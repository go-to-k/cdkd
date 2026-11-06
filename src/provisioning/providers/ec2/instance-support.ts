import {
  type Instance,
  type HostnameType,
  type PrivateDnsNameOptionsRequest,
  type LaunchTemplateSpecification,
} from '@aws-sdk/client-ec2';
import { dynamicReferenceTokens, SECRET_MASK } from '../../../deployment/secret-redaction.js';
import { coerceCfnBoolean, configBooleanRefusal, configStringRefusal } from '../../config-shape.js';
import { definedAttributes } from '../../attribute-map.js';
import { isSettledInstanceState } from '../../ec2-instance-state.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { markRefusedBeforeApplying } from '../../../deployment/prior-attempt-scope.js';

/**
 * Issue #5446: the stop / start waits of an in-place InstanceType / UserData
 * change. The resource deadline bounds them first; this cap applies only
 * outside one. A t3 stop or start measured about a minute.
 */
export const INSTANCE_STATE_WAIT_CAP_MS = 15 * 60 * 1000;
export const INSTANCE_STATE_POLL_MS = 5000;
/**
 * go-to-k/cdkd#5630: the attach / detach waits of `AWS::EC2::Instance
 * Volumes`, capped like the stop / start waits outside a resource deadline.
 * CloudFormation's own attach and detach updates took 10-20 s (measured).
 */
export const VOLUME_ATTACHMENT_WAIT_CAP_MS = 10 * 60 * 1000;
export const VOLUME_ATTACHMENT_POLL_MS = 2000;
/**
 * go-to-k/cdkd#5630: how long CreateAssociation is retried while Systems
 * Manager does not yet see the instance's IAM role (cdkd launches and
 * associates the profile faster than CloudFormation does). The resource
 * deadline bounds it first; this cap applies only outside one.
 */
export const SSM_ASSOCIATION_ROLE_WAIT_CAP_MS = 5 * 60 * 1000;
export const SSM_ASSOCIATION_ROLE_POLL_MS = 3000;
/** Consecutive reads with no attachment after AttachVolume that fail the wait. */
export const VOLUME_ATTACHMENT_NONE_READS = 15;
/** `DescribeVolumes`'s answer for a volume id EC2 no longer lists. */
export const VOLUME_NOT_FOUND_NAMES: ReadonlySet<string> = new Set(['InvalidVolume.NotFound']);
/**
 * Consecutive `stopped` reads after a StartInstances that count as AWS undoing
 * the start (issue #5446): StartInstances answers `pending` at once, so a
 * `stopped` that outlives three polls is not a lagging read.
 */
export const STOPPED_AFTER_START_READS = 3;
/** How long a profile change waits out a `disassociating` association. */
export const PROFILE_DISASSOCIATING_POLLS = 15;
export const PROFILE_DISASSOCIATING_DELAY_MS = 2000;

/**
 * A refusal raised before any call of an EC2 Instance update (issue #5446):
 * non-retryable, and marked so the engine journals the failed update without
 * its attempted properties (a later `rollback --revert-failed` then has
 * nothing to "undo" on an instance this update never touched).
 */
export function refusedBeforeApplying<E extends Error>(error: E): E {
  return markRefusedBeforeApplying(markNonRetryable(error));
}
/** The states a stop -> modify -> start can begin from (issue #5446). */
export const STOPPABLE_INSTANCE_STATES = new Set(['pending', 'running', 'stopping', 'stopped']);
/**
 * Instances THIS process stopped and could not start again (issue #5446).
 * The rollback revert that follows the failed update reads them `stopped`;
 * this tells it the stop was cdkd's, so it starts them again as
 * CloudFormation's rollback does, instead of leaving a user-stopped one alone.
 */
export const instancesLeftStoppedByCdkd = new Set<string>();
/** The wait errors that mean AWS stopped an instance right after cdkd's start. */
export const instanceStoppedAfterStart = new WeakSet<object>();

