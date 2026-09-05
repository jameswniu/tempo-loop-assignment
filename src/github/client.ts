import { graphql } from '@octokit/graphql';
import { isBotLogin } from '../metrics/compute.js';
import type { Actor, PullRequestRecord, ReviewRecord, ReviewState, Window } from '../metrics/types.js';

/**
 * GitHub owner and repository names allow letters, digits, hyphen, underscore
 * and dot. Validating against that set matters because the value is
 * interpolated into a search query string, and an unchecked value could smuggle
 * extra qualifiers (a space then `repo:someone/else`) and quietly widen the
 * search past the repository the caller named.
 */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export class InvalidRepositoryError extends Error {}
export class RepositoryNotFoundError extends Error {}
export class PrivateRepositoryError extends Error {}
export class UpstreamRateLimitError extends Error {}

export interface FetchResult {
  pullRequests: PullRequestRecord[];
  /** True when the upstream result cap was hit, so the numbers are a floor. */
  truncated: boolean;
  rateLimitRemaining: number | null;
}

/** GitHub search returns at most 1000 results for any one query. */
const SEARCH_RESULT_CAP = 1000;
const PAGE_SIZE = 50;

const QUERY = `
  query($owner: String!, $name: String!, $q: String!, $cursor: String) {
    rateLimit { remaining }
    repository(owner: $owner, name: $name) { nameWithOwner isPrivate }
    search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $cursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
          title
          createdAt
          mergedAt
          author { login __typename }
          reviews(first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              state
              submittedAt
              author { login __typename }
              comments { totalCount }
            }
          }
        }
      }
    }
  }
`;

/** GraphQL resolves author to a union; __typename is how a Bot identifies itself. */
interface GraphQLActor {
  login: string;
  __typename: string;
}

interface SearchResponse {
  rateLimit: { remaining: number } | null;
  repository: { nameWithOwner: string; isPrivate: boolean } | null;
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      number?: number;
      title?: string;
      createdAt?: string;
      mergedAt?: string | null;
      author?: GraphQLActor | null;
      reviews?: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<RawReview | null>;
      };
    } | null>;
  };
}

export class GitHubClient {
  private readonly request: typeof graphql;

  constructor(token: string) {
    this.request = graphql.defaults({ headers: { authorization: `bearer ${token}` } });
  }

  /**
   * Fetches every pull request merged in the window, with its reviews, in one
   * paginated query. The REST shape of this would be one list call plus a
   * reviews call and a comments call per pull request, so roughly 1 + 2N
   * requests against a 5000 per hour budget. This is N / 50 requests, and the
   * `merged:` qualifier does the window filtering upstream so we never download
   * pull requests we would immediately discard.
   */
  async fetchMergedPullRequests(owner: string, repo: string, window: Window): Promise<FetchResult> {
    if (!NAME.test(owner) || !NAME.test(repo)) {
      throw new InvalidRepositoryError(
        'owner and repo may contain only letters, digits, dot, hyphen and underscore',
      );
    }

    const from = isoDate(window.from);
    // GitHub's merged: range is inclusive on both ends while our window is half
    // open, so we ask for one day past the end and drop the overshoot in
    // computeInsights, which is the single place the boundary rule lives.
    const to = isoDate(window.to);
    const q = `repo:${owner}/${repo} is:pr is:merged merged:${from}..${to} sort:updated-desc`;

    const collected: PullRequestRecord[] = [];
    let cursor: string | null = null;
    let remaining: number | null = null;
    let issueCount = 0;

    do {
      const response: SearchResponse = await this.send(owner, repo, q, cursor);
      remaining = response.rateLimit?.remaining ?? remaining;
      issueCount = response.search.issueCount;

      for (const node of response.search.nodes) {
        if (node?.number === undefined || node.createdAt === undefined) continue;
        const reviews = mapReviews(node.reviews?.nodes ?? []);
        // A pull request can carry more than one page of reviews. Left
        // unfollowed, a contentious one silently undercounts its reviewers, so
        // the remaining pages are fetched for the few pull requests that need
        // it rather than the numbers quietly being wrong.
        if (node.reviews?.pageInfo.hasNextPage === true) {
          reviews.push(
            ...(await this.fetchRemainingReviews(owner, repo, node.number, node.reviews.pageInfo.endCursor)),
          );
        }
        collected.push({
          number: node.number,
          title: node.title ?? '',
          author: toActor(node.author),
          createdAt: node.createdAt,
          mergedAt: node.mergedAt ?? null,
          reviews,
        });
      }

      cursor = response.search.pageInfo.hasNextPage ? response.search.pageInfo.endCursor : null;
    } while (cursor !== null && collected.length < SEARCH_RESULT_CAP);

    return {
      pullRequests: collected,
      truncated: issueCount > SEARCH_RESULT_CAP,
      rateLimitRemaining: remaining,
    };
  }

