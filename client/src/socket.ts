import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServer, ServerToClient } from '../../shared/types.ts';

export type GameSocket = Socket<ServerToClient, ClientToServer>;

export const socket: GameSocket = io({ transports: ['websocket', 'polling'] });

type EventName = keyof ClientToServer;

/** Emit an event that takes an acknowledgement callback and await the reply. */
export function request<T = unknown>(event: EventName, payload?: unknown): Promise<Ack<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'The server did not respond. Check your connection.' }), 8000);
    const done = (r: Ack<T>) => {
      clearTimeout(timer);
      resolve(r);
    };
    const emit = socket.emit as unknown as (...args: unknown[]) => void;
    if (payload === undefined) emit.call(socket, event, done);
    else emit.call(socket, event, payload, done);
  });
}

const SESSION_KEY = 'company-auction-session';

export interface StoredSession {
  code: string;
  token: string;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable (private mode): sessions just won't survive reloads
  }
}

const NAME_KEY = 'company-auction-name';
export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}
