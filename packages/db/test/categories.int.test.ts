import { newId, STARTER_CATEGORY_KEYS, STARTER_TYPE_KEYS } from '@expensewise/domain';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyExpense,
  deleteCategory,
  deleteType,
  expenseClassifications,
  listCatalog,
  memberChoices,
  saveCategory,
  saveType,
  seedStarterCatalog,
  type CatalogRecord,
} from '../src/categories.ts';
import { withOrg } from '../src/client.ts';
import { ensureOwnerOrganization } from '../src/members.ts';
import { auditEvents, expenses, reports } from '../src/schema.ts';
import { linkSignIn } from '../src/sign-ins.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

/** An organization as one is created on first sign-in, with the ready-made set. */
async function freshOrg(name: string) {
  const userId = `user_${newId()}`;
  const { membership } = await ensureOwnerOrganization(app.db, {
    userId,
    email: `${name}@example.com`,
  });
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) =>
    withOrg(app.db, membership.orgId, work);
  const actor = { memberId: membership.memberId, userId };
  return { ...membership, userId, actor, inOrg };
}

const named = (catalog: CatalogRecord) => ({
  category: (name: string) => catalog.categories.find((c) => c.name === name)!,
  type: (name: string) => catalog.types.find((t) => t.name === name)!,
});

const actionsOf = (org: Awaited<ReturnType<typeof freshOrg>>, entityTypes: string[]) =>
  org.inOrg((tx) =>
    tx
      .select({ action: auditEvents.action, payload: auditEvents.payload })
      .from(auditEvents)
      .where(inArray(auditEvents.entityType, entityTypes))
      .orderBy(auditEvents.sequence),
  );

/** A Ready expense typed in by hand, for the member. */
const addExpense = (
  org: Awaited<ReturnType<typeof freshOrg>>,
  merchant: string | null,
  over: Partial<typeof expenses.$inferInsert> = {},
) =>
  org.inOrg(async (tx) => {
    const id = newId();
    await tx.insert(expenses).values({
      id,
      orgId: org.orgId,
      memberId: org.memberId,
      status: 'ready',
      source: 'manual',
      merchant,
      transactionDate: '2026-09-24',
      amountMinor: 650,
      currency: 'USD',
      ...over,
    });
    return id;
  });

describe('the ready-made set (FR-EXP-11, ADR-0036)', () => {
  it('gives a new organization the ready-made categories and types, once', async () => {
    const org = await freshOrg('starter');
    const catalog = await org.inOrg((tx) => listCatalog(tx));
    expect(catalog.categories.map((c) => c.starterKey).sort()).toEqual(
      [...STARTER_CATEGORY_KEYS].sort(),
    );
    expect(catalog.types.map((t) => t.starterKey).sort()).toEqual([...STARTER_TYPE_KEYS].sort());
    const { category, type } = named(catalog);
    expect(
      category('Travel').typeIds.map((id) => catalog.types.find((t) => t.id === id)!.name),
    ).toEqual(['Airfare', 'Ground transport', 'Lodging', 'Mileage']);
    expect(category('Meals').typeIds).toEqual([type('Business meal').id, type('Per-diem meal').id]);
    expect(catalog.categories.every((c) => c.active && !c.inUse && c.parentId === null)).toBe(true);

    await org.inOrg((tx) => seedStarterCatalog(tx, org.orgId));
    const again = await org.inOrg((tx) => listCatalog(tx));
    expect(again.categories).toHaveLength(STARTER_CATEGORY_KEYS.length);
    expect(again.types).toHaveLength(STARTER_TYPE_KEYS.length);

    const [created] = await org.inOrg((tx) =>
      tx.select({ payload: auditEvents.payload }).from(auditEvents),
    );
    expect(created?.payload).toMatchObject({ catalog: 'starter' });
  });

  it('seeds only the organization it runs in', async () => {
    const org = await freshOrg('seed-mine');
    const other = await seedOrg(app.db, 'seed-other');
    await expectDbError(
      org.inOrg((tx) => seedStarterCatalog(tx, other.orgId)),
      /row-level security/,
    );
    expect(await withOrg(app.db, other.orgId, (tx) => listCatalog(tx))).toEqual({
      categories: [],
      types: [],
    });
  });

  it('is no one’s work until a person changes it, so a sign-in can still move out', async () => {
    const target = await seedOrg(app.db, 'catalog-target');
    const untouched = await freshOrg('catalog-untouched');
    const changed = await freshOrg('catalog-changed');
    const travel = named(await changed.inOrg((tx) => listCatalog(tx))).category('Travel');
    await changed.inOrg((tx) =>
      saveCategory(tx, changed.orgId, travel.id, { glCode: '6100' }, changed.actor),
    );
    const move = (org: Awaited<ReturnType<typeof freshOrg>>) =>
      linkSignIn(
        app.db,
        { orgId: target.orgId, memberId: target.memberId, role: 'owner' },
        { userId: org.userId, email: 'x@example.com' },
        target.userId,
      );
    expect((await move(changed)).status).toBe('has_own_organization');
    expect((await move(untouched)).status).toBe('linked');
  });
});

