import type { Tier } from './data/companies.ts';
import type { SectorId } from './data/sectors.ts';
import type { PayoutLine, SynergyBreakdown } from './economy.ts';

// ── Settings ────────────────────────────────────────────────────

export type AuctionMode = 'open' | 'sealed';
export type WinCondition = 'netWorth' | 'roi' | 'purse' | 'portfolio';

export interface GameSettings {
  maxPlayers: number;
  companyCount: number;
  startingBudget: number;
  turnoverMin: number;
  turnoverMax: number;
  auctionMode: AuctionMode;
  winCondition: WinCondition;
  runningCosts: boolean;
  marketEvents: boolean;
  /** Private intel tips each player gets at the start. */
  intelPerPlayer: number;
  /** Last place gets an extra intel tip after each round. */
  catchUpIntel: boolean;
  /** Open: countdown that resets on each bid. Sealed: time to submit. */
  bidSeconds: number;
  /** How long the round intro (with market news) shows before bidding starts. */
  introSeconds: number;
  /** When AI players' reasoning becomes visible to everyone. */
  aiReasoning: 'live' | 'end';
}

export const DEFAULT_SETTINGS: GameSettings = {
  maxPlayers: 6,
  companyCount: 20,
  startingBudget: 1000,
  turnoverMin: 20,
  turnoverMax: 200,
  auctionMode: 'open',
  winCondition: 'netWorth',
  runningCosts: true,
  marketEvents: true,
  intelPerPlayer: 2,
  catchUpIntel: true,
  bidSeconds: 10,
  introSeconds: 6,
  aiReasoning: 'live',
};

export const LIMITS = {
  maxPlayers: [2, 10],
  companyCount: [2, 100],
  startingBudget: [100, 100000],
  turnoverMin: [0, 100000],
  turnoverMax: [1, 100000],
  intelPerPlayer: [0, 5],
  bidSeconds: [5, 60],
  introSeconds: [2, 60],
} as const;

export const WIN_CONDITION_LABEL: Record<WinCondition, string> = {
  netWorth: 'Net worth (cash + company value)',
  roi: 'Return on spend',
  purse: 'Cash in purse',
  portfolio: 'Portfolio value',
};

// ── Players ─────────────────────────────────────────────────────

export type PlayerKind = 'human' | 'bot' | 'llm';
export type Persona = 'balanced' | 'tycoon' | 'value' | 'synergy' | 'gambler';

export const PERSONAS: Record<Persona, { label: string; blurb: string }> = {
  balanced: { label: 'Strategist', blurb: 'Weighs value, synergies and budget evenly.' },
  tycoon: { label: 'Tycoon', blurb: 'Aggressive. Buys early and bids big on mega-caps.' },
  value: { label: 'Value Investor', blurb: 'Patient. Only buys below fair value.' },
  synergy: { label: 'Empire Builder', blurb: 'Chases sector bonuses and named combos.' },
  gambler: { label: 'Gambler', blurb: 'Unpredictable. Loves a hunch and a bluff.' },
};

export interface AiSpec {
  persona: Persona;
  /** Absent for built-in bots. */
  provider?: string;
  model?: string;
  modelLabel?: string;
  /** Whose key powers this LLM player. */
  keySource?: 'account' | 'server';
  /** Username of the account whose key is used. */
  keyOwner?: string;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  kind: PlayerKind;
  isHost: boolean;
  connected: boolean;
  ai?: AiSpec;
}

// ── Game views (what each client sees) ──────────────────────────

export type Phase = 'intro' | 'auction' | 'sold' | 'summary' | 'finished';

export interface PublicCompany {
  id: string;
  name: string;
  sector: SectorId;
  tier: Tier;
  hq: string;
  tagline: string;
  runningCost: number;
  status: 'upcoming' | 'auction' | 'sold' | 'unsold';
  ownerId: string | null;
  price: number | null;
  roundBought: number | null;
}

export interface PublicPlayer {
  id: string;
  name: string;
  kind: PlayerKind;
  isHost: boolean;
  connected: boolean;
  ai?: AiSpec;
  companyIds: string[];
}

export interface BidEntry {
  playerId: string;
  amount: number;
  at: number;
}

export interface AuctionView {
  companyId: string;
  mode: AuctionMode;
  startedAt: number;
  deadline: number;
  highBid: number | null;
  highBidderId: string | null;
  history: BidEntry[];
  outIds: string[];
  sealedSubmittedIds: string[];
  /** Sealed mode: my own submitted bid (null = passed, undefined = not yet). */
  myBid?: number | null;
  minNextBid: number;
  aiThinkingIds: string[];
}

export interface SaleView {
  companyId: string;
  winnerId: string | null;
  price: number | null;
  /** Only present for the winner. */
  turnover?: number;
  at: number;
}

export interface HoldingView {
  companyId: string;
  price: number;
  roundBought: number;
  turnover: number;
  runningCost: number;
  synergy: SynergyBreakdown;
  netPerRound: number;
  valuation: number;
}

