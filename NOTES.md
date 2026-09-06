# Notes

## How to run it

You need a GitHub token. A classic personal access token with no scopes ticked is enough, because
this service only reads public repositories, and it lifts the rate limit from 60 requests an hour
to 5000. For the narrative endpoint you also need an Anthropic key.

```bash
cp .env.example .env
# GITHUB_TOKEN=ghp_...
# ANTHROPIC_API_KEY=sk-ant-...     optional, the metrics endpoint works without it
npm install
npm run dev
```

```bash
curl 'localhost:8080/v1/insights?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
curl 'localhost:8080/v1/insights/narrative?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
```

Everything in one container, API and web page on http://localhost:8080

```bash
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... docker compose up
```

The web page in development, where Vite serves it on 5173 and proxies the API:

```bash
npm run dev
cd frontend && npm install && npm run dev
```

`npm test` runs 128 tests. `npm run eval` runs the model evaluation suite, described below. Node 22
or later, which the lockfile requires.

## The metric, and why this one

Contributor counts by commits are easy to compute and say very little. What a team actually wants
to know is whether review is a shared habit or one person's job, so the window is the pull requests
merged in `[from, to)` and three figures carry the story.

How many merged pull requests nobody but the author looked at. How long a pull request waits for
its first review by someone else, as a median and a p90. What share of the reviewed pull requests
the single busiest reviewer touched.

Run that over `honojs/hono` for the summer and one maintainer reviewed 96% of everything while 48
of 126 pull requests merged with no outside review at all. Run it over `fastify/fastify` for the
same window and the busiest reviewer is at 47%, one pull request went unreviewed, and the median
first review lands in about eight hours. Same three numbers, two completely different working
cultures, which is the point.

## Architecture

Four layers, each of which can be understood without the others. A GitHub client fetches merged
pull requests and their reviews. A pure function turns those into metrics. A service ties fetch,
cache and compute together. Fastify exposes two endpoints.

`computeInsights` takes pull requests and a window and returns numbers. No network, no clock, no
database. That is what lets a fixture with hand-checked expectations pin every counting rule, and
those tests are the ones I would keep if I could keep only one file.

The fetch is one paginated GraphQL query rather than REST. REST would be a list call plus a reviews
call and a comments call per pull request, roughly 1 + 2N requests against a 5000 an hour budget.
GraphQL is N/50, and the `merged:` search qualifier does the window filtering upstream so nothing
is downloaded and then discarded. Responses are cached in SQLite keyed on the exact query, which
needs no extra service for a reviewer to start.

The narrative endpoint is the part I would talk about first. The model never sees raw JSON. It gets
a flat fact table, one line per number, each with an id, a value, a unit and a plain description,
and it is told it may cite nothing else. The answer comes back as structured output through a
forced tool call, and then the service checks the model's own work: every evidence item's metric id
is looked up and its value compared exactly, and every number appearing anywhere in the model's
prose must have a counterpart among the facts it actually cited. If either check fails the request
is retried once and then returns 502 with the mismatch attached.

That last decision changed during the build. The first version returned 200 with the failures noted
in a metadata block, which felt honest. It is not. Any client that renders the narrative and
ignores the metadata shows fabricated numbers under a success status, which makes the check
decorative. A narrative carrying numbers that do not match the metrics is a failed answer, so it
fails.

## Decisions worth flagging

**Bots are separated, not silently dropped.** `pullRequestsMerged` counts everything merged, so it
can be checked against GitHub's own search UI. Bot-authored pull requests are then reported
separately and excluded from every review figure, because whether a dependency bump got a human
review is a different question. Reviewed plus unreviewed plus bot-authored equals merged, and a
test asserts it. This mattered more than expected: fastify had 20 dependabot pull requests in one
quarter, and counting them understated the top reviewer's share by five points, 0.4231 against
0.4727. `npx tsx tools/verify-claims.ts` recomputes that from a frozen payload. The account type
comes from GraphQL's `__typename`, not the login, because GraphQL returns `dependabot` and
`github-actions` with no marker in the name at all.

