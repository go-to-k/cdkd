/**
 * go-to-k/cdkd#6610: the ONE table of resource types that write into ANOTHER
 * resource's property, and the drift path every such pair goes through.
 *
 * A CloudFormation type such as `AWS::SNS::Subscription` or
 * `AWS::ECS::ClusterCapacityProviderAssociations` is its own resource, yet it
 * writes members of a PARENT's property (a topic's `Subscription`, a cluster's
 * `CapacityProviders`). When cdkd reads the parent for its drift baseline or
 * for `cdkd drift`, the child's members show up on the parent, so drift
 * reported them as the parent's drift and `drift --revert` sent the parent's
 * baseline back, removing what the sibling attached.
 *
 * {@link SIBLING_WRITE_PAIRS} records EVERY such pair the audit found, with
 * one of three verdicts:
 *  - `table`: handled here, by a row of {@link SIBLING_OWNED_ROWS};
 *  - `helper`: handled by a per-pair module that predates this table and also
 *    filters the parent's own readback and deploy-time capture
 *    (`iam-sibling-managed-policies.ts`, `sg-sibling-rules.ts`, or an
 *    `undeclaredUncomparedDriftKeys` entry in `cli/commands/drift/baseline-keys.ts`);
 *  - `none`: the parent's drift read never returns the child's members, so
 *    the pair does not collide (the evidence names the read).
 * A new colliding pair is a row of {@link SIBLING_OWNED_ROWS}, not new code.
 *
 * What a row does, always from the stack's OWN state records (no AWS call):
 *  - DETECTION ({@link stripSiblingOwnedParentMembers}): a member a sibling
 *    record of the stack writes is dropped from BOTH comparison sides, unless
 *    the parent's own template declares it too (then the parent owns it as
 *    well). A member nothing in the stack writes is still compared, so an
 *    out-of-band addition still reports, and `--revert` still removes it.
 *  - REVERT ({@link siblingOwnedRevertDesired}): the desired bag drops the same
 *    members, then takes back the LIVE ones from the readback, which is also
 *    `update()`'s previous side: the provider sees each sibling-owned member on
 *    both sides and neither removes nor re-adds it, on the SDK route and on
 *    Cloud Control, whose readback is not filtered.
 *  - DEPLOY ({@link tableMembersSiblingsStoppedWriting}): when a deploy makes a
 *    sibling stop writing a member (the child removed or changed), the parent's
 *    recorded baseline drops it, so drift does not report it as lost and
 *    `--revert` does not put it back.
 *
 * A WHOLE-KEY row (no `identity`) is a child that owns the parent's entire
 * property: `PutClusterCapacityProviders` replaces a cluster's whole set, so a
 * cluster whose template declares neither list holds only what its
 * association wrote.
 */
import type { ReadCurrentStateContext } from '../types/resource.js';
import { hasOwnKey } from '../utils/own-keys.js';
import { injectiveKey } from '../state/record-keys.js';
import {
  previousMaySurvive,
  stripSiblingOwnedMembers,
  type TemplatePolicies,
  type WriterRecord,
} from './iam-sibling-managed-policies.js';
import { isRedactedRecordedValue } from './redacted-delete-address.js';
import { stripSiblingOwnedSgRules } from './sg-sibling-rules.js';

/** One write a child record makes onto a parent: the parent's physical id, and the member's identity (absent: the whole key). */
interface SiblingWrite {
  parent: string;
  member?: string;
}

/** One colliding (child, parent, key) pair handled by this module. */
interface SiblingOwnedRow {
  child: string;
  parent: string;
  /** The parent property, a `.`-separated path for a nested one (`Instances.TaskInstanceGroups`). */
  key: string;
  /** What the child record writes, from its recorded `properties` and physical id. */
  writes: (properties: Record<string, unknown>, physicalId: string | undefined) => SiblingWrite[];
  /** A list element's identity on the parent; absent for a whole-key row. */
  identity?: (element: unknown) => string | undefined;
  /** The ids a child may name the parent by; absent: its physical id alone. */
  parentIds?: (physicalId: string) => string[];
  /**
   * The parent's read OMITS the list when it is empty (rather than emitting
   * `[]`), so a list the strip empties leaves the bag, both sides alike.
   */
  emptyMeansAbsent?: boolean;
}

