import { COMPANY_BY_ID, type CompanyDef } from '../../shared/data/companies.ts';
import { EVENT_BY_ID, type MarketEventDef } from '../../shared/data/events.ts';
import type { SectorId } from '../../shared/data/sectors.ts';
import {
  activeCombosForPool,
  companyValuation,
  computeSynergies,
  money,
  netPerRound,
  payoutLine,
  runningCostFor,
} from '../../shared/economy.ts';
import type {
  AiSpec,
  AiThought,
  AuctionView,
  BidEntry,
  FinalResults,
  GameSettings,
  GameView,
  HoldingView,
  IntelTip,
  LogEntry,
  PayoutView,
  Phase,
  PlayerKind,
  PrivatePlayer,
  PublicCompany,
  StandingView,
} from '../../shared/types.ts';
import { generateIntel } from './intel.ts';
import { createRng, type Rng } from './rng.ts';
import { drawEvents, rollSectorHeat, rollTurnover, selectPool } from './setup.ts';

export const TIMING = {
  /** Once everyone but the leader is out, close this quickly. */
  earlyCloseMs: 1200,
  /** How long an auction may be held open past its deadline for AI players still deciding. */
  aiGraceMs: 12000,
};

export interface PlayerInit {
  id: string;
  name: string;
  kind: PlayerKind;
  isHost: boolean;
  ai?: AiSpec;
}

interface Holding {
  companyId: string;
  price: number;
  roundBought: number;
}

export interface EnginePlayer extends PlayerInit {
  connected: boolean;
  purse: number;
  spent: number;
  income: number;
  holdings: Holding[];
  intel: IntelTip[];
  payouts: PayoutView[];
}

export interface EngineCompany {
  def: CompanyDef;
  turnover: number;
  runningCost: number;
  status: PublicCompany['status'];
  ownerId: string | null;
  price: number | null;
  roundBought: number | null;
}

interface AuctionState {
  companyId: string;
  startedAt: number;
  deadline: number;
  hardDeadline: number;
  highBid: number | null;
  highBidderId: string | null;
  history: BidEntry[];
  out: Set<string>;
  sealed: Map<string, { amount: number | null; at: number }>;
  aiPending: Set<string>;
}

interface SaleState {
  companyId: string;
  winnerId: string | null;
  price: number | null;
  at: number;
}

interface InternalLog extends LogEntry {
  to?: string;
}

export type GameEvent =
  | { type: 'auctionStart'; companyId: string }
  | { type: 'bid'; playerId: string; amount: number }
  | {
      type: 'auctionEnd';
      companyId: string;
      winnerId: string | null;
      price: number | null;
      bids: number;
      startedAt: number;
      /** AI players whose decision had not arrived when the lot closed. */
      stillThinking: string[];
    }
  | { type: 'roundEnd'; round: number }
  | { type: 'finished' };

/**
 * Everything needed to rebuild a game in another server process (e.g. after a deploy),
 * as plain JSON. Company and event definitions are stored by id.
 */
export interface GameSnapshot {
  v: 1;
  settings: GameSettings;
  players: EnginePlayer[];
  companies: (Omit<EngineCompany, 'def'> & { id: string })[];
  heat: Record<SectorId, number>;
  events: string[];
  totalRounds: number;
  slotsPerRound: number;
  activeComboIds: string[];
  phase: Phase;
  phaseEndsAt: number | null;
  paused: boolean;
  pausedAt: number | null;
  round: number;
  cursor: number;
  auction:
    | (Omit<AuctionState, 'out' | 'sealed' | 'aiPending'> & {
        out: string[];
        sealed: [string, { amount: number | null; at: number }][];
      })
    | null;
  lastSale: SaleState | null;
  aiThoughts: (AiThought & { publicReason: string })[];
  results: FinalResults | null;
  version: number;
  rng: number;
  log: InternalLog[];
  logSeq: number;
  intelSeq: number;
}

export type ActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): ActionResult => ({ ok: false, error });
const OK: ActionResult = { ok: true };

export class Game {
  readonly settings: GameSettings;
  readonly players: EnginePlayer[];
  readonly companies: EngineCompany[];
  readonly heat: Record<SectorId, number>;
  readonly events: MarketEventDef[];
  readonly totalRounds: number;
  readonly slotsPerRound: number;
  readonly activeComboIds: string[];

