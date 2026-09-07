<p align="center">
  <img src="assets/hero.svg" alt="How does a team review its own work? Three review signals from merged pull requests, one fact table, every number checked. Three cards for hono over summer 2026. Unreviewed asks how much merges with nobody else looking, 48 of 126 merged without review. Wait asks how long a change sat before review came, a 37 hour median with the p90 at 153 hours. Share asks whether review is shared or one person's job, 75 of 78 reviewed pull requests touched by one reviewer, 96 percent. The footer reads 134 tests, eval median 90 percent over 8 runs, redrawn by tools/figures.ts." width="100%">
</p>

<div align="center">

<b><font size="6">Review insights</font></b>

<br/>

<img alt="checks" src="https://img.shields.io/github/actions/workflow/status/jameswniu/tempo-loop-assignment/checks.yml?branch=main&style=flat-square&labelColor=141413&label=checks">
<img alt="134 tests, no network and no key" src="https://img.shields.io/badge/tests-134_%C2%B7_no_network,_no_key-CC785C?style=flat-square&labelColor=141413">
<img alt="eval median 90% over 8 runs" src="https://img.shields.io/badge/eval_median-90%25_over_8_runs-6B645A?style=flat-square&labelColor=141413">
<img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6B645A?style=flat-square&labelColor=141413">

<br/><br/>

<strong>Three review signals from a repository's merged pull requests, and a narrative that has to cite them.</strong><br/>
One metrics endpoint, one narrative endpoint, and a check that fails the request when the model's numbers do not match the computed ones.

<br/>

<code>fetch -> compute -> fact table -> model -> check -> answer</code>

</div>

```bash
cp .env.example .env     # a GitHub token, and an LLM key for the narrative
npm install
npm run dev              # API and web page on localhost:8080
npm test                 # 134 tests, no network, no key
npm run eval             # four frozen cases against the configured model
npm run verify           # recomputes every number this page states, from frozen payloads
```

```bash
curl 'localhost:8080/v1/insights?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
curl 'localhost:8080/v1/insights/narrative?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
```

A classic token with no scopes ticked is enough, since only public repositories are read. Without an LLM key the metrics endpoint works and the narrative endpoint answers 503 saying so.

---

## The metric, and why this one

Contributor counts by commits are easy to compute and say very little. What a team actually wants to know is whether review is a shared habit or one person's job, so the window is the pull requests merged in `[from, to)` and three figures carry the story.

| | The question it answers | Where its truth comes from | On hono, summer 2026 |
|:---|:---|:---|:---|
| **Merged without review** | How much merges with nobody but the author looking? | Merged pull requests with no review from anyone else | 48 of 126 |
| **Wait for first review** | When review comes, how long did the change sit? | Hours from opening to the first outside review, median and p90 | A median of 37 hours and a tail past six days |
| **Top reviewer share** | Is review a shared habit or one person's job? | Reviewed pull requests touched by the single busiest reviewer | One person on 75 of 78 |

Run that over `honojs/hono` for the summer and one maintainer reviewed 96% of everything, while 48 of 126 pull requests merged with no outside review at all. Run it over `fastify/fastify` for the same window and the busiest reviewer is at 47%, one pull request went unreviewed, and the median first review lands in about eight hours. Same three numbers, two completely different working cultures.

<p align="center"><img src="docs/images/signals.png" alt="Three health signals for hono over the summer, with the contributor table below" width="100%"></p>

## How it is built

Four layers, each of which can be understood without the others. A GitHub client fetches merged pull requests and their reviews. A pure function turns those into metrics. A service ties fetch, cache and compute together. Fastify exposes two endpoints.

`computeInsights` takes pull requests and a window and returns numbers, with no network, no clock and no database. That is what lets a fixture with hand-checked expectations pin every counting rule, and those tests are the ones I would keep if I could keep only one file.

The fetch is one paginated GraphQL query rather than REST. REST would be a list call plus a reviews call and a comments call per pull request, roughly 1 + 2N requests against a 5000 an hour budget. GraphQL is N/50, and the `merged:` search qualifier does the window filtering upstream, so nothing is downloaded and then discarded. Responses are cached in SQLite keyed on the exact query, which needs no extra service for a reviewer to start.

