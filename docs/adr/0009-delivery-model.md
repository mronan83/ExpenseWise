# ADR-0009: Delivery model

Deliver trunk-based and continuously, as Kanban flow with two-week increments, with the product owner approving acceptance and production promotion.

- **Status:** Accepted (recommended; no objection)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-09

## Context

The team is one human and one AI builder. The builder architects, builds, tests and deploys, which removes separation of duties: the author reviews their own work ([C6](../01-vision-and-scope.md#c6-one-builder-in-four-roles-removes-separation-of-duties)). Self-review blind spots are rated high likelihood, medium impact (R7). Scrum ceremonies only pay off for larger teams.

## Decision

- **Dual-track.** Discovery runs ahead and ends in Ready, which means the Definition of Ready is met. Delivery pulls work when there is capacity, with a WIP limit of 2.
- **Trunk-based continuous delivery.** Small, flagged branches and pull requests, gates G1–G4 on every push, a preview environment with G5 on every pull request, and staging with G6 on every merge.
- **Increments.** Work runs as continuous flow, with a two-week increment for demo, acceptance and re-planning.
- **Two human gates.** The product owner agrees the acceptance criteria (Ready) and approves every production promotion.
- **Independent review.** Automated gates act as the independent reviewer, and Claude runs an adversarial review pass on every pull request before it reaches the product owner.
- **Ship dark.** Every capability sits behind a feature flag, and deploy is not release (AP8).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Scrum with full ceremonies | Its ceremonies only pay off for larger teams. Continuous flow with increments keeps the demo, acceptance and re-planning without the overhead. |

## Consequences

### Positive

- Small, verified slices reach production continuously, dark until released.
- Automated gates provide review that does not depend on the author's judgment.
- The product owner's attention goes to the two points of highest leverage.

### Negative

- Heavy automation is needed up front: gates G1–G5 and preview environments are Phase 0 scope.
- The product owner is on the critical path for every promotion.
- Separation of duties rests on automation and on the product owner's gates. Blind spots that no gate checks stay possible (R7), so each exploratory finding becomes an automated test.

## Exit path / reversibility

This is a process decision and can change at any increment boundary. The gates, flags and environments stay useful under any process. If the team grows, ceremonies can be added where they start to pay off.

## Links

- [Delivery lifecycle](../06-delivery-lifecycle.md): [operating model](../06-delivery-lifecycle.md#71-operating-model), [roles](../06-delivery-lifecycle.md#71-roles-and-accountability), [quality gates](../06-delivery-lifecycle.md#73-quality-gates)
- [Roadmap](../07-roadmap.md)
- [Risk register](../08-risk-register.md): R7
