import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { GitHubClient } from '../src/github/client.js';

/**
 * Freezes the raw upstream payload for the repositories the documentation makes
 * claims about, so those claims can be rechecked offline and will not drift as
 * the repositories keep moving.
 *
 *   npx tsx tools/capture-raw.ts
 */
const WINDOW = { from: '2026-06-01T00:00:00Z', to: '2026-09-01T00:00:00Z' };
const REPOS = [
  ['fastify', 'fastify'],
  ['honojs', 'hono'],
] as const;

const client = new GitHubClient(process.env.GITHUB_TOKEN!);
for (const [owner, repo] of REPOS) {
  const result = await client.fetchMergedPullRequests(owner, repo, WINDOW);
  const path = `evals/cases/raw/${owner}-${repo}.json`;
  writeFileSync(path, JSON.stringify({ window: WINDOW, ...result }, null, 2));
  console.log(`${path}: ${result.pullRequests.length} pull requests, truncated=${result.truncated}`);
}
