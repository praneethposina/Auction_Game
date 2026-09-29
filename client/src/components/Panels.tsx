import { useState } from 'react';
import { COMBO_BY_ID } from '../../../shared/data/combos.ts';
import { SECTORS } from '../../../shared/data/sectors.ts';
import { money, pct } from '../../../shared/economy.ts';
import type { GameView } from '../../../shared/types.ts';
import { Monogram, PlayerTag, SectorChip, TierChip } from './common.tsx';

type PanelProps = { g: GameView; tabClass: (tab: string) => string };

export function PortfolioPanel({ g, tabClass }: PanelProps) {
  const me = g.me!;
  const perRound = me.holdings.reduce((s, h) => s + h.netPerRound, 0);
  const value = me.holdings.reduce((s, h) => s + h.valuation, 0);
  return (
    <div className={`card ${tabClass('portfolio')}`} data-tab="portfolio">
      <h3>My portfolio</h3>
      <div className="facts two" style={{ marginBottom: 10 }}>
        <div className="fact highlight">
          <div className="label">Cash</div>
          <div className="value num">{money(me.purse)}</div>
        </div>
        <div className="fact">
          <div className="label">Net / round</div>
          <div className={`value num ${perRound >= 0 ? 'good' : 'bad'}`}>{money(perRound)}</div>
        </div>
        <div className="fact">
          <div className="label">Company value</div>
          <div className="value num">{money(value)}</div>
        </div>
        <div className="fact">
          <div className="label">Spent · earned</div>
          <div className="value num small">
            {money(me.spent)} · <span className={me.income >= 0 ? 'good' : 'bad'}>{money(me.income)}</span>
          </div>
        </div>
      </div>
      {me.holdings.length === 0 ? (
        <div className="empty">No companies yet. Win an auction to learn a turnover.</div>
      ) : (
        <div className="list">
          {me.holdings.map((h) => {
            const c = g.companies.find((x) => x.id === h.companyId)!;
            return (
              <div key={h.companyId} className="holding">
                <div className="row">
                  <Monogram name={c.name} sector={c.sector} size="sm" />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    <div className="tiny muted">
                      Paid {money(h.price)} · round {h.roundBought}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num small">{money(h.turnover)}</div>
                    <div className={`tiny num ${h.netPerRound >= 0 ? 'good' : 'bad'}`}>net {money(h.netPerRound)}</div>
                  </div>
                </div>
                <div className="syn">
                  <SectorChip sector={c.sector} short />
                  {h.synergy.sectorBonus > 0 && (
                    <span className="chip good">
                      {h.synergy.sectorCount}× {SECTORS[c.sector].short} {pct(h.synergy.sectorBonus)}
                    </span>
                  )}
                  {h.synergy.combos.map((cb) => (
                    <span key={cb.comboId} className="chip good" title={COMBO_BY_ID[cb.comboId].why}>
                      {COMBO_BY_ID[cb.comboId].icon} {COMBO_BY_ID[cb.comboId].name} {pct(cb.bonus)}
                    </span>
                  ))}
                  {g.settings.runningCosts && <span className="chip">cost {money(h.runningCost)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {me.lastPayout && (
        <div className="hint" style={{ marginTop: 10 }}>
          Last payout (round {me.lastPayout.round}): {me.lastPayout.total >= 0 ? '+' : ''}
          {money(me.lastPayout.total)}
        </div>
      )}
    </div>
  );
}

export function IntelPanel({ g, tabClass }: PanelProps) {
  const me = g.me!;
  const sold = (ids: string[]) =>
    ids.length > 0 && ids.every((id) => g.companies.find((c) => c.id === id)?.status !== 'upcoming' && g.companies.find((c) => c.id === id)?.status !== 'auction');
  const tips = [...me.intel].reverse();
  return (
    <div className={`card ${tabClass('intel')}`} data-tab="intel">
      <div className="spread">
        <h3>🕵️ Private intel</h3>
        <span className="hint">Only you can see this</span>
      </div>
      {tips.length === 0 ? (
        <div className="empty">No tips yet. Trailing players get fresh intel after each round.</div>
      ) : (
        <div className="list">
          {tips.map((t) => (
            <div key={t.id} className={`tip ${sold(t.companyIds) ? 'stale' : ''}`}>
              <div>{t.text}</div>
              <div className="tiny muted" style={{ marginTop: 4 }}>
                {t.source === 'catchup' ? `📡 Catch-up tip · round ${t.round}` : 'Starting tip'}
                {sold(t.companyIds) ? ' · already auctioned' : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MarketPanel({ g, tabClass }: PanelProps) {
  const [show, setShow] = useState<'companies' | 'combos'>('companies');
  const playerName = (id: string | null) => g.players.find((p) => p.id === id)?.name ?? '';
  const order = { auction: 0, upcoming: 1, sold: 2, unsold: 3 } as const;
  const companies = [...g.companies].sort((a, b) => order[a.status] - order[b.status]);
  const inPool = new Map(g.companies.map((c) => [c.id, c]));
  const meId = g.me?.id;
  const upcoming = g.companies.filter((c) => c.status === 'upcoming').length;

  return (
    <div className={`card ${tabClass('market')}`} data-tab="market">
      <h3>Market</h3>
      <div style={{ marginBottom: 8 }}>
        <div className="segmented">
          <button className={show === 'companies' ? 'on' : ''} onClick={() => setShow('companies')}>
            Companies
          </button>
          <button className={show === 'combos' ? 'on' : ''} onClick={() => setShow('combos')}>
            Combos ({g.activeComboIds.length})
          </button>
        </div>
      </div>
      {show === 'companies' ? (
        <>
          <div className="hint" style={{ marginBottom: 6 }}>
            {upcoming} still to come. Auction order is secret.
          </div>
          <div className="stack" style={{ gap: 2 }}>
            {companies.map((c) => (
              <div
                key={c.id}
                className={`market-row ${c.status === 'auction' ? 'current' : ''} ${c.status === 'sold' || c.status === 'unsold' ? 'done' : ''}`}
              >
                <Monogram name={c.name} sector={c.sector} size="sm" />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <div className="tiny muted">
                    {SECTORS[c.sector].icon} {SECTORS[c.sector].short}
                    {c.status === 'sold' && ` · ${c.ownerId === meId ? 'you' : playerName(c.ownerId)} · ${money(c.price!)}`}
                    {c.status === 'unsold' && ' · withdrawn'}
                    {c.status === 'auction' && ' · on the block'}
                  </div>
                </div>
                <TierChip tier={c.tier} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="list">
          <div className="hint">
            Combos you can still build in this game. Own the required number of members to boost all of them.
          </div>
          {g.activeComboIds.length === 0 && <div className="empty">No named combos are possible with this pool.</div>}
          {g.activeComboIds.map((id) => {
            const combo = COMBO_BY_ID[id];
            return (
              <div key={id} className="combo">
                <div className="spread">
                  <strong>
                    {combo.icon} {combo.name}
                  </strong>
                  <span className="tiny num gold">{combo.tiers.map((t) => `${t.need}→${pct(t.bonus)}`).join(' · ')}</span>
                </div>
                <div className="tiny muted">{combo.why}</div>
                <div className="members">
                  {combo.members.map((m) => {
                    const c = inPool.get(m);
                    const cls = !c
                      ? 'absent'
                      : c.ownerId === meId
                        ? 'mine'
                        : c.ownerId || c.status === 'unsold'
                          ? 'theirs'
                          : c.status === 'auction'
                            ? 'block'
                            : '';
                    return (
                      <span key={m} className={`member ${cls}`} title={!c ? 'Not in this game' : c.ownerId ? playerName(c.ownerId) : c.status}>
                        {c?.name ?? m}
                        {combo.anchor === m ? ' ⚓' : ''}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="hint">
            Sector bonus: own 2 / 3 / 4+ in one sector for +10% / +20% / +35% on each. ⚓ = must own this one.
          </div>
        </div>
      )}
    </div>
  );
}

export function PlayersPanel({ g, tabClass }: PanelProps) {
  const nameOf = (id: string) => g.companies.find((c) => c.id === id)?.name ?? id;
  return (
    <div className={`card ${tabClass('players')}`} data-tab="players">
      <div className="spread">
        <h3>Players</h3>
        <span className="hint">Cash &amp; turnovers are secret</span>
      </div>
      <div className="list">
        {g.players.map((p) => (
          <div key={p.id} className={`item ${p.id === g.me?.id ? 'me' : ''}`} style={{ alignItems: 'flex-start' }}>
            <span className={`dot ${p.connected ? '' : 'off'}`} style={{ marginTop: 6 }} />
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                <strong>{p.name}</strong>
                {p.id === g.me?.id && <span className="faint small">(you)</span>}
                <PlayerTag kind={p.kind} model={p.ai?.modelLabel} />
              </div>
              <div className="tiny muted" style={{ marginTop: 3 }}>
                {p.companyIds.length === 0 ? 'No companies yet' : p.companyIds.map(nameOf).join(' · ')}
              </div>
            </div>
            <span className="chip num">{p.companyIds.length}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FeedPanel({ g, tabClass }: PanelProps) {
  const [show, setShow] = useState<'log' | 'ai'>('log');
  const hasAi = g.players.some((p) => p.kind !== 'human');
  const nameOf = (id: string) => g.players.find((p) => p.id === id)?.name ?? '?';
  const companyName = (id: string) => g.companies.find((c) => c.id === id)?.name ?? id;
  return (
    <div className={`card ${tabClass('players')}`} data-tab="players">
      <h3>Activity</h3>
      <div style={{ marginBottom: hasAi ? 8 : 0 }}>
        {hasAi && (
          <div className="segmented">
            <button className={show === 'log' ? 'on' : ''} onClick={() => setShow('log')}>
              Log
            </button>
            <button className={show === 'ai' ? 'on' : ''} onClick={() => setShow('ai')}>
              AI minds
            </button>
          </div>
        )}
      </div>
      {show === 'log' || !hasAi ? (
        <div className="log">
          {[...g.log].reverse().map((l) => (
            <div key={l.id} className={`entry ${l.private ? 'private' : ''}`}>
              {l.text}
            </div>
          ))}
        </div>
      ) : g.settings.aiReasoning === 'end' ? (
        <div className="empty">The host chose to reveal AI reasoning at the end of the game.</div>
      ) : g.aiThoughts.length === 0 ? (
        <div className="empty">AI reasoning appears here after each sale.</div>
      ) : (
        <div className="log">
          {[...g.aiThoughts].reverse().map((t) => (
            <div key={`${t.playerId}-${t.at}`} className="thought">
              <div className="spread">
                <strong>{nameOf(t.playerId)}</strong>
                <span className="tiny muted">
                  {companyName(t.companyId)} · {t.maxBid > 0 ? `max ${money(t.maxBid)}` : 'pass'}
                  {t.source === 'fallback' ? ' · backup' : ''}
                </span>
              </div>
              <div className="muted small">{t.reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
