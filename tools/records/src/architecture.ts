/**
 * The written half of the technical architecture page. The other half is generated from the
 * repository each time the page is built: packages and their dependencies, API operations,
 * pages, workflows and jobs, migrations, test counts and decision records. A test fails when a
 * workspace package, GitHub workflow, background function, setting or secret exists without a
 * description here, so a new component can't arrive undescribed. Every pull request says what
 * it revised here, or why nothing needed revising.
 */

export const SUMMARY =
  'ExpenseWise is one Next.js app on Vercel with its API inside it. The browser talks only to that API, with the person’s own sign-in token; the API reaches Postgres on Supabase as a role that row-level security binds. Anything slow, such as reading a receipt with AI models, leaves the request through an outbox and runs as a retryable workflow on Inngest. Merging to main is the release: GitHub Actions migrates the database first, then makes the new build live.';

export interface Principle {
  readonly id: string;
  readonly name: string;
  /** How the code does it today. */
  readonly built: string;
  /** Where it falls short, with the records that track it. */
  readonly short?: string;
  readonly refs: readonly string[];
}

/** The design principles (docs/05-architecture.md §6.1), as built. */
export const PRINCIPLES: readonly Principle[] = [
  {
    id: 'AP1',
    name: 'API-first',
    built:
      'Every operation is in `packages/api`, described by a contract generated from the code (`openapi.json`) that CI checks. The web app calls only `/api/v1`; it never reads the database or Supabase’s Data API.',
    short: 'The iPhone app, its second client, is Phase 3.',
    refs: ['ADR-0002', 'ADR-0013'],
  },
  {
    id: 'AP2',
    name: 'Modular monolith',
    built:
      'One deployment. Packages depend one way only: domain rules at the bottom, then data access, reading, workflows and the API, then the web app. A package can’t reach upward.',
    short:
      'Modules share one schema; a module owns its tables by convention, not by database rights.',
    refs: ['ADR-0002'],
  },
  {
    id: 'AP3',
    name: 'Async by default',
    built:
      'Filing a receipt commits the receipt, its expense, an outbox event and the audit event in one transaction and answers at once. The reading runs on Inngest, retried step by step, and settles the receipt whatever happens.',
    refs: ['ADR-0003', 'ADR-0017'],
  },
  {
    id: 'AP4',
    name: 'Append-only history',
    built:
      'Every state change appends a hash-chained audit event in its own transaction. The database refuses to change or remove one. Confirmations of readings are append-only too.',
    short:
      'Locking approved expenses is an application rule; the database doesn’t enforce it until approval exists (FR-EXP-03, #24).',
    refs: ['ADR-0008'],
  },
  {
    id: 'AP5',
    name: 'Exact money',
    built:
      'Amounts are integer minor units with an ISO 4217 code, parsed and formatted only by `@expensewise/domain`, which refuses extra precision rather than rounding. A search for 18.92 matches 18.920 dinars and never yen.',
    short: 'Conversion to a home currency is Phase 2; the columns for it exist.',
    refs: ['ADR-0008'],
  },
  {
    id: 'AP6',
    name: 'Isolation in the database',
    built:
      'Every tenant table has `org_id`, a forced row-level security policy and composite foreign keys. The app connects as a role that can’t bypass it, and refuses to start if it could.',
    short:
      'Inside one organization the API doesn’t yet keep members to their own records (GAP-20, #50).',
    refs: ['ADR-0001', 'ADR-0013'],
  },
  {
    id: 'AP7',
    name: 'Buy the commodity',
    built:
      'Sign-in, storage and Postgres are Supabase; workflows are Inngest; reading is Anthropic, with OpenAI as fallback; errors go to Sentry and flags to PostHog. Each sits behind an interface of ours (`ObjectStore`, `Extractor`, the flag client).',
    refs: ['ADR-0003', 'ADR-0013', 'ADR-0020'],
  },
  {
    id: 'AP8',
    name: 'Ship dark',
    built:
      'Flags are read per request from PostHog, so turning one on needs no deploy. Merge is the release, so code reaches production the moment it is merged.',
    short:
      'While the only organization is the product owner’s, new screens ship without a flag (Q5); flags apply again from the first invite (#29).',
    refs: ['ADR-0019'],
  },
];