describe('owners and finance admins keep the lists (FR-EXP-11, Q7)', () => {
  it('adds, renames, nests, codes and retires categories and types, each in the audit trail', async () => {
    const org = await freshOrg('catalog-edit');
    const { category, type } = named(await org.inOrg((tx) => listCatalog(tx)));
    const save = (id: string | null, change: Parameters<typeof saveCategory>[3]) =>
      org.inOrg((tx) => saveCategory(tx, org.orgId, id, change, org.actor));
    const saveT = (id: string | null, change: Parameters<typeof saveType>[3]) =>
      org.inOrg((tx) => saveType(tx, org.orgId, id, change, org.actor));

    const rail = await saveT(null, { name: '  Rail  ', parentId: type('Ground transport').id });
    expect(rail).toMatchObject({
      status: 'saved',
      record: { name: 'Rail', parentId: type('Ground transport').id, active: true },
    });
    const railId = rail.status === 'saved' ? rail.record.id : '';
    const client = await save(null, {
      name: 'Client travel',
      parentId: category('Travel').id,
      glCode: ' 6150 ',
      typeIds: [type('Airfare').id, railId, railId],
    });
    expect(client).toMatchObject({
      status: 'saved',
      record: { name: 'Client travel', glCode: '6150', taxCode: null, starterKey: null },
    });
    const clientId = client.status === 'saved' ? client.record.id : '';
    expect(client.status === 'saved' && client.record.typeIds).toEqual([
      type('Airfare').id,
      railId,
    ]);

    // A type can be allowed in several categories.
    expect(
      await save(category('Travel').id, { typeIds: [...category('Travel').typeIds, railId] }),
    ).toMatchObject({ status: 'saved' });
    expect(await save(clientId, { name: 'Client travel', glCode: '6150' })).toMatchObject({
      status: 'unchanged',
    });
    expect(await save(clientId, { typeIds: [railId], active: false })).toMatchObject({
      status: 'saved',
      record: { typeIds: [railId], active: false },
    });
    expect(await saveT(type('Lodging').id, { name: 'Hotels' })).toMatchObject({
      status: 'saved',
      record: { name: 'Hotels', starterKey: 'lodging' },
    });

    const problems = [
      await save(null, { name: '   ' }),
      await save(null, { name: 'travel' }),
      await save(null, { name: 'New', parentId: newId() }),
      await save(category('Travel').id, { parentId: clientId }),
      await save(null, { name: 'New', typeIds: [newId()] }),
      await save(null, { name: 'New', taxCode: 'x'.repeat(41) }),
      await save(null, { name: 'New', glCode: 'x'.repeat(41) }),
      await saveT(railId, { parentId: railId }),
      await saveT(newId(), { name: 'Gone' }),
    ];
    expect(problems.map((p) => (p.status === 'invalid' ? p.problem : p.status))).toEqual([
      'invalid_name',
      'name_taken',
      'no_such_parent',
      'nests_in_itself',
      'no_such_type',
      'invalid_code',
      'invalid_code',
      'nests_in_itself',
      'missing',
    ]);

    const events = await actionsOf(org, ['category', 'expense_type']);
    expect(events.map((e) => e.action)).toEqual([
      'expense_type.created',
      'category.created',
      'category.changed',
      'category.changed',
      'expense_type.changed',
    ]);
    expect(events[3]?.payload).toMatchObject({
      changes: [
        { field: 'typeIds', from: [type('Airfare').id, railId], to: [railId] },
        { field: 'active', from: true, to: false },
      ],
    });
  });

  it('deletes only what no expense has and nothing sits under; one in use is retired and kept', async () => {
    const org = await freshOrg('catalog-delete');
    const { category, type } = named(await org.inOrg((tx) => listCatalog(tx)));
    const expenseId = await addExpense(org, 'Delta Air Lines');
    expect(
      await org.inOrg((tx) =>
        classifyExpense(
          tx,
          org.orgId,
          expenseId,
          { categoryId: category('Travel').id, typeId: type('Airfare').id },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'classified' });

    const del = (kind: 'category' | 'type', id: string) =>
      org.inOrg((tx) =>
        kind === 'category'
          ? deleteCategory(tx, org.orgId, id, org.userId)
          : deleteType(tx, org.orgId, id, org.userId),
      );
    expect(await del('category', category('Travel').id)).toBe('in_use');
    expect(await del('type', type('Airfare').id)).toBe('in_use');
    expect(await del('category', newId())).toBe('missing');
    expect(await del('type', newId())).toBe('missing');

    await org.inOrg((tx) =>
      saveCategory(tx, org.orgId, category('Travel').id, { active: false }, org.actor),
    );
    const kept = await org.inOrg((tx) => expenseClassifications(tx, [expenseId]));
    expect(kept).toMatchObject([{ categoryId: category('Travel').id, typeId: type('Airfare').id }]);

    const child = await org.inOrg((tx) =>
      saveCategory(
        tx,
        org.orgId,
        null,
        { name: 'Supplies', parentId: category('Office').id },
        org.actor,
      ),
    );
    expect(await del('category', category('Office').id)).toBe('has_children');
    expect(await del('category', child.status === 'saved' ? child.record.id : '')).toBe('deleted');
    expect(await del('category', category('Office').id)).toBe('deleted');
    // The type Office allowed stays, allowed nowhere now, until it too goes.
    expect(await del('type', type('Office supplies').id)).toBe('deleted');
    const subtype = await org.inOrg((tx) =>
      saveType(
        tx,
        org.orgId,
        null,
        { name: 'Ferry', parentId: type('Ground transport').id },
        org.actor,
      ),
    );
    expect(subtype.status).toBe('saved');
    expect(await del('type', type('Ground transport').id)).toBe('has_children');

    const after = await org.inOrg((tx) => listCatalog(tx));
    expect(after.categories.map((c) => c.name)).not.toContain('Office');
    expect(after.types.map((t) => t.name)).not.toContain('Office supplies');
    expect(named(after).category('Travel')).toMatchObject({ active: false, inUse: true });
    expect((await actionsOf(org, ['category', 'expense_type'])).map((e) => e.action)).toEqual([
      'category.changed',
      'category.created',
      'category.deleted',
      'category.deleted',
      'expense_type.deleted',
      'expense_type.created',
    ]);
  });
});

describe('a category and type on each expense (FR-EXP-11, FR-INT-10)', () => {
  it('takes a type its category allows, once, and records who chose it', async () => {
    const org = await freshOrg('classify');
    const { category, type } = named(await org.inOrg((tx) => listCatalog(tx)));
    const expenseId = await addExpense(org, 'Pappas Bros. Steakhouse');
    const classify = (categoryId: string, typeId: string, id = expenseId) =>
      org.inOrg((tx) => classifyExpense(tx, org.orgId, id, { categoryId, typeId }, org.userId));

    expect(await classify(category('Meals').id, type('Airfare').id)).toEqual({
      status: 'invalid',
      problem: 'type_not_allowed',
    });
    expect(await classify(category('Meals').id, type('Business meal').id)).toEqual({
      status: 'classified',
    });
    expect(await classify(category('Meals').id, type('Business meal').id)).toEqual({
      status: 'unchanged',
    });
    expect(await classify(category('Meals').id, type('Business meal').id, newId())).toEqual({
      status: 'missing',
    });
    await org.inOrg((tx) =>
      saveType(tx, org.orgId, type('Per-diem meal').id, { active: false }, org.actor),
    );
    expect(await classify(category('Meals').id, type('Per-diem meal').id)).toEqual({
      status: 'invalid',
      problem: 'type_retired',
    });

    const submitted = await addExpense(org, 'Lufthansa', { status: 'submitted' });
    expect(await classify(category('Travel').id, type('Airfare').id, submitted)).toEqual({
      status: 'not_editable',
      current: 'submitted',
    });

    const events = await actionsOf(org, ['expense']);
    expect(events).toEqual([
      {
        action: 'expense.classified',
        payload: {
          categoryId: category('Meals').id,
          typeId: type('Business meal').id,
          previous: null,
        },
      },
    ]);
    await expectDbError(
      org.inOrg((tx) =>
        tx.update(expenses).set({ typeId: null }).where(eq(expenses.id, expenseId)),
      ),
      /expenses_classified_whole/,
    );
  });

  it('opens a closed report again when an expense on it is given a category', async () => {
    const org = await freshOrg('classify-report');
    const { category, type } = named(await org.inOrg((tx) => listCatalog(tx)));
    const reportId = newId();
    const now = new Date();
    await org.inOrg((tx) =>
      tx.insert(reports).values({
        id: reportId,
        orgId: org.orgId,
        memberId: org.memberId,
        title: 'September',
        status: 'closed',
        currency: 'USD',
        closesAt: new Date(now.getTime() + 86_400_000),
        closedAt: now,
      }),
    );
    const expenseId = await addExpense(org, 'Zuni Café', { reportId });
    await org.inOrg((tx) =>
      classifyExpense(
        tx,
        org.orgId,
        expenseId,
        { categoryId: category('Meals').id, typeId: type('Business meal').id },
        org.userId,
      ),
    );
    const [report] = await org.inOrg((tx) =>
      tx.select({ status: reports.status }).from(reports).where(eq(reports.id, reportId)),
    );
    expect(report?.status).toBe('open');
  });

  it('learns from each member’s own choices, newest first, for expenses that name a merchant', async () => {
    const org = await freshOrg('choices');
    const other = await freshOrg('choices-other');
    const { category, type } = named(await org.inOrg((tx) => listCatalog(tx)));
    const classify = async (merchant: string | null, typeName: string, categoryName: string) => {
      const id = await addExpense(org, merchant);
      await org.inOrg((tx) =>
        classifyExpense(
          tx,
          org.orgId,
          id,
          { categoryId: category(categoryName).id, typeId: type(typeName).id },
          org.userId,
        ),
      );
    };
    await classify('Uber', 'Ground transport', 'Travel');
    await classify(null, 'Other', 'Other');
    await classify('Uber Eats', 'Business meal', 'Meals');

    const choices = await org.inOrg((tx) => memberChoices(tx, [org.memberId, org.memberId]));
    expect(choices).toEqual([
      {
        memberId: org.memberId,
        merchant: 'Uber Eats',
        categoryId: category('Meals').id,
        typeId: type('Business meal').id,
      },
      {
        memberId: org.memberId,
        merchant: 'Uber',
        categoryId: category('Travel').id,
        typeId: type('Ground transport').id,
      },
    ]);
    expect(await org.inOrg((tx) => memberChoices(tx, []))).toEqual([]);
    expect(await org.inOrg((tx) => expenseClassifications(tx, []))).toEqual([]);
    // Another organization's choices are its own.
    expect(await other.inOrg((tx) => memberChoices(tx, [org.memberId]))).toEqual([]);
  });
});
