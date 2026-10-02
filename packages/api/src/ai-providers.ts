import type { AiAuthScheme, AiProvider } from '@expensewise/db';

export type ProviderVerdict =
  | { readonly ok: true; readonly authScheme: AiAuthScheme }
  | {
      readonly ok: false;
      /**
       * rejected: the provider refused the key itself (401, 403). refused: it answered with
       * another client error (400, 404). unreachable: no answer, or it is busy or failing
       * (429, 5xx), so trying again later may work.
       */
      readonly reason: 'rejected' | 'refused' | 'unreachable';
      readonly status?: number;
      /** The provider's own message, or why there was no answer. Never contains the key. */
      readonly detail?: string;
    };

/** Checks a key with a free call to the provider (listing models). Never logs the key. */
export type ProviderKeyVerifier = (
  provider: AiProvider,
  key: string,
  preferred?: AiAuthScheme,
) => Promise<ProviderVerdict>;

/** Anthropic accepts OAuth-style tokens as bearer tokens with this beta header. */
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

/** The request headers that authenticate `key` with `provider` under `scheme`. */
export function providerAuthHeaders(
  provider: AiProvider,
  key: string,
  scheme: AiAuthScheme,
): Record<string, string> {
  if (provider === 'openai') return { authorization: `Bearer ${key}` };
  return scheme === 'api_key'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : {
        authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_OAUTH_BETA,
      };
}

const MODELS_URL: Record<AiProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/models?limit=1',
  openai: 'https://api.openai.com/v1/models',
};

const INVISIBLE = /[\s\u200B-\u200D\u2060\uFEFF]+/g;
const ENV_PREFIX = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY)=/i;
const QUOTES = new Set(['"', "'", '`', '\u201C', '\u201D', '\u2018', '\u2019']);

/**
 * What the person meant to paste. API keys never contain whitespace, so line breaks, spaces
 * and invisible characters picked up when copying are removed, as are a pasted
 * `ANTHROPIC_API_KEY=` prefix and surrounding quotes.
 */
export function normalizeProviderKey(raw: string): string {
  let key = raw.replace(INVISIBLE, '').replace(ENV_PREFIX, '');
  let start = 0;
  let end = key.length;
  while (start < end && QUOTES.has(key[start]!)) start++;
  while (end > start && QUOTES.has(key[end - 1]!)) end--;
  key = key.slice(start, end);
  return key;
}

/** Keys are printable ASCII. Anything else can't be sent in a header, so it isn't a key. */
export const isPlausibleKey = (key: string) => /^[\x21-\x7E]{8,1000}$/.test(key);

/** The provider's error message from a failed response, with the key removed if echoed. */
async function providerMessage(res: Response, key: string): Promise<string | undefined> {
  const body = (await res.json().catch(() => undefined)) as
    { error?: { message?: unknown; type?: unknown } | string; message?: unknown } | undefined;
  const error = body?.error;
  const message =
    typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : typeof body?.message === 'string'
          ? body.message
          : undefined;
  return message?.split(key).join('[key]').slice(0, 300);
}

/** Why a request got no answer: a timeout or a network error code, never the error text. */
function failureDetail(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `no answer within ${timeoutMs / 1000} seconds`;
  }
  // Error messages can quote the request's headers, and so the key; codes can't.
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return `the request failed${typeof code === 'string' ? ` (${code})` : ''}`;
}

/**
 * Verifies keys against the providers' model lists, which cost nothing. Anthropic issues both
 * API keys (sent as x-api-key) and OAuth-style tokens (sent as a bearer token), so both are
 * tried, the preferred scheme first; the one that works is stored with the key. When neither
 * works, the answer to the scheme the key looks made for is reported.
 */
export function providerKeyVerifier(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): ProviderKeyVerifier {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  const attempt = async (
    provider: AiProvider,
    key: string,
    scheme: AiAuthScheme,
  ): Promise<ProviderVerdict> => {
    let res: Response;
    try {
      res = await doFetch(MODELS_URL[provider], {
        headers: providerAuthHeaders(provider, key, scheme),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: failureDetail(error, timeoutMs) };
    }
    if (res.ok) return { ok: true, authScheme: scheme };
    const detail = await providerMessage(res, key);
    const reason =
      res.status === 401 || res.status === 403
        ? 'rejected'
        : res.status === 429 || res.status >= 500
          ? 'unreachable'
          : 'refused';
    return { ok: false, reason, status: res.status, ...(detail ? { detail } : {}) };
  };

  return async (provider, key, preferred) => {
    if (provider === 'openai') return attempt('openai', key, 'bearer');
    const madeFor: AiAuthScheme = key.startsWith('sk-ant-oat') ? 'bearer' : 'api_key';
    const first = preferred ?? madeFor;
    const second: AiAuthScheme = first === 'bearer' ? 'api_key' : 'bearer';
    const firstVerdict = await attempt('anthropic', key, first);
    // No answer at all: the other scheme would get none either.
    if (firstVerdict.ok || (firstVerdict.reason === 'unreachable' && !firstVerdict.status)) {
      return firstVerdict;
    }
    const secondVerdict = await attempt('anthropic', key, second);
    if (secondVerdict.ok) return secondVerdict;
    return first === madeFor ? firstVerdict : secondVerdict;
  };
}
