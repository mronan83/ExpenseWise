import type { OrgFeature } from '@expensewise/db';
import type { MemberRole } from '@expensewise/domain';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { BEFORE_THE_CODE, createApi, openApiDocument, type ApiOptions } from '../src/app.ts';
import { supabaseTokenVerifier, type TokenVerifier } from '../src/auth.ts';
import { featureGate } from '../src/features.ts';
import { ProblemError } from '../src/problem.ts';
import { requireCodeOfTheEnrolled, requireOwnAuthenticator } from '../src/second-factor.ts';
import { createSecretBox } from '../src/secret-box.ts';
import type { CallerMembership, WorkspaceStore } from '../src/workspace.ts';

/*
 * The second factor locks everything for someone with an authenticator (#85, Q41, ADR-0044):
 * with tokens signed as Supabase Auth signs them, aal1 (password alone) and aal2 (passed the
 * code), for a person whose sign-in has a verified authenticator and one whose hasn't, with the
 * organization's switch on and off, across every operation in the API contract. And a person's
 * other email, with none of its own while another of theirs has one, held until it adds its own
 * (#88, Q43).
 */

const PROJECT = 'https://test-project.supabase.co';
const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const ID = '0192f7a0-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const FLAG = 'security.second-factor';

/**
 * Who signs in, by the token's subject, whether their sign-in has an authenticator, and whether
 * any of the person's sign-ins has one (#88).
 */
const PEOPLE: Record<
  string,
  { role: MemberRole; authenticator: boolean; personAuthenticator: boolean; member: string }
> = {
  'u-enrolled': {
    role: 'owner',
    authenticator: true,
    personAuthenticator: true,
    member: '0192f7a0-0000-7000-8000-0000000000b1',
  },
  'u-plain': {
    role: 'member',
    authenticator: false,
    personAuthenticator: false,
    member: '0192f7a0-0000-7000-8000-0000000000b2',
  },
  // The same person as u-enrolled, by another email that has no authenticator of its own.
  'u-other-email': {
    role: 'owner',
    authenticator: false,
    personAuthenticator: true,
    member: '0192f7a0-0000-7000-8000-0000000000b1',
  },
};

let verifyToken: TokenVerifier;
let sign: (user: string, aal: 'aal1' | 'aal2') => Promise<string>;

