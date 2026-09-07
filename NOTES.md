# Notes

## How to run it

You need a GitHub token. A classic personal access token with no scopes ticked is enough, since this only reads public repositories, and it lifts the rate limit from 60 requests an hour to 5000. The narrative endpoint also needs an LLM key.

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

`npm test` runs 134 tests with no network and no key. `npm run eval` runs the model evaluation. `npm run verify` recomputes every number the README states from frozen payloads. Node 22 or later.

## The metric, and why this one

Contributor counts by commits are easy and say very little. What a team wants to know is whether review is a shared habit or one person's job, so three figures carry the story over the pull requests merged in a window.

How many merged with nobody but the author looking. How long a change sat before its first outside review, as a median and a p90. What share of the reviewed pull requests the busiest reviewer touched.

Over `honojs/hono` this summer, one maintainer reviewed 96% of everything, 48 of 126 merged with no outside review, that one reviewer touched 75 of 78, and the wait is a 37 hour median with the p90 at 153 hour. Over `fastify/fastify`, same window, the busiest reviewer is at 47%, one pull request went unreviewed, and the median first review lands in about eight hours. Same three numbers, two different working cultures.

## Architecture

Four layers, each readable without the others. A GitHub client fetches merged pull requests and their reviews, a pure function turns them into metrics, a service ties fetch, cache and compute together, and Fastify exposes two endpoints.

`computeInsights` takes pull requests and a window and returns numbers, with no network, no clock and no database. That is what lets a fixture with hand-checked expectations pin every counting rule, and those tests are the ones I would keep if I could keep only one file. The fetch is one paginated GraphQL query rather than REST, which would be a list call plus a reviews call and a comments call per pull request, roughly 1 + 2N against a 5000 an hour budget. GraphQL is N/50, and the `merged:` qualifier filters the window upstream so nothing is downloaded and discarded. Responses are cached in SQLite keyed on the exact query, so a reviewer needs no extra service.

The narrative endpoint is the part I would talk about first. The model never sees raw JSON. It gets a flat fact table, one line per number with an id, a value, a unit and a plain description, and it may cite nothing else. The answer comes back as structured output, and then the service checks the model's own work. Every evidence item's id is looked up and its value compared exactly, and every number in the prose must have a counterpart among the facts it cited. If either check fails the request is retried once with the mismatch named, then returns 502 with the report attached.

That decision changed during the build. The first version returned 200 with the failures in a metadata block, which felt honest and is not. Any client that renders the narrative and ignores the metadata shows fabricated numbers under a success status, which makes the check decorative.

## Decisions worth flagging

**Bots are separated, not dropped.** `pullRequestsMerged` counts everything merged so it reconciles with GitHub's own search, then bot-authored pull requests are reported apart and excluded from every review figure. Reviewed plus unreviewed plus bot-authored equals merged, and a test asserts it. This mattered more than expected. Fastify had 20 dependabot pull requests in one quarter, and counting them understated the top reviewer's share by five points, 0.4231 against 0.4727. The account type comes from GraphQL's `__typename` rather than the login, because `dependabot` arrives with no marker in its name.

**A capped sample withholds its derived statistics.** GitHub search returns at most 1000 results. Past that the counts are still true as floors, but a median and a share computed from whichever pull requests sorted first are a biased slice wearing false precision. They come back null, the response says the sample is incomplete, and the model is told before it writes.

**Private repositories are refused with a 403,** however wide the token's scope, so this endpoint cannot be used to read private activity.

**Auth is conditional.** On loopback there is no bearer token, because the brief asks for something a reviewer can curl. The moment the host is not loopback the process refuses to start without a token or an explicit declaration that the published port is confined to the host's loopback, which is what the compose file passes it.

**A real figure used without a citation is reported, not refused.** A model can write "3 rollbacks" with no rollback metric anywhere, and 3 happens to be a real contributor count, so it passes as merely uncited. Refusing would reject sound answers over bookkeeping, and nearly every run carries one. I measured the middle option of spending the retry on tidying them up and it made results worse, from 18 of 20 down to 16 and 17, because the draw that had been catching fabrications went on polish instead.

**The wait's percentile is named by its id.** The prompt asks for p90 with `reviewLatency.p90Hours` cited, a cited p90 reads as a name, an uncited one is a claim with nothing behind it, and the spelled-out ordinal is refused in every form. Nine rounds of grammar tried to tell "the 90th percentile wait" from "the 90th percentile contributor" sentence by sentence, and a rule that parses English was never going to converge, so the label moved to an id instead.

