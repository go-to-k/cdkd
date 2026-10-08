import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Vitest `globalSetup`: gives every test run its own `TMPDIR` and removes it
 * when the run ends.
 *
 * WHY. Dozens of suites create scratch directories with
 * `mkdtempSync(join(tmpdir(), 'cdkd-...'))` and never remove them. Each run
 * left thousands of entries behind; a working machine accumulated ~90,000 of
 * them (~60 GB) in the user temp directory. Patching every suite would leave
 * the next one to leak again, so the run owns the directory instead:
 * `os.tmpdir()` reads `TMPDIR` on every call, and the test workers -- and any
 * CLI a test spawns -- inherit the environment set here.
 *
 * Only the run's own directory is removed, so a concurrent run (another
 * worktree, another session) is never touched. A run killed before teardown
 * leaves that one directory behind, named `cdkd-vitest-*`.
 *
 * The path is deliberately NOT realpath'd: on macOS `tmpdir()` sits behind
 * the `/var` -> `/private/var` link, and suites such as
 * `asset-path-containment.test.ts` exercise that two-spellings case only when
 * `tmpdir()` still goes through the link.
 */
export default function setup(): () => void {
  const runDir = mkdtempSync(join(tmpdir(), 'cdkd-vitest-'));
  const saved = process.env['TMPDIR'];
  process.env['TMPDIR'] = runDir;
  return () => {
    if (saved === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = saved;
    rmSync(runDir, { recursive: true, force: true });
  };
}
