# Architecture decision records

The index of ExpenseWise architecture decision records (ADRs) and how to add one.

Each ADR records one decision with its context, the alternatives considered and an exit path. ADR-0001 to ADR-0012 record decisions D-01 to D-12 from the blueprint's decision register (v0.3, 30 September 2026). "Decided by product owner" records the product owner's call from 30 September 2026. "Recommended; no objection" means Claude is proceeding on it unless the product owner objects. ADR-0013 records D-13, decided after v0.3, ADR-0014 records D-16, ADR-0015 records D-17, ADR-0016 records D-18, ADR-0017 records D-19, ADR-0018 records D-20, ADR-0019 records D-21, ADR-0020 records D-22, ADR-0021 records D-23, ADR-0022 records D-24, ADR-0023 records D-25, ADR-0024 records D-26, ADR-0025 records D-27, ADR-0026 records D-28, ADR-0027 records D-29, ADR-0028 records D-30, ADR-0029 records D-31, ADR-0030 records D-32, ADR-0031 records D-33, ADR-0032 records D-34, ADR-0033 records D-35, ADR-0034 records D-36, ADR-0036 records D-38, ADR-0037 records D-39, and ADR-0038 records D-40.

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
| [0015](0015-ai-provider-keys-in-app.md) | AI provider keys configured in the app | D-17 | Accepted (decided by product owner); amended by [ADR-0020](0020-openai-fallback-reader.md) | 2026-10-02 |
| [0016](0016-several-sign-ins-per-person.md) | One person, several sign-ins | D-18 | Accepted (decided by product owner) | 2026-10-02 |
| [0017](0017-read-receipts-with-two-models.md) | Read every receipt with two models until the tier is chosen | D-19 | Accepted (decided by product owner); amended by [ADR-0020](0020-openai-fallback-reader.md), [ADR-0032](0032-features-switched-per-organization.md) and, for organizations with AI model settings on, [ADR-0033](0033-ready-on-one-confident-reading.md) | 2026-10-02 |
| [0018](0018-release-migrates-then-promotes.md) | A release migrates first, then makes the build live | D-20 | Accepted (decided by product owner); amended by [ADR-0019](0019-merge-is-the-release.md) | 2026-10-02 |
| [0019](0019-merge-is-the-release.md) | Merging is the release | D-21 | Accepted (decided by product owner) | 2026-10-02 |
| [0020](0020-openai-fallback-reader.md) | GPT-5.6 Luna reads a receipt when Claude can't | D-22 | Accepted (fallback decided by product owner; model and Ready rule recommended, no objection); amended by [ADR-0021](0021-confirming-a-reading.md) and, for organizations with AI model settings on, [ADR-0033](0033-ready-on-one-confident-reading.md) | 2026-10-02 |
| [0021](0021-confirming-a-reading.md) | A person confirms or corrects a reading that needs a look | D-23 | Accepted (actions requested by product owner; storage and rules recommended, no objection); amended by [ADR-0022](0022-expense-follows-its-receipt.md) | 2026-10-03 |
| [0022](0022-expense-follows-its-receipt.md) | An expense follows its receipt until a person edits it | D-24 | Accepted (proof and editing decided by product owner; filing rules recommended, no objection) | 2026-10-03 |
| [0023](0023-expenses-file-to-trips-by-date.md) | Expenses file to trips by date, until a person chooses | D-25 | Accepted (filing by date required by FR-EXP-04; choice, shared-day and submitted rules recommended, no objection) | 2026-10-03 |
| [0024](0024-inbound-email-through-bird.md) | Inbound email through Bird | D-26 | Accepted (vendor decided by product owner; sender and webhook checks recommended, no objection) | 2026-10-03 |
| [0025](0025-no-staging-in-phase-1.md) | No staging environment in Phase 1 | D-27 | Accepted (decided by product owner) | 2026-10-03 |
| [0026](0026-email-in-through-a-bird-mailbox.md) | Email-in through a Bird agent mailbox | D-28 | Accepted (mailbox and allowlist set up by product owner; how it is read and checked recommended, no objection) | 2026-10-03 |
| [0027](0027-email-text-as-a-pdf-receipt.md) | An emailed receipt's text becomes a PDF receipt | D-29 | Accepted (product owner asked for HTML email bodies first; how recommended, no objection) | 2026-10-03 |
| [0028](0028-possible-duplicates.md) | Possible duplicates are judged on what was read, held for the person, and deleted whole | D-30 | Accepted (requirement, merge and delete decided by product owner; matching and mechanism recommended, no objection) | 2026-10-04 |
| [0029](0029-expense-reports.md) | Expense reports gather trips and local expenses, and close within 28 days | D-31 | Accepted (lifecycle and rules decided by product owner; schedule, timing and mechanism recommended, no objection); amended by [ADR-0037](0037-organization-settings.md) | 2026-10-04 |
| [0030](0030-receipt-time-and-place.md) | A receipt's time and place are read with it, and the time zone is looked up offline | D-32 | Accepted (what is read decided by product owner; offline lookup and rules recommended, no objection) | 2026-10-04 |
| [0031](0031-duplicates-on-time-and-place.md) | Duplicates are matched on time and place, and told apart as exact or possible | D-33 | Accepted (matching and exact versus possible decided by product owner; 30-minute window and display recommended); amended by [ADR-0037](0037-organization-settings.md) | 2026-10-04 |
| [0032](0032-features-switched-per-organization.md) | Every new feature ships switched off, and each organization's owner switches it on | D-34 | Accepted (flagging every feature decided by product owner, Q5; switch per organization recommended) | 2026-10-04 |
| [0037](0037-organization-settings.md) | The organization's settings are kept on the organization, and its time zone sets the report schedule's days | D-39 | Accepted (details, who sets the window and its bounds decided by product owner, Q24; time zone, what a change touches and storage recommended, no objection yet) | 2026-10-04 |
| [0038](0038-manual-mileage.md) | A drive is an expense, paid at the IRS business rate on its date | D-40 | Accepted (what is logged and the rate copied on from the blueprint; the IRS rate, the shape and the rules recommended, Q31) | 2026-10-04 |
| [0036](0036-categories-and-types.md) | Categories and types are two lists an organization keeps, and suggestions for them are rules, not a model | D-38 | Accepted (two lists, the category narrowing the types, decided by product owner, Q7; ready-made set, retiring and suggestion rules recommended) | 2026-10-04 |
| [0033](0033-ready-on-one-confident-reading.md) | Each organization chooses its AI models, and Ready rests on one confident reading | D-35 | Accepted (switches, primary, back-ups and the operator switch decided by product owner, Q8 and Q11; Ready rule, defaults and mechanism recommended, no objection yet) | 2026-10-04 |
| [0034](0034-reference-rates-for-reimbursement.md) | Amounts are converted at the ECB's reference rate for their purchase date, and keep it | D-36 | Accepted (conversion, the person's own currency and the purchase date's reference rate decided by product owner, Q23, Q25; source, weekend rule and mechanism recommended, no objection) | 2026-10-04 |

