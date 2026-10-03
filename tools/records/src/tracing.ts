import type { ChangeLogEntry, Gap, Question } from './model.ts';

/**
 * Where the code falls short of a requirement, found while tracing. Each gap has a backlog
 * item that closes it; an open gap has an open item and a closed gap a done one.
 */
export const GAPS: readonly Gap[] = [
  {
    id: 'GAP-01',
    title:
      'Real receipts are stored in production, and nothing backs them up. Supabase’s Free plan keeps no backups of its own.',
    affects: ['NFR-REL-01', 'NFR-REL-02', 'NFR-REL-03', 'NFR-REL-05', 'BO-4'],
    severity: 'High',
    evidence:
      'ADR-0014 and the roadmap make the nightly backup a precondition of real use; real receipts have been captured since Oct 2. The backup was built in PR #23 (#1) and needed its storage and secrets (#2).',
    fix: 'Set up its storage and secrets and run it once (#2), then restore it (#10).',
    backlog: 2,
    closed: {
      date: '2026-10-03',
      note: 'The backup ran for real on Oct 3: 51 tables and the one receipt image, encrypted in Backblaze B2, and the uploaded copy decrypted back to the same dump. It runs every night. Restoring it is #10.',
    },
  },
  {
    id: 'GAP-18',
    title: 'The backup’s own key can delete the backups once their 30-day Object Lock has passed.',
    affects: ['NFR-REL-01', 'F-37'],
    severity: 'Medium',
    evidence:
      'Runbook section 5 creates a Read and Write Backblaze key, which includes deleting. Object Lock protects each file for its first 30 days only. After that, a leaked key could erase the monthly dumps and every older receipt image, which ADR-0014 says are never deleted from the copy.',
    fix: 'A key that can list, read and write but not delete (#48).',
    backlog: 48,
  },
  {
    id: 'GAP-20',
    title:
      'Within an organization, any member can see and change every member’s receipts, expenses and trips.',
    affects: ['FR-GOV-01'],
    severity: 'Medium',
    evidence:
      'Row-level security keeps organizations apart, but inside one the API checks only that the caller is a member. Found while building trips (#16), which follow the same rule as expenses. Harmless while every organization has one person; the first invite (#29) would show a new member their colleagues’ spending.',
    fix: 'A member sees and changes their own; an approver sees what they approve; finance admins see everything, and auditors read it. Enforced in the API, with a test for each role, before anyone is invited (#50).',
    backlog: 50,
  },
  {
    id: 'GAP-19',
    title:
      'The dependency audit lets one high advisory through: braces (GHSA-vfj7-8cjw-p6xm), which has no fixed version yet.',
    affects: ['NFR-SEC-12'],
    severity: 'Low',
    evidence:
      'Published on Oct 3 and failed G4 on every branch. braces reaches us only through lint tooling (eslint-config-next, a dev dependency), never the deployed app, and expands only globs written in this repository. No release of braces, micromatch or Next’s lint plugin avoids it yet.',
    fix: 'Ignored in pnpm-workspace.yaml at your direction on Oct 3. Advisory watch checks every Monday and fails once a fix exists; then update and remove the ignore (#49).',
    backlog: 49,
  },
  {
    id: 'GAP-02',
    title:
      'Preview builds hold production credentials: `DATABASE_URL` and `SUPABASE_SECRET_KEY` are set for Preview as well as Production.',
    affects: ['NFR-SEC-13', 'NFR-SEC-01'],
    severity: 'High',
    evidence:
      'Vercel environment variables, read Oct 2 (names and targets only). Every branch push builds unreviewed code that can read production data and every stored receipt.',
    fix: 'Untick Preview on both. Previews then have no database until staging exists (#30); CI tests against its own Postgres, so nothing is lost.',
    backlog: 3,
  },
  {
    id: 'GAP-03',
    title:
      'Sign-in has no second factor. Increment 1 planned TOTP, and approvals need it for step-up.',
    affects: ['FR-PLT-03', 'FR-GOV-04'],
    severity: 'High',
    evidence:
      'The API reads the session’s assurance level (`aal1` or `aal2`), but nothing enrolls a factor or asks for one.',
    fix: 'TOTP enrollment and challenge on the sign-in page; require `aal2` where approvals and admin actions need it (#8).',
    backlog: 8,
  },
  {
    id: 'GAP-04',
    title:
      'A reading can be Ready although its parts don’t add up to the total or its date is in the future.',
    affects: ['FR-INT-04'],
    severity: 'Medium',
    evidence:
      '`isAutoReady()` checks confidence and unreadable values only; normalization checks the date’s format, not its plausibility. Two agreeing models make a silent error less likely, not impossible.',
    fix: 'Add reconciliation (subtotal + taxes + tip against the total, with a tolerance for rounding) and a date window to the Ready rule (#7).',
    backlog: 7,
  },
  {
    id: 'GAP-05',
    title:
      'The outbox relay isn’t running, so a receipt whose eager send fails waits until someone presses Read again.',
    affects: ['NFR-DAT-07', 'F-33'],
    severity: 'Medium',
    evidence:
      '`RELAY_DATABASE_URL` is not set in Vercel (read Oct 2), and the relay is registered only when it is (ADR-0017 §5).',
    fix: 'Add `RELAY_DATABASE_URL` for Production (#11).',
    backlog: 11,
  },
  {
    id: 'GAP-06',
    title:
      'Nothing finds a receipt stuck in Reading. The SLO promises every receipt reaches a status, checked hourly.',
    affects: ['NFR-DAT-07', 'F-33'],
    severity: 'Medium',
    evidence:
      'No reconciliation job among the workflow functions; the SLO table in delivery §7.7 names one.',
    fix: 'An hourly workflow that settles or re-reads receipts left in Reading too long, and reports them (#12).',
    backlog: 12,
  },
  {
    id: 'GAP-07',
    title: 'Errors go nowhere anyone looks: error tracking is built but has no destination.',
    affects: ['NFR-OPS-01', 'F-32'],
    severity: 'Medium',
    evidence:
      '`NEXT_PUBLIC_SENTRY_DSN` is not set in Vercel (read Oct 2), so Sentry stays off. Failures reach only Vercel’s short-lived logs.',
    fix: 'Create a Sentry project and add its DSN (#13).',
    backlog: 13,
  },
  {
    id: 'GAP-08',
    title: 'Nothing outside the app notices when production is down.',
    affects: ['NFR-REL-04'],
    severity: 'Medium',
    evidence:
      'The readiness endpoint exists and is tested, but no external check calls it, so availability is never measured.',
    fix: 'A scheduled GitHub Actions check of `/api/v1/health/ready` every 15 minutes; GitHub emails on failure, with no new account (#14).',
    backlog: 14,
  },
  {
    id: 'GAP-09',
    title:
      'The release script has no test, though it decides what goes live and refuses to roll production back.',
    affects: ['NFR-DEL-03', 'NFR-REL-07', 'F-36'],
    severity: 'Medium',
    evidence:
      '`.github/scripts/promote-production.mjs` was exercised by hand before PR #17; no test runs in CI.',
    fix: 'Commit its test harness with stand-in Vercel and GitHub answers, and run it in G2 (#15).',
    backlog: 15,
  },
  {
    id: 'GAP-10',
    title:
      'The app could hard-delete expenses, reports and receipts: only the audit log is protected.',
    affects: ['NFR-DAT-05'],
    severity: 'Medium',
    evidence:
      'Migration 0001 grants DELETE on every tenant table to `expensewise_app`; the append-only trigger covers `audit_events` alone.',
    fix: 'Revoke DELETE on financial tables (or add a trigger that refuses it), with a test (#33).',
    backlog: 33,
  },
  {
    id: 'GAP-11',
    title:
      'A breaking API change would pass CI: G3 checks that the contract matches the code, not that it stays compatible.',
    affects: ['NFR-ARC-04', 'NFR-DEL-01', 'F-35'],
    severity: 'Low',
    evidence:
      '`contract:check` compares `openapi.json` with the code. G3 as written also names a breaking-change diff and migrations on a copy.',
    fix: 'Diff the contract against `main` in G3 and fail on a breaking change without a new version (#34).',
    backlog: 34,
  },
  {
    id: 'GAP-12',
    title: 'Seven-year retention with legal hold, promised for Phase 0, has no design.',
    affects: ['NFR-PRV-01'],
    severity: 'Medium',
    evidence:
      'Vision C5 puts retention in Phase 0; no ADR, table or job implements it. Nothing is deleted today, so nothing is lost yet.',
    fix: 'Your answer to Q2, then an ADR and the retention fields (#35).',
    backlog: 35,
  },
  {
    id: 'GAP-13',
    title: 'Subprocessor agreements are unconfirmed.',
    affects: ['NFR-PRV-04'],
    severity: 'Medium',
    evidence:
      'ADR-0010 requires a data processing agreement with every subprocessor. Receipts reach Supabase, Vercel, Inngest and Anthropic, and OpenAI on the fallback path (ADR-0020).',
    fix: 'Your answer to Q3 (#36).',
    backlog: 36,
  },
  {
    id: 'GAP-14',
    title: 'A field doesn’t show the receipt text it came from, and can’t be corrected with a tap.',
    affects: ['FR-INT-11'],
    severity: 'Low',
    evidence:
      'The receipt page shows each model’s values with their confidence and the original image; the schema asks for no source text. Since #47 a reading that needs a look can be corrected, but a Ready one can’t.',
    fix: 'Ask the model for each field’s source line and highlight it, and correct any field with a tap, as a reversal once it is an expense (#37).',
    backlog: 37,
  },
  {
    id: 'GAP-17',
    title:
      'A receipt that needs a look is a dead end: the page offers no way to confirm or correct it.',
    affects: ['FR-INT-15', 'FR-INT-11'],
    severity: 'Medium',
    evidence:
      'Reported by the product owner on Oct 2. The receipt page’s only action is Read again; the receipt review design (design §5.3) has Looks right and Edit a field. Every fallback reading lands in Needs a look (ADR-0020).',
    fix: 'Build both actions; either makes the receipt Ready, with an audit event (#47).',
    backlog: 47,
    closed: {
      date: '2026-10-03',
      note: 'Looks right and Edit a field are on the receipt page (F-40, ADR-0021): either makes the receipt Ready, records who did it in the audit trail, and keeps each correction beside what the model read.',
    },
  },
  {
    id: 'GAP-15',
    title: 'Nothing proves the model is called without tools.',
    affects: ['NFR-SEC-07'],
    severity: 'Low',
    evidence: 'The Claude extractor passes no tools today, but no test fails if one is added.',
    fix: 'Assert in the extractor tests that no tools are sent (#38).',
    backlog: 38,
  },
  {
    id: 'GAP-16',
    title: 'Capture to Ready isn’t measured end to end.',
    affects: ['NFR-PERF-01'],
    severity: 'Low',
    evidence:
      'Each reading stores its own latency; nothing records the time from filing to settlement.',
    fix: 'Record it at settlement and show the p95 beside the comparison (#32).',
    backlog: 32,
  },
];

