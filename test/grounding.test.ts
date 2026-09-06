import { describe, expect, it } from 'vitest';
import { buildFactSet, factIndex } from '../src/llm/facts.js';
import { buildReport, groundEvidence, scanNarrativeNumbers } from '../src/llm/grounding.js';
import { computeInsights } from '../src/metrics/compute.js';
import { SAMPLE, WINDOW } from './fixtures.js';

/**
 * The grounding checks are what make the narrative endpoint safe to put in
 * front of somebody. Without them the endpoint is a model asserting numbers
 * nobody verified, which is the failure mode the whole design is arranged
 * against, so these tests carry as much weight as the metric ones.
 */
const insights = computeInsights('acme/widgets', SAMPLE, WINDOW);
const allFacts = buildFactSet(insights);
const facts = factIndex(allFacts);

/** The prose scan checks against the facts the model cited, so tests name them. */
const cited = (...ids: string[]) => ids.map((id) => facts.get(id)!);
const everyFact = allFacts;

describe('groundEvidence', () => {
  it('accepts a citation whose id and value both match', () => {
    const [item] = groundEvidence(
      [{ claim: 'five merged', metric: 'totals.pullRequestsMerged', value: 5 }],
      facts,
    );
    expect(item?.grounded).toBe(true);
    expect(item?.actualValue).toBe(5);
    expect(item?.unit).toBe('count');
  });

  it('rejects a metric id that does not exist', () => {
    const [item] = groundEvidence(
      [{ claim: 'invented', metric: 'totals.velocityScore', value: 42 }],
      facts,
    );
    expect(item?.grounded).toBe(false);
    expect(item?.actualValue).toBeNull();
    expect(item?.problem).toContain('no metric called');
  });

  it('rejects a real metric quoted at the wrong value, and says what it should be', () => {
    const [item] = groundEvidence(
      [{ claim: 'overstated', metric: 'totals.pullRequestsMerged', value: 50 }],
      facts,
    );
    expect(item?.grounded).toBe(false);
    expect(item?.actualValue).toBe(5);
    expect(item?.problem).toBe('cited 50 but totals.pullRequestsMerged is 5');
  });

  it('tolerates the tiny error a JSON round trip introduces', () => {
    const share = insights.reviewConcentration!.share;
    const [item] = groundEvidence(
      [{ claim: 'share', metric: 'reviewConcentration.share', value: share + 1e-13 }],
      facts,
    );
    expect(item?.grounded).toBe(true);
  });
});