export interface Component {
  readonly name: string;
  readonly technology: string;
  readonly responsibility: string;
  /** Repository paths. Every workspace package is named by exactly one component. */
  readonly where: readonly string[];
}

export const COMPONENTS: readonly Component[] = [
  {
    name: 'Web app',
    technology: 'Next.js 16, React 19, Tailwind CSS 4',
    responsibility:
      'Every screen, as client components that call the API with the person’s token. Hosts the API at `/api` and the workflow endpoint at `/api/inngest`.',
    where: ['apps/web'],
  },
  {
    name: 'API',
    technology: 'Hono with zod-openapi; jose for tokens',
    responsibility:
      'Verifies the sign-in token, finds the caller’s membership, and serves every operation. Generates the OpenAPI contract and answers errors as problem documents.',
    where: ['packages/api'],
  },
  {
    name: 'Domain',
    technology: 'TypeScript, no I/O',
    responsibility:
      'The rules: money, dates, lifecycles, editing an expense, filing to trips, approvals. Tested to 90% coverage or more.',
    where: ['packages/domain'],
  },
  {
    name: 'Data access',
    technology: 'Drizzle ORM on node-postgres',
    responsibility:
      'The schema and migrations, `withOrg()` and every query and write, each with its audit event. Runs migrations and the data steps on release, one of which takes back anything Supabase’s Data API roles hold. Holds the restore drill’s database checks.',
    where: ['packages/db'],
  },
  {
    name: 'Receipt reading',
    technology: 'Anthropic SDK; OpenAI over HTTPS',
    responsibility:
      'Turns an image or PDF into fields with a confidence each, through one prompt and one schema. Compares two Claude models and falls back to OpenAI; checks that a reading’s sums make its total and its date is plausible before it can be Ready; checks a reading against the expense.',
    where: ['packages/extraction'],
  },
  {
    name: 'Workflows',
    technology: 'Inngest',
    responsibility:
      'Reads receipts and relays the outbox. Each step retries on its own; a failed run still settles its receipt.',
    where: ['packages/workflows'],
  },
  {
    name: 'File storage',
    technology: 'Supabase Storage over its REST API',
    responsibility:
      'The private receipts bucket: one-time signed uploads, short-lived signed reads, size and type limits.',
    where: ['packages/storage'],
  },
  {
    name: 'Feature flags',
    technology: 'PostHog (posthog-node)',
    responsibility:
      'A registry of flags, read per request, with local overrides for tests. Off by default.',
    where: ['packages/flags'],
  },
  {
    name: 'Records and pages',
    technology: 'TypeScript',
    responsibility:
      'Requirements, features, gaps, questions and the backlog, checked against the code in every test run, and the four published pages: traceability, backlog, this architecture and the data model.',
    where: ['tools/records'],
  },
  {
    name: 'Evals',
    technology: 'TypeScript, Playwright for synthetic receipts',
    responsibility:
      'Scores the reading models against labelled receipts. Receipt images and eval data never go in git.',
    where: ['evals'],
  },
];

/** Services outside the repository. */
export const SERVICES: readonly { readonly name: string; readonly role: string }[] = [
  { name: 'Vercel', role: 'Builds every push; serves production once the release promotes it.' },
  {
    name: 'Supabase',
    role: 'Postgres, sign-in (Auth) and the receipts bucket (Storage), on the Free plan (ADR-0014).',
  },
  { name: 'Inngest', role: 'Runs the workflows, with retries and a schedule.' },
  { name: 'Anthropic', role: 'Claude models read receipts, with each organization’s own key.' },
  { name: 'OpenAI', role: 'The fallback reader when no Claude model could read (ADR-0020).' },
  { name: 'Sentry', role: 'Error tracking and traces.' },
  { name: 'PostHog', role: 'Feature flags.' },
  {
    name: 'GitHub Actions',
    role: 'CI gates G1–G5, the release, the nightly backup and the monthly restore drill.',
  },
  {
    name: 'Backblaze B2',
    role: 'The encrypted off-site backup, locked for 30 days, and restored from every month.',
  },
];

