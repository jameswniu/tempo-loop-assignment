import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
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

/** Shared output contract. Both adapters force the model to emit exactly this. */
export const NARRATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrative', 'hypothesis', 'evidence'],
  properties: {
    narrative: {
      type: 'string',
      description: 'Three to five sentences on what stands out in this window.',
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
      description: 'One entry per number the narrative leans on.',
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
    this.client = new Anthropic({ apiKey });
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
    });

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

/** OpenAI enforces the same shape through structured outputs. */
export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(apiKey: string, readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: request.maxTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'insight', strict: true, schema: NARRATIVE_SCHEMA },
      },
    });

    const content = response.choices[0]?.message.content;
    if (content == null || content === '') throw new LlmError('model returned no structured output');
    return {
      json: JSON.parse(content),
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}
