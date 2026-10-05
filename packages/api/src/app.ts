import { isOwnRecordsRefusal } from '@expensewise/db';
import { DomainError } from '@expensewise/domain';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Hono, type Context, type ErrorHandler, type NotFoundHandler } from 'hono';
import type { ProviderKeyVerifier } from './ai-providers.ts';
import type { ApprovalStore } from './approval.ts';
import { registerApprovalRoutes } from './approval-routes.ts';
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
import type { ItemizedStore } from './itemized.ts';
import { registerItemizedRoutes } from './itemized-routes.ts';
import type { MileageStore } from './mileage.ts';
import type { MileageRateStore } from './mileage-rates.ts';
import { registerMileageRateRoutes } from './mileage-rate-routes.ts';
import { registerMileageRoutes } from './mileage-routes.ts';
import type { PeopleStore } from './people.ts';
import { registerPeopleRoutes } from './people-routes.ts';
import { registerReceiptRoutes, type ReceiptRouteOptions } from './receipt-routes.ts';
import { registerReportExportRoutes } from './report-export-routes.ts';
import { registerReimbursementRoutes } from './reimbursement-routes.ts';
import type { ReimbursementStore } from './reimbursement.ts';
import { registerReportRoutes } from './report-routes.ts';
import type { ReportStore } from './reports.ts';
import type { RouteKeyStore, RouteKeyVerifier, RouteMileageStore } from './route-mileage.ts';
import { registerRouteMileageRoutes } from './route-mileage-routes.ts';
import { registerTripRoutes } from './trip-routes.ts';
import type { TripStore } from './trips.ts';
import { registerUnfiledEmailRoutes } from './unfiled-email-routes.ts';
import type { UnfiledEmailStore } from './unfiled-emails.ts';
import { listFeaturesRoute } from './routes/workspace.ts';
import { beforeTheCode, secondFactorEverywhere } from './second-factor.ts';
import { registerWorkspaceRoutes } from './workspace-routes.ts';
import type { WorkspaceStore } from './workspace.ts';

/**
 * The only routes a session that hasn't passed the code may use while the second factor holds
 * everything else (#85): the organization's switches, which the code screen and the check that
 * sends someone to it read. An email held until it adds its own authenticator (#88) uses the
 * same list: Settings › Sign-ins adds one through Supabase Auth in the browser and reads only
 * the switches from us; so does an email that isn't let in (#90), whose screen says so and
 * offers signing out. `GET /v1/me` names who is signed in and nothing of an organization, so it
 * is never held; the health checks and the email webhook carry no person's token, so an email
 * from an address that isn't let in is still filed.
 */
export const BEFORE_THE_CODE = [listFeaturesRoute] as const;

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
  /**
   * The organization's rate a mile (Q28). Without it, its routes answer 503 and a quote is at
   * the IRS rate; logging a drive reads the rate itself.
   */
  readonly mileageRates?: MileageRateStore;
  /** Drives logged by their stops, and saved places (FR-CAP-04). Without it, those answer 503. */
  readonly routeMileage?: RouteMileageStore;
  /** The organization's OpenRouteService key (Q31). Without it, Settings › Mileage answers 503. */
  readonly routeKeys?: RouteKeyStore;
  /** Checks an OpenRouteService key with one short route as it is saved (ADR-0039). */
  readonly verifyRouteKey?: RouteKeyVerifier;
  /** What Home shows, read at once. Without it, Home answers 503. */
  readonly home?: HomeStore;
  /** Expense reports. Without it, those routes answer 503 and Needs you shows no reports. */
  readonly reports?: ReportStore;
  /**
   * Approval (#24). Without it, those routes answer 503, and Needs you shows nothing to approve
   * and no returned report.
   */
  readonly approvals?: ApprovalStore;
  /** The audit trail and its chain check. Without it, those routes answer 503. */
  readonly audit?: AuditStore;
  /** Categories and types (FR-EXP-11). Without it, those routes answer 503 and expenses show none. */
  readonly categories?: CategoryStore;
  /**
   * Emails that filed nothing (#59). Without it, Needs you lists none and dismissing one
   * answers 503.
   */
  readonly emails?: UnfiledEmailStore;
  /** Receipts' itemized lines and expenses' splits. Without it, those routes answer 503. */
  readonly itemized?: ItemizedStore;
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
      'plus an ISO 4217 code. Errors are RFC 9457 problem documents. While an organization ' +
      'has the second factor switched on, every request of a person whose sign-in has a ' +
      'verified authenticator, from a session that has not passed it (aal1), is refused with ' +
      '403 second_factor_required, except GET /v1/me and GET /v1/features. Once a person has ' +
      'an authenticator, only a sign-in they let in opens the API: the one they first signed ' +
      'in with is let in once it passes its code, and a session of another is refused the same ' +
      'way with 403 sign_in_not_let_in, naming its email, until they let it in from a sign-in ' +
      'let in that passed its code. One let in with no authenticator of its own, or the one ' +
      'first signed in with while none of theirs is let in, is refused with 403 ' +
      'authenticator_required, naming its email, until it adds one and passes it. While none ' +
      'of their sign-ins is let in, both refusals carry noneLetIn: true.',
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
  // request acts for, so members' records are read and changed as them (ADR-0035). Resolving
  // them first, while their organization has the second factor on, refuses an email of a person
  // with an authenticator that they haven't let in, holds one let in until it adds its own, and
  // asks one with an authenticator for its code, so every route asks it; the first of a person's
  // emails to pass its code is let in there (#85, #88, #90, ADR-0044).
  const store = options.workspace;
  const workspace =
    store &&
    recordingCaller(
      store,
      secondFactorEverywhere(features, (caller, actor) => store.recordPassedCode(caller, actor)),
    );
  // What the code screen, and the check in front of it, need before the code: the switch. Who is
  // signed in (GET /v1/me) never resolves an organization, so it needs no mark.
  for (const route of BEFORE_THE_CODE) app.use(route.getRoutingPath(), beforeTheCode(route.method));
  const routes = { ...options, workspace, features };
  registerWorkspaceRoutes(app, routes);
  registerOrganizationRoutes(app, routes);
  registerReceiptRoutes(app, routes);
  registerExpenseRoutes(app, routes);
  registerTripRoutes(app, routes);
  registerMileageRoutes(app, routes);
  registerMileageRateRoutes(app, routes);
  registerRouteMileageRoutes(app, routes);
  registerHomeRoutes(app, routes);
  registerReportRoutes(app, routes);
  registerApprovalRoutes(app, routes);
  registerReportExportRoutes(app, routes);
  registerReimbursementRoutes(app, routes);
  registerInboundRoutes(app, routes);
  registerAuditRoutes(app, routes);
  registerCategoryRoutes(app, routes);
  registerItemizedRoutes(app, routes);
  registerModelSettingsRoutes(app, routes);
  registerPeopleRoutes(app, routes);
  registerUnfiledEmailRoutes(app, routes);

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