/** What `EC2Provider.planInstanceMemberUpdates` decided to apply (issue #5446). */
export interface InstanceMemberPlan {
  instanceType?: string;
  /** Raw user-data bytes; empty for a removed UserData. */
  userData?: Uint8Array;
  profile?: { kind: 'set'; arn?: string; name?: string } | { kind: 'remove' };
  /** `vpc-default` is resolved to a `set` by `prepareInstanceMemberUpdates`. */
  securityGroups?: { kind: 'set'; ids: string[] } | { kind: 'vpc-default' };
  deleteOnTermination?: Array<{ DeviceName: string; DeleteOnTermination: boolean }>;
  /** go-to-k/cdkd#5630: in place, no stop. */
  shutdownBehavior?: string;
  /** go-to-k/cdkd#5630: in place, no stop; `true` for a removal. */
  sourceDestCheck?: boolean;
  /**
   * go-to-k/cdkd#5630: a Tenancy the template declares and the record lacks.
   * `prepareInstanceMemberUpdates` compares it with the live tenancy; nothing
   * is ever sent for it.
   */
  tenancyAddition?: { value: string; replaying: boolean };
  /**
   * go-to-k/cdkd#5630: the ModifyPrivateDnsNameOptions members that changed.
   * A `PrivateDnsHostnameType` needs a stopped instance (CloudFormation stops
   * and starts it); `prepareInstanceMemberUpdates` drops it when the live
   * instance already has it.
   */
  privateDnsNameOptions?: {
    PrivateDnsHostnameType?: HostnameType;
    EnableResourceNameDnsARecord?: boolean;
    EnableResourceNameDnsAAAARecord?: boolean;
  };
  /**
   * go-to-k/cdkd#5630: the `Volumes` entries to detach, then attach, in
   * place (a Device change is both).
   */
  volumes?: { detach: InstanceVolume[]; attach: InstanceVolume[] };
  /**
   * go-to-k/cdkd#5630: an `SsmAssociations` change, applied in place by
   * `applyInstanceSsmAssociationChange`: the instance's association is
   * deleted when the record held one, then the desired one is created.
   * `documentNames` narrows the delete to the recorded documents; `undefined`
   * (an unusable record) deletes any instance-id association of the instance.
   */
  ssmAssociation?: {
    deleteExisting: boolean;
    documentNames: string[] | undefined;
    create: InstanceSsmAssociation | undefined;
  };
}

/**
 * go-to-k/cdkd#5630: the members of an update that need a stopped instance,
 * in the order the messages name them.
 */
export function instanceStopMembers(plan: InstanceMemberPlan): string[] {
  return [
    plan.instanceType !== undefined ? 'InstanceType' : '',
    plan.userData !== undefined ? 'UserData' : '',
    plan.privateDnsNameOptions?.PrivateDnsHostnameType !== undefined
      ? 'PrivateDnsNameOptions.HostnameType'
      : '',
  ].filter(Boolean);
}

/**
 * A recorded stand-in for a value cdkd resolved and sent: a string carrying a
 * `{{resolve:...}}` token, or the state redaction mask (issue #5446). A state
 * record (a rollback revert's desired bag) holds these where the template had
 * a secret; sending one would write the stand-in onto the instance.
 */
export function isRecordedStandIn(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isRecordedStandIn);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(isRecordedStandIn);
  }
  return (
    typeof value === 'string' && (value === SECRET_MASK || dynamicReferenceTokens(value).length > 0)
  );
}

/**
 * An instance profile's comparison key: its NAME, from a name, an ARN
 * (`arn:...:instance-profile[/path]/<name>`) or an `{Arn,Name}` object. State
 * carries the template's name while a drift readback carries the ARN.
 */
export function instanceProfileKey(value: unknown): string | undefined {
  const fromArn = (arn: string): string => arn.slice(arn.lastIndexOf('/') + 1);
  if (typeof value === 'string') {
    const v = value.trim();
    if (v === '') return undefined;
    return v.startsWith('arn:') ? fromArn(v) : v;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['Name'] === 'string' && obj['Name'] !== '') return obj['Name'];
    if (typeof obj['Arn'] === 'string' && obj['Arn'] !== '') return fromArn(obj['Arn']);
  }
  return undefined;
}

