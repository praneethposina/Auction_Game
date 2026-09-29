import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Persistence for accounts, sessions and saved API keys.
// Postgres when DATABASE_URL is set (Railway), otherwise a local SQLite file.
// All SQL below is written once with `?` placeholders and runs on both.

export interface Db {
  kind: 'sqlite' | 'postgres';
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

async function openSqlite(file: string): Promise<Db> {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  // node:sqlite prints an "experimental" warning on import; it's stable enough for this.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite')) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  const { DatabaseSync } = await import('node:sqlite');
  process.emitWarning = emit;

  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return {
    kind: 'sqlite',
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    run: async (sql, params = []) => Number(db.prepare(sql).run(...(params as never[])).changes),
    close: async () => db.close(),
  };
}

async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const toPg = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return {
    kind: 'postgres',
    all: async <T>(sql: string, params: unknown[] = []) => (await pool.query(toPg(sql), params)).rows as T[],
    run: async (sql, params = []) => (await pool.query(toPg(sql), params)).rowCount ?? 0,
    close: () => pool.end(),
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    secret TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    ended_at BIGINT,
    status TEXT NOT NULL,
    info TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS games_started ON games (started_at)`,
  `CREATE TABLE IF NOT EXISTS game_members (
    game_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (game_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS game_members_user ON game_members (user_id)`,
  `CREATE TABLE IF NOT EXISTS game_logs (
    game_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at BIGINT NOT NULL,
    entry TEXT NOT NULL,
    PRIMARY KEY (game_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS room_snapshots (
    code TEXT PRIMARY KEY,
    owner TEXT,
    heartbeat_at BIGINT NOT NULL,
    saved_at BIGINT NOT NULL,
    data TEXT NOT NULL
  )`,
];

export interface GameRow {
  id: string;
  roomCode: string;
  startedAt: number;
  endedAt: number | null;
  status: 'playing' | 'finished' | 'ended';
  info: string;
}

interface RawGame {
  id: string;
  room_code: string;
  started_at: number | string;
  ended_at: number | string | null;
  status: string;
  info: string;
}

const toGame = (r: RawGame): GameRow => ({
  id: r.id,
  roomCode: r.room_code,
  startedAt: Number(r.started_at),
  endedAt: r.ended_at === null ? null : Number(r.ended_at),
  status: r.status as GameRow['status'],
  info: r.info,
});

export interface SnapshotRow {
  code: string;
  owner: string | null;
  heartbeatAt: number;
  savedAt: number;
  data: string;
}

export interface UserRow {
  id: string;
  username: string;
  createdAt: number;
}

interface RawUser {
  id: string;
  username: string;
  password_hash: string;
  created_at: number | string;
}

const toUser = (r: RawUser): UserRow => ({ id: r.id, username: r.username, createdAt: Number(r.created_at) });

export class Store {
  constructor(readonly db: Db) {}

  async migrate() {
    for (const sql of SCHEMA) await this.db.run(sql);
  }

  /** Returns null if the username is taken. */
  async createUser(id: string, username: string, passwordHash: string, now: number): Promise<UserRow | null> {
    const lower = username.toLowerCase();
    const taken = await this.db.all('SELECT id FROM users WHERE username_lower = ?', [lower]);
    if (taken.length > 0) return null;
    try {
      await this.db.run(
        'INSERT INTO users (id, username, username_lower, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, username, lower, passwordHash, now],
      );
    } catch {
      return null; // lost a race on the unique index
    }
    return { id, username, createdAt: now };
  }

  async findLogin(username: string): Promise<{ user: UserRow; passwordHash: string } | null> {
    const rows = await this.db.all<RawUser>('SELECT * FROM users WHERE username_lower = ?', [username.toLowerCase()]);
    return rows[0] ? { user: toUser(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  async userById(id: string): Promise<UserRow | null> {
    const rows = await this.db.all<RawUser>('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async createSession(tokenHash: string, userId: string, expiresAt: number) {
    await this.db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
      tokenHash,
      userId,
      expiresAt,
    ]);
  }

  async sessionUser(tokenHash: string, now: number): Promise<UserRow | null> {
    const rows = await this.db.all<RawUser>(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
      [tokenHash, now],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async deleteSession(tokenHash: string) {
    await this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  async purgeSessions(now: number) {
    await this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
  }

  async listKeys(userId: string): Promise<{ provider: string; secret: string; updatedAt: number }[]> {
    const rows = await this.db.all<{ provider: string; secret: string; updated_at: number | string }>(
      'SELECT provider, secret, updated_at FROM api_keys WHERE user_id = ? ORDER BY provider',
      [userId],
    );
    return rows.map((r) => ({ provider: r.provider, secret: r.secret, updatedAt: Number(r.updated_at) }));
  }

  async getKey(userId: string, provider: string): Promise<string | null> {
    const rows = await this.db.all<{ secret: string }>(
      'SELECT secret FROM api_keys WHERE user_id = ? AND provider = ?',
      [userId, provider],
    );
    return rows[0]?.secret ?? null;
  }

  async putKey(userId: string, provider: string, secret: string, now: number) {
    await this.db.run(
      `INSERT INTO api_keys (user_id, provider, secret, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, provider) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at`,
      [userId, provider, secret, now],
    );
  }

  async deleteKey(userId: string, provider: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM api_keys WHERE user_id = ? AND provider = ?', [userId, provider])) > 0;
  }

  async getMeta(k: string): Promise<string | null> {
    const rows = await this.db.all<{ v: string }>('SELECT v FROM meta WHERE k = ?', [k]);
    return rows[0]?.v ?? null;
  }

  // ── Games and their logs ──

  async createGame(g: Omit<GameRow, 'endedAt' | 'status'>) {
    await this.db.run(
      'INSERT INTO games (id, room_code, started_at, ended_at, status, info) VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT (id) DO NOTHING',
      [g.id, g.roomCode, g.startedAt, 'playing', g.info],
    );
  }

  async endGame(id: string, status: 'finished' | 'ended', endedAt: number) {
    await this.db.run("UPDATE games SET status = ?, ended_at = ? WHERE id = ? AND status = 'playing'", [status, endedAt, id]);
  }

  async addGameMember(gameId: string, userId: string) {
    await this.db.run('INSERT INTO game_members (game_id, user_id) VALUES (?, ?) ON CONFLICT (game_id, user_id) DO NOTHING', [
      gameId,
      userId,
    ]);
  }

  async getGame(id: string): Promise<GameRow | null> {
    const rows = await this.db.all<RawGame>('SELECT * FROM games WHERE id = ?', [id]);
    return rows[0] ? toGame(rows[0]) : null;
  }

  async userGames(userId: string, limit: number): Promise<GameRow[]> {
    const rows = await this.db.all<RawGame>(
      'SELECT g.* FROM games g JOIN game_members m ON m.game_id = g.id WHERE m.user_id = ? ORDER BY g.started_at DESC LIMIT ?',
      [userId, limit],
    );
    return rows.map(toGame);
  }

  async appendGameLogs(gameId: string, entries: { seq: number; at: number }[]) {
    // A few hundred rows per statement keeps every write small.
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200);
      const values = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      await this.db.run(
        `INSERT INTO game_logs (game_id, seq, at, entry) VALUES ${values} ON CONFLICT (game_id, seq) DO NOTHING`,
        chunk.flatMap((e) => [gameId, e.seq, e.at, JSON.stringify(e)]),
      );
    }
  }

  async gameLogs(gameId: string): Promise<string[]> {
    const rows = await this.db.all<{ entry: string }>('SELECT entry FROM game_logs WHERE game_id = ? ORDER BY seq', [gameId]);
    return rows.map((r) => r.entry);
  }

  /** Forget games (and their logs) that started before `before`. */
  async purgeGames(before: number) {
    const old = 'SELECT id FROM games WHERE started_at < ?';
    await this.db.run(`DELETE FROM game_logs WHERE game_id IN (${old})`, [before]);
    await this.db.run(`DELETE FROM game_members WHERE game_id IN (${old})`, [before]);
    await this.db.run('DELETE FROM games WHERE started_at < ?', [before]);
  }

  // ── Room snapshots (so a restart or deploy doesn't end running games) ──

  /** Claim a fresh room code. False if some process already uses it. */
  async reserveRoom(code: string, owner: string, now: number): Promise<boolean> {
    const n = await this.db.run(
      "INSERT INTO room_snapshots (code, owner, heartbeat_at, saved_at, data) VALUES (?, ?, ?, ?, '') ON CONFLICT (code) DO NOTHING",
      [code, owner, now, now],
    );
    return n > 0;
  }

  /** Save a room, but only while `asOwner` still owns it. False if another process took it over. */
  async saveRoom(code: string, owner: string | null, asOwner: string, now: number, data: string): Promise<boolean> {
    const n = await this.db.run(
      `INSERT INTO room_snapshots (code, owner, heartbeat_at, saved_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (code) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at,
         saved_at = excluded.saved_at, data = excluded.data
       WHERE room_snapshots.owner = ?`,
      [code, owner, now, now, data, asOwner],
    );
    return n > 0;
  }

  async heartbeatRooms(owner: string, now: number) {
    await this.db.run('UPDATE room_snapshots SET heartbeat_at = ? WHERE owner = ?', [now, owner]);
  }

  async loadRoom(code: string): Promise<SnapshotRow | null> {
    const rows = await this.db.all<{ code: string; owner: string | null; heartbeat_at: number | string; saved_at: number | string; data: string }>(
      'SELECT * FROM room_snapshots WHERE code = ?',
      [code],
    );
    const r = rows[0];
    return r ? { code: r.code, owner: r.owner, heartbeatAt: Number(r.heartbeat_at), savedAt: Number(r.saved_at), data: r.data } : null;
  }

  /** Take over a room that is released, or whose owner stopped heart-beating. */
  async claimRoom(code: string, owner: string, now: number, staleBefore: number): Promise<boolean> {
    const n = await this.db.run(
      "UPDATE room_snapshots SET owner = ?, heartbeat_at = ? WHERE code = ? AND data <> '' AND (owner IS NULL OR owner = ? OR heartbeat_at < ?)",
      [owner, now, code, owner, staleBefore],
    );
    return n > 0;
  }

  async deleteRoom(code: string, owner: string) {
    await this.db.run('DELETE FROM room_snapshots WHERE code = ? AND owner = ?', [code, owner]);
  }

  /** Rooms nobody has touched since `before` (their players never came back). */
  async purgeRooms(before: number): Promise<number> {
    return this.db.run('DELETE FROM room_snapshots WHERE heartbeat_at < ?', [before]);
  }

  /** Stores v unless a value already exists; returns whichever value is stored. */
  async ensureMeta(k: string, v: string): Promise<string> {
    await this.db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO NOTHING', [k, v]);
    return (await this.getMeta(k))!;
  }
}

export async function openStore(opts: { databaseUrl?: string; sqliteFile: string }): Promise<Store> {
  const db = opts.databaseUrl ? await openPostgres(opts.databaseUrl) : await openSqlite(opts.sqliteFile);
  const store = new Store(db);
  await store.migrate();
  return store;
}
