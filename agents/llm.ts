// One small LLM wrapper with a provider switch.
//   LLM_PROVIDER=gemini (default) -> @google/genai, models.generateContent with a JSON schema
//   LLM_PROVIDER=nvidia           -> openai SDK pointed at https://integrate.api.nvidia.com/v1
// Every call: validate JSON with zod -> retry once on bad JSON -> stored fallback.
// Every result is tagged source = 'llm' | 'fallback'. Fallbacks are never presented as model output.
// Successful llm results are cached by input hash so repeated inputs cost no quota.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AGENTS_DIR, env } from './config';

export type Source = 'llm' | 'fallback';

export interface LlmResult<T> {
  data: T;
  source: Source;
  provider: string;
  model: string;
  cached: boolean;
  /** Why we fell back, when we did. */
  note?: string;
}

export interface JsonTask<T> {
  /** Short task name, part of the cache key. */
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Stored/templated result used when the model is unavailable or returns bad JSON twice. */
  fallback: () => T;
}

export interface ProviderAdapter {
  name: 'gemini' | 'nvidia' | 'fake';
  model: string;
  /** False when no key is configured. No call is made then. */
  available: boolean;
  unavailableReason?: string;
  complete(system: string, prompt: string, jsonSchema: unknown): Promise<string>;
}

// ------------------------------------------------------------------------------------------------
// Providers
// ------------------------------------------------------------------------------------------------

export function geminiAdapter(apiKey = env.GEMINI_API_KEY, model = env.GEMINI_MODEL): ProviderAdapter {
  return {
    name: 'gemini',
    model,
    available: apiKey.length > 0,
    unavailableReason: apiKey ? undefined : 'GEMINI_API_KEY is not set',
    async complete(system, prompt, jsonSchema) {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema,
          maxOutputTokens: 1024,
        },
      });
      return res.text ?? '';
    },
  };
}

export function nvidiaAdapter(apiKey = env.NVIDIA_API_KEY, model = env.NVIDIA_MODEL): ProviderAdapter {
  return {
    name: 'nvidia',
    model,
    available: apiKey.length > 0,
    unavailableReason: apiKey ? undefined : 'NVIDIA_API_KEY is not set',
    async complete(system, prompt, jsonSchema) {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey, baseURL: env.NVIDIA_BASE_URL });
      // chat_template_kwargs is an NVIDIA extension the OpenAI types don't know about. Turning thinking
      // off stops reasoning models (nemotron-*-reasoning) spending the whole token budget before the JSON;
      // checked against nemotron-3-nano-omni-30b-a3b-reasoning on 2026-11-08.
      const body: import('openai').OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
        chat_template_kwargs?: { enable_thinking: boolean };
      } = {
        model,
        temperature: 0.6,
        top_p: 0.95,
        max_tokens: 2048,
        messages: [
          {
            role: 'system',
            content:
              `${system}\nReply with ONE JSON object only, no prose, no markdown fences. ` +
              `It must match this JSON Schema:\n${JSON.stringify(jsonSchema)}`,
          },
          { role: 'user', content: prompt },
        ],
        chat_template_kwargs: { enable_thinking: false },
      };
      const res = await client.chat.completions.create(body);
      return res.choices[0]?.message?.content ?? '';
    },
  };
}

export function adapterFromEnv(provider: 'gemini' | 'nvidia' = env.LLM_PROVIDER): ProviderAdapter {
  return provider === 'nvidia' ? nvidiaAdapter() : geminiAdapter();
}

// ------------------------------------------------------------------------------------------------
// JSON parsing
// ------------------------------------------------------------------------------------------------

/** Pull a JSON object out of model text: strips <think> blocks and ``` fences, then takes the outer {...}. */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(t.slice(start, end + 1));
}

// ------------------------------------------------------------------------------------------------
// Cache
// ------------------------------------------------------------------------------------------------

