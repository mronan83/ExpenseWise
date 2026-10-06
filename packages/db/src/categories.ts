import {
  catalogCode,
  catalogName,
  checkChoice,
  followPolicy,
  isTripMovable,
  nestsInItself,
  type CatalogCategory,
  type CatalogNode,
  type ChoiceProblem,
  type ConfirmedChoice,
  type ExpenseStatus,
} from '@expensewise/domain';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites } from './audit.ts';
import type { Transaction } from './client.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import {
  categories,
  categoryTypes,
  expenseLines,
  expenseParts,
  expenses,
  expenseTypes,
} from './schema.ts';

/*
 * Categories and types an organization defines (FR-EXP-11, Q7, ADR-0036), and the category and
 * type a person chooses for each expense. Every write takes the organization's write lock first
 * and appends its audit event in the same transaction. Who may write is the caller's to check.
 */

export interface CategoryRecord extends CatalogCategory {
  readonly glCode: string | null;
  readonly taxCode: string | null;
  /** Some expense has it, so it can only be retired, never deleted. */
  readonly inUse: boolean;
}

export interface TypeRecord extends CatalogNode {
  /** Some expense has it, so it can only be retired, never deleted. */
  readonly inUse: boolean;
  /**
   * The policy says the company pays it directly (FR-EXP-18, Q46). Read from the database; a
   * record made elsewhere, such as a test's, may leave it out.
   */
  readonly companyPays?: boolean;
}

export interface CatalogRecord {
  readonly categories: readonly CategoryRecord[];
  readonly types: readonly TypeRecord[];
}

/** Gives a new organization the ready-made set. Call inside withOrg(), as it is created. */
export async function seedStarterCatalog(tx: Transaction, orgId: string): Promise<void> {
  await tx.execute(sql`select seed_starter_catalog(${orgId}::uuid)`);
}

/** The organization's categories and types, retired ones included, by name. Call inside withOrg(). */
export async function listCatalog(tx: Transaction): Promise<CatalogRecord> {
  const node = (table: typeof categories | typeof expenseTypes) => ({
    id: table.id,
    parentId: table.parentId,
    name: table.name,
    active: table.active,
    starterKey: table.starterKey,
  });
  const categoryRows = await tx
    .select({ ...node(categories), glCode: categories.glCode, taxCode: categories.taxCode })
    .from(categories)
    .orderBy(asc(categories.name));
  const typeRows = await tx
    .select({ ...node(expenseTypes), companyPays: expenseTypes.companyPays })
    .from(expenseTypes)
    .orderBy(asc(expenseTypes.name));
  const links = await tx
    .select({ categoryId: categoryTypes.categoryId, typeId: categoryTypes.typeId })
    .from(categoryTypes);
  const chosen = (table: typeof expenses | typeof expenseParts | typeof expenseLines) =>
    tx
      .selectDistinct({ categoryId: table.categoryId, typeId: table.typeId })
      .from(table)
      .where(isNotNull(table.typeId));
  // An expense's own, and those its parts and lines were given in a split (FR-EXP-15).
  const used = [
    ...(await chosen(expenses)),
    ...(await chosen(expenseParts)),
    ...(await chosen(expenseLines)),
  ];
  const usedCategories = new Set(used.map((u) => u.categoryId));
  const usedTypes = new Set(used.map((u) => u.typeId));
  const typeNames = new Map(typeRows.map((t) => [t.id, t.name]));
  return {
    categories: categoryRows.map((c) => ({
      ...c,
      typeIds: links
        .filter((l) => l.categoryId === c.id)
        .map((l) => l.typeId)
        .sort((a, b) => (typeNames.get(a) ?? '').localeCompare(typeNames.get(b) ?? '')),
      inUse: usedCategories.has(c.id),
    })),
    types: typeRows.map((t) => ({ ...t, inUse: usedTypes.has(t.id) })),
  };
}

/** Who is changing the catalog: the member, for the row, and their sign-in, for the audit trail. */
export interface CatalogActor {
  readonly memberId: string;
  readonly userId: string;
}

export type CatalogProblem =
  | 'invalid_name'
  | 'name_taken'
  | 'invalid_code'
  | 'no_such_parent'
  | 'nests_in_itself'
  | 'no_such_type';

