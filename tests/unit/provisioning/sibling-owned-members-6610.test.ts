import { describe, it, expect } from 'vite-plus/test';
import {
  SIBLING_OWNED_ROWS,
  SIBLING_WRITE_PAIRS,
  siblingOwnedRevertDesired,
  stripSiblingOwnedParentMembers,
  tableMembersSiblingsStoppedWriting,
  withoutStoppedTableMembers,
} from '../../../src/provisioning/sibling-owned-members.js';
import { pruneMembersSiblingsStoppedWriting } from '../../../src/deployment/deploy-engine/observed-capture.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6610: the table of child types that write into a parent's
 * property, per pair. End to end through `cdkd drift` / `--revert`:
 * `tests/unit/cli/drift-sibling-owned-members-6610.test.ts`.
 */

type Siblings = Record<string, { resourceType: string; physicalId?: string; properties: Record<string, unknown> }>;
const ctx = (siblings: Siblings) => ({ siblings });

const CLUSTER = 'my-cluster';
const association = (cluster: unknown = CLUSTER) => ({
  resourceType: 'AWS::ECS::ClusterCapacityProviderAssociations',
  physicalId: 'assoc',
  properties: {
    Cluster: cluster,
    CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
    DefaultCapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
  },
});
const clusterBag = (providers: string[]) => ({
  ClusterName: CLUSTER,
  CapacityProviders: providers,
  DefaultCapacityProviderStrategy: providers.map((p) => ({ CapacityProvider: p, Weight: 1 })),
  ClusterSettings: [],
});

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:topic';
const INLINE = { Protocol: 'email', Endpoint: 'ops@example.com' };
const SIB = { Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:123456789012:q' };
const STRANGER = { Protocol: 'email', Endpoint: 'evil@example.com' };
const subscription = (props: Record<string, unknown> = SIB, topic: unknown = TOPIC) => ({
  resourceType: 'AWS::SNS::Subscription',
  physicalId: 'sub-arn',
  properties: { TopicArn: topic, ...props },
});

const ROLE = 'my-role';
const policy = (name: string) => ({ PolicyName: name, PolicyDocument: { Version: '2012-10-17' } });

describe('SIBLING_WRITE_PAIRS', () => {
  it('records every table row as a `table` verdict and no pair twice', () => {
    const keys = SIBLING_WRITE_PAIRS.map((p) => `${p.child}|${p.parent}|${p.key}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SIBLING_WRITE_PAIRS.filter((p) => p.verdict === 'table')).toHaveLength(
      SIBLING_OWNED_ROWS.length
    );
  });
});

describe('ECS cluster <- ClusterCapacityProviderAssociations (whole key)', () => {
  it.each([
    ['by name', CLUSTER],
    ['by ARN', `arn:aws:ecs:us-east-1:123456789012:cluster/${CLUSTER}`],
  ])('drops both lists from both sides when an association names the cluster %s', (_l, ref) => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::ECS::Cluster',
      CLUSTER,
      clusterBag(['FARGATE']),
      clusterBag(['FARGATE', 'FARGATE_SPOT']),
      { ClusterName: CLUSTER },
      ctx({ Assoc: association(ref) })
    );
    expect(out.baseline).toEqual({ ClusterName: CLUSTER, ClusterSettings: [] });
    expect(out.aws).toEqual({ ClusterName: CLUSTER, ClusterSettings: [] });
  });

  it.each([
    ['no association', {}],
    ['an association naming another cluster', { Assoc: association('other') }],
    ['a redacted association target', { Assoc: association('{{resolve:ssm:/c}}') }],
  ])('keeps comparing the lists with %s', (_l, siblings) => {
    const baseline = clusterBag(['FARGATE']);
    const aws = clusterBag(['FARGATE', 'FARGATE_SPOT']);
    const out = stripSiblingOwnedParentMembers(
      'AWS::ECS::Cluster',
      CLUSTER,
      baseline,
      aws,
      { ClusterName: CLUSTER },
      ctx(siblings as Siblings)
    );
    expect(out.baseline).toBe(baseline);
    expect(out.aws).toBe(aws);
  });

  it('keeps comparing a list the cluster template declares itself', () => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::ECS::Cluster',
      CLUSTER,
      clusterBag(['FARGATE']),
      clusterBag(['FARGATE', 'FARGATE_SPOT']),
      { ClusterName: CLUSTER, CapacityProviders: ['FARGATE'] },
      ctx({ Assoc: association() })
    );
    expect(out.baseline['CapacityProviders']).toEqual(['FARGATE']);
    expect(out.aws['CapacityProviders']).toEqual(['FARGATE', 'FARGATE_SPOT']);
    expect(out.aws['DefaultCapacityProviderStrategy']).toBeUndefined();
  });

  it('--revert drops the stale lists from the desired bag (the overlay sends the live ones)', () => {
    const live = clusterBag(['FARGATE', 'FARGATE_SPOT']);
    const desired = siblingOwnedRevertDesired(
      'AWS::ECS::Cluster',
      CLUSTER,
      { ...clusterBag(['FARGATE']), ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }] },
      live,
      { ClusterName: CLUSTER },
      ctx({ Assoc: association() })
    );
    expect(desired['CapacityProviders']).toBeUndefined();
    expect(desired['DefaultCapacityProviderStrategy']).toBeUndefined();
    expect(desired['ClusterSettings']).toEqual([{ Name: 'containerInsights', Value: 'enabled' }]);
  });
});

describe('SNS topic <- AWS::SNS::Subscription (members by Protocol + Endpoint)', () => {
  it('drops the sibling subscription from both sides, and only it', () => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::SNS::Topic',
      TOPIC,
      { Subscription: [INLINE, SIB] },
      { Subscription: [INLINE, SIB, STRANGER] },
      { Subscription: [INLINE] },
      ctx({ Sub: subscription() })
    );
    expect(out.baseline).toEqual({ Subscription: [INLINE] });
    expect(out.aws).toEqual({ Subscription: [INLINE, STRANGER] });
  });

  it.each([
    ['a subscription on another topic', { Sub: subscription(SIB, `${TOPIC}-other`) }],
    ['a subscription with another endpoint', { Sub: subscription({ ...SIB, Endpoint: 'x' }) }],
    ['a redacted endpoint', { Sub: subscription({ ...SIB, Endpoint: '***' }) }],
    ['no sibling at all', {}],
  ])('keeps the subscription compared with %s', (_l, siblings) => {
    const aws = { Subscription: [INLINE, SIB] };
    const out = stripSiblingOwnedParentMembers(
      'AWS::SNS::Topic',
      TOPIC,
      { Subscription: [INLINE] },
      aws,
      { Subscription: [INLINE] },
      ctx(siblings as Siblings)
    );
    expect(out.aws).toBe(aws);
  });

  it('keeps a subscription the topic template ALSO declares inline', () => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::SNS::Topic',
      TOPIC,
      { Subscription: [INLINE, SIB] },
      { Subscription: [INLINE] },
      { Subscription: [INLINE, SIB] },
      ctx({ Sub: subscription() })
    );
    expect(out.baseline).toEqual({ Subscription: [INLINE, SIB] });
  });

  it('--revert keeps the LIVE sibling subscription in the desired list', () => {
    const desired = siblingOwnedRevertDesired(
      'AWS::SNS::Topic',
      TOPIC,
      { Subscription: [INLINE, SIB] },
      { Subscription: [SIB, STRANGER] },
      { Subscription: [INLINE] },
      ctx({ Sub: subscription() })
    );
    // At its live position, so a provider pairing items by position finds it there.
    expect(desired).toEqual({ Subscription: [SIB, INLINE] });
  });

  it('--revert does not re-add a sibling subscription the readback lacks', () => {
    const desired = siblingOwnedRevertDesired(
      'AWS::SNS::Topic',
      TOPIC,
      { Subscription: [INLINE, SIB] },
      { Subscription: [] },
      { Subscription: [INLINE] },
      ctx({ Sub: subscription() })
    );
    expect(desired).toEqual({ Subscription: [INLINE] });
  });
});

describe('IAM principal <- AWS::IAM::Policy / RolePolicy / UserPolicy / GroupPolicy (inline Policies)', () => {
  const PRINCIPALS = [
    ['AWS::IAM::Role', 'Roles', 'AWS::IAM::RolePolicy', 'RoleName'],
    ['AWS::IAM::User', 'Users', 'AWS::IAM::UserPolicy', 'UserName'],
    ['AWS::IAM::Group', 'Groups', 'AWS::IAM::GroupPolicy', 'GroupName'],
  ] as const;
  const siblingsFor = (field: string, standalone: string, nameField: string) => [
    ['an AWS::IAM::Policy', { resourceType: 'AWS::IAM::Policy', properties: { ...policy('P'), [field]: [ROLE] } }],
    [standalone, { resourceType: standalone, properties: { ...policy('P'), [nameField]: ROLE } }],
  ] as const;

  for (const [type, field, standalone, nameField] of PRINCIPALS) {
    for (const [label, sibling] of siblingsFor(field, standalone, nameField)) {
      it(`${type}: drops ${label}'s policy from both sides`, () => {
        const out = stripSiblingOwnedParentMembers(
          type,
          ROLE,
          { Policies: [policy('Own'), policy('P')] },
          { Policies: [policy('Own'), policy('P'), policy('Stranger')] },
          { Policies: [policy('Own')] },
          ctx({ Pol: sibling })
        );
        expect(out.baseline).toEqual({ Policies: [policy('Own')] });
        expect(out.aws).toEqual({ Policies: [policy('Own'), policy('Stranger')] });
      });
    }
  }

  it('a sibling owns only the document it recorded: an edited live document stays compared', () => {
    const edited = { PolicyName: 'P', PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } };
    const aws = { Policies: [edited] };
    const out = stripSiblingOwnedParentMembers(
      'AWS::IAM::Role',
      ROLE,
      { Policies: [] },
      aws,
      {},
      ctx({ Pol: { resourceType: 'AWS::IAM::Policy', properties: { ...policy('P'), Roles: [ROLE] } } })
    );
    expect(out.aws).toBe(aws);
  });

  it('a document recorded as a JSON string matches the live object, keys in any order', () => {
    const recorded = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}';
    const live = { Statement: [{ Resource: '*', Action: 's3:GetObject', Effect: 'Allow' }], Version: '2012-10-17' };
    const out = stripSiblingOwnedParentMembers(
      'AWS::IAM::Role',
      ROLE,
      { Policies: [] },
      { Policies: [{ PolicyDocument: live, PolicyName: 'P' }] },
      {},
      ctx({ Pol: { resourceType: 'AWS::IAM::Policy', properties: { PolicyName: 'P', PolicyDocument: recorded, Roles: [ROLE] } } })
    );
    expect(out.aws).toEqual({ Policies: [] });
  });

  it('an old baseline holding the sibling policy under another document leaves it, when the SDK readback dropped the name', () => {
    const stale = { PolicyName: 'P', PolicyDocument: { Version: '2008-10-17' } };
    const context = ctx({ Pol: { resourceType: 'AWS::IAM::Policy', properties: { ...policy('P'), Roles: [ROLE] } } });
    const out = stripSiblingOwnedParentMembers('AWS::IAM::Role', ROLE, { Policies: [policy('Own'), stale] }, { Policies: [policy('Own')] }, { Policies: [policy('Own')] }, context);
    expect(out.baseline).toEqual({ Policies: [policy('Own')] });
    expect(
      siblingOwnedRevertDesired('AWS::IAM::Role', ROLE, { Policies: [policy('Own'), stale] }, { Policies: [policy('Own')] }, { Policies: [policy('Own')] }, context)
    ).toEqual({ Policies: [policy('Own')] });
  });

  it('a policy the principal template declares itself is not dropped by name', () => {
    const own = { PolicyName: 'P', PolicyDocument: { Version: '2008-10-17' } };
    const baseline = { Policies: [own] };
    const out = stripSiblingOwnedParentMembers('AWS::IAM::Role', ROLE, baseline, { Policies: [] }, { Policies: [own] }, ctx({ Pol: { resourceType: 'AWS::IAM::Policy', properties: { ...policy('P'), Roles: [ROLE] } } }));
    expect(out.baseline).toBe(baseline);
  });

  it('a readback that still holds the name decides by document: a stale baseline copy stays compared', () => {
    const stale = { PolicyName: 'P', PolicyDocument: { Version: '2008-10-17' } };
    const baseline = { Policies: [stale] };
    const out = stripSiblingOwnedParentMembers('AWS::IAM::Role', ROLE, baseline, { Policies: [stale] }, {}, ctx({ Pol: { resourceType: 'AWS::IAM::Policy', properties: { ...policy('P'), Roles: [ROLE] } } }));
    expect(out.baseline).toBe(baseline);
  });

  it('a sibling policy whose document changed in a deploy leaves the old document in no baseline', () => {
    const old = { PolicyName: 'P', PolicyDocument: { Version: '2008-10-17' } };
    const role = { resourceType: 'AWS::IAM::Role', physicalId: ROLE, properties: {}, observedProperties: { Policies: [old] } } as ResourceState;
    const next: Record<string, ResourceState> = {
      Role: role,
      Pol: { resourceType: 'AWS::IAM::Policy', physicalId: 'p', properties: { ...policy('P'), Roles: [ROLE] } } as ResourceState,
    };
    const previous = { Role: role, Pol: { resourceType: 'AWS::IAM::Policy', physicalId: 'p', properties: { ...old, Roles: [ROLE] } } as ResourceState };
    expect(pruneMembersSiblingsStoppedWriting(previous, next)).toBe(1);
    expect(next['Role']!.observedProperties).toEqual({ Policies: [] });
  });

  it('a UserPolicy does not reach a role of the same name', () => {
    const aws = { Policies: [policy('P')] };
    const out = stripSiblingOwnedParentMembers(
      'AWS::IAM::Role',
      ROLE,
      { Policies: [] },
      aws,
      {},
      ctx({ Pol: { resourceType: 'AWS::IAM::UserPolicy', properties: { ...policy('P'), UserName: ROLE } } })
    );
    expect(out.aws).toBe(aws);
  });

  it('--revert drops a sibling policy an old baseline holds, so update() does not re-put it', () => {
    const desired = siblingOwnedRevertDesired(
      'AWS::IAM::Role',
      ROLE,
      { Policies: [policy('Own'), policy('P')] },
      { Policies: [policy('Own')] },
      { Policies: [policy('Own')] },
      ctx({ Pol: { resourceType: 'AWS::IAM::Policy', properties: { ...policy('P'), Roles: [ROLE] } } })
    );
    expect(desired).toEqual({ Policies: [policy('Own')] });
  });

  it('a removed AWS::IAM::Policy leaves the role baseline', () => {
    const role = { resourceType: 'AWS::IAM::Role', physicalId: ROLE, properties: {}, observedProperties: { Policies: [policy('P')] } } as ResourceState;
    const next: Record<string, ResourceState> = { Role: role };
    const pol = { resourceType: 'AWS::IAM::Policy', physicalId: 'p', properties: { ...policy('P'), Roles: [ROLE] } } as ResourceState;
    expect(pruneMembersSiblingsStoppedWriting({ Role: role, Pol: pol }, next)).toBe(1);
    expect(next['Role']!.observedProperties).toEqual({ Policies: [] });
  });
});

