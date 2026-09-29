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
];

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
