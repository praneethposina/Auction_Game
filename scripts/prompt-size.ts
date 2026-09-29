// Prints the size of the LLM prompt at a few points in a bot-only game.
// Usage: npx tsx scripts/prompt-size.ts [players=6] [companies=30]
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { AiDirector } from '../server/ai/director.ts';
import { buildPrompt } from '../server/ai/llm.ts';
import { Game } from '../server/game/engine.ts';

const [players = 6, companies = 30] = process.argv.slice(2, 4).map(Number);
let clock = 0;
const game = new Game({
  settings: { ...DEFAULT_SETTINGS, companyCount: companies, maxPlayers: players },
  players: Array.from({ length: players }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i}`,
    kind: 'bot' as const,
    isHost: i === 0,
    ai: { persona: 'balanced' as const },
  })),
  seed: 42,
  now: 0,
});
const director = new AiDirector(game, () => clock, 7, { botDelay: false });
const samples: { lot: number; chars: number; tokens: number }[] = [];
let lastLot = '';
let lot = 0;
while (game.phase !== 'finished') {
  clock += 100;
  game.tick(clock);
  director.tick();
  await Promise.resolve();
  await Promise.resolve();
  const a = game.auction;
  if (a && a.companyId !== lastLot) {
    lastLot = a.companyId;
    lot++;
    const { system, user } = buildPrompt(game, game.player('p1')!, a.companyId, 'balanced');
    const chars = system.length + user.length;
    samples.push({ lot, chars, tokens: Math.round(chars / 4) });
    if (process.env.SHOW && lot === Number(process.env.SHOW)) console.log(`${system}\n---\n${user}`);
  }
}
director.dispose();
const avg = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
console.log(`${players} players, ${companies} companies, ${samples.length} lots`);
console.log(`first lot: ${samples[0].chars} chars (~${samples[0].tokens} tokens)`);
console.log(`middle lot: ${samples[samples.length >> 1].chars} chars (~${samples[samples.length >> 1].tokens} tokens)`);
console.log(`last lot: ${samples.at(-1)!.chars} chars (~${samples.at(-1)!.tokens} tokens)`);
console.log(`average: ${avg(samples.map((s) => s.chars))} chars (~${avg(samples.map((s) => s.tokens))} tokens), game total ~${samples.reduce((s, x) => s + x.tokens, 0)} tokens per LLM player`);
