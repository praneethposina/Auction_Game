import type { AiCatalog, ModelOption, ProviderStatus } from '../../shared/types.ts';

// Free / open-weight model providers. All of them speak the OpenAI chat-completions API,
// so one client works for every provider. Keys come from environment variables (see .env.example).

export interface ProviderDef {
  id: string;
  label: string;
  envVar: string;
  signupUrl: string;
  freeTier: string;
  baseUrl: () => string | undefined;
  apiKey: () => string | undefined;
  /** Curated, known-good models. */
  models: { model: string; label: string; note?: string; recommended?: boolean }[];
  /** Extra request-body fields for a given model (e.g. keep reasoning short). */
  extraBody?: (model: string) => Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** Discover models at runtime (OpenAI-compatible GET /models). */
  discover?: 'openrouter-free' | 'list-all';
}

const env = (name: string) => process.env[name]?.trim() || undefined;

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'groq',
    label: 'Groq',
    envVar: 'GROQ_API_KEY',
    signupUrl: 'https://console.groq.com/keys',
    freeTier: 'Free tier, no card needed. Very fast, generous rate limits.',
    baseUrl: () => 'https://api.groq.com/openai/v1',
    apiKey: () => env('GROQ_API_KEY'),
    models: [
      { model: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: 'OpenAI open-weight reasoning model', recommended: true },
      { model: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', note: 'Meta, solid all-rounder', recommended: true },
      { model: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', note: 'Alibaba, preview on Groq', recommended: true },
      { model: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', note: 'Small and very fast' },
      { model: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', note: 'Tiny, instant, a bit reckless' },
    ],
    extraBody: (model) => (model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    envVar: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    freeTier: ':free models cost nothing: 20 requests/min and 50/day (1,000/day after a one-time $10 top-up).',
    baseUrl: () => 'https://openrouter.ai/api/v1',
    apiKey: () => env('OPENROUTER_API_KEY'),
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
    discover: 'openrouter-free',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    envVar: 'HF_TOKEN',
    signupUrl: 'https://huggingface.co/settings/tokens',
    freeTier: 'Small monthly free credits, then pay-as-you-go. Open-weight models only.',
    baseUrl: () => 'https://router.huggingface.co/v1',
    apiKey: () => env('HF_TOKEN'),
    models: [
      { model: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash', note: 'DeepSeek, open-weight', recommended: true },
      { model: 'moonshotai/Kimi-K3', label: 'Kimi K3', note: 'Moonshot AI, open-weight', recommended: true },
      { model: 'zai-org/GLM-5.3-Flash', label: 'GLM 5.3 Flash', note: 'Zhipu, open-weight' },
      { model: 'Qwen/Qwen3.8-27B', label: 'Qwen 3.8 27B', note: 'Alibaba, open-weight' },
      { model: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: 'OpenAI, open-weight' },
      { model: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', note: 'Meta, open-weight' },
      { model: 'google/gemma-4-31B-it', label: 'Gemma 4 31B', note: 'Google, open-weight' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    envVar: 'OLLAMA_BASE_URL',
    signupUrl: 'https://ollama.com/download',
    freeTier: 'Runs on your own machine: free and unlimited. Speed depends on your hardware.',
    baseUrl: () => env('OLLAMA_BASE_URL'),
    apiKey: () => (env('OLLAMA_BASE_URL') ? 'ollama' : undefined),
    models: [],
    discover: 'list-all',
  },
  {
    id: 'custom',
    label: env('CUSTOM_LLM_LABEL') ?? 'Custom endpoint',
    envVar: 'CUSTOM_LLM_BASE_URL',
    signupUrl: 'https://platform.openai.com/docs/api-reference/chat',
    freeTier: 'Any OpenAI-compatible endpoint (Cerebras, Gemini, LM Studio, vLLM, …).',
    baseUrl: () => env('CUSTOM_LLM_BASE_URL'),
    apiKey: () => (env('CUSTOM_LLM_BASE_URL') ? (env('CUSTOM_LLM_API_KEY') ?? 'none') : undefined),
    models: (env('CUSTOM_LLM_MODELS') ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => ({ model: m, label: m })),
    discover: env('CUSTOM_LLM_MODELS') ? undefined : 'list-all',
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isConfigured(p: ProviderDef): boolean {
  return Boolean(p.baseUrl() && p.apiKey());
}

// Model discovery is cached so the lobby stays snappy.
const CACHE_MS = 30 * 60 * 1000;
const discovered = new Map<string, { at: number; models: { model: string; label: string }[] }>();

const EXCLUDE = /(guard|safety|safeguard|embed|whisper|tts|orpheus|coder|code|sante|vision-exp|ocr)/i;

async function discoverModels(p: ProviderDef): Promise<{ model: string; label: string }[] | null> {
  if (!p.discover) return null;
  const cached = discovered.get(p.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const base = p.baseUrl();
  if (!base) return null;
  try {
    const headers: Record<string, string> = {};
    const key = p.apiKey();
    if (key && p.id !== 'openrouter') headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${base.replace(/\/$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id: string; name?: string }[] };
    let list = (body.data ?? []).map((m) => ({ model: m.id, label: (m.name ?? m.id).replace(/\s*\(free\)\s*$/i, '') }));
    if (p.discover === 'openrouter-free') list = list.filter((m) => m.model.endsWith(':free'));
    list = list.filter((m) => !EXCLUDE.test(m.model));
    discovered.set(p.id, { at: Date.now(), models: list });
    return list;
  } catch {
    return null;
  }
}

export async function buildCatalog(): Promise<AiCatalog> {
  const providers: ProviderStatus[] = PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    configured: isConfigured(p),
    envVar: p.envVar,
    signupUrl: p.signupUrl,
    freeTier: p.freeTier,
  }));

  const models: ModelOption[] = [];
  for (const p of PROVIDERS) {
    const live = await discoverModels(p);
    const liveIds = live ? new Set(live.map((m) => m.model)) : null;
    const curated = p.models.filter((m) => !liveIds || liveIds.has(m.model) || p.id !== 'openrouter');
    for (const m of curated) {
      models.push({ provider: p.id, providerLabel: p.label, model: m.model, label: m.label, note: m.note, recommended: m.recommended });
    }
    if (live) {
      const known = new Set(curated.map((m) => m.model));
      for (const m of live) {
        if (known.has(m.model)) continue;
        models.push({ provider: p.id, providerLabel: p.label, model: m.model, label: m.label });
      }
    }
  }
  return { providers, models };
}
