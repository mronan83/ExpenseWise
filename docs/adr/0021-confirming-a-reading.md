# ADR-0021: A person confirms or corrects a reading that needs a look

A receipt that needs a look offers two actions: **Looks right** confirms a reading as it is, and **Edit a field** corrects it first. Either makes the receipt **Ready**. What the person confirmed is stored apart from what the models read, and each correction keeps what the model read beside it.

- **Status:** Accepted (the two actions requested by product owner; the storage and rules recommended, no objection)
- **Date:** 2026-10-03
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-23
- **Amends:** [ADR-0020](0020-openai-fallback-reader.md) (point 3: a person can now make a fallback reading Ready; the model still can't)
- **Related:** [ADR-0006](0006-receipt-extraction.md) (receipt extraction), [ADR-0012](0012-eval-set-composition.md) (eval set), [ADR-0017](0017-read-receipts-with-two-models.md) (two readings)

## Context

On Oct 2 the product owner reported that a receipt marked **Needs a look** was a dead end: the page offered only **Read again** (GAP-17). The receipt review design (design §5.3) has always had **Looks right** and **Edit a field**, and the journeys (§4.5) end a review with the receipt Ready. Since Oct 3, buying Anthropic credit has been deprioritized (#4), so every receipt is read by the fallback model, and by ADR-0020 every one of them needs a look. Without this, no receipt can become Ready at all.

Three facts shape it:

- **The readings are evidence and must stay as read.** They feed the tier decision (ADR-0017) and the eval set (ADR-0012). A correction that overwrote a reading would erase exactly what the eval set needs: where a model was wrong.
- **There is no expense to file into yet.** Turning a settled receipt into an expense is #6. The confirmed values must be ready for it, in domain types.
- **Readings can change underneath a person.** Read again starts a new request while the page still shows the old readings.

## Decision

1. **One operation, two buttons.** `POST /v1/receipts/{receiptId}/confirm` takes the reading to start from (by model) and, optionally, the fields the person changed. **Looks right** sends no changes; **Edit a field** sends the changed fields.
   - The fields are merchant, date, currency, total, tax and tip.
   - Amounts are plain decimals in the receipt's currency, parsed exactly by `@expensewise/domain`, never rounded.
   - A corrected currency keeps the printed amounts. It is not a conversion.
2. **Only from Needs a look, only against the latest readings.** The receipt row is locked, and the request is refused (409) if the receipt is being read, is already Ready, or was read again after the readings were shown.
3. **Filing fields must be complete.** Merchant, date, currency and total are required, as for an automatic Ready (ADR-0006). A reading that lacks one can't be confirmed as it is; the person enters it. A tax or tip the receipt doesn't print counts as zero, as it is shown (FR-INT-14).
4. **A review row, apart from the readings.** `receipt_reviews` records who confirmed which reading of which request, and the values the receipt is filed with: typed columns, money as integer minor units with an ISO 4217 code. It has forced row-level security, like every tenant table. It is append-only: the app role can select and insert, never update or delete.
5. **Corrections keep both sides.** Each correction stores the field, what the model read (null if it read nothing) and what the person entered. Only real changes count; a value re-entered unchanged is not a correction. These rows are the eval set's candidates from real receipts (ADR-0012). They stay in the database and never go in git.
6. **Ready means a person or two models said so.** The receipt status becomes `extracted`, shown as Ready, in the same transaction as the review row and a `receipt.confirmed` audit event that names the reading, the request and the corrections. The receipt's merchant, date and total then come from the review. The page says who confirmed which reading and what they corrected.
7. **Reading again starts over.** A review applies only while its request is the latest and the receipt is Ready. Read again warns first, then shows the new readings. The old review stays in the table and the audit trail.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Write corrections into the reading itself | Loses what the model read, which is what the eval set and the tier decision need. |
| A separate `confirmed` receipt status | Every list, filter and the expense step (#6) would need to treat two statuses as Ready. The review row already records that a person confirmed it. |
| Confirmed values as JSON on the receipt row | Money and dates as untyped JSON invite floats and bad dates. Typed columns with checks keep the money invariant. A row per confirmation also keeps history. |
| Separate endpoints for confirm and for edit | Two ways to reach the same state, and a half-corrected receipt in between. One call either files it or changes nothing. |
| Let any Ready receipt be corrected | A Ready receipt reaches an expense in #6, where a correction is a reversal plus a new version. Corrections after Ready belong there, with #37. |

## Consequences

### Positive

- Every receipt can now become Ready, including fallback-only ones.
- Real corrections accumulate as eval candidates from the first day.
- The audit trail says who decided what each receipt is filed with.

### Negative

- **A person can confirm a wrong reading.** Ready no longer always means two models agreed. Contained: the page and the audit event say who confirmed which reading, and approval (#24) is a second look for teams.
- **One more tenant table.** Contained by the same forced row-level security, composite foreign keys and policy-coverage test as every other.
- **The eval candidates aren't exported yet.** They wait in the database until the real-world eval layer is built (#39).

## Exit path / reversibility

- **To stop confirmations,** remove the route and the page's review panel. Reviews already made keep their receipts Ready, and the audit trail keeps the record.
- **To move the values onto expenses,** #6 reads the current review, so nothing here changes.
- **To allow corrections after Ready,** add them on the expense, as a reversal plus a new version.

## Links

- [Design §5.3: receipt review](../04-app-design.md#receipt-review)
- [Journeys §4.5](../03-journeys-and-workflows.md)
- [ADR-0020: GPT-5.6 Luna reads a receipt when Claude can't](0020-openai-fallback-reader.md)
