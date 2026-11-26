import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import {
  AppError,
  FLAGS,
  hasPermission,
  normaliseCorrelationId,
  platformMetrics,
  type FeatureFlags,
  type FileStore,
  type PeopleDirectory,
  type Logger,
  type Pool,
  type Principal,
  type SecretBox,
} from '@astra/platform';
import type { ApiConfig } from './config';
import type { Authenticator } from './auth/authenticator';
import { errorHandler, problem, sendProblem } from './http/problem';
import type { RouteMeta } from './http/types';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { accountRoutes } from './routes/accounts';
import { webhookRoutes } from './routes/webhooks';
import { eventRoutes } from './routes/events';
import { auditRoutes } from './routes/audit';
import { flagRoutes } from './routes/flags';
import { agentRoutes } from './routes/agents';
import { cardRoutes } from './routes/card';
import { refdataRoutes } from './routes/refdata';
import { filingRoutes } from './routes/filings';
import { formRoutes } from './routes/forms';
import { catalogueRoutes } from './routes/catalogue';
import { peopleRoutes } from './routes/people';
import { ratingRoutes } from './routes/rating';
import { planRoutes } from './routes/plans';
import { underwritingRoutes } from './routes/underwriting';
import { proposalRoutes } from './routes/proposals';
import { policyRoutes } from './routes/policies';
import { documentRoutes } from './routes/documents';
import { servicingRoutes } from './routes/servicing';
import type { CredentialIssuer } from './accounts/credentials';
import { accountConfigRoutes } from './routes/account-config';
import { channelRoutes } from './routes/channels';
import { workbenchRoutes } from './routes/workbench';
import { reportRoutes } from './routes/reports';
import { dataRoutes } from './routes/data';
import { serviceCloudRoutes } from './routes/service-cloud';
import { cardMappingRoutes } from './routes/card-mapping';
import { INTERNAL_HEADER, INTERNAL_KEY } from './http/internal';
import { billingRoutes } from './routes/billing';

export interface AppDeps {
  config: ApiConfig;
  pool: Pool;
  authenticator: Authenticator;
  flags: FeatureFlags;
  secrets: SecretBox;
  logger: Logger;
  files: FileStore;
  /** The clock servicing reads; tests move it to reach the end of a review period. */
  now?: () => Date;
  /** Issues sandbox credentials through the identity provider; absent when it is not configured. */
  credentials?: CredentialIssuer;
  /** Records display names of signed-in principals; optional so tests can leave it out. */
  people?: PeopleDirectory;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

const ANONYMOUS: Principal = {
  kind: 'system',
  subject: 'anonymous',
  name: null,
  email: null,
  roles: [],
  permissions: [],
  accountScope: { type: 'accounts', accountIds: [] },
};

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: (req) => normaliseCorrelationId(req.headers['x-correlation-id']),
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    bodyLimit: 1_048_576,
    trustProxy: true,
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  // Every route must declare its tenancy; the catalogue drives the cross-account test suite.
  const catalogue: RouteMeta[] = [];
  app.decorate('routeCatalogue', catalogue);
  app.addHook('onRoute', (route) => {
    const tenancy = route.config?.tenancy;
    if (!tenancy) {
      // Plugin-provided routes: API documentation and the CORS preflight handler are public.
      if (route.url.startsWith('/docs') || (route.method === 'OPTIONS' && route.url === '*')) {
        route.config = { ...route.config, tenancy: 'public' };
      } else {
        throw new Error(`Route ${route.method} ${route.url} does not declare its tenancy`);
      }
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      catalogue.push({
        method,
        url: route.url,
        tenancy: route.config!.tenancy!,
        permission: route.config?.permission ?? null,
      });
    }
  });

