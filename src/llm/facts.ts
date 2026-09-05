import type { Insights } from '../metrics/types.js';

/**
 * One number the model is allowed to cite. The fact set is the contract between
 * the metric layer and the language model: the prompt carries these ids and
 * values, the model may reference nothing else, and grounding is then a
 * dictionary lookup rather than a guess about what a sentence meant.
 */
export interface Fact {
  id: string;
  value: number;
  unit: 'count' | 'hours' | 'share';
  description: string;
}

/** Contributor rows included in the fact set. Bounds the prompt for a repository with hundreds of contributors. */
export const CONTRIBUTOR_FACT_LIMIT = 10;

export function buildFactSet(insights: Insights): Fact[] {
  const facts: Fact[] = [
    fact('totals.pullRequestsMerged', insights.totals.pullRequestsMerged, 'count', 'pull requests merged in the window'),
    fact('totals.pullRequestsReviewed', insights.totals.pullRequestsReviewed, 'count', 'merged pull requests that received at least one review from someone other than the author'),
    fact('totals.pullRequestsUnreviewed', insights.totals.pullRequestsUnreviewed, 'count', 'merged pull requests that received no review from anyone but the author'),
    fact('totals.reviewsSubmitted', insights.totals.reviewsSubmitted, 'count', 'review submissions by people other than the pull request author'),
    fact('totals.contributors', insights.totals.contributors, 'count', 'distinct people who authored or reviewed at least one merged pull request'),
    fact('totals.botAccountsExcluded', insights.totals.botAccountsExcluded, 'count', 'bot accounts dropped from every count'),
  ];

  if (insights.reviewLatency !== null) {
    facts.push(
      fact('reviewLatency.medianHours', insights.reviewLatency.medianHours, 'hours', 'median hours from a pull request opening to its first review by someone else'),
      fact('reviewLatency.p90Hours', insights.reviewLatency.p90Hours, 'hours', 'ninetieth percentile of that same wait'),
      fact('reviewLatency.sampleSize', insights.reviewLatency.sampleSize, 'count', 'pull requests the latency figures are computed over'),
    );
  }

  if (insights.reviewConcentration !== null) {
    facts.push(
      fact('reviewConcentration.share', insights.reviewConcentration.share, 'share', `share of reviewed pull requests touched by ${insights.reviewConcentration.topReviewer}, the busiest reviewer, from 0 to 1`),
      fact('reviewConcentration.pullRequestsReviewed', insights.reviewConcentration.pullRequestsReviewed, 'count', `pull requests reviewed by ${insights.reviewConcentration.topReviewer}`),
      fact('reviewConcentration.denominator', insights.reviewConcentration.denominator, 'count', 'reviewed pull requests, the denominator of the concentration share'),
    );
  }

  for (const row of insights.contributors.slice(0, CONTRIBUTOR_FACT_LIMIT)) {
    facts.push(
      fact(`contributor.${row.login}.pullRequestsAuthored`, row.pullRequestsAuthored, 'count', `merged pull requests authored by ${row.login}`),
      fact(`contributor.${row.login}.pullRequestsReviewed`, row.pullRequestsReviewed, 'count', `merged pull requests reviewed by ${row.login}`),
      fact(`contributor.${row.login}.reviewsSubmitted`, row.reviewsSubmitted, 'count', `review submissions by ${row.login}`),
      fact(`contributor.${row.login}.reviewComments`, row.reviewComments, 'count', `inline diff comments left by ${row.login}`),
    );
  }

  return facts;
}

export function factIndex(facts: Fact[]): Map<string, Fact> {
  return new Map(facts.map((f) => [f.id, f]));
}

/** The fact table exactly as the model sees it. */
export function renderFactSet(facts: Fact[]): string {
  return facts.map((f) => `${f.id} = ${f.value} (${f.unit}) : ${f.description}`).join('\n');
}

function fact(id: string, value: number, unit: Fact['unit'], description: string): Fact {
  return { id, value, unit, description };
}
