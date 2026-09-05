import type {
  Actor,
  ConcentrationSummary,
  ContributorRow,
  Insights,
  LatencySummary,
  PullRequestRecord,
  Window,
} from './types.js';

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Fallback for mappers that cannot see the account type. GitHub's REST API
 * suffixes app logins with [bot] while GraphQL does not, so this catches the
 * REST shape and the client sets Actor.isBot from __typename for GraphQL.
 */
export function isBotLogin(login: string): boolean {
  return login.endsWith('[bot]');
}

/** A contributor counts only when the account exists and is a person. */
function isPerson(actor: Actor | null): actor is Actor {
  return actor !== null && !actor.isBot;
}

/**
 * Half-open membership test. A pull request belongs to the window by the
 * instant it merged, so an open pull request is never counted no matter when
 * it was created, and one merged exactly at `to` belongs to the next window.
 */
export function mergedWithin(pr: PullRequestRecord, window: Window): boolean {
  if (pr.mergedAt === null) return false;
  const merged = Date.parse(pr.mergedAt);
  return merged >= Date.parse(window.from) && merged < Date.parse(window.to);
}

/**
 * Nearest-rank percentile over an ascending sample. p90 is the value at
 * index ceil(0.9 * n) - 1, so it is always an observed value and never an
 * interpolation between two of them. The median is the mean of the two middle
 * values when n is even, which is the one place a value not in the sample can
 * be reported.
 */
export function percentile(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) throw new RangeError('percentile of an empty sample');
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index]!;
}

