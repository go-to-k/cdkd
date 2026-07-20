import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseLedger,
  dedupeRows,
  sortRows,
  normalizeLedger,
  findDuplicateTests,
  findOutOfOrderTests,
  LEDGER_PATH,
} from '../../../scripts/normalize-integ-ledger.js';

/**
 * Guards issue #1112: the integ-last-run ledger is an update-type file whose
 * "exactly one row per test" invariant was broken structurally by /run-integ's
 * append-under-rebase write path. See `scripts/normalize-integ-ledger.ts` for
 * the mechanism.
 */

const SCRIPT = join(import.meta.dirname, '../../../scripts/normalize-integ-ledger.ts');

const HEADER = [
  '# integ-last-run ledger (update-type: one row per test). cols: test\tlast_run_iso\tresult\tduration_s\tflow\tnote',
  '# INVARIANT: exactly one row per test.',
];

function row(test: string, iso: string, note = 'n'): string {
  return [test, iso, 'PASS', '10', 'standard', note].join('\t');
}

function file(...lines: string[]): string {
  return [...HEADER, ...lines].join('\n') + '\n';
}

function dataRows(content: string): string[] {
  return content.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
}

function runCli(
  content: string,
  args: string[] = [],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string; content: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-ledger-'));
  const path = join(dir, 'integ-last-run.tsv');
  try {
    writeFileSync(path, content, 'utf8');
    const r = spawnSync(process.execPath, ['--experimental-strip-types', SCRIPT, path, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      content: readFileSync(path, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseLedger', () => {
  it('preserves the leading comment block verbatim and separates data rows', () => {
    const parsed = parseLedger(file(row('b', '2026-01-02T00:00:00Z'), row('a', '2026-01-01T00:00:00Z')));
    expect(parsed.header).toEqual(HEADER);
    expect(parsed.rows.map((r) => r.test)).toEqual(['b', 'a']);
  });

  it('hard-fails on a row with the wrong column count rather than dropping it', () => {
    const bad = file(row('a', '2026-01-01T00:00:00Z'), 'b\t2026-01-01T00:00:00Z\tPASS');
    expect(() => parseLedger(bad)).toThrow(/line 4: expected 6 tab-separated columns.*found 3/s);
  });

  it('hard-fails on an unparseable timestamp rather than dropping the row', () => {
    const bad = file(row('a', 'not-a-date'));
    expect(() => parseLedger(bad)).toThrow(/line 3: malformed last_run_iso "not-a-date"/);
  });

  /**
   * `Date.parse` — which this script must never use — accepts all of these.
   * The timezone-less form is the dangerous one: the spec says to read it as
   * LOCAL time, which made the normalizer's winner machine-dependent.
   */
  it.each([
    ['2026-01-01T05:00:00', 'missing the trailing Z (would be read as local time)'],
    ['2026', 'year only'],
    ['Jul 20 2026', 'human-readable form'],
    ['2026-01-01T05:00:00+09:00', 'non-UTC offset'],
    ['2026-01-01T05:00:00.123Z', 'fractional seconds'],
    ['garbage', 'garbage'],
  ])('rejects %s (%s) with a line number', (ts) => {
    expect(() => parseLedger(file(row('a', ts)))).toThrow(
      /line 3: malformed last_run_iso .*expected a UTC instant of exactly the form/s,
    );
  });

  it('accepts the exact form /run-integ writes', () => {
    expect(() => parseLedger(file(row('a', '2026-07-20T09:15:00Z')))).not.toThrow();
  });

  it('hard-fails on an empty test name', () => {
    expect(() => parseLedger(file(row('', '2026-01-01T00:00:00Z')))).toThrow(/empty test name/);
  });

  it('hard-fails on a comment line interleaved after data rows', () => {
    const bad = file(row('a', '2026-01-01T00:00:00Z'), '# stray');
    expect(() => parseLedger(bad)).toThrow(/comment line appears after data rows/);
  });
});

describe('dedupeRows', () => {
  it('keeps the newest last_run_iso per test', () => {
    const { rows } = parseLedger(
      file(
        row('a', '2026-01-01T00:00:00Z', 'old'),
        row('a', '2026-03-01T00:00:00Z', 'newest'),
        row('a', '2026-02-01T00:00:00Z', 'middle'),
      ),
    );
    const deduped = dedupeRows(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.raw).toContain('newest');
  });

  /**
   * Regression guard for the timezone bug: `dedupeRows` used to compare via
   * `Date.parse`, so with a timezone-less row in the input the winner flipped
   * by machine (TZ=UTC picked LOCAL, TZ=Asia/Tokyo picked ZED) — and the
   * loser is DELETED, so a real run record could be destroyed differently
   * depending on whose laptop ran the task. The input below is the exact
   * shape that flipped. Today it is rejected outright, and the assertion is
   * that the two timezones agree byte-for-byte on everything: exit code,
   * message, and resulting file.
   */
  it('produces identical results regardless of the ambient timezone', () => {
    const input = file(
      row('t', '2026-01-01T05:00:00', 'LOCAL'), // no Z -> local time under Date.parse
      row('t', '2026-01-01T00:00:00Z', 'ZED'),
    );
    const utc = runCli(input, [], { TZ: 'UTC' });
    const tokyo = runCli(input, [], { TZ: 'Asia/Tokyo' });
    const la = runCli(input, [], { TZ: 'America/Los_Angeles' });

    expect(utc.status).toBe(tokyo.status);
    expect(utc.status).toBe(la.status);
    expect(utc.stderr).toBe(tokyo.stderr);
    expect(utc.stderr).toBe(la.stderr);
    expect(utc.content).toBe(tokyo.content);
    expect(utc.content).toBe(la.content);
    // And it fails loudly rather than silently picking a timezone-dependent winner.
    expect(utc.status).toBe(1);
    expect(utc.stderr).toMatch(/malformed last_run_iso "2026-01-01T05:00:00"/);
  });

  it('picks the same winner in every timezone for valid UTC rows', () => {
    const input = file(
      row('t', '2026-01-01T00:00:00Z', 'older'),
      row('t', '2026-01-01T23:00:00Z', 'newer'),
    );
    for (const TZ of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      const r = runCli(input, [], { TZ });
      expect(r.status).toBe(0);
      expect(dataRows(r.content)).toHaveLength(1);
      expect(r.content).toContain('newer');
      expect(r.content).not.toContain('older');
    }
  });

  it('keeps the first row on an exact timestamp tie without erroring', () => {
    const { rows } = parseLedger(
      file(row('a', '2026-01-01T00:00:00Z', 'first'), row('a', '2026-01-01T00:00:00Z', 'second')),
    );
    const deduped = dedupeRows(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.raw).toContain('first');
  });
});

describe('sortRows', () => {
  it('sorts by test name lexicographically (code-unit order, locale-independent)', () => {
    const { rows } = parseLedger(
      file(
        row('local-invoke', '2026-01-01T00:00:00Z'),
        row('Alb', '2026-01-01T00:00:00Z'),
        row('alb', '2026-01-01T00:00:00Z'),
        row('alb-advanced', '2026-01-01T00:00:00Z'),
      ),
    );
    // Uppercase sorts before lowercase under code-unit comparison; a
    // locale-aware sort would interleave them and produce a phantom CI diff.
    expect(sortRows(rows).map((r) => r.test)).toEqual(['Alb', 'alb', 'alb-advanced', 'local-invoke']);
  });
});

describe('normalizeLedger', () => {
  it('dedupes, sorts, preserves the header, and ends with a trailing newline', () => {
    const out = normalizeLedger(
      file(
        row('c', '2026-01-01T00:00:00Z'),
        row('a', '2026-01-01T00:00:00Z', 'stale'),
        row('b', '2026-01-01T00:00:00Z'),
        row('a', '2026-05-01T00:00:00Z', 'fresh'),
      ),
    );
    expect(out.startsWith(HEADER.join('\n'))).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false); // exactly one, not a blank trailing line
    expect(dataRows(out).map((l) => l.split('\t')[0])).toEqual(['a', 'b', 'c']);
    expect(out).toContain('fresh');
    expect(out).not.toContain('stale');
  });

  it('is idempotent — normalizing twice yields identical bytes', () => {
    const once = normalizeLedger(
      file(
        row('z', '2026-01-01T00:00:00Z'),
        row('m', '2026-02-01T00:00:00Z'),
        row('m', '2026-01-01T00:00:00Z'),
        row('a', '2026-01-01T00:00:00Z'),
      ),
    );
    expect(normalizeLedger(once)).toBe(once);
  });

  it('leaves an already-normalized file byte-identical', () => {
    const normalized = file(row('a', '2026-01-01T00:00:00Z'), row('b', '2026-01-01T00:00:00Z'));
    expect(normalizeLedger(normalized)).toBe(normalized);
  });

  it('never loses a test: the output row count equals the distinct input test count', () => {
    const input = file(
      row('a', '2026-01-01T00:00:00Z'),
      row('b', '2026-01-01T00:00:00Z'),
      row('a', '2026-02-01T00:00:00Z'),
      row('c', '2026-01-01T00:00:00Z'),
      row('b', '2026-03-01T00:00:00Z'),
    );
    const distinct = new Set(dataRows(input).map((l) => l.split('\t')[0]));
    expect(dataRows(normalizeLedger(input))).toHaveLength(distinct.size);
  });
});

describe('diagnostics', () => {
  it('reports duplicated and out-of-order test names', () => {
    const { rows } = parseLedger(
      file(row('b', '2026-01-01T00:00:00Z'), row('a', '2026-01-01T00:00:00Z'), row('b', '2026-02-01T00:00:00Z')),
    );
    expect(findDuplicateTests(rows)).toEqual(['b']);
    // `b` is the misplaced row (it belongs after `a`), not `a`.
    expect(findOutOfOrderTests(rows)).toEqual(['b']);
  });

  it('names the row that sits too late, not the one it displaced', () => {
    const { rows } = parseLedger(
      file(
        row('a', '2026-01-01T00:00:00Z'),
        row('c', '2026-01-01T00:00:00Z'),
        row('b', '2026-01-01T00:00:00Z'),
      ),
    );
    expect(findOutOfOrderTests(rows)).toEqual(['c']);
  });
});

describe('CLI', () => {
  const unsorted = file(row('b', '2026-01-01T00:00:00Z'), row('a', '2026-01-01T00:00:00Z'));

  it('--check exits 0 without writing when the file is already normalized', () => {
    const normalized = file(row('a', '2026-01-01T00:00:00Z'), row('b', '2026-01-01T00:00:00Z'));
    const r = runCli(normalized, ['--check']);
    expect(r.status).toBe(0);
    expect(r.content).toBe(normalized);
  });

  it('--check exits 1 WITHOUT writing, naming the offending tests and the fix command', () => {
    const dup = file(
      row('b', '2026-01-01T00:00:00Z'),
      row('a', '2026-01-01T00:00:00Z'),
      row('a', '2026-02-01T00:00:00Z'),
    );
    const r = runCli(dup, ['--check']);
    expect(r.status).toBe(1);
    expect(r.content).toBe(dup); // untouched
    expect(r.stderr).toContain('duplicated tests (1): a');
    expect(r.stderr).toContain('out-of-order tests (1): b'); // `b` is the row sitting too late
    expect(r.stderr).toContain('vp run integ-ledger-normalize');
  });

  it('writes the normalized file and exits 0 without --check', () => {
    const r = runCli(unsorted);
    expect(r.status).toBe(0);
    expect(dataRows(r.content).map((l) => l.split('\t')[0])).toEqual(['a', 'b']);
  });

  it('exits non-zero on a malformed row instead of silently dropping it', () => {
    const r = runCli(file(row('a', '2026-01-01T00:00:00Z'), 'b\tPASS'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/expected 6 tab-separated columns/);
  });

  it('reports a malformed row as a clean one-liner, not a Node stack trace', () => {
    const r = runCli(file(row('a', '2026-01-01T00:00:00Z'), 'b\tPASS'));
    expect(r.stderr).not.toMatch(/^\s+at /m); // no stack frames
    expect(r.stderr).not.toContain('node:internal');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('reports a missing file as a clean one-liner too', () => {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', SCRIPT, join(tmpdir(), 'cdkd-ledger-does-not-exist.tsv')],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(r.stderr).toMatch(/ENOENT/);
  });
});

describe('the committed ledger', () => {
  it('is normalized on disk (the invariant CI enforces)', () => {
    const content = readFileSync(LEDGER_PATH, 'utf8');
    expect(normalizeLedger(content)).toBe(content);
  });
});
