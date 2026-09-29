import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Store } from './db/store.ts';

// ── Passwords ───────────────────────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Session tokens ──────────────────────────────────────────────

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newId = () => randomBytes(9).toString('base64url');

// ── API key encryption (AES-256-GCM) ────────────────────────────

export class Vault {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`company-auction:${secret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** Returns null when the value cannot be decrypted (e.g. APP_SECRET changed). */
  decrypt(sealed: string): string | null {
    try {
      const [v, iv, tag, data] = sealed.split(':');
      if (v !== 'v1') return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/**
 * The encryption secret for saved API keys. Prefer APP_SECRET from the environment so the
 * database alone can't reveal keys; otherwise generate one and keep it in the database.
 */
export async function resolveAppSecret(store: Store): Promise<{ secret: string; fromEnv: boolean }> {
  const env = process.env.APP_SECRET?.trim();
  if (env) return { secret: env, fromEnv: true };
  return { secret: await store.ensureMeta('app_secret', randomBytes(32).toString('base64url')), fromEnv: false };
}

export function maskKey(key: string): string {
  const tail = key.slice(-4);
  return `${key.slice(0, Math.min(4, Math.max(0, key.length - 8)))}…${tail}`;
}

// ── Tiny in-memory rate limiter ─────────────────────────────────

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10000) this.hits.clear();
    return true;
  }
}
