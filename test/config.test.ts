import { describe, expect, it } from 'vitest';
import { assertReachableConfigIsSafe, corsOrigins, loadConfig, narrativeKeyFor } from '../src/config.js';

const base = { GITHUB_TOKEN: 'gh-token' };

describe('loadConfig', () => {
  it('fails loudly when the GitHub token is missing rather than at first request', () => {
    expect(() => loadConfig({})).toThrow(/GITHUB_TOKEN/);
  });

  it('points at .env.example so the error is actionable', () => {
    expect(() => loadConfig({})).toThrow(/\.env\.example/);
  });

  it('rejects a provider it has no adapter for', () => {
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'gemini' })).toThrow();
  });

  it('defaults to loopback so the service is not reachable by accident', () => {
    expect(loadConfig(base).HOST).toBe('127.0.0.1');
  });

  /**
   * Copying .env.example leaves every key someone did not fill in as an empty
   * string rather than absent. Treating those as set is a boot failure on the
   * documented first step, which is the worst place to have one.
   */
  it('boots from a copied .env.example with the optional keys left blank', () => {
    const config = loadConfig({
      GITHUB_TOKEN: 'gh-token',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: '',
      API_TOKEN: '',
      LLM_PROVIDER: '',
      LLM_MODEL: '',
      PORT: '',
      HOST: '',
      CORS_ORIGINS: '',
      LOG_LEVEL: '',
      CACHE_PATH: '',
      CACHE_TTL_SECONDS: '',
    });
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.API_TOKEN).toBeUndefined();
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.PORT).toBe(8080);
    expect(config.LLM_PROVIDER).toBe('anthropic');
    expect(config.CACHE_TTL_SECONDS).toBe(900);
  });
});

describe('narrativeKeyFor', () => {
  it('reads the key belonging to the selected provider', () => {
    const config = loadConfig({ ...base, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-key' });
    expect(narrativeKeyFor(config)).toBe('sk-test-key');
  });

  it('returns nothing when the selected provider has no key, so the service still boots', () => {
    const config = loadConfig({ ...base, LLM_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-test-key' });
    expect(narrativeKeyFor(config)).toBeUndefined();
  });
});

describe('assertReachableConfigIsSafe', () => {
  it('allows an open instance once a token is set', () => {
    const config = loadConfig({ ...base, HOST: '0.0.0.0', API_TOKEN: 'a-token-long-enough' });
    expect(() => assertReachableConfigIsSafe(config)).not.toThrow();
  });

  it('refuses to boot open with no token, because both endpoints spend money', () => {
    const config = loadConfig({ ...base, HOST: '0.0.0.0' });
    expect(() => assertReachableConfigIsSafe(config)).toThrow(/API_TOKEN/);
  });

  it('leaves loopback alone', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(() => assertReachableConfigIsSafe(loadConfig({ ...base, HOST: host }))).not.toThrow();
    }
  });
});

describe('corsOrigins', () => {
  it('splits and trims the configured list', () => {
    const config = loadConfig({ ...base, CORS_ORIGINS: 'http://a.test , http://b.test ,' });
    expect(corsOrigins(config)).toEqual(['http://a.test', 'http://b.test']);
  });
});
