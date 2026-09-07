# Notes

## How to run it

A classic GitHub token with no scopes ticked is enough, since this only reads public repositories. It lifts the rate limit from 60 requests an hour to 5000. The narrative endpoint also needs an LLM key. Node 22 or later.

```bash
cp .env.example .env          # GITHUB_TOKEN, and ANTHROPIC_API_KEY for the narrative
npm install
npm run dev                   # API and web page on localhost:8080
npm test                      # 134 tests, no network, no key
npm run eval                  # four frozen cases against the configured model
npm run verify                # recomputes every number the README states
```

```bash
curl 'localhost:8080/v1/insights?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
curl 'localhost:8080/v1/insights/narrative?repo=honojs/hono&from=2026-06-01&to=2026-09-01'
```

Or the whole thing in a container, `GITHUB_TOKEN=... ANTHROPIC_API_KEY=... docker compose up`.

## The metric

Commit counts say little about a team. Whether review is a shared habit or one person's job says a lot, so three figures carry it.

- How much merged with nobody but the author looking.
- How long a change sat before its first outside review, as a median and a p90.
- What share of the reviewed pull requests the busiest reviewer touched.

On `honojs/hono` this summer one maintainer reviewed 96% of everything, 48 of 126 merged unreviewed, that reviewer touched 75 of 78, and the wait is a 37 hour median with the p90 at 153 hour. On `fastify/fastify`, same window, the busiest reviewer is at 47% and the median first review lands in about eight hours.

## Architecture

A GitHub client fetches, a pure function computes, a service caches, Fastify exposes two endpoints.

- `computeInsights` has no network, no clock and no database, so a fixture pins every counting rule. Those tests are the ones I would keep if I could keep only one file.
- The fetch is one paginated GraphQL query, N/50 requests where REST would need 1 + 2N against a 5000 an hour budget. The `merged:` qualifier filters the window upstream.
- Responses cache in SQLite keyed on the exact query, so a reviewer needs no extra service running.

The narrative endpoint is the part I would talk about first. The model never sees raw JSON. It gets a fact table, one line per number with an id, a value and a unit, and may cite nothing else. The service then checks its work, looking up every citation and comparing exactly, and matching every number in the prose against the table. A failure is one retry with the mismatch named, then a 502 with the report attached.

That last part changed during the build. The first version returned 200 with the failures in a metadata block, which felt honest and is not. Any client that renders the prose and ignores the metadata shows fabricated numbers under a success.

## Decisions

- Bots are separated rather than dropped, and typed by GraphQL's `__typename` rather than the login. On fastify, 20 dependabot pull requests in a quarter understated the top reviewer's share by five points, 0.4231 against 0.4727.
- Past GitHub's 1000 result cap the counts hold as floors, but a median from whichever pull requests sorted first is false precision. It comes back null and the model is told the window is incomplete.
- Private repositories get a 403 however wide the token's scope, so this endpoint cannot read private activity.
- Loopback needs no bearer token, because a reviewer should be able to curl it. Any other host refuses to start without one, or without an explicit declaration that the published port is confined to the host's loopback.
- A real figure used without a citation is reported rather than refused. Spending the retry on tidying those took the suite from 18 of 20 down to 16 and 17.
- The wait's percentile is named by its id, p90 with its metric cited, and the spelled-out ordinal is refused. Nine rounds of grammar tried to tell the p90 wait from a contributor's percentile and never converged.

## What I did not do

- The cache does not revalidate visibility, so a repository that goes private stays served for up to 15 minutes. Checking on every hit costs the request the cache exists to avoid.
- The prose scan cannot judge a sentence. One run wrote "over half" of 52 in 110 and there is no digit to catch, so the exact guarantee lives in the evidence array.
- A login shaped like `p90-dev` reads as the percentile label, so an answer naming that contributor without citing p90 is refused. It fails closed, and masking known logins is the five-line fix.
- No commit or issue signals, and no splitting a window past the result cap. A smaller thing I can fully explain beat a larger one I could not.

## Beyond the brief

- A React page with the figures, the contributor table and the narrative beside its evidence chain. It shows the failure rather than the prose when the check fails, and discards a narrative that arrives after the metrics on screen have changed.
- An eval suite in `evals/`, four cases frozen from real repositories, five checks each, so a run is out of twenty and a case the provider never answers fails all five.
- Every figure on the landing page is generated from the repository's own numbers, and `npm run figures:check` fails CI when one drifts or the pages stop carrying the numbers as measured. `docs/REFEREE.md` holds a card for every number a reader sees.

The deployed path, `qwen-plus` through the service's own adapter, scored a median of 90% over eight runs with provider timeouts counted at full weight. The shipped default, `claude-sonnet-5`, scored a median of 97.5% through the Claude Code command line, which compares the model rather than the path, since the SDK adapter with an API key has not been run. What still fails on the completed qwen runs is arithmetic the prompt forbids, totals added up from figures the fact table never held.

## What I would do next

- Split the window and recurse past the 1000 result cap, so a busy repository returns complete data instead of withholding its statistics.
- Move the fetch to a background worker writing into SQLite, so the read path never waits on GitHub and a repository can be watched over time.
- Add trend lines, since every number here is one window and the real question is the direction.
- Tie every prose claim to a metric id, the way the p90 already is.

## How I worked

I used a coding agent throughout, which is how I work now and what the brief encourages.

The design is mine. Which metrics answer the question and what their denominators are, the half-open window, the bot rule, the fact table as the model's only vocabulary, failing the request rather than warning on it, and what to leave out. Test expectations were written by hand and the figures checked against GitHub's own search before I trusted them.

Where it earned its place is review. Every change went through an adversarial pass by a second model told to refute rather than approve, before each commit. That caught four real defects.

- A build script pointing at a path the build never produced, so `npm run build && npm start` would have failed for a reviewer following the README.
- An auth bypass where percent-encoding the path reached the route while skipping a guard that matched the URL as text.
- A cache key built from the clock, so the default no-date URL missed upstream on every request.
- The 200-with-a-warning decision above.

Two of those were regressions the review itself introduced a round earlier, which is why it runs more than once. On the last round it argued once more that an uncited real figure should fail the request, and I did not take it.
