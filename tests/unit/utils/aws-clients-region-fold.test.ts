import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { AwsClients } from '../../../src/utils/aws-clients.js';
import { canonicalizeRegion } from '../../../src/utils/aws-partition.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AWS_CLIENTS_PATH = join(REPO_ROOT, 'src', 'utils', 'aws-clients.ts');

/**
 * Issue [#2065](https://github.com/go-to-k/cdkd/issues/2065) — the client
 * constructor is the LAST fold, behind the per-command one in
 * `src/cli/region-options.ts`. It is what covers a library caller that never
 * runs a CLI handler, and it is the reason `client.config.region()` — the
 * source the six provider ARN builders in issue
 * [#1881](https://github.com/go-to-k/cdkd/issues/1881) interpolate raw — is
 * canonical for every CONFIGURED bag.
 */
describe('AwsClients folds its configured region', () => {
  it('folds an upper-cased region handed to the constructor', () => {
    expect(new AwsClients({ region: 'US-EAST-1' }).configuredRegion).toBe('us-east-1');
  });

  it('folds a mixed-case NON-commercial region, where the partition also turns on it', () => {
    // The partition table's walk is a case-sensitive `startsWith`, so this is
    // the spelling that resolved to the COMMERCIAL suffix before #1795.
    expect(new AwsClients({ region: 'CN-North-1' }).configuredRegion).toBe('cn-north-1');
  });

  it('leaves an already-canonical region byte-identical', () => {
    expect(new AwsClients({ region: 'ap-northeast-1' }).configuredRegion).toBe('ap-northeast-1');
  });

  it('keeps an ABSENT region absent — undefined is a distinct answer from any region', () => {
    // Load-bearing for issue #2029: `clientOptions` omits `region` entirely in
    // this case, which is what lets the SDK's own chain resolve the profile.
    expect(new AwsClients({}).configuredRegion).toBeUndefined();
    expect(new AwsClients({ profile: 'p' }).configuredRegion).toBeUndefined();
  });

  it('reaches the CONSTRUCTED client, not just the reported config', async () => {
    // `configuredRegion` reads `this.config`, so it would still pass if the
    // fold were applied there and nowhere else. This asserts the value the SDK
    // actually signs with — the thing S3 rejected with
    // `AuthorizationHeaderMalformed: the region 'US-EAST-1' is wrong`.
    const clients = new AwsClients({ region: 'US-WEST-2' });
    try {
      await expect(clients.s3.config.region()).resolves.toBe('us-west-2');
    } finally {
      clients.destroy();
    }
  });

  it('agrees with canonicalizeRegion, which it may not import (see foldRegion)', () => {
    // The inlined copy exists only because this file must stay resolvable by
    // `node`'s native type stripping. Pin the two together so the copy cannot
    // drift into a second, different normalization.
    for (const spelling of [
      'US-EAST-1',
      'us-east-1',
      'CN-North-1',
      'eu-west-3',
      'US-GOV-WEST-1',
      'eusc-de-east-1',
      'AP-Southeast-4',
    ]) {
      expect(new AwsClients({ region: spelling }).configuredRegion).toBe(
        canonicalizeRegion(spelling)
      );
    }
  });
});

/**
 * The fence for the constraint that produced the inlined copy in the first
 * place. `scripts/audit-provider-coverage.ts` imports this module as
 * `'../src/utils/aws-clients.ts'` and runs under `node scripts/…` with native
 * type stripping, which resolves relative specifiers LITERALLY — so a
 * `./foo.js` import resolves to a file that does not exist on disk and the
 * script dies with `ERR_MODULE_NOT_FOUND`.
 *
 * Without this test the failure surfaces as ~32 unrelated
 * `gen-nested-key-coverage` cases going red, several files away from the import
 * that caused them.
 *
 * WHAT THIS ASSERTS, AND WHY IT CHANGED (issue #2388)
 *
 * It used to assert `relativeImports === []`, which is a SUFFICIENT condition
 * for resolvability, not the property itself — and it was too strict in one
 * direction while being blind in another. Too strict: the `.ts` spelling
 * resolves under BOTH the script and `tsc` (which is why
 * `scripts/audit-provider-coverage.ts` uses it, and
 * `rewriteRelativeImportExtensions` in `tsconfig.json` is what emits it as
 * `.js`), so banning every relative import banned a working one. Blind: the
 * constraint is TRANSITIVE — a `./dep.js` two hops down breaks the script just
 * as hard, from a file the old assertion never opened — so relaxing the
 * spelling without widening the SCOPE would have opened a hole in the same
 * change that closed one.
 *
 * So it now asserts the actual property: every relative import reachable from
 * `aws-clients.ts` resolves to a file that exists under literal resolution.
 */
