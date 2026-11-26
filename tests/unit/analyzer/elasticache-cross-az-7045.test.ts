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
  elastiCacheAzModeReplaced,
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
    expect(await diff(singleAz, crossAz)).toEqual(['AZMode', 'PreferredAvailabilityZones']);
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

describe('the #7045 predicate halves', () => {
  const bags = { oldProperties: singleAz, newProperties: crossAz };

  it('answers true for each half of the measured change', () => {
    expect(elastiCacheAzModeReplaced('single-az', 'cross-az', bags)).toBe(true);
    expect(
      elastiCachePreferredAvailabilityZonesReplaced(
        undefined,
        ['us-east-1a', 'us-east-1b'],
        bags
      )
    ).toBe(true);
    const registry = new ReplacementRulesRegistry();
    expect(registry.requiresReplacement(TYPE, 'AZMode', 'single-az', 'cross-az', bags)).toBe(true);
  });

  it('answers false without the sibling bags or with an unresolved zone list', () => {
    expect(elastiCacheAzModeReplaced('single-az', 'cross-az')).toBe(false);
    expect(elastiCachePreferredAvailabilityZonesReplaced(undefined, ['us-east-1a', 'us-east-1b'])).toBe(
      false
    );
    const unresolved = {
      oldProperties: singleAz,
      newProperties: {
        ...crossAz,
        PreferredAvailabilityZones: [{ 'Fn::Select': [0, { 'Fn::GetAZs': '' }] }, 'us-east-1b'],
      },
    };
    expect(elastiCacheAzModeReplaced('single-az', 'cross-az', unresolved)).toBe(false);
    // A changed NumCacheNodes, and an absent one on the previous side.
    const scaled = { oldProperties: singleAz, newProperties: { ...crossAz, NumCacheNodes: 3 } };
    expect(elastiCacheAzModeReplaced('single-az', 'cross-az', scaled)).toBe(false);
    const { NumCacheNodes: _n, ...noCount } = singleAz;
    const noCountBags = { oldProperties: noCount, newProperties: { ...crossAz, NumCacheNodes: undefined } };
    expect(elastiCacheAzModeReplaced('single-az', 'cross-az', noCountBags)).toBe(false);
  });
});
