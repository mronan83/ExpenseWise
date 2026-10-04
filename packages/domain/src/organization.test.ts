import { describe, expect, it } from 'vitest';
import {
  applyOrganizationEdit,
  canonicalLocale,
  canonicalTimeZone,
  isOrganizationSize,
  type OrganizationDetails,
} from './organization.ts';

const today: OrganizationDetails = {
  name: "alex's organization",
  homeCurrency: 'USD',
  country: null,
  locale: null,
  timeZone: null,
  address: null,
  industry: null,
  size: null,
};

describe('an organization’s details (FR-PLT-11)', () => {
  it('sets each detail and demographic, tidied, and says what changed', () => {
    const result = applyOrganizationEdit(today, {
      name: '  Acme Field Services ',
      homeCurrency: 'eur',
      country: 'de',
      locale: 'de-de',
      timeZone: 'europe/berlin',
      address: 'Friedrichstraße 43\n10117 Berlin',
      industry: 'Professional services',
      size: '11_50',
    });
    expect(result.ok && result.value.details).toEqual({
      name: 'Acme Field Services',
      homeCurrency: 'EUR',
      country: 'DE',
      locale: 'de-DE',
      timeZone: 'Europe/Berlin',
      address: 'Friedrichstraße 43\n10117 Berlin',
      industry: 'Professional services',
      size: '11_50',
    });
    expect(result.ok && result.value.changes.map((c) => c.field)).toEqual([
      'name',
      'homeCurrency',
      'country',
      'locale',
      'timeZone',
      'address',
      'industry',
      'size',
    ]);
    expect(result.ok && result.value.changes[1]).toEqual({
      field: 'homeCurrency',
      from: 'USD',
      to: 'EUR',
    });
  });

  it('clears a detail left blank, but never the name or home currency', () => {
    const set = { ...today, country: 'US', industry: 'Consulting' };
    const cleared = applyOrganizationEdit(set, { country: ' ', industry: '' });
    expect(cleared.ok && cleared.value.details).toMatchObject({ country: null, industry: null });
    expect(applyOrganizationEdit(set, { name: ' ' })).toEqual({
      ok: false,
      error: { field: 'name', message: 'This can’t be blank.' },
    });
    expect(applyOrganizationEdit(set, { homeCurrency: '' })).toMatchObject({
      ok: false,
      error: { field: 'homeCurrency' },
    });
  });

  it('changes nothing when the edit says what is already there', () => {
    const result = applyOrganizationEdit(today, { name: "alex's organization", country: '' });
    expect(result.ok && result.value.changes).toEqual([]);
  });

  it('refuses a value that isn’t one, naming the field', () => {
    const refused = (edit: Parameters<typeof applyOrganizationEdit>[1]) => {
      const result = applyOrganizationEdit(today, edit);
      return result.ok ? null : result.error.field;
    };
    expect(refused({ homeCurrency: 'XYZ' })).toBe('homeCurrency');
    expect(refused({ country: 'USA' })).toBe('country');
    expect(refused({ country: '1A' })).toBe('country');
    expect(refused({ locale: 'not a locale' })).toBe('locale');
    expect(refused({ timeZone: 'Mars/Olympus_Mons' })).toBe('timeZone');
    expect(refused({ size: 'huge' })).toBe('size');
    expect(refused({ industry: 'x'.repeat(101) })).toBe('industry');
    expect(refused({ address: 'x'.repeat(301) })).toBe('address');
  });

  it('knows locales, time zones and sizes by their canonical names', () => {
    expect(canonicalLocale('en-us')).toBe('en-US');
    expect(canonicalLocale('en_US')).toBeNull();
    expect(canonicalLocale('xx-')).toBeNull();
    expect(canonicalTimeZone('America/Chicago')).toBe('America/Chicago');
    expect(canonicalTimeZone('Nowhere/Special')).toBeNull();
    expect(isOrganizationSize('just_me')).toBe(true);
    expect(isOrganizationSize('2-10')).toBe(false);
  });
});
