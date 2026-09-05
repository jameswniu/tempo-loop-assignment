import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import {
  InvalidRepositoryError,
  PrivateRepositoryError,
  RepositoryNotFoundError,
  UpstreamRateLimitError,
} from './github/client.js';
import { LlmError, type LlmProvider } from './llm/provider.js';
import { generateNarrative, NarrativeNotGroundedError } from './llm/narrative.js';
import { BadRequestError, parseQuery } from './routes/params.js';
import type { InsightsService } from './service.js';

export interface ServerDeps {
  service: InsightsService;
  /** Absent when no API key is configured. The insights endpoint still works. */
  provider: LlmProvider | null;
  logLevel: string;
  /** Browser origins allowed to call the API. Empty disables cross-origin calls. */
  corsOrigins: string[];
  /** When set, /v1 routes require `Authorization: Bearer <token>`. */
  apiToken?: string | undefined;
}

/** Fastify attaches a `validation` array to errors its own schema layer raises. */
function isSchemaValidationError(error: unknown): error is Error & { validation: unknown[] } {
  return error instanceof Error && Array.isArray((error as { validation?: unknown }).validation);
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.logLevel,
      // Tokens must never reach the log. Fastify logs headers by default.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  // An explicit allow-list rather than a reflected origin. The API needs no
  // credentials, but reflecting any origin would let any page a developer has
  // open drive their local instance and its GitHub token.
  app.register(cors, { origin: deps.corsOrigins });

  /** Open by design, so a container health probe needs no credentials. */
  app.get('/health', async () => ({
    status: 'ok',
    narrativeAvailable: deps.provider !== null,
    provider: deps.provider?.name ?? null,
    model: deps.provider?.model ?? null,
  }));

  /**
   * The /v1 routes live in their own plugin so the guards below are scoped by
   * ROUTING rather than by matching the request URL as text. That distinction
   * is the whole point: Fastify decodes percent-encoded path bytes before it
   * matches a route, so `/v%31/insights` reaches `/v1/insights` while a
   * `url.startsWith('/v1/')` check sees a string that does not match and waves
   * the request through with no origin check and no bearer token.
   */
  app.register(
    async (v1) => {
      /**
       * CORS decides whether a browser may READ a response, which is too late
       * for an endpoint that spends money: the request has already fired. A
       * cross-origin page always announces itself with an Origin header, and
       * curl, HTTPie and Postman send none, so refusing a disallowed Origin
       * here stops a drive-by without asking the reviewer for a token on their
       * own machine.
       */
      v1.addHook('onRequest', async (request, reply) => {
        const origin = request.headers.origin;
        if (origin !== undefined) {
          // An Origin was announced, so the allow-list is the whole decision.
          // The bundled frontend on :5173 calling the API on :8080 is cross
          // origin and same site, and it belongs here by being allow-listed.
          if (!deps.corsOrigins.includes(origin)) {
            return reply
              .code(403)
              .send({ error: 'origin_not_allowed', message: 'This origin may not call the API.' });
          }
          return;
        }

        // No Origin. That is either a command line client, which sends no
        // Sec-Fetch header at all, or a browser request that does not announce
        // an origin, such as a navigation or an <img> subresource. Only the
        // second kind is refused, and Sec-Fetch-Site tells them apart.
        const fetchSite = request.headers['sec-fetch-site'];
        if (typeof fetchSite === 'string' && fetchSite !== 'none' && fetchSite !== 'same-origin') {
          return reply
            .code(403)
            .send({ error: 'cross_site_request', message: 'Cross-site browser requests are not accepted.' });
        }
      });

      if (deps.apiToken !== undefined) {
        const expected = `Bearer ${deps.apiToken}`;
        v1.addHook('onRequest', async (request, reply) => {
          if (request.headers.authorization !== expected) {
            return reply
              .code(401)
              .send({ error: 'unauthorized', message: 'Missing or invalid bearer token.' });
          }
        });
      }

      /**
       * The metric endpoint. Returns the leaderboard and the summary figures
       * for a repository over a window, with no model involved.
       */
      v1.get('/insights', async (request, reply) => {
        const { owner, repo, window } = parseQuery(request.query);
        const result = await deps.service.getInsights(owner, repo, window);
        reply.header('x-cache', result.meta.cache);
        return result;
      });

      /**
       * The narrative endpoint. Computes the same metrics, hands the model a
       * fact table built from them, and checks the model's citations against
       * that table before returning anything.
       */
      v1.get('/insights/narrative', async (request, reply) => {
        if (deps.provider === null) {
          return reply.code(503).send({
            error: 'narrative_unavailable',
            message:
              'No LLM API key is configured. Set ANTHROPIC_API_KEY in .env and restart. The /v1/insights endpoint works without one.',
          });
        }

        const { owner, repo, window } = parseQuery(request.query);
        const result = await deps.service.getInsights(owner, repo, window);

        if (result.insights.totals.pullRequestsMerged === 0) {
          return reply.code(422).send({
            error: 'no_data_in_window',
            message: 'No pull requests merged in this window, so there is nothing to narrate.',
            window,
          });
        }

        const narrative = await generateNarrative(result.insights, deps.provider, {
          truncated: result.meta.truncated,
        });
        reply.header('x-cache', result.meta.cache);
        return { ...narrative, metrics: result.insights, meta: result.meta };
      });
    },
    { prefix: '/v1' },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BadRequestError || error instanceof InvalidRepositoryError) {
      return reply.code(400).send({ error: 'bad_request', message: error.message });
    }
    if (error instanceof RepositoryNotFoundError) {
      return reply.code(404).send({ error: 'repository_not_found', message: error.message });
    }
    if (error instanceof PrivateRepositoryError) {
      return reply.code(403).send({ error: 'private_repository', message: error.message });
    }
    if (error instanceof UpstreamRateLimitError) {
      return reply.code(429).send({ error: 'upstream_rate_limited', message: error.message });
    }
    if (error instanceof NarrativeNotGroundedError) {
      // Not a 200. A narrative carrying numbers that do not match the computed
      // metrics is a failed answer, and the report travels with the error so
      // the caller can see exactly which claim broke.
      return reply.code(502).send({
        error: 'narrative_not_grounded',
        message: error.message,
        grounding: error.result.grounding,
        evidence: error.result.evidence,
        narrative: error.result.narrative,
      });
    }
    if (error instanceof LlmError) {
      return reply.code(502).send({ error: 'model_error', message: error.message });
    }
    if (isSchemaValidationError(error)) {
      return reply.code(400).send({ error: 'bad_request', message: error.message });
    }

    // Anything unrecognised is logged in full and reported without internals,
    // so a stack trace or an upstream URL never reaches the client.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong.' });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: 'not_found',
      message: 'Try GET /v1/insights?repo=owner/name or GET /v1/insights/narrative?repo=owner/name',
    }),
  );

  return app;
}
