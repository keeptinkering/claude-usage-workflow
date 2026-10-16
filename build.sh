#!/usr/bin/env bash
#
# build.sh: produce distributable artifacts for each surface into ./.build/
#
# Usage:
#   ./build.sh [alfred|raycast|macos|all|1|2|3|4]
#   With no arg it shows an interactive menu.
#
# Output (all under ./.build/, which is gitignored):
#   alfred  -> ".build/Claude Code Usage.alfredworkflow"
#   raycast -> ".build/raycast-extension.zip"
#   macos   -> ".build/ClaudeUsage.app" and ".build/ClaudeUsage.dmg"
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/.build"
mkdir -p "$OUT"

log()  { printf '==> %s\n' "$*"; }
step() { printf '    %s\n' "$*"; }

build_alfred() {
  log "alfred"
  local plist="$ROOT/alfred/info.plist"
  local stage="$OUT/alfred-stage"
  local artifact="$OUT/Claude Code Usage.alfredworkflow"

  [ -f "$plist" ] || { echo "missing alfred/info.plist (defines the ccu Script Filter)"; return 1; }
  [ -f "$ROOT/alfred/usage.js" ]  || { echo "missing alfred/usage.js"; return 1; }
  [ -f "$ROOT/core/usage.mjs" ]   || { echo "missing core/usage.mjs"; return 1; }

  rm -rf "$stage"; mkdir -p "$stage"

  # info.plist is the source that defines the ccu Script Filter.
  step "copy info.plist"
  cp "$plist" "$stage/info.plist"

  # ESM: the bundle needs type:module so usage.js can use import.
  step "write package.json (type:module)"
  printf '{\n  "name": "claude-code-usage-alfred",\n  "private": true,\n  "type": "module"\n}\n' > "$stage/package.json"

  # Vendor the shared core next to the entry, and rewrite the dev import
  # path (../core/usage.mjs) to the flat bundle layout (./usage.mjs).
  step "vendor core + rewrite import path"
  cp "$ROOT/core/usage.mjs" "$stage/usage.mjs"
  sed 's#\.\./core/usage\.mjs#./usage.mjs#g' "$ROOT/alfred/usage.js" > "$stage/usage.js"

  step "syntax check"
  node --check "$stage/usage.mjs"
  node --check "$stage/usage.js"

  # Workflow icon (shown in Alfred). Optional: include only if generated.
  local icon_files=""
  if [ -f "$ROOT/alfred/icon.png" ]; then
    cp "$ROOT/alfred/icon.png" "$stage/icon.png"
    icon_files="icon.png"
  fi

  step "zip bundle"
  rm -f "$artifact"
  ( cd "$stage" && zip -q -r -X "$artifact" info.plist package.json usage.js usage.mjs $icon_files )
  rm -rf "$stage"
  step "built: ${artifact#$ROOT/}"
}

build_raycast() {
  log "raycast"
  local dir="$ROOT/raycast"
  local artifact="$OUT/raycast-extension.zip"
  [ -d "$dir" ] || { echo "missing raycast/"; return 1; }

  if [ ! -d "$dir/node_modules" ]; then
    step "npm install"
    ( cd "$dir" && npm install --silent )
  fi

  # `npx ray build` skips the npm prebuild hook, so vendor the core here.
  step "vendor core"
  ( cd "$dir" && node scripts/copy-core.mjs >/dev/null )

  step "ray build (validate)"
  ( cd "$dir" && npx --no-install ray build ) || { echo "ray build failed"; return 1; }

  # Distributable = source zip minus node_modules and generated files.
  step "zip source"
  rm -f "$artifact"
  ( cd "$dir" && zip -q -r "$artifact" . \
      -x 'node_modules/*' -x '.build/*' -x 'raycast-env.d.ts' )
  step "built: ${artifact#$ROOT/}"
}

build_macos() {
  log "macos"
  local pkg="$ROOT/macos/ClaudeUsage"
  local app_src="$pkg/../build/ClaudeUsage.app"
  [ -x "$pkg/build.sh" ] || { echo "missing macos/ClaudeUsage/build.sh"; return 1; }

  step "swift build + assemble .app"
  ( cd "$pkg" && ./build.sh )

  [ -d "$app_src" ] || { echo "expected app not found at $app_src"; return 1; }

  step "copy .app"
  rm -rf "$OUT/ClaudeUsage.app"
  cp -R "$app_src" "$OUT/ClaudeUsage.app"

  # DMG: stage the app next to an /Applications symlink so the user can
  # drag-install, then pack a compressed (UDZO) image via hdiutil.
  step "build dmg"
  local dmg="$OUT/ClaudeUsage.dmg"
  local dmgstage="$OUT/dmg-stage"
  rm -rf "$dmgstage" "$dmg"
  mkdir -p "$dmgstage"
  cp -R "$app_src" "$dmgstage/ClaudeUsage.app"
  ln -s /Applications "$dmgstage/Applications"
  hdiutil create -quiet -volname "ClaudeUsage" -srcfolder "$dmgstage" \
    -ov -format UDZO "$dmg"
  rm -rf "$dmgstage"
  step "built: .build/ClaudeUsage.app + .build/ClaudeUsage.dmg"
}

prompt_menu() {
  # Ask interactively when no arg was given. Prompt goes to stderr so the
  # chosen value is the only thing on stdout.
  {
    echo "What to build?"
    echo "  1) alfred    Alfred workflow bundle"
    echo "  2) raycast   Raycast extension zip"
    echo "  3) macos     macOS .app + .dmg"
    echo "  4) all       all of the above"
  } >&2
  local choice
  read -r -p "Enter 1-4 [4]: " choice >&2
  echo "${choice:-4}"
}

TYPE="${1:-}"
[ -z "$TYPE" ] && TYPE="$(prompt_menu)"

case "$TYPE" in
  1|alfred)  build_alfred ;;
  2|raycast) build_raycast ;;
  3|macos)   build_macos ;;
  4|all)     build_alfred; build_raycast; build_macos ;;
  *) echo "unknown choice: $TYPE"; echo "usage: ./build.sh [alfred|raycast|macos|all|1|2|3|4]"; exit 2 ;;
esac

log "done. artifacts in ${OUT#$ROOT/}/"
ls -1 "$OUT"
