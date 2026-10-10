import type { StoredModelSettings } from '@expensewise/db';
import {
  defaultModelSettings,
  MODELS,
  modelSettingsFrom,
  readingOrder,
  SETTINGS_MODELS,
  type ModelId,
  type ModelProvider,
} from '@expensewise/extraction';
import { modelStopped, parseOverrides } from '@expensewise/flags';

/**
 * Which models read an organization's receipts. compare: two models side by side, and the
 * fallback when neither could (ADR-0017, ADR-0020), less any model the operator stopped.
 * primary: the organization's AI model settings, in the order tried (FR-INT-16, ADR-0033).
 */
export type ReadingPlan =
  | { readonly mode: 'compare'; readonly stopped: readonly ModelId[] }
  | { readonly mode: 'primary'; readonly order: readonly ModelId[] };

/** Without AI model settings, or a way to read them: two models side by side, as before. */
export const SIDE_BY_SIDE: ReadingPlan = { mode: 'compare', stopped: [] };

/**
 * The plan for an organization's next reading. With AI model settings off, side by side as
 * before. With them on, its primary and then each back-up that is on, from what it saved or
 * the defaults, less a model whose provider it has no key for: that model stays off. Either
 * way a model the operator stopped in FLAG_OVERRIDES reads nothing.
 */
export function readingPlanFor(input: {
  /** Whether receipts.model-settings is on for the organization. */
  readonly settingsOn: boolean;
  readonly saved?: StoredModelSettings | undefined;
  /** FLAG_OVERRIDES. */
  readonly overrides?: string | undefined;
  /** The providers the organization has a key for; every one when not given. */
  readonly keyed?: ReadonlySet<ModelProvider> | undefined;
}): ReadingPlan {
  const stopped = stoppedModels(input.overrides);
  if (!input.settingsOn) return { mode: 'compare', stopped };
  return { mode: 'primary', order: modelOrderFor(input) };
}

const stoppedModels = (overrides: string | undefined) => {
  const parsed = parseOverrides(overrides);
  return SETTINGS_MODELS.filter((model) => modelStopped(model, parsed));
};

/**
 * The models anything but a receipt's side-by-side comparison reads with, in the order tried:
 * the organization's primary, then each back-up that is on (FR-INT-16, ADR-0050). With AI
 * model settings off, the defaults the settings start from. A model whose provider it has no
 * key for, or the operator stopped, is passed over.
 */
export function modelOrderFor(input: {
  readonly settingsOn: boolean;
  readonly saved?: StoredModelSettings | undefined;
  readonly overrides?: string | undefined;
  readonly keyed?: ReadonlySet<ModelProvider> | undefined;
}): ModelId[] {
  const stopped = stoppedModels(input.overrides);
  const settings = input.settingsOn ? modelSettingsFrom(input.saved) : defaultModelSettings();
  return readingOrder(settings).filter(
    (model) => !stopped.includes(model) && (input.keyed?.has(MODELS[model].provider) ?? true),
  );
}
