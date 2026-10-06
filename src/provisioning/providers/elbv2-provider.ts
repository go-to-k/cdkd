import {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancersCommand,
  type DescribeLoadBalancersCommandOutput,
  waitUntilLoadBalancerAvailable,
  DescribeLoadBalancerAttributesCommand,
  ModifyLoadBalancerAttributesCommand,
  SetSubnetsCommand,
  SetSecurityGroupsCommand,
  SetIpAddressTypeCommand,
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  ModifyTargetGroupCommand,
  DescribeTargetGroupsCommand,
  type DescribeTargetGroupsCommandOutput,
  ModifyTargetGroupAttributesCommand,
  DescribeTargetGroupAttributesCommand,
  DescribeTargetHealthCommand,
  RegisterTargetsCommand,
  DeregisterTargetsCommand,
  ModifyCapacityReservationCommand,
  DescribeCapacityReservationCommand,
  ModifyIpPoolsCommand,
  DescribeTagsCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  CreateListenerCommand,
  DeleteListenerCommand,
  ModifyListenerCommand,
  DescribeListenersCommand,
  ModifyListenerAttributesCommand,
  DescribeListenerAttributesCommand,
  type Tag,
  type Action,
  type Certificate,
  type SubnetMapping,
  type LoadBalancerSchemeEnum,
  type LoadBalancerTypeEnum,
  type IpAddressType,
  type ProtocolEnum,
  type TargetTypeEnum,
  type MutualAuthenticationAttributes,
  type EnablePrefixForIpv6SourceNatEnum,
  type EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum,
  type TargetGroupIpAddressTypeEnum,
  type TargetDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { getLogger } from '../../utils/logger.js';
import { definedAttributes } from '../attribute-map.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { withRetry, type RetryLogger } from '../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../interrupt-watch.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import { isTruthyCfnBoolean } from '../data-delete-intent.js';
import {
  protectedReplacementAdvice,
  pasteableAwsCommand,
} from '../replacement-protection-advice.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import {
  createMaskedLogSinks,
  createMaskedRetryLogger,
  maskerOrIdentity,
  withDerivedNameMasks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { markNonRetryable, wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { holdsSecretDerivedEntry } from '../iam-policy-targets.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  type ProtectionFlipRecord,
  type ProtectionGuardSite,
} from './deletion-protection-compensation.js';
import { unchangedBehindSecretReference } from '../secret-reference-immutable.js';
import {
  hasErrorName,
  nameHeldBefore,
  skippedCleanupText,
  type NameHeldBefore,
} from './create-ownership.js';

/**
 * The `Name` a load balancer ARN carries
 * (`...:loadbalancer/app/<name>/<id>`), or `undefined` when the physical id is
 * not one, so the caller keeps its own comparison (go-to-k/cdkd#4275).
 */
function loadBalancerNameFromArn(arn: string): string | undefined {
  return nameFromElbv2Arn(arn, ':loadbalancer/', 3);
}

/**
 * The `Name` a target group ARN carries (`...:targetgroup/<name>/<id>`), or
 * `undefined` when the physical id is not one (go-to-k/cdkd#4339).
 */
function targetGroupNameFromArn(arn: string): string | undefined {
  return nameFromElbv2Arn(arn, ':targetgroup/', 2);
}

/**
 * The name `CreateLoadBalancer` / `CreateTargetGroup` sends for this bag: the
 * template's `Name` under the stack-name prefix rule and the 32-character cap,
 * or one derived from the logical id, in the CALLER's async scope (stack name,
 * prefix flag). The creates and the name lookup in `import()` both take it
 * from here, so the go-to-k/cdkd#3937 probe asks for exactly the name the
 * create would send.
 */
function sentElbv2Name(properties: Record<string, unknown>, logicalIdForFallback: string): string {
  return generateResourceNameWithFallback(
    // A number is sent as its decimal spelling, as AWS reads it.
    typeof properties['Name'] === 'number'
      ? String(properties['Name'])
      : (properties['Name'] as string | undefined),
    logicalIdForFallback,
    { maxLength: 32 }
  );
}

/**
 * The name an `import()` without a known physical id looks up: the one the
 * create would send for the template's `Name` ({@link sentElbv2Name}), or
 * `undefined` without a usable `Name` (a string, or a number, which the create
 * sends as its decimal spelling). A name derived from the logical id is
 * never looked up: the orphan-adoption pre-pass, which presumes such a
 * holder is the stack's own, passes a known physical id instead.
 */
function explicitElbv2Name(input: ResourceImportInput): string | undefined {
  const declared = input.properties['Name'];
  const usable =
    (typeof declared === 'string' && declared !== '') ||
    (typeof declared === 'number' && Number.isFinite(declared));
  return usable ? sentElbv2Name(input.properties, input.logicalId) : undefined;
}

/**
 * A by-name `Describe*` before a create (go-to-k/cdkd#4403): a listed match
 * holds the name. The ABSENCE of one is answered by the service's not-found
 * error, so an empty list with no error is no answer: it throws, which the
 * lookup reads as `unknown`, never as `free`.
 */
function answeredHeld(items: unknown[] | undefined): true {
  if (items === undefined || items.length === 0) {
    throw new Error('ELBv2 answered no match and no not-found error for the name');
  }
  return true;
}

/**
 * The one resource a by-name `Describe*` answered. ELBv2 names are unique per
 * account and region, so more than one, or one without an ARN, is an answer
 * cdkd cannot read, and an empty list without the not-found error is no
 * answer: each throws rather than pick one or read the name as free.
 */
function onlyNamedMatch<T>(
  items: T[] | undefined,
  arnOf: (item: T) => string | undefined,
  what: string
): { item: T; arn: string } {
  const found = items ?? [];
  const arn = found.length === 1 ? arnOf(found[0]!) : undefined;
  if (arn === undefined || arn === '') {
    throw new Error(
      `ELBv2 answered ${found.length} ${what}(s) for one name` +
        (found.length === 1 ? ' with no ARN' : '') +
        `, so cdkd cannot tell which resource holds it`
    );
  }
  return { item: found[0]!, arn };
}

/**
 * The name segment of an ELBv2 ARN: after `marker`, `segments` `/`-separated
 * parts with the name second-to-last.
 */
function nameFromElbv2Arn(arn: string, marker: string, segments: number): string | undefined {
  const at = arn.indexOf(marker);
  if (at < 0) return undefined;
  const parts = arn.slice(at + marker.length).split('/');
  const name = parts[segments - 2];
  return parts.length === segments && name !== undefined && name !== '' ? name : undefined;
}

/**
 * A masker that also hides the NAME a recorded ELBv2 ARN carries when the
 * recorded `Name` is secret-derived (go-to-k/cdkd#4339): after a secret
 * rotation the physical id still names the PRE-rotation value, which this
 * deploy's masker never resolved, and a previous side still spelling
 * `{{resolve:` makes it a needle.
 */
function recordedNameMask(
  maskSecrets: SecretMasker | undefined,
  previousName: unknown,
  recordedName: string | undefined
): MaskerFn {
  const logger = { debug: () => {}, warn: () => {} };
  return withDerivedNameMasks(logger, createMaskedLogSinks(logger, maskSecrets), [
    [previousName, recordedName],
  ]).mask;
}

/**
 * Test seam for the capacity-reservation stabilize poll (mirrors
 * `finalSnapshotDelays` in ../final-snapshot.ts). Unit tests stub `sleep`
 * so the poll runs without wall-clock delay.
 */
export const capacityReservationDelays = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** CFn shape of an `AWS::ElasticLoadBalancingV2::TargetGroup.Targets` entry. */
interface CfnTargetDescription {
  Id?: string;
  Port?: number | string;
  AvailabilityZone?: string;
}

// ─── Targets reads (go-to-k/cdkd#3989) ──────────────────────────────
//
// The TargetGroup update derives its DeregisterTargets set from the gap
// between the desired and the recorded `Targets`. Reading a present-but-
// malformed value (or dropping a malformed entry) as empty therefore
// deregistered every target the other side holds: on a rollback or
// `drift --revert`, where the desired side is a recorded bag, `Targets: {}`
// emptied the target group. So `undefined` / `null` is ABSENT (an empty list),
// and anything else that is not a list of well-formed entries is MALFORMED.
// A malformed DESIRED side is refused before any call; a malformed RECORDED
// side is read from the live group ADD-only (see `readUpdateTargets`).

/** Which side of an update a `Targets` value came from. */
type TargetsSide = 'desired' | 'recorded';

type TargetsRead =
  | { kind: 'list'; items: CfnTargetDescription[] }
  // `onlySecret`: well-shaped, and malformed ONLY because an `Id` holds a
  // dynamic reference or its mask.
  | { kind: 'malformed'; onlySecret: boolean };

/** An integer port, as a number or a digit string (CFn coerces scalars). */
function isTargetPort(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value);
  return typeof value === 'string' && /^\d+$/.test(value);
}

/**
 * `side` matters for the `Id` only. A DESIRED `Id` holding a dynamic reference
 * or its mask names nothing Elastic Load Balancing holds, so it is malformed. A
 * RECORDED one is what cdkd writes for an `Id` that came from a secret (cdkd
 * keeps the reference in state): it is read, and `removableRecordedTargets`
 * keeps it out of the deregister set.
 */
function isWellFormedTarget(entry: unknown, side: TargetsSide, ignoreSecrets = false): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  const id = e['Id'];
  if (typeof id !== 'string' || id.length === 0) return false;
  if (side === 'desired' && !ignoreSecrets && holdsSecretDerivedEntry(id)) return false;
  if (e['Port'] != null && !isTargetPort(e['Port'])) return false;
  const az = e['AvailabilityZone'];
  return az == null || (typeof az === 'string' && az.length > 0);
}

/** Read one `Targets` value; ABSENT (`undefined` / `null`) reads as the empty list. */
function readTargets(value: unknown, side: TargetsSide): TargetsRead {
  if (value === undefined || value === null) return { kind: 'list', items: [] };
  if (Array.isArray(value) && value.every((entry) => isWellFormedTarget(entry, side))) {
    return { kind: 'list', items: value as CfnTargetDescription[] };
  }
  return {
    kind: 'malformed',
    onlySecret:
      Array.isArray(value) && value.every((entry) => isWellFormedTarget(entry, side, true)),
  };
}

/**
 * A recorded `Targets` list minus every entry whose `Id` is secret-derived: the
 * diff would otherwise deregister a literal `{{resolve:...}}` id. Dropping it
 * only misses that one removal, the safe direction.
 */
function removableRecordedTargets(items: CfnTargetDescription[]): CfnTargetDescription[] {
  return items.filter((e) => !holdsSecretDerivedEntry(e.Id));
}

/**
 * Map well-formed CFn `Targets` entries (see {@link readTargets}) to the SDK's
 * `TargetDescription[]`; `Port` is numeric-coerced.
 *
 * `groupPort` defaults an OMITTED `Port` to the target group's own port,
 * which is what AWS substitutes when a target is registered without one.
 * This is load-bearing for the update diff, not cosmetic: `targetKey` in
 * `updateTargetGroup` keys on `Port ?? null`, so without the default a
 * template-shaped `[{Id}]` and an AWS-readback-shaped `[{Id, Port: 80}]`
 * describe the SAME live target under two different keys — and the diff then
 * registers the "new" one (a no-op, it lands on the group port) and
 * DEREGISTERS the live one. `cdkd drift --revert` hits exactly that, since it
 * hands `update()` the AWS snapshot as the previous side and a template-shaped
 * desired side. Absent for a `lambda` target group (no port), where both sides
 * stay undefined and therefore still key identically.
 */
function toTargetDescriptions(
  items: CfnTargetDescription[],
  groupPort?: unknown
): TargetDescription[] {
  const defaultPort =
    groupPort === undefined || groupPort === null || Number.isNaN(Number(groupPort))
      ? undefined
      : Number(groupPort);
  return items.map((e) => {
    const port = e.Port != null ? Number(e.Port) : defaultPort;
    return {
      Id: e.Id as string,
      ...(port !== undefined && { Port: port }),
      ...(e.AvailabilityZone != null && { AvailabilityZone: e.AvailabilityZone }),
    };
  });
}

/** The refusal's cause clause for a desired list refused only for a dynamic reference. */
function targetsSecretCause(read: TargetsRead): string {
  return read.kind === 'malformed' && read.onlySecret
    ? ' (an Id holds a dynamic reference or its mask, which names no target Elastic Load ' +
        'Balancing accepts)'
    : '';
}

const TARGETS_WHAT =
  'targets, each with a string Id and, where given, an integer Port and a string AvailabilityZone';

/**
 * Documented AWS defaults for TargetGroup attributes, used to reset a
 * removed `TargetGroupAttributes` entry. Unlike ModifyLoadBalancerAttributes
 * / ModifyListenerAttributes, ModifyTargetGroupAttributes REJECTS an empty
 * `Value` ("A target group attribute value must be specified" — live-verified
 * 2026-08-11), so clearing an override requires sending the documented
 * default explicitly. Keys whose default is target-type-dependent or
 * undocumented are deliberately absent — a removal of those warns and
 * retains the live value instead of guessing.
 * Source: ELBv2 API reference, TargetGroupAttribute key table.
 */
const TARGET_GROUP_ATTRIBUTE_DEFAULTS: Record<string, string> = {
  'deregistration_delay.timeout_seconds': '300',
  'deregistration_delay.connection_termination.enabled': 'false',
  'stickiness.enabled': 'false',
  'stickiness.lb_cookie.duration_seconds': '86400',
  'stickiness.app_cookie.duration_seconds': '86400',
  'load_balancing.algorithm.type': 'round_robin',
  'load_balancing.algorithm.anomaly_mitigation': 'off',
  'load_balancing.cross_zone.enabled': 'use_load_balancer_configuration',
  'slow_start.duration_seconds': '0',
  'lambda.multi_value_headers.enabled': 'false',
  'proxy_protocol_v2.enabled': 'false',
};

/**
 * Documented AWS defaults for the BOOLEAN / ENUM-valued LoadBalancer and
 * Listener attributes, used to reset a removed `LoadBalancerAttributes` /
 * `ListenerAttributes` entry.
 *
 * Unlike ModifyTargetGroupAttributes — which rejects an empty `Value` for
 * EVERY key — these two APIs accept `Value: ''` for the numeric and
 * free-form string attributes and REJECT it only where the value is
 * validated against a fixed set. Live A/B 2026-08-11 (issue #1609 item 1),
 * via the `alb` integ's removal phase:
 *
 *   idle_timeout.timeout_seconds  -> `Value: ''` ACCEPTED (numeric)
 *   deletion_protection.enabled   -> "The value of 'deletion_protection.enabled'
 *                                     must be 'true' or 'false', but was ''"
 *   routing.http.response.server.enabled (Listener)
 *                                 -> same rejection, same shape
 *
 * A rejection fails the whole Modify* call, so ONE removed boolean took the
 * entire deploy down (and then the rollback with it). Hence: send the
 * documented default for the validated keys, and keep the empty string for
 * everything else — which is both these APIs' own "clear the override"
 * signal and the behaviour every non-boolean key already relied on.
 *
 * That fallback is the deliberate DIVERGENCE from
 * TARGET_GROUP_ATTRIBUTE_DEFAULTS, whose unknown-key arm warns and retains:
 * there the empty string is never valid, here it is valid for the majority
 * of keys, so falling back to it preserves working behaviour instead of
 * silently retaining a value the template asked to drop.
 *
 * A key is listed ONLY when ONE unconditional default is established for it —
 * documented in the SDK model, or (for
 * `routing.http.response.server.enabled`, which the model leaves unstated)
 * proven by the `alb` integ's live removal readback. Two exclusion classes
 * matter, and both are the difference between failing loudly and writing a
 * wrong value silently:
 *
 * - **Default depends on the LOAD BALANCER** — `load_balancing.cross_zone.enabled`
 *   is always-on and unconfigurable for an ALB but defaults to false on an
 *   NLB / GWLB, and `ipv6.deny_all_igw_traffic` is "false for internet-facing
 *   load balancers and true for internal load balancers". cdkd knows neither
 *   the type nor the scheme at diff time, so a hardcoded entry would send the
 *   WRONG value for half of all load balancers — and since it is a valid
 *   boolean, AWS accepts it. For `ipv6.deny_all_igw_traffic` that means
 *   silently un-blocking internet-gateway access on an INTERNAL load balancer.
 * - **No documented default at all** — `dns_record.client_routing_policy`
 *   enumerates its possible values but states no default.
 *
 * Both classes keep the empty-string behaviour they have always had, so a
 * removal there fails loudly (for a validated key) instead of guessing.
 *
 * Source: the `@aws-sdk/client-elastic-load-balancing-v2` model docs for
 * `ModifyLoadBalancerAttributes` / `ModifyListenerAttributes`, checked per key;
 * `routing.http.response.server.enabled`'s default is additionally LIVE-proven
 * by the `alb` integ's removal readback rather than taken from the docs.
 */
