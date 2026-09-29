import type { Game, GameEvent } from '../game/engine.ts';
import { TIMING } from '../game/engine.ts';
import { createRng, type Rng } from '../game/rng.ts';
import { botDecision, type AiDecision } from './bot.ts';
import { llmDecision } from './llm.ts';
import type { Credentials } from './models.ts';

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
  private readonly unsubscribe: () => void;

  private readonly llm: typeof llmDecision;
  private readonly botDelay: boolean;
  private readonly credentialsFor: (playerId: string) => Credentials | undefined;

  constructor(
    private readonly game: Game,
    private readonly now: () => number,
    seed: number,
    opts: {
      llm?: typeof llmDecision;
      botDelay?: boolean;
      credentialsFor?: (playerId: string) => Credentials | undefined;
    } = {},
  ) {
    this.llm = opts.llm ?? llmDecision;
    this.botDelay = opts.botDelay ?? true;
    this.credentialsFor = opts.credentialsFor ?? (() => undefined);
    this.rng = createRng(seed);
    this.unsubscribe = game.on((e) => this.onEvent(e));
  }

  dispose() {
    this.seq++;
    this.unsubscribe();
  }

  private aiPlayers() {
    return this.game.players.filter((p) => p.kind !== 'human');
  }

  private onEvent(e: GameEvent) {
    if (e.type === 'auctionStart') this.startAuction(e.companyId);
    else if (e.type === 'bid') this.onBid(e.playerId);
    else if (e.type === 'auctionEnd') {
      this.seq++;
      this.decisions.clear();
      this.nextActAt.clear();
    }
  }

  private startAuction(companyId: string) {
    const seq = ++this.seq;
    const now = this.now();
    const timeoutMs = this.game.settings.bidSeconds * 1000 + TIMING.aiGraceMs - 1500;
    for (const p of this.aiPlayers()) {
      this.game.setAiPending(p.id, true, now);
      const persona = p.ai?.persona ?? 'balanced';
      const decide = async (): Promise<AiDecision> => {
        const credentials = this.credentialsFor(p.id);
        if (p.kind === 'llm' && p.ai?.model && credentials) {
          try {
            return await this.llm({
              game: this.game,
              player: p,
              companyId,
              persona,
              credentials,
              model: p.ai.model,
              timeoutMs,
            });
          } catch (err) {
            const why = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : 'error';
            const fb = botDecision(this.game, p, companyId, persona, this.rng, 'fallback');
            return { ...fb, reason: `[LLM ${why}, used backup brain] ${fb.reason}` };
          }
        }
        if (this.botDelay) await new Promise((r) => setTimeout(r, 250 + this.rng.next() * 900));
        return botDecision(this.game, p, companyId, persona, this.rng);
      };
      void decide().then((d) => this.apply(seq, p.id, companyId, d));
    }
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
      source: d.source,
      at: now,
    });
    if (this.game.settings.auctionMode === 'sealed') {
      this.game.submitSealed(playerId, d.maxBid >= this.game.minOpeningBid() ? d.maxBid : null, now);
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
    if (!a || this.game.phase !== 'auction' || this.game.settings.auctionMode !== 'open') return;
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