## What I did not do

**The cache does not revalidate visibility.** A public repository that goes private stays served until the 15 minute TTL expires, because checking on every hit costs the upstream request the cache exists to avoid. It is a real hole, and naming it here beats having it found.

**The prose scan cannot judge a sentence.** One run wrote that a reviewer handled "over half" of the reviewed pull requests when the figure was 52 of 110, and there is no digit in "over half" to catch. The exact guarantee lives in the evidence array, which is bound to metric ids.

**One residual in the label rule.** A contributor whose login is shaped like `p90-dev` reads as the label, so an answer naming them without citing p90 is refused rather than passed. It fails closed, and masking the logins the fact table already knows is the five-line fix if such a repository turns up.

**No commit or issue signals, and no splitting a window past the result cap.** Both would widen the story. A smaller thing I can fully explain seemed better than a larger one I could not.

## Beyond the brief

A React page with a repository field, a date range, the summary figures, the contributor table, and the narrative rendered with its evidence chain so each claim sits beside the metric id it came from. When the grounding check fails the page shows the failure rather than the prose. The narrative is requested using the query that produced the metrics on screen rather than the live form fields, and one arriving after those metrics were replaced is discarded, since either gap puts one repository's prose beside another's table.

An evaluation suite in `evals/`, four cases frozen from real repositories, chosen for different shapes. A concentrated maintainer, a distributed team, a large mixed one, and a solo repository where nobody reviews anything. Each case asserts that the citations ground, that no number is invented, that the model reached for the metric carrying the story, that its confidence sits in a band written before the model ever ran, and that the evidence chain is not empty. A case the provider never answers fails all five, so every run is out of twenty.

The deployed path is the service's own OpenAI-compatible adapter with the model this machine is configured for, `qwen-plus`, and it scored a median of 90% over eight runs, with two runs that lost cases to provider timeouts counted at full weight. The shipped default, `claude-sonnet-5`, was measured separately through the Claude Code command line on a subscription login, same prompts and schema, and scored a median of 97.5%. That compares the model rather than the path, because the command line is not the SDK adapter a request takes, and the Anthropic adapter has not been run, which needs a paid key. What still fails on the completed qwen runs is one thing, arithmetic the prompt forbids, adding contributor counts into a total the fact table never held.

Every figure on the landing page is generated by `tools/figures.ts` from the repository's own numbers, the eval panel from the suite's own report and the hero from the frozen payloads and the committed sample. Each string passes a fit guard at generation time, and `npm run figures:check` fails CI when a committed figure drifts from its generator, or when the README or these notes stop carrying the numbers as measured. `docs/REFEREE.md` holds a card for every number a reader sees, naming what is counted, what the denominator is, and the command that regenerates it.

## What I would do next

Split the window and recurse when a query exceeds the 1000 result cap, so a busy repository over a long window returns complete data instead of withholding its derived statistics.

Move the fetch to a background worker writing normalised pull requests into SQLite, so the read path never waits on GitHub and a repository can be watched over time. The cache is keyed per exact window today, so two overlapping windows share nothing.

Add trend lines. Every number here is a single window, and the interesting version of the question is whether concentration is getting better or worse.

Tie every prose claim to a metric id, the way the wait's percentile already is, which is the honest fix for the scan limit above.

## How I worked

I used a coding agent throughout, which is how I work now and what the brief encourages.

The design is mine. Which metrics answer the question and what their denominators are, the half-open window, the bot rule and where it applies, the fact table as the model's only vocabulary, failing the request rather than warning on it, spending the retry on fabrications rather than on tidiness, and what to leave out. The test expectations were written by hand, and the figures were checked against GitHub's own search before I trusted them.

The part worth mentioning is how the code was reviewed. Every change went through an adversarial pass by a second model instructed to refute rather than approve, before each commit. That found real defects and not stylistic ones. A build script pointing at a path the build never produced, so `npm run build && npm start` would have failed for a reviewer following the README. An auth bypass where percent-encoding the path, `/v%31/insights`, reached the route while skipping a guard that matched the URL as text. A cache key built from `Date.now()`, so the default no-date URL missed upstream on every request. And the 200-with-a-warning decision described above.

Two of those were regressions the review itself introduced a round earlier, which is the argument for running it more than once. On its last round it argued a fifth time that an uncited real figure should fail the request, and I did not take it, for the reason given above.

The evaluation suite exists for the same reason. When a model writes the thing a user reads, the check on its output has to be code.
