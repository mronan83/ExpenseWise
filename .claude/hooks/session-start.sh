#!/bin/bash
# SessionStart hook for Claude Code on the web: installs dependencies so lint,
# typecheck and tests work immediately, and starts a local Postgres for
# integration tests when the binaries are available. Safe to run repeatedly.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

corepack enable >/dev/null 2>&1 || true
pnpm install --prefer-offline

env_file="${CLAUDE_ENV_FILE:-/dev/null}"
{
  echo 'export NEXT_TELEMETRY_DISABLED=1'
  echo 'export TURBO_TELEMETRY_DISABLED=1'
} >>"$env_file"

# Preinstalled Chromium lets Playwright run without `playwright install`.
chromium="$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$chromium" ]; then
  echo "export PLAYWRIGHT_CHROMIUM_EXECUTABLE=$chromium" >>"$env_file"
fi

# Integration tests need Postgres. Best effort: a missing database must not block the session.
pg_bin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$pg_bin" ]; then
  echo "export PATH=\"$pg_bin:\$PATH\"" >>"$env_file"
  if PATH="$pg_bin:$PATH" bash scripts/dev-postgres.sh start >/dev/null 2>&1; then
    echo "export DATABASE_URL=$(bash scripts/dev-postgres.sh url)" >>"$env_file"
  else
    echo "Postgres did not start; integration tests will need \`pnpm db:up\`." >&2
  fi
fi
