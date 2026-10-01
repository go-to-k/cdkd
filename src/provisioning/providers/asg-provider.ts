import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  type DescribeAutoScalingGroupsCommandOutput,
  DescribeLifecycleHooksCommand,
  DescribeTrafficSourcesCommand,
  DescribeNotificationConfigurationsCommand,
  EnableMetricsCollectionCommand,
  DisableMetricsCollectionCommand,
  PutLifecycleHookCommand,
  DeleteLifecycleHookCommand,
  AttachTrafficSourcesCommand,
  DetachTrafficSourcesCommand,
  PutNotificationConfigurationCommand,
  DeleteNotificationConfigurationCommand,
  CreateOrUpdateTagsCommand,
  DeleteTagsCommand,
  AttachLoadBalancersCommand,
  DetachLoadBalancersCommand,
  AttachLoadBalancerTargetGroupsCommand,
  DetachLoadBalancerTargetGroupsCommand,
  type Tag as ASGTag,
  type LaunchTemplateSpecification,
  type AvailabilityZoneDistribution,
  type CapacityReservationSpecification,
  type DeletionProtection,
  type InstanceMaintenancePolicy,
} from '@aws-sdk/client-auto-scaling';
import { EC2Client } from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { disableInstanceApiTermination } from '../ec2-termination-protection.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
} from '../../types/resource.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import {
  protectedReplacementAdvice,
  pasteableAwsCommand,
  WITHHELD_AWS_COMMAND,
} from '../replacement-protection-advice.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { holdsSecretDerivedEntry } from '../iam-policy-targets.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  type ProtectionFlipRecord,
  type ProtectionGuardSite,
} from './deletion-protection-compensation.js';

// ─── List reads (go-to-k/cdkd#3948) ─────────────────────────────────
//
// Every sub-shape diff helper derives its REMOVALS (Detach*, Delete*,
// Disable*) from the gap between the desired and the recorded list. Reading a
// present-but-malformed value as an empty list therefore removes everything the
// other side holds: on a rollback or `drift --revert`, where the desired side
// is a recorded bag, `TargetGroupARNs: {}` detached every target group. So
// `undefined` / `null` is ABSENT (an empty list), and anything else that is not
// a list of well-formed entries is MALFORMED, refused on BOTH sides before any
// call. A refusal names only the property and side, never record content.

/** The two attachment lists: entries are bare names / ARNs. */
type AttachmentKind = 'LoadBalancerNames' | 'TargetGroupARNs';
/** The entry lists: each entry is an object keyed by one identity member. */
type EntryKind =
  | 'Tags'
  | 'MetricsCollection'
  | 'LifecycleHookSpecificationList'
  | 'TrafficSources'
  | 'NotificationConfigurations';
type ListKind = AttachmentKind | EntryKind;

/**
 * API length caps (`XmlStringMaxLen255` / `XmlStringMaxLen511`). A classic load
 * balancer name or a target-group ARN never holds whitespace.
 */
const ATTACHMENT_MAX_LENGTH: Record<AttachmentKind, number> = {
  LoadBalancerNames: 255,
  TargetGroupARNs: 511,
};
const ATTACHMENT_WHAT: Record<AttachmentKind, string> = {
  LoadBalancerNames: 'load balancer names',
  TargetGroupARNs: 'target group ARNs',
};

/** The member each diff helper keys an entry by, and any string-list member it forwards. */
const ENTRY_SHAPE: Record<EntryKind, { identity: string; stringList?: string; what: string }> = {
  Tags: { identity: 'Key', what: 'tags with a Key' },
  MetricsCollection: {
    identity: 'Granularity',
    stringList: 'Metrics',
    what: 'entries with a Granularity',
  },
  LifecycleHookSpecificationList: {
    identity: 'LifecycleHookName',
    what: 'entries with a LifecycleHookName',
  },
  TrafficSources: { identity: 'Identifier', what: 'entries with an Identifier' },
  NotificationConfigurations: {
    identity: 'TopicARN',
    stringList: 'NotificationTypes',
    what: 'entries with a TopicARN',
  },
};

const LIST_KINDS: readonly ListKind[] = [
  'Tags',
  'LoadBalancerNames',
  'TargetGroupARNs',
  'MetricsCollection',
  'LifecycleHookSpecificationList',
  'TrafficSources',
  'NotificationConfigurations',
];

type ListRead =
  | { kind: 'list'; items: unknown[] }
  // `onlySecret`: the list is well-shaped, and refused ONLY because a member
  // holds a dynamic reference or its mask.
  | { kind: 'malformed'; secretDerived: boolean; onlySecret: boolean };

function isAttachmentKind(kind: ListKind): kind is AttachmentKind {
  return kind === 'LoadBalancerNames' || kind === 'TargetGroupARNs';
}

/**
 * `side` matters for an entry list's IDENTITY only. A desired identity holding a
 * dynamic reference or its mask names nothing AWS holds, so it is malformed. A
 * RECORDED one is what cdkd writes for a template whose identity came from a
 * secret (cdkd keeps the reference in state), so refusing it would refuse every
 * later update of that group: it is read, and `removableRecorded` then keeps it
 * out of the removal set (go-to-k/cdkd#3948).
 */
type ListSide = 'desired' | 'recorded';

function isWellFormedEntry(
  kind: ListKind,
  entry: unknown,
  side: ListSide,
  // Ask the SHAPE question alone, as if no member held a secret: used to tell
  // a list refused only for a dynamic reference from a malformed one.
  ignoreSecrets = false
): boolean {
  if (isAttachmentKind(kind)) {
    return (
      typeof entry === 'string' &&
      entry.length > 0 &&
      entry.length <= ATTACHMENT_MAX_LENGTH[kind] &&
      !/\s/.test(entry) &&
      // A dynamic reference is a well-formed STRING but not a name AWS holds:
      // sending it would Detach / Attach a literal `{{resolve:...}}`.
      (ignoreSecrets || !holdsSecretDerivedEntry(entry))
    );
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const { identity, stringList } = ENTRY_SHAPE[kind];
  const record = entry as Record<string, unknown>;
  const id = record[identity];
  if (typeof id !== 'string' || id.length === 0) return false;
  if (side === 'desired' && !ignoreSecrets && holdsSecretDerivedEntry(id)) return false;
  if (stringList !== undefined) {
    const list = record[stringList];
    if (list != null && !(Array.isArray(list) && list.every((v) => typeof v === 'string'))) {
      return false;
    }
    // A desired metric / notification type holding a dynamic reference names
    // nothing AWS accepts; a RECORDED one is filtered by `removableRecorded`.
    if (
      side === 'desired' &&
      !ignoreSecrets &&
      Array.isArray(list) &&
      list.some((v) => holdsSecretDerivedEntry(v))
    ) {
      return false;
    }
  }
  return true;
}

/** Read one list property; ABSENT (`undefined` / `null`) reads as the empty list. */
function readList(kind: ListKind, value: unknown, side: ListSide): ListRead {
  if (value === undefined || value === null) return { kind: 'list', items: [] };
  if (Array.isArray(value) && value.every((entry) => isWellFormedEntry(kind, entry, side))) {
    return { kind: 'list', items: value };
  }
  return {
    kind: 'malformed',
    secretDerived: holdsSecretDerivedEntry(value),
    onlySecret:
      Array.isArray(value) && value.every((entry) => isWellFormedEntry(kind, entry, side, true)),
  };
}

/**
 * The cause clause for DESIRED lists refused because a member holds a dynamic
 * reference or its mask: "not a list of ..." alone reads as a shape error. It
 * names the property only, never the value.
 */
function secretDerivedCause(kinds: ListKind[], read: Record<ListKind, ListRead>): string {
  const secret = kinds.filter((k) => {
    const r = read[k];
    return r.kind === 'malformed' && r.onlySecret;
  });
  return secret.length === 0
    ? ''
    : ` (${secret.join(' / ')} holds a dynamic reference or its mask where a name belongs, ` +
        `which names nothing Auto Scaling accepts)`;
}

function listWhat(kind: ListKind): string {
  return isAttachmentKind(kind) ? ATTACHMENT_WHAT[kind] : ENTRY_SHAPE[kind].what;
}

/**
 * Every list property of one bag, keyed by kind. The caller passes its own
 * literal read of each property (`{ Tags: properties['Tags'], ... }`) so the
 * handled-property wiring walk still sees which property feeds the calls.
 */
function readLists(values: Record<ListKind, unknown>, side: ListSide): Record<ListKind, ListRead> {
  const out = {} as Record<ListKind, ListRead>;
  for (const kind of LIST_KINDS) out[kind] = readList(kind, values[kind], side);
  return out;
}

function malformedKinds(read: Record<ListKind, ListRead>): ListKind[] {
  return LIST_KINDS.filter((k) => read[k].kind === 'malformed');
}

/**
 * A recorded entry list minus every entry whose identity is secret-derived: the
 * diff helpers would otherwise Delete / Detach a literal `{{resolve:...}}` key.
 * Dropping it only misses that one removal, the safe direction; the desired
 * side's plaintext identity is still upserted.
 */
function removableRecorded(kind: ListKind, items: unknown[]): unknown[] {
  if (isAttachmentKind(kind)) return items;
  const { identity, stringList } = ENTRY_SHAPE[kind];
  return items
    .filter((e) => !holdsSecretDerivedEntry((e as Record<string, unknown>)[identity]))
    .flatMap((e) => {
      // A secret-derived MEMBER of a recorded string list (a metric name, a
      // notification type) is dropped too, so no call names the literal
      // reference. Only for `MetricsCollection` is an entry left with no
      // members dropped whole: there an empty list means ALL. A notification
      // entry is KEPT (its TopicARN alone addresses the Delete).
      if (stringList === undefined) return [e];
      const record = e as Record<string, unknown>;
      const list = record[stringList];
      if (!Array.isArray(list) || !list.some((v) => holdsSecretDerivedEntry(v))) return [e];
      const kept = list.filter((v) => !holdsSecretDerivedEntry(v));
      if (kept.length === 0 && kind === 'MetricsCollection') return [];
      return [{ ...record, [stringList]: kept }];
    });
}

function itemsOf(read: ListRead): unknown[] {
  return read.kind === 'list' ? read.items : [];
}

/**
 * AWS Auto Scaling Provider
 *
 * Implements resource provisioning for `AWS::AutoScaling::AutoScalingGroup`.
 *
 * WHY a dedicated SDK provider (instead of CC API fallback):
 *   1. Owns the `--remove-protection` flip-off: ASG protection has three
 *      levels (`none` / `prevent-force-deletion` / `prevent-all-deletion`)
 *      and the destroy path needs to (a) clear it via `UpdateAutoScalingGroup
 *      ({DeletionProtection: 'none'})` before the actual delete and (b) set
 *      `ForceDelete: true` on `DeleteAutoScalingGroup` so AWS terminates any
 *      running instances as part of the delete (matches the user's "I know
 *      what I'm doing" intent).
 *   2. Faster than CC API for the common case — direct Create/Update calls
 *      with no eventual-consistency polling beyond what `DescribeAutoScaling
 *      Groups` already provides.
 *
 * Update has narrower coverage than create: AWS does not support modifying
 * `AutoScalingGroupName` (immutable) — that diff still surfaces
 * `ResourceUpdateNotSupportedError` so the caller can `cdkd deploy
 * --replace`. The mutable fields handled in-place via
 * `UpdateAutoScalingGroup` include MinSize / MaxSize / DesiredCapacity /
 * VPCZoneIdentifier / HealthCheckType / HealthCheckGracePeriod /
 * DefaultCooldown / Cooldown / NewInstancesProtectedFromScaleIn /
 * MaxInstanceLifetime / TerminationPolicies / CapacityRebalance /
 * ServiceLinkedRoleARN / Context / DesiredCapacityType /
 * DefaultInstanceWarmup / AvailabilityZones / AvailabilityZoneDistribution
 * / AvailabilityZoneImpairmentPolicy / SkipZonalShiftValidation /
 * CapacityReservationSpecification / InstanceMaintenancePolicy /
 * DeletionProtection / MixedInstancesPolicy / LaunchTemplate.
 *
 * `UpdateAutoScalingGroup` has merge semantics (absent input field = "no
 * change"), so update() routes every optional mutable field through
 * `clearOnUpdateRemoval` — a property REMOVED from the template is reset to
 * its CFn default / SDK-documented clear sentinel, matching CloudFormation
 * (issue #1160).
 *
 * Sub-shape diffs are applied via dedicated AWS APIs before the main
 * `UpdateAutoScalingGroup` call:
 *   - `Tags` → `CreateOrUpdateTags` / `DeleteTags` (#475)
 *   - `LoadBalancerNames` → `AttachLoadBalancers` /
 *     `DetachLoadBalancers` (#476)
 *   - `TargetGroupARNs` → `AttachLoadBalancerTargetGroups` /
 *     `DetachLoadBalancerTargetGroups` (#476)
 *   - `MetricsCollection` → `EnableMetricsCollection` /
 *     `DisableMetricsCollection`
 *   - `LifecycleHookSpecificationList` → per-entry `PutLifecycleHook` /
 *     `DeleteLifecycleHook`
 *   - `TrafficSources` → `AttachTrafficSources` /
 *     `DetachTrafficSources`
 *   - `NotificationConfigurations` → per-topic
 *     `PutNotificationConfiguration` /
 *     `DeleteNotificationConfiguration`
 *
 * Each helper is a no-op when the before/after JSON is identical.
 */
/** An entry `foldMetricsCollection` reads faithfully (string Granularity, string-list or absent Metrics). */
function isFoldableMetricsEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const { Granularity, Metrics } = entry as { Granularity?: unknown; Metrics?: unknown };
  return (
    typeof Granularity === 'string' &&
    Granularity.length > 0 &&
    (Metrics == null || (Array.isArray(Metrics) && Metrics.every((m) => typeof m === 'string')))
  );
}

