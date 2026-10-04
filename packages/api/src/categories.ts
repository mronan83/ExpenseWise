import {
  classifyExpense,
  deleteCategory,
  deleteType,
  expenseClassifications,
  listCatalog,
  listUncodedExpenses,
  memberChoices,
  saveCategory,
  saveType,
  type CatalogActor,
  type CatalogDeletion,
  type CatalogRecord,
  type CatalogWrite,
  type CategoryChange,
  type CategoryRecord,
  type ClassifyResult,
  type Database,
  type ExpenseClassification,
  type MemberChoice,
  type Transaction,
  type TypeChange,
  type TypeRecord,
} from '@expensewise/db';
import { asCaller } from './caller.ts';
import { withProofs, type ExpensesWithProof } from './expenses.ts';

/** What showing expenses with their categories needs, read at once. */
export interface Classifying {
  readonly catalog: CatalogRecord;
  /** The category and type chosen for each expense asked about that has them. */
  readonly chosen: readonly ExpenseClassification[];
  /** What the expenses' owners chose before, newest first, for suggestions. */
  readonly history: readonly MemberChoice[];
}

/** A member's expenses with no category and type, and what to suggest for each (Q27). */
export interface UncodedNeedingYou extends ExpensesWithProof {
  readonly classifying: Classifying;
}

/**
 * A member's own Ready expenses with no category and type, oldest first, with their receipts
 * and what suggestions learn from, for Needs you (FR-EXP-11, Q27). Call inside withOrg().
 */
export async function uncodedNeedingYou(
  tx: Transaction,
  memberId: string,
  limit: number,
): Promise<UncodedNeedingYou> {
  const found = await withProofs(tx, await listUncodedExpenses(tx, memberId, limit));
  return {
    ...found,
    classifying: {
      catalog: await listCatalog(tx),
      chosen: [],
      history: await memberChoices(tx, [memberId]),
    },
  };
}

/**
 * What the API needs from the database for categories and types (FR-EXP-11, FR-INT-10). Every
 * write appends its audit event in the same transaction. Tests use an in-memory fake.
 */
export interface CategoryStore {
  catalog(orgId: string): Promise<CatalogRecord>;
  /** Adds a category (`id` null) or changes one. */
  saveCategory(
    orgId: string,
    id: string | null,
    change: CategoryChange,
    actor: CatalogActor,
  ): Promise<CatalogWrite<CategoryRecord>>;
  /** Adds a type (`id` null) or changes one. */
  saveType(
    orgId: string,
    id: string | null,
    change: TypeChange,
    actor: CatalogActor,
  ): Promise<CatalogWrite<TypeRecord>>;
  deleteCategory(orgId: string, id: string, actorUserId: string): Promise<CatalogDeletion>;
  deleteType(orgId: string, id: string, actorUserId: string): Promise<CatalogDeletion>;
  /** Gives an expense the category and type a person chose, or confirms a suggestion. */
  classify(
    orgId: string,
    expenseId: string,
    choice: { readonly categoryId: string; readonly typeId: string },
    actorUserId: string,
  ): Promise<ClassifyResult>;
  classifying(
    orgId: string,
    expenseIds: readonly string[],
    memberIds: readonly string[],
  ): Promise<Classifying>;
}

/** The category store on Postgres, as expensewise_app and as the caller. */
export function dbCategoryStore(db: Database): CategoryStore {
  // As the caller, so row-level security shows and changes only what their role allows (ADR-0035).
  const inOrg = asCaller(db);

  return {
    catalog: (orgId) => inOrg(orgId, (tx) => listCatalog(tx)),
    saveCategory: (orgId, id, change, actor) =>
      inOrg(orgId, (tx) => saveCategory(tx, orgId, id, change, actor)),
    saveType: (orgId, id, change, actor) =>
      inOrg(orgId, (tx) => saveType(tx, orgId, id, change, actor)),
    deleteCategory: (orgId, id, actor) =>
      inOrg(orgId, (tx) => deleteCategory(tx, orgId, id, actor)),
    deleteType: (orgId, id, actor) => inOrg(orgId, (tx) => deleteType(tx, orgId, id, actor)),
    classify: (orgId, expenseId, choice, actor) =>
      inOrg(orgId, (tx) => classifyExpense(tx, orgId, expenseId, choice, actor)),
    classifying: (orgId, expenseIds, memberIds) =>
      inOrg(orgId, async (tx) => ({
        catalog: await listCatalog(tx),
        chosen: await expenseClassifications(tx, expenseIds),
        history: await memberChoices(tx, memberIds),
      })),
  };
}
