import {
  type ClusterState,
  type CloudWatchLogConfiguration,
  type MonitoringConfiguration,
} from '@aws-sdk/client-emr';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import type { ProtectionGuardSite } from '../deletion-protection-compensation.js';
import { onlySecretReferencesDiffer } from '../../secret-reference-immutable.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Default polling budget for EMR cluster lifecycle transitions. A cluster
 * create (RunJobFlow → WAITING/RUNNING) typically takes 5-15 minutes
 * (instance provisioning + bootstrap + application install), and a delete
 * (TerminateJobFlows → TERMINATED) 5-10 minutes. Mirror the Custom Resource /
 * FSx providers' 1-hour ceiling so the slowest realistic create/terminate
 * still fits inside the per-resource deadline.
 */
export const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Cluster states that mean "create succeeded, the cluster is up". */
export const CREATE_READY_STATES: ReadonlySet<ClusterState> = new Set<ClusterState>([
  'WAITING',
  'RUNNING',
]);

/**
 * Cluster states that mean "the cluster is gone" (for delete polling and
 * delete idempotency). `TERMINATED_WITH_ERRORS` still counts as gone — the
 * cluster no longer bills — but is logged so a failed terminate is visible.
 */
export const TERMINAL_STATES: ReadonlySet<ClusterState> = new Set<ClusterState>([
  'TERMINATED',
  'TERMINATED_WITH_ERRORS',
]);

/**
 * Top-level CFn properties that map to a MUTABLE EMR API surface. Every other
 * property is either registry-createOnly (routed through DELETE+CREATE by the
 * replacement-detection layer) or lives inside the `Instances` block (handled
 * specially in `update()` — the members CloudFormation updates in place are
 * applied there, go-to-k/cdkd#5422).
 */
export const MUTABLE_TOP_LEVEL_PROPS = new Set<string>([
  'Tags',
  'VisibleToAllUsers',
  'StepConcurrencyLevel',
  'ManagedScalingPolicy',
  'AutoTerminationPolicy',
]);

/**
 * Mutable properties whose REMOVAL from the template cdkd leaves in place
 * (issue #1160). `ModifyCluster` keeps a `StepConcurrencyLevel` it is not
 * sent, and cdkd sends no reset, because CloudFormation keeps it too despite
 * its documented default of 1 (CFn A/B us-east-1 2026-10-20: a removal from 5,
 * alone and beside a Tags change, left the live value 5, and no update
 * failed). `update()` names the removal in its own warning rather than the
 * shared caller's, whose line claims a CloudFormation reset.
 */
export const LEFT_IN_PLACE_ON_REMOVAL = ['StepConcurrencyLevel'] as const;

/**
 * The ONE warning line for {@link LEFT_IN_PLACE_ON_REMOVAL} removals. Names
 * are template-borne, so they go through `safeMsg`. The deploy line says
 * CloudFormation keeps the value too (the CFn A/B above). A rollback revert
 * restores an earlier state record, so there the property is one the failed
 * deploy ADDED, and the line says that instead.
 */
export const leftInPlaceWarning = (
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback'
): string => {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  const verb = one ? 'is' : 'are';
  return caller === 'rollback'
    ? safeMsg`${logicalId} (AWS::EMR::Cluster): ${subject} ${names.join(', ')} ${verb} absent from the state being restored; ModifyCluster keeps a setting it is not sent, so the rollback leaves the value the failed deploy applied in place.`
    : safeMsg`${logicalId} (AWS::EMR::Cluster): ${subject} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template and ${one ? 'keeps its' : 'keep their'} current AWS value, as CloudFormation leaves ${one ? 'it' : 'them'}; ModifyCluster keeps a setting it is not sent. Declare the intended value explicitly to change it.`;
};

export const toNumber = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  // A non-numeric template value (e.g. an unresolved intrinsic that slipped
  // through) coerces to NaN; forwarding NaN to the SDK is worse than dropping
  // the field, so treat it as absent.
  return Number.isNaN(n) ? undefined : n;
};

export const toBoolean = (v: unknown): boolean | undefined => {
  if (v === undefined) return undefined;
  // Case-insensitive, as `coerceCfnBoolean` reads a CFn boolean: a `"True"`
  // must not silently become false (go-to-k/cdkd#5824).
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return Boolean(v);
};

/**
 * CFn `MonitoringConfiguration` -> the SDK shape (go-to-k/cdkd#5824). The CFn
 * schema declares one member, `CloudWatchLogConfiguration`, whose five members
 * (`Enabled`, `LogGroupName`, `LogStreamNamePrefix`, `EncryptionKeyArn`,
 * `LogTypes` — a map of log type to a list of file names) carry the SDK's
 * spelling and shape, so each is copied by name; the SDK v3 serializer DROPS a
 * member it does not model. `Enabled` is coerced as CloudFormation coerces a
 * scalar (`"true"`). A non-object container is passed through for AWS to
 * reject, as the sibling blobs are.
 *
 * A key outside the schema's members, at either level, would be dropped by
 * the copy (and by the serializer), while CloudFormation rejects the
 * template: each is handed to `onUnknown` with its path, which refuses on a
 * template create and warns on a state replay (`create()`).
 */
