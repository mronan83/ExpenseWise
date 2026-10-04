# ADR-0033: Each organization chooses its AI models, and Ready rests on one confident reading

Once an organization switches on AI model settings, its owners and finance admins switch each AI model on or off and choose exactly one primary. The primary reads every receipt. A model that is on but not primary is a back-up, which reads only when the models before it produced no reading, in the order set. A receipt is **Ready** on one confident reading whose sums and date pass, not on two readings that agree. With every model off, a receipt is filed for a person to fill in. The operator can stop any model for every organization at once.

- **Status:** Accepted (switches, primary, back-ups, every model off and the operator switch decided by product owner, Oct 3, Q8 and Q11; the Ready rule, the defaults and the mechanism recommended, no objection yet)
- **Date:** 2026-10-04
- **Deciders:** Product owner (FR-INT-16, Q8, Q11); Claude (principal architect), for the Ready rule, the defaults and the design
- **Decision register:** D-35
- **Amends:** [ADR-0017](0017-read-receipts-with-two-models.md) (points 1 to 3: two models side by side, and Ready when they agree) and [ADR-0020](0020-openai-fallback-reader.md) (the fallback, and that its reading is never Ready), for each organization with `receipts.model-settings` on. With it off, both hold unchanged.
- **Related:** [ADR-0006](0006-receipt-extraction.md) (receipt extraction), [ADR-0015](0015-ai-provider-keys-in-app.md) (keys in the app), [ADR-0021](0021-confirming-a-reading.md) (confirming a reading), [ADR-0022](0022-expense-follows-its-receipt.md) (the expense follows its receipt), [ADR-0032](0032-features-switched-per-organization.md) (features switched per organization)

## Context

