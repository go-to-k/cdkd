import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  elastiCachePreferredAvailabilityZonesMovedToDisjoint,
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
    for (const key of ['CacheNodeType', 'NumCacheNodes', 'AZMode', 'Engine', 'ClusterName']) {
      expect(registry.isClassified(TYPE, key)).toBe(false);
    }
  });
});
