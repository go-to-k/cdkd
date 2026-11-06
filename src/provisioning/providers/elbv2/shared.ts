import type { TargetDescription } from '@aws-sdk/client-elastic-load-balancing-v2';
import { definedAttributes } from '../../attribute-map.js';
import { generateResourceNameWithFallback } from '../../resource-name.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import type { ResourceImportInput, SecretMasker } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import type { ProtectionGuardSite } from '../deletion-protection-compensation.js';

/**
 * The `Name` a load balancer ARN carries
 * (`...:loadbalancer/app/<name>/<id>`), or `undefined` when the physical id is
 * not one, so the caller keeps its own comparison (go-to-k/cdkd#4275).
 */
export function loadBalancerNameFromArn(arn: string): string | undefined {
  return nameFromElbv2Arn(arn, ':loadbalancer/', 3);
}

/**
 * The `Name` a target group ARN carries (`...:targetgroup/<name>/<id>`), or
 * `undefined` when the physical id is not one (go-to-k/cdkd#4339).
 */
export function targetGroupNameFromArn(arn: string): string | undefined {
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
export function sentElbv2Name(
  properties: Record<string, unknown>,
  logicalIdForFallback: string
): string {
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
export function explicitElbv2Name(input: ResourceImportInput): string | undefined {
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
export function answeredHeld(items: unknown[] | undefined): true {
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
export function onlyNamedMatch<T>(
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
export function nameFromElbv2Arn(
  arn: string,
  marker: string,
  segments: number
): string | undefined {
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
export function recordedNameMask(
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
export interface CfnTargetDescription {
  Id?: string;
  Port?: number | string;
  AvailabilityZone?: string;
  QuicServerId?: string;
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
export type TargetsSide = 'desired' | 'recorded';

export type TargetsRead =
  | { kind: 'list'; items: CfnTargetDescription[] }
  // `onlySecret`: well-shaped, and malformed ONLY because an `Id` or
  // `QuicServerId` holds a dynamic reference or its mask.
  | { kind: 'malformed'; onlySecret: boolean };

/** An integer port, as a number or a digit string (CFn coerces scalars). */
export function isTargetPort(value: unknown): boolean {
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
export function isWellFormedTarget(
  entry: unknown,
  side: TargetsSide,
  ignoreSecrets = false
): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  const id = e['Id'];
  if (typeof id !== 'string' || id.length === 0) return false;
  // The `QuicServerId` is a wire value too: a recorded reference or mask there
  // would reach RegisterTargets / DeregisterTargets as a literal token.
  if (
    side === 'desired' &&
    !ignoreSecrets &&
    (holdsSecretDerivedEntry(id) || holdsSecretDerivedEntry(e['QuicServerId']))
  ) {
    return false;
  }
  if (e['Port'] != null && !isTargetPort(e['Port'])) return false;
  const az = e['AvailabilityZone'];
  const quic = e['QuicServerId'];
  if (quic != null && (typeof quic !== 'string' || quic.length === 0)) return false;
  return az == null || (typeof az === 'string' && az.length > 0);
}

/** Read one `Targets` value; ABSENT (`undefined` / `null`) reads as the empty list. */
export function readTargets(value: unknown, side: TargetsSide): TargetsRead {
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
 * A recorded `Targets` list minus every entry whose `Id` or `QuicServerId` is secret-derived: the
 * diff would otherwise deregister a literal `{{resolve:...}}` id. Dropping it
 * only misses that one removal, the safe direction.
 */
export function removableRecordedTargets(items: CfnTargetDescription[]): CfnTargetDescription[] {
  return items.filter(
    (e) => !holdsSecretDerivedEntry(e.Id) && !holdsSecretDerivedEntry(e.QuicServerId)
  );
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
export function toTargetDescriptions(
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
      ...(e.QuicServerId != null && { QuicServerId: e.QuicServerId }),
    };
  });
}

/** The refusal's cause clause for a desired list refused only for a dynamic reference. */
export function targetsSecretCause(read: TargetsRead): string {
  return read.kind === 'malformed' && read.onlySecret
    ? ' (an Id or QuicServerId holds a dynamic reference or its mask, which names no target Elastic Load ' +
        'Balancing accepts)'
    : '';
}

export const TARGETS_WHAT =
  'targets, each with a string Id and, where given, an integer Port, a string AvailabilityZone and a string QuicServerId';

/**
 * The removal resolver of all three attribute bags: a key REMOVED from
 * `LoadBalancerAttributes` / `TargetGroupAttributes` / `ListenerAttributes` is
 * never sent, so it keeps its live value. That is CloudFormation parity, not a
 * gap (issue #1160, CFn A/B us-east-1 2026-10-17): a CloudFormation update
 * that dropped one key or the whole list left every value as it was, for a
 * target group (`deregistration_delay.timeout_seconds`), a load balancer
 * (`routing.http.drop_invalid_header_fields.enabled`, `access_logs.s3.*`) and
 * a listener (`routing.http.response.x_frame_options.header_value`,
 * `routing.http.response.server.enabled`). No Elastic Load Balancing call
 * removes an attribute key either.
 */
export const RETAIN_REMOVED_ATTRIBUTE = (): undefined => undefined;

/**
 * The LoadBalancer attribute keys that point log delivery at an S3 bucket
 * (`access_logs.s3.*`, `connection_logs.s3.*`, `health_check_logs.s3.*`). A
 * removed one is kept like any other key, but warned about: see
 * `updateLoadBalancer`.
 */
export const LOG_DELIVERY_ATTRIBUTE = /^[a-z_]+_logs\.s3\./;

/**
 * The Listener attribute keys whose kept value can silently mislead a client
 * or a backend: a CORS response header (`routing.http.response.access_control_*`,
 * a cross-origin grant) and a request-header rename
 * (`routing.http.request.<header>.header_name`, the mTLS client-certificate and
 * TLS headers): once the rename is dropped from the template the app reads the
 * default name again, while the ALB keeps writing the renamed one, so a
 * client-supplied header under the default name may be trusted. A removed one
 * is kept like any other key, but warned about: see `updateListener`. Security
 * response headers (HSTS, CSP, frame options) fail safe when kept: no warning.
 */
export const MISLEADING_IF_KEPT_ATTRIBUTE =
  /^routing\.http\.(response\.access_control_|request\.[a-z0-9_]+\.header_name$)/;

/**
 * The attribute map a load balancer records, shared by `create()` and
 * `import()` (issue #3627).
 */
export function loadBalancerAttributes(
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
export function targetGroupAttributes(
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
export const ATTRIBUTE_BAG_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'LoadBalancerAttributes'],
  ['AWS::ElasticLoadBalancingV2::TargetGroup', 'TargetGroupAttributes'],
  ['AWS::ElasticLoadBalancingV2::Listener', 'ListenerAttributes'],
]);

/** An attribute entry's string `Key`, or `undefined` when it has none. */
export function attributeEntryKey(entry: unknown): string | undefined {
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
export function isElbv2NotFoundName(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return (
    name === 'LoadBalancerNotFoundException' ||
    name === 'TargetGroupNotFoundException' ||
    name === 'ListenerNotFoundException'
  );
}

/**
 * go-to-k/cdkd#4606: the ARN form each type's physical id takes on both
 * routes (Cloud Control's primary identifier is the ARN too), with the
 * partition, region and account captured. The last segment(s) are the
 * AWS-generated id a create mints, so a re-created resource of the same name
 * gets another ARN.
 */
export const ELBV2_ARN_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  [
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
    /^arn:(aws[a-z-]*):elasticloadbalancing:([a-z0-9-]+):(\d{12}):loadbalancer\/(?:app|net|gwy)\/[A-Za-z0-9-]+\/[0-9a-f]+$/,
  ],
  [
    'AWS::ElasticLoadBalancingV2::TargetGroup',
    /^arn:(aws[a-z-]*):elasticloadbalancing:([a-z0-9-]+):(\d{12}):targetgroup\/[A-Za-z0-9-]+\/[0-9a-f]+$/,
  ],
  [
    'AWS::ElasticLoadBalancingV2::Listener',
    /^arn:(aws[a-z-]*):elasticloadbalancing:([a-z0-9-]+):(\d{12}):listener\/(?:app|net|gwy)\/[A-Za-z0-9-]+\/[0-9a-f]+\/[0-9a-f]+$/,
  ],
]);

/**
 * go-to-k/cdkd#4606: the `partition:region:account` scope of an ELBv2 ARN of
 * `resourceType`, or `undefined` for any other form (a name, another type's
 * ARN, another type).
 */
export function elbv2ArnScope(resourceType: string, physicalId: string): string | undefined {
  const match = ELBV2_ARN_PATTERNS.get(resourceType)?.exec(physicalId);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : undefined;
}

/**
 * Issue #1160: Listener properties whose REMOVAL `ModifyListener` does not
 * apply. The API keeps any field it is not sent, and cdkd sends no reset,
 * because CloudFormation keeps each of them too (CFn A/B us-east-1
 * 2026-10-20: every one of the six, removed alone and removed beside a
 * DefaultActions change, kept its live value, and no update failed). Each
 * still changes how a client connects (port, protocol, TLS policy,
 * certificate, ALPN, mTLS), so a kept value can mislead, and each is named in
 * `updateListener`'s own warning.
 */
export const LISTENER_LEFT_IN_PLACE_ON_REMOVAL = [
  'AlpnPolicy',
  'Certificates',
  'MutualAuthentication',
  'Port',
  'Protocol',
  'SslPolicy',
] as const;

/**
 * The protocol change after which ModifyListener itself drops `SslPolicy` and
 * `Certificates` ("Changing the protocol from HTTPS to HTTP, or from TLS to
 * TCP, removes the security policy and default certificate properties", the
 * ModifyListener API reference), keyed by the previous protocol.
 */
export const LISTENER_TLS_DOWNGRADE: ReadonlyMap<string, string> = new Map([
  ['HTTPS', 'HTTP'],
  ['TLS', 'TCP'],
]);

export const CLEARED_BY_TLS_DOWNGRADE: ReadonlySet<string> = new Set(['SslPolicy', 'Certificates']);

/**
 * The ONE warning line for {@link LISTENER_LEFT_IN_PLACE_ON_REMOVAL} removals.
 * Names are template-borne, so they go through `safeMsg`. The deploy line
 * says CloudFormation keeps the value too (the CFn A/B above). A rollback
 * revert restores an earlier state record, so there the property is one the
 * failed deploy ADDED, and the line says that instead.
 */
export const listenerLeftInPlaceWarning = (
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback'
): string => {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  return caller === 'rollback'
    ? safeMsg`${logicalId} (AWS::ElasticLoadBalancingV2::Listener): ${subject} ${names.join(', ')} ${one ? 'is' : 'are'} absent from the state being restored; ModifyListener keeps a setting it is not sent, so the rollback leaves the value the failed deploy applied in place.`
    : safeMsg`${logicalId} (AWS::ElasticLoadBalancingV2::Listener): ${subject} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template and ${one ? 'keeps its' : 'keep their'} current AWS value, as CloudFormation leaves ${one ? 'it' : 'them'}; ModifyListener keeps a setting it is not sent. Declare the intended value explicitly to change it.`;
};
