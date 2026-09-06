import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ApiError,
  fetchInsights,
  fetchNarrative,
  setBearerToken,
  type Insights,
  type Narrative,
  type Query,
} from './api.js';

const DEFAULT_REPO = 'honojs/hono';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

type Tone = 'good' | 'warn' | 'bad' | 'none';

// Display thresholds only, for colour: every number above is still shown regardless of tone.
const UNREVIEWED_SHARE_GOOD_BELOW = 0.1;
const UNREVIEWED_SHARE_WARN_BELOW = 0.25;
const REVIEW_WAIT_GOOD_BELOW_HOURS = 24;
const REVIEW_WAIT_WARN_BELOW_HOURS = 72;
const TOP_REVIEWER_SHARE_GOOD_BELOW = 0.5;
const TOP_REVIEWER_SHARE_WARN_BELOW = 0.75;

export function App() {
  const [repo, setRepo] = useState(DEFAULT_REPO);
  const [from, setFrom] = useState(isoDaysAgo(90));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [insights, setInsights] = useState<Insights | null>(null);
  /**
   * The query the displayed metrics actually came from. The narrative is asked
   * for using THIS, never the live form fields, because the page's whole claim
   * is that the written explanation cites the numbers shown beside it. Editing
   * the repository field and pressing Explain would otherwise put one
   * repository's prose next to another's table.
   */
  const [loadedQuery, setLoadedQuery] = useState<Query | null>(null);
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [narrating, setNarrating] = useState(false);
  const [token, setToken] = useState('');

  /**
   * Every load gets a number, and a response is only applied if its number is
   * still the current one. Binding the narrative to the loaded query is not
   * enough on its own: a model call takes seconds, the form stays usable while
   * it runs, and without this a narrative for one repository can land beside
   * another's metrics simply by arriving late.
   */
  const generation = useRef(0);

  // True when the form has moved on from what is displayed. The Explain button
  // still answers for what is displayed, and the page says so rather than
  // quietly using one query for the table and another for the prose.
  const formHasMovedOn =
    loadedQuery !== null &&
    (loadedQuery.repo !== repo.trim() || loadedQuery.from !== from || loadedQuery.to !== to);

  async function loadMetrics(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setNarrative(null);
    setInsights(null);
    setLoadedQuery(null);
    const mine = ++generation.current;
    const query: Query = { repo: repo.trim(), from, to };
    try {
      const response = await fetchInsights(query);
      if (mine !== generation.current) return;
      setInsights(response.insights);
      setLoadedQuery(query);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'network', String(caught)));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }

  async function explain() {
    if (loadedQuery === null) return;
    const mine = generation.current;
    setNarrating(true);
    setError(null);
    try {
      const result = await fetchNarrative(loadedQuery);
      // The metrics on screen changed while the model was writing. This answer
      // describes numbers nobody is looking at any more, so it is dropped.
      if (mine !== generation.current) return;
      setNarrative(result);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'network', String(caught)));
    } finally {
      if (mine === generation.current) setNarrating(false);
    }
  }

  // Fills the form with one of the empty state's suggestions, over the same
  // three month window. It only sets state; the user still presses Load.
  function preset(repoName: string) {
    setRepo(repoName);
    setFrom('2026-06-01');
    setTo('2026-09-01');
  }

  return (
    <main>
      <header>
        <h1>Review insights</h1>
        <p className="lede">
          How a repository reviews its own work, over a window.{' '}
          <strong>
            Every number below is computed from merged pull requests, and the written explanation
            may only cite numbers from this page.
          </strong>
        </p>
      </header>

      <form className="toolbar" onSubmit={loadMetrics}>
        <label className="repo">
          Repository
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            required
          />
        </label>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          API token
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setBearerToken(e.target.value);
            }}
            placeholder="only if the server sets one"
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? (
            <>
              <span className="spinner" />
              Loading
            </>
          ) : (
            'Load metrics'
          )}
        </button>
      </form>

      {insights === null && error === null && !loading && (
        <section className="empty">
          <p>Load a repository to see how it reviews its own work.</p>
          <p>Try one of these, each over the same three months:</p>
          <div className="try">
            <button type="button" onClick={() => preset('honojs/hono')}>
              honojs/hono
            </button>
            <button type="button" onClick={() => preset('fastify/fastify')}>
              fastify/fastify
            </button>
            <button type="button" onClick={() => preset('vitest-dev/vitest')}>
              vitest-dev/vitest
            </button>
          </div>
        </section>
      )}

      {error !== null && <ErrorPanel error={error} />}
      {insights !== null && (
        <>
          <Summary insights={insights} />
          <Leaderboard insights={insights} />
          <section className="block explain">
            <div className="explain-head">
              <button onClick={explain} disabled={narrating}>
                {narrating ? (
                  <>
                    <span className="spinner" />
                    Asking the model
                  </>
                ) : (
                  'Explain these numbers'
                )}
              </button>
              <p>
                The model gets a table of these numbers and may cite nothing else. Every citation
                is checked before anything is shown.
              </p>
            </div>
            {formHasMovedOn && (
              <p className="warning">
                The form has changed since these numbers were loaded. Explaining will describe what
                is shown above, for {loadedQuery?.repo}. Load metrics again to move on.
              </p>
            )}
            {narrative !== null && <NarrativePanel narrative={narrative} />}
          </section>
        </>
      )}
    </main>
  );
}

