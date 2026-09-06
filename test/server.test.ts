import { describe, expect, it } from 'vitest';
import { CacheStore } from '../src/cache/store.js';
import type { GitHubClient } from '../src/github/client.js';
import { PrivateRepositoryError, RepositoryNotFoundError, UpstreamRateLimitError } from '../src/github/client.js';
import { LlmError, type LlmProvider } from '../src/llm/provider.js';
import { InsightsService } from '../src/service.js';
import { buildServer } from '../src/server.js';
import { SAMPLE } from './fixtures.js';

function serverWith(options: {
  fetch?: GitHubClient['fetchMergedPullRequests'];
  provider?: LlmProvider | null;
  apiToken?: string;
}) {
  const client = {
    fetchMergedPullRequests:
      options.fetch ??
      (async () => ({ pullRequests: SAMPLE, truncated: false, rateLimitRemaining: 4999 })),
  } as unknown as GitHubClient;
  return buildServer({
    service: new InsightsService(client, new CacheStore(':memory:', 900)),
    provider: options.provider ?? null,
    logLevel: 'silent',
    corsOrigins: ['http://localhost:5173'],
    apiToken: options.apiToken,
  });
}

/** A model that echoes whatever the test wants it to say, so the route can be
 * exercised without a network call or an API key. */
function stubProvider(json: unknown): LlmProvider {
  return {
    name: 'stub',
    model: 'stub-1',
    complete: async () => ({ json, inputTokens: 10, outputTokens: 20 }),
  };
}

describe('GET /health', () => {
  it('reports that the narrative endpoint is unavailable with no key configured', async () => {
    const response = await serverWith({}).inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', narrativeAvailable: false });
  });
});

