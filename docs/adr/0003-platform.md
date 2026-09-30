# ADR-0003: Platform

Run on Vercel, Neon Postgres, Cloudflare R2 and Inngest, with portability designed in.

- **Status:** Accepted (recommended; no objection); Amended by [ADR-0013](0013-supabase-platform.md)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-03

## Context

The delivery model needs a preview environment for every pull request, instant rollback and rolling releases ([delivery lifecycle](../06-delivery-lifecycle.md)). Receipt intelligence needs durable, retryable workflows. Receipt images must be private, uploaded directly from the client, and kept for 7 years. The builder is one AI working in daily sessions, so a fast start matters more than fine-grained infrastructure control. Hosting is in the US ([ADR-0010](0010-residency-and-compliance.md)).

## Decision

| Need | Choice | Why |
| --- | --- | --- |
| Hosting and CI | Vercel + GitHub Actions | Preview per pull request, instant rollback, rolling releases |
| Database | PostgreSQL on Neon + Drizzle | Relational integrity for money, row-level security, a database branch per pull request, point-in-time recovery |
| Files | Cloudflare R2 (S3 API) | Presigned uploads, lifecycle rules, no egress fees |
| Workflows | Inngest | Durable steps, retries, schedules and idempotency on serverless |

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| AWS-native (ECS, RDS, S3, SQS) | More control, slower start. |
| AWS ECS / Fargate + CodePipeline for hosting | Same trade-off as AWS-native: more control, slower start. Vercel gives previews per pull request, instant rollback and rolling releases out of the box. |
| Supabase or RDS / Aurora for Postgres | Neon gives a database branch per pull request, which the preview environments use. |
| AWS S3 or Vercel Blob for files | R2 offers the S3 API with no egress fees. |
| Trigger.dev, Temporal or SQS + Lambda for workflows | Temporal is heavier to run; SQS + Lambda means building durable steps ourselves. |

## Consequences

### Positive

- Every pull request gets its own preview and database branch, which gate G5 relies on.
- Rollback is instant, and flags act as kill switches.
- No egress fees on receipt images.

### Negative

- Four vendors to manage instead of one cloud, each with its own limits and pricing.
- Vendor lock-in is a standing risk (R5: medium likelihood, medium impact).
- Every vendor that touches data is a subprocessor and must sign a data processing agreement.

## Exit path / reversibility

Portability is designed in: standard Postgres, the S3 API and containerizable Node. Leaving any vendor is a migration, not a rewrite. Vendor calls sit behind adapters.

- **Neon:** any standard Postgres, including RDS / Aurora.
- **R2:** any S3-compatible store; object keys and presigned-URL flows stay the same.
- **Vercel:** a container host such as ECS / Fargate.
- **Inngest:** the least portable piece. Workflow definitions use its step API, so moving to Temporal or SQS + Lambda means re-expressing each workflow. Keeping every business decision in ordinary tested code, outside the workflow engine, limits that work.

## Links

- [Containers](../05-architecture.md#63-containers), [technology stack](../05-architecture.md#68-technology-stack)
- [Environments](../06-delivery-lifecycle.md#73-environments), [release management](../06-delivery-lifecycle.md#77-release-management-and-operations)
- [Risk register](../08-risk-register.md): R5, R6
- [ADR-0002](0002-architecture-style.md), [ADR-0010](0010-residency-and-compliance.md)
