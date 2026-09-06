/** Mirrors the server response shapes. Kept narrow: only what the page renders. */

export interface ContributorRow {
  login: string;
  pullRequestsAuthored: number;
  pullRequestsReviewed: number;
  reviewsSubmitted: number;
  reviewComments: number;
}

export interface Insights {
  repository: string;
  window: { from: string; to: string };
  sampleComplete: boolean;
  totals: {
    pullRequestsMerged: number;
    pullRequestsAuthoredByBots: number;
    pullRequestsReviewed: number;
    pullRequestsUnreviewed: number;
    reviewsSubmitted: number;
    contributors: number;
    botAccountsExcluded: number;
  };
  contributors: ContributorRow[];
  reviewLatency: { medianHours: number; p90Hours: number; sampleSize: number } | null;
  reviewConcentration: {
    topReviewer: string;
    pullRequestsReviewed: number;
    denominator: number;
    share: number;
  } | null;
}

export interface Evidence {
  claim: string;
  metric: string;
  value: number;
  grounded: boolean;
  actualValue: number | null;
  unit: string | null;
  problem?: string;
}

export interface Narrative {
  narrative: string;
  dataComplete: boolean;
  hypothesis: { statement: string; confidence: number; reasoning: string };
  evidence: Evidence[];
  grounding: {
    score: number | null;
    evidenceTotal: number;
    evidenceGrounded: number;
    unverifiedNumbersInNarrative: number[];
  };
  model: { provider: string; name: string; attempts: number };
  metrics: Insights;
}

export interface InsightsResponse {
  insights: Insights;
  meta: { cache: 'hit' | 'miss'; cacheAgeSeconds: number | null; truncated: boolean };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Present on a 502 from the narrative endpoint, which returns its report. */
    readonly grounding?: Narrative['grounding'],
    readonly evidence?: Evidence[],
  ) {
    super(message);
  }
}

/**
 * Set when the API is running with API_TOKEN configured, which is what the
 * compose file tells an operator to do before publishing the port wider. The
 * token lives in memory only, so it is never written to storage.
 */
let bearerToken: string | null = null;

export function setBearerToken(token: string): void {
  bearerToken = token.trim() === '' ? null : token.trim();
}

async function request<T>(path: string, params: URLSearchParams): Promise<T> {
  const response = await fetch(`${path}?${params.toString()}`, {
    headers: bearerToken === null ? undefined : { authorization: `Bearer ${bearerToken}` },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? 'unknown',
      body.message ?? 'Request failed.',
      body.grounding,
      body.evidence,
    );
  }
  return body as T;
}

function query(repo: string, from: string, to: string): URLSearchParams {
  const params = new URLSearchParams({ repo });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params;
}

/** The exact query behind a set of results, so the page can never mix two. */
export interface Query {
  repo: string;
  from: string;
  to: string;
}

export const fetchInsights = (q: Query): Promise<InsightsResponse> =>
  request<InsightsResponse>('/v1/insights', query(q.repo, q.from, q.to));

export const fetchNarrative = (q: Query): Promise<Narrative> =>
  request<Narrative>('/v1/insights/narrative', query(q.repo, q.from, q.to));
