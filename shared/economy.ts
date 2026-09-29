import { COMPANY_BY_ID, type CompanyDef, type Tier } from './data/companies.ts';
import { COMBOS, MAX_SYNERGY_BONUS, type ComboDef } from './data/combos.ts';
import type { MarketEventDef } from './data/events.ts';
import { SECTOR_BONUS_TIERS, SECTORS } from './data/sectors.ts';

// ── Turnover model ──────────────────────────────────────────────
// turnover = min + (max - min) * X / N,  X ~ Binomial(N, p)
// p comes from the company's tier plus a hidden per-game sector "heat" shift.

export const BINOMIAL_N = 20;
export const TIER_P: Record<Tier, number> = { mega: 0.72, large: 0.52, mid: 0.32 };
/** Possible hidden sector heat shifts to p, drawn once per game per sector. */
export const HEAT_SHIFTS = [-0.14, -0.07, 0, 0, 0, 0.07, 0.14];
/** End-of-game company value = net turnover per round × this multiple. */
export const VALUATION_MULTIPLE = 2;

export const TIER_LABEL: Record<Tier, string> = { mega: 'Mega', large: 'Large', mid: 'Mid' };

export function clampP(p: number): number {
  return Math.min(0.95, Math.max(0.05, p));
}

export function turnoverFromDraw(x: number, min: number, max: number): number {
  return Math.round(min + ((max - min) * x) / BINOMIAL_N);
}

export function expectedTurnover(p: number, min: number, max: number): number {
  return min + (max - min) * p;
}

function binomPmf(n: number, p: number): number[] {
  const out: number[] = [];
  let coeff = 1;
  for (let k = 0; k <= n; k++) {
    if (k > 0) coeff = (coeff * (n - k + 1)) / k;
    out.push(coeff * p ** k * (1 - p) ** (n - k));
  }
  return out;
}

/** Likely turnover band (10th–90th percentile) for a tier, ignoring hidden heat. */
export function likelyRange(tier: Tier, min: number, max: number): { low: number; high: number; mean: number } {
  const pmf = binomPmf(BINOMIAL_N, TIER_P[tier]);
  let cum = 0;
  let low = 0;
  let high = BINOMIAL_N;
  let lowSet = false;
  for (let k = 0; k <= BINOMIAL_N; k++) {
    cum += pmf[k];
    if (!lowSet && cum >= 0.1) {
      low = k;
      lowSet = true;
    }
    if (cum >= 0.9) {
      high = k;
      break;
    }
  }
  return {
    low: turnoverFromDraw(low, min, max),
    high: turnoverFromDraw(high, min, max),
    mean: Math.round(expectedTurnover(TIER_P[tier], min, max)),
  };
}

/** Running cost per round: public information, based on the tier's expected turnover and sector margins. */
export function runningCostFor(company: CompanyDef, min: number, max: number): number {
  const expected = expectedTurnover(TIER_P[company.tier], min, max);
  return Math.round(expected * SECTORS[company.sector].costRatio);
}

// ── Synergies ───────────────────────────────────────────────────

export interface ComboHit {
  comboId: string;
  bonus: number;
  owned: number;
}

export interface SynergyBreakdown {
  sectorBonus: number;
  sectorCount: number;
  combos: ComboHit[];
  total: number;
}

export function comboLevel(combo: ComboDef, owned: Set<string>): { bonus: number; count: number } {
  const count = combo.members.filter((m) => owned.has(m)).length;
  if (combo.anchor && !owned.has(combo.anchor)) return { bonus: 0, count };
  let bonus = 0;
  for (const tier of combo.tiers) if (count >= tier.need) bonus = tier.bonus;
  return { bonus, count };
}

export function sectorBonusFor(count: number): number {
  let bonus = 0;
  for (const tier of SECTOR_BONUS_TIERS) if (count >= tier.need) bonus = tier.bonus;
  return bonus;
}

/** Synergy bonus for every owned company given the full set of owned company ids. */
export function computeSynergies(ownedIds: string[]): Record<string, SynergyBreakdown> {
  const owned = new Set(ownedIds);
  const sectorCounts = new Map<string, number>();
  for (const id of ownedIds) {
    const s = COMPANY_BY_ID[id].sector;
    sectorCounts.set(s, (sectorCounts.get(s) ?? 0) + 1);
  }
  const activeCombos: { combo: ComboDef; bonus: number; count: number }[] = [];
  for (const combo of COMBOS) {
    const { bonus, count } = comboLevel(combo, owned);
    if (bonus > 0) activeCombos.push({ combo, bonus, count });
  }
  const result: Record<string, SynergyBreakdown> = {};
  for (const id of ownedIds) {
    const sectorCount = sectorCounts.get(COMPANY_BY_ID[id].sector) ?? 0;
    const sectorBonus = sectorBonusFor(sectorCount);
    const combos = activeCombos
      .filter((a) => a.combo.members.includes(id))
      .map((a) => ({ comboId: a.combo.id, bonus: a.bonus, owned: a.count }));
    const total = Math.min(
      MAX_SYNERGY_BONUS,
      sectorBonus + combos.reduce((sum, c) => sum + c.bonus, 0),
    );
    result[id] = { sectorBonus, sectorCount, combos, total };
  }
  return result;
}

