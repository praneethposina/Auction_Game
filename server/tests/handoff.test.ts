import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { DEFAULT_SETTINGS, type GameLogResponse, type RoomView } from '../../shared/types.ts';
import { AiDirector } from '../ai/director.ts';
import { createApp } from '../app.ts';
import { openStore, type Store } from '../db/store.ts';
import { Game, type PlayerInit } from '../game/engine.ts';
import { Vault } from '../security.ts';

const BOTS: PlayerInit[] = ['quant', 'tycoon', 'sniper', 'value'].map((persona, i) => ({
  id: `p${i}`,
  name: persona,
  kind: 'bot' as const,
  isHost: i === 0,
  ai: { persona: persona as 'quant' },
}));

/** Play a bot game on a simulated clock. `interrupt` may swap in a restored game + director. */
async function play(
  mode: 'open' | 'sealed',
  interrupt?: (game: Game, director: AiDirector, clock: number, now: () => number) => [Game, AiDirector, number] | null,
) {
  let clock = 0;
  const now = () => clock;
  let game = new Game({ settings: { ...DEFAULT_SETTINGS, companyCount: 12, auctionMode: mode }, players: BOTS, seed: 99, now: 0 });
  let director = new AiDirector(game, () => clock, 7, { botDelay: false });
  let swapped = false;
  for (let guard = 0; game.phase !== 'finished' && guard < 100000; guard++) {
    clock += 100;
    game.tick(clock);
    director.tick();
    await Promise.resolve();
    await Promise.resolve();
    if (!swapped && interrupt) {
      const next = interrupt(game, director, clock, now);
      if (next) [game, director, clock] = next;
      swapped = next !== null;
    }
  }
  director.dispose();
  return game;
}

/** Snapshot → JSON → restore, as a new server process would. */
function roundTrip(game: Game, director: AiDirector, frozenAt: number, now: number, clock: () => number): [Game, AiDirector] {
  const snap = JSON.parse(JSON.stringify({ game: game.snapshot(), director: director.snapshot() }));
  director.dispose();
  const restored = new Game({ snapshot: snap.game, frozenAt, now });
  const d = new AiDirector(restored, clock, 1, { botDelay: false, restore: snap.director });
  d.resumeAuction();
  return [restored, d];
}

describe('games survive a server restart', () => {
  it('a game restored between lots finishes exactly as if nothing happened', async () => {
    for (const mode of ['open', 'sealed'] as const) {
      const straight = await play(mode);
      const resumed = await play(mode, (game, director, clock, now) => {
        if (game.phase !== 'sold' || game.cursor < 5) return null;
        // The new process starts 90 seconds later: that time must not count.
        const later = clock + 90000;
        const [g, d] = roundTrip(game, director, clock, later, now);
        return [g, d, later];
      });
      expect(resumed.results!.standings).toEqual(straight.results!.standings);
    }
  });

  it('a game restored mid-auction keeps its clock and finishes', async () => {
    let checked = false;
    const game = await play('open', (g, director, clock, now) => {
      if (g.phase !== 'auction' || g.cursor < 3 || !g.auction || g.auction.aiPending.size > 0) return null;
      const left = g.auction.deadline - clock;
      const later = clock + 45000;
      const [restored, d] = roundTrip(g, director, clock, later, now);
      expect(restored.auction!.deadline - later).toBe(left);
      expect(restored.auction!.companyId).toBe(g.auction.companyId);
      checked = true;
      return [restored, d, later];
    });
    expect(checked).toBe(true);
    expect(game.phase).toBe('finished');
    expect(game.companies.every((c) => c.status === 'sold' || c.status === 'unsold')).toBe(true);
  });
});

const PG_URL = process.env.TEST_DATABASE_URL;
const backends: [string, (dir: string) => Promise<Store>][] = [
  ['sqlite', (dir) => openStore({ sqliteFile: path.join(dir, 'db.sqlite') })],
];
if (PG_URL) backends.push(['postgres', () => openStore({ databaseUrl: PG_URL, sqliteFile: '' })]);

