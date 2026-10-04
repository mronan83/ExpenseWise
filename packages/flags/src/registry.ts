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
  'receipts.journeys': {
    name: 'Journeys and stays',
    description:
      'A ride, flight or train receipt reads where it went from and to, and a hotel folio its ' +
      'check-in and check-out, with the nights worked out; each shows on the expense, which can ' +
      'correct it (FR-INT-20, FR-INT-21, #79). A receipt read before gains them when read again.',
  },
  'expenses.mileage': {
    name: 'Mileage',
    description:
      'Add a mileage expense: date, destination, purpose and miles, at the rate in force on the ' +
      'day (FR-CAP-03, #17).',
  },
  'expenses.route-mileage': {
    name: 'Route mileage',
    description:
      'Add a drive by its start, stops and end, measured by OpenRouteService with your ' +
      'organization’s own key in Settings › Mileage, with saved places and a reason for any ' +
      'change to the measured miles (FR-CAP-04, #20).',
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
  // The operator's switch per AI model (FR-INT-16, US-READ-18). Unlike a feature, it acts
  // only when FLAG_OVERRIDES turns it off: then that model reads no organization's receipts,
  // whatever each has chosen. Unset or on, each organization decides. See modelStopped().
  'operator.claude-sonnet-5-5': {
    name: 'Operator switch: Sonnet 5.5',
    serverOnly: true,
    description: operatorSwitch('Sonnet 5.5'),
  },
  'operator.claude-haiku-4-5': {
    name: 'Operator switch: Haiku 4.5',
    serverOnly: true,
    description: operatorSwitch('Haiku 4.5'),
  },
  'operator.gpt-5.6-luna': {
    name: 'Operator switch: GPT-5.6 Luna',
    serverOnly: true,
    description: operatorSwitch('GPT-5.6 Luna'),
  },
  'operator.claude-opus-5-5': {
    name: 'Operator switch: Opus 5.5',
    serverOnly: true,
    description: operatorSwitch('Opus 5.5'),
  },
  'operator.claude-fable-5-1': {
    name: 'Operator switch: Fable 5.1',
    serverOnly: true,
    description: operatorSwitch('Fable 5.1'),
  },
} as const satisfies Record<string, FlagDefinition>;

function operatorSwitch(label: string): string {
  return (
    `Set off in FLAG_OVERRIDES, ${label} reads no organization’s receipts, whatever each ` +
    'has chosen, during an outage or a bad release. Unset, each organization decides.'
  );
}

export type FlagKey = keyof typeof FLAGS;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(FLAGS, key);
}