const ASG = 'my-asg';
const hook = (name: string) => ({ LifecycleHookName: name, LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING' });

describe('ASG <- AWS::AutoScaling::LifecycleHook (members by LifecycleHookName)', () => {
  it.each([
    ['a named hook', { AutoScalingGroupName: ASG, ...hook('H') }, 'hook-cc-id'],
    ['a generated name, read from its Cloud Control id', { AutoScalingGroupName: ASG, LifecycleTransition: 'x' }, `${ASG}|H`],
  ])('drops %s from both sides', (_l, props, physicalId) => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::AutoScaling::AutoScalingGroup',
      ASG,
      { LifecycleHookSpecificationList: [hook('Own'), hook('H')] },
      { LifecycleHookSpecificationList: [hook('Own'), hook('H'), hook('Stranger')] },
      { LifecycleHookSpecificationList: [hook('Own')] },
      ctx({ Hook: { resourceType: 'AWS::AutoScaling::LifecycleHook', physicalId, properties: props } })
    );
    expect(out.baseline).toEqual({ LifecycleHookSpecificationList: [hook('Own')] });
    expect(out.aws).toEqual({ LifecycleHookSpecificationList: [hook('Own'), hook('Stranger')] });
  });

  it('a generated name read from an id naming ANOTHER group owns nothing', () => {
    const aws = { LifecycleHookSpecificationList: [hook('H')] };
    const out = stripSiblingOwnedParentMembers(
      'AWS::AutoScaling::AutoScalingGroup',
      ASG,
      { LifecycleHookSpecificationList: [] },
      aws,
      {},
      ctx({ Hook: { resourceType: 'AWS::AutoScaling::LifecycleHook', physicalId: 'other|H', properties: { AutoScalingGroupName: ASG } } })
    );
    expect(out.aws).toBe(aws);
  });

  it('--revert keeps the live sibling hook at its live position', () => {
    const desired = siblingOwnedRevertDesired(
      'AWS::AutoScaling::AutoScalingGroup',
      ASG,
      { LifecycleHookSpecificationList: [hook('Own')] },
      { LifecycleHookSpecificationList: [hook('H'), hook('Own'), hook('Stranger')] },
      { LifecycleHookSpecificationList: [hook('Own')] },
      ctx({ Hook: { resourceType: 'AWS::AutoScaling::LifecycleHook', physicalId: 'x', properties: { AutoScalingGroupName: ASG, ...hook('H') } } })
    );
    expect(desired).toEqual({ LifecycleHookSpecificationList: [hook('H'), hook('Own')] });
  });
});