export type CatalogWrite<T> =
  | { readonly status: 'saved'; readonly record: T }
  /** It was already so. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged'; readonly record: T }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly problem: CatalogProblem; readonly field: string };

/** What to set on a category; whatever is left out stays as it is. */
export interface CategoryChange {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly glCode?: string | null;
  readonly taxCode?: string | null;
  /** The types it allows, all of them. */
  readonly typeIds?: readonly string[];
  /** false retires it, true brings it back. */
  readonly active?: boolean;
}

/** What to set on a type; whatever is left out stays as it is. */
export interface TypeChange {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly active?: boolean;
}

export type CatalogDeletion = 'deleted' | 'missing' | 'in_use' | 'has_children';

interface FieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

const invalid = (problem: CatalogProblem, field: string) =>
  ({ status: 'invalid', problem, field }) as const;

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** The name, parent and state every node has, checked against its own list. */
function nodeChange<T extends CatalogNode>(
  list: readonly T[],
  current: T | undefined,
  change: { readonly name?: string; readonly parentId?: string | null; readonly active?: boolean },
) {
  const name = change.name === undefined ? (current?.name ?? null) : catalogName(change.name);
  if (name === null) return invalid('invalid_name', 'name');
  const taken = list.some(
    (n) => n.id !== current?.id && n.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) return invalid('name_taken', 'name');
  const parentId = change.parentId === undefined ? (current?.parentId ?? null) : change.parentId;
  if (parentId !== null && !list.some((n) => n.id === parentId)) {
    return invalid('no_such_parent', 'parentId');
  }
  if (current && nestsInItself(list, current.id, parentId)) {
    return invalid('nests_in_itself', 'parentId');
  }
  return {
    status: 'ok',
    name,
    parentId,
    active: change.active ?? current?.active ?? true,
  } as const;
}

/** What differs between a node as it is and as it will be, field by field. */
function changesOf<T extends object>(before: T | undefined, after: Partial<T>): FieldChange[] {
  if (!before) return [];
  return (Object.keys(after) as (keyof T & string)[]).flatMap((field): FieldChange[] => {
    const from: unknown = before[field];
    const to: unknown = after[field];
    const same = Array.isArray(from) && Array.isArray(to) ? sameList(from, to) : from === to;
    return same ? [] : [{ field, from, to }];
  });
}

/**
 * Adds a category (`id` null) or changes one: its name, where it sits, its codes, the types it
 * allows, or whether it is retired. Call inside withOrg().
 */
export async function saveCategory(
  tx: Transaction,
  orgId: string,
  id: string | null,
  change: CategoryChange,
  actor: CatalogActor,
): Promise<CatalogWrite<CategoryRecord>> {
  await lockOrgWrites(tx, orgId);
  const catalog = await listCatalog(tx);
  const current = id === null ? undefined : catalog.categories.find((c) => c.id === id);
  if (id !== null && !current) return { status: 'missing' };

  const node = nodeChange(catalog.categories, current, change);
  if (node.status === 'invalid') return node;
  const glCode =
    change.glCode === undefined ? (current?.glCode ?? null) : catalogCode(change.glCode);
  if (glCode === undefined) return invalid('invalid_code', 'glCode');
  const taxCode =
    change.taxCode === undefined ? (current?.taxCode ?? null) : catalogCode(change.taxCode);
  if (taxCode === undefined) return invalid('invalid_code', 'taxCode');
  const typeIds =
    change.typeIds === undefined ? (current?.typeIds ?? []) : [...new Set(change.typeIds)];
  if (typeIds.some((t) => !catalog.types.some((x) => x.id === t))) {
    return invalid('no_such_type', 'typeIds');
  }

  const after = {
    name: node.name,
    parentId: node.parentId,
    glCode,
    taxCode,
    typeIds,
    active: node.active,
  };
  const changes = changesOf(current, after);
  if (current && changes.length === 0) return { status: 'unchanged', record: current };

  const now = new Date();
  const values = {
    name: node.name,
    parentId: node.parentId,
    glCode,
    taxCode,
    active: node.active,
    updatedByMemberId: actor.memberId,
    updatedAt: now,
  };
  let categoryId: string;
  if (current) {
    categoryId = current.id;
    await tx.update(categories).set(values).where(eq(categories.id, categoryId));
  } else {
    const [row] = await tx
      .insert(categories)
      .values({ orgId, ...values })
      .returning({ id: categories.id });
    categoryId = row!.id;
  }
  const before = current?.typeIds ?? [];
  const removed = before.filter((t) => !typeIds.includes(t));
  const added = typeIds.filter((t) => !before.includes(t));
  if (removed.length > 0) {
    await tx
      .delete(categoryTypes)
      .where(and(eq(categoryTypes.categoryId, categoryId), inArray(categoryTypes.typeId, removed)));
  }
  if (added.length > 0) {
    await tx.insert(categoryTypes).values(added.map((typeId) => ({ orgId, categoryId, typeId })));
  }
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actor.userId },
    entityType: 'category',
    entityId: categoryId,
    action: current ? 'category.changed' : 'category.created',
    payload: current ? { changes } : after,
  });
  const saved = (await listCatalog(tx)).categories.find((c) => c.id === categoryId)!;
  return { status: 'saved', record: saved };
}

