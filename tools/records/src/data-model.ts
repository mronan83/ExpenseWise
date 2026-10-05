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
      'Who is in which organization and what its owner keeps about it, with what role, how they sign in and the links that let someone join, the AI keys and the routing key an organization brings, the AI models it reads receipts with, and the features its owner has switched on.',
    tables: [
      'organizations',
      'members',
      'member_sign_ins',
      'member_invites',
      'ai_provider_keys',
      'route_service_keys',
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
      'The claim: what was spent, on which trip, coded to which category and type, the miles behind it, the route they were measured on and the rate a mile the organization pays them at, the places a person drives from, and what it is in the currency it is reimbursed in; the receipt lines it keeps, those left out of it, and the parts it is split into.',
    tables: [
      'expenses',
      'expense_conversions',
      'expense_itemizations',
      'expense_lines',
      'expense_parts',
      'trips',
      'categories',
      'expense_types',
      'category_types',
      'mileage_logs',
      'org_mileage_rates',
      'mileage_routes',
      'mileage_route_stops',
      'saved_places',
    ],
  },
  {
    name: 'Reports and approval',
    about:
      'Expenses gathered for submission, each approver’s decision, and the expenses a returned report rejected, with why.',
    tables: ['reports', 'approval_steps', 'expense_rejections'],
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
      'A person in an organization, with their role, the approver an owner chose for their reports in Settings › People, empty for Automatic (FR-GOV-01, FR-GOV-02, #86), and the currency they are reimbursed in, once they choose one in Settings; until then, their organization’s home currency (FR-EXP-13, Q23). An owner can change the role or remove them; a removed member keeps their row, their records and their history, signs in here no more, and comes back as the same member if invited again (FR-PLT-07, ADR-0035). The role also decides whose records they see: their own, or everyone’s for owners, finance admins and auditors.',
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
  route_service_keys: {
    about:
      'An organization’s own key for the routing service that measures route drives, OpenRouteService for now (Q31, ADR-0039): one per provider, stored only as ciphertext sealed as the AI keys are and bound to the organization and provider, with its last four characters and when OpenRouteService accepted it, on the check made as it was saved (NFR-SEC-04). Owners and finance admins set and remove it; each change is in the audit trail, by its last four characters only. A table of its own rather than a third AI provider, so it never lists among the AI keys. The measuring workflow reads it for the system.',
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
      'One model’s reading of one receipt for one request, with its outcome, confidence, timing and cost. Its outcome is confident only when the reading would be Ready on its own, its sums and date included (FR-INT-04). Readings since `receipt-v2` also read fees and whether a document is a purchase summary; older ones read back as having no fees (ADR-0027). Since `receipt-v3` they read the time of purchase and the merchant’s address too; older ones read back without them (ADR-0030). An organization with Where each field was read switched on is asked `receipt-v4`, which also keeps in the output the line of the receipt behind each field (GAP-14); every other organization is still asked `receipt-v3`. Since PR #59 a request is that base with the additions its organization has switched on, each joined onto both versions with “+”: with Journeys and stays on, `receipt-v3+journeys-v1` (or `receipt-v4+journeys-v1`) also keeps where a ride, flight or train went and a folio’s check-in and check-out, and may say a document is a rail ticket; a reading without them parses back with neither (ADR-0040). Each request is read once per model, so a retry adds nothing (ADR-0017, NFR-DAT-06). A reading made under the organization’s AI model settings records why the model read: primary, or backup when the models before it read nothing; one made side by side has none (ADR-0033).',
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
      'An email a member sent to the receipts address, kept once per provider message: who sent it, its subject, whether its sender was proved and, when not, why (`sender_problem`, kept since PR #60), how many receipts it filed (its attachments, or with none its own text as a PDF) and, when proved, its text (at most 64 KiB). Mail from anyone who is not a member is never kept (ADR-0026, ADR-0027, FR-CAP-02). One that filed nothing, unproved or with nothing in it to read, is in its member’s Needs you while `receipts.unfiled-emails` is on, for 30 days through the member-and-arrival index, until they dismiss it: `dismissed_at` is the one column the app may change, set once, by the member, with its audit event; the row is otherwise as it arrived (#59).',
  },
  expenses: {
    about:
      'What is claimed: merchant, date, amount and currency, its status, and the trip it is filed to. It also carries when and where it was bought, as its receipt prints them: a local time with its time zone, worked out offline from the city, region and country, and the address (FR-INT-17, ADR-0030). It follows its receipt until a person edits it (ADR-0022) and files to trips by date until a person chooses (ADR-0023). One with a date and no trip is local: it carries a justification and points at its report itself, while one on a trip goes with the trip’s report (FR-EXP-14, ADR-0029). A drive is an expense with source `mileage` and a mileage log (ADR-0038). With Journeys and stays on, it carries where a ride, flight or train went (`journey_from`, `journey_to`, as printed) and a hotel stay’s `check_in` and `check_out` days, which follow the receipt the same way and are edited the same way; the nights are worked out from the two days when shown, never stored (FR-INT-20, FR-INT-21, ADR-0040). Home sums a member’s month through the member-and-date index, so it needs no index of its own. It carries the category and type a person chose, with when, all three together or none (FR-EXP-11); a suggestion is never stored, and suggestions read a member’s past choices through the member-and-chosen-at index (FR-INT-10, ADR-0036). Its Phase 0 columns for one converted amount (`home_amount_minor`, `fx_rate`, `fx_rate_date`, `fx_source`) assume one home currency per organization and stay unused: conversions are kept in `expense_conversions` (ADR-0034). Its amount is the claim: its receipt’s total less each line left out of it with its share of the tax, tip and fees, so reports, Home and conversion follow an exclusion with nothing of their own (ADR-0041). It keeps why it claims less than its receipt, in its member’s words, 1 to 500 characters (FR-EXP-10), and, from when its report was last submitted, its category’s and type’s names as they were then (`category_name`, `type_name`), which a submitted claim and its export show from then on (NFR-DAT-04, ADR-0043). Approved, it is locked: nothing changes it but settling it.',
  },
  expense_conversions: {
    about:
      'An expense’s amount converted to the currency its report is reimbursed in (FR-EXP-13, ADR-0034): what was converted (the amount, its currency and purchase date), into which currency, and the ECB reference rate applied, with the day it was published and its source, copied on so a later rate never changes the claim (NFR-DAT-02, NFR-DAT-04). Or that the source publishes no rate for it, so it stays as spent. One per expense: a new conversion, once the amount, currency, date or reimbursement currency changes, replaces it, and every conversion is in the audit trail. A rate already recorded for a currency, date and reimbursement currency is applied to the others alike, so one day’s rate is fetched once. It goes with its expense when that is deleted. Written only while `reports.currency-conversion` is on, by the conversion workflow.',
  },
  expense_itemizations: {
    about:
      'An expense’s copy of its receipt’s itemized lines: the currency, total and subtotal of the reading they were copied from, one per expense (FR-INT-22, ADR-0041). Copied when the expense is filed and again with each new reading, while the expense follows its receipt: until a person edits it, leaves a line out or splits it, and never once it is submitted, so a submitted claim never changes under a re-read. A reading with no lines takes it away. Each copy is audited. Written whether or not `expenses.itemized` is on, so switching it on shows the lines at once.',
  },
  expense_lines: {
    about:
      'One line of that copy, numbered from 1 as printed: each item (a discount a negative one), then each tax, each fee and the tip, in the itemization’s currency. An item can be left out of the claim with a reason picked from four and a note, which other needs (FR-EXP-16, Q38), and given a category and type of its own in a split by line (FR-EXP-15, Q36). What a line and its share of the tax, tip and fees take off is the domain’s arithmetic, never stored: the claim is written to the expense’s amount. Read only through its expense, with the expense’s member named.',
  },
  expense_parts: {
    about:
      'The parts of a split expense (FR-EXP-15, Q35): each with a category and type and an amount in the expense’s currency, together its claim exactly. Split by line, they are worked out from the lines’ categories and types whenever those or an exclusion change, and the part with no category and type is the lines left with the expense’s own; split by amount, a person typed each, at least two. Reports total by them, and the export writes a row each. Submitting its expense’s report copies each part’s category and type names onto it, which the submitted claim shows from then on (NFR-DAT-04).',
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
      'The drive behind a mileage expense, one per expense: how it was logged (manual since PR #58, route since PR #59; GPS later), its date, destination, business purpose and miles, and the rate copied on when it was logged, or when its date or miles last changed: per mile, currency, the day it took effect and its source, `irs-business` for the IRS business rate or `organization` for the organization’s own (NFR-DAT-04, ADR-0038, Q28). For a route drive the miles are those claimed, 0 until it is measured or its miles are entered, its origin is its start and its destination its end (ADR-0039). Its expense holds miles × that rate, the destination as its merchant and the purpose as its justification, so trips, reports and totals need nothing of their own for it. Read only through its expense, with the expense’s member named.',
  },
  org_mileage_rates: {
    about:
      'What the organization pays drives at, as an owner or finance admin set it (Q28, #77): from each row’s day, its own rate a mile in the home currency of the day it was set, or, with no rate, the IRS business rate again. The latest row on or before a drive’s date decides; with none, the IRS rate. Its own rate has no last day known, unlike the IRS table in the domain. One row per organization and day, set again rather than deleted, with who set it last; each change is in the audit trail with what it replaced. It is the organization’s, not one member’s, so every member reads it to price their drives. A drive copies the rate it is paid at onto its log, so changing these never alters one already logged (NFR-DAT-04).',
  },
  mileage_routes: {
    about:
      'The route behind a drive logged by its stops, one per drive, beside its mileage log (FR-CAP-04, ADR-0039). Whether it is measuring, measured or failed, with the reason in plain words when it failed; whether it is a round trip; and the measuring it waits for, the outbox event’s id, so a measurement made for stops since changed is never recorded. Once measured it keeps, copied on, the distance in whole metres (the sum of its legs, the way back included), the way back alone on a round trip, its miles in hundredths, the provider, the profile and when (NFR-DAT-04); it is never measured again unless its person changes its stops before it is submitted (Q33). The reason the miles claimed differ from those measured, or were entered by hand, is here too. Written by the member’s requests and by the measuring workflow, which acts for the system.',
  },
  mileage_route_stops: {
    about:
      'A route drive’s stops in order, the start at 0: each address as its person typed it, which is what is sent to be measured (Q32), and once measured the place it was found at, its coordinates to six places and the leg to it from the stop before in whole metres (ADR-0039). Replaced whole when the stops change before submission; the audit trail keeps what they were.',
  },
  saved_places: {
    about:
      'A place a member keeps to pick for a stop, such as Home or Office: a name, once per member whatever its case, and an address (FR-CAP-04). Picking one copies its address onto the stop; its name is never sent anywhere (Q32). A member’s own under the own-records rules (ADR-0035). The audit trail records its name and that its address changed, never the address.',
  },
  reports: {
    about:
      'A member’s claim for reimbursement: the trips and local expenses that point at it, when it closes itself (day 28, later if reopened), and when it closed. Open, then closed by the person or on day 28, reopenable until submitted; with approval on, submitted by its member and waiting for approval, then approved, or returned and open again (FR-EXP-05, FR-EXP-12, ADR-0029, ADR-0043). One that has been through approval is never dropped. Its currency is the one it is reimbursed in: while currency conversion is on, its member’s, which it opens in and follows until it is submitted; otherwise the organization’s home currency (FR-EXP-13, ADR-0034).',
  },
  approval_steps: {
    about:
      'One step per submission of a report, numbered: the approver it went to, pending until decided, then who decided, approved or returned, when and with what comment; a return needs one (FR-GOV-02, ADR-0043). Only the report’s own member adds one, and only a pending one is decided, by whoever may decide it. The approver it names sees the report and what is on it.',
  },
  expense_rejections: {
    about:
      'Each expense a returned report rejected, with why, once per step and expense: one the review rejected on its own because it differs from its receipt (`automatic`), or one its approver rejected in their words (FR-GOV-10 to FR-GOV-12). Kept with the step that returned it, so each round stays as it was; the latest round’s show on the report and in Needs you until it is submitted again. Its expense’s member’s under the own-records rules, written by the person deciding as a decision allows, never changed, and deleted just before its expense.',
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
    'Fires before every insert, update and delete of a member’s records and what hangs off them, and refuses one the acting member may not change with an error, so the whole transaction, its audit event included, rolls back. Silent for the system (ADR-0035). While a transaction decides a report, it also lets whoever may decide it change that report’s status and times and its expenses’ status, and add its rejections, and nothing else (ADR-0043).',
  app_expense_report:
    'The report an expense is on: its own, as a local expense, or its trip’s. Runs as its owner, so a policy can ask it without the policies of trips calling back into it.',
  app_report_of_expense:
    'The report an expense, by its id, is on, as `app_expense_report` finds it.',
  app_approver_of:
    'Whether the acting member is the approver a step of a report went to; the own-records policies on reports, trips, expenses and receipts show them that report and what is on it. Runs as its owner (ADR-0043).',
  app_deciding_report:
    'The report the current transaction decides, from `app.deciding_report`, which `decideReport()` sets for that transaction only.',
  app_may_decide:
    'Whether the acting member may decide someone else’s report now: it waits on a pending step, they have an approving role, and they are the approver it went to or an owner or finance admin; the database’s twin of `mayDecide()`. Runs as its owner.',
  app_self_attests:
    'Whether the acting member self-attests a report: their own, with an approving role, in an organization of one active member; the database’s twin of the self-attestation in `canApprove()`.',
  app_row_report:
    'The report a row of reports, expenses or expense rejections is on, as a decision sees it.',
  app_decision_change:
    'Whether a change touches only what a decision changes: a report’s status and the times that go with it, or an expense’s status.',
  enforce_approval_steps:
    'Fires before every insert, update and delete of an approval step for a member: only a report’s own member routes it, only a pending step is decided, by whoever may decide its report or a one-person organization’s owner on their own, and a member deletes none. Silent for the system.',
  delete_expense_rejections:
    'Fires before an expense is deleted and deletes its rejections first, while the expense is still there to say whose they are, so its member can delete the receipt that proves it. The foreign key’s cascade stays as a backstop.',
  lock_approved_expenses:
    'Fires before every update of an expense and refuses any change to an approved or settled one but settling it, whoever asks, the system included: an approved claim is corrected by a reversal and a new version (FR-EXP-03, #87).',
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
    'Which organizations have report work due at a moment: a trip or local expense whose time to join a report has come, an open report on its day 28, or one with nothing to claim that has never been through approval. The 24 hours are counted in the organization’s time zone when it keeps one, and at UTC−12 otherwise; it reads the zone whether or not the feature is on, so it may name an organization a few hours early, never late, and the run inside finds nothing due (ADR-0037). The hourly schedule asks it outside any organization; it runs as its owner and answers with organization ids only (ADR-0029).',
  member_for_sign_in_email:
    'Which member signs in with an email address, case aside, and that sign-in’s user, for an arriving email that names no organization yet. Runs as its owner and returns ids only, so the app still can’t read sign-ins outside an organization (ADR-0026).',
  sign_in_has_authenticator:
    'Whether a sign-in, a Supabase Auth user, has a verified second factor such as an authenticator app, read from Supabase Auth’s own `auth.mfa_factors` as it is asked: yes or no, and nothing else of Supabase’s. The API asks it in the query that finds each request’s caller, so the second factor holds every request of someone with one (ADR-0044). Runs as its owner, which can read Supabase’s auth schema, where the app has no right; only the app may call it. No if the id isn’t a UUID, and on plain Postgres, which has no Supabase Auth. Nothing the app writes changes the answer, so removing an authenticator in Supabase takes effect on the next request.',
  person_has_authenticator:
    'Whether the person a sign-in belongs to has a verified second factor on any email they sign in with: this sign-in, or another linked to the same member. Asked beside `sign_in_has_authenticator` in the query that finds each request’s caller, it tells the API that one of a person’s emails still needs its own, so that email is held until it adds one (#88, ADR-0044). Yes or no, and nothing else: not which email has one, or any email. It reads Supabase Auth only through `sign_in_has_authenticator`, and runs as its owner because, before an organization is chosen, the app sees only its own sign-in; only the app may call it. No for a sign-in no member has, and on plain Postgres. Removing a person’s only authenticator in Supabase frees their other emails on the next request.',
  seed_starter_catalog:
    'Gives an organization the ready-made categories and types, and which types each allows, unless it has a category or type already, so running it again adds nothing. Runs as its caller: the release ran it for every organization as the owner, and the app runs it inside `withOrg()` as an organization is created, where row-level security keeps it to that one (ADR-0036).',
  delete_expense_conversion:
    'Fires before an expense is deleted and deletes its conversion first, while the expense is still there to say whose it is, so the `own_records` trigger on `expense_conversions` lets the member who deleted the receipt delete it too (ADR-0034, ADR-0035). Reached through the cascade instead, the expense was already gone and the member’s deletion was refused; added in PR #59. The foreign key’s cascade stays as a backstop.',
  delete_expense_lines:
    'Fires before an expense is deleted and deletes its lines and parts first, while the expense is still there to say whose they are, so the `own_records` trigger on each lets the member who deleted the receipt delete them too (ADR-0041). The foreign keys’ cascade stays as a backstop.',
  reject_audit_mutation:
    'Fires on any UPDATE, DELETE or TRUNCATE of audit_events and refuses it, whoever asks.',
  inbound_email_dismissed_once:
    'Fires before `dismissed_at` of an email changes, and refuses to clear or move a dismissal already made, whoever asks: an email dismissed from Needs you stays dismissed (#59).',
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
      'With a member named for the transaction, a restrictive `own_records` policy shows a member or approver only their own receipts, expenses, trips, reports, emails and saved places, and the readings, confirmations, duplicate pairs, conversions, mileage, routes, receipt lines and split parts that hang off them; owners, finance admins and auditors see everyone’s. An `own_records` trigger refuses any change to another member’s rows, and every change by an auditor, with an error rather than a silent skip. What hangs off an expense is deleted just before it, while it still says whose it is, so a member can delete their own receipt (`delete_expense_conversion`, `delete_expense_lines`, `delete_expense_rejections`). An approver also sees each report routed to them and what is on it (ADR-0043). With no member named, the system’s own work sees and changes everything, as before (ADR-0035).',
    objects: [
      'own_records',
      'app_current_member',
      'app_sees_every_member',
      'app_changes_member',
      'enforce_own_records',
      'delete_expense_conversion',
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
      'expense_itemizations_currency_iso',
      'expense_lines_currency_iso',
      'expense_parts_currency_iso',
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
    rule: 'An expense’s receipt lines are in the receipt’s currency, numbered once, and only an item is left out or split off, for a reason.',
    mechanism:
      'One itemization per expense, by a composite key and deleted with it; each line points at it by its organization, expense and currency, so every line is in the itemization’s currency, and has its own number. A tax, fee or tip line is never excluded or given a category of its own. An excluded line has a reason and when; other needs a note, and a note is at most 200 characters (R-EXCLUSION-NOTE-MAX). Whether lines add up, each item’s share and what the claim comes to are the domain’s (`checkLines`, `lineClaims`, `claimWithout`), under the organization’s write lock.',
    objects: [
      'expense_itemizations_expense_key',
      'expense_itemizations_expense_fk',
      'expense_lines_itemization_fk',
      'expense_lines_position_key',
      'expense_lines_items_only',
      'expense_lines_excluded_whole',
      'expense_lines_other_needs_note',
      'expense_lines_note_length',
      'delete_expense_lines',
    ],
    refs: ['FR-INT-22', 'FR-EXP-16', 'ADR-0041'],
  },
  {
    rule: 'A split expense’s parts are each more than zero, in its own organization’s categories and types.',
    mechanism:
      'Each part points at its expense, category and type by composite keys and is more than zero; a part typed by amount has its own category and type, chosen together, and only a part made of lines may follow the expense’s own. That the parts add up to the claim exactly is the domain’s (`partsByLine`, `partsByAmount`), checked before a split is saved and whenever an exclusion changes the parts.',
    objects: [
      'expense_parts_expense_fk',
      'expense_parts_category_fk',
      'expense_parts_type_fk',
      'expense_parts_amount_positive',
      'expense_parts_classified_whole',
      'expense_parts_amounts_classified',
      'expense_lines_split_whole',
    ],
    refs: ['FR-EXP-15', 'Q35', 'ADR-0041'],
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
    rule: 'A returned report says why, and so does each expense it rejected.',
    mechanism:
      'A returned approval step must carry a comment. A rejection belongs to one step and one expense of the same organization, once per step and expense, with a reason of 1 to 500 characters (R-APPROVAL-NOTE-MAX); it goes with its expense. A reason for claiming less than a receipt is 1 to 500 characters too.',
    objects: [
      'approval_steps_return_needs_comment',
      'approval_steps_org_id_id_key',
      'expense_rejections_step_expense_key',
      'expense_rejections_step_fk',
      'expense_rejections_expense_fk',
      'expense_rejections_reason_length',
      'expenses_claim_reason_length',
      'delete_expense_rejections',
    ],
    refs: ['FR-GOV-02', 'FR-GOV-12', 'FR-EXP-10', 'ADR-0043'],
  },
  {
    rule: 'A member’s chosen approver is someone else in their own organization.',
    mechanism:
      'The approver is a member of the same organization by a composite key, and never the member themselves (`members_manager_not_self`). That they hold a role that may approve, and are still active, is checked when an owner chooses them (`mayChooseApprover`) and again at every submission, where routing passes over one who can’t approve now and finds one as Automatic does (`routeReport`), under the organization’s write lock. A report already submitted keeps the approver its step names.',
    objects: ['members_manager_fk', 'members_manager_not_self', 'members_org_id_id_key'],
    refs: ['FR-GOV-02', 'FR-GOV-03', 'ADR-0043'],
  },
  {
    rule: 'Only whoever may decide a report decides it, and changes nothing of its member’s but its state.',
    mechanism:
      'An approver sees a report a step names them on, with what is on it (`app_approver_of`). Deciding, the transaction names the report it decides; the own-records trigger then lets the approver it went to, or an owner or finance admin, never its own member in a team, change that report’s status and times and its expenses’ status, and add its rejections, while its step is pending, and refuses anything else of its member’s. Only a report’s own member routes it, and a step is decided once (`enforce_approval_steps`). Who it goes to, and that approving someone else’s needs the second factor, are the domain’s and the API’s (`chooseApprover`, `mayDecide`, `requireSecondFactor`).',
    objects: [
      'app_approver_of',
      'app_deciding_report',
      'app_may_decide',
      'app_self_attests',
      'app_decision_change',
      'enforce_approval_steps',
      'enforce_own_records',
    ],
    refs: ['FR-GOV-02', 'FR-GOV-03', 'FR-GOV-01', 'ADR-0043', 'ADR-0035'],
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
    rule: 'An organization changes its rate a mile once per day, to a rate above zero in a currency, or to none for the IRS rate.',
    mechanism:
      'Unique per organization and day; a rate and its currency are present together or not at all, the rate above zero and the currency an ISO code; who set it is a member of the same organization by a composite key. That a drive takes the latest change on or before its date, else the IRS rate, is one rule in the domain (`rateOn`), which every drive is priced through; who may change it, owners and finance admins, is the API’s to check.',
    objects: [
      'org_mileage_rates_org_day_key',
      'org_mileage_rates_rate_and_currency',
      'org_mileage_rates_rate_positive',
      'org_mileage_rates_currency_iso',
      'org_mileage_rates_set_by_fk',
    ],
    refs: ['FR-CAP-03', 'NFR-DAT-04', 'Q28'],
  },
  {
    rule: 'A route drive’s measurement is whole, kept with its drive, and recorded only for the request it was made for.',
    mechanism:
      'One route per organization and drive, pointing at its mileage log by a composite key. Measured exactly when the provider, profile, time, metres and miles are all present; failed exactly when it has a reason; distances never negative, and a reason for other miles 1 to 500 characters. That a measurement is recorded only for the request the route waits for, and that the miles are claimed at the rate on the drive’s date, are the db code’s and the domain’s (`recordRouteMeasurement`, `milesFromMetres`), under the organization’s write lock.',
    objects: [
      'mileage_routes_expense_key',
      'mileage_routes_log_fk',
      'mileage_routes_measured_whole',
      'mileage_routes_problem_when_failed',
      'mileage_routes_distance_nonnegative',
      'mileage_routes_reason_length',
    ],
    refs: ['NFR-DAT-04', 'FR-CAP-04', 'Q33', 'ADR-0039'],
  },
  {
    rule: 'A route drive’s stops are in order, each place once, and a found place is whole.',
    mechanism:
      'One stop per drive and position, 0 to 24, pointing at its route by a composite key; an address of 1 to 200 characters; a label and both coordinates together or none, within the globe; no leg before the start, and none negative. How many stops a drive takes, 25, is the domain’s to check (R-ROUTE-STOPS), and the position range holds it in the database too.',
    objects: [
      'mileage_route_stops_position_key',
      'mileage_route_stops_route_fk',
      'mileage_route_stops_position_range',
      'mileage_route_stops_address_length',
      'mileage_route_stops_place_whole',
      'mileage_route_stops_coordinates_range',
      'mileage_route_stops_leg',
    ],
    refs: ['FR-CAP-04', 'ADR-0039'],
  },
  {
    rule: 'A member keeps a place by a name once, and only their own.',
    mechanism:
      'A unique index over the organization, the member and the name in lower case; the place points at its member by a composite key; a name of 1 to 40 characters and an address of 1 to 200. The own-records policy and trigger keep it to its member.',
    objects: [
      'saved_places_member_name_key',
      'saved_places_member_fk',
      'saved_places_name_length',
      'saved_places_address_length',
    ],
    refs: ['FR-CAP-04', 'ADR-0035'],
  },
  {
    rule: 'An organization has one routing key per provider, and shows only its last four characters.',
    mechanism:
      'Unique per organization and provider; the hint is at most four characters; who last set it points at a member of the organization. Who may set it, and that it is checked with OpenRouteService first, are the API’s to check.',
    objects: [
      'route_service_keys_org_provider_key',
      'route_service_keys_hint_short',
      'route_service_keys_updated_by_fk',
    ],
    refs: ['NFR-SEC-04', 'Q31', 'ADR-0039'],
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
    rule: 'The app learns whether a sign-in has a second factor, and nothing else of Supabase Auth.',
    mechanism:
      'One owner-run function answers yes or no from Supabase Auth’s own record of verified factors, as it is asked; the app holds no right on Supabase’s auth schema, so it can neither read a factor nor change what the answer is, and a session that skipped the code can’t clear it (ADR-0044). The release fails at its migration if the owner can’t read the record, rather than every request.',
    objects: ['sign_in_has_authenticator'],
    refs: ['FR-PLT-03', 'ADR-0044', 'ADR-0013'],
  },
  {
    rule: 'The app learns whether a person has a second factor on any of their emails, and none of their other emails.',
    mechanism:
      'A second owner-run function asks the first of every sign-in of the member a sign-in belongs to and answers yes or no, so an email with none of its own, of a person with one, is held until it adds its own (#88). It adds no right on Supabase’s auth schema, and the app, before an organization is chosen, still sees only its own sign-in (ADR-0044).',
    objects: ['person_has_authenticator', 'own_sign_ins'],
    refs: ['FR-PLT-03', 'FR-PLT-04', 'ADR-0044', 'ADR-0016'],
  },
  {
    rule: 'An email is kept once, and only for a member.',
    mechanism:
      'One row per organization, provider and message id; the workflow derives every id from the message, so a repeat delivery or a retried step files nothing twice. The sender is found through one owner-run function that answers with ids, and the row points at its member by a composite key.',
    objects: ['inbound_emails_message_key', 'member_for_sign_in_email', 'inbound_emails_member_fk'],
    refs: ['ADR-0026', 'NFR-DAT-06'],
  },
  {
    rule: 'An email that filed nothing is dismissed once, by its member, and stays as it arrived.',
    mechanism:
      'The app may update only `dismissed_at`, by a column grant, and never deletes an email. The `own_records` trigger lets only the member it came from set it, and no auditor; another trigger refuses to clear or move a dismissal, and checks keep a dismissal off an email that filed receipts and a sender problem off a proved one. The audit event is written in the same transaction.',
    objects: [
      'inbound_email_dismissed_once',
      'dismissed_once',
      'own_records',
      'inbound_emails_dismissed_unfiled',
      'inbound_emails_problem_unverified',
    ],
    refs: ['FR-CAP-02', 'ADR-0035', '#59'],
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
      'The domain’s lifecycle refuses an edit after submission, and the database refuses any change to an approved or settled expense but settling it, whoever asks. `delete_receipt()` refuses a submitted one. The reversal and new version that correct one are not built yet (GAP-34, #87).',
    objects: ['lock_approved_expenses', 'approved_locked', 'delete_receipt'],
    refs: ['FR-EXP-03', 'ADR-0043'],
  },
];