/** Marker for {@link setAt}: remove the key. */
const REMOVE: unique symbol = Symbol('remove');

/** The value at `path` in `bag`, `undefined` when any segment is missing or not an object. */
function getAt(bag: unknown, path: readonly string[]): unknown {
  let node: unknown = bag;
  for (const segment of path) {
    if (!isPlainRecord(node) || !hasOwnKey(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Whether `bag` holds `path` (own keys, every segment). */
function hasAt(bag: unknown, path: readonly string[]): boolean {
  let node: unknown = bag;
  for (const segment of path) {
    if (!isPlainRecord(node) || !hasOwnKey(node, segment)) return false;
    node = node[segment];
  }
  return true;
}

/** `bag` with `value` at `path` (copy-on-write along the path); `path`'s containers must exist. */
function setAt(
  bag: Record<string, unknown>,
  path: readonly string[],
  value: unknown
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return bag;
  if (rest.length === 0) {
    if (value !== REMOVE) return { ...bag, [head]: value };
    const { [head]: _removed, ...kept } = bag;
    return kept;
  }
  const child = bag[head];
  return isPlainRecord(child) ? { ...bag, [head]: setAt(child, rest, value) } : bag;
}

const pathOf = (row: SiblingOwnedRow): string[] => row.key.split('.');

/** The ids `row`'s children may name a parent of `physicalId` by. */
function parentIdsOf(row: SiblingOwnedRow, physicalId: string): string[] {
  return row.parentIds ? row.parentIds(physicalId) : [physicalId];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty plain string that is not a redaction mask or a `{{resolve:...}}` reference. */
function plainString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !isRedactedRecordedValue(value)
    ? value
    : undefined;
}

/**
 * An association's `Cluster`: the cluster name, or its ARN, which names the
 * cluster after `cluster/`. The cluster's physical id is its name.
 */
function clusterWrites(properties: Record<string, unknown>): SiblingWrite[] {
  const cluster = plainString(properties['Cluster']);
  if (cluster === undefined) return [];
  const arn = /^arn:[^:]+:ecs:[^:]*:[^:]*:cluster\/(.+)$/.exec(cluster);
  return [{ parent: arn ? arn[1]! : cluster }];
}

/** An SNS subscription's identity, `(Protocol, Endpoint)`: what the topic's read and `update()` match on. */
function snsSubscriptionIdentity(element: unknown): string | undefined {
  if (!isPlainRecord(element)) return undefined;
  const protocol = plainString(element['Protocol']);
  const endpoint = plainString(element['Endpoint']);
  return protocol === undefined || endpoint === undefined
    ? undefined
    : JSON.stringify([protocol, endpoint]);
}

function snsSubscriptionWrites(properties: Record<string, unknown>): SiblingWrite[] {
  const topic = plainString(properties['TopicArn']);
  const member = snsSubscriptionIdentity(properties);
  return topic === undefined || member === undefined ? [] : [{ parent: topic, member }];
}

/** `value` as key-sorted JSON, or `undefined` when it holds a mask or a `{{resolve:...}}` reference. */
function canonicalJson(value: unknown): string | undefined {
  let doc = value;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc) as unknown;
    } catch {
      return undefined;
    }
  }
  if (doc === undefined || isRedactedRecordedValue(doc)) return undefined;
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : isPlainRecord(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])])
          )
        : v;
  return JSON.stringify(sort(doc));
}

/**
 * An inline policy's identity on a principal: its `PolicyName` AND its
 * document. A sibling owns only the document it RECORDED: an `AWS::IAM::Policy`
 * naming several principals reads back its first only, so a document edited
 * on another one must stay this principal's drift rather than leave it.
 */
function inlinePolicyIdentity(element: unknown): string | undefined {
  if (!isPlainRecord(element)) return undefined;
  const name = plainString(element['PolicyName']);
  const doc = canonicalJson(element['PolicyDocument']);
  return name === undefined || doc === undefined ? undefined : JSON.stringify([name, doc]);
}

/** An `AWS::IAM::Policy`'s writes onto each principal its `field` list names. */
function iamPolicyWrites(field: 'Roles' | 'Users' | 'Groups') {
  return (properties: Record<string, unknown>): SiblingWrite[] => {
    const member = inlinePolicyIdentity(properties);
    const names = properties[field];
    if (member === undefined || !Array.isArray(names)) return [];
    return names.flatMap((n) => {
      const parent = plainString(n);
      return parent === undefined ? [] : [{ parent, member }];
    });
  };
}

