import type { GameLogEntry, GameLogKind, GameLogLevel } from '../shared/types.ts';

// A running record of one game, for debugging: lots and sales, every AI decision with its
// timing (and for LLMs, each request, token counts and the raw answer), timeouts, fallbacks,
// pauses, disconnects and server restarts.
//
// Entries are buffered and written to the database in batches, so logging never slows the
// game down and a database hiccup never breaks it. Notable entries are also printed as one
// JSON line each, so they show up in the host's server logs (Railway) too.
//
// `secret` holds what players must not see mid-game (prompts, private intel, AI max bids and
// full reasoning). The API only returns it once the game is over.

export type LogWriter = (gameId: string, entries: GameLogEntry[]) => Promise<void>;

const MAX_PENDING = 5000;

export class GameLog {
  private seq: number;
  private pending: GameLogEntry[] = [];
  private flushing: Promise<void> | null = null;

  constructor(
    readonly gameId: string,
    readonly roomCode: string,
    private readonly write: LogWriter | null,
    opts: { seq?: number; quiet?: boolean } = {},
  ) {
    this.seq = opts.seq ?? 0;
    this.quiet = opts.quiet ?? false;
  }

  private readonly quiet: boolean;

  get lastSeq() {
    return this.seq;
  }

  add(
    kind: GameLogKind,
    level: GameLogLevel,
    msg: string,
    extra: { playerId?: string; data?: Record<string, unknown>; secret?: Record<string, unknown> } = {},
  ): GameLogEntry {
    const entry: GameLogEntry = { seq: ++this.seq, at: Date.now(), kind, level, msg, ...extra };
    if (this.write) {
      this.pending.push(entry);
      if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    }
    if (!this.quiet && (level !== 'info' || kind === 'llm' || kind === 'game' || kind === 'server')) {
      // Never print `secret`: server logs are not the place for prompts or private intel.
      console.log(JSON.stringify({ log: 'game', game: this.gameId, room: this.roomCode, kind, level, msg, ...extra.data }));
    }
    return entry;
  }

  /** Write buffered entries. Safe to call often; concurrent calls share one write. */
  flush(): Promise<void> {
    if (!this.write || this.pending.length === 0) return this.flushing ?? Promise.resolve();
    if (this.flushing) return this.flushing.then(() => this.flush());
    const batch = this.pending.splice(0);
    const write = this.write;
    this.flushing = write(this.gameId, batch)
      .catch((err: unknown) => {
        // Put them back for the next try (oldest first), unless the buffer is already full.
        if (this.pending.length + batch.length <= MAX_PENDING) this.pending.unshift(...batch);
        console.warn(`[gamelog] could not save ${batch.length} log entries for ${this.gameId}: ${String(err)}`);
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }
}
