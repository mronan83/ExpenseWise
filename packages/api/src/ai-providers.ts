import type { AiAuthScheme, AiProvider } from '@expensewise/db';

export type ProviderVerdict =
  | { readonly ok: true; readonly authScheme: AiAuthScheme }
  | { readonly ok: false; readonly reason: 'rejected' | 'unreachable'; readonly status?: number };

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

/**
 * Verifies keys against the providers' model lists, which cost nothing. Anthropic issues both
 * API keys (sent as x-api-key) and OAuth-style tokens (sent as a bearer token), so both are
 * tried, the preferred scheme first; the one that works is stored with the key.
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
    try {
      const res = await doFetch(MODELS_URL[provider], {
        headers: providerAuthHeaders(provider, key, scheme),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true, authScheme: scheme };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: 'rejected', status: res.status };
      }
      return { ok: false, reason: 'unreachable', status: res.status };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  };

  return async (provider, key, preferred) => {
    if (provider === 'openai') return attempt('openai', key, 'bearer');
    const order: AiAuthScheme[] =
      preferred === 'bearer' ? ['bearer', 'api_key'] : ['api_key', 'bearer'];
    const first = await attempt('anthropic', key, order[0]!);
    if (first.ok || first.reason === 'unreachable') return first;
    return attempt('anthropic', key, order[1]!);
  };
}
