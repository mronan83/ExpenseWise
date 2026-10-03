# ADR-0025: No staging environment in Phase 1

Phase 1 runs without a staging environment. A changed screen is checked on an iPhone in production, right after its release.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-10-03
- **Deciders:** Product owner
- **Decision register:** D-27

## Context

The delivery lifecycle (§7.3) planned a second, free Supabase project for staging. It would hold synthetic data, and previews and the release candidate would use it. It was never set up. On Oct 3 the product owner unticked Preview on the production credentials (#3, GAP-02). Since then a preview build has no database, so a signed-in screen on a preview has nothing on it.

The pull request template asked for each changed screen to be checked on an iPhone through its preview. That check is the defence against faults only iOS Safari shows (GAP-22), such as the overlapping date fields of Oct 3, because CI's iPhone run is WebKit on Linux. Q13 asked where the check should happen now. The product owner answered A: on production, right after each release, and declined to set up staging.

## Decision

- **No staging project in Phase 1.** Previews build and run gate G5's signed-out checks, but they hold no data. CI's own Postgres and the end-to-end bench test every signed-in screen (G5).
- **The iPhone check moves to production.** After a release that changes a screen, the product owner opens it on an iPhone in production. The pull request template and the Definition of Done say so.
- **A fault found there is fixed forward.** It gets its own pull request, which follows the same rules as any other. Rolling back is the fallback when the fix can't wait.
- **Out of scope:** gate G6's release-candidate checks (full end-to-end, evals, performance and DAST on staging). They aren't built, and they will need an environment when they are.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Staging project (Q13 B) | About 20 minutes of the product owner's setup, and one more project to migrate and keep in sync. Declined. |
| No iPhone check at all (Q13 C) | Would leave GAP-22 without any defence. |
| A paid device cloud running iOS Safari in CI (#57) | Still a separate cost decision, open as #57. |

## Consequences

### Positive

- No second project to set up, migrate or keep in sync, and nothing more to pay for or monitor.

### Negative

- An iOS-only fault is found after it reaches production, not before. With one person using the app, that cost is a fix-forward, not an outage for customers.
- Gate G6 has no environment to run in when it is built.

## Exit path / reversibility

A staging project can be added at any time. It means a second Supabase project, the migrations run against it, and Preview-scoped credentials in Vercel, all of which backlog #30 describes. Revisit before a second organization holds data in production, or when G6 is built.

## Links

- [Delivery lifecycle §7.3](../06-delivery-lifecycle.md#73-environments), [ADR-0009](0009-delivery-model.md), [ADR-0014](0014-supabase-free-plan.md)
- Backlog #3, #30 and #57; GAP-02 and GAP-22
