# ADR-0048: The release waits for CI to pass on the merged commit

A merge to `main` starts CI on the merged commit, and the **Release** workflow runs only once that CI has passed. A commit whose gates fail on `main` is never released, and production stays on the last commit that passed.

- **Status:** Accepted (decided by product owner, Oct 9)
- **Date:** 2026-10-09
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-50
- **Amends:** [ADR-0019](0019-merge-is-the-release.md) (point 1, "it runs at once")

## Context

ADR-0019 started the release on the push to `main`, alongside CI on the same commit. Neither waited for the other: `promote-production` made the build live, and CI reported 15 to 20 minutes later. A red CI on `main` could only say that something already live was broken.

Every pull request passes G1–G5 before it is merged. What `main` then holds is not always what was checked:

- **Main can move between a pull request's last run and its merge.** Two pull requests can each be green against an older `main`, and their combination is checked by nobody before it ships.
- **A squash merge makes a new commit,** checked only by the run on `main`.

That run cost 818 of CI's 2,444 minutes over Sep 30 to Oct 9: free while the repository is public, but buying a signal that came too late to stop anything.

## Decision

1. **The Release workflow starts when CI completes on `main`** (`workflow_run`), and runs only when:
   - CI passed;
   - it was CI's run for a push, never a pull request's, even from a branch named `main`;
   - it ran in this repository.
2. **The release is of the commit CI passed on.** It checks out that commit and promotes its build. The order of ADR-0018 is unchanged: migrate, set role passwords where needed, promote, check production serves it.
3. **A newer merge supersedes an older one.**
   - CI on `main` still cancels a run that a newer push replaces, so only the newer commit releases, and it carries both changes.
   - A run whose commit is no longer the head of `main` migrates but doesn't promote, as before.
4. **The manual run stays ungated.** It is kept for a recovery that needs the migrations and role passwords applied again (runbook), which no CI run precedes.
5. **The product owner's word to merge is still the approval** (ADR-0019 points 2 to 4). The gate adds a check, not a click.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep ADR-0019 as written | A commit that fails its gates on `main` ships anyway, and CI's run there buys nothing it can act on. |
| Drop CI's run on `main` | Saves its minutes, but nothing would check what `main` holds after a merge. |
| Keep the push trigger and poll for CI's checks in the release job | Holds a runner idle for the length of CI on every release, with the same result. |
| Require branches to be up to date before merging | Closes the moved-main gap but not the squash commit's. It makes every pull request wait on every other, and needs settings this session can't read. |

## Consequences

### Positive

- **Nothing reaches production without passing G1–G5 as it stands on `main`.**
- CI's run on `main` now decides something.

### Negative

- **A release lands 15 to 20 minutes after the merge rather than 2.** It waits for G5's end-to-end checks, about 16 minutes of desktop Chromium and iPhone WebKit. Running the two in parallel jobs would roughly halve it.
- **A failing gate on `main` holds every later release** until a fix is merged and passes. That is the point, but it means `main` must be fixed forward promptly.

## Exit path / reversibility

Put `push: branches: [main]` back as the Release trigger and drop the job's condition. That restores ADR-0019 with no other change.

## Links

- [ADR-0018](0018-release-migrates-then-promotes.md), [ADR-0019](0019-merge-is-the-release.md)
- F-36, US-REL-02, NFR-DEL-03
