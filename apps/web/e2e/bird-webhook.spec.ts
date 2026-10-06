import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E_BIRD_KEY } from './bird';

// A deployed preview is started with no signing secret of ours, so only a local run checks this.
test.skip(!!process.env.E2E_BASE_URL, 'needs the web app started with the e2e signing secret');

const URL = '/api/v1/inbound/bird';

const signed = (body: string) => {
  const id = 'msg_e2e';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', E2E_BIRD_KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  };
};

test.describe('Bird’s webhook, as a function of its own (#93)', () => {
  test('is answered by its own function, not the API’s, which leaves it unconfigured', async ({
    request,
  }) => {
    // The API's function would answer 503 email_in_not_configured; this one checks the signature.
    const res = await request.post(URL, {
      data: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type']).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'missing_headers' });
  });

  test('acknowledges a signed event it doesn’t read', async ({ request }) => {
    const body = JSON.stringify({ type: 'email_mailbox.thread_created', data: {} });
    const res = await request.post(URL, { data: body, headers: signed(body) });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
  });
});
