import { describe, expect, it } from 'vitest';
import { costNanoUsd, formatUsd, isModelId, MODEL_IDS, MODELS } from './models.ts';

describe('model price table', () => {
  it('covers the four tiers the spike compares, most capable first', () => {
    expect(MODEL_IDS).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-4-5',
    ]);
    expect(MODELS['claude-haiku-4-5'].effort).toBeNull();
    expect(isModelId('claude-opus-5-5')).toBe(true);
    expect(isModelId('gpt-4')).toBe(false);
  });

  it('prices a call exactly in nano-dollars', () => {
    // Opus 5.5: 2,000 in at $4/M + 500 out at $20/M = $0.008 + $0.010.
    const nano = costNanoUsd('claude-opus-5-5', {
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(nano).toBe(18_000_000n);
    expect(formatUsd(nano)).toBe('0.018000');
  });

  it('includes cache reads and writes', () => {
    const nano = costNanoUsd('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(formatUsd(nano, 2)).toBe('1.35');
  });

  it('rounds the display half up without floats', () => {
    expect(formatUsd(1_500n, 6)).toBe('0.000002');
    expect(formatUsd(1_499n, 6)).toBe('0.000001');
  });
});
