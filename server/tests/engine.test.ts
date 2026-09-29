import { describe, expect, it } from 'vitest';
import { COMPANIES, COMPANY_BY_ID } from '../../shared/data/companies.ts';
import { COMBOS } from '../../shared/data/combos.ts';
import { EVENT_BY_ID, MARKET_EVENTS } from '../../shared/data/events.ts';
import { SECTOR_IDS, SECTORS } from '../../shared/data/sectors.ts';
import {
  computeSynergies,
  eventEffectFor,
  likelyRange,
  payoutLine,
  previewSynergy,
} from '../../shared/economy.ts';
import { DEFAULT_SETTINGS, type GameSettings } from '../../shared/types.ts';
import { Game, TIMING, type PlayerInit } from '../game/engine.ts';
import { createRng } from '../game/rng.ts';
import { rollSectorHeat, rollTurnover, selectPool } from '../game/setup.ts';
import { sanitizeSettings } from '../rooms.ts';

const PLAYERS: PlayerInit[] = [
  { id: 'a', name: 'Alice', kind: 'human', isHost: true },
  { id: 'b', name: 'Bob', kind: 'human', isHost: false },
  { id: 'c', name: 'Cara', kind: 'human', isHost: false },
];

function newGame(overrides: Partial<GameSettings> = {}, seed = 42, players = PLAYERS) {
  const settings = { ...DEFAULT_SETTINGS, companyCount: 6, ...overrides };
  return new Game({ settings, players, seed, now: 0 });
}

/** Advance the clock past the current phase deadline. */
function advance(game: Game, now: number): number {
  const t = Math.max(now, (game.phaseEndsAt ?? now) + 1);
  game.tick(t);
  return t;
}

describe('game data', () => {
  it('has exactly 200 unique companies in known sectors', () => {
    expect(COMPANIES).toHaveLength(200);
    expect(new Set(COMPANIES.map((c) => c.id)).size).toBe(200);
    for (const c of COMPANIES) expect(SECTORS[c.sector]).toBeDefined();
  });

  it('combos reference real companies, anchors are members and tiers ascend', () => {
    const ids = new Set(COMBOS.map((c) => c.id));
    expect(ids.size).toBe(COMBOS.length);
    for (const combo of COMBOS) {
      for (const m of combo.members) expect(COMPANY_BY_ID[m], `${combo.id}: ${m}`).toBeDefined();
      expect(new Set(combo.members).size).toBe(combo.members.length);
      if (combo.anchor) expect(combo.members).toContain(combo.anchor);
      for (let i = 1; i < combo.tiers.length; i++) {
        expect(combo.tiers[i].need).toBeGreaterThan(combo.tiers[i - 1].need);
        expect(combo.tiers[i].bonus).toBeGreaterThan(combo.tiers[i - 1].bonus);
      }
      expect(combo.tiers[combo.tiers.length - 1].need).toBeLessThanOrEqual(combo.members.length);
    }
  });

  it('market events reference real sectors and companies', () => {
    expect(new Set(MARKET_EVENTS.map((e) => e.id)).size).toBe(MARKET_EVENTS.length);
    for (const e of MARKET_EVENTS) {
      for (const s of [...Object.keys(e.demand), ...Object.keys(e.costs)]) {
        expect(SECTOR_IDS, `${e.id}: ${s}`).toContain(s);
      }
      for (const id of [...Object.keys(e.companyDemand ?? {}), ...Object.keys(e.companyCosts ?? {})]) {
        expect(COMPANY_BY_ID[id], `${e.id}: ${id}`).toBeDefined();
      }
    }
  });
});

