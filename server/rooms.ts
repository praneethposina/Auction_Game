import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  PERSONAS,
  type AiSpec,
  type GameSettings,
  type LobbyPlayer,
  type PlayerKind,
  type RoomView,
} from '../shared/types.ts';
import { AiDirector } from './ai/director.ts';
import { providerById, type Credentials } from './ai/models.ts';
import { Game } from './game/engine.ts';
import { randomSeed } from './game/rng.ts';

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

export interface RoomPlayer extends LobbyPlayer {
  token: string;
  sockets: Set<string>;
  disconnectedAt: number | null;
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
  return next;
}

export class Room {
  readonly code: string;
  hostId = '';
  players: RoomPlayer[] = [];
  settings: GameSettings = { ...DEFAULT_SETTINGS };
  status: RoomView['status'] = 'lobby';
  game: Game | null = null;
  lastActivity = Date.now();
  private director: AiDirector | null = null;
  /** Keys powering LLM players. Server memory only, never sent to clients. */
  private readonly aiCredentials = new Map<string, Credentials>();
  private sentVersion = -1;
  private dirty = true;

  constructor(code: string) {
    this.code = code;
  }

  touch() {
    this.dirty = true;
    this.lastActivity = Date.now();
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
    this.director = new AiDirector(this.game, () => Date.now(), randomSeed(), {
      credentialsFor: (id) => this.aiCredentials.get(id),
    });
    this.status = 'playing';
    this.touch();
    return { ok: true };
  }

  rematch(byId: string): Result {
    if (byId !== this.hostId) return fail('Only the host can start a rematch.');
    if (this.status !== 'finished') return fail('The game is not over yet.');
    this.director?.dispose();
    this.director = null;
    this.game = null;
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

  dispose() {
    this.director?.dispose();
  }

  viewFor(playerId: string, now: number): RoomView {
    return {
      code: this.code,
      hostId: this.hostId,
      meId: playerId,
      status: this.status,
      players: this.players.map(({ id, name, kind, isHost, connected, ai }) => ({ id, name, kind, isHost, connected, ai })),
      settings: this.settings,
      game: this.game ? this.game.viewFor(playerId, now) : null,
    };
  }
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    let code = '';
    do {
      code = Array.from(randomBytes(5), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code: unknown): Room | undefined {
    if (typeof code !== 'string') return undefined;
    return this.rooms.get(code.trim().toUpperCase());
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  delete(code: string) {
    this.rooms.get(code)?.dispose();
    this.rooms.delete(code);
  }
}