/** A standalone `RolePolicy` / `UserPolicy` / `GroupPolicy`'s write onto the principal its `field` names. */
function standalonePolicyWrites(field: 'RoleName' | 'UserName' | 'GroupName') {
  return (properties: Record<string, unknown>): SiblingWrite[] => {
    const member = inlinePolicyIdentity(properties);
    const parent = plainString(properties[field]);
    return member === undefined || parent === undefined ? [] : [{ parent, member }];
  };
}

/**
 * An `EIPAssociation`'s address: its `AllocationId`, or its `EIP` (the public
 * IP) for an address with none. The EIP's physical id is `PublicIp|AllocationId`.
 */
function eipAssociationWrites(properties: Record<string, unknown>): SiblingWrite[] {
  const parent = plainString(properties['AllocationId']) ?? plainString(properties['EIP']);
  return parent === undefined ? [] : [{ parent }];
}

/**
 * A standalone lifecycle hook's write onto its group: the hook's name, from
 * `LifecycleHookName` or, for a generated one, the second segment of its
 * Cloud Control id `<group>|<hook>`.
 */
function lifecycleHookWrites(
  properties: Record<string, unknown>,
  physicalId: string | undefined
): SiblingWrite[] {
  const group = plainString(properties['AutoScalingGroupName']);
  const fromId = typeof physicalId === 'string' ? physicalId.split('|') : [];
  const name =
    plainString(properties['LifecycleHookName']) ??
    (fromId.length === 2 && fromId[0] === group ? plainString(fromId[1]) : undefined);
  return group === undefined || name === undefined ? [] : [{ parent: group, member: name }];
}

function lifecycleHookIdentity(element: unknown): string | undefined {
  return isPlainRecord(element) ? plainString(element['LifecycleHookName']) : undefined;
}

/**
 * A TASK instance group's identity in the cluster's `Instances`: its `Name` and
 * `InstanceType`. A group with no name owns nothing (it stays compared), since
 * two unnamed groups of one type cannot be told apart.
 */
function emrGroupIdentity(element: unknown): string | undefined {
  if (!isPlainRecord(element)) return undefined;
  const name = plainString(element['Name']);
  const type = plainString(element['InstanceType']);
  return name === undefined || type === undefined ? undefined : JSON.stringify([name, type]);
}

function emrGroupWrites(properties: Record<string, unknown>): SiblingWrite[] {
  const cluster = plainString(properties['JobFlowId']);
  const member = properties['InstanceRole'] === 'TASK' ? emrGroupIdentity(properties) : undefined;
  return cluster === undefined || member === undefined ? [] : [{ parent: cluster, member }];
}

/** A TASK instance fleet's identity in the cluster's `Instances`: its `Name`. */
function emrFleetIdentity(element: unknown): string | undefined {
  return isPlainRecord(element) ? plainString(element['Name']) : undefined;
}

function emrFleetWrites(properties: Record<string, unknown>): SiblingWrite[] {
  const cluster = plainString(properties['ClusterId']);
  const member =
    properties['InstanceFleetType'] === 'TASK' ? emrFleetIdentity(properties) : undefined;
  return cluster === undefined || member === undefined ? [] : [{ parent: cluster, member }];
}

const PRINCIPALS = [
  ['AWS::IAM::Role', 'Roles', 'AWS::IAM::RolePolicy', 'RoleName'],
  ['AWS::IAM::User', 'Users', 'AWS::IAM::UserPolicy', 'UserName'],
  ['AWS::IAM::Group', 'Groups', 'AWS::IAM::GroupPolicy', 'GroupName'],
] as const;

