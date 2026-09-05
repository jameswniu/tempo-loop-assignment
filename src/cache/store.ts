import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A small read-through cache for upstream payloads, keyed by the exact query
 * that produced them. GitHub's rate budget is 5000 points an hour and a wide
 * window costs a few dozen, so repeated demo queries would burn it quickly
 * without this. SQLite keeps the cache across restarts with no extra service
 * for a reviewer to start.
 */
export class CacheStore {
  private readonly db: Database.Database;
  private readonly ttlSeconds: number;

  constructor(path: string, ttlSeconds: number) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS upstream_cache (
        key         TEXT PRIMARY KEY,
        payload     TEXT NOT NULL,
        fetched_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_fetched_at ON upstream_cache(fetched_at);
    `);
    this.ttlSeconds = ttlSeconds;
  }

  get<T>(key: string): { value: T; ageSeconds: number } | null {
    const row = this.db
      .prepare('SELECT payload, fetched_at FROM upstream_cache WHERE key = ?')
      .get(key) as { payload: string; fetched_at: number } | undefined;
    if (row === undefined) return null;

    const ageSeconds = Math.floor((Date.now() - row.fetched_at) / 1000);
    if (ageSeconds > this.ttlSeconds) {
      this.db.prepare('DELETE FROM upstream_cache WHERE key = ?').run(key);
      return null;
    }
    return { value: JSON.parse(row.payload) as T, ageSeconds };
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO upstream_cache (key, payload, fetched_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at',
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  /** Drops entries past their TTL. Called on boot so the file cannot grow without bound. */
  prune(): number {
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    return this.db.prepare('DELETE FROM upstream_cache WHERE fetched_at < ?').run(cutoff).changes;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Cache keys carry a schema version so a change to the fetch shape cannot serve
 * a stale payload that no longer parses.
 */
export function upstreamKey(owner: string, repo: string, from: string, to: string): string {
  return `v1:gh:${owner}/${repo}:${from}:${to}`;
}
