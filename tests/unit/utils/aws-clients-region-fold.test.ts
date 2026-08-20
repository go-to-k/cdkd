import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * `./foo.js` import here resolves to a file that does not exist on disk and
 * the script dies with `ERR_MODULE_NOT_FOUND`.
 *
 * Without this test the failure surfaces as ~32 unrelated
 * `gen-nested-key-coverage` cases going red, several files away from the import
 * that caused them.
 */
describe('aws-clients.ts stays resolvable under node type stripping', () => {
  const source = readFileSync(AWS_CLIENTS_PATH, 'utf8');
  const relativeImports = [
    ...source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+'(\.[^']*)'/gm),
  ].map((m) => m[1]!);

  it('has no relative import at all — the script resolves this file directly', () => {
    // A FLOOR on the matcher: if the regex ever stops seeing imports, the
    // package-import count proves it is still reading the file rather than
    // silently matching nothing.
    const packageImports = [...source.matchAll(/^\s*import[^\n]*?from\s+'([^.'][^']*)'/gm)];
    expect(packageImports.length).toBeGreaterThan(10);
    expect(relativeImports).toEqual([]);
  });
});
