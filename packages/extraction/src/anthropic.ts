import Anthropic from '@anthropic-ai/sdk';

/** Anthropic's header for OAuth-style tokens sent as a bearer token. */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

export interface StoredAnthropicKey {
  readonly key: string;
  /** How Anthropic accepted the key when it was saved (ADR-0015). */
  readonly authScheme: 'api_key' | 'bearer';
}

/**
 * An Anthropic client for an organization's own key. Both credentials are passed
 * explicitly, so nothing in the server's environment can stand in for the stored key.
 */
export function anthropicClient(
  stored: StoredAnthropicKey,
  options: { timeoutMs?: number; maxRetries?: number } = {},
): Anthropic {
  const common = {
    timeout: options.timeoutMs ?? 90_000,
    maxRetries: options.maxRetries ?? 2,
    credentials: null,
  };
  return stored.authScheme === 'bearer'
    ? new Anthropic({
        ...common,
        apiKey: null,
        authToken: stored.key,
        defaultHeaders: { 'anthropic-beta': ANTHROPIC_OAUTH_BETA },
      })
    : new Anthropic({ ...common, apiKey: stored.key, authToken: null });
}
