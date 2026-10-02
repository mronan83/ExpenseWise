import { describe, expect, it } from 'vitest';
import {
  isPlausibleKey,
  normalizeProviderKey,
  providerAuthHeaders,
  providerKeyVerifier,
} from '../src/ai-providers.ts';

type Call = { url: string; headers: Record<string, string> };

/** A fetch that answers by auth header, recording what was sent. */
function fakeFetch(answer: (call: Call) => number | Error | [number, unknown]) {
  const calls: Call[] = [];
  const doFetch = (input: string, init?: RequestInit) => {
    const call = { url: input, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) return Promise.reject(result);
    const [status, body] = Array.isArray(result) ? result : [result, {}];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
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

  it("reports a key both schemes reject as rejected, with Anthropic's own message", async () => {
    const { fetch } = fakeFetch((c) =>
      c.headers['x-api-key']
        ? [
            401,
            {
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid x-api-key' },
            },
          ]
        : [401, { type: 'error', error: { message: 'OAuth authentication is not supported' } }],
    );
    expect(await providerKeyVerifier({ fetch })('anthropic', 'sk-ant-api03-k')).toEqual({
      ok: false,
      reason: 'rejected',
      status: 401,
      detail: 'invalid x-api-key',
    });
    // An OAuth-style token is reported from the bearer attempt, the one it is made for.
    expect(await providerKeyVerifier({ fetch })('anthropic', 'sk-ant-oat01-k')).toMatchObject({
      detail: 'OAuth authentication is not supported',
    });
  });

  it('tries the other scheme after any answer, not only a 401', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.headers['x-api-key'] ? [400, { error: { message: 'wrong header' } }] : 200,
    );
    expect(await providerKeyVerifier({ fetch })('anthropic', 'k')).toEqual({
      ok: true,
      authScheme: 'bearer',
    });
    expect(calls).toHaveLength(2);
  });

  it('calls a 400 refused, and a 429 or 5xx unreachable, keeping the status and message', async () => {
    const refused = fakeFetch(() => [400, { error: { message: 'bad request' } }]);
    expect(await providerKeyVerifier({ fetch: refused.fetch })('anthropic', 'k')).toEqual({
      ok: false,
      reason: 'refused',
      status: 400,
      detail: 'bad request',
    });
    const busy = fakeFetch(() => [
      529,
      { error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]);
    expect(await providerKeyVerifier({ fetch: busy.fetch })('anthropic', 'k')).toEqual({
      ok: false,
      reason: 'unreachable',
      status: 529,
      detail: 'Overloaded',
    });
  });

  it('reports no answer as unreachable, without the error text or trying further', async () => {
    const leaky = new TypeError(
      'Headers.append: "x-api-key: sk-secret" is an invalid header value',
      {
        cause: { code: 'UND_ERR_INVALID_ARG' },
      },
    );
    const offline = fakeFetch(() => leaky);
    const verdict = await providerKeyVerifier({ fetch: offline.fetch })('anthropic', 'sk-secret');
    expect(verdict).toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'the request failed (UND_ERR_INVALID_ARG)',
    });
    expect(JSON.stringify(verdict)).not.toContain('sk-secret');
    expect(offline.calls).toHaveLength(1);
    const slow = fakeFetch(() => Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    expect(
      await providerKeyVerifier({ fetch: slow.fetch, timeoutMs: 8000 })('openai', 'k'),
    ).toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'no answer within 8 seconds',
    });
  });

  it('never repeats the key, even if the provider echoes it', async () => {
    const { fetch } = fakeFetch(() => [401, { error: { message: 'key sk-echo-me is not valid' } }]);
    const verdict = await providerKeyVerifier({ fetch })('openai', 'sk-echo-me');
    expect(verdict).toMatchObject({ detail: 'key [key] is not valid' });
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

describe('normalizeProviderKey', () => {
  it('removes what copying adds and keys never contain', () => {
    expect(normalizeProviderKey('  sk-ant-api03-abc\n  def\u200B ')).toBe('sk-ant-api03-abcdef');
    expect(normalizeProviderKey('ANTHROPIC_API_KEY="sk-ant-api03-abc"')).toBe('sk-ant-api03-abc');
    expect(normalizeProviderKey('\u201Csk-proj-abc\u201D')).toBe('sk-proj-abc');
  });

  it('leaves a clean key as it is, and spots what still is not one', () => {
    expect(normalizeProviderKey('sk-ant-api03-AbC_123-xyz')).toBe('sk-ant-api03-AbC_123-xyz');
    expect(isPlausibleKey('sk-ant-api03-AbC_123-xyz')).toBe(true);
    expect(isPlausibleKey('sk-ant-\u00e9t\u00e9-key')).toBe(false);
    expect(isPlausibleKey('short')).toBe(false);
  });
});
