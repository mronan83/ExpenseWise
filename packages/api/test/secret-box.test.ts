import { describe, expect, it } from 'vitest';
import { createSecretBox, keyHint, SecretBoxError } from '../src/secret-box.ts';

const box = createSecretBox('a-server-only-secret-of-some-length');

describe('secret box', () => {
  it('round-trips a secret, with a fresh nonce every time', () => {
    const a = box.seal('provider-key-123', 'org-1:anthropic');
    const b = box.seal('provider-key-123', 'org-1:anthropic');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain('provider-key-123');
    expect(box.open(a, 'org-1:anthropic')).toBe('provider-key-123');
  });

  it('refuses to open a ciphertext under another organization or provider', () => {
    const sealed = box.seal('provider-key-123', 'org-1:anthropic');
    expect(() => box.open(sealed, 'org-2:anthropic')).toThrow(SecretBoxError);
    expect(() => box.open(sealed, 'org-1:openai')).toThrow(SecretBoxError);
  });

  it('refuses to open with a different secret, or a tampered ciphertext', () => {
    const sealed = box.seal('provider-key-123', 'ctx');
    expect(() => createSecretBox('another-secret-entirely-xyz').open(sealed, 'ctx')).toThrow(
      SecretBoxError,
    );
    const bytes = Buffer.from(sealed.slice(3), 'base64url');
    bytes[bytes.length - 1]! ^= 1;
    expect(() => box.open(`v1.${bytes.toString('base64url')}`, 'ctx')).toThrow(SecretBoxError);
    expect(() => box.open('v2.abc', 'ctx')).toThrow(/Unknown ciphertext format/);
    expect(() => box.open('v1.AAAA', 'ctx')).toThrow(/too short/);
  });

  it('needs a secret of at least 16 characters', () => {
    expect(() => createSecretBox('short')).toThrow(/at least 16/);
  });

  it('shows only the last four characters as a hint', () => {
    expect(keyHint('provider-key-WXYZ')).toBe('WXYZ');
  });
});