describe.each(backends)('deploy hand-over between two server processes (%s)', (_name, open) => {
  let dir = '';
  let storeA: Store;
  let storeB: Store;
  let a: ReturnType<typeof createApp>;
  let b: ReturnType<typeof createApp>;
  const sockets: Socket[] = [];

  const start = async (store: Store, instanceId: string) => {
    const app = createApp({
      store,
      vault: new Vault('handoff-secret'),
      serveClient: false,
      tickMs: 50,
      quietLogs: true,
      handoverWaitMs: 400,
      keeper: { saveEveryMs: 100, heartbeatMs: 100, staleMs: 3000, instanceId },
    });
    await new Promise<void>((r) => app.httpServer.listen(0, '127.0.0.1', () => r()));
    return { app, url: `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}` };
  };

  const socketTo = (url: string) =>
    new Promise<Socket>((resolve) => {
      const s = connect(url, { transports: ['websocket'], reconnection: false });
      sockets.push(s);
      s.on('connect', () => resolve(s));
    });

  const call = <T = any>(s: Socket, ev: string, payload?: unknown) =>
    new Promise<{ ok: boolean; error?: string; data?: T; retry?: boolean }>((resolve) =>
      payload === undefined ? s.emit(ev, resolve) : s.emit(ev, payload, resolve),
    );

  const nextState = (s: Socket, test: (v: RoomView) => boolean, ms = 8000) =>
    new Promise<RoomView>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for state')), ms);
      const on = (v: RoomView) => {
        if (!test(v)) return;
        clearTimeout(timer);
        s.off('room:state', on);
        resolve(v);
      };
      s.on('room:state', on);
    });

  beforeAll(async () => {
    // Two processes, one database (as during a Railway deploy).
    dir = mkdtempSync(path.join(tmpdir(), 'handoff-'));
    storeA = await open(dir);
    storeB = await open(dir);
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await a?.close().catch(() => {});
    await b?.close().catch(() => {});
    await storeA.db.close().catch(() => {});
    await storeB.db.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves a running game to the new process without losing anything', async () => {
    const A = await start(storeA, 'old');
    a = A.app;
    const host = await socketTo(A.url);
    const created = await call<{ code: string; token: string }>(host, 'room:create', { name: 'Host' });
    expect(created.ok).toBe(true);
    const { code, token } = created.data!;
    await call(host, 'lobby:addAi', { persona: 'quant' });
    await call(host, 'lobby:addAi', { persona: 'value' });
    await call(host, 'lobby:settings', { companyCount: 6, auctionMode: 'sealed', introSeconds: 2, bidSeconds: 30 });
    const started = nextState(host, (v) => v.game?.phase === 'auction' && (v.game.auction?.sealedSubmittedIds.length ?? 0) >= 2);
    expect((await call(host, 'lobby:start')).ok).toBe(true);
    const before = await started;
    const gameId = before.gameId!;
    expect(gameId).toBeTruthy();

    // The new process comes up while the old one still runs the room: it must not take it.
    const B = await start(storeB, 'new');
    b = B.app;
    const early = await socketTo(B.url);
    const busy = await call(early, 'room:resume', { code, token });
    expect(busy.ok).toBe(false);
    expect(busy.retry).toBe(true);

    // Old process gets SIGTERM: freezes and saves the game, then drops connections.
    const gone = new Promise<void>((r) => host.on('disconnect', () => r()));
    const warned = new Promise<void>((r) => host.on('server:restarting', () => r()));
    await a.drain();
    await warned;
    await gone;
    expect(await storeA.loadRoom(code)).toMatchObject({ owner: null });

    // The browser reconnects (to the new process) and resumes its seat.
    const again = await socketTo(B.url);
    const state = nextState(again, (v) => v.game !== null);
    const resumed = await call(again, 'room:resume', { code, token });
    expect(resumed.ok).toBe(true);
    const after = await state;
    expect(after.gameId).toBe(gameId);
    expect(after.game!.round).toBe(before.game!.round);
    expect(after.game!.auction!.companyId).toBe(before.game!.auction!.companyId);
    // The AI bids already in stay in; the clock did not run while the server was down.
    expect(after.game!.auction!.sealedSubmittedIds.sort()).toEqual(before.game!.auction!.sealedSubmittedIds.sort());
    const leftBefore = before.game!.phaseEndsAt! - before.game!.serverNow;
    const leftAfter = after.game!.phaseEndsAt! - after.game!.serverNow;
    expect(leftAfter).toBeGreaterThan(leftBefore - 3000);

    // And the game carries on in the new process.
    const sold = nextState(again, (v) => v.game?.phase === 'sold');
    expect((await call(again, 'game:sealed', { amount: null })).ok).toBe(true);
    const s = await sold;
    expect(s.game!.lastSale!.companyId).toBe(before.game!.auction!.companyId);
    expect((await storeB.loadRoom(code))?.owner).toBe('new');

    // The log tells the story, across both processes; secrets stay hidden until the game ends.
    const logs = (await (await fetch(`${B.url}/api/games/${gameId}/logs`)).json()) as GameLogResponse;
    expect(logs.revealed).toBe(false);
    const msgs = logs.entries.map((e) => e.msg);
    expect(msgs.some((m) => m.startsWith('Game started'))).toBe(true);
    expect(msgs.some((m) => m.includes('Server restarting'))).toBe(true);
    expect(msgs.some((m) => m.includes('Game restored'))).toBe(true);
    expect(logs.entries.filter((e) => e.kind === 'bot').length).toBeGreaterThanOrEqual(2);
    expect(logs.entries.every((e) => e.secret === undefined)).toBe(true);
    const seqs = logs.entries.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    const ended = nextState(again, (v) => v.status === 'finished');
    expect((await call(again, 'game:end')).ok).toBe(true);
    await ended;
    const final = (await (await fetch(`${B.url}/api/games/${gameId}/logs`)).json()) as GameLogResponse;
    expect(final.revealed).toBe(true);
    expect(final.game.status).toBe('finished');
    expect(final.entries.some((e) => e.kind === 'bot' && typeof e.secret?.maxBid === 'number')).toBe(true);
    expect(final.entries.some((e) => e.msg.includes('ended the game early'))).toBe(true);
  });
});
