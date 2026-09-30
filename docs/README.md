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
| [08 Risk register](08-risk-register.md) | §10 | Risks R1–R8 with likelihood, impact and mitigation |
| [ADR index](adr/README.md) | §9 | Decisions D-01 to D-12 as ADR-0001 to ADR-0012, D-13 (after v0.3) as ADR-0013, and how to add an ADR |

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
| D-13 | Supabase platform | [ADR-0013](adr/0013-supabase-platform.md) | Accepted (product owner rejected Clerk; consolidation recommended, no objection) |

## Visual version

The repository docs are canonical from v0.3 onward; the artifact is a v0.3 snapshot. The visual version of the blueprint is the private artifact <https://claude.ai/artifact/Lmtj84jjRfQiAjE99cSMtZ> (owner access).
