#!/usr/bin/env node
/**
 * Regenerate `tests/once-leak-allowlist.json` — the grandfather list for the
 * runtime `*Once`-leak detector (issue #1618).
 *
 * Runs the unit suite once with the detector in SNAPSHOT mode, which records
 * every leak as a JSON file instead of failing the test, then collapses the
 * records to the set of distinct test FILES that leak.
 *
 * File granularity, not per-test: a test name changes whenever someone
 * rewords it, and a per-test list would go stale on every edit while a file
 * list only changes when a file is added or fixed. The trade-off is that a
 * grandfathered file gets no protection for its NEW tests either — accepted,
 * because the alternative is a remediation batch across the leaking files and
 * that is exactly what stalled the three previous attempts at this issue.
 *
 * Usage:
 *   vp run gen:once-leak-allowlist
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mirror of the `OnceLeak` shape emitted by `tests/once-leak-detector.ts`. */
interface OnceLeakRecord {
  file: string;
  test: string;
  primedBy: string;
  mock: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowListPath = join(repoRoot, 'tests', 'once-leak-allowlist.json');

const vpCommand = (): string => {
  const local = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vp.cmd' : 'vp');
  return existsSync(local) ? local : 'vp';
};

/** Signals an expected abort whose message is already user-facing. */
class GenerationAborted extends Error {}

const snapshotDir = mkdtempSync(join(tmpdir(), 'cdkd-once-leak-'));

try {
  mkdirSync(snapshotDir, { recursive: true });

  // `vp test run`, never `vp run test`: the latter is a CACHED Vite+ task whose
  // key does not take these env vars into account, so it can replay an earlier
  // green summary and produce an empty allow-list that looks legitimate.
  const result = spawnSync(vpCommand(), ['test', 'run'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CDKD_ONCE_LEAK_DETECT: '1',
      CDKD_ONCE_LEAK_SNAPSHOT: snapshotDir,
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  // A non-zero exit is tolerated only when it is NOT the detector talking:
  // snapshot mode never throws, so a failure here is a genuinely broken suite
  // and the resulting list would be partial.
  //
  // `process.exitCode` + `throw`, never `process.exit()`: an exit() here would
  // skip the `finally` below and leak a `cdkd-once-leak-*` directory into the
  // OS temp dir on every failed regeneration (confirmed on Node 24).
  if (result.status !== 0) {
    process.exitCode = 1;
    throw new GenerationAborted(
      `vp test run exited with ${result.status ?? 'a signal'}. The allow-list was NOT written — ` +
        'fix the failing tests first, otherwise the snapshot only covers the files that ran.'
    );
  }

  const records = readdirSync(snapshotDir).flatMap(
    (name) => JSON.parse(readFileSync(join(snapshotDir, name), 'utf8')) as OnceLeakRecord[]
  );

  const files = [...new Set(records.map((record) => record.file))].sort();

  writeFileSync(
    allowListPath,
    `${JSON.stringify(
      {
        $comment:
          '`*Once` leaks grandfathered for the runtime detector (issue 1618). The three ' +
          'pre-existing real entries were fixed by issue 1655, so what remains is the ' +
          'deliberately-leaking canary suite, which must stay listed (see .claude/rules/' +
          'testing.md). Regenerate with `vp run gen:once-leak-allowlist`. Removing a file ' +
          'from this list after fixing its priming is the intended ratchet direction; ' +
          'adding one is not.',
        files,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  console.log(
    `\nWrote ${allowListPath}\n  ${records.length} leak record(s) across ${files.length} file(s).`
  );
} catch (error) {
  if (!(error instanceof GenerationAborted)) {
    throw error;
  }
  console.error(`\n${error.message}`);
} finally {
  rmSync(snapshotDir, { force: true, recursive: true });
}
