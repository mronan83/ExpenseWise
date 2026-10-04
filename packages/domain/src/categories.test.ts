import { describe, expect, it } from 'vitest';
import {
  CATALOG_CODE_MAX,
  CATALOG_NAME_MAX,
  catalogCode,
  catalogName,
  checkChoice,
  KEYWORD_RULES,
  nestsInItself,
  STARTER_CATEGORY_KEYS,
  STARTER_TYPE_KEYS,
  suggestCategory,
  treeOrder,
  type Catalog,
  type CatalogCategory,
  type CatalogNode,
  type SuggestionInput,
} from './categories.ts';

const type = (id: string, name: string, over: Partial<CatalogNode> = {}): CatalogNode => ({
  id,
  parentId: null,
  name,
  active: true,
  starterKey: id,
  ...over,
});
const category = (
  id: string,
  name: string,
  typeIds: string[],
  over: Partial<CatalogCategory> = {},
): CatalogCategory => ({ ...type(id, name, over), typeIds, ...over });

/** The ready-made set, with each id its key. */
const starter: Catalog = {
  categories: [
    category('travel', 'Travel', ['airfare', 'lodging', 'ground_transport', 'mileage']),
    category('meals', 'Meals', ['business_meal', 'per_diem_meal']),
    category('office', 'Office', ['office_supplies']),
    category('software', 'Software', ['software']),
    category('other', 'Other', ['other']),
  ],
  types: [
    type('airfare', 'Airfare'),
    type('lodging', 'Lodging'),
    type('ground_transport', 'Ground transport'),
    type('mileage', 'Mileage'),
    type('business_meal', 'Business meal'),
    type('per_diem_meal', 'Per-diem meal'),
    type('office_supplies', 'Office supplies'),
    type('software', 'Software'),
    type('other', 'Other'),
  ],
};

const expense = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({
  merchant: null,
  readMerchant: null,
  documentType: null,
  source: 'camera',
  ...over,
});

describe('names and codes', () => {
  it('keeps a name trimmed, with its spaces made single, and refuses a blank or long one', () => {
    expect(catalogName('  Ground   transport ')).toBe('Ground transport');
    expect(catalogName('   ')).toBeNull();
    expect(catalogName('x'.repeat(CATALOG_NAME_MAX))).toHaveLength(CATALOG_NAME_MAX);
    expect(catalogName('x'.repeat(CATALOG_NAME_MAX + 1))).toBeNull();
  });

  it('keeps a code trimmed, a blank one as none, and refuses a long one', () => {
    expect(catalogCode(' 6100 ')).toBe('6100');
    expect(catalogCode('')).toBeNull();
    expect(catalogCode(null)).toBeNull();
    expect(catalogCode('x'.repeat(CATALOG_CODE_MAX + 1))).toBeUndefined();
  });
});

