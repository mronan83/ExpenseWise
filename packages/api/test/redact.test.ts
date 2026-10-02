import { describe, expect, it } from 'vitest';
import { redactEvent, redactSecrets } from '../src/redact.ts';

describe('redactSecrets', () => {
  it('removes credentials from connection strings but keeps the host', () => {
    expect(
      redactSecrets(
        'connect failed: postgresql://expensewise_app.ref:hunter2@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
      ),
    ).toBe(
      'connect failed: postgresql://[redacted]@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
    );
  });

  it('removes bearer tokens, JWTs and vendor keys', () => {
    // Built at run time so the secret scanner (G4) never sees a token-shaped literal.
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = `${part({ alg: 'ES256' })}.${part({ sub: 'test-user' })}.${part({ sig: 'fake' })}`;
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets(`token ${jwt} expired`)).toBe('token [redacted-jwt] expired');
    expect(redactSecrets('key sk-ant-api03-abcDEF_123 and sb_secret_XyZ123')).toBe(
      'key sk-ant-[redacted] and sb_secret_[redacted]',
    );
  });

  it('leaves ordinary messages alone', () => {
    const message = 'Cannot combine USD with EUR at https://expensewise.dev/problems/x';
    expect(redactSecrets(message)).toBe(message);
  });
});

describe('redactEvent', () => {
  it('redacts the message, exception values and breadcrumbs, and keeps the rest', () => {
    const url = 'postgresql://app:hunter2@db.example.com/postgres';
    const event = {
      message: `failed: ${url}`,
      exception: { values: [{ type: 'Error', value: `cannot reach ${url}` }, { type: 'Error' }] },
      breadcrumbs: [{ category: 'console', message: `Readiness: ${url}` }, { category: 'ui' }],
      tags: { route: '/api/v1/me' },
    };
    expect(redactEvent(event)).toEqual({
      message: 'failed: postgresql://[redacted]@db.example.com/postgres',
      exception: {
        values: [
          { type: 'Error', value: 'cannot reach postgresql://[redacted]@db.example.com/postgres' },
          { type: 'Error' },
        ],
      },
      breadcrumbs: [
        {
          category: 'console',
          message: 'Readiness: postgresql://[redacted]@db.example.com/postgres',
        },
        { category: 'ui' },
      ],
      tags: { route: '/api/v1/me' },
    });
  });

  it('accepts an event with nothing to redact', () => {
    expect(redactEvent({})).toEqual({});
  });
});
