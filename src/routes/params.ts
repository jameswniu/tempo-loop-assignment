import { z } from 'zod';
import type { Window } from '../metrics/types.js';

/** Longest window accepted. Past this the upstream 1000-result cap starts to bite silently. */
export const MAX_WINDOW_DAYS = 366;
const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export class BadRequestError extends Error {}

const query = z.object({
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, 'repo must look like owner/name'),
  from: z.string().optional(),
  to: z.string().optional(),
});

export interface ParsedQuery {
  owner: string;
  repo: string;
  window: Window;
}

/**
 * Validates and normalises the query string. Dates may be a plain YYYY-MM-DD or
 * a full ISO instant; both land as an instant so the window boundary is exact
 * rather than dependent on the server's timezone. Omitting both dates gives the
 * last 30 days, which is what makes the quickstart a single URL.
 */
export function parseQuery(raw: unknown): ParsedQuery {
  const parsed = query.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  const [owner, repo] = parsed.data.repo.split('/') as [string, string];
  // A default `to` of "now" would carry a fresh millisecond on every request,
  // and since the cache is keyed on the exact window, the no-date quickstart
  // URL would miss upstream every single time. Rounding down to the top of the
  // hour makes repeated calls share a key, and makes the answer reproducible
  // for anyone comparing two runs.
  const to =
    parsed.data.to === undefined ? startOfCurrentHour() : parseInstant(parsed.data.to, 'to');
  const from =
    parsed.data.from === undefined
      ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY)
      : parseInstant(parsed.data.from, 'from');

  if (from.getTime() >= to.getTime()) throw new BadRequestError('from must be earlier than to');
  const days = (to.getTime() - from.getTime()) / MS_PER_DAY;
  if (days > MAX_WINDOW_DAYS) {
    throw new BadRequestError(`window is ${Math.round(days)} days, the maximum is ${MAX_WINDOW_DAYS}`);
  }

  return { owner, repo, window: { from: from.toISOString(), to: to.toISOString() } };
}

function startOfCurrentHour(): Date {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  return now;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Deliberately stricter than `new Date()`. Two behaviours of the built-in
 * parser are wrong for a metrics API: it rolls an impossible date forward, so
 * 2026-02-31 silently becomes 3 March and the caller gets a window they did not
 * ask for, and it reads a datetime with no zone in the server's local time, so
 * the same request answers differently on two machines. A window has to mean
 * the same thing everywhere, so an explicit offset is required.
 */
function parseInstant(value: string, field: string): Date {
  if (CALENDAR_DATE.test(value)) return assertRealCalendarDate(value, field);

  if (!ISO_INSTANT.test(value)) {
    throw new BadRequestError(
      `${field} must be YYYY-MM-DD or an ISO 8601 instant carrying a timezone, such as 2026-06-01T09:30:00Z`,
    );
  }
  // The calendar part is checked on its own terms, before the offset is
  // applied. Comparing it against the normalised UTC date instead would reject
  // 2026-06-01T00:30:00+02:00, which is a real instant that lands on 31 May in
  // UTC. What has to be rejected is a day that never existed, like 31 February.
  const [calendarPart] = value.split('T') as [string];
  assertRealCalendarDate(calendarPart, field);

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestError(`${field} is not a real instant`);
  return date;
}

/** Throws unless the YYYY-MM-DD text names a day that exists. */
function assertRealCalendarDate(value: string, field: string): Date {
  const matched = CALENDAR_DATE.exec(value);
  if (matched === null) throw new BadRequestError(`${field} is not a real calendar date`);
  const [, year, month, day] = matched as unknown as [string, string, string, string];
  const date = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new BadRequestError(`${field} is not a real calendar date`);
  }
  return date;
}