describe('GET /v1/insights', () => {
  it('returns the computed metrics and marks the first call a cache miss', async () => {
    const response = await serverWith({}).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-cache']).toBe('miss');
    expect(response.json().insights.totals.pullRequestsMerged).toBe(5);
  });

  it('serves the second identical call from cache without hitting upstream', async () => {
    let calls = 0;
    const app = serverWith({
      fetch: (async () => {
        calls += 1;
        return { pullRequests: SAMPLE, truncated: false, rateLimitRemaining: 4999 };
      }) as unknown as GitHubClient['fetchMergedPullRequests'],
    });
    const url = '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01';
    await app.inject({ method: 'GET', url });
    const second = await app.inject({ method: 'GET', url });
    expect(calls).toBe(1);
    expect(second.headers['x-cache']).toBe('hit');
  });

  it('answers 400 for a repository name that could smuggle a search qualifier', async () => {
    const response = await serverWith({}).inject({
      method: 'GET',
      url: `/v1/insights?repo=${encodeURIComponent('acme/widgets is:pr repo:other/thing')}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad_request');
  });

  it('answers 404 when the repository does not exist', async () => {
    const app = serverWith({
      fetch: (async () => {
        throw new RepositoryNotFoundError('repository not found');
      }) as unknown as GitHubClient['fetchMergedPullRequests'],
    });
    const response = await app.inject({ method: 'GET', url: '/v1/insights?repo=acme/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('repository_not_found');
  });

  it('answers 429 when GitHub rate limits us, rather than a bare 500', async () => {
    const app = serverWith({
      fetch: (async () => {
        throw new UpstreamRateLimitError('rate limited');
      }) as unknown as GitHubClient['fetchMergedPullRequests'],
    });
    const response = await app.inject({ method: 'GET', url: '/v1/insights?repo=acme/widgets' });
    expect(response.statusCode).toBe(429);
  });

  it('answers 403 for a private repository rather than reporting on it', async () => {
    // The token this service holds may be scoped wider than it needs. Refusing
    // private repositories means it still cannot be used to read private data.
    const app = serverWith({
      fetch: (async () => {
        throw new PrivateRepositoryError('this service only reports on public repositories');
      }) as unknown as GitHubClient['fetchMergedPullRequests'],
    });
    const response = await app.inject({ method: 'GET', url: '/v1/insights?repo=acme/secret' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('private_repository');
  });

  it('does not leak internals when something unexpected fails', async () => {
    const app = serverWith({
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443 while calling internal-host');
      }) as unknown as GitHubClient['fetchMergedPullRequests'],
    });
    const response = await app.inject({ method: 'GET', url: '/v1/insights?repo=acme/widgets' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toContain('internal-host');
  });
});

describe('GET /v1/insights/narrative', () => {
  // A well-behaved answer cites every number it mentions. The 3 in the prose is
  // why the reviewed count appears in the evidence array as well as the merged one.
  const goodOutput = {
    narrative: 'Five pull requests merged and 3 of them drew a review from somebody else.',
    hypothesis: { statement: 'Review is spread thin.', confidence: 0.4, reasoning: 'Small sample.' },
    evidence: [
      { claim: 'merged', metric: 'totals.pullRequestsMerged', value: 5 },
      { claim: 'reviewed', metric: 'totals.pullRequestsReviewed', value: 3 },
    ],
  };

  it('answers 503 with a usable message when no key is configured', async () => {
    const response = await serverWith({}).inject({ method: 'GET', url: '/v1/insights/narrative?repo=acme/widgets' });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain('ANTHROPIC_API_KEY');
  });

  it('returns the narrative alongside the metrics it was built from', async () => {
    const app = serverWith({ provider: stubProvider(goodOutput) });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.grounding).toMatchObject({ score: 1, evidenceGrounded: 2, unverifiedNumbersInNarrative: [] });
    expect(body.metrics.totals.pullRequestsMerged).toBe(5);
  });

  /**
   * A 200 would mean "here is a valid answer", and a narrative carrying numbers
   * that do not match the metrics is not one. The report travels with the
   * error so the caller can see which claim broke.
   */
  it('fails the request when the model misquotes a number, with the mismatch attached', async () => {
    const app = serverWith({
      provider: stubProvider({
        ...goodOutput,
        narrative: 'Throughput climbed 47% this month.',
        evidence: [{ claim: 'merged', metric: 'totals.pullRequestsMerged', value: 99 }],
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.error).toBe('narrative_not_grounded');
    expect(body.grounding.score).toBe(0);
    expect(body.evidence[0].problem).toBe('cited 99 but totals.pullRequestsMerged is 5');
  });

  /**
   * A sound answer that used a real figure without recording it is returned as
   * it stands. Spending the retry on that was measured and made results worse,
   * so the draw is kept in reserve for a genuinely bad answer.
   */
  it('does not spend a draw tidying an unrecorded figure', async () => {
    let attempt = 0;
    const provider: LlmProvider = {
      name: 'stub',
      model: 'stub-1',
      complete: async () => {
        attempt += 1;
        return {
          json:
            attempt === 1
              ? {
                  ...goodOutput,
                  // 1 is totals.pullRequestsUnreviewed, real but not cited here.
                  narrative: 'Five merged, 3 reviewed, and 1 went in unreviewed.',
                }
              : goodOutput,
          inputTokens: 10,
          outputTokens: 20,
        };
      },
    };
    const app = serverWith({ provider });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(attempt).toBe(1);
    expect(response.statusCode).toBe(200);
    expect(response.json().grounding.uncitedNumbersInNarrative).toEqual([1]);
  });

  it('accepts an unrecorded figure rather than failing when the draws run out', async () => {
    const app = serverWith({
      provider: stubProvider({
        ...goodOutput,
        narrative: 'Five merged, 3 reviewed, and 1 went in unreviewed.',
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().grounding.uncitedNumbersInNarrative).toEqual([1]);
  });

  it('retries once before failing, because a second draw usually lands clean', async () => {
    let attempt = 0;
    const flaky: LlmProvider = {
      name: 'stub',
      model: 'stub-1',
      complete: async () => {
        attempt += 1;
        return {
          json:
            attempt === 1
              ? { ...goodOutput, evidence: [{ claim: 'merged', metric: 'totals.pullRequestsMerged', value: 99 }] }
              : goodOutput,
          inputTokens: 10,
          outputTokens: 20,
        };
      },
    };
    const app = serverWith({ provider: flaky });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(attempt).toBe(2);
    expect(response.statusCode).toBe(200);
    expect(response.json().grounding.score).toBe(1);
  });

  it('catches a fabricated number hiding in the hypothesis, not just the narrative', async () => {
    // The narrative is clean here. Scanning it alone would report a perfect
    // grounding score beside a hypothesis that made a number up.
    const app = serverWith({
      provider: stubProvider({
        ...goodOutput,
        hypothesis: {
          statement: 'Review load shifted after the 14 new joiners landed.',
          confidence: 0.5,
          reasoning: 'Throughput moved 81% in the same period.',
        },
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().grounding.unverifiedNumbersInNarrative).toEqual([14, 81]);
  });

  it('retries a malformed response before giving up on it', async () => {
    // Strict schemas still let a model return the right keys with empty
    // strings. That is a bad draw, not a broken endpoint, so it gets the retry.
    let attempt = 0;
    const flaky: LlmProvider = {
      name: 'stub',
      model: 'stub-1',
      complete: async () => {
        attempt += 1;
        return {
          json: attempt === 1 ? { narrative: '', hypothesis: { statement: '', confidence: 0.5, reasoning: '' }, evidence: [] } : goodOutput,
          inputTokens: 10,
          outputTokens: 20,
        };
      },
    };
    const response = await serverWith({ provider: flaky }).inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(attempt).toBe(2);
    expect(response.statusCode).toBe(200);
  });

  it('answers 502, not 500, when a provider ignores the schema and returns prose', async () => {
    // OPENAI_BASE_URL invites endpoints whose schema support varies, so this is
    // the compatibility boundary rather than a hypothetical.
    const prose: LlmProvider = {
      name: 'stub',
      model: 'stub-1',
      complete: async () => {
        throw new LlmError('model returned content that is not JSON: Sure! Here is the analysis');
      },
    };
    const response = await serverWith({ provider: prose }).inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('model_error');
  });

  it('answers 502 when the model returns something that is not the agreed shape', async () => {
    const app = serverWith({ provider: stubProvider({ narrative: 'no hypothesis here' }) });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('model_error');
  });

  it('answers 502 when confidence comes back outside 0 to 1', async () => {
    const app = serverWith({
      provider: stubProvider({ ...goodOutput, hypothesis: { ...goodOutput.hypothesis, confidence: 4 } }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(502);
  });

  it('tells the model the window is incomplete, and reports it as incomplete', async () => {
    const app = serverWith({
      fetch: (async () => ({ pullRequests: SAMPLE, truncated: true, rateLimitRemaining: 4999 })) as unknown as GitHubClient['fetchMergedPullRequests'],
      provider: stubProvider(goodOutput),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/insights/narrative?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    const body = response.json();
    expect(body.dataComplete).toBe(false);
    expect(body.metrics.reviewLatency).toBeNull();
    expect(body.metrics.reviewConcentration).toBeNull();
  });

  it('answers 422 rather than asking a model to narrate an empty window', async () => {
    const app = serverWith({
      fetch: (async () => ({ pullRequests: [], truncated: false, rateLimitRemaining: 4999 })) as unknown as GitHubClient['fetchMergedPullRequests'],
      provider: stubProvider(goodOutput),
    });
    const response = await app.inject({ method: 'GET', url: '/v1/insights/narrative?repo=acme/widgets' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('no_data_in_window');
  });
});

/**
 * CORS governs whether a browser may read a response, by which point the
 * request has already reached GitHub or a paid model. A page a developer merely
 * visits can fire a GET at localhost, so a disallowed Origin is refused before
 * any work happens.
 */
describe('browser origin', () => {
  it('refuses a request from an origin that is not allowed', async () => {
    const response = await serverWith({}).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
      headers: { origin: 'https://evil.test' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('origin_not_allowed');
  });

  it('allows the configured origin', async () => {
    const response = await serverWith({}).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.statusCode).toBe(200);
  });

  /**
   * The bundled frontend runs on :5173 and the API on :8080. That is cross
   * origin and same site, so a Sec-Fetch rule applied ahead of the allow-list
   * would refuse the one browser client this project ships.
   */
  it('allows the bundled frontend, which is same-site and allow-listed', async () => {
    const response = await serverWith({}).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
      headers: { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a cross-site browser request that carries no origin', async () => {
    const response = await serverWith({}).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('cross_site_request');
  });

  it('leaves a request with no origin alone, which is every command line client', async () => {
    const response = await serverWith({}).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('bearer token, when one is configured', () => {
  const token = 'a-token-long-enough-to-pass';

  it('rejects a /v1 request that carries no token', async () => {
    const response = await serverWith({ apiToken: token }).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets',
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await serverWith({ apiToken: token }).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets',
      headers: { authorization: 'Bearer not-the-right-token-here' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the right token', async () => {
    const response = await serverWith({ apiToken: token }).inject({
      method: 'GET',
      url: '/v1/insights?repo=acme/widgets&from=2026-06-01&to=2026-07-01',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });

  /**
   * Fastify decodes percent-encoded path bytes before matching a route, so
   * /v%31/insights reaches /v1/insights. A guard that matched the request URL
   * as text saw a string that did not start with /v1/ and let it straight
   * through with no token at all.
   */
  it.each(['/v%31/insights', '/%76%31/insights', '/v1/%69nsights'])(
    'guards %s, which routes to /v1/insights after decoding',
    async (path) => {
      const app = serverWith({ apiToken: token });
      const url = `${path}?repo=acme/widgets&from=2026-06-01&to=2026-07-01`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const authorised = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorised.statusCode).toBe(200);
    },
  );

  it('leaves /health open so a container probe still works', async () => {
    const response = await serverWith({ apiToken: token }).inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});

describe('unknown routes', () => {
  it('answers 404 with a pointer to the real endpoints', async () => {
    const response = await serverWith({}).inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain('/v1/insights');
  });
});
