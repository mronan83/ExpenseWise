import type { Story } from '../model.ts';
import { ACCESS_STORIES } from './access.ts';
import { CAPTURE_STORIES } from './capture.ts';
import { DOMAIN_STORIES } from './domain.ts';
import { DUPLICATE_STORIES } from './duplicates.ts';
import { EXPENSE_STORIES } from './expenses.ts';
import { OPERATIONS_STORIES } from './operations.ts';
import { READING_STORIES } from './reading.ts';
import { REPORT_STORIES } from './reports.ts';
import { SECURITY_STORIES } from './security.ts';

/**
 * Every user story, by area (NFR-DEL-09). Each file holds one area's stories; the
 * integrity checks hold them to the requirements, features, tests and rules they cite.
 */
export const STORIES: readonly Story[] = [
  ...ACCESS_STORIES,
  ...CAPTURE_STORIES,
  ...READING_STORIES,
  ...DUPLICATE_STORIES,
  ...EXPENSE_STORIES,
  ...REPORT_STORIES,
  ...DOMAIN_STORIES,
  ...SECURITY_STORIES,
  ...OPERATIONS_STORIES,
];
