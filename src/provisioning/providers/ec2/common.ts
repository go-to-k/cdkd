import { isDeepStrictEqual } from 'node:util';
import { describeAwsFailure, type AwsFailureText } from '../../../utils/aws-failure-text.js';
import { coerceCfnBoolean, coerceCfnInteger } from '../../config-shape.js';
import { type CfnTagEntry } from '../../tag-list.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';
import { type MaskerFn } from '../../masked-retry-logger.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import { relayedNameCollision } from '../../../deployment/retryable-errors.js';
import { tagListsMatch } from './sg-support.js';

/** EC2's own not-found answer: an error code of the `<Thing>.NotFound` shape. */
export function isEc2NotFoundCode(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.endsWith('.NotFound');
}

/** Whether `error` carries one of `names` as its EC2 error code. */
export function isNamedError(error: unknown, names: ReadonlySet<string>): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && names.has(name);
}
/** `DescribeAddresses`'s answer for an allocation id EC2 no longer holds. */
export const EIP_ALLOCATION_NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  'InvalidAllocationID.NotFound',
]);

/** `DescribeInstances`'s answer for an instance id EC2 no longer lists. */
export const INSTANCE_NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  'InvalidInstanceID.NotFound',
]);
/**
 * go-to-k/cdkd#5630: attempts `whileLaunchedInstanceNotVisible` gives a call
 * on a just-launched instance (delays 1, 2, 4, 8, 8, 8, 8 s: ~39s in all).
 */
export const LAUNCHED_INSTANCE_VISIBILITY_ATTEMPTS = 8;
/** `DescribeVpcs`'s answer for a VPC id EC2 no longer lists. */
export const VPC_NOT_FOUND_NAMES: ReadonlySet<string> = new Set(['InvalidVpcID.NotFound']);
export const IPAM_POOL_NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  'InvalidIpamPoolId.NotFound',
]);
/** `DescribeSubnets`'s answer for a subnet id EC2 no longer lists. */
export const SUBNET_NOT_FOUND_NAMES: ReadonlySet<string> = new Set(['InvalidSubnetID.NotFound']);
/** `DescribeSecurityGroups`'s answer for a group id EC2 no longer lists. */
export const SECURITY_GROUP_NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  'InvalidGroup.NotFound',
]);

export const NAT_GATEWAY_ID_PATTERN = /^nat-[0-9a-f]+$/;
const EIP_ALLOCATION_ID_PATTERN = /^eipalloc-[0-9a-f]+$/;
export const INSTANCE_ID_PATTERN = /^i-[0-9a-f]+$/;
export const VPC_ID_PATTERN = /^vpc-[0-9a-f]+$/;
export const SUBNET_ID_PATTERN = /^subnet-[0-9a-f]+$/;
export const SECURITY_GROUP_ID_PATTERN = /^sg-[0-9a-f]+$/;

/**
 * go-to-k/cdkd#4606: a physical id's identity when it is the AWS-generated
 * id `pattern` matches (a NAT gateway's `nat-…`, an instance's `i-…`, a
 * VPC's `vpc-…`, a subnet's `subnet-…`, a security group's `sg-…`), or
 * `undefined` for any other form.
 */
export function generatedIdIdentity(pattern: RegExp, physicalId: string): string | undefined {
  return pattern.test(physicalId) ? physicalId : undefined;
}

/**
 * go-to-k/cdkd#4606: the allocation id an Elastic IP physical id carries —
 * the composite `PublicIp|AllocationId` or a bare allocation id — or
 * `undefined` for any other form (a bare public IP included).
 */
export function eipAllocationIdentity(physicalId: string): string | undefined {
  const segments = physicalId.split('|');
  const allocationId =
    segments.length === 1 ? segments[0] : segments.length === 2 ? segments[1] : undefined;
  return allocationId !== undefined && EIP_ALLOCATION_ID_PATTERN.test(allocationId)
    ? allocationId
    : undefined;
}

