# ADR-0014: Supabase Free plan with self-managed backups

Keep production on Supabase's Free plan through Phase 1. In place of what Pro would have provided, add a nightly encrypted off-site backup, a heartbeat, quota alerts and a monthly restore drill.

- **Status:** Accepted (Free plan decided by product owner; the controls are recommended, no objection)
- **Date:** 2026-10-01
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-16 (amends the Supabase Pro part of D-14)
- **Amends:** [ADR-0013](0013-supabase-platform.md) (environments and cost)

## Context

[ADR-0013](0013-supabase-platform.md) planned to upgrade production to Pro ($25/month) before the Phase 1 dogfood month, and [D-14](../07-roadmap.md#phase-1-plan) moved that month's start to Oct 15. The product owner has declined Pro, and any spend, for now. Real financial records will therefore live on the Free plan from Oct 15. Receipts are tax evidence to be kept for 3 to 7 years ([ADR-0010](0010-residency-and-compliance.md)).

Each Free plan limit, what it risks for one person's real use, and the answer:

| Free plan limit | Risk | Answer |
| --- | --- | --- |
| Paused after 7 days without enough database activity; Supabase says a few requests a day are enough but not whether reads count | Sign-in and capture stop until the project is resumed from the dashboard | Daily real use from Oct 15, plus a nightly heartbeat write |
| No backups; Supabase advises Free users to keep their own dumps off-site | A bad migration, a bug or a deleted project loses every record | A nightly encrypted dump and receipt-image copy at a second provider |
| 500 MB database; the database turns read-only above it | Writes fail | One person's expenses, trips and audit events grow by megabytes a year, not hundreds. Alert at 70%. |
| 1 GB file storage | Uploads fail | Phone photos are 3–5 MB, which would fill 1 GB in months. Resize on capture to about 400 KB, which gives roughly two years at 100 receipts a month. Alert at 70%. |
| 5 GB egress a month | Downloads blocked | Negligible for one user |
| Shared compute, no support SLA | Slow queries; slow help in an outage | Enough for one user; recovery doesn't depend on support, because we hold our own backups |

Pro would not remove the need for our own backups. Its daily backups keep 7 days and exclude stored files, so ADR-0013 already required a nightly off-site copy of receipt images.

## Decision

We will run production on the Free plan through Phase 1. The controls below are built in increment 1, before real use starts on Oct 15.

1. **Nightly off-site backup.** A scheduled GitHub Actions workflow dumps the whole database, auth users included, following Supabase's documented roles, schema and data procedure. It also copies new receipt images. Everything is encrypted on the runner before upload to a private Backblaze B2 bucket in a US region ([ADR-0010](0010-residency-and-compliance.md)). The encryption key exists only in GitHub secrets and the owner's password manager. Losing it makes the backups unreadable.
2. **Retention.** Database dumps are kept for 30 days, plus one a month for 12 months. Receipt images are immutable, so the copy only ever adds files and never deletes them. They are kept for as long as the expense they support. The bucket's Object Lock, in compliance mode for 30 days, means nobody can delete a backup in its first 30 days: not a leaked key, a faulty job or the owner.
3. **Its own environment, quiet logs.** A nightly job can't wait for a human approval, so the backup runs in a GitHub environment named `backup` that only `main` can use, not in the approval-gated `production` environment. The repository is public, and so are its workflow logs and artifacts. The backup and drill jobs therefore log only pass or fail, sizes and timings, never data, and upload no workflow artifacts.
4. **Heartbeat.** The same job writes one row to an `ops.heartbeat` table, so the project never looks idle for 7 days, even when the owner is away.
5. **Quota alerts.** The job measures database size and storage used, and fails at 70% of either Free limit. A failed run emails the owner.
6. **Storage budget.** Capture resizes photos to about 2,000 px on the long edge before upload, which keeps receipts legible at about 300–500 KB, and files are capped at 10 MB.
7. **Restore drill.** A monthly workflow restores the latest backup into Supabase's Postgres 17 image on a throwaway runner. It checks that migrations are at head, that row counts match those recorded at dump time, that row-level security is on for every tenant table, and that a sample of receipt images matches stored checksums. The first drill runs on synthetic data before Oct 15. A drill on real data with images stays a Phase 1 exit criterion.
8. **Staging.** Staging is the second free project the plan allows, at no cost. It may pause when idle.

**Recovery objectives.** We can lose up to 24 hours of changes (recovery point), the same as Pro's daily backups. Recovery takes up to 4 hours (recovery time): restore into a new or unpaused project, run **Database migrations** to re-set role passwords, copy images back, and repoint Vercel. A restore into a new project changes its URL and keys, so everyone signs in again.

**Upgrade to Pro when any of these happens.** Each upgrade is still the product owner's call, but these triggers are agreed now:

- someone other than the owner stores real data, such as a second member or the Phase 2 pilot team;
- any Free limit passes 70%;
- production pauses despite the heartbeat, or two nightly backups or a drill fail in a row;
- the product is sold.

Point-in-time recovery stays deferred, as in ADR-0013.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Supabase Pro from Oct 15 ($25/month) | Declined by the product owner: no spend yet. Its backups keep 7 days and exclude receipt images, so the off-site copy is needed either way. |
| Free plan without our own backups | One bad migration or deleted project would lose tax evidence with no way back. |
| Cloudflare R2 as the backup target | Its 10 GB free tier also fits, but it needs a payment card on file. B2's free 10 GB doesn't. |
| GitHub as the backup target (a private repository or workflow artifacts) | Receipt images never go in git. Artifacts expire after at most 90 days, and in this public repository anyone can download them. |
| Move the database to another provider's free plan | Reverses ADR-0013 two weeks before real use, to trade one set of free-plan limits for another. |
| Delay real use until Pro is approved | Defeats D-14: the dogfood month would fall in the quiet holiday weeks. |

## Consequences

### Positive

- Supabase costs nothing in Phase 1.
- The backups are stronger than Pro's. They keep 30 days plus 12 monthly copies against Pro's 7 days, include receipt images, and sit with a second vendor, which reduces R9. A monthly drill proves them instead of assuming they work.
- The image copy also survives a deletion in Supabase Storage, which keeps no versions.
- The drill rehearses the exit path from Supabase in ADR-0013.

### Negative

- **We own the backups.** If the job breaks silently, there are no backups. Contained by failed runs emailing the owner, by row counts recorded at dump time that the drill checks, and by the monthly drill.
- **Recovery is slower.** It takes hours, not minutes, and a restore into a new project signs everyone out.
- **Pausing remains possible.** If Supabase's measure of activity ignores the heartbeat, the project still pauses. Resuming it is a dashboard click, possible for up to a year, and a pause is an upgrade trigger.
- **The backup secrets have no approval gate.** Any workflow merged to `main` can read the `backup` environment. It holds an owner-level database connection and Supabase S3 keys that can read and write every bucket and bypass row-level security. Contained by restricting the environment to `main`, where every change passes the gates and is merged by the owner.
- **Scheduled runs are not guaranteed.** GitHub can delay scheduled workflows under load, and because this repository is public it disables them after 60 days without activity. The quota check and the drill notice a missed night; a disabled schedule shows on the Actions page.
- **Photos are resized.** Detail beyond about 2,000 px is gone. Receipts stay legible, and PDFs are stored unchanged.

## Exit path / reversibility

Upgrading to Pro is a billing change in the dashboard, with no migration. The off-site backup stays after an upgrade, because Pro's backups exclude receipt images. Leaving Supabase uses the same dumps and image copies that the drill restores every month.

## Links

- [ADR-0013](0013-supabase-platform.md) (amended), [ADR-0010](0010-residency-and-compliance.md), [ADR-0001](0001-target-segment-and-tenancy.md)
- [Roadmap: Phase 1 plan](../07-roadmap.md#phase-1-plan), [backups and recovery](../06-delivery-lifecycle.md#backups-and-recovery), [runbook: off-site backups](../runbooks/environment-setup.md#5-off-site-backups-backblaze-b2)
- [Risk register](../08-risk-register.md): R9, R10
- [Supabase pricing](https://supabase.com/pricing), [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [Supabase backups](https://supabase.com/docs/guides/platform/backups), [Supabase S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)
- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock), [lifecycle rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules)
