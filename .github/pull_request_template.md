## What and why

<!-- The user-visible change, the journey step and capability it serves (docs/02, docs/03). -->

## How it was verified

<!-- Commands run, tests added, screenshots of UI changes. -->

## Definition of Done

- [ ] Gates G1–G5 are green
- [ ] Acceptance criteria run as automated tests
- [ ] State changes emit audit events; telemetry events added where useful
- [ ] Money stays integer minor units; every new tenant table has `org_id` and a row-level security policy
- [ ] Accessibility checked (axe in G5 for new screens)
- [ ] Docs, ADRs and requirement records (`tools/records`) updated in this pull request (or not needed)
- [ ] Behind a feature flag, default off, if customer-visible
- [ ] Demonstrated on the preview environment and accepted by the product owner
