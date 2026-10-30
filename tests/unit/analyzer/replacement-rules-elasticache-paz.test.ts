import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  elastiCachePreferredAvailabilityZonesMovedToDisjoint,
  elastiCacheAzModeRemovedFromSingleAz,
  elastiCachePreferredAvailabilityZonesRemovedFromSingleAz,
} from '../../../src/analyzer/replacement-rules.js';

/**
 * `AWS::ElastiCache::CacheCluster.PreferredAvailabilityZones` (go-to-k/cdkd#5458).
 * Real CloudFormation change-set executions (memcached, us-east-1) replaced the
 * cluster when the list moved to zones the PREVIOUS template list does not
 * name -- even with the only live node already in the new zone -- and updated
 * it in place otherwise.
 */
describe('ReplacementRulesRegistry — AWS::ElastiCache::CacheCluster.PreferredAvailabilityZones', () => {
  const registry = new ReplacementRulesRegistry();
  const TYPE = 'AWS::ElastiCache::CacheCluster';
  const KEY = 'PreferredAvailabilityZones';
  const replaces = (oldValue: unknown, newValue: unknown) =>
    registry.requiresReplacement(TYPE, KEY, oldValue, newValue);

  it('replaces a move to zones the previous list does not name (the measured replacing rows)', () => {
    expect(replaces(['us-east-1c', 'us-east-1a'], ['us-east-1b'])).toBe(true);
    expect(replaces(['us-east-1b'], ['us-east-1c'])).toBe(true);
    expect(replaces(['us-east-1a'], ['us-east-1b'])).toBe(true);
  });

  it('updates in place when the lists share a zone (the measured in-place rows)', () => {
    expect(replaces(['us-east-1c', 'us-east-1b'], ['us-east-1b', 'us-east-1b'])).toBe(false);
    expect(replaces(['us-east-1a', 'us-east-1b', 'us-east-1c'], ['us-east-1a', 'us-east-1c'])).toBe(
      false
    );
    expect(replaces(['us-east-1c'], ['us-east-1c', 'us-east-1b'])).toBe(false);
  });

  it('updates in place when either side is absent or empty', () => {
    expect(replaces(undefined, ['us-east-1b'])).toBe(false);
    expect(replaces(undefined, ['us-east-1c', 'us-east-1b'])).toBe(false);
    expect(replaces(['us-east-1c', 'us-east-1b'], undefined)).toBe(false);
    expect(replaces([], ['us-east-1b'])).toBe(false);
    expect(replaces(['us-east-1b'], [])).toBe(false);
    expect(replaces(undefined, undefined)).toBe(false);
    // The predicate itself too: the registry may answer an absent side
    // before consulting it.
    const moved = elastiCachePreferredAvailabilityZonesMovedToDisjoint;
    expect(moved(undefined, ['us-east-1b'])).toBe(false);
    expect(moved(['us-east-1b'], undefined)).toBe(false);
    expect(moved(undefined, undefined)).toBe(false);
  });

  it('ignores order and repeats', () => {
    expect(replaces(['us-east-1a', 'us-east-1b'], ['us-east-1b', 'us-east-1a'])).toBe(false);
    expect(replaces(['us-east-1a', 'us-east-1a'], ['us-east-1a'])).toBe(false);
  });

  it('never replaces when either side still holds an unresolved value', () => {
    const moved = elastiCachePreferredAvailabilityZonesMovedToDisjoint;
    const az = { 'Fn::Select': [1, { 'Fn::GetAZs': '' }] };
    expect(moved(['us-east-1a'], [az])).toBe(false);
    expect(moved([az], ['us-east-1b'])).toBe(false);
    expect(moved([az], [az])).toBe(false);
    // The resolved form of the same move still replaces.
    expect(moved(['us-east-1a'], ['us-east-1b'])).toBe(true);
  });

  it('is classified, and leaves every other property to the schema fallback', () => {
    expect(registry.isClassified(TYPE, KEY)).toBe(true);
    expect(registry.isClassified(TYPE, 'AZMode')).toBe(true);
    for (const key of ['CacheNodeType', 'NumCacheNodes', 'Engine', 'ClusterName']) {
      expect(registry.isClassified(TYPE, key)).toBe(false);
    }
  });
});

/**
 * go-to-k/cdkd#5558: removing `AZMode` or `PreferredAvailabilityZones` replaces
 * the cluster exactly when the PREVIOUS template said `AZMode: single-az` and
 * the new one names no zone list, on 1 and 2 nodes alike; a `cross-az`
 * cluster, or a `single-az` one keeping its zone list, is updated in place.
 * Each row is a real CloudFormation stack update (memcached, us-east-1); the
 * 1-node single-az and 2-node cross-az rows also beside a changed
 * PreferredMaintenanceWindow.
 */
