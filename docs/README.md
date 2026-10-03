# ExpenseWise documentation

Index of the ExpenseWise product, architecture and delivery docs, translated from the approved solution blueprint v0.3 (30 September 2026).

## Purpose

ExpenseWise is a receipt-first, automation-first expense, receipt, mileage and trip app, built web first with a native iPhone app later. The system drafts every expense, assembles every report and chases every missing receipt; people confirm the few things it isn't sure about. These docs are the docs-as-code form of the approved solution blueprint (v0.3): how people will use the product, how it is built, and how we ship it safely. The twelve decisions in the blueprint's decision register, and decisions made since, are recorded as architecture decision records (ADRs). Docs and ADRs are updated in the same pull request as the change they describe (Definition of Done).

## Contents

| Doc | Blueprint section | Covers |
| --- | --- | --- |
| [01 Vision and scope](01-vision-and-scope.md) | §1–§2 | Product, architecture and delivery at a glance; outcome measures; challenges C1–C6; positioning |
| [02 Capability map](02-capability-map.md) | §3 | Capabilities by area and phase (P1–P4); the scope contract |
| [03 Journeys and workflows](03-journeys-and-workflows.md) | §4 | Personas, golden-path trip, mileage, approval workflow, lifecycles, automation rules, month-end close |
| [04 App design](04-app-design.md) | §5 | Design principles DP1–DP6, information architecture, key screens, design system and accessibility |
| [05 Architecture](05-architecture.md) | §6 | Principles AP1–AP8, context, containers, receipt path, pipeline, domain model, stack, security, iPhone, travel data |
| [06 Delivery lifecycle](06-delivery-lifecycle.md) | §7 | Operating model, RACI, environments, gates G1–G6, test strategy, Ready and Done, release and operations, SLOs |
| [07 Roadmap](07-roadmap.md) | §8 | Phases P0–P4 in weeks, scope and exit criteria |
| [Requirements and backlog](../tools/records/src) | – | Objectives, functional and non-functional requirements traced to features, decisions, code and checks; gaps, open questions and the backlog. Published after each successful release as [the traceability page](https://claude.ai/artifact/8VCWvpqvNVELSKUwQawoyN) and the backlog page |
| [08 Risk register](08-risk-register.md) | §10 | Risks R1–R10 with likelihood, impact and mitigation |
| [Runbook: environment setup](runbooks/environment-setup.md) | – | Connecting Vercel, Supabase and GitHub; off-site backups; rebuilding after a restore |
| [ADR index](adr/README.md) | §9 | Decisions D-01 to D-12 as ADR-0001 to ADR-0012, D-13 (after v0.3) as ADR-0013, D-16 as ADR-0014, D-17 as ADR-0015, D-18 as ADR-0016, D-19 as ADR-0017, D-20 as ADR-0018, D-21 as ADR-0019, D-22 as ADR-0020, and how to add an ADR; D-14 and D-15 are recorded in the roadmap |

## Decision status

| ID | Decision | ADR | Status |
| --- | --- | --- | --- |
| D-01 | Target segment and tenancy | [ADR-0001](adr/0001-target-segment-and-tenancy.md) | Accepted (decided by product owner) |
| D-02 | Architecture style | [ADR-0002](adr/0002-architecture-style.md) | Accepted (recommended; no objection) |
| D-03 | Platform | [ADR-0003](adr/0003-platform.md) | Accepted (recommended; no objection); Amended by [ADR-0013](adr/0013-supabase-platform.md) |
| D-04 | iPhone technology | [ADR-0004](adr/0004-iphone-technology.md) | Accepted (decided by product owner) |
| D-05 | Identity | [ADR-0005](adr/0005-identity.md) | Superseded by [ADR-0013](adr/0013-supabase-platform.md) |
| D-06 | Receipt extraction | [ADR-0006](adr/0006-receipt-extraction.md) | Accepted (decided by product owner) |
| D-07 | Bank and card feeds | [ADR-0007](adr/0007-bank-and-card-feeds.md) | Accepted (decided by product owner) |
| D-08 | Money and data conventions | [ADR-0008](adr/0008-money-and-data-conventions.md) | Accepted (recommended; no objection) |
| D-09 | Delivery model | [ADR-0009](adr/0009-delivery-model.md) | Accepted (recommended; no objection) |
| D-10 | Residency and compliance | [ADR-0010](adr/0010-residency-and-compliance.md) | Accepted (decided by product owner) |
| D-11 | Travel data sources | [ADR-0011](adr/0011-travel-data-sources.md) | Accepted (recommended; no objection) |
| D-12 | Eval set composition | [ADR-0012](adr/0012-eval-set-composition.md) | Proposed (awaiting product owner: permission to search the owner's Gmail for past receipts) |
| D-13 | Supabase platform | [ADR-0013](adr/0013-supabase-platform.md) | Accepted (decided by product owner after a cost and capability comparison); Amended by [ADR-0014](adr/0014-supabase-free-plan.md) |
| D-14 | Start real use in week 4 (Oct 15) | [Roadmap: Phase 1 plan](07-roadmap.md#phase-1-plan) | Accepted (decided by product owner); its Supabase Pro part is replaced by D-16 |
| D-15 | Email and password sign-in, no custom email domain in Phase 1 | [Roadmap: Phase 1 plan](07-roadmap.md#phase-1-plan) | Accepted (decided by product owner) |
| D-16 | Supabase Free plan through Phase 1, with self-managed off-site backups | [ADR-0014](adr/0014-supabase-free-plan.md) | Accepted (Free plan decided by product owner; the controls are recommended, no objection) |
| D-17 | AI provider keys configured in the app, encrypted, per organization | [ADR-0015](adr/0015-ai-provider-keys-in-app.md) | Accepted (decided by product owner); Amended by [ADR-0020](adr/0020-openai-fallback-reader.md) |
| D-18 | One person can sign in with several emails; each reaches the same member | [ADR-0016](adr/0016-several-sign-ins-per-person.md) | Accepted (decided by product owner) |
| D-19 | Every receipt is read by Haiku and Sonnet side by side until the tier is chosen; events dispatch right after commit | [ADR-0017](adr/0017-read-receipts-with-two-models.md) | Accepted (decided by product owner); Amended by [ADR-0020](adr/0020-openai-fallback-reader.md) |
| D-20 | A release applies migrations, then promotes that commit's build; Vercel no longer publishes on its own | [ADR-0018](adr/0018-release-migrates-then-promotes.md) | Accepted (decided by product owner) |
| D-21 | Asking for the merge is the production approval; the release runs straight after it | [ADR-0019](adr/0019-merge-is-the-release.md) | Accepted (decided by product owner) |
| D-22 | When neither Claude model can read a receipt, GPT-5.6 Luna reads it on the organization's OpenAI key; its reading can't make a receipt Ready | [ADR-0020](adr/0020-openai-fallback-reader.md) | Accepted (fallback decided by product owner; model and Ready rule recommended, no objection) |
| D-23 | A receipt that needs a look is confirmed as read or corrected by a person, which makes it Ready; corrections keep what the model read | [ADR-0021](adr/0021-confirming-a-reading.md) | Accepted (actions requested by product owner; storage and rules recommended, no objection) |
| D-24 | Every receipt has an expense from capture, linked as its proof; the expense follows the receipt until a person edits it, and is Ready only when its receipt is | [ADR-0022](adr/0022-expense-follows-its-receipt.md) | Accepted (proof and editing decided by product owner; filing rules recommended, no objection) |
| D-25 | Expenses file to the trip their date falls in until a person chooses its trip; on a shared day the trip that ends first keeps it; submitted expenses never move | [ADR-0023](adr/0023-expenses-file-to-trips-by-date.md) | Accepted (filing by date required by FR-EXP-04; choice, shared-day and submitted rules recommended, no objection) |
| D-26 | Email-in arrives through Bird's inbound service; we verify the webhook and check the sender's DKIM alignment ourselves | [ADR-0024](adr/0024-inbound-email-through-bird.md) | Accepted (vendor decided by product owner; sender and webhook checks recommended, no objection) |
| D-27 | No staging environment in Phase 1; a changed screen is checked on an iPhone in production right after its release | [ADR-0025](adr/0025-no-staging-in-phase-1.md) | Accepted (decided by product owner) |
| D-28 | Email-in reads a Bird agent mailbox: the webhook verifies and hands off, and a workflow fetches the raw message, checks its DKIM alignment and files its attachments | [ADR-0026](adr/0026-email-in-through-a-bird-mailbox.md) | Accepted (mailbox and allowlist set up by product owner; how it is read and checked recommended, no objection) |
| D-29 | An emailed receipt with nothing attached is filed as its text laid out as a PDF; readings gain fees and purchase summaries, which are never Ready on their own | [ADR-0027](adr/0027-email-text-as-a-pdf-receipt.md) | Accepted (product owner asked for HTML email bodies first; how recommended, no objection) |

## Visual version

The repository docs are canonical from v0.3 onward; the artifact is a v0.3 snapshot. The visual version of the blueprint is the private artifact <https://claude.ai/artifact/Lmtj84jjRfQiAjE99cSMtZ> (owner access).