const JOB = 'j-ABC';
const taskGroup = (name: string) => ({ Name: name, InstanceType: 'm5.xlarge', InstanceCount: 1 });

describe('EMR cluster <- InstanceGroupConfig / InstanceFleetConfig (nested Instances lists)', () => {
  const groupSibling = (props: Record<string, unknown> = {}) => ({
    resourceType: 'AWS::EMR::InstanceGroupConfig',
    physicalId: 'ig-1',
    properties: { JobFlowId: JOB, InstanceRole: 'TASK', ...taskGroup('Sib'), ...props },
  });

  it('drops a sibling TASK group from both sides, removing a list it empties', () => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::EMR::Cluster',
      JOB,
      { Name: 'c', Instances: { CoreInstanceGroup: { InstanceCount: 2 } } },
      { Name: 'c', Instances: { CoreInstanceGroup: { InstanceCount: 2 }, TaskInstanceGroups: [taskGroup('Sib')] } },
      { Instances: { CoreInstanceGroup: { InstanceCount: 2 } } },
      ctx({ Group: groupSibling() })
    );
    expect(out.aws).toEqual({ Name: 'c', Instances: { CoreInstanceGroup: { InstanceCount: 2 } } });
    expect(out.baseline).toEqual(out.aws);
  });

  it.each([
    ['an unnamed group', groupSibling({ Name: undefined })],
    ['a group of another cluster', groupSibling({ JobFlowId: 'j-OTHER' })],
  ])('keeps the group compared for %s', (_l, sibling) => {
    const aws = { Instances: { TaskInstanceGroups: [taskGroup('Sib')] } };
    expect(stripSiblingOwnedParentMembers('AWS::EMR::Cluster', JOB, {}, aws, {}, ctx({ Group: sibling })).aws).toBe(aws);
  });

  it('a second group of the same name and type is nobody\'s: one written copy drops one member', () => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::EMR::Cluster',
      JOB,
      { Instances: {} },
      { Instances: { TaskInstanceGroups: [taskGroup('Sib'), { ...taskGroup('Sib'), InstanceCount: 9 }] } },
      {},
      ctx({ Group: groupSibling() })
    );
    expect(out.aws).toEqual({ Instances: { TaskInstanceGroups: [{ ...taskGroup('Sib'), InstanceCount: 9 }] } });
    const desired = siblingOwnedRevertDesired(
      'AWS::EMR::Cluster',
      JOB,
      { Instances: {} },
      { Instances: { TaskInstanceGroups: [taskGroup('Sib'), { ...taskGroup('Sib'), InstanceCount: 9 }] } },
      {},
      ctx({ Group: groupSibling() })
    );
    expect(desired).toEqual({ Instances: { TaskInstanceGroups: [taskGroup('Sib')] } });
  });

  it('two sibling groups of one identity own two copies, less one the cluster declares', () => {
    const two = ctx({ G1: groupSibling(), G2: { ...groupSibling(), physicalId: 'ig-2' } });
    const live = { Instances: { TaskInstanceGroups: [taskGroup('Sib'), taskGroup('Sib')] } };
    expect(stripSiblingOwnedParentMembers('AWS::EMR::Cluster', JOB, {}, live, {}, two).aws).toEqual({ Instances: {} });
    expect(
      stripSiblingOwnedParentMembers('AWS::EMR::Cluster', JOB, {}, live, { Instances: { TaskInstanceGroups: [taskGroup('Sib')] } }, two).aws
    ).toEqual({ Instances: { TaskInstanceGroups: [taskGroup('Sib')] } });
  });

  it('--revert re-adds no copy the desired bag already holds', () => {
    const desired = siblingOwnedRevertDesired(
      'AWS::EMR::Cluster',
      JOB,
      { Instances: { TaskInstanceGroups: [taskGroup('Sib'), taskGroup('Sib')] } },
      { Instances: { TaskInstanceGroups: [taskGroup('Sib'), taskGroup('Sib')] } },
      {},
      ctx({ Group: groupSibling() })
    );
    expect(desired).toEqual({ Instances: { TaskInstanceGroups: [taskGroup('Sib'), taskGroup('Sib')] } });
  });

  it('removing one of two same-identity sibling groups prunes one copy, not both', () => {
    const cluster = { resourceType: 'AWS::EMR::Cluster', physicalId: JOB, properties: {}, observedProperties: { Instances: { TaskInstanceGroups: [taskGroup('Sib'), taskGroup('Sib')] } } } as ResourceState;
    const g2 = { ...groupSibling(), physicalId: 'ig-2' } as ResourceState;
    const next: Record<string, ResourceState> = { Cluster: cluster, G2: g2 };
    expect(pruneMembersSiblingsStoppedWriting({ Cluster: cluster, G1: groupSibling() as ResourceState, G2: g2 }, next)).toBe(1);
    expect(next['Cluster']!.observedProperties).toEqual({ Instances: { TaskInstanceGroups: [taskGroup('Sib')] } });
  });

  it('drops a sibling TASK fleet, and keeps a stranger task group', () => {
    const fleet = { resourceType: 'AWS::EMR::InstanceFleetConfig', properties: { ClusterId: JOB, InstanceFleetType: 'TASK', Name: 'F' } };
    const out = stripSiblingOwnedParentMembers(
      'AWS::EMR::Cluster',
      JOB,
      { Instances: {} },
      { Instances: { TaskInstanceFleets: [{ Name: 'F', TargetOnDemandCapacity: 1 }], TaskInstanceGroups: [taskGroup('Stranger')] } },
      {},
      ctx({ Fleet: fleet })
    );
    expect(out.aws).toEqual({ Instances: { TaskInstanceGroups: [taskGroup('Stranger')] } });
  });

  it('--revert puts the live sibling group back where the read lists it', () => {
    const desired = siblingOwnedRevertDesired(
      'AWS::EMR::Cluster',
      JOB,
      { Instances: { CoreInstanceGroup: { InstanceCount: 2 } } },
      { Instances: { CoreInstanceGroup: { InstanceCount: 3 }, TaskInstanceGroups: [taskGroup('Sib')] } },
      {},
      ctx({ Group: groupSibling() })
    );
    expect(desired).toEqual({
      Instances: { CoreInstanceGroup: { InstanceCount: 2 }, TaskInstanceGroups: [taskGroup('Sib')] },
    });
  });

  it('a removed group leaves the cluster baseline, and the emptied list with it', () => {
    const cluster = { resourceType: 'AWS::EMR::Cluster', physicalId: JOB, properties: {}, observedProperties: { Instances: { TaskInstanceGroups: [taskGroup('Sib')] } } } as ResourceState;
    const next: Record<string, ResourceState> = { Cluster: cluster };
    expect(pruneMembersSiblingsStoppedWriting({ Cluster: cluster, Group: groupSibling() as ResourceState }, next)).toBe(1);
    expect(next['Cluster']!.observedProperties).toEqual({ Instances: {} });
  });
});

