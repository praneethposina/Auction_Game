// Plays many bot-only games with a simulated clock and prints balance statistics.
// Usage: npm run simulate -- [games=200] [players=5] [companies=20] [mode=open|sealed]
import { COMPANY_BY_ID } from '../shared/data/companies.ts';
import { DEFAULT_SETTINGS, type AuctionMode, type Persona } from '../shared/types.ts';
import { AiDirector } from '../server/ai/director.ts';
import { Game } from '../server/game/engine.ts';

const [games = 200, players = 5, companies = 20] = process.argv.slice(2, 5).map(Number);
const mode = (process.argv[5] ?? 'open') as AuctionMode;
const personas: Persona[] = ['balanced', 'tycoon', 'value', 'synergy', 'gambler'];

const wins: Record<string, number> = {};
const priceByTier: Record<string, number[]> = { mega: [], large: [], mid: [] };
const priceByRound: number[][] = [];
let unsold = 0;
let sold = 0;
const finalNetWorth: number[] = [];
const spentShare: number[] = [];

for (let g = 0; g < games; g++) {
  let clock = 0;
  const game = new Game({
    settings: { ...DEFAULT_SETTINGS, companyCount: companies, auctionMode: mode, maxPlayers: players },
    players: Array.from({ length: players }, (_, i) => ({
      id: `p${i}`,
      name: personas[i % personas.length],
      kind: 'bot' as const,
      isHost: i === 0,
      ai: { persona: personas[i % personas.length] },
    })),
    seed: 1000 + g,
    now: 0,
  });
  const director = new AiDirector(game, () => clock, 5000 + g, { botDelay: false });
  let guard = 0;
  while (game.phase !== 'finished' && guard++ < 200000) {
    clock += 100;
    game.tick(clock);
    director.tick();
    await Promise.resolve();
    await Promise.resolve();
  }
  director.dispose();
  const r = game.results!;
  wins[game.player(r.standings[0].playerId)!.name] = (wins[game.player(r.standings[0].playerId)!.name] ?? 0) + 1;
  for (const c of game.companies) {
    if (c.status === 'sold') {
      sold++;
      priceByTier[COMPANY_BY_ID[c.def.id].tier].push(c.price!);
      (priceByRound[c.roundBought! - 1] ??= []).push(c.price!);
    } else unsold++;
  }
  for (const s of r.standings) {
    finalNetWorth.push(s.netWorth);
    spentShare.push(s.spent / DEFAULT_SETTINGS.startingBudget);
  }
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
console.log(`\n${games} games · ${players} bots · ${companies} companies · ${mode}`);
console.log('Wins by persona:', wins);
console.log('Avg price by tier:', Object.fromEntries(Object.entries(priceByTier).map(([k, v]) => [k, avg(v)])));
console.log('Avg price by round:', priceByRound.map(avg));
console.log(`Sold ${sold}, unsold ${unsold} (${Math.round((100 * unsold) / (sold + unsold))}%)`);
console.log('Avg final net worth:', avg(finalNetWorth), '| avg spent / budget:', (spentShare.reduce((a, b) => a + b, 0) / spentShare.length).toFixed(2));