  /** Follows the review cursor for a single pull request past the first page. */
  private async fetchRemainingReviews(
    owner: string,
    name: string,
    number: number,
    startCursor: string | null,
  ): Promise<ReviewRecord[]> {
    const collected: ReviewRecord[] = [];
    let cursor = startCursor;
    let pages = 0;

    while (cursor !== null && pages < MAX_REVIEW_PAGES) {
      const response = await this.request<ReviewPageResponse>(REVIEW_PAGE_QUERY, {
        owner,
        name,
        number,
        cursor,
      });
      const page = response.repository?.pullRequest?.reviews;
      if (page === undefined || page === null) break;
      collected.push(...mapReviews(page.nodes));
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      pages += 1;
    }
    return collected;
  }

  private async send(
    owner: string,
    name: string,
    q: string,
    cursor: string | null,
  ): Promise<SearchResponse> {
    try {
      const response = await this.request<SearchResponse>(QUERY, { owner, name, q, cursor });
      // Search finds nothing for a repository that does not exist rather than
      // failing, so an unknown repository would otherwise read as a healthy one
      // with no activity. Resolving the repository in the same query separates
      // "no pull requests merged" from "no such repository".
      if (response.repository === null) {
        throw new RepositoryNotFoundError('repository not found, or not visible to this token');
      }
      // The service is scoped to public data, as the assignment asks. Refusing
      // private repositories here means a token with wider scope than it needs
      // still cannot be used through this endpoint to read private activity.
      if (response.repository.isPrivate) {
        throw new PrivateRepositoryError('this service only reports on public repositories');
      }
      return response;
    } catch (error) {
      if (error instanceof RepositoryNotFoundError || error instanceof PrivateRepositoryError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/rate limit|secondary rate/i.test(message)) {
        throw new UpstreamRateLimitError('GitHub rate limit reached, retry later');
      }
      if (/could not resolve to a Repository|NOT_FOUND/i.test(message)) {
        throw new RepositoryNotFoundError('repository not found, or not visible to this token');
      }
      throw error;
    }
  }
}

/**
 * The account type is authoritative. The login suffix is kept as a second
 * signal so this stays correct if the mapper is ever pointed at REST payloads,
 * which mark bots in the name instead.
 */
function toActor(actor: GraphQLActor | null | undefined): Actor | null {
  if (actor == null) return null;
  return { login: actor.login, isBot: actor.__typename === 'Bot' || isBotLogin(actor.login) };
}

/** Bounds the follow-up paging. 20 pages is 2000 reviews on one pull request. */
const MAX_REVIEW_PAGES = 20;

const REVIEW_PAGE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            state
            submittedAt
            author { login __typename }
            comments { totalCount }
          }
        }
      }
    }
  }
`;

interface RawReview {
  state: string;
  submittedAt: string | null;
  author: GraphQLActor | null;
  comments: { totalCount: number };
}

interface ReviewPageResponse {
  repository: {
    pullRequest: {
      reviews: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<RawReview | null> };
    } | null;
  } | null;
}

function mapReviews(nodes: Array<RawReview | null>): ReviewRecord[] {
  return nodes
    .filter((r): r is RawReview => r !== null && r.submittedAt !== null)
    .map((r) => ({
      author: toActor(r.author),
      submittedAt: r.submittedAt as string,
      state: normaliseState(r.state),
      commentCount: r.comments.totalCount,
    }));
}

function isoDate(instant: string): string {
  return new Date(instant).toISOString().slice(0, 10);
}

function normaliseState(state: string): ReviewState {
  const allowed: ReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'];
  return allowed.includes(state as ReviewState) ? (state as ReviewState) : 'COMMENTED';
}
