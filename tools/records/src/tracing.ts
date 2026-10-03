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
    id: 'GAP-21',
    title:
      'The automated screen checks see only signed-out screens, and their iPhone engine is not iOS Safari.',
    affects: ['NFR-UX-01', 'NFR-UX-02'],
    severity: 'Medium',
    evidence:
      'CI has no signed-in user, so its accessibility and layout checks load each screen’s sign-in prompt, never the forms and lists people use. Its iPhone run is WebKit on Linux, which has no native date picker. On Oct 3 you found From and To overlapping on Trips on your iPhone; a sweep of every signed-in screen then found the same in four more forms, and a colour-contrast failure on receipts whose readings differ.',
    fix: 'A signed-in run in CI: the real API on a test database with a test sign-in, every screen in each state, at phone and desktop widths, in light and dark, with the layout and accessibility checks (#54).',
    backlog: 54,
    closed: {
      date: '2026-10-03',
      note: 'Gate G5 now opens 26 signed-in screens and states, seeded through the real API and reading workflow, in desktop Chromium and iPhone WebKit at 375, 393 and 440 px, light and dark, checking layout and WCAG 2.2 AA (PR #38). Put back, the overlapping date fields and the contrast failure of Oct 3 both fail it. That the engine is not iOS Safari is GAP-22.',
    },
  },
  {
    id: 'GAP-22',
    title: 'No automated check runs on iOS Safari itself.',
    affects: ['NFR-UX-02'],
    severity: 'Low',
    evidence:
      'Gate G5’s iPhone run is WebKit on Linux, which draws form controls its own way. Since PR #38 it fails any date field still drawn natively, the cause of the Oct 3 overlap, but another iOS-only quirk would still reach a phone first.',
    fix: 'Check a changed screen on an iPhone in production right after its release, as the pull request template asks (ADR-0025, Q13), and decide whether a device cloud run is worth its cost (#57).',
    backlog: 57,
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
    closed: {
      date: '2026-10-03',
      note: 'You unticked Preview on both; Vercel now lists `DATABASE_URL` and `SUPABASE_SECRET_KEY` for Production only (read Oct 3, names and targets only). Previews now have no data, which Q13 is about.',
    },
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
    closed: {
      date: '2026-10-03',
      note: 'A reading is Ready only if its subtotal, taxes and tip make the total, a minor unit allowed per tax or tip line, and its date is no more than a day after the upload and no more than a year before it. A reading that fails says which, on the receipt (PR #40).',
    },
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
  {
    id: 'Q7',
    title: 'What a type is, beside a category',
    ask: 'Expenses need categories and types (FR-EXP-11). Which shape? A: one tree. A category such as Travel holds types such as Airfare, Lodging and Taxi; a person picks the type and its category follows. B: two separate choices on every expense, a type for what was bought and a category for where finance books it. C: something else.',
    why: 'It decides what a person picks on each expense, what the reader suggests (#18), what reports and the accountant’s year-end summary total by (FR-INS-03), and where rules attach: meals need attendees, mileage has a rate, some types need a receipt above a limit.',
    recommendation:
      'A. The type says what was bought and carries its rules; the category carries the GL and tax codes and is what summaries total. A person picks one thing, never two, and the reader suggests one thing. Each organization starts from a ready-made set that owners and finance admins can rename, add to or retire.',
    affects: ['FR-EXP-11', 'FR-INT-10', 'FR-INS-03'],
    answer: {
      date: '2026-10-03',
      text: 'Two trees: categories and types are separate lists, and a category filters the types available to choose from (FR-EXP-11).',
    },
  },
  {
    id: 'Q8',
    title: 'What turning an AI model off covers',
    ask: 'Turning AI models on and off (FR-INT-16). 1, who switches: A, each organization in Settings, by owners and finance admins; B, only you, for every organization at once; C, both. 2, with every model off: A, receipts are still filed but not read, and wait in Needs a look to be filled in by hand; B, the last model can’t be turned off. 3, the OpenAI fallback: A, a switch like the others; B, always on while its key is there.',
    why: 'Two Claude models read every receipt today, so each costs twice (ADR-0017). The switch is how the tier decision (#21) takes effect, and how spend stops during an outage or a bad model release without a deploy.',
    recommendation:
      '1C: each organization chooses in Settings, and you keep an operator switch per model, as a flag, for outages. 2A: every model may be off, since a receipt can always be filled in by hand (ADR-0022). 3A: the fallback is a switch like the others, on by default.',
    affects: ['FR-INT-16', 'FR-INT-08', 'FR-INT-09'],
    answer: {
      date: '2026-10-03',
      text: '1C and 2A: each organization switches models in Settings and you keep an operator switch; every model may be off. OpenAI is no longer a fallback but a model like the others, on or off, and any model can be set as primary (FR-INT-16). New Q11: what a model that is on but not primary does.',
    },
  },
  {
    id: 'Q9',
    title: 'Where a receipt’s time and address live',
    ask: 'Time and address from the receipt (FR-INT-17). 1, where: A, on the receipt’s reading and confirmation, the proof, and shown on its expense; B, also on the expense, editable like merchant and date. 2, the address: A, as printed, plus the city and country picked out of it; B, as printed only. 3, the time: A, the local time as printed, with no time zone, as dates are kept; B, a moment in UTC, which needs the time zone of where you were.',
    why: 'The time settles which trip a shared day’s expense belongs to and, later, which meal it was; the city can suggest the trip, and the country the currency. An editable copy on the expense adds a field that review must check against the receipt (FR-GOV-10).',
    recommendation:
      '1A: they are evidence, so they stay with the proof, and a wrong one is corrected on the receipt like any other field. 2A: the printed text keeps the evidence, and the city and country make it useful. 3A: a receipt prints local time and rarely a zone; guessing one would invent data.',
    affects: ['FR-INT-17', 'FR-INT-01'],
    answer: {
      date: '2026-10-03',
      text: 'On the receipt and on the expense; the address as printed, with its city and country (2A); the time as printed, with its time zone worked out from the address where possible, and set by the person where it can’t be, if they want (FR-INT-17).',
    },
  },
  {
    id: 'Q10',
    title: 'Whether an emailed receipt always waits for review',
    ask: 'Email-in (FR-CAP-02): you asked for an emailed receipt or purchase summary to arrive as a pending receipt for review. A: every emailed one waits for you, whatever the reading. B: the same rule as a photo, Ready when the models are sure and Needs a look otherwise. C: B for receipts, A for purchase summaries such as order confirmations.',
    why: 'Most emailed receipts are typed by a system, so they read cleanly; holding each for review adds a touch per receipt, against fewer than one (BO-1). A purchase summary is weaker proof: it shows what was ordered, not always what was charged.',
    recommendation:
      'C. A purchase summary always waits for review, marked as a summary rather than a receipt; a receipt follows the photo rule. Either way, only mail from an address you sign in with is read.',
    affects: ['FR-CAP-02', 'FR-INT-02'],
    answer: {
      date: '2026-10-03',
      text: 'C: a purchase summary always waits for review; a receipt follows the photo rule (FR-CAP-02).',
    },
  },
  {
    id: 'Q11',
    title: 'What a model that is on, but not primary, does',
    ask: 'AI model switches (FR-INT-16), after your answer to Q8: the primary reads every receipt. A model that is on but not primary: A, also reads every receipt, and a receipt is Ready only when it agrees with the primary, as the two Claude models do today; B, reads only when the primary can’t, in an order you set; C, does nothing until it is made primary.',
    why: 'A pays for a second reading of every receipt; B costs nothing until the primary fails, from an outage or no credit, and keeps receipts moving; C is simplest, but a primary outage leaves every receipt for you to fill in.',
    recommendation:
      'B, with A as a setting you turn on while choosing a primary (#21), so the comparison stays available without paying for it every day.',
    affects: ['FR-INT-16', 'FR-INT-02', 'FR-INT-08'],
    answer: {
      date: '2026-10-03',
      text: 'B: exactly one model is primary and reads every receipt; any other model that is on is a back-up, reading only when the primary can’t, in the order set (FR-INT-16). The optional side-by-side comparison suggested alongside B was not part of your answer, so it is not planned.',
    },
  },
  {
    id: 'Q12',
    title: 'How dates are shown',
    ask: 'Screens show dates three ways today: 2026-09-30 on receipts and expenses, 10/3/2026, 1:12 PM for when something was added or checked, and Sep 29 – Oct 1, 2026 on trips. Pick one for showing a date: A, Sep 30, 2026; B, 2026-09-30; C, the phone’s own format (09/30/2026 in the US).',
    why: 'One format reads faster and avoids 10/3 meaning October 3 to you and 10 March to a European colleague. Forms keep the phone’s date picker whatever is chosen, and a model’s reading table keeps the date exactly as read.',
    recommendation:
      'A everywhere a date is shown, with the time as 1:12 PM where one matters: unambiguous in any country, and already how trips read.',
    affects: ['NFR-UX-02', 'NFR-UX-06'],
    answer: {
      date: '2026-10-03',
      text: 'A, as recommended: Sep 30, 2026, with the time as 1:12 PM where one matters, everywhere a date is shown (NFR-UX-06, #55).',
    },
  },
  {
    id: 'Q13',
    title: 'Where to check a changed screen on your iPhone, now previews have no data',
    ask: 'Since #3, a preview build has no database, so a signed-in screen on a preview has nothing on it. The pull request template still asks for a changed screen to be checked on an iPhone through the preview before merging. A: check on production, right after each release. B: build staging next (#30, from P3 to P1): a second free Supabase project with made-up data that previews use. C: drop the iPhone check and rely on CI.',
    why: 'CI’s iPhone run is WebKit on Linux, not iOS Safari (GAP-22), so the iPhone check is what catches an iOS-only fault, as your Oct 3 screenshot did. A finds it after it reaches production; B finds it before. Staging also gives the delivery lifecycle the release candidate environment it describes (delivery §7.3). The Free plan allows two projects, so B costs nothing; it needs about 20 minutes of your setup, and the rest is mine.',
    recommendation: 'B, with A until staging is ready. C would leave GAP-22 with no defence.',
    affects: ['NFR-SEC-13', 'NFR-UX-02', 'GAP-22'],
    answer: {
      date: '2026-10-03',
      text: 'A: a changed screen is checked on an iPhone in production right after its release. No staging environment (ADR-0025).',
    },
  },
  {
    id: 'Q14',
    title: 'Whether an expense on no trip needs you',
    ask: 'The Home dashboard (#28) shows expenses that aren’t on a trip. A: as a figure (“Not on a trip: 3 · $41.75”) that opens them. B: each one goes in Needs you until you put it on a trip or mark it as everyday spend.',
    why: 'Expenses already file to the trip their date falls in (ADR-0023), so one left over is usually everyday spend, like a local lunch or software, that needs no trip. Asking about each would put routine items in the inbox, which DP2 keeps for what really needs you.',
    recommendation:
      'A. If a policy later needs every expense on a trip, that rule can make it B for those organizations.',
    affects: ['FR-INS-01', 'FR-EXP-02'],
    answer: {
      date: '2026-10-03',
      text: 'A: information only, a figure that opens those expenses.',
    },
  },
  {
    id: 'Q15',
    title: 'When incomplete reports join Home',
    ask: 'You asked for incomplete expense reports on Home, and reports don’t exist yet. A: they join when reports are built (#23, P3), and until then Recent trips shows whether each trip’s expenses are all Ready. B: move #23 up, so a trip becomes a draft report 48 hours after it ends and Home shows the ones to finish.',
    why: 'For one person the trip is the report, and a trip whose expenses are all Ready is ready to claim. Reports start to matter when someone else approves them (#24) or an accountant wants them as documents (#25).',
    recommendation: 'A, unless you are reimbursed from reports this quarter.',
    affects: ['FR-INS-01', 'FR-EXP-05'],
    answer: {
      date: '2026-10-03',
      text: 'B: #23 moves up, built third after #28 and #19, and brings reports to finish to Home as part of it.',
    },
  },
  {
    id: 'Q16',
    title: 'Which kind of Bird address you made',
    ask: 'Your address, jpdf7j4q5ukxcliugqji@inbox.ai, is on inbox.ai, not the us1.inbound.bird.com that Bird’s guide gives for a forwarding address. Bird also makes agent mailboxes on inbox.ai. In the Bird dashboard, was it made under Email → Domains → Forwarding, or under Mailboxes? And which event does the webhook listen for?',
    why: 'They arrive differently. A forwarding address raises `email.received` and is read through the inbound-messages API; a mailbox raises `email_mailbox.message_received` and is read through threads. The webhook has to listen for the one that fires, and email-in (#19) reads the matching API.',
    recommendation:
      'Keep whichever it is. If it is a mailbox, set its receive policy to allowlist your sign-in addresses, a second gate before ours, and point the webhook at email_mailbox.message_received.',
    affects: ['FR-CAP-02'],
    answer: {
      date: '2026-10-03',
      text: 'A mailbox, made under Mailboxes; there is no domain of ours, so the address stays on inbox.ai. Its receive policy is now allowlist. Email-in reads it through the mailbox API (ADR-0026).',
    },
  },
];

