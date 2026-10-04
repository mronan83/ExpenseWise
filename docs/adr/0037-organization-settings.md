# ADR-0037: The organization's settings are kept on the organization, and its time zone sets the report schedule's days

The owner keeps the organization's details, demographics and duplicate time window in Settings › Organization, as columns on the organization itself. With organization settings on and a time zone kept, the report schedule counts the organization's days in that zone. A new home currency, or a new duplicate window, applies to what is worked out from then on; nothing already made is converted or judged again.

- **Status:** Accepted (the details, who sets the window and its bounds decided by product owner, Oct 4, FR-PLT-11, FR-INT-19, Q24; how the time zone counts days, what a change of currency or window touches, and the storage recommended, no objection yet)
- **Date:** 2026-10-04
- **Deciders:** Product owner (what an owner keeps in Settings; the owner sets the window for everyone, 0 to 120 minutes, 30 by default); Claude (principal architect), for the design
- **Decision register:** D-39. Amends the timing of [ADR-0029](0029-expense-reports.md) §3 and the fixed window of [ADR-0031](0031-duplicates-on-time-and-place.md) §3, as both foresaw (#63, #64).

## Context

A new organization is named after its owner's email address and starts in US dollars, and nothing could change either. The product owner asked on Oct 4 for the organization's details and demographics to be kept in Settings (FR-PLT-11), and for the duplicate time window to be set there (FR-INT-19). Their answer to Q24: the owner sets the window, for everyone.

Two rules counted time with no organization in mind:

- **When something joins a report.** A trip or local expense joined 24 hours after its day had ended everywhere, which is noon UTC two days on: the day counted at UTC−12, where it ends last. In US Central time that is about 31 hours after the day ends.
- **Day 28.** A report closed 28 days of 24 hours after it opened. Across a clock change that is an hour off the organization's calendar, so day 28 can land late on the day before.

The window was one constant, 30 minutes, in the domain.

## Decision

1. **The settings are columns on `organizations`.** Country, locale, time zone, address, industry, size (`organization_size`) and the duplicate window, each optional, so every organization stays valid. A check keeps the country to two capitals and the window to 0 to 120. An empty window means the domain's default of 30 minutes, so the number lives once. Only the owner writes them, each change with one audit event saying what changed, from and to (`organization.updated`, `organization.duplicate_window_set`); a change to what is already there records nothing.
2. **The time zone counts the organization's days, with organization settings on.** Whatever is dated D joins a report 24 hours after D ends in the organization's zone. A report's day 28 is 28 days on the organization's calendar, at the time of day it opened, and its title is that day's date. With the feature off, or no time zone kept, everything counts at UTC−12 as before. `lastDayToJoin()` in the domain says which dates have joined at a moment. It only formats a moment in a zone, so the database's `AT TIME ZONE` gives the same answer.
3. **The schedule may look in early, never late.** `report_work_due()` reads the time zone whether or not the feature is on: every zone's date is on or after UTC−12's, so it names every organization it did before and some a few hours sooner. The run inside the organization reads the switch (the server's override, then the owner's) and finds nothing due when it is off. A time zone is checked against Postgres's own list when set, so the schedule never meets one it can't read.
4. **A new home currency applies from then on.** Reports opened afterwards are in it. Reports already opened keep theirs, and no amount is converted or rewritten (NFR-DAT-04).
5. **A new window judges receipts read from then on.** Pairs already flagged stay flagged, pairs kept stay kept, and receipts already read aren't judged again.
6. **Settings shows the caller's role.** Settings › Organization opens with the role of whoever is signed in, from the organization call every page already makes, so the owner can confirm it with each address (Q24). The page shows while either feature is on; each section only with its own.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A settings table, one row per key | Eight known fields with their own types and checks. Columns let the database check each one, and a read is the row the app already reads. |
| Store the window as 30 by default in the database | The number would live in the migration and the domain. An empty column defers to the domain's constant. |
| Ask Postgres the feature switch in `report_work_due()` | The server's override lives in the environment, where SQL can't see it. A superset that the run narrows is right whatever the override says. |
| Convert existing reports, or re-judge receipts, when a setting changes | It rewrites what people already saw and submitted, and a reimbursed amount must never move (NFR-DAT-04). |
| Count day 28 as 28 × 24 hours in every case | Across a clock change, day 28 would fall on the organization's day 27 for an hour. |

## Consequences

### Positive

- **A trip joins 24 hours after its day ends where the organization is.** No more 31 hours in US Central time.
- **Each setting is audited, and the owner alone changes it.** The window can't be loosened by the person whose receipts it judges.
- **Changing a setting rewrites nothing.** What was converted, flagged or kept stays as it was.

### Negative

- **An organization whose feature is off but keeps a time zone is looked at a few hours early.** Each of those hourly runs finds nothing and costs one short transaction.
- **The locale is kept but used by nothing yet.** Screens still format numbers and dates the browser's way.
- **A zone whose clocks change at midnight** starts its day at the change, so on those days `joinsReportAt()` can be an hour out. The schedule uses `lastDayToJoin()`, which is exact.

## Exit path / reversibility

- **The columns are optional.** Dropping one, or the whole feature, changes no other table. With the flag off the code takes its earlier path.
- **The schedule's zone is one function**, `organizationTimeZone()`. Returning null brings back UTC−12 for everyone.

## Links

- [ADR-0029: Expense reports](0029-expense-reports.md), [ADR-0031: Duplicates on time and place](0031-duplicates-on-time-and-place.md), [ADR-0032: Features switched per organization](0032-features-switched-per-organization.md)
- FR-PLT-11, FR-INT-19, F-51, F-52, Q24, backlog #63, #64
