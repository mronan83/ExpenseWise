/** The feature that brings categories and types (FR-EXP-11, FR-INT-10). */
export const CATEGORIES_FLAG = 'expenses.categories';

interface CatalogNode {
  id: string;
  name: string;
  parentId: string | null;
  /** How deep it sits: 0 at the top. Lists come in tree order. */
  depth: number;
  /** False once retired: no longer offered, kept by the expenses that have it. */
  active: boolean;
  /** Some expense has it, so it can be retired but not deleted. */
  inUse: boolean;
}

export interface ExpenseType extends CatalogNode {
  /**
   * The policy says the company pays it directly (FR-EXP-18): only while Paid by the company
   * is on.
   */
  companyPays?: boolean;
}

export interface Category extends CatalogNode {
  glCode: string | null;
  taxCode: string | null;
  /** The types it allows. */
  typeIds: string[];
}

export interface Catalog {
  categories: Category[];
  types: ExpenseType[];
  /** Owners and finance admins change them; everyone chooses from them. */
  canManage: boolean;
}

interface Chosen {
  id: string;
  name: string;
  active: boolean;
}

/** An expense's category and type: chosen, suggested until confirmed, or missing. */
export interface ExpenseCategory {
  state: 'confirmed' | 'suggested' | 'missing';
  category: Chosen | null;
  type: Chosen | null;
  /** For a suggestion: what its owner last chose for the merchant, or the merchant's words. */
  basis: 'history' | 'keywords' | null;
}

/** "Travel › Airfare", with a retired one said so. */
export function categoryText(c: ExpenseCategory): string {
  const name = (n: Chosen | null) => (n ? `${n.name}${n.active ? '' : ' (retired)'}` : '–');
  return `${name(c.category)} › ${name(c.type)}`;
}

/** A name indented by its depth, for a select's options. */
export const indented = (n: { name: string; depth: number }) => `${' '.repeat(n.depth)}${n.name}`;