/** Two lists of strings hold the same members, order and repeats aside. */
export function sameStringSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  const sa = new Set(a.map(String));
  const sb = new Set(b.map(String));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/**
 * AWS EC2 Networking Provider
 *
 * Implements resource provisioning for EC2 networking resources:
 * - AWS::EC2::VPC
 * - AWS::EC2::Subnet
 * - AWS::EC2::InternetGateway
 * - AWS::EC2::VPCGatewayAttachment
 * - AWS::EC2::RouteTable
 * - AWS::EC2::Route
 * - AWS::EC2::SubnetRouteTableAssociation
 * - AWS::EC2::SecurityGroup
 * - AWS::EC2::SecurityGroupIngress
 * - AWS::EC2::Instance
 */
/**
 * The `AWS::EC2::Instance` attribute map for a `DescribeInstances` read-back,
 * shared by `createInstance` and `updateInstance` so the two cannot answer
 * the same instance differently (issue #3077).
 *
 * The map distinguishes UNKNOWN from KNOWN-EMPTY, and the instance STATE is
 * what tells them apart:
 *
 *  - `pending` (a `--no-wait` create, or an update racing one): the private
 *    address, private DNS name and AZ are assigned at launch and are recorded
 *    when present; the PUBLIC pair may simply not exist yet — the API
 *    reports `PublicDnsName: ''` and no `PublicIpAddress` in that window — so
 *    an empty or absent public member is UNKNOWN and its key is OMITTED. A
 *    persisted `''` would shadow the resolver's live re-read for the life of
 *    the record (the defect the issue reports); an absent key sends the next
 *    `Fn::GetAtt` back to AWS.
 *  - any settled state (`running`, `stopped`, ...): what AWS reports IS the
 *    answer. A running instance in a private subnet is described exactly like
 *    the pending window above — `PublicDnsName: ''`, no `PublicIpAddress` —
 *    and CloudFormation answers `''` for both attributes, so the pair is
 *    recorded as the known empty string rather than omitted: omitted, every
 *    resolution would take the live arm, find nothing, and degrade to the
 *    instance id with a warning, permanently, on an ordinary private-subnet
 *    stack (review of the first cut).
 *  - no `State` at all (a read-back that returned no instance, or a shape
 *    without one): treated like `pending` — whatever members are present are
 *    recorded, and an empty or absent public member is omitted, since nothing
 *    says the instance has settled.
 *
 * `definedAttributes` then drops the `undefined` members; it keeps `''`, so the
 * pending-window normalization has to happen HERE, where the state is known.
 *
 * What follows from the pending rule: a `--no-wait` create of an instance in
 * a PRIVATE subnet omits the public pair, and nothing later writes it -- a
 * no-change deploy's auto-refresh touches `observedProperties`, never
 * `attributes` -- so `Fn::GetAtt [.., PublicIp]` takes the resolver's live arm
 * on every resolution. That arm applies THIS SAME three-state rule at read
 * time (issue #3096): a settled instance's missing public member resolves to
 * the known `''`, while a still-`pending` one is REFUSED rather than degraded
 * to the instance id, and nothing is cached so the next deploy re-reads.
 */
export function describedInstanceAttributes(
  instanceId: string,
  instance: Instance | undefined
): Record<string, unknown> {
  const stateName = instance?.State?.Name;
  const settled = isSettledInstanceState(stateName);
  // A settled instance's public member: reported value, or the known empty.
  // A pending one's: reported non-empty value, or unknown.
  const publicMember = (value: string | undefined): string | undefined =>
    settled ? (value ?? '') : value || undefined;
  return definedAttributes({
    InstanceId: instanceId,
    PrivateIp: instance?.PrivateIpAddress,
    PublicIp: publicMember(instance?.PublicIpAddress),
    PrivateDnsName: instance?.PrivateDnsName,
    PublicDnsName: publicMember(instance?.PublicDnsName),
    AvailabilityZone: instance?.Placement?.AvailabilityZone,
  });
}
// go-to-k/cdkd#5630: `PlacementGroupName` / `PrivateIpAddress` are create-only
// in the schema too. `Tenancy` replaces only on some changes and is planned on
// its own (`planInstanceMemberUpdates`).
export const INSTANCE_CREATE_ONLY_SENT = [
  'CpuOptions',
  'HibernationOptions',
  'PlacementGroupName',
  'PrivateIpAddress',
  // go-to-k/cdkd#5630: create-only in the schema.
  'Ipv6AddressCount',
  'Ipv6Addresses',
  // go-to-k/cdkd#5630: create-only in the schema; CloudFormation measured
  // (us-east-1, 2026-11-06): a Version change creates a new instance.
  'LaunchTemplate',
  // go-to-k/cdkd#5630: create-only in the schema; CloudFormation measured
  // (us-east-1): adding, changing or removing an entry creates a new instance.
  'LicenseSpecifications',
];