const LOAD_BALANCER_ATTRIBUTE_DEFAULTS: Record<string, string> = {
  'deletion_protection.enabled': 'false',
  'access_logs.s3.enabled': 'false',
  'connection_logs.s3.enabled': 'false',
  'health_check_logs.s3.enabled': 'false',
  'routing.http.desync_mitigation_mode': 'defensive',
  'routing.http.drop_invalid_header_fields.enabled': 'false',
  'routing.http.preserve_host_header.enabled': 'false',
  'routing.http.x_amzn_tls_version_and_cipher_suite.enabled': 'false',
  'routing.http.xff_client_port.enabled': 'false',
  'routing.http.xff_header_processing.mode': 'append',
  'routing.http2.enabled': 'true',
  'waf.fail_open.enabled': 'false',
  'zonal_shift.config.enabled': 'false',
};

/** @see LOAD_BALANCER_ATTRIBUTE_DEFAULTS — same rule, Listener key table. */
const LISTENER_ATTRIBUTE_DEFAULTS: Record<string, string> = {
  'routing.http.response.server.enabled': 'true',
};

/**
 * The attribute map a load balancer records, shared by `create()` and
 * `import()` (issue #3627).
 */
function loadBalancerAttributes(
  lb: {
    DNSName?: string | undefined;
    CanonicalHostedZoneId?: string | undefined;
    LoadBalancerName?: string | undefined;
  },
  lbArn: string
): Record<string, unknown> {
  return definedAttributes({
    DNSName: lb.DNSName,
    CanonicalHostedZoneID: lb.CanonicalHostedZoneId,
    LoadBalancerArn: lbArn,
    LoadBalancerFullName: lbArn.split('/').slice(1).join('/'),
    LoadBalancerName: lb.LoadBalancerName,
  });
}

/**
 * The attribute map a target group records, shared by `create()`,
 * `update()` and `import()` (issue #3627).
 */
function targetGroupAttributes(
  tg: { TargetGroupName?: string | undefined },
  tgArn: string
): Record<string, unknown> {
  return definedAttributes({
    TargetGroupArn: tgArn,
    // CloudFormation's value keeps the `targetgroup/` prefix
    // (`targetgroup/<name>/<id>`), the form a CloudWatch `TargetGroup`
    // dimension takes; the earlier `.replace('targetgroup/', '')` dropped it.
    TargetGroupFullName: tgArn.split(':').pop(),
    TargetGroupName: tg.TargetGroupName,
  });
}

/** The keyed `[{Key, Value}]` attribute bag each ELBv2 type reads back in full. */
const ATTRIBUTE_BAG_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'LoadBalancerAttributes'],
  ['AWS::ElasticLoadBalancingV2::TargetGroup', 'TargetGroupAttributes'],
  ['AWS::ElasticLoadBalancingV2::Listener', 'ListenerAttributes'],
]);

/** An attribute entry's string `Key`, or `undefined` when it has none. */
function attributeEntryKey(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const key = (entry as { Key?: unknown }).Key;
  return typeof key === 'string' ? key : undefined;
}

/**
 * The {@link ProtectionGuardSite} for an `AWS::ElasticLoadBalancingV2::LoadBalancer`
 * whose `--remove-protection` delete failed terminally (issue #2204).
 *
 * `--region` is rendered whenever the state records one, for the reason
 * `rdsFamilyProtectionSite` gives: on the region-mismatch race that reaches the
 * not-found arm, a check run against the operator's default region answers the
 * same not-found and reads as "gone".
 */
export function loadBalancerProtectionSite(
  loadBalancerArn: string,
  region: string | undefined
): ProtectionGuardSite {
  return {
    subject: 'ELBv2 LoadBalancer',
    guardName: 'deletion_protection.enabled',
    noun: 'load balancer',
    // Keyed on the SDK error's name, as the shared sites are: every re-enable
    // is a bare `send`, so the error arrives unwrapped.
    isNotFound: (error) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'LoadBalancerNotFoundException',
    notFoundMeaning:
      'ELBv2 answered LoadBalancerNotFound. That most commonly means the load balancer is ' +
      'gone, and it can also mean it is not in this region or account.',
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = region ? aws` --region ${region}` : aws``;
      const restore = aws`aws elbv2 modify-load-balancer-attributes --load-balancer-arn ${loadBalancerArn}${regionArg} --attributes Key=deletion_protection.enabled,Value=true`;
      return {
        check:
          aws`aws elbv2 describe-load-balancer-attributes --load-balancer-arn ${loadBalancerArn}${regionArg}`.render(),
        restoreAfterNotFound: restore.render(),
        restoreLive: restore.render(),
      };
    },
  };
}

/**
 * ELBv2's own not-found answer, by error NAME (go-to-k/cdkd#4283). The
 * provider's looser message match keeps its old "cannot tell" answer.
 */
function isElbv2NotFoundName(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return (
    name === 'LoadBalancerNotFoundException' ||
    name === 'TargetGroupNotFoundException' ||
    name === 'ListenerNotFoundException'
  );
}

/**
 * AWS ELBv2 Provider
 *
 * Implements resource provisioning for ELBv2 resources:
 * - AWS::ElasticLoadBalancingV2::LoadBalancer
 * - AWS::ElasticLoadBalancingV2::TargetGroup
 * - AWS::ElasticLoadBalancingV2::Listener
 *
 * WHY: ELBv2 Create* APIs are synchronous - the CC API adds unnecessary polling
 * overhead for operations that complete immediately. This SDK provider eliminates
 * that polling.
 *
 * "The API is synchronous" is NOT the same claim as "the resource is ready",
 * and an earlier version of this comment conflated the two. TargetGroup and
 * Listener genuinely are ready on return; a LoadBalancer comes back with
 * `State.Code: provisioning` and is not servable for another 90-180s. So
 * createLoadBalancer waits for `active` (skippable with --no-wait) while the
 * other two do not.
 */

