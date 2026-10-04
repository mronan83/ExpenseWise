import { describe, expect, it } from 'vitest';
import {
  checkModelSettings,
  DEFAULT_PRIMARY,
  defaultModelSettings,
  modelSettingsFrom,
  readingOrder,
  SETTINGS_MODELS,
} from './model-settings.ts';
import { MODELS } from './models.ts';

const every = (enabled: Record<string, boolean>) =>
  SETTINGS_MODELS.map((model) => ({ model, enabled: enabled[model] ?? false }));

describe('model settings', () => {
  it('offers every model, so any of them can be primary', () => {
    expect([...SETTINGS_MODELS].sort()).toEqual(Object.keys(MODELS).sort());
  });

  it('starts with Sonnet 5.5 primary, then Haiku 4.5 and GPT-5.6 Luna, the rest off', () => {
    const defaults = defaultModelSettings();
    expect(defaults.primary).toBe(DEFAULT_PRIMARY);
    expect(readingOrder(defaults)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-4-5',
      'gpt-5.6-luna',
    ]);
    expect(defaults.models.filter((m) => !m.enabled).map((m) => m.model)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
    ]);
  });

  it('reads with the primary first, then each back-up that is on, in the order set', () => {
    const checked = checkModelSettings({
      primary: 'gpt-5.6-luna',
      models: [
        { model: 'claude-haiku-4-5', enabled: true },
        { model: 'claude-fable-5-1', enabled: false },
        { model: 'claude-sonnet-5-5', enabled: true },
        { model: 'gpt-5.6-luna', enabled: true },
        { model: 'claude-opus-5-5', enabled: false },
      ],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(readingOrder(checked.value)).toEqual([
      'gpt-5.6-luna',
      'claude-haiku-4-5',
      'claude-sonnet-5-5',
    ]);
  });

  it('lets every model be off, with no primary, and then reads with none', () => {
    const checked = checkModelSettings({ primary: null, models: every({}) });
    expect(checked).toEqual({ ok: true, value: { primary: null, models: every({}) } });
    if (checked.ok) expect(readingOrder(checked.value)).toEqual([]);
  });

  it('needs exactly one primary, and it must be on', () => {
    expect(
      checkModelSettings({ primary: null, models: every({ 'claude-haiku-4-5': true }) }),
    ).toEqual({ ok: false, problem: { kind: 'no_primary' } });
    expect(
      checkModelSettings({
        primary: 'claude-opus-5-5',
        models: every({ 'claude-haiku-4-5': true }),
      }),
    ).toEqual({ ok: false, problem: { kind: 'primary_off', model: 'claude-opus-5-5' } });
    expect(
      checkModelSettings({ primary: 'gpt-4', models: every({ 'claude-haiku-4-5': true }) }),
    ).toEqual({ ok: false, problem: { kind: 'primary_off', model: 'gpt-4' } });
  });

  it('reads with the defaults until a choice is saved, and keeps a saved one current', () => {
    expect(modelSettingsFrom(undefined)).toEqual(defaultModelSettings());
    const saved = modelSettingsFrom({
      primary: 'retired-model',
      models: [
        { model: 'retired-model', enabled: true },
        { model: 'claude-haiku-4-5', enabled: true },
        { model: 'gpt-5.6-luna', enabled: false },
      ],
    });
    // A model that is gone is dropped, its place as primary taken by the first that is on,
    // and a model added since is off.
    expect(saved.primary).toBe('claude-haiku-4-5');
    expect(saved.models.map((m) => m.model).sort()).toEqual([...SETTINGS_MODELS].sort());
    expect(readingOrder(saved)).toEqual(['claude-haiku-4-5']);
  });

  it('needs every model listed once, and no other', () => {
    expect(
      checkModelSettings({ primary: null, models: [{ model: 'gpt-4', enabled: false }] }),
    ).toEqual({ ok: false, problem: { kind: 'unknown_model', model: 'gpt-4' } });
    expect(
      checkModelSettings({
        primary: null,
        models: [...every({}), { model: 'claude-haiku-4-5', enabled: true }],
      }),
    ).toEqual({ ok: false, problem: { kind: 'listed_twice', model: 'claude-haiku-4-5' } });
    expect(checkModelSettings({ primary: null, models: every({}).slice(1) })).toMatchObject({
      ok: false,
      problem: { kind: 'not_listed' },
    });
  });
});
