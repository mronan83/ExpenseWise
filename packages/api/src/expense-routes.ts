import type { Membership } from '@expensewise/db';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { expenseDetail, expenseSummary } from './expense-views.ts';
import type { ExpenseStore } from './expenses.ts';
import { ProblemError } from './problem.ts';
import { editExpenseRoute, getExpenseRoute, listExpensesRoute } from './routes/expenses.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ExpenseRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly expenses?: ExpenseStore;
}

const LIST_LIMIT = 100;

export function registerExpenseRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ExpenseRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [listExpensesRoute, getExpenseRoute, editExpenseRoute].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);

  const stores = () => {
    if (!options.workspace || !options.expenses) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        {
          code: 'database_not_configured',
        },
      );
    }
    return { workspace: options.workspace, expenses: options.expenses };
  };
  const member = async (userId: string): Promise<Membership> => {
    const membership = await stores().workspace.findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        {
          code: 'no_organization',
          detail: 'Call POST /v1/me/organization after signing in.',
        },
      );
    }
    return membership;
  };
  const notFound = () =>
    new ProblemError(404, 'not-found', 'No such expense', { code: 'not_found' });

  app.openapi(listExpensesRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { expenses, receipts, runs, reviews } = await stores().expenses.list(
      who.orgId,
      LIST_LIMIT,
    );
    const proofOf = (receiptId: string | null) => {
      const receipt = receipts.find((r) => r.id === receiptId);
      return receipt ? { receipt, runs, reviews } : null;
    };
    return c.json({ expenses: expenses.map((e) => expenseSummary(e, proofOf(e.receiptId))) }, 200);
  });

  app.openapi(getExpenseRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { expenseId } = c.req.valid('param');
    const found = await stores().expenses.get(who.orgId, expenseId);
    if (!found) throw notFound();
    return c.json(expenseDetail(found.expense, found.proof), 200);
  });

  app.openapi(editExpenseRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const { expenses } = stores();
    const result = await expenses.edit(who.orgId, expenseId, c.req.valid('json'), caller.userId);
    if (result.status === 'missing') throw notFound();
    if (result.status === 'not_editable') {
      const reading = result.current === 'processing';
      throw new ProblemError(409, 'not-editable', 'This expense can’t be edited now', {
        code: reading ? 'being_read' : 'locked',
        detail: reading
          ? 'Its receipt is being read. Try again in a few seconds.'
          : 'It is submitted or approved. An approved expense is corrected by a reversal.',
      });
    }
    if (result.status === 'invalid') {
      throw new ProblemError(422, 'invalid-value', 'A value is not valid', {
        code: 'invalid_value',
        detail: result.problem.message,
        field: result.problem.field,
      });
    }
    const found = await expenses.get(who.orgId, expenseId);
    if (!found) throw notFound();
    return c.json(expenseDetail(found.expense, found.proof), 200);
  });
}