describe('setup', () => {
  it('selects the requested number of unique companies', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rng = createRng(seed);
      for (const count of [3, 10, 20, 37, 60]) {
        const pool = selectPool(rng, count);
        expect(pool).toHaveLength(count);
        expect(new Set(pool).size).toBe(count);
      }
    }
    expect(selectPool(createRng(1), 200)).toHaveLength(200);
  });

  it('seeds pools so sector pairs and combos are reachable', () => {
    let withCombo = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const game = newGame({ companyCount: 20 }, seed);
      if (game.activeComboIds.length > 0) withCombo++;
      const counts = new Map<string, number>();
      for (const c of game.companies) counts.set(c.def.sector, (counts.get(c.def.sector) ?? 0) + 1);
      expect([...counts.values()].some((n) => n >= 2)).toBe(true);
    }
    expect(withCombo).toBe(40);
  });

  it('keeps turnovers inside the host range and respects tiers on average', () => {
    const rng = createRng(7);
    const sums = { mega: 0, mid: 0 };
    for (let i = 0; i < 400; i++) {
      const heat = rollSectorHeat(rng);
      const mega = rollTurnover(rng, 'nvidia', heat, 20, 200);
      const mid = rollTurnover(rng, 'snap', heat, 20, 200);
      for (const t of [mega, mid]) {
        expect(t).toBeGreaterThanOrEqual(20);
        expect(t).toBeLessThanOrEqual(200);
      }
      sums.mega += mega;
      sums.mid += mid;
    }
    expect(sums.mega / 400).toBeGreaterThan(sums.mid / 400 + 40);
  });

  it('reports a sensible likely range per tier', () => {
    const mega = likelyRange('mega', 20, 200);
    const mid = likelyRange('mid', 20, 200);
    expect(mega.low).toBeGreaterThan(mid.low);
    expect(mega.high).toBeLessThanOrEqual(200);
    expect(mid.low).toBeGreaterThanOrEqual(20);
  });
});

describe('synergies', () => {
  it('awards named combos and sector bonuses', () => {
    const syn = computeSynergies(['alphabet', 'meta']);
    // Same sector (internet) → +10%, Ad Duopoly → +25%.
    expect(syn.alphabet.sectorBonus).toBeCloseTo(0.1);
    expect(syn.alphabet.combos.map((c) => c.comboId)).toContain('ad_duopoly');
    expect(syn.meta.total).toBeCloseTo(0.35);
  });

  it('requires the anchor for anchored combos', () => {
    const without = computeSynergies(['amazon', 'alphabet']);
    expect(without.amazon.combos.map((c) => c.comboId)).not.toContain('claude_coalition');
    expect(without.amazon.combos.map((c) => c.comboId)).toContain('hyperscalers');
    const withAnchor = computeSynergies(['amazon', 'anthropic']);
    expect(withAnchor.anthropic.combos.map((c) => c.comboId)).toContain('claude_coalition');
  });

  it('previews the uplift from adding a company', () => {
    const preview = previewSynergy(['coca_cola'], 'pepsico');
    expect(preview.newCombos).toContain('cola_wars');
    expect(preview.uplift.coca_cola).toBeGreaterThan(0);
  });

  it('caps a company at +100%', () => {
    const everything = COMPANIES.map((c) => c.id);
    const syn = computeSynergies(everything);
    for (const s of Object.values(syn)) expect(s.total).toBeLessThanOrEqual(1);
  });
});

describe('market events', () => {
  it('stack sector and company effects', () => {
    const oil = EVENT_BY_ID.oil_spike;
    expect(eventEffectFor(oil, 'exxon').demand).toBeCloseTo(1.45);
    expect(eventEffectFor(oil, 'delta').cost).toBeCloseTo(1.35);
    // Energy sector +45%, NextEra -30% on top.
    expect(eventEffectFor(oil, 'nextera').demand).toBeCloseTo(1.15);
    expect(eventEffectFor(null, 'exxon')).toEqual({ demand: 1, cost: 1 });
  });

  it('computes payout lines with synergy, demand and costs', () => {
    const line = payoutLine('exxon', 100, 50, 0.2, EVENT_BY_ID.oil_spike, true);
    expect(line.gross).toBe(Math.round(100 * 1.2 * 1.45));
    expect(line.cost).toBe(50);
    expect(line.net).toBe(line.gross - 50);
    expect(payoutLine('exxon', 100, 50, 0, null, false).net).toBe(100);
  });
});

