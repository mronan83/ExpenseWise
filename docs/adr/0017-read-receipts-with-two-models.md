# ADR-0017: Read every receipt with two models until the tier is chosen

Each receipt is read by Haiku 4.5 and Sonnet 5.5 side by side, on the organization's own key, so the model-tier decision rests on the product owner's real receipts. Events reach the workflow runner right after commit, and the outbox relay becomes the safety net.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-10-02
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-19
- **Related:** [ADR-0006](0006-receipt-extraction.md) (receipt extraction), [ADR-0012](0012-eval-set-composition.md) (eval set), [ADR-0013](0013-supabase-platform.md) (storage), [ADR-0014](0014-supabase-free-plan.md) (Free plan), [ADR-0015](0015-ai-provider-keys-in-app.md) (keys in the app)

## Context

Increment 0's extraction spike was to choose a model tier from accuracy and cost on the eval seed. It never ran, because no key reached the build environment. Keys now live in the app (ADR-0015). The product owner approved Sonnet and Haiku only, and asked for the receipt page directly.

Real receipts are better evidence than synthetic ones for one person's expenses: their merchants, their phone camera, their handwriting on tips. A page that reads each receipt with both tiers produces that evidence as a side effect of using the product.

The receipt path in the architecture (section 6.4) also needs its first real implementation: signed upload, outbox, workflow. Two gaps showed up while building it:

- With only the 5-minute relay, a receipt could wait minutes before it is read.
- Without `RELAY_DATABASE_URL`, the relay would fail on every sweep, and with retries that spends most of Inngest's free executions.

## Decision

1. **Both tiers read every receipt** (`COMPARISON_MODELS`), in parallel workflow steps, with the organization's stored Anthropic key.
   - Each reading is stored in `extraction_runs` with model, prompt and schema version, outcome, latency, tokens and cost, keyed by the request that asked for it.
   - Reading one receipt costs about two cents on the owner's key.
2. **Status until the tier decision:**
   - **Ready** (`extracted`) only when both models read the merchant, date, currency and total with high confidence and agree on them.
   - **Needs review** when at least one reading succeeded but that test fails.
   - **Failed** when no reading succeeded: no key, a rejected key, no credit, or a file that doesn't match what was described.
   - Agreement between two independent readings is a stronger Ready signal than either model's own confidence.
3. **The tier decision uses the page's running comparison:** receipts compared, how many the models read alike, and confidence, time and spend per model. Once the tier is chosen, `COMPARISON_MODELS` shrinks to one model and Ready falls back to ADR-0006's single-reading rule.
4. **The capture path follows section 6.4:**
   - The client asks for a one-time upload, sends the file straight to a private Supabase Storage bucket, then files it.
   - The server derives the storage path. It refuses an exact duplicate by SHA-256 before upload.
   - The workflow checks the stored file's size, hash and real type (magic bytes) before any model sees it.
   - The browser scales photos to about 2,000 px and re-encodes them as JPEG, which drops location metadata (ADR-0014's storage budget).
   - The bucket is created on first use with the existing `SUPABASE_SECRET_KEY`, so there is no new setting.
5. **Eager dispatch, relay as safety net:**
   - After commit, the API sends the outbox event to Inngest with the outbox id as the event id. A receipt is read in seconds.
   - If that send fails, the receipt is still filed. The relay's later copy of an event is dropped as a duplicate within 24 hours.
   - The relay is registered only when `RELAY_DATABASE_URL` is set. Without it, a failed eager send means the receipt waits for **Read again**.
6. **Failure handling:**
   - Errors retrying can't fix (401, 403, 400) are stored as failed readings with the provider's message, such as "Your credit balance is too low".
   - Errors a retry may fix are thrown, so the step retries.
   - If a run still fails, an `onFailure` handler settles the receipt from whatever was stored, so it never stays Reading forever.
7. **No feature flag.** The product owner is the only user and asked for this screen. The screen requires sign-in, and reading needs the organization's own key.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Run the spike harness on the synthetic eval seed first | It needs the key in the build environment, which failed repeatedly. Synthetic receipts also say less about this owner's receipts than their own do. The harness stays for regression (ADR-0012). |
| Read with one model now and pick the tier later | Gives no comparison, so the decision would rest on impressions. |
| Read inside the upload request | It breaks "slow or external work goes through the outbox and workflows". It would also tie a 5–15 second model call to the request and lose retries. |
| Relay only, no eager send | Simpler, but it adds up to 5 minutes before reading starts unless `RELAY_DATABASE_URL` is set, and that is one more manual setting. |
| Upload through the API | Vercel caps request bodies at 4.5 MB, and section 6.4 keeps image bytes out of the API. |

## Consequences

### Positive

- The tier decision gets evidence from real use, at about two cents a receipt.
- A filed receipt is read in seconds; locally the whole loop settled in 5.5 seconds with stand-in models.
- The receipt path in section 6.4 now exists end to end: signed upload, the outbox, the workflow, side-by-side review.

### Negative

- **Twice the model cost** until the tier is chosen. Contained by the per-reading cost shown on screen and the owner's own spend limit at Anthropic.
- **Two paths deliver events.** Both use the outbox id, and the reading workflow is idempotent: one reading per model per request, and one settlement per request.
- **The storage secret sees every object.** The API decides which path a client may upload to, and a receipt row can only name its own organization's path. That holds as long as the code holds. This is the same trust ADR-0013 accepted for signed URLs.
- **Without the relay, an event lost after commit needs Read again.** Setting `RELAY_DATABASE_URL` closes the gap.

## Exit path / reversibility

Choosing the tier means editing `COMPARISON_MODELS` and the Ready rule in `settleReading`. Stored readings keep their model, so the history stays comparable. Turning off eager dispatch means removing `dispatch` from the API options, and the relay then carries every event.

## Links

- [Architecture 6.4: receipt path](../05-architecture.md#64-receipt-path)
- [Runbook section 6: workflows](../runbooks/environment-setup.md#6-workflows-error-tracking-and-feature-flags)