  phase: Phase = 'intro';
  phaseEndsAt: number | null;
  paused = false;
  pausedAt: number | null = null;
  round = 1;
  cursor = 0;
  auction: AuctionState | null = null;
  lastSale: SaleState | null = null;
  aiThoughts: (AiThought & { publicReason: string })[] = [];
  results: FinalResults | null = null;
  version = 0;

  private readonly rng: Rng;
  private readonly logEntries: InternalLog[] = [];
  private readonly listeners: ((e: GameEvent) => void)[] = [];
  private logSeq = 0;
  private intelSeq = 0;

  constructor(
    opts:
      | { settings: GameSettings; players: PlayerInit[]; seed: number; now: number }
      /** Rebuild a saved game. Time between `frozenAt` and `now` doesn't count against any timer. */
      | { snapshot: GameSnapshot; frozenAt: number; now: number },
  ) {
    if ('snapshot' in opts) {
      const snap = opts.snapshot;
      const shift = Math.max(0, opts.now - opts.frozenAt);
      this.settings = { ...snap.settings };
      this.rng = createRng(snap.rng);
      this.players = snap.players;
      this.companies = snap.companies.map(({ id, ...c }) => ({ ...c, def: COMPANY_BY_ID[id] }));
      this.heat = snap.heat;
      this.events = snap.events.map((id) => EVENT_BY_ID[id]);
      this.totalRounds = snap.totalRounds;
      this.slotsPerRound = snap.slotsPerRound;
      this.activeComboIds = snap.activeComboIds;
      this.phase = snap.phase;
      this.phaseEndsAt = snap.phaseEndsAt === null ? null : snap.phaseEndsAt + shift;
      this.paused = snap.paused;
      this.pausedAt = snap.pausedAt === null ? null : snap.pausedAt + shift;
      this.round = snap.round;
      this.cursor = snap.cursor;
      this.auction = snap.auction && {
        ...snap.auction,
        startedAt: snap.auction.startedAt + shift,
        deadline: snap.auction.deadline + shift,
        hardDeadline: snap.auction.hardDeadline + shift,
        out: new Set(snap.auction.out),
        sealed: new Map(snap.auction.sealed),
        // AI players still thinking when the old server stopped are asked again.
        aiPending: new Set(),
      };
      this.lastSale = snap.lastSale;
      this.aiThoughts = snap.aiThoughts;
      this.results = snap.results;
      this.version = snap.version + 1;
      this.logEntries = snap.log;
      this.logSeq = snap.logSeq;
      this.intelSeq = snap.intelSeq;
      return;
    }
    const { settings, now } = opts;
    this.settings = { ...settings };
    this.rng = createRng(opts.seed);
    this.players = opts.players.map((p) => ({
      ...p,
      connected: true,
      purse: settings.startingBudget,
      spent: 0,
      income: 0,
      holdings: [],
      intel: [],
      payouts: [],
    }));
    this.slotsPerRound = this.players.length;

    const poolIds = selectPool(this.rng, settings.companyCount);
    this.heat = rollSectorHeat(this.rng);
    this.companies = poolIds.map((id) => ({
      def: COMPANY_BY_ID[id],
      turnover: rollTurnover(this.rng, id, this.heat, settings.turnoverMin, settings.turnoverMax),
      runningCost: runningCostFor(COMPANY_BY_ID[id], settings.turnoverMin, settings.turnoverMax),
      status: 'upcoming',
      ownerId: null,
      price: null,
      roundBought: null,
    }));
    this.activeComboIds = activeCombosForPool(poolIds);
    this.totalRounds = Math.ceil(this.companies.length / this.slotsPerRound);
    this.events = settings.marketEvents ? drawEvents(this.rng, this.totalRounds) : [];

    for (const p of this.players) {
      for (let i = 0; i < settings.intelPerPlayer; i++) this.giveIntel(p, 'start');
    }

    this.phaseEndsAt = now + this.introMs();
    this.announceRound();
  }

  // ── Wiring ──────────────────────────────────────────────────

