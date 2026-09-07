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

| | The question it answers | Where its truth comes from | On hono, summer 2026 |
|:---|:---|:---|:---|
| **Merged without review** | How much merges with nobody but the author looking? | Merged pull requests with no review from anyone else | 48 of 126 |
| **Wait for first review** | When review comes, how long did the change sit? | Hours from opening to the first outside review, median and p90 | A median of 37 hours and a tail past six days |
| **Top reviewer share** | Is review a shared habit or one person's job? | Reviewed pull requests touched by the single busiest reviewer | One person on 75 of 78 |

Commit counts say little about how a team works. These three separate a team that reviews each other's work from one where a single maintainer is the bottleneck. On `honojs/hono` one maintainer reviewed 96% of everything. On `fastify/fastify`, same window, the busiest reviewer is at 47%, one pull request went unreviewed, and the median first review lands in about eight hours.

---

## 1. The metric

Every number comes out of one pure function over the pull requests merged in `[from, to)`, with no network, no clock and no database, so a fixture pins each counting rule. Bots are reported apart and leave every review figure, a review by the author never counts, and reviewed plus unreviewed plus bot-authored equals merged.

<p align="center"><img src="docs/images/signals.png" alt="Three health signals for hono over the summer, with the contributor table below" width="100%"></p>

## 2. The grounded narrative

The model gets a fact table, one line per number with an id, a value and a unit, and may cite nothing else. Every citation is looked up and compared exactly, and every number in the prose has to exist in that table. A mismatch is one retry with the mismatch named, then a 502, never a 200 with a warning.

<p align="center"><img src="docs/images/narrative.png" alt="The generated narrative, its hypothesis with a confidence gauge, and the evidence chain where each claim names the metric it rests on" width="100%"></p>

<p align="center">
  <a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4"><img src="docs/images/demo.gif" alt="Recording of the page loading hono's metrics and asking the model to explain them" width="100%"></a>
</p>
<p align="center"><sub><a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4">Watch the recording</a></sub></p>

## 3. The eval suite

Four cases frozen from real repositories, a concentrated maintainer, a distributed team, a large mixed one and a solo repository, with five checks each, so every run is out of twenty. Over eight runs the deployed path, `qwen-plus` through the service's own adapter, scored a median of 90%, with two runs that lost cases to provider timeouts counted at full weight. The shipped default model through the Claude Code command line scored 97.5%, which compares the model and not the path.

<p align="center"><img src="assets/eval-panel.svg" alt="The most recent eval run, checks passed per case for each model" width="100%"></p>

## How a request flows

<p align="center">
  <img src="assets/system-map.svg" alt="Request path. How a request flows. Fetch, compute, then hold the narrative to the numbers. 2 endpoints, 134 tests green, a suite with no network and no key. 01 fetch, GitHubClient, one search query with the merged range as its qualifier, 50 pull requests a page, authors and reviewers typed by typename, 404 when missing, 403 when private, 429 when rate limited. 02 compute, computeInsights, a half open window, self review never counts, a bot's pull request leaves every review figure, reviewed plus unreviewed plus bot authored equals merged. 03 ground, generateNarrative, a fact per number, each citation compared exactly, a mismatch gets one retry then a 502." width="100%">
</p>

## What I left out, and why

- The cache does not revalidate visibility. A public repository that goes private stays served from cache until the 15 minute TTL runs out, because checking on every hit costs the upstream request the cache exists to avoid.
- A real figure used without a citation is reported, not refused. Refusing would reject most sound answers over bookkeeping, and spending the retry on it was measured and made the suite worse.
- The Anthropic adapter, the shipped default, has not been measured, because it needs a paid key. The default model was measured through the command line instead, and that number stays out of the badge and the hero.

More in [NOTES.md](NOTES.md), and a card for every number above in [docs/REFEREE.md](docs/REFEREE.md).
