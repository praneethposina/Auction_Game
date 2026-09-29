import { COMBO_BY_ID, COMBOS } from '../../shared/data/combos.ts';
import { COMPANY_BY_ID, type Tier } from '../../shared/data/companies.ts';
import { EVENT_BY_ID } from '../../shared/data/events.ts';
import { SECTORS, type SectorId } from '../../shared/data/sectors.ts';
import {
  BINOMIAL_N,
  clampP,
  comboLevel,
  eventEffectFor,
  expectedTurnover,
  HEAT_SHIFTS,
  previewSynergy,
  sectorBonusFor,
  TIER_P,
  turnoverFromDraw,
  VALUATION_MULTIPLE,
} from '../../shared/economy.ts';
import type { EnginePlayer, Game } from '../game/engine.ts';

// The "analyst" behind built-in bots, the LLM fallback, and the numbers in the LLM prompt.
// It only uses information the player really has: public game state, their own companies'
// turnovers, and their own private intel. Never other players' cash or hidden turnovers.

export interface Appraisal {
  estTurnover: number;
  estLow: number;
  estHigh: number;
  intelNotes: string[];
  /** Posterior mean of the hidden sector heat shift, inferred from own holdings and intel. */
  heatEstimate: number;
  heatNote: string | null;
  synergy: number;
  newCombos: string[];
  sectorCountAfter: number;
  uplift: Record<string, number>;
  eventDemand: number;
  eventCost: number;
  runningCost: number;
  payoutsLeft: number;
  /** Expected total value in the net-worth sense: payouts + end-of-game valuation. */
  value: number;
  /** Same, ignoring all synergy effects. */
  valueNoSynergy: number;
  /** Payouts only (what matters for "cash in purse"). */
  cashValue: number;
  /** End-of-game valuation only (what matters for "portfolio value"). */
  terminalValue: number;
  /** Probability the company loses money in an average round. */
  lossChance: number;
  /** Value of keeping this company away from rivals who would complete a combo with it. */
  denialValue: number;
  denialNote: string | null;
  foresightNote: string | null;
  /** Expected value of synergies this company could unlock with companies still to come. */
  potentialValue: number;
  potentialNote: string | null;
}

type Dist = Map<number, number>; // turnover → probability weight

function binomPmf(p: number): number[] {
  const out: number[] = [];
  let coeff = 1;
  for (let k = 0; k <= BINOMIAL_N; k++) {
    if (k > 0) coeff = (coeff * (BINOMIAL_N - k + 1)) / k;
    out.push(coeff * p ** k * (1 - p) ** (BINOMIAL_N - k));
  }
  return out;
}

function turnoverDist(p: number, min: number, max: number): Dist {
  const d: Dist = new Map();
  binomPmf(p).forEach((w, k) => {
    const t = turnoverFromDraw(k, min, max);
    d.set(t, (d.get(t) ?? 0) + w);
  });
  return d;
}

