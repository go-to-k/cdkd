import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';

import { derivePseudoParametersFromRegion } from '../../../src/local/intrinsic-image.js';

/**
 * Issue #1814: `derivePseudoParametersFromRegion` is cdk-local's, and cdk-local
 * carries its own partition table whose prefix tests are case-sensitive — so the
 * issue #1795 canonicalization inside `src/utils/aws-partition.ts` structurally
 * could not reach it. `src/local/intrinsic-image.ts` now wraps the re-export with
 * a canonicalizing boundary.
 *
 * The bar these tests hold to is the one #1795 set: for every partition, an
 * upper-cased region must produce the SAME answer as its lower-cased form, and
 * the commercial answer must be byte-identical to today's so the change is safe
 * without a non-commercial account.
 */
describe('derivePseudoParametersFromRegion (issue #1814 canonicalizing boundary)', () => {
  describe('non-commercial partitions: case must not change the verdict', () => {
    it.each([
      ['cn-north-1', 'aws-cn', 'amazonaws.com.cn'],
      ['us-gov-west-1', 'aws-us-gov', 'amazonaws.com'],
      ['us-iso-east-1', 'aws-iso', 'c2s.ic.gov'],
      ['us-isob-east-1', 'aws-iso-b', 'sc2s.sgov.gov'],
    ])(
      '%s resolves %s / %s however it is cased',
      (region: string, partition: string, urlSuffix: string) => {
      const canonical = derivePseudoParametersFromRegion(region, '111122223333');

      expect(canonical).toEqual({
        accountId: '111122223333',
        region,
        partition,
        urlSuffix,
      });

      // The two spellings a `--region` flag can actually carry.
      for (const raw of [region.toUpperCase(), toMixedCase(region)]) {
        expect(derivePseudoParametersFromRegion(raw, '111122223333')).toEqual(canonical);
      }
    });

    it('folds the region VALUE too, not just the derived suffix', () => {
      // `region` is substituted as `${AWS::Region}` into every ARN the resolver
      // builds, so a raw upper-cased value would misspell those as well. This is
      // why the wrapper canonicalizes the INPUT rather than post-processing.
      expect(derivePseudoParametersFromRegion('CN-NORTH-1')?.region).toBe('cn-north-1');
    });

    it('is the exact defect the issue describes: an upper-cased cn- region is no longer commercial', () => {
      const pseudo = derivePseudoParametersFromRegion('CN-NORTH-1', '111122223333');

      expect(pseudo?.urlSuffix).not.toBe('amazonaws.com');
      // The host the pre-fix code synthesized, spelled out so a regression is
      // recognizable: `<acct>.dkr.ecr.CN-NORTH-1.amazonaws.com` does not exist.
      expect(`${pseudo?.accountId}.dkr.ecr.${pseudo?.region}.${pseudo?.urlSuffix}`).toBe(
        '111122223333.dkr.ecr.cn-north-1.amazonaws.com.cn',
      );
    });
  });

  describe('commercial partition: byte-identical to the pre-fix behavior', () => {
    it('us-east-1 is unchanged', () => {
      expect(derivePseudoParametersFromRegion('us-east-1', '123456789012')).toEqual({
        accountId: '123456789012',
        region: 'us-east-1',
        partition: 'aws',
        urlSuffix: 'amazonaws.com',
      });
    });

    it('an upper-cased commercial region resolves commercial, as it always did', () => {
      expect(derivePseudoParametersFromRegion('US-EAST-1', '123456789012')).toEqual(
        derivePseudoParametersFromRegion('us-east-1', '123456789012'),
      );
    });

    /**
     * Surfaced while writing the row above: canonicalizing the region is only
     * half the agreement between the two tables. cdk-local's partition table
     * predates the three rows cdkd's issue #1764 added, so for these regions the
     * shim delegates a perfectly canonical region and STILL gets a commercial
     * answer. That is a table-COVERAGE divergence, orthogonal to case, and it is
     * not something this wrapper can fix — filed as issue #1821.
     *
     * Pinned rather than left latent so the day cdk-local gains the rows, this
     * test fails and points at #1821 instead of the divergence being
     * re-discovered from scratch.
     */
    it.each(['us-isof-south-1', 'eu-isoe-west-1', 'eusc-de-east-1'])(
      '%s is a KNOWN cdk-local table gap, not a case bug (issue #1821)',
      (region: string) => {
        expect(derivePseudoParametersFromRegion(region)).toEqual({
          accountId: undefined,
          region,
          partition: 'aws',
          urlSuffix: 'amazonaws.com',
        });
        // Case-folding is still applied — the wrapper does its job here.
        expect(derivePseudoParametersFromRegion(region.toUpperCase())?.region).toBe(region);
      },
    );

    it('an unknown region still falls back to commercial rather than throwing', () => {
      const pseudo = derivePseudoParametersFromRegion('xx-somewhere-9');

      expect(pseudo?.partition).toBe('aws');
      expect(pseudo?.urlSuffix).toBe('amazonaws.com');
    });
  });

  describe('pass-through semantics the wrapper must not change', () => {
    it('leaves an undefined region to upstream to answer', () => {
      expect(derivePseudoParametersFromRegion(undefined)).toBeUndefined();
    });

    it('omits accountId when the caller passes none', () => {
      expect(derivePseudoParametersFromRegion('CN-NORTH-1')?.accountId).toBeUndefined();
    });

    it('forwards the accountId argument verbatim', () => {
      expect(derivePseudoParametersFromRegion('us-east-1', '999988887777')?.accountId).toBe(
        '999988887777',
      );
    });

    it('is idempotent under a second fold, so an upstream fix cannot double-apply', () => {
      const once = derivePseudoParametersFromRegion('CN-NORTH-1');
      expect(derivePseudoParametersFromRegion(once?.region)).toEqual(once);
    });
  });

  /**
   * Binding proof. The wrapper only protects a call site that reaches the symbol
   * THROUGH this shim — a site sourcing it straight from `cdk-local/internal`
   * would silently keep the raw-region behavior, and every assertion above would
   * still pass.
   *
   * So this sweeps the WHOLE of `src/`, rather than checking a hand-listed set
   * of today's call sites: a hardcoded list cannot fail for a file that does not
   * exist yet, which is exactly the regression the proof exists to catch.
   */
  describe('the shim is the only route to the upstream symbol', () => {
    const SYMBOL = 'derivePseudoParametersFromRegion';
    const SHIM = 'src/local/intrinsic-image.ts';
    const srcRoot = new URL('../../../src/', import.meta.url);

    /**
     * True when `source` sources {@link SYMBOL} from `cdk-local/internal`.
     *
     * The predicate has to be narrower than "mentions cdk-local/internal" —
     * these files legitimately take OTHER symbols from it — so it reads the
     * named bindings of each block. It must match BOTH keywords: `export {…}
     * from` is the pre-#1814 shape of this very file and the shape ~10 sibling
     * shims still use, so an `import`-only regex would miss a re-export
     * reintroducing the bug. A namespace binding counts too: `ns.<SYMBOL>(…)`
     * reaches upstream just as directly.
     */
    /**
     * Comments are stripped FIRST. The predicate matches raw text, and this
     * assertion is a set EQUALITY over the whole tree — so one prose mention of
     * the forbidden shape (`// do NOT write: import { … } from 'cdk-local/internal'`)
     * in any `src/**` file would fail the build for an unrelated PR. This repo's
     * comment style makes that likely; the shim's own JSDoc narrates the pre-fix
     * shape a few lines above. Same precedent as `scripts/check-integ-*.ts`,
     * which strip comments before classifying.
     */
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // TRAILING `//`, not just full-line: `const x = 1; // never write:
        // import { … } from 'cdk-local/internal'` is the same false positive
        // one column over. A `//` inside a string literal (a URL) is stripped
        // too, which can only shorten a line that was never an import anyway —
        // an import statement carries no `//`. The block-comment arm is
        // swallow-prone in the other direction (an unbalanced `/*` inside a
        // string consumes to the next `*/`, a false NEGATIVE); zero such
        // occurrences in `src/` today, and the floor below would not catch it,
        // so it is recorded rather than defended against.
        .replace(/\/\/.*$/gm, '');

    const sourcesSymbolFromCdkLocal = (rawSource: string): boolean => {
      const source = stripComments(rawSource);
      const named = /(?:import|export)\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]cdk-local\/internal['"]/g;
      const namespace = /(?:import|export)\s*\*\s*(?:as\s+\w+\s*)?from\s*['"]cdk-local\/internal['"]/;
      // `const { X } = await import('cdk-local/internal')` reaches upstream just
      // as directly as a static import. No such shape exists in `src/` today.
      const dynamic = /\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]cdk-local\/internal['"]\s*\)/g;

      if (namespace.test(source)) return true;

      return [...source.matchAll(named), ...source.matchAll(dynamic)].some((match) =>
        match[1]!
          .split(',')
          .some((binding) => binding.trim().split(/\s+as\s+/)[0]?.trim() === SYMBOL),
      );
    };

    it('the predicate sees every shape it claims to, and no others', () => {
      // Without this the sweep below could pass vacuously — a predicate that
      // never matches anything reports a perfectly clean tree.
      for (const positive of [
        `import { ${SYMBOL}, tryResolveImageFnJoin } from 'cdk-local/internal';`,
        `import { ${SYMBOL} as x } from 'cdk-local/internal';`,
        `export { ${SYMBOL} } from 'cdk-local/internal';`, // the pre-#1814 shape
        `export {\n  ${SYMBOL},\n  substituteImagePlaceholders,\n} from 'cdk-local/internal';`,
        `import type { ${SYMBOL} } from 'cdk-local/internal';`,
        `import * as ns from 'cdk-local/internal';`,
        `export * from 'cdk-local/internal';`,
        `export * as ns from 'cdk-local/internal';`,
        `const { ${SYMBOL} } = await import('cdk-local/internal');`,
      ]) {
        expect(sourcesSymbolFromCdkLocal(positive)).toBe(true);
      }

      for (const negative of [
        `import { tryResolveImageFnJoin } from 'cdk-local/internal';`,
        `export { substituteImagePlaceholders } from 'cdk-local/internal';`,
        `import { ${SYMBOL} } from '../../local/intrinsic-image.js';`, // the correct route
        // The shim's OWN alias target. Exact-equality on the binding name is
        // what keeps this a near-miss rather than a match.
        `import { ${SYMBOL}Upstream } from 'cdk-local/internal';`,
        // Prose mentions, in every comment form. A set-equality assertion over
        // the whole tree turns a false positive here into a broken build for
        // somebody else's PR, so these matter as much as the positives.
        `// ${SYMBOL} is re-exported from 'cdk-local/internal' by the shim`,
        `  // do NOT write: import { ${SYMBOL} } from 'cdk-local/internal';`,
        `/**\n * Never: import { ${SYMBOL} } from 'cdk-local/internal';\n */`,
      ]) {
        expect(sourcesSymbolFromCdkLocal(negative)).toBe(false);
      }
    });

    it(`only ${SHIM} sources it from cdk-local`, () => {
      const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' }).filter((f) =>
        f.endsWith('.ts'),
      );
      // Floor: a broken walk that yielded nothing would report a clean tree.
      expect(files.length).toBeGreaterThan(100);

      const offenders = files.filter((f) =>
        sourcesSymbolFromCdkLocal(readFileSync(new URL(f, srcRoot), 'utf8')),
      );

      expect(offenders.map((f) => `src/${f}`)).toEqual([SHIM]);
    });

    it('and the shim WRAPS it rather than re-exporting it', () => {
      const shim = readFileSync(new URL('local/intrinsic-image.ts', srcRoot), 'utf8');

      // A bare `export { derivePseudoParametersFromRegion } from 'cdk-local/internal'`
      // is exactly the pre-#1814 shape, and would satisfy the sweep above.
      expect(shim).toMatch(
        /export function derivePseudoParametersFromRegion\s*\(/,
      );
      expect(shim).toMatch(/canonicalizeRegion\(region\)/);
    });
  });
});

/** `us-gov-west-1` -> `Us-Gov-West-1`: the shape a hand-typed `--region` takes. */
function toMixedCase(region: string): string {
  return region
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('-');
}