/*
 * Issue #2080 (Plan B): `CreateVpc`, `CreateSubnet`, `CreateInternetGateway`,
 * `AllocateAddress` and `CreateSecurityGroup` carry no idempotency token (no
 * `ClientToken` member on their `@aws-sdk/client-ec2` requests), so a 5xx
 * whose request EC2 completed used to be replayed -- by the SDK inside one
 * `send`, invisibly, or by the engine's retry. All five now go through
 * `EC2Provider.getCreateClient`, which refuses the SDK's 5xx retry.
 *
 * A replayed VPC, internet gateway or Elastic IP is a SECOND resource, so an
 * ambiguous failure arms a latch and the next attempt REPORTS candidates
 * before creating again (`orphan-report.ts`; detection only). A replayed
 * subnet or security group COLLIDES instead -- a subnet CIDR cannot repeat in
 * its VPC (`InvalidSubnet.Conflict`), a group name cannot repeat in its VPC
 * (`InvalidGroup.Duplicate`) -- and the surfaced 5xx lets `withRetry` mark
 * that collision as possibly this create's own (#3978). The subnet's lookup
 * still runs, because its conflict error names no subnet id.
 */
export const createVpcLatch = new AmbiguousCreateLatch('ec2:CreateVpc');
export const createSubnetLatch = new AmbiguousCreateLatch('ec2:CreateSubnet');
export const createInternetGatewayLatch = new AmbiguousCreateLatch('ec2:CreateInternetGateway');
export const allocateAddressLatch = new AmbiguousCreateLatch('ec2:AllocateAddress');
/**
 * VPC, subnet, internet gateway and allocation ids this process created,
 * never reported as orphan candidates. One set: each id carries its type's
 * prefix (`vpc-`, `subnet-`, `igw-`, `eipalloc-`).
 */
export const ec2IdsCreatedByThisProcess = new RecentIdSet();

/**
 * go-to-k/cdkd#5633: the wait after deleting an IPAM-allocated VPC for its
 * pool allocation to be released. AWS releases it late: measured 1092s (about
 * 18 minutes) after `DeleteVpc` returned (us-east-1, 2026-11-04, a /28 from an
 * advanced-tier private pool), so the cap is 25 minutes, under the default
 * 30-minute per-resource deadline. A release has also taken longer than that
 * (go-to-k/cdkd#5975); the pool CIDR's delete then waits again, under its own
 * deadline (`ipamPoolCidrReleaseWait`). Exported so tests can shorten it.
 */
export const vpcIpamReleaseWait = { pollIntervalMs: 10_000, maxWaitMs: 25 * 60_000 };

/**
 * What an ambiguous-create orphan report matches a VPC on: the declared
 * primary CIDR, or (go-to-k/cdkd#5633) the IPAM pool it was allocated from.
 */
export type VpcOrphanMatch = { cidrBlock: string } | { ipamPoolId: string };

/**
 * What an ambiguous-create orphan report matches a subnet on: a declared
 * CIDR (IPv4, or IPv6 for an IPv6-only subnet), or (go-to-k/cdkd#5632) the
 * IPAM pool its block is allocated from.
 */
export type SubnetOrphanMatch = { cidr: string; family: 'ipv4' | 'ipv6' } | { ipamPoolId: string };

/**
 * The writable members of CloudFormation's `VpcEncryptionControl`, each the
 * same-named `VpcEncryptionControlConfiguration` member (go-to-k/cdkd#5633).
 * The schema's other members (`State`, `StateMessage`, `VpcId`,
 * `VpcEncryptionControlId`, `ResourceExclusions`) are what AWS reports back.
 */
export const VPC_ENCRYPTION_CONTROL_EXCLUSIONS = [
  'InternetGatewayExclusion',
  'EgressOnlyInternetGatewayExclusion',
  'NatGatewayExclusion',
  'VirtualPrivateGatewayExclusion',
  'VpcPeeringExclusion',
  'LambdaExclusion',
  'VpcLatticeExclusion',
  'ElasticFileSystemExclusion',
] as const;

/** The sentence a create-path refusal adds when it is replaying a state record. */
export function replayedRecordNote(context: { replayingState?: boolean } | undefined): string {
  return context?.replayingState === true
    ? ' The value comes from the state record being restored.'
    : '';
}

