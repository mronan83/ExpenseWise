/** A one-time upload the browser makes straight to storage (ADR-0013). */
export interface SignedUpload {
  readonly path: string;
  /** Proves the upload is allowed. Good for this one path, for about two hours. */
  readonly token: string;
}

/**
 * Private object storage for receipt images. Paths follow `orgs/{orgId}/receipts/{id}`; the
 * API decides who may ask for which path, since the storage credential sees every object.
 */
export interface ObjectStore {
  signedUpload(path: string): Promise<SignedUpload>;
  /** A short-lived URL the browser can show the object from. */
  signedDownloadUrl(path: string, expiresInSeconds: number): Promise<string>;
  /** The object's bytes, or null when nothing was uploaded there. */
  download(path: string): Promise<Uint8Array | null>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Where a receipt's original file lives. */
export const receiptPath = (orgId: string, receiptId: string) =>
  `orgs/${orgId}/receipts/${receiptId}`;

/** The private bucket receipt files live in. */
export const RECEIPT_BUCKET = 'receipts';

/** ADR-0014: files are capped at 10 MB; capture resizes photos to about 400 KB first. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
