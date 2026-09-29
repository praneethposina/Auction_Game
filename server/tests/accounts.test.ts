import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { AiCatalog, RoomView } from '../../shared/types.ts';
import { createApp } from '../app.ts';
import { openStore, type Store } from '../db/store.ts';
import { hashPassword, hashToken, maskKey, Vault, verifyPassword } from '../security.ts';

// Postgres tests run when TEST_DATABASE_URL points at a disposable database.
const PG_URL = process.env.TEST_DATABASE_URL;

describe('security', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('hunter22');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('hunter22', h)).toBe(true);
    expect(await verifyPassword('hunter23', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('encrypts API keys and detects tampering or a changed secret', () => {
    const vault = new Vault('s3cret');
    const sealed = vault.encrypt('gsk_live_1234567890');
    expect(sealed).not.toContain('gsk_live');
    expect(vault.decrypt(sealed)).toBe('gsk_live_1234567890');
    expect(new Vault('other').decrypt(sealed)).toBeNull();
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(vault.decrypt(parts.join(':'))).toBeNull();
  });

  it('masks keys', () => {
    expect(maskKey('gsk_abcdefghijklmnop')).toBe('gsk_…mnop');
    expect(maskKey('short123')).toBe('…t123');
  });
});

function storeSuite(name: string, open: () => Promise<Store>) {
  describe(`store (${name})`, () => {
    let store: Store;
    beforeAll(async () => {
      store = await open();
      if (store.db.kind === 'postgres') {
        for (const t of ['users', 'sessions', 'api_keys', 'meta']) await store.db.run(`DELETE FROM ${t}`);
      }
    });
    afterAll(async () => store.db.close());

    it('creates users with case-insensitive unique names', async () => {
      const u = await store.createUser('u1', 'Praneeth', 'hash', 1);
      expect(u?.username).toBe('Praneeth');
      expect(await store.createUser('u2', 'praneeth', 'hash', 2)).toBeNull();
      const login = await store.findLogin('PRANEETH');
      expect(login?.user.id).toBe('u1');
      expect(login?.passwordHash).toBe('hash');
      expect((await store.userById('u1'))?.createdAt).toBe(1);
    });

    it('expires sessions', async () => {
      await store.createSession('tok', 'u1', 1000);
      expect((await store.sessionUser('tok', 999))?.id).toBe('u1');
      expect(await store.sessionUser('tok', 1000)).toBeNull();
      await store.purgeSessions(2000);
      expect(await store.sessionUser('tok', 0)).toBeNull();
    });

    it('upserts, lists and deletes keys', async () => {
      await store.putKey('u1', 'groq', 'sealed-1', 10);
      await store.putKey('u1', 'groq', 'sealed-2', 20);
      await store.putKey('u1', 'cerebras', 'sealed-3', 30);
      const keys = await store.listKeys('u1');
      expect(keys).toEqual([
        { provider: 'cerebras', secret: 'sealed-3', updatedAt: 30 },
        { provider: 'groq', secret: 'sealed-2', updatedAt: 20 },
      ]);
      expect(await store.getKey('u1', 'groq')).toBe('sealed-2');
      expect(await store.deleteKey('u1', 'groq')).toBe(true);
      expect(await store.getKey('u1', 'groq')).toBeNull();
    });

    it('keeps the first meta value', async () => {
      expect(await store.ensureMeta('app_secret', 'a')).toBe('a');
      expect(await store.ensureMeta('app_secret', 'b')).toBe('a');
    });
  });
}

storeSuite('sqlite', () => openStore({ sqliteFile: ':memory:' }));
if (PG_URL) storeSuite('postgres', () => openStore({ databaseUrl: PG_URL, sqliteFile: '' }));

