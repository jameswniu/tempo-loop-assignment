import type { Fact } from './facts.js';
import type { Window } from '../metrics/types.js';

export interface EvidenceInput {
  claim: string;
  metric: string;
  value: number;
}

export interface GroundedEvidence extends EvidenceInput {
  /** True when the cited id exists and the cited value matches the computed one. */
  grounded: boolean;
  /** The computed value behind that id, or null when the id is unknown. */
  actualValue: number | null;
  unit: string | null;
  /** Present only when grounded is false, in plain words. */
  problem?: string;
}

export interface GroundingReport {
  /** Fraction of evidence items that check out, 0 to 1. Null when there is no evidence. */
  score: number | null;
  evidenceTotal: number;
  evidenceGrounded: number;
  /**
   * Numbers in the prose that match no computed value at all. These are
   * fabrications and they fail the request.
   */
  unverifiedNumbersInNarrative: number[];
  /**
   * Numbers in the prose that match a computed value the model did not put in
   * its evidence array. The figure is real, the bookkeeping is untidy, so this
   * is reported and does not fail the request.
   */
  uncitedNumbersInNarrative: number[];
}

/** JSON round-trips and percentage arithmetic both introduce tiny error. */
const EPSILON = 1e-9;

/**
 * Checks one evidence item against the fact set. An item is grounded when the
 * id it names exists and the value it reports equals the computed value. This
 * is a dictionary lookup rather than an interpretation of the sentence, which
 * is the whole reason the model is handed ids instead of raw JSON.
 */
export function groundEvidence(items: EvidenceInput[], facts: Map<string, Fact>): GroundedEvidence[] {
  return items.map((item) => {
    const fact = facts.get(item.metric);
    if (fact === undefined) {
      return {
        ...item,
        grounded: false,
        actualValue: null,
        unit: null,
        problem: `no metric called "${item.metric}" is computed for this window`,
      };
    }
    if (Math.abs(fact.value - item.value) > EPSILON) {
      return {
        ...item,
        grounded: false,
        actualValue: fact.value,
        unit: fact.unit,
        problem: `cited ${item.value} but ${item.metric} is ${fact.value}`,
      };
    }
    return { ...item, grounded: true, actualValue: fact.value, unit: fact.unit };
  });
}

/** A value and the same value rounded to zero, one or two decimals. */
function roundedForms(value: number): number[] {
  const forms = [value];
  for (const places of [0, 1, 2]) {
    const factor = 10 ** places;
    forms.push(Math.round(value * factor) / factor);
  }
  return forms;
}

/**
 * Number words the model might reach for instead of digits. A digit-only
 * scanner reads "seven rollbacks" as prose and waves it through, so these are
 * rewritten before the scan. The prompt also asks for digits, which makes this
 * a backstop rather than the primary mechanism.
 */
const NUMBER_WORDS: ReadonlyMap<string, string> = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'],
  ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
  ['ten', '10'], ['eleven', '11'], ['twelve', '12'], ['thirteen', '13'],
  ['fourteen', '14'], ['fifteen', '15'], ['sixteen', '16'], ['seventeen', '17'],
  ['eighteen', '18'], ['nineteen', '19'], ['twenty', '20'], ['thirty', '30'],
  ['forty', '40'], ['fifty', '50'], ['sixty', '60'], ['seventy', '70'],
  ['eighty', '80'], ['ninety', '90'], ['hundred', '100'], ['thousand', '1000'],
]);

const NUMBER_WORD_PATTERN = new RegExp(`\\b(${[...NUMBER_WORDS.keys()].join('|')})\\b`, 'gi');

function digitiseNumberWords(text: string): string {
  return text.replace(NUMBER_WORD_PATTERN, (word) => NUMBER_WORDS.get(word.toLowerCase()) ?? word);
}

/** Whole dates are removed before scanning rather than having their parts allowed. */
const DATE_SHAPED = /\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?/g;