/**
 * The metrics `EnableMetricsCollection` is KNOWN to enable when it is sent a
 * `Granularity` and no `Metrics` (go-to-k/cdkd#4021), sorted. Primary source:
 * observed on real AWS on 2026-09-28 in us-east-1 — a fresh group with no warm
 * pool, enabled with no `Metrics`, reported these 25 in `EnabledMetrics`.
 * Secondary source: the `EnableMetricsCollectionType.Metrics` documentation of
 * `@aws-sdk/client-auto-scaling` 3.1140.0 ("If you specify Granularity and
 * don't specify any metrics, all metrics are enabled"), which lists 20 and
 * omits the four `*Retained*` names and `WarmPoolMinSize`. AWS can add more, so
 * this is a LOWER bound: `canonicalizeDriftPair` treats a readback holding all
 * of these (and possibly more) as ALL.
 */
export const ALL_GROUP_METRICS: readonly string[] = [
  'GroupAndWarmPoolDesiredCapacity',
  'GroupAndWarmPoolTotalCapacity',
  'GroupDesiredCapacity',
  'GroupInServiceCapacity',
  'GroupInServiceInstances',
  'GroupMaxSize',
  'GroupMinSize',
  'GroupPendingCapacity',
  'GroupPendingInstances',
  'GroupStandbyCapacity',
  'GroupStandbyInstances',
  'GroupTerminatingCapacity',
  'GroupTerminatingInstances',
  'GroupTerminatingRetainedCapacity',
  'GroupTerminatingRetainedInstances',
  'GroupTotalCapacity',
  'GroupTotalInstances',
  'WarmPoolDesiredCapacity',
  'WarmPoolMinSize',
  'WarmPoolPendingCapacity',
  'WarmPoolPendingRetainedCapacity',
  'WarmPoolTerminatingCapacity',
  'WarmPoolTerminatingRetainedCapacity',
  'WarmPoolTotalCapacity',
  'WarmPoolWarmedCapacity',
];

/**
 * A metric list naming every {@link ALL_GROUP_METRICS} entry, which create and
 * update send AS ALL (no `Metrics`) rather than as that list (#4021): several
 * of those names are observed, not documented as accepted by the API, and "no
 * metrics" is AWS's own spelling of all. This applies to a template that
 * lists all of them too, which then also enables any metric AWS adds later.
 */
function holdsAllKnownMetrics(metrics: readonly string[]): boolean {
  return ALL_GROUP_METRICS.every((m) => metrics.includes(m));
}

/** One granularity of a folded `MetricsCollection`; `Metrics` absent = ALL. */
type FoldedMetrics = { Granularity: string; Metrics?: string[] };

/**
 * Fold a `MetricsCollection` list to the shape AWS holds (go-to-k/cdkd#4013):
 * ONE entry per granularity, its `Metrics` the sorted UNION of every entry's
 * metrics at that granularity, or absent (ALL) when any entry there omits
 * `Metrics` or lists none — AWS's "no metrics means all metrics". Sorted by
 * granularity, so two lists enabling the same metrics fold equal whatever
 * their entry split or order. Entries with no string `Granularity` are skipped
 * (the update path refuses them before this runs); a non-array folds to `[]`.
 * Pure: shared by the update diff and the drift canonicalization.
 */
export function foldMetricsCollection(value: unknown): FoldedMetrics[] {
  if (!Array.isArray(value)) return [];
  const byGranularity = new Map<string, Set<string> | 'ALL'>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as { Granularity?: unknown; Metrics?: unknown };
    if (typeof entry.Granularity !== 'string' || entry.Granularity.length === 0) continue;
    const metrics = Array.isArray(entry.Metrics)
      ? entry.Metrics.filter((m): m is string => typeof m === 'string')
      : [];
    const current = byGranularity.get(entry.Granularity);
    if (metrics.length === 0 || current === 'ALL') {
      byGranularity.set(entry.Granularity, 'ALL');
      continue;
    }
    const set = current ?? new Set<string>();
    for (const m of metrics) set.add(m);
    byGranularity.set(entry.Granularity, set);
  }
  return [...byGranularity.keys()].sort().map((granularity) => {
    const metrics = byGranularity.get(granularity)!;
    return metrics === 'ALL'
      ? { Granularity: granularity }
      : { Granularity: granularity, Metrics: [...metrics].sort() };
  });
}

/**
 * The {@link ProtectionGuardSite} for an `AWS::AutoScaling::AutoScalingGroup`
 * whose `--remove-protection` delete failed terminally (issue #2204).
 *
 * `removedLevel` answers the `DeletionProtection` value the flip removed,
 * read when a line is rendered: the restore command must put back THAT level,
 * and a command that cannot name it is withheld rather than guessed.
 * `--region` is rendered whenever the state records one, for the reason
 * `rdsFamilyProtectionSite` gives.
 */
export function autoScalingGroupProtectionSite(
  groupName: string,
  region: string | undefined,
  removedLevel: () => string | undefined
): ProtectionGuardSite {
  return {
    subject: 'AutoScalingGroup',
    guardName: 'DeletionProtection',
    noun: 'group',
    // Auto Scaling has no typed not-found error: a missing group is a
    // `ValidationError` whose message says so.
    isNotFound: (error) => {
      if (typeof error !== 'object' || error === null) return false;
      const { name, message } = error as { name?: unknown; message?: unknown };
      return (
        name === 'ValidationError' &&
        typeof message === 'string' &&
        /not found|does not exist/i.test(message)
      );
    },
    notFoundMeaning:
      'Auto Scaling answered that the group was not found. That most commonly means the ' +
      'group is gone, and it can also mean it is not in this region or account.',
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = region ? aws` --region ${region}` : aws``;
      const level = removedLevel();
      const restore =
        level === undefined
          ? WITHHELD_AWS_COMMAND
          : aws`aws autoscaling update-auto-scaling-group --auto-scaling-group-name ${groupName}${regionArg} --deletion-protection ${level}`.render();
      return {
        check:
          aws`aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${groupName}${regionArg}`.render(),
        restoreAfterNotFound: restore,
        restoreLive: restore,
      };
    },
  };
}

