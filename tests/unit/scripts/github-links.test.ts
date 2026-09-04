import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { githubTree, githubBlob } from '../../../scripts/github-links.ts';

/**
 * The generated coverage matrices link out of the published site, so their
 * links must be absolute GitHub URLs rather than `../` paths — about 2,600 of
 * them resolved to nothing on cdkd.dev until issue #2510.
 *
 * The host lives in one module so a rename cannot drift eight emitters apart.
 * That is only true while nothing re-hardcodes it, which is what the second
 * test here checks: the extraction is otherwise load-bearing by convention
 * alone, and `scripts/` is outside both the lint and the typecheck scope
 * (`vite.config.ts`'s `ignorePatterns`, `tsconfig.json`'s `include`), so
 * nothing else would notice.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const GENERATORS = [
  'scripts/build-cli-flag-coverage-matrix.ts',
  'scripts/build-integ-coverage-matrix.ts',
  'scripts/build-scenario-coverage-matrix.ts',
];

describe('github-links', () => {
  it('builds a tree URL for a directory and a blob URL for a file', () => {
    expect(githubTree('tests/integration/lambda/')).toBe(
      'https://github.com/go-to-k/cdkd/tree/main/tests/integration/lambda/'
    );
    expect(githubBlob('src/provisioning/register-providers.ts')).toBe(
      'https://github.com/go-to-k/cdkd/blob/main/src/provisioning/register-providers.ts'
    );
  });

  it('no matrix generator hardcodes the GitHub host', () => {
    // The helper module is deliberately not in this list — a scan that included
    // it would be satisfied by its own definition.
    const offenders = GENERATORS.filter((f) =>
      readFileSync(join(repoRoot, f), 'utf8').includes('https://github.com/')
    );
    expect(
      offenders,
      'these generators hardcode the GitHub host; call githubTree / githubBlob so a rename moves one line, not eight'
    ).toEqual([]);

    // Anti-vacuity: the list must still name files that exist and that really
    // do emit links, or the check above passes over nothing.
    expect(GENERATORS.length).toBe(3);
    for (const f of GENERATORS) {
      expect(
        readFileSync(join(repoRoot, f), 'utf8'),
        `${f} no longer calls the link helpers — has it stopped emitting links?`
      ).toMatch(/github(Tree|Blob)\(/);
    }
  });
});
