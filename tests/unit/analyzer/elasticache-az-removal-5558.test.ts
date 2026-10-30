import { describe, it, expect, vi } from 'vite-plus/test';

// Issue #5558: through the whole diff, removing AZMode or
// PreferredAvailabilityZones replaces a CacheCluster whose previous template
// said `AZMode: single-az`, and updates a `cross-az` one in place, as
// CloudFormation does (measured, us-east-1). The zone-list half reads the
// previous AZMode from the sibling bags the diff hands the predicate.

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
  return {
    changeType: change?.changeType,
    replacing: (change?.propertyChanges ?? [])
      .filter((p) => p.requiresReplacement)
      .map((p) => p.path)
      .sort(),
  };
};

const base = { Engine: 'memcached', CacheNodeType: 'cache.t3.micro' };

describe('CacheCluster AZ removals through the diff (issue #5558)', () => {
  it('replaces a single-az cluster whose PreferredAvailabilityZones is removed', async () => {
    const old = {
      ...base,
      NumCacheNodes: 2,
      AZMode: 'single-az',
      PreferredAvailabilityZones: ['us-east-1a', 'us-east-1a'],
    };
    expect(await diff(old, { ...base, NumCacheNodes: 2, AZMode: 'single-az' })).toEqual({
      changeType: 'UPDATE',
      replacing: ['PreferredAvailabilityZones'],
    });
  });

  it('replaces a single-az cluster whose AZMode is removed', async () => {
    expect(
      await diff({ ...base, NumCacheNodes: 1, AZMode: 'single-az' }, { ...base, NumCacheNodes: 1 })
    ).toEqual({ changeType: 'UPDATE', replacing: ['AZMode'] });
  });

  it('updates a cross-az cluster in place for either removal', async () => {
    const old = {
      ...base,
      NumCacheNodes: 2,
      AZMode: 'cross-az',
      PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b'],
    };
    expect(await diff(old, { ...base, NumCacheNodes: 2, AZMode: 'cross-az' })).toEqual({
      changeType: 'UPDATE',
      replacing: [],
    });
    expect(
      await diff(old, { ...base, NumCacheNodes: 2, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b'] })
    ).toEqual({ changeType: 'UPDATE', replacing: [] });
  });
});
