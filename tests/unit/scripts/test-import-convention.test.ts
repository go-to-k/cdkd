import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Test files must import test APIs from 'vite-plus/test', never 'vitest'.
 *
 * vitest is bundled inside the `vite-plus` dev dependency and is NOT a direct
 * dependency of cdkd, so `from 'vitest'` typechecks and runs LOCALLY (pnpm
 * hoisting exposes the transitive package) but fails CI's stricter install
 * with `TS2307: Cannot find module 'vitest'` (`vp run typecheck:test`) — a
 * divergence invisible until push (PR #1226, 2026-07-26). This meta-lint
 * moves the failure to the local `vp run test`.
 *
 * Per the "a checker must prove it sees its input" rule
 * (.claude/rules/testing.md), the scan asserts a real file-count floor so a
 * walker regression cannot pass vacuously.
 */

const TESTS_ROOT = join(import.meta.dirname, '..', '..');

// Matches static and dynamic imports of the bare 'vitest' specifier (either
// quote style). Subpaths like 'vitest/config' are equally undeclared and are
// caught by the same prefix. 'vite-plus/test' does not match.
const VITEST_IMPORT_RE = /from\s+['"]vitest(?:\/[^'"]*)?['"]|import\s*\(\s*['"]vitest(?:\/[^'"]*)?['"]\s*\)/;

function walkTestFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'cdk.out') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTestFiles(full, out);
    } else if (
      (entry.endsWith('.test.ts') || entry.endsWith('.test-d.ts')) &&
      // Skip this lint itself — its doc comment necessarily spells out the
      // banned import as prose, which would self-match.
      entry !== 'test-import-convention.test.ts'
    ) {
      out.push(full);
    }
  }
}

describe('test-file import convention (vite-plus/test, not vitest)', () => {
  const files: string[] = [];
  walkTestFiles(TESTS_ROOT, files);

  it('scans a plausible number of test files (walker coverage floor)', () => {
    // 470 test files at the time of writing; the floor leaves headroom for
    // removals while still failing loudly if the walker breaks and scans a
    // subtree only.
    expect(files.length).toBeGreaterThan(400);
  });

  it("no test file imports from 'vitest' (use 'vite-plus/test')", () => {
    const violations = files.filter((f) => VITEST_IMPORT_RE.test(readFileSync(f, 'utf8')));
    expect(
      violations.map((f) => f.replace(`${TESTS_ROOT}/`, 'tests/')),
      "import test APIs from 'vite-plus/test' — 'vitest' is a transitive dep that resolves locally via pnpm hoisting but fails CI typecheck (TS2307)"
    ).toEqual([]);
  });
});
