import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeInsights } from '../src/metrics/compute.js';
import type { PullRequestRecord, Window } from '../src/metrics/types.js';

/**
 * Generates every figure on the landing page, so a committed SVG can never
 * drift from the thing that produced it. `npm run figures` writes them,
 * `npm run figures:check` regenerates in memory and fails if any differs.
 *
 * Every line of text passes a fit guard at generation time. Text overflowing a
 * card border is the most common defect in a generated figure, and the guard
 * names the offending string rather than letting it ship.
 */

const VIEW_W = 1200;
const FONT_FLOOR = 22;

// A warm dark ground and one accent. Cards sit a step lighter than the ground
// with a hairline edge and an accent rail, kickers are mono capitals, and the
// numbers are the brightest thing on the sheet.
const ground = '#141413';
const panel = '#1F1E1D';
const line = '#3A3734';
const ink = '#F4F1EA';
const muted = '#B8B0A4';
const accent = '#CC785C';
const dim = '#6B645A';
const mono = 'SFMono-Regular,Menlo,Consolas,Liberation Mono,monospace';
const sans = 'Helvetica Neue,Helvetica,Arial,sans-serif';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Estimated rendered width: chars * size * 0.58, or 0.62 in bold, plus the letter spacing. */
function fits(text: string, size: number, boxWidth: number, pad: number, bold = false, where = '', spacing = 0): void {
  if (size < FONT_FLOOR) throw new Error(`font ${size} below the ${FONT_FLOOR} floor for "${text}" ${where}`);
  const est = text.length * size * (bold ? 0.62 : 0.58) + Math.max(text.length - 1, 0) * spacing;
  if (est > boxWidth - 2 * pad) {
    throw new Error(`text does not fit ${where}: "${text}" needs ${Math.round(est)} of ${boxWidth - 2 * pad}`);
  }
}

interface TextOpts { size: number; fill?: string; weight?: number; family?: string; anchor?: string; spacing?: number; upper?: boolean }

function text(x: number, y: number, s: string, opts: TextOpts): string {
  const t = opts.upper ? s.toUpperCase() : s;
  return `<text x="${x}" y="${y}" font-family="${opts.family ?? sans}" font-size="${opts.size}" fill="${opts.fill ?? ink}"` +
    `${opts.weight ? ` font-weight="${opts.weight}"` : ''}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}` +
    `${opts.spacing ? ` letter-spacing="${opts.spacing}"` : ''}>${esc(t)}</text>`;
}

/** The dark sheet every figure sits on, full bleed. */
function sheet(h: number): string {
  return `<rect x="0" y="0" width="${VIEW_W}" height="${h}" fill="${ground}"/>`;
}

/** A card a step up from the ground, with an accent rail down its left edge. */
function card(x: number, y: number, w: number, h: number, rail = true): string {
  const box = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${panel}" stroke="${line}" stroke-width="1.5"/>`;
  return rail ? `${box}<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>` : box;
}

/* ---------------- hero ---------------- */

interface HeroCard { code: string; question: [string, string]; label: string; value: string; foot: string }

