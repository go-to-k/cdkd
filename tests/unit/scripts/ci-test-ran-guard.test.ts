import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vite-plus/test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/**
 * The `unit tests` step in CI asserts that vitest actually RAN, not merely that
 * the step exited 0 — a task-runner failure that never reaches vitest exits 0
 * and prints no `Test Files` summary, which reads as a green suite.
 *
 * The guard is three lines of shell inside a YAML string, so nothing type-checks
 * it and nothing runs it outside CI. This suite extracts the predicate FROM
 * `ci.yml` and runs it against captured output, so the guard cannot rot into a
 * pattern that matches everything (or nothing) without failing here.
 *
 * It deliberately does NOT re-implement the grep: a copy would drift from the
 * workflow, and a copy that drifts is exactly what this file exists to prevent.
 */
/**
 * The `- name: unit tests` step, with commented-out lines dropped.
 *
 * Both halves matter and both were measured: reading the whole file finds a
 * guard that has been moved to a step nobody runs, and keeping `#` lines finds
 * one that has been commented OUT -- with either, this suite reported 5 passed
 * over a workflow that no longer checks anything.
 */
function unitTestStep(): string {
  const yml = readFileSync(CI_YML, 'utf8');
  const start = yml.indexOf('- name: unit tests');
  expect(
    start,
    'the `- name: unit tests` step is gone from .github/workflows/ci.yml. If it was renamed, ' +
      'update this extractor; if the suite is no longer run there, this whole file is moot.'
  ).toBeGreaterThan(-1);
  const next = yml.indexOf('\n      - ', start);
  return yml
    .slice(start, next === -1 ? undefined : next)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function guardPatternFromWorkflow(): string {
  const step = unitTestStep();
  const match = /grep -qE '([^']+)' \/tmp\/unit-test\.log/.exec(step);
  expect(
    match,
    'could not find the `Test Files` guard in .github/workflows/ci.yml. If the step was ' +
      'renamed or rewritten, update this extractor; if the guard was REMOVED, restore it — ' +
      'without it a task-runner failure that runs no tests reports a green CI.'
  ).not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

/** Run the extracted predicate over `text`, returning the shell's exit status. */
function guardStatus(pattern: string, text: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-ci-guard-'));
  const log = join(dir, 'unit-test.log');
  writeFileSync(log, text);
  try {
    execFileSync('grep', ['-qE', pattern, log]);
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the CI guard that asserts the unit suite actually ran', () => {
  const pattern = guardPatternFromWorkflow();

  it('passes on the summary a real run prints', () => {
    // The exact bytes vitest emits under a pty, leading space and all.
    expect(guardStatus(pattern, ' Test Files  843 passed (843)\n')).toBe(0);
  });

  it('passes on the ANSI-COLOURED summary CI actually produces', () => {
    // The first version of this guard anchored on `^[[:space:]]*Test Files` and
    // failed a green CI run, because under CI vitest colours the summary and
    // the line begins with an escape sequence rather than a space. The fixture
    // below is copied from the failing run's log (job 99279629061), which is
    // the input the local pty fixture above does not represent.
    const e = '\u001b';
    const coloured = `${e}[2m Test Files ${e}[22m ${e}[1m${e}[32m845 passed${e}[39m${e}[22m${e}[90m (845)${e}[39m\n`;
    expect(guardStatus(pattern, coloured)).toBe(0);
  });

  it('passes on a coloured FAILING summary too', () => {
    // A red run must still count as "the suite ran" -- this guard is about
    // whether vitest executed, and the step's own exit code carries the verdict.
    const e = '\u001b';
    expect(
      guardStatus(pattern, `${e}[2m Test Files ${e}[22m ${e}[1m${e}[31m1 failed${e}[39m | 844 passed\n`)
    ).toBe(0);
  });

  it('FAILS on the silent no-op that motivated it', () => {
    // Verbatim from the shape observed on this repo's main worktree: the Vite+
    // cache encoder overflowed, no test ran, and the process exited 0.
    const noop = [
      'VITE+ - The Unified Toolchain for the Web',
      '',
      '✗ Cache lookup failed: Encoded sequence length exceeded preallocation limit of 4194304 bytes (needed 6871312 bytes)',
      '---',
      'vp run: 0/0 cache hit (0%). (Run `vp run --last-details` for full details)',
      '',
    ].join('\n');
    expect(guardStatus(pattern, noop)).not.toBe(0);
  });

  it('FAILS on empty output', () => {
    expect(guardStatus(pattern, '')).not.toBe(0);
  });

  it('does not pass on the words appearing in prose rather than as a summary line', () => {
    // Guards against the pattern being loosened to a bare substring match: a
    // failure message that happens to mention the phrase is not a summary.
    expect(guardStatus(pattern, 'error: no Test Files summary was printed\n')).not.toBe(0);
  });

  it('the workflow still pipes through tee and sets pipefail', () => {
    // The predicate above is only reached if the step captured the output and
    // did not swallow vitest's own exit status. Read from the STEP, not the
    // file, and with comments dropped -- otherwise a commented-out line, or the
    // same words in a different job, keeps this green.
    const step = unitTestStep();
    expect(step).toContain('set -o pipefail');
    expect(step).toContain('tee /tmp/unit-test.log');
  });
});