export class ELBv2Provider implements ResourceProvider {
  private elbv2Client?: ElasticLoadBalancingV2Client;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('ELBv2Provider');
  /** `--remove-protection` flips per load balancer, kept across `delete()` re-entry (#2204). */
  private readonly protectionFlips = new ProtectionFlipRegistry();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      new Set([
        'Name',
        'Subnets',
        'SubnetMappings',
        'SecurityGroups',
        'Scheme',
        'Type',
        'IpAddressType',
        'LoadBalancerAttributes',
        'Tags',
        'EnablePrefixForIpv6SourceNat',
        'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
        'Ipv4IpamPoolId',
        'MinimumLoadBalancerCapacity',
        'EnableCapacityReservationProvisionStabilize',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      new Set([
        'Protocol',
        'Port',
        'VpcId',
        'TargetType',
        'ProtocolVersion',
        'HealthCheckProtocol',
        'HealthCheckPort',
        'HealthCheckPath',
        'HealthCheckEnabled',
        'HealthCheckIntervalSeconds',
        'HealthCheckTimeoutSeconds',
        'HealthyThresholdCount',
        'UnhealthyThresholdCount',
        'Matcher',
        'Name',
        'Tags',
        'IpAddressType',
        'TargetControlPort',
        'TargetGroupAttributes',
        'Targets',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::Listener',
      new Set([
        'LoadBalancerArn',
        'Certificates',
        'DefaultActions',
        'Port',
        'Protocol',
        'SslPolicy',
        'AlpnPolicy',
        'MutualAuthentication',
        'ListenerAttributes',
      ]),
    ],
  ]);

  private getClient(): ElasticLoadBalancingV2Client {
    if (!this.elbv2Client) {
      this.elbv2Client = new ElasticLoadBalancingV2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.elbv2Client;
  }

  /**
   * A {@link RetryLogger} for this provider's `withRetry` calls, bound to the
   * caller's secret masker (issue #2050).
   *
   * Thin wrapper over the shared {@link createMaskedRetryLogger} so the two
   * providers that need it cannot drift apart — see that module for why the
   * factory is shared rather than hand-rolled per file, and for the full
   * rationale on why `warn` is threaded rather than omitted.
   *
   * WHY NOT A `maskSecrets` OPTION ON `withRetry` (issue #2050 acceptance
   * item 3): `RetryLogger` is a structural type any caller can already satisfy
   * with a masking object — `drift.ts`'s revert has done exactly that since
   * issue #1914 — so the option would be a SECOND spelling of one intent
   * across ~50 existing call sites, and two spellings is how a later author
   * reaches for the unmasked one.
   */
  private maskedRetryLogger(maskSecrets: SecretMasker | undefined): RetryLogger {
    return createMaskedRetryLogger(this.logger, maskSecrets);
  }

  /**
   * Mask a caught AWS error's message before it is interpolated into a line
   * this provider logs (issue #2050, review round 2). A thrown `create()` /
   * `update()` failure goes through {@link wrapMaskedError} instead, which
   * masks the same text and also stamps the wrap.
   *
   * Masks `error.message` rather than the assembled sentence ON PURPOSE. The
   * two are NOT equivalent: handing the masker the raw message can reach
   * `maskSecretsInText`'s WHOLE-VALUE arm, which matches at ANY length, while
   * a longer assembled sentence can only ever reach the SUBSTRING arm, which
   * ignores needles below 4 characters. See `SecretMaskingContext` in
   * `src/types/resource.ts`.
   */
  private maskErrorMessage(error: unknown, maskSecrets: SecretMasker | undefined): string {
    const mask = maskerOrIdentity(maskSecrets);
    return mask(error instanceof Error ? error.message : String(error));
  }

  /**
   * A `create()` / `update()` failure wrap quoting the caught error's text
   * masked RAW, as {@link maskErrorMessage} does (issue #2050).
   *
   * NOT a duplicate of {@link maskedRetryLogger}, and strictly WIDER than it.
   * `withRetry` rethrows the RAW error, and `deploy-engine.ts` prints the
   * resulting message at ERROR — i.e. at DEFAULT verbosity — so a masked
   * give-up `warn` was being followed one line later by the identical text
   * unmasked. It is also the ONLY disclosure surface for a NON-RETRYABLE
   * rejection, where `withRetry` emits nothing at all: its give-up summary is
   * gated on `propagationRetries > 0 || serverErrorRetries > 0`, and a
   * validation error that fails on attempt 0 satisfies neither.
   *
   * The `cause` stays the ORIGINAL, unmasked error, and a message the mask
   * changed is stamped so the retry classifiers read that chain rather than
   * the masked message (`wrapMaskedAwsError`, issue #4259): a secret that
   * spells part of the retry table's wording would otherwise turn a transient
   * failure terminal. A method, so `gen-update-wrap-coverage` sees the catch
   * that throws it as a wrap.
   */
  private wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedAwsError(mask, error, build);
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  /**
   * `create()` reads `context` for ONE thing: `maskSecrets` (issue #2050). The
   * Listener create path runs a post-create `ModifyListenerAttributes` through
   * `withRetry`, whose per-attempt `debug` line and give-up `warn` summary
   * interpolate the AWS message verbatim — and that payload is built from
   * RESOLVED template properties. See {@link maskedRetryLogger}.
   *
   * The LoadBalancer arm receives it too (issue #2063). It runs no `withRetry`,
   * but it has the two surfaces that do not need one: the `ProvisioningError`
   * its catch throws (printed at ERROR — DEFAULT verbosity — by
   * `deploy-engine.ts`) and its partial-create cleanup `warn`. Its payload is
   * `Name` / `Subnets` / `SecurityGroups` / `LoadBalancerAttributes` values /
   * `Tags` values straight out of the resolved bag, and AWS quotes a rejected
   * value back.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.createLoadBalancer(logicalId, resourceType, properties, context?.maskSecrets);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.createTargetGroup(logicalId, resourceType, properties, context?.maskSecrets);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.createListener(logicalId, resourceType, properties, context?.maskSecrets);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  /**
   * `context` is read for ONE thing today: `maskSecrets` (issue #2050) — the
   * update-path twin of the `create()` note above.
   *
   * The catch below is the LoadBalancer arm's masking site (issue #2063), and
   * the reason that arm needs no `maskSecrets` parameter of its own.
   * `updateLoadBalancer` has no try/catch: its `ModifyLoadBalancerAttributes` /
   * `SetSubnets` / `SetSecurityGroups` / `AddTags` rejections — every one of
   * them built from the resolved `properties` bag — propagate RAW to here.
   * The sibling arms wrap their own errors into a `ProvisioningError` first,
   * so the `CdkdError` passthrough short-circuits them and this frame masks
   * only what actually escapes unwrapped.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
      // is control flow the deploy engine matches BY CLASS, and an inner
      // ProvisioningError already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      // The LoadBalancer arm has no wrap of its own, and AWS echoes its ARN,
      // which carries a pre-rotation secret-derived name the deploy's masker
      // never resolved (go-to-k/cdkd#4339).
      const mask =
        resourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer'
          ? recordedNameMask(
              context?.maskSecrets,
              previousProperties['Name'],
              loadBalancerNameFromArn(physicalId)
            )
          : maskerOrIdentity(context?.maskSecrets);
      throw this.wrapMaskedError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update ELBv2 resource ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.updateLoadBalancer(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context?.maskSecrets,
          context?.desiredFromAwsReadback === true
        );
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.updateTargetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context?.maskSecrets,
          context?.desiredFromAwsReadback === true
        );
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.updateListener(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context?.maskSecrets,
          context?.desiredFromAwsReadback === true
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.deleteLoadBalancer(logicalId, physicalId, resourceType, context);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.deleteTargetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.deleteListener(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::LoadBalancer ─────────────────────

  private async createLoadBalancer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating LoadBalancer ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
    // delete the load balancer this call created (never one that held the name).
    let leftBehindArn: string | undefined;
    try {
      const lbName = sentElbv2Name(properties, logicalId);

      // Whether the cleanup below may delete what CreateLoadBalancer returns:
      // on identical settings it hands back a load balancer that already held
      // the name (go-to-k/cdkd#4403). Asked only when a wiring step can fail.
      const lbAttributes = this.normalizeAttributes(properties['LoadBalancerAttributes']);
      const enforcePrivateLink = properties[
        'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'
      ] as EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum | undefined;
      const minCapacity = properties['MinimumLoadBalancerCapacity'] as
        | { CapacityUnits?: number | string }
        | undefined;
      // Read ONCE, so the wait below and this gate cannot disagree.
      const waitForActive = process.env['CDKD_NO_WAIT'] !== 'true';
      const wiringDeclared =
        waitForActive ||
        lbAttributes.length > 0 ||
        enforcePrivateLink !== undefined ||
        minCapacity?.CapacityUnits !== undefined;
      const heldBefore: NameHeldBefore = wiringDeclared
        ? await nameHeldBefore(
            async () =>
              answeredHeld(
                (await this.getClient().send(new DescribeLoadBalancersCommand({ Names: [lbName] })))
                  .LoadBalancers
              ),
            (error) => hasErrorName(error, ['LoadBalancerNotFoundException'])
          )
        : 'free';

      const ipv4IpamPoolId = properties['Ipv4IpamPoolId'] as string | undefined;
      const response = await this.getClient().send(
        new CreateLoadBalancerCommand({
          Name: lbName,
          Subnets: properties['Subnets'] as string[] | undefined,
          SubnetMappings: properties['SubnetMappings'] as
            | Array<{ SubnetId: string; AllocationId?: string; PrivateIPv4Address?: string }>
            | undefined,
          SecurityGroups: properties['SecurityGroups'] as string[] | undefined,
          Scheme: properties['Scheme'] as LoadBalancerSchemeEnum | undefined,
          Type: properties['Type'] as LoadBalancerTypeEnum | undefined,
          IpAddressType: properties['IpAddressType'] as IpAddressType | undefined,
          EnablePrefixForIpv6SourceNat: properties['EnablePrefixForIpv6SourceNat'] as
            | EnablePrefixForIpv6SourceNatEnum
            | undefined,
          // CFn flattens the SDK's `IpamPools` wrapper to a single
          // `Ipv4IpamPoolId` string (ipv4 is the only pool kind today).
          ...(ipv4IpamPoolId !== undefined && { IpamPools: { Ipv4IpamPoolId: ipv4IpamPoolId } }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const lb = response.LoadBalancers?.[0];
      if (!lb || !lb.LoadBalancerArn) {
        // Theoretical AWS SDK contract violation: CreateLoadBalancer
        // returned success but with no LoadBalancerArn. Cannot clean up
        // — we have no ARN to delete. Has never been observed in
        // practice.
        throw new Error('CreateLoadBalancer did not return LoadBalancer ARN');
      }
      const lbArn = lb.LoadBalancerArn;

      this.logger.debug(`Successfully created LoadBalancer ${logicalId}: ${lbArn}`);

      // CreateLoadBalancerCommand has succeeded — AWS has now committed
      // the LB. If the subsequent ModifyLoadBalancerAttributesCommand
      // throws, the LB exists on AWS but cdkd state will NOT (the throw
      // aborts before the success-return). The next redeploy plans
      // CREATE again and AWS rejects with `DuplicateLoadBalancerName`
      // (LB Names are unique per scheme within a region). Wrap the
      // attributes call in an inner try/catch that issues a best-effort
      // `DeleteLoadBalancerCommand` before re-throwing the original
      // error. A freshly-created LB has no listeners / target group
      // attachments yet, so a single DeleteLoadBalancer suffices (no
      // need to delete listeners first).
      try {
        // Wait for the LB to leave `provisioning` and reach `active`
        // unless --no-wait is set. CreateLoadBalancer returns a fully
        // formed LoadBalancer object synchronously, but with
        // `State.Code: provisioning` — the LB is NOT servable yet, and
        // `DNSName` (returned below as a GetAtt attribute) 503s until it
        // is. Both other engines wait here: CloudFormation before
        // CREATE_COMPLETE, Terraform's `aws_lb` before apply returns.
        //
        // Deliberately INSIDE the partial-create cleanup try/catch: a
        // waiter timeout with the LB already created on AWS but absent
        // from cdkd state would make the next deploy fail with
        // DuplicateLoadBalancerName (LB names are unique per scheme per
        // region), so it has to route through the same best-effort
        // DeleteLoadBalancer as an attributes-wiring failure. The cleanup
        // NARROWS that window rather than closing it — LB deletion is
        // asynchronous and outlives the DeleteLoadBalancer call, so an
        // immediate retry can still hit the duplicate-name error (issue
        // #1291 item 4).
        //
        // Create only. SetSubnets / SetSecurityGroups / SetIpAddressType
        // on update act on an already-active LB and need no waiter.
        if (waitForActive) {
          this.logger.debug(`Waiting for LoadBalancer ${logicalId} to reach active state...`);
          await waitUntilLoadBalancerAvailable(
            // 600s matches Terraform's default `aws_lb` create timeout.
            // minDelay/maxDelay override the AWS SDK defaults (15s / 120s)
            // per the #1177 poll-cap sweep: an ALB reaches `active` in
            // 90-180s, so a 120s-apart late poll can add minutes of dead
            // time to every deploy that creates one.
            { client: this.getClient(), maxWaitTime: 600, minDelay: 5, maxDelay: 10 },
            { LoadBalancerArns: [lbArn] }
          );
          this.logger.debug(`LoadBalancer ${logicalId} is active`);
        } else {
          this.logger.debug(
            `LoadBalancer ${logicalId} created (skipping active-state wait per --no-wait)`
          );
        }

        // Apply LoadBalancerAttributes if specified (normalized so an
        // unquoted-YAML numeric/boolean Value goes on the wire as a string,
        // matching the TG / Listener create paths).
        if (lbAttributes.length > 0) {
          await this.getClient().send(
            new ModifyLoadBalancerAttributesCommand({
              LoadBalancerArn: lbArn,
              Attributes: lbAttributes,
            })
          );
          this.logger.debug(
            `Applied ${lbAttributes.length} LoadBalancer attributes for ${logicalId}`
          );
        }

        // EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic has no
        // CreateLoadBalancer member — the only write path is SetSecurityGroups,
        // so re-issue the create-time security groups with the flag when the
        // template carries it (NLB + security-groups only; AWS rejects it
        // elsewhere and the error surfaces through the cleanup catch).
        if (enforcePrivateLink !== undefined) {
          await this.getClient().send(
            new SetSecurityGroupsCommand({
              LoadBalancerArn: lbArn,
              SecurityGroups: (properties['SecurityGroups'] as string[] | undefined) ?? [],
              EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: enforcePrivateLink,
            })
          );
          // Masked because `enforcePrivateLink` IS a resolved property value.
          // Debug level is not an exemption (issue #2063 review): `--verbose`
          // is an ordinary way to run a failing deploy, and #1997 shipped this
          // exact shape as a leak (a resolved ASG name in a debug line). Masked
          // on the RAW value rather than the finished sentence so a value that
          // is the whole needle is caught at any length.
          this.logger.debug(
            `Applied EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic=${maskerOrIdentity(
              maskSecrets
            )(String(enforcePrivateLink))} for ${logicalId}`
          );
        }

        // MinimumLoadBalancerCapacity rides on the separate
        // ModifyCapacityReservation control-plane call (no CreateLoadBalancer
        // member). EnableCapacityReservationProvisionStabilize is a CFn-only
        // orchestration flag with NO SDK member: it opts the deploy into
        // waiting for the reservation to reach `provisioned` before success.
        if (minCapacity?.CapacityUnits !== undefined) {
          await this.getClient().send(
            new ModifyCapacityReservationCommand({
              LoadBalancerArn: lbArn,
              MinimumLoadBalancerCapacity: {
                CapacityUnits: Number(minCapacity.CapacityUnits),
              },
            })
          );
          // Same reason as the SetSecurityGroups debug above:
          // `MinimumLoadBalancerCapacity.CapacityUnits` is a resolved property
          // value, and it is the more reachable of the two — a
          // `{{resolve:secretsmanager:...}}` resolving to a numeric string is
          // accepted by `Number()` here and by AWS, so the plaintext prints.
          this.logger.debug(
            `Requested capacity reservation of ${maskerOrIdentity(maskSecrets)(
              String(minCapacity.CapacityUnits)
            )} LCU for ${logicalId}`
          );
          if (
            isTruthyCfnBoolean(properties['EnableCapacityReservationProvisionStabilize']) &&
            process.env['CDKD_NO_WAIT'] !== 'true'
          ) {
            await this.waitForCapacityReservationProvisioned(lbArn, logicalId);
          }
        }
      } catch (innerError) {
        if (heldBefore !== 'free') {
          this.logger.warn(
            maskerOrIdentity(maskSecrets)(
              skippedCleanupText(
                heldBefore,
                `LoadBalancer ${logicalId} (${lbArn})`,
                pasteableAwsCommand(
                  maskSecrets
                )`aws elbv2 delete-load-balancer --load-balancer-arn ${lbArn}`.render()
              )
            )
          );
        } else {
          try {
            await this.getClient().send(new DeleteLoadBalancerCommand({ LoadBalancerArn: lbArn }));
            this.logger.debug(
              `Cleaned up partially-created LoadBalancer ${logicalId} (${lbArn}) after wiring failure`
            );
          } catch (cleanupError) {
            leftBehindArn = lbArn;
            this.logger.warn(
              // Masked for uniformity with the sibling lines in this same `try`
              // (issue #2063), matching the Listener / TargetGroup create paths.
              // The cleanup call carries only the AWS-issued ARN, so a resolved
              // property value reaching here would be surprising — but
              // "surprising" is not "impossible", and an unmasked line sitting
              // beside masked ones is what a later author copies.
              `Failed to clean up partially-created LoadBalancer ${logicalId} (${lbArn}): ${this.maskErrorMessage(cleanupError, maskSecrets)}. Manual deletion may be required before the next deploy: ${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-load-balancer --load-balancer-arn ${lbArn}`.render()}`
            );
          }
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      return {
        physicalId: lbArn,
        attributes: loadBalancerAttributes(lb, lbArn),
      };
    } catch (error) {
      // `cause` carries the ORIGINAL error untouched (issue #2063): the
      // classifier walks it for `$metadata`, so only the human-readable
      // message is masked. This throw is the ONLY disclosure surface for a
      // NON-RETRYABLE `CreateLoadBalancer` rejection — nothing on this path
      // goes through `withRetry`, so there is no give-up summary behind it.
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapMaskedError(
        maskerOrIdentity(maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create LoadBalancer ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      if (leftBehindArn !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindArn);
      }
      throw thrown;
    }
  }

  private async updateLoadBalancer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    callerMaskSecrets?: SecretMasker,
    fromReadback = false
  ): Promise<ResourceUpdateResult> {
    // Masks a pre-rotation secret-derived `Name` the ARN carries too
    // (go-to-k/cdkd#4339), which this deploy's own masker never resolved.
    const maskSecrets = recordedNameMask(
      callerMaskSecrets,
      previousProperties['Name'],
      loadBalancerNameFromArn(physicalId)
    );
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // ELBv2 LoadBalancer Name / Type / Scheme are immutable after
    // creation. The deploy engine detects these via immutable-property
    // detection and replaces the resource. The remaining surface is
    // mutable in-place via separate Set*/Modify* calls:
    //   - LoadBalancerAttributes → ModifyLoadBalancerAttributes (key diff)
    //   - Subnets / SubnetMappings / EnablePrefixForIpv6SourceNat → SetSubnets
    //   - SecurityGroups / EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic
    //     → SetSecurityGroups (full replace)
    //   - IpAddressType → SetIpAddressType
    //   - Ipv4IpamPoolId → ModifyIpPools (removal → RemoveIpamPools)
    //   - MinimumLoadBalancerCapacity → ModifyCapacityReservation
    //     (removal → ResetCapacityReservation; the
    //     EnableCapacityReservationProvisionStabilize flag gates a
    //     provisioned-state wait, not an API field)
    //   - Tags → AddTags / RemoveTags (key diff)
    // Any other diff (Name / Type / Scheme) rejects with
    // ResourceUpdateNotSupportedError so `cdkd drift --revert` surfaces
    // the limitation instead of silently no-op'ing.
    const handledKeys = new Set([
      'LoadBalancerAttributes',
      'Subnets',
      'SubnetMappings',
      'SecurityGroups',
      'IpAddressType',
      'Tags',
      'EnablePrefixForIpv6SourceNat',
      'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
      'Ipv4IpamPoolId',
      'MinimumLoadBalancerCapacity',
      'EnableCapacityReservationProvisionStabilize',
    ]);
    // Compared key by key: a secret-derived value is recorded as its
    // `{{resolve:...}}` reference and handed here resolved, which is no change
    // (go-to-k/cdkd#4275). `Name` is decided by the name the ARN carries; any
    // other key takes the masker arm, which only a key the engine replaces on
    // every change (`Type`, `Scheme`) can pass.
    let immutableChanged = false;
    for (const key of new Set([...Object.keys(properties), ...Object.keys(previousProperties)])) {
      if (handledKeys.has(key)) continue;
      if (JSON.stringify(properties[key]) === JSON.stringify(previousProperties[key])) continue;
      if (
        await unchangedBehindSecretReference({
          resourceType,
          key,
          desired: properties[key],
          previous: previousProperties[key],
          physicalName: key === 'Name' ? loadBalancerNameFromArn(physicalId) : undefined,
          // The deploy's own masker: whether a desired value is one this
          // deploy resolved is its question, not the recorded name's.
          maskSecrets: callerMaskSecrets,
        })
      ) {
        continue;
      }
      immutableChanged = true;
      break;
    }
    if (immutableChanged) {
      // Issue [#2610] site 1. `--replace` alone cannot succeed on a load
      // balancer whose `deletion_protection.enabled` attribute is on: the
      // replacement's DELETE runs from the deploy engine, which never sets
      // `DeleteContext.removeProtection` — see
      // `../replacement-protection-advice.ts` for the mechanism and for why the
      // RECORDED bag is the one to read. `deletion_protection.enabled` lives
      // INSIDE `LoadBalancerAttributes`, which `handledKeys` above strips from
      // the comparison, so this refusal is reached with the attribute
      // unexamined and the attribute diff is applied only further down — i.e.
      // at this point AWS still holds what `previousProperties` records.
      const deletionProtected = this.normalizeAttributes(
        previousProperties['LoadBalancerAttributes']
      ).some((a) => a.Key === 'deletion_protection.enabled' && isTruthyCfnBoolean(a.Value));
      const remedy = deletionProtected
        ? protectedReplacementAdvice({
            evidence:
              "cdkd's recorded properties for this load balancer carry " +
              'LoadBalancerAttributes deletion_protection.enabled=true',
            replaceFlags: 'cdkd deploy --replace',
            disable: {
              before: 'aws elbv2 modify-load-balancer-attributes --load-balancer-arn',
              identifier: physicalId,
              after: '--attributes Key=deletion_protection.enabled,Value=false',
              // An ARN carrying a secret-derived name (the pre-rotation one
              // included) withholds the command (go-to-k/cdkd#4339).
              maskSecrets,
            },
          })
        : 'For Name / Type / Scheme re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.';
      throw new ResourceUpdateNotSupportedError(
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        logicalId,
        'ELBv2 LoadBalancer Name / Type / Scheme are immutable on AWS — none of the ELBv2 Modify* / Set* APIs accept these fields; they are fixed at creation. cdkd handles LoadBalancerAttributes / Subnets / SubnetMappings / SecurityGroups / IpAddressType / Tags in-place. ' +
          remedy
      );
    }

    // ─── LoadBalancerAttributes ──────────────────────────────────────
    // ModifyLoadBalancerAttributes replaces ONLY the listed attrs — keys
    // not in the request are left untouched. Build the diff: changed
    // values from newAttrs win; keys present only in oldAttrs are reset.
    // A removed BOOLEAN / ENUM key takes its documented default from
    // LOAD_BALANCER_ATTRIBUTE_DEFAULTS because this API rejects an empty
    // Value for those (live-verified 2026-08-11 — see that table); every
    // other key keeps the empty string, which the API accepts as "clear the
    // override". Skip the call entirely when nothing changed so the
    // no-drift round-trip is a clean no-op. `drift --revert` sends no
    // removal at all (go-to-k/cdkd#4147, see diffAttributeBag).
    const submittedAttrs = this.diffAttributeBag(
      'LoadBalancerAttributes',
      logicalId,
      properties['LoadBalancerAttributes'],
      previousProperties['LoadBalancerAttributes'],
      this.attributeRemovalResolver(LOAD_BALANCER_ATTRIBUTE_DEFAULTS),
      fromReadback,
      maskSecrets
    );
    if (submittedAttrs.length > 0) {
      await this.getClient().send(
        new ModifyLoadBalancerAttributesCommand({
          LoadBalancerArn: physicalId,
          Attributes: submittedAttrs,
        })
      );
      this.logger.debug(
        `Applied ${submittedAttrs.length} LoadBalancerAttributes change(s) for ${logicalId}`
      );
    }

    // ─── Subnets / SubnetMappings ────────────────────────────────────
    // SetSubnets is a full-replace API: the request payload is the
    // complete desired set; AWS swaps in / out as needed. SubnetMappings
    // wins when both are present (matches CFn semantics — they're a
    // strict superset of Subnets). Skip the call when neither value
    // actually changed.
    const newSubnets = properties['Subnets'] as string[] | undefined;
    const oldSubnets = previousProperties['Subnets'] as string[] | undefined;
    const newMappings = properties['SubnetMappings'] as SubnetMapping[] | undefined;
    const oldMappings = previousProperties['SubnetMappings'] as SubnetMapping[] | undefined;
    const newIpv6SourceNat = properties['EnablePrefixForIpv6SourceNat'] as
      | EnablePrefixForIpv6SourceNatEnum
      | undefined;
    const oldIpv6SourceNat = previousProperties['EnablePrefixForIpv6SourceNat'] as
      | EnablePrefixForIpv6SourceNatEnum
      | undefined;
    const subnetsChanged = JSON.stringify(newSubnets) !== JSON.stringify(oldSubnets);
    const mappingsChanged = JSON.stringify(newMappings) !== JSON.stringify(oldMappings);
    // EnablePrefixForIpv6SourceNat rides on SetSubnets: a change re-issues the
    // current subnet set with the new flag. A REMOVED flag on its own is
    // retained (no call) — CFn retains most removed fields. The COMBINED case
    // (flag removed in the SAME deploy that changes Subnets, so the Set call is
    // issued WITHOUT the member) is A/B-verified: AWS RETAINS the live value on
    // omission — measured us-east-1 2026-08-12 against a dualstack NLB holding
    // the non-default `on`. Adding a third subnet with the member omitted left
    // the flag `on`. So omitting is correct and re-sending would be redundant.
    //
    // Scope of that evidence, because this code can emit TWO request forms and
    // they are fenced differently. The `nlb-source-nat` integ regression-fences
    // the `SubnetMappings` arm only. The plain `Subnets` arm was measured by
    // hand during the same A/B and retained identically, but nothing in the
    // repo reproduces it, so treat it as observed-once rather than guarded — if
    // AWS ever diverges per arm, the integ will not catch the `Subnets` side.
    const ipv6SourceNatChanged =
      newIpv6SourceNat !== undefined && newIpv6SourceNat !== oldIpv6SourceNat;
    if (subnetsChanged || mappingsChanged || ipv6SourceNatChanged) {
      await this.getClient().send(
        new SetSubnetsCommand({
          LoadBalancerArn: physicalId,
          ...(newMappings && newMappings.length > 0
            ? { SubnetMappings: newMappings }
            : { Subnets: newSubnets }),
          ...(newIpv6SourceNat !== undefined && {
            EnablePrefixForIpv6SourceNat: newIpv6SourceNat,
          }),
        })
      );
      this.logger.debug(`Updated Subnets / SubnetMappings for ${logicalId}`);
    }

    // ─── SecurityGroups ──────────────────────────────────────────────
    // SetSecurityGroups requires the full desired set (overrides the
    // previous association). Note: NLBs without a SG at create time
    // cannot have one added later — AWS will reject the call. That's
    // the deploy engine's replacement layer's problem; here we just
    // surface the AWS error if it fires.
    const newSGs = properties['SecurityGroups'] as string[] | undefined;
    const oldSGs = previousProperties['SecurityGroups'] as string[] | undefined;
    const newEnforce = properties['EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'] as
      | EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum
      | undefined;
    const oldEnforce = previousProperties[
      'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'
    ] as EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum | undefined;
    // EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic rides on
    // SetSecurityGroups: a change re-issues the current security-group set
    // with the new flag. A REMOVED flag is retained (no-op) — same rationale
    // as EnablePrefixForIpv6SourceNat above. The COMBINED case is A/B-verified
    // the same way: AWS RETAINS on omission — measured us-east-1 2026-08-12
    // against an NLB holding the non-default `off`, where adding a second
    // security group with the member omitted left the flag `off`. (Note the
    // SetSecurityGroups RESPONSE omits the field when the request did; the
    // DescribeLoadBalancers readback is the authoritative check.) The flag is
    // settable and readable on any SG-bearing NLB — no PrivateLink endpoint
    // service has to exist for the value to persist.
    const enforceChanged = newEnforce !== undefined && newEnforce !== oldEnforce;
    if (JSON.stringify(newSGs) !== JSON.stringify(oldSGs) || enforceChanged) {
      await this.getClient().send(
        new SetSecurityGroupsCommand({
          LoadBalancerArn: physicalId,
          SecurityGroups: newSGs ?? [],
          ...(newEnforce !== undefined && {
            EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: newEnforce,
          }),
        })
      );
      this.logger.debug(`Updated SecurityGroups for ${logicalId}`);
    }

    // ─── IpAddressType ───────────────────────────────────────────────
    const newIpType = properties['IpAddressType'] as IpAddressType | undefined;
    const oldIpType = previousProperties['IpAddressType'] as IpAddressType | undefined;
    if (newIpType !== undefined && newIpType !== oldIpType) {
      await this.getClient().send(
        new SetIpAddressTypeCommand({
          LoadBalancerArn: physicalId,
          IpAddressType: newIpType,
        })
      );
      this.logger.debug(`Updated IpAddressType for ${logicalId}`);
    }

    // ─── Ipv4IpamPoolId ──────────────────────────────────────────────
    // ModifyIpPools sets / removes the IPAM pool association. Removal has a
    // dedicated API spelling (RemoveIpamPools: ['ipv4']), so — unlike the two
    // Set* flags above — dropping the property from the template detaches
    // the pool instead of silently retaining it.
    const newIpamPool = properties['Ipv4IpamPoolId'] as string | undefined;
    const oldIpamPool = previousProperties['Ipv4IpamPoolId'] as string | undefined;
    if (newIpamPool !== oldIpamPool) {
      await this.getClient().send(
        new ModifyIpPoolsCommand({
          LoadBalancerArn: physicalId,
          ...(newIpamPool !== undefined
            ? { IpamPools: { Ipv4IpamPoolId: newIpamPool } }
            : { RemoveIpamPools: ['ipv4'] }),
        })
      );
      this.logger.debug(
        newIpamPool !== undefined
          ? `Updated Ipv4IpamPoolId for ${logicalId}`
          : `Removed IPAM pool association for ${logicalId}`
      );
    }

    // ─── MinimumLoadBalancerCapacity ─────────────────────────────────
    // ModifyCapacityReservation sets the reservation; removal resets it via
    // the dedicated ResetCapacityReservation flag (a capacity reservation is
    // billable, so retaining a removed one would silently keep charging).
    const newCapacity = properties['MinimumLoadBalancerCapacity'] as
      | { CapacityUnits?: number | string }
      | undefined;
    const oldCapacity = previousProperties['MinimumLoadBalancerCapacity'] as
      | { CapacityUnits?: number | string }
      | undefined;
    const newCapacityUnits =
      newCapacity?.CapacityUnits !== undefined ? Number(newCapacity.CapacityUnits) : undefined;
    const oldCapacityUnits =
      oldCapacity?.CapacityUnits !== undefined ? Number(oldCapacity.CapacityUnits) : undefined;
    if (newCapacityUnits !== oldCapacityUnits) {
      await this.getClient().send(
        new ModifyCapacityReservationCommand({
          LoadBalancerArn: physicalId,
          ...(newCapacityUnits !== undefined
            ? { MinimumLoadBalancerCapacity: { CapacityUnits: newCapacityUnits } }
            : { ResetCapacityReservation: true }),
        })
      );
      // The update twin of the create-path capacity debug line, and the reason
      // this arm takes a masker at all: it has no try/catch, so its REJECTIONS
      // are masked by `update()`'s outer frame, but a debug line it emits on
      // the SUCCESS path never reaches that frame.
      //
      // The line therefore reports the value the TEMPLATE declared, not the
      // one that went on the wire (`'1e5'` logs as `1e5` while AWS received
      // `100000`). That divergence is deliberate: the masker matches by
      // literal occurrence, so only the declared spelling can be masked, and a
      // log line that cannot be masked is worth less than one that is
      // approximate.
      //
      // Masks the RAW property value, NOT `newCapacityUnits` — the `Number()`
      // coercion two statements up is exactly the "mask before you stringify"
      // gap the `SecretMasker` contract documents, and an earlier revision of
      // this line got it wrong while asserting the opposite in a comment.
      // A masker matches by LITERAL occurrence, so any value `Number()` does
      // not round-trip renders unmasked: `'0471'` prints `471`, `'1e5'` prints
      // `100000`, `' 4071'` prints `4071`, and a 20-digit value loses its tail
      // to float precision. The create twin above already masks the raw value;
      // this now matches it.
      this.logger.debug(
        newCapacityUnits !== undefined
          ? `Requested capacity reservation of ${maskerOrIdentity(maskSecrets)(
              String(newCapacity?.CapacityUnits)
            )} LCU for ${logicalId}`
          : `Reset capacity reservation for ${logicalId}`
      );
      if (
        newCapacityUnits !== undefined &&
        isTruthyCfnBoolean(properties['EnableCapacityReservationProvisionStabilize']) &&
        process.env['CDKD_NO_WAIT'] !== 'true'
      ) {
        await this.waitForCapacityReservationProvisioned(physicalId, logicalId);
      }
    }

    // ─── Tags ────────────────────────────────────────────────────────
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskSecrets
    );

    return { physicalId, wasReplaced: false };
  }

