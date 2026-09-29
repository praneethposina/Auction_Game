import { COMBO_BY_ID } from '../../shared/data/combos.ts';
import {
  BINOMIAL_N,
  clampP,
  eventEffectFor,
  previewSynergy,
  TIER_P,
  turnoverFromDraw,
  VALUATION_MULTIPLE,
} from '../../shared/economy.ts';
import type { EnginePlayer, Game } from '../game/engine.ts';

// A shared "analyst" used by built-in bots, as a fallback for LLM players,
// and as a helper line in the LLM prompt. It only uses information the player has.

export interface Appraisal {
  estTurnover: number;
  estLow: number;
  estHigh: number;
  intelNotes: string[];
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
}

type Dist = { t: number; w: number }[];

function distribution(p: number, min: number, max: number): Dist {
  const out: Dist = [];
  let coeff = 1;
  for (let k = 0; k <= BINOMIAL_N; k++) {
    if (k > 0) coeff = (coeff * (BINOMIAL_N - k + 1)) / k;
    out.push({ t: turnoverFromDraw(k, min, max), w: coeff * p ** k * (1 - p) ** (BINOMIAL_N - k) });
  }
  return out;
}

function mean(d: Dist): number {
  const total = d.reduce((s, x) => s + x.w, 0);
  return d.reduce((s, x) => s + x.t * x.w, 0) / total;
}

function quantile(d: Dist, q: number): number {
  const total = d.reduce((s, x) => s + x.w, 0);
  let cum = 0;
  for (const x of d) {
    cum += x.w;
    if (cum / total >= q) return x.t;
  }
  return d[d.length - 1].t;
}

/** Keep only outcomes consistent with a tip; ignore the tip if nothing would be left. */
function restrict(d: Dist, keep: (t: number) => boolean): Dist {
  const next = d.filter((x) => keep(x.t) && x.w > 0);
  return next.length > 0 ? next : d;
}

export function appraise(game: Game, player: EnginePlayer, companyId: string): Appraisal {
  const s = game.settings;
  const company = game.company(companyId)!;
  const { tier, sector } = company.def;
  const min = s.turnoverMin;
  const max = s.turnoverMax;
  const range = max - min;
  const notes: string[] = [];

  let p = TIER_P[tier];
  const heatTip = player.intel.find((t) => t.kind === 'sectorHeat' && t.sectorId === sector);
  if (heatTip?.data?.heat !== undefined) {
    p = clampP(p + heatTip.data.heat);
    if (heatTip.data.heat !== 0) notes.push(heatTip.data.heat > 0 ? 'sector is hot' : 'sector is cold');
  }
  let d = distribution(p, min, max);

  for (const tip of player.intel) {
    if (!tip.companyIds.includes(companyId) || !tip.data) continue;
    const data = tip.data;
    switch (tip.kind) {
      case 'band':
        d = restrict(d, (t) => t >= data.low! && t <= data.high!);
        notes.push(`intel: $${data.low}-${data.high}`);
        break;
      case 'above':
        d = restrict(d, (t) => t >= data.low!);
        notes.push(`intel: above $${data.low}`);
        break;
      case 'below':
        d = restrict(d, (t) => t <= data.high!);
        notes.push(`intel: below $${data.high}`);
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
        const otherTurnover = known ? game.company(otherId)!.turnover : undefined;
        if (otherTurnover !== undefined) {
          d = restrict(d, (t) => (iAmHigher ? t >= otherTurnover : t <= otherTurnover));
        } else {
          d = restrict(d, (t) => (iAmHigher ? t >= min + range * 0.25 : t <= min + range * 0.75));
        }
        notes.push(`intel: ${iAmHigher ? 'beats' : 'trails'} ${game.company(otherId)!.def.name}`);
        break;
      }
      default:
        break;
    }
  }

  const est = mean(d);
  const owned = player.holdings.map((h) => h.companyId);
  const preview = previewSynergy(owned, companyId);
  const syn = preview.candidate.total;
  const eff = eventEffectFor(game.currentEvent(), companyId);
  const cost = s.runningCosts ? company.runningCost : 0;
  const k = game.payoutsRemaining();

  const valueWith = (synergy: number, withUplift: boolean) => {
    const gross = est * (1 + synergy);
    const thisRound = gross * eff.demand - cost * eff.cost;
    const later = (gross - cost) * (k - 1);
    const terminal = Math.max(0, gross - cost) * VALUATION_MULTIPLE;
    let upliftCash = 0;
    let upliftTerminal = 0;
    if (withUplift) {
      for (const [id, inc] of Object.entries(preview.uplift)) {
        const t = game.company(id)!.turnover;
        upliftCash += t * inc * k;
        upliftTerminal += t * inc * VALUATION_MULTIPLE;
      }
    }
    return { cash: thisRound + later + upliftCash, terminal: terminal + upliftTerminal };
  };

  const full = valueWith(syn, true);
  const bare = valueWith(0, false);

  return {
    estTurnover: Math.round(est),
    estLow: quantile(d, 0.1),
    estHigh: quantile(d, 0.9),
    intelNotes: notes,
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
  };
}