/**
 * "90th percentile" is the name of the p90 metric, not a figure, and a model
 * with the p90 wait in front of it writes exactly that. Only the percentile
 * ranks the fact table carries are treated as labels, so "the 8th busiest
 * reviewer" is still a number the scan sees and "95th percentile" is still
 * an invented one. Without this every narrative naming the 90th percentile
 * was refused for inventing the number 90.
 */
/**
 * The only shapes in which a percentile label names the review wait, the one
 * percentile the fact table carries: the label directly on a wait noun, or a
 * wait noun at the label. "The 90th percentile of contributors waited" is
 * neither and stays a number, an invented one.
 */
/** The word form of the ranks a fact table could carry, since the p90 description itself says "ninetieth". */
const ORDINAL_WORDS: Record<string, string> = { '50': 'fiftieth', '75': 'seventy-fifth', '90': 'ninetieth', '95': 'ninety-fifth', '99': 'ninety-ninth' };
const WORD_TO_RANK: Record<string, string> = Object.fromEntries(Object.entries(ORDINAL_WORDS).map(([rank, word]) => [word, rank]));

/** A percentile spelled as an ordinal, in digits or words, hyphenated or not, with no noun attached. */
const PERCENTILE_ORDINAL = new RegExp(`(?<![A-Za-z0-9_-])(\\d{1,2}(?:st|nd|rd|th)|${Object.values(ORDINAL_WORDS).join('|')})[\\s-]+percentile\\b`, 'gi');

/**
 * The id-shaped label on its own, "p90", which the generic scan would skip as
 * an identifier. An id says which metric it names wherever it appears, so it
 * needs no sentence around it. "p90bot" is a login, so the digits must end
 * the token, while "p90-hour" is the label with a unit hung on it.
 */
const PERCENTILE_ID = /(?<![A-Za-z0-9_-])p(\d{1,2})(?![A-Za-z0-9_])/gi;

function rankOf(label: string): string {
  const digits = /^p?(\d{1,2})/i.exec(label);
  if (digits) return digits[1]!;
  return WORD_TO_RANK[label.toLowerCase()] ?? label;
}

function percentileRanks(facts: Fact[]): Set<string> {
  const ranks = new Set<string>();
  for (const fact of facts) {
    // Only the latency percentile itself. A contributor whose login happens
    // to contain p90 is not a percentile and must not authorise the label.
    const match = /^reviewLatency\.p(\d{1,2})Hours$/.exec(fact.id);
    if (match) ranks.add(match[1]!);
  }
  return ranks;
}

/**
 * Numbers, matched with any percent marker that follows them. Grouped numerals
 * are matched whole, because splitting "1,000" on the comma reads it as 1 and
 * 000, both of which match something harmless.
 *
 * A digit run PRECEDED by a letter, hyphen or underscore belongs to an
 * identifier rather than to a claim. GitHub logins routinely carry digits, and
 * without this the 20 inside a username like ababove20-jpg is reported as an
 * invented number.
 *
 * The test is deliberately only on what comes before. An earlier version also
 * skipped a number FOLLOWED by a letter or hyphen, which exempted every
 * ordinary compact form a narrative uses, so "90-day", "24h" and "2x" passed
 * the gate without being checked at all. Those are exactly where a fabricated
 * or unit-converted figure would hide.
 */
const NUMBER_WITH_CONTEXT = /(?<![A-Za-z0-9_-])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(%|percent\b)?/gi;

/**
 * Pulls every number out of the prose and checks each against the fact set.
 * This catches a number invented mid-sentence even when the evidence array is
 * clean, which is the failure the evidence check alone cannot see.
 *
 * The percentage form of a share is accepted only where the prose actually
 * writes a percentage. Without that, a share of 0.3333 silently authorises the
 * bare number 33, and "the team shipped 33 pull requests" passes a scan whose
 * entire job is to catch that sentence.
 *
 * The allowed values are the facts the model actually CITED, not every fact
 * computed. Checking against the whole table means a sentence like "3 rollbacks"
 * passes on the strength of some unrelated metric that happens to equal 3.
 *
 * Known limit, stated plainly: this checks that a number has a counterpart, not
 * that the sentence around it is true. A cited value reused for a different
 * claim still passes, because that is a semantic problem a numeric scan cannot
 * solve. The exact guarantee lives in the evidence array, which is bound to
 * metric ids. This is the backstop for prose.
 */
