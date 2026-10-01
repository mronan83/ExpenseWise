import type { GroundTruth } from '../truth.ts';

/**
 * CORD v2 (Clova AI, CC BY 4.0): Indonesian receipts with labelled totals.
 * https://huggingface.co/datasets/naver-clova-ix/cord-v2
 */
export const CORD_ROWS_URL =
  'https://datasets-server.huggingface.co/rows?dataset=naver-clova-ix/cord-v2&config=default&split=test';

/**
 * CORD prints rupiah with "." or "," as thousands separators ("60.000", "1,591,600").
 * A final separator followed by exactly two digits is read as a decimal point instead.
 */
export function parseCordAmount(raw: unknown): string | null {
  const text: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned) || cleaned.startsWith('-')) return null;
  const decimal = /[.,](\d{2})$/.exec(cleaned);
  if (decimal) {
    const whole = cleaned.slice(0, -3).replace(/[.,]/g, '') || '0';
    return `${BigInt(whole).toString()}.${decimal[1]}`;
  }
  return BigInt(cleaned.replace(/[.,]/g, '')).toString();
}

type CordParse = {
  total?: Record<string, unknown>;
  sub_total?: Record<string, unknown>;
};

/** Known answers from a CORD row's `gt_parse`, or null when it has no usable total. */
export function cordTruth(
  groundTruthJson: string,
): Pick<GroundTruth, 'documentType' | 'currency' | 'total' | 'subtotal' | 'taxTotal'> | null {
  const parsed = JSON.parse(groundTruthJson) as { gt_parse?: CordParse };
  const gt = parsed.gt_parse ?? {};
  const total = parseCordAmount(gt.total?.total_price);
  if (!total || total === '0') return null;
  const subtotal = parseCordAmount(gt.sub_total?.subtotal_price);
  const tax = parseCordAmount(gt.sub_total?.tax_price);
  return {
    documentType: 'receipt',
    currency: 'IDR',
    total,
    ...(subtotal && subtotal !== '0' ? { subtotal } : {}),
    ...(tax && tax !== '0' ? { taxTotal: tax } : {}),
  };
}

interface RowsResponse {
  rows: { row_idx: number; row: { image: { src: string }; ground_truth: string } }[];
}

/** Fetches up to `count` labelled test receipts, skipping rows without a usable total. */
export async function* fetchCord(count: number) {
  let taken = 0;
  for (let offset = 0; taken < count && offset < 100; offset += 25) {
    const res = await fetch(`${CORD_ROWS_URL}&offset=${offset}&length=25`);
    if (!res.ok) throw new Error(`CORD rows request failed: HTTP ${res.status}`);
    const page = (await res.json()) as RowsResponse;
    for (const { row_idx, row } of page.rows) {
      if (taken >= count) return;
      const truth = cordTruth(row.ground_truth);
      if (!truth) continue;
      const image = await fetch(row.image.src);
      if (!image.ok) throw new Error(`CORD image ${row_idx} failed: HTTP ${image.status}`);
      taken++;
      yield { index: row_idx, truth, bytes: new Uint8Array(await image.arrayBuffer()) };
    }
  }
}
