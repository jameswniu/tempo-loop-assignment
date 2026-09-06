import 'dotenv/config';
import { z } from 'zod';

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

/**
 * Environment is validated once at boot. A missing or malformed variable fails
 * the process immediately rather than surfacing as a confusing 500 on the first
 * request that happens to need it.
 */
/**
 * An unset variable in a copied .env arrives as an empty string, not as
 * undefined. Without this, following .env.example and filling in only the keys
 * you need fails at boot, which is the first thing a new reader would hit.
 */
const optionalText = (min = 1) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.string().min(min).optional());

const schema = z.object({
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  ANTHROPIC_API_KEY: optionalText(),
  OPENAI_API_KEY: optionalText(),
  /**
   * Base URL for the OpenAI-compatible adapter. Left unset it talks to OpenAI.
   * Set, it talks to anything speaking the same chat API, which is most
   * providers now, so swapping vendors is configuration rather than code.
   */
  OPENAI_BASE_URL: optionalText(),
  LLM_PROVIDER: z.preprocess(blankToUndefined, z.enum(['anthropic', 'openai']).default('anthropic')),
  LLM_MODEL: z.preprocess(blankToUndefined, z.string().default('claude-sonnet-5')),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(8080)),
  /** Loopback by default. This service carries a GitHub token, so it should not
   *  listen on every interface unless someone deliberately asks it to. */
  HOST: z.preprocess(blankToUndefined, z.string().default('127.0.0.1')),
  /** Comma-separated browser origins allowed to call the API. */
  CORS_ORIGINS: z.preprocess(
    blankToUndefined,
    z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  ),
  /** When set, every /v1 request must carry `Authorization: Bearer <token>`. */
  API_TOKEN: optionalText(16),
  /**
   * The address this process's port is published on by whatever is in front of
   * it, which for a container is the host side of the port mapping. A loopback
   * value here is what lets the service bind 0.0.0.0 inside a container without
   * a token. It is an address rather than a boolean on purpose: the compose
   * file feeds the same variable to the port mapping and to this, so widening
   * the publish cannot leave a stale exemption behind.
   */
  PUBLISHED_ON: optionalText(),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ),
  /** Built frontend directory. Set in the container; unset in development. */
  STATIC_ROOT: optionalText(),
  CACHE_PATH: z.preprocess(blankToUndefined, z.string().default('./data/cache.db')),
  CACHE_TTL_SECONDS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().nonnegative().default(900),
  ),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}\n\nCopy .env.example to .env and fill it in.`);
  }
  return parsed.data;
}

/**
 * The narrative endpoint needs a key for whichever provider is selected. The
 * insights endpoint does not, so the service still boots and serves metrics
 * with no LLM key present.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * On loopback the service is a local tool and asking a reviewer for a bearer
 * token would only get in the way. Bound to anything else it is reachable, and
 * both endpoints spend real money: one burns a GitHub rate limit, the other
 * calls a model per request. So the token is optional locally and required the
 * moment the bind address stops being loopback.
 *
 * A container has to bind 0.0.0.0 for its published port to work at all, and
 * the process cannot see that the port is published only to the host's
 * loopback. ALLOW_UNAUTHENTICATED_BIND is how an operator states that the
 * boundary is handled elsewhere. It is deliberately a separate, named decision
 * rather than a silent exemption for anything that looks containerised.
 */
export function assertReachableConfigIsSafe(config: Config): void {
  if (LOOPBACK.has(config.HOST)) return;
  if (config.API_TOKEN !== undefined) return;
  if (config.PUBLISHED_ON !== undefined && LOOPBACK.has(config.PUBLISHED_ON)) return;

  throw new Error(
    `HOST is ${config.HOST}, so this service is reachable from outside this process` +
      (config.PUBLISHED_ON === undefined
        ? '. '
        : `, and its port is published on ${config.PUBLISHED_ON}. `) +
      'Set API_TOKEN (16 characters or more) to require a bearer token, or set HOST=127.0.0.1. ' +
      "In a container, publishing the port on the host's loopback and passing that same address as " +
      'PUBLISHED_ON is what grants the exemption.',
  );
}

export interface Exposure {
  message: string;
  /** True when the process is open and trusting a declaration to confine it. */
  warn: boolean;
}

/**
 * One line at boot saying which of the three states the process is in. The
 * third is logged as a warning rather than as information, because it is the
 * only one whose safety rests on something this process cannot verify.
 */
export function describeExposure(config: Config): Exposure {
  if (config.API_TOKEN !== undefined) {
    return { message: 'a bearer token is required on every /v1 request', warn: false };
  }
  if (LOOPBACK.has(config.HOST)) {
    return { message: `bound to ${config.HOST}, reachable from this machine only`, warn: false };
  }
  return {
    message:
      `bound to ${config.HOST} with no token, on the declaration that its port is published on ` +
      `${config.PUBLISHED_ON}. Nothing here can check that. If this port is reachable from ` +
      'anywhere else, set API_TOKEN now.',
    warn: true,
  };
}

export function corsOrigins(config: Config): string[] {
  return config.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function narrativeKeyFor(config: Config): string | undefined {
  return config.LLM_PROVIDER === 'anthropic' ? config.ANTHROPIC_API_KEY : config.OPENAI_API_KEY;
}
