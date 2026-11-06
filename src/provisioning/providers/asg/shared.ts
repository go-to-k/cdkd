import { ec2InstanceProtectionSite } from '../../ec2-termination-protection.js';
import { pasteableAwsCommand, WITHHELD_AWS_COMMAND } from '../../replacement-protection-advice.js';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import type { ProtectionGuardSite } from '../deletion-protection-compensation.js';

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
export type AttachmentKind = 'LoadBalancerNames' | 'TargetGroupARNs';

/** The entry lists: each entry is an object keyed by one identity member. */
export type EntryKind =
  | 'Tags'
  | 'MetricsCollection'
  | 'LifecycleHookSpecificationList'
  | 'TrafficSources'
  | 'NotificationConfigurations';

export type ListKind = AttachmentKind | EntryKind;

/**
 * API length caps (`XmlStringMaxLen255` / `XmlStringMaxLen511`). A classic load
 * balancer name or a target-group ARN never holds whitespace.
 */
export const ATTACHMENT_MAX_LENGTH: Record<AttachmentKind, number> = {
  LoadBalancerNames: 255,
  TargetGroupARNs: 511,
};

export const ATTACHMENT_WHAT: Record<AttachmentKind, string> = {
  LoadBalancerNames: 'load balancer names',
  TargetGroupARNs: 'target group ARNs',
};

/** The member each diff helper keys an entry by, and any string-list member it forwards. */
export const ENTRY_SHAPE: Record<
  EntryKind,
  { identity: string; stringList?: string; what: string }
