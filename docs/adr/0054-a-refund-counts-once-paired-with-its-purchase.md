# ADR-0054: A refund counts only once it is paired with its purchase

A refund is money a merchant gave back, and ExpenseWise files it as an expense below zero. It never counts on its own. Until its owner pairs it with the purchase it refunds, it sits on no trip and no report, is never Ready, and waits in Needs you.

Once paired, it goes where its purchase goes, so the two net down on one claim. If the purchase was already claimed, the refund goes on the person's open report instead, as money paid back. Either way, it is the company's when its purchase is.

- **Status:**
  - Refunds handled, as designed below: accepted, decided by the product owner on Oct 27 ("Some will 100% need to handle refunds"; Q60, "yes" to the design).
  - Pairing by hand, the 180-day window (R-REFUND-DAYS), the database check that holds unpaired refunds, and leaving card credits for later: recommended, with no objection yet.
- **Date:** 2026-10-27
- **Deciders:** Product owner; Claude (principal architect), for the design
- **Decision register:** D-56

## Context

On Oct 27 the product owner reported a refund receipt for an order that had been refunded in full.

1. The reading came in below zero, as it should.
2. Confirming it with Looks right failed with "Enter an amount of zero or more".
3. The original order was already in ExpenseWise (Q59).

Nothing in ExpenseWise knew about refunds:

- **Confirming one was refused twice over.** The app refused a total below zero (`confirmReading`), and so did the database (`receipt_reviews_amounts_not_negative`). Editing an expense's amount below zero was refused too (`applyExpenseEdit`).
- **A refund read with confidence went straight to Ready.** No check looked at the sign. A Ready refund was then filed by date to a trip, or joined the open report as a local expense.
- **Every total would have taken it off.** Report totals, conversions, exports and Home all add up whatever expenses a report or month holds. A refund on its own would quietly reduce a claim, even when the purchase it refunds was never claimed, or was claimed by someone else.
- **Splitting broke on it.** Splits are refused below zero (`expense_parts_amount_positive`). A split refund would have failed in the database instead of being explained.
- **Card credits were ignored.** Matching only looks at charges above zero (FR-INT-24).

## Decision

1. **A refund is an expense below zero.**
   - A reading with a total below zero fails a new reading check, `refund`, so it is never Ready on its own; a person looks.
   - Looks right accepts it. Its tax and tip go below zero with it, or are zero. The database check becomes `receipt_reviews_amounts_one_sign`: a purchase's amounts are zero or more, a refund's zero or less.
   - Edit a field accepts an amount below zero, such as `-25.00`.
2. **On its own, a refund counts in no claim.**
   - It is on no trip and no report, and stays Needs review.
   - Filing by date, joining reports on their day and moving to a report all pass it by. Choosing a trip for it is refused.
   - The database holds every writer to this with `expenses_refund_unpaired_held`, not only the writers that know about refunds. A refund submitted before this check existed is left as it went in.
   - Home's month leaves it out.
   - It waits in Needs you: "Pair it with the purchase it refunds, or delete it if that purchase was never claimed here."
3. **A refund is paired by its owner with one purchase of their own** (`expenses.refund_of_id`).
   - The pairing names the member (`expenses_org_member_id_key`, a composite foreign key), so a refund can never be paired with someone else's purchase.
   - The purchase must be in the refund's currency, dated on or before it and no more than 180 days earlier (R-REFUND-DAYS).
   - The purchase must have enough left: what its refunds give back, this one included, is no more than it cost. Partial refunds net down, and several can together give back all of it.
   - The purchases it fits are offered likeliest first: the closer merchant name, then the one it refunds in full, then the nearer date. The person chooses; nothing about a refund is guessed.
4. **Paired, a refund goes where it counts.**
   - **Purchase still open to change:** the refund goes on the purchase's trip, or its report if it is local. It follows the purchase when the purchase moves trip or report, so the two net to zero on one claim.
   - **Purchase already submitted or later:** the refund goes on the person's open report, as money paid back. If it has no justification, it gets "Refund of ⟨merchant⟩ on ⟨date⟩".
   - Its status is then Ready, once its receipt is.
   - It takes the purchase's category and type if it has none.
   - It is the company's whenever its purchase is, and follows every change to that: by hand, by policy or by card charge (FR-EXP-17). Who paid it is set on the purchase, not on the refund.
5. **A pairing that no longer fits is let go, never left wrong.** The refund goes back to Needs you, out of any claim, with an audit event. This happens when:
   - the purchase's amount, currency or date changes so the refund no longer fits;
   - the refund changes so it no longer fits;
   - the purchase's receipt is deleted;
   - a person unpairs it.

   A refund already submitted keeps its claim as it went in.
6. **A refund isn't split or itemized.** It gives money back on its purchase as a whole. Split the purchase instead.
7. **Refunds filed before this are taken out of their claims on release.** A data step (`holdUnpairedRefunds`) runs after migrations:
   - it takes each unpaired refund off its trip and report, with an audit event, and reopens any closed report it leaves;
   - it then validates the database check, which the migration added as `NOT VALID` for exactly this.
8. **Card credits are not matched yet.** A company-card purchase already makes its refund the company's, so the money is kept out of the claim. Linking the bank's credit line to the refund, as evidence, is #115 (GAP-60).

## Why pairing, not netting a purchase's amount

- **Netting the purchase would rewrite a claimed expense.** A purchase on an approved report is locked (FR-EXP-03). A refund that lowered it would be a correction of an approved expense, which must be a reversal plus a new version.
- **A paired refund is a new movement of money with its own evidence.** It has its own receipt, date and audit trail. It points at what it refunds, and the purchase's claim stands as it went in.
- **Placement then decides only which claim nets it.** That is the same report when the purchase can still change, and the next one when it can't. The money is right either way, because a refund is one row and counts once.

## Why the person pairs it

- **A refund's merchant name often differs from its purchase's.** "Amazon.com" and "AMZN Mktp", or a hotel group and the hotel, are common examples.
- **A wrong pairing on its own would move money between claims silently.**
- **One tap from a short list ranked likeliest first is cheap.** Needs you makes sure it isn't forgotten.

## Why 180 days

- Most returns are taken within 30 to 90 days. A card dispute settles within 120.
- Half a year covers both, with room, and keeps the list offered short.
- The window is Claude's choice and the product owner's to confirm. Its value is held once, in R-REFUND-DAYS.

## Consequences

- **The confirm error is gone.** A refund can be confirmed and edited, and it counts the moment it is paired.
- **The database guarantees a refund never takes anything off a claim on its own.** That holds whatever code writes the row.
- **A refund in a foreign currency is converted at its own date's rate**, like any expense. It may not net to exactly zero in the reimbursement currency; the difference is the real exchange movement.
- **Some things are not handled yet:**
  - Refunds of purchases claimed outside ExpenseWise, before it was used, have nothing to pair with. They can only be deleted (Q61).
  - On an iPhone the amount keyboard has no minus key. A refund read as above zero can be edited to below zero only on a keyboard with a minus key, until a Refund switch is added.
