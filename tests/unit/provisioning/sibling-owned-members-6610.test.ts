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

  it('--revert sends the LIVE lists, so update() sees no capacity-provider change', () => {
    const live = clusterBag(['FARGATE', 'FARGATE_SPOT']);
    const desired = siblingOwnedRevertDesired(
      'AWS::ECS::Cluster',
      CLUSTER,
      { ...clusterBag(['FARGATE']), ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }] },
      live,
      { ClusterName: CLUSTER },
      ctx({ Assoc: association() })
    );
    expect(desired['CapacityProviders']).toEqual(live['CapacityProviders']);
    expect(desired['DefaultCapacityProviderStrategy']).toEqual(
      live['DefaultCapacityProviderStrategy']
    );
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
    expect(desired).toEqual({ Subscription: [INLINE, SIB] });
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

describe('IAM principal <- AWS::IAM::Policy / RolePolicy (inline Policies by PolicyName)', () => {
  it.each([
    [
      'an AWS::IAM::Policy naming the role',
      { resourceType: 'AWS::IAM::Policy', properties: { PolicyName: 'P', Roles: [ROLE] } },
    ],
    [
      'a standalone AWS::IAM::RolePolicy',
      { resourceType: 'AWS::IAM::RolePolicy', properties: { PolicyName: 'P', RoleName: ROLE } },
    ],
  ])('drops %s from both sides', (_l, sibling) => {
    const out = stripSiblingOwnedParentMembers(
      'AWS::IAM::Role',
      ROLE,
      { Policies: [policy('Own'), policy('P')] },
      { Policies: [policy('Own'), policy('P'), policy('Stranger')] },
      { Policies: [policy('Own')] },
      ctx({ Pol: sibling })
    );
    expect(out.baseline).toEqual({ Policies: [policy('Own')] });
    expect(out.aws).toEqual({ Policies: [policy('Own'), policy('Stranger')] });
  });

  it('a UserPolicy does not reach a role of the same name', () => {
    const aws = { Policies: [policy('P')] };
    const out = stripSiblingOwnedParentMembers(
      'AWS::IAM::Role',
      ROLE,
      { Policies: [] },
      aws,
      {},
      ctx({ Pol: { resourceType: 'AWS::IAM::UserPolicy', properties: { PolicyName: 'P', UserName: ROLE } } })
    );
    expect(out.aws).toBe(aws);
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
