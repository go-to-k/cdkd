import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * `drift.ts` tells a deliberate REFUSAL apart from a failure to READ, and says
 * so in the message: "refused to resolve" versus "could not resolve" (issue
 * [#2108](https://github.com/go-to-k/cdkd/issues/2108)). Getting that wrong
 * sends a reader hunting for a `secretsmanager:GetSecretValue` grant that is not
 * missing.
 *
 * WHY A SOURCE-LEVEL FENCE rather than a behavioural one. Both call sites used
 * to ENUMERATE the one refusal code they knew
 * (`DRIFT_SECRET_REGION_AMBIGUOUS`), so `DRIFT_SECRET_TOKEN_SCAN_MISMATCH` --
 * whose own message says "Refusing rather than resolving it" -- silently took
 * the read-failure wording. That second refusal is an internal-invariant guard
 * (`resolveDriftLeafByRegion` scans a leaf for tokens and then re-locates them
 * in the SAME string), so no input reaches it while the scanner is correct, and
 * a test that drives the command cannot cover it at all. What CAN be fenced is
 * the property that made it wrong: the good state is stated POSITIVELY -- a
 * refusal DECLARES itself one by class, and no branch enumerates codes -- so a
 * THIRD refusal added later cannot inherit the wrong wording by omission. This
 * repo has a standing lesson that enumerating bad shapes loses that race.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// The command module and every module split out of it under `drift/`.
const DRIFT_DIR = `${REPO_ROOT}src/cli/commands/drift/`;
const DRIFT_SOURCES = [
  `${REPO_ROOT}src/cli/commands/drift.ts`,
  ...readdirSync(DRIFT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `${DRIFT_DIR}${f}`),
];

/** Every refusal code the module raises. Both must be raised the SAME way. */
const REFUSAL_CODES = [
  'DRIFT_SECRET_REGION_AMBIGUOUS',
  'DRIFT_SECRET_TOKEN_SCAN_MISMATCH',
  // go-to-k/cdkd#4213: a nested child whose ancestors' regions could not be established.
  'DRIFT_SECRET_REGION_UNKNOWN',
];

function driftSource(): string {
  return DRIFT_SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n');
}

/**
 * The line each refusal code appears on, so a failure message can name it.
 * A code should only ever appear as the `code` argument of a
 * `DriftSecretRefusalError` construction.
 */
function linesMentioning(source: string, needle: string): string[] {
  return source.split('\n').filter((line) => line.includes(needle));
}

describe('a drift secret refusal declares itself by CLASS, not by an enumerated code (issue #2108)', () => {
  it('raises every refusal through DriftSecretRefusalError', () => {
    const source = driftSource();

    // Non-vacuity first: if the class were renamed away, every assertion below
    // would be about strings that no longer exist.
    expect(source).toContain('class DriftSecretRefusalError extends CdkdError');
    expect(source).toContain('function isDriftSecretRefusal(');

    for (const code of REFUSAL_CODES) {
      const lines = linesMentioning(source, `'${code}'`);
      // The code is raised exactly once and read nowhere.
      expect(lines, `${code} should be raised exactly once`).toHaveLength(1);
      expect(
        lines[0],
        `${code} must not be compared against — branch on isDriftSecretRefusal instead`
      ).not.toContain('===');
    }

    // Every refusal is constructed as the class. `regionAmbiguousDriftSecretError`
    // is the factory for one; the token-scan guard and the unknown-ancestor
    // guard (go-to-k/cdkd#4213) throw the others inline.
    const constructions = source.split('new DriftSecretRefusalError(').length - 1;
    expect(constructions, 'every refusal must construct DriftSecretRefusalError').toBe(
      REFUSAL_CODES.length
    );
  });

  it('picks the refusal wording from the predicate at BOTH call sites', () => {
    const source = driftSource();

    // The detection site and the revert site. Each renders one of two wordings,
    // and the split must be decided by the predicate rather than by a code.
    const refusalWordings = ['refused to resolve a dynamic reference', 'refused to re-resolve a'];
    for (const wording of refusalWordings) {
      expect(source, `the ${wording} branch should still exist`).toContain(wording);
    }
    const predicateUses = source.split('isDriftSecretRefusal(err)').length - 1;
    expect(predicateUses, 'both wording branches must ask the predicate').toBe(
      refusalWordings.length
    );
  });
});
