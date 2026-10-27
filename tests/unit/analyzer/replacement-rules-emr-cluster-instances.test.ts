import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  emrClusterInstancesReplaced,
} from '../../../src/analyzer/replacement-rules.js';

/**
 * `AWS::EMR::Cluster.Instances` (go-to-k/cdkd#5418). The schema marks no
 * `Instances` path createOnly and the CloudFormation reference says "No
 * interruption" for every member, but CloudFormation replaces the cluster for
 * most of them (measured; see the predicate). The members it updates in place
 * must not replace.
 */
describe('ReplacementRulesRegistry — AWS::EMR::Cluster.Instances', () => {
  const registry = new ReplacementRulesRegistry();
  const TYPE = 'AWS::EMR::Cluster';

  const group = (name: string, count: number): Record<string, unknown> => ({
    InstanceCount: count,
    InstanceType: 'm5.xlarge',
    Market: 'ON_DEMAND',
    Name: name,
  });
  const fleet = (name: string, onDemand: number, spot?: number): Record<string, unknown> => ({
    Name: name,
    TargetOnDemandCapacity: onDemand,
    ...(spot !== undefined && { TargetSpotCapacity: spot }),
    InstanceTypeConfigs: [{ InstanceType: 'm5.xlarge', WeightedCapacity: 1 }],
  });
  const groups = (): Record<string, unknown> => ({
    Ec2SubnetId: 'subnet-1',
    EmrManagedMasterSecurityGroup: 'sg-m',
    EmrManagedSlaveSecurityGroup: 'sg-s',
    KeepJobFlowAliveWhenNoSteps: true,
    TerminationProtected: false,
    MasterInstanceGroup: group('Master', 1),
    CoreInstanceGroup: group('Core', 1),
    TaskInstanceGroups: [group('t1', 1)],
  });
  const fleets = (): Record<string, unknown> => ({
    Ec2SubnetIds: ['subnet-1'],
    KeepJobFlowAliveWhenNoSteps: true,
    MasterInstanceFleet: fleet('Master', 1),
    CoreInstanceFleet: fleet('Core', 1),
    TaskInstanceFleets: [fleet('tf1', 1)],
  });
  const replaces = (oldValue: unknown, newValue: unknown): boolean =>
    registry.requiresReplacement(TYPE, 'Instances', oldValue, newValue);

  it('is classified, so the createOnly fallback never overrides it', () => {
    expect(registry.isClassified(TYPE, 'Instances')).toBe(true);
  });

  it.each<[string, (i: Record<string, unknown>) => void]>([
    ['AdditionalMasterSecurityGroups added', (i) => (i['AdditionalMasterSecurityGroups'] = ['sg-x'])],
    ['AdditionalSlaveSecurityGroups added', (i) => (i['AdditionalSlaveSecurityGroups'] = ['sg-x'])],
    ['Ec2SubnetId changed', (i) => (i['Ec2SubnetId'] = 'subnet-2')],
    ['Ec2KeyName added', (i) => (i['Ec2KeyName'] = 'key')],
    ['EmrManagedMasterSecurityGroup changed', (i) => (i['EmrManagedMasterSecurityGroup'] = 'sg-z')],
    ['ServiceAccessSecurityGroup added', (i) => (i['ServiceAccessSecurityGroup'] = 'sg-z')],
    ['HadoopVersion added', (i) => (i['HadoopVersion'] = '2.4.0')],
    ['Placement added', (i) => (i['Placement'] = { AvailabilityZone: 'us-east-1a' })],
    ['KeepJobFlowAliveWhenNoSteps changed', (i) => (i['KeepJobFlowAliveWhenNoSteps'] = false)],
    ['MasterInstanceGroup.InstanceType changed', (i) => ((i['MasterInstanceGroup'] as Record<string, unknown>)['InstanceType'] = 'm5.2xlarge')],
    ['CoreInstanceGroup.InstanceType changed', (i) => ((i['CoreInstanceGroup'] as Record<string, unknown>)['InstanceType'] = 'm5.2xlarge')],
    ['CoreInstanceGroup.EbsConfiguration added', (i) => ((i['CoreInstanceGroup'] as Record<string, unknown>)['EbsConfiguration'] = { EbsOptimized: true })],
    ['a task group added', (i) => (i['TaskInstanceGroups'] as unknown[]).push(group('t2', 1))],
    ['a task group removed', (i) => (i['TaskInstanceGroups'] = [])],
    ['a task group renamed', (i) => ((i['TaskInstanceGroups'] as Record<string, unknown>[])[0]!['Name'] = 't9')],
    ['the core group removed', (i) => delete i['CoreInstanceGroup']],
  ])('replaces on %s', (_label, mutate) => {
    const next = groups();
    mutate(next);
    expect(replaces(groups(), next)).toBe(true);
  });

  it.each<[string, (i: Record<string, unknown>) => void]>([
    ['TerminationProtected changed', (i) => (i['TerminationProtected'] = true)],
    ['TerminationProtected removed', (i) => delete i['TerminationProtected']],
    ['CoreInstanceGroup.InstanceCount changed', (i) => ((i['CoreInstanceGroup'] as Record<string, unknown>)['InstanceCount'] = 3)],
    ['a task group InstanceCount changed', (i) => ((i['TaskInstanceGroups'] as Record<string, unknown>[])[0]!['InstanceCount'] = 4)],
    ['UnhealthyNodeReplacement added', (i) => (i['UnhealthyNodeReplacement'] = true)],
    ['CoreInstanceGroup.AutoScalingPolicy added', (i) => ((i['CoreInstanceGroup'] as Record<string, unknown>)['AutoScalingPolicy'] = { Constraints: { MinCapacity: 1, MaxCapacity: 3 } })],
    ['a task group AutoScalingPolicy added', (i) => ((i['TaskInstanceGroups'] as Record<string, unknown>[])[0]!['AutoScalingPolicy'] = { Constraints: { MinCapacity: 1, MaxCapacity: 3 } })],
  ])('updates in place on %s', (_label, mutate) => {
    const next = groups();
    mutate(next);
    expect(replaces(groups(), next)).toBe(false);
  });

  it('replaces when an in-place member moves beside a replacing one', () => {
    const next = groups();
    next['TerminationProtected'] = true;
    (next['CoreInstanceGroup'] as Record<string, unknown>)['InstanceCount'] = 3;
    next['AdditionalMasterSecurityGroups'] = ['sg-x'];
    expect(replaces(groups(), next)).toBe(true);
  });

  it('keeps a master group count change a replacement', () => {
    const next = groups();
    (next['MasterInstanceGroup'] as Record<string, unknown>)['InstanceCount'] = 3;
    expect(replaces(groups(), next)).toBe(true);
  });

  it.each<[string, (i: Record<string, unknown>) => void, boolean]>([
    ['core fleet TargetOnDemandCapacity changed', (i) => ((i['CoreInstanceFleet'] as Record<string, unknown>)['TargetOnDemandCapacity'] = 2), false],
    ['core fleet TargetSpotCapacity added', (i) => ((i['CoreInstanceFleet'] as Record<string, unknown>)['TargetSpotCapacity'] = 1), false],
    ['task fleet TargetOnDemandCapacity changed', (i) => ((i['TaskInstanceFleets'] as Record<string, unknown>[])[0]!['TargetOnDemandCapacity'] = 3), false],
    ['master fleet TargetOnDemandCapacity changed', (i) => ((i['MasterInstanceFleet'] as Record<string, unknown>)['TargetOnDemandCapacity'] = 2), true],
    ['core fleet InstanceTypeConfigs changed', (i) => ((i['CoreInstanceFleet'] as Record<string, unknown>)['InstanceTypeConfigs'] = [{ InstanceType: 'm5.2xlarge' }]), true],
    ['Ec2SubnetIds changed', (i) => (i['Ec2SubnetIds'] = ['subnet-1', 'subnet-2']), true],
  ])('instance fleets: %s', (_label, mutate, expected) => {
    const next = fleets();
    mutate(next);
    expect(replaces(fleets(), next)).toBe(expected);
  });

  it('does not replace on an unchanged block', () => {
    expect(replaces(groups(), groups())).toBe(false);
    expect(replaces(fleets(), fleets())).toBe(false);
  });

  it('replaces on an unresolved intrinsic in a replacing member, not in an in-place one', () => {
    const viaRef = groups();
    viaRef['Ec2SubnetId'] = { Ref: 'Subnet' };
    expect(emrClusterInstancesReplaced(groups(), viaRef)).toBe(true);
    const countViaRef = groups();
    (countViaRef['CoreInstanceGroup'] as Record<string, unknown>)['InstanceCount'] = { Ref: 'N' };
    expect(emrClusterInstancesReplaced(groups(), countViaRef)).toBe(false);
  });

  it('compares a non-object block whole', () => {
    expect(emrClusterInstancesReplaced({ 'Fn::If': ['C', groups(), fleets()] }, groups())).toBe(
      true
    );
    expect(emrClusterInstancesReplaced('x', 'x')).toBe(false);
  });

  it('answers the promoted-dependent probe (no value on either side) with true', () => {
    expect(emrClusterInstancesReplaced(undefined, undefined)).toBe(true);
    expect(registry.conditionalReplacementVerdict(TYPE, 'Instances', undefined, undefined)).toBe(
      true
    );
  });

  it('does not mutate the values it compares', () => {
    const before = groups();
    const after = groups();
    after['TerminationProtected'] = true;
    emrClusterInstancesReplaced(before, after);
    expect(before).toEqual(groups());
    expect(after['TerminationProtected']).toBe(true);
  });

  it('leaves every other property to the registry schema fallback', () => {
    for (const key of ['Name', 'ReleaseLabel', 'Tags', 'StepConcurrencyLevel', 'Steps']) {
      expect(registry.isClassified(TYPE, key)).toBe(false);
    }
  });
});