export const CONTEXT_DIAGRAM = `flowchart LR
  P["People<br/>in the browser"] -->|"/api/v1 with<br/>their token"| W
  subgraph V["Vercel"]
    W["Next.js app<br/>screens · API · /api/inngest"]
  end
  subgraph S["Supabase"]
    AU["Auth<br/>sign-in, JWKS"]
    PG[("Postgres<br/>row-level security")]
    ST["Storage<br/>private receipts"]
  end
  P -->|"sign in"| AU
  P -->|"signed upload"| ST
  W -->|"verify token"| AU
  W -->|"expensewise_app"| PG
  W -->|"signed URLs"| ST
  W -->|"events"| I["Inngest<br/>workflows"]
  I -->|"run steps"| W
  W -->|"read receipt"| AN["Anthropic"]
  W -.->|"fallback"| OA["OpenAI"]
  W -.-> SE["Sentry"]
  W -.-> PH["PostHog"]
  GH["GitHub Actions"] -->|"migrate"| PG
  GH -->|"promote"| V
  GH -->|"nightly"| B2["Backblaze B2<br/>encrypted backup"]
  B2 -.->|"monthly<br/>restore drill"| GH`;

export interface Flow {
  readonly id: string;
  readonly title: string;
  readonly about: string;
  readonly diagram: string;
  readonly refs: readonly string[];
}

export const FLOWS: readonly Flow[] = [
  {
    id: 'capture',
    title: 'A receipt becomes an expense on a trip',
    about:
      'The request answers in about a second; the reading happens after it. The file goes straight from the browser to storage, so it never passes through the API.',
    diagram: `sequenceDiagram
  actor P as Person
  participant W as Web app
  participant A as API
  participant S as Storage
  participant DB as Postgres
  participant I as Inngest
  participant M as Models
  P->>W: Takes a photo
  W->>A: POST /v1/receipts/uploads
  A-->>W: One-time signed upload
  W->>S: Uploads the file
  W->>A: POST /v1/receipts
  A->>DB: One transaction: receipt, expense (processing), outbox event, audit events
  A->>I: Sends the event after commit
  A-->>W: Filed
  I->>A: Read a receipt (/api/inngest)
  A->>S: Check the file
  par Each compared model
    A->>M: Image to fields
  end
  opt No Claude model could read it
    A->>M: OpenAI fallback
  end
  Note over A: Ready needs confident readings that agree,<br/>sums that make the total and a plausible date
  A->>DB: One transaction: receipt settles, expense follows, files to its trip by date
  Note over DB: Ready only when the receipt is Ready and the claim is complete`,
    refs: ['ADR-0017', 'ADR-0020', 'ADR-0022', 'ADR-0023', 'FR-INT-04'],
  },
  {
    id: 'request',
    title: 'Every API request',
    about:
      'Who the caller is comes from a verified token; what they can see comes from the database.',
    diagram: `sequenceDiagram
  participant W as Web app
  participant A as API
  participant AU as Supabase Auth
  participant DB as Postgres
  W->>A: Request, bearer token
  A->>AU: Project public keys (cached)
  A->>A: Verify an ES256 or RS256 signature, issuer, audience, expiry
  A->>DB: Find the caller’s membership (app.user_id)
  A->>DB: withOrg: set app.org_id, run the work
  Note over DB: Every row checked against app_current_org()
  DB-->>A: Only this organization’s rows
  A-->>W: JSON, or a problem document`,
    refs: ['NFR-SEC-01', 'NFR-SEC-09', 'ADR-0013'],
  },
  {
    id: 'release',
    title: 'Merge is the release',
    about:
      'A pull request passes the gates; merging it starts the release, which changes the database before the code that needs it goes live.',
    diagram: `flowchart LR
  PR["Pull request"] --> G["CI gates G1–G5<br/>CodeQL"]
  PR --> PV["Vercel preview<br/>no production data"]
  G --> R{"Product owner:<br/>merge?"}
  R -->|merge| M["main"]
  M --> MG["Release: migrate<br/>as schema owner"]
  MG --> RP["Set role passwords<br/>where needed"]
  RP --> PR2["Promote this commit's<br/>build to production"]
  PR2 --> H["/api/v1/health<br/>reports the commit"]
  H --> PG["Pages republished"]`,
    refs: ['ADR-0018', 'ADR-0019'],
  },
  {
    id: 'backup',
    title: 'Nightly backup',
    about:
      'A second vendor holds an encrypted copy, so losing the Supabase project loses at most a day.',
    diagram: `flowchart LR
  T["09:17 UTC"] --> HB["Write the heartbeat"]
  HB --> D["Dump the database<br/>auth users included"]
  D --> E["Encrypt with<br/>the passphrase"]
  E --> B["Upload to B2<br/>30-day lock"]
  B --> RI["Copy new<br/>receipt images"]
  RI --> Q["Check Free plan quotas<br/>alert at 70%"]`,
    refs: ['ADR-0014', 'NFR-REL-01'],
  },
  {
    id: 'restore-drill',
    title: 'Monthly restore drill',
    about:
      'Proves the newest backup restores the way a recovery would: into a new Supabase project, here a throwaway one on the runner with the same auth and storage services. It reads only the bucket; it never connects to production.',
    diagram: `flowchart LR
  T["2nd of the month<br/>11:43 UTC"] --> DL["Download the newest dump<br/>decrypt, check checksums"]
  DL --> S["Throwaway Supabase<br/>Postgres, auth, storage"]
  S --> R["Restore roles,<br/>schema, then data"]
  R --> F["Bring forward as the<br/>release would"]
  F --> C["Row counts, migrations,<br/>schema, isolation"]
  C --> I["Receipt images match<br/>their SHA-256"]
  I --> O["Recovery point 24 h,<br/>recovery time 4 h"]`,
    refs: ['ADR-0014', 'NFR-REL-02', 'NFR-REL-03'],
  },
];

