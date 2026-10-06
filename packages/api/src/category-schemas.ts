import { CATALOG_CODE_MAX, CATALOG_NAME_MAX } from '@expensewise/domain';
import { z } from '@hono/zod-openapi';

/*
 * Categories and types an organization defines, and the category and type on each expense
 * (FR-EXP-11, FR-INT-10, ADR-0036). Behind the `expenses.categories` feature.
 */

const node = {
  id: z.string().uuid(),
  name: z.string().openapi({ example: 'Airfare' }),
  parentId: z
    .string()
    .uuid()
    .nullable()
    .openapi({ description: 'The one it sits under; null at the top. Either list nests.' }),
  depth: z
    .number()
    .int()
    .openapi({ description: 'How deep it sits: 0 at the top. The list comes in tree order.' }),
  active: z.boolean().openapi({
    description: 'False once retired: no longer offered, but kept by every expense that has it.',
  }),
  inUse: z.boolean().openapi({
    description: 'Some expense has it, so it can be retired but never deleted.',
  }),
};

export const ExpenseTypeSchema = z
  .object({
    ...node,
    companyPays: z
      .boolean()
      .optional()
      .openapi({
        description:
          'The organization’s policy that the company pays this type directly, such as Airfare ' +
          'an employer books (FR-EXP-18, Q46): an expense of it is paid by the company unless a ' +
          'person set it by hand. This type only, not those under it. Only while ' +
          '`expenses.company-paid` is on.',
      }),
  })
  .openapi('ExpenseType');

export const CategorySchema = z
  .object({
    ...node,
    name: z.string().openapi({ example: 'Travel' }),
    glCode: z.string().nullable().openapi({ description: 'Its general ledger code.' }),
    taxCode: z.string().nullable().openapi({ description: 'Its tax code.' }),
    typeIds: z
      .array(z.string().uuid())
      .openapi({ description: 'The types it allows: choosing it narrows the types to these.' }),
  })
  .openapi('Category');

export const CatalogSchema = z
  .object({
    categories: z.array(CategorySchema),
    types: z.array(ExpenseTypeSchema),
    canManage: z
      .boolean()
      .openapi({ description: 'Whether the caller may change them: owners and finance admins.' }),
  })
  .openapi('Catalog');

const name = z
  .string()
  .max(200)
  .openapi({
    description: `Up to ${CATALOG_NAME_MAX} characters once trimmed, unique in its list, case aside.`,
  });
const parentId = z.string().uuid().nullable();
const code = z
  .string()
  .max(200)
  .nullable()
  .openapi({ description: `Up to ${CATALOG_CODE_MAX} characters; blank or null for none.` });
const typeIds = z.array(z.string().uuid()).max(500).openapi({
  description: 'Every type it allows; those left out stop being allowed.',
});

export const NewCategorySchema = z
  .object({
    name,
    parentId: parentId.optional(),
    glCode: code.optional(),
    taxCode: code.optional(),
    typeIds: typeIds.optional(),
  })
  .openapi('NewCategory');

export const CategoryChangeSchema = z
  .object({
    name: name.optional(),
    parentId: parentId.optional(),
    glCode: code.optional(),
    taxCode: code.optional(),
    typeIds: typeIds.optional(),
    active: z.boolean().optional().openapi({ description: 'false retires it; true restores it.' }),
  })
  .openapi('CategoryChange');

export const NewExpenseTypeSchema = z
  .object({ name, parentId: parentId.optional() })
  .openapi('NewExpenseType');

export const ExpenseTypeChangeSchema = z
  .object({
    name: name.optional(),
    parentId: parentId.optional(),
    active: z.boolean().optional().openapi({ description: 'false retires it; true restores it.' }),
  })
  .openapi('ExpenseTypeChange');

export const SetCompanyPaysSchema = z
  .object({
    companyPays: z.boolean().openapi({
      description:
        'true: the company pays this type directly. false: the person pays and claims it.',
    }),
  })
  .strict()
  .openapi('SetCompanyPays');

export const CompanyPaysSchema = ExpenseTypeSchema.extend({
  switched: z
    .number()
    .int()
    .openapi({
      description:
        'How many expenses of this type followed the change: those not set by hand and not yet ' +
        'submitted (Q48). Each is named in the audit trail.',
    }),
}).openapi('CompanyPays');

export const ClassifyExpenseSchema = z
  .object({ categoryId: z.string().uuid(), typeId: z.string().uuid() })
  .openapi('ClassifyExpense');

const chosen = z
  .object({ id: z.string().uuid(), name: z.string(), active: z.boolean() })
  .nullable();

/** An expense's category and type, chosen, suggested or missing. Present while the feature is on. */
export const ExpenseCategorySchema = z
  .object({
    state: z.enum(['confirmed', 'suggested', 'missing']).openapi({
      description:
        'confirmed: a person chose them. suggested: worked out from what it shows, until a ' +
        'person confirms it. missing: neither, so the expense says it needs them.',
    }),
    category: chosen,
    type: chosen,
    basis: z
      .enum(['history', 'keywords'])
      .nullable()
      .openapi({
        description:
          'For a suggestion: history, what its owner last chose for the same merchant; keywords, ' +
          'what its merchant or reading names. Rules, never a model (ADR-0036).',
      }),
  })
  .openapi('ExpenseCategory');
