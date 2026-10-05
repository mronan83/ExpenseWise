/**
 * An email from a member's own address that filed nothing, because its sender couldn't be
 * proved or it had nothing in it to read, shows in Needs you until they dismiss it or it is
 * this many days old (#59, FR-CAP-02).
 */
export const UNFILED_EMAIL_DAYS = 30;

const DAY_MS = 86_400_000;

/** The earliest arrival an email that filed nothing can have and still show at `now`. */
export function unfiledEmailsSince(now: Date): Date {
  return new Date(now.getTime() - UNFILED_EMAIL_DAYS * DAY_MS);
}
