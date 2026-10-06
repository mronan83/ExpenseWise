import type { CatalogRecord, ExpenseRecord } from '@expensewise/db';
import { suggestCategory, treeOrder, type CatalogNode } from '@expensewise/domain';
import type { CategoryStore, Classifying } from './categories.ts';
import { expenseDetail } from './expense-views.ts';
import { filedReading } from './receipt-views.ts';
import type { ReceiptWithReadings } from './receipts.ts';

/**
 * Both lists in tree order, each node with its depth, and whether the caller may change them.
 * With `companyPaid`, while Paid by the company is on, each type says whether the company pays
 * it directly (FR-EXP-18).
 */
export function catalogView(catalog: CatalogRecord, canManage: boolean, companyPaid = false) {
  return {
    categories: treeOrder(catalog.categories).map(({ node, depth }) => ({
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      depth,
      active: node.active,
      inUse: node.inUse,
      glCode: node.glCode,
      taxCode: node.taxCode,
      typeIds: [...node.typeIds],
    })),
    types: treeOrder(catalog.types).map(({ node, depth }) => ({
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      depth,
      active: node.active,
      inUse: node.inUse,
      ...(companyPaid ? { companyPays: node.companyPays ?? false } : {}),
    })),
    canManage,
  };
}

export const categoryView = (catalog: CatalogRecord, id: string) =>
  catalogView(catalog, true).categories.find((c) => c.id === id);

export const typeView = (catalog: CatalogRecord, id: string) =>
  catalogView(catalog, true).types.find((t) => t.id === id);

export type ExpenseCategory = ReturnType<typeof expenseCategory>;

const shown = (list: readonly CatalogNode[], id: string) => {
  const node = list.find((n) => n.id === id);
  return node ? { id: node.id, name: node.name, active: node.active } : null;
};

/**
 * An expense's category and type: those a person chose, else a suggestion worked out from what
 * it shows (FR-INT-10, ADR-0036), else missing, which the expense says.
 */
export function expenseCategory(
  expense: ExpenseRecord,
  proof: ReceiptWithReadings | null,
  { catalog, chosen, history }: Classifying,
) {
  const mine = chosen.find((c) => c.expenseId === expense.id);
  if (mine) {
    return {
      state: 'confirmed' as const,
      category: shown(catalog.categories, mine.categoryId),
      type: shown(catalog.types, mine.typeId),
      basis: null,
    };
  }
  const reading = proof ? filedReading(proof.receipt, proof.runs, proof.reviews) : null;
  const suggestion = suggestCategory(
    {
      merchant: expense.merchant,
      readMerchant: reading?.merchant?.value ?? null,
      documentType: reading?.documentType ?? null,
      source: expense.source,
    },
    history.filter((h) => h.memberId === expense.memberId),
    catalog,
  );
  if (suggestion) {
    return {
      state: 'suggested' as const,
      category: shown(catalog.categories, suggestion.categoryId),
      type: shown(catalog.types, suggestion.typeId),
      basis: suggestion.basis,
    };
  }
  return { state: 'missing' as const, category: null, type: null, basis: null };
}

/** One expense as its page shows it, with its category and type when a store is given. */
export async function detailWithCategory(
  store: CategoryStore | undefined,
  orgId: string,
  found: { readonly expense: ExpenseRecord; readonly proof: ReceiptWithReadings | null },
) {
  const detail = expenseDetail(found.expense, found.proof);
  if (!store) return detail;
  const category = (await categorize(store, orgId, [found])).get(found.expense.id);
  return { ...detail, category };
}

/** Each expense's category and type, by expense id, read in one go. */
export async function categorize(
  store: CategoryStore,
  orgId: string,
  items: readonly { readonly expense: ExpenseRecord; readonly proof: ReceiptWithReadings | null }[],
): Promise<Map<string, ExpenseCategory>> {
  if (items.length === 0) return new Map();
  const classifying = await store.classifying(
    orgId,
    items.map((i) => i.expense.id),
    items.map((i) => i.expense.memberId),
  );
  return new Map(
    items.map((i) => [i.expense.id, expenseCategory(i.expense, i.proof, classifying)]),
  );
}
