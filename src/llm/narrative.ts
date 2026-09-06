import { z } from 'zod';
import { buildFactSet, factIndex, renderFactSet, type Fact } from './facts.js';
import { buildReport, groundEvidence, scanNarrativeNumbers } from './grounding.js';
import type { GroundedEvidence, GroundingReport } from './grounding.js';
import { LlmError, type LlmProvider } from './provider.js';
import type { Insights } from '../metrics/types.js';

const SYSTEM = `You read engineering collaboration data and explain what stands out in it.

You are given a fact table. Every line is one metric id, its value, its unit and what it means.

Rules you must follow:
- Cite metric ids exactly as written in the table. Never invent an id.
- Copy values exactly as written. Never round in the evidence array.
- Do not put any number in the narrative that is not in the table, and cite every number you do use in the evidence array. Describe a magnitude in words when you have no exact figure for it.
- Write numbers as digits rather than words, so 7 rather than seven.
- Offer a root-cause hypothesis only where the numbers support one. If they do not, say the data cannot separate the likely causes and set a low confidence.
- Confidence is your own calibration, from 0 to 1. A small sample or several equally good explanations should pull it down. Reserve anything above 0.8 for a pattern the numbers make hard to explain any other way.
- Write plainly, the way you would say it to the team. No headings, no bullet points, no bold labels.`;

const responseSchema = z.object({
  narrative: z.string().min(1),
  hypothesis: z.object({
    statement: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  }),
  evidence: z
    .array(z.object({ claim: z.string().min(1), metric: z.string().min(1), value: z.number() }))
    .max(20),
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

export function buildPrompt(insights: Insights, options: NarrativeOptions): string {
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
  return lines.join('\n');
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
  let lastFailure: NarrativeResult | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await attemptNarrative(insights, provider, options, index);
    result.model.attempts = attempt;
    if (result.grounding.score === 1 && result.grounding.unverifiedNumbersInNarrative.length === 0) {
      return result;
    }
    lastFailure = result;
  }

  throw new NarrativeNotGroundedError(lastFailure!);
}

async function attemptNarrative(
  insights: Insights,
  provider: LlmProvider,
  options: NarrativeOptions,
  index: Map<string, Fact>,
): Promise<NarrativeResult> {
  const completion = await provider.complete({
    system: SYSTEM,
    user: buildPrompt(insights, options),
    maxTokens: 2000,
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
  const unverified = scanNarrativeNumbers(
    [
      parsed.data.narrative,
      parsed.data.hypothesis.statement,
      parsed.data.hypothesis.reasoning,
      ...parsed.data.evidence.map((item) => item.claim),
    ].join('\n'),
    citedFacts,
    insights.window,
  );

  return {
    repository: insights.repository,
    window: insights.window,
    dataComplete: !options.truncated,
    narrative: parsed.data.narrative,
    hypothesis: parsed.data.hypothesis,
    evidence,
    grounding: buildReport(evidence, unverified),
    model: {
      provider: provider.name,
      name: provider.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      attempts: 1,
    },
  };
}
