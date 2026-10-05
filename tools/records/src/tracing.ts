import type { ChangeLogEntry, Gap, Question } from './model.ts';

/**
 * Where the code falls short of a requirement, found while tracing. Each gap has a backlog
 * item that closes it; an open gap has an open item and a closed gap a done one.
 */
export const GAPS: readonly Gap[] = [
  {
    id: 'GAP-27',
    title: 'Renaming a category or type changes the name on old claims.',
    affects: ['NFR-DAT-04', 'FR-EXP-11', 'F-43'],
    severity: 'Low',
    evidence:
      'Found merging PR #58: an expense points at its category and type (ADR-0036) and copies neither name, so renaming one shows the new name on every claim that used it, submitted or exported ones included. One in use can be retired but never deleted, so nothing is lost, but an old claim no longer reads as it did.',
    fix: 'Copy the category and type names onto an expense when its report is submitted, as the mileage and FX rates are copied, and show those on submitted claims and exports (#70).',
    backlog: 70,
    closed: {
      date: '2026-10-05',
      note: 'PR #60, with approval (#24): submitting a report copies each expense’s category and type names onto it, and its parts’, and its export and totals by category read those once it is submitted (#70).',
    },
  },
  {
    id: 'GAP-28',
    title: 'No rule hangs off a type yet.',
    affects: ['FR-EXP-11', 'F-43'],
    severity: 'Low',
    evidence:
      'Built in PR #58 behind `expenses.categories`: an expense without a category and type says so on its page and in the list, and since PR #59 in Needs you too (#71); by your answer to Q27 it holds nothing up, so nothing refuses one. Types carry no rules yet, because attendees and a receipt needed above a limit are not built as rules; the mileage rate is the organization’s, by your answer to Q28.',
    fix: 'Attach each rule to the type as it is built (#78).',
    backlog: 78,
  },
  {
    id: 'GAP-29',
    title: 'Nothing asks to re-confirm the AI model after about 100 real receipts.',
    affects: ['NFR-AI-04'],
    severity: 'Low',
    evidence:
      'Found building AI model settings (#52). NFR-AI-04 asks for the model tier to be re-confirmed after about 100 real receipts. The primary is now your choice in Settings › AI models, with each model’s record beside it, but nothing counts the receipts read since the choice or asks you to look again.',
    fix: 'Count the receipts read since the primary was last chosen, and at about 100 ask in Needs you to keep it or change it (#72).',
    backlog: 72,
    closed: {
      date: '2026-10-05',
      note: 'Withdrawn at your word (Oct 5): no reminder to re-confirm the model. Each model’s record stays beside it in Settings › AI models for whenever you look (#72).',
    },
  },
  {
    id: 'GAP-30',
    title: 'Home doesn’t show business miles, though mileage exists.',
    affects: ['FR-INS-01', 'F-22'],
    severity: 'Low',
    evidence:
      'FR-INS-01 asks Home for business miles once mileage exists, and manual mileage was built in PR #58 (#17). Home’s request has no flag check of its own yet, so the figure was left out of that change rather than shown while mileage is switched off. A drive does count in Home’s spend for the month, as any expense does.',
    fix: 'Sum the person’s drives dated this month and show the figure on Home behind the expenses.mileage flag (#73).',
    backlog: 73,
    closed: {
      date: '2026-10-05',
      note: 'Home’s month shows Business miles while mileage is on: the person’s own drives dated this month, by hand and by route once measured, added up exactly, opening the month’s expenses (#73). What awaits reimbursement is #89.',
    },
  },
  {
    id: 'GAP-31',
    title:
      'Inside an organization, the audit trail and the outbox are kept to the organization, not to each member.',
    affects: ['FR-GOV-01'],
    severity: 'Low',
    evidence:
      'Found building #50 (ADR-0035). Members see only their own receipts, expenses, trips and reports, but every member’s transaction can read the organization’s whole audit trail, which it reads to chain the next event, and its outbox. No screen or API operation shows either to a member, so nothing reaches one through the app; a screen that read them would show colleagues’ merchants and amounts.',
    fix: 'Hold reading the trail to owners, finance admins and auditors, with the chain’s last link read by an owner-run function, and the outbox to the system (#74).',
    backlog: 74,
  },
  {
    id: 'GAP-32',
    title: 'The eval harness has never been run against a model.',
    affects: ['NFR-AI-01', 'NFR-AI-04'],
    severity: 'Low',
    evidence:
      'Found closing #39 and #72 on Oct 5. The harness scores public and synthetic receipts, but no model key has reached the build environment, so it has never read one: accuracy by layer is unmeasured, and the tier is chosen from your own receipts compared on the page instead (ADR-0017).',
    fix: 'Run the eval set against the models with your approval of the spend, estimated before it starts, and report accuracy by layer (#84).',
    backlog: 84,
  },
  {
    id: 'GAP-33',
    title:
      'A session that skipped the second factor can still use the API, short of admin actions.',
    affects: ['FR-PLT-03', 'F-11'],
    severity: 'Medium',
    evidence:
      'Found building #8 on Oct 5. The app asks for the code before anything else, but the API refuses aal1 only for admin actions and approving (FR-GOV-04), because a token doesn’t say whether its person has an authenticator. A stolen password, used against the API directly, still reads that person’s records (all of them, for an owner or finance admin), changes their own, and can link another sign-in that has no authenticator.',
    fix: 'Refuse aal1 on every request of someone with a verified authenticator while the organization has the second factor on, and require aal2 to link a sign-in (#85, Q41).',
    backlog: 85,
    closed: {
      date: '2026-10-05',
      note: 'ADR-0044: while the second factor is on, a session of someone whose sign-in has a verified authenticator gets nothing from the API until it passes the code, but who they are and the organization’s switches, checked once as each request finds its caller; linking a sign-in needs the code from anyone with an authenticator, whatever the switch. The API reads Supabase Auth’s own record of factors through one function, so removing one takes effect at once. A person’s other email with no authenticator of its own is GAP-35.',
    },
  },
  {
    id: 'GAP-34',
    title: 'An approved expense can’t be corrected.',
    affects: ['FR-EXP-03', 'F-18'],
    severity: 'Medium',
    evidence:
      'Found building approval (#24) in PR #60. An approved expense is locked, in the app and in the database, as FR-EXP-03 asks, but nothing makes the reversal and new version that correct one; the expense keeps a version and a reversal link that nothing writes yet.',
    fix: 'Reverse an approved expense with a copy that cancels it, pointing at it, and file a new version for its member to correct and submit, each in the audit trail (#87).',
    backlog: 87,
  },
  {
    id: 'GAP-35',
    title: 'A person’s other email with no authenticator of its own still opens on its password.',
    affects: ['FR-PLT-03', 'FR-PLT-04', 'F-11'],
    severity: 'Low',
    evidence:
      'Found building #85 on Oct 5. Each email a person signs in with is its own Supabase Auth user with its own authenticators, and the second factor holds each sign-in by its own (ADR-0044), as the code screen does. Linking one now needs the code from someone with an authenticator, but the email linked, or linked before, has none until its person adds one, and opens everything on its password alone.',
    fix: 'Once a person has an authenticator on any of their sign-ins, hold every other sign-in of theirs that has none until it adds one and passes it, with the app saying which email needs one (#88, Q43).',
    backlog: 88,
    closed: {
      date: '2026-10-05',
      note: 'ADR-0044, at your answer to Q43: while the second factor is on, a session of an email with no authenticator of its own, of a person with one on another of their emails, gets nothing from the API but who they are and the switches, whatever its session says: 403 `authenticator_required`, naming the email, until it adds its own and enters its code. The app says which email needs one, never asks it for a code, and sends it to Settings › Sign-ins, where adding one works. The API asks `person_has_authenticator`, one owner-run function over the person’s sign-ins that reads Supabase Auth only through `sign_in_has_authenticator`, so removing a person’s only authenticator frees their other emails at once. Whoever has a held email’s password can still add an authenticator to it: GAP-36.',
    },
  },
  {
    id: 'GAP-36',
    title:
      'Whoever has the password of a person’s held email can add an authenticator to it and get in.',
    affects: ['FR-PLT-03', 'FR-PLT-04', 'F-11'],
    severity: 'Low',
    evidence:
      'Found building #88 on Oct 5. A person’s other email with no authenticator of its own is held until it adds one and enters its code (Q43). Supabase Auth lets an email with no verified factor add one on its password alone, so whoever has that password, the person or someone who stole it, can add an authenticator of their own in Settings › Sign-ins, enter its code, and open everything. The hold stops a password used as it is; it can’t tell the person adding one from someone else.',
    fix: 'By your answer to Q44: once a person has an authenticator, only an email they have let in signs in; their other emails still forward receipts, and one is let in only from an email that passed its code, then adds its own authenticator (#90).',
    backlog: 90,
    closed: {
      date: '2026-10-05',
      note: 'PR #60, at your answer to Q44 (ADR-0044, A person’s emails let in): while the second factor is on and a person has an authenticator, only an email they let in opens the app. The first of their emails to pass its code is let in then; another is refused, with 403 `sign_in_not_let_in` naming it, whatever its session says, its own authenticator included, and the app says it isn’t let in, that its receipts are still filed and how to let it in, never asking for a code. From an email let in that passed its code, Settings › Sign-ins lets another in, for 24 hours, in which it adds its own authenticator and passes its code; then it is let in for good, until withdrawn. Kept in `let_in_sign_ins`, each change audited, and only the person, from a session that passed the code, changes it, in the database too. Email-in files receipts from every address, let in or not. Before the first email passes its code, whoever holds another’s password could be let in first: GAP-37.',
    },
  },
  {
    id: 'GAP-37',
    title:
      'Before any of a person’s emails is let in, whoever has the password of one can add an authenticator to it and be let in first.',
    affects: ['FR-PLT-03', 'FR-PLT-04', 'F-11'],
    severity: 'Low',
    evidence:
      'Found building #90 on Oct 5. By your answer to Q44, the first of a person’s emails to pass its code is let in. Supabase Auth lets an email with no authenticator add one on its password alone, so until the person’s own email passes its code, for instance before they ever add an authenticator, whoever holds the password of another email linked to them can add theirs to it, pass its code and be let in first. The person’s own email is then refused and says it isn’t let in, which tells them; the owner removes that authenticator in Supabase and resets who is let in (the runbook).',
    fix: 'If your answer to Q45 asks for it: let in automatically only the email the person first signed in with, which until then may add its own authenticator, and refuse any other until it is let in from it (#91).',
    backlog: 91,
  },
  {
    id: 'GAP-25',
    title: 'Photos emailed in are stored with their location.',
    affects: ['NFR-PRV-03'],
    severity: 'Medium',
    evidence:
      'Found writing the user stories (US-PRV-01). The browser redraws a photo before upload, dropping its metadata; email-in stores an attachment’s bytes as they arrived, and an image the browser can’t decode is uploaded unchanged.',
    fix: 'Strip image metadata on the server before storing, for every source, with a test (#68).',
    backlog: 68,
  },
  {
    id: 'GAP-26',
    title: 'Some requirements say more than the build does.',
    affects: ['FR-CAP-02', 'FR-INT-03', 'FR-EXP-05', 'NFR-DAT-05', 'NFR-DEL-05', 'NFR-SEC-08'],
    severity: 'Medium',
    evidence:
      'Writing a Given/When/Then criterion for every requirement checked each against the code. Nineteen requirements promise something the build does only in part, such as a personal receipts address (FR-CAP-02) or a flag for every capability (NFR-DEL-05). The criteria claim only what is built; the requirements still say more.',
    fix: 'Bring each requirement’s wording to what is built, or build the rest, item by item as you choose (#69).',
    backlog: 69,
  },
  {
    id: 'GAP-24',
    title: 'Detailed requirements are scattered, with no acceptance criteria you can sign off.',
    affects: ['NFR-DEL-09', 'F-53'],
    severity: 'Medium',
    evidence:
      'Your review of Oct 4. Your detailed requirements, such as those for duplicates and expense reports, are recorded, but across requirement texts and their notes, your answers to questions, decision records and the change log; the rules a test proves are written only as test names. No page lists, per requirement, the criteria it is accepted on, who decided each one, and which test proves it.',
    fix: 'User stories with Given/When/Then acceptance criteria in these records, each criterion traced to a test or shown as untested, a register of the rules’ numbers, and a page for them (#65, Q26).',
    backlog: 65,
    closed: {
      date: '2026-10-04',
      note: 'PR #57: 108 user stories with 588 acceptance criteria cover every built requirement and feature and every planned requirement from your words. Each criterion says who decided it and which test proves it; the 82 built criteria no test proves yet are listed against #66. The register holds 18 rules, each held to the code.',
    },
  },
  {
    id: 'GAP-23',
    title: 'Duplicates are matched on the total, which a tip or an amended receipt changes.',
    affects: ['FR-INT-18', 'F-48'],
    severity: 'Medium',
    evidence:
      'Your review of Oct 4: the same purchase with a tip added, or an amended receipt, has another total, so it isn’t flagged. Since PR #49 a match needs the same vendor and total, dated a day apart at most; time and place aren’t read from receipts yet.',
    fix: 'Match on vendor, date, time and location, the total free to differ, and tell a duplicate (everything the same) from a possible one that may need a merge or a replacement (#61, after #53).',
    backlog: 61,
    closed: {
      date: '2026-10-04',
      note: 'PR #54 (ADR-0031): with a time and a place on both receipts, a similar merchant at the same place on the same day, at most 30 minutes apart, is one purchase, whatever the total; exact when the minute and the total match too. Without them, the total still decides (Q18).',
    },
  },
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
    closed: {
      date: '2026-10-04',
      note: 'PR #58 (ADR-0035): enforced in the database, not only the API. Each request names its caller to Postgres; a member or approver sees only their own receipts, expenses, trips and reports and what hangs off them, owners, finance admins and auditors see everyone’s, everyone changes only their own, and an auditor nothing. Tested for each role by API and directly as the app’s database role. Approval isn’t built, so an approver sees only their own until #24.',
    },
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
    closed: {
      date: '2026-10-05',
      note: 'Behind `security.second-factor` (ADR-0042): authenticator apps are added in Settings › Sign-ins, and while the organization has it on, sign-in asks for the code and every admin action needs aal2; approving someone else’s spend calls the same check with #24. What a token from a password alone can still do through the API is GAP-33.',
    },
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
      'Migration 0001 granted DELETE on every tenant table to `expensewise_app`; the append-only trigger covers `audit_events` alone. Since migration 0017 the app can’t delete receipts, readings, confirmations or expenses except through `delete_receipt()` (ADR-0028); it can still delete reports, approval steps and mileage logs.',
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
    closed: {
      date: '2026-10-04',
      note: 'PR #58, behind Where each field was read: each field shows the line of the receipt it was read from, as text (no highlight on the image: the models give no position), and a Ready receipt’s field is corrected with a tap through its expense, until the expense is submitted. Correcting an approved one is a reversal, which comes with approval (#24).',
    },
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
    closed: {
      date: '2026-10-05',
      note: 'A test builds every request a reader can send, to each Claude model and to OpenAI, with each addition on, off and left out, for a photo and a PDF, and fails if any carries a tool, a tool choice or a function, or a field beyond those it sends today (#38).',
    },
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
    closed: {
      date: '2026-10-04',
      note: 'PR #58: each receipt keeps when its first reading settled, and the comparison shows the 95th percentile against 30 seconds, behind Capture-to-Ready time. Reading production’s figure is #75.',
    },
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
    answer: {
      date: '2026-10-04',
      text: 'Flag every feature from now on, each off by default; you switch each one on after checking it on your iPhone in production. The screens already released stay as they are. Each organization’s owner switches its own features in Settings › Features, at once and without a release, and the server’s override still beats that switch (ADR-0032).',
    },
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
  {
    id: 'Q17',
    title: 'Which addresses may send receipts in',
    ask: 'Email-in reads mail only from an address you sign in with. A: keep it that way; an address you send receipts from is added as a sign-in (Settings → Sign-ins). B: each person also keeps a short list of forwarding addresses, each confirmed once with a code sent to it, which let mail in but can’t sign in.',
    why: 'Signing in with an employer’s address ties your ExpenseWise account to that job and its mail policies. A forwarding address only lets receipts in. Either way, each email is proved by its sender’s DKIM signature, and the Bird allowlist must include the address too.',
    recommendation: 'B.',
    affects: ['FR-CAP-02', 'F-16'],
    answer: {
      date: '2026-10-03',
      text: 'A: your work address is already a sign-in, so sign-in addresses stay the only senders; no forwarding list. I had guessed it wasn’t one without being able to see your sign-ins.',
    },
  },
  {
    id: 'Q18',
    title: 'How duplicates are matched until time and place are read',
    ask: 'You want duplicates matched on vendor, date, time and location, the total free to differ. The time and address on a receipt aren’t read yet; that is #53. Until it ships: A: keep matching on vendor, date and the same total, as now. B: match on vendor and date alone, whatever the total.',
    why: 'Without time and place, B flags every two rides with one company on one day: airport to hotel, then hotel to office. Many receipts print no time or address, so even after #53 some will have only vendor, date and total to go on.',
    recommendation:
      'A, then your rule once #53 reads time and place. A receipt that prints neither is still matched on vendor, date and total.',
    affects: ['FR-INT-18', 'GAP-23'],
    answer: {
      date: '2026-10-04',
      text: 'A, with #53 coming soon: it is built now, before #61.',
    },
  },
  {
    id: 'Q19',
    title: 'Whether an exact duplicate is deleted for you',
    ask: 'When vendor, date, time, location and total all match, it is a duplicate, not a possible one. A: it is shown as a duplicate and deleted with one tap, Delete the copy. B: it is deleted automatically, and the audit trail says so.',
    why: 'A deletion can’t be undone, by your answer of Oct 3. A forwarded email matches every time; two real purchases at the same place, minute and amount almost never do. The copy counts in no total while it waits.',
    recommendation: 'A for now; B once a month of use shows no exact match was a real purchase.',
    affects: ['FR-INT-18'],
    answer: {
      date: '2026-10-04',
      text: 'A, for delete and for replace: an exact duplicate is deleted with one tap, and a possible one can replace the earlier receipt.',
    },
  },
  {
    id: 'Q20',
    title: 'What happens on day 28 to a report that can’t close',
    ask: 'A report closes automatically 28 days after it opens, but can’t close while any of its trips has expenses needing review. When both apply: A: it stays open past day 28, marked overdue, and reimbursement of all its trips waits. B: on day 28 the trips still needing review move to the next report, and the rest closes on time.',
    why: 'A trip that ends a few days before day 28 joins the open report and can hold up every other trip in it. B pays the finished trips on time, using your rule that trips can move between reports. The warning of delayed reimbursement shows before day 28 either way.',
    recommendation: 'B.',
    affects: ['FR-EXP-12', 'FR-EXP-05'],
    answer: {
      date: '2026-10-04',
      text: 'B, and by hand too: a report not closing while expenses need review is as intended; a trip still needing review can be moved to another report, or moves to the next one on day 28.',
    },
  },
  {
    id: 'Q21',
    title: 'Where expenses on no trip are claimed',
    ask: 'A report holds trips, so an expense on no trip, such as a local lunch or a software subscription, has no report to go on. A: the open report also takes expenses on no trip, dated up to the day it closes. B: they aren’t claimed through reports.',
    why: 'Home shows them as Not on a trip (Q14). Under B they are never reimbursed.',
    recommendation: 'A.',
    affects: ['FR-EXP-05', 'FR-INS-01'],
    answer: {
      date: '2026-10-04',
      text: 'A, as local expenses: an expense on no trip is local, needs a justification, and can go on a report as local. A receipt from when no trip is under way becomes a local expense needing a justification (FR-EXP-14).',
    },
  },
  {
    id: 'Q22',
    title: 'Which exchange rate converts an amount',
    ask: 'Every amount is converted to your reimbursement currency. A: the rate on the purchase date, from the European Central Bank’s free daily reference rates, which you can replace with the rate on your card statement. B: the rate on the day the report closes.',
    why: 'The purchase date’s rate is the usual policy and doesn’t move while a report waits. The card’s own rate, fees included, is what you were really charged; card feeds (FR-CAP-06) could bring it in later. Each conversion keeps its rate, the rate’s date and its source (NFR-DAT-02).',
    recommendation: 'A.',
    affects: ['FR-EXP-13', 'NFR-DAT-02'],
    answer: {
      date: '2026-10-04',
      text: 'Most cards convert at the time of purchase, so a rate may only be needed when no conversion was done. Q23 follows up.',
    },
  },
  {
    id: 'Q23',
    title: 'What a receipt in another currency is reimbursed at',
    ask: 'A receipt in euros paid with a US card: the card converted it, and your statement shows the dollars charged, any foreign transaction fee included. The receipt shows only euros, so the app doesn’t know the dollars. A: you enter the amount charged from your statement; until you do, an estimate from the purchase date’s reference rate shows, marked as an estimate. B: it stays in euros, and the report totals each currency apart for whoever reimburses you. C: card feeds (FR-CAP-06) bring in the amount charged; until then, as B.',
    why: 'You’re right that the card’s conversion, fees and all, is what you paid, so it is what you should get back. But it reaches the app only from your statement or a card feed. Cash spent abroad, or a card charged in the local currency, has no conversion at all.',
    recommendation: 'A.',
    affects: ['FR-EXP-13', 'F-49'],
    answer: {
      date: '2026-10-04',
      text: 'In your preferred currency, as set in the app (FR-EXP-13). Where the converted amount comes from, a reference rate or your statement, is Q25.',
    },
  },
  {
    id: 'Q24',
    title: 'Who sets the duplicate time window',
    ask: 'You asked for the duplicate time window to be set in Settings (FR-INT-19). A: the organization’s owner sets it once, for everyone’s receipts. B: each person sets it for their own receipts.',
    why: 'Catching duplicates is a control: it stops one purchase being reimbursed twice. A person who can narrow the window on their own receipts can switch that control off for themselves, which an approver or auditor would not accept once there is a team. In a one-person organization the owner is you, so A changes nothing for you today.',
    recommendation: 'A.',
    affects: ['FR-INT-19', 'F-52'],
    answer: {
      date: '2026-10-04',
      text: 'A: the organization’s owner sets it, for everyone. Make sure both of your email addresses have the owner role. A role belongs to the person, not the address: your first sign-in made you the owner of your organization, and your work address was linked to you as a second sign-in (Q17), so both carry it. #64 shows your role in Settings so you can confirm it with each address.',
    },
  },
  {
    id: 'Q25',
    title: 'Where a converted amount comes from',
    ask: 'Your answer to Q23 settles the currency: your preferred one. It leaves where the converted figure comes from when a receipt is in another currency. A: the app converts at the purchase date’s reference rate, shown as converted at that rate, and you can replace it with the amount your card statement shows, fees included. B: the reference rate only, never replaced. C: you always enter the amount from your statement, and nothing is reimbursed until you do.',
    why: 'The reference rate needs no work from you and suits cash and local-currency charges, which have no conversion at all. But your card’s conversion, fees included, is what you actually paid (your answer to Q22), so A lets the statement win where you have it. Each conversion keeps its rate, the rate’s date and its source (NFR-DAT-02).',
    recommendation: 'A.',
    affects: ['FR-EXP-13', 'F-49', 'NFR-DAT-02'],
    answer: {
      date: '2026-10-04',
      text: 'The rate at the time of purchase: the purchase date’s reference rate. Replacing it with the amount on your statement was not asked for, so it isn’t planned.',
    },
  },
  {
    id: 'Q26',
    title: 'How detailed requirements are written down',
    ask: 'Your detailed requirements are recorded today across requirement texts, their notes, your answers to questions, decision records and test names, with no acceptance criteria you can read and sign off (GAP-24). Proposed: each requirement gets user stories (as a…, I want…, so that…) with numbered acceptance criteria in Given/When/Then form, each marked as decided by you or assumed by Claude, and each traced to the automated test that proves it, or shown as untested. The numbers they share, such as 28 days or 30 minutes, are named once in a register of rules. All of it lives in these records, so the checks refuse a delivered story whose criteria no test covers, and it is published as a fifth page after each release. A: as proposed. B: stories and criteria in a separate document, not checked against the code.',
    why: 'A separate document drifts from the code within weeks; these records already fail the build when they disagree with it, and the criteria would inherit that. Stories carry who and why; the Given/When/Then criteria carry the precision, and are what you would accept or reject.',
    recommendation: 'A.',
    affects: ['NFR-DEL-09', 'F-53', 'GAP-24'],
    answer: {
      date: '2026-10-04',
      text: 'A, the user story format as laid out. Go back through the entire build and capture every user story and its acceptance criteria. Asked where they live: in these records (tools/records/src/stories), beside the requirements, and published as a fifth page, User stories & acceptance criteria, after each release; the traceability page links each requirement to its stories.',
    },
  },
  {
    id: 'Q27',
    title: 'What an expense without a category and type holds up',
    ask: 'Every expense has a category and a type (FR-EXP-11). With categories switched on, one without them says so on its page and in the expense list, and holds nothing up. Should it also: A, stay as it is; B, appear in Needs you as well; C, stop its report from being submitted, once reports are submitted (#24); D, both B and C?',
    why: 'Switched on for the first time, every expense you already have lacks them, so B would fill Needs you at once; it is the list of what needs you now. Submission is where finance needs the coding, and where a missing one does harm. A suggestion is shown for most expenses, so confirming one is a tap.',
    recommendation:
      'C, with A until reports are submitted: the expense and the list say what is missing, and submitting needs it (#71).',
    affects: ['FR-EXP-11', 'F-43', 'GAP-28'],
    answer: {
      date: '2026-10-04',
      text: 'B: an expense without a category and type also appears in Needs you, and holds nothing up. Switched on for the first time, Needs you lists every expense you already have until each is coded; most carry a suggestion you confirm with a tap (#71).',
    },
  },
  {
    id: 'Q28',
    title: 'Which rate mileage pays',
    ask: 'Manual mileage (#17) pays each drive at a rate copied onto it from its date. Nothing in the app held a rate, so Claude chose the IRS standard mileage rate for business use: 72.5 cents a mile in 2026, 70 cents in 2025, back to 2022 (ADR-0038). A: keep the IRS business rate, added each December when the IRS announces the next year’s; until it is added, a drive dated in the new year is refused rather than paid at the old rate. B: your own rate a mile, set in Settings, with the IRS rate as its starting value. C: something else.',
    why: 'The rate decides every mileage claim, and it is copied onto each drive, so a later change never alters one already logged (NFR-DAT-04). The IRS rate is what a solo professional can deduct without keeping vehicle costs; an employer may pay less, or more as taxable pay. An organization outside the US would need its own rate and currency, which only B gives.',
    recommendation:
      'A, while you are the only organization; B before a second organization, or anyone outside the US, joins.',
    affects: ['FR-CAP-03', 'F-13', 'NFR-DAT-04'],
    answer: {
      date: '2026-10-04',
      text: 'The IRS business rate by default, and your own rate a mile in Settings whenever you want it (#77).',
    },
  },
  {
    id: 'Q29',
    title: 'Which reports can be exported once approval exists',
    ask: 'FR-SET-01 says approved reports are exported. You asked for export (#25) before approval (#24), so today a report can be exported once it closes, and at every state after that. Once approval exists: A: keep it so, and a closed report can still be exported before it is submitted or approved. B: only an approved report can be exported.',
    why: 'A copy of a closed report lets you check it, or send it to whoever reimburses you, before you submit; an approved report is what finance books, and the PDF says which it is. B would take away an export you have today. Posting to accounting (FR-SET-02) takes approved reports only either way.',
    recommendation: 'A.',
    affects: ['FR-SET-01', 'F-19', 'US-RPT-16', 'US-RPT-17'],
    answer: {
      date: '2026-10-04',
      text: 'Once approval exists, submitted and approved reports are exported. Until then there is nothing submitted, so a closed report exports as it does today (#24).',
    },
  },
  {
    id: 'Q30',
    title: 'What owners and finance admins may do with others’ records',
    ask: 'Since #50, owners, finance admins and auditors can open everyone’s receipts, expenses and trips, but each person changes only their own, and Receipts, Expenses and Trips list only your own. A: as built: see everyone’s, change only your own; a claim that needs fixing goes back to its person, through approval (#24). B: owners and finance admins can also change anyone’s records, each change audited. C: as A, plus a list of everyone’s records for owners and finance admins.',
    why: 'Who may change a colleague’s claim is a control: if a finance admin can edit an expense, what its claimant said they spent can change under them. A list of everyone’s is how an owner would actually look at the team’s spending; today they open a record only by its link.',
    recommendation: 'A for now; decide on C when the first team starts approving reports.',
    affects: ['FR-GOV-01', 'F-61', 'ADR-0035'],
    answer: {
      date: '2026-10-04',
      text: 'A, as recommended: owners and finance admins see everyone’s records and change only their own; a claim that needs fixing goes back to its person through approval (#24). A list of everyone’s waits until the first team approves reports.',
    },
  },
  {
    id: 'Q31',
    title: 'Where the route-mileage key lives',
    ask: 'Route-based mileage (#20) needs an OpenRouteService key. A: in the app, in Settings, like the AI provider keys: checked with a free call when saved, stored encrypted, only its last four characters shown. B: a Vercel environment variable you set, one for the whole app.',
    why: 'In the app it takes effect at once and is checked on screen, and each organization brings its own, which suits OpenRouteService’s terms that tie a free key to one person. A server variable is less code but needs a redeploy, shows no check, and lends your personal key to every organization.',
    recommendation: 'A.',
    affects: ['FR-CAP-04', 'F-14'],
    answer: {
      date: '2026-10-04',
      text: 'A: in the app, in Settings, checked on save and stored encrypted.',
    },
  },
  {
    id: 'Q32',
    title: 'What may be sent to OpenRouteService',
    ask: 'To measure a drive, each stop goes to OpenRouteService: an address to find it on the map, then the points in order for the driving distance. Its terms ask that no personal data is sent, and a home address arguably is. A: a saved place is looked up once and only its point is sent afterwards. B: each address is sent as typed, every time. C: only points dropped on a map.',
    why: 'Names, notes and purposes are never sent in any case. A sends your home address once; B on every drive from home; C never, but is slower on a phone.',
    recommendation: 'A.',
    affects: ['FR-CAP-04', 'F-14'],
    answer: {
      date: '2026-10-04',
      text: 'B: each address is sent as typed, every time a drive is measured; never a name, note or purpose.',
    },
  },
  {
    id: 'Q33',
    title: 'When the measured route and the odometer disagree',
    ask: 'OpenRouteService measures the shortest sensible route; a real drive may be longer. A: you may change the miles with a reason, and the claim shows both. B: you may change them freely. C: the measured distance is final; use manual miles for anything else.',
    why: 'The IRS expects the miles actually driven, and a reviewer expects a change explained. Either way the claim keeps the measured distance, its source and when it was measured, and is never measured again.',
    recommendation: 'A.',
    affects: ['FR-CAP-04', 'F-14', 'NFR-DAT-04'],
    answer: {
      date: '2026-10-04',
      text: 'A: you may change the miles with a reason; the claim and its export show the measured miles and yours.',
    },
  },
  {
    id: 'Q34',
    title: 'Which AI models Settings offers',
    ask: 'You approved Sonnet 5.5 and Haiku 4.5 (ADR-0017), and GPT-5.6 Luna reads for OpenAI. Settings › AI models (#52) also lists Opus 5.5 and Fable 5.1, switched off, with their list prices. A: offer only the approved ones. B: keep all five, those two off.',
    why: 'Offering them spends nothing until one is switched on, and they read hard receipts better at several times the cost; but a switch you can flip is a choice you are offered.',
    recommendation: 'A.',
    affects: ['FR-INT-16', 'F-45'],
    answer: {
      date: '2026-10-04',
      text: 'B: all five offered, Opus 5.5 and Fable 5.1 off until you switch one on.',
    },
  },
  {
    id: 'Q35',
    title: 'What a split expense is',
    ask: 'You asked to split an expense into categories and types for reporting. A: it stays one expense with one receipt, made of parts, each with a category, type and amount. B: it becomes several expenses on the same receipt, each reviewed and approved on its own.',
    why: 'One expense in parts keeps one claim for approval and one receipt as proof, while reports and exports total by category and type. Several expenses are simpler to store but multiply what is reviewed, and the receipt has to be checked against their sum.',
    recommendation: 'A.',
    affects: ['FR-EXP-15', 'F-55'],
    answer: { date: '2026-10-04', text: 'A: one expense, in parts.' },
  },
  {
    id: 'Q36',
    title: 'How the parts of a split are made',
    ask: 'A: from itemized lines where the receipt has them, each line given a category and type, or by amounts where it doesn’t. B: from lines only. C: by amounts only.',
    why: 'Folios and itemized bills split naturally by line; card slips and taxi receipts have no lines. Either way the parts add up to the claim.',
    recommendation: 'A.',
    affects: ['FR-EXP-15', 'F-55'],
    answer: { date: '2026-10-04', text: 'A: by line where itemized, by amount where not.' },
  },
  {
    id: 'Q37',
    title: 'The tax on a line split off or excluded',
    ask: 'A: lines as printed; tax and service charges are lines of their own, split or excluded like any other. B: each tax or service line is spread across the other lines in proportion.',
    why: 'As printed matches the receipt exactly. In proportion is closer to what finance would allocate, so excluding the minibar also takes off its share of the tax, but the amounts no longer match a printed line.',
    recommendation: 'A.',
    affects: ['FR-EXP-15', 'FR-EXP-16', 'F-55'],
    answer: {
      date: '2026-10-04',
      text: 'B: spread in proportion, in whole cents, the largest share taking any cent left over so the parts add up to the receipt exactly.',
    },
  },
  {
    id: 'Q38',
    title: 'The reason for an excluded line',
    ask: 'Claiming less than a receipt needs a reason (Q6). A: the excluded line is the reason, with an optional note. B: pick a reason: personal, paid by someone else, not reimbursable, other. C: a typed note for each.',
    why: 'A is one tap; B tells a reviewer why at a glance for one more tap; C is the most explicit and the slowest on a phone.',
    recommendation: 'A.',
    affects: ['FR-EXP-16', 'FR-EXP-10', 'F-55'],
    answer: {
      date: '2026-10-04',
      text: 'A reason picked from the list, and an optional note. Claude assumes other needs the note, since other alone says nothing; yours to overturn.',
    },
  },
  {
    id: 'Q39',
    title: 'Which transportation receipts read a from and to',
    ask: 'You asked for the from and to of a ride. A: rides, airline tickets and rail tickets each read their from and to. B: rides only.',
    why: 'The same reading reads either at a few output tokens more; one rule for every leg of a journey.',
    recommendation: 'A.',
    affects: ['FR-INT-20', 'F-54'],
    answer: { date: '2026-10-04', text: 'A: rides, flights and rail.' },
  },
  {
    id: 'Q40',
    title: 'Approval and the second factor',
    ask: 'Approval (#24) needs a second factor before anyone approves someone else’s spend, and none is built yet (#8). A: build the second factor in the same batch, behind its own switch. B: approval on a password alone for now. C: approval for a one-person organization only, until #8. D: leave #24 and #70 for later.',
    why: 'Approving someone else’s spend is the action most worth protecting, and the second factor is all that stands between #24 and its whole rule.',
    recommendation: 'A.',
    affects: ['FR-GOV-04', 'FR-PLT-03', 'F-11', 'F-18'],
    answer: {
      date: '2026-10-05',
      text: 'A: the second factor is built in the same batch as approval, behind its own switch.',
    },
  },
  {
    id: 'Q41',
    title: 'How far the second factor reaches',
    ask: 'With the second factor on, the app asks for the code at sign-in, and the API refuses admin actions and approving without it, as FR-GOV-04 says. A token from a password alone, used directly against the API, can still read that person’s records and change their own (GAP-33). A: refuse every request of someone with an authenticator until they enter the code, and need it to link a sign-in (#85). B: keep it to admin actions and approving, as built.',
    why: 'An owner or finance admin sees everyone’s records, so their password alone still reaches all of the organization’s spending.',
    recommendation: 'A, before a second person joins.',
    affects: ['FR-PLT-03', 'GAP-33', 'F-11'],
    answer: {
      date: '2026-10-05',
      text: 'A: refuse every request of someone with an authenticator until they enter the code, and need it to link a sign-in (#85).',
    },
  },
  {
    id: 'Q42',
    title: 'Who a team member’s report goes to',
    ask: 'Approval (#24) sends a report to one approver. As built: the member’s manager if one is set and can approve it, otherwise the longest-standing approver, then finance admin, then owner, never the member themselves; an owner or finance admin may also decide in that person’s place. A: keep that. B: as A, and let an owner choose each member’s approver in Settings › People (#86). C: something else.',
    why: 'In a small team there is usually one obvious approver, and routing by role finds them without a setting. Once two people approve, who gets which member’s report matters, and nothing sets a manager yet.',
    recommendation: 'A until a second approver joins, then B.',
    affects: ['FR-GOV-02', 'F-18'],
    answer: {
      date: '2026-10-05',
      text: 'B: keep the routing as built, and let an owner choose each member’s approver in Settings › People now (#86).',
    },
  },
  {
    id: 'Q43',
    title: 'A person’s other email, once they have an authenticator',
    ask: 'With the second factor on, a session of someone with an authenticator gets nothing until it passes the code (#85). Each email a person signs in with has its own authenticators, so the code is asked of the email that has one; another email of theirs with none still opens on its password, as linked before or since (GAP-35). A: hold that email until it adds its own authenticator and enters its code, the app saying which email needs one (#88). B: keep each email to its own authenticators, as built.',
    why: 'Linking a second email now needs the code, but the email linked starts with no authenticator, so a stolen password for it still opens the person’s receipts, and an owner’s everyone’s.',
    recommendation: 'A, before anyone links a second email with the second factor on.',
    affects: ['FR-PLT-03', 'FR-PLT-04', 'GAP-35', 'F-11'],
    answer: {
      date: '2026-10-05',
      text: 'A: hold a person’s other email until it adds its own authenticator and enters its code, the app saying which email needs one (#88).',
    },
  },
  {
    id: 'Q44',
    title: 'How one of a person’s other emails is let in',
    ask: 'By your answer to Q43, a person’s other email with no authenticator of its own is held until it adds one (#88), but Supabase Auth lets an email with none add one on its password alone, so whoever has that password could add their own and get in (GAP-36). A: a new authenticator on another email counts only once confirmed from an email that already passed its code. B: once a person has an authenticator, only an email with one signs in; their other emails still forward receipts but can’t open the app. C: keep it as built.',
    why: 'Each email a person links is its own sign-in with its own password, so each is its own way in; the hold stops a password used alone, not one used to add an authenticator.',
    recommendation: 'A.',
    affects: ['FR-PLT-03', 'FR-PLT-04', 'GAP-36', 'F-11'],
    answer: {
      date: '2026-10-05',
      text: 'B, with the choice to add an authenticator to another email: only an email with an authenticator signs in, the others still forward receipts, and the person may let another email in from one that has passed its code, after which it adds its own authenticator (#90).',
    },
  },
  {
    id: 'Q45',
    title: 'Which of a person’s emails is let in first',
    ask: 'By your answer to Q44, once a person has an authenticator only an email they let in signs in, and the first of their emails to pass its code is let in (#90). Until then, whoever holds the password of another email linked to them could add an authenticator to it and be let in first (GAP-37); the person would find their own email refused, and the owner would reset it as the runbook says. A: let in automatically only the email the person first signed in with, which until then may add its own authenticator; any other is refused until it is let in from it (#91). B: keep the first to pass its code, as built.',
    why: 'Linking an email needs the passwords of both and, from someone with an authenticator, the code, so the email a person first signed in with is their own; a later one may be the one whose password leaked.',
    recommendation: 'A, before a second person with two emails joins.',
    affects: ['FR-PLT-03', 'FR-PLT-04', 'GAP-37', 'F-11'],
  },
];

