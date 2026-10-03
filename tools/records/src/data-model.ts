/**
 * The written half of the data model page. The schema itself is read from
 * packages/db/schema.json, which the integration tests keep identical to what the migrations
 * build; column notes come from the comments in packages/db/src/schema.ts. A test fails when a
 * table or function has no description here, or a rule names an object the schema lacks, so the
 * page can't fall behind the migrations. Every pull request that changes the schema says what it
 * revised here, or why nothing needed revising.
 */

export interface Domain {
  readonly name: string;
  readonly about: string;
  readonly tables: readonly string[];
}

/** Every table is in exactly one domain. */
export const DOMAINS: readonly Domain[] = [
  {
    name: 'Organizations and people',
    about:
      'Who is in which organization, how they sign in, and the AI keys an organization brings.',
    tables: ['organizations', 'members', 'member_sign_ins', 'ai_provider_keys'],
  },
  {
    name: 'Receipts and reading',
    about:
      'The proof: each captured file, every model’s reading of it, and what a person confirmed.',
    tables: ['receipts', 'extraction_runs', 'receipt_reviews'],
  },
  {
    name: 'Expenses and trips',
    about: 'The claim: what was spent, on which trip, coded how, and the miles behind it.',
    tables: ['expenses', 'trips', 'categories', 'mileage_logs'],
  },
  {
    name: 'Reports and approval',
    about: 'Expenses gathered for submission, and each approver’s decision.',
    tables: ['reports', 'approval_steps'],
  },
  {
    name: 'Trail and delivery',
    about:
      'What happened and in what order, the events that start background work, and the backup’s heartbeat.',
    tables: ['audit_events', 'outbox_events', 'ops.heartbeat'],
  },
];

export interface TableNote {
  readonly about: string;
  /** For a table the app's code doesn't write: what does. */
  readonly writtenBy?: string;
}

export const TABLES: Readonly<Record<string, TableNote>> = {
  organizations: {
    about:
      'One business or one person working alone, with its home currency. Everything else belongs to exactly one organization (ADR-0001).',
  },
  members: {
    about:
      'A person in an organization, with their role and, for approval routing, their manager (FR-GOV-01).',
  },
  member_sign_ins: {
    about:
      'The sign-ins that reach a member. One person can have several, such as a personal and a work email, and approvals still see one person (ADR-0016).',
  },
  ai_provider_keys: {
    about:
      'An organization’s own Anthropic or OpenAI key, stored only as ciphertext bound to the organization and provider; only the last four characters are ever shown (ADR-0015, NFR-SEC-04).',
  },
  receipts: {
    about:
      'A captured file: where it is stored, its fingerprint, and whether it has been read. It stays linked to the expense it proves (FR-EXP-08, ADR-0022).',
  },
  extraction_runs: {
    about:
      'One model’s reading of one receipt for one request, with its outcome, confidence, timing and cost. Each request is read once per model, so a retry adds nothing (ADR-0017, NFR-DAT-06).',
  },
  receipt_reviews: {
    about:
      'A person confirming a reading that needed a look, as read or corrected. Append-only; each correction keeps what the model read (ADR-0021).',
  },
  expenses: {
    about:
      'What is claimed: merchant, date, amount and currency, its status, and the trip it is filed to. It follows its receipt until a person edits it (ADR-0022) and files to trips by date until a person chooses (ADR-0023).',
  },
  trips: {
    about:
      'A member’s trip: a name, a purpose, a city and its first and last days. Expenses dated inside it file to it (FR-EXP-04, ADR-0023).',
  },
  categories: {
    about:
      'Expense categories with their GL and tax codes, per organization. Defined in Phase 0; nothing uses it yet. Its shape, and the types inside it, wait on Q7 (FR-EXP-11, #51).',
  },
  mileage_logs: {
    about:
      'The journey behind a mileage expense: method, distance, and the rate copied on when the claim was made (NFR-DAT-04). Built with manual mileage (#17).',
  },
  reports: {
    about:
      'Expenses gathered for approval, usually one trip’s, with its own lifecycle. Drafting starts with #23 and approval with #24.',
  },
  approval_steps: {
    about:
      'Each approver’s decision on a report, in order. Returning a report needs a comment (FR-GOV-02, #24).',
  },
  audit_events: {
    about:
      'Every state change, in order, hash-chained per organization: editing, removing or reordering an event breaks the chain. Written in the same transaction as the change (FR-GOV-05, NFR-DAT-05).',
  },
  outbox_events: {
    about:
      'Events written in the same transaction as the change they announce, then sent to the workflows. Nothing is announced that didn’t commit, and nothing committed goes unannounced (ADR-0017).',
  },
  'ops.heartbeat': {
    about:
      'One row with the time of the last nightly backup, so the free plan never sees the project as idle. No tenant data; only the schema owner reaches it (ADR-0014, NFR-REL-05).',
    writtenBy: 'The nightly backup, as the schema owner (`scripts/backup/backup.sh`).',
  },
};

