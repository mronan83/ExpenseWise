# ADR-0031: Duplicates are matched on time and place, and told apart as exact or possible

Where both receipts say when and where a purchase happened, those decide whether two receipts are one purchase, whatever their totals. A pair that matches in time and total too is an exact copy, deleted with one tap. One whose total or time differs a little is a possible duplicate: the earlier receipt can be replaced by the later. Receipts that don't both say when and where are still matched on the total.

- **Status:** Accepted (matching on vendor, date, time and place, and exact versus possible, decided by product owner, Oct 4; the 30-minute window and how a pair is shown recommended, no objection yet)
- **Date:** 2026-10-04
- **Deciders:** Product owner (what makes a duplicate, Q18, Q19); Claude (principal architect), for the design
- **Decision register:** D-33. Amends the matching rule of [ADR-0028](0028-possible-duplicates.md); uses the time and place read since [ADR-0030](0030-receipt-time-and-place.md).

## Context

ADR-0028 matched a pair on the same currency and total, dated a day apart at most, from a similar merchant. The product owner's review of Oct 4 (GAP-23) found its blind spot. The same purchase with a tip added, or an amended receipt, has another total, so it wasn't flagged. They asked for a match on vendor, date, time and location, and for an exact copy to be told apart from a possible one that may need a merge or a replacement. Their answers:

- **Q18.** Until time and place are read (#53), keep matching on the total.
- **Q19.** An exact duplicate is deleted with one tap; a possible one can replace the earlier receipt.

The total rule has a second blind spot. It flags two real purchases with the same total, such as the same coffee bought each morning, when they are a day apart.

## Decision

1. **When and where decide, where both receipts say them.** `duplicateKind()` in the domain asks three questions in order:
   - **A time and a place on both.** A similar merchant, the same place and the same day, at most 30 minutes apart, is one purchase, whatever the total. It is exact when the minute and the total are the same too, and possible otherwise.
   - **A time on both, a place on only one or neither.** The same, but the total must match too. Without a place, a different total is no evidence.
   - **A time on one or neither.** The rule of ADR-0028 stands, as Q18 asked: a similar merchant, the same currency and total, dated a day apart at most. Always possible, never exact.

   Two receipts that say different places, or the same place hours apart, are two purchases.
2. **The same place is the same city, or the same address.** Cities are compared without case, accents or punctuation. Without a city on both, an address matches when every word of the shorter is in the longer, with street words spelled either way ("St" and "Street"). A different country says no.
3. **"The same time" allows 30 minutes for a possible duplicate.** The restaurant case the product owner gave prints the itemized bill, then the card slip with the tip a few minutes later. A one-minute rule would miss it. An exact copy still needs the same minute. The window is one constant.
4. **Candidates are the member's receipts dated a day either way.** The check no longer requires the same total to find a candidate. It prefers an exact match to a possible one, and the audit event records which it was.
5. **Exact or possible is judged when shown.** It is judged from both expenses as they are now, not stored. A pair whose expenses have since been edited apart stays possible until the person decides.
6. **What the person does:**
   - **An exact copy.** **Delete the copy**, one tap, or **Keep both**. Delete one and Merge sit under Other choices.
   - **A possible one.** **Replace the earlier one** keeps the later receipt, as for an amended one, and deletes the earlier. Keep both, Delete one and Merge are offered as before.
   - **Both one-tap actions are merges with no fields chosen.** The kept expense keeps its values, and takes a note or a trip only the deleted one had. If the kept expense can't change, Delete the copy deletes outright.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| The same minute for every match | It misses the tip on the card slip, the case that started this. |
| A wider window, such as two hours | Two coffees at the same café in a morning would be flagged. Thirty minutes covers a bill and its slip. |
| Store exact or possible on the pair | It would go stale when the person edits an expense. Judging it when shown is always current, and the audit event keeps what it was when flagged. |
| Replace as a plain delete of the earlier receipt | A note, a trip chosen by hand or a later edit on the earlier expense would be lost. A merge with no fields chosen keeps them. |
| Drop the total rule once time and place are read | Receipts read before #53, and those that print no time, would never be matched. |

## Consequences

### Positive

- **A tip added or an amended receipt is caught.** It is shown as possible, with Replace one tap away.
- **Same-total purchases hours apart are no longer flagged.** Where both receipts say when and where, those are believed.
- **An exact copy costs one tap.**

### Negative

- **A second purchase at the same place within 30 minutes is flagged as possible.** For example, a coffee and then a pastry. Keep both dismisses it for good.
- **Without a time on both, matching is as before.** That covers receipts read before #53, and some that print no time. Reading one again brings its time and place in.
- **One-tap deletion has no confirmation step.** It is a merge into the earlier receipt and appears in the audit trail, but the copy's file is gone.

## Exit path / reversibility

- **The rule is one function.** The window is one constant. Neither is stored anywhere, so changing them changes how pairs are judged and shown from then on.
- **The one-tap actions are the existing merge action.** Removing them leaves Delete one and Merge as they were.

## Links

- [ADR-0028: Possible duplicates](0028-possible-duplicates.md), [ADR-0030: A receipt's time and place](0030-receipt-time-and-place.md)
- FR-INT-18, F-48, GAP-23, Q18, Q19, backlog #61, #53
