#!/usr/bin/env bash
# Weekly check of the advisories the dependency audit (gate G4) lets through:
# auditConfig.ignoreGhsas in pnpm-workspace.yaml. Each is there only because no fixed version
# existed. This fails, and GitHub emails the owner, once one has a fix or no longer affects the
# lockfile, so an ignore is removed instead of forgotten (GAP-19).
set -euo pipefail

mapfile -t ignored < <(pnpm config get auditConfig | sed -n 's/^ignoreGhsas\[\]=//p')
if [ "${#ignored[@]}" -eq 0 ]; then
  echo "The audit ignores no advisories."
  exit 0
fi

# Audit the same lockfile without the ignore list, from a scratch directory.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp pnpm-lock.yaml package.json "$work/"
awk '/^auditConfig:/ { skip = 1; next } skip && /^[^ #]/ { skip = 0 } !skip' \
  pnpm-workspace.yaml >"$work/pnpm-workspace.yaml"
# pnpm audit exits non-zero whenever it finds anything; the report is what matters.
(cd "$work" && pnpm audit --json >audit.json) || true
if ! jq -e '.advisories' "$work/audit.json" >/dev/null 2>&1; then
  echo "::error::pnpm audit returned no report." >&2
  exit 1
fi

stale=0
for id in "${ignored[@]}"; do
  found=$(jq -c --arg id "$id" \
    '[.advisories[] | select(.github_advisory_id == $id)] | first // empty' "$work/audit.json")
  if [ -z "$found" ]; then
    echo "::error::$id no longer affects the lockfile. Remove it from auditConfig.ignoreGhsas in pnpm-workspace.yaml." >&2
    stale=1
    continue
  fi
  module=$(jq -r .module_name <<<"$found")
  patched=$(jq -r .patched_versions <<<"$found")
  # The advisory database writes "no fixed version" as the empty range <0.0.0.
  if [ "$patched" != "<0.0.0" ]; then
    echo "::error::$id ($module) now has a fix: $patched. Update to it and remove the ignore from pnpm-workspace.yaml." >&2
    stale=1
  else
    echo "$id ($module): still no fixed version, so the ignore stays."
  fi
done
exit "$stale"