ADR-0017 had Haiku 4.5 and Sonnet 5.5 read every receipt side by side until the model tier was chosen (#21), and made a receipt Ready only when both read its merchant, date, currency and total with high confidence and agreed. ADR-0020 added GPT-5.6 Luna as a fallback when neither could read it, a reading that is never Ready.

On Oct 3 the product owner asked for a switch per AI model in Settings, for owners and finance admins, with exactly one primary, and an operator switch per model (FR-INT-16). Their answers settled the rest:

- **Q8:** each organization switches its models and the operator keeps a switch per model (1C); every model may be off, and a receipt is then filed for a person to fill in (2A); OpenAI's model is no longer a fallback but a model like the others, and any model can be primary.
- **Q11:** exactly one model is primary and reads every receipt; any other model that is on is a back-up, reading only when the primary can't, in the order set (B). The optional side-by-side comparison was not part of the answer.
- **Oct 3:** any model that is on can be made primary at any time, whatever the eval set says of it.

Reading each receipt once removes the second reading that ADR-0017's Ready rule compares, so Ready needs a new rule.

## Decision

1. **The settings are a feature, switched per organization.** `receipts.model-settings` (ADR-0032). With it off, receipts are read exactly as ADR-0017 and ADR-0020 say. With it on, this decision applies, from the next reading on; Read again uses the settings as they are then.
2. **One row per model per organization** in `org_ai_models`: on or off, its place in the order, and which one is primary. The database allows one primary at most, and only one that is on. Saving is for owners and finance admins, and appends `ai_models.changed` with the choice before and after, in the same transaction; a save that changes nothing records nothing.
3. **Every model in the price table can be chosen** (Opus 5.5, Fable 5.1 and GPT-5.6 Luna included). Until a choice is saved, the defaults are what read receipts before: Sonnet 5.5 primary, then Haiku 4.5, then GPT-5.6 Luna, with Opus 5.5 and Fable 5.1 off.
4. **A model with no key stays off.** Settings won't switch one on, and the workflow passes over one whose key was removed.
5. **The workflow reads one model at a time.** It reads the plan at the start of each reading (the organization's switch and settings, its keys, and the operator's stops), then tries the primary and each back-up in order, stopping at the first that produces a reading, confident or not. A model that fails (no credit, a rejected key, an outage after its step's retries) is stored as failed and the next one is tried. Each reading records its role, `primary` or `backup`.
6. **Ready rests on one confident reading.** The first reading made decides alone. It is Ready when its merchant, date, currency and total have high confidence and its sums and date pass (FR-INT-04), whichever model made it, a back-up included; otherwise it Needs a look, and its expense starts from it. A receipt every model tried failed to read is Not read.
7. **With every model off, a receipt is filed for a person to fill in.** It Needs a look with nothing read, says so in Needs you, and is confirmed by entering every field (ADR-0022 point 6), with no model named.
8. **The operator's switch per model** is a server-only flag, `operator.<model id>`. Set off in `FLAG_OVERRIDES`, that model reads no organization's receipts, whatever each chose; with model settings off, a stopped compared model is stored as failed with `stopped`, and a stopped fallback isn't asked. Unset, each organization decides.
9. **Settings shows the evidence beside the choice:** for each model, how it has read the organization's latest receipts (readings, how many were sure, time and spend), what it does now, and its list price. This is how the tier decision (#21) is made and changed.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep two models reading every receipt, and Ready when they agree (Q11 A) | Twice the cost of every receipt; the product owner chose B. |
| Make a back-up's reading never Ready, as the fallback's was | The product owner made OpenAI's model a model like the others, and any model can be primary. A back-up reads only when the primary couldn't; holding its confident reading for a look would make every outage a pile of manual work. |
| Ask the back-ups when the primary is unsure, not only when it fails | Q11 says a back-up reads when the primary can't. An unsure reading is still a reading, and a look settles it for less than a second model call. |
| Keep the last model from being switched off (Q8 2B) | The product owner chose 2A: every model may be off, since a receipt can always be filled in by hand. |
| Offer only the models that read receipts before | Any model can be primary (Q8). Opus 5.5 and Fable 5.1 start off, so they cost nothing until switched on. |
| Store the choice as one JSON value per organization | One row per model keeps the one-primary rule in the database, and adding a model needs no data migration. |

## Consequences

### Positive

- **About half the model cost per receipt,** with no second reading of every receipt.
- **Receipts keep moving through an outage:** a back-up reads when the primary can't, and Ready is still possible.
- **The tier decision is the owner's, and reversible at any time,** with the evidence on the same screen.
- **Spend stops for every organization at once** when the operator stops a model.

### Negative

- **Ready no longer has two independent readings behind it.** One confident reading is weaker evidence than two that agree (ADR-0017). Contained by the sums and date checks, and by the eval set and the comparison that remain; re-confirming the choice after about 100 real receipts is not prompted yet (GAP-30, #73).
- **The running comparison stops growing for organizations with the setting on,** since two models no longer read the same receipt. Each model's own record keeps counting.
- **Readings are made one after another,** so an outage of the primary adds its retries before a back-up reads.
- **The operator's switch needs a deploy:** `FLAG_OVERRIDES` is read when the server starts (ADR-0032).

## Exit path / reversibility

- **Per organization,** switching `receipts.model-settings` off returns to ADR-0017 and ADR-0020 from the next reading on; the saved choice stays for later.
- **In the code,** the plan is one function (`readingPlanFor`) and the Ready rule one branch of `settleReading`. Removing the flag removes the side-by-side branch, `COMPARISON_MODELS` and `FALLBACK_MODEL`.
- **Readings keep their model and role,** so every receipt's history stays readable whichever rule decided it.

## Links

- FR-INT-16, FR-INT-08, FR-INT-09, NFR-AI-04; Q8, Q11; backlog #52 and #21
- [ADR-0017](0017-read-receipts-with-two-models.md), [ADR-0020](0020-openai-fallback-reader.md), [ADR-0032](0032-features-switched-per-organization.md)
