# Referee cards

One card for every number this repository states about the world. Each was written from the code
that produces it, not from the prose that quotes it, and every card names the command that
regenerates its number. A claim no command can reproduce does not belong on a page a stranger
reads.

Both worked repositories are frozen in `evals/cases/raw`, captured Sat 5 September 2026 for the
window 2026-06-01 up to but not including 2026-09-01, so these numbers stay checkable after the
repositories move on. `npx tsx tools/verify-claims.ts` recomputes all of them at once. Line
numbers are at the commit that added this file.

## Mismatches

None outstanding. Two were found and fixed while writing these cards.

NOTES.md said excluding bots changed fastify's top reviewer share by three percentage points. It is
five. The number had been typed from memory rather than read from a run, which is the exact thing
these cards exist to catch.

Four of the NOTES.md line references in the first draft of these cards pointed at the wrong lines,
found by reading each one back. Every reference below has now been checked against the file.

## Cards

```
Claim     "one maintainer reviewed 96% of everything" (NOTES.md line 48, and the metric section of README.md)
Unit      share of REVIEWED pull requests that yusukebe reviewed, so the denominator is the 78 human-authored pull requests that got at least one review from somebody other than their author, not the 126 merged
Match     a person counts as having reviewed a pull request when they submitted at least one review on it, they are not its author, and neither they nor the author is a bot account (compute.ts line 154 drops the self-review, line 136 drops the whole pull request when a bot opened it), and each pull request counts once for that person no matter how many times they reviewed it
Set       126 pull requests merged into honojs/hono in the window, 0 of them opened by a bot, 48 with no outside review at all, 1 bot account seen and excluded, and the reviews come from the first 100 per pull request plus any further pages fetched (client.ts line 169), which no pull request in this set needed
Command   npx tsx tools/verify-claims.ts, which reads evals/cases/raw/honojs-hono.json and calls concentration() at compute.ts line 231
Sibling   fastify/fastify over the same window is 47% on the same measure, 52 of 110, and that gap between two healthy open source projects is the entire reason this metric is the one on the page
Bound     one window of one repository says nothing about a trend, 75 of 78 is a wide interval on a small denominator, and the 48 unreviewed pull requests are excluded from this ratio entirely so the share describes review when review happens rather than how often it happens
Knob      whether unreviewed pull requests join the denominator, at which case the same reviewer reads as 75 of 126, or 60%
```

```
Claim     "48 of 126 pull requests merged with no outside review" (NOTES.md lines 48 and 49)
Unit      human-authored pull requests merged in the window where nobody but the author submitted a review, over every pull request merged in the window including bot-authored ones
Match     a pull request is unreviewed when firstExternalReviewAt returns null (compute.ts line 65), meaning it carries no review from a non-bot account that is not its author, and a review by the author never counts however substantial it is
Set       the same 126 merged pull requests, and because hono had 0 bot-authored pull requests in this window the two denominators coincide here, which they do not on fastify
Command   npx tsx tools/verify-claims.ts, totals.pullRequestsUnreviewed against totals.pullRequestsMerged
Sibling   fastify/fastify is 1 unreviewed against 131 merged over the same three months, and 1 of 110 once its 20 bot-authored pull requests come out
Bound     a merge is not the same as an approval, so a pull request reviewed in Slack or in person and merged without a GitHub review lands in this count, and that is a real limit of measuring collaboration through one API
Knob      whether a review by the author counts, which would move hono from 48 unreviewed to fewer, since self-review is common on a solo-maintained repository
```

```
Claim     "the median first review lands in about eight hours" for fastify (NOTES.md line 51), 8.36 hours exactly
Unit      hours from a pull request opening to the first review submitted on it by somebody other than its author, as a median over the 110 human-authored pull requests that received such a review
Match     the clock starts at createdAt and stops at the earliest submittedAt among reviews by non-bot accounts that are not the author (compute.ts line 65), a review timestamped before its own pull request is clamped to zero rather than counted negative (line 180), and a pull request with no outside review is excluded from the sample rather than counted as infinitely slow
Set       110 of fastify's 131 merged pull requests, after removing 20 bot-authored ones and 1 that nobody reviewed, over 2026-06-01 to 2026-09-01
Command   npx tsx tools/verify-claims.ts, reviewLatency.medianHours, computed by median() at compute.ts line 52
Sibling   the p90 on the same set is 121.08 hours, so the slowest tenth waits more than five days while the middle waits eight hours, and honojs/hono's median over its own set is 37.19 hours
Bound     the median is the mean of the two middle values on an even sample, which is the one reported figure that is not itself an observed wait, and none of this distinguishes a pull request that sat unread from one that was not ready to read
Knob      excluding unreviewed pull requests from the sample, since counting them at any finite penalty would move both the median and the p90 upward on hono far more than on fastify
```

