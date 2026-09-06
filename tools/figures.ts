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

const ink = '#0f1319';
const paper = '#ffffff';
const silver = { top: '#f5f5f5', mid: '#d4d4d8', low: '#a1a1aa' };
const accent = '#345c8f';
const good = '#1a7f37';
const grayText = '#8b949e';
const mono = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const sans = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Estimated rendered width: chars * size * 0.58, or 0.62 in bold. */
function fits(text: string, size: number, boxWidth: number, pad: number, bold = false, where = ''): void {
  if (size < FONT_FLOOR) throw new Error(`font ${size} below the ${FONT_FLOOR} floor for "${text}" ${where}`);
  const est = text.length * size * (bold ? 0.62 : 0.58);
  if (est > boxWidth - 2 * pad) {
    throw new Error(`text does not fit ${where}: "${text}" needs ${Math.round(est)} of ${boxWidth - 2 * pad}`);
  }
}

function text(x: number, y: number, s: string, opts: { size: number; fill?: string; weight?: number; family?: string; anchor?: string; spacing?: number; upper?: boolean }): string {
  const t = opts.upper ? s.toUpperCase() : s;
  return `<text x="${x}" y="${y}" font-family="${opts.family ?? sans}" font-size="${opts.size}" fill="${opts.fill ?? paper}"` +
    `${opts.weight ? ` font-weight="${opts.weight}"` : ''}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}` +
    `${opts.spacing ? ` letter-spacing="${opts.spacing}"` : ''}>${esc(t)}</text>`;
}

const rimDefs = `<defs><linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${silver.top}"/><stop offset="0.5" stop-color="${silver.mid}"/><stop offset="1" stop-color="${silver.low}"/>` +
  `</linearGradient></defs>`;

function card(x: number, y: number, w: number, h: number, fill = '#161b22'): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="url(#rim)" stroke-width="1.5"/>` +
    `<rect x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="1" fill="#ffffff" fill-opacity="0.18"/>`;
}

/* ---------------- hero ---------------- */

interface Tile { number: string; caption: string }

export function hero(tiles: Tile[], footer: string): string {
  // The footer gets its own baseline under the stage pills. Sharing one put
  // the right-anchored command text straight through the last three pills,
  // which the per-string fit guard cannot see because each string fit its own
  // box. Collisions between elements need their own check, below.
  const H = 484;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${H}" width="100%" role="img" aria-label="Review insights">`);
  parts.push(rimDefs);
  parts.push(`<rect width="${VIEW_W}" height="${H}" fill="${ink}"/>`);
  parts.push(`<rect x="0" y="0" width="6" height="${H}" fill="${accent}"/>`);

  const kicker = 'every number checked';
  fits(kicker, 22, VIEW_W, 56, false, 'hero kicker');
  parts.push(text(56, 64, kicker, { size: 22, family: mono, fill: grayText, spacing: 4, upper: true }));

  const title = 'Review insights';
  fits(title, 60, VIEW_W, 56, true, 'hero title');
  parts.push(text(56, 132, title, { size: 60, weight: 700 }));

  const sub = 'A narrative that may only cite what the page computed.';
  fits(sub, 26, VIEW_W, 56, false, 'hero subtitle');
  parts.push(text(56, 176, sub, { size: 26, fill: '#c9d1d9' }));

  const tileW = 340, tileH = 122, gap = 34, top = 214;
  tiles.forEach((t, i) => {
    const x = 56 + i * (tileW + gap);
    parts.push(card(x, top, tileW, tileH));
    fits(t.number, 54, tileW, 22, true, `tile ${i} number`);
    parts.push(text(x + 22, top + 66, t.number, { size: 54, weight: 700 }));
    fits(t.caption, 22, tileW, 22, false, `tile ${i} caption`);
    parts.push(text(x + 22, top + 100, t.caption, { size: 22, fill: grayText }));
  });

  const stages = ['fetch', 'compute', 'fact table', 'model', 'check', 'answer'];
  const highlight = 'check';
  let px = 56;
  const py = 372;
  for (const s of stages) {
    const w = Math.round(s.length * 22 * 0.62) + 36;
    const hot = s === highlight;
    parts.push(`<rect x="${px}" y="${py - 26}" width="${w}" height="38" rx="19" fill="${hot ? accent : '#161b22'}" stroke="${hot ? accent : silver.low}" stroke-width="1"/>`);
    fits(s, 22, w, 18, false, `stage pill ${s}`);
    parts.push(text(px + w / 2, py, s, { size: 22, family: mono, anchor: 'middle', fill: hot ? paper : '#c9d1d9' }));
    px += w + 14;
  }
  if (px - 14 > VIEW_W - 56) throw new Error(`stage pills overrun the right margin by ${px - 14 - (VIEW_W - 56)}`);

  fits(footer, 22, VIEW_W, 56, false, 'hero footer');
  parts.push(text(56, 438, footer, { size: 22, family: mono, fill: grayText }));
  parts.push('</svg>');
  return parts.join('\n');
}

/* ---------------- system map ---------------- */

