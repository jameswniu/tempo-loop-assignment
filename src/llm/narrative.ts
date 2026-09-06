import { z } from 'zod';
import { buildFactSet, factIndex, renderFactSet, type Fact } from './facts.js';
import { buildReport, groundEvidence, scanNarrativeNumbers } from './grounding.js';
import type { GroundedEvidence, GroundingReport } from './grounding.js';
import { LlmError, type LlmProvider } from './provider.js';
import type { Insights } from '../metrics/types.js';

const SYSTEM = `You read engineering collaboration data and explain what stands out in it.

You are given a fact table. Every line is one metric id, its value, its unit and what it means.

Your answer has two separate parts and they are written differently.

The narrative and the hypothesis are prose for a person to read. Write them the way you would say
them out loud. Never put a metric id in them, and never put a citation in brackets after a figure.
"48 of 126 pull requests merged unreviewed" is right. "48 of 126 merged unreviewed
(totals.pullRequestsUnreviewed = 48)" is wrong, because the ids belong in the other part.

The evidence array is the structured record of where those figures came from, one entry per figure
you used, each naming the metric id and its value. This array is the only place ids appear. Leaving
it empty is never correct when your prose contains a number.

Length comes first. The narrative is three to five sentences. The hypothesis is one sentence and its
reasoning is two or three. This is a short written answer for a colleague, not a report.

That length is what decides how many numbers you use. A few sentences carry a handful of figures, so
pick the ones that carry the argument and leave the rest of the table alone. Do not list every
contributor, do not walk the table row by row, and do not reach for a number just because it is
there. Naming one or two people is often the whole story.

Rules you must follow:
- Cite metric ids exactly as written in the table. Never invent an id.
- Copy values exactly as written. Never round in the evidence array.
- Every figure in your prose gets one entry in the evidence array. Eight figures, eight entries. A figure you would rather not record is a figure to leave out of the prose. Written to the length above this normally lands between four and ten entries, and more than fifteen means you are describing the table rather than explaining it.
- Do no arithmetic. Do not turn a count into a percentage, subtract one figure from another, convert hours into days, or add anything up. Use the figures as the table gives them. Write "48 of 126" and not "38%", "153.28 hours" and not "over six days".
- Where you have no exact figure, say it in words. "Most", "a handful", "the majority" and "far more" all need no citation.
- Write numbers as digits rather than words, so 7 rather than seven.
- Name the slowest-tenth wait by its id, p90, and cite reviewLatency.p90Hours when you do. Never write "90th percentile" or "ninetieth percentile" in any form. That spelling is refused.
- Offer a root-cause hypothesis only where the numbers support one. If they do not, say the data cannot separate the likely causes and set a low confidence.
- Confidence is your own calibration, from 0 to 1, and it is about the CAUSE you propose, not about whether the numbers are correct. The numbers are given; you are being asked how sure you are about why.
- Anchors. Above 0.8 only when the pattern is extreme and one explanation is far better than the others. Between 0.4 and 0.7 when the pattern is clear but several causes would produce it. Below 0.4 when the sample is small, when almost nothing happened, or when you are really describing the data rather than explaining it.
- If nobody reviewed anything, there is no review behaviour to explain and no team dynamic visible, so say that plainly and stay below 0.4. A repository with one contributor is a person working alone, which is an observation and not a finding.
- Write plainly, the way you would say it to the team. No headings, no bullet points, no bold labels.`;

/**
 * A ceiling on citations, not a target. Since every number written has to be
 * cited, this only has to sit above the number of figures a few paragraphs can
 * carry. It was 20, which the model kept exceeding by correctly obeying the
 * citation rule, so the cap was rejecting good answers.
 */
const MAX_EVIDENCE_ITEMS = 40;

const responseSchema = z.object({
  narrative: z.string().min(1),
  hypothesis: z.object({
    statement: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  }),
  evidence: z
    .array(z.object({ claim: z.string().min(1), metric: z.string().min(1), value: z.number() }))
    .max(MAX_EVIDENCE_ITEMS),
});

export interface NarrativeOptions {
  /**
   * True when the upstream result cap was reached, so every count is a floor
   * rather than a total.
   */
  truncated: boolean;
}

