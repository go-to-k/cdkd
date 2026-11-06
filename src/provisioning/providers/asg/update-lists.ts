import type { ASGProvider } from '../asg-provider.js';
import {
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
} from '@aws-sdk/client-auto-scaling';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { SecretMasker } from '../../../types/resource.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  type AttachmentKind,
  type ListKind,
  LIST_KINDS,
  type ListRead,
  isAttachmentKind,
  secretDerivedCause,
  listWhat,
  readLists,
  malformedKinds,
  removableRecorded,
  itemsOf,
  holdsAllKnownMetrics,
  type FoldedMetrics,
  foldMetricsCollection,
} from './shared.js';

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
export async function readUpdateLists(
  this: ASGProvider,
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
export function recordedListRepair(
  this: ASGProvider,
  kinds: ListKind[],
  read: Record<ListKind, ListRead>
): string {
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
export async function applyTagsDiff(
  this: ASGProvider,
  physicalId: string,
  next: unknown[],
  prev: unknown[]
): Promise<void> {
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
export async function applyLoadBalancerNamesDiff(
  this: ASGProvider,
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
export async function applyTargetGroupArnsDiff(
  this: ASGProvider,
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
export async function applyMetricsCollectionDiff(
  this: ASGProvider,
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
    const asAll = metrics === undefined || (disables.length === 0 && holdsAllKnownMetrics(metrics));
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

export async function applyLifecycleHooksDiff(
  this: ASGProvider,
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

export async function applyTrafficSourcesDiff(
  this: ASGProvider,
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

export async function applyNotificationConfigurationsDiff(
  this: ASGProvider,
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
