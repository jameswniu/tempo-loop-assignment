import 'dotenv/config';
import { EXPECTATIONS, loadCase, type Expectation } from './cases.js';
import { generateNarrative, NarrativeNotGroundedError, type NarrativeResult } from '../src/llm/narrative.js';
import { LlmError, AnthropicProvider, OpenAIProvider, type LlmProvider } from '../src/llm/provider.js';

/**
 * The suite to run before changing a prompt or swapping a model.
 *
 * Cases are real payloads captured from public repositories and frozen on
 * disk, so a run costs model calls and no GitHub quota, and two runs see
 * exactly the same numbers. Every check is objective. Nothing here scores
 * whether the prose reads nicely, because that is not a thing a regression
 * suite can hold steady.
 *
 *   npm run eval                 both providers when both keys are present
 *   npm run eval -- anthropic    one of them
 */

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface CaseOutcome {
  case: string;
  checks: CheckResult[];
  attempts: number;
  outputTokens: number;
  failed: boolean;
  /**
   * Reported, not scored. A figure that exists in the metrics but did not make
   * the evidence array does not fail a request in the service either, and
   * small integers coincide with some contributor row often enough that
   * scoring this would be measuring noise.
   */
  uncited: number[];
}

function check(name: string, passed: boolean, detail: string): CheckResult {
  return { name, passed, detail };
}

function evaluate(expectation: Expectation, result: NarrativeResult): CheckResult[] {
  const cited = new Set(result.evidence.map((item) => item.metric));
  const missing = expectation.mustCite.filter((group) => !group.some((metric) => cited.has(metric)));
  const [low, high] = expectation.confidence;
  const confidence = result.hypothesis.confidence;

  return [
    check(
      'evidence grounded',
      result.grounding.score === 1,
      `${result.grounding.evidenceGrounded}/${result.grounding.evidenceTotal} citations match the computed metrics`,
    ),
    check(
      'no invented numbers',
      result.grounding.unverifiedNumbersInNarrative.length === 0,
      result.grounding.unverifiedNumbersInNarrative.length === 0
        ? 'every number in the prose exists in the computed metrics'
        : `matches nothing computed: ${result.grounding.unverifiedNumbersInNarrative.join(', ')}`,
    ),

    check(
      'cites the metric that carries the story',
      missing.length === 0,
      missing.length === 0
        ? `cited ${cited.size} metrics`
        : `cited none of ${missing.map((group) => group.join(' or ')).join('; ')}`,
    ),
    check(
      'confidence is defensible',
      confidence >= low && confidence <= high,
      `${confidence} against an expected ${low} to ${high}`,
    ),
    check('evidence chain is not empty', result.evidence.length > 0, `${result.evidence.length} items`),
  ];
}

async function runCase(expectation: Expectation, provider: LlmProvider): Promise<CaseOutcome> {
  const insights = await loadCase(expectation.name);
  try {
    const result = await generateNarrative(insights, provider);
    const checks = evaluate(expectation, result);
    return {
      case: expectation.name,
      checks,
      attempts: result.model.attempts,
      outputTokens: result.model.outputTokens,
      failed: checks.some((c) => !c.passed),
      uncited: result.grounding.uncitedNumbersInNarrative,
    };
  } catch (error) {
    if (error instanceof NarrativeNotGroundedError) {
      // The service refused this answer. That is the endpoint behaving
      // correctly and the model failing, so it is recorded as a failure here.
      return {
        case: expectation.name,
        checks: evaluate(expectation, error.result),
        attempts: error.result.model.attempts,
        outputTokens: error.result.model.outputTokens,
        failed: true,
        uncited: error.result.grounding.uncitedNumbersInNarrative,
      };
    }
    if (!(error instanceof LlmError)) {
      // A provider timeout or a dropped connection says nothing about the
      // model's answer, but a suite that dies on one reports nothing about the
      // cases it had not reached yet. Recorded, and the run carries on.
      return {
        case: expectation.name,
        checks: [check('reached the provider', false, error instanceof Error ? error.message : String(error))],
        attempts: 1,
        outputTokens: 0,
        failed: true,
        uncited: [],
      };
    }
    if (error instanceof LlmError) {
      // The model returned something that is not the agreed shape at all. A
      // suite that dies here would report nothing about the other cases, so it
      // is recorded and the run carries on.
      return {
        case: expectation.name,
        checks: [check('model returned the agreed shape', false, error.message)],
        attempts: 1,
        outputTokens: 0,
        failed: true,
        uncited: [],
      };
    }
    throw error;
  }
}

function providers(argument: string | undefined): LlmProvider[] {
  const wanted = argument === undefined ? ['anthropic', 'openai'] : [argument];
  const built: LlmProvider[] = [];

  if (wanted.includes('anthropic') && process.env.ANTHROPIC_API_KEY) {
    built.push(new AnthropicProvider(process.env.ANTHROPIC_API_KEY, process.env.LLM_MODEL ?? 'claude-sonnet-5'));
  }
  if (wanted.includes('openai') && process.env.OPENAI_API_KEY) {
    built.push(
      new OpenAIProvider(
        process.env.OPENAI_API_KEY,
        process.env.EVAL_OPENAI_MODEL ?? 'gpt-4o',
        process.env.OPENAI_BASE_URL,
      ),
    );
  }
  return built;
}

function report(provider: LlmProvider, outcomes: CaseOutcome[]): boolean {
  const total = outcomes.reduce((sum, o) => sum + o.checks.length, 0);
  const passed = outcomes.reduce((sum, o) => sum + o.checks.filter((c) => c.passed).length, 0);
  const retried = outcomes.filter((o) => o.attempts > 1).length;

  console.log(`\n${provider.name} / ${provider.model}`);
  console.log('='.repeat(72));
  for (const outcome of outcomes) {
    console.log(`\n  ${outcome.case}${outcome.attempts > 1 ? `  (took ${outcome.attempts} draws)` : ''}`);
    for (const c of outcome.checks) {
      console.log(`    ${c.passed ? 'pass' : 'FAIL'}  ${c.name.padEnd(38)} ${c.detail}`);
    }
    if (outcome.uncited.length > 0) {
      console.log(`    note  ${'figures used but not recorded'.padEnd(38)} ${outcome.uncited.join(', ')}`);
    }
  }
  console.log(
    `\n  ${passed}/${total} checks passed across ${outcomes.length} cases, ` +
      `${retried} needed a second draw, ${outcomes.reduce((s, o) => s + o.outputTokens, 0)} output tokens\n`,
  );
  return outcomes.every((o) => !o.failed);
}

const selected = providers(process.argv[2]);
if (selected.length === 0) {
  console.error(
    'No provider available. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env.\n' +
      'Pass a name to pick one: npm run eval -- anthropic',
  );
  process.exit(1);
}

let allPassed = true;
for (const provider of selected) {
  // The cases share nothing, so they run together. Sequentially this is four
  // round trips of half a minute or more end to end, which is slow enough that
  // a person stops running it, and a suite nobody runs is not a suite.
  const outcomes = await Promise.all(EXPECTATIONS.map((expectation) => runCase(expectation, provider)));
  allPassed = report(provider, outcomes) && allPassed;
}

if (selected.length > 1) {
  console.log('Both providers ran the same frozen cases. Compare the pass counts before swapping one in.\n');
}
process.exit(allPassed ? 0 : 1);