describe('scanNarrativeNumbers', () => {
  it('passes prose that only restates values the model cited', () => {
    const prose = 'Five pull requests merged, and 3 of them were reviewed by someone else.';
    const scan = scanNarrativeNumbers(
      prose,
      cited('totals.pullRequestsMerged', 'totals.pullRequestsReviewed'),
      everyFact,
      WINDOW,
    );
    expect(scan.fabricated).toEqual([]);
    expect(scan.uncited).toEqual([]);
  });

  /**
   * A number matching an uncited metric is recorded rather than accepted
   * silently. It is not called a fabrication, because the figure does exist in
   * the computed metrics and refusing the whole answer over it would be
   * disproportionate, but it does not pass unremarked either.
   */
  it('records a number vouched for only by a metric the model did not cite', () => {
    // totals.pullRequestsReviewed is 3, but the model only cited the merged count.
    const scan = scanNarrativeNumbers(
      'There were 3 rollbacks.',
      cited('totals.pullRequestsMerged'),
      everyFact,
      WINDOW,
    );
    expect(scan.fabricated).toEqual([]);
    expect(scan.uncited).toEqual([3]);
  });

  it('passes a share written as a percentage', () => {
    // reviewConcentration.share is 0.3333, so 33 and 33.33 are both legitimate.
    expect(scanNarrativeNumbers('The top reviewer saw 33% of them.', cited('reviewConcentration.share'), everyFact, WINDOW).fabricated).toEqual([]);
    expect(scanNarrativeNumbers('Closer to 33.33 percent.', cited('reviewConcentration.share'), everyFact, WINDOW).fabricated).toEqual([]);
  });

  /**
   * The sharpest hole this scan had. A share of 0.3333 made the bare number 33
   * acceptable anywhere, so a fabricated count wearing that value passed clean.
   */
  it('does not let a share authorise the same number as a bare count', () => {
    expect(scanNarrativeNumbers('The team shipped 33 pull requests.', cited('reviewConcentration.share'), everyFact, WINDOW).fabricated).toEqual([33]);
  });

  it('allows a whole date but not its parts loose in the prose', () => {
    expect(scanNarrativeNumbers('Between 2026-06-01 and 2026-07-01 things were steady.', everyFact, everyFact, WINDOW).fabricated).toEqual([]);
    // 6 and 7 are the window months. Loose in a sentence they are just numbers.
    expect(scanNarrativeNumbers('There were 6 incidents and 7 rollbacks.', everyFact, everyFact, WINDOW).fabricated).toEqual([6, 7]);
  });

  it('allows the year the window falls in, which the narrative naturally names', () => {
    expect(scanNarrativeNumbers('Through 2026 the team kept a steady pace.', everyFact, everyFact, WINDOW).fabricated).toEqual([]);
  });

  it('passes a value rounded for readability', () => {
    // reviewLatency.p90Hours is 9, medianHours is 4.
    expect(scanNarrativeNumbers('The slowest tenth waited about 9 hours.', cited('reviewLatency.p90Hours'), everyFact, WINDOW).fabricated).toEqual([]);
  });

  it('does not let a count authorise its own hundredfold', () => {
    // totals.pullRequestsMerged is 5. Percentage scaling is for shares only, so
    // prose claiming 500 must not pass just because 5 is a real number.
    expect(scanNarrativeNumbers('The team shipped 500 pull requests.', everyFact, everyFact, WINDOW).fabricated).toEqual([500]);
  });

  it('reads a grouped numeral whole rather than as separate digit runs', () => {
    // Split on the comma this reads as 1 and 000, both harmless, and the
    // invented figure passes.
    expect(scanNarrativeNumbers('They merged 1,000 pull requests.', everyFact, everyFact, WINDOW).fabricated).toEqual([1000]);
  });

  /**
   * The username guard must not become a blanket exemption. These compact forms
   * are ordinary prose, and a fabricated figure wearing one would otherwise
   * never be checked.
   */
  it.each([
    ['a 90-day window', 90],
    ['waits of 24h or more', 24],
    ['a 2x increase', 2],
    ['a 3-person team', 3],
  ])('still examines the number in %s', (prose, expected) => {
    // Which list it lands in depends on whether the value exists in the
    // metrics. What matters here is that it is examined rather than skipped.
    const scan = scanNarrativeNumbers(prose, [], everyFact, WINDOW);
    expect([...scan.fabricated, ...scan.uncited]).toContain(expected);
  });

  it('still ignores digits inside a login', () => {
    // ababove20-jpg is a real contributor in the fixture.
    const scan = scanNarrativeNumbers('ababove20-jpg reviewed some.', [], everyFact, WINDOW);
    expect(scan.fabricated).toEqual([]);
    expect(scan.uncited).toEqual([]);
  });

  it('reads a number written as a word, which a digit-only scan waves through', () => {
    expect(scanNarrativeNumbers('There were seven rollbacks.', everyFact, everyFact, WINDOW).fabricated).toEqual([7]);
    expect(scanNarrativeNumbers('Twelve people were on call.', everyFact, everyFact, WINDOW).fabricated).toEqual([12]);
  });

  it('accepts a cited value written as a word', () => {
    // totals.pullRequestsMerged is 5.
    expect(
      scanNarrativeNumbers('Five pull requests merged.', cited('totals.pullRequestsMerged'), everyFact, WINDOW)
        .fabricated,
    ).toEqual([]);
  });

  it('flags a number that matches nothing computed', () => {
    const prose = 'Throughput rose 47% against the previous quarter.';
    expect(scanNarrativeNumbers(prose, everyFact, everyFact, WINDOW).fabricated).toEqual([47]);
  });

  it('allows the window dates the narrative names', () => {
    expect(scanNarrativeNumbers('Between 2026-06-01 and 2026-07-01 the team shipped steadily.', everyFact, everyFact, WINDOW).fabricated).toEqual([]);
  });

  /**
   * The two tiers. A figure the model mentioned without recording is real and
   * only untidy. A figure that matches nothing computed is made up. Treating
   * them the same throws away sound answers over bookkeeping.
   */
  it('separates a real figure the model forgot to cite from a fabricated one', () => {
    // totals.pullRequestsReviewed is 3 and is real. 47 is not a computed value.
    const scan = scanNarrativeNumbers(
      'It reviewed 3 of them, and throughput rose 47%.',
      cited('totals.pullRequestsMerged'),
      everyFact,
      WINDOW,
    );
    expect(scan.uncited).toEqual([3]);
    expect(scan.fabricated).toEqual([47]);
  });

  it('reports each unmatched number once', () => {
    expect(scanNarrativeNumbers('Up 47%, and 47% again, and 61% elsewhere.', everyFact, everyFact, WINDOW).fabricated).toEqual([47, 61]);
  });
});

describe('buildReport', () => {
  it('scores the fraction of evidence that checks out', () => {
    const evidence = groundEvidence(
      [
        { claim: 'ok', metric: 'totals.pullRequestsMerged', value: 5 },
        { claim: 'bad', metric: 'totals.pullRequestsMerged', value: 9 },
      ],
      facts,
    );
    const report = buildReport(evidence, { fabricated: [], uncited: [] });
    expect(report).toEqual({
      score: 0.5,
      evidenceTotal: 2,
      evidenceGrounded: 1,
      unverifiedNumbersInNarrative: [],
      uncitedNumbersInNarrative: [],
    });
  });

  it('reports a null score rather than a perfect one when there is no evidence', () => {
    expect(buildReport([], { fabricated: [], uncited: [] }).score).toBeNull();
  });
});

describe('buildFactSet', () => {
  it('exposes every number the API reports so the model can cite all of them', () => {
    const ids = new Set(buildFactSet(insights).map((f) => f.id));
    for (const id of [
      'totals.pullRequestsMerged',
      'totals.pullRequestsUnreviewed',
      'reviewLatency.medianHours',
      'reviewLatency.p90Hours',
      'reviewConcentration.share',
      'contributor.alice.pullRequestsAuthored',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('omits latency and concentration facts when the window produced neither', () => {
    const empty = computeInsights('acme/widgets', [], WINDOW);
    const ids = buildFactSet(empty).map((f) => f.id);
    expect(ids.some((id) => id.startsWith('reviewLatency'))).toBe(false);
    expect(ids.some((id) => id.startsWith('reviewConcentration'))).toBe(false);
  });
});
