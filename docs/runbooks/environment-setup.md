# Runbook: connect Vercel, Supabase and GitHub

How the production environment is wired, and the steps to rebuild it after a restore or in a new project. See [ADR-0013](../adr/0013-supabase-platform.md) and [ADR-0014](../adr/0014-supabase-free-plan.md) for the decisions behind it.

## How the pieces connect

| Connection | Carries | Where it is set |
| --- | --- | --- |
| Browser and iOS app → Supabase Auth | Sign-in, using the publishable key | Vercel env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| API (Vercel) → Supabase JWKS | Verifying access tokens; no secret needed | Derived from `NEXT_PUBLIC_SUPABASE_URL` |
| API (Vercel) → Postgres | Tenant data as `expensewise_app`, transaction pooler, verified TLS | Vercel env: `DATABASE_URL` |
| API (Vercel) → Supabase Storage | Signed upload and download URLs (Phase 1) | Vercel env: `SUPABASE_SECRET_KEY` |
| GitHub Actions → Postgres | Migrations as the schema owner, then role passwords | GitHub environment `production` secrets |
| GitHub Actions → Postgres, Storage and Backblaze B2 | The nightly encrypted backup and heartbeat (from increment 1) | GitHub environment `backup` secrets |

The `postgres` role has BYPASSRLS. Its connection string lives only in GitHub secrets, never in Vercel.

## 1. Supabase project settings

1. **Integrations → Data API:** it may stay enabled. ExpenseWise never calls it, and migration 0002 leaves its roles no privileges on our tables. Don't create tables by hand in the dashboard's `public` schema; they may be exposed to it.
2. **Settings → JWT Keys:** confirm the current key is asymmetric (ES256 or RS256). New projects default to this.
3. **Settings → API Keys:** note the publishable key (`sb_publishable_…`) and the secret key (`sb_secret_…`).
4. **Connect** (top of the project page) **→ Connection string → Method: Session pooler:** copy the string for the `postgres` role. It looks like `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-N-<region>.pooler.supabase.com:5432/postgres`; copy the host exactly. The `<region>` must match `regions` in `apps/web/vercel.json` (production is us-west-2 and `pdx1`); if it doesn't, update one or the other first.
   - Replace `[YOUR-PASSWORD]`, brackets included, with the database password chosen when the project was created. If it is lost, reset it under **Database → Settings → Reset database password**; nothing else uses it yet.
   - A password with `@ : / ? # %` must be percent-encoded in the URL. Resetting to a long letters-and-digits password avoids that.
   - Use the session pooler, not the direct connection: the direct host is IPv6-only and GitHub's runners are IPv4-only. Use port 5432, not 6543: migrations need a whole session.
   - Leave out `sslmode`; our code verifies TLS against Supabase's root CA.

## 2. GitHub: the production environment

Do this before merging the first pull request that adds migrations. The merge starts the **Database migrations** workflow straight away, and if the `production` environment doesn't exist yet, GitHub creates it with no protection.

1. **Generate the two role passwords** and save both in your password manager:
   ```sh
   openssl rand -hex 32   # expensewise_app
   openssl rand -hex 32   # expensewise_relay
   ```
   Hex output is URL-safe, which matters because the app password goes into `DATABASE_URL` later. Any other generator is fine at 24+ letters and digits.
2. **Settings → Environments**. If an environment called `Production` already exists, open it rather than creating another: Vercel creates it when it first deploys, and GitHub matches environment names regardless of case, so the workflow's `production` is that environment, unprotected until you configure it. Otherwise choose **New environment** and name it `production`. Then:
   - **Required reviewers:** tick it, add yourself, and leave **Prevent self-review** unticked. You both merge (which starts the run) and approve it; with self-review prevented, a solo owner could never approve. Then **Save protection rules**.
   - **Deployment branches and tags:** change "No restriction" to **Selected branches and tags**, then add a branch rule `main`. A workflow on any other branch can then never reach these secrets.
3. **Environment secrets → Add environment secret**, three times. Use environment secrets, not repository secrets, so that the approval gate guards them:
   - `DATABASE_MIGRATION_URL`: the full string from step 1.4, password filled in.
   - `EXPENSEWISE_APP_DB_PASSWORD`: the first password from step 2.1.
   - `EXPENSEWISE_RELAY_DB_PASSWORD`: the second.