describe('aws-clients.ts stays resolvable under node type stripping', () => {
  /**
   * Every relative specifier in one module, covering the three forms Node
   * resolves: `from '…'`, a bare side-effect `import '…'`, and a dynamic
   * `import('…')`. The static forms are anchored to a line-leading
   * `import` / `export` so prose in a JSDoc block cannot pose as one.
   */
  function relativeSpecifiers(source: string): string[] {
    const found = [
      ...source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+'(\.[^']*)'/gm),
      ...source.matchAll(/^\s*import\s+'(\.[^']*)'/gm),
      ...source.matchAll(/\bimport\s*\(\s*'(\.[^']*)'/g),
    ].map((m) => m[1]!);
    return [...new Set(found)];
  }

  /** Walk the closure the way `node` would, reporting what it cannot resolve. */
  function walkClosure(entry: string): { files: string[]; unresolved: string[] } {
    const files: string[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
      for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
        // LITERAL resolution — no extension substitution, which is exactly the
        // step `node`'s type stripping declines to perform.
        const target = join(dirname(file), spec);
        if (!existsSync(target)) {
          unresolved.push(`${relative(REPO_ROOT, file)} -> ${spec}`);
          continue;
        }
        queue.push(target);
      }
    }
    return { files, unresolved };
  }

  const closure = walkClosure(AWS_CLIENTS_PATH);

  it('resolves every relative import in the closure, not just this file\'s own', () => {
    expect(closure.unresolved).toEqual([]);
  });

  it('walks past the entry file — the transitive half is what a spelling check missed', () => {
    // A FLOOR on the walk. Without it, a matcher that silently stops seeing
    // imports reports an empty `unresolved` and passes vacuously; the closure
    // is `aws-clients.ts` -> `aws-client-defaults.ts` -> `proxy-routing-agent.ts`.
    expect(closure.files.length).toBeGreaterThanOrEqual(3);
  });

  it('still reads the entry file rather than matching nothing', () => {
    const source = readFileSync(AWS_CLIENTS_PATH, 'utf8');
    const packageImports = [...source.matchAll(/^\s*import[^\n]*?from\s+'([^.'][^']*)'/gm)];
    expect(packageImports.length).toBeGreaterThan(10);
  });

  it('reports a `.js`-spelled relative import — the failure it exists to catch', () => {
    // The COLLAPSE-TOWARD-GREEN defence: an `unresolved` that is empty because
    // the walk cannot fail is indistinguishable from a clean tree, and only a
    // known-bad input tells the two apart. Uses the real spellings of the real
    // closure, so it also fails if `aws-client-defaults.ts` is renamed.
    expect(relativeSpecifiers("import { x } from './aws-client-defaults.js';")).toEqual([
      './aws-client-defaults.js',
    ]);
    expect(existsSync(join(dirname(AWS_CLIENTS_PATH), './aws-client-defaults.js'))).toBe(false);
    expect(existsSync(join(dirname(AWS_CLIENTS_PATH), './aws-client-defaults.ts'))).toBe(true);
  });

  it('sees a side-effect import and a dynamic import, not only `from`', () => {
    expect(relativeSpecifiers("import './side.js';")).toEqual(['./side.js']);
    expect(relativeSpecifiers("const m = await import('./dyn.js');")).toEqual(['./dyn.js']);
    // Prose in a JSDoc block is not an import.
    expect(relativeSpecifiers(' * `./aws-partition.js` import here is fine')).toEqual([]);
  });
});
