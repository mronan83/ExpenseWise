import type { ReceiptExtraction } from '@expensewise/extraction';
import { describe, expect, it } from 'vitest';
import { percent, percentile, summarize, type ResultRow } from './report.ts';
import { sameMerchant, scoreDocument } from './score.ts';
import type { GroundTruth } from './truth.ts';

const truth: GroundTruth = {
  id: 'r1',
  source: 'synthetic-receipt',
  file: 'synthetic-receipt/0.jpg',
  mediaType: 'image/jpeg',
  documentType: 'receipt',
  currency: 'USD',
  merchant: 'Juniper & Rye',
  date: '2026-07-14',
  subtotal: '45.50',
  taxTotal: '3.75',
  tip: '9.10',
  total: '58.35',
  cardLastFour: '4417',
};

const good: ReceiptExtraction = {
  documentType: 'receipt',
  merchant: { name: 'JUNIPER AND RYE', confidence: 'high' },
  date: { value: '2026-07-14', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '58.35', confidence: 'high' },
  subtotal: { value: '45.50', confidence: 'high' },
  taxes: [{ label: 'Sales tax', value: '3.75', confidence: 'high' }],
  tip: { value: '9.10', confidence: 'medium' },
  cardLastFour: { value: '4417', confidence: 'high' },
  lineItems: [],
};

describe('sameMerchant', () => {
  it.each([
    ['Juniper & Rye', 'JUNIPER AND RYE'],
    ['The Larkspur', 'Larkspur'],
    ['Copper Kettle Diner', 'Copper Kettle Diner #12'],
    ['Northstar Air', 'NorthStar Air Inc.'],
  ])('matches %s and %s', (a, b) => expect(sameMerchant(a, b)).toBe(true));

  it.each([
    ['Bayside Grill', 'Oak Street Tacos'],
    ['Meridian Air', ''],
  ])('does not match %s and %s', (a, b) => expect(sameMerchant(a, b)).toBe(false));
});

describe('scoreDocument', () => {
  it('scores every printed field and files a fully confident read as Ready', () => {
    const s = scoreDocument(truth, { outcome: 'extracted', extraction: good });
    expect(s.fields.map((f) => f.field)).toEqual([
      'documentType',
      'merchant',
      'date',
      'currency',
      'total',
      'subtotal',
      'taxTotal',
      'tip',
      'cardLastFour',
    ]);
    expect(s.allCorrect).toBe(true);
    expect(s.autoReady).toBe(true);
    expect(s.silentError).toBe(false);
  });

  it('flags a confidently wrong total as a silent error when nothing checks it', () => {
    // Without a subtotal there is nothing for the total to add up against (FR-INT-04).
    const s = scoreDocument(truth, {
      outcome: 'extracted',
      extraction: { ...good, subtotal: null, total: { value: '49.25', confidence: 'high' } },
    });
    expect(s.fields.find((f) => f.field === 'total')).toEqual({
      field: 'total',
      correct: false,
      confidence: 'high',
    });
    expect(s.silentError).toBe(true);
  });

  it('sends a total its parts do not make to review, so it is no silent error', () => {
    const s = scoreDocument(truth, {
      outcome: 'extracted',
      extraction: { ...good, total: { value: '49.25', confidence: 'high' } },
    });
    expect(s.autoReady).toBe(false);
    expect(s.silentError).toBe(false);
  });

  it('judges the date as if the receipt was captured on the day it is dated', () => {
    const old = { ...truth, date: '2019-03-02' };
    const read = { ...good, date: { value: '2019-03-02', confidence: 'high' as const } };
    expect(scoreDocument(old, { outcome: 'extracted', extraction: read }).autoReady).toBe(true);
    // A year misread is caught by the date check, not filed.
    const misread = { ...good, date: { value: '2016-03-02', confidence: 'high' as const } };
    expect(scoreDocument(old, { outcome: 'extracted', extraction: misread }).silentError).toBe(
      false,
    );
  });

  it('sends a doubtful read to review rather than counting a silent error', () => {
    const s = scoreDocument(truth, {
      outcome: 'extracted',
      extraction: { ...good, total: { value: '49.25', confidence: 'low' } },
    });
    expect(s.autoReady).toBe(false);
    expect(s.silentError).toBe(false);
  });

  it('skips fields the document does not print', () => {
    const cord: GroundTruth = {
      id: 'c1',
      source: 'cord',
      file: 'cord/1.jpg',
      mediaType: 'image/jpeg',
      documentType: 'receipt',
      currency: 'IDR',
      total: '60000',
    };
    const s = scoreDocument(cord, {
      outcome: 'extracted',
      extraction: {
        ...good,
        currency: { code: 'IDR', confidence: 'high' },
        total: { value: '60000', confidence: 'high' },
      },
    });
    expect(s.fields.map((f) => f.field)).toEqual(['documentType', 'currency', 'total']);
    expect(s.allCorrect).toBe(true);
  });

  it('counts a refusal as every scored field wrong', () => {
    const s = scoreDocument(truth, { outcome: 'refused', extraction: null });
    expect(s.fields.every((f) => !f.correct && f.confidence === null)).toBe(true);
    expect(s.autoReady).toBe(false);
  });
});

describe('report arithmetic', () => {
  it('formats percentages and percentiles without floats', () => {
    expect(percent(1, 3)).toBe('33.3');
    expect(percent(2, 3)).toBe('66.7');
    expect(percent(0, 0)).toBe('–');
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  it('summarizes accuracy, review routing and cost per model', () => {
    const row = (score: ReturnType<typeof scoreDocument>, cost: bigint): ResultRow => ({
      itemId: 'x',
      source: 'synthetic-receipt',
      model: 'claude-haiku-4-5',
      outcome: 'extracted',
      latencyMs: 1200,
      costNanoUsd: cost,
      score,
    });
    const right = scoreDocument(truth, { outcome: 'extracted', extraction: good });
    // A wrong merchant: confident, and nothing a check can catch.
    const wrong = scoreDocument(truth, {
      outcome: 'extracted',
      extraction: { ...good, merchant: { name: 'Copper Kettle Diner', confidence: 'high' } },
    });
    const s = summarize(
      [row(right, 4_000_000n), row(wrong, 6_000_000n)],
      'claude-haiku-4-5',
      'all',
    );
    expect(s).toMatchObject({
      documents: 2,
      allCorrect: 1,
      autoReady: 2,
      silentErrors: 1,
      confidentlyWrong: 1,
      wrongFields: 1,
      costNanoUsd: 10_000_000n,
    });
    expect(s.fieldAccuracy.merchant).toEqual({ correct: 1, scored: 2 });
  });
});
