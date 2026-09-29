import { existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';
import type {
  AccountUser,
  Ack,
  ClientToServer,
  SavedKey,
  ServerToClient,
  SessionInfo,
} from '../shared/types.ts';
import {
  accountCredentials,
  buildCatalog,
  providerById,
  PROVIDERS,
  serverCredentials,
  validateKey,
  type Credentials,
} from './ai/models.ts';
import type { Store, UserRow } from './db/store.ts';
import { RoomRegistry, type Room } from './rooms.ts';
import { hashPassword, hashToken, maskKey, newId, newToken, RateLimiter, verifyPassword, type Vault } from './security.ts';

const TICK_MS = 100;
const COOKIE = 'ca_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME = /^[A-Za-z0-9_.-]{3,20}$/;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

interface SocketData {
  code?: string;
  playerId?: string;
  user?: AccountUser;
}

type GameSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u: UserRow): AccountUser => ({ id: u.id, username: u.username });

export interface AppOptions {
  store: Store;
  vault: Vault;
  /** Serve the built client from dist/ if present. */
  serveClient?: boolean;
  tickMs?: number;
}

export function createApp({ store, vault, serveClient = true, tickMs = TICK_MS }: AppOptions) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const registerLimiter = new RateLimiter(20, 60 * 60 * 1000);
  const keyCheckLimiter = new RateLimiter(30, 10 * 60 * 1000);

  async function userFromHeaders(headers: IncomingHttpHeaders): Promise<UserRow | null> {
    const token = parseCookies(headers.cookie)[COOKIE];
    if (!token) return null;
    return store.sessionUser(hashToken(token), Date.now());
  }

  function setSession(req: Request, res: Response, token: string | null) {
    const secure = req.secure ? '; Secure' : '';
    const value = token
      ? `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`
      : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    res.setHeader('Set-Cookie', value);
  }

  async function startSession(req: Request, res: Response, user: UserRow) {
    const token = newToken();
    await store.createSession(hashToken(token), user.id, Date.now() + SESSION_MS);
    setSession(req, res, token);
  }

  // Reject cross-site state changes (cookies are SameSite=Lax, this is belt and braces).
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
      } catch {
        return res.status(403).json({ error: 'Bad origin.' });
      }
    }
    next();
  });

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  const requireUser = async (req: Request, res: Response): Promise<UserRow | null> => {
    const user = await userFromHeaders(req.headers);
    if (!user) res.status(401).json({ error: 'Please sign in first.' });
    return user;
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, db: store.db.kind });
  });

  // ── Auth ────────────────────────────────────────────────────

  app.post(
    '/api/auth/register',
    wrap(async (req, res) => {
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      if (!USERNAME.test(username))
        return res.status(400).json({ error: 'Username: 3–20 letters, numbers, dots, dashes or underscores.' });
      if (password.length < 6 || password.length > 200)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      if (!registerLimiter.take(req.ip ?? 'ip')) return res.status(429).json({ error: 'Too many sign-ups. Try again later.' });
      const user = await store.createUser(newId(), username, await hashPassword(password), Date.now());
      if (!user) return res.status(409).json({ error: 'That username is taken. Try signing in instead.' });
      await startSession(req, res, user);
      res.json({ user: publicUser(user) });
    }),
  );

  app.post(
    '/api/auth/login',
    wrap(async (req, res) => {
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      if (!loginLimiter.take(`${req.ip}:${username.toLowerCase()}`))
        return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
      const found = username ? await store.findLogin(username) : null;
      if (!found || !(await verifyPassword(password, found.passwordHash)))
        return res.status(401).json({ error: 'Wrong username or password.' });
      await startSession(req, res, found.user);
      res.json({ user: publicUser(found.user) });
    }),
  );

  app.post(
    '/api/auth/logout',
    wrap(async (req, res) => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) await store.deleteSession(hashToken(token));
      setSession(req, res, null);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/auth/me',
    wrap(async (req, res) => {
      const user = await userFromHeaders(req.headers);
      res.json({ user: user ? publicUser(user) : null });
    }),
  );

  // ── Saved API keys ──────────────────────────────────────────

  app.get('/api/providers', (_req, res) => {
    res.json({
      providers: PROVIDERS.filter((p) => p.userKeys).map((p) => ({
        id: p.id,
        label: p.label,
        signupUrl: p.signupUrl,
        freeTier: p.freeTier,
        keyHint: p.keyHint,
      })),
    });
  });

  app.get(
    '/api/keys',
    wrap(async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      const keys: SavedKey[] = (await store.listKeys(user.id)).map((k) => {
        const plain = vault.decrypt(k.secret);
        return { provider: k.provider, masked: plain ? maskKey(plain) : '••••', updatedAt: k.updatedAt, readable: plain !== null };
      });
      res.json({ keys });
    }),
  );

  app.put(
    '/api/keys/:provider',
    wrap(async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      const provider = providerById(String(req.params.provider));
      if (!provider?.userKeys) return res.status(404).json({ error: 'Unknown provider.' });
      const key = String(req.body?.key ?? '').trim();
      if (key.length < 8 || key.length > 400 || /\s/.test(key))
        return res.status(400).json({ error: 'That doesn’t look like an API key.' });
      if (!keyCheckLimiter.take(user.id)) return res.status(429).json({ error: 'Too many key checks. Try again later.' });
      const check = await validateKey(provider, key);
      if (check.rejected) return res.status(400).json({ error: check.detail });
      await store.putKey(user.id, provider.id, vault.encrypt(key), Date.now());
      res.json({ ok: true, check });
    }),
  );

  app.delete(
    '/api/keys/:provider',
    wrap(async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      await store.deleteKey(user.id, String(req.params.provider));
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/keys/:provider/test',
    wrap(async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      const provider = providerById(String(req.params.provider));
      const sealed = provider ? await store.getKey(user.id, provider.id) : null;
      if (!provider || !sealed) return res.status(404).json({ error: 'No saved key for that provider.' });
      const plain = vault.decrypt(sealed);
      if (!plain) return res.json({ check: { ok: false, rejected: false, detail: 'This key can’t be read anymore. Please paste it again.' } });
      if (!keyCheckLimiter.take(user.id)) return res.status(429).json({ error: 'Too many key checks. Try again later.' });
      res.json({ check: await validateKey(provider, plain) });
    }),
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  if (serveClient && existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|socket\.io)\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // ── Realtime game ───────────────────────────────────────────

  const httpServer = createServer(app);
  const io = new Server<ClientToServer, ServerToClient>(httpServer, {
    pingInterval: 10000,
    pingTimeout: 8000,
  });
  const rooms = new RoomRegistry();

  io.use((raw, next) => {
    const socket = raw as GameSocket;
    userFromHeaders(socket.handshake.headers)
      .then((u) => {
        if (u) socket.data.user = publicUser(u);
        next();
      })
      .catch(() => next());
  });

  function broadcast(room: Room) {
    const now = Date.now();
    for (const p of room.players) {
      if (p.kind !== 'human') continue;
      for (const sid of p.sockets) io.to(sid).emit('room:state', room.viewFor(p.id, now));
    }
  }

  function reply<T>(ack: unknown, result: Ack<T>) {
    if (typeof ack === 'function') (ack as (r: Ack<T>) => void)(result);
  }

  function session(room: Room, playerId: string): SessionInfo {
    const p = room.player(playerId)!;
    return { code: room.code, playerId: p.id, token: p.token };
  }

  /** The signed-in user's decrypted keys, by provider. */
  async function accountKeys(userId: string | undefined): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!userId) return out;
    for (const k of await store.listKeys(userId)) {
      const plain = vault.decrypt(k.secret);
      if (plain) out.set(k.provider, plain);
    }
    return out;
  }

  io.on('connection', (raw) => {
    const socket = raw as GameSocket;

    const current = (): { room: Room; playerId: string } | null => {
      const { code, playerId } = socket.data;
      const room = code ? rooms.get(code) : undefined;
      if (!room || !playerId || !room.player(playerId)) return null;
      return { room, playerId };
    };

    const bind = (room: Room, playerId: string) => {
      const prev = current();
      if (prev && (prev.room !== room || prev.playerId !== playerId)) {
        prev.room.detachSocket(prev.playerId, socket.id);
        broadcast(prev.room);
      }
      socket.data.code = room.code;
      socket.data.playerId = playerId;
      room.attachSocket(playerId, socket.id);
      room.tick(Date.now());
      broadcast(room);
    };

    const act = (ack: unknown, fn: (room: Room, playerId: string) => { ok: boolean; error?: string }) => {
      const ctx = current();
      if (!ctx) return reply(ack, { ok: false, error: 'You are not in a room.' });
      const result = fn(ctx.room, ctx.playerId);
      reply(ack, result.ok ? { ok: true } : { ok: false, error: result.error });
      if (result.ok) {
        ctx.room.touch();
        ctx.room.tick(Date.now());
        broadcast(ctx.room);
      }
    };

    socket.on('room:create', (p, ack) => {
      const room = rooms.create();
      const res = room.addHuman(p?.name);
      if (!res.ok) {
        rooms.delete(room.code);
        return reply(ack, { ok: false, error: res.error });
      }
      bind(room, res.data!.id);
      reply(ack, { ok: true, data: session(room, res.data!.id) });
    });

    socket.on('room:join', (p, ack) => {
      const room = rooms.get(p?.code);
      if (!room) return reply(ack, { ok: false, error: 'No room with that code.' });
      const res = room.addHuman(p?.name);
      if (!res.ok) return reply(ack, { ok: false, error: res.error });
      bind(room, res.data!.id);
      reply(ack, { ok: true, data: session(room, res.data!.id) });
    });

    socket.on('room:resume', (p, ack) => {
      const room = rooms.get(p?.code);
      const player = room && typeof p?.token === 'string' ? room.byToken(p.token) : undefined;
      if (!room || !player) return reply(ack, { ok: false, error: 'That session has expired.' });
      bind(room, player.id);
      reply(ack, { ok: true, data: session(room, player.id) });
    });

    socket.on('room:leave', () => {
      const ctx = current();
      if (!ctx) return;
      ctx.room.detachSocket(ctx.playerId, socket.id);
      ctx.room.leave(ctx.playerId);
      socket.data.code = undefined;
      socket.data.playerId = undefined;
      if (ctx.room.humanCount() === 0) rooms.delete(ctx.room.code);
      else broadcast(ctx.room);
    });

    socket.on('lobby:settings', (patch, ack) => act(ack, (room, pid) => room.updateSettings(pid, patch ?? {})));
    socket.on('lobby:remove', (p, ack) => act(ack, (room, pid) => room.remove(pid, p?.playerId)));
    socket.on('lobby:start', (ack) => act(ack, (room, pid) => room.start(pid, Date.now())));
    socket.on('game:rematch', (ack) => act(ack, (room, pid) => room.rematch(pid)));

    socket.on('lobby:addAi', async (spec, ack) => {
      const ctx = current();
      if (!ctx) return reply(ack, { ok: false, error: 'You are not in a room.' });
      const allowed = ctx.room.canAddAi(ctx.playerId);
      if (!allowed.ok) return reply(ack, { ok: false, error: allowed.error });
      let credentials: Credentials | undefined;
      if (spec?.provider) {
        const provider = providerById(spec.provider);
        if (!provider) return reply(ack, { ok: false, error: 'Unknown AI provider.' });
        const user = socket.data.user;
        if (user && provider.userKeys) {
          const plain = (await accountKeys(user.id)).get(provider.id);
          if (plain) credentials = accountCredentials(provider, plain) ?? undefined;
        }
        credentials ??= serverCredentials(provider) ?? undefined;
        if (!credentials) {
          return reply(ack, {
            ok: false,
            error: user
              ? `Save a ${provider.label} key under Account → API keys first.`
              : `Sign in and save a ${provider.label} key to use it.`,
          });
        }
      }
      act(ack, (room, pid) => room.addAi(pid, spec ?? {}, credentials, socket.data.user?.username));
    });

    socket.on('game:bid', (p, ack) =>
      act(ack, (room, pid) => room.game?.placeBid(pid, Number(p?.amount), Date.now()) ?? { ok: false, error: 'No game.' }),
    );
    socket.on('game:sealed', (p, ack) =>
      act(ack, (room, pid) => {
        const amount = p?.amount === null ? null : Number(p?.amount);
        return room.game?.submitSealed(pid, amount, Date.now()) ?? { ok: false, error: 'No game.' };
      }),
    );
    socket.on('game:out', (ack) =>
      act(ack, (room, pid) => room.game?.declareOut(pid, Date.now()) ?? { ok: false, error: 'No game.' }),
    );
    socket.on('game:skip', (ack) =>
      act(ack, (room, pid) => {
        if (pid !== room.hostId) return { ok: false, error: 'Only the host can skip.' };
        return room.game?.skip(Date.now()) ?? { ok: false, error: 'No game.' };
      }),
    );
    socket.on('game:pause', (p, ack) =>
      act(ack, (room, pid) => {
        if (pid !== room.hostId) return { ok: false, error: 'Only the host can pause.' };
        if (!room.game) return { ok: false, error: 'No game.' };
        return p?.paused ? room.game.pause(Date.now()) : room.game.resume(Date.now());
      }),
    );
    socket.on('game:end', (ack) =>
      act(ack, (room, pid) => {
        if (pid !== room.hostId) return { ok: false, error: 'Only the host can end the game.' };
        return room.game?.endEarly() ?? { ok: false, error: 'No game.' };
      }),
    );

    socket.on('ai:catalog', async (ack) => {
      try {
        reply(ack, { ok: true, data: await buildCatalog(await accountKeys(socket.data.user?.id)) });
      } catch {
        reply(ack, { ok: false, error: 'Could not load the model list.' });
      }
    });

    socket.on('disconnect', () => {
      const ctx = current();
      if (!ctx) return;
      ctx.room.detachSocket(ctx.playerId, socket.id);
      broadcast(ctx.room);
    });
  });

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.all()) {
      if (room.isAbandoned(now)) {
        rooms.delete(room.code);
        continue;
      }
      if (room.tick(now)) broadcast(room);
    }
  }, tickMs);

  const purger = setInterval(() => void store.purgeSessions(Date.now()).catch(() => {}), 60 * 60 * 1000);

  return {
    app,
    httpServer,
    io,
    rooms,
    close: async () => {
      clearInterval(ticker);
      clearInterval(purger);
      io.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
