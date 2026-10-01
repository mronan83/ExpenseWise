import { describe, expect, it, vi } from 'vitest';
import {
  connectionConfig,
  describeConnection,
  retryWhilePoolerRejectsPassword,
} from './connection.ts';
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

const POOLER = 'aws-0-us-west-2.pooler.supabase.com';
const supabaseUrl = (password: string, port = 5432) =>
  `postgresql://postgres.abcd:${password}@${POOLER}:${port}/postgres`;
/** The password in the connection string handed to node-postgres, decoded as pg decodes it. */
const sentPassword = (url: string) =>
  decodeURIComponent(new URL(connectionConfig(url).connectionString ?? '').password);

describe('Supabase password tidying', () => {
  it.each([
    ['dashes', 'trymew-dacSej-3qyize'],
    ['symbols', 'a+b$c!d*e'],
    ['an escaped @', 'p%40ss'],
  ])('leaves a password with %s alone', (_, password) => {
    expect(sentPassword(supabaseUrl(password))).toBe(decodeURIComponent(password));
    expect(describeConnection(supabaseUrl(password)).corrections).toEqual([]);
  });

  it("removes the brackets left from Supabase's [YOUR-PASSWORD] template", () => {
    expect(sentPassword(supabaseUrl('[Abc123xyz]'))).toBe('Abc123xyz');
    expect(describeConnection(supabaseUrl('[Abc123xyz]')).corrections).toEqual([
      "removed the square brackets around the password (they belong to Supabase's placeholder)",
    ]);
  });

  it('removes spaces pasted around the password', () => {
    expect(sentPassword(supabaseUrl('%20Abc123xyz%20'))).toBe('Abc123xyz');
  });

  it('rejects the placeholder itself, with or without brackets', () => {
    expect(() => connectionConfig(supabaseUrl('[YOUR-PASSWORD]'))).toThrow(/placeholder/);
    expect(() => connectionConfig(supabaseUrl('YOUR-PASSWORD'))).toThrow(/placeholder/);
  });

  it('leaves non-Supabase hosts untouched', () => {
    const url = 'postgres://app:[literal]@127.0.0.1:5432/app';
    expect(connectionConfig(url)).toEqual({ connectionString: url });
  });
});

describe('describeConnection', () => {
  it('names the user, host, port and database but never the password', () => {
    const summary = describeConnection(supabaseUrl('[s3cret-value]'));
    expect(summary).toMatchObject({
      user: 'postgres.abcd',
      host: POOLER,
      port: '5432',
      database: 'postgres',
    });
    expect(JSON.stringify(summary)).not.toContain('s3cret-value');
  });
});

describe('retryWhilePoolerRejectsPassword', () => {
  const rejected = () =>
    Object.assign(new Error('password authentication failed'), { code: '28P01' });
  const wrapped = () => new Error('Failed query: CREATE SCHEMA', { cause: rejected() });
  const options = { delaysMs: [1, 2, 3], sleep: () => Promise.resolve() };

  it('retries while the pooler rejects the password, including wrapped errors', async () => {
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rejected())
      .mockRejectedValueOnce(wrapped())
      .mockResolvedValue('migrated');
    const log = vi.fn();
    await expect(
      retryWhilePoolerRejectsPassword(supabaseUrl('pw'), work, { ...options, log }),
    ).resolves.toBe('migrated');
    expect(work).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last delay and says what to check', async () => {
    const work = vi.fn<() => Promise<never>>().mockRejectedValue(rejected());
    await expect(retryWhilePoolerRejectsPassword(supabaseUrl('pw'), work, options)).rejects.toThrow(
      /rejected the database password 4 times[\s\S]*Connection pooling/,
    );
    expect(work).toHaveBeenCalledTimes(4);
  });

  it('does not retry other errors', async () => {
    const work = vi.fn<() => Promise<never>>().mockRejectedValue(new Error('relation missing'));
    await expect(retryWhilePoolerRejectsPassword(supabaseUrl('pw'), work, options)).rejects.toThrow(
      'relation missing',
    );
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs once against anything other than the Supabase pooler', async () => {
    const work = vi.fn<() => Promise<never>>().mockRejectedValue(rejected());
    await expect(
      retryWhilePoolerRejectsPassword('postgres://u:p@127.0.0.1:5432/db', work, options),
    ).rejects.toThrow('password authentication failed');
    expect(work).toHaveBeenCalledTimes(1);
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
