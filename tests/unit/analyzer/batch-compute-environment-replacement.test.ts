import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { CREATE_ONLY_PATHS } from '../../../src/analyzer/replacement-rules/batch-compute-environment.js';

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
    ['AllocationStrategy', { AllocationStrategy: 'SPOT_CAPACITY_OPTIMIZED' }],
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

  // Batch refuses these any infrastructure update, ReplaceComputeEnvironment
  // false or not (measured on #7098).
  it('a Fargate environment replaces on an infrastructure member even under false', () => {
    const fargate = { Type: 'FARGATE', MaxvCpus: 2, Subnets: ['subnet-a'], SecurityGroupIds: ['sg-a'] };
    expect(replaces({ Type: 'FARGATE_SPOT' }, false, fargate)).toBe(true);
    expect(replaces({ Tags: { k: 'v' } }, false, fargate)).toBe(true);
    expect(replaces({ Subnets: ['subnet-b'] }, false, fargate)).toBe(false);
    expect(replaces({ MaxvCpus: 4 }, undefined, fargate)).toBe(false);
  });

  it('a BEST_FIT environment (or no strategy) replaces on infrastructure and network changes', () => {
    for (const strategy of ['BEST_FIT', undefined]) {
      const bestFit = { ...base, AllocationStrategy: strategy };
      expect(replaces({ InstanceTypes: ['m5.large'] }, false, bestFit)).toBe(true);
      expect(replaces({ Subnets: ['subnet-b'] }, false, bestFit)).toBe(true);
      expect(replaces({ SecurityGroupIds: ['sg-b'] }, false, bestFit)).toBe(true);
      expect(replaces({ MaxvCpus: 8 }, false, bestFit)).toBe(false);
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

  // The hand rule owns ComputeResources, so the schema fallback never reads its
  // nested create-only paths: the copy must match the committed snapshot.
  it('the create-only member list matches the registry schema snapshot', () => {
    const snapshot = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/cfn-registry-create-only-paths.json'), 'utf8')
    ) as { types: Record<string, string[][]> };
    const fromSchema = snapshot.types[TYPE]!
      .filter((p) => p[0] === 'ComputeResources')
      .map((p) => p.slice(1).join('.'))
      .sort();
    expect(fromSchema.length).toBeGreaterThan(0);
    expect(CREATE_ONLY_PATHS.map((p) => p.join('.')).sort()).toEqual(fromSchema);
  });
});
