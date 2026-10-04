export interface FlagDefinition {
  /** What it is called where it is switched. */
  readonly name: string;
  /** What turning the flag on changes, for whoever flips it. */
  readonly description: string;
  /**
   * Set only on the server, by FLAG_OVERRIDES, for every organization: an operator's switch.
   * Without it, each organization's owner switches the flag in Settings › Features (ADR-0032).
   */
  readonly serverOnly?: true;
}

/**
 * Every feature flag. A flag not listed here doesn't exist, so a typo is a type error.
 * Every flag is off by default: code ships dark and is released by turning its flag on
 * (AP8). Remove a flag, and the code behind its off branch, once it is on everywhere.
 */
export const FLAGS = {
  'shell.build-version': {
    name: 'Build version',
    serverOnly: true,
    description:
      "Show the deployed build's commit next to the app name. Phase 0's trivial change, " +
      'shipped dark to prove the flag path through every gate.',
  },
  'settings.organization': {
    name: 'Organization settings',
    description:
      'Settings › Organization: the name, home currency, country, locale, time zone, address, ' +
      'industry and size, kept by the owner. The time zone then decides when a day ends for ' +
      'reports (FR-PLT-11, #63).',
  },
  'settings.duplicate-window': {
    name: 'Duplicate time window',
    description:
      'The owner sets how many minutes apart two receipts at one place can be and still be one ' +
      'purchase (FR-INT-19, #64).',
  },
  'reports.currency-conversion': {
    name: 'Currency conversion on reports',
    description:
      'Reports convert every amount to your reimbursement currency at the purchase date’s ' +
      'reference rate, beside the amount as spent (FR-EXP-13, #62).',
  },
  'expenses.categories': {
    name: 'Categories and types',
    description:
      'Categories and types the organization defines, a category and type on every expense, and ' +
      'suggestions for them (FR-EXP-11, FR-INT-10, #51, #18).',
  },
  'receipts.model-settings': {
    name: 'AI model settings',
    description:
      'Settings › AI models: switch each model on or off and choose the one primary; back-ups ' +
      'read only when it can’t (FR-INT-16, #52).',
  },
  'receipts.field-sources': {
    name: 'Where each field was read',
    description:
      'Each field of a reading shows the line of the receipt it was read from, and one tap ' +
      'corrects it (GAP-14, #37).',
  },
  'receipts.capture-time': {
    name: 'Capture-to-Ready time',
    description:
      'How the models compare shows the 95th-percentile time from capture to Ready (GAP-16, #32).',
  },
  'expenses.mileage': {
    name: 'Mileage',
    description:
      'Add a mileage expense: date, destination, purpose and miles, at the rate in force on the ' +
      'day (FR-CAP-03, #17).',
  },
  'reports.export': {
    name: 'Report export',
    description: 'Export a closed report as CSV or PDF (FR-SET-01, #25).',
  },
  'governance.audit-trail': {
    name: 'Audit trail',
    description:
      'Settings › Audit trail: every record’s history, with the hash chain checked on screen ' +
      '(FR-GOV-06, #26).',
  },
  'team.invites': {
    name: 'Invite people',
    description:
      'Settings › People: invite someone by link with a role, change their role or revoke it ' +
      '(FR-PLT-07, #29).',
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAGS;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(FLAGS, key);
}
