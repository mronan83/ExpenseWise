import { merchantWords, similarMerchants } from './duplicates.ts';
import { err, ok, type Result } from './result.ts';

/*
 * Categories and types an organization defines (FR-EXP-11, Q7, ADR-0036): two lists, each able
 * to nest, and for each category the types it allows. Every expense gets one of each, the type
 * chosen from those its category allows. A suggestion for them is worked out here, by rules,
 * with no model and nothing spent (FR-INT-10).
 */

/** A category or a type. Either list nests, and either can be retired. */
export interface CatalogNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  /** False once retired: no longer offered, but kept by every expense that has it. */
  readonly active: boolean;
  /** The ready-made one it started as, such as `airfare`; null for one a person added. */
  readonly starterKey: string | null;
}

export interface CatalogCategory extends CatalogNode {
  /** The types it allows. */
  readonly typeIds: readonly string[];
}

export interface Catalog {
  readonly categories: readonly CatalogCategory[];
  readonly types: readonly CatalogNode[];
}

/** The longest name a category or type may have. */
export const CATALOG_NAME_MAX = 80;
/** The longest general ledger or tax code a category may carry. */
export const CATALOG_CODE_MAX = 40;

/** A name as kept: trimmed, with runs of spaces made one. Null when blank or too long. */
export function catalogName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length > 0 && name.length <= CATALOG_NAME_MAX ? name : null;
}

/**
 * A general ledger or tax code as kept: trimmed, and null when blank. Undefined when it is too
 * long to be a code.
 */
export function catalogCode(raw: string | null): string | null | undefined {
  const code = raw?.trim() ?? '';
  if (code.length > CATALOG_CODE_MAX) return undefined;
  return code === '' ? null : code;
}

/**
 * Whether giving `id` the parent `parentId` would put it inside itself: the parent is itself,
 * or one of its own descendants.
 */
export function nestsInItself(
  nodes: readonly Pick<CatalogNode, 'id' | 'parentId'>[],
  id: string,
  parentId: string | null,
): boolean {
  const parents = new Map(nodes.map((n) => [n.id, n.parentId]));
  const seen = new Set<string>();
  for (let at = parentId; at !== null && !seen.has(at); at = parents.get(at) ?? null) {
    if (at === id) return true;
    seen.add(at);
  }
  return false;
}

/**
 * The list as a tree reads: each node after its parent, siblings by name, with how deep it is.
 * A node whose parent is missing reads as a top-level one.
 */
export function treeOrder<T extends Pick<CatalogNode, 'id' | 'parentId' | 'name'>>(
  nodes: readonly T[],
): { readonly node: T; readonly depth: number }[] {
  const ids = new Set(nodes.map((n) => n.id));
  const children = (parentId: string | null) =>
    nodes
      .filter((n) => (n.parentId !== null && ids.has(n.parentId) ? n.parentId : null) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
  const out: { node: T; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const node of children(parentId)) {
      out.push({ node, depth });
      visit(node.id, depth + 1);
    }
  };
  visit(null, 0);
  // Only a loop the database refuses could leave a node unreached; it still shows.
  const reached = new Set(out.map((o) => o.node.id));
  for (const node of nodes) if (!reached.has(node.id)) out.push({ node, depth: 0 });
  return out;
}

/** Why a category and type can't go on an expense. */
export type ChoiceProblem =
  'no_such_category' | 'no_such_type' | 'category_retired' | 'type_retired' | 'type_not_allowed';

/**
 * Checks a choice of category and type for an expense (Q7): both exist and are in use, and the
 * category allows the type.
 */
export function checkChoice(
  catalog: Catalog,
  categoryId: string,
  typeId: string,
): Result<{ readonly categoryId: string; readonly typeId: string }, ChoiceProblem> {
  const category = catalog.categories.find((c) => c.id === categoryId);
  if (!category) return err('no_such_category');
  const type = catalog.types.find((t) => t.id === typeId);
  if (!type) return err('no_such_type');
  if (!category.active) return err('category_retired');
  if (!type.active) return err('type_retired');
  if (!category.typeIds.includes(typeId)) return err('type_not_allowed');
  return ok({ categoryId, typeId });
}

/** The ready-made categories every organization starts with, by key. */
export const STARTER_CATEGORY_KEYS = ['travel', 'meals', 'office', 'software', 'other'] as const;
export type StarterCategoryKey = (typeof STARTER_CATEGORY_KEYS)[number];

/** The ready-made types every organization starts with, by key. */
export const STARTER_TYPE_KEYS = [
  'airfare',
  'lodging',
  'ground_transport',
  'mileage',
  'business_meal',
  'per_diem_meal',
  'office_supplies',
  'software',
  'other',
] as const;
export type StarterTypeKey = (typeof STARTER_TYPE_KEYS)[number];

/** A rule that names a ready-made type for what an expense shows. */
export interface KeywordRule {
  readonly type: StarterTypeKey;
  /** The category it is suggested under, while that category allows it. */
  readonly category: StarterCategoryKey;
  /** What the reading said the document is. */
  readonly documentTypes?: readonly string[];
  /** Whole words of the merchant's name, as `merchantWords` gives them. */
  readonly words?: readonly string[];
}

/** A mileage expense is suggested Mileage by how it was made, not by any word. */
const MILEAGE_SOURCE = 'mileage';
const MILEAGE_RULE: KeywordRule = { type: 'mileage', category: 'travel' };

/**
 * The keyword rules, in the order they are tried; the first that matches wins. What the reading
 * said the document is comes before any word, and lodging before airfare, so "Delta Hotels" is
 * a stay. Words are whole words of the merchant's name (ADR-0036).
 */