/** What changed in these records, newest first. */
export const CHANGE_LOG: readonly ChangeLogEntry[] = [
  {
    date: '2026-10-03',
    change:
      'PR #44, at your direction (#19): email or forward a receipt to the Bird mailbox and each PDF or photo attached is filed and read like an upload. Bird’s webhook is checked against its signature; the email is fetched as it arrived, and only a DKIM signature by the sender’s own domain proves who sent it. The address must be one you sign in with; mail from anyone else is dropped with nothing kept. Your answer to Q16: it is a mailbox, with its allowlist on (ADR-0026). FR-CAP-02 and F-16 are Partial until #58 reads the body itself and purchase summaries, which comes before #23.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #43, at your direction (#28): Home is a dashboard beneath Needs you. It shows the trip under way, with its day and spend so far and Add a receipt, or the next within 14 days; this month’s spend, trips, expenses on no trip and how many are Ready; receipts being read; and the last three trips, each with whether all its expenses are Ready. Every figure opens the list behind it, and only your own records count. Your answers: Q14 A, so expenses on no trip are information only; Q15 B, so #23 moves up and brings reports to finish to Home. The order is #28, #19, #23. Your Bird setup is done; Q16 asks which kind of address it is.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'Your answers: Q13 A, so there is no staging environment (ADR-0025, #30) and a changed screen is checked on an iPhone in production after its release; #7’s limits stand; any model that is on can be made primary at any time (#52). Bird signs its webhooks to the Standard Webhooks scheme, which settles how email-in verifies them (#19). Your new requirement: Home becomes a dashboard beneath Needs you, with the current trip, recent trips, this month’s figures, expenses on no trip and, once reports exist, reports to finish (FR-INS-01, #28 now P1). Q14 and Q15 ask how two of its items behave.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #41, at your direction (#9): Home is the Needs you inbox, with real items. Each receipt that needs a look or couldn’t be read is listed, newest first, with why and one action: Check it, Fill it in, or Open settings when a key is the problem. With nothing to do, it says so. F-10 is Verified; FR-EXP-02 is Partial until returned reports (#24) and missing receipts (with card transactions) join it.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #40, at your direction (#7): a receipt is Ready only when its sums and date are plausible, as well as read with confidence and agreed. The subtotal, taxes and tip must make the total, a cent allowed per tax or tip line; prices that include VAT add up too. The date may be a day after the upload and no more than a year before it. A receipt that fails says why, such as “$45.50 + $4.43 tax doesn’t come to the $58.43 total.” GAP-04 is closed and FR-INT-04 Verified. Receipts read before today keep their status.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'You unticked Preview on `DATABASE_URL` and `SUPABASE_SECRET_KEY`, and Vercel now holds both for Production only, so #3 is done, GAP-02 closed and NFR-SEC-13 Implemented. Previews now show no data, so Q13 asks where you check a changed screen on your iPhone; I recommend building staging next (#30). Email-in moves from Postmark to Bird at your direction (ADR-0024, #19). Bird doesn’t report DMARC and its receiving guide doesn’t say how webhooks are signed, so we check the sender’s DKIM alignment ourselves and confirm the signing before building.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #38, at your direction (#54): gate G5 checks every signed-in screen. A bench runs the real API on its own database, seeded through the real reading workflow, and 26 screens and states are opened in desktop Chromium and iPhone WebKit at 375 to 440 px, in light and dark, for layout and WCAG 2.2 AA. Put back, the date overlap and contrast failure you found both fail it. GAP-21 is closed and NFR-UX-01 Verified; NFR-UX-02 stays Partial because the engine isn’t iOS Safari (GAP-22, #57). Found on the way: the tab bar could hide a focused link, so focus now stops above it (WCAG 2.4.11).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'At your request the restore drill ran on production’s backup and passed: the dump 22 minutes old, all 50 tables (137 rows), migrations, schema, row-level security, isolation and all 6 receipt images, in 1 min 11 s. #10 is done; F-41 and NFR-REL-02 are Verified. The restore again gave Supabase’s Data API roles 60 tables and functions, which the release now takes back. NFR-REL-03 stays Partial until a whole recovery is timed (new #56).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your answers to Q11 and Q12: exactly one AI model is primary and reads every receipt, and any other model that is on is a back-up for when it can’t (FR-INT-16; #52 can start). With one reading per receipt, Ready rests on the primary’s confident reading rather than on two models agreeing, so the running comparison ends with #52 (FR-INT-02, FR-INT-08). Dates show as Sep 30, 2026 everywhere (new NFR-UX-06, #55).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #36, from your iPhone screenshot: date fields no longer run over each other on iOS, in the five forms that put two side by side (Trips search, new and edited trips, Expenses search, and a receipt’s Edit a field). A sweep of every signed-in screen then fixed more: the tab bar is on every screen, as the design has it, not only Home; small links have 44-point touch areas; the “differs” note on a receipt meets AA contrast; and two text slips. Found on the way: CI checks only signed-out screens, which is how this reached you (GAP-21, #54), so NFR-UX-01 and NFR-UX-02 are Partial until it checks signed-in ones.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #35: the monthly restore drill (F-41; NFR-REL-02 and NFR-REL-03 Partial until it passes on production’s backup, #10). Its first rehearsals found three things that would have broken a real recovery, all fixed: a restore needs Supabase’s auth and storage services, not the bare database image; the dump repeats a grant and empty tables that a new project’s postgres role may not restore, so a new step prepares the files (the runbook uses it too); and a restore quietly hands Supabase’s Data API roles every table and function again, so every release now takes those grants back (NFR-SEC-03).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your answers to Q7–Q10: categories and types are two trees, the category filtering the types (FR-EXP-11; #51 can start). Any AI model can be primary, and OpenAI is no longer a fallback (FR-INT-16; new Q11 on what the other models that are on do). Time and address go on the receipt and the expense, with a time zone from the address or set by you (FR-INT-17; #53 can start). A purchase summary always waits for review (FR-CAP-02).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your messages: a reading also captures the time of purchase and the merchant’s address, either of which may be blank (FR-INT-17, F-46, #53; Q9 on where they live). Email-in now takes any receipt or purchase summary, not only travel emails, and reads only mail from your own addresses (FR-CAP-02, #19; Q10 on whether each waits for review).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your message: owners and finance admins turn each AI model on or off for their organization (FR-INT-16, F-45, #52). New Q8: who switches, what happens with every model off, and whether the OpenAI fallback has a switch. The tier decision (#21) takes effect through it.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your message: the technical architecture and the data model are living pages, revised with every change and confirmed in every report (NFR-DEL-08). PR #32 builds both (F-44): read from the repository and from a snapshot of the migrated database that the integration tests keep current, with a written half the tests hold to completeness, and a "changed in this release" box on each.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'From your message: an organization defines its own expense categories and types, and every expense has a type (FR-EXP-11, F-43, #51). New Q7: what a type is beside a category. Category suggestions (#18) now wait on #51, since they suggest from what an organization defines.',
    by: 'Claude, at your direction',
  },
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