/** What each database function is for. */
export const FUNCTIONS: Readonly<Record<string, string>> = {
  app_current_org:
    'The organization this transaction works in, from `app.org_id`, which `withOrg()` sets. Every tenant policy compares against it; with no setting it is null and no row matches.',
  app_current_user:
    'The signed-in user for this transaction, from `app.user_id`, set from a verified token. Lets a person find their own memberships before an organization is chosen.',
  claim_outbox_batch:
    'Hands the relay a batch of unpublished outbox events, locking them so two sweeps never take the same one. Runs as its owner, so the relay role needs no table rights.',
  mark_outbox_published: 'Marks events the relay has sent, so they are not sent again.',
  reject_audit_mutation:
    'Fires on any UPDATE, DELETE or TRUNCATE of audit_events and refuses it, whoever asks.',
};

/** What each database role is, and who uses it. */
export const ROLES: Readonly<Record<string, string>> = {
  expensewise_app:
    'The running app. Reads and writes tenant tables under row-level security, which it can’t bypass; `assertRowSecurityApplies()` refuses to start otherwise (NFR-SEC-02).',
  expensewise_relay:
    'The outbox relay. No table rights at all: it can only call the two outbox functions.',
  anon: 'Supabase’s Data API role for anonymous callers. Has no rights to our data (ADR-0013).',
  authenticated:
    'Supabase’s Data API role for signed-in callers. Has no rights to our data either: the API is the only path (NFR-SEC-03).',
  service_role:
    'Supabase’s privileged Data API role. Stripped of every grant on our tables by migration 0002, and again on every release.',
};

export interface Rule {
  readonly rule: string;
  readonly mechanism: string;
  /** Constraints, indexes, policies, triggers or functions that enforce it; each must exist. */
  readonly objects: readonly string[];
  readonly refs: readonly string[];
}

