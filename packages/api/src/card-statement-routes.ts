import { createHash } from 'node:crypto';
import type { CardChangeResult, CommittedEvent, Membership } from '@expensewise/db';
import { isCurrencyCode, mayChangeRecord, newId, SET_ASIDE_NOTE_MAX } from '@expensewise/domain';
import { readStatementList, STATEMENT_ROWS_MAX } from '@expensewise/extraction';
import { RECEIPT_BUCKET, statementPath, type ObjectStore } from '@expensewise/storage';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { notYours } from './caller.ts';
import { CARD_STATEMENTS_FLAG, type CardStore } from './card-statements.ts';
import { cardStatementsView } from './card-statement-views.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { OrganizationStore } from './organization.ts';
import { ProblemError } from './problem.ts';
import { amountView } from './receipt-views.ts';
import {
  bringBackRoute,
  confirmStatementRoute,
  deleteStatementRoute,
  fileStatementRoute,
  listStatementsRoute,
  matchableRoute,
  matchAgainRoute,
  matchToExpenseRoute,
  setAsideRoute,
  statementFileRoute,
  statementListRoute,
  statementUploadRoute,
  unmatchRoute,
} from './routes/card-statements.ts';
import type { WorkspaceStore } from './workspace.ts';

/** How long a link to a statement's PDF lasts, as a receipt's image link does. */
const STATEMENT_LINK_SECONDS = 300;

export interface CardStatementRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  /** Card statements and their transactions. Without it, these routes answer 503. */
  readonly cards?: CardStore;
  /** Where statement PDFs are kept, beside receipts. Without it, uploading one answers 503. */
  readonly files?: ObjectStore;
  /** The organization's home currency, the currency of a list that names none. */
  readonly organization?: OrganizationStore;
  /** Hands the event that has a statement read to the workflow runner (ADR-0017). */
  readonly dispatch?: (events: readonly CommittedEvent[]) => Promise<void>;
  readonly features?: FeatureGate;
}

const LIST_TEXT: Record<string, string> = {
  empty: 'The file is empty.',
  no_columns:
    'It has no columns for a date, a merchant and an amount. Download the transactions as CSV.',
  no_rows: 'No row reads as a transaction with a date and an amount.',
  too_many_rows: `A list holds at most ${STATEMENT_ROWS_MAX} transactions. Download a shorter period.`,
};

const SET_ASIDE_TEXT: Record<string, string> = {
  unknown_reason: 'Pick a reason: personal, no receipt, not an expense, or other.',
  note_needed: 'Other needs a note saying why.',
  note_too_long: `A note is at most ${SET_ASIDE_NOTE_MAX} characters.`,
};

