import { describe, expect, it } from 'vitest';
import { MEMBER_ROLES } from './approvals.ts';
import {
  GENESIS_HASH,
  canReadAuditTrail,
  canonicalJson,
  chainAuditEvent,
  secretLikeFields,
  verifyAuditChain,
  type AuditEventInput,
  type ChainedAuditEvent,
} from './audit.ts';

const event = (
  sequence: number,
  action: string,
  payload: Record<string, unknown> = {},
): AuditEventInput => ({
  orgId: '0192f0c8-0000-7000-8000-000000000001',
  sequence,
  actor: { type: 'user', id: 'member-1' },
  entityType: 'expense',
  entityId: 'expense-1',
  action,
  occurredAt: `2026-09-24T12:00:0${sequence}Z`,
  payload,
});

async function buildChain(inputs: AuditEventInput[]): Promise<ChainedAuditEvent[]> {
  const chain: ChainedAuditEvent[] = [];
  let prev = GENESIS_HASH;
  for (const input of inputs) {
    const chained = await chainAuditEvent(prev, input);
    chain.push(chained);
    prev = chained.hash;
  }
  return chain;
}

describe('canonicalJson', () => {
  it('ignores key order at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
    expect(canonicalJson([null, true, 'a'])).toBe('[null,true,"a"]');
  });

  it('refuses values that do not round-trip through JSON', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/NaN or Infinity/);
    expect(() => canonicalJson({ n: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson(() => 1)).toThrow(/function/);
  });
});

describe('audit chain', () => {
  it('verifies an untouched chain', async () => {
    const chain = await buildChain([
      event(1, 'created'),
      event(2, 'submitted'),
      event(3, 'approved'),
    ]);
    expect(chain[0]?.prevHash).toBe(GENESIS_HASH);
    expect(chain[1]?.prevHash).toBe(chain[0]?.hash);
    expect(await verifyAuditChain(chain)).toEqual({ ok: true });
  });

  it('detects an edited payload', async () => {
    const chain = await buildChain([
      event(1, 'created', { amountMinor: 18420 }),
      event(2, 'approved'),
    ]);
    const tampered = [{ ...chain[0]!, payload: { amountMinor: 1842 } }, chain[1]!];
    expect(await verifyAuditChain(tampered)).toEqual({ ok: false, brokenAt: 0 });
  });

  it('detects removed and reordered events', async () => {
    const chain = await buildChain([
      event(1, 'created'),
      event(2, 'submitted'),
      event(3, 'approved'),
    ]);
    expect(await verifyAuditChain([chain[0]!, chain[2]!])).toEqual({ ok: false, brokenAt: 1 });
    expect(await verifyAuditChain([chain[1]!, chain[0]!, chain[2]!])).toEqual({
      ok: false,
      brokenAt: 0,
    });
  });

  it('detects a recomputed hash that no longer matches its content', async () => {
    const chain = await buildChain([event(1, 'created')]);
    expect(await verifyAuditChain([{ ...chain[0]!, hash: 'f'.repeat(64) }])).toEqual({
      ok: false,
      brokenAt: 0,
    });
  });
});

describe('who reads the trail', () => {
  it('lets owners, finance admins and auditors read it, and no one else', () => {
    expect(MEMBER_ROLES.filter(canReadAuditTrail)).toEqual(['finance_admin', 'owner', 'auditor']);
  });
});

describe('secretLikeFields', () => {
  it('finds a credential by its field name or its shape, at any depth', () => {
    expect(secretLikeFields({ apiKey: 'anything' })).toEqual(['apiKey']);
    expect(secretLikeFields({ nested: { access_token: 'x' } })).toEqual(['nested.access_token']);
    expect(secretLikeFields({ note: 'sk-ant-api03-0123456789abcdef' })).toEqual(['note']);
    expect(secretLikeFields({ list: ['ok', 'sk_live_0123456789abcdefgh'] })).toEqual(['list[1]']);
    expect(
      secretLikeFields({ jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl' }),
    ).toEqual(['jwt']);
  });

  it('passes what the trail stores: a key’s last four characters, digests, ids and text', () => {
    expect(
      secretLikeFields({
        keyHint: 'wxyz',
        authScheme: 'api_key',
        sha256: 'a'.repeat(64),
        requestId: '0192f0c8-0000-7000-8000-000000000001',
        changes: { merchant: { from: 'Uber', to: 'Uber Eats' } },
        justification: 'Client dinner, skipped the hotel breakfast',
        token: null,
        flag: 'governance.audit-trail',
      }),
    ).toEqual([]);
  });
});
