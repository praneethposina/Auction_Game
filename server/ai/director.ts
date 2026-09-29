import type { Game, GameEvent } from '../game/engine.ts';
import { TIMING } from '../game/engine.ts';
import { createRng, type Rng } from '../game/rng.ts';
import type { GameLog } from '../gamelog.ts';
import { botDecision, type AiDecision } from './bot.ts';
import { LlmError, llmDecision, newTrace, type LlmTrace } from './llm.ts';
import type { Credentials } from './models.ts';

/** What the director needs to carry across a server restart. */
export interface DirectorSnapshot {
  rng: number;
  benched: [string, string][];
}

/**
 * Drives the AI players of one game.
 * Each AI makes ONE decision per company (its maximum price) as soon as the company
 * hits the block. LLMs are called once per company, which keeps free-tier usage low.
 * In open auctions the director then raises on the AI's behalf, with human-like pauses,
 * until its limit is reached. In sealed auctions the decision is submitted directly.
 */
export class AiDirector {
  private readonly rng: Rng;
  private readonly decisions = new Map<string, AiDecision>();
  private readonly nextActAt = new Map<string, number>();
  private seq = 0;
  /** When the current lot closed (wall clock), to tell how late a slow answer was. */
  private closedAt = new Map<number, number>();
  /** AI players whose provider can't serve them any more (no credits, bad key), with the reason. */
  private readonly benched = new Map<string, string>();
  /** LLM players whose (fixed) system prompt is already in the log. */
  private readonly loggedSystem = new Set<string>();
  private readonly unsubscribe: () => void;

  private readonly llm: typeof llmDecision;
  private readonly botDelay: boolean;
  private readonly credentialsFor: (playerId: string) => Credentials | undefined;
  private readonly log: GameLog | null;

  constructor(
    private readonly game: Game,
    private readonly now: () => number,
    seed: number,
    opts: {
      llm?: typeof llmDecision;
      botDelay?: boolean;
      credentialsFor?: (playerId: string) => Credentials | undefined;
      log?: GameLog | null;
      restore?: DirectorSnapshot;
    } = {},
  ) {
    this.llm = opts.llm ?? llmDecision;
    this.botDelay = opts.botDelay ?? true;
    this.credentialsFor = opts.credentialsFor ?? (() => undefined);
    this.log = opts.log ?? null;
    this.rng = createRng(opts.restore ? opts.restore.rng : seed);
    for (const [id, why] of opts.restore?.benched ?? []) this.benched.set(id, why);
    this.unsubscribe = game.on((e) => this.onEvent(e));
  }

  dispose() {
    this.seq++;
    this.unsubscribe();
  }

  snapshot(): DirectorSnapshot {
    return { rng: this.rng.state(), benched: [...this.benched] };
  }

  /**
   * After a restart mid-auction: rebuild the AI decisions already made for the lot on the block
   * (they are in the game's AI thoughts) and ask again for the ones that were still thinking.
   */
  resumeAuction() {
    const a = this.game.auction;
    if (!a || this.game.phase !== 'auction') return;
    const seq = ++this.seq;
    const now = this.now();
    const pending = [];
    for (const p of this.aiPlayers()) {
      const thought = this.game.aiThoughts.findLast((t) => t.playerId === p.id && t.companyId === a.companyId && t.round === this.game.round);
      if (!thought) {
        pending.push(p);
        continue;
      }
      if (this.game.settings.auctionMode === 'open') {
        this.decisions.set(p.id, { maxBid: thought.maxBid, reason: thought.reason, publicReason: thought.publicReason, source: thought.source });
        this.nextActAt.set(p.id, now + 500 + this.rng.next() * 900);
      } else if (!a.sealed.has(p.id)) {
        this.game.submitSealed(p.id, thought.maxBid >= this.game.minOpeningBid() ? thought.maxBid : null, now, true);
      }
    }
    this.decide(seq, a.companyId, pending);
  }

  private aiPlayers() {
    return this.game.players.filter((p) => p.kind !== 'human');
  }

  private onEvent(e: GameEvent) {
    if (e.type === 'auctionStart') this.decide(++this.seq, e.companyId, this.aiPlayers());
    else if (e.type === 'bid') this.onBid(e.playerId);
    else if (e.type === 'auctionEnd') {
      this.closedAt.set(this.seq, Date.now());
      if (this.closedAt.size > 4) this.closedAt.delete(this.closedAt.keys().next().value!);
      this.seq++;
      this.decisions.clear();
      this.nextActAt.clear();
    }
  }

