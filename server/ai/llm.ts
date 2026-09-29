import { COMBO_BY_ID } from '../../shared/data/combos.ts';
import { SECTORS } from '../../shared/data/sectors.ts';
import { likelyRange, money, pct, TIER_LABEL, VALUATION_MULTIPLE } from '../../shared/economy.ts';
import { PERSONAS, WIN_CONDITION_LABEL, type Persona } from '../../shared/types.ts';
import type { EnginePlayer, Game } from '../game/engine.ts';
import { appraise } from './appraise.ts';
import type { AiDecision } from './bot.ts';
import { providerById, type Credentials } from './models.ts';

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
    'Your "reason" is read out to ALL players after the sale. Never reveal your private intel, sector heat, your cash, or the turnovers of companies you own; explain in general terms (synergies, news, timing, budget pacing).',
    'Reply with ONLY a JSON object and nothing else:',
    '{"max_bid": <integer, 0 to pass>, "reason": "<max 30 words>"}',
  ].join('\n');

  const expectedBuys = Math.max(1, Math.round(((game.upcomingCount() + 1) / game.players.length) * 10) / 10);
  const analystNotes = [
    a.heatNote,
    a.lossChance > 0.15 ? `${Math.round(a.lossChance * 100)}% chance it loses money in an average round` : null,
    a.denialNote ? `it ${a.denialNote}` : null,
    a.foresightNote,
  ].filter(Boolean);
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
- Naive average-case worth to you (payouts + end value, ignores strategy and competition): ~${money(a.value)}.${
    analystNotes.length ? `\n- Analyst notes: ${analystNotes.join('; ')}.` : ''
  }

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

// ── Answer parsing ──────────────────────────────────────────────
// Models answer in many shapes: clean JSON, JSON in code fences, JSON with single quotes or
// trailing commas, "$1.2B", or plain sentences like "My max bid is $720M". Be forgiving.

const BID_KEYS = ['max_bid', 'maxbid', 'max bid', 'maximum_bid', 'maximumbid', 'bid', 'max', 'amount', 'final_bid', 'price'];

/** Convert a number with an optional unit to the game's unit ($M). */
function toMillions(value: number, unit: string | undefined, startingBudget: number): number {
  const u = (unit ?? '').toLowerCase();
  let v = value;
  if (/^(b|bn|billion)$/.test(u)) v *= 1000;
  else if (/^(k|thousand)$/.test(u)) v /= 1000;
  // Raw dollars ("720000000") instead of millions.
  if (!u && v > startingBudget * 1000) v /= 1_000_000;
  return v;
}

function numberFrom(raw: unknown, startingBudget: number): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? toMillions(raw, undefined, startingBudget) : null;
  if (typeof raw !== 'string') return null;
  const m = raw.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*(billion|bn|b|million|mn|m|thousand|k)?\b/i);
  return m ? toMillions(Number(m[1]), m[2], startingBudget) : null;
}

/** Every balanced {...} block in the text, outermost first. */
function jsonBlocks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr: string | null = null;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        out.push(text.slice(i, j + 1));
        break;
      }
    }
  }
  return out;
}