  /**
   * Poll DescribeCapacityReservation until every zonal state reports
   * `provisioned` — the semantics of the CFn-only
   * `EnableCapacityReservationProvisionStabilize` flag (no SDK member; it
   * opts the deploy into waiting for the reservation instead of returning
   * while zones are still `pending`). Bounded at ~10 min / 15s interval;
   * a timeout WARNS and continues (the reservation keeps provisioning
   * asynchronously and the ModifyCapacityReservation was accepted), while a
   * `failed` zonal state throws — that reservation will never provision.
   *
   * Takes NO masker, deliberately (issue #2063 audit). Its only request is
   * `DescribeCapacityReservation({ LoadBalancerArn })` with an AWS-issued ARN,
   * so no resolved template value is in the payload for AWS to quote back into
   * the transient-failure `debug` line; the timeout `warn` and the `failed`
   * throw are assembled from a logical id, a count and an AWS-supplied zonal
   * reason. A structural reason, not a likelihood judgement — add the
   * parameter if this ever sends a template-derived member. The `failed` throw
   * is an ordinary `Error`, so it lands in `createLoadBalancer`'s masked catch
   * on the create path and in `update()`'s on the update path either way.
   */
  private async waitForCapacityReservationProvisioned(
    lbArn: string,
    logicalId: string
  ): Promise<void> {
    const maxAttempts = 40;
    const intervalMs = 15_000;
    this.logger.debug(`Waiting for capacity reservation of ${logicalId} to provision...`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // A transient Describe failure (throttle, network blip) is treated as
      // still-pending rather than thrown: on the create path an escaped error
      // lands in the partial-create cleanup and would DELETE a healthy LB
      // whose reservation was merely pending. Only a `failed` zonal state —
      // a definitive answer from AWS — aborts the wait.
      let zones;
      try {
        const resp = await this.getClient().send(
          new DescribeCapacityReservationCommand({ LoadBalancerArn: lbArn })
        );
        zones = resp.CapacityReservationState ?? [];
      } catch (probeError) {
        this.logger.debug(
          `DescribeCapacityReservation for ${logicalId} failed transiently (attempt ${attempt + 1}/${maxAttempts}): ${describeAwsFailure(probeError).detail}`
        );
        await capacityReservationDelays.sleep(intervalMs);
        continue;
      }
      const failed = zones.find((z) => z.State?.Code === 'failed');
      if (failed) {
        throw new Error(
          `Capacity reservation for ${logicalId} failed in ${failed.AvailabilityZone ?? 'an availability zone'}: ${failed.State?.Reason ?? 'no reason reported'}`
        );
      }
      if (zones.length === 0 || zones.every((z) => z.State?.Code === 'provisioned')) {
        this.logger.debug(`Capacity reservation for ${logicalId} is provisioned`);
        return;
      }
      await capacityReservationDelays.sleep(intervalMs);
    }
    this.logger.warn(
      `Capacity reservation for ${logicalId} did not reach 'provisioned' within ${(maxAttempts * intervalMs) / 60000} minutes; continuing (provisioning completes asynchronously)`
    );
  }

