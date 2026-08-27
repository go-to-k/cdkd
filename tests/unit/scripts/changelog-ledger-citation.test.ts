import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * A changelog entry that cites an integ run by its ledger row is making a claim
 * the repo can check, and it is a claim that goes stale in a specific,
 * predictable way: the lane re-runs the integ (a review round staled the
 * marker), the ledger row is REPLACED — one row per test is the ledger's
 * invariant — and the prose keeps naming the run it was written against.
 *
 * That is not hypothetical. On 2026-08-27 the entry shipped by PR
 * go-to-k/cdkd#2309 cited `s3-lifecycle, 2026-08-26T19:01:39Z, PASS, 226s`
 * while the row on `main` already read `2026-08-27T05:08:35Z PASS 208`,
 * because a fourth review round staled `integ-destroy` and the lane ran the
 * fixture again. The sentence around it — "the arm has RUN against real AWS"
 * — stayed true; the evidence it pointed at did not exist any more.
 *
 * The same commit also carried the reverse shape, a caveat reading "that run
 * predates two later edits" about a row that by then POSTdated them. A reader
 * cannot tell either from the prose, which is why this is a test rather than a
 * sentence in a skill: the equivalent sentence was already written, and was
 * violated anyway.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CHANGELOG = join(REPO_ROOT, 'docs', 'changelog-cdkd.md');
const LEDGER = join(REPO_ROOT, 'docs', '_generated', 'integ-last-run.tsv');

/**
 * Matches the shape `/run-integ`'s ledger rows are quoted in: a backticked test
 * name, then an ISO-8601 UTC instant, inside one parenthesised group. The
 * result and duration are optional because an entry may cite only when a run
 * happened. Deliberately anchored on the TIMESTAMP rather than on the words
 * around it — an entry is free to phrase the citation however it likes, and a
 * matcher keyed on prose would be evaded by the next rewording.
 */
const CITATION = /\(`([a-z0-9][a-z0-9-]*)`,\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?:,\s*(PASS|FAIL))?(?:,\s*(\d+)\s*s)?\)/g;

interface LedgerRow {
  readonly lastRunIso: string;
  readonly result: string;
  readonly durationS: string;
}

function readLedger(): Map<string, LedgerRow> {
  const rows = new Map<string, LedgerRow>();
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [test, lastRunIso, result, durationS] = line.split('\t');
    if (test === undefined || lastRunIso === undefined) continue;
    rows.set(test, { lastRunIso, result: result ?? '', durationS: durationS ?? '' });
  }
  return rows;
}

/** Strip fenced code blocks — a fence may quote a ledger row as an EXAMPLE. */
function prose(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, '');
}

describe('changelog citations of the integ ledger', () => {
  const ledger = readLedger();
  const text = prose(readFileSync(CHANGELOG, 'utf8'));
  const citations = [...text.matchAll(CITATION)];

  it('parses the ledger it checks against', () => {
    // Floor, so a broken split cannot make every assertion below vacuous.
    expect(ledger.size).toBeGreaterThanOrEqual(200);
    expect(ledger.get('s3-lifecycle')).toBeDefined();
  });

  it('names a test the ledger actually holds', () => {
    for (const [, test] of citations) {
      expect(ledger.has(test as string), `changelog cites unknown integ test '${test}'`).toBe(true);
    }
  });

  it('cites the run the ledger currently records, not a superseded one', () => {
    const stale = citations
      .filter(([, test, iso]) => ledger.get(test as string)?.lastRunIso !== iso)
      .map(([, test, iso]) => `${test}: cited ${iso}, ledger has ${ledger.get(test as string)?.lastRunIso}`);
    expect(
      stale,
      'a changelog entry cites an integ run the ledger no longer holds — the lane re-ran the fixture ' +
        'after the prose was written, and one row per test means the cited run is gone. Re-derive the ' +
        'citation from docs/_generated/integ-last-run.tsv.'
    ).toEqual([]);
  });

  it('cites the result and duration that row actually carries', () => {
    const wrong: string[] = [];
    for (const [, test, , result, durationS] of citations) {
      const row = ledger.get(test as string);
      if (row === undefined) continue;
      if (result !== undefined && result !== row.result) {
        wrong.push(`${test}: cited result ${result}, ledger has ${row.result}`);
      }
      if (durationS !== undefined && durationS !== row.durationS) {
        wrong.push(`${test}: cited ${durationS}s, ledger has ${row.durationS}s`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