/** The colliding pairs this module handles. */
export const SIBLING_OWNED_ROWS: readonly SiblingOwnedRow[] = [
  {
    child: 'AWS::ECS::ClusterCapacityProviderAssociations',
    parent: 'AWS::ECS::Cluster',
    key: 'CapacityProviders',
    writes: clusterWrites,
  },
  {
    child: 'AWS::ECS::ClusterCapacityProviderAssociations',
    parent: 'AWS::ECS::Cluster',
    key: 'DefaultCapacityProviderStrategy',
    writes: clusterWrites,
  },
  {
    child: 'AWS::SNS::Subscription',
    parent: 'AWS::SNS::Topic',
    key: 'Subscription',
    writes: snsSubscriptionWrites,
    identity: snsSubscriptionIdentity,
  },
  // The group's read emits every live hook (`DescribeLifecycleHooks`), and
  // `update()` deletes a previous hook the desired side lacks.
  {
    child: 'AWS::AutoScaling::LifecycleHook',
    parent: 'AWS::AutoScaling::AutoScalingGroup',
    key: 'LifecycleHookSpecificationList',
    writes: lifecycleHookWrites,
    identity: lifecycleHookIdentity,
  },
  // The cluster's read lists every TASK group / fleet under `Instances`, and
  // omits a list that is empty.
  {
    child: 'AWS::EMR::InstanceGroupConfig',
    parent: 'AWS::EMR::Cluster',
    key: 'Instances.TaskInstanceGroups',
    writes: emrGroupWrites,
    identity: emrGroupIdentity,
    emptyMeansAbsent: true,
  },
  {
    child: 'AWS::EMR::InstanceFleetConfig',
    parent: 'AWS::EMR::Cluster',
    key: 'Instances.TaskInstanceFleets',
    writes: emrFleetWrites,
    identity: emrFleetIdentity,
    emptyMeansAbsent: true,
  },
  // The EIP's SDK read emits `InstanceId` only when the EIP declares it; a
  // Cloud Control read returns the association's instance on every address.
  {
    child: 'AWS::EC2::EIPAssociation',
    parent: 'AWS::EC2::EIP',
    key: 'InstanceId',
    writes: eipAssociationWrites,
    parentIds: (physicalId) => physicalId.split('|').filter((part) => part !== ''),
  },
  // The IAM providers' own readback already drops these by name
  // (`collectInlinePolicyNamesManagedBySiblings`, #323 / #4821); the rows add
  // the baseline side, a Cloud Control readback, and the deploy-time prune,
  // and own a policy only under the document the sibling recorded.
  ...PRINCIPALS.flatMap(([parent, field, standalone, nameField]) => [
    {
      child: 'AWS::IAM::Policy',
      parent,
      key: 'Policies',
      writes: iamPolicyWrites(field),
      identity: inlinePolicyIdentity,
    },
    {
      child: standalone,
      parent,
      key: 'Policies',
      writes: standalonePolicyWrites(nameField),
      identity: inlinePolicyIdentity,
    },
  ]),
];

/** A recorded verdict for one (child, parent, key) pair; see the module comment. */
export interface SiblingWritePair {
  child: string;
  parent: string;
  key: string;
  verdict: 'table' | 'helper' | 'none';
  /** Where it is handled, or which read shows it does not collide. */
  evidence: string;
}

/**
 * Every child -> parent property pair the go-to-k/cdkd#6610 audit examined.
 * The `table` entries are derived from {@link SIBLING_OWNED_ROWS}, so the two
 * cannot disagree. A `none` verdict's evidence is the parent's SDK provider
 * read, the route every listed parent takes unless its record is pinned to
 * Cloud Control; a Cloud Control read returns every schema property the model
 * holds, so a pair whose parent schema carries the child's members collides
 * there and needs a row, not a `none` entry.
 */
