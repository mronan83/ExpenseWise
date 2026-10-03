import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  amountMatches,
  applyTripInput,
  isTripMovable,
  TRIP_MAX_DAYS,
  tripCovers,
  tripFor,
  tripPhase,
  type TripValues,
  type TripWindow,
} from './trips.ts';

const trip = (id: string, startDate: string, endDate: string, created = 0): TripWindow => ({
  id,
  startDate,
  endDate,
  createdAt: new Date(Date.UTC(2026, 8, 1) + created * 1000),
});

describe('tripFor', () => {
  const houston = trip('houston', '2026-09-22', '2026-09-25');

  it('files a date to the trip that covers it, start and end days included', () => {
    expect(tripFor('2026-09-22', [houston])).toBe(houston);
    expect(tripFor('2026-09-23', [houston])).toBe(houston);
    expect(tripFor('2026-09-25', [houston])).toBe(houston);
  });

  it('files nothing outside every trip, or with no date yet', () => {
    expect(tripFor('2026-09-21', [houston])).toBeNull();
    expect(tripFor('2026-09-26', [houston])).toBeNull();
    expect(tripFor(null, [houston])).toBeNull();
    expect(tripFor('2026-09-23', [])).toBeNull();
  });

  it('gives a day two trips share to the trip that ends first, where the hotel bill belongs', () => {
    const denver = trip('denver', '2026-09-25', '2026-09-28');
    expect(tripFor('2026-09-25', [denver, houston])).toBe(houston);
    expect(tripFor('2026-09-25', [houston, denver])).toBe(houston);
    expect(tripFor('2026-09-26', [houston, denver])).toBe(denver);
  });

  it('keeps a short trip’s days inside a longer one', () => {
    const london = trip('london', '2026-09-01', '2026-09-14');
    const paris = trip('paris', '2026-09-05', '2026-09-06');
    expect(tripFor('2026-09-05', [london, paris])).toBe(paris);
    expect(tripFor('2026-09-07', [london, paris])).toBe(london);
    // Ending the same day, the one that starts later is the narrower one.
    const lastDay = trip('last-day', '2026-09-14', '2026-09-14');
    expect(tripFor('2026-09-14', [lastDay, london])).toBe(lastDay);
  });

  it('breaks a tie between trips with the same dates by the newer one, then by id', () => {
    const older = trip('a', '2026-09-22', '2026-09-25', 0);
    const newer = trip('b', '2026-09-22', '2026-09-25', 5);
    expect(tripFor('2026-09-23', [newer, older])).toBe(newer);
    expect(tripFor('2026-09-23', [older, newer])).toBe(newer);
    const twin = trip('c', '2026-09-22', '2026-09-25', 5);
    expect(tripFor('2026-09-23', [twin, newer])).toBe(twin);
  });

  it('does not depend on the order the trips are listed in', () => {
    const day = fc.integer({ min: 1, max: 28 }).map((d) => `2026-09-${String(d).padStart(2, '0')}`);
    const window = fc
      .tuple(day, day, fc.integer({ min: 0, max: 3 }))
      .map(([a, b, created]): [string, string, number] =>
        a <= b ? [a, b, created] : [b, a, created],
      );
    fc.assert(
      fc.property(fc.array(window, { maxLength: 6 }), day, (windows, date) => {
        const trips = windows.map(([s, e, c], i) => trip(`t${i}`, s, e, c));
        const picked = tripFor(date, trips);
        expect(tripFor(date, [...trips].reverse())).toBe(picked);
        if (picked) expect(tripCovers(picked, date)).toBe(true);
        else expect(trips.some((t) => tripCovers(t, date))).toBe(false);
      }),
    );
  });
});

describe('tripPhase', () => {
  const window = { startDate: '2026-09-22', endDate: '2026-09-25' };
  it.each([
    ['2026-09-21', 'upcoming'],
    ['2026-09-22', 'under_way'],
    ['2026-09-25', 'under_way'],
    ['2026-09-26', 'past'],
  ] as const)('on %s it is %s', (today, phase) => {
    expect(tripPhase(window, today)).toBe(phase);
  });
});

describe('isTripMovable', () => {
  it.each([
    ['processing', true],
    ['needs_review', true],
    ['ready', true],
    ['submitted', false],
    ['approved', false],
    ['settled', false],
  ] as const)('%s → %s', (status, movable) => {
    expect(isTripMovable(status)).toBe(movable);
  });
});

