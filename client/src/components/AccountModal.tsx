import { useEffect, useState, type FormEvent } from 'react';
import type { GameInfo, SavedKey } from '../../../shared/types.ts';
import { api, type KeyCheck, type ProviderInfo } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { GameLogModal } from './GameLogModal.tsx';

function SignInForm({ initial }: { initial: 'signin' | 'signup' }) {
  const { signIn } = useAuth();
  const [mode, setMode] = useState(initial);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(mode, username.trim(), password);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="segmented" role="tablist">
        <button type="button" className={mode === 'signin' ? 'on' : ''} onClick={() => setMode('signin')}>
          Sign in
        </button>
        <button type="button" className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>
          Create account
        </button>
      </div>
      <label className="field">
        Username
        <input
          className="input"
          autoComplete="username"
          value={username}
          maxLength={20}
          autoFocus
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="field">
        Password
        <input
          className="input"
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {mode === 'signup' && <div className="hint">3–20 letters or numbers. Password: 6+ characters. No email needed.</div>}
      {error && <div className="bad small">{error}</div>}
      <button className="btn primary block" type="submit" disabled={busy || !username.trim() || !password}>
        {busy ? 'One moment…' : mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
      <div className="hint">
        An account saves your AI API keys so you can bring LLM players into any game. You can always play without one.
      </div>
    </form>
  );
}

function KeyRow({
  provider,
  saved,
  onChanged,
}: {
  provider: ProviderInfo;
  saved: SavedKey | undefined;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const r = await api.saveKey(provider.id, value.trim());
    setBusy(false);
    if (!r.ok) return setStatus({ ok: false, text: r.error });
    setStatus({ ok: r.data.check.ok, text: r.data.check.ok ? 'Saved and verified ✓' : `Saved. ${r.data.check.detail}` });
    setValue('');
    setEditing(false);
    onChanged();
  };

  const test = async () => {
    setBusy(true);
    const r = await api.testKey(provider.id);
    setBusy(false);
    const check: KeyCheck | null = r.ok ? r.data.check : null;
    setStatus(check ? { ok: check.ok, text: check.detail } : { ok: false, text: r.ok ? '' : r.error });
  };

  const remove = async () => {
    setBusy(true);
    await api.deleteKey(provider.id);
    setBusy(false);
    setStatus(null);
    onChanged();
  };

  return (
    <div className="key-row">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div style={{ fontWeight: 700 }}>{provider.label}</div>
          <div className="tiny muted">{provider.freeTier}</div>
        </div>
        {saved ? (
          <span className={`chip ${saved.readable ? 'good' : 'bad'}`}>
            {saved.readable ? `✓ ${saved.masked}` : 'Re-enter key'}
          </span>
        ) : (
          <a className="btn sm" href={provider.signupUrl} target="_blank" rel="noreferrer">
            Get free key ↗
          </a>
        )}
      </div>

      {editing || !saved ? (
        <form className="row" style={{ marginTop: 8 }} onSubmit={save}>
          <input
            className="input num grow"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Paste key (${provider.keyHint})`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="btn primary" disabled={busy || value.trim().length < 8} type="submit">
            {busy ? 'Checking…' : 'Save'}
          </button>
        </form>
      ) : (
        <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
          <button className="btn sm" disabled={busy} onClick={test}>
            Test
          </button>
          <button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>
            Replace
          </button>
          <button className="btn sm danger" disabled={busy} onClick={remove}>
            Remove
          </button>
        </div>
      )}
      {status && <div className={`small ${status.ok ? 'good' : 'bad'}`} style={{ marginTop: 6 }}>{status.text}</div>}
    </div>
  );
}

function KeysManager() {
  const { user, signOut, keysChanged, keysVersion } = useAuth();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [keys, setKeys] = useState<SavedKey[]>([]);

  useEffect(() => {
    void api.providers().then((r) => r.ok && setProviders(r.data.providers));
  }, []);
  useEffect(() => {
    void api.keys().then((r) => r.ok && setKeys(r.data.keys));
  }, [keysVersion]);

  return (
    <div className="stack">
      <div className="spread">
        <div>
          Signed in as <strong>{user?.username}</strong>
        </div>
        <button className="btn sm ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <div className="divider" />
      <div>
        <h3 style={{ marginBottom: 4 }}>AI API keys</h3>
        <div className="hint">
          Paste a free key from any provider below. When you host, you can then add LLM players powered by your key.
          Keys are encrypted on the server and never shown to other players.
        </div>
      </div>
      <div className="list">
        {providers.map((p) => (
          <KeyRow key={p.id} provider={p} saved={keys.find((k) => k.provider === p.id)} onChanged={keysChanged} />
        ))}
      </div>
      <div className="divider" />
      <RecentGames />
    </div>
  );
}

/** Games this account played in, each with its debug log. */
function RecentGames() {
  const [games, setGames] = useState<GameInfo[] | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  useEffect(() => {
    void api.myGames().then((r) => setGames(r.ok ? r.data.games : []));
  }, []);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3 style={{ marginBottom: 0 }}>Recent games</h3>
      <div className="hint">Logs show every lot, AI decision and LLM request with timings and errors. Kept for 30 days.</div>
      {games === null ? (
        <div className="muted small">Loading…</div>
      ) : games.length === 0 ? (
        <div className="empty">No games yet. Games you play while signed in show up here.</div>
      ) : (
        <div className="list">
          {games.map((g) => {
            const llms = g.players.filter((p) => p.kind === 'llm').length;
            return (
              <div key={g.id} className="item">
                <div className="grow">
                  <div className="small" style={{ fontWeight: 600 }}>
                    {new Date(g.startedAt).toLocaleString()} · room {g.roomCode}
                  </div>
                  <div className="tiny muted">
                    {g.players.length} players{llms ? ` (${llms} LLM)` : ''} · {g.status === 'playing' ? 'in progress' : g.status}
                  </div>
                </div>
                <button className="btn sm ghost" onClick={() => setLogFor(g.id)}>
                  📜 Log
                </button>
              </div>
            );
          })}
        </div>
      )}
      {logFor && <GameLogModal gameId={logFor} onClose={() => setLogFor(null)} />}
    </div>
  );
}

export function AccountModal() {
  const { user, accountOpen, closeAccount } = useAuth();

  useEffect(() => {
    if (!accountOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeAccount();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accountOpen, closeAccount]);

  if (!accountOpen) return null;
  return (
    <div className="modal-backdrop" onClick={closeAccount}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label="Account" onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: 20 }}>{user ? 'Your account' : 'Sign in'}</h2>
          <button className="btn sm ghost" onClick={closeAccount} aria-label="Close">
            ✕
          </button>
        </div>
        {user ? <KeysManager /> : <SignInForm initial={accountOpen === 'signup' ? 'signup' : 'signin'} />}
      </div>
    </div>
  );
}
