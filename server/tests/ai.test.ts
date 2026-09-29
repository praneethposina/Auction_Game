import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type GameSettings } from '../../shared/types.ts';
import { appraise } from '../ai/appraise.ts';
import { botDecision } from '../ai/bot.ts';
import { AiDirector } from '../ai/director.ts';
import { buildPrompt, parseDecision } from '../ai/llm.ts';
import { Game, type PlayerInit } from '../game/engine.ts';
import { createRng } from '../game/rng.ts';

const PLAYERS: PlayerInit[] = [
  { id: 'h', name: 'Human', kind: 'human', isHost: true },
  { id: 'bot', name: 'Botty', kind: 'bot', isHost: false, ai: { persona: 'balanced' } },
  { id: 'llm', name: 'Model', kind: 'llm', isHost: false, ai: { persona: 'tycoon', provider: 'groq', model: 'x' } },
];

function setup(overrides: Partial<GameSettings> = {}) {
  let clock = 0;
  const game = new Game({ settings: { ...DEFAULT_SETTINGS, companyCount: 6, ...overrides }, players: PLAYERS, seed: 9, now: 0 });
  return { game, clock: () => clock, setClock: (t: number) => (clock = t) };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('parseDecision', () => {
  it('reads plain, fenced and think-wrapped JSON', () => {
    expect(parseDecision('{"max_bid": 250, "reason": "solid"}', 1000)).toEqual({ maxBid: 250, reason: 'solid' });
    expect(parseDecision('```json\n{"max_bid": "$300", "reason": "x"}\n```', 1000)?.maxBid).toBe(300);
    expect(parseDecision('<think>{"max_bid": 999}</think>{"maxBid": 120}', 1000)?.maxBid).toBe(120);
    expect(parseDecision('I will bid. max_bid: 75', 1000)?.maxBid).toBe(75);
  });

  it('clamps to the purse and rejects garbage', () => {
    expect(parseDecision('{"max_bid": 5000}', 400)?.maxBid).toBe(400);
    expect(parseDecision('{"max_bid": -3}', 400)?.maxBid).toBe(0);
    expect(parseDecision('no idea', 400)).toBeNull();
  });
});

describe('appraisal and prompt', () => {
  it('uses band intel to narrow the estimate', () => {
    const { game } = setup();
    game.tick(100000);
    const companyId = game.auction!.companyId;
    const me = game.player('bot')!;
    const turnover = game.company(companyId)!.turnover;
    me.intel.push({ id: 't', kind: 'band', text: '', companyIds: [companyId], data: { low: turnover - 5, high: turnover + 5 }, round: 1, source: 'start' });
    const a = appraise(game, me, companyId);
    expect(Math.abs(a.estTurnover - turnover)).toBeLessThanOrEqual(5);
  });

  it('prompt includes private info but not hidden values', () => {
    const { game } = setup();
    game.tick(100000);
    const companyId = game.auction!.companyId;
    const me = game.player('llm')!;
    const other = game.player('h')!;
    other.purse = 8765;
    const { user } = buildPrompt(game, me, companyId, 'tycoon');
    expect(user).toContain(game.company(companyId)!.def.name);
    for (const tip of me.intel) expect(user).toContain(tip.text);
    expect(user).not.toContain('8,765');
  });

  it('bots never bid more than they have', () => {
    const { game } = setup();
    game.tick(100000);
    const me = game.player('bot')!;
    me.purse = 37;
    const d = botDecision(game, me, game.auction!.companyId, 'tycoon', createRng(1));
    expect(d.maxBid).toBeLessThanOrEqual(37);
  });
});

describe('AiDirector', () => {
  it('waits for LLM decisions, records thoughts and falls back on errors', async () => {
    const { game, clock, setClock } = setup({ auctionMode: 'sealed' });
    let calls = 0;
    const director = new AiDirector(game, clock, 1, {
      botDelay: false,
      llm: async () => {
        calls++;
        throw new Error('rate limited');
      },
    });
    setClock(100000);
    game.tick(clock());
    expect(game.auction!.aiPending.size).toBe(2);
    await flush();
    expect(calls).toBe(1);
    expect(game.auction!.aiPending.size).toBe(0);
    expect(game.auction!.sealed.has('bot')).toBe(true);
    expect(game.auction!.sealed.has('llm')).toBe(true);
    const thought = game.aiThoughts.find((t) => t.playerId === 'llm')!;
    expect(thought.source).toBe('fallback');
    expect(thought.reason).toContain('rate limited');
    game.submitSealed('h', null, clock());
    expect(game.phase).toBe('sold');
    director.dispose();
  });

  it('bids on behalf of AIs in open auctions until their limit', async () => {
    const { game, clock, setClock } = setup({ auctionMode: 'open' });
    const director = new AiDirector(game, clock, 2, {
      botDelay: false,
      llm: async () => ({ maxBid: 150, reason: 'fair value', source: 'llm' }),
    });
    setClock(100000);
    game.tick(clock());
    await flush();
    game.declareOut('h', clock());
    let t = clock();
    for (let i = 0; i < 400 && game.phase === 'auction'; i++) {
      t += 100;
      setClock(t);
      director.tick();
      game.tick(t);
    }
    expect(game.phase).toBe('sold');
    if (game.lastSale!.winnerId === 'llm') expect(game.lastSale!.price!).toBeLessThanOrEqual(150);
    director.dispose();
  });
});
