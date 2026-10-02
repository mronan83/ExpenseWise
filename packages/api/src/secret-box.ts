import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets, such as AI provider keys, for storage (ADR-0015). AES-256-GCM with
 * a random 96-bit nonce per seal. The context (organization and provider) is bound in as
 * additional authenticated data, so a ciphertext copied to another row will not open.
 */
export interface SecretBox {
  seal(plaintext: string, context: string): string;
  /** Throws SecretBoxError when the ciphertext was made with another key or context. */
  open(sealed: string, context: string): string;
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Derives the encryption key from a server-only secret with HKDF-SHA-256. The deployment
 * passes APP_ENCRYPTION_KEY when set, otherwise SUPABASE_SECRET_KEY, so no extra setting is
 * needed. Rotating the source secret makes stored keys unreadable; they are then entered again.
 */
export function createSecretBox(
  masterSecret: string,
  purpose = 'expensewise/ai-provider-keys/v1',
): SecretBox {
  if (masterSecret.length < 16) {
    throw new SecretBoxError('The encryption secret must be at least 16 characters');
  }
  const key = Buffer.from(hkdfSync('sha256', masterSecret, 'expensewise', purpose, 32));

  return {
    seal(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const sealed = Buffer.concat([nonce, cipher.getAuthTag(), body]);
      return `${VERSION}.${sealed.toString('base64url')}`;
    },
    open(sealed, context) {
      const [version, encoded] = sealed.split('.', 2);
      if (version !== VERSION || !encoded) throw new SecretBoxError('Unknown ciphertext format');
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length <= NONCE_BYTES + TAG_BYTES) throw new SecretBoxError('Ciphertext too short');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, NONCE_BYTES));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
        const body = bytes.subarray(NONCE_BYTES + TAG_BYTES);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretBoxError('The stored secret cannot be decrypted with the current key');
      }
    },
  };
}

/** The last four characters, shown so the owner can tell which key is stored. */
export function keyHint(secret: string): string {
  return secret.slice(-4);
}