/** What changed in these records, newest first. */
export const CHANGE_LOG: readonly ChangeLogEntry[] = [
  {
    date: '2026-10-05',
    change:
      'Your answers of Oct 5 on PR #60. Q41: the second factor locks everything for someone with an authenticator: every request is refused until they enter the code, and linking a sign-in needs it (#85, unblocked). Q42: a report keeps finding its approver as built, and an owner chooses each member’s approver in Settings › People now (#86, unblocked). Both join PR #60.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-05',
    change:
      'PR #60, built behind its own switches, each off until you switch it on in Settings › Features. Single-step approval (#24, F-18, ADR-0043): a closed report is submitted to one approver, never while an expense differs from its receipt without a reason, and approved, or returned with a comment and each rejected expense and why, in Needs you; a one-person organization self-attests, and approving someone else’s spend needs the second factor. A submitted claim keeps its category and type names (#70, GAP-27 closed). The second factor (#8, F-11, ADR-0042): an authenticator app in Settings › Sign-ins, its code at sign-in, and before every admin action, with switching it on refused until your own session has passed it (GAP-03 closed). Emails from your address that filed nothing show in Needs you with why, for 30 days or until dismissed (#59). A report’s export adds From and to, and Stay (#83); Home shows the month’s business miles (#73, GAP-30 closed); a test proves no tools ever reach a model (#38, GAP-15 closed). At your answers to Q41 and Q42, also in PR #60: while the second factor is on, someone with an authenticator gets nothing from the API until they enter the code, and linking a sign-in always needs it (#85, ADR-0044, GAP-33 closed); an owner chooses each member’s approver in Settings › People (#86). Your answer to Q43, also in PR #60: once a person has an authenticator, their other emails are held until each adds its own (#88, GAP-35 closed). Your answer to Q44, also in PR #60: once a person has an authenticator, only an email they let in signs in, the others still forward receipts, and another email is let in from one that passed its code (#90, GAP-36). New: GAP-34 with #87; #89.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-05',
    change:
      'Your decisions of Oct 5. Q40: the second factor (#8) is built in the same batch as approval (#24), behind its own switch. #72 is withdrawn: you don’t need a reminder to confirm the AI model, so NFR-AI-04 no longer asks for one and GAP-29 is closed. #39 is closed: your Gmail is not searched, so D-12 is decided and the eval set’s layers are public, synthetic and real captures (ADR-0012, NFR-AI-01). What those two leave missing is now GAP-32: the eval harness has never been run against a model, which waits on your approval of a run’s spend (#84).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'PR #59, built behind its own switches, each off until you switch it on in Settings › Features. Route mileage (#20, F-14, ADR-0039): a drive by its start, stops and end, with saved places and a round trip, measured by car with OpenRouteService on your organization’s own key, kept in Settings › Mileage, and other miles claimed with a reason (Q31 to Q33). Your own rate a mile from a day, or the IRS rate again (#77, Q28), which route drives are paid at too. An expense without a category and type is listed in Needs you (#71, Q27). Journeys and stays (#79, F-54, ADR-0040): a ride, flight or rail ticket reads its from and to, and a hotel folio its check-in and check-out, with the nights worked out. Itemized lines under the total (#80), a line left out of the claim with its reason (#82), and an expense split into parts by category and type (#81) (F-55, ADR-0041, Q35 to Q38). Fixed on the way: a member can delete a receipt whose expense was converted to their currency, which the own-records rules had refused since PR #58; a possible duplicate’s date in Needs you reads Sep 29, 2026; a rail ticket suggests Ground transport.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Your requirements of Oct 4 for receipts, recorded as Planned with their stories: a transportation receipt reads where it went from and to, rides, flights and rail (FR-INT-20, Q39); a hotel folio reads its stay and the nights (FR-INT-21); a receipt’s itemized lines show under the total (FR-INT-22); an expense splits into parts by category and type, by line or by amount, staying one expense (FR-EXP-15, Q35, Q36); a line can be excluded from reimbursement with a reason and an optional note (FR-EXP-16, Q38); tax and service charges spread across lines in proportion (Q37). Features F-54 and F-55; backlog #79 to #82; stories US-READ-23, US-READ-24 and US-EXP-07 to US-EXP-09.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Your answers of Oct 4, asked one at a time. Q27: an expense without a category and type also appears in Needs you (#71). Q28: the IRS rate by default, and your own rate in Settings (#77). Q29: once approval exists, submitted and approved reports export (#24). Q30: owners and finance admins see everyone’s records and change only their own. Q34: all five AI models offered, the two larger Claude models off. For route-based mileage (#20), unblocked with your OpenRouteService account: the key lives in Settings (Q31), addresses are sent as typed (Q32), and you may change the measured miles with a reason (Q33).',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'PR #58, the backlog batch you asked for in one PR, each feature behind its own switch (your answer to Q5, ADR-0032). Every new feature is off until you switch it on in the new Settings › Features, for your organization, at once and audited; the server’s override setting still beats it. Built: organization details and its time zone deciding when report days end (#63, F-51); the duplicate time window and your role in Settings (#64, F-52); amounts converted to your reimbursement currency at the ECB reference rate for the purchase date (#62, F-49, ADR-0034); categories and types your organization defines, with rule-based suggestions and no model calls (#51, #18, F-43, F-15, ADR-0036); AI models switched on and off with one primary and ordered back-ups, Ready resting on one confident reading, which settles the tier as your choice (#52, #21, F-45, ADR-0033); the receipt line behind each field and a one-tap correction of a Ready receipt (#37, GAP-14 closed); capture-to-Ready time with its 95th percentile (#32, GAP-16 closed); manual mileage at the IRS rate on the day (#17, F-13, ADR-0038); CSV and PDF export of a closed report (#25, F-19); the audit trail with its hash chain checked on screen (#26, F-20); invites by link, roles and removal (#29, F-23); and, not switchable because it is security, each member sees and changes only their own records (#50, F-61, GAP-20 closed, ADR-0035). Dates read one way everywhere, Sep 30, 2026 (#55, NFR-UX-06). #4 withdrawn at your word; #22 done with the build version switched on in production; Phase 0 closed in the docs; route mileage researched (#20: OpenRouteService, free). Opened: GAP-27 (#70, a renamed category changes old claims), GAP-28 to GAP-31 with #71 to #74, #75 to read capture-to-Ready in production, #76 to add the 2027 IRS mileage rate before January, and Q27 to Q30 for your decision.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'User stories and acceptance criteria for the entire build (#65; NFR-DEL-09 and F-53 Verified; GAP-24 closed). 108 stories with 588 Given/When/Then criteria cover all 97 requirements that are built or planned from your words, and every built feature. Each criterion says who decided it: you (101), the blueprint (206), or Claude (281, listed first on the page for you to confirm). 456 of the 538 built criteria are proved by a test; the other 82 are listed against #66. A register of 18 rules, such as 28 days and 30 minutes, is held to the code. A fifth page publishes them, and each requirement on the traceability page links its stories. Writing them found: photos emailed in keep their location (GAP-25, #68); error reports don’t redact OpenAI keys (#67); nineteen requirements that say more than the build does (GAP-26, #69), among them Q5, which earlier pull requests cited although you never answered it; and a misstatement in ADR-0029, corrected here: a trip joins its report 24 to 50 hours after its return day ends, about 31 hours in US Central time, not at most 26.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Your answers to Q24 to Q26. Q24: the organization’s owner sets the duplicate time window, for everyone, and both of your addresses must carry the owner role; #64 shows your role in Settings. Q25: an amount in another currency is converted at the purchase date’s reference rate; no statement override is planned. Q26: user stories with Given/When/Then acceptance criteria, in these records and on a fifth page, written for the entire build (#65). #62, #64 and #65 are no longer waiting on you.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Your answers and requests of Oct 4, after the release. Q23: a receipt in another currency is reimbursed in your preferred currency, as set in the app; Q25 asks where the converted figure comes from. The duplicate time window is to be set in Settings, 0 to 120 minutes, 30 by default (FR-INT-19, F-52, #64); Q24 asks who sets it. Your detailed requirements are recorded but scattered, with no acceptance criteria you can sign off (GAP-24, NFR-DEL-09, F-53, #65); Q26 proposes user stories with Given/When/Then criteria, each traced to a test.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Duplicates matched on time and place, exact or possible (#61; FR-INT-18 and F-48 Verified; GAP-23 closed; ADR-0031). Where both receipts say when and where, those decide, whatever the total: a similar merchant at the same place on the same day, at most 30 minutes apart, is one purchase. Exact when the minute and the total match too: Delete the copy takes one tap. Otherwise possible, as with the card slip and its tip: Replace the earlier one keeps the later receipt. Receipts that don’t both say when and where are still matched on the total, a day either way (Q18). Two purchases at the same café hours apart are no longer flagged. The 30 minutes is Claude’s reading of “the same time”, yours to change.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Time and place from the receipt (#53; FR-INT-17 and F-46 Verified; ADR-0030). Each reading now captures the time of purchase and the merchant’s address, with city, region and country picked out, each with its confidence; neither ever holds a receipt for a look. The expense carries them and shows them beside its receipt’s; you can edit them, and the time zone is worked out again from the place, offline, so no address leaves ExpenseWise, or you pick one. Receipts read before this have no time or place until read again. The eval set scores time, city and country. #61 can now match duplicates on time and place.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Expense reports (#23; FR-EXP-05, FR-EXP-12, FR-EXP-14, F-17 and F-50 Verified; ADR-0029). A trip goes on your open report 24 hours after you’re back, and an expense on no trip likewise after its date; with no report open, one opens. Close it when nothing needs you, within 28 days, or it closes itself, moving what still needs review to the next report; it warns in its last week. Reopen a closed report until it is submitted; anything that changes on it reopens it too. Move a trip to another report or a new one. A local expense asks why it was for business. Needs you shows a report overdue, closing soon or ready to close, and local expenses needing a reason; Home lists your reports. Totals stay per currency until #62.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'More of your answers of Oct 4. Q18: keep matching on the total until #53, built now. Q19: an exact duplicate is deleted with one tap; a possible one can replace the earlier receipt. Q20: a trip still needing review moves to the next report on day 28, or by hand. Q21: an expense on no trip is local and needs a justification (FR-EXP-14, F-50). Q22: cards convert at purchase, so Q23 asks what a receipt in another currency is reimbursed at. Closing a report never submits it. Your reimbursement currency is set in Settings and starts as your organization’s; your organization’s details are editable there too (FR-PLT-11, F-51, #63). #23, #53 and #61 are under way.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Your answers of Oct 4. Duplicates: match on vendor, date, time and location, since a tip or an amended receipt changes the total, and tell a duplicate from a possible one that may need a merge or a replacement (FR-INT-18 and F-48 now Partial, GAP-23, #61). Time and place are read with #53, moved up to P1 for it. Reports: a report holds one or more trips, which join 24 hours after their return date and can move between reports; you’re told in the app (FR-EXP-05). A report closes within 28 days or closes itself, can’t close while expenses need review, warns before day 28, is submitted only once closed, and can be reopened until submitted (FR-EXP-12). Everything is converted to your reimbursement currency (FR-EXP-13, F-49, #62). Open questions: Q18 to Q22.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-04',
    change:
      'Possible duplicates are caught in review (#60, FR-INT-18 and F-48 Verified, ADR-0028). When a receipt is read it is compared with your other receipts: same currency and total, a day apart at most, a similar merchant. The later of a pair waits in Needs you as a possible duplicate and counts in no total. On either receipt’s page you keep both, delete one, or merge one into the one you keep, taking its missing fields and any you tick; the other is deleted with its file and expense, and the audit trail records what it was. A submitted or approved expense is never deleted. The app can no longer delete receipts, readings or expenses except through one database function. Receipts filed before this, such as the eight Uber forwards, are checked once on release.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'Your requirement: possible duplicates are caught in review, then merged, deleted or kept (FR-INT-18, F-48, #60, all Planned). Your answers: no reference copy is kept; a merge keeps the primary you choose, takes the other’s missing or chosen fields, and deletes it; #60 is built before #23. The same Uber receipt, forwarded eight times, was filed eight times: each forward differed slightly, so the file fingerprint didn’t match. Duplicates will be judged on what was read: same person, currency and total, within a day, a similar merchant.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'Fix: Bird’s webhook refused an event it should have ignored. Your webhook also sends events email-in doesn’t use, such as email.received, whose message id may be empty or an email’s Message-ID; the webhook checked those ids as if they were mailbox ids and answered 400. It now acknowledges every other event whatever its data, reads the signed body whatever content type it carries, and logs one line per delivery. Your forwarded email itself never raised the mailbox event the app reads, which points to Bird holding it back before the webhook.',
    by: 'Claude',
  },
  {
    date: '2026-10-03',
    change:
      'Your answer to Q17: A, sign-in addresses stay the only senders; your work address already is one. A correction to the entry below: your work address was also already on the Bird allowlist, so neither explains why Bird made no call for your first test. The next test is watched in the logs as it arrives.',
    by: 'Claude, at your direction',
  },
  {
    date: '2026-10-03',
    change:
      'PR #45, at your direction (#58, moved first): an email with nothing attached, such as an Uber or airline receipt, is filed as its own text laid out as a PDF and read like an upload (ADR-0027). Readings now count fees that are neither tax nor tip, such as a booking fee, so a ride receipt can add up (FR-INT-04). A purchase summary is marked as one and always waits for review (Q10). Each email leaves one line in the logs with what came of it. FR-CAP-02 and F-16 are Verified. Your first test never reached the app: Bird made no call, most likely because your work address isn’t on its allowlist. Q17 asks whether addresses you don’t sign in with may send receipts in; #59 will show an email that came but filed nothing.',
    by: 'Claude, at your direction',
  },
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