beforeAll(async () => {
  const project = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(project.publicKey)), kid: 'project-key', alg: 'ES256' };
  verifyToken = supabaseTokenVerifier({
    projectUrl: PROJECT,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  sign = (user, aal) =>
    new SignJWT({ role: 'authenticated', aal, email: `${user}@example.com`, session_id: 's-1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'project-key' })
      .setSubject(user)
      .setIssuer(`${PROJECT}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(project.privateKey);
});

const membershipOf = (userId: string): CallerMembership | undefined => {
  const person = PEOPLE[userId];
  return person
    ? {
        orgId: ORG,
        memberId: person.member,
        role: person.role,
        authenticator: person.authenticator,
        personAuthenticator: person.personAuthenticator,
      }
    : undefined;
};

/**
 * One stand-in for every store. It knows each caller's membership, with whether their sign-in
 * has an authenticator, and the organization's switches; any other call means the request got
 * past every check, and answers 409 reached_store with what it reached.
 */
function setup(switchedOn: readonly string[], flagOverrides = '') {
  const switched = new Set(switchedOn);
  const reached: string[] = [];
  const known: Record<string, (...args: never[]) => Promise<unknown>> = {
    findMembership: (userId: string) => Promise.resolve(membershipOf(userId)),
    ensureOrganization: (owner: { userId: string }) =>
      Promise.resolve({
        membership: membershipOf(owner.userId),
        organization: { id: ORG, name: 'Acme', homeCurrency: 'USD' },
        created: false,
      }),
    featureOn: (_org: string, flag: string) => Promise.resolve(switched.has(flag)),
    listFeatures: (): Promise<OrgFeature[]> =>
      Promise.resolve([...switched].map((flag) => ({ flag, enabled: true, updatedAt: NOW }))),
  };
  const store = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string' || property === 'then') return undefined;
        return (
          known[property] ??
          (() => {
            reached.push(property);
            return Promise.reject(
              new ProblemError(409, 'reached-store', 'Reached the store', {
                code: 'reached_store',
              }),
            );
          })
        );
      },
    },
  ) as never;
  const options: ApiOptions = {
    version: 'test',
    verifyToken,
    workspace: store,
    organization: store,
    expenses: store,
    trips: store,
    mileage: store,
    mileageRates: store,
    routeMileage: store,
    routeKeys: store,
    home: store,
    reports: store,
    approvals: store,
    audit: store,
    categories: store,
    emails: store,
    itemized: store,
    modelSettings: store,
    reimbursement: store,
    people: store,
    receipts: store,
    files: store,
    dispatch: () => Promise.resolve(),
    secrets: createSecretBox('second-factor-everywhere-secret-0123456789'),
    verifyProviderKey: () => Promise.resolve({ ok: true, authScheme: 'api_key' }),
    verifyRouteKey: () => Promise.resolve({ ok: true }),
    flagOverrides,
    now: () => new Date(),
  };
  const api = createApi(options);
  return {
    reached,
    async call(user: string, aal: 'aal1' | 'aal2', method: string, path: string, body?: unknown) {
      const res = await api.request(path, {
        method,
        headers: {
          authorization: `Bearer ${await sign(user, aal)}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return {
        status: res.status,
        body: parsed as { code?: string; detail?: string; email?: string } | null,
      };
    },
  };
}

/* Every operation in the contract, with a request its schema accepts. */

interface Schema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly enum?: readonly unknown[];
  readonly example?: unknown;
  readonly default?: unknown;
  readonly format?: string;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly minItems?: number;
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly allOf?: readonly Schema[];
}

interface Operation {
  readonly security?: readonly unknown[];
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: string;
    readonly required?: boolean;
    readonly schema: Schema;
  }[];
  readonly requestBody?: { readonly content: Record<string, { readonly schema: Schema }> };
}

const contract = openApiDocument() as unknown as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

/**
 * A value the schema accepts, from its example where it has one. A new operation whose request
 * this can't make valid fails the tests below with what its validation said, rather than
 * passing them unchecked.
 */
function sample(schema: Schema): unknown {
  if (schema.$ref) return sample(contract.components.schemas[schema.$ref.split('/').pop()!]!);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  const options = schema.oneOf ?? schema.anyOf;
  if (options) return sample(options.find((o) => o.type !== 'null') ?? options[0]!);
  if (schema.allOf) {
    return Object.assign({}, ...schema.allOf.map((s) => sample(s) as object)) as unknown;
  }
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== 'null')
    : (schema.type as string | undefined);
  switch (type) {
    case 'object': {
      // A change with nothing required still has to change something: its first field.
      const keys = schema.required?.length
        ? schema.required
        : Object.keys(schema.properties ?? {}).slice(0, 1);
      return Object.fromEntries(keys.map((key) => [key, sample(schema.properties![key]!)]));
    }
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items!));
    case 'string': {
      if (schema.format === 'uuid') return ID;
      if (schema.format === 'date') return '2026-10-05';
      if (schema.format === 'date-time') return NOW.toISOString();
      if (schema.format === 'email') return 'someone@example.com';
      // A run of one kind of character, such as /^[0-9a-f]{64}$/: its first, that many times.
      const run = schema.pattern && /^\^\[(.)[^\]]*\]\{(\d+)\}\$$/.exec(schema.pattern);
      if (run) return run[1]!.repeat(Number(run[2]));
      return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

const OPERATIONS = Object.entries(contract.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => {
    const name = `${method.toUpperCase()} ${path}`;
    let url = path;
    const query = new URLSearchParams();
    for (const p of op.parameters ?? []) {
      const value = String(sample(p.schema));
      if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(value));
      else if (p.in === 'query' && p.required) query.set(p.name, value);
    }
    const schema = op.requestBody?.content['application/json']?.schema;
    return {
      name,
      method: method.toUpperCase(),
      url: query.size ? `${url}?${query}` : url,
      body: schema ? sample(schema) : undefined,
      signedIn: (op.security ?? []).length > 0,
    };
  }),
);

