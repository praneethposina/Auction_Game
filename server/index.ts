// Load .env before anything reads process.env.
import './env.ts';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import type { Ack, ClientToServer, ServerToClient, SessionInfo } from '../shared/types.ts';
import { buildCatalog } from './ai/models.ts';
import { RoomRegistry, type Room } from './rooms.ts';

const PORT = Number(process.env.PORT ?? 3001);
const TICK_MS = 100;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const app = express();
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/(api|socket\.io)\/).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const httpServer = createServer(app);
const io = new Server<ClientToServer, ServerToClient>(httpServer, {
  cors: { origin: true },
  pingInterval: 10000,
  pingTimeout: 8000,
});

const rooms = new RoomRegistry();

interface SocketData {
  code?: string;
  playerId?: string;
}

type GameSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

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

  /** Run a room action and push fresh state to everyone if it succeeded. */
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
  socket.on('lobby:addAi', (spec, ack) => act(ack, (room, pid) => room.addAi(pid, spec ?? {})));
  socket.on('lobby:remove', (p, ack) => act(ack, (room, pid) => room.remove(pid, p?.playerId)));
  socket.on('lobby:start', (ack) => act(ack, (room, pid) => room.start(pid, Date.now())));
  socket.on('game:rematch', (ack) => act(ack, (room, pid) => room.rematch(pid)));

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

  socket.on('ai:catalog', async (ack) => {
    try {
      reply(ack, { ok: true, data: await buildCatalog() });
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

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.all()) {
    if (room.isAbandoned(now)) {
      rooms.delete(room.code);
      continue;
    }
    if (room.tick(now)) broadcast(room);
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  const mode = existsSync(dist) ? 'serving the built client' : 'API only (run the Vite dev server for the UI)';
  console.log(`🔨 Company Auction server on http://localhost:${PORT} (${mode})`);
});
