import { createPublicKey, createSign, createVerify, createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vapidKeys } from '../src/vapid.ts';

const SECRET = 'a-server-secret-of-some-length';

describe('the server’s VAPID keys (ADR-0053)', () => {
  it('are a P-256 pair that signs and verifies, the same from the same secret', () => {
    const keys = vapidKeys(SECRET);
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    expect(vapidKeys(SECRET)).toEqual(keys);
    const point = Buffer.from(keys.publicKey, 'base64url');
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'),
    };
    const privateKey = createPrivateKey({ key: { ...jwk, d: keys.privateKey }, format: 'jwk' });
    const signature = createSign('SHA256').update('a push').sign(privateKey);
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    expect(createVerify('SHA256').update('a push').verify(publicKey, signature)).toBe(true);
  });

  it('differ for another secret, and need a secret long enough', () => {
    expect(vapidKeys(`${SECRET}-2`).publicKey).not.toBe(vapidKeys(SECRET).publicKey);
    expect(() => vapidKeys('short')).toThrow('at least 16 characters');
  });
});
