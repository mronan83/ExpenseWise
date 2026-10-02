import { describe, expect, it } from 'vitest';
import { roleConnectionString } from './role-passwords.ts';

describe('roleConnectionString', () => {
  it("keeps the Supabase pooler's project suffix on the user name", () => {
    const url = new URL(
      roleConnectionString(
        'postgresql://postgres.abcdefgh:owner-secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
        'expensewise_app',
        'p@ss/word:with#symbols',
      ),
    );
    expect(decodeURIComponent(url.username)).toBe('expensewise_app.abcdefgh');
    expect(decodeURIComponent(url.password)).toBe('p@ss/word:with#symbols');
    expect(url.host).toBe('aws-0-us-west-2.pooler.supabase.com:5432');
    expect(url.pathname).toBe('/postgres');
  });

  it('uses the bare role name elsewhere', () => {
    const url = new URL(
      roleConnectionString(
        'postgres://postgres:pw@127.0.0.1:5432/expensewise',
        'expensewise_relay',
        'x',
      ),
    );
    expect(url.username).toBe('expensewise_relay');
    expect(url.pathname).toBe('/expensewise');
  });
});
