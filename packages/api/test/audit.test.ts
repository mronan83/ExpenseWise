import type { AuditChainCheck, AuditFilter, Membership } from '@expensewise/db';
import { GENESIS_HASH, chainAuditEvent, type ChainedAuditEvent } from '@expensewise/domain';
import type { z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { AuditStore } from '../src/audit.ts';
import type { Identity } from '../src/auth.ts';
import type { AuditPageSchema, AuditVerificationSchema } from '../src/routes/audit.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

/** Whatever a route answered: a page of the trail, the chain check, or a problem. */
type Body = z.infer<typeof AuditPageSchema> &
  z.infer<typeof AuditVerificationSchema> & { code?: string };

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const RECEIPT = '0192f7a0-0000-7000-8000-0000000000d1';
const EXPENSE = '0192f7a0-0000-7000-8000-0000000000e1';

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const member = (role: Membership['role']): Membership => ({
  orgId: ORG,
  memberId: `0192f7a0-0000-7000-8000-00000000b00${role.length}`,
  role,
});

async function chain(): Promise<ChainedAuditEvent[]> {
  const riley = { type: 'user' as const, id: 'riley' };
  const workflow = { type: 'system' as const, id: 'receipt-workflow' };
  const inputs = [
    [riley, 'receipt', RECEIPT, 'receipt.captured', { source: 'camera' }],
    [workflow, 'expense', EXPENSE, 'expense.created', { receiptId: RECEIPT }],
    [workflow, 'receipt', RECEIPT, 'receipt.read', { status: 'extracted' }],
    [riley, 'expense', EXPENSE, 'expense.edited', { changes: { merchant: { to: 'Uber' } } }],
    [riley, 'ai_provider_key', 'anthropic', 'ai_provider_key.saved', { keyHint: 'wxyz' }],
  ] as const;
  const out: ChainedAuditEvent[] = [];
  let prev = GENESIS_HASH;
  for (const [i, [actor, entityType, entityId, action, payload]] of inputs.entries()) {
    const event = await chainAuditEvent(prev, {
      orgId: ORG,
      sequence: i + 1,
      actor,
      entityType,
      entityId,
      action,
      occurredAt: new Date(NOW.getTime() + i * 60_000).toISOString(),
      payload,
    });
    out.push(event);
    prev = event.hash;
  }
  return out;
}

const INTACT: AuditChainCheck = { intact: true, checked: 5, total: 5, brokenAt: null };

function setup(opts: { flag?: boolean; audit?: boolean; check?: AuditChainCheck } = {}) {
  const memberships: Record<string, Membership> = {
    riley: member('owner'),
    sam: member('finance_admin'),
    ada: member('auditor'),
    jordan: member('approver'),
    alex: member('member'),
  };
  const asked: { filter: AuditFilter; limit: number }[] = [];
  let verified = 0;
  const events = chain();
  const audit: AuditStore = {
    page: async (orgId, filter, limit) => {
      expect(orgId).toBe(ORG);
      asked.push({ filter, limit });
      const matching = (await events)
        .filter(
          (e) =>
            (filter.entityType === undefined || e.entityType === filter.entityType) &&
            (filter.entityId === undefined || e.entityId === filter.entityId) &&
            (filter.actorId === undefined || e.actor.id === filter.actorId) &&
            (filter.before === undefined || e.sequence < filter.before),
        )
        .reverse()
        .slice(0, limit);
      return {
        events: matching,
        actors: matching.some((e) => e.actor.id === 'riley')
          ? [{ userId: 'riley', name: 'Riley', email: 'riley@example.com' }]
          : [],
      };
    },
    verify: () => {
      verified++;
      return Promise.resolve(opts.check ?? INTACT);
    },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      // No organization has switched it on: only the override turns it on here.
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    audit: opts.audit === false ? undefined : audit,
    flagOverrides: opts.flag === false ? undefined : 'governance.audit-trail=on',
    now: () => NOW,
  });
  const call = async (path: string, who?: string) => {
    const res = await api.request(path, {
      headers: who ? { authorization: `Bearer ${who}` } : {},
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { call, asked, verified: () => verified };
}

describe('audit trail', () => {
  it('lists the trail newest first, a page at a time, with who made each change', async () => {
    const s = setup();
    const first = await s.call('/v1/audit/events?limit=2', 'riley');
    expect(first.status).toBe(200);
    expect(first.body.events.map((e) => e.sequence)).toEqual([5, 4]);
    expect(first.body.nextCursor).toBe('4');
    expect(first.body.events[0]).toMatchObject({
      occurredAt: '2026-10-04T12:04:00.000Z',
      actor: { type: 'user', id: 'riley', name: 'Riley', email: 'riley@example.com' },
      entityType: 'ai_provider_key',
      entityId: 'anthropic',
      action: 'ai_provider_key.saved',
      payload: { keyHint: 'wxyz' },
    });
    expect(first.body.events[0]?.hash).toMatch(/^[0-9a-f]{64}$/);

    const second = await s.call(`/v1/audit/events?limit=2&cursor=4`, 'riley');
    expect(second.body.events.map((e) => e.sequence)).toEqual([3, 2]);
    expect(second.body.events[0]?.actor).toEqual({
      type: 'system',
      id: 'receipt-workflow',
      name: null,
      email: null,
    });
    const last = await s.call(`/v1/audit/events?limit=2&cursor=${second.body.nextCursor}`, 'riley');
    expect(last.body.events.map((e) => e.sequence)).toEqual([1]);
    expect(last.body.nextCursor).toBeNull();
    // A page asks for one more than it shows, to know whether another follows.
    expect(s.asked.map((a) => a.limit)).toEqual([3, 3, 3]);
  });

  it('shows 50 events a page unless asked, and never more than 100', async () => {
    const s = setup();
    expect((await s.call('/v1/audit/events', 'riley')).status).toBe(200);
    expect((await s.call('/v1/audit/events?limit=100', 'riley')).status).toBe(200);
    expect(s.asked.map((a) => a.limit)).toEqual([51, 101]);
    for (const bad of ['limit=0', 'limit=101', 'cursor=abc', 'cursor=0', 'entityType=Receipt!']) {
      const res = await s.call(`/v1/audit/events?${bad}`, 'riley');
      expect(res.status, bad).toBe(400);
      expect(res.body.code, bad).toBe('invalid_request');
    }
  });

  it('narrows the trail to one record, or to who made the change', async () => {
    const s = setup();
    const record = await s.call(`/v1/audit/events?entityType=receipt&entityId=${RECEIPT}`, 'riley');
    expect(record.body.events.map((e) => e.action)).toEqual(['receipt.read', 'receipt.captured']);
    const byWorkflow = await s.call('/v1/audit/events?actorId=receipt-workflow', 'riley');
    expect(byWorkflow.body.events.map((e) => e.sequence)).toEqual([3, 2]);
    expect(s.asked.map((a) => a.filter)).toEqual([
      { entityType: 'receipt', entityId: RECEIPT },
      { actorId: 'receipt-workflow' },
    ]);
  });

  it('recomputes the chain on request, and says where it breaks', async () => {
    const intact = setup();
    const ok = await intact.call('/v1/audit/verification', 'riley');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      intact: true,
      checked: 5,
      total: 5,
      brokenAt: null,
      checkedAt: NOW.toISOString(),
    });
    expect(intact.verified()).toBe(1);

    const [, edited] = await chain();
    const broken = setup({
      check: { intact: false, checked: 2, total: 5, brokenAt: edited! },
    });
    expect((await broken.call('/v1/audit/verification', 'ada')).body).toMatchObject({
      intact: false,
      checked: 2,
      total: 5,
      brokenAt: {
        sequence: 2,
        occurredAt: '2026-10-04T12:01:00.000Z',
        entityType: 'expense',
        entityId: EXPENSE,
        action: 'expense.created',
      },
    });
  });

  it('lets only owners, finance admins and auditors read it', async () => {
    const s = setup();
    for (const who of ['riley', 'sam', 'ada']) {
      expect((await s.call('/v1/audit/events', who)).status, who).toBe(200);
      expect((await s.call('/v1/audit/verification', who)).status, who).toBe(200);
    }
    for (const who of ['jordan', 'alex']) {
      for (const path of ['/v1/audit/events', '/v1/audit/verification']) {
        const res = await s.call(path, who);
        expect(res.status, who).toBe(403);
        expect(res.body.code, who).toBe('forbidden_role');
      }
    }
    expect((await s.call('/v1/audit/events', 'mallory')).body.code).toBe('no_organization');
  });

  it('answers 404 feature_off while the audit trail is switched off', async () => {
    const s = setup({ flag: false });
    for (const path of ['/v1/audit/events', '/v1/audit/verification']) {
      const res = await s.call(path, 'riley');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('feature_off');
    }
    expect(s.asked).toEqual([]);
    expect(s.verified()).toBe(0);
  });

  it('needs a signed-in member and a database', async () => {
    expect((await setup().call('/v1/audit/events')).status).toBe(401);
    expect((await setup().call('/v1/audit/verification')).status).toBe(401);
    expect((await setup({ audit: false }).call('/v1/audit/events', 'riley')).status).toBe(503);
  });
});
