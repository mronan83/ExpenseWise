import { describe, expect, it } from 'vitest';
import { createFlags, parseOverrides, type FlagSource } from './flags.ts';
import { FLAG_KEYS, FLAGS, isFlagKey } from './registry.ts';

const source = (values: Record<string, boolean>): FlagSource => ({
  evaluate: () => Promise.resolve(values),
});
const quiet = () => {};

describe('registry', () => {
  it('lists every flag with a description', () => {
    expect(FLAG_KEYS).toContain('shell.build-version');
    for (const key of FLAG_KEYS) expect(FLAGS[key].description.length).toBeGreaterThan(10);
  });

  it('knows its own flags and nothing else', () => {
    expect(isFlagKey('shell.build-version')).toBe(true);
    expect(isFlagKey('toString')).toBe(false);
    expect(isFlagKey('shell.unknown')).toBe(false);
  });
});

describe('parseOverrides', () => {
  it('reads on and off values, and a bare key as on', () => {
    expect(parseOverrides('shell.build-version=off')).toEqual({ 'shell.build-version': false });
    expect(parseOverrides(' shell.build-version = ON ')).toEqual({ 'shell.build-version': true });
    expect(parseOverrides('shell.build-version')).toEqual({ 'shell.build-version': true });
    expect(parseOverrides(undefined)).toEqual({});
    expect(parseOverrides(' , ')).toEqual({});
  });

  it('reports and ignores unknown flags and unreadable values', () => {
    const logged: string[] = [];
    const log = (m: string) => logged.push(m);
    expect(parseOverrides('shell.nope=on,shell.build-version=maybe', log)).toEqual({});
    expect(logged).toEqual([
      'FLAG_OVERRIDES: ignoring unknown flag "shell.nope"',
      'FLAG_OVERRIDES: ignoring "shell.build-version=maybe"; use on or off',
    ]);
  });
});

describe('createFlags', () => {
  it('is off by default, with no source and no overrides', async () => {
    expect(await createFlags().isEnabled('shell.build-version')).toBe(false);
  });

  it('follows the source, and reads a flag the source omits as off', async () => {
    expect(
      await createFlags({ source: source({ 'shell.build-version': true }) }).isEnabled(
        'shell.build-version',
      ),
    ).toBe(true);
    expect(await createFlags({ source: source({}) }).isEnabled('shell.build-version')).toBe(false);
  });

  it('lets an override beat the source in both directions', async () => {
    const on = source({ 'shell.build-version': true });
    const off = source({ 'shell.build-version': false });
    const killed = createFlags({ source: on, overrides: 'shell.build-version=off' });
    const forced = createFlags({ source: off, overrides: 'shell.build-version=on' });
    expect(await killed.isEnabled('shell.build-version')).toBe(false);
    expect(await forced.isEnabled('shell.build-version')).toBe(true);
  });

  it('reads a flag as off when the source fails', async () => {
    const logged: string[] = [];
    const failing: FlagSource = { evaluate: () => Promise.reject(new Error('down')) };
    const flags = createFlags({ source: failing, log: (m) => logged.push(m) });
    expect(await flags.isEnabled('shell.build-version')).toBe(false);
    expect(logged).toEqual([
      'Flags: evaluating "shell.build-version" failed; using the default (off)',
    ]);
  });

  it('reads a flag as off when the source is too slow', async () => {
    const slow: FlagSource = {
      evaluate: () =>
        new Promise((resolve) => setTimeout(() => resolve({ 'shell.build-version': true }), 200)),
    };
    const flags = createFlags({ source: slow, timeoutMs: 10, log: quiet });
    expect(await flags.isEnabled('shell.build-version')).toBe(false);
  });

  it('asks the source for every flag at once, for the given user', async () => {
    const asked: unknown[] = [];
    const recording: FlagSource = {
      evaluate: (keys, context) => {
        asked.push({ keys, context });
        return Promise.resolve({});
      },
    };
    await createFlags({ source: recording }).isEnabled('shell.build-version', {
      distinctId: 'user_1',
    });
    expect(asked).toEqual([{ keys: FLAG_KEYS, context: { distinctId: 'user_1' } }]);
  });
});
