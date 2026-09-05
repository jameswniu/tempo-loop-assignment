import { describe, expect, it } from 'vitest';
import { BadRequestError, MAX_WINDOW_DAYS, parseQuery } from '../src/routes/params.js';

describe('parseQuery', () => {
  it('splits owner and repo and normalises plain dates to instants', () => {
    const parsed = parseQuery({ repo: 'fastify/fastify', from: '2026-06-01', to: '2026-07-01' });
    expect(parsed.owner).toBe('fastify');
    expect(parsed.repo).toBe('fastify');
    expect(parsed.window).toEqual({ from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' });
  });

  it('accepts a full ISO instant as well as a plain date', () => {
    const parsed = parseQuery({ repo: 'a/b', from: '2026-06-01T06:30:00Z', to: '2026-06-02' });
    expect(parsed.window.from).toBe('2026-06-01T06:30:00.000Z');
  });

  it('defaults to the last 30 days so the quickstart is one URL', () => {
    const parsed = parseQuery({ repo: 'a/b' });
    const days = (Date.parse(parsed.window.to) - Date.parse(parsed.window.from)) / 86_400_000;
    expect(days).toBeCloseTo(30, 5);
  });

  /**
   * The cache is keyed on the exact window. A default `to` of "now" would carry
   * a new millisecond every call, so the most-used URL in the README would miss
   * upstream every time and burn the rate limit.
   */
  it('buckets the default window to the hour so repeated calls share a cache key', () => {
    const first = parseQuery({ repo: 'a/b' });
    const second = parseQuery({ repo: 'a/b' });
    expect(first.window).toEqual(second.window);
    expect(first.window.to).toMatch(/T\d{2}:00:00\.000Z$/);
  });

  /**
   * The repo value is interpolated into a GitHub search query. Without this
   * check a caller could append their own qualifiers and widen the search past
   * the repository they named, so these cases are the security ones.
   */
  it.each([
    'fastify/fastify is:pr repo:torvalds/linux',
    'fastify/fastify OR repo:private/thing',
    '../../etc/passwd',
    'fastify',
    'fastify/fastify/extra',
    'fast ify/fastify',
    '',
  ])('rejects %j as a repository', (repo) => {
    expect(() => parseQuery({ repo })).toThrow(BadRequestError);
  });

  it('accepts the punctuation real repository names use', () => {
    expect(() => parseQuery({ repo: 'my-org.name_x/repo.js-2' })).not.toThrow();
  });

  it('rejects a window that runs backwards', () => {
    expect(() => parseQuery({ repo: 'a/b', from: '2026-07-01', to: '2026-06-01' })).toThrow(/earlier/);
  });

  it('rejects a zero-length window', () => {
    expect(() => parseQuery({ repo: 'a/b', from: '2026-06-01', to: '2026-06-01' })).toThrow(/earlier/);
  });

  it('rejects a window past the cap, where the upstream result limit starts to bite', () => {
    expect(() => parseQuery({ repo: 'a/b', from: '2020-01-01', to: '2026-01-01' })).toThrow(
      new RegExp(String(MAX_WINDOW_DAYS)),
    );
  });

  it('rejects a date it cannot parse instead of silently using today', () => {
    expect(() => parseQuery({ repo: 'a/b', from: 'banana' })).toThrow(BadRequestError);
  });

  /**
   * The built-in Date parser rolls an impossible day forward, so 31 February
   * becomes 3 March and the caller silently gets a window they never asked for.
   */
  it.each(['2026-02-31', '2026-13-01', '2026-06-31', '2026-00-10'])(
    'rejects %s rather than rolling it into the next month',
    (from) => {
      expect(() => parseQuery({ repo: 'a/b', from })).toThrow(/real calendar date/);
    },
  );

  /**
   * A datetime with no zone is read in the server's local time, so the same
   * request answers differently on two machines. A window has to mean one thing.
   */
  it('rejects a datetime carrying no timezone', () => {
    expect(() => parseQuery({ repo: 'a/b', from: '2026-06-01T00:00:00' })).toThrow(/timezone/);
  });

  it('rejects an impossible date even when it carries a time and a zone', () => {
    // The pattern check alone lets this through, and Date rolls it to 3 March.
    expect(() => parseQuery({ repo: 'a/b', from: '2026-02-31T00:00:00Z' })).toThrow(
      /real calendar date/,
    );
  });

  it('accepts an explicit offset as well as Z', () => {
    const parsed = parseQuery({ repo: 'a/b', from: '2026-06-01T09:30:00+02:00', to: '2026-06-02' });
    expect(parsed.window.from).toBe('2026-06-01T07:30:00.000Z');
  });

  /**
   * A real instant just after midnight in a positive offset lands on the
   * previous day in UTC. Validating the calendar text against the normalised
   * UTC date would reject it, so the two checks have to stay separate.
   */
  it('accepts an offset instant that lands on the previous day in UTC', () => {
    const parsed = parseQuery({ repo: 'a/b', from: '2026-06-01T00:30:00+02:00', to: '2026-06-03' });
    expect(parsed.window.from).toBe('2026-05-31T22:30:00.000Z');
  });

  it('accepts an offset instant that lands on the next day in UTC', () => {
    const parsed = parseQuery({ repo: 'a/b', from: '2026-06-01T23:30:00-05:00', to: '2026-06-03' });
    expect(parsed.window.from).toBe('2026-06-02T04:30:00.000Z');
  });

  it('accepts a real leap day', () => {
    expect(() => parseQuery({ repo: 'a/b', from: '2024-02-29', to: '2024-03-01' })).not.toThrow();
  });
});
