# ADR-0019: Merging is the release

The product owner's request to merge is the production approval. The **Release** workflow runs straight after each merge, with no second approval click.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-10-02
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-21
- **Amends:** [ADR-0018](0018-release-migrates-then-promotes.md) (point 2, "one approval")

## Context

ADR-0018 made each release one approved job: migrate, then promote. In practice, every release needed two acts from the product owner:

- saying "merge", since Claude merges only on that word;
- approving the run in GitHub.

The second click guarded nothing the first hadn't decided. Claude Code's safety rules rightly won't let Claude press it on the owner's behalf. So the click became a manual step with no added judgment, and it held releases up when the owner wasn't at GitHub.

## Decision

1. **No required reviewers** on the `production` GitHub environment. A merge to `main` starts the **Release** run, and it runs at once.
2. **The order doesn't change.** Migrations still run first. Vercel still builds without publishing, and the run then promotes that build and checks production serves it (ADR-0018 points 1 and 3–5).
3. **Claude merges only on the product owner's explicit request** in the session, per pull request, after G1–G5 are green. That request is the release approval the delivery lifecycle asks for.
4. **The production secrets stay restricted to `main`** by the environment's deployment-branch rule.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep the approval click (ADR-0018 as written) | Two acts for one decision. Releases stalled when the owner was away from GitHub. |
| Let Claude press the approval | Claude Code's safety rules block approving production deployments for someone else, and a permission rule to allow it would weaken that protection for every project. |
| Auto-publish from Vercel again | It brings back the race between migrations and the build that broke sign-in on Oct 2 (ADR-0018). |

## Consequences

### Positive

- One word releases a change, and the safe order still holds.
- Releases no longer wait on a second visit to GitHub.

### Negative

- **No second look after the merge.** A merged change goes out within a few minutes. Contained by G1–G5 on every pull request, by Claude merging only on explicit request, and by Vercel's Instant Rollback.
- **Production secrets no longer wait on a human click.** Any workflow that reaches `main` can read them. Contained by the deployment-branch rule and by every change reaching `main` only through a reviewed pull request.

## Exit path / reversibility

Tick **Required reviewers** on the `production` environment again. That restores ADR-0018's approval click with no code change.
