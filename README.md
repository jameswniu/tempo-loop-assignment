<p align="center">
  <img src="assets/hero.svg" alt="Pull request review metrics. Review insights. Merged pull request metrics, and a narrative checked against them. Three tiles read 96 percent for one reviewer on hono, 134 tests, and 90 percent eval median over 8 runs. The stages run fetch, compute, fact table, model, check, answer, with check highlighted. The footer names npm run verify, npm test and npm run eval." width="100%">
</p>

<div align="center">

<b><font size="6">Review insights</font></b>

</div>

<p align="center">
<a href="https://github.com/jameswniu/tempo-loop-assignment/actions/workflows/checks.yml"><img alt="checks" src="https://github.com/jameswniu/tempo-loop-assignment/actions/workflows/checks.yml/badge.svg?branch=main"></a>
<img alt="134 tests" src="https://img.shields.io/badge/tests-134-345c8f?style=flat-square&labelColor=57606a">
<img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6e7681?style=flat-square&labelColor=57606a">
</p>

<div align="center">

<br/>

<strong>A service that reads a GitHub repository's merged pull requests and reports how the team reviews its own work.</strong><br/>
A second endpoint asks a language model to explain the numbers, then checks every figure in the answer against the numbers it was given.<br/>
If a figure does not match, the request fails.

<br/>

<code>fetch -> compute -> fact table -> model -> check -> answer</code>

</div>

---

Three figures, each answering a different question.

| | The question it answers | Where its truth comes from | On hono, this summer |
|:---|:---|:---|:---|
| **Merged without review** | How much ships with nobody but the author looking? | Merged pull requests with no review from anyone else | 48 of 126 |
| **Wait for first review** | When review happens, how long does a change sit first? | Hours from opening to the first outside review, median and p90 | A median of 37 hours and a tail past six days |
| **Top reviewer share** | Is review a shared habit or one person's job? | Reviewed pull requests touched by the single busiest reviewer | One person on 75 of 78 |

Commit counts say little about how a team works. These three separate a team that reviews each other's work from one where a single maintainer is the bottleneck. On `honojs/hono` one maintainer reviewed 96% of everything. On `fastify/fastify`, same window, the busiest reviewer is at 47%, one pull request went unreviewed, and the median first review lands in about eight hours.

<table>
  <tr>
    <td width="33%" align="center" valign="top"><a href="#1-the-metric"><img src="docs/images/cell-signals.gif" alt="The three signals loading for hono, each with a colour and a verdict" width="100%"></a><br>A pure function over merged pull requests, each counting rule pinned by a fixture. <a href="#1-the-metric">The rules</a></td>
    <td width="33%" align="center" valign="top"><a href="#2-the-grounded-narrative"><img src="docs/images/cell-narrative.gif" alt="The model's explanation arriving with its evidence chain, each claim beside the metric it rests on" width="100%"></a><br>A fact table the model may not go beyond, every citation checked before a word is shown. <a href="#2-the-grounded-narrative">The check</a></td>
    <td width="33%" align="center" valign="top"><a href="#3-the-eval-suite"><img src="assets/eval-panel.svg" alt="The eval run, four frozen cases with checks passed per case" width="100%"></a><br>Four frozen cases, run before any change to the prompt or the model. <a href="#3-the-eval-suite">The suite</a></td>
  </tr>
</table>

---

## Run it

```bash
cp .env.example .env      # add a GitHub token, and an LLM key for the narrative
npm install
npm run dev
```

```bash
curl 'localhost:8080/v1/insights?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
curl 'localhost:8080/v1/insights/narrative?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
```

Or the whole thing, API and web page together on http://localhost:8080

```bash
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... docker compose up
```

A classic GitHub token with no scopes ticked is enough, since the service only reads public repositories. Without an LLM key the metrics endpoint works and the narrative endpoint returns 503 saying so. `npm test` runs the suite, `npm run eval` runs the model evaluation, and `npm run verify` recomputes every number this page states from frozen payloads.

<p align="center">
  <img src="assets/system-map.svg" alt="System map. One query in, one checked answer. Section 01, fetch. GraphQL search, where the merged qualifier does the window, 50 pull requests a page, and bots are identified by typename. Section 02, compute. computeInsights, a half-open window, no self-review counts, and reviewed plus unreviewed plus bots sums back to merged. Section 03, ground. generateNarrative, fact table in and JSON out, each citation looked up, and a mismatch is a 502." width="100%">
</p>

---

## 1. The metric

The window is the pull requests merged in `[from, to)`. Every number comes out of one pure function, `computeInsights` in [`src/metrics/compute.ts`](src/metrics/compute.ts), with no network, no clock and no database, so a fixture with hand-checked expectations pins each counting rule. Bots are identified by the account type GitHub reports and kept out of every review figure, a review by the author never counts, and reviewed plus unreviewed plus bot-authored equals merged.

<p align="center"><img src="docs/images/signals.png" alt="Three health signals for hono over the summer, with the contributor table below" width="100%"></p>

## 2. The grounded narrative

The model gets a fact table, one line per number with an id, a value and a unit, and may cite nothing else. Every citation is looked up and compared exactly, and every number in the prose must exist in the fact table. A number that matches nothing computed is one retry and then a 502, never a 200 with a warning. A real figure the model forgot to cite is reported beside the answer.

<p align="center"><img src="docs/images/narrative.png" alt="The generated narrative, its hypothesis with a confidence gauge, and the evidence chain where each claim names the metric it rests on" width="100%"></p>

<p align="center">
  <a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4"><img src="docs/images/demo.gif" alt="Recording of the page loading hono's metrics and asking the model to explain them" width="100%"></a>
</p>
<p align="center"><sub><a href="https://github.com/jameswniu/tempo-loop-assignment/raw/main/docs/images/demo.mp4">Watch the recording</a></sub></p>

## 3. The eval suite

Four cases frozen from real repositories, a concentrated maintainer, a distributed team, a large mixed one and a solo repository. Each asserts that the citations ground, that no number is invented, that the metric carrying the story is cited, and that the confidence sits in a band written before the model was ever run.

<p align="center"><img src="assets/eval-panel.svg" alt="The most recent eval run, checks passed per case" width="100%"></p>

The panel is the latest run. Over eight runs the deployed path, `qwen-plus` through the service's own adapter, scored a median of 90%, with the two runs that lost cases to provider timeouts counted at full weight. The shipped default model through the Claude Code command line scored 97.5%, a comparison of the model rather than of the deployed path. Every sample, and what each model gets wrong, is in [NOTES.md](NOTES.md).

---

## Everything else

[NOTES.md](NOTES.md) holds the architecture tour, the decisions, the eval history and what I would do next. [docs/REFEREE.md](docs/REFEREE.md) holds a card for every number this page states. The three hero numbers are measured by `tools/figures.ts`, and CI fails when this page drifts from them.
