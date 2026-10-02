# ADR-0020: GPT-5.6 Luna reads a receipt when Claude can't

When neither Claude model can read a receipt, the workflow reads it once with OpenAI's GPT-5.6 Luna on the organization's own OpenAI key. A fallback reading can make a receipt **Needs a look**, never **Ready**.

- **Status:** Accepted (fallback decided by product owner; the model and the Ready rule are recommended, no objection)
- **Date:** 2026-10-02
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-22
- **Amends:** [ADR-0015](0015-ai-provider-keys-in-app.md) (point 7, "OpenAI keys are stored, not yet used") and [ADR-0017](0017-read-receipts-with-two-models.md) (point 2, status)
- **Related:** [ADR-0006](0006-receipt-extraction.md) (receipt extraction), [ADR-0010](0010-residency-and-compliance.md) (subprocessors), [ADR-0012](0012-eval-set-composition.md) (eval set)

## Context

On Oct 2 the product owner's Anthropic account ran out of credit. Every receipt then failed with "Your credit balance is too low", although an OpenAI key was already saved in the app. ADR-0015 stored OpenAI keys but left them unused until an OpenAI extractor existed and had been compared on the eval set. The product owner asked for the fallback now.

Three facts shape it:

- **A receipt nobody reads is the worst outcome.** The person has to type it in. A reading that needs checking still saves most of that work.
- **The fallback is an unmeasured model.** It hasn't been run on the eval set or on the owner's receipts, so its confidence isn't calibrated against anything here.
- **Its cost doesn't matter much.** GPT-5.6 Luna lists at $0.20 per million input tokens and $1.20 per million output tokens (OpenAI pricing, read Oct 2). That is well under a cent per receipt, against about two cents for the Claude pair.

## Decision

1. **Claude first, always.** Haiku 4.5 and Sonnet 5.5 read every receipt as in ADR-0017. The fallback model reads **only when neither produced a reading**, for example:
   - no Anthropic key, or a key that can't be decrypted;
   - Anthropic refused the request: no credit, a rejected key, a rejected file;
   - Anthropic didn't answer after the step's retries. The model's reading is then stored as failed, `unavailable`, so the page says why.
2. **One reader, one model.** `FALLBACK_MODEL` is `gpt-5.6-luna`:
   - It is read through the Responses API, with strict structured outputs and the same prompt and receipt schema as Claude.
   - It gets no tools and low reasoning effort.
   - `store: false`, so OpenAI keeps no retrievable copy of the response.
   - The reader lives in `@expensewise/extraction` behind the `Extractor` interface (ADR-0006). It uses `fetch`, with no new dependency.
3. **The fallback can't make a receipt Ready.** With a fallback reading, the status is **Needs a look**. Without one it is **Failed**. Ready still requires the two Claude readings to agree with confidence.
4. **No OpenAI key, no fallback.** The step is skipped and nothing is stored, so organizations without an OpenAI key see exactly what they saw before.
5. **Errors are handled the same way as Claude's (ADR-0017 point 6).** One addition: OpenAI reports an empty balance as 429 `insufficient_quota`. That is stored as a failed reading with OpenAI's message instead of being retried. Every other 429 is a rate limit and is retried.
6. **Shown, not hidden.**
   - The receipt page shows the fallback reading in its own column, marked *fallback*.
   - The verdict says that Claude couldn't read the receipt and that this is a single reading.
   - The comparison gets a fallback row once the fallback has been used, so its spend is visible. Its readings never count towards the "compared" and "agreed" numbers the tier decision uses.
   - Stored runs record `extractor: 'openai'`.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Top up Anthropic credit and build nothing | That fixes today's failure but not the next one: an outage, an expired card, a revoked key. It remains the first fix, and it is recommended alongside this change. |
| Read every receipt with OpenAI too, as a third comparison | Adds cost and noise to the tier decision for a provider nobody asked to evaluate, and it sends every receipt to a second subprocessor. |
| Let a confident fallback reading make a receipt Ready | Ready means "you don't need to look". Neither the eval set nor these receipts have measured this model, so its "high confidence" isn't yet evidence. Revisit once fallback readings can be compared with Claude's on the same receipts. |
| A larger OpenAI model | Costs more for a path that should be rare. The receipt still gets a human look, which catches what a smaller model misses. |
| Run the eval-set comparison first (ADR-0015 point 7) | The harness needs a key in the build environment, which has failed repeatedly (ADR-0017). The Ready rule above contains the risk until a comparison exists. |

## Consequences

### Positive

- A receipt is read even when Anthropic can't be used. The person checks it instead of typing it.
- Outages and empty balances surface with the provider's own message, per model.
- OpenAI keys, stored since ADR-0015, now do something, and only when needed.

### Negative

- **A second subprocessor sees receipt images, but only on the fallback path.** The images go to the organization's own OpenAI account under its own terms, like Anthropic under ADR-0015. `store: false` keeps no retrievable copy. OpenAI's API data policy may still keep inputs for a limited period for abuse monitoring. Deleting the OpenAI key turns the fallback off.
- **Readings from two providers sit side by side.** The models may read the same receipt differently. Contained because fallback readings never count as compared and never make a receipt Ready.
- **An outage now costs more steps.** Each Claude step that runs out of retries adds a step to record it, plus the fallback step. That is still a handful of executions per receipt on Inngest's free plan.
- **The schema conversion is ours.** Strict mode needs every object closed and every field required. `strictJsonSchema` makes sure of that and is tested. If OpenAI rejects the schema, the reading is stored as failed with OpenAI's message.

## Exit path / reversibility

- **To turn the fallback off for one organization,** remove its OpenAI key.
- **To remove it from the code,** delete the fallback step in `receiptReadingFunction`. Stored readings keep their model and extractor, so history stays readable.
- **To change the model,** edit `FALLBACK_MODEL` and its entry in `MODELS`.
- **To let the fallback make a receipt Ready,** change one branch in `settleReading`. That needs evidence first: fallback and Claude readings of the same receipts that agree.

## Links

- [ADR-0015: AI provider keys in the app](0015-ai-provider-keys-in-app.md)
- [ADR-0017: Read every receipt with two models](0017-read-receipts-with-two-models.md)
- [Architecture 6.4: receipt path](../05-architecture.md#64-receipt-path)
