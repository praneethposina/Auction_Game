import { useEffect, useState, type FormEvent } from 'react';
import { AccountButton, useAuth } from '../auth.tsx';
import { loadName, saveName } from '../socket.ts';

const FEATURES = [
  { icon: '🏢', title: '200 real companies', text: 'NVIDIA, Anthropic, Google, TSMC, Visa… a fresh random pool every game.' },
  { icon: '🙈', title: 'Hidden turnovers', text: 'Tier and sector hint at value. Only the winner learns the real number.' },
  { icon: '🕵️', title: 'Private intel', text: 'Secret tips only you see. Trailing players get extra help.' },
  { icon: '🧩', title: 'Sectors & combos', text: 'Build empires: Ad Duopoly, Chip Supply Chain, Musk Empire and 70+ more.' },
  { icon: '📰', title: 'Market events', text: 'Rate hikes, oil shocks, AI booms. Real-world economics move profits.' },
  { icon: '🤖', title: 'Play vs AI', text: 'Save a free API key once, then add LLM players to any game and watch them reason.' },
];

export function Home({ enter }: { enter: (event: 'room:create' | 'room:join', payload: unknown) => Promise<string | null> }) {
  const params = new URLSearchParams(window.location.search);
  const { user } = useAuth();
  const [name, setName] = useState(loadName);
  useEffect(() => {
    if (user && !name.trim()) setName(user.username);
  }, [user, name]);
  const [code, setCode] = useState((params.get('room') ?? '').toUpperCase());
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async (kind: 'create' | 'join', e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) {
      setError('Enter your name first.');
      return;
    }
    if (kind === 'join' && code.trim().length < 4) {
      setError('Enter the room code your host shared.');
      return;
    }
    saveName(name.trim());
    setBusy(kind);
    setError(null);
    const err =
      kind === 'create'
        ? await enter('room:create', { name: name.trim() })
        : await enter('room:join', { name: name.trim(), code: code.trim().toUpperCase() });
    setBusy(null);
    if (err) setError(err);
  };

  const invited = code.length > 0;

  return (
    <div className="home">
      <div className="home-top">
        <AccountButton />
      </div>
      <div className="hero">
        <div className="logo">🔨</div>
        <h1>Company Auction</h1>
        <p>Bid on the world’s top companies, read the market, and build the most valuable empire. Play with friends or AI.</p>
      </div>

      <div className="home-grid">
        <form className="card stack" onSubmit={(e) => go(invited ? 'join' : 'create', e)}>
          <label className="field">
            Your name
            <input
              className="input"
              value={name}
              maxLength={20}
              placeholder="e.g. Praneeth"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {!invited && (
            <button className="btn primary block" type="submit" disabled={busy !== null}>
              {busy === 'create' ? 'Creating…' : 'Host a new game'}
            </button>
          )}
          <div className="divider" />
          <label className="field">
            Room code
            <input
              className="input code"
              value={code}
              maxLength={6}
              placeholder="ABCDE"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
          <button
            className={`btn block ${invited ? 'primary' : ''}`}
            type="button"
            disabled={busy !== null}
            onClick={() => go('join')}
          >
            {busy === 'join' ? 'Joining…' : 'Join game'}
          </button>
          {invited && (
            <button className="btn ghost sm" type="button" onClick={() => setCode('')}>
              or host your own game
            </button>
          )}
          {error && <div className="bad small">{error}</div>}
        </form>

        <div className="card stack">
          <h3>How it works</h3>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, color: 'var(--muted)' }}>
            <li>Everyone starts with the same budget.</li>
            <li>Each round, one company per player goes under the hammer. Its turnover is hidden.</li>
            <li>Win a company and its turnover is revealed to you alone.</li>
            <li>At the end of every round, your companies pay turnover minus running costs, boosted by synergies and moved by market news.</li>
            <li>The host picks the win condition: net worth, return on spend, cash, or portfolio value.</li>
          </ol>
        </div>
      </div>

      <div className="features">
        {FEATURES.map((f) => (
          <div key={f.title} className="card feature">
            <div className="icon">{f.icon}</div>
            <h4>{f.title}</h4>
            <p>{f.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
