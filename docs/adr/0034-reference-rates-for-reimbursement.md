# ADR-0034: Amounts are converted at the ECB's reference rate for their purchase date, and keep it

Every amount on a report is converted to the person's reimbursement currency at the European Central Bank's euro reference rate for its purchase date, fetched in the background, and the rate, its date and its source are copied onto the expense, so a later rate never changes it.

- **Status:** Accepted (converting everything in a report to the person's reimbursement currency, beside the amount as spent, decided by product owner, Oct 4; that currency being the person's own, set in the app, decided by product owner, Q23; the purchase date's reference rate, with no statement override, decided by product owner, Q25; the source, the weekend rule, where conversions are kept and how they are fetched recommended, no objection yet)
- **Date:** 2026-10-04
- **Deciders:** Product owner (Oct 4, Q22, Q23, Q25); Claude (principal architect), for the source and the mechanism
- **Decision register:** D-36. Builds on [ADR-0008](0008-money-and-data-conventions.md) (exact money, a rate kept with its provenance) and [ADR-0029](0029-expense-reports.md) (reports); ships behind `reports.currency-conversion` ([ADR-0032](0032-features-switched-per-organization.md)).

## Context

A report holds trips and local expenses, and until now totalled each currency apart (US-RPT-06). The product owner asked on Oct 4 for everything in a report to be shown in the currency the person is reimbursed in, beside what was spent (FR-EXP-13). Their answers settled what that means:

- **Q22:** most cards convert at purchase, so an amount already in the reimbursement currency needs no rate.
- **Q23:** the currency is the person's preferred one, set in the app. It starts as the organization's home currency.
- **Q25:** an amount in another currency is converted at the purchase date's reference rate. Replacing it with the amount on a card statement was not asked for, so it isn't planned.

NFR-DAT-02 requires a converted amount to carry its rate, the rate's date and its source; NFR-DAT-04 requires the rate to be copied onto the record, so a later rate never changes an old claim. Fetching a rate is a call to another service, so it must go through the outbox and a workflow, never inside a request (ADR-0017). ADR-0014 rules out paid services.

## Decision

1. **The source is the European Central Bank's euro reference rates**, read from its data API (`data-api.ecb.europa.eu`, series `EXR.D.<currency>.EUR.SP00.A`, CSV). It is free, needs no key or account, and publishes about 30 currencies each working day at about 16:00 CET. Two currencies other than the euro are crossed through it: one unit of A is (EUR→B) ÷ (EUR→A) of B, kept to 10 significant digits.
2. **The rate for a purchase date** is the one published on that date; on a weekend or holiday it is the last one published before it, at most 10 days back (`REFERENCE_RATE_LOOKBACK_DAYS`, R-RATE-LOOKBACK). The recorded rate date is the day it was published, not the purchase date. A purchase dated today or later waits for the next day, when its own rate is out.
3. **A currency the source doesn't publish stays unconverted**, said plainly: it is recorded as having no rate, shown as spent, and listed apart from the report's total. So is one with nothing published in the lookback.
4. **The reimbursement currency is the member's** (`members.reimbursement_currency`), chosen in Settings › Currency; null means the organization's home currency. A report carries it in `reports.currency`: a new report opens in it, and open and closed reports follow a new choice. A submitted report keeps its own.
5. **Each conversion is a row in `expense_conversions`**, one per expense: the amount as spent, its currency and purchase date, the reimbursement currency, and either the converted amount with its rate, rate date and source, or that there is no rate. A check refuses a converted amount without all three. Each conversion is audited (`expense.converted`, `expense.not_converted`).
6. **A recorded rate is never fetched again.** Another amount in the same currency, on the same purchase date and into the same currency takes the rate already recorded, so one day's rate is applied alike. An edited amount keeps its rate, and the report shows the new amount converted at it at once; the workflow records it in the background.
7. **Conversion runs in the background.** A change that may leave something to convert (a trip joining a report, an edit on a report, a new choice of currency) enqueues `report.conversions_due` in its transaction; switching the feature on announces `feature.switched`. The `amount-conversion` workflow converts what the recorded rates allow, fetches the rest from the ECB, then converts again, as the app inside the organization. An hourly sweep, `amount-conversion-sweep`, asks `conversion_work_due()` (ids only) for what is still converting, so a failed fetch or a missed request is caught within the hour (R-CONVERSION-SWEEP). Until a rate is recorded the report shows the amount as converting, and its total says how many are left out.
8. **Totals use the converted amounts.** A report's total in its reimbursement currency adds the amounts already in it and the converted ones, half-even to the minor unit, and leaves out possible duplicates, as the totals per currency do. The totals as spent stay beside it.
9. **Off, nothing changes.** While `reports.currency-conversion` is off, a report opens in the organization's home currency, nothing converts, and reports, Home and Needs you read exactly as before. The Phase 0 columns on `expenses` (`home_amount_minor`, `fx_rate`, `fx_rate_date`, `fx_source`) stay unused; they were built for one home currency per organization.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A rate from the card statement, entered by the person (Q23 A, Q25 A) | The product owner chose the reference rate only (Q25). |
| Converting on the day the report closes (Q22 B) | The purchase date's rate is the usual policy and doesn't move while a report waits; the product owner chose it (Q25). |
| Open Exchange Rates, Fixer, exchangerate.host | They need a key or an account, limit the free plan, or resell the ECB's rates anyway. |
| Converting inside the request | A call to another service in a request: it can be slow or down, and the outbox exists for this (ADR-0017). |
| A table of fetched rates per day | The rates already recorded on conversions serve as the record of what was applied; a second table would hold the same facts twice. |
| Reusing the Phase 0 FX columns on `expenses` | They assume one home currency per organization, have no target currency, and keep 10 decimal places, too few for a cross rate such as dong to dinar. |
| Converting on read from rates kept per day | Then no record would say which rate a claim used, which NFR-DAT-04 requires. |

## Consequences

### Positive

- **One total to be reimbursed**, with what was spent and the rate behind each amount on the same page.
- **A claim never changes after the fact.** The rate is on the record, a check refuses one without its provenance, and the audit trail keeps each conversion.
- **No account, key or spend.** The source is public; the workflow runs a few times a day per organization.

### Negative

- **Most of the world's currencies aren't published by the ECB** (dirhams, dinars, pesos of Chile, Colombia and Argentina among those the app supports). They stay unconverted, said plainly, until a second source is added behind the same function.
- **An amount shows as converting for a few minutes** after a trip joins a report or an amount changes currency or date, until the relay hands on the request (every 5 minutes) or the sweep runs.
- **A cross rate is rounded to 10 significant digits.** Converting with it is within a minor unit of the exact cross up to about 20 million in the reimbursement currency, and the stored rate alone reproduces every converted amount.

## Exit path / reversibility

- **The source is one function** (`ecbRates()` in `packages/workflows`). Another, or a second for the currencies the ECB lacks, plugs in there; the stored source names which one gave each rate.
- **Switching the feature off** hides every conversion and stops new ones; the rows stay, and switching it on again picks up where it left off.
- **A statement amount** (Q25 A) would be a third outcome on `expense_conversions`, with the person as its source.

## Links

- FR-EXP-13, NFR-DAT-02, NFR-DAT-04, F-49, US-RPT-11, US-RPT-14, US-RPT-15, Q22, Q23, Q25, backlog #62
- [ADR-0008](0008-money-and-data-conventions.md), [ADR-0014](0014-supabase-free-plan.md), [ADR-0017](0017-read-receipts-with-two-models.md), [ADR-0029](0029-expense-reports.md), [ADR-0032](0032-features-switched-per-organization.md)
- ECB euro foreign exchange reference rates: https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html
