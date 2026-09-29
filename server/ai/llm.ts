import { COMBO_BY_ID } from '../../shared/data/combos.ts';
import { SECTORS } from '../../shared/data/sectors.ts';
import { likelyRange, money, pct, TIER_LABEL, VALUATION_MULTIPLE } from '../../shared/economy.ts';
import { PERSONAS, WIN_CONDITION_LABEL, type Persona } from '../../shared/types.ts';
import type { EnginePlayer, Game } from '../game/engine.ts';
import { appraise } from './appraise.ts';
import type { AiDecision } from './bot.ts';
import { providerById } from './models.ts';

const WIN_EXPLAIN = {
  netWorth: 'Highest final cash + end-of-game company value wins. Every dollar overpaid is a dollar lost.',
  roi: 'Highest (all payouts received + end-of-game company value) ÷ total money spent wins. Only buy bargains; buying nothing scores 0.',
  purse: 'Highest cash at the end wins. Company value at the end does NOT count, only the payouts it earns before the game ends.',
  portfolio: 'Highest total end-of-game company value wins. Leftover cash is worthless, so spend it all wisely.',
};

export function buildPrompt(game: Game, player: EnginePlayer, companyId: string, persona: Persona) {
  const s = game.settings;
  const c = game.company(companyId)!;
  const a = appraise(game, player, companyId);
  const range = likelyRange(c.def.tier, s.turnoverMin, s.turnoverMax);
  const event = game.currentEvent();
  const sector = SECTORS[c.def.sector];
  const nameOf = (id: string) => game.company(id)?.def.name ?? id;
  const ownerOf = (id: string) => {
    const co = game.company(id);
    if (!co) return 'not in this game';
    if (co.ownerId === player.id) return 'you';
    if (co.ownerId) return game.player(co.ownerId)!.name;
    if (co.status === 'unsold') return 'withdrawn';
    return co.def.id === companyId ? 'on the block' : 'upcoming';
  };

  const system = [
    `You are "${player.name}", an AI player in a fast multiplayer company-auction game.`,
    `Persona: ${PERSONAS[persona].label}. ${PERSONAS[persona].blurb}`,
    'Think like a sharp investor, use your private intel, and be decisive.',
    'Reply with ONLY a JSON object and nothing else:',
    '{"max_bid": <integer, 0 to pass>, "reason": "<max 30 words>"}',
  ].join('\n');

  const expectedBuys = Math.max(1, Math.round(((game.upcomingCount() + 1) / game.players.length) * 10) / 10);
  const holdings = game.holdingsView(player);
  const portfolio =
    holdings.length === 0
      ? '- (none yet)'
      : holdings
          .map(
            (h) =>
              `- ${nameOf(h.companyId)} (${SECTORS[game.company(h.companyId)!.def.sector].short}): turnover ${money(h.turnover)}, net ${money(h.netPerRound)}/round, synergy ${pct(h.synergy.total)}`,
          )
          .join('\n');

  const intel = player.intel.length === 0 ? '- (none)' : player.intel.map((t) => `- ${t.text}`).join('\n');

  const opponents = game.players
    .filter((p) => p.id !== player.id)
    .map((p) => `- ${p.name}: ${p.holdings.length ? p.holdings.map((h) => nameOf(h.companyId)).join(', ') : 'nothing yet'}`)
    .join('\n');

  const upcoming = game.companies
    .filter((x) => x.status === 'upcoming')
    .map((x) => `${x.def.name} (${SECTORS[x.def.sector].short}, ${TIER_LABEL[x.def.tier]})`)
    .join('; ');

  const combos = game.activeComboIds
    .map((id) => COMBO_BY_ID[id])
    .filter((combo) => combo.members.includes(companyId) || combo.members.some((m) => ownerOf(m) === 'you'))
    .slice(0, 8)
    .map((combo) => {
      const tiers = combo.tiers.map((t) => `${t.need}→${pct(t.bonus)}`).join(', ');
      const members = combo.members
        .filter((m) => game.company(m))
        .map((m) => `${nameOf(m)} [${ownerOf(m)}]`)
        .join(', ');
      return `- ${combo.name} (${tiers}${combo.anchor ? `, must include ${nameOf(combo.anchor)}` : ''}): ${members}`;
    })
    .join('\n');

  const auctionRule =
    s.auctionMode === 'open'
      ? 'Open ascending auction. Give your MAXIMUM price: an agent raises for you in steps up to that limit, so you usually pay just above the runner-up.'
      : 'Sealed-bid, first-price: everyone bids once in secret, the highest bid wins and pays exactly its bid. Shade your bid below your true value.';

  const synergyLine =
    a.synergy > 0
      ? `If you win: synergy ${pct(a.synergy)} on it (you would own ${a.sectorCountAfter} ${sector.name} companies${a.newCombos.length ? `; activates ${a.newCombos.join(', ')}` : ''}).`
      : 'If you win: no synergy with your current portfolio.';
  const upliftLine = Object.keys(a.uplift).length
    ? `It would also boost: ${Object.entries(a.uplift)
        .map(([id, inc]) => `${nameOf(id)} ${pct(inc)}`)
        .join(', ')}.`
    : '';

  const user = `RULES
- Each company has a hidden turnover per round; only its buyer learns it.
- At the end of EVERY round (including the round of purchase) each company pays: turnover × (1 + synergy) × news demand multiplier${s.runningCosts ? ' − running cost × news cost multiplier' : ''}.
- Owning 2/3/4+ companies in one sector gives each +10%/+20%/+35%. Named combos add more.
- At game end each company is worth ${VALUATION_MULTIPLE}× its normal net turnover per round.
- WIN CONDITION: ${WIN_CONDITION_LABEL[s.winCondition]}. ${WIN_EXPLAIN[s.winCondition]}
- ${auctionRule} Minimum bid ${money(game.minOpeningBid())}.

SITUATION
- Round ${game.round} of ${game.totalRounds}. This company collects ${a.payoutsLeft} payout(s) if bought now.
- Your cash: ${money(player.purse)}. ${game.upcomingCount()} more companies after this one. ${game.players.length} players.
- Budget pace: expect to win about ${expectedBuys} of the remaining companies, i.e. roughly ${money(player.purse / expectedBuys)} per company if spread evenly (payouts will add cash as you go).
${event ? `- News this round: ${event.icon} ${event.headline}. ${event.story}\n- News effect on this company this round: demand ×${a.eventDemand.toFixed(2)}, costs ×${a.eventCost.toFixed(2)}.` : '- No market news this round.'}

ON THE BLOCK: ${c.def.name} (${sector.name}, ${TIER_LABEL[c.def.tier]} tier, HQ ${c.def.hq}). ${c.def.tagline}.
- ${TIER_LABEL[c.def.tier]}-tier turnover is usually ${money(range.low)}–${money(range.high)} per round (avg ${money(range.mean)}).
- Your estimate using your intel: ~${money(a.estTurnover)} (likely ${money(a.estLow)}–${money(a.estHigh)}).${s.runningCosts ? `\n- Running cost: ${money(c.runningCost)} per round.` : ''}
- ${synergyLine} ${upliftLine}
- Naive average-case worth to you (payouts + end value, ignores strategy and competition): ~${money(a.value)}.

YOUR PORTFOLIO
${portfolio}

YOUR PRIVATE INTEL (true facts only you know)
${intel}

OPPONENTS (their cash and turnovers are hidden)
${opponents}

RELEVANT COMBOS
${combos || '- (none)'}

STILL TO COME: ${upcoming || '(nothing, this is the last company)'}

What is your maximum bid for ${c.def.name}? Reply with JSON only.`;

  return { system, user };
}

