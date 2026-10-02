# ADR-0018: A release migrates first, then makes the build live

Production releases run as one approved GitHub Actions job: apply migrations, then promote that commit's Vercel build. Vercel no longer assigns the production domain on its own.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-10-02
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-20
- **Related:** [ADR-0009](0009-delivery-model.md) (delivery model), [ADR-0013](0013-supabase-platform.md) (Supabase), [ADR-0014](0014-supabase-free-plan.md) (Free plan)

## Context

Vercel built and published every push to `main` within about a minute. Migrations ran in a separate **Database migrations** workflow that waited for the product owner's approval. The two weren't connected.

On Oct 2, #15 went live 16 seconds after the merge while its migration still waited. Sign-in failed until the migration was approved, because the new code read a table that didn't exist yet. A setting meant to make Vercel wait didn't hold. The delivery lifecycle already says the product owner approves every production promotion ([06](../06-delivery-lifecycle.md)), but nothing enforced it.

## Decision

1. **Vercel builds, the release promotes.** Auto-assign Custom Production Domains is off: each push to `main` still gets a production build, but it doesn't go live.
2. **One job, one approval.** The **Release** workflow (`release.yml`, which replaces `db-migrate.yml`) runs on every push to `main` in the `production` environment. Once approved, it:
   - applies migrations;
   - sets the runtime roles' passwords where they don't already work;
   - waits for this commit's production build, promotes it with `VERCEL_TOKEN`, and checks the production domain serves it;
   - resyncs Inngest so the new build's workflows register.
3. **Never backwards.** Releases run one at a time. A run whose commit is no longer the head of `main` migrates but doesn't promote, and a run queued behind another is replaced by a newer push. Approving runs in order always leaves the newest commit live.
4. **Commits without a build** (Vercel skips those that don't touch the app) finish with production unchanged.
5. **Migrations stay backward compatible.** For about a minute the live build meets the new schema, so every migration must keep the previous release working (expand, migrate, contract).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Vercel deployment checks waiting on the migration check | Tried, and it didn't hold. It also can't wait for a check that only runs when migrations change. |
| Run migrations automatically on merge, with no approval | It shortens the gap to about a minute but doesn't close it: the Vercel build and the migration still race. It also drops the product owner's release approval. |
| Keep auto-publish and write code that tolerates a missing migration | Every change would need a fallback path, and getting one wrong breaks production silently. Ordering the release is simpler and checkable. |
| Deploy from GitHub Actions with the Vercel CLI | It rebuilds outside Vercel's Git integration and loses preview comments and build caching, for no gain over promoting the build Vercel already made. |

## Consequences

### Positive

- Code never goes live before its migration.
- The product owner's approval is the release, as the lifecycle intended.
- The release checks what users get: it fails loudly if production doesn't switch.
- Inngest is resynced against the build that is actually live.

### Negative

- **Every merge needs an approval to go live**, including docs-only merges, which approve and finish without a promotion. That is one click per merge.
- **One more credential.** `VERCEL_TOKEN` can manage the team's projects. It sits in the `production` environment behind the approval gate and is restricted to `main`. Rotate it on the same schedule as the database secrets.
- **Rollback is by hand**, with Vercel's Instant Rollback, which does not undo migrations. That is acceptable because migrations stay backward compatible (point 5).

## Exit path / reversibility

Turn Auto-assign Custom Production Domains back on and delete the promote step. That restores the old behavior, gap included.

## Links

- `.github/workflows/release.yml`, `.github/scripts/promote-production.mjs`
- [Runbook section 2](../runbooks/environment-setup.md#2-github-the-production-environment), [section 3](../runbooks/environment-setup.md#3-vercel-project)