  app.decorateRequest('ctx', null as never);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Swagger UI needs inline styles and its own scripts; the API itself serves only JSON.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
      },
    },
  });
  // Browsers may call the API from the configured origins and, for the widget, from the origins each account lists.
  const staticOrigins = new Set((deps.config.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean));
  let widgetOrigins = { at: 0, set: new Set<string>() };
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, false);
      if (staticOrigins.has(origin)) return callback(null, true);
      if (Date.now() - widgetOrigins.at < 30_000) return callback(null, widgetOrigins.set.has(origin));
      deps.pool.query<{ origin: string }>('SELECT origin FROM channels.widget_origins()').then(
        (r) => {
          widgetOrigins = { at: Date.now(), set: new Set(r.rows.map((x) => x.origin)) };
          callback(null, widgetOrigins.set.has(origin));
        },
        () => callback(null, false),
      );
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: false,
    exposedHeaders: ['x-correlation-id', 'location', 'idempotent-replayed'],
  });

  // Availability and latency per route template (E13-F03-S01). Unmatched paths share one label so
  // scanners cannot create unbounded metric series.
  const apiMetrics = platformMetrics();
  app.addHook('onResponse', async (request, reply) => {
    apiMetrics.apiRequestDuration.record(reply.elapsedTime / 1000, {
      http_route: request.routeOptions.url ?? 'unmatched',
      http_request_method: request.method,
      http_response_status_code: reply.statusCode,
    });
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', String(request.id));
    const tenancy = request.routeOptions.config?.tenancy;
    if (!tenancy || tenancy === 'public') {
      request.ctx = { correlationId: String(request.id), principal: ANONYMOUS };
      return;
    }
    const principal = await deps.authenticator.authenticate(request.headers.authorization);
    if (principal.kind === 'partner') {
      const accountId =
        principal.accountScope.type === 'accounts' ? principal.accountScope.accountIds[0] : null;
      if (!(await deps.flags.isEnabled(FLAGS.partnerApiAccess, accountId))) {
        throw new AppError('forbidden', 'API access for this account is suspended.');
      }
    }
    request.ctx = { correlationId: String(request.id), principal };
    request.log = request.log.child({ actor: principal.subject });
    await deps.people?.record(principal);
  });

  await app.register(rateLimit, {
    global: true,
    hook: 'preValidation',
    max: deps.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ctx?.principal.subject ?? req.ip,
    allowList: (req) => req.url.startsWith('/health/') || req.headers[INTERNAL_HEADER] === INTERNAL_KEY,
  });

  // Authorisation runs before body validation, so callers without access learn nothing about request shapes.
  app.addHook('preValidation', async (request) => {
    const config = request.routeOptions.config;
    if (!config?.tenancy || config.tenancy === 'public') return;
    const principal = request.ctx.principal;
    if (config.tenancy === 'platform' && principal.accountScope.type !== 'all') {
      throw new AppError('forbidden', 'This operation is only available to Assurant staff.');
    }
    // A browser-held channel token is limited to its one quote.
    if (principal.quoteId && (request.params as { quoteId?: string } | undefined)?.quoteId !== principal.quoteId) {
      throw new AppError('forbidden', 'This token is limited to one quote.');
    }
    if (config.permission && !hasPermission(principal, config.permission)) {
      throw new AppError('forbidden', `This action needs the ${config.permission} permission.`);
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Astra Travel Platform API',
        version: '1.0.0',
        description:
          'Platform API for Astra Travel. All errors use RFC 9457 problem details with a stable `code`. ' +
          'Creating resources requires an `Idempotency-Key` header; repeating a request with the same key ' +
          'returns the original response.',
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      reply,
      problem('not_found', String(request.id), `No route for ${request.method} ${request.url}`),
    ),
  );

  await app.register(healthRoutes, deps);
  await app.register(meRoutes, deps);
  await app.register(accountRoutes, deps);
  await app.register(webhookRoutes, deps);
  await app.register(eventRoutes, deps);
  await app.register(auditRoutes, deps);
  await app.register(flagRoutes, deps);
  await app.register(agentRoutes, deps);
  await app.register(cardRoutes, deps);
  await app.register(refdataRoutes, deps);
  await app.register(filingRoutes, deps);
  await app.register(formRoutes, deps);
  await app.register(catalogueRoutes, deps);
  await app.register(peopleRoutes, deps);
  await app.register(ratingRoutes, deps);
  await app.register(planRoutes, deps);
  await app.register(underwritingRoutes, deps);
  await app.register(proposalRoutes, deps);
  await app.register(policyRoutes, deps);
  await app.register(documentRoutes, deps);
  await app.register(servicingRoutes, deps);
  await app.register(billingRoutes, deps);
  await app.register(accountConfigRoutes, deps);
  await app.register(channelRoutes, deps);
  await app.register(workbenchRoutes, deps);
  await app.register(reportRoutes, deps);
  await app.register(dataRoutes, deps);
  await app.register(serviceCloudRoutes, deps);
  await app.register(cardMappingRoutes, deps);

  return app;
}
