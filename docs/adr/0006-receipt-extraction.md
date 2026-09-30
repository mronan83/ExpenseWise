# ADR-0006: Receipt extraction

Extract receipt fields with Claude vision and structured outputs behind an `Extractor` interface, choosing the model tier from measured accuracy and cost.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-06 (recorded as "Approved · spike")

## Context

Reading a receipt is largely solved; automating an expense is mostly a data problem ([C4](../01-vision-and-scope.md#c4-automation-is-a-data-problem-more-than-an-ocr-problem)). Accuracy on hard receipts (R2) and cost per receipt (R6) are both open until measured. In the pipeline, the model does one job, Extract. Every other stage and every workflow decision is ordinary tested code.

## Decision

- **Model and interface.** Use Claude vision with structured outputs behind an `Extractor` interface. Responses are constrained to our JSON schema: merchant, date, currency, total, subtotal, taxes, tip, card last four, line items, document type and per-field confidence.
- **Spike first.** The spike runs in Phase 0 on the public and synthetic layers of the eval set ([ADR-0012](0012-eval-set-composition.md)). It reports accuracy and cost per receipt for each model tier, split by data source.
- **Tier selection.** Start with the most capable Claude tier at low effort to set the accuracy ceiling. Then run a mid tier and the smallest tier against the same eval set. A cheaper tier ships only if it holds accuracy on every field, and the product owner makes that trade once the numbers exist.
- **Re-confirmation.** Public and synthetic data flatter the model, so the tier choice is re-confirmed after about 100 real receipts (roughly four weeks of everyday capture).
- **Safety and traceability.** The model gets no tools, so receipt text that looks like an instruction is just data. Every run stores model, prompt version, latency, cost and output.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Receipt-specialist API: Veryfi, Mindee or AWS Textract AnalyzeExpense | Kept as a benchmark and a fallback rather than the default. The spike measures one on the same eval set. |
| Traditional OCR in a Python backend | Its advantage fades with model-based extraction, and it would add a second language. |

## Consequences

### Positive

- Reads messy receipts and returns schema-valid JSON, with no free-text parsing.
- Per-field confidence feeds the confidence gate and the Needs review inbox.

### Negative

- Cost scales with volume: roughly 2–3¢ per receipt on the most capable tier at list price, well under 1¢ on the smallest. Prompt caching helps; the spike measures the real figure.
- Early accuracy numbers are optimistic until the real-world layer is large enough.
- An eval harness must be maintained, and gate G6 runs extraction evals whenever a prompt or model changes.

## Exit path / reversibility

Everything calls the `Extractor` interface, so swapping the model tier or the provider is a configuration change plus an eval run. The specialist API benchmarked in the spike is the ready fallback. Re-processing stored receipts after a change goes through the Batch API at half price.

## Links

- [Receipt intelligence pipeline](../05-architecture.md#65-receipt-intelligence-pipeline), [receipt path](../05-architecture.md#64-receipt-path)
- [Test strategy and QA note](../06-delivery-lifecycle.md#75-test-strategy)
- [Risk register](../08-risk-register.md): R2, R6
- [ADR-0012](0012-eval-set-composition.md)
