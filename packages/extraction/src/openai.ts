import { z } from 'zod';
import type { ExtractionInput, ExtractionRun, Extractor } from './extractor.ts';
import { costNanoUsd, MODELS, type OpenAIModelId, type TokenUsage } from './models.ts';
import type { ReceiptExtraction } from './schema.ts';
import { variantOf, type ExtractionVariant, type ExtractorOptions } from './variant.ts';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * An error answer from a provider's API, with its status, message and error code, such as
 * 429 `insufficient_quota`. Never carries the key.
 */
export class ProviderHttpError extends Error {
  override readonly name = 'ProviderHttpError';
  constructor(
    readonly status: number,
    readonly providerMessage: string | undefined,
    readonly code: string | undefined,
  ) {
    super(`The provider answered ${status}${providerMessage ? `: ${providerMessage}` : ''}`);
  }
}

type JsonSchema = { [key: string]: unknown };

/**
 * Structured outputs in strict mode need every object closed and every property listed as
 * required; a field that may be absent is nullable instead. The receipt schema already
 * follows that, and this makes sure of it rather than trusting the converter.
 */
export function strictJsonSchema(schema: JsonSchema): JsonSchema {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const out: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$schema') continue;
      out[key] = key === 'properties' ? mapValues(value as JsonSchema, visit) : visit(value);
    }
    if (out.type === 'object' && out.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties);
    }
    return out;
  };
  return visit(schema) as JsonSchema;
}

const mapValues = (o: JsonSchema, f: (v: unknown) => unknown) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

/** Each request's structure, made once, for the additions an organization has switched on. */
const JSON_SCHEMAS = new WeakMap<ExtractionVariant, JsonSchema>();
const jsonSchemaOf = (variant: ExtractionVariant) => {
  let schema = JSON_SCHEMAS.get(variant);
  if (!schema) {
    schema = strictJsonSchema(z.toJSONSchema(variant.schema));
    JSON_SCHEMAS.set(variant, schema);
  }
  return schema;
};

interface ResponsesAnswer {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
  };
}

/**
 * Reads a document with an OpenAI model through the Responses API and strict structured
 * outputs: the fallback reader for when no Claude model can read (ADR-0020). Same prompt,
 * same schema, no tools. Responses are not stored at OpenAI.
 */
export class OpenAIExtractor implements Extractor {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  private readonly asked: ExtractorOptions;

  constructor(
    private readonly apiKey: string,
    readonly model: OpenAIModelId,
    options: { fetch?: typeof fetch; timeoutMs?: number } & ExtractorOptions = {},
  ) {
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.asked = {
      fieldSources: options.fieldSources ?? false,
      journeys: options.journeys ?? false,
      purchases: options.purchases ?? false,
    };
  }

  async extract(input: ExtractionInput): Promise<ExtractionRun> {
    const { effort } = MODELS[this.model];
    const variant = variantOf(this.asked);
    const started = performance.now();
    const res = await this.doFetch(RESPONSES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        instructions: variant.system,
        input: [
          {
            role: 'user',
            content: [fileBlock(input), { type: 'input_text', text: 'Extract this document.' }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'receipt_extraction',
            schema: jsonSchemaOf(variant),
            strict: true,
          },
        },
        reasoning: { effort },
        max_output_tokens: 16_000,
        // Receipts are personal data: nothing is kept at OpenAI for later retrieval.
        store: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await httpError(res, this.apiKey);
    const answer = (await res.json()) as ResponsesAnswer;
    const latencyMs = Math.ceil(performance.now() - started);

    // OpenAI counts cached input inside input_tokens; Anthropic counts it apart. Split it so
    // each token is priced once.
    const cached = answer.usage?.input_tokens_details?.cached_tokens ?? 0;
    const usage: TokenUsage = {
      inputTokens: Math.max(0, (answer.usage?.input_tokens ?? 0) - cached),
      outputTokens: answer.usage?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
    const parts = (answer.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? []);
    const refused =
      parts.some((p) => p.type === 'refusal') ||
      answer.incomplete_details?.reason === 'content_filter';
    const parsed = refused
      ? undefined
      : variant.schema.safeParse(
          parseJson(
            parts
              .filter((p) => p.type === 'output_text')
              .map((p) => p.text ?? '')
              .join(''),
          ),
        );
    const outcome: ExtractionRun['outcome'] = refused
      ? 'refused'
      : answer.status === 'incomplete'
        ? 'truncated'
        : parsed?.success
          ? 'extracted'
          : 'invalid';
    return {
      outcome,
      extraction:
        outcome === 'extracted' && parsed?.success ? (parsed.data as ReceiptExtraction) : null,
      model: this.model,
      promptVersion: variant.promptVersion,
      schemaVersion: variant.schemaVersion,
      latencyMs,
      usage,
      costNanoUsd: costNanoUsd(this.model, usage),
    };
  }
}

function fileBlock(input: ExtractionInput) {
  const data = `data:${input.mediaType};base64,${Buffer.from(input.bytes).toString('base64')}`;
  if (input.mediaType === 'application/pdf') {
    return { type: 'input_file', filename: 'receipt.pdf', file_data: data };
  }
  // Receipts are small print; low detail would downscale them past legibility.
  return { type: 'input_image', image_url: data, detail: 'high' };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function httpError(res: Response, apiKey: string): Promise<ProviderHttpError> {
  const body = (await res.json().catch(() => undefined)) as
    { error?: { message?: unknown; code?: unknown } } | undefined;
  const message =
    typeof body?.error?.message === 'string'
      ? body.error.message.split(apiKey).join('[key]').slice(0, 300)
      : undefined;
  const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
  return new ProviderHttpError(res.status, message, code);
}
