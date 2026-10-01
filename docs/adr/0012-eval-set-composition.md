# ADR-0012: Eval set composition

Build the extraction eval set in layers (public, synthetic, the owner's past emails if permitted, then real captures) and report accuracy by layer.

- **Status:** Proposed (awaiting product owner: permission to search the owner's Gmail for past receipts)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-12 ("Eval set without a shoebox")

## Context

A unit test proves that code does what it says. An eval measures how often the model reads a receipt correctly. The model-tier choice depends on those numbers ([ADR-0006](0006-receipt-extraction.md)). There is no shoebox of past receipts to label. Public and synthetic data flatter the model, so the tier choice is re-confirmed after about 100 real receipts (roughly four weeks of everyday capture).

## Decision (proposed)

Build the eval set in four layers, and always report accuracy by layer:

1. **Public datasets:** CORD v2 and SROIE (CC BY 4.0) and ExpressExpense US restaurant receipts (MIT).
2. **Synthetic documents:** hotel folios and e-ticket receipts with known answers, since no public folio dataset exists.
3. **The owner's past travel emails, with permission.** Claude searches the owner's Gmail for past airline, hotel and ride receipts to seed the real-world layer. Nothing is stored until the owner has reviewed the list, and none of it goes into the git repository.
4. **Real captures:** every receipt captured from Phase 1 on. Every correction in the inbox becomes a candidate for the set.

Layers 1 and 2 form the Phase 0 eval seed for the extraction spike. Staging uses the anonymized eval receipts.

**Open question for the product owner:** may Claude search the owner's Gmail for past airline, hotel and ride receipts?

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Public and synthetic data only | Gives optimistic accuracy numbers. |
| Skip the inbox search and build the real-world layer from new captures only | This is the fallback if permission is declined. It works, but the re-confirmation then waits for about 100 real receipts from new captures alone (roughly four weeks of everyday capture), with no head start from past trips. |

## Consequences

### Positive

- Accuracy is honest because it is reported by layer.
- The tier decision rests on real receipts, not only on flattering data.

### Negative

- Searching personal email is sensitive. It needs explicit permission, review before storage, and exclusion from git.
- Synthetic folios and e-tickets have to be generated and labeled.
- Public datasets carry license terms (CC BY 4.0 and MIT) that must be respected.

## Exit path / reversibility

The layers are independent. Dropping the inbox layer leaves the other three, and because accuracy is reported by layer, the effect on the numbers is visible. To speed up the real-world layer, the owner snaps every receipt for the next few weeks, business or personal.

## Links

- [QA note in the test strategy](../06-delivery-lifecycle.md#75-test-strategy)
- [Receipt intelligence pipeline](../05-architecture.md#65-receipt-intelligence-pipeline)
- [Roadmap: Phase 0 scope](../07-roadmap.md#phases)
- [ADR-0006](0006-receipt-extraction.md)
