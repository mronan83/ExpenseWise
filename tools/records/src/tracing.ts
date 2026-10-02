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
      'No backup workflow in `.github/workflows/`. ADR-0014 and the roadmap make the nightly backup a precondition of real use; real receipts have been captured since Oct 2.',
    fix: 'Build the nightly encrypted backup to Backblaze B2 (#1), set up its storage and secrets (#2), then restore it once (#10).',
    backlog: 1,
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
      'ADR-0010 requires a data processing agreement with every subprocessor. Receipts reach Supabase, Vercel, Inngest and Anthropic today, and OpenAI once PR #20 merges.',
    fix: 'Your answer to Q3 (#36).',
    backlog: 36,
  },
  {
    id: 'GAP-14',
    title: 'A field doesn’t show the receipt text it came from, and can’t be corrected with a tap.',
    affects: ['FR-INT-11'],
    severity: 'Low',
    evidence:
      'The receipt page shows each model’s values with their confidence and the original image; the schema asks for no source text.',
    fix: 'Ask the model for each field’s source line; highlight it; let a tap correct the value and keep the correction (#37).',
    backlog: 37,
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
    why: 'The roadmap made the backup a precondition of real use (D-14, ADR-0014), and real receipts are already in production with no copy anywhere (GAP-01).',
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
];

/** What changed in these records, newest first. */
export const CHANGE_LOG: readonly ChangeLogEntry[] = [
  {
    date: '2026-10-02',
    change:
      'First version: 8 objectives, 56 functional and 59 non-functional requirements, 39 features, 16 gaps found while tracing (GAP-01 to GAP-16) and five questions. The backlog moves from the conversation to its own page (39 open items, 6 done), republished after each successful release. The Definition of Done now includes these records.',
    by: 'Claude, from the repository at 840fcac, at your request',
  },
];
