/**
 * Emails that filed nothing, through the API on a real database, as expensewise_app (#59): kept
 * as the email workflow keeps them, shown in each member's own Needs you, and dismissed only by
 * the member they came from. Run with `pnpm test:integration`.
 */
import { randomBytes } from 'node:crypto';
import {
  createDatabase,
  findMemberships,
  recordInboundEmail,
  withOrg,
  type NewInboundEmail,
} from '@expensewise/db';
import { newId } from '@expensewise/domain';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbHomeStore } from '../src/home.ts';
import { dbPeopleStore } from '../src/people.ts';
import { dbReceiptStore } from '../src/receipts.ts';
import { dbReportStore } from '../src/reports.ts';
import { dbUnfiledEmailStore } from '../src/unfiled-emails.ts';
import { dbWorkspaceStore } from '../src/workspace.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    relayUrl: string;
  }
}

const { db, pool } = createDatabase(inject('appUrl'));
afterAll(async () => {
  await pool.end();
});

const apiWith = (flagOverrides: string) =>
  createApi({
    version: 'int',
    // Signs a request in as whoever its bearer token names.
    verifyToken: (token) =>
      Promise.resolve({
        userId: token,
        email: `${token}@example.com`,
        assuranceLevel: 'aal1',
        sessionId: 's',
        issuedAt: new Date(),
      }),
    workspace: dbWorkspaceStore(db),
    receipts: dbReceiptStore(db),
    home: dbHomeStore(db),
    reports: dbReportStore(db),
    people: dbPeopleStore(db),
    emails: dbUnfiledEmailStore(db),
    flagOverrides,
  });
const on = apiWith('team.invites=on,receipts.unfiled-emails=on');
const off = apiWith('team.invites=on');

const run = randomBytes(3).toString('hex');
const user = (name: string) => `${name}-${run}`;

interface Item {
  readonly kind: string;
  readonly email?: { readonly id: string; readonly subject: string | null };
  readonly reason: { readonly code: string; readonly problem?: string | null };
}
interface Body {
  readonly token: string;
  readonly code?: string;
  readonly items: Item[];
  readonly needsYou: { readonly count: number; readonly items: Item[] };
}

async function call(api: typeof on, who: string, method: string, path: string, body?: unknown) {
  const res = await api.request(path, {
    method,
    headers: {
      authorization: `Bearer ${who}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
}

/** Keeps an email for a member as the email workflow does: for the system, in its organization. */
async function keep(who: string, over: Partial<NewInboundEmail>): Promise<string> {
  const [member] = await findMemberships(db, who);
  if (!member) throw new Error(`${who} is in no organization`);
  const id = newId();
  await withOrg(db, member.orgId, (tx) =>
    recordInboundEmail(
      tx,
      member.orgId,
      {
        id,
        memberId: member.memberId,
        provider: 'bird',
        providerMessageId: `rem_${id}`,
        fromAddress: `${who}@example.com`,
        subject: null,
        sentAt: null,
        status: 'no_attachments',
        bodyText: null,
        ...over,
      },
      [],
      who,
    ),
  );
  return id;
}

const emailsIn = (items: Item[]) => items.filter((i) => i.kind === 'email');

describe('emails that filed nothing, by API (#59)', () => {
  const riley = user('riley');
  const sam = user('sam');
  let unproved: string;
  let empty: string;
  let samsEmail: string;
  let filed: string;

  beforeAll(async () => {
    expect((await call(on, riley, 'POST', '/v1/me/organization')).status).toBe(201);
    const made = await call(on, riley, 'POST', '/v1/settings/people/invites', { role: 'member' });
    expect(made.status).toBe(201);
    expect(
      (await call(on, sam, 'POST', '/v1/invites/accept', { token: made.body.token })).status,
    ).toBe(200);
    empty = await keep(riley, { subject: 'Receipt' });
    unproved = await keep(riley, {
      status: 'unverified',
      senderProblem: 'signature_failed',
      subject: 'Fwd: Your ride',
    });
    filed = await keep(riley, { status: 'filed', bodyText: 'Thanks for riding' });
    samsEmail = await keep(sam, { status: 'unverified', senderProblem: 'unsigned' });
  });

  it('shows each member only their own, with why, in the inbox and on Home', async () => {
    const inbox = await call(on, riley, 'GET', '/v1/inbox');
    expect(inbox.status).toBe(200);
    const listed = emailsIn(inbox.body.items);
    expect(listed.map((i) => [i.email?.id, i.email?.subject, i.reason])).toEqual([
      [unproved, 'Fwd: Your ride', { code: 'unproved', problem: 'signature_failed' }],
      [empty, 'Receipt', { code: 'empty', problem: null }],
    ]);
    const home = await call(on, riley, 'GET', '/v1/home');
    expect(home.body.needsYou.count).toBe(2);
    const sams = await call(on, sam, 'GET', '/v1/inbox');
    expect(emailsIn(sams.body.items).map((i) => i.email?.id)).toEqual([samsEmail]);
  });

  it('shows none, and dismisses none, with the feature off', async () => {
    const inbox = await call(off, riley, 'GET', '/v1/inbox');
    expect(inbox.body.items).toEqual([]);
    expect((await call(off, riley, 'GET', '/v1/home')).body.needsYou.count).toBe(0);
    const refused = await call(off, riley, 'POST', `/v1/inbox/emails/${empty}/dismiss`);
    expect(refused).toMatchObject({ status: 404, body: { code: 'feature_off' } });
  });

  it('lets only the member it came from dismiss it, once, and never one that filed receipts', async () => {
    // The owner sees Sam's records, and still can't dismiss Sam's email; Sam can't find Riley's.
    const owners = await call(on, riley, 'POST', `/v1/inbox/emails/${samsEmail}/dismiss`);
    expect(owners).toMatchObject({ status: 403, body: { code: 'not_yours' } });
    const sams = await call(on, sam, 'POST', `/v1/inbox/emails/${empty}/dismiss`);
    expect(sams).toMatchObject({ status: 404, body: { code: 'not_found' } });
    const receipts = await call(on, riley, 'POST', `/v1/inbox/emails/${filed}/dismiss`);
    expect(receipts.status).toBe(404);

    expect((await call(on, riley, 'POST', `/v1/inbox/emails/${unproved}/dismiss`)).status).toBe(
      204,
    );
    expect((await call(on, riley, 'POST', `/v1/inbox/emails/${unproved}/dismiss`)).status).toBe(
      204,
    );
    const after = await call(on, riley, 'GET', '/v1/inbox');
    expect(emailsIn(after.body.items).map((i) => i.email?.id)).toEqual([empty]);
  });
});
