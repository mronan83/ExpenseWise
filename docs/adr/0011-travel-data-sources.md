# ADR-0011: Travel data sources

Email is the integration: email-in forwarding in Phase 1, opt-in Gmail and Outlook sync in Phase 2, and Plaid for charges.

- **Status:** Accepted (recommended; no objection)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-11

## Context

None of Delta, United, American, Southwest, Marriott, Hilton, IHG or Hyatt gives third-party apps access to a traveler's own bookings, receipts, folios or loyalty activity (checked 30 September 2026). Their developer programs sell seats and rooms through agencies. Concur's partner program needs fees, certification and an established business, and TripIt's API is closed to new apps. Delta's SkyMiles rules forbid account access by aggregation apps. Airlines and hotels email the traveler instead.

## Decision

- **Phase 1: forwarding.** Move the email-in forwarding address from Phase 2 into Phase 1. It works for any sender and needs no OAuth review.
- **Phase 2: inbox sync.** Add opt-in, read-only Gmail and Outlook inbox sync for back-filling past trips. Gmail runs as an unverified app under the 100-user lifetime cap until we sell; testing mode is not used because it forces re-consent every 7 days. Outlook uses Microsoft Graph Mail.Read, which needs no audit.
- **Charges.** Use Plaid for card and bank charges ([ADR-0007](0007-bank-and-card-feeds.md)).
- **How emails get read.** Use schema.org reservation markup when present; otherwise Claude reads the body and any PDF attachment against the receipt schema.
- **Folio gap.** A hotel charge with no folio after 24 h becomes an inbox item asking the traveler to get the folio emailed and forward it.
- **Not built.** No loyalty scraping, and no partner feeds until the product is commercial.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Wait for airline and hotel APIs | They don't exist for small apps. |
| Partner e-receipt feeds (Concur TripLink, Marriott e-folio) | Need a commercial program: fees, certification, an established business. |
| Loyalty login scraping | Breaks program terms, and American and Southwest have won court cases against scrapers. |
| Booking through Duffel ($3 per order) | Gives first-party trip data but makes ExpenseWise a travel seller. Stays on the Horizon (P4). |
| Per-vendor HTML parsers | A maintenance trap when templates change. Added only if the eval set shows a sender we keep missing. |
| Gmail verification and CASA assessment now | Roughly $540 a year and up; only necessary when we sell. |

## Consequences

### Positive

- Travel receipts arrive automatically from Phase 1, from any sender; past trips can be back-filled in Phase 2.

### Negative

- It depends on travelers forwarding emails or opting in to sync.
- The unverified Gmail app is capped at 100 users for its lifetime.
- The folio gap needs a manual step from the traveler.

## Exit path / reversibility

When the product is sold, complete Google verification and the CASA assessment, and reconsider partner feeds. Every source feeds the same pipeline and schema, so adding one does not reshape the core.

## Links

- [Travel data](../05-architecture.md#611-travel-data), [capability map](../02-capability-map.md)
- [ADR-0006](0006-receipt-extraction.md), [ADR-0007](0007-bank-and-card-feeds.md)