export class ASGProvider implements ResourceProvider {
  private asgClient?: AutoScalingClient;
  private ec2Client?: EC2Client;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('ASGProvider');
  /** `--remove-protection` flips per group, kept across `delete()` re-entry (#2204). */
  private readonly protectionFlips = new ProtectionFlipRegistry();
  /**
   * The `DeletionProtection` level each flip record's flip removed. Keyed by
   * the RECORD, not the group, so it lives and dies with it: the registry
   * hands a re-entered `delete()` the same record (and so this level), and a
   * released or aged-out record takes its level with it.
   */
  private readonly removedProtection = new WeakMap<ProtectionFlipRecord, string>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::AutoScaling::AutoScalingGroup',
      new Set([
        'AutoScalingGroupName',
        'LaunchTemplate',
        'MinSize',
        'MaxSize',
        'DesiredCapacity',
        'VPCZoneIdentifier',
        'AvailabilityZones',
        'HealthCheckType',
        'HealthCheckGracePeriod',
        'Cooldown',
        'DefaultCooldown',
        'Tags',
        'TerminationPolicies',
        'NewInstancesProtectedFromScaleIn',
        'CapacityRebalance',
        'ServiceLinkedRoleARN',
        'MaxInstanceLifetime',
        'LoadBalancerNames',
        'TargetGroupARNs',
        'MetricsCollection',
        'LifecycleHookSpecificationList',
        'MixedInstancesPolicy',
        'Context',
        'DesiredCapacityType',
        'DefaultInstanceWarmup',
        'TrafficSources',
        'NotificationConfigurations',
        'AvailabilityZoneDistribution',
        'AvailabilityZoneImpairmentPolicy',
        'SkipZonalShiftValidation',
        'CapacityReservationSpecification',
        'InstanceMaintenancePolicy',
        'DeletionProtection',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::AutoScaling::AutoScalingGroup',
      new Map<string, string>([
        [
          'LaunchConfigurationName',
          'AWS Launch Configurations end-of-life 2024-10; use LaunchTemplate instead',
        ],
        [
          'NotificationConfiguration',
          'Legacy singular form; use NotificationConfigurations (plural) which cdkd already wires',
        ],
      ]),
    ],
  ]);

  /**
   * Fold `MetricsCollection` on BOTH drift sides (go-to-k/cdkd#4013):
   * `readCurrentState` reports one entry per granularity, while a template-
   * shaped baseline (a record deployed before observed-capture) carries one
   * entry per CDK `GroupMetrics`, so the same enabled set would otherwise
   * drift forever. Same helper as the update diff, so the two cannot disagree.
   */
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') return properties;
    const key = 'MetricsCollection';
    const metrics = properties[key];
    // Fold only a list every entry of which is readable: the fold would read
    // an unreadable `Metrics` as ALL and hide the difference (and `--accept`
    // would persist that ALL).
    if (!Array.isArray(metrics) || !metrics.every(isFoldableMetricsEntry)) return properties;
    const folded = foldMetricsCollection(metrics);
    if (JSON.stringify(folded) === JSON.stringify(metrics)) return properties;
    return { ...properties, [key]: folded };
  }

  /**
   * Compare an ALL `MetricsCollection` baseline against the per-metric readback
   * (go-to-k/cdkd#4021). An entry with no `Metrics` enables every metric, but
   * `EnabledMetrics` lists them one by one, so a template-shaped ALL baseline
   * (a record deployed before observed-capture) never matched.
   *
   * The rule is a SUPERSET test, keyed on the BASELINE saying ALL: that
   * granularity's baseline becomes the readback's metrics UNION
   * {@link ALL_GROUP_METRICS}. A readback holding every known metric therefore
   * compares clean (a metric AWS adds later included), and one missing a known
   * metric differs by exactly the missing ones. Residual: an out-of-band
   * disable of a metric cdkd does not yet list is NOT reported.
   *
   * Only the baseline is rewritten, and only by ADDING metrics, so `--accept`
   * (which writes the readback side) persists nothing new, and `--revert`
   * (which sends this baseline as its desired side) can only Enable, never
   * Disable a metric the readback holds; `applyMetricsCollectionDiff` sends
   * that Enable as ALL (no `Metrics`), not as the expanded list.
   */
  async canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    const key = 'MetricsCollection';
    const unchanged = { baseline, aws };
    if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') return unchanged;
    const recorded = baseline[key];
    if (!Array.isArray(recorded) || !recorded.every(isFoldableMetricsEntry)) return unchanged;
    const folded = foldMetricsCollection(recorded);
    if (folded.every((e) => e.Metrics !== undefined)) return unchanged;
    const live = aws[key];
    const liveBy = new Map<string, string[]>();
    if (Array.isArray(live) && live.every(isFoldableMetricsEntry)) {
      for (const e of foldMetricsCollection(live)) liveBy.set(e.Granularity, e.Metrics ?? []);
    }
    const expanded = folded.map((e) =>
      e.Metrics !== undefined
        ? e
        : {
            Granularity: e.Granularity,
            Metrics: [
              ...new Set([...ALL_GROUP_METRICS, ...(liveBy.get(e.Granularity) ?? [])]),
            ].sort(),
          }
    );
    return { baseline: { ...baseline, [key]: expanded }, aws };
  }

  private getClient(): AutoScalingClient {
    if (!this.asgClient) {
      this.asgClient = new AutoScalingClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.asgClient;
  }

  private getEc2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.ec2Client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  /**
   * The `context` parameter is read for ONE thing: `maskSecrets` (issue #1932
   * item 3, adopted here by issue #1997).
   *
   * An earlier revision of this comment claimed the create path had no site to
   * mask, on the grounds that it names "only the logical id and the generated
   * group name". Both halves were wrong: `groupName` falls back to a generated
   * name only when `AutoScalingGroupName` is ABSENT, so when the template
   * DECLARES it the value is a resolved property value — and it IS logged, on
   * the line below. Debug level is not an exemption; the contract's rule is any
   * log line that interpolates a value from the `properties` bag, and this
   * provider already masks its convergence-poll debug line for that reason.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
    }

    const groupName =
      (properties['AutoScalingGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });

    // ONE masked sink for this method's own lines (issue #1997).
    const maskSecrets: SecretMasker = context?.maskSecrets ?? ((text) => text);
    const debug = (message: string): void => this.logger.debug(maskSecrets(message));
    debug(`Creating AutoScalingGroup ${logicalId}: ${maskSecrets(groupName)}`);

    // A malformed list would otherwise reach the SDK cast as `string[]`, whose
    // serializer walks a string character by character (go-to-k/cdkd#3948).
    const lists = readLists(
      {
        Tags: properties['Tags'],
        LoadBalancerNames: properties['LoadBalancerNames'],
        TargetGroupARNs: properties['TargetGroupARNs'],
        MetricsCollection: properties['MetricsCollection'],
        LifecycleHookSpecificationList: properties['LifecycleHookSpecificationList'],
        TrafficSources: properties['TrafficSources'],
        NotificationConfigurations: properties['NotificationConfigurations'],
      },
      'desired'
    );
    const malformedOnCreate = malformedKinds(lists);
    if (malformedOnCreate.length > 0) {
      throw markNonRetryable(
        new ProvisioningError(
          `${malformedOnCreate.join(' / ')} of AutoScalingGroup ${logicalId} is not a list of ` +
            `${malformedOnCreate.map(listWhat).join(' / ')}` +
            `${secretDerivedCause(malformedOnCreate, lists)} — the group was not created`,
          resourceType,
          logicalId
        )
      );
    }

    // Set only when a failed create-time wiring could not be fully retired.
    let survivorNote: string | undefined;
    try {
      const launchTemplate = this.buildLaunchTemplate(properties);
      const tags = this.buildTags(groupName, properties);
      const vpcZoneIdentifier = this.joinVpcZoneIdentifier(properties['VPCZoneIdentifier']);

      const minSize = properties['MinSize'] != null ? Number(properties['MinSize']) : 0;
      const maxSize = properties['MaxSize'] != null ? Number(properties['MaxSize']) : minSize;

      await this.getClient().send(
        new CreateAutoScalingGroupCommand({
          AutoScalingGroupName: groupName,
          MinSize: minSize,
          MaxSize: maxSize,
          ...(properties['DesiredCapacity'] != null && {
            DesiredCapacity: Number(properties['DesiredCapacity']),
          }),
          ...(launchTemplate && { LaunchTemplate: launchTemplate }),
          ...(properties['MixedInstancesPolicy'] !== undefined && {
            MixedInstancesPolicy: properties['MixedInstancesPolicy'] as never,
          }),
          ...(vpcZoneIdentifier !== undefined && { VPCZoneIdentifier: vpcZoneIdentifier }),
          ...(properties['AvailabilityZones'] !== undefined && {
            AvailabilityZones: properties['AvailabilityZones'] as string[],
          }),
          ...(properties['HealthCheckType'] !== undefined && {
            HealthCheckType: properties['HealthCheckType'] as string,
          }),
          ...(properties['HealthCheckGracePeriod'] != null && {
            HealthCheckGracePeriod: Number(properties['HealthCheckGracePeriod']),
          }),
          ...(properties['Cooldown'] != null && {
            DefaultCooldown: Number(properties['Cooldown']),
          }),
          ...(properties['DefaultCooldown'] != null && {
            DefaultCooldown: Number(properties['DefaultCooldown']),
          }),
          ...(properties['TerminationPolicies'] !== undefined && {
            TerminationPolicies: properties['TerminationPolicies'] as string[],
          }),
          ...(properties['NewInstancesProtectedFromScaleIn'] !== undefined && {
            NewInstancesProtectedFromScaleIn: properties[
              'NewInstancesProtectedFromScaleIn'
            ] as boolean,
          }),
          ...(properties['CapacityRebalance'] !== undefined && {
            CapacityRebalance: properties['CapacityRebalance'] as boolean,
          }),
          ...(properties['ServiceLinkedRoleARN'] !== undefined && {
            ServiceLinkedRoleARN: properties['ServiceLinkedRoleARN'] as string,
          }),
          ...(properties['MaxInstanceLifetime'] != null && {
            MaxInstanceLifetime: Number(properties['MaxInstanceLifetime']),
          }),
          ...(properties['LoadBalancerNames'] != null && {
            LoadBalancerNames: itemsOf(lists.LoadBalancerNames) as string[],
          }),
          ...(properties['TargetGroupARNs'] != null && {
            TargetGroupARNs: itemsOf(lists.TargetGroupARNs) as string[],
          }),
          ...(properties['Context'] !== undefined && {
            Context: properties['Context'] as string,
          }),
          ...(properties['DesiredCapacityType'] !== undefined && {
            DesiredCapacityType: properties['DesiredCapacityType'] as string,
          }),
          ...(properties['DefaultInstanceWarmup'] != null && {
            DefaultInstanceWarmup: Number(properties['DefaultInstanceWarmup']),
          }),
          ...(properties['LifecycleHookSpecificationList'] != null && {
            LifecycleHookSpecificationList: properties['LifecycleHookSpecificationList'] as never,
          }),
          ...(properties['TrafficSources'] != null && {
            TrafficSources: properties['TrafficSources'] as never,
          }),
          ...(properties['AvailabilityZoneDistribution'] !== undefined && {
            AvailabilityZoneDistribution: properties['AvailabilityZoneDistribution'] as never,
          }),
          ...(properties['AvailabilityZoneImpairmentPolicy'] !== undefined && {
            AvailabilityZoneImpairmentPolicy: properties[
              'AvailabilityZoneImpairmentPolicy'
            ] as never,
          }),
          ...(properties['SkipZonalShiftValidation'] !== undefined && {
            SkipZonalShiftValidation: properties['SkipZonalShiftValidation'] as boolean,
          }),
          ...(properties['CapacityReservationSpecification'] !== undefined && {
            CapacityReservationSpecification: properties[
              'CapacityReservationSpecification'
            ] as never,
          }),
          ...(properties['InstanceMaintenancePolicy'] !== undefined && {
            InstanceMaintenancePolicy: properties['InstanceMaintenancePolicy'] as never,
          }),
          ...(properties['DeletionProtection'] !== undefined && {
            DeletionProtection: properties['DeletionProtection'] as never,
          }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      // `CreateAutoScalingGroup` takes neither `MetricsCollection` nor
      // `NotificationConfigurations`: each rides its own API, which only the
      // update diff helpers used to send, so a first deploy silently lacked both
      // (go-to-k/cdkd#3995). One call PER ENTRY, from the lists `readLists`
      // validated above: CDK renders one `MetricsCollection` entry per
      // `GroupMetrics`, all at `1Minute`, and each must be enabled (the update
      // helper's per-granularity map would keep only the last). CloudFormation
      // reports CREATE_FAILED and rolls the group back when either fails, so a
      // failure here retires the group before re-throwing.
      try {
        for (const entry of itemsOf(lists.MetricsCollection) as Array<{
          Granularity: string;
          Metrics?: string[] | null;
        }>) {
          await this.getClient().send(
            new EnableMetricsCollectionCommand({
              AutoScalingGroupName: groupName,
              Granularity: entry.Granularity,
              ...(entry.Metrics && entry.Metrics.length > 0 && !holdsAllKnownMetrics(entry.Metrics)
                ? { Metrics: entry.Metrics }
                : {}),
            })
          );
        }
        for (const entry of itemsOf(lists.NotificationConfigurations) as Array<{
          TopicARN: string;
          NotificationTypes?: string[] | null;
        }>) {
          await this.getClient().send(
            new PutNotificationConfigurationCommand({
              AutoScalingGroupName: groupName,
              TopicARN: entry.TopicARN,
              NotificationTypes: entry.NotificationTypes ?? [],
            })
          );
        }
      } catch (wiringError) {
        survivorNote = await this.retireFailedCreate(groupName, logicalId, properties, maskSecrets);
        // The group itself was created: an error from its wiring is an
        // auxiliary object's, never this group's name collision (#3826).
        throw markAuxiliaryFailure(wiringError, logicalId);
      }

      debug(`Successfully created AutoScalingGroup ${logicalId}: ${maskSecrets(groupName)}`);

      const arn = await this.fetchArn(groupName, maskSecrets);
      const attributes: Record<string, unknown> = {};
      if (arn) attributes['Arn'] = arn;
      if (launchTemplate?.LaunchTemplateId) {
        attributes['LaunchTemplateID'] = launchTemplate.LaunchTemplateId;
      }
      return { physicalId: groupName, attributes };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      // A retire that could not finish is APPENDED, never swapped in: the
      // user needs the wiring failure AND the survivor (#2169's rule). That
      // error is also NON-RETRYABLE: a replayed create can only meet the
      // surviving group ("already exists"), and the retry would throw THAT,
      // dropping the survivor note — while the note's own AWS text (a missing
      // `autoscaling:DeleteAutoScalingGroup` grant reads as IAM propagation)
      // would otherwise classify as retryable.
      const failure = new ProvisioningError(
        `Failed to create AutoScalingGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}` +
          (survivorNote === undefined ? '' : ` ${survivorNote}`),
        resourceType,
        logicalId,
        groupName,
        cause
      );
      throw survivorNote === undefined ? failure : markNonRetryable(failure);
    }
  }

  /**
   * Retire a group whose create-time wiring failed, as CloudFormation's
   * CREATE_FAILED rollback does (go-to-k/cdkd#3995). The group was created by
   * THIS call under the name it was sent, so every call below can only reach
   * it. In order:
   *
   * 1. ONE `UpdateAutoScalingGroup` scales it to zero (and clears a
   *    template-set `DeletionProtection`), so no launch STARTS after step 2
   *    has listed the instances. Non-fatal, as in `delete()`: when it fails, a
   *    protection-only update is sent on its own, and the delete is attempted
   *    either way, reporting its own refusal.
   * 2. EC2 termination protection is flipped off on every instance listed,
   *    in two passes — once after the scale-down and again right before the
   *    delete — which NARROWS the window for a launch in flight at the first
   *    read (#796: a `ForceDelete` cannot terminate a protected instance,
   *    which orphans), and retries a flip the first pass could not make.
   * 3. `ForceDelete`, then the wait for the group to be gone.
   *
   * Returns `undefined` when the group is gone, or the note naming the
   * survivor and its manual retire command. Never throws: the wiring error is
   * what the caller re-throws, with this note APPENDED to the thrown message
   * (`.claude/rules/provider-diff-record-folds.md`) rather than logged, so the
   * survivor reaches every surface that reports the failure.
   */
  private async retireFailedCreate(
    groupName: string,
    logicalId: string,
    properties: Record<string, unknown>,
    maskSecrets: SecretMasker
  ): Promise<string | undefined> {
    const debug = (message: string): void => this.logger.debug(maskSecrets(message));
    let deleteAccepted = false;
    try {
      const protection = properties['DeletionProtection'];
      try {
        await this.getClient().send(
          new UpdateAutoScalingGroupCommand({
            AutoScalingGroupName: groupName,
            MinSize: 0,
            MaxSize: 0,
            DesiredCapacity: 0,
            ...(protection != null &&
              protection !== 'none' && { DeletionProtection: 'none' as never }),
          })
        );
      } catch (scaleError) {
        debug(
          `Could not scale AutoScalingGroup ${logicalId} to zero before retiring it: ` +
            describeAwsFailure(scaleError).detail
        );
        // The combined call can be refused TRANSIENTLY on a group still
        // launching (`ResourceContention`, `ScalingActivityInProgress`), which
        // would leave the template's protection on and the delete refused:
        // lift the protection on its own.
        if (protection != null && protection !== 'none') {
          try {
            await this.getClient().send(
              new UpdateAutoScalingGroupCommand({
                AutoScalingGroupName: groupName,
                DeletionProtection: 'none' as never,
              })
            );
          } catch (liftError) {
            debug(
              `Could not clear DeletionProtection on AutoScalingGroup ${logicalId} before ` +
                `retiring it: ${describeAwsFailure(liftError).detail}`
            );
          }
        }
      }
      const flipped = new Set<string>();
      await this.removeInstanceTerminationProtection(groupName, logicalId, maskSecrets, flipped);
      await this.removeInstanceTerminationProtection(groupName, logicalId, maskSecrets, flipped);
      await this.getClient().send(
        new DeleteAutoScalingGroupCommand({ AutoScalingGroupName: groupName, ForceDelete: true })
      );
      deleteAccepted = true;
      await this.waitForGroupDeleted(groupName);
      debug(`Retired AutoScalingGroup ${logicalId} after its create-time wiring failed`);
      return undefined;
    } catch (cleanupError) {
      const outcome = deleteAccepted
        ? `cdkd started deleting it but could not confirm it is gone`
        : `cdkd could not delete it`;
      return maskSecrets(
        `The group was created, and ${outcome} (` +
          `${describeAwsFailure(cleanupError).detail}); it is not recorded in state, so delete ` +
          `it before the next deploy: ` +
          pasteableAwsCommand(
            maskSecrets
          )`aws autoscaling delete-auto-scaling-group --auto-scaling-group-name ${groupName} --force-delete`.render()
      );
    }
  }

  /**
   * The `context` parameter is read for ONE thing today: `maskSecrets` (issue
   * #1932 item 3, adopted here by issue #1997). `applyTargetGroupArnsDiff` is
   * the only path in this provider that interpolates a RESOLVED property value
   * into a log line — its convergence timeout names the expected
   * `TargetGroupARNs` set — so it is the only one the masker is threaded into.
   *
   * `create()` takes the masker too — see its own doc for why the original
   * "nothing to mask there" reading was wrong.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    this.logger.debug(`Updating AutoScalingGroup ${logicalId}: ${physicalId}`);

    // Reject diffs on fields AWS does not support modifying via
    // UpdateAutoScalingGroup. The replacement-detection layer typically
    // catches AutoScalingGroupName changes earlier; this is defense-in-
    // depth + the only place to surface the equivalent error for
    // sub-resource fields the caller may reasonably expect to round-trip.
    const stringEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    if (!stringEq(properties['AutoScalingGroupName'], previousProperties['AutoScalingGroupName'])) {
      // Issue [#2610] site 8. `--replace` alone cannot succeed on a group whose
      // recorded `DeletionProtection` is `'prevent-all-deletion'` (see the
      // level analysis below for why that is the ONLY blocking level): the
      // replacement's DELETE runs from the deploy engine, which never sets
      // `DeleteContext.removeProtection` — `delete()` below gates BOTH its
      // flip-off and its `ForceDelete: true` on exactly that field. See
      // `../replacement-protection-advice.ts`.
      //
      // Read the RECORDED bag: this guard fires before any
      // `UpdateAutoScalingGroup` in this method, so AWS still holds what
      // `previousProperties` records.
      //
      // The value is a THREE-level string enum, and only the strictest level
      // blocks a deploy-side replacement. AWS's own wording: the setting
      // controls whether `DeleteAutoScalingGroup` is allowed "according to the
      // specified protection level" -- `prevent-force-deletion` withholds only
      // the FORCE delete, and the deploy engine's replacement issues
      // `ForceDelete: false` (see `delete()` below, where the flag rides
      // `context?.removeProtection`). So on `prevent-force-deletion` the delete
      // is not refused BECAUSE of protection, and telling the user to clear it
      // would name a remedy that fixes nothing -- the exact defect issue
      // [#2610] is about, reintroduced by an over-wide predicate. An ABSENT
      // value is the AWS-side default, which `readCurrentState` writes back as
      // the explicit `'none'` placeholder.
      const recordedProtection = previousProperties['DeletionProtection'];
      const remedy =
        recordedProtection === 'prevent-all-deletion'
          ? protectedReplacementAdvice({
              evidence:
                "cdkd's recorded properties for this group carry " +
                'DeletionProtection: prevent-all-deletion',
              replaceFlags: 'cdkd deploy --replace',
              disable: {
                before: 'aws autoscaling update-auto-scaling-group --auto-scaling-group-name',
                identifier: physicalId,
                after: '--deletion-protection none',
              },
            })
          : 'Use cdkd deploy --replace to replace the group.';
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'AutoScalingGroupName is immutable on AWS — UpdateAutoScalingGroup does not accept a new name; the name is fixed at creation. ' +
          remedy
      );
    }
    // BOTH sides before any call (go-to-k/cdkd#3948): a rollback replays this
    // method with a recorded bag as the DESIRED side, and the previous side is
    // always the state record.
    const { next, prev, retained } = await this.readUpdateLists(
      logicalId,
      physicalId,
      resourceType,
      {
        Tags: properties['Tags'],
        LoadBalancerNames: properties['LoadBalancerNames'],
        TargetGroupARNs: properties['TargetGroupARNs'],
        MetricsCollection: properties['MetricsCollection'],
        LifecycleHookSpecificationList: properties['LifecycleHookSpecificationList'],
        TrafficSources: properties['TrafficSources'],
        NotificationConfigurations: properties['NotificationConfigurations'],
      },
      {
        Tags: previousProperties['Tags'],
        LoadBalancerNames: previousProperties['LoadBalancerNames'],
        TargetGroupARNs: previousProperties['TargetGroupARNs'],
        MetricsCollection: previousProperties['MetricsCollection'],
        LifecycleHookSpecificationList: previousProperties['LifecycleHookSpecificationList'],
        TrafficSources: previousProperties['TrafficSources'],
        NotificationConfigurations: previousProperties['NotificationConfigurations'],
      }
    );
    try {
      // Sub-shape diffs are applied via separate per-shape SDK calls
      // BEFORE the main UpdateAutoScalingGroup. AWS does not expose these
      // fields on UpdateAutoScalingGroup, so each one rides its own
      // dedicated API. Each per-shape helper is a no-op when the
      // before/after JSON is identical.
      await this.applyTagsDiff(physicalId, next.Tags, prev.Tags);
      await this.applyLoadBalancerNamesDiff(
        physicalId,
        next.LoadBalancerNames as string[],
        prev.LoadBalancerNames as string[]
      );
      await this.applyTargetGroupArnsDiff(
        physicalId,
        next.TargetGroupARNs as string[],
        prev.TargetGroupARNs as string[],
        context?.maskSecrets,
        retained.TargetGroupARNs
      );
      await this.applyMetricsCollectionDiff(
        physicalId,
        next.MetricsCollection,
        prev.MetricsCollection
      );
      await this.applyLifecycleHooksDiff(
        physicalId,
        next.LifecycleHookSpecificationList,
        prev.LifecycleHookSpecificationList
      );
      await this.applyTrafficSourcesDiff(physicalId, next.TrafficSources, prev.TrafficSources);
      await this.applyNotificationConfigurationsDiff(
        physicalId,
        next.NotificationConfigurations,
        prev.NotificationConfigurations
      );

      const launchTemplate = this.buildLaunchTemplate(properties);
      const vpcZoneIdentifier = this.joinVpcZoneIdentifier(properties['VPCZoneIdentifier']);

      // issue #1160: `UpdateAutoScalingGroup` has merge semantics — an absent
      // input field means "no change" — while CloudFormation resets a property
      // REMOVED from the template to its default. Resolve every optional
      // mutable field through `clearOnUpdateRemoval` so a removal sends the
      // explicit CFn default (or the SDK-documented clear sentinel) instead of
      // silently keeping the old live value. Each reset value's doc basis is
      // noted inline (models_0.d.ts = the AWS SDK command/model doc).
      //
      // Deliberately NOT reset on removal:
      //   - DesiredCapacity: CFn leaves current capacity unmanaged when the
      //     property is absent (scaling policies own it) — leaving it
      //     unchanged IS the CFn-parity behavior.
      //   - MinSize / MaxSize: required properties, never removable.
      //   - LaunchTemplate vs MixedInstancesPolicy, VPCZoneIdentifier vs
      //     AvailabilityZones: mutually-exclusive pairs — a "removal" is
      //     really a switch to the other member, which the API applies by
      //     presence; pure removal of both is an invalid template.
      //   - ServiceLinkedRoleARN: no documented clear sentinel; the default
      //     is an account-specific service-linked-role ARN — leave unchanged.
      //   - Context: SDK doc says "Reserved." — leave unchanged.
      //   - SkipZonalShiftValidation: transient per-request validation flag,
      //     not persisted group config — nothing to reset.
      //   - AvailabilityZoneImpairmentPolicy: DEFERRED — the SDK model
      //     documents no default for `ImpairedZoneHealthCheckBehavior` (and
      //     none for `ZonalShiftEnabled`), so a reset shape cannot be derived
      //     without guessing; removal currently keeps the live value.
      //
      // Sub-field removal inside a KEPT config object (issue #1225 — the
      // #1160 bug class one level down) is deliberately passed through
      // verbatim here:
      //   - InstanceMaintenancePolicy: a kept-but-partial object (one of the
      //     two percentages dropped) is REJECTED by AWS — the SDK doc requires
      //     "Both MinHealthyPercentage and MaxHealthyPercentage must be
      //     specified". CloudFormation submits the same partial object, so the
      //     loud failure IS the CFn-parity behavior; there is no silent drop
      //     to normalize away.
      //   - CapacityReservationSpecification: whether AWS keeps or clears a
      //     previously-set CapacityReservationTarget when only the preference
      //     is re-sent is UNPROBED (a live probe needs a billed Capacity
      //     Reservation); the kept-partial object passes through unchanged.
      //   - AvailabilityZoneDistribution: single sub-field — no partial shape
      //     exists.
      const healthCheckTypeInput = clearOnUpdateRemoval(
        properties['HealthCheckType'] as string | undefined,
        previousProperties['HealthCheckType'] as string | undefined,
        // SDK doc: "EC2 is the default health check and cannot be disabled.
        // ... Only specify EC2 if you must clear a value that was previously
        // set."
        'EC2'
      );
      const healthCheckGracePeriodInput = clearOnUpdateRemoval(
        properties['HealthCheckGracePeriod'] != null
          ? Number(properties['HealthCheckGracePeriod'])
          : undefined,
        previousProperties['HealthCheckGracePeriod'] != null
          ? Number(previousProperties['HealthCheckGracePeriod'])
          : undefined,
        // CFn default: 0 seconds.
        0
      );
      // CFn's template key is `Cooldown`; cdkd also accepts the SDK-side
      // spelling `DefaultCooldown`. Treat the two keys as ONE logical field on
      // both sides so switching spellings is never misread as a removal.
      const cooldownRaw = properties['Cooldown'] ?? properties['DefaultCooldown'];
      const prevCooldownRaw =
        previousProperties['Cooldown'] ?? previousProperties['DefaultCooldown'];
      const defaultCooldownInput = clearOnUpdateRemoval(
        cooldownRaw != null ? Number(cooldownRaw) : undefined,
        prevCooldownRaw != null ? Number(prevCooldownRaw) : undefined,
        // CFn default: 300 seconds.
        300
      );
      const terminationPoliciesInput = clearOnUpdateRemoval(
        properties['TerminationPolicies'] as string[] | undefined,
        previousProperties['TerminationPolicies'] as string[] | undefined,
        // CFn/API default termination policy.
        ['Default']
      );
      const newInstancesProtectedInput = clearOnUpdateRemoval(
        properties['NewInstancesProtectedFromScaleIn'] as boolean | undefined,
        previousProperties['NewInstancesProtectedFromScaleIn'] as boolean | undefined,
        false
      );
      const capacityRebalanceInput = clearOnUpdateRemoval(
        properties['CapacityRebalance'] as boolean | undefined,
        previousProperties['CapacityRebalance'] as boolean | undefined,
        false
      );
      const maxInstanceLifetimeInput = clearOnUpdateRemoval(
        properties['MaxInstanceLifetime'] != null
          ? Number(properties['MaxInstanceLifetime'])
          : undefined,
        previousProperties['MaxInstanceLifetime'] != null
          ? Number(previousProperties['MaxInstanceLifetime'])
          : undefined,
        // SDK doc: "To clear a previously set value, specify a new value of 0."
        0
      );
      const desiredCapacityTypeInput = clearOnUpdateRemoval(
        properties['DesiredCapacityType'] as string | undefined,
        previousProperties['DesiredCapacityType'] as string | undefined,
        // SDK doc: "By default, Amazon EC2 Auto Scaling specifies units".
        'units'
      );
      const defaultInstanceWarmupInput = clearOnUpdateRemoval(
        properties['DefaultInstanceWarmup'] != null
          ? Number(properties['DefaultInstanceWarmup'])
          : undefined,
        previousProperties['DefaultInstanceWarmup'] != null
          ? Number(previousProperties['DefaultInstanceWarmup'])
          : undefined,
        // SDK doc: "To remove a value that you previously set, include the
        // property but specify -1 for the value."
        -1
      );
      const instanceMaintenancePolicyInput = clearOnUpdateRemoval(
        properties['InstanceMaintenancePolicy'] as InstanceMaintenancePolicy | undefined,
        previousProperties['InstanceMaintenancePolicy'] as InstanceMaintenancePolicy | undefined,
        // SDK doc (both sub-fields): "To clear a previously set value,
        // specify a value of -1."
        { MinHealthyPercentage: -1, MaxHealthyPercentage: -1 }
      );
      const capacityReservationSpecInput = clearOnUpdateRemoval(
        properties['CapacityReservationSpecification'] as
          | CapacityReservationSpecification
          | undefined,
        previousProperties['CapacityReservationSpecification'] as
          | CapacityReservationSpecification
          | undefined,
        // SDK doc: "default - Auto Scaling uses the Capacity Reservation
        // preference from your launch template or an open Capacity
        // Reservation." — the behavior of a group that never set the field.
        { CapacityReservationPreference: 'default' }
      );
      const availabilityZoneDistributionInput = clearOnUpdateRemoval(
        properties['AvailabilityZoneDistribution'] as AvailabilityZoneDistribution | undefined,
        previousProperties['AvailabilityZoneDistribution'] as
          | AvailabilityZoneDistribution
          | undefined,
        // SDK doc: "The default is balanced-best-effort."
        { CapacityDistributionStrategy: 'balanced-best-effort' }
      );
      const deletionProtectionInput = clearOnUpdateRemoval(
        properties['DeletionProtection'] as DeletionProtection | undefined,
        previousProperties['DeletionProtection'] as DeletionProtection | undefined,
        // SDK doc: "Default: none" — also the flip-off value delete() uses.
        'none'
      );

      await this.getClient().send(
        new UpdateAutoScalingGroupCommand({
          AutoScalingGroupName: physicalId,
          ...(properties['MinSize'] != null && { MinSize: Number(properties['MinSize']) }),
          ...(properties['MaxSize'] != null && { MaxSize: Number(properties['MaxSize']) }),
          ...(properties['DesiredCapacity'] != null && {
            DesiredCapacity: Number(properties['DesiredCapacity']),
          }),
          ...(launchTemplate && { LaunchTemplate: launchTemplate }),
          ...(properties['MixedInstancesPolicy'] !== undefined && {
            MixedInstancesPolicy: properties['MixedInstancesPolicy'] as never,
          }),
          ...(vpcZoneIdentifier !== undefined && { VPCZoneIdentifier: vpcZoneIdentifier }),
          ...(properties['AvailabilityZones'] !== undefined && {
            AvailabilityZones: properties['AvailabilityZones'] as string[],
          }),
          ...(healthCheckTypeInput !== undefined && {
            HealthCheckType: healthCheckTypeInput,
          }),
          ...(healthCheckGracePeriodInput !== undefined && {
            HealthCheckGracePeriod: healthCheckGracePeriodInput,
          }),
          ...(defaultCooldownInput !== undefined && {
            DefaultCooldown: defaultCooldownInput,
          }),
          ...(terminationPoliciesInput !== undefined && {
            TerminationPolicies: terminationPoliciesInput,
          }),
          ...(newInstancesProtectedInput !== undefined && {
            NewInstancesProtectedFromScaleIn: newInstancesProtectedInput,
          }),
          ...(capacityRebalanceInput !== undefined && {
            CapacityRebalance: capacityRebalanceInput,
          }),
          ...(properties['ServiceLinkedRoleARN'] !== undefined && {
            ServiceLinkedRoleARN: properties['ServiceLinkedRoleARN'] as string,
          }),
          ...(maxInstanceLifetimeInput !== undefined && {
            MaxInstanceLifetime: maxInstanceLifetimeInput,
          }),
          ...(properties['Context'] !== undefined && {
            Context: properties['Context'] as string,
          }),
          ...(desiredCapacityTypeInput !== undefined && {
            DesiredCapacityType: desiredCapacityTypeInput,
          }),
          ...(defaultInstanceWarmupInput !== undefined && {
            DefaultInstanceWarmup: defaultInstanceWarmupInput,
          }),
          ...(availabilityZoneDistributionInput !== undefined && {
            AvailabilityZoneDistribution: availabilityZoneDistributionInput,
          }),
          // Removal reset DEFERRED (no SDK-documented default for the
          // sub-fields) — see the comment block above.
          ...(properties['AvailabilityZoneImpairmentPolicy'] !== undefined && {
            AvailabilityZoneImpairmentPolicy: properties[
              'AvailabilityZoneImpairmentPolicy'
            ] as never,
          }),
          ...(properties['SkipZonalShiftValidation'] !== undefined && {
            SkipZonalShiftValidation: properties['SkipZonalShiftValidation'] as boolean,
          }),
          ...(capacityReservationSpecInput !== undefined && {
            CapacityReservationSpecification: capacityReservationSpecInput,
          }),
          ...(instanceMaintenancePolicyInput !== undefined && {
            InstanceMaintenancePolicy: instanceMaintenancePolicyInput,
          }),
          ...(deletionProtectionInput !== undefined && {
            DeletionProtection: deletionProtectionInput,
          }),
        })
      );

      this.logger.debug(`Successfully updated AutoScalingGroup ${logicalId}`);

      const arn = await this.fetchArn(physicalId, context?.maskSecrets);
      const attributes: Record<string, unknown> = {};
      if (arn) attributes['Arn'] = arn;
      if (launchTemplate?.LaunchTemplateId) {
        attributes['LaunchTemplateID'] = launchTemplate.LaunchTemplateId;
      }
      return { physicalId, wasReplaced: false, attributes };
    } catch (error) {
      if (error instanceof ResourceUpdateNotSupportedError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update AutoScalingGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an Auto Scaling group.
   *
   * The compensation boundary (issue #2204): a `--remove-protection` flip of
   * `DeletionProtection` to `none` whose delete then fails terminally is undone
   * here — back to the value the pre-flip readback saw — so a destroy that did
   * not happen does not leave a live group with its guard stripped.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    // The record `run` was handed, so the re-enable and the site's commands
    // can read the value this record's flip removed.
    let current: ProtectionFlipRecord | undefined;
    const removedValue = (): string | undefined =>
      current ? this.removedProtection.get(current) : undefined;
    await deleteWithProtectionCompensation({
      registry: this.protectionFlips,
      key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
      run: (flip) => {
        current = flip;
        return this.deleteOnce(logicalId, physicalId, resourceType, context, flip);
      },
      compensation: {
        logicalId,
        physicalId,
        logger: this.logger,
        site: autoScalingGroupProtectionSite(physicalId, context?.expectedRegion, removedValue),
        reEnable: async () => {
          const value = removedValue();
          // Unreachable while the record is only ever set together with the
          // value (`deleteOnce`); throwing keeps the LOUD "could NOT
          // re-enable" line rather than guessing a level the user never had.
          if (value === undefined) {
            throw new Error('the DeletionProtection value removed by this run was not recorded');
          }
          await this.getClient().send(
            new UpdateAutoScalingGroupCommand({
              AutoScalingGroupName: physicalId,
              DeletionProtection: value as DeletionProtection,
            })
          );
        },
      },
    });
  }

  private async deleteOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    this.logger.debug(`Deleting AutoScalingGroup ${logicalId}: ${physicalId}`);

    // `--remove-protection`: clear DeletionProtection in-place before the
    // actual delete, then set ForceDelete=true so AWS terminates running
    // instances as part of the delete (matches the "I know what I'm doing"
    // intent of the flag). Without `removeProtection`, ForceDelete stays
    // false and AWS rejects the delete on a group with running instances
    // or DeletionProtection set, surfacing as ProvisioningError. The
    // flip-off is idempotent — AWS accepts UpdateAutoScalingGroup
    // (DeletionProtection: 'none') even when protection is already
    // disabled, so we always issue it under the flag. The pre-flip readback is
    // what lets a terminal failure restore ONLY a guard this run turned off,
    // and to the level it had: `prevent-force-deletion` and
    // `prevent-all-deletion` are both "on", and putting back the wrong one
    // would be a configuration change of cdkd's own.
    if (context?.removeProtection === true) {
      try {
        let observed: string | undefined;
        await observeThenDisableProtection({
          flip,
          logger: this.logger,
          physicalId,
          guardName: 'DeletionProtection',
          observe: async () => {
            const group = await this.describeGroup(physicalId);
            const value = group?.DeletionProtection;
            observed = typeof value === 'string' && value !== 'none' ? value : undefined;
            return observed !== undefined;
          },
          disable: async () => {
            await this.getClient().send(
              new UpdateAutoScalingGroupCommand({
                AutoScalingGroupName: physicalId,
                DeletionProtection: 'none' as never,
              })
            );
          },
        });
        // Recorded only once AWS accepted the flip (a rejected one threw out of
        // `observeThenDisableProtection` above), and never CLEARED here: a
        // re-entered attempt observes `none` because the previous one turned it
        // off, so overwriting would lose the level the latch still owes.
        if (observed !== undefined) this.removedProtection.set(flip, observed);
        this.logger.debug(
          `Disabled DeletionProtection on AutoScalingGroup ${logicalId} before delete`
        );
      } catch (flipError) {
        // Non-fatal: log and proceed. The actual delete below surfaces
        // any real error.
        this.logger.debug(
          `Could not disable DeletionProtection on ${physicalId}: ${describeAwsFailure(flipError).detail}`
        );
      }

      // ASG-level DeletionProtection + ForceDelete only governs the GROUP and
      // its scale-in protection. If the group's launch template sets
      // EC2-level termination protection (DisableApiTermination), the
      // ForceDelete below still cannot terminate those instances and they
      // ORPHAN after the group is gone (issue #796). Enumerate the group's
      // current instances and flip each one's DisableApiTermination off first,
      // mirroring the EC2Provider `--remove-protection` path.
      await this.removeInstanceTerminationProtection(physicalId, logicalId);
    }

    try {
      await this.getClient().send(
        new DeleteAutoScalingGroupCommand({
          AutoScalingGroupName: physicalId,
          ForceDelete: context?.removeProtection === true,
        })
      );
      // AWS took the delete, so a throw from the wait below is a WAIT failing,
      // not the delete: the group is going and its guard must not be put back.
      flip.deleteAccepted = true;

      this.logger.debug(`Successfully initiated deletion of AutoScalingGroup ${logicalId}`);

      // Wait for the group to be fully gone. ASG delete is asynchronous —
      // returning immediately would leave dependent EC2 / IAM / SG
      // resources blocked on the lingering group.
      await this.waitForGroupDeleted(physicalId);
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
        this.logger.debug(`AutoScalingGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete AutoScalingGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    const group = await this.describeGroup(physicalId);
    if (!group) {
      throw new ProvisioningError(
        `AutoScalingGroup ${physicalId} not found while resolving attribute ${attributeName}`,
        'AWS::AutoScaling::AutoScalingGroup',
        logicalId,
        physicalId
      );
    }
    switch (attributeName) {
      case 'Arn':
      case 'AutoScalingGroupARN':
        return group.AutoScalingGroupARN ?? '';
      case 'LaunchConfigurationName':
        return group.LaunchConfigurationName ?? '';
      case 'LaunchTemplateID':
      case 'LaunchTemplateId':
        return group.LaunchTemplate?.LaunchTemplateId ?? '';
      default:
        return '';
    }
  }

  /**
   * Read the AWS-current AutoScalingGroup configuration in CFn-property shape.
   *
   * Surfaces the user-controllable subset of `DescribeAutoScalingGroups`,
   * with always-emit placeholders on user-controllable top-level keys per
   * the cdkd PR #145 always-emit convention so that v3 `observedProperties`
   * baseline catches console-side ADDs to fields a clean deploy did not
   * template (e.g. a console-set `DeletionProtection: 'prevent-force-deletion'`
   * on a group originally created without it).
   *
   * Sub-shapes (LifecycleHookSpecificationList / TrafficSources /
   * NotificationConfigurations) are surfaced via three parallel Describe
   * calls fired alongside the primary `DescribeAutoScalingGroups`. Each is
   * best-effort: a per-call failure (e.g. permissions gap on
   * `autoscaling:DescribeLifecycleHooks`) is logged at debug and the
   * matching key falls back to its always-emit `[]` placeholder rather
   * than aborting the whole drift read.
   *
   * `MetricsCollection` is reverse-mapped from `EnabledMetrics` (already
   * present on the primary `DescribeAutoScalingGroups` response, so no
   * extra call is needed).
   *
   * Returns `undefined` when the group is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    // Fire the four reads in parallel. Sub-shape failures are best-effort
    // so a single permission gap does not break the whole drift read.
    const groupPromise = (async () => {
      try {
        return await this.describeGroup(physicalId);
      } catch (err) {
        if (this.isNotFoundError(err)) return undefined;
        throw err;
      }
    })();

    const lifecycleHooksPromise = this.getClient()
      .send(new DescribeLifecycleHooksCommand({ AutoScalingGroupName: physicalId }))
      .then((r) => r.LifecycleHooks ?? [])
      .catch((err) => {
        this.logger.debug(
          `DescribeLifecycleHooks(${physicalId}) failed: ${describeAwsFailure(err).detail}`
        );
        return [];
      });

    const trafficSourcesPromise = this.getClient()
      .send(new DescribeTrafficSourcesCommand({ AutoScalingGroupName: physicalId }))
      .then((r) => r.TrafficSources ?? [])
      .catch((err) => {
        this.logger.debug(
          `DescribeTrafficSources(${physicalId}) failed: ${describeAwsFailure(err).detail}`
        );
        return [];
      });

    const notificationsPromise = this.getClient()
      .send(new DescribeNotificationConfigurationsCommand({ AutoScalingGroupNames: [physicalId] }))
      .then((r) => r.NotificationConfigurations ?? [])
      .catch((err) => {
        this.logger.debug(
          `DescribeNotificationConfigurations(${physicalId}) failed: ${describeAwsFailure(err).detail}`
        );
        return [];
      });

    const [group, lifecycleHooks, trafficSources, notifications] = await Promise.all([
      groupPromise,
      lifecycleHooksPromise,
      trafficSourcesPromise,
      notificationsPromise,
    ]);

    if (!group) return undefined;

    const result: Record<string, unknown> = {};
    if (group.AutoScalingGroupName !== undefined) {
      result['AutoScalingGroupName'] = group.AutoScalingGroupName;
    }
    if (group.LaunchTemplate) {
      const lt: Record<string, unknown> = {};
      if (group.LaunchTemplate.LaunchTemplateId !== undefined) {
        lt['LaunchTemplateId'] = group.LaunchTemplate.LaunchTemplateId;
      }
      if (group.LaunchTemplate.LaunchTemplateName !== undefined) {
        lt['LaunchTemplateName'] = group.LaunchTemplate.LaunchTemplateName;
      }
      if (group.LaunchTemplate.Version !== undefined) {
        lt['Version'] = group.LaunchTemplate.Version;
      }
      result['LaunchTemplate'] = lt;
    }
    result['MinSize'] = group.MinSize ?? 0;
    result['MaxSize'] = group.MaxSize ?? 0;
    if (group.DesiredCapacity !== undefined) result['DesiredCapacity'] = group.DesiredCapacity;
    // VPCZoneIdentifier round-trips back to the CFn list shape so the
    // comparator sees the same array the template emitted, not the
    // SDK-side comma-joined string.
    if (group.VPCZoneIdentifier !== undefined && group.VPCZoneIdentifier !== '') {
      result['VPCZoneIdentifier'] = group.VPCZoneIdentifier.split(',').map((s) => s.trim());
    } else {
      result['VPCZoneIdentifier'] = [];
    }
    result['AvailabilityZones'] = group.AvailabilityZones ?? [];
    if (group.HealthCheckType !== undefined) result['HealthCheckType'] = group.HealthCheckType;
    if (group.HealthCheckGracePeriod !== undefined) {
      result['HealthCheckGracePeriod'] = group.HealthCheckGracePeriod;
    }
    if (group.DefaultCooldown !== undefined) {
      // CFn template field is `Cooldown`; SDK / Describe response calls it
      // `DefaultCooldown`. Surface under the CFn name so the comparator
      // matches state directly.
      result['Cooldown'] = group.DefaultCooldown;
    }
    result['NewInstancesProtectedFromScaleIn'] = group.NewInstancesProtectedFromScaleIn ?? false;
    result['TerminationPolicies'] = group.TerminationPolicies ?? [];
    result['CapacityRebalance'] = group.CapacityRebalance ?? false;
    if (group.ServiceLinkedRoleARN !== undefined) {
      result['ServiceLinkedRoleARN'] = group.ServiceLinkedRoleARN;
    }
    if (group.MaxInstanceLifetime !== undefined) {
      result['MaxInstanceLifetime'] = group.MaxInstanceLifetime;
    }
    result['LoadBalancerNames'] = group.LoadBalancerNames ?? [];
    result['TargetGroupARNs'] = group.TargetGroupARNs ?? [];
    if (group.Context !== undefined) result['Context'] = group.Context;
    if (group.DesiredCapacityType !== undefined) {
      result['DesiredCapacityType'] = group.DesiredCapacityType;
    }
    if (group.DefaultInstanceWarmup !== undefined) {
      result['DefaultInstanceWarmup'] = group.DefaultInstanceWarmup;
    }
    if (group.MixedInstancesPolicy !== undefined) {
      result['MixedInstancesPolicy'] = group.MixedInstancesPolicy;
    }
    if (group.AvailabilityZoneDistribution !== undefined) {
      result['AvailabilityZoneDistribution'] = group.AvailabilityZoneDistribution;
    }
    if (group.AvailabilityZoneImpairmentPolicy !== undefined) {
      result['AvailabilityZoneImpairmentPolicy'] = group.AvailabilityZoneImpairmentPolicy;
    }
    if (group.CapacityReservationSpecification !== undefined) {
      result['CapacityReservationSpecification'] = group.CapacityReservationSpecification;
    }
    if (group.InstanceMaintenancePolicy !== undefined) {
      result['InstanceMaintenancePolicy'] = group.InstanceMaintenancePolicy;
    }
    if (group.DeletionProtection !== undefined) {
      result['DeletionProtection'] = group.DeletionProtection;
    } else {
      // AWS reports `undefined` when the group has the AWS-side default
      // (`'none'`). Always-emit placeholder so the v3 `observedProperties`
      // baseline catches a console-side flip to `prevent-force-deletion`
      // / `prevent-all-deletion`.
      result['DeletionProtection'] = 'none';
    }
    // Tags: filter aws:* prefix and normalize to CFn shape sorted by Key.
    // ASG returns Tags inside the AutoScalingGroup record (already populated
    // by DescribeAutoScalingGroups — no separate ListTagsForResource call).
    result['Tags'] = normalizeAwsTagsToCfn(group.Tags);

    // Sub-shapes — reverse-map AWS responses to CFn template shape and
    // always-emit `[]` placeholders so the v3 `observedProperties` baseline
    // catches console-side ADDs to a previously-empty list.
    result['MetricsCollection'] = mapEnabledMetricsToCfn(group.EnabledMetrics);
    result['LifecycleHookSpecificationList'] = mapLifecycleHooksToCfn(lifecycleHooks);
    // Strip ALL elbv2 / elb entries from TrafficSources — the canonical
    // attachment state for these types lives in TargetGroupARNs /
    // LoadBalancerNames. TrafficSources is meant for attachment types
    // without a dedicated CFn property (VPC Lattice, VPC Endpoint
    // Service). Filtering unconditionally avoids two failure modes
    // surfaced by tests/integration/drift-revert-vpc (PR #547):
    // double-attach/detach on revert, and stale TS entries from AWS's
    // eventual-consistency window after Attach/Detach surfacing as
    // false drift on the next read.
    const dedupedTrafficSources = trafficSources.filter((t) => {
      if (t.Identifier === undefined) return false;
      if (t.Type === 'elbv2' || t.Type === 'elb') return false;
      return true;
    });
    result['TrafficSources'] = mapTrafficSourcesToCfn(dedupedTrafficSources);
    result['NotificationConfigurations'] = mapNotificationsToCfn(notifications);

    return result;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private buildLaunchTemplate(
    properties: Record<string, unknown>
  ): LaunchTemplateSpecification | undefined {
    const lt = properties['LaunchTemplate'] as
      | { LaunchTemplateId?: string; LaunchTemplateName?: string; Version?: string | number }
      | undefined;
    if (!lt) return undefined;
    const out: LaunchTemplateSpecification = {};
    // AWS UpdateAutoScalingGroup rejects when both LaunchTemplateId and
    // LaunchTemplateName are present in the same LaunchTemplate object
    // ("Valid requests must contain either launchTemplateId or
    // LaunchTemplateName"). DescribeAutoScalingGroups returns both, so
    // a straight readCurrentState → update round-trip on `drift --revert`
    // would hit this. Prefer the ID (canonical, doesn't change on LT
    // rename) and only fall back to Name when ID is absent.
    if (lt.LaunchTemplateId !== undefined) {
      out.LaunchTemplateId = lt.LaunchTemplateId;
      if (lt.LaunchTemplateName !== undefined) {
        // User templated BOTH — AWS would reject the resulting Create /
        // Update otherwise; we silently prefer the ID. Surface the
        // choice in --verbose so a user wondering why their Name didn't
        // take effect has an auditable signal.
        this.logger.debug(
          `buildLaunchTemplate: both LaunchTemplateId (${lt.LaunchTemplateId}) and LaunchTemplateName (${lt.LaunchTemplateName}) templated; dropping Name (#551)`
        );
      }
    } else if (lt.LaunchTemplateName !== undefined) {
      out.LaunchTemplateName = lt.LaunchTemplateName;
    }
    if (lt.Version !== undefined) {
      // Defensive coercion: AWS SDK `LaunchTemplateSpecification.Version`
      // is `string` and AWS rejects non-string forms with `Invalid
      // launch template version: either '$Default', '$Latest', or a
      // numeric version are allowed.`. cdkd's `IntrinsicResolver`
      // resolves `Fn::GetAtt <LaunchTemplate>.LatestVersionNumber`
      // through a per-type lookup; intermediate cases could surface
      // numeric values, so we coerce defensively.
      out.Version = String(lt.Version);
    }
    if (out.LaunchTemplateId === undefined && out.LaunchTemplateName === undefined) {
      return undefined;
    }
    return out;
  }

  /**
   * CFn `Tags` is `[{Key, Value, PropagateAtLaunch?}]`. AWS expects each
   * tag to also carry `ResourceId: <groupName>` and `ResourceType:
   * 'auto-scaling-group'`. We tack those on at create time so the SDK
   * input shape matches without forcing the user to template them.
   */
  private buildTags(groupName: string, properties: Record<string, unknown>): ASGTag[] {
    const raw = properties['Tags'] as
      | Array<{ Key?: string; Value?: string; PropagateAtLaunch?: boolean }>
      | undefined;
    if (!raw) return [];
    return raw
      .filter((t) => t.Key !== undefined)
      .map((t) => ({
        ResourceId: groupName,
        ResourceType: 'auto-scaling-group',
        Key: t.Key as string,
        Value: t.Value ?? '',
        PropagateAtLaunch: t.PropagateAtLaunch ?? false,
      }));
  }

  /**
   * CFn `VPCZoneIdentifier` is a list of subnet ids; the AWS SDK input
   * field is a comma-joined string.
   */
  private joinVpcZoneIdentifier(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) {
      const cleaned = value.map((v) => String(v).trim()).filter((v) => v.length > 0);
      if (cleaned.length === 0) return undefined;
      return cleaned.join(',');
    }
    if (typeof value === 'string') return value;
    return undefined;
  }

  private async describeGroup(groupName: string) {
    const response = await this.getClient().send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [groupName],
      })
    );
    return response.AutoScalingGroups?.[0];
  }

  /**
   * Flip EC2-level termination protection (`DisableApiTermination`) off on
   * every instance currently launched by the group, so the subsequent
   * `DeleteAutoScalingGroup(ForceDelete: true)` can actually terminate them
   * instead of orphaning the protected instances (issue #796). Best-effort:
   * a Describe failure or a per-instance flip failure is logged at debug and
   * does not block the delete (the modify WRITE lags the terminate READ, so
   * the shared helper swallows propagation errors the same way the EC2 path
   * does — the orphan, if any, surfaces as a leftover instance the caller
   * can clean up rather than a hard delete failure).
   */
  private async removeInstanceTerminationProtection(
    groupName: string,
    logicalId: string,
    // The create path passes its masker: AWS's describe error can echo the
    // group name, which may be a resolved secret there. `delete()` has none.
    maskSecrets: SecretMasker = (text) => text,
    // Instances already flipped by an earlier pass of the same retire.
    alreadyFlipped: Set<string> = new Set()
  ): Promise<void> {
    let instanceIds: string[];
    try {
      const group = await this.describeGroup(groupName);
      instanceIds = (group?.Instances ?? [])
        .map((i) => i.InstanceId)
        .filter(
          (id): id is string => typeof id === 'string' && id.length > 0 && !alreadyFlipped.has(id)
        );
    } catch (describeError) {
      this.logger.debug(
        maskSecrets(
          `Could not enumerate instances of AutoScalingGroup ${logicalId} for termination-protection removal: ${describeAwsFailure(describeError).detail}`
        )
      );
      return;
    }

    if (instanceIds.length === 0) return;

    this.logger.debug(
      `Disabling EC2 termination protection on ${instanceIds.length} instance(s) of AutoScalingGroup ${logicalId} before force delete`
    );
    for (const instanceId of instanceIds) {
      // Only an ACCEPTED flip is recorded, so a later pass retries a failed one.
      if (await disableInstanceApiTermination(this.getEc2Client(), instanceId, this.logger)) {
        alreadyFlipped.add(instanceId);
      }
    }
  }

  private async fetchArn(
    groupName: string,
    // The create path passes its masker: the name may be a resolved secret.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<string | undefined> {
    try {
      const group = await this.describeGroup(groupName);
      return group?.AutoScalingGroupARN;
    } catch (err) {
      this.logger.debug(
        maskSecrets(
          `DescribeAutoScalingGroups(${groupName}) failed: ${describeAwsFailure(err).detail}`
        )
      );
      return undefined;
    }
  }

  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    // ASG returns ValidationError with message "AutoScalingGroup name not
    // found" rather than a typed NotFound exception; cover both shapes.
    return (
      name === 'ValidationError' &&
      (message.includes('autoscalinggroup name not found') ||
        message.includes('not found') ||
        message.includes('does not exist'))
    );
  }

  private async waitForGroupDeleted(groupName: string, maxWaitMs = 900_000): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const group = await this.describeGroup(groupName);
        if (!group) return;
      } catch (error) {
        if (this.isNotFoundError(error)) return;
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for AutoScalingGroup ${groupName} to be deleted (15 minute cap)`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Read every list property of both sides, refusing a malformed one before
   * any call (go-to-k/cdkd#3948). ABSENT reads as the empty list.
   *
   * One exception keeps a deploy moving: a malformed RECORDED
   * `LoadBalancerNames` / `TargetGroupARNs` is read from the live group
   * instead, once every desired list and every other recorded list is
   * well-formed. That covers a dynamic reference or its mask (cdkd keeps
   * `{{resolve:...}}` in state by design) and a record `cdkd import` left with
   * an unresolved intrinsic (`[{ Ref: 'MyTG' }]`), which used to self-heal on
   * the next deploy. Only the live entries the desired side also names are
   * taken, so the read is ADD-only: nothing is detached on the strength of a
   * record cdkd could not read, and a live entry the desired side omits stays
   * attached, with a warning.
   */
  private async readUpdateLists(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    desired: Record<ListKind, unknown>,
    recorded: Record<ListKind, unknown>
  ): Promise<{
    next: Record<ListKind, unknown[]>;
    prev: Record<ListKind, unknown[]>;
    /** Live entries an unreadable record hid, left attached on purpose. */
    retained: Record<AttachmentKind, string[]>;
  }> {
    const nextRead = readLists(desired, 'desired');
    const prevRead = readLists(recorded, 'recorded');
    const badNext = malformedKinds(nextRead);
    let badPrev = malformedKinds(prevRead);
    const retained: Record<AttachmentKind, string[]> = {
      LoadBalancerNames: [],
      TargetGroupARNs: [],
    };
    const readLive = (k: ListKind): boolean => {
      const read = prevRead[k];
      return isAttachmentKind(k) && read.kind === 'malformed';
    };

    if (badNext.length === 0 && badPrev.length > 0 && badPrev.every(readLive)) {
      const kinds = badPrev.join(' / ');
      let group: Awaited<ReturnType<ASGProvider['describeGroup']>>;
      try {
        group = await this.describeGroup(physicalId);
      } catch (error) {
        // Not marked non-retryable: a throttled read is worth the retry, which
        // classifies through `cause`.
        throw new ProvisioningError(
          `the recorded ${kinds} of AutoScalingGroup ${logicalId} is not a list cdkd can read, ` +
            `and the live group could not be read from Auto Scaling instead — nothing was ` +
            `attached or detached`,
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        );
      }
      for (const kind of badPrev as AttachmentKind[]) {
        const live = (group?.[kind] ?? []).filter((v): v is string => typeof v === 'string');
        const wanted = itemsOf(nextRead[kind]);
        prevRead[kind] = { kind: 'list', items: live.filter((v) => wanted.includes(v)) };
        retained[kind] = live.filter((v) => !wanted.includes(v));
        if (retained[kind].length > 0) {
          this.logger.warn(
            safeMsg`The recorded ${kind} of AutoScalingGroup ${logicalId} is not a list cdkd can read, so cdkd read it from Auto Scaling; the group holds ${kind} entries the desired list does not name, and cdkd left them attached. Detach them yourself if they are no longer wanted.`
          );
        }
      }
      badPrev = [];
    }

    if (badNext.length > 0 || badPrev.length > 0) {
      const which = [...badNext.map((k) => `desired ${k}`), ...badPrev.map((k) => `recorded ${k}`)];
      const what = [...new Set([...badNext, ...badPrev].map(listWhat))];
      throw markNonRetryable(
        new ProvisioningError(
          `${which.join(' / ')} of AutoScalingGroup ${logicalId} is not a list of ` +
            `${what.join(' / ')}${secretDerivedCause(badNext, nextRead)} — nothing was attached, ` +
            `detached or removed` +
            (badPrev.length > 0 ? `: ${this.recordedListRepair(badPrev, prevRead)}` : ''),
          resourceType,
          logicalId,
          physicalId
        )
      );
    }

    const next = {} as Record<ListKind, unknown[]>;
    const prev = {} as Record<ListKind, unknown[]>;
    for (const kind of LIST_KINDS) {
      next[kind] = itemsOf(nextRead[kind]);
      prev[kind] = removableRecorded(kind, itemsOf(prevRead[kind]));
    }
    return { next, prev, retained };
  }

  /**
   * The repair sentence for malformed RECORDED lists, echoing no record
   * content. An attachment list needs no repair: it is read from the live group
   * once the desired side is well-formed. A secret-derived entry list must never
   * be answered with "write the value into state.json"; setting it to `[]` is
   * always safe, since an empty recorded list removes nothing and re-applies
   * what the desired side names.
   */
  private recordedListRepair(kinds: ListKind[], read: Record<ListKind, ListRead>): string {
    const live = kinds.filter(isAttachmentKind);
    const entry = kinds.filter((k) => !isAttachmentKind(k));
    const secret = entry.filter((k) => {
      const r = read[k];
      return r.kind === 'malformed' && r.secretDerived;
    });
    const plain = entry.filter((k) => !secret.includes(k));
    const parts: string[] = [];
    if (plain.length > 0) {
      parts.push(
        `repair the recorded ${plain.join(' / ')} in state.json to a list of ` +
          `${[...new Set(plain.map(listWhat))].join(' / ')} and re-run`
      );
    }
    if (secret.length > 0) {
      parts.push(
        `the recorded ${secret.join(' / ')} is secret-derived (cdkd keeps the dynamic reference ` +
          `or its mask in state), so do not write the value into state.json; set it to [] in ` +
          `state.json and re-run, which removes nothing`
      );
    }
    if (live.length > 0) {
      parts.push(
        `the recorded ${live.join(' / ')} needs no repair: cdkd reads it from Auto Scaling ` +
          `instead once every desired list and every other recorded list is well-formed`
      );
    }
    return parts.join('; ');
  }

  // ─── Sub-shape diff helpers ───────────────────────────────────────
  // Each helper is a no-op when before/after JSON is identical (the cheap
  // structural-equality check happens first; we only build SDK calls for
  // genuine diffs). Identity is positional within the array per CFn shape:
  // `MetricsCollection` keyed on `Granularity`, `LifecycleHookSpecification
  // List` on `LifecycleHookName`, `TrafficSources` on `Identifier`,
  // `NotificationConfigurations` on `TopicARN`.

  /**
   * Diff and apply changes to the ASG's `Tags` property via the
   * `CreateOrUpdateTags` / `DeleteTags` AWS APIs (#475). CFn Tags shape is
   * `[{Key, Value, PropagateAtLaunch}]`; AWS Tag input adds `ResourceId`
   * (= the ASG name) and `ResourceType: 'auto-scaling-group'`.
   *
   * Diff semantics:
   *   - Removed keys → `DeleteTags`.
   *   - Added keys → `CreateOrUpdateTags`.
   *   - Modified value or `PropagateAtLaunch` flag → `CreateOrUpdateTags`
   *     (the AWS API upserts by `(ResourceId, ResourceType, Key)` tuple, so
   *     a single upsert call replaces the old value).
   *
   * No-op when before/after JSON is identical.
   */
  private async applyTagsDiff(physicalId: string, next: unknown[], prev: unknown[]): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    type CfnTag = { Key?: string; Value?: string; PropagateAtLaunch?: boolean };
    const nextEntries = next as CfnTag[];
    const prevEntries = prev as CfnTag[];
    const nextByKey = new Map<string, CfnTag>();
    for (const t of nextEntries) {
      if (t.Key) nextByKey.set(t.Key, t);
    }
    const prevByKey = new Map<string, CfnTag>();
    for (const t of prevEntries) {
      if (t.Key) prevByKey.set(t.Key, t);
    }
    // Delete keys removed from `next`.
    const toDelete: CfnTag[] = [];
    for (const [key, tag] of prevByKey) {
      if (!nextByKey.has(key)) toDelete.push(tag);
    }
    if (toDelete.length > 0) {
      await this.getClient().send(
        new DeleteTagsCommand({
          // DeleteTags is keyed only by (ResourceId, ResourceType, Key).
          // Intentionally omit `Value` / `PropagateAtLaunch`: AWS treats
          // those as additional match constraints, so passing the
          // cdkd-recorded values would silently no-op when a console-side
          // edit drifted them between deploys. cdkd owns the tag, so
          // delete-by-key matches the "we own the resource" intent.
          Tags: toDelete.map((t) => ({
            ResourceId: physicalId,
            ResourceType: 'auto-scaling-group',
            Key: t.Key as string,
          })),
        })
      );
    }
    // Upsert keys whose value / propagate-flag differs.
    const toUpsert: CfnTag[] = [];
    for (const [key, tag] of nextByKey) {
      const before = prevByKey.get(key);
      if (JSON.stringify(before) === JSON.stringify(tag)) continue;
      toUpsert.push(tag);
    }
    if (toUpsert.length > 0) {
      await this.getClient().send(
        new CreateOrUpdateTagsCommand({
          Tags: toUpsert.map((t) => ({
            ResourceId: physicalId,
            ResourceType: 'auto-scaling-group',
            Key: t.Key as string,
            ...(t.Value !== undefined && { Value: t.Value }),
            ...(t.PropagateAtLaunch !== undefined && {
              PropagateAtLaunch: t.PropagateAtLaunch,
            }),
          })),
        })
      );
    }
  }

  /**
   * Diff `LoadBalancerNames` (Classic Load Balancers) and issue
   * `AttachLoadBalancers` / `DetachLoadBalancers` for the delta (#476).
   * Names are opaque strings; AWS allows N attached LBs per ASG so this
   * helper batches every add into one Attach call and every remove into
   * one Detach call. No-op when before/after JSON is identical.
   */
  private async applyLoadBalancerNamesDiff(
    physicalId: string,
    nextNames: string[],
    prevNames: string[]
  ): Promise<void> {
    if (JSON.stringify(nextNames) === JSON.stringify(prevNames)) return;
    const nextSet = new Set(nextNames);
    const prevSet = new Set(prevNames);
    const toAttach = nextNames.filter((n) => !prevSet.has(n));
    const toDetach = prevNames.filter((n) => !nextSet.has(n));
    if (toDetach.length > 0) {
      await this.getClient().send(
        new DetachLoadBalancersCommand({
          AutoScalingGroupName: physicalId,
          LoadBalancerNames: toDetach,
        })
      );
    }
    if (toAttach.length > 0) {
      await this.getClient().send(
        new AttachLoadBalancersCommand({
          AutoScalingGroupName: physicalId,
          LoadBalancerNames: toAttach,
        })
      );
    }
  }

  /**
   * Diff `TargetGroupARNs` (ALB / NLB target groups) and issue
   * `AttachLoadBalancerTargetGroups` /
   * `DetachLoadBalancerTargetGroups` for the delta (#476). Target-group
   * ARNs are opaque strings; same per-call batching pattern as
   * `applyLoadBalancerNamesDiff`. No-op when before/after JSON is
   * identical.
   */
  private async applyTargetGroupArnsDiff(
    physicalId: string,
    nextArns: string[],
    prevArns: string[],
    maskSecrets?: SecretMasker,
    // Live target groups a secret-derived record hid, which this update leaves
    // attached: the convergence poll must expect them too (go-to-k/cdkd#3948).
    retainedArns: string[] = []
  ): Promise<void> {
    if (JSON.stringify(nextArns) === JSON.stringify(prevArns)) return;
    const nextSet = new Set(nextArns);
    const prevSet = new Set(prevArns);
    const toAttach = nextArns.filter((a) => !prevSet.has(a));
    const toDetach = prevArns.filter((a) => !nextSet.has(a));
    if (toDetach.length > 0) {
      await this.getClient().send(
        new DetachLoadBalancerTargetGroupsCommand({
          AutoScalingGroupName: physicalId,
          TargetGroupARNs: toDetach,
        })
      );
    }
    if (toAttach.length > 0) {
      await this.getClient().send(
        new AttachLoadBalancerTargetGroupsCommand({
          AutoScalingGroupName: physicalId,
          TargetGroupARNs: toAttach,
        })
      );
    }
    // AttachLoadBalancerTargetGroups is async — the target group starts in
    // 'Adding' state and only becomes visible in
    // DescribeAutoScalingGroups.TargetGroupARNs after AWS internal
    // propagation. A subsequent `cdkd drift` read right after the call
    // returns can otherwise see a stale snapshot and report drift
    // against the AWS-side empty list (surfaced by tests/integration/
    // drift-revert-vpc's step-6 "drift again" check). Bounded poll to
    // confirm the post-state matches the intent before returning so the
    // caller's next read is consistent.
    if (toDetach.length > 0 || toAttach.length > 0) {
      await this.waitForTargetGroupArnsConvergence(
        physicalId,
        new Set([...nextArns, ...retainedArns]),
        maskSecrets
      );
    }
  }

  private static readonly TG_CONVERGENCE_TIMEOUT_MS = 30_000;
  private static readonly TG_CONVERGENCE_POLL_INTERVAL_MS = 1_000;

  /**
   * `maskSecrets` is the caller's secret masker (issue #1932 item 3, adopted
   * here by issue #1997), threaded from `UpdateContext` via
   * `applyTargetGroupArnsDiff`. `expected` is built from the RESOLVED
   * `TargetGroupARNs` bag, so a `{{resolve:secretsmanager:...}}` scalar in it is
   * already plaintext by the time this method names it. It defaults to IDENTITY
   * so every existing caller and unit test keeps working unchanged.
   */
  private async waitForTargetGroupArnsConvergence(
    physicalId: string,
    expected: Set<string>,
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    // ONE masked sink per level for every line in this method (issue #1997),
    // rather than a `maskSecrets(...)` at each call: a line added later is
    // masked by construction instead of by the author remembering. Each is the
    // OUTER of two layers — a finished message is always longer than the value
    // inside it, so it can only reach `maskSecretsInText`'s SUBSTRING arm, which
    // ignores needles below `MIN_NEEDLE_LENGTH` (4); the per-ARN mask below is
    // the inner layer, reaching the WHOLE-VALUE arm at any length.
    const warn = (message: string): void => this.logger.warn(maskSecrets(message));
    const debug = (message: string): void => this.logger.debug(maskSecrets(message));
    const deadlineMs = Date.now() + ASGProvider.TG_CONVERGENCE_TIMEOUT_MS;
    let lastObserved: Set<string> = new Set();
    while (Date.now() < deadlineMs) {
      let resp: DescribeAutoScalingGroupsCommandOutput | undefined;
      try {
        resp = await this.getClient().send(
          new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [physicalId] })
        );
      } catch (err) {
        // Transient throttle / network blip during the 30s window must
        // not throw out of applyTargetGroupArnsDiff — the Attach/Detach
        // already succeeded, and propagating would fail the whole
        // update path. Log + retry; the loop will fall through to the
        // timeout-warn path if the API is genuinely down.
        debug(
          `applyTargetGroupArnsDiff convergence poll: transient error, retrying — ${
            describeAwsFailure(err).detail
          }`
        );
        await new Promise((r) => setTimeout(r, ASGProvider.TG_CONVERGENCE_POLL_INTERVAL_MS));
        continue;
      }
      lastObserved = new Set(resp.AutoScalingGroups?.[0]?.TargetGroupARNs ?? []);
      if (lastObserved.size === expected.size && [...expected].every((a) => lastObserved.has(a))) {
        return;
      }
      await new Promise((r) => setTimeout(r, ASGProvider.TG_CONVERGENCE_POLL_INTERVAL_MS));
    }
    // Timeout — surface as a warning rather than failure so the caller
    // still sees the SDK-side success; drift can re-report if the
    // propagation is still stuck. Includes observed vs expected so
    // post-mortem doesn't need a re-deploy.
    // Sort both sides before stringify for visual symmetry — expected
    // comes from the caller's insertion order, observed from AWS-side
    // order; eyeballing the diff in logs is easier when both are sorted.
    //
    // Each ARN is masked INDIVIDUALLY before being stringified (issue #1997):
    // `JSON.stringify` escapes `"` / `\` / newlines, so a secret carrying any of
    // them no longer OCCURS in the finished line and the outer sink alone would
    // miss it. The observed side is masked too — it comes back from AWS, but a
    // resolved secret sent by an earlier deploy is exactly what AWS echoes.
    const expectedSorted = [...expected].sort().map((a) => maskSecrets(a));
    const observedSorted = [...lastObserved].sort().map((a) => maskSecrets(a));
    warn(
      `applyTargetGroupArnsDiff: TG set did not converge within ${ASGProvider.TG_CONVERGENCE_TIMEOUT_MS}ms for ASG ${physicalId}. expected=${JSON.stringify(expectedSorted)} observed=${JSON.stringify(observedSorted)}`
    );
  }

  /**
   * Diff `MetricsCollection` as AWS holds it (go-to-k/cdkd#4013): a SET of
   * enabled metrics per granularity, where CDK renders one entry per
   * `GroupMetrics`, all at `1Minute`. Both sides are folded with
   * {@link foldMetricsCollection} first; keying the raw entries by granularity
   * kept only the LAST entry on each side, so several `GroupMetrics` enabled
   * only one group's metrics on update and never disabled the others' removals.
   *
   * Per granularity: dropped entirely -> Disable its metrics (all of them when
   * it was ALL); now ALL -> one Enable without `Metrics`; now a set -> Disable
   * what left the set (every metric first, when it was ALL) and Enable the
   * whole set (Enable is additive and idempotent, so re-sending the kept
   * members also re-applies anything changed out of band). No-op when the
   * folded sides are equal.
   */
  private async applyMetricsCollectionDiff(
    physicalId: string,
    next: unknown[],
    prev: unknown[]
  ): Promise<void> {
    const nextFold = foldMetricsCollection(next);
    const prevFold = foldMetricsCollection(prev);
    if (JSON.stringify(nextFold) === JSON.stringify(prevFold)) return;
    const toMap = (fold: FoldedMetrics[]): Map<string, string[] | undefined> =>
      new Map(fold.map((e) => [e.Granularity, e.Metrics]));
    const prevBy = toMap(prevFold);
    const nextBy = toMap(nextFold);
    const disable = async (metrics: string[] | undefined): Promise<void> => {
      await this.getClient().send(
        new DisableMetricsCollectionCommand({
          AutoScalingGroupName: physicalId,
          ...(metrics !== undefined ? { Metrics: metrics } : {}),
        })
      );
    };
    const enable = async (granularity: string, metrics: string[] | undefined): Promise<void> => {
      // Never as ALL once this call has sent a Disable: ALL would re-enable what
      // that Disable just removed (a metric beyond the known list included).
      const asAll =
        metrics === undefined || (disables.length === 0 && holdsAllKnownMetrics(metrics));
      await this.getClient().send(
        new EnableMetricsCollectionCommand({
          AutoScalingGroupName: physicalId,
          Granularity: granularity,
          ...(asAll ? {} : { Metrics: metrics }),
        })
      );
    };
    // DisableMetricsCollection takes no Granularity, so a Disable for one
    // granularity also turns a metric off at another. Every Disable therefore
    // goes out FIRST, and once any has, every desired granularity is enabled
    // again (Enable is additive and idempotent); otherwise only the changed ones.
    const disables: Array<string[] | undefined> = [];
    const changed = new Set<string>();
    for (const [granularity, metrics] of prevBy) {
      if (!nextBy.has(granularity)) disables.push(metrics);
    }
    for (const [granularity, metrics] of nextBy) {
      const had = prevBy.has(granularity);
      const before = prevBy.get(granularity);
      if (had && JSON.stringify(before ?? null) === JSON.stringify(metrics ?? null)) continue;
      changed.add(granularity);
      if (metrics !== undefined && had) {
        // ALL -> a subset: clear everything, then enable the subset. A subset
        // that shrank: disable only what left it.
        if (before === undefined) {
          disables.push(undefined);
        } else {
          const removed = before.filter((m) => !metrics.includes(m));
          if (removed.length > 0) disables.push(removed);
        }
      }
    }
    for (const metrics of disables) await disable(metrics);
    for (const [granularity, metrics] of nextBy) {
      if (disables.length > 0 || changed.has(granularity)) await enable(granularity, metrics);
    }
  }

  private async applyLifecycleHooksDiff(
    physicalId: string,
    next: unknown[],
    prev: unknown[]
  ): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    const nextEntries = next as Array<{
      LifecycleHookName?: string;
      LifecycleTransition?: string;
      RoleARN?: string;
      NotificationTargetARN?: string;
      NotificationMetadata?: string;
      HeartbeatTimeout?: number;
      DefaultResult?: string;
    }>;
    const prevEntries = prev as Array<{
      LifecycleHookName?: string;
    }>;
    const nextNames = new Set(
      nextEntries.map((e) => e.LifecycleHookName).filter((n): n is string => !!n)
    );
    // Delete hooks no longer in `next`.
    for (const e of prevEntries) {
      if (e.LifecycleHookName && !nextNames.has(e.LifecycleHookName)) {
        await this.getClient().send(
          new DeleteLifecycleHookCommand({
            AutoScalingGroupName: physicalId,
            LifecycleHookName: e.LifecycleHookName,
          })
        );
      }
    }
    // PutLifecycleHook is upsert — issue for every hook in `next` whose
    // shape differs from the matching `prev` entry.
    const prevByName = new Map<string, unknown>();
    for (const e of prevEntries) {
      if (e.LifecycleHookName) prevByName.set(e.LifecycleHookName, e);
    }
    for (const e of nextEntries) {
      if (!e.LifecycleHookName) continue;
      const prevHook = prevByName.get(e.LifecycleHookName);
      if (JSON.stringify(prevHook) === JSON.stringify(e)) continue;
      await this.getClient().send(
        new PutLifecycleHookCommand({
          AutoScalingGroupName: physicalId,
          LifecycleHookName: e.LifecycleHookName,
          ...(e.LifecycleTransition !== undefined && {
            LifecycleTransition: e.LifecycleTransition,
          }),
          ...(e.RoleARN !== undefined && { RoleARN: e.RoleARN }),
          ...(e.NotificationTargetARN !== undefined && {
            NotificationTargetARN: e.NotificationTargetARN,
          }),
          ...(e.NotificationMetadata !== undefined && {
            NotificationMetadata: e.NotificationMetadata,
          }),
          ...(e.HeartbeatTimeout !== undefined && { HeartbeatTimeout: e.HeartbeatTimeout }),
          ...(e.DefaultResult !== undefined && { DefaultResult: e.DefaultResult }),
        })
      );
    }
  }

  private async applyTrafficSourcesDiff(
    physicalId: string,
    next: unknown[],
    prev: unknown[]
  ): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    const nextEntries = next as Array<{
      Identifier?: string;
      Type?: string;
    }>;
    const prevEntries = prev as Array<{
      Identifier?: string;
      Type?: string;
    }>;
    const nextIds = new Set(nextEntries.map((e) => e.Identifier).filter((i): i is string => !!i));
    const prevIds = new Set(prevEntries.map((e) => e.Identifier).filter((i): i is string => !!i));
    const toDetach = prevEntries.filter((e) => e.Identifier && !nextIds.has(e.Identifier));
    const toAttach = nextEntries.filter((e) => e.Identifier && !prevIds.has(e.Identifier));
    if (toDetach.length > 0) {
      await this.getClient().send(
        new DetachTrafficSourcesCommand({
          AutoScalingGroupName: physicalId,
          TrafficSources: toDetach.map((e) => ({
            Identifier: e.Identifier as string,
            ...(e.Type !== undefined && { Type: e.Type }),
          })),
        })
      );
    }
    if (toAttach.length > 0) {
      await this.getClient().send(
        new AttachTrafficSourcesCommand({
          AutoScalingGroupName: physicalId,
          TrafficSources: toAttach.map((e) => ({
            Identifier: e.Identifier as string,
            ...(e.Type !== undefined && { Type: e.Type }),
          })),
        })
      );
    }
  }

  private async applyNotificationConfigurationsDiff(
    physicalId: string,
    next: unknown[],
    prev: unknown[]
  ): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    // CFn `NotificationConfigurations` is an array of `{TopicARN,
    // NotificationTypes[]}`; AWS `PutNotificationConfiguration` is keyed
    // by TopicARN — one call per topic. AWS reports each notification
    // type as a separate response entry (one row per `(asgName, topicArn,
    // notificationType)` triple), but cdkd state stores the CFn shape, so
    // both sides of the diff share the per-topic key.
    const nextEntries = next as Array<{
      TopicARN?: string;
      NotificationTypes?: string[];
    }>;
    const prevEntries = prev as Array<{
      TopicARN?: string;
      NotificationTypes?: string[];
    }>;
    const nextByTopic = new Map<string, string[] | undefined>();
    for (const e of nextEntries) {
      if (e.TopicARN) nextByTopic.set(e.TopicARN, e.NotificationTypes);
    }
    const prevByTopic = new Map<string, string[] | undefined>();
    for (const e of prevEntries) {
      if (e.TopicARN) prevByTopic.set(e.TopicARN, e.NotificationTypes);
    }
    for (const topic of prevByTopic.keys()) {
      if (!nextByTopic.has(topic)) {
        await this.getClient().send(
          new DeleteNotificationConfigurationCommand({
            AutoScalingGroupName: physicalId,
            TopicARN: topic,
          })
        );
      }
    }
    for (const [topic, types] of nextByTopic) {
      const before = prevByTopic.get(topic);
      if (JSON.stringify(before ?? null) === JSON.stringify(types ?? null)) continue;
      await this.getClient().send(
        new PutNotificationConfigurationCommand({
          AutoScalingGroupName: physicalId,
          TopicARN: topic,
          NotificationTypes: types ?? [],
        })
      );
    }
  }
}

