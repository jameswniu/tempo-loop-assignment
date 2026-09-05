/**
 * Normalised shapes the metric layer consumes. Keeping these free of GitHub's
 * wire format is what lets computeInsights stay a pure function, and what makes
 * a second integration a matter of writing one more mapper.
 */

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

/**
 * A GitHub account. `isBot` comes from the account type the API reports, not
 * from the shape of the login: GraphQL returns `github-actions` and
 * `dependabot` with no marker in the name and `__typename: "Bot"` beside it,
 * so a name-based check silently lets automation into a leaderboard.
 */
export interface Actor {
  login: string;
  isBot: boolean;
}

export interface ReviewRecord {
  /** The reviewer, or null when the account has been deleted. */
  author: Actor | null;
  /** ISO 8601 instant the review was submitted. */
  submittedAt: string;
  state: ReviewState;
  /** Inline comments left on the diff as part of this review submission. */
  commentCount: number;
}

export interface PullRequestRecord {
  number: number;
  title: string;
  author: Actor | null;
  createdAt: string;
  mergedAt: string | null;
  reviews: ReviewRecord[];
}

export interface Window {
  /** Inclusive lower bound, ISO 8601. */
  from: string;
  /** Exclusive upper bound, ISO 8601. */
  to: string;
}

export interface ContributorRow {
  login: string;
  pullRequestsAuthored: number;
  /** Distinct merged pull requests this person reviewed, excluding their own. */
  pullRequestsReviewed: number;
  /** Every review submission, so two passes on one pull request count twice. */
  reviewsSubmitted: number;
  /** Inline diff comments this person left across all their reviews. */
  reviewComments: number;
}

export interface LatencySummary {
  medianHours: number;
  p90Hours: number;
  /** Merged pull requests that received a non-author review, the latency denominator. */
  sampleSize: number;
}

export interface ConcentrationSummary {
  topReviewer: string;
  /** Reviewed pull requests this person touched. */
  pullRequestsReviewed: number;
  /** Merged pull requests that received at least one non-author review. */
  denominator: number;
  /** pullRequestsReviewed divided by denominator, 0 to 1. */
  share: number;
}

export interface Insights {
  repository: string;
  window: Window;
  /**
   * False when the upstream result cap was reached. Counts are then floors, and
   * the derived statistics are withheld rather than reported from a biased slice.
   */
  sampleComplete: boolean;
  totals: {
    /** Every pull request merged in the window, bots included, so this reconciles with GitHub search. */
    pullRequestsMerged: number;
    /** Of those, the ones a bot opened. Reviewed + unreviewed + this equals merged. */
    pullRequestsAuthoredByBots: number;
    /** Human-authored pull requests with at least one review by another person. */
    pullRequestsReviewed: number;
    /** Human-authored pull requests nobody but the author reviewed. */
    pullRequestsUnreviewed: number;
    reviewsSubmitted: number;
    contributors: number;
    botAccountsExcluded: number;
  };
  contributors: ContributorRow[];
  /** Null when the window produced no reviewed pull request, or the sample was capped. */
  reviewLatency: LatencySummary | null;
  /** Null when the window produced no reviewed pull request, or the sample was capped. */
  reviewConcentration: ConcentrationSummary | null;
}
