import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ExtractionInput, ExtractionRun, Extractor } from './extractor.ts';
import { costNanoUsd, MODELS, type ClaudeModelId, type TokenUsage } from './models.ts';
import { EXTRACTION_VARIANTS, variantOf, type ExtractorOptions } from './variant.ts';

/** Each request's structure, made once: the source-line variant only where it is switched on. */
const FORMATS = {
  plain: zodOutputFormat(EXTRACTION_VARIANTS.plain.schema),
  sources: zodOutputFormat(EXTRACTION_VARIANTS.sources.schema),
};

/**
 * Reads a document with Claude vision and structured outputs. The model gets no tools,
 * so nothing printed on a receipt can make it do anything but fill the schema.
 */
export class ClaudeExtractor implements Extractor {
  constructor(
    private readonly client: Anthropic,
    readonly model: ClaudeModelId,
    private readonly options: ExtractorOptions = {},
  ) {}

  async extract(input: ExtractionInput): Promise<ExtractionRun> {
    const { effort } = MODELS[this.model];
    const variant = variantOf(this.options);
    const format = this.options.fieldSources ? FORMATS.sources : FORMATS.plain;
    const started = performance.now();
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: variant.system,
      messages: [
        {
          role: 'user',
          content: [documentBlock(input), { type: 'text', text: 'Extract this document.' }],
        },
      ],
      output_config: {
        format,
        ...(effort ? { effort } : {}),
      },
    });
    const latencyMs = Math.ceil(performance.now() - started);
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const outcome: ExtractionRun['outcome'] =
      response.stop_reason === 'refusal'
        ? 'refused'
        : response.stop_reason === 'max_tokens'
          ? 'truncated'
          : response.parsed_output
            ? 'extracted'
            : 'invalid';
    return {
      outcome,
      extraction: outcome === 'extracted' ? response.parsed_output : null,
      model: this.model,
      promptVersion: variant.promptVersion,
      schemaVersion: variant.schemaVersion,
      latencyMs,
      usage,
      costNanoUsd: costNanoUsd(this.model, usage),
    };
  }
}

function documentBlock(input: ExtractionInput): Anthropic.ContentBlockParam {
  const data = Buffer.from(input.bytes).toString('base64');
  if (input.mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: input.mediaType, data } };
}