function normalize(d: Dist): Dist {
  const total = [...d.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return d;
  return new Map([...d].map(([t, w]) => [t, w / total]));
}

function expect(d: Dist, f: (t: number) => number): number {
  let s = 0;
  for (const [t, w] of d) s += w * f(t);
  return s;
}

function quantile(d: Dist, q: number): number {
  const sorted = [...d].sort((a, b) => a[0] - b[0]);
  let cum = 0;
  for (const [t, w] of sorted) {
    cum += w;
    if (cum >= q) return t;
  }
  return sorted[sorted.length - 1][0];
}

/** Keep only outcomes consistent with a tip; ignore the tip if nothing would be left. */
function restrict(d: Dist, keep: (t: number) => boolean): Dist {
  const next: Dist = new Map([...d].filter(([t, w]) => keep(t) && w > 0));
  return next.size > 0 ? normalize(next) : d;
}

const HEAT_PRIOR = (() => {
  const m = new Map<number, number>();
  for (const h of HEAT_SHIFTS) m.set(h, (m.get(h) ?? 0) + 1 / HEAT_SHIFTS.length);
  return m;
})();

/**
 * Posterior over the hidden heat shift of a sector. The player sees the true turnover of every
 * company they own, and each one is evidence about its sector's heat: a Large chip designer
 * turning over near the top of the range makes "Chips are hot" more likely.
 */
export function heatPosterior(game: Game, player: EnginePlayer, sector: SectorId): Map<number, number> {
  const tip = player.intel.find((t) => t.kind === 'sectorHeat' && t.sectorId === sector);
  if (tip?.data?.heat !== undefined) return new Map([[tip.data.heat, 1]]);
  const { turnoverMin: min, turnoverMax: max } = game.settings;
  const post = new Map(HEAT_PRIOR);
  for (const h of player.holdings) {
    const c = game.company(h.companyId)!;
    if (c.def.sector !== sector) continue;
    for (const [shift, w] of post) {
      const likelihood = turnoverDist(clampP(TIER_P[c.def.tier] + shift), min, max).get(c.turnover) ?? 0;
      post.set(shift, w * likelihood);
    }
  }
  const total = [...post.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return new Map(HEAT_PRIOR);
  return new Map([...post].map(([s, w]) => [s, w / total]));
}

function companyDist(game: Game, heat: Map<number, number>, tier: Tier): Dist {
  const { turnoverMin: min, turnoverMax: max } = game.settings;
  const mix: Dist = new Map();
  for (const [shift, w] of heat) {
    for (const [t, pw] of turnoverDist(clampP(TIER_P[tier] + shift), min, max)) {
      mix.set(t, (mix.get(t) ?? 0) + w * pw);
    }
  }
  return normalize(mix);
}

/**
 * A rival's cash, estimated only from public information: the starting budget, prices they
 * paid (announced at each sale) and the average payout of the tiers they own.
 */
export function estimateRivalCash(game: Game, rival: EnginePlayer): number {
  const s = game.settings;
  const roundsDone = game.phase === 'summary' || game.phase === 'finished' ? game.round : game.round - 1;
  let cash = s.startingBudget;
  for (const h of rival.holdings) {
    const c = game.company(h.companyId)!;
    cash -= h.price;
    const net = expectedTurnover(TIER_P[c.def.tier], s.turnoverMin, s.turnoverMax) - (s.runningCosts ? c.runningCost : 0);
    cash += net * Math.max(0, roundsDone - h.roundBought + 1);
  }
  return cash;
}

/** Number of rivals who can plausibly afford to bid at all. */
export function activeRivals(game: Game, player: EnginePlayer): number {
  return game.players.filter((p) => p.id !== player.id && estimateRivalCash(game, p) >= game.minOpeningBid()).length;
}

function tierMean(game: Game, tier: Tier): number {
  return expectedTurnover(TIER_P[tier], game.settings.turnoverMin, game.settings.turnoverMax);
}

/** What a rival would gain (in net-worth terms) by adding this company, using public info only. */
function rivalGain(game: Game, rival: EnginePlayer, companyId: string, estTurnover: number, k: number): number {
  const owned = rival.holdings.map((h) => h.companyId);
  if (owned.length === 0) return 0;
  const preview = previewSynergy(owned, companyId);
  const horizon = k + VALUATION_MULTIPLE;
  let gain = estTurnover * preview.candidate.total * horizon;
  for (const [id, inc] of Object.entries(preview.uplift)) {
    gain += tierMean(game, COMPANY_BY_ID[id].tier) * inc * horizon;
  }
  return gain;
}

export function appraise(game: Game, player: EnginePlayer, companyId: string): Appraisal {
  const s = game.settings;
  const company = game.company(companyId)!;
  const { tier, sector } = company.def;
  const min = s.turnoverMin;
  const max = s.turnoverMax;
  const range = max - min;
  const notes: string[] = [];

  // 1. Hidden sector heat: prior + evidence from own holdings (or an exact heat tip).
  const heat = heatPosterior(game, player, sector);
  const heatEstimate = [...heat].reduce((acc, [h, w]) => acc + h * w, 0);
  const tipKnown = player.intel.some((t) => t.kind === 'sectorHeat' && t.sectorId === sector);
  const evidence = player.holdings.filter((h) => game.company(h.companyId)!.def.sector === sector).length;
  let heatNote: string | null = null;
  if (Math.abs(heatEstimate) >= 0.035 && (tipKnown || evidence > 0)) {
    heatNote = `${SECTORS[sector].short} looks ${heatEstimate > 0 ? 'hot' : 'cold'}${tipKnown ? ' (intel)' : ` (from my ${evidence} ${SECTORS[sector].short} co.)`}`;
  }

  // 2. Turnover distribution, narrowed by any company-specific intel.
  let d = companyDist(game, heat, tier);
  for (const tip of player.intel) {
    if (!tip.companyIds.includes(companyId) || !tip.data) continue;
    const data = tip.data;
    switch (tip.kind) {
      case 'band':
        d = restrict(d, (t) => t >= data.low! && t <= data.high!);
        notes.push(`intel $${data.low}-${data.high}`);
        break;
      case 'above':
        d = restrict(d, (t) => t >= data.low!);
        notes.push(`intel >$${data.low}`);
        break;
      case 'below':
        d = restrict(d, (t) => t <= data.high!);
        notes.push(`intel <$${data.high}`);
        break;
      case 'rank':
        if (data.rank === 'top') d = restrict(d, (t) => t >= min + range * 0.55);
        else if (data.rank === 'bottom') d = restrict(d, (t) => t <= min + range * 0.35);
        else d = restrict(d, (t) => t > min + range * 0.3 && t < min + range * 0.65);
        notes.push(`intel: ${data.rank} earner`);
        break;
      case 'compare': {
        const otherId = tip.companyIds.find((id) => id !== companyId)!;
        const iAmHigher = data.higherId === companyId;
        const known = player.holdings.find((h) => h.companyId === otherId);
        const otherTurnover = known ? game.company(otherId)!.turnover : tierMean(game, COMPANY_BY_ID[otherId].tier);
        d = restrict(d, (t) => (iAmHigher ? t >= otherTurnover : t <= otherTurnover));
        notes.push(`intel: ${iAmHigher ? 'beats' : 'trails'} ${game.company(otherId)!.def.name}`);
        break;
      }
      default:
        break;
    }
  }

  // 3. Value over the whole distribution (end value is floored at zero, so averages mislead).
  const owned = player.holdings.map((h) => h.companyId);
  const preview = previewSynergy(owned, companyId);
  const syn = preview.candidate.total;
  const eff = eventEffectFor(game.currentEvent(), companyId);
  const cost = s.runningCosts ? company.runningCost : 0;
  const k = game.payoutsRemaining();

  // Next round's headline, if a tip revealed it, replaces one average future round.
  // A tip received in round r names round r+1's headline, so it's only news during round r.
  const nextTip = player.intel.find((t) => t.kind === 'nextEvent' && t.eventId && t.round === game.round);
  const nextEvent = nextTip && k >= 2 ? EVENT_BY_ID[nextTip.eventId!] : undefined;
  const nextEff = nextEvent ? eventEffectFor(nextEvent, companyId) : null;
  const foresightNote =
    nextEff && (nextEff.demand !== 1 || nextEff.cost !== 1)
      ? `next round's news ×${nextEff.demand.toFixed(2)}`
      : null;

  const valueWith = (synergy: number, withUplift: boolean) => {
    const cash = expect(d, (t) => {
      const gross = t * (1 + synergy);
      const thisRound = gross * eff.demand - cost * eff.cost;
      const nextRound = nextEff ? gross * nextEff.demand - cost * nextEff.cost : gross - cost;
      const later = k >= 2 ? nextRound + (gross - cost) * (k - 2) : 0;
      return thisRound + later;
    });
    const terminal = expect(d, (t) => Math.max(0, t * (1 + synergy) - cost)) * VALUATION_MULTIPLE;
    let upliftCash = 0;
    let upliftTerminal = 0;
    if (withUplift) {
      for (const [id, inc] of Object.entries(preview.uplift)) {
        const t = game.company(id)!.turnover;
        upliftCash += t * inc * k;
        upliftTerminal += t * inc * VALUATION_MULTIPLE;
      }
    }
    return { cash: cash + upliftCash, terminal: terminal + upliftTerminal };
  };

  const full = valueWith(syn, true);
  const bare = valueWith(0, false);
  const est = expect(d, (t) => t);
  const lossChance = expect(d, (t) => (t * (1 + syn) - cost < 0 ? 1 : 0));

  // 4. Denial: what the strongest rival would gain from this company via combos/sector bonuses.
  let denialValue = 0;
  let denialNote: string | null = null;
  const rivals = game.players.filter((p) => p.id !== player.id);
  for (const r of rivals) {
    const g = rivalGain(game, r, companyId, est, k);
    if (g > denialValue) {
      denialValue = g;
      const comboHit = COMBOS.find((c) => {
        if (!c.members.includes(companyId)) return false;
        const set = new Set([...r.holdings.map((h) => h.companyId), companyId]);
        return comboLevel(c, set).bonus > comboLevel(c, new Set(r.holdings.map((h) => h.companyId))).bonus;
      });
      const sectorCount = r.holdings.filter((h) => game.company(h.companyId)!.def.sector === sector).length + 1;
      denialNote = comboHit
        ? `would complete ${r.name}'s ${comboHit.name}`
        : sectorBonusFor(sectorCount) > 0
          ? `would boost ${r.name}'s ${SECTORS[sector].short} set`
          : null;
    }
  }
  if (!denialNote) denialValue = 0;
  // Only relative position matters, and the gain is shared among the other rivals.
  denialValue /= Math.max(1, rivals.length);

  // 5. Option value: synergies this company could unlock with companies still to come.
  // Chance of winning any given future lot ≈ 1 / players.
  const winChance = 1 / Math.max(1, game.players.length);
  const upcomingFree = game.companies.filter((c) => c.status === 'upcoming' && c.def.id !== companyId);
  const futureHorizon = Math.max(1, k - 1) + VALUATION_MULTIPLE;
  const avgMean = (ids: string[]) =>
    ids.length ? ids.reduce((acc, id) => acc + tierMean(game, COMPANY_BY_ID[id].tier), 0) / ids.length : est;
  let potentialValue = 0;
  let potentialNote: string | null = null;
  const ownedSet = new Set(owned);
  const sameSectorLeft = upcomingFree.filter((c) => c.def.sector === sector).map((c) => c.def.id);
  const ownedInSector = owned.filter((id) => game.company(id)!.def.sector === sector).length;
  if (ownedInSector === 0 && sameSectorLeft.length > 0) {
    const chance = Math.min(1, sameSectorLeft.length * winChance);
    potentialValue += chance * sectorBonusFor(2) * (est + avgMean(sameSectorLeft)) * futureHorizon;
  }
  let bestCombo: { name: string; v: number } | null = null;
  for (const combo of COMBOS) {
    if (!combo.members.includes(companyId) || !game.activeComboIds.includes(combo.id)) continue;
    const have = combo.members.filter((m) => ownedSet.has(m)).length + 1;
    const tierNeed = combo.tiers.find((t) => t.need > have);
    if (!tierNeed) continue;
    const missing = tierNeed.need - have;
    const open = combo.members.filter((m) => upcomingFree.some((c) => c.def.id === m));
    if (open.length < missing) continue;
    if (combo.anchor && combo.anchor !== companyId && !ownedSet.has(combo.anchor) && !open.includes(combo.anchor)) continue;
    const chance = Math.min(1, open.length * winChance) ** missing;
    const v = chance * tierNeed.bonus * (est + missing * avgMean(open)) * futureHorizon;
    potentialValue += v;
    if (!bestCombo || v > bestCombo.v) bestCombo = { name: combo.name, v };
  }
  if (bestCombo && bestCombo.v > 5) potentialNote = `could start ${bestCombo.name}`;
  else if (potentialValue > 5 && sameSectorLeft.length > 0) potentialNote = `${sameSectorLeft.length} more ${SECTORS[sector].short} to come`;

  return {
    estTurnover: Math.round(est),
    estLow: quantile(d, 0.1),
    estHigh: quantile(d, 0.9),
    intelNotes: notes,
    heatEstimate,
    heatNote,
    synergy: syn,
    newCombos: preview.newCombos.map((id) => COMBO_BY_ID[id].name),
    sectorCountAfter: preview.sectorCountAfter,
    uplift: preview.uplift,
    eventDemand: eff.demand,
    eventCost: eff.cost,
    runningCost: company.runningCost,
    payoutsLeft: k,
    value: Math.round(full.cash + full.terminal),
    valueNoSynergy: Math.round(bare.cash + bare.terminal),
    cashValue: Math.round(full.cash),
    terminalValue: Math.round(full.terminal),
    lossChance,
    denialValue: Math.round(denialValue),
    denialNote,
    foresightNote,
    potentialValue: Math.round(potentialValue),
    potentialNote,
  };
}

/** Expected end-of-game value of an average company still to come (for portfolio pacing). */
export function averageUpcomingTerminal(game: Game): number {
  const s = game.settings;
  const upcoming = game.companies.filter((c) => c.status === 'upcoming' || c.status === 'auction');
  if (upcoming.length === 0) return 1;
  const total = upcoming.reduce((acc, c) => {
    const net = tierMean(game, c.def.tier) - (s.runningCosts ? c.runningCost : 0);
    return acc + Math.max(0, net) * VALUATION_MULTIPLE;
  }, 0);
  return Math.max(1, total / upcoming.length);
}
