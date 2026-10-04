import { isModelId, MODELS, type ModelId } from './models.ts';

/**
 * Which AI models read an organization's receipts, and in what order, once its owner has
 * switched on AI model settings (FR-INT-16, ADR-0033). Exactly one model that is on is the
 * primary and reads every receipt; any other model that is on is a back-up, tried in the
 * order set only when the models before it produced no reading (Q11).
 */
export interface ModelSetting {
  readonly model: ModelId;
  readonly enabled: boolean;
}

export interface ModelSettings {
  /** The model that reads every receipt; null only when every model is off. */
  readonly primary: ModelId | null;
  /** Every model once, in the order back-ups are tried. */
  readonly models: readonly ModelSetting[];
}

/** Every model an organization can switch: any of them can be primary (Q8). */
export const SETTINGS_MODELS = Object.keys(MODELS) as ModelId[];

/**
 * The primary until an owner chooses one: the more capable of the two tiers that read every
 * receipt before (ADR-0017), whose reading their expenses were filed with.
 */
export const DEFAULT_PRIMARY = 'claude-sonnet-5-5' satisfies ModelId;

/**
 * Before an owner saves a choice: the three models that read receipts before (ADR-0017,
 * ADR-0020) are on, Sonnet 5.5 first, then Haiku 4.5, then GPT-5.6 Luna. Opus 5.5 and
 * Fable 5.1 cost more and stay off until switched on.
 */
const DEFAULT_ORDER: readonly ModelId[] = [
  DEFAULT_PRIMARY,
  'claude-haiku-4-5',
  'gpt-5.6-luna',
  'claude-opus-5-5',
  'claude-fable-5-1',
];
const ON_BY_DEFAULT: ReadonlySet<ModelId> = new Set([
  DEFAULT_PRIMARY,
  'claude-haiku-4-5',
  'gpt-5.6-luna',
]);

export function defaultModelSettings(): ModelSettings {
  return {
    primary: DEFAULT_PRIMARY,
    models: DEFAULT_ORDER.map((model) => ({ model, enabled: ON_BY_DEFAULT.has(model) })),
  };
}

/** Why a choice of models can't be saved. */
export type ModelSettingsProblem =
  | { readonly kind: 'unknown_model'; readonly model: string }
  | { readonly kind: 'listed_twice'; readonly model: ModelId }
  | { readonly kind: 'not_listed'; readonly models: readonly ModelId[] }
  | { readonly kind: 'primary_off'; readonly model: string }
  | { readonly kind: 'no_primary' };

/**
 * Checks a choice of models: every model listed once, in the order back-ups are tried, and a
 * primary that is on, or none when every model is off.
 */
export function checkModelSettings(input: {
  readonly primary: string | null;
  readonly models: readonly { readonly model: string; readonly enabled: boolean }[];
}): { ok: true; value: ModelSettings } | { ok: false; problem: ModelSettingsProblem } {
  const fail = (problem: ModelSettingsProblem) => ({ ok: false as const, problem });
  const models: ModelSetting[] = [];
  for (const { model, enabled } of input.models) {
    if (!isModelId(model)) return fail({ kind: 'unknown_model', model });
    if (models.some((m) => m.model === model)) return fail({ kind: 'listed_twice', model });
    models.push({ model, enabled });
  }
  const missing = SETTINGS_MODELS.filter((id) => !models.some((m) => m.model === id));
  if (missing.length > 0) return fail({ kind: 'not_listed', models: missing });
  const { primary } = input;
  if (primary === null) {
    return models.some((m) => m.enabled)
      ? fail({ kind: 'no_primary' })
      : { ok: true, value: { primary: null, models } };
  }
  const chosen = models.find((m) => m.model === primary);
  if (!chosen?.enabled) return fail({ kind: 'primary_off', model: primary });
  return { ok: true, value: { primary: chosen.model, models } };
}

/**
 * The settings an organization reads with: what it saved, or the defaults before anyone
 * saved a choice. A saved model that no longer exists is dropped and one added since is off,
 * at the end; a primary that is gone gives way to the first model that is on.
 */
export function modelSettingsFrom(saved?: {
  readonly primary: string | null;
  readonly models: readonly { readonly model: string; readonly enabled: boolean }[];
}): ModelSettings {
  if (!saved) return defaultModelSettings();
  const models: ModelSetting[] = [];
  for (const { model, enabled } of saved.models) {
    if (isModelId(model) && !models.some((m) => m.model === model)) {
      models.push({ model, enabled });
    }
  }
  for (const model of SETTINGS_MODELS) {
    if (!models.some((m) => m.model === model)) models.push({ model, enabled: false });
  }
  const on = models.filter((m) => m.enabled);
  const primary = (on.find((m) => m.model === saved.primary) ?? on[0])?.model ?? null;
  return { primary, models };
}

/** The models that read, in the order they are tried: the primary, then each back-up that is on. */
export function readingOrder(settings: ModelSettings): ModelId[] {
  const { primary } = settings;
  if (primary === null) return [];
  return [
    primary,
    ...settings.models.filter((m) => m.enabled && m.model !== primary).map((m) => m.model),
  ];
}