4. **Merge the pull request.** In **Actions**, the **Database migrations** run waits with "Review deployments". Open it, tick `production`, and **Approve and deploy**. The log ends with `Migrations applied.` and `Runtime role passwords set; neither role can bypass row-level security.` It stops with an error if either role could bypass row-level security.
5. **Later runs:** **Actions → Database migrations → Run workflow** re-runs it by hand, after a restore for example. That button only exists once the workflow is on `main`.

## 3. Vercel project

1. **Settings → Build and Deployment:** set Root Directory to `apps/web` (keep "Include files outside the root directory" on), Framework Preset to Next.js, and Node.js Version to 22.x. Vercel picks up the pinned pnpm version from `package.json` by itself.
2. **Settings → Environment Variables**, for Production and Preview:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`
   - `SUPABASE_SECRET_KEY` = `sb_secret_…` (mark it Sensitive)
   - `DATABASE_URL` = `postgresql://expensewise_app.<project-ref>:<app password>@<pooler host>:6543/postgres` (mark it Sensitive). This is the transaction pooler: the same host as step 1.4, but with the `expensewise_app.<project-ref>` user and port 6543. Add it only after step 2.4 has set the password.
   - No `SUPABASE_URL` or `POSTGRES_URL`. The API reads the project URL only from `NEXT_PUBLIC_SUPABASE_URL`, and the `postgres` role must never reach the runtime.
3. Redeploy. Changed variables only reach new deployments. Then check:
   - `GET /api/v1/health` returns 200.
   - `GET /api/v1/me` returns 401 without a token, not 503, which shows the API found the Supabase project.
   - `GET /api/v1/health/ready` returns 200 with every check `pass`: the database answers, the app is connected as `expensewise_app`, TLS is verified against Supabase's root certificate, and row-level security is enforced on every tenant table. Any failure answers 503 and names the check:

     | Check says | Fix |
     | --- | --- |
     | `DATABASE_URL is not set` | Add it (step 3.2) and redeploy |
     | `password rejected` | `DATABASE_URL` must use password 1 from step 2.1; if you just ran migrations, see the pooler note under "If the migration run fails" |
     | `connected as postgres, which bypasses row-level security` | `DATABASE_URL` is the migration connection; use the `expensewise_app.<project-ref>` user on port 6543 |
     | `found 0 tenant tables … run migrations` | Run **Database migrations** (step 2.5) |
     | `the connection is not TLS-verified` | `DATABASE_URL` must point at a `*.supabase.com` host |

Previews share the production Supabase project until a staging project exists (ADR-0013); no real data is stored before the Phase 1 dogfood month.

## 4. Supabase Auth (needed for sign-in in Phase 1)

