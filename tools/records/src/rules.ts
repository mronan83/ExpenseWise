import type { Rule } from './model.ts';

/**
 * The numbers and settings ExpenseWise's rules share, each named once. Acceptance criteria
 * cite them by id; where the code keeps one in a constant, the integrity checks fail when the
 * code and this register disagree. Change a value here and in the code together.
 */
export const RULES: readonly Rule[] = [
  {
    id: 'R-REPORT-WINDOW',
    name: 'Days a report stays open',
    value: '28 days from opening, then it closes itself',
    decided: { by: 'owner', source: 'owner 2026-10-04' },
    code: { file: 'packages/domain/src/reports.ts', constant: 'REPORT_WINDOW_DAYS', literal: '28' },
  },
  {
    id: 'R-REPORT-WARNING',
    name: 'When a report warns of delayed reimbursement',
    value: 'in its last 7 days',
    decided: { by: 'claude', source: 'ADR-0029' },
    code: { file: 'packages/domain/src/reports.ts', constant: 'REPORT_WARNING_DAYS', literal: '7' },
    note: 'You asked for a warning as day 28 approaches; the 7 days are Claude’s.',
  },
  {
    id: 'R-REOPEN-GRACE',
    name: 'Time a reopened report gets',
    value: 'its day 28, or 7 days from reopening if that is later',
    decided: { by: 'claude', source: 'ADR-0029' },
    code: { file: 'packages/domain/src/reports.ts', constant: 'REOPEN_GRACE_DAYS', literal: '7' },
  },
  {
    id: 'R-REPORT-JOIN',
    name: 'When a trip or local expense joins a report',
    value: '24 hours after its day ends, counted as noon UTC two days after it',
    decided: { by: 'owner', source: 'owner 2026-10-04' },
    note: 'Your 24 hours. Counting them from noon UTC on the second day, so no time zone sees a trip join early, is Claude’s (ADR-0029).',
  },
  {
    id: 'R-REPORT-SCHEDULE',
    name: 'How often reports are kept on time',
    value: 'hourly, at 7 minutes past',
    decided: { by: 'claude', source: 'ADR-0029' },
    code: {
      file: 'packages/workflows/src/reports.ts',
      constant: 'REPORT_SCHEDULE',
      literal: "'7 * * * *'",
    },
  },
  {
    id: 'R-JUSTIFICATION-MAX',
    name: 'Longest justification for a local expense',
    value: '500 characters',
    decided: { by: 'claude', source: 'ADR-0029' },
    code: { file: 'packages/domain/src/reports.ts', constant: 'JUSTIFICATION_MAX', literal: '500' },
  },
  {
    id: 'R-DUPLICATE-WINDOW',
    name: 'How far apart two receipts at one place can be and still be one purchase',
    value: '30 minutes; the same minute for an exact copy',
    decided: { by: 'claude', source: 'ADR-0031' },
    code: {
      file: 'packages/domain/src/duplicates.ts',
      constant: 'DUPLICATE_TIME_WINDOW_MINUTES',
      literal: '30',
    },
    note: 'Claude’s reading of your “the same time”. It becomes a setting your organization’s owner changes, 0 to 120 minutes (FR-INT-19, #64).',
  },
  {
    id: 'R-DUPLICATE-DAYS',
    name: 'How far apart the dates of two receipts matched on their total can be',
    value: 'a day either way',
    decided: { by: 'claude', source: 'ADR-0028' },
    code: { file: 'packages/domain/src/duplicates.ts', constant: 'DUPLICATE_DAY_WINDOW', literal: '1' },
    note: 'Used only where the two receipts don’t both say when and where; you kept it for those (Q18).',
  },
  {
    id: 'R-DATE-AHEAD',
    name: 'How far after its upload a receipt can be dated',
    value: '1 day, for a merchant ahead of UTC',
    decided: { by: 'owner', source: 'owner 2026-10-03' },
    code: { file: 'packages/extraction/src/checks.ts', constant: 'DAYS_AHEAD', literal: '1' },
  },
  {
    id: 'R-DATE-BEHIND',
    name: 'How long before its upload a receipt can be dated',
    value: 'a year',
    decided: { by: 'owner', source: 'owner 2026-10-03' },
  },
  {
    id: 'R-SUMS-TOLERANCE',
    name: 'How far a receipt’s parts may miss its total',
    value: 'one minor unit (a cent) per tax, fee or tip line',
    decided: { by: 'owner', source: 'owner 2026-10-03' },
  },
  {
    id: 'R-RECEIPT-SIZE',
    name: 'Largest receipt file',
    value: '10 MB',
    decided: { by: 'claude' },
    code: {
      file: 'packages/storage/src/store.ts',
      constant: 'RECEIPT_MAX_BYTES',
      literal: '10 * 1024 * 1024',
    },
  },
  {
    id: 'R-EMAIL-RECEIPTS',
    name: 'Most receipts filed from one email',
    value: '10',
    decided: { by: 'claude', source: 'ADR-0026' },
    code: {
      file: 'packages/workflows/src/email.ts',
      constant: 'MAX_RECEIPTS_PER_EMAIL',
      literal: '10',
    },
  },
  {
    id: 'R-EMAIL-PDF-PAGES',
    name: 'Longest PDF made from an email’s text',
    value: '5 pages',
    decided: { by: 'claude', source: 'ADR-0027' },
    code: { file: 'packages/workflows/src/email-pdf.ts', constant: 'MAX_PDF_PAGES', literal: '5' },
  },
  {
    id: 'R-TRIP-LENGTH',
    name: 'Longest trip',
    value: '366 days',
    decided: { by: 'claude' },
    code: { file: 'packages/domain/src/trips.ts', constant: 'TRIP_MAX_DAYS', literal: '366' },
  },
  {
    id: 'R-HOME-NEEDS',
    name: 'Items Needs you shows on Home before “Show all”',
    value: '3, newest first',
    decided: { by: 'claude' },
    note: 'From the Home dashboard Claude proposed and you took forward on Oct 3 (#28); the number itself was never put to you.',
    code: { file: 'packages/api/src/home-routes.ts', constant: 'NEEDS_SHOWN', literal: '3' },
  },
  {
    id: 'R-IMAGE-LINK',
    name: 'How long a link to a receipt’s file works',
    value: '5 minutes',
    decided: { by: 'claude' },
    code: {
      file: 'packages/api/src/receipt-routes.ts',
      constant: 'IMAGE_LINK_SECONDS',
      literal: '300',
    },
  },
  {
    id: 'R-SIGN-IN-LINK',
    name: 'How long a link to add a sign-in works',
    value: '10 minutes',
    decided: { by: 'claude' },
    code: {
      file: 'packages/api/src/workspace-routes.ts',
      constant: 'LINK_TOKEN_MAX_AGE_MS',
      literal: '10 * 60 * 1000',
    },
  },
];
