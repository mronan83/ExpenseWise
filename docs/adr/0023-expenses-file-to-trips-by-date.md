# ADR-0023: Expenses file to trips by date, until a person chooses

An expense files to the trip whose dates include its date, both ends included, with no human touch. A person can put an expense on another trip, or on none, and from then on dates never move it. On a day two trips share, the trip that ends first keeps it. A submitted expense never moves.

- **Status:** Accepted (filing by date required by FR-EXP-04; the rules for a person's choice, shared days and submitted expenses recommended, no objection); point 1 amended on Oct 6: a ticket files by the day it departs, from the product owner's goal of each trip's full picture (FR-EXP-19, GAP-40, #94)
- **Date:** 2026-10-03
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-25
- **Related:** [ADR-0022](0022-expense-follows-its-receipt.md) (an expense follows its receipt), [ADR-0008](0008-money-and-data-conventions.md) (money and data conventions, the audit trail)

## Context

Trips are how a traveler thinks about spend: the trip is the report (design: Trip timeline). FR-EXP-01 asks for a Ready reading to be filed to the trip its date falls in, with no human touch. FR-EXP-04 asks for trips with dates and a purpose, filed to by date, and FR-INS-02 for search across trips and expenses. The product owner raised them to P1 on Oct 3 (#16).

The `trips` table and `expenses.trip_id` have been in the schema since Phase 0. Nothing filed to them.

Four facts shape it:

- **Dates are right most of the time, and wrong in a known way.** A flight or a hotel is often booked, and charged, weeks before the trip. Its date says nothing about the trip it belongs to.
- **Trips can share a day.** Flying from one trip straight to the next puts the checkout of one and the dinner of the other on the same date. A short trip can sit inside a longer one.
- **Expenses and trips change in any order.** A receipt can be read while the trip it belongs to is being made, and a trip's dates can change after its expenses filed.
- **A submitted expense belongs to its report.** Moving it would change a report someone is approving.

## Decision

1. **Filed by date, both ends included.** An expense files to the member's trip whose first and last days include its date. It files again whenever its date changes: read, read again, confirmed or edited. It also files again when a trip is made, its dates change or it is deleted. An expense with no date yet is on no trip.
   - *Amended Oct 6 (#94, FR-EXP-19, GAP-40):* the day it files by is `filingDate` in the domain: the day a ticket's first leg departs (`expenses.departs_on`), when it was read or entered, else its date. A fare is usually bought weeks before it flies, so by its date it filed to no trip, and this ADR's own context foresaw it. Its date stays the day it was charged, for its claim, its month and its conversion. A change of departure files it again, as a change of date does. A local expense joins a report by the same day (ADR-0029), so a fare whose trip isn't made yet waits until it departs rather than joining the month it was bought. In SQL the day is `coalesce(departs_on, transaction_date)`, read as text so it can't shift with a time zone.
2. **A person's choice wins.** `PUT /v1/expenses/{expenseId}/trip` takes `{"tripId": …}` to put it on one of its owner's trips, or `{"tripId": null}` for none. Either sets `expenses.trip_pinned`, and from then on filing by date leaves it alone. `{"byDate": true}` hands it back to filing by date. Another member's trip is refused.
3. **On a shared day, the trip that ends first keeps it.** A hotel bill is dated the day you check out, and it is the largest item of the day. A short trip inside a longer one ends first, so it keeps its own days. Between trips that end the same day, the one that starts later wins; then the newer one. The rule is `tripFor` in the domain, and the order trips are listed in never changes the answer.
4. **Submitted or later, it stays.** Filing moves an expense only while it is processing, needs review or is Ready. A trip that a submitted expense rests on can't be deleted (409). A trip on a report that isn't submitted can be deleted, and a closed report reopens (ADR-0029).
5. **Deleting a trip files its expenses again.** That includes those a person had put on it, since the choice was of that trip. Each files by date to any other trip that covers it.
6. **Every move is recorded.** The audit events are `trip.created`, `trip.edited` (each field's old and new value), `trip.deleted` (with the expenses on it), `expense.trip_filed` (by date) and `expense.trip_set` (by a person).
7. **Filing never races and never deadlocks.** Filing takes the organization's write lock before it reads trips or locks any expense: the lock every audit append already takes and holds to commit (`lockOrgWrites`). So a receipt read while its trip is being made waits for the trip, and an expense edit can't hold the row a trip's filing needs while waiting for the lock that filing holds. A test proves the deadlock without it.
8. **Whether a trip is upcoming, under way or past is worked out where it is shown,** from the viewer's own date (`tripPhase`). `trips.status` stays `planned` until reports close trips (#23).
9. **Search** finds trips by part of the name, purpose, city or the merchant of an expense on them, and by dates. It finds expenses by part of the merchant, a date range, an amount or a trip. An amount matches in every currency it can be written in, never rounded: 18.92 finds 18.92 dollars and 18.920 dinars, never yen.
10. **A trip is at most 366 days.** A year is room for any assignment, and it stops a mistyped year from making one trip that every expense files to.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| On a shared day, the trip that starts later keeps it | Files the checkout of the first trip's hotel, the largest item that day, to the next trip. Claude first proposed this on Oct 3, then reversed it for that reason. |
| A buffer of a day or two around each trip | Catches the airport taxi the day before, but files unrelated spend near every trip and makes shared days common. A person's choice handles the exceptions exactly. |
| Ask the person whenever trips overlap | A question for every shared day is the paperwork the product exists to remove. |
| File once and never again | A trip made after its receipts, or redated, would leave its expenses behind. |
| Let filing move submitted expenses | Changes a report while someone approves it. |
| Store upcoming and under way in `trips.status` | Needs a job to flip them, and the day changes at a different moment for each traveler. |
| A row lock on the member, or no lock at all | A member lock taken after the audit lock deadlocks against a receipt read; no lock lets a receipt read while its trip is made miss the trip. |

## Consequences

### Positive

- A Ready reading is a Ready expense on the right trip with no human touch: FR-EXP-01 is whole.
- The common exception, a booking made ahead, is one choice that sticks.
- Every filing has an audit event, from the workflow or the person.

### Negative

- **A shared day is a rule, not a judgment.** Dinner on the evening you arrive at the second trip files to the first. It shows on the first trip's timeline, and one choice moves it.
- **Making or redating a trip writes an event for each expense it moves.** A trip of 40 expenses writes 40. That is the trail working, not noise.
- **Writes in one organization wait for each other a little earlier than before.** They already waited at their first audit event; filing takes the same lock at its start.

## Exit path / reversibility

- **To change the shared-day rule,** change `tripFor` in `packages/domain/src/trips.ts`. Expenses refile as their dates or trips next change; a one-off data step can refile the rest.
- **To stop filing by date,** remove the calls to `fileExpenseToTrip` and the refiling in the trip functions. Trips and choices stay.
- **To forget the choices,** set `trip_pinned` to false; the next change refiles them by date.

## Links

- [Journeys §4.2: golden path](../03-journeys-and-workflows.md#42-golden-path-a-business-trip-end-to-end)
- [App design: Trip timeline](../04-app-design.md#trip-timeline)
- [ADR-0022: An expense follows its receipt until a person edits it](0022-expense-follows-its-receipt.md)
