# ClaudeUsage (macOS menu bar app)

A native SwiftUI menu bar app that shows your live Claude Code usage next to the
clock: `W 35% . C 18%` (W = weekly / seven day, C = session / five hour). Click
it for a detail popover with Refresh and Quit.

## Requirements

- macOS 13.0 or newer.
- Xcode command line tools with Swift 5.9+ (built and tested with Swift 6.2).
- A signed-in Claude Code CLI (the app reads its OAuth token, read only).

## Build

```sh
cd macos/ClaudeUsage
./build.sh
```

This compiles a release binary with `swift build -c release`, assembles
`macos/build/ClaudeUsage.app`, and ad-hoc codesigns it.

## Run

The bundle is ad-hoc signed, not notarized, so Gatekeeper will warn on first
launch. Bypass it once:

- In Finder, right-click `macos/build/ClaudeUsage.app` and choose **Open**, then
  confirm. macOS remembers the choice for later launches.

The app has `LSUIElement = YES`, so it runs as a menu-bar-only agent: no Dock
icon and no main window. Look for `W .. . C ..` near the clock.

## What it does

- Reads the OAuth access token, same order as the rest of the project:
  1. Keychain via `security find-generic-password -s "Claude Code-credentials" -w`.
  2. Fallback file `~/.claude/.credentials.json`.
- Calls `GET https://api.anthropic.com/api/oauth/usage` with the three required
  headers and refreshes on a timer (default 180s), on launch, on manual refresh,
  and on popover open when the cache is stale.
- Keeps the last good numbers in memory and marks them with a `*` when a refresh
  fails (for example a 429), so the title is never blank.

## States

- No login: title shows `Claude !`, popover explains how to sign in.
- Expired token: the app runs `claude auth status` so Claude Code renews its own
  login, re-reads the Keychain, and retries once. If that still fails (401), last
  good data stays, marked stale, and the popover asks you to sign in again.
- Rate limit (429) or network error: last good data stays, marked stale.
- Keychain and CLI calls run off the main thread with timeouts, so a pending
  Keychain prompt or a slow CLI never freezes the menu bar.
- First load: title shows `Claude ...`.

## Configuration

There is no in-app Settings UI. The app runs on sensible defaults: title shows
both windows, severity color dot on (green under 50%, yellow under 80%, red at or
above 80%), refresh and cache at 180 seconds, User-Agent auto-detected from
`claude --version` (else a pinned fallback). Advanced users can override the
`UserDefaults` keys for `com.narayann7.ClaudeUsage` via `defaults write`.

## Note on sandboxing

The app is **non-sandboxed** by design. It shells out to `security` to read the
Keychain and to `claude --version` for the User-Agent, both of which the App
Sandbox blocks. It only reads local credentials and calls a single HTTPS
endpoint. A future sandbox plus notarization path would switch to the SecItem
API with a Keychain access group.
