import type { CommittedEvent, Membership } from '@expensewise/db';
import { newId } from '@expensewise/domain';
import { receiptPath, RECEIPT_BUCKET, type ObjectStore } from '@expensewise/storage';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { ProblemError } from './problem.ts';
import { comparisonSummary, receiptDetail, receiptSummary } from './receipt-views.ts';
import type { ReceiptStore } from './receipts.ts';
import {
  fileReceiptRoute,
  getReceiptRoute,
  listReceiptsRoute,
  readReceiptAgainRoute,
  receiptUploadRoute,
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
    const { receipts, runs } = await stores().receipts.list(who.orgId, LIST_LIMIT);
    return c.json(
      {
        receipts: receipts.map((r) => receiptSummary(r, runs)),
        comparison: comparisonSummary(receipts, runs),
        readingAvailable: options.dispatch !== undefined,
      },
      200,
    );
  });

  app.openapi(getReceiptRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { receiptId } = c.req.valid('param');
    const found = await stores().receipts.get(who.orgId, receiptId);
    if (!found) throw notFound();
    let imageUrl: string | null = null;
    try {
      imageUrl =
        (await options.files?.signedDownloadUrl(found.receipt.storageKey, IMAGE_LINK_SECONDS)) ??
        null;
    } catch {
      // A missing or unreachable file still shows the readings.
    }
    return c.json(receiptDetail(found.receipt, found.runs, imageUrl), 200);
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
    return c.json(receiptSummary(found.receipt, found.runs), 202);
  });
}
