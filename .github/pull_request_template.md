## What and why

<!-- The user-visible change, the journey step and capability it serves (docs/02, docs/03). -->

## How it was verified

<!-- Commands run, tests added, screenshots of UI changes. -->

## Architecture and data model

<!-- Say what this change revised in tools/records/src/architecture.ts and data-model.ts (and packages/db/schema.json, via `pnpm db:snapshot`), or why neither needed revising. -->

## Definition of Done

- [ ] Gates G1–G5 are green
- [ ] Acceptance criteria run as automated tests
- [ ] State changes emit audit events; telemetry events added where useful
- [ ] Money stays integer minor units; every new tenant table has `org_id` and a row-level security policy
- [ ] Accessibility checked (axe in G5 for new screens)
- [ ] Docs, ADRs and requirement records (`tools/records`) updated in this pull request (or not needed)
- [ ] Architecture and data model assessed: revised in this pull request, or no change needed and why
- [ ] Behind a feature flag, default off, if customer-visible
- [ ] Accepted by the product owner; a changed screen checked on an iPhone in production right after its release (ADR-0025)
