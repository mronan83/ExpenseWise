import { sql, type SQL } from 'drizzle-orm';
import { categories, expenseParts, expenses, expenseTypes } from './schema.ts';

/*
 * The names a category and a type are shown by on a claim (NFR-DAT-04, #70): once an expense's
 * report is submitted, the names copied onto it then; before that, and for a claim submitted
 * before names were copied, the category's and type's own names now. Returned to its member, an
 * expense can be changed again, so it shows its names as they are until it is submitted again.
 */

const submitted = sql`${expenses.status} in ('submitted', 'approved', 'settled')`;

/** An expense's category name, as its claim shows it. Join categories and expenses. */
export const shownCategoryName: SQL<string | null> = sql<
  string | null
>`case when ${submitted} and ${expenses.categoryName} is not null then ${expenses.categoryName} else ${categories.name} end`;

/** An expense's type name, as its claim shows it. Join expense_types and expenses. */
export const shownTypeName: SQL<string | null> = sql<
  string | null
>`case when ${submitted} and ${expenses.typeName} is not null then ${expenses.typeName} else ${expenseTypes.name} end`;

/** A part's category name, as its claim shows it. Join categories, expense_parts and expenses. */
export const shownPartCategoryName: SQL<string | null> = sql<
  string | null
>`case when ${submitted} and ${expenseParts.categoryName} is not null then ${expenseParts.categoryName} else ${categories.name} end`;

/** A part's type name, as its claim shows it. Join expense_types, expense_parts and expenses. */
export const shownPartTypeName: SQL<string | null> = sql<
  string | null
>`case when ${submitted} and ${expenseParts.typeName} is not null then ${expenseParts.typeName} else ${expenseTypes.name} end`;
