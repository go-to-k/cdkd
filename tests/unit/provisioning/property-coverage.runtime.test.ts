/**
 * Deploy-time property-coverage runtime helpers (PR5).
 *
 * Distinct from `property-coverage.test.ts` (the offline / Issue #391 test
 * layer that enforces every provider declares `handledProperties` /
 * `unhandledByDesign` consistently with the CFn schema fixture). This file
 * exercises the runtime helpers:
 *   - `getPropertyCoverage` (lookup)
 *   - `findSilentDropProperties` (per-resource silent-drop detection)
 *   - `findActionableSilentDrops` (silent drops minus the override allow-set)
 *   - `unsupportedPropertyIssueUrl` (1-click GitHub issue link)
 *
 * The throw-based `ProviderRegistry.validateResourceProperties` tests were
 * removed when #614 reversed the silent-drop policy: the method now
 * auto-routes via Cloud Control API + info-logs instead of throwing. The
 * info-/warn-log shape is covered by
 * `provider-registry-report-silent-drops.test.ts`; the routing decisions
 * are covered by `provider-registry-cc-routing.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  PROPERTY_COVERAGE_BY_TYPE,
  findActionableSilentDrops,
  findSilentDropProperties,
  getPropertyCoverage,
  unsupportedPropertyIssueUrl,
} from '../../../src/provisioning/property-coverage.js';

describe('getPropertyCoverage', () => {
  it('returns a record for a Tier 1 SDK-provider type', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    expect(cov).toBeDefined();
    expect(cov!.handled.size).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown type', () => {
    expect(getPropertyCoverage('AWS::Made::Up')).toBeUndefined();
  });

  it('returns undefined for a Custom:: type (no SDK-provider write-side drop)', () => {
    expect(getPropertyCoverage('Custom::Foo')).toBeUndefined();
  });
});

describe('findSilentDropProperties', () => {
  it('returns [] when the resource type has no coverage record (Tier 2 / Custom / unknown)', () => {
    expect(findSilentDropProperties('AWS::Made::Up', { Foo: 'bar' })).toEqual([]);
  });

  it('returns [] when properties is undefined or empty', () => {
    expect(findSilentDropProperties('AWS::Lambda::Function', undefined)).toEqual([]);
    expect(findSilentDropProperties('AWS::Lambda::Function', {})).toEqual([]);
  });

  it('returns [] when every property is handled', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const handledKey = Array.from(cov.handled)[0];
    if (!handledKey) throw new Error('Lambda Function should declare at least one handled property');
    expect(
      findSilentDropProperties('AWS::Lambda::Function', { [handledKey]: 'x' })
    ).toEqual([]);
  });

  it('flags a silent-drop property with its rationale', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const dropKey = Array.from(cov.silentDrop.keys())[0];
    if (!dropKey) return; // No silent drops left — provider has caught up.
    const drops = findSilentDropProperties('AWS::Lambda::Function', { [dropKey]: 'x' });
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual({
      property: dropKey,
      rationale: cov.silentDrop.get(dropKey),
    });
  });

  it('passes through properties NOT in the CFn schema (escape hatch / typo tolerance)', () => {
    expect(
      findSilentDropProperties('AWS::Lambda::Function', {
        SomeFakeUnknownProperty: 'x',
      })
    ).toEqual([]);
  });

  it('sorts results alphabetically by property name', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    if (cov.silentDrop.size < 2) {
      throw new Error('AWS::Lambda::Function should declare ≥2 silent-drop properties');
    }
    const keys = Array.from(cov.silentDrop.keys());
    const reversed = [...keys].reverse();
    const props = Object.fromEntries(reversed.map((k) => [k, 'x']));
    const drops = findSilentDropProperties('AWS::Lambda::Function', props);
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
    expect(drops.map((d) => d.property)).toEqual(sortedKeys);
  });
});

describe('unsupportedPropertyIssueUrl', () => {
  it('URL-encodes the resource type + property in the title', () => {
    const url = unsupportedPropertyIssueUrl('AWS::Lambda::Function', 'LoggingConfig');
    expect(url).toContain('github.com/go-to-k/cdkd/issues/new');
    expect(url).toContain('labels=resource-support');
    expect(url).toContain('AWS%3A%3ALambda%3A%3AFunction.LoggingConfig');
  });
});

describe('PROPERTY_COVERAGE_BY_TYPE shape', () => {
  it('contains at least one Tier 1 SDK-provider type', () => {
    expect(PROPERTY_COVERAGE_BY_TYPE.size).toBeGreaterThan(0);
  });
});

/**
 * Find a (type, property, rationale) triple from the generated coverage map
 * so the tests below stay declarative against whichever silent-drop type the
 * generator surfaces today. Throws if every Tier 1 type is fully handled —
 * at that point the runtime reject path has no exercise input and these
 * tests would silently no-op, masking regressions. Today the generated map
 * carries 469 silent-drop entries, so this is far from triggering; the
 * throw exists so the tests fail loudly when (eventually) every gap is
 * closed and a different test shape is required.
 */
