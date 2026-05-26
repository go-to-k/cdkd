/**
 * Routing decision matrix for {@link ProviderRegistry.getProviderFor}
 * (issue [#614](https://github.com/go-to-k/cdkd/issues/614) — Cloud
 * Control API greenfield fallback).
 *
 * Each test pins one row of the decision tree documented on the class
 * docstring. The tests use `PROPERTY_COVERAGE_BY_TYPE` to discover a
 * real Tier 1 type with one or more silent-drop entries so they stay
 * declarative against the generated map; if the project ever closes
 * every silent-drop gap, the helper throws so the test fails loudly
 * instead of silently no-opping.
 */
import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

/**
 * Find a (type, property) tuple where the type has at least one silent-drop
 * entry. Throws when the generated map has none left.
 */
function pickSilentDropFixture(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const first = cov.silentDrop.entries().next();
    if (!first.done) {
      return { resourceType, property: first.value[0] };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no silent-drop entries — every Tier 1 ' +
      'type is fully handled. Update these tests to use a synthetic fixture.'
  );
}

/**
 * Find a (type, propA, propB) triple where the type has ≥ 2 silent-drop
 * entries. Used by tests that need per-property granularity.
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
      'the partial-override test needs at least one such type.'
  );
}

/**
 * Build a tiny stub SDK provider exposing only what the registry
 * inspects (no AWS calls). Keeps each test free of unrelated mocking.
 */
function stubSdkProvider(): ResourceProvider {
  return {
    create: () => Promise.resolve({ physicalId: 'phys' }),
    update: () => Promise.resolve({ physicalId: 'phys' }),
    delete: () => Promise.resolve(),
    getAttribute: () => Promise.resolve(undefined),
  } as ResourceProvider;
}

