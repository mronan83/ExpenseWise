import { describe, expect, it } from 'vitest';
import { connectionConfig } from './connection.ts';
import { scramSha256Verifier } from './role-passwords.ts';
import { SUPABASE_ROOT_CA } from './supabase-ca.ts';

describe('connectionConfig', () => {
  it('verifies Supabase hosts against the Supabase root CA and drops URL ssl params', () => {
    const config = connectionConfig(
      'postgresql://expensewise_app.abcd:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require',
    );
    expect(config.ssl).toEqual({ ca: SUPABASE_ROOT_CA, rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode');
    expect(config.connectionString).toContain('pooler.supabase.com:6543');
  });

  it('leaves other hosts to the connection string', () => {
    const url = 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
    expect(connectionConfig(url)).toEqual({ connectionString: url });
  });

  it('bundles a PEM certificate', () => {
    expect(SUPABASE_ROOT_CA).toMatch(
      /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\n$/,
    );
  });
});

describe('scramSha256Verifier', () => {
  it('produces the Postgres SCRAM-SHA-256 stored-password format', () => {
    const verifier = scramSha256Verifier('a-long-enough-password-for-tests', Buffer.alloc(16, 1));
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
    );
    expect(verifier).not.toContain('a-long-enough-password');
  });

  it('salts every verifier differently by default', () => {
    expect(scramSha256Verifier('same-password-same-password')).not.toBe(
      scramSha256Verifier('same-password-same-password'),
    );
  });
});