export const MONITORING_CONFIGURATION_MEMBERS: ReadonlySet<string> = new Set([
  'CloudWatchLogConfiguration',
]);
export const CLOUDWATCH_LOG_CONFIGURATION_MEMBERS: ReadonlySet<string> = new Set([
  'Enabled',
  'LogGroupName',
  'LogStreamNamePrefix',
  'EncryptionKeyArn',
  'LogTypes',
]);

export const toSdkMonitoringConfiguration = (
  value: unknown,
  onUnknown: (path: string) => void
): MonitoringConfiguration | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return value as MonitoringConfiguration;
  for (const key of Object.keys(value)) {
    if (!MONITORING_CONFIGURATION_MEMBERS.has(key)) onUnknown(`MonitoringConfiguration.${key}`);
  }
  const cw = value['CloudWatchLogConfiguration'];
  if (cw === undefined || cw === null) return {};
  if (!isPlainObject(cw)) {
    return { CloudWatchLogConfiguration: cw as CloudWatchLogConfiguration };
  }
  for (const key of Object.keys(cw)) {
    if (!CLOUDWATCH_LOG_CONFIGURATION_MEMBERS.has(key)) {
      onUnknown(`MonitoringConfiguration.CloudWatchLogConfiguration.${key}`);
    }
  }
  return {
    CloudWatchLogConfiguration: {
      Enabled: toBoolean(cw['Enabled']),
      LogGroupName: cw['LogGroupName'] as string | undefined,
      LogStreamNamePrefix: cw['LogStreamNamePrefix'] as string | undefined,
      EncryptionKeyArn: cw['EncryptionKeyArn'] as string | undefined,
      LogTypes: cw['LogTypes'] as Record<string, string[]> | undefined,
    },
  };
};

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `next` with every position the record holds as a `{{resolve:...}}`
 * reference, and `next` holds as that reference's resolved value, put back to
 * the recorded reference (go-to-k/cdkd#5422). Anything else is `next`'s own.
 */
export function withRecordedReferences(
  next: unknown,
  prev: unknown,
  mask: MaskerFn | undefined
): unknown {
  if (typeof prev === 'string' && typeof next === 'string') {
    return next !== prev && onlySecretReferencesDiffer(next, prev, mask) ? prev : next;
  }
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length) {
    return next.map((item, i) => withRecordedReferences(item, prev[i], mask));
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    return Object.fromEntries(
      Object.entries(next).map(([key, value]) => [
        key,
        withRecordedReferences(value, prev[key], mask),
      ])
    );
  }
  return next;
}

/** One CORE or TASK instance group or fleet whose in-place members moved. */
export interface InstancesResize {
  readonly type: 'CORE' | 'TASK';
  /** Its `Instances` path, for messages (`TaskInstanceGroups[1]`). */
  readonly path: string;
  readonly prev: Record<string, unknown>;
  readonly next: Record<string, unknown>;
}

/**
 * The `Instances` members CloudFormation updates in place that moved
 * (go-to-k/cdkd#5418 measured which they are; `emrClusterInstancesReplaced`
 * strips exactly these). Read off the RAW sides.
 */
export interface InstancesInPlacePlan {
  readonly terminationProtected: boolean;
  readonly unhealthyNodeReplacement: boolean;
  readonly groups: readonly InstancesResize[];
  readonly fleets: readonly InstancesResize[];
}

/** Each planned resize with the id of the group or fleet it addresses. */
export interface InstancesTargets {
  readonly groups: readonly { resize: InstancesResize; id: string }[];
  readonly fleets: readonly { resize: InstancesResize; id: string }[];
}

export const NO_INSTANCES_TARGETS: InstancesTargets = { groups: [], fleets: [] };

/** Group / fleet states that end it: never a resize target. */
export const ENDED_GROUP_STATES: ReadonlySet<string> = new Set([
  'TERMINATING',
  'TERMINATED',
  'SHUTTING_DOWN',
  'ENDED',
]);
export const ENDED_FLEET_STATES: ReadonlySet<string> = new Set(['TERMINATING', 'TERMINATED']);

/** Reads a recorded value as written: a `{{resolve:...}}` reference stays one. */
export const IDENTITY_MASK: MaskerFn = maskerOrIdentity(undefined);

export const EMPTY_INSTANCES_PLAN: InstancesInPlacePlan = {
  terminationProtected: false,
  unhealthyNodeReplacement: false,
  groups: [],
  fleets: [],
};

/** A group's members `ModifyInstanceGroups` / `PutAutoScalingPolicy` apply. */
export const GROUP_IN_PLACE_MEMBERS = ['InstanceCount', 'AutoScalingPolicy'] as const;
/** A fleet's members `ModifyInstanceFleet` applies. */
export const FLEET_IN_PLACE_MEMBERS = ['TargetOnDemandCapacity', 'TargetSpotCapacity'] as const;

