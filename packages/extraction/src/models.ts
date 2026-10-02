import { formatUnits } from '@expensewise/domain';

/**
 * The models that read receipts, with list prices: Claude from the Claude API reference cached
 * 2026-09-25 (the tiers the extraction spike compares, ADR-0006), OpenAI from its pricing page
 * read 2026-10-02 (the fallback reader, ADR-0020). Prices are integer nano-dollars per token,
 * so $4 per million tokens is 4000, and cost arithmetic never touches a float.
 */
export const MODELS = {
  'claude-fable-5-1': {
    provider: 'anthropic',
    label: 'Fable 5.1',
    tier: 'most capable',
    effort: 'low',
    price: { input: 10_000n, output: 50_000n, cacheRead: 250n, cacheWrite: 12_500n },
  },
  'claude-opus-5-5': {
    provider: 'anthropic',
    label: 'Opus 5.5',
    tier: 'upper mid',
    effort: 'low',
    price: { input: 4_000n, output: 20_000n, cacheRead: 200n, cacheWrite: 5_000n },
  },
  'claude-sonnet-5-5': {
    provider: 'anthropic',
    label: 'Sonnet 5.5',
    tier: 'mid',
    effort: 'low',
    price: { input: 2_000n, output: 10_000n, cacheRead: 200n, cacheWrite: 2_500n },
  },
  'claude-haiku-4-5': {
    provider: 'anthropic',
    label: 'Haiku 4.5',
    tier: 'smallest',
    // Haiku 4.5 rejects the effort setting and thinks only when given a token budget,
    // so it runs without either.
    effort: null,
    price: { input: 1_000n, output: 5_000n, cacheRead: 100n, cacheWrite: 1_250n },
  },
  'gpt-5.6-luna': {
    provider: 'openai',
    label: 'GPT-5.6 Luna',
    tier: 'fallback',
    effort: 'low',
    // OpenAI bills cached input but doesn't charge to write the cache.
    price: { input: 200n, output: 1_200n, cacheRead: 20n, cacheWrite: 0n },
  },
} as const;

export type ModelId = keyof typeof MODELS;
export type ModelProvider = (typeof MODELS)[ModelId]['provider'];
export type ClaudeModelId = {
  [K in ModelId]: (typeof MODELS)[K]['provider'] extends 'anthropic' ? K : never;
}[ModelId];
export type OpenAIModelId = {
  [K in ModelId]: (typeof MODELS)[K]['provider'] extends 'openai' ? K : never;
}[ModelId];

/** The Claude models: what the eval harness and the comparison choose between. */
export const MODEL_IDS = (Object.keys(MODELS) as ModelId[]).filter(
  (id): id is ClaudeModelId => MODELS[id].provider === 'anthropic',
);

/**
 * Reads a receipt only when no Claude model could: no credit, a rejected key, an outage
 * (ADR-0020). Small and cheap, since it reads a receipt that would otherwise go unread.
 */
export const FALLBACK_MODEL = 'gpt-5.6-luna' satisfies OpenAIModelId;

/**
 * Every receipt is read by both tiers the product owner approved for the extraction spike,
 * so the tier decision rests on their own receipts (ADR-0017). One tier is dropped once the
 * decision is made.
 */
export const COMPARISON_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-5-5',
] as const satisfies readonly ClaudeModelId[];

export function isModelId(value: string): value is ModelId {
  return Object.hasOwn(MODELS, value);
}

export function isClaudeModelId(value: string): value is ClaudeModelId {
  return isModelId(value) && MODELS[value].provider === 'anthropic';
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
