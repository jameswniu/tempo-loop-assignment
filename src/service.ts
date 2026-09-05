import { GitHubClient } from './github/client.js';
import { CacheStore, upstreamKey } from './cache/store.js';
import { computeInsights } from './metrics/compute.js';
import type { Insights, PullRequestRecord, Window } from './metrics/types.js';

export interface InsightsResponse {
  insights: Insights;
  meta: {
    cache: 'hit' | 'miss';
    cacheAgeSeconds: number | null;
    /** True when the upstream result cap was reached, so every count is a floor. */
    truncated: boolean;
    rateLimitRemaining: number | null;
  };
}

interface CachedUpstream {
  pullRequests: PullRequestRecord[];
  truncated: boolean;
}

/**
 * Ties the three layers together: fetch (cached), compute, respond. Kept
 * separate from the HTTP routes so the same path is exercised by tests and by
 * the eval harness without standing a server up.
 */
export class InsightsService {
  constructor(
    private readonly github: GitHubClient,
    private readonly cache: CacheStore,
  ) {}

  async getInsights(owner: string, repo: string, window: Window): Promise<InsightsResponse> {
    const key = upstreamKey(owner, repo, window.from, window.to);
    const cached = this.cache.get<CachedUpstream>(key);

    if (cached !== null) {
      return {
        insights: computeInsights(`${owner}/${repo}`, cached.value.pullRequests, window, {
          sampleComplete: !cached.value.truncated,
        }),
        meta: {
          cache: 'hit',
          cacheAgeSeconds: cached.ageSeconds,
          truncated: cached.value.truncated,
          rateLimitRemaining: null,
        },
      };
    }

    const fetched = await this.github.fetchMergedPullRequests(owner, repo, window);
    this.cache.set(key, { pullRequests: fetched.pullRequests, truncated: fetched.truncated });

    return {
      insights: computeInsights(`${owner}/${repo}`, fetched.pullRequests, window, {
        sampleComplete: !fetched.truncated,
      }),
      meta: {
        cache: 'miss',
        cacheAgeSeconds: null,
        truncated: fetched.truncated,
        rateLimitRemaining: fetched.rateLimitRemaining,
      },
    };
  }
}