export const KEYWORD_RULES: readonly KeywordRule[] = [
  { type: 'airfare', category: 'travel', documentTypes: ['airline_ticket'] },
  { type: 'lodging', category: 'travel', documentTypes: ['hotel_folio'] },
  { type: 'ground_transport', category: 'travel', documentTypes: ['ride_receipt', 'rail_ticket'] },
  {
    type: 'lodging',
    category: 'travel',
    words: [
      'hotel',
      'hotels',
      'inn',
      'suites',
      'resort',
      'motel',
      'lodge',
      'hostel',
      'airbnb',
      'marriott',
      'hilton',
      'hyatt',
      'sheraton',
      'westin',
      'ritz',
      'fairmont',
      'radisson',
      'novotel',
      'ibis',
      'doubletree',
    ],
  },
  {
    type: 'airfare',
    category: 'travel',
    words: [
      'airline',
      'airlines',
      'airways',
      'air',
      'flight',
      'flights',
      'delta',
      'jetblue',
      'lufthansa',
      'ryanair',
      'easyjet',
      'klm',
      'qantas',
      'emirates',
    ],
  },
  {
    type: 'business_meal',
    category: 'meals',
    words: [
      'restaurant',
      'cafe',
      'coffee',
      'espresso',
      'roasters',
      'bistro',
      'brasserie',
      'trattoria',
      'grill',
      'kitchen',
      'steakhouse',
      'diner',
      'eatery',
      'eats',
      'tavern',
      'pub',
      'bar',
      'deli',
      'bakery',
      'pizza',
      'pizzeria',
      'sushi',
      'ramen',
      'taqueria',
      'burger',
      'bbq',
      'catering',
      'starbucks',
    ],
  },
  {
    type: 'ground_transport',
    category: 'travel',
    words: [
      'taxi',
      'cab',
      'uber',
      'lyft',
      'limo',
      'limousine',
      'shuttle',
      'bus',
      'train',
      'rail',
      'railway',
      'amtrak',
      'metro',
      'subway',
      'transit',
      'parking',
      'toll',
      'tolls',
      'hertz',
      'avis',
      'sixt',
      'fuel',
      'petrol',
    ],
  },
  {
    type: 'office_supplies',
    category: 'office',
    words: ['staples', 'office', 'officemax', 'stationery', 'printing'],
  },
  {
    type: 'software',
    category: 'software',
    words: [
      'software',
      'saas',
      'github',
      'atlassian',
      'slack',
      'zoom',
      'adobe',
      'dropbox',
      'notion',
      'figma',
      'jetbrains',
      'microsoft',
      'aws',
    ],
  },
];

/** What an expense shows that a suggestion can go on. */
export interface SuggestionInput {
  /** The merchant on the expense, as the person sees it. */
  readonly merchant: string | null;
  /** The merchant as its receipt was read, when it differs. */
  readonly readMerchant: string | null;
  /** What the reading said the document is, such as `hotel_folio`. */
  readonly documentType: string | null;
  /** How the expense was made, such as `camera` or `mileage`. */
  readonly source: string;
}

/** A category and type the person chose for an expense of theirs, newest first. */
export interface ConfirmedChoice {
  readonly merchant: string;
  readonly categoryId: string;
  readonly typeId: string;
}

/** history: what the person last chose for this merchant. keywords: a keyword rule. */
export type SuggestionBasis = 'history' | 'keywords';

export interface Suggestion {
  readonly categoryId: string;
  readonly typeId: string;
  readonly basis: SuggestionBasis;
}

const byName = (a: CatalogNode, b: CatalogNode) => a.name.localeCompare(b.name);

/** The category to suggest a type under: the rule's own if it allows it, else the first that does. */
function categoryFor(catalog: Catalog, typeId: string, preferred: StarterCategoryKey) {
  const allowing = catalog.categories
    .filter((c) => c.active && c.typeIds.includes(typeId))
    .sort(byName);
  return allowing.find((c) => c.starterKey === preferred) ?? allowing[0];
}

function ruleMatches(rule: KeywordRule, words: ReadonlySet<string>, documentType: string | null) {
  if (rule.documentTypes) return documentType !== null && rule.documentTypes.includes(documentType);
  return (rule.words ?? []).some((w) => words.has(w));
}

/**
 * A type, and so a category, to suggest for an expense (FR-INT-10, ADR-0036). First what the
 * person last chose for the same merchant, matched as duplicates match merchants, while that
 * choice can still be made; then the first keyword rule that matches what the expense shows, for
 * a ready-made type still in use. Null when nothing fits. Never calls a model.
 */
export function suggestCategory(
  input: SuggestionInput,
  history: readonly ConfirmedChoice[],
  catalog: Catalog,
): Suggestion | null {
  const names = [input.merchant, input.readMerchant].filter(
    (n): n is string => n !== null && n.trim() !== '',
  );
  for (const choice of history) {
    if (!names.some((n) => similarMerchants(n, choice.merchant))) continue;
    if (checkChoice(catalog, choice.categoryId, choice.typeId).ok) {
      return { categoryId: choice.categoryId, typeId: choice.typeId, basis: 'history' };
    }
  }

  const words = new Set(names.flatMap(merchantWords));
  const rules =
    input.source === MILEAGE_SOURCE
      ? [MILEAGE_RULE]
      : KEYWORD_RULES.filter((rule) => ruleMatches(rule, words, input.documentType));
  for (const rule of rules) {
    const type = catalog.types.find((t) => t.active && t.starterKey === rule.type);
    const category = type && categoryFor(catalog, type.id, rule.category);
    if (type && category) return { categoryId: category.id, typeId: type.id, basis: 'keywords' };
  }
  return null;
}