describe('ProviderRegistry.getProviderFor', () => {
  it('routes Custom Resources via the Custom Resource provider, recorded as sdk', () => {
    const registry = new ProviderRegistry();
    const decision = registry.getProviderFor({
      resourceType: 'Custom::Foo',
      properties: { ServiceToken: 'arn:aws:lambda:::function:foo' },
    });
    // Custom::* always routes to the dedicated custom-resource provider,
    // but the state field records 'sdk' so v7+ writers always populate
    // the layer label.
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.ccRouteReason).toBeUndefined();
    // It is NOT the Cloud Control provider.
    expect(decision.provider).not.toBe(registry.getCloudControlProvider());
  });

  it('routes AWS::CloudFormation::CustomResource the same way as Custom::*', () => {
    const registry = new ProviderRegistry();
    const decision = registry.getProviderFor({
      resourceType: 'AWS::CloudFormation::CustomResource',
      properties: {},
    });
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.provider).not.toBe(registry.getCloudControlProvider());
  });

  it('keeps an existing provisionedBy: cc-api resource on Cloud Control (sticky)', () => {
    const registry = new ProviderRegistry();
    // Register an SDK provider for a Tier 1 type so the un-sticky path
    // would normally hit the SDK provider. We then assert that the
    // state-recorded layer overrides that.
    const fx = pickSilentDropFixture();
    const sdk = stubSdkProvider();
    registry.register(fx.resourceType, sdk);

    const decision = registry.getProviderFor({
      resourceType: fx.resourceType,
      properties: {}, // no silent drops in the template
      provisionedBy: 'cc-api',
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.provider).toBe(registry.getCloudControlProvider());
  });

  it('routes a Tier 1 type with no silent-drop properties to the SDK provider', () => {
    const registry = new ProviderRegistry();
    const fx = pickSilentDropFixture();
    const sdk = stubSdkProvider();
    registry.register(fx.resourceType, sdk);

    // Pass an empty property bag — no silent drops to trigger CC.
    const decision = registry.getProviderFor({
      resourceType: fx.resourceType,
      properties: {},
    });
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.provider).toBe(sdk);
    expect(decision.ccRouteReason).toBeUndefined();
  });

  it('auto-routes via Cloud Control when an SDK type would silent-drop a property (#614)', () => {
    const registry = new ProviderRegistry();
    const fx = pickSilentDropFixture();
    const sdk = stubSdkProvider();
    registry.register(fx.resourceType, sdk);

    const decision = registry.getProviderFor({
      resourceType: fx.resourceType,
      properties: { [fx.property]: 'anything' },
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.provider).toBe(registry.getCloudControlProvider());
    expect(decision.ccRouteReason?.properties).toEqual([fx.property]);
  });

  it('partial --allow-unsupported-properties override still triggers CC for the non-overridden drops', () => {
    const pair = pickSilentDropPair();
    const registry = new ProviderRegistry();
    const sdk = stubSdkProvider();
    registry.register(pair.resourceType, sdk);
    // Override only one of the two drops.
    registry.allowUnsupportedProperties([`${pair.resourceType}:${pair.propA}`]);

    const decision = registry.getProviderFor({
      resourceType: pair.resourceType,
      properties: {
        [pair.propA]: 'allowed',
        [pair.propB]: 'not-allowed',
      },
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.ccRouteReason?.properties).toEqual([pair.propB]);
  });

  it('full --allow-unsupported-properties override keeps the resource on the SDK provider', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    const sdk = stubSdkProvider();
    registry.register(fx.resourceType, sdk);
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);

    const decision = registry.getProviderFor({
      resourceType: fx.resourceType,
      properties: { [fx.property]: 'allowed' },
    });
    // Every silent-drop property is in the allow set → SDK Provider
    // path, the user has explicitly opted into the silent drop.
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.provider).toBe(sdk);
  });

  it('routes a Tier 2 type (no SDK provider, CC-supported) via Cloud Control', () => {
    const registry = new ProviderRegistry();
    // S3::Bucket has an SDK provider in the live registry, but this
    // standalone registry has no providers registered — so the SDK path
    // is skipped and the CC path is used.
    const decision = registry.getProviderFor({ resourceType: 'AWS::S3::Bucket' });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.provider).toBe(registry.getCloudControlProvider());
    expect(decision.ccRouteReason).toBeUndefined();
  });

  it('routes a --allow-unsupported-types escape-hatch type via Cloud Control optimistically', () => {
    const registry = new ProviderRegistry();
    registry.allowUnsupportedTypes(['AWS::AppMesh::Mesh']);
    const decision = registry.getProviderFor({ resourceType: 'AWS::AppMesh::Mesh' });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.provider).toBe(registry.getCloudControlProvider());
  });

  it('throws for a totally unsupported type with no SDK / CC / escape-hatch coverage', () => {
    const registry = new ProviderRegistry();
    // `CloudControlProvider.isSupportedResourceType` accepts everything in
    // the `AWS::` namespace optimistically, so we use a non-AWS::, non-Custom::
    // namespace to exercise the final no-provider throw branch.
    expect(() =>
      registry.getProviderFor({ resourceType: 'ThirdParty::Made::Up' })
    ).toThrow(/No provider available/);
  });
});

describe('ProviderRegistry.findAutoRouteHits', () => {
  it('returns [] when no resource has actionable silent drops', () => {
    const registry = new ProviderRegistry();
    expect(registry.findAutoRouteHits([])).toEqual([]);
    expect(
      registry.findAutoRouteHits([
        { logicalId: 'X', resourceType: 'AWS::S3::Bucket', properties: {} },
      ])
    ).toEqual([]);
  });

  it('returns one hit per resource with un-allowed silent-drop properties', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    const hits = registry.findAutoRouteHits([
      {
        logicalId: 'X',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
      },
    ]);
    expect(hits).toEqual([
      {
        logicalId: 'X',
        resourceType: fx.resourceType,
        properties: [fx.property],
      },
    ]);
  });

  it('excludes a resource whose silent drops are entirely in the allow set', () => {
    const fx = pickSilentDropFixture();
    const registry = new ProviderRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
    const hits = registry.findAutoRouteHits([
      {
        logicalId: 'X',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
      },
    ]);
    expect(hits).toEqual([]);
  });
});