interface Section { code: string; label: string; note: string; cards: { title: string; lines: string[]; foot: string }[] }

export function systemMap(sections: Section[]): string {
  // Height follows the content. A fixed canvas left two hundred units of dead
  // band under the cards, which reads as an unfinished figure.
  const columnBottom = (s: Section): number =>
    190 + 52 + s.cards.reduce((y, c) => y + 64 + c.lines.length * 30 + 34 + 18, 0) - 18;
  const H = Math.max(...sections.map(columnBottom)) + 56;
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${H}" width="100%" role="img" aria-label="System map">`);
  p.push(rimDefs);
  p.push(`<rect width="${VIEW_W}" height="${H}" fill="${ink}"/>`);
  p.push(`<rect x="0" y="0" width="6" height="${H}" fill="${accent}"/>`);
  p.push(text(56, 58, 'system map', { size: 22, family: mono, fill: grayText, spacing: 4, upper: true }));
  const title = 'One query in, one checked answer';
  fits(title, 40, 820, 0, true, 'map title');
  p.push(text(56, 108, title, { size: 40, weight: 700 }));
  const sub = 'The last layer refuses what it cannot trace to the first.';
  fits(sub, 24, 820, 0, false, 'map subtitle');
  p.push(text(56, 144, sub, { size: 24, fill: '#c9d1d9' }));

  const box = { x: 900, y: 40, w: 244, h: 84 };
  p.push(card(box.x, box.y, box.w, box.h));
  const stat1 = '2 endpoints';
  const stat2 = 'N / 50 calls';
  fits(stat1, 26, box.w, 18, true, 'stat box 1');
  fits(stat2, 22, box.w, 18, false, 'stat box 2');
  p.push(text(box.x + 18, box.y + 36, stat1, { size: 26, weight: 700 }));
  p.push(text(box.x + 18, box.y + 68, stat2, { size: 22, family: mono, fill: grayText }));

  const colW = 340, gapX = 34, top = 190;
  sections.forEach((s, i) => {
    const x = 56 + i * (colW + gapX);
    p.push(text(x, top, `${s.code}  ${s.label}`, { size: 22, family: mono, fill: accent === '#345c8f' ? '#7aa2d4' : accent, spacing: 2, upper: true }));
    fits(s.note, 22, colW, 0, false, `section ${s.code} note`);
    p.push(text(x, top + 30, s.note, { size: 22, fill: grayText }));
    let y = top + 52;
    for (const c of s.cards) {
      const h = 64 + c.lines.length * 30 + 34;
      p.push(card(x, y, colW, h));
      fits(c.title, 26, colW, 20, true, `card ${c.title}`);
      p.push(text(x + 20, y + 40, c.title, { size: 26, weight: 700 }));
      c.lines.forEach((ln, j) => {
        fits(ln, 22, colW, 20, false, `card ${c.title} line ${j}`);
        p.push(text(x + 20, y + 74 + j * 30, ln, { size: 22, fill: '#c9d1d9' }));
      });
      fits(c.foot, 22, colW, 20, false, `card ${c.title} foot`);
      p.push(text(x + 20, y + h - 18, c.foot, { size: 22, family: mono, fill: grayText }));
      y += h + 18;
    }
  });
  p.push('</svg>');
  return p.join('\n');
}

/* ---------------- eval panel, fed by evals/last-run.json ---------------- */

interface RunSummary { provider: string; model: string; cases: { name: string; passed: number; total: number }[]; passed: number; total: number }
interface LastRun { runs: RunSummary[] }

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** One block per provider that ran, so a degraded provider is drawn rather than overwritten. */
function evalBlock(p: string[], run: RunSummary, top: number, first: boolean): number {
  const head = first ? 108 : 60;
  const title = `${run.passed} of ${run.total} checks passed`;
  fits(title, 40, 800, 0, true, `eval title ${run.model}`);
  p.push(text(56, top + head, title, { size: 40, weight: 700 }));
  const count = COUNT_WORDS[run.cases.length] ?? String(run.cases.length);
  const sub = `${run.model}, ${count} frozen cases, every check exact`;
  fits(sub, 22, 1090, 0, false, `eval subtitle ${run.model}`);
  p.push(text(56, top + head + 32, sub, { size: 22, family: mono, fill: grayText }));

  const barX = 520, barW = 560;
  run.cases.forEach((c, i) => {
    const y = top + head + 82 + i * 58;
    fits(c.name, 24, barX - 56, 0, false, `case ${c.name}`);
    p.push(text(56, y + 8, c.name, { size: 24, fill: '#c9d1d9' }));
    p.push(`<rect x="${barX}" y="${y - 14}" width="${barW}" height="28" fill="#161b22" stroke="url(#rim)" stroke-width="1"/>`);
    const w = Math.round((c.passed / Math.max(c.total, 1)) * barW);
    p.push(`<rect x="${barX}" y="${y - 14}" width="${w}" height="28" fill="${c.passed === c.total ? good : accent}"/>`);
    p.push(text(barX + barW + 16, y + 8, `${c.passed}/${c.total}`, { size: 24, family: mono, fill: paper }));
  });
  return head + 42 + run.cases.length * 58;
}

