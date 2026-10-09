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

// ── Historical-version collapse ─────────────────────────────────────────────

/**
 * Version-collapse rules, ported from the model-pruning spec the operator uses
 * for their gateway inventory (2026-09-23): a gateway's `/v1/models` lists every
 * historical snapshot of every line, so raw output is mostly superseded
 * duplicates — `gpt-5` / `5.1` / `5.2` / `5.4` / `5.5`, six `gemini-*-flash`
 * generations, `claude-opus-4-6` … `4-8` next to `claude-opus-5`.
 *
 * This runs *after* {@link filterChatModels} / {@link filterByCapability}:
 * those answer "is this a usable model at all", this answers "is it the newest
 * one of its line".
 *
 * The rules are mechanical — no per-vendor tables:
 *   1. Date stamps (`20251001`, `260915`, `2025-08-07`, `03-25`, `0613`) and
 *      preview-ish qualifiers (`-preview`, `-exp`, `-latest`, …) mark a
 *      *snapshot* of a line, not the line itself, so they are stripped. The
 *      newest date is remembered for tie-breaking.
 *   2. Whatever name remains is the **product line**; the digits left in it are
 *      the **generation**. Tier words (`-mini`, `-nano`, `-lite`, `-flash`,
 *      `-turbo`, `-pro`, `-max`, `-code`, `-sol`, …) are part of the line, so
 *      `gpt-5.6-sol` and `gpt-5.6-terra` are two lines and both survive at the
 *      same generation — only genuine versions collapse.
 *   3. Keep the highest generation per line. Tie-breakers, in order: the
 *      undated alias over a dated snapshot (`qwen3.8-max` > `qwen3.8-max-0902`),
 *      the stable name over its `-preview` twin, then the newest date stamp
 *      (`doubao-…-260915` > `doubao-…-260628`).
 *   4. A line named exactly after its vendor with no tier (`gpt-5.5`) is the
 *      vendor's generic handle; it is dropped once any tiered line of that
 *      vendor has reached a newer generation (`gpt-5.6-*`, `gpt-6-*`).
 *   5. A line carrying **no generation digits at all** (`qwen-turbo`,
 *      `qwen-max`) is the pre-numbering era of that vendor. It is dropped once
 *      the vendor ships any numbered line (`qwen3.8-*`), unless it is a
 *      {@link STABLE_ALIASES} entry — those are evergreen handles the vendor
 *      keeps pointing at its newest backend.
 *   6. A vendor-wide generation floor catches the tiered lines that rule 3
 *      cannot: `gpt-4-turbo` is its own tier line with no newer sibling, so
 *      nothing competes with it, yet it is plainly history once the vendor
 *      ships generation 6. Any line more than one major generation behind the
 *      vendor's newest is dropped. One generation of slack is deliberate —
 *      operators routinely run the previous major alongside the new one
 *      (`gpt-5.6-*` next to `gpt-6-*`, `glm-4.6v` next to `glm-5.3`).
 */
export interface PruneVersionsResult {
  /** Models that survive, in their original order. */
  models: ModelInfo[];
  /** Older generations of the same line that were hidden, in original order. */
  dropped: ModelInfo[];
}

export interface PruneVersionsOptions {
  /**
   * Ids to keep even when a newer generation of their line exists. Callers pass
   * the session's currently selected model here so the list keeps marking it
   * `← 当前` instead of silently hiding the active choice.
   */
  alwaysKeep?: Iterable<string>;
}

/** Ordered longest-first, so `20251001` is not partially eaten by `\d{4}`. */
const DATE_PATTERNS: RegExp[] = [
  /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, // 2025-08-07
  /(?<!\d)\d{8}(?!\d)/g,             // 20251001
  /(?<!\d)\d{6}(?!\d)/g,             // 260915
  /(?<!\d)\d{2}-\d{2}(?!\d)/g,       // 03-25
  /(?<!\d)\d{4}(?!\d)/g,             // 0613
];

const PREVIEW_QUALIFIER = /(?<![a-z0-9])(preview|exp|experimental|latest|stable|snapshot)(?![a-z0-9])/g;