const EIP = '203.0.113.10|eipalloc-0abc';
const eipAssociation = (props: Record<string, unknown>) => ({
  resourceType: 'AWS::EC2::EIPAssociation',
  physicalId: 'eipassoc-1',
  properties: { InstanceId: 'i-new', ...props },
});

describe('EC2 EIP <- EIPAssociation (whole key, Cloud Control readback)', () => {
  it.each([
    ['its AllocationId', { AllocationId: 'eipalloc-0abc' }],
    ['its public IP', { EIP: '203.0.113.10' }],
  ])('drops InstanceId from both sides when an association names the address by %s', (_l, props) => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::EC2::EIP',
      EIP,
      { Domain: 'vpc', InstanceId: 'i-old' },
      { Domain: 'vpc', InstanceId: 'i-new' },
      { Domain: 'vpc' },
      ctx({ Assoc: eipAssociation(props) })
    );
    expect(out).toEqual({ baseline: { Domain: 'vpc' }, aws: { Domain: 'vpc' } });
  });

  it('keeps InstanceId compared for an association naming another address, or a declared one', () => {
    const aws = { Domain: 'vpc', InstanceId: 'i-new' };
    expect(
      stripSiblingOwnedParentMembers('AWS::EC2::EIP', EIP, aws, aws, { Domain: 'vpc' }, ctx({ Assoc: eipAssociation({ AllocationId: 'eipalloc-other' }) })).aws
    ).toBe(aws);
    expect(
      stripSiblingOwnedParentMembers('AWS::EC2::EIP', EIP, aws, aws, { InstanceId: 'i-new' }, ctx({ Assoc: eipAssociation({ AllocationId: 'eipalloc-0abc' }) })).aws
    ).toBe(aws);
  });

  it('--revert drops a stale InstanceId from the desired bag', () => {
    const desired = siblingOwnedRevertDesired(
      'AWS::EC2::EIP',
      EIP,
      { Domain: 'vpc', InstanceId: 'i-old' },
      { Domain: 'vpc', InstanceId: 'i-new' },
      { Domain: 'vpc' },
      ctx({ Assoc: eipAssociation({ EIP: '203.0.113.10' }) })
    );
    expect(desired).toEqual({ Domain: 'vpc' });
  });

  it('an association replaced by one naming the address the other way stops nothing', () => {
    const eip = { resourceType: 'AWS::EC2::EIP', physicalId: EIP, properties: {} } as ResourceState;
    expect(
      tableMembersSiblingsStoppedWriting(
        { Assoc: eipAssociation({ EIP: '203.0.113.10' }) as ResourceState },
        { Eip: eip, Assoc2: eipAssociation({ AllocationId: 'eipalloc-0abc' }) as ResourceState }
      ).size
    ).toBe(0);
  });

  it('a removed association drops InstanceId from the recorded baseline', () => {
    const eip = { resourceType: 'AWS::EC2::EIP', physicalId: EIP, properties: { Domain: 'vpc' }, observedProperties: { Domain: 'vpc', InstanceId: 'i-old' } } as ResourceState;
    const next: Record<string, ResourceState> = { Eip: eip };
    expect(pruneMembersSiblingsStoppedWriting({ Eip: eip, Assoc: eipAssociation({ AllocationId: 'eipalloc-0abc' }) as ResourceState }, next)).toBe(1);
    expect(next['Eip']!.observedProperties).toEqual({ Domain: 'vpc' });
  });
});

