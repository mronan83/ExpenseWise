import type { CommittedEvent, Membership } from '@expensewise/db';
import { newId } from '@expensewise/domain';
import { confirmReading } from '@expensewise/extraction';
import { receiptPath, RECEIPT_BUCKET, type ObjectStore } from '@expensewise/storage';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { needsYouItems, NO_REPORTS } from './needs-you-views.ts';
import { ProblemError } from './problem.ts';
import { inboxRoute } from './routes/inbox.ts';
import {
  comparisonSummary,
  latestRuns,
  normalized,
  receiptDetail,
  receiptSummary,
} from './receipt-views.ts';
import type { ReceiptStore } from './receipts.ts';
import type { ReportStore } from './reports.ts';
import {
  confirmReceiptRoute,
  fileReceiptRoute,
  getReceiptRoute,
  listReceiptsRoute,
  readReceiptAgainRoute,
  receiptUploadRoute,
  resolveDuplicateRoute,
} from './routes/receipts.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ReceiptRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly receipts?: ReceiptStore;
  readonly files?: ObjectStore;
  /**
   * Hands committed outbox events to the workflow runner right away, so a receipt is read in
   * seconds. Best effort: the outbox relay delivers anything this misses (ADR-0017).
   */
  readonly dispatch?: (events: readonly CommittedEvent[]) => Promise<void>;
  /** Reports and local expenses that need the person join Needs you when it is given. */
  readonly reports?: ReportStore;
  readonly now?: () => Date;
}

const LIST_LIMIT = 100;
const IMAGE_LINK_SECONDS = 300;

