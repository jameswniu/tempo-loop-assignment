import { useRef, useState, type FormEvent } from 'react';
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

  return (
    <main>
      <header>
        <h1>Review insights</h1>
        <p className="lede">
          How a repository reviews its own work, over a window. Every number below is computed from
          merged pull requests, and the written explanation may only cite numbers from this page.
        </p>
      </header>

      <form onSubmit={loadMetrics}>
        <label>
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
        <label className="token">
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
          {loading ? 'Loading' : 'Load metrics'}
        </button>
      </form>

      {error !== null && <ErrorPanel error={error} />}
      {insights !== null && (
        <>
          <Summary insights={insights} />
          <Leaderboard insights={insights} />
          <section className="explain">
            <button onClick={explain} disabled={narrating}>
              {narrating ? 'Asking the model' : 'Explain these numbers'}
            </button>
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
  return (
    <section>
      <h2>{insights.repository}</h2>
      {!insights.sampleComplete && (
        <p className="warning">
          This window exceeded the upstream result cap. The counts below are a floor, and the
          latency and concentration figures are withheld because a partial sample cannot produce an
          honest median.
        </p>
      )}
      <div className="cards">
        <Card label="Merged" value={totals.pullRequestsMerged} note="pull requests in this window" />
        <Card
          label="Reviewed"
          value={totals.pullRequestsReviewed}
          note="saw a review from someone other than the author"
        />
        <Card
          label="Unreviewed"
          value={totals.pullRequestsUnreviewed}
          note="merged with nobody else looking"
          alarming={totals.pullRequestsMerged > 0 && totals.pullRequestsUnreviewed / totals.pullRequestsMerged > 0.25}
        />
        <Card
          label="Median wait"
          value={reviewLatency === null ? null : `${reviewLatency.medianHours}h`}
          note={reviewLatency === null ? 'no reviewed pull requests' : `to a first review, over ${reviewLatency.sampleSize}`}
        />
        <Card
          label="p90 wait"
          value={reviewLatency === null ? null : `${reviewLatency.p90Hours}h`}
          note="the slowest tenth waited at least this long"
        />
        <Card
          label="Top reviewer share"
          value={reviewConcentration === null ? null : `${Math.round(reviewConcentration.share * 100)}%`}
          note={
            reviewConcentration === null
              ? 'nobody reviewed anything'
              : `${reviewConcentration.topReviewer}, on ${reviewConcentration.pullRequestsReviewed} of ${reviewConcentration.denominator} reviewed`
          }
          alarming={reviewConcentration !== null && reviewConcentration.share > 0.8}
        />
      </div>
      <p className="footnote">
        {totals.pullRequestsAuthoredByBots} of the merged pull requests were opened by a bot and are
        left out of every review figure. {totals.botAccountsExcluded} bot accounts were excluded
        from the table below.
      </p>
    </section>
  );
}

function Card({
  label,
  value,
  note,
  alarming = false,
}: {
  label: string;
  value: number | string | null;
  note: string;
  alarming?: boolean;
}) {
  return (
    <div className={`card${alarming ? ' card-alarming' : ''}`}>
      <span className="card-label">{label}</span>
      <span className="card-value">{value ?? 'n/a'}</span>
      <span className="card-note">{note}</span>
    </div>
  );
}

function Leaderboard({ insights }: { insights: Insights }) {
  return (
    <section>
      <h3>Who authored and who reviewed</h3>
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
            {insights.contributors.slice(0, 20).map((row) => (
              <tr key={row.login}>
                <td>{row.login}</td>
                <td>{row.pullRequestsAuthored}</td>
                <td>{row.pullRequestsReviewed}</td>
                <td>{row.reviewsSubmitted}</td>
                <td>{row.reviewComments}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {insights.contributors.length > 20 && (
        <p className="footnote">Showing the top 20 of {insights.contributors.length}.</p>
      )}
    </section>
  );
}

function NarrativePanel({ narrative }: { narrative: Narrative }) {
  const confidence = Math.round(narrative.hypothesis.confidence * 100);
  return (
    <section className="narrative">
      <p className="prose">{narrative.narrative}</p>

      <h3>Most likely cause</h3>
      <p className="prose">{narrative.hypothesis.statement}</p>
      <div className="confidence">
        <div className="confidence-bar">
          <div className="confidence-fill" style={{ width: `${confidence}%` }} />
        </div>
        <span>{confidence}% confident</span>
      </div>
      <p className="prose muted">{narrative.hypothesis.reasoning}</p>

      <h3>Evidence</h3>
      <ul className="evidence">
        {narrative.evidence.map((item, index) => (
          <li key={`${item.metric}-${index}`} className={item.grounded ? 'ok' : 'bad'}>
            <span className="evidence-claim">{item.claim}</span>
            <code>
              {item.metric} = {item.value}
              {item.unit === 'hours' ? 'h' : ''}
            </code>
            {item.problem !== undefined && <span className="evidence-problem">{item.problem}</span>}
          </li>
        ))}
      </ul>

      <p className="footnote">
        {narrative.grounding.evidenceGrounded} of {narrative.grounding.evidenceTotal} citations were
        checked against the computed metrics and matched. Written by {narrative.model.provider}{' '}
        {narrative.model.name}
        {narrative.model.attempts > 1 ? `, after ${narrative.model.attempts} attempts` : ''}.
      </p>
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