/** Decisions only the product owner can make. Each confirms a requirement or closes a gap. */
export const QUESTIONS: readonly Question[] = [
  {
    id: 'Q1',
    title: 'Real receipts before backups',
    ask: 'Keep capturing real receipts while the backup is built, or pause until the first backup has been restored?',
    why: 'The roadmap made the backup a precondition of real use (D-14, ADR-0014), and real receipts are in production. Since Oct 3 a copy goes off-site every night (GAP-01 closed), but none has been restored yet (#10).',
    recommendation:
      'Keep capturing, and keep every original (paper or email) until #10 passes. The backup is about a day of work plus your 20-minute setup.',
    affects: ['GAP-01', 'NFR-REL-01'],
  },
  {
    id: 'Q2',
    title: 'Retention',
    ask: 'Is seven years the default, configurable per organization, with legal hold? And must it exist before the Phase 1 exit, or before a second organization?',
    why: 'Vision C5 promised retention in Phase 0. Nothing deletes data today, so the risk is keeping too much, not losing it.',
    recommendation:
      'Seven years, built before a second organization stores data. Until then, nothing is deleted.',
    affects: ['NFR-PRV-01', 'GAP-12'],
  },
  {
    id: 'Q3',
    title: 'Subprocessor terms',
    ask: 'ADR-0010 asks for a data processing agreement with every subprocessor. For Phase 1, do the standard terms of your own Supabase, Vercel, Inngest, Anthropic and OpenAI accounts satisfy it?',
    why: 'Receipts are personal data and tax evidence. Each of these vendors sees them.',
    recommendation:
      'Yes for Phase 1, while the only data is yours; sign each vendor’s DPA before a second person’s data arrives.',
    affects: ['NFR-PRV-04', 'GAP-13'],
  },
  {
    id: 'Q4',
    title: 'Outcome measures while you are the only user',
    ask: 'Touches per expense and minutes per trip apply to you now. Submit-to-reimbursed doesn’t, while you approve your own reports. Measure it from the first second member, or drop it until Phase 2?',
    why: 'BO-3’s measure needs a baseline in Phase 1, and a solo organization reimburses itself.',
    recommendation:
      'Measure the first two from increment 2; start BO-3’s baseline with the pilot team.',
    affects: ['BO-1', 'BO-2', 'BO-3'],
  },
  {
    id: 'Q5',
    title: 'Shipping without flags',
    ask: 'AP8 says every capability ships dark behind a flag. ADR-0017 shipped the receipt pages unflagged because you are the only user. Keep that exception until a second member joins?',
    why: 'Flags cost a little on every change; they matter once someone else would see an unfinished feature.',
    recommendation: 'Yes, and flag everything again from the first invite (#29).',
    affects: ['NFR-DEL-05'],
  },
  {
    id: 'Q6',
    title: 'What counts as matching the receipt',
    ask: 'Checking an expense against its receipt (FR-GOV-10): must the amount equal the receipt’s total, or may a person claim less with a reason, such as a hotel bill with a personal minibar charge, or one receipt split across several expenses? And should a mismatch be caught while editing and before submission, or only at review?',
    why: 'An exact rule rejects honest partial claims; a loose one lets over-claims through. A rejection at review costs a full round trip, which catching it before submission avoids; the approval flow already checks receipts on submit (journeys §4.4).',
    recommendation:
      'Merchant (loosely), date and currency must match. The amount may be lower than the receipt’s only with a reason, never higher, and expenses split from one receipt may not add up to more than it. Show a mismatch as soon as the expense is edited, refuse to submit one without a reason, and let review return the whole report for any mismatch it finds.',
    affects: ['FR-GOV-10', 'FR-EXP-09', 'FR-EXP-10', 'FR-GOV-13'],
    answer: {
      date: '2026-10-03',
      text: '1B and 2B, as recommended. An expense may claim less than its receipt with a reason, never more (FR-EXP-10). A difference shows as soon as the expense is edited, and a report can’t be submitted while one has no reason (FR-GOV-13); review still returns the whole report for any mismatch.',
    },
  },
];

