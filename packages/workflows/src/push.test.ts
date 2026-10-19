import type { PendingPush, PushOutcome } from '@expensewise/db';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { sweepPush, webPushSender, type PushSweepPorts, type VapidIdentity } from './push.ts';

const NOW = new Date('2026-10-19T15:02:00Z');
const MESSAGE = {
  title: 'Receipt from Delta filed',
  body: 'The receipt you emailed is read and filed.',
  url: '/receipts/r1',
  tag: 'expensewise-m1',
};

const vapid = (): VapidIdentity => ({
  subject: 'https://expensewise.example',
  ...webpush.generateVAPIDKeys(),
});

/** A browser's keys, kept so a test can read what was sent to it. */
function browser(endpoint = 'https://web.push.apple.com/QGuQ2sp') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    device: {
      id: 'd1',
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: auth.toString('base64url'),
      },
    },
    /** Opens an aes128gcm body (RFC 8291) the way the browser does. */
    open(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idLength = body.readUInt8(20);
      const serverKey = body.subarray(21, 21 + idLength);
      const content = body.subarray(21 + idLength);
      const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) => {
        const prk = createHmac('sha256', salt).update(ikm).digest();
        return createHmac('sha256', prk)
          .update(Buffer.concat([info, Buffer.from([1])]))
          .digest()
          .subarray(0, length);
      };
      const shared = ecdh.computeSecret(serverKey);
      const keyInfo = Buffer.concat([
        Buffer.from('WebPush: info\0'),
        ecdh.getPublicKey(),
        serverKey,
      ]);
      const ikm = hkdf(auth, shared, keyInfo, 32);
      const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
      const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(content.subarray(content.length - 16));
      const plain = Buffer.concat([
        decipher.update(content.subarray(0, content.length - 16)),
        decipher.final(),
      ]);
      // The record ends with the delimiter 2 and any padding.
      return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
    },
  };
}

describe('sending a push (RFC 8030, RFC 8291, RFC 8292)', () => {
  it('sends it encrypted for the device and signed with the server’s key, for a day', async () => {
    const b = browser();
    const calls: { url: string; init: RequestInit }[] = [];
    const send = webPushSender(vapid(), (url, init) => {
      calls.push({ url: url as string, init: init! });
      return Promise.resolve(new Response(null, { status: 201 }));
    });
    expect(await send(b.device, MESSAGE)).toBe('sent');
    const [call] = calls;
    expect(call!.url).toBe(b.device.endpoint);
    const headers = call!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      TTL: '86400',
      Urgency: 'normal',
      'Content-Encoding': 'aes128gcm',
    });
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const body = Buffer.from(call!.init.body as Uint8Array);
    // Only the device can read it: no word of it is in the clear.
    expect(body.toString('latin1')).not.toContain('Delta');
    expect(JSON.parse(b.open(body))).toEqual(MESSAGE);
  });

  it('drops a device only when its service says the subscription has ended', async () => {
    const b = browser();
    const answering = (status: number) =>
      webPushSender(vapid(), () => Promise.resolve(new Response(null, { status })));
    expect(await answering(410)(b.device, MESSAGE)).toBe('gone');
    expect(await answering(404)(b.device, MESSAGE)).toBe('gone');
    // A 403 can be our own signing: tried again, never every device dropped at once.
    expect(await answering(403)(b.device, MESSAGE)).toBe('failed');
    expect(await answering(429)(b.device, MESSAGE)).toBe('failed');
    expect(await answering(503)(b.device, MESSAGE)).toBe('failed');
    const unreachable = webPushSender(vapid(), () => Promise.reject(new TypeError('fetch failed')));
    expect(await unreachable(b.device, MESSAGE)).toBe('failed');
  });
});

function ports(due: string[], failing: string[] = []) {
  const settled: { orgId: string; outcomes: readonly PushOutcome[] }[] = [];
  const asked: boolean[] = [];
  const push = (orgId: string): PendingPush => ({
    memberId: `${orgId}-m`,
    notificationIds: [`${orgId}-n1`, `${orgId}-n2`],
    message: MESSAGE,
    devices: [
      {
        id: `${orgId}-iphone`,
        endpoint: 'https://web.push.apple.com/a',
        keys: browser().device.keys,
      },
      { id: `${orgId}-old`, endpoint: 'https://web.push.apple.com/b', keys: browser().device.keys },
    ],
  });
  const p: PushSweepPorts = {
    now: () => NOW,
    dueOrganizations: (_now, reminders) => {
      asked.push(reminders);
      return Promise.resolve(due);
    },
    prepare: (orgId) =>
      failing.includes(orgId)
        ? Promise.reject(new Error(`${orgId} broke`))
        : Promise.resolve({ read: 3, made: 2 }),
    pending: (orgId) => Promise.resolve([push(orgId)]),
    send: (device) => Promise.resolve(device.id.endsWith('-old') ? 'gone' : 'sent'),
    settle: (orgId, outcomes) => {
      settled.push({ orgId, outcomes });
      return Promise.resolve();
    },
  };
  return { p, settled, asked };
}

describe('the sweep (R-PUSH-EVERY)', () => {
  it('makes each organization’s notifications, sends one push to each device, and records it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { p, settled, asked } = ports(['org-a', 'org-b']);
    expect(await sweepPush(p)).toEqual({
      organizations: 2,
      made: 4,
      pushes: 2,
      sent: 2,
      gone: 2,
      failed: 0,
    });
    // 15:02 is in the first sweep of the hour, so reports to remind of are looked for.
    expect(asked).toEqual([true]);
    expect(settled[0]).toEqual({
      orgId: 'org-a',
      outcomes: [
        { notificationIds: ['org-a-n1', 'org-a-n2'], sent: ['org-a-iphone'], gone: ['org-a-old'] },
      ],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('web.push.apple.com');
    log.mockRestore();
  });

  it('carries on past an organization that fails, then fails the run to be retried', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { p, settled, asked } = ports(['org-a', 'org-b'], ['org-a']);
    p.now = () => new Date('2026-10-19T15:10:00Z');
    await expect(sweepPush(p)).rejects.toThrow('Push failed for 1 organization(s)');
    expect(settled.map((s) => s.orgId)).toEqual(['org-b']);
    expect(asked).toEqual([false]);
    log.mockRestore();
  });
});
