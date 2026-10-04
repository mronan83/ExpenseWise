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
      'Who is in which organization and what its owner keeps about it, with what role, how they sign in and the links that let someone join, the AI keys an organization brings, the AI models it reads receipts with, and the features its owner has switched on.',
    tables: [
      'organizations',
      'members',
      'member_sign_ins',
      'member_invites',
      'ai_provider_keys',
      'org_ai_models',
      'org_features',
    ],
  },
  {
    name: 'Receipts and reading',
    about:
      'The proof: each captured file, every model’s reading of it, what a person confirmed, the receipts that may be the same purchase, and the emails receipts arrived in.',
    tables: [
      'receipts',
      'extraction_runs',
      'receipt_reviews',
      'receipt_duplicates',
      'inbound_emails',
    ],
  },
  {
    name: 'Expenses and trips',
    about:
      'The claim: what was spent, on which trip, coded to which category and type, the miles behind it, and what it is in the currency it is reimbursed in.',
    tables: [
      'expenses',
      'expense_conversions',
      'trips',
      'categories',
      'expense_types',
      'category_types',
      'mileage_logs',
    ],
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
      'One business or one person working alone, with its home currency. Everything else belongs to exactly one organization (ADR-0001). Its owner keeps its country, locale, time zone, address, industry and size here, each optional, and the duplicate time window, empty for the default of 30 minutes (FR-PLT-11, FR-INT-19). With organization settings on, the time zone says which day it is for the report schedule (ADR-0037). Each change is one audit event, from and to.',
  },
  members: {
    about:
      'A person in an organization, with their role, for approval routing their manager (FR-GOV-01), and the currency they are reimbursed in, once they choose one in Settings; until then, their organization’s home currency (FR-EXP-13, Q23). An owner can change the role or remove them; a removed member keeps their row, their records and their history, signs in here no more, and comes back as the same member if invited again (FR-PLT-07, ADR-0035). The role also decides whose records they see: their own, or everyone’s for owners, finance admins and auditors.',
  },
  member_sign_ins: {
    about:
      'The sign-ins that reach a member. One person can have several, such as a personal and a work email, and approvals still see one person (ADR-0016).',
  },
  member_invites: {
    about:
      'A link an owner made for one person to join with a role (FR-PLT-07, ADR-0035). Only the SHA-256 of its token is kept; the link is shown once. It works once, for 7 days, until it is revoked; an accepted or revoked one stays as the record of who let whom in, and each step is in the audit trail. No email is sent: the owner passes the link on.',
  },
  ai_provider_keys: {
    about:
      'An organization’s own Anthropic or OpenAI key, stored only as ciphertext bound to the organization and provider; only the last four characters are ever shown (ADR-0015, NFR-SEC-04).',
  },
  org_ai_models: {
    about:
      'Which AI models read the organization’s receipts, once AI model settings are on for it (FR-INT-16, ADR-0033): one row per model, on or off, in the order back-ups are tried, and which one is primary. Owners and finance admins choose; each change is in the audit trail with the choice before and after. No rows means the defaults: Sonnet 5.5 primary, then Haiku 4.5 and GPT-5.6 Luna. A model is never deleted, only switched off.',
  },
  org_features: {
    about:
      'A feature the organization’s owner has switched on or off, with who switched it last. No row means off; the server’s override beats a row (ADR-0032, NFR-DEL-05). Each switch is in the audit trail.',
  },
  receipts: {
    about:
      'A captured file: where it is stored, its fingerprint, whether it has been read, when its first reading settled, and when it was last compared for duplicates. With its filing time, the settled time gives capture to read, whose 95th percentile Receipts shows (NFR-PERF-01, R-CAPTURE-READY); receipts read before it was kept took theirs from the audit trail. It stays linked to the expense it proves (FR-EXP-08, ADR-0022). Home lists a member’s own that need a look or failed, and counts those still being read. The app can’t delete one directly; only `delete_receipt()` can (ADR-0028).',
  },
  extraction_runs: {
    about:
      'One model’s reading of one receipt for one request, with its outcome, confidence, timing and cost. Its outcome is confident only when the reading would be Ready on its own, its sums and date included (FR-INT-04). Readings since `receipt-v2` also read fees and whether a document is a purchase summary; older ones read back as having no fees (ADR-0027). Since `receipt-v3` they read the time of purchase and the merchant’s address too; older ones read back without them (ADR-0030). An organization with Where each field was read switched on is asked `receipt-v4`, which also keeps in the output the line of the receipt behind each field (GAP-14); every other organization is still asked `receipt-v3`. Each request is read once per model, so a retry adds nothing (ADR-0017, NFR-DAT-06). A reading made under the organization’s AI model settings records why the model read: primary, or backup when the models before it read nothing; one made side by side has none (ADR-0033).',
  },
  receipt_reviews: {
    about:
      'A person confirming a reading that needed a look, as read or corrected, or correcting a field of a Ready receipt with a tap (GAP-14). Each row holds every value the receipt is then filed with; the newest for its latest reading decides. Append-only; each correction keeps what the model read, as an eval candidate (ADR-0021).',
  },
  receipt_duplicates: {
    about:
      'Two of a member’s receipts that read as the same purchase (FR-INT-18): with a time and a place on both, a similar merchant at the same place on the same day, at most 30 minutes apart, whatever the total; otherwise the same currency and total, dated a day apart at most (ADR-0031). Whether a pair is exact or possible is judged from both expenses when shown, and the audit event records it as flagged. The later one is held: it needs a look, whatever its reading settled to, which is kept here to restore, and its expense counts in no total. Open until the person decides. Keep both dismisses the pair, which is never flagged again; delete and merge remove the row with the receipt (ADR-0028).',
  },
  inbound_emails: {
    about:
      'An email a member sent to the receipts address, kept once per provider message: who sent it, its subject, whether its sender was proved, how many receipts it filed (its attachments, or with none its own text as a PDF) and, when proved, its text (at most 64 KiB). Mail from anyone who is not a member is never kept (ADR-0026, ADR-0027, FR-CAP-02).',
  },
  expenses: {
    about:
      'What is claimed: merchant, date, amount and currency, its status, and the trip it is filed to. It also carries when and where it was bought, as its receipt prints them: a local time with its time zone, worked out offline from the city, region and country, and the address (FR-INT-17, ADR-0030). It follows its receipt until a person edits it (ADR-0022) and files to trips by date until a person chooses (ADR-0023). One with a date and no trip is local: it carries a justification and points at its report itself, while one on a trip goes with the trip’s report (FR-EXP-14, ADR-0029). A drive is an expense with source `mileage` and a mileage log (ADR-0038). Home sums a member’s month through the member-and-date index, so it needs no index of its own. It carries the category and type a person chose, with when, all three together or none (FR-EXP-11); a suggestion is never stored, and suggestions read a member’s past choices through the member-and-chosen-at index (FR-INT-10, ADR-0036). Its Phase 0 columns for one converted amount (`home_amount_minor`, `fx_rate`, `fx_rate_date`, `fx_source`) assume one home currency per organization and stay unused: conversions are kept in `expense_conversions` (ADR-0034).',
  },
  expense_conversions: {
    about:
      'An expense’s amount converted to the currency its report is reimbursed in (FR-EXP-13, ADR-0034): what was converted (the amount, its currency and purchase date), into which currency, and the ECB reference rate applied, with the day it was published and its source, copied on so a later rate never changes the claim (NFR-DAT-02, NFR-DAT-04). Or that the source publishes no rate for it, so it stays as spent. One per expense: a new conversion, once the amount, currency, date or reimbursement currency changes, replaces it, and every conversion is in the audit trail. A rate already recorded for a currency, date and reimbursement currency is applied to the others alike, so one day’s rate is fetched once. It goes with its expense when that is deleted. Written only while `reports.currency-conversion` is on, by the conversion workflow.',
  },
  trips: {
    about:
      'A member’s trip: a name, a purpose, a city and its first and last days. Expenses dated inside it file to it (FR-EXP-04, ADR-0023). It points at the report it is on, which it joins 24 hours after its return date (FR-EXP-05, ADR-0029). Home finds the trip under way, the next and the last ones through the member-and-dates index.',
  },
  categories: {
    about:
      'The categories an organization codes its expenses to, with their general ledger and tax codes; they nest (FR-EXP-11, Q7, ADR-0036). Every organization starts with a ready-made five, seeded by `seed_starter_catalog()`; owners and finance admins rename, move, code and retire them, and delete one only while no expense has it. A ready-made one keeps its `starter_key`; one a person changed names who did, so an untouched set is no one’s work. People see and change them only while `expenses.categories` is on; the ready-made set is seeded either way.',
  },
  expense_types: {
    about:
      'The types an organization’s expenses are, such as Airfare or Business meal: a second list beside the categories, which also nests, where rules will attach (Q7, #71). Every organization starts with a ready-made nine, whose `starter_key` keyword suggestions look for, so a renamed one keeps its suggestions (FR-INT-10, ADR-0036). Retired, never deleted, once an expense has one.',
  },
  category_types: {
    about:
      'Which types each category allows: choosing a category narrows the types to these (Q7). A type may be allowed in several. Taking a type out of a category changes no expense that already has the pair; the pair is checked only when a person chooses (ADR-0036).',
  },
  mileage_logs: {
    about:
      'The drive behind a mileage expense, one per expense: how it was logged (manual since PR #58; route and GPS later), its date, destination, business purpose and miles, and the rate copied on when it was logged, or when its date or miles last changed: per mile, currency, the day it took effect and its source, the IRS business rate for now (NFR-DAT-04, ADR-0038). Its expense holds miles × that rate, the destination as its merchant and the purpose as its justification, so trips, reports and totals need nothing of their own for it. Read only through its expense, with the expense’s member named.',
  },
  reports: {
    about:
      'A member’s claim for reimbursement: the trips and local expenses that point at it, when it closes itself (day 28, later if reopened), and when it closed. Open, then closed by the person or on day 28, reopenable until submitted; approval follows with #24 (FR-EXP-05, FR-EXP-12, ADR-0029). Its currency is the one it is reimbursed in: while currency conversion is on, its member’s, which it opens in and follows until it is submitted; otherwise the organization’s home currency (FR-EXP-13, ADR-0034).',
  },
  approval_steps: {
    about:
      'Each approver’s decision on a report, in order. Returning a report needs a comment (FR-GOV-02, #24).',
  },
  audit_events: {
    about:
      'Every state change, in order, hash-chained per organization: editing, removing or reordering an event breaks the chain. Written in the same transaction as the change (FR-GOV-05, NFR-DAT-05). Owners, finance admins and auditors read it newest first, a page at a time by sequence, in Settings › Audit trail, which recomputes the chain each time it opens (FR-GOV-06).',
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
  app_current_member:
    'The member this transaction acts for, from `app.member_id`, which `withOrg()` sets from the caller’s membership. Null for the system’s own work, such as a workflow, which sees and changes every member’s records (ADR-0035).',
  app_current_member_role:
    'That member’s role, from `app.member_role`, set with it. A member named without a role is held to their own records.',
  app_sees_every_member:
    'Whether this transaction sees every member’s records: the system, owners, finance admins and auditors. Members and approvers see their own (ADR-0035).',
  app_changes_member:
    'Whether this transaction may change a record of a given member: the system, or that member themselves unless an auditor. Never null, so a record of a member it can’t see is refused.',
  app_record_owner:
    'The member a row belongs to: its own `member_id`, or that of the receipt or expense it hangs off, looked up under the caller’s own row-level security.',
  enforce_own_records:
    'Fires before every insert, update and delete of a member’s records and what hangs off them, and refuses one the acting member may not change with an error, so the whole transaction, its audit event included, rolls back. Silent for the system (ADR-0035).',
  app_invite_hash:
    'The SHA-256 of the invite token the API was given, from `app.invite_hash`. Lets the person holding a link see that one invite before they belong to its organization; the API clears it once read.',
  delete_receipt:
    'Deletes one receipt of the current organization with its readings, confirmations, duplicate pairs and, unless another receipt proves it, its expense; returns the file to remove. Refuses a receipt whose expense is submitted or further along. Runs as its owner, because the app holds no DELETE right on receipts, readings, confirmations or expenses (ADR-0028).',
  claim_outbox_batch:
    'Hands the relay a batch of unpublished outbox events, locking them so two sweeps never take the same one. Runs as its owner, so the relay role needs no table rights.',
  mark_outbox_published: 'Marks events the relay has sent, so they are not sent again.',
  conversion_work_due:
    'Which organizations have amounts to convert at a moment: an open or closed report in another currency than its member’s, or an amount on one in another currency than the report’s with no conversion recorded for exactly it, its purchase date before that day. Only organizations whose owner switched currency conversion on count, unless the server’s override has it on for all. The hourly sweep asks it outside any organization; it runs as its owner and answers with organization ids only (ADR-0034).',
  report_work_due:
    'Which organizations have report work due at a moment: a trip or local expense whose time to join a report has come, an open report on its day 28, or one with nothing to claim. The 24 hours are counted in the organization’s time zone when it keeps one, and at UTC−12 otherwise; it reads the zone whether or not the feature is on, so it may name an organization a few hours early, never late, and the run inside finds nothing due (ADR-0037). The hourly schedule asks it outside any organization; it runs as its owner and answers with organization ids only (ADR-0029).',
  member_for_sign_in_email:
    'Which member signs in with an email address, case aside, and that sign-in’s user, for an arriving email that names no organization yet. Runs as its owner and returns ids only, so the app still can’t read sign-ins outside an organization (ADR-0026).',
  seed_starter_catalog:
    'Gives an organization the ready-made categories and types, and which types each allows, unless it has a category or type already, so running it again adds nothing. Runs as its caller: the release ran it for every organization as the owner, and the app runs it inside `withOrg()` as an organization is created, where row-level security keeps it to that one (ADR-0036).',
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
    rule: 'Inside an organization, each member sees and changes only their own records.',
    mechanism:
      'With a member named for the transaction, a restrictive `own_records` policy shows a member or approver only their own receipts, expenses, trips, reports and emails, and the readings, confirmations, duplicate pairs and mileage that hang off them; owners, finance admins and auditors see everyone’s. An `own_records` trigger refuses any change to another member’s rows, and every change by an auditor, with an error rather than a silent skip. With no member named, the system’s own work sees and changes everything, as before (ADR-0035).',
    objects: [
      'own_records',
      'app_current_member',
      'app_sees_every_member',
      'app_changes_member',
      'enforce_own_records',
    ],
    refs: ['FR-GOV-01', 'GAP-20', 'ADR-0035'],
  },
  {
    rule: 'An invite link works once, for one organization, and only its holder sees it.',
    mechanism:
      'Only the token’s SHA-256 is stored, unique and real; an invite is accepted or revoked, never both, and accepted by a member of its own organization. Before joining, a person sees just the invite whose hash the API set for their transaction (`invite_holder`). The 7 days, the one use and the rest are the domain’s and the API’s to check, under the organization’s write lock.',
    objects: [
      'member_invites_token_hash_key',
      'member_invites_token_hash_hex',
      'member_invites_accepted_or_revoked',
      'member_invites_accepted_by_fk',
      'invite_holder',
      'app_invite_hash',
    ],
    refs: ['FR-PLT-07', 'ADR-0035'],
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
      'Amounts are `bigint` minor units beside a `char(3)` ISO 4217 code with a format check. No float or numeric column holds money; a conversion’s rate, which isn’t money, is an exact `numeric`, kept as applied.',
    objects: [
      'expenses_currency_iso',
      'reports_currency_iso',
      'receipt_reviews_currency_code',
      'expense_conversions_currency_iso',
      'expense_conversions_into_iso',
      'members_reimbursement_currency_iso',
    ],
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
    rule: 'A time of purchase is a time of day, and a country is a two-letter code.',
    mechanism:
      'Checks keep `transaction_time` HH:MM from 00:00 to 23:59 and `merchant_country` two capital letters. Each may be empty: a receipt that prints no time or place is never held for it. The time zone is checked against the runtime’s list when a person sets it (ADR-0030).',
    objects: ['expenses_time_of_day', 'expenses_country_code'],
    refs: ['FR-INT-17', 'ADR-0030'],
  },
  {
    rule: 'A converted amount carries its rate, the rate’s date and its source.',
    mechanism:
      'A conversion is either converted, with its converted amount, a rate above zero, the day the rate was published, on or before the purchase date, and a named source, or has no rate, with none of them. It converts between two different currencies. The Phase 0 columns on expenses keep their own all-or-nothing check, though nothing writes them.',
    objects: [
      'expense_conversions_rate_complete',
      'expense_conversions_source_named',
      'expense_conversions_two_currencies',
      'expenses_fx_complete',
    ],
    refs: ['NFR-DAT-02', 'ADR-0034'],
  },
  {
    rule: 'An expense has one conversion at a time, in its own organization, and it keeps its rate.',
    mechanism:
      'One conversion per organization and expense, pointing at the expense by a composite key and deleted with it. The rate is copied on when it applies; a later rate never rewrites it, and a new conversion replaces it only when the amount, currency, date or reimbursement currency changed, with its audit event.',
    objects: [
      'expense_conversions_expense_key',
      'expense_conversions_expense_fk',
      'conversion_work_due',
    ],
    refs: ['NFR-DAT-04', 'FR-EXP-13', 'ADR-0034'],
  },
  {
    rule: 'The audit trail can’t be changed by anyone.',
    mechanism:
      'The app may only insert and read it. Triggers refuse UPDATE, DELETE and TRUNCATE, even from the owner. Each event’s hash covers the previous one, and sequence and hash are unique per organization. The audit trail recomputes the chain on screen, so an event edited with the guard switched off shows.',
    objects: [
      'audit_events_append_only',
      'audit_events_no_truncate',
      'reject_audit_mutation',
      'audit_events_org_sequence_key',
      'audit_events_hash_key',
    ],
    refs: ['FR-GOV-05', 'NFR-DAT-05', 'FR-GOV-06'],
  },
  {
    rule: 'The same file is filed once per organization.',
    mechanism:
      'The file’s SHA-256 is unique within an organization, and must be a real digest. A member filing a file a colleague already filed is refused without being shown the colleague’s receipt (ADR-0035).',
    objects: ['receipts_org_sha256_key', 'receipts_sha256_hex'],
    refs: ['NFR-DAT-06'],
  },
  {
    rule: 'A receipt settles after it is filed.',
    mechanism:
      'Its first settled reading’s time is never before its filing time, so capture to read is never negative. Settling sets it once, on the database’s clock, and reading the receipt again keeps it.',
    objects: ['receipts_settled_after_capture'],
    refs: ['NFR-PERF-01'],
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
      'The rate, its currency, effective date and source are copied onto the log, so a later rate change never alters it; one log per expense, on the expense’s own organization. That the expense claims miles × that rate, and that it is changed only as mileage, are rules in the domain (`applyMileageInput`) and the db code.',
    objects: [
      'mileage_logs_rate_currency_iso',
      'mileage_logs_distance_nonnegative',
      'mileage_logs_expense_key',
      'mileage_logs_expense_fk',
    ],
    refs: ['NFR-DAT-04', 'FR-CAP-03', 'ADR-0038'],
  },
  {
    rule: 'An organization has one key per AI provider, and shows only its last four characters.',
    mechanism: 'Unique per organization and provider; the hint is at most four characters.',
    objects: ['ai_provider_keys_org_provider_key', 'ai_provider_keys_hint_short'],
    refs: ['NFR-SEC-04', 'ADR-0015'],
  },
  {
    rule: 'An organization has one setting per AI model, and at most one primary, which is on.',
    mechanism:
      'Unique per organization and model; a unique index over the organization where the row is primary; a primary must be enabled. Who may choose, which models exist and that a model has its provider’s key are the API’s to check.',
    objects: [
      'org_ai_models_org_model_key',
      'org_ai_models_one_primary',
      'org_ai_models_primary_is_on',
      'org_ai_models_model_format',
      'org_ai_models_updated_by_fk',
    ],
    refs: ['FR-INT-16', 'ADR-0033'],
  },
  {
    rule: 'A reading says why its model read, or nothing.',
    mechanism: 'Its role is primary, backup, or empty for a reading made side by side.',
    objects: ['extraction_runs_role_known'],
    refs: ['ADR-0033'],
  },
  {
    rule: 'An organization switches each feature once, and only to a flag-shaped name.',
    mechanism:
      'Unique per organization and flag; the flag must look like `area.name`. Which flags exist, and that only the owner switches, is the API’s to check.',
    objects: [
      'org_features_org_flag_key',
      'org_features_flag_format',
      'org_features_updated_by_fk',
    ],
    refs: ['ADR-0032'],
  },
  {
    rule: 'An organization’s country is a two-letter code, and its duplicate window 0 to 120 minutes.',
    mechanism:
      'Checks on the columns; the size is one of the bands in `organization_size`. The home currency must be one ExpenseWise supports, the locale a language tag, and the time zone one both the runtime and Postgres know, which the domain and `updateOrganization()` check when the owner sets them. Only the owner changes them, which the API checks (ADR-0037).',
    objects: ['organizations_country_code', 'organizations_duplicate_window_range'],
    refs: ['FR-PLT-11', 'FR-INT-19', 'ADR-0037'],
  },
  {
    rule: 'An expense’s category and type are its organization’s own, chosen together.',
    mechanism:
      'Categories and types point at their parents, and the allowances and expenses at both, by composite keys, so nothing reaches into another organization. Each list keeps a name once and a ready-made key once per organization, and nothing is its own parent; deeper loops, and whether a category allows the type chosen, are checked by the domain (`nestsInItself`, `checkChoice`) under the organization’s write lock. An expense has a category, a type and when they were chosen, or none of the three.',
    objects: [
      'categories_parent_fk',
      'categories_org_name_key',
      'categories_org_starter_key',
      'categories_not_own_parent',
      'expense_types_parent_fk',
      'expense_types_org_name_key',
      'expense_types_org_starter_key',
      'expense_types_not_own_parent',
      'category_types_pair_key',
      'category_types_category_fk',
      'category_types_type_fk',
      'expenses_category_fk',
      'expenses_type_fk',
      'expenses_classified_whole',
      'seed_starter_catalog',
    ],
    refs: ['FR-EXP-11', 'ADR-0036'],
  },
  {
    rule: 'A sign-in reaches one member.',
    mechanism:
      'An identity provider subject is unique across all organizations; a person sees their own sign-ins and memberships before choosing an organization.',
    objects: ['member_sign_ins_user_key', 'own_sign_ins', 'own_memberships'],
    refs: ['ADR-0016'],
  },
  {
    rule: 'An email is kept once, and only for a member.',
    mechanism:
      'One row per organization, provider and message id; the workflow derives every id from the message, so a repeat delivery or a retried step files nothing twice. The sender is found through one owner-run function that answers with ids, and the row points at its member by a composite key.',
    objects: ['inbound_emails_message_key', 'member_for_sign_in_email', 'inbound_emails_member_fk'],
    refs: ['ADR-0026', 'NFR-DAT-06'],
  },
  {
    rule: 'A receipt is deleted whole, only through one function, and never once its expense is submitted.',
    mechanism:
      'The app has no DELETE right on receipts, readings, confirmations or expenses. `delete_receipt()` is the one way: it removes the receipt with everything that hangs off it in one statement, within the current organization, and refuses a submitted, approved or settled expense. The audit event saying what was deleted is written first, in the same transaction.',
    objects: ['delete_receipt'],
    refs: ['FR-INT-18', 'ADR-0028', 'FR-EXP-03'],
  },
  {
    rule: 'Two receipts are flagged as possible duplicates once.',
    mechanism:
      'A pair is unique per organization, held receipt and other receipt, the two must differ, and both point into the same organization by composite keys. The check looks for an earlier pair in either order, open or dismissed, so a pair the person kept is never flagged again.',
    objects: [
      'receipt_duplicates_pair_key',
      'receipt_duplicates_two_receipts',
      'receipt_duplicates_receipt_fk',
      'receipt_duplicates_other_fk',
    ],
    refs: ['FR-INT-18', 'ADR-0028'],
  },
  {
    rule: 'A report holds only its member’s trips and expenses, and an expense on a trip goes with the trip.',
    mechanism:
      'A trip and a local expense point at a report by a key that includes their member, so they can only point at that member’s report. An expense on a trip has no report of its own; it is on whatever report its trip is on.',
    objects: [
      'reports_org_member_id_key',
      'trips_report_fk',
      'expenses_report_fk',
      'expenses_report_only_when_local',
    ],
    refs: ['FR-EXP-05', 'FR-EXP-14', 'ADR-0029'],
  },
  {
    rule: 'A report is closed exactly when it has a closed time.',
    mechanism:
      'An open report has no closed time and any other has one. Closing, reopening and day 28 go through the domain’s report lifecycle under the organization’s write lock, each with its audit event.',
    objects: ['reports_closed_when_closed'],
    refs: ['FR-EXP-12', 'ADR-0029'],
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
