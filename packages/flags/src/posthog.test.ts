import { beforeEach, describe, expect, it, vi } from 'vitest';
import { posthogSource, SERVER_DISTINCT_ID } from './posthog.ts';

const evaluateFlags = vi.fn();
vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function PostHog() {
    return { evaluateFlags };
  }),
}));

function snapshot(values: Record<string, boolean | string>) {
  return { getFlag: (key: string) => values[key] };
}

describe('posthogSource', () => {
  beforeEach(() => evaluateFlags.mockReset());

  it('evaluates for the server when there is no user, and keeps only flags PostHog returned', async () => {
    evaluateFlags.mockResolvedValue(snapshot({ 'shell.build-version': true }));
    const source = posthogSource({ apiKey: 'phc_test' });
    expect(await source.evaluate(['shell.build-version'], {})).toEqual({
      'shell.build-version': true,
    });
    expect(evaluateFlags).toHaveBeenCalledWith(SERVER_DISTINCT_ID, {
      flagKeys: ['shell.build-version'],
    });

    evaluateFlags.mockResolvedValue(snapshot({}));
    const other = posthogSource({ apiKey: 'phc_test' });
    expect(await other.evaluate(['shell.build-version'], { distinctId: 'u1' })).toEqual({});
  });

  it('treats a multivariate value as on and false as off', async () => {
    evaluateFlags.mockResolvedValue(snapshot({ 'shell.build-version': 'variant-a' }));
    expect(
      await posthogSource({ apiKey: 'k' }).evaluate(['shell.build-version'], { distinctId: 'a' }),
    ).toEqual({ 'shell.build-version': true });
    evaluateFlags.mockResolvedValue(snapshot({ 'shell.build-version': false }));
    expect(
      await posthogSource({ apiKey: 'k' }).evaluate(['shell.build-version'], { distinctId: 'a' }),
    ).toEqual({ 'shell.build-version': false });
  });

  it('reuses an answer per user for the cache period, and retries after a failure', async () => {
    let clock = 0;
    const source = posthogSource({ apiKey: 'k', cacheMs: 1_000, now: () => clock });
    evaluateFlags.mockResolvedValue(snapshot({ 'shell.build-version': true }));
    await source.evaluate(['shell.build-version'], { distinctId: 'a' });
    await source.evaluate(['shell.build-version'], { distinctId: 'a' });
    expect(evaluateFlags).toHaveBeenCalledTimes(1);

    await source.evaluate(['shell.build-version'], { distinctId: 'b' });
    expect(evaluateFlags).toHaveBeenCalledTimes(2);

    clock = 1_000;
    evaluateFlags.mockRejectedValueOnce(new Error('down'));
    await expect(source.evaluate(['shell.build-version'], { distinctId: 'a' })).rejects.toThrow(
      'down',
    );
    await source.evaluate(['shell.build-version'], { distinctId: 'a' });
    expect(evaluateFlags).toHaveBeenCalledTimes(4);
  });
});
