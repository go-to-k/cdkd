import { describe, expect, it } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

// go-to-k/cdkd#7098: a Batch compute environment's ComputeResources change that
// needs an infrastructure update replaces unless the template sets
// `ReplaceComputeEnvironment: false` (measured through Cloud Control on #7083).

const TYPE = 'AWS::Batch::ComputeEnvironment';
const registry = new ReplacementRulesRegistry();

const base = {
  Type: 'EC2',
  AllocationStrategy: 'BEST_FIT_PROGRESSIVE',
  MinvCpus: 0,
  MaxvCpus: 4,
  InstanceTypes: ['optimal'],
  Subnets: ['subnet-a'],
  SecurityGroupIds: ['sg-a'],
  InstanceRole: 'arn:aws:iam::123456789012:instance-profile/a',
};

function replaces(
  change: Record<string, unknown>,
  replaceComputeEnvironment: unknown,
  from: Record<string, unknown> = base
): boolean {
  const oldResources = from;
  const newResources = { ...from, ...change };
  const bag = (resources: Record<string, unknown>): Record<string, unknown> => ({
    Type: 'MANAGED',
    ComputeResources: resources,
    ...(replaceComputeEnvironment === undefined
      ? {}
      : { ReplaceComputeEnvironment: replaceComputeEnvironment }),
  });
  return registry.requiresReplacement(TYPE, 'ComputeResources', oldResources, newResources, {
    oldProperties: bag(oldResources),
    newProperties: bag(newResources),
  });
}

describe('Batch compute environment ComputeResources replacement (go-to-k/cdkd#7098)', () => {
  const infrastructure: Array<[string, Record<string, unknown>]> = [
    ['AllocationStrategy', { AllocationStrategy: 'BEST_FIT' }],
    ['BidPercentage', { BidPercentage: 60 }],
    ['Ec2Configuration', { Ec2Configuration: [{ ImageType: 'ECS_AL2' }] }],
    ['Ec2KeyPair', { Ec2KeyPair: 'kp' }],
    ['ImageId', { ImageId: 'ami-1' }],
    ['InstanceRole', { InstanceRole: 'arn:aws:iam::123456789012:instance-profile/b' }],
    ['InstanceTypes', { InstanceTypes: ['m5.large'] }],
    ['LaunchTemplate', { LaunchTemplate: { LaunchTemplateName: 'lt', Version: '2' } }],
    ['PlacementGroup', { PlacementGroup: 'pg' }],
    ['Tags', { Tags: { k: 'v' } }],
    ['Type', { Type: 'SPOT' }],
  ];

  it.each(infrastructure)('%s replaces when ReplaceComputeEnvironment is absent or true', (_, change) => {
    expect(replaces(change, undefined)).toBe(true);
    expect(replaces(change, true)).toBe(true);
    expect(replaces(change, 'true')).toBe(true);
  });

  it.each(infrastructure)('%s stays in place under ReplaceComputeEnvironment: false', (_, change) => {
    expect(replaces(change, false)).toBe(false);
    expect(replaces(change, 'false')).toBe(false);
  });

  it('a scaling change stays in place whatever ReplaceComputeEnvironment says', () => {
    for (const change of [{ Subnets: ['subnet-a', 'subnet-b'] }, { SecurityGroupIds: ['sg-b'] }, { MaxvCpus: 8 }]) {
      expect(replaces(change, undefined)).toBe(false);
      expect(replaces(change, false)).toBe(false);
    }
  });

  it('a schema create-only member replaces even under ReplaceComputeEnvironment: false', () => {
    expect(replaces({ SpotIamFleetRole: 'arn:aws:iam::123456789012:role/b' }, false)).toBe(true);
    expect(
      replaces(
        { ManagedInstancesProvider: { InstanceLaunchTemplate: { CapacityOptionType: 'SPOT' } } },
        false
      )
    ).toBe(true);
  });

  it('no change, or no sibling bags, stays in place', () => {
    expect(replaces({}, undefined)).toBe(false);
    expect(
      registry.requiresReplacement(TYPE, 'ComputeResources', base, { ...base, InstanceTypes: ['m5.large'] })
    ).toBe(false);
  });
});