export function hero(cards: HeroCard[], footer: string): string {
  const H = 460;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${H}" width="100%" role="img" aria-label="Review insights">`);
  parts.push(sheet(H));
  parts.push(`<rect x="0" y="0" width="${VIEW_W}" height="4" fill="${accent}"/>`);

  const kicker = 'three review signals / one fact table / every number checked';
  fits(kicker, 22, VIEW_W, 48, false, 'hero kicker', 3);
  parts.push(text(48, 50, kicker, { size: 22, family: mono, fill: muted, spacing: 3, upper: true }));

  const title = 'How does a team review its own work?';
  fits(title, 44, VIEW_W, 48, true, 'hero title');
  parts.push(text(48, 102, title, { size: 44, weight: 700 }));

  const sub = 'Three signals from merged pull requests, and a narrative held to them.';
  fits(sub, 24, VIEW_W, 48, false, 'hero subtitle');
  parts.push(text(48, 142, sub, { size: 24, fill: muted }));

  const cardW = 352, cardH = 232, gap = 24, top = 168;
  if (cards.length !== 3) throw new Error(`the hero is laid out for three cards, got ${cards.length}`);
  cards.forEach((c, i) => {
    const x = 48 + i * (cardW + gap);
    parts.push(card(x, top, cardW, cardH));
    const tx = x + 22;
    fits(c.code, 22, cardW, 22, true, `hero card ${i} code`, 2);
    parts.push(text(tx, top + 40, c.code, { size: 22, family: mono, weight: 700, fill: accent, spacing: 2, upper: true }));
    c.question.forEach((q, j) => {
      fits(q, 22, cardW, 22, true, `hero card ${i} question line ${j}`);
      parts.push(text(tx, top + 82 + j * 30, q, { size: 22, weight: 700 }));
    });
    fits(c.label, 22, cardW, 22, false, `hero card ${i} label`, 1.5);
    parts.push(text(tx, top + 152, c.label, { size: 22, family: mono, fill: muted, spacing: 1.5, upper: true }));
    fits(c.value, 26, cardW, 22, true, `hero card ${i} value`);
    parts.push(text(tx, top + 186, c.value, { size: 26, weight: 700 }));
    fits(c.foot, 22, cardW, 22, false, `hero card ${i} foot`);
    parts.push(text(tx, top + 216, c.foot, { size: 22, family: mono, fill: muted }));
  });

  fits(footer, 22, VIEW_W, 48, false, 'hero footer');
  parts.push(text(48, 438, footer, { size: 22, family: mono, fill: muted }));
  parts.push('</svg>');
  return parts.join('\n');
}

/* ---------------- system map ---------------- */

interface Section { code: string; label: string; note: string; title: string; lines: string[]; foot: string }

export function systemMap(sections: Section[], stat: [string, string], closing: string): string {
  // Height follows the content, one full-width card per stage.
  const cardH = (s: Section): number => 64 + s.lines.length * 34 + 36;
  const top = 204;
  const H = sections.reduce((y, s) => y + 18 + cardH(s) + 48, top) + 26;
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${H}" width="100%" role="img" aria-label="System map">`);
  p.push(sheet(H));
  p.push(`<rect x="0" y="0" width="8" height="${H}" fill="${accent}"/>`);
  p.push(text(48, 56, 'request path', { size: 22, family: mono, weight: 700, fill: accent, spacing: 4, upper: true }));
  const title = 'How a request flows';
  fits(title, 44, 700, 0, true, 'map title');
  p.push(text(48, 108, title, { size: 44, weight: 700 }));
  const sub = 'Fetch, compute, then hold the narrative to the numbers.';
  fits(sub, 24, VIEW_W, 48, false, 'map subtitle');
  p.push(text(48, 156, sub, { size: 24, fill: muted }));

  const box = { x: 746, y: 40, w: 430, h: 96 };
  p.push(card(box.x, box.y, box.w, box.h, false));
  fits(stat[0], 22, box.w, 22, false, 'stat box line 1');
  fits(stat[1], 22, box.w, 22, false, 'stat box line 2');
  p.push(text(box.x + 22, box.y + 40, stat[0], { size: 22, family: mono }));
  p.push(text(box.x + 22, box.y + 76, stat[1], { size: 22, family: mono }));

  const cardX = 48, cardW = VIEW_W - 96;
  let y = top;
  for (const s of sections) {
    const head = `${s.code}  ${s.label}`;
    fits(head, 22, 262, 0, true, `section ${s.code} head`, 2);
    p.push(text(cardX, y, head, { size: 22, family: mono, weight: 700, fill: accent, spacing: 2, upper: true }));
    fits(s.note, 22, VIEW_W - 310 - 48, 0, false, `section ${s.code} note`);
    p.push(text(310, y, s.note, { size: 22, family: mono, fill: muted }));
    const h = cardH(s);
    const cy = y + 18;
    p.push(card(cardX, cy, cardW, h));
    fits(s.title, 26, cardW, 26, true, `section ${s.code} title`);
    p.push(text(cardX + 26, cy + 44, s.title, { size: 26, weight: 700 }));
    s.lines.forEach((ln, j) => {
      fits(ln, 22, cardW, 26, false, `section ${s.code} line ${j}`);
      p.push(text(cardX + 26, cy + 82 + j * 34, ln, { size: 22 }));
    });
    fits(s.foot, 22, cardW, 26, false, `section ${s.code} foot`);
    p.push(text(cardX + 26, cy + h - 18, s.foot, { size: 22, family: mono, fill: muted }));
    y = cy + h + 48;
  }
  fits(closing, 22, VIEW_W, 48, false, 'map closing');
  p.push(text(48, H - 30, closing, { size: 22, family: mono, fill: muted }));
  p.push('</svg>');
  return p.join('\n');
}

