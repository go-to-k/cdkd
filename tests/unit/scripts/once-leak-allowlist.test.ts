import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const allowListPath = resolve(repoRoot, 'tests/once-leak-allowlist.json');

const allowList = JSON.parse(readFileSync(allowListPath, 'utf8')) as {
  $comment?: string;
  files: string[];
};

/**
 * Static guards on the `*Once`-leak allow-list (issue #1618).
 *
 * The CI job `once-leak-detect` proves the detector still catches NEW leaks.
 * These tests guard the other direction — that the grandfather list does not
 * quietly grow, and that an entry cannot outlive the leak it excuses. A stale
 * entry is not a correctness bug (the file simply keeps its exemption), but it
 * silently withholds protection from a file that no longer needs the
 * exemption, which is the slow way this ratchet stops ratcheting.
 */
describe('once-leak allow-list', () => {
  it('names only files that exist', () => {
    const missing = allowList.files.filter((file) => !existsSync(resolve(repoRoot, file)));

    expect(missing, 'delete these entries — run `vp run gen:once-leak-allowlist`').toEqual([]);
  });

  it('names only files that still prime a *Once value', () => {
    // An allow-listed file with no `*Once` primer left cannot leak, so its
    // exemption is dead and is costing that file its protection.
    const withoutPrimer = allowList.files.filter(
      (file) => !/mock(?:ImplementationOnce|ReturnValueOnce|ResolvedValueOnce|RejectedValueOnce|ThrowOnce)\b/.test(
        readFileSync(resolve(repoRoot, file), 'utf8')
      )
    );

    expect(
      withoutPrimer,
      'these files no longer prime any *Once value — drop them from the allow-list'
    ).toEqual([]);
  });

  it('is sorted and deduplicated, so regeneration produces a stable diff', () => {
    expect(allowList.files).toEqual([...new Set(allowList.files)].sort());
  });

  it('always contains the canary, which leaks by construction', () => {
    // The floor that does NOT deadlock the bootstrap. `once-leak-canary.test.ts`
    // leaks deliberately and permanently, so a regeneration that saw ANYTHING
    // re-adds it. Its absence therefore means the last regeneration observed no
    // leak at all — a dead detector — and this fails at unit level rather than
    // waiting for the CI-only canary step. An empty `files` array would
    // otherwise satisfy every other assertion in this file vacuously.
    expect(allowList.files).toContain('tests/unit/scripts/once-leak-canary.test.ts');
  });

  it('covers only a small minority of the suite', () => {
    // A cap, not a floor. A regeneration that somehow recorded every file would
    // produce a green CI job protecting nothing, so the size is bounded — but
    // an EMPTY list is the goal state of this ratchet, not a defect, and
    // asserting a floor would both fight that and deadlock the bootstrap (the
    // generator runs this very suite, so a floor makes the first regeneration
    // unable to succeed).
    expect(allowList.files.length).toBeLessThanOrEqual(40);
  });

  it('exempts whole files, never individual tests', () => {
    // Per-test granularity was rejected: a test name changes whenever someone
    // rewords it, so the list would go stale on ordinary edits.
    for (const file of allowList.files) {
      expect(file).toMatch(/^tests\/unit\/.+\.test\.ts$/);
    }
  });
});
