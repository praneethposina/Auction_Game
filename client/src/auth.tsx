import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountUser } from '../../shared/types.ts';
import { api } from './api.ts';
import { socket } from './socket.ts';

export type AccountTab = 'signin' | 'signup' | 'keys';

interface AuthState {
  user: AccountUser | null;
  loading: boolean;
  /** Bumps whenever saved keys change, so AI pickers can refresh. */
  keysVersion: number;
  accountOpen: AccountTab | null;
  openAccount: (tab?: AccountTab) => void;
  closeAccount: () => void;
  signIn: (mode: 'signin' | 'signup', username: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  keysChanged: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** The socket handshake carries the session cookie, so reconnect after signing in or out. */
function reconnectSocket() {
  socket.disconnect();
  socket.connect();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [keysVersion, setKeysVersion] = useState(0);
  const [accountOpen, setAccountOpen] = useState<AccountTab | null>(null);

  useEffect(() => {
    void api.me().then((r) => {
      if (r.ok) setUser(r.data.user);
      setLoading(false);
    });
  }, []);

  const signIn = useCallback(async (mode: 'signin' | 'signup', username: string, password: string) => {
    const r = mode === 'signup' ? await api.register(username, password) : await api.login(username, password);
    if (!r.ok) return r.error;
    setUser(r.data.user);
    setKeysVersion((v) => v + 1);
    reconnectSocket();
    return null;
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    setKeysVersion((v) => v + 1);
    reconnectSocket();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      keysVersion,
      accountOpen,
      openAccount: (tab) => setAccountOpen(tab ?? (user ? 'keys' : 'signin')),
      closeAccount: () => setAccountOpen(null),
      signIn,
      signOut,
      keysChanged: () => setKeysVersion((v) => v + 1),
    }),
    [user, loading, keysVersion, accountOpen, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function AccountButton() {
  const { user, loading, openAccount } = useAuth();
  if (loading) return null;
  return (
    <button className="btn sm" onClick={() => openAccount()}>
      {user ? `👤 ${user.username}` : 'Sign in'}
    </button>
  );
}
