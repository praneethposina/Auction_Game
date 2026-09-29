import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import { llmDecision, parseDecision } from '../ai/llm.ts';
import { Game, type PlayerInit } from '../game/engine.ts';

describe('parseDecision handles the shapes real models produce', () => {
  const cases: [string, string, number][] = [
    ['clean JSON', '{"max_bid": 250, "reason": "solid"}', 250],
    ['code fence', '```json\n{"max_bid": 300, "reason": "x"}\n```', 300],
    ['closed think block', '<think>maybe {"max_bid": 999}</think>{"max_bid": 120}', 120],
    ['single quotes', "{'max_bid': 410, 'reason': 'ok'}", 410],
    ['trailing comma', '{"max_bid": 205, "reason": "fine",}', 205],
    ['thousands separator', '{"max_bid": 1,200, "reason": "big"}', 1200],
    ['unquoted keys', '{max_bid: 330, reason: "cheap"}', 330],
    ['dollar and unit', '{"max_bid": "$720M", "reason": "x"}', 720],
    ['billions', '{"max_bid": "$1.2B"}', 1200],
    ['camelCase key', '{"maxBid": 88}', 88],
    ['nested object', '{"decision": {"max_bid": 150, "reason": "nested"}}', 150],
    ['raw dollars', '{"max_bid": 450000000}', 450],
    ['prose then JSON', 'Given the synergy I value it highly.\n{"max_bid": 610, "reason": "combo"}', 610],
    ['plain text', 'After weighing it all, my max bid is $540M because of the Stargate combo.', 540],
    ['markdown bold', '**Maximum bid:** $475M\n**Reason:** strong sector', 475],
    ['bid up to', 'I will bid up to 380 million for this one.', 380],
    ['pass', 'I pass on this company, too risky.', 0],
  ];
  for (const [name, raw, expected] of cases) {
    it(name, () => {
      expect(parseDecision(raw, 5000, 1000)?.maxBid).toBe(expected);
    });
  }

  it('keeps the reason', () => {
    expect(parseDecision("{'max_bid': 410, 'reason': 'ok then'}", 5000)?.reason).toBe('ok then');
  });

  it('clamps to the purse and rejects non-answers', () => {
    expect(parseDecision('{"max_bid": 5000}', 400)?.maxBid).toBe(400);
    expect(parseDecision('{"max_bid": -3}', 400)?.maxBid).toBe(0);
    expect(parseDecision('Let me think about the sector heat and synergy...', 400)).toBeNull();
    expect(parseDecision('<think>still reasoning about {"max_bid": 900', 400)).toBeNull();
    expect(parseDecision('', 400)).toBeNull();
  });
});