**Private repositories are refused with a 403.** The token this service holds may be scoped wider
than it needs, and refusing private repositories means it cannot be used through this endpoint to
read private activity even so.

**A capped sample withholds its derived statistics.** GitHub search returns at most 1000 results.
Past that, counts are still true as floors, but a median and a concentration share computed from
whichever pull requests happened to sort first are a biased slice wearing false precision. So they
come back null, the response says `sampleComplete: false`, and the model is told the window is
incomplete before it writes anything.

**Auth is conditional rather than always on.** On loopback there is no bearer token, because the
brief asks for something a reviewer can curl directly and a token would be friction with no
benefit. The moment `HOST` is not loopback the process refuses to start without either an
`API_TOKEN` or an explicit `ALLOW_UNAUTHENTICATED_BIND=true`. The container needs the latter,
because it has to bind `0.0.0.0` for its published port to work at all while the compose file
confines that port to the host's loopback.

## What I did not do

**The cache does not revalidate visibility.** A public repository that goes private stays served
from cache until the 15 minute TTL expires. Checking on every cache hit would cost an upstream
request per hit, which is the entire thing the cache exists to avoid. The data was public when it
was captured and the window is short, so I left it, but it is a real hole and I would rather name
it than have it found.

**The container runs unauthenticated on a declaration.** `docker-compose.yml` publishes the port
on the host's loopback and passes that same address to the process as `PUBLISHED_ON`, which is what
lets it bind `0.0.0.0` inside the container without a token. One variable drives both, so widening
the publish revokes the exemption rather than leaving a stale one behind, and the process logs a
warning at boot saying its safety rests on a declaration it cannot verify.

The adversarial review argued this should not exist at all, and that a non-loopback bind should
always demand a token. It is right that `PUBLISHED_ON` is a declaration rather than observed socket
state. My reasoning for keeping it is that a process cannot observe how Docker published its port,
so every version of this is a declaration, and requiring a token only relocates the declaration to
whether somebody set one. The cost of the stricter rule falls on `docker compose up` being a single
command, which the brief asks for directly. Someone deploying this for real should set `API_TOKEN`
and stop thinking about it.

**A real figure used without being recorded is reported, not refused.** The adversarial review
argued four separate times that this should fail the request, and its example is a fair one. A model
can write "3 rollbacks" with no rollback metric anywhere, and 3 happens to be a real contributor
count, so it passes as merely uncited. I held because the alternative refuses sound answers over
bookkeeping, and because most runs contain at least one such number, so requiring zero would reject
most good answers. I did measure the middle option of spending the retry on tidying these up, and it
made results worse. The draw that had been catching fabrications went on polish instead, and the
suite fell from 18 of 20 to 16 and 17. This is a precision and recall trade with no free answer, and
this paragraph is here so the choice is visible rather than buried.

**The prose number scan is a backstop, not a proof.** It has two tiers. A number matching nothing
computed is a fabrication and fails the request. A number that matches a computed value the model
did not cite is reported and does not, because refusing an otherwise sound answer over bookkeeping
is the wrong trade and small integers coincide with some contributor row constantly.

Neither tier can tell whether the sentence around a number is true. A real example from a run: the
model wrote that one reviewer handled "over half" of reviewed pull requests when the figure is 52
of 110, which is under half. There is no digit in "over half", so nothing was flagged. The exact
guarantee lives in the evidence array, which is bound to metric ids, and I would not describe this
check as more than it is.

**Inline comments are attributed to reviewers, not to threads.** Comment counts come from each
review submission, so a comment left outside a formal review is not counted.

**No commit or issue signals.** Both were available and both would have widened the story, but a
smaller thing I can fully explain seemed better than a larger one I could not.

## Beyond the brief

A React page on the frontend, one screen with a repository field and a date range, the summary
figures, the contributor table, and the narrative rendered with its evidence chain so each claim
sits next to the metric id it came from. When the grounding check fails the page shows the failure
rather than the prose. A screenshot of it working is in the README.

