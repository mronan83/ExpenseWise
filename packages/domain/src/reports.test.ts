import { describe, expect, it } from 'vitest';
import {
  cleanJustification,
  joinsReportAt,
  JUSTIFICATION_MAX,
  localExpenseReady,
  planAutoClose,
  reopenedClosesAt,
  reportClosesAt,
  reportWarns,
  tripReady,
} from './reports.ts';

const at = (iso: string) => new Date(iso);

describe('when a trip or local expense joins a report', () => {
  it('waits until 24 hours after its day has ended everywhere: noon UTC two days on', () => {
    expect(joinsReportAt('2026-10-01').toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(joinsReportAt('2026-12-31').toISOString()).toBe('2027-01-02T12:00:00.000Z');
  });

  it('is never early, even where the day ends last (UTC−12)', () => {
    // 1 Oct ends at UTC−12 at 2 Oct 12:00 UTC; 24 hours on is the time it joins.
    const endsLast = at('2026-10-02T12:00:00Z').getTime();
    expect(joinsReportAt('2026-10-01').getTime() - endsLast).toBe(24 * 3_600_000);
  });

  it('refuses a date that is not one', () => {
    expect(() => joinsReportAt('2026-02-30')).toThrow();
  });
});

describe('a report’s 28 days', () => {
  const opened = at('2026-10-03T12:00:00Z');

  it('closes itself 28 days after it opens, and warns in its last week', () => {
    const closes = reportClosesAt(opened);
    expect(closes.toISOString()).toBe('2026-10-31T12:00:00.000Z');
    expect(reportWarns(closes, at('2026-10-24T11:59:59Z'))).toBe(false);
    expect(reportWarns(closes, at('2026-10-24T12:00:00Z'))).toBe(true);
    expect(reportWarns(closes, at('2026-11-02T00:00:00Z'))).toBe(true);
  });

  it('gives a reopened report a week, or keeps its own day 28 if later', () => {
    const closes = reportClosesAt(opened);
    expect(reopenedClosesAt(closes, at('2026-10-10T09:00:00Z'))).toEqual(closes);
    expect(reopenedClosesAt(closes, at('2026-10-30T09:00:00Z')).toISOString()).toBe(
      '2026-11-06T09:00:00.000Z',
    );
  });
});

describe('what holds a report open', () => {
  it('is a trip with an expense being read or needing review', () => {
    expect(tripReady(['ready', 'ready'])).toBe(true);
    expect(tripReady([])).toBe(true);
    expect(tripReady(['ready', 'needs_review'])).toBe(false);
    expect(tripReady(['processing'])).toBe(false);
  });

  it('is a local expense needing review, or with no justification', () => {
    expect(localExpenseReady('ready', 'Client lunch with Acme')).toBe(true);
    expect(localExpenseReady('ready', null)).toBe(false);
    expect(localExpenseReady('ready', '   ')).toBe(false);
    expect(localExpenseReady('needs_review', 'Client lunch')).toBe(false);
  });

  it('keeps a justification trimmed, blank as none, and refuses one too long', () => {
    expect(cleanJustification('  Team offsite  ')).toEqual({ value: 'Team offsite' });
    expect(cleanJustification('   ')).toEqual({ value: null });
    expect(cleanJustification('x'.repeat(JUSTIFICATION_MAX))).toEqual({
      value: 'x'.repeat(JUSTIFICATION_MAX),
    });
    expect(cleanJustification('x'.repeat(JUSTIFICATION_MAX + 1))).toHaveProperty('error');
  });
});

describe('day 28', () => {
  it('closes with what is ready and moves the rest on', () => {
    expect(
      planAutoClose([
        { id: 'omaha', ready: true },
        { id: 'houston', ready: false },
        { id: 'lunch', ready: true },
      ]),
    ).toEqual({ action: 'close', move: ['houston'] });
    expect(planAutoClose([{ id: 'omaha', ready: true }])).toEqual({ action: 'close', move: [] });
  });

  it('waits, overdue, when nothing is ready, and drops a report holding nothing', () => {
    expect(planAutoClose([{ id: 'houston', ready: false }])).toEqual({ action: 'stay_open' });
    expect(planAutoClose([])).toEqual({ action: 'drop' });
  });
});
