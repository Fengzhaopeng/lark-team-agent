/**
 * Utilities for querying available models from an Anthropic-compatible API.
 *
 * Works with the official Anthropic API and compatible proxies (e.g. modelproxy).
 * Credentials are read from the standard environment variables:
 *   ANTHROPIC_API_KEY   — required
 *   ANTHROPIC_BASE_URL  — optional, defaults to https://api.anthropic.com
 */

export interface ModelInfo {
  id: string;
  displayName?: string;
  createdAt?: string;
}

export type FetchModelsResult =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; error: FetchModelsError };

export type FetchModelsError =
  | { code: 'missing-api-key' }
  | { code: 'network-error'; message: string }
  | { code: 'http-error'; status: number; message: string }
  | { code: 'parse-error'; message: string }
  | { code: 'timeout'; message: string };

export interface FetchModelsOptions {
  /** Override base URL. Falls back to ANTHROPIC_BASE_URL env var, then https://api.anthropic.com */
  baseUrl?: string;
  /** Override API key. Falls back to ANTHROPIC_API_KEY env var */
  apiKey?: string;
  /** Request timeout in ms. Default 10000 */
  timeoutMs?: number;
}

/**
 * Fetch available models from the /v1/models endpoint.
 * Never throws — always returns a typed result.
 */
export async function fetchModels(opts: FetchModelsOptions = {}): Promise<FetchModelsResult> {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey) {
    return { ok: false, error: { code: 'missing-api-key' } };
  }

  const baseUrl = (opts.baseUrl ?? process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com')
    .replace(/\/$/, '');
  const url = `${baseUrl}/v1/models`;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: { code: 'timeout', message: `Request timed out after ${timeoutMs}ms` } };
    }
    return {
      ok: false,
      error: { code: 'network-error', message: err instanceof Error ? err.message : String(err) },
    };
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.text();
      const json = JSON.parse(body) as { error?: { message?: string } };
      message = (json.error?.message ?? body.slice(0, 200)) || res.statusText;
    } catch {
      // keep statusText
    }
    return { ok: false, error: { code: 'http-error', status: res.status, message } };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: { code: 'parse-error', message: err instanceof Error ? err.message : String(err) },
    };
  }

  if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>)['data'])) {
    return { ok: false, error: { code: 'parse-error', message: 'Unexpected response shape' } };
  }

  const models: ModelInfo[] = ((data as { data: unknown[] }).data)
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      id: String(item['id'] ?? ''),
      displayName: typeof item['display_name'] === 'string' ? item['display_name'] : undefined,
      createdAt: typeof item['created_at'] === 'string' ? item['created_at'] : undefined,
    }))
    .filter((m) => m.id);

  return { ok: true, models };
}

/** Human-readable error message for FetchModelsError. */
export function formatFetchModelsError(error: FetchModelsError): string {
  switch (error.code) {
    case 'missing-api-key':
      return 'ANTHROPIC_API_KEY 未设置';
    case 'timeout':
      return `请求超时：${error.message}`;
    case 'network-error':
      return `网络错误：${error.message}`;
    case 'http-error':
      return `API 返回 ${error.status}：${error.message}`;
    case 'parse-error':
      return `响应解析失败：${error.message}`;
  }
}

// ── Model grouping ──────────────────────────────────────────────────────────

import type { CapabilityCache, ModelCapability } from './model-probe.js';

/**
 * Fallback patterns for filtering out non-chat models when no probe cache
 * is available. These cover the most common embedding / image / video / audio
 * model naming conventions but are NOT exhaustive — use probe cache when possible.
 *
 * Kept deliberately conservative: a false positive (hiding a real chat model)
 * is worse than a false negative here, so only names that are unambiguously
 * not conversational are listed.
 */
const NON_CHAT_FALLBACK_PATTERNS = [
  /embedding/i,
  // Image generation
  /^gpt-image/i,
  /^imagen-/i,
  /seedream/i,
  /-image(-|$)/i,     // gemini-3.1-flash-image, gemini-3-pro-image-preview
  /^dall-e/i,
  /^flux/i,
  // Video generation
  /seedance/i,
  // Audio input/output
  /-tts$/i,
  /-transcribe$/i,
  /-realtime/i,
  /-audio/i,
  // Non-conversational text endpoints
  /^text-(ada|babbage|curie|davinci|moderation)/i,
  /whisper/i,
];

/**
 * Filter models to those usable as Claude Code `--model` argument.
 * If a probe cache is supplied, uses it as the authoritative source.
 * Otherwise falls back to the conservative name-based filter above.
 */
export function filterChatModels(models: ModelInfo[], probeCache?: CapabilityCache | null): ModelInfo[] {
  if (probeCache) {
    const chatIds = new Set(
      probeCache.models
        .filter((m) => m.capabilities.includes('chat'))
        .map((m) => m.modelId),
    );
    return models.filter((m) => chatIds.has(m.id));
  }
  return models.filter((m) => !NON_CHAT_FALLBACK_PATTERNS.some((p) => p.test(m.id)));
}

/**
 * Filter models to those with a specific capability, using probe cache.
 * Returns all models when no cache is available (caller must handle).
 */
export function filterByCapability(
  models: ModelInfo[],
  capability: ModelCapability,
  probeCache: CapabilityCache,
): ModelInfo[] {
  const ids = new Set(
    probeCache.models
      .filter((m) => m.capabilities.includes(capability))
      .map((m) => m.modelId),
  );
  return models.filter((m) => ids.has(m.id));
}

const MODEL_GROUP_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Claude',       pattern: /^(claude-|global\.|us\.anthropic\.)/i },
  { label: 'GPT',          pattern: /^gpt-/i },
  { label: 'DeepSeek',     pattern: /^deepseek-/i },
  { label: 'Qwen',         pattern: /^qwen/i },
  { label: 'GLM / Doubao', pattern: /^(glm-|doubao-|seed)/i },
  { label: 'Kimi',         pattern: /^(kimi-|moonshot-)/i },
  { label: 'MiniMax',      pattern: /^minimax/i },
];

export interface ModelGroup {
  label: string;
  models: ModelInfo[];
}

/**
 * Group models by family. Returns an ordered list of groups.
 * Models not matching any rule land in an "Other" group at the end.
 */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const matched = new Set<string>();
  const groups: ModelGroup[] = [];

  for (const rule of MODEL_GROUP_RULES) {
    const members = models.filter((m) => rule.pattern.test(m.id));
    if (members.length > 0) {
      groups.push({ label: rule.label, models: members });
      members.forEach((m) => matched.add(m.id));
    }
  }

  const other = models.filter((m) => !matched.has(m.id));
  if (other.length > 0) groups.push({ label: 'Other', models: other });

  return groups;
}
