import {
  assertRowSecurityApplies,
  fileReceipt,
  findReceiptBySha256,
  getReceipt,
  listExtractionRuns,
  listReceipts,
  requestReceiptReading,
  withOrg,
  type CommittedEvent,
  type Database,
  type ExtractionRunRecord,
  type FileReceiptResult,
  type NewReceipt,
  type ReceiptRecord,
} from '@expensewise/db';

/**
 * What the API needs from the database for receipts. Filing and asking for a reading write
 * the outbox event and the audit event in the same transaction. Tests use an in-memory fake.
 */
export interface ReceiptStore {
  findBySha256(orgId: string, sha256: string): Promise<string | undefined>;
  file(orgId: string, input: NewReceipt, actorUserId: string): Promise<FileReceiptResult>;
  list(
    orgId: string,
    limit: number,
  ): Promise<{ receipts: ReceiptRecord[]; runs: ExtractionRunRecord[] }>;
  get(
    orgId: string,
    receiptId: string,
  ): Promise<{ receipt: ReceiptRecord; runs: ExtractionRunRecord[] } | undefined>;
  requestReading(
    orgId: string,
    receiptId: string,
    actorUserId: string,
  ): Promise<CommittedEvent | undefined>;
}

/** The receipt store on Postgres, as expensewise_app. It checks the role once. */
export function dbReceiptStore(db: Database): ReceiptStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  const inOrg = async <T>(orgId: string, work: Parameters<typeof withOrg<T>>[2]) => {
    await safe();
    return withOrg(db, orgId, work);
  };

  return {
    findBySha256: (orgId, sha256) =>
      inOrg(orgId, async (tx) => (await findReceiptBySha256(tx, sha256))?.id),
    file: (orgId, input, actor) => inOrg(orgId, (tx) => fileReceipt(tx, orgId, input, actor)),
    list: (orgId, limit) =>
      inOrg(orgId, async (tx) => {
        const receipts = await listReceipts(tx, limit);
        const runs = await listExtractionRuns(
          tx,
          receipts.map((r) => r.id),
        );
        return { receipts, runs };
      }),
    get: (orgId, receiptId) =>
      inOrg(orgId, async (tx) => {
        const receipt = await getReceipt(tx, receiptId);
        if (!receipt) return undefined;
        return { receipt, runs: await listExtractionRuns(tx, [receiptId]) };
      }),
    requestReading: (orgId, receiptId, actor) =>
      inOrg(orgId, (tx) => requestReceiptReading(tx, orgId, receiptId, actor)),
  };
}