export function evalPanel(run: LastRun): string {
  if (run.runs.length === 0) throw new Error('evals/last-run.json names no runs');
  const GAP = 20;
  const heights = run.runs.map((r, i) => (i === 0 ? 108 : 60) + 42 + r.cases.length * 58);
  const H = heights.reduce((s, h) => s + h, 0) + GAP * (run.runs.length - 1) + 70;
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${H}" width="100%" role="img" aria-label="Eval run">`);
  p.push(rimDefs);
  p.push(`<rect width="${VIEW_W}" height="${H}" fill="${ink}"/>`);
  p.push(`<rect x="0" y="0" width="6" height="${H}" fill="${accent}"/>`);
  p.push(text(56, 58, 'eval run', { size: 22, family: mono, fill: grayText, spacing: 4, upper: true }));
  let top = 0;
  run.runs.forEach((r, i) => {
    if (i > 0) {
      p.push(`<line x1="56" y1="${top + GAP / 2}" x2="${VIEW_W - 56}" y2="${top + GAP / 2}" stroke="url(#rim)" stroke-width="1"/>`);
      top += GAP;
    }
    top += evalBlock(p, r, top, i === 0);
  });
  const foot = 'npm run eval   (writes evals/last-run.json, which drew this panel)';
  fits(foot, 22, VIEW_W, 56, false, 'eval footer');
  p.push(text(56, H - 30, foot, { size: 22, family: mono, fill: grayText }));
  p.push('</svg>');
  return p.join('\n');
}

/* ---------------- eval sample, fed by evals/sample.json ---------------- */

interface Sample { model: string; runs: { passed: number; total: number }[] }

/**
 * The median pass rate over the committed sample, so the hero tile and the
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

const SAMPLE = sampleMedian(JSON.parse(readFileSync('evals/sample.json', 'utf8')) as Sample);

/* ---------------- the other two hero numbers, each measured ---------------- */

/** The top reviewer's share on hono, recomputed from the frozen payload the eval cases use. */
function honoShare(): number {
  const frozen = JSON.parse(readFileSync('evals/cases/raw/honojs-hono.json', 'utf8')) as { window: Window; pullRequests: PullRequestRecord[] };
  const insights = computeInsights('honojs/hono', frozen.pullRequests, frozen.window);
  if (insights.reviewConcentration === null) throw new Error('hono payload has no concentration figure');
  return Math.round(insights.reviewConcentration.share * 100);
}

/** The test count is measured by running the suite, so the tile cannot outlive a deleted test. */
function testCount(): number {
  const out = join(tmpdir(), `figures-vitest-${process.pid}.json`);
  execFileSync('npx', ['vitest', 'run', '--reporter=json', '--outputFile', out], { stdio: 'ignore' });
  const report = JSON.parse(readFileSync(out, 'utf8')) as { numTotalTests: number; numFailedTests: number };
  if (report.numFailedTests > 0) throw new Error(`${report.numFailedTests} tests failed, so no figure is drawn from that run`);
  return report.numTotalTests;
}

const SHARE = honoShare();
const TESTS = testCount();

/* ---------------- entry ---------------- */

function build(): Record<string, string> {
  const out: Record<string, string> = {};
  out['assets/hero.svg'] = hero(
    [
      { number: `${SHARE}%`, caption: 'one reviewer, hono' },
      { number: `${TESTS}`, caption: 'tests, rules pinned' },
      { number: `${SAMPLE.percent}%`, caption: `eval pass, median of ${SAMPLE.runs}` },
    ],
    'npm run verify  ·  npm test  ·  npm run eval',
  );
  out['assets/system-map.svg'] = systemMap([
    {
      code: '01', label: 'fetch', note: 'one query, filtered above',
      cards: [{ title: 'GraphQL search', lines: ['merged: does the window', '50 pull requests a page', 'bots by __typename'], foot: 'src/github/client.ts' }],
    },
    {
      code: '02', label: 'compute', note: 'pure, so a fixture pins it',
      cards: [{ title: 'computeInsights', lines: ['half-open [from, to)', 'no self-review counts', 'sums back to merged'], foot: 'src/metrics/compute.ts' }],
    },
    {
      code: '03', label: 'ground', note: 'ids in, every one checked',
      cards: [{ title: 'generateNarrative', lines: ['fact table in, JSON out', 'each citation looked up', 'a mismatch is a 502'], foot: 'src/llm/narrative.ts' }],
    },
  ]);
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
  // The badges and the prose carry the same numbers by hand, so the check
  // holds the README and NOTES to the measured values rather than the typing.
  const held: [string, string[]][] = [
    ['README.md', [`eval-${SAMPLE.percent}%25_median_of_${SAMPLE.runs}_runs`, `a median of ${SAMPLE.percent}%`, `tests-${TESTS}-`, `${TESTS} tests`, `${SHARE}%`]],
    ['NOTES.md', [`${TESTS} tests`, `${SHARE}%`, `a median of ${SAMPLE.percent}%`]],
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
