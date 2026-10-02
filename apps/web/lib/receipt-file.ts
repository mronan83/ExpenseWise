/** ADR-0014: about 2,000 px on the long edge keeps receipts legible at roughly 300–500 KB. */
const LONG_EDGE = 2000;
const JPEG_QUALITY = 0.85;
const MAX_BYTES = 10 * 1024 * 1024;
const READABLE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

export type ReceiptContentType =
  'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf';

export class ReceiptFileError extends Error {
  override name = 'ReceiptFileError';
}

/**
 * Gets a picked file ready to upload. Photos are scaled down and re-encoded as JPEG, which
 * also drops their location metadata; PDFs go as they are.
 */
export async function prepareReceiptFile(
  file: File,
): Promise<{ blob: Blob; contentType: ReceiptContentType }> {
  if (file.type === 'application/pdf') return checked(file, 'application/pdf');
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('Encoding failed');
    return checked(blob, 'image/jpeg');
  } catch {
    // The browser can't decode it (HEIC outside Safari, for example). Send it unchanged if
    // the reader understands it.
    if (READABLE.includes(file.type)) return checked(file, file.type as ReceiptContentType);
    throw new ReceiptFileError(
      "This file type can't be read. Take a photo, or choose a JPEG, PNG or PDF.",
    );
  }
}

function checked(blob: Blob, contentType: ReceiptContentType) {
  if (blob.size === 0) throw new ReceiptFileError('That file is empty.');
  if (blob.size > MAX_BYTES) throw new ReceiptFileError('That file is over 10 MB.');
  return { blob, contentType };
}

/** Lowercase hex SHA-256, which the server uses to spot a file filed twice. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
