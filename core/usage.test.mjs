// core/usage.test.mjs
// Run: node --test core/
// All deps are mocked. No real network, keychain, or filesystem is touched.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  toPct,
  bar,
  resetRelative,
  resetLocal,
  summaryLine,
  readToken,
  readCredentials,
  isExpired,
  refreshLogin,
  fetchRaw,
  getUsage,
  parseUsage,
  NoTokenError,
  UnauthorizedError,
  RateLimitedError,
} from "./usage.mjs";

// -- toPct -------------------------------------------------------------------

test("toPct: 0..1 fraction becomes integer percent", () => {
  assert.equal(toPct(0.18), 18);
});

test("toPct: 0..100 value passes through (defensive)", () => {
  assert.equal(toPct(18), 18);
});

test("toPct: zero is zero", () => {
  assert.equal(toPct(0), 0);
});

test("toPct: negatives and junk clamp to zero", () => {
  assert.equal(toPct(-1), 0);
  assert.equal(toPct(NaN), 0);
});

// -- bar ---------------------------------------------------------------------

test("bar: half fill at width 10", () => {
  const b = bar(50, 10);
  assert.equal(b.length, 10);
  assert.equal(b, "█████░░░░░");
});

test("bar: empty and full", () => {
  assert.equal(bar(0, 14), "░".repeat(14));
  assert.equal(bar(100, 14), "█".repeat(14));
});

// -- reset formatting with a fixed injected clock ---------------------------

test("resetRelative: hours and minutes from a fixed clock", () => {
  const now = new Date("2026-07-20T04:30:00Z");
  const iso = "2026-07-20T07:19:00Z"; // 2h 49m ahead
  assert.equal(resetRelative(iso, now), "resets in 2h 49m");
});

test("resetRelative: minutes only", () => {
  const now = new Date("2026-07-20T04:30:00Z");
  const iso = "2026-07-20T04:45:00Z"; // 15m ahead
  assert.equal(resetRelative(iso, now), "resets in 15m");
});

test("resetRelative: past time reads 'resets soon'", () => {
  const now = new Date("2026-07-20T10:00:00Z");
  const iso = "2026-07-20T09:00:00Z";
  assert.equal(resetRelative(iso, now), "resets soon");
});

test("resetLocal: renders a weekday and time", () => {
  // Assert on shape not exact tz-dependent value.
  const out = resetLocal("2026-07-22T22:29:00Z");
  assert.match(out, /^resets [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM)$/);
});

// -- summaryLine -------------------------------------------------------------

test("summaryLine: one-line copy string", () => {
  const r = { fiveHour: { pct: 18 }, sevenDay: { pct: 35 } };
  assert.equal(summaryLine(r), "Claude Code usage: session 18%, weekly 35%");
});

// -- parseUsage --------------------------------------------------------------

test("parseUsage: maps endpoint shape to windows", () => {
  const raw = {
    five_hour: { utilization: 0.18, resets_at: "2026-07-20T07:19:00Z" },
    seven_day: { utilization: 0.35, resets_at: "2026-07-22T22:29:00Z" },
    seven_day_sonnet: { utilization: 0.0, resets_at: "2026-07-22T22:29:00Z" },
  };
  const p = parseUsage(raw);
  assert.equal(p.fiveHour.pct, 18);
  assert.equal(p.sevenDay.pct, 35);
  assert.equal(p.sevenDaySonnet.pct, 0);
  assert.equal(p.fiveHour.resetsAt, "2026-07-20T07:19:00Z");
});

// -- readToken with mocked deps ---------------------------------------------

const TOKEN_BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: "tok-abc-123" },
});

test("readToken: reads from keychain first", async () => {
  const deps = {
    execFileSync: () => TOKEN_BLOB,
    readFileSync: () => {
      throw new Error("file should not be read when keychain works");
    },
    homedir: () => "/home/test",
  };
  const token = await readToken(deps);
  assert.equal(token, "tok-abc-123");
});

test("readToken: falls back to credentials file", async () => {
  const deps = {
    execFileSync: () => {
      throw new Error("no keychain");
    },
    readFileSync: (path) => {
      assert.match(path, /\.claude\/\.credentials\.json$/);
      return TOKEN_BLOB;
    },
    homedir: () => "/home/test",
  };
  const token = await readToken(deps);
  assert.equal(token, "tok-abc-123");
});

test("readToken: throws NoTokenError when both fail", async () => {
  const deps = {
    execFileSync: () => {
      throw new Error("no keychain");
    },
    readFileSync: () => {
      throw new Error("no file");
    },
    homedir: () => "/home/test",
  };
  await assert.rejects(() => readToken(deps), NoTokenError);
});

