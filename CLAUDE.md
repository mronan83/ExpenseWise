# ExpenseWise: notes for Claude sessions

Expense, receipt, mileage and trip app. A pnpm + Turborepo TypeScript monorepo, currently in Phase 0. Start with `docs/README.md`; decisions are in `docs/adr/`.

## Commands

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`: run all of these before any commit.
- `pnpm test:integration` needs `DATABASE_URL`. The SessionStart hook starts a local Postgres and exports it; otherwise run `pnpm db:up`.
- `pnpm contract:check` checks that `packages/api/openapi.json` and the db migrations match the code.
- `pnpm build && pnpm test:e2e`: Playwright. Locally, run `--project=desktop-chromium` with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` set by the hook.

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
