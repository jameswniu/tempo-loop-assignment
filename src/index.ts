import { assertReachableConfigIsSafe, corsOrigins, loadConfig, narrativeKeyFor } from './config.js';
import { GitHubClient } from './github/client.js';
import { CacheStore } from './cache/store.js';
import { AnthropicProvider, OpenAIProvider, type LlmProvider } from './llm/provider.js';
import { InsightsService } from './service.js';
import { buildServer } from './server.js';

const config = loadConfig();
assertReachableConfigIsSafe(config);

const cache = new CacheStore(config.CACHE_PATH, config.CACHE_TTL_SECONDS);
cache.prune();

const key = narrativeKeyFor(config);
const provider: LlmProvider | null =
  key === undefined
    ? null
    : config.LLM_PROVIDER === 'anthropic'
      ? new AnthropicProvider(key, config.LLM_MODEL)
      : new OpenAIProvider(key, config.LLM_MODEL);

const app = buildServer({
  service: new InsightsService(new GitHubClient(config.GITHUB_TOKEN), cache),
  provider,
  logLevel: config.LOG_LEVEL,
  corsOrigins: corsOrigins(config),
  apiToken: config.API_TOKEN,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => {
      cache.close();
      process.exit(0);
    });
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  if (provider === null) {
    app.log.warn('No LLM key configured. /v1/insights/narrative will return 503.');
  }
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
