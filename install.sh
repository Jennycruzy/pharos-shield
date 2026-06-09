#!/usr/bin/env bash
#
# Pharos Shield — one-step installer.
#
# Tell your agent "install this skill" and point it at this repo; it runs this.
# Installs dependencies, builds the compiled server, registers the MCP server so
# you can talk to Shield in plain English, and installs the agent skill for
# Claude Code. Safe to re-run (idempotent).
#
#   bash install.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$ROOT/pharos-shield"
SERVER="$PKG/dist/mcp/server.js"

echo "==> 1/3  Installing dependencies and building (compiles dist/)…"
( cd "$PKG" && npm install )

if [ ! -f "$SERVER" ]; then
  echo "ERROR: build did not produce $SERVER" >&2
  exit 1
fi

echo "==> 2/3  Registering the MCP server (your natural-language interface)…"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove pharos-shield-mcp -s user >/dev/null 2>&1 || true
  claude mcp add pharos-shield-mcp -s user -e PHAROS_NETWORK=mainnet -- node "$SERVER"
  echo "    Registered with Claude Code (user scope)."
else
  echo "    'claude' CLI not found — skipped. For any MCP client, the config is:"
  echo "      command = node    args = [\"$SERVER\"]"
  echo "    Run  ( cd pharos-shield && npm run setup )  for per-CLI snippets."
fi

echo "==> 3/3  Installing the agent skill for Claude Code…"
SKILL_DIR="$HOME/.claude/skills"
mkdir -p "$SKILL_DIR"
ln -sfn "$PKG" "$SKILL_DIR/pharos-shield"
echo "    Linked $SKILL_DIR/pharos-shield -> $PKG"

echo
echo "Done. Open a NEW session (MCP tools load at startup), then just ask:"
echo "  \"is 0x3c2269811836af69497e5f486a85d7316753cf62 a proxy and who can upgrade it?\""
echo "  \"why did tx 0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff fail?\""
echo "  \"dry-run a balanceOf call before I sign it\""
