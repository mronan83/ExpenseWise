# Runbook: connect Vercel, Supabase and GitHub

How the production environment is wired, and the steps to rebuild it after a restore or in a new project. See [ADR-0013](../adr/0013-supabase-platform.md) for the decisions behind it.

## How the pieces connect

| Connection | Carries | Where it is set |
| --- | --- | --- |
| Browser and iOS app → Supabase Auth | Sign-in, using the publishable key | Vercel env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| API (Vercel) → Supabase JWKS | Verifying access tokens; no secret needed | Derived from `NEXT_PUBLIC_SUPABASE_URL` |
| API (Vercel) → Postgres | Tenant data as `expensewise_app`, transaction pooler, verified TLS | Vercel env: `DATABASE_URL` |
| API (Vercel) → Supabase Storage | Signed upload and download URLs (Phase 1) | Vercel env: `SUPABASE_SECRET_KEY` |
| GitHub Actions → Postgres | Migrations as the schema owner, then role passwords | GitHub environment `production` secrets |

The `postgres` role has BYPASSRLS. Its connection string lives only in GitHub secrets, never in Vercel.

## 1. Supabase project settings

1. **Integrations → Data API:** it may stay enabled. ExpenseWise never calls it, and migration 0002 leaves its roles no privileges on our tables. Don't create tables by hand in the dashboard's `public` schema; they may be exposed to it.
2. **Settings → JWT Keys:** confirm the current key is asymmetric (ES256 or RS256). New projects default to this.
3. **Settings → API Keys:** note the publishable key (`sb_publishable_…`) and the secret key (`sb_secret_…`).
4. **Connect → Session pooler:** copy the connection string for the `postgres` role (port 5432). Remove any `sslmode` parameter; our code verifies TLS against Supabase's root CA.

## 2. GitHub: the production environment

1. **Settings → Environments → New environment:** `production`. Under **Deployment protection rules**, add yourself as a required reviewer, and limit deployment branches to `main`.
2. Add these environment secrets:
   - `DATABASE_MIGRATION_URL`: the session pooler string from step 1.4.
   - `EXPENSEWISE_APP_DB_PASSWORD` and `EXPENSEWISE_RELAY_DB_PASSWORD`: two new random passwords, at least 24 characters each, from a password manager. Store them there too.
3. **Actions → Database migrations → Run workflow**, then approve the run. It applies migrations and sets both role passwords as SCRAM verifiers. It fails if either role could bypass row-level security.

## 3. Vercel project

1. **Settings → Build and Deployment:** set Root Directory to `apps/web` (keep "Include files outside the root directory" on), Framework Preset to Next.js, and Node.js Version to 22.x. Vercel picks up the pinned pnpm version from `package.json` by itself.
2. **Settings → Environment Variables**, for Production and Preview:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`
   - `SUPABASE_SECRET_KEY` = `sb_secret_…` (mark it Sensitive)
   - `DATABASE_URL` = `postgresql://expensewise_app.<project-ref>:<app password>@<pooler host>:6543/postgres` (mark it Sensitive). This is the transaction pooler: the same host as step 1.4, but with the `expensewise_app.<project-ref>` user and port 6543.
3. Redeploy. `GET /api/v1/health` returns 200. `GET /api/v1/me` returns 401 without a token, not 503, which shows the API found the Supabase project.

Previews share the production Supabase project until a staging project exists (ADR-0013); no real data is stored before the Phase 1 dogfood month.

## 4. Supabase Auth URLs (needed for sign-in in Phase 1)

**Authentication → URL Configuration:** set Site URL to the production domain, and add redirect URLs for `https://expensewise-*-mronan83s-projects.vercel.app/**` so preview sign-ins work.

## After a restore or in a new project

Custom role passwords are not in backups or dumps. Re-run **Database migrations** (step 2.3): it re-applies any missing migrations and re-sets both passwords from the GitHub secrets.
