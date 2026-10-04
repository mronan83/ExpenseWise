import { isOwnRecordsRefusal } from '@expensewise/db';
import { DomainError } from '@expensewise/domain';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Hono, type Context, type ErrorHandler, type NotFoundHandler } from 'hono';
import type { ProviderKeyVerifier } from './ai-providers.ts';
import type { AuditStore } from './audit.ts';
import { registerAuditRoutes } from './audit-routes.ts';
import { callerScope, notYours, recordingCaller } from './caller.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { problem, ProblemError } from './problem.ts';
import { healthRoute } from './routes/health.ts';
import { meRoute } from './routes/me.ts';
import { readyRoute } from './routes/ready.ts';
import type { Readiness } from './schemas.ts';
import type { SecretBox } from './secret-box.ts';
import type { CategoryStore } from './categories.ts';
import { registerCategoryRoutes } from './category-routes.ts';
import { registerExpenseRoutes } from './expense-routes.ts';
import type { HomeStore } from './home.ts';
import { registerHomeRoutes } from './home-routes.ts';
import { registerInboundRoutes, type InboundRouteOptions } from './inbound-routes.ts';
import type { OrganizationStore } from './organization.ts';
import { registerOrganizationRoutes } from './organization-routes.ts';
import type { ModelSettingsStore } from './model-settings.ts';
import { registerModelSettingsRoutes } from './model-settings-routes.ts';
import type { ExpenseStore } from './expenses.ts';
import type { MileageStore } from './mileage.ts';
import { registerMileageRoutes } from './mileage-routes.ts';
import type { PeopleStore } from './people.ts';
import { registerPeopleRoutes } from './people-routes.ts';
import { registerReceiptRoutes, type ReceiptRouteOptions } from './receipt-routes.ts';
import { registerReportExportRoutes } from './report-export-routes.ts';
import { registerReimbursementRoutes } from './reimbursement-routes.ts';
import type { ReimbursementStore } from './reimbursement.ts';
import { registerReportRoutes } from './report-routes.ts';
import type { ReportStore } from './reports.ts';
import { registerTripRoutes } from './trip-routes.ts';
import type { TripStore } from './trips.ts';
import { registerWorkspaceRoutes } from './workspace-routes.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ApiOptions
  extends
    Pick<ReceiptRouteOptions, 'receipts' | 'files' | 'dispatch'>,
    Pick<InboundRouteOptions, 'birdWebhookSecret' | 'receiveEmail'> {
  /** Deployed commit SHA, or "dev". */
  readonly version: string;
  /** Verifies access tokens. Without one, protected routes answer 503 auth_not_configured. */
  readonly verifyToken?: TokenVerifier;
  /** Checks the database the way tenant requests use it. Without one, readiness answers 503. */
  readonly readiness?: ReadinessProbe;
  /** Sends unexpected errors to error tracking. Broken business rules (422) are not errors. */
  readonly reportError?: (error: unknown) => void;
  /** Organizations and AI provider keys. Without it, those routes answer 503. */
  readonly workspace?: WorkspaceStore;
  /** The organization's details and duplicate window. Without it, those routes answer 503. */
  readonly organization?: OrganizationStore;
  /** Expenses, each with its receipt as proof. Without it, those routes answer 503. */
  readonly expenses?: ExpenseStore;
  /** Trips and the expenses filed to them. Without it, those routes answer 503. */
  readonly trips?: TripStore;
  /** Drives logged by hand (FR-CAP-03). Without it, those routes answer 503. */
  readonly mileage?: MileageStore;
  /** What Home shows, read at once. Without it, Home answers 503. */
  readonly home?: HomeStore;
  /** Expense reports. Without it, those routes answer 503 and Needs you shows no reports. */
  readonly reports?: ReportStore;
  /** The audit trail and its chain check. Without it, those routes answer 503. */
  readonly audit?: AuditStore;
  /** Categories and types (FR-EXP-11). Without it, those routes answer 503 and expenses show none. */
  readonly categories?: CategoryStore;
  /** Which AI models read receipts (FR-INT-16). Without it, Settings › AI models answers 503. */
  readonly modelSettings?: ModelSettingsStore;
  /** The currency each person is reimbursed in. Without it, those routes answer 503. */
  readonly reimbursement?: ReimbursementStore;
  /** People and invite links (#29). Without it, those routes answer 503. */
  readonly people?: PeopleStore;
  /** Encrypts AI provider keys at rest. Without it, saving or testing a key answers 503. */
  readonly secrets?: SecretBox;
  /** Checks AI provider keys with a free call to the provider. */
  readonly verifyProviderKey?: ProviderKeyVerifier;
  /**
   * FLAG_OVERRIDES: features forced on or off for every organization, beating each owner's
   * switch. The kill switch.
   */
  readonly flagOverrides?: string;
  readonly now?: () => Date;
}

