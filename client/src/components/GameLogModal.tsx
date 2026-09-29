import { useEffect, useMemo, useState } from 'react';
import { llmStats } from '../../../shared/logstats.ts';
import { PROVIDER_LABELS, type GameLogEntry, type GameLogResponse } from '../../../shared/types.ts';
import { api } from '../api.ts';

type Filter = 'all' | 'llm' | 'problems' | 'lots' | 'players';

const FILTERS: { id: Filter; label: string; test: (e: GameLogEntry) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'llm', label: 'LLM calls', test: (e) => e.kind === 'llm' },
  { id: 'problems', label: 'Problems', test: (e) => e.level !== 'info' },
  { id: 'lots', label: 'Lots', test: (e) => e.kind === 'lot' || e.kind === 'round' || e.kind === 'game' },
  { id: 'players', label: 'Players & server', test: (e) => e.kind === 'player' || e.kind === 'server' },
];

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function clockTime(at: number, start: number) {
  const s = Math.max(0, Math.round((at - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The game's debug log: every lot, AI decision and LLM request, with timings and errors. */
export function GameLogModal({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const [data, setData] = useState<GameLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('llm');
  const [open, setOpen] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void api.gameLogs(gameId).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [gameId, tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stats = useMemo(() => (data ? llmStats(data.entries) : []), [data]);
  const shown = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)!.test;
    return data ? data.entries.filter(test).reverse() : [];
  }, [data, filter]);

  const download = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify({ ...data, llmStats: stats }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `auction-${data.game.roomCode}-${new Date(data.game.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}-log.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card log-modal" role="dialog" aria-modal="true" aria-label="Game log" onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 8 }}>
          <h2 style={{ fontSize: 20 }}>Game log</h2>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm ghost" onClick={() => setTick((t) => t + 1)} title="Reload">
              ↻
            </button>
            <button className="btn sm" onClick={download} disabled={!data}>
              ⬇ JSON
            </button>
            <button className="btn sm ghost" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        {error && <div className="bad small">{error}</div>}
        {!data && !error && <div className="muted small">Loading…</div>}
        {data && (
          <>
            <div className="hint" style={{ marginBottom: 10 }}>
              Room {data.game.roomCode} · started {new Date(data.game.startedAt).toLocaleString()} ·{' '}
              {data.game.status === 'playing' ? 'in progress' : data.game.status}.{' '}
              {data.revealed
                ? 'Game over: prompts, raw answers, AI max bids and hidden turnovers are included.'
                : 'Prompts, raw answers and AI bids stay hidden until the game ends.'}
            </div>

            {stats.length > 0 && (
              <div className="log-stats">
                {stats.map((s) => (
                  <div key={s.playerId} className="log-stat">
                    <div className="spread">
                      <strong>{s.name}</strong>
                      <span className={`chip ${s.fallbacks === 0 ? 'good' : s.ok === 0 ? 'bad' : 'warn'}`}>
                        {s.ok}/{s.calls} answered
                      </span>
                    </div>
                    <div className="tiny muted">
                      {PROVIDER_LABELS[s.provider] ?? s.provider} · {s.model}
                    </div>
                    <div className="tiny">
                      avg {secs(s.avgMs)} · p95 {secs(s.p95Ms)} · max {secs(s.maxMs)}
                      {s.late > 0 && <span className="bad"> · {s.late} too late</span>}
                    </div>
                    <div className="tiny">
                      {s.promptTokens > 0 ? `${s.promptTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out tokens` : 'no token counts reported'}
                      {s.calls > 0 && s.promptTokens > 0 && ` (~${Math.round(s.promptTokens / s.calls)} in per call)`}
                    </div>
                    {Object.keys(s.outcomes).some((o) => o !== 'ok') && (
                      <div className="tiny bad">
                        {Object.entries(s.outcomes)
                          .filter(([o]) => o !== 'ok')
                          .map(([o, n]) => `${o.replace(/_/g, ' ')} ×${n}`)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="segmented" style={{ margin: '10px 0' }}>
              {FILTERS.map((f) => (
                <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>

            {shown.length === 0 ? (
              <div className="empty">Nothing here yet.</div>
            ) : (
              <div className="log-list">
                {shown.map((e) => (
                  <div key={e.seq} className={`log-row ${e.level}`}>
                    <button className="log-line" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                      <span className="num faint">{clockTime(e.at, data.game.startedAt)}</span>
                      <span className={`log-kind ${e.kind}`}>{e.kind}</span>
                      <span className="grow">{e.msg}</span>
                    </button>
                    {open === e.seq && (
                      <pre className="log-detail">{JSON.stringify({ ...e.data, ...(e.secret ? { private: e.secret } : {}) }, null, 2)}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
