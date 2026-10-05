# ADR-0041: An expense keeps its receipt's lines, leaves a line out with a reason, and splits into parts

An expense keeps a copy of its receipt's itemized lines, taken from each reading until a person changes the expense. Where the lines add up to the receipt, each item line carries its share of the tax, tip and fees, spread in proportion in whole minor units, the largest share taking any unit left over. A line can be left out of the claim with a reason, and the expense can be split into parts, each with its own category and type, by line or by amount, the parts always adding up to the claim.

- **Status:** Accepted (lines under the total, excluding a line with a reason picked from a list, splitting by line or by amount into parts of one expense, and the tax spread in proportion decided by product owner, Oct 4, Q35 to Q38; the copy of the lines, the add-up rule, other needing a note, and the parts model recommended, no objection yet); points 1, 2 and 4 amended on Oct 5 for credits and lines printed once a night, after the product owner's report of a Hilton folio (GAP-38, #92)
- **Date:** 2026-10-04
- **Deciders:** Product owner (Oct 4, Q35, Q36, Q37, Q38); Claude (principal architect), for the copy, the add-up rule and the storage
- **Decision register:** D-43. Builds on [ADR-0022](0022-expense-follows-its-receipt.md) (an expense follows its receipt until edited), [ADR-0036](0036-categories-and-types.md) (categories and types), [ADR-0034](0034-reference-rates-for-reimbursement.md) (conversion) and [ADR-0008](0008-money-and-data-conventions.md) (exact money); ships behind `expenses.itemized` and `expenses.split` ([ADR-0032](0032-features-switched-per-organization.md)).

## Context

Every reading has held a receipt's lines since receipt-v1 (FR-INT-01), and nothing showed or used them. On Oct 4 the product owner asked for three things (FR-INT-22, FR-EXP-15, FR-EXP-16):

- A receipt's itemized lines in an expandable section under the expense's total.
- A line left out of the claim, such as a hotel's minibar, with a reason: personal, paid by someone else, not reimbursable or other, and an optional note (Q38). That is how an expense claims less than its receipt with a reason (FR-EXP-10, Q6), line by line.
- An expense split into parts, each with its own category and type, for reporting. It stays one expense with one receipt (Q35), split by line where the receipt has lines and by amount where it doesn't (Q36). Tax and service charges are spread across the other lines in proportion, in whole cents, the largest share taking any cent left over, so the parts add up to the receipt exactly (Q37).

Three facts shape it:

- **Readings arrive again.** Read again replaces a reading, and a submitted claim must never change under one.
- **Lines don't always add up.** A model can miss a line, read a total wrong, or meet a receipt whose prices include their VAT. Spreading tax across lines that don't make the receipt would invent the numbers a reviewer checks.
- **The claim is the expense's amount.** Reports, Home, conversion and the export all read `expenses.amount_minor`. A claim that lived anywhere else would have to be taught to every one of them.

## Decision

