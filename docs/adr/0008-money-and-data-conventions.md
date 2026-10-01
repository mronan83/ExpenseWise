# ADR-0008: Money and data conventions

Store money as integer minor units with ISO 4217 codes, times as UTC instants with local dates, IDs as UUIDv7, and never hard-delete financial records.

- **Status:** Accepted (recommended; no objection)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-08

## Context

Receipts are tax evidence, and approvals need an audit trail ([C5](../01-vision-and-scope.md#c5-financial-records-carry-obligations-from-the-first-receipt)). Approved records must never be edited (AP4), and money must be exact (AP5). The iPhone app will capture offline and sync later, so IDs must be safe to generate on a phone. Rates change over time, and a later change must never alter an old claim.

## Decision

- **Money:** integer minor units plus an ISO 4217 code. Converted amounts store the rate, its source and its date. We never use floats for money.
- **Time:** instants in UTC, and transaction dates as local calendar dates. An 11 pm dinner in Tokyo stays on that day.
- **Identifiers:** UUIDv7, which is time-ordered and safe to generate on a phone while offline, so the ID doubles as the idempotency key for a sync.
- **No hard deletes of financial records:** corrections are reversals and new versions.
- **Snapshots over lookups:** mileage rate, FX rate, policy version and category mapping are copied onto the record at the time they applied.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Decimal columns for money | Acceptable, per the decision register. Integer minor units with a currency code were preferred as the single convention (AP5). |
| Floats for money | Never. Rounding errors are unacceptable in financial records. |
| Look up rates and mappings at read time | A later rate or policy change would silently alter old claims. |
| Editing or deleting records in place | Loses what was approved and breaks the audit trail. |

## Consequences

### Positive

- Money math is exact. Property tests hold invariants: splits sum to the total, and conversions round-trip within one minor unit.
- Old claims never change when rates, policies or mappings change.
- Offline captures sync exactly once.

### Negative

- Every amount needs its currency code handled and formatted correctly, at every boundary.
- Corrections take more work than edits: a reversing entry plus a new version.
- Storage grows over time, since financial records and their versions are never deleted.

## Exit path / reversibility

Moving money columns to decimals is acceptable per the decision register and would be a data migration run through the expand, migrate, contract process. The no-hard-delete and snapshot rules are effectively one-way: records created under them keep their history, and that history is the point. UUIDv7 IDs can coexist with any later ID scheme.

## Links

- [Data conventions](../05-architecture.md#67-data-conventions), [domain model](../05-architecture.md#66-domain-model)
- [Test strategy](../06-delivery-lifecycle.md#75-test-strategy), [release management](../06-delivery-lifecycle.md#77-release-management-and-operations)
- [Mileage](../03-journeys-and-workflows.md#43-mileage)