/** What a session that skipped the code may still ask, as the API's own list names them. */
const EXEMPT = new Set([
  'GET /v1/me',
  ...BEFORE_THE_CODE.map((r) => `${r.method.toUpperCase()} ${r.path}`),
]);
const SIGNED_IN = OPERATIONS.filter((o) => o.signedIn);
const HELD = SIGNED_IN.filter((o) => !EXEMPT.has(o.name));
const LINK = 'POST /v1/me/sign-ins';

const refused = (res: { status: number; body: { code?: string } | null }) =>
  res.status === 403 && res.body?.code === 'second_factor_required';

describe('everything, for someone with an authenticator (#85)', () => {
  it('names only who is signed in and the organization’s switches as asked before the code', () => {
    expect([...EXEMPT].sort()).toEqual(['GET /v1/features', 'GET /v1/me']);
    expect(HELD.length).toBe(SIGNED_IN.length - 2);
    // The health checks and the email webhook carry no person's token.
    expect(OPERATIONS.filter((o) => !o.signedIn).map((o) => o.name)).toEqual([
      'GET /v1/health',
      'GET /v1/health/ready',
      'POST /v1/inbound/bird',
    ]);
  });

  it.each(HELD.map((o) => [o.name, o] as const))(
    'refuses every request of someone with an authenticator whose session skipped the code, while it is on, and reaches nothing: %s',
    async (_name, op) => {
      const s = setup([FLAG]);
      const res = await s.call('u-enrolled', 'aal1', op.method, op.url, op.body);
      expect(res, res.body?.detail).toMatchObject({
        status: 403,
        body: { code: 'second_factor_required' },
      });
      expect(s.reached).toEqual([]);
    },
  );

  it.each(HELD.map((o) => [o.name, o] as const))(
    'lets every request through once the session passed the code: %s',
    async (_name, op) => {
      const s = setup([FLAG]);
      const res = await s.call('u-enrolled', 'aal2', op.method, op.url, op.body);
      expect(refused(res)).toBe(false);
    },
  );

  it('still answers who is signed in, and the organization’s switches, before the code', async () => {
    const s = setup([FLAG]);
    expect(await s.call('u-enrolled', 'aal1', 'GET', '/v1/me')).toMatchObject({
      status: 200,
      body: { userId: 'u-enrolled', assuranceLevel: 'aal1' },
    });
    const features = await s.call('u-enrolled', 'aal1', 'GET', '/v1/features');
    expect(features.status).toBe(200);
    const listed = (features.body as unknown as { features: { key: string; enabled: boolean }[] })
      .features;
    expect(listed.find((f) => f.key === FLAG)?.enabled).toBe(true);
    expect(s.reached).toEqual([]);
  });

  it('holds a feature switch, though the switches can be read before the code', async () => {
    const s = setup([FLAG]);
    expect(
      await s.call('u-enrolled', 'aal1', 'PUT', '/v1/settings/features/reports.export', {
        enabled: true,
      }),
    ).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
  });

  it.each(SIGNED_IN.map((o) => [o.name, o] as const))(
    'asks nothing more of someone with no authenticator while it is on: %s',
    async (_name, op) => {
      const s = setup([FLAG]);
      expect(refused(await s.call('u-plain', 'aal1', op.method, op.url, op.body))).toBe(false);
    },
  );

  it.each(SIGNED_IN.filter((o) => o.name !== LINK).map((o) => [o.name, o] as const))(
    'changes nothing for anyone while the second factor is switched off: %s',
    async (_name, op) => {
      const s = setup([]);
      expect(refused(await s.call('u-enrolled', 'aal1', op.method, op.url, op.body))).toBe(false);
    },
  );

  it('changes nothing while the server’s override has it off, whatever the switch says', async () => {
    const s = setup([FLAG], `${FLAG}=off`);
    for (const op of HELD.filter((o) => o.name !== LINK)) {
      const res = await s.call('u-enrolled', 'aal1', op.method, op.url, op.body);
      expect(refused(res), op.name).toBe(false);
    }
  });
});

