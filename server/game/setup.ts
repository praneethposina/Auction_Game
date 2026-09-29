import { COMPANIES, COMPANY_BY_ID } from '../../shared/data/companies.ts';
import { COMBOS } from '../../shared/data/combos.ts';
import { MARKET_EVENTS, type MarketEventDef } from '../../shared/data/events.ts';
import { SECTOR_IDS, type SectorId } from '../../shared/data/sectors.ts';
import { BINOMIAL_N, clampP, HEAT_SHIFTS, TIER_P, turnoverFromDraw } from '../../shared/economy.ts';
import type { Rng } from './rng.ts';

/**
 * Pick `count` companies for this game, in auction order.
 * The pool is seeded with a few named combos and clustered by sector so that
 * synergies are actually reachable, instead of 20 unrelated companies.
 */
export function selectPool(rng: Rng, count: number): string[] {
  const total = COMPANIES.length;
  if (count >= total) return rng.shuffle(COMPANIES.map((c) => c.id));

  const pool = new Set<string>();
  const add = (id: string) => {
    if (pool.size < count) pool.add(id);
  };

  // 1. Seed a handful of combos so there is something to chase.
  const comboTarget = Math.max(1, Math.round(count / 7));
  const comboBudget = Math.ceil(count * 0.6);
  let seeded = 0;
  for (const combo of rng.shuffle(COMBOS)) {
    if (seeded >= comboTarget) break;
    const need = combo.tiers[0].need;
    const chosen: string[] = [];
    if (combo.anchor) chosen.push(combo.anchor);
    for (const m of rng.shuffle(combo.members)) {
      if (chosen.length >= need) break;
      if (!chosen.includes(m)) chosen.push(m);
    }
    const fresh = chosen.filter((id) => !pool.has(id));
    if (pool.size + fresh.length > comboBudget) continue;
    fresh.forEach(add);
    seeded++;
  }

  // 2. Fill with sector clusters, favouring sectors that are already present.
  const present = new Set([...pool].map((id) => COMPANY_BY_ID[id].sector));
  const sectorOrder: SectorId[] = [
    ...rng.shuffle(SECTOR_IDS.filter((s) => present.has(s))),
    ...rng.shuffle(SECTOR_IDS.filter((s) => !present.has(s))),
  ];
  while (pool.size < count) {
    let progressed = false;
    for (const sector of sectorOrder) {
      if (pool.size >= count) break;
      const available = rng.shuffle(COMPANIES.filter((c) => c.sector === sector && !pool.has(c.id)));
      if (available.length === 0) continue;
      const take = Math.min(present.has(sector) ? rng.int(1, 2) : rng.int(2, 3), available.length);
      for (const c of available.slice(0, take)) add(c.id);
      present.add(sector);
      progressed = true;
    }
    if (!progressed) break;
  }

  return rng.shuffle([...pool]);
}

export function rollSectorHeat(rng: Rng): Record<SectorId, number> {
  return Object.fromEntries(SECTOR_IDS.map((s) => [s, rng.pick(HEAT_SHIFTS)])) as Record<SectorId, number>;
}

export function rollTurnover(
  rng: Rng,
  companyId: string,
  heat: Record<SectorId, number>,
  min: number,
  max: number,
): number {
  const company = COMPANY_BY_ID[companyId];
  const p = clampP(TIER_P[company.tier] + heat[company.sector]);
  return turnoverFromDraw(rng.binomial(BINOMIAL_N, p), min, max);
}

/** One event per round, drawn without replacement (reshuffled if the game outlasts the deck). */
export function drawEvents(rng: Rng, rounds: number): MarketEventDef[] {
  const out: MarketEventDef[] = [];
  let deck = [...MARKET_EVENTS];
  for (let i = 0; i < rounds; i++) {
    if (deck.length === 0) deck = [...MARKET_EVENTS];
    const ev = rng.weighted(deck, (e) => e.weight ?? 1);
    out.push(ev);
    deck = deck.filter((e) => e !== ev);
  }
  return out;
}
