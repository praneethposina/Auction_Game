import type { AccountUser, GameInfo, GameLogResponse, SavedKey } from '../../shared/types.ts';

export interface KeyCheck {
  ok: boolean;
  rejected: boolean;
  detail: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  signupUrl: string;
  freeTier: string;
  keyHint: string;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true, data: json };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

export const api = {
  me: () => call<{ user: AccountUser | null }>('GET', '/api/auth/me'),
  register: (username: string, password: string) =>
    call<{ user: AccountUser }>('POST', '/api/auth/register', { username, password }),
  login: (username: string, password: string) => call<{ user: AccountUser }>('POST', '/api/auth/login', { username, password }),
  logout: () => call<{ ok: boolean }>('POST', '/api/auth/logout', {}),
  providers: () => call<{ providers: ProviderInfo[] }>('GET', '/api/providers'),
  keys: () => call<{ keys: SavedKey[] }>('GET', '/api/keys'),
  saveKey: (provider: string, key: string) => call<{ ok: boolean; check: KeyCheck }>('PUT', `/api/keys/${provider}`, { key }),
  deleteKey: (provider: string) => call<{ ok: boolean }>('DELETE', `/api/keys/${provider}`, {}),
  testKey: (provider: string) => call<{ check: KeyCheck }>('POST', `/api/keys/${provider}/test`, {}),
  myGames: () => call<{ games: GameInfo[] }>('GET', '/api/games'),
  gameLogs: (gameId: string) => call<GameLogResponse>('GET', `/api/games/${encodeURIComponent(gameId)}/logs`),
};
