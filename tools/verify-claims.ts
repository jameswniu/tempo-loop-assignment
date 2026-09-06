import { readFileSync } from 'node:fs';
import { computeInsights } from '../src/metrics/compute.js';
import type { Insights, PullRequestRecord, Window } from '../src/metrics/types.js';

/**
 * Recomputes every number the README and NOTES.md state about a real
 * repository, from payloads frozen in evals/cases/raw. A claim in the
 * documentation that this cannot reproduce is a claim that comes out.
 *
 *   npx tsx tools/verify-claims.ts
 */

interface Frozen {
  window: Window;
  pullRequests: PullRequestRecord[];
  truncated: boolean;
}

function load(slug: string): Frozen {
  return JSON.parse(readFileSync(`evals/cases/raw/${slug}.json`, 'utf8')) as Frozen;
}

function line(claim: string, actual: string): void {
  console.log(`  ${claim.padEnd(56)} ${actual}`);
}

const hono = load('honojs-hono');
const fastify = load('fastify-fastify');
const honoInsights = computeInsights('honojs/hono', hono.pullRequests, hono.window);
const fastifyInsights = computeInsights('fastify/fastify', fastify.pullRequests, fastify.window);

console.log('\nWindow for both: 2026-06-01 up to but not including 2026-09-01\n');

console.log('honojs/hono, the concentrated case');
line('top reviewer share', `${Math.round(honoInsights.reviewConcentration!.share * 100)}%`);
line(
  'merged with no outside review',
  `${honoInsights.totals.pullRequestsUnreviewed} of ${honoInsights.totals.pullRequestsMerged}`,
);
line('median hours to first outside review', `${honoInsights.reviewLatency!.medianHours}`);

console.log('\nfastify/fastify, the distributed case');
line('top reviewer share', `${Math.round(fastifyInsights.reviewConcentration!.share * 100)}%`);
line('merged with no outside review', `${fastifyInsights.totals.pullRequestsUnreviewed}`);
line('median hours to first outside review', `${fastifyInsights.reviewLatency!.medianHours}`);
line('bot-authored pull requests', `${fastifyInsights.totals.pullRequestsAuthoredByBots}`);

/**
 * The claim that counting bot pull requests understates the top reviewer's
 * share. Recomputed by relabelling every bot as a person, which is exactly the
 * state the code was in before the account type was read from __typename.
 */
const asIfBotsWerePeople = (records: PullRequestRecord[]): PullRequestRecord[] =>
  records.map((pr) => ({
    ...pr,
    author: pr.author === null ? null : { ...pr.author, isBot: false },
    reviews: pr.reviews.map((r) => ({
      ...r,
      author: r.author === null ? null : { ...r.author, isBot: false },
    })),
  }));

const naive = computeInsights('fastify/fastify', asIfBotsWerePeople(fastify.pullRequests), fastify.window);
const withBots = naive.reviewConcentration!;
const withoutBots = fastifyInsights.reviewConcentration!;
const deltaPoints = Math.round((withoutBots.share - withBots.share) * 100);

console.log('\nWhat excluding bots changes, on fastify/fastify');
line('share with bots counted as people', `${withBots.share} (${withBots.pullRequestsReviewed}/${withBots.denominator})`);
line('share with bots excluded', `${withoutBots.share} (${withoutBots.pullRequestsReviewed}/${withoutBots.denominator})`);
line('difference in percentage points', `${deltaPoints}`);
line('contributors counted as people', `${naive.totals.contributors} against ${fastifyInsights.totals.contributors}`);

const identity = (i: Insights): boolean =>
  i.totals.pullRequestsReviewed + i.totals.pullRequestsUnreviewed + i.totals.pullRequestsAuthoredByBots ===
  i.totals.pullRequestsMerged;

console.log('\nInvariants');
line('hono: reviewed + unreviewed + bot-authored = merged', identity(honoInsights) ? 'holds' : 'BROKEN');
line('fastify: reviewed + unreviewed + bot-authored = merged', identity(fastifyInsights) ? 'holds' : 'BROKEN');
line(
  'no contributor reviewed more than the denominator',
  Math.max(...fastifyInsights.contributors.map((c) => c.pullRequestsReviewed)) <= withoutBots.denominator
    ? 'holds'
    : 'BROKEN',
);
console.log('');