/** Adds a type (`id` null) or changes one: its name, where it sits, or whether it is retired. */
export async function saveType(
  tx: Transaction,
  orgId: string,
  id: string | null,
  change: TypeChange,
  actor: CatalogActor,
): Promise<CatalogWrite<TypeRecord>> {
  await lockOrgWrites(tx, orgId);
  const catalog = await listCatalog(tx);
  const current = id === null ? undefined : catalog.types.find((t) => t.id === id);
  if (id !== null && !current) return { status: 'missing' };

  const node = nodeChange(catalog.types, current, change);
  if (node.status === 'invalid') return node;
  const after = { name: node.name, parentId: node.parentId, active: node.active };
  const changes = changesOf(current, after);
  if (current && changes.length === 0) return { status: 'unchanged', record: current };

  const values = { ...after, updatedByMemberId: actor.memberId, updatedAt: new Date() };
  let typeId: string;
  if (current) {
    typeId = current.id;
    await tx.update(expenseTypes).set(values).where(eq(expenseTypes.id, typeId));
  } else {
    const [row] = await tx
      .insert(expenseTypes)
      .values({ orgId, ...values })
      .returning({ id: expenseTypes.id });
    typeId = row!.id;
  }
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actor.userId },
    entityType: 'expense_type',
    entityId: typeId,
    action: current ? 'expense_type.changed' : 'expense_type.created',
    payload: current ? { changes } : after,
  });
  const saved = (await listCatalog(tx)).types.find((t) => t.id === typeId)!;
  return { status: 'saved', record: saved };
}

/**
 * Deletes a category no expense has and none sits under, with the types it allowed. One in use
 * is retired instead, so old claims keep it. Call inside withOrg().
 */
export async function deleteCategory(
  tx: Transaction,
  orgId: string,
  id: string,
  actorUserId: string,
): Promise<CatalogDeletion> {
  await lockOrgWrites(tx, orgId);
  const catalog = await listCatalog(tx);
  const found = catalog.categories.find((c) => c.id === id);
  if (!found) return 'missing';
  if (found.inUse) return 'in_use';
  if (catalog.categories.some((c) => c.parentId === id)) return 'has_children';
  await tx.delete(categoryTypes).where(eq(categoryTypes.categoryId, id));
  await tx.delete(categories).where(eq(categories.id, id));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'category',
    entityId: id,
    action: 'category.deleted',
    payload: { name: found.name, typeIds: found.typeIds },
  });
  return 'deleted';
}

/** Deletes a type no expense has and none sits under; the categories that allowed it stop. */
export async function deleteType(
  tx: Transaction,
  orgId: string,
  id: string,
  actorUserId: string,
): Promise<CatalogDeletion> {
  await lockOrgWrites(tx, orgId);
  const catalog = await listCatalog(tx);
  const found = catalog.types.find((t) => t.id === id);
  if (!found) return 'missing';
  if (found.inUse) return 'in_use';
  if (catalog.types.some((t) => t.parentId === id)) return 'has_children';
  await tx.delete(categoryTypes).where(eq(categoryTypes.typeId, id));
  await tx.delete(expenseTypes).where(eq(expenseTypes.id, id));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'expense_type',
    entityId: id,
    action: 'expense_type.deleted',
    payload: { name: found.name },
  });
  return 'deleted';
}

/** The category and type a person chose for an expense, and when. */
export interface ExpenseClassification {
  readonly expenseId: string;
  readonly categoryId: string;
  readonly typeId: string;
  readonly classifiedAt: Date;
}