describe('llmDecision recovers from flaky providers', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const players: PlayerInit[] = [
    { id: 'h', name: 'Human', kind: 'human', isHost: true },
    { id: 'llm', name: 'Model', kind: 'llm', isHost: false, ai: { persona: 'quant', provider: 'groq', model: 'm' } },
  ];

  function setup() {
    const game = new Game({ settings: { ...DEFAULT_SETTINGS, companyCount: 4 }, players, seed: 3, now: 0 });
    game.tick(1e9);
    return game;
  }

  /** Scripted provider: each call returns the next response. Records request bodies. */
  function script(responses: (Response | (() => Response))[]) {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const next = responses.shift();
      if (!next) throw new Error('no more scripted responses');
      return typeof next === 'function' ? next() : next;
    }) as typeof fetch;
    return bodies;
  }

  const ok = (content: string, finish = 'stop', extra: Record<string, unknown> = {}) =>
    Response.json({ choices: [{ finish_reason: finish, message: { content, ...extra } }] });

  const decide = (game: Game, model = 'model-a') =>
    llmDecision({
      game,
      player: game.player('llm')!,
      companyId: game.auction!.companyId,
      persona: 'quant',
      credentials: { provider: 'groq', baseUrl: 'https://fake.test/v1', apiKey: 'k', source: 'account' },
      model,
      timeoutMs: 20000,
    });

  it('asks for JSON mode and falls back when the provider rejects it', async () => {
    const game = setup();
    const bodies = script([
      new Response('response_format not supported', { status: 400 }),
      ok('{"max_bid": 222, "reason": "fine"}'),
    ]);
    const d = await decide(game, 'no-json-model');
    expect(d.maxBid).toBe(222);
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
    expect(bodies[1].response_format).toBeUndefined();
  });

  it('retries once after a rate limit', async () => {
    const game = setup();
    script([new Response('slow down', { status: 429, headers: { 'retry-after': '0.1' } }), ok('{"max_bid": 150}')]);
    expect((await decide(game)).maxBid).toBe(150);
  });

  it('retries with more room when a thinking model runs out of tokens', async () => {
    const game = setup();
    const bodies = script([ok('', 'length', { reasoning_content: 'hmm, heat, synergy, hmm…' }), ok('{"max_bid": 333}')]);
    expect((await decide(game)).maxBid).toBe(333);
    expect(bodies[1].max_tokens).toBe(4096);
  });

  it('reads the answer from the reasoning field when content is empty', async () => {
    const game = setup();
    script([ok('', 'stop', { reasoning_content: 'I conclude: {"max_bid": 275, "reason": "fair"}' })]);
    expect((await decide(game)).maxBid).toBe(275);
  });

  it('asks for a bare-JSON restatement when the answer is unreadable', async () => {
    const game = setup();
    const bodies = script([ok('This company looks attractive given the combos in play.'), ok('{"max_bid": 190, "reason": "combo"}')]);
    const d = await decide(game);
    expect(d.maxBid).toBe(190);
    const repairMsgs = bodies[1].messages as { role: string; content: string }[];
    expect(repairMsgs.at(-1)!.content).toContain('ONLY this JSON');
  });

  it('explains why it gave up', async () => {
    const game = setup();
    script([ok('', 'length'), ok('', 'length')]);
    await expect(decide(game)).rejects.toThrow('ran out of tokens while thinking');
    script([new Response('bad key', { status: 401 })]);
    await expect(decide(game)).rejects.toThrow('API key rejected');
  });
});

describe('provider failures that will not recover', () => {
  it('stops calling a provider that is out of credits', async () => {
    const { AiDirector } = await import('../ai/director.ts');
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: 'You have depleted your monthly included credits.' }), { status: 402 });
    }) as typeof fetch;
    try {
      let clock = 0;
      const game = new Game({
        settings: { ...DEFAULT_SETTINGS, companyCount: 4, auctionMode: 'sealed' },
        players: [
          { id: 'h', name: 'Human', kind: 'human', isHost: true },
          { id: 'llm', name: 'DeepSeek', kind: 'llm', isHost: false, ai: { persona: 'quant', provider: 'huggingface', model: 'x', modelLabel: 'DeepSeek' } },
        ],
        seed: 5,
        now: 0,
      });
      const director = new AiDirector(game, () => clock, 1, {
        botDelay: false,
        credentialsFor: () => ({ provider: 'huggingface', baseUrl: 'https://fake.test/v1', apiKey: 'k', source: 'account' }),
      });
      const settle = async () => {
        for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 1));
      };
      clock = 1e9;
      game.tick(clock);
      await settle();
      const first = game.aiThoughts.at(-1)!;
      expect(first.source).toBe('fallback');
      expect(first.reason).toContain('out of credits');
      expect(first.reason).toContain('depleted your monthly included credits');
      expect(calls).toBe(1);
      // Next lot: no new call, still plays.
      game.submitSealed('h', null, clock);
      clock += 1e6;
      game.tick(clock);
      await settle();
      expect(game.phase).toBe('auction');
      await settle();
      expect(calls).toBe(1);
      expect(game.aiThoughts.at(-1)!.reason).toContain('backup brain is playing');
      director.dispose();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