export interface Setting {
  /** The names it covers; every setting the code or a workflow reads is named once. */
  readonly names: readonly string[];
  readonly kind:
    'Secret' | 'Public build variable' | 'Set by the platform' | 'Constant' | 'Tooling';
  readonly where: string;
  readonly use: string;
}

export const SETTINGS: readonly Setting[] = [
  {
    names: ['DATABASE_URL'],
    kind: 'Secret',
    where: 'Vercel, Production only; locally from `pnpm db:up`',
    use: 'The app’s connection, as `expensewise_app`. Tests use it as a superuser to build throwaway databases, and the end-to-end bench to build its own.',
  },
  {
    names: ['RELAY_DATABASE_URL'],
    kind: 'Secret',
    where: 'Vercel',
    use: 'The outbox relay’s connection, as `expensewise_relay`. Without it the relay isn’t registered.',
  },
  {
    names: ['DATABASE_MIGRATION_URL'],
    kind: 'Secret',
    where: 'GitHub `production` environment',
    use: 'The schema owner, for migrations and role passwords during the release.',
  },
  {
    names: ['EXPENSEWISE_APP_DB_PASSWORD', 'EXPENSEWISE_RELAY_DB_PASSWORD'],
    kind: 'Secret',
    where: 'GitHub `production` environment',
    use: 'Set as the runtime roles’ passwords, only where they don’t already work.',
  },
  {
    names: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
    kind: 'Public build variable',
    where: 'Vercel',
    use: 'Sign-in in the browser, and where the API fetches the public keys to verify tokens.',
  },
  {
    names: ['SUPABASE_SECRET_KEY'],
    kind: 'Secret',
    where: 'Vercel, Production only',
    use: 'Server-side access to the receipts bucket; also derives the key-encryption key when `APP_ENCRYPTION_KEY` is unset.',
  },
  {
    names: ['APP_ENCRYPTION_KEY'],
    kind: 'Secret',
    where: 'Vercel (optional)',
    use: 'Derives the key that encrypts each organization’s AI provider keys (ADR-0015).',
  },
  {
    names: ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'],
    kind: 'Secret',
    where: 'Vercel, from the Inngest integration',
    use: 'Sending events, and proving that calls to `/api/inngest` come from Inngest.',
  },
  {
    names: ['INNGEST_DEV'],
    kind: 'Tooling',
    where: 'Local only',
    use: 'Points the workflows at the local Inngest dev server.',
  },
  {
    names: ['VERCEL_GIT_COMMIT_SHA', 'NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA', 'NEXT_PUBLIC_VERCEL_ENV'],
    kind: 'Set by the platform',
    where: 'Vercel',
    use: 'The version `/api/v1/health` reports, and the environment errors are tagged with.',
  },
  {
    names: ['NEXT_RUNTIME'],
    kind: 'Set by the platform',
    where: 'Next.js',
    use: 'Which runtime the error-tracking setup is loading in.',
  },
  {
    names: ['NEXT_PUBLIC_SENTRY_DSN'],
    kind: 'Public build variable',
    where: 'Vercel',
    use: 'Where errors and traces go. Without it, error tracking is a no-op.',
  },
  {
    names: ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'],
    kind: 'Secret',
    where: 'Vercel build',
    use: 'Uploading source maps at build time. Without them the build still succeeds.',
  },
  {
    names: ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST'],
    kind: 'Public build variable',
    where: 'Vercel',
    use: 'Reading feature flags.',
  },
  {
    names: ['FLAG_OVERRIDES'],
    kind: 'Tooling',
    where: 'Local and tests',
    use: 'Forces flags on or off without PostHog.',
  },
  {
    names: ['CI', 'E2E_BASE_URL', 'E2E_PORT', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE'],
    kind: 'Tooling',
    where: 'CI and local test runs',
    use: 'How the end-to-end tests find the app and the browser.',
  },
  {
    names: ['VERCEL_TOKEN'],
    kind: 'Secret',
    where: 'GitHub `production` environment',
    use: 'Promoting the released commit’s build to production.',
  },
  {
    names: ['VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID', 'PRODUCTION_URL', 'RELEASE_SHA', 'REPOSITORY'],
    kind: 'Constant',
    where: '`.github/workflows/release.yml`',
    use: 'Which project and commit the release promotes, and where it checks the result.',
  },
  {
    names: ['GITHUB_TOKEN'],
    kind: 'Set by the platform',
    where: 'GitHub Actions',
    use: 'Lets the release check that main hasn’t moved on before promoting.',
  },
  {
    names: ['BACKUP_DATABASE_URL', 'BACKUP_PASSPHRASE'],
    kind: 'Secret',
    where: 'GitHub `backup` environment',
    use: 'The backup’s database connection, and the passphrase that encrypts each dump and that the restore drill decrypts with. The product owner keeps a copy of the passphrase. The drill is given the passphrase only, never the connection.',
  },
  {
    names: ['B2_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET'],
    kind: 'Secret',
    where: 'GitHub `backup` environment',
    use: 'Writing to the Backblaze bucket, and reading it back for the restore drill. The key can delete after the 30-day lock (GAP-18, #48).',
  },
  {
    names: ['SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY'],
    kind: 'Secret',
    where: 'GitHub `backup` environment',
    use: 'Reading new receipt images from Supabase Storage for the backup.',
  },
  {
    names: ['RESTORE_DATABASE_URL', 'DRILL_MANIFEST'],
    kind: 'Tooling',
    where: '`scripts/backup/restore-drill.sh`',
    use: 'The throwaway database the drill restored into, and the dump’s manifest, for its database checks. They refuse any database not on the runner.',
  },
];

/** What each GitHub workflow is for, by file. */
export const WORKFLOWS: Readonly<Record<string, string>> = {
  'ci.yml':
    'The quality gates on every pull request and push to main: static checks, unit and property tests with coverage, integration and contract against a real Postgres, security, then build and end-to-end, signed out and, against the real API on its own database, signed in, with layout and accessibility checks.',
  'codeql.yml': 'Static analysis for security on every pull request, push and week.',
  'release.yml':
    'Runs when main changes: migrate, set role passwords where needed, then promote the commit’s build. One at a time, never cancelled.',
  'backup.yml':
    'The nightly encrypted backup to Backblaze B2, with the heartbeat and quota alerts.',
  'restore-drill.yml':
    'On the 2nd of each month and on demand, restores the newest backup into a throwaway Supabase stack and checks row counts, migrations, the schema, tenant isolation, receipt images, and the recovery point and time.',
  'advisory-watch.yml':
    'Every Monday, fails once an ignored dependency advisory has a fix, so the ignore can go (GAP-19).',
};

/** What each background function does, by id. */
export const BACKGROUND: Readonly<Record<string, string>> = {
  'receipt-reading':
    'Reads a receipt when it is uploaded or read again: checks the file, reads it with each compared model in parallel steps, falls back to OpenAI when none could, then settles the receipt, its expense and its trip.',
  'outbox-relay':
    'Every five minutes and on demand, sends committed outbox events that the request didn’t manage to send. The event id is the outbox id, so a duplicate is dropped.',
};

export interface Quality {
  readonly attribute: string;
  readonly how: string;
  readonly short: string;
  readonly refs: readonly string[];
}

export const QUALITY: readonly Quality[] = [
  {
    attribute: 'Security',
    how: 'Forced row-level security, a runtime role that can’t bypass it, Supabase’s Data API roles stripped on every release, verified tokens, encrypted provider keys, a private bucket, invite-only sign-in, security headers, and production credentials in production builds only.',
    short: 'Members aren’t yet kept to their own records (GAP-20); no second factor (#8).',
    refs: ['NFR-SEC-01', 'NFR-SEC-13', 'GAP-20', '#8'],
  },
  {
    attribute: 'Integrity',
    how: 'One transaction per change with its audit event; exact money; idempotent filing and reading; constraints for what must always hold.',
    short: 'Approved expenses are locked in code only, until approval exists (#24).',
    refs: ['NFR-DAT-01', 'NFR-DAT-06', '#24'],
  },
  {
    attribute: 'Responsiveness',
    how: 'Requests do only database work; reading runs after the answer, on Inngest.',
    short: 'Nothing is measured from outside the app yet.',
    refs: ['NFR-PERF-01'],
  },
  {
    attribute: 'Recoverability',
    how: 'Nightly encrypted backups to a second vendor, locked for 30 days, and a monthly drill that restores the newest one and checks it. Recovery point 24 hours, recovery time 4 hours.',
    short:
      'The drill restored production’s backup in 1 min 11 s on Oct 3, but a whole recovery, into a new project with Vercel pointed at it, has not been rehearsed (#56).',
    refs: ['NFR-REL-01', 'NFR-REL-02', 'NFR-REL-03', '#56'],
  },
  {
    attribute: 'Operability',
    how: 'Health and readiness endpoints report the version, the role, TLS and row-level security; errors go to Sentry; a failed GitHub run, the backup included, emails the owner.',
    short: 'No uptime monitoring from outside.',
    refs: ['NFR-REL-05'],
  },
  {
    attribute: 'Changeability',
    how: 'A generated API contract, migrations checked against the schema, a schema snapshot checked against the migrations, and records the tests check against the code.',
    short:
      'Phase 0 tables nothing uses yet (categories, mileage, reports, approvals) may change shape before first use.',
    refs: ['FR-EXP-11'],
  },
  {
    attribute: 'Accessibility and fit on a phone',
    how: 'Gate G5 opens every screen, signed out and signed in against the real API, in desktop Chromium and iPhone WebKit at three phone widths, light and dark, and checks layout and WCAG 2.2 AA. Colour tokens meet AA contrast, small links have 44-point touch areas, focus stops above the tab bar, and date fields are drawn without the native look so iOS can’t widen them out of their card.',
    short:
      'Its WebKit is not iOS Safari, so an iOS-only quirk other than native date fields would still reach a phone first (GAP-22, #57).',
    refs: ['NFR-UX-01', 'NFR-UX-02', 'GAP-22', '#57'],
  },
];
