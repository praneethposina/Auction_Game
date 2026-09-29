import { COMPANY_BY_ID, type Tier } from '../../shared/data/companies.ts';
import { SECTORS } from '../../shared/data/sectors.ts';
import { money, netPerRound, pct } from '../../shared/economy.ts';
import type { Persona } from '../../shared/types.ts';
import type { EnginePlayer, Game } from '../game/engine.ts';
import type { Rng } from '../game/rng.ts';
import { activeRivals, appraise, averageUpcomingTerminal, type Appraisal } from './appraise.ts';

export interface AiDecision {
  maxBid: number;
  reason: string;
  source: 'llm' | 'bot' | 'fallback';
}

interface Style {
  /** Multiplier on the fair price. */
  valueMult: number;
  /** Random ± fraction applied to the final price. */
  noise: number;
  /** Budget pacing: how many "fair shares" of the remaining budget one company may take. */
  pace: number;
  /** Weight on value that comes from synergies (1 = fair). */
  synergyWeight: number;
  /** Weight on keeping combo pieces away from rivals. */
  denialWeight: number;
  /** Weight on synergies this company could unlock later. */
  potentialWeight: number;
  /** Discount per unit of probability that the company loses money each round. */
  riskAversion: number;
  /** Sealed bids: 'optimal' shades by bidder count, a number is a fixed fraction. */
  sealed: 'optimal' | 'random' | number;
  tier?: Partial<Record<Tier, number>>;
}

const STYLES: Record<Persona, Style> = {
  balanced: { valueMult: 0.95, noise: 0.06, pace: 1.7, synergyWeight: 1, denialWeight: 0.2, potentialWeight: 0.25, riskAversion: 0.2, sealed: 'optimal' },
  quant: { valueMult: 1, noise: 0, pace: 1.8, synergyWeight: 1, denialWeight: 0.35, potentialWeight: 0.35, riskAversion: 0, sealed: 'optimal' },
  tycoon: {
    valueMult: 1.08,
    noise: 0.07,
    pace: 2.4,
    synergyWeight: 1,
    denialWeight: 0, potentialWeight: 0.1,
    riskAversion: 0,
    sealed: 0.9,
    tier: { mega: 1.12, large: 1.03, mid: 0.92 },
  },
  value: { valueMult: 0.9, noise: 0.03, pace: 1.5, synergyWeight: 0.9, denialWeight: 0, potentialWeight: 0.1, riskAversion: 0.5, sealed: 0.82 },
  synergy: { valueMult: 0.9, noise: 0.06, pace: 2.0, synergyWeight: 1.8, denialWeight: 0.2, potentialWeight: 0.9, riskAversion: 0.1, sealed: 'optimal' },
  specialist: { valueMult: 0.92, noise: 0.05, pace: 1.9, synergyWeight: 1.5, denialWeight: 0.1, potentialWeight: 0.6, riskAversion: 0.1, sealed: 'optimal' },
  bluechip: {
    valueMult: 0.97,
    noise: 0.05,
    pace: 2.0,
    synergyWeight: 1,
    denialWeight: 0, potentialWeight: 0.15,
    riskAversion: 0.1,
    sealed: 'optimal',
    tier: { mega: 1.2, large: 1.05, mid: 0.55 },
  },
  bargain: {
    valueMult: 0.92,
    noise: 0.05,
    pace: 1.6,
    synergyWeight: 1,
    denialWeight: 0, potentialWeight: 0.15,
    riskAversion: 0.2,
    sealed: 'optimal',
    tier: { mega: 0.8, large: 0.95, mid: 1.18 },
  },
  sniper: { valueMult: 1, noise: 0.05, pace: 1.8, synergyWeight: 1, denialWeight: 0.1, potentialWeight: 0.2, riskAversion: 0.1, sealed: 'optimal' },
  hoarder: { valueMult: 0.95, noise: 0.04, pace: 1.4, synergyWeight: 1, denialWeight: 0, potentialWeight: 0.1, riskAversion: 0.3, sealed: 0.85 },
  momentum: { valueMult: 0.95, noise: 0.06, pace: 2.0, synergyWeight: 1, denialWeight: 0, potentialWeight: 0.1, riskAversion: 0, sealed: 'optimal' },
  contrarian: { valueMult: 0.92, noise: 0.06, pace: 1.7, synergyWeight: 1, denialWeight: 0, potentialWeight: 0.1, riskAversion: 0.1, sealed: 'optimal' },
  blocker: { valueMult: 0.9, noise: 0.05, pace: 1.9, synergyWeight: 1, denialWeight: 1.2, potentialWeight: 0.2, riskAversion: 0.1, sealed: 'optimal' },
  gambler: { valueMult: 1, noise: 0.45, pace: 2.2, synergyWeight: 1, denialWeight: 0, potentialWeight: 0.2, riskAversion: 0, sealed: 'random' },
};