/* ---------------- eval panel, fed by evals/last-run.json ---------------- */

interface RunSummary { provider: string; model: string; cases: { name: string; passed: number; total: number }[]; passed: number; total: number }
interface LastRun { runs: RunSummary[] }

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export function evalPanel(run: LastRun): string {
  if (run.runs.length === 0) throw new Error('evals/last-run.json names no runs');
  const ROW = 54;
  const blockH = (r: RunSummary): number => 40 + ROW * r.cases.length + 24;
  const panelTop = 122;
  const panelH = run.runs.reduce((h, r) => h + blockH(r), 0) + 30;
  const H = panelTop + panelH + 78;
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${H}" width="100%" role="img" aria-label="Eval run">`);
  p.push(sheet(H));
  const title = 'What the latest eval run scored';
  fits(title, 30, VIEW_W, 48, true, 'eval title');
  p.push(text(48, 58, title, { size: 30, weight: 700 }));
  const first = run.runs[0] as RunSummary;
  const cases = COUNT_WORDS[first.cases.length] ?? String(first.cases.length);
  const models = COUNT_WORDS[run.runs.length] ?? String(run.runs.length);
  const sub = `${cases} frozen cases, five checks each, ${models} model${run.runs.length === 1 ? '' : 's'}, one run of npm run eval each`;
  fits(sub, 22, VIEW_W, 48, false, 'eval subtitle');
  p.push(text(48, 94, sub, { size: 22, fill: muted }));
  p.push(card(48, panelTop, VIEW_W - 96, panelH, false));

  const labelX = 500, barX = 518, barW = 480;
  let y = panelTop + 40;
  for (const r of run.runs) {
    const head = `${r.model}, ${r.passed} of ${r.total}`;
    fits(head, 22, VIEW_W - 96, 26, true, `eval block ${r.model}`, 1);
    p.push(text(74, y, head, { size: 22, family: mono, weight: 700, fill: accent, spacing: 1 }));
    r.cases.forEach((c, i) => {
      const cy = y + ROW * (i + 1);
      fits(c.name, 22, labelX - 74, 0, false, `case ${c.name}`);
      p.push(text(labelX, cy, c.name, { size: 22, anchor: 'end' }));
      const w = Math.max(3, Math.round((c.passed / Math.max(c.total, 1)) * barW));
      p.push(`<rect x="${barX}" y="${cy - 18}" width="${w}" height="24" rx="2" fill="${c.passed === c.total ? accent : dim}"/>`);
      p.push(text(barX + w + 17, cy, `${c.passed} of ${c.total}`, { size: 22 }));
    });
    y += blockH(r);
  }
  const foot = 'evals/last-run.json, written by npm run eval, redrawn by npm run figures';
  fits(foot, 22, VIEW_W, 48, false, 'eval footer');
  p.push(text(48, H - 30, foot, { size: 22, family: mono, fill: muted }));
  p.push('</svg>');
  return p.join('\n');
}

/* ---------------- eval sample, fed by evals/sample.json ---------------- */

interface Sample { model: string; runs: { passed: number; total: number }[]; comparison?: Sample }

/**
 * The median pass rate over the committed sample, so the hero footer and the
 * README badge have a producer rather than a typed number. Even counts average
 * the middle pair, the same rule the metrics use.
 */
export function sampleMedian(sample: Sample): { percent: number; runs: number } {
  const rates = sample.runs.map((r) => (r.passed / r.total) * 100).sort((a, b) => a - b);
  if (rates.length === 0) throw new Error('evals/sample.json names no runs');
  const mid = Math.floor(rates.length / 2);
  const upper = rates[mid] as number;
  const lower = rates.length % 2 === 0 ? (rates[mid - 1] as number) : upper;
  return { percent: Math.round(((lower + upper) / 2) * 10) / 10, runs: rates.length };
}

