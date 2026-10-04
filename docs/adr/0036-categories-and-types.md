# ADR-0036: Categories and types are two lists an organization keeps, and suggestions for them are rules, not a model

An organization keeps its own categories and types as two lists that each nest, with the types each category allows; every expense gets one of each, and a suggestion for them is worked out by rules from what ExpenseWise already holds, at no cost.

- **Status:** Accepted (two lists, the category narrowing the types, decided by product owner, Q7; the ready-made set, retiring, who keeps the lists and the suggestion rules recommended, no objection yet)
- **Date:** 2026-10-04
- **Deciders:** Product owner (FR-EXP-11, Oct 3; Q7; flagging, Q5); Claude (principal architect), for the model, the ready-made set and the suggestion rules
- **Decision register:** D-38. Builds on [ADR-0032](0032-features-switched-per-organization.md): it ships behind `expenses.categories`.

## Context

The product owner asked on Oct 3 for an organization's own categories and types, every expense having a type (FR-EXP-11), and answered Q7: two trees, a category filtering the types that can be chosen. Category suggestions (FR-INT-10, #18) wait on those lists, since they suggest from them. Phase 0 left a `categories` table with GL and tax codes that nothing used.

Three forces shape it:

- **Old claims must keep their coding.** A category renamed or retired can't change an expense already filed under it.
- **Switching it on must not block what works.** Every expense that exists has neither, and with the flag off nothing may change (Q5).
- **Suggestions should cost nothing.** Every receipt is already read by models at a cost (ADR-0017); a second model call per expense to guess a category would add spend for little gain, and the blueprint's enrich stage is ordinary code, with the model doing only Extract (arch §6.5).

## Decision

1. **Two lists, each nesting, and an allowance between them.** `categories` (with its GL and tax codes) and `expense_types` each have a parent within their own list. `category_types` says which types each category allows; a type may be allowed in several. Names are unique in their list, case aside, and nothing can sit under itself or anything under it. All three are tenant tables with forced row-level security.
2. **Every organization starts from a ready-made set.** Travel (Airfare, Lodging, Ground transport, Mileage), Meals (Business meal, Per-diem meal), Office (Office supplies), Software (Software) and Other (Other). One function, `seed_starter_catalog()`, seeds it: the migration runs it for every organization that exists, and creating an organization runs it in the same transaction. Each ready-made row keeps a `starter_key`, so a renamed one is still found by the keyword rules. An untouched set is no one's work, so it never stops a sign-in moving out of an empty organization.
3. **Owners and finance admins keep the lists; everyone chooses from them.** Rename, move, code, allow types, retire and restore. One no expense has may be deleted; one in use is only retired: no longer offered, but every expense that has it keeps it, shown as retired. Every change is in the audit trail.
4. **An expense gets a category and a type together.** The person chooses them, or confirms a suggestion, until the expense is submitted; the type must be one the category allows, and both must be in use. `expenses.category_id`, `type_id` and `classified_at` are set together or not at all. Only what a person chose is stored. Like any change, it reopens a closed report (ADR-0029).
5. **A suggestion is worked out when shown, by rules, never by a model.** In order: the category and type the expense's owner last chose for a similar merchant (matched as duplicates match merchants, ADR-0028), passing over one that can no longer be chosen; then what the reading says the document is (airline ticket, hotel folio, ride receipt); then whole words of the merchant's name (hotel, airlines, taxi, restaurant and some well-known names), lodging before airfare so "Delta Hotels" is a stay; a mileage expense is suggested Mileage. A keyword names a ready-made type, suggested under the ready-made category if it still allows it, else another that does. Nothing fits, nothing is suggested. It is a pure function in `@expensewise/domain`, run in the request, with no outbox: it reads only the organization's own rows.
6. **Missing says so, and holds nothing up.** With the flag on, an expense with neither chosen nor suggested says it has none, on its page and in the list; a suggestion is marked as one. It is not added to Needs you, which would fill with every expense there is the day the flag goes on, and it blocks no close or move. Whether submission should need them is Q27, built by #71 (GAP-28).
7. **Off means absent.** With `expenses.categories` off, the routes answer 404 `feature_off`, expenses carry no `category`, and Settings shows no Categories page. The rows exist either way.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| One tree, the type implying its category (Q7's recommendation A) | The product owner chose two lists, the category narrowing the types. |
| Ask a model for a category on each expense | Costs a call per expense on the organization's key, for a guess rules make nearly as well for travel spend. The reading's own document type and the person's history carry most of it. |
| Store the suggestion on the expense | It would go stale as the lists or the history change, and reports could total by a guess nobody confirmed. Working it out when shown is cheap and always current. |
| A database rule that the pair is allowed (a foreign key to `category_types`) | Taking a type out of a category would then fail, or rewrite, every old claim that used the pair. The check is made when a person chooses. |
| Seed the set in TypeScript for new organizations | Existing organizations need it from the migration too; one SQL function keeps a single copy. |
| Put a missing category in Needs you, or block closing a report | Fills Needs you on the day the flag goes on, and blocks what works today. Submission is where coding matters; Q27 asks. |

## Consequences

### Positive

- **Coding is the organization's own** and survives renames: expenses point at rows, and retired ones stay readable.
- **Suggestions cost nothing** and explain themselves: the page says whether one came from the person's last choice or from the merchant and reading.
- **The lists are ready for rules.** Attendees, a mileage rate or a receipt needed above a limit can attach to a type as each is built (#71).

### Negative

- **Keyword rules are English and travel-shaped.** A merchant whose name says nothing is left without a suggestion until the person has chosen once for it.
- **Seeded rows have random UUIDs** rather than the application's UUIDv7, as the backfill in 0007 did; nothing orders them by id.
- **History is read per request**: the newest 1,000 choices of the members on the page. That bound is ample for now and is the first thing to index or cache if it grows.

## Exit path / reversibility

- **Suggestions are one function.** A model, or rules learned from corrections across organizations (FR-INT-12), could replace it behind the same `suggested` state and `basis`, adding a basis rather than changing the API.
- **Switching the flag off hides it all at once**; removing the feature would drop the three columns on expenses and the two new tables in a later release.

## Links

- FR-EXP-11, FR-INT-10, FR-INT-12, F-43, F-15, US-RPT-12, US-RPT-13, US-EXP-05, US-EXP-06, Q7, Q27, GAP-28, #51, #18, #71
- [ADR-0028: Possible duplicates](0028-possible-duplicates.md), [ADR-0029: Expense reports](0029-expense-reports.md), [ADR-0032: Features switched per organization](0032-features-switched-per-organization.md)
