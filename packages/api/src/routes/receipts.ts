import { createRoute, z } from '@hono/zod-openapi';
import {
  ConfirmReceiptSchema,
  CorrectReceiptSchema,
  DuplicateResolutionSchema,
  FileReceiptSchema,
  ProblemSchema,
  ReceiptDetailSchema,
  ReceiptListSchema,
  ReceiptSummarySchema,
  ReceiptUploadRequestSchema,
  ReceiptUploadTicketSchema,
  ResolveDuplicateSchema,
} from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
  503: problem('Sign-in, the database or file storage is not configured on this server.'),
};

const receiptParam = z.object({
  receiptId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'receiptId', in: 'path' } }),
});

export const receiptUploadRoute = createRoute({
  method: 'post',
  path: '/v1/receipts/uploads',
  tags: ['Receipts'],
  summary: 'Get a one-time upload for a receipt file',
  description:
    'Step 1 of capture (architecture 6.4). Returns a path and token the client uploads the ' +
    'file to directly, so image bytes never pass through the API. A file already filed in ' +
    'this organization is refused before it is uploaded again.',
  ...secured,
  request: {
    body: {
      content: { 'application/json': { schema: ReceiptUploadRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Upload the file to this path with this token, then file it.',
      content: { 'application/json': { schema: ReceiptUploadTicketSchema } },
    },
    ...common,
    409: problem('The same file is already filed; receiptId names it.'),
  },
});

export const fileReceiptRoute = createRoute({
  method: 'post',
  path: '/v1/receipts',
  tags: ['Receipts'],
  summary: 'File an uploaded receipt',
  description:
    'Step 3 of capture. Records the receipt and the event that has it read, in one ' +
    'transaction, then hands the event to the workflow runner. Safe to retry with the same id.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: FileReceiptSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'This receipt was already filed (a retried request).',
      content: { 'application/json': { schema: ReceiptSummarySchema } },
    },
    202: {
      description: 'Filed; it is being read.',
      content: { 'application/json': { schema: ReceiptSummarySchema } },
    },
    ...common,
    409: problem('The same file is already filed as another receipt; receiptId names it.'),
  },
});

export const listReceiptsRoute = createRoute({
  method: 'get',
  path: '/v1/receipts',
  tags: ['Receipts'],
  summary: 'Recent receipts, and how the compared models did on them',
  ...secured,
  responses: {
    200: {
      description: 'The 100 most recent receipts, newest first.',
      content: { 'application/json': { schema: ReceiptListSchema } },
    },
    ...common,
  },
});

export const getReceiptRoute = createRoute({
  method: 'get',
  path: '/v1/receipts/{receiptId}',
  tags: ['Receipts'],
  summary: 'One receipt, with each model’s reading side by side',
  ...secured,
  request: { params: receiptParam },
  responses: {
    200: {
      description: 'The receipt.',
      content: { 'application/json': { schema: ReceiptDetailSchema } },
    },
    ...common,
    404: problem('No such receipt in this organization.'),
  },
});

export const readReceiptAgainRoute = createRoute({
  method: 'post',
  path: '/v1/receipts/{receiptId}/read',
  tags: ['Receipts'],
  summary: 'Read a receipt again',
  description: 'For example after adding an AI provider key. Each model reads it afresh.',
  ...secured,
  request: { params: receiptParam },
  responses: {
    202: {
      description: 'It is being read again.',
      content: { 'application/json': { schema: ReceiptSummarySchema } },
    },
    ...common,
    404: problem('No such receipt in this organization.'),
  },
});

export const confirmReceiptRoute = createRoute({
  method: 'post',
  path: '/v1/receipts/{receiptId}/confirm',
  tags: ['Receipts'],
  summary: 'Confirm a reading that needs a look, as read or corrected',
  description:
    '"Looks right" and "Edit a field" (FR-INT-15, ADR-0021). Makes the receipt Ready with ' +
    'the chosen reading and any corrected fields, records who confirmed what in the audit ' +
    'trail, and keeps each correction beside what the model read.',
  ...secured,
  request: {
    params: receiptParam,
    body: { content: { 'application/json': { schema: ConfirmReceiptSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'It is Ready.',
      content: { 'application/json': { schema: ReceiptDetailSchema } },
    },
    ...common,
    404: problem('No such receipt in this organization.'),
    409: problem(
      'It is not waiting for a look: being read, already Ready, read again since its ' +
        'readings were shown, or held as a possible duplicate until that is decided.',
    ),
    422: problem(
      'No such reading, a value that is not valid, or a filing field still missing; field ' +
        'or fields name which.',
    ),
  },
});

export const correctReceiptRoute = createRoute({
  method: 'post',
  path: '/v1/receipts/{receiptId}/corrections',
  tags: ['Receipts'],
  summary: 'Correct a field of a Ready receipt',
  description:
    'One tap corrects a field of a receipt that is already Ready (GAP-14, FR-INT-11), with ' +
    '"Where each field was read" switched on (receipts.field-sources). Its expense changes as ' +
    'an edit would change it, before submission and recorded in the audit trail (ADR-0022); ' +
    'each correction is kept beside what the model read, as Edit a field keeps it (ADR-0021). ' +
    'A submitted or approved expense is locked: correcting an approved one is a reversal ' +
    '(FR-EXP-03), which is not built yet. A receipt that needs a look is confirmed instead.',
  ...secured,
  request: {
    params: receiptParam,
    body: { content: { 'application/json': { schema: CorrectReceiptSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Corrected.',
      content: { 'application/json': { schema: ReceiptDetailSchema } },
    },
    ...common,
    404: problem('No such receipt in this organization, or the feature is off (feature_off).'),
    409: problem(
      'It is not Ready (not_ready), it was read again since (read_again), or its expense is ' +
        'submitted or further along (locked).',
    ),
    422: problem('A value is not valid, or it is filed so already (unchanged); field names which.'),
  },
});

export const resolveDuplicateRoute = createRoute({
  method: 'post',
  path: '/v1/receipts/{receiptId}/duplicates/{otherReceiptId}',
  tags: ['Receipts'],
  summary: 'Decide about two receipts flagged as possible duplicates',
  description:
    'Keep both, delete one, or merge one into the primary the person chose (FR-INT-18, ' +
    'ADR-0028). A deleted receipt goes with its file, readings, confirmations and expense; ' +
    'the audit trail records what it was. Either receipt of the pair may be in the path.',
  ...secured,
  request: {
    params: receiptParam.extend({
      otherReceiptId: z
        .string()
        .uuid()
        .openapi({ param: { name: 'otherReceiptId', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: ResolveDuplicateSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Decided.',
      content: { 'application/json': { schema: DuplicateResolutionSchema } },
    },
    ...common,
    404: problem(
      'These receipts are not flagged as possible duplicates of each other, or it was decided.',
    ),
    409: problem('The expense to delete, or to merge into, is submitted or further along.'),
    422: problem('The receipt to keep is not one of the two.'),
  },
});
