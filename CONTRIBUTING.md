# Contributing

How a change moves from idea to production. The full model is in [docs/06-delivery-lifecycle.md](docs/06-delivery-lifecycle.md). This page covers the mechanics.

## Flow

1. **Ready.** The story links to a journey step and a capability, has Given/When/Then acceptance criteria agreed by the product owner, and has an ADR if it is architectural.
2. **Branch.** Short-lived branches off `main`, named `<type>/<short-description>`, for example `feat/receipt-upload`.
3. **Commit.** Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `ci:`. Release notes are generated from them.
4. **Pull request.** Small and focused. The template carries the Definition of Done. Gates G1–G5 must be green.
5. **Review and accept.** An adversarial review pass, then the product owner accepts the increment.
6. **Merge and promote.** Merge to `main`. Vercel builds it, and the **Release** workflow waits for the product owner's approval, applies migrations, then makes that build live ([ADR-0018](docs/adr/0018-release-migrates-then-promotes.md)).

## Rules the code relies on

- **Money** is integer minor units plus an ISO 4217 code. Use `@expensewise/domain` (`money`, `fromDecimal`, `allocate`, `convert`). ESLint blocks `parseFloat` and `Math.round` in domain code.
- **Tenancy.** Every query runs inside `withOrg(db, orgId, …)`. The API and workers connect as `expensewise_app`, which row-level security confines to one organization.
- **Audit.** Every state change calls `appendAuditEvent()` in the same transaction as the change.
- **Async work** goes through `enqueueOutbox()` in the same transaction, never a direct call to a queue. The relay in `packages/workflows` hands committed events to Inngest with the outbox id as the event id, so a workflow starts once even if an event is relayed twice.
- **Feature flags.** Anything a user can see ships behind a flag in `packages/flags/src/registry.ts`, off by default (AP8). Read it on the server with `flags.isEnabled()`. Delete the flag and its off branch once it is on everywhere.
- **Errors.** Unexpected errors go to Sentry with credentials redacted, and with no request bodies, cookies, query strings or database parameters. Never put receipt contents in an error message.
- **API changes** start in `packages/api`. Run `pnpm --filter @expensewise/api contract:generate` and commit `openapi.json`; CI fails on drift.

## Adding a tenant table

1. Add it to `packages/db/src/schema.ts` with `org_id`, a `unique (org_id, id)` and composite `(org_id, …)` foreign keys.
2. Run `pnpm --filter @expensewise/db generate`.
3. Add grants, `ENABLE`/`FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy in a custom migration (`drizzle-kit generate --custom`).
4. `pnpm test:integration`. The policy coverage test fails if step 3 was missed.

## Database migrations

- Never edit a migration that has been merged. Add a new one.
- Expand, migrate, contract: add new structures first, move the code over, and remove old structures in a later release.
- A release migrates before the new build goes live, so for a minute the live code meets the new schema. Each migration must keep the previous release working.
- Migrations run as the schema owner, never as `expensewise_app`.

## Decisions

Architectural choices get an ADR in `docs/adr/`: copy `0000-template.md` and use the next number. Superseding an ADR means a new ADR that links back to it; the old one is never edited to reverse it.