describe('open auction', () => {
  it('runs a sale end to end and charges the winner', () => {
    const game = newGame();
    expect(game.phase).toBe('intro');
    let now = advance(game, 0);
    expect(game.phase).toBe('auction');
    const companyId = game.auction!.companyId;

    expect(game.placeBid('a', 5, now)).toMatchObject({ ok: false });
    expect(game.placeBid('a', 50, now)).toEqual({ ok: true });
    expect(game.placeBid('a', 60, now)).toMatchObject({ ok: false }); // already leading
    expect(game.placeBid('b', 52, now)).toMatchObject({ ok: false }); // below min increment
    expect(game.placeBid('b', 100, now)).toEqual({ ok: true });
    expect(game.placeBid('c', 5000, now)).toMatchObject({ ok: false }); // over purse

    game.declareOut('a', now);
    game.declareOut('c', now);
    // Everyone except the leader is out → closes quickly.
    expect(game.auction!.deadline).toBe(now + TIMING.earlyCloseMs);
    now = advance(game, now);
    expect(game.phase).toBe('sold');
    const bob = game.player('b')!;
    expect(bob.purse).toBe(DEFAULT_SETTINGS.startingBudget - 100);
    expect(bob.holdings).toEqual([{ companyId, price: 100, roundBought: 1 }]);
    expect(game.company(companyId)!.status).toBe('sold');
  });

  it('withdraws a company when nobody bids', () => {
    const game = newGame();
    const now = advance(game, 0);
    const id = game.auction!.companyId;
    for (const p of PLAYERS) game.declareOut(p.id, now);
    expect(game.phase).toBe('sold');
    expect(game.company(id)!.status).toBe('unsold');
    expect(game.lastSale!.winnerId).toBeNull();
  });

  it('extends the countdown after a late bid', () => {
    const game = newGame({ bidSeconds: 10 });
    const start = advance(game, 0);
    const late = start + 9000;
    game.placeBid('a', 20, late);
    expect(game.auction!.deadline).toBeGreaterThanOrEqual(late + 4000);
  });

  it('waits for AI players that are still thinking, up to a limit', () => {
    const game = newGame();
    const start = advance(game, 0);
    game.setAiPending('c', true, start);
    game.tick(start + DEFAULT_SETTINGS.bidSeconds * 1000 + 10);
    expect(game.phase).toBe('auction');
    game.tick(game.auction!.hardDeadline + 1);
    expect(game.phase).toBe('sold');
  });
});

describe('sealed auction', () => {
  it('awards the highest sealed bid, earliest wins ties', () => {
    const game = newGame({ auctionMode: 'sealed' });
    const now = advance(game, 0);
    expect(game.submitSealed('a', 120, now)).toEqual({ ok: true });
    expect(game.submitSealed('a', 130, now)).toMatchObject({ ok: false });
    expect(game.submitSealed('b', 120, now + 5)).toEqual({ ok: true });
    expect(game.phase).toBe('auction');
    expect(game.placeBid('c', 50, now)).toMatchObject({ ok: false });
    expect(game.submitSealed('c', null, now + 6)).toEqual({ ok: true });
    // All submitted → resolves immediately.
    expect(game.phase).toBe('sold');
    expect(game.lastSale).toMatchObject({ winnerId: 'a', price: 120 });
  });

  it('hides other players’ sealed amounts', () => {
    const game = newGame({ auctionMode: 'sealed' });
    const now = advance(game, 0);
    game.submitSealed('a', 321, now);
    const bobView = JSON.stringify(game.viewFor('b', now));
    expect(bobView).not.toMatch(/[:[,]321[,}\]]/);
    expect(game.viewFor('b', now).auction!.sealedSubmittedIds).toEqual(['a']);
    expect(game.viewFor('a', now).auction!.myBid).toBe(321);
  });
});

