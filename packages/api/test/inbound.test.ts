import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { ArrivedEmail } from '../src/inbound-routes.ts';
import { verifyStandardWebhook } from '../src/webhooks.ts';

const NOW = new Date('2026-10-03T18:00:00Z');
const SECONDS = String(NOW.getTime() / 1000);
const KEY = Buffer.from('a-test-signing-key-of-32-bytes!!');
const SECRET = `whsec_${KEY.toString('base64')}`;

const sign = (id: string, timestamp: string, body: string, key = KEY) =>
  `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;

const arrived = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'email_mailbox.message_received',
    timestamp: '2026-10-03T18:00:00Z',
    data: {
      message_id: 'rem_01abc',
      mailbox_id: 'mbx_01m414nd2jf769jm8rs7rb3cjv',
      thread_id: 'thr_01xyz',
      from: 'bounce@example.com',
      to: ['receipts@inbox.ai'],
      subject: 'Fwd: receipt',
      attachment_count: 1,
      spf_pass: true,
      dkim_pass: true,
      dmarc_pass: null,
      ...over,
    },
  });

function api(options: { secret?: string; fail?: boolean } = {}) {
  const received: ArrivedEmail[] = [];
  const app = createApi({
    version: 'test',
    now: () => NOW,
    birdWebhookSecret: 'secret' in options ? options.secret : SECRET,
    receiveEmail: (email) => {
      if (options.fail) return Promise.reject(new Error('Inngest is down'));
      received.push(email);
      return Promise.resolve();
    },
  });
  const post = (body: string, headers: Record<string, string> = {}) =>
    app.request('/v1/inbound/bird', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'msg_1',
        'webhook-timestamp': SECONDS,
        'webhook-signature': sign('msg_1', SECONDS, body),
        ...headers,
      },
      body,
    });
  return { post, received };
}

describe('checking a webhook signature', () => {
  const headers = { id: 'msg_1', timestamp: SECONDS, signature: sign('msg_1', SECONDS, '{}') };

  it('accepts the signature of the exact body, among others', () => {
    expect(verifyStandardWebhook(SECRET, headers, '{}', NOW)).toBe('valid');
    const rotated = { ...headers, signature: `v1,b2xk ${headers.signature}` };
    expect(verifyStandardWebhook(SECRET, rotated, '{}', NOW)).toBe('valid');
  });

  it('refuses another body, another secret, or no signature', () => {
    expect(verifyStandardWebhook(SECRET, headers, '{ }', NOW)).toBe('bad_signature');
    const other = `whsec_${Buffer.from('another-key').toString('base64')}`;
    expect(verifyStandardWebhook(other, headers, '{}', NOW)).toBe('bad_signature');
    expect(verifyStandardWebhook(SECRET, { ...headers, signature: 'v2,abc' }, '{}', NOW)).toBe(
      'bad_signature',
    );
    expect(verifyStandardWebhook(SECRET, { id: 'msg_1' }, '{}', NOW)).toBe('missing_headers');
  });

  it('refuses a delivery more than five minutes off', () => {
    const later = new Date(NOW.getTime() + 301_000);
    expect(verifyStandardWebhook(SECRET, headers, '{}', later)).toBe('stale');
    const earlier = new Date(NOW.getTime() - 301_000);
    expect(verifyStandardWebhook(SECRET, headers, '{}', earlier)).toBe('stale');
    expect(verifyStandardWebhook(SECRET, { ...headers, timestamp: 'soon' }, '{}', NOW)).toBe(
      'stale',
    );
  });
});

describe('POST /v1/inbound/bird', () => {
  it('hands an arriving email to the workflow and says it was accepted', async () => {
    const { post, received } = api();
    const res = await post(arrived());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
    expect(received).toEqual([{ provider: 'bird', messageId: 'rem_01abc', threadId: 'thr_01xyz' }]);
  });

  it('acknowledges other events and does nothing with them', async () => {
    const { post, received } = api();
    const body = JSON.stringify({ type: 'email.received', data: { message_id: 'rem_01abc' } });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
    expect(received).toEqual([]);
  });

  it('refuses a delivery whose signature does not match its body', async () => {
    const { post, received } = api();
    const res = await post(arrived(), { 'webhook-signature': sign('msg_1', SECONDS, '{}') });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'bad_signature' });
    const unsigned = await post(arrived(), { 'webhook-signature': '' });
    expect(unsigned.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('refuses a message id that could change where the email is fetched from', async () => {
    const { post, received } = api();
    const res = await post(arrived({ message_id: '../../v1/keys' }));
    expect(res.status).toBe(400);
    expect(received).toEqual([]);
  });

  it('answers 503 so Bird tries again when the hand-off fails', async () => {
    const res = await api({ fail: true }).post(arrived());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'hand_off_failed' });
  });

  it('answers 503 when email-in is not configured', async () => {
    const res = await api({ secret: undefined }).post(arrived());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'email_in_not_configured' });
  });
});