describe('nesting', () => {
  const nodes = [
    { id: 'travel', parentId: null },
    { id: 'air', parentId: 'travel' },
    { id: 'long-haul', parentId: 'air' },
  ];

  it('refuses a parent that is the node itself or one of its descendants', () => {
    expect(nestsInItself(nodes, 'travel', 'travel')).toBe(true);
    expect(nestsInItself(nodes, 'travel', 'long-haul')).toBe(true);
    expect(nestsInItself(nodes, 'long-haul', 'travel')).toBe(false);
    expect(nestsInItself(nodes, 'air', null)).toBe(false);
  });

  it('stops at a loop it did not make', () => {
    const loop = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(nestsInItself(loop, 'c', 'a')).toBe(false);
  });

  it('reads a list as a tree: each after its parent, siblings by name, with its depth', () => {
    const list = [
      { id: '3', parentId: '1', name: 'Taxi' },
      { id: '1', parentId: null, name: 'Ground transport' },
      { id: '2', parentId: '1', name: 'Rail' },
      { id: '4', parentId: null, name: 'Airfare' },
      { id: '5', parentId: 'gone', name: 'Orphan' },
    ];
    expect(treeOrder(list).map((o) => `${o.depth}:${o.node.name}`)).toEqual([
      '0:Airfare',
      '0:Ground transport',
      '1:Rail',
      '1:Taxi',
      '0:Orphan',
    ]);
  });

  it('still shows every node of a loop', () => {
    const loop = [
      { id: 'a', parentId: 'b', name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
    ];
    expect(treeOrder(loop).map((o) => o.node.id)).toEqual(['a', 'b']);
  });
});

describe('choosing a category and type', () => {
  it('takes a type its category allows', () => {
    expect(checkChoice(starter, 'travel', 'airfare')).toEqual({
      ok: true,
      value: { categoryId: 'travel', typeId: 'airfare' },
    });
  });

  it('refuses a type the category does not allow, and anything missing or retired', () => {
    const retired: Catalog = {
      categories: starter.categories.map((c) => (c.id === 'office' ? { ...c, active: false } : c)),
      types: starter.types.map((t) => (t.id === 'mileage' ? { ...t, active: false } : t)),
    };
    const problem = (c: string, t: string) => {
      const result = checkChoice(retired, c, t);
      return result.ok ? null : result.error;
    };
    expect(problem('meals', 'airfare')).toBe('type_not_allowed');
    expect(problem('nope', 'airfare')).toBe('no_such_category');
    expect(problem('travel', 'nope')).toBe('no_such_type');
    expect(problem('office', 'office_supplies')).toBe('category_retired');
    expect(problem('travel', 'mileage')).toBe('type_retired');
  });
});

describe('suggesting a category and type', () => {
  it('suggests what the person last chose for the same merchant, matched loosely', () => {
    const history = [
      { merchant: 'Blue Bottle Coffee — Oxbow', categoryId: 'meals', typeId: 'per_diem_meal' },
      { merchant: 'Blue Bottle', categoryId: 'meals', typeId: 'business_meal' },
    ];
    expect(suggestCategory(expense({ merchant: 'BlueBottle' }), history, starter)).toEqual({
      categoryId: 'meals',
      typeId: 'business_meal',
      basis: 'history',
    });
    expect(
      suggestCategory(expense({ merchant: 'Blue Bottle Coffee' }), history, starter),
    ).toMatchObject({ typeId: 'per_diem_meal', basis: 'history' });
  });

  it('matches history on the merchant as read when the expense has none', () => {
    const history = [{ merchant: 'Lyft', categoryId: 'other', typeId: 'other' }];
    expect(suggestCategory(expense({ readMerchant: 'Lyft, Inc.' }), history, starter)).toEqual({
      categoryId: 'other',
      typeId: 'other',
      basis: 'history',
    });
  });

  it('passes over a past choice that can no longer be made', () => {
    const history = [
      { merchant: 'Uber', categoryId: 'meals', typeId: 'ground_transport' },
      { merchant: 'Uber', categoryId: 'gone', typeId: 'other' },
    ];
    expect(suggestCategory(expense({ merchant: 'Uber' }), history, starter)).toEqual({
      categoryId: 'travel',
      typeId: 'ground_transport',
      basis: 'keywords',
    });
  });

  it('goes by what the reading says the document is before any word', () => {
    expect(
      suggestCategory(
        expense({ merchant: 'Bistro Air', documentType: 'hotel_folio' }),
        [],
        starter,
      ),
    ).toMatchObject({ typeId: 'lodging', categoryId: 'travel' });
    expect(suggestCategory(expense({ documentType: 'airline_ticket' }), [], starter)).toMatchObject(
      { typeId: 'airfare' },
    );
    expect(suggestCategory(expense({ documentType: 'ride_receipt' }), [], starter)).toMatchObject({
      typeId: 'ground_transport',
    });
    expect(suggestCategory(expense({ documentType: 'rail_ticket' }), [], starter)).toMatchObject({
      typeId: 'ground_transport',
    });
  });

  it.each([
    ['The Ritz-Carlton, Half Moon Bay', 'lodging'],
    ['Delta Hotels by Marriott', 'lodging'],
    ['Delta Air Lines', 'airfare'],
    ['Lufthansa', 'airfare'],
    ['Pappas Bros. Steakhouse', 'business_meal'],
    ['Zuni Café', 'business_meal'],
    ['Uber Eats', 'business_meal'],
    ['Uber Technologies Inc.', 'ground_transport'],
    ['SP+ Parking', 'ground_transport'],
    ['Staples', 'office_supplies'],
    ['GitHub, Inc.', 'software'],
  ])('suggests %s as %s from the words of its name', (merchant, typeId) => {
    expect(suggestCategory(expense({ merchant }), [], starter)).toMatchObject({
      typeId,
      basis: 'keywords',
    });
  });

  it('suggests Mileage for a mileage expense, whatever its words', () => {
    expect(
      suggestCategory(expense({ merchant: 'Acme Hotel', source: 'mileage' }), [], starter),
    ).toEqual({ categoryId: 'travel', typeId: 'mileage', basis: 'keywords' });
  });

  it('suggests nothing when no rule fits', () => {
    expect(suggestCategory(expense({ merchant: 'Juniper & Rye' }), [], starter)).toBeNull();
    expect(suggestCategory(expense(), [], starter)).toBeNull();
  });

  it('suggests a ready-made type under another category that allows it, and never a retired one', () => {
    const moved: Catalog = {
      categories: [
        ...starter.categories.filter((c) => c.id !== 'meals'),
        category('client', 'Client costs', ['business_meal'], { starterKey: null }),
      ],
      types: starter.types,
    };
    expect(suggestCategory(expense({ merchant: 'Bayside Grill' }), [], moved)).toEqual({
      categoryId: 'client',
      typeId: 'business_meal',
      basis: 'keywords',
    });
    const retired: Catalog = {
      categories: starter.categories,
      types: starter.types.map((t) => (t.id === 'lodging' ? { ...t, active: false } : t)),
    };
    expect(suggestCategory(expense({ merchant: 'Hyatt Regency' }), [], retired)).toBeNull();
  });

  it('names only ready-made types and categories in its rules', () => {
    for (const rule of KEYWORD_RULES) {
      expect(STARTER_TYPE_KEYS).toContain(rule.type);
      expect(STARTER_CATEGORY_KEYS).toContain(rule.category);
      expect(Boolean(rule.words) !== Boolean(rule.documentTypes)).toBe(true);
    }
  });
});