/**
 * go-to-k/cdkd#5630: the refusal for a malformed `AWS::EC2::Instance
 * LicenseSpecifications` (a list of `{ LicenseConfigurationArn }`, the member
 * required by the schema), so the launch never drops a license configuration
 * the template declared.
 */
export function instanceLicenseSpecificationsRefusal(
  value: unknown,
  resourceType: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    // The shape only, never the value: a template string may be a resolved secret.
    const shape = typeof value === 'object' ? 'an object' : `a ${typeof value}`;
    return `${resourceType}.LicenseSpecifications must be a list of { LicenseConfigurationArn } entries (got ${shape})`;
  }
  for (const [i, item] of (value as unknown[]).entries()) {
    const path = `${resourceType}.LicenseSpecifications[${i}]`;
    const refusal =
      item === undefined || item === null
        ? `${path} must be an object (got ${item === null ? 'null' : 'undefined'})`
        : configStringRefusal(item, 'LicenseConfigurationArn', '', path);
    if (refusal !== undefined) return refusal;
    const arn = (item as Record<string, unknown>)['LicenseConfigurationArn'];
    if (typeof arn !== 'string' || arn === '') return `${path}.LicenseConfigurationArn is required`;
  }
  return undefined;
}

/**
 * go-to-k/cdkd#5630: `LicenseSpecifications` as RunInstances takes it (the
 * member names match), or `undefined` for an absent list. Call it only after
 * {@link instanceLicenseSpecificationsRefusal} passed.
 */
export function licenseSpecificationsRequest(
  value: unknown
): Array<{ LicenseConfigurationArn: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => ({
    LicenseConfigurationArn: (v as Record<string, unknown>)['LicenseConfigurationArn'] as string,
  }));
}

/**
 * go-to-k/cdkd#5630: one `AWS::EC2::Instance SsmAssociations` entry, its
 * `AssociationParameters` as the `Parameters` map CreateAssociation takes.
 * `parameterKeys` keeps the declared order (the drift readback emits the
 * parameters in it); `declaresParameters` whether the entry named the list.
 */
export interface InstanceSsmAssociation {
  DocumentName: string;
  Parameters: Record<string, string[]>;
  parameterKeys: string[];
  declaresParameters: boolean;
}

/**
 * go-to-k/cdkd#5630: the refusal for a malformed `AWS::EC2::Instance
 * SsmAssociations` (a list of `{ DocumentName, AssociationParameters? }`, each
 * parameter a `{ Key, Value: [string] }`). It runs on every path, a rollback
 * replay too: the update deletes the association the desired list lacks, so a
 * list read as empty would delete it. The messages name shapes and keys,
 * never a parameter VALUE: CloudTrail withholds those as sensitive, and a
 * template may resolve a secret into one.
 */