export interface Cache {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export function memoryCache(): Cache {
  const m = new Map<string, unknown>();
  return { get: k => m.get(k), set: (k, v) => void m.set(k, v) };
}

export function fileCache(path = resolve(AGENTS_DIR, '.cache', 'llm-cache.json')): Cache {
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    data = {};
  }
  return {
    get: k => data[k],
    set: (k, v) => {
      data[k] = v;
      try {
        mkdirSync(resolve(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify(data, null, 1));
      } catch {
        /* cache is best effort */
      }
    },
  };
}

export const hashInput = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

// ------------------------------------------------------------------------------------------------
// Wrapper
// ------------------------------------------------------------------------------------------------

export interface LlmClient {
  adapter: ProviderAdapter;
  generateJson<T>(task: JsonTask<T>): Promise<LlmResult<T>>;
  stats: { calls: number; cacheHits: number; fallbacks: number };
}

export function createLlm(opts: {
  adapter: ProviderAdapter;
  cache?: Cache;
  minIntervalMs?: number;
  forceFallback?: boolean;
  log?: (msg: string) => void;
}): LlmClient {
  const { adapter } = opts;
  const cache = opts.cache ?? memoryCache();
  const minInterval = opts.minIntervalMs ?? 0;
  const log = opts.log ?? (() => {});
  const stats = { calls: 0, cacheHits: 0, fallbacks: 0 };

  // Serialise model calls and space them out (free-tier friendly).
  let chain: Promise<unknown> = Promise.resolve();
  let lastCall = 0;
  const throttled = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(async () => {
      const wait = lastCall + minInterval - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastCall = Date.now();
      return fn();
    });
    chain = run.catch(() => undefined);
    return run;
  };

  async function generateJson<T>(task: JsonTask<T>): Promise<LlmResult<T>> {
    const base = { provider: adapter.name, model: adapter.model };
    const fallback = (note: string): LlmResult<T> => {
      stats.fallbacks++;
      log(`[llm] ${task.task}: fallback (${note})`);
      return { ...base, data: task.schema.parse(task.fallback()), source: 'fallback', cached: false, note };
    };

    if (opts.forceFallback) return fallback('LLM_FORCE_FALLBACK=1');
    if (!adapter.available) return fallback(adapter.unavailableReason ?? 'provider unavailable');

    const key = hashInput([adapter.name, adapter.model, task.task, task.system, task.prompt]);
    const hit = cache.get(key);
    if (hit !== undefined) {
      const parsed = task.schema.safeParse(hit);
      if (parsed.success) {
        stats.cacheHits++;
        return { ...base, data: parsed.data, source: 'llm', cached: true };
      }
    }

    const jsonSchema = z.toJSONSchema(task.schema);
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        stats.calls++;
        const prompt =
          attempt === 1
            ? task.prompt
            : `${task.prompt}\n\nYour previous reply was not valid JSON for the schema (${lastErr}). Reply again with valid JSON only.`;
        const text = await throttled(() => adapter.complete(task.system, prompt, jsonSchema));
        const parsed = task.schema.safeParse(extractJson(text));
        if (parsed.success) {
          cache.set(key, parsed.data);
          log(`[llm] ${task.task}: ok via ${adapter.name}/${adapter.model} (attempt ${attempt})`);
          return { ...base, data: parsed.data, source: 'llm', cached: false };
        }
        lastErr = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300);
      } catch (e) {
        lastErr = e instanceof Error ? e.message.slice(0, 300) : String(e);
        // Network / quota errors are not "bad JSON": don't burn a retry on a 429.
        if (/429|quota|rate/i.test(lastErr)) break;
      }
    }
    return fallback(`model output rejected: ${lastErr}`);
  }

  return { adapter, generateJson, stats };
}

export type Provider = 'gemini' | 'nvidia';
export const isProvider = (v: unknown): v is Provider => v === 'gemini' || v === 'nvidia';

// One client per provider, created on first use. They share one file cache (keys include provider +
// model, so entries never cross providers) so two clients never overwrite each other's entries.
const clients = new Map<Provider, LlmClient>();
let sharedCache: Cache | undefined;
const processCache = () => (sharedCache ??= fileCache());

/** Client for a specific provider. */
export function llmFor(provider: Provider): LlmClient {
  let c = clients.get(provider);
  if (!c) {
    c = createLlm({
      adapter: adapterFromEnv(provider),
      cache: processCache(),
      minIntervalMs: env.LLM_MIN_INTERVAL_MS,
      forceFallback: env.LLM_FORCE_FALLBACK,
      log: m => console.log(m),
    });
    clients.set(provider, c);
  }
  return c;
}

// The provider every agent uses. Starts at LLM_PROVIDER; the worker switches it when the dashboard
// changes agent_config.llmProvider.
let activeProvider: Provider = env.LLM_PROVIDER;
export const getActiveProvider = (): Provider => activeProvider;
export function setActiveProvider(provider: Provider) {
  activeProvider = provider;
}

/** The active client. Weather Research and Triage both call this, so one switch moves every agent. */
export function llm(): LlmClient {
  return llmFor(activeProvider);
}