/**
 * A version token is 1–3 digits, optionally followed by `.`/`-` and a second
 * component. It must not be followed by another digit, nor by a *size unit*
 * letter — `235b` in `qwen3-235b-a22b`, `16k` in `gpt-3.5-turbo-16k` and `27B`
 * in `Qwen3.8-27B` are context/parameter counts, not versions. A tier letter is
 * fine and stays outside the match, which is how `glm-4v` yields generation 4.
 */
const VERSION_TOKEN = /(?<![0-9.])(\d{1,3})(?:[.\-](\d{1,3}))?(?![0-9bBkKmM%])/g;

/**
 * OpenAI's `-4o` is generation-4 naming under a marketing suffix. Normalizing it
 * to `-4` lets it compete in (and lose to) the newest `gpt` generation instead
 * of surviving as a bogus line of its own.
 */
const GENERATION_ALIASES: Array<[RegExp, string]> = [[/4o(?=-|$)/g, '4']];

/**
 * Stable aliases that always track the vendor's newest backend. These win their
 * line even when a sibling looks numerically newer, because the vendor
 * renumbered the model without renaming the alias — e.g. `deepseek-flash` is
 * v4.1-Flash while `deepseek-v4-flash` is the older handle for the same
 * backend. `doubao-seed-evolving` is the same shape: an evergreen handle with
 * no generation digits that rule 5 would otherwise read as history. Keep this
 * list tiny and evidence-backed.
 */
const STABLE_ALIASES = new Set(['deepseek-flash', 'doubao-seed-evolving']);

interface LineInfo {
  /** Name with dates, qualifiers and version digits removed. */
  line: string;
  /** Version components, e.g. `claude-opus-5-5` → `[5, 5]`. */
  version: number[];
  /** Leading vendor token, e.g. `gpt-5.5` → `gpt`. */
  vendor: string;
  /** True when the raw id carried a date stamp. */
  dated: boolean;
  /** True when the raw id carried a preview-ish qualifier. */
  qualified: boolean;
  /** Sortable date stamp for same-generation tie-breaks; 0 when undated. */
  dateRank: number;
}

export function keepLatestVersions(
  models: ModelInfo[],
  opts: PruneVersionsOptions = {},
): PruneVersionsResult {
  const pinned = new Set(opts.alwaysKeep ?? []);
  const info = new Map<string, LineInfo>();
  const lines = new Map<string, string[]>();
  /** Highest version reached anywhere in each vendor family. */
  const vendorCeiling = new Map<string, number[]>();

  for (const model of models) {
    const parsed = describeLine(model.id);
    info.set(model.id, parsed);
    const members = lines.get(parsed.line);
    if (members) members.push(model.id);
    else lines.set(parsed.line, [model.id]);
    const ceiling = vendorCeiling.get(parsed.vendor);
    if (!ceiling || compareVersions(parsed.version, ceiling) > 0) {
      vendorCeiling.set(parsed.vendor, parsed.version);
    }
  }

  const winners = new Set<string>();
  const droppedByLine = new Set<string>();
  /** Vendors that ship at least one generation-numbered line. */
  const numberedVendors = new Set<string>();
  for (const entry of info.values()) {
    if (entry.version.length > 0) numberedVendors.add(entry.vendor);
  }

  for (const [line, members] of lines) {
    const winner = pickWinner(members, info)!;
    const stale =
      // Rule 4: a bare vendor handle is stale once a tiered line has moved on.
      isBareVendorHandle(line, winner, info, vendorCeiling)
      // Rule 5: an unnumbered line is stale once the vendor ships numbered ones.
      || isUnnumberedLegacy(winner, info, numberedVendors)
      // Rule 6: a tiered line two or more major generations behind.
      || isOutdatedGeneration(winner, info, vendorCeiling);
    if (stale) {
      members.forEach((id) => droppedByLine.add(id));
      continue;
    }
    winners.add(winner);
  }

  const kept: ModelInfo[] = [];
  const dropped: ModelInfo[] = [];
  for (const model of models) {
    const survives = !droppedByLine.has(model.id)
      && (winners.has(model.id) || pinned.has(model.id));
    (survives ? kept : dropped).push(model);
  }
  return { models: kept, dropped };
}

/**
 * True when `winner` names its vendor and nothing else (`gpt-5.5` → line `gpt`)
 * while a tiered sibling of the same vendor has already reached a newer
 * generation (`gpt-5.6-sol`, `gpt-6-astra`).
 */