describe('linking another sign-in (FR-PLT-04, #85)', () => {
  const link = async (s: ReturnType<typeof setup>, user: string, aal: 'aal1' | 'aal2') =>
    s.call(user, aal, 'POST', '/v1/me/sign-ins', { accessToken: await sign('u-other', 'aal1') });

  it.each([
    // On, every request is held already; off, linking still is, and says why.
    ['on', [FLAG], /before anything else/],
    ['off', [], /Linking another sign-in/],
  ] as const)(
    'needs the code from someone with an authenticator, whatever the switch: %s',
    async (_state, switched, why) => {
      const s = setup(switched);
      const res = await link(s, 'u-enrolled', 'aal1');
      expect(res).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
      expect(res.body?.detail).toMatch(why);
      expect(s.reached).toEqual([]);
      await link(s, 'u-enrolled', 'aal2');
      expect(s.reached).toEqual(['linkSignIn']);
    },
  );

  it('links as before for someone with no authenticator, on a password alone', async () => {
    for (const switched of [[FLAG], []]) {
      const s = setup(switched);
      await link(s, 'u-plain', 'aal1');
      expect(s.reached).toEqual(['linkSignIn']);
    }
  });
});

describe('requireCodeOfTheEnrolled', () => {
  const counting = (on: boolean) => {
    let reads = 0;
    const workspace = {
      featureOn: () => {
        reads += 1;
        return Promise.resolve(on);
      },
    } as unknown as WorkspaceStore;
    return { gate: featureGate({ workspace }), reads: () => reads };
  };

  it('reads the switch only for an enrolled person’s session that skipped the code', async () => {
    const on = counting(true);
    const enrolled = { orgId: ORG, authenticator: true };
    await requireCodeOfTheEnrolled(on.gate, { orgId: ORG }, { assuranceLevel: 'aal1' });
    await requireCodeOfTheEnrolled(on.gate, enrolled, { assuranceLevel: 'aal2' });
    expect(on.reads()).toBe(0);
    await expect(
      requireCodeOfTheEnrolled(on.gate, enrolled, { assuranceLevel: 'aal1' }),
    ).rejects.toMatchObject({ status: 403, extra: { code: 'second_factor_required' } });
    expect(on.reads()).toBe(1);
    const off = counting(false);
    await expect(
      requireCodeOfTheEnrolled(off.gate, enrolled, { assuranceLevel: 'aal1' }),
    ).resolves.toBe(undefined);
  });
});

/* A person's other emails (#88, Q43). */

const OTHER = 'u-other-email';
const held = (res: { status: number; body: { code?: string } | null }) =>
  res.status === 403 && res.body?.code === 'authenticator_required';

