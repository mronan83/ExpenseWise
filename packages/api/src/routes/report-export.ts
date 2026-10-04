import { createRoute, z } from '@hono/zod-openapi';
import { ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
  404: problem(
    'No such report in this organization, or another member’s that the caller can’t export; ' +
      'or report export is switched off (feature_off).',
  ),
  409: problem('The report is still open (not_closed): close it first.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const reportParam = z.object({
  reportId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'reportId', in: 'path' } }),
});

const headers = z.object({
  'Content-Disposition': z.string().openapi({
    description: 'An attachment, named for the person and the day the report opened.',
    example: 'attachment; filename="expense-report-riley-2026-10-03.csv"',
  }),
});

const access =
  'Only a report that has closed, or gone further; until approval (#24) exists, a closed ' +
  'report. The member whose report it is exports it, as do the organization’s owner, finance ' +
  'admins and auditors. Behind the reports.export feature.';

export const exportReportCsvRoute = createRoute({
  method: 'get',
  path: '/v1/reports/{reportId}/export.csv',
  tags: ['Reports'],
  summary: 'A report as CSV',
  description:
    'A row per expense on it: date, merchant, category, type, trip, purpose, note, and the ' +
    'amount and currency as spent; then a row per currency’s total, never converted. UTF-8 ' +
    'with a byte order mark, lines ending CRLF (FR-SET-01). ' +
    access,
  ...secured,
  request: { params: reportParam },
  responses: {
    200: {
      description: 'The CSV.',
      headers,
      content: { 'text/csv': { schema: z.string() } },
    },
    ...common,
  },
});

export const exportReportPdfRoute = createRoute({
  method: 'get',
  path: '/v1/reports/{reportId}/export.pdf',
  tags: ['Reports'],
  summary: 'A report as a PDF summary',
  description:
    'Who it is for, the organization, its dates and status, the same table as the CSV, and ' +
    'each currency’s total; no receipt images (FR-SET-01). ' +
    access,
  ...secured,
  request: { params: reportParam },
  responses: {
    200: {
      description: 'The PDF.',
      headers,
      content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } },
    },
    ...common,
  },
});
