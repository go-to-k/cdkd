import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BucketLocationConstraint } from '@aws-sdk/client-s3';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import { ENUM_ABSENT_REGION } from '../_enum-absent-region.js';

/**
 * Fences the BINDING between the shared enum-absent region constant and the
 * four suites that depend on it.
 *
 * Four call sites cast a region string to `BucketLocationConstraint`
 * (`s3-bucket-provider.ts`, `bootstrap.ts`, `state-migrate.ts`,
 * `asset-storage.ts`). Each is fenced by ONE test row passing a region the SDK
 * enum does NOT list, so that a future "soundness fix" filtering the region to
 * enum members reds instead of silently omitting `CreateBucketConfiguration` --
 * which on a REGIONAL endpoint answers `IllegalLocationConstraintException`,
 * i.e. a broken deploy.
 *
 * Three of those rows hardcoded `ca-west-1`. `@aws-sdk/client-s3` 3.1018.0 ->
 * 3.1126.0 grew the enum 33 -> 38 members and took `ca-west-1` with it, so all
 * three went SILENTLY inert -- green through the exact regression they exist to
 * catch (issue [#2862](https://github.com/go-to-k/cdkd/issues/2862)).
 *
 * `s3-bucket-provider-location-constraint-case.test.ts` asserts the constant is
 * still absent, so the enum growing again is LOUD. This file fences what that
 * cannot see: a fenced row that stops passing the constant leaves it intact and
 * worthless.
 *
 * ## Why a PINNED use site rather than source analysis
 *
 * The question is "does THIS row still pass the shared constant", and three
 * revisions answered the harder question "is this identifier used anywhere in
 * this file" instead. All three were measured wrong on the real tree: a
 * `[a-z]{2}`-headed region regex was blind to `eusc-de-east-1` (one of the eight
 * currently-absent regions); a quote-pairing reader desynced on apostrophes in
 * comments, so a hardcoded `'eusc-de-east-1'` sat in the source and the row
 * passed; and an import-stripping matcher ate 692 characters of real code out of
 * `asset-storage.test.ts`, failing an untouched file.
 *
 * Pinning the exact expression each row uses needs none of that -- it is the
 * same primitive as the import check, an exact substring. Its worst case is a
 * VISIBLE failure when someone reformats that one line, with the expected string
 * in the message; the alternatives' worst case was a silent pass or a false
 * failure on a file nobody touched.
 *
 * A scan for hardcoded region LITERALS was also tried and REMOVED. These suites
 * are the only home of the issue-1794 `DenyExternalAccess` partition rows, which
 * legitimately name `aws-iso` / `aws-eusc` regions; the scan would have reported
 * one as an inert fence, with a remedy that is wrong there (a partition row
 * needs a region/partition PAIR) -- and a check that misdiagnoses gets deleted
 * along with the coverage beside it. The use-site pin catches the same mutation
 * without looking at anything but its own line.
 *
 * ## Known bounds
 *
 * - A FIFTH `as BucketLocationConstraint` cast site landing in `src/` gets no
 *   row here; `SIBLING_CAST_SITES` is a literal list and this file cannot see
 *   the new site. The length assertion below makes SHRINKING it loud, not
 *   growing the source.
 * - The pinned expression is compared verbatim, so a purely cosmetic edit to
 *   that line reds. That is the trade named above, and the fix is one line.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_ROOT = join(HERE, '..');

/**
 * The suites fencing the three NON-provider cast sites: the import specifier
 * each must use, and the EXACT expression through which it passes the constant.
 *
 * A literal list, not a glob, and its length is asserted below -- deleting an
 * entry would otherwise just register fewer `it.each` rows and stay green,
 * which is the same silent-shrink mutation this file exists to stop, one level
 * up.
 */
