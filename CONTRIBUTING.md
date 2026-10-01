# Contributing

How a change moves from idea to production. The full model is in [docs/06-delivery-lifecycle.md](docs/06-delivery-lifecycle.md). This page covers the mechanics.

## Flow

1. **Ready.** The story links to a journey step and a capability, has Given/When/Then acceptance criteria agreed by the product owner, and has an ADR if it is architectural.
2. **Branch.** Short-lived branches off `main`, named `<type>/<short-description>`, for example `feat/receipt-upload`.
3. **Commit.** Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `ci:`. Release notes are generated from them.
4. **Pull request.** Small and focused. The template carries the Definition of Done. Gates G1–G5 must be green.
5. **Review and accept.** An adversarial review pass, then the product owner accepts the increment.
6. **Merge and promote.** Merge to `main`, which deploys to staging once environments exist. Production promotion needs the product owner's approval.

## Rules the code relies on

- **Money** is integer minor units plus an ISO 4217 code. Use `@expensewise/domain` (`money`, `fromDecimal`, `allocate`, `convert`). ESLint blocks `parseFloat` and `Math.round` in domain code.
- **Tenancy.** Every query runs inside `withOrg(db, orgId, …)`. The API and workers connect as `expensewise_app`, which row-level security confines to one organization.
- **Audit.** Every state change calls `appendAuditEvent()` in the same transaction as the change.
- **Async work** goes through `enqueueOutbox()` in the same transaction, never a direct call to a queue.
- **API changes** start in `packages/api`. Run `pnpm --filter @expensewise/api contract:generate` and commit `openapi.json`; CI fails on drift.

## Adding a tenant table

1. Add it to `packages/db/src/schema.ts` with `org_id`, a `unique (org_id, id)` and composite `(org_id, …)` foreign keys.
2. Run `pnpm --filter @expensewise/db generate`.
3. Add grants, `ENABLE`/`FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy in a custom migration (`drizzle-kit generate --custom`).
4. `pnpm test:integration`. The policy coverage test fails if step 3 was missed.

## Database migrations

- Never edit a migration that has been merged. Add a new one.
- Expand, migrate, contract: add new structures first, move the code over, and remove old structures in a later release.
- Migrations run as the schema owner, never as `expensewise_app`.

## Decisions

Architectural choices get an ADR in `docs/adr/`: copy `0000-template.md` and use the next number. Superseding an ADR means a new ADR that links back to it; the old one is never edited to reverse it.
