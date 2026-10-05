import { describe, expect, it } from 'vitest';
import { UNFILED_EMAIL_DAYS, unfiledEmailsSince } from './unfiled-emails.ts';

describe('an email that filed nothing', () => {
  it('shows for 30 days from when it arrived', () => {
    expect(UNFILED_EMAIL_DAYS).toBe(30);
    expect(unfiledEmailsSince(new Date('2026-10-05T12:00:00.000Z')).toISOString()).toBe(
      '2026-09-05T12:00:00.000Z',
    );
  });
});
