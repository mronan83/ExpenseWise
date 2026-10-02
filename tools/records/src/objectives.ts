import type { Area, Objective } from './model.ts';

/**
 * Why ExpenseWise exists, from the vision's outcome measures and challenges
 * (docs/01-vision-and-scope.md) and the personas (docs/03 §4.1). Three objectives have a
 * measure with a target; the others are measured by a requirement or an exit criterion.
 */
export const OBJECTIVES: readonly Objective[] = [
  {
    id: 'BO-1',
    title: 'Expenses draft themselves: people confirm only what the system is unsure of',
    measure: 'Touches per expense, capture to submitted: fewer than 1 for clean receipts',
    sources: ['vision C1', 'vision C4', 'design DP1', 'design DP2'],
    personas: ['Alex', 'Riley'],
    areas: ['CAP', 'INT', 'EXP', 'AI', 'UX', 'PERF'],
  },
  {
    id: 'BO-2',
    title: "A trip's report is done in minutes, not on a Sunday night",
    measure: 'Human minutes from trip end to submitted: fewer than 5 per trip',
    sources: ['vision C1', 'journeys §4.2'],
    personas: ['Alex'],
    areas: ['EXP', 'GOV', 'INS'],
  },
  {
    id: 'BO-3',
    title: 'Money reaches people sooner',
    measure: 'Calendar days from submit to reimbursed: baseline in Phase 1, then halve it',
    sources: ['vision C1', 'journeys §4.2'],
    personas: ['Alex', 'Sam'],
    areas: ['GOV', 'SET'],
  },
  {
    id: 'BO-4',
    title: 'Records an auditor and the IRS accept, kept safe for seven years',
    measure: 'A year-end summary the accountant accepts; no receipt lost; the restore drill passes',
    sources: ['vision C5', 'journeys §4.3', 'ADR-0008', 'ADR-0014'],
    personas: ['Riley', 'Sam'],
    areas: ['GOV', 'DAT', 'PRV', 'REL', 'SEC'],
  },
  {
    id: 'BO-5',
    title: 'Control without friction: approvers see only exceptions',
    measure: 'Median approval time; share of policy violations caught at capture',
    sources: ['vision C2', 'journeys §4.4', 'design DP6'],
    personas: ['Jordan', 'Sam'],
    areas: ['GOV', 'INT'],
  },
  {
    id: 'BO-6',
    title: 'Month-end closes first time: the export reconciles',
    measure: 'A pilot team closes a month end to end in ExpenseWise (Phase 2 exit)',
    sources: ['journeys §4.7', 'roadmap P2'],
    personas: ['Sam'],
    areas: ['SET', 'GOV', 'INS'],
  },
  {
    id: 'BO-7',
    title: 'One API, many clients: the iPhone app arrives without a rewrite',
    measure: 'The iPhone app ships on the same versioned API, with no breaking change unversioned',
    sources: ['vision C3', 'arch AP1', 'ADR-0004'],
    personas: ['Alex'],
    areas: ['PLT', 'ARC'],
  },
  {
    id: 'BO-8',
    title: 'A team of one person and one AI ships safely',
    measure: 'Every change passes the gates; every release is approved and verified live',
    sources: ['vision C6', 'ADR-0009', 'ADR-0019'],
    personas: [],
    areas: ['DEL', 'OPS', 'SEC'],
  },
];

/**
 * Requirement areas. Functional areas follow the capability map's rows
 * (docs/02-capability-map.md); non-functional areas follow the architecture and delivery docs.
 */
export const AREAS: readonly Area[] = [
  {
    code: 'CAP',
    kind: 'FR',
    name: 'Capture',
    blurb: 'Get evidence in with the least effort.',
  },
  {
    code: 'INT',
    kind: 'FR',
    name: 'Intelligence',
    blurb: 'Turn evidence into correct data.',
  },
  {
    code: 'EXP',
    kind: 'FR',
    name: 'Expense management',
    blurb: 'Organize spend around how people work.',
  },
  {
    code: 'GOV',
    kind: 'FR',
    name: 'Governance',
    blurb: 'Control without friction.',
  },
  {
    code: 'SET',
    kind: 'FR',
    name: 'Settlement',
    blurb: 'Close the loop with money and the ledger.',
  },
  {
    code: 'INS',
    kind: 'FR',
    name: 'Insights',
    blurb: 'Know where the money goes.',
  },
  {
    code: 'PLT',
    kind: 'FR',
    name: 'Platform',
    blurb: 'Organizations, sign-in, notifications and the clients.',
  },
  {
    code: 'SEC',
    kind: 'NFR',
    name: 'Security and tenancy',
    blurb: 'Every row knows its tenant, and secrets never leak.',
  },
  {
    code: 'PRV',
    kind: 'NFR',
    name: 'Privacy and retention',
    blurb: 'Personal data is minimal, kept as long as the law needs and no longer.',
  },
  {
    code: 'DAT',
    kind: 'NFR',
    name: 'Data integrity and money',
    blurb: 'Exact money, nothing lost, nothing approved ever edited.',
  },
  {
    code: 'REL',
    kind: 'NFR',
    name: 'Reliability and recovery',
    blurb: 'Backups that have been restored, and availability that is measured.',
  },
  {
    code: 'PERF',
    kind: 'NFR',
    name: 'Performance',
    blurb: 'The user never waits on AI.',
  },
  {
    code: 'UX',
    kind: 'NFR',
    name: 'Design and accessibility',
    blurb: 'Thumb-first, legible money, WCAG 2.2 AA.',
  },
  {
    code: 'AI',
    kind: 'NFR',
    name: 'AI quality and cost',
    blurb: 'Accuracy measured, not assumed; cost known per receipt.',
  },
  {
    code: 'ARC',
    kind: 'NFR',
    name: 'Architecture and portability',
    blurb: 'One API, slow work in workflows, vendors behind adapters.',
  },
  {
    code: 'DEL',
    kind: 'NFR',
    name: 'Delivery and change control',
    blurb: 'Gates as the independent reviewer; merging is the release.',
  },
  {
    code: 'OPS',
    kind: 'NFR',
    name: 'Observability',
    blurb: 'Someone finds out when it breaks.',
  },
];