function lenientJson(chunk: string): unknown {
  try {
    return JSON.parse(chunk);
  } catch {
    // fall through to repairs
  }
  let fixed = chunk
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  if (!fixed.includes('"')) fixed = fixed.replace(/'/g, '"');
  fixed = fixed
    .replace(/([{,]\s*)([A-Za-z_][\w ]*?)\s*:/g, '$1"$2":')
    .replace(/:\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?)/g, (_m, n: string) => `: ${n.replace(/,/g, '')}`)
    .replace(/:\s*\$\s*(\d)/g, ': $1');
  try {
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

function bidFromObject(obj: unknown, startingBudget: number): { bid: number; reason: string } | null {
  if (!obj || typeof obj !== 'object') return null;
  const entries = Object.entries(obj as Record<string, unknown>);
  const norm = (k: string) => k.toLowerCase().replace(/[-\s]+/g, '_');
  for (const key of BID_KEYS) {
    const hit = entries.find(([k]) => norm(k) === key.replace(/ /g, '_') || k.toLowerCase() === key);
    if (!hit) continue;
    const bid = numberFrom(hit[1], startingBudget);
    if (bid === null) continue;
    const reasonEntry = entries.find(([k]) => /reason|rationale|explanation|thought/i.test(k));
    return { bid, reason: reasonEntry ? String(reasonEntry[1]) : '' };
  }
  // Nested, e.g. {"decision": {"max_bid": 300}}
  for (const [, v] of entries) {
    const inner = bidFromObject(v, startingBudget);
    if (inner) return inner;
  }
  return null;
}

/** Strip reasoning blocks and code fences. An unclosed <think> means no final answer yet. */
function visibleAnswer(raw: string): string {
  let text = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const open = text.search(/<think(?:ing)?>/i);
  if (open >= 0) text = text.slice(0, open);
  return text.replace(/```(?:json)?/gi, '').trim();
}

export function parseDecision(
  raw: string,
  purse: number,
  startingBudget = 1000,
): { maxBid: number; reason: string } | null {
  const text = visibleAnswer(raw);
  if (!text) return null;
  const clamp = (bid: number) => Math.max(0, Math.min(purse, Math.floor(bid)));

  const blocks = jsonBlocks(text);
  for (const chunk of blocks.reverse()) {
    const hit = bidFromObject(lenientJson(chunk), startingBudget);
    if (hit) return { maxBid: clamp(hit.bid), reason: hit.reason.slice(0, 280) };
  }

  // Plain-text answers: take the last explicit bid statement.
  const re =
    /(?:max(?:imum)?[\s_-]*bid|final[\s_-]*bid|my[\s_-]*bid|bid[\s_-]*limit|will\s+bid|bid)[^\w$\n]{0,6}(?:(?:is|of|at|up\s+to|to)\b[^\w$\n]{0,4})?\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|mn|m|thousand|k)?\b/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (last) {
    const bid = toMillions(Number(last[1].replace(/,/g, '')), last[2], startingBudget);
    const reason = text.replace(/\s+/g, ' ').slice(0, 200);
    return { maxBid: clamp(bid), reason };
  }
  if (/\b(i\s+pass|pass\b|no\s+bid|not\s+bidding|skip\s+this)/i.test(text)) {
    return { maxBid: 0, reason: text.replace(/\s+/g, ' ').slice(0, 200) };
  }
  return null;
}

// ── Calling the model ───────────────────────────────────────────

/**
 * An LLM's reason is shown to every player. Models sometimes quote their private intel anyway,
 * so hold back any reason that mentions intel, sector heat, the player's cash, its own
 * companies' turnovers or numbers from its tips. The full text is revealed when the game ends.
 */
export function publicSafeReason(reason: string, game: Game, player: EnginePlayer): string | null {
  const text = reason.toLowerCase();
  if (/\b(intel|insider|tip|tips|tipped|private|secret|analyst|heat|leak|leaked)\b/.test(text)) return null;
  if (/\b(hot|cold|warm|cool|ice|icy|frozen|temperature)\b/.test(text)) return null;
  if (/next round'?s? (news|headline|event)|upcoming (news|headline)/.test(text)) return null;
  const numbers = [...text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(b|bn|billion|m|mn|million)?\b/g)].map((m) => {
    const v = Number(m[1].replace(/,/g, ''));
    return /^(b|bn|billion)$/.test(m[2] ?? '') ? v * 1000 : v;
  });
  const secrets = new Set<number>();
  for (const tip of player.intel) {
    for (const v of [tip.data?.low, tip.data?.high]) if (v !== undefined) secrets.add(v);
  }
  for (const h of player.holdings) secrets.add(game.company(h.companyId)!.turnover);
  for (const n of numbers) {
    if (secrets.has(n)) return null;
    if (player.purse > 0 && Math.abs(n - player.purse) <= player.purse * 0.02) return null;
  }
  return reason;
}

export class LlmError extends Error {
  /** The provider will keep failing for this key (no credits, bad key): stop calling it. */
  fatal = false;
}

/** Pull a readable message out of a provider error body (often JSON). */
function providerMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string | { message?: string }; message?: string };
    const msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message);
    if (msg) return msg.slice(0, 140);
  } catch {
    // not JSON
  }
  return body.replace(/\s+/g, ' ').slice(0, 140);
}

// At most a few requests in flight per provider key, so a table full of LLM players
// doesn't burst straight into the provider's per-minute rate limit.
const MAX_IN_FLIGHT = 3;
const lanes = new Map<string, { active: number; waiting: (() => void)[] }>();

async function acquireLane(key: string, deadline: number): Promise<() => void> {
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, (lane = { active: 0, waiting: [] }));
  const l = lane;
  if (l.active >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        l.waiting = l.waiting.filter((w) => w !== go);
        reject(Object.assign(new LlmError('was queued behind other AI players too long'), {}));
      }, Math.max(0, deadline - Date.now()));
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      l.waiting.push(go);
    });
  }
  l.active++;
  return () => {
    l.active--;
    const next = l.waiting.shift();
    if (next) next();
    if (l.active === 0 && l.waiting.length === 0) lanes.delete(key);
  };
}

/** Models/providers that rejected JSON mode, so we stop asking for it. */
const noJsonMode = new Set<string>();

interface ChatAnswer {
  content: string;
  reasoning: string;
  finish: string | null;
}

async function chat(
  base: string,
  key: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<ChatAnswer> {
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new LlmError(
      res.status === 429
        ? 'was rate limited by the provider'
        : res.status === 402
          ? `is out of credits (${providerMessage(text)})`
          : res.status === 401 || res.status === 403
            ? `had its API key rejected (HTTP ${res.status})`
            : `got an error from the provider (HTTP ${res.status}: ${providerMessage(text)})`,
    );
    err.fatal = res.status === 401 || res.status === 402 || res.status === 403;
    Object.assign(err, { status: res.status, body: text, retryAfter: Number(res.headers.get('retry-after')) || 0 });
    throw err;
  }
  const data = (await res.json()) as {
    choices?: {
      finish_reason?: string | null;
      message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
    }[];
  };
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '',
    finish: choice?.finish_reason ?? null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function llmDecision(opts: {
  game: Game;
  player: EnginePlayer;
  companyId: string;
  persona: Persona;
  credentials: Credentials;
  model: string;
  timeoutMs: number;
}): Promise<AiDecision> {
  const found = providerById(opts.credentials.provider);
  if (!found) throw new LlmError(`unknown provider ${opts.credentials.provider}`);
  const provider = found;
  const { baseUrl, apiKey } = opts.credentials;
  const deadline = Date.now() + opts.timeoutMs;
  const left = () => deadline - Date.now();
  const modelKey = `${provider.id}:${opts.model}`;
  const { system, user } = buildPrompt(opts.game, opts.player, opts.companyId, opts.persona);
  const startingBudget = opts.game.settings.startingBudget;
  const extra = provider.extraBody?.(opts.model) ?? {};

  const release = await acquireLane(`${baseUrl}|${apiKey}`, deadline);
  try {
    return await decideWithRetries();
  } finally {
    release();
  }

  async function decideWithRetries(): Promise<AiDecision> {
    const ask = async (messages: { role: string; content: string }[], maxTokens: number): Promise<ChatAnswer> => {
      const base = { model: opts.model, messages, temperature: 0.6, max_tokens: maxTokens, ...extra };
      const jsonMode = !noJsonMode.has(modelKey);
      let rateRetried = false;
      for (;;) {
        try {
          return await chat(
            baseUrl,
            apiKey,
            provider.extraHeaders ?? {},
            jsonMode && !noJsonMode.has(modelKey) ? { ...base, response_format: { type: 'json_object' } } : base,
            left(),
          );
        } catch (err) {
          const e = err as LlmError & { status?: number; retryAfter?: number };
          if (e.status === 400 && jsonMode && !noJsonMode.has(modelKey)) {
            noJsonMode.add(modelKey); // provider doesn't do JSON mode; ask again without it
            continue;
          }
          const wait = Math.min(4000, (e.retryAfter || 1.5) * 1000);
          if (e.status === 429 && !rateRetried && left() > wait + 4000) {
            rateRetried = true;
            await sleep(wait);
            continue;
          }
          throw err;
        }
      }
    };

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let answer = await ask(messages, 2048);
    let parsed = parseDecision(answer.content, opts.player.purse, startingBudget) ??
      parseDecision(answer.reasoning.slice(-2000), opts.player.purse, startingBudget);

    // Thinking models sometimes spend the whole budget reasoning and never answer.
    if (!parsed && !visibleAnswer(answer.content) && answer.finish === 'length' && left() > 6000) {
      answer = await ask(
        [{ role: 'system', content: `${system}\nDo not deliberate at length: output the JSON object right away.` }, messages[1]],
        4096,
      );
      parsed = parseDecision(answer.content, opts.player.purse, startingBudget);
    }

    // It answered, just not in a readable shape: ask it to restate as bare JSON.
    if (!parsed && visibleAnswer(answer.content) && left() > 4000) {
      const repair = await ask(
        [
          ...messages,
          { role: 'assistant', content: visibleAnswer(answer.content).slice(-1500) },
          { role: 'user', content: 'Restate your decision as ONLY this JSON, nothing else: {"max_bid": <integer>, "reason": "<one short sentence>"}' },
        ],
        300,
      ).catch(() => null);
      if (repair) parsed = parseDecision(repair.content, opts.player.purse, startingBudget);
    }

    if (!parsed) {
      const why = !visibleAnswer(answer.content)
        ? answer.finish === 'length'
          ? 'ran out of tokens while thinking'
          : 'returned an empty answer'
        : 'gave an unreadable answer';
      console.warn(
        `[llm] ${provider.id}/${opts.model} ${why} (finish=${answer.finish}): ${JSON.stringify(answer.content.slice(0, 300))}`,
      );
      throw new LlmError(why);
    }
    let maxBid = parsed.maxBid;
    if (maxBid > 0 && maxBid < opts.game.minOpeningBid()) maxBid = 0;
    const reason = parsed.reason || '(no reason given)';
    return {
      maxBid,
      reason,
      publicReason: publicSafeReason(reason, opts.game, opts.player) ?? '(Reasoning kept private until the game ends.)',
      source: 'llm',
    };
  }
}
