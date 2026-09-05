import type { Actor, PullRequestRecord, ReviewRecord, ReviewState } from '../src/metrics/types.js';

export const WINDOW = { from: '2026-06-01T00:00:00Z', to: '2026-07-01T00:00:00Z' };

export const person = (login: string): Actor => ({ login, isBot: false });
export const bot = (login: string): Actor => ({ login, isBot: true });

export function review(
  author: Actor | null,
  submittedAt: string,
  commentCount = 0,
  state: ReviewState = 'APPROVED',
): ReviewRecord {
  return { author, submittedAt, commentCount, state };
}

export function pull(
  number: number,
  author: Actor | null,
  createdAt: string,
  mergedAt: string | null,
  reviews: ReviewRecord[] = [],
): PullRequestRecord {
  return { number, title: `pull ${number}`, author, createdAt, mergedAt, reviews };
}

/**
 * One fixture exercising every counting rule at once: the half-open window
 * boundary, an unmerged pull request, a bot author, a self-review, two review
 * submissions on one pull request, and a pull request nobody reviewed.
 */
export const SAMPLE: PullRequestRecord[] = [
  pull(1, person('alice'), '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', [
    review(person('bob'), '2026-06-01T02:00:00Z', 3, 'COMMENTED'),
    review(person('carol'), '2026-06-01T03:00:00Z', 0),
    review(person('bob'), '2026-06-01T05:00:00Z', 1),
  ]),
  pull(2, person('bob'), '2026-06-05T00:00:00Z', '2026-06-06T00:00:00Z', [
    review(person('bob'), '2026-06-05T01:00:00Z', 5),
    review(person('alice'), '2026-06-05T09:00:00Z', 2),
  ]),
  pull(3, person('alice'), '2026-06-10T00:00:00Z', '2026-06-11T00:00:00Z', []),
  pull(4, bot('dependabot'), '2026-06-12T00:00:00Z', '2026-06-13T00:00:00Z', [
    review(person('alice'), '2026-06-12T01:00:00Z', 2),
  ]),
  // Merged at exactly `to`. A half-open window puts this in the next period.
  pull(5, person('alice'), '2026-06-20T00:00:00Z', '2026-07-01T00:00:00Z'),
  // Never merged.
  pull(6, person('alice'), '2026-06-25T00:00:00Z', null),
  pull(7, person('dave'), '2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z', [
    review(person('erin'), '2026-06-15T04:00:00Z', 0),
  ]),
];
