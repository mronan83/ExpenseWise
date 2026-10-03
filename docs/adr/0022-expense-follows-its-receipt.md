# ADR-0022: An expense follows its receipt until a person edits it

Every receipt has an expense from the moment it is captured. The receipt stays linked to it as its proof. The expense takes its values from the receipt's reading, or from what a person confirmed, until a person edits the expense; from then on no reading overwrites it. An expense is **Ready** only when its receipt is Ready and its merchant, date, currency and amount are filled in.

- **Status:** Accepted (receipt as proof and editable expenses decided by product owner; the filing rules recommended, no objection)
- **Date:** 2026-10-03
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-24
- **Amends:** [ADR-0021](0021-confirming-a-reading.md) (point 2: a receipt no model could read can be confirmed too, by entering every field)
- **Related:** [ADR-0006](0006-receipt-extraction.md) (receipt extraction), [ADR-0020](0020-openai-fallback-reader.md) (fallback reader)

## Context

Increment 1 ends when a captured receipt becomes an expense with no human touch (FR-EXP-01, #6). The expense table, its lifecycle and the money rules already existed; nothing created an expense.

On Oct 3 the product owner set the rules:

- The receipt is the proof of the expense and stays linked to it (FR-EXP-08).
- An expense can be edited once it exists (FR-EXP-09).
- At review, an expense that doesn't match its receipt is rejected, and that returns the whole report (FR-GOV-10, FR-GOV-11; #24).

Three facts shape it:

- **The proof and the claim are different records.** The receipt, its readings and any confirmation are evidence (ADR-0021). The expense is what is claimed. Editing one must never quietly change the other, or the review check against the receipt means nothing.
- **Readings arrive after capture and can arrive again.** Read again, or buying Anthropic credit (#4), produces a new reading of a receipt whose expense already exists.
- **A person's edit is deliberate.** A machine reading that silently replaced it would undo work without anyone noticing.

## Decision

1. **One expense per receipt, from capture.** Filing a receipt creates its expense, `processing`, in the same transaction, and links them (`receipts.expense_id`). Its audit event is `expense.created`.
2. **The expense follows its receipt.** When the receipt is read, read again or confirmed, the expense is filed again in the same transaction:
   - The values come from the confirmation if there is one, else from the most capable reading, else the fallback's.
   - The status is `processing` while the receipt is read. It is `ready` when the receipt is Ready and the claim is complete, and `needs_review` otherwise.
   - The audit event is `expense.filed`, from the workflow or the person.
3. **A person's edit wins.** `PATCH /v1/expenses/{expenseId}` changes the fields sent.
   - It sets `edited_at` and records `expense.edited` with each field's old and new value.
   - From then on, readings change the expense's status but never its values.
   - Amounts are parsed exactly by the domain, and a corrected currency keeps the amount as written.
4. **Editable while it needs review or is Ready.** That includes again after its report is returned. Not while its receipt is read (409 `being_read`), and not once submitted (409 `locked`). An approved expense is locked; a correction is a reversal plus a new version (FR-EXP-03).
5. **Where the claim differs from the proof is shown, not hidden.**
   - The expense shows what its receipt shows: confirmed values, else the reading, marked as unconfirmed.
   - It lists the fields that differ: merchant loosely, as two readings are compared; date, currency and amount exactly.
   - Enforcing that difference at review is #24. What counts as matching is open as Q6.
6. **No receipt is a dead end.** A receipt that no model could read can be confirmed as well, with every field entered by hand (amending ADR-0021 point 2). Otherwise its expense could never become Ready.
7. **Receipts filed before this get their expense on release.** A data step runs after the schema migrations, as the schema owner. It files an expense for each receipt without one, with hash-chained audit events. A confirmed receipt files what was confirmed; any other receipt gets an expense that needs review. It is safe to run on every release.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Create the expense only when the receipt is Ready | A receipt that needs a look would have no expense to fill in, and the inbox (#9) would have two kinds of item for one piece of work. The lifecycle has always started at Processing. |
| Let readings keep overwriting the expense | A re-read after an edit would silently undo the person's work. |
| Copy the receipt's values once and never look back | The expense would stay empty for a receipt confirmed later, and the review check would have nothing to compare. |
| Edit the receipt's values instead of the expense's | Erases the proof. The receipt keeps what was read and confirmed, and the expense keeps what is claimed. |
| A plain SQL backfill | Audit events are hash-chained in TypeScript, so SQL couldn't write them, and the backfilled expenses would have no trail. |

## Consequences

### Positive

- Every receipt is an expense from capture, and Ready receipts are Ready expenses with no human touch.
- Edits are safe from later readings, and every change has an audit event.
- The review check (#24) has both sides ready: the claim and the proof.

### Negative

- **An edited expense can drift from its receipt.** That is shown on the expense and in the list, and review enforces it once #24 is built.
- **The data step runs on every release.** It looks only at receipts without an expense, so after the first release it is one query.
- **A receipt both models read before #6 gets an expense that needs review,** not one filled in from the reading. None exist in production; such an expense is completed by editing it.

## Exit path / reversibility

- **To stop creating expenses at capture,** remove the call in `fileReceipt`. Existing expenses stay linked.
- **To let readings refresh an edited expense,** drop the `edited_at` check in `fileReceiptExpense`.
- **To drop the data step,** remove it from `runMigrations` once every receipt has an expense.

## Links

- [Journeys §4.5: lifecycles](../03-journeys-and-workflows.md#45-lifecycles)
- [ADR-0021: A person confirms or corrects a reading that needs a look](0021-confirming-a-reading.md)
