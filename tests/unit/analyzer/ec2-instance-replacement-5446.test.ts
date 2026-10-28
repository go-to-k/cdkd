import { describe, it, expect, vi } from 'vite-plus/test';

// Issue #5446: which AWS::EC2::Instance changes replace, as CloudFormation
// decides (measured, us-east-1): SecurityGroupIds replaces only without a
// SubnetId; BlockDeviceMappings replaces unless only DeleteOnTermination moved.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import {
  ReplacementRulesRegistry,
  blockDeviceMappingsDifferOnlyInDeleteOnTermination,
} from '../../../src/analyzer/replacement-rules.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::EC2::Instance';
const rules = new ReplacementRulesRegistry();

const bdm = (size: unknown, dot: unknown) => [
  { DeviceName: '/dev/sdf', Ebs: { VolumeType: 'gp3', VolumeSize: size, DeleteOnTermination: dot } },
];

describe('AWS::EC2::Instance SecurityGroupIds replacement (issue #5446)', () => {
  it('replaces when the instance has no SubnetId', () => {
    expect(
      rules.requiresReplacement(TYPE, 'SecurityGroupIds', ['sg-a'], ['sg-b'], {
        oldProperties: { SecurityGroupIds: ['sg-a'] },
        newProperties: { SecurityGroupIds: ['sg-b'] },
      })
    ).toBe(true);
  });

  it('replaces a removal without a SubnetId too', () => {
    expect(
      rules.requiresReplacement(TYPE, 'SecurityGroupIds', ['sg-a'], undefined, {
        oldProperties: { SecurityGroupIds: ['sg-a'] },
        newProperties: {},
      })
    ).toBe(true);
  });

  it('updates in place with a SubnetId', () => {
    expect(
      rules.requiresReplacement(TYPE, 'SecurityGroupIds', ['sg-a'], ['sg-b'], {
        oldProperties: { SubnetId: 'subnet-1', SecurityGroupIds: ['sg-a'] },
        newProperties: { SubnetId: 'subnet-1', SecurityGroupIds: ['sg-b'] },
      })
    ).toBe(false);
  });

  it('answers in place without the sibling bags', () => {
    expect(rules.requiresReplacement(TYPE, 'SecurityGroupIds', ['sg-a'], ['sg-b'])).toBe(false);
  });
});

describe('AWS::EC2::Instance BlockDeviceMappings replacement (issue #5446)', () => {
  it('updates in place when only DeleteOnTermination moved', () => {
    expect(
      rules.requiresReplacement(TYPE, 'BlockDeviceMappings', bdm(8, true), bdm(8, false))
    ).toBe(false);
  });

  it('treats a stringly-typed equal scalar as equal', () => {
    expect(
      rules.requiresReplacement(TYPE, 'BlockDeviceMappings', bdm(8, true), bdm('8', 'false'))
    ).toBe(false);
  });

  it.each([
    ['a VolumeSize change', bdm(8, true), bdm(9, true)],
    ['a VolumeSize change with a DeleteOnTermination change', bdm(8, true), bdm(9, false)],
    ['a removal', bdm(8, true), undefined],
    ['an addition', undefined, bdm(8, true)],
    [
      'an added device',
      bdm(8, true),
      [...bdm(8, true), { DeviceName: '/dev/sdg', Ebs: { VolumeSize: 8 } }],
    ],
    [
      'a renamed device',
      bdm(8, true),
      [{ DeviceName: '/dev/sdh', Ebs: { VolumeType: 'gp3', VolumeSize: 8, DeleteOnTermination: true } }],
    ],
  ])('replaces on %s', (_name, before, after) => {
    expect(rules.requiresReplacement(TYPE, 'BlockDeviceMappings', before, after)).toBe(true);
  });

  it('blockDeviceMappingsDifferOnlyInDeleteOnTermination ignores an absent vs present DeleteOnTermination', () => {
    expect(
      blockDeviceMappingsDifferOnlyInDeleteOnTermination(
        [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 8 } }],
        [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 8, DeleteOnTermination: false } }]
      )
    ).toBe(true);
  });
});

describe('DiffCalculator hands the sibling bags to the predicate (issue #5446)', () => {
  const state = (props: Record<string, unknown>): StackState =>
    ({
      version: 3,
      region: 'us-east-1',
      stackName: 's',
      resources: {
        Inst: { physicalId: 'i-1', resourceType: TYPE, properties: props, attributes: {}, dependencies: [] },
      },
      outputs: {},
      lastModified: 0,
    }) as unknown as StackState;
  const template = (props: Record<string, unknown>): CloudFormationTemplate =>
    ({ Resources: { Inst: { Type: TYPE, Properties: props } } }) as CloudFormationTemplate;

  const groupsChange = async (subnet: Record<string, unknown>) => {
    const base = { ImageId: 'ami-1', InstanceType: 't3.nano', ...subnet };
    const changes = await new DiffCalculator().calculateDiff(
      state({ ...base, SecurityGroupIds: ['sg-a'] }),
      template({ ...base, SecurityGroupIds: ['sg-b'] })
    );
    return changes.get('Inst')?.propertyChanges?.find((p) => p.path === 'SecurityGroupIds');
  };

  it('a SecurityGroupIds change with a SubnetId is in place', async () => {
    expect((await groupsChange({ SubnetId: 'subnet-1' }))?.requiresReplacement).toBe(false);
  });

  it('a SecurityGroupIds change without a SubnetId replaces', async () => {
    expect((await groupsChange({}))?.requiresReplacement).toBe(true);
  });
});
