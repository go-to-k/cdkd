import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROPERTY_COVERAGE_BY_TYPE,
  withoutAcceptedSilentDropProperties,
  withoutSilentDropProperties,
} from '../../../src/provisioning/property-coverage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCHEMA_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'cfn-schemas');

/**
 * Two disjointness invariants the issue
 * [#2750](https://github.com/go-to-k/cdkd/issues/2750) narrowing depends on.
 *
 * That change removes a type's SILENT-DROP keys from the state record and from
 * the record side of the diff, on the ground that the SDK route cannot have
 * written one. Both cases below bound what that removal may touch: the first
 * says no data-loss guard reads such a key, the second that the narrowing
 * leaves a CREATE-ONLY one alone.
 *
 * Neither holds by construction — `silentDrop` is regenerated from AWS's
 * published schemas by `vp run gen:property-coverage`, so a provider losing a
 * `handledProperties` entry, or AWS publishing a property cdkd does not wire,
 * moves a key INTO the set with no code change at all.
 */
describe('silent-drop keys are disjoint from what other layers read (#2750)', () => {
  /**
   * A key the DATA-LOSS guards read out of a recorded property bag.
   *
   * Enumerated by hand and deliberately so: these are the reads that decide
   * whether cdkd is allowed to destroy a user's data, and a grep-derived
   * population would silently shrink when one is renamed. Sourced from
   * `src/provisioning/stateful-types.ts` (`logGroupHasPositiveRetention`),
   * `src/provisioning/data-delete-intent.ts` (`hasCdkAutoDeleteTag` reads
   * `Tags`), and `ECRProvider.delete` (`EmptyOnDelete`).
   */
  const GUARD_KEYS: ReadonlyArray<readonly [string, string]> = [
    ['AWS::Logs::LogGroup', 'RetentionInDays'],
    ['AWS::S3::Bucket', 'Tags'],
    ['AWS::S3Express::DirectoryBucket', 'Tags'],
    ['AWS::ECR::Repository', 'Tags'],
    ['AWS::ECR::Repository', 'EmptyOnDelete'],
  ];

  it('PREMISE: every guard key names a type cdkd has coverage for', () => {
    // Without this the loop below passes vacuously the moment a type leaves
    // the Tier 1 map — `getPropertyCoverage` returns undefined and no key can
    // be in a set that does not exist.
    for (const [type] of GUARD_KEYS) {
      expect(PROPERTY_COVERAGE_BY_TYPE.get(type), `${type} lost its coverage record`).toBeDefined();
    }
  });

  it('no data-loss guard reads a key the record narrowing removes', () => {
    const violations: string[] = [];
    for (const [type, property] of GUARD_KEYS) {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(type);
      if (coverage?.silentDrop.has(property)) {
        violations.push(`${type}.${property}`);
      }
    }
    expect(
      violations,
      'A data-loss guard reads a property cdkd now strips from the SDK-routed ' +
        'state record (#2750), so the guard would see nothing and could fail ' +
        'OPEN — a destroy-and-recreate with no --force-stateful-recreation ' +
        'prompt. Either wire the property in its provider (moving it out of ' +
        'silentDrop) or make the guard read `observedProperties` instead.'
    ).toEqual([]);
  });

  /**
   * The other direction, found by the go-to-k/cdkd#2788 review: the record-side
   * narrowing turns a dropped key into an ADDITION against the template, and
   * `createOnlyChangeRequiresReplacement` classifies an added create-only path
   * as a REPLACEMENT. A silent drop that is also create-only would therefore
   * DELETE + CREATE a resource on a plain upgrade deploy over an unchanged
   * template, and `promoteReplacementDependents` would cascade it.
   *
   * That intersection is NOT empty — 24 types carry 80 such pairs — so the
   * invariant is not "no drop is create-only" but "the narrowing does not
   * REMOVE one". The first cut of this file asserted the former with a
   * pointer-shaped parse (`path.split('/')[2]`) and passed on all 134 fixtures
   * having compared nothing, because `scripts/refresh-cfn-schemas.mjs` already
   * strips the `/properties/` prefix before writing; the injected violation
   * that "reddened" it was a `/properties/X` entry, a shape the repo never
   * contains. Read the fixture entries as the bare names they are.
   *
   * The runtime classification resolves `createOnlyProperties` from the LIVE
   * CloudFormation registry via `DescribeType`, not from these fixtures, so
   * this fence does not PROVE the runtime intersection is respected. It proves
   * the committed snapshot's is — the same snapshot
   * `vp run gen:property-coverage` derives `createOnlyDrops` from, which is
   * what the narrowing actually consults.
   */
  it('the narrowing never removes a create-only property (#2790 is the residual)', () => {
    const violations: string[] = [];
    let typesRead = 0;
    let dropsChecked = 0;
    let typesWithCreateOnlyDrops = 0;
    let createOnlyDropsSeen = 0;

    for (const file of readdirSync(SCHEMA_DIR)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as {
        resourceType?: string;
        createOnlyProperties?: string[];
      };
      const type = schema.resourceType;
      if (!type) continue;
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(type);
      if (!coverage) continue;
      typesRead++;

      // BARE top-level names. `refresh-cfn-schemas.mjs` filters to
      // `/properties/<name>` entries, strips the prefix, and drops anything
      // still containing a slash — so a pointer-shaped parse here yields an
      // empty set for every type and the whole case goes inert.
      const createOnly = new Set(schema.createOnlyProperties ?? []);
      const perTypeCreateOnlyDrops: string[] = [];

      // The OTHER direction, and it is not symmetry: an OVER-emitted
      // `createOnlyDrops` entry makes the narrowing keep a key it should
      // remove, which reverts go-to-k/cdkd#2750 for that pair — silently, since
      // the generated file still matches what the generator produces, so CI's
      // drift job cannot see it either. Measured green before this loop existed.
      for (const emitted of coverage.createOnlyDrops) {
        if (!createOnly.has(emitted)) {
          violations.push(`${type}.${emitted} (createOnlyDrops entry is not create-only in the schema)`);
        }
        if (!coverage.silentDrop.has(emitted)) {
          violations.push(`${type}.${emitted} (createOnlyDrops entry is not a silent drop)`);
        }
      }

      for (const property of coverage.silentDrop.keys()) {
        dropsChecked++;
        if (!createOnly.has(property)) continue;
        perTypeCreateOnlyDrops.push(property);
        createOnlyDropsSeen++;
        // The generated set the narrowing reads must agree with the schema it
        // was generated from — otherwise the exclusion is keyed on a set that
        // does not describe the property.
        if (!coverage.createOnlyDrops.has(property)) {
          violations.push(`${type}.${property} (absent from createOnlyDrops)`);
          continue;
        }
        // The load-bearing assertion: the narrowing LEAVES it.
        const narrowed = withoutSilentDropProperties(type, { [property]: 'x' });
        if (!(property in narrowed)) {
          violations.push(`${type}.${property} (removed by withoutSilentDropProperties)`);
        }
        const desiredNarrowed = withoutAcceptedSilentDropProperties(
          type,
          { [property]: 'x' },
          new Set([`${type}:${property}`])
        );
        if (!(property in desiredNarrowed)) {
          violations.push(`${type}.${property} (removed by withoutAcceptedSilentDropProperties)`);
        }
      }
      if (perTypeCreateOnlyDrops.length > 0) typesWithCreateOnlyDrops++;
    }

    // Floors on the WALK and on the COMPARAND. The walk floors alone are what
    // let the pointer-shaped parse pass: they watched how many fixtures were
    // opened, never whether anything was compared. Literals rather than a
    // re-derivation, so a count computed from the same walk cannot satisfy the
    // fence it guards.
    expect(typesRead, 'read too few schema fixtures — is the walk still finding them?').toBeGreaterThan(100);
    expect(dropsChecked, 'checked too few silent drops — is the coverage map still populated?').toBeGreaterThan(200);
    expect(
      typesWithCreateOnlyDrops,
      'no type has a create-only silent drop — the comparand collapsed, so this ' +
        'case is asserting nothing. Check how `createOnlyProperties` is spelled ' +
        'in tests/fixtures/cfn-schemas/*.json before believing it.'
    ).toBeGreaterThan(15);
    expect(createOnlyDropsSeen, 'too few create-only drops compared').toBeGreaterThan(50);

    expect(
      violations,
      'The #2750 create-only exclusion and the schema it is derived from ' +
        'disagree. Either an emitted `createOnlyDrops` member is not ' +
        'create-only (or not a silent drop) in the schema, which makes the ' +
        'narrowing KEEP a key it should remove and reverts #2750 for that ' +
        'pair; or the narrowing REMOVED a create-only one, which is the ' +
        'destructive direction — such a key then reads as an ADDITION on the ' +
        'next deploy, which the create-only fallback classifies as a ' +
        'REPLACEMENT, so an upgrade deploy over an unchanged template would ' +
        'destroy and re-create the resource and cascade to its dependents. ' +
        'The exclusion lives in `removableSilentDrops`; go-to-k/cdkd#2790 ' +
        'carries the residual it leaves.'
    ).toEqual([]);
  });
});