export function registerCardStatementRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: CardStatementRouteOptions,
) {
  const features = options.features ?? featureGate({ workspace: options.workspace });
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      statementUploadRoute,
      fileStatementRoute,
      statementListRoute,
      listStatementsRoute,
      confirmStatementRoute,
      deleteStatementRoute,
      statementFileRoute,
      matchAgainRoute,
      setAsideRoute,
      bringBackRoute,
      matchToExpenseRoute,
      unmatchRoute,
      matchableRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);

  const unavailable = (what: string, code: string) =>
    new ProblemError(503, code.replaceAll('_', '-'), `${what} is not configured on this server`, {
      code,
    });
  const stores = () => {
    if (!options.workspace || !options.cards) {
      throw unavailable('The database', 'database_not_configured');
    }
    return { workspace: options.workspace, cards: options.cards };
  };
  const files = () => {
    if (!options.files) throw unavailable('File storage', 'storage_not_configured');
    return options.files;
  };
  /** The caller's membership, once card statements are on for their organization. */
  const member = async (userId: string): Promise<Membership> => {
    const membership = await stores().workspace.findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        { code: 'no_organization', detail: 'Call POST /v1/me/organization after signing in.' },
      );
    }
    await features.require(membership.orgId, CARD_STATEMENTS_FLAG);
    return membership;
  };
  /** One who may bring a statement in: anyone but an auditor, who changes nothing (ADR-0035). */
  const bringer = async (userId: string) => {
    const who = await member(userId);
    if (!mayChangeRecord(who.role, true)) throw notYours();
    return who;
  };
  const view = async (who: Membership) =>
    cardStatementsView(await stores().cards.list(who.orgId, who.memberId));
  const notFound = (what: string) =>
    new ProblemError(404, 'not-found', `No such ${what}`, { code: 'not_found' });
  const conflict = (code: string, title: string, detail: string) =>
    new ProblemError(409, code.replaceAll('_', '-'), title, { code, detail });

  /** The person's statements after a change, or the problem it ran into. */
  const answer = async (who: Membership, result: CardChangeResult, what = 'transaction') => {
    switch (result.status) {
      case 'missing':
        throw notFound(what);
      case 'matched':
        throw conflict('matched', 'It pays for an expense', 'Let it go of its expense first.');
      case 'set_aside':
        throw conflict('set_aside', 'It is set aside', 'Bring it back first.');
      case 'not_matchable':
        throw conflict(
          'not_matchable',
          'That expense can’t be matched to it',
          'Choose one of your own expenses with its receipt.',
        );
      case 'not_waiting':
        throw conflict('not_waiting', 'It isn’t waiting for a look', 'Refresh and look again.');
      case 'invalid':
        throw new ProblemError(422, 'invalid-value', 'A value is not valid', {
          code: result.problem,
          detail: SET_ASIDE_TEXT[result.problem],
          field: result.problem.startsWith('note') ? 'note' : 'reason',
        });
      case 'changed':
      case 'unchanged':
        return view(who);
    }
  };

  /** Removes a file nothing points at. Best effort (ADR-0028). */
  const removeFile = async (storageKey: string) => {
    try {
      await files().remove(storageKey);
    } catch (error) {
      console.warn('Removing a statement’s file failed', { storageKey, error });
    }
  };
  const dispatch = async (event: CommittedEvent) => {
    if (!options.dispatch) return;
    try {
      await options.dispatch([event]);
    } catch (error) {
      // The event is committed in the outbox; the relay's sweep sends it later.
      console.warn('Handing a statement event to the workflow runner failed', error);
    }
  };

  app.openapi(statementUploadRoute, async (c) => {
    const who = await bringer(c.var.identity.userId);
    const statementId = newId();
    const upload = await files().signedUpload(statementPath(who.orgId, statementId));
    return c.json({ statementId, bucket: RECEIPT_BUCKET, ...upload }, 201);
  });

  app.openapi(fileStatementRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await bringer(userId);
    const body = c.req.valid('json');
    // Derived here, never taken from the client: a statement can only name its own path.
    const storageKey = statementPath(who.orgId, body.id);
    const result = await stores().cards.file(
      who.orgId,
      {
        id: body.id,
        memberId: who.memberId,
        source: 'upload',
        storageKey,
        contentType: 'application/pdf',
        byteSize: body.byteSize,
        sha256: body.sha256,
      },
      userId,
    );
    if (result.status === 'exists') {
      // The same PDF brought in before: the copy just uploaded has nothing to read.
      if (result.statementId !== body.id) await removeFile(storageKey);
      return c.json(await view(who), 200);
    }
    await dispatch(result.event);
    return c.json(await view(who), 202);
  });

  app.openapi(statementListRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await bringer(userId);
    const { text, currency } = c.req.valid('json');
    const home = (await options.organization?.get(who.orgId))?.homeCurrency;
    const code = currency ?? (home && isCurrencyCode(home) ? home : 'USD');
    if (!isCurrencyCode(code)) {
      throw new ProblemError(422, 'invalid-value', 'A value is not valid', {
        code: 'unknown_currency',
        detail: 'That isn’t a currency this app knows.',
        field: 'currency',
      });
    }
    const read = readStatementList(text, code);
    if (!read.ok) {
      throw new ProblemError(422, 'not-a-list', 'It isn’t a transaction list', {
        code: read.problem,
        detail: LIST_TEXT[read.problem],
      });
    }
    const bytes = new TextEncoder().encode(text);
    const result = await stores().cards.recordList(
      who.orgId,
      {
        id: newId(),
        memberId: who.memberId,
        byteSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        currency: code,
        transactions: read.transactions,
      },
      userId,
    );
    return result.status === 'exists'
      ? c.json(
          { statementId: result.statementId, added: 0, matched: 0, skipped: read.skipped },
          200,
        )
      : c.json(
          {
            statementId: result.statementId,
            added: result.added,
            matched: result.matched,
            skipped: read.skipped,
          },
          201,
        );
  });

  app.openapi(listStatementsRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(await view(who), 200);
  });

  app.openapi(confirmStatementRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId);
    const { statementId } = c.req.valid('param');
    const result = await stores().cards.confirm(who.orgId, statementId, userId);
    return c.json(await answer(who, result, 'statement'), 200);
  });

  app.openapi(deleteStatementRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId);
    const { statementId } = c.req.valid('param');
    const removed = await stores().cards.remove(who.orgId, statementId, userId);
    if (!removed) throw notFound('statement');
    if (removed.storageKey) await removeFile(removed.storageKey);
    return c.json(await view(who), 200);
  });

  app.openapi(statementFileRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { statementId } = c.req.valid('param');
    const kept = await stores().cards.list(who.orgId, who.memberId);
    const statement = kept.statements.find((s) => s.id === statementId);
    if (!statement) throw notFound('statement');
    if (!statement.storageKey) {
      throw new ProblemError(404, 'no-file', 'It keeps no file', {
        code: 'no_file',
        detail: 'A downloaded list is read as it comes in, and no file is kept.',
      });
    }
    const url = await files().signedDownloadUrl(statement.storageKey, STATEMENT_LINK_SECONDS);
    return c.json({ url, expiresInSeconds: STATEMENT_LINK_SECONDS }, 200);
  });

  app.openapi(matchAgainRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await bringer(userId);
    const matched = await stores().cards.matchAgain(who.orgId, who.memberId, userId);
    return c.json({ matched }, 200);
  });

  app.openapi(setAsideRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId);
    const { transactionId } = c.req.valid('param');
    const result = await stores().cards.setAside(
      who.orgId,
      transactionId,
      c.req.valid('json'),
      userId,
    );
    return c.json(await answer(who, result), 200);
  });

  app.openapi(bringBackRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId);
    const { transactionId } = c.req.valid('param');
    const result = await stores().cards.bringBack(who.orgId, transactionId, userId);
    return c.json(await answer(who, result), 200);
  });

  app.openapi(matchToExpenseRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId);
    const { transactionId } = c.req.valid('param');
    const { expenseId } = c.req.valid('json');
    const result = await stores().cards.matchTo(who.orgId, transactionId, expenseId, userId);
    return c.json(await answer(who, result), 200);
  });

  app.openapi(unmatchRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId);
    const { transactionId } = c.req.valid('param');
    const result = await stores().cards.unmatch(who.orgId, transactionId, userId);
    return c.json(await answer(who, result), 200);
  });

  app.openapi(matchableRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { transactionId } = c.req.valid('param');
    const kept = await stores().cards.list(who.orgId, who.memberId);
    const t = kept.transactions.find((x) => x.id === transactionId);
    if (!t) throw notFound('transaction');
    const found = await stores().cards.matchable(who.orgId, who.memberId, t.transactionDate);
    return c.json(
      {
        expenses: found.map((e) => ({
          id: e.id,
          merchant: e.merchant,
          date: e.transactionDate,
          amount: amountView(e.amountMinor, e.currency),
          charged:
            e.chargedMinor !== 0 && e.currency ? amountView(e.chargedMinor, e.currency) : null,
        })),
      },
      200,
    );
  });
}
