import { DomainError } from '@expensewise/domain';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Hono, type Context, type ErrorHandler, type NotFoundHandler } from 'hono';
import { problem } from './problem.ts';
import { healthRoute } from './routes/health.ts';

export interface ApiOptions {
  /** Deployed commit SHA, or "dev". */
  readonly version: string;
}

export const OPENAPI_INFO = {
  openapi: '3.1.0',
  info: {
    title: 'ExpenseWise API',
    version: '1.0.0',
    description:
      'The API behind the ExpenseWise web and iOS apps. Money is always integer minor units ' +
      'plus an ISO 4217 code. Errors are RFC 9457 problem documents.',
  },
  servers: [{ url: '/api' }],
};

const notFound: NotFoundHandler = (c: Context) =>
  problem(c, 404, 'not-found', 'Not found', {
    detail: `No route for ${c.req.method} ${c.req.path}`,
    code: 'not_found',
  });

const onError: ErrorHandler = (error, c) => {
  if (error instanceof DomainError) {
    return problem(c, 422, 'business-rule', 'A business rule was not met', {
      detail: error.message,
      code: error.code,
    });
  }
  console.error(error);
  return problem(c, 500, 'internal', 'Something went wrong on our side', { code: 'internal' });
};

/**
 * The versioned HTTP API, independent of Next.js so the same app serves the web
 * client, the future iOS client, tests and OpenAPI generation.
 */
export function createApi(options: ApiOptions) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problem(c, 400, 'invalid-request', 'The request is not valid', {
          detail: result.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
          code: 'invalid_request',
        });
      }
    },
  });

  app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const, version: options.version }, 200));

  app.doc31('/v1/openapi.json', OPENAPI_INFO);

  app.notFound(notFound);
  app.onError(onError);

  return app;
}

export type Api = ReturnType<typeof createApi>;

/**
 * The API as deployed, mounted under /api. Paths that match nothing under /api still
 * get problem documents rather than the framework's plain-text 404.
 */
export function createHttpApp(options: ApiOptions) {
  const app = new Hono().basePath('/api');
  app.route('/', createApi(options));
  app.notFound(notFound);
  app.onError(onError);
  return app;
}

/** The OpenAPI 3.1 document for the current code. */
export function openApiDocument(app: Api = createApi({ version: 'contract' })) {
  return app.getOpenAPI31Document(OPENAPI_INFO);
}
