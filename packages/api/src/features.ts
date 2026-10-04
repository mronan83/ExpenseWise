import type { OrgFeature } from '@expensewise/db';
import { FLAG_KEYS, FLAGS, parseOverrides, type FlagKey } from '@expensewise/flags';
import { ProblemError } from './problem.ts';
import type { WorkspaceStore } from './workspace.ts';

/**
 * The flags an organization's owner switches. `shell.*` flags are the server's own and are
 * set only by FLAG_OVERRIDES.
 */
export const ORG_FEATURE_KEYS = FLAG_KEYS.filter((key) => !key.startsWith('shell.'));

export type OrgFeatureKey = (typeof ORG_FEATURE_KEYS)[number];

/** Where a feature's state came from. */
export type FeatureSource = 'default' | 'organization' | 'override';

export interface FeatureState {
  readonly key: OrgFeatureKey;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly source: FeatureSource;
  readonly switchedAt: string | null;
}

/**
 * Whether a feature is on for an organization (Q5: each feature ships dark and its owner
 * switches it on). FLAG_OVERRIDES wins, as the server's kill switch; then the organization's
 * switch; then off.
 */
export interface FeatureGate {
  isOn(orgId: string, key: OrgFeatureKey): Promise<boolean>;
  /** Throws 404 feature_off unless the feature is on, so a dark feature looks absent. */
  require(orgId: string, key: OrgFeatureKey): Promise<void>;
  list(orgId: string): Promise<FeatureState[]>;
  overridden(key: OrgFeatureKey): boolean;
}

export function featureState(
  key: OrgFeatureKey,
  override: boolean | undefined,
  switched: OrgFeature | undefined,
): FeatureState {
  const base = { key, name: FLAGS[key].name, description: FLAGS[key].description };
  if (override !== undefined) {
    return { ...base, enabled: override, source: 'override', switchedAt: null };
  }
  if (switched) {
    return {
      ...base,
      enabled: switched.enabled,
      source: 'organization',
      switchedAt: switched.updatedAt.toISOString(),
    };
  }
  return { ...base, enabled: false, source: 'default', switchedAt: null };
}

export function featureOff(key: OrgFeatureKey): ProblemError {
  return new ProblemError(404, 'feature-off', 'This feature is not switched on', {
    code: 'feature_off',
    detail: `The organization's owner can switch on "${key}" in Settings › Features.`,
  });
}

export function featureGate(options: {
  readonly workspace?: WorkspaceStore;
  readonly flagOverrides?: string;
}): FeatureGate {
  const overrides = parseOverrides(options.flagOverrides, (m) => console.warn(m));
  const overrideOf = (key: FlagKey) => overrides[key];
  const switched = async (orgId: string) =>
    options.workspace ? options.workspace.listFeatures(orgId) : [];

  const gate: FeatureGate = {
    async isOn(orgId, key) {
      const override = overrideOf(key);
      if (override !== undefined) return override;
      if (!options.workspace) return false;
      return options.workspace.featureOn(orgId, key);
    },
    async require(orgId, key) {
      if (!(await gate.isOn(orgId, key))) throw featureOff(key);
    },
    async list(orgId) {
      const rows = await switched(orgId);
      return ORG_FEATURE_KEYS.map((key) =>
        featureState(
          key,
          overrideOf(key),
          rows.find((r) => r.flag === key),
        ),
      );
    },
    overridden: (key) => overrideOf(key) !== undefined,
  };
  return gate;
}