// ─── File-level reverse-mappers (CFn template shape) ────────────────

/**
 * Reverse-map AWS `EnabledMetrics: [{Metric, Granularity}]` (flat list,
 * one row per enabled metric) back to the CFn array shape
 * `[{Granularity, Metrics?[]}]`. Metrics with the same Granularity are
 * grouped together; the resulting Metrics list is sorted alphabetically
 * for stable positional compare in the drift comparator.
 *
 * Always returns a placeholder `[]` per the cdkd PR #145 always-emit
 * convention so a console-side EnableMetricsCollection on a previously-
 * empty group surfaces as drift on the v3 `observedProperties` baseline.
 */
function mapEnabledMetricsToCfn(
  enabledMetrics:
    | Array<{ Metric?: string | undefined; Granularity?: string | undefined }>
    | undefined
): Array<{ Granularity: string; Metrics?: string[] }> {
  if (!enabledMetrics || enabledMetrics.length === 0) return [];
  const byGranularity = new Map<string, Set<string>>();
  for (const e of enabledMetrics) {
    const g = e.Granularity;
    if (!g) continue;
    let set = byGranularity.get(g);
    if (!set) {
      set = new Set();
      byGranularity.set(g, set);
    }
    if (e.Metric) set.add(e.Metric);
  }
  const result: Array<{ Granularity: string; Metrics?: string[] }> = [];
  // Sort by Granularity for stable positional compare.
  for (const granularity of Array.from(byGranularity.keys()).sort()) {
    const metrics = Array.from(byGranularity.get(granularity) ?? []).sort();
    result.push(
      metrics.length > 0
        ? { Granularity: granularity, Metrics: metrics }
        : { Granularity: granularity }
    );
  }
  return result;
}