1. **The expense keeps a copy of its receipt's lines** in `expense_itemizations` and `expense_lines`: the reading's currency, total and subtotal, and each line numbered from 1 as printed, the items first (a discount is a negative item), then each tax, each fee and the tip, in integer minor units. The receipt workflow hands the lines of the reading the expense is filed with to `settleReceipt()`, and `fileReceiptExpense()` copies them while the expense still follows its receipt: until a person edits it, which leaving a line out and splitting it now count as (ADR-0022), and never once it is submitted. A new reading replaces the copy; a reading with no lines takes it away. Each copy is audited as `expense.lines_read`. An expense filed before this shows the lines of the reading it was filed with, and takes them as its copy on its first change.
   - *Amended Oct 5 (#92, GAP-38):* every line is read each time it is printed, so a folio's room, taxes and fees for each night are lines of their own, never merged, and a total the document prints of them, such as "Total taxes", is not another line. A credit, refund, reversal or adjustment is a line of its own with a negative amount, described as printed, never netted into the charges it reverses or left out: an item, as a discount is, or a negative tax line when it reverses a tax. A payment is never a line, and a folio's total is what was charged after credits, not the balance left. No new kind of line was needed: as an item, a credit takes a negative share of the tax (point 3) that offsets the shares of the charges it reverses, within the unit that rounding down leaves. The instructions and schema that ask for this are `extract-v5` and `receipt-v5` (`extract-v6` and `receipt-v6` with source lines), for every organization, as a fix; a reading keeps the versions it was made with, and Read again reads a receipt the new way.
2. **Lines add up, or they aren't used (Claude's rule).** The items must come to the subtotal where one is printed, and with the taxes, tip and fees to the total, each within a cent a line (R-LINES-TOLERANCE). Prices that include their tax add up too: then the items and fees alone make the total, and the subtotal may be printed before or after its tax. Lines that don't add up still show, with what they come to beside what they should ("These lines come to $943.00, but the receipt's subtotal is $961.50"), and then no line can be left out or split by line; splitting by amount still works. So do lines that no longer make up the claim: an expense whose currency or amount a person changed by hand.
   - *Amended Oct 5 (#92):* the same rule now checks a reading too. Where no subtotal is printed, as on most hotel folios, a reading whose item lines, with its taxes, fees and tip, don't make its total within a cent a line fails its sums check (FR-INT-04) and is held for a look, however confident. Before, a reading without a subtotal had nothing to add up, so a folio read with one night's taxes of two was Ready. One function, `linesMakeTotal()`, holds both to the rule. A receipt with neither a subtotal nor an item line has nothing to add up, as before, and one with a subtotal is checked against it, as before.
3. **The spread.** What the total holds beyond the items, the taxes, tip and fees together, is spread across the item lines in proportion to their amounts: each share rounded down, and the largest share takes every unit left over (Q37, `allocateToLargest()`). A discount or a credit takes a negative share; a zero line takes none. Every line and its share add up to the receipt's total exactly, with no float and no rounding of money anywhere.
4. **Leaving a line out** sets its reason, a note that other needs (Claude's reading of Q38; R-EXCLUSION-NOTE-MAX), and when. The claim is the receipt's total less each excluded line and its share, written to `expenses.amount_minor` as a person's edit, so reports, Home, the export and conversion follow it with nothing of their own: a recorded rate converts the new amount at once, and the conversion workflow records it (ADR-0034). Only an item is left out; a discount or a credit can't be (*amended Oct 5, #92*: a charge that a credit reversed can be, with its share), and no claim goes below zero. A credit is in a part of a split only with lines that come to more than it; alone, or with only the charges it reversed, its part comes to nothing or less and is refused. Including it again restores it. While the claim is made of its lines, an edit of its amount or currency is refused (409 `itemized`), and a merge that takes another receipt's amount lets the lines go. Each change is audited (`expense.line_excluded`, `expense.line_included`).
5. **The parts.** A split is rows of `expense_parts`, each with a category and type and an amount in the expense's currency, adding up to its claim exactly. By line, the lines given a category and type in `expense_lines` make a part each, with their shares, and the lines given none stay together with the expense's own category and type (a part with none, which follows the expense's own); the parts are worked out again whenever a line is left out or included. By amount, a person types at least two parts (at most R-SPLIT-PARTS-MAX), and a split that doesn't add up to the claim is refused (422 `parts_dont_add_up`). While split by amount, a line can't change the claim until the split goes. Each part's category and type is checked as a choice is, and counts as in use. Each change is audited (`expense.split`, `expense.split_removed`).
6. **Reports and the export count parts.** `GET /v1/reports/{reportId}/categories` totals a report by category and type, each part under its own, and, while conversion is on, each part takes its share of its expense's conversion. The export writes a row per part, marked "1 of 2", and lists the excluded lines with what each took off and why; a report with neither exports exactly as before.
7. **Locked once submitted.** Lines, exclusions and splits change only while the expense is open to edits; a submitted or approved claim keeps them as they went in, and no reading replaces them.
8. **Whose they are.** The three tables hang off an expense, so they carry the `own_records` policy and trigger (ADR-0035): a member sees only their own, owners, finance admins and auditors see everyone's, and only the expense's member changes them. They go with their expense: `delete_expense_lines()` deletes them just before it, while it is still there to say whose they are.
9. **Off, nothing changes.** With `expenses.itemized` off, an expense reads as before and the line routes answer 404 `feature_off`; with `expenses.split` or `expenses.categories` off, so do the split routes and the report's totals by category and type. Lines are still copied, unseen, so switching it on shows them at once.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Read the lines from the reading every time | A re-read would change a submitted claim's lines, and an exclusion would point at a line that moved. |
| Keep the claim apart from `amount_minor` | Reports, Home, conversion, duplicates and the export would each need to learn it. |
| Several expenses on one receipt for a split (Q35 B) | The product owner chose one expense in parts. |
| Tax as lines of their own, split or excluded as printed (Q37 A) | The product owner chose the spread in proportion. |
| The largest remainder takes each unit left over | The usual method, and within a unit of exact for every line; the product owner asked for the largest share to take what is left (Q37). |
| Spread even when the lines don't add up | It would invent shares a reviewer checks against the receipt. |
| Parts worked out on read, never stored | Every report and export would repeat the arithmetic; stored parts are what was claimed, and a check holds each above zero. |

## Consequences

### Positive

- **A folio claims what the business owes.** The minibar comes off with its share of the tax, and a reviewer sees it and why.
- **Reports total by what was bought.** A hotel bill's room is lodging and its room-service dinner a meal, in one expense with one receipt.
- **Every amount adds up exactly.** Lines with their shares make the receipt; parts make the claim; a part's share of a conversion makes the conversion.

### Negative

- **A receipt's lines can't be used when a model misread one.** Splitting by amount still works; reading it again may fix it.
- **More readings need a look** (*Oct 5, #92*). A receipt that prints item lines and no subtotal, read with a line left out, is held where before it was Ready. That is what holds a folio read with one night's taxes; a person confirms it or reads it again.
- **An edit by hand freezes the lines too.** As with its values, a person's edit stops the expense following new readings.
- **The app may delete lines and parts.** They are copies and derived rows, replaced as the expense changes; each change is in the audit trail.

## Exit path / reversibility

- **Switching a feature off** hides the lines or the parts; the claim keeps what was excluded until someone includes it.
- **The spread is one function** (`allocateToLargest()`); the largest remainder (`allocate()`) is a one-line change if the product owner prefers it.
- **Dropping the feature** is dropping three tables and the routes; `amount_minor` already holds each claim.

## Links

- FR-INT-22, FR-EXP-15, FR-EXP-16, FR-EXP-10, FR-INT-04, F-55, US-EXP-07, US-EXP-08, US-EXP-09, US-READ-25, Q35, Q36, Q37, Q38, GAP-38, backlog #80, #81, #82, #92
- [ADR-0022](0022-expense-follows-its-receipt.md), [ADR-0034](0034-reference-rates-for-reimbursement.md), [ADR-0035](0035-own-records-and-invite-links.md), [ADR-0036](0036-categories-and-types.md)
