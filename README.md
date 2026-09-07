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

A classic token with no scopes ticked is enough, since only public repositories are read. Without an LLM key the metrics endpoint still works and the narrative endpoint answers 503.

---

## The metric, and why this one

Commit counts say little about how a team works. What a team wants to know is whether review is a shared habit or one person's job, so three figures carry the story.

| | The question it answers | Where its truth comes from | On hono, summer 2026 |
|:---|:---|:---|:---|
| **Merged without review** | How much merges with nobody but the author looking? | Merged pull requests with no review from anyone else | 48 of 126 |
| **Wait for first review** | When review comes, how long did the change sit? | Hours from opening to the first outside review, median and p90 | A median of 37 hours and a tail past six days |
| **Top reviewer share** | Is review a shared habit or one person's job? | Reviewed pull requests touched by the single busiest reviewer | One person on 75 of 78 |

On `honojs/hono` one maintainer reviewed 96% of everything, and 48 of 126 pull requests merged with no outside review. On `fastify/fastify`, same window, the busiest reviewer is at 47% and the median first review lands in about eight hours. Same three numbers, two different working cultures.

<p align="center"><img src="docs/images/signals.png" alt="Three health signals for hono over the summer, with the contributor table below" width="100%"></p>

## How it is built

Four layers, each readable without the others. A GitHub client fetches merged pull requests and their reviews, a pure function turns them into metrics, a service ties fetch, cache and compute together, and Fastify exposes two endpoints.

`computeInsights` has no network, no clock and no database, so a fixture pins every counting rule. The fetch is one paginated GraphQL query, N/50 requests where REST would need 1 + 2N, and the `merged:` qualifier filters upstream. Responses are cached in SQLite, keyed on the exact query.

<p align="center">
  <img src="assets/system-map.svg" alt="Request path. How a request flows. Fetch, compute, then hold the narrative to the numbers. 2 endpoints, 134 tests green, a suite with no network and no key. 01 fetch, GitHubClient, one search query with the merged range as its qualifier, 50 pull requests a page, authors and reviewers typed by typename, 404 when missing, 403 when private, 429 when rate limited. 02 compute, computeInsights, a half open window, self review never counts, a bot's pull request leaves every review figure, reviewed plus unreviewed plus bot authored equals merged. 03 ground, generateNarrative, a fact per number, each citation compared exactly, a mismatch gets one retry then a 502." width="100%">
</p>

## The narrative, and the check on it

The model gets a flat fact table, one line per number with an id, a value and a unit, and may cite nothing else. The service then checks its work. Every citation is looked up and compared exactly, and every number in the prose must exist in the table. A mismatch is one retry with the mismatch named, then a 502 with the report attached.

The first version returned 200 with the failures in a metadata block. A client that ignores the metadata then shows fabricated numbers under a success, so a narrative that fails the check now fails the request.

<p align="center"><img src="docs/images/narrative.png" alt="The generated narrative, its hypothesis with a confidence gauge, and the evidence chain where each claim names the metric it rests on" width="100%"></p>

<p align="center">
  <a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4"><img src="docs/images/demo.gif" alt="Recording of the page loading hono's metrics and asking the model to explain them" width="100%"></a>
</p>
<p align="center"><sub><a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4">Watch the recording</a></sub></p>

## Decisions worth flagging

- Bots are separated, not dropped, and typed by GraphQL's `__typename`, because on fastify 20 dependabot pull requests understated the top reviewer's share by five points.
- A sample capped at GitHub's 1000 results withholds its median and share, since a slice that happened to sort first is false precision.
- Private repositories get a 403, however wide the token's scope.
- Loopback needs no token, and any other host refuses to start without one or an explicit declaration.
- A real figure used without a citation is reported, not refused, because spending the retry on it took the suite from 18 of 20 down to 16 and 17.
- The wait's percentile is named by its id, p90, and the spelled out ordinal is refused, after nine rounds of grammar failed to parse the English.

## The eval suite

Four cases frozen from real repositories, five checks each, so every run is out of twenty. A case the provider never answers fails all five.

The deployed path, `qwen-plus` through the service's own adapter, scored a median of 90% over eight runs, timeouts counted at full weight. The shipped default, `claude-sonnet-5`, scored 97.5% through the Claude Code command line on a subscription login. That compares the model, not the path, since the SDK adapter with an API key has not been run.

<p align="center"><img src="assets/eval-panel.svg" alt="The most recent eval run, checks passed per case for each model" width="100%"></p>

## What I left out, and why

- The cache does not revalidate visibility, so a repository that goes private stays served for up to 15 minutes.
- The prose scan cannot judge a sentence, so "over half" of 52 in 110 passed with no digit to catch.
- No commit or issue signals, and no splitting of a window past the 1000 result cap, because a smaller thing fully explained beat a larger one I could not.

More in [NOTES.md](NOTES.md), and a card for every number above in [docs/REFEREE.md](docs/REFEREE.md).
