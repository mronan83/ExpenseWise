#!/bin/bash
# PostToolUse hook: after a pull request is merged, remind the session that the merge starts
# the release, and that the four pages are republished only after the release succeeds.
set -euo pipefail

input=$(cat)
if ! grep -qE '"tool_name": ?"mcp__github__merge_pull_request"|pulls/[0-9]+/merge' <<<"$input"; then
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A pull request was merged. The merge starts the Release run (ADR-0019); it is not yet the release. Don't post the backlog in the conversation. Note the version production served before the merge, then watch the Release run. Only when it succeeds and /api/v1/health reports the merged commit (or the run reports that no build was needed): check out the latest main, run `pnpm records:pages --out <scratchpad dir> --since <that earlier version>`, and republish all four pages (traceability, backlog, architecture, data model) to the URLs in tools/records/src/pages.ts. Then report the release with the links, and confirm what the release revised in the architecture and the data model, or that nothing needed revising (NFR-DEL-08). If the merged change altered behaviour without updating tools/records, open a follow-up pull request that does."}}
JSON