export const SIBLING_WRITE_PAIRS: readonly SiblingWritePair[] = [
  ...SIBLING_OWNED_ROWS.map((row): SiblingWritePair => ({
    child: row.child,
    parent: row.parent,
    key: row.key,
    verdict: 'table',
    evidence: 'SIBLING_OWNED_ROWS',
  })),
  ...(['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Group'] as const).map(
    (parent): SiblingWritePair => ({
      child: 'AWS::IAM::ManagedPolicy',
      parent,
      key: 'ManagedPolicyArns',
      verdict: 'helper',
      evidence: 'iam-sibling-managed-policies.ts (#6324)',
    })
  ),
  ...(['Roles', 'Users', 'Groups'] as const).map((key): SiblingWritePair => ({
    child: 'AWS::IAM::Role / User / Group',
    parent: 'AWS::IAM::ManagedPolicy',
    key,
    verdict: 'helper',
    evidence: 'iam-sibling-managed-policies.ts (#6328)',
  })),
  {
    child: 'AWS::IAM::UserToGroupAddition',
    parent: 'AWS::IAM::User',
    key: 'Groups',
    verdict: 'helper',
    evidence: 'iam-sibling-managed-policies.ts (#6328)',
  },
  ...(['SecurityGroupIngress', 'SecurityGroupEgress'] as const).map((key): SiblingWritePair => ({
    child: `AWS::EC2::${key}`,
    parent: 'AWS::EC2::SecurityGroup',
    key,
    verdict: 'helper',
    evidence: 'sg-sibling-rules.ts (#6418)',
  })),
  {
    child: 'Custom::S3BucketNotifications',
    parent: 'AWS::S3::Bucket',
    key: 'NotificationConfiguration',
    verdict: 'helper',
    evidence: 'undeclaredUncomparedDriftKeys (#5736): any writer, any stack',
  },
  {
    child: 'AWS::Events::EventBusPolicy',
    parent: 'AWS::Events::EventBus',
    key: 'Policy',
    verdict: 'helper',
    evidence: 'undeclaredUncomparedDriftKeys (#6323): any writer, any stack',
  },
  {
    child: 'AWS::EC2::VolumeAttachment',
    parent: 'AWS::EC2::Instance',
    key: 'BlockDeviceMappings',
    verdict: 'helper',
    evidence: 'undeclaredUncomparedDriftKeys + declared-devices readback (#6384)',
  },
  ...(
    [
      [
        'AWS::IAM::UserToGroupAddition',
        'AWS::IAM::Group',
        'members',
        'the group read has no member list',
      ],
      [
        'AWS::Lambda::Permission',
        'AWS::Lambda::Function',
        'policy',
        'lambda-function read-state emits no Policy',
      ],
      [
        'AWS::Lambda::EventSourceMapping / EventInvokeConfig / Url',
        'AWS::Lambda::Function',
        '-',
        'lambda-function read-state emits none of their keys',
      ],
      [
        'AWS::S3::BucketPolicy',
        'AWS::S3::Bucket',
        'policy',
        's3-bucket read-state emits no Policy',
      ],
      [
        'AWS::SNS::TopicPolicy',
        'AWS::SNS::Topic',
        'policy',
        'sns-topic read-state emits no Policy',
      ],
      ['AWS::SQS::QueuePolicy', 'AWS::SQS::Queue', 'policy', 'the SQS queue read emits no Policy'],
      [
        'AWS::SNS::TopicInlinePolicy',
        'AWS::SNS::Topic',
        'policy',
        'sns-topic read-state emits no Policy',
      ],
      [
        'AWS::SQS::QueueInlinePolicy',
        'AWS::SQS::Queue',
        'policy',
        'the SQS queue read emits no Policy',
      ],
      [
        'AWS::Logs::SubscriptionFilter',
        'AWS::Logs::LogGroup',
        'filters',
        'logs-loggroup read-state emits no filter key',
      ],
      [
        'AWS::ElasticLoadBalancingV2::ListenerRule',
        'AWS::ElasticLoadBalancingV2::Listener',
        'rules',
        "the listener read has no rule list; DefaultActions is the listener's own",
      ],
      [
        'AWS::ElasticLoadBalancingV2::ListenerCertificate',
        'AWS::ElasticLoadBalancingV2::Listener',
        'Certificates',
        'DescribeListeners returns the default certificate only',
      ],
      [
        'AWS::EC2::NetworkAclEntry',
        'AWS::EC2::NetworkAcl',
        'entries',
        'the network ACL read emits VpcId only',
      ],
      [
        'AWS::EC2::Route',
        'AWS::EC2::RouteTable',
        'routes',
        'the route table read emits VpcId only',
      ],
      [
        'AWS::EC2::SubnetRouteTableAssociation / SubnetNetworkAclAssociation',
        'AWS::EC2::Subnet / RouteTable / NetworkAcl',
        'associations',
        'none of the three reads emits an association',
      ],
      [
        'AWS::EC2::VPCGatewayAttachment',
        'AWS::EC2::VPC / InternetGateway',
        'attachments',
        'neither read emits an attachment',
      ],
      [
        'AWS::EC2::VPCCidrBlock',
        'AWS::EC2::VPC',
        'CidrBlockAssociations',
        'the VPC read emits the primary CidrBlock only; on Cloud Control the list is read-only (#6485)',
      ],
      [
        'AWS::EC2::NetworkInterfaceAttachment',
        'AWS::EC2::Instance',
        'NetworkInterfaces',
        'the instance read emits no NetworkInterfaces',
      ],
      ['AWS::KMS::Alias', 'AWS::KMS::Key', 'aliases', 'the key read emits no alias'],
      [
        'AWS::SecretsManager::ResourcePolicy / RotationSchedule',
        'AWS::SecretsManager::Secret',
        '-',
        'the secret read emits neither',
      ],
      [
        'AWS::Cognito::UserPoolClient / UserPoolDomain',
        'AWS::Cognito::UserPool',
        '-',
        'the user pool read emits neither',
      ],
      [
        'AWS::Route53::RecordSet',
        'AWS::Route53::HostedZone',
        'records',
        'the hosted zone read emits no records',
      ],
      [
        'AWS::ApiGateway::Method / Resource',
        'AWS::ApiGateway::Resource / RestApi',
        '-',
        'the resource read emits ParentId and PathPart only',
      ],
    ] as const
  ).map(([child, parent, key, evidence]): SiblingWritePair => ({
    child,
    parent,
    key,
    verdict: 'none',
    evidence,
  })),
];

