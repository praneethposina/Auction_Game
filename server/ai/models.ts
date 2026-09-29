import type { AiCatalog, ModelOption, ProviderStatus } from '../../shared/types.ts';

// LLM providers. All speak the OpenAI chat-completions API, so one client works for all.
// Keys come either from a player's account (saved, encrypted) or from server env vars.

export interface Credentials {
  provider: string;
  baseUrl: string;
  apiKey: string;
  source: 'account' | 'server';
}

export interface ProviderDef {
  id: string;
  label: string;
  envVar: string;
  signupUrl: string;
  freeTier: string;
  keyHint: string;
  /** Players can save their own key for this provider in their account. */
  userKeys: boolean;
  baseUrl: () => string | undefined;
  serverKey: () => string | undefined;
  /** Curated, known-good models. */
  models: { model: string; label: string; note?: string; recommended?: boolean }[];
  /** Extra request-body fields for a given model (e.g. keep reasoning short). */
  extraBody?: (model: string) => Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** Discover models at runtime via GET /models. */
  discover?: { mode: 'openrouter-free' | 'all'; needsKey: boolean; mapId?: (id: string) => string };
  /** Endpoint that answers 200 for a valid key. */
  validateUrl?: string;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'groq',
    label: 'Groq',
    envVar: 'GROQ_API_KEY',
    signupUrl: 'https://console.groq.com/keys',
    freeTier: 'Free tier, no card needed. Very fast, generous limits.',
    keyHint: 'gsk_…',
    userKeys: true,
    baseUrl: () => 'https://api.groq.com/openai/v1',
    serverKey: () => env('GROQ_API_KEY'),
    models: [
      { model: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: 'OpenAI open-weight reasoning model', recommended: true },
      { model: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', note: 'Meta, solid all-rounder', recommended: true },
      { model: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', note: 'Alibaba, preview on Groq', recommended: true },
      { model: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', note: 'Small and very fast' },
      { model: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', note: 'Tiny, instant, a bit reckless' },
    ],
    extraBody: (model) => (model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
    discover: { mode: 'all', needsKey: true },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    envVar: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    freeTier: ':free models cost nothing: 20 req/min, 50 req/day (1,000/day after a one-time $10 top-up).',
    keyHint: 'sk-or-v1-…',
    userKeys: true,
    baseUrl: () => 'https://openrouter.ai/api/v1',
    serverKey: () => env('OPENROUTER_API_KEY'),
    models: [
      { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra', note: 'NVIDIA, 550B open MoE', recommended: true },
      { model: 'thinkingmachines/inkling:free', label: 'Inkling', note: 'Thinking Machines, open-weight', recommended: true },
      { model: 'qwen/qwen3.8-27b:free', label: 'Qwen 3.8 27B', note: 'Alibaba, open-weight', recommended: true },
      { model: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', note: 'Google, open-weight', recommended: true },
      { model: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super', note: 'NVIDIA, 120B open MoE' },
      { model: 'dots-studio/dots-3-note-preview:free', label: 'Dots3-Note', note: 'Dots Studio, open MoE' },
      { model: 'thinkingmachines/inkling-small:free', label: 'Inkling Small', note: 'Thinking Machines, efficient' },
      { model: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B', note: 'Google, fast MoE' },
      { model: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning', note: 'NVIDIA, tiny and quick' },
    ],
    extraBody: () => ({ reasoning: { effort: 'low', exclude: true } }),
    extraHeaders: { 'HTTP-Referer': 'https://github.com/praneethposina/Auction_Game', 'X-Title': 'Company Auction Game' },
    discover: { mode: 'openrouter-free', needsKey: false },
    validateUrl: 'https://openrouter.ai/api/v1/key',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    envVar: 'CEREBRAS_API_KEY',
    signupUrl: 'https://cloud.cerebras.ai',
    freeTier: 'Free tier with daily token limits. Extremely fast open-weight models.',
    keyHint: 'csk-…',
    userKeys: true,
    baseUrl: () => 'https://api.cerebras.ai/v1',
    serverKey: () => env('CEREBRAS_API_KEY'),
    models: [],
    discover: { mode: 'all', needsKey: true },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    freeTier: 'Free tier from Google AI Studio (Gemini Flash and Gemma models).',
    keyHint: 'AIza…',
    userKeys: true,
    baseUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai',
    serverKey: () => env('GEMINI_API_KEY'),
    models: [],
    discover: { mode: 'all', needsKey: true, mapId: (id) => id.replace(/^models\//, '') },
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    envVar: 'HF_TOKEN',
    signupUrl: 'https://huggingface.co/settings/tokens',
    freeTier: 'Small monthly free credits, then pay-as-you-go. Open-weight models only.',
    keyHint: 'hf_…',
    userKeys: true,
    baseUrl: () => 'https://router.huggingface.co/v1',
    serverKey: () => env('HF_TOKEN'),
    models: [
      { model: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash', note: 'DeepSeek, open-weight', recommended: true },
      { model: 'moonshotai/Kimi-K3', label: 'Kimi K3', note: 'Moonshot AI, open-weight', recommended: true },
      { model: 'zai-org/GLM-5.3-Flash', label: 'GLM 5.3 Flash', note: 'Zhipu, open-weight' },
      { model: 'Qwen/Qwen3.8-27B', label: 'Qwen 3.8 27B', note: 'Alibaba, open-weight' },
      { model: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: 'OpenAI, open-weight' },
      { model: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', note: 'Meta, open-weight' },
      { model: 'google/gemma-4-31B-it', label: 'Gemma 4 31B', note: 'Google, open-weight' },
    ],
    validateUrl: 'https://huggingface.co/api/whoami-v2',
  },
  {
    id: 'ollama',
    label: 'Ollama (server-local)',
    envVar: 'OLLAMA_BASE_URL',
    signupUrl: 'https://ollama.com/download',
    freeTier: 'Runs on the game server’s machine: free and unlimited.',
    keyHint: '',
    userKeys: false,
    baseUrl: () => env('OLLAMA_BASE_URL'),
    serverKey: () => (env('OLLAMA_BASE_URL') ? 'ollama' : undefined),
    models: [],
    discover: { mode: 'all', needsKey: true },
  },
  {
    id: 'custom',
    label: env('CUSTOM_LLM_LABEL') ?? 'Custom endpoint',
    envVar: 'CUSTOM_LLM_BASE_URL',
    signupUrl: 'https://platform.openai.com/docs/api-reference/chat',
    freeTier: 'Any OpenAI-compatible endpoint configured by the server owner.',
    keyHint: '',
    userKeys: false,
    baseUrl: () => env('CUSTOM_LLM_BASE_URL'),
    serverKey: () => (env('CUSTOM_LLM_BASE_URL') ? (env('CUSTOM_LLM_API_KEY') ?? 'none') : undefined),
    models: (env('CUSTOM_LLM_MODELS') ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => ({ model: m, label: m })),
    discover: env('CUSTOM_LLM_MODELS') ? undefined : { mode: 'all', needsKey: true },
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function serverCredentials(p: ProviderDef): Credentials | null {
  const baseUrl = p.baseUrl();
  const apiKey = p.serverKey();
  return baseUrl && apiKey ? { provider: p.id, baseUrl, apiKey, source: 'server' } : null;
}

export function accountCredentials(p: ProviderDef, apiKey: string): Credentials | null {
  const baseUrl = p.baseUrl();
  return p.userKeys && baseUrl ? { provider: p.id, baseUrl, apiKey, source: 'account' } : null;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export interface KeyCheck {
  ok: boolean;
  /** The provider explicitly refused the key (as opposed to being unreachable). */
  rejected: boolean;
  detail: string;
}

/** Checks a key with the provider. Never throws. */
export async function validateKey(p: ProviderDef, apiKey: string): Promise<KeyCheck> {
  const base = p.baseUrl();
  const url = p.validateUrl ?? (base ? `${base.replace(/\/$/, '')}/models` : undefined);
  if (!url) return { ok: false, rejected: false, detail: 'This provider cannot be checked.' };
  try {
    const res = await fetch(url, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true, rejected: false, detail: `${p.label} accepted the key.` };
    if (res.status === 400 || res.status === 401 || res.status === 403)
      return { ok: false, rejected: true, detail: `${p.label} rejected this key.` };
    if (res.status === 429)
      return { ok: true, rejected: false, detail: `${p.label} is rate limiting right now, but the key looks valid.` };
    return { ok: false, rejected: false, detail: `${p.label} answered with HTTP ${res.status}.` };
  } catch {
    return { ok: false, rejected: false, detail: `Could not reach ${p.label} to check the key.` };
  }
}

// Model discovery is cached per provider so the lobby stays snappy.
const CACHE_MS = 30 * 60 * 1000;
const discovered = new Map<string, { at: number; models: { model: string; label: string }[] }>();

const EXCLUDE =
  /(guard|safety|safeguard|embed|whisper|tts|orpheus|coder|code|sante|vision-exp|ocr|image|audio|live|veo|imagen|aqa|lyria|transcribe|robotics|computer-use)/i;

async function discoverModels(p: ProviderDef, apiKey: string | undefined) {
  if (!p.discover) return null;
  if (p.discover.needsKey && !apiKey) return discovered.get(p.id)?.models ?? null;
  const cached = discovered.get(p.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const base = p.baseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/models`, {
      headers: p.discover.needsKey && apiKey ? authHeaders(apiKey) : {},
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id: string; name?: string; display_name?: string }[] };
    const mapId = p.discover.mapId ?? ((id: string) => id);
    let list = (body.data ?? []).map((m) => ({
      model: mapId(m.id),
      label: (m.name ?? m.display_name ?? mapId(m.id)).replace(/\s*\(free\)\s*$/i, ''),
    }));
    if (p.discover.mode === 'openrouter-free') list = list.filter((m) => m.model.endsWith(':free'));
    list = list.filter((m) => !EXCLUDE.test(m.model));
    discovered.set(p.id, { at: Date.now(), models: list });
    return list;
  } catch {
    return null;
  }
}

/**
 * The provider/model list for one player. `accountKeys` maps provider id → the player's own
 * decrypted key, so their providers show as available and discovery can use their key.
 */
export async function buildCatalog(accountKeys: Map<string, string> = new Map()): Promise<AiCatalog> {
  const providers: ProviderStatus[] = PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    signupUrl: p.signupUrl,
    freeTier: p.freeTier,
    keyHint: p.keyHint,
    userKeys: p.userKeys,
    serverKey: serverCredentials(p) !== null,
    yourKey: accountKeys.has(p.id),
  }));

  const models: ModelOption[] = [];
  await Promise.all(
    PROVIDERS.map(async (p) => {
      const key = accountKeys.get(p.id) ?? p.serverKey();
      const live = await discoverModels(p, key);
      const liveIds = live ? new Set(live.map((m) => m.model)) : null;
      const curated = p.models.filter((m) => p.id !== 'openrouter' || !liveIds || liveIds.has(m.model));
      const out: ModelOption[] = curated.map((m) => ({
        provider: p.id,
        providerLabel: p.label,
        model: m.model,
        label: m.label,
        note: m.note,
        recommended: m.recommended,
      }));
      if (live) {
        const known = new Set(curated.map((m) => m.model));
        for (const m of live) {
          if (!known.has(m.model)) out.push({ provider: p.id, providerLabel: p.label, model: m.model, label: m.label });
        }
      }
      models.push(...out);
    }),
  );
  const order = new Map(PROVIDERS.map((p, i) => [p.id, i]));
  models.sort((a, b) => order.get(a.provider)! - order.get(b.provider)!);
  return { providers, models };
}
