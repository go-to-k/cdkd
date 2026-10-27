import {
  EMRClient,
  RunJobFlowCommand,
  ListClustersCommand,
  TerminateJobFlowsCommand,
  DescribeClusterCommand,
  ListInstanceGroupsCommand,
  ListInstanceFleetsCommand,
  SetTerminationProtectionCommand,
  SetVisibleToAllUsersCommand,
  ModifyClusterCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  PutManagedScalingPolicyCommand,
  RemoveManagedScalingPolicyCommand,
  PutAutoTerminationPolicyCommand,
  RemoveAutoTerminationPolicyCommand,
  SetUnhealthyNodeReplacementCommand,
  InvalidRequestException,
  type Cluster,
  type ClusterState,
  type JobFlowInstancesConfig,
  type InstanceGroup,
  type InstanceFleet,
  type InstanceGroupConfig,
  type InstanceFleetConfig,
  type InstanceRoleType,
  type InstanceFleetType,
  type ManagedScalingPolicy,
  type AutoTerminationPolicy,
  type Tag,
  type RunJobFlowCommandOutput,
} from '@aws-sdk/client-emr';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure, describeAwsStatusReason } from '../../utils/aws-failure-text.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
} from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  pasteableAwsCommand,
  protectedReplacementAdvice,
} from '../replacement-protection-advice.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  type ProtectionFlipRecord,
  type ProtectionGuardSite,
} from './deletion-protection-compensation.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import {
  toSdkConfigurations,
  toSdkInstanceTypeConfigs,
  toSdkStepConfigs,
} from '../emr-configuration.js';
import {
  onlySecretReferencesDiffer,
  unchangedBehindSecretReference,
} from '../secret-reference-immutable.js';
import { emrClusterInstancesReplaced } from '../../analyzer/replacement-rules.js';
import { EMRInstanceGroupConfigProvider } from './emr-instance-group-config-provider.js';
import { EMRInstanceFleetConfigProvider } from './emr-instance-fleet-config-provider.js';
import { createMaskedLogSinks, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from './orphan-report.js';
import {
  AmbiguousCreateLatch,
  RecentIdSet,
  isInsideWindow,
  replayedSendWindow,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { commandHole } from '../../utils/pasteable-command.js';
import { safeMsg } from '../../utils/display-safe.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';

/**
 * Default polling budget for EMR cluster lifecycle transitions. A cluster
 * create (RunJobFlow → WAITING/RUNNING) typically takes 5-15 minutes
 * (instance provisioning + bootstrap + application install), and a delete
 * (TerminateJobFlows → TERMINATED) 5-10 minutes. Mirror the Custom Resource /
 * FSx providers' 1-hour ceiling so the slowest realistic create/terminate
 * still fits inside the per-resource deadline.
 */
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Cluster states that mean "create succeeded, the cluster is up". */
const CREATE_READY_STATES: ReadonlySet<ClusterState> = new Set<ClusterState>([
  'WAITING',
  'RUNNING',
]);

/**
 * Cluster states that mean "the cluster is gone" (for delete polling and
 * delete idempotency). `TERMINATED_WITH_ERRORS` still counts as gone — the
 * cluster no longer bills — but is logged so a failed terminate is visible.
 */
const TERMINAL_STATES: ReadonlySet<ClusterState> = new Set<ClusterState>([
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
const MUTABLE_TOP_LEVEL_PROPS = new Set<string>([
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
const LEFT_IN_PLACE_ON_REMOVAL = ['StepConcurrencyLevel'] as const;

/**
 * The ONE warning line for {@link LEFT_IN_PLACE_ON_REMOVAL} removals. Names
 * are template-borne, so they go through `safeMsg`. The deploy line says
 * CloudFormation keeps the value too (the CFn A/B above). A rollback revert
 * restores an earlier state record, so there the property is one the failed
 * deploy ADDED, and the line says that instead.
 */
const leftInPlaceWarning = (
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

const toNumber = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  // A non-numeric template value (e.g. an unresolved intrinsic that slipped
  // through) coerces to NaN; forwarding NaN to the SDK is worse than dropping
  // the field, so treat it as absent.
  return Number.isNaN(n) ? undefined : n;
};

const toBoolean = (v: unknown): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v === 'true';
  return Boolean(v);
};

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `next` with every position the record holds as a `{{resolve:...}}`
 * reference, and `next` holds as that reference's resolved value, put back to
 * the recorded reference (go-to-k/cdkd#5422). Anything else is `next`'s own.
 */
function withRecordedReferences(next: unknown, prev: unknown, mask: MaskerFn | undefined): unknown {
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
interface InstancesResize {
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
interface InstancesInPlacePlan {
  readonly terminationProtected: boolean;
  readonly unhealthyNodeReplacement: boolean;
  readonly groups: readonly InstancesResize[];
  readonly fleets: readonly InstancesResize[];
}

const EMPTY_INSTANCES_PLAN: InstancesInPlacePlan = {
  terminationProtected: false,
  unhealthyNodeReplacement: false,
  groups: [],
  fleets: [],
};

/** A group's members `ModifyInstanceGroups` / `PutAutoScalingPolicy` apply. */
const GROUP_IN_PLACE_MEMBERS = ['InstanceCount', 'AutoScalingPolicy'] as const;
/** A fleet's members `ModifyInstanceFleet` applies. */
const FLEET_IN_PLACE_MEMBERS = ['TargetOnDemandCapacity', 'TargetSpotCapacity'] as const;

/**
 * Plan the in-place `Instances` changes. Only called once the diff's
 * predicate found no replacing member, so the groups and fleets on both sides
 * are the same ones, in the same order, and only these members moved.
 */
function planInstancesInPlace(
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
const LIVE_CLUSTER_STATES: ClusterState[] = ['STARTING', 'BOOTSTRAPPING', 'RUNNING', 'WAITING'];

/**
 * go-to-k/cdkd#4606: the cluster id form `RunJobFlow` mints (`j-` and upper-case
 * alphanumerics). Any other spelling is not compared as an identity.
 */
const CLUSTER_ID_PATTERN = /^j-[0-9A-Z]+$/;

/**
 * Retry-safety state for `RunJobFlow`, which mints the cluster id and carries
 * no idempotency token (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `orphan-report.ts`. Module-scoped: a provider instance is per
 * registry, and one process can build several.
 */
const runJobFlowLatch = new AmbiguousCreateLatch('emr:RunJobFlow');
/** Clusters this process created and recorded, never reported as orphan candidates. */
const clustersCreatedByThisProcess = new RecentIdSet();

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

/**
 * SDK Provider for `AWS::EMR::Cluster` (EMR on EC2).
 *
 * The type is `ProvisioningType: NON_PROVISIONABLE` in the CFn registry, so
 * cdkd's Cloud Control fallback cannot handle it (issue #1043) — pre-flight
 * would otherwise reject it via `unsupported-types.generated.ts`.
 *
 * Lifecycle — a cluster is a stateful, per-instance-hour-billed resource, so
 * every path is polled to completion:
 *  - `create` → `RunJobFlow` + poll `DescribeCluster` until `WAITING`/`RUNNING`
 *    (the cluster is up and idle / running steps). A `TERMINATED*` terminal
 *    during create is a hard error; the partially-created cluster is
 *    best-effort terminated so it does not bill.
 *  - `update` → the limited mutable surface only: `SetTerminationProtection`
 *    (`Instances.TerminationProtected`), `SetVisibleToAllUsers`,
 *    `ModifyCluster` (`StepConcurrencyLevel`; a removal is warned about and
 *    left in place, issue #1160), managed-scaling / auto-
 *    termination policy APIs, and `AddTags`/`RemoveTags`. Applications,
 *    release label, ... are schema-createOnly and most `Instances` changes
 *    are a registry-rule replacement (issue #5418), so a change that reaches
 *    `update()` anyway is refused with a `--replace` pointer. The `Instances`
 *    members CloudFormation updates in place are applied (go-to-k/cdkd#5422):
 *    `SetUnhealthyNodeReplacement`, and a core / task group's or fleet's
 *    resize and auto-scaling policy through the instance group / fleet
 *    providers' own `update()`, which wait for the resize to settle.
 *  - `delete` → `TerminateJobFlows` + poll until `TERMINATED`. Idempotent on
 *    an already-gone cluster (`assertRegionMatch` guards the region). Honors
 *    termination protection: under `--remove-protection` it flips
 *    `SetTerminationProtection(false)` first (mirroring the EC2/ASG pattern),
 *    and turns it back on if the terminate then fails terminally (#2204).
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource deadline
 * to the polling ceiling (mirrors `CustomResourceProvider` / `FSxFileSystem
 * Provider`), so slow EMR creates/terminates don't require `--resource-timeout`.
 */
export class EMRClusterProvider implements ResourceProvider {
  /**
   * Cloud Control has NO handlers for this type (`ProvisioningType:
   * NON_PROVISIONABLE`), so the deploy engine's #614 silent-drop auto-route
   * MUST NOT send an unhandled-property EMR template to CC — it would fail at
   * provisioning time with an opaque UnsupportedActionException. With this
   * opt-out the ProviderRegistry rejects such templates pre-flight with a
   * clear error instead.
   */
  readonly disableCcApiFallback = true;

  private client: EMRClient | undefined;
  private createClient: EMRClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('EMRClusterProvider');
  /** `--remove-protection` flips, keyed so a re-entered delete keeps them (#2204). */
  private readonly protectionFlips = new ProtectionFlipRegistry();

  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  /**
   * The failure wrap every create / update / delete catch builds.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through the
   * operation's `maskSecrets` (`mask`), and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on the
   * `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}). A cdkd-authored or transport error, or a
   * non-`Error` throw, keeps its text; the deploy engine masks a thrown
   * message. The delete checks `InvalidRequestException` by type before it
   * wraps, so no "already gone" reading depends on AWS's wording.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  /**
   * The error a FAILED / terminal state read off a successful Describe throws
   * (go-to-k/cdkd#2319). AWS's reason (`Status.StateChangeReason`) reaches the
   * same persisted sink as a caught failure, and a validation reason names IAM
   * role ARNs, so the message carries the reason's code (if any) plus the
   * `--verbose` pointer ({@link describeAwsStatusReason}). The reason goes to
   * `debug` through the operation's masker, and becomes the `cause` the wrap
   * is stamped `markRedactedCause` over, so the retry classifiers still read it
   * as they read the message before. No reason keeps cdkd's fallback text.
   *
   * `build` runs twice, so it must stay a side-effect-free constructor call
   * threading `cause`.
   */
  private wrapStatusReasonError(
    mask: MaskerFn | undefined,
    reason: { code?: string | undefined; message?: string | undefined } | undefined,
    fallback: string,
    build: (text: string, cause: Error | undefined) => ProvisioningError
  ): ProvisioningError {
    const text = describeAwsStatusReason(reason, fallback);
    if (!text.redacted) return build(text.detail, undefined);
    const m = maskerOrIdentity(mask);
    const cause = new Error(text.detail);
    this.logger.debug(m(build(m(text.detail), cause).message));
    return markRedactedCause(build(m(text.summary), cause));
  }

  private wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
    const m = maskerOrIdentity(mask);
    this.logger.debug(m(build(m(failure.detail)).message));
    return markRedactedCause(build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`));
  }

  /**
   * The cleanup-failure text a best-effort `warn` quotes after `head`
   * (go-to-k/cdkd#2319). An AWS-authored failure is named by its CLASS at
   * warn, since a denied call names the caller's assumed-role ARN; AWS's own
   * text goes to `debug` under the same `head`, masked. A cdkd-authored or
   * transport error keeps its text, masked.
   */
  private cleanupFailureText(head: string, error: unknown, mask: MaskerFn | undefined): string {
    const m = maskerOrIdentity(mask);
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return m(failure.detail);
    this.logger.debug(m(`${head}${m(failure.detail)}`));
    return m(failure.summary);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EMR::Cluster',
      new Set([
        'AdditionalInfo',
        'Applications',
        'AutoScalingRole',
        'AutoTerminationPolicy',
        'BootstrapActions',
        'Configurations',
        'CustomAmiId',
        'EbsRootVolumeIops',
        'EbsRootVolumeSize',
        'EbsRootVolumeThroughput',
        'Instances',
        'JobFlowRole',
        'KerberosAttributes',
        'LogEncryptionKmsKeyId',
        'LogUri',
        'ManagedScalingPolicy',
        'Name',
        'OSReleaseLabel',
        'PlacementGroupConfigs',
        'ReleaseLabel',
        'ScaleDownBehavior',
        'SecurityConfiguration',
        'ServiceRole',
        'StepConcurrencyLevel',
        'Steps',
        'Tags',
        'VisibleToAllUsers',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled by `update()` — so the shared caller warns about
   * none of them.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EMR::Cluster',
      new Set([
        // Create-only (a removal replaces), or `Instances`: required; a removed
        // sub-field replaces, except the in-place ones update() handles:
        // `TerminationProtected` is sent as false, `AutoScalingPolicy` is
        // removed, a fleet capacity is sent as 0, and `UnhealthyNodeReplacement`
        // is refused (CloudFormation fails that removal).
        ...[...(this.handledProperties.get('AWS::EMR::Cluster') ?? [])].filter(
          (key) => !MUTABLE_TOP_LEVEL_PROPS.has(key)
        ),
        // Diffed by AddTags / RemoveTags.
        'Tags',
        // Sent as false, CloudFormation's documented default for this type.
        'VisibleToAllUsers',
        // Removed through RemoveManagedScalingPolicy / RemoveAutoTerminationPolicy.
        'ManagedScalingPolicy',
        'AutoTerminationPolicy',
        // Left in place, as CloudFormation leaves it (CFn A/B 2026-10-20),
        // and named in update()'s own warning (no reset).
        ...LEFT_IN_PLACE_ON_REMOVAL,
      ]),
    ],
  ]);

  private getClient(): EMRClient {
    if (!this.client) {
      this.client = new EMRClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * The client `RunJobFlow` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #2080). Separate so every other call
   * keeps the full SDK retry.
   */
  private getCreateClient(): EMRClient {
    if (!this.createClient) {
      this.createClient = withoutServerErrorRetries(
        new EMRClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.createClient;
  }

  /**
   * Self-reported minimum per-resource timeout: the deploy engine resolves
   * `max(getMinResourceTimeoutMs(), globalCliDefault)` so EMR's slow
   * create/terminate polling fits inside the resource deadline without the
   * user passing `--resource-timeout`.
   *
   * Return the poll ceiling PLUS one poll interval (not exactly `maxWaitMs`):
   * the deploy engine's `withResourceDeadline` is a non-cancelling
   * `Promise.race`, so if the external deadline were exactly equal to the
   * internal poll ceiling the two could fire together and the external one
   * could win — leaving the internal timeout + best-effort rollback terminate
   * un-run and (if the CLI then exits) a live cluster billing. The extra
   * interval guarantees the internal `waitForCluster*` timeout fires first and
   * the rollback path always runs.
   */
  getMinResourceTimeoutMs(): number {
    return this.maxWaitMs + this.pollIntervalMs;
  }

  // ─── CREATE ────────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    if (resourceType !== 'AWS::EMR::Cluster') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Creating EMR Cluster ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    let clusterId: string | undefined;

    try {
      // Build the RunJobFlow input INSIDE the try so a malformed template value
      // (e.g. a bad Instances shape) surfaces as a wrapped ProvisioningError
      // rather than a raw throw.
      const tags =
        properties['Tags'] !== undefined && properties['Tags'] !== null ? desiredTags : undefined;
      const input = {
        Name: properties['Name'] as string,
        ReleaseLabel: properties['ReleaseLabel'] as string | undefined,
        ServiceRole: properties['ServiceRole'] as string | undefined,
        JobFlowRole: properties['JobFlowRole'] as string | undefined,
        LogUri: properties['LogUri'] as string | undefined,
        LogEncryptionKmsKeyId: properties['LogEncryptionKmsKeyId'] as string | undefined,
        AdditionalInfo: properties['AdditionalInfo'] as string | undefined,
        AutoScalingRole: properties['AutoScalingRole'] as string | undefined,
        ScaleDownBehavior: properties['ScaleDownBehavior'] as
          | import('@aws-sdk/client-emr').ScaleDownBehavior
          | undefined,
        CustomAmiId: properties['CustomAmiId'] as string | undefined,
        OSReleaseLabel: properties['OSReleaseLabel'] as string | undefined,
        SecurityConfiguration: properties['SecurityConfiguration'] as string | undefined,
        EbsRootVolumeSize: toNumber(properties['EbsRootVolumeSize']),
        EbsRootVolumeIops: toNumber(properties['EbsRootVolumeIops']),
        EbsRootVolumeThroughput: toNumber(properties['EbsRootVolumeThroughput']),
        StepConcurrencyLevel: toNumber(properties['StepConcurrencyLevel']),
        VisibleToAllUsers: toBoolean(properties['VisibleToAllUsers']),
        Applications: properties['Applications'] as
          | import('@aws-sdk/client-emr').Application[]
          | undefined,
        Configurations: toSdkConfigurations(properties['Configurations']),
        BootstrapActions: properties['BootstrapActions'] as
          | import('@aws-sdk/client-emr').BootstrapActionConfig[]
          | undefined,
        Steps: toSdkStepConfigs(properties['Steps']),
        KerberosAttributes: properties['KerberosAttributes'] as
          | import('@aws-sdk/client-emr').KerberosAttributes
          | undefined,
        PlacementGroupConfigs: properties['PlacementGroupConfigs'] as
          | import('@aws-sdk/client-emr').PlacementGroupConfig[]
          | undefined,
        ManagedScalingPolicy: this.toManagedScalingPolicy(
          properties['ManagedScalingPolicy'] as Record<string, unknown> | undefined
        ),
        AutoTerminationPolicy: this.toAutoTerminationPolicy(
          properties['AutoTerminationPolicy'] as Record<string, unknown> | undefined
        ),
        Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
        Instances: this.toJobFlowInstancesConfig(
          properties['Instances'] as Record<string, unknown> | undefined
        ),
      };

      // Issue #2080: after an earlier ambiguous attempt, name the cluster it
      // may have launched before a second RunJobFlow is sent. Detection only
      // -- see `orphan-report.ts`. A duplicate cluster bills per
      // instance-hour, so the report carries a terminate command (after
      // confirming); cdkd never terminates a cluster it did not record.
      const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
        const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
        const aws = pasteableAwsCommand(log.mask);
        const regionArg = await orphanCommandRegionArg(this.getClient(), aws);
        const name = input.Name;
        const protectedCluster = input.Instances?.TerminationProtected === true;
        await reportPossibleOrphans(logicalId, lookupWindow, log, {
          action: 'RunJobFlow',
          service: 'EMR',
          listAction: 'ListClusters',
          subject: `a cluster named ${log.value(name)}`,
          noun: 'cluster(s)',
          list: () =>
            collectOrphanIds(
              async (marker) => {
                const page = await this.getClient().send(
                  new ListClustersCommand({
                    CreatedAfter: new Date(lookupWindow.floorMs),
                    CreatedBefore: new Date(lookupWindow.ceilingMs),
                    // A cluster already terminating or gone bills nothing.
                    ClusterStates: LIVE_CLUSTER_STATES,
                    ...(marker && { Marker: marker }),
                  })
                );
                return { items: page.Clusters ?? [], next: page.Marker };
              },
              (c) =>
                c.Id &&
                c.Name === name &&
                isInsideWindow(c.Status?.Timeline?.CreationDateTime, lookupWindow) &&
                !clustersCreatedByThisProcess.has(c.Id)
                  ? c.Id
                  : undefined
            ),
          inspect: (id) => aws`aws emr describe-cluster --cluster-id ${id}${regionArg}`.render(),
          remove: (id) => aws`aws emr terminate-clusters --cluster-ids ${id}${regionArg}`.render(),
          // Conditional, not chained: the candidate may be another deploy's
          // cluster, whose protection this template says nothing about.
          removeVerb: protectedCluster
            ? // A quoted hole (`commandHole`): a bare `<id>` pastes as a redirection.
              `terminate it (this template turns termination protection on, so if describe-cluster shows it on for the candidate, first run ${aws`aws emr modify-cluster-attributes --cluster-id`.render()} ${commandHole('id')} ${aws`--no-termination-protected${regionArg}`.render()} with its id)`
            : 'terminate it',
        });
      };
      const orphanWindow = runJobFlowLatch.take(logicalId);
      if (orphanWindow !== undefined) {
        await reportOrphans(orphanWindow);
      }
      const attemptStartMs = Date.now();
      let response: RunJobFlowCommandOutput;
      try {
        response = await this.getCreateClient().send(new RunJobFlowCommand(input));
      } catch (error) {
        runJobFlowLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
        throw error;
      }
      clusterId = response.JobFlowId;
      if (clusterId) clustersCreatedByThisProcess.add(clusterId);
      // Issue #4687: the SDK replayed this RunJobFlow inside its `send`, so
      // an earlier attempt may have made one too. Detection only.
      const replayWindow = replayedSendWindow(response, attemptStartMs);
      if (replayWindow !== undefined) {
        await reportOrphans(replayWindow);
      }
      if (!clusterId) {
        throw new ProvisioningError(
          `EMR RunJobFlow for ${logicalId} returned no JobFlowId`,
          resourceType,
          logicalId
        );
      }

      const cluster = await this.waitForClusterReady(
        clusterId,
        logicalId,
        resourceType,
        context?.maskSecrets
      );

      this.logger.debug(`Successfully created EMR Cluster ${logicalId}: ${clusterId}`);

      return {
        physicalId: clusterId,
        attributes: this.buildAttributes(cluster),
      };
    } catch (error) {
      // Atomicity: if RunJobFlow succeeded but polling failed (the cluster
      // went TERMINATED_WITH_ERRORS, or the wait timed out), create() is
      // about to throw without returning a physicalId — the deploy engine
      // cannot roll it back, and a live EMR cluster bills per instance-hour.
      // Best-effort terminate it here.
      // go-to-k/cdkd#4583: the id of a cluster RunJobFlow returned that the
      // terminate below could not stop, named for the failed-CREATE journal.
      let survivorId: string | undefined;
      if (clusterId !== undefined) {
        try {
          // If the template requested Instances.TerminationProtected: true the
          // cluster is PROTECTED, and TerminateJobFlows would 400 with a
          // ValidationException — leaving a live billing cluster, the exact
          // outcome this rollback exists to prevent. Flip protection off first
          // (idempotent — EMR accepts it when already false), mirroring the
          // delete path, then terminate.
          await this.getClient().send(
            new SetTerminationProtectionCommand({
              JobFlowIds: [clusterId],
              TerminationProtected: false,
            })
          );
          await this.getClient().send(new TerminateJobFlowsCommand({ JobFlowIds: [clusterId] }));
          this.logger.warn(`Rolled back partially-created EMR Cluster ${clusterId}`);
        } catch (cleanupError) {
          survivorId = clusterId;
          const cleanupHead = `Failed to roll back partially-created EMR Cluster ${clusterId}: `;
          this.logger.warn(
            maskerOrIdentity(context?.maskSecrets)(
              `${cleanupHead}${this.cleanupFailureText(cleanupHead, cleanupError, context?.maskSecrets)} — terminate it manually to stop billing`
            )
          );
        }
      }
      if (error instanceof ProvisioningError) {
        if (survivorId !== undefined) {
          markCreatedBeforeFailure(error, logicalId, resourceType, survivorId);
          // go-to-k/cdkd#4945: terminal. RunJobFlow sends no name and no token, so the
          // engine's retry would make another cluster while the journal names one.
          markNonRetryable(error);
        }
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create EMR Cluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      if (survivorId !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, survivorId);
        markNonRetryable(thrown);
      }
      throw thrown;
    }
  }

  /**
   * Map the CFn `Instances` (`JobFlowInstancesConfig`) block to the SDK
   * `RunJobFlow.Instances` shape. Most field names are identical; the one
   * structural difference is the role-keyed CFn groups/fleets
   * (`MasterInstanceGroup` / `CoreInstanceGroup` / `TaskInstanceGroups` and
   * the `*InstanceFleet(s)` siblings) which the SDK expresses as flat
   * `InstanceGroups` / `InstanceFleets` arrays with an explicit
   * `InstanceRole` / `InstanceFleetType` discriminator per entry.
   */
  private toJobFlowInstancesConfig(
    config: Record<string, unknown> | undefined
  ): JobFlowInstancesConfig | undefined {
    if (!config) return undefined;

    const instanceGroups: InstanceGroupConfig[] = [];
    const pushGroup = (raw: unknown, role: InstanceRoleType): void => {
      if (raw === undefined || raw === null) return;
      instanceGroups.push(this.toInstanceGroupConfig(raw as Record<string, unknown>, role));
    };
    pushGroup(config['MasterInstanceGroup'], 'MASTER');
    pushGroup(config['CoreInstanceGroup'], 'CORE');
    for (const task of (config['TaskInstanceGroups'] as unknown[] | undefined) ?? []) {
      pushGroup(task, 'TASK');
    }

    const instanceFleets: InstanceFleetConfig[] = [];
    const pushFleet = (raw: unknown, type: InstanceFleetType): void => {
      if (raw === undefined || raw === null) return;
      instanceFleets.push(this.toInstanceFleetConfig(raw as Record<string, unknown>, type));
    };
    pushFleet(config['MasterInstanceFleet'], 'MASTER');
    pushFleet(config['CoreInstanceFleet'], 'CORE');
    for (const task of (config['TaskInstanceFleets'] as unknown[] | undefined) ?? []) {
      pushFleet(task, 'TASK');
    }

    return {
      InstanceGroups: instanceGroups.length > 0 ? instanceGroups : undefined,
      InstanceFleets: instanceFleets.length > 0 ? instanceFleets : undefined,
      Ec2KeyName: config['Ec2KeyName'] as string | undefined,
      Ec2SubnetId: config['Ec2SubnetId'] as string | undefined,
      Ec2SubnetIds: config['Ec2SubnetIds'] as string[] | undefined,
      HadoopVersion: config['HadoopVersion'] as string | undefined,
      Placement: config['Placement'] as import('@aws-sdk/client-emr').PlacementType | undefined,
      KeepJobFlowAliveWhenNoSteps: toBoolean(config['KeepJobFlowAliveWhenNoSteps']),
      TerminationProtected: toBoolean(config['TerminationProtected']),
      UnhealthyNodeReplacement: toBoolean(config['UnhealthyNodeReplacement']),
      EmrManagedMasterSecurityGroup: config['EmrManagedMasterSecurityGroup'] as string | undefined,
      EmrManagedSlaveSecurityGroup: config['EmrManagedSlaveSecurityGroup'] as string | undefined,
      ServiceAccessSecurityGroup: config['ServiceAccessSecurityGroup'] as string | undefined,
      AdditionalMasterSecurityGroups: config['AdditionalMasterSecurityGroups'] as
        | string[]
        | undefined,
      AdditionalSlaveSecurityGroups: config['AdditionalSlaveSecurityGroups'] as
        | string[]
        | undefined,
    };
  }

  private toInstanceGroupConfig(
    raw: Record<string, unknown>,
    role: InstanceRoleType
  ): InstanceGroupConfig {
    return {
      InstanceRole: role,
      InstanceType: raw['InstanceType'] as string,
      InstanceCount: toNumber(raw['InstanceCount']) as number,
      Name: raw['Name'] as string | undefined,
      Market: raw['Market'] as import('@aws-sdk/client-emr').MarketType | undefined,
      BidPrice: raw['BidPrice'] as string | undefined,
      Configurations: toSdkConfigurations(raw['Configurations']),
      EbsConfiguration: raw['EbsConfiguration'] as
        | import('@aws-sdk/client-emr').EbsConfiguration
        | undefined,
      AutoScalingPolicy: raw['AutoScalingPolicy'] as
        | import('@aws-sdk/client-emr').AutoScalingPolicy
        | undefined,
      CustomAmiId: raw['CustomAmiId'] as string | undefined,
    };
  }

  private toInstanceFleetConfig(
    raw: Record<string, unknown>,
    type: InstanceFleetType
  ): InstanceFleetConfig {
    return {
      InstanceFleetType: type,
      Name: raw['Name'] as string | undefined,
      TargetOnDemandCapacity: toNumber(raw['TargetOnDemandCapacity']),
      TargetSpotCapacity: toNumber(raw['TargetSpotCapacity']),
      InstanceTypeConfigs: toSdkInstanceTypeConfigs(raw['InstanceTypeConfigs']),
      LaunchSpecifications: raw['LaunchSpecifications'] as
        | import('@aws-sdk/client-emr').InstanceFleetProvisioningSpecifications
        | undefined,
      ResizeSpecifications: raw['ResizeSpecifications'] as
        | import('@aws-sdk/client-emr').InstanceFleetResizingSpecifications
        | undefined,
    };
  }

  private toManagedScalingPolicy(
    config: Record<string, unknown> | undefined
  ): ManagedScalingPolicy | undefined {
    if (!config) return undefined;
    const limits = config['ComputeLimits'] as Record<string, unknown> | undefined;
    // ComputeLimits is required for a valid managed-scaling policy. Without it
    // there is nothing to PutManagedScalingPolicy — return undefined so both
    // create (no ManagedScalingPolicy set) and update (routes to
    // RemoveManagedScalingPolicy) do the right thing instead of sending an
    // empty policy AWS rejects.
    if (!limits) return undefined;
    return {
      ComputeLimits: {
        UnitType: limits['UnitType'] as
          | import('@aws-sdk/client-emr').ComputeLimitsUnitType
          | undefined,
        MinimumCapacityUnits: toNumber(limits['MinimumCapacityUnits']),
        MaximumCapacityUnits: toNumber(limits['MaximumCapacityUnits']),
        MaximumOnDemandCapacityUnits: toNumber(limits['MaximumOnDemandCapacityUnits']),
        MaximumCoreCapacityUnits: toNumber(limits['MaximumCoreCapacityUnits']),
      },
      UtilizationPerformanceIndex: toNumber(config['UtilizationPerformanceIndex']),
      ScalingStrategy: config['ScalingStrategy'] as
        | import('@aws-sdk/client-emr').ScalingStrategy
        | undefined,
    };
  }

  private toAutoTerminationPolicy(
    config: Record<string, unknown> | undefined
  ): AutoTerminationPolicy | undefined {
    if (!config) return undefined;
    return { IdleTimeout: toNumber(config['IdleTimeout']) };
  }

  /**
   * Apply the planned group and fleet changes (go-to-k/cdkd#5422) through the
   * `AWS::EMR::InstanceGroupConfig` / `InstanceFleetConfig` providers' own
   * `update()`, which issue `ModifyInstanceGroups` / `PutAutoScalingPolicy` /
   * `RemoveAutoScalingPolicy` / `ModifyInstanceFleet` and wait for the resize to
   * settle, so the two paths share one resize and one wait. Each group or
   * fleet is found by its role, and a TASK one by its `Name` (CloudFormation
   * tells them apart by name); one at a time, since EMR refuses a resize while
   * another is in progress.
   */
  private async applyInstancesResizes(
    logicalId: string,
    clusterId: string,
    plan: InstancesInPlacePlan,
    mask: MaskerFn | undefined
  ): Promise<void> {
    if (plan.groups.length === 0 && plan.fleets.length === 0) return;
    const options = { pollIntervalMs: this.pollIntervalMs, maxWaitMs: this.maxWaitMs };
    const pick = <T extends { Name?: string | undefined }>(
      candidates: T[],
      resize: InstancesResize,
      kind: string
    ): T => {
      const name = resize.next['Name'];
      const matches =
        resize.type === 'TASK' && typeof name === 'string'
          ? candidates.filter((c) => c.Name === name)
          : candidates;
      if (matches.length !== 1) {
        throw new ProvisioningError(
          safeMsg`Cannot apply Instances.${resize.path} to EMR cluster ${clusterId}: found ${String(matches.length)} ${resize.type} instance ${kind}s${resize.type === 'TASK' && typeof name === 'string' ? safeMsg` named ${name}` : ''}, expected exactly one`,
          'AWS::EMR::Cluster',
          logicalId,
          clusterId
        );
      }
      return matches[0]!;
    };
    if (plan.groups.length > 0) {
      const groups = await this.listInstanceGroups(clusterId);
      const groupProvider = new EMRInstanceGroupConfigProvider(options);
      for (const resize of plan.groups) {
        const group = pick(
          groups.filter((g) => g.InstanceGroupType === resize.type),
          resize,
          'group'
        );
        const bag = (side: Record<string, unknown>): Record<string, unknown> => ({
          JobFlowId: clusterId,
          InstanceCount: side['InstanceCount'],
          AutoScalingPolicy: side['AutoScalingPolicy'],
        });
        await groupProvider.update(
          logicalId,
          group.Id!,
          'AWS::EMR::InstanceGroupConfig',
          bag(resize.next),
          bag(resize.prev),
          mask ? { maskSecrets: mask } : undefined
        );
      }
    }
    if (plan.fleets.length > 0) {
      const fleets = await this.listInstanceFleets(clusterId);
      const fleetProvider = new EMRInstanceFleetConfigProvider(options);
      for (const resize of plan.fleets) {
        const fleet = pick(
          fleets.filter((f) => f.InstanceFleetType === resize.type),
          resize,
          'fleet'
        );
        const bag = (side: Record<string, unknown>): Record<string, unknown> => ({
          ClusterId: clusterId,
          InstanceFleetType: resize.type,
          TargetOnDemandCapacity: side['TargetOnDemandCapacity'],
          TargetSpotCapacity: side['TargetSpotCapacity'],
        });
        await fleetProvider.update(
          logicalId,
          fleet.Id!,
          'AWS::EMR::InstanceFleetConfig',
          bag(resize.next),
          bag(resize.prev),
          mask ? { maskSecrets: mask } : undefined
        );
      }
    }
  }

  // ─── UPDATE ────────────────────────────────────────────────────────

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    const changed = (key: string): boolean => !jsonEqual(properties[key], previousProperties[key]);

    // The deploy diff classifies an `Instances` change as a replacement unless
    // only members CloudFormation updates in place moved (go-to-k/cdkd#5418,
    // `emrClusterInstancesReplaced`). This method applies those members
    // (go-to-k/cdkd#5422, `planInstancesInPlace`), and refuses a replacing
    // member as defence in depth (the diff was bypassed).
    const nextInstances = (properties['Instances'] ?? {}) as Record<string, unknown>;
    const prevInstances = (previousProperties['Instances'] ?? {}) as Record<string, unknown>;

    // Issue [#2610] sites 2 and 3. Both refusals below advise a replacement,
    // and BOTH advices were wrong in two independent ways.
    //
    // 1. `AWS::EMR::Cluster` is in `STATEFUL_TYPES`, so the deploy engine's
    //    `--replace` fallback refuses it a second time with
    //    STATEFUL_REPLACE_BLOCKED unless `--force-stateful-recreation` is also
    //    passed. Name the full flag set upfront, as the `AWS::Logs::LogGroup`
    //    guard does (issue [#2558]).
    // 2. Neither flag can clear `Instances.TerminationProtected`: the
    //    replacement's DELETE runs from the deploy engine, which never sets
    //    `DeleteContext.removeProtection` — `delete()` below gates its
    //    `SetTerminationProtection` flip-off on exactly that field. See
    //    `../replacement-protection-advice.ts`.
    //
    // The RECORDED bag is the one to read: both refusals fire before any
    // `SetTerminationProtection` / `ModifyCluster*` call in this method, so at
    // this point AWS still holds what `previousProperties` records.
    // A THUNK, not a value: both refusals are defence-in-depth arms that fire
    // only when the replacement layer was bypassed, so building an ~900-char
    // sentence on every ordinary `update()` would be pure waste.
    const replaceFlags = 'cdkd deploy --replace --force-stateful-recreation';
    const replaceRemedy = (): string =>
      // `toBoolean` is the SAME predicate this provider's own wire read uses
      // (`create()` / the `SetTerminationProtection` arm), not
      // `isTruthyCfnBoolean`: the two disagree on `TerminationProtected: 1`,
      // which `toBoolean` SENDS as protected while the CFn-boolean helper reads
      // as unprotected -- so the short advice would go to a cluster AWS really
      // is protecting. Sharing the wire's predicate is the `config-shape.ts`
      // rule applied to a read.
      toBoolean(prevInstances['TerminationProtected']) === true
        ? protectedReplacementAdvice({
            evidence:
              "cdkd's recorded properties for this cluster carry " +
              'Instances.TerminationProtected: true',
            replaceFlags,
            disable: {
              before: 'aws emr modify-cluster-attributes --cluster-id',
              identifier: physicalId,
              after: '--no-termination-protected',
            },
          })
        : `Re-deploy with ${replaceFlags}, or destroy + redeploy the stack.`;

    let instancesPlan: InstancesInPlacePlan = EMPTY_INSTANCES_PLAN;
    if (changed('Instances')) {
      // Whether a member's change REPLACES, judged on the deploy diff's own
      // predicate, so the two never disagree. A position recorded as a
      // `{{resolve:...}}` reference and handed here resolved reads as its
      // recorded reference for this judgement only (as the top-level loop
      // below exempts one, go-to-k/cdkd#4275): the diff compares references
      // as written, so a reference the template EDITED in a replacing part was
      // a replacement and never reaches this method. The in-place
      // sub-members are planned below from the RAW sides, so an in-place edit
      // is never dropped behind a reference that stood beside it.
      const mask = context?.maskSecrets;
      const isReplacingMember = (key: string): boolean =>
        emrClusterInstancesReplaced(
          { [key]: prevInstances[key] },
          { [key]: withRecordedReferences(nextInstances[key], prevInstances[key], mask) }
        );
      const movedKeys = [
        ...new Set([...Object.keys(nextInstances), ...Object.keys(prevInstances)]),
      ].filter((key) => !jsonEqual(nextInstances[key], prevInstances[key]));
      // An ABSENT block reads as `{}` (as `nextInstances` / `prevInstances`
      // do), so a lone in-place member on one side is still applied; any other
      // block that is not an object is compared whole.
      const blockIsObject = (value: unknown): boolean =>
        value == null || (typeof value === 'object' && !Array.isArray(value));
      const blocksAreObjects =
        blockIsObject(properties['Instances']) && blockIsObject(previousProperties['Instances']);
      const replacing = blocksAreObjects
        ? movedKeys.some(isReplacingMember)
        : emrClusterInstancesReplaced(previousProperties['Instances'], properties['Instances']);
      if (replacing) {
        // The members are judged key by key, so this names a member that
        // replaces, never an in-place one moved beside it. A block that is not
        // an object is named whole.
        const named = blocksAreObjects ? movedKeys.find(isReplacingMember) : undefined;
        const subject =
          named === undefined
            ? safeMsg`AWS EMR Cluster's Instances block`
            : safeMsg`AWS EMR Cluster Instances.${named}`;
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${subject} cannot be updated in place — CloudFormation replaces the cluster for this change. ` +
            replaceRemedy()
        );
      }
      instancesPlan = planInstancesInPlace(prevInstances, nextInstances);
      // REMOVING `UnhealthyNodeReplacement` has no value to send: CloudFormation
      // fails that update ("Internal Failure", then a rollback; raw CFn A/B on
      // go-to-k/cdkd#5422), so cdkd refuses it before any call. A rollback
      // replay cannot edit the template, so it keeps the live value and warns.
      if (
        instancesPlan.unhealthyNodeReplacement &&
        nextInstances['UnhealthyNodeReplacement'] === undefined
      ) {
        const removal = safeMsg`${logicalId} (AWS::EMR::Cluster): removing Instances.UnhealthyNodeReplacement fails under CloudFormation too (its update ends in Internal Failure and rolls back). Declare it explicitly instead (true is EMR's default).`;
        if (!context?.replayingState) {
          throw new ResourceUpdateNotSupportedError(resourceType, logicalId, removal);
        }
        this.logger.warn(safeMsg`${removal} The rollback leaves the live value in place.`);
        instancesPlan = { ...instancesPlan, unhealthyNodeReplacement: false };
      }
    }
    const terminationProtectedChanged = instancesPlan.terminationProtected;

    // Any changed top-level property that is neither registry-createOnly
    // (which never reaches here) nor a known mutable one is refused. This
    // guard fires only if the replacement layer is bypassed. A secret-derived
    // value (a `Name`, a `KerberosAttributes` password) is recorded as its
    // `{{resolve:...}}` reference and handed here resolved, which is no change
    // (go-to-k/cdkd#4275).
    for (const key of Object.keys({ ...properties, ...previousProperties })) {
      if (key === 'Instances') continue;
      if (!changed(key)) continue;
      if (
        !MUTABLE_TOP_LEVEL_PROPS.has(key) &&
        !(await unchangedBehindSecretReference({
          resourceType,
          key,
          desired: properties[key],
          previous: previousProperties[key],
          maskSecrets: context?.maskSecrets,
        }))
      ) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          safeMsg`AWS EMR Cluster ${key} is immutable on AWS — it is fixed at cluster creation. ` +
            replaceRemedy()
        );
      }
    }

    // Issue #1160: a LEFT_IN_PLACE_ON_REMOVAL property removed from the
    // desired side has nothing to send — ModifyCluster keeps a field it is not
    // sent, and cdkd sends no reset, as CloudFormation leaves it
    // (LEFT_IN_PLACE_ON_REMOVAL). Counting it as a change only issued a
    // ModifyCluster carrying no update field. Named once, and only after the
    // update SUCCEEDED (the shared caller's warning has the same timing): a
    // retried attempt would repeat it. Not on `drift --revert`: its previous
    // side is an AWS readback, so a key the desired side lacks was never
    // removed from a template.
    const removed = context?.removedProperties;
    const leftInPlaceNames = LEFT_IN_PLACE_ON_REMOVAL.filter((key) =>
      removed !== undefined
        ? removed.has(key)
        : properties[key] === undefined && previousProperties[key] !== undefined
    );
    const warnLeftInPlace = (): void => {
      if (leftInPlaceNames.length === 0 || context?.desiredFromAwsReadback) return;
      this.logger.warn(
        leftInPlaceWarning(
          logicalId,
          leftInPlaceNames,
          context?.replayingState ? 'rollback' : 'deploy'
        )
      );
    };

    const visibleChanged = changed('VisibleToAllUsers');
    const stepConcurrencyChanged =
      changed('StepConcurrencyLevel') && properties['StepConcurrencyLevel'] !== undefined;
    const managedScalingChanged = changed('ManagedScalingPolicy');
    const autoTerminationChanged = changed('AutoTerminationPolicy');
    const tagsChanged = changed('Tags');

    if (
      !terminationProtectedChanged &&
      !instancesPlan.unhealthyNodeReplacement &&
      instancesPlan.groups.length === 0 &&
      instancesPlan.fleets.length === 0 &&
      !visibleChanged &&
      !stepConcurrencyChanged &&
      !managedScalingChanged &&
      !autoTerminationChanged &&
      !tagsChanged
    ) {
      this.logger.debug(`No mutable diff for EMR Cluster ${logicalId}, skipping update`);
      warnLeftInPlace();
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating EMR Cluster ${logicalId}: ${physicalId}`);

    try {
      if (terminationProtectedChanged) {
        await this.getClient().send(
          new SetTerminationProtectionCommand({
            JobFlowIds: [physicalId],
            TerminationProtected: toBoolean(nextInstances['TerminationProtected']) ?? false,
          })
        );
      }

      if (instancesPlan.unhealthyNodeReplacement) {
        await this.getClient().send(
          new SetUnhealthyNodeReplacementCommand({
            JobFlowIds: [physicalId],
            UnhealthyNodeReplacement: toBoolean(nextInstances['UnhealthyNodeReplacement']),
          })
        );
      }

      await this.applyInstancesResizes(logicalId, physicalId, instancesPlan, context?.maskSecrets);

      if (visibleChanged) {
        await this.getClient().send(
          new SetVisibleToAllUsersCommand({
            JobFlowIds: [physicalId],
            VisibleToAllUsers: toBoolean(properties['VisibleToAllUsers']) ?? false,
          })
        );
      }

      if (stepConcurrencyChanged) {
        await this.getClient().send(
          new ModifyClusterCommand({
            ClusterId: physicalId,
            StepConcurrencyLevel: toNumber(properties['StepConcurrencyLevel']),
          })
        );
      }

      if (managedScalingChanged) {
        const next = this.toManagedScalingPolicy(
          properties['ManagedScalingPolicy'] as Record<string, unknown> | undefined
        );
        if (next) {
          await this.getClient().send(
            new PutManagedScalingPolicyCommand({
              ClusterId: physicalId,
              ManagedScalingPolicy: next,
            })
          );
        } else {
          await this.getClient().send(
            new RemoveManagedScalingPolicyCommand({ ClusterId: physicalId })
          );
        }
      }

      if (autoTerminationChanged) {
        const next = this.toAutoTerminationPolicy(
          properties['AutoTerminationPolicy'] as Record<string, unknown> | undefined
        );
        if (next && next.IdleTimeout !== undefined) {
          await this.getClient().send(
            new PutAutoTerminationPolicyCommand({
              ClusterId: physicalId,
              AutoTerminationPolicy: next,
            })
          );
        } else {
          await this.getClient().send(
            new RemoveAutoTerminationPolicyCommand({ ClusterId: physicalId })
          );
        }
      }

      if (tagsChanged) {
        await this.applyTagDiff(
          physicalId,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      // Re-derive attributes so the deploy engine's state write keeps
      // GetAtt-served attributes (MasterPublicDNS) fresh. Best-effort: the
      // real update already succeeded, so a transient Describe failure must
      // not fail (and roll back) the whole update.
      let cluster: Cluster | undefined;
      try {
        const resp = await this.getClient().send(
          new DescribeClusterCommand({ ClusterId: physicalId })
        );
        cluster = resp.Cluster;
      } catch (describeError) {
        this.logger.debug(
          `Post-update attribute refresh for ${physicalId} failed (returning without attributes): ${
            describeAwsFailure(describeError).detail
          }`
        );
      }

      this.logger.debug(`Successfully updated EMR Cluster ${logicalId}`);
      warnLeftInPlace();

      return {
        physicalId,
        wasReplaced: false,
        ...(cluster && { attributes: this.buildAttributes(cluster) }),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update EMR Cluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Apply a `Tags` diff via `AddTags` / `RemoveTags`. Full-tag-removal is
   * handled explicitly (a tag present before and absent now must be removed
   * via `RemoveTags` — mirrors the #981 ECR regression class where an empty
   * desired tag set silently left the old tags in place). Both sides are read
   * through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record untags
   * nothing.
   */
  private async applyTagDiff(
    physicalId: string,
    resourceType: string,
    logicalId: string,
    prevTagsRaw: unknown,
    nextTagsRaw: unknown
  ): Promise<void> {
    const plan = planTagDiff(prevTagsRaw, nextTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const toSet: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
    const toRemove = plan.remove;

    if (toRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsCommand({ ResourceId: physicalId, TagKeys: toRemove })
      );
    }
    if (toSet.length > 0) {
      await this.getClient().send(new AddTagsCommand({ ResourceId: physicalId, Tags: toSet }));
    }
  }

  // ─── DELETE ────────────────────────────────────────────────────────

  /**
   * Terminate an EMR cluster.
   *
   * The compensation boundary (issue #2204): a `--remove-protection` flip of
   * `TerminationProtected` whose `TerminateJobFlows` then fails terminally is
   * undone here, so a destroy that did not happen does not leave a live cluster
   * with its guard stripped.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    await deleteWithProtectionCompensation({
      registry: this.protectionFlips,
      key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
      run: (flip) => this.deleteOnce(logicalId, physicalId, resourceType, context, flip),
      compensation: {
        logicalId,
        physicalId,
        logger: this.logger,
        site: emrClusterProtectionSite(physicalId, context?.expectedRegion),
        reEnable: async () => {
          await this.getClient().send(
            new SetTerminationProtectionCommand({
              JobFlowIds: [physicalId],
              TerminationProtected: true,
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
    this.logger.debug(`Deleting EMR Cluster ${logicalId}: ${physicalId}`);

    // Pre-check: resolve the current state so an already-terminated /
    // gone-from-a-different-region cluster is handled idempotently before
    // any terminate call.
    let current: Cluster | undefined;
    try {
      const resp = await this.getClient().send(
        new DescribeClusterCommand({ ClusterId: physicalId })
      );
      current = resp.Cluster;
    } catch (error) {
      if (error instanceof InvalidRequestException) {
        // The cluster id is not valid in this region — either truly gone or
        // the client is pointed at the wrong region. Guard with the state
        // region before trusting NotFound.
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone is named once.
          this.logger.info(
            safeMsg`  EMR cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`EMR Cluster ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to describe EMR Cluster ${logicalId} before deletion: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }

    const currentState = current?.Status?.State;
    if (currentState && TERMINAL_STATES.has(currentState)) {
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: the usual journaled cluster — its create's wait
        // saw it terminate, then the cleanup call failed.
        this.logger.info(
          safeMsg`  EMR cluster ${physicalId} (${logicalId}), which a failed deploy created, is already ${currentState}; nothing to delete`
        );
      } else {
        this.logger.debug(`EMR Cluster ${physicalId} already ${currentState}, skipping deletion`);
      }
      return;
    }

    try {
      // Honor termination protection. Under --remove-protection, flip it off
      // first (idempotent — EMR accepts the call when already false); a
      // TerminateJobFlows against a protected cluster otherwise fails with a
      // ValidationException. Mirrors the EC2/ASG --remove-protection pattern.
      //
      // The pre-check `DescribeCluster` above is this attempt's readback of the
      // guard, so a terminal failure below restores ONLY a guard this run
      // turned off. A rejected flip still fails the delete, as before: it is
      // wrapped by the `catch` below, and nothing is recorded for it.
      if (context?.removeProtection) {
        await observeThenDisableProtection({
          flip,
          logger: this.logger,
          physicalId,
          mask: context?.maskSecrets,
          guardName: 'TerminationProtected',
          observe: () => Promise.resolve(current?.TerminationProtected === true),
          disable: async () => {
            await this.getClient().send(
              new SetTerminationProtectionCommand({
                JobFlowIds: [physicalId],
                TerminationProtected: false,
              })
            );
          },
        });
        this.logger.debug(
          `Disabled termination protection on EMR Cluster ${physicalId} before deletion`
        );
      }

      await this.getClient().send(new TerminateJobFlowsCommand({ JobFlowIds: [physicalId] }));
      // AWS took the terminate. What can still throw after this is the
      // termination WAIT (a poll failure or its timeout), against a cluster
      // that is already shutting down, so it must not re-enable the guard.
      flip.deleteAccepted = true;
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to terminate EMR Cluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }

    // Termination is async — poll until TERMINATED. A timeout is a hard error
    // (never warn-and-continue): a still-running EMR cluster keeps billing
    // per instance-hour and the destroy must not report success.
    await this.waitForClusterTerminated(physicalId, logicalId, resourceType, context?.maskSecrets);

    this.logger.debug(`Successfully deleted EMR Cluster ${logicalId}`);
  }

  // ─── Lifecycle polling ─────────────────────────────────────────────

  /**
   * Issue the polling `DescribeCluster` with bounded tolerance for TRANSIENT
   * errors (throttling / 5xx / connection resets): up to
   * `maxConsecutiveTransient` consecutive failures are absorbed before the
   * error propagates. A 10-minute poll at 15s intervals would otherwise turn
   * a single throttle into a spurious failure + rollback cycle. Non-transient
   * errors propagate immediately.
   */
  private async describeForPoll(
    clusterId: string,
    transientState: { count: number },
    maxConsecutiveTransient = 5
  ): Promise<Cluster | undefined> {
    try {
      const response = await this.getClient().send(
        new DescribeClusterCommand({ ClusterId: clusterId })
      );
      transientState.count = 0;
      return response.Cluster;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      const msg = describeAwsFailure(error).detail;
      const transient =
        name === 'ThrottlingException' ||
        name === 'InternalServerException' ||
        name === 'InternalServerError' ||
        name === 'TimeoutError' ||
        /rate exceeded|too many requests|throttl|timed? ?out|ECONNRESET|EPIPE|socket hang up/i.test(
          msg
        );
      if (transient && transientState.count < maxConsecutiveTransient) {
        transientState.count += 1;
        this.logger.debug(
          `Transient DescribeCluster error while polling ${clusterId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
        );
        return undefined;
      }
      throw error;
    }
  }

  private async waitForClusterReady(
    clusterId: string,
    logicalId: string,
    resourceType: string,
    mask?: MaskerFn
  ): Promise<Cluster> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      const cluster = await this.describeForPoll(clusterId, transientState);
      const state = cluster?.Status?.State;

      if (cluster && state && CREATE_READY_STATES.has(state)) return cluster;

      if (state && TERMINAL_STATES.has(state)) {
        const reason = cluster?.Status?.StateChangeReason;
        throw this.wrapStatusReasonError(
          mask,
          { code: reason?.Code, message: reason?.Message },
          'no state-change reason reported',
          (text, cause) =>
            new ProvisioningError(
              `EMR Cluster ${clusterId} entered terminal state ${state} during creation: ${text}`,
              resourceType,
              logicalId,
              clusterId,
              cause
            )
        );
      }

      this.logger.debug(`EMR Cluster ${clusterId} state: ${state ?? 'unknown'}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EMR Cluster ${clusterId} to reach WAITING/RUNNING (${Math.round(this.maxWaitMs / 60000)} min)`,
      resourceType,
      logicalId,
      clusterId
    );
  }

  private async waitForClusterTerminated(
    clusterId: string,
    logicalId: string,
    resourceType: string,
    mask?: MaskerFn
  ): Promise<void> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      let cluster: Cluster | undefined;
      try {
        cluster = await this.describeForPoll(clusterId, transientState);
      } catch (error) {
        if (error instanceof InvalidRequestException) return; // aged out of Describe = gone
        const cause = error instanceof Error ? error : undefined;
        throw this.wrapCaughtError(
          mask,
          error,
          (text) =>
            new ProvisioningError(
              `Failed to poll EMR Cluster ${clusterId} termination: ${text}`,
              resourceType,
              logicalId,
              clusterId,
              cause
            )
        );
      }

      const state = cluster?.Status?.State;
      if (state && TERMINAL_STATES.has(state)) {
        if (state === 'TERMINATED_WITH_ERRORS') {
          // The reason's code at warn, its text at debug (go-to-k/cdkd#2319): a
          // validation reason names IAM role ARNs and the account id.
          const m = maskerOrIdentity(mask);
          const head = `EMR Cluster ${clusterId} terminated with errors: `;
          const stateReason = cluster?.Status?.StateChangeReason;
          const reason = describeAwsStatusReason(
            { code: stateReason?.Code, message: stateReason?.Message },
            'no state-change reason reported'
          );
          if (reason.redacted) this.logger.debug(m(`${head}${m(reason.detail)}`));
          this.logger.warn(
            m(`${head}${m(reason.summary)} (the cluster is gone and no longer bills)`)
          );
        }
        return;
      }

      this.logger.debug(
        `EMR Cluster ${clusterId} state: ${state ?? 'unknown'}, waiting for termination...`
      );
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EMR Cluster ${clusterId} termination (${Math.round(this.maxWaitMs / 60000)} min) — verify and terminate it manually to stop billing`,
      resourceType,
      logicalId,
      clusterId
    );
  }

  // ─── Attributes ────────────────────────────────────────────────────

  private buildAttributes(cluster: Cluster | undefined): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    if (cluster?.Id !== undefined) attributes['Id'] = cluster.Id;
    if (cluster?.MasterPublicDnsName !== undefined) {
      attributes['MasterPublicDNS'] = cluster.MasterPublicDnsName;
    }
    return attributes;
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id') return physicalId;

    const response = await this.getClient().send(
      new DescribeClusterCommand({ ClusterId: physicalId })
    );
    const cluster = response.Cluster;
    if (!cluster) return undefined;

    switch (attributeName) {
      case 'MasterPublicDNS':
        return cluster.MasterPublicDnsName;
      default:
        return undefined;
    }
  }

  // ─── IDENTITY (go-to-k/cdkd#4606) ──────────────────────────────────

  /**
   * go-to-k/cdkd#4606: whether the cluster a failed CREATE journaled (one whose
   * own terminate failed) is the one the record under the same logical id holds
   * — a fix-forward that created a new cluster there.
   *
   * The identity is the `j-…` id `RunJobFlow` mints: unique per account and
   * region and never reassigned, so two distinct ids in the stack's region name
   * two distinct clusters. Any other id form is `'unknown'`; equal ids are
   * `'same'` without a read. After the region check, `DescribeCluster` must
   * read the record's cluster back under its own id, in any state: the same
   * client then proves it is in the stack's account and region, and a
   * transient cluster (no `KeepJobFlowAliveWhenNoSteps`, an idle
   * `AutoTerminationPolicy`) may already be terminating by the settle. A
   * record cluster EMR does not know, or one reading back as another id, is
   * `'unknown'`. The journaled cluster is then `'different'`, whether it reads back in any
   * state (a `TERMINATED_WITH_ERRORS` one included: the settle's delete names
   * it already terminated) or EMR answers `InvalidRequestException` for it;
   * only a read naming the record's cluster makes it `'same'`. Any other
   * failure throws, which the caller reads as `'unknown'`.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== 'AWS::EMR::Cluster') return 'unknown';
    if (
      !CLUSTER_ID_PATTERN.test(journaledPhysicalId) ||
      !CLUSTER_ID_PATTERN.test(record.physicalId)
    ) {
      return 'unknown';
    }
    if (journaledPhysicalId === record.physicalId) return 'same';
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recorded = await this.readClusterIdentity(record.physicalId);
    if (recorded?.id !== record.physicalId) return 'unknown';
    const journaled = await this.readClusterIdentity(journaledPhysicalId);
    return journaled?.id === recorded.id ? 'same' : 'different';
  }

  /**
   * The id `DescribeCluster` reports for `clusterId`, or `undefined`
   * on `InvalidRequestException` (EMR's answer for an id it does not know).
   * Any other failure, and a response naming no cluster, throws: "could not
   * read" never reads as "gone".
   */
  private async readClusterIdentity(clusterId: string): Promise<{ id: string } | undefined> {
    let response;
    try {
      response = await this.getClient().send(new DescribeClusterCommand({ ClusterId: clusterId }));
    } catch (error) {
      if (error instanceof InvalidRequestException) return undefined;
      throw error;
    }
    const id = response.Cluster?.Id;
    if (typeof id !== 'string') {
      throw new Error('DescribeCluster did not return the cluster asked for');
    }
    return { id };
  }

  // ─── IMPORT ────────────────────────────────────────────────────────

  /**
   * Adopt an existing EMR cluster into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <logicalId>=j-XXXX` override (`knownPhysicalId`) → verify
   *     via `DescribeCluster`. There is no template name property that equals
   *     the physical id — a cluster's id (`j-...`) is service-generated, while
   *     the template `Name` is only the display name — so no name fallback
   *     applies (`resolveExplicitPhysicalId(..., null)`).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, null);
    if (explicit) {
      const cluster = await this.describeClusterOrUndefined(explicit);
      // A cluster that has aged out of DescribeCluster (returns null) or that
      // is already terminated is not adoptable — report not-found so the
      // import command marks it skipped rather than writing dead state.
      if (!cluster || (cluster.Status?.State && TERMINAL_STATES.has(cluster.Status.State))) {
        return null;
      }
      return { physicalId: explicit, attributes: this.buildAttributes(cluster) };
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // cluster reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * `DescribeCluster` that maps a not-found (`InvalidRequestException` — the
   * cluster id is unknown in this region / aged out of Describe) to
   * `undefined` instead of throwing, so `import()` can treat it as "no match"
   * rather than aborting the whole adoption run. Also consumed by
   * `readCurrentState` for the same gone-cluster tolerance.
   *
   * Note the mapping is BROAD — `InvalidRequestException` covers more than
   * not-found, so a genuine failure here degrades to "no match" and a
   * subsequent deploy would CREATE a duplicate cluster rather than adopt the
   * existing one. Narrowing the mapping needs a message/code-level
   * discriminator AWS does not currently document.
   */
  private async describeClusterOrUndefined(clusterId: string): Promise<Cluster | undefined> {
    try {
      const resp = await this.getClient().send(
        new DescribeClusterCommand({ ClusterId: clusterId })
      );
      return resp.Cluster;
    } catch (err) {
      if (err instanceof InvalidRequestException) return undefined;
      throw err;
    }
  }

  // ─── DRIFT (readCurrentState) ──────────────────────────────────────

  /**
   * Read the currently-deployed properties for `cdkd drift` and to seed the
   * `observedProperties` baseline right after `cdkd import`.
   *
   * The bulk of the work is reversing the flatten that `create()` applies to
   * the CFn `Instances` block: `DescribeCluster` reports the cluster's
   * `InstanceCollectionType`, and the instance groups / fleets themselves come
   * from `ListInstanceGroups` / `ListInstanceFleets` as FLAT arrays with a
   * per-entry `InstanceGroupType` / `InstanceFleetType` discriminator — the
   * exact inverse of the role-keyed CFn `MasterInstanceGroup` /
   * `CoreInstanceGroup` / `TaskInstanceGroups` (+ `*InstanceFleet(s)`) shape.
   * `reverseInstancesToCfn` re-buckets them and folds in the flat
   * `Ec2InstanceAttributes` (subnet / key name / security groups).
   *
   * Scope: the reversible property set — the reverse-mapped `Instances` block,
   * `Tags` (via `normalizeAwsTagsToCfn`, `aws:*` stripped), and the top-level
   * scalar fields `DescribeCluster` returns directly. Create-only sub-config
   * that AWS does not read back faithfully (`ManagedScalingPolicy` /
   * `AutoTerminationPolicy` — separate Get* APIs; `BootstrapActions` / `Steps`
   * / `KerberosAttributes` / `Configurations` nesting / `AdditionalInfo` /
   * `PlacementGroupConfigs`; `Instances` EBS / auto-scaling sub-specs) is
   * declared in `getDriftUnknownPaths` so the drift comparator skips it on the
   * `properties`-fallback path instead of firing a guaranteed false positive.
   * On the normal path the baseline is `observedProperties` (captured via this
   * same method), so observed == current and there is no phantom drift.
   *
   * Returns `RESOURCE_NOT_FOUND` for a `TERMINATED*` cluster (the state
   * `delete` and `import` already read as gone). An `InvalidRequestException`
   * stays `undefined` (drift-unknown): EMR uses it for more than an unknown id,
   * so it is not evidence the cluster is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const cluster = await this.describeClusterOrUndefined(physicalId);
    if (!cluster) return undefined;
    if (cluster.Status?.State && TERMINAL_STATES.has(cluster.Status.State)) {
      return RESOURCE_NOT_FOUND;
    }

    let instanceGroups: InstanceGroup[] = [];
    let instanceFleets: InstanceFleet[] = [];
    if (cluster.InstanceCollectionType === 'INSTANCE_FLEET') {
      instanceFleets = await this.listInstanceFleets(physicalId);
    } else {
      instanceGroups = await this.listInstanceGroups(physicalId);
    }

    const out: Record<string, unknown> = {
      Name: cluster.Name ?? '',
      ReleaseLabel: cluster.ReleaseLabel ?? '',
      ServiceRole: cluster.ServiceRole ?? '',
      LogUri: cluster.LogUri ?? '',
      LogEncryptionKmsKeyId: cluster.LogEncryptionKmsKeyId ?? '',
      AutoScalingRole: cluster.AutoScalingRole ?? '',
      ScaleDownBehavior: cluster.ScaleDownBehavior ?? '',
      CustomAmiId: cluster.CustomAmiId ?? '',
      OSReleaseLabel: cluster.OSReleaseLabel ?? '',
      SecurityConfiguration: cluster.SecurityConfiguration ?? '',
      EbsRootVolumeSize: cluster.EbsRootVolumeSize,
      EbsRootVolumeIops: cluster.EbsRootVolumeIops,
      EbsRootVolumeThroughput: cluster.EbsRootVolumeThroughput,
      StepConcurrencyLevel: cluster.StepConcurrencyLevel,
      VisibleToAllUsers: cluster.VisibleToAllUsers ?? false,
      JobFlowRole: cluster.Ec2InstanceAttributes?.IamInstanceProfile ?? '',
      Applications: cluster.Applications ?? [],
      Tags: normalizeAwsTagsToCfn(cluster.Tags),
      Instances: this.reverseInstancesToCfn(cluster, instanceGroups, instanceFleets),
    };
    return out;
  }

  /**
   * State property paths this provider cannot read back from AWS faithfully,
   * skipped by the drift comparator to avoid a guaranteed false positive on
   * the `properties`-fallback path. See `readCurrentState`'s docstring.
   *
   * NOTE on the `Instances.*` entries: `reverseInstancesToCfn` deliberately
   * reconstructs only the primary topology per group / fleet (role, type,
   * count / capacity, market, bid price, name, custom AMI) — the lossy
   * sub-specs `create()` reads (`EbsConfiguration` / `AutoScalingPolicy` /
   * per-group `Configurations`; per-fleet `InstanceTypeConfigs` /
   * `LaunchSpecifications` / `ResizeSpecifications`) and the top-level
   * `Instances` fields AWS does not report back (`HadoopVersion` /
   * `Placement` / `KeepJobFlowAliveWhenNoSteps`) are NOT reconstructed. On the
   * NORMAL drift path both the `observedProperties` baseline and the current
   * snapshot go through this same lossy reverse, so these paths are absent
   * from both sides and never drift — ignoring them there is a no-op. On the
   * `properties`-fallback path (no `observedProperties`) the baseline is the
   * full template `Instances`, which DOES carry these sub-fields, so without
   * the skip every one would fire guaranteed false-positive drift. The two
   * `Task*` arrays are ignored WHOLE (the comparator compares arrays as leaves,
   * so an element sub-field cannot be path-targeted); Master/Core groups and
   * fleets are single objects, so their lossy sub-fields are targeted directly.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [
      'AdditionalInfo',
      // Returned by readCurrentState for a richer observedProperties baseline,
      // but skipped by the comparator: AWS augments each entry with a resolved
      // `Version`/`AdditionalInfo` the template usually omits, which would fire
      // false-positive drift on the `properties`-fallback path.
      'Applications',
      'AutoTerminationPolicy',
      'BootstrapActions',
      'Configurations',
      // Top-level Instances fields readCurrentState cannot reconstruct.
      'Instances.HadoopVersion',
      'Instances.KeepJobFlowAliveWhenNoSteps',
      'Instances.Placement',
      // Master/Core instance-group lossy sub-specs (single objects → targeted).
      'Instances.CoreInstanceGroup.AutoScalingPolicy',
      'Instances.CoreInstanceGroup.Configurations',
      'Instances.CoreInstanceGroup.EbsConfiguration',
      'Instances.MasterInstanceGroup.AutoScalingPolicy',
      'Instances.MasterInstanceGroup.Configurations',
      'Instances.MasterInstanceGroup.EbsConfiguration',
      // Master/Core instance-fleet lossy sub-specs (single objects → targeted).
      'Instances.CoreInstanceFleet.InstanceTypeConfigs',
      'Instances.CoreInstanceFleet.LaunchSpecifications',
      'Instances.CoreInstanceFleet.ResizeSpecifications',
      'Instances.MasterInstanceFleet.InstanceTypeConfigs',
      'Instances.MasterInstanceFleet.LaunchSpecifications',
      'Instances.MasterInstanceFleet.ResizeSpecifications',
      // Task groups/fleets are arrays → the comparator compares them as leaves,
      // so the lossy element sub-fields force the whole array to be skipped.
      'Instances.TaskInstanceFleets',
      'Instances.TaskInstanceGroups',
      'KerberosAttributes',
      'ManagedScalingPolicy',
      'PlacementGroupConfigs',
      'Steps',
    ];
  }

  private async listInstanceGroups(clusterId: string): Promise<InstanceGroup[]> {
    const groups: InstanceGroup[] = [];
    let marker: string | undefined;
    do {
      const resp = await this.getClient().send(
        new ListInstanceGroupsCommand({ ClusterId: clusterId, ...(marker && { Marker: marker }) })
      );
      groups.push(...(resp.InstanceGroups ?? []));
      marker = resp.Marker;
    } while (marker);
    return groups;
  }

  private async listInstanceFleets(clusterId: string): Promise<InstanceFleet[]> {
    const fleets: InstanceFleet[] = [];
    let marker: string | undefined;
    do {
      const resp = await this.getClient().send(
        new ListInstanceFleetsCommand({ ClusterId: clusterId, ...(marker && { Marker: marker }) })
      );
      fleets.push(...(resp.InstanceFleets ?? []));
      marker = resp.Marker;
    } while (marker);
    return fleets;
  }

  /**
   * Reverse of `toJobFlowInstancesConfig` — re-bucket the flat SDK
   * `InstanceGroup[]` / `InstanceFleet[]` (each carrying a role discriminator)
   * back into the role-keyed CFn `Instances` shape, and fold in the flat
   * `Ec2InstanceAttributes` (subnet / key name / security groups).
   *
   * Only the primary topology fields per group / fleet are reversed (role,
   * type, count / capacity, market, bid price, name, custom AMI). Lossy
   * sub-specs (EBS block-device / auto-scaling for groups; per-instance-type
   * specs for fleets) are intentionally NOT reconstructed — they are covered
   * by the drift baseline being `observedProperties` on the normal path.
   */
  private reverseInstancesToCfn(
    cluster: Cluster,
    instanceGroups: InstanceGroup[],
    instanceFleets: InstanceFleet[]
  ): Record<string, unknown> {
    const ec2 = cluster.Ec2InstanceAttributes;
    const instances: Record<string, unknown> = {};

    const taskGroups: Record<string, unknown>[] = [];
    for (const g of instanceGroups) {
      const cfn = this.reverseInstanceGroup(g);
      switch (g.InstanceGroupType) {
        case 'MASTER':
          instances['MasterInstanceGroup'] = cfn;
          break;
        case 'CORE':
          instances['CoreInstanceGroup'] = cfn;
          break;
        case 'TASK':
          taskGroups.push(cfn);
          break;
      }
    }
    if (taskGroups.length > 0) instances['TaskInstanceGroups'] = taskGroups;

    const taskFleets: Record<string, unknown>[] = [];
    for (const f of instanceFleets) {
      const cfn = this.reverseInstanceFleet(f);
      switch (f.InstanceFleetType) {
        case 'MASTER':
          instances['MasterInstanceFleet'] = cfn;
          break;
        case 'CORE':
          instances['CoreInstanceFleet'] = cfn;
          break;
        case 'TASK':
          taskFleets.push(cfn);
          break;
      }
    }
    if (taskFleets.length > 0) instances['TaskInstanceFleets'] = taskFleets;

    if (ec2?.Ec2KeyName !== undefined) instances['Ec2KeyName'] = ec2.Ec2KeyName;
    if (ec2?.Ec2SubnetId !== undefined) instances['Ec2SubnetId'] = ec2.Ec2SubnetId;
    if (ec2?.RequestedEc2SubnetIds !== undefined) {
      instances['Ec2SubnetIds'] = ec2.RequestedEc2SubnetIds;
    }
    if (ec2?.EmrManagedMasterSecurityGroup !== undefined) {
      instances['EmrManagedMasterSecurityGroup'] = ec2.EmrManagedMasterSecurityGroup;
    }
    if (ec2?.EmrManagedSlaveSecurityGroup !== undefined) {
      instances['EmrManagedSlaveSecurityGroup'] = ec2.EmrManagedSlaveSecurityGroup;
    }
    if (ec2?.ServiceAccessSecurityGroup !== undefined) {
      instances['ServiceAccessSecurityGroup'] = ec2.ServiceAccessSecurityGroup;
    }
    if (ec2?.AdditionalMasterSecurityGroups !== undefined) {
      instances['AdditionalMasterSecurityGroups'] = ec2.AdditionalMasterSecurityGroups;
    }
    if (ec2?.AdditionalSlaveSecurityGroups !== undefined) {
      instances['AdditionalSlaveSecurityGroups'] = ec2.AdditionalSlaveSecurityGroups;
    }
    if (cluster.TerminationProtected !== undefined) {
      instances['TerminationProtected'] = cluster.TerminationProtected;
    }
    if (cluster.UnhealthyNodeReplacement !== undefined) {
      instances['UnhealthyNodeReplacement'] = cluster.UnhealthyNodeReplacement;
    }

    return instances;
  }

  private reverseInstanceGroup(g: InstanceGroup): Record<string, unknown> {
    const out: Record<string, unknown> = {
      InstanceType: g.InstanceType ?? '',
      // CFn's `InstanceCount` maps to the requested (not running) count so a
      // mid-resize read does not report transient drift.
      InstanceCount: g.RequestedInstanceCount ?? 0,
    };
    if (g.Name !== undefined) out['Name'] = g.Name;
    if (g.Market !== undefined) out['Market'] = g.Market;
    if (g.BidPrice !== undefined) out['BidPrice'] = g.BidPrice;
    if (g.CustomAmiId !== undefined) out['CustomAmiId'] = g.CustomAmiId;
    return out;
  }

  private reverseInstanceFleet(f: InstanceFleet): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (f.Name !== undefined) out['Name'] = f.Name;
    if (f.TargetOnDemandCapacity !== undefined) {
      out['TargetOnDemandCapacity'] = f.TargetOnDemandCapacity;
    }
    if (f.TargetSpotCapacity !== undefined) out['TargetSpotCapacity'] = f.TargetSpotCapacity;
    return out;
  }
}