  private decide(seq: number, companyId: string, players: Game['players']) {
    const now = this.now();
    // Long bid timers shouldn't mean waiting minutes on a stuck LLM request.
    const timeoutMs = Math.min(45000, this.game.settings.bidSeconds * 1000 + TIMING.aiGraceMs - 1500);
    const round = this.game.round;
    const lotName = this.game.company(companyId)?.def.name ?? companyId;
    for (const p of players) {
      this.game.setAiPending(p.id, true, now);
      const persona = p.ai?.persona ?? 'balanced';
      const label = p.ai?.modelLabel ?? p.ai?.model ?? p.name;
      const started = Date.now();
      const base = { player: p.name, lot: lotName, round };
      const withNote = (fb: AiDecision, note: string): AiDecision => ({
        ...fb,
        reason: `${note} ${fb.reason}`,
        publicReason: `${note} ${fb.publicReason}`,
      });

      const decide = async (): Promise<{ d: AiDecision; log?: (late: { late: boolean; afterCloseMs?: number }) => void }> => {
        const credentials = this.credentialsFor(p.id);
        const benched = this.benched.get(p.id);
        if (p.kind === 'llm' && benched) {
          const fb = botDecision(this.game, p, companyId, persona, this.rng, 'fallback');
          const d = withNote(fb, `[${benched}; the backup brain is playing for it]`);
          return {
            d,
            log: () =>
              this.log?.add('llm', 'warn', `${p.name}: not called (${benched}); backup brain bid`, {
                playerId: p.id,
                data: { ...base, provider: p.ai?.provider, model: p.ai?.model, outcome: 'benched' },
                secret: { maxBid: d.maxBid, reason: d.reason },
              }),
          };
        }
        if (p.kind === 'llm' && p.ai?.model && !credentials) {
          this.log?.add('llm', 'error', `${p.name}: no API key available on this server; backup brain bid`, {
            playerId: p.id,
            data: { ...base, provider: p.ai.provider, model: p.ai.model, outcome: 'no_key' },
          });
        }
        if (p.kind === 'llm' && p.ai?.model && credentials) {
          const trace = newTrace();
          const ai = p.ai;
          const logCall = (outcome: string, d: AiDecision, why?: string) => (late: { late: boolean; afterCloseMs?: number }) =>
            this.logLlm(p.id, trace, {
              ...base,
              ...late,
              label,
              provider: ai.provider,
              model: ai.model,
              outcome,
              why,
              ms: Date.now() - started,
              timeoutMs,
              decision: d,
            });
          try {
            const d = await this.llm({ game: this.game, player: p, companyId, persona, credentials, model: ai.model!, timeoutMs, trace });
            return { d, log: logCall('ok', d) };
          } catch (err) {
            const why =
              err instanceof Error
                ? err.name === 'TimeoutError' || err.name === 'AbortError'
                  ? 'took too long to answer'
                  : err.message
                : 'failed';
            const outcome = err instanceof LlmError ? err.code : err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'error';
            const fb = botDecision(this.game, p, companyId, persona, this.rng, 'fallback');
            if (err instanceof LlmError && err.fatal) {
              this.benched.set(p.id, `${label} ${why}`);
              const d = withNote(fb, `[${label} ${why}. It won't be called again this game; the backup brain plays for it]`);
              return { d, log: logCall(outcome, d, why) };
            }
            const d = withNote(fb, `[${label} ${why}; the backup brain bid instead]`);
            return { d, log: logCall(outcome, d, why) };
          }
        }
        if (this.botDelay) await new Promise((r) => setTimeout(r, 250 + this.rng.next() * 900));
        const d = botDecision(this.game, p, companyId, persona, this.rng);
        return {
          d,
          log: () =>
            this.log?.add('bot', 'info', `${p.name} decided in ${Date.now() - started}ms`, {
              playerId: p.id,
              data: { ...base, persona, ms: Date.now() - started },
              secret: { maxBid: d.maxBid, reason: d.reason },
            }),
        };
      };
      void decide().then(({ d, log }) => {
        const late = seq !== this.seq || this.game.auction?.companyId !== companyId;
        const closed = this.closedAt.get(seq);
        log?.({ late, afterCloseMs: late && closed ? Date.now() - closed : undefined });
        this.apply(seq, p.id, companyId, d);
      });
    }
  }

