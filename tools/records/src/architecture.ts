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
      'Filing a receipt commits the receipt, its expense, an outbox event and the audit event in one transaction and answers at once. The reading runs on Inngest, retried step by step, and settles the receipt whatever happens. An arriving email is handed straight to Inngest instead, since its organization is unknown until its sender is proved; Bird’s redelivery does the outbox’s job (ADR-0026).',
    refs: ['ADR-0003', 'ADR-0017', 'ADR-0026'],
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
      'Sign-in, storage and Postgres are Supabase; workflows are Inngest; reading is Anthropic, with OpenAI as fallback; email-in is a Bird mailbox; errors go to Sentry and flags to PostHog. Each sits behind an interface of ours (`ObjectStore`, `Extractor`, the email ports, the flag client).',
    refs: ['ADR-0003', 'ADR-0013', 'ADR-0020', 'ADR-0026'],
  },
  {
    id: 'AP8',
    name: 'Ship dark',
    built:
      'Every feature built since Oct 4 ships behind a flag, off by default (Q5). Flags are read per request: the server’s override first, then the organization’s own switch, which its owner sets in Settings › Features at once and audited (ADR-0032), then off. Merge is the release, so code reaches production dark the moment it is merged.',
    short:
      'Screens released before Oct 4 have no flag. PostHog is wired as a source but its key is not set, so it decides nothing.',
    refs: ['ADR-0019', 'ADR-0032'],
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
      'Every screen, as client components that call the API with the person’s token, expense reports among them. Hosts the API at `/api` and the workflow endpoint at `/api/inngest`.',
    where: ['apps/web'],
  },
  {
    name: 'API',
    technology: 'Hono with zod-openapi; jose for tokens; pdf-lib for report PDFs',
    responsibility:
      'Verifies the sign-in token, finds the caller’s membership, and serves every operation, including Home, read in one transaction: the Needs you inbox, which says why each item needs the person, then their trip, month and recent trips. Takes Bird’s signed email webhook, checked against the exact bytes before anything parses them. Settles possible duplicates as the person decides, removing a deleted receipt’s file only after the deletion commits. Serves expense reports: closing, reopening, moving a trip or local expense, and justifying one; Needs you adds reports to act on and local expenses needing a reason. Exports a closed report as CSV, and as a PDF summary laid out in the request with pdf-lib: a database read and a layout in memory, with no other service. Generates the OpenAPI contract and answers errors as problem documents.',
    where: ['packages/api'],
  },
  {
    name: 'Domain',
    technology: 'TypeScript, no I/O',
    responsibility:
      'The rules: money, dates, lifecycles, editing an expense and its time and place, filing to trips, when two receipts are the same purchase, exactly or possibly, and how two expenses merge, when something joins a report and what day 28 does, what a report’s export holds and who may export it, approvals. Tested to 90% coverage or more.',
    where: ['packages/domain'],
  },
  {
    name: 'Data access',
    technology: 'Drizzle ORM on node-postgres',
    responsibility:
      'The schema and migrations, `withOrg()` and every query and write, each with its audit event. Runs migrations and the data steps on release: one takes back anything Supabase’s Data API roles hold, another compares each receipt read before duplicates were looked for, once. Compares each receipt as its reading settles and holds a later copy; deletes a receipt only through `delete_receipt()`. Joins trips and local expenses to reports and closes them on day 28; any change to a closed report reopens it. Reads a report with every expense on it for its export. Holds the restore drill’s database checks.',
    where: ['packages/db'],
  },
  {
    name: 'Receipt reading',
    technology: 'Anthropic SDK; OpenAI over HTTPS',
    responsibility:
      'Turns an image or PDF into fields with a confidence each, through one prompt and one schema, the time of purchase and the merchant’s address among them. Works out a time zone from the city, region and country offline (city-timezones), so no address leaves ExpenseWise. Compares two Claude models and falls back to OpenAI; checks that a reading’s sums make its total, counting fees as well as tax and tip, that its date is plausible and that it isn’t a purchase summary before it can be Ready; checks a reading against the expense.',
    where: ['packages/extraction'],
  },
  {
    name: 'Workflows',
    technology: 'Inngest',
    responsibility:
      'Reads receipts, reads emailed receipts, relays the outbox and keeps expense reports on time. An email is fetched as it arrived, its sender proved by a DKIM signature aligned with the From domain (mailauth), its parts read (postal-mime) and its attachments filed like uploads; with nothing attached, its HTML becomes text (html-to-text) laid out as a PDF (pdf-lib) and filed instead. Each step retries on its own; a failed run still settles its receipt.',
    where: ['packages/workflows'],
  },
  {
    name: 'File storage',
    technology: 'Supabase Storage over its REST API',
    responsibility:
      'The private receipts bucket: one-time signed uploads, short-lived signed reads, server-side saves for emailed files, removal of a deleted receipt’s file, size and type limits.',
    where: ['packages/storage'],
  },
  {
    name: 'Feature flags',
    technology: 'TypeScript, Postgres; PostHog (posthog-node) when configured',
    responsibility:
      'A registry of flags, each off by default. One gate in the API (`features.ts`) answers whether a feature is on for an organization: the server’s override, then the owner’s switch in `org_features`, then off. A route behind an off feature answers 404 `feature_off`, and screens hide it.',
    where: ['packages/flags'],
  },
  {
    name: 'Records and pages',
    technology: 'TypeScript',
    responsibility:
      'Requirements, features, gaps, questions, the backlog, and the user stories with their acceptance criteria and the register of the numbers the rules share, checked against the code in every test run: every built requirement has a story, every built criterion a test, and every rule the value the code keeps. The five published pages: traceability, backlog, this architecture, the data model, and user stories.',
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
  {
    name: 'Bird',
    role: 'The agent mailbox emailed receipts arrive at, on inbox.ai, with an allowlist of senders; signs its webhooks and keeps each message as it arrived for 30 days (ADR-0026).',
  },
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
  E["Email from a member"] --> BI["Bird mailbox<br/>allowlist"]
  BI -->|"signed webhook"| W
  W -->|"fetch as it arrived"| BI
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
  A->>DB: One transaction: receipt settles, expense follows, files to its trip by date,<br/>and a later copy of another receipt is held for a look
  Note over DB: Ready only when the receipt is Ready and the claim is complete
  P->>W: Opens Home
  W->>A: GET /v1/home, with the person’s own day
  A-->>W: What needs them, their trip, month and recent trips`,
    refs: ['ADR-0017', 'ADR-0020', 'ADR-0022', 'ADR-0023', 'FR-INT-04'],
  },
  {
    id: 'email-in',
    title: 'An emailed receipt',
    about:
      'The webhook only checks Bird’s signature and hands the email on; who sent it is proved in the workflow, from the message as it arrived. Nothing is kept unless the From address is a member’s sign-in, and nothing is filed unless a DKIM signature aligned with that address’s domain covers the whole message. An email with nothing attached, such as a ride receipt, is filed as its own text laid out as a PDF (ADR-0027). Every id comes from the message, so a repeat delivery or a retried step files nothing twice.',
    diagram: `sequenceDiagram
  actor P as Member
  participant B as Bird mailbox
  participant A as API
  participant I as Inngest
  participant DB as Postgres
  participant S as Storage
  P->>B: Emails or forwards a receipt
  Note over B: Allowlist on the envelope sender
  B->>A: POST /v1/inbound/bird, signed
  A->>A: Standard Webhooks signature, within 5 minutes
  A->>I: email/received, id = the message id
  A-->>B: 202 (503 and Bird retries if the hand-off fails)
  I->>A: Read an emailed receipt (/api/inngest)
  A->>B: The message as it arrived (RFC 5322)
  A->>A: DKIM: one From, a passing signature, aligned, whole body
  A->>DB: member_for_sign_in_email(From): ids only
  alt Not a member
    Note over A: Dropped, nothing kept
  else A member, proved
    Note over A: Nothing attached: its text, laid out as a PDF
    A->>S: Save each PDF or photo under its derived id
    A->>DB: One transaction: email, receipts, expenses, outbox events, audit
    A->>I: receipt.uploaded for each, as an upload sends
  else A member, not proved
    A->>DB: Email kept as unverified, nothing filed
  end`,
    refs: ['ADR-0024', 'ADR-0026', 'ADR-0027', 'FR-CAP-02'],
  },
  {
    id: 'duplicates',
    title: 'A possible duplicate',
    about:
      'Judged on what was read, not the file: a forward differs byte for byte, so its fingerprint never matches. The later receipt waits in Needs you and counts in no total until the person decides. Deleting goes through one owner-run function, since the app can’t delete receipts or expenses itself, and the file goes only after that commits: a failure leaves an orphaned file, never a receipt without one (ADR-0028).',
    diagram: `sequenceDiagram
  actor P as Person
  participant W as Web app
  participant A as API
  participant DB as Postgres
  participant S as Storage
  Note over DB: A reading settles: same member, currency and total,<br/>a day apart, a similar merchant? The later is held
  P->>W: Opens it from Needs you
  W->>A: GET /v1/receipts/{id}
  A-->>W: Both receipts and their expenses, side by side
  P->>W: Keep both, delete one, or merge into the one chosen
  W->>A: POST /v1/receipts/{id}/duplicates/{other}
  alt Keep both
    A->>DB: Pair dismissed, held receipt released, audit
  else Delete or merge
    A->>DB: One transaction: merged fields and their audit,<br/>the deletion’s audit, delete_receipt(), re-check any copy of it
    A->>S: Remove its file, after commit
  end
  A-->>W: Which receipt remains`,
    refs: ['FR-INT-18', 'ADR-0028', 'FR-EXP-03'],
  },
  {
    id: 'reports',
    title: 'A report’s 28 days',
    about:
      'Nothing has to be remembered: a trip is on a report a day after the person is back, and the report closes on time. The schedule works inside one organization at a time as the app, so row-level security holds; only the question of which organizations have work runs as the owner, and it answers with ids (ADR-0029).',
    diagram: `sequenceDiagram
  actor P as Person
  participant I as Inngest
  participant A as API
  participant DB as Postgres
  I->>A: report-schedule, hourly (/api/inngest)
  A->>DB: report_work_due(now): organization ids only
  loop Each organization, in one transaction as the app
    A->>DB: Due trips and local expenses join the open report, or a new one
    A->>DB: Day 28: close with what is ready, move the rest to the next report
  end
  P->>A: GET /v1/home, GET /v1/inbox
  A-->>P: Reports to finish; a report closing soon or ready to close; local expenses needing a reason
  P->>A: POST /v1/reports/{id}/close
  A->>DB: Refused while anything needs review or a reason; else closed, with its audit event
  Note over DB: Any later change to it reopens it, until it is submitted`,
    refs: ['FR-EXP-05', 'FR-EXP-12', 'FR-EXP-14', 'ADR-0029'],
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
  H --> PG["Pages republished"]
  H --> IP["A changed screen checked<br/>on an iPhone in production"]`,
    refs: ['ADR-0018', 'ADR-0019', 'ADR-0025'],
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
    | 'Secret'
    | 'Server variable'
    | 'Public build variable'
    | 'Set by the platform'
    | 'Constant'
    | 'Tooling';
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
    names: ['BIRD_WEBHOOK_SECRET'],
    kind: 'Secret',
    where: 'Vercel, Production only',
    use: 'Checks that calls to `/api/v1/inbound/bird` come from Bird (Standard Webhooks, `whsec_…`). Without it, the webhook answers 503.',
  },
  {
    names: ['BIRD_API_KEY'],
    kind: 'Secret',
    where: 'Vercel, Production only',
    use: 'Fetches an arrived email as it was received, with the `mailbox:read` scope; its `bk_us1_` prefix picks the region.',
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
    kind: 'Server variable',
    where: 'Vercel production (shell.build-version=on since Oct 4), local and tests',
    use: 'Forces flags on or off for every organization, beating each owner’s switch: the kill switch.',
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
  'email-reading':
    'Reads an email that arrived at the receipts address: fetches it from Bird as it was received, proves its sender by DKIM, finds the member who signs in with that address, then stores and files each PDF or photo as a receipt, or with none the email’s text as a PDF, and hands their reading on. Mail from anyone else is dropped with nothing kept. Logs one line per email with what came of it (ADR-0026, ADR-0027).',
  'outbox-relay':
    'Every five minutes and on demand, sends committed outbox events that the request didn’t manage to send. The event id is the outbox id, so a duplicate is dropped.',
  'report-schedule':
    'Hourly, at seven past: asks which organizations have report work due (report_work_due(), ids only), then in each, as the app and in one transaction, puts due trips and local expenses on the open report or a new one, closes reports on day 28 with what is ready, moves the rest on, and drops reports with nothing to claim. Safe to repeat; logs one line of counts (ADR-0029).',
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