describe('accounts API and AI keys over sockets', () => {
  const realFetch = globalThis.fetch;
  let base = '';
  let server: ReturnType<typeof createApp>;
  let store: Store;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    // Provider calls are faked: keys containing "bad" are rejected.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (url.endsWith('/models') && !url.includes('openrouter')) {
        if (auth.includes('bad')) return new Response('no', { status: 401 });
        return Response.json({ data: [{ id: 'fake-model-large' }, { id: 'whisper-large-v3' }] });
      }
      if (url.includes('openrouter.ai/api/v1/models')) return Response.json({ data: [{ id: 'x/y:free', name: 'Y (free)' }] });
      if (url.includes('openrouter.ai/api/v1/key')) return new Response('ok', { status: auth.includes('bad') ? 401 : 200 });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    store = await openStore({ sqliteFile: ':memory:' });
    server = createApp({ store, vault: new Vault('test-secret'), serveClient: false, tickMs: 50 });
    await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.close();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await server.close();
    await store.db.close();
  });

  const api = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, json: (await res.json()) as Record<string, any>, cookie: setCookie?.split(';')[0] };
  };

  const socketFor = (cookie?: string) =>
    new Promise<Socket>((resolve) => {
      const s = connect(base, { transports: ['websocket'], extraHeaders: cookie ? { Cookie: cookie } : {} });
      sockets.push(s);
      s.on('connect', () => resolve(s));
    });

  const call = <T = any>(s: Socket, ev: string, payload?: unknown) =>
    new Promise<{ ok: boolean; error?: string; data?: T }>((resolve) =>
      payload === undefined ? s.emit(ev, resolve) : s.emit(ev, payload, resolve),
    );

  it('registers, signs in, and rejects bad input', async () => {
    expect((await api('POST', '/api/auth/register', { username: 'a', password: 'secret1' })).status).toBe(400);
    expect((await api('POST', '/api/auth/register', { username: 'maya', password: '123' })).status).toBe(400);
    const reg = await api('POST', '/api/auth/register', { username: 'maya', password: 'secret1' });
    expect(reg.status).toBe(200);
    expect(reg.json.user.username).toBe('maya');
    expect(reg.cookie).toMatch(/^ca_session=/);
    expect((await api('POST', '/api/auth/register', { username: 'MAYA', password: 'secret1' })).status).toBe(409);

    expect((await api('POST', '/api/auth/login', { username: 'maya', password: 'nope' })).status).toBe(401);
    const login = await api('POST', '/api/auth/login', { username: 'Maya', password: 'secret1' });
    expect(login.status).toBe(200);
    expect((await api('GET', '/api/auth/me', undefined, login.cookie)).json.user.username).toBe('maya');
    expect((await api('GET', '/api/auth/me')).json.user).toBeNull();

    await api('POST', '/api/auth/logout', {}, login.cookie);
    expect((await api('GET', '/api/auth/me', undefined, login.cookie)).json.user).toBeNull();
  });

  it('blocks cross-site writes', async () => {
    const res = await realFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ username: 'maya', password: 'secret1' }),
    });
    expect(res.status).toBe(403);
  });

  it('saves keys encrypted, never returns them, and uses them for LLM players', async () => {
    const { cookie } = await api('POST', '/api/auth/register', { username: 'host1', password: 'secret1' });
    expect((await api('GET', '/api/keys')).status).toBe(401);
    expect((await api('PUT', '/api/keys/groq', { key: 'gsk_bad_key_000' }, cookie)).status).toBe(400);
    expect((await api('PUT', '/api/keys/nope', { key: 'gsk_good_key_123' }, cookie)).status).toBe(404);
    const saved = await api('PUT', '/api/keys/groq', { key: 'gsk_good_key_123' }, cookie);
    expect(saved.json.check.ok).toBe(true);

    const list = await api('GET', '/api/keys', undefined, cookie);
    expect(list.json.keys).toEqual([{ provider: 'groq', masked: 'gsk_…_123', updatedAt: expect.any(Number), readable: true }]);
    expect(JSON.stringify(list.json)).not.toContain('gsk_good_key_123');
    const raw = await store.db.all<{ secret: string }>('SELECT secret FROM api_keys');
    expect(raw[0].secret).not.toContain('gsk_good');
    expect((await api('POST', '/api/keys/groq/test', {}, cookie)).json.check.ok).toBe(true);

    // Signed-in host: catalog shows their key and discovered models; they can add an LLM player.
    const s = await socketFor(cookie);
    const created = await call(s, 'room:create', { name: 'Host' });
    expect(created.ok).toBe(true);
    const cat = await call<AiCatalog>(s, 'ai:catalog');
    const groq = cat.data!.providers.find((p) => p.id === 'groq')!;
    expect(groq.yourKey).toBe(true);
    expect(cat.data!.models.some((m) => m.provider === 'groq' && m.model === 'fake-model-large')).toBe(true);
    expect(cat.data!.models.some((m) => m.model === 'whisper-large-v3')).toBe(false);

    const views: RoomView[] = [];
    s.on('room:state', (v: RoomView) => views.push(v));
    const added = await call(s, 'lobby:addAi', { persona: 'tycoon', provider: 'groq', model: 'openai/gpt-oss-120b', modelLabel: 'GPT-OSS 120B' });
    expect(added.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    const llm = views.at(-1)!.players.find((p) => p.kind === 'llm')!;
    expect(llm.ai).toMatchObject({ provider: 'groq', keySource: 'account', keyOwner: 'host1' });
    expect(JSON.stringify(views)).not.toContain('gsk_good_key_123');

    const noKey = await call(s, 'lobby:addAi', { provider: 'cerebras', model: 'x' });
    expect(noKey.ok).toBe(false);
    expect(noKey.error).toContain('Cerebras');

    // Guests can't use someone else's saved key.
    const guest = await socketFor();
    await call(guest, 'room:create', { name: 'Guest' });
    const guestAdd = await call(guest, 'lobby:addAi', { provider: 'groq', model: 'openai/gpt-oss-120b' });
    expect(guestAdd.ok).toBe(false);
    expect(guestAdd.error).toContain('Sign in');

    expect((await api('DELETE', '/api/keys/groq', {}, cookie)).json.ok).toBe(true);
    expect((await api('GET', '/api/keys', undefined, cookie)).json.keys).toEqual([]);
  });

  it('rate limits password guessing', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await api('POST', '/api/auth/login', { username: 'victim', password: `x${i}` })).status;
    expect(last).toBe(429);
  });

  it('keeps hashes of session tokens only', async () => {
    const { cookie } = await api('POST', '/api/auth/register', { username: 'tokens', password: 'secret1' });
    const token = cookie!.split('=')[1];
    const rows = await store.db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.some((r) => r.token_hash === hashToken(token))).toBe(true);
  });
});