export interface NarrativeResult {
  repository: string;
  window: { from: string; to: string };
  /** False when the underlying sample was capped, which the narrative is told about. */
  dataComplete: boolean;
  narrative: string;
  hypothesis: { statement: string; confidence: number; reasoning: string };
  evidence: GroundedEvidence[];
  grounding: GroundingReport;
  model: {
    provider: string;
    name: string;
    inputTokens: number;
    outputTokens: number;
    /** How many draws it took to pass the grounding checks. */
    attempts: number;
  };
}

export function buildPrompt(insights: Insights, options: NarrativeOptions, correction?: string): string {
  const facts = buildFactSet(insights);
  const lines = [
    `Repository: ${insights.repository}`,
    `Window: ${insights.window.from} up to but not including ${insights.window.to}`,
  ];
  // Without this the model reads a capped sample as the whole picture and
  // states a floor as a total, at whatever confidence the pattern suggests.
  if (options.truncated) {
    lines.push(
      '',
      'Warning: this window exceeded the upstream result cap. Every count below is a floor rather than a total, and the review latency and concentration figures have been withheld because a partial sample cannot produce an honest median. Say plainly in the narrative that the window is incomplete, describe the counts as at least this many, and lower your confidence accordingly.',
    );
  }
  lines.push('', 'Fact table:', renderFactSet(facts), '', 'Write the narrative, the hypothesis and the evidence chain.');
  // A retry that says nothing about why the last attempt failed is just another
  // roll of the dice. Naming the exact numbers that did not check out turns the
  // second draw into a correction.
  if (correction !== undefined) lines.push('', correction);
  return lines.join('\n');
}

function correctionFor(result: NarrativeResult): string {
  const parts: string[] = ['Your previous answer was rejected. Fix these and answer again.'];
  const ungrounded = result.evidence.filter((item) => !item.grounded);
  for (const item of ungrounded) {
    parts.push(`- Evidence "${item.metric}": ${item.problem ?? 'did not check out'}.`);
  }
  const loose = result.grounding.unverifiedNumbersInNarrative;
  if (loose.length > 0) {
    parts.push(
      `- These numbers appear in your writing and exist nowhere in the fact table: ${loose.join(', ')}.`,
      '  Each one is a figure you worked out rather than read, most likely a total you added up, a' +
        ' difference you subtracted, or a count turned into a percentage. Take every one of them out.',
      '  Say it in words instead. "Between them they submitted most of the reviews" needs no number' +
        ' and is true. Or name the individual figures the table does give you and let them stand.',
    );
    // The one percentile the fact table carries. Its label is a claim about
    // that metric and passes only with the metric in the evidence.
    if (loose.includes(90)) {
      parts.push(
        '  If one of them is the 90 of "90th percentile", write p90 instead and cite reviewLatency.p90Hours,' +
          ' or drop the phrase. The spelled-out percentile is refused in every form.',
      );
    }
  }
  const uncited = result.grounding.uncitedNumbersInNarrative;
  if (uncited.length > 0) {
    parts.push(
      `- These are real figures you used without recording: ${uncited.join(', ')}. Add an evidence` +
        ' entry for each, or drop it from the prose.',
    );
  }
  return parts.join('\n');
}

/**
 * Raised when the model's own output fails the checks against the computed
 * metrics. Carries the failed result so a caller can see exactly what was
 * wrong rather than getting a bare error.
 */
export class NarrativeNotGroundedError extends Error {
  constructor(readonly result: NarrativeResult) {
    super('the model produced numbers that do not match the computed metrics');
  }
}

/** One retry. Models are stochastic, and a second draw usually lands clean. */
const MAX_ATTEMPTS = 2;

/**
 * End-to-end budget for the whole endpoint, retry included. Without this the
 * per-request timeout multiplies by the number of draws and a caller waits far
 * longer than any single timeout suggests.
 */
const TOTAL_BUDGET_MS = 75_000;

/**
 * Generous on purpose. Models emit the evidence array before the prose, so a
 * long chain of citations can consume the whole budget and leave the narrative
 * and hypothesis as empty strings, which reads as a wording problem and is
 * really a truncation. Measured completions sit near 1500 tokens, so this
 * leaves room for a citation-heavy answer without starving the writing.
 */
