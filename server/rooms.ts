import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  PERSONAS,
  type AiSpec,
  type GameSettings,
  type LobbyPlayer,
  type PlayerKind,
  type PublicAiSpec,
  type RoomView,
} from '../shared/types.ts';
import { COMPANY_BY_ID } from '../shared/data/companies.ts';
import { money } from '../shared/economy.ts';
import { AiDirector, type DirectorSnapshot } from './ai/director.ts';
import { providerById, type Credentials } from './ai/models.ts';
import { Game, type GameEvent, type GameSnapshot } from './game/engine.ts';
import { randomSeed } from './game/rng.ts';
import { GameLog, type LogWriter } from './gamelog.ts';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOBBY_DROP_MS = 2 * 60 * 1000;
const ROOM_IDLE_MS = 30 * 60 * 1000;

const BOT_NAMES = [
  'Warren Bot',
  'Cathie Circuit',
  'Gordon Gekkobot',
  'Charlie Mungerbot',
  'Ada Ledger',
  'Rex Ticker',
  'Penny Stock',
  'Bull Byte',
  'Bearly Legal',
  'Dee Fi',
  'Quinn Quant',
  'Hedge Hog',
  'Ivy Index',
  'Moe Mentum',
  'Rich Reserve',
  'Val U. Hunter',
  'Sal Sniper',
  'Blocky Balboa',
  'Bluey Chip',
  'Midas Cap',
];

export interface RoomPlayer extends Omit<LobbyPlayer, 'ai'> {
  ai?: AiSpec;
  token: string;
  sockets: Set<string>;
  disconnectedAt: number | null;
}

/** Hooks into the rest of the server (database), all optional so rooms work standalone in tests. */
export interface RoomServices {
  /** Persist game log entries. Without it logs only go to the console. */
  writeLogs?: LogWriter | null;
  /** Don't print log lines to the console (tests, simulations). */
  quietLogs?: boolean;
  gameStarted?: (room: Room) => void;
  gameEnded?: (room: Room, status: 'finished' | 'ended') => void;
}

/** A room as plain JSON, to survive a server restart. API keys are sealed (encrypted). */
export interface RoomSnapshot {
  v: 1;
  code: string;
  hostId: string;
  players: (Omit<RoomPlayer, 'sockets'> & { sockets?: undefined })[];
  settings: GameSettings;
  status: RoomView['status'];
  gameId: string | null;
  logSeq: number;
  gameStartedAt: number | null;
  game: GameSnapshot | null;
  director: DirectorSnapshot | null;
  credentials: string | null;
  accounts: [string, string][];
  savedAt: number;
}

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

function randomId(bytes = 6) {
  return randomBytes(bytes).toString('base64url');
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 20);
  return name.length > 0 ? name : null;
}

