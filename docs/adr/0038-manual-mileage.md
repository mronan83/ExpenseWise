# ADR-0038: A drive is an expense, paid at the IRS business rate on its date

A drive logged by hand is an ordinary expense of miles × the IRS standard business rate in force on its date, with the drive and that rate copied onto its mileage log, so trips, reports and totals take it as they take any expense.

- **Status:** Accepted (logging date, destination, purpose and miles with the rate on the day copied on decided in the blueprint, journeys §4.3; the IRS rate as the source, the shape and the rules recommended by Claude, put to the product owner in Q28)
- **Date:** 2026-10-04
- **Deciders:** Product owner (FR-CAP-03 and NFR-DAT-04 from the blueprint, and the batch of Oct 4); Claude (principal architect), for the design
- **Decision register:** D-40

## Context

FR-CAP-03 asks for mileage logged by hand: date, destination, business purpose and miles, the elements IRS Publication 463 asks for, with the rate in force on the travel date copied onto the entry. NFR-DAT-04 says a rate copied on is never changed by a later one. The rules were built in PR #1 (`reimburse`, `selectRate`), and the `mileage_logs` table, with columns for the copied rate, has existed since the first schema, unused.

A drive has to behave like any expense where people see and claim them: list with expenses, file to the trip its date falls in (ADR-0023), join that trip's report or, on no trip, a report of its own with a justification (ADR-0029), and count in every total. And something has to say what the rate is: nothing in the app held one, no organization setting exists, and the Phase 1 admin console is limited to invites and roles (roadmap scope guards).

## Decision

1. **A drive is an expense with source `mileage`, plus one mileage log.** The expense holds the amount, miles × rate rounded half-up to the cent in integer minor units, in the rate's currency; the destination as its merchant; the date as its transaction date; and the business purpose as its justification. It is Ready at once. Because it is an ordinary expense row, filing to trips, joining reports, closing them and every total work unchanged. The log holds the drive (method `manual`, date, destination, purpose, miles) and the rate copied on: per mile, currency, the day it took effect and its source. Both rows and the audit event are written in one transaction.
2. **The rate is the IRS standard mileage rate for business use on the drive's date.** It is a table in the domain, each rate from the day it took effect, 2022 to 2026, with the last day it is known for (31 Dec 2026). A date after that day, or before the first rate, has no rate and is refused rather than paid at a rate that was not in force; each December, when the IRS announces the next year's, it is added. Q28 asks the product owner whether to keep it or set their own.
3. **A drive is changed only as mileage, until it is submitted.** `PATCH /v1/mileage/{id}` takes its date, destination, purpose or miles. A new date or new miles price it again at the rate in force on its date, copied on afresh; a new destination or purpose leaves the rate and amount alone. Editing it as an ordinary expense is refused with 409 `mileage`, so its amount is always miles × its rate. Submitted or approved, it is locked like any expense. Its reason on a report is its purpose: changing one changes the other, and it can't be cleared.
4. **A member's drives are their own.** Every read and change of a drive names the member as well as the organization, whatever row security adds.
5. **Its guards are rules in the register:** at most 1,000 miles a drive (an odometer reading typed as the distance), two decimal places, and a date at most a day after today in UTC.
6. **It ships behind `expenses.mileage`** (ADR-0032): off, its operations answer 404 `feature_off` and Add mileage and the drive's details are hidden. A drive logged while it was on stays an expense, since it is money already claimed.

Out of scope: kilometres, routes and saved places (#20), automatic mileage (Phase 3), business miles on Home (#73), and rates an organization sets.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Mileage as its own claim type, beside expenses | Trips, reports, totals, Needs you and the coming export would each need a second path, and a total could leave miles out. |
| The rate as an organization setting now | Needs a settings screen and rules for who sets it; the Phase 1 admin console is limited to invites and roles. It stays open in Q28. |
| Keep paying the last known rate after its year ends | A January drive would be paid at last year's rate and keep it for good, since the rate is copied on. Refusing until the new rate is added is loud and correct. |
| Keep the copied rate when the miles change | A corrected entry would carry a rate copied for different figures; pricing it again on the day's rate is what a new entry would get. |

## Consequences

### Positive

- **Nothing that reads expenses changed.** Trips, reports, Home's spend and search take drives as they are.
- **Every drive keeps its rate.** A later rate, or a change to the table, never alters one already claimed (NFR-DAT-04).

### Negative

- **The rate table needs a December edit each year.** Until the next year's rate is added, a drive dated in it is refused. The register's rule (R-MILEAGE-RATE) names the last day known.
- **A drive's merchant is its destination.** Lists show the destination, marked as mileage where the list is the person's own expenses.
- **Rates are in dollars.** An organization outside the US would need its own rate and currency (Q28).

## Exit path / reversibility

- **The rate source is one table passed to the domain.** An organization's own rates would be another table of the same shape, read from the database; drives already logged keep the rate they have.
- **Route-based mileage (#20)** adds method `route` and its points to the same log; the expense stays as it is.

## Links

- FR-CAP-03, NFR-DAT-04, F-13, F-25, Q28, backlog #17, #20 and #73
- [ADR-0023: Expenses file to trips by date](0023-expenses-file-to-trips-by-date.md), [ADR-0029: Expense reports](0029-expense-reports.md), [ADR-0032: Features switched per organization](0032-features-switched-per-organization.md)
- IRS Publication 463 and the IRS standard mileage rates notices
