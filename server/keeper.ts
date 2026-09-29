import { randomBytes } from 'node:crypto';
import type { Store } from './db/store.ts';
import { Room, type RoomRegistry, type RoomSnapshot } from './rooms.ts';

// Keeps rooms alive across server restarts and deploys.
//
// Rooms live in memory, so a new server process (a deploy) would normally end every game.
// Instead, the process that runs a room saves a snapshot to the database every few seconds
// and heart-beats while it owns it. On shutdown (SIGTERM from Railway once the new deploy is
// healthy) it stops the clocks, saves a final snapshot and releases the room. Players'
// browsers reconnect by themselves, reach the new process, which claims the room, rebuilds
// it and carries on: timers resume where they stopped, AI players still thinking are asked
// again. A crash loses at most the last few seconds.

export interface KeeperOptions {
  seal: (plain: string) => string;
  unseal: (sealed: string) => string | null;
  instanceId?: string;
  saveEveryMs?: number;
  heartbeatMs?: number;
  /** A room whose owner hasn't heart-beaten for this long can be taken over. */
  staleMs?: number;
}

export type ClaimResult = { room: Room } | { busy: true } | { missing: true };

export class RoomKeeper {
  readonly instanceId: string;
  private readonly saved = new Map<string, string>();
  private readonly claiming = new Map<string, Promise<ClaimResult>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private saving: Promise<void> | null = null;
  private stopped = false;
  private readonly saveEveryMs: number;
  private readonly heartbeatMs: number;
  readonly staleMs: number;

  constructor(
    private readonly store: Store,
    private readonly rooms: RoomRegistry,
    private readonly opts: KeeperOptions,
  ) {
    this.instanceId = opts.instanceId ?? `${process.env.RAILWAY_DEPLOYMENT_ID ?? 'local'}:${randomBytes(6).toString('base64url')}`;
    this.saveEveryMs = opts.saveEveryMs ?? 2000;
    this.heartbeatMs = opts.heartbeatMs ?? 5000;
    this.staleMs = opts.staleMs ?? 20000;
  }

  start() {
    this.timers.push(
      setInterval(() => void this.saveAll(), this.saveEveryMs),
      setInterval(() => void this.store.heartbeatRooms(this.instanceId, Date.now()).catch(() => {}), this.heartbeatMs),
      // Rooms whose players never came back after a restart.
      setInterval(() => void this.store.purgeRooms(Date.now() - 24 * 60 * 60 * 1000).catch(() => {}), 60 * 60 * 1000),
    );
  }

  /** Reserve a new room's code across all server processes. */
  reserve(code: string): Promise<boolean> {
    return this.store.reserveRoom(code, this.instanceId, Date.now()).catch(() => true);
  }

  forgetSaved(code: string) {
    this.saved.delete(code);
    void this.store.deleteRoom(code, this.instanceId).catch(() => {});
  }

  /** Save every room that changed since its last save. */
  saveAll(release = false): Promise<void> {
    if (this.saving) return this.saving.then(() => this.saveAll(release));
    this.saving = (async () => {
      const now = Date.now();
      for (const room of this.rooms.all()) {
        const key = room.stateKey();
        if (!release && this.saved.get(room.code) === key) continue;
        try {
          const data = JSON.stringify(room.snapshot(this.opts.seal, now));
          const ok = await this.store.saveRoom(room.code, release ? null : this.instanceId, this.instanceId, now, data);
          if (ok) this.saved.set(room.code, key);
          else if (!release) {
            // Another process took this room over (we missed heartbeats). It is theirs now.
            console.warn(`[keeper] room ${room.code} is owned by another server now; dropping it here`);
            this.rooms.forget(room.code);
            this.saved.delete(room.code);
          }
        } catch (err) {
          console.warn(`[keeper] could not save room ${room.code}: ${String(err)}`);
        }
      }
    })().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  /**
   * Find a room this process doesn't have in memory. `busy` means another process still runs
   * it (the old server during a deploy); ask again in a moment.
   */
  claim(code: string): Promise<ClaimResult> {
    const inflight = this.claiming.get(code);
    if (inflight) return inflight;
    const p = this.doClaim(code).finally(() => this.claiming.delete(code));
    this.claiming.set(code, p);
    return p;
  }

  private async doClaim(code: string): Promise<ClaimResult> {
    if (this.stopped) return { busy: true };
    const existing = this.rooms.get(code);
    if (existing) return { room: existing };
    const now = Date.now();
    const row = await this.store.loadRoom(code);
    if (!row || !row.data) return { missing: true };
    if (row.owner && row.owner !== this.instanceId && row.heartbeatAt >= now - this.staleMs) return { busy: true };
    if (!(await this.store.claimRoom(code, this.instanceId, now, now - this.staleMs))) return { busy: true };
    // Re-read: the owner may have saved a final snapshot between our read and the claim.
    const fresh = await this.store.loadRoom(code);
    if (!fresh?.data) return { missing: true };
    let snap: RoomSnapshot;
    let room: Room;
    try {
      snap = JSON.parse(fresh.data) as RoomSnapshot;
      room = Room.restore(snap, { services: this.rooms.services, unseal: this.opts.unseal, now: Date.now() });
    } catch (err) {
      // A snapshot this version can't rebuild: give up on the room rather than retrying forever.
      console.error(`[keeper] could not restore room ${code}:`, err);
      await this.store.deleteRoom(code, this.instanceId).catch(() => {});
      return { missing: true };
    }
    this.rooms.add(room);
    this.saved.delete(code);
    console.log(
      JSON.stringify({ log: 'keeper', msg: 'room restored', room: code, status: snap.status, gapMs: Date.now() - snap.savedAt }),
    );
    return { room };
  }

  /** Wait for a room another process is handing over, up to `waitMs`. */
  async claimWithin(code: string, waitMs: number): Promise<ClaimResult> {
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await this.claim(code).catch((err: unknown) => {
        console.warn(`[keeper] claim ${code} failed: ${String(err)}`);
        return { busy: true } as const;
      });
      if (!('busy' in r) || Date.now() + 500 > until) return r;
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  /** Final save with every room released, so the next process can take over immediately. */
  async shutdown() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.saveAll(true);
  }
}