describe('ReplacementRulesRegistry — AWS::ElastiCache::CacheCluster AZ removals (#5558)', () => {
  const registry = new ReplacementRulesRegistry();
  const TYPE = 'AWS::ElastiCache::CacheCluster';
  const W1 = 'sun:05:00-sun:06:00';
  const W2 = 'mon:05:00-mon:06:00';
  const base = (nodes: number, extra: Record<string, unknown>) => ({
    Engine: 'memcached',
    CacheNodeType: 'cache.t3.micro',
    NumCacheNodes: nodes,
    PreferredMaintenanceWindow: W1,
    ...extra,
  });
  const without = (props: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(Object.entries(props).filter(([k]) => !keys.includes(k)));
  /** The keys the registry would replace for this old -> new template pair. */
  const replacing = (oldProps: Record<string, unknown>, newProps: Record<string, unknown>) =>
    [...new Set([...Object.keys(oldProps), ...Object.keys(newProps)])]
      .filter((key) =>
        registry.requiresReplacement(TYPE, key, oldProps[key], newProps[key], {
          oldProperties: oldProps,
          newProperties: newProps,
        })
      )
      .sort();

  const single1 = base(1, { AZMode: 'single-az', PreferredAvailabilityZones: ['us-east-1a'] });
  const single2 = base(2, {
    AZMode: 'single-az',
    PreferredAvailabilityZones: ['us-east-1a', 'us-east-1a'],
  });
  const cross2 = base(2, {
    AZMode: 'cross-az',
    PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b'],
  });

  it('replaces a single-az cluster whose zone list is removed (1 and 2 nodes)', () => {
    for (const props of [single1, single2]) {
      expect(replacing(props, without(props, 'PreferredAvailabilityZones'))).toEqual([
        'PreferredAvailabilityZones',
      ]);
      // Beside an in-place change: the same verdict.
      expect(
        replacing(props, {
          ...without(props, 'PreferredAvailabilityZones'),
          PreferredMaintenanceWindow: W2,
        })
      ).toEqual(['PreferredAvailabilityZones']);
    }
  });

  it('replaces a single-az cluster whose AZMode is removed with no zone list (1 and 2 nodes)', () => {
    for (const props of [base(1, { AZMode: 'single-az' }), base(2, { AZMode: 'single-az' })]) {
      expect(replacing(props, without(props, 'AZMode'))).toEqual(['AZMode']);
      expect(replacing(props, { ...without(props, 'AZMode'), PreferredMaintenanceWindow: W2 })).toEqual(
        ['AZMode']
      );
    }
    expect(replacing(single1, without(single1, 'AZMode', 'PreferredAvailabilityZones'))).toEqual([
      'AZMode',
      'PreferredAvailabilityZones',
    ]);
  });

  it('updates a single-az cluster in place when AZMode is removed but the zone list is kept', () => {
    expect(replacing(single1, without(single1, 'AZMode'))).toEqual([]);
  });

  it('updates a cross-az cluster in place for either removal', () => {
    for (const next of [
      without(cross2, 'PreferredAvailabilityZones'),
      { ...without(cross2, 'PreferredAvailabilityZones'), PreferredMaintenanceWindow: W2 },
      without(cross2, 'AZMode'),
      without(cross2, 'AZMode', 'PreferredAvailabilityZones'),
    ]) {
      expect(replacing(cross2, next)).toEqual([]);
    }
    const noZones = base(2, { AZMode: 'cross-az' });
    expect(replacing(noZones, without(noZones, 'AZMode'))).toEqual([]);
    expect(
      replacing(noZones, { ...without(noZones, 'AZMode'), PreferredMaintenanceWindow: W2 })
    ).toEqual([]);
    // #5458's measured 2-node `[1c, 1b]` -> absent (cross-az).
    const old5458 = base(2, {
      AZMode: 'cross-az',
      PreferredAvailabilityZones: ['us-east-1c', 'us-east-1b'],
    });
    expect(replacing(old5458, without(old5458, 'PreferredAvailabilityZones'))).toEqual([]);
  });

  it('keeps every other AZ change in place, and needs the previous AZMode to replace a zone-list removal', () => {
    // Not removals: AZMode set or changed, a zone list added or kept.
    expect(replacing(base(1, {}), base(1, { AZMode: 'single-az' }))).toEqual([]);
    expect(replacing(base(2, { AZMode: 'single-az' }), base(2, { AZMode: 'cross-az' }))).toEqual(
      []
    );
    expect(replacing(base(1, { AZMode: 'single-az' }), single1)).toEqual([]);
    // A zone-list removal that also moves AZMode to cross-az is unmeasured.
    expect(replacing(single2, base(2, { AZMode: 'cross-az' }))).toEqual([]);
    // A zone list with no previous AZMode (CloudFormation refuses it at
    // create), or no sibling bags at all: no replacement.
    const noMode = base(1, { PreferredAvailabilityZones: ['us-east-1a'] });
    expect(replacing(noMode, without(noMode, 'PreferredAvailabilityZones'))).toEqual([]);
    expect(
      elastiCachePreferredAvailabilityZonesRemovedFromSingleAz(['us-east-1a'], undefined)
    ).toBe(false);
    expect(
      registry.requiresReplacement(TYPE, 'PreferredAvailabilityZones', ['us-east-1a'], undefined)
    ).toBe(false);
    // An empty previous list is no removal of zones.
    expect(
      elastiCachePreferredAvailabilityZonesRemovedFromSingleAz([], undefined, {
        oldProperties: { AZMode: 'single-az', PreferredAvailabilityZones: [] },
        newProperties: { AZMode: 'single-az' },
      })
    ).toBe(false);
    // Callers outside a diff ask with no values at all.
    expect(elastiCacheAzModeRemovedFromSingleAz(undefined, undefined)).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'AZMode', undefined, undefined)).toBe(false);
    // The AZMode half reads the new zone list from the sibling bags too.
    const bags = (newProperties: Record<string, unknown>) => ({
      oldProperties: { AZMode: 'single-az' },
      newProperties,
    });
    expect(elastiCacheAzModeRemovedFromSingleAz('single-az', undefined, bags({}))).toBe(true);
    expect(
      elastiCacheAzModeRemovedFromSingleAz('single-az', undefined, bags({ PreferredAvailabilityZones: [] }))
    ).toBe(false);
    expect(elastiCacheAzModeRemovedFromSingleAz('single-az', undefined)).toBe(false);
    expect(elastiCacheAzModeRemovedFromSingleAz('cross-az', undefined, bags({}))).toBe(false);
  });
});
