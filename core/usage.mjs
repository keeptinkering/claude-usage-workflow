// core/usage.mjs
//
// One dependency-free ES module that owns the Claude Code usage endpoint
// contract: token read, fetch, parse, cache. Node 18+, ESM, zero runtime deps
// (built-in fetch only). Alfred and Raycast import this; Swift mirrors it.
//
// Endpoint contract:
//   GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <oauth_access_token>
//   anthropic-beta: oauth-2025-04-20
//   User-Agent: claude-code/<version>

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// -- constants ---------------------------------------------------------------

export const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const BETA_HEADER = "oauth-2025-04-20";
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

// Pinned fallback version used when no override is supplied. Kept as a plain
// constant so a single bump covers every surface.
const PINNED_VERSION = "1.0.0";
const DEFAULT_CACHE_SECONDS = 180;

// Hard ceilings so a hung keychain prompt, CLI, or socket can never wedge a
// refresh. Without these an expired login could leave the UI stuck forever.
const KEYCHAIN_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const CLI_REFRESH_TIMEOUT_MS = 30_000;

// Treat a token this close to expiry as already expired, so we refresh before
// the request instead of eating a 401 first.
const EXPIRY_SKEW_MS = 60_000;

// -- typed errors ------------------------------------------------------------

export class NoTokenError extends Error {
  constructor(message = "No Claude Code login found") {
    super(message);
    this.name = "NoTokenError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized (401): token expired or beta header changed") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class RateLimitedError extends Error {
  constructor(message = "Rate limited (429) and no cache available") {
    super(message);
    this.name = "RateLimitedError";
  }
}

// -- token resolution --------------------------------------------------------

// Default dependency bundle for readToken. Tests inject a fake set so no real
// keychain or filesystem is touched.
const defaultTokenDeps = {
  execFileSync,
  readFileSync,
  homedir,
};

// Pull the OAuth record out of the stored blob. The documented path is
// .claudeAiOauth; any other top-level object holding an accessToken is accepted
// too, so a renamed key does not read as "not logged in".
function extractCredentials(jsonBlob) {
  const parsed = JSON.parse(jsonBlob);
  const candidates = [
    parsed?.claudeAiOauth,
    ...Object.values(parsed ?? {}),
  ];
  for (const c of candidates) {
    const token = c?.accessToken;
    if (typeof token === "string" && token.length > 0) {
      const expiresAt = Number(c.expiresAt);
      return {
        token,
        expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
      };
    }
  }
  throw new Error("no accessToken in credentials blob");
}

/**
 * Resolve the OAuth credentials (access token plus expiry, when stored).
 * Order: macOS Keychain, then ~/.claude/.credentials.json. Re-read on every
 * call so a token Claude Code refreshed in the meantime is picked up. Throws
 * NoTokenError if both fail.
 * @param {{ execFileSync?:Function, readFileSync?:Function, homedir?:Function }} [deps]
 * @returns {Promise<{ token:string, expiresAt:number|null }>}
 */
export async function readCredentials(deps = {}) {
  const d = { ...defaultTokenDeps, ...deps };

  // 1. Keychain
  try {
    const blob = d.execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS }
    );
    return extractCredentials(blob);
  } catch {
    // fall through to file
  }

  // 2. Credentials file
  try {
    const path = join(d.homedir(), ".claude", ".credentials.json");
    const blob = d.readFileSync(path, "utf8");
    return extractCredentials(blob);
  } catch {
    // fall through to throw
  }

  throw new NoTokenError();
}

/**
 * Resolve just the OAuth access token. See readCredentials.
 * @param {{ execFileSync?:Function, readFileSync?:Function, homedir?:Function }} [deps]
 * @returns {Promise<string>}
 */
export async function readToken(deps = {}) {
  return (await readCredentials(deps)).token;
}

/**
 * True when the stored expiry is in the past (or within the skew window).
 * Unknown expiry counts as not expired; the endpoint's 401 is the backstop.
 * @param {number|null} expiresAt epoch ms
 * @param {number} [now] epoch ms
 * @returns {boolean}
 */
export function isExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  return expiresAt - EXPIRY_SKEW_MS <= now;
}

// -- login refresh -----------------------------------------------------------

/**
 * Candidate paths for the Claude Code CLI. GUI launchers (Alfred, Raycast, a
 * menu bar app) start with a minimal PATH, so common install dirs are tried
 * explicitly before falling back to a bare `claude` on PATH.
 * @param {Record<string,string|undefined>} env
 * @param {string} home
 * @returns {string[]}
 */
