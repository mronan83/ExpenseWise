# ADR-0046: A card's transactions come in from its statement, kept once, and are matched to expenses by amount, day and merchant

A cardholder brings in their card's monthly statement as a PDF, uploaded or forwarded, or a transaction list downloaded from the card's site. A model reads the PDF once and the list needs none. Each transaction is kept once per person and matched to at most one of their expenses: by the same amount and currency within three days, the closer merchant first, or by the person. A charge with neither an expense nor a reason is a missing receipt in Needs you.

- **Status:** Accepted. Decided by the product owner on Oct 7: statement import and matching, with a live feed as a later source (Q51), for a U.S. Bank card on Access Online (Q50). The rest is recommended, with no objection yet: separate entities, one model and no tools, a list read with no model, the key, the matching rule, a statement that misses its totals waiting for a look, setting a charge aside, the "statement" subject, each person's card their own, and the expense showing the card's dollars.
- **Date:** 2026-10-07
- **Deciders:** Product owner (Q50, Q51); Claude (principal architect), for the design
- **Decision register:** D-48.
  - Amends [ADR-0007](0007-bank-and-card-feeds.md) (statement first).
  - Amended by [ADR-0050](0050-every-ai-feature-reads-with-the-organizations-models.md) (Oct 10): a statement is read by the organization's primary AI model, then its back-ups, not by Claude Sonnet alone.
  - Builds on [ADR-0006](0006-receipt-extraction.md) (no tools reach a model), [ADR-0017](0017-read-receipts-with-two-models.md) (reading is a workflow), [ADR-0026](0026-email-in-through-a-bird-mailbox.md) (the receipts address), [ADR-0032](0032-features-switched-per-organization.md) (behind `expenses.card-statements`), [ADR-0034](0034-reference-rates-for-reimbursement.md) (conversion at the reference rate), [ADR-0035](0035-own-records-and-invite-links.md) (each person's records are their own) and [ADR-0041](0041-itemized-lines-splits-and-exclusions.md) (a reading whose sums miss waits for a look).
  - Delivers FR-CAP-10, FR-INT-24 and F-65 (#97).

## Context

The product owner wants their corporate card's transactions matched to their expenses (Oct 7). The card is a U.S. Bank commercial card, seen in Access Online (Q50). No aggregator reaches Access Online, so the Plaid feed of ADR-0007 would bring nothing in. The issuer's daily commercial-card file goes only where the employer's card program administrator enrolls it. The product owner chose statement import and matching (Q51).

What shapes the design:

- **A statement is not an expense.** It lists dozens of charges, several pages long, with its own totals. A receipt's reading, its checks and its expense are all wrong for it.
- **The same charge arrives more than once.** A charge can arrive in the list downloaded mid-month and again in that month's statement, or in two overlapping lists.
- **A statement prints its own totals.** These check a reading the way a receipt's sums do (ADR-0041).
- **Matching must never guess.** A wrong match hides a missing receipt; a missed one only asks the person.
- **Each person's card is their own** (ADR-0035). An owner sees everyone's expenses, but nobody else needs a colleague's card.
- **Model calls run in workflows, on the organization's own key** (ADR-0017, [ADR-0015](0015-ai-provider-keys-in-app.md)), with no tools (ADR-0006), and each step finishes inside the function's limit of about 60 seconds.

## Decision

1. **Two entities, apart from receipts.**
   - `card_statements`: each statement or list a member brought in, unique by member and SHA-256. A PDF is kept beside receipts at `orgs/{org}/statements/{id}`; a list keeps no file.
   - `card_transactions`: each transaction, unique by member and a key. The key comes from the card, the day, the currency, the amount, the merchant's words and the reference, numbered when a statement prints two alike (`transactionKeys`). A later statement adds only what is new (AC4).
2. **A PDF is read once, with its own instructions and structure** (`statement-v1`), by the organization's primary AI model, then its back-ups (ADR-0050; until Oct 10, by Claude Sonnet alone). The reading never shares the receipt's prompt, schema or checks, and offers no tools.
   - It runs in a workflow (`card-statement-reading`), on the organization's own keys. Reading is one step; keeping and matching is another, so a retry after the model answered never pays twice.
   - The model gets one attempt inside the step's limit. A timeout is not retried, since a long statement would only time out again, and the person is asked for the downloaded list instead.
   - The reading first says whether the document is a card account's statement at all. A hotel folio forwarded as a "statement" is turned away, with how to forward it as a receipt.
3. **A downloaded list is read in the request, with no model.**
   - Columns are found by their names after any lines above the header, in CSV or tab-separated form; payments to the card are left out.
   - A list of mostly negative amounts in one column is read the other way round.
   - At most 2,000 rows: a longer list is refused whole, never cut short.
4. **A statement whose lines don't make its printed totals waits for a look** (AC5), as does one with a line that couldn't be read. Its transactions are kept but nothing is matched until the person confirms it.
5. **Matching is the domain's rule, one to one** (`matchTransactions`).
   - A charge matches an expense of the same member with the same amount and currency, dated within three days, not a drive and not already matched. The closer merchant name wins, then the nearer day. A tie is left for the person.
   - It runs when a statement is read or confirmed, when a list comes in, when a receipt of the member's is read, and on Match again.
   - The person can match a charge to any of their expenses not paid by another charge, whatever its amount or currency: a tip added later, or a fare in euros.
6. **A charge with no expense is a missing receipt** in Needs you, until the person adds its receipt, matches it, or sets it aside with a reason. The reasons are personal, no receipt to be had, not an expense, or other, which needs a note. Credits and refunds are never missing receipts.
7. **An email with "statement" in its subject** files its PDFs as statements while the feature is on. Off, it is read as receipts, as before (AC9).
8. **Each person's card is their own.** Both tables carry `own_records` policies and triggers (ADR-0035), so an owner doesn't see a colleague's card. The workflow acts for the system.
9. **An expense shows the charge that paid for it.** For a charge abroad it shows the dollars the card was charged. The claim keeps its own amount, which its report converts at the purchase date's reference rate (ADR-0034, AC7).
10. **Deleting an expense lets go of its charge** (`release_card_transactions`), which is then a missing receipt again. Deleting a statement brought in by mistake deletes its transactions.
11. **Off, nothing reads it.** Behind `expenses.card-statements`, its routes answer 404 `feature_off` and Needs you and expenses read as before.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Ask the employer's card administrator for the issuer's daily file (Q51 B) | Fresher, but needs the employer's approval and a file-transfer setup the product owner doesn't control. Remains a later source. |
| Plaid, as ADR-0007 planned (Q51 C) | It doesn't reach Access Online, so this card would stay out of reach. |
| Read a statement as a receipt, with the receipt's prompt | A statement is many purchases with its own totals, and none of it is an expense. Mixing them would change every receipt's request. |
| Both comparison models on every statement | A statement is long, so a second reading doubles a cost that the totals check already guards. |
| Auto-match on a similar amount, such as a tip added later | Would guess. A tip or a conversion is the person's to match. |
| Each statement keeps its own copy of a transaction | The same charge would be a missing receipt twice. |
| Show everyone's cards to owners and finance admins | Nothing needs them yet, and a card's charges include personal ones. Can be added with approval of card charges. |
| Convert a charge abroad at the card's rate | Q25 set the reference rate for every claim. The card's dollars are shown, not used. |

## Consequences

### Positive

- **Free, and nobody else holds the card's login.** A list costs nothing; a PDF costs a few cents on the organization's own key.
- **Works for any issuer** whose statement prints its transactions, and the same transactions take any later source.
- **Missing receipts surface by themselves** in Needs you, and a matched expense shows its charge.

### Negative

- **Monthly, unless the person brings a list in sooner.** A charge is a missing receipt only once its statement is in.
- **A very long statement may not read in one step** and asks for the list instead.
- **Who pays the card's bill isn't known** (Q52). A matched charge doesn't yet mark its expense paid by the company. If the company pays the bill, a claimed expense would be paid twice until the person marks it (#98).

## Exit path / reversibility

- **The tables are additive.** Switching the feature off hides them; dropping them is one migration, after the flag and its off branch go.
- **The matching rule is one domain function**, and a live feed is another way to fill `card_transactions` with the same key.

## Links

- FR-CAP-10, FR-INT-24, F-65, US-CAP-07, GAP-42, Q50, Q51, Q52, backlog #97, #98
- [ADR-0006](0006-receipt-extraction.md), [ADR-0007](0007-bank-and-card-feeds.md), [ADR-0017](0017-read-receipts-with-two-models.md), [ADR-0026](0026-email-in-through-a-bird-mailbox.md), [ADR-0032](0032-features-switched-per-organization.md), [ADR-0034](0034-reference-rates-for-reimbursement.md), [ADR-0035](0035-own-records-and-invite-links.md), [ADR-0041](0041-itemized-lines-splits-and-exclusions.md), [ADR-0045](0045-paid-by-the-company.md)
