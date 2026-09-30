# ADR-0010: Residency and compliance

Host in the US and build to OWASP ASVS Level 2 with SOC 2-ready controls; a formal audit comes when the product is sold to businesses.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-10

## Context

Receipts are tax evidence. IRS guidance calls for keeping records 3 to 7 years depending on circumstances. Approvals need an audit trail, and receipt images contain personal data ([C5](../01-vision-and-scope.md#c5-financial-records-carry-obligations-from-the-first-receipt)). The product serves individuals and small teams and is not sold commercially for now ([ADR-0001](0001-target-segment-and-tenancy.md)).

## Decision

- **Hosting.** US hosting.
- **Build standard.** OWASP ASVS Level 2 from day one, with SOC 2-ready controls.
- **Audit timing.** A formal SOC 2 Type I audit comes when the product is sold to businesses; a business customer's security review is the usual trigger.
- **Controls from Phase 0:**
  - 7-year default retention, configurable, with legal hold.
  - Deletion requests honored except where records must be kept.
  - A data processing agreement with every subprocessor.
  - Location metadata stripped from stored receipt copies.
  - Only card last four stored.
  - TLS everywhere and encryption at rest.
  - Step-up MFA for admin actions.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| EU hosting and GDPR-first | Relevant if EU users are in scope. They are not, for now. |
| A formal SOC 2 audit now | Deferred until the product is sold to businesses; a business customer's security review is the usual trigger. SOC 2-ready controls are built in the meantime. |

## Consequences

### Positive

- The controls that are cheap now and expensive to retrofit (tenant isolation, audit log, retention, PII rules) exist from the first receipt.
- The audit, when it comes, starts from controls already in place.

### Negative

- EU users are out of scope until residency is revisited.
- Without an audit, SOC 2 readiness is a claim we check ourselves; it is not independently attested.
- Keeping records for 7 years by default means paying to store receipt images and records for that long.

## Exit path / reversibility

If EU users come into scope, revisit residency and GDPR-first handling in a new ADR. Portability (standard Postgres, the S3 API and containerizable Node) makes moving or adding hosting a migration, not a rewrite ([ADR-0003](0003-platform.md)). The SOC 2 Type I audit starts when the product is sold to businesses, usually prompted by a business customer's security review.

## Links

- [Security, privacy and compliance](../05-architecture.md#69-security-privacy-and-compliance)
- [Data conventions](../05-architecture.md#67-data-conventions)
- [Risk register](../08-risk-register.md): R4
- [ADR-0001](0001-target-segment-and-tenancy.md), [ADR-0003](0003-platform.md)
