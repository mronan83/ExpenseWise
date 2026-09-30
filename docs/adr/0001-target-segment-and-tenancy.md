# ADR-0001: Target segment and tenancy

Serve individuals and small teams first, not sold commercially for now, with every user in an organization from day one.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-01

## Context

The brief asked for a full-featured platform in the spirit of Concur, Ramp and Expensify. Those are three different businesses. Concur sells governance to enterprise finance, Ramp sells a corporate card, and Expensify sells receipt automation to small businesses and individuals ([C2](../01-vision-and-scope.md#c2-concur-ramp-and-expensify-are-three-different-businesses)). Chasing feature parity with all three is how a v1 ships late ([C1](../01-vision-and-scope.md#c1-full-featured-is-a-destination-not-a-scope)).

The personas range from Riley, a solo professional, to Sam, a controller at a 60-person firm. Financial records also carry obligations from the first receipt: tenant isolation, an audit trail and retention are cheap now and expensive to retrofit ([C5](../01-vision-and-scope.md#c5-financial-records-carry-obligations-from-the-first-receipt)).

## Decision

- Target individuals and small teams. The product is not sold commercially for now.
- Every user belongs to an organization from day one, so opening the product up later is a pricing decision, not a re-architecture.
- Every table carries `org_id`, and Postgres row-level security backstops the application's own checks (AP6).
- ExpenseWise enters automation-first for individuals and teams in Phase 1 and moves toward automated control by Phase 3 ([positioning](../01-vision-and-scope.md#positioning)).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Enterprise-first: SSO, ERP and complex policy up front | This is the feature-parity path C1 warns against. Those capabilities are sequenced instead: policy engine in P2, SSO and SCIM in P3, ERP connectors in P4. |
| Individual accounts now, organizations added later | Tenancy is cheap now and expensive to retrofit (C5). |

## Consequences

### Positive

- Opening the product to more users is a pricing decision, not a re-architecture.
- Tenant isolation, the audit log and retention exist before the first real receipt.
- Solo professionals such as Riley fit the same model. A one-person organization may approve its own reports, and the audit event records the approval as a self-attestation.

### Negative

- Tenancy, row-level security and cross-tenant tests (gate G3) are built and maintained before there is a second tenant.
- Enterprise buyers are not served until later phases: SSO and SCIM arrive in Phase 3, and ERP connectors are on the Phase 4 horizon.
- Approval rules depend on organization size. Separation of duties applies whenever an organization has two or more members, so `canApprove()` returns its basis (`separation_of_duties` or `solo_self_attestation`) and the audit trail must record it.
- Cross-tenant data exposure stays a live risk (R4: low likelihood, critical impact) and needs a security review at every phase exit.

## Exit path / reversibility

The segment choice is easy to reverse. Moving up-market follows the capability map: policy engine and multi-step approval (P2), SSO and SCIM (P3), ERP connectors (P4), and a SOC 2 Type I audit when the product is sold to businesses ([ADR-0010](0010-residency-and-compliance.md)).

The organization model is the part that is hard to reverse. That is why it is in place from day one.

## Links

- [Vision and scope](../01-vision-and-scope.md)
- [Capability map](../02-capability-map.md)
- [Architecture principles](../05-architecture.md#61-architecture-principles), [security, privacy and compliance](../05-architecture.md#69-security-privacy-and-compliance)
- [Risk register](../08-risk-register.md): R1, R4
- [ADR-0010](0010-residency-and-compliance.md)
