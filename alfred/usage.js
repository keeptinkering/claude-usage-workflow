#!/usr/bin/env node
// alfred/usage.js
//
// Thin Alfred renderer over the shared core. All endpoint, token, and cache
// logic lives in ../core/usage.mjs; this file only turns the result into
// Alfred's {"items":[...]} JSON. Bundle usage.mjs next to this file inside the
// .alfredworkflow zip so the relative import resolves.
//
// Optional Alfred workflow variables (env): CC_UA, CC_CACHE_SECONDS.

import {
  getUsage,
  bar,
  resetRelative,
  resetLocal,
  summaryLine,
  NoTokenError,
  UnauthorizedError,
  RateLimitedError,
} from "../core/usage.mjs";

function row(title, subtitle, valid, copy) {
  const item = { title, subtitle, valid: Boolean(valid) };
  if (valid && copy) {
    item.arg = copy;
    item.text = { copy };
  }
  return item;
}

function errorRow(title, subtitle) {
  return { items: [{ title, subtitle, valid: false }] };
}

async function main() {
  const r = await getUsage({
    userAgent: process.env.CC_UA,
    cacheSeconds: Number(process.env.CC_CACHE_SECONDS) || 180,
  });

  const summary = summaryLine(r);

  // Session: five_hour, relative countdown.
  const sessionTitle = `${bar(r.fiveHour.pct)}  ${r.fiveHour.pct}% used`;
  const sessionSub = `Current session · ${resetRelative(r.fiveHour.resetsAt)}`;

  // Weekly: seven_day, local day/time.
  const weeklyTitle = `${bar(r.sevenDay.pct)}  ${r.sevenDay.pct}% used`;
  const weeklySub = `Weekly · all models · ${resetLocal(r.sevenDay.resetsAt)}`;

  // Sonnet: display-only.
  const sonnetTitle = `${bar(r.sevenDaySonnet.pct)}  ${r.sevenDaySonnet.pct}% used`;
  const sonnetSub = `Weekly · Sonnet only · ${resetLocal(r.sevenDaySonnet.resetsAt)}`;

  const out = {
    items: [
      row(sessionTitle, sessionSub, true, summary),
      row(weeklyTitle, weeklySub, true, summary),
      row(sonnetTitle, sonnetSub, false),
    ],
  };

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  let title = "Claude Code usage error";
  let subtitle = err && err.message ? err.message : String(err);

  if (err instanceof NoTokenError) {
    title = "No Claude Code login found";
    subtitle = "Run `claude` and sign in, then try again.";
  } else if (err instanceof UnauthorizedError) {
    title = "Claude Code login expired (401)";
    subtitle = "Automatic refresh failed. Run `claude` and sign in again.";
  } else if (err instanceof RateLimitedError) {
    title = "Rate limited (429)";
    subtitle = "Endpoint is throttling. Wait a few minutes and retry.";
  }

  process.stdout.write(JSON.stringify(errorRow(title, subtitle)));
});