describe('tableMembersSiblingsStoppedWriting', () => {
  const rec = (resourceType: string, physicalId: string, properties: Record<string, unknown>, extra: Partial<ResourceState> = {}): ResourceState =>
    ({ resourceType, physicalId, properties, ...extra }) as ResourceState;

  it('a removed standalone subscription leaves the topic baseline', () => {
    const topic = rec('AWS::SNS::Topic', TOPIC, { Subscription: [INLINE] }, {
      observedProperties: { Subscription: [INLINE, SIB] },
    });
    const previous = { Topic: topic, Sub: rec('AWS::SNS::Subscription', 's', { TopicArn: TOPIC, ...SIB }) };
    const next: Record<string, ResourceState> = { Topic: topic };
    expect(pruneMembersSiblingsStoppedWriting(previous, next)).toBe(1);
    expect(next['Topic']!.observedProperties).toEqual({ Subscription: [INLINE] });
  });

  it('a removed association leaves the cluster baseline lists empty', () => {
    const cluster = rec('AWS::ECS::Cluster', CLUSTER, { ClusterName: CLUSTER }, {
      observedProperties: clusterBag(['FARGATE']),
    });
    const previous = { Cluster: cluster, Assoc: association() as ResourceState };
    const next: Record<string, ResourceState> = { Cluster: cluster };
    expect(pruneMembersSiblingsStoppedWriting(previous, next)).toBe(1);
    expect(next['Cluster']!.observedProperties).toEqual({
      ...clusterBag([]),
      ClusterSettings: [],
    });
  });

  it('a removed association leaves a list the cluster template declares itself', () => {
    const cluster = rec('AWS::ECS::Cluster', CLUSTER, { CapacityProviders: ['FARGATE'] }, {
      observedProperties: clusterBag(['FARGATE']),
    });
    const next: Record<string, ResourceState> = { Cluster: cluster };
    pruneMembersSiblingsStoppedWriting({ Cluster: cluster, Assoc: association() as ResourceState }, next);
    expect(next['Cluster']!.observedProperties!['CapacityProviders']).toEqual(['FARGATE']);
    expect(next['Cluster']!.observedProperties!['DefaultCapacityProviderStrategy']).toEqual([]);
  });

  it('an association still naming the cluster, or a retained one, stops nothing', () => {
    const cluster = rec('AWS::ECS::Cluster', CLUSTER, {}, { observedProperties: clusterBag(['FARGATE']) });
    const changed = { ...association(), properties: { ...association().properties, CapacityProviders: ['FARGATE'] } } as ResourceState;
    expect(tableMembersSiblingsStoppedWriting({ Assoc: association() as ResourceState }, { Cluster: cluster, Assoc: changed }).size).toBe(0);
    const retained = { ...association(), deletionPolicy: 'Retain' } as ResourceState;
    expect(tableMembersSiblingsStoppedWriting({ Assoc: retained }, { Cluster: cluster }).size).toBe(0);
  });

  it('a subscription moved to another endpoint drops only the old endpoint', () => {
    const topic = rec('AWS::SNS::Topic', TOPIC, {}, { observedProperties: { Subscription: [SIB, STRANGER] } });
    const stopped = tableMembersSiblingsStoppedWriting(
      { Sub: rec('AWS::SNS::Subscription', 's', { TopicArn: TOPIC, ...SIB }) },
      { Topic: topic, Sub: rec('AWS::SNS::Subscription', 's2', { TopicArn: TOPIC, ...SIB, Endpoint: 'new' }) }
    );
    expect(withoutStoppedTableMembers(topic.observedProperties!, stopped.get('Topic')!, {})).toEqual({
      Subscription: [STRANGER],
    });
  });
});