/** For one parent, each row with sibling writes onto it and the members they write (`undefined`: the whole key). */
function ownedByRow(
  resourceType: string,
  physicalId: string | undefined,
  context: ReadCurrentStateContext | undefined
): Array<[SiblingOwnedRow, Set<string> | undefined]> {
  if (typeof physicalId !== 'string' || physicalId === '') return [];
  const out: Array<[SiblingOwnedRow, Set<string> | undefined]> = [];
  for (const row of SIBLING_OWNED_ROWS) {
    if (row.parent !== resourceType) continue;
    const ids = new Set(parentIdsOf(row, physicalId));
    const members = new Set<string>();
    let any = false;
    for (const sibling of Object.values(context?.siblings ?? {})) {
      if (sibling.resourceType !== row.child || !isPlainRecord(sibling.properties)) continue;
      for (const w of row.writes(sibling.properties, sibling.physicalId)) {
        if (!ids.has(w.parent)) continue;
        any = true;
        if (w.member !== undefined) members.add(w.member);
      }
    }
    if (any) out.push([row, row.identity ? members : undefined]);
  }
  return out;
}

/**
 * `owned` minus the members the parent's own `properties` declare under
 * `row.key`: those the parent owns as well, so they stay compared.
 */
function effectiveDrop(
  row: SiblingOwnedRow,
  owned: ReadonlySet<string> | undefined,
  properties: Record<string, unknown> | undefined
): Set<string> {
  const drop = new Set(owned ?? []);
  const identity = row.identity;
  const own = getAt(properties, pathOf(row));
  if (identity === undefined || drop.size === 0 || !Array.isArray(own)) return drop;
  for (const entry of own) {
    const id = identity(entry);
    if (id !== undefined) drop.delete(id);
  }
  return drop;
}

/**
 * `bag` without `row`'s members in `owned` (all of `row.key` for a whole-key
 * row) that the parent's own `properties` do not declare. Returned by identity
 * when nothing is dropped.
 */
function withoutOwned(
  bag: Record<string, unknown>,
  row: SiblingOwnedRow,
  owned: ReadonlySet<string> | undefined,
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  const path = pathOf(row);
  if (!hasAt(bag, path)) return bag;
  const declared = hasAt(properties, path);
  if (row.identity === undefined) return declared ? bag : setAt(bag, path, REMOVE);
  const list = getAt(bag, path);
  if (!Array.isArray(list)) return bag;
  const identity = row.identity;
  const drop = effectiveDrop(row, owned, properties);
  if (drop.size === 0) return bag;
  const kept = list.filter((m) => {
    const id = identity(m);
    return id === undefined || !drop.has(id);
  });
  if (kept.length === list.length) return bag;
  return setAt(bag, path, kept.length === 0 && row.emptyMeansAbsent && !declared ? REMOVE : kept);
}

/**
 * The detection pass: `baseline` and `aws` without every member a SIBLING
 * record of the stack writes onto this resource — the IAM attachment lists
 * (`stripSiblingOwnedMembers`), a security group's inline rules
 * (`stripSiblingOwnedSgRules`) and every {@link SIBLING_OWNED_ROWS} row. A
 * member the resource's own template declares stays compared. Non-mutating;
 * each bag is returned by identity when it has nothing to drop.
 */
