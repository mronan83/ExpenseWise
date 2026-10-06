# ADR-0026: Email-in through a Bird agent mailbox

Email-in receipts arrive at a Bird agent mailbox on `inbox.ai`. We fetch each message exactly as it arrived and check its sender's DKIM signature ourselves, then file its attachments as receipts in a background workflow.

- **Status:** Accepted (mailbox and allowlist set up by product owner; how it is read and checked recommended, no objection); point 1 amended on Oct 6: the webhook is a function of its own, at the product owner's word after Bird reported failing deliveries (GAP-39, #93)
- **Date:** 2026-10-03
- **Deciders:** Product owner (mailbox, receive policy); Claude (principal architect), for the design
- **Decision register:** D-28. Amends [ADR-0024](0024-inbound-email-through-bird.md).

## Context

[ADR-0024](0024-inbound-email-through-bird.md) chose Bird for email-in. It assumed an inbound address on `us1.inbound.bird.com`, the `email.received` event, and a webhook that stores the message in one transaction with an outbox event. On Oct 3 the product owner created an **agent mailbox** instead, `jpdf7j4q5ukxcliugqji@inbox.ai`, and set its receive policy to **allowlist** (Q16). We have no domain of our own (D-15), so `inbox.ai` is the address for now.

Bird's documentation and API spec, read Oct 3, say this about a mailbox:

