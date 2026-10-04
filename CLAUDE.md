# ExpenseWise: notes for Claude sessions

Expense, receipt, mileage and trip app. A pnpm + Turborepo TypeScript monorepo, currently in Phase 0. Start with `docs/README.md`; decisions are in `docs/adr/`.

## Commands

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`: run all of these before any commit.
- `pnpm test:integration` needs `DATABASE_URL`. The SessionStart hook starts a local Postgres and exports it; otherwise run `pnpm db:up`.
- `pnpm contract:check` checks that `packages/api/openapi.json` and the db migrations match the code.
- `pnpm build && pnpm test:e2e`: Playwright. Locally, run `--project=desktop-chromium` with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` set by the hook. The signed-in checks (`e2e/signed-in.spec.ts`) need `DATABASE_URL` for their bench API and a build made with `NEXT_PUBLIC_SUPABASE_URL=https://e2e.supabase.invalid NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_e2e`, as CI does.
- `pnpm records:pages --out <dir> --since <previous production commit>`: builds the five published pages (traceability, backlog, architecture, data model, user stories). It refuses while the records disagree with the code.

## Invariants: don't break these

- Money is integer minor units plus an ISO 4217 code. No floats and no `Math.round` on money; use `@expensewise/domain`.
- All data access runs inside `withOrg()`. New tenant tables need `org_id`, composite FKs and an RLS policy (see CONTRIBUTING.md).
- The runtime connects as `expensewise_app`, never as Supabase's `postgres` role (it has BYPASSRLS). `assertRowSecurityApplies()` enforces this. The API never uses supabase-js or PostgREST for data (ADR-0013).
- State changes append an audit event in the same transaction. `audit_events` is append-only.
- Slow or external work goes through the outbox and workflows, never inline in a request.
- Approved expenses are locked; corrections are reversals plus a new version.
- A one-person organization self-attests approvals; any team enforces separation of duties (`canApprove`).
- The API contract is generated from code; regenerate and commit `openapi.json` with API changes.
- Receipt images and eval data never go in git.

## Conventions

- Conventional Commits, small PRs, and the PR template's Definition of Done.
- Tests sit next to domain code (`*.test.ts`). Integration tests are in `packages/db/test` (`*.int.test.ts`).
- A flaky test is a bug. Never skip, quarantine or retry to get to green.

## Records: requirements, traceability and backlog

- `tools/records/src` is the source of truth for what is required and what is next. It holds objectives, requirements, features, gaps, questions, the change log and the backlog. The code is the source of truth for what exists.
- A pull request that changes behaviour updates the records in the same PR. That means statuses, checks, any new API operation, page, workflow or flag claimed by a feature, and a change-log entry.
- It also updates the user stories in `tools/records/src/stories` (NFR-DEL-09). New or changed behaviour gets its story and Given/When/Then acceptance criteria, each criterion traced to the test that proves it. A built criterion with no test names the open backlog item that adds one. Each criterion says who decided it: the product owner (their date or question), the blueprint, or Claude. When unsure, it's Claude's, which the page asks the owner to confirm. A shared number, such as 28 days, lives once in `rules.ts`, and the checks hold the code to it.
- `pnpm test` fails when the records and the code disagree. Never weaken those checks to get to green.
- After a merge, don't post the backlog in the conversation. The merge only starts the Release run. Wait until it succeeds and production's `/api/v1/health` reports the merged commit, or the run reports that no build was needed. Then build the five pages (traceability, backlog, architecture, data model, user stories) from the latest `main` and republish them to the URLs in `tools/records/src/pages.ts`. Report with the links. Never publish after a merge alone. Publish from a branch only as a draft (`--draft`), which says so on the page.
- The technical architecture and the data model are living (NFR-DEL-08). Every pull request assesses both: revise `tools/records/src/architecture.ts` and `data-model.ts` where the change affects them, run `pnpm db:snapshot` after a migration and commit `packages/db/schema.json`, and say in the PR what was revised or why nothing was. Every report of a change, enhancement or fix to the product owner confirms the assessment: what was revised on each page, or that nothing needed to be. `pnpm test` fails when a package, setting, workflow, background function, table or function has no description.
- A requirement or answer from the product owner is recorded the same day: questions answered, requirements added as Planned with their stories and acceptance criteria, gaps opened with a backlog item.