function pickSilentDropFixture(): {
  resourceType: string;
  property: string;
  rationale: string;
} {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const first = cov.silentDrop.entries().next();
    if (!first.done) {
      const [property, rationale] = first.value;
      return { resourceType, property, rationale };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no silent-drop entries — every Tier 1 ' +
      'type is fully handled. Update these tests to exercise the reject path ' +
      'against a synthetic fixture instead of the generated map.'
  );
}

/**
 * Find a (type, propA, propB) triple where the type has ≥2 silent-drop
 * entries — used by tests that need to verify per-property granularity.
 * Throws (rather than silently skipping) so a regression in the generated
 * map fails the suite loudly. Today many Tier 1 types satisfy this (e.g.
 * AWS::Lambda::Function has 15 silent-drop entries), so the throw is the
 * safe default.
 */
function pickSilentDropPair(): { resourceType: string; propA: string; propB: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.silentDrop.size >= 2) {
      const sorted = Array.from(cov.silentDrop.keys()).sort((x, y) => x.localeCompare(y));
      return { resourceType, propA: sorted[0]!, propB: sorted[1]! };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no type with ≥2 silent-drop entries — ' +
      'these tests assume at least one type with multiple gaps. Update them ' +
      'to use a synthetic fixture instead of the generated map.'
  );
}

describe('findActionableSilentDrops (#614)', () => {
  it('returns the full set when allowedKeys is empty', () => {
    const fx = pickSilentDropFixture();
    const drops = findActionableSilentDrops(
      fx.resourceType,
      { [fx.property]: 'x' },
      new Set()
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]?.property).toBe(fx.property);
  });

  it('filters out drops whose <Type>:<Prop> key is in allowedKeys', () => {
    const fx = pickSilentDropFixture();
    const drops = findActionableSilentDrops(
      fx.resourceType,
      { [fx.property]: 'x' },
      new Set([`${fx.resourceType}:${fx.property}`])
    );
    expect(drops).toEqual([]);
  });

  it('only filters by the exact <Type>:<Prop> token — siblings remain', () => {
    const pair = pickSilentDropPair();
    const drops = findActionableSilentDrops(
      pair.resourceType,
      { [pair.propA]: 'x', [pair.propB]: 'y' },
      new Set([`${pair.resourceType}:${pair.propA}`])
    );
    expect(drops.map((d) => d.property)).toEqual([pair.propB]);
  });

  it('preserves alphabetical sort from findSilentDropProperties', () => {
    const pair = pickSilentDropPair();
    const drops = findActionableSilentDrops(
      pair.resourceType,
      { [pair.propB]: 'x', [pair.propA]: 'y' },
      new Set()
    );
    expect(drops.map((d) => d.property)).toEqual([pair.propA, pair.propB]);
  });
});
