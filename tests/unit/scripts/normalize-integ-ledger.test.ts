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

function runCli(content: string, args: string[] = []): { status: number; stdout: string; stderr: string; content: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-ledger-'));
  const path = join(dir, 'integ-last-run.tsv');
  try {
    writeFileSync(path, content, 'utf8');
    const r = spawnSync(process.execPath, ['--experimental-strip-types', SCRIPT, path, ...args], {
      encoding: 'utf8',
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
    expect(() => parseLedger(bad)).toThrow(/line 3: unparseable last_run_iso "not-a-date"/);
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
    expect(findOutOfOrderTests(rows)).toEqual(['a']);
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
    expect(r.stderr).toContain('out-of-order tests (1): a');
    expect(r.stderr).toContain('vp run integ-ledger-normalize');
  });

  it('writes the normalized file and exits 0 without --check', () => {
    const r = runCli(unsorted);
    expect(r.status).toBe(0);
    expect(dataRows(r.content).map((l) => l.split('\t')[0])).toEqual(['a', 'b']);
  });

  it('exits non-zero on a malformed row instead of silently dropping it', () => {
    const r = runCli(file(row('a', '2026-01-01T00:00:00Z'), 'b\tPASS'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/expected 6 tab-separated columns/);
  });
});

describe('the committed ledger', () => {
  it('is normalized on disk (the invariant CI enforces)', () => {
    const content = readFileSync(LEDGER_PATH, 'utf8');
    expect(normalizeLedger(content)).toBe(content);
  });
});