export function median(sortedAscending: number[]): number {
  const n = sortedAscending.length;
  if (n === 0) throw new RangeError('median of an empty sample');
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAscending[mid]! : (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2;
}

/**
 * The first review of a pull request by somebody other than its author.
 * Self-reviews are excluded because a pull request nobody else looked at has
 * not been reviewed, whatever the timeline says. Returns null when no such
 * review exists, which is what makes a pull request "unreviewed" here.
 */
function firstExternalReviewAt(pr: PullRequestRecord): number | null {
  const times = pr.reviews
    .filter((r) => isPerson(r.author) && r.author.login !== pr.author?.login)
    .map((r) => Date.parse(r.submittedAt))
    .filter((t) => Number.isFinite(t));
  return times.length === 0 ? null : Math.min(...times);
}

/**
 * Computes every number the API reports, as a pure function of the fetched
 * pull requests and the window. No network, no clock, no database, so a test
 * fixture pins the arithmetic exactly and the same input always produces the
 * same output.
 *
 * Counting rules, each of which a reader can check against this file:
 *   - A pull request counts when its merged_at falls in [from, to).
 *   - pullRequestsMerged counts every one of them, so it can be checked against
 *     GitHub's own search. Bot-authored ones are then reported separately and
 *     left out of the review figures, because whether a dependency bump got a
 *     human review is a different question from how the team reviews itself.
 *   - No bot ever appears as a contributor, and a bot's review never counts.
 *   - A review by the pull request author never counts as a review.
 *   - pullRequestsReviewed counts distinct pull requests, reviewsSubmitted
 *     counts submissions, so a second pass on one pull request moves only the
 *     second number.
 *   - Review latency is measured from pull request creation to that first
 *     external review, and pull requests with no external review are excluded
 *     from the latency sample rather than counted as infinitely slow.
 */
export interface ComputeOptions {
  /**
   * False when the caller could not fetch the whole window. Counts stay useful
   * as floors, but a median and a concentration share computed from whichever
   * pull requests happened to sort first are not floors, they are a biased
   * sample, so they are withheld instead of reported with false precision.
   */
  sampleComplete: boolean;
}

export function computeInsights(
  repository: string,
  pullRequests: PullRequestRecord[],
  window: Window,
  options: ComputeOptions = { sampleComplete: true },
): Insights {
  const inWindow = pullRequests.filter((pr) => mergedWithin(pr, window));

  const rows = new Map<string, ContributorRow>();
  const bots = new Set<string>();
  const row = (login: string): ContributorRow => {
    let existing = rows.get(login);
    if (existing === undefined) {
      existing = {
        login,
        pullRequestsAuthored: 0,
        pullRequestsReviewed: 0,
        reviewsSubmitted: 0,
        reviewComments: 0,
      };
      rows.set(login, existing);
    }
    return existing;
  };

  const latencies: number[] = [];
  let botAuthored = 0;
  let unreviewed = 0;
  let reviewsSubmitted = 0;
  const reviewedPullRequestsBy = new Map<string, Set<number>>();

  for (const pr of inWindow) {
    if (pr.author?.isBot === true) {
      bots.add(pr.author.login);
      botAuthored += 1;
      // Everything below measures how the team reviews its own work, so a
      // dependency bump is out of scope for all of it. Skipping here rather
      // than in three places is what keeps the numerator and the denominator
      // of the concentration share over the same set of pull requests.
      continue;
    }
    if (pr.author !== null) row(pr.author.login).pullRequestsAuthored += 1;

    const externalReviewers = new Set<string>();
    for (const review of pr.reviews) {
      if (review.author === null) continue;
      if (review.author.isBot) {
        bots.add(review.author.login);
        continue;
      }
      if (review.author.login === pr.author?.login) continue;

      reviewsSubmitted += 1;
      const reviewer = row(review.author.login);
      reviewer.reviewsSubmitted += 1;
      reviewer.reviewComments += review.commentCount;
      externalReviewers.add(review.author.login);
    }

    for (const reviewer of externalReviewers) {
      row(reviewer).pullRequestsReviewed += 1;
      let seen = reviewedPullRequestsBy.get(reviewer);
      if (seen === undefined) {
        seen = new Set<number>();
        reviewedPullRequestsBy.set(reviewer, seen);
      }
      seen.add(pr.number);
    }

    const firstReview = firstExternalReviewAt(pr);
    if (firstReview === null) {
      unreviewed += 1;
    } else {
      const hours = (firstReview - Date.parse(pr.createdAt)) / MS_PER_HOUR;
      // A review timestamped before the pull request opened is upstream data we
      // do not trust; clamping at zero keeps one bad row from skewing a median.
      latencies.push(Math.max(hours, 0));
    }
  }

  latencies.sort((a, b) => a - b);
  const reviewLatency: LatencySummary | null =
    latencies.length === 0 || !options.sampleComplete
      ? null
      : {
          medianHours: roundTo(median(latencies), 2),
          p90Hours: roundTo(percentile(latencies, 0.9), 2),
          sampleSize: latencies.length,
        };

  const reviewedCount = inWindow.length - botAuthored - unreviewed;
  const reviewConcentration = options.sampleComplete
    ? concentration(reviewedPullRequestsBy, reviewedCount)
    : null;

  const contributors = [...rows.values()].sort(
    (a, b) =>
      b.pullRequestsAuthored + b.pullRequestsReviewed - (a.pullRequestsAuthored + a.pullRequestsReviewed) ||
      a.login.localeCompare(b.login),
  );

  return {
    repository,
    window,
    sampleComplete: options.sampleComplete,
    totals: {
      pullRequestsMerged: inWindow.length,
      pullRequestsAuthoredByBots: botAuthored,
      pullRequestsReviewed: reviewedCount,
      pullRequestsUnreviewed: unreviewed,
      reviewsSubmitted,
      contributors: contributors.length,
      botAccountsExcluded: bots.size,
    },
    contributors,
    reviewLatency,
    reviewConcentration,
  };
}

/**
 * Share of reviewed pull requests that the single busiest reviewer touched.
 * The denominator is reviewed pull requests, not all merged ones, so the number
 * answers "when review happens, how often is it the same person" rather than
 * being dragged down by pull requests nobody reviewed. Ties break on login
 * ascending so the same input always names the same person.
 */
function concentration(
  reviewedBy: Map<string, Set<number>>,
  reviewedCount: number,
): ConcentrationSummary | null {
  if (reviewedCount === 0 || reviewedBy.size === 0) return null;
  const ranked = [...reviewedBy.entries()].sort(
    (a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]),
  );
  const [topReviewer, pullRequests] = ranked[0]!;
  return {
    topReviewer,
    pullRequestsReviewed: pullRequests.size,
    denominator: reviewedCount,
    share: roundTo(pullRequests.size / reviewedCount, 4),
  };
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