export function parseDecision(raw: string, purse: number): { maxBid: number; reason: string } | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const candidates = text.match(/\{[^{}]*\}/g) ?? [];
  for (const chunk of candidates.reverse()) {
    try {
      const obj = JSON.parse(chunk) as Record<string, unknown>;
      const rawBid = obj.max_bid ?? obj.maxBid ?? obj.bid ?? obj.max;
      const bid = typeof rawBid === 'string' ? Number(rawBid.replace(/[^\d.]/g, '')) : Number(rawBid);
      if (!Number.isFinite(bid)) continue;
      return {
        maxBid: Math.max(0, Math.min(purse, Math.floor(bid))),
        reason: String(obj.reason ?? obj.reasoning ?? '').slice(0, 280),
      };
    } catch {
      // try the next candidate
    }
  }
  const m = text.match(/max_?bid"?\s*[:=]\s*\$?\s*([\d,]+)/i);
  if (m) {
    const bid = Number(m[1].replace(/,/g, ''));
    return { maxBid: Math.max(0, Math.min(purse, Math.floor(bid))), reason: '' };
  }
  return null;
}

export class LlmError extends Error {}

export async function llmDecision(opts: {
  game: Game;
  player: EnginePlayer;
  companyId: string;
  persona: Persona;
  provider: string;
  model: string;
  timeoutMs: number;
}): Promise<AiDecision> {
  const provider = providerById(opts.provider);
  const base = provider?.baseUrl();
  const key = provider?.apiKey();
  if (!provider || !base || !key) throw new LlmError(`${opts.provider} is not configured`);

  const { system, user } = buildPrompt(opts.game, opts.player, opts.companyId, opts.persona);
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...(provider.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
      max_tokens: 1500,
      ...(provider.extraBody?.(opts.model) ?? {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmError(res.status === 429 ? 'rate limited' : `HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; reasoning?: string; reasoning_content?: string } }[];
  };
  const msg = data.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content || msg?.reasoning || '';
  const parsed = parseDecision(content, opts.player.purse);
  if (!parsed) throw new LlmError('unreadable answer');
  let maxBid = parsed.maxBid;
  if (maxBid > 0 && maxBid < opts.game.minOpeningBid()) maxBid = 0;
  return { maxBid, reason: parsed.reason || '(no reason given)', source: 'llm' };
}
