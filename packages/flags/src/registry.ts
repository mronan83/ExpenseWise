export interface FlagDefinition {
  /** What turning the flag on changes, for whoever flips it. */
  readonly description: string;
}

/**
 * Every feature flag. A flag not listed here doesn't exist, so a typo is a type error.
 * Every flag is off by default: code ships dark and is released by turning its flag on
 * (AP8). Remove a flag, and the code behind its off branch, once it is on everywhere.
 */
export const FLAGS = {
  'shell.build-version': {
    description:
      "Show the deployed build's commit next to the app name. Phase 0's trivial change, " +
      'shipped dark to prove the flag path through every gate.',
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAGS;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(FLAGS, key);
}
