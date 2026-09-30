import { createHttpApp } from '@expensewise/api';
import { handle } from 'hono/vercel';

// The whole versioned API lives in @expensewise/api; Next.js only hands it requests under /api.
const handler = handle(
  createHttpApp({ version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev' }),
);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