const SAMPLE_RAW = JSON.parse(readFileSync('evals/sample.json', 'utf8')) as Sample;
const SAMPLE = sampleMedian(SAMPLE_RAW);
if (SAMPLE_RAW.comparison === undefined) throw new Error('evals/sample.json carries no comparison sample for the second column of the eval record');
const COMPARISON_RAW = SAMPLE_RAW.comparison;
const COMPARISON = sampleMedian(COMPARISON_RAW);

/* ---------------- the hono figures, recomputed from the frozen payload ---------------- */

interface HonoFigures { share: number; unreviewed: number; merged: number; reviewed: number; topReviewed: number; medianHours: number; p90Hours: number }

/** Every number the hero states about hono, recomputed from the payload the eval cases use. */
function honoFigures(): HonoFigures {
  const frozen = JSON.parse(readFileSync('evals/cases/raw/honojs-hono.json', 'utf8')) as { window: Window; pullRequests: PullRequestRecord[] };
  const insights = computeInsights('honojs/hono', frozen.pullRequests, frozen.window);
  if (insights.reviewConcentration === null || insights.reviewLatency === null) throw new Error('hono payload has no derived statistics');
  return {
    share: Math.round(insights.reviewConcentration.share * 100),
    unreviewed: insights.totals.pullRequestsUnreviewed,
    merged: insights.totals.pullRequestsMerged,
    reviewed: insights.reviewConcentration.denominator,
    topReviewed: insights.reviewConcentration.pullRequestsReviewed,
    medianHours: Math.round(insights.reviewLatency.medianHours),
    p90Hours: Math.round(insights.reviewLatency.p90Hours),
  };
}

/** The test count is measured by running the suite, so the figure cannot outlive a deleted test. */
function testCount(): number {
  const out = join(tmpdir(), `figures-vitest-${process.pid}.json`);
  execFileSync('npx', ['vitest', 'run', '--reporter=json', '--outputFile', out], { stdio: 'ignore' });
  const report = JSON.parse(readFileSync(out, 'utf8')) as { numTotalTests: number; numFailedTests: number };
  if (report.numFailedTests > 0) throw new Error(`${report.numFailedTests} tests failed, so no figure is drawn from that run`);
  return report.numTotalTests;
}

const HONO = honoFigures();
const TESTS = testCount();

/* ---------------- entry ---------------- */

function build(): Record<string, string> {
  const out: Record<string, string> = {};
  const label = 'hono, summer 2026';
  out['assets/hero.svg'] = hero(
    [
      { code: '01 unreviewed', question: ['How much merges with', 'nobody else looking?'], label, value: `${HONO.unreviewed} of ${HONO.merged}`, foot: 'merged without review' },
      { code: '02 wait', question: ['When review comes,', 'how long did it sit?'], label, value: `${HONO.medianHours} h median`, foot: `p90 at ${HONO.p90Hours} h` },
      { code: '03 share', question: ['Is review shared, or', "one person's job?"], label, value: `${HONO.topReviewed} of ${HONO.reviewed}`, foot: `one reviewer, ${HONO.share}%` },
    ],
    `${TESTS} tests  ·  eval median ${SAMPLE.percent}% over ${SAMPLE.runs} runs  ·  redrawn by tools/figures.ts`,
  );
  out['assets/system-map.svg'] = systemMap(
    [
      {
        code: '01', label: 'fetch', note: 'one GraphQL search, the merged qualifier does the window',
        title: 'GitHubClient, src/github/client.ts',
        lines: [
          'one search query with the merged range as its qualifier, 50 pull requests a page',
          'authors and reviewers typed by __typename, so a Bot is a Bot whatever its login',
          '404 when the repository is missing, 403 when private, 429 when GitHub rate limits',
        ],
        foot: 'GET /v1/insights?repo=honojs/hono&from=2026-06-01&to=2026-09-01',
      },
      {
        code: '02', label: 'compute', note: 'a pure function, no network, no clock, no database',
        title: 'computeInsights, src/metrics/compute.ts',
        lines: [
          'half open, [from, to), so a merge at the to instant belongs to the next period',
          "self review never counts, and a bot's pull request leaves every review figure",
          'reviewed plus unreviewed plus bot authored equals merged, and a test asserts it',
        ],
        foot: 'every counting rule pinned by a fixture in test/metrics.test.ts',
      },
      {
        code: '03', label: 'ground', note: 'a fact table in, JSON out, every citation looked up',
        title: 'generateNarrative, src/llm/narrative.ts',
        lines: [
          'a fact per number, id, value and unit, and the model may cite nothing else',
          'each citation compared exactly, every number in the prose matched to the table',
          'a mismatch gets one retry with the mismatch named, then a 502, never a 200',
        ],
        foot: 'GET /v1/insights/narrative, same query, the answer beside the metrics it cites',
      },
    ],
    [`2 endpoints / ${TESTS} tests green`, 'suite: no network, no key'],
    'drawn by tools/figures.ts, npm run figures:check fails when a figure drifts',
  );
  const runPath = 'evals/last-run.json';
  if (existsSync(runPath)) {
    out['assets/eval-panel.svg'] = evalPanel(JSON.parse(readFileSync(runPath, 'utf8')) as LastRun);
  }
  return out;
}