Phase 1 signs in with email and password plus TOTP, and has no custom email domain ([D-15](../07-roadmap.md#phase-1-plan)).

1. **Authentication → Sign In / Providers:** keep Email enabled and turn off **Allow new users to sign up**. Nobody needs to self-register in Phase 1.
2. **Authentication → Users → Add user:** create the product owner's account with email and password, and tick **Auto Confirm User** so no confirmation email is needed. TOTP is enrolled in the app after the first sign-in.
3. **Authentication → URL Configuration:** set Site URL to `https://expensewise-theta.vercel.app`, and add `https://expensewise-*-mronan83s-projects.vercel.app/**` as a redirect URL so preview sign-ins work.

Supabase's built-in email covers password resets and the owner's own notifications. It is rate-limited and delivers only to members of the Supabase team. Before a second person is invited, add a sender domain or create their account the same way as step 2.

## 5. Off-site backups (Backblaze B2)

The Free plan keeps no backups, so a nightly workflow keeps our own ([ADR-0014](../adr/0014-supabase-free-plan.md)). Set this up before real use starts on Oct 15. The workflow itself arrives in increment 1 and uses the names below.

1. **Create a Backblaze B2 account** at <https://www.backblaze.com/sign-up/cloud-storage> and choose the **US West** region. The region can't be changed later. The first 10 GB are free and no card is needed, but B2 verifies a phone number by text message.
2. **Buckets → Create a Bucket:**
   - **Bucket Unique Name:** `expensewise-backups-` plus a few random letters. Names are global across Backblaze.
   - **Files in Bucket are:** Private.
   - **Default Encryption:** Enable.
   - **Object Lock:** Enable. Then, on the bucket's card, open the Object Lock setting and set a default retention of 30 days. The web console offers only compliance mode: for 30 days nobody, you included, can delete a backup. That is the point, and it can't be turned off later.
3. **Lifecycle Settings** on the bucket's card: choose **Use custom lifecycle rules** and add two:
   - file name prefix `db/daily/`: days from uploading to hiding 30, days from hiding to deleting 1;
   - file name prefix `db/monthly/`: days from uploading to hiding 365, days from hiding to deleting 1.

   Leave everything else, including `receipts/`, with no rule; receipt images are kept.
4. **Application Keys → Add a New Application Key:**
   - **Name:** `expensewise-backup`.
   - **Allow access to Bucket(s):** only the bucket from step 2.
   - **Type of Access:** Read and Write.
   - Leave the file name prefix and duration empty.

   Copy the `keyID` and `applicationKey` straight away; the key is shown only once.
5. **Generate the backup passphrase** with `openssl rand -hex 32` and save it in your password manager. Without it the backups can't be decrypted, and nobody can recover it.
6. **Supabase → Storage → Configuration → S3:** turn on **S3 protocol connection** if it is off, then under **Access keys** create a key described as `expensewise-backup`, and copy the access key ID and secret. The nightly job reads receipt images through it. These keys can read and write every bucket and bypass row-level security, so they go only in the `backup` environment.
7. **GitHub → Settings → Environments → New environment** named `backup`:
   - **Required reviewers:** leave unticked. A nightly job can't wait for an approval.
   - **Deployment branches and tags:** **Selected branches and tags**, branch rule `main`.
   - **Environment secrets:**

     | Secret | Value |
     | --- | --- |
     | `BACKUP_DATABASE_URL` | The same session-pooler string as `DATABASE_MIGRATION_URL` (step 1.4) |
     | `SUPABASE_S3_ACCESS_KEY_ID` | From step 6 |
     | `SUPABASE_S3_SECRET_ACCESS_KEY` | From step 6 |
     | `B2_KEY_ID` | `keyID` from step 4 |
     | `B2_APPLICATION_KEY` | `applicationKey` from step 4 |
     | `B2_BUCKET` | The bucket name from step 2 |
     | `BACKUP_PASSPHRASE` | From step 5 |

## 7. The extraction spike (GitHub Actions)

The **Extraction spike** workflow calls the Anthropic API, which costs money. It runs only by hand, in a GitHub environment that needs your approval for every run. It refuses to send anything when its estimate is above the cap you give it.

1. **Create an API key** in the Anthropic Console (Developer Platform), under **API keys**.
2. **GitHub → Settings → Environments → New environment** named `evals`:
   - **Required reviewers:** tick it and add yourself; leave **Prevent self-review** unticked.
   - **Deployment branches and tags:** **Selected branches and tags**, branch rule `main`.
   - **Environment secret** `ANTHROPIC_API_KEY`: the key from step 1.
3. **Actions → Extraction spike → Run workflow.** Choose the models, by default `sonnet,haiku`, and a dollar cap, by default 4. Then open the run and choose **Review deployments → Approve and deploy**.
4. **The report** appears on the run's summary page. It holds totals by model and source, and the cascade (cheapest model first, the next when unsure); it never includes receipt contents, because this repository's logs are public.

## After a restore or in a new project

Custom role passwords are not in backups or dumps. Re-run **Database migrations** (step 2.5): it re-applies any missing migrations and re-sets both passwords from the GitHub secrets.

## If the migration run fails

Read the failed step's log. It shows where the job connected (user, host, port, database), never the password.

| Log says | Cause | Fix |
| --- | --- | --- |
| `DATABASE_MIGRATION_URL:` with nothing after it | The secret is missing, misnamed, or saved under **Environment variables** instead of **Environment secrets** | Add it as an environment secret on `production`, with the exact name |
| `password authentication failed` (28P01) right after a password reset | Supabase's pooler caches credentials apart from the database and can keep rejecting the new password ([Supabase guide](https://supabase.com/docs/guides/troubleshooting/supavisor-error-password-authentication-failed-after-password-rotation)). The job already retries for about 90 seconds. | **Database → Settings → Connection pooling:** change the pool size by one and save, change it back and save, then run again |
| `password authentication failed` with no recent reset | The password in the secret isn't the database's. Supabase can't show it, only reset it. | Reset it (section 1.4), update the secret, wait a few minutes, run again |
| `still contains Supabase's [YOUR-PASSWORD] placeholder` | The template was pasted without filling in the password | Replace `[YOUR-PASSWORD]`, brackets included, with the password |

Brackets or spaces left around a pasted password are removed automatically, and the log says so.