const MAX_OUTPUT_TOKENS = 4000;

/**
 * Runs the narrative through the model and then checks its own output against
 * the computed metrics before returning it. Nothing here trusts the model: the
 * shape is validated, every cited number is looked up by id, and every number
 * in the prose must have a counterpart among the facts the model cited.
 *
 * A result that fails those checks is not returned as a success. An earlier
 * version attached the failures to a 200 and let the caller decide, which meant
 * any client that rendered the narrative and ignored the metadata displayed
 * known-bad numbers under a success status, and the check was decorative. It
 * now retries once and then fails, with the report attached so the caller can
 * see what went wrong.
 */
export async function generateNarrative(
  insights: Insights,
  provider: LlmProvider,
  options: NarrativeOptions = { truncated: false },
): Promise<NarrativeResult> {
  const facts = buildFactSet(insights);
  const index = factIndex(facts);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastFailure: NarrativeResult | undefined;

  let lastShapeError: LlmError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    // A second draw is worth having, but not at the cost of doubling how long
    // the caller waits. The remaining budget is handed to the call itself, so
    // an attempt starting just inside the deadline cannot run a full timeout
    // past it, which checking only between attempts allowed.
    if (attempt > 1 && remaining <= 0) break;

    const correction = lastFailure === undefined ? undefined : correctionFor(lastFailure);

    // A malformed response is exactly the stochastic failure the retry exists
    // for, so it is retried rather than thrown straight past the loop. Models
    // under a strict schema occasionally return the right keys with empty
    // strings in them, and a second draw almost always comes back well formed.
    let result: NarrativeResult;
    try {
      result = await attemptNarrative(insights, provider, options, index, correction, remaining);
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      lastShapeError = error;
      continue;
    }
    result.model.attempts = attempt;

    const acceptable = result.grounding.score === 1 && result.grounding.unverifiedNumbersInNarrative.length === 0;
    if (!acceptable) {
      lastFailure = result;
      continue;
    }

    // Sound answer. Nothing is fabricated and every citation resolves, so it is
    // returned even if it used a real figure without recording it.
    //
    // Spending the second draw on that bookkeeping was tried and measured: it
    // moved the evaluation suite from 18 of 20 down to 16 and 17, because the
    // draw that had been catching fabrications went on tidiness instead and the
    // redraw sometimes introduced new problems. The retry is worth more as
    // insurance against a bad answer than as polish on a good one.
    return result;
  }

  if (lastFailure === undefined && lastShapeError !== undefined) throw lastShapeError;
  throw new NarrativeNotGroundedError(lastFailure!);
}

async function attemptNarrative(
  insights: Insights,
  provider: LlmProvider,
  options: NarrativeOptions,
  index: Map<string, Fact>,
  correction?: string,
  timeoutMs?: number,
): Promise<NarrativeResult> {
  const completion = await provider.complete({
    system: SYSTEM,
    user: buildPrompt(insights, options, correction),
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : undefined,
  });

  const parsed = responseSchema.safeParse(completion.json);
  if (!parsed.success) {
    throw new LlmError(
      `model output did not match the required shape: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`,
    );
  }

  const evidence = groundEvidence(parsed.data.evidence, index);
  const citedFacts = evidence
    .map((item) => index.get(item.metric))
    .filter((fact): fact is Fact => fact !== undefined);

  // Every field the model wrote that a person will read, not just the
  // narrative. A fabricated number is just as wrong sitting in the hypothesis,
  // and scanning only one field leaves the grounding report looking clean while
  // the sentence beside it is invented.
  const scan = scanNarrativeNumbers(
    [
      parsed.data.narrative,
      parsed.data.hypothesis.statement,
      parsed.data.hypothesis.reasoning,
      ...parsed.data.evidence.map((item) => item.claim),
    ].join('\n'),
    citedFacts,
    [...index.values()],
    insights.window,
  );

  return {
    repository: insights.repository,
    window: insights.window,
    dataComplete: !options.truncated,
    narrative: parsed.data.narrative,
    hypothesis: parsed.data.hypothesis,
    evidence,
    grounding: buildReport(evidence, scan),
    model: {
      provider: provider.name,
      name: provider.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      attempts: 1,
    },
  };
}
