import { useEffect, useMemo, useState } from 'react';
import { money } from '../../../shared/economy.ts';
import {
  LIMITS,
  PERSONAS,
  WIN_CONDITION_LABEL,
  type AiCatalog,
  type GameSettings,
  type Persona,
  type RoomView,
  type WinCondition,
} from '../../../shared/types.ts';
import { PlayerTag, Segmented, Toggle } from '../components/common.tsx';
import { request } from '../socket.ts';

const WIN_HINT: Record<WinCondition, string> = {
  netWorth: 'Cash + value of your companies. Balanced; the default.',
  roi: 'Everything you earned ÷ what you spent. Rewards bargains.',
  purse: 'Only cash counts. Companies matter for what they pay out.',
  portfolio: 'Only company value counts. Spend it all, wisely.',
};

function NumberField({
  label,
  value,
  onCommit,
  disabled,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
  min: number;
  max: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || draft.trim() === '') return setDraft(String(value));
    if (n !== value) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <label className="field">
      <span>
        {label}
        {suffix ? <span className="faint"> {suffix}</span> : null}
      </span>
      <input
        className="input num"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function AddAi({ onError, disabled }: { onError: (m: string) => void; disabled: boolean }) {
  const [catalog, setCatalog] = useState<AiCatalog | null>(null);
  const [kind, setKind] = useState<'bot' | 'llm'>('bot');
  const [persona, setPersona] = useState<Persona>('balanced');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void request<AiCatalog>('ai:catalog').then((r) => {
      if (!r.ok || !r.data) return;
      setCatalog(r.data);
      const first = r.data.providers.find((p) => p.configured);
      if (first) {
        setProvider(first.id);
        setKind('llm');
      }
    });
  }, []);

  const configured = catalog?.providers.filter((p) => p.configured) ?? [];
  const models = useMemo(() => catalog?.models.filter((m) => m.provider === provider) ?? [], [catalog, provider]);
  useEffect(() => {
    if (models.length && !models.some((m) => m.model === model)) setModel(models[0].model);
  }, [models, model]);

  const add = async () => {
    setBusy(true);
    const chosen = models.find((m) => m.model === model);
    const payload =
      kind === 'bot'
        ? { persona, name: name.trim() || undefined }
        : { persona, provider, model, modelLabel: chosen?.label ?? model, name: name.trim() || undefined };
    const r = await request('lobby:addAi', payload);
    setBusy(false);
    if (!r.ok) onError(r.error ?? 'Could not add AI player.');
    else setName('');
  };

  return (
    <div className="card stack">
      <h3>Add AI players</h3>
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: 'bot', label: '⚙️ Built-in bot' },
          { value: 'llm', label: '🤖 LLM model' },
        ]}
      />

      {kind === 'llm' && (
        <>
          {configured.length === 0 ? (
            <div className="callout stack" style={{ gap: 6 }}>
              <div>
                No LLM provider is configured on the server yet. Add a free API key to <code>.env</code> and restart:
              </div>
              {catalog?.providers.map((p) => (
                <div key={p.id}>
                  <strong>{p.label}</strong>: <code>{p.envVar}</code>.{' '}
                  <span className="faint">{p.freeTier}</span>{' '}
                  <a href={p.signupUrl} target="_blank" rel="noreferrer">
                    Get a key
                  </a>
                </div>
              ))}
            </div>
          ) : (
            <>
              <label className="field">
                Provider
                <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {configured.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="hint">{catalog?.providers.find((p) => p.id === provider)?.freeTier}</div>
              <label className="field">
                Model
                <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.recommended ? '★ ' : ''}
                      {m.label}
                      {m.note ? ` · ${m.note}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {catalog && catalog.providers.some((p) => !p.configured) && (
                <div className="hint">
                  More providers:{' '}
                  {catalog.providers
                    .filter((p) => !p.configured)
                    .map((p) => `${p.label} (${p.envVar})`)
                    .join(', ')}
                </div>
              )}
            </>
          )}
        </>
      )}

      <label className="field">
        Personality
        <select className="select" value={persona} onChange={(e) => setPersona(e.target.value as Persona)}>
          {Object.entries(PERSONAS).map(([id, p]) => (
            <option key={id} value={id}>
              {p.label}: {p.blurb}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          Name <span className="faint">(optional)</span>
        </span>
        <input className="input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
      </label>
      <button
        className="btn block"
        disabled={disabled || busy || (kind === 'llm' && (configured.length === 0 || !model))}
        onClick={add}
      >
        {busy ? 'Adding…' : `Add ${kind === 'bot' ? 'bot' : 'LLM player'}`}
      </button>
    </div>
  );
}

export function Lobby({ view, onLeave, onError }: { view: RoomView; onLeave: () => void; onError: (m: string) => void }) {
  const isHost = view.meId === view.hostId;
  const s = view.settings;
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const link = `${window.location.origin}/?room=${view.code}`;
  const rounds = Math.ceil(s.companyCount / Math.max(1, view.players.length));
  const full = view.players.length >= s.maxPlayers;

  const set = async (patch: Partial<GameSettings>) => {
    const r = await request('lobby:settings', patch);
    if (!r.ok) onError(r.error ?? 'Could not update settings.');
  };

  const copy = async () => {
    try {
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        await navigator.share({ title: 'Company Auction', text: `Join my game with code ${view.code}`, url: link });
      } else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      // user cancelled the share sheet
    }
  };

  const start = async () => {
    setStarting(true);
    const r = await request('lobby:start');
    setStarting(false);
    if (!r.ok) onError(r.error ?? 'Could not start.');
  };

  const remove = async (playerId: string) => {
    const r = await request('lobby:remove', { playerId });
    if (!r.ok) onError(r.error ?? 'Could not remove player.');
  };

  return (
    <div className="page">
      <div className="topbar">
        <div className="brand">🔨 Company Auction</div>
        <button className="btn sm ghost" onClick={onLeave}>
          Leave
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread wrap" style={{ flexWrap: 'wrap' }}>
          <div className="room-code">
            <div>
              <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                Room code
              </div>
              <div className="code">{view.code}</div>
            </div>
            <button className="btn sm" onClick={copy}>
              {copied ? '✓ Link copied' : '🔗 Share invite'}
            </button>
          </div>
          {isHost ? (
            <button className="btn primary" onClick={start} disabled={starting || view.players.length < 2}>
              {starting ? 'Starting…' : `Start game ▶`}
            </button>
          ) : (
            <div className="muted small">Waiting for the host to start…</div>
          )}
        </div>
        {isHost && view.players.length < 2 && (
          <div className="hint" style={{ marginTop: 8 }}>
            Share the code with friends, or add AI players below. You need at least 2 players.
          </div>
        )}
      </div>

      <div className="lobby-grid">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="spread">
              <h3>Players</h3>
              <span className="muted small num">
                {view.players.length} / {s.maxPlayers}
              </span>
            </div>
            <div className="list">
              {view.players.map((p) => (
                <div key={p.id} className={`item ${p.id === view.meId ? 'me' : ''}`}>
                  <span className={`dot ${p.connected ? '' : 'off'}`} title={p.connected ? 'Online' : 'Offline'} />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>
                      {p.name} {p.id === view.meId && <span className="faint small">(you)</span>}
                    </div>
                    {p.ai && (
                      <div className="tiny muted">
                        {PERSONAS[p.ai.persona].label}
                        {p.ai.provider ? ` · ${p.ai.provider}` : ''}
                      </div>
                    )}
                  </div>
                  {p.isHost && <span className="chip host">Host</span>}
                  <PlayerTag kind={p.kind} model={p.ai?.modelLabel} />
                  {isHost && !p.isHost && (
                    <button className="btn sm ghost" onClick={() => remove(p.id)} aria-label={`Remove ${p.name}`}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
          {isHost && <AddAi onError={onError} disabled={full} />}
          {isHost && full && <div className="hint">The room is full. Raise “Max players” to add more.</div>}
        </div>

        <div className="card">
          <div className="spread">
            <h3>Game settings</h3>
            {!isHost && <span className="hint">Only the host can change these</span>}
          </div>
          <div className="settings-grid">
            <NumberField
              label="Companies to auction"
              value={s.companyCount}
              min={LIMITS.companyCount[0]}
              max={LIMITS.companyCount[1]}
              disabled={!isHost}
              onCommit={(v) => set({ companyCount: v })}
            />
            <NumberField
              label="Max players"
              value={s.maxPlayers}
              min={LIMITS.maxPlayers[0]}
              max={LIMITS.maxPlayers[1]}
              disabled={!isHost}
              onCommit={(v) => set({ maxPlayers: v })}
            />
            <div className="full hint">
              {s.companyCount} companies ÷ {view.players.length} player{view.players.length === 1 ? '' : 's'} ={' '}
              <strong className="gold">
                {rounds} round{rounds === 1 ? '' : 's'}
              </strong>{' '}
              (one company per player per round, drawn from 200).
            </div>
            <NumberField
              label="Starting budget"
              suffix="($M)"
              value={s.startingBudget}
              min={LIMITS.startingBudget[0]}
              max={LIMITS.startingBudget[1]}
              disabled={!isHost}
              onCommit={(v) => set({ startingBudget: v })}
            />
            <NumberField
              label="Bid timer"
              suffix="(seconds)"
              value={s.bidSeconds}
              min={LIMITS.bidSeconds[0]}
              max={LIMITS.bidSeconds[1]}
              disabled={!isHost}
              onCommit={(v) => set({ bidSeconds: v })}
            />
            <NumberField
              label="Turnover range: min"
              suffix="($M / round)"
              value={s.turnoverMin}
              min={LIMITS.turnoverMin[0]}
              max={LIMITS.turnoverMin[1]}
              disabled={!isHost}
              onCommit={(v) => set({ turnoverMin: v })}
            />
            <NumberField
              label="Turnover range: max"
              suffix="($M / round)"
              value={s.turnoverMax}
              min={LIMITS.turnoverMax[0]}
              max={LIMITS.turnoverMax[1]}
              disabled={!isHost}
              onCommit={(v) => set({ turnoverMax: v })}
            />
            <div className="full hint">
              Hidden turnovers are drawn from {money(s.turnoverMin)}–{money(s.turnoverMax)} with a binomial distribution. Mega
              companies lean high, Mid companies lean low, and each sector runs secretly hot or cold every game.
            </div>

            <div className="full field">
              <span className="muted small" style={{ fontWeight: 500 }}>
                Auction style
              </span>
              <Segmented
                value={s.auctionMode}
                disabled={!isHost}
                onChange={(v) => set({ auctionMode: v })}
                options={[
                  { value: 'open', label: '🔊 Open bidding' },
                  { value: 'sealed', label: '✉️ Sealed bid' },
                ]}
              />
              <span className="hint">
                {s.auctionMode === 'open'
                  ? 'Live ascending auction. The timer resets after every bid.'
                  : 'Everyone submits one secret bid. Highest wins and pays its bid.'}
              </span>
            </div>

            <div className="full field">
              <span className="muted small" style={{ fontWeight: 500 }}>
                Win condition
              </span>
              <div className="option-cards">
                {(Object.keys(WIN_CONDITION_LABEL) as WinCondition[]).map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`option-card ${s.winCondition === w ? 'on' : ''}`}
                    disabled={!isHost}
                    onClick={() => set({ winCondition: w })}
                  >
                    <strong>{WIN_CONDITION_LABEL[w]}</strong>
                    <span>{WIN_HINT[w]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="full">
              <Toggle
                label="Running costs"
                hint="Companies cost money to operate every round. Thin-margin sectors cost more."
                checked={s.runningCosts}
                disabled={!isHost}
                onChange={(v) => set({ runningCosts: v })}
              />
              <Toggle
                label="Market events"
                hint="A real-world headline each round shifts demand and costs by sector."
                checked={s.marketEvents}
                disabled={!isHost}
                onChange={(v) => set({ marketEvents: v })}
              />
              <Toggle
                label="Catch-up intel"
                hint="The player in last place gets an extra private tip after each round."
                checked={s.catchUpIntel}
                disabled={!isHost}
                onChange={(v) => set({ catchUpIntel: v })}
              />
              <Toggle
                label="Show AI reasoning live"
                hint="After each sale, reveal why each AI bid what it did. Off = reveal at the end."
                checked={s.aiReasoning === 'live'}
                disabled={!isHost}
                onChange={(v) => set({ aiReasoning: v ? 'live' : 'end' })}
              />
            </div>
            <div className="full field">
              <span className="muted small" style={{ fontWeight: 500 }}>
                Private intel tips per player at the start
              </span>
              <Segmented
                value={String(s.intelPerPlayer)}
                disabled={!isHost}
                onChange={(v) => set({ intelPerPlayer: Number(v) })}
                options={[0, 1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