```
Claim     "counting them understated the top reviewer's share by five points, 0.4231 against 0.4727" (NOTES.md line 91)
Unit      the difference in percentage points between two runs of the same concentration metric over the same 132 fetched pull requests, one treating every bot account as a person and one excluding them
Match     the two runs differ only in Actor.isBot, which the client sets from GraphQL's __typename rather than from the login text, and the naive run is reproduced by relabelling every actor isBot false, which is exactly the state the code was in before that field was read
Set       fastify/fastify, 131 merged in the window of 132 fetched, 20 opened by bots, 3 distinct bot accounts seen, with the naive run giving 55 of 130 and the corrected run 52 of 110
Command   npx tsx tools/verify-claims.ts, the section headed "What excluding bots changes"
Sibling   the same correction moves the contributor count from 56 to 53, and on honojs/hono it moves nothing at all on the author side because that repository had no bot-authored pull requests in this window, only a bot reviewer
Bound     one repository over one quarter, and the size of this effect is entirely a function of how much dependency automation a project runs, so it is an illustration that the bug mattered and not an estimate of how much it matters anywhere else
Knob      reading bot status from the login suffix instead of the account type, which is what GraphQL defeats by returning dependabot and github-actions with no marker in the name
```

```
Claim     "REST would be a list call plus a reviews call and a comments call per pull request, roughly 1 + 2N requests. GraphQL is N/50" (NOTES.md line 65)
Unit      upstream HTTP requests to fetch one window, where N is the number of merged pull requests in it
Match     the GraphQL figure is arithmetic on the page size, PAGE_SIZE 50 at client.ts line 28, so 131 pull requests are 3 requests plus one extra per pull request carrying more than 100 reviews, of which this set had none. The REST figure is the shape of the equivalent call, one search page plus pulls.listReviews and pulls.listReviewComments per pull request, and it is not measured because that path was never built
Set       not a measurement. An argument for the design, stated as a count of requests rather than as a latency
Command   the GraphQL half is checkable, the constant is at client.ts line 28 and the fetch loop at line 118. The REST half is a claim about code that does not exist in this repository
Sibling   GitHub's GraphQL budget is points rather than requests, and a query that pages 132 pull requests with their reviews cost 3 points of a 5000 hourly budget in the runs behind these cards, which is the number that actually governs whether this design holds
Bound     it says nothing about wall clock, which measured about 2 to 3 seconds for a 131 pull request window and is dominated by round trips rather than by their count
Knob      PAGE_SIZE at client.ts line 28, and the review page size of 100, past which a second query per pull request is needed
```

```
Claim     "GitHub search returns at most 1000 results" (NOTES.md line 100, and the reason sampleComplete exists)
Unit      the maximum result count GitHub's search API will return for one query, and the point past which this service withholds its derived statistics
Match     SEARCH_RESULT_CAP at client.ts line 27, compared against the issueCount the search itself reports, so truncation is detected from the upstream count and not inferred from how many pages came back
Set       a documented platform limit, not a measurement of this repository. Neither frozen case comes near it: fastify fetched 132 and hono 126
Command   the constant is at client.ts line 27 and its effect is asserted by the capped-sample test in test/metrics.test.ts. No run in this repository has actually reached the cap
Sibling   the 366 day window cap at routes/params.ts is the other guard on the same problem, and it is a blunt one, since a busy monorepo can exceed 1000 merges in a month while a quiet repository never will in a year
Bound     UNVERIFIED against a live truncating query. The behaviour on truncation is tested against a fixture that sets the flag, not against a real repository large enough to trip it, and that is the weakest evidence behind any card here
Knob      the window length, since the only remedy in this version is to ask for less time at once, and splitting the window and recursing is the first thing listed under what I would do next
```

```
Claim     "npm test runs 113 tests" (NOTES.md line 35)
Unit      test cases that pass in the vitest suite, across 5 files, counting each case generated by it.each separately
Match     a passing assertion block as vitest counts it, which is the tests total in its own summary line
Command   npm test
Sibling   these are unit and route-level tests only. There is no test that calls GitHub, and the model is exercised only through stubs, so the entire upstream boundary is covered by the frozen fixtures rather than by the suite
Bound     a count of tests is not a measure of coverage and no coverage figure is claimed anywhere in this repository. The number is here because NOTES.md states it, and a stated number needs a card
Knob      adding or removing a case in the it.each blocks, which move the count by several at a time
```
