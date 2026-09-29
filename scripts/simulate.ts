// Plays many bot-only games with a simulated clock and prints balance statistics.
// Usage: npm run simulate -- [games=300] [players=5] [companies=20] [mode=open|sealed] [win=netWorth|roi|purse|portfolio]
// Each game seats a random mix of personalities, so win rates are per appearance.
import { COMPANY_BY_ID } from '../shared/data/companies.ts';
import { DEFAULT_SETTINGS, PERSONAS, type AuctionMode, type Persona, type WinCondition } from '../shared/types.ts';
import { AiDirector } from '../server/ai/director.ts';
import { Game } from '../server/game/engine.ts';
import { createRng } from '../server/game/rng.ts';

const [games = 300, players = 5, companies = 20] = process.argv.slice(2, 5).map(Number);
const mode = (process.argv[5] ?? 'open') as AuctionMode;
const winCondition = (process.argv[6] ?? 'netWorth') as WinCondition;
const all = Object.keys(PERSONAS) as Persona[];
const pick = createRng(424242);

const stats = new Map<Persona, { games: number; wins: number; rankSum: number; worth: number; bought: number }>();
for (const p of all) stats.set(p, { games: 0, wins: 0, rankSum: 0, worth: 0, bought: 0 });
const priceByTier: Record<string, number[]> = { mega: [], large: [], mid: [] };
const priceByRound: number[][] = [];
let unsold = 0;
let sold = 0;

for (let g = 0; g < games; g++) {
  let clock = 0;
  const seats = pick.shuffle(all).slice(0, players);
  const game = new Game({
    settings: { ...DEFAULT_SETTINGS, companyCount: companies, auctionMode: mode, winCondition, maxPlayers: players },
    players: seats.map((persona, i) => ({ id: `p${i}`, name: persona, kind: 'bot' as const, isHost: i === 0, ai: { persona } })),
    seed: 1000 + g,
    now: 0,
  });
  const director = new AiDirector(game, () => clock, 5000 + g, { botDelay: false });
  let guard = 0;
  while (game.phase !== 'finished' && guard++ < 400000) {
    clock += 100;
    game.tick(clock);
    director.tick();
    await Promise.resolve();
    await Promise.resolve();
  }
  director.dispose();
  for (const s of game.results!.standings) {
    const persona = game.player(s.playerId)!.ai!.persona;
    const st = stats.get(persona)!;
    st.games++;
    st.rankSum += s.rank;
    st.worth += s.netWorth;
    st.bought += s.holdings.length;
    if (s.rank === 1) st.wins++;
  }
  for (const c of game.companies) {
    if (c.status === 'sold') {
      sold++;
      priceByTier[COMPANY_BY_ID[c.def.id].tier].push(c.price!);
      (priceByRound[c.roundBought! - 1] ??= []).push(c.price!);
    } else unsold++;
  }
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
console.log(`\n${games} games · ${players} bots · ${companies} companies · ${mode} · win by ${winCondition}`);
console.log('Persona              games   win%   avg rank   avg net worth   companies/game');
for (const [p, s] of [...stats].sort((a, b) => b[1].wins / Math.max(1, b[1].games) - a[1].wins / Math.max(1, a[1].games))) {
  if (!s.games) continue;
  console.log(
    `${PERSONAS[p].label.padEnd(20)} ${String(s.games).padStart(5)}  ${((100 * s.wins) / s.games).toFixed(1).padStart(5)}   ${(s.rankSum / s.games).toFixed(2).padStart(8)}   ${String(Math.round(s.worth / s.games)).padStart(13)}   ${(s.bought / s.games).toFixed(1).padStart(14)}`,
  );
}
console.log(`Fair share of wins: ${(100 / players).toFixed(1)}%`);
console.log('Avg price by tier:', Object.fromEntries(Object.entries(priceByTier).map(([k, v]) => [k, avg(v)])));
console.log('Avg price by round:', priceByRound.map(avg));
console.log(`Sold ${sold}, unsold ${unsold} (${Math.round((100 * unsold) / Math.max(1, sold + unsold))}%)`);
