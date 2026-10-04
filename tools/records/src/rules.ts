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
    value:
      '24 hours after its day ends: where the organization is, when it keeps a time zone; otherwise at UTC−12, which is noon UTC two days after it',
    decided: { by: 'owner', source: 'owner 2026-10-04' },
    code: {
      file: 'packages/domain/src/time-zones.ts',
      constant: 'LAST_TIME_ZONE',
      literal: "'Etc/GMT+12'",
    },
    note: 'Your 24 hours. Counting them at UTC−12, where the day ends last, so no time zone sees a trip join early, is Claude’s (ADR-0029): a wait of 24 to 50 hours after the day ends, about 31 hours in US Central time, plus up to an hour for the schedule. With organization settings on and a time zone kept, they are counted there, so the wait is 24 hours (ADR-0037).',
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
    value: '30 minutes until the owner sets another; the same minute for an exact copy',
    decided: { by: 'claude', source: 'ADR-0031' },
    code: {
      file: 'packages/domain/src/duplicates.ts',
      constant: 'DUPLICATE_TIME_WINDOW_MINUTES',
      literal: '30',
    },
    note: 'Claude’s reading of your “the same time”. Since #64 it is the default your organization’s owner can change in Settings, for everyone (FR-INT-19, Q24). An empty setting means this value, so the number lives once.',
  },
  {
    id: 'R-DUPLICATE-WINDOW-MAX',
    name: 'Widest duplicate time window the owner can set',
    value: '120 minutes; the narrowest is 0, the same minute only',
    decided: { by: 'claude' },
    code: {
      file: 'packages/domain/src/duplicates.ts',
      constant: 'DUPLICATE_WINDOW_MAX_MINUTES',
      literal: '120',
    },
    note: 'Claude’s proposal with your request of Oct 4 (FR-INT-19): wide enough for a bill and its tip slip, narrow enough that a morning and an afternoon at one café stay apart. The database holds the column to it too.',
  },
  {
    id: 'R-DUPLICATE-DAYS',
    name: 'How far apart the dates of two receipts matched on their total can be',
    value: 'a day either way',
    decided: { by: 'claude', source: 'ADR-0028' },
    code: {
      file: 'packages/domain/src/duplicates.ts',
      constant: 'DUPLICATE_DAY_WINDOW',
      literal: '1',
    },
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
    id: 'R-PDF-CELL-LINES',
    name: 'Most lines a cell of a report’s PDF shows',
    value: '12, the last ending in “…”; the CSV keeps all of it',
    decided: { by: 'claude' },
    code: { file: 'packages/api/src/report-pdf.ts', constant: 'MAX_CELL_LINES', literal: '12' },
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
    decided: { by: 'blueprint', source: 'ADR-0016' },
    code: {
      file: 'packages/api/src/workspace-routes.ts',
      constant: 'LINK_TOKEN_MAX_AGE_MS',
      literal: '10 * 60 * 1000',
    },
  },
  {
    id: 'R-AUDIT-PAGE',
    name: 'Changes on one page of the audit trail',
    value: '50, newest first; up to 100 when the API is asked for more',
    decided: { by: 'claude' },
    code: { file: 'packages/api/src/audit.ts', constant: 'AUDIT_PAGE_SIZE', literal: '50' },
  },
  {
    id: 'R-MILEAGE-RATE',
    name: 'The rate a drive is paid at',
    value:
      'the IRS standard mileage rate for business use on its date: 72.5 cents a mile in 2026, 70 cents in 2025; known from 1 Jan 2022 to 31 Dec 2026',
    decided: { by: 'claude', source: 'ADR-0038' },
    code: {
      file: 'packages/domain/src/mileage.ts',
      constant: 'IRS_BUSINESS_RATES_THROUGH',
      literal: "'2026-12-31'",
    },
    note: 'Nothing in the app held a rate, so Claude chose the IRS rate; Q31 asks whether you want your own. Each year’s rate is added when the IRS announces it in December; until then a drive dated after the last day known is refused rather than paid at the old rate.',
  },
  {
    id: 'R-MILEAGE-MAX',
    name: 'Most miles one drive claims',
    value: '1,000 miles; a longer drive is logged day by day',
    decided: { by: 'claude', source: 'ADR-0038' },
    code: {
      file: 'packages/domain/src/mileage.ts',
      constant: 'MILEAGE_MAX_MILES',
      literal: '1000',
    },
    note: 'A guard against an odometer reading typed as the distance.',
  },
  {
    id: 'R-MILEAGE-AHEAD',
    name: 'How far after today a drive can be dated',
    value: '1 day after today in UTC, for a person ahead of UTC',
    decided: { by: 'claude', source: 'ADR-0038' },
    code: { file: 'packages/domain/src/mileage.ts', constant: 'MILEAGE_DAYS_AHEAD', literal: '1' },
  },
];