const SIBLING_CAST_SITES = [
  {
    file: 'cli/bootstrap.test.ts',
    specifier: '../_enum-absent-region.js',
    useSite: "'--region', ENUM_ABSENT_REGION",
  },
  {
    file: 'cli/state-migrate.test.ts',
    specifier: '../_enum-absent-region.js',
    useSite: 'const region = ENUM_ABSENT_REGION;',
  },
  {
    file: 'assets/asset-storage.test.ts',
    specifier: '../_enum-absent-region.js',
    useSite: '{ region: ENUM_ABSENT_REGION }',
  },
] as const;

/**
 * The provider suite's own row where issue #2282's case fold meets #2322's enum
 * widening -- it must pass the MIS-CASED spelling, or the fold is untested. Its
 * sibling constants are pinned in that suite; what is pinned here is that the
 * row still READS the mis-cased one.
 */
const MISCASED_CAST_SITE = {
  file: 'provisioning/s3-bucket-provider-location-constraint-case.test.ts',
  specifier: '../_enum-absent-region.js',
  useSite: 'clientRegion.value = ENUM_ABSENT_REGION_MISCASED;',
} as const;

const read = (relative: string): string => readFileSync(join(UNIT_ROOT, relative), 'utf8');

/** Every real region name, from the same table the guard suite measures against. */
const allRegions = (): Set<string> => new Set(RegionInfo.regions.map((r) => r.name));

/** Enum members, i.e. the regions a membership filter would KEEP. */
const enumMembers = (): Set<string> => new Set<string>(Object.values(BucketLocationConstraint));

const ALL_CAST_SITES = [...SIBLING_CAST_SITES, MISCASED_CAST_SITE] as const;

describe('the enum-absent region constant is BOUND to every row that depends on it', () => {
  it('guard-the-guard: the constant is a real region, not us-east-1, and the enum still omits it', () => {
    // Duplicated on purpose from the provider suite's own guard row: the rows
    // below are otherwise satisfied by a binding to a constant that has itself
    // gone stale, and this file would report a healthy binding to a dead value.
    // Both copies read live data, so they cannot disagree.
    const members = enumMembers();
    expect(members.has('eu-west-1'), 'the enum must be populated').toBe(true);
    expect(allRegions().has(ENUM_ABSENT_REGION), 'must be a real region').toBe(true);
    // `us-east-1` is absent BY DESIGN and is the one region whose
    // LocationConstraint must be OMITTED, so it can never fence these sites.
    expect(ENUM_ABSENT_REGION).not.toBe('us-east-1');
    expect(members.has(ENUM_ABSENT_REGION)).toBe(false);
  });

  it('covers all three non-provider cast sites -- the list cannot shrink silently', () => {
    // Without this, deleting an entry registers fewer rows and the file stays
    // green: the population would leave without a failure, which is exactly the
    // shape of the defect being fenced.
    expect(SIBLING_CAST_SITES.map((s) => s.file)).toEqual([
      'cli/bootstrap.test.ts',
      'cli/state-migrate.test.ts',
      'assets/asset-storage.test.ts',
    ]);
  });

  it.each(ALL_CAST_SITES)('$file imports the constant it fences with', ({ file, specifier }) => {
    const source = read(file);
    expect(
      source.includes(`from '${specifier}'`),
      `${file} no longer imports from ${specifier}`
    ).toBe(true);
    expect(
      source.includes('ENUM_ABSENT_REGION'),
      `${file} imports from ${specifier} but names no ENUM_ABSENT_REGION binding`
    ).toBe(true);
  });

  it.each(ALL_CAST_SITES)('$file still PASSES the constant at its fenced row', ({
    file,
    useSite,
  }) => {
    // The import alone proves nothing -- an unused import is caught by neither
    // `tsconfig.test.json` (`noUnusedLocals: false`) nor lint (scoped to
    // `src/**`) -- so a row swapping in a hardcoded region while keeping the
    // import would go inert exactly the way `ca-west-1` did.
    expect(
      read(file).includes(useSite),
      `${file} no longer contains \`${useSite}\` -- if the row was reformatted, update this pin; if it stopped passing the shared constant, that fence is INERT`
    ).toBe(true);
  });
});
