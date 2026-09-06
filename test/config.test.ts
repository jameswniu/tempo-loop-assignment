import { describe, expect, it } from 'vitest';
import { perAttemptTimeout } from '../src/llm/provider.js';
import {
  assertReachableConfigIsSafe,
  corsOrigins,
  describeExposure,
  loadConfig,
  narrativeKeyFor,
} from '../src/config.js';

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

  it('allows an open bind whose port is published on loopback', () => {
    // What docker-compose.yml does: bind 0.0.0.0 inside the container while the
    // published port reaches the host's loopback only.
    const config = loadConfig({ ...base, HOST: '0.0.0.0', PUBLISHED_ON: '127.0.0.1' });
    expect(() => assertReachableConfigIsSafe(config)).not.toThrow();
  });

  /**
   * The exemption and the port mapping read the same compose variable, so a
   * wider publish revokes the exemption instead of leaving a stale one behind.
   */
  it('revokes the exemption when the port is published wider', () => {
    const config = loadConfig({ ...base, HOST: '0.0.0.0', PUBLISHED_ON: '0.0.0.0' });
    expect(() => assertReachableConfigIsSafe(config)).toThrow(/API_TOKEN/);
  });

  it('names the publish address in the refusal, so the cause is obvious', () => {
    const config = loadConfig({ ...base, HOST: '0.0.0.0', PUBLISHED_ON: '203.0.113.4' });
    expect(() => assertReachableConfigIsSafe(config)).toThrow(/published on 203\.0\.113\.4/);
  });

  it('says which of the three exposure states it is in', () => {
    expect(describeExposure(loadConfig(base)).message).toMatch(/this machine only/);
    expect(describeExposure(loadConfig({ ...base, API_TOKEN: 'a-token-long-enough' })).message).toMatch(
      /bearer token/,
    );
  });

  /**
   * The open-but-declared state is the only one whose safety rests on something
   * the process cannot check, so it is the only one that warns.
   */
  it('warns, rather than informs, when it is open on a declaration it cannot verify', () => {
    const open = describeExposure(loadConfig({ ...base, HOST: '0.0.0.0', PUBLISHED_ON: '127.0.0.1' }));
    expect(open.warn).toBe(true);
    expect(open.message).toMatch(/Nothing here can check that/);

    expect(describeExposure(loadConfig(base)).warn).toBe(false);
    expect(describeExposure(loadConfig({ ...base, API_TOKEN: 'a-token-long-enough' })).warn).toBe(false);
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

describe('perAttemptTimeout', () => {
  it('divides the remaining budget across the attempts the SDK may fund', () => {
    // An SDK timeout is per attempt and the SDK retries once, so handing it the
    // whole budget lets one call run for twice that long.
    expect(perAttemptTimeout(60_000)).toBe(30_000);
    expect(perAttemptTimeout(75_000)).toBe(37_500);
  });

  it('keeps a floor so a nearly spent budget still makes one real attempt', () => {
    expect(perAttemptTimeout(100)).toBe(1_000);
  });
});
