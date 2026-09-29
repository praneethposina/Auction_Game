import type { GameLogEntry } from './types.ts';

/** Per-LLM-player health over a game: how often it answered, how fast, and at what token cost. */
export interface LlmStats {
  playerId: string;
  name: string;
  provider: string;
  model: string;
  calls: number;
  ok: number;
  /** Decisions made by the backup brain instead (errors, timeouts, unreadable answers, benched). */
  fallbacks: number;
  /** Answers that arrived after the lot had already closed. */
  late: number;
  outcomes: Record<string, number>;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  promptTokens: number;
  outputTokens: number;
  /** Requests that reported no token usage (counts above are then partial). */
  noUsage: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function llmStats(entries: GameLogEntry[]): LlmStats[] {
  const by = new Map<string, LlmStats & { times: number[] }>();
  for (const e of entries) {
    if (e.kind !== 'llm' || !e.playerId || !e.data) continue;
    const d = e.data;
    let s = by.get(e.playerId);
    if (!s) {
      s = {
        playerId: e.playerId,
        name: String(d.player ?? e.playerId),
        provider: String(d.provider ?? ''),
        model: String(d.model ?? ''),
        calls: 0,
        ok: 0,
        fallbacks: 0,
        late: 0,
        outcomes: {},
        avgMs: 0,
        p95Ms: 0,
        maxMs: 0,
        promptTokens: 0,
        outputTokens: 0,
        noUsage: 0,
        times: [],
      };
      by.set(e.playerId, s);
    }
    const outcome = String(d.outcome ?? 'unknown');
    s.outcomes[outcome] = (s.outcomes[outcome] ?? 0) + 1;
    if (outcome === 'benched') {
      s.fallbacks++;
      continue; // no request was made
    }
    s.calls++;
    if (outcome === 'ok') s.ok++;
    else s.fallbacks++;
    if (d.late) s.late++;
    s.times.push(num(d.ms));
    s.promptTokens += num(d.promptTokens);
    s.outputTokens += num(d.outputTokens);
    if (d.promptTokens === undefined) s.noUsage++;
  }
  return [...by.values()].map(({ times, ...s }) => {
    const sorted = [...times].sort((a, b) => a - b);
    return {
      ...s,
      avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
      p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0,
      maxMs: sorted.at(-1) ?? 0,
    };
  });
}
