# ExpenseWise

Receipts, mileage and trips, filed for you. ExpenseWise drafts every expense, assembles every report and chases every missing receipt, and people handle the few exceptions.

It is a web app first (a mobile-first progressive web app) and a native iPhone app later, both on one versioned API.

**Status:** Phase 0 (foundations). See the [roadmap](docs/07-roadmap.md).

## Documentation

- [docs/](docs/README.md): vision, capability map, journeys, app design, architecture, delivery lifecycle, roadmap and risks
- [Decision records](docs/adr/README.md): ADR-0001 to ADR-0012
- [Contributing](CONTRIBUTING.md): how work flows from idea to production
- [Security policy](SECURITY.md)

## Repository layout

| Path              | What it holds                                                                           |
| ----------------- | --------------------------------------------------------------------------------------- |
| `apps/web`        | Next.js app: the PWA shell, with the API mounted under `/api`                           |
| `packages/api`    | The versioned HTTP API (Hono + OpenAPI 3.1). `openapi.json` is the committed contract   |
| `packages/domain` | Business rules with no I/O: money, FX, mileage, lifecycles, approvals, audit hash chain |
| `packages/db`     | Postgres schema, migrations, row-level security, audit log and outbox                   |
| `docs`            | Docs-as-code and ADRs                                                                   |
| `scripts`         | Developer tooling, such as a local Postgres                                             |

## Getting started

You need Node 22 and pnpm 10 (`corepack enable`), plus Docker or local Postgres 16 binaries for integration tests.

```bash
pnpm install
pnpm dev                      # web app on http://localhost:3000
pnpm db:up                    # local Postgres; prints the DATABASE_URL to export
pnpm test                     # unit and property tests
pnpm test:integration         # needs DATABASE_URL
pnpm build && pnpm test:e2e   # production build plus Playwright journeys
```

## Everyday commands

| Command                                            | Gate | Runs                                                                |
| -------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | G1   | Prettier, ESLint (type-aware), TypeScript strict                    |
| `pnpm test`                                        | G2   | Vitest and fast-check; 90% coverage floor on `packages/domain`      |
| `pnpm test:integration`, `pnpm contract:check`     | G3   | Real Postgres (tenancy, audit, outbox), OpenAPI and migration drift |
| CI only                                            | G4   | gitleaks, `pnpm audit`, CodeQL                                      |
| `pnpm test:e2e`                                    | G5   | Playwright on desktop Chromium and iPhone WebKit, axe accessibility |

The gates are defined in [docs/06-delivery-lifecycle.md](docs/06-delivery-lifecycle.md).
