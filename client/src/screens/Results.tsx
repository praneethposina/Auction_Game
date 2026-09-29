import { useState } from 'react';
import { SECTORS, type SectorId } from '../../../shared/data/sectors.ts';
import { money, pct } from '../../../shared/economy.ts';
import { WIN_CONDITION_LABEL, type RoomView, type StandingView } from '../../../shared/types.ts';
import { Monogram, PlayerTag } from '../components/common.tsx';
import { request } from '../socket.ts';

const MEDALS = ['🥇', '🥈', '🥉'];

function metricText(s: StandingView, wc: string) {
  if (wc === 'roi') return `${s.roi.toFixed(2)}×`;
  return money(s.metric);
}

export function Results({ view, onLeave, onError }: { view: RoomView; onLeave: () => void; onError: (m: string) => void }) {
  const g = view.game!;
  const r = g.results;
  const [open, setOpen] = useState<string | null>(view.meId);
  const isHost = view.meId === view.hostId;
  if (!r) return <div className="center-screen">Tallying results…</div>;

  const player = (id: string) => g.players.find((p) => p.id === id)!;
  const company = (id: string) => g.companies.find((c) => c.id === id)!;
  const podium = r.standings.slice(0, 3);
  const heat = (Object.entries(r.sectorHeat) as [SectorId, number][])
    .filter(([s]) => g.companies.some((c) => c.sector === s))
    .sort((a, b) => b[1] - a[1]);

  const rematch = async () => {
    const res = await request('game:rematch');
    if (!res.ok) onError(res.error ?? 'Could not start a rematch.');
  };

  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="topbar">
        <div className="brand">🔨 Company Auction</div>
        <div className="row">
          {isHost && (
            <button className="btn primary sm" onClick={rematch}>
              Play again
            </button>
          )}
          <button className="btn sm ghost" onClick={onLeave}>
            Leave
          </button>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'center' }}>
        <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>
          Final results · {WIN_CONDITION_LABEL[r.winCondition]}
        </div>
        <h2 style={{ fontSize: 30, margin: '8px 0 16px' }}>🏆 {player(r.standings[0].playerId).name} wins!</h2>
        <div className="podium">
          {[podium[1], podium[0], podium[2]].map((s, i) =>
            s ? (
              <div key={s.playerId} className={`place ${i === 1 ? 'first' : ''}`}>
                <div className="medal">{MEDALS[s.rank - 1] ?? `#${s.rank}`}</div>
                <div style={{ fontWeight: 700, marginTop: 4 }}>{player(s.playerId).name}</div>
                <div className="num gold" style={{ fontSize: 20, fontWeight: 700 }}>
                  {metricText(s, r.winCondition)}
                </div>
                <PlayerTag kind={player(s.playerId).kind} model={player(s.playerId).ai?.modelLabel} />
              </div>
            ) : (
              <div key={`empty-${i}`} />
            ),
          )}
        </div>
      </div>

      <div className="card">
        <h3>Standings</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th className="r">Net worth</th>
                <th className="r">Cash</th>
                <th className="r">Company value</th>
                <th className="r">Return</th>
                <th className="r">Spent</th>
              </tr>
            </thead>
            <tbody>
              {r.standings.map((s) => (
                <tr key={s.playerId} style={s.playerId === view.meId ? { background: 'rgba(245,184,61,0.07)' } : undefined}>
                  <td>{s.rank}</td>
                  <td>
                    <button className="btn ghost sm" style={{ padding: 0, minHeight: 0, border: 0 }} onClick={() => setOpen(s.playerId)}>
                      {player(s.playerId).name}
                    </button>
                  </td>
                  <td className="r num">{money(s.netWorth)}</td>
                  <td className="r num">{money(s.purse)}</td>
                  <td className="r num">{money(s.portfolioValue)}</td>
                  <td className="r num">{s.spent > 0 ? `${s.roi.toFixed(2)}×` : '–'}</td>
                  <td className="r num">{money(s.spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="lobby-grid">
        <div className="card">
          <h3>Portfolios revealed</h3>
          <div className="segmented" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            {r.standings.map((s) => (
              <button key={s.playerId} className={open === s.playerId ? 'on' : ''} onClick={() => setOpen(s.playerId)}>
                {player(s.playerId).name}
              </button>
            ))}
          </div>
          {r.standings
            .filter((s) => s.playerId === open)
            .map((s) => (
              <div key={s.playerId} className="list">
                {s.holdings.length === 0 && <div className="empty">Bought nothing.</div>}
                {s.holdings.map((h) => {
                  const c = company(h.companyId);
                  return (
                    <div key={h.companyId} className="holding">
                      <div className="row">
                        <Monogram name={c.name} sector={c.sector} size="sm" />
                        <div className="grow">
                          <div style={{ fontWeight: 600 }}>{c.name}</div>
                          <div className="tiny muted">
                            Paid {money(h.price)} in round {h.roundBought}
                            {h.synergy.total > 0 ? ` · synergy ${pct(h.synergy.total)}` : ''}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div className="num small">{money(h.turnover)}/rd</div>
                          <div className="tiny num muted">worth {money(h.valuation)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <h3>Secret sector temperatures</h3>
            <div className="row wrap" style={{ gap: 6 }}>
              {heat.map(([s, h]) => (
                <span key={s} className={`chip ${h > 0 ? 'good' : h < 0 ? 'bad' : ''}`}>
                  {SECTORS[s].icon} {SECTORS[s].short} {h > 0.1 ? '🔥🔥' : h > 0 ? '🔥' : h < -0.1 ? '🧊🧊' : h < 0 ? '🧊' : '·'}
                </span>
              ))}
            </div>
            {r.unsold.length > 0 && (
              <>
                <div className="divider" />
                <div className="small muted">Never sold:</div>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  {r.unsold.map((u) => (
                    <span key={u.companyId} className="chip">
                      {company(u.companyId).name} · {money(u.turnover)}/rd
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          {g.aiThoughts.length > 0 && (
            <div className="card">
              <h3>🤖 How the AIs played</h3>
              <div className="log" style={{ maxHeight: 420 }}>
                {g.aiThoughts.map((t) => (
                  <div key={`${t.playerId}-${t.at}`} className="thought">
                    <div className="spread">
                      <strong>{player(t.playerId).name}</strong>
                      <span className="tiny muted">
                        {company(t.companyId).name} · {t.maxBid > 0 ? `max ${money(t.maxBid)}` : 'pass'}
                        {company(t.companyId).ownerId === t.playerId ? ' · won' : ''}
                      </span>
                    </div>
                    <div className="muted small">{t.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