// -- fetchRaw with mocked fetch ---------------------------------------------

function fakeResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

test("fetchRaw: 200 returns parsed body and sends required headers", async () => {
  let seenUrl;
  let seenHeaders;
  const deps = {
    fetch: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return fakeResponse(200, { five_hour: { utilization: 0.5 } });
    },
  };
  const body = await fetchRaw("tok-xyz", "claude-code/1.2.3", deps);
  assert.equal(body.five_hour.utilization, 0.5);
  assert.match(seenUrl, /\/api\/oauth\/usage$/);
  assert.equal(seenHeaders.Authorization, "Bearer tok-xyz");
  assert.equal(seenHeaders["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(seenHeaders["User-Agent"], "claude-code/1.2.3");
});

test("fetchRaw: 401 throws UnauthorizedError", async () => {
  const deps = { fetch: async () => fakeResponse(401, {}) };
  await assert.rejects(() => fetchRaw("t", "ua", deps), UnauthorizedError);
});

test("fetchRaw: 429 throws RateLimitedError", async () => {
  const deps = { fetch: async () => fakeResponse(429, {}) };
  await assert.rejects(() => fetchRaw("t", "ua", deps), RateLimitedError);
});

// -- getUsage flow with mocked deps -----------------------------------------

const RAW = {
  five_hour: { utilization: 0.18, resets_at: "2026-07-20T07:19:00Z" },
  seven_day: { utilization: 0.35, resets_at: "2026-07-22T22:29:00Z" },
  seven_day_sonnet: { utilization: 0.0, resets_at: "2026-07-22T22:29:00Z" },
};

test("getUsage: fresh cache returns cached:true, never fetches", async () => {
  let fetched = false;
  const deps = {
    statSync: () => ({ mtimeMs: Date.now() }), // fresh
    readFileSync: () => JSON.stringify(RAW),
    writeFileSync: () => {},
    fetch: async () => {
      fetched = true;
      return fakeResponse(200, RAW);
    },
    execFileSync: () => TOKEN_BLOB,
    homedir: () => "/home/test",
  };
  const r = await getUsage({ deps, env: {}, cacheFile: "/x/ccu-usage.json" });
  assert.equal(r.cached, true);
  assert.equal(r.fiveHour.pct, 18);
  assert.equal(fetched, false);
});

test("getUsage: stale cache triggers fetch, returns cached:false and writes", async () => {
  let wrote = false;
  const deps = {
    statSync: () => ({ mtimeMs: Date.now() - 999 * 1000 }), // stale
    readFileSync: () => JSON.stringify(RAW),
    writeFileSync: () => {
      wrote = true;
    },
    fetch: async () => fakeResponse(200, RAW),
    execFileSync: () => TOKEN_BLOB,
    homedir: () => "/home/test",
  };
  const r = await getUsage({ deps, env: {}, cacheFile: "/x/ccu-usage.json" });
  assert.equal(r.cached, false);
  assert.equal(r.sevenDay.pct, 35);
  assert.equal(wrote, true);
});

test("getUsage: 429 serves stale cache when present", async () => {
  let firstStat = true;
  const deps = {
    // First call (freshness check) reports stale so we proceed to fetch.
    statSync: () => {
      if (firstStat) {
        firstStat = false;
        return { mtimeMs: Date.now() - 999 * 1000 };
      }
      return { mtimeMs: Date.now() - 999 * 1000 };
    },
    readFileSync: () => JSON.stringify(RAW),
    writeFileSync: () => {},
    fetch: async () => fakeResponse(429, {}),
    execFileSync: () => TOKEN_BLOB,
    homedir: () => "/home/test",
  };
  const r = await getUsage({ deps, env: {}, cacheFile: "/x/ccu-usage.json" });
  assert.equal(r.cached, true);
  assert.equal(r.fiveHour.pct, 18);
});

test("getUsage: 429 with no cache rethrows RateLimitedError", async () => {
  const deps = {
    statSync: () => {
      throw new Error("no cache file");
    },
    readFileSync: () => {
      throw new Error("no cache file");
    },
    writeFileSync: () => {},
    fetch: async () => fakeResponse(429, {}),
    execFileSync: () => TOKEN_BLOB,
    homedir: () => "/home/test",
  };
  await assert.rejects(
    () => getUsage({ deps, env: {}, cacheFile: "/x/ccu-usage.json" }),
    RateLimitedError
  );
});

// -- expired login recovery -------------------------------------------------

function blob(accessToken, expiresAt) {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
}

// A fake keychain + CLI: `security` returns the current blob, `claude auth
// status` swaps in the refreshed blob (what Claude Code does on refresh).
function fakeStore(initial, afterRefresh) {
  const state = { blob: initial, cliCalls: 0 };
  state.execFileSync = (cmd, args) => {
    if (cmd === "security") return state.blob;
    if (args && args[0] === "auth") {
      state.cliCalls += 1;
      if (afterRefresh) state.blob = afterRefresh;
      return "{}";
    }
    throw new Error(`unexpected exec ${cmd}`);
  };
  return state;
}

function noCacheDeps(store, fetch) {
  return {
    statSync: () => {
      throw new Error("no cache file");
    },
    readFileSync: () => {
      throw new Error("no file");
    },
    writeFileSync: () => {},
    fetch,
    execFileSync: store.execFileSync,
    homedir: () => "/home/test",
  };
}

test("readCredentials: returns token and expiry", async () => {
  const c = await readCredentials({
    execFileSync: () => blob("tok-1", 1234),
    homedir: () => "/home/test",
  });
  assert.deepEqual(c, { token: "tok-1", expiresAt: 1234 });
});

test("readCredentials: accepts an accessToken under another top-level key", async () => {
  const c = await readCredentials({
    execFileSync: () => JSON.stringify({ other: { accessToken: "tok-2" } }),
    homedir: () => "/home/test",
  });
  assert.equal(c.token, "tok-2");
  assert.equal(c.expiresAt, null);
});

test("readCredentials: passes a timeout to the keychain read", async () => {
  let opts;
  await readCredentials({
    execFileSync: (_cmd, _args, o) => {
      opts = o;
      return TOKEN_BLOB;
    },
    homedir: () => "/home/test",
  });
  assert.ok(opts.timeout > 0);
});

test("isExpired: past, near-future, future, unknown", () => {
  const now = 1_000_000_000;
  assert.equal(isExpired(now - 1, now), true);
  assert.equal(isExpired(now + 30_000, now), true); // inside skew
  assert.equal(isExpired(now + 3_600_000, now), false);
  assert.equal(isExpired(null, now), false);
});

test("refreshLogin: skips missing binaries and runs `claude auth status`", () => {
  const seen = [];
  const ok = refreshLogin({
    env: {},
    homedir: () => "/home/test",
    execFileSync: (bin, args) => {
      seen.push(bin);
      if (bin !== "/opt/homebrew/bin/claude") {
        const e = new Error("not found");
        e.code = "ENOENT";
        throw e;
      }
      assert.deepEqual(args, ["auth", "status"]);
      return "{}";
    },
  });
  assert.equal(ok, true);
  assert.equal(seen.at(-1), "/opt/homebrew/bin/claude");
});

test("refreshLogin: returns false when no CLI is installed", () => {
  const ok = refreshLogin({
    env: {},
    homedir: () => "/home/test",
    execFileSync: () => {
      const e = new Error("not found");
      e.code = "ENOENT";
      throw e;
    },
  });
  assert.equal(ok, false);
});

test("getUsage: 401 refreshes the login and retries with the new token", async () => {
  const store = fakeStore(blob("old", null), blob("new", null));
  const tokens = [];
  const deps = noCacheDeps(store, async (_url, init) => {
    const t = init.headers.Authorization;
    tokens.push(t);
    return t === "Bearer new" ? fakeResponse(200, RAW) : fakeResponse(401, {});
  });
  const r = await getUsage({ deps, env: {}, cacheFile: "/x/ccu-usage.json" });
  assert.equal(r.cached, false);
  assert.equal(r.fiveHour.pct, 18);
  assert.deepEqual(tokens, ["Bearer old", "Bearer new"]);
  assert.equal(store.cliCalls, 1);
});

test("getUsage: expired token is refreshed before the first request", async () => {
  const store = fakeStore(blob("old", Date.now() - 1000), blob("new", Date.now() + 3_600_000));
  const tokens = [];
  const deps = noCacheDeps(store, async (_url, init) => {
    tokens.push(init.headers.Authorization);
    return fakeResponse(200, RAW);
  });
  await getUsage({ deps, env: {}, cacheFile: "/x/ccu-usage.json" });
  assert.deepEqual(tokens, ["Bearer new"]);
  assert.equal(store.cliCalls, 1);
});

test("getUsage: 401 with no new token surfaces UnauthorizedError after one refresh", async () => {
  const store = fakeStore(blob("old", null), null);
  let calls = 0;
  const deps = noCacheDeps(store, async () => {
    calls += 1;
    return fakeResponse(401, {});
  });
  await assert.rejects(
    () => getUsage({ deps, env: {}, cacheFile: "/x/ccu-usage.json" }),
    UnauthorizedError
  );
  assert.equal(calls, 1);
  assert.equal(store.cliCalls, 1);
});
