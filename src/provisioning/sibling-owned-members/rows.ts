/**
 * go-to-k/cdkd#6610: the rows of `../sibling-owned-members.ts` — one per
 * colliding (child, parent, key) pair — and the per-pair write and identity
 * readers they use. See that module's comment for what a row does.
 */
import { isRedactedRecordedValue } from '../redacted-delete-address.js';

/** One write a child record makes onto a parent: the parent's physical id, and the member's identity (absent: the whole key). */
export interface SiblingWrite {
  parent: string;
  member?: string;
}

/** One colliding (child, parent, key) pair handled by this module. */
export interface SiblingOwnedRow {
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
  /**
   * A list element's NAME, for a row whose identity carries more than it
   * (an inline policy's document). A baseline member whose name a sibling
   * writes leaves the baseline by name alone when the readback holds no member
   * of that name: the parent's own readback already dropped it by name.
   */
  nameOf?: (element: unknown) => string | undefined;
  /** The NAME inside a member identity this row's `identity` built (the inverse half of `nameOf`). */
  memberName?: (member: string) => string | undefined;
}

/** How many times each member identity is written (a multiset). */
export type MemberCounts = ReadonlyMap<string, number>;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
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
 * cluster after `cluster/`. The cluster's physical id is its name. The ARN's
 * account and region are not matched: the association is a record of the
 * SAME stack (one account and region), and ECS refuses an association whose
 * cluster is in another account or region, so its name alone names the cluster.
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
function inlinePolicyName(element: unknown): string | undefined {
  return isPlainRecord(element) ? plainString(element['PolicyName']) : undefined;
}

/** The policy name inside an {@link inlinePolicyIdentity}, which encodes `[name, document]`. */
function inlinePolicyMemberName(member: string): string | undefined {
  try {
    const name = (JSON.parse(member) as unknown[])[0];
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

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

/** An instance attachment's write onto its instance: the attached volume or interface id. */
function instanceAttachmentWrites(idField: 'VolumeId' | 'NetworkInterfaceId') {
  return (properties: Record<string, unknown>): SiblingWrite[] => {
    const instance = plainString(properties['InstanceId']);
    const member = plainString(properties[idField]);
    return instance === undefined || member === undefined ? [] : [{ parent: instance, member }];
  };
}

function instanceAttachmentIdentity(idField: 'VolumeId' | 'NetworkInterfaceId') {
  return (element: unknown): string | undefined =>
    isPlainRecord(element) ? plainString(element[idField]) : undefined;
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
  // An instance's SDK read emits neither list (`VolumeAttachment`'s devices
  // are `BlockDeviceMappings`, #6384); a Cloud Control read returns the
  // attached volumes and interfaces in `Volumes` / `NetworkInterfaces`.
  {
    child: 'AWS::EC2::VolumeAttachment',
    parent: 'AWS::EC2::Instance',
    key: 'Volumes',
    writes: instanceAttachmentWrites('VolumeId'),
    identity: instanceAttachmentIdentity('VolumeId'),
  },
  {
    child: 'AWS::EC2::NetworkInterfaceAttachment',
    parent: 'AWS::EC2::Instance',
    key: 'NetworkInterfaces',
    writes: instanceAttachmentWrites('NetworkInterfaceId'),
    identity: instanceAttachmentIdentity('NetworkInterfaceId'),
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
      nameOf: inlinePolicyName,
      memberName: inlinePolicyMemberName,
    },
    {
      child: standalone,
      parent,
      key: 'Policies',
      writes: standalonePolicyWrites(nameField),
      identity: inlinePolicyIdentity,
      nameOf: inlinePolicyName,
      memberName: inlinePolicyMemberName,
    },
  ]),
];
