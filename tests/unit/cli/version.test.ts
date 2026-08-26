import { describe, it, expect } from 'vite-plus/test';
import {
  existsSync,
  readFileSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const cliPath = join(repoRoot, 'dist', 'cli.js');
const pkgPath = join(repoRoot, 'package.json');

/**
 * Every test here needs the BUILT CLI, so each one skips when `dist/` is
 * absent — which is the normal state of a fresh worktree and must stay a skip
 * for contributors who have not run `vp run build`.
 *
 * In the job that BUILDS it must NOT be a skip. `dist/` is gitignored and there is no artifact
 * restore, so when `vp run test` ran before `vp run build` these tests were
 * green-by-SKIP on every PR (measured: `Test Files 1 skipped (1) / Tests 3
 * skipped (3)`) — and the wiring fence below is the ONLY coverage of the
 * `--version` fast path. `.github/workflows/ci.yml` now builds first and sets
 * `CDKD_EXPECT_DIST` on that step alone; this flag is the fence for THAT, so
 * a future reorder fails loudly instead of silently re-disarming the fence
 * one layer out.
 *
 * Deliberately NOT keyed on a bare `CI`: `CI` is set in every job, but only
 * `check-build-test` builds, so keying on it reddened `once-leak-detect` and
 * `runtime-compat`, which legitimately have no `dist/`.
 */
const distMissing = !existsSync(cliPath);
const skipUnbuilt = distMissing && !process.env['CDKD_EXPECT_DIST'];

/**
 * Fail with the CAUSE rather than with a bare ENOENT.
 *
 * Without this, the flag-set-but-unbuilt case surfaces as
 * `ENOENT: ... dist/cli.js` from deep inside a test body — which blocks CI
 * correctly but tells the reader nothing about WHY, and the why is a one-line
 * step-order regression in ci.yml. Called first in every test here.
 */
function requireBuiltCli(): void {
  expect(
    distMissing,
    'CDKD_EXPECT_DIST is set but dist/cli.js is absent — `vp run build` must ' +
      'run before `vp run test` in .github/workflows/ci.yml. These tests are ' +
      'the only coverage of the --version fast path, so a skip here is a ' +
      'silently disarmed fence.'
  ).toBe(false);
}

// Spawning the built CLI can exceed vitest's default 5s timeout on slower
// machines under load — same class as gen-handled-property-wiring's
// SPAWN_TIMEOUT_MS, though this spawn is lighter so the budget is half.
//
// Since issue #2002 the spawn is lighter again: `--version` is answered by the
// fast path in src/cli/index.ts without importing the command tree, measured
// 2026-08-25 on Node 24.15 at ~47 ms against ~1020 ms before. The generous
// budget stays because the failure it guards (a loaded machine running 690+
// test files concurrently) is about scheduling, not about this spawn's own
// cost.
const CLI_SPAWN_TIMEOUT_MS = 30_000;

// The fast path's whole point is that the entry chunk carries no command tree.
// Asserting the ARTIFACT rather than the elapsed time is deliberate: a timing
// fence for this would have to distinguish ~47 ms from ~1020 ms on an
// arbitrarily loaded machine, whereas the entry chunk is 2.5 KB with the fast
// path and 4.1 MB without it — three orders of magnitude, and deterministic.
// A regression to a static `import ... from './program.js'` in index.ts pulls
// the whole tree back into this file and trips the bound.
//
// This bound alone does NOT fence the fast path, and a review measured that:
// deleting the `if` block from index.ts while KEEPING the dynamic import left
// every test green, because the chunk stays small and the predicate's own
// tests only constrain a function nothing has to call. The
// `stubbedCommandTree` test below is the fence for the wiring itself.
const ENTRY_CHUNK_MAX_BYTES = 64 * 1024;

describe('cdkd --version', () => {
  it.skipIf(skipUnbuilt)(
    'reports the version baked in from package.json',
    () => {
      requireBuiltCli();
      const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const output = execFileSync('node', [cliPath, '--version'], {
        encoding: 'utf-8',
      }).trim();
      expect(output).toBe(version);
    },
    CLI_SPAWN_TIMEOUT_MS,
  );

  it.skipIf(skipUnbuilt)(
    'answers from the entry chunk, which carries no command tree (issue #2002)',
    () => {
      requireBuiltCli();
      const entry = readFileSync(cliPath, 'utf-8');

      // Positive marker: the command tree is reached through a DYNAMIC import,
      // so nothing hoists it above the fast path's decision.
      expect(entry).toMatch(/import\(["'][^"']*program[^"']*["']\)/);

      // Bytes, not UTF-16 units: the chunk contains non-ASCII, so
      // `entry.length` would undercount against a byte budget.
      expect(statSync(cliPath).size).toBeLessThan(ENTRY_CHUNK_MAX_BYTES);
    },
    CLI_SPAWN_TIMEOUT_MS,
  );

  // The fence for the WIRING, i.e. for the branch this change actually adds.
  // Everything else here constrains an adjacent property: the artifact test
  // above constrains the dynamic import, and tests/unit/version.test.ts
  // constrains a predicate that nothing is obliged to call. Removing the `if`
  // block from src/cli/index.ts leaves all of those green — measured.
  //
  // So: copy the built entry plus its one static chunk into a tmpdir, replace
  // the dynamically-imported command-tree chunk with a module that THROWS on
  // evaluation, and assert `--version` still answers while `--help` does not.
  // That is exactly the claim — the version flag is answered without the
  // command tree being loaded — rather than a proxy for it.
  //
  // Wrong fences ruled out, each tried: an elapsed-time assertion cannot
  // separate ~47 ms from ~1020 ms on a loaded machine; a source regex for
  // `isVersionOnlyInvocation` would not prove the branch PRECEDES the import,
  // which is the whole claim (the name itself DOES survive in the entry — an
  // earlier version of this comment said rolldown renames it, which is true
  // only of the chunk's own exports); and importing src/cli/index.ts from a
  // unit test runs `main()` as a side effect.
  it.skipIf(skipUnbuilt)(
    'answers --version with the command tree stubbed out, and only then (issue #2002)',
    () => {
      requireBuiltCli();
      const distDir = join(repoRoot, 'dist');
      const entry = readFileSync(cliPath, 'utf-8');

      const dynamicMatch = /import\(["'](\.\/[^"']*program[^"']*)["']\)/.exec(entry);
      expect(dynamicMatch).not.toBeNull();
      const programChunk = (dynamicMatch as RegExpExecArray)[1] as string;

      // The sandbox lives in tmpdir() ON PURPOSE, and its lack of a
      // node_modules is load-bearing rather than incidental. `vite.config.ts`
      // marks @aws-sdk/* (and commander / archiver / graphlib / p-limit)
      // `neverBundle`, so any module the entry pulls in STATICALLY drags an
      // external the sandbox cannot resolve -- which is what makes this fence
      // catch "somebody added a static import to index.ts" as well as
      // "somebody deleted the fast path". Measured: adding a static
      // `getAwsClients` import left the entry chunk at 2.5 KB (well under the
      // byte bound) and regressed --version to ~0.4-0.7 s, and only this test
      // went red. Moving the sandbox inside the repo would silently disarm
      // that half.
      const sandbox = mkdtempSync(join(tmpdir(), 'cdkd-version-fence-'));

      // Copy every sibling chunk the entry imports STATICALLY. Reading them
      // off the entry rather than copying the whole dist keeps the stub the
      // only difference between the sandbox and the real build.
      const staticSpecifiers = [...entry.matchAll(/^import\s[^\n]*from\s*["'](\.\/[^"']+)["']/gm)].map(
        (m) => m[1] as string
      );
      for (const spec of staticSpecifiers) {
        copyFileSync(join(distDir, spec), join(sandbox, spec.replace('./', '')));
      }
      copyFileSync(cliPath, join(sandbox, 'cli.js'));

      // The stub. Any load of the command tree is now a hard failure.
      writeFileSync(
        join(sandbox, programChunk.replace('./', '')),
        "throw new Error('COMMAND_TREE_WAS_LOADED');\n"
      );

      // Pin the module system rather than relying on Node's unflagged ESM
      // syntax detection: under `--no-experimental-detect-module` (Node 20's
      // behaviour, which `runtime-compat` exercises) the sandbox otherwise
      // fails to load at all. It fails loudly rather than vacuously, but a
      // fence that only runs on some supported engines is not a fence.
      writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}\n');

      const sandboxEntry = join(sandbox, 'cli.js');
      const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      // The positive marker: the version is answered, with the tree unloadable.
      const out = execFileSync('node', [sandboxEntry, '--version'], {
        encoding: 'utf-8',
      }).trim();
      expect(out).toBe(version);

      // The negative control: the stub really is wired in, so the assertion
      // above is not passing because the sandbox quietly resolved the real
      // chunk. Without this, a copy that failed to place the stub would look
      // identical to a working fast path.
      let helpFailed = false;
      let helpOutput = '';
      try {
        execFileSync('node', [sandboxEntry, '--help'], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (err) {
        helpFailed = true;
        helpOutput = String((err as { stderr?: string }).stderr ?? '');
      }
      expect(helpFailed).toBe(true);
      expect(helpOutput).toContain('COMMAND_TREE_WAS_LOADED');

      // No `readdirSync(sandbox)` guard here: an earlier revision asserted the
      // stub file exists, which is vacuous — `writeFileSync` had just created
      // it two statements above. The real anti-vacuity guard is the stderr
      // check on the negative control: a misassembled sandbox fails with
      // ERR_MODULE_NOT_FOUND, which does not contain the stub's marker.
      rmSync(sandbox, { recursive: true, force: true });
    },
    CLI_SPAWN_TIMEOUT_MS,
  );
});
