import { describe, it, expect } from 'vite-plus/test';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type StackState,
} from '../../../src/types/state.js';

/**
 * Schema v6 — `parentStack` / `parentLogicalId` / `parentRegion` stack-level
 * fields for `AWS::CloudFormation::Stack` nested-stack adoption (issue
 * [#459](https://github.com/go-to-k/cdkd/issues/459)). This prep PR adds
 * the type bump alone — the `NestedStackProvider` that populates the
 * fields lands in a follow-up PR. The integ test
 * `tests/integration/schema-v5-to-v6-migration/` proves the transparent
 * auto-migration round-trip against real AWS.
 */
describe('State schema v6 — parent-stack tracking for nested-stack adoption', () => {
  it('current schema version is 6', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(6);
  });

  it('readers accept every prior version + v6', () => {
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(1);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(2);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(3);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(4);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(5);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(6);
  });

  it('parentStack / parentLogicalId / parentRegion are optional (top-level stacks leave undefined)', () => {
    const topLevel: StackState = {
      version: 6,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };
    expect(topLevel.parentStack).toBeUndefined();
    expect(topLevel.parentLogicalId).toBeUndefined();
    expect(topLevel.parentRegion).toBeUndefined();
  });

  it('StackState round-trips parentStack / parentLogicalId / parentRegion through JSON (nested-stack child shape)', () => {
    const child: StackState = {
      version: 6,
      stackName: 'MyParent~ChildStack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      parentStack: 'MyParent',
      parentLogicalId: 'ChildStack',
      parentRegion: 'us-east-1',
      lastModified: 1717024800000,
    };

    const round = JSON.parse(JSON.stringify(child)) as StackState;
    expect(round.version).toBe(6);
    expect(round.parentStack).toBe('MyParent');
    expect(round.parentLogicalId).toBe('ChildStack');
    expect(round.parentRegion).toBe('us-east-1');
    expect(round.stackName).toBe('MyParent~ChildStack');
  });

  it('JSON.stringify omits undefined parent fields (v5 state stays v5-shaped on serialize, no spurious nulls)', () => {
    const topLevel: StackState = {
      version: 6,
      stackName: 'TopLevel',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      parentStack: undefined,
      parentLogicalId: undefined,
      parentRegion: undefined,
      lastModified: 0,
    };
    const serialized = JSON.stringify(topLevel);
    expect(serialized).not.toContain('parentStack');
    expect(serialized).not.toContain('parentLogicalId');
    expect(serialized).not.toContain('parentRegion');
  });
});
