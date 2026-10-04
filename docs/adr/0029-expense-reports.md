# ADR-0029: Expense reports gather trips and local expenses, and close within 28 days

A report is a member's claim for reimbursement. Trips join it 24 hours after their return date and local expenses 24 hours after their own date. An hourly schedule does the joining, and closes reports on day 28. The person can close a report early, move trips between reports, and reopen a closed report until it is submitted. Any change to a closed report reopens it.

- **Status:** Accepted (lifecycle and rules decided by product owner, Oct 4; schedule, timing and mechanism recommended, no objection); point 3 amended by [ADR-0037](0037-organization-settings.md), which counts the days in the organization's time zone
- **Date:** 2026-10-04
- **Deciders:** Product owner (what a report holds, when it opens and closes, local expenses); Claude (principal architect), for the design
- **Decision register:** D-31. Amends the report lifecycle in journeys §4.5 and the 48-hour rule in §4.6. Builds on [ADR-0023](0023-expenses-file-to-trips-by-date.md).

## Context

The product owner's answers of Oct 4 (FR-EXP-05, FR-EXP-12, FR-EXP-14, Q20, Q21) replace the roadmap's report drafted per trip 48 hours after it ends:

- **What a report holds.** A report holds one or more trips. Expenses on no trip are local, need a justification, and go on reports too.
- **When things join.** A trip joins the open report 24 hours after its return date. With no open report, a new one opens for it. Trips can be moved from one report to another.
- **Closing.** A report is closed within 28 days of opening, or it closes itself. It can't close while expenses on it need review. As day 28 nears, it warns that reimbursement will be delayed.
- **Day 28 with work left.** A trip still needing review moves to the next report, or the person moves it.
- **Submitting.** Closing never submits; submitting is the person's own act. Only a closed report can be submitted. A closed report can be reopened until it is submitted, and a submitted report is locked.
- **Notice.** The person is told in the app, on Home and in Needs you.

The schema had a report pointing at one trip (`reports.trip_id`), unused, and a report lifecycle that went from open straight to submitted. Nothing in the app ran on a schedule except the outbox relay.

## Decision

1. **A trip points at its report.** `trips.report_id` links a trip to its report, and its expenses go with it. A local expense, one with a date and no trip, points at a report itself through `expenses.report_id`. A check forbids an expense with both a trip and a report of its own. Both links are composite keys that include the member, so a report holds only its member's trips and expenses. `reports.trip_id` is dropped.
2. **Reports gain a closed state.** The lifecycle is open, then closed, then submitted (#24), then on to approval. A check keeps `closed_at` set exactly when a report isn't open. `closes_at` holds day 28.
3. **The 24 hours are counted so no one sees a join early.** Something dated D joins at noon UTC on D+2. That is 24 hours after D has ended everywhere, since the day ends last at UTC−12. Where the day ends earlier, the wait is longer: about 31 hours in US Central time and up to 50 hours at UTC+14. (This line said 26 hours until Oct 4, when writing the user stories found the error.) The organization's time zone (#63) can bring it to 24 hours wherever the organization is.
4. **An hourly schedule does the work.** An Inngest cron at seven minutes past each hour does the scheduled work.
   - It asks the database which organizations have work due. `report_work_due()` runs as its owner and answers with ids only.
   - It then works inside each organization as the app, in one transaction:
     - Due trips and local expenses join the member's newest open report, or a new one.
     - Reports on day 28 close with what is ready. Trips and local expenses still needing review move to the next open report, opened for them if need be.
     - A report with nothing ready waits, overdue, rather than moving everything.
     - An open report with nothing to claim is dropped.
   - Nothing joins twice and a closed report stays closed, so a retried run is safe. About 720 runs a month sit well within the free plan.
5. **What holds a report open:**
   - a trip with an expense still being read or needing review, possible duplicates included;
   - a local expense needing review, or with no justification.

   A trip whose expenses have all moved away doesn't count. Totals are per currency and never converted until #62. Possible duplicates are left out of totals.
6. **The person:**
   - closes a report with nothing left to review;
   - reopens a closed one until it is submitted. It then keeps its day 28, or gets a week from reopening if that is later;
   - moves a trip or local expense between open reports, or to a new one. A report left holding nothing is dropped;
   - writes a local expense's justification, up to 500 characters.
7. **Any change to a closed report reopens it.** The change can be an edit, a receipt read again, a trip's dates changed, an expense moving trips, or a duplicate deleted or merged. A closed report means nothing on it needs review, and the change may undo that. The audit event says why it reopened. A submitted report is never reopened this way; its expenses are submitted, and those can't change.
8. **Needs you shows only what to act on.** In order:
   - a report overdue, or in its last week with work left;
   - receipts needing a look;
   - local expenses with no justification;
   - reports ready to close.

   A report still filling up isn't in Needs you, since what blocks it already is. Home lists open and closed reports.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Compute reports on read, with no schedule | Reports would only open or close when someone looks. Day 28 would pass unnoticed until then, and a read would write. |
| Membership in a join table (report, trip) | One trip is on one report. A column with a composite key says that and keeps the member check in the database. |
| Refuse changes to a closed report | Late receipts and readings happen whatever the person intends. Refusing them would strand an expense outside its report, or block a reading. Reopening says honestly that the report changed. |
| Count the 24 hours from midnight UTC | The trip would join up to 12 hours early for someone in the Americas: their return day wouldn't be over 24 hours yet. |
| On day 28, move everything when nothing is ready | It would restart the clock on the same work every month. Waiting, overdue, says what is true. |

## Consequences

### Positive

- **Claims happen without being remembered.** A trip ends, and a day later it is on a report with 28 days to close.
- **Day 28 pays what is done.** One unreviewed taxi doesn't hold up a month of finished trips.
- **The database keeps reports to their member.** Every change to a report is in the audit trail.

### Negative

- **Joining runs late outside UTC−12.** Something joins 24 to 50 hours after its day ends, depending on the time zone, and within the hour after that: about 31 hours in US Central time. #63 fixes this with the organization's time zone.
- **Reopening is automatic.** A closed report reopens when anything on it changes, so a report the person closed can open again. Needs you and Home show it.
- **Totals are per currency.** Until #62 converts them, a report with euros and dollars shows two totals.
- **A report can hold only local expenses.** The product owner said a report holds at least one trip. Local expenses (Q21) make a month with no travel possible, so a report of only local expenses is allowed.

## Exit path / reversibility

- **Timing.** The schedule is one function. Its timing is three constants in the domain: the 28-day window, the 7-day warning and the 7-day grace.
- **Membership.** It is two columns. A per-trip report model would mean a migration and a change to `joinDueItems`; nothing else depends on how membership is stored.

## Links

- [ADR-0023: Expenses file to trips by date](0023-expenses-file-to-trips-by-date.md), [ADR-0017: Read every receipt with two models](0017-read-receipts-with-two-models.md), whose workflow runner the schedule runs on
- FR-EXP-05, FR-EXP-12, FR-EXP-13, FR-EXP-14, F-17, F-50, backlog #23, #62, #63
