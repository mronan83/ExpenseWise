import { describe, expect, it } from 'vitest';
import { providerAuthHeaders, providerKeyVerifier } from '../src/ai-providers.ts';

type Call = { url: string; headers: Record<string, string> };

/** A fetch that answers by auth header, recording what was sent. */
function fakeFetch(answer: (call: Call) => number | Error) {
  const calls: Call[] = [];
  const doFetch = (input: string, init?: RequestInit) => {
    const call = { url: input, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const result = answer(call);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(new Response('{}', { status: result }));
  };
  return { calls, fetch: doFetch as unknown as typeof fetch };
}

describe('providerKeyVerifier', () => {
  it('accepts an Anthropic API key sent as x-api-key', async () => {
    const { fetch, calls } = fakeFetch((c) => (c.headers['x-api-key'] ? 200 : 401));
    expect(await providerKeyVerifier({ fetch })('anthropic', 'k')).toEqual({
      ok: true,
      authScheme: 'api_key',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1');
  });

  it('falls back to a bearer token when Anthropic rejects the key as x-api-key', async () => {
    const { fetch, calls } = fakeFetch((c) => (c.headers.authorization === 'Bearer k' ? 200 : 401));
    expect(await providerKeyVerifier({ fetch })('anthropic', 'k')).toEqual({
      ok: true,
      authScheme: 'bearer',
    });
    expect(calls.map((c) => Object.keys(c.headers).sort())).toEqual([
      ['anthropic-version', 'x-api-key'],
      ['anthropic-beta', 'anthropic-version', 'authorization'],
    ]);
  });

  it('tries the stored scheme first when re-checking a key', async () => {
    const { fetch, calls } = fakeFetch(() => 200);
    await providerKeyVerifier({ fetch })('anthropic', 'k', 'bearer');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe('Bearer k');
  });

  it('reports a key both schemes reject as rejected, with the status', async () => {
    const { fetch } = fakeFetch(() => 401);
    expect(await providerKeyVerifier({ fetch })('anthropic', 'k')).toEqual({
      ok: false,
      reason: 'rejected',
      status: 401,
    });
  });

  it('reports outages and network errors as unreachable, without trying further', async () => {
    const down = fakeFetch(() => 529);
    expect(await providerKeyVerifier({ fetch: down.fetch })('anthropic', 'k')).toEqual({
      ok: false,
      reason: 'unreachable',
      status: 529,
    });
    expect(down.calls).toHaveLength(1);
    const offline = fakeFetch(() => new TypeError('fetch failed'));
    expect(await providerKeyVerifier({ fetch: offline.fetch })('openai', 'k')).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('checks OpenAI keys as bearer tokens against its model list', async () => {
    const { fetch, calls } = fakeFetch(() => 200);
    expect(await providerKeyVerifier({ fetch })('openai', 'sk-test')).toEqual({
      ok: true,
      authScheme: 'bearer',
    });
    expect(calls[0]).toEqual({
      url: 'https://api.openai.com/v1/models',
      headers: { authorization: 'Bearer sk-test' },
    });
  });
});

describe('providerAuthHeaders', () => {
  it('sends Anthropic bearer tokens with the OAuth beta header', () => {
    expect(providerAuthHeaders('anthropic', 't', 'bearer')).toEqual({
      authorization: 'Bearer t',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });
});