export function stripSiblingOwnedParentMembers(
  resourceType: string,
  physicalId: string | undefined,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  const members = stripSiblingOwnedMembers(
    resourceType,
    physicalId,
    baseline,
    aws,
    properties,
    context
  );
  let out = stripSiblingOwnedSgRules(
    resourceType,
    physicalId,
    members.baseline,
    members.aws,
    properties,
    context
  );
  for (const [row, owned] of ownedByRow(resourceType, physicalId, context)) {
    out = {
      baseline: withoutOwned(out.baseline, row, owned, properties),
      aws: withoutOwned(out.aws, row, owned, properties),
    };
  }
  return out;
}

/**
 * The revert pass over the DESIRED bag (the recorded baseline): the members
 * {@link stripSiblingOwnedParentMembers} dropped leave it, and for a
 * {@link SIBLING_OWNED_ROWS} row the LIVE sibling-owned members of `aws` (the
 * raw readback, `update()`'s previous side) come back in. A provider then
 * finds each such member on both sides and neither removes nor re-adds it,
 * whether or not its own readback filtered it. The two older helpers' members
 * need no re-add: their providers' readbacks never carry them.
 */
export function siblingOwnedRevertDesired(
  resourceType: string,
  physicalId: string | undefined,
  desired: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): Record<string, unknown> {
  let out = stripSiblingOwnedMembers(
    resourceType,
    physicalId,
    desired,
    aws,
    properties,
    context
  ).baseline;
  out = stripSiblingOwnedSgRules(resourceType, physicalId, out, aws, properties, context).baseline;
  for (const [row, owned] of ownedByRow(resourceType, physicalId, context)) {
    const path = pathOf(row);
    const stripped = withoutOwned(out, row, owned, properties);
    const live = getAt(aws, path);
    if (row.identity === undefined) {
      // Whole key: it never drifts (both sides drop it), so the overlay sends
      // the live value and the desired bag needs none.
      out = stripped;
      continue;
    }
    const drop = effectiveDrop(row, owned, properties);
    if (!Array.isArray(live) || drop.size === 0) {
      out = stripped;
      continue;
    }
    const identity = row.identity;
    const strippedList = getAt(stripped, path);
    // A list the parent's read omits when empty (`emptyMeansAbsent`) may be
    // absent from the desired bag, removed by the strip or never captured:
    // the live members still go back, into the container the desired bag
    // holds. A desired bag without that container is left alone.
    const kept = Array.isArray(strippedList)
      ? strippedList
      : row.emptyMeansAbsent && strippedList === undefined
        ? []
        : undefined;
    if (kept === undefined || !hasAt(stripped, path.slice(0, -1))) {
      out = stripped;
      continue;
    }
    // Each live sibling-owned member goes back at its live position, so a
    // provider that pairs list items by position sees them where they are.
    const result = [...kept];
    const present = new Set(result.map((m) => identity(m)));
    live.forEach((m, index) => {
      const id = identity(m);
      if (id === undefined || !drop.has(id) || present.has(id)) return;
      result.splice(Math.min(index, result.length), 0, m);
      present.add(id);
    });
    out =
      result.length === kept.length && Array.isArray(strippedList)
        ? stripped
        : setAt(stripped, path, result);
  }
  return out;
}

/** A {@link SIBLING_OWNED_ROWS} key of one record and what to drop from its baseline (`undefined`: the whole key). */
export interface StoppedTableMembers {
  row: SiblingOwnedRow;
  members: Set<string> | undefined;
}

/**
 * go-to-k/cdkd#6610, the {@link SIBLING_OWNED_ROWS} twin of
 * `membersSiblingsStoppedWriting` (go-to-k/cdkd#6343): per logical id of
 * `next`, the members a sibling record wrote onto it before this deploy
 * (`previous`) and no longer writes after it. The deploy's own operation on
 * that sibling (its delete, or its update) has just removed them from AWS, so
 * a parent baseline still holding one would read as lost and `--revert` would
 * put it back. The evidence is the sibling's RECORDED write; a sibling whose
 * previous resource may survive the deploy (`previousMaySurvive`) stopped
 * nothing. In memory only; no AWS call.
 */
