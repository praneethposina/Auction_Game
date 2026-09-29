import { describe, expect, it } from 'vitest';
import { COMPANIES } from '../../shared/data/companies.ts';
import { DEFAULT_SETTINGS, PERSONAS, type GameSettings, type Persona } from '../../shared/types.ts';
import { appraise, heatPosterior } from '../ai/appraise.ts';
import { botDecision } from '../ai/bot.ts';
import { Game, type EnginePlayer, type PlayerInit } from '../game/engine.ts';
import { createRng } from '../game/rng.ts';

const PLAYERS: PlayerInit[] = [
  { id: 'me', name: 'Me', kind: 'bot', isHost: true, ai: { persona: 'quant' } },
  { id: 'r1', name: 'Rival 1', kind: 'bot', isHost: false, ai: { persona: 'balanced' } },
  { id: 'r2', name: 'Rival 2', kind: 'bot', isHost: false, ai: { persona: 'balanced' } },
];

function setup(overrides: Partial<GameSettings> = {}, players = PLAYERS) {
  const game = new Game({ settings: { ...DEFAULT_SETTINGS, companyCount: 12, ...overrides }, players, seed: 11, now: 0 });
  game.tick(1e9); // into the first auction
  return game;
}

/** Hand a company to a player as if they had won it. */
function give(game: Game, p: EnginePlayer, companyId: string, price = 100) {
  const c = game.company(companyId);
  if (!c) throw new Error(`${companyId} not in pool`);
  c.status = 'sold';
  c.ownerId = p.id;
  c.price = price;
  c.roundBought = 1;
  p.holdings.push({ companyId, price, roundBought: 1 });
  p.purse -= price;
  p.spent += price;
}

describe('sector heat inference', () => {
  it('reads heat from the turnovers of companies the player owns', () => {
    const game = setup();
    const me = game.player('me')!;
    const [a, b] = game.companies.filter((c) => c.status === 'upcoming');
    give(game, me, a.def.id);
    a.turnover = game.settings.turnoverMax; // a stunning result…
    const hot = heatPosterior(game, me, a.def.sector);
    const hotMean = [...hot].reduce((s, [h, w]) => s + h * w, 0);
    expect(hotMean).toBeGreaterThan(0.03);

    a.turnover = game.settings.turnoverMin; // …or a dud
    const cold = heatPosterior(game, me, a.def.sector);
    expect([...cold].reduce((s, [h, w]) => s + h * w, 0)).toBeLessThan(-0.03);
    // Other sectors are untouched unless we own something there.
    if (b.def.sector !== a.def.sector) {
      const other = heatPosterior(game, me, b.def.sector);
      expect([...other].reduce((s, [h, w]) => s + h * w, 0)).toBeCloseTo(0, 5);
    }
  });

  it('trusts an exact heat tip', () => {
    const game = setup();
    const me = game.player('me')!;
    me.intel.push({ id: 'x', kind: 'sectorHeat', text: '', companyIds: [], sectorId: 'ai', data: { heat: 0.14 }, round: 1, source: 'start' });
    expect([...heatPosterior(game, me, 'ai')]).toEqual([[0.14, 1]]);
  });
});

describe('bots never peek at hidden information', () => {
  it('ignore rivals’ real cash and hidden turnovers', () => {
    const game = setup();
    const me = game.player('me')!;
    const rival = game.player('r1')!;
    const target = game.auction!.companyId;
    const other = game.companies.find((c) => c.status === 'upcoming')!;
    give(game, rival, other.def.id, 150);

    const decide = () => botDecision(game, me, target, 'quant', createRng(3)).maxBid;
    const before = decide();
    rival.purse = 99999;
    other.turnover = game.settings.turnoverMax;
    expect(decide()).toBe(before);
    rival.purse = -500;
    other.turnover = game.settings.turnoverMin;
    expect(decide()).toBe(before);
  });
});

describe('bidding math', () => {
  it('shades sealed bids less when more rivals compete', () => {
    const small = setup({ auctionMode: 'sealed' }, PLAYERS.slice(0, 2));
    const many = setup(
      { auctionMode: 'sealed' },
      [...PLAYERS, ...['r3', 'r4', 'r5'].map((id) => ({ id, name: id, kind: 'bot' as const, isHost: false, ai: { persona: 'balanced' as Persona } }))],
    );
    const shadeOf = (g: Game) => {
      const me = g.player('me')!;
      const d = botDecision(g, me, g.auction!.companyId, 'quant', createRng(1));
      const m = d.reason.match(/bidding (\d+)%/);
      return Number(m?.[1]);
    };
    expect(shadeOf(small)).toBeLessThan(shadeOf(many));
    expect(shadeOf(many)).toBeLessThanOrEqual(93);
  });

  it('values cash-only win conditions below net worth', () => {
    const nw = setup({ winCondition: 'netWorth' });
    const cash = setup({ winCondition: 'purse' });
    const id = nw.auction!.companyId;
    const a = appraise(nw, nw.player('me')!, id);
    expect(a.cashValue).toBeLessThan(a.value);
    const bid = (g: Game) => botDecision(g, g.player('me')!, id, 'quant', createRng(2)).maxBid;
    expect(bid(cash)).toBeLessThanOrEqual(bid(nw));
  });

  it('spoilers pay extra to keep a combo piece from a rival', () => {
    const game = setup({ companyCount: 40 });
    const me = game.player('me')!;
    const rival = game.player('r1')!;
    // Find an upcoming pair that forms a 2-member combo.
    const pool = new Set(game.companies.filter((c) => c.status === 'upcoming').map((c) => c.def.id));
    const pairs: [string, string][] = [
      ['alphabet', 'meta'],
      ['coca_cola', 'pepsico'],
      ['microsoft', 'openai'],
      ['eli_lilly', 'novo_nordisk'],
      ['nike', 'adidas'],
    ];
    let pair = pairs.find(([x, y]) => pool.has(x) && pool.has(y));
    if (!pair) {
      // Force one into the pool for the test.
      const [x, y] = pairs[0];
      const slots = game.companies.filter((c) => c.status === 'upcoming').slice(0, 2);
      slots[0].def = COMPANIES.find((c) => c.id === x)!;
      slots[1].def = COMPANIES.find((c) => c.id === y)!;
      pair = [x, y];
    }
    const [held, target] = pair;
    const without = appraise(game, me, target).denialValue;
    give(game, rival, held);
    const withRival = appraise(game, me, target);
    expect(without).toBe(0);
    expect(withRival.denialValue).toBeGreaterThan(0);
    expect(withRival.denialNote).toContain('Rival 1');
    const spoiler = botDecision(game, me, target, 'blocker', createRng(4));
    expect(spoiler.reason).toContain('Rival 1');
  });

  it('every personality produces a sane bid', () => {
    for (const persona of Object.keys(PERSONAS) as Persona[]) {
      for (const mode of ['open', 'sealed'] as const) {
        const game = setup({ auctionMode: mode });
        const me = game.player('me')!;
        const d = botDecision(game, me, game.auction!.companyId, persona, createRng(9));
        expect(d.maxBid).toBeGreaterThanOrEqual(0);
        expect(d.maxBid).toBeLessThanOrEqual(me.purse);
        expect(d.reason.length).toBeGreaterThan(10);
      }
    }
  });
});