export function instanceSsmAssociationsRefusal(
  value: unknown,
  resourceType: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const shapeOf = (v: unknown): string =>
    v === null
      ? 'null'
      : Array.isArray(v)
        ? 'a list'
        : typeof v === 'object'
          ? 'an object'
          : `a ${typeof v}`;
  if (!Array.isArray(value)) {
    return `${resourceType}.SsmAssociations must be a list of { DocumentName, AssociationParameters } entries (got ${shapeOf(value)})`;
  }
  for (const [i, item] of (value as unknown[]).entries()) {
    const path = `${resourceType}.SsmAssociations[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return `${path} must be an object (got ${item === undefined ? 'undefined' : shapeOf(item)})`;
    }
    const entry = item as Record<string, unknown>;
    const name = entry['DocumentName'];
    if (typeof name !== 'string' || name === '') {
      return name === undefined || name === ''
        ? `${path}.DocumentName is required`
        : `${path}.DocumentName must be a string (got ${shapeOf(name)})`;
    }
    const params = entry['AssociationParameters'];
    if (params === undefined || params === null) continue;
    if (!Array.isArray(params)) {
      return `${path}.AssociationParameters must be a list of { Key, Value } entries (got ${shapeOf(params)})`;
    }
    const seen = new Set<string>();
    for (const [j, param] of (params as unknown[]).entries()) {
      const ppath = `${path}.AssociationParameters[${j}]`;
      if (param === null || typeof param !== 'object' || Array.isArray(param)) {
        return `${ppath} must be an object (got ${param === undefined ? 'undefined' : shapeOf(param)})`;
      }
      const key = (param as Record<string, unknown>)['Key'];
      if (typeof key !== 'string' || key === '') return `${ppath}.Key is required`;
      if (seen.has(key)) return `${ppath} declares the Key ${key} a second time`;
      seen.add(key);
      const values = (param as Record<string, unknown>)['Value'];
      if (!Array.isArray(values)) {
        return `${ppath}.Value must be a list of strings (got ${values === undefined ? 'undefined' : shapeOf(values)})`;
      }
      for (const [k, v] of (values as unknown[]).entries()) {
        if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) {
          return `${ppath}.Value[${k}] must be a string (got ${v === undefined ? 'undefined' : shapeOf(v)})`;
        }
      }
    }
  }
  return undefined;
}

/**
 * go-to-k/cdkd#5630: the `SsmAssociations` entries, or `[]` for an absent
 * list. A numeric parameter value is sent as the string SSM takes, as
 * CloudFormation coerces a scalar. Call it only on a value
 * {@link instanceSsmAssociationsRefusal} passed.
 */
export function instanceSsmAssociationEntries(value: unknown): InstanceSsmAssociation[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const entry = v as Record<string, unknown>;
    const params = Array.isArray(entry['AssociationParameters'])
      ? (entry['AssociationParameters'] as Array<Record<string, unknown>>)
      : [];
    const Parameters: Record<string, string[]> = {};
    for (const p of params) {
      Parameters[p['Key'] as string] = (p['Value'] as unknown[]).map((x) => String(x));
    }
    return {
      DocumentName: entry['DocumentName'] as string,
      Parameters,
      parameterKeys: params.map((p) => p['Key'] as string),
      declaresParameters: Array.isArray(entry['AssociationParameters']),
    };
  });
}

/** An SSM document's name, from a name or an ARN (`arn:...:document/<name>`). */
export function ssmDocumentName(nameOrArn: string): string {
  return nameOrArn.startsWith('arn:') ? nameOrArn.slice(nameOrArn.lastIndexOf('/') + 1) : nameOrArn;
}

/**
 * go-to-k/cdkd#5630: whether two `SsmAssociations` values associate the same
 * documents with the same parameters (parameter order aside; the order of a
 * parameter's values counts). An unusable side is never the same.
 */
export function sameSsmAssociations(a: unknown, b: unknown, resourceType: string): boolean {
  if (
    instanceSsmAssociationsRefusal(a, resourceType) !== undefined ||
    instanceSsmAssociationsRefusal(b, resourceType) !== undefined
  ) {
    return false;
  }
  const left = instanceSsmAssociationEntries(a);
  const right = instanceSsmAssociationEntries(b);
  if (left.length !== right.length) return false;
  return left.every((l, i) => {
    const r = right[i]!;
    if (ssmDocumentName(l.DocumentName) !== ssmDocumentName(r.DocumentName)) return false;
    const lk = Object.keys(l.Parameters).sort();
    const rk = Object.keys(r.Parameters).sort();
    return (
      lk.length === rk.length &&
      lk.every((k, j) => k === rk[j] && sameOrderedStrings(l.Parameters[k]!, r.Parameters[k]!))
    );
  });
}

function sameOrderedStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * go-to-k/cdkd#5630: an `SsmAssociations` EC2 and Systems Manager refuse
 * every time, so CloudFormation fails the create before RunInstances
 * (measured us-east-1): two or more entries, or an entry on an instance with
 * no `IamInstanceProfile`. Refused before any call on every path, a rollback
 * replay included, since the replay could not succeed either.
 */
export function ssmAssociationsAwsRefusal(
  properties: Record<string, unknown>,
  resourceType: string
): string | undefined {
  const entries = instanceSsmAssociationEntries(properties['SsmAssociations']);
  if (entries.length > 1) {
    return `${resourceType}.SsmAssociations declares ${entries.length} documents, and an instance takes at most one ("Currently, multiple documents cannot be associated with one instance", which CloudFormation refuses too). Declare a single entry`;
  }
  const profile = properties['IamInstanceProfile'];
  const hasProfile =
    (typeof profile === 'string' && profile.trim() !== '') ||
    (profile !== null && typeof profile === 'object');
  if (entries.length === 1 && !hasProfile) {
    return `${resourceType}.SsmAssociations needs an IamInstanceProfile: Systems Manager associates a document only with an instance that has an IAM role ("Before you can associate a document with the instance, you must associate an IAM role", which CloudFormation refuses too). Declare an IamInstanceProfile`;
  }
  return undefined;
}

/**
 * go-to-k/cdkd#5630: the refusal for a malformed `AWS::EC2::Instance
 * LaunchTemplate`, so the launch never drops the template it names. EC2
 * refuses a specification naming neither an id nor a name.
 */
export function instanceLaunchTemplateRefusal(
  value: unknown,
  resourceType: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const path = `${resourceType}.LaunchTemplate`;
  const refusal =
    configStringRefusal(value, 'LaunchTemplateId', '', path) ??
    configStringRefusal(value, 'LaunchTemplateName', '', path) ??
    configStringRefusal(value, 'Version', '', path, { coerceNumber: true });
  if (refusal !== undefined) return refusal;
  const block = value as Record<string, unknown>;
  const named = (key: string): boolean => typeof block[key] === 'string' && block[key] !== '';
  if (!named('LaunchTemplateId') && !named('LaunchTemplateName')) {
    return `${path} must name a LaunchTemplateId or a LaunchTemplateName`;
  }
  return undefined;
}

/**
 * go-to-k/cdkd#5630: `LaunchTemplate` as RunInstances takes it (the member
 * names match; a numeric Version is sent as the string EC2 takes), or
 * `undefined` for an absent block. Call it only after
 * {@link instanceLaunchTemplateRefusal} passed.
 */
export function launchTemplateRequest(value: unknown): LaunchTemplateSpecification | undefined {
  if (value === undefined || value === null) return undefined;
  const block = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const v = block[key];
    if (typeof v === 'number') return String(v);
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const id = text('LaunchTemplateId');
  const name = text('LaunchTemplateName');
  const version = text('Version');
  return {
    ...(id !== undefined && { LaunchTemplateId: id }),
    ...(name !== undefined && { LaunchTemplateName: name }),
    ...(version !== undefined && { Version: version }),
  };
}

/** go-to-k/cdkd#5630: one `AWS::EC2::Instance Volumes` entry. */
export interface InstanceVolume {
  Device: string;
  VolumeId: string;
}

/**
 * go-to-k/cdkd#5630: the refusal for a malformed `AWS::EC2::Instance Volumes`
 * (a list of `{ Device, VolumeId }`, both required by the schema). It runs on
 * every path, a rollback replay too: the update detaches what the desired list
 * lacks, so a list read as empty would detach every volume.
 */
export function instanceVolumesRefusal(value: unknown, resourceType: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    // The shape only, never the value: a template string may be a resolved secret.
    const shape = typeof value === 'object' ? 'an object' : `a ${typeof value}`;
    return `${resourceType}.Volumes must be a list of { Device, VolumeId } entries (got ${shape})`;
  }
  for (const [i, item] of (value as unknown[]).entries()) {
    const path = `${resourceType}.Volumes[${i}]`;
    if (item === undefined || item === null) {
      return `${path} must be an object (got ${item === null ? 'null' : 'undefined'})`;
    }
    for (const key of ['Device', 'VolumeId']) {
      const refusal = configStringRefusal(item, key, '', path);
      if (refusal !== undefined) return refusal;
      const member = (item as Record<string, unknown>)[key];
      if (typeof member !== 'string' || member === '') return `${path}.${key} is required`;
    }
  }
  return undefined;
}

/**
 * go-to-k/cdkd#5630: the `Volumes` entries, or `[]` for an absent list. Call it
 * only on a value {@link instanceVolumesRefusal} passed.
 */
export function instanceVolumeEntries(value: unknown): InstanceVolume[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const entry = v as Record<string, unknown>;
    return { Device: entry['Device'] as string, VolumeId: entry['VolumeId'] as string };
  });
}

/** Whether `list` holds the same `{ Device, VolumeId }` pair as `entry`. */
export function holdsVolume(list: readonly InstanceVolume[], entry: InstanceVolume): boolean {
  return list.some((v) => v.Device === entry.Device && v.VolumeId === entry.VolumeId);
}

/**
 * go-to-k/cdkd#5630: the refusal for a malformed `AWS::EC2::Instance
 * Ipv6Addresses` (a list of `{ Ipv6Address }`, the member required by the
 * schema), so the launch never drops an address the template declared.
 */
export function instanceIpv6AddressesRefusal(
  value: unknown,
  resourceType: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    // The shape only, never the value: a template string may be a resolved secret.
    const shape = typeof value === 'object' ? 'an object' : `a ${typeof value}`;
    return `${resourceType}.Ipv6Addresses must be a list of { Ipv6Address } entries (got ${shape})`;
  }
  for (const [i, item] of (value as unknown[]).entries()) {
    const path = `${resourceType}.Ipv6Addresses[${i}]`;
    const refusal =
      item === undefined || item === null
        ? `${path} must be an object (got ${item === null ? 'null' : 'undefined'})`
        : configStringRefusal(item, 'Ipv6Address', '', path);
    if (refusal !== undefined) return refusal;
    const address = (item as Record<string, unknown>)['Ipv6Address'];
    if (typeof address !== 'string' || address === '') {
      return `${path}.Ipv6Address is required (the address to assign)`;
    }
  }
  return undefined;
}

/**
 * go-to-k/cdkd#5630: the refusal for a malformed `AWS::EC2::Instance
 * PrivateDnsNameOptions`. Shared by the launch and the update, so neither
 * drops a member the template declared.
 */
export function privateDnsNameOptionsRefusal(
  value: unknown,
  resourceType: string
): string | undefined {
  const path = `${resourceType}.PrivateDnsNameOptions`;
  // A blank HostnameType would be dropped from the request and the launch
  // would take the subnet's default, so it is refused like a malformed one.
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['HostnameType'] === ''
  ) {
    return `${path}.HostnameType must not be empty`;
  }
  return (
    configStringRefusal(value, 'HostnameType', '', path) ??
    configBooleanRefusal(value, 'EnableResourceNameDnsARecord', path) ??
    configBooleanRefusal(value, 'EnableResourceNameDnsAAAARecord', path)
  );
}

/**
 * go-to-k/cdkd#5630: `PrivateDnsNameOptions` as RunInstances takes it (the
 * member names match), or `undefined` for an absent block. Call it only after
 * {@link privateDnsNameOptionsRefusal} passed.
 */
export function privateDnsNameOptionsRequest(
  value: unknown
): PrivateDnsNameOptionsRequest | undefined {
  if (value === undefined || value === null) return undefined;
  const block = value as Record<string, unknown>;
  const hostnameType = block['HostnameType'];
  const aRecord = coerceCfnBoolean(block['EnableResourceNameDnsARecord']);
  const aaaaRecord = coerceCfnBoolean(block['EnableResourceNameDnsAAAARecord']);
  return {
    ...(typeof hostnameType === 'string' &&
      hostnameType !== '' && { HostnameType: hostnameType as HostnameType }),
    ...(aRecord !== undefined && { EnableResourceNameDnsARecord: aRecord }),
    ...(aaaaRecord !== undefined && { EnableResourceNameDnsAAAARecord: aaaaRecord }),
  };
}
