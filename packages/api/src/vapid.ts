import { createECDH, hkdfSync } from 'node:crypto';

/*
 * The server's VAPID keys (RFC 8292, ADR-0053): the P-256 key pair it signs pushes with, so
 * Apple's push service and the others know each comes from the server the browser subscribed
 * to. One pair for the whole app, derived from the same server-only secret as the SecretBox
 * with its own HKDF label, so there is no key to keep or set. Rotating the secret changes the
 * keys; each device then subscribes again when Settings › Notifications next opens on it
 * (renewThisDevice() in the web app).
 */

export interface VapidKeys {
  /** The uncompressed public point (65 bytes), base64url: what a browser subscribes with. */
  readonly publicKey: string;
  /** The private scalar (32 bytes), base64url. Server-only; never logged or returned. */
  readonly privateKey: string;
}

/** The order of P-256: a private scalar is from 1 to one less than this. */
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/**
 * Derives the VAPID key pair from the server's secret. The same secret always gives the same
 * pair. A draw outside P-256's range, about one in four billion, is drawn again.
 */
export function vapidKeys(masterSecret: string): VapidKeys {
  if (masterSecret.length < 16) throw new Error('The secret must be at least 16 characters');
  for (let counter = 0; ; counter++) {
    const scalar = Buffer.from(
      hkdfSync(
        'sha256',
        masterSecret,
        'expensewise',
        `expensewise/web-push-vapid/v1/${counter}`,
        32,
      ),
    );
    const value = BigInt(`0x${scalar.toString('hex')}`);
    if (value === 0n || value >= P256_ORDER) continue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    return {
      publicKey: ecdh.getPublicKey().toString('base64url'),
      privateKey: scalar.toString('base64url'),
    };
  }
}
