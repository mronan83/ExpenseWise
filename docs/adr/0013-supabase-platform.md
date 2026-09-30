# ADR-0013: Supabase platform

Consolidate identity, the database and file storage on Supabase, and keep Vercel for hosting and Inngest for workflows.

- **Status:** Accepted (product owner rejected Clerk; consolidation recommended, no objection)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-13 (decided after blueprint v0.3)
- **Supersedes:** [ADR-0005](0005-identity.md) (identity)
- **Amends:** [ADR-0003](0003-platform.md) (platform)

## Context

The product owner rejected Clerk and chose Supabase, keeping Vercel. Supabase Auth keeps users in the project's own Postgres. Running auth on Supabase with data on Neon would therefore mean two databases and two vendors for no benefit.

The architecture sets the constraints. The API is the only path to data (AP1), Postgres row-level security backstops the application's checks (AP6), and vendors sit behind adapters (AP7). The organizations and members model already lives in our own schema ([ADR-0001](0001-target-segment-and-tenancy.md)).

## Decision

| Need | Before | Now |
| --- | --- | --- |
| Identity | Clerk ([ADR-0005](0005-identity.md)) | Supabase Auth |
| Database | Neon Postgres | Supabase Postgres |
| Files | Cloudflare R2 | Supabase Storage |
| Hosting | Vercel | Vercel (unchanged) |
| Workflows | Inngest | Inngest (unchanged). Supabase Queues is Public Alpha and Cron is Beta, so neither replaces Inngest. |

### Access path

- **Architecture unchanged.** The API is the only path to data. We do not use supabase-js or PostgREST for data.
- **Token verification.** The API verifies Supabase access tokens against the project JWKS at `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. It accepts:
  - ES256 or RS256 signatures only;
  - issuer `<url>/auth/v1`;
  - audience and role `authenticated`.

  It rejects anonymous users.
- **Signing keys.** Asymmetric signing keys have been the default for new projects since 2025-10-01. The backend holds no JWT secret, and legacy HS256 keys are removed by the end of 2026.

### Hardening

- **Data API.** The Data API is disabled in the dashboard.
- **Grants.** Migration 0002 revokes every grant and default privilege from `anon`, `authenticated` and `service_role`. Tests recreate Supabase's defaults and prove the revocation.
- **Migration role.** The Supabase `postgres` role has BYPASSRLS, so it is used only for migrations. The integration's `POSTGRES_URL` must never be the runtime connection.
- **Runtime role.** The API connects as `expensewise_app` through the shared pooler in transaction mode: username `expensewise_app.<ref>`, port 6543, IPv4, which Vercel needs. It refuses to start tenant work if its role is a superuser or has BYPASSRLS.
- **Role passwords.** Custom role passwords are never in migrations, and they don't survive restores or new projects. The runbook re-sets them from secrets.
- **Timeouts.** Role statement timeouts are set in migration 0003.

### Storage

- Buckets are private. The API creates signed upload and download URLs with the server-side secret key (`sb_secret_…`), using the path layout `orgs/{orgId}/receipts/{receiptId}`.
- Signed upload URLs can't limit size or type per URL, so an outbox job validates each upload.
- Deleting the object is the only reliable cut-off for a cached signed URL.
- Database backups don't include stored files. A nightly job copies the bucket to a second provider through the S3-compatible endpoint (Phase 1), because receipt images are the audit evidence.

### Environments and cost

| Item | Decision |
| --- | --- |
| Development | Free plan. It pauses after 7 days of inactivity and has no backups. |
| Production | Upgrade to Pro before the Phase 1 dogfood month, when real financial records arrive. Pro is $25/month, includes a $10 compute credit for one Micro project, keeps daily backups for 7 days and is never paused. |
| Staging | A second project, about $10/month on Micro. Vercel previews use the staging project. |
| CI | Gates keep using a Postgres service container, so per-PR databases are not needed. |
| Branching | Deferred. Supabase Branching is Pro-only, Beta and billed hourly outside the spend cap. |
| Point-in-time recovery | Deferred until the product is sold. It costs $100/month and up and needs Small compute. |
| Region | us-east-1, next to Vercel's default function region. |

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Clerk | Rejected by the product owner. |
| Supabase Auth only, keeping Neon and R2 | Two databases, and identity split from data. |
| Self-hosted Auth.js or Better Auth | More security surface to own. |

## Consequences

### Positive

- Identity, data and files come from one vendor, and auth users live in the same Postgres as our data.
- The architecture is unchanged. The API stays the only path to data, and row-level security and adapters stay in place.

### Negative

- **Orgs and roles.** We build organization invitations and role management ourselves, on the orgs and members model that already exists.
- **Passkeys.** Passkeys are experimental (beta since 2026-05).
- **SSO and SCIM.** SAML SSO needs Pro, and there is no SCIM for end users.
- **MFA.** Phone MFA is a paid add-on; TOTP MFA is available.
- **Sign-out.** Signed-out access tokens stay valid until they expire (about 1 hour), so sensitive actions check `session_id`.
- **Step-up.** Approving someone else's spend and admin actions require aal2 (step-up MFA). A one-person organization's self-attestation does not.
- **Concentration.** More eggs in one vendor basket (R9).

## Exit path / reversibility

- **Auth users** move with a `pg_dump` of the auth schema, including their bcrypt password hashes.
- **The database** is standard Postgres and moves with `pg_dump`.
- **Storage objects** move through the S3-compatible endpoint with rclone or `aws s3 sync`.
- **Clients** are insulated: everything sits behind our own API and adapters.

## Links

- [ADR-0003](0003-platform.md) (amended), [ADR-0005](0005-identity.md) (superseded), [ADR-0001](0001-target-segment-and-tenancy.md)
- [Technology stack](../05-architecture.md#68-technology-stack), [security, privacy and compliance](../05-architecture.md#69-security-privacy-and-compliance), [how the iPhone app slots in](../05-architecture.md#610-how-the-iphone-app-slots-in)
- [Environments](../06-delivery-lifecycle.md#73-environments), [roadmap](../07-roadmap.md)
- [Risk register](../08-risk-register.md): R5, R9