describe('rounds, payouts and results', () => {
  function playOut(game: Game, pick: (game: Game, now: number) => void) {
    let now = 0;
    let guard = 0;
    while (game.phase !== 'finished' && guard++ < 1000) {
      if (game.phase === 'auction') pick(game, now);
      now = advance(game, now);
    }
    return now;
  }

  it('pays out owned companies at the end of each round', () => {
    const game = newGame({ companyCount: 6, marketEvents: false });
    let now = advance(game, 0); // round 1, auction 1
    const first = game.auction!.companyId;
    game.placeBid('a', 100, now);
    now = advance(game, now); // closes
    // Finish round 1 with no more purchases.
    while (game.phase !== 'summary') {
      if (game.phase === 'auction') for (const p of PLAYERS) game.declareOut(p.id, now);
      now = advance(game, now);
    }
    const alice = game.player('a')!;
    const c = game.company(first)!;
    const expected = c.turnover - c.runningCost;
    expect(alice.payouts[0].total).toBe(expected);
    expect(alice.purse).toBe(1000 - 100 + expected);
  });

  it('plays a full game to a ranked finish', () => {
    const game = newGame({ companyCount: 9 });
    let turn = 0;
    playOut(game, (g, now) => {
      const bidder = PLAYERS[turn++ % PLAYERS.length].id;
      g.placeBid(bidder, g.minNextBid() + 20, now);
    });
    expect(game.phase).toBe('finished');
    expect(game.round).toBe(3);
    const results = game.results!;
    expect(results.standings).toHaveLength(3);
    for (let i = 1; i < results.standings.length; i++) {
      expect(results.standings[i - 1].metric).toBeGreaterThanOrEqual(results.standings[i].metric);
    }
    for (const s of results.standings) {
      expect(s.netWorth).toBe(s.purse + s.portfolioValue);
    }
  });

  it('ranks by the chosen win condition', () => {
    for (const winCondition of ['netWorth', 'roi', 'purse', 'portfolio'] as const) {
      const game = newGame({ companyCount: 6, winCondition });
      let turn = 0;
      playOut(game, (g, now) => {
        g.placeBid(PLAYERS[turn++ % 3].id, g.minNextBid() + 10 * turn, now);
      });
      const s = game.results!.standings;
      const key = { netWorth: 'netWorth', roi: 'roi', purse: 'purse', portfolio: 'portfolioValue' }[winCondition] as
        | 'netWorth'
        | 'roi'
        | 'purse'
        | 'portfolioValue';
      for (const row of s) expect(row.metric).toBe(row[key]);
    }
  });

  it('gives the trailing player catch-up intel after a round', () => {
    const game = newGame({ companyCount: 9, intelPerPlayer: 0, catchUpIntel: true });
    let now = advance(game, 0);
    // Alice overpays badly for the first company; the others buy nothing.
    game.placeBid('a', 900, now);
    while (game.phase !== 'summary') {
      if (game.phase === 'auction') for (const p of PLAYERS) if (p.id !== 'a') game.declareOut(p.id, now);
      if (game.phase === 'auction') game.declareOut('a', now);
      now = advance(game, now);
    }
    expect(game.player('a')!.intel.length).toBe(1);
    expect(game.player('b')!.intel.length).toBe(0);
  });
});