describe('a person’s other email, until it adds its own authenticator (#88)', () => {
  it.each(HELD.map((o) => [o.name, o] as const))(
    'holds every request of an email with none of its own, of a person with one on another, while it is on, whatever its session says, and reaches nothing: %s',
    async (_name, op) => {
      const s = setup([FLAG]);
      for (const aal of ['aal1', 'aal2'] as const) {
        const res = await s.call(OTHER, aal, op.method, op.url, op.body);
        expect(res, `${aal}: ${res.body?.detail}`).toMatchObject({
          status: 403,
          body: { code: 'authenticator_required', email: `${OTHER}@example.com` },
        });
      }
      expect(s.reached).toEqual([]);
    },
  );

  it('names the email that needs one, and never asks it for a code it can’t have', async () => {
    const s = setup([FLAG]);
    const res = await s.call(OTHER, 'aal1', 'GET', '/v1/reports');
    expect(res.body?.code).toBe('authenticator_required');
    expect(res.body?.detail).toMatch(
      /^u-other-email@example\.com has no authenticator app of its own/,
    );
    expect(res.body?.detail).toMatch(/Settings › Sign-ins/);
  });

  it('still answers who is signed in, and the organization’s switches, which adding one in Settings › Sign-ins reads', async () => {
    const s = setup([FLAG]);
    expect(await s.call(OTHER, 'aal1', 'GET', '/v1/me')).toMatchObject({
      status: 200,
      body: { userId: OTHER },
    });
    const features = await s.call(OTHER, 'aal1', 'GET', '/v1/features');
    expect(features.status).toBe(200);
    const listed = (features.body as unknown as { features: { key: string; enabled: boolean }[] })
      .features;
    expect(listed.find((f) => f.key === FLAG)?.enabled).toBe(true);
    expect(s.reached).toEqual([]);
  });

  it('asks the email with the authenticator for its code, not for another, and lets it through once passed', async () => {
    const s = setup([FLAG]);
    for (const op of HELD) {
      const before = await s.call('u-enrolled', 'aal1', op.method, op.url, op.body);
      expect(before.body?.code, op.name).toBe('second_factor_required');
      const after = await s.call('u-enrolled', 'aal2', op.method, op.url, op.body);
      expect(held(after) || refused(after), op.name).toBe(false);
    }
  });

  it.each(SIGNED_IN.map((o) => [o.name, o] as const))(
    'asks nothing more of a person with no authenticator on any email: %s',
    async (_name, op) => {
      const s = setup([FLAG]);
      const res = await s.call('u-plain', 'aal1', op.method, op.url, op.body);
      expect(held(res) || refused(res)).toBe(false);
    },
  );

  it.each(SIGNED_IN.map((o) => [o.name, o] as const))(
    'changes nothing for the other email while the second factor is switched off: %s',
    async (_name, op) => {
      const s = setup([]);
      const res = await s.call(OTHER, 'aal1', op.method, op.url, op.body);
      expect(held(res) || refused(res)).toBe(false);
    },
  );

  it('changes nothing for the other email while the server’s override has it off, whatever the switch says', async () => {
    const s = setup([FLAG], `${FLAG}=off`);
    for (const op of SIGNED_IN) {
      const res = await s.call(OTHER, 'aal1', op.method, op.url, op.body);
      expect(held(res) || refused(res), op.name).toBe(false);
    }
  });
});

describe('requireOwnAuthenticator', () => {
  const counting = (on: boolean) => {
    let reads = 0;
    const workspace = {
      featureOn: () => {
        reads += 1;
        return Promise.resolve(on);
      },
    } as unknown as WorkspaceStore;
    return { gate: featureGate({ workspace }), reads: () => reads };
  };
  const email = { email: 'work@example.com' };

  it('reads the switch only for an email with none of its own, of a person with one', async () => {
    const on = counting(true);
    await requireOwnAuthenticator(on.gate, { orgId: ORG }, email);
    await requireOwnAuthenticator(on.gate, { orgId: ORG, personAuthenticator: false }, email);
    await requireOwnAuthenticator(
      on.gate,
      { orgId: ORG, authenticator: true, personAuthenticator: true },
      email,
    );
    expect(on.reads()).toBe(0);
    await expect(
      requireOwnAuthenticator(on.gate, { orgId: ORG, personAuthenticator: true }, email),
    ).rejects.toMatchObject({
      status: 403,
      extra: { code: 'authenticator_required', email: 'work@example.com' },
    });
    expect(on.reads()).toBe(1);
    const off = counting(false);
    await expect(
      requireOwnAuthenticator(off.gate, { orgId: ORG, personAuthenticator: true }, email),
    ).resolves.toBe(undefined);
  });

  it('says which email when the token names none', async () => {
    const on = counting(true);
    await expect(
      requireOwnAuthenticator(on.gate, { orgId: ORG, personAuthenticator: true }, { email: null }),
    ).rejects.toMatchObject({
      extra: { code: 'authenticator_required', detail: /^The email you signed in with has no/ },
    });
  });
});