export interface PayoutView {
  round: number;
  eventId: string | null;
  lines: PayoutLine[];
  total: number;
}

export type IntelKind = 'above' | 'below' | 'band' | 'compare' | 'rank' | 'sectorHeat' | 'nextEvent';

/** Machine-readable form of what the tip text says (used by AI players; no extra information). */
export interface IntelData {
  low?: number;
  high?: number;
  heat?: number;
  rank?: 'top' | 'bottom' | 'middle';
  higherId?: string;
}

export interface IntelTip {
  id: string;
  kind: IntelKind;
  text: string;
  data?: IntelData;
  companyIds: string[];
  sectorId?: SectorId;
  eventId?: string;
  round: number;
  source: 'start' | 'catchup';
}

export interface PrivatePlayer {
  id: string;
  purse: number;
  spent: number;
  income: number;
  holdings: HoldingView[];
  intel: IntelTip[];
  lastPayout: PayoutView | null;
}

export interface LogEntry {
  id: number;
  at: number;
  text: string;
  private?: boolean;
}

export interface AiThought {
  playerId: string;
  companyId: string;
  round: number;
  maxBid: number;
  reason: string;
  source: 'llm' | 'bot' | 'fallback';
  at: number;
}

export interface StandingView {
  playerId: string;
  rank: number;
  metric: number;
  purse: number;
  portfolioValue: number;
  netWorth: number;
  roi: number;
  spent: number;
  income: number;
  holdings: HoldingView[];
}

export interface FinalResults {
  winCondition: WinCondition;
  standings: StandingView[];
  sectorHeat: Partial<Record<SectorId, number>>;
  unsold: { companyId: string; turnover: number }[];
}

export interface EventView {
  id: string;
  round: number;
}

export interface GameView {
  phase: Phase;
  phaseEndsAt: number | null;
  serverNow: number;
  round: number;
  totalRounds: number;
  slot: number;
  slotsInRound: number;
  settings: GameSettings;
  event: EventView | null;
  companies: PublicCompany[];
  activeComboIds: string[];
  auction: AuctionView | null;
  lastSale: SaleView | null;
  players: PublicPlayer[];
  me: PrivatePlayer | null;
  log: LogEntry[];
  aiThoughts: AiThought[];
  results: FinalResults | null;
}

export interface RoomView {
  code: string;
  hostId: string;
  meId: string;
  status: 'lobby' | 'playing' | 'finished';
  players: LobbyPlayer[];
  settings: GameSettings;
  game: GameView | null;
}

// ── AI model catalog ────────────────────────────────────────────

export interface ModelOption {
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  note?: string;
  recommended?: boolean;
}

export interface ProviderStatus {
  id: string;
  label: string;
  envVar: string;
  signupUrl: string;
  freeTier: string;
  keyHint: string;
  /** Players can save their own key for this provider. */
  userKeys: boolean;
  /** The server owner configured a shared key. */
  serverKey: boolean;
  /** The current player has a saved key in their account. */
  yourKey: boolean;
}

export interface AiCatalog {
  providers: ProviderStatus[];
  models: ModelOption[];
}

// ── Accounts ────────────────────────────────────────────────────

export interface AccountUser {
  id: string;
  username: string;
}

export interface SavedKey {
  provider: string;
  masked: string;
  updatedAt: number;
  /** False if the key can no longer be decrypted (server secret changed). */
  readable: boolean;
}

// ── Socket messages ─────────────────────────────────────────────

export interface Ack<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface SessionInfo {
  code: string;
  playerId: string;
  token: string;
}

export interface ClientToServer {
  'room:create': (p: { name: string }, ack: (r: Ack<SessionInfo>) => void) => void;
  'room:join': (p: { code: string; name: string }, ack: (r: Ack<SessionInfo>) => void) => void;
  'room:resume': (p: { code: string; token: string }, ack: (r: Ack<SessionInfo>) => void) => void;
  'room:leave': () => void;
  'lobby:settings': (p: Partial<GameSettings>, ack: (r: Ack) => void) => void;
  'lobby:addAi': (p: AiSpec & { name?: string }, ack: (r: Ack) => void) => void;
  'lobby:remove': (p: { playerId: string }, ack: (r: Ack) => void) => void;
  'lobby:start': (ack: (r: Ack) => void) => void;
  'game:bid': (p: { amount: number }, ack: (r: Ack) => void) => void;
  'game:sealed': (p: { amount: number | null }, ack: (r: Ack) => void) => void;
  'game:out': (ack: (r: Ack) => void) => void;
  'game:skip': (ack: (r: Ack) => void) => void;
  'game:rematch': (ack: (r: Ack) => void) => void;
  'ai:catalog': (ack: (r: Ack<AiCatalog>) => void) => void;
}

export interface ServerToClient {
  'room:state': (view: RoomView) => void;
  'room:kicked': (p: { reason: string }) => void;
}