export function tableMembersSiblingsStoppedWriting(
  previous: Readonly<Record<string, WriterRecord>>,
  next: Readonly<Record<string, WriterRecord>>,
  oldMaySurvive: (logicalId: string) => boolean = () => false,
  templatePolicies?: TemplatePolicies
): Map<string, StoppedTableMembers[]> {
  const encode = (row: number, parent: string, member: string | undefined): string =>
    injectiveKey(row, parent, member === undefined ? '' : `m:${member}`);
  const writesOf = (record: WriterRecord): Array<[number, SiblingWrite]> => {
    const props = record.properties;
    if (!isPlainRecord(props)) return [];
    const out: Array<[number, SiblingWrite]> = [];
    SIBLING_OWNED_ROWS.forEach((row, index) => {
      if (row.child !== record.resourceType) return;
      for (const w of row.writes(props, record.physicalId)) out.push([index, w]);
    });
    return out;
  };
  const stillWritten = new Set<string>();
  for (const record of Object.values(next)) {
    for (const [i, w] of writesOf(record)) stillWritten.add(encode(i, w.parent, w.member));
  }
  // injectiveKey(row index, parent id) -> members (undefined: whole key)
  const stopped = new Map<string, { row: number; members: Set<string> | undefined }>();
  for (const [logicalId, record] of Object.entries(previous)) {
    const writes = writesOf(record);
    if (writes.length === 0) continue;
    if (previousMaySurvive(logicalId, record, next, oldMaySurvive, templatePolicies)) continue;
    for (const [i, w] of writes) {
      if (stillWritten.has(encode(i, w.parent, w.member))) continue;
      const target = injectiveKey(i, w.parent);
      let entry = stopped.get(target);
      if (entry === undefined) {
        entry = { row: i, members: w.member === undefined ? undefined : new Set() };
        stopped.set(target, entry);
      }
      if (w.member !== undefined) entry.members?.add(w.member);
    }
  }
  const result = new Map<string, StoppedTableMembers[]>();
  if (stopped.size === 0) return result;
  for (const [logicalId, record] of Object.entries(next)) {
    const id = record.physicalId;
    if (typeof id !== 'string' || id === '') continue;
    const entries: StoppedTableMembers[] = [];
    SIBLING_OWNED_ROWS.forEach((row, index) => {
      if (row.parent !== record.resourceType) return;
      // Every id the parent answers to: a sibling still writing under ANY of
      // them (an association replaced by one naming the address the other
      // way) stopped nothing.
      const ids = [...new Set(parentIdsOf(row, id))];
      const written = (member: string | undefined): boolean =>
        ids.some((pid) => stillWritten.has(encode(index, pid, member)));
      let merged: StoppedTableMembers | undefined;
      for (const parentId of ids) {
        const entry = stopped.get(injectiveKey(index, parentId));
        if (entry === undefined) continue;
        if (entry.members === undefined) {
          if (!written(undefined)) merged = { row, members: undefined };
          continue;
        }
        if (merged !== undefined && merged.members === undefined) continue;
        for (const m of entry.members) {
          if (written(m)) continue;
          merged ??= { row, members: new Set() };
          merged.members!.add(m);
        }
      }
      if (merged !== undefined) entries.push(merged);
    });
    if (entries.length > 0) result.set(logicalId, entries);
  }
  return result;
}

/**
 * `bag` without the {@link tableMembersSiblingsStoppedWriting} members the
 * resource's own `properties` do not declare. A whole-key LIST is left EMPTY
 * (`[]`), what the parent reads once its writer is gone; a whole-key scalar
 * (an EIP's `InstanceId`) leaves the bag, as a read of an unassociated address
 * omits it. Returned by identity when nothing changes.
 */
export function withoutStoppedTableMembers(
  bag: Record<string, unknown>,
  stopped: readonly StoppedTableMembers[],
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  let out = bag;
  for (const { row, members } of stopped) {
    if (row.identity !== undefined) {
      out = withoutOwned(out, row, members, properties);
      continue;
    }
    const path = pathOf(row);
    const value = getAt(out, path);
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    if (hasAt(properties, path)) continue;
    out = setAt(out, path, Array.isArray(value) ? [] : REMOVE);
  }
  return out;
}
