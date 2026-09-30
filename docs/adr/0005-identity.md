# ADR-0005: Identity

Use Clerk for organizations, roles, MFA, passkeys and its iOS SDK, and add enterprise SSO in Phase 3.

- **Status:** Superseded by [ADR-0013](0013-supabase-platform.md) (previously Accepted (recommended; no objection))
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-05

## Context

Every user belongs to an organization from day one ([ADR-0001](0001-target-segment-and-tenancy.md)). Phase 1 needs organizations and tenancy, and sign-in with MFA and passkeys. Access control uses five roles: Member, Approver, Finance admin, Owner and Auditor (read-only). Admin actions need step-up MFA. The iPhone app needs browser-free auth with short-lived access tokens and refresh. SSO and SCIM are Phase 3 capabilities.

Identity is a commodity. We buy it and build only what differentiates (AP7).

## Decision

- Use Clerk for organizations, roles, MFA, passkeys and its iOS SDK.
- Add enterprise SSO in Phase 3, alongside SCIM.
- Keep identity behind an adapter, like every other vendor boundary.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Self-hosted Auth.js or Better Auth | Cheaper, but with more security surface to own: sessions, MFA, passkeys and account recovery become our code to secure and maintain. |
| WorkOS | Considered in the stack review. Clerk covers organizations, roles, MFA, passkeys and an iOS SDK in one product for Phase 1. |

## Consequences

### Positive

- Organizations, roles, MFA and passkeys are available in Phase 0 without building them.
- The iOS SDK covers browser-free auth for the Phase 3 app.
- Less security surface for a team of one human and one AI builder.

### Negative

- A paid vendor on the critical path: if sign-in is down, the product is down.
- Identity data sits with a subprocessor, which must sign a data processing agreement.
- Role semantics must stay consistent between Clerk and our own Organization and Member records.

## Exit path / reversibility

Organization and Member are entities in our own schema, and every tenant row carries our `org_id`, so authorization and tenancy do not depend on the vendor's data model. Moving to Auth.js, Better Auth or WorkOS means migrating users and sessions and re-linking them to members. That is a migration, not a rewrite, but users may need to sign in again or re-enroll factors, so it should be planned rather than done on short notice.

## Links

- [System context](../05-architecture.md#62-system-context), [technology stack](../05-architecture.md#68-technology-stack)
- [Security, privacy and compliance](../05-architecture.md#69-security-privacy-and-compliance)
- [How the iPhone app slots in](../05-architecture.md#610-how-the-iphone-app-slots-in)
- [ADR-0001](0001-target-segment-and-tenancy.md), [ADR-0004](0004-iphone-technology.md)
