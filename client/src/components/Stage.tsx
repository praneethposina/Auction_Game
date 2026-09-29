import { useEffect, useRef, useState } from 'react';
import { COMBO_BY_ID } from '../../../shared/data/combos.ts';
import { EVENT_BY_ID, type MarketEventDef } from '../../../shared/data/events.ts';
import { SECTORS, type SectorId } from '../../../shared/data/sectors.ts';
import {
  eventEffectFor,
  flag,
  likelyRange,
  money,
  pct,
  previewSynergy,
  VALUATION_MULTIPLE,
} from '../../../shared/economy.ts';
import type { GameView, PublicCompany } from '../../../shared/types.ts';
import { request } from '../socket.ts';
import { Countdown, Monogram, SectorChip, TierChip } from './common.tsx';

interface StageProps {
  g: GameView;
  now: number;
  isHost: boolean;
  onError: (m: string) => void;
}

const nameOf = (g: GameView, playerId: string | null) =>
  playerId ? (g.players.find((p) => p.id === playerId)?.name ?? '?') : '—';

function EffectChips({ event, g }: { event: MarketEventDef; g: GameView }) {
  const sectorsInGame = new Set(g.companies.map((c) => c.sector));
  const chips: { key: string; label: string; good: boolean }[] = [];
  for (const [sector, d] of Object.entries(event.demand) as [SectorId, number][]) {
    if (!d || !sectorsInGame.has(sector)) continue;
    chips.push({ key: `d-${sector}`, label: `${SECTORS[sector].icon} ${SECTORS[sector].short} sales ${pct(d)}`, good: d > 0 });
  }
  for (const [sector, d] of Object.entries(event.costs) as [SectorId, number][]) {
    if (!d || !sectorsInGame.has(sector)) continue;
    chips.push({ key: `c-${sector}`, label: `${SECTORS[sector].icon} ${SECTORS[sector].short} costs ${pct(d)}`, good: d < 0 });
  }
  const inPool = new Map(g.companies.map((c) => [c.id, c.name]));
  for (const [id, d] of Object.entries(event.companyDemand ?? {})) {
    if (!d || !inPool.has(id)) continue;
    chips.push({ key: `cd-${id}`, label: `${inPool.get(id)} sales ${pct(d)}`, good: d > 0 });
  }
  for (const [id, d] of Object.entries(event.companyCosts ?? {})) {
    if (!d || !inPool.has(id)) continue;
    chips.push({ key: `cc-${id}`, label: `${inPool.get(id)} costs ${pct(d)}`, good: d < 0 });
  }
  if (chips.length === 0) return <div className="hint">No direct effect on the sectors in this game.</div>;
  return (
    <div className="effects">
      {chips.map((c) => (
        <span key={c.key} className={`chip ${c.good ? 'good' : 'bad'}`}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

function SkipButton({ isHost, label = 'Skip ⏭' }: { isHost: boolean; label?: string }) {
  if (!isHost) return null;
  return (
    <button className="btn sm ghost" onClick={() => void request('game:skip')}>
      {label}
    </button>
  );
}

function IntroView({ g, now, isHost }: StageProps) {
  const event = g.event ? EVENT_BY_ID[g.event.id] : null;
  return (
    <div className="intro-card stack" style={{ gap: 12 }}>
      <div className="round">
        Round {g.round} of {g.totalRounds} · {g.slotsInRound} companies
      </div>
      {event ? (
        <>
          <div style={{ fontSize: 44 }}>{event.icon}</div>
          <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
            Market news
          </div>
          <div className="headline">{event.headline}</div>
          <p className="muted" style={{ margin: '0 auto', maxWidth: 560 }}>
            {event.story}
          </p>
          <EffectChips event={event} g={g} />
          <div className="hint">Applies to this round’s payouts.</div>
        </>
      ) : (
        <div className="headline">Get ready to bid</div>
      )}
      <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
        <span className="muted small">First company in</span>
        <Countdown endsAt={g.phaseEndsAt} now={now} />
        <SkipButton isHost={isHost} />
      </div>
    </div>
  );
}

function CompanyHeader({ c }: { c: PublicCompany }) {
  return (
    <div className="company-head">
      <Monogram name={c.name} sector={c.sector} size="lg" />
      <div className="grow">
        <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
          <SectorChip sector={c.sector} />
          <TierChip tier={c.tier} />
          <span className="chip" title="Headquarters">
            {flag(c.hq)} {c.hq}
          </span>
        </div>
        <h2>{c.name}</h2>
        <div className="muted small">{c.tagline}</div>
      </div>
    </div>
  );
}

function CompanyFacts({ g, c }: { g: GameView; c: PublicCompany }) {
  const s = g.settings;
  const me = g.me!;
  const range = likelyRange(c.tier, s.turnoverMin, s.turnoverMax);
  const event = g.event ? EVENT_BY_ID[g.event.id] : null;
  const eff = eventEffectFor(event, c.id);
  const preview = previewSynergy(
    me.holdings.map((h) => h.companyId),
    c.id,
  );
  const payoutsLeft = g.totalRounds - g.round + 1;
  const tips = me.intel.filter((t) => t.companyIds.includes(c.id));
  const upliftNames = Object.entries(preview.uplift).map(
    ([id, inc]) => `${g.companies.find((x) => x.id === id)?.name ?? id} ${pct(inc)}`,
  );
  const combos = g.activeComboIds.map((id) => COMBO_BY_ID[id]).filter((combo) => combo.members.includes(c.id));

  return (
    <div className="stack">
      <div className="facts">
        <div className="fact">
          <div className="label">Likely turnover</div>
          <div className="value num">
            {money(range.low)}–{money(range.high)}
          </div>
          <div className="tiny faint">per round · avg {money(range.mean)}</div>
        </div>
        {s.runningCosts && (
          <div className="fact">
            <div className="label">Running cost</div>
            <div className="value num">{money(c.runningCost)}</div>
            <div className="tiny faint">per round · {SECTORS[c.sector].short} margins</div>
          </div>
        )}
        <div className="fact">
          <div className="label">Payouts left</div>
          <div className="value num">{payoutsLeft}</div>
          <div className="tiny faint">+ worth {VALUATION_MULTIPLE}× net at the end</div>
        </div>
        {(eff.demand !== 1 || eff.cost !== 1) && (
          <div className="fact">
            <div className="label">This round’s news</div>
            <div className="value num">
              <span className={eff.demand >= 1 ? 'good' : 'bad'}>sales ×{eff.demand.toFixed(2)}</span>
              {s.runningCosts && eff.cost !== 1 && (
                <span className={eff.cost <= 1 ? 'good' : 'bad'}> · costs ×{eff.cost.toFixed(2)}</span>
              )}
            </div>
          </div>
        )}
        <div className={`fact ${preview.candidate.total > 0 ? 'highlight' : ''}`}>
          <div className="label">Your synergy if you win</div>
          <div className="value num">{preview.candidate.total > 0 ? pct(preview.candidate.total) : 'None yet'}</div>
          <div className="tiny faint">
            {preview.newCombos.length
              ? preview.newCombos.map((id) => COMBO_BY_ID[id].name).join(', ')
              : preview.candidate.sectorBonus > 0
                ? `${preview.sectorCountAfter} ${SECTORS[c.sector].short} companies`
                : 'No matching sector or combo'}
            {upliftNames.length ? ` · boosts ${upliftNames.join(', ')}` : ''}
          </div>
        </div>
      </div>
      {tips.length > 0 && (
        <div className="fact intel">
          <div className="label">🕵️ Your private intel</div>
          {tips.map((t) => (
            <div key={t.id} className="small" style={{ marginTop: 4 }}>
              {t.text}
            </div>
          ))}
        </div>
      )}
      {combos.length > 0 && (
        <div className="row wrap small" style={{ gap: 6 }}>
          <span className="muted">Part of:</span>
          {combos.map((combo) => (
            <span key={combo.id} className="chip" title={combo.why}>
              {combo.icon} {combo.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenBidControls({ g, onError }: { g: GameView; onError: (m: string) => void }) {
  const a = g.auction!;
  const me = g.me!;
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const leading = a.highBidderId === me.id;
  const out = a.outIds.includes(me.id);
  const next = a.minNextBid;
  const base = a.highBid ?? 0;
  const inc = Math.max(1, Math.round(g.settings.startingBudget / 200));
  const quick = [...new Set([next, Math.max(next, base + inc * 5), Math.max(next, base + inc * 10), Math.max(next, base + inc * 20)])];

  const bid = async (amount: number) => {
    setBusy(true);
    const r = await request('game:bid', { amount });
    setBusy(false);
    if (!r.ok) onError(r.error ?? 'Bid failed.');
    else setCustom('');
  };

  if (out) return <div className="callout">You dropped out of this auction. Watch the rest play out.</div>;
  const cannotAfford = me.purse < next;

  return (
    <div className="bid-controls">
      {leading ? (
        <div className="callout" style={{ borderColor: 'var(--gold)', color: 'var(--gold-2)' }}>
          🥇 You’re the highest bidder. Hold your nerve…
        </div>
      ) : cannotAfford ? (
        <div className="callout">You can’t afford the next bid ({money(next)}).</div>
      ) : (
        <div className="quick-bids">
          {quick.map((amt) => (
            <button key={amt} className="btn" disabled={busy || amt > me.purse} onClick={() => bid(amt)}>
              {money(amt)}
            </button>
          ))}
        </div>
      )}
      {!leading && !cannotAfford && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.round(Number(custom));
            if (n) void bid(n);
          }}
        >
          <input
            className="input num grow"
            inputMode="numeric"
            placeholder={`Custom bid (min ${next})`}
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ''))}
          />
          <button className="btn primary" disabled={busy || !custom} type="submit">
            Bid
          </button>
        </form>
      )}
      {!leading && (
        <button
          className="btn ghost block"
          onClick={async () => {
            const r = await request('game:out');
            if (!r.ok) onError(r.error ?? 'Could not drop out.');
          }}
        >
          I’m out ✋
        </button>
      )}
    </div>
  );
}

function SealedBidControls({ g, onError }: { g: GameView; onError: (m: string) => void }) {
  const a = g.auction!;
  const me = g.me!;
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const submitted = a.myBid !== undefined;

  const send = async (value: number | null) => {
    setBusy(true);
    const r = await request('game:sealed', { amount: value });
    setBusy(false);
    if (!r.ok) onError(r.error ?? 'Could not submit.');
  };

  const waitingOn = g.players.filter((p) => !a.sealedSubmittedIds.includes(p.id));

  return (
    <div className="bid-controls">
      {submitted ? (
        <div className="callout" style={{ borderColor: 'var(--gold)' }}>
          {a.myBid === null ? 'You passed on this company.' : <>✉️ Your sealed bid: <strong className="num gold">{money(a.myBid!)}</strong></>}
        </div>
      ) : (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Math.round(Number(amount));
              if (n) void send(n);
            }}
          >
            <input
              className="input num grow"
              inputMode="numeric"
              placeholder={`Your secret bid (min ${a.minNextBid}, max ${me.purse})`}
              value={amount}
              autoFocus
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            />
            <button className="btn primary" type="submit" disabled={busy || !amount}>
              Seal bid
            </button>
          </form>
          <button className="btn ghost block" disabled={busy} onClick={() => send(null)}>
            Pass
          </button>
        </>
      )}
      <div className="hint">
        {waitingOn.length === 0 ? 'Everyone has bid.' : `Waiting on: ${waitingOn.map((p) => p.name).join(', ')}`}
      </div>
    </div>
  );
}

function AuctionView({ g, now, onError }: StageProps) {
  const a = g.auction!;
  const c = g.companies.find((x) => x.id === a.companyId)!;
  const event = g.event ? EVENT_BY_ID[g.event.id] : null;
  const total = g.settings.bidSeconds * 1000;
  const overtime = now >= a.deadline && a.aiThinkingIds.length > 0;
  const lastBid = useRef<number | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    if (a.highBid !== null && a.highBid !== lastBid.current) setFlashKey((k) => k + 1);
    lastBid.current = a.highBid;
  }, [a.highBid]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="spread">
        <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
          Lot {g.slot} of {g.slotsInRound} · Round {g.round}/{g.totalRounds}
        </span>
        <span className="chip">{a.mode === 'open' ? '🔊 Open' : '✉️ Sealed'}</span>
      </div>
      {event && (
        <div className="event-strip">
          <span className="icon">{event.icon}</span>
          <span>
            <strong>{event.headline}</strong>
          </span>
        </div>
      )}
      <CompanyHeader c={c} />

      <div className="bid-board">
        <div>
          {a.mode === 'open' ? (
            a.highBid !== null ? (
              <>
                <div className="tiny muted">Highest bid · {nameOf(g, a.highBidderId)}</div>
                <div key={flashKey} className="amount flash">
                  {money(a.highBid)}
                </div>
              </>
            ) : (
              <>
                <div className="tiny muted">No bids yet · opening bid</div>
                <div className="amount">{money(a.minNextBid)}</div>
              </>
            )
          ) : (
            <>
              <div className="tiny muted">Sealed bids in</div>
              <div className="amount">
                {a.sealedSubmittedIds.length}/{g.players.length}
              </div>
            </>
          )}
        </div>
        <div style={{ minWidth: 110 }}>
          {overtime ? <div className="thinking">AI deciding…</div> : <Countdown endsAt={a.deadline} now={now} total={total} />}
        </div>
      </div>

      {a.aiThinkingIds.length > 0 && (
        <div className="row wrap" style={{ gap: 10 }}>
          {a.aiThinkingIds.map((id) => (
            <span key={id} className="thinking">
              {nameOf(g, id)} is thinking
            </span>
          ))}
        </div>
      )}

      {a.mode === 'open' ? <OpenBidControls g={g} onError={onError} /> : <SealedBidControls g={g} onError={onError} />}

      <CompanyFacts g={g} c={c} />

      {a.mode === 'open' && a.history.length > 0 && (
        <div className="history">
          {[...a.history].reverse().map((h, i) => (
            <div key={`${h.at}-${i}`} className="h-row">
              <span>{nameOf(g, h.playerId)}</span>
              <span className="num">{money(h.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {a.mode === 'open' && a.outIds.length > 0 && (
        <div className="hint">Out: {a.outIds.map((id) => nameOf(g, id)).join(', ')}</div>
      )}
    </div>
  );
}

function SoldView({ g, now, isHost }: StageProps) {
  const sale = g.lastSale!;
  const c = g.companies.find((x) => x.id === sale.companyId)!;
  const mine = sale.winnerId === g.me?.id;
  const holding = g.me?.holdings.find((h) => h.companyId === c.id);
  const thoughts = g.aiThoughts.filter((t) => t.companyId === c.id);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="hammer">
        <div className="big">{sale.winnerId ? '🔨' : '🚫'}</div>
      </div>
      <div style={{ textAlign: 'center' }} className="stack">
        <div className="row" style={{ justifyContent: 'center' }}>
          <Monogram name={c.name} sector={c.sector} />
          <h2 style={{ fontSize: 26 }}>{c.name}</h2>
        </div>
        {sale.winnerId ? (
          <div style={{ fontSize: 18 }}>
            Sold to <strong className={mine ? 'gold' : ''}>{mine ? 'you' : nameOf(g, sale.winnerId)}</strong> for{' '}
            <strong className="num">{money(sale.price!)}</strong>
          </div>
        ) : (
          <div className="muted">No bids. It’s withdrawn from the market.</div>
        )}
        {mine && sale.turnover !== undefined && holding && (
          <div className="stack" style={{ gap: 4, alignItems: 'center' }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
              Turnover revealed (only to you)
            </div>
            <div className="reveal">{money(sale.turnover)} / round</div>
            <div className="small muted">
              Net after costs &amp; synergy: <strong className={holding.netPerRound >= 0 ? 'good' : 'bad'}>{money(holding.netPerRound)}</strong>{' '}
              per round
              {holding.synergy.total > 0 ? ` (synergy ${pct(holding.synergy.total)})` : ''}
            </div>
          </div>
        )}
        {sale.winnerId && !mine && <div className="hint">Its turnover stays secret. Only the buyer knows.</div>}
      </div>
      {thoughts.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
            🤖 What the AIs were thinking
          </div>
          {thoughts.map((t) => (
            <div key={`${t.playerId}-${t.at}`} className="thought">
              <div className="spread">
                <strong>{nameOf(g, t.playerId)}</strong>
                <span className="num small">{t.maxBid > 0 ? `max ${money(t.maxBid)}` : 'passed'}</span>
              </div>
              <div className="muted">{t.reason}</div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
        <span className="muted small">Next up in</span>
        <Countdown endsAt={g.phaseEndsAt} now={now} />
        <SkipButton isHost={isHost} />
      </div>
    </div>
  );
}

function SummaryView({ g, now, isHost }: StageProps) {
  const me = g.me!;
  const payout = me.lastPayout && me.lastPayout.round === g.round ? me.lastPayout : null;
  const nameFor = (id: string) => g.companies.find((c) => c.id === id)?.name ?? id;
  const last = g.round >= g.totalRounds;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="intro-card" style={{ paddingTop: 6 }}>
        <div className="round">Round {g.round} complete</div>
        <div className="headline">💰 Payday</div>
      </div>
      {payout && payout.lines.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th className="r">Turnover</th>
                <th className="r">Synergy</th>
                <th className="r">News</th>
                {g.settings.runningCosts && <th className="r">Costs</th>}
                <th className="r">Net</th>
              </tr>
            </thead>
            <tbody>
              {payout.lines.map((l) => (
                <tr key={l.companyId}>
                  <td>{nameFor(l.companyId)}</td>
                  <td className="r num">{money(l.turnover)}</td>
                  <td className="r num">{l.synergy > 0 ? pct(l.synergy) : '–'}</td>
                  <td className={`r num ${l.demandMult > 1 ? 'good' : l.demandMult < 1 ? 'bad' : ''}`}>×{l.demandMult.toFixed(2)}</td>
                  {g.settings.runningCosts && <td className="r num bad">−{money(l.cost)}</td>}
                  <td className={`r num ${l.net >= 0 ? 'good' : 'bad'}`}>{money(l.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="callout">You don’t own any companies yet, so nothing paid out this round.</div>
      )}
      <div className="bid-board">
        <div>
          <div className="tiny muted">This round</div>
          <div className={`amount ${payout && payout.total < 0 ? 'bad' : ''}`} style={{ fontSize: 30 }}>
            {payout ? `${payout.total >= 0 ? '+' : ''}${money(payout.total)}` : money(0)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="tiny muted">Cash now</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
            {money(me.purse)}
          </div>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
        <span className="muted small">{last ? 'Final results in' : 'Next round in'}</span>
        <Countdown endsAt={g.phaseEndsAt} now={now} />
        <SkipButton isHost={isHost} />
      </div>
    </div>
  );
}

export function Stage(props: StageProps) {
  const { g } = props;
  return (
    <div className={`card stage phase-${g.phase}`}>
      {g.phase === 'intro' && <IntroView {...props} />}
      {g.phase === 'auction' && g.auction && <AuctionView {...props} />}
      {g.phase === 'sold' && g.lastSale && <SoldView {...props} />}
      {g.phase === 'summary' && <SummaryView {...props} />}
    </div>
  );
}