export interface NumberScan {
  /** Matches nothing computed anywhere. Fabricated. */
  fabricated: number[];
  /** Matches a computed value the model did not cite. Real but unrecorded. */
  uncited: number[];
}

export function scanNarrativeNumbers(
  narrative: string,
  cited: Fact[],
  all: Fact[],
  window: Window,
): NumberScan {
  const allow = (facts: Fact[]) => {
    const plain = new Set<number>();
    const asPercentage = new Set<number>();
    for (const fact of facts) {
      for (const form of roundedForms(fact.value)) plain.add(round12(form));
      if (fact.unit === 'share') {
        for (const form of roundedForms(fact.value * 100)) asPercentage.add(round12(form));
      }
    }
    return { plain, asPercentage };
  };

  const citedForms = allow(cited);
  const everyForm = allow(all);
  const { plain, asPercentage } = citedForms;
  // The narrative names its own period, so the years of the window are prose.
  // Months and days are not allowed loose: a whole date is stripped instead.
  for (const instant of [window.from, window.to]) plain.add(new Date(instant).getUTCFullYear());

  for (const instant of [window.from, window.to]) everyForm.plain.add(new Date(instant).getUTCFullYear());

  const fabricated: number[] = [];
  const uncited: number[] = [];

  // A percentile label is a name only when the model cited that metric. Named
  // without a citation it is a claim about one specific metric with no evidence
  // behind it, and unlike a bare number it says which metric, so it fails the
  // request the way an invented number does rather than being reported.
  const citedRanks = percentileRanks(cited);
  const invent = (rank: string): string => {
    if (!fabricated.includes(Number(rank))) fabricated.push(Number(rank));
    return ' ';
  };
  // The wait's percentile is named by its id, p90, and the prompt asks for
  // exactly that. An id says which metric it names wherever it appears, so a
  // cited one is a name and an uncited one is a claim with nothing behind it.
  // The ordinal spelling, "90th percentile" in digits or words, is refused
  // outright, because whether it names the wait or something else is a
  // question of English the scanner cannot settle. Both passes remove what
  // they recognised, so the generic scan never sees a percentile as a number.
  let text = narrative.replace(PERCENTILE_ORDINAL, (_match: string, ordinal: string) => invent(rankOf(ordinal)));
  text = text.replace(PERCENTILE_ID, (_match: string, rank: string) => (citedRanks.has(rank) ? ' ' : invent(rank)));
  const prose = digitiseNumberWords(text.replace(DATE_SHAPED, ' '));
  for (const match of prose.matchAll(NUMBER_WITH_CONTEXT)) {
    const value = round12(Number(match[1]!.replace(/,/g, '')));
    if (!Number.isFinite(value)) continue;
    const isPercentage = match[2] !== undefined;

    if (plain.has(value) || (isPercentage && asPercentage.has(value))) continue;

    // Real figure, just not recorded in the evidence array. Worth reporting,
    // not worth refusing an otherwise sound answer over. Treating this the same
    // as a fabrication means a model that mentions a true median without
    // formally citing it gets its answer thrown away.
    if (everyForm.plain.has(value) || (isPercentage && everyForm.asPercentage.has(value))) {
      if (!uncited.includes(value)) uncited.push(value);
      continue;
    }

    if (!fabricated.includes(value)) fabricated.push(value);
  }
  return { fabricated, uncited };
}

export function buildReport(evidence: GroundedEvidence[], scan: NumberScan): GroundingReport {
  const grounded = evidence.filter((e) => e.grounded).length;
  return {
    score: evidence.length === 0 ? null : round12(grounded / evidence.length),
    evidenceTotal: evidence.length,
    evidenceGrounded: grounded,
    unverifiedNumbersInNarrative: scan.fabricated,
    uncitedNumbersInNarrative: scan.uncited,
  };
}

function round12(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}