/** Cash the player can expect to spend over the rest of the game: purse plus income still to come. */
function spendable(game: Game, player: EnginePlayer): number {
  const s = game.settings;
  const syn = game.synergiesFor(player);
  const perRound = player.holdings.reduce((acc, h) => {
    const c = game.company(h.companyId)!;
    return acc + netPerRound(c.turnover, c.runningCost, syn[h.companyId].total, s.runningCosts);
  }, 0);
  // Payouts at the end of this round and every later round except the last can still be spent.
  const futureIncome = Math.max(0, perRound) * Math.max(0, game.totalRounds - game.round);
  return player.purse + 0.8 * futureIncome;
}

/** Companies this player can expect to win from here on, counting only rivals who can still bid. */
function expectedBuys(game: Game, player: EnginePlayer): number {
  const left = game.upcomingCount() + 1;
  return Math.max(1, left / (activeRivals(game, player) + 1));
}

/** How much of the purse one company may take right now. */
export function budgetCap(game: Game, player: EnginePlayer, persona: Persona): number {
  const style = STYLES[persona] ?? STYLES.balanced;
  if (game.upcomingCount() === 0) return Math.max(0, player.purse);
  let pace = style.pace;
  if (persona === 'sniper') pace *= 0.75 + 0.6 * roundProgress(game);
  let cap = Math.min(player.purse, (spendable(game, player) / expectedBuys(game, player)) * pace);
  // Hoard only when leftover cash actually counts toward winning.
  if (persona === 'hoarder' && game.round < game.totalRounds && game.settings.winCondition !== 'portfolio') {
    cap = Math.min(cap, player.purse - game.settings.startingBudget * 0.25);
  }
  return Math.max(0, Math.floor(cap));
}

/** 0 in the first round, 1 in the last. */
function roundProgress(game: Game): number {
  return game.totalRounds <= 1 ? 1 : (game.round - 1) / (game.totalRounds - 1);
}

/**
 * Spending cash now means it can't buy a bargain later. The discount is the surplus a dollar
 * can still expect to earn in future auctions, so it shrinks to zero on the final lot.
 */
function cashOpportunityDiscount(game: Game): number {
  const total = game.companies.length;
  const remaining = game.upcomingCount();
  return 1 - 0.1 * (remaining / Math.max(1, total));
}

/** What the company is worth to this player under the host's win condition. */
function fairPrice(game: Game, player: EnginePlayer, a: Appraisal): number {
  switch (game.settings.winCondition) {
    case 'purse':
      return a.cashValue;
    case 'roi':
      // Only bargains raise a return-on-spend score.
      return a.value / 1.2;
    case 'portfolio': {
      // Leftover cash is worthless, so split the whole budget by each company's share of value.
      const share = a.terminalValue / (averageUpcomingTerminal(game) * expectedBuys(game, player));
      return spendable(game, player) * Math.min(1, share);
    }
    default:
      return a.value;
  }
}

function personaFactor(game: Game, player: EnginePlayer, companyId: string, persona: Persona, a: Appraisal): { factor: number; note?: string } {
  const company = COMPANY_BY_ID[companyId];
  switch (persona) {
    case 'sniper': {
      const f = 0.85 + 0.35 * roundProgress(game);
      return { factor: f, note: f < 1 ? 'saving cash for later rounds' : 'late-game pounce' };
    }
    case 'momentum': {
      const f = Math.min(1.5, Math.max(0.6, 1 + 1.5 * (a.eventDemand - 1) - 0.8 * (a.eventCost - 1)));
      return { factor: f, note: f > 1.02 ? 'riding the news' : f < 0.98 ? 'news is against it' : undefined };
    }
    case 'contrarian': {
      const f = 1 + 1.2 * Math.max(0, 1 - a.eventDemand) - 0.8 * Math.max(0, a.eventDemand - 1);
      return { factor: f, note: f > 1.02 ? 'unloved today, fine later' : f < 0.98 ? 'too hyped for me' : undefined };
    }
    case 'specialist': {
      const counts = new Map<string, number>();
      for (const h of player.holdings) {
        const sector = game.company(h.companyId)!.def.sector;
        counts.set(sector, (counts.get(sector) ?? 0) + 1);
      }
      if (counts.size > 0) {
        const favourites = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([s]) => s);
        return favourites.includes(company.sector)
          ? { factor: 1.18, note: `my ${SECTORS[company.sector].short} focus` }
          : { factor: 0.8, note: 'outside my sectors' };
      }
      // Before owning anything, prefer sectors with the most companies still to come.
      const peers = game.companies.filter((c) => c.status === 'upcoming' && c.def.sector === company.sector).length;
      return { factor: Math.min(1.3, 1 + 0.08 * peers), note: peers > 0 ? `${peers} more ${SECTORS[company.sector].short} to come` : undefined };
    }
    default:
      return { factor: 1 };
  }
}

