import { useEffect, useRef, useState } from 'react';
import { EVENT_BY_ID } from '../../../shared/data/events.ts';
import { money } from '../../../shared/economy.ts';
import type { RoomView } from '../../../shared/types.ts';
import { useServerNow } from '../components/common.tsx';
import { FeedPanel, IntelPanel, MarketPanel, PlayersPanel, PortfolioPanel } from '../components/Panels.tsx';
import { Stage } from '../components/Stage.tsx';
import { Results } from './Results.tsx';

type Tab = 'auction' | 'portfolio' | 'intel' | 'market' | 'players';

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'auction', icon: '🔨', label: 'Auction' },
  { id: 'portfolio', icon: '💼', label: 'Portfolio' },
  { id: 'intel', icon: '🕵️', label: 'Intel' },
  { id: 'market', icon: '🏢', label: 'Market' },
  { id: 'players', icon: '👥', label: 'Players' },
];

export function Game({
  view,
  clockOffset,
  onLeave,
  onError,
}: {
  view: RoomView;
  clockOffset: number;
  onLeave: () => void;
  onError: (m: string) => void;
}) {
  const g = view.game!;
  const now = useServerNow(clockOffset);
  const [tab, setTab] = useState<Tab>('auction');
  const [seenIntel, setSeenIntel] = useState(g.me?.intel.length ?? 0);
  const phaseRef = useRef(g.phase);
  const isHost = view.meId === view.hostId;

  // Jump back to the auction when a new company hits the block.
  useEffect(() => {
    if (g.phase !== phaseRef.current && (g.phase === 'auction' || g.phase === 'intro')) setTab('auction');
    phaseRef.current = g.phase;
  }, [g.phase]);

  useEffect(() => {
    if (tab === 'intel') setSeenIntel(g.me?.intel.length ?? 0);
  }, [tab, g.me?.intel.length]);

  if (g.phase === 'finished' || !g.me) {
    return <Results view={view} onLeave={onLeave} onError={onError} />;
  }

  const event = g.event ? EVENT_BY_ID[g.event.id] : null;
  const newIntel = Math.max(0, g.me.intel.length - seenIntel);
  const tabClass = (t: string) => (tab === t ? 'tab-active' : '');

  return (
    <div className="game">
      <div className="hud">
        <div className="row" style={{ gap: 18 }}>
          <div className="stat">
            <span className="label">Round</span>
            <span className="value num">
              {g.round}/{g.totalRounds}
            </span>
          </div>
          <div className="stat">
            <span className="label">Cash</span>
            <span className="value num gold">{money(g.me.purse)}</span>
          </div>
          <div className="stat hide-sm">
            <span className="label">Companies</span>
            <span className="value num">{g.me.holdings.length}</span>
          </div>
          {event && (
            <div className="stat hide-sm" style={{ maxWidth: 360 }}>
              <span className="label">Market news</span>
              <span className="small" style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {event.icon} {event.headline}
              </span>
            </div>
          )}
        </div>
        <div className="row">
          <span className="chip hide-sm">Room {view.code}</span>
          <button
            className="btn sm ghost"
            onClick={() => {
              if (window.confirm('Leave this game for good? (If you just close the tab or lose signal, reopening the page reconnects you.)')) onLeave();
            }}
          >
            Leave
          </button>
        </div>
      </div>

      <div className="col-left">
        <PlayersPanel g={g} tabClass={tabClass} />
        <MarketPanel g={g} tabClass={tabClass} />
      </div>

      <div className={`col-stage ${tabClass('auction')}`} data-tab="auction">
        <Stage g={g} now={now} isHost={isHost} onError={onError} />
      </div>

      <div className="col-right">
        <PortfolioPanel g={g} tabClass={tabClass} />
        <IntelPanel g={g} tabClass={tabClass} />
        <FeedPanel g={g} tabClass={tabClass} />
      </div>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <span className="ico">{t.icon}</span>
            {t.label}
            {t.id === 'intel' && newIntel > 0 && <span className="badge">{newIntel}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
