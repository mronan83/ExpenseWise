# Architecture decision records

The index of ExpenseWise architecture decision records (ADRs) and how to add one.

Each ADR records one decision with its context, the alternatives considered and an exit path. ADR-0001 to ADR-0012 record decisions D-01 to D-12 from the blueprint's decision register (v0.3, 30 September 2026). "Decided by product owner" records the product owner's call from 30 September 2026. "Recommended; no objection" means Claude is proceeding on it unless the product owner objects. ADR-0013 records D-13, decided after v0.3, ADR-0014 records D-16, ADR-0015 records D-17, ADR-0016 records D-18, ADR-0017 records D-19, and ADR-0018 records D-20.

## Index

| ADR | Title | Decision | Status | Date |
| --- | --- | --- | --- | --- |
| [0001](0001-target-segment-and-tenancy.md) | Target segment and tenancy | D-01 | Accepted (decided by product owner) | 2026-09-30 |
| [0002](0002-architecture-style.md) | Architecture style | D-02 | Accepted (recommended; no objection) | 2026-09-30 |
| [0003](0003-platform.md) | Platform | D-03 | Accepted (recommended; no objection); Amended by [ADR-0013](0013-supabase-platform.md) | 2026-09-30 |
| [0004](0004-iphone-technology.md) | iPhone technology | D-04 | Accepted (decided by product owner) | 2026-09-30 |
| [0005](0005-identity.md) | Identity | D-05 | Superseded by [ADR-0013](0013-supabase-platform.md) | 2026-09-30 |
| [0006](0006-receipt-extraction.md) | Receipt extraction | D-06 | Accepted (decided by product owner) | 2026-09-30 |
| [0007](0007-bank-and-card-feeds.md) | Bank and card feeds | D-07 | Accepted (decided by product owner) | 2026-09-30 |
| [0008](0008-money-and-data-conventions.md) | Money and data conventions | D-08 | Accepted (recommended; no objection) | 2026-09-30 |
| [0009](0009-delivery-model.md) | Delivery model | D-09 | Accepted (recommended; no objection) | 2026-09-30 |
| [0010](0010-residency-and-compliance.md) | Residency and compliance | D-10 | Accepted (decided by product owner) | 2026-09-30 |
| [0011](0011-travel-data-sources.md) | Travel data sources | D-11 | Accepted (recommended; no objection) | 2026-09-30 |
| [0012](0012-eval-set-composition.md) | Eval set composition | D-12 | Proposed (awaiting product owner: permission to search the owner's Gmail for past receipts) | 2026-09-30 |
| [0013](0013-supabase-platform.md) | Supabase platform | D-13 | Accepted (decided by product owner after a cost and capability comparison); Amended by [ADR-0014](0014-supabase-free-plan.md) | 2026-09-30 |
| [0014](0014-supabase-free-plan.md) | Supabase Free plan with self-managed backups | D-16 | Accepted (Free plan decided by product owner; the controls are recommended, no objection) | 2026-10-01 |
| [0015](0015-ai-provider-keys-in-app.md) | AI provider keys configured in the app | D-17 | Accepted (decided by product owner) | 2026-10-02 |
| [0016](0016-several-sign-ins-per-person.md) | One person, several sign-ins | D-18 | Accepted (decided by product owner) | 2026-10-02 |
| [0017](0017-read-receipts-with-two-models.md) | Read every receipt with two models until the tier is chosen | D-19 | Accepted (decided by product owner) | 2026-10-02 |
| [0018](0018-release-migrates-then-promotes.md) | A release migrates first, then makes the build live | D-20 | Accepted (decided by product owner) | 2026-10-02 |

## How to add an ADR

1. **Decide whether you need one.** A story that is architectural needs an ADR before it is Ready ([Definition of Ready](../06-delivery-lifecycle.md#76-definition-of-ready-and-definition-of-done)).
2. **Copy the template.** Copy [0000-template.md](0000-template.md) to `NNNN-short-title.md`, where `NNNN` is the next unused number (the next one is 0019). Numbers are never reused.
3. **Fill in every section.** Keep it tight. Name concrete alternatives, and give an honest exit path.
4. **Open it as Proposed.** Add a row to the index above in the same pull request.
5. **Record the outcome.** When the product owner accepts it, set the status to Accepted. Docs and ADRs are updated in the same pull request as the change they describe ([Definition of Done](../06-delivery-lifecycle.md#76-definition-of-ready-and-definition-of-done)).

## Status lifecycle

**Proposed → Accepted → Superseded**

- **Proposed.** Written and open for review; not yet in force.
- **Accepted.** In force. The body is not rewritten after acceptance; a change of direction is a new ADR.
- **Amended.** Still in force, but part of it is changed by a newer ADR. Add "Amended by ADR-NNNN" with a link to the status line; the body is not rewritten.
- **Superseded.** Replaced by a newer ADR. Set the status to "Superseded by ADR-NNNN" with a link, and link back from the new ADR.
