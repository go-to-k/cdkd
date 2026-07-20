#!/usr/bin/env node
/**
 * scripts/normalize-integ-ledger.ts
 *
 * Deterministic normalizer for the integ-last-run ledger
 * (docs/_generated/integ-last-run.tsv), an update-type ledger with the
 * invariant "exactly one row per test".
 *
 * Why this exists (issue #1112): `/run-integ` used to record a run by
 * dropping the test's old row and appending a new one at the END of the
 * file. That is correct in isolation but NOT rebase-safe:
 *
 *   - Rebase replays each commit's append against the new base.
 *   - The base already carries a row for that test (a sibling lane merged
 *     first), so the replay appends a SECOND copy rather than replacing it.
 *   - Git auto-merge sees two non-conflicting additions to different
 *     regions of a text file and takes BOTH.
 *
 * Ten tests on `main` had accumulated duplicates that way before #1115
 * swept them by hand. With duplicates present, "when did this test last
 * run?" depends on which row a reader or `/pick-integ` happens to hit.
 *
 * The fix is a whole-file rewrite rather than an in-place append:
 * collapse to one row per test (keeping the NEWEST run) and emit the rows
 * in a stable sorted order. A replayed commit then produces an IDENTICAL
 * file instead of an additive diff, and a genuine conflict resolves at a
 * deterministic location instead of silently taking both sides. The same
 * pass doubles as the invariant CHECK that CI runs (issue #1112 fix 1) —
 * one mechanism covering both halves of the issue.
 *
 * Malformed rows are a HARD FAILURE, never a silent drop: a silently
 * discarded run record is worse than a red build, because the ledger is
 * the only place a run's outcome is retained.
 *
 * Run from the repo root:
 *   node --experimental-strip-types scripts/normalize-integ-ledger.ts
 *   node --experimental-strip-types scripts/normalize-integ-ledger.ts --check
 *   (or: vp run integ-ledger-normalize [-- --check])
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const LEDGER_PATH = join(REPO_ROOT, 'docs/_generated/integ-last-run.tsv');

/** Column count of a ledger data row: test/last_run_iso/result/duration_s/flow/note. */
const COLUMNS = 6;

/**
 * The ONLY accepted `last_run_iso` shape: a fixed-width UTC instant, exactly
 * what `/run-integ` writes via `date -u +%Y-%m-%dT%H:%M:%SZ`.
 *
 * This is deliberately stricter than `Date.parse`, which must NOT be used
 * anywhere in this file. `Date.parse` is lenient — it accepts `2026`,
 * `Jul 20 2026`, and (the dangerous one) a date-time with NO designator like
 * `2026-01-01T05:00:00`, which the spec says to interpret as LOCAL time. That
 * made the normalizer's own output timezone-dependent: the same two-row input
 * picked a different winner under TZ=UTC vs TZ=Asia/Tokyo, so (a) a
 * developer's run and CI's UTC run disagreed about whether a file was
 * normalized — the gate would flap — and (b) the losing row is DELETED, so a
 * real run record could be destroyed depending on whose machine ran the task.
 * A normalizer whose entire value proposition is determinism cannot depend on
 * the ambient timezone.
 *
 * With the shape pinned, plain string comparison on this fixed-width form IS
 * chronological comparison, so no date parsing is needed anywhere.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface LedgerRow {
  test: string;
  lastRunIso: string;
  /** The row verbatim, so normalization is byte-preserving per row. */
  raw: string;
  /** 1-based line number in the source file, for error messages. */
  line: number;
}

export interface ParsedLedger {
  /** Leading `#` comment lines, preserved verbatim and in order. */
  header: string[];
  rows: LedgerRow[];
}

/**
 * Parses the ledger. Throws on any row that is not exactly `COLUMNS`
 * tab-separated fields or whose timestamp is unparseable — see the
 * "hard failure" note in the module header.
 */
export function parseLedger(content: string): ParsedLedger {
  const header: string[] = [];
  const rows: LedgerRow[] = [];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    // A trailing empty string from the final newline is not a row.
    if (line === '') continue;

    if (line.startsWith('#')) {
      if (rows.length > 0) {
        throw new Error(
          `integ-last-run.tsv line ${lineNo}: comment line appears after data rows; ` +
            `the header comment block must be contiguous at the top of the file`,
        );
      }
      header.push(line);
      continue;
    }

    const fields = line.split('\t');
    if (fields.length !== COLUMNS) {
      throw new Error(
        `integ-last-run.tsv line ${lineNo}: expected ${COLUMNS} tab-separated columns ` +
          `(test, last_run_iso, result, duration_s, flow, note) but found ${fields.length}: ${JSON.stringify(line)}`,
      );
    }

    const [test, lastRunIso] = fields as [string, string, string, string, string, string];
    if (test.trim() === '') {
      throw new Error(`integ-last-run.tsv line ${lineNo}: empty test name`);
    }
    if (!ISO_UTC.test(lastRunIso)) {
      throw new Error(
        `integ-last-run.tsv line ${lineNo}: malformed last_run_iso ${JSON.stringify(lastRunIso)} ` +
          `for test ${JSON.stringify(test)} (expected a UTC instant of exactly the form ` +
          `YYYY-MM-DDTHH:MM:SSZ, e.g. 2026-07-20T09:15:00Z — the trailing Z is required, ` +
          `since a timezone-less timestamp would make the normalizer's output depend on the ` +
          `local timezone)`,
      );
    }

    rows.push({ test, lastRunIso, raw: line, line: lineNo });
  }

  return { header, rows };
}

