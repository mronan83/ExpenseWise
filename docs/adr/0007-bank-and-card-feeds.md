# ADR-0007: Bank and card feeds

Connect read-only Plaid transactions in Phase 2; no card issuing is planned. *Amended Oct 7:* a card's statement comes in first, and a live feed is a later source of the same transactions.

- **Status:** Accepted (decided by product owner); amended Oct 7, 2026, by the product owner's answers to Q50 and Q51 (GAP-42, #97)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-07

## Context

Without a transaction feed we can't auto-create expenses from card swipes, spot missing receipts or reliably catch duplicates ([C4](../01-vision-and-scope.md#c4-automation-is-a-data-problem-more-than-an-ocr-problem)). The positioning adopts Ramp's rule that the transaction is the source of truth once bank feeds arrive ([C2](../01-vision-and-scope.md#c2-concur-ramp-and-expensify-are-three-different-businesses)). Issuing our own card is a regulated business; if we ever do it, we do it through a partner.

## Decision

- **Yes to feeds.** Connect read-only Plaid transactions in Phase 2.
- **No card issuing.** No card issuing is planned. Phase 4 lists corporate cards through a partner only as a candidate that needs its own business case.
- **What the feed drives:**
  - A Transaction entity (feed, posted date) is matched to at most one expense.
  - A card transaction with no receipt after 24 h triggers a nudge, at most one a day, with quiet hours respected.
  - A hotel charge with no folio after 24 h becomes an inbox item.
- **Plan and keys.** The Plaid Trial plan allows 10 bank connections. Preview environments use Plaid sandbox keys.
- *Amended Oct 7 (Q50, Q51, GAP-42):* **a card's statement comes first.** The product owner's corporate card is a U.S. Bank commercial card, seen in Access Online, which Plaid, SimpleFIN and Teller don't reach: aggregators reach consumer and small-business sites such as usbank.com, not commercial-card portals such as Access Online, CitiManager or PaymentNet. Its issuer's daily commercial-card file (Visa VCF) goes only where the employer's card program administrator enrolls it. So a person brings in their card's monthly statement, or a transaction list downloaded from the card's site, by upload or by forwarding it to their receipts address (FR-CAP-10), and each transaction is matched to an expense (FR-INT-24), in Phase 1 (#97). The Transaction entity and its matching are the same whichever source brings a transaction in; Plaid, or SimpleFIN, becomes a later adapter for cards whose site an aggregator reaches. No card login reaches ExpenseWise or a third party.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| No feeds: receipts and email only | Leaves out card-swipe expenses, missing-receipt detection and reliable duplicate checks, which C4 identifies as the main automation gains. |
| Card issuing via a partner | A regulated business, and no card issuing is planned. Corporate cards appear in Phase 4 only as a candidate that needs its own business case. |
| Plaid first for a corporate card (Oct 7) | Plaid doesn't reach a commercial-card portal such as U.S. Bank Access Online, so it can't bring this card's charges in at any price. |
| The employer's commercial-card file (Oct 7) | Daily and complete, but enrolled by the employer's card program administrator, with a file-transfer setup: the product owner chose the statement (Q51). |
| Free open-source connection (Oct 7) | None exists in the US: open-source finance apps rent an aggregator (SimpleFIN about $15 a year), and the free European one, GoCardless Bank Account Data, stopped taking sign-ups in July 2025. OFX Direct Connect is gone at American Express, and the CFPB's open-banking rule is enjoined and being rewritten. |

## Consequences

### Positive

- Receipt ↔ transaction matching, missing-receipt nudges and stronger duplicate detection become possible.
- Read-only access means ExpenseWise moves no money through the feed.

### Negative

- Feeds carry amount, merchant and date only. A hotel charge shows no nightly breakdown, and IRS Publication 463 expects documentary evidence for lodging whatever the amount. This folio gap has to be closed through email ([ADR-0011](0011-travel-data-sources.md)).
- The Trial plan's 10-connection limit bounds the early user base.
- Feed cost adds to cost per user (R6), and Plaid is another subprocessor that must sign a data processing agreement.

## Exit path / reversibility

Plaid sits behind an adapter (AP7), and the Transaction shape and its adapter are designed in Phase 0, so another feed provider is a new adapter, not a new core. Capture and email-in keep working without feeds, so turning feeds off degrades automation but loses no receipts.

## Links

- [Capability map](../02-capability-map.md), [automation rules](../03-journeys-and-workflows.md#46-automation-rules)
- [System context](../05-architecture.md#62-system-context), [domain model](../05-architecture.md#66-domain-model), [travel data](../05-architecture.md#611-travel-data)
- [Risk register](../08-risk-register.md): R6, R8
- [ADR-0011](0011-travel-data-sources.md)
- FR-CAP-06, FR-CAP-10, FR-INT-12, FR-INT-24, F-65, US-CAP-07, GAP-42, Q50, Q51, backlog #97
