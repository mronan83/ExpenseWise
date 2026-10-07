# ADR-0047: What a corporate card paid for is the company's, and a charge is documented only by an expense with its receipt

A charge on a corporate card that is matched to an expense makes that expense *paid by the company*, whatever its type, unless a person set who paid by hand. It stays on its report and trip and is never claimed. A charge is matched only to an expense that has its receipt, so a charge without one stays a missing receipt.

- **Status:** Accepted.
  - Decided by the product owner, Oct 7 (Q52): the card is in their name and billed to their employer; every charge must have its receipt and expense; a charge without one is flagged.
  - Recommended, no objection yet: no billing setting, a person's choice standing, letting a charge go handing the expense back to its type's policy, and a submitted claim never changing.
- **Date:** 2026-10-07
- **Deciders:** Product owner (Q52); Claude (principal architect), for the design
- **Decision register:** D-49. Amends [ADR-0045](0045-paid-by-the-company.md) (the policy is now its type's, or the card's) and [ADR-0046](0046-card-statements-and-matching.md) (only an expense with its receipt is matched). Delivers FR-INT-25, FR-INT-26 and F-66 (#98).

## Context

ADR-0046 brings a card's charges in and matches them to expenses, but matching changed nothing of who paid. The product owner's card is billed to their employer (Q52), so an expense it paid, still claimed on a report, would be paid twice: once to U.S. Bank and once to them (GAP-43). They use the card so that every charge is documented by an expense *with its receipt*. A charge matched to an expense with no receipt, which only a drive or an expense typed in has, would pass as documented (GAP-44).

What shapes the design:

- **Who paid is already a policy with a person's override** (ADR-0045). An unpinned expense follows its type's policy, a pinned one stays as set, and nothing submitted changes.
- **Every non-drive expense is filed from a receipt.** The app has no screen that types an expense in without one, and a receipt deleted takes its expense with it.

## Decision

1. **The policy for an unpinned expense is its type's, or the card's.** It is the company's when its type is one the company pays, or when a card charge paid for it (`policyPays`). Choosing a type, handing an expense back to the policy, and a change of a type's policy all use this. A change of policy never takes a card's expense away from the company.
2. **Matching follows through.** When a charge is matched, on its own or by hand, its expense follows the policy at once (`followCardCharges`). The same applies when a charge is let go, moved to another expense, or its statement is deleted.
   - Each switch is one `expense.paid_by_set` audit event marked `byCard`, and a closed report it is on opens again.
   - A person's choice stands.
   - A drive is never the company's.
   - A submitted, approved or settled claim never changes (Q48).
3. **Only an expense with its receipt is matched.** Auto-matching skips an expense with no receipt, it isn't offered by hand, and matching one by hand is refused (`not_matchable`). A charge whose only expense has no receipt therefore stays a missing receipt. Deleting a matched expense's receipt deletes the expense and releases the charge (`release_card_transactions`), which is flagged again.
4. **No setting for who pays the card's bill.** Every card brought in is taken as billed to the company, as Q52 says this one is. A person whose card is billed to them sets *I paid it* on an expense, and it is pinned.
5. **Shown only while Paid by the company is on** (ADR-0045). The column is written either way, so switching it on shows the expenses as matching left them. While it is off, the Card page says to switch it on.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A setting per organization or per card for who pays the bill | One person, one card billed to the employer; a setting is a screen and a state to keep for a case nobody has yet. An exit path below. |
| Mark matched expenses paid by the company even while Paid by the company is off | It would change what every report claims behind a switch that says it is off. |
| Flag a charge whose expense has no receipt as its own state | No such expense can be made in the app today, so it would be a state nothing reaches; refusing the match keeps the charge flagged by the state that exists. |
| Change who paid on a submitted claim when its charge arrives | A submitted claim never changes (Q48, ADR-0043); it would rewrite what an approver saw. GAP-45 and #99 address the timing instead. |

## Consequences

### Positive

- **What the card paid for is never claimed**, with no step for the person, and a type's policy can't undo it.
- **A matched charge is always documented** by an expense and its receipt, and every other charge is in Needs you.

### Negative

- **A statement that comes after a report was submitted leaves that claim as it went in** (GAP-45). The charge still documents the expense. #99 would know the card at the receipt, from the last four digits a reading shows, so the expense is the company's before its report is submitted.
- **One lookup per expense** a change reaches, for its charge, on an indexed column.

## Exit path / reversibility

- **A setting** for cards billed to the cardholder is one column and one condition in `policyPays`.
- **Taking it back** is `policyPays` returning to its type's policy alone; the expenses it switched would follow at their next change, or one data step.

## Links

- FR-INT-25, FR-INT-26, F-66, US-CAP-08, GAP-43, GAP-44, GAP-45, Q52, backlog #98, #99
- [ADR-0043](0043-single-step-approval.md), [ADR-0045](0045-paid-by-the-company.md), [ADR-0046](0046-card-statements-and-matching.md)
