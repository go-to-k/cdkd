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
];

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
