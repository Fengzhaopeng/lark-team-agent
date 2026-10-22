/**
 * Which Feishu OAuth scopes the team bot asks each user for, and how the bridge
 * recognises "this user needs to (re)authorize" from a lark-cli tool result.
 *
 * Scope policy
 * ------------
 * `lark-cli auth login --recommend` is `--domain all` (~220 scopes: mail,
 * calendar, approval, attendance, okr, vc ...). Users see a wall of consent they
 * never needed, and every lark-cli upgrade that adds a domain re-prompts
 * everyone. We ask only for domains the agent demonstrably calls.
 *
 * Usage evidence (agent transcripts, 2026-09-01 .. 2026-10-22, real Bash calls,
 * calls / distinct workspaces):
 *   docs 642/4  im 441/4  sheets 270/4  drive 154/4  wiki 37/3   -> default
 *   base 87/2 (82 from one person; 51 scopes, the biggest domain) -> on demand
 *   whiteboard 41/2 (board:* scopes are already inside `docs`)
 *   apps 107/2 (106 from one admin, spark:*)                     -> on demand
 *   minutes 9/1  contact 6/2  task 1  mail 3  calendar/vc/approval/okr 0
 * Default = what essentially everyone uses. Everything else is requested on
 * demand (see `detectAuthNeed` / `authDomainArgs`) the first time a command
 * actually fails for lack of it.
 */

/** Domains requested at first authorization. Keep this list small and boring. */
export const DEFAULT_AUTH_DOMAINS: readonly string[] = ['docs', 'drive', 'sheets', 'wiki', 'im'];

/** Domains that may be added later, on demand, when a command needs them. */
const ON_DEMAND_DOMAINS: ReadonlySet<string> = new Set([
  'base',
  'contact',
  'minutes',
  'apps',
  'task',
  'mail',
  'calendar',
  'vc',
  'approval',
  'attendance',
  'okr',
  'slides',
  'mindnotes',
  'note',
  'markdown',
]);

/** scope prefix (text before the first ':') -> lark-cli `--domain` value. */
const SCOPE_PREFIX_TO_DOMAIN: Readonly<Record<string, string>> = {
  docx: 'docs',
  docs: 'docs',
  drive: 'drive',
  space: 'drive',
  sheets: 'sheets',
  base: 'base',
  bitable: 'base',
  wiki: 'wiki',
  im: 'im',
  contact: 'contact',
  minutes: 'minutes',
  board: 'docs',
  spark: 'apps',
  application: 'apps',
  task: 'task',
  mail: 'mail',
  calendar: 'calendar',
  vc: 'vc',
  approval: 'approval',
  attendance: 'attendance',
  okr: 'okr',
  slides: 'slides',
  mindnote: 'mindnotes',
  search: 'drive',
};

/** `--domain a,b,c` argument for the default scope set. */
export function defaultAuthDomainArgs(): string[] {
  return ['--domain', DEFAULT_AUTH_DOMAINS.join(',')];
}

export type AuthNeedKind =
  /** User has no usable token at all (never authorized / expired / wiped). */
  | 'token_missing'
  /** User has a token but it lacks scope(s) this command needs. */
  | 'scope_missing';

export interface AuthNeed {
  kind: AuthNeedKind;
  /** Scopes the failing command reported as missing, when known. */
  missingScopes: string[];
  /** lark-cli `--domain` values to add for this request (deduped, may be empty). */
  domains: string[];
}

/**
 * Inspect a tool_result and decide whether the *sender's personal* authorization
 * is the thing that failed. Deliberately conservative: a bot-identity failure
 * (`"identity": "bot"`, e.g. `app_scope_not_applied`) is an app-console problem
 * that no user OAuth can fix, so it must NOT trigger a user auth card.
 */
export function detectAuthNeed(output: string, isError: boolean): AuthNeed | undefined {
  if (!output) return undefined;
  // Cheap pre-filter: only lark-cli structured errors / known phrases qualify.
  if (
    !output.includes('need_user_authorization') &&
    !output.includes('token_missing') &&
    !output.includes('missing_scope') &&
    !output.includes('"authentication"')
  ) {
    return undefined;
  }
  // Skip skill / reference text that merely *documents* these errors.
  if (!isError && !output.includes('"ok": false') && !output.includes('"ok":false')) {
    return undefined;
  }

  const identity = /"identity"\s*:\s*"(user|bot)"/.exec(output)?.[1];
  if (identity === 'bot') return undefined;

  const subtype = /"subtype"\s*:\s*"([a-z_]+)"/.exec(output)?.[1];
  const missing = extractScopes(output);

  if (subtype === 'token_missing' || output.includes('need_user_authorization')) {
    return { kind: 'token_missing', missingScopes: missing, domains: domainsForMissingScopes(missing) };
  }
  if (subtype === 'missing_scope' || (identity === 'user' && output.includes('missing_scope'))) {
    return { kind: 'scope_missing', missingScopes: missing, domains: domainsForMissingScopes(missing) };
  }
  return undefined;
}

/** Pull scope names out of a lark-cli error ("requires scope(s): a b", `scopes=a%20b`, JSON arrays). */
function extractScopes(output: string): string[] {
  const found = new Set<string>();
  const add = (s: string): void => {
    for (const tok of s.split(/[\s,;|"'\\[\]]+/)) {
      if (/^[a-z_]+(?::[a-z_.]+)+$/.test(tok)) found.add(tok);
    }
  };
  for (const m of output.matchAll(/scope\(s\):\s*([^\n"]+)/g)) add(m[1] ?? '');
  for (const m of output.matchAll(/"missing_scopes"\s*:\s*\[([^\]]*)\]/g)) add(m[1] ?? '');
  for (const m of output.matchAll(/scopes=([A-Za-z0-9%:._+-]+)/g)) {
    add(decodeURIComponent((m[1] ?? '').replace(/\+/g, ' ')));
  }
  return [...found];
}

/** Map missing scope names to the lark-cli domains that grant them. */
export function domainsForMissingScopes(scopes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of scopes) {
    const d = SCOPE_PREFIX_TO_DOMAIN[s.split(':')[0] ?? ''];
    if (d && (ON_DEMAND_DOMAINS.has(d) || DEFAULT_AUTH_DOMAINS.includes(d))) out.add(d);
  }
  return [...out];
}

/**
 * `--domain` args for an auth flow: the default set, plus any on-demand domains
 * the failing command needs. Always re-sends the full default set so a re-auth
 * never narrows what the user already relies on.
 */
export function authDomainArgs(extraDomains: readonly string[] = []): string[] {
  const all = [...new Set([...DEFAULT_AUTH_DOMAINS, ...extraDomains])];
  return ['--domain', all.join(',')];
}
