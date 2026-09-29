import { COMPANY_BY_ID } from '../../shared/data/companies.ts';
import { money, pct } from '../../shared/economy.ts';
import type { Persona } from '../../shared/types.ts';
import type { EnginePlayer, Game } from '../game/engine.ts';
import type { Rng } from '../game/rng.ts';
import { appraise, type Appraisal } from './appraise.ts';

export interface AiDecision {
  maxBid: number;
  reason: string;
  source: 'llm' | 'bot' | 'fallback';
}

const BUDGET_SHARE: Record<Persona, number> = {
  balanced: 1.7,
  tycoon: 2.4,
  value: 1.3,
  synergy: 2.0,
  gambler: 2.2,
};

/** How much of the purse a player should be willing to put into one company right now. */
export function budgetCap(game: Game, player: EnginePlayer, persona: Persona): number {
  const leftIncludingThis = game.upcomingCount() + 1;
  const expectedBuys = Math.max(1, leftIncludingThis / game.players.length);
  if (leftIncludingThis <= 1) return player.purse;
  return Math.floor(player.purse * Math.min(1, BUDGET_SHARE[persona] / expectedBuys));
}

/** Translate an appraisal into what the player is willing to pay under the chosen win condition. */
export function targetPrice(game: Game, a: Appraisal, persona: Persona, rng: Rng): number {
  let target: number;
  switch (game.settings.winCondition) {
    case 'purse':
      target = a.cashValue;
      break;
    case 'portfolio':
      // Cash is worth nothing at the end, so money only matters as ammunition.
      target = a.terminalValue * 2.5;
      break;
    case 'roi':
      target = a.value * 0.7;
      break;
    default:
      target = a.value;
  }

  const synergyPart = a.value - a.valueNoSynergy;
  switch (persona) {
    case 'balanced':
      target *= 0.9;
      break;
    case 'tycoon':
      target *= 1.1;
      break;
    case 'value':
      target *= 0.78;
      break;
    case 'synergy':
      target = (target + synergyPart * 0.8) * 0.9;
      break;
    case 'gambler':
      target *= 0.55 + rng.next() * 0.95;
      break;
  }
  target *= 0.93 + rng.next() * 0.14;
  if (game.settings.auctionMode === 'sealed') target *= persona === 'gambler' ? 0.7 + rng.next() * 0.3 : 0.85;
  return Math.max(0, target);
}

export function botDecision(
  game: Game,
  player: EnginePlayer,
  companyId: string,
  persona: Persona,
  rng: Rng,
  source: AiDecision['source'] = 'bot',
): AiDecision {
  const a = appraise(game, player, companyId);
  const tycoonBoost = persona === 'tycoon' && COMPANY_BY_ID[companyId].tier === 'mega' ? 1.1 : 1;
  const target = targetPrice(game, a, persona, rng) * tycoonBoost;
  const cap = budgetCap(game, player, persona);
  let maxBid = Math.floor(Math.min(target, cap, player.purse));
  if (maxBid < game.minOpeningBid()) maxBid = 0;

  const bits = [`est. ~${money(a.estTurnover)}/rd`];
  if (a.intelNotes.length) bits.push(a.intelNotes.join(', '));
  if (a.synergy > 0) bits.push(`synergy ${pct(a.synergy)}${a.newCombos.length ? ` (${a.newCombos.join(', ')})` : ''}`);
  if (a.eventDemand !== 1 || a.eventCost !== 1) bits.push(`news ×${a.eventDemand.toFixed(2)}`);
  bits.push(`${a.payoutsLeft} payouts left → worth ~${money(a.value)}`);
  const verdict =
    maxBid === 0
      ? 'Passing.'
      : maxBid < target * 0.95
        ? `Budget caps me at ${money(maxBid)}.`
        : maxBid > a.value * 1.02
          ? `Paying a premium: will go to ${money(maxBid)}.`
          : `Will go to ${money(maxBid)}.`;
  return { maxBid, reason: `${bits.join('; ')}. ${verdict}`, source };
}