function clamp(n: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

export function sanitizeSettings(current: GameSettings, patch: Partial<GameSettings>): GameSettings {
  const next: GameSettings = { ...current };
  if (patch.maxPlayers !== undefined) next.maxPlayers = clamp(patch.maxPlayers, LIMITS.maxPlayers, current.maxPlayers);
  if (patch.companyCount !== undefined) next.companyCount = clamp(patch.companyCount, LIMITS.companyCount, current.companyCount);
  if (patch.startingBudget !== undefined)
    next.startingBudget = clamp(patch.startingBudget, LIMITS.startingBudget, current.startingBudget);
  if (patch.turnoverMin !== undefined) next.turnoverMin = clamp(patch.turnoverMin, LIMITS.turnoverMin, current.turnoverMin);
  if (patch.turnoverMax !== undefined) next.turnoverMax = clamp(patch.turnoverMax, LIMITS.turnoverMax, current.turnoverMax);
  if (next.turnoverMax <= next.turnoverMin) next.turnoverMax = next.turnoverMin + 1;
  if (patch.intelPerPlayer !== undefined)
    next.intelPerPlayer = clamp(patch.intelPerPlayer, LIMITS.intelPerPlayer, current.intelPerPlayer);
  if (patch.bidSeconds !== undefined) next.bidSeconds = clamp(patch.bidSeconds, LIMITS.bidSeconds, current.bidSeconds);
  if (patch.introSeconds !== undefined)
    next.introSeconds = clamp(patch.introSeconds, LIMITS.introSeconds, current.introSeconds);
  if (patch.summarySeconds !== undefined)
    next.summarySeconds = clamp(patch.summarySeconds, LIMITS.summarySeconds, current.summarySeconds);
  if (patch.soldSeconds !== undefined) next.soldSeconds = clamp(patch.soldSeconds, LIMITS.soldSeconds, current.soldSeconds);
  if (patch.bidResetSeconds !== undefined)
    next.bidResetSeconds = clamp(patch.bidResetSeconds, LIMITS.bidResetSeconds, current.bidResetSeconds);
  if (patch.auctionMode === 'open' || patch.auctionMode === 'sealed') next.auctionMode = patch.auctionMode;
  if (patch.winCondition && ['netWorth', 'roi', 'purse', 'portfolio'].includes(patch.winCondition))
    next.winCondition = patch.winCondition;
  if (typeof patch.runningCosts === 'boolean') next.runningCosts = patch.runningCosts;
  if (typeof patch.marketEvents === 'boolean') next.marketEvents = patch.marketEvents;
  if (typeof patch.catchUpIntel === 'boolean') next.catchUpIntel = patch.catchUpIntel;
  if (patch.aiReasoning === 'live' || patch.aiReasoning === 'end') next.aiReasoning = patch.aiReasoning;
  if (typeof patch.showPersonas === 'boolean') next.showPersonas = patch.showPersonas;
  return next;
}

export class Room {
  readonly code: string;
  hostId = '';
  players: RoomPlayer[] = [];
  settings: GameSettings = { ...DEFAULT_SETTINGS };
  status: RoomView['status'] = 'lobby';
  game: Game | null = null;
  gameId: string | null = null;
  gameStartedAt: number | null = null;
  log: GameLog | null = null;
  lastActivity = Date.now();
  /** Signed-in account behind each human seat (player id → user id), for "my games". */
  readonly accounts = new Map<string, string>();
  private director: AiDirector | null = null;
  /** Keys powering LLM players. Server memory only, never sent to clients. */
  private readonly aiCredentials = new Map<string, Credentials>();
  private sentVersion = -1;
  private dirty = true;
  /** Bumped on every change, so the saver knows when a snapshot is stale. */
  changes = 0;
  private unsubscribeLog: (() => void) | null = null;

  constructor(
    code: string,
    private readonly services: RoomServices = {},
  ) {
    this.code = code;
  }

  touch() {
    this.dirty = true;
    this.changes++;
    this.lastActivity = Date.now();
  }

  /** Changes whenever anything worth saving changes. */
  stateKey(): string {
    return `${this.changes}:${this.game?.version ?? -1}`;
  }

  private name(playerId: string) {
    return this.player(playerId)?.name ?? playerId;
  }

  humanCount() {
    return this.players.filter((p) => p.kind === 'human').length;
  }

  player(id: string) {
    return this.players.find((p) => p.id === id);
  }

  byToken(token: string) {
    return this.players.find((p) => p.token === token);
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 17)} #${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private addPlayer(name: string, kind: PlayerKind, ai?: AiSpec): RoomPlayer {
    const p: RoomPlayer = {
      id: randomId(),
      token: randomId(18),
      name: this.uniqueName(name),
      kind,
      isHost: false,
      connected: kind !== 'human',
      ai,
      sockets: new Set(),
      disconnectedAt: null,
    };
    this.players.push(p);
    if (!this.hostId && kind === 'human') {
      this.hostId = p.id;
      p.isHost = true;
    }
    this.touch();
    return p;
  }

  addHuman(rawName: unknown): Result<RoomPlayer> {
    const name = cleanName(rawName);
    if (!name) return fail('Please enter a name.');
    if (this.status !== 'lobby') return fail('That game has already started.');
    if (this.players.length >= this.settings.maxPlayers) return fail('That room is full.');
    return { ok: true, data: this.addPlayer(name, 'human') };
  }

  /** Check that an AI can be added before any key lookups happen. */
  canAddAi(byId: string): Result {
    if (byId !== this.hostId) return fail('Only the host can add AI players.');
    if (this.status !== 'lobby') return fail('The game has already started.');
    if (this.players.length >= this.settings.maxPlayers) return fail('The room is full. Raise the player limit first.');
    return { ok: true };
  }

  /**
   * Add an AI player. LLM players need credentials, resolved by the caller from the host's
   * account or the server's env keys.
   */
  addAi(
    byId: string,
    spec: Partial<AiSpec> & { name?: string },
    credentials?: Credentials,
    keyOwner?: string,
  ): Result {
    const allowed = this.canAddAi(byId);
    if (!allowed.ok) return allowed;
    const persona = spec.persona && spec.persona in PERSONAS ? spec.persona : 'balanced';
    if (spec.provider) {
      const provider = providerById(spec.provider);
      if (!provider) return fail('Unknown AI provider.');
      if (!credentials) return fail(`Add a ${provider.label} API key to your account first.`);
      if (typeof spec.model !== 'string' || !spec.model.trim()) return fail('Pick a model.');
      const modelLabel = (spec.modelLabel || spec.model).slice(0, 40);
      const name = cleanName(spec.name) ?? modelLabel.slice(0, 20);
      const p = this.addPlayer(name, 'llm', {
        persona,
        provider: provider.id,
        model: spec.model.trim().slice(0, 120),
        modelLabel,
        keySource: credentials.source,
        keyOwner: credentials.source === 'account' ? keyOwner : undefined,
      });
      this.aiCredentials.set(p.id, credentials);
      return { ok: true };
    }
    const used = new Set(this.players.map((p) => p.name));
    const name = cleanName(spec.name) ?? BOT_NAMES.find((n) => !used.has(n)) ?? 'Bot';
    this.addPlayer(name, 'bot', { persona });
    return { ok: true };
  }

  remove(byId: string, targetId: string): Result {
    if (byId !== this.hostId) return fail('Only the host can remove players.');
    if (this.status !== 'lobby') return fail('Players cannot be removed during a game.');
    if (targetId === this.hostId) return fail('The host cannot remove themselves.');
    const idx = this.players.findIndex((p) => p.id === targetId);
    if (idx < 0) return fail('No such player.');
    this.players.splice(idx, 1);
    this.aiCredentials.delete(targetId);
    this.touch();
    return { ok: true };
  }

  /** A human leaves the lobby for good (or is dropped after disconnecting). */
  leave(playerId: string) {
    if (this.status !== 'lobby') {
      // Mid-game the seat stays (the game keeps their companies), but host duties move on.
      if (this.status === 'playing') this.log?.add('player', 'info', `${this.name(playerId)} left the game`, { playerId });
      this.setConnected(playerId, false);
      if (this.hostId === playerId) this.passHost(playerId);
      return;
    }
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx < 0) return;
    this.players.splice(idx, 1);
    if (this.hostId === playerId) this.passHost(playerId);
    this.touch();
  }

  /** Hand the host role to another human, preferring someone who is online. */
  private passHost(fromId: string) {
    const humans = this.players.filter((p) => p.kind === 'human' && p.id !== fromId);
    const next = humans.find((p) => p.connected) ?? humans[0];
    if (!next) return;
    this.hostId = next.id;
    if (this.status === 'playing') this.log?.add('player', 'info', `${next.name} is now the host`, { playerId: next.id });
    for (const p of this.players) p.isHost = p.id === this.hostId;
    if (this.game) for (const p of this.game.players) p.isHost = p.id === this.hostId;
    this.game?.touchView();
    this.touch();
  }

  updateSettings(byId: string, patch: Partial<GameSettings>): Result {
    if (byId !== this.hostId) return fail('Only the host can change settings.');
    if (this.status !== 'lobby') return fail('Settings are locked once the game starts.');
    const next = sanitizeSettings(this.settings, patch);
    if (next.maxPlayers < this.players.length) next.maxPlayers = this.players.length;
    this.settings = next;
    this.touch();
    return { ok: true };
  }

  start(byId: string, now: number): Result {
    if (byId !== this.hostId) return fail('Only the host can start the game.');
    if (this.status !== 'lobby') return fail('The game is already running.');
    if (this.players.length < 2) return fail('You need at least 2 players. Invite friends or add AI players.');
    if (this.settings.companyCount < this.players.length)
      return fail(`Auction at least ${this.players.length} companies so everyone gets a shot each round.`);
    this.game = new Game({
      settings: this.settings,
      players: this.players.map((p) => ({ id: p.id, name: p.name, kind: p.kind, isHost: p.isHost, ai: p.ai })),
      seed: randomSeed(),
      now,
    });
    for (const p of this.players) this.game.setConnected(p.id, p.connected);
    this.gameId = randomBytes(16).toString('base64url');
    this.gameStartedAt = Date.now();
    this.log = new GameLog(this.gameId, this.code, this.services.writeLogs ?? null, { quiet: this.services.quietLogs });
    this.log.add('game', 'info', `Game started: ${this.players.length} players, ${this.game.companies.length} companies, ${this.game.totalRounds} rounds`, {
      data: {
        settings: this.settings,
        players: this.players.map((p) => ({
          name: p.name,
          kind: p.kind,
          ...(p.ai ? { persona: p.ai.persona, provider: p.ai.provider, model: p.ai.model, keySource: p.ai.keySource } : {}),
        })),
      },
    });
    this.wireGame();
    this.status = 'playing';
    this.touch();
    this.services.gameStarted?.(this);
    return { ok: true };
  }

  /** Director + game-event logging for the current game (new or restored). */
  private wireGame(restore?: DirectorSnapshot) {
    const game = this.game!;
    this.director = new AiDirector(game, () => Date.now(), randomSeed(), {
      credentialsFor: (id) => this.aiCredentials.get(id),
      log: this.log,
      restore,
    });
    this.unsubscribeLog?.();
    this.unsubscribeLog = game.on((e) => this.logGameEvent(e));
  }

  private logGameEvent(e: GameEvent) {
    const game = this.game;
    const log = this.log;
    if (!game || !log) return;
    if (e.type === 'auctionStart') {
      const c = COMPANY_BY_ID[e.companyId];
      log.add('lot', 'info', `Round ${game.round}, lot ${game.slotInRound()}/${game.slotsInRound()}: ${c.name} (${c.tier})`, {
        data: { round: game.round, company: c.name, sector: c.sector, tier: c.tier },
      });
    } else if (e.type === 'auctionEnd') {
      const c = game.company(e.companyId)!;
      const secs = ((Date.now() - e.startedAt) / 1000).toFixed(1);
      const thinking = e.stillThinking.map((id) => this.name(id));
      const msg =
        e.winnerId && e.price !== null
          ? `${c.def.name} sold to ${this.name(e.winnerId)} for ${money(e.price)} (${e.bids} bid${e.bids === 1 ? '' : 's'}, ${secs}s)`
          : `${c.def.name}: no bids, withdrawn (${secs}s)`;
      log.add('lot', thinking.length ? 'warn' : 'info', thinking.length ? `${msg}. Closed while ${thinking.join(', ')} still thinking` : msg, {
        data: {
          round: game.round,
          company: c.def.name,
          winner: e.winnerId ? this.name(e.winnerId) : null,
          price: e.price,
          bids: e.bids,
          seconds: Number(secs),
          ...(thinking.length ? { stillThinking: thinking } : {}),
        },
        secret: { turnover: c.turnover },
      });
    } else if (e.type === 'roundEnd') {
      log.add('round', 'info', `Round ${e.round} payouts`, {
        secret: { payouts: Object.fromEntries(game.players.map((p) => [p.name, p.payouts.at(-1)?.total ?? 0])) },
      });
    } else if (e.type === 'finished') {
      const standings = game.results?.standings ?? [];
      const top = standings[0];
      log.add('game', 'info', top ? `Game over: ${this.name(top.playerId)} wins` : 'Game over', {
        data: {
          standings: standings.map((st) => ({ name: this.name(st.playerId), rank: st.rank, netWorth: Math.round(st.netWorth), purse: st.purse })),
        },
      });
      void log.flush();
      this.services.gameEnded?.(this, 'finished');
    }
  }

  // ── Host controls ──

  pause(byId: string, paused: boolean, now: number): Result {
    if (byId !== this.hostId) return fail('Only the host can pause.');
    if (!this.game) return fail('No game.');
    const wasPaused = this.game.paused;
    const r = paused ? this.game.pause(now) : this.game.resume(now);
    if (r.ok && wasPaused !== paused) this.log?.add('game', 'info', `${this.name(byId)} ${paused ? 'paused' : 'resumed'} the game`);
    return r;
  }

  endGame(byId: string): Result {
    if (byId !== this.hostId) return fail('Only the host can end the game.');
    if (!this.game) return fail('No game.');
    const round = this.game.round;
    const r = this.game.endEarly();
    if (r.ok) this.log?.add('game', 'info', `${this.name(byId)} ended the game early in round ${round}`);
    return r;
  }

  skip(byId: string, now: number): Result {
    if (byId !== this.hostId) return fail('Only the host can skip.');
    return this.game?.skip(now) ?? fail('No game.');
  }

  rematch(byId: string): Result {
    if (byId !== this.hostId) return fail('Only the host can start a rematch.');
    if (this.status !== 'finished') return fail('The game is not over yet.');
    this.director?.dispose();
    this.director = null;
    this.unsubscribeLog?.();
    this.unsubscribeLog = null;
    void this.log?.flush();
    this.log = null;
    this.game = null;
    this.gameId = null;
    this.gameStartedAt = null;
    this.status = 'lobby';
    this.touch();
    return { ok: true };
  }

  attachSocket(playerId: string, socketId: string) {
    const p = this.player(playerId);
    if (!p) return;
    p.sockets.add(socketId);
    this.setConnected(playerId, true);
  }

  detachSocket(playerId: string, socketId: string) {
    const p = this.player(playerId);
    if (!p) return;
    p.sockets.delete(socketId);
    if (p.sockets.size === 0) this.setConnected(playerId, false);
  }

  private setConnected(playerId: string, connected: boolean) {
    const p = this.player(playerId);
    if (!p || p.kind !== 'human') return;
    if (p.connected !== connected && this.status === 'playing') {
      this.log?.add('player', 'info', `${p.name} ${connected ? 'connected' : 'disconnected'}`, { playerId });
    }
    p.connected = connected;
    p.disconnectedAt = connected ? null : Date.now();
    this.game?.setConnected(playerId, connected);
    this.touch();
  }

  /** Advance timers. Returns true if clients need a fresh state. */
  tick(now: number): boolean {
    if (this.game) {
      this.game.tick(now);
      this.director?.tick();
      if (this.status === 'playing' && this.game.phase === 'finished') {
        this.status = 'finished';
        this.touch();
      }
      if (this.game.version !== this.sentVersion) {
        this.sentVersion = this.game.version;
        this.dirty = true;
      }
    }
    if (this.status === 'lobby') {
      for (const p of [...this.players]) {
        if (p.kind === 'human' && !p.connected && p.disconnectedAt && now - p.disconnectedAt > LOBBY_DROP_MS) {
          this.leave(p.id);
        }
      }
    }
    const changed = this.dirty;
    this.dirty = false;
    return changed;
  }

  isAbandoned(now: number): boolean {
    const anyoneHere = this.players.some((p) => p.kind === 'human' && p.connected);
    return this.humanCount() === 0 || (!anyoneHere && now - this.lastActivity > ROOM_IDLE_MS);
  }

  /** The room is closing for good (everyone left or it sat idle). */
  dispose() {
    this.stop();
    if (this.status === 'playing' && this.log) {
      this.log.add('game', 'warn', 'Room closed before the game finished (everyone left or went idle)');
      this.services.gameEnded?.(this, 'ended');
    }
    void this.log?.flush();
  }

  /** Stop AI activity (on dispose, or before the server hands the room to a new process). */
  stop() {
    this.director?.dispose();
    this.director = null;
    this.unsubscribeLog?.();
    this.unsubscribeLog = null;
  }

  snapshot(seal: (plain: string) => string, now: number): RoomSnapshot {
    return {
      v: 1,
      code: this.code,
      hostId: this.hostId,
      players: this.players.map(({ sockets: _sockets, ...p }) => ({ ...p })),
      settings: this.settings,
      status: this.status,
      gameId: this.gameId,
      logSeq: this.log?.lastSeq ?? 0,
      gameStartedAt: this.gameStartedAt,
      game: this.game?.snapshot() ?? null,
      director: this.director?.snapshot() ?? null,
      credentials: this.aiCredentials.size ? seal(JSON.stringify([...this.aiCredentials])) : null,
      accounts: [...this.accounts],
      savedAt: now,
    };
  }

  /**
   * Rebuild a room saved by another server process. Everyone starts disconnected and rejoins
   * with their seat token; timers resume where they stopped; AI players still thinking are asked again.
   */
  static restore(
    snap: RoomSnapshot,
    opts: { services?: RoomServices; unseal: (sealed: string) => string | null; now: number },
  ): Room {
    const room = new Room(snap.code, opts.services);
    room.hostId = snap.hostId;
    room.settings = snap.settings;
    room.status = snap.status;
    room.gameId = snap.gameId;
    room.gameStartedAt = snap.gameStartedAt;
    for (const [pid, uid] of snap.accounts) room.accounts.set(pid, uid);
    room.players = snap.players.map((p) => ({
      ...p,
      sockets: new Set<string>(),
      connected: p.kind !== 'human',
      disconnectedAt: p.kind === 'human' ? opts.now : null,
    }));
    if (snap.credentials) {
      const plain = opts.unseal(snap.credentials);
      if (plain) for (const [pid, cred] of JSON.parse(plain) as [string, Credentials][]) room.aiCredentials.set(pid, cred);
    }
    if (snap.game && snap.gameId) {
      room.game = new Game({ snapshot: snap.game, frozenAt: snap.savedAt, now: opts.now });
      for (const p of room.players) if (p.kind === 'human') room.game.setConnected(p.id, false);
      room.log = new GameLog(snap.gameId, snap.code, opts.services?.writeLogs ?? null, {
        seq: snap.logSeq,
        quiet: opts.services?.quietLogs,
      });
      const gap = ((opts.now - snap.savedAt) / 1000).toFixed(1);
      room.log.add('server', 'info', `Game restored after a server restart; the clock was stopped for ${gap}s`, {
        data: { gapMs: opts.now - snap.savedAt },
      });
      if (snap.credentials && room.aiCredentials.size === 0) {
        room.log.add('server', 'error', 'Could not unlock the saved AI keys (APP_SECRET changed?); LLM players use the backup brain');
      }
      if (room.status === 'playing') {
        room.wireGame(snap.director ?? undefined);
        room.director!.resumeAuction();
      }
    }
    room.touch();
    return room;
  }

  viewFor(playerId: string, now: number): RoomView {
    // Personalities are strategy info: hidden from non-hosts when the host says so, until the game ends.
    const reveal = this.settings.showPersonas || playerId === this.hostId || this.status === 'finished';
    const redact = <T extends { ai?: PublicAiSpec }>(p: T): T =>
      reveal || !p.ai ? p : { ...p, ai: { ...p.ai, persona: undefined } };
    const game = this.game ? this.game.viewFor(playerId, now) : null;
    if (game) game.players = game.players.map(redact);
    return {
      code: this.code,
      hostId: this.hostId,
      meId: playerId,
      status: this.status,
      players: this.players.map(({ id, name, kind, isHost, connected, ai }) => redact({ id, name, kind, isHost, connected, ai })),
      settings: this.settings,
      game,
      gameId: this.gameId,
    };
  }
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(
    readonly services: RoomServices = {},
    private readonly onDelete?: (room: Room) => void,
  ) {}

  create(): Room {
    let code = '';
    do {
      code = Array.from(randomBytes(5), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this.services);
    this.rooms.set(code, room);
    return room;
  }

  /** Put a restored room in place. */
  add(room: Room) {
    this.rooms.set(room.code, room);
  }

  /** Drop a room from this process without ending it (another process owns it now). */
  forget(code: string) {
    this.rooms.get(code)?.stop();
    this.rooms.delete(code);
  }

  get(code: unknown): Room | undefined {
    if (typeof code !== 'string') return undefined;
    return this.rooms.get(code.trim().toUpperCase());
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  delete(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.dispose();
    this.rooms.delete(code);
    this.onDelete?.(room);
  }
}