## How to add an ADR

1. **Decide whether you need one.** A story that is architectural needs an ADR before it is Ready ([Definition of Ready](../06-delivery-lifecycle.md#76-definition-of-ready-and-definition-of-done)).
2. **Copy the template.** Copy [0000-template.md](0000-template.md) to `NNNN-short-title.md`, where `NNNN` is the next unused number (the next one is 0028). Numbers are never reused.
3. **Fill in every section.** Keep it tight. Name concrete alternatives, and give an honest exit path.
4. **Open it as Proposed.** Add a row to the index above in the same pull request.
5. **Record the outcome.** When the product owner accepts it, set the status to Accepted. Docs and ADRs are updated in the same pull request as the change they describe ([Definition of Done](../06-delivery-lifecycle.md#76-definition-of-ready-and-definition-of-done)).

## Status lifecycle

**Proposed → Accepted → Superseded**

- **Proposed.** Written and open for review; not yet in force.
- **Accepted.** In force. The body is not rewritten after acceptance; a change of direction is a new ADR.
- **Amended.** Still in force, but part of it is changed by a newer ADR. Add "Amended by ADR-NNNN" with a link to the status line; the body is not rewritten.
- **Superseded.** Replaced by a newer ADR. Set the status to "Superseded by ADR-NNNN" with a link, and link back from the new ADR.
