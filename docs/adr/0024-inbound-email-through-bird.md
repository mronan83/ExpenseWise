# ADR-0024: Inbound email through Bird

Email-in receipts arrive through Bird's inbound email service, not Postmark's.

- **Status:** Accepted (vendor decided by product owner; sender and webhook checks recommended, no objection)
- **Date:** 2026-10-03
- **Deciders:** Product owner (vendor); Claude (principal architect), for the controls
- **Decision register:** D-26

## Context

Email-in (FR-CAP-02, backlog #19) gives each person a receipts address. They email or forward a receipt, an airline or hotel email, or a purchase summary to it, and it is read like a photo ([ADR-0011](0011-travel-data-sources.md)). Phase 1 has no email domain of ours (D-15), so the address has to live on the provider's domain. The technology stack named Postmark for inbound. On Oct 3 the product owner chose Bird instead.

Bird's documentation, read Oct 3, says:

- An inbound address on Bird's own domain needs no domain of ours. The US region uses `us1.inbound.bird.com` and the EU region `eu1.inbound.bird.com`. Pointing a domain's MX records at Bird is also possible.
- A received message arrives as an `email.received` webhook. Its attachments come from `GET /v1/email/inbound-messages/{id}/attachments`. A message can be up to 20 MB.
- Each message carries `spf_pass` and `dkim_pass`. `dmarc_pass` is always null for now.
- The receiving guide doesn't say how a webhook is signed.

Only mail from an address the person signs in with may be read (FR-CAP-02), and a From header is easy to forge. Without a DMARC result, the provider doesn't tell us whether a passing DKIM signature belongs to the sender's domain.

## Decision

We will receive email-in through Bird, in its US region, on an address on Bird's inbound domain, until there is a domain of ours.

- **The webhook is authenticated before anything is stored.** Before the build, we confirm how Bird signs its webhooks and verify every call. If Bird can't sign them, the webhook URL carries a long secret, kept as a setting. Either way, a call that fails is answered 401 and dropped.
- **We decide who sent it.** A message is read only if its DKIM signature passed **and** the signing domain aligns with the From address's domain. This is the DMARC alignment check, done by us because Bird doesn't report DMARC yet. The From address must also be one of the person's sign-ins. Anything else is dropped, and the drop is counted, never shown to the sender.
- **It goes through the outbox.** The webhook stores the message and its attachments and appends an outbox event in one transaction. Reading happens in the workflow, as for an upload. The webhook does no slow work inline.
- **Behind the same adapter.** An `InboundMail` interface turns the provider's message into ours: sender, sign-in check, subject, text, attachments. Nothing past it knows the provider.
- **Out of scope:** outbound email. Whether Bird also replaces Resend is decided when a sender domain is added (D-15).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Postmark inbound | Mature, and it documents webhook protection. The product owner chose Bird. |
| Amazon SES inbound | Needs a domain of ours and more plumbing (S3 and SNS) for one address. |
| Gmail or Outlook sync only | That is Phase 2 back-fill (ADR-0011). It doesn't give a forwarding address. |

## Consequences

### Positive

- One provider account and no domain to reach a working forwarding address.
- The sender check doesn't depend on any provider's DMARC verdict, so it survives a later change of provider.

### Negative

- Bird's inbound product documents less than Postmark's. How webhooks are signed is an open question until the build. The build waits on that answer, not on guesswork.
- Our own DKIM alignment check is code we own and must test against real mail, including forwarded mail, whose DKIM often breaks in transit. Mail that fails the check is dropped. Its sender has to send from their own address or attach the receipt.
- A forwarding address on Bird's domain changes once we have a domain. People update their forwarding rule then.

## Exit path / reversibility

The `InboundMail` adapter is the only code that knows Bird. Moving to Postmark or SES means writing a new adapter and a new webhook route, then giving people a new address. The stored messages, the outbox event and the reading pipeline stay as they are.

## Links

- [ADR-0011: Travel data sources](0011-travel-data-sources.md), [Technology stack](../05-architecture.md#68-technology-stack)
- Bird: [Receiving email](https://bird.com/en-us/docs/guides/email/receiving-email), [inbound messages CLI reference](https://bird.com/docs/cli/reference/email-inbound-messages)
