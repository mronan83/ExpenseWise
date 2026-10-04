import { describe, expect, it } from 'vitest';
import { CAPTURE_TO_READY_SLO_MS, captureMs, captureTime, percentile } from './capture-time.ts';

describe('the time from capture to read', () => {
  it('takes the 95th percentile by nearest rank, always one of the times measured', () => {
    // 1 to 100 seconds: the 95th of 100 is the 95th smallest.
    const hundred = Array.from({ length: 100 }, (_, i) => (100 - i) * 1000);
    expect(percentile(hundred, 95)).toBe(95_000);
    // Of 20, the 19th; of 3, the largest: ceil(0.95 × 3) is 3.
    expect(percentile([...Array.from({ length: 20 }, (_, i) => i + 1)], 95)).toBe(19);
    expect(percentile([4_200, 1_800, 12_345], 95)).toBe(12_345);
    expect(percentile([7_001], 95)).toBe(7_001);
    // Never interpolated: between 10 and 20 there is nothing to invent.
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile([10, 20], 100)).toBe(20);
    expect(percentile([], 95)).toBeNull();
  });

  it('refuses a percentile or a time that is not whole', () => {
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 95.5)).toThrow(RangeError);
    expect(() => percentile([1.5], 95)).toThrow(RangeError);
    expect(() => percentile([-1], 95)).toThrow(RangeError);
  });

  it('measures whole milliseconds from filing to settlement, never below zero', () => {
    const filed = new Date('2026-10-04T12:00:00.000Z');
    expect(captureMs(filed, new Date('2026-10-04T12:00:12.345Z'))).toBe(12_345);
    expect(captureMs(filed, new Date('2026-10-04T11:59:59.000Z'))).toBe(0);
  });

  it('says how many receipts the 95th percentile is over, and whether it is under 30 seconds', () => {
    expect(CAPTURE_TO_READY_SLO_MS).toBe(30_000);
    expect(captureTime([8_000, 12_000, 29_999])).toEqual({
      receipts: 3,
      p95Ms: 29_999,
      sloMs: 30_000,
      withinSlo: true,
    });
    expect(captureTime([8_000, 30_000])).toMatchObject({ p95Ms: 30_000, withinSlo: false });
    expect(captureTime([])).toEqual({ receipts: 0, p95Ms: null, sloMs: 30_000, withinSlo: null });
  });
});
