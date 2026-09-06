import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  /**
   * Time this call may take, from the caller's remaining end-to-end budget.
   * Without it the budget is only checked between attempts, so an attempt
   * starting just inside the deadline still runs a full timeout past it.
   */
  timeoutMs?: number | undefined;
}

export interface CompletionResult {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The seam between the service and whichever model writes the narrative. It
 * exists so the eval harness can run the same frozen cases through a second
 * provider and report the difference, which is the check to run before swapping
 * a model. The request path only ever uses the configured provider.
 */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class LlmError extends Error {}

/**
 * A narrative sits behind a synchronous HTTP request, so the worst case has to
 * be bounded end to end and not just per attempt. These numbers multiply:
 * generateNarrative can draw twice, and each draw is one SDK call that may
 * retry. At 30 seconds and one retry the ceiling is four attempts, two minutes,
 * and generateNarrative stops early once its own budget is spent. The earlier
 * 60 seconds with two retries allowed six attempts and six minutes, which is
 * far longer than any caller will wait and long enough for concurrent requests
 * to pile up during a provider outage.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

/**
 * An SDK timeout applies per attempt and the SDK retries, so a caller's
 * remaining budget has to be divided by the attempts it may fund. Passing the
 * whole remaining budget as the timeout lets one call run MAX_RETRIES + 1 times
 * that long, which is how a 75 second cap quietly became 150.
 */
export function perAttemptTimeout(remainingMs: number): number {
  return Math.max(Math.floor(remainingMs / (MAX_RETRIES + 1)), 1_000);
}

/** Shared output contract. Both adapters force the model to emit exactly this. */
export const NARRATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrative', 'hypothesis', 'evidence'],
  properties: {
    narrative: {
      type: 'string',
      description:
        'Three to five sentences of plain prose on what stands out. No metric ids and no bracketed citations: those belong in the evidence array.',
    },
    hypothesis: {
      type: 'object',
      additionalProperties: false,
      required: ['statement', 'confidence', 'reasoning'],
      properties: {
        statement: { type: 'string', description: 'The most likely cause of the pattern.' },
        confidence: { type: 'number', description: 'Between 0 and 1.' },
        reasoning: { type: 'string', description: 'Why that confidence and not higher or lower.' },
      },
    },
    evidence: {
      type: 'array',
      description:
        'One entry per figure used in the narrative or hypothesis. Never empty when the prose contains a number.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'metric', 'value'],
        properties: {
          claim: { type: 'string', description: 'What this number shows, in one sentence.' },
          metric: { type: 'string', description: 'A metric id copied exactly from the fact table.' },
          value: { type: 'number', description: 'That metric value, copied exactly.' },
        },
      },
    },
  },
} as const;

/**
 * Anthropic has no JSON mode, so the schema is passed as a single tool and the
 * model is forced to call it. The tool input is then the structured output.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      tools: [
        {
          name: 'report_insight',
          description: 'Report the narrative, hypothesis and evidence chain.',
          input_schema: NARRATIVE_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: 'report_insight' },
    }, request.timeoutMs === undefined ? undefined : { timeout: perAttemptTimeout(request.timeoutMs) });

    const call = response.content.find((block) => block.type === 'tool_use');
    if (call === undefined || call.type !== 'tool_use') {
      throw new LlmError('model returned no structured output');
    }
    return {
      json: call.input,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

/**
 * Talks to OpenAI, or to anything else speaking the same chat API, which is
 * most providers now. The shape is enforced through structured outputs rather
 * than asked for in the prompt, so a provider that ignores the schema fails the
 * response validation instead of quietly returning something else.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name: string;
  private readonly client: OpenAI;

  constructor(apiKey: string, readonly model: string, baseURL?: string | undefined) {
    this.client = new OpenAI({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
    this.name = baseURL === undefined ? 'openai' : `openai-compatible (${new URL(baseURL).host})`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: request.maxTokens,
      // The instructions travel in the user message rather than a system one.
      // Measured against Alibaba's OpenAI-compatible endpoint with a strict
      // schema: these instructions in a system message returned an empty
      // evidence array on every run, the same text in the user message
      // returned a full one, and a throwaway system message alongside the
      // full instructions in the user message was also fine. So the system
      // ROLE is not the problem; this instruction text in the system position
      // is. The narrative came back well-formed either way, which is what made
      // the failure silent and worth a comment rather than a one-line fix.
      messages: [{ role: 'user', content: `${request.system}\n\n${request.user}` }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'insight', strict: true, schema: NARRATIVE_SCHEMA },
      },
    }, request.timeoutMs === undefined ? undefined : { timeout: perAttemptTimeout(request.timeoutMs) });

    const content = response.choices[0]?.message.content;
    if (content == null || content === '') throw new LlmError('model returned no structured output');

    // A compatible endpoint that does not honour the schema returns prose here,
    // and a bare SyntaxError would escape the retry loop and surface as a 500.
    // This is the compatibility boundary, so it fails as a model error like any
    // other bad draw. The body is truncated because it reaches a client.
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new LlmError(
        `model returned content that is not JSON, which usually means this endpoint does not honour response_format: ${content.slice(0, 200)}`,
      );
    }

    return {
      json: parsed,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}
