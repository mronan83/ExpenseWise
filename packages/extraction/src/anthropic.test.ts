import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicClient } from './anthropic.ts';

afterEach(() => vi.unstubAllEnvs());

describe('anthropicClient', () => {
  it('sends an API key as x-api-key and ignores any key in the environment', () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token-should-not-be-used');
    const client = anthropicClient({ key: 'stored-api-key', authScheme: 'api_key' });
    expect(client.apiKey).toBe('stored-api-key');
    expect(client.authToken).toBeNull();
  });

  it('sends an OAuth-style token as a bearer token with the beta header', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key-should-not-be-used');
    const client = anthropicClient({ key: 'stored-token', authScheme: 'bearer' });
    expect(client.apiKey).toBeNull();
    expect(client.authToken).toBe('stored-token');
  });
});