Two details in it are worth naming. The narrative is requested using the query that produced the
metrics on screen rather than the live form fields, and a narrative that arrives after those metrics
have been replaced is discarded. Either one missing puts one repository's prose beside another's
table, which is this page's central claim broken in the most visible way possible.

An evaluation suite in `evals/`. Four cases frozen from real repositories, chosen for different
shapes: a concentrated maintainer, a distributed team, a large mixed one, and a solo repository
where nobody reviews anything. Each case asserts that the citations ground, that no number is
invented, that the model reached for the metric that actually carries the story, and that its
confidence sits in a defensible band. Cases run concurrently, so a full run is about 25 seconds.

What it currently reports, against `qwen-plus` through an OpenAI-compatible endpoint: 16 or 17 of 20
checks on each of eight consecutive runs, so a median of 85% and a spread of 80 to 85. Every run
returns a well-formed answer for all four cases.

Those numbers are lower than the ones I nearly wrote here. An earlier five-run sample came back 18,
18, 18, 18 and 17, and I was about to report 18 of 20 as the headline. The next three runs were 14
of 16, 19 of 20 and 17 of 20, which made it obvious the first sample was a streak rather than a
measurement. Two of those eight runs also contained a case that returned no usable answer at all, a
hard failure a reviewer running the suite once had a real chance of hitting. Retrying a malformed
response instead of throwing it straight past the retry loop removed those entirely, zero in the
next eight runs, and tightened the spread from 75 to 95 down to 80 to 85.

What still fails is consistent and is the same thing each time. The model does arithmetic it was
told not to do, adding three contributors' review counts into a total of 180 that appears nowhere
in the fact table, and the service refuses those answers. That is the gate working rather than a
defect to tune away, and it is the number worth reporting: how often a given model produces an
answer this service will accept.

Reaching that number took eight measured runs and found three real defects, none of which any
amount of stub testing would have surfaced. The prompt contained a contradiction, telling the model
to cite every number it used and also to keep the evidence array to three to six entries. Instructions
in a system message rather than a user message made the model return an empty evidence array on
every attempt while the narrative came back fine, so the failure was silent. And telling the model
to cite everything led it to write metric ids inline in the prose instead of filling the array,
because nothing had told it the two fields have different jobs.

`docs/REFEREE.md` is not part of the assignment. It is a card for every number a reader of this
repository will see, naming what is counted, what the denominator is, the rule that decides a
match, and the command that regenerates it.

## What I would do next

Split the window and recurse when a query exceeds the 1000 result cap, so a busy repository over a
long window returns complete data instead of withholding its derived statistics.

Move the fetch to a background worker writing normalised pull requests into SQLite, so the read
path never waits on GitHub and a repository can be watched over time. The cache is keyed per exact
window today, so two overlapping windows share nothing.

Add trend lines. Every number here is a single window, and the interesting version of the question
is whether concentration is getting better or worse.

Tie prose claims to metric ids rather than to bare values, which is the honest fix for the scan
limit above.

## What I used AI for

Claude Code wrote most of the code from my direction, and I reviewed and rewrote as it went.

The part worth mentioning is how it was reviewed. Every change was put through an adversarial pass
by a second model instructed to refute rather than approve, before each commit. That found real
defects and not stylistic ones: a build script pointing at a path the build never produced, so
`npm run build && npm start` would have failed for a reviewer following the README; an auth bypass
where percent-encoding the path (`/v%31/insights`) reached the route while skipping a guard that
matched the URL as text; a cache key built from `Date.now()` so the default no-date URL missed
upstream on every request; and the 200-with-a-warning decision described above.

Two of those were regressions the review itself introduced a round earlier, which is the argument
for running it more than once. The last round converged on a single finding I disagreed with and
did not fix, which is the cache visibility trade-off named above.

The evaluation suite exists for the same reason. When a model writes the thing a user reads, the
check on its output has to be code.