function Summary({ insights }: { insights: Insights }) {
  const { totals, reviewLatency, reviewConcentration } = insights;
  const unreviewed = totals.pullRequestsUnreviewed;
  // A capped window carries floor counts and deliberately withholds the median
  // and the concentration share. Rendering a null there as "no reviews" would
  // be a different claim from the true one, and a percentage from floor
  // counts would be a number from a biased slice, so every signal goes neutral.
  const capped = !insights.sampleComplete;
  // The review figures are computed over human-authored pull requests only,
  // so the denominator here has to be the same population. Dividing by every
  // merged pull request, bots included, lets a dependency-bump-heavy window
  // read as healthy when every human pull request in it went unreviewed.
  const humanMerged = totals.pullRequestsReviewed + totals.pullRequestsUnreviewed;

  const unreviewedShare = humanMerged === 0 ? 0 : unreviewed / humanMerged;
  const unreviewedTone: Tone =
    humanMerged === 0
      ? 'none'
      : unreviewedShare < UNREVIEWED_SHARE_GOOD_BELOW
        ? 'good'
        : unreviewedShare < UNREVIEWED_SHARE_WARN_BELOW
          ? 'warn'
          : 'bad';
  const unreviewedVerdict =
    humanMerged === 0 ? 'no data' : unreviewedTone === 'good' ? 'healthy' : unreviewedTone === 'warn' ? 'watch' : 'gap';

  const waitTone: Tone =
    reviewLatency === null
      ? 'none'
      : reviewLatency.medianHours < REVIEW_WAIT_GOOD_BELOW_HOURS
        ? 'good'
        : reviewLatency.medianHours < REVIEW_WAIT_WARN_BELOW_HOURS
          ? 'warn'
          : 'bad';
  const waitVerdict =
    reviewLatency === null ? 'no reviews' : waitTone === 'good' ? 'fast' : waitTone === 'warn' ? 'slow' : 'stalled';

  const topShare = reviewConcentration === null ? 0 : reviewConcentration.share;
  const topTone: Tone =
    reviewConcentration === null
      ? 'none'
      : topShare < TOP_REVIEWER_SHARE_GOOD_BELOW
        ? 'good'
        : topShare < TOP_REVIEWER_SHARE_WARN_BELOW
          ? 'warn'
          : 'bad';
  const topVerdict =
    reviewConcentration === null
      ? 'no reviews'
      : topTone === 'good'
        ? 'spread'
        : topTone === 'warn'
          ? 'leaning'
          : 'single point';

  return (
    <section className="block">
      <div className="block-head">
        <h2>
          <span className="repo-name">{insights.repository}</span>
        </h2>
        <span className="window">
          {insights.window.from.slice(0, 10)} to {insights.window.to.slice(0, 10)}
        </span>
      </div>
      {!insights.sampleComplete && (
        <p className="warning">
          This window exceeded the upstream result cap. The counts below are a floor, and the
          latency and concentration figures are withheld because a partial sample cannot produce an
          honest median.
        </p>
      )}
      <div className="signals">
        <Signal
          label="Merged without review"
          value={capped ? `at least ${unreviewed}` : humanMerged === 0 ? 'n/a' : `${unreviewed}`}
          // No denominator on a capped window. "At least 48 of 126" still
          // reads as a bounded ratio when both numbers are floors.
          unit={capped || humanMerged === 0 ? undefined : ` of ${humanMerged}`}
          tone={capped ? 'none' : unreviewedTone}
          verdict={capped ? 'incomplete' : unreviewedVerdict}
          note={
            capped
              ? `the window hit the upstream cap, so this and the at least ${humanMerged} merged by people are both floors, and no share is shown`
              : totals.pullRequestsMerged === 0
                ? 'nothing merged in this window'
                : humanMerged === 0
                  ? 'everything merged in this window was opened by a bot, so there is no review coverage to measure'
                  : `${Math.round(unreviewedShare * 100)}% merged with nobody but the author looking`
          }
        />
        <Signal
          label="Wait for first review"
          value={capped ? 'withheld' : reviewLatency === null ? 'n/a' : `${reviewLatency.medianHours}`}
          unit={capped || reviewLatency === null ? undefined : 'h median'}
          tone={capped ? 'none' : waitTone}
          verdict={capped ? 'incomplete' : waitVerdict}
          note={
            capped
              ? 'a median from a capped sample would be biased, so none is reported'
              : reviewLatency === null
                ? 'no pull request received an outside review'
                : `the slowest tenth waited ${reviewLatency.p90Hours}h or more, over ${reviewLatency.sampleSize} reviewed`
          }
        />
        <Signal
          label="Top reviewer share"
          value={capped ? 'withheld' : reviewConcentration === null ? 'n/a' : `${Math.round(reviewConcentration.share * 100)}`}
          unit={capped || reviewConcentration === null ? undefined : '%'}
          tone={capped ? 'none' : topTone}
          verdict={capped ? 'incomplete' : topVerdict}
          note={
            capped ? (
              'a share from a capped sample would be biased, so none is reported'
            ) : reviewConcentration === null ? (
              'nobody reviewed anything'
            ) : (
              <>
                <b>{reviewConcentration.topReviewer}</b> reviewed {reviewConcentration.pullRequestsReviewed} of the{' '}
                {reviewConcentration.denominator} that got any review
              </>
            )
          }
        />
      </div>
      <div className="counts">
        <span>
          <b>{totals.pullRequestsMerged}</b> merged
        </span>
        <span>
          <b>{totals.pullRequestsReviewed}</b> reviewed by someone else
        </span>
        <span>
          <b>{totals.contributors}</b> people
        </span>
        <span>
          <b>{totals.pullRequestsAuthoredByBots}</b> opened by bots, excluded from review figures
        </span>
      </div>
    </section>
  );
}

