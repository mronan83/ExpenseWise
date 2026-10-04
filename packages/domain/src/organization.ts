import { isCurrencyCode } from './currency.ts';
import { isCountryCode, isTimeZone } from './expense-details.ts';
import { err, ok, type Result } from './result.ts';

/**
 * How many people an organization has, in bands (FR-PLT-11). The bands are Claude's, the
 * usual ones for a business's size.
 */
export const ORGANIZATION_SIZES = [
  'just_me',
  '2_10',
  '11_50',
  '51_200',
  '201_1000',
  'over_1000',
] as const;
export type OrganizationSize = (typeof ORGANIZATION_SIZES)[number];

export const isOrganizationSize = (value: string): value is OrganizationSize =>
  (ORGANIZATION_SIZES as readonly string[]).includes(value);

/**
 * An organization's details and demographics, as its owner keeps them in Settings
 * (FR-PLT-11). Only the name and home currency are always there.
 */
export interface OrganizationDetails {
  readonly name: string;
  /** ISO 4217. Reports opened from now on are in it; nothing already made is converted. */
  readonly homeCurrency: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string | null;
  /** A BCP 47 language tag, such as en-US. */
  readonly locale: string | null;
  /** An IANA time zone, such as America/Chicago: when the organization's day ends. */
  readonly timeZone: string | null;
  /** The postal address, as the owner writes it, lines and all. */
  readonly address: string | null;
  readonly industry: string | null;
  readonly size: OrganizationSize | null;
}

export const ORGANIZATION_FIELDS = [
  'name',
  'homeCurrency',
  'country',
  'locale',
  'timeZone',
  'address',
  'industry',
  'size',
] as const;
export type OrganizationField = (typeof ORGANIZATION_FIELDS)[number];

/** The most text each field keeps. */
const MAX: Record<OrganizationField, number> = {
  name: 200,
  homeCurrency: 3,
  country: 2,
  locale: 35,
  timeZone: 64,
  address: 300,
  industry: 100,
  size: 16,
};

/** A language tag in its canonical form ("en-us" is "en-US"), or null if it isn't one. */
export function canonicalLocale(value: string): string | null {
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value)) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/** A time zone as the runtime names it ("america/chicago" is "America/Chicago"). */
export function canonicalTimeZone(value: string): string | null {
  if (!isTimeZone(value)) return null;
  return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
}

/** The owner's change to the details. A blank string clears a field that may be empty. */
export type OrganizationEdit = { readonly [F in OrganizationField]?: string };

export interface OrganizationChange {
  readonly field: OrganizationField;
  readonly from: string | null;
  readonly to: string | null;
}

export interface OrganizationEditProblem {
  readonly field: OrganizationField;
  readonly message: string;
}

const REQUIRED: ReadonlySet<OrganizationField> = new Set(['name', 'homeCurrency']);

/** Checks one field's new value, and puts it in the form it is kept in. */
function cleanField(field: OrganizationField, raw: string): Result<string | null, string> {
  const value = raw.trim();
  if (value === '') {
    return REQUIRED.has(field) ? err('This can’t be blank.') : ok(null);
  }
  if (value.length > MAX[field]) return err(`At most ${MAX[field]} characters.`);
  switch (field) {
    case 'homeCurrency': {
      const code = value.toUpperCase();
      return isCurrencyCode(code)
        ? ok(code)
        : err('A currency is a three-letter code ExpenseWise supports, such as USD or EUR.');
    }
    case 'country': {
      const code = value.toUpperCase();
      return isCountryCode(code)
        ? ok(code)
        : err('A country is a two-letter code, such as US or DE.');
    }
    case 'locale': {
      const tag = canonicalLocale(value);
      return tag ? ok(tag) : err('A locale is a language tag, such as en-US or de-DE.');
    }
    case 'timeZone': {
      const zone = canonicalTimeZone(value);
      return zone ? ok(zone) : err('A time zone is a name such as America/Chicago.');
    }
    case 'size':
      return isOrganizationSize(value) ? ok(value) : err('Choose one of the sizes listed.');
    default:
      return ok(value);
  }
}

/**
 * Applies the owner's edit to the details (FR-PLT-11), checking each field it sets: a name
 * and a supported home currency that can't be blank, a two-letter country, a language tag, a
 * time zone the runtime knows, a size from the list, and no field longer than it keeps.
 * Returns the details as they would be and what changed.
 */
export function applyOrganizationEdit(
  current: OrganizationDetails,
  edit: OrganizationEdit,
): Result<
  { details: OrganizationDetails; changes: OrganizationChange[] },
  OrganizationEditProblem
> {
  // Only the details: `current` may be a whole organization, whose other fields aren't ours.
  const next = Object.fromEntries(ORGANIZATION_FIELDS.map((f) => [f, current[f]])) as Record<
    OrganizationField,
    string | null
  >;
  for (const field of ORGANIZATION_FIELDS) {
    const raw = edit[field];
    if (raw === undefined) continue;
    const cleaned = cleanField(field, raw);
    if (!cleaned.ok) return err({ field, message: cleaned.error });
    next[field] = cleaned.value;
  }
  const changes = ORGANIZATION_FIELDS.filter((f) => next[f] !== current[f]).map((field) => ({
    field,
    from: current[field],
    to: next[field],
  }));
  return ok({ details: next as unknown as OrganizationDetails, changes });
}
