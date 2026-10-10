# ADR-0051: An expense can be paid by several card charges

A card charge still pays for at most one expense, but an expense can now be paid by several charges. A ride and its tip, charged apart, both document the one receipt. A person can add any charge to an expense another charge already pays for. Two charges that make up an expense exactly are matched to it on their own, when they are the only two that do.

- **Status:**
  - Several charges to one expense: accepted, decided by the product owner on Oct 10 ("I need to be able to assign more than one charge from a statement to an expense").
  - Pairing on its own, its limits and R-PAIR-LIKENESS: recommended, with no objection yet.
- **Date:** 2026-10-10
- **Deciders:** Product owner; Claude (principal architect), for the design
- **Decision register:** D-53
- **Amends:** [ADR-0046](0046-card-statements-and-matching.md). Its rule that each transaction is matched to at most one expense, and each expense to at most one transaction, keeps only its first half.

## Context

On Oct 10 the product owner reported an Uber receipt of $24.11, which the card charged as $21.11 and $3.00 (GAP-54).

- **Nothing could match it.** Neither charge is $24.11, so neither matched on its own. By hand, the second charge was refused: a database index (`card_transactions_expense_key`) held each expense to one charge, and the app offered only expenses no charge paid for.
- **It recurs.** Uber charges a trip's tip apart, so every ride with a tip does this. A hotel's deposit and balance, or a fare and a later seat fee charged apart, do the same.
- **The rest was ready for it.** Who paid already asks whether *any* charge pays for an expense (FR-INT-25). Undoing a match already hands the expense back only when no charge is left.

## Decision

1. **Many charges to one expense, never one charge to many.**
   - `card_transactions.expense_id` keeps pointing at one expense.
   - The unique index becomes a plain one (`card_transactions_expense_idx`, migration 0060).
   - One charge split across several expenses is not built; nobody has asked for it.
2. **By hand, any charge can join an expense.**
   - The person picks from their expenses with receipts, within a week. Each choice shows what its charges already come to.
   - The rule that an expense needs its receipt to document a charge stays (FR-INT-26).
3. **On their own, two charges make up an expense only when it is unambiguous:**
   - one charge of the whole amount wins, as before;
   - otherwise two charges are matched together when all of these hold:
     - each is a charge, not a credit, in the expense's currency;
     - each is within three days of the expense (R-MATCH-DAYS);
     - each names the expense's merchant (R-PAIR-LIKENESS);
     - together they make its amount to the cent;
     - they are the only two that do;
     - no other expense could take either;
     - neither is in a tie for a single match.
   - Anything less clear is left for the person. Three or more charges are matched only by hand.
4. **The expense shows each charge and what they come to.** The API's `cardCharge` becomes `cardCharges`, oldest first. With several, the expense says whether together they make its total, or names the difference.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| By hand only | Every tipped ride would need a person to pair it, when its charges name the merchant, fall on its day and add up to the cent. |
| Pair any charges that add up, whatever the merchant | Two unrelated charges could make up an expense by chance. Requiring the merchant and uniqueness keeps a guess from being made. |
| Combine three or more charges | Rare, and the combinations grow fast; the person can add them by hand. |
| A join table between charges and expenses | Needed only if one charge were split across expenses. The column already models many to one. |

## Consequences

### Positive

- The product owner's Uber receipt matches on its own, as every tipped ride will.
- An expense's page traces to every charge that paid it.

### Negative

- **An expense's charges may not make its total.** For example, a person adds a wrong charge by hand. The page shows the difference rather than refusing it, since a person may know better (a tip added after the receipt).

## Exit path / reversibility

Put the unique index back after unmatching all but one charge on each expense. Pairing is one function in `packages/domain/src/card-transactions.ts`, which can be dropped on its own.

## Links

- [ADR-0046](0046-card-statements-and-matching.md), [ADR-0047](0047-a-card-charge-matched-is-paid-by-the-company.md)
- FR-INT-24, F-65, US-CAP-07 AC12 and AC13, R-PAIR-LIKENESS, GAP-54, backlog #106