function Signal({
  label,
  value,
  unit,
  tone,
  verdict,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  tone: Tone;
  verdict: string;
  note: ReactNode;
}) {
  return (
    <div className="signal" data-tone={tone}>
      <div className="signal-top">
        <span className="signal-label">{label}</span>
        <span className="verdict">{verdict}</span>
      </div>
      <div className="signal-value">
        {value}
        {unit !== undefined && <small>{unit}</small>}
      </div>
      <div className="signal-note">{note}</div>
    </div>
  );
}

function Leaderboard({ insights }: { insights: Insights }) {
  const contributors = insights.contributors;
  const rows = contributors.slice(0, 20);
  const maxReviewed = Math.max(1, ...rows.map((r) => r.pullRequestsReviewed));
  return (
    <section className="block">
      <h3 className="eyebrow">Who authored and who reviewed</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Authored</th>
              <th>Reviewed</th>
              <th>Review submissions</th>
              <th>Inline comments</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.login}>
                <td className="person">
                  <span className="rank">{i + 1}</span>
                  {row.login}
                </td>
                <td>{row.pullRequestsAuthored}</td>
                <td className="bar-cell">
                  <i
                    className="bar"
                    style={{ width: `calc((100% - 4.4rem) * ${(row.pullRequestsReviewed / maxReviewed).toFixed(3)})` }}
                  />
                  <span>{row.pullRequestsReviewed}</span>
                </td>
                <td>{row.reviewsSubmitted}</td>
                <td>{row.reviewComments}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {contributors.length > 20 && <p className="table-foot">Showing the top 20 of {contributors.length}.</p>}
    </section>
  );
}

