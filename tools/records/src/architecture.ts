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
      'Every state change appends a hash-chained audit event in its own transaction. The database refuses to change or remove one. Confirmations of readings are append-only too. Settings › Audit trail recomputes the chain from every stored event each time it opens (FR-GOV-06). An approved expense is locked: the database refuses any change to it but settling it, whoever asks, and each round of a report’s approval keeps its step and rejections (ADR-0043).',
    short:
      'Correcting an approved expense, with a reversal and a new version, isn’t built (GAP-34, #87).',
    refs: ['ADR-0008', 'ADR-0043', 'GAP-34', '#87'],
  },
  {
    id: 'AP5',
    name: 'Exact money',
    built:
      'Amounts are integer minor units with an ISO 4217 code, parsed and formatted only by `@expensewise/domain`, which refuses extra precision rather than rounding. A search for 18.92 matches 18.920 dinars and never yen. A receipt’s tax, tip and fees are spread across its lines in whole minor units, and a split’s parts and their conversions add up exactly (ADR-0041).',
    short: 'Conversion to a home currency is Phase 2; the columns for it exist.',
    refs: ['ADR-0008'],
  },
  {
    id: 'AP6',
    name: 'Isolation in the database',
    built:
      'Every tenant table has `org_id`, a forced row-level security policy and composite foreign keys. The app connects as a role that can’t bypass it, and refuses to start if it could. Inside an organization, each request names its caller’s membership to the database, and policies and triggers keep a member to their own receipts, expenses, trips and reports; owners, finance admins and auditors see everyone’s, and an auditor changes nothing (ADR-0035). An approver also sees each report routed to them and what is on it, and whoever decides a report changes only its status and its expenses’ (ADR-0043). Background work names no member and acts for the system.',
    short:
      'The audit trail and the outbox are kept to the organization, not to each member (GAP-31, #74).',
    refs: ['ADR-0001', 'ADR-0013', 'ADR-0035', 'ADR-0043', 'GAP-31', '#74'],
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
      'Every screen, as client components that call the API with the person’s token, expense reports among them. Signs in, and handles the second factor, through Supabase Auth in the browser, for authentication only: adding and removing authenticator apps, the code screen before anything else while the organization has it on, and the code asked for in the middle of an admin action, or of any read or change the API holds for someone with an authenticator, which is then sent again, the prompt giving way to the code screen when it opens (ADR-0042, ADR-0044). Hosts the API at `/api` and the workflow endpoint at `/api/inngest`.',
    where: ['apps/web'],
  },
  {
    name: 'API',
    technology: 'Hono with zod-openapi; jose for tokens; pdf-lib for report PDFs',
    responsibility:
      'Verifies the sign-in token, finds the caller’s membership and runs each member-facing store’s transaction as that member, so the database shows them only what their role allows (ADR-0035); a change the database refuses answers 403 `not_yours`. While the organization has the second factor on, every admin action needs a session that passed it (aal2), checked by one helper after the role check, and switching it on needs the owner’s own (ADR-0042); and a session of someone whose sign-in has a verified authenticator, until it passes the code, gets nothing but who they are and the switches, checked once as each request finds its caller, from Supabase Auth’s own record of factors read in the same query; linking a sign-in needs the code from anyone with one, whatever the switch (ADR-0044). Serves Settings › People: invite links, roles and removing someone, and accepting a link. Serves every operation, including Home, read in one transaction: the Needs you inbox, which says why each item needs the person, then their trip, month and recent trips, the month with the person’s business miles while mileage is on. Takes Bird’s signed email webhook, checked against the exact bytes before anything parses them. Settles possible duplicates as the person decides, removing a deleted receipt’s file only after the deletion commits. Serves expense reports: closing, reopening, moving a trip or local expense, and justifying one; Needs you adds reports to act on and local expenses needing a reason. While approval is on, submits a closed report to its approver, judging each expense against what its receipt shows, and approves it, asking for the second factor to approve someone else’s, or returns it with a comment and each rejected expense; Needs you adds reports to approve and those that came back, with each rejected expense and why (ADR-0043). Serves the audit trail to owners, finance admins and auditors, a page at a time, and recomputes its hash chain when asked. Exports a closed report, or once approval is on a submitted or approved one (Q29), as CSV, and as a PDF summary laid out in the request with pdf-lib: a database read and a layout in memory, with no other service. In the PDF a column of figures is never narrower than its widest value, so a date or an amount is never broken however many columns a report adds; while Journeys and stays is on, a report with a journey or a stay adds From and to, or Stay. Serves Settings › Organization: the details and the duplicate time window, which every member reads and only the owner changes. Logs, quotes and corrects drives, each only the caller’s own, behind the mileage flag, and serves the rate a mile they are paid at, which every member reads and only owners and finance admins set from a day (Q28); behind route mileage, logs a drive by its stops and hands the request to measure it on, changes its stops or the miles it claims with a reason, keeps each person’s saved places, and keeps the organization’s OpenRouteService key, checked with one short route as it is saved and stored encrypted, the one call to that service made in a request (ADR-0039). Serves the categories and types an organization keeps, which only owners and finance admins change, and shows each expense its own, or a suggestion worked out in the request by rules, with no model call; while they are on, Needs you also lists the person’s Ready expenses that have neither, with that suggestion (Q27). While emails that filed nothing are on, Needs you lists the person’s own, with why, and dismisses one for them alone (#59). While currency conversion is on, serves each person’s reimbursement currency and shows reports, Home and Needs you in it, beside the amounts as spent. While itemized lines are on, shows each expense its receipt’s lines, with their shares and whether they add up, and leaves a line out of the claim with a reason; while splits are on, splits an expense into parts by line or by amount and totals a report by category and type, and the export writes a row per part and the lines left out (ADR-0041). Generates the OpenAPI contract and answers errors as problem documents.',
    where: ['packages/api'],
  },
  {
    name: 'Domain',
    technology: 'TypeScript, no I/O',
    responsibility:
      'The rules: money, dates, lifecycles, editing an expense and its time and place, filing to trips, when two receipts are the same purchase, exactly or possibly, and how two expenses merge, when something joins a report and what day 28 does, counted in an organization’s time zone or at UTC−12, what a report’s export holds and who may export it, approvals: who a report goes to, who may decide it and when the second factor is needed, and whether an expense holds up against its receipt, claiming less only with a reason (ADR-0043), an organization’s details and the duplicate window’s bounds, which reference rate a purchase date takes and what a report adds up to in the reimbursement currency, approvals, what a drive pays: the organization’s latest change on or before its date, its own rate a mile or the IRS rate again, else the IRS business rate, held as a table with the last day it is known for (ADR-0038, Q28), all through one function, and a drive by its route: its stops, the miles in hundredths from whole metres in integer arithmetic, and when other miles need a reason (ADR-0039), and drives’ miles added up exactly for Home, how categories and types nest and which pairs can be chosen, and the rules that suggest a type from a person’s past choices, the reading and the merchant’s name, and a hotel stay’s nights, worked out from its dates and not sure past 31 (ADR-0040); whether a receipt’s lines add up, each item’s share of the tax, tip and fees, spread in proportion with the largest share taking what is left, what leaving a line out leaves claimed, and the parts a split makes, always adding up to the claim (ADR-0041); the second factor’s own rules: a code of 6 digits, when sign-in asks for it, and who is offered an authenticator app, up to 10 (ADR-0042). Tested to 90% coverage or more.',
    where: ['packages/domain'],
  },
  {
    name: 'Data access',
    technology: 'Drizzle ORM on node-postgres',
    responsibility:
      'The schema and migrations, `withOrg()`, which can name the member a transaction acts for (ADR-0035), and every query and write, each with its audit event. Makes, accepts and revokes invite links, keeping only each token’s hash, and changes roles and removes people, never the last owner. Runs migrations and the data steps on release: one takes back anything Supabase’s Data API roles hold, another compares each receipt read before duplicates were looked for, once. Compares each receipt as its reading settles and holds a later copy, and keeps when its first reading settled; corrects a Ready receipt’s field with its expense in one transaction; deletes a receipt only through `delete_receipt()`. Joins trips and local expenses to reports and closes them on day 28, by the organization’s days when it keeps a time zone; any change to a closed report reopens it. Reads a report with every expense on it for its export, with the category and type names copied on when it was submitted. Submits a report to its approver, copying those names on, and approves or returns it with each rejection, naming the report it decides so the database lets the person deciding change only its status and its expenses’ (ADR-0043). Keeps the organization’s details and duplicate window, each change audited. Writes a drive as an expense and its mileage log together, with the rate copied on, reading the organization’s own rates a mile in the same transaction, and keeps those rates, each change audited; a drive by its route with its stops and the request to measure it, and records a measurement only for the request it was made for. Keeps each member’s saved places and the organization’s routing key, as ciphertext. Lists a member’s Ready expenses with no category and type for Needs you, leaving out any held as a possible duplicate, and their emails that filed nothing, never with their text; records a dismissal once, audited. Seeds each new organization’s ready-made categories and types through `seed_starter_catalog()`, and keeps the lists and each expense’s choice. Converts a report’s amounts with the rates it is given, records each conversion with its rate, and asks for conversion in the transaction of any change that leaves something to convert. Copies a reading’s itemized lines onto its expense while the expense follows its receipt, and keeps the lines left out and the parts of a split, worked out again on each change and audited; an expense’s lines and parts go just before it (ADR-0041). Holds the restore drill’s database checks.',
    where: ['packages/db'],
  },
  {
    name: 'Receipt reading',
    technology: 'Anthropic SDK; OpenAI over HTTPS',
    responsibility:
      'Turns an image or PDF into fields with a confidence each, through one prompt and one schema, the time of purchase and the merchant’s address among them; each organization is asked the additions it switched on, composed independently, each adding its own instructions, structure and version: the line of the receipt behind each field (GAP-14), and where a ride, flight or train went and a folio’s stay (ADR-0040); with none on, the request is byte for byte what it always was. No request offers the model a tool, a tool choice or a function, and a test of every request, as it leaves, holds it to that (NFR-SEC-07). Works out a time zone from the city, region and country offline (city-timezones), so no address leaves ExpenseWise. Compares two Claude models and falls back to OpenAI; checks that a reading’s sums make its total, counting fees as well as tax and tip, that its date is plausible and that it isn’t a purchase summary before it can be Ready; checks a reading against the expense; turns a reading’s itemized lines into minor units for its expense to keep, or none when any can’t be read exactly.',
    where: ['packages/extraction'],
  },
  {
    name: 'Workflows',
    technology: 'Inngest',
    responsibility:
      'Reads receipts, with the models each organization chose or side by side, reads emailed receipts, relays the outbox, keeps expense reports on time, converts their amounts with the ECB’s reference rates, fetched over HTTPS, and measures drives by their route with OpenRouteService: Pelias search for each stop, then driving-car directions, on the organization’s own key. Reads an organization’s feature switches inside its transaction where it has no request to ask, the server’s override first, as the API does (ADR-0032). An email is fetched as it arrived, its sender proved by a DKIM signature aligned with the From domain (mailauth), or kept with why it wasn’t, its parts read (postal-mime) and its attachments filed like uploads; with nothing attached, its HTML becomes text (html-to-text) laid out as a PDF (pdf-lib) and filed instead. Each step retries on its own; a failed run still settles its receipt.',
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
      'A registry of flags, each off by default. One gate in the API (`features.ts`) answers whether a feature is on for an organization: the server’s override, then the owner’s switch in `org_features`, then off. A route behind an off feature answers 404 `feature_off`, and screens hide it. Work with no request, such as the report schedule or the duplicate check, asks `featureOn()` in the data access package, which reads the same override first.',
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
  {
    name: 'OpenRouteService',
    role: 'HeiGIT’s routing service on OpenStreetMap data: finds each stop of a drive by its route and measures the drive by car, on each organization’s own free Standard key, kept in Settings (ADR-0039).',
  },
  {
    name: 'European Central Bank',
    role: 'Its data API publishes the euro reference rates a report’s amounts are converted at; public, with no key or account (ADR-0034).',
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
  W -->|"reference rates"| ECB["ECB data API"]
  W -->|"find stops, route a drive"| ORS["OpenRouteService"]
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
  A->>DB: Which models: the organization’s settings, its keys, the operator’s stops
  A->>S: Check the file
  alt AI model settings on
    loop The primary, then each back-up while none has read it
      A->>M: Image to fields
    end
    Note over A: Ready needs one confident reading,<br/>sums that make the total and a plausible date
  else Side by side
    par Each compared model
      A->>M: Image to fields
    end
    opt No Claude model could read it
      A->>M: OpenAI fallback
    end
    Note over A: Ready needs confident readings that agree,<br/>sums that make the total and a plausible date
  end
  A->>DB: One transaction: receipt settles, expense follows with its receipt's lines,<br/>files to its trip by date, and a later copy of another receipt is held for a look
  Note over DB: Ready only when the receipt is Ready and the claim is complete
  P->>W: Opens Home
  W->>A: GET /v1/home, with the person’s own day
  A-->>W: What needs them, their trip, month and recent trips`,
    refs: [
      'ADR-0017',
      'ADR-0020',
      'ADR-0022',
      'ADR-0023',
      'ADR-0033',
      'ADR-0041',
      'FR-INT-04',
      'FR-INT-16',
    ],
  },
  {
    id: 'email-in',
    title: 'An emailed receipt',
    about:
      'The webhook only checks Bird’s signature and hands the email on; who sent it is proved in the workflow, from the message as it arrived. Nothing is kept unless the From address is a member’s sign-in, and nothing is filed unless a DKIM signature aligned with that address’s domain covers the whole message. An email with nothing attached, such as a ride receipt, is filed as its own text laid out as a PDF (ADR-0027). Every id comes from the message, so a repeat delivery or a retried step files nothing twice. A member’s email that files nothing, unproved with why or with nothing in it to read, is kept so that, while the feature is on, their Needs you shows it until they dismiss it (#59).',
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
    A->>DB: Email kept as unverified, with why; nothing filed
  end
  Note over P,DB: An email that filed nothing shows in the member’s Needs you`,
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
    id: 'approval',
    title: 'A report approved, or returned',
    about:
      'The person submits their own closed report; it goes in one step to one approver, who approves it or returns it. Every write is the database’s to allow: the submitter changes their own records, and the person deciding changes only the decided report’s status and its expenses’, while its step is pending (ADR-0043).',
    diagram: `sequenceDiagram
  actor M as Member
  actor R as Approver
  participant A as API
  participant DB as Postgres
  M->>A: POST /v1/reports/{id}/submit
  A->>DB: As the member: closed? each expense against its receipt; who it goes to
  A->>DB: Expenses submitted, names copied on, a pending step, report.submitted
  R->>A: GET /v1/approvals, GET /v1/reports/{id}/approval
  A->>DB: As the approver: the report and what is on it, routed to them
  alt Approve
    R->>A: POST /v1/reports/{id}/approve (aal2 for someone else's)
    A->>DB: Expenses approved and locked, report approved, step decided, report.approved
  else Return
    R->>A: POST /v1/reports/{id}/return, a comment and rejections
    A->>DB: Expenses Ready again, rejections kept, report open, step returned, report.returned
    A-->>M: Needs you: the returned report and each rejected expense, with why
  end`,
    refs: ['FR-GOV-02', 'FR-GOV-03', 'FR-GOV-04', 'FR-GOV-11', 'FR-GOV-12', 'ADR-0043'],
  },
  {
    id: 'conversion',
    title: 'A report in the currency you are reimbursed in',
    about:
      'Fetching a rate is a call to another service, so it never happens in a request: the change that leaves something to convert asks for it through the outbox, and the workflow fetches, then converts as the app inside the organization. A rate once recorded is applied again, never fetched again, and an hourly sweep catches what a failed fetch left converting (ADR-0034).',
    diagram: `sequenceDiagram
  actor P as Person
  participant A as API
  participant DB as Postgres
  participant I as Inngest
  participant E as ECB data API
  P->>A: PUT /v1/me/reimbursement-currency, or a trip joins a report, or an amount changes
  A->>DB: Reports follow the person's currency; report.conversions_due in the outbox
  DB-->>I: Relayed, or handed on at once
  I->>A: amount-conversion (/api/inngest)
  A->>DB: Convert what recorded rates allow; what still needs a rate
  A->>E: EUR rates for those currencies, over each date's 10 days before
  A->>DB: Convert, copying the rate, its date and source onto each expense
  P->>A: GET /v1/reports/{id}
  A-->>P: Each amount beside its conversion, the total, what is converting, the rates used
  Note over I,DB: Hourly at 37 past, conversion_work_due() finds what is still converting`,
    refs: ['FR-EXP-13', 'NFR-DAT-02', 'NFR-DAT-04', 'ADR-0034'],
  },
  {
    id: 'route-mileage',
    title: 'A drive measured by its route',
    about:
      'Measuring calls another service, so it never happens in a request: saving the drive asks for it through the outbox, and the workflow finds each stop and routes through them, then records the result as the system, only for the request it was made for. Each address goes as typed, with the key in a header; nothing else of the drive does (Q32). A stop not found or a refused key needs a look at once; a busy or used-up service is asked again, then needs a look (ADR-0039).',
    diagram: `sequenceDiagram
  actor P as Person
  participant A as API
  participant DB as Postgres
  participant I as Inngest
  participant O as OpenRouteService
  P->>A: POST /v1/mileage/routes: date, purpose, stops, round trip
  A->>DB: One transaction: expense (processing), mileage log with the day's rate, route, stops, outbox event, audit
  A->>I: mileage.route_measure_requested, after commit
  A-->>P: The drive, Measuring…
  I->>A: route-measuring (/api/inngest)
  A->>DB: The stops, if this request is still the one it waits for
  A->>DB: The organization's key, decrypted
  loop Each stop
    A->>O: Pelias search: the address as typed
  end
  A->>O: driving-car directions through the points, back to the start on a round trip
  alt Measured
    A->>DB: Each place and leg in metres, the total, miles, provider, when; miles × the rate on its date; Ready
  else Not found, refused key, too far
    A->>DB: Needs a look, with the reason
  else Busy or used up (429, 5xx)
    Note over I,O: Tried again 3 times, then needs a look
  end
  P->>A: PUT /v1/mileage/{id}/route/miles with a reason
  A->>DB: Claimed miles at the day's rate; the measured miles stay; audit`,
    refs: ['FR-CAP-04', 'NFR-DAT-04', 'Q31', 'Q32', 'Q33', 'ADR-0039'],
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
  A->>DB: Find the caller’s membership, and whether their sign-in has a second factor (app.user_id)
  A->>A: Hold a session that skipped the code, if it is owed
  A->>DB: withOrg: set app.org_id, run the work
  Note over DB: Every row checked against app_current_org()
  DB-->>A: Only this organization’s rows
  A-->>W: JSON, or a problem document`,
    refs: ['NFR-SEC-01', 'NFR-SEC-09', 'ADR-0013'],
  },
  {
    id: 'second-factor',
    title: 'The second factor at sign-in, and before an admin action',
    about:
      'Supabase Auth keeps each authenticator’s secret and checks each code; the API trusts the token’s `aal` claim, and learns whether its sign-in has an authenticator from Supabase Auth’s own record, through `sign_in_has_authenticator`, as it finds the caller. While the organization has it switched on, a password-only session of someone with an authenticator is asked for the code before anything else, and the API holds every request of theirs but who they are and the switches until it passes; an admin action at aal1 is asked for it, then sent again (ADR-0042, ADR-0044).',
    diagram: `sequenceDiagram
  actor P as Person
  participant W as Web app
  participant AU as Supabase Auth
  participant A as API
  P->>W: Email and password
  W->>AU: Sign in
  AU-->>W: Session at aal1, next level aal2 when an authenticator is verified
  W->>A: GET /v1/features
  A-->>W: security.second-factor on
  opt Any other request before the code
    W->>A: GET /v1/…, token at aal1
    A->>A: Find the caller, and whether their sign-in has an authenticator
    A-->>W: 403 second_factor_required
  end
  W->>P: The code screen, before anything else
  P->>W: 6-digit code
  W->>AU: Challenge and verify
  AU-->>W: Session at aal2
  P->>W: An admin change
  W->>A: PUT /v1/settings/…, bearer token
  alt Token at aal1 and the switch on
    A-->>W: 403 second_factor_required
    W->>P: The code, the page kept underneath
    P->>W: 6-digit code
    W->>AU: Challenge and verify
    W->>A: The same request, token at aal2
  end
  A-->>W: Done, with its audit event`,
    refs: ['FR-PLT-03', 'FR-GOV-04', 'ADR-0042', 'ADR-0044', 'ADR-0013'],
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
    use: 'Sign-in and the second factor in the browser, and where the API fetches the public keys to verify tokens.',
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
    use: 'Derives the key that encrypts each organization’s AI provider keys (ADR-0015) and its OpenRouteService key (ADR-0039).',
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
    use: 'Forces flags on or off for every organization, beating each owner’s switch: the kill switch. Read by the API and by the workflows alike, for each organization’s switch and for the operator’s switch per AI model: `operator.<model id>=off` stops that model reading anyone’s receipts (FR-INT-16).',
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
    'Reads a receipt when it is uploaded or read again: chooses the models, checks the file, then reads it and settles the receipt, its expense and its trip. Side by side, each compared model reads in parallel steps and OpenAI reads when none could (ADR-0017, ADR-0020). Under the organization’s AI model settings, the primary reads it and each back-up only when the ones before it read nothing, one step at a time, and one confident reading makes it Ready; with every model off it is filed for a person to fill in (ADR-0033). A model the operator stopped reads nothing.',
  'email-reading':
    'Reads an email that arrived at the receipts address: fetches it from Bird as it was received, proves its sender by DKIM, finds the member who signs in with that address, then stores and files each PDF or photo as a receipt, or with none the email’s text as a PDF, and hands their reading on. Mail from anyone else is dropped with nothing kept. Logs one line per email with what came of it (ADR-0026, ADR-0027).',
  'outbox-relay':
    'Every five minutes and on demand, sends committed outbox events that the request didn’t manage to send. The event id is the outbox id, so a duplicate is dropped.',
  'amount-conversion':
    'When a report has something to convert, or the owner switches currency conversion on: points open and closed reports at their member’s reimbursement currency, converts what rates already recorded allow, fetches the rest from the ECB’s data API, then converts again, recording each rate with its date and source. Requests for one organization close together run once, one at a time (ADR-0034).',
  'amount-conversion-sweep':
    'Hourly, at 37 past: asks which organizations still have amounts converting (conversion_work_due(), ids only), then converts in each as amount-conversion does. One failing doesn’t hold up the rest; logs one line of counts (ADR-0034).',
  'route-measuring':
    'When a drive by its route is saved, or its stops change: loads its stops if the request is still the one it waits for, finds each with OpenRouteService’s Pelias search, narrowed to the organization’s country when it keeps one, and routes by car through them in order, back to the start on a round trip, with the organization’s own key; then records each place and leg in whole metres, the total, its miles and its source, and claims those miles at the rate on the drive’s date, as the system in one transaction. A stop not found, a missing or refused key or no road leaves the drive needing a look with the reason; a busy or used-up service (429, 5xx) is tried again 3 times, then the drive needs a look. One organization’s drives one at a time (ADR-0039).',
  'report-schedule':
    'Hourly, at seven past: asks which organizations have report work due (report_work_due(), ids only), then in each, as the app and in one transaction, puts due trips and local expenses on the open report or a new one, closes reports on day 28 with what is ready, moves the rest on, and drops reports with nothing to claim. The days are the organization’s own when organization settings are on and it keeps a time zone, and UTC−12’s otherwise (ADR-0037). Safe to repeat; logs one line of counts (ADR-0029).',
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
    how: 'Forced row-level security, members kept to their own records inside an organization, a runtime role that can’t bypass it, Supabase’s Data API roles stripped on every release, verified tokens, a second factor once switched on, before anything else for someone with an authenticator and before every admin action, encrypted provider keys, a private bucket, invite-only sign-in, security headers, and production credentials in production builds only.',
    short:
      'A person’s other email with no authenticator of its own still opens on its password (GAP-35). The audit trail and the outbox are kept to the organization, not to each member (GAP-31).',
    refs: ['NFR-SEC-01', 'NFR-SEC-13', 'FR-GOV-01', 'FR-GOV-04', 'FR-PLT-03', 'GAP-31', 'GAP-35'],
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
    short: 'Phase 0 tables nothing uses yet (approvals) may change shape before first use.',
    refs: ['FR-GOV-02'],
  },
  {
    attribute: 'Accessibility and fit on a phone',
    how: 'Gate G5 opens every screen, signed out and signed in against the real API, in desktop Chromium and iPhone WebKit at three phone widths, light and dark, and checks layout and WCAG 2.2 AA. Colour tokens meet AA contrast, small links have 44-point touch areas, focus stops above the tab bar, and date fields are drawn without the native look so iOS can’t widen them out of their card.',
    short:
      'Its WebKit is not iOS Safari, so an iOS-only quirk other than native date fields would still reach a phone first (GAP-22, #57).',
    refs: ['NFR-UX-01', 'NFR-UX-02', 'GAP-22', '#57'],
  },
];
