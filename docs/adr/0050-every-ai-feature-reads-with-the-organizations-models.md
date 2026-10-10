# ADR-0050: Every AI feature reads with the organization's models

Anything the app asks a model to read is read by the organization's primary AI model, then by each back-up that is on, in the order set in Settings › AI models. No feature names a model of its own. A card statement is the first feature after receipts to follow the rule, and a test fails if any workflow names a model itself.

- **Status:** Accepted (decided by product owner, Oct 10: "the app features should use that model")
- **Date:** 2026-10-10
- **Deciders:** Product owner; Claude (principal architect), for the design
- **Decision register:** D-52
- **Amends:**
  - [ADR-0046](0046-card-statements-and-matching.md) point 2, which had Claude Sonnet read every statement on the Anthropic key.
  - [ADR-0033](0033-ready-on-one-confident-reading.md), whose primary and back-ups read receipts, and now every reading.

## Context

On Oct 10 the product owner's Cardholder Activity PDF failed to read. Production's logs show four tries, each answered by Anthropic: *"Your credit balance is too low to access the Anthropic API."*

- **The statement reader named its own model.** ADR-0046 had Claude Sonnet read every statement on the Anthropic key. That was Claude's recommendation, never confirmed, and it ignored the AI model settings that receipts already follow (FR-INT-16).
- **The records already said it couldn't work.** Since Oct 4 they noted that the product owner chose not to buy Anthropic credit (#4, withdrawn). A statement could not be read at all on this account.
- **The failure hid its cause.** Receipts tell an error retrying can't fix from an outage (`permanentFailure`); statements didn't. Each retry asked again, and the person was told only *"It couldn't be read. Try again."* (GAP-50).
- **The product owner's rule:** the point of choosing a primary model is that the app's features use it (GAP-49).

## Decision

1. **One way to choose a model.** Every reading takes its models from `modelOrderFor` in `packages/workflows/src/reading-plan.ts`:
   - the primary, then each back-up that is on, in the order set;
   - less any model whose provider the organization has no key for, or the operator stopped.
   - With AI model settings off, the defaults the settings start from, Sonnet 5.5, then Haiku 4.5 and GPT-5.6 Luna (R-MODEL-DEFAULTS).
   - A receipt's side-by-side comparison, used only while the settings are off, is unchanged (ADR-0017).
2. **A statement is read like a receipt under the settings.**
   - The primary reads it, each model in a step of its own.
   - A back-up reads only when the models before it gave no reading.
   - Either provider can read it: an OpenAI reader sits beside Claude's, with the same instructions (`statement-v1`) and structure, no tools, and nothing stored at OpenAI.
3. **An error retrying can't fix hands the statement on.** A rejected key or no credit is told apart as receipts do. That model is asked once, and the next one reads. A step that runs out of retries, as in an outage, hands it on too.
4. **When no model can read it, the statement says why:**
   - it names each model tried and what its provider said;
   - when none is on or none has its key, it says so;
   - either way, it offers the downloaded list, which needs no model.
5. **A guard keeps it so.** `workflows/reading-plan` fails when any workflow source names a model id.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep a model per feature | Splits one setting into several the owner must keep in step. The owner's rule is one primary for the app. |
| A separate model setting for statements | No evidence yet that a statement needs a different tier. The totals check already holds a poor reading for a look. Revisit if one model does well on receipts and badly on statements. |
| Fall back to Claude whatever the settings | Pays a provider the owner chose not to fund, and fails anyway while it has no credit. |

## Consequences

### Positive

- The owner's choice of model governs every AI cost and every reading.
- A statement is read on the account that is funded, and a turned-down provider costs one call, not four.
- A failure names its cause, so the person can act on it.

### Negative

- **A statement read by a smaller primary may miss more lines.** The totals check holds such a reading for a look rather than matching it. No eval has run on statements with any model.
- **Two readers to keep in step.** The OpenAI statement reader repeats Claude's instructions and structure; `statement-v1` versions both.

## Exit path / reversibility

Name a model in `cardStatementReadingPorts` again, and drop the guard. Nothing stored changes: each statement keeps the model that read it.

## Links

- [ADR-0033](0033-ready-on-one-confident-reading.md), [ADR-0046](0046-card-statements-and-matching.md), [ADR-0017](0017-read-receipts-with-two-models.md)
- FR-INT-16, FR-CAP-10, F-45, F-65, US-READ-17 AC13, US-CAP-07 AC10 and AC11, GAP-49, GAP-50, GAP-51, backlog #103