- **The event.** Arriving mail raises `email_mailbox.message_received`. It carries `message_id`, `thread_id` and `mailbox_id`.
- **The sender.** The event's `from` is the **envelope** sender, not the From header.
- **Authentication results.** The event gives `dkim_pass` and `spf_pass`, but no signing domain, and `dmarc_pass` is always null. So the event alone can't tell whether a passing signature belongs to the From domain.
- **The raw message.** `GET /v1/email/threads/{thread_id}/messages/{message_id}/raw` returns the message exactly as received (RFC 5322), for 30 days. After that it returns `410 Gone`.
- **Webhook signing.** Webhooks are signed the Standard Webhooks way (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
- **Delivery.** A webhook that fails is retried 8 times over about 27.5 hours.
- **The allowlist.** It checks the envelope sender. Blocked mail is stored quietly and raises no webhook.

Two facts shape the design:

- **The organization is unknown until the sender is checked.** An email names no organization. Every tenant table, the outbox included, needs one.
- **The sender check needs the raw bytes.** Only the raw message lets us check the From header against its DKIM signatures.

## Decision

We will read email-in from the Bird agent mailbox as follows.

1. **The webhook only verifies and hands off.** `POST /api/v1/inbound/bird` checks the Standard Webhooks signature against `BIRD_WEBHOOK_SECRET`. It works on the exact body bytes and allows 5 minutes of clock difference. A delivery that fails the check is answered 401.
   - For `email_mailbox.message_received`, the webhook sends one `email/received` event to the workflow runner. The event's id is the Bird message id, so a repeat delivery within a day starts nothing. Other events are acknowledged and ignored.
   - If the hand-off fails, the webhook answers 503, and Bird's own retries keep the email from being lost.
   - This replaces ADR-0024's "store and outbox in one transaction". That needs an organization, which isn't known yet. Bird's redelivery does the job the outbox would.
   - *Amended Oct 6 (#93, GAP-39):* the webhook is a function of its own. Bird waits 5 seconds for an answer, and in the whole API's function a cold start alone took 2.4, growing with every feature, while email arrives so rarely that nearly every delivery starts cold. The handler (`birdWebhook` in `@expensewise/api/bird-webhook`) needs nothing else of the API; the web app serves it at `app/api/v1/inbound/bird` with a setting of its own, so Vercel bundles it apart, and hands off through the workflow client alone (`@expensewise/workflows/client`). A lint rule refuses any other import there. The API keeps the operation in its contract with the same handler, and its own function leaves it unconfigured, so a delivery that ever reached it would get 503 and be sent again. The server loads error tracking only once it has a DSN. Since this change, a signed event the webhook doesn't read is acknowledged whatever else its envelope carries, and while nothing can take an email on, an arriving one is answered 503 after its signature is checked.
2. **The workflow fetches the raw message and checks the sender.** The `email-reading` function fetches the message with `BIRD_API_KEY` (scope `mailbox:read`). It then checks DKIM with mailauth. The From address counts as proved only when all of these hold:
   - the message has exactly one From address;
   - a signature passes;
   - the signing domain aligns with the From domain (relaxed alignment, as DMARC has it);
   - the signature covers the whole body (no `l=` tail).

   SPF and the envelope sender prove nothing about From and are not used. The allowlist stays as a first gate in front of this.
3. **Only a member's sign-in address counts.** The proved From address must be one of a member's sign-ins. The `member_for_sign_in_email` database function answers that question and returns only ids, so the runtime still can't read sign-ins across organizations. Mail from anyone else is dropped with nothing stored, and the run records the outcome.
4. **What is kept.**
   - **Verified sender:** every attachment that can be a receipt is stored and filed exactly like an upload, with its expense, outbox event and audit event. The body text, at most 64 KiB, is kept for reading purchase summaries later (#58).
   - **A member's address that fails the check:** the email is kept as `unverified`, with its subject only. Nothing is filed and no body is kept, so the member can be shown that it came.
   - **What counts as a receipt:**
     - a PDF, or a picture we can read, judged by its bytes;
     - up to 10 MB each and ten per email;
     - not pictures under 16 KiB, or under 128 KiB when the email's own HTML shows them, since those are logos and banners;
     - each file once.
5. **Every id comes from the message.** Each email and receipt id is derived from the Bird message id and the file's hash, and storage saves replace. A retried step therefore makes the same records again. A step that kept the email but failed before handing on its receipt events finds the email kept and sends those events again, for receipts still waiting to be read.
6. **The raw message is the adapter.** Past `fetchRaw`, nothing knows Bird. A different provider needs a new fetch and a new webhook route, nothing more.

Out of scope for this slice: reading the email body as a receipt or purchase summary (#58), showing the address and unverified emails in the app, and outbound mail.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Trust Bird's `dkim_pass` | It doesn't say which domain signed. Anyone can send a message signed by their own domain with a forged From, and it would pass. |
| Check the event's `from` against sign-ins | That is the envelope sender, which is easy to set and often a bounce address. It proves nothing about who wrote the message. |
| Store the email in the webhook, then use the outbox | The organization isn't known until the sender is checked, and checking it means fetching the message, which is slow work we keep out of requests. |
| Fetch attachments through Bird's attachment API | That is several calls per email, and the bytes still have to be matched to the DKIM-checked message. One raw fetch gives both. |

## Consequences

### Positive

- The sender check depends on no provider's verdict and is tested against real signatures in CI.
- Nothing about an email is stored unless its From address belongs to a member.
- A delivery repeated by Bird, by the runner or by a retried step files nothing twice.

### Negative

- **Automatic forwarding doesn't work.** A forwarding rule keeps the merchant's From address, which isn't a member's. Forwarding by hand works, because the forward is a new message signed by the person's own provider.
- **Sign-in addresses only.** A person whose sign-in address isn't the one they send from must add that address as a sign-in first. This includes Apple's Hide My Email addresses.
- **The 30-day limit.** An email that waits more than 30 days to be read can't be checked any more, and is dropped.
- **We own the check.** The DKIM alignment check is code we own and must keep current with mailauth.

## Exit path / reversibility

The workflow's ports are the only code that knows Bird: `fetchRaw` and the webhook route. Moving to another provider, or to our own domain, means a new fetch, a new webhook route and a new address for people to use. The tables, the sender check and the receipt pipeline stay as they are.

## Links

- [ADR-0024: Inbound email through Bird](0024-inbound-email-through-bird.md), [ADR-0017: Read receipts with two models](0017-read-receipts-with-two-models.md), [ADR-0022: Expense follows its receipt](0022-expense-follows-its-receipt.md)
- Bird: [Mailboxes](https://bird.com/en-us/docs/guides/email/mailboxes), [Receiving email](https://bird.com/en-us/docs/guides/email/receiving-email), [Webhooks](https://bird.com/en-us/docs/guides/webhooks)
- [Standard Webhooks](https://www.standardwebhooks.com/), [RFC 6376: DKIM](https://www.rfc-editor.org/rfc/rfc6376), [RFC 7489 §3.1: DMARC identifier alignment](https://www.rfc-editor.org/rfc/rfc7489#section-3.1)
