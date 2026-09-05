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
   * Numbers that appear in the prose but match no computed value. Advisory: a
   * legitimate restatement the rule below does not anticipate lands here too,
   * so this flags text for a human rather than declaring it wrong.
   */
  unverifiedNumbersInNarrative: number[];
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
 * Numbers, matched with any percent marker that follows them. Grouped numerals
 * are matched whole, because splitting "1,000" on the comma reads it as 1 and
 * 000, both of which match something harmless.
 */
const NUMBER_WITH_CONTEXT = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(%|percent\b)?/gi;

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
export function scanNarrativeNumbers(narrative: string, cited: Fact[], window: Window): number[] {
  const plain = new Set<number>();
  const asPercentage = new Set<number>();
  for (const fact of cited) {
    for (const form of roundedForms(fact.value)) plain.add(round12(form));
    if (fact.unit === 'share') {
      for (const form of roundedForms(fact.value * 100)) asPercentage.add(round12(form));
    }
  }
  // The narrative names its own period, so the years of the window are prose.
  // Months and days are not allowed loose: a whole date is stripped instead.
  for (const instant of [window.from, window.to]) plain.add(new Date(instant).getUTCFullYear());

  const prose = digitiseNumberWords(narrative.replace(DATE_SHAPED, ' '));
  const unverified: number[] = [];
  for (const match of prose.matchAll(NUMBER_WITH_CONTEXT)) {
    const value = round12(Number(match[1]!.replace(/,/g, '')));
    if (!Number.isFinite(value)) continue;
    const isPercentage = match[2] !== undefined;
    if (plain.has(value) || (isPercentage && asPercentage.has(value))) continue;
    if (!unverified.includes(value)) unverified.push(value);
  }
  return unverified;
}

export function buildReport(evidence: GroundedEvidence[], unverifiedNumbers: number[]): GroundingReport {
  const grounded = evidence.filter((e) => e.grounded).length;
  return {
    score: evidence.length === 0 ? null : round12(grounded / evidence.length),
    evidenceTotal: evidence.length,
    evidenceGrounded: grounded,
    unverifiedNumbersInNarrative: unverifiedNumbers,
  };
}

function round12(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}
