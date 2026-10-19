import type { CommittedEvent, Membership, NotificationSettings } from '@expensewise/db';
import { CHOSEN_KINDS, type PushSubscriptionInput } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { NotificationStore } from '../src/notifications.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-10-19T15:00:00.000Z');
const ON = 'notifications.push=on';
const PUBLIC_KEY = `B${'A'.repeat(86)}`;
const EVENT: CommittedEvent = {
  outboxId: 'o1',
  topic: 'notifications.push_requested',
  orgId: ORG,
  payload: { reason: 'test' },
};

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const device = {
  endpoint: 'https://web.push.apple.com/QGuQ2sp',
  keys: { p256dh: `B${'C'.repeat(86)}`, auth: 'D'.repeat(22) },
  timeZone: 'America/Chicago',
};

function setup(options: { flags?: string; publicKey?: string | null } = {}) {
  const off = new Set<string>();
  const devices = new Map<string, PushSubscriptionInput>();
  const calls: string[] = [];
  const dispatched: CommittedEvent[] = [];
  const settings = (): NotificationSettings => ({
    kinds: CHOSEN_KINDS.map((kind) => ({ kind, on: !off.has(kind) })),
    devices: devices.size,
  });
  const notifications: NotificationStore = {
    settings: () => Promise.resolve(settings()),
    setKind: (_org, _member, kind, on, actor) => {
      calls.push(`kind ${kind} ${on} by ${actor}`);
      if (on) off.delete(kind);
      else off.add(kind);
      return Promise.resolve(settings());
    },
    addDevice: (_org, _member, subscription) => {
      const renewed = devices.has(subscription.endpoint);
      devices.set(subscription.endpoint, subscription);
      calls.push(`device ${subscription.timeZone}`);
      return Promise.resolve(renewed ? 'renewed' : 'added');
    },
    removeDevice: (_org, _member, endpoint) => Promise.resolve(devices.delete(endpoint)),
    test: () =>
      Promise.resolve(
        devices.size > 0 ? { status: 'requested', event: EVENT } : { status: 'no_devices' },
      ),
  };
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'member' },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    notifications,
    ...(options.publicKey === null ? {} : { pushPublicKey: options.publicKey ?? PUBLIC_KEY }),
    dispatch: (events) => {
      dispatched.push(...events);
      return Promise.resolve();
    },
    flagOverrides: options.flags ?? ON,
    now: () => NOW,
  });
  const call = async (method: string, path: string, who?: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        code?: string;
        kinds?: { kind: string; label: string; on: boolean }[];
      },
    };
  };
  return { call, calls, dispatched, devices };
}

describe('Settings › Notifications (FR-PLT-12, ADR-0053)', () => {
  it('shows each kind on until switched off, the key to subscribe with, and the devices', async () => {
    const { call } = setup();
    const { status, body } = await call('GET', '/v1/me/notifications', 'riley');
    expect(status).toBe(200);
    expect(body).toMatchObject({ publicKey: PUBLIC_KEY, devices: 0 });
    expect(body.kinds?.map((k) => k.kind)).toEqual([...CHOSEN_KINDS]);
    expect(body.kinds?.[0]).toEqual({
      kind: 'receipts',
      label: 'A receipt you emailed is filed',
      on: true,
    });
  });

  it('switches a kind off and on for the caller, and refuses one that isn’t switched', async () => {
    const { call, calls } = setup();
    const off = await call('PUT', '/v1/me/notifications/receipts', 'riley', { on: false });
    expect(off.status).toBe(200);
    expect(off.body.kinds?.find((k) => k.kind === 'receipts')?.on).toBe(false);
    expect(calls).toEqual(['kind receipts false by riley']);
    expect((await call('PUT', '/v1/me/notifications/test', 'riley', { on: false })).status).toBe(
      400,
    );
  });

  it('allows a device at a push service, renews it, and refuses any other address', async () => {
    const { call, calls } = setup();
    expect(await call('POST', '/v1/me/push-subscriptions', 'riley', device)).toEqual({
      status: 201,
      body: { status: 'added', devices: 1 },
    });
    expect(await call('POST', '/v1/me/push-subscriptions', 'riley', device)).toEqual({
      status: 200,
      body: { status: 'renewed', devices: 1 },
    });
    expect(calls).toEqual(['device America/Chicago', 'device America/Chicago']);
    for (const endpoint of [
      'http://web.push.apple.com/x',
      'https://169.254.169.254/latest/meta-data',
      'https://web.push.apple.com.attacker.example/x',
    ]) {
      const refused = await call('POST', '/v1/me/push-subscriptions', 'riley', {
        ...device,
        endpoint,
      });
      expect(refused).toMatchObject({ status: 400, body: { code: 'not_a_push_service' } });
    }
    const badKeys = await call('POST', '/v1/me/push-subscriptions', 'riley', {
      ...device,
      keys: { ...device.keys, auth: 'short' },
    });
    expect(badKeys).toMatchObject({ status: 400, body: { code: 'bad_push_keys' } });
    expect(
      (
        await call('POST', '/v1/me/push-subscriptions/remove', 'riley', {
          endpoint: device.endpoint,
        })
      ).status,
    ).toBe(204);
  });

  it('sends a test through the workflows, once a device is allowed', async () => {
    const { call, dispatched } = setup();
    expect(await call('POST', '/v1/me/notifications/test', 'riley')).toMatchObject({
      status: 409,
      body: { code: 'no_devices' },
    });
    await call('POST', '/v1/me/push-subscriptions', 'riley', device);
    expect(await call('POST', '/v1/me/notifications/test', 'riley')).toEqual({
      status: 202,
      body: { status: 'requested' },
    });
    expect(dispatched).toEqual([EVENT]);
  });

  it('answers only when switched on, signed in, and able to send', async () => {
    expect(
      (await setup({ flags: '' }).call('GET', '/v1/me/notifications', 'riley')).body.code,
    ).toBe('feature_off');
    expect((await setup().call('GET', '/v1/me/notifications')).status).toBe(401);
    const unsendable = setup({ publicKey: null });
    expect((await unsendable.call('GET', '/v1/me/notifications', 'riley')).body.publicKey).toBe(
      null,
    );
    expect(
      await unsendable.call('POST', '/v1/me/push-subscriptions', 'riley', device),
    ).toMatchObject({ status: 503, body: { code: 'push_not_configured' } });
  });
});
