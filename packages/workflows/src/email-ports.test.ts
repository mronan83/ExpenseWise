import { NonRetriableError } from 'inngest';
import { describe, expect, it } from 'vitest';
import { birdApiBase, birdRawMessage } from './email-ports.ts';

const EMAIL = { provider: 'bird', messageId: 'rem_01abc', threadId: 'thr_01xyz' } as const;

function fakeFetch(status: number, body = '') {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(new Response(status === 204 ? null : body, { status }));
  };
  return { impl, calls };
}

describe('Bird', () => {
  it('sends a key to the region it was made in', () => {
    expect(birdApiBase('bk_us1_abc')).toBe('https://us1.platform.bird.com');
    expect(birdApiBase('bk_eu1_abc')).toBe('https://eu1.platform.bird.com');
    expect(birdApiBase('something-else')).toBe('https://us1.platform.bird.com');
  });

  it('fetches the message as it arrived, with the key', async () => {
    const f = fakeFetch(200, 'From: riley@example.com\r\n\r\nhi');
    const raw = await birdRawMessage('bk_us1_key', f.impl)(EMAIL);
    expect(new TextDecoder().decode(raw as Uint8Array)).toContain('riley@example.com');
    expect(f.calls[0]?.url).toBe(
      'https://us1.platform.bird.com/v1/email/threads/thr_01xyz/messages/rem_01abc/raw',
    );
    expect(new Headers(f.calls[0]?.init?.headers).get('authorization')).toBe('Bearer bk_us1_key');
  });

  it('says the message is gone once Bird no longer keeps it', async () => {
    expect(await birdRawMessage('bk_us1_key', fakeFetch(410).impl)(EMAIL)).toBe('gone');
  });

  it('stops at a rejected key, and tries again when Bird is busy or not ready', async () => {
    const fails = (status: number) => birdRawMessage('bk_us1_key', fakeFetch(status).impl)(EMAIL);
    await expect(fails(401)).rejects.toThrow('BIRD_API_KEY needs the mailbox:read scope');
    await expect(fails(401)).rejects.toBeInstanceOf(NonRetriableError);
    await expect(fails(400)).rejects.toBeInstanceOf(NonRetriableError);
    for (const status of [404, 429, 503]) {
      await expect(fails(status)).rejects.toThrow(`Bird answered ${status}`);
      await expect(fails(status)).rejects.not.toBeInstanceOf(NonRetriableError);
    }
  });
});