/** Never expected to throw; a probe that does still reads as not ready. */
export type ReadinessProbe = () => Promise<Readiness>;

const needsDatabase = { status: 'skip', detail: 'needs a database connection' } as const;
const notReady = (detail: string): Readiness => ({
  ready: false,
  checks: {
    database: { status: 'fail', detail },
    role: needsDatabase,
    tls: needsDatabase,
    tenantIsolation: needsDatabase,
  },
});

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

function errorHandler(reportError?: (error: unknown) => void): ErrorHandler {
  return (error, c) => {
    if (error instanceof ProblemError) {
      return problem(c, error.status, error.slug, error.title, error.extra);
    }
    if (error instanceof DomainError) {
      return problem(c, 422, 'business-rule', 'A business rule was not met', {
        detail: error.message,
        code: error.code,
      });
    }
    // The database refused a change that isn't the caller's own (ADR-0035): expected, not a bug.
    if (isOwnRecordsRefusal(error)) {
      const refusal = notYours();
      return problem(c, refusal.status, refusal.slug, refusal.title, refusal.extra);
    }
    console.error(error);
    reportError?.(error);
    return problem(c, 500, 'internal', 'Something went wrong on our side', { code: 'internal' });
  };
}

/**
 * The versioned HTTP API, independent of Next.js so the same app serves the web
 * client, the future iOS client, tests and OpenAPI generation.
 */
export function createApi(options: ApiOptions) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>({
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

  // First, before any route: each request gets a slot for who it acts for (ADR-0035).
  app.use('*', callerScope);

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'A Supabase Auth access token for a signed-in user.',
  });

  app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const, version: options.version }, 200));

  app.openapi(readyRoute, async (c) => {
    const report = options.readiness
      ? await options.readiness().catch((error: unknown) => {
          // Logged only: a connection failure can carry connection details.
          console.error('Readiness probe threw', error);
          return notReady('readiness check failed');
        })
      : notReady('readiness is not configured');
    c.header('Cache-Control', 'no-store');
    return report.ready ? c.json(report, 200) : c.json(report, 503);
  });

  // Protected routes: register the identity check before each handler.
  app.use(meRoute.getRoutingPath(), requireIdentity(options.verifyToken));
  app.openapi(meRoute, (c) => {
    const { userId, email, assuranceLevel, sessionId } = c.var.identity;
    return c.json({ userId, email, assuranceLevel, sessionId }, 200);
  });

  // One gate for every route: a feature that is off answers 404 feature_off.
  const features: FeatureGate = featureGate(options);
  // Each route resolves its caller through the workspace store, which records them as who the
  // request acts for, so members' records are read and changed as them (ADR-0035).
  const workspace = options.workspace && recordingCaller(options.workspace);
  const routes = { ...options, workspace, features };
  registerWorkspaceRoutes(app, routes);
  registerOrganizationRoutes(app, routes);
  registerReceiptRoutes(app, routes);
  registerExpenseRoutes(app, routes);
  registerTripRoutes(app, routes);
  registerMileageRoutes(app, routes);
  registerHomeRoutes(app, routes);
  registerReportRoutes(app, routes);
  registerReportExportRoutes(app, routes);
  registerReimbursementRoutes(app, routes);
  registerInboundRoutes(app, routes);
  registerAuditRoutes(app, routes);
  registerCategoryRoutes(app, routes);
  registerModelSettingsRoutes(app, routes);
  registerPeopleRoutes(app, routes);

  app.doc31('/v1/openapi.json', OPENAPI_INFO);

  app.notFound(notFound);
  app.onError(errorHandler(options.reportError));

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
  app.onError(errorHandler(options.reportError));
  return app;
}

/** The OpenAPI 3.1 document for the current code. */
export function openApiDocument(app: Api = createApi({ version: 'contract' })) {
  return app.getOpenAPI31Document(OPENAPI_INFO);
}
