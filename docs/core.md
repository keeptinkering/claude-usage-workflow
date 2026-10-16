# Claude Code Usage: Alfred Workflow

An Alfred workflow that shows your live Claude Code usage: the rolling
**5-hour session** and the **7-day weekly** limits, with reset times. Same
numbers as the in-app `/usage` panel.

Trigger: type `ccu` in Alfred.

```
███░░░░░░░░░░░  18% used   Current session · resets in 2h 49m
█████░░░░░░░░░  35% used   Weekly · all models · resets Wed 10:29 PM
```

---

## How it works

The panel in Claude Code is not computed locally. It comes from an
Anthropic endpoint that returns your authoritative usage. The workflow
calls that same endpoint and renders the result as Alfred rows.

### The endpoint

```
GET https://api.anthropic.com/api/oauth/usage
```

Undocumented and beta. It is what Claude Code's own `/usage` HUD reads.

Required headers:

| Header | Value | Why |
|---|---|---|
| `Authorization` | `Bearer <oauth_access_token>` | Your Claude Code login |
| `anthropic-beta` | `oauth-2025-04-20` | Without it you get `401` |
| `User-Agent` | `claude-code/<version>` | Without it you hit an aggressive `429` bucket |

Response shape:

```json
{
  "five_hour":        { "utilization": 0.18, "resets_at": "2026-07-20T07:19:00Z" },
  "seven_day":        { "utilization": 0.35, "resets_at": "2026-07-22T22:29:00Z" },
  "seven_day_sonnet": { "utilization": 0.00, "resets_at": "2026-07-22T22:29:00Z" }
}
```

`utilization` is a fraction from 0 to 1. The script multiplies by 100 for the
percentage (and tolerates a 0-100 shape defensively). `resets_at` is UTC ISO;
the script renders the session as a relative countdown and the weekly as a
local day/time.

### Where the token comes from

Claude Code authenticates with OAuth, not an API key. The access token is
resolved in this order:

1. **macOS Keychain**, service `Claude Code-credentials`, read with
   `security find-generic-password -s "Claude Code-credentials" -w`. The stored
   password is a JSON blob; the token is at `.claudeAiOauth.accessToken`.
2. **Credentials file**, `~/.claude/.credentials.json`, same JSON path.

Nothing leaves your machine except the request to `api.anthropic.com`.

### Expired login

The access token is short-lived. Claude Code renews it with a single-use
refresh token, but only while the CLI runs, so a menu bar or launcher can be
left holding an expired token. When the stored token is past its `expiresAt`,
or the endpoint answers `401`, the core runs `claude auth status`, which lets
Claude Code renew and save its own login, then re-reads the store and retries
once. The refresh token itself is never read or used here: spending it without
writing the result back would sign you out of Claude Code.

Set `CC_CLAUDE_BIN` if the CLI lives somewhere other than `~/.local/bin`,
`~/.claude/local`, `/opt/homebrew/bin`, or `/usr/local/bin`.

### Caching

The endpoint rate-limits hard, and once throttled it can stay `429` for a
while with no `Retry-After`. To stay clear of that, the successful response is
cached to a temp file for ~180 seconds. Rapid re-triggers of `ccu` reuse the
cache instead of hammering the endpoint.

---

## The pieces

The workflow bundle (`Claude Code Usage.alfredworkflow`) is a zip of two files.

### `info.plist`

Defines one **Script Filter** object (keyword `ccu`, no argument) wired to a
**Copy to Clipboard** output. The Script Filter runs a small bash shim whose
only job is to find a `node` binary and run `usage.js`:

```bash
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Append newest nvm-installed node, if any
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_NODE_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort | tail -n1)"
  [ -n "$NVM_NODE_DIR" ] && export PATH="$NVM_NODE_DIR:$PATH"
fi

NODE_BIN="$(command -v node || true)"
# ...fallbacks to common install paths...

"$NODE_BIN" usage.js
```

The PATH gymnastics exist because GUI apps like Alfred launch with a minimal
`PATH` that usually excludes Homebrew, nvm, and bun. Alfred runs the Script
Filter with the working directory set to the workflow folder, so `usage.js`
resolves by name.

Workflow variables (optional, set in Alfred): `CC_UA` (override User-Agent),
`CC_CACHE_SECONDS` (override the 180s cache).

### `usage.js`

Plain Node, no dependencies (uses the built-in `fetch`, so Node 18+). Flow:

1. Return the cache if it is fresh.
2. Read the OAuth token (Keychain → file).
3. `fetch` the endpoint with the three required headers.
4. Cache the raw JSON.
5. Convert each window to a percent, a Unicode bar, and a reset string, then
   print Alfred's `{"items":[...]}` JSON.

Each usage window becomes one Alfred row. The session and weekly rows are
`valid` (Enter copies a one-line summary); the Sonnet-only row is display-only.

---

## Setup

1. Double-click `Claude Code Usage.alfredworkflow` to import it into Alfred.
2. Make sure you are signed into Claude Code (`claude`), this is the OAuth
   login the token comes from, **not** an `ANTHROPIC_API_KEY`.
3. Have Node 18+ installed and reachable (Homebrew, nvm, or bun).
4. Type `ccu`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Node not found" | Alfred's minimal PATH | Install Node, or add its bin dir to the shim's PATH |
| "No Claude Code login found" | Not signed in, or token stored elsewhere | Run `claude` and sign in |
| `401` | Login expired and the automatic refresh could not renew it, or the beta header changed | Run `claude` and sign in again; update `oauth-2025-04-20` if Anthropic bumped it |
| `429` | Endpoint throttling | Wait a few minutes; cached results are served meanwhile |

---

## Caveats

- **Undocumented + beta.** The endpoint and its dated beta header
  (`oauth-2025-04-20`) are not in Anthropic's public API reference and can
  change without notice. A header bump breaks it silently until updated.
- **Policy.** A Feb 2026 policy restricts OAuth tokens to official Anthropic
  clients. This reads your own account data, read-only, on demand, but the
  endpoint could be locked down at any time.
- **Weekly reset detail.** The weekly window resets on a 7-day rolling basis
  (reset time shown per response), not at a fixed calendar boundary.

---

## Why not ccusage?

[`ccusage`](https://github.com/ryoppippi/ccusage) reads local `~/.claude`
JSONL logs and is excellent for **token/cost** breakdowns. But it estimates
against your own history, it cannot report the official session/weekly
**limit percentages**. Those only exist server-side, behind this endpoint.
This workflow uses the endpoint precisely to match what `/usage` shows.