import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import { botDecision } from '../ai/bot.ts';
import { publicSafeReason } from '../ai/llm.ts';
import { Game, type PlayerInit } from '../game/engine.ts';
import { createRng } from '../game/rng.ts';
import { Room } from '../rooms.ts';

const PLAYERS: PlayerInit[] = [
  { id: 'h', name: 'Human', kind: 'human', isHost: true },
  { id: 'b', name: 'Bot', kind: 'bot', isHost: false, ai: { persona: 'quant' } },
];

function setup() {
  const game = new Game({ settings: { ...DEFAULT_SETTINGS, companyCount: 12 }, players: PLAYERS, seed: 21, now: 0 });
  game.tick(1e9);
  return game;
}

describe('AI reasoning never leaks private information during the game', () => {
  it('bot public reasons leave out intel, estimates, heat and cash', () => {
    const game = setup();
    const bot = game.player('b')!;
    const id = game.auction!.companyId;
    const sector = game.company(id)!.def.sector;
    bot.intel.push({ id: 't1', kind: 'band', text: '', companyIds: [id], data: { low: 135, high: 180 }, round: 1, source: 'start' });
    bot.intel.push({ id: 't2', kind: 'sectorHeat', text: '', companyIds: [], sectorId: sector, data: { heat: 0.14 }, round: 1, source: 'start' });
    bot.purse = 777;
    const d = botDecision(game, bot, id, 'quant', createRng(1));
    expect(d.reason).toMatch(/intel/);
    for (const leak of [/intel/i, /\$135/, /\$180/, /est\./, /hot|cold/i, /\$777/, /worth ~/, /Budget caps/]) {
      expect(d.publicReason).not.toMatch(leak);
    }
    expect(d.publicReason).toMatch(/payouts? left/);
  });

  it('holds back LLM reasons that quote intel, heat, cash or own turnovers', () => {
    const game = setup();
    const p = game.player('b')!;
    p.purse = 3000;
    p.intel.push({ id: 't', kind: 'below', text: '', companyIds: [], data: { high: 300 }, round: 1, source: 'start' });
    const own = game.companies.find((c) => c.status === 'upcoming')!;
    own.status = 'sold';
    own.ownerId = 'b';
    own.turnover = 187;
    p.holdings.push({ companyId: own.def.id, price: 100, roundBought: 1 });
    expect(publicSafeReason('My intel says Retail is ice cold, so bid cheap.', game, p)).toBeNull();
    expect(publicSafeReason('Retail looks cold this game.', game, p)).toBeNull();
    expect(publicSafeReason('With $3,000M in cash I can afford it.', game, p)).toBeNull();
    expect(publicSafeReason('It turns over less than $300M, so modest bid.', game, p)).toBeNull();
    expect(publicSafeReason('My other company makes $187M a round.', game, p)).toBeNull();
    expect(publicSafeReason('Intel says this one tops the pool.', game, p)).toBeNull();
    expect(publicSafeReason('Per my tips, a solid earner.', game, p)).toBeNull();
    // The chip company is not a leak.
    expect(publicSafeReason('Intel completes GPU Wars with my NVIDIA; worth a strong bid.', game, p)).toBe(
      'Intel completes GPU Wars with my NVIDIA; worth a strong bid.',
    );
    expect(publicSafeReason('Anchor for Streaming Giants; 10 payouts left make it worth a strong bid.', game, p)).toBe(
      'Anchor for Streaming Giants; 10 payouts left make it worth a strong bid.',
    );
  });

  it('players see the public reason live and the full one after the game', () => {
    const game = setup();
    const id = game.auction!.companyId;
    game.recordAiThought({ playerId: 'b', companyId: id, round: 1, maxBid: 50, reason: 'FULL: intel says top earner', publicReason: 'PUBLIC: fits my combo', source: 'bot', at: 1 });
    game.declareOut('h', 1e9);
    game.declareOut('b', 1e9);
    const live = game.viewFor('h', 1e9).aiThoughts;
    expect(live[0].reason).toBe('PUBLIC: fits my combo');
    expect(JSON.stringify(game.viewFor('h', 1e9))).not.toContain('FULL:');
    game.endEarly();
    expect(game.viewFor('h', 2e9).aiThoughts[0].reason).toBe('FULL: intel says top earner');
  });
});

describe('AI personality visibility', () => {
  function room(showPersonas: boolean) {
    const r = new Room('PPPPP');
    const host = r.addHuman('Host');
    const guest = r.addHuman('Guest');
    if (!host.ok || !guest.ok) throw new Error('setup');
    r.updateSettings(host.data!.id, { showPersonas });
    r.addAi(host.data!.id, { persona: 'blocker' });
    return { r, hostId: host.data!.id, guestId: guest.data!.id };
  }

  it('shows personalities to everyone when on', () => {
    const { r, guestId } = room(true);
    expect(r.viewFor(guestId, 0).players.find((p) => p.kind === 'bot')!.ai!.persona).toBe('blocker');
  });

  it('hides them from other players when off, but not from the host or after the game', () => {
    const { r, hostId, guestId } = room(false);
    expect(r.viewFor(hostId, 0).players.find((p) => p.kind === 'bot')!.ai!.persona).toBe('blocker');
    const guestLobby = r.viewFor(guestId, 0);
    expect(guestLobby.players.find((p) => p.kind === 'bot')!.ai!.persona).toBeUndefined();
    expect(JSON.stringify(guestLobby)).not.toContain('blocker');

    r.start(hostId, 0);
    const guestGame = r.viewFor(guestId, 1);
    expect(JSON.stringify(guestGame)).not.toContain('blocker');
    r.game!.endEarly();
    r.tick(2);
    expect(r.viewFor(guestId, 3).game!.players.find((p) => p.kind === 'bot')!.ai!.persona).toBe('blocker');
  });
});