/**
 * go-to-k/cdkd#5633 / #5630: the create-only properties this provider sends
 * at create time and can never change. A change to one is a replacement in
 * the engine, so only `cdkd drift --revert` brings one to `update()`.
 */
export const VPC_CREATE_ONLY_SENT = ['Ipv4IpamPoolId', 'Ipv4NetmaskLength', 'VpcEncryptionControl'];

/**
 * go-to-k/cdkd#5632: the Subnet's create-only CreateSubnet inputs, as
 * {@link VPC_CREATE_ONLY_SENT} is the VPC's. Neither pool id has a readback
 * (getDriftUnknownPaths), so `update()` compares a key only when both sides
 * carry it.
 */
export const SUBNET_CREATE_ONLY_SENT = [
  'VpcId',
  'CidrBlock',
  'AvailabilityZone',
  'AvailabilityZoneId',
  'Ipv4IpamPoolId',
  'Ipv4NetmaskLength',
  'Ipv6IpamPoolId',
  'Ipv6NetmaskLength',
];

/** go-to-k/cdkd#5632: the IPAM pool id pattern a delete-side wait may send. */
export const IPAM_POOL_ID_PATTERN = /^ipam-pool-[0-9a-z]+$/;

/**
 * One of those values with CloudFormation's scalar spellings folded (an
 * integer or boolean written as a string), so the comparison sees a change
 * only where AWS would hold a different value.
 */
function foldCreateOnlySent(key: string, value: unknown): unknown {
  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  if (key === 'Ipv4NetmaskLength' || key === 'Ipv6NetmaskLength') {
    return coerceCfnInteger(value) ?? value;
  }
  if (key === 'CpuOptions') {
    const cpu = asRecord(value);
    if (cpu === undefined) return value;
    return Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, coerceCfnInteger(v) ?? v]));
  }
  if (key === 'HibernationOptions') {
    const hibernation = asRecord(value);
    if (hibernation === undefined) return value;
    return Object.fromEntries(
      Object.entries(hibernation).map(([k, v]) => [k, coerceCfnBoolean(v) ?? v])
    );
  }
  if (key === 'LaunchTemplate') {
    // go-to-k/cdkd#5630: a numeric Version is sent as its string.
    const template = asRecord(value);
    if (template === undefined || typeof template['Version'] !== 'number') return value;
    return { ...template, Version: String(template['Version']) };
  }
  return value;
}

/** Whether two sides hold the same create-only value (see foldCreateOnlySent). */
export function sameCreateOnlySent(key: string, a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(foldCreateOnlySent(key, a), foldCreateOnlySent(key, b));
}

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetEc2CreateRetryStateForTests(): void {
  createVpcLatch.resetForTests();
  createSubnetLatch.resetForTests();
  createInternetGatewayLatch.resetForTests();
  allocateAddressLatch.resetForTests();
  ec2IdsCreatedByThisProcess.resetForTests();
}

/**
 * Whether a resource could be an orphan of a lost create response, by its
 * tags: the creates send the template's tags in `TagSpecifications`
 * (go-to-k/cdkd#4971), so an orphan carries EXACTLY those -- or none, when the
 * lost attempt was the untagged re-send of {@link EC2Provider.sendTaggedCreate}
 * or the template declares none. Any other tag set was put there by something
 * else. A recorded resource with the same tags matches too, which the undated
 * report's wording already allows for.
 */
export const mayBeLostCreate = (
  tags: ReadonlyArray<unknown> | undefined,
  sent: ReadonlyArray<CfnTagEntry>
): boolean =>
  tags === undefined || tags.length === 0 || (sent.length > 0 && tagListsMatch(tags, sent));

/**
 * The orphan report's noun for a lookup matched by {@link mayBeLostCreate}:
 * `untagged <what>` when the template declares no tags, else a phrase naming
 * both tag states that lookup accepts. `adjective` leads either form.
 */