export interface SynergyPreview {
  /** Synergy the candidate itself would get. */
  candidate: SynergyBreakdown;
  /** Increase in synergy % on companies already owned, by company id. */
  uplift: Record<string, number>;
  /** Combos the candidate would newly activate or level up. */
  newCombos: string[];
  sectorCountAfter: number;
}

export function previewSynergy(ownedIds: string[], candidateId: string): SynergyPreview {
  const before = computeSynergies(ownedIds);
  const after = computeSynergies([...ownedIds, candidateId]);
  const uplift: Record<string, number> = {};
  for (const id of ownedIds) {
    const diff = after[id].total - before[id].total;
    if (diff > 1e-9) uplift[id] = diff;
  }
  const beforeCombos = new Map<string, number>();
  for (const b of Object.values(before)) for (const c of b.combos) beforeCombos.set(c.comboId, c.bonus);
  const newCombos = after[candidateId].combos
    .filter((c) => (beforeCombos.get(c.comboId) ?? 0) < c.bonus)
    .map((c) => c.comboId);
  return {
    candidate: after[candidateId],
    uplift,
    newCombos,
    sectorCountAfter: after[candidateId].sectorCount,
  };
}

/** Combos that can possibly activate given the companies in this game's pool. */
export function activeCombosForPool(poolIds: string[]): string[] {
  const pool = new Set(poolIds);
  return COMBOS.filter((c) => {
    if (c.anchor && !pool.has(c.anchor)) return false;
    const present = c.members.filter((m) => pool.has(m)).length;
    return present >= c.tiers[0].need;
  }).map((c) => c.id);
}

// ── Market events ───────────────────────────────────────────────

export interface EventEffect {
  demand: number;
  cost: number;
}

export function eventEffectFor(event: MarketEventDef | null | undefined, companyId: string): EventEffect {
  if (!event) return { demand: 1, cost: 1 };
  const company = COMPANY_BY_ID[companyId];
  const demand =
    1 + (event.demand[company.sector] ?? 0) + (event.companyDemand?.[companyId] ?? 0);
  const cost = 1 + (event.costs[company.sector] ?? 0) + (event.companyCosts?.[companyId] ?? 0);
  return { demand: Math.max(0, demand), cost: Math.max(0, cost) };
}

// ── Payouts & valuation ─────────────────────────────────────────

export interface PayoutLine {
  companyId: string;
  turnover: number;
  synergy: number;
  demandMult: number;
  gross: number;
  cost: number;
  costMult: number;
  net: number;
}

export function payoutLine(
  companyId: string,
  turnover: number,
  runningCost: number,
  synergy: number,
  event: MarketEventDef | null | undefined,
  runningCostsEnabled: boolean,
): PayoutLine {
  const effect = eventEffectFor(event, companyId);
  const gross = Math.round(turnover * (1 + synergy) * effect.demand);
  const cost = runningCostsEnabled ? Math.round(runningCost * effect.cost) : 0;
  return {
    companyId,
    turnover,
    synergy,
    demandMult: effect.demand,
    gross,
    cost,
    costMult: runningCostsEnabled ? effect.cost : 0,
    net: gross - cost,
  };
}

export function netPerRound(turnover: number, runningCost: number, synergy: number, runningCostsEnabled: boolean): number {
  return Math.round(turnover * (1 + synergy)) - (runningCostsEnabled ? runningCost : 0);
}

export function companyValuation(
  turnover: number,
  runningCost: number,
  synergy: number,
  runningCostsEnabled: boolean,
): number {
  return Math.max(0, netPerRound(turnover, runningCost, synergy, runningCostsEnabled)) * VALUATION_MULTIPLE;
}

// ── Formatting ──────────────────────────────────────────────────

export function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}M`;
}

export function pct(n: number, withSign = true): string {
  const v = Math.round(n * 100);
  return `${withSign && v > 0 ? '+' : ''}${v}%`;
}

export function flag(countryCode: string): string {
  return countryCode
    .toUpperCase()
    .replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));
}