> = {
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

export const LIST_KINDS: readonly ListKind[] = [
  'Tags',
  'LoadBalancerNames',
  'TargetGroupARNs',
  'MetricsCollection',
  'LifecycleHookSpecificationList',
  'TrafficSources',
  'NotificationConfigurations',
];

export type ListRead =
  | { kind: 'list'; items: unknown[] }
  // `onlySecret`: the list is well-shaped, and refused ONLY because a member
  // holds a dynamic reference or its mask.
  | { kind: 'malformed'; secretDerived: boolean; onlySecret: boolean };

export function isAttachmentKind(kind: ListKind): kind is AttachmentKind {
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
export type ListSide = 'desired' | 'recorded';

export function isWellFormedEntry(
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
export function readList(kind: ListKind, value: unknown, side: ListSide): ListRead {
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
export function secretDerivedCause(kinds: ListKind[], read: Record<ListKind, ListRead>): string {
  const secret = kinds.filter((k) => {
    const r = read[k];
    return r.kind === 'malformed' && r.onlySecret;
  });
  return secret.length === 0
    ? ''
    : ` (${secret.join(' / ')} holds a dynamic reference or its mask where a name belongs, ` +
        `which names nothing Auto Scaling accepts)`;
}

export function listWhat(kind: ListKind): string {
  return isAttachmentKind(kind) ? ATTACHMENT_WHAT[kind] : ENTRY_SHAPE[kind].what;
}

/**
 * Every list property of one bag, keyed by kind. The caller passes its own
 * literal read of each property (`{ Tags: properties['Tags'], ... }`) so the
 * call site shows (and a grep finds) which property feeds the calls.
 */
export function readLists(
  values: Record<ListKind, unknown>,
  side: ListSide
): Record<ListKind, ListRead> {
  const out = {} as Record<ListKind, ListRead>;
  for (const kind of LIST_KINDS) out[kind] = readList(kind, values[kind], side);
  return out;
}

export function malformedKinds(read: Record<ListKind, ListRead>): ListKind[] {
  return LIST_KINDS.filter((k) => read[k].kind === 'malformed');
}

/**
 * A recorded entry list minus every entry whose identity is secret-derived: the
 * diff helpers would otherwise Delete / Detach a literal `{{resolve:...}}` key.
 * Dropping it only misses that one removal, the safe direction; the desired
 * side's plaintext identity is still upserted.
 */
export function removableRecorded(kind: ListKind, items: unknown[]): unknown[] {
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

export function itemsOf(read: ListRead): unknown[] {
  return read.kind === 'list' ? read.items : [];
}

export type ZoneMembers = { AvailabilityZones?: string[]; AvailabilityZoneIds?: string[] };

/** A subnet list the group launches into: a non-empty list or comma-joined string. */
export function declaresSubnets(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value !== '';
}

/**
 * The zone members a create or update sends (go-to-k/cdkd#2762).
 *
 * AWS refuses `AvailabilityZones` and `AvailabilityZoneIds` in one request, and
 * `readCurrentState` reports BOTH (AWS answers both whichever member created
 * the group). So a bag built from a readback (`drift --revert`) or a state
 * record (a rollback replay, where an imported record can hold the readback)
 * that carries both sends at most one:
 *   - none when it also carries subnets: the zones follow `VPCZoneIdentifier`,
 *     and subnets beside zone ids are an unmeasured combination there;
 *   - else on update the one that changed against the previous side, the zone
 *     ids first, and neither when neither changed; on create (`previous`
 *     absent) the zone ids, or the names when the id list is empty.
 * An empty zone-id list (an unreported member) is never sent from such a bag.
 * A template bag is passed through as declared: AWS refuses a template
 * declaring both, as it refuses CloudFormation's request.
 */
export function zoneMembers(
  properties: Record<string, unknown>,
  stateBorne: boolean,
  previousProperties?: Record<string, unknown>
): ZoneMembers {
  const names = properties['AvailabilityZones'] as string[] | undefined;
  const ids = properties['AvailabilityZoneIds'] as string[] | undefined;
  if (!stateBorne || names === undefined || ids === undefined) {
    return {
      ...(names !== undefined && { AvailabilityZones: names }),
      ...(ids !== undefined && { AvailabilityZoneIds: ids }),
    };
  }
  if (declaresSubnets(properties['VPCZoneIdentifier'])) return {};
  const changed = (key: string): boolean =>
    previousProperties === undefined ||
    JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key]);
  if (Array.isArray(ids) && ids.length > 0 && changed('AvailabilityZoneIds')) {
    return { AvailabilityZoneIds: ids };
  }
  if (changed('AvailabilityZones')) return { AvailabilityZones: names };
  return {};
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
 * DefaultInstanceWarmup / AvailabilityZones / AvailabilityZoneIds /
 * AvailabilityZoneDistribution / AvailabilityZoneImpairmentPolicy /
 * SkipZonalShiftValidation / CapacityReservationSpecification /
 * InstanceMaintenancePolicy / DeletionProtection / MixedInstancesPolicy /
 * LaunchTemplate / PlacementGroup / InstanceLifecyclePolicy.
 *
 * `UpdateAutoScalingGroup` has merge semantics (absent input field = "no
 * change"). Per the real CloudFormation A/B in go-to-k/cdkd#5004, a property
 * REMOVED from the template is reset by CloudFormation for only four members
 * (InstanceMaintenancePolicy, MaxInstanceLifetime,
 * CapacityReservationSpecification, AvailabilityZoneDistribution), plus
 * AvailabilityZoneImpairmentPolicy per the #1160 A/B and PlacementGroup per
 * the #2762 A/B — those get a removal reset here, declared in
 * `removalDefaults` or a local `clearOnUpdateRemoval`. Every other optional
 * member (HealthCheckType, HealthCheckGracePeriod, Cooldown,
 * TerminationPolicies, NewInstancesProtectedFromScaleIn, CapacityRebalance,
 * DesiredCapacityType, DefaultInstanceWarmup, DeletionProtection,
 * InstanceLifecyclePolicy) is KEPT at its live value by CloudFormation, so a
 * removal sends nothing for it (issues #1160, #5004, #2762).
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
export function isFoldableMetricsEntry(entry: unknown): boolean {
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
export function holdsAllKnownMetrics(metrics: readonly string[]): boolean {
  return ALL_GROUP_METRICS.every((m) => metrics.includes(m));
}

/** One granularity of a folded `MetricsCollection`; `Metrics` absent = ALL. */
export type FoldedMetrics = { Granularity: string; Metrics?: string[] };

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

/**
 * The re-enable of a group-launched instance failed and a readback found the
 * instance `shutting-down` or `terminated`. Raised by the ASG instance site's
 * `reEnable` so the compensation takes its "gone" arm (a WARN with the check
 * command) instead of the ERROR that claims the instance is LIVE.
 */
export class LaunchedInstanceGoneError extends Error {
  override readonly name = 'LaunchedInstanceGone';
  constructor(instanceId: string, state: string) {
    super(`instance ${instanceId} is ${state}`);
  }
}

/** EC2 instance states from which an instance never comes back. */
export const GONE_INSTANCE_STATES: ReadonlySet<string> = new Set(['shutting-down', 'terminated']);

/**
 * The {@link ProtectionGuardSite} for an EC2 instance an Auto Scaling group
 * launched, whose `DisableApiTermination` the group's `--remove-protection`
 * delete turned off (issue #796) before that delete failed terminally (issue
 * #2204). The EC2 instance site's commands, led by a subject naming the group:
 * the logical id on each line is the GROUP's, since the instance has none of
 * its own in the template.
 *
 * Its "gone" arm is wider than the EC2 site's. The group's flip is what lets it
 * terminate an instance (a scale-in, a health replacement) between the flip and
 * the terminal attempt, and a write to a terminated-but-describable instance
 * fails with an error other than `InvalidInstanceID.NotFound`. So the site's
 * `reEnable` reads the instance's state back after a failed write and raises
 * {@link LaunchedInstanceGoneError} for a dead one, keyed on the documented
 * state name rather than on an error code.
 */
export function autoScalingGroupInstanceProtectionSite(
  instanceId: string,
  region: string | undefined
): ProtectionGuardSite {
  const ec2Site = ec2InstanceProtectionSite(instanceId, region);
  return {
    ...ec2Site,
    subject: 'EC2 Instance launched by AutoScalingGroup',
    isNotFound: (error) =>
      ec2Site.isNotFound(error) ||
      (typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'LaunchedInstanceGone'),
    notFoundMeaning:
      'EC2 answered that the instance was not found, or reports it shutting-down or terminated ' +
      '(the group may have replaced it). That most commonly means the instance is gone, and a ' +
      'not-found answer can also mean it is not in this region or account.',
  };
}

/** The registry key type for a group-launched instance's flip record. */
export const EC2_INSTANCE_TYPE = 'AWS::EC2::Instance';

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
export function mapEnabledMetricsToCfn(
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
export function mapLifecycleHooksToCfn(
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
export function mapTrafficSourcesToCfn(
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
export function mapNotificationsToCfn(
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