export function claudeCandidates(env, home) {
  const list = [];
  if (env.CC_CLAUDE_BIN) list.push(env.CC_CLAUDE_BIN);
  list.push(
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "claude"
  );
  return list;
}

/**
 * Ask the Claude Code CLI to bring its own login up to date.
 *
 * The OAuth refresh token is single-use and owned by Claude Code. Refreshing
 * it here and failing to write it back would sign the user out of Claude Code
 * itself, so this app never touches the refresh token. Instead it runs
 * `claude auth status`, which loads (and if needed refreshes and saves) the
 * stored login, then the caller re-reads the store.
 *
 * Best-effort: returns true if some candidate ran, false otherwise. Never
 * throws.
 * @param {{ execFileSync?:Function, homedir?:Function, env?:object }} [deps]
 * @returns {boolean}
 */
export function refreshLogin(deps = {}) {
  const d = { ...defaultTokenDeps, ...deps };
  const env = d.env || process.env;
  for (const bin of claudeCandidates(env, d.homedir())) {
    try {
      d.execFileSync(bin, ["auth", "status"], {
        encoding: "utf8",
        timeout: CLI_REFRESH_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return true;
    } catch (err) {
      // ENOENT means this candidate is not installed; try the next one. Any
      // other failure (non-zero exit, timeout) means the CLI ran but could not
      // help, so stop.
      if (err && err.code === "ENOENT") continue;
      return true;
    }
  }
  return false;
}

// -- user agent --------------------------------------------------------------

/**
 * Resolve the User-Agent string. Honors an explicit override, then CC_UA env,
 * then falls back to claude-code/<pinned version>.
 * @param {string} [override]
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolveUserAgent(override, env = process.env) {
  if (override) return override;
  if (env.CC_UA) return env.CC_UA;
  return `claude-code/${PINNED_VERSION}`;
}

// -- raw fetch ---------------------------------------------------------------

// Default dependency bundle for fetchRaw. Tests inject a fake fetch.
const defaultFetchDeps = {
  fetch: (...args) => fetch(...args),
};

/**
 * Raw endpoint call, no cache. Returns the parsed JSON body on 200.
 * Throws UnauthorizedError on 401, RateLimitedError on 429, generic Error
 * otherwise.
 * @param {string} token
 * @param {string} userAgent
 * @param {{ fetch?:Function }} [deps]
 * @returns {Promise<object>}
 */
export async function fetchRaw(token, userAgent, deps = {}) {
  const d = { ...defaultFetchDeps, ...deps };
  const res = await d.fetch(ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": BETA_HEADER,
      "User-Agent": userAgent,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 200) {
    return await res.json();
  }
  if (res.status === 401) {
    throw new UnauthorizedError();
  }
  if (res.status === 429) {
    throw new RateLimitedError();
  }
  throw new Error(`usage endpoint returned HTTP ${res.status}`);
}

// -- formatting helpers ------------------------------------------------------

/**
 * Normalize a utilization value to an integer percent. Accepts a 0..1 fraction
 * (the endpoint shape) or a 0..100 value (defensive), returns 0..100 integer.
 * @param {number} u
 * @returns {number}
 */
export function toPct(u) {
  const n = Number(u);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct);
}

/**
 * Render a unicode progress bar of the given width for a 0..100 percent.
 * @param {number} pct
 * @param {number} [width]
 * @returns {string}
 */
export function bar(pct, width = 14) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Render an ISO reset timestamp as a relative countdown, e.g. "resets in 2h 49m".
 * @param {string} iso
 * @param {Date} [now]
 * @returns {string}
 */
export function resetRelative(iso, now = new Date()) {
  const target = new Date(iso).getTime();
  let diffMs = target - now.getTime();
  if (!Number.isFinite(target) || diffMs <= 0) return "resets soon";
  const totalMin = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

/**
 * Render an ISO reset timestamp as a local day and time, e.g. "resets Wed 10:29 PM".
 * @param {string} iso
 * @param {Date} [now] unused, kept for a symmetric signature
 * @returns {string}
 */
export function resetLocal(iso) {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "resets soon";
  const day = target.toLocaleDateString("en-US", { weekday: "short" });
  const time = target.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `resets ${day} ${time}`;
}

// -- parse -------------------------------------------------------------------

function windowFrom(raw) {
  const w = raw || {};
  return {
    pct: toPct(w.utilization),
    resetsAt: typeof w.resets_at === "string" ? w.resets_at : "",
  };
}

/**
 * Shape a raw endpoint JSON body into a UsageResult (without the cached flag).
 * @param {object} raw
 * @returns {{ fiveHour:object, sevenDay:object, sevenDaySonnet:object }}
 */
export function parseUsage(raw) {
  return {
    fiveHour: windowFrom(raw.five_hour),
    sevenDay: windowFrom(raw.seven_day),
    sevenDaySonnet: windowFrom(raw.seven_day_sonnet),
  };
}

/**
 * One-line copy string shared by Alfred and Raycast.
 * @param {{ fiveHour:{pct:number}, sevenDay:{pct:number} }} result
 * @returns {string}
 */
export function summaryLine(result) {
  const c = result?.fiveHour?.pct ?? 0;
  const w = result?.sevenDay?.pct ?? 0;
  return `Claude Code usage: session ${c}%, weekly ${w}%`;
}

// -- cache -------------------------------------------------------------------

function cachePath(opts) {
  return opts.cacheFile || join(tmpdir(), "ccu-usage.json");
}

function readFreshCache(path, cacheSeconds, deps) {
  try {
    const info = deps.statSync(path);
    const ageSeconds = (Date.now() - info.mtimeMs) / 1000;
    if (ageSeconds < cacheSeconds) {
      const raw = JSON.parse(deps.readFileSync(path, "utf8"));
      return raw;
    }
  } catch {
    // no cache or unreadable
  }
  return null;
}

// -- getUsage ----------------------------------------------------------------

const defaultUsageDeps = {
  readFileSync,
  writeFileSync,
  statSync,
  fetch: (...args) => fetch(...args),
  execFileSync,
  homedir,
};

/**
 * Full flow: cache, then token, fetch, parse, cache.
 *
 * Expired login recovery: if the stored token is past its expiry, or the
 * endpoint answers 401, ask Claude Code to refresh its login, re-read the
 * store, and retry once with the new token. If the token did not change the
 * UnauthorizedError is surfaced so the UI can tell the user to sign in again.
 * @param {{ userAgent?:string, cacheSeconds?:number, cacheFile?:string, env?:object, deps?:object }} [opts]
 * @returns {Promise<{fiveHour:object, sevenDay:object, sevenDaySonnet:object, cached:boolean}>}
 */
export async function getUsage(opts = {}) {
  const env = opts.env || process.env;
  const d = { ...defaultUsageDeps, ...(opts.deps || {}) };

  const cacheSeconds =
    opts.cacheSeconds ||
    Number(env.CC_CACHE_SECONDS) ||
    DEFAULT_CACHE_SECONDS;

  const path = cachePath(opts);
  const userAgent = resolveUserAgent(opts.userAgent, env);

  // 1. Fresh cache wins.
  const cached = readFreshCache(path, cacheSeconds, d);
  if (cached) {
    return { ...parseUsage(cached), cached: true };
  }

  // 2. Token, then fetch.
  const tokenDeps = {
    execFileSync: d.execFileSync,
    readFileSync: d.readFileSync,
    homedir: d.homedir,
  };
  const refreshAndReread = async () => {
    refreshLogin({ execFileSync: d.execFileSync, homedir: d.homedir, env });
    return readCredentials(tokenDeps);
  };

  let creds = await readCredentials(tokenDeps);
  let refreshed = false;
  if (isExpired(creds.expiresAt)) {
    creds = await refreshAndReread();
    refreshed = true;
  }

  let raw;
  try {
    try {
      raw = await fetchRaw(creds.token, userAgent, { fetch: d.fetch });
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || refreshed) throw err;
      const before = creds.token;
      creds = await refreshAndReread();
      if (creds.token === before) throw err;
      raw = await fetchRaw(creds.token, userAgent, { fetch: d.fetch });
    }
  } catch (err) {
    // On 429, serve any cache we can find regardless of freshness.
    if (err instanceof RateLimitedError) {
      try {
        const stale = JSON.parse(d.readFileSync(path, "utf8"));
        return { ...parseUsage(stale), cached: true };
      } catch {
        throw err;
      }
    }
    throw err;
  }

  // 3. Cache raw JSON, return fresh.
  try {
    d.writeFileSync(path, JSON.stringify(raw), "utf8");
  } catch {
    // caching is best-effort
  }
  return { ...parseUsage(raw), cached: false };
}