/**
 * Plan the in-place `Instances` changes. Only called once the diff's
 * predicate found no replacing member, so the groups and fleets on both sides
 * are the same ones, in the same order, and only these members moved.
 */
export function planInstancesInPlace(
  prev: Record<string, unknown>,
  next: Record<string, unknown>
): InstancesInPlacePlan {
  const moved = (a: unknown, b: unknown, keys: readonly string[]): boolean =>
    keys.some(
      (key) =>
        !jsonEqual(isPlainObject(a) ? a[key] : undefined, isPlainObject(b) ? b[key] : undefined)
    );
  const asBag = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});
  const entries = (single: string, list: string, keys: readonly string[]): InstancesResize[] => {
    const out: InstancesResize[] = [];
    if (next[single] !== undefined && moved(prev[single], next[single], keys)) {
      out.push({
        type: 'CORE',
        path: single,
        prev: asBag(prev[single]),
        next: asBag(next[single]),
      });
    }
    const prevList = Array.isArray(prev[list]) ? (prev[list] as unknown[]) : [];
    const nextList = Array.isArray(next[list]) ? (next[list] as unknown[]) : [];
    nextList.forEach((entry, i) => {
      if (moved(prevList[i], entry, keys)) {
        out.push({
          type: 'TASK',
          path: list + '[' + String(i) + ']',
          prev: asBag(prevList[i]),
          next: asBag(entry),
        });
      }
    });
    return out;
  };
  return {
    terminationProtected: !jsonEqual(prev['TerminationProtected'], next['TerminationProtected']),
    unhealthyNodeReplacement: !jsonEqual(
      prev['UnhealthyNodeReplacement'],
      next['UnhealthyNodeReplacement']
    ),
    groups: entries('CoreInstanceGroup', 'TaskInstanceGroups', GROUP_IN_PLACE_MEMBERS),
    fleets: entries('CoreInstanceFleet', 'TaskInstanceFleets', FLEET_IN_PLACE_MEMBERS),
  };
}

/** Cluster states an orphan lookup reports: every state that still bills. */
export const LIVE_CLUSTER_STATES: ClusterState[] = [
  'STARTING',
  'BOOTSTRAPPING',
  'RUNNING',
  'WAITING',
];

/**
 * go-to-k/cdkd#4606: the cluster id form `RunJobFlow` mints (`j-` and upper-case
 * alphanumerics). Any other spelling is not compared as an identity.
 */
export const CLUSTER_ID_PATTERN = /^j-[0-9A-Z]+$/;

/**
 * Retry-safety state for `RunJobFlow`, which mints the cluster id and carries
 * no idempotency token (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `orphan-report.ts`. Module-scoped: a provider instance is per
 * registry, and one process can build several.
 */
export const runJobFlowLatch = new AmbiguousCreateLatch('emr:RunJobFlow');
/** Clusters this process created and recorded, never reported as orphan candidates. */
export const clustersCreatedByThisProcess = new RecentIdSet();

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetEMRClusterCreateRetryStateForTests(): void {
  runJobFlowLatch.resetForTests();
  clustersCreatedByThisProcess.resetForTests();
}

/**
 * The {@link ProtectionGuardSite} for an `AWS::EMR::Cluster`, whose guard is
 * `TerminationProtected` (issue #2204).
 *
 * EMR has no dedicated not-found error. `isNotFound` judges the error of the
 * RE-ENABLE (`SetTerminationProtection`), and which error that JobFlow-era API
 * returns for an unknown cluster id is NOT measured: its SDK model declares
 * only `InternalServerError`. It is keyed on `InvalidRequestException`, the
 * answer `DescribeCluster` gives for an unknown id (the pre-check in
 * `deleteOnce` relies on that), which also covers other invalid requests, so
 * the not-found wording claims nothing about what the answer means. Any other
 * error takes the ERROR arm, the loud direction, which still names the restore
 * command.
 */
export function emrClusterProtectionSite(
  physicalId: string,
  region: string | undefined
): ProtectionGuardSite {
  return {
    subject: 'EMR Cluster',
    guardName: 'TerminationProtected',
    noun: 'cluster',
    isNotFound: (error) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'InvalidRequestException',
    notFoundMeaning:
      'EMR answered InvalidRequestException. That can mean the cluster is gone, that it is not ' +
      'in this region or account, or that EMR refused the request for another reason.',
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = region ? aws` --region ${region}` : aws``;
      const restore = aws`aws emr modify-cluster-attributes --cluster-id ${physicalId}${regionArg} --termination-protected`;
      return {
        check: aws`aws emr describe-cluster --cluster-id ${physicalId}${regionArg}`.render(),
        restoreAfterNotFound: restore.render(),
        restoreLive: restore.render(),
      };
    },
  };
}