export const RULES: readonly Rule[] = [
  {
    rule: 'One organization never sees or changes another’s rows.',
    mechanism:
      'Every tenant table carries `org_id` and a `tenant_isolation` policy, forced so even the owner’s queries obey it. References are composite `(org_id, id)` foreign keys, so a row can’t point into another organization even though foreign-key checks skip row-level security.',
    objects: ['tenant_isolation', 'app_current_org', 'expenses_trip_fk', 'receipts_expense_fk'],
    refs: ['NFR-SEC-01', 'ADR-0001'],
  },
  {
    rule: 'Supabase’s Data API roles hold nothing in our schema.',
    mechanism:
      'Migration 0002 took back their grants and the default privileges that would hand them new objects. Every release does it again (`lockDownDataApi()`), because grants can come back without a migration: a restore into a new project gives them every table and function as it recreates them.',
    objects: [],
    refs: ['NFR-SEC-03', 'ADR-0013'],
  },
  {
    rule: 'Money is exact.',
    mechanism:
      'Amounts are `bigint` minor units beside a `char(3)` ISO 4217 code with a format check. No float or numeric column holds money.',
    objects: ['expenses_currency_iso', 'reports_currency_iso', 'receipt_reviews_currency_code'],
    refs: ['NFR-DAT-01', 'ADR-0008'],
  },
  {
    rule: 'A Ready expense is complete.',
    mechanism:
      'From Ready onward, amount, currency and date must be present; only processing and needs-review expenses may lack them.',
    objects: ['expenses_complete_when_ready'],
    refs: ['FR-EXP-01'],
  },
  {
    rule: 'A converted amount carries its rate, the rate’s date and its source.',
    mechanism: 'All four FX columns are present together or absent together.',
    objects: ['expenses_fx_complete'],
    refs: ['NFR-DAT-02'],
  },
  {
    rule: 'The audit trail can’t be changed by anyone.',
    mechanism:
      'The app may only insert and read it. Triggers refuse UPDATE, DELETE and TRUNCATE, even from the owner. Each event’s hash covers the previous one, and sequence and hash are unique per organization.',
    objects: [
      'audit_events_append_only',
      'audit_events_no_truncate',
      'reject_audit_mutation',
      'audit_events_org_sequence_key',
      'audit_events_hash_key',
    ],
    refs: ['FR-GOV-05', 'NFR-DAT-05'],
  },
  {
    rule: 'The same file is filed once per organization.',
    mechanism: 'The file’s SHA-256 is unique within an organization, and must be a real digest.',
    objects: ['receipts_org_sha256_key', 'receipts_sha256_hex'],
    refs: ['NFR-DAT-06'],
  },
  {
    rule: 'Each request is read once per model.',
    mechanism:
      'A reading is unique per receipt, model and request, so a retried step adds nothing.',
    objects: ['extraction_runs_request_key'],
    refs: ['NFR-DAT-06', 'ADR-0017'],
  },
  {
    rule: 'A trip ends on or after the day it starts.',
    mechanism:
      'A check on the dates. Which trip an expense files to, and a person’s choice of it (`trip_pinned`), are rules in the domain (`tripFor`), applied under the organization’s write lock.',
    objects: ['trips_dates_ordered'],
    refs: ['FR-EXP-04', 'ADR-0023'],
  },
  {
    rule: 'A returned report says why.',
    mechanism: 'A returned approval step must carry a comment.',
    objects: ['approval_steps_return_needs_comment'],
    refs: ['FR-GOV-02'],
  },
  {
    rule: 'A mileage claim keeps the rate it was made at.',
    mechanism:
      'The rate, its currency, effective date and source are copied onto the log, so a later rate change never alters it.',
    objects: ['mileage_logs_rate_currency_iso', 'mileage_logs_distance_nonnegative'],
    refs: ['NFR-DAT-04'],
  },
  {
    rule: 'An organization has one key per AI provider, and shows only its last four characters.',
    mechanism: 'Unique per organization and provider; the hint is at most four characters.',
    objects: ['ai_provider_keys_org_provider_key', 'ai_provider_keys_hint_short'],
    refs: ['NFR-SEC-04', 'ADR-0015'],
  },
  {
    rule: 'A sign-in reaches one member.',
    mechanism:
      'An identity provider subject is unique across all organizations; a person sees their own sign-ins and memberships before choosing an organization.',
    objects: ['member_sign_ins_user_key', 'own_sign_ins', 'own_memberships'],
    refs: ['ADR-0016'],
  },
  {
    rule: 'The relay can do one thing.',
    mechanism:
      'The relay role has no table rights; it claims and marks outbox events through two owner-run functions. The outbox policy is not forced, so those functions see every organization’s events.',
    objects: ['claim_outbox_batch', 'mark_outbox_published'],
    refs: ['ADR-0017'],
  },
  {
    rule: 'An approved expense is locked; a correction is a reversal and a new version.',
    mechanism:
      'Enforced in the application today: the domain’s lifecycle refuses an edit after submission. No database rule stops an update yet; it comes with approval (#24).',
    objects: [],
    refs: ['FR-EXP-03'],
  },
];
