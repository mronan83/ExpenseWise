import { createRoute, z } from '@hono/zod-openapi';
import {
  CatalogSchema,
  CategoryChangeSchema,
  CategorySchema,
  ClassifyExpenseSchema,
  ExpenseTypeChangeSchema,
  ExpenseTypeSchema,
  NewCategorySchema,
  NewExpenseTypeSchema,
} from '../category-schemas.ts';
import { ExpenseDetailSchema, ProblemSchema } from '../schemas.ts';

/*
 * Categories and types (FR-EXP-11, FR-INT-10, ADR-0036). Every route answers 404 feature_off
 * while `expenses.categories` is off for the organization.
 */

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
  required: true,
});

const pathId = (name: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: 'path' } });
const params = {
  categoryId: z.object({ categoryId: pathId('categoryId') }),
  typeId: z.object({ typeId: pathId('typeId') }),
  expenseId: z.object({ expenseId: pathId('expenseId') }),
};
const idParam = <K extends keyof typeof params>(name: K) => params[name];

const manage = {
  ...common,
  400: problem('The request is not valid.'),
  403: problem('Only an owner or finance admin can change categories and types.'),
  404: problem('No such one in this organization, or the feature is off (feature_off).'),
  422: problem(
    'A value is not valid: a blank or taken name, a parent that is missing or inside it, a type ' +
      'that is missing, or a code too long. field names which.',
  ),
};

export const getCatalogRoute = createRoute({
  method: 'get',
  path: '/v1/categories',
  tags: ['Categories'],
  summary: 'The organization’s categories and types',
  description:
    'FR-EXP-11. Both lists in tree order, retired ones included, with the types each category ' +
    'allows. Everyone in the organization reads them, to choose from.',
  ...secured,
  responses: {
    200: {
      description: 'The categories and types.',
      content: { 'application/json': { schema: CatalogSchema } },
    },
    ...common,
    403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
    404: problem('The feature is off (feature_off).'),
  },
});

export const createCategoryRoute = createRoute({
  method: 'post',
  path: '/v1/settings/categories',
  tags: ['Categories'],
  summary: 'Add a category',
  description: 'With its codes, where it sits and the types it allows. Recorded in the audit log.',
  ...secured,
  request: { body: json(NewCategorySchema) },
  responses: {
    201: {
      description: 'The new category.',
      content: { 'application/json': { schema: CategorySchema } },
    },
    ...manage,
  },
});

export const updateCategoryRoute = createRoute({
  method: 'patch',
  path: '/v1/settings/categories/{categoryId}',
  tags: ['Categories'],
  summary: 'Change a category: rename, move, code, allow types, retire or restore',
  description:
    'Changes the fields sent. A retired category is no longer offered, but every expense that ' +
    'has it keeps it. Recorded in the audit log.',
  ...secured,
  request: { params: idParam('categoryId'), body: json(CategoryChangeSchema) },
  responses: {
    200: {
      description: 'The category as it is now.',
      content: { 'application/json': { schema: CategorySchema } },
    },
    ...manage,
  },
});

export const deleteCategoryRoute = createRoute({
  method: 'delete',
  path: '/v1/settings/categories/{categoryId}',
  tags: ['Categories'],
  summary: 'Delete a category no expense has',
  description: 'One in use is retired instead, so old claims keep it. Recorded in the audit log.',
  ...secured,
  request: { params: idParam('categoryId') },
  responses: {
    204: { description: 'Deleted.' },
    ...manage,
    409: problem('An expense has it (in_use), or another sits under it (has_children).'),
  },
});

export const createTypeRoute = createRoute({
  method: 'post',
  path: '/v1/settings/expense-types',
  tags: ['Categories'],
  summary: 'Add a type',
  description:
    'A category offers it once it allows it (PATCH the category). Recorded in the audit log.',
  ...secured,
  request: { body: json(NewExpenseTypeSchema) },
  responses: {
    201: {
      description: 'The new type.',
      content: { 'application/json': { schema: ExpenseTypeSchema } },
    },
    ...manage,
  },
});

export const updateTypeRoute = createRoute({
  method: 'patch',
  path: '/v1/settings/expense-types/{typeId}',
  tags: ['Categories'],
  summary: 'Change a type: rename, move, retire or restore',
  description:
    'Changes the fields sent. A retired type is no longer offered, but every expense that has ' +
    'it keeps it. Recorded in the audit log.',
  ...secured,
  request: { params: idParam('typeId'), body: json(ExpenseTypeChangeSchema) },
  responses: {
    200: {
      description: 'The type as it is now.',
      content: { 'application/json': { schema: ExpenseTypeSchema } },
    },
    ...manage,
  },
});

export const deleteTypeRoute = createRoute({
  method: 'delete',
  path: '/v1/settings/expense-types/{typeId}',
  tags: ['Categories'],
  summary: 'Delete a type no expense has',
  description:
    'Every category that allowed it stops. One in use is retired instead. Recorded in the audit log.',
  ...secured,
  request: { params: idParam('typeId') },
  responses: {
    204: { description: 'Deleted.' },
    ...manage,
    409: problem('An expense has it (in_use), or another sits under it (has_children).'),
  },
});

export const classifyExpenseRoute = createRoute({
  method: 'put',
  path: '/v1/expenses/{expenseId}/category',
  tags: ['Expenses'],
  summary: 'Choose an expense’s category and type, or confirm the ones suggested',
  description:
    'FR-EXP-11, FR-INT-10. The type must be one the category allows, and both in use. Until ' +
    'it is submitted. Recorded in the audit log; a closed report it is on opens again.',
  ...secured,
  request: { params: idParam('expenseId'), body: json(ClassifyExpenseSchema) },
  responses: {
    200: {
      description: 'The expense as it is now.',
      content: { 'application/json': { schema: ExpenseDetailSchema } },
    },
    ...common,
    400: problem('The request is not valid.'),
    403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
    404: problem('No such expense in this organization, or the feature is off (feature_off).'),
    409: problem('It is submitted or later, so it stays as it went in.'),
    422: problem(
      'No such category or type, one is retired, or the category doesn’t allow the type.',
    ),
  },
});