export function registerReceiptRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ReceiptRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      receiptUploadRoute,
      fileReceiptRoute,
      listReceiptsRoute,
      getReceiptRoute,
      readReceiptAgainRoute,
      confirmReceiptRoute,
      resolveDuplicateRoute,
      inboxRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);

  const unavailable = (what: string, code: string) =>
    new ProblemError(503, code.replaceAll('_', '-'), `${what} is not configured on this server`, {
      code,
    });
  const stores = () => {
    if (!options.workspace || !options.receipts) {
      throw unavailable('The database', 'database_not_configured');
    }
    return { workspace: options.workspace, receipts: options.receipts };
  };
  const files = () => {
    if (!options.files) throw unavailable('File storage', 'storage_not_configured');
    return options.files;
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
  const duplicate = (receiptId: string) =>
    new ProblemError(409, 'duplicate-receipt', 'This file is already filed', {
      code: 'duplicate_receipt',
      receiptId,
    });
  const notFound = () =>
    new ProblemError(404, 'not-found', 'No such receipt', { code: 'not_found' });
  const notWaiting = (stale: boolean) =>
    new ProblemError(409, 'not-waiting', 'This receipt is not waiting for a look', {
      code: stale ? 'read_again' : 'not_waiting',
      detail: stale
        ? 'It was read again after these readings were shown. Refresh and look again.'
        : 'It is being read, or it is already Ready.',
    });
  const heldAsDuplicate = () =>
    new ProblemError(409, 'possible-duplicate', 'This receipt may be a duplicate', {
      code: 'possible_duplicate',
      detail: 'Keep both, delete one or merge them first.',
    });
  const unprocessable = (code: string, title: string, extra: Record<string, unknown> = {}) =>
    new ProblemError(422, code.replaceAll('_', '-'), title, { code, ...extra });

  const imageOf = async (storageKey: string) => {
    try {
      return (await options.files?.signedDownloadUrl(storageKey, IMAGE_LINK_SECONDS)) ?? null;
    } catch {
      // A missing or unreachable file still shows the readings.
      return null;
    }
  };

  /** Removes a deleted receipt's file. Best effort: the receipt is already gone (ADR-0028). */
  const removeFile = async (storageKey: string) => {
    try {
      if (!options.files) throw new Error('file storage is not configured');
      await options.files.remove(storageKey);
    } catch (error) {
      console.warn('Removing a deleted receipt’s file failed', { storageKey, error });
    }
  };

  const dispatch = async (event: CommittedEvent) => {
    if (!options.dispatch) return;
    try {
      await options.dispatch([event]);
    } catch (error) {
      // The event is committed in the outbox; the relay's sweep sends it later.
      console.warn('Handing a receipt event to the workflow runner failed', error);
    }
  };

  app.openapi(receiptUploadRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const store = files();
    const { sha256 } = c.req.valid('json');
    const existing = await stores().receipts.findBySha256(who.orgId, sha256);
    if (existing) throw duplicate(existing);
    const receiptId = newId();
    const upload = await store.signedUpload(receiptPath(who.orgId, receiptId));
    return c.json({ receiptId, bucket: RECEIPT_BUCKET, ...upload }, 201);
  });

  app.openapi(fileReceiptRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const body = c.req.valid('json');
    const result = await stores().receipts.file(
      who.orgId,
      {
        id: body.id,
        memberId: who.memberId,
        source: body.source,
        // Derived here, never taken from the client: a receipt can only name its own path.
        storageKey: receiptPath(who.orgId, body.id),
        contentType: body.contentType,
        byteSize: body.byteSize,
        sha256: body.sha256,
      },
      caller.userId,
    );
    if (result.status === 'duplicate') throw duplicate(result.receiptId);
    if (result.status === 'exists') return c.json(receiptSummary(result.receipt, []), 200);
    await dispatch(result.event);
    return c.json(receiptSummary(result.receipt, []), 202);
  });

  app.openapi(listReceiptsRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { receipts, runs, reviews } = await stores().receipts.list(who.orgId, LIST_LIMIT);
    return c.json(
      {
        receipts: receipts.map((r) => receiptSummary(r, runs, reviews)),
        comparison: comparisonSummary(receipts, runs),
        readingAvailable: options.dispatch !== undefined,
      },
      200,
    );
  });

  app.openapi(inboxRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    // What needs this person: their own receipts, reports and local expenses (FR-EXP-02).
    const receipts = await stores().receipts.list(who.orgId, LIST_LIMIT, {
      statuses: ['needs_review', 'failed'],
      memberId: who.memberId,
    });
    const reports = options.reports
      ? await options.reports.needsYou(who.orgId, who.memberId, LIST_LIMIT)
      : NO_REPORTS;
    const items = needsYouItems(receipts, reports, options.now?.() ?? new Date());
    return c.json({ items }, 200);
  });

  app.openapi(getReceiptRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { receiptId } = c.req.valid('param');
    const found = await stores().receipts.get(who.orgId, receiptId);
    if (!found) throw notFound();
    const imageUrl = await imageOf(found.receipt.storageKey);
    return c.json(
      receiptDetail(found.receipt, found.runs, imageUrl, found.reviews, found.pairs),
      200,
    );
  });

  app.openapi(readReceiptAgainRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { receiptId } = c.req.valid('param');
    const { receipts } = stores();
    const event = await receipts.requestReading(who.orgId, receiptId, caller.userId);
    if (!event) throw notFound();
    await dispatch(event);
    const found = await receipts.get(who.orgId, receiptId);
    if (!found) throw notFound();
    return c.json(receiptSummary(found.receipt, found.runs, found.reviews), 202);
  });

  app.openapi(confirmReceiptRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { receiptId } = c.req.valid('param');
    const body = c.req.valid('json');
    const { receipts } = stores();
    const found = await receipts.get(who.orgId, receiptId);
    if (!found) throw notFound();
    if (found.receipt.status !== 'needs_review' && found.receipt.status !== 'failed') {
      throw notWaiting(false);
    }
    if (found.pairs.some((p) => p.heldReceiptId === receiptId)) throw heldAsDuplicate();
    const run = latestRuns(receiptId, found.runs).find((r) => r.model === body.model);
    if (!run) {
      throw unprocessable('no_such_reading', 'This receipt has no such reading', {
        detail: `Choose one of the readings shown: ${body.model} is not among them.`,
      });
    }
    const result = confirmReading(normalized(run), body.corrections ?? {});
    if (!result.ok) {
      const { error } = result;
      throw error.kind === 'missing'
        ? unprocessable('missing_fields', 'Some filing fields are still missing', {
            detail: 'Enter them with Edit a field.',
            fields: error.fields,
          })
        : unprocessable('invalid_value', 'A value is not valid', {
            detail: error.message,
            field: error.field,
          });
    }
    const { confirmed, corrections } = result.value;
    const outcome = await receipts.confirm(
      who.orgId,
      receiptId,
      {
        memberId: who.memberId,
        requestId: run.requestId,
        model: run.model,
        merchant: confirmed.merchant,
        transactionDate: confirmed.date,
        currency: confirmed.currency,
        totalMinor: confirmed.total.amountMinor,
        taxMinor: confirmed.taxTotal?.amountMinor ?? null,
        tipMinor: confirmed.tip?.amountMinor ?? null,
        corrections,
      },
      caller.userId,
    );
    if (outcome === 'missing') throw notFound();
    if (outcome === 'duplicate') throw heldAsDuplicate();
    if (outcome !== 'confirmed') throw notWaiting(outcome === 'stale');
    const after = await receipts.get(who.orgId, receiptId);
    if (!after) throw notFound();
    const imageUrl = await imageOf(after.receipt.storageKey);
    return c.json(
      receiptDetail(after.receipt, after.runs, imageUrl, after.reviews, after.pairs),
      200,
    );
  });

  app.openapi(resolveDuplicateRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { receiptId, otherReceiptId } = c.req.valid('param');
    const decision = c.req.valid('json');
    const kept =
      decision.action === 'delete'
        ? decision.keep
        : decision.action === 'merge'
          ? decision.primary
          : receiptId;
    if (kept !== receiptId && kept !== otherReceiptId) {
      throw unprocessable('not_in_pair', 'The receipt to keep is not one of the two', {
        detail: `Keep ${receiptId} or ${otherReceiptId}.`,
      });
    }
    const result = await stores().receipts.resolveDuplicate(
      who.orgId,
      receiptId,
      otherReceiptId,
      decision,
      caller.userId,
    );
    if (result.status === 'not_a_pair') {
      throw new ProblemError(404, 'not-a-pair', 'These receipts are not flagged as duplicates', {
        code: 'not_a_pair',
        detail: 'Either it was already decided, or they never looked alike.',
      });
    }
    if (result.status === 'locked') {
      throw new ProblemError(409, 'locked', 'Its expense is submitted or further along', {
        code: 'locked',
        detail: 'A submitted or approved expense is never deleted or merged into.',
      });
    }
    if (result.status === 'kept_both') {
      return c.json({ outcome: 'kept_both' as const, kept, deleted: null, taken: [] }, 200);
    }
    // After the commit: a failure here leaves a file nothing points to, never a receipt
    // without its file.
    await removeFile(result.storageKey);
    const deleted = kept === receiptId ? otherReceiptId : receiptId;
    return c.json(
      {
        outcome: result.status,
        kept: result.kept,
        deleted,
        taken: result.status === 'merged' ? result.taken : [],
      },
      200,
    );
  });
}
