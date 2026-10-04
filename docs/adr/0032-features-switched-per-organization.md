# ADR-0032: Every new feature ships switched off, and each organization's owner switches it on

Each feature built from Oct 4 on ships behind a flag that is off by default. The owner of an organization switches it on for everyone in that organization, in Settings › Features, once they have checked it on their phone in production. The switch is a row in the database, so it takes effect at once, without a release. The server's override setting still beats it, as the kill switch.

- **Status:** Accepted (flagging every feature and switching each on after an iPhone check decided by product owner, Oct 4, Q5; the switch per organization, owner only, recommended, no objection yet)
- **Date:** 2026-10-04
- **Deciders:** Product owner (Q5, and how the batch of Oct 4 is released); Claude (principal architect), for the design
- **Decision register:** D-34. Ends the exception of [ADR-0017](0017-read-receipts-with-two-models.md) §7 for features built from now on; builds on AP8 and the flag registry of PR #11.

## Context

AP8 says every capability ships dark behind a flag. ADR-0017 let the receipt screens ship without one while the product owner was the only user, and every screen since did the same. Q5 asked whether to keep that exception until a second member joins. On Oct 4 the product owner asked for sixteen backlog items in one pull request, and chose to have each feature flagged and switched on after checking it on an iPhone (ADR-0025 has no staging, so production is where they check).

Flags existed in two places, neither of which suits a person switching their own features:

- **The override setting (`FLAG_OVERRIDES`).** An environment variable read when the server starts. Changing it needs a Vercel edit and a new build, and it applies to every organization.
- **PostHog.** Its key was never set, and it would be a second service with an account to keep, to switch a few booleans.

## Decision

1. **Every feature built from now on has a flag, off by default.** The registry in `packages/flags` names it, says what it changes, and a feature in the records claims it, as before. Screens already released stay unflagged.
2. **An organization's switches are rows in `org_features`.** One row per switched flag, with who switched it last. No row means off. The table has `org_id`, composite keys and forced row-level security like every tenant table.
3. **Only the owner switches.** `PUT /v1/settings/features/{key}` refuses anyone else. Everyone can read `GET /v1/features`, because screens need it to hide what is off. Each switch appends `feature.switched_on` or `feature.switched_off` to the audit log in the same transaction; a switch to what it already is records nothing.
4. **The order is: override, then the organization's switch, then off.** The override stays the server's kill switch. A switch the override would ignore is refused with 409, so the page never says a feature is on when it isn't.
5. **A feature that is off looks absent.** Its routes answer 404 `feature_off` through one `FeatureGate`, and its screens, links and actions are hidden. Data written while it was on stays; switching it off hides it, it deletes nothing.
6. **The server's own flags are not offered.** A flag marked server-only in the registry, such as the build version or an operator's switch for a model, changes the app for every organization and is set only by the override.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Turn features on with `FLAG_OVERRIDES` | Each switch needs a Vercel edit and a build, which is a release. It is one setting for every organization. |
| PostHog flags, targeted by organization | A second service, account and key for a few booleans, and a slow or failed call reads as off. It stays possible as a source behind the override. |
| Switches per person | Features change shared data, such as categories and report currency. Half an organization on and half off would split its records. |
| Keep shipping unflagged until a second member joins (Q5's recommendation) | The product owner chose to check each feature on the iPhone before relying on it, which needs the switch now. |

## Consequences

### Positive

- **Checking a feature costs no release.** The owner switches it on, checks it on the phone, and switches it off at once if it misbehaves.
- **Each switch is audited.** Who turned what on, and when, is in the audit trail with everything else.
- **Teams later get it for free.** A second organization's owner switches its own features.

### Negative

- **Every gated request reads one row.** It is an indexed read inside the request's own transaction; there is no cache to go stale.
- **Code carries both branches until a flag is removed.** The registry says to remove a flag, and its off branch, once it is on everywhere.
- **A feature that is off still has its tables.** Migrations run whatever the switch says, so a schema change can't wait on it.

## Exit path / reversibility

- **The gate is one function.** Pointing it at PostHog, or dropping the table, changes no route.
- **Removing a flag** removes its registry entry, its claim and its off branch; rows for it in `org_features` are then ignored and can be deleted.

## Links

- [ADR-0017: Two models until the tier is chosen](0017-read-receipts-with-two-models.md), [ADR-0025: No staging in Phase 1](0025-no-staging-in-phase-1.md)
- NFR-DEL-05, F-31, US-REL-05, Q5, backlog #22