describe('applyTripInput', () => {
  const houston: TripValues = {
    name: 'Houston · Acme onsite',
    purpose: 'Client onsite',
    primaryCity: 'Houston',
    startDate: '2026-09-22',
    endDate: '2026-09-25',
  };

  it('makes a trip from a name and two dates, trimming what was typed', () => {
    const made = applyTripInput(null, {
      name: '  Houston · Acme onsite ',
      startDate: '2026-09-22',
      endDate: '2026-09-25',
      purpose: '',
    });
    expect(made).toEqual({
      ok: true,
      value: {
        values: {
          name: 'Houston · Acme onsite',
          purpose: null,
          primaryCity: null,
          startDate: '2026-09-22',
          endDate: '2026-09-25',
        },
        changes: [
          { field: 'name', from: null, to: 'Houston · Acme onsite' },
          { field: 'startDate', from: null, to: '2026-09-22' },
          { field: 'endDate', from: null, to: '2026-09-25' },
        ],
      },
    });
  });

  it('needs a name and both dates for a new trip', () => {
    expect(applyTripInput(null, { startDate: '2026-09-22', endDate: '2026-09-25' })).toEqual({
      ok: false,
      error: { field: 'name', message: 'Give the trip a name.' },
    });
    expect(applyTripInput(null, { name: 'X', endDate: '2026-09-25' })).toMatchObject({
      ok: false,
      error: { field: 'startDate' },
    });
    expect(applyTripInput(null, { name: 'X', startDate: '2026-09-25' })).toMatchObject({
      ok: false,
      error: { field: 'endDate' },
    });
  });

  it('changes only the fields sent, and clears a purpose or city sent empty', () => {
    const edited = applyTripInput(houston, { endDate: '2026-09-26', primaryCity: ' ' });
    expect(edited.ok && edited.value.values).toEqual({
      ...houston,
      endDate: '2026-09-26',
      primaryCity: null,
    });
    expect(edited.ok && edited.value.changes).toEqual([
      { field: 'primaryCity', from: 'Houston', to: null },
      { field: 'endDate', from: '2026-09-25', to: '2026-09-26' },
    ]);
    const cleared = applyTripInput(houston, { purpose: null });
    expect(cleared.ok && cleared.value.values.purpose).toBeNull();
  });

  it('reports no changes when the values are already those', () => {
    const same = applyTripInput(houston, { name: 'Houston · Acme onsite', endDate: '2026-09-25' });
    expect(same.ok && same.value.changes).toEqual([]);
  });

  it('allows a one-day trip and one a year long, and nothing longer', () => {
    expect(applyTripInput(houston, { endDate: '2026-09-22' }).ok).toBe(true);
    expect(
      applyTripInput(null, { name: 'Year', startDate: '2026-01-01', endDate: '2026-12-31' }).ok,
    ).toBe(true);
    expect(
      applyTripInput(null, { name: 'Leap', startDate: '2024-01-01', endDate: '2024-12-31' }).ok,
    ).toBe(true);
    expect(
      applyTripInput(null, { name: 'Typo', startDate: '2026-09-22', endDate: '2027-09-25' }),
    ).toEqual({
      ok: false,
      error: { field: 'endDate', message: `A trip can be at most ${TRIP_MAX_DAYS} days long.` },
    });
  });

  it.each([
    [{ name: '' }, 'name'],
    [{ name: null }, 'name'],
    [{ name: 'x'.repeat(121) }, 'name'],
    [{ purpose: 'x'.repeat(501) }, 'purpose'],
    [{ primaryCity: 'x'.repeat(121) }, 'primaryCity'],
    [{ startDate: '2026-02-30' }, 'startDate'],
    [{ startDate: '' }, 'startDate'],
    [{ endDate: null }, 'endDate'],
    [{ endDate: '2026-09-21' }, 'endDate'],
  ] as const)('refuses %o as a value for %s', (input, field) => {
    expect(applyTripInput(houston, input)).toMatchObject({ ok: false, error: { field } });
  });
});

describe('amountMatches', () => {
  const of = (text: string) =>
    Object.fromEntries((amountMatches(text) ?? []).map((m) => [m.amountMinor, m.currencies]));

  it('reads an amount with cents in every currency that has cents or more', () => {
    const matches = of('18.92');
    expect(
      Object.keys(matches)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1892, 18920]);
    expect(matches[1892]).toContain('USD');
    expect(matches[18920]).toEqual(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
    expect(Object.values(matches).flat()).not.toContain('JPY');
  });

  it('reads a whole amount in every currency, at its own scale', () => {
    const matches = of('1200');
    expect(matches[1200]).toEqual(['CLP', 'ISK', 'JPY', 'KRW', 'VND']);
    expect(matches[120000]).toContain('EUR');
    expect(matches[1200000]).toContain('KWD');
  });

  it('reads three decimals only in currencies that have them', () => {
    expect(Object.keys(of('1.234'))).toEqual(['1234']);
  });

  it.each(['', '  ', '-5', '1,000', '$12', '12.', '.5', '1.2345', 'abc', '1e3'])(
    'is null for %j',
    (text) => {
      expect(amountMatches(text)).toBeNull();
    },
  );
});
