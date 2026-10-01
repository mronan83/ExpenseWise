import { formatUnits } from '@expensewise/domain';

/**
 * The model tiers the extraction spike compares (ADR-0006), with list prices from the
 * Claude API reference cached 2026-09-25. Prices are integer nano-dollars per token,
 * so $4 per million tokens is 4000, and cost arithmetic never touches a float.
 */
export const MODELS = {
  'claude-fable-5-1': {
    label: 'Fable 5.1',
    tier: 'most capable',
    effort: 'low',
    price: { input: 10_000n, output: 50_000n, cacheRead: 250n, cacheWrite: 12_500n },
  },
  'claude-opus-5-5': {
    label: 'Opus 5.5',
    tier: 'upper mid',
    effort: 'low',
    price: { input: 4_000n, output: 20_000n, cacheRead: 200n, cacheWrite: 5_000n },
  },
  'claude-sonnet-5-5': {
    label: 'Sonnet 5.5',
    tier: 'mid',
    effort: 'low',
    price: { input: 2_000n, output: 10_000n, cacheRead: 200n, cacheWrite: 2_500n },
  },
  'claude-haiku-4-5': {
    label: 'Haiku 4.5',
    tier: 'smallest',
    // Haiku 4.5 rejects the effort setting and thinks only when given a token budget,
    // so it runs without either.
    effort: null,
    price: { input: 1_000n, output: 5_000n, cacheRead: 100n, cacheWrite: 1_250n },
  },
} as const;

export type ModelId = keyof typeof MODELS;
export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export function isModelId(value: string): value is ModelId {
  return Object.hasOwn(MODELS, value);
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Cost of one call in nano-dollars. Thinking tokens are billed as output tokens. */
export function costNanoUsd(model: ModelId, usage: TokenUsage): bigint {
  const price = MODELS[model].price;
  return (
    BigInt(usage.inputTokens) * price.input +
    BigInt(usage.outputTokens) * price.output +
    BigInt(usage.cacheReadTokens) * price.cacheRead +
    BigInt(usage.cacheWriteTokens) * price.cacheWrite
  );
}

/** Nano-dollars as a dollar string with six decimals, e.g. 12_345_678n → "0.012346". */
export function formatUsd(nano: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(9 - decimals);
  const rounded = (nano + divisor / 2n) / divisor;
  return formatUnits(rounded, decimals);
}