function sealedShade(style: Style, rivals: number, rng: Rng): number {
  if (style.sealed === 'random') return 0.6 + rng.next() * 0.4;
  if (typeof style.sealed === 'number') return style.sealed;
  // Symmetric first-price equilibrium with n bidders: bid (n-1)/n of your value.
  const n = rivals + 1;
  return Math.min(0.93, Math.max(0.6, (n - 1) / n));
}

export function botDecision(
  game: Game,
  player: EnginePlayer,
  companyId: string,
  persona: Persona,
  rng: Rng,
  source: AiDecision['source'] = 'bot',
): AiDecision {
  const style = STYLES[persona] ?? STYLES.balanced;
  const a = appraise(game, player, companyId);
  const tier = COMPANY_BY_ID[companyId].tier;

  let target = fairPrice(game, player, a) * (persona === 'gambler' ? 1 : cashOpportunityDiscount(game));
  target += (style.synergyWeight - 1) * (a.value - a.valueNoSynergy);
  target += style.denialWeight * a.denialValue;
  target += style.potentialWeight * a.potentialValue;
  target *= 1 - style.riskAversion * a.lossChance;
  target *= style.valueMult * (style.tier?.[tier] ?? 1);
  const pf = personaFactor(game, player, companyId, persona, a);
  target *= pf.factor;
  if (style.noise > 0) target *= 1 + style.noise * (rng.next() * 2 - 1);

  let shadeNote: string | null = null;
  if (game.settings.auctionMode === 'sealed') {
    const rivals = activeRivals(game, player);
    const shade = sealedShade(style, rivals, rng);
    target *= shade;
    shadeNote = `sealed: bidding ${Math.round(shade * 100)}% vs ~${rivals} rival${rivals === 1 ? '' : 's'}`;
  }

  const cap = budgetCap(game, player, persona);
  let maxBid = Math.floor(Math.max(0, Math.min(target, cap, player.purse)));
  if (maxBid < game.minOpeningBid()) maxBid = 0;

  const bits = [`est. ~${money(a.estTurnover)}/rd`];
  if (a.heatNote) bits.push(a.heatNote);
  if (a.intelNotes.length) bits.push(a.intelNotes.join(', '));
  if (a.synergy > 0) bits.push(`synergy ${pct(a.synergy)}${a.newCombos.length ? ` (${a.newCombos.join(', ')})` : ''}`);
  if (a.eventDemand !== 1 || a.eventCost !== 1) bits.push(`news ×${a.eventDemand.toFixed(2)}`);
  if (a.foresightNote) bits.push(a.foresightNote);
  if (style.denialWeight > 0.3 && a.denialNote) bits.push(a.denialNote);
  if (style.potentialWeight >= 0.3 && a.potentialNote) bits.push(a.potentialNote);
  if (pf.note) bits.push(pf.note);
  if (a.lossChance > 0.25) bits.push(`${Math.round(a.lossChance * 100)}% chance it loses money`);
  bits.push(`${a.payoutsLeft} payout${a.payoutsLeft === 1 ? '' : 's'} left → worth ~${money(a.value)}`);
  if (shadeNote) bits.push(shadeNote);
  const verdict =
    maxBid === 0
      ? 'Passing.'
      : maxBid < target * 0.95
        ? `Budget caps me at ${money(maxBid)}.`
        : maxBid > a.value * 1.02
          ? `Paying a premium: up to ${money(maxBid)}.`
          : `Up to ${money(maxBid)}.`;
  return { maxBid, reason: `${bits.join('; ')}. ${verdict}`, source };
}
