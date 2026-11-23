/**
 * go-to-k/cdkd#6852: the diff ignores ONE property, a custom resource's
 * top-level `Timestamp`, as non-deterministic. CloudFormation sends an Update
 * on that change, so this is a known divergence, kept as it is until the v1
 * release session (#6443) removes it; that change flips the first case. Until
 * then these cases pin the boundary so the rule cannot widen: the exact name,
 * top-level only, custom resource types only.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  // No DescribeType call: no property here is create-only.
  return { ...actual, getCreateOnlyPropertyPaths: async () => [] };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';

const changedPaths = async (
  type: string,
  current: Record<string, unknown>,
  desired: Record<string, unknown>
) =>
  (await new DiffCalculator().compareProperties(type, current, desired)).map((c) => c.path);

describe('custom resource `Timestamp` ignore: its boundary (#6852)', () => {
  it.each(['Custom::Thing', 'AWS::CloudFormation::CustomResource'])(
    'today: a changed top-level Timestamp alone is no change on %s',
    async (type) => {
      expect(await changedPaths(type, { Timestamp: '1' }, { Timestamp: '2' })).toEqual([]);
    }
  );

  it.each([
    ['a non-custom type', 'AWS::SSM::Parameter', { Timestamp: '1' }, { Timestamp: '2' }, 'Timestamp'],
    ['another casing', 'Custom::Thing', { timestamp: '1' }, { timestamp: '2' }, 'timestamp'],
    ['a longer name', 'Custom::Thing', { TimestampX: '1' }, { TimestampX: '2' }, 'TimestampX'],
    [
      'a nested Timestamp',
      'Custom::Thing',
      { Config: { Timestamp: '1' } },
      { Config: { Timestamp: '2' } },
      'Config',
    ],
  ])('still a change: %s', async (_label, type, current, desired, path) => {
    expect(await changedPaths(type, current, desired)).toEqual([path]);
  });

  it('a sibling change beside the Timestamp is still a change', async () => {
    expect(
      await changedPaths('Custom::Thing', { Timestamp: '1', A: 1 }, { Timestamp: '2', A: 2 })
    ).toEqual(['A']);
  });
});