/**
 * Reverse-map AWS `DescribeLifecycleHooks` response to the CFn
 * `LifecycleHookSpecificationList` shape. Each hook is surfaced under the
 * exact CFn property name. AWS-side fields cdkd state never carried
 * (`AutoScalingGroupName` — duplicated on every hook by AWS,
 * `GlobalTimeout` — AWS-derived) are filtered out. Sorted by
 * LifecycleHookName for stable positional compare.
 */
function mapLifecycleHooksToCfn(
  hooks: Array<{
    LifecycleHookName?: string | undefined;
    LifecycleTransition?: string | undefined;
    NotificationTargetARN?: string | undefined;
    RoleARN?: string | undefined;
    NotificationMetadata?: string | undefined;
    HeartbeatTimeout?: number | undefined;
    DefaultResult?: string | undefined;
  }>
): Array<Record<string, unknown>> {
  if (!hooks || hooks.length === 0) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const h of hooks) {
    if (!h.LifecycleHookName) continue;
    const entry: Record<string, unknown> = { LifecycleHookName: h.LifecycleHookName };
    if (h.LifecycleTransition !== undefined) entry['LifecycleTransition'] = h.LifecycleTransition;
    if (h.RoleARN !== undefined) entry['RoleARN'] = h.RoleARN;
    if (h.NotificationTargetARN !== undefined) {
      entry['NotificationTargetARN'] = h.NotificationTargetARN;
    }
    if (h.NotificationMetadata !== undefined) {
      entry['NotificationMetadata'] = h.NotificationMetadata;
    }
    if (h.HeartbeatTimeout !== undefined) entry['HeartbeatTimeout'] = h.HeartbeatTimeout;
    if (h.DefaultResult !== undefined) entry['DefaultResult'] = h.DefaultResult;
    result.push(entry);
  }
  result.sort((a, b) =>
    String(a['LifecycleHookName']).localeCompare(String(b['LifecycleHookName']))
  );
  return result;
}