function isBareVendorHandle(
  line: string,
  winner: string,
  info: Map<string, LineInfo>,
  vendorCeiling: Map<string, number[]>,
): boolean {
  const entry = info.get(winner)!;
  if (line !== entry.vendor) return false;
  const ceiling = vendorCeiling.get(entry.vendor);
  if (!ceiling || ceiling.length === 0) return false;
  return compareVersions(entry.version, ceiling) < 0;
}

/**
 * True for pre-numbering-era names like `qwen-turbo` / `qwen-max`: no generation
 * digits anywhere, and the same vendor now ships numbered lines. Evergreen
 * aliases are exempt — they are the vendor's *current* handle, not history.
 */
function isUnnumberedLegacy(
  winner: string,
  info: Map<string, LineInfo>,
  numberedVendors: Set<string>,
): boolean {
  const entry = info.get(winner)!;
  if (entry.version.length > 0) return false;
  if (!numberedVendors.has(entry.vendor)) return false;
  return !STABLE_ALIASES.has(winner.toLowerCase());
}

/**
 * True when a line's major generation trails the vendor's newest by two or
 * more — `gpt-4-turbo` against generation 6, `glm-3-turbo` against `glm-5.3`.
 *
 * Rule 3 only compares lines that share a name, so a tier that stopped shipping
 * (`gpt-4-turbo`) never loses to a tier that kept going (`gpt-5.3-chat`); the
 * vendor-wide ceiling is what exposes it. The one-generation allowance keeps the
 * previous major generation available on purpose.
 */
function isOutdatedGeneration(
  winner: string,
  info: Map<string, LineInfo>,
  vendorCeiling: Map<string, number[]>,
): boolean {
  const entry = info.get(winner)!;
  if (entry.version.length === 0) return false;
  const ceiling = vendorCeiling.get(entry.vendor);
  if (!ceiling || ceiling.length === 0) return false;
  const major = entry.version[0] ?? 0;
  const newest = ceiling[0] ?? 0;
  return newest - major >= 2;
}

function pickWinner(members: string[], info: Map<string, LineInfo>): string | undefined {
  const alias = members.find((id) => STABLE_ALIASES.has(id.toLowerCase()));
  if (alias) return alias;
  let best = members[0];
  for (const id of members.slice(1)) {
    if (best === undefined || compareRank(info.get(id)!, info.get(best)!) > 0) best = id;
  }
  return best;
}

/** Positive when `a` should outrank `b` within the same line. */
function compareRank(a: LineInfo, b: LineInfo): number {
  const byVersion = compareVersions(a.version, b.version);
  if (byVersion !== 0) return byVersion;
  if (a.dated !== b.dated) return a.dated ? -1 : 1;
  if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
  return a.dateRank - b.dateRank;
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function describeLine(id: string): LineInfo {
  let name = id.toLowerCase();
  for (const [pattern, replacement] of GENERATION_ALIASES) {
    name = name.replace(pattern, replacement);
  }

  let dateRank = 0;
  for (const pattern of DATE_PATTERNS) {
    name = name.replace(pattern, (match) => {
      dateRank = Math.max(dateRank, dateRankOf(match));
      return '-';
    });
  }
  const dated = dateRank > 0;

  let qualified = false;
  name = name.replace(PREVIEW_QUALIFIER, () => {
    qualified = true;
    return '-';
  });

  let version: number[] = [];
  name = name.replace(VERSION_TOKEN, (_match, first: string, second?: string) => {
    const tuple = second === undefined ? [Number(first)] : [Number(first), Number(second)];
    if (compareVersions(tuple, version) > 0) version = tuple;
    return '-';
  });

  // Removing tokens leaves runs of separators behind ("glm-5.3-flash" →
  // "glm---flash"); collapse them so the same line always yields one key.
  const line = name.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const vendor = line.split('-')[0] ?? line;
  return { line, version, vendor, dated, qualified, dateRank };
}

/**
 * Normalize a date stamp to a sortable integer. Precision differs per width, so
 * the values are only meaningful within one format — which is all line-local
 * tie-breaking needs. `YYMMDD` is padded to sit alongside `YYYYMMDD`.
 */
function dateRankOf(match: string): number {
  const digits = match.replace(/\D/g, '');
  if (digits.length === 8) return Number(digits);
  if (digits.length === 6) return 20_000_000 + Number(digits);
  return Number(digits);
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
