import type { OrgFeature, PassedCode } from '@expensewise/db';
import type { LetIn, MemberRole, PersonLetIn } from '@expensewise/domain';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { BEFORE_THE_CODE, createApi, openApiDocument, type ApiOptions } from '../src/app.ts';
import { supabaseTokenVerifier, type TokenVerifier } from '../src/auth.ts';
import { featureGate } from '../src/features.ts';
import { ProblemError } from '../src/problem.ts';
import { admitSignIn } from '../src/second-factor.ts';
import { createSecretBox } from '../src/secret-box.ts';
import type { CallerMembership, WorkspaceStore } from '../src/workspace.ts';

/*
 * The second factor locks everything for someone with an authenticator (#85, Q41, ADR-0044):
 * with tokens signed as Supabase Auth signs them, aal1 (password alone) and aal2 (passed the
 * code), for a person whose sign-in has a verified authenticator and one whose hasn't, with the
 * organization's switch on and off, across every operation in the API contract. A person's other
 * email let in, with none of its own while another of theirs has one, held until it adds its own
 * (#88, Q43); once a person has an authenticator, an email they haven't let in refused (#90,
 * Q44); and only the email they first signed in with let in on its own (#91, Q45).
 */

const PROJECT = 'https://test-project.supabase.co';
const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const ID = '0192f7a0-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const FLAG = 'security.second-factor';

/**
 * Who signs in, by the token's subject, whether their sign-in has an authenticator, whether
 * any of the person's sign-ins has one (#88), whether it, and any of theirs, is let in (#90),
 * and whether it is the email they first signed in with (#91).
 */
const PEOPLE: Record<
  string,
  {
    role: MemberRole;
    authenticator: boolean;
    personAuthenticator: boolean;
    letIn: LetIn;
    personLetIn: PersonLetIn;
    firstSignIn?: boolean;
    member: string;
  }
> = {
  // An email let in, with its authenticator.
  'u-enrolled': {
    role: 'owner',
    authenticator: true,
    personAuthenticator: true,
    letIn: 'yes',
    personLetIn: 'with_authenticator',
    member: '0192f7a0-0000-7000-8000-0000000000b1',
  },
  'u-plain': {
    role: 'member',
    authenticator: false,
    personAuthenticator: false,
    letIn: 'no',
    personLetIn: 'none',
    member: '0192f7a0-0000-7000-8000-0000000000b2',
  },
  // The same person as u-enrolled, by another email they let in that has no authenticator of
  // its own yet (#88, #90).
  'u-other-email': {
    role: 'owner',
    authenticator: false,
    personAuthenticator: true,
    letIn: 'waiting',
    personLetIn: 'with_authenticator',
    member: '0192f7a0-0000-7000-8000-0000000000b1',
  },
  // The same person again, by emails they haven't let in: one with no authenticator, one that
  // added its own, which counts for nothing (#90).
  'u-not-let-in': {
    role: 'owner',
    authenticator: false,
    personAuthenticator: true,
    letIn: 'no',
    personLetIn: 'with_authenticator',
    member: '0192f7a0-0000-7000-8000-0000000000b1',
  },
  'u-not-let-in-own': {
    role: 'owner',
    authenticator: true,
    personAuthenticator: true,
    letIn: 'no',
    personLetIn: 'with_authenticator',
    member: '0192f7a0-0000-7000-8000-0000000000b1',
  },
  // Someone with an authenticator, none of whose emails is let in yet, by the email they first
  // signed in with: it is let in once it passes its code (#90, #91).
  'u-first': {
    role: 'owner',
    authenticator: true,
    personAuthenticator: true,
    letIn: 'no',
    personLetIn: 'none',
    firstSignIn: true,
    member: '0192f7a0-0000-7000-8000-0000000000b3',
  },
  // Another person, none of whose emails is let in yet: by another email, which added an
  // authenticator of its own and waits to be let in from the first (#91); and by the email they
  // first signed in with, which has none of its own yet and may add one.
  'u-not-first': {
    role: 'owner',
    authenticator: true,
    personAuthenticator: true,
    letIn: 'no',
    personLetIn: 'none',
    member: '0192f7a0-0000-7000-8000-0000000000b4',
  },
  'u-first-held': {
    role: 'owner',
    authenticator: false,
    personAuthenticator: true,
    letIn: 'no',
    personLetIn: 'none',
    firstSignIn: true,
    member: '0192f7a0-0000-7000-8000-0000000000b4',
  },
  // An email let in from another, that added its own authenticator and waits to pass its code.
  'u-waiting': {
    role: 'owner',
    authenticator: true,
    personAuthenticator: true,
    letIn: 'waiting',
    personLetIn: 'with_authenticator',
    member: '0192f7a0-0000-7000-8000-0000000000b3',
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
        letIn: person.letIn,
        personLetIn: person.personLetIn,
        firstSignIn: person.firstSignIn === true,
      }
    : undefined;
};

