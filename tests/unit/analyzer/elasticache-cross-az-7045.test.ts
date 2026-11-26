import { describe, it, expect, vi } from 'vite-plus/test';

// Issue #7045: a memcached CacheCluster moved from `AZMode: single-az` with
// no zone list to `AZMode: cross-az` with a list naming two zones, keeping
// NumCacheNodes, is REPLACED by real CloudFormation (us-east-1, 2026-11-26,
// change set + execution: a new cluster with nodes in 1a and 1b).
// ModifyCacheCluster carries AZMode only beside nodes to add, so an in-place
// update left the cluster in one zone. The neighbouring shapes nobody
// measured keep the in-place update.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    ...actual,
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, tryGetTopLevelWriteOnlyProperties: async () => new Set<string>() };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  ReplacementRulesRegistry,
  elastiCacheAzModeRemovedFromSingleAz,
} from '../../../src/analyzer/replacement-rules.js';
import { elastiCachePreferredAvailabilityZonesReplaced } from '../../../src/analyzer/replacement-rules/predicates.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::ElastiCache::CacheCluster';

const state = (props: Record<string, unknown>): StackState =>
  ({
    version: 3,
    region: 'us-east-1',
    stackName: 's',
    resources: {
      Cache: {
        physicalId: 'cdkd-c-1',
        resourceType: TYPE,
        properties: props,
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  }) as unknown as StackState;
const template = (props: Record<string, unknown>): CloudFormationTemplate =>
  ({ Resources: { Cache: { Type: TYPE, Properties: props } } }) as CloudFormationTemplate;

const diff = async (oldProps: Record<string, unknown>, newProps: Record<string, unknown>) => {
  const change = (await new DiffCalculator().calculateDiff(state(oldProps), template(newProps))).get(
    'Cache'
  );
  return (change?.propertyChanges ?? [])
    .filter((p) => p.requiresReplacement)
    .map((p) => p.path)
    .sort();
};

const base = { Engine: 'memcached', CacheNodeType: 'cache.t4g.micro' };
/** The measured v1 / v2 templates (#7038's measurement lane). */
const singleAz = { ...base, NumCacheNodes: 2, AZMode: 'single-az' };
const crossAz = {
  ...base,
  NumCacheNodes: 2,
  AZMode: 'cross-az',
  PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b'],
};

describe('CacheCluster single-az -> cross-az through the diff (issue #7045)', () => {
  it('replaces the measured change: same node count, a two-zone list added', async () => {
    // Marked on the zone list only, as CloudFormation's change set marks it
    // (PreferredAvailabilityZones Conditionally, AZMode Never).
    expect(await diff(singleAz, crossAz)).toEqual(['PreferredAvailabilityZones']);
  });

  it('keeps the unmeasured neighbours in place', async () => {
    // A scale-out beside the move (NewAvailabilityZones carries the AZMode).
    expect(
      await diff(
        { ...singleAz, NumCacheNodes: 1 },
        { ...crossAz, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b'] }
      )
    ).toEqual([]);
    // A previous zone list shared with the new one.
    expect(
      await diff({ ...singleAz, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1a'] }, crossAz)
    ).toEqual([]);
    // A new list naming one zone, or none at all.
    expect(
      await diff(singleAz, { ...crossAz, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1a'] })
    ).toEqual([]);
    const { PreferredAvailabilityZones: _zones, ...crossAzNoZones } = crossAz;
    expect(await diff(singleAz, crossAzNoZones)).toEqual([]);
    // The reverse move, another engine, the singular zone.
    expect(await diff({ ...crossAz }, { ...singleAz })).toEqual([]);
    expect(await diff({ ...singleAz, Engine: 'redis' }, { ...crossAz, Engine: 'redis' })).toEqual(
      []
    );
    expect(
      await diff(
        { ...singleAz, PreferredAvailabilityZone: 'us-east-1a' },
        { ...crossAz, PreferredAvailabilityZone: 'us-east-1a' }
      )
    ).toEqual([]);
  });
});

describe('the #7045 zone-list predicate', () => {
  const ZONES = ['us-east-1a', 'us-east-1b'];
  const paz = (newProperties: Record<string, unknown>, oldProperties: Record<string, unknown> = singleAz) =>
    elastiCachePreferredAvailabilityZonesReplaced(undefined, newProperties['PreferredAvailabilityZones'], {
      oldProperties,
      newProperties,
    });

  it('answers true for the measured change, and the AZMode key stays an update', () => {
    expect(paz(crossAz)).toBe(true);
    const registry = new ReplacementRulesRegistry();
    const bags = { oldProperties: singleAz, newProperties: crossAz };
    expect(registry.requiresReplacement(TYPE, 'PreferredAvailabilityZones', undefined, ZONES, bags)).toBe(true);
    expect(registry.requiresReplacement(TYPE, 'AZMode', 'single-az', 'cross-az', bags)).toBe(false);
    expect(elastiCacheAzModeRemovedFromSingleAz('single-az', 'cross-az', bags)).toBe(false);
  });

  it('answers false without the sibling bags, or for an unmeasured shape', () => {
    expect(elastiCachePreferredAvailabilityZonesReplaced(undefined, ZONES)).toBe(false);
    // An unresolved entry.
    expect(
      paz({ ...crossAz, PreferredAvailabilityZones: [{ 'Fn::Select': [0, { 'Fn::GetAZs': '' }] }, 'us-east-1b'] })
    ).toBe(false);
    // A changed NumCacheNodes, and an absent one on the previous side.
    expect(paz({ ...crossAz, NumCacheNodes: 3 }, { ...singleAz, NumCacheNodes: 3 })).toBe(false);
    expect(paz({ ...crossAz, NumCacheNodes: 3 })).toBe(false);
    const { NumCacheNodes: _n, ...noCount } = singleAz;
    expect(paz({ ...crossAz, NumCacheNodes: undefined }, noCount)).toBe(false);
    // A list whose length differs from the node count.
    expect(
      paz({ ...crossAz, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'] })
    ).toBe(false);
    expect(paz({ ...crossAz, AZMode: 'single-az' })).toBe(false);
  });
});
