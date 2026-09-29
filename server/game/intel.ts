import { COMPANY_BY_ID } from '../../shared/data/companies.ts';
import type { MarketEventDef } from '../../shared/data/events.ts';
import { SECTORS, type SectorId } from '../../shared/data/sectors.ts';
import { money } from '../../shared/economy.ts';
import type { IntelKind, IntelTip } from '../../shared/types.ts';
import type { Rng } from './rng.ts';

export interface IntelContext {
  rng: Rng;
  turnoverMin: number;
  turnoverMax: number;
  /** Every company in this game's pool with its hidden turnover. */
  pool: { id: string; turnover: number; status: string }[];
  heat: Record<SectorId, number>;
  /** Market event per round (index 0 = round 1). Empty when events are off. */
  events: MarketEventDef[];
  round: number;
  totalRounds: number;
}

const roundDown = (n: number, step: number) => Math.floor(n / step) * step;
const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

/**
 * Generate one truthful private tip. Tips only cover companies still to be auctioned,
 * and avoid repeating what the player already knows.
 */
export function generateIntel(
  ctx: IntelContext,
  known: IntelTip[],
  source: 'start' | 'catchup',
  id: string,
): IntelTip | null {
  const { rng } = ctx;
  const range = ctx.turnoverMax - ctx.turnoverMin;
  const step = range >= 100 ? 5 : 1;
  const knownCompanies = new Set(known.flatMap((k) => k.companyIds));
  const knownSectors = new Set(known.filter((k) => k.sectorId).map((k) => k.sectorId));
  const knownEvents = new Set(known.filter((k) => k.eventId).map((k) => k.eventId));

  const upcoming = ctx.pool.filter((c) => c.status === 'upcoming');
  const fresh = upcoming.filter((c) => !knownCompanies.has(c.id));
  const sortedPool = [...ctx.pool].sort((a, b) => b.turnover - a.turnover);
  const quarter = Math.max(1, Math.ceil(ctx.pool.length / 4));
  const nextEvent = ctx.round < ctx.totalRounds ? ctx.events[ctx.round] : undefined;
  const heatSectors = [...new Set(upcoming.map((c) => COMPANY_BY_ID[c.id].sector))].filter(
    (s) => !knownSectors.has(s),
  );

  const options: { kind: IntelKind; weight: number }[] = [];
  if (fresh.length > 0) {
    options.push({ kind: 'band', weight: 3 }, { kind: 'above', weight: 2 }, { kind: 'rank', weight: 1.5 });
  }
  if (fresh.length > 1) options.push({ kind: 'compare', weight: 2 });
  if (heatSectors.length > 0) options.push({ kind: 'sectorHeat', weight: 1.5 });
  if (nextEvent && !knownEvents.has(nextEvent.id)) {
    options.push({ kind: 'nextEvent', weight: source === 'catchup' ? 4 : 0.5 });
  }
  if (options.length === 0) return null;

  const kind = rng.weighted(options, (o) => o.weight).kind;
  const name = (cid: string) => COMPANY_BY_ID[cid].name;
  const base = { id, round: ctx.round, source };

  switch (kind) {
    case 'band': {
      const c = rng.pick(fresh);
      const width = Math.max(step * 2, roundUp(range * 0.25, step));
      let low = roundDown(c.turnover - rng.next() * (width - step), step);
      low = Math.max(ctx.turnoverMin, Math.min(low, ctx.turnoverMax - width));
      const high = low + width;
      return {
        ...base,
        kind,
        companyIds: [c.id],
        data: { low, high },
        text: `${name(c.id)} turns over between ${money(low)} and ${money(high)} per round.`,
      };
    }
    case 'above':
    case 'below': {
      const c = rng.pick(fresh);
      const mid = ctx.turnoverMin + range / 2;
      const margin = range * (0.05 + rng.next() * 0.15);
      if (c.turnover >= mid) {
        const threshold = Math.max(ctx.turnoverMin, roundDown(c.turnover - margin, step));
        return {
          ...base,
          kind: 'above',
          companyIds: [c.id],
          data: { low: threshold },
          text: `${name(c.id)} turns over more than ${money(threshold)} per round.`,
        };
      }
      const threshold = Math.min(ctx.turnoverMax, roundUp(c.turnover + margin, step));
      return {
        ...base,
        kind: 'below',
        companyIds: [c.id],
        data: { high: threshold },
        text: `${name(c.id)} turns over less than ${money(threshold)} per round.`,
      };
    }
    case 'compare': {
      let [a, b] = rng.shuffle(fresh).slice(0, 2);
      for (let tries = 0; tries < 6 && a.turnover === b.turnover; tries++) [a, b] = rng.shuffle(fresh).slice(0, 2);
      if (a.turnover === b.turnover) {
        return {
          ...base,
          kind,
          companyIds: [a.id, b.id],
          data: {},
          text: `${name(a.id)} and ${name(b.id)} have exactly the same turnover.`,
        };
      }
      const [hi, lo] = a.turnover > b.turnover ? [a, b] : [b, a];
      return {
        ...base,
        kind,
        companyIds: [hi.id, lo.id],
        data: { higherId: hi.id },
        text: `${name(hi.id)} turns over more than ${name(lo.id)}.`,
      };
    }
    case 'rank': {
      const c = rng.pick(fresh);
      const idx = sortedPool.findIndex((p) => p.id === c.id);
      if (idx < quarter) {
        return {
          ...base,
          kind,
          companyIds: [c.id],
          data: { rank: 'top' },
          text: `${name(c.id)} is one of the top ${quarter} earners in this game.`,
        };
      }
      if (idx >= ctx.pool.length - quarter) {
        return {
          ...base,
          kind,
          companyIds: [c.id],
          data: { rank: 'bottom' },
          text: `${name(c.id)} is one of the ${quarter} weakest earners in this game.`,
        };
      }
      return {
        ...base,
        kind,
        companyIds: [c.id],
        data: { rank: 'middle' },
        text: `${name(c.id)} is a middle-of-the-pack earner: neither top ${quarter} nor bottom ${quarter}.`,
      };
    }
    case 'sectorHeat': {
      const sector = rng.pick(heatSectors);
      const heat = ctx.heat[sector];
      const label = SECTORS[sector].name;
      const text =
        heat > 0.1
          ? `🔥🔥 ${label} is running very hot this game: expect well above-normal turnovers.`
          : heat > 0
            ? `🔥 ${label} is running warm this game: turnovers lean higher than usual.`
            : heat < -0.1
              ? `🧊🧊 ${label} is ice cold this game: expect well below-normal turnovers.`
              : heat < 0
                ? `🧊 ${label} is running cool this game: turnovers lean lower than usual.`
                : `${label} is running at a normal temperature this game.`;
      return { ...base, kind, companyIds: [], sectorId: sector, data: { heat }, text };
    }
    case 'nextEvent': {
      const ev = nextEvent!;
      return {
        ...base,
        kind,
        companyIds: [],
        eventId: ev.id,
        text: `Insider tip: round ${ctx.round + 1}'s market headline will be "${ev.icon} ${ev.headline}".`,
      };
    }
  }
}