export const lostCreateNoun = (
  what: string,
  sent: ReadonlyArray<CfnTagEntry>,
  adjective?: string
): string =>
  sent.length === 0
    ? `${adjective !== undefined ? `${adjective}, ` : ''}untagged ${what}`
    : `${adjective !== undefined ? `${adjective} ` : ''}${what} with no tags or exactly the template's tags`;

/**
 * True when a create that carried `TagSpecifications` was refused for lacking
 * `ec2:CreateTags` (go-to-k/cdkd#4971). Measured wording, from a session
 * allowed each create action but not `ec2:CreateTags`: `UnauthorizedOperation`
 * with "... is not authorized to perform: ec2:CreateTags on resource: ...", for
 * all nine creates. Untagged, each of those creates was allowed. An answer
 * that names no action (only the encoded authorization message) is not
 * matched: such a create fails, as the same create from CloudFormation would.
 */
export function isCreateTagsDenial(error: unknown): boolean {
  return (
    isNamedError(error, CREATE_TAGS_DENIAL_NAMES) &&
    describeAwsFailure(error).detail.includes('ec2:CreateTags')
  );
}

/**
 * cdkd-authored sentences appended to an AWS error's own message, keyed by
 * that error ({@link EC2Provider}'s `sendTaggedCreate`). The wrap that names
 * the error by its class only re-appends them (go-to-k/cdkd#2319).
 */
export const CDKD_NOTES = new WeakMap<Error, string>();

/**
 * What a thrown EC2 wrap says in place of an AWS-authored failure's own text
 * (go-to-k/cdkd#2319): its class, through `mask` (the class is AWS-authored
 * text too), plus two cdkd-authored facts that text carried and a reader of
 * the thrown message needs. An "already exists" is restated
 * ({@link relayedNameCollision}), because the create-first replacement path
 * reads the TOP-level message to credit a name collision
 * (`isNameCollisionErrorFrom`), and EC2 names the security-group one
 * `InvalidGroup.Duplicate`, which no collision pattern matches; not from a
 * post-create wiring call's failure ({@link markAuxiliaryFailure}), where "it"
 * would read as this resource (#3826). A {@link CDKD_NOTES} note is
 * re-appended.
 */
export function redactedEc2FailureText(
  mask: MaskerFn,
  error: unknown,
  failure: AwsFailureText
): string {
  // A non-`Error` throw is redacted too, but AWS did not author it, so it
  // reports nothing.
  if (!(error instanceof Error)) return mask(failure.summary);
  const collision = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  return `${mask(failure.summary)}${collision}${CDKD_NOTES.get(error) ?? ''}`;
}

/** The error code EC2 answers a denied action with. */
export const CREATE_TAGS_DENIAL_NAMES: ReadonlySet<string> = new Set(['UnauthorizedOperation']);

/**
 * EC2's answer to a `ClientToken` re-used with different parameters. A
 * token-bearing create (NAT gateway, route table, network ACL, instance) whose
 * earlier attempt went through the untagged re-send of
 * {@link EC2Provider.sendTaggedCreate} holds its token for the UNTAGGED
 * request, so a later tagged attempt with that token gets this answer --
 * measured, once the caller may `ec2:CreateTags` (a role that still may not is
 * refused that first, also measured). The untagged re-send then returns the
 * resource the token already names.
 */
export const IDEMPOTENT_MISMATCH_NAMES: ReadonlySet<string> = new Set([
  'IdempotentParameterMismatch',
]);

/**
 * go-to-k/cdkd#4971: an EC2 `Describe*` is eventually consistent, so the
 * deploy's observed capture -- which reads right after cdkd's own create
 * (`afterOwnWrite`) -- can be told a resource made a moment ago does not
 * exist, and a not-found there discards the drift baseline. Before tags rode
 * the create, the `CreateTags` call sat between the two. The capture is off the
 * deploy's critical path, and the wait is only spent on a not-found answer.
 */
export const OWN_WRITE_READ_ATTEMPTS = 5;
export const OWN_WRITE_READ_DELAY_MS = 500;

/** Page size of an orphan lookup's `Describe*` call (EC2's maximum). */
export const ORPHAN_LIST_PAGE_SIZE = 1000;
