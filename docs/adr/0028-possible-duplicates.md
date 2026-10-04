# ADR-0028: Possible duplicates are judged on what was read, held for the person, and deleted whole

Two receipts that read as the same purchase are a possible duplicate. The later one waits in Needs you and counts in no total until the person keeps both, deletes one, or merges one into the other. Deleting removes the receipt with everything that hangs off it, through one function the app can call but can't get around, and the file goes once that has committed.

- **Status:** Accepted (requirement and merge and delete rules decided by product owner, Oct 3; matching and mechanism recommended, no objection)
- **Date:** 2026-10-04
- **Deciders:** Product owner (what is a duplicate to them, merge and delete); Claude (principal architect), for the design
- **Decision register:** D-30. Builds on [ADR-0021](0021-confirming-a-reading.md) and [ADR-0022](0022-expense-follows-its-receipt.md).

## Context

The product owner forwarded the same Uber receipt email eight times, and it was filed as eight receipts, each with its own expense. The file fingerprint (NFR-DAT-06) didn't catch them. [ADR-0027](0027-email-text-as-a-pdf-receipt.md) makes the same text give the same PDF, but a forward is not the same text: each forward adds its own header and quoting, so every PDF differed by a few bytes.

The product owner's requirement (FR-INT-18) and answers, the same day:

- Possible duplicates are caught in review. They can be merged, or one deleted to save space.
- No reference copy is kept. Delete means delete.
- In a merge the person chooses the primary. It takes the other's missing information, or specific fields the person picks, and the other is deleted.

Three things in the existing design were in the way:

- **The app could delete rows.** Migration 0001 granted `expensewise_app` DELETE on receipts, readings and expenses. Nothing used it, and a careless query could have orphaned a receipt's readings or left an expense without its proof.
- **A Ready duplicate counts.** A copy read with confidence is Ready on its own, so it is counted on Home and in its trip's total the moment it settles.
- **The file outlives a transaction.** Storage isn't in the database, so deleting a receipt and its file can't be one atomic step.

## Decision

1. **A match is judged on what was read.** When a receipt's reading settles, it is compared with the same member's other read receipts. It is a possible duplicate of one that has:
   - the same currency and the same total, exactly, in minor units;
   - a date no more than one day apart, since a forward can cross midnight or a time zone;
   - a similar merchant: the same words once case, punctuation and company suffixes such as Inc. are set aside, or every word of the shorter name in the longer one ("Uber" and "Uber Technologies Inc.").

   Receipts still being read, or that nothing could read, are not compared.
2. **The later receipt is held.** Of the two, the one added later is the copy, whichever was read last.
   - It needs a look whatever its reading settled to, and Looks right is refused while it is held. Needs you says "Possible duplicate of an earlier receipt" and names it.
   - Its expense is left out of Home's month and of trip totals, so a purchase sent twice never counts twice.
   - What its reading settled to is kept on the pair, so it goes back to that once released. Reading it again keeps it held.
3. **The person decides, on either receipt's page.** The two are shown side by side: merchant, date, amount, notes, trip, and when and how each was added.
   - **Keep both.** The pair is dismissed and never flagged again, in either order.
   - **Delete one.** The person chooses which. The receipt goes with its file, readings, confirmations, pairs and expense.
   - **Merge.** The person chooses the primary. Its expense takes each field it lacks from the other, and each field the person ticks; an amount brings its currency. The other is then deleted as above.
   - A submitted, approved or settled expense is never deleted or merged into (FR-EXP-03).
   - Receipts held against the one deleted are checked again, so a third copy is then held against the receipt kept.
4. **Deleting goes through one function.** The app's DELETE rights on receipts, readings and expenses are taken back. `delete_receipt(id)` runs as its owner and is the only way to delete:
   - It works only inside the current organization.
   - It refuses a receipt whose expense is submitted or further along.
   - It deletes the expense only when no other receipt proves it.
   - It returns the file to remove.
5. **The audit trail says what was deleted.** Before the deletion, in the same transaction, an event records the receipt's fingerprint, merchant, date, amount, expense and what it duplicated. A merge also records each field the primary took, from and to.
6. **The file goes after the commit.** The API removes the file once the transaction has committed. If that fails, it logs it: an orphaned file can be swept later, while a receipt pointing at a missing file would be a broken proof.
7. **Receipts filed before this are checked once.** A release data step compares each read receipt that has never been compared, oldest first, so the later copy is the one held. A marker on each receipt makes it safe on every release.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Make the email PDF ignore forward headers, so the fingerprint matches | Only catches identical forwards of one email. A photo and an emailed copy of the same receipt, or a resent email, would still double up. Worth adding later to skip the two model reads a repeat costs, but it can't be the only check. |
| Ask a model whether two receipts are the same | A cost per receipt on the organization's key, and an answer that can't be explained. The fields already read decide it in a query. |
| Soft-delete: hide the copy, keep its rows and file | The product owner said no reference copy: deleting is to save space. The audit trail keeps what the receipt was. |
| Delete with the app's own rights, row by row | Any query could then delete. One owner-run function deletes everything that hangs off a receipt together, and nothing else can. |
| Flag both receipts of a pair | Both would leave the totals and both would need a look, for one purchase. Holding only the later one keeps the original counted. |

## Consequences

### Positive

- **Duplicates are caught however they arrive.** A forward, a resend, or a photo of a receipt that was also emailed, once their readings agree.
- **Nothing counts twice while the person decides.**
- **Deleting is safer than before.** The app can no longer delete a receipt, a reading or an expense except through `delete_receipt()`, whole, inside its organization, and never once submitted.

### Negative

- **A near-miss isn't caught.** Readings that differ by a cent, or merchants named in unrelated ways, such as a card descriptor beside a trading name, are not flagged. The rule leans towards not flagging, since a held receipt costs the person a look.
- **Two real purchases can be flagged.** Two identical coffees a day apart look the same. Keep both settles it for good.
- **Each repeat forward is still read.** Both models read every copy before it is compared, at a cost to the organization's key. Catching identical forwards before reading would save that.
- **A file can be orphaned.** If removal fails after the commit, the file stays with nothing pointing at it until swept.

## Exit path / reversibility

- **Matching.** The rule is one function in the domain, `looksLikeSamePurchase`. It can be widened, for example to a cent's tolerance, without touching storage or screens.
- **Pairs.** These are rows in `receipt_duplicates`. Dropping the feature means releasing every held receipt to its settled status and dropping the table.
- **Deleted receipts can't come back.** That is the requirement. The nightly backup holds them for its retention period.

## Links

- [ADR-0021: Confirming a reading](0021-confirming-a-reading.md), [ADR-0022: Expense follows its receipt](0022-expense-follows-its-receipt.md), [ADR-0027: An emailed receipt's text becomes a PDF receipt](0027-email-text-as-a-pdf-receipt.md)
- FR-INT-18, F-48, backlog #60