<p align="center">
  <img src="assets/system-map.svg" alt="Request path. How a request flows. Fetch, compute, then hold the narrative to the numbers. 2 endpoints, 134 tests green, a suite with no network and no key. 01 fetch, GitHubClient, one search query with the merged range as its qualifier, 50 pull requests a page, authors and reviewers typed by typename, 404 when missing, 403 when private, 429 when rate limited. 02 compute, computeInsights, a half open window, self review never counts, a bot's pull request leaves every review figure, reviewed plus unreviewed plus bot authored equals merged. 03 ground, generateNarrative, a fact per number, each citation compared exactly, a mismatch gets one retry then a 502." width="100%">
</p>

## The narrative, and the check on it

The model never sees raw JSON. It gets a flat fact table, one line per number, each with an id, a value, a unit and a plain description, and it is told it may cite nothing else. The answer comes back as structured output, and then the service checks the model's own work. Every evidence item's metric id is looked up and its value compared exactly, and every number appearing anywhere in the prose must have a counterpart in the table. If either check fails the request is retried once, with the mismatch named, and then returns 502 with the report attached.

That last decision changed during the build. The first version returned 200 with the failures noted in a metadata block, which felt honest. It is not. Any client that renders the narrative and ignores the metadata shows fabricated numbers under a success status, which makes the check decorative. A narrative carrying numbers that do not match the metrics is a failed answer, so it fails.

<p align="center"><img src="docs/images/narrative.png" alt="The generated narrative, its hypothesis with a confidence gauge, and the evidence chain where each claim names the metric it rests on" width="100%"></p>

<p align="center">
  <a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4"><img src="docs/images/demo.gif" alt="Recording of the page loading hono's metrics and asking the model to explain them" width="100%"></a>
</p>
<p align="center"><sub><a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4">Watch the recording</a></sub></p>

## Decisions worth flagging

- Bots are separated, not silently dropped. `pullRequestsMerged` counts everything merged, so it can be checked against GitHub's own search, and bot-authored pull requests are then reported apart and excluded from every review figure. On fastify, 20 dependabot pull requests in one quarter understated the top reviewer's share by five points, 0.4231 against 0.4727. The account type comes from GraphQL's `__typename`, because `dependabot` arrives with no marker in its name.
- A capped sample withholds its derived statistics. GitHub search returns at most 1000 results, and past that a median and a share computed from whichever pull requests sorted first are a biased slice wearing false precision. So they come back null, the response says the sample is incomplete, and the model is told so before it writes.
- Private repositories are refused with a 403, however wide the token's scope, so this endpoint cannot be used to read private activity.
- Auth is conditional. On loopback there is no bearer token, because a reviewer should be able to curl it. The moment the host is not loopback, the process refuses to start without a token or an explicit declaration that the port is published on the host's loopback.
- A real figure the model used without citing is reported beside the answer, not refused. Refusing would reject most sound answers over bookkeeping, and spending the retry on tidying those up was measured and made the suite worse, 18 of 20 down to 16 and 17.
- The wait's percentile is named by its id. The model writes p90 and cites `reviewLatency.p90Hours`, and the spelled out ordinal is refused. Nine rounds of grammar tried to tell the p90 wait from a contributor's percentile sentence by sentence, and a rule that parses English was never going to converge.

## The eval suite

Four cases frozen from real repositories, a concentrated maintainer, a distributed team, a large mixed one and a solo repository where nobody reviews anything. Each asserts that the citations ground, that no number is invented, that the metric carrying the story is cited, that the confidence sits in a band written before the model was ever run, and that the evidence chain is not empty. A case the provider never answers fails all five, so every run is out of twenty.

Over eight runs the deployed path, `qwen-plus` through the service's own adapter, scored a median of 90%, with two runs that lost cases to provider timeouts counted at full weight. The shipped default model, `claude-sonnet-5`, was measured as well, through the Claude Code command line on a subscription login, and scored 97.5% over its own eight runs. That compares the model and not the path, because the service reaches Claude through the Anthropic SDK with an API key, and that adapter has not been run.

<p align="center"><img src="assets/eval-panel.svg" alt="The most recent eval run, checks passed per case for each model" width="100%"></p>

## What I left out, and why

- The cache does not revalidate visibility. A public repository that goes private stays served from cache until the 15 minute TTL runs out, because checking on every hit costs the upstream request the cache exists to avoid.
- The prose scan cannot judge a sentence. One run wrote that a reviewer handled over half of the reviewed pull requests when the figure was 52 of 110, and there is no digit in over half. The exact guarantee lives in the evidence array.
- No commit or issue signals, and no splitting of a window past the 1000 result cap. Both would widen the story, and a smaller thing I can fully explain seemed better than a larger one I could not.

More in [NOTES.md](NOTES.md), and a card for every number above in [docs/REFEREE.md](docs/REFEREE.md).
