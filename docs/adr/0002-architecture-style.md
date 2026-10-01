# ADR-0002: Architecture style

Build a modular monolith in TypeScript behind a versioned API, with durable workflows for anything slow.

- **Status:** Accepted (recommended; no objection)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-02

## Context

People need an answer in about a second, while receipts need seconds of careful reading. The web app ships first and the iPhone app follows in Phase 3 as a second client, not a rewrite. The team is one human and one AI builder, so every moving part in production is a part we operate ourselves.

## Decision

- **One deployable, hard boundaries.** The API is a modular monolith with eight modules: Identity, Capture, Expenses, Trips, Approvals, Policy, Settlement and Insights. Each module owns its tables, and modules call each other only through public interfaces (AP2).
- **API-first.** Clients use a versioned, OpenAPI-described API. No business rule lives in a client (AP1). The API uses Hono in Next.js route handlers with zod-openapi and an OpenAPI 3.1 contract, versioned in the path (`/api/v1`) with a 6-month deprecation window.
- **Async by default.** Anything slow or external runs in a durable workflow with retries and idempotency (AP3).
- **One language.** TypeScript, strict, for web, API and workers, in a pnpm and Turborepo monorepo.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Microservices from day one | Operational debt with no payoff for a team this size. |
| Python backend | Its OCR advantage fades with model-based extraction, and it splits the codebase into two languages. |
| tRPC for the API | Generates TypeScript-only clients, which rules out the Swift client. |
| NestJS | Considered. Hono with zod-openapi was preferred because it is contract-first and generates both TypeScript and Swift clients. |

## Consequences

### Positive

- One deployable, typed contracts end to end, and one language across web, API and workers.
- The iPhone app consumes the same contract through a generated Swift client.
- Capture returns in about a second because slow work never runs inline.

### Negative

- Module boundaries are enforced by interfaces and review, not by the network, so they can erode without discipline.
- Modules cannot scale or release independently while they share one deployable.
- Contract changes need versioning and deprecation windows once the iPhone app ships.

## Exit path / reversibility

A module becomes a service only when it has to scale or release on its own. Because modules already own their data and talk through interfaces, extracting one is a migration, not a rewrite. The runtime is containerizable Node, so the deployable can move hosts without code changes to the modules ([ADR-0003](0003-platform.md)).

## Links

- [Architecture principles](../05-architecture.md#61-architecture-principles), [containers](../05-architecture.md#63-containers), [technology stack](../05-architecture.md#68-technology-stack)
- [ADR-0003](0003-platform.md), [ADR-0004](0004-iphone-technology.md)
