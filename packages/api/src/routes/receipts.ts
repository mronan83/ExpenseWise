import { createRoute, z } from '@hono/zod-openapi';
import {
  FileReceiptSchema,
  ProblemSchema,
  ReceiptDetailSchema,
  ReceiptListSchema,
  ReceiptSummarySchema,
  ReceiptUploadRequestSchema,
  ReceiptUploadTicketSchema,
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