  /**
   * Delete a load balancer.
   *
   * The compensation boundary (issue #2204): a `--remove-protection` flip of
   * `deletion_protection.enabled` whose delete then fails terminally is undone
   * here, so a destroy that did not happen does not leave a live load balancer
   * with its guard stripped.
   */
  private async deleteLoadBalancer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    await deleteWithProtectionCompensation({
      registry: this.protectionFlips,
      key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
      run: (flip) =>
        this.deleteLoadBalancerOnce(logicalId, physicalId, resourceType, context, flip),
      compensation: {
        logicalId,
        physicalId,
        logger: this.logger,
        site: loadBalancerProtectionSite(physicalId, context?.expectedRegion),
        reEnable: async () => {
          await this.getClient().send(
            new ModifyLoadBalancerAttributesCommand({
              LoadBalancerArn: physicalId,
              Attributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
            })
          );
        },
      },
    });
  }

  private async deleteLoadBalancerOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    this.logger.debug(`Deleting LoadBalancer ${logicalId}: ${physicalId}`);

    // `--remove-protection`: clear the `deletion_protection.enabled`
    // attribute before delete. Idempotent — ELBv2 accepts the call when
    // protection is already disabled. Non-fatal: log at debug if the
    // flip-off errors so the actual DeleteLoadBalancer proceeds. The pre-flip
    // readback is what lets a terminal failure restore ONLY a guard this run
    // turned off.
    if (context?.removeProtection === true) {
      try {
        await observeThenDisableProtection({
          flip,
          logger: this.logger,
          physicalId,
          guardName: 'deletion_protection.enabled',
          observe: async () => {
            const resp = await this.getClient().send(
              new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: physicalId })
            );
            return (resp.Attributes ?? []).some(
              (a) => a.Key === 'deletion_protection.enabled' && a.Value === 'true'
            );
          },
          disable: async () => {
            await this.getClient().send(
              new ModifyLoadBalancerAttributesCommand({
                LoadBalancerArn: physicalId,
                Attributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
              })
            );
          },
        });
        this.logger.debug(
          `Disabled deletion_protection.enabled on LoadBalancer ${logicalId} before delete`
        );
      } catch (flipError) {
        if (!this.isNotFoundError(flipError)) {
          this.logger.debug(
            `Could not disable deletion_protection.enabled on ${physicalId}: ${describeAwsFailure(flipError).detail}`
          );
        }
      }
    }

    try {
      await this.getClient().send(new DeleteLoadBalancerCommand({ LoadBalancerArn: physicalId }));
      // AWS took the delete. `DeleteLoadBalancer` has no wait after it today,
      // but the latch is what keeps a future one from re-enabling the guard on
      // a load balancer that is already going.
      flip.deleteAccepted = true;
      this.logger.debug(`Successfully deleted LoadBalancer ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`LoadBalancer ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete LoadBalancer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::TargetGroup ──────────────────────

  private async createTargetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating TargetGroup ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    // go-to-k/cdkd#3989: refused before CreateTargetGroup, so a malformed list
    // neither strands a half-wired group nor registers a subset of it.
    const desiredTargets = readTargets(properties['Targets'], 'desired');
    if (desiredTargets.kind === 'malformed') {
      throw markNonRetryable(
        new ProvisioningError(
          `Targets of TargetGroup ${logicalId} is not a list of ${TARGETS_WHAT}` +
            `${targetsSecretCause(desiredTargets)} — the target group was not created`,
          resourceType,
          logicalId
        )
      );
    }

    // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
    // delete the target group this call created (never one that held the name).
    let leftBehindArn: string | undefined;
    try {
      const matcher = properties['Matcher'] as { HttpCode?: string; GrpcCode?: string } | undefined;

      const tgName = sentElbv2Name(properties, logicalId);

      // Whether the cleanup below may delete what CreateTargetGroup returns:
      // on identical settings it hands back a target group that already held
      // the name (go-to-k/cdkd#4403). Asked only when a wiring step can fail.
      const tgAttributes = this.normalizeAttributes(properties['TargetGroupAttributes']);
      const targets = toTargetDescriptions(desiredTargets.items);
      const heldBefore: NameHeldBefore =
        tgAttributes.length > 0 || targets.length > 0
          ? await nameHeldBefore(
              async () =>
                answeredHeld(
                  (
                    await this.getClient().send(
                      new DescribeTargetGroupsCommand({ Names: [tgName] })
                    )
                  ).TargetGroups
                ),
              (error) => hasErrorName(error, ['TargetGroupNotFoundException'])
            )
          : 'free';

      const response = await this.getClient().send(
        new CreateTargetGroupCommand({
          Name: tgName,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          VpcId: properties['VpcId'] as string | undefined,
          TargetType: properties['TargetType'] as TargetTypeEnum | undefined,
          ProtocolVersion: properties['ProtocolVersion'] as string | undefined,
          HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
          HealthCheckPort: properties['HealthCheckPort'] as string | undefined,
          HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
          HealthCheckEnabled:
            properties['HealthCheckEnabled'] !== undefined
              ? Boolean(properties['HealthCheckEnabled'])
              : undefined,
          HealthCheckIntervalSeconds:
            properties['HealthCheckIntervalSeconds'] !== undefined
              ? Number(properties['HealthCheckIntervalSeconds'])
              : undefined,
          HealthCheckTimeoutSeconds:
            properties['HealthCheckTimeoutSeconds'] !== undefined
              ? Number(properties['HealthCheckTimeoutSeconds'])
              : undefined,
          HealthyThresholdCount:
            properties['HealthyThresholdCount'] !== undefined
              ? Number(properties['HealthyThresholdCount'])
              : undefined,
          UnhealthyThresholdCount:
            properties['UnhealthyThresholdCount'] !== undefined
              ? Number(properties['UnhealthyThresholdCount'])
              : undefined,
          IpAddressType: properties['IpAddressType'] as TargetGroupIpAddressTypeEnum | undefined,
          TargetControlPort:
            properties['TargetControlPort'] !== undefined
              ? Number(properties['TargetControlPort'])
              : undefined,
          ...(matcher && { Matcher: matcher }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const tg = response.TargetGroups?.[0];
      if (!tg || !tg.TargetGroupArn) {
        throw new Error('CreateTargetGroup did not return TargetGroup ARN');
      }
      const tgArn = tg.TargetGroupArn;

      this.logger.debug(`Successfully created TargetGroup ${logicalId}: ${tgArn}`);

      // TargetGroupAttributes and Targets ride on separate post-create calls
      // (ModifyTargetGroupAttributes / RegisterTargets). CreateTargetGroup has
      // already committed the TG, so a failure here would strand it outside
      // cdkd state and the next deploy's CREATE would collide on the unique TG
      // name — wrap in the same best-effort-delete-then-rethrow pattern as the
      // LoadBalancer create path above.
      try {
        if (tgAttributes.length > 0) {
          await this.getClient().send(
            new ModifyTargetGroupAttributesCommand({
              TargetGroupArn: tgArn,
              Attributes: tgAttributes,
            })
          );
          this.logger.debug(
            `Applied ${tgAttributes.length} TargetGroup attribute(s) for ${logicalId}`
          );
        }

        if (targets.length > 0) {
          await this.getClient().send(
            new RegisterTargetsCommand({ TargetGroupArn: tgArn, Targets: targets })
          );
          this.logger.debug(`Registered ${targets.length} target(s) for ${logicalId}`);
        }
      } catch (innerError) {
        if (heldBefore !== 'free') {
          this.logger.warn(
            maskerOrIdentity(maskSecrets)(
              skippedCleanupText(
                heldBefore,
                `TargetGroup ${logicalId} (${tgArn})`,
                pasteableAwsCommand(
                  maskSecrets
                )`aws elbv2 delete-target-group --target-group-arn ${tgArn}`.render()
              )
            )
          );
        } else {
          try {
            await this.getClient().send(new DeleteTargetGroupCommand({ TargetGroupArn: tgArn }));
            this.logger.debug(
              `Cleaned up partially-created TargetGroup ${logicalId} (${tgArn}) after wiring failure`
            );
          } catch (cleanupError) {
            leftBehindArn = tgArn;
            this.logger.warn(
              // Masked for uniformity with the sibling lines in this same `try`
              // (issue #2050). The cleanup call carries only a physical ARN, so a
              // resolved property value reaching here would be surprising — but
              // "surprising" is not "impossible", and an unmasked line sitting
              // beside masked ones is what a later author copies.
              `Failed to clean up partially-created TargetGroup ${logicalId} (${tgArn}): ` +
                `${this.maskErrorMessage(cleanupError, maskSecrets)}. Manual deletion may be ` +
                `required before the next deploy: ` +
                `${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-target-group --target-group-arn ${tgArn}`.render()}`
            );
          }
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      return {
        physicalId: tgArn,
        attributes: targetGroupAttributes(tg, tgArn),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapMaskedError(
        maskerOrIdentity(maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create TargetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      if (leftBehindArn !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindArn);
      }
      throw thrown;
    }
  }

  private async updateTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    callerMaskSecrets?: SecretMasker,
    fromReadback = false
  ): Promise<ResourceUpdateResult> {
    // Every line below that can name the target group, its ARN included,
    // masks a pre-rotation secret-derived name too (go-to-k/cdkd#4339).
    const maskSecrets = recordedNameMask(
      callerMaskSecrets,
      previousProperties['Name'],
      targetGroupNameFromArn(physicalId)
    );
    this.logger.debug(`Updating TargetGroup ${logicalId}: ${maskSecrets(physicalId)}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    // IpAddressType is createOnly in the CFn schema (the registry fallback
    // already classifies its change as replacement); TargetControlPort has
    // NO modify API at all AND is missing from the schema's
    // createOnlyProperties, so without this guard a change would be silently
    // dropped. Reject both with ResourceUpdateNotSupportedError — the deploy
    // engine matches it by class and falls back to replacement.
    // TargetControlPort is compared numerically ("8080" vs 8080 is a template
    // quoting difference, not a change); IpAddressType compares as a string.
    const immutableChanged = (key: string, coerce: boolean): boolean => {
      const next = properties[key];
      const prev = previousProperties[key];
      if (coerce) {
        const nextNum = next !== undefined ? Number(next) : undefined;
        const prevNum = prev !== undefined ? Number(prev) : undefined;
        return nextNum !== prevNum;
      }
      return JSON.stringify(next) !== JSON.stringify(prev);
    };
    for (const [immutableKey, coerce] of [
      ['IpAddressType', false],
      ['TargetControlPort', true],
    ] as Array<[string, boolean]>) {
      if (immutableChanged(immutableKey, coerce)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `ELBv2 TargetGroup ${immutableKey} is immutable on AWS — no Modify* API accepts it; it is fixed at creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    // Before ModifyTargetGroup: a malformed desired `Targets` is refused with
    // nothing sent (go-to-k/cdkd#3989).
    const { newTargets, oldTargets } = await this.readUpdateTargets(
      logicalId,
      physicalId,
      resourceType,
      properties['Targets'],
      previousProperties['Targets'],
      properties['Port']
    );

    try {
      // Class 2 sanitize at the wire layer: `readCurrentState` always-emits
      // `Matcher: {}` for non-HTTP/HTTPS target groups (TCP / UDP / GENEVE
      // never carry HttpCode / GrpcCode). Without this guard, `cdkd drift
      // --revert` round-trips the `{}` placeholder back through
      // `ModifyTargetGroup`, which AWS rejects: "Matcher must contain
      // either HttpCode or GrpcCode". Treat the empty object the same as
      // an absent Matcher — drop the key from the API input.
      const rawMatcher = properties['Matcher'] as
        | { HttpCode?: string; GrpcCode?: string }
        | undefined;
      const matcher =
        rawMatcher && (rawMatcher.HttpCode !== undefined || rawMatcher.GrpcCode !== undefined)
          ? rawMatcher
          : undefined;

      // Removal semantics (issue #1160, live CFn A/B 2026-08-10 on an HTTP
      // target group): CloudFormation itself RETAINS every health-check
      // field EXCEPT `HealthCheckPort` when the property is removed from
      // the template — HealthCheckProtocol / HealthCheckPath /
      // HealthCheckEnabled / HealthCheckIntervalSeconds /
      // HealthCheckTimeoutSeconds / HealthyThresholdCount /
      // UnhealthyThresholdCount and the listener's SslPolicy all kept their
      // customized values through a CFn removal update, so cdkd's
      // pass-through (absent -> undefined -> ModifyTargetGroup merge) is
      // already CFn parity for those. `HealthCheckPort` is the one field
      // CFn resets, to its create default `traffic-port`; mirror that.
      // GENEVE target groups are deferred (retain, no reset): their create
      // default is port 80, not `traffic-port`, and CFn's removal behavior
      // for a Gateway Load Balancer TG has not been A/B-verified.
      const targetGroupProtocol = String(
        properties['Protocol'] ?? previousProperties['Protocol'] ?? ''
      ).toUpperCase();
      const healthCheckPort =
        targetGroupProtocol === 'GENEVE'
          ? (properties['HealthCheckPort'] as string | undefined)
          : clearOnUpdateRemoval(
              properties['HealthCheckPort'] as string | undefined,
              previousProperties['HealthCheckPort'] as string | undefined,
              'traffic-port'
            );

      await this.getClient().send(
        new ModifyTargetGroupCommand({
          TargetGroupArn: physicalId,
          HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
          HealthCheckPort: healthCheckPort,
          HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
          HealthCheckEnabled:
            properties['HealthCheckEnabled'] !== undefined
              ? Boolean(properties['HealthCheckEnabled'])
              : undefined,
          HealthCheckIntervalSeconds:
            properties['HealthCheckIntervalSeconds'] !== undefined
              ? Number(properties['HealthCheckIntervalSeconds'])
              : undefined,
          HealthCheckTimeoutSeconds:
            properties['HealthCheckTimeoutSeconds'] !== undefined
              ? Number(properties['HealthCheckTimeoutSeconds'])
              : undefined,
          HealthyThresholdCount:
            properties['HealthyThresholdCount'] !== undefined
              ? Number(properties['HealthyThresholdCount'])
              : undefined,
          UnhealthyThresholdCount:
            properties['UnhealthyThresholdCount'] !== undefined
              ? Number(properties['UnhealthyThresholdCount'])
              : undefined,
          ...(matcher && { Matcher: matcher }),
        })
      );

      // ─── TargetGroupAttributes ───────────────────────────────────────
      // ModifyTargetGroupAttributes replaces ONLY the listed attrs — same
      // key-diff semantics as LoadBalancerAttributes, EXCEPT the removal
      // arm: this API rejects an empty Value ("A target group attribute
      // value must be specified", live-verified 2026-08-11), so a removed
      // key is reset by sending its documented default from
      // TARGET_GROUP_ATTRIBUTE_DEFAULTS; a key with no known default warns
      // and retains the live value. Skip the call when nothing changed.
      // `drift --revert` sends no removal at all (go-to-k/cdkd#4147).
      const tgAttrDiff = this.diffAttributeBag(
        'TargetGroupAttributes',
        logicalId,
        properties['TargetGroupAttributes'],
        previousProperties['TargetGroupAttributes'],
        (key, currentValue) => {
          // Object.hasOwn, not a bare index: `__proto__` / `constructor` /
          // `toString` would otherwise resolve up the prototype chain to a
          // non-string and be submitted as a garbage Value.
          const fallback = Object.hasOwn(TARGET_GROUP_ATTRIBUTE_DEFAULTS, key)
            ? TARGET_GROUP_ATTRIBUTE_DEFAULTS[key]
            : undefined;
          if (fallback === undefined) {
            // `key` comes out of the RESOLVED `TargetGroupAttributes` bag, so a
            // KEY can itself be a resolved secret — the same question
            // `servicediscovery-provider.ts` answers for
            // `DeleteServiceAttributes`, and the two files must not disagree
            // about it. Masked as the raw value (not the finished sentence) so
            // it reaches `maskSecretsInText`'s whole-value arm at any length.
            this.logger.warn(
              `TargetGroup attribute ${maskerOrIdentity(maskSecrets)(key)} was removed from the ` +
                `template but has no documented default cdkd can reset it to — the live value is ` +
                `retained. Set the attribute explicitly to change it.`
            );
            return undefined;
          }
          // Already at the default — nothing to reset. Same safety property as
          // the LB / Listener arms, kept as a guard for any caller whose
          // previous side is not a template (`drift --revert` no longer
          // reaches this resolver; see attributeRemovalResolver's docstring).
          return currentValue === fallback ? undefined : fallback;
        },
        fromReadback,
        maskSecrets
      );
      if (tgAttrDiff.length > 0) {
        await this.getClient().send(
          new ModifyTargetGroupAttributesCommand({
            TargetGroupArn: physicalId,
            Attributes: tgAttrDiff,
          })
        );
        this.logger.debug(
          `Applied ${tgAttrDiff.length} TargetGroupAttributes change(s) for ${logicalId}`
        );
      }

      // ─── Targets ─────────────────────────────────────────────────────
      // RegisterTargets / DeregisterTargets diff keyed on the full
      // (Id, Port, AvailabilityZone) tuple — a changed Port registers the new
      // tuple and deregisters the old one. Register first so a target whose
      // spelling changed never has a window with zero registrations.
      // BOTH sides are normalized against the SAME group port so the keys are
      // comparable — see toTargetDescriptions' note on why the omitted-Port
      // case is a destructive diff rather than a cosmetic one. Both were read
      // by `readUpdateTargets` above.
      const targetKey = (t: TargetDescription) =>
        JSON.stringify([t.Id, t.Port ?? null, t.AvailabilityZone ?? null]);
      const oldTargetKeys = new Set(oldTargets.map(targetKey));
      const newTargetKeys = new Set(newTargets.map(targetKey));
      const targetsToRegister = newTargets.filter((t) => !oldTargetKeys.has(targetKey(t)));
      const targetsToDeregister = oldTargets.filter((t) => !newTargetKeys.has(targetKey(t)));
      if (targetsToRegister.length > 0) {
        await this.getClient().send(
          new RegisterTargetsCommand({ TargetGroupArn: physicalId, Targets: targetsToRegister })
        );
        this.logger.debug(`Registered ${targetsToRegister.length} target(s) for ${logicalId}`);
      }
      if (targetsToDeregister.length > 0) {
        await this.getClient().send(
          new DeregisterTargetsCommand({
            TargetGroupArn: physicalId,
            Targets: targetsToDeregister,
          })
        );
        this.logger.debug(`Deregistered ${targetsToDeregister.length} target(s) for ${logicalId}`);
      }

      // Describe to get current attributes
      const describeResponse = await this.getClient().send(
        new DescribeTargetGroupsCommand({ TargetGroupArns: [physicalId] })
      );
      const tg = describeResponse.TargetGroups?.[0];

      // Apply tag diff. ELBv2 uses AddTags / RemoveTags with [arn].
      await this.applyTagDiff(
        physicalId,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        maskSecrets
      );

      this.logger.debug(`Successfully updated TargetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: targetGroupAttributes(tg ?? {}, physicalId),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        maskerOrIdentity(maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update TargetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting TargetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteTargetGroupCommand({ TargetGroupArn: physicalId }));
      this.logger.debug(`Successfully deleted TargetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`TargetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete TargetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::Listener ─────────────────────────

  /**
   * Does a listener already sit on `port` of `loadBalancerArn`? The listener
   * twin of the by-name lookups (go-to-k/cdkd#4403): a listener has no name,
   * and its port is what CreateListener hands an existing listener back on.
   * Pages through every listener; a page loop that does not end throws, so
   * the caller reads it as `unknown`.
   */
  private async listenerPortHeld(
    loadBalancerArn: string,
    port: number | undefined
  ): Promise<boolean> {
    let marker: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await this.getClient().send(
        new DescribeListenersCommand({
          LoadBalancerArn: loadBalancerArn,
          ...(marker !== undefined && { Marker: marker }),
        })
      );
      if ((response.Listeners ?? []).some((l) => l.Port === port)) return true;
      if (!response.NextMarker) return false;
      marker = response.NextMarker;
    }
    throw new Error('DescribeListeners did not finish paging');
  }

  private async createListener(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Listener ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
    // delete the listener this call created.
    let leftBehindArn: string | undefined;
    try {
      const defaultActions = this.convertActions(
        properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
      );
      const certificates = this.convertCertificates(
        properties['Certificates'] as Array<Record<string, unknown>> | undefined
      );

      const alpnPolicy = properties['AlpnPolicy'] as string[] | undefined;
      const mutualAuth = properties['MutualAuthentication'] as
        | MutualAuthenticationAttributes
        | undefined;

      // Whether the cleanup below may delete what CreateListener returns: on
      // identical settings it hands back the listener already on this port
      // (go-to-k/cdkd#4403). Asked only when a wiring step can fail.
      const listenerAttributes = this.normalizeAttributes(properties['ListenerAttributes']);
      const heldBefore: NameHeldBefore =
        listenerAttributes.length > 0
          ? await nameHeldBefore(
              () =>
                this.listenerPortHeld(
                  properties['LoadBalancerArn'] as string,
                  properties['Port'] !== undefined ? Number(properties['Port']) : undefined
                ),
              (error) => hasErrorName(error, ['LoadBalancerNotFoundException'])
            )
          : 'free';

      const response = await this.getClient().send(
        new CreateListenerCommand({
          LoadBalancerArn: properties['LoadBalancerArn'] as string,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          SslPolicy: properties['SslPolicy'] as string | undefined,
          DefaultActions: defaultActions ?? [],
          ...(certificates && { Certificates: certificates }),
          ...(alpnPolicy && alpnPolicy.length > 0 && { AlpnPolicy: alpnPolicy }),
          ...(mutualAuth !== undefined && { MutualAuthentication: mutualAuth }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const listener = response.Listeners?.[0];
      if (!listener || !listener.ListenerArn) {
        throw new Error('CreateListener did not return Listener ARN');
      }
      const listenerArn = listener.ListenerArn;

      this.logger.debug(`Successfully created Listener ${logicalId}: ${listenerArn}`);

      // CreateListener does NOT accept ListenerAttributes (e.g.
      // `tcp.idle_timeout.seconds`, `routing.http.response.server.enabled`) —
      // they ride on a separate post-create `ModifyListenerAttributes`
      // control-plane call. CreateListener has already committed the listener
      // on AWS, so a failure here would strand a half-configured listener (the
      // throw aborts before the success-return, cdkd state is NOT written, and
      // the next deploy plans CREATE again — but the LB already has a listener
      // on this port, which AWS rejects with `DuplicateListener`). Wrap the
      // attributes call in an inner try/catch that issues a best-effort
      // `DeleteListener` before re-throwing the original error (atomicity),
      // mirroring the LoadBalancer create path above.
      try {
        if (listenerAttributes.length > 0) {
          // Interruptible (issue #2053): without the watch a Ctrl-C here sits
          // out the whole backoff schedule before anything responds.
          const watch = startInterruptWatch(`ELBv2 Listener ${logicalId} attributes`);
          try {
            await withRetry(
              () =>
                this.getClient().send(
                  new ModifyListenerAttributesCommand({
                    ListenerArn: listenerArn,
                    Attributes: listenerAttributes,
                  })
                ),
              logicalId,
              // NOT `this.logger` (issue #2050): `Attributes` here is
              // `properties['ListenerAttributes']`, already RESOLVED, and an AWS
              // rejection quotes the offending value back into the message
              // `withRetry` interpolates.
              {
                logger: this.maskedRetryLogger(maskSecrets),
                isInterrupted: watch.isInterrupted,
                onInterrupted: watch.onInterrupted,
              }
            );
          } finally {
            watch.dispose();
          }
          this.logger.debug(
            `Applied ${listenerAttributes.length} ListenerAttribute(s) for ${logicalId}`
          );
        }
      } catch (innerError) {
        // An interrupt takes the SAME cleanup as any other attributes-wiring
        // failure. That is not symmetry for its own sake, and the tempting
        // opposite — "a Ctrl-C must not delete what the user just made" — was
        // written here first and is WRONG, because it assumes this listener is
        // tracked. It is not: `create()` is throwing, so `newResources[logicalId]`
        // is never set, and only a cleanup that FAILS below marks the ARN for
        // the rollback journal (go-to-k/cdkd#4583). Nothing else holds it.
        //
        // So the choice is not "delete vs preserve" but "delete vs ORPHAN
        // FOREVER". A preserved listener fails the next deploy with
        // `DuplicateListener` — permanently, since `cdkd rollback` skips it and
        // `cdkd destroy` has no record of it — while the engine prints "run
        // deploy again to resume, `cdkd rollback` to revert, or destroy to
        // clean up", all three of which would be false.
        //
        // The handle is printed BEFORE the delete is attempted, at default
        // verbosity, so a process that dies mid-cleanup still leaves the user
        // something to act on. Silent orphan is the one unacceptable outcome.
        if (heldBefore !== 'free') {
          this.logger.warn(
            maskerOrIdentity(maskSecrets)(
              skippedCleanupText(
                heldBefore,
                `Listener ${logicalId} (${listenerArn})`,
                pasteableAwsCommand(
                  maskSecrets
                )`aws elbv2 delete-listener --listener-arn ${listenerArn}`.render()
              )
            )
          );
          throw markAuxiliaryFailure(innerError, logicalId);
        }
        if (isInterruptedWaitError(innerError)) {
          // Routed through the masked sink like every other line in this catch.
          // The three interpolated values are safe on their own — an AWS-minted
          // ARN and a CFn logical id — but the sibling `warn` two lines down
          // argues the discipline directly: an unmasked line sitting beside
          // masked ones is what a later author copies.
          this.logger.warn(
            maskerOrIdentity(maskSecrets)(
              `Interrupted after creating Listener ${logicalId} (${listenerArn}) but before its ` +
                `attributes were applied. Nothing in cdkd state refers to it, so cdkd is deleting ` +
                `it now — left behind it would fail the next deploy with DuplicateListener and ` +
                `destroy could not reach it. If that delete fails, on a first-time create the failed deploy's rollback journal records it for \`cdkd rollback --revert-failed\`; ` +
                `otherwise remove it yourself: ${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-listener --listener-arn ${listenerArn}`.render()}`
            )
          );
        }
        try {
          await this.getClient().send(new DeleteListenerCommand({ ListenerArn: listenerArn }));
          this.logger.debug(
            `Cleaned up partially-created Listener ${logicalId} (${listenerArn}) after attributes-wiring failure`
          );
        } catch (cleanupError) {
          leftBehindArn = listenerArn;
          this.logger.warn(
            // Masked for the same reason as the TargetGroup cleanup above
            // (issue #2050).
            `Failed to clean up partially-created Listener ${logicalId} (${listenerArn}): ` +
              `${this.maskErrorMessage(cleanupError, maskSecrets)}. On a first-time create the failed deploy's rollback ` +
              `journal records it for \`cdkd rollback --revert-failed\`; otherwise delete it yourself ` +
              `before the next deploy: ` +
              `${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-listener --listener-arn ${listenerArn}`.render()}`
          );
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      return {
        physicalId: listenerArn,
        attributes: {
          ListenerArn: listenerArn,
        },
      };
    } catch (error) {
      // `cause` carries the ORIGINAL error untouched (issue #2050): the
      // classifier walks it for `$metadata`, so only the human-readable
      // message is masked.
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapMaskedError(
        maskerOrIdentity(maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create Listener ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      if (leftBehindArn !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindArn);
      }
      throw thrown;
    }
  }

  private async updateListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    maskSecrets?: SecretMasker,
    fromReadback = false
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Listener ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      const defaultActions = this.convertActions(
        properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
      );
      const certificates = this.convertCertificates(
        properties['Certificates'] as Array<Record<string, unknown>> | undefined
      );

      const alpnPolicy = properties['AlpnPolicy'] as string[] | undefined;
      const mutualAuth = properties['MutualAuthentication'] as
        | MutualAuthenticationAttributes
        | undefined;

      await this.getClient().send(
        new ModifyListenerCommand({
          ListenerArn: physicalId,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          SslPolicy: properties['SslPolicy'] as string | undefined,
          ...(defaultActions && { DefaultActions: defaultActions }),
          ...(certificates && { Certificates: certificates }),
          // AlpnPolicy is a TLS-listener-only field; only forward it
          // when the diff actually carries values (CFn template-side it
          // is an array of one entry). An empty array would be rejected
          // by AWS on non-TLS listeners.
          ...(alpnPolicy && alpnPolicy.length > 0 && { AlpnPolicy: alpnPolicy }),
          // MutualAuthentication is HTTPS-listener-only. Forward when
          // the user templated it; AWS will reject on non-HTTPS.
          ...(mutualAuth !== undefined && { MutualAuthentication: mutualAuth }),
        })
      );

      // ─── ListenerAttributes ──────────────────────────────────────────
      // ModifyListenerAttributes replaces ONLY the listed attrs — keys not
      // in the request are left untouched. Build the diff: changed values
      // from newAttrs win; keys present only in oldAttrs are reset. A removed
      // BOOLEAN / ENUM key takes its documented default from
      // LISTENER_ATTRIBUTE_DEFAULTS because this API rejects an empty Value
      // for those — dropping `routing.http.response.server.enabled` failed
      // the whole deploy pre-fix (live-verified 2026-08-11, issue #1609
      // item 1); every other key keeps the empty string, which the API
      // accepts as "clear the override". Skip the call entirely when nothing
      // changed so the no-drift round-trip is a clean no-op. A failure here
      // THROWS (caught by the outer try/catch and re-wrapped as a
      // ProvisioningError) so cdkd state is not written as-if-applied — the
      // next deploy retries. `drift --revert` sends no removal at all
      // (go-to-k/cdkd#4147).
      const submittedAttrs = this.diffAttributeBag(
        'ListenerAttributes',
        logicalId,
        properties['ListenerAttributes'],
        previousProperties['ListenerAttributes'],
        this.attributeRemovalResolver(LISTENER_ATTRIBUTE_DEFAULTS),
        fromReadback,
        maskSecrets
      );
      if (submittedAttrs.length > 0) {
        // Interruptible for the same reason as the create path (issue #2053).
        const watch = startInterruptWatch(`ELBv2 Listener ${logicalId} attributes`);
        try {
          await withRetry(
            () =>
              this.getClient().send(
                new ModifyListenerAttributesCommand({
                  ListenerArn: physicalId,
                  Attributes: submittedAttrs,
                })
              ),
            logicalId,
            // Masked for the same reason as the create path (issue #2050) — the
            // submitted diff is built from `properties` / `previousProperties`,
            // both RESOLVED.
            {
              logger: this.maskedRetryLogger(maskSecrets),
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
            }
          );
        } finally {
          watch.dispose();
        }
        this.logger.debug(
          `Applied ${submittedAttrs.length} ListenerAttributes change(s) for ${logicalId}`
        );
      }

      // Apply tag diff. Listener `handledProperties` doesn't currently
      // include Tags but AWS allows tags on listeners; previous state may
      // hold them after import / drift refresh, so handle the diff for
      // safety.
      await this.applyTagDiff(
        physicalId,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        maskSecrets
      );

      this.logger.debug(`Successfully updated Listener ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          ListenerArn: physicalId,
        },
      };
    } catch (error) {
      // `cause` carries the ORIGINAL error untouched (issue #2050) — see the
      // create path above.
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        maskerOrIdentity(maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Listener ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Listener ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteListenerCommand({ ListenerArn: physicalId }));
      this.logger.debug(`Successfully deleted Listener ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Listener ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Listener ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Normalize a CFn `ListenerAttributes` value (an array of `{ Key, Value }`
   * objects) into the SDK's `Attributes` shape. CFn emits the `Value` as a
   * string (e.g. `"3600"`, `"false"`) — pass it through verbatim; the
   * `ModifyListenerAttributes` API takes string Key/Value pairs. Entries
   * missing a `Key` are dropped (an empty `Value` is a valid "clear the
   * override" signal, so only `Key` is required). Returns `[]` for an
   * absent / non-array value so callers can branch on `.length`.
   *
   * Values are coerced only from `string` / `number` / `boolean` — never
   * `String()`-coerced from an arbitrary object (which would yield
   * `[object Object]`); CFn emits these as strings already, so a non-scalar
   * value is malformed input and is dropped rather than silently stringified.
   */
  private normalizeAttributes(raw: unknown): Array<{ Key: string; Value: string }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ Key: string; Value: string }> = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as { Key?: unknown; Value?: unknown };
      if (typeof e.Key !== 'string') continue;
      let value: string;
      if (e.Value === undefined || e.Value === null) {
        value = '';
      } else if (
        typeof e.Value === 'string' ||
        typeof e.Value === 'number' ||
        typeof e.Value === 'boolean'
      ) {
        value = String(e.Value);
      } else {
        // Non-scalar value — malformed; skip rather than emit [object Object].
        continue;
      }
      out.push({ Key: e.Key, Value: value });
    }
    return out;
  }

  /**
   * Key-diff two normalized `{Key, Value}` attribute lists into the payload
   * for a Modify*Attributes call: changed values from `newAttrs` win, and
   * keys present only in `oldAttrs` are pushed back through `removalValue`.
   * A resolver returning `undefined` SKIPS the entry (the resolver owns any
   * warn). An empty return means nothing changed and the call should be
   * skipped. Shared by the LoadBalancer / TargetGroup / Listener update
   * paths — and all three pass their OWN resolver, because the three APIs
   * disagree about what resets an attribute:
   *
   * - LoadBalancer / Listener: the empty string clears a numeric or
   *   free-form-string override, but a BOOLEAN / ENUM key rejects it and
   *   fails the whole call, so those take a documented default
   *   (`LOAD_BALANCER_ATTRIBUTE_DEFAULTS` / `LISTENER_ATTRIBUTE_DEFAULTS`).
   * - TargetGroup: the empty string is rejected for EVERY key, so the
   *   documented default is the only reset and an unknown key warns and
   *   retains (`TARGET_GROUP_ATTRIBUTE_DEFAULTS`).
   *
   * All three behaviours were live-verified 2026-08-11. `removalValue` is
   * REQUIRED rather than defaulted: there is no reset value that is correct
   * for all three APIs, so a caller that forgets to pass one should fail to
   * compile instead of silently inheriting the empty string that two of the
   * three reject.
   */
  private diffAttributes(
    newAttrs: Array<{ Key: string; Value: string }>,
    oldAttrs: Array<{ Key: string; Value: string }>,
    removalValue: (key: string, currentValue: string) => string | undefined
  ): Array<{ Key: string; Value: string }> {
    const newAttrMap = new Map(newAttrs.map((a) => [a.Key, a.Value]));
    const oldAttrMap = new Map(oldAttrs.map((a) => [a.Key, a.Value]));
    const submitted: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newAttrMap) {
      if (oldAttrMap.get(k) !== v) submitted.push({ Key: k, Value: v });
    }
    for (const [k, currentValue] of oldAttrMap) {
      if (!newAttrMap.has(k)) {
        const value = removalValue(k, currentValue);
        if (value !== undefined) submitted.push({ Key: k, Value: value });
      }
    }
    return submitted;
  }

  /**
   * {@link diffAttributes} over one of the three attribute bags of an
   * `update()`, except on `cdkd drift --revert` (`fromReadback`), where a key
   * the desired side lacks is never sent as a removal (go-to-k/cdkd#4147).
   *
   * There the desired side is the recorded baseline and the previous side the
   * live readback, so such a key is one AWS reports and the baseline does not
   * hold. With an observed baseline that means AWS was not returning the key at
   * capture (an attribute rolled out later, or `ddos_protection.syn_cookie.mode`,
   * which AWS returns intermittently), so cdkd has no recorded value to restore.
   * No Elastic Load Balancing call removes an attribute key, and the removal
   * value is a guess: `''` or a documented default. A rejected `''` (an enum or
   * boolean key) fails the WHOLE Modify call, taking every other reverted
   * attribute of the bag with it. (Without an observed baseline, `runRevert`
   * merges the untemplated keys into the desired side, so none arrives here.)
   *
   * The key keeps its live value, and a warning names it and the remedy, since
   * `cdkd drift` keeps reporting a key only the readback holds: it cannot tell
   * a service-side addition from a value an operator set.
   */
  private diffAttributeBag(
    bag: 'LoadBalancerAttributes' | 'TargetGroupAttributes' | 'ListenerAttributes',
    logicalId: string,
    desired: unknown,
    previous: unknown,
    removalValue: (key: string, currentValue: string) => string | undefined,
    fromReadback: boolean,
    maskSecrets: SecretMasker | undefined
  ): Array<{ Key: string; Value: string }> {
    const leftInPlace: string[] = [];
    const submitted = this.diffAttributes(
      this.normalizeAttributes(desired),
      this.normalizeAttributes(previous),
      fromReadback
        ? (key) => {
            leftInPlace.push(key);
            return undefined;
          }
        : removalValue
    );
    if (leftInPlace.length > 0) {
      // A KEY comes out of the resolved bag, so it is masked as the raw value
      // (the TargetGroup removal warning's rule), then made display-safe.
      const mask = maskerOrIdentity(maskSecrets);
      const keys = leftInPlace.map((key) => mask(key)).join(', ');
      const one = leftInPlace.length === 1;
      const noun = one ? 'key' : 'keys';
      const values = one ? 'its live value' : 'their live values';
      const them = one ? 'it' : 'them';
      const be = one ? 'is' : 'are';
      const theValue = one ? 'the value' : 'the values';
      this.logger.warn(
        safeMsg`${logicalId}: AWS reports ${bag} ${noun} ${keys}, which the recorded baseline holds no value for. No Elastic Load Balancing call removes an attribute key, so the revert leaves ${values} in place, and 'cdkd drift' keeps reporting ${them}. If ${values} ${be} what you intend, run 'cdkd drift --accept' to record ${them}; otherwise declare ${theValue} in the template and deploy.`
      );
    }
    return submitted;
  }

  /**
   * Build the `removalValue` resolver for the LoadBalancer / Listener attribute
   * arms: reset a removed key to its documented default, or to `''` (which
   * those two APIs accept as "clear the override") when no default is known.
   *
   * **A key already AT its default is SKIPPED, and that is a safety property,
   * not an optimization.** It was written for a previous side that is not a
   * template: `cdkd drift --revert` calls `update(..., newProperties,
   * outcome.awsProperties)` (`src/cli/commands/drift.ts`), so `oldAttrs` can be
   * the FULL `readCurrentState` snapshot, where every untemplated key looks
   * REMOVED, and writing a documented default there would silently disable
   * deletion protection, access / connection logs, HTTP/2, WAF fail-open and
   * zonal shift on a live load balancer. That caller no longer reaches this
   * resolver at all ({@link diffAttributeBag}, go-to-k/cdkd#4147); the skip
   * stays for any other caller handing a readback as the previous side.
   *
   * The skip is exact rather than heuristic: a key the user never templated is
   * BY DEFINITION sitting at its default, so it is skipped; a key the template
   * really did set is set to a NON-default value (otherwise templating it
   * would be a no-op), so its reset still fires. A template that set a key to
   * exactly its default and then dropped it is skipped too — correctly, since
   * there is nothing to change.
   */
  private attributeRemovalResolver(
    defaults: Record<string, string>
  ): (key: string, currentValue: string) => string | undefined {
    return (key, currentValue) => {
      // Object.hasOwn, not a bare index: `__proto__` / `constructor` /
      // `toString` would otherwise resolve up the prototype chain to a
      // non-string and emit a garbage Value.
      const fallback = Object.hasOwn(defaults, key) ? defaults[key] : '';
      return currentValue === fallback ? undefined : fallback;
    };
  }

  /**
   * Read both sides of a TargetGroup update's `Targets` (go-to-k/cdkd#3989),
   * mapped to the SDK shape against the SAME group port.
   *
   * A malformed DESIRED side is refused before any call, on every path (a
   * rollback replay and `drift --revert` included): read as empty it would
   * deregister every target the record holds.
   *
   * A malformed RECORDED side is read from the live group instead
   * (`DescribeTargetHealth`), ADD-only: the old side becomes the desired
   * targets the group already holds, so nothing is deregistered on the strength
   * of a record cdkd could not read, and a registered target the desired side
   * omits stays registered, with a warning. `cdkd import` can record an
   * unresolved intrinsic there, which a refusal would wedge forever. A
   * draining target counts as not held, so a desired one is registered again.
   */
  private async readUpdateTargets(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    desiredRaw: unknown,
    recordedRaw: unknown,
    groupPort: unknown
  ): Promise<{ newTargets: TargetDescription[]; oldTargets: TargetDescription[] }> {
    const desired = readTargets(desiredRaw, 'desired');
    if (desired.kind === 'malformed') {
      throw markNonRetryable(
        new ProvisioningError(
          `desired Targets of TargetGroup ${logicalId} is not a list of ${TARGETS_WHAT}` +
            `${targetsSecretCause(desired)} — the target group was not updated`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    const newTargets = toTargetDescriptions(desired.items, groupPort);

    const recorded = readTargets(recordedRaw, 'recorded');
    if (recorded.kind === 'list') {
      return {
        newTargets,
        oldTargets: toTargetDescriptions(removableRecordedTargets(recorded.items), groupPort),
      };
    }

    let live: TargetDescription[];
    try {
      const resp = await this.getClient().send(
        new DescribeTargetHealthCommand({ TargetGroupArn: physicalId })
      );
      live = (resp.TargetHealthDescriptions ?? [])
        .filter((d) => d.TargetHealth?.State !== 'draining')
        .map((d) => d.Target)
        .filter((t): t is TargetDescription => typeof t?.Id === 'string' && t.Id.length > 0);
    } catch (error) {
      // Not marked non-retryable: a throttled read is worth the retry, which
      // classifies through `cause`.
      throw new ProvisioningError(
        `the recorded Targets of TargetGroup ${logicalId} is not a list cdkd can read, and the ` +
          `registered targets could not be read from Elastic Load Balancing instead — the ` +
          `target group was not updated`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
    // A desired entry naming no AvailabilityZone matches a live one in any zone.
    const holds = (want: TargetDescription, have: TargetDescription): boolean =>
      want.Id === have.Id &&
      (want.Port ?? null) === (have.Port ?? null) &&
      (want.AvailabilityZone === undefined || want.AvailabilityZone === have.AvailabilityZone);
    const retained = live.filter((have) => !newTargets.some((want) => holds(want, have)));
    if (retained.length > 0) {
      this.logger.warn(
        safeMsg`The recorded Targets of TargetGroup ${logicalId} is not a list cdkd can read, so cdkd read the registered targets from Elastic Load Balancing; the target group holds ${retained.length} target(s) the desired Targets does not name, and cdkd left them registered. Deregister them yourself if they are no longer wanted.`
      );
    }
    return {
      newTargets,
      oldTargets: newTargets.filter((want) => live.some((have) => holds(want, have))),
    };
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via ELBv2's
   * `AddTags` / `RemoveTags` APIs. Both accept `ResourceArns: [arn]`
   * (single ARN), `Tags: [{Key, Value}]` for AddTags, and
   * `TagKeys: [...]` for RemoveTags. Both sides are read through
   * `planTagDiff` (go-to-k/cdkd#3994): an unreadable record untags nothing.
   */
  private async applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    // A load balancer ARN carries its `Name`, which can be secret-derived
    // (go-to-k/cdkd#4275); absent means unmasked.
    maskSecrets?: SecretMasker
  ): Promise<void> {
    const mask = maskerOrIdentity(maskSecrets);
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const tagsToAdd: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsCommand({ ResourceArns: [arn], TagKeys: tagsToRemove })
      );
      this.logger.debug(mask(`Removed ${tagsToRemove.length} tag(s) from ELBv2 resource ${arn}`));
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(new AddTagsCommand({ ResourceArns: [arn], Tags: tagsToAdd }));
      this.logger.debug(mask(`Added/updated ${tagsToAdd.length} tag(s) on ELBv2 resource ${arn}`));
    }
  }

  /**
   * Convert CDK DefaultActions to ELBv2 API Action format
   * CDK uses PascalCase property names matching the ELBv2 API, so pass through.
   */
  private convertActions(
    actions: Array<Record<string, unknown>> | undefined
  ): Action[] | undefined {
    if (!actions || actions.length === 0) return undefined;
    return actions as unknown as Action[];
  }

  /**
   * Convert CDK Certificates to ELBv2 API Certificate format
   */
  private convertCertificates(
    certificates: Array<Record<string, unknown>> | undefined
  ): Certificate[] | undefined {
    if (!certificates || certificates.length === 0) return undefined;
    return certificates as unknown as Certificate[];
  }

  /**
   * Read the AWS-current ELBv2 resource configuration in CFn-property shape.
   *
   * Dispatch per resource type:
   *  - `LoadBalancer` → `DescribeLoadBalancers` (Name, Subnets via
   *    `AvailabilityZones[].SubnetId`, SecurityGroups, Scheme, Type,
   *    IpAddressType) plus `DescribeLoadBalancerAttributes` for the full
   *    `LoadBalancerAttributes` `[{Key, Value}]` array (sorted by Key for
   *    stable positional compare). AWS returns every attribute valid for
   *    this LB type including defaults the user did not template; on the
   *    v3 observedProperties baseline that's load-bearing — a console-side
   *    change to ANY attribute (templated or not) surfaces as drift.
   *  - `TargetGroup` → `DescribeTargetGroups` (Protocol, Port, VpcId,
   *    TargetType, ProtocolVersion, HealthCheck*, Matcher, Name).
   *  - `Listener` → `DescribeListeners` (LoadBalancerArn, Certificates,
   *    DefaultActions, Port, Protocol, SslPolicy).
   *
   * Tags are surfaced via a follow-up `DescribeTags(ResourceArns=[arn])`
   * for all three types (the `physicalId` cdkd state holds is the ARN).
   * CDK's `aws:*` auto-tags are filtered out and the result key is omitted
   * when AWS reports no user tags. Returns `RESOURCE_NOT_FOUND` when the
   * resource is gone (`*NotFoundException`), `undefined` for another type.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.readLoadBalancer(physicalId);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.readTargetGroup(physicalId);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.readListener(physicalId);
      default:
        return undefined;
    }
  }

  private async readLoadBalancer(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let lb;
    try {
      const resp = await this.getClient().send(
        new DescribeLoadBalancersCommand({ LoadBalancerArns: [physicalId] })
      );
      lb = resp.LoadBalancers?.[0];
    } catch (err) {
      if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }
    if (!lb) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (lb.LoadBalancerName !== undefined) result['Name'] = lb.LoadBalancerName;
    const subnets = (lb.AvailabilityZones ?? [])
      .map((az) => az.SubnetId)
      .filter((id): id is string => !!id);
    result['Subnets'] = subnets;
    result['SecurityGroups'] = lb.SecurityGroups ? [...lb.SecurityGroups] : [];
    if (lb.Scheme !== undefined) result['Scheme'] = lb.Scheme;
    if (lb.Type !== undefined) result['Type'] = lb.Type;
    if (lb.IpAddressType !== undefined) result['IpAddressType'] = lb.IpAddressType;
    if (lb.EnablePrefixForIpv6SourceNat !== undefined) {
      result['EnablePrefixForIpv6SourceNat'] = lb.EnablePrefixForIpv6SourceNat;
    }
    if (lb.EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic !== undefined) {
      result['EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'] =
        lb.EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic;
    }
    // Flatten the SDK's IpamPools wrapper back to the CFn spelling.
    if (lb.IpamPools?.Ipv4IpamPoolId !== undefined) {
      result['Ipv4IpamPoolId'] = lb.IpamPools.Ipv4IpamPoolId;
    }

    // MinimumLoadBalancerCapacity via DescribeCapacityReservation —
    // best-effort like the attribute reads below; emitted only when a
    // reservation is actually set (CapacityUnits > 0) so LBs without one
    // don't grow a phantom key.
    try {
      const capResp = await this.getClient().send(
        new DescribeCapacityReservationCommand({ LoadBalancerArn: physicalId })
      );
      const units = capResp.MinimumLoadBalancerCapacity?.CapacityUnits;
      if (units !== undefined && units > 0) {
        result['MinimumLoadBalancerCapacity'] = { CapacityUnits: units };
      }
    } catch (err) {
      if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err)) return undefined;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

    // LoadBalancerAttributes via DescribeLoadBalancerAttributes. AWS
    // returns the FULL attribute set (every key valid for this LB type,
    // including AWS-defaulted values the user did not template). We sort
    // by Key for stable positional compare and emit the whole list, so a
    // console-side change to any attribute (templated or not) surfaces
    // as drift on the v3 observedProperties baseline (which captures
    // the same full set at deploy time); an undeclared key AWS stops
    // returning is not drift (`canonicalizeDriftPair`). On the v2 fallback baseline
    // (state.properties) users templating only a subset will see drift
    // on the AWS-defaulted keys — that's the v2 limitation in general
    // and the documented motivation for upgrading to v3 / running
    // `cdkd state refresh-observed`.
    try {
      const attrsResp = await this.getClient().send(
        new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: physicalId })
      );
      const attrs = (attrsResp.Attributes ?? [])
        .filter(
          (a): a is { Key: string; Value: string } =>
            typeof a.Key === 'string' && typeof a.Value === 'string'
        )
        .map((a) => ({ Key: a.Key, Value: a.Value }))
        .sort((a, b) => a.Key.localeCompare(b.Key));
      result['LoadBalancerAttributes'] = attrs;
    } catch (err) {
      if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err)) return undefined;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

    await this.attachTags(result, physicalId);
    return result;
  }

  private async readTargetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let tg;
    try {
      const resp = await this.getClient().send(
        new DescribeTargetGroupsCommand({ TargetGroupArns: [physicalId] })
      );
      tg = resp.TargetGroups?.[0];
    } catch (err) {
      if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }
    if (!tg) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (tg.TargetGroupName !== undefined) result['Name'] = tg.TargetGroupName;
    if (tg.Protocol !== undefined) result['Protocol'] = tg.Protocol;
    if (tg.Port !== undefined) result['Port'] = tg.Port;
    if (tg.VpcId !== undefined) result['VpcId'] = tg.VpcId;
    if (tg.TargetType !== undefined) result['TargetType'] = tg.TargetType;
    if (tg.ProtocolVersion !== undefined) result['ProtocolVersion'] = tg.ProtocolVersion;
    if (tg.HealthCheckProtocol !== undefined)
      result['HealthCheckProtocol'] = tg.HealthCheckProtocol;
    if (tg.HealthCheckPort !== undefined) result['HealthCheckPort'] = tg.HealthCheckPort;
    if (tg.HealthCheckPath !== undefined) result['HealthCheckPath'] = tg.HealthCheckPath;
    if (tg.HealthCheckEnabled !== undefined) result['HealthCheckEnabled'] = tg.HealthCheckEnabled;
    if (tg.HealthCheckIntervalSeconds !== undefined) {
      result['HealthCheckIntervalSeconds'] = tg.HealthCheckIntervalSeconds;
    }
    if (tg.HealthCheckTimeoutSeconds !== undefined) {
      result['HealthCheckTimeoutSeconds'] = tg.HealthCheckTimeoutSeconds;
    }
    if (tg.HealthyThresholdCount !== undefined) {
      result['HealthyThresholdCount'] = tg.HealthyThresholdCount;
    }
    if (tg.UnhealthyThresholdCount !== undefined) {
      result['UnhealthyThresholdCount'] = tg.UnhealthyThresholdCount;
    }
    if (tg.IpAddressType !== undefined) result['IpAddressType'] = tg.IpAddressType;
    if (tg.TargetControlPort !== undefined) result['TargetControlPort'] = tg.TargetControlPort;
    const matcher: Record<string, unknown> = {};
    if (tg.Matcher?.HttpCode !== undefined) matcher['HttpCode'] = tg.Matcher.HttpCode;
    if (tg.Matcher?.GrpcCode !== undefined) matcher['GrpcCode'] = tg.Matcher.GrpcCode;
    result['Matcher'] = matcher;

    // TargetGroupAttributes via DescribeTargetGroupAttributes — the FULL
    // attribute set sorted by Key, same model as LoadBalancerAttributes /
    // ListenerAttributes.
    try {
      const attrsResp = await this.getClient().send(
        new DescribeTargetGroupAttributesCommand({ TargetGroupArn: physicalId })
      );
      const attrs = (attrsResp.Attributes ?? [])
        .filter(
          (a): a is { Key: string; Value: string } =>
            typeof a.Key === 'string' && typeof a.Value === 'string'
        )
        .map((a) => ({ Key: a.Key, Value: a.Value }))
        .sort((a, b) => a.Key.localeCompare(b.Key));
      result['TargetGroupAttributes'] = attrs;
    } catch (err) {
      if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err)) return undefined;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

    await this.attachRegisteredTargets(result, physicalId);
    await this.attachTags(result, physicalId);
    return result;
  }

  /**
   * Read the target group's REGISTERED targets back in CFn `Targets` shape via
   * `DescribeTargetHealth` (issue
   * [#1620](https://github.com/go-to-k/cdkd/issues/1620)).
   *
   * Two things make this safe to compare, and both were the reason `Targets`
   * sat in {@link getDriftUnknownPaths} until now:
   *
   *  - **Order.** AWS does not guarantee a readback order for the target list,
   *    and the drift comparator compares arrays positionally. The type now
   *    declares `Targets` in {@link getDriftUnorderedPaths}, which sorts the
   *    list on BOTH comparison sides — so a reorder is not drift.
   *  - **Draining.** Deregistration is asynchronous: a just-removed target
   *    keeps reporting for minutes with `TargetHealth.State === 'draining'`.
   *    Including one would freeze it into the deploy-time `observedProperties`
   *    snapshot and produce PERMANENT phantom drift against every later read,
   *    once it finally disappears. `draining` means "being removed", so the
   *    registered set deliberately excludes it. Every other state (`initial`
   *    right after `RegisterTargets`, `unused` for a target with no listener,
   *    `unhealthy`, `unavailable`) IS a registered target and is included —
   *    health is not registration.
   *
   * Two AWS-SUBSTITUTED values are dropped, because echoing back a value the
   * template never wrote is phantom drift against a `properties`-fallback
   * baseline — and, worse, a DESTRUCTIVE one: `updateTargetGroup` keys its
   * register / deregister diff on the whole `(Id, Port, AvailabilityZone)`
   * tuple, so one extra member makes the SAME live target read as a different
   * one and `--revert` deregisters it.
   *
   *  - `Port` when it equals the target group's own port — what AWS
   *    substitutes for a target registered without one. (`toTargetDescriptions`
   *    closes the same gap from the other direction, so a template that DOES
   *    spell the port out still keys identically.)
   *  - `AvailabilityZone` unless the group is `ip`-typed and AWS reported
   *    something other than its `all` default. CFn only accepts the member for
   *    `ip` targets, and `DeregisterTargets` rejects it on an instance group.
   *
   * Known bound: if `DescribeTargetHealth` were to return an empty list in the
   * window right after `RegisterTargets`, the deploy-time snapshot would
   * freeze `Targets: []` against a template that declares some. Not observed —
   * `RegisterTargets` is synchronous and the integ's post-deploy drift run
   * sees all three fixture targets — and left unguarded deliberately, since
   * treating an empty readback as unreadable would also blind a legitimately
   * emptied target group.
   *
   * On error the key is left ABSENT rather than emitted empty. That is not
   * silent: against an observed baseline that HOLDS targets, an absent key
   * still reports them as drifted. It is the honest option available — the
   * read failed, so the live set is unknown — and it keeps `--revert` from
   * acting on a fabricated empty list.
   */
  private async attachRegisteredTargets(
    result: Record<string, unknown>,
    targetGroupArn: string
  ): Promise<void> {
    try {
      const resp = await this.getClient().send(
        new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })
      );
      const groupPort = typeof result['Port'] === 'number' ? result['Port'] : undefined;
      const isIpTargetGroup = result['TargetType'] === 'ip';
      const targets: CfnTargetDescription[] = [];
      for (const desc of resp.TargetHealthDescriptions ?? []) {
        if (desc.TargetHealth?.State === 'draining') continue;
        const id = desc.Target?.Id;
        if (typeof id !== 'string' || id.length === 0) continue;
        const port = desc.Target?.Port;
        const az = desc.Target?.AvailabilityZone;
        targets.push({
          Id: id,
          ...(port !== undefined && port !== groupPort && { Port: port }),
          ...(isIpTargetGroup && az !== undefined && az !== 'all' && { AvailabilityZone: az }),
        });
      }
      result['Targets'] = targets;
    } catch (err) {
      // Permission errors etc — leave the key absent rather than reporting
      // every registered target as removed. Swallowed (not NotFound-mapped to
      // `undefined` like the attributes read above) because the
      // DescribeTargetGroups + DescribeTargetGroupAttributes calls that
      // precede it already surface a deleted target group; this mirrors
      // `attachTags`, the sibling best-effort enrichment.
      this.logger.debug(
        `ELBv2 DescribeTargetHealth(${targetGroupArn}) failed: ${describeAwsFailure(err).detail}`
      );
    }
  }

  /**
   * `Targets` is scoped PER RESOURCE (issue
   * [#1602](https://github.com/go-to-k/cdkd/issues/1602)'s seam), not switched
   * off for the type: it is compared only for a target group whose TEMPLATE
   * declares `Targets`.
   *
   * The reason is the issue [#1498](https://github.com/go-to-k/cdkd/issues/1498)
   * class. A target group fronting an ECS service or an ASG declares NO
   * `Targets` — the sibling resource registers them, and it keeps
   * re-registering as it scales. Comparing an undeclared target list would
   * therefore report drift on every scale event of an untouched stack, and
   * `--revert` would DEREGISTER the tasks the service just placed. The
   * `undeclaredEmptyObservedKeys` guard only covers the case where the capture
   * happened to be EMPTY, which for a redeployed running service it is not.
   *
   * An absent properties bag falls back to COMPARING, per the method's
   * contract — hiding real drift is the worse failure, and the only caller
   * that omits the bag today is not `cdkd drift`.
   */
  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        // EnableCapacityReservationProvisionStabilize is a CFn-only
        // orchestration flag (wait-for-provisioned opt-in) with no AWS-side
        // readback — it is not a resource property on the wire.
        return ['EnableCapacityReservationProvisionStabilize'];
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        if (
          properties !== undefined &&
          Object.keys(properties).length > 0 &&
          properties['Targets'] === undefined
        ) {
          return ['Targets'];
        }
        return [];
      default:
        return [];
    }
  }

  /**
   * `Targets` is a semantically UNORDERED set: `RegisterTargets` /
   * `DeregisterTargets` are set operations (the provider's own update path
   * key-diffs them rather than comparing positions), and `DescribeTargetHealth`
   * documents no ordering guarantee. Declared here rather than sorted inside
   * {@link attachRegisteredTargets} so the sort applies to BOTH comparison
   * sides — see {@link ResourceProvider.getDriftUnorderedPaths}, whose header
   * records why one-sided sorting manufactures drift on the
   * `properties`-fallback baseline.
   *
   * `TargetGroupAttributes` needs no declaration: it is a `{Key, Value}` list,
   * which the shared tag-list canonicalizer already sorts on both sides.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::ElasticLoadBalancingV2::TargetGroup') return [];
    return ['Targets'];
  }

  /**
   * Drop from the BASELINE an attribute-bag entry whose key the template never
   * declared and the readback no longer reports (go-to-k/cdkd#4144).
   *
   * The attribute readbacks emit every key AWS returns, and the observed
   * baseline captured the same. AWS can stop returning an undeclared key
   * (`ddos_protection.syn_cookie.mode` came and went between two reads of one
   * ALB), and nobody out-of-band can cause that: the Modify*Attributes APIs
   * set values and never remove a key. The key set otherwise moves only with
   * the resource's own configuration (a listener's protocol), which is compared
   * on its own. So that one-sided absence is not drift, and `--revert` must not
   * write the key back.
   *
   * Still compared: a DECLARED key that changed or vanished, an undeclared key
   * present on both sides, and a key only the readback holds. Fails closed
   * (identity) when the readback bag is not an array (its read failed) or is
   * empty (a degenerate reply), or the
   * declared bag is present but not a list of string `Key`s, since then which
   * keys are declared is unknown.
   *
   * Only the baseline is trimmed, so `--accept` (which writes the readback
   * side) persists nothing new. `--revert` sends this baseline as its desired
   * side against the readback as previous; the dropped key is on neither, so
   * `diffAttributes` submits nothing for it.
   */
  async canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    properties?: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    const unchanged = { baseline, aws };
    const bagKey = ATTRIBUTE_BAG_BY_TYPE.get(resourceType);
    if (bagKey === undefined) return unchanged;
    const recorded = baseline[bagKey];
    const live = aws[bagKey];
    // An EMPTY readback is a degenerate read (no `Attributes` in the reply),
    // not a report that every key vanished: dropping on it would hide the bag.
    if (!Array.isArray(recorded) || !Array.isArray(live) || live.length === 0) return unchanged;
    const declared = properties?.[bagKey];
    const declaredKeys = new Set<string>();
    if (declared !== undefined) {
      if (!Array.isArray(declared)) return unchanged;
      for (const entry of declared) {
        const key = attributeEntryKey(entry);
        if (key === undefined) return unchanged;
        declaredKeys.add(key);
      }
    }
    const liveKeys = new Set<string>();
    for (const entry of live) {
      const key = attributeEntryKey(entry);
      if (key !== undefined) liveKeys.add(key);
    }
    const kept = recorded.filter((entry) => {
      const key = attributeEntryKey(entry);
      return key === undefined || declaredKeys.has(key) || liveKeys.has(key);
    });
    if (kept.length === recorded.length) return unchanged;
    return { baseline: { ...baseline, [bagKey]: kept }, aws };
  }

  private async readListener(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let listener;
    try {
      const resp = await this.getClient().send(
        new DescribeListenersCommand({ ListenerArns: [physicalId] })
      );
      listener = resp.Listeners?.[0];
    } catch (err) {
      if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }
    if (!listener) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (listener.LoadBalancerArn !== undefined) {
      result['LoadBalancerArn'] = listener.LoadBalancerArn;
    }
    if (listener.Port !== undefined) result['Port'] = listener.Port;
    if (listener.Protocol !== undefined) result['Protocol'] = listener.Protocol;
    if (listener.SslPolicy !== undefined) result['SslPolicy'] = listener.SslPolicy;
    result['Certificates'] = (listener.Certificates ?? []).map((c) => {
      const out: Record<string, unknown> = {};
      if (c.CertificateArn !== undefined) out['CertificateArn'] = c.CertificateArn;
      if (c.IsDefault !== undefined) out['IsDefault'] = c.IsDefault;
      return out;
    });
    // CDK already uses PascalCase that matches AWS SDK shape; pass through
    // the keys the SDK returns. Cast to unknown via Record so the
    // comparator's deep-equal handles the structured comparison.
    result['DefaultActions'] = (listener.DefaultActions ?? []).map(
      (a) => a as unknown as Record<string, unknown>
    );
    // AlpnPolicy / MutualAuthentication are conditional on listener
    // protocol but always-emitted as user-controllable knobs so the v3
    // observedProperties baseline catches console-side ADDs (PR #145
    // pattern). AlpnPolicy is `[]` for non-TLS listeners; the
    // `MutualAuthentication` placeholder mirrors the `{}` shape AWS
    // returns when a user toggles it on.
    result['AlpnPolicy'] = listener.AlpnPolicy ?? [];
    result['MutualAuthentication'] = listener.MutualAuthentication ?? {};

    // ListenerAttributes via DescribeListenerAttributes. AWS returns the FULL
    // attribute set (every key valid for this listener type, including
    // AWS-defaulted values the user did not template). Sort by Key for a
    // stable positional compare and emit the whole list, so a console-side
    // change to any attribute surfaces as drift on the v3 observedProperties
    // baseline (which captures the same full set at deploy time) — the same
    // model as LoadBalancerAttributes above.
    try {
      const attrsResp = await this.getClient().send(
        new DescribeListenerAttributesCommand({ ListenerArn: physicalId })
      );
      const attrs = (attrsResp.Attributes ?? [])
        .filter(
          (a): a is { Key: string; Value: string } =>
            typeof a.Key === 'string' && typeof a.Value === 'string'
        )
        .map((a) => ({ Key: a.Key, Value: a.Value }))
        .sort((a, b) => a.Key.localeCompare(b.Key));
      result['ListenerAttributes'] = attrs;
    } catch (err) {
      if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err)) return undefined;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

    await this.attachTags(result, physicalId);
    return result;
  }

  /** Best-effort tag fetch via `DescribeTags(ResourceArns=[arn])`. */
  private async attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    try {
      const resp = await this.getClient().send(new DescribeTagsCommand({ ResourceArns: [arn] }));
      const tagDesc = resp.TagDescriptions?.[0];
      const tags = normalizeAwsTagsToCfn(tagDesc?.Tags);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(`ELBv2 DescribeTags(${arn}) failed: ${describeAwsFailure(err).detail}`);
    }
  }

  /**
   * Adopt an existing ELBv2 LoadBalancer or TargetGroup into cdkd state.
   *
   * Lookup: `--resource <id>=<arn>` override → verify with
   * `DescribeLoadBalancers` or `DescribeTargetGroups`. Without one, a
   * template `Name` is looked up by the name the create would send
   * ({@link sentElbv2Name}); with neither, the resource is reported as
   * not-found.
   *
   * The by-name lookup is also the go-to-k/cdkd#3937 name probe: both creates
   * answer success with the existing resource when one of that name has the
   * same settings, so the deploy asks here first. Only the service's own
   * not-found error reads as free: anything else, more than one match, or an
   * answer naming none throws, which the probe refuses on.
   *
   * Listener is likewise not auto-importable (no template-supplied stable
   * identifier); use `--resource <listenerId>=<arn>` for those.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.importLoadBalancer(input);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.importTargetGroup(input);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        // Listener: only honor explicit overrides.
        if (input.knownPhysicalId) {
          return { physicalId: input.knownPhysicalId, attributes: {} };
        }
        return null;
      default:
        return null;
    }
  }

  private async importLoadBalancer(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeLoadBalancersCommand({ LoadBalancerArns: [input.knownPhysicalId] })
        );
        // Issue #3627: the same map `create()` records; the resolver has no
        // ELBv2 arm, so without it every attribute resolved to the ARN.
        const lb = resp.LoadBalancers?.[0];
        return lb?.LoadBalancerArn
          ? {
              physicalId: lb.LoadBalancerArn,
              attributes: loadBalancerAttributes(lb, lb.LoadBalancerArn),
            }
          : null;
      } catch (err) {
        if (this.isNotFoundError(err)) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Without a template `Name` there is nothing to look up.
    const name = explicitElbv2Name(input);
    if (name === undefined) return null;
    let resp: DescribeLoadBalancersCommandOutput;
    try {
      resp = await this.getClient().send(new DescribeLoadBalancersCommand({ Names: [name] }));
    } catch (err) {
      // By ERROR NAME only: `isNotFoundError` also matches message text, and
      // a lookup that did not answer must never read as "the name is free".
      if ((err as { name?: unknown }).name === 'LoadBalancerNotFoundException') return null;
      throw err;
    }
    const lb = onlyNamedMatch(resp.LoadBalancers, (l) => l.LoadBalancerArn, 'load balancer');
    return { physicalId: lb.arn, attributes: loadBalancerAttributes(lb.item, lb.arn) };
  }

  private async importTargetGroup(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeTargetGroupsCommand({ TargetGroupArns: [input.knownPhysicalId] })
        );
        // Issue #3627: the same map `create()` records.
        const tg = resp.TargetGroups?.[0];
        return tg?.TargetGroupArn
          ? {
              physicalId: tg.TargetGroupArn,
              attributes: targetGroupAttributes(tg, tg.TargetGroupArn),
            }
          : null;
      } catch (err) {
        if (this.isNotFoundError(err)) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk (issue #1134); without a template `Name`
    // there is nothing to look up.
    const name = explicitElbv2Name(input);
    if (name === undefined) return null;
    let resp: DescribeTargetGroupsCommandOutput;
    try {
      resp = await this.getClient().send(new DescribeTargetGroupsCommand({ Names: [name] }));
    } catch (err) {
      // By ERROR NAME only, as for the load balancer lookup.
      if ((err as { name?: unknown }).name === 'TargetGroupNotFoundException') return null;
      throw err;
    }
    const tg = onlyNamedMatch(resp.TargetGroups, (t) => t.TargetGroupArn, 'target group');
    return { physicalId: tg.arn, attributes: targetGroupAttributes(tg.item, tg.arn) };
  }

  /**
   * Check if an error indicates the resource was not found
   */
  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = (error.message || '').toLowerCase();
    const name = (error as { name?: string }).name ?? '';
    return (
      message.includes('not found') ||
      message.includes('does not exist') ||
      name === 'LoadBalancerNotFoundException' ||
      name === 'TargetGroupNotFoundException' ||
      name === 'ListenerNotFoundException'
    );
  }
}