  private logLlm(
    playerId: string,
    trace: LlmTrace,
    info: {
      player: string;
      lot: string;
      round: number;
      label: string;
      provider?: string;
      model?: string;
      outcome: string;
      why?: string;
      ms: number;
      timeoutMs: number;
      late: boolean;
      afterCloseMs?: number;
      decision: AiDecision;
    },
  ) {
    if (!this.log) return;
    const { decision: d, label, why, ...rest } = info;
    const sum = (k: 'promptTokens' | 'outputTokens') =>
      trace.attempts.some((a) => a[k] !== undefined) ? trace.attempts.reduce((s, a) => s + (a[k] ?? 0), 0) : undefined;
    const promptTokens = sum('promptTokens');
    const outputTokens = sum('outputTokens');
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const tokens = promptTokens !== undefined ? ` (${promptTokens}→${outputTokens ?? '?'} tokens)` : '';
    const via =
      trace.parsedFrom === 'reasoning'
        ? ', read from its reasoning'
        : trace.parsedFrom === 'short_think'
          ? ', after a "think less" retry'
          : trace.parsedFrom === 'repair'
            ? ', after a JSON reminder'
            : '';
    const tries = trace.attempts.length > 1 ? ` after ${trace.attempts.length} requests` : '';
    let msg =
      info.outcome === 'ok'
        ? `${info.player} (${label}) answered in ${secs(info.ms)}${tokens}${via}`
        : `${info.player} (${label}) ${why}${tries} (${secs(info.ms)}); backup brain bid`;
    if (info.late) msg += `. Arrived ${info.afterCloseMs !== undefined ? `${secs(info.afterCloseMs)} ` : ''}after the lot closed, so it was not used`;
    if (trace.laneWaitMs > 1000) msg += `. Waited ${secs(trace.laneWaitMs)} for a free slot on the key`;
    const level = info.outcome === 'ok' && !info.late ? 'info' : info.outcome === 'no_credits' || info.outcome === 'bad_key' ? 'error' : 'warn';
    const first = !this.loggedSystem.has(playerId);
    this.loggedSystem.add(playerId);
    this.log.add('llm', level, msg, {
      playerId,
      data: {
        ...rest,
        laneWaitMs: trace.laneWaitMs,
        promptChars: trace.system.length + trace.user.length,
        promptTokens,
        outputTokens,
        parsedFrom: trace.parsedFrom,
        attempts: trace.attempts,
        ...(trace.withheldReason ? { reasonWithheld: true } : {}),
      },
      secret: {
        maxBid: d.maxBid,
        reason: d.reason,
        ...(first ? { system: trace.system } : {}),
        user: trace.user,
        answer: trace.answer,
        ...(trace.reasoningTail ? { reasoningTail: trace.reasoningTail } : {}),
      },
    });
  }

  private apply(seq: number, playerId: string, companyId: string, d: AiDecision) {
    if (seq !== this.seq || this.game.auction?.companyId !== companyId) return;
    const now = this.now();
    this.decisions.set(playerId, d);
    this.game.recordAiThought({
      playerId,
      companyId,
      round: this.game.round,
      maxBid: d.maxBid,
      reason: d.reason,
      publicReason: d.publicReason,
      source: d.source,
      at: now,
    });
    if (this.game.settings.auctionMode === 'sealed') {
      this.game.submitSealed(playerId, d.maxBid >= this.game.minOpeningBid() ? d.maxBid : null, now, true);
    } else {
      this.nextActAt.set(playerId, now + 200 + this.rng.next() * 1000);
    }
    this.game.setAiPending(playerId, false, now);
  }

  private onBid(bidderId: string) {
    const now = this.now();
    for (const pid of this.decisions.keys()) {
      if (pid === bidderId || this.nextActAt.has(pid)) continue;
      this.nextActAt.set(pid, now + 500 + this.rng.next() * 900);
    }
  }

  tick() {
    const a = this.game.auction;
    if (!a || this.game.paused || this.game.phase !== 'auction' || this.game.settings.auctionMode !== 'open') return;
    const now = this.now();
    for (const [pid, at] of [...this.nextActAt]) {
      if (at > now) continue;
      this.nextActAt.delete(pid);
      this.act(pid, now);
    }
  }

  private act(playerId: string, now: number) {
    const a = this.game.auction;
    const d = this.decisions.get(playerId);
    const p = this.game.player(playerId);
    if (!a || !d || !p || a.out.has(playerId) || a.highBidderId === playerId) return;
    const next = this.game.minNextBid();
    const limit = Math.min(d.maxBid, p.purse);
    if (limit < next) {
      this.game.declareOut(playerId, now);
      return;
    }
    const inc = this.game.minIncrement();
    let amount: number;
    if (a.highBid === null) {
      amount = Math.max(next, Math.round(limit * (0.2 + this.rng.next() * 0.35)));
    } else {
      const gap = limit - next;
      amount = next + Math.max(0, Math.round(gap * (0.2 + this.rng.next() * 0.4)));
    }
    amount = Math.min(limit, Math.ceil(amount / inc) * inc);
    this.game.placeBid(playerId, Math.max(next, amount), now);
  }
}