/**
 * Reverse-map AWS `DescribeTrafficSources` response to the CFn
 * `TrafficSources` shape `[{Identifier, Type?}]`. AWS-side runtime fields
 * (`State`, the deprecated `TrafficSource` alias) are filtered out.
 * Sorted by Identifier for stable positional compare.
 */
function mapTrafficSourcesToCfn(
  trafficSources: Array<{ Identifier?: string | undefined; Type?: string | undefined }>
): Array<Record<string, unknown>> {
  if (!trafficSources || trafficSources.length === 0) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const t of trafficSources) {
    if (!t.Identifier) continue;
    const entry: Record<string, unknown> = { Identifier: t.Identifier };
    if (t.Type !== undefined) entry['Type'] = t.Type;
    result.push(entry);
  }
  result.sort((a, b) => String(a['Identifier']).localeCompare(String(b['Identifier'])));
  return result;
}

/**
 * Reverse-map AWS `DescribeNotificationConfigurations` (a flat list, one
 * row per `(topicArn, notificationType)`) into the CFn shape
 * `[{TopicARN, NotificationTypes[]}]`. NotificationTypes are grouped per
 * TopicARN and sorted alphabetically for stable positional compare.
 */
function mapNotificationsToCfn(
  configurations: Array<{ TopicARN?: string | undefined; NotificationType?: string | undefined }>
): Array<Record<string, unknown>> {
  if (!configurations || configurations.length === 0) return [];
  const byTopic = new Map<string, Set<string>>();
  for (const c of configurations) {
    if (!c.TopicARN) continue;
    let set = byTopic.get(c.TopicARN);
    if (!set) {
      set = new Set();
      byTopic.set(c.TopicARN, set);
    }
    if (c.NotificationType) set.add(c.NotificationType);
  }
  const result: Array<Record<string, unknown>> = [];
  for (const topic of Array.from(byTopic.keys()).sort()) {
    const types = Array.from(byTopic.get(topic) ?? []).sort();
    result.push({ TopicARN: topic, NotificationTypes: types });
  }
  return result;
}
