import { COMBO_BY_ID } from '../../shared/data/combos.ts';
import { SECTORS } from '../../shared/data/sectors.ts';
import { likelyRange, pct, VALUATION_MULTIPLE } from '../../shared/economy.ts';
import { PERSONAS, type Persona } from '../../shared/types.ts';
import type { EnginePlayer, Game } from '../game/engine.ts';
import { appraise } from './appraise.ts';
import type { AiDecision } from './bot.ts';
import { providerById, type Credentials } from './models.ts';

const WIN_EXPLAIN = {
  netWorth: 'highest final cash + company end value. Overpaying loses.',
  roi: 'highest (payouts received + company end value) / money spent. Buy bargains only; buying nothing scores 0.',
  purse: 'highest final cash. End value does NOT count, only payouts collected before the game ends.',
  portfolio: 'highest total company end value. Leftover cash is worthless: spend it all, wisely.',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Tip text without emoji or "Insider tip:" noise. */
const plainTip = (text: string) =>
  text
    .replace(/^Insider tip:\s*/i, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The prompt is split for size: a system message that never changes during the game (rules,
 * persona, answer format, so providers can cache it) and a small JSON object with only what
 * matters for this one decision. Everything is in $M.
 */
export function buildPrompt(game: Game, player: EnginePlayer, companyId: string, persona: Persona) {
  const s = game.settings;
  const c = game.company(companyId)!;
  const a = appraise(game, player, companyId);
  const range = likelyRange(c.def.tier, s.turnoverMin, s.turnoverMax);
  const event = game.currentEvent();
  const sector = SECTORS[c.def.sector];
  const nameOf = (id: string) => game.company(id)?.def.name ?? id;

  const system = [
    `You are "${player.name}", an AI bidder in a company-auction game. Style: ${PERSONAS[persona].label}: ${PERSONAS[persona].blurb}`,
    `Rules (money in $M): every company pays at the end of each round, including the round it is bought: turnover x (1 + synergy) x news demand${s.runningCosts ? ' - running cost x news cost' : ''}. Owning 2/3/4+ in one sector gives each +10/20/35%; named combos add more. At game end a company is worth ${VALUATION_MULTIPLE}x its net per round. Turnovers are hidden; only the owner learns them.`,
    `Win: ${WIN_EXPLAIN[s.winCondition]}`,
    s.auctionMode === 'open'
      ? 'Open auction: give your MAXIMUM price; an agent raises for you, so you usually pay just above the runner-up.'
      : 'Sealed first-price auction: one secret bid each, the highest wins and pays its bid. Shade below your value.',
    'Each turn you get the state as JSON. est = your turnover estimate [low, mid, high] using your intel. avg_value = rough average worth to you. intel = private true facts.',
    'Your "reason" is shown to ALL players: never mention your intel, sector heat, your cash or your companies\' turnovers.',
    'Reply with ONLY: {"max_bid": <integer, 0 = pass>, "reason": "<15 words max>"}',
  ].join('\n');

  const upcoming = game.companies.filter((x) => x.status === 'upcoming');
  const expectedBuys = Math.max(1, (upcoming.length + 1) / game.players.length);
  const lotCombos = game.activeComboIds.map((id) => COMBO_BY_ID[id]).filter((combo) => combo.members.includes(companyId));
  const related = new Set(lotCombos.flatMap((combo) => combo.members));
  const owned = (id: string) => game.company(id)?.ownerId ?? null;

  const later = upcoming.filter((x) => x.def.sector === c.def.sector || related.has(x.def.id));
  const nearby = new Set([companyId, ...later.map((x) => x.def.id)]);

  // Only tips that bear on this decision: this company, related ones still to come, its sector,
  // or next round's news.
  const intel = player.intel
    .filter(
      (t) =>
        t.companyIds.some((id) => nearby.has(id)) ||
        (t.kind === 'sectorHeat' && t.sectorId === c.def.sector) ||
        (t.kind === 'nextEvent' && t.round === game.round),
    )
    .map((t) => plainTip(t.text));

  const lot: Record<string, unknown> = {
    name: c.def.name,
    sector: sector.short,
    tier: c.def.tier,
    typical: [range.low, range.high],
    est: [a.estLow, a.estTurnover, a.estHigh],
  };
  if (s.runningCosts) lot.running_cost = c.runningCost;
  const effect: Record<string, number> = {};
  if (a.eventDemand !== 1) effect.demand = round2(a.eventDemand);
  if (s.runningCosts && a.eventCost !== 1) effect.cost = round2(a.eventCost);
  if (Object.keys(effect).length) lot.news_effect = effect;
  if (a.synergy > 0) lot.synergy_if_won = pct(a.synergy);
  if (a.newCombos.length) lot.completes = a.newCombos;
  const boost = Object.entries(a.uplift).map(([id, inc]) => `${nameOf(id)} ${pct(inc)}`);
  if (boost.length) lot.boosts = boost;
  lot.avg_value = Math.round(a.value);
  if (a.lossChance > 0.15) lot.loss_chance = pct(a.lossChance);

  const notes = [a.heatNote, a.denialNote ? `it ${a.denialNote}` : null, a.potentialNote, a.foresightNote].filter(Boolean);

  const rivals: Record<string, number> = {};
  for (const p of game.players) if (p.id !== player.id) rivals[p.name] = p.holdings.length;

  const combos = lotCombos.slice(0, 4).map((combo) => {
    const members = combo.members.filter((m) => game.company(m) && m !== companyId);
    const mine = members.filter((m) => owned(m) === player.id).map(nameOf);
    const theirs = members
      .filter((m) => owned(m) && owned(m) !== player.id)
      .map((m) => `${nameOf(m)} (${game.player(owned(m)!)!.name})`);
    const open = members.filter((m) => game.company(m)!.status === 'upcoming').map(nameOf);
    return {
      name: combo.name,
      bonus: combo.tiers.map((t) => `${t.need}:${pct(t.bonus)}`).join(' '),
      ...(combo.anchor ? { needs: nameOf(combo.anchor) } : {}),
      ...(mine.length ? { yours: mine } : {}),
      ...(theirs.length ? { rivals: theirs } : {}),
      ...(open.length ? { to_come: open } : {}),
    };
  });

  const sectorRivals = game.players
    .filter((p) => p.id !== player.id)
    .map((p) => [p.name, p.holdings.filter((h) => game.company(h.companyId)!.def.sector === c.def.sector).length] as const)
    .filter(([, n]) => n > 0);

  const state: Record<string, unknown> = {
    round: `${game.round}/${game.totalRounds}`,
    payouts_if_won: a.payoutsLeft,
    cash: player.purse,
    per_buy_budget: Math.round(player.purse / expectedBuys),
    min_bid: game.minOpeningBid(),
    lot,
  };
  if (event) state.news = event.headline;
  if (notes.length) state.notes = notes;
  if (intel.length) state.intel = intel;
  const holdings = game.holdingsView(player);
  if (holdings.length)
    state.mine = holdings.map((h) => `${nameOf(h.companyId)} (${SECTORS[game.company(h.companyId)!.def.sector].short}) turnover ${h.turnover}, net ${h.netPerRound}`);
  state.rivals_companies = rivals;
  if (sectorRivals.length) state[`rivals_in_${sector.short}`] = Object.fromEntries(sectorRivals);
  if (combos.length) state.combos = combos;
  state.to_come = later.length ? { count: upcoming.length, related: later.slice(0, 8).map((x) => x.def.name) } : upcoming.length;

  return { system, user: JSON.stringify(state) };
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
  // "Intel" the chip company is fine; "my intel says…" is not. Lowercase "intel" is almost
  // always the tip, capitalised it's usually the company, so check the original casing too.
  if (/\bintel\b/.test(reason)) return null;
  if (/\b(my|our|the|private|secret|insider|analyst'?s?)\s+(intel|tips?|info|information|intelligence)\b/.test(text)) return null;
  if (/\bintel\s+(says|said|suggests|shows|indicates|puts|tells|told|reveals|confirms|hints)\b/.test(text)) return null;
  if (/\b(insider|tipped|tip-off|a tip|private info|secret info|analyst|heat|leak|leaked)\b/.test(text)) return null;
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

/** Why a call failed, for the game log. */
export type LlmFailure =
  | 'timeout'
  | 'rate_limited'
  | 'no_credits'
  | 'bad_key'
  | 'http_error'
  | 'network'
  | 'queue_timeout'
  | 'empty'
  | 'out_of_tokens'
  | 'unreadable'
  | 'unknown_provider';

export class LlmError extends Error {
  /** The provider will keep failing for this key (no credits, bad key): stop calling it. */
  fatal = false;
  code: LlmFailure;
  constructor(message: string, code: LlmFailure) {
    super(message);
    this.code = code;
  }
}

/** One HTTP request to the provider. */
export interface LlmAttempt {
  step: 'ask' | 'no_json_mode' | 'rate_limit_retry' | 'short_think' | 'repair';
  ms: number;
  status?: number;
  finish?: string | null;
  promptTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  answerChars?: number;
  reasoningChars?: number;
  error?: string;
}

/** Everything about one decision, filled in as it happens (also when it fails), for the game log. */
export interface LlmTrace {
  system: string;
  user: string;
  laneWaitMs: number;
  attempts: LlmAttempt[];
  /** The model's last visible answer and the tail of its reasoning, trimmed. */
  answer?: string;
  reasoningTail?: string;
  parsedFrom?: 'answer' | 'reasoning' | 'short_think' | 'repair';
  withheldReason?: boolean;
}

export const newTrace = (): LlmTrace => ({ system: '', user: '', laneWaitMs: 0, attempts: [] });

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
        reject(new LlmError('was queued behind other AI players on the same key too long', 'queue_timeout'));
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

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

async function chat(
  base: string,
  key: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  attempt: LlmAttempt,
): Promise<ChatAnswer> {
  const started = Date.now();
  try {
    let res: Response;
    try {
      res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        attempt.error = `no answer within ${(Math.max(1000, timeoutMs) / 1000).toFixed(1)}s`;
        throw new LlmError('took too long to answer', 'timeout');
      }
      attempt.error = `network: ${e.message}`.slice(0, 160);
      throw new LlmError(`could not reach the provider (${e.message})`, 'network');
    }
    attempt.status = res.status;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      attempt.error = providerMessage(text);
      const code: LlmFailure =
        res.status === 429 ? 'rate_limited' : res.status === 402 ? 'no_credits' : res.status === 401 || res.status === 403 ? 'bad_key' : 'http_error';
      const err = new LlmError(
        code === 'rate_limited'
          ? 'was rate limited by the provider'
          : code === 'no_credits'
            ? `is out of credits (${providerMessage(text)})`
            : code === 'bad_key'
              ? `had its API key rejected (HTTP ${res.status})`
              : `got an error from the provider (HTTP ${res.status}: ${providerMessage(text)})`,
        code,
      );
      err.fatal = code === 'no_credits' || code === 'bad_key';
      Object.assign(err, { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 0 });
      throw err;
    }
    let data: {
      choices?: {
        finish_reason?: string | null;
        message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
      }[];
      usage?: ChatUsage;
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        attempt.error = 'answer was cut off by the time limit';
        throw new LlmError('took too long to answer', 'timeout');
      }
      attempt.error = 'response was not JSON';
      throw new LlmError('sent a response that is not valid JSON', 'http_error');
    }
    const choice = data.choices?.[0];
    const answer = {
      content: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '',
      finish: choice?.finish_reason ?? null,
    };
    attempt.finish = answer.finish;
    attempt.answerChars = answer.content.length;
    if (answer.reasoning) attempt.reasoningChars = answer.reasoning.length;
    if (data.usage) {
      attempt.promptTokens = data.usage.prompt_tokens;
      attempt.outputTokens = data.usage.completion_tokens;
      const r = data.usage.completion_tokens_details?.reasoning_tokens;
      if (r) attempt.reasoningTokens = r;
    }
    return answer;
  } finally {
    attempt.ms = Date.now() - started;
  }
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
  /** Filled in with timings, token counts and the raw answer, for the game log. */
  trace?: LlmTrace;
}): Promise<AiDecision> {
  const trace = opts.trace ?? newTrace();
  const found = providerById(opts.credentials.provider);
  if (!found) throw new LlmError(`unknown provider ${opts.credentials.provider}`, 'unknown_provider');
  const provider = found;
  const { baseUrl, apiKey } = opts.credentials;
  const deadline = Date.now() + opts.timeoutMs;
  const left = () => deadline - Date.now();
  const modelKey = `${provider.id}:${opts.model}`;
  const { system, user } = buildPrompt(opts.game, opts.player, opts.companyId, opts.persona);
  trace.system = system;
  trace.user = user;
  const startingBudget = opts.game.settings.startingBudget;
  const extra = provider.extraBody?.(opts.model) ?? {};

  const queued = Date.now();
  const release = await acquireLane(`${baseUrl}|${apiKey}`, deadline).finally(() => {
    trace.laneWaitMs = Date.now() - queued;
  });
  try {
    return await decideWithRetries();
  } finally {
    release();
  }

  async function decideWithRetries(): Promise<AiDecision> {
    const ask = async (
      step: LlmAttempt['step'],
      messages: { role: string; content: string }[],
      maxTokens: number,
    ): Promise<ChatAnswer> => {
      const base = { model: opts.model, messages, temperature: 0.6, max_tokens: maxTokens, ...extra };
      const jsonMode = !noJsonMode.has(modelKey);
      let rateRetried = false;
      for (;;) {
        const attempt: LlmAttempt = { step, ms: 0 };
        trace.attempts.push(attempt);
        try {
          const answer = await chat(
            baseUrl,
            apiKey,
            provider.extraHeaders ?? {},
            jsonMode && !noJsonMode.has(modelKey) ? { ...base, response_format: { type: 'json_object' } } : base,
            left(),
            attempt,
          );
          trace.answer = answer.content.slice(-1500);
          trace.reasoningTail = answer.reasoning ? answer.reasoning.slice(-600) : undefined;
          return answer;
        } catch (err) {
          const e = err as LlmError & { status?: number; retryAfter?: number };
          if (e.status === 400 && jsonMode && !noJsonMode.has(modelKey)) {
            noJsonMode.add(modelKey); // provider doesn't do JSON mode; ask again without it
            step = 'no_json_mode';
            continue;
          }
          const wait = Math.min(4000, (e.retryAfter || 1.5) * 1000);
          if (e.status === 429 && !rateRetried && left() > wait + 4000) {
            rateRetried = true;
            step = 'rate_limit_retry';
            await sleep(wait);
            continue;
          }
          throw err;
        }
      }
    };

    const purse = opts.player.purse;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let answer = await ask('ask', messages, 2048);
    let parsed = parseDecision(answer.content, purse, startingBudget);
    if (parsed) trace.parsedFrom = 'answer';
    else {
      parsed = parseDecision(answer.reasoning.slice(-2000), purse, startingBudget);
      if (parsed) trace.parsedFrom = 'reasoning';
    }

    // Thinking models sometimes spend the whole budget reasoning and never answer.
    if (!parsed && !visibleAnswer(answer.content) && answer.finish === 'length' && left() > 6000) {
      answer = await ask(
        'short_think',
        [{ role: 'system', content: `${system}\nDo not deliberate at length: output the JSON object right away.` }, messages[1]],
        4096,
      );
      parsed = parseDecision(answer.content, purse, startingBudget);
      if (parsed) trace.parsedFrom = 'short_think';
    }

    // It answered, just not in a readable shape: ask it to restate as bare JSON.
    if (!parsed && visibleAnswer(answer.content) && left() > 4000) {
      const unreadable = answer;
      const repair = await ask(
        'repair',
        [
          ...messages,
          { role: 'assistant', content: visibleAnswer(answer.content).slice(-1500) },
          { role: 'user', content: 'Restate your decision as ONLY this JSON, nothing else: {"max_bid": <integer>, "reason": "<one short sentence>"}' },
        ],
        300,
      ).catch(() => null);
      if (repair) parsed = parseDecision(repair.content, purse, startingBudget);
      if (parsed) trace.parsedFrom = 'repair';
      else {
        // Keep the original unreadable answer in the log, not the failed restatement.
        answer = unreadable;
        trace.answer = unreadable.content.slice(-1500);
      }
    }

    if (!parsed) {
      const [why, code]: [string, LlmFailure] = !visibleAnswer(answer.content)
        ? answer.finish === 'length'
          ? ['ran out of tokens while thinking', 'out_of_tokens']
          : ['returned an empty answer', 'empty']
        : ['gave an unreadable answer', 'unreadable'];
      throw new LlmError(why, code);
    }
    let maxBid = parsed.maxBid;
    if (maxBid > 0 && maxBid < opts.game.minOpeningBid()) maxBid = 0;
    const reason = parsed.reason || '(no reason given)';
    const safe = publicSafeReason(reason, opts.game, opts.player);
    trace.withheldReason = safe === null;
    return {
      maxBid,
      reason,
      publicReason: safe ?? '(Reasoning kept private until the game ends.)',
      source: 'llm',
    };
  }
}
