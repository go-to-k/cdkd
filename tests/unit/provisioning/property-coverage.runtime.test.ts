/**
 * Deploy-time property-coverage runtime helpers (PR5).
 *
 * Distinct from `property-coverage.test.ts` (the offline / Issue #391 test
 * layer that enforces every provider declares `handledProperties` /
 * `unhandledByDesign` consistently with the CFn schema fixture). This file
 * exercises the runtime helpers that drive `ProviderRegistry.validateResourceProperties`:
 *   - `getPropertyCoverage` (lookup)
 *   - `findSilentDropProperties` (per-resource silent-drop detection)
 *   - `unsupportedPropertyIssueUrl` (1-click GitHub issue link)
 *   - `ProviderRegistry.validateResourceProperties` (per-template throw with
 *     actionable error message + escape hatch via `--allow-unsupported-properties`)
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  PROPERTY_COVERAGE_BY_TYPE,
  findSilentDropProperties,
  getPropertyCoverage,
  unsupportedPropertyIssueUrl,
} from '../../../src/provisioning/property-coverage.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

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

describe('ProviderRegistry.validateResourceProperties', () => {
  it('no-op on an empty template', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.validateResourceProperties([])).not.toThrow();
  });

  it('no-op when every property is handled', () => {
    const registry = new ProviderRegistry();
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const handledKey = Array.from(cov.handled)[0];
    if (!handledKey) throw new Error('Lambda Function should declare at least one handled property');
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'MyLambda',
          resourceType: 'AWS::Lambda::Function',
          properties: { [handledKey]: 'x' },
        },
      ])
    ).not.toThrow();
  });

  it('throws on a silent-drop with property name + rationale + re-run command + issue link', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    let message = '';
    try {
      registry.validateResourceProperties([
        {
          logicalId: 'MyResource',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'x' },
        },
      ]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('cdkd would silently drop these properties');
    expect(message).toContain('MyResource');
    expect(message).toContain(fx.resourceType);
    expect(message).toContain(fx.property);
    expect(message).toContain(fx.rationale);
    expect(message).toContain('--allow-unsupported-properties');
    expect(message).toContain(`${fx.resourceType}:${fx.property}`);
    expect(message).toContain('github.com/go-to-k/cdkd/issues/new');
  });

  it('honors the --allow-unsupported-properties escape hatch (per type+property)', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'MyResource',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'x' },
        },
      ])
    ).not.toThrow();
  });

  it('only allows the named entry, not all properties of the same type', () => {
    // Pick a type with two silent-drop entries so we can verify per-property
    // (not per-type) granularity of the escape hatch.
    const pair = pickSilentDropPair();
    const registry = new ProviderRegistry();
    registry.allowUnsupportedProperties([`${pair.resourceType}:${pair.propA}`]);
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'X',
          resourceType: pair.resourceType,
          properties: { [pair.propA]: 'x', [pair.propB]: 'y' },
        },
      ])
    ).toThrow(new RegExp(pair.propB));
  });

  it('groups errors by logical ID + sorts properties alphabetically within each', () => {
    const pair = pickSilentDropPair();
    const registry = new ProviderRegistry();
    let message = '';
    try {
      registry.validateResourceProperties([
        {
          logicalId: 'AlphaResource',
          resourceType: pair.resourceType,
          properties: { [pair.propB]: 'x', [pair.propA]: 'y' },
        },
      ]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('AlphaResource');
    const idxA = message.indexOf(pair.propA);
    const idxB = message.indexOf(pair.propB);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it('sorts logical IDs alphabetically across resources in the error message', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    let message = '';
    try {
      // Pass insertion order Zeta -> Alpha to confirm the renderer sorts.
      registry.validateResourceProperties([
        {
          logicalId: 'ZetaResource',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'x' },
        },
        {
          logicalId: 'AlphaResource',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'y' },
        },
      ]);
    } catch (e) {
      message = (e as Error).message;
    }
    const idxAlpha = message.indexOf('AlphaResource');
    const idxZeta = message.indexOf('ZetaResource');
    expect(idxAlpha).toBeGreaterThan(-1);
    expect(idxZeta).toBeGreaterThan(-1);
    expect(idxAlpha).toBeLessThan(idxZeta);
  });

  it('throws on a mixed template — flags only the silent-drop resource', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    const lambdaCov = getPropertyCoverage('AWS::Lambda::Function');
    if (!lambdaCov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const lambdaHandled = Array.from(lambdaCov.handled)[0];
    if (!lambdaHandled) {
      throw new Error('AWS::Lambda::Function should declare at least one handled property');
    }
    let message = '';
    try {
      registry.validateResourceProperties([
        {
          logicalId: 'GoodLambda',
          resourceType: 'AWS::Lambda::Function',
          properties: { [lambdaHandled]: 'x' },
        },
        {
          logicalId: 'BadResource',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'x' },
        },
      ]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('BadResource');
    expect(message).not.toContain('GoodLambda');
  });

  it('deduplicates re-run command entries when the same type+prop appears in multiple resources', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    let message = '';
    try {
      registry.validateResourceProperties([
        {
          logicalId: 'R1',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'x' },
        },
        {
          logicalId: 'R2',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'y' },
        },
      ]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('R1');
    expect(message).toContain('R2');
    // Re-run command should mention the type+prop pair exactly once.
    const flagSegment = message.slice(message.indexOf('--allow-unsupported-properties'));
    const occurrences = flagSegment.split(`${fx.resourceType}:${fx.property}`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('skips Tier 2 / unknown / Custom resource types (no Tier 1 coverage = no drop)', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'MyCustom',
          resourceType: 'Custom::Foo',
          properties: { Anything: 'goes' },
        },
        {
          logicalId: 'MyMadeUp',
          resourceType: 'AWS::Made::Up',
          properties: { Anything: 'goes' },
        },
      ])
    ).not.toThrow();
  });
});