function NarrativePanel({ narrative }: { narrative: Narrative }) {
  const confidence = Math.round(narrative.hypothesis.confidence * 100);
  return (
    <section className="narrative">
      <div className="narrative-body">
        <p className="prose">{narrative.narrative}</p>
        <div className="cause">
          <div>
            <h3 className="eyebrow">Most likely cause</h3>
            <p className="prose">{narrative.hypothesis.statement}</p>
            <p className="prose reasoning">{narrative.hypothesis.reasoning}</p>
          </div>
          <div className="gauge">
            <span className="gauge-label">Confidence</span>
            <span className="gauge-number">
              {confidence}
              <small>%</small>
            </span>
            <div className="gauge-track">
              <div className="gauge-fill" style={{ width: `${confidence}%` }} />
            </div>
          </div>
        </div>
      </div>
      <div className="ledger">
        <div className="ledger-head">
          <h3 className="eyebrow">Evidence</h3>
          <p>Each claim names the metric it rests on. The value shown is the computed one.</p>
        </div>
        <ul className="evidence">
          {narrative.evidence.map((item, index) => (
            <li key={`${item.metric}-${index}`} className={item.grounded ? 'ok' : 'bad'}>
              <span className="mark">{item.grounded ? '✓' : '✕'}</span>
              <span className="evidence-claim">{item.claim}</span>
              <code>
                {item.metric} = <b>{item.value}{item.unit === 'hours' ? 'h' : ''}</b>
              </code>
              {item.problem !== undefined && <span className="evidence-problem">{item.problem}</span>}
            </li>
          ))}
        </ul>
        <div className="provenance">
          <span className="pill good">
            {narrative.grounding.evidenceGrounded} of {narrative.grounding.evidenceTotal} citations matched
          </span>
          {narrative.grounding.uncitedNumbersInNarrative.length > 0 && (
            // The numbers themselves, not a count. A reader auditing the prose
            // needs to know which figures have no citation behind them.
            <span className="pill warn">
              used without a citation: {narrative.grounding.uncitedNumbersInNarrative.join(', ')}
            </span>
          )}
          <span className="pill">
            {narrative.model.provider} · {narrative.model.name}
          </span>
          {narrative.model.attempts > 1 && <span className="pill">took {narrative.model.attempts} attempts</span>}
        </div>
      </div>
    </section>
  );
}

function ErrorPanel({ error }: { error: ApiError }) {
  return (
    <section className="error">
      <h3>{titleFor(error)}</h3>
      <p>{error.message}</p>
      {error.evidence !== undefined && (
        <ul className="evidence">
          {error.evidence
            .filter((item) => !item.grounded)
            .map((item, index) => (
              <li key={index} className="bad">
                <span className="mark">✕</span>
                <span className="evidence-claim">{item.claim}</span>
                <span className="evidence-problem">{item.problem}</span>
              </li>
            ))}
        </ul>
      )}
      {error.grounding !== undefined && error.grounding.unverifiedNumbersInNarrative.length > 0 && (
        <p>
          Numbers in the text that match nothing it cited:{' '}
          {error.grounding.unverifiedNumbersInNarrative.join(', ')}
        </p>
      )}
    </section>
  );
}

function titleFor(error: ApiError): string {
  switch (error.code) {
    case 'narrative_not_grounded':
      return 'The model quoted numbers that do not match the metrics';
    case 'repository_not_found':
      return 'No such repository';
    case 'private_repository':
      return 'Private repository';
    case 'narrative_unavailable':
      return 'No model configured';
    case 'unauthorized':
      return 'This server wants an API token';
    case 'no_data_in_window':
      return 'Nothing merged in this window';
    case 'upstream_rate_limited':
      return 'GitHub rate limit reached';
    default:
      return 'Something went wrong';
  }
}
