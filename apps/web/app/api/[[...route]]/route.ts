import { createHttpApp, supabaseTokenVerifier } from '@expensewise/api';
import { handle } from 'hono/vercel';

// The whole versioned API lives in @expensewise/api; Next.js only hands it requests under /api.
// One source for the project URL: it is public, so a server-only copy (such as a Sensitive
// SUPABASE_URL, which nobody can read back) could silently point verification elsewhere.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

const handler = handle(
  createHttpApp({
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
    // Without a Supabase project, protected routes answer 503 rather than failing the build.
    verifyToken: supabaseUrl ? supabaseTokenVerifier({ projectUrl: supabaseUrl }) : undefined,
  }),
);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