/**
 * Collapses to one row per test, keeping the row with the greatest
 * `last_run_iso`. An exact tie keeps the FIRST occurrence (no error — two
 * runs recorded in the same second are indistinguishable, and failing the
 * build over it would be worse than picking either).
 *
 * Compares the timestamps as plain STRINGS, never via `Date.parse`.
 * `parseLedger` has already pinned every value to the fixed-width
 * `YYYY-MM-DDTHH:MM:SSZ` UTC form, on which lexicographic order and
 * chronological order coincide. Using `Date` here would reintroduce the
 * timezone dependence described at `ISO_UTC` — and since the loser of this
 * comparison is DELETED, a timezone-dependent winner means a real run record
 * can be destroyed differently on different machines.
 */
export function dedupeRows(rows: LedgerRow[]): LedgerRow[] {
  const winners = new Map<string, LedgerRow>();
  for (const row of rows) {
    const current = winners.get(row.test);
    if (current === undefined || row.lastRunIso > current.lastRunIso) {
      winners.set(row.test, row);
    }
  }
  return [...winners.values()];
}

/**
 * Sorts by test name using plain lexicographic comparison on UTF-16 code
 * units (`<` / `>`), NOT `localeCompare`. This is deliberate: the sort
 * order is baked into a committed file that CI compares byte-for-byte, so
 * it must be identical on every machine regardless of locale (ICU
 * collation differs between environments and would produce a phantom
 * diff). Do not "improve" this into a locale-aware sort.
 */
export function sortRows(rows: LedgerRow[]): LedgerRow[] {
  return [...rows].sort((a, b) => (a.test < b.test ? -1 : a.test > b.test ? 1 : 0));
}

/** Serializes header + rows back to file bytes, with a trailing newline. */
export function serializeLedger(header: string[], rows: LedgerRow[]): string {
  return [...header, ...rows.map((r) => r.raw)].join('\n') + '\n';
}

/** Full normalization: parse -> dedupe -> sort -> serialize. Idempotent. */
export function normalizeLedger(content: string): string {
  const { header, rows } = parseLedger(content);
  return serializeLedger(header, sortRows(dedupeRows(rows)));
}

/** Test names appearing more than once, in first-seen order. */
export function findDuplicateTests(rows: LedgerRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.test, (counts.get(row.test) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([test]) => test);
}

/**
 * Test names that sit too LATE in the file — each one is followed by a
 * lexicographically smaller name.
 *
 * At a break between `rows[i-1]` and `rows[i]` it is the PREDECESSOR that is
 * reported, not `rows[i]`: for the input `b, a` the misplaced row is `b`
 * (it belongs after `a`), and naming `a` would send whoever hits the CI
 * failure looking at the wrong line.
 */
export function findOutOfOrderTests(rows: LedgerRow[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.test < rows[i - 1]!.test) out.push(rows[i - 1]!.test);
  }
  return out;
}

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (e) {
    // A malformed row / missing file must surface as the same clean one-liner
    // the --check path prints, not as a raw Node stack trace in the CI log.
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

function run(argv: string[]): number {
  const check = argv.includes('--check');
  // An explicit path is accepted so the CLI surface (exit codes, messages) is
  // testable against synthetic fixtures; CI and `vp run` pass no path.
  const ledgerPath = argv.find((a) => !a.startsWith('--')) ?? LEDGER_PATH;
  const original = readFileSync(ledgerPath, 'utf8');
  const normalized = normalizeLedger(original);

  if (normalized === original) {
    console.log(
      `integ-last-run.tsv is normalized (${parseLedger(original).rows.length} rows, one per test).`,
    );
    return 0;
  }

  if (check) {
    const { rows } = parseLedger(original);
    const duplicates = findDuplicateTests(rows);
    const outOfOrder = findOutOfOrderTests(rows);
    console.error('integ-last-run.tsv is not normalized.');
    if (duplicates.length > 0) {
      console.error(`  duplicated tests (${duplicates.length}): ${duplicates.join(', ')}`);
    }
    if (outOfOrder.length > 0) {
      console.error(`  out-of-order tests (${outOfOrder.length}): ${outOfOrder.join(', ')}`);
    }
    console.error('  fix: vp run integ-ledger-normalize');
    return 1;
  }

  writeFileSync(ledgerPath, normalized, 'utf8');
  console.log(
    `Normalized integ-last-run.tsv (${parseLedger(normalized).rows.length} rows, one per test).`,
  );
  return 0;
}

// Only run when invoked directly, so the unit test can import the helpers.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
