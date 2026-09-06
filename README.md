# Review insights

A small service that reads a GitHub repository's merged pull requests and reports how the team
reviews its own work. A second endpoint asks a language model to explain the numbers, then checks
the model's answer back against them before returning it.

## Run it

```bash
cp .env.example .env      # add a GitHub token, and an Anthropic key for the narrative
npm install
npm run dev
```

```bash
curl 'localhost:8080/v1/insights?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
curl 'localhost:8080/v1/insights/narrative?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
```

Or the whole thing, API and web page together, on http://localhost:8080

```bash
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... docker compose up
```

The GitHub token can be a classic personal access token with no scopes ticked. That is enough for
public repositories and lifts the rate limit from 60 requests an hour to 5000. Only
`GITHUB_TOKEN` is required. Without an LLM key the metrics endpoint works and the narrative
endpoint returns 503 saying so.

## Endpoints

`GET /v1/insights?repo=owner/name&from=YYYY-MM-DD&to=YYYY-MM-DD`

Contributor table plus three summary figures over the window. Both dates are optional and default
to the last 30 days.

`GET /v1/insights/narrative?repo=owner/name&from=...&to=...`

The same metrics, plus a short written explanation, a root cause hypothesis with a confidence
score, and an evidence chain where every item names the metric it came from. If the model quotes a
number that does not match the computed metrics, the request fails with 502 and the mismatch
attached, rather than returning prose nobody checked.

`GET /health`

## What the metric means

The window is the set of pull requests merged in `[from, to)`, and the question is whether the
team's review load is spread or concentrated. Three figures carry it: how many merged pull
requests nobody but the author looked at, how long a pull request waits for its first outside
review, and what share of reviewed pull requests the single busiest reviewer touched. Together
they separate a team that reviews each other's work from one where a single maintainer is the
bottleneck and the queue.

The counting rules are in `src/metrics/compute.ts`, and each has a test that pins it.

## Web page

One screen. Enter a repository and a window, load the metrics, then ask for the explanation. Each
claim in the evidence chain sits next to the metric id it came from, and the footer says how many
citations were checked against the computed numbers.

![Three health signals for hono over the summer, with the contributor table below](docs/images/signals.png)

![The generated narrative, its hypothesis with a confidence gauge, and the evidence chain where each claim names the metric it rests on](docs/images/narrative.png)

A short recording of the whole flow, from an empty page to a grounded explanation: [demo.mp4](https://raw.githubusercontent.com/jameswniu/tempo-loop-assignment/main/docs/images/demo.mp4)

![Recording of the page loading hono's metrics and asking the model to explain them](docs/images/demo.gif)

```bash
npm run dev                          # API on 8080
cd frontend && npm install && npm run dev    # page on 5173
```

`docker compose up` serves the page and the API together on http://localhost:8080 instead.

## Everything else

`npm test` runs the suite. `npm run eval` runs the model evaluation cases. Design decisions,
trade-offs and what I would do next are in [NOTES.md](NOTES.md). The reasoning behind every
number this page shows is in [docs/REFEREE.md](docs/REFEREE.md).