/** What changed in these records, newest first. */
export const CHANGE_LOG: readonly ChangeLogEntry[] = [
  {
    date: '2026-10-03',
    change:
      'PR #30: trips, trip history and search (F-12, ADR-0023, D-25). Expenses file to the trip their date falls in, and a person can choose another trip or none. #16 is done, so #23 is open; FR-EXP-01, FR-EXP-04 and FR-INS-02 are Verified. Found on the way: any member can change any other member’s records (GAP-20, #50), to fix before the first invite. One change from what Claude first told you: on a day two trips share, the trip that ends first keeps it, because that day’s hotel bill belongs to it.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your answer to Q6 (1B, 2B): an expense may claim less than its receipt with a reason, never more (FR-EXP-10), and a report can’t be submitted while a difference has no reason (FR-GOV-13). Both join #24, now effort L. The difference already shows when an expense is edited (F-09).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #28: every receipt has an expense from capture, linked as its proof, and the expense can be edited (F-09, ADR-0022, D-24). #6 is done; FR-EXP-08 and FR-EXP-09 are Verified; FR-EXP-01 is Partial until expenses file to trips (#16). An edited expense that differs from its receipt says so; enforcing that at review is #24 (Q6).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your message: the receipt stays linked to its expense as proof (FR-EXP-08), and an expense can be edited once it exists (FR-EXP-09), both with #6. At review, an expense that doesn’t match its receipt is rejected (FR-GOV-10), one rejected expense returns the whole report (FR-GOV-11), and rejected expenses are surfaced for remediation (FR-GOV-12), with #24 and #9. New Q6: what counts as matching.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #26: Looks right and Edit a field (F-40, ADR-0021, D-23). A receipt that needs a look can now be made Ready, so #47 is done, GAP-17 closed and FR-INT-15 Verified. Corrections are kept beside what the model read, in a new append-only table under row-level security; FR-INT-11 stays Partial (source text, GAP-14).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your decision: braces’ new high advisory (GHSA-vfj7-8cjw-p6xm), which has no fix and reaches us only through lint tooling, is ignored by the audit, so G4 passes again. NFR-SEC-12 is Partial (GAP-19, #49), and a weekly Advisory watch fails once a fix exists.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your message: your copy of the backup passphrase decrypts the first backup, production has one receipt image as the backup counted, and GitHub’s failure email reached you (F-37, F-42). Your focus is #47, #16, then #10; #16 rises to P1 and needs #6 first. #4 drops to P3 and Medium severity, and #21, which waits on it, to P3.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your setup: the nightly backup ran for real (51 tables, 1 receipt image), so #2 is done and GAP-01 closed. The heartbeat and quota alerts are now their own feature, F-42, so NFR-REL-05 is Verified; the heartbeat is written first, so a Backblaze outage can’t stop it. F-37 and NFR-REL-01 stay Partial: no restore yet (#10), and the job’s key can delete after the 30-day lock (new GAP-18, #48).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-02',
    change:
      'PR #23: the nightly encrypted backup to Backblaze B2, with the heartbeat and quota alerts (F-37, #1 done). Rehearsed against a stand-in, including a full restore. NFR-REL-01 and NFR-REL-05 are Partial until its secrets are set and it runs (#2); GAP-01 now closes with #2. The restore drill is its own feature, F-41 (#10).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-02',
    change:
      'From your message: the fallback read a real receipt, so #46 is done and FR-INT-09 and F-08 are Verified. New FR-INT-14: tax and tip the receipt doesn’t print count as $0, built in this change. New FR-INT-15 and GAP-17: a receipt that needs a look must offer a next step (#47, P1).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-02',
    change:
      'PR #21 merged and released (0d52203): the records and both pages are live, published after the release. The backlog page is published for the first time.',
    by: 'Claude, after the release',
  },
  {
    date: '2026-10-02',
    change:
      'PR #20 merged: GPT-5.6 Luna reads a receipt when no Claude model can (F-08, ADR-0020). FR-INT-09 and F-08 are Partial until a real receipt shows OpenAI accepts the request (#46). Backlog #5 done.',
    by: 'Claude, after the merge',
  },
  {
    date: '2026-10-02',
    change:
      'First version: 8 objectives, 56 functional and 59 non-functional requirements, 39 features, 16 gaps found while tracing (GAP-01 to GAP-16) and five questions. The backlog moves from the conversation to its own page (39 open items, 6 done), republished after each successful release. The Definition of Done now includes these records.',
    by: 'Claude, from the repository at 840fcac, at your request',
  },
];
