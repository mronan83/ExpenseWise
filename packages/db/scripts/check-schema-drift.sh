#!/usr/bin/env bash
# Fails when src/schema.ts has changes that no committed migration captures.
# Generates into a scratch copy of migrations/ and checks that nothing new appears.
# drizzle-kit exits 0 on some errors, so its output is checked too.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=".data/drift-check" # relative: drizzle-kit mishandles absolute --out paths
rm -rf "$scratch" && mkdir -p "$scratch"
trap 'rm -rf "$scratch"' EXIT
cp -R migrations "$scratch/migrations"
before="$(ls "$scratch/migrations" | wc -l)"
if ! output="$(npx drizzle-kit generate --dialect postgresql --schema ./src/schema.ts \
  --out "$scratch/migrations" --name drift </dev/null 2>&1)" || grep -qiE '^error|Error:' <<<"$output"; then
  echo "drizzle-kit failed while checking for drift:" >&2
  echo "$output" >&2
  exit 1
fi
after="$(ls "$scratch/migrations" | wc -l)"
if [ "$before" != "$after" ]; then
  echo "src/schema.ts has changes without a migration. Run \`pnpm --filter @expensewise/db generate\` and commit it." >&2
  exit 1
fi
echo "Schema and migrations are in sync."