  on(listener: (e: GameEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(e: GameEvent) {
    for (const l of [...this.listeners]) l(e);
  }

  private touch() {
    this.version++;
  }

  private log(text: string, to?: string) {
    this.logEntries.push({ id: ++this.logSeq, at: Date.now(), text, to, private: to !== undefined });
    if (this.logEntries.length > 400) this.logEntries.splice(0, this.logEntries.length - 400);
  }

  player(id: string): EnginePlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  company(id: string): EngineCompany | undefined {
    return this.companies.find((c) => c.def.id === id);
  }

  currentEvent(): MarketEventDef | null {
    return this.events[this.round - 1] ?? null;
  }

  // ── Rules helpers ──────────────────────────────────────────

  minOpeningBid(): number {
    return Math.max(1, Math.round(this.settings.startingBudget / 100));
  }

  minIncrement(): number {
    return Math.max(1, Math.round(this.settings.startingBudget / 200));
  }

  minNextBid(): number {
    const a = this.auction;
    if (!a || a.highBid === null) return this.minOpeningBid();
    return a.highBid + this.minIncrement();
  }

  private bidMs(): number {
    return this.settings.bidSeconds * 1000;
  }

  /** Round intro (market news) duration, set by the host. */
  introMs(): number {
    return this.settings.introSeconds * 1000;
  }

  /** End-of-round payout summary duration, set by the host. */
  summaryMs(): number {
    return this.settings.summarySeconds * 1000;
  }

  /** Open bidding: minimum time left on the clock after any bid. */
  private resetMs(): number {
    return this.settings.bidResetSeconds * 1000;
  }

  /** How long the sale reveal shows. */
  soldMs(): number {
    return this.settings.soldSeconds * 1000;
  }

  roundEndIndex(round = this.round): number {
    return Math.min(round * this.slotsPerRound, this.companies.length);
  }

  slotInRound(): number {
    return this.cursor - (this.round - 1) * this.slotsPerRound + 1;
  }

  slotsInRound(): number {
    return this.roundEndIndex() - (this.round - 1) * this.slotsPerRound;
  }

  /** Payouts a company bought in the current round will still collect (including this round). */
  payoutsRemaining(): number {
    return this.totalRounds - this.round + 1;
  }

  upcomingCount(): number {
    return this.companies.filter((c) => c.status === 'upcoming').length;
  }

  // ── Clock ──────────────────────────────────────────────────

  tick(now: number) {
    if (this.paused) return;
    switch (this.phase) {
      case 'intro':
        if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) this.startAuction(now);
        break;
      case 'auction':
        this.checkAuctionClose(now);
        break;
      case 'sold':
        if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) this.afterSale(now);
        break;
      case 'summary':
        if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) this.afterSummary(now);
        break;
      case 'finished':
        break;
    }
  }

  /** Host shortcut to skip an intro, sale reveal or round summary. */
  skip(now: number): ActionResult {
    if (this.paused) return fail('Resume the game first.');
    if (this.phase === 'auction' || this.phase === 'finished') return fail('Nothing to skip right now.');
    this.phaseEndsAt = now;
    this.tick(now);
    return OK;
  }

  /** Freeze every countdown. Bids are refused until the host resumes. */
  pause(now: number): ActionResult {
    if (this.phase === 'finished') return fail('The game is over.');
    if (this.paused) return OK;
    this.paused = true;
    this.pausedAt = now;
    this.log('⏸ The host paused the game');
    this.touch();
    return OK;
  }

  resume(now: number): ActionResult {
    if (!this.paused || this.pausedAt === null) return OK;
    const shift = Math.max(0, now - this.pausedAt);
    if (this.phaseEndsAt !== null) this.phaseEndsAt += shift;
    if (this.auction) {
      this.auction.startedAt += shift;
      this.auction.deadline += shift;
      this.auction.hardDeadline += shift;
    }
    this.paused = false;
    this.pausedAt = null;
    this.log('▶ The host resumed the game');
    this.touch();
    this.maybeEarlyClose(now);
    return OK;
  }

  /** Host ends the game now: no more auctions or payouts, straight to final standings. */
  endEarly(): ActionResult {
    if (this.phase === 'finished') return fail('The game is already over.');
    this.auction = null;
    for (const c of this.companies) if (c.status !== 'sold') c.status = 'unsold';
    this.paused = false;
    this.pausedAt = null;
    this.log(`🛑 The host ended the game in round ${this.round}`);
    this.finish();
    return OK;
  }

  /** Mark the view as changed (e.g. host moved to another player). */
  touchView() {
    this.touch();
  }

  snapshot(): GameSnapshot {
    const a = this.auction;
    return structuredClone({
      v: 1,
      settings: this.settings,
      players: this.players,
      companies: this.companies.map(({ def, ...c }) => ({ ...c, id: def.id })),
      heat: this.heat,
      events: this.events.map((e) => e.id),
      totalRounds: this.totalRounds,
      slotsPerRound: this.slotsPerRound,
      activeComboIds: this.activeComboIds,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      paused: this.paused,
      pausedAt: this.pausedAt,
      round: this.round,
      cursor: this.cursor,
      auction: a && {
        companyId: a.companyId,
        startedAt: a.startedAt,
        deadline: a.deadline,
        hardDeadline: a.hardDeadline,
        highBid: a.highBid,
        highBidderId: a.highBidderId,
        history: a.history,
        out: [...a.out],
        sealed: [...a.sealed],
      },
      lastSale: this.lastSale,
      aiThoughts: this.aiThoughts,
      results: this.results,
      version: this.version,
      rng: this.rng.state(),
      log: this.logEntries,
      logSeq: this.logSeq,
      intelSeq: this.intelSeq,
    } satisfies GameSnapshot);
  }

  setConnected(playerId: string, connected: boolean) {
    const p = this.player(playerId);
    if (p && p.connected !== connected) {
      p.connected = connected;
      this.touch();
    }
  }

  // ── Auction flow ───────────────────────────────────────────

  private announceRound() {
    const ev = this.currentEvent();
    this.log(
      ev
        ? `Round ${this.round}/${this.totalRounds} · ${ev.icon} ${ev.headline}`
        : `Round ${this.round}/${this.totalRounds} begins`,
    );
    this.touch();
  }

  private startAuction(now: number) {
    const company = this.companies[this.cursor];
    company.status = 'auction';
    const deadline = now + this.bidMs();
    this.auction = {
      companyId: company.def.id,
      startedAt: now,
      deadline,
      hardDeadline: deadline + TIMING.aiGraceMs,
      highBid: null,
      highBidderId: null,
      history: [],
      out: new Set(),
      sealed: new Map(),
      aiPending: new Set(),
    };
    this.phase = 'auction';
    this.phaseEndsAt = deadline;
    this.touch();
    this.emit({ type: 'auctionStart', companyId: company.def.id });
  }

  placeBid(playerId: string, amount: number, now: number): ActionResult {
    const a = this.auction;
    const p = this.player(playerId);
    if (this.paused) return fail('The game is paused.');
    if (this.phase !== 'auction' || !a) return fail('No auction is running.');
    if (this.settings.auctionMode !== 'open') return fail('This game uses sealed bids.');
    if (!p) return fail('Unknown player.');
    if (!Number.isInteger(amount)) return fail('Bids must be whole numbers.');
    if (a.out.has(playerId)) return fail('You already dropped out of this auction.');
    if (a.highBidderId === playerId) return fail('You are already the highest bidder.');
    if (amount < this.minNextBid()) return fail(`Minimum bid is ${money(this.minNextBid())}.`);
    if (amount > p.purse) return fail('You cannot bid more than your purse.');

    a.highBid = amount;
    a.highBidderId = playerId;
    a.history.push({ playerId, amount, at: now });
    a.deadline = Math.max(a.deadline, now + this.resetMs());
    this.phaseEndsAt = a.deadline;
    this.touch();
    this.emit({ type: 'bid', playerId, amount });
    this.maybeEarlyClose(now);
    return OK;
  }

  declareOut(playerId: string, now: number): ActionResult {
    const a = this.auction;
    if (this.paused) return fail('The game is paused.');
    if (this.phase !== 'auction' || !a) return fail('No auction is running.');
    if (this.settings.auctionMode !== 'open') return fail('Use a sealed bid or pass.');
    if (!this.player(playerId)) return fail('Unknown player.');
    if (a.highBidderId === playerId) return fail('You are the highest bidder.');
    if (!a.out.has(playerId)) {
      a.out.add(playerId);
      this.touch();
    }
    this.maybeEarlyClose(now);
    return OK;
  }

  /** `fromAi` lets an AI decision that arrives during a pause still be recorded. */
  submitSealed(playerId: string, amount: number | null, now: number, fromAi = false): ActionResult {
    const a = this.auction;
    const p = this.player(playerId);
    if (this.paused && !fromAi) return fail('The game is paused.');
    if (this.phase !== 'auction' || !a) return fail('No auction is running.');
    if (this.settings.auctionMode !== 'sealed') return fail('This game uses open bidding.');
    if (!p) return fail('Unknown player.');
    if (a.sealed.has(playerId)) return fail('You already submitted for this company.');
    if (amount !== null) {
      if (!Number.isInteger(amount)) return fail('Bids must be whole numbers.');
      if (amount < this.minOpeningBid()) return fail(`Minimum bid is ${money(this.minOpeningBid())}.`);
      if (amount > p.purse) return fail('You cannot bid more than your purse.');
    }
    a.sealed.set(playerId, { amount, at: now });
    this.touch();
    this.maybeEarlyClose(now);
    return OK;
  }

  /** AI director marks players whose decision is still being computed; the auction waits for them (bounded). */
  setAiPending(playerId: string, pending: boolean, now: number) {
    const a = this.auction;
    if (!a) return;
    const had = a.aiPending.has(playerId);
    if (pending && !had) a.aiPending.add(playerId);
    else if (!pending && had) a.aiPending.delete(playerId);
    else return;
    this.touch();
    if (!pending) this.maybeEarlyClose(now);
  }

  recordAiThought(thought: AiThought & { publicReason?: string }) {
    this.aiThoughts.push({ ...thought, publicReason: thought.publicReason ?? thought.reason });
    this.touch();
  }

  private canAfford(p: EnginePlayer, amount: number): boolean {
    return p.purse >= amount;
  }

  private maybeEarlyClose(now: number) {
    const a = this.auction;
    if (!a || this.phase !== 'auction' || this.paused) return;
    if (a.aiPending.size > 0) return;
    if (this.settings.auctionMode === 'sealed') {
      const waiting = this.players.filter(
        (p) => !a.sealed.has(p.id) && this.canAfford(p, this.minOpeningBid()),
      );
      if (waiting.length === 0) this.closeAuction(now);
      return;
    }
    const next = this.minNextBid();
    const contenders = this.players.filter(
      (p) => p.id !== a.highBidderId && !a.out.has(p.id) && this.canAfford(p, next),
    );
    if (contenders.length > 0) return;
    if (a.highBidderId === null) {
      this.closeAuction(now);
      return;
    }
    const early = now + TIMING.earlyCloseMs;
    if (early < a.deadline) {
      a.deadline = early;
      this.phaseEndsAt = early;
      this.touch();
    }
  }

  private checkAuctionClose(now: number) {
    const a = this.auction;
    if (!a) return;
    if (now < a.deadline) return;
    if (a.aiPending.size > 0 && now < a.hardDeadline) return;
    this.closeAuction(now);
  }

  private closeAuction(now: number) {
    const a = this.auction!;
    const company = this.company(a.companyId)!;
    let winnerId: string | null = null;
    let price: number | null = null;

    if (this.settings.auctionMode === 'open') {
      winnerId = a.highBidderId;
      price = a.highBid;
    } else {
      const bids = [...a.sealed.entries()]
        .filter(([pid, b]) => b.amount !== null && this.canAfford(this.player(pid)!, b.amount))
        .map(([pid, b]) => ({ pid, amount: b.amount!, at: b.at, tie: this.rng.next() }));
      bids.sort((x, y) => y.amount - x.amount || x.at - y.at || x.tie - y.tie);
      if (bids.length > 0) {
        winnerId = bids[0].pid;
        price = bids[0].amount;
      }
    }

    if (winnerId !== null && price !== null) {
      const w = this.player(winnerId)!;
      w.purse -= price;
      w.spent += price;
      w.holdings.push({ companyId: company.def.id, price, roundBought: this.round });
      company.status = 'sold';
      company.ownerId = winnerId;
      company.price = price;
      company.roundBought = this.round;
      this.log(`🔨 ${company.def.name} sold to ${w.name} for ${money(price)}`);
      this.log(`🔓 ${company.def.name}'s turnover is ${money(company.turnover)} per round.`, winnerId);
    } else {
      company.status = 'unsold';
      this.log(`🚫 No bids: ${company.def.name} is withdrawn from the market`);
    }

    this.lastSale = { companyId: company.def.id, winnerId, price, at: now };
    this.auction = null;
    this.phase = 'sold';
    this.phaseEndsAt = now + this.soldMs();
    this.touch();
    this.emit({
      type: 'auctionEnd',
      companyId: company.def.id,
      winnerId,
      price,
      bids: this.settings.auctionMode === 'open' ? a.history.length : [...a.sealed.values()].filter((b) => b.amount !== null).length,
      startedAt: a.startedAt,
      stillThinking: [...a.aiPending],
    });
  }

  private afterSale(now: number) {
    this.cursor++;
    if (this.cursor < this.roundEndIndex()) {
      this.startAuction(now);
    } else {
      this.endRound(now);
    }
  }

  // ── Rounds & payouts ───────────────────────────────────────

  synergiesFor(p: EnginePlayer) {
    return computeSynergies(p.holdings.map((h) => h.companyId));
  }

  private endRound(now: number) {
    const event = this.currentEvent();
    for (const p of this.players) {
      const syn = this.synergiesFor(p);
      const lines = p.holdings.map((h) => {
        const c = this.company(h.companyId)!;
        return payoutLine(c.def.id, c.turnover, c.runningCost, syn[c.def.id].total, event, this.settings.runningCosts);
      });
      const total = lines.reduce((s, l) => s + l.net, 0);
      p.purse += total;
      p.income += total;
      const payout: PayoutView = { round: this.round, eventId: event?.id ?? null, lines, total };
      p.payouts.push(payout);
      if (lines.length > 0) {
        this.log(`💰 Round ${this.round} payout: ${total >= 0 ? '+' : ''}${money(total)}`, p.id);
      }
    }

    if (this.settings.catchUpIntel && this.round < this.totalRounds && this.players.length > 1) {
      const standings = this.computeStandings();
      const worst = standings[standings.length - 1].rank;
      const trailing = standings.filter((s) => s.rank === worst);
      if (trailing.length < standings.length) {
        const pick = this.rng.pick(trailing);
        const p = this.player(pick.playerId)!;
        const tip = this.giveIntel(p, 'catchup');
        if (tip) this.log('📡 You are trailing, so your analyst dug up a fresh tip.', p.id);
      }
    }

    this.phase = 'summary';
    this.phaseEndsAt = now + this.summaryMs();
    this.touch();
    this.emit({ type: 'roundEnd', round: this.round });
  }

  private afterSummary(now: number) {
    if (this.round >= this.totalRounds) {
      this.finish();
      return;
    }
    this.round++;
    this.phase = 'intro';
    this.phaseEndsAt = now + this.introMs();
    this.announceRound();
  }

  private finish() {
    this.phase = 'finished';
    this.phaseEndsAt = null;
    this.results = {
      winCondition: this.settings.winCondition,
      standings: this.computeStandings(),
      sectorHeat: { ...this.heat },
      unsold: this.companies
        .filter((c) => c.status !== 'sold')
        .map((c) => ({ companyId: c.def.id, turnover: c.turnover })),
    };
    const top = this.results.standings[0];
    if (top) this.log(`🏆 ${this.player(top.playerId)!.name} wins!`);
    this.touch();
    this.emit({ type: 'finished' });
  }

  private giveIntel(p: EnginePlayer, source: 'start' | 'catchup'): IntelTip | null {
    const tip = generateIntel(
      {
        rng: this.rng,
        turnoverMin: this.settings.turnoverMin,
        turnoverMax: this.settings.turnoverMax,
        pool: this.companies.map((c) => ({ id: c.def.id, turnover: c.turnover, status: c.status })),
        heat: this.heat,
        events: this.events,
        round: this.round,
        totalRounds: this.totalRounds,
      },
      p.intel,
      source,
      `intel-${++this.intelSeq}`,
    );
    if (tip) {
      p.intel.push(tip);
      this.touch();
    }
    return tip;
  }

  // ── Scoring ────────────────────────────────────────────────

  holdingsView(p: EnginePlayer): HoldingView[] {
    const syn = this.synergiesFor(p);
    return p.holdings.map((h) => {
      const c = this.company(h.companyId)!;
      const s = syn[h.companyId];
      return {
        companyId: h.companyId,
        price: h.price,
        roundBought: h.roundBought,
        turnover: c.turnover,
        runningCost: c.runningCost,
        synergy: s,
        netPerRound: netPerRound(c.turnover, c.runningCost, s.total, this.settings.runningCosts),
        valuation: companyValuation(c.turnover, c.runningCost, s.total, this.settings.runningCosts),
      };
    });
  }

  computeStandings(): StandingView[] {
    const rows = this.players.map((p) => {
      const holdings = this.holdingsView(p);
      const portfolioValue = holdings.reduce((s, h) => s + h.valuation, 0);
      const netWorth = p.purse + portfolioValue;
      const roi = p.spent > 0 ? (p.income + portfolioValue) / p.spent : 0;
      const metric =
        this.settings.winCondition === 'netWorth'
          ? netWorth
          : this.settings.winCondition === 'roi'
            ? roi
            : this.settings.winCondition === 'purse'
              ? p.purse
              : portfolioValue;
      return {
        playerId: p.id,
        rank: 0,
        metric,
        purse: p.purse,
        portfolioValue,
        netWorth,
        roi,
        spent: p.spent,
        income: p.income,
        holdings,
      };
    });
    rows.sort((a, b) => b.metric - a.metric || b.netWorth - a.netWorth);
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      r.rank = prev && prev.metric === r.metric && prev.netWorth === r.netWorth ? prev.rank : i + 1;
    });
    return rows;
  }

  // ── Views ──────────────────────────────────────────────────

  viewFor(playerId: string | null, now: number): GameView {
    const me = playerId ? this.player(playerId) : undefined;
    const finished = this.phase === 'finished';
    const a = this.auction;

    const companies: PublicCompany[] = this.companies.map((c) => ({
      id: c.def.id,
      name: c.def.name,
      sector: c.def.sector,
      tier: c.def.tier,
      hq: c.def.hq,
      tagline: c.def.tagline,
      runningCost: c.runningCost,
      status: c.status,
      ownerId: c.ownerId,
      price: c.price,
      roundBought: c.roundBought,
    }));

    let auction: AuctionView | null = null;
    if (a) {
      const mine = me ? a.sealed.get(me.id) : undefined;
      auction = {
        companyId: a.companyId,
        mode: this.settings.auctionMode,
        startedAt: a.startedAt,
        deadline: a.deadline,
        highBid: a.highBid,
        highBidderId: a.highBidderId,
        history: a.history.slice(-30),
        outIds: [...a.out],
        sealedSubmittedIds: [...a.sealed.keys()],
        myBid: mine ? mine.amount : undefined,
        minNextBid: this.minNextBid(),
        aiThinkingIds: [...a.aiPending],
      };
    }

    let privateMe: PrivatePlayer | null = null;
    if (me) {
      privateMe = {
        id: me.id,
        purse: me.purse,
        spent: me.spent,
        income: me.income,
        holdings: this.holdingsView(me),
        intel: me.intel,
        lastPayout: me.payouts[me.payouts.length - 1] ?? null,
      };
    }

    const sale = this.lastSale;
    const lastSale = sale
      ? {
          companyId: sale.companyId,
          winnerId: sale.winnerId,
          price: sale.price,
          turnover:
            finished || (me && sale.winnerId === me.id) ? this.company(sale.companyId)!.turnover : undefined,
          at: sale.at,
        }
      : null;

    const settled = new Set(this.companies.filter((c) => c.status === 'sold' || c.status === 'unsold').map((c) => c.def.id));
    // During the game only the public reason is shown; full reasoning (which may cite private
    // intel) is revealed once the game is over.
    const aiThoughts: AiThought[] =
      finished || this.settings.aiReasoning === 'live'
        ? this.aiThoughts
            .filter((t) => finished || settled.has(t.companyId))
            .map(({ publicReason, ...t }) => ({ ...t, reason: finished ? t.reason : publicReason }))
        : [];

    const event = this.currentEvent();

    return {
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      paused: this.paused,
      pausedAt: this.pausedAt,
      serverNow: now,
      round: this.round,
      totalRounds: this.totalRounds,
      slot: Math.min(this.slotInRound(), this.slotsInRound()),
      slotsInRound: this.slotsInRound(),
      settings: this.settings,
      event: event ? { id: event.id, round: this.round } : null,
      companies,
      activeComboIds: this.activeComboIds,
      auction,
      lastSale,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        isHost: p.isHost,
        connected: p.connected,
        ai: p.ai,
        companyIds: p.holdings.map((h) => h.companyId),
      })),
      me: privateMe,
      log: this.logEntries
        .filter((l) => !l.to || l.to === playerId)
        .slice(-60)
        .map(({ to: _to, ...rest }) => rest),
      aiThoughts,
      results: this.results,
    };
  }
}