const check = process.argv.includes('--check');
const files = build();
let drift = 0;
mkdirSync('assets', { recursive: true });
for (const [path, svg] of Object.entries(files)) {
  if (check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== svg) { console.error(`drift: ${path} differs from its generator`); drift += 1; }
    else console.log(`ok: ${path}`);
  } else {
    writeFileSync(path, svg);
    console.log(`wrote ${path} (${svg.length} bytes)`);
  }
}
if (check) {
  // The badges, the tables and the prose carry the same numbers by hand, so the
  // check holds the README and NOTES to the measured values rather than the typing.
  const runs = `${COUNT_WORDS[SAMPLE.runs] ?? SAMPLE.runs} runs`;
  // Every row of the eval record, both columns, and its median line.
  if (COMPARISON_RAW.runs.length !== SAMPLE_RAW.runs.length) throw new Error('the two eval samples have different run counts, so the record table cannot pair them');
  const sampleRows = SAMPLE_RAW.runs.map((r, i) => {
    const c = COMPARISON_RAW.runs[i] as { passed: number; total: number };
    return `| ${i + 1} | ${r.passed} of ${r.total} | ${c.passed} of ${c.total} |`;
  });
  sampleRows.push(`| Median | ${SAMPLE.percent}% | ${COMPARISON.percent}% |`);
  const tail = `past ${COUNT_WORDS[Math.floor(HONO.p90Hours / 24)] ?? Math.floor(HONO.p90Hours / 24)} days`;
  const held: [string, string[]][] = [
    ['README.md', [
      `eval_median-${SAMPLE.percent}%25_over_${SAMPLE.runs}_runs`,
      `a median of ${SAMPLE.percent}%`,
      runs,
      `tests-${TESTS}_`,
      `${TESTS} tests`,
      `${HONO.share}%`,
      `${HONO.unreviewed} of ${HONO.merged}`,
      `${HONO.topReviewed} of ${HONO.reviewed}`,
      `${HONO.medianHours} hours`,
      tail,
      ...sampleRows,
    ]],
    ['NOTES.md', [
      `${TESTS} tests`,
      `${HONO.share}%`,
      `a median of ${SAMPLE.percent}%`,
      `a median of ${COMPARISON.percent}%`,
      runs,
      `${HONO.unreviewed} of ${HONO.merged}`,
      `${HONO.topReviewed} of ${HONO.reviewed}`,
      `${HONO.medianHours} hour median`,
      `${HONO.p90Hours} hour`,
    ]],
  ];
  for (const [doc, needles] of held) {
    const body = readFileSync(doc, 'utf8');
    for (const needle of needles) {
      if (body.includes(needle)) console.log(`ok: ${doc} carries "${needle}"`);
      else { console.error(`drift: ${doc} does not carry "${needle}"`); drift += 1; }
    }
  }
}
if (check && drift > 0) process.exit(1);
