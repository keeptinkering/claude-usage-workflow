// Thin wrapper over the shared core module (core/usage.mjs, vendored to
// src/lib/usage.mjs by scripts/copy-core.mjs at prebuild/predev time). This file
// owns no fetch, token, or parse logic: it only bridges Raycast preferences into
// the core and re-exports the shaped result.

import { getPreferenceValues } from "@raycast/api";
// The vendored core is plain JS with JSDoc types. allowJs picks it up.
import {
  getUsage as coreGetUsage,
  summaryLine as coreSummaryLine,
} from "./usage.mjs";

export type Window = {
  pct: number;
  resetsAt: string;
};

export type UsageResult = {
  fiveHour: Window;
  sevenDay: Window;
  sevenDaySonnet: Window;
  cached: boolean;
};

type Preferences = {
  userAgent?: string;
  cacheSeconds?: string;
  titleWindows?: "both" | "w" | "c";
};

// Named error classes exported by the core, re-surfaced here so callers can key
// error handling off the name without importing the .mjs directly.
export type UsageErrorName =
  "NoTokenError" | "UnauthorizedError" | "RateLimitedError";

function readPrefs(): Preferences {
  return getPreferenceValues<Preferences>();
}

/**
 * Fetch usage through the shared core, wiring in Raycast preferences.
 * Throws the core's typed errors (NoTokenError / UnauthorizedError /
 * RateLimitedError) which callers can inspect via error.name.
 */
export async function getUsage(): Promise<UsageResult> {
  const prefs = readPrefs();

  const userAgent =
    prefs.userAgent && prefs.userAgent.trim().length > 0
      ? prefs.userAgent.trim()
      : undefined;

  const parsedCache = Number(prefs.cacheSeconds);
  const cacheSeconds =
    Number.isFinite(parsedCache) && parsedCache > 0 ? parsedCache : undefined;

  const result = await coreGetUsage({ userAgent, cacheSeconds });
  return result as UsageResult;
}

/**
 * One-line summary string, identical to the Alfred workflow output. Delegates to
 * the shared core so the two surfaces never drift.
 */
export function summaryLine(result: UsageResult): string {
  return coreSummaryLine(result);
}

/**
 * Map an unknown thrown value to a short human reason. Keeps the menu bar title
 * and the list error state consistent.
 */
export function reasonFor(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === "NoTokenError") {
    return "No Claude Code login";
  }
  if (name === "UnauthorizedError") {
    return "Login expired, run `claude` to sign in";
  }
  if (name === "RateLimitedError") {
    return "Rate limited, retry soon";
  }
  const message = (error as { message?: string })?.message;
  return message && message.length > 0 ? message : "Could not load usage";
}
