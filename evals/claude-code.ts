import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { LlmError, NARRATIVE_SCHEMA, type CompletionRequest, type CompletionResult, type LlmProvider } from '../src/llm/provider.js';

const run = promisify(execFile);

/** The command line is missing, or nobody is logged in. Not a model result, and never recorded as one. */
export class ProviderUnavailableError extends Error {}

const NOT_LOGGED_IN = /log ?in|logged out|authenticat|credential|api key|unauthori[sz]ed|subscription/i;

function parseEnvelope(text: string | undefined): Envelope | null {
  if (text === undefined || text.trim() === '') return null;
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return null;
  }
}

interface Envelope {
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The shipped default model, reached through the Claude Code command line on
 * a subscription login instead of an API key. Eval only, never the request
 * path: a service cannot shell out to somebody's login, and the CLI is not on
 * a reviewer's machine by default, so this provider is opt-in by name.
 *
 * The call is lean. No settings, no memory, no tools, no MCP servers, only the
 * system prompt, the user prompt and the schema, which is the same input the
 * SDK adapter sends. So the measurement is of the model, not of whatever the
 * local install happens to carry. There is no output token cap on this path.
 */
export class ClaudeCodeProvider implements LlmProvider {
  readonly name = 'claude-code';

  constructor(readonly model: string) {}

  /** Run once before any case, so a machine without the command line aborts before the report is touched. */
  static preflight(): void {
    try {
      execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 15_000 });
    } catch (error) {
      throw new ProviderUnavailableError(
        `claude-code needs the Claude Code command line on PATH and a login. ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const args = [
      '--print',
      '--model', this.model,
      '--system-prompt', request.system,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(NARRATIVE_SCHEMA),
      '--setting-sources', '',
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--no-session-persistence',
      '--disable-slash-commands',
      request.user,
    ];
    let envelope: Envelope | null;
    try {
      const { stdout } = await run('claude', args, { timeout: request.timeoutMs ?? 90_000, maxBuffer: 8 * 1024 * 1024 });
      envelope = parseEnvelope(stdout);
      if (envelope === null) throw new LlmError('claude-code returned something other than its JSON envelope');
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const failure = error as { code?: string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string; message?: string };
      const message = (failure.message ?? String(error)).split('\n')[0] ?? '';
      if (failure.code === 'ENOENT') throw new ProviderUnavailableError(`claude is not on PATH. ${message}`);
      if (failure.killed === true || (failure.signal !== undefined && failure.signal !== null)) {
        throw new LlmError(`claude-code did not complete in time: ${message}`);
      }
      envelope = parseEnvelope(failure.stdout);
      if (envelope === null) {
        // The command line ran and exited without its envelope. That is not
        // something a model said, so it is not recorded as one. An expired
        // login lands here.
        const detail = (failure.stderr ?? '').split('\n').find((line) => line.trim() !== '') ?? message;
        throw new ProviderUnavailableError(`claude-code exited without answering. ${detail.slice(0, 200)}`);
      }
    }
    if (envelope.is_error === true) {
      const detail = String(envelope.result).slice(0, 200);
      if (NOT_LOGGED_IN.test(detail)) throw new ProviderUnavailableError(`claude-code has no usable login. ${detail}`);
      throw new LlmError(`claude-code reported an error: ${detail}`);
    }
    if (envelope.structured_output === undefined || envelope.structured_output === null) {
      throw new LlmError('claude-code returned no structured output');
    }
    return {
      json: envelope.structured_output,
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
    };
  }
}