/**
 * One stand-in for every store. It knows each caller's membership, with where their sign-in
 * stands for the second factor, and the organization's switches, and records who passed their
 * code (#90), answering `passed` as told; any other call means the request got past every
 * check, and answers 409 reached_store with what it reached.
 */
function setup(switchedOn: readonly string[], flagOverrides = '', passed: PassedCode = 'passed') {
  const switched = new Set(switchedOn);
  const reached: string[] = [];
  const recorded: string[] = [];
  const known: Record<string, (...args: never[]) => Promise<unknown>> = {
    recordPassedCode: (_member: CallerMembership, actor: { userId: string }) => {
      recorded.push(actor.userId);
      return Promise.resolve(passed);
    },
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
    recorded,
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
        body: parsed as {
          code?: string;
          detail?: string;
          email?: string;
          noneLetIn?: boolean;
        } | null,
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

/** A feature gate that counts how often the switch is read. */
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
const session = (assuranceLevel: 'aal1' | 'aal2', email: string | null = 'work@example.com') => ({
  userId: 'u-1',
  email,
  assuranceLevel,
});
const member = { orgId: ORG, memberId: ORG, role: 'owner' as const };

describe('admitSignIn, for someone with an authenticator (#85)', () => {
  it('reads the switch only for an enrolled person’s session that skipped the code', async () => {
    const on = counting(true);
    const enrolled = { ...member, authenticator: true, letIn: 'yes' as const };
    const letIn = { ...enrolled, personLetIn: 'with_authenticator' as const };
    await admitSignIn(on.gate, member, session('aal1'));
    await admitSignIn(on.gate, letIn, session('aal2'));
    expect(on.reads()).toBe(0);
    await expect(admitSignIn(on.gate, letIn, session('aal1'))).rejects.toMatchObject({
      status: 403,
      extra: { code: 'second_factor_required' },
    });
    expect(on.reads()).toBe(1);
    const off = counting(false);
    await expect(admitSignIn(off.gate, letIn, session('aal1'))).resolves.toBe(undefined);
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

describe('admitSignIn, for an email let in without its own authenticator (#88)', () => {
  const waiting = {
    ...member,
    personAuthenticator: true,
    letIn: 'waiting' as const,
    personLetIn: 'with_authenticator' as const,
  };

  it('reads the switch only for an email with none of its own, of a person with one', async () => {
    const on = counting(true);
    await admitSignIn(on.gate, member, session('aal1'));
    await admitSignIn(on.gate, { ...member, personAuthenticator: false }, session('aal1'));
    await admitSignIn(
      on.gate,
      { ...waiting, authenticator: true, letIn: 'yes' as const },
      session('aal2'),
    );
    expect(on.reads()).toBe(0);
    await expect(admitSignIn(on.gate, waiting, session('aal1'))).rejects.toMatchObject({
      status: 403,
      extra: { code: 'authenticator_required', email: 'work@example.com' },
    });
    expect(on.reads()).toBe(1);
    const off = counting(false);
    await expect(admitSignIn(off.gate, waiting, session('aal1'))).resolves.toBe(undefined);
  });

  it('says which email when the token names none', async () => {
    const on = counting(true);
    await expect(admitSignIn(on.gate, waiting, session('aal1', null))).rejects.toMatchObject({
      extra: { code: 'authenticator_required', detail: /^The email you signed in with has no/ },
    });
  });
});

/* Only an email a person lets in signs in, once they have an authenticator (#90, Q44). */

const NOT_LET_IN = ['u-not-let-in', 'u-not-let-in-own'] as const;
const notLetIn = (res: { status: number; body: { code?: string } | null }) =>
  res.status === 403 && res.body?.code === 'sign_in_not_let_in';

describe('an email not let in, once a person has an authenticator (#90)', () => {
  it.each(HELD.map((o) => [o.name, o] as const))(
    'refuses every request of an email not let in, while it is on, whatever its session says, its own authenticator included, and reaches nothing: %s',
    async (_name, op) => {
      const s = setup([FLAG]);
      for (const user of NOT_LET_IN) {
        for (const aal of ['aal1', 'aal2'] as const) {
          const res = await s.call(user, aal, op.method, op.url, op.body);
          expect(res, `${user} ${aal}: ${res.body?.detail}`).toMatchObject({
            status: 403,
            body: { code: 'sign_in_not_let_in', email: `${user}@example.com` },
          });
        }
      }
      expect(s.reached).toEqual([]);
      expect(s.recorded).toEqual([]);
    },
  );

  it('names the email that isn’t let in, says its receipts are still filed, and never asks it for a code or an authenticator', async () => {
    const s = setup([FLAG]);
    const res = await s.call('u-not-let-in-own', 'aal1', 'GET', '/v1/reports');
    expect(res.body?.code).toBe('sign_in_not_let_in');
    expect(res.body?.detail).toMatch(/^u-not-let-in-own@example\.com isn't let in to sign in/);
    expect(res.body?.detail).toMatch(/receipts you send from this one are still filed/);
    expect(res.body?.detail).toMatch(/let this one in from Settings › Sign-ins/);
  });

  it('still answers who is signed in, and the organization’s switches, which the screen that says it isn’t let in reads', async () => {
    const s = setup([FLAG]);
    for (const user of NOT_LET_IN) {
      expect(await s.call(user, 'aal1', 'GET', '/v1/me')).toMatchObject({
        status: 200,
        body: { userId: user },
      });
      expect((await s.call(user, 'aal2', 'GET', '/v1/features')).status).toBe(200);
    }
    expect(s.reached).toEqual([]);
  });

  it.each(SIGNED_IN.map((o) => [o.name, o] as const))(
    'changes nothing for an email not let in while the second factor is switched off: %s',
    async (_name, op) => {
      const s = setup([]);
      for (const user of NOT_LET_IN) {
        const res = await s.call(user, 'aal1', op.method, op.url, op.body);
        expect(notLetIn(res) || held(res), user).toBe(false);
      }
      expect(s.recorded).toEqual([]);
    },
  );

  it('changes nothing for an email not let in while the server’s override has it off, whatever the switch says', async () => {
    const s = setup([FLAG], `${FLAG}=off`);
    for (const op of SIGNED_IN.filter((o) => o.name !== LINK)) {
      for (const user of NOT_LET_IN) {
        const res = await s.call(user, 'aal1', op.method, op.url, op.body);
        expect(notLetIn(res) || held(res), `${user} ${op.name}`).toBe(false);
      }
    }
    expect(s.recorded).toEqual([]);
  });

  it('carries no one’s token on the email webhook, so email from any address is still filed', () => {
    const webhook = OPERATIONS.find((o) => o.name === 'POST /v1/inbound/bird');
    expect(webhook?.signedIn).toBe(false);
  });
});

describe('the first email to pass its code, and one let in passing its own (#90)', () => {
  it('lets in the email a person first signed in with once it passes its own code while none is let in, then lets it through', async () => {
    const s = setup([FLAG], '', 'let_in_first');
    const before = await s.call('u-first', 'aal1', 'GET', '/v1/reports');
    expect(before.body?.code).toBe('second_factor_required');
    expect(s.recorded).toEqual([]);
    const after = await s.call('u-first', 'aal2', 'GET', '/v1/reports');
    expect(after.body?.code).toBe('reached_store');
    expect(s.recorded).toEqual(['u-first']);
  });

  it('refuses it after all when the database finds it isn’t the first just then', async () => {
    const s = setup([FLAG], '', 'not_let_in');
    const res = await s.call('u-first', 'aal2', 'GET', '/v1/reports');
    expect(res).toMatchObject({ status: 403, body: { code: 'sign_in_not_let_in' } });
    expect(s.reached).toEqual([]);
  });

  it('keeps an email let in from another let in once it passes its own code', async () => {
    const s = setup([FLAG]);
    expect((await s.call('u-waiting', 'aal1', 'GET', '/v1/reports')).body?.code).toBe(
      'second_factor_required',
    );
    expect((await s.call('u-waiting', 'aal2', 'GET', '/v1/reports')).body?.code).toBe(
      'reached_store',
    );
    expect(s.recorded).toEqual(['u-waiting']);
  });

  it('records nothing for an email let in already, or while the second factor is off', async () => {
    const on = setup([FLAG]);
    await on.call('u-enrolled', 'aal2', 'GET', '/v1/reports');
    expect(on.recorded).toEqual([]);
    const off = setup([]);
    await off.call('u-first', 'aal2', 'GET', '/v1/reports');
    expect(off.recorded).toEqual([]);
  });

  it('reads the switch only when it would refuse or record something', async () => {
    const on = counting(true);
    const first = {
      ...member,
      authenticator: true,
      personAuthenticator: true,
      letIn: 'no' as const,
      personLetIn: 'none' as const,
      firstSignIn: true,
    };
    const record = () => Promise.resolve('let_in_first' as const);
    await admitSignIn(on.gate, { ...member, letIn: 'no' as const }, session('aal2'), record);
    expect(on.reads()).toBe(0);
    await admitSignIn(on.gate, first, session('aal2'), record);
    expect(on.reads()).toBe(1);
    const off = counting(false);
    let recorded = 0;
    await admitSignIn(off.gate, first, session('aal2'), () => {
      recorded += 1;
      return record();
    });
    expect(recorded).toBe(0);
  });
});

/* Only the email a person first signed in with is let in on its own (#91, Q45). */

const SWITCH_ON = ['PUT', `/v1/settings/features/${FLAG}`, { enabled: true }] as const;

describe('only the email a person first signed in with is let in on its own (#91)', () => {
  it.each(HELD.map((o) => [o.name, o] as const))(
    'refuses every request of another email while none is let in, even once it passes a code of its own, records nothing and reaches nothing: %s',
    async (_name, op) => {
      const s = setup([FLAG], '', 'let_in_first');
      for (const aal of ['aal1', 'aal2'] as const) {
        const res = await s.call('u-not-first', aal, op.method, op.url, op.body);
        expect(res, `${aal}: ${res.body?.detail}`).toMatchObject({
          status: 403,
          body: { code: 'sign_in_not_let_in', email: 'u-not-first@example.com', noneLetIn: true },
        });
      }
      expect(s.reached).toEqual([]);
      expect(s.recorded).toEqual([]);
    },
  );

  it('tells another email, while none is let in, to let it in from the one first signed in with, and says nothing of it once one is let in', async () => {
    const s = setup([FLAG]);
    const before = await s.call('u-not-first', 'aal2', 'GET', '/v1/reports');
    expect(before.body?.detail).toMatch(/only the one you first signed in with is let in/);
    expect(before.body?.detail).toMatch(/sign in with the email you first signed in with/);
    expect(before.body?.detail).toMatch(/receipts you send from this one are still filed/);
    const after = await s.call('u-not-let-in-own', 'aal2', 'GET', '/v1/reports');
    expect(after.body).not.toHaveProperty('noneLetIn');
    expect(after.body?.detail).toMatch(/sign in with the email that has your authenticator app/);
  });

  it('asks the email first signed in with to add its own authenticator while another has one and none is let in, never refusing it as not let in', async () => {
    const s = setup([FLAG]);
    for (const aal of ['aal1', 'aal2'] as const) {
      const res = await s.call('u-first-held', aal, 'GET', '/v1/reports');
      expect(res).toMatchObject({
        status: 403,
        body: {
          code: 'authenticator_required',
          email: 'u-first-held@example.com',
          noneLetIn: true,
        },
      });
      expect(res.body?.detail).toMatch(/It is the email you first signed in with, so it is let in/);
    }
    // What adding one in Settings › Sign-ins reads still answers.
    expect((await s.call('u-first-held', 'aal1', 'GET', '/v1/features')).status).toBe(200);
    // One let in, waiting for its own, is held as before, saying nothing of the first.
    const waiting = await s.call(OTHER, 'aal1', 'GET', '/v1/reports');
    expect(waiting.body?.code).toBe('authenticator_required');
    expect(waiting.body).not.toHaveProperty('noneLetIn');
    expect(s.reached).toEqual([]);
    expect(s.recorded).toEqual([]);
  });

  it('changes nothing for another email, or the first, while the second factor is off', async () => {
    for (const s of [setup([]), setup([FLAG], `${FLAG}=off`)]) {
      for (const user of ['u-not-first', 'u-first-held']) {
        const res = await s.call(user, 'aal2', 'GET', '/v1/reports');
        expect(res.body?.code, user).toBe('reached_store');
      }
      expect(s.recorded).toEqual([]);
    }
  });

  it('refuses switching the second factor on from an email it would then refuse, and switches nothing', async () => {
    const s = setup([]);
    const [method, path, body] = SWITCH_ON;
    const notFirst = await s.call('u-not-first', 'aal2', method, path, body);
    expect(notFirst).toMatchObject({
      status: 409,
      body: { code: 'second_factor_would_refuse_you' },
    });
    expect(notFirst.body?.detail).toMatch(/only the email you first signed in with is let in/);
    const notLetIn = await s.call('u-not-let-in-own', 'aal2', method, path, body);
    expect(notLetIn).toMatchObject({
      status: 409,
      body: { code: 'second_factor_would_refuse_you' },
    });
    expect(notLetIn.body?.detail).toMatch(/Switch it on from an email you let in/);
    expect(s.reached).toEqual([]);
    // From the email first signed in with, or one let in, it switches.
    for (const user of ['u-first', 'u-enrolled']) {
      await s.call(user, 'aal2', method, path, body);
    }
    expect(s.reached).toEqual(['switchFeature', 'switchFeature']);
  });
});
