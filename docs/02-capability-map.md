# Capability map

What the business must be able to do, by capability area and phase; this map is the scope contract (blueprint §3).

A request that doesn't map to a capability here is a new capability, and it gets a decision rather than a quiet addition.

## Phase legend

- **P1 · Golden path**
- **P2 · Automate**
- **P3 · iPhone and scale**
- **P4 · Horizon.** Each item needs its own business case; none is assumed.

Phase 0 (Foundations) builds the platform under all of these. Weeks, scope and exit criteria for each phase are in the [roadmap](07-roadmap.md).

## Map

| Area | Purpose | P1 · Golden path | P2 · Automate | P3 · iPhone and scale | P4 · Horizon |
| --- | --- | --- | --- | --- | --- |
| Capture | Get evidence in with the least effort | Camera and upload<br>PDF and multi-page<br>Manual mileage<br>Route-based mileage<br>Email-in forwarding | Inbox sync (Gmail, Outlook)<br>Bank and card feeds | Offline capture queue<br>Automatic GPS mileage | SMS and chat capture<br>Travel booking via partner |
| Intelligence | Turn evidence into correct data | Field extraction<br>Confidence-gated review<br>Exact-duplicate detection<br>Category suggestion | Receipt ↔ transaction matching<br>Near-duplicate detection<br>Merchant normalization<br>Learned categorization | – | Anomaly and fraud signals |
| Expense management | Organize spend around how people work | Expenses<br>Trips and trip history<br>Reports | Split expenses<br>Multi-currency and FX<br>Meal attendees | Per diem<br>Recurring expenses | – |
| Governance | Control without friction | Roles and permissions<br>Single-step approval<br>Audit trail | Policy engine<br>Multi-step routing and delegation<br>Auto-submit and auto-approve rules | – | Budgets |
| Settlement | Close the loop with money and the ledger | CSV and PDF export | QuickBooks and Xero sync | Reimbursement payouts | ERP connectors<br>Corporate cards via partner |
| Insights | Know where the money goes | Personal dashboard<br>Trip history and search | Team spend analytics<br>Mileage and tax summaries | Custom report builder | – |
| Platform | Run it safely | Organizations and tenancy<br>Sign-in and TOTP MFA<br>Email notifications<br>Admin console | – | Push notifications<br>SAML SSO<br>Passkeys, once GA<br>Public API and webhooks | SCIM, once the identity provider supports it |

## Changes in v0.3

- **Email-in forwarding is P1.** It moved from Phase 2 into Phase 1. Without an airline or hotel API, it is the only automatic route for travel receipts, and it needs no OAuth review ([ADR-0011](adr/0011-travel-data-sources.md), [travel data](05-architecture.md#611-travel-data)).
- **Inbox sync (Gmail, Outlook) is P2.** Opt-in inbox sync, for back-filling past trips, stays in Phase 2.

## Changes after v0.3

The repository docs are canonical from v0.3 onward. Changes made here since the v0.3 blueprint:

- **Near-duplicate detection (P2)** added to Intelligence. Exact-duplicate detection (SHA-256) stays P1; the perceptual hash for near-duplicates is P2.
- **Travel booking via partner (P4)** added to Capture, so the roadmap's Phase 4 scope maps to a capability.
- **Identity on Supabase ([ADR-0013](adr/0013-supabase-platform.md)).** P1 sign-in uses TOTP MFA. Passkeys move to P3, once Supabase's beta is generally available. SAML SSO stays P3 (Supabase Pro). SCIM moves to P4, since Supabase doesn't offer it for end users yet.

## Related

- [Roadmap](07-roadmap.md): phase scope and exit criteria.
- [Journeys and workflows](03-journeys-and-workflows.md): the golden path these capabilities serve.
- [Risk register](08-risk-register.md): R1 (scope creep) is mitigated by this map.
