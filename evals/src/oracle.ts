import type { ExtractionInput, ExtractionRun, Extractor, ModelId } from '@expensewise/extraction';
import type { GroundTruth } from './truth.ts';

/**
 * Returns the known answers instead of calling a model, so a dry run proves the data,
 * scoring and report end to end (every field should score correct) without spending money.
 */
export class OracleExtractor implements Extractor {
  constructor(
    readonly model: ModelId,
    private readonly truthFor: (input: ExtractionInput) => GroundTruth,
  ) {}

  extract(input: ExtractionInput): Promise<ExtractionRun> {
    const t = this.truthFor(input);
    const high = 'high' as const;
    const amount = (value: string | undefined) => (value ? { value, confidence: high } : null);
    return Promise.resolve({
      outcome: 'extracted',
      extraction: {
        documentType: t.documentType,
        merchant: t.merchant ? { name: t.merchant, confidence: high } : null,
        date: t.date ? { value: t.date, confidence: high } : null,
        currency: { code: t.currency, confidence: high },
        total: amount(t.total),
        subtotal: amount(t.subtotal),
        taxes: t.taxTotal ? [{ label: 'Tax', value: t.taxTotal, confidence: high }] : [],
        tip: amount(t.tip),
        cardLastFour: t.cardLastFour ? { value: t.cardLastFour, confidence: high } : null,
        lineItems: [],
      },
      model: this.model,
      promptVersion: 'oracle',
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costNanoUsd: 0n,
    });
  }
}
