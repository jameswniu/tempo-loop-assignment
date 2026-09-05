import { describe, expect, it } from 'vitest';
import { computeInsights, median, mergedWithin, percentile } from '../src/metrics/compute.js';
import { bot, person, pull, review, SAMPLE, WINDOW } from './fixtures.js';

/**
 * These are the tests that matter most in this repository. Every number the API
 * reports comes out of computeInsights, so a fixture with hand-checked
 * expectations is the only thing standing between a refactor and a leaderboard
 * that is quietly wrong.
 */
describe('computeInsights', () => {
  const insights = computeInsights('acme/widgets', SAMPLE, WINDOW);
  const by = (login: string) => insights.contributors.find((c) => c.login === login);

  it('counts every merged pull request in the window, bots included', () => {
    // 1, 2, 3, 4 and 7. Not 5, merged at exactly `to`. Not 6, never merged.
    expect(insights.totals.pullRequestsMerged).toBe(5);
    expect(insights.totals.pullRequestsAuthoredByBots).toBe(1);
  });

  it('treats the window as half open, so `to` belongs to the next period', () => {
    const atUpperBound = SAMPLE.find((p) => p.number === 5)!;
    expect(mergedWithin(atUpperBound, WINDOW)).toBe(false);
    expect(mergedWithin({ ...atUpperBound, mergedAt: '2026-06-30T23:59:59Z' }, WINDOW)).toBe(true);
    expect(mergedWithin({ ...atUpperBound, mergedAt: WINDOW.from }, WINDOW)).toBe(true);
  });

  it('never counts an open pull request', () => {
    expect(mergedWithin(SAMPLE.find((p) => p.number === 6)!, WINDOW)).toBe(false);
  });

  it('separates review submissions from distinct pull requests reviewed', () => {
    // bob reviewed pull 1 twice. That is two submissions on one pull request.
    expect(by('bob')?.reviewsSubmitted).toBe(2);
    expect(by('bob')?.pullRequestsReviewed).toBe(1);
  });

  it('attributes inline comments to the reviewer who left them', () => {
    expect(by('bob')?.reviewComments).toBe(4); // 3 on the first pass, 1 on the second
    expect(by('carol')?.reviewComments).toBe(0);
  });

  it('does not let an author review their own pull request', () => {
    // bob left a 5-comment review on his own pull 2. None of it counts.
    expect(by('bob')?.reviewsSubmitted).toBe(2);
    expect(by('bob')?.reviewComments).toBe(4);
  });

  it('excludes bot accounts from the leaderboard and reports how many', () => {
    expect(insights.contributors.map((c) => c.login)).not.toContain('dependabot');
    expect(insights.totals.botAccountsExcluded).toBe(1);
  });

  it('excludes a review of a bot-authored pull request from every review figure', () => {
    // alice reviewed the dependabot pull. It is not team review activity, so it
    // counts nowhere, which is what keeps the concentration share at most 1.
    expect(by('alice')?.reviewsSubmitted).toBe(1);
    expect(by('alice')?.pullRequestsReviewed).toBe(1);
  });

  it('counts a pull request with no external review as unreviewed', () => {
    expect(insights.totals.pullRequestsUnreviewed).toBe(1); // pull 3
    expect(insights.totals.pullRequestsReviewed).toBe(3); // pulls 1, 2 and 7
  });

  it('reconciles: reviewed plus unreviewed plus bot-authored equals merged', () => {
    const { pullRequestsReviewed, pullRequestsUnreviewed, pullRequestsAuthoredByBots, pullRequestsMerged } =
      insights.totals;
    expect(pullRequestsReviewed + pullRequestsUnreviewed + pullRequestsAuthoredByBots).toBe(pullRequestsMerged);
  });

  it('measures latency to the first review by somebody other than the author', () => {
    // pull 1 waited 2h, pull 2 waited 9h (bob's self-review at 1h does not
    // stop the clock), pull 7 waited 4h. Pull 3 is excluded, not counted slow.
    expect(insights.reviewLatency).toEqual({ medianHours: 4, p90Hours: 9, sampleSize: 3 });
  });

  it('divides concentration by reviewed pull requests and breaks ties on login', () => {
    // Four people reviewed one pull request each, so the tie resolves to alice.
    expect(insights.reviewConcentration).toEqual({
      topReviewer: 'alice',
      pullRequestsReviewed: 1,
      denominator: 3,
      share: 0.3333,
    });
  });

  it('ranks contributors by authored plus reviewed, then by login', () => {
    expect(insights.contributors.map((c) => c.login)).toEqual(['alice', 'bob', 'carol', 'dave', 'erin']);
  });

  /**
   * A capped sample still supports counts, read as floors. It does not support
   * a median or a share: those would be computed from whichever pull requests
   * happened to sort first, which is a biased slice wearing false precision.
   */
  it('withholds the derived statistics when the sample was capped', () => {
    const capped = computeInsights('acme/widgets', SAMPLE, WINDOW, { sampleComplete: false });
    expect(capped.sampleComplete).toBe(false);
    expect(capped.reviewLatency).toBeNull();
    expect(capped.reviewConcentration).toBeNull();
    // The counts survive, because a floor is still a true statement.
    expect(capped.totals.pullRequestsMerged).toBe(5);
    expect(capped.contributors.length).toBe(5);
  });

  it('reports a complete sample as complete', () => {
    expect(insights.sampleComplete).toBe(true);
  });

  it('survives a window with nothing in it', () => {
    const empty = computeInsights('acme/widgets', SAMPLE, {
      from: '2020-01-01T00:00:00Z',
      to: '2020-02-01T00:00:00Z',
    });
    expect(empty.totals.pullRequestsMerged).toBe(0);
    expect(empty.reviewLatency).toBeNull();
    expect(empty.reviewConcentration).toBeNull();
    expect(empty.contributors).toEqual([]);
  });

  it('survives a deleted account on both the author and the reviewer side', () => {
    const orphaned = computeInsights(
      'acme/widgets',
      [pull(9, null, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', [review(null, '2026-06-01T01:00:00Z')])],
      WINDOW,
    );
    expect(orphaned.totals.pullRequestsMerged).toBe(1);
    expect(orphaned.totals.pullRequestsUnreviewed).toBe(1);
    expect(orphaned.contributors).toEqual([]);
  });

  it('clamps a review timestamped before its own pull request rather than reporting negative time', () => {
    const skewed = computeInsights(
      'acme/widgets',
      [pull(10, person('alice'), '2026-06-10T00:00:00Z', '2026-06-11T00:00:00Z', [
        review(person('bob'), '2026-06-09T00:00:00Z'),
      ])],
      WINDOW,
    );
    expect(skewed.reviewLatency?.medianHours).toBe(0);
  });

  it('keeps the concentration share at or below 1 however lopsided the data', () => {
    // One reviewer on every human pull request, plus a pile of bot pull requests
    // they also reviewed. This is the shape that produced a share above 1 before
    // the bot skip and the denominator were made to agree.
    const pulls = [
      pull(20, person('alice'), '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', [review(person('bob'), '2026-06-01T01:00:00Z')]),
      ...Array.from({ length: 10 }, (_, i) =>
        pull(30 + i, bot('dependabot'), '2026-06-03T00:00:00Z', '2026-06-04T00:00:00Z', [
          review(person('bob'), '2026-06-03T01:00:00Z'),
        ]),
      ),
    ];
    const lopsided = computeInsights('acme/widgets', pulls, WINDOW);
    expect(lopsided.reviewConcentration?.share).toBe(1);
    expect(lopsided.reviewConcentration!.pullRequestsReviewed).toBeLessThanOrEqual(
      lopsided.reviewConcentration!.denominator,
    );
  });
});

describe('percentile and median', () => {
  it('takes the nearest rank, so p90 is always an observed value', () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sample, 0.9)).toBe(9); // ceil(0.9 * 10) = 9, index 8
    expect(percentile(sample, 1)).toBe(10);
    expect(percentile([42], 0.9)).toBe(42);
  });

  it('averages the middle pair for an even sample, which is the one interpolated value', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('refuses an empty sample rather than returning a misleading zero', () => {
    expect(() => median([])).toThrow(RangeError);
    expect(() => percentile([], 0.5)).toThrow(RangeError);
  });
});
