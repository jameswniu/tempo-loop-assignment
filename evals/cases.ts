import type { Insights } from '../src/metrics/types.js';

/**
 * What a good answer looks like for one frozen case. These are deliberately
 * checkable rather than a matter of taste: whether the numbers are grounded,
 * whether the model reached for the metric that actually carries the story,
 * and whether its confidence sits in a defensible band for the evidence.
 */
export interface Expectation {
  /** File in evals/cases, without the extension. */
  name: string;
  /** Why this case is in the suite. */
  premise: string;
  /**
   * Groups of interchangeable metric ids. A correct answer cites at least one
   * from each group.
   *
   * Groups rather than exact ids because several citations say the same thing.
   * Writing "75 of the 78 reviewed" cites the numerator and the denominator and
   * is better prose than quoting a share of 0.9615, so demanding the share
   * specifically fails a correct answer for choosing the clearer phrasing.
   */
  mustCite: string[][];
  /** Inclusive band the hypothesis confidence should land in. */
  confidence: [number, number];
}

export const EXPECTATIONS: Expectation[] = [
  {
    name: 'concentrated-maintainer',
    premise:
      'One maintainer reviews 96% of everything and 48 of 126 merged pull requests get no review at all. The bus factor is the story, and the model should find it.',
    mustCite: [['reviewConcentration.share', 'reviewConcentration.pullRequestsReviewed']],
    // A pattern this lopsided over 126 pull requests supports a confident read.
    confidence: [0.6, 0.95],
  },
  {
    name: 'distributed-review',
    premise:
      'Review is spread across many people, almost nothing merges unreviewed, and the median first review is fast. A correct answer should not manufacture a problem here.',
    mustCite: [['reviewLatency.medianHours', 'reviewLatency.p90Hours']],
    confidence: [0.4, 0.9],
  },
  {
    name: 'mixed-signals',
    premise:
      'A large repository with moderate concentration and a moderate unreviewed count. No single explanation dominates, so confidence should stay mid-range.',
    mustCite: [],
    confidence: [0.3, 0.8],
  },
  {
    name: 'sparse-solo-repo',
    premise:
      'A solo repository. 38 merged, nobody reviews anything, so latency and concentration are both absent. The model should say there is no review activity rather than invent a dynamic, and should not be confident about a team that does not exist.',
    mustCite: [['totals.pullRequestsUnreviewed', 'totals.pullRequestsReviewed']],
    confidence: [0.0, 0.7],
  },
];

export async function loadCase(name: string): Promise<Insights> {
  const url = new URL(`./cases/${name}.json`, import.meta.url);
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(url, 'utf8')) as Insights;
}