/** The category and type chosen for each of these expenses that has them. Call inside withOrg(). */
export async function expenseClassifications(
  tx: Transaction,
  expenseIds: readonly string[],
): Promise<ExpenseClassification[]> {
  if (expenseIds.length === 0) return [];
  const rows = await tx
    .select({
      expenseId: expenses.id,
      categoryId: expenses.categoryId,
      typeId: expenses.typeId,
      classifiedAt: expenses.classifiedAt,
    })
    .from(expenses)
    .where(and(inArray(expenses.id, [...expenseIds]), isNotNull(expenses.typeId)));
  return rows.flatMap((r) =>
    r.categoryId && r.typeId && r.classifiedAt
      ? [
          {
            expenseId: r.expenseId,
            categoryId: r.categoryId,
            typeId: r.typeId,
            classifiedAt: r.classifiedAt,
          },
        ]
      : [],
  );
}

/** A choice a member made for one of their expenses, with whose it was. */
export interface MemberChoice extends ConfirmedChoice {
  readonly memberId: string;
}

/** How many past choices suggestions look through: the newest, across the members asked for. */
export const CHOICE_HISTORY_LIMIT = 1000;

/**
 * What these members chose for their expenses that name a merchant, newest first: what
 * suggestions learn from (FR-INT-10). Call inside withOrg().
 */
export async function memberChoices(
  tx: Transaction,
  memberIds: readonly string[],
): Promise<MemberChoice[]> {
  if (memberIds.length === 0) return [];
  const rows = await tx
    .select({
      memberId: expenses.memberId,
      merchant: expenses.merchant,
      categoryId: expenses.categoryId,
      typeId: expenses.typeId,
    })
    .from(expenses)
    .where(
      and(
        inArray(expenses.memberId, [...new Set(memberIds)]),
        isNotNull(expenses.classifiedAt),
        isNotNull(expenses.merchant),
      ),
    )
    .orderBy(desc(expenses.classifiedAt), desc(expenses.id))
    .limit(CHOICE_HISTORY_LIMIT);
  return rows.flatMap((r) =>
    r.merchant && r.categoryId && r.typeId
      ? [{ memberId: r.memberId, merchant: r.merchant, categoryId: r.categoryId, typeId: r.typeId }]
      : [],
  );
}

export type ClassifyResult =
  | { readonly status: 'classified' }
  /** It already had them. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  /** Submitted or later: it stays as it went in. */
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus }
  | { readonly status: 'invalid'; readonly problem: ChoiceProblem };

/**
 * Gives an expense the category and type a person chose, or confirms the ones suggested
 * (FR-EXP-11, FR-INT-10): both in use, the type one the category allows. Not once it is
 * submitted. A closed report it is on opens again, as for any change. Call inside withOrg().
 */
export async function classifyExpense(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  choice: { readonly categoryId: string; readonly typeId: string },
  actorUserId: string,
): Promise<ClassifyResult> {
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({
      status: expenses.status,
      source: expenses.source,
      categoryId: expenses.categoryId,
      typeId: expenses.typeId,
      companyPaid: expenses.companyPaid,
      pinned: expenses.companyPaidPinned,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (!isTripMovable(expense.status)) return { status: 'not_editable', current: expense.status };
  // What it already has stays, even once retired.
  if (expense.categoryId === choice.categoryId && expense.typeId === choice.typeId) {
    return { status: 'unchanged' };
  }
  const catalog = await listCatalog(tx);
  const checked = checkChoice(catalog, choice.categoryId, choice.typeId);
  if (!checked.ok) return { status: 'invalid', problem: checked.error };
  // One not set by hand follows the policy for its new type (Q46); a drive never does.
  const policy = catalog.types.find((t) => t.id === checked.value.typeId)?.companyPays ?? false;
  const paid =
    expense.source === 'mileage'
      ? expense
      : followPolicy({ companyPaid: expense.companyPaid, pinned: expense.pinned }, policy);
  const now = new Date();
  await tx
    .update(expenses)
    .set({ ...checked.value, companyPaid: paid.companyPaid, classifiedAt: now, updatedAt: now })
    .where(eq(expenses.id, expenseId));
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.classified',
    payload: {
      ...checked.value,
      previous:
        expense.categoryId && expense.typeId
          ? { categoryId: expense.categoryId, typeId: expense.typeId }
          : null,
      // Who paid it, when the policy for its new type changed that (FR-EXP-18).
      ...(paid.companyPaid === expense.companyPaid
        ? {}
        : { companyPaid: { from: expense.companyPaid, to: paid.companyPaid } }),
    },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'an expense on it was given a category',
  );
  return { status: 'classified' };
}