describe('hidden information', () => {
  it('never reveals other players’ purse or turnovers', () => {
    const game = newGame({ companyCount: 6 });
    let now = advance(game, 0);
    const id = game.auction!.companyId;
    game.placeBid('a', 137, now);
    for (const p of ['b', 'c']) game.declareOut(p, now);
    now = advance(game, now);

    const turnover = game.company(id)!.turnover;
    const bob = game.viewFor('b', now);
    expect(bob.me!.purse).toBe(1000);
    expect(bob.lastSale!.turnover).toBeUndefined();
    expect(bob.players.find((p) => p.id === 'a')!.companyIds).toEqual([id]);
    const leaked = JSON.stringify(bob);
    expect(leaked).not.toContain(`"purse":${1000 - 137}`);
    expect(bob.me!.holdings).toHaveLength(0);

    const alice = game.viewFor('a', now);
    expect(alice.lastSale!.turnover).toBe(turnover);
    expect(alice.me!.holdings[0].turnover).toBe(turnover);
  });

  it('hides AI reasoning for the company currently on the block', () => {
    const game = newGame({ aiReasoning: 'live' });
    const now = advance(game, 0);
    const id = game.auction!.companyId;
    game.recordAiThought({ playerId: 'c', companyId: id, round: 1, maxBid: 99, reason: 'secret', source: 'bot', at: now });
    expect(game.viewFor('a', now).aiThoughts).toHaveLength(0);
    for (const p of PLAYERS) game.declareOut(p.id, now);
    expect(game.viewFor('a', now).aiThoughts).toHaveLength(1);
  });

  it('intel tips are always true', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const game = newGame({ companyCount: 20, intelPerPlayer: 5 }, seed);
      const t = (id: string) => game.company(id)!.turnover;
      for (const p of game.players) {
        for (const tip of p.intel) {
          const nums = [...tip.text.matchAll(/\$([\d,]+)M/g)].map((m) => Number(m[1].replace(/,/g, '')));
          switch (tip.kind) {
            case 'band':
              expect(t(tip.companyIds[0])).toBeGreaterThanOrEqual(nums[0]);
              expect(t(tip.companyIds[0])).toBeLessThanOrEqual(nums[1]);
              break;
            case 'above':
              expect(t(tip.companyIds[0])).toBeGreaterThanOrEqual(nums[0]);
              break;
            case 'below':
              expect(t(tip.companyIds[0])).toBeLessThanOrEqual(nums[0]);
              break;
            case 'compare':
              expect(t(tip.companyIds[0])).toBeGreaterThanOrEqual(t(tip.companyIds[1]));
              break;
            case 'sectorHeat': {
              const heat = game.heat[tip.sectorId!];
              if (tip.text.includes('hot') || tip.text.includes('warm')) expect(heat).toBeGreaterThan(0);
              else if (tip.text.includes('cold') || tip.text.includes('cool')) expect(heat).toBeLessThan(0);
              else expect(heat).toBe(0);
              break;
            }
            case 'nextEvent':
              expect(game.events[1].id).toBe(tip.eventId);
              break;
            case 'rank':
              break;
          }
        }
      }
    }
  });
});

describe('round intro timing', () => {
  it('shows the intro for the host-chosen number of seconds every round', () => {
    const game = newGame({ companyCount: 6, introSeconds: 12 });
    expect(game.phase).toBe('intro');
    expect(game.phaseEndsAt).toBe(12000);
    game.tick(11999);
    expect(game.phase).toBe('intro');
    let now = advance(game, 0);
    expect(game.phase).toBe('auction');
    while (game.phase !== 'intro') {
      if (game.phase === 'auction') for (const p of PLAYERS) game.declareOut(p.id, now);
      now = advance(game, now);
    }
    expect(game.round).toBe(2);
    expect(game.phaseEndsAt! - now).toBe(12000);
  });

  it('clamps the setting to 2–60 seconds', () => {
    expect(sanitizeSettings(DEFAULT_SETTINGS, { introSeconds: 0 }).introSeconds).toBe(2);
    expect(sanitizeSettings(DEFAULT_SETTINGS, { introSeconds: 999 }).introSeconds).toBe(60);
    expect(sanitizeSettings(DEFAULT_SETTINGS, { introSeconds: 15 }).introSeconds).toBe(15);
    expect(sanitizeSettings(DEFAULT_SETTINGS, { introSeconds: Number.NaN }).introSeconds).toBe(DEFAULT_SETTINGS.introSeconds);
  });
});
