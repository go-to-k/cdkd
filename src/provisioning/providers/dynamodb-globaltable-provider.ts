import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isUsableAttemptedName } from '../../state/unsettled-properties.js';
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DeleteResourcePolicyCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PolicyNotFoundException,
  PutResourcePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateContributorInsightsCommand,
  UpdateKinesisStreamingDestinationCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
  type ApproximateCreationDateTimePrecision,
  type ContributorInsightsMode,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexDescription,
  type GlobalSecondaryIndexUpdate,
  type GlobalTableSettingsReplicationMode,
  type LocalSecondaryIndex,
  type OnDemandThroughput,
  type ProvisionedThroughput,
  type ReplicaGlobalSecondaryIndex,
  type StreamSpecification,
  type Tag,
  type TimeToLiveDescription,
  type ReplicationGroupUpdate,
  type CreateReplicationGroupMemberAction,
  type ReplicaDescription,
  type UpdateGlobalSecondaryIndexAction,
  type UpdateReplicationGroupMemberAction,
  type UpdateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import type {
  DescribeScalableTargetsCommandOutput,
  DescribeScalingPoliciesCommandOutput,
} from '@aws-sdk/client-application-auto-scaling';
import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand,
  RegisterScalableTargetCommand,
  PutScalingPolicyCommand,
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';
import { getLogger } from '../../utils/logger.js';
import { definedAttributes } from '../attribute-map.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import {
  isTtlAlreadyDisabled,
  isTtlRateLimited,
  planTimeToLive,
  sendTtlWaitingOutRateLimit,
} from '../dynamodb-ttl.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { isRefusedByName, markDeleteStarted, type DeleteProgress } from '../delete-started.js';
import {
  isAuxiliaryFailure,
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
} from '../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../created-resource-sink.js';
import { markNotGone } from '../not-gone.js';
import { generatedNameFor } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import {
  planTagDiff,
  tagPlanWarning,
  refuseMalformedDesiredTags,
  type CfnTagEntry,
} from '../tag-list.js';
import {
  coerceCfnBoolean,
  coerceCfnInteger,
  configBooleanRefusal,
  configStringRefusal,
  readConfigString,
  replayWarn,
  requireConfigString,
} from '../config-shape.js';
import {
  WARM_THROUGHPUT_MEMBERS,
  coerceWarmThroughput,
  isWarmThroughputDecrease,
  toFiniteNumber,
  type WarmThroughputCoercion,
  type WarmThroughputSpec,
} from '../dynamodb-warm-throughput.js';
import {
  planVectorIndexUpdates,
  readbackVectorIndexes,
  vectorIndexesForCreate,
  vectorIndexesSettled,
  vectorIndexesShapeDetail,
  type VectorIndexPlan,
} from '../dynamodb-vector-indexes.js';
import { withRetry } from '../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../interrupt-watch.js';
import { enclosingDeadlineRemainingMs } from '../../deployment/resource-deadline.js';
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  isTransientServerError,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
  INDEX_SETTLE_POLL_INTERVAL_MS,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  TABLE_INDEX_NOUN,
  VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  deleteTableWithIndexBusyRetry,
  hasTransitionalTableIndex,
  waitForIndexesSettled,
  maskedLogger,
  relayedIndexBusyDelete,
} from '../dynamodb-index-busy-delete.js';
import {
  AUTO_SCALING_TEARDOWN_MAX_RETRIES,
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS,
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS as DELETE_BUDGET_REUSE_WINDOW_MS,
  type ProtectionCompensationOutcome,
  type ProtectionFlipRecord,
  ProtectionFlipRegistry,
  autoScalingRetriesWithinDeleteBudget,
  beginDeleteWait,
  compensateRemovedDeletionProtection,
  DYNAMODB_DELETE_DEADLINE_MARGIN_MS,
  deleteBudgetKey,
  isTerminalDeleteFailure,
  resolveDynamoDbDeleteBudgetClock,
  resolveDynamoDbDeleteBudgetMs,
} from './dynamodb-delete-budget.js';
import { ElapsedBudget, ElapsedBudgetRegistry } from '../../utils/elapsed-budget.js';
import {
  createMaskedLogSinks,
  maskDeep,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import {
  pasteableAwsCommand,
  protectedReplacementAdvice,
} from '../replacement-protection-advice.js';
import { unchangedBehindSecretReference } from '../secret-reference-immutable.js';
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
  ResourceIdentityVerdict,
  ReadCurrentStateContext,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  ambientClientDefaults,
  clientDefaultsFor,
  type CredentialConfig,
} from '../../utils/ambient-client-defaults.js';
import { injectiveKey } from '../../state/record-keys.js';
import { indexEntriesByName } from '../dynamodb-contributor-insights.js';
import {
  declaredIndexInsights,
  declaredReplicaSettings,
  planReplicaIndexInsightsOps,
  canonicalizePre5381ReplicaBaseline,
  keepUnreadReplicaMembers,
  readPitrSpec,
  readStreamPolicy,
  readTablePolicy,
  reverseMapReplicaContributorInsights,
  reverseMapReplicaPitr,
  samePolicyDocument,
  planReplicaSettingCorrections,
  planReplicaSettingOps,
  replicaSettingRefusals,
  settingOf,
  SETTING_MEMBER,
  type LiveReplicaSettings,
  type ReplicaSetting,
  type ReplicaSettingOp,
} from '../dynamodb-replica-settings.js';
import {
  declaredStreamPolicyMember as declaredPolicyMember,
  reverseMapStreamPolicy as reverseMapPolicyMember,
  streamPolicyMatchesDeclared as policyMatchesDeclared,
} from '../dynamodb-stream-members.js';

/**
 * A DynamoDB table NAME (3-255 of `a-z A-Z 0-9 _ . -`), the physical id this
 * provider records. The identity answers (`isSameResource`,
 * `resourceIdentity`) refuse anything else: `DescribeTable` also takes a
 * table ARN, which this provider never records and would only be guessing
 * about.
 */
function isTableName(id: string): boolean {
  return /^[A-Za-z0-9_.-]{3,255}$/.test(id);
}

/**
 * The CLOSED path table {@link DynamoDBGlobalTableProvider.canonicalizeDriftProperties}
 * strips from BOTH drift comparison sides (issue #1742).
 *
 * One entry today: the AWS-computed `GlobalSecondaryIndexes[].WarmThroughput`.
 * A table rather than an inline check so a second per-array-element member
 * lands as a row instead of a second walk — and so the scope is READABLE as a
 * list of paths, which is what "closed table" means here. Deliberately does
 * NOT include `LocalSecondaryIndexes` (this provider's readback assigns the
 * raw SDK descriptions there, a wider divergence than one member) or
 * `Replicas[].GlobalSecondaryIndexes` (whose entries carry only the read-half
 * throughput blocks — no `WarmThroughput` is emitted or accepted there).
 */
const DRIFT_STRIPPED_INDEX_MEMBERS: ReadonlyArray<{ listKey: string; member: string }> = [
  { listKey: 'GlobalSecondaryIndexes', member: 'WarmThroughput' },
];

/**
 * AWS DynamoDB GlobalTable Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::GlobalTable using the
 * standard DynamoDB SDK (2019.11.21 API generation, NOT the legacy
 * 2017.11.29 endpoints). CDK v2's `dynamodb.TableV2` construct synthesizes
 * as this type.
 *
 * WHY a dedicated SDK provider:
 *   - Pre-PR the type fell through to Cloud Control API which did not pass
 *     a `TableName` field, so AWS auto-generated random names like
 *     `yq2phLewTEUtzr4sy2gYFRU4I-1OGJ0UFLOKOOV` instead of the cdkd
 *     `${stackName}-X<hash>` shape (Issue #383).
 *   - Per memory rule `feedback_dedicated_provider_over_special_case.md`,
 *     the consistent fix is a dedicated SDK Provider rather than adding
 *     the type to `FALLBACK_NAME_RULES`.
 *
 * **CRITICAL**: do NOT use the legacy 2017.11.29 endpoints
 * (`CreateGlobalTableCommand` / `UpdateGlobalTableCommand` /
 * `DescribeGlobalTableCommand`). The CFn type `AWS::DynamoDB::GlobalTable`
 * is the 2019.11.21 generation, which uses the regular DynamoDB CRUD API
 * (`CreateTableCommand` + `UpdateTableCommand` with `ReplicaUpdates`).
 *
 * In-place update support (post-PR #384 follow-up):
 *  - `update()` covers every mutable surface — Tags, DeletionProtection,
 *    TableClass, SSE, StreamSpec, OnDemand throughput, BillingMode flip,
 *    Replica add / remove / modify, GSI add / remove / modify, TTL toggle.
 *  - The serialization is load-bearing: AWS's `UpdateTable` does not accept
 *    `ReplicaUpdates` alongside `BillingMode` / `GlobalSecondaryIndexUpdates`,
 *    so each category is its own SDK round-trip with a wait-for-ACTIVE in
 *    between. `BillingMode` and `GlobalSecondaryIndexUpdates` DO combine, and
 *    only in the `PAY_PER_REQUEST -> PROVISIONED` flip, where AWS REQUIRES
 *    per-GSI `ProvisionedThroughput` in the SAME call as `BillingMode` ("you
 *    must specify read and write capacity unit values for the table and for
 *    each global secondary index") — so that path deliberately sends both
 *    together (Issue #1387). Immutable property changes (TableName, KeySchema,
 *    AttributeDefinitions removal, LocalSecondaryIndexes) throw
 *    `ProvisioningError` naming the offending field — the deploy engine's
 *    diff classification should catch these as REPLACEMENT before ever
 *    calling `update()`, but the guard is defense-in-depth.
 *  - Per-replica drift (`ContributorInsightsSpecification` /
 *    `PointInTimeRecoverySpecification` / `KinesisStreamSpecification`)
 *    is surfaced for BOTH the LOCAL replica AND cross-region replicas
 *    via per-region SDK clients (cached in `regionalClientCache` for
 *    the deploy run). Issue #389 lifted the v1 LOCAL-only limitation.
 *  - Cross-region replica Tags propagation (Issue #389 / #441):
 *    BOTH `create()` and `update()` resolve each non-local replica's
 *    table ARN by swapping the region segment of the local ARN and
 *    issue `TagResource` / `UntagResource` against a per-region
 *    client. The shared helper `applyCrossRegionReplicaTagsDiff`
 *    centralizes the diff + best-effort WARN-on-failure contract.
 */
/**
 * Mask every string LEAF (and every KEY) of a value before it is stringified
 * into a log line (issue #1932 item 3, adopted here by issue #1997).
 *
 * The INNER of the two masking layers `SecretMaskingContext` prescribes, and
 * neither layer subsumes the other. The outer one — routing the assembled
 * message through the masker — can only reach `maskSecretsInText`'s SUBSTRING
 * arm, which ignores needles below `MIN_NEEDLE_LENGTH` (4) and, more
 * importantly, never matches at all once `JSON.stringify` has escaped a `"`, a
 * `\` or a newline inside the value: the secret no longer OCCURS in the
 * finished line. Handing the masker each raw string reaches the WHOLE-VALUE arm
 * at any length and runs BEFORE any escaping. The mask is idempotent and matches
 * by value rather than by position, so the two layers compose.
 *
 * Walks rather than testing the top level, because a secret nested in an object
 * or array leaf is stringified — and escaped — identically.
 *
 * Issue #2176 hoisted the walk into `../masked-retry-logger.js`. The previous
 * note here said the helper was "duplicated rather than shared because these two
 * files deliberately hold no common module today" — that rationale expired the
 * moment a shared LEAF module existed for exactly this, and it had already cost
 * something: this copy carried NO depth cap, so it was one of SIX copies that
 * had drifted apart on the one property that matters.
 */
function maskLeafValue(value: unknown, maskSecrets: SecretMasker): unknown {
  return maskDeep(value, maskSecrets);
}

/**
 * go-to-k/cdkd#5487: the running update's `UpdateContext.markUnsettled` and
 * `unsettledProperties`, for the helpers that make its sends. Absent outside
 * an update (create, delete, a read), where marking does nothing.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * go-to-k/cdkd#5487: the identities a collection's entries are keyed by. A list
 * whose every entry (live, recorded and declared) is an object carrying one of
 * these is projected entry by entry; any other list is an ordinary value.
 */
const IDENTITY_KEYS = ['Region', 'IndexName', 'AttributeName'] as const;

/**
 * The identity a collection is keyed by: `{ key }` when every entry carries
 * it; `'ambiguous'` when some entry carries a candidate identity but not every
 * entry does (the projection cannot tell named entries apart, so it fails
 * CLOSED); `undefined` for an ordinary list (no entry carries one).
 */
function identityKeyOf(...lists: unknown[][]): { key: string } | 'ambiguous' | undefined {
  const entries = lists.flat();
  if (entries.length === 0) return undefined;
  const key = IDENTITY_KEYS.find((candidate) =>
    entries.every((entry) => isPlainObject(entry) && typeof entry[candidate] === 'string')
  );
  if (key !== undefined) return { key };
  const partial = entries.some(
    (entry) =>
      isPlainObject(entry) &&
      IDENTITY_KEYS.some((candidate) => typeof entry[candidate] === 'string')
  );
  return partial ? 'ambiguous' : undefined;
}

/** Positional lists whose entries happen to carry an `AttributeName`, never collections. */
const POSITIONAL_LIST_KEYS: ReadonlySet<string> = new Set(['KeySchema']);

/** A live entry the projection left out: no record or template names it. */
export interface UnnamedLiveEntry {
  /** The identity key (`Region`, `IndexName`, ...) and its value. */
  identity: string;
  value: string;
  /** Where it sits, as a member path (`Replicas`, `Replicas[us-east-1].GlobalSecondaryIndexes`). */
  path: string;
  /** The whole list was left at the record's value: its entries could not be keyed. */
  ambiguous?: true;
}

/**
 * go-to-k/cdkd#5487: the ONE projection every value `readUnsettled` returns
 * goes through, so convergence never removes or resets what neither the record
 * (`own`) nor the template (`wanted`) names:
 *
 * - a plain object keeps only the members `own` or `wanted` names, each
 *   projected in turn; a member neither names keeps the record's value, absent
 *   staying absent; `Tags` always keep the record's (tags merge);
 * - a list keyed by an identity (`IDENTITY_KEYS`: replicas by `Region`,
 *   indexes by `IndexName`, ...) keeps only the live entries whose identity
 *   `own` or `wanted` names, each projected against its named counterparts; an
 *   entry only the template names is ADOPTED (on the previous side, so it is
 *   not created again); a live entry neither names is left out (never removed)
 *   and reported in `unnamed`;
 * - anything else is the live value.
 */
function projectNamed(
  live: unknown,
  own: unknown,
  wanted: unknown,
  path: string,
  unnamed: UnnamedLiveEntry[],
  // go-to-k/cdkd#5498: the names an earlier failed update's accepted calls
  // added, per member path. A live entry (or replica tag) named here EXACTLY,
  // not redacted, joins the previous side, so the template's omission removes
  // it; nothing else does.
  attempted: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): unknown {
  const attemptedAt = (at: string): ReadonlySet<string> =>
    new Set([...(attempted.get(at) ?? [])].filter(isUsableAttemptedName));
  if (isPlainObject(live) && (isPlainObject(own) || isPlainObject(wanted))) {
    const ownBag = isPlainObject(own) ? own : undefined;
    const wantedBag = isPlainObject(wanted) ? wanted : undefined;
    const out: Record<string, unknown> = {};
    for (const key of IDENTITY_KEYS) if (Object.hasOwn(live, key)) out[key] = live[key];
    const named = new Set([...Object.keys(ownBag ?? {}), ...Object.keys(wantedBag ?? {})]);
    for (const key of named) {
      if ((IDENTITY_KEYS as readonly string[]).includes(key)) continue;
      if (key === 'Tags') {
        if (ownBag !== undefined && Object.hasOwn(ownBag, 'Tags')) out['Tags'] = ownBag['Tags'];
        const withAttempted = withAttemptedReplicaTags(
          ownBag?.['Tags'],
          wantedBag?.['Tags'],
          live['Tags'],
          attemptedAt(`${path}.Tags`)
        );
        if (withAttempted !== undefined) out['Tags'] = withAttempted;
        continue;
      }
      if (!Object.hasOwn(live, key) || live[key] === undefined) continue;
      out[key] = POSITIONAL_LIST_KEYS.has(key)
        ? live[key]
        : projectNamed(
            live[key],
            ownBag?.[key],
            wantedBag?.[key],
            `${path}.${key}`,
            unnamed,
            attempted
          );
    }
    return out;
  }
  if (Array.isArray(live)) {
    const ownList = Array.isArray(own) ? own : [];
    const wantedList = Array.isArray(wanted) ? wanted : [];
    const identity = identityKeyOf(live, ownList, wantedList);
    if (identity === undefined) return live;
    if (identity === 'ambiguous') {
      // Fail CLOSED: some entry has no identity, so a live-only entry cannot be
      // told from a named one. The record's value stands (nothing removed).
      unnamed.push({ identity: 'unkeyed entries', value: 'some', path, ambiguous: true });
      return own;
    }
    const id = identity.key;
    const byId = (list: unknown[]): Map<string, Record<string, unknown>> =>
      new Map(
        list.map((entry) => [
          (entry as Record<string, string>)[id]!,
          entry as Record<string, unknown>,
        ])
      );
    const ownById = byId(ownList);
    const wantedById = byId(wantedList);
    return live.flatMap((entry) => {
      const value = (entry as Record<string, string>)[id]!;
      const ownEntry = ownById.get(value);
      const wantedEntry = wantedById.get(value);
      if (ownEntry === undefined && wantedEntry === undefined) {
        // go-to-k/cdkd#5498: an entry a failed update's accepted call added is
        // the previous side's, whole, so the template's omission removes it.
        if (attemptedAt(path).has(value)) return [entry];
        unnamed.push({ identity: id, value, path });
        return [];
      }
      return [projectNamed(entry, ownEntry, wantedEntry, `${path}[${value}]`, unnamed, attempted)];
    });
  }
  return live;
}

/**
 * go-to-k/cdkd#5498: a replica's recorded tags plus each live tag whose key an
 * earlier failed update's accepted tag call added and neither the record nor
 * the template declares, so the tag diff removes exactly those. List shape
 * (`[{Key, Value}]`) only; `undefined` (the record's tags stand) otherwise.
 */
function withAttemptedReplicaTags(
  recorded: unknown,
  desired: unknown,
  live: unknown,
  attempted: ReadonlySet<string>
): unknown[] | undefined {
  if (attempted.size === 0 || !Array.isArray(live)) return undefined;
  const keysOf = (value: unknown): Set<string> | undefined => {
    if (value === undefined || value === null) return new Set();
    if (!Array.isArray(value)) return undefined;
    const keys = new Set<string>();
    for (const entry of value) {
      const key = (entry as { Key?: unknown } | null)?.Key;
      if (typeof key !== 'string') return undefined;
      keys.add(key);
    }
    return keys;
  };
  const recordedKeys = keysOf(recorded);
  const desiredKeys = keysOf(desired);
  if (recordedKeys === undefined || desiredKeys === undefined) return undefined;
  const removable = live.filter((entry) => {
    const key = (entry as { Key?: unknown } | null)?.Key;
    return (
      typeof key === 'string' &&
      attempted.has(key) &&
      !recordedKeys.has(key) &&
      !desiredKeys.has(key)
    );
  });
  if (removable.length === 0) return undefined;
  return [...((recorded as unknown[] | undefined) ?? []), ...removable];
}

/**
 * go-to-k/cdkd#5487: set while `readUnsettled` reads, so each best-effort read
 * of `readCurrentState` throws instead of omitting a key (an omitted key would
 * converge the setting to "not set").
 */
const strictReadScope = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Whether a read feeding `key` must throw rather than omit (go-to-k/cdkd#5487):
 * only when `readUnsettled` reads and `key` is one of the unsettled names, so a
 * read feeding a settled key keeps `readCurrentState`'s tolerance.
 */
function strictFor(key: string): boolean {
  return strictReadScope.getStore()?.has(key) === true;
}

/**
 * The strict set for one replica's reads: a replica AWS is not serving
 * (CREATION_FAILED, REGION_DISABLED, an inaccessible key, ...) keeps the
 * tolerant reads, so its regional not-found or region error never blocks the
 * deploy that recovers it.
 */
function replicaStrictness(status: string | undefined): ReadonlySet<string> {
  const current = strictReadScope.getStore() ?? new Set<string>();
  if (status === undefined || status === 'ACTIVE' || status === 'UPDATING') return current;
  return new Set([...current].filter((key) => key !== 'Replicas'));
}

const unsettledScope = new AsyncLocalStorage<{
  mark: (key: string) => void;
  unsettled: ReadonlySet<string>;
  /** go-to-k/cdkd#5498: `UpdateContext.markAttempted`. */
  attempted?: (path: string, items: readonly string[]) => void;
}>();

/** A Region usable as a path segment (`Replicas[<region>].Tags`): AWS's shape only. */
const REGION_SEGMENT = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * go-to-k/cdkd#5498: record `items` as added by a call AWS has just ACCEPTED
 * (call it after the send resolves, never before; a send that throws added
 * nothing). Outside an update it does nothing.
 */
function markAttemptedItems(path: string, items: readonly string[]): void {
  const scope = unsettledScope.getStore();
  if (scope?.attempted === undefined || items.length === 0) return;
  scope.attempted(path, items);
}

/** Mark `keys` unsettled, immediately before the send that changes them. */
function markUnsettled(...keys: string[]): void {
  const scope = unsettledScope.getStore();
  if (scope === undefined) return;
  for (const key of keys) scope.mark(key);
}

/** Whether the running update converges `key` (an earlier failure left it unsettled). */
function isUnsettled(key: string): boolean {
  return unsettledScope.getStore()?.unsettled.has(key) === true;
}

/** `text` closed as a sentence, for a wrap that continues after it. */
function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

export class DynamoDBGlobalTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private createClient: Promise<DynamoDBClient> | undefined;
  /** The credential half of the `AwsClients` `dynamoDBClient` came from (#4639). */
  private readonly credentialConfig: CredentialConfig;
  private logger = getLogger().child('DynamoDBGlobalTableProvider');
  /**
   * Caches per-region `DynamoDBClient` instances for cross-region drift
   * reads (`readCurrentState`) and cross-region Tag propagation
   * (`update()`). Keyed by region string; reuses the default credential
   * chain. Lifetime is the provider instance — one deploy run.
   */
  private regionalClientCache = new Map<string, DynamoDBClient>();
  /**
   * Caches per-region `ApplicationAutoScalingClient` instances for
   * per-replica `ReadCapacityAutoScalingSettings` reverse-mapping in
   * `readCurrentState`. Same lifetime / shape as `regionalClientCache`
   * — one per region for the duration of the provider instance.
   *
   * Issue #395: per-replica read capacity autoscaling lives in the
   * replica's region (each replica has its own scaling target +
   * policy registered against `application-autoscaling` in that
   * region), so we cannot reuse the local-region client.
   */
  private regionalAutoScalingClientCache = new Map<string, ApplicationAutoScalingClient>();
  /**
   * Caches `getAttribute(physicalId, attribute)` results for the lifetime
   * of this provider instance (one deploy run). Safe under the current
   * `update()` contract because `update()` cannot mid-deploy mutate
   * StreamArn / Arn / TableId — those are AWS-managed identifiers that
   * only change on REPLACEMENT (which destroys the provider instance).
   * If a future PR adds a stream toggle path that flips StreamArn on the
   * same physicalId, the cache must be invalidated on the matching
   * UpdateTable success.
   */
  private attributeCache = new Map<string, unknown>();
  /**
   * The ONE wall-clock allowance each `delete()` spends, keyed by physical id
   * (issue #1955). Keyed rather than per-call because `destroy-runner.ts` can
   * RE-ENTER `delete()` from the top — its outer retry loop classes a throttled
   * `DeleteTable` as retryable — inside the SAME per-resource deadline, and a
   * per-call budget would hand that second pass a fresh allowance. Keyed rather
   * than per-instance because a destroy level deletes its resources
   * CONCURRENTLY through this one provider instance.
   *
   * See `./dynamodb-delete-budget.ts` for the sizing and for the three failure
   * terms it closes.
   */
  private readonly deleteBudgets = new ElapsedBudgetRegistry();

  /**
   * What each in-flight delete did to `DeletionProtectionEnabled` (issue
   * #1978), keyed exactly as the allowance above and for exactly the same
   * reason: `destroy-runner.ts` re-enters `delete()` after a retryable failure,
   * and the second attempt's pre-flip `DescribeTable` sees the guard already
   * off BECAUSE the first attempt turned it off. A record created per call
   * would therefore read "nothing to undo" on precisely the retry-then-fail
   * case the issue names. Keyed rather than a plain field for the budget's
   * reason too — one provider instance serves a whole level's tables at once.
   */
  private readonly protectionFlips = new ProtectionFlipRegistry();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DynamoDB::GlobalTable',
      new Set([
        'TableName',
        'KeySchema',
        'AttributeDefinitions',
        'BillingMode',
        'StreamSpecification',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'SSESpecification',
        'Replicas',
        'TableClass',
        'TimeToLiveSpecification',
        'WriteProvisionedThroughputSettings',
        'WriteOnDemandThroughputSettings',
        'DeletionProtectionEnabled',
        'ReadOnDemandThroughputSettings',
        'ReadProvisionedThroughputSettings',
        'TableType',
        'VectorIndexes',
        'WarmThroughput',
        // Note: `AWS::DynamoDB::GlobalTable` has NO top-level `Tags`
        // property. Tags live inside `Replicas[].Tags`, which is
        // already covered by the `Replicas` entry above.
        //
        // go-to-k/cdkd#2762: three properties stay on the Cloud Control route.
        // `MultiRegionConsistency` and `GlobalTableWitnesses` (MRSC) do not fit
        // the per-replica serial paths here. Measured us-east-1 / us-east-2 /
        // us-west-2, 2026-11-01: the replica and witness Creates must go out in
        // ONE `UpdateTable` with the mode; a lone replica Delete is refused
        // ("does not include all witnesses"), so the update and delete paths
        // and the partial-create cleanup would each need a one-call shape;
        // `DeleteTable` is refused until they are gone; TTL is refused on such
        // a table; and it carries no stream, which `create()`'s `needsStream`
        // arm would enable. `GlobalTableSourceArn` creates a multi-account
        // replica: CDK's `TableV2MultiAccountReplica` renders no `KeySchema`
        // (which `create()` requires), and DynamoDB asks for a `ResourcePolicy`
        // on the `CreateTable` (measured, same day), a cross-account path this
        // provider has no way to exercise.
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
    // A test double may carry no `credentialConfig`: degrade to `{}`, as
    // `ambientCredentialConfig` does.
    this.credentialConfig =
      (awsClients as { credentialConfig?: CredentialConfig }).credentialConfig ?? {};
  }

  /**
   * The client `CreateTable` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * -- and every other provider sharing `getAwsClients().dynamoDB` -- keeps
   * the full SDK retry. Built in the shared client's REGION (read from it, as
   * `config.region()` resolves it), so the create cannot land in another
   * region than the calls around it, and with the credentials of the SAME
   * `AwsClients` that client came from, read at construction, so a later
   * `setAwsClients` switch cannot give the create another identity. The PROMISE is cached, so two creates on
   * a cold provider build one client; a rejected region read is not cached,
   * so the next create retries it.
   *
   * `CreateTable` carries no idempotency token and a table name is unique per
   * account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with the table the first send made, and that
   * `ResourceInUseException` surfaced from the engine's FIRST attempt as a
   * table somebody else holds. Refused here, the 5xx reaches the deploy
   * engine's retry, which marks the create as possibly replayed (`withRetry`,
   * #3978). The table is not adopted on that collision: a name is not
   * attribution (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): Promise<DynamoDBClient> {
    this.createClient ??= this.dynamoDBClient.config.region().then(
      (region) =>
        withoutServerErrorRetries(
          new DynamoDBClient({ ...clientDefaultsFor(this.credentialConfig), region })
        ),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  /**
   * Self-reported minimum per-resource deadline (issue #1955).
   *
   * The engine resolves the deadline as
   * `perTypeCliOverride ?? max(getMinResourceTimeoutMs(), globalCliDefault)`,
   * so declaring this is what turns "the shared delete budget fits inside the
   * deadline" from an assumption about the CLI default into a guarantee: a user
   * who lowers `--resource-timeout` globally can no longer re-create the
   * crossing the budget exists to remove. It equals today's
   * `DEFAULT_RESOURCE_TIMEOUT_MS`, so at default settings this changes nothing.
   *
   * **It is TYPE-level, not operation-level**, and that is a real consequence
   * rather than a detail: `deploy-engine.ts` and `destroy-runner.ts` both fold
   * it in through the same `Math.max(...)`, so a user running
   * `--resource-timeout 5m` for fail-fast CI gets 30 minutes for this type's
   * CREATE and UPDATE too, not only for the DELETE the budget is about. The
   * interface has no per-operation form, and the escape hatch for anyone who
   * wants the shorter deadline back is the per-type override
   * (`--resource-timeout AWS::DynamoDB::GlobalTable=5m`), which still wins.
   */
  getMinResourceTimeoutMs(): number {
    return DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS;
  }

  /**
   * Return a `DynamoDBClient` pinned to the given region, caching per
   * region for the lifetime of this provider instance. Uses the default
   * credential chain (env / shared config / IAM role) — no explicit
   * credential plumbing needed.
   *
   * Used by `readCurrentState` (cross-region per-replica sub-spec reads)
   * and `update()` (cross-region replica Tag propagation). Both code
   * paths fire region-scoped DynamoDB APIs (`DescribeContributorInsights`
   * / `DescribeContinuousBackups` / `DescribeKinesisStreamingDestination`
   * / `TagResource` / `UntagResource`) against the replica's region.
   *
   * The cache may return `this.dynamoDBClient` when `region` happens to
   * match the local client's region — in tests the local mock is
   * intercepted via `vi.mock('../../utils/aws-clients.js')` so reuse
   * is safe (and explicitly desired so the mock catches the call).
   */
  private getRegionalClient(region: string): DynamoDBClient {
    const cached = this.regionalClientCache.get(region);
    if (cached) return cached;
    const client = new DynamoDBClient({ ...ambientClientDefaults(), region });
    this.regionalClientCache.set(region, client);
    return client;
  }

  /**
   * Return an `ApplicationAutoScalingClient` pinned to the given region,
   * caching per region for the lifetime of this provider instance. Mirrors
   * `getRegionalClient` but for the application-autoscaling service.
   *
   * Used by `readAutoScalingSettings` (Issue #395) to recover per-replica
   * `ReadCapacityAutoScalingSettings` shapes — each cross-region replica's
   * scaling target + policy are registered with the autoscaling control
   * plane in the replica's region, so cross-region drift reads need a
   * region-scoped client.
   */
  private getRegionalAutoScalingClient(region: string): ApplicationAutoScalingClient {
    const cached = this.regionalAutoScalingClientCache.get(region);
    if (cached) return cached;
    const client = new ApplicationAutoScalingClient({ ...ambientClientDefaults(), region });
    this.regionalAutoScalingClientCache.set(region, client);
    return client;
  }

  /**
   * Lazy-init + cache the local-region `ApplicationAutoScalingClient`.
   * Previously `applyAutoScalingDiff` constructed a fresh client per
   * call when no `client` arg was passed, leaking SDK clients (each
   * holds its own HTTP agent) on multi-stack runs with many
   * GlobalTables (PR #403 review minor #4).
   */
  private localAutoScalingClient: ApplicationAutoScalingClient | undefined;
  private async getLocalAutoScalingClient(): Promise<ApplicationAutoScalingClient> {
    if (this.localAutoScalingClient) return this.localAutoScalingClient;
    const region = (await this.dynamoDBClient.config.region()) ?? '';
    this.localAutoScalingClient = new ApplicationAutoScalingClient({
      ...ambientClientDefaults(),
      region,
    });
    return this.localAutoScalingClient;
  }

  /**
   * Construct the regional table ARN for a cross-region replica of a
   * GlobalTable. AWS replicates the same `TableName` across every
   * replica region, with each replica's ARN differing only in the
   * `:<region>:` segment. Cheaper than a second `DescribeTable` round-
   * trip on the regional client.
   *
   * Example:
   *   local ARN:   arn:aws:dynamodb:us-east-1:123:table/Foo
   *   for eu-west-1 → arn:aws:dynamodb:eu-west-1:123:table/Foo
   *
   * Returns `undefined` when the local ARN is malformed (defensive —
   * downstream callers omit the offending operation rather than throw).
   */
  private replicaArnForRegion(localTableArn: string, targetRegion: string): string | undefined {
    const segments = localTableArn.split(':');
    if (segments.length < 6) return undefined;
    segments[3] = targetRegion;
    return segments.join(':');
  }

  /**
   * The masked sinks ONE `create()` / `update()` logs through (issue #2177,
   * `.claude/rules/provider-masking.md`): `createMaskedLogSinks` over the
   * context's masker, extended by `withDerivedNameMasks` with `pairs` — each
   * `[template value, name derived from it]`. The physical id IS the table
   * name, and every auto-scaling resource id, policy name, ARN and pasteable
   * command embeds it, so a secret-derived `TableName` is masked wherever it
   * occurs: below the base masker's substring floor too, and on update when
   * only the PREVIOUS side recorded it (a rotated secret's `{{resolve:`
   * reference). Built per call; never cached on the provider, which serves
   * concurrent resources.
   */
  private operationSinks(
    context: CreateContext | UpdateContext | undefined,
    pairs: ReadonlyArray<readonly [raw: unknown, name: string | undefined]>
  ): MaskedLogSinks {
    return withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      pairs
    );
  }

  /**
   * Wrap a caught failure, masked through `log`. A provider-local factory so
   * the update-wrap coverage scanner sees the `ProvisioningError` it returns.
   * A catch that only ever sees a cdkd-authored refusal builds its own
   * `ProvisioningError` instead; a catch-all that can see both (the deletes,
   * whose try also runs cdkd's own waits) passes a cdkd-authored error
   * through the masked pass-through below.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug`, masked both raw
   * and as the finished line. The wrap is stamped `markRedactedCause`, so
   * retry classification reads the withheld text on the `cause` chain. An
   * "already exists" and an index-busy refusal are restated
   * ({@link relayedNameCollision}, {@link relayedIndexBusyDelete}); the first
   * is not, when a post-CreateTable call raised it ({@link isAuxiliaryFailure}).
   * A cdkd-authored or transport error keeps the masked pass-through of the
   * shared `wrapMaskedAwsError`, which stamps when the mask changed the text
   * (the #4244 class); a non-`Error` throw is withheld like an AWS one,
   * unstamped (it has no chain).
   * The delete checks `ResourceNotFoundException` by type before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapMaskedError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError,
    // go-to-k/cdkd#2762: how the index-busy relay names the index on a table
    // with vector indexes; omitted, {@link relayedIndexBusyDelete}'s default.
    indexNoun?: string
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(log.mask, error, build);
    log.debug(build(log.mask(failure.detail)).message);
    // Not restated when a post-create call raised it (#3826): "it" would read
    // as this resource.
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(
      `${log.mask(failure.summary)}${relay}${relayedIndexBusyDelete(failure.detail, indexNoun)}` +
        relayedEncryptionChangeLimit(failure.detail)
    );
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * The failure text a partial-create cleanup `warn` quotes after `head`, with
   * its closing period (go-to-k/cdkd#2319). An AWS-authored failure is named
   * by its CLASS at warn, since a denied `DeleteTable` names the caller's
   * assumed-role ARN; AWS's own text goes to `debug` under the same `head`,
   * masked. A cdkd-authored or transport error keeps its text, masked.
   */
  private cleanupFailureText(log: MaskedLogSinks, head: string, error: unknown): string {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return `${log.mask(failure.detail)}.`;
    log.debug(`${head}${log.mask(failure.detail)}`);
    return log.mask(failure.summary);
  }

  /**
   * {@link wrapMaskedError} for a delete catch. The wrap names an AWS failure
   * by its CLASS, and the delete classifiers read `NotFound` in a message as
   * "already deleted": a class naming ANOTHER object's not-found (this
   * resource's own not-found returned before the wrap) is marked
   * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
   */
  private wrapDeleteError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError,
    indexNoun?: string
  ): ProvisioningError {
    const thrown = this.wrapMaskedError(log, error, build, indexNoun);
    return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }

  /**
   * Create a DynamoDB Global Table (CDK TableV2).
   *
   * GlobalTable is built on the regular DynamoDB Table primitive: cdkd issues
   * `CreateTableCommand` first (which only creates the table in the local
   * region), waits for `ACTIVE`, then issues one `UpdateTableCommand` per
   * additional replica region via `ReplicaUpdates: [{ Create: {...} }]`.
   *
   * Streams must be enabled with `NEW_AND_OLD_IMAGES` when the table has any
   * cross-region replicas — AWS rejects the replica-add otherwise. cdkd
   * auto-enables them with an info log when the template omits it.
   *
   * Partial-create cleanup (PR #374-class): if any post-`CreateTableCommand`
   * wiring (wait ACTIVE → replica adds → TTL → Tags) throws, cdkd issues a
   * best-effort `DeleteTableCommand` so AWS is not left holding a billing
   * orphan with no cdkd state record. Cleanup failures escalate to WARN
   * with the exact `aws dynamodb delete-table --table-name <id>` recovery
   * command.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // The caller's secret masker (issue #1932 item 3, adopted here by issue
    // #1997), extended by the table-name needle (issue #2177). Read
    // defensively — `create()` is also called by the import path, by the
    // rollback executor's reverse-replacement arm, and by tests, so it must not
    // care which caller it got. Every line below goes through `log`.
    const log = this.operationSinks(context, [
      [properties['TableName'], properties['TableName'] as string | undefined],
    ]);
    const maskSecrets: SecretMasker = log.mask;
    const warn = log.warn;
    log.debug(`Creating DynamoDB GlobalTable ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed `Replicas[].Tags` is refused before any call.
    const desiredReplicaTags = refuseMalformedReplicaTags(properties, resourceType, logicalId);
    // go-to-k/cdkd#5570: a `Replicas[].DisassociationProtectionEnabled` that is
    // not a boolean is refused before any call; a state replay warns and
    // leaves that replica's protection as AWS has it.
    const disassociationRefusal = disassociationProtectionRefusal(properties, undefined, logicalId);
    if (disassociationRefusal !== undefined) {
      if (context?.replayingState !== true) {
        throw new ProvisioningError(log.mask(disassociationRefusal), resourceType, logicalId);
      }
      warn(`${disassociationRefusal} Proceeding: this create replays a cdkd state record.`);
    }

    const tableName =
      (properties['TableName'] as string | undefined) ||
      generatedNameFor('AWS::DynamoDB::GlobalTable', logicalId);
    const keySchema = properties['KeySchema'] as KeySchemaElement[] | undefined;
    const attributeDefinitions = properties['AttributeDefinitions'] as
      | AttributeDefinition[]
      | undefined;

    if (!keySchema) {
      throw new ProvisioningError(
        `KeySchema is required for DynamoDB GlobalTable ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!attributeDefinitions) {
      throw new ProvisioningError(
        `AttributeDefinitions is required for DynamoDB GlobalTable ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // GlobalTable defaults to PAY_PER_REQUEST in CDK; respect explicit override.
    //
    // Guarded per issue #1513 — the last top-level `?? 'default'` site that
    // issue left open, because this file was owned by a parallel lane when the
    // rest shipped. `BillingMode` is ENUM-valued, so it does NOT take
    // `coerceNumber`: a number here is a template bug, not the unquoted-YAML
    // scalar CFn coerces. And the default it silently substitutes is the
    // consequential one — a `BillingMode: null` (or an intrinsic the resolver
    // could not resolve) on a template that says PROVISIONED would create an
    // ON-DEMAND table, with every `ProvisionedThroughput` block below dropped
    // by the billing gate and only a diagnostic to show for it.
    //
    // Wrapped the same way the `StreamSpecification` guard below is: the read
    // sits OUTSIDE `create()`'s try, so an unwrapped throw would escape untyped
    // into the deploy engine's retry loop.
    //
    // When the replay downgrade DOES fire, the substituted mode is what goes on
    // the wire, so it is what state must record (issue #1683, the #1653 sibling
    // for this arm): the table really is created PAY_PER_REQUEST, and recording
    // the malformed declared value instead leaves permanent phantom drift no
    // `--revert` can clear. Composed onto `replayWarn`'s own callback rather
    // than replacing it, and only when that callback EXISTS, so a template-path
    // create keeps refusing — the single-call-site exception `.claude/rules/
    // providers.md` licenses for a read of KNOWN warn-and-DEFAULT class.
    let billingMode: string;
    let billingModeSubstituted = false;
    let billingModeAbsentOnReplay = false;
    try {
      const billingReplayWarn = replayWarn(log, context).onUnusable;
      billingMode = requireConfigString(
        properties['BillingMode'],
        'PAY_PER_REQUEST',
        'AWS::DynamoDB::GlobalTable BillingMode',
        billingReplayWarn
          ? {
              onUnusable: (message) => {
                billingModeSubstituted = true;
                billingReplayWarn(message);
              },
            }
          : {}
      );
      // An ABSENT value is not malformed, so neither the refusal nor
      // `replayWarn` fires and PAY_PER_REQUEST applies silently. On a REPLAY
      // that absence can be one this provider's own update-path arm produced —
      // it DROPS the key when the record had none rather than inventing one —
      // so announce it, per `.claude/rules/providers.md`: a drop is only honest
      // while something still says so. `LambdaUrlProvider.create` carries the
      // same announcement for the same reason. A template-path create with a
      // legitimately absent `BillingMode` stays silent, since there the default
      // IS the declared intent.
      //
      // This is noisier than the Lambda URL precedent and that is accepted, not
      // overlooked: there the silent default is a PUBLIC function URL, here it
      // is `PAY_PER_REQUEST`, which is also CDK's own default — so most replays
      // this fires on are benign. It stays a warn because the alternative is a
      // drop nothing announces, and the one case it is NOT benign (a record
      // that lost the key while AWS holds PROVISIONED — issue #1733) is
      // invisible from here.
      if (billingReplayWarn && properties['BillingMode'] === undefined) {
        // The create resolves to PAY_PER_REQUEST here too, so the SAME capacity
        // blocks go unsent as in the substitute arm below (issue #1726 review).
        // Only the STRIP is shared: this arm deliberately does NOT record a
        // `BillingMode`, because whether an absent recorded mode may be
        // materialized is issue #1733's question, not this one's.
        billingModeAbsentOnReplay = true;
        warn(
          `AWS::DynamoDB::GlobalTable ${logicalId}: the state record declares no BillingMode, ` +
            `so this replay creates the table PAY_PER_REQUEST. If it was PROVISIONED, set the ` +
            `mode in the template and redeploy.`
        );
      }
    } catch (error) {
      // A cdkd-authored refusal: masked, never stamped (`wrapMaskedAwsError` is
      // for relayed AWS text only).
      throw new ProvisioningError(
        log.mask(describeAwsFailure(error).detail),
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }

    const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';
    const replicas = (properties['Replicas'] as Array<Record<string, unknown>> | undefined) ?? [];

    const createParams: CreateTableCommandInput = {
      TableName: tableName,
      KeySchema: keySchema,
      AttributeDefinitions: attributeDefinitions,
      BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
    };

    // The DESIRED side, so it collects diagnostics (issues #1428 / #1444 A /
    // #1511). Declared before the first translation below — every one of them
    // pushes into it, and they are all emitted BEFORE `CreateTable` (a
    // translation complaint must never arrive after a real table exists).
    const diagnostics: ThroughputDiagnostic[] = [];

    // ProvisionedThroughput: GlobalTable's CFn shape uses
    // `WriteProvisionedThroughputSettings` for write capacity and a
    // per-replica `ReadProvisionedThroughputSettings` for read capacity.
    // The base CreateTable call needs `ProvisionedThroughput` when
    // BillingMode=PROVISIONED. We pull WriteCapacityUnits from
    // `WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings`
    // when present, else default to 5/5. Read capacity is per-replica;
    // we use the deploy-region replica's setting when available.
    if (billingMode === 'PROVISIONED') {
      createParams.ProvisionedThroughput = derivePerCallProvisionedThroughput(
        properties,
        currentRegion,
        'min',
        diagnostics,
        maskSecrets
      );
    }

    // issue #1653: the bag actually delivered, when the replay downgrade above
    // or below substituted a value for a malformed declared one. `undefined`
    // (the normal case) means "record the desired properties".
    //
    // Two arms can fire in ONE create (a single state record carrying two
    // malformed values), so the LATER one composes onto whatever the earlier
    // recorded (`?? properties`) — that composition is live, not decorative,
    // and a unit test fences it (issue #1683). The FIRST arm assigns directly
    // because there is nothing yet to compose onto.
    //
    // The `needsStream` auto-enable further down is a third, and composes the
    // same way (issue #1723).
    let effectiveProperties: Record<string, unknown> | undefined;

    if (billingModeSubstituted) {
      // The twin question, re-asked here because this arm SUBSTITUTES rather
      // than skips and `.claude/rules/providers.md` requires it at every
      // substitute site: no `canonicalizeDesiredProperties` is needed.
      // `BillingMode` is not create-only, so the next deploy's diff sees a
      // changed value, classifies an ordinary in-place UPDATE, and the update
      // path's own guard answers it — no replacement is derived and nothing is
      // removed. Canonicalizing the desired side would instead make cdkd agree
      // with a malformed template forever.
      //
      // The substitution drops MORE than one key from the wire (issue #1726).
      // Sending PAY_PER_REQUEST also makes this create skip
      // `createParams.ProvisionedThroughput`, hand the SUBSTITUTED mode to
      // `toSdkGlobalSecondaryIndexes` (so every PROVISIONED-only per-index
      // member is dropped before `CreateTable`), and skip auto-scaling
      // registration. Recording the desired capacity blocks alongside the
      // substituted mode would leave the same permanent phantom drift this arm
      // exists to remove, one key over — so they are STRIPPED here.
      //
      // Which keys are safe to strip is answered by what `readCurrentState`
      // emits for a PAY_PER_REQUEST GlobalTable, per member, and every one of
      // those emissions is type-discriminator-gated on
      // `billingMode === 'PROVISIONED'` further down this file: the top-level
      // `WriteProvisionedThroughputSettings` emits `{}`, and the per-replica /
      // per-index / per-replica-index blocks are omitted entirely. So the
      // PROVISIONED-only set is exactly what `stripProvisionedCapacityKeys`
      // removes. The on-demand ceilings are deliberately NOT stripped: they go
      // on the wire under this very mode (`OnDemandThroughput` is attached when
      // `billingMode !== 'PROVISIONED'`), so what was SENT still describes them.
      //
      // No `canonicalizeDesiredProperties` twin is needed, and the reason is
      // the arm's own: this bag ALREADY records a `BillingMode` differing from
      // the malformed declared one, so the next deploy's diff ALREADY
      // classifies an in-place UPDATE (see the paragraph above). Stripping the
      // capacity keys folds into that same UPDATE rather than manufacturing a
      // new one, and once the template's mode is corrected the update path
      // re-sends the capacity settings normally. A twin would instead make cdkd
      // agree with a malformed template forever.
      effectiveProperties = stripProvisionedCapacityKeys({
        ...properties,
        BillingMode: billingMode,
      });
    } else if (billingModeAbsentOnReplay) {
      // The absent-mode replay sibling: same unsent capacity, same strip, but
      // the bag keeps whatever `BillingMode` the record had (i.e. none). See
      // the flag's own comment and issue #1733.
      effectiveProperties = stripProvisionedCapacityKeys(properties);
    }

    // Stream specification. GlobalTable cross-region replication requires
    // streams with NEW_AND_OLD_IMAGES. CDK synth always emits
    // `StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' }`
    // (verified via real `cdk synth` 2026-05-16); cdkd defensively forces
    // streams on when the template has more than one replica or any
    // non-local replica, even if the template was hand-authored without.
    const streamSpecInput = properties['StreamSpecification'] as
      | Record<string, unknown>
      | undefined;
    const hasNonLocalReplica = replicas.some((r) => r['Region'] !== currentRegion);
    const needsStream = hasNonLocalReplica || replicas.length > 1;
    // `!= null` rather than a truthiness gate: `StreamSpecification: ''` is
    // exactly the malformed shape `readConfigString` exists to refuse, and a
    // falsy gate would skip the guard and silently fall through to the
    // auto-enable arm below (.claude/rules/providers.md, "cover the CREATE
    // path"). `create()` has no wrapping catch around this point, so the
    // helper's plain Error is converted here rather than escaping untyped
    // into the deploy engine's retry loop -- same treatment as the GSI
    // translation below.
    if (streamSpecInput != null) {
      let streamViewType: string;
      // issue #1653 (create-path sibling): a SUBSTITUTED value is the same
      // class as a dropped key (.claude/rules/providers.md, #1633) — under the
      // replay downgrade the deploy SUCCEEDS while the engine records the
      // MALFORMED desired block, so `readCurrentState` can never match it and
      // the difference is permanent phantom drift.
      //
      // This arm is NOT the "replay-CREATE -> DROP the key" case the #1612
      // carve-out describes: that answer is scoped to a SKIP, where nothing
      // reached AWS. Here the downgrade SUBSTITUTES the default and the block
      // IS applied — a stream really is created — so the rule that binds is
      // "what you return is what you SENT", and dropping the key would record
      // that cdkd sent nothing. The recorded shape is the CFn one
      // (`StreamViewType` only — `AWS::DynamoDB::GlobalTable`'s
      // `StreamSpecification` declares no `StreamEnabled`, verified against
      // aws-cdk-lib's `convertCfnGlobalTableStreamSpecificationPropertyToCloudFormation`),
      // so the effective bag is indistinguishable from what an ordinary
      // template-path create of the same table records.
      //
      // LIVE. `streamSpecSubstituted` can only be set when
      // `context.replayingState` is true, and the sole caller that sets that
      // flag is `rollback-executor/replay-reverse-replacement.ts`'s reverse-replacement arm — which
      // HONOURS `effectiveProperties` as of issue #1682 (PR #1696): the bag
      // handed to `create()` IS `previousState.properties`, so what this arm
      // returns replaces the record's `properties` wholesale. Before that the
      // arm rebuilt the record from `prev.properties` and every provider's
      // replay-CREATE substitution was announced into a void.
      //
      // Live-tested by `tests/integration/rollback-replay-effective-props`
      // (`StreamTable`, issue #1706): it pins the recorded CFn shape
      // `{ StreamViewType }` and a clean diff against the live table.
      let streamSpecSubstituted = false;
      try {
        // `replayWarn` (issue #1544): a state record written by an older
        // binary can carry `StreamSpecification: ''`, and on the rollback
        // executor's reverse-replacement replay the user cannot edit that
        // record — a hard refusal would leave the old table unrestorable. The
        // downgrade treats the malformed block as `{}` (stream enabled with
        // the NEW_AND_OLD_IMAGES default, exactly what an empty block means),
        // warns, and proceeds; template-path creates keep the refusal.
        // The wrapper preserves `replayWarn`'s gate exactly: with no replay
        // downgrade in effect the options bag stays EMPTY, so a template-path
        // create keeps the hard refusal rather than silently gaining one.
        //
        // "Do not infer the skip by wrapping `onUnusable`" (#1612) does not
        // bind here: that rule guards a callback SHARED by SKIP-class guards
        // and warn-and-DEFAULT reads, where a generic wrapper cannot tell the
        // two apart and would record a defaulted-but-APPLIED value as skipped.
        // This is one call site of known class — a `readConfigString`
        // warn-and-DEFAULT — and what it records is precisely the DEFAULT that
        // was applied, which is the outcome that rule wants.
        const replayDowngrade = replayWarn(log, context).onUnusable;
        streamViewType = readConfigString(
          streamSpecInput,
          'StreamViewType',
          'NEW_AND_OLD_IMAGES',
          'AWS::DynamoDB::GlobalTable StreamSpecification',
          replayDowngrade
            ? {
                onUnusable: (message) => {
                  streamSpecSubstituted = true;
                  replayDowngrade(message);
                },
              }
            : {}
        );
      } catch (error) {
        // A cdkd-authored refusal: masked, never stamped (`wrapMaskedAwsError`
        // is for relayed AWS text only).
        throw new ProvisioningError(
          log.mask(describeAwsFailure(error).detail),
          resourceType,
          logicalId,
          undefined,
          error instanceof Error ? error : undefined
        );
      }
      createParams.StreamSpecification = {
        StreamEnabled: true,
        StreamViewType: streamViewType,
      } as StreamSpecification;
      if (streamSpecSubstituted) {
        effectiveProperties = {
          ...(effectiveProperties ?? properties),
          StreamSpecification: { StreamViewType: streamViewType },
        };
      }
    } else if (needsStream) {
      // cdkd deliberately sends MORE than the template asked for: cross-region
      // replication requires a stream, so one is enabled even where the
      // template declares no `StreamSpecification` at all — the "arms that do
      // NOT log a refusal" case.
      //
      // Issue #1723: recorded, paired with the `canonicalizeDesiredProperties`
      // twin through the one shared predicate, so an unchanged template still
      // diffs NO_CHANGE. Not for phantom drift — there is none either way, the
      // drift walk descending only into keys a record has — but because a
      // record without the stream reads a template that LATER declares the
      // same `{ StreamViewType: NEW_AND_OLD_IMAGES }` as a change, and
      // `update()` then asks AWS to enable a stream the table already has.
      // Only the region-independent half is recorded; see the helper.
      const impliedStream = replicationImpliedStreamSpecification(properties);
      if (impliedStream) {
        effectiveProperties = {
          ...(effectiveProperties ?? properties),
          [STREAM_SPECIFICATION_KEY]: impliedStream,
        };
      }
      this.logger.info(
        log.mask(
          `Auto-enabling streams (NEW_AND_OLD_IMAGES) on ${logicalId} — required for cross-region replication`
        )
      );
      createParams.StreamSpecification = {
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      } as StreamSpecification;
    }

    // GSIs: the CFn GlobalTable GSI shape models throughput differently
    // from the SDK's `GlobalSecondaryIndex` (Issue #1387) — translate
    // rather than cast. Pre-fix a PROVISIONED GlobalTable with a GSI
    // failed `CreateTable` outright (AWS requires per-GSI
    // `ProvisionedThroughput`) and per-GSI on-demand limits were dropped.
    // Called UNCONDITIONALLY (it returns [] for an absent value): a truthiness
    // gate here would let `null` / `''` / `0` skip the helper's non-array guard
    // and deploy a zero-GSI table — the very case that guard exists for.
    // `create()` has no wrapping catch around this point, so the helper's plain
    // Error is converted to a ProvisioningError here rather than escaping
    // untyped into the deploy engine's retry loop.
    let sdkIndexes: GlobalSecondaryIndex[];
    let indexesOmitted = false;
    try {
      // The trailing `onUnusableIndexes` hook is the GSI guard's replay
      // downgrade (issue #1544): on a reverse-replacement replay a non-array
      // `GlobalSecondaryIndexes` recorded in state warns and the block is
      // OMITTED (zero indexes) instead of stranding the rollback; on a
      // template-path create the hook is `undefined` and the refusal stands.
      //
      // This arm DROPS the key from the effective bag (issue #1724), which is
      // the replay-CREATE+SKIP answer `.claude/rules/providers.md` prescribes:
      // the helper returns the well-defined EMPTY list, so `CreateTable` goes
      // out with NO indexes and nothing was applied — there is no value to
      // vouch for. It is deliberately NOT the SUBSTITUTE shape its two
      // siblings above take: those APPLY a default (a stream really is
      // created, the table really is PAY_PER_REQUEST), so what they record is
      // what they sent, whereas recording the malformed blob here would claim
      // indexes AWS does not hold — a record `readCurrentState` can never
      // match, which the NEXT update then reads as its previous side (the
      // #1552 class). Which arm you are on is a property of the GUARD, not of
      // the path: ask whether the call went out.
      const onUnusableCreateIndexes = replayWarn(log, context).onUnusable;
      sdkIndexes = toSdkGlobalSecondaryIndexes(
        properties,
        currentRegion,
        billingMode,
        'min',
        diagnostics,
        onUnusableCreateIndexes &&
          ((message) => {
            indexesOmitted = true;
            onUnusableCreateIndexes(
              `${message} Omitting the malformed block, so this create carries NO ` +
                `indexes; the same value is REFUSED on a template-path create`
            );
          }),
        maskSecrets
      );
    } catch (error) {
      // A cdkd-authored refusal: masked, never stamped (`wrapMaskedAwsError` is
      // for relayed AWS text only).
      throw new ProvisioningError(
        log.mask(describeAwsFailure(error).detail),
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
    // What the post-`CreateTable` wiring reads the replicas from. It differs
    // from `properties` only on the omit arm below, and it is ONE value so the
    // three consumers of a replica's index block — the pre-flight scan,
    // `addReplica`, and the autoscaling registration — cannot disagree about
    // whether that block still exists.
    let wiringProperties: Record<string, unknown> = properties;
    if (indexesOmitted) {
      // Composed onto whatever the earlier arms recorded (`?? properties`) —
      // a single state record can carry more than one malformed value, and
      // this is the LAST of the three arms.
      //
      // The top-level key is dropped, matching what was actually skipped.
      effectiveProperties = { ...(effectiveProperties ?? properties) };
      delete effectiveProperties['GlobalSecondaryIndexes'];
      // ...and EVERY replica's index block, local and cross-region alike
      // (issue #1741, second instance). Each one names indexes of THIS table,
      // and this create builds none, so none of them can be applied:
      //
      //  - the LOCAL block is only a CAPACITY SOURCE that
      //    `toSdkGlobalSecondaryIndexes` reads through `localByName`, and that
      //    call returned the EMPTY list;
      //  - a CROSS-REGION block has its own send path (`addReplica`, after
      //    `CreateTable`), but it is an OVERRIDE of an index the replica
      //    inherits from the source table, and there is no such index. Before
      //    this it was kept, sent AND recorded. Measured live on an on-demand
      //    read ceiling: AWS accepted the replica-add and the re-created
      //    replica held no override, so the record claimed a value AWS never
      //    applied. Live coverage: the opt-in cross-region arm of
      //    `tests/integration/rollback-replay-effective-props`.
      //
      // So the omit prunes everything downstream that referenced the indexes —
      // the same shape as the `AttributeDefinitions` prune below — on the WIRE
      // (`wiringProperties`) and in the RECORD alike. The RECORD half is the
      // one with a user-visible consequence: `readCurrentState` attaches a
      // replica's index block only when the live table has indexes, so on a
      // zero-index table a retained block is a never-matchable record, which
      // the next update reads as its previous side (the #1724 class). The WIRE
      // half keeps the two in agreement — the record describes what was sent —
      // and stops a request naming an index that does not exist.
      //
      // The block is withdrawn from each bag SEPARATELY: the record composes
      // onto the earlier arms' answer (the billing strip may already have
      // rewritten `Replicas`), while the wire reads the replay's own bag.
      const recorded = withdrawReplicaIndexBlocks(effectiveProperties['Replicas']);
      if (recorded.changed) effectiveProperties['Replicas'] = recorded.replicas;
      const wired = withdrawReplicaIndexBlocks(properties['Replicas']);
      if (wired.changed) {
        wiringProperties = { ...properties, Replicas: wired.replicas };
        // Announced from HERE rather than folded into the omit warning above:
        // that one fires from the GSI guard, which never reads a replica's
        // block, and a withdrawn cross-region override is a separate loss the
        // user would otherwise have no way to see. The local block needs no
        // line of its own — it only ever fed the translation that warning
        // already reports as empty.
        const crossRegion = wired.withdrawnRegions.filter((region) => region !== currentRegion);
        if (crossRegion.length > 0) {
          warn(
            `DynamoDB GlobalTable ${logicalId}: omitting the GlobalSecondaryIndexes ` +
              `overrides of replica(s) ${crossRegion.join(', ')}: they name indexes this ` +
              `create does not build, so there is nothing for them to apply to`
          );
        }
      }
      // ...and PRUNE `AttributeDefinitions` down to the attributes this call
      // still keys on (issue #1741). DynamoDB requires the definitions to be
      // EXACTLY the attributes referenced by `KeySchema` and by the indexes
      // being created, so omitting the indexes while sending their key
      // attributes leaves an orphan and AWS rejects the WHOLE call:
      //
      //   ValidationException: One or more parameter values were invalid: Some
      //   AttributeDefinitions are not used. AttributeDefinitions: [pk, gsipk],
      //   KeySchema: [pk]
      //
      // That is the ordinary shape — an index keyed on its own attribute — so
      // before this the downgrade FAILED on exactly the population it exists
      // for: a reverse-replacement rollback of a table whose state record an
      // older binary wrote badly did not re-create the table at all, and the
      // refusal it replaced at least failed before touching AWS.
      //
      // LSI key attributes MUST survive: `LocalSecondaryIndexes` is create-only
      // and is NOT omitted by this arm (it is sent from `properties` a few
      // lines below), so a naive "keep only the table KeySchema" would break a
      // table with an LSI — which is why the scope is passed explicitly rather
      // than defaulted.
      const keptKeyAttributes = collectDesiredKeyAttributeNames(properties, {
        indexListKeys: ['LocalSecondaryIndexes'],
      });
      // Fail OPEN on an unreadable key schema OR a non-array definitions bag.
      // An empty set means no key schema resolved to a name at all (an
      // intrinsic-valued `KeySchema`, a malformed block), and pruning against
      // it would strip EVERY definition and turn a template defect into a
      // different, more confusing AWS error. Leaving the definitions alone is
      // the pre-fix behavior, and AWS still rejects the genuinely-bad call
      // loudly.
      //
      // The `Array.isArray` half is not defensive padding: `attributeDefinitions`
      // is a bare cast guarded only by a truthiness test above, so a state
      // record carrying `{}` / a string / an unresolved intrinsic reaches here
      // — and this is the REPLAY path, where a malformed record IS the premise.
      // `.filter` on a non-array throws a raw `TypeError` outside any `try`,
      // which would escape untyped into the deploy engine instead of the
      // `ValidationException` AWS returns today.
      if (keptKeyAttributes.size > 0 && Array.isArray(attributeDefinitions)) {
        const prunedAttributeDefinitions = attributeDefinitions.filter((definition) => {
          const name = asRecord(definition)?.['AttributeName'];
          // An UNPARSEABLE entry is KEPT, not pruned. Only a definition whose
          // `AttributeName` cdkd can actually read is knowably orphaned;
          // dropping one it could not parse would be a silent loss decided on
          // the strength of a value that was never read — the class the
          // config-shape guards exist to refuse — and it would do so on the
          // replay path, where malformed records are the premise. Keeping it
          // reproduces the pre-fix behavior for that entry: AWS rejects the
          // call loudly and names the field.
          if (typeof name !== 'string') return true;
          return keptKeyAttributes.has(name);
        });
        if (prunedAttributeDefinitions.length !== attributeDefinitions.length) {
          createParams.AttributeDefinitions = prunedAttributeDefinitions;
          // Recorded for the same reason the index key itself is dropped: an
          // attribute definition that was not SENT is the phantom-drift class
          // (#1724), so the effective bag has to describe the pruned list.
          //
          // NO `canonicalizeDesiredProperties` twin, and the question is asked
          // here rather than inherited (the `.claude/rules/providers.md` rule
          // is to re-ask it at every recording site). The twin exists because a
          // narrowed record makes the next diff read the difference as a
          // user-made ADD, and for a CREATE-ONLY property that classifies as a
          // REPLACEMENT. Neither holds: `AWS::DynamoDB::GlobalTable` has no
          // `ReplacementRulesRegistry` entry and its schema's
          // `createOnlyProperties` is `TableName` alone, so the un-canonicalized
          // diff derives an IN-PLACE update — and that update genuinely
          // converges, because `update()` re-adds the definitions a restored
          // index needs. Canonicalizing instead would fold the template side
          // onto the pruned list and leave the re-created table permanently
          // missing the indexes the record was malformed about, which is the
          // opposite of the recovery this arm exists to enable.
          // A distinct array from the one on `createParams`, so a later mutation
          // of either cannot reach the other (the rollback executor spreads the
          // effective bag shallowly). Scoped to the PRUNED path deliberately:
          // on the untouched path both sides still alias the caller's
          // `properties['AttributeDefinitions']`, exactly as before this change.
          effectiveProperties['AttributeDefinitions'] = [...prunedAttributeDefinitions];
        }
      }
    }
    if (sdkIndexes.length > 0) {
      createParams.GlobalSecondaryIndexes = sdkIndexes;
    }
    if (properties['LocalSecondaryIndexes']) {
      createParams.LocalSecondaryIndexes = properties[
        'LocalSecondaryIndexes'
      ] as LocalSecondaryIndex[];
    }
    // go-to-k/cdkd#2762: vector indexes ride `CreateTable` (member names shared
    // with CFn, `Dimensions` on the Integer grammar). Every replica added below
    // inherits them (measured, us-east-1 + us-east-2, 2026-11-01).
    const createVectorIndexes = vectorIndexesForCreate(properties['VectorIndexes']);
    if (createVectorIndexes !== undefined) createParams.VectorIndexes = createVectorIndexes;
    // go-to-k/cdkd#2762: the table's warm throughput rides `CreateTable` too, on
    // either billing mode. An unusable block is reported below and not sent.
    const warmCoercion = coerceWarmThroughput(properties['WarmThroughput']);
    if (warmCoercion.spec) createParams.WarmThroughput = warmCoercion.spec;
    const warmDiagnostic = warmThroughputDiagnostic(
      properties['WarmThroughput'],
      warmCoercion,
      undefined
    );
    if (warmDiagnostic) diagnostics.push(warmDiagnostic);
    // go-to-k/cdkd#5489: the settings replication mode rides `CreateTable`, as
    // CloudFormation sends it; a mode on a table with more than one replica is
    // refused below (`replicaSettingsRefusal`) before anything is created.
    const createMode = readReplicationMode(properties);
    if (createMode.kind === 'usable') {
      createParams.GlobalTableSettingsReplicationMode =
        createMode.mode as GlobalTableSettingsReplicationMode;
    }

    // SSE: GlobalTable's CFn shape is { SSEEnabled, SSEType } with NO
    // top-level KMSMasterKeyId — the key is per-replica, so the LOCAL table's
    // comes from its own `Replicas[?Region==<deploy region>]` entry
    // (go-to-k/cdkd#5355; before it, a CMK table was created under the AWS
    // managed key).
    // An `SSEEnabled` that is not a boolean is refused rather than read: the
    // fallback below would ENABLE encryption for it. A replay of a state
    // record (which the user cannot edit) warns and takes that fallback.
    const sseEnabledRefusal = configBooleanRefusal(
      properties['SSESpecification'],
      'SSEEnabled',
      'AWS::DynamoDB::GlobalTable SSESpecification'
    );
    if (sseEnabledRefusal !== undefined) {
      const onReplay = replayWarn(log, context).onUnusable;
      if (!onReplay) {
        throw new ProvisioningError(
          log.mask(
            `AWS::DynamoDB::GlobalTable ${logicalId}: ${sseEnabledRefusal}. Nothing was created; ` +
              `fix the template value`
          ),
          resourceType,
          logicalId
        );
      }
      onReplay(`${sseEnabledRefusal}. Encryption is enabled, the block's default.`);
    }
    // go-to-k/cdkd#5365: the per-replica settings the wiring below sends, read
    // by the write plan's own readers, refused before anything is created. A
    // replay of a state record (which the user cannot edit) skips an
    // unreadable block with a warning instead, and tries a policy anyway.
    const replicaSettingRefusal = replicaSettingsRefusal(properties, undefined, currentRegion);
    if (replicaSettingRefusal !== undefined && !replayWarn(log, context).onUnusable) {
      throw new ProvisioningError(
        log.mask(
          `AWS::DynamoDB::GlobalTable ${logicalId}: ${replicaSettingRefusal}. Nothing was ` +
            `created; fix the template value`
        ),
        resourceType,
        logicalId
      );
    }
    if (properties['SSESpecification']) {
      createParams.SSESpecification = toSdkTableSseSpecification(
        properties['SSESpecification'],
        readReplicaKmsMasterKeyId(localReplicaEntry(properties, currentRegion))
      );
    }

    // DeletionProtectionEnabled is per-replica in the CFn schema for
    // `AWS::DynamoDB::GlobalTable` (just like Tags). CDK 2.x's
    // `deletionProtection: true` synthesizes to
    // `Replicas[?Region==<deploy region>].DeletionProtectionEnabled`.
    // Extract via the shared module-level helper.
    const dpeResolved = extractLocalDeletionProtection(properties, currentRegion);
    if (dpeResolved !== undefined) {
      createParams.DeletionProtectionEnabled = dpeResolved;
    }
    // Per-replica in the CFn schema too (`Replicas[].TableClass`, where CDK's
    // `tableClass` renders) — go-to-k/cdkd#5355.
    const localTableClass = extractLocalTableClass(properties, currentRegion);
    if (localTableClass !== undefined) {
      createParams.TableClass = localTableClass;
    }

    // Table-level on-demand ceilings. CDK's `Billing.onDemand({ maxRead…,
    // maxWrite… })` splits the pair across two CFn locations — the write half
    // at top-level `WriteOnDemandThroughputSettings`, the read half on the
    // LOCAL replica's `ReadOnDemandThroughputSettings` — and only the write
    // half was ever wired, so a user who capped read request units got a table
    // with NO read ceiling and a success report (issue #1436). Both halves go
    // into the SAME `CreateTable` member.
    const createCeilings = collectTableOnDemandCeilings(
      properties,
      currentRegion,
      diagnostics,
      maskSecrets
    );
    const createOnDemand: OnDemandThroughput = {
      ...(createCeilings.read.value !== undefined && {
        MaxReadRequestUnits: createCeilings.read.value,
      }),
      ...(createCeilings.write.value !== undefined && {
        MaxWriteRequestUnits: createCeilings.write.value,
      }),
    };
    if (billingMode !== 'PROVISIONED' && Object.keys(createOnDemand).length > 0) {
      createParams.OnDemandThroughput = createOnDemand;
    }

    // Tags are per-replica in the CFn `AWS::DynamoDB::GlobalTable`
    // schema (there is NO top-level `Properties.Tags` field — CDK's
    // `cdk.Tags.of(tableV2).add(...)` puts them in
    // `Replicas[?Region==<deploy region>].Tags`). For the LOCAL replica
    // we apply them via `CreateTable`'s top-level `Tags` field (avoids
    // a separate `TagResource` round-trip). Cross-region replicas'
    // Tags are propagated AFTER the replicas flip ACTIVE — see the
    // `applyCrossRegionReplicaTagsDiff` loop further down (Issue #441).
    const localReplicaForTags = replicas.find((r) => r['Region'] === currentRegion);
    const localReplicaTags =
      localReplicaForTags !== undefined ? desiredReplicaTags.get(localReplicaForTags) : undefined;
    if (localReplicaTags && localReplicaTags.length > 0) {
      createParams.Tags = localReplicaTags.map((t): Tag => ({ Key: t.Key, Value: t.Value }));
    }

    // Pre-flight the CROSS-REGION replica blocks through the same translators
    // the post-`CreateTable` wiring will use, discarding the result and
    // keeping only the diagnostics. Issue #1428's third rejected design
    // surfaced its complaint from inside that wiring, which meant a
    // statically-detectable garbage value created a real table first — and
    // under `DeletionProtectionEnabled: true` the compensating delete fails,
    // orphaning a billing table with no state record. Reporting is cheap and
    // pure, so it happens BEFORE the first mutating call instead.
    //
    // Both this scan and the replica-add loop below read `wiringReplicas`, so
    // a block the omit arm withdrew is neither reported nor sent.
    const wiringReplicas =
      (wiringProperties['Replicas'] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const replica of wiringReplicas) {
      const replicaRegion = replica['Region'] as string | undefined;
      if (!replicaRegion || replicaRegion === currentRegion) continue;
      toSdkReplicaGlobalSecondaryIndexes(
        replica['GlobalSecondaryIndexes'],
        billingMode,
        diagnostics,
        maskSecrets
      );
      toSdkReplicaThroughputOverrides(replica, billingMode, diagnostics, {}, maskSecrets);
    }
    this.reportThroughputDiagnostics(diagnostics, logicalId, tableName, maskSecrets);

    // go-to-k/cdkd#4606: the `TableId` CreateTable answered with, carried on
    // the created-before-failure mark so the journal needs no read of a table
    // whose failure (a describe that cannot run, say) may fail that read too.
    let createdTableId: string | undefined;
    try {
      const createOut = await (
        await this.getCreateClient()
      ).send(new CreateTableCommand(createParams));
      // An absent or empty id is dropped by `markCreatedBeforeFailure`.
      createdTableId = createOut?.TableDescription?.TableId;
      // go-to-k/cdkd#5511: report before the ACTIVE wait.
      reportCreatedResource(logicalId, resourceType, tableName, createdTableId);
      log.debug(`CreateTable initiated for ${log.value(tableName)}, waiting for ACTIVE`);
    } catch (error) {
      // CreateTable itself failed: no table this create can attribute to
      // itself, so no cleanup. A 5xx may hide a committed one; the engine's
      // retry then reads its collision as possibly replayed (#4639).
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create DynamoDB GlobalTable ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            tableName,
            cause
          )
      );
    }

    // Inner try/catch wraps every post-CreateTable wiring call so a
    // wiring failure issues a best-effort DeleteTable before re-throwing.
    // Without this, an aborted deploy leaves a billing AWS-side table
    // with no cdkd state record (PR #374 pattern).
    try {
      const tableInfo = await this.waitForTableActive(tableName, logicalId, undefined, maskSecrets);
      // go-to-k/cdkd#2762: a vector index created WITH the table may still be
      // building when the table reads ACTIVE; a replica add must not meet it.
      if (createVectorIndexes !== undefined) {
        await this.waitForVectorIndexesSettled(tableName, logicalId, maskSecrets);
      }

      // Replica adds: one UpdateTable per region (AWS rejects multiple
      // ReplicaUpdates in a single call). Each call must complete before
      // the next — UpdateTable returns immediately but the table flips to
      // UPDATING until the replica is provisioned.
      for (const replica of wiringReplicas) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        // No diagnostics collector: the same translation already ran in the
        // pre-flight scan above, so passing one here would warn twice.
        await this.addReplica(
          tableName,
          replica,
          region,
          logicalId,
          billingMode,
          undefined,
          maskSecrets
        );
      }

      // Cross-region replica Tags propagation (Issue #441 — closes the
      // create-side half of Issue #389's scope; the update path already
      // shipped per-region propagation). `CreateTable`'s top-level
      // `Tags` only covers the LOCAL replica; non-local replicas need a
      // separate `TagResource` against the regional client AFTER the
      // replica flips ACTIVE (AWS rejects `TagResource` with
      // `ResourceNotFoundFault` against a still-provisioning replica,
      // which is why this loop sits below the `addReplica` await above
      // — `waitForReplicaActive` is part of `addReplica`). Best-effort
      // per replica: a single region's failure logs at WARN and the
      // deploy continues (mirrors `update()`'s contract). Without
      // this, the first `cdkd drift` against a freshly-created
      // multi-region table reports Tags drift on every cross-region
      // replica.
      for (const replica of replicas) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        const replicaTags = desiredReplicaTags.get(replica);
        if (!replicaTags || replicaTags.length === 0) continue;
        await this.applyCrossRegionReplicaTagsDiff(
          tableInfo.tableArn,
          region,
          undefined, // create() has no previous state — every tag is an add
          replicaTags,
          resourceType,
          logicalId,
          tableName,
          maskSecrets
        );
      }

      // Per-replica point-in-time recovery, Contributor Insights, Kinesis
      // destination and resource policies (go-to-k/cdkd#5365), each through
      // its replica's own region once every replica is ACTIVE. A failure here
      // is a wiring failure: the cleanup below removes the table.
      await this.applyReplicaSettings(
        tableName,
        logicalId,
        currentRegion,
        wiringProperties,
        undefined,
        new Set(),
        false,
        replayWarn(log, context).onUnusable !== undefined,
        new Set(),
        undefined,
        warn,
        maskSecrets
      );

      // go-to-k/cdkd#5570: each replica's declared disassociation protection,
      // a solo UpdateTable in its own region once every replica is settled.
      await this.convergeReplicaDisassociationProtection(
        tableName,
        logicalId,
        currentRegion,
        wiringProperties,
        undefined,
        context?.replayingState === true ? 'replay' : 'template',
        warn,
        maskSecrets
      );

      // TTL is a separate API call (UpdateTimeToLive). Applied after
      // table + replicas are ACTIVE so the AWS-side request validates.
      // A disabled spec sends nothing: a new table starts with TTL disabled,
      // and AWS refuses to disable it again (issue #5447).
      const createTtl = planTimeToLive(properties['TimeToLiveSpecification'], undefined, 'create');
      if (createTtl.kind === 'enable') {
        await this.dynamoDBClient.send(
          new UpdateTimeToLiveCommand({
            TableName: tableName,
            TimeToLiveSpecification: { Enabled: true, AttributeName: createTtl.attributeName },
          })
        );
      }

      // Application-autoscaling registration (Issue #1419). Before this,
      // `create()` registered NOTHING — only `update()` ever called
      // `applyAutoScalingDiff` — so a freshly created PROVISIONED
      // GlobalTable had no scaling policy at all until some later deploy
      // happened to run an update, and per-index settings were dropped even
      // then. Runs after the table AND every replica are ACTIVE:
      // `RegisterScalableTarget` against a still-provisioning table or a
      // not-yet-created index is rejected.
      //
      // Deliberately the LAST wiring step, and deliberately wrapped so it
      // cannot throw. Both are about the partial-create cleanup below: that
      // handler deletes the table (it does NOT route through `delete()`, so
      // it would not deregister anything), and a target registered before a
      // LATER wiring step failed would be orphaned in the
      // application-autoscaling control plane with no table left to name it
      // — the exact leak this issue exists to close, re-introduced on the
      // failure path. Registering last means nothing can fail after it, and
      // warn-instead-of-throw means a best-effort concern can never be what
      // destroys a successfully created table.
      //
      // Skipped on PAY_PER_REQUEST — scalable targets are meaningless
      // without provisioned capacity, and AWS rejects them.
      if (billingMode === 'PROVISIONED') {
        try {
          await this.reconcileAutoScalingTargets(
            tableName,
            [],
            // `wiringProperties`, not `properties`: on the replay omit arm a
            // replica's per-index read target would name an index this create
            // did not build, and the registrations run in sequence, so one
            // that throws skips every target after it.
            collectAutoScalingTargets(wiringProperties, currentRegion),
            currentRegion,
            undefined,
            maskSecrets
          );
        } catch (autoScalingErr) {
          warn(
            `Auto-scaling registration failed for ${tableName}: ` +
              `${describeAwsFailure(autoScalingErr).detail}. ` +
              `The table was created successfully; re-run the deploy to register the ` +
              `scaling targets.`
          );
        }
      }

      log.debug(`Successfully created DynamoDB GlobalTable ${logicalId}: ${log.value(tableName)}`);

      return {
        physicalId: tableName,
        attributes: {
          Arn: tableInfo.tableArn,
          TableId: tableInfo.tableId,
          StreamArn: tableInfo.streamArn,
          TableName: tableName,
        },
        ...(effectiveProperties && { effectiveProperties }),
      };
    } catch (wiringError) {
      // Partial-create cleanup. The table exists on AWS; delete it
      // before re-throwing so the user is not billed for a phantom
      // resource. Cleanup-step failures escalate to WARN with a recovery
      // command; the original error always propagates.
      //
      // IMPORTANT: if any non-local replicas were added before the
      // failure (replica-add loop is serial and partially-progressed
      // failures DO happen), AWS rejects `DeleteTable` on a
      // multi-replica table. We must drop the additional replicas
      // first — mirror the `delete()` shape: DescribeTable → per-region
      // Delete ReplicaUpdates → DeleteTable. Each step is best-effort
      // so a single sub-failure does not block the rest of the cleanup.
      warn(`Wiring failed after CreateTable for ${tableName}; attempting best-effort cleanup`);
      let tableLeftBehind = false;
      try {
        const describe = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const replicasForCleanup = describe.Table?.Replicas ?? [];
        for (const replica of replicasForCleanup) {
          const region = replica.RegionName;
          if (!region || region === currentRegion) continue;
          try {
            // A replica `addReplica` protected (go-to-k/cdkd#5355) refuses
            // the drop below. This create built it, so there is no user
            // setting to preserve: turn the guard off first. Only a replica
            // the template asked to protect can carry it, and even then it is
            // read from AWS first: the failure may have come before the guard
            // was set, and a flip against a replica still CREATING is refused.
            // Its own best-effort try, so a failed flip still leaves the drop
            // below to be attempted (and refused loudly).
            const declared = readReplicaDeletionProtection(
              localReplicaEntry(wiringProperties, region),
              region
            );
            try {
              const live =
                declared === true
                  ? await this.getRegionalClient(region).send(
                      new DescribeTableCommand({ TableName: tableName })
                    )
                  : undefined;
              if (live?.Table?.DeletionProtectionEnabled === true) {
                await this.setReplicaDeletionProtection(
                  tableName,
                  region,
                  false,
                  logicalId,
                  maskSecrets
                );
              }
            } catch (flipError) {
              if (isInterruptedWaitError(flipError)) throw flipError;
              log.debug(
                `Partial-create cleanup: could not turn off deletion protection on the ` +
                  `${region} replica of ${log.value(tableName)}: ` +
                  log.mask(describeAwsFailure(flipError).detail)
              );
            }
            await this.dynamoDBClient.send(
              new UpdateTableCommand({
                TableName: tableName,
                ReplicaUpdates: [{ Delete: { RegionName: region } }],
              })
            );
            await this.waitForReplicaGone(
              tableName,
              region,
              logicalId,
              undefined,
              undefined,
              maskSecrets
            );
            // go-to-k/cdkd#5581: DynamoDB registered targets for the replica
            // this create added; they outlive it.
            await this.deregisterRemovedReplicaScalableTargets(tableName, region, {
              maskSecrets,
            });
          } catch (replicaCleanupErr) {
            // A Ctrl-C stops the cleanup like every other wait here.
            if (isInterruptedWaitError(replicaCleanupErr)) throw replicaCleanupErr;
            // The class at warn, AWS's text at debug (go-to-k/cdkd#2319).
            const msg = this.cleanupFailureText(
              log,
              `Partial-create cleanup: failed to drop replica ${region} on ${tableName}: `,
              replicaCleanupErr
            );
            // `Delete={RegionName=` and `}` are cdkd's own text, so they sit in
            // the template's literal part: passed as a value, their `{` and `}`
            // would withhold the command for every table (`PASTE_ARG_UNSAFE`,
            // go-to-k/cdkd#3950). The literal is single-quoted around the
            // value, so in a normal paste the shell sees one word,
            // `Delete={RegionName=<region>}`, with the braces never exposed:
            // unquoted, zsh's `BRACE_CCL` would expand them. A line flipped by
            // an apostrophe in `msg` (AWS error text) leaves them unquoted, but
            // the words stay glued to prose, so the worst case is an aws parse
            // error, not a run. `region` is an AWS region name read from
            // `DescribeTable`, so it holds no quote.
            warn(
              `Partial-create cleanup: failed to drop replica ${region} on ${tableName}: ${msg} ` +
                `Run: ${pasteableAwsCommand(maskSecrets)`aws dynamodb update-table --table-name ${tableName} --replica-updates 'Delete={RegionName='${region}'}' --region ${currentRegion}`.render()}`
            );
          }
        }
        // go-to-k/cdkd#2762: a vector index may still be building when the
        // failure arrives (the wait for it can be what failed), and AWS refuses
        // `DeleteTable` during a build.
        if (createVectorIndexes !== undefined) {
          await this.rollBackCreatedVectorTable(logicalId, tableName, maskSecrets);
        } else {
          await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
        }
        retractCreatedResource(logicalId, resourceType, tableName);
      } catch (cleanupErr) {
        tableLeftBehind = true;
        const cleanupMsg = this.cleanupFailureText(
          log,
          `Partial-create cleanup failed for ${tableName}: `,
          cleanupErr
        );
        warn(
          `Partial-create cleanup failed for ${tableName}: ${cleanupMsg} ` +
            `To remove the orphaned AWS-side table, run: ` +
            pasteableAwsCommand(
              maskSecrets
            )`aws dynamodb delete-table --table-name ${tableName}`.render()
        );
      }
      // CreateTable succeeded, so nothing raised here is this table's own name
      // collision: an "already exists" relayed from the replica add or the TTL
      // call would otherwise be credited to it, and `--replace` would delete
      // the live old table over it (issue #3826 / #3877).
      markAuxiliaryFailure(wiringError, logicalId);
      const cause = wiringError instanceof Error ? wiringError : undefined;
      const thrown = this.wrapMaskedError(
        log,
        wiringError,
        (text) =>
          new ProvisioningError(
            `Failed to create DynamoDB GlobalTable ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            tableName,
            cause
          )
      );
      // go-to-k/cdkd#4583: the cleanup DeleteTable failed, so the table this
      // call created is left behind — let `rollback --revert-failed` delete it.
      // With its `TableId` (go-to-k/cdkd#4606), the identity a later settle
      // compares before deleting it by name.
      if (tableLeftBehind) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, tableName, createdTableId);
      }
      throw thrown;
    }
  }

  /**
   * `create()`'s rollback `DeleteTable` for a table declaring vector indexes
   * (go-to-k/cdkd#2762), retrying ONLY the index-busy refusal: the
   * `AWS::DynamoDB::Table` provider's `rollBackCreatedTable` (go-to-k/cdkd#5574).
   * Bounded by what the enclosing per-resource deadline has left; with no room
   * left the first refusal is terminal, since that deadline does not cancel.
   * Throws what the last `DeleteTable` threw; the caller reports the table left
   * behind.
   */
  private async rollBackCreatedVectorTable(
    logicalId: string,
    tableName: string,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const logger = maskedLogger(this.logger, maskSecrets, tableName);
    const allowanceMs = Math.min(
      resolveDynamoDbDeleteBudgetMs(),
      enclosingDeadlineRemainingMs() - DYNAMODB_DELETE_DEADLINE_MARGIN_MS
    );
    const budget =
      allowanceMs > 0
        ? new ElapsedBudget(allowanceMs, resolveDynamoDbDeleteBudgetClock())
        : undefined;
    await deleteTableWithIndexBusyRetry({
      logicalId,
      physicalId: tableName,
      typeLabel: 'GlobalTable',
      indexNoun: TABLE_INDEX_NOUN,
      maxRetries: GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
      logger,
      deleteTable: async () => {
        await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
      },
      reArm: () =>
        this.waitForIndexesActive(tableName, logicalId, {
          maxAttempts: VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
          shortCapUnlessVectorBusy: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
          proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
          ...(budget !== undefined && { budget }),
          maskSecrets,
        }),
      shouldKeepRetrying: () => budget !== undefined && !budget.isExhausted(),
      retryWarning: () =>
        `DynamoDB GlobalTable ${logicalId}: AWS refused the DeleteTable rolling back the ` +
        `partially-created table ${tableName} because ${TABLE_INDEX_NOUN} is still being ` +
        `created, updated or deleted. Waiting for the indexes to settle and retrying (up to ` +
        `${GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES} retries in all, within ~` +
        `${Math.max(1, Math.round((budget?.totalMs ?? 0) / 60_000))} minutes).`,
      sleepSeam: deleteTableRetryDelays,
    });
  }

  /**
   * Log a batch of {@link ThroughputDiagnostic}s at WARN, de-duplicated.
   *
   * The translators run over every index on both the create and the update
   * path, so the same malformed block can be reported more than once in one
   * call; a repeated warning reads as repeated damage and is worse than
   * useless. Kept as ONE formatter so the five translation call sites cannot
   * word the same defect differently.
   */
  private reportThroughputDiagnostics(
    diagnostics: readonly ThroughputDiagnostic[],
    logicalId: string,
    physicalId: string,
    // The caller's secret masker (issue #1997). Each diagnostic names an index
    // NAME read out of the resolved `GlobalSecondaryIndexes` bag, and its
    // message can quote a declared capacity value. Defaults to IDENTITY.
    maskSecrets: SecretMasker = (text) => text
  ): void {
    // ONE masked sink (issue #1997): this formatter is the single site the five
    // translation call sites share, so masking here covers every one of them.
    const warn = (message: string): void => this.logger.warn(maskSecrets(message));
    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      // The index NAME is a resolved property value, so it is masked raw —
      // reaching `maskSecretsInText`'s WHOLE-VALUE arm at any length — as well
      // as through the sink above.
      const scope = diagnostic.indexName
        ? `GSI '${maskSecrets(diagnostic.indexName)}' on ${physicalId}`
        : physicalId;
      const line = `DynamoDB GlobalTable ${logicalId}: ${scope}: ${diagnostic.message}`;
      if (seen.has(line)) continue;
      seen.add(line);
      warn(line);
    }
  }

  /**
   * The `WarmThroughput` block to put on ONE `GlobalSecondaryIndexUpdate`, or
   * `undefined` when it must not be sent (issue #1857).
   *
   * ONE helper for all three `UpdateTable` send sites — the billing-flip
   * ride-along, the `added` loop's `Create`, and the `modified` loop's
   * `Update` — because three copies of a decrease guard is three chances to
   * word one differently, and the whole point of {@link isWarmThroughputDecrease}
   * is that the answer does not depend on which site asked.
   *
   * The `desired` argument is already COERCED (`toSdkGlobalSecondaryIndexes`
   * did it), so an unusable block never reaches here at all: it was refused
   * and reported during translation, and arrives as `undefined`. What is left
   * for this helper is the one question translation cannot answer, because it
   * needs live AWS state: would this call LOWER what AWS reports?
   *
   * The refusal is a WARN and a dropped member, not a throw. A decrease is a
   * template that has fallen behind a value AWS grew on its own; failing the
   * deploy over it would block every unrelated change to the same table, and
   * there is no template edit that "fixes" it other than raising a number the
   * user never chose.
   */
  private warmThroughputForSend(
    indexName: string,
    desired: WarmThroughputSpec | undefined,
    liveWarmByIndexName: ReadonlyMap<string, WarmThroughputSpec>,
    logicalId: string,
    physicalId: string,
    // The caller's secret masker (issue #1997). The warning below names the
    // DECLARED per-index `WarmThroughput` and the index NAME, both of which come
    // out of the RESOLVED `properties` bag. Defaults to IDENTITY.
    maskSecrets: SecretMasker = (text) => text
  ): WarmThroughputSpec | undefined {
    // ONE masked sink (issue #1997) — see `update()` for why both layers.
    const warn = (message: string): void => this.logger.warn(maskSecrets(message));
    if (!desired) return undefined;
    const live = liveWarmByIndexName.get(indexName);
    if (!isWarmThroughputDecrease(desired, live)) return desired;
    // Both sides are guaranteed to have at least one numeric member here:
    // `isWarmThroughputDecrease` returns TRUE only when some DECLARED member of
    // `desired` is strictly below a finite counterpart in `live`. An earlier
    // cut appended `|| '(none)'` for an empty render; that arm was
    // unreachable — the guard above answers `false` for every input that could
    // produce it — so it is left off rather than kept as an untestable branch.
    const format = (spec: WarmThroughputSpec | undefined): string =>
      WARM_THROUGHPUT_MEMBERS.filter((m) => spec?.[m] !== undefined)
        .map((m) => `${m}=${spec?.[m]}`)
        .join(', ');
    warn(
      // The index NAME is a resolved property value: masked RAW so it reaches
      // `maskSecretsInText`'s WHOLE-VALUE arm at any length, as well as through
      // the sink above (issue #1997). `format` renders numeric members only, so
      // it carries no plaintext of its own.
      `DynamoDB GlobalTable ${logicalId}: GSI '${maskSecrets(indexName)}' on ${physicalId}: ` +
        `WarmThroughput was NOT sent — the template asks for ${format(desired)} while AWS ` +
        `reports ${format(live)}, and DynamoDB rejects a decrease ` +
        `("decreasing WarmThroughput is not supported"). Warm throughput only rises with a ` +
        `table's traffic, so a template below the live value can never be applied; raise it ` +
        `to at least the live value, or remove it. Every other change to this index is ` +
        `applied normally.`
    );
    return undefined;
  }

  /**
   * The table-level `WarmThroughput` to send, or `undefined` when none must go
   * out (go-to-k/cdkd#2762): the {@link warmThroughputForSend} rule one level
   * up. A block AWS already reports needs no call; one below it is reported and
   * not sent, because warm throughput only rises with a table's traffic. This
   * differs from CloudFormation, which fails the update ("decreasing
   * WarmThroughput is not supported", measured 2026-11-01), and matches
   * `AWS::DynamoDB::Table`. The `desired` argument is already coerced.
   */
  private tableWarmThroughputForSend(
    desired: WarmThroughputSpec | undefined,
    live: WarmThroughputSpec | undefined,
    logicalId: string,
    physicalId: string,
    maskSecrets: SecretMasker
  ): WarmThroughputSpec | undefined {
    if (!desired) return undefined;
    const declared = WARM_THROUGHPUT_MEMBERS.filter((m) => desired[m] !== undefined);
    if (declared.every((m) => desired[m] === live?.[m])) return undefined;
    if (!isWarmThroughputDecrease(desired, live)) return desired;
    const format = (spec: WarmThroughputSpec | undefined): string =>
      declared.map((m) => `${m}=${spec?.[m]}`).join(', ');
    // `format` renders numeric members only. The name is masked on its own too,
    // for one below the masker's substring floor.
    this.logger.warn(
      maskSecrets(
        `DynamoDB GlobalTable ${logicalId}: table ${maskSecrets(physicalId)}: WarmThroughput was NOT sent — ` +
          `the template asks for ${format(desired)} while AWS reports ${format(live)}, and ` +
          `DynamoDB rejects a decrease. Raise it to at least the live value, or remove it. ` +
          `Every other change to this table is applied normally.`
      )
    );
    return undefined;
  }

  /**
   * Apply a {@link planVectorIndexUpdates} plan (go-to-k/cdkd#2762): each op in
   * its own `UpdateTable` (AWS takes one vector index add or remove per call),
   * with the table and every index settled before and after. A Create carries
   * the desired `AttributeDefinitions`, as a GSI Create does. A replica follows
   * the deploy region's table (measured, us-east-1 + us-east-2, 2026-11-01), so
   * no region is addressed separately.
   */
  private async applyVectorIndexUpdates(
    physicalId: string,
    logicalId: string,
    plan: VectorIndexPlan,
    desiredAttributeDefinitions: AttributeDefinition[] | undefined,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const scope = (name: unknown): string =>
      `vector index ${typeof name === 'string' ? maskSecrets(name) : '<unnamed>'} on DynamoDB ` +
      `GlobalTable ${maskSecrets(physicalId)}`;
    for (const name of plan.alreadyGone) {
      this.logger.debug(
        maskSecrets(`${scope(name)} is recorded but not live; skipping its Delete`)
      );
    }
    for (const name of plan.adopted) {
      this.logger.warn(
        maskSecrets(
          `${scope(name)} already exists in AWS with the declared definition but is absent ` +
            `from cdkd's recorded previous state, so its Create is being skipped. This usually ` +
            `means an earlier deploy created the index and then failed before state was written.`
        )
      );
    }
    if (plan.ops.length === 0) return;
    await this.waitForVectorIndexesSettled(physicalId, logicalId, maskSecrets);
    markUnsettled('VectorIndexes');
    for (const op of plan.ops) {
      const input: UpdateTableCommandInput = { TableName: physicalId, VectorIndexUpdates: [op] };
      if (op.Create && desiredAttributeDefinitions) {
        input.AttributeDefinitions = desiredAttributeDefinitions;
      }
      await this.dynamoDBClient.send(new UpdateTableCommand(input));
      if (op.Create?.IndexName !== undefined) {
        markAttemptedItems('VectorIndexes', [op.Create.IndexName]);
      }
      await this.waitForVectorIndexesSettled(physicalId, logicalId, maskSecrets);
      this.logger.debug(
        maskSecrets(
          `${op.Create ? 'created' : 'deleted'} ` +
            scope(op.Create?.IndexName ?? op.Delete?.IndexName)
        )
      );
    }
  }

  /**
   * Wait until the table and every vector index are settled. An index building
   * or being removed refuses the next index op and a replica add, as a GSI does.
   */
  private async waitForVectorIndexesSettled(
    tableName: string,
    logicalId: string,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const watch = startInterruptWatch(
      maskSecrets(`DynamoDB vector indexes on ${maskSecrets(tableName)}`)
    );
    try {
      for (let attempt = 1; attempt <= VECTOR_INDEX_SETTLE_ATTEMPTS; attempt++) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        const table = (
          await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }))
        ).Table;
        if (table?.TableStatus === 'ACTIVE' && vectorIndexesSettled(table.VectorIndexes)) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      watch.dispose();
    }
    throw new Error(
      maskSecrets(
        `DynamoDB GlobalTable ${logicalId}: table ${maskSecrets(tableName)} and its vector ` +
          `indexes did not settle within ${VECTOR_INDEX_SETTLE_ATTEMPTS} polls`
      )
    );
  }

  /**
   * Add a single replica region. Issues one `UpdateTableCommand` with
   * `ReplicaUpdates: [{ Create: { RegionName, ... } }]` and polls
   * `DescribeTable` until the replica's `ReplicaStatus` flips to ACTIVE.
   * Capped at 10 minutes per replica (AWS Replica provisioning typically
   * takes 1–5 min).
   *
   * `CreateReplicationGroupMemberAction` has no member for a replica's
   * point-in-time recovery, Contributor Insights (the table's or an index's),
   * Kinesis destination, resource policies or stream tags:
   * {@link applyReplicaSettings} sends those through the replica's own region
   * once every replica is ACTIVE (go-to-k/cdkd#5365, go-to-k/cdkd#5489).
   */
  private async addReplica(
    tableName: string,
    replica: Record<string, unknown>,
    region: string,
    logicalId: string,
    billingMode: string,
    diagnostics?: ThroughputDiagnostic[],
    // Threaded from both call sites (`create` / `update`), which each hold the
    // contract's `context?.maskSecrets`. Identity default keeps the
    // "absent means unmasked" contract for any future caller (issue #2178).
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    const create: CreateReplicationGroupMemberAction = {
      RegionName: region,
    };
    // CFn spellings `SSESpecification.KMSMasterKeyId` / `TableClass`, not the
    // SDK member names (go-to-k/cdkd#5355).
    const kmsMasterKeyId = readReplicaKmsMasterKeyId(replica);
    if (kmsMasterKeyId !== undefined) {
      create.KMSMasterKeyId = kmsMasterKeyId;
    }
    // Replica-level GSI overrides. The CFn
    // `ReplicaGlobalSecondaryIndexSpecification` spells the per-replica read
    // throughput `Read{Provisioned,OnDemand}ThroughputSettings`, while the SDK
    // wants `{Provisioned,OnDemand}ThroughputOverride` — translate (Issue #1387).
    const replicaIndexes = toSdkReplicaGlobalSecondaryIndexes(
      replica['GlobalSecondaryIndexes'],
      billingMode,
      diagnostics,
      maskSecrets
    );
    if (replicaIndexes) {
      create.GlobalSecondaryIndexes = replicaIndexes;
    }
    // The replica's own TABLE-level read ceiling / read capacity, which uses
    // the SAME two CFn spellings one level up (issue #1436). A non-local
    // replica's `ReadOnDemandThroughputSettings` was dropped entirely before
    // this — the replica silently kept the source table's default.
    const tableOverrides = toSdkReplicaThroughputOverrides(
      replica,
      billingMode,
      diagnostics,
      {},
      maskSecrets
    );
    if (tableOverrides.ProvisionedThroughputOverride) {
      create.ProvisionedThroughputOverride = tableOverrides.ProvisionedThroughputOverride;
    }
    if (tableOverrides.OnDemandThroughputOverride) {
      create.OnDemandThroughputOverride = tableOverrides.OnDemandThroughputOverride;
    }
    const tableClass = readReplicaTableClass(replica);
    if (tableClass !== undefined) {
      create.TableClassOverride = tableClass;
    }

    const replicaUpdates: ReplicationGroupUpdate[] = [{ Create: create }];

    // A refusal because the region still holds a same-named table is retried
    // ONLY after that table is confirmed to be going away (issue #3569): a
    // table this provider just deleted leaves its regional copy DELETING for
    // minutes after it has left the source's `Replicas[]`, which is all
    // `delete()` waits for. A reverse-replacement rollback re-creates the old
    // table under its old name straight after deleting it, so it hits exactly
    // that window. Anything but DELETING is re-thrown untouched — a live table
    // of that name is not cdkd's to wait out, let alone remove.
    for (let attempt = 1; ; attempt++) {
      try {
        markUnsettled('Replicas');
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: tableName,
            ReplicaUpdates: replicaUpdates,
          })
        );
        // go-to-k/cdkd#5498: AWS accepted the replica Create.
        markAttemptedItems('Replicas', [region]);
        break;
      } catch (error) {
        if (attempt >= REPLICA_COPY_RELEASE_ATTEMPTS || !isReplicaCopyExistsRefusal(error)) {
          throw error;
        }
        if (!(await this.waitForRegionalCopyReleased(tableName, region, maskSecrets))) throw error;
        // One more interval AFTER the region reports the copy gone: the source
        // table's own view of the region can trail the region itself, which is
        // the lag this retry exists for, and a copy found gone on the FIRST poll
        // would otherwise be retried at once.
        await new Promise((resolve) => setTimeout(resolve, REPLICA_COPY_RELEASE_POLL_MS));
      }
    }

    await this.waitForReplicaActive(tableName, region, logicalId, undefined, maskSecrets);

    // `CreateReplicationGroupMemberAction` has no deletion-protection member,
    // so a cross-region replica's `DeletionProtectionEnabled` is set on the
    // replica's own table in its own region once it exists. A new replica
    // starts unprotected, so only `true` needs a call (go-to-k/cdkd#5355).
    const protect = readReplicaDeletionProtection(replica, region, (message) =>
      this.logger.warn(maskSecrets(message))
    );
    if (protect === true) {
      await this.setReplicaDeletionProtection(tableName, region, true, logicalId, maskSecrets);
    }
  }

  /**
   * Set `DeletionProtectionEnabled` on a CROSS-REGION replica: an
   * `UpdateTable` against the replica's table through the region-scoped
   * client, since the source table's `ReplicaUpdates` cannot carry it
   * (go-to-k/cdkd#5355). Then waits for the change to settle — see
   * {@link waitForReplicaProtectionSettled}.
   */
  private async setReplicaDeletionProtection(
    tableName: string,
    region: string,
    enabled: boolean,
    logicalId: string,
    maskSecrets: SecretMasker,
    budget?: ElapsedBudget
  ): Promise<void> {
    await this.sendReplicaDeletionProtection(tableName, region, enabled, logicalId, maskSecrets, {
      budget,
    });
    await this.waitForReplicaProtectionSettled(
      tableName,
      region,
      enabled,
      logicalId,
      maskSecrets,
      budget
    );
  }

  /**
   * The protection write itself, after the table and every replica — this
   * replica's own table included — read settled: a change still in flight
   * (a key, class or protection change moments earlier) makes DynamoDB refuse
   * it with `ResourceInUseException` (integ, 2026-10-27: the auto-disable
   * straight after a key / class update was refused that way).
   */
  private async sendReplicaDeletionProtection(
    tableName: string,
    region: string,
    enabled: boolean,
    logicalId: string,
    maskSecrets: SecretMasker,
    opts: { budget?: ElapsedBudget | undefined } = {}
  ): Promise<void> {
    await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, { ...opts, region });
    await this.writeReplicaDeletionProtection(tableName, region, enabled);
  }

  private async writeReplicaDeletionProtection(
    tableName: string,
    region: string,
    enabled: boolean
  ): Promise<void> {
    markUnsettled('Replicas');
    await this.getRegionalClient(region).send(
      new UpdateTableCommand({ TableName: tableName, DeletionProtectionEnabled: enabled })
    );
  }

  /**
   * Wait for a replica's deletion-protection change to land. On a
   * cross-region replica the change puts BOTH the replica's table and the
   * source table into `UPDATING` for about 30 s, the new value reads back
   * only once the replica is `ACTIVE` again, and the source refuses a replica
   * update or drop meanwhile with `ResourceInUseException` (measured
   * us-east-1 + us-west-2, 2026-10-26). Bounded and interruptible like the
   * other waits here; on the delete path it spends the shared allowance.
   */
  private async waitForReplicaProtectionSettled(
    tableName: string,
    region: string,
    enabled: boolean,
    logicalId: string,
    maskSecrets: SecretMasker,
    budget?: ElapsedBudget,
    // go-to-k/cdkd#5570: the disassociation-protection pass waits the same
    // way, on the replica region's own table (the local one included).
    member:
      | 'DeletionProtectionEnabled'
      | 'DisassociationProtectionEnabled' = 'DeletionProtectionEnabled',
    replicaClient: DynamoDBClient = this.getRegionalClient(region)
  ): Promise<void> {
    const wait = beginDeleteWait(REPLICA_PROTECTION_SETTLE_POLLS, budget);
    const what =
      member === 'DeletionProtectionEnabled' ? 'deletion-protection' : 'disassociation-protection';
    const watch = startInterruptWatch(
      maskSecrets(`DynamoDB replica ${region} ${what} change on ${tableName}`)
    );
    try {
      while (wait.nextPoll()) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        const replica = await replicaClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        if (replica.Table?.TableStatus === 'ACTIVE' && replica.Table[member] === enabled) {
          const source = await this.dynamoDBClient.send(
            new DescribeTableCommand({ TableName: tableName })
          );
          if (source.Table?.TableStatus === 'ACTIVE') return;
        }
        await new Promise((resolve) => setTimeout(resolve, REPLICA_PROTECTION_SETTLE_POLL_MS));
      }
    } finally {
      watch.dispose();
    }
    throw new ProvisioningError(
      maskSecrets(
        `${member}=${enabled} on the ${region} replica of ${tableName} did not ` +
          `settle within ${wait.pollsRun} polls${wait.note()}`
      ),
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * `update()`'s cross-region `Replicas[].DeletionProtectionEnabled` pass
   * (go-to-k/cdkd#5355), over every replica the update KEEPS — one it just
   * added already took its setting in {@link addReplica}.
   *
   * A template-side change is sent, an absent value reading as `false` (what
   * CloudFormation leaves after the member is removed, and what a new replica
   * starts with). A DECLARED value the template did not change is checked
   * against AWS, the twin of the local table's AWS-aware diff: before this
   * issue the setting was never sent, so a replica deployed then holds `false`
   * under a record saying `true`, and only a read converges it (a console-side
   * enable under a declared `false` likewise). That read is best-effort — a
   * failure leaves the replica as it is. A value that is not a boolean is
   * reported and the replica's protection left alone, never read as `false`.
   */
  private async convergeReplicaDeletionProtection(
    tableName: string,
    logicalId: string,
    currentRegion: string,
    previousProperties: Record<string, unknown>,
    properties: Record<string, unknown>,
    addedRegions: ReadonlySet<unknown>,
    // `drift --revert`: the desired side is a read-back, which omits a
    // replica's protection when its regional read failed (go-to-k/cdkd#5381)
    // — an absence there is unknown, never "unprotect".
    desiredFromReadback: boolean,
    warn: (message: string) => void,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const desired = Array.isArray(properties['Replicas'])
      ? (properties['Replicas'] as unknown[])
      : [];
    for (const entry of desired) {
      const replica = asRecord(entry);
      const region = replica?.['Region'];
      if (typeof region !== 'string' || region === currentRegion || addedRegions.has(region)) {
        continue;
      }
      const declared = readReplicaDeletionProtection(replica, region, warn);
      if (declared === UNUSABLE) continue;
      if (declared === undefined && desiredFromReadback) continue;
      const previous = readReplicaDeletionProtection(
        localReplicaEntry(previousProperties, region),
        region
      );
      const newDpe = declared ?? false;
      const oldDpe = previous === UNUSABLE ? undefined : (previous ?? false);
      if (oldDpe !== undefined && newDpe !== oldDpe) {
        if (oldDpe && declared === undefined) {
          // The local table's auto-disable warning, for the same footgun: a
          // dropped `deletionProtection` line turns the guard off.
          warn(
            `Auto-disabling DeletionProtectionEnabled on the ${region} replica of ` +
              `${tableName}: the template no longer sets it for that replica. Set it ` +
              `to false explicitly to silence this warning.`
          );
        }
        await this.setReplicaDeletionProtection(tableName, region, newDpe, logicalId, maskSecrets);
        continue;
      }
      // Only a DECLARED value is converged against AWS; an absent one with an
      // unreadable record has no change to send and nothing to assert.
      if (declared === undefined) continue;
      let live: boolean | undefined;
      try {
        const described = await this.getRegionalClient(region).send(
          new DescribeTableCommand({ TableName: tableName })
        );
        live = described.Table?.DeletionProtectionEnabled;
      } catch (readError) {
        this.logger.debug(
          maskSecrets(
            `Could not read DeletionProtectionEnabled on the ${region} replica of ${tableName}: ` +
              describeAwsFailure(readError).detail
          )
        );
      }
      if (typeof live === 'boolean' && live !== newDpe) {
        await this.setReplicaDeletionProtection(tableName, region, newDpe, logicalId, maskSecrets);
      }
    }
  }

  /**
   * Each replica's declared `Replicas[].DisassociationProtectionEnabled`, the
   * local table's included (go-to-k/cdkd#5570). DynamoDB takes it only as an
   * `UpdateTable` of the replica's own table, in its own region, that changes
   * nothing else, so it is one solo write per replica, made once every other
   * change of the create or update has settled.
   *
   * AWS-aware: a replica already holding the declared value gets no write.
   * The protection is on by default for every replica (DynamoDB Developer
   * Guide, "Disassociating a global table replica"), so a declared `true`
   * usually costs one read. A value the template changed, or declares on a
   * replica this deploy creates, is sent when that read fails or reports no
   * value; an unchanged one is only converged against a value AWS reports, so
   * a failed read leaves the replica as it is.
   *
   * A REMOVED value sends nothing: an `UpdateTable` that omits the member
   * leaves the setting unchanged, so the replica keeps it, and the template
   * path says so (CloudFormation's behaviour on removal is unmeasured). A
   * state replay is the exception: its desired side is the record an earlier
   * deploy left, and a record without the member stands for the AWS default,
   * so when the rolled-back deploy declared `false` and AWS reads `false`,
   * the replay sends `true` — a rollback never leaves the protection weaker
   * than the record it restores. It does not ask whether that deploy got as
   * far as sending its `false`: a `false` set outside cdkd, which the record
   * does not declare either, is turned back on as well, the way the replay
   * restores every other recorded setting. A drift revert sends nothing for
   * an absence: a read-back omits a member whose read failed.
   *
   * The protection guards only the `Disassociate` replica action, which cdkd
   * never sends; deletion protection is the guard of a replica removal and of
   * `DeleteTable`, so no delete path reads this one.
   */
  private async convergeReplicaDisassociationProtection(
    tableName: string,
    logicalId: string,
    currentRegion: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown> | undefined,
    origin: 'template' | 'replay' | 'readback',
    warn: (message: string) => void,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const desired = Array.isArray(properties['Replicas'])
      ? (properties['Replicas'] as unknown[])
      : [];
    let wrote = false;
    // A single-Region table takes no write at all: DynamoDB answered the solo
    // UpdateTable {false} with a 500 there. A new or changed `false` was
    // refused (or, on a replay or a revert, warned) up front by
    // disassociationProtectionRefusal; a `true` and an unchanged `false` are
    // skipped here.
    const multiRegion = isMultiRegionReplicaSet(properties);
    for (const entry of desired) {
      const replica = asRecord(entry);
      const region = replica?.['Region'];
      if (typeof region !== 'string' || region === '') continue;
      const declared = readReplicaDisassociationProtection(replica);
      const previous =
        previousProperties === undefined
          ? undefined
          : readReplicaDisassociationProtection(localReplicaEntry(previousProperties, region));
      // Resolved only for a replica the pass reads: a region-scoped client is
      // never built for one that declares nothing.
      const clientFor = (): DynamoDBClient =>
        region === currentRegion ? this.dynamoDBClient : this.getRegionalClient(region);
      const readLive = async (): Promise<boolean | undefined> => {
        const client = clientFor();
        try {
          const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
          return described.Table?.DisassociationProtectionEnabled;
        } catch (readError) {
          this.logger.debug(
            maskSecrets(
              `Could not read ${DISASSOCIATION_PROTECTION_KEY} on the ${region} replica of ` +
                `${tableName}: ${describeAwsFailure(readError).detail}`
            )
          );
          return undefined;
        }
      };
      if (!multiRegion) {
        if (declared !== undefined) {
          const message =
            `${DISASSOCIATION_PROTECTION_KEY}=${declared} on the ${region} replica of ` +
            `${tableName} is not sent: DynamoDB applies it only to a replica of a multi-Region ` +
            "global table, and this table's Replicas name a single Region.";
          // Said once, in the deploy that leaves one Region or that declares
          // or changes the value; afterwards it is the steady state, at debug.
          const justShrunk =
            previousProperties !== undefined && isMultiRegionReplicaSet(previousProperties);
          if (origin === 'template' && (justShrunk || declared !== previous)) warn(message);
          else this.logger.debug(maskSecrets(message));
        } else if (
          origin !== 'readback' &&
          replica?.[DISASSOCIATION_PROTECTION_KEY] === undefined &&
          previous !== undefined
        ) {
          // Nothing can be sent here, the template's removal and a replay's
          // restore alike: say what the replica keeps.
          warn(
            `${DISASSOCIATION_PROTECTION_KEY} was removed from the ${region} replica of ` +
              `${tableName}, whose Replicas now name a single Region, so nothing is sent and ` +
              `the replica keeps its current setting (${previous} when last deployed).`
          );
        }
        continue;
      }
      if (declared === undefined) {
        if (replica?.[DISASSOCIATION_PROTECTION_KEY] !== undefined || previous === undefined) {
          continue;
        }
        if (origin === 'template') {
          warn(
            `${DISASSOCIATION_PROTECTION_KEY} was removed from the ${region} replica of ` +
              `${tableName}; DynamoDB keeps the replica's current setting (${previous} when ` +
              `last deployed), so nothing is sent. Declare it to change it.`
          );
        } else if (origin === 'replay' && previous === false && (await readLive()) === false) {
          await this.setReplicaDisassociationProtection(
            tableName,
            region,
            clientFor(),
            true,
            logicalId,
            maskSecrets
          );
          wrote = true;
        }
        continue;
      }
      // go-to-k/cdkd#5487: an earlier update that failed part-way may have
      // left a write unsent, so an unsettled `Replicas` counts as a change
      // and is sent even when this deploy's read fails.
      const changed = declared !== previous || isUnsettled('Replicas');
      const live = await readLive();
      if (live === declared) continue;
      if (live === undefined && !changed) continue;
      await this.setReplicaDisassociationProtection(
        tableName,
        region,
        clientFor(),
        declared,
        logicalId,
        maskSecrets
      );
      wrote = true;
    }
    // The replica-scoped wait above does not read the other replicas'
    // statuses, and the steps after this pass (TTL, the index updates,
    // auto-scaling) are refused with `ResourceInUseException` while any is
    // still UPDATING: settle the whole table before handing it on.
    if (wrote) await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
  }

  /**
   * The solo disassociation-protection write on one replica's own table, once
   * the table and every replica read settled (a change still in flight makes
   * DynamoDB refuse it with `ResourceInUseException`, as it refuses the
   * deletion-protection write), then the wait for the value to read back —
   * see {@link waitForReplicaProtectionSettled}.
   */
  private async setReplicaDisassociationProtection(
    tableName: string,
    region: string,
    client: DynamoDBClient,
    enabled: boolean,
    logicalId: string,
    maskSecrets: SecretMasker
  ): Promise<void> {
    await this.waitForGlobalTableSettled(
      tableName,
      logicalId,
      maskSecrets,
      client === this.dynamoDBClient ? {} : { region }
    );
    // A refusal propagates as the deletion-protection write's does: the
    // caller's masked wrap names its class, never AWS's text (#2319).
    markUnsettled('Replicas');
    this.logger.debug(
      maskSecrets(
        `Sending UpdateTable ${DISASSOCIATION_PROTECTION_KEY}=${enabled} to the ${region} replica of ${tableName}`
      )
    );
    await client.send(
      new UpdateTableCommand({ TableName: tableName, DisassociationProtectionEnabled: enabled })
    );
    await this.waitForReplicaProtectionSettled(
      tableName,
      region,
      enabled,
      logicalId,
      maskSecrets,
      undefined,
      DISASSOCIATION_PROTECTION_KEY,
      client
    );
  }

  /**
   * `update()`'s AWS-aware pass over the KEPT cross-region replicas' declared
   * `TableClass` (go-to-k/cdkd#5355). The diff-driven replica update only
   * fires on a template change, but a replica deployed before this issue
   * holds `STANDARD` under a record that already names the declared class —
   * so the two sides match and only AWS can say the replica is wrong. Read
   * from ONE source `DescribeTable` after the replica updates ran, which
   * reports each replica's class. The KMS keys are {@link applyReplicaKeys}'.
   */
  private async convergeReplicaSettings(
    tableName: string,
    logicalId: string,
    currentRegion: string,
    properties: Record<string, unknown>,
    addedRegions: ReadonlySet<unknown>,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const desired = Array.isArray(properties['Replicas'])
      ? (properties['Replicas'] as unknown[])
      : [];
    const kept = desired
      .map(asRecord)
      .filter(
        (r): r is Record<string, unknown> =>
          typeof r?.['Region'] === 'string' &&
          r['Region'] !== currentRegion &&
          !addedRegions.has(r['Region'])
      );
    if (kept.every((r) => readReplicaTableClass(r) === undefined)) return;
    let liveReplicas: ReplicaDescription[] | undefined;
    let sourceClass: string | undefined;
    try {
      const described = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      liveReplicas = described.Table?.Replicas;
      sourceClass = described.Table?.TableClassSummary?.TableClass;
    } catch (readError) {
      this.logger.debug(
        maskSecrets(
          `Could not read the replicas of ${tableName} to converge their table class: ` +
            describeAwsFailure(readError).detail
        )
      );
      return;
    }
    for (const replica of kept) {
      const region = replica['Region'] as string;
      const live = liveReplicas?.find((r) => r.RegionName === region);
      if (!live) continue;
      const tableClass = readReplicaTableClass(replica);
      if (tableClass === undefined) continue;
      // A replica without its own class summary inherits the source table's.
      const liveClass = live.ReplicaTableClassSummary?.TableClass ?? sourceClass ?? 'STANDARD';
      if (tableClass === liveClass) {
        this.logger.debug(
          maskSecrets(
            `The ${region} replica of ${tableName} already holds its declared table class`
          )
        );
        continue;
      }
      this.logger.debug(
        maskSecrets(`Bringing the ${region} replica of ${tableName} to its declared table class`)
      );
      // Best-effort: this corrects a replica the TEMPLATE did not change, so
      // a refusal must not fail a deploy that would otherwise succeed. It is
      // reported; this pass runs again on the table's next update.
      try {
        markUnsettled('Replicas');
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: tableName,
            ReplicaUpdates: [{ Update: { RegionName: region, TableClassOverride: tableClass } }],
          })
        );
        // The whole table, so the key pass after this is not refused.
        await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
      } catch (convergeError) {
        if (isInterruptedWaitError(convergeError)) throw convergeError;
        this.logger.debug(
          maskSecrets(
            `Could not bring the ${region} replica of ${tableName} to its declared table class: ` +
              describeAwsFailure(convergeError).detail
          )
        );
        this.logger.warn(
          maskSecrets(
            `The ${region} replica of ${tableName} does not hold its declared TableClass, and ` +
              `setting it failed (${describeAwsFailure(convergeError).summary}). The next deploy ` +
              `that updates this table tries again.`
          )
        );
      }
    }
  }

  /**
   * `update()`'s customer managed key pass for a table with cross-region
   * replicas (go-to-k/cdkd#5355). DynamoDB takes such a key change only
   * through `ReplicaUpdates`, and only with EVERY region's key in the same
   * call — the table's own region as one of the entries (measured 2026-10-26:
   * `SSESpecification` with a key is refused, a one-replica `Update` is
   * refused with "KMSMasterKeyId must be specified for each replica", and an
   * `Update` per region in one call is accepted, from the AWS owned key, the
   * AWS managed key or another customer managed key alike).
   *
   * Sent when a region's declared key changed in the template, or when a
   * declared key ARN differs from the one AWS reports (a table deployed
   * before this issue sits on the AWS managed key under a record naming the
   * declared one; AWS reports every key as an ARN — measured). A region
   * without a declared key keeps the key AWS reports. A template-side change
   * that fails, or that leaves a region with neither key (DynamoDB needs
   * every region's), fails the update; a correction AWS alone asked for is
   * best-effort and reported, as {@link convergeReplicaSettings} is.
   * A table without cross-region replicas took its key through
   * `SSESpecification` already.
   */
  private async applyReplicaKeys(
    tableName: string,
    logicalId: string,
    currentRegion: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    addedRegions: ReadonlySet<unknown>,
    // The local key update step 3 held back for this pass, if any.
    deferredSseUpdate: UpdateTableCommandInput['SSESpecification'],
    // Whether that held-back update is a template change (else an AWS-aware
    // correction, best-effort like the rest of the convergence).
    deferredSseFromTemplate: boolean,
    // Whether step 3 sent a template-driven `SSESpecification` without a key,
    // which moved every replica to the AWS managed key.
    keylessSseFromTemplate: boolean,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const tableOnKms =
      properties['SSESpecification'] !== undefined &&
      configBooleanRefusal(
        properties['SSESpecification'],
        'SSEEnabled',
        'AWS::DynamoDB::GlobalTable SSESpecification'
      ) === undefined &&
      toSdkTableSseSpecification(properties['SSESpecification'], undefined).Enabled;
    if (!tableOnKms) return;
    const declared = new Map<string, string | undefined>();
    for (const entry of Array.isArray(properties['Replicas'])
      ? (properties['Replicas'] as unknown[])
      : []) {
      const replica = asRecord(entry);
      const region = replica?.['Region'];
      if (typeof region === 'string') declared.set(region, readReplicaKmsMasterKeyId(replica));
    }
    if ([...declared.values()].every((key) => key === undefined)) return;
    // A cross-region replica's key changed in the template: not one this
    // update added (its `Create` carried the key) and not one the template
    // stopped naming. The local key's change is step 3's held-back update.
    const replicaKeyChanged = [...declared].some(
      ([region, key]) =>
        region !== currentRegion &&
        key !== undefined &&
        !addedRegions.has(region) &&
        key !== readReplicaKmsMasterKeyId(localReplicaEntry(previousProperties, region))
    );
    let liveKeys: Map<string, string | undefined>;
    try {
      liveKeys = await this.readLiveKeys(tableName, currentRegion);
    } catch (readError) {
      if (replicaKeyChanged || deferredSseFromTemplate || keylessSseFromTemplate) throw readError;
      this.logger.debug(
        maskSecrets(
          `Could not read the KMS keys of ${tableName} to converge them: ` +
            describeAwsFailure(readError).detail
        )
      );
      return;
    }
    // A held-back local update whose key AWS already reports (only the
    // block's spelling changed) is no change.
    const templateChanged =
      replicaKeyChanged ||
      (keylessSseFromTemplate &&
        [...declared].some(([region, key]) => region !== currentRegion && key !== undefined)) ||
      (deferredSseFromTemplate && declared.get(currentRegion) !== liveKeys.get(currentRegion));
    let request: UpdateTableCommandInput;
    if (liveKeys.size < 2) {
      // The update dropped every cross-region replica: the key held back for
      // this pass goes through `SSESpecification` after all.
      if (deferredSseUpdate === undefined) return;
      request = { TableName: tableName, SSESpecification: deferredSseUpdate };
    } else {
      const built = this.replicaKeysRequest(
        tableName,
        logicalId,
        liveKeys,
        declared,
        templateChanged,
        maskSecrets
      );
      if (built === undefined) return;
      request = built;
    }
    try {
      markUnsettled('SSESpecification', 'Replicas');
      await this.dynamoDBClient.send(new UpdateTableCommand(request));
      await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
    } catch (keyError) {
      if (templateChanged || isInterruptedWaitError(keyError)) throw keyError;
      this.logger.debug(
        maskSecrets(
          `Could not bring the KMS keys of ${tableName} to the declared ones: ` +
            describeAwsFailure(keyError).detail
        )
      );
      this.logger.warn(
        maskSecrets(
          `${tableName} does not hold its declared KMS keys, and setting them failed ` +
            `(${describeAwsFailure(keyError).summary}). The next deploy that updates this ` +
            `table tries again.`
        )
      );
    }
  }

  /** The key ARN each region of `tableName` reports, the local one included. */
  private async readLiveKeys(
    tableName: string,
    currentRegion: string
  ): Promise<Map<string, string | undefined>> {
    const described = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    const keys = new Map<string, string | undefined>([
      [currentRegion, described.Table?.SSEDescription?.KMSMasterKeyArn],
    ]);
    for (const r of described.Table?.Replicas ?? []) {
      if (r.RegionName !== undefined && r.RegionName !== currentRegion) {
        keys.set(r.RegionName, r.KMSMasterKeyId);
      }
    }
    return keys;
  }

  /**
   * {@link applyReplicaKeys}' `ReplicaUpdates` call for a table with
   * cross-region replicas, or `undefined` when there is nothing to send.
   */
  private replicaKeysRequest(
    tableName: string,
    logicalId: string,
    liveKeys: ReadonlyMap<string, string | undefined>,
    declared: ReadonlyMap<string, string | undefined>,
    templateChanged: boolean,
    maskSecrets: SecretMasker
  ): UpdateTableCommandInput | undefined {
    const drifted = [...liveKeys].some(([region, live]) => {
      const key = declared.get(region);
      return isKmsKeyArn(key) && key !== live;
    });
    if (!templateChanged && !drifted) {
      this.logger.debug(
        maskSecrets(`Every region of ${tableName} already holds its declared KMS key`)
      );
      return undefined;
    }
    const entries = [...liveKeys].map(([region, live]) => ({
      Update: { RegionName: region, KMSMasterKeyId: declared.get(region) ?? live },
    }));
    const keyless = entries.filter((e) => e.Update.KMSMasterKeyId === undefined);
    if (keyless.length > 0) {
      const text =
        `The KMS keys of ${tableName} were not changed: DynamoDB takes every region's key ` +
        `in one call, and no key is declared or reported for ` +
        `${keyless.map((e) => e.Update.RegionName).join(', ')}`;
      // A change the template asked for fails the update; a correction AWS
      // alone asked for is reported.
      if (templateChanged) {
        throw new ProvisioningError(
          maskSecrets(`${text}. Declare a key for every replica`),
          'AWS::DynamoDB::GlobalTable',
          logicalId,
          tableName
        );
      }
      this.logger.warn(maskSecrets(`${text}.`));
      return undefined;
    }
    this.logger.debug(
      maskSecrets(`Setting the KMS key of every region of ${tableName} in one ReplicaUpdates call`)
    );
    return { TableName: tableName, ReplicaUpdates: entries };
  }

  /**
   * The per-replica settings pass (go-to-k/cdkd#5365): point-in-time recovery,
   * Contributor Insights, the Kinesis streaming destination and the two
   * resource policies — none of which rides `CreateTable` or `ReplicaUpdates` —
   * for every replica the desired side declares, the local table included,
   * each through its own region.
   *
   * `previousProperties` is `undefined` on `create()`; `freshRegions` names
   * the replicas this operation created, which hold none of the settings yet.
   * A template-side change that fails fails the operation. On `update()` a
   * DECLARED setting the template did not change is also checked against AWS
   * and corrected — before this issue none was ever sent, so a replica deployed
   * then holds none of them under a record that names them — and that
   * correction is best-effort and reported, like {@link convergeReplicaSettings}.
   */
  private async applyReplicaSettings(
    tableName: string,
    logicalId: string,
    currentRegion: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown> | undefined,
    freshRegions: ReadonlySet<unknown>,
    streamReplaced: boolean,
    // A state replay (no template to fix): a table policy refused on a replica
    // this operation created is reported rather than failing the replay.
    replaying: boolean,
    // Settings whose removal arm is skipped (see `planReplicaSettingOps`).
    keepOnRemoval: ReadonlySet<ReplicaSetting>,
    // The deploy region's stream arn BEFORE this operation, for a
    // `StreamViewType` change: the old stream stays readable for 24 h, so a
    // policy the template removed is deleted from it too.
    previousLocalStreamArn: string | undefined,
    warn: (message: string) => void,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const desired = Array.isArray(properties['Replicas'])
      ? (properties['Replicas'] as unknown[])
      : [];
    // go-to-k/cdkd#5489: a replica's per-index Contributor Insights. On a
    // create every index already exists, so it is sent here; `update()` runs
    // this pass BEFORE its GSI diff, so a new index does not exist yet, and
    // {@link applyReplicaIndexInsights} sends them all after that diff.
    const tableIndexNames =
      previousProperties === undefined
        ? new Set(indexEntriesByName(properties['GlobalSecondaryIndexes']).keys())
        : undefined;
    for (const entry of desired) {
      const replica = asRecord(entry);
      const region = replica?.['Region'];
      if (typeof region !== 'string' || region === '') continue;
      const fresh = previousProperties === undefined || freshRegions.has(region);
      const previous =
        previousProperties === undefined
          ? undefined
          : localReplicaEntry(previousProperties, region);
      const ops = planReplicaSettingOps(
        replica,
        previous,
        {
          fresh,
          streamReplaced,
          keepOnRemoval,
          ...(tableIndexNames !== undefined && { tableIndexNames }),
        },
        (reason) =>
          warn(
            `The ${region} replica of ${tableName}: ${reason}, so that setting was left as it ` +
              `is. ` +
              (replaying
                ? `The value came from a recorded state, which a template edit cannot reach.`
                : `Fix the template value and re-deploy.`)
          )
      );
      if (
        !fresh &&
        keepOnRemoval.has('pitr') &&
        replica?.['PointInTimeRecoverySpecification'] == null &&
        (() => {
          const prior = readPitrSpec(previous?.['PointInTimeRecoverySpecification']);
          return prior.kind === 'usable' && prior.enabled;
        })()
      ) {
        warn(
          `The ${region} replica of ${tableName}: point-in-time recovery was not turned off, ` +
            `although the properties being applied (a rollback's recorded state, or a drift ` +
            `--revert read-back) declare none — turning it off would delete every recovery ` +
            `point. Turn it off by hand if that is intended.`
        );
      }
      // What the template did not change but declares: checked against AWS.
      const unchanged = fresh ? new Set<ReplicaSetting>() : declaredReplicaSettings(replica);
      // Checked by `applyReplicaIndexInsights`, after `update()`'s GSI diff.
      unchanged.delete('indexContributorInsights');
      for (const op of ops) unchanged.delete(settingOf(op));
      if (ops.length === 0 && unchanged.size === 0) continue;

      const client =
        region === currentRegion ? this.dynamoDBClient : this.getRegionalClient(region);
      // A key, class or protection change moments earlier leaves the table
      // (and this replica) UPDATING, and these calls are refused meanwhile.
      await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, {
        ...(region !== currentRegion && { region }),
      });
      let arns: { tableArn?: string; streamArn?: string } | undefined;
      const describe = async (): Promise<{ tableArn?: string; streamArn?: string }> => {
        if (arns === undefined) {
          const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
          arns = {
            ...(described.Table?.TableArn !== undefined && { tableArn: described.Table.TableArn }),
            ...(described.Table?.LatestStreamArn !== undefined && {
              streamArn: described.Table.LatestStreamArn,
            }),
          };
        }
        return arns;
      };

      for (const op of ops) {
        try {
          await this.sendReplicaSettingOp(
            client,
            tableName,
            region,
            logicalId,
            op,
            describe,
            maskSecrets
          );
        } catch (error) {
          // A table policy on a replica this operation created is refused on
          // the template path (`replicaSettingsRefusal`, CloudFormation
          // parity), so only a state replay reaches here: it is reported, and
          // the next update's AWS-aware pass puts it.
          if (
            !replaying ||
            !fresh ||
            op.kind !== 'putTablePolicy' ||
            isInterruptedWaitError(error)
          ) {
            throw error;
          }
          warn(
            `The ${region} replica of ${tableName} was created without its ResourcePolicy: ` +
              `${describeAwsFailure(error).summary}. The next deploy that updates this table ` +
              `puts it.`
          );
        }
      }

      // A `StreamViewType` change leaves the OLD stream readable for 24 h
      // under its old policy. When this deploy removes or changes that policy
      // in the template, the old stream loses it too — best-effort: it may
      // already be gone. An UNCHANGED policy stays there, so a consumer still
      // draining the old stream keeps its access. Only the deploy region's
      // retired stream is known here: a cross-region replica's keeps its old
      // policy until it expires.
      const priorStreamPolicy = readStreamPolicy(previous);
      const desiredStreamPolicy = readStreamPolicy(replica);
      const streamPolicyChanged =
        priorStreamPolicy.kind !== 'absent' &&
        desiredStreamPolicy.kind !== 'unusable' &&
        !(desiredStreamPolicy.kind === 'absent' && keepOnRemoval.has('streamPolicy')) &&
        !(
          priorStreamPolicy.kind === 'usable' &&
          desiredStreamPolicy.kind === 'usable' &&
          samePolicyDocument(priorStreamPolicy.document, desiredStreamPolicy.document)
        );
      if (
        region === currentRegion &&
        streamReplaced &&
        previousLocalStreamArn !== undefined &&
        streamPolicyChanged &&
        (await describe()).streamArn !== previousLocalStreamArn
      ) {
        await this.deleteOldStreamPolicy(
          client,
          previousLocalStreamArn,
          tableName,
          warn,
          maskSecrets
        );
      }

      if (unchanged.size === 0) continue;
      const live = await this.readLiveReplicaSettings(
        client,
        tableName,
        region,
        unchanged,
        describe,
        maskSecrets,
        replica
      );
      for (const op of planReplicaSettingCorrections(replica, live, unchanged)) {
        const member = SETTING_MEMBER[settingOf(op)];
        this.logger.debug(
          maskSecrets(`Bringing the ${region} replica of ${tableName} to its declared ${member}`)
        );
        try {
          await this.sendReplicaSettingOp(
            client,
            tableName,
            region,
            logicalId,
            op,
            describe,
            maskSecrets
          );
        } catch (convergeError) {
          if (isInterruptedWaitError(convergeError)) throw convergeError;
          this.logger.debug(
            maskSecrets(
              `Could not bring the ${region} replica of ${tableName} to its declared ${member}: ` +
                describeAwsFailure(convergeError).detail
            )
          );
          this.logger.warn(
            maskSecrets(
              `The ${region} replica of ${tableName} does not hold its declared ${member}, and ` +
                `setting it failed (${describeAwsFailure(convergeError).summary}). The next ` +
                `deploy that updates this table tries again.`
            )
          );
        }
      }
    }
  }

  /**
   * Send a `GlobalTableSettingsReplicationMode` change (go-to-k/cdkd#5489) in
   * its own `UpdateTable`, as CloudFormation does, and wait for the table to
   * settle. A failure fails the update: the template asked for it.
   */
  private async sendReplicationMode(
    tableName: string,
    logicalId: string,
    mode: string,
    maskSecrets: SecretMasker,
    // `false` for a correction AWS alone asked for: a failure is reported.
    fromTemplate = true
  ): Promise<void> {
    this.logger.debug(
      maskSecrets(`Setting GlobalTableSettingsReplicationMode of ${tableName} to ${mode}`)
    );
    await this.sendLocalSettingUpdate(
      {
        TableName: tableName,
        GlobalTableSettingsReplicationMode: mode as GlobalTableSettingsReplicationMode,
      },
      fromTemplate,
      'GlobalTableSettingsReplicationMode',
      tableName,
      logicalId,
      maskSecrets
    );
  }

  /**
   * `update()`'s per-index Contributor Insights pass over every replica
   * (go-to-k/cdkd#5489), run AFTER the GSI diff so an index this update
   * created exists. The template-driven calls fail the update; a declared
   * setting the template did not change is checked against AWS and corrected
   * best-effort — before this issue none was ever sent, so a replica deployed
   * then holds none of them under a record that names them.
   */
  private async applyReplicaIndexInsights(
    tableName: string,
    logicalId: string,
    currentRegion: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    freshRegions: ReadonlySet<unknown>,
    keepOnRemoval: ReadonlySet<ReplicaSetting>,
    replaying: boolean,
    warn: (message: string) => void,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const tableIndexNames = new Set(
      indexEntriesByName(properties['GlobalSecondaryIndexes']).keys()
    );
    if (tableIndexNames.size === 0) return;
    const desired = Array.isArray(properties['Replicas'])
      ? (properties['Replicas'] as unknown[])
      : [];
    for (const entry of desired) {
      const replica = asRecord(entry);
      const region = replica?.['Region'];
      if (typeof region !== 'string' || region === '') continue;
      const fresh = freshRegions.has(region);
      const ops = planReplicaIndexInsightsOps(
        replica,
        localReplicaEntry(previousProperties, region),
        {
          fresh,
          tableIndexNames,
          removes: (setting) => !keepOnRemoval.has(setting),
        },
        (reason) =>
          warn(
            `The ${region} replica of ${tableName}: ${reason}, so that setting was left as it ` +
              `is. ` +
              (replaying
                ? `The value came from a recorded state, which a template edit cannot reach.`
                : `Fix the template value and re-deploy.`)
          )
      );
      // Declared, unchanged and on the table: checked against AWS.
      const addressed = new Set(
        ops.flatMap((op) => (op.kind === 'indexContributorInsights' ? [op.indexName] : []))
      );
      const declared = declaredIndexInsights(replica);
      const unchanged = fresh
        ? []
        : [...declared.keys()].filter((name) => tableIndexNames.has(name) && !addressed.has(name));
      if (ops.length === 0 && unchanged.length === 0) continue;

      const client =
        region === currentRegion ? this.dynamoDBClient : this.getRegionalClient(region);
      await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, {
        ...(region !== currentRegion && { region }),
      });
      // An index this update created may still be building in this region,
      // and its rules cannot be set until it is ACTIVE. Best-effort: a wait
      // that ends unconfirmed leaves AWS's own refusal as the backstop.
      await waitForIndexesSettled({
        tableName,
        logicalId,
        logger: maskedLogger(this.logger, maskSecrets, tableName),
        describeTable: () => client.send(new DescribeTableCommand({ TableName: tableName })),
        maxAttempts: 900,
        proceedNote: `setting the index's Contributor Insights may be refused.`,
      });
      // No op here addresses an arn.
      const describe = (): Promise<{ tableArn?: string; streamArn?: string }> =>
        Promise.resolve({});
      for (const op of ops) {
        await this.sendReplicaSettingOp(
          client,
          tableName,
          region,
          logicalId,
          op,
          describe,
          maskSecrets
        );
      }
      if (unchanged.length === 0) continue;
      const replicaIndexes = indexEntriesByName(replica?.['GlobalSecondaryIndexes']);
      const onlyUnchanged: Record<string, unknown> = {
        ...replica,
        GlobalSecondaryIndexes: unchanged.map((name) => replicaIndexes.get(name)),
      };
      const only = new Set<ReplicaSetting>(['indexContributorInsights']);
      const live = await this.readLiveReplicaSettings(
        client,
        tableName,
        region,
        only,
        describe,
        maskSecrets,
        onlyUnchanged
      );
      for (const op of planReplicaSettingCorrections(onlyUnchanged, live, only)) {
        try {
          await this.sendReplicaSettingOp(
            client,
            tableName,
            region,
            logicalId,
            op,
            describe,
            maskSecrets
          );
        } catch (convergeError) {
          if (isInterruptedWaitError(convergeError)) throw convergeError;
          this.logger.warn(
            maskSecrets(
              `The ${region} replica of ${tableName} does not hold the declared ` +
                `${SETTING_MEMBER.indexContributorInsights} of an index, and setting it failed ` +
                `(${describeAwsFailure(convergeError).summary}). The next deploy that updates ` +
                `this table tries again.`
            )
          );
        }
      }
    }
  }

  /**
   * What AWS reports for the given settings of one replica. Each read is
   * best-effort: a failure leaves that setting unknown, and an unknown setting
   * is never corrected.
   */
  private async readLiveReplicaSettings(
    client: DynamoDBClient,
    tableName: string,
    region: string,
    wanted: ReadonlySet<ReplicaSetting>,
    describe: () => Promise<{ tableArn?: string; streamArn?: string }>,
    maskSecrets: SecretMasker,
    // The desired replica entry: names the indexes whose read is wanted.
    declared?: Record<string, unknown>
  ): Promise<LiveReplicaSettings> {
    const live: LiveReplicaSettings = {};
    const attempt = async (what: string, read: () => Promise<void>): Promise<void> => {
      try {
        await read();
      } catch (readError) {
        this.logger.debug(
          maskSecrets(
            `Could not read ${what} of the ${region} replica of ${tableName}: ` +
              describeAwsFailure(readError).detail
          )
        );
      }
    };
    if (wanted.has('pitr')) {
      await attempt('point-in-time recovery', async () => {
        const out = await client.send(
          new DescribeContinuousBackupsCommand({ TableName: tableName })
        );
        const pitr = out.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
        const status = pitr?.PointInTimeRecoveryStatus;
        // ENABLING / DISABLING are on their way: nothing to correct yet.
        if (status === 'ENABLED' || status === 'DISABLED') {
          live.pitr = {
            enabled: status === 'ENABLED',
            ...(pitr?.RecoveryPeriodInDays !== undefined && {
              recoveryPeriodInDays: pitr.RecoveryPeriodInDays,
            }),
          };
        }
      });
    }
    if (wanted.has('contributorInsights')) {
      await attempt('Contributor Insights', async () => {
        const out = await client.send(
          new DescribeContributorInsightsCommand({ TableName: tableName })
        );
        const status = out.ContributorInsightsStatus;
        if (status === 'ENABLED' || status === 'ENABLING') live.contributorInsightsEnabled = true;
        else if (status === 'DISABLED' || status === 'DISABLING') {
          live.contributorInsightsEnabled = false;
        }
      });
    }
    if (wanted.has('kinesis')) {
      await attempt('the Kinesis streaming destination', async () => {
        live.kinesisStreamArns = await this.activeKinesisStreamArns(client, tableName);
      });
    }
    const hasPolicy = async (arn: string | undefined): Promise<boolean | undefined> => {
      if (arn === undefined) return undefined;
      try {
        await client.send(new GetResourcePolicyCommand({ ResourceArn: arn }));
        return true;
      } catch (error) {
        if (error instanceof PolicyNotFoundException) return false;
        throw error;
      }
    };
    if (wanted.has('tablePolicy')) {
      await attempt('the resource policy', async () => {
        const answer = await hasPolicy((await describe()).tableArn);
        if (answer !== undefined) live.hasTablePolicy = answer;
      });
    }
    if (wanted.has('streamPolicy')) {
      await attempt('the stream resource policy', async () => {
        const answer = await hasPolicy((await describe()).streamArn);
        if (answer !== undefined) live.hasStreamPolicy = answer;
      });
    }
    if (wanted.has('indexContributorInsights')) {
      const perIndex = new Map<string, boolean>();
      for (const indexName of declaredIndexInsights(declared).keys()) {
        await attempt(`Contributor Insights of an index`, async () => {
          const out = await client.send(
            new DescribeContributorInsightsCommand({ TableName: tableName, IndexName: indexName })
          );
          const status = out.ContributorInsightsStatus;
          // ENABLING / DISABLING are on their way: nothing to correct yet.
          if (status === 'ENABLED' || status === 'DISABLED') {
            perIndex.set(indexName, status === 'ENABLED');
          }
        });
      }
      live.indexContributorInsightsEnabled = perIndex;
    }
    if (wanted.has('streamTags')) {
      await attempt('the stream tags', async () => {
        const arn = (await describe()).streamArn;
        if (arn === undefined) return;
        const tags = new Map<string, string>();
        let nextToken: string | undefined;
        do {
          const out = await client.send(
            new ListTagsOfResourceCommand({ ResourceArn: arn, NextToken: nextToken })
          );
          for (const t of out.Tags ?? []) {
            if (t.Key !== undefined) tags.set(t.Key, t.Value ?? '');
          }
          nextToken = out.NextToken;
        } while (nextToken !== undefined);
        live.streamTags = tags;
      });
    }
    return live;
  }

  /**
   * Delete the resource policy of a stream a `StreamViewType` change retired.
   * No policy, or no stream any more, is the goal; anything else is reported,
   * since the deploy itself succeeded and the old stream expires in 24 h.
   */
  private async deleteOldStreamPolicy(
    client: DynamoDBClient,
    streamArn: string,
    tableName: string,
    warn: (message: string) => void,
    maskSecrets: SecretMasker
  ): Promise<void> {
    try {
      markUnsettled('Replicas');
      await this.retrySettlingRefusal(
        () => client.send(new DeleteResourcePolicyCommand({ ResourceArn: streamArn })),
        `delete the policy of the retired stream of ${tableName}`,
        maskSecrets
      );
    } catch (error) {
      if (isInterruptedWaitError(error)) throw error;
      if (error instanceof PolicyNotFoundException || error instanceof ResourceNotFoundException) {
        return;
      }
      warn(
        `The previous stream of ${tableName} (retired by the StreamViewType change) keeps its ` +
          `old resource policy until it expires: deleting it failed ` +
          `(${describeAwsFailure(error).summary}).`
      );
    }
  }

  /**
   * After a refused Kinesis enable / disable: whether the table streams to
   * `streamArn` now. An interrupt, or a read that fails, rethrows the ORIGINAL
   * refusal rather than hiding it behind the read's own error.
   */
  private async kinesisStreaming(
    client: DynamoDBClient,
    tableName: string,
    streamArn: string,
    refusal: unknown
  ): Promise<boolean> {
    if (isInterruptedWaitError(refusal)) throw refusal;
    try {
      return (await this.activeKinesisStreamArns(client, tableName)).has(streamArn);
    } catch {
      throw refusal;
    }
  }

  /**
   * The pauses between re-reads of a Kinesis destination this update
   * disabled. `DisableKinesisStreamingDestination` answers `DISABLING`, and
   * the first `DescribeKinesisStreamingDestination` after it read `ACTIVE` in
   * one run and `DISABLING` in another, then `DISABLED` about a second later
   * (measured us-east-1, 2026-10-28). The deploy captures its drift baseline
   * right after the update, so a capture inside that window recorded a
   * destination AWS was removing, and every later `cdkd drift` reported it
   * (go-to-k/cdkd#5399's integ).
   */
  protected kinesisDisableSettleDelaysMs: readonly number[] = Array<number>(30).fill(2000);

  /**
   * Wait until no entry for `streamArn` among `tableName`'s destinations is
   * `ACTIVE`, `ENABLING`, `UPDATING` or `DISABLING` (the read-back's present
   * set, plus `DISABLING`, which is still settling: a later read can flicker
   * back to `ACTIVE`, above). Best-effort, since the disable itself was accepted: a
   * failed read ends the wait with a debug line, and running out of re-reads
   * or of the resource deadline ends it with a warning.
   */
  private async waitForKinesisDisableSettled(
    client: DynamoDBClient,
    tableName: string,
    streamArn: string,
    scope: string,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const watch = startInterruptWatch(maskSecrets(`Kinesis streaming disable on ${scope}`));
    let last = 'none read';
    try {
      for (const delayMs of [0, ...this.kinesisDisableSettleDelaysMs]) {
        // The engine's deadline does not cancel this update: a wait that
        // outlived it would keep polling with nobody waiting on it.
        if (enclosingDeadlineRemainingMs() <= 0) break;
        if (delayMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, Math.min(delayMs, enclosingDeadlineRemainingMs())))
          );
        }
        if (watch.isInterrupted()) throw watch.onInterrupted();
        let unsettled: string | undefined;
        try {
          const out = await client.send(
            new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
          );
          // Judged across EVERY entry for the stream: history entries (a
          // DISABLED or ENABLE_FAILED one) linger beside the current entry,
          // and neither may decide the wait on its own.
          unsettled = (out.KinesisDataStreamDestinations ?? []).find(
            (d) =>
              d.StreamArn === streamArn && KINESIS_DISABLE_UNSETTLED.has(d.DestinationStatus ?? '')
          )?.DestinationStatus;
        } catch (error) {
          this.logger.debug(
            maskSecrets(
              `Could not confirm the Kinesis streaming disable on ${scope}: ` +
                describeAwsFailure(error).detail
            )
          );
          return;
        }
        if (unsettled === undefined) return;
        last = unsettled;
      }
      this.logger.warn(
        maskSecrets(
          `The Kinesis streaming destination on ${scope} had not settled ` +
            `(last status: ${last}); 'cdkd drift' may report it on this replica until it does`
        )
      );
    } finally {
      watch.dispose();
    }
  }

  /** The Kinesis streams a table streams to (`ACTIVE` or `ENABLING`). */
  private async activeKinesisStreamArns(
    client: DynamoDBClient,
    tableName: string
  ): Promise<Set<string>> {
    const out = await client.send(
      new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
    );
    return new Set(
      (out.KinesisDataStreamDestinations ?? [])
        .filter((d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING')
        .flatMap((d) => (d.StreamArn !== undefined ? [d.StreamArn] : []))
    );
  }

  /**
   * Send ONE {@link ReplicaSettingOp} through the replica's own region,
   * retrying the "settling" refusals DynamoDB returns while an earlier change
   * on the table is still in flight (enabling point-in-time recovery, say).
   * The policy text is never logged: it names principals and can carry a
   * resolved secret in a condition value.
   */
  private async sendReplicaSettingOp(
    client: DynamoDBClient,
    tableName: string,
    region: string,
    logicalId: string,
    op: ReplicaSettingOp,
    describe: () => Promise<{ tableArn?: string; streamArn?: string }>,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const scope = `the ${region} replica of ${tableName}`;
    const arnFor = async (which: 'tableArn' | 'streamArn'): Promise<string> => {
      const arn = (await describe())[which];
      if (arn === undefined || arn === '') {
        throw new ProvisioningError(
          maskSecrets(
            `Cannot apply ${SETTING_MEMBER[settingOf(op)]} to ${scope}: DescribeTable returned ` +
              `no ${which === 'tableArn' ? 'TableArn' : 'LatestStreamArn (the table has no stream)'}`
          ),
          'AWS::DynamoDB::GlobalTable',
          logicalId,
          tableName
        );
      }
      return arn;
    };
    const send = (call: () => Promise<unknown>): Promise<void> => {
      // go-to-k/cdkd#5487: every op here changes a replica member.
      markUnsettled('Replicas');
      return this.retrySettlingRefusal(call, `${op.kind} on ${scope}`, maskSecrets);
    };
    switch (op.kind) {
      case 'pitr':
        await send(() =>
          client.send(
            new UpdateContinuousBackupsCommand({
              TableName: tableName,
              PointInTimeRecoverySpecification: {
                PointInTimeRecoveryEnabled: op.enabled,
                ...(op.recoveryPeriodInDays !== undefined && {
                  RecoveryPeriodInDays: op.recoveryPeriodInDays,
                }),
              },
            })
          )
        );
        break;
      case 'contributorInsights':
        await send(() =>
          client.send(
            new UpdateContributorInsightsCommand({
              TableName: tableName,
              ContributorInsightsAction: op.action,
              ...(op.mode !== undefined && {
                ContributorInsightsMode: op.mode as ContributorInsightsMode,
              }),
            })
          )
        );
        break;
      case 'kinesisEnable':
        // Already streaming there (a re-run): enabling it again is refused, and
        // that refusal can be one the settling retry would wait out first.
        // A read that fails here falls through to the enable, which decides.
        if (
          await this.activeKinesisStreamArns(client, tableName).then(
            (arns) => arns.has(op.streamArn),
            () => false
          )
        ) {
          break;
        }
        try {
          await send(() =>
            client.send(
              new EnableKinesisStreamingDestinationCommand({
                TableName: tableName,
                StreamArn: op.streamArn,
                ...(op.precision !== undefined && {
                  EnableKinesisStreamingConfiguration: {
                    ApproximateCreationDateTimePrecision:
                      op.precision as ApproximateCreationDateTimePrecision,
                  },
                }),
              })
            )
          );
        } catch (error) {
          // A re-run after a deploy that enabled it and failed before state
          // recorded it: the destination is what the template asks for.
          if (!(await this.kinesisStreaming(client, tableName, op.streamArn, error))) throw error;
        }
        break;
      case 'kinesisDisable':
        try {
          await send(() =>
            client.send(
              new DisableKinesisStreamingDestinationCommand({
                TableName: tableName,
                StreamArn: op.streamArn,
              })
            )
          );
        } catch (error) {
          // Already off (a re-run, or an out-of-band disable) is the goal.
          if (await this.kinesisStreaming(client, tableName, op.streamArn, error)) throw error;
        }
        await this.waitForKinesisDisableSettled(
          client,
          tableName,
          op.streamArn,
          scope,
          maskSecrets
        );
        break;
      case 'kinesisPrecision':
        await send(() =>
          client.send(
            new UpdateKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: op.streamArn,
              UpdateKinesisStreamingConfiguration: {
                ApproximateCreationDateTimePrecision:
                  op.precision as ApproximateCreationDateTimePrecision,
              },
            })
          )
        );
        break;
      case 'putTablePolicy':
      case 'putStreamPolicy': {
        const arn = await arnFor(op.kind === 'putTablePolicy' ? 'tableArn' : 'streamArn');
        await send(() =>
          client.send(new PutResourcePolicyCommand({ ResourceArn: arn, Policy: op.document }))
        );
        break;
      }
      case 'deleteTablePolicy':
      case 'deleteStreamPolicy': {
        // No stream left means no stream policy left: the goal.
        if (op.kind === 'deleteStreamPolicy' && (await describe()).streamArn === undefined) break;
        const arn = await arnFor(op.kind === 'deleteTablePolicy' ? 'tableArn' : 'streamArn');
        try {
          await send(() => client.send(new DeleteResourcePolicyCommand({ ResourceArn: arn })));
        } catch (error) {
          // No policy left to remove is the goal.
          if (!(error instanceof PolicyNotFoundException)) throw error;
        }
        break;
      }
      case 'indexContributorInsights':
        await send(() =>
          client.send(
            new UpdateContributorInsightsCommand({
              TableName: tableName,
              IndexName: op.indexName,
              ContributorInsightsAction: op.action,
              ...(op.mode !== undefined && {
                ContributorInsightsMode: op.mode as ContributorInsightsMode,
              }),
            })
          )
        );
        break;
      case 'untagStream': {
        // No stream left means no stream tags left: the goal.
        if ((await describe()).streamArn === undefined) break;
        const arn = await arnFor('streamArn');
        await send(() =>
          client.send(new UntagResourceCommand({ ResourceArn: arn, TagKeys: op.keys }))
        );
        break;
      }
      case 'tagStream': {
        const arn = await arnFor('streamArn');
        await send(() => client.send(new TagResourceCommand({ ResourceArn: arn, Tags: op.tags })));
        break;
      }
    }
    this.logger.debug(maskSecrets(`Applied ${op.kind} to ${scope}`));
  }

  /**
   * Retry a call DynamoDB refused only because an earlier change on the table
   * is still settling ("Backups are being enabled ... retry later",
   * `ResourceInUseException`, `LimitExceededException`). Bounded (about two
   * minutes) and interruptible, like the other waits here.
   */
  private async retrySettlingRefusal(
    call: () => Promise<unknown>,
    label: string,
    maskSecrets: SecretMasker
  ): Promise<void> {
    const watch = startInterruptWatch(maskSecrets(`DynamoDB ${label}`));
    try {
      let delayMs = SETTLING_RETRY_INITIAL_MS;
      for (let attempt = 1; ; attempt++) {
        try {
          await call();
          return;
        } catch (error) {
          const detail = describeAwsFailure(error).detail;
          const name = error instanceof Error ? error.name : '';
          const settling =
            /being enabled|being updated|please retry later|backups are being/i.test(detail) ||
            name === 'ResourceInUseException' ||
            name === 'LimitExceededException';
          if (!settling || attempt >= SETTLING_RETRY_ATTEMPTS) throw error;
          this.logger.debug(
            maskSecrets(
              `Transient refusal of ${label} (attempt ${attempt}/${SETTLING_RETRY_ATTEMPTS}): ` +
                `${detail} - retrying in ${delayMs}ms`
            )
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (watch.isInterrupted()) throw watch.onInterrupted();
          delayMs = Math.min(delayMs * 2, 30000);
        }
      }
    } finally {
      watch.dispose();
    }
  }

  /**
   * Step 3's `TableClass` / `SSESpecification` call, each alone, waited out
   * across the global table. A template change that fails fails the update;
   * a correction AWS alone asked for is reported and left for the next
   * update (go-to-k/cdkd#5355).
   */
  private async sendLocalSettingUpdate(
    input: UpdateTableCommandInput,
    fromTemplate: boolean,
    what: string,
    tableName: string,
    logicalId: string,
    maskSecrets: SecretMasker
  ): Promise<void> {
    try {
      // go-to-k/cdkd#5487: SSE is a table key; the other local settings sent
      // here (TableClass, the replication mode) are replica members.
      markUnsettled(input.SSESpecification !== undefined ? 'SSESpecification' : 'Replicas');
      await this.dynamoDBClient.send(new UpdateTableCommand(input));
      await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
    } catch (error) {
      if (fromTemplate || isInterruptedWaitError(error)) throw error;
      this.logger.debug(
        maskSecrets(
          `Could not bring the ${what} of ${tableName} to the declared one: ` +
            describeAwsFailure(error).detail
        )
      );
      this.logger.warn(
        maskSecrets(
          `${tableName} does not hold its declared ${what}, and setting it failed ` +
            `(${describeAwsFailure(error).summary}).` +
            relayedEncryptionChangeLimit(describeAwsFailure(error).detail) +
            ` The next deploy that updates this table tries again.`
        )
      );
    }
  }

  /**
   * The read capacity of each cross-region replica that a
   * `ProvisionedThroughput` of `sendRead` would change, read in its own region.
   */
  private async readRegionReadsToRestore(
    tableName: string,
    replicas: readonly ReplicaDescription[],
    currentRegion: string,
    sendRead: number
  ): Promise<Array<{ region: string; read: number }>> {
    const reads: Array<{ region: string; read: number }> = [];
    for (const replica of replicas) {
      const region = replica.RegionName;
      if (region === undefined || region === currentRegion) continue;
      const regional = await this.getRegionalClient(region).send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const read =
        regional.Table?.ProvisionedThroughput?.ReadCapacityUnits ??
        replica.ProvisionedThroughputOverride?.ReadCapacityUnits;
      if (read !== undefined && read !== sendRead) reads.push({ region, read });
    }
    return reads;
  }

  /**
   * Wait until the table, every replica it lists and its encryption all read
   * as settled — what a table-class, encryption or replica-key change leaves
   * in flux across the regions, and what the next change on the table is
   * refused until (go-to-k/cdkd#5355).
   */
  private async waitForGlobalTableSettled(
    tableName: string,
    logicalId: string,
    maskSecrets: SecretMasker,
    opts: {
      // Also require this replica region's own table to read ACTIVE.
      region?: string;
      budget?: ElapsedBudget | undefined;
      maxPolls?: number;
      // `false` only for the compensation after a Ctrl-C, which must still
      // run; it stays bounded by `maxPolls`.
      interruptible?: boolean;
    } = {}
  ): Promise<void> {
    const wait = beginDeleteWait(opts.maxPolls ?? GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS, opts.budget);
    const watch = startInterruptWatch(
      maskSecrets(`DynamoDB global table ${tableName} settling after an update`)
    );
    try {
      while (wait.nextPoll()) {
        if (opts.interruptible !== false && watch.isInterrupted()) throw watch.onInterrupted();
        const response = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const table = response.Table;
        if (
          table?.TableStatus === 'ACTIVE' &&
          table.SSEDescription?.Status !== 'UPDATING' &&
          (table.Replicas ?? []).every((r) => r.ReplicaStatus === 'ACTIVE')
        ) {
          if (opts.region === undefined) return;
          const replica = await this.getRegionalClient(opts.region).send(
            new DescribeTableCommand({ TableName: tableName })
          );
          if (replica.Table?.TableStatus === 'ACTIVE') return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      watch.dispose();
    }
    throw new ProvisioningError(
      maskSecrets(
        `Table ${tableName} and its replicas did not settle within ${wait.pollsRun} polls${wait.note()}`
      ),
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * `delete()`'s cross-region replica drop. Under `--remove-protection` the
   * replica's own deletion protection (go-to-k/cdkd#5355) is turned off first,
   * the same flag the local table's flip honours; without the flag AWS refuses
   * a protected replica's drop and that refusal propagates, as the local
   * table's `DeleteTable` refusal does.
   *
   * Observe-then-flip like the local flip (issue #1978): only a guard that was
   * ON and that this call turned off is put back, and only when AWS refused
   * the drop (or the wait before it failed) — once the drop is accepted the
   * replica is on its way out.
   * DynamoDB throttles a second deletion-protection change on one table
   * within {@link DELETION_PROTECTION_REFLIP_MS} of the first (measured
   * 2026-10-26: `ThrottlingException: Deletion protection setting for table X
   * modified within the previous 15000 milliseconds`), so the restore waits
   * that window out once before giving up and saying how to restore it.
   */
  private async dropReplicaForDelete(
    tableName: string,
    region: string,
    removeProtection: boolean,
    logicalId: string,
    budget: ElapsedBudget,
    maskSecrets: SecretMasker
  ): Promise<void> {
    let flippedOff = false;
    if (removeProtection) {
      try {
        const before = await this.getRegionalClient(region).send(
          new DescribeTableCommand({ TableName: tableName })
        );
        if (before.Table?.DeletionProtectionEnabled === true) {
          await this.sendReplicaDeletionProtection(
            tableName,
            region,
            false,
            logicalId,
            maskSecrets,
            {
              budget,
            }
          );
          flippedOff = true;
        }
      } catch (flipError) {
        // A Ctrl-C in the wait before the write stops the destroy; nothing
        // was turned off yet, so there is nothing to put back.
        if (isInterruptedWaitError(flipError)) throw flipError;
        // Best-effort like the local flip: a guard left on makes the drop
        // below refuse, and that refusal is what the user sees.
        this.logger.debug(
          maskSecrets(
            `Could not disable DeletionProtectionEnabled on the ${region} replica of ${tableName}: ` +
              describeAwsFailure(flipError).detail
          )
        );
      }
      if (flippedOff) {
        // Outside the best-effort catch: the source refuses the drop until
        // the change settles, and a wait that runs out or is interrupted must
        // stop the delete — with the guard put back first.
        try {
          await this.waitForReplicaProtectionSettled(
            tableName,
            region,
            false,
            logicalId,
            maskSecrets,
            budget
          );
        } catch (waitError) {
          // The throttle wait runs even after a Ctrl-C: a replica left
          // unprotected costs more than 16 s.
          await this.restoreReplicaDeletionProtection(
            tableName,
            region,
            logicalId,
            maskSecrets,
            isInterruptedWaitError(waitError)
              ? 'the destroy was interrupted'
              : 'its deletion-protection change did not settle'
          );
          throw waitError;
        }
      }
    }
    try {
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: tableName,
          ReplicaUpdates: [{ Delete: { RegionName: region } }],
        })
      );
    } catch (dropError) {
      if (flippedOff) {
        await this.restoreReplicaDeletionProtection(
          tableName,
          region,
          logicalId,
          maskSecrets,
          'it could not be dropped'
        );
      }
      throw dropError;
    }
  }

  /** {@link dropReplicaForDelete}'s compensation; never throws. */
  private async restoreReplicaDeletionProtection(
    tableName: string,
    region: string,
    logicalId: string,
    maskSecrets: SecretMasker,
    // Why the delete stopped, as the warning states it.
    reason: string
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        // Settled first like every protection write, but this compensation
        // runs after a Ctrl-C or a wait that ran out too: the wait is short,
        // not interruptible, runs once (the throttle retry already waited
        // out its window), and the write is attempted whatever it found.
        if (attempt === 1) {
          await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, {
            region,
            maxPolls: REPLICA_PROTECTION_SETTLE_POLLS,
            interruptible: false,
          }).catch(() => undefined);
        }
        await this.writeReplicaDeletionProtection(tableName, region, true);
        return;
      } catch (restoreError) {
        if (
          attempt === 1 &&
          restoreError instanceof Error &&
          restoreError.name === 'ThrottlingException'
        ) {
          await new Promise((resolve) => setTimeout(resolve, DELETION_PROTECTION_REFLIP_MS));
          continue;
        }
        try {
          // The class at warn, AWS's text at debug (go-to-k/cdkd#2319).
          this.logger.debug(
            maskSecrets(
              `Could not restore DeletionProtectionEnabled on the ${region} replica of ` +
                `${tableName}: ${describeAwsFailure(restoreError).detail}`
            )
          );
          const head = maskSecrets(
            `The ${region} replica of ${tableName} was not deleted (${reason}), and its ` +
              `deletion protection, which this destroy turned off, could not be turned back on ` +
              `(${describeAwsFailure(restoreError).summary}). It is LEFT UNPROTECTED. ` +
              `To restore it, run: `
          );
          const command = pasteableAwsCommand(
            maskSecrets
          )`aws dynamodb update-table --table-name ${tableName} --deletion-protection-enabled --region ${region}`.render();
          this.logger.warn(safeMsg`${head}${command}`);
        } catch {
          // A throwing logger must not replace the drop error on its way out.
        }
        return;
      }
    }
  }

  /**
   * Poll the replica REGION for its same-named table until it is gone,
   * answering `true` once it is (so the replica-add may be retried) and
   * `false` for anything that is not a copy on its way out: a table in any
   * status but `DELETING`, a probe error, or the cap running out. Only ever
   * READS the region — the caller re-throws AWS's own refusal on `false`.
   * Interruptible, like every other bounded wait on this provider's paths.
   */
  private async waitForRegionalCopyReleased(
    tableName: string,
    region: string,
    // Both lines below name the RESOLVED table name, and the debug one quotes
    // AWS's error text, which often echoes it (issue #1997's contract).
    maskSecrets: SecretMasker
  ): Promise<boolean> {
    const client = this.getRegionalClient(region);
    // Masked: the label reaches the user in `InterruptedWaitError`'s message
    // on Ctrl-C, and `tableName` is the resolved name.
    const watch = startInterruptWatch(
      maskSecrets(`DynamoDB ${region} copy of ${tableName} to finish deleting`)
    );
    let announced = false;
    try {
      for (let poll = 0; poll < REPLICA_COPY_RELEASE_POLLS; poll++) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        let status: string | undefined;
        try {
          const response = await client.send(new DescribeTableCommand({ TableName: tableName }));
          status = response.Table?.TableStatus;
        } catch (probeError) {
          if (probeError instanceof ResourceNotFoundException) return true;
          this.logger.debug(
            maskSecrets(
              `Could not read the ${region} copy of ${tableName}: ${describeAwsFailure(probeError).detail}`
            )
          );
          return false;
        }
        if (status !== 'DELETING') return false;
        if (!announced) {
          this.logger.info(
            maskSecrets(
              `The ${region} copy of ${tableName} is still being deleted; waiting for it before adding the replica`
            )
          );
          announced = true;
        }
        await new Promise((resolve) => setTimeout(resolve, REPLICA_COPY_RELEASE_POLL_MS));
      }
      return false;
    } finally {
      watch.dispose();
    }
  }

  /**
   * Update a DynamoDB Global Table in place.
   *
   * AWS-side state-machine constraint: `UpdateTable` does not accept
   * `ReplicaUpdates` alongside `BillingMode` / `GlobalSecondaryIndexUpdates`,
   * so each category must serialize into its own SDK round-trip with a
   * `waitForTableActiveAfterUpdate` between every step. `BillingMode` and
   * `GlobalSecondaryIndexUpdates` DO combine, and only in step 4's
   * `PAY_PER_REQUEST -> PROVISIONED` flip, which AWS requires to carry
   * per-GSI `ProvisionedThroughput` in the same call (Issue #1387).
   * Order:
   *   1. Wait for current ACTIVE (defensive).
   *   2. Tags diff (TagResource / UntagResource — no wait needed).
   *   3. Non-conflicting flat fields (DeletionProtectionEnabled / TableClass
   *      / SSESpecification / StreamSpecification / OnDemandThroughput)
   *      in one combined `UpdateTableCommand`. Wait ACTIVE.
   *   4. BillingMode flip (separate UpdateTable). Wait ACTIVE.
   *   5. Replica diff (serial per Create / Update / Delete). Wait ACTIVE
   *      after each.
   *   6. GSI diff (serial per Create / Update / Delete; new GSIs may need
   *      additional AttributeDefinitions). Wait ACTIVE after each.
   *   7. TimeToLiveSpecification toggle.
   *
   * Immutable properties (TableName / KeySchema / AttributeDefinitions
   * removals / LocalSecondaryIndexes changes) throw `ProvisioningError`
   * naming the offending field — the deploy engine's diff classifier
   * should catch these as REPLACEMENT before ever calling `update()`,
   * but the guard is defense-in-depth.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#5487: the sends below are spread over many helpers (some
    // shared with create / delete), so the update's marks reach them through
    // an async-local scope rather than a parameter on each: only a send made
    // inside THIS update marks, and concurrent updates never share a scope.
    return unsettledScope.run(
      {
        mark: (key) => context?.markUnsettled?.(key),
        unsettled: context?.unsettledProperties ?? new Set(),
        attempted: (path, items) => context?.markAttempted?.(path, items),
      },
      () =>
        this.updateInScope(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context
        )
    );
  }

  private async updateInScope(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    // Read for two things. `maskSecrets` (issue #1932 item 3, adopted here by
    // issue #1997): the update path carries the same RESOLVED bag as
    // `create()`, so the masking requirement is identical on both — a masker on
    // one path and not the other is a fix with a hole in the shape of whichever
    // path a given deploy takes. And the ORIGIN of the desired bag
    // (`replayingState` / `desiredFromAwsReadback`), which decides whether the
    // template-path refusals below refuse or the warn arms downgrade.
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#5381: a `drift --revert` desired side omits a replica member
    // it never recorded; that absence is not a removal.
    if (context?.desiredFromAwsReadback === true) {
      properties = keepUnreadReplicaMembers(properties, previousProperties);
    }
    // ONE masked sink for every warning in this method (issue #1997), rather
    // than a `maskSecrets(...)` at each `this.logger.warn` call: a warning added
    // later is masked by construction instead of by the author remembering. It
    // is the OUTER of two layers — a finished message is always longer than the
    // value inside it, so it can only reach `maskSecretsInText`'s SUBSTRING arm,
    // which ignores needles below `MIN_NEEDLE_LENGTH` (4). The per-value masking
    // below is the inner layer, handing the masker each raw string so it reaches
    // the WHOLE-VALUE arm at any length and BEFORE `JSON.stringify` escapes it.
    //
    // The sinks carry the table-name needle too (issue #2177): the physical id
    // IS the table name, paired with BOTH sides' `TableName`, so a name the
    // previous side recorded as a `{{resolve:` reference (a rotated secret,
    // whose plaintext this deploy's bag may not hold) is masked as well.
    const log = this.operationSinks(context, [
      [properties['TableName'], physicalId],
      [previousProperties['TableName'], physicalId],
    ]);
    const maskSecrets: SecretMasker = log.mask;
    const warn = log.warn;
    // `physicalId` is the resolved table name, so the entry line needs the
    // sink too (issue #1997) — found by a test asserting on the debug
    // stream rather than by review.
    const debug = log.debug;
    debug(`Updating DynamoDB GlobalTable ${logicalId}: ${log.value(physicalId)}`);
    // go-to-k/cdkd#3994: a malformed desired `Replicas[].Tags` is refused
    // before any call.
    refuseMalformedReplicaTags(properties, resourceType, logicalId, physicalId);
    // go-to-k/cdkd#5570: refused before any call on the template path; warned
    // on a state replay or a drift revert (see disassociationProtectionRefusal).
    const disassociationRefusal = disassociationProtectionRefusal(
      properties,
      previousProperties,
      logicalId
    );
    if (disassociationRefusal !== undefined) {
      if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
        throw new ProvisioningError(
          log.mask(disassociationRefusal),
          resourceType,
          logicalId,
          physicalId
        );
      }
      warn(
        `${disassociationRefusal} Proceeding: this update restores a recorded or read-back configuration.`
      );
    }

    // ─── Immutable property guards (defense-in-depth) ───────────────────
    // Issue [#2610] sites 5-7. The three refusals below advise a replacement,
    // and the bare `--replace` they used to name was wrong twice over.
    //
    // 1. `AWS::DynamoDB::GlobalTable` is in `STATEFUL_TYPES`, so the deploy
    //    engine's `--replace` fallback refuses a second time with
    //    STATEFUL_REPLACE_BLOCKED unless `--force-stateful-recreation` is also
    //    passed.
    // 2. Neither flag can clear `DeletionProtectionEnabled`: the replacement's
    //    DELETE runs from the deploy engine, which never sets
    //    `DeleteContext.removeProtection` — `delete()`'s flip-off is gated on
    //    exactly that field. See `../replacement-protection-advice.ts`.
    //
    // Read the RECORDED bag: all three guards fire before any `UpdateTable` in
    // this method, so AWS still holds what `previousProperties` records. The
    // resolution goes through `extractLocalDeletionProtection`, the SAME helper
    // `create()` uses — the property is per-replica in this type's CFn schema
    // (`Replicas[?Region==<deploy region>].DeletionProtectionEnabled`) with a
    // top-level fallback, and a second spelling of that rule is how the two
    // would come to disagree about which table is protected.
    //
    // An ASYNC THUNK, and both halves of that are decisions. It is a THUNK
    // because all three guards are defence-in-depth (the replacement layer
    // normally routes these changes away), so an ordinary `update()` must not
    // pay for a sentence nothing will read. It is ASYNC because it resolves the
    // client region ITSELF, lazily, rather than hoisting the method's own
    // `currentRegion` above the guards: an earlier revision did hoist it, and
    // the review of PR go-to-k/cdkd#2662 showed the cure was worse than the
    // complaint. `config.region()` can REJECT, so hoisting it made a
    // region-resolution error pre-empt the immutable-property refusal; wrapping
    // THAT in a try/catch then degraded the method-wide `currentRegion` to `''`
    // for its ~40 other uses -- including the replica diff loops, whose
    // `region === currentRegion` skip is the only thing keeping the LOCAL
    // replica from being issued a `Delete`. This file's delete path refuses
    // outright on an unresolvable region for exactly that reason. Resolving
    // inside the thunk keeps the method's read fail-CLOSED and unmoved, and
    // bounds the degradation to one sentence: an unresolved region here means
    // `extractLocalDeletionProtection` finds no local replica and falls back to
    // the top-level flag, i.e. the short advice -- the same direction
    // protection-enabled-out-of-band already takes.
    const replaceFlags = 'cdkd deploy --replace --force-stateful-recreation';
    const replaceRemedy = async (): Promise<string> => {
      let guardRegion = '';
      try {
        guardRegion = (await this.dynamoDBClient.config.region()) ?? '';
      } catch {
        guardRegion = '';
      }
      // A protected CROSS-REGION replica blocks the replacement's delete too:
      // AWS refuses that replica's drop (go-to-k/cdkd#5355). Named with its
      // region, since that is where the guard has to come off.
      // An unresolved region cannot tell the local entry from the others, so
      // nothing is named then (the degradation the note above bounds).
      const protectedReplica =
        guardRegion === '' ||
        extractLocalDeletionProtection(previousProperties, guardRegion) === true
          ? undefined
          : (Array.isArray(previousProperties['Replicas'])
              ? (previousProperties['Replicas'] as unknown[])
              : []
            )
              .map(asRecord)
              .find(
                (r) =>
                  typeof r?.['Region'] === 'string' &&
                  r['Region'] !== guardRegion &&
                  coerceCfnBoolean(r['DeletionProtectionEnabled']) === true
              )?.['Region'];
      if (typeof protectedReplica === 'string') {
        return protectedReplacementAdvice({
          evidence:
            "cdkd's recorded properties for this table carry " +
            `DeletionProtectionEnabled: true for the ${protectedReplica} replica`,
          replaceFlags,
          disable: {
            before: 'aws dynamodb update-table --table-name',
            identifier: physicalId,
            after: '--no-deletion-protection-enabled',
            caveat: "Run it with --region set to that replica's region.",
            maskSecrets,
          },
        });
      }
      return extractLocalDeletionProtection(previousProperties, guardRegion) === true
        ? protectedReplacementAdvice({
            evidence:
              "cdkd's recorded properties for this table carry " +
              'DeletionProtectionEnabled: true for the deploy region',
            replaceFlags,
            disable: {
              before: 'aws dynamodb update-table --table-name',
              identifier: physicalId,
              after: '--no-deletion-protection-enabled',
              // A secret-derived table name withholds the command (issue #2177).
              maskSecrets,
            },
          })
        : `replacement required (deploy with ${replaceFlags}, or destroy + redeploy)`;
    };
    // A secret-derived `TableName` is recorded as its `{{resolve:...}}`
    // reference and handed here resolved: the physical id, which IS the table
    // name, decides instead (go-to-k/cdkd#4275).
    if (
      properties['TableName'] !== undefined &&
      previousProperties['TableName'] !== undefined &&
      properties['TableName'] !== previousProperties['TableName'] &&
      !(await unchangedBehindSecretReference({
        resourceType,
        key: 'TableName',
        desired: properties['TableName'],
        previous: previousProperties['TableName'],
        physicalName: physicalId,
      }))
    ) {
      throw new ProvisioningError(
        log.mask(`TableName is immutable on AWS::DynamoDB::GlobalTable; ${await replaceRemedy()}`),
        resourceType,
        logicalId,
        physicalId
      );
    }
    if (
      properties['KeySchema'] !== undefined &&
      previousProperties['KeySchema'] !== undefined &&
      !deepEqual(properties['KeySchema'], previousProperties['KeySchema'])
    ) {
      throw new ProvisioningError(
        log.mask(`KeySchema is immutable on AWS::DynamoDB::GlobalTable; ${await replaceRemedy()}`),
        resourceType,
        logicalId,
        physicalId
      );
    }
    // go-to-k/cdkd#5489: an ADDED or REMOVED whole list is a change too. Before,
    // the guard needed both sides to declare a list, so adding or removing it
    // sent nothing and the update went green while DynamoDB kept the live
    // table's LSIs (it has no API that changes them). CloudFormation never
    // applies either in place (CFn A/B, us-east-1 + us-west-2, 2026-10-28): a
    // removed list REPLACES the table, and an added one fails the update with
    // "LocalSecondaryIndex template can be updated only to values matching
    // existing resource". The diff routes a removal to a replacement
    // (`globalTableLocalSecondaryIndexesRemoved` in the replacement rules), so
    // only an added or changed list normally reaches this refusal. An absent
    // list and an empty one both declare no index.
    if (
      !deepEqual(
        lsiListOrEmpty(properties['LocalSecondaryIndexes']),
        lsiListOrEmpty(previousProperties['LocalSecondaryIndexes'])
      )
    ) {
      throw new ProvisioningError(
        log.mask(
          `LocalSecondaryIndexes is immutable on AWS::DynamoDB::GlobalTable; ${await replaceRemedy()}`
        ),
        resourceType,
        logicalId,
        physicalId
      );
    }
    // AttributeDefinitions: additions are allowed (needed for new GSIs).
    // A removal is refused ONLY when some key schema in the DESIRED template
    // still references the removed attribute — that is a real
    // redefine-in-place, which AWS rejects and only a replacement can apply.
    //
    // A removal whose attribute nothing references anymore is the ORDINARY
    // way a GSI is deleted: dropping the index from a `TableV2` also drops
    // its key attribute from the synthesized `AttributeDefinitions` (CDK
    // derives the list from the keys in use, and DynamoDB rejects an entry
    // no key schema uses). The pre-#1421 blanket refusal therefore made
    // every GSI removal a forced replacement — caught live by the
    // `gsi-billing-flip` integ, whose drop-one-index phase this guard
    // failed. The `UpdateTable` GSI `Delete` action takes no
    // `AttributeDefinitions` at all, so an unreferenced removal is pure
    // bookkeeping on the cdkd side.
    const oldAttrs = (previousProperties['AttributeDefinitions'] ?? []) as AttributeDefinition[];
    const newAttrs = (properties['AttributeDefinitions'] ?? []) as AttributeDefinition[];
    const desiredKeyAttrNames = collectDesiredKeyAttributeNames(properties);
    const removedAttrs = oldAttrs.filter(
      (o) => !newAttrs.some((n) => n.AttributeName === o.AttributeName)
    );
    const removedButStillReferenced = removedAttrs.filter(
      (a) => a.AttributeName !== undefined && desiredKeyAttrNames.has(a.AttributeName)
    );
    if (removedButStillReferenced.length > 0) {
      throw new ProvisioningError(
        `AttributeDefinitions removals are immutable on AWS::DynamoDB::GlobalTable while a ` +
          `key schema still references them (offenders: ${removedButStillReferenced.map((a) => log.value(a.AttributeName)).join(', ')}); ` +
          `replacement required`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // ─── Template-path refusals (issue #3740, the #3728 shape) ──────────
    // Three DESIRED-side reads further down warn-and-skip a malformed value on
    // EVERY caller: `BillingMode` (keeps the mode it compared against),
    // `StreamSpecification` (leaves the live stream alone) and a non-array
    // `GlobalSecondaryIndexes` (suppresses the whole GSI diff). Each runs after
    // the tag diff, and the GSI one after the flat-field `UpdateTable` too, so
    // a throw there would strand what was already applied. On a TEMPLATE-path
    // update each value is template-borne and mutable in place, so it is
    // REFUSED here, before the ACTIVE wait, the `DescribeTable` and every
    // write. The two state-borne callers keep the warnings: the rollback
    // executor's revert arms (`replayingState`) and `cdkd drift --revert`
    // (`desiredFromAwsReadback`) hand a bag the user cannot edit from the
    // template.
    //
    // Each is gated on the value having CHANGED from the recorded one: an
    // unchanged malformed value is not a pending operation (the warn arms
    // send nothing for it), so refusing it would fail a deploy that changes
    // something else. Each asks the same predicate, key, fallback and path as
    // its arm.
    if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
      const changed = (key: string): boolean =>
        !deepEqual(properties[key], previousProperties[key]);
      const refuse = (refusal: string, cause?: unknown): never => {
        throw new ProvisioningError(
          log.mask(
            `AWS::DynamoDB::GlobalTable ${logicalId}: ${refusal.replace(/\.$/, '')}. Nothing was ` +
              `applied to the table; fix the template value`
          ),
          resourceType,
          logicalId,
          physicalId,
          cause instanceof Error ? cause : undefined
        );
      };
      let refusal: string | undefined;
      if (changed('BillingMode')) {
        try {
          requireConfigString(
            properties['BillingMode'],
            'PAY_PER_REQUEST',
            'AWS::DynamoDB::GlobalTable BillingMode'
          );
        } catch (error) {
          // `requireConfigString` throws only its own plain `Error`.
          refuse(describeAwsFailure(error).detail, error);
        }
      }
      // `!deepEqual` is the StreamSpecification arm's own change test. A
      // removal (the absent desired side) needs no gate of its own:
      // `configStringRefusal` answers `undefined` for a nullish container.
      if (
        refusal === undefined &&
        !deepEqual(properties['StreamSpecification'], previousProperties['StreamSpecification'])
      ) {
        refusal = configStringRefusal(
          properties['StreamSpecification'],
          'StreamViewType',
          'NEW_AND_OLD_IMAGES',
          'AWS::DynamoDB::GlobalTable StreamSpecification'
        );
      }
      // go-to-k/cdkd#5355: the flat SSE update reads `SSEEnabled` with a
      // default of ON, so a non-boolean one must not reach it. Its trigger is
      // the block OR the local replica's key, so both gate the refusal (the
      // key-convergence arm skips an unusable value instead).
      if (
        refusal === undefined &&
        (changed('SSESpecification') ||
          !deepEqual(replicaKeyBlocks(properties), replicaKeyBlocks(previousProperties)))
      ) {
        refusal = configBooleanRefusal(
          properties['SSESpecification'],
          'SSEEnabled',
          'AWS::DynamoDB::GlobalTable SSESpecification'
        );
      }
      if (refusal === undefined && changed('GlobalSecondaryIndexes')) {
        refusal = globalSecondaryIndexesShapeDetail(
          properties['GlobalSecondaryIndexes'],
          maskSecrets
        );
      }
      // go-to-k/cdkd#2762: an unreadable list would read as "no index declared"
      // and delete every recorded one.
      if (refusal === undefined && changed('VectorIndexes')) {
        refusal = vectorIndexesShapeDetail(properties['VectorIndexes']);
      }
      // go-to-k/cdkd#5365: a replica's point-in-time recovery, Contributor
      // Insights, Kinesis destination and resource policies, each block read by
      // the reader the write plan uses — refused only for a replica whose
      // blocks changed (an unchanged one is not a pending operation).
      if (refusal === undefined) {
        refusal = replicaSettingsRefusal(properties, previousProperties);
      }
      if (refusal !== undefined) refuse(refusal);
    } else {
      const sseEnabledRefusal = configBooleanRefusal(
        properties['SSESpecification'],
        'SSEEnabled',
        'AWS::DynamoDB::GlobalTable SSESpecification'
      );
      if (sseEnabledRefusal !== undefined) {
        warn(`${sseEnabledRefusal}. Encryption is treated as enabled, the block's default.`);
      }
    }

    // Resolve the client region ONCE for the whole update — the Tags
    // diff step, the BillingMode flip's capacity derivation, and the
    // Replicas diff loop all need it. Deliberately NOT hoisted above the
    // guards (see `replaceRemedy`): this read is fail-CLOSED, and every
    // consumer below treats `currentRegion` as the LOCAL-replica
    // discriminator.
    const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';

    // issue #1653: the bag actually delivered, when a warn-and-SKIP arm below
    // left a declared configuration un-applied. `undefined` (the normal case)
    // means "record the desired properties" — see the `StreamSpecification`
    // block for the full reasoning.
    //
    // THREE arms in this method answer it, all composed rather than assigned so
    // one cannot erase another (issue #1683, the #1653 sweep): this
    // `StreamSpecification` skip, the `desiredGsiUnusable` skip, and the
    // `BillingMode` warn-and-keep-the-previous-mode. Every one of them is a
    // SKIP, so the `canonicalizeDesiredProperties` twin the rules require for a
    // NARROWING does not apply — see each arm's own comment. A fourth site,
    // after the final `DescribeTable`, re-records the implied stream (issue
    // #1723); that one IS paired with the twin.
    let effectiveProperties: Record<string, unknown> | undefined;

    try {
      // 1. Wait for ACTIVE before any update — defensive against rare
      // states where a previous deploy left the table mid-transition.
      await this.waitForTableActiveAfterUpdate(
        physicalId,
        logicalId,
        undefined,
        undefined,
        maskSecrets
      );

      // 2. Tags diff. The CFn `AWS::DynamoDB::GlobalTable` schema has
      // NO top-level `Tags` — tags live inside each `Replicas[]` entry
      // as `Replicas[?Region==<region>].Tags`. For the LOCAL replica we
      // diff and apply via TagResource / UntagResource on the local
      // table ARN; cross-region replicas' Tags are propagated inside
      // the per-replica modify loop further down via the per-region
      // client returned by `getRegionalClient` (Issue #389).
      const describeResp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const tableArn = describeResp.Table?.TableArn;
      // go-to-k/cdkd#2762: VectorIndexes. `UpdateTable` creates or deletes a
      // vector index and has no in-place modify, so a same-name index whose
      // definition changed is refused here, before any mutating call. Planned
      // against the LIVE list too, so a record that lags AWS converges instead
      // of re-sending a Create AWS refuses. A state-borne bag warns and skips
      // that change (no template-side remedy). An UNSETTLED VectorIndexes needs
      // no extra trigger: the previous side is then `readUnsettled`'s live list.
      // A state-borne bag with an unreadable list is refused nowhere (the guards
      // above are the template path's): it leaves the indexes as they are.
      const vectorIndexesChanged = !deepEqual(
        properties['VectorIndexes'],
        previousProperties['VectorIndexes']
      );
      const vectorIndexShape = vectorIndexesShapeDetail(properties['VectorIndexes']);
      if (vectorIndexShape !== undefined && vectorIndexesChanged) {
        warn(`${vectorIndexShape}; the VectorIndexes change was not applied`);
      }
      const vectorIndexPlan =
        vectorIndexShape === undefined && vectorIndexesChanged
          ? planVectorIndexUpdates(
              previousProperties['VectorIndexes'],
              properties['VectorIndexes'],
              describeResp.Table === undefined
                ? undefined
                : (describeResp.Table.VectorIndexes ?? [])
            )
          : undefined;
      if (vectorIndexPlan !== undefined && vectorIndexPlan.changed.length > 0) {
        // Each name masked on its own (the WHOLE-VALUE arm, at any length).
        const vectorMessage =
          `AWS::DynamoDB::GlobalTable ${logicalId}: VectorIndexes ` +
          `${vectorIndexPlan.changed.map((name) => maskSecrets(name)).join(', ')} changed ` +
          `definition, which DynamoDB cannot modify in place`;
        if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
          throw new ProvisioningError(
            `${maskSecrets(vectorMessage)}. Nothing was applied to the table; rename the index ` +
              `(so it is dropped and re-created) or revert the change`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        warn(`${vectorMessage}; that change was not applied`);
      }
      const extractLocalTags = (props: Record<string, unknown>): unknown => {
        // The SHARED predicate, not a second spelling of it: this reader is
        // the one that throws FIRST on the apply path, and it kept the
        // unguarded form for a round after its sibling was fixed.
        const local = localReplicaEntry(props, currentRegion);
        return local?.['Tags'];
      };
      if (tableArn) {
        await this.applyTagDiff(
          tableArn,
          resourceType,
          logicalId,
          extractLocalTags(previousProperties),
          extractLocalTags(properties),
          maskSecrets,
          currentRegion
        );
      }

      // LIVE per-index warm throughput, for the decrease guard the three
      // `UpdateTable` send sites below share (issue #1857). Read off the
      // describe this method already made rather than a second call, and built
      // ONCE so the three sites cannot end up comparing against differently
      // aged snapshots of the same table. `Status` is deliberately not carried:
      // the guard compares NUMBERS. A `WarmThroughput` still `UPDATING` reports
      // the OLD value (see `readCurrentState`), so a request below the raise in
      // flight passes it; AWS accepted one on a single-region table (measured,
      // us-east-1, 2026-11-01).
      const liveWarmByIndexName = new Map<string, WarmThroughputSpec>();
      for (const liveGsi of describeResp.Table?.GlobalSecondaryIndexes ?? []) {
        const name = liveGsi.IndexName;
        const warm = liveGsi.WarmThroughput;
        if (typeof name !== 'string' || !warm) continue;
        const spec: WarmThroughputSpec = {};
        if (warm.ReadUnitsPerSecond !== undefined)
          spec.ReadUnitsPerSecond = warm.ReadUnitsPerSecond;
        if (warm.WriteUnitsPerSecond !== undefined) {
          spec.WriteUnitsPerSecond = warm.WriteUnitsPerSecond;
        }
        if (Object.keys(spec).length > 0) liveWarmByIndexName.set(name, spec);
      }

      // Resolved BEFORE the flat-field block below (step 4 re-reads them for
      // the flip itself). The on-demand reset in that block has to know the
      // billing mode on BOTH sides — see `onDemandCeilingLive` below.
      // The PREVIOUS side stays unguarded on purpose (issue #1513): it comes
      // from cdkd STATE, so refusing a malformed value an older binary already
      // recorded would make the stack permanently un-updatable with no
      // template-side remedy. The DESIRED side WARNS rather than throws for the
      // same reason one level down — `rollback-executor.ts` replays a rollback
      // via `update(..., previousState.properties, ...)`, so this bag can
      // itself be a historical state record.
      // A state-recorded previous that is itself UNUSABLE is replaced by the
      // table's ACTUAL billing mode (issue #1552). The warn path below records
      // the junk desired value as the new state, so the previous side of the
      // NEXT update can be `null` / `''` while the table really runs
      // PAY_PER_REQUEST — and `?? 'PAY_PER_REQUEST'` only rescues `null` /
      // `undefined`, so a `''` stayed junk. Comparing a corrected template
      // against that junk previous reads as a real flip and sends a same-mode
      // `UpdateTable`, which DynamoDB rejects when no capacity change rides
      // along: the deploy fails, state stays unchanged, and the rejection
      // repeats on every deploy. `DescribeTable` was already issued above, so
      // this costs no extra call.
      //
      // Since issue #1733 an ABSENT recorded previous consults AWS TOO, under a
      // narrower gate. The rule the two branches now share is "consult AWS
      // whenever the recorded previous cannot serve as a baseline", and an
      // absent one cannot: it resolved to the create-path default
      // PAY_PER_REQUEST without ever asking the table, so a record with no
      // `BillingMode` — left by `cdkd import` of a PROVISIONED table, or by
      // this method's own DROP arm below — made a corrected `PAY_PER_REQUEST`
      // template compare EQUAL, issue no `UpdateTable`, and silently lose the
      // flip. `readCurrentState` emits `BillingMode` only where AWS reports a
      // `BillingModeSummary`, so `cdkd drift` could not report it either.
      //
      // Two deliberate narrowings keep that from becoming a re-pricing of its
      // own, and each answers one of the questions issue #1733 raised:
      //
      //  - the live read is consulted ONLY when the DESIRED side declares
      //    `BillingMode` at all. A template that legitimately OMITS the
      //    property means "GlobalTable's own default", and seeding AWS's mode
      //    there would flip an imported PROVISIONED table to on-demand on its
      //    next deploy — a live re-pricing nobody asked for, on the exact
      //    population #1733 flagged as needing measurement. Where the property
      //    is declared, the user IS stating a mode, and comparing it against
      //    the table's real one is the whole point.
      //  - a `BillingModeSummary` AWS does not report resolves to PROVISIONED,
      //    the SAME reading `liveBillingMode` below and the sibling
      //    `AWS::DynamoDB::Table` provider already take, rather than to this
      //    provider's create-path default. That is not an invention: DynamoDB
      //    omits the summary for a provisioned table, and such a table IS
      //    provisioned. MEASURED, not reasoned about (us-east-1, 2026-08-13,
      //    the `dynamodb-globaltable` integ's [measure] line for #1733 (a)): a
      //    table created with an EXPLICIT `BillingMode: PROVISIONED` reports NO
      //    `BillingModeSummary` either — so this inference carries every
      //    provisioned table, not just an imported one, which is why the
      //    fallback below can never be the create-path default. Falling back to
      //    PAY_PER_REQUEST here instead — the first cut of this change — left
      //    #1733 INERT on its own headline population AND
      //    re-opened the #1552 rejection in the other direction: a record with
      //    no mode against a `PROVISIONED` template would have compared
      //    PAY_PER_REQUEST vs PROVISIONED and flipped a table that was already
      //    provisioned. An unknown reported value takes the same PROVISIONED
      //    reading; pre-#1733 the unusable branch passed such a value through
      //    verbatim, so this is a deliberate tightening rather than a
      //    restoration.
      //
      // With that alignment the seeded baselines cannot re-introduce the
      // same-mode `UpdateTable` rejection #1552 exists to prevent: the flip
      // below is gated on `oldBilling !== newBilling`, and a baseline resolved
      // from `DescribeTable` IS the mode AWS holds — so an inequality there is a
      // flip AWS accepts, where a junk baseline produced an inequality against a
      // mode the table already had.
      const recordedOldBilling = previousProperties['BillingMode'];
      const recordedOldBillingAbsent = recordedOldBilling === undefined;
      const recordedOldBillingUsable =
        typeof recordedOldBilling === 'string' && recordedOldBilling.trim() !== '';
      // NOT this provider's create-path default: the two answer different
      // questions. An ABSENT recorded previous means "the template declared no
      // BillingMode", where PAY_PER_REQUEST is GlobalTable's own default; an
      // ABSENT `BillingModeSummary` is AWS saying the table was created
      // without an explicit mode, which IS PROVISIONED (the same reading
      // `AWS::DynamoDB::Table`'s `readCurrentState` takes). Using the template
      // default here would read a live PROVISIONED table as on-demand and mask
      // a real flip.
      //
      // Named rather than inlined because the GSI recovery baseline (issue
      // #1571) needs the SAME answer: `DescribeTable` reports
      // `ProvisionedThroughput: {0, 0}` for every index of an on-demand table,
      // so which live members are safe to read is decided by this value.
      const rawLiveBillingMode = describeResp.Table?.BillingModeSummary?.BillingMode;
      // What AWS actually TOLD us, as distinct from what cdkd INFERS below.
      // Nothing branches on it — `liveBillingMode` is the answer every consumer
      // takes — but the seeded-baseline warning needs to say whether the mode it
      // names was reported or inferred, and asserting "the table's actual
      // billing mode" over an inference would overstate what cdkd knows.
      const reportedBillingMode =
        rawLiveBillingMode === 'PROVISIONED' || rawLiveBillingMode === 'PAY_PER_REQUEST'
          ? rawLiveBillingMode
          : undefined;
      const liveBillingMode = reportedBillingMode ?? 'PROVISIONED';
      const desiredDeclaresBillingMode = properties['BillingMode'] !== undefined;
      const seedAbsentFromLive = recordedOldBillingAbsent && desiredDeclaresBillingMode;
      const oldBilling = recordedOldBillingUsable
        ? (recordedOldBilling as string)
        : recordedOldBillingAbsent
          ? seedAbsentFromLive
            ? liveBillingMode
            : 'PAY_PER_REQUEST'
          : liveBillingMode;
      if (!recordedOldBillingUsable && !recordedOldBillingAbsent) {
        warn(
          `AWS::DynamoDB::GlobalTable ${logicalId}: the recorded previous BillingMode ` +
            // Masked LEAF BY LEAF before `JSON.stringify` escapes anything
            // (issue #1997): `previousProperties` is a cdkd state record whose
            // values were resolved by an earlier deploy and can be plaintext,
            // and a secret carrying a quote / backslash / newline no longer
            // OCCURS in the finished line once stringified. The walk rather than
            // a top-level `typeof` test is load-bearing — this arm fires
            // precisely when the value is NOT a usable string, so the realistic
            // shapes are an array or an object with the secret nested inside.
            `is unusable (${JSON.stringify(
              maskLeafValue(recordedOldBilling, maskSecrets)
            )}) — using the table's ` +
            `actual billing mode (${oldBilling}) as the comparison baseline for this ` +
            `update so a corrected template does not issue a same-mode UpdateTable.`
        );
      }
      // Announced only where the seeded baseline DIFFERS from the create-path
      // default this branch used before #1733 — i.e. exactly the deploys whose
      // behavior changes. Firing on every table whose record simply carries no
      // mode would be noise on the ordinary on-demand path. One condition
      // suffices: `liveBillingMode` is PAY_PER_REQUEST only when AWS reported
      // it, so this arm implies a reported-or-inferred PROVISIONED.
      if (seedAbsentFromLive && oldBilling !== 'PAY_PER_REQUEST') {
        warn(
          `AWS::DynamoDB::GlobalTable ${logicalId}: the cdkd state record declares no ` +
            `BillingMode — using ${oldBilling} as the comparison baseline for this update ` +
            `(${
              reportedBillingMode !== undefined
                ? 'the mode DescribeTable reports'
                : 'inferred: DescribeTable reports no BillingModeSummary, which means the ' +
                  'table was created without an explicit mode'
            }), so a template declaring a different mode still applies the flip instead of ` +
            `comparing equal to the create-path default.`
        );
      }
      // An UNUSABLE desired value must fall back to the PREVIOUS billing mode,
      // NOT to the create-path default. Warning and then defaulting to
      // PAY_PER_REQUEST would be strictly worse than the bug this guards:
      // before the guard existed a junk value flowed into `UpdateTable` and AWS
      // REJECTED it (loud, billing unchanged), whereas defaulting makes
      // `oldBilling !== newBilling` true against a live PROVISIONED table and
      // silently FLIPS it to on-demand — which also tears down the write
      // scalable target via `billingFlippedToOnDemand` and every per-GSI
      // capacity setting. A malformed template would silently re-price and
      // de-autoscale a production table with only a `warn` to show for it.
      //
      // An ABSENT value keeps defaulting to PAY_PER_REQUEST, because that IS a
      // genuine template-declared flip. Only the present-but-unusable case
      // suppresses it.
      //
      // Reached with a malformed value only by the state-borne callers, or by
      // a template-path update whose value is UNCHANGED from the record: a
      // changed one is refused before any call (issue #3740, the pre-flight
      // above the ACTIVE wait).
      let billingUnusable = false;
      const requestedBilling = requireConfigString(
        properties['BillingMode'],
        'PAY_PER_REQUEST',
        'AWS::DynamoDB::GlobalTable BillingMode',
        {
          onUnusable: (message) => {
            billingUnusable = true;
            // logicalId-prefixed for the same reason the GSI and stream arms
            // are: a stack can carry several GlobalTables, and without it
            // neither the user nor an integ assertion can tell which one
            // warned.
            // "compared against", not "the table's current mode": for an
            // ABSENT recorded previous `oldBilling` is the create-path default
            // and was never checked against AWS, so the stronger wording would
            // assert a mode the table may not have.
            warn(
              `AWS::DynamoDB::GlobalTable ${logicalId}: ${message} The mode this update ` +
                `compared against (${oldBilling}) is kept for this update rather than ` +
                `flipped to the default.`
            );
          },
        }
      );
      const newBilling = billingUnusable ? oldBilling : requestedBilling;
      // The table-level on-demand ceiling is only a live, resettable setting
      // when the table is on-demand on BOTH sides of this deploy.
      //
      // A "not flipping" test is NOT enough, and getting that wrong introduces
      // a failure where none existed: PROVISIONED -> PROVISIONED is also "not
      // flipping", so a provisioned template that carried
      // `WriteOnDemandThroughputSettings` (legal in the CFn schema; reachable
      // from hand-authored L1 and from state written before this fix) and then
      // drops it would send `OnDemandThroughput` on a PROVISIONED table and
      // earn a ValidationException — where the pre-fix behavior was a correct
      // no-op, since the ceiling was never live there in the first place.
      //
      // Requiring PAY_PER_REQUEST on both sides subsumes the flip suppression
      // too: a flip makes the two sides differ, so at least one is not
      // PAY_PER_REQUEST. Dropping the block while moving to PROVISIONED is the
      // natural template edit, not a clear request, and step 4's flip owns
      // that call.
      const onDemandCeilingLive =
        oldBilling === 'PAY_PER_REQUEST' && newBilling === 'PAY_PER_REQUEST';

      // Every DESIRED-side translation runs HERE, before the first mutating
      // call, so a template defect is reported while the table is still
      // untouched rather than between two half-applied UpdateTable steps.
      // Only the desired side gets a collector: `previousProperties` comes
      // from cdkd STATE, and complaining about a value an older binary
      // recorded there would shout on every deploy about a template the user
      // never wrote (issue #1428's "asymmetric between the desired side and
      // the previous side").
      const diagnostics: ThroughputDiagnostic[] = [];
      // Once per changed value, as on `AWS::DynamoDB::Table`: an unchanged block
      // is not a pending operation.
      if (!deepEqual(properties['WarmThroughput'], previousProperties['WarmThroughput'])) {
        const warmUpdateDiagnostic = warmThroughputDiagnostic(
          properties['WarmThroughput'],
          coerceWarmThroughput(properties['WarmThroughput']),
          undefined
        );
        if (warmUpdateDiagnostic) diagnostics.push(warmUpdateDiagnostic);
      }
      const desiredCeilings = collectTableOnDemandCeilings(
        properties,
        currentRegion,
        diagnostics,
        maskSecrets
      );
      // The TABLE-level provisioned capacity falls through to 5/5 only on step
      // 4's billing flip, so the #1511 diagnostic is gated on exactly that
      // condition rather than on `newBilling` alone, which would warn about a
      // value nothing consumes. Same `'seed'` source step 4 uses, so the blamed
      // member matches what it would have read. Result discarded: this call is
      // for the diagnostics.
      const flippingToProvisioned = oldBilling !== newBilling && newBilling === 'PROVISIONED';
      if (flippingToProvisioned) {
        derivePerCallProvisionedThroughput(
          properties,
          currentRegion,
          'seed',
          diagnostics,
          maskSecrets
        );
      }
      // Read here so a declared value step 4a' cannot read is reported with the
      // rest of this update's diagnostics. A flip carried the capacity already,
      // and a table turned on-demand out of band reports 0/0, no capacity to
      // send back.
      const tableCapacityChange =
        oldBilling === 'PROVISIONED' &&
        newBilling === 'PROVISIONED' &&
        liveBillingMode === 'PROVISIONED'
          ? readTableCapacityChange(
              properties,
              previousProperties,
              currentRegion,
              diagnostics,
              maskSecrets
            )
          : undefined;
      // The DIFF's translation stays on `'min'` (step 6 compares against it),
      // but the diagnostics must be raised with the source step 4 will actually
      // READ: on a flip that is `'seed'`, and naming `MinCapacity` for a value
      // the flip never consulted is the same mismatch the table-level call
      // above avoids (issue #1435's precedence, one level down). Firing itself
      // is source-independent — `pickAutoScalingCapacity` falls back both ways
      // — so this only ever changes WHICH member the sentence names.
      //
      // The GSI shape refusal is DOWNGRADED to a warning on this path (issue
      // #1551): the desired bag can be a cdkd STATE record on a rollback
      // replay / `drift --revert`, and a throw would strand it. The
      // downgrade's own semantics differ from the create site's, though, and
      // that difference is the whole point of deciding this per site — the
      // create site OMITS the block (a fresh table with zero indexes), while
      // here an empty desired list means "the template declares no GSIs", so
      // step 6's diff would DELETE every live index. `desiredGsiUnusable`
      // therefore suppresses the GSI diff entirely: the indexes are left
      // exactly as they are (keep-previous), never dropped. On a template-path
      // update this arm is reached only with an UNCHANGED malformed block: a
      // changed one is refused before any call (issue #3740, the pre-flight
      // above the ACTIVE wait, sharing `globalSecondaryIndexesShapeDetail`).
      // The two sides get DIFFERENT treatment, because only one of them can be
      // recovered from AWS.
      let desiredGsiUnusable = false;
      const onUnusableGsiBlock = (message: string): void => {
        desiredGsiUnusable = true;
        warn(
          `AWS::DynamoDB::GlobalTable ${logicalId}: ${message} No GlobalSecondaryIndexes ` +
            `change is applied by this update; the table's existing indexes are left untouched.`
        );
      };
      // The PREVIOUS side's translation gets the downgrade UNCONDITIONALLY (it
      // is reached from step 4's flip and again from step 6's diff): that bag
      // comes from cdkd STATE, never from the template, so a refusal there is
      // the guard-the-desired-side-only rule violated outright — a malformed
      // block an older binary (or this provider's own warn path) recorded would
      // make the table permanently un-updatable with no template-side remedy.
      //
      // Suppressing the diff is NOT the right answer on this side, and that is
      // the #1552 class one property over: the warn path records the junk
      // desired block as the new state, so the NEXT deploy — the one carrying
      // the user's CORRECTED template — would hit this suppression, silently
      // drop the GSI add, and record the corrected block as state. The deploy
      // after that sees previous == desired and never applies it either: the
      // index is lost permanently, with a success exit code. So the baseline is
      // seeded from the LIVE table's index NAMES instead (see below), in the
      // same spirit as
      // the BillingMode guard seeds from `BillingModeSummary`.
      let previousGsiUnusable = false;
      const onUnusablePreviousGsiBlock = (message: string): void => {
        previousGsiUnusable = true;
        warn(
          `AWS::DynamoDB::GlobalTable ${logicalId}: ${message} (recorded in cdkd state, ` +
            `not in the template) — using the table's LIVE indexes as the comparison ` +
            `baseline for this update, so a corrected template still applies.`
        );
      };
      // AWS's own view of WHICH indexes exist — names only, deliberately.
      // `DescribeTable` was already issued above, so this costs no extra call.
      //
      // Carrying the live VALUES into the diff was the first cut of this fix
      // and it was wrong three ways, each caught by review: `DescribeTable`
      // reports `ProvisionedThroughput: {0, 0}` for every index on a
      // PAY_PER_REQUEST table, so a desired side with no capacity read as
      // "modified" on every index and a flip re-sent `{0, 0}` (which AWS
      // rejects); AWS's member order differs from the translator's, which a
      // key-order-sensitive compare read as a change on any index carrying
      // both warm and provisioned throughput; and live capacity
      // fights auto-scaling (live 10 vs the template's min 1 reads as a
      // scale-down nobody asked for).
      //
      // Existence is what stops the PERMANENT LOSS, and for a while it was the
      // only thing taken. Issue #1571 then closed the residual that left: the
      // baseline also carries the live VALUES that are safe to compare, with
      // each of the three failure modes above turned into an explicit
      // exclusion rather than a blanket refusal. This set is still used on its
      // own for the live-ONLY report below. See `buildLiveRecoveryGsiBaseline`
      // for which values are carried and why.
      const liveIndexNames = new Set(
        (describeResp.Table?.GlobalSecondaryIndexes ?? [])
          .map((live) => live.IndexName)
          .filter((name): name is string => typeof name === 'string')
      );
      const desiredSdkIndexes = toSdkGlobalSecondaryIndexes(
        properties,
        currentRegion,
        newBilling,
        'min',
        flippingToProvisioned ? undefined : diagnostics,
        onUnusableGsiBlock,
        maskSecrets
      );
      if (flippingToProvisioned) {
        toSdkGlobalSecondaryIndexes(
          properties,
          currentRegion,
          newBilling,
          'seed',
          diagnostics,
          onUnusableGsiBlock,
          maskSecrets
        );
      }
      for (const replica of (properties['Replicas'] ?? []) as Array<Record<string, unknown>>) {
        const replicaRegion = asRecord(replica)?.['Region'];
        if (typeof replicaRegion !== 'string' || replicaRegion === currentRegion) continue;
        toSdkReplicaGlobalSecondaryIndexes(
          replica['GlobalSecondaryIndexes'],
          newBilling,
          diagnostics,
          maskSecrets
        );
        toSdkReplicaThroughputOverrides(replica, newBilling, diagnostics, {}, maskSecrets);
      }
      this.reportThroughputDiagnostics(diagnostics, logicalId, physicalId, maskSecrets);

      // The local table's customer managed key when cross-region replicas
      // make `SSESpecification` the wrong channel for it: `applyReplicaKeys`
      // sends it after the replica diff (go-to-k/cdkd#5355).
      let deferredSseUpdate: UpdateTableCommandInput['SSESpecification'];
      let deferredSseFromTemplate = false;
      let keylessSseFromTemplate = false;
      // 3. Non-conflicting flat fields in one combined UpdateTable.
      // AWS allows combining these in a single call because they don't
      // conflict with each other or with each other's modes.
      // DeletionProtectionEnabled is per-replica in the CFn schema
      // (same shape as Tags). Extract via shared module-level helper.
      //
      // **AWS-aware diff (migration fix)**: also compare against AWS's
      // observed DPE from the DescribeTable response above. Pre-PR
      // #410 cdkd was reading top-level DPE which was always
      // undefined → no UpdateTable was issued, but state recorded
      // the user's template intent (per-replica DPE=true). Post-fix,
      // a no-change redeploy would see oldDpe=true vs newDpe=true
      // and skip the update — but AWS still has DPE=false. By
      // comparing against `awsDpe` from DescribeTable, we re-converge
      // the actual AWS state to the template intent on any deploy,
      // not just deploys with a template-side diff. Same logic
      // doubles as protection against console-side drift.
      const newDpe = extractLocalDeletionProtection(properties, currentRegion);
      const oldDpe = extractLocalDeletionProtection(previousProperties, currentRegion);
      const awsDpe = describeResp.Table?.DeletionProtectionEnabled;
      const flatUpdate: UpdateTableCommandInput = { TableName: physicalId };
      let flatChanged = false;
      // A table-class change and an encryption change each go out as their
      // OWN UpdateTable after the flat one (see where they are sent).
      let tableClassUpdate: UpdateTableCommandInput['TableClass'];
      let sseUpdate: UpdateTableCommandInput['SSESpecification'];
      // Whether `sseUpdate` comes from a template change (fails the update
      // when refused) rather than from the AWS-aware correction (best-effort).
      let sseFromTemplate = false;
      // The same for `tableClassUpdate`.
      let tableClassFromTemplate = false;
      const dpeDiffersFromState = newDpe !== oldDpe;
      const dpeDiffersFromAws =
        newDpe !== undefined && typeof awsDpe === 'boolean' && Boolean(newDpe) !== awsDpe;
      if (dpeDiffersFromState || dpeDiffersFromAws) {
        // **Auto-disable WARN**: cdkd's diff semantics treat
        // "absent property in template" as "revert to default", which
        // matches CFn / CDK CLI parity. For DPE specifically this
        // means: removing `deletionProtection: true` from CDK code
        // silently disables protection on AWS. That's a refactoring
        // footgun (e.g. moving the prop into a config helper but
        // mistyping the destination, or accidentally deleting the
        // line during a cleanup). Surface a WARN so the user has
        // visibility before the next destroy. WARN only — no behavior
        // change; the user can still proceed if they really mean to
        // disable protection.
        const templateExplicitlySetsDpe = newDpe !== undefined;
        const flippingTrueToFalse =
          (oldDpe === true || awsDpe === true) && Boolean(newDpe ?? false) === false;
        if (flippingTrueToFalse && !templateExplicitlySetsDpe) {
          // Neutral wording covers both flip directions:
          //   - state DPE=true, AWS=true, new=undefined (property removed from CDK code)
          //   - state DPE=false/undefined, AWS=true, new=undefined (console-side enable
          //     + CDK code never set it)
          // Both cases reach the same recovery path.
          warn(
            `Auto-disabling DeletionProtectionEnabled on ${physicalId}: ` +
              `the CDK code does not set 'deletionProtection: true' but AWS ` +
              `has it enabled. AWS will accept DeleteTable on this resource ` +
              `after this deploy. ` +
              `If you meant to keep protection on, set ` +
              `'deletionProtection: true' in your CDK code; ` +
              `if you meant to disable it explicitly, set ` +
              `'deletionProtection: false' to silence this warning.`
          );
        }
        flatUpdate.DeletionProtectionEnabled = Boolean(newDpe ?? false);
        flatChanged = true;
      }
      // The local table's class and KMS key are per-replica in the CFn schema
      // (go-to-k/cdkd#5355), so both sides are read from the local replica.
      const tableClassChange = tableClassToSend(
        extractLocalTableClass(previousProperties, currentRegion),
        extractLocalTableClass(properties, currentRegion)
      );
      // AWS-aware like the protection flag above: a table created before
      // go-to-k/cdkd#5355 holds STANDARD under a record that already names the
      // declared class, so an unchanged template converges it only by a read.
      const declaredTableClass = extractLocalTableClass(properties, currentRegion);
      const liveTableClass = describeResp.Table?.TableClassSummary?.TableClass ?? 'STANDARD';
      if (tableClassChange !== undefined) {
        tableClassUpdate = tableClassChange;
        tableClassFromTemplate = true;
      } else if (declaredTableClass !== undefined && declaredTableClass !== liveTableClass) {
        tableClassUpdate = declaredTableClass as UpdateTableCommandInput['TableClass'];
      }
      const newLocalKmsKey = readReplicaKmsMasterKeyId(
        localReplicaEntry(properties, currentRegion)
      );
      if (
        properties['SSESpecification'] !== undefined &&
        (!deepEqual(properties['SSESpecification'], previousProperties['SSESpecification']) ||
          newLocalKmsKey !==
            readReplicaKmsMasterKeyId(localReplicaEntry(previousProperties, currentRegion)))
      ) {
        sseUpdate = toSdkTableSseSpecification(properties['SSESpecification'], newLocalKmsKey);
        sseFromTemplate = true;
      } else if (
        properties['SSESpecification'] === undefined &&
        previousProperties['SSESpecification'] !== undefined &&
        toSdkTableSseSpecification(previousProperties['SSESpecification'], undefined).Enabled
      ) {
        // A REMOVED block resets the table to the AWS owned key, which is what
        // CloudFormation does (CFn A/B, us-east-1 + us-west-2, 2026-10-26:
        // `SSEDescription` absent on both regions once the update completed).
        // `Enabled: false` is DynamoDB's spelling of "AWS owned key"; sent only
        // when the previous block had encryption on, since that is the one
        // case with anything to reset (go-to-k/cdkd#5355).
        sseUpdate = { Enabled: false };
        sseFromTemplate = true;
      } else if (
        isKmsKeyArn(newLocalKmsKey) &&
        properties['SSESpecification'] !== undefined &&
        configBooleanRefusal(
          properties['SSESpecification'],
          'SSEEnabled',
          'AWS::DynamoDB::GlobalTable SSESpecification'
        ) === undefined &&
        toSdkTableSseSpecification(properties['SSESpecification'], undefined).Enabled &&
        describeResp.Table?.SSEDescription?.KMSMasterKeyArn !== newLocalKmsKey
      ) {
        // AWS-aware, for the reason the table class above is: a table created
        // before go-to-k/cdkd#5355 sits on the AWS managed key under a record
        // naming the declared one. Compared only for a key ARN, which is what
        // AWS reports back (CDK's `customerManagedKey` renders the ARN).
        sseUpdate = toSdkTableSseSpecification(properties['SSESpecification'], newLocalKmsKey);
      }
      if (
        properties['StreamSpecification'] !== undefined &&
        !deepEqual(properties['StreamSpecification'], previousProperties['StreamSpecification'])
      ) {
        // Guarded like the create path, so the two cannot disagree: without
        // it a malformed container here sent `StreamViewType: undefined`
        // while create refused the identical template (issue #1493 review).
        //
        // The refusal is DOWNGRADED to a warning (issue #1551) because a
        // rollback replay / `drift --revert` feeds a cdkd STATE record in as
        // the desired bag, which the user cannot edit — a throw here would
        // strand the replay. A template-path update never reaches it with a
        // malformed block: this branch runs only on a change, and the
        // pre-flight above the ACTIVE wait refuses a changed malformed block
        // before any call (issue #3740). The downgrade SKIPS the block entirely rather
        // than sending the `NEW_AND_OLD_IMAGES` default: defaulting would
        // silently re-point a live stream's view type (and enable a stream
        // the template never asked to enable), which is the destructive
        // half of the guard, not the safe one. Skipping leaves the live
        // stream exactly as it is.
        let streamSpecUnusable = false;
        const streamViewType = readConfigString(
          properties['StreamSpecification'],
          'StreamViewType',
          'NEW_AND_OLD_IMAGES',
          'AWS::DynamoDB::GlobalTable StreamSpecification',
          {
            onUnusable: (message) => {
              streamSpecUnusable = true;
              // Prefixed with the type + logical id, matching the GSI warn arm
              // below. Without it the sentence names only the PROPERTY PATH, so
              // on a stack with several GlobalTables the user cannot tell which
              // table warned — and neither can an integ assertion.
              warn(
                `AWS::DynamoDB::GlobalTable ${logicalId}: ${message} The table's existing ` +
                  `stream configuration is left untouched for this update rather than ` +
                  `re-pointed at the default.`
              );
            },
          }
        );
        // Issue #1723: the recorded previous side is not proof of what AWS
        // holds. A record written before #1723 carries no stream for a table
        // `create()` gave one, and a rollback replay of a two-to-one replica
        // change hands back the OLD record's implied stream against a previous
        // side that dropped it. Either way the desired block can already be
        // LIVE, and re-sending it asks AWS to enable a stream the table has.
        // Read off the DescribeTable this update already made, so the gate
        // costs no call; the desired value is then exactly what AWS holds, so
        // recording it is correct and no `effectiveProperties` is needed.
        const liveStreamSpec = describeResp.Table?.StreamSpecification;
        const alreadyLive =
          liveStreamSpec?.StreamEnabled === true &&
          liveStreamSpec.StreamViewType === streamViewType;
        if (!streamSpecUnusable) {
          if (alreadyLive) {
            this.logger.debug(
              log.mask(
                `${logicalId}: StreamSpecification already live as ${streamViewType}; not re-sent`
              )
            );
          } else {
            flatUpdate.StreamSpecification = {
              StreamEnabled: true,
              StreamViewType: streamViewType,
            } as StreamSpecification;
            flatChanged = true;
          }
        } else {
          // issue #1653: the skip makes the deploy SUCCEED with the declared
          // block never reaching AWS, so recording the desired bag verbatim
          // writes a value AWS does not hold — `readCurrentState` can never
          // match it, every later `cdkd drift` re-reports the difference, and
          // `drift --revert` re-issues the same skipped call. Answer with the
          // bag actually delivered instead.
          //
          // On the UPDATE path that is the PREVIOUS value: the `UpdateTable`
          // never ran, so AWS still holds the previously-applied stream
          // configuration and that IS what state should describe
          // (.claude/rules/providers.md, issue #1612). An ABSENT previous
          // means the key is absent from the effective bag — there is nothing
          // to retain, and an explicit `undefined` would survive the spread
          // and any `Object.keys` walk over the recorded bag.
          //
          // Deliberately NOT paired with a `canonicalizeDesiredProperties`
          // twin: a SKIP is not a pure function of the desired bag, and
          // canonicalizing the desired side would compare a previous side
          // holding a VALID `StreamSpecification` against a desired side with
          // the key removed, derive a REMOVAL, and disable the live stream.
          //
          // The previous value is VALIDATED before it is retained, through the
          // same `configStringRefusal` predicate the desired-side guard above
          // runs — an absent-vs-present test is not enough. `previousProperties`
          // is a cdkd STATE record, and a rollback replay whose record was
          // written by an older binary is exactly the #1544 scenario
          // `replayWarn` exists for, so the previous side can hold `null` /
          // `''` / a bare string just as the desired side can. Copying that
          // into `effectiveProperties` would re-create the permanent phantom
          // drift this arm exists to remove, merely sourced from the other
          // side. When BOTH sides are unusable the key is DROPPED — there is
          // no value cdkd can vouch for, which is the same answer
          // `LambdaUrlProvider`'s OMITTED arm takes for `AuthType` (#1654).
          // Sharing the predicate rather than hand-writing a `typeof` twin is
          // what keeps the two sides agreeing on a blank string / an explicit
          // null / a coerced number.
          const previousStreamSpec = previousProperties['StreamSpecification'];
          const previousStreamSpecUsable =
            previousStreamSpec !== undefined &&
            previousStreamSpec !== null &&
            configStringRefusal(
              previousStreamSpec,
              'StreamViewType',
              'NEW_AND_OLD_IMAGES',
              'AWS::DynamoDB::GlobalTable StreamSpecification'
            ) === undefined;
          // Composed, not assigned. This arm runs FIRST, so `effectiveProperties`
          // is always undefined here and the `??` is inert TODAY — a mutation to
          // `{ ...properties }` passes every test, measured. It is written this
          // way so the two independent guards (which can both fire in one
          // update) stay symmetrical, and so an arm inserted ahead of this one
          // is not erased silently. The GSI arm below runs second and its
          // composition IS fenced by a test (issue #1683 review).
          effectiveProperties = { ...(effectiveProperties ?? properties) };
          if (previousStreamSpecUsable) {
            // COPIED, not aliased: `rollback-executor.ts` spreads the returned
            // bag shallowly, so handing back the previous record's own object
            // would leave two state records sharing one mutable value.
            effectiveProperties['StreamSpecification'] = {
              ...(previousStreamSpec as Record<string, unknown>),
            };
          } else {
            delete effectiveProperties['StreamSpecification'];
          }
        }
      }

      // `desiredGsiUnusable` is the same class one property over (issue #1683,
      // the #1653 sibling this change closes): the GSI diff is SUPPRESSED, so
      // AWS keeps the index set it already holds while the engine recorded the
      // malformed desired blob — a record `readCurrentState` can never match,
      // and one the NEXT update reads as its previous side (the #1552 class).
      //
      // On UPDATE the answer is "retain the PREVIOUS value" per
      // `.claude/rules/providers.md`, NOT the create side's OMIT — an absent
      // list here reads as "the template declares no GSIs".
      //
      // The previous side is VALIDATED before it is retained, through the SAME
      // helper the desired side ran: a probe call with a flag-only callback.
      // The helper is pure, so this costs one extra translation and no separate
      // shape predicate. Be honest about what that buys TODAY: the helper
      // refuses on exactly one branch (present-and-not-an-array) and passes a
      // non-object ENTRY through untouched, so the probe is behaviourally
      // identical to `Array.isArray` and no test distinguishes them. The reason
      // to route through it anyway is that the two stay in step when the
      // helper's refusals grow — which is a claim about the FUTURE, not a
      // divergence already covered.
      // The key is DROPPED when the previous side is unusable OR absent — there
      // is no value cdkd can vouch for either way, the same answer the
      // `StreamSpecification` arm above takes. (The absent case is the `!==
      // undefined` half of the condition below, not a separate branch.)
      if (desiredGsiUnusable) {
        let previousGsiProbeUnusable = false;
        toSdkGlobalSecondaryIndexes(
          previousProperties,
          currentRegion,
          oldBilling,
          'min',
          undefined,
          () => {
            previousGsiProbeUnusable = true;
          },
          maskSecrets
        );
        const previousIndexes = previousProperties['GlobalSecondaryIndexes'];
        effectiveProperties = { ...(effectiveProperties ?? properties) };
        if (!previousGsiProbeUnusable && previousIndexes !== undefined) {
          // The probe refuses exactly "present and not an array", so reaching
          // here with a defined value means it IS an array — no non-array
          // fallback branch, which would be unreachable (issue #1683 review).
          //
          // COPIED, not aliased: `rollback-executor.ts` spreads the returned
          // bag shallowly, so handing back the previous record's own array
          // would leave two state records sharing one mutable value. Scope
          // this claim honestly — it covers THIS key only. The surrounding
          // spread is shallow too, so every other key (`Replicas`,
          // `SSESpecification`, per-replica `Tags`) stays aliased to the
          // caller's bag, which on a replay IS `previousState.properties`.
          // The ELEMENTS of this array are shared as well; nothing mutates a
          // recorded GSI entry today, and deep-cloning here would diverge from
          // how every sibling arm copies.
          effectiveProperties['GlobalSecondaryIndexes'] = [...(previousIndexes as unknown[])];
        } else {
          delete effectiveProperties['GlobalSecondaryIndexes'];
        }
      }

      // The third arm issue #1683 names, and the one its arm 1 places on BOTH
      // paths: an unusable desired `BillingMode` does NOT flip the table, it
      // keeps `oldBilling` (see the guard's own comment for why defaulting here
      // would silently re-price a production table). So AWS is left holding the
      // mode it already had while the engine recorded the malformed desired
      // value.
      //
      // Be precise about what that costs, because the obvious phrasing
      // overstates it: `readCurrentState` emits `BillingMode` only when AWS
      // returns a `BillingModeSummary`, and a table created without an explicit
      // mode has none — the live run that verified this arm measured exactly
      // that. So the payoff here is chiefly the DIFF's previous side, which the
      // next deploy reads: a junk value recorded there is the #1552 class,
      // re-derived on every deploy. Drift convergence is the payoff only for a
      // table whose mode AWS does report.
      //
      // The split is on ABSENCE, not on usability, and `oldBilling` is the
      // right value for everything else — which is what the two guards above
      // already decided, per shape:
      //
      //  - recorded previous PRESENT and usable: `oldBilling` IS that value, so
      //    this retains it. It deliberately does not consult the live mode; an
      //    out-of-band re-price is a finding for `cdkd drift` to report, not
      //    something this arm should quietly reconcile away.
      //  - recorded previous PRESENT but unusable: `oldBilling` is the live
      //    `DescribeTable` reading the #1552 guard resolved for exactly this
      //    shape, and recording it RESTORES a usable baseline. Dropping here
      //    instead looks tidier and is a regression (caught in review): a
      //    dropped key reads as ABSENT next time, and the absent branch does
      //    NOT consult AWS — it defaults to PAY_PER_REQUEST — so a corrected
      //    template asking for PAY_PER_REQUEST would compare equal, issue no
      //    `UpdateTable`, and silently lose the flip on a live PROVISIONED
      //    table that `readCurrentState` cannot even report.
      //  - recorded previous ABSENT: the record never carried the key, so it is
      //    left exactly as it was — the same answer the GSI arm above and the
      //    Lambda URL `AuthType` arm (#1654) take. Since issue #1733 the
      //    baseline for this shape is no longer a blind create-path default
      //    (see the resolution block above), so the DROP no longer strands the
      //    corrected template: the next deploy re-reads AWS rather than
      //    comparing against a key this arm could have invented. Recording
      //    `oldBilling` here anyway is deliberately NOT done — where the desired
      //    side declares no mode the baseline is still the template default, so
      //    the key would be an invention on a table AWS may hold as PROVISIONED.
      if (billingUnusable) {
        effectiveProperties = { ...(effectiveProperties ?? properties) };
        if (recordedOldBilling === undefined) {
          delete effectiveProperties['BillingMode'];
        } else {
          effectiveProperties['BillingMode'] = oldBilling;
        }
        // The capacity twin of the same suppression (issue #1738, the
        // UPDATE-side sibling of #1726's CREATE half). With the flip suppressed
        // the capacity call for the OTHER mode never fires either, yet the bag
        // above still carries whatever blocks the template declared — state
        // describing capacity AWS never received, which `readCurrentState` can
        // never match and the NEXT update reads as its previous side.
        //
        // The create-side answer does not transfer, for the two reasons #1726's
        // own note gives: there the substituted mode is always PAY_PER_REQUEST
        // so the unsendable set is decidable outright, and the resource is NEW
        // so a DROP is right. Here the KEPT mode is resolved at run time and the
        // table already EXISTS, so `.claude/rules/providers.md`'s UPDATE row
        // applies instead — retain the PREVIOUS value, validated first.
        effectiveProperties = retainUnsendableCapacityMembers(
          effectiveProperties,
          previousProperties,
          newBilling
        );
      }

      // Table-level on-demand ceilings, BOTH halves. The write half lives at
      // top-level `WriteOnDemandThroughputSettings`; the read half lives on
      // the LOCAL replica as `ReadOnDemandThroughputSettings` and was never
      // read at all before issue #1436 — so `maxReadRequestUnits` was dropped
      // on the way in and could not be reset on the way out either.
      //
      // Per-member, and MERGED rather than branched on "the whole block
      // disappeared": read and write are INDEPENDENT CDK props living in
      // different parts of the template, so a branch would silently drop the
      // single-member removal, which is the likelier user edit. That branch
      // shape is exactly the blocker the #1433 review caught one level down.
      //
      // `-1` is the reset sentinel, LIVE-VERIFIED for this member pair
      // (issue #1434, us-east-1 + us-west-2, 2026-08-09): `UpdateTable` with
      // `OnDemandThroughput: {MaxWriteRequestUnits: -1}` was accepted and
      // `DescribeTable` afterwards returned `{MaxReadRequestUnits: 100}` — the
      // dropped member cleared, the untouched sibling preserved — and a
      // follow-up `{MaxReadRequestUnits: -1}` removed the block entirely. So
      // the reset reads back as ABSENCE, never as -1, and any drift /
      // read-back comparison must expect that.
      //
      // The sentinel is NOT transferable to the REPLICA-level overrides; see
      // the note on the replica loop below for the probe that proved it.
      //
      // The comparison baseline is AWS's OBSERVED ceiling, not the state
      // record — the same AWS-aware diff the DeletionProtectionEnabled block
      // above uses, and for a sharper reason here. A table deployed before
      // #1436 has `maxReadRequestUnits` recorded in cdkd state (state stores
      // template intent) while AWS never received it, so a state-vs-state
      // comparison sees "unchanged" and the drop is never repaired. Reading
      // the live value converges the table on the FIRST post-fix deploy, and
      // doubles as console-drift correction.
      const awsOnDemand = describeResp.Table?.OnDemandThroughput;
      const onDemandPayload: OnDemandThroughput = {};
      const resolveCeiling = (
        desired: RawCeiling,
        live: number | undefined
      ): number | undefined => {
        // A declared-but-unresolvable value (an unresolved intrinsic) sends
        // NOTHING. It must not take the reset branch, which would silently
        // clear the ceiling the template was trying to SET — the exact
        // silent-wrong-action class the reset exists to remove. The
        // `diagnostics` pass above already told the user why nothing moved.
        if (desired.declared) {
          if (desired.value === undefined) return undefined;
          return desired.value !== live ? desired.value : undefined;
        }
        if (onDemandCeilingLive && live !== undefined) return ON_DEMAND_LIMIT_RESET;
        return undefined;
      };
      const nextMaxRead = resolveCeiling(desiredCeilings.read, awsOnDemand?.MaxReadRequestUnits);
      const nextMaxWrite = resolveCeiling(desiredCeilings.write, awsOnDemand?.MaxWriteRequestUnits);
      if (nextMaxRead !== undefined) onDemandPayload.MaxReadRequestUnits = nextMaxRead;
      if (nextMaxWrite !== undefined) onDemandPayload.MaxWriteRequestUnits = nextMaxWrite;
      // Never sent while EITHER side is PROVISIONED. The new side is obvious
      // (AWS rejects an on-demand ceiling on a provisioned table; a template
      // carrying one while moving to PROVISIONED is a stale leftover, not a
      // request — issue #1428 defect 3, one level up). The OLD side matters
      // because step 3 runs BEFORE step 4's flip: on a PROVISIONED ->
      // PAY_PER_REQUEST flip the live table is still provisioned here, so a
      // ceiling the new template declares must wait for the flip to land —
      // sending it now would 400 and, since state is only saved on success,
      // make the flip template repeatedly undeployable. The per-GSI path has
      // the same shape for free (its on-demand limits are applied by step 6,
      // which runs after the flip); this deferral is the table-level twin.
      const deferCeilingsPastFlip =
        oldBilling === 'PROVISIONED' &&
        newBilling === 'PAY_PER_REQUEST' &&
        Object.keys(onDemandPayload).length > 0;
      if (
        newBilling !== 'PROVISIONED' &&
        !deferCeilingsPastFlip &&
        Object.keys(onDemandPayload).length > 0
      ) {
        flatUpdate.OnDemandThroughput = onDemandPayload;
        flatChanged = true;
      }
      if (flatChanged) {
        // go-to-k/cdkd#5487: the keys this one call changes, before it.
        if (flatUpdate.DeletionProtectionEnabled !== undefined) markUnsettled('Replicas');
        if (flatUpdate.StreamSpecification !== undefined) markUnsettled('StreamSpecification');
        if (flatUpdate.OnDemandThroughput !== undefined) {
          markUnsettled('WriteOnDemandThroughputSettings', 'ReadOnDemandThroughputSettings');
        }
        await this.dynamoDBClient.send(new UpdateTableCommand(flatUpdate));
        await this.waitForTableActiveAfterUpdate(
          physicalId,
          logicalId,
          undefined,
          undefined,
          maskSecrets
        );
      }
      // DynamoDB takes a table-class change and an encryption change each as
      // the ONLY operation of its UpdateTable (measured 2026-10-26 on a
      // two-region table: `TableClass modification must be the only operation
      // in the request`, and the same for `Server-Side Encryption`, refused
      // with deletion protection or each other alongside), and an encryption
      // change moves every replica with it, so each is sent alone and waited
      // out across the whole global table (go-to-k/cdkd#5355).
      // A correction AWS alone asked for (a table deployed before
      // go-to-k/cdkd#5355, a console-side change) is best-effort, as the
      // replica convergence is: DynamoDB's encryption-change throttle or an
      // unusable key must not fail every later deploy of the table.
      if (tableClassUpdate !== undefined) {
        await this.sendLocalSettingUpdate(
          { TableName: physicalId, TableClass: tableClassUpdate },
          tableClassFromTemplate,
          'TableClass',
          physicalId,
          logicalId,
          maskSecrets
        );
      }
      // A customer managed key on a table with cross-region replicas cannot
      // go through `SSESpecification` (measured: "Customer Managed CMKs on
      // Global Table Version 2019.11.21 replicas cannot be updated through
      // SSESpecification parameter and can only be updated through
      // ReplicaUpdates parameter"); `applyReplicaKeys` sets it after the
      // replica diff. The AWS managed key (`SSEType: KMS`, no key) and the
      // AWS owned key (`Enabled: false`) do go through it, and move every
      // replica with the table (measured).
      const liveHasCrossRegionReplica = (describeResp.Table?.Replicas ?? []).some(
        (r) => r.RegionName !== undefined && r.RegionName !== currentRegion
      );
      if (sseUpdate?.KMSMasterKeyId !== undefined && liveHasCrossRegionReplica) {
        deferredSseUpdate = sseUpdate;
        deferredSseFromTemplate = sseFromTemplate;
      } else if (sseUpdate !== undefined) {
        await this.sendLocalSettingUpdate(
          { TableName: physicalId, SSESpecification: sseUpdate },
          sseFromTemplate,
          'encryption',
          physicalId,
          logicalId,
          maskSecrets
        );
        // A template change to the AWS managed key moved every replica with
        // the table; a replica the template still names a customer managed
        // key for is then a template change for the key pass too.
        keylessSseFromTemplate =
          sseFromTemplate && sseUpdate.KMSMasterKeyId === undefined && liveHasCrossRegionReplica;
      }

      // 4. BillingMode flip (own UpdateTable per AWS state-machine rule).
      // Defaults must match the `billingMode` read in `create()`
      // (`PAY_PER_REQUEST`) so
      // a template with no explicit `BillingMode` doesn't false-fire
      // a PROVISIONED → PAY_PER_REQUEST diff on every update of a
      // PAY_PER_REQUEST table. Both are resolved just above step 3, which
      // needs the same pair to suppress its on-demand reset during a flip —
      // ONE binding, so the two sites cannot disagree about what "flipping"
      // means.
      // GSIs whose ProvisionedThroughput was already applied as part of the
      // BillingMode flip below — step 6 must not re-issue an Update for them.
      const gsiHandledByBillingFlip = new Set<string>();
      if (oldBilling !== newBilling) {
        const billingUpdate: UpdateTableCommandInput = {
          TableName: physicalId,
          BillingMode: newBilling as 'PROVISIONED' | 'PAY_PER_REQUEST',
        };
        if (newBilling === 'PROVISIONED') {
          // Mirror create()'s capacity derivation so a user template
          // with non-default read/write capacity is preserved across a
          // PAY_PER_REQUEST → PROVISIONED flip (the previous hardcoded
          // `ReadCapacityUnits: 5` silently overrode the template).
          //
          // `'seed'` here and NOWHERE else (Issue #1435): this flip is the one
          // context AWS documents `SeedCapacity` for — the value the table runs
          // at until the scaling policies exist. Every other call site takes
          // `MinCapacity`, which is what CloudFormation creates at.
          billingUpdate.ProvisionedThroughput = derivePerCallProvisionedThroughput(
            properties,
            currentRegion,
            'seed',
            undefined,
            maskSecrets
          );
          // AWS requires per-GSI `ProvisionedThroughput` in the SAME
          // UpdateTable call that flips PAY_PER_REQUEST -> PROVISIONED
          // (Issue #1387): the throughput-mode change applies to the table
          // AND every index atomically, so the table-level
          // `ProvisionedThroughput` set above and these per-index updates ride
          // the same call.
          const provisionedIndexes = toSdkGlobalSecondaryIndexes(
            properties,
            currentRegion,
            newBilling,
            'seed',
            undefined,
            onUnusableGsiBlock,
            maskSecrets
          );
          // Only indexes that ALREADY exist on AWS can take an `Update`
          // action; a GSI introduced by this same deploy is created (with
          // its throughput) by step 6's `added` loop.
          // `Array.isArray` rather than a bare cast: a non-array value would
          // otherwise hit `.map` on a plain object and die with a bare
          // TypeError. That arm is now only reached for a shape the translator
          // above accepted; a state-recorded block it REFUSED reads as ZERO
          // existing indexes, which would omit capacity for every live index
          // and get the flip rejected — so the live table's own names are used
          // instead (issue #1551).
          // EVERY index live on AWS needs throughput in this call, including
          // one this deploy REMOVES: its `Delete` is issued by step 6, which
          // runs AFTER the flip, so at flip time it is still a live index on
          // a table becoming PROVISIONED and AWS rejects the call if it has
          // no capacity. Its throughput therefore has to come from the
          // PREVIOUS template — the new one no longer mentions it.
          //
          // Translated BEFORE the name scan below (issue #1551): this is the
          // first previous-side translation on the flip path, so it is what
          // discovers a malformed state-recorded block, and the scan needs
          // that answer to pick its source.
          const previousFlipIndexes = toSdkGlobalSecondaryIndexes(
            previousProperties,
            currentRegion,
            newBilling,
            'seed',
            undefined,
            onUnusablePreviousGsiBlock,
            maskSecrets
          );
          // A flip TO PROVISIONED with an unusable block on EITHER side is
          // refused outright (issue #1551). AWS requires per-index
          // `ProvisionedThroughput` for every live index in this very call, and
          // neither fallback can supply it: the desired block is the junk one,
          // and `DescribeTable` reports `{0, 0}` for every index while the
          // table is still PAY_PER_REQUEST, which AWS rejects.
          //
          // It is a THROW rather than the warn-and-skip this branch first
          // shipped, because a skipped flip still SUCCEEDS — the engine then
          // records `BillingMode: PROVISIONED` as state while the table stays
          // on-demand, and the next deploy compares state against state, never
          // recomputes the flip, and translates every later GSI update under
          // the wrong mode. That is a permanent, silent divergence; refusing
          // loudly leaves the table exactly as it is and names the remedy.
          if (desiredGsiUnusable || previousGsiUnusable) {
            throw new ProvisioningError(
              `Cannot flip AWS::DynamoDB::GlobalTable ${logicalId} to PROVISIONED while its ` +
                `GlobalSecondaryIndexes block is unusable: AWS requires per-index provisioned ` +
                `capacity in the same UpdateTable, and it cannot be derived from a malformed ` +
                `block (nor read from a table that is still on-demand). Fix the ` +
                `GlobalSecondaryIndexes value — in the template, or in the cdkd state record ` +
                `on a rollback / drift --revert replay — and re-deploy. The table is ` +
                `unchanged.`,
              resourceType,
              logicalId,
              physicalId
            );
          }
          const previousByIndexName = new Map<string, GlobalSecondaryIndex>();
          for (const gsi of previousFlipIndexes) {
            if (gsi.IndexName) previousByIndexName.set(gsi.IndexName, gsi);
          }
          const previousCfnIndexes = previousProperties['GlobalSecondaryIndexes'];
          const existingIndexNames = new Set(
            (Array.isArray(previousCfnIndexes) ? (previousCfnIndexes as unknown[]) : [])
              .map((entry) => (entry as Record<string, unknown> | null)?.['IndexName'])
              .filter((name): name is string => typeof name === 'string')
          );
          const byIndexName = new Map(previousByIndexName);
          const survivingIndexNames = new Set<string>();
          for (const gsi of provisionedIndexes) {
            if (!gsi.IndexName) continue;
            survivingIndexNames.add(gsi.IndexName);
            byIndexName.set(gsi.IndexName, gsi);
          }
          const indexUpdates: GlobalSecondaryIndexUpdate[] = [];
          for (const indexName of existingIndexNames) {
            const gsi = byIndexName.get(indexName);
            if (!gsi?.ProvisionedThroughput) continue;
            // Every index handled here is skipped by step 6's `modified` loop,
            // so a simultaneous WarmThroughput change has to ride along or it
            // is dropped with no warning. Sent only when it actually differs —
            // warm throughput is increase-only, so re-asserting the current
            // value on an unrelated capacity edit is a needless AWS-side risk.
            const previousWarm = previousByIndexName.get(indexName)?.WarmThroughput;
            const warmChanged =
              gsi.WarmThroughput !== undefined && !deepEqual(gsi.WarmThroughput, previousWarm);
            // Issue #1857: a change is not automatically a SENDABLE change.
            // AWS rejects a decrease, and this ride-along rides on a flip the
            // user does want — forwarding a doomed member would fail the whole
            // flip over a property that is not what they were changing.
            const warmToSend = warmChanged
              ? this.warmThroughputForSend(
                  indexName,
                  gsi.WarmThroughput,
                  liveWarmByIndexName,
                  logicalId,
                  physicalId,
                  maskSecrets
                )
              : undefined;
            indexUpdates.push({
              Update: {
                IndexName: indexName,
                ProvisionedThroughput: gsi.ProvisionedThroughput,
                ...(warmToSend && { WarmThroughput: warmToSend }),
              },
            });
            // Only a SURVIVING index is "handled" — step 6's `modified` loop
            // is what this set suppresses, and a removed index belongs to the
            // `removed` loop, which must still run.
            if (survivingIndexNames.has(indexName)) gsiHandledByBillingFlip.add(indexName);
          }
          if (indexUpdates.length > 0) {
            billingUpdate.GlobalSecondaryIndexUpdates = indexUpdates;
          }
        }
        markUnsettled(
          'BillingMode',
          'WriteProvisionedThroughputSettings',
          TABLE_READ_PROVISIONED_KEY
        );
        if (billingUpdate.GlobalSecondaryIndexUpdates !== undefined) {
          markUnsettled('GlobalSecondaryIndexes');
          for (const indexUpdate of billingUpdate.GlobalSecondaryIndexUpdates) {
            debug(
              `Sending UpdateTable GlobalSecondaryIndexUpdates Update for index ` +
                `${maskSecrets(indexUpdate.Update?.IndexName ?? '')} on ${physicalId} (with the billing mode change)`
            );
          }
        }
        await this.dynamoDBClient.send(new UpdateTableCommand(billingUpdate));
        await this.waitForTableActiveAfterUpdate(
          physicalId,
          logicalId,
          undefined,
          undefined,
          maskSecrets
        );
      }

      // 4a. The table-level on-demand ceilings a PROVISIONED ->
      // PAY_PER_REQUEST flip deferred (see step 3's `deferCeilingsPastFlip`):
      // now that the table IS on-demand, the declared ceilings are a plain
      // ceiling-set. Sent as its own UpdateTable — AWS's state-machine rule
      // wants the flip call to carry the flip, and the well-probed payload
      // shape here is the same one step 3 sends on a non-flip deploy.
      if (deferCeilingsPastFlip) {
        markUnsettled('WriteOnDemandThroughputSettings', 'ReadOnDemandThroughputSettings');
        await this.dynamoDBClient.send(
          new UpdateTableCommand({ TableName: physicalId, OnDemandThroughput: onDemandPayload })
        );
        await this.waitForTableActiveAfterUpdate(
          physicalId,
          logicalId,
          undefined,
          undefined,
          maskSecrets
        );
      }

      // 4a'. go-to-k/cdkd#2762, go-to-k/cdkd#5604: a changed literal capacity,
      // on either side. `ProvisionedThroughput` takes both members, so a side
      // this update does not change goes out as AWS holds it, which is also how
      // an auto-scaled side stays with its scaling policy. A value AWS holds is
      // not sent: DynamoDB refuses a `ProvisionedThroughput` that changes nothing.
      //
      // `ProvisionedThroughput` on a table with a cross-region replica sets
      // every region to the sent read capacity and clears its
      // `ProvisionedThroughputOverride`, a write-only change included (measured,
      // go-to-k/cdkd#5604). So a read change alone goes out as the local
      // region's override, which leaves the others alone (the result
      // CloudFormation reaches, measured), and a write change, which has no
      // such route, puts back each region's read, as that region reports it
      // rather than from the override the local region lists.
      if (tableCapacityChange) {
        const liveThroughput = describeResp.Table?.ProvisionedThroughput;
        const sendRead = tableCapacityChange.read ?? liveThroughput?.ReadCapacityUnits;
        const sendWrite = tableCapacityChange.write ?? liveThroughput?.WriteCapacityUnits;
        const readMoves = sendRead !== liveThroughput?.ReadCapacityUnits;
        const writeMoves = sendWrite !== liveThroughput?.WriteCapacityUnits;
        if (sendRead !== undefined && sendWrite !== undefined && (readMoves || writeMoves)) {
          // Read before the send, which loses them. A region already at the sent
          // read has nothing to put back. A failed read stops here, with nothing
          // changed.
          const readsToRestore =
            writeMoves && liveHasCrossRegionReplica
              ? await this.readRegionReadsToRestore(
                  physicalId,
                  describeResp.Table?.Replicas ?? [],
                  currentRegion,
                  sendRead
                )
              : [];
          // After a failure, `Replicas` makes the next deploy send what the
          // template declares for each region; a value it does not declare is
          // named in the warning below, and nothing recovers it.
          markUnsettled(
            ...(readMoves ? tableCapacityChange.readKeys : []),
            ...(writeMoves ? [TABLE_WRITE_PROVISIONED_KEY] : []),
            ...(readsToRestore.length > 0 ? ['Replicas'] : [])
          );
          await this.dynamoDBClient.send(
            new UpdateTableCommand(
              liveHasCrossRegionReplica && !writeMoves
                ? {
                    TableName: physicalId,
                    ReplicaUpdates: [
                      {
                        Update: {
                          RegionName: currentRegion,
                          ProvisionedThroughputOverride: { ReadCapacityUnits: sendRead },
                        },
                      },
                    ],
                  }
                : {
                    TableName: physicalId,
                    ProvisionedThroughput: {
                      ReadCapacityUnits: sendRead,
                      WriteCapacityUnits: sendWrite,
                    },
                  }
            )
          );
          const unrestored = [...readsToRestore];
          try {
            // The whole group: another region moves with this one, and step 5
            // meets a refusal while a replica is still updating.
            if (liveHasCrossRegionReplica) {
              await this.waitForGlobalTableSettled(physicalId, logicalId, maskSecrets);
            } else {
              await this.waitForTableActiveAfterUpdate(
                physicalId,
                logicalId,
                undefined,
                undefined,
                maskSecrets
              );
            }
            for (const { region, read } of readsToRestore) {
              await this.dynamoDBClient.send(
                new UpdateTableCommand({
                  TableName: physicalId,
                  ReplicaUpdates: [
                    {
                      Update: {
                        RegionName: region,
                        ProvisionedThroughputOverride: { ReadCapacityUnits: read },
                      },
                    },
                  ],
                })
              );
              await this.waitForGlobalTableSettled(physicalId, logicalId, maskSecrets);
              unrestored.shift();
            }
          } catch (putBackError) {
            if (unrestored.length > 0) {
              warn(
                `${maskSecrets(physicalId)}: the write capacity update set every region's read ` +
                  `capacity to ${sendRead} and failed before putting back: ` +
                  `${unrestored.map((r) => `${r.region}=${r.read}`).join(', ')}. A value the ` +
                  `template declares goes out on the next deploy; any other stays at ` +
                  `${sendRead} until set with UpdateTable ReplicaUpdates ` +
                  `(ProvisionedThroughputOverride).`
              );
            }
            throw putBackError;
          }
        }
      }

      // 4b. Table-level write auto-scaling diff (Issue #402 / closes #395
      // deferred items). Fires whenever the WriteCapacityAutoScalingSettings
      // sub-shape differs between old and new (incl. add / remove). Skipped
      // when the table is PAY_PER_REQUEST on BOTH sides — autoscaling
      // targets are meaningless without ProvisionedThroughput. When the
      // BillingMode flipped PROVISIONED -> PAY_PER_REQUEST, force tear-down
      // regardless of whether the template still carries the settings:
      // autoscaling is invalid on PAY_PER_REQUEST.
      //
      // Placed AFTER the BillingMode flip so a PAY_PER_REQUEST -> PROVISIONED
      // template flip plus a new WriteCapacityAutoScalingSettings doesn't try
      // to RegisterScalableTarget against a not-yet-PROVISIONED table.
      const writeAutoScalingOld = (
        (previousProperties['WriteProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
      )['WriteCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
      const writeAutoScalingNew = (
        (properties['WriteProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
      )['WriteCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
      const billingFlippedToOnDemand =
        oldBilling === 'PROVISIONED' && newBilling === 'PAY_PER_REQUEST';
      // Force teardown on a flip to PAY_PER_REQUEST regardless of whether
      // the template still carries the (now-invalid) autoscaling settings
      // — AWS rejects targets on on-demand tables, so any prior target
      // must come down.
      const effectiveNewAutoScaling = billingFlippedToOnDemand ? undefined : writeAutoScalingNew;
      // Dimensions applied by THIS update() before step 6b runs. 6b skips
      // these so they are not re-issued, while a dimension whose diff gate
      // below declined to fire stays absent from the set and is therefore
      // still backfilled by 6b (Issue #1419 — see reconcileAutoScalingTargets).
      const autoScalingApplied = new Set<string>();
      const autoScalingMeaningful = newBilling === 'PROVISIONED' || oldBilling === 'PROVISIONED';
      if (autoScalingMeaningful && !deepEqual(writeAutoScalingOld, effectiveNewAutoScaling)) {
        await this.applyAutoScalingDiff(
          physicalId,
          'dynamodb:table:WriteCapacityUnits',
          writeAutoScalingOld,
          effectiveNewAutoScaling,
          undefined,
          undefined,
          undefined,
          maskSecrets
        );
        autoScalingApplied.add(
          autoScalingTargetKey({
            dimension: 'dynamodb:table:WriteCapacityUnits',
            region: currentRegion,
          })
        );
      }

      // go-to-k/cdkd#5489: a REMOVED settings replication mode is reset
      // before the replica diff, while the table still has the one replica a
      // mode is valid on; a declared one is sent after it (below).
      const modeUpdate = replicationModeUpdate(properties, previousProperties);
      if (modeUpdate === 'DISABLED' && readReplicationMode(properties).kind === 'absent') {
        await this.sendReplicationMode(physicalId, logicalId, modeUpdate, maskSecrets);
      }

      // 5. Replica diff. AWS limits to ONE ReplicaUpdates entry per call,
      // so serialize Create / Update / Delete and wait between each.
      // `currentRegion` is already resolved once at the top of update().
      const replicaDiff = diffReplicas(
        (previousProperties['Replicas'] ?? []) as Array<Record<string, unknown>>,
        (properties['Replicas'] ?? []) as Array<Record<string, unknown>>
      );
      // Removes first: AWS rejects DeleteTable on a multi-replica table
      // but tolerates dropping replicas while the rest stay live.
      for (const replica of replicaDiff.removed) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;

        // Per-replica read auto-scaling teardown (Issue #402). When the
        // removed replica had `ReadCapacityAutoScalingSettings`, the
        // scalable target + policy in the replica's region must be torn
        // down BEFORE the ReplicaUpdates Delete: AWS's application-
        // autoscaling control plane stays around after the table replica
        // disappears, and a future re-add of the same region would
        // collide. Best-effort: failures log at WARN and the deploy
        // continues to drop the replica.
        const removedReadAutoScaling = (
          (replica['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
        )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
        if (removedReadAutoScaling) {
          const regionalAutoScalingClient = this.getRegionalAutoScalingClient(region);
          await this.applyAutoScalingDiff(
            physicalId,
            'dynamodb:table:ReadCapacityUnits',
            removedReadAutoScaling,
            undefined,
            regionalAutoScalingClient,
            undefined,
            undefined,
            maskSecrets
          );
          autoScalingApplied.add(
            autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
          );
        }

        markUnsettled('Replicas');
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            ReplicaUpdates: [{ Delete: { RegionName: region } }],
          })
        );
        await this.waitForReplicaGone(
          physicalId,
          region,
          logicalId,
          undefined,
          undefined,
          maskSecrets
        );
        // go-to-k/cdkd#5581: the targets DynamoDB registered for this replica
        // (its write dimension included) outlive it; drop them once its table
        // is past the point of return.
        await this.deregisterRemovedReplicaScalableTargets(physicalId, region, { maskSecrets });
      }
      for (const replica of replicaDiff.added) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        // Diagnostics already emitted by the pre-flight scan at the top of
        // update(); passing the collector again would warn twice.
        await this.addReplica(
          physicalId,
          replica,
          region,
          logicalId,
          newBilling,
          undefined,
          maskSecrets
        );

        // Cross-region Tags propagation for the newly-added replica
        // (Issue #441 follow-up — mirrors the create-side + modified
        // paths). `UpdateTable(ReplicaUpdates: [{Create: ...}])` does
        // not accept a `Tags` field, so any `Replicas[].Tags` declared
        // in the new replica entry must be applied via a separate
        // `TagResource` against the replica's region-scoped ARN.
        const newReplicaTags: unknown = replica['Tags'];
        await this.applyCrossRegionReplicaTagsDiff(
          tableArn,
          region,
          undefined,
          newReplicaTags,
          resourceType,
          logicalId,
          physicalId,
          maskSecrets
        );

        // Per-replica read auto-scaling (Issue #402): when the new
        // replica has `ReadCapacityAutoScalingSettings`, register the
        // scalable target + target-tracking policy in the replica's
        // region right after the replica becomes ACTIVE. Skipped on
        // PAY_PER_REQUEST tables (autoscaling is meaningless without
        // ProvisionedThroughput).
        const newReadAutoScaling = (
          (replica['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
        )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
        if (newBilling === 'PROVISIONED' && newReadAutoScaling) {
          const regionalAutoScalingClient = this.getRegionalAutoScalingClient(region);
          await this.applyAutoScalingDiff(
            physicalId,
            'dynamodb:table:ReadCapacityUnits',
            undefined,
            newReadAutoScaling,
            regionalAutoScalingClient,
            undefined,
            undefined,
            maskSecrets
          );
          autoScalingApplied.add(
            autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
          );
        }
      }
      for (const replica of replicaDiff.modified) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;

        // Look up the matching previous replica entry so we can diff
        // Tags independently of the non-Tags fields (UpdateReplica's
        // SDK action does not accept Tags — cross-region tag changes
        // must go through TagResource / UntagResource against the
        // replica's region-scoped table ARN).
        const oldReplica = (
          (previousProperties['Replicas'] ?? []) as Array<Record<string, unknown>>
        ).find((r) => r['Region'] === region);
        const oldReplicaTags: unknown = oldReplica?.['Tags'];
        const newReplicaTags: unknown = replica['Tags'];

        // Cross-region Tags propagation (Issue #389): delegate to the
        // shared `applyCrossRegionReplicaTagsDiff` helper (also used by
        // `create()` per Issue #441) — the helper handles the
        // diff-equals-no-op short-circuit, the ARN-derivation guard,
        // and the best-effort WARN-on-failure contract uniformly across
        // both code paths.
        await this.applyCrossRegionReplicaTagsDiff(
          tableArn,
          region,
          oldReplicaTags,
          newReplicaTags,
          resourceType,
          logicalId,
          physicalId,
          maskSecrets
        );

        // Per-replica read auto-scaling diff (Issue #402 / closes #395
        // deferred items). The read dimension's scalable target +
        // policy live in the REPLICA's region (each replica registers
        // its own target with `application-autoscaling` in its own
        // region), so route through a region-scoped autoscaling client.
        const oldReadAutoScaling = (
          (oldReplica?.['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
        )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
        const newReadAutoScaling = (
          (replica['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
        )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
        const effectiveNewReadAutoScaling =
          newBilling === 'PAY_PER_REQUEST' ? undefined : newReadAutoScaling;
        if (
          (newBilling === 'PROVISIONED' || oldBilling === 'PROVISIONED') &&
          !deepEqual(oldReadAutoScaling, effectiveNewReadAutoScaling)
        ) {
          const regionalAutoScalingClient = this.getRegionalAutoScalingClient(region);
          await this.applyAutoScalingDiff(
            physicalId,
            'dynamodb:table:ReadCapacityUnits',
            oldReadAutoScaling,
            effectiveNewReadAutoScaling,
            regionalAutoScalingClient,
            undefined,
            undefined,
            maskSecrets
          );
          autoScalingApplied.add(
            autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
          );
        }

        // A replica's KMS key is not sent here: DynamoDB refuses a key
        // change for one replica alone ("KMSMasterKeyId must be specified
        // for each replica", measured), so `applyReplicaKeys` sets every
        // region's key in one call after this loop (go-to-k/cdkd#5355). A
        // REMOVED key (CDK's `customerManagedKey` -> `awsManagedKey`) needs
        // nothing here either: the table's `SSESpecification` update moves
        // every replica to the AWS managed key (measured).
        const updateAction: UpdateReplicationGroupMemberAction = { RegionName: region };
        // Same CFn -> SDK per-replica GSI throughput translation as the
        // create-side `addReplica` (Issue #1387).
        const replicaIndexes = toSdkReplicaGlobalSecondaryIndexes(
          replica['GlobalSecondaryIndexes'],
          newBilling,
          undefined,
          maskSecrets
        );
        if (replicaIndexes) {
          updateAction.GlobalSecondaryIndexes = replicaIndexes;
        }
        // The replica's own TABLE-level read ceiling / read capacity, which
        // uses the same two CFn spellings one level up (issue #1436).
        //
        // SET only — there is deliberately NO reset arm here, and that is a
        // probe-informed decision rather than an omission. Live probe
        // (us-east-1 source + us-west-2 replica, 2026-08-09, recorded on
        // issue #1436): `OnDemandThroughputOverride: {MaxReadRequestUnits: -1}`
        // is ACCEPTED but reads back LITERALLY as -1 — it is not a reset
        // sentinel here, unlike the table-level member — and the empty-block
        // form `OnDemandThroughputOverride: {}` left the table stuck in
        // UPDATING for over an hour, after which AWS refused to delete it for
        // 24 hours. So a template that DROPS a non-local replica's ceiling
        // leaves the old override live, and says so, rather than corrupting
        // the table with a payload probing already proved hazardous.
        const replicaOverrides = toSdkReplicaThroughputOverrides(
          replica,
          newBilling,
          undefined,
          {},
          maskSecrets
        );
        if (replicaOverrides.ProvisionedThroughputOverride) {
          updateAction.ProvisionedThroughputOverride =
            replicaOverrides.ProvisionedThroughputOverride;
        }
        if (replicaOverrides.OnDemandThroughputOverride) {
          updateAction.OnDemandThroughputOverride = replicaOverrides.OnDemandThroughputOverride;
        }
        // A DROPPED override is reported rather than acted on, for the reason
        // above. Only when the billing mode held still — a flip re-shapes both
        // sides by construction, so "the old override is gone" there is the
        // translation, not a template edit.
        if (oldBilling === newBilling) {
          const oldReplicaOverrides = toSdkReplicaThroughputOverrides(
            oldReplica ?? {},
            oldBilling,
            undefined,
            {},
            maskSecrets
          );
          const droppedOverrides: string[] = [];
          if (
            oldReplicaOverrides.OnDemandThroughputOverride &&
            !replicaOverrides.OnDemandThroughputOverride
          ) {
            droppedOverrides.push('ReadOnDemandThroughputSettings');
          }
          if (
            oldReplicaOverrides.ProvisionedThroughputOverride &&
            !replicaOverrides.ProvisionedThroughputOverride
          ) {
            droppedOverrides.push('ReadProvisionedThroughputSettings');
          }
          if (droppedOverrides.length > 0) {
            warn(
              `Cross-region replica ${region} of ${physicalId}: the template no longer ` +
                // Override MEMBER NAMES come out of the resolved `Replicas`
                // bag, so each is masked raw before the join (issue #1997).
                `declares ${droppedOverrides.map((o) => maskSecrets(o)).join(' / ')}, but ` +
                `DynamoDB offers no way to ` +
                `CLEAR a replica-level throughput override — a -1 sentinel is stored ` +
                `literally, and an empty override block wedges the table in UPDATING. ` +
                `The previous override is STILL IN ` +
                `EFFECT on AWS. Set an explicit value, or remove and re-add the replica, ` +
                `to change it.`
            );
          }
        }
        const replicaTableClassChange = tableClassToSend(
          readReplicaTableClass(oldReplica),
          readReplicaTableClass(replica)
        );
        if (replicaTableClassChange !== undefined) {
          updateAction.TableClassOverride = replicaTableClassChange;
        }
        // AWS rejects an UpdateReplica with no update fields
        // (ValidationException). When the only change in the modified
        // replica is `Tags` (now applied above via per-region client),
        // the updateAction has only `RegionName`. Skip the
        // UpdateReplica SDK call in that case — the Tags-only diff is
        // already in flight against the regional client.
        const hasUpdateField =
          updateAction.GlobalSecondaryIndexes !== undefined ||
          updateAction.TableClassOverride !== undefined ||
          updateAction.ProvisionedThroughputOverride !== undefined ||
          updateAction.OnDemandThroughputOverride !== undefined;
        if (!hasUpdateField) {
          debug(
            `Cross-region replica ${region} of ${maskSecrets(physicalId)}: only Tags-style ` +
              `changes detected; UpdateReplica skipped (AWS rejects empty ` +
              `Update actions). Tags propagation handled above via per-region client.`
          );
          continue;
        }
        markUnsettled('Replicas');
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            ReplicaUpdates: [{ Update: updateAction }],
          })
        );
        await this.waitForReplicaActive(physicalId, region, logicalId, undefined, maskSecrets);
      }
      const addedReplicaRegions = new Set(replicaDiff.added.map((r) => r['Region']));
      if (modeUpdate !== undefined && readReplicationMode(properties).kind === 'usable') {
        await this.sendReplicationMode(physicalId, logicalId, modeUpdate, maskSecrets);
      } else {
        // A declared mode the template did not change, which a pre-fix deploy
        // never sent: compared with the mode update()'s first DescribeTable
        // reported (no extra read, so a failure of that read fails the update
        // as before), and the corrective UpdateTable is best-effort — a failed
        // SEND is reported, not thrown.
        const correction = replicationModeCorrection(
          properties,
          previousProperties,
          describeResp.Table?.GlobalTableSettingsReplicationMode
        );
        if (correction !== undefined) {
          await this.sendReplicationMode(physicalId, logicalId, correction, maskSecrets, false);
        }
      }
      await this.convergeReplicaDeletionProtection(
        physicalId,
        logicalId,
        currentRegion,
        previousProperties,
        properties,
        addedReplicaRegions,
        context?.desiredFromAwsReadback === true,
        warn,
        maskSecrets
      );
      await this.convergeReplicaSettings(
        physicalId,
        logicalId,
        currentRegion,
        properties,
        addedReplicaRegions,
        maskSecrets
      );
      await this.applyReplicaKeys(
        physicalId,
        logicalId,
        currentRegion,
        properties,
        previousProperties,
        addedReplicaRegions,
        deferredSseUpdate,
        deferredSseFromTemplate,
        keylessSseFromTemplate,
        maskSecrets
      );
      // A read-back omits a member whose read failed, and carries a policy
      // only where one is declared: an absence there is no removal. A rollback replay must not
      // turn recovery off on a record whose update may never have sent it.
      const replicaKeepOnRemoval = new Set<ReplicaSetting>(
        context?.desiredFromAwsReadback === true
          ? [
              'pitr',
              'contributorInsights',
              'kinesis',
              'tablePolicy',
              'streamPolicy',
              // Neither is read back (go-to-k/cdkd#5489).
              'indexContributorInsights',
              'streamTags',
            ]
          : context?.replayingState === true
            ? ['pitr']
            : []
      );
      // go-to-k/cdkd#5365: the per-replica settings, the local table's
      // included, after every replica change above has settled. A
      // `StreamViewType` change minted a new stream, which holds no policy.
      await this.applyReplicaSettings(
        physicalId,
        logicalId,
        currentRegion,
        properties,
        previousProperties,
        addedReplicaRegions,
        !deepEqual(
          asRecord(properties['StreamSpecification'])?.['StreamViewType'],
          asRecord(previousProperties['StreamSpecification'])?.['StreamViewType']
        ),
        context?.replayingState === true || context?.desiredFromAwsReadback === true,
        replicaKeepOnRemoval,
        describeResp.Table?.LatestStreamArn,
        warn,
        maskSecrets
      );
      // go-to-k/cdkd#5570: after every replica change above, as a solo write
      // per replica (the local table and the replicas this update added
      // included); the GSI, auto-scaling and TTL steps below follow it.
      await this.convergeReplicaDisassociationProtection(
        physicalId,
        logicalId,
        currentRegion,
        properties,
        previousProperties,
        context?.desiredFromAwsReadback === true
          ? 'readback'
          : context?.replayingState === true
            ? 'replay'
            : 'template',
        warn,
        maskSecrets
      );

      // 6. GSI diff. New GSI Create may need additional AttributeDefinitions
      // — AWS allows combining `AttributeDefinitions` and one GSI
      // `Create` action in the same UpdateTable call.
      //
      // Both sides are translated CFn -> SDK first (Issue #1387) so the diff
      // is over the shapes actually sent to AWS. That is load-bearing twice
      // over: the emitted Create / Update actions carry real throughput
      // (pre-fix they carried none, so a PROVISIONED GSI add was rejected),
      // and an auto-scaling-only template edit — `MaxCapacity` 20 -> 30,
      // invisible to DynamoDB's own API — no longer produces a bare
      // `Update: { IndexName }` that AWS rejects as an empty update.
      // The PREVIOUS side takes the same unconditional downgrade as step 4's
      // translation of it (issue #1551) — see `onUnusablePreviousGsiBlock` —
      // and the same LIVE-table baseline, so a corrected template still
      // applies rather than being silently dropped forever.
      // Translated FIRST, then substituted: on an update with no billing flip
      // this call is the first one to touch the previous side, so the flag is
      // still false when the expression is evaluated — reading it before the
      // call would leave the empty downgrade result in place.
      const previousTranslatedIndexes = toSdkGlobalSecondaryIndexes(
        previousProperties,
        currentRegion,
        oldBilling,
        'min',
        undefined,
        onUnusablePreviousGsiBlock,
        maskSecrets
      );
      // With a junk state record the baseline is built from the DESIRED side
      // filtered to the indexes that actually EXIST live, carrying the live
      // VALUES that are safe to compare (issue #1571 — see
      // `buildLiveRecoveryGsiBaseline` for which are, which are not, and why).
      // Three properties follow:
      //   - a desired index that does NOT exist live is ADDED, which is the
      //     permanent-loss case this whole fallback exists for;
      //   - a desired index that exists live is compared on capacity /
      //     on-demand ceilings only, so a capacity edit and a #1160-class
      //     ceiling REMOVAL both apply on THIS deploy rather than lagging one;
      //   - an index live but absent from the template is in NEITHER side, so
      //     it is never DELETED. Deleting is irreversible and a junk state
      //     record cannot tell "cdkd used to manage this" from "somebody
      //     created it out of band", so the safe reading is to leave it and
      //     say so.
      const previousSdkIndexes = previousGsiUnusable
        ? buildLiveRecoveryGsiBaseline(
            desiredSdkIndexes,
            describeResp.Table?.GlobalSecondaryIndexes,
            {
              // A flip re-shapes every index by construction, and step 4 applies
              // the provisioned side atomically, so a value comparison across
              // two billing modes would measure the translation rather than the
              // user's edit.
              carryLiveValues: oldBilling === newBilling && liveBillingMode === newBilling,
              liveBillingMode,
              uncomparableCapacityIndexNames: collectUncomparableCapacityGsiNames(
                properties,
                currentRegion
              ),
            }
          )
        : previousTranslatedIndexes;
      if (previousGsiUnusable) {
        const desiredNames = new Set(
          desiredSdkIndexes
            .map((gsi) => gsi.IndexName)
            .filter((name): name is string => typeof name === 'string')
        );
        const liveOnly = [...liveIndexNames].filter((name) => !desiredNames.has(name));
        if (liveOnly.length > 0) {
          // Be precise about the remedy: a later deploy does NOT clear these.
          // Once this deploy records a valid block, the live-only index is in
          // neither the previous nor the desired side of EVERY subsequent
          // diff, so it survives indefinitely.
          //
          // `cdkd drift --accept` is NOT the remedy either, and claiming it
          // was is the same false-convergence bug one layer over (review
          // catch). Two independent reasons: `--accept` writes into
          // `observedProperties` whenever that field exists, while the deploy
          // diff's previous side is `properties`; and this provider's
          // `readCurrentState` already reverse-maps the LIVE index list, so
          // the drift report is empty and there is nothing to accept. The
          // only thing that actually clears the index is deleting it in AWS.
          warn(
            // Index names, masked raw before the join (issue #1997). These come
            // back from AWS, but a resolved value sent by an earlier deploy is
            // exactly what AWS echoes.
            `AWS::DynamoDB::GlobalTable ${logicalId}: ${liveOnly
              .map((n) => maskSecrets(n))
              .join(', ')} exist(s) on the ` +
              `table but not in the template. No Delete is issued while the recorded ` +
              `GlobalSecondaryIndexes are unusable — a junk state record cannot prove cdkd ` +
              `created them, and an index delete is irreversible. This does NOT self-heal, ` +
              `and no later cdkd deploy will remove them: delete the index directly, e.g.: ` +
              pasteableAwsCommand(
                maskSecrets
              )`aws dynamodb update-table --table-name ${physicalId} --global-secondary-index-updates '[{"Delete":{"IndexName":"<name>"}}]'`.render()
          );
        }
      }
      // `desiredSdkIndexes` was translated once at the top of update() — the
      // same call, reused rather than repeated, so the diagnostics reported
      // there provably describe the indexes actually being applied here.
      // `desiredGsiUnusable` (issue #1551): the DESIRED `GlobalSecondaryIndexes`
      // was present-but-malformed and was downgraded to an EMPTY list above.
      // Feeding that into the diff would read as "the template declares no
      // indexes" (delete every live GSI) or as "none existed" (re-create every
      // GSI), both destructive on a value nobody can act on from a template.
      // Emit no GSI action at all instead; the warning already told the user
      // why nothing moved.
      const gsiDiff: ReturnType<typeof diffGlobalSecondaryIndexes> = desiredGsiUnusable
        ? { added: [], removed: [], modified: [] }
        : diffGlobalSecondaryIndexes(previousSdkIndexes, desiredSdkIndexes);
      // RAW per-index on-demand key presence for the DESIRED side, so the
      // `modified` loop can tell "the template dropped this member" from "the
      // template set it to something that did not coerce" (issue #1440).
      const rawOnDemandDeclarations = collectRawOnDemandDeclarations(properties, currentRegion);
      // Needed by the `modified` loop to tell a REAL edit from the reshaping a
      // BillingMode flip causes by construction (both sides are translated
      // under different billing modes, so every index necessarily differs).
      const previousSdkByName = new Map<string, GlobalSecondaryIndex>();
      for (const prev of previousSdkIndexes) {
        if (prev.IndexName) previousSdkByName.set(prev.IndexName, prev);
      }
      for (const gsi of gsiDiff.removed) {
        if (!gsi.IndexName) continue;
        const gsiUpdate: GlobalSecondaryIndexUpdate = {
          Delete: { IndexName: gsi.IndexName },
        };
        markUnsettled('GlobalSecondaryIndexes');
        debug(
          `Sending UpdateTable GlobalSecondaryIndexUpdates Delete for index ` +
            `${maskSecrets(gsi.IndexName)} on ${physicalId}`
        );
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(
          physicalId,
          logicalId,
          undefined,
          undefined,
          maskSecrets
        );
      }
      for (const gsi of gsiDiff.added) {
        if (!gsi.IndexName || !gsi.KeySchema || !gsi.Projection) continue;
        const addedWarmToSend = this.warmThroughputForSend(
          gsi.IndexName,
          gsi.WarmThroughput,
          liveWarmByIndexName,
          logicalId,
          physicalId,
          maskSecrets
        );
        const gsiUpdate: GlobalSecondaryIndexUpdate = {
          Create: {
            IndexName: gsi.IndexName,
            KeySchema: gsi.KeySchema,
            Projection: gsi.Projection,
            ...(gsi.ProvisionedThroughput && {
              ProvisionedThroughput: gsi.ProvisionedThroughput,
            }),
            ...(gsi.OnDemandThroughput && { OnDemandThroughput: gsi.OnDemandThroughput }),
            // `create()` sends WarmThroughput for a GSI declared up front, so a
            // GSI ADDED by a later update must carry it too — otherwise the
            // same template yields a different index depending on whether it
            // was in the first deploy or a subsequent one.
            //
            // Routed through the same guard as the other two sites (issue
            // #1857) even though an index being CREATED has no live value to
            // decrease from — so the guard passes it through here by
            // construction. That is the point: one predicate answering for all
            // three sites is what keeps them from diverging, and an `added`
            // entry that turns out to exist live (the #1571 recovery baseline
            // reaches this loop from a junk state record) then gets the same
            // answer as everywhere else instead of an unguarded send.
            ...(addedWarmToSend && { WarmThroughput: addedWarmToSend }),
          },
        };
        markUnsettled('GlobalSecondaryIndexes');
        debug(
          `Sending UpdateTable GlobalSecondaryIndexUpdates Create for index ` +
            `${maskSecrets(gsi.IndexName ?? '')} on ${physicalId}`
        );
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            AttributeDefinitions: newAttrs,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        // go-to-k/cdkd#5498: AWS accepted the index Create.
        markAttemptedItems('GlobalSecondaryIndexes', [gsi.IndexName]);
        await this.waitForTableActiveAfterUpdate(
          physicalId,
          logicalId,
          undefined,
          undefined,
          maskSecrets
        );
      }
      for (const gsi of gsiDiff.modified) {
        // Explicit `typeof` rather than truthiness: an unresolved-intrinsic
        // `IndexName` is a truthy OBJECT, and everything downstream (the
        // declaration map, `previousSdkByName`) is keyed by string. Such an
        // entry used to fall through and be safe only by a Map identity miss —
        // an accident, not a guarantee.
        if (typeof gsi.IndexName !== 'string' || gsi.IndexName.length === 0) continue;
        // Already applied atomically with the BillingMode flip above.
        if (gsiHandledByBillingFlip.has(gsi.IndexName)) continue;
        // A BillingMode flip re-shapes EVERY index by construction: the two
        // sides are translated under different billing modes, so the old side
        // carries `ProvisionedThroughput` and the new side on-demand fields or
        // neither. Such an entry is not a template edit, so it must not draw
        // the immutable-field warning below — but it must NOT be skipped
        // wholesale either. `PAY_PER_REQUEST -> PROVISIONED` is applied
        // atomically by step 4's flip call (those indexes are filtered out
        // above); the REVERSE direction has no per-GSI field in that call, so
        // the on-demand limits have to be applied here as their own round trip.
        // A blanket skip dropped every per-GSI `Max{Read,Write}RequestUnits` on
        // a flip to on-demand — the same silent-drop class #1387 exists to close.
        const billingFlipped = oldBilling !== newBilling;
        const update: UpdateGlobalSecondaryIndexAction = { IndexName: gsi.IndexName };
        // On-demand limits: MERGE the desired side with an explicit reset for
        // every member the template DROPPED. Omitting a removed member leaves
        // the old ceiling live in AWS forever while cdkd reports success — the
        // absent-field-reset silent-drop class (#1160), one level down inside a
        // nested block (#1225). CloudFormation resets it.
        //
        // Merging rather than branching is load-bearing: the read limit comes
        // from `Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughput-
        // Settings` and the write limit from `GSI.WriteOnDemandThroughputSettings`
        // — two INDEPENDENT CDK props. An `else if` that only fired when the new
        // side had no on-demand block at all would still silently drop the
        // single-member removal, which is the likelier user edit.
        //
        // `-1` is the reset sentinel, LIVE-VERIFIED rather than inferred from
        // the table-level field's docs (issue #1423). Both payload shapes were
        // probed against real AWS: `{-1, -1}` cleared both members, and the
        // MIXED `{MaxReadRequestUnits: 50, MaxWriteRequestUnits: -1}` was
        // accepted and read back as `{MaxReadRequestUnits: 50}` — the dropped
        // member cleared, the kept one preserved. In both cases the reset reads
        // back as ABSENCE, never as -1, so drift comparisons must expect that.
        //
        // Skipped on a billing flip, where "no on-demand fields" is just the
        // translation of a PROVISIONED side rather than a template removal.
        //
        // The "was it dropped" test reads the RAW CFn keys, not the translated
        // side (issue #1440). `toSdkGlobalSecondaryIndexes` coerces through
        // `coerceCfnInteger`, so a present-but-unparseable value (an unresolved
        // `{Ref: …}`) arrives here as `undefined` and is indistinguishable from
        // a removal — which sent `-1` and silently CLEARED the ceiling the
        // template was trying to SET.
        //
        // Be precise about what the guard buys, because the obvious claim is
        // WRONG: it does NOT put the value back on a path that reaches AWS.
        // The coercion happened upstream, so the unparseable value is already
        // gone by the time this loop runs and NOTHING is sent for that member.
        // What the guard removes is the DESTRUCTIVE half — cdkd no longer
        // deletes a ceiling the user was trying to set — and what remains is a
        // no-op. A no-op with no explanation is its own trap, so the
        // suppression is reported: without it the only output was the
        // immutable-field warning below, which tells the user to RECREATE THE
        // INDEX — advice that is both useless and alarming for what is really
        // an unresolved intrinsic in their template.
        const previousOnDemand = previousSdkByName.get(gsi.IndexName)?.OnDemandThroughput;
        const declared = rawOnDemandDeclarations.get(gsi.IndexName);
        const onDemand: OnDemandThroughput = { ...gsi.OnDemandThroughput };
        const unresolvedMembers: string[] = [];
        if (!billingFlipped && previousOnDemand) {
          if (
            previousOnDemand.MaxReadRequestUnits !== undefined &&
            onDemand.MaxReadRequestUnits === undefined
          ) {
            if (declared?.readDeclared) unresolvedMembers.push('MaxReadRequestUnits');
            else onDemand.MaxReadRequestUnits = ON_DEMAND_LIMIT_RESET;
          }
          if (
            previousOnDemand.MaxWriteRequestUnits !== undefined &&
            onDemand.MaxWriteRequestUnits === undefined
          ) {
            if (declared?.writeDeclared) unresolvedMembers.push('MaxWriteRequestUnits');
            else onDemand.MaxWriteRequestUnits = ON_DEMAND_LIMIT_RESET;
          }
        }
        // `unresolvedMembers` is no longer REPORTED from here (issue #1444 A
        // moved the diagnostic into the translation, where the value is
        // actually lost and where it also fires for a first-time set and
        // across a billing flip — two cases this gate never runs for). It is
        // still TRACKED, because it suppresses the immutable-field warning
        // below: telling the user to recreate the index is wrong and alarming
        // advice for what is really an unresolved intrinsic.
        if (Object.keys(onDemand).length > 0) update.OnDemandThroughput = onDemand;
        // Provisioned capacity on a flip is step 4's job, so only a real
        // same-billing-mode edit sends it from here.
        if (!billingFlipped && gsi.ProvisionedThroughput) {
          update.ProvisionedThroughput = gsi.ProvisionedThroughput;
        }
        // `WarmThroughput` is billing-mode independent, so a flip must not
        // swallow a simultaneous change to it. Sent only when it actually
        // differs, in EVERY case — DynamoDB warm throughput is increase-only,
        // so re-asserting the current value on an unrelated capacity edit is a
        // needless AWS-side risk, and the extra UpdateTable would also cost a
        // wait-for-ACTIVE.
        const previousSdk = previousSdkByName.get(gsi.IndexName);
        let warmDecreaseRefused = false;
        if (
          gsi.WarmThroughput !== undefined &&
          !deepEqual(gsi.WarmThroughput, previousSdk?.WarmThroughput)
        ) {
          // Issue #1857: AWS rejects a decrease, so a template that has fallen
          // behind a value AWS grew on its own would fail this index's whole
          // UpdateTable — including the capacity edit the user actually made.
          const warmToSend = this.warmThroughputForSend(
            gsi.IndexName,
            gsi.WarmThroughput,
            liveWarmByIndexName,
            logicalId,
            physicalId,
            maskSecrets
          );
          if (warmToSend) update.WarmThroughput = warmToSend;
          else warmDecreaseRefused = true;
        }
        // A GSI whose only change is KeySchema / Projection produces no
        // throughput fields; AWS rejects an `Update` action with nothing
        // but an IndexName, so skip and let the (immutable) change surface
        // as a no-op rather than a confusing ValidationException.
        if (!update.ProvisionedThroughput && !update.OnDemandThroughput && !update.WarmThroughput) {
          // `unresolvedMembers` already explained the emptiness above. Falling
          // through would ALSO print "recreate the index under a new name",
          // which is wrong advice for an unresolved intrinsic and contradicts
          // the warning just emitted — the user would get two messages, one of
          // them misleading.
          //
          // `warmDecreaseRefused` is the same shape one issue later (#1857): a
          // GSI whose ONLY change is a WarmThroughput decrease empties this
          // update because cdkd DECLINED to send the member, and it has just
          // said so in a message that names the property and the remedy.
          // Adding "KeySchema / Projection are immutable, recreate the index"
          // on top would be flatly wrong — nothing immutable changed, and
          // recreating the index would not raise a warm throughput AWS itself
          // grew.
          if (!billingFlipped && unresolvedMembers.length === 0 && !warmDecreaseRefused) {
            warn(
              // The index NAME is a resolved property value, masked raw so it
              // reaches the WHOLE-VALUE arm at any length (issue #1997).
              `GSI '${maskSecrets(gsi.IndexName ?? '')}' on ${physicalId} changed in a way ` +
                `DynamoDB's ` +
                `UpdateTable cannot express (KeySchema / Projection are immutable on an ` +
                `existing index). Recreate the index under a new name to apply the change.`
            );
          }
          continue;
        }
        const gsiUpdate: GlobalSecondaryIndexUpdate = { Update: update };
        markUnsettled('GlobalSecondaryIndexes');
        // One line per index change sent, Delete / Create / Update alike (the
        // dynamodb-globaltable integ reads them: an index it must not see
        // touched, #1585).
        debug(
          `Sending UpdateTable GlobalSecondaryIndexUpdates Update for index ` +
            `${maskSecrets(gsi.IndexName ?? '')} on ${physicalId}`
        );
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(
          physicalId,
          logicalId,
          undefined,
          undefined,
          maskSecrets
        );
      }

      // 6a. go-to-k/cdkd#2762: VectorIndexes, planned and refused above. After
      // the GSI ops, each in its own `UpdateTable`.
      if (vectorIndexPlan !== undefined) {
        await this.applyVectorIndexUpdates(
          physicalId,
          logicalId,
          vectorIndexPlan,
          properties['AttributeDefinitions'] as AttributeDefinition[] | undefined,
          maskSecrets
        );
      }

      // 6a'. go-to-k/cdkd#2762: the table's WarmThroughput. A removal sends
      // nothing (the API has no such call, and AWS keeps the value), as on
      // `AWS::DynamoDB::Table`. The diagnostics report an unusable block.
      if (!deepEqual(properties['WarmThroughput'], previousProperties['WarmThroughput'])) {
        const warmCoercion = coerceWarmThroughput(properties['WarmThroughput']);
        const warmToSend = this.tableWarmThroughputForSend(
          warmCoercion.spec,
          describeResp.Table?.WarmThroughput,
          logicalId,
          physicalId,
          maskSecrets
        );
        if (warmToSend) {
          markUnsettled('WarmThroughput');
          await this.dynamoDBClient.send(
            new UpdateTableCommand({ TableName: physicalId, WarmThroughput: warmToSend })
          );
          await this.waitForTableActiveAfterUpdate(
            physicalId,
            logicalId,
            undefined,
            undefined,
            maskSecrets
          );
        }
      }

      // 6b. Auto-scaling reconciliation across ALL FOUR scalable dimensions
      // (Issue #1419). Two of them were unreachable before this change:
      //   - `dynamodb:index:*` was never registered anywhere, so a per-GSI
      //     `*CapacityAutoScalingSettings` block produced only an initial
      //     capacity and the index never scaled.
      //   - `dynamodb:table:ReadCapacityUnits` for the LOCAL region was
      //     never registered either — the replica loops in step 5 all
      //     `continue` on `currentRegion`, so only CROSS-REGION replicas
      //     ever got a read target.
      //
      // The other two (table-level write in 4b, cross-region read in step 5)
      // ARE reconciled here as well, deliberately, even though those steps
      // already touch them. An earlier cut excluded them by filter to keep
      // their call sequences pristine, and that was wrong: both of those
      // steps are DIFF-GATED (`!deepEqual(old, new)`, and an unchanged
      // replica appears in none of added/modified/removed at all), which is
      // exactly the condition `reconcileAutoScalingTargets` documents as
      // un-backfillable. A table created by the pre-fix `create()` — which
      // registered nothing — has byte-identical settings on both sides of
      // every later deploy, so a diff gate never fires and those two
      // dimensions would stay unregistered forever. Re-applying is safe: the
      // register/put pair is an idempotent upsert, and on a flip to
      // PAY_PER_REQUEST the second teardown just returns
      // `ObjectNotFoundException`, which `applyAutoScalingDiff` suppresses.
      //
      // Placed after step 6 so an index added by this same deploy already
      // exists — `RegisterScalableTarget` on `table/<t>/index/<i>` needs the
      // index to be there — and an index dropped by it is already gone,
      // leaving only its orphan target to deregister. Deregistering a
      // removed REPLICA's index targets after step 5 dropped the replica
      // (rather than before, as step 5 does for its own table-level read
      // target) is fine and not a contradiction of that rationale: an
      // application-autoscaling target is a record in a SEPARATE control
      // plane that outlives the DynamoDB resource, which is precisely why
      // it has to be deregistered explicitly at all — the ordering only
      // matters for step 5's own call, which must not race its replica
      // delete.
      //
      // Billing gating mirrors 4b: meaningful when either side is
      // PROVISIONED, and a flip TO `PAY_PER_REQUEST` forces a full teardown
      // regardless of what the template still says, because AWS rejects
      // scalable targets on an on-demand table.
      //
      // `desiredGsiUnusable` suppresses this too (issue #1551). The per-INDEX
      // targets are derived from the same `GlobalSecondaryIndexes` block the
      // guards above refused to trust, and `collectAutoScalingTargets` reads a
      // non-array as "no per-index specs" — so reconciling against it would
      // DEREGISTER every live index's scalable target and delete its policies,
      // the destructive outcome the GSI-diff suppression exists to prevent,
      // reached by a different route. Suppressing the whole reconcile (rather
      // than only its index dimension) also keeps the table-level and
      // cross-region targets from being re-derived from a bag that is known
      // bad; steps 4b / 5 already applied their own diff-gated changes.
      //
      // ...EXCEPT on a flip TO PAY_PER_REQUEST, where the reconcile is a
      // mandatory TEARDOWN: AWS rejects scalable targets on an on-demand
      // table, so skipping there would strand exactly the targets this block
      // exists to remove — and the teardown derives nothing from the junk
      // block (its desired side is the unconditional `[]` a few lines down).
      const skipAutoScalingForUnusableGsi = desiredGsiUnusable && newBilling !== 'PAY_PER_REQUEST';
      const autoScalingMeaningfulForIndexes =
        (newBilling === 'PROVISIONED' || oldBilling === 'PROVISIONED') &&
        !skipAutoScalingForUnusableGsi;
      if (skipAutoScalingForUnusableGsi && oldBilling === 'PROVISIONED') {
        warn(
          `AWS::DynamoDB::GlobalTable ${logicalId}: skipping the auto-scaling target ` +
            `reconcile because the GlobalSecondaryIndexes block is unusable — the ` +
            `per-index targets are derived from it, so reconciling would deregister ` +
            `the live indexes' scalable targets. Existing targets are left untouched.`
        );
      }
      if (autoScalingMeaningfulForIndexes) {
        // A GSI created by step 6 above leaves the TABLE ACTIVE while the
        // index itself is still `CREATING`, and application-autoscaling
        // rejects a target whose resource is not ready. Best-effort wait so
        // the index gets its policy on the deploy that adds it rather than
        // on the next one.
        if (gsiDiff.added.length > 0) {
          await this.waitForIndexesActive(physicalId, logicalId, { maskSecrets });
        }
        await this.reconcileAutoScalingTargets(
          physicalId,
          collectAutoScalingTargets(previousProperties, currentRegion),
          newBilling === 'PAY_PER_REQUEST'
            ? []
            : collectAutoScalingTargets(properties, currentRegion),
          currentRegion,
          autoScalingApplied,
          maskSecrets
        );
      }

      // go-to-k/cdkd#5489: each replica's per-index Contributor Insights, now
      // that every index this update created exists.
      await this.applyReplicaIndexInsights(
        physicalId,
        logicalId,
        currentRegion,
        properties,
        previousProperties,
        addedReplicaRegions,
        replicaKeepOnRemoval,
        context?.replayingState === true || context?.desiredFromAwsReadback === true,
        warn,
        maskSecrets
      );

      // 7. TimeToLiveSpecification (separate API).
      // AWS rate-limits TTL changes per table ("Time to live has been
      // modified multiple times within a fixed interval"). Like
      // CloudFormation, the call is re-sent until AWS accepts it, within the
      // resource timeout (#5451); a refusal still standing then is rewrapped
      // with the remedy.
      if (
        !deepEqual(
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        )
      ) {
        const sendTtl = async (cmd: UpdateTimeToLiveCommand): Promise<void> => {
          try {
            await sendTtlWaitingOutRateLimit(() => this.dynamoDBClient.send(cmd), {
              what: maskSecrets(`DynamoDB TimeToLive rate-limit wait on ${physicalId}`),
              announce: () =>
                this.logger.info(
                  maskSecrets(
                    `DynamoDB global table ${logicalId}: TimeToLive was changed recently, and AWS ` +
                      `refuses another change until its rate-limit interval passes (up to about ` +
                      `an hour). Retrying every minute, like CloudFormation, within the resource timeout.`
                  )
                ),
            });
          } catch (ttlErr) {
            const msg = describeAwsFailure(ttlErr).detail;
            // A disable whose goal already holds (an earlier attempt that
            // landed before a later step failed, or an out-of-band disable).
            if (cmd.input.TimeToLiveSpecification?.Enabled === false && isTtlAlreadyDisabled(msg)) {
              this.logger.debug(maskSecrets(`TimeToLive already disabled on ${physicalId}`));
              return;
            }
            if (isTtlRateLimited(msg)) {
              throw this.wrapMaskedError(
                log,
                ttlErr,
                (text) =>
                  new ProvisioningError(
                    `AWS rejected TimeToLive update on ${log.value(physicalId)}: ${sentence(text)} ` +
                      `AWS rate-limits TTL changes per table, and kept refusing until the resource ` +
                      `timeout ran out; redeploy once the interval has passed (up to about an hour), ` +
                      `or raise --resource-timeout.`,
                    resourceType,
                    logicalId,
                    physicalId,
                    ttlErr instanceof Error ? ttlErr : undefined
                  )
              );
            }
            throw ttlErr;
          }
        };
        // Issue #5447: `Enabled: false` needs no AttributeName in the
        // template, but UpdateTimeToLive needs one even to disable — take the
        // recorded enabled one, else the live one.
        const ttlPlan = planTimeToLive(
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification'],
          'update'
        );
        let ttlTarget: { enabled: boolean; attributeName: string } | undefined;
        if (ttlPlan.kind === 'enable' || ttlPlan.kind === 'disable') {
          ttlTarget = { enabled: ttlPlan.kind === 'enable', attributeName: ttlPlan.attributeName };
        } else if (ttlPlan.kind === 'disable-live') {
          let live: TimeToLiveDescription | undefined;
          await this.retrySettlingRefusal(
            async () => {
              live = (
                await this.dynamoDBClient.send(
                  new DescribeTimeToLiveCommand({ TableName: physicalId })
                )
              ).TimeToLiveDescription;
            },
            `TimeToLive read on ${physicalId}`,
            maskSecrets
          );
          const status = live?.TimeToLiveStatus;
          if ((status === 'ENABLED' || status === 'ENABLING') && live?.AttributeName) {
            ttlTarget = { enabled: false, attributeName: live.AttributeName };
          }
        }
        if (ttlTarget) {
          markUnsettled('TimeToLiveSpecification');
          await sendTtl(
            new UpdateTimeToLiveCommand({
              TableName: physicalId,
              TimeToLiveSpecification: {
                Enabled: ttlTarget.enabled,
                AttributeName: ttlTarget.attributeName,
              },
            })
          );
        }
      }

      // Resolve attributes for return.
      const finalDescribe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );

      // Issue #1723, update side: without this, any update of a multi-replica
      // table whose template declares no stream re-records the desired bag and
      // the stream `create()` recorded vanishes again. Recorded only when the
      // live table CONFIRMS it — this update never sends the stream, so the
      // claim rests on what AWS holds, not on what cdkd sent. When it does not
      // confirm, the key stays absent, which the shared twin folds identically
      // on both diff sides, so either answer diffs NO_CHANGE next time.
      const impliedStream = replicationImpliedStreamSpecification(properties);
      const liveStream = finalDescribe.Table?.StreamSpecification;
      if (
        impliedStream &&
        liveStream?.StreamEnabled === true &&
        liveStream.StreamViewType === impliedStream.StreamViewType
      ) {
        effectiveProperties = {
          ...(effectiveProperties ?? properties),
          [STREAM_SPECIFICATION_KEY]: impliedStream,
        };
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: finalDescribe.Table?.TableArn,
          TableId: finalDescribe.Table?.TableId,
          StreamArn: finalDescribe.Table?.LatestStreamArn,
          TableName: physicalId,
        },
        ...(effectiveProperties && { effectiveProperties }),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update DynamoDB GlobalTable ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via DynamoDB's
   * `TagResource` / `UntagResource` APIs against the local client. Both
   * take the table ARN as `ResourceArn`.
   *
   * Local-replica convenience wrapper around `applyTagDiffOnClient` so
   * existing call sites stay unchanged.
   */
  private async applyTagDiff(
    tableArn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    maskSecrets: SecretMasker,
    region?: string
  ): Promise<void> {
    await this.applyTagDiffOnClient(
      this.dynamoDBClient,
      tableArn,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      maskSecrets,
      region
    );
  }

  /**
   * Propagate a per-replica Tags diff to ONE cross-region replica via a
   * per-region client (Issue #389 / #441 — closes the create-side gap).
   * Centralizes the common shape used by BOTH `create()` (`oldTags`
   * undefined → every new tag is an add) and `update()` (per-replica
   * modify path's old-vs-new diff). Best-effort: a failure here logs at
   * WARN naming the offending region + ARN + reason and the deploy
   * continues — the cross-region Tags state will surface as drift on
   * the next run (or `cdkd drift --revert`) rather than aborting the
   * deploy mid-flight. Mirrors the autoscaling diff's failure contract
   * (PR #393).
   *
   * `tableArn` is the LOCAL replica's table ARN (returned by the
   * post-create `waitForTableActive` or the inline `DescribeTable` in
   * `update()`); the helper swaps the region segment via
   * `replicaArnForRegion` before issuing `TagResource` / `UntagResource`
   * against the per-region client.
   *
   * No-op when `oldTags` deep-equals `newTags` — the caller is allowed
   * to invoke unconditionally without first diffing.
   */
  private async applyCrossRegionReplicaTagsDiff(
    tableArn: string | undefined,
    region: string,
    oldTags: unknown,
    newTags: unknown,
    resourceType: string,
    logicalId: string,
    physicalIdForLogs: string,
    // The caller's secret masker (issue #1997). All three warnings below name
    // `physicalIdForLogs`, which is the resolved table name. Defaults to
    // IDENTITY; every caller is on the create or update path, both of which
    // have one.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    // ONE masked sink for every line in this method (issue #1997).
    const warn = (message: string): void => this.logger.warn(maskSecrets(message));
    // go-to-k/cdkd#5487: unsettled `Replicas` re-send the tags even when the bags agree.
    if (deepEqual(oldTags, newTags) && !isUnsettled('Replicas')) return;
    if (!tableArn) {
      warn(
        `Local DescribeTable returned no TableArn — cannot propagate Tags to cross-region replica ${region} of ${physicalIdForLogs}`
      );
      return;
    }
    const replicaArn = this.replicaArnForRegion(tableArn, region);
    if (!replicaArn) {
      warn(
        `Could not derive replica ARN for region ${region} from ${tableArn} — skipping Tags propagation for ${physicalIdForLogs}`
      );
      return;
    }
    try {
      const regionalClient = this.getRegionalClient(region);
      await this.applyTagDiffOnClient(
        regionalClient,
        replicaArn,
        resourceType,
        `${logicalId} (replica ${region})`,
        oldTags,
        newTags,
        maskSecrets,
        region
      );
    } catch (tagErr) {
      warn(
        `Could not apply Tags diff to cross-region replica ${region} of ${physicalIdForLogs}: ${describeAwsFailure(tagErr).detail}. The replica's Tags state will surface as drift until the next successful deploy.`
      );
    }
  }

  /**
   * Apply a Tags diff against the given `DynamoDBClient` (which may be
   * the local client or a per-region client returned by
   * `getRegionalClient`). Used by the local-replica path AND the
   * cross-region replica Tags propagation path (Issue #389 / #441). Both
   * sides are read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable
   * record untags nothing. `id` names the replica in that warning.
   */
  private async applyTagDiffOnClient(
    client: DynamoDBClient,
    tableArn: string,
    resourceType: string,
    id: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    maskSecrets: SecretMasker = (text) => text,
    /** go-to-k/cdkd#5498: the replica whose accepted tag keys are recorded. */
    region?: string
  ): Promise<void> {
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, id);
    if (tagWarning !== undefined) {
      this.logger.warn(maskSecrets(tagWarning));
    }
    // go-to-k/cdkd#5487: a replica's tags are a member of `Replicas`. When an
    // earlier failure left it unsettled, every template tag is re-sent and only
    // the recorded tags the template dropped are removed (the previous side
    // keeps the record's tags, never the live ones).
    const toSet = isUnsettled('Replicas') ? planTagDiff(undefined, newTagsRaw).set : plan.set;
    const tagsToAdd = [...toSet].map(([k, v]) => ({ Key: k, Value: v }));
    const tagsToRemove = plan.remove;
    if (tagsToRemove.length > 0 || tagsToAdd.length > 0) markUnsettled('Replicas');

    if (tagsToRemove.length > 0) {
      await client.send(new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove }));
      // Masked: the table ARN carries the table name, which can be
      // secret-derived.
      this.logger.debug(
        maskSecrets(`Removed ${tagsToRemove.length} tag(s) from DynamoDB GlobalTable ${tableArn}`)
      );
    }
    if (tagsToAdd.length > 0) {
      await client.send(new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd }));
      // go-to-k/cdkd#5498: AFTER the call resolved, the keys it added that the
      // record lacked. A malformed recorded list cannot say which: none.
      if (region !== undefined && REGION_SEGMENT.test(region)) {
        let recordedKeys: Set<string> | undefined;
        try {
          recordedKeys = new Set([...planTagDiff(undefined, oldTagsRaw).set.keys()]);
        } catch {
          recordedKeys = undefined;
        }
        if (recordedKeys !== undefined) {
          markAttemptedItems(
            `Replicas[${region}].Tags`,
            tagsToAdd.map((t) => t.Key).filter((key) => !recordedKeys.has(key))
          );
        }
      }
      this.logger.debug(
        maskSecrets(`Added/updated ${tagsToAdd.length} tag(s) on DynamoDB GlobalTable ${tableArn}`)
      );
    }
  }

  /**
   * Apply an application-autoscaling diff for one (tableName, dimension)
   * pair (Issue #402 / PR closing Issue #395's deferred items).
   *
   * Dimension is either:
   *  - `dynamodb:table:WriteCapacityUnits` (table-level write capacity),
   *    paired with the local-region autoscaling client.
   *  - `dynamodb:table:ReadCapacityUnits` (per-replica read capacity),
   *    paired with a region-scoped autoscaling client returned by
   *    `getRegionalAutoScalingClient`.
   *
   * Diff semantics (idempotent upsert, per Issue #402 spec):
   *  - new auto-scaling settings present (Min/Max + TargetValue) →
   *    `RegisterScalableTarget` (upsert) + `PutScalingPolicy` (upsert).
   *    AWS's `RegisterScalableTarget` accepts no-op Min/Max changes
   *    silently, and `PutScalingPolicy` is idempotent on the same
   *    policy name (`DynamoDB{Write,Read}CapacityUtilization:table/<name>`).
   *  - old auto-scaling settings present but new ones absent (= null) →
   *    `DeleteScalingPolicy` + `DeregisterScalableTarget`. AWS rejects
   *    `DeregisterScalableTarget` on a still-policy-attached target,
   *    so the policy must be deleted FIRST.
   *  - neither side has auto-scaling settings → no-op.
   *
   * **Best-effort**: any AWS error is logged at WARN with the per-API
   * recovery command and the deploy continues — auto-scaling drift is
   * recoverable on the next deploy, and an aborted deploy is much worse
   * UX than a transient auto-scaling miss. This matches the cross-region
   * Tags propagation contract (PR #393).
   *
   * **Policy naming** matches AWS's CDK / console default:
   *   `DynamoDBWriteCapacityUtilization:table/<table-name>` (write)
   *   `DynamoDBReadCapacityUtilization:table/<table-name>`  (read)
   * so re-imports against a console-created target also match.
   *
   * **`SeedCapacity` is intentionally NOT forwarded** — it is a CFn
   * create-only field with no corresponding `RegisterScalableTarget`
   * surface; `readAutoScalingSettings` also explicitly skips it.
   */
  private async applyAutoScalingDiff(
    tableName: string,
    dimension: DynamoDBScalableDimension,
    oldSettings: Record<string, unknown> | undefined,
    newSettings: Record<string, unknown> | undefined,
    client?: ApplicationAutoScalingClient,
    indexName?: string,
    budget?: ElapsedBudget,
    // The caller's secret masker (issue #1997). The malformed-capacity warning
    // below names `MinCapacity` / `MaxCapacity` straight out of the RESOLVED
    // auto-scaling settings bag. The DELETE path passes its
    // `DeleteContext.maskSecrets` too (go-to-k/cdkd#5581): its teardown sends
    // EMPTY settings, so that warning cannot fire there, but the teardown's own
    // warnings name the table. Defaults to IDENTITY for a caller passing none.
    maskSecrets: SecretMasker = (text) => text,
    // go-to-k/cdkd#4946: the delete's flag, set once the teardown may have
    // removed a policy or target. Absent on every create / update caller.
    progress?: DeleteProgress
  ): Promise<void> {
    // go-to-k/cdkd#5487: the top-level key these settings belong to — an
    // index's, the table's write side, or a replica's read side.
    const autoScalingKey =
      indexName !== undefined
        ? 'GlobalSecondaryIndexes'
        : dimension.includes('Write')
          ? 'WriteProvisionedThroughputSettings'
          : 'Replicas';
    // ONE masked sink (issue #1997) — see `update()` for why both layers.
    const warn = (message: string): void => this.logger.warn(maskSecrets(message));
    // Issue #1955: the DELETE path calls this in a BURST — table-level plus one
    // per GSI, per non-local replica, then again locally — BEFORE the first
    // budgeted poll. Both branches below now retry throttles: the register one
    // always did, and the TEARDOWN one (the only branch the delete path takes,
    // since every delete-path caller passes `newSettings: undefined`) gained it
    // with this change, because a swallowed throttle there leaves a scalable
    // target silently REGISTERED — the PR #403 leak a future table of the same
    // name inherits, the exact mirror of the never-registered gap the register
    // branch's retry closes.
    //
    // Retrying on a path that shares one deadline with every wait after it is
    // what makes the bound necessary. `asMaxRetries` is funded from the SURPLUS
    // above a reserve, so a throttled burst cannot spend the allowance the
    // delete itself needs, and at zero the call is still ISSUED once — the
    // leak-prevention never depends on the retry. Every CREATE / UPDATE caller
    // passes no budget and keeps `withRetry`'s default schedule.
    // See `autoScalingRetriesWithinDeleteBudget` for the arithmetic.
    const asMaxRetries = autoScalingRetriesWithinDeleteBudget(
      budget,
      AUTO_SCALING_TEARDOWN_MAX_RETRIES
    );
    const isWrite = dimension.endsWith('WriteCapacityUnits');
    const metricType = isWrite
      ? 'DynamoDBWriteCapacityUtilization'
      : 'DynamoDBReadCapacityUtilization';
    // Index-level targets register against `table/<t>/index/<i>` (Issue #1419);
    // table-level keeps `table/<t>`. The policy name follows AWS's own
    // `<metricType>:<resourceId>` convention, so the table-level spelling is
    // byte-identical to what shipped before this generalization — a renamed
    // policy would orphan the existing one on every already-deployed table.
    const resourceId = autoScalingResourceId(tableName, indexName);
    const policyName = `${metricType}:${resourceId}`;

    // PR #403 review minor #4: route the no-client-arg fallback through
    // the cached `getLocalAutoScalingClient()` rather than constructing
    // a fresh client per call. Multi-stack runs with many GlobalTables
    // were leaking SDK clients (each holds its own HTTP agent).
    const asClient = client ?? (await this.getLocalAutoScalingClient());

    const oldEnabled = oldSettings !== undefined && oldSettings !== null;
    const newEnabled = newSettings !== undefined && newSettings !== null;

    if (!oldEnabled && !newEnabled) {
      return; // nothing to do
    }

    // ONE watch for all four `withRetry` calls below (issue #2053). They run
    // back to back on the same table — register + policy on the deploy path,
    // policy-delete + deregister on the teardown path — so a single Ctrl-C has
    // to abort whichever of them is currently sitting in its backoff, and a
    // watch per call would install and tear one down four times for one wait.
    //
    // Started HERE, after the no-op early return above, rather than at the top
    // of the method: the common call on a table with no auto-scaling reaches
    // neither branch, and a watch taken for it is added and removed for a
    // method that never waits. Every `return` from this point on unwinds
    // through the `finally` that disposes it.
    // Masked for the same reason as the replica-copy wait's label: it reaches
    // the user in `InterruptedWaitError`'s message on Ctrl-C.
    const watch = startInterruptWatch(maskSecrets(`DynamoDB auto-scaling for ${tableName}`));
    try {
      if (newEnabled) {
        // Register OR update scalable target (idempotent on no-op).
        //
        // `coerceCfnInteger`, the same reader `pickAutoScalingCapacity` takes
        // `MinCapacity` through for the table's own capacity (issue #3135):
        // these two FORWARD the same member to two services, and on a
        // `Number()` read a padded `" 7 "` registered a scalable target at 7
        // while the capacity derivation beside it had already dropped the
        // value and sent the announced 5/5 fallback. A spelling CloudFormation
        // rejects now takes this block's existing warn-and-skip arm, exactly
        // like a non-numeric value. The `?? 0` keeps an ABSENT member's
        // pre-existing reading (zero, which AWS refuses by name).
        const minCapacity = coerceCfnInteger(newSettings!['MinCapacity'] ?? 0);
        const maxCapacity = coerceCfnInteger(newSettings!['MaxCapacity'] ?? 0);
        if (minCapacity === undefined || maxCapacity === undefined) {
          warn(
            `Cannot apply auto-scaling diff on ${tableName} (${dimension}): ` +
              `MinCapacity / MaxCapacity must be integers CloudFormation accepts ` +
              `(an optional sign and decimal digits; no surrounding whitespace, hex, ` +
              `exponent or decimal point), got ` +
              // Masked as RAW values (issue #1997): `String()` of a resolved
              // secret is the plaintext itself, and the WHOLE-VALUE arm matches at
              // any length where the sink's substring arm needs 4 characters.
              `${maskSecrets(String(newSettings!['MinCapacity']))} / ` +
              `${maskSecrets(String(newSettings!['MaxCapacity']))}`
          );
          return;
        }
        try {
          // Throttle-only retry (Issue #1419 review): a table with many
          // indexes issues a burst of these, and application-autoscaling is
          // throttled per account. Every error here is swallowed into a WARN,
          // so an un-retried `ThrottlingException` would leave the target
          // unregistered *silently* — re-introducing, under load, exactly the
          // never-registered gap this change closes. Non-throttle failures
          // still fall straight through to the WARN below.
          markUnsettled(autoScalingKey);
          await withRetry(
            () =>
              asClient.send(
                new RegisterScalableTargetCommand({
                  ServiceNamespace: 'dynamodb',
                  ResourceId: resourceId,
                  ScalableDimension: dimension,
                  MinCapacity: minCapacity,
                  MaxCapacity: maxCapacity,
                })
              ),
            `${resourceId} (${dimension})`,
            {
              // `isRetryable` is invoked as `(message, error)`. Passing
              // `isThrottlingError` DIRECTLY hands it the message STRING, on
              // which it finds no `.name` / `.$metadata` / `.cause` and always
              // returns false — and because `isRetryable` is set at all, the
              // call also opts out of the default schedule. It typechecks (a
              // 1-arg `unknown` callback is assignable) and silently disables
              // the retry entirely. Same spelling as `describe-type.ts`.
              isRetryable: (_message, error) => isThrottlingError(error),
              maxRetries: asMaxRetries,
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
              ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
            }
          );
        } catch (err) {
          // A user abort is not an AWS failure (issue #2053 review). Swallowing it
          // printed up to two "Could not ... Run: aws application-autoscaling ..."
          // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
          // -- and then carried straight on to the next teardown WRITE. Re-throwing
          // stops the burst; `delete()`'s catch passes it through unwrapped.
          if (isInterruptedWaitError(err)) throw err;
          warn(
            `Could not register auto-scaling target on ${tableName} (${dimension}): ` +
              `${describeAwsFailure(err).detail}. ` +
              `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling register-scalable-target --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension} --min-capacity ${String(minCapacity)} --max-capacity ${String(maxCapacity)}`.render()}`
          );
          return;
        }

        const tttCfg = (newSettings!['TargetTrackingScalingPolicyConfiguration'] ?? {}) as Record<
          string,
          unknown
        >;
        const targetValue = Number(tttCfg['TargetValue']);
        if (!Number.isFinite(targetValue)) {
          warn(
            `Auto-scaling target registered on ${tableName} (${dimension}) but ` +
              `TargetValue is missing or non-numeric — skipping PutScalingPolicy. ` +
              `Provide TargetTrackingScalingPolicyConfiguration.TargetValue in the template.`
          );
          return;
        }
        const targetTrackingConfig: Record<string, unknown> = {
          PredefinedMetricSpecification: { PredefinedMetricType: metricType },
          TargetValue: targetValue,
        };
        // The two cooldowns are CloudFormation Integers and are FORWARDED, so
        // they take the DynamoDB grammar too (issue #3135); a rejected spelling
        // is announced and OMITTED (the service default applies) rather than
        // sent as `Number()`'s reading or as `NaN`. `TargetValue` above is a
        // CloudFormation Double, whose grammar is unmeasured, and keeps `Number()`.
        for (const cooldown of ['ScaleInCooldown', 'ScaleOutCooldown'] as const) {
          const raw = tttCfg[cooldown];
          if (raw === undefined) continue;
          const seconds = coerceCfnInteger(raw);
          if (seconds === undefined) {
            warn(
              `Auto-scaling policy on ${tableName} (${dimension}): ` +
                `TargetTrackingScalingPolicyConfiguration.${cooldown} is not an integer ` +
                `CloudFormation accepts (got ${JSON.stringify(maskDeep(raw, maskSecrets))?.slice(0, 80)}), ` +
                `so it is omitted and the service default applies.`
            );
            continue;
          }
          targetTrackingConfig[cooldown] = seconds;
        }
        if (tttCfg['DisableScaleIn'] !== undefined) {
          targetTrackingConfig['DisableScaleIn'] = Boolean(tttCfg['DisableScaleIn']);
        }
        try {
          // Same throttle-only retry as the register above — a swallowed
          // throttle here leaves a registered target with NO policy, which
          // scales nothing.
          markUnsettled(autoScalingKey);
          await withRetry(
            () =>
              asClient.send(
                new PutScalingPolicyCommand({
                  PolicyName: policyName,
                  ServiceNamespace: 'dynamodb',
                  ResourceId: resourceId,
                  ScalableDimension: dimension,
                  PolicyType: 'TargetTrackingScaling',
                  // SDK input shape uses Pascal-cased keys; the inner config object
                  // is the same shape we read back via DescribeScalingPolicies.
                  TargetTrackingScalingPolicyConfiguration: targetTrackingConfig as never,
                })
              ),
            `${policyName}`,
            {
              isRetryable: (_message, error) => isThrottlingError(error),
              maxRetries: asMaxRetries,
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
              ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
            }
          );
          this.logger.debug(
            maskSecrets(`Upserted auto-scaling policy ${policyName} on ${tableName} (${dimension})`)
          );
        } catch (err) {
          // A user abort is not an AWS failure (issue #2053 review). Swallowing it
          // printed up to two "Could not ... Run: aws application-autoscaling ..."
          // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
          // -- and then carried straight on to the next teardown WRITE. Re-throwing
          // stops the burst; `delete()`'s catch passes it through unwrapped.
          if (isInterruptedWaitError(err)) throw err;
          warn(
            `Could not put auto-scaling policy on ${tableName} (${dimension}): ` +
              `${describeAwsFailure(err).detail}. ` +
              `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling put-scaling-policy --policy-name ${policyName} --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension} --policy-type TargetTrackingScaling`.render()}`
          );
        }
        return;
      }

      // newEnabled === false, oldEnabled === true: tear down.
      // Idempotency: AWS's application-autoscaling raises
      // `ObjectNotFoundException` ("No scaling policy found" / "No
      // scalable target found") when the resource is already gone.
      // That is success for our purposes (e.g. the `update()` BillingMode
      // flip already tore down autoscaling, and now `delete()`'s defense-
      // in-depth teardown fires). Detect via the error name AND message
      // substring (the SDK doesn't always type-name the error on first
      // exposure) and silently skip — only surface non-RNF errors as
      // WARN with the recovery command.
      const isObjectNotFound = (err: unknown): boolean => {
        if (!(err instanceof Error)) return false;
        const name = (err as Error & { name?: string }).name ?? '';
        const msg = err.message ?? '';
        return (
          name === 'ObjectNotFoundException' ||
          msg.includes('No scaling policy found') ||
          msg.includes('No scalable target found')
        );
      };
      try {
        // Throttle-only retry, the SYMMETRIC twin of the register branch's. That
        // one retries because a swallowed `ThrottlingException` leaves a target
        // silently UNregistered; a swallowed throttle HERE leaves one silently
        // REGISTERED, which is the PR #403 leak a future table of the same name
        // inherits. The teardown had no retry at all until issue #1955's review
        // found the asymmetry. `maxRetries` is the caller's bound
        // (`autoScalingRetriesWithinDeleteBudget`) rather than the default,
        // because this runs before every budgeted wait on the delete path; an
        // absent budget (every CREATE / UPDATE caller) gets the default schedule.
        // `ObjectNotFoundException` is not a throttle, so the idempotent
        // already-gone arm below still fires on the FIRST attempt.
        markUnsettled(autoScalingKey);
        await withRetry(
          () =>
            asClient.send(
              new DeleteScalingPolicyCommand({
                PolicyName: policyName,
                ServiceNamespace: 'dynamodb',
                ResourceId: resourceId,
                ScalableDimension: dimension,
              })
            ),
          `${resourceId} (${dimension})`,
          {
            isRetryable: (_message, error) => isThrottlingError(error),
            maxRetries: asMaxRetries,
            isInterrupted: watch.isInterrupted,
            onInterrupted: watch.onInterrupted,
            ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
          }
        );
        if (progress) progress.stripped = true;
      } catch (err) {
        // A user abort is not an AWS failure (issue #2053 review). Swallowing it
        // printed up to two "Could not ... Run: aws application-autoscaling ..."
        // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
        // -- and then carried straight on to the next teardown WRITE. Re-throwing
        // stops the burst; `delete()`'s catch passes it through unwrapped.
        if (isInterruptedWaitError(err)) throw err;
        // Swallowed: it may still have landed, unless nothing was there or AWS
        // refused it by name.
        if (progress && !isObjectNotFound(err) && !isRefusedByName(err)) progress.stripped = true;
        if (!isObjectNotFound(err)) {
          warn(
            `Could not delete auto-scaling policy on ${tableName} (${dimension}): ` +
              `${describeAwsFailure(err).detail}. ` +
              `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling delete-scaling-policy --policy-name ${policyName} --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension}`.render()}`
          );
        }
        // Continue to the Deregister attempt regardless — AWS may have
        // already cleaned up the policy, in which case the deregister
        // succeeds (or also returns ObjectNotFoundException, also
        // suppressed below).
      }
      try {
        // Same throttle-only retry and the same bound as the policy delete above.
        markUnsettled(autoScalingKey);
        await withRetry(
          () =>
            asClient.send(
              new DeregisterScalableTargetCommand({
                ServiceNamespace: 'dynamodb',
                ResourceId: resourceId,
                ScalableDimension: dimension,
              })
            ),
          `${resourceId} (${dimension})`,
          {
            isRetryable: (_message, error) => isThrottlingError(error),
            maxRetries: asMaxRetries,
            isInterrupted: watch.isInterrupted,
            onInterrupted: watch.onInterrupted,
            ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
          }
        );
        if (progress) progress.stripped = true;
        this.logger.debug(
          maskSecrets(`Deregistered auto-scaling target ${resourceId} (${dimension})`)
        );
      } catch (err) {
        // A user abort is not an AWS failure (issue #2053 review). Swallowing it
        // printed up to two "Could not ... Run: aws application-autoscaling ..."
        // lines PER dimension, per GSI and per replica -- blaming AWS for a Ctrl-C
        // -- and then carried straight on to the next teardown WRITE. Re-throwing
        // stops the burst; `delete()`'s catch passes it through unwrapped.
        if (isInterruptedWaitError(err)) throw err;
        if (progress && !isObjectNotFound(err) && !isRefusedByName(err)) progress.stripped = true;
        if (!isObjectNotFound(err)) {
          warn(
            `Could not deregister auto-scaling target on ${tableName} (${dimension}): ` +
              `${describeAwsFailure(err).detail}. ` +
              `Run: ${pasteableAwsCommand(maskSecrets)`aws application-autoscaling deregister-scalable-target --service-namespace dynamodb --resource-id ${resourceId} --scalable-dimension ${dimension}`.render()}`
          );
        }
      }
    } finally {
      watch.dispose();
    }
  }

  /**
   * Resolve the application-autoscaling client that owns a given region's
   * targets. The local region goes through the cached client; every other
   * region gets the per-region cached client.
   */
  private async autoScalingClientForRegion(
    region: string,
    localRegion: string
  ): Promise<ApplicationAutoScalingClient> {
    return region === localRegion
      ? await this.getLocalAutoScalingClient()
      : this.getRegionalAutoScalingClient(region);
  }

  /**
   * Probe which of the given targets are ALREADY registered, so the
   * reconcile can skip the ones that are both present and unchanged
   * (Issue #1419).
   *
   * Per region: `DescribeScalableTargets` (batched + paginated) AND
   * `DescribeScalingPolicies`, returning the set of `autoScalingTargetKey`s
   * for which BOTH a target and a target-tracking policy exist.
   *
   * Both halves are required. A target whose `PutScalingPolicy` failed is
   * registered but scales nothing, and `applyAutoScalingDiff` swallows that
   * failure into a WARN — so probing the target alone would mark it present
   * and skip it on every later deploy, which is the same silent never-scales
   * gap this whole change exists to close, one level down.
   *
   * Best-effort: on ANY failure it returns `null`, which the caller reads as
   * "presence unknown" and falls back to upserting everything — an extra
   * idempotent call is always safer than skipping a registration that was
   * never made.
   */
  private async probeRegisteredTargets(
    tableName: string,
    specs: AutoScalingTargetSpec[],
    localRegion: string,
    // The update caller's masker (issue #2177): the debug line below names the
    // resolved table name and quotes AWS's error text. Defaults to IDENTITY.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<Set<string> | null> {
    const byRegion = new Map<string, AutoScalingTargetSpec[]>();
    for (const spec of specs) {
      const list = byRegion.get(spec.region);
      if (list) list.push(spec);
      else byRegion.set(spec.region, [spec]);
    }

    // Re-key off the RESOURCE ID so the presence sets and the spec-keyed maps
    // share one identity: strip the `table/<t>/index/` prefix back to the
    // index name (empty at table level).
    const indexPrefix = `${autoScalingResourceId(tableName)}/index/`;
    const keyOf = (resourceId: string, dimension: string, region: string): string => {
      const suffix = resourceId.startsWith(indexPrefix) ? resourceId.slice(indexPrefix.length) : '';
      return `${region}|${dimension}|${suffix}`;
    };

    const present = new Set<string>();
    for (const [region, regionSpecs] of byRegion) {
      const resourceIds = [
        ...new Set(regionSpecs.map((s) => autoScalingResourceId(tableName, s.indexName))),
      ];
      const client = await this.autoScalingClientForRegion(region, localRegion);
      const targets = new Set<string>();
      const policies = new Set<string>();
      for (let i = 0; i < resourceIds.length; i += DESCRIBE_SCALABLE_TARGETS_BATCH) {
        const batch = resourceIds.slice(i, i + DESCRIBE_SCALABLE_TARGETS_BATCH);
        try {
          // Paginate: the API caps a page well below the batch size, so
          // reading page 1 only would report absent for the wide tables the
          // probe exists to speed up (fails safe, but defeats the point).
          let nextToken: string | undefined;
          do {
            const res: DescribeScalableTargetsCommandOutput = await client.send(
              new DescribeScalableTargetsCommand({
                ServiceNamespace: 'dynamodb',
                ResourceIds: batch,
                ...(nextToken ? { NextToken: nextToken } : {}),
              })
            );
            for (const target of res.ScalableTargets ?? []) {
              if (!target.ResourceId || !target.ScalableDimension) continue;
              targets.add(keyOf(target.ResourceId, target.ScalableDimension, region));
            }
            nextToken = res.NextToken;
          } while (nextToken);

          let policyToken: string | undefined;
          do {
            const res: DescribeScalingPoliciesCommandOutput = await client.send(
              new DescribeScalingPoliciesCommand({
                ServiceNamespace: 'dynamodb',
                ...(policyToken ? { NextToken: policyToken } : {}),
              })
            );
            for (const policy of res.ScalingPolicies ?? []) {
              if (!policy.ResourceId || !policy.ScalableDimension) continue;
              if (policy.PolicyType !== 'TargetTrackingScaling') continue;
              policies.add(keyOf(policy.ResourceId, policy.ScalableDimension, region));
            }
            policyToken = res.NextToken;
          } while (policyToken);
        } catch (err) {
          this.logger.debug(
            maskSecrets(
              `Could not probe existing auto-scaling targets on ${tableName} in ${region}: ` +
                `${describeAwsFailure(err).detail} — re-asserting every target instead.`
            )
          );
          return null;
        }
      }
      for (const key of targets) {
        if (policies.has(key)) present.add(key);
      }
    }
    return present;
  }

  /**
   * Reconcile the application-autoscaling targets a CFn template declares
   * against the ones its previous version declared (Issue #1419).
   *
   * **A desired target is re-asserted even when the template did not
   * change, unless it is known to already exist.** A purely diff-gated
   * register would never backfill the targets that are the entire subject
   * of this issue: on a table deployed before this fix the settings are
   * byte-identical on both sides of every subsequent deploy, so a diff
   * check sees no change and leaves the dimension unregistered forever.
   *
   * The naive form of that — upsert everything, every deploy — costs
   * `2 x (1 + N_gsi x (1 + N_replica))` serial round trips on EVERY deploy
   * of an autoscaled table (a 20-GSI, 3-replica table would spend well over
   * a hundred sequential calls re-asserting a steady state). So presence is
   * probed first with one batched `DescribeScalableTargets` per region, and
   * a target that already exists AND whose settings are unchanged is
   * skipped. When the probe fails, presence is unknown and everything is
   * upserted — the correct direction to fail.
   */
  private async reconcileAutoScalingTargets(
    tableName: string,
    previousSpecs: AutoScalingTargetSpec[],
    desiredSpecs: AutoScalingTargetSpec[],
    localRegion: string,
    alreadyApplied: ReadonlySet<string> = new Set(),
    // Forwarded to `applyAutoScalingDiff` (issue #1997) and to the presence
    // probe (issue #2177); this method logs no property value of its own.
    // Defaults to IDENTITY.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    // Dimensions an earlier step of this same `update()` already applied are
    // dropped here rather than re-issued. This is a DYNAMIC skip-set, not a
    // static per-dimension filter: a dimension whose diff gate SKIPPED it
    // never enters the set, so it still gets backfilled here — which is the
    // whole point. A static filter (the first cut) got this wrong in the
    // other direction, permanently excluding two dimensions from backfill.
    const previousSpecsToUse = previousSpecs.filter(
      (s) => !alreadyApplied.has(autoScalingTargetKey(s))
    );
    const desiredSpecsToUse = desiredSpecs.filter(
      (s) => !alreadyApplied.has(autoScalingTargetKey(s))
    );

    const previousByKey = new Map<string, AutoScalingTargetSpec>();
    for (const spec of previousSpecsToUse) {
      previousByKey.set(autoScalingTargetKey(spec), spec);
    }

    // The skip below requires a PREVIOUS spec, so with nothing previous
    // (create) the probe could never save a call — don't pay for it.
    const registered =
      desiredSpecsToUse.length > 0 && previousSpecsToUse.length > 0
        ? await this.probeRegisteredTargets(tableName, desiredSpecsToUse, localRegion, maskSecrets)
        : new Set<string>();

    const handled = new Set<string>();
    for (const spec of desiredSpecsToUse) {
      const key = autoScalingTargetKey(spec);
      handled.add(key);
      const previous = previousByKey.get(key);
      // Already registered (target AND policy) AND the template did not touch
      // it: nothing to do. `registered === null` means the probe failed, so
      // presence is unknown and the upsert runs.
      //
      // Note this compares the TEMPLATE's two sides, not the live Min/Max, so
      // an out-of-band console edit is not corrected while the template stays
      // put. That matches the pre-existing diff gates' contract; drift
      // correction is `cdkd drift`'s job, not the deploy path's.
      if (
        registered?.has(key) &&
        previous !== undefined &&
        deepEqual(previous.settings, spec.settings)
      ) {
        continue;
      }
      const client = await this.autoScalingClientForRegion(spec.region, localRegion);
      await this.applyAutoScalingDiff(
        tableName,
        spec.dimension,
        previous?.settings,
        spec.settings,
        client,
        spec.indexName,
        undefined,
        maskSecrets
      );
    }

    // Anything the previous template declared and this one does not: the
    // index was dropped, the replica was removed, or the user deleted the
    // auto-scaling block. Tear the target down so it does not survive in
    // AWS's application-autoscaling control plane and get silently
    // inherited by a future resource of the same name.
    for (const [key, spec] of previousByKey) {
      if (handled.has(key)) continue;
      const client = await this.autoScalingClientForRegion(spec.region, localRegion);
      await this.applyAutoScalingDiff(
        tableName,
        spec.dimension,
        spec.settings,
        undefined,
        client,
        spec.indexName,
        undefined,
        maskSecrets
      );
    }
  }

  /**
   * Delete a DynamoDB Global Table.
   *
   * Order is load-bearing:
   *  1. Optional `--remove-protection` flip-off (idempotent).
   *  2. `DescribeTable` → drop every non-local replica via UpdateTable
   *     `ReplicaUpdates: [{ Delete: { RegionName } }]`, one at a time
   *     (AWS rejects multiple replica updates per call). Each delete
   *     polls until the replica disappears from `Replicas[]`.
   *  3. `DeleteTableCommand` on the local region only.
   *  4. Wait for `ResourceNotFoundException` on subsequent DescribeTable.
   *
   * DELETE idempotency: a `ResourceNotFoundException` is treated as
   * success ONLY when the client region matches the state region
   * (`assertRegionMatch`). A mismatched destroy would otherwise silently
   * strip a still-existing resource from state.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    // `--remove-protection` compensation (issue #1978). The sibling
    // `AWS::DynamoDB::Table` provider's wrapper is the same MECHANISM line for
    // line -- it is not byte-identical, since it lacks this header, names
    // `deleteTableResource`, and passes `typeLabel: 'table'` -- and the two are
    // kept in step for a reason: the two types share one root cause with two
    // sites, and the #1955 review had already caught a half-applied twin in
    // this pair.
    //
    // The window is WIDER on this type than on the sibling. Between the flip
    // and the `DeleteTable` sit the client-region resolve, the pre-delete
    // describe, the auto-scaling teardown and one `waitForReplicaGone` per
    // non-local replica — twelve minutes apiece, and interruptible since issue
    // #2053, which is the Ctrl-C route recorded on the issue. Catching at the
    // method boundary covers all of them; a `catch` on the `DeleteTable` `try`
    // alone would cover none.
    // From the REGISTRY, not a fresh object: this method is re-entered by
    // `destroy-runner.ts` after a retryable failure, and what has to survive
    // that re-entry is exactly "an earlier attempt already flipped the guard
    // off". Same key and the same window CONSTANT as the delete
    // allowance below, but not the same semantics: this one SLIDES on reuse
    // (issue #2211) while `ElapsedBudgetRegistry` still measures from creation.
    const flip: ProtectionFlipRecord = this.protectionFlips.acquire(
      deleteBudgetKey(physicalId, context?.expectedRegion),
      DELETE_BUDGET_REUSE_WINDOW_MS,
      // The same injected clock the allowance below gets. Production-identical
      // either way (both default to the monotonic clock). It is threaded so the
      // reuse window can be driven THROUGH `delete()`, which is what fences the
      // SLIDING window go-to-k/cdkd#2211 fixed: the suite's three-attempt case
      // advances this clock past `DELETE_BUDGET_REUSE_WINDOW_MS` in total while
      // keeping every gap inside it, and asserts the latch survived.
      resolveDynamoDbDeleteBudgetClock()
    );
    // go-to-k/cdkd#4946: set once a step before `DeleteTable` may have changed
    // the table, so a refused delete is never read as a whole survivor.
    const progress: DeleteProgress = { stripped: false };
    try {
      await this.deleteGlobalTableResource(
        logicalId,
        physicalId,
        resourceType,
        context,
        flip,
        progress
      );
    } catch (error) {
      if (progress.stripped) markDeleteStarted(error);
      // The outcome DEFAULTS to `failed` and the release sits in a `finally`,
      // so an unknown outcome retains the record -- the safe direction.
      // `compensateRemovedDeletionProtection` documents that it never throws
      // (it must not replace the failure this `catch` is about to re-throw),
      // but that is a property of the callee: a compensation that died
      // part-way is exactly the case where cdkd cannot say whether the guard
      // is back on, so the caller does not depend on it.
      let outcome: ProtectionCompensationOutcome = 'failed';
      try {
        outcome = await compensateRemovedDeletionProtection({
          flip,
          error,
          logicalId,
          physicalId,
          typeLabel: 'GlobalTable',
          logger: this.logger,
          ...(context?.expectedRegion ? { region: context.expectedRegion } : {}),
          reEnable: async () => {
            await this.dynamoDBClient.send(
              new UpdateTableCommand({
                TableName: physicalId,
                DeletionProtectionEnabled: true,
              })
            );
          },
        });
      } catch {
        // `catch`, not `finally`, and `outcome` stays `'failed'`.
        // `compensateRemovedDeletionProtection` does not throw by contract --
        // every arm is inside its own try/catch -- but a LOGGER that throws
        // escapes it, and under `finally` that exception replaced the delete
        // error on its way out, so `throw error` below was never reached and
        // the caller saw the logger's message instead of "Failed to delete
        // DynamoDB table ...". Measured with a probe that made `logger.warn`
        // and `logger.error` throw. Catching keeps the ORIGINAL error's
        // identity while leaving the retain-on-unknown-outcome behaviour
        // exactly as it was: an outcome that never got assigned is `'failed'`,
        // so nothing is released.
      }
      {
        // TERMINAL failure whose compensation did not FAIL: drop the flip
        // record (issue #2244).
        //
        // Records are RETAINED on a throw by design -- that is what carries "an
        // earlier attempt already flipped the guard off" across the re-entered
        // `delete()` issue #1978's round 2 fixed. But the contract is about a
        // re-entry, and `isTerminalDeleteFailure` is the predicate that already
        // asserts none is coming: it MIRRORS `destroy-runner.ts`'s re-entry
        // condition. It is the same PREDICATE the compensation above consults,
        // NOT the same gate -- the compensation ANDs it with
        // `flip.flippedOffByThisRun` and `!flip.deleteAccepted`, so this
        // release also fires on the arms where the compensation early-returned
        // having done nothing. That is intended: a record with nothing to undo
        // has nothing left to serve either. So on this arm there is no second
        // attempt for the record to serve, and keeping it is not conservative
        // -- it is wrong in the one direction the registry's own JSDoc names.
        // A provider is REGISTERED once, so every delete served by the same
        // `ProviderRegistry` reaches this same INSTANCE and therefore this same
        // registry -- the deploy engine's own deletes, and
        // `rollback-executor.ts`, which takes that registry from its context
        // rather than building one. (`destroy-runner.ts` DOES build a fresh
        // registry when a stack's region differs, so the sharing is per
        // registry rather than per process; the key is region-qualified for the
        // same reason.) A second destroy of the same `region\0name` key inside
        // the reuse window would inherit that latch and answer its own terminal
        // failure with an `UpdateTable(DeletionProtectionEnabled: true)` the
        // user never asked for. Issue #2211's SLIDE widened that window from "a
        // full window after the FIRST attempt" to "a full window after the
        // LAST", which is what turned this from implicit into worth closing.
        //
        // WHAT THE GUARD ACTUALLY IS ON EACH RELEASING ARM, because "the
        // compensation has just put it BACK ON" is true of only one of them:
        //
        //  - `restored` -- the re-enable landed, so the guard is back on and a
        //    retained `flippedOffByThisRun: true` describes a world that no
        //    longer exists.
        //  - `not-applicable` because `flippedOffByThisRun` is false -- this run
        //    never turned the guard off, so there is nothing to describe.
        //  - `not-applicable` because `deleteAccepted` is true -- the guard IS
        //    still off, but AWS has taken the `DeleteTable` and the table is
        //    `DELETING`, so there is no live guard for a later delete to owe
        //    anything to.
        //  - `not-applicable` because the error is retryable -- unreachable
        //    here, since the same predicate gates this release.
        //
        // NOT released when the compensating `UpdateTable` itself FAILED, and
        // that arm is the reason this reads an outcome at all. There the guard
        // really is off and cdkd really is the one that turned it off, so the
        // record is the only in-process memory that a re-enable is still owed
        // -- and a later delete of the same key retrying it is the action cdkd
        // owes, not one nobody asked for. Releasing it instead makes that later
        // delete observe the guard already off, record
        // `flippedOffByThisRun: false` and compensate NOTHING, so a table cdkd
        // stripped stays stripped. Two state records CAN name one physical
        // table -- `cdkd import` adopts the same table into a second stack --
        // so this is reachable by the same route that justifies the release
        // itself. (An earlier revision released here too, calling the retry
        // "speculative". It is not, and the two arguments could not both
        // stand.) The failed re-enable is still reported with the command that
        // fixes it; retention is what lets cdkd fix it on its own.
        //
        // THE THREE ROUTES OUT OF THIS `catch`, since the predicate answers
        // them differently and only one of them is obvious:
        //
        //  - **Retryable** (a throttle on any attempt but the outer loop's
        //    last). The predicate is FALSE, so nothing is released and the
        //    retained-on-throw contract stands exactly as it did. On the LAST
        //    attempt the destroy loop's `runDeleteAttempt` scope makes the
        //    same throttle TERMINAL (issue #4318), so the compensation runs and
        //    this release follows it, as on the ordinary route.
        //  - **Interrupt** (Ctrl-C). `isInterruptedWaitError` makes it TERMINAL,
        //    so the release fires -- and it is the route that most needs it. The
        //    run is being torn down, no re-entry is coming, and the compensation
        //    above has just re-enabled the guard (on the `restored` arm -- a
        //    compensation that FAILED retains instead, and one that was
        //    `not-applicable` had nothing to put back); the process can still outlive
        //    the abort long enough for a rollback or a sibling stack's destroy
        //    to reach the same key. Pinned by its own case, since a claim in a
        //    comment that no test composes is one a refactor can quietly break.
        //  - **Deadline** (`--resource-timeout`). This release does NOT fire, and
        //    cannot: `src/deployment/resource-deadline.ts` rejects the OUTER
        //    promise on its timer without cancelling what it wraps, so no
        //    `ResourceTimeoutError` ever enters this `catch` (known narrowing 2,
        //    the same non-cancelling shape issue #1955 documents). The record
        //    stays latched behind an attempt that is still polling, which is
        //    correct: that attempt has not finished, and when it does it reaches
        //    either the success release or this one.
        //
        // The delete ALLOWANCE is deliberately left alone, and NOT because a
        // re-entry might still spend it -- this arm's whole premise is that no
        // re-entry is coming. It is out of scope: this change is about the flip
        // record, the two registries differ in what an inherited entry can DO
        // (an inherited allowance can only make a later delete give up sooner,
        // never issue a write nobody asked for), and `ElapsedBudgetRegistry`'s
        // window is FIXED rather than sliding, so it ages out from its own
        // creation regardless of what happens here.
        if (isTerminalDeleteFailure(error) && outcome !== 'failed') {
          this.protectionFlips.release(deleteBudgetKey(physicalId, context?.expectedRegion));
        }
      }
      throw error;
    }
  }

  private async deleteGlobalTableResource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord,
    progress: DeleteProgress
  ): Promise<void> {
    // go-to-k/cdkd#2007: the table name can be secret-derived. The name is
    // masked as a VALUE too, so one below the substring floor is caught.
    const deleteMask: SecretMasker = context?.maskSecrets ?? ((text: string) => text);
    // The sinks the two thrown wraps below route AWS's withheld text through.
    const deleteLog = createMaskedLogSinks(this.logger, deleteMask);
    const loopLogger = maskedLogger(this.logger, context?.maskSecrets, physicalId);
    const shownTable = deleteMask(physicalId);
    this.logger.debug(deleteMask(`Deleting DynamoDB GlobalTable ${logicalId}: ${shownTable}`));

    // ONE allowance for every wait below (issue #1955). Acquired before the
    // FIRST call, so the `--remove-protection` flip's ACTIVE wait is both
    // MEASURED by this clock and CLAMPED by it — the two are separate
    // properties and an earlier revision had only the first, which left that
    // wait free to spend ~12 min of a budget it was nonetheless draining.
    // Acquired from the registry so a re-entry after a throttle CONTINUES this
    // clock rather than restarting it — see the field's own note and
    // `./dynamodb-delete-budget.ts`.
    const budget = this.deleteBudgets.acquire(
      deleteBudgetKey(physicalId, context?.expectedRegion),
      resolveDynamoDbDeleteBudgetMs(),
      resolveDynamoDbDeleteBudgetClock(),
      // Entries are retained on a throw so the outer loop's re-entry keeps
      // spending this clock — but "retained" must not mean "forever". Past the
      // deadline the allowance is sized against, that deadline has certainly
      // fired, so any caller arriving now belongs to a NEW operation and gets a
      // new allowance. Without this, a provider instance shared across
      // operations (the deploy engine hands the same registry to
      // `rollback-executor.ts`) could hand a fresh delete a spent budget.
      DELETE_BUDGET_REUSE_WINDOW_MS
    );

    if (context?.removeProtection === true) {
      // Idempotent flip-off — AWS accepts the no-op already-disabled case.
      try {
        // OBSERVE before flipping (issue #1978). Only a guard that was ON and
        // that THIS run turned off may be put back on the error path — a table
        // the user had already left unprotected must come out of a failed
        // destroy exactly as it went in. Best-effort like the flip itself: a
        // describe failure leaves the record false, which means "do not know,
        // so do not touch", and the delete proceeds either way. Deliberately
        // NOT read from the state properties: state can be stale, and what has
        // to be restored is what AWS actually had.
        //
        // This is a SECOND `DescribeTable` on this path — the pre-delete one
        // further down cannot serve, because it runs after the flip and would
        // therefore report the value cdkd just wrote.
        let observedProtectionOn = false;
        try {
          const before = await this.dynamoDBClient.send(
            new DescribeTableCommand({ TableName: physicalId })
          );
          observedProtectionOn = before.Table?.DeletionProtectionEnabled === true;
        } catch (observeError) {
          this.logger.debug(
            deleteMask(
              `Could not read DeletionProtectionEnabled on ${shownTable} before disabling it: ${describeAwsFailure(observeError).detail}`
            )
          );
        }
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            DeletionProtectionEnabled: false,
          })
        );
        // Set only AFTER AWS accepted the flip: a rejected `UpdateTable` left
        // the guard where it was, so there is nothing to compensate.
        //
        // LATCHED, never assigned: on a re-entry the observation above reports
        // the guard OFF because the PREVIOUS attempt turned it off, so
        // `flip.flippedOffByThisRun = observedProtectionOn` would erase what
        // that attempt recorded and the terminal failure here would compensate
        // nothing (issue #1978). The record is cleared by `release()` on a
        // terminal outcome, which is what stops the latch from outliving the
        // delete it belongs to.
        if (observedProtectionOn) flip.flippedOffByThisRun = true;
        this.logger.debug(`Disabled DeletionProtectionEnabled on ${logicalId}, waiting for ACTIVE`);
        try {
          await this.waitForTableActiveAfterUpdate(
            physicalId,
            logicalId,
            GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
            budget,
            context?.maskSecrets
          );
        } catch (waitErr) {
          this.logger.debug(
            deleteMask(
              `Could not wait for table ${shownTable} ACTIVE after protection flip: ${describeAwsFailure(waitErr).detail}`
            )
          );
        }
      } catch (flipError) {
        if (!(flipError instanceof ResourceNotFoundException)) {
          this.logger.debug(
            deleteMask(
              `Could not disable DeletionProtectionEnabled on ${shownTable}: ${describeAwsFailure(flipError).detail}`
            )
          );
        }
      }
    }

    let currentRegion: string;
    try {
      currentRegion = await this.dynamoDBClient.config.region();
    } catch (regionErr) {
      const cause = regionErr instanceof Error ? regionErr : undefined;
      throw new ProvisioningError(
        `Could not resolve client region for DynamoDB GlobalTable ${logicalId} delete — would risk dropping the local replica`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    // Drop every non-local replica first. GlobalTable cannot be deleted
    // while it has additional replicas — AWS rejects DeleteTable.
    // ALSO tear down per-replica autoscaling targets (read dim) BEFORE
    // the replica delete, AND the table-level autoscaling target
    // (write dim) BEFORE the DeleteTable call. Without these,
    // `RegisterScalableTarget` + `PutScalingPolicy` survive in AWS's
    // application-autoscaling control plane indefinitely; a future
    // create of the same `tableName` (same region) inherits the orphan
    // target silently. PR #403 code-reviewer caught this as a blocker.
    // Captured from the pre-delete describe so the #1521 index-settled gate
    // below needs no second call.
    let preDeleteTable:
      | {
          readonly GlobalSecondaryIndexes?:
            | ReadonlyArray<{ readonly IndexStatus?: string | undefined }>
            | undefined;
          readonly VectorIndexes?:
            | ReadonlyArray<{ readonly IndexStatus?: string | undefined }>
            | undefined;
        }
      | undefined;
    // go-to-k/cdkd#2762: the index-busy lines name a vector index only on a
    // table that has one, so every other table's text stays as it was.
    let indexNoun: string | undefined;
    try {
      const describe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const replicas = describe.Table?.Replicas ?? [];
      // Index names come from AWS, not from the template: `delete()` may be
      // running against state whose properties are stale, and an orphaned
      // scalable target is only findable by the index that actually exists.
      preDeleteTable = describe.Table;
      if ((describe.Table?.VectorIndexes ?? []).length > 0) indexNoun = TABLE_INDEX_NOUN;
      const tableIndexNames = (describe.Table?.GlobalSecondaryIndexes ?? [])
        .map((gsi) => gsi.IndexName)
        .filter((name): name is string => typeof name === 'string');
      for (const replica of replicas) {
        const region = replica.RegionName;
        if (!region || region === currentRegion) continue;
        try {
          // Tear down the cross-region replica's read autoscaling
          // BEFORE deleting the replica (best-effort) — table level first,
          // then every per-index read target in that region (Issue #1419).
          await this.applyAutoScalingDiff(
            physicalId,
            'dynamodb:table:ReadCapacityUnits',
            {} /* oldSettings — placeholder; non-undefined forces teardown */,
            undefined /* newSettings — undefined triggers Delete+Deregister */,
            this.getRegionalAutoScalingClient(region),
            undefined /* indexName — table level */,
            budget,
            deleteMask,
            progress
          );
          // Index names come from the TABLE's index list, not the replica's
          // own `GlobalSecondaryIndexes`. A GlobalTable replicates every
          // index to every replica, but the per-replica entry is documented
          // as "replica-specific settings" and its sibling
          // `ProvisionedThroughputOverride` says "if not described, uses the
          // source table's" — so a replica that inherits throughput can come
          // back with the list omitted entirely, and every
          // `dynamodb:index:ReadCapacityUnits` target in that region would
          // leak past `DeleteTable`.
          for (const indexName of tableIndexNames) {
            await this.applyAutoScalingDiff(
              physicalId,
              'dynamodb:index:ReadCapacityUnits',
              {},
              undefined,
              this.getRegionalAutoScalingClient(region),
              indexName,
              budget,
              deleteMask,
              progress
            );
          }
          await this.dropReplicaForDelete(
            physicalId,
            region,
            context?.removeProtection === true,
            logicalId,
            budget,
            deleteMask
          );
          progress.stripped = true;
          await this.waitForReplicaGone(
            physicalId,
            region,
            logicalId,
            REPLICA_GONE_WAIT_ATTEMPTS,
            budget,
            context?.maskSecrets
          );
          // go-to-k/cdkd#5581: the read teardown above names only the read
          // dimension; DynamoDB also registered the replica's WRITE target
          // there, which survives the replica and the table.
          await this.deregisterRemovedReplicaScalableTargets(physicalId, region, {
            budget,
            maskSecrets: deleteMask,
            progress,
          });
        } catch (replicaErr) {
          // Table itself already gone — outer DeleteTable will handle
          // idempotency (the region check below ensures a mismatched
          // destroy doesn't silently strip state).
          if (!(replicaErr instanceof ResourceNotFoundException)) {
            throw replicaErr;
          }
        }
      }
      // Tear down the LOCAL replica's read autoscaling AND the table-
      // level write autoscaling before `DeleteTable`. Same orphan-leak
      // concern: surviving scaling targets would inherit on re-create.
      const localAsClient = await this.getLocalAutoScalingClient();
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:ReadCapacityUnits',
        {},
        undefined,
        localAsClient,
        undefined /* indexName — table level */,
        budget,
        deleteMask,
        progress
      );
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:WriteCapacityUnits',
        {},
        undefined,
        localAsClient,
        undefined /* indexName — table level */,
        budget,
        deleteMask,
        progress
      );
      // Per-index targets in the local region (Issue #1419). Without this
      // the index-level targets registered by `create()` / step 6b survive
      // `DeleteTable` and are silently inherited by a future table of the
      // same name — the same orphan-leak the table-level teardown above
      // exists to prevent, one level down.
      for (const indexName of tableIndexNames) {
        await this.applyAutoScalingDiff(
          physicalId,
          'dynamodb:index:WriteCapacityUnits',
          {},
          undefined,
          localAsClient,
          indexName,
          budget,
          deleteMask,
          progress
        );
        await this.applyAutoScalingDiff(
          physicalId,
          'dynamodb:index:ReadCapacityUnits',
          {},
          undefined,
          localAsClient,
          indexName,
          budget,
          deleteMask,
          progress
        );
      }
    } catch (describeErr) {
      // An already-actionable `ProvisioningError` passes through VERBATIM.
      // This block wraps far more than the describe its message names — the
      // replica teardown loop and its `waitForReplicaGone` run inside it — so a
      // replica that never disappeared used to surface as
      // `Failed to describe DynamoDB GlobalTable X before delete: Replica
      // us-west-2 ... did not disappear`, a describe failure that did not
      // happen, while the real residue (a replica removal still in flight, the
      // local auto-scaling teardown skipped, no `DeleteTable` issued) went
      // unnamed. Pre-existing, and reachable more often now that the shared
      // allowance can cut the replica wait short on a third replica or on a
      // re-entry. Same rule the `Table` provider's `update()` catch already
      // uses: never double-wrap an error that already says what went wrong.
      if (describeErr instanceof ProvisioningError) throw describeErr;
      // Same passthrough, same reason (issue #2053 review): this catch wraps
      // far more than the describe its message names — the replica teardown
      // loop and `waitForReplicaGone` run inside it — so a user abort surfaced
      // as `Failed to describe DynamoDB GlobalTable X before delete: ...`, a
      // describe failure that did not happen. That is the exact double-wrap the
      // comment below already claims was fixed for the replica case.
      if (isInterruptedWaitError(describeErr)) throw describeErr;
      // An AWS-authored failure is reduced to its class (go-to-k/cdkd#2319):
      // this arm THROWS, so the text reaches the durable events store. The
      // typed RNF guard below returns before any wrap, so a class naming
      // another object's not-found here (an auto-scaling
      // `ObjectNotFoundException` from the replica teardown) is marked
      // `markNotGone`: the delete classifiers never read it as this table gone,
      // which keeps the state row.
      if (!(describeErr instanceof ResourceNotFoundException)) {
        const cause = describeErr instanceof Error ? describeErr : undefined;
        throw this.wrapDeleteError(
          deleteLog,
          describeErr,
          (text) =>
            new ProvisioningError(
              `Failed to describe DynamoDB GlobalTable ${logicalId} before delete: ${text}`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
      // RNF on the pre-delete DescribeTable — table already gone; the
      // region-match check on the DeleteTable RNF path below handles
      // idempotency.
    }

    try {
      // AWS refuses `DeleteTable` while an index is transitioning
      // (`Cannot delete table while indexes are being created, updated, or
      // deleted`), and that is not a theoretical destroy failure: it is what
      // ORPHANED this fixture's table on 2026-08-10 after a deploy failed
      // mid-flip (issue #1521). Gated on what the PRE-DELETE describe above
      // already reported, so the overwhelmingly common case (no index in
      // flight) costs no extra call at all; only a table that really is
      // mid-transition pays for the poll. Best-effort — on timeout the delete
      // goes ahead and AWS's own error stays the backstop.
      if (hasTransitionalTableIndex(preDeleteTable)) {
        deleteLog.debug(`Waiting for indexes on ${physicalId} to settle before DeleteTable`);
        await this.waitForIndexesActive(physicalId, logicalId, {
          proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
          budget,
          ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
        });
      }
      // ...and retry when AWS refuses ANYWAY (issue #1830). The gate above is
      // necessary but not sufficient: it reads the PRE-DELETE describe, which
      // is taken before the auto-scaling teardown loop above, and that loop
      // issues a long sequence of application-autoscaling calls. An index can
      // enter `UPDATING` inside that window — application auto-scaling can
      // start a capacity change on an autoscaled index at any moment — so a
      // table that was settled when we looked is not necessarily settled when
      // `DeleteTable` lands. Measured on a real `dynamodb-globaltable` destroy
      // (us-east-1, 2026-08-13): the delete failed, the very next `cdkd
      // destroy` succeeded with no other change. Surfacing that as a hard
      // `PartialFailureError` with state preserved makes the user re-run a
      // destroy for a condition that clears itself in seconds.
      //
      // The classifier, the budget, the re-arm bound and the warning line all
      // live in `../dynamodb-index-busy-delete.ts`, which
      // `dynamodb-table-provider.ts` reads too (issue #1931): the same AWS
      // refusal has to answer the same way on both DynamoDB types, and a
      // second spelling is a second chance for one of them to drift.
      await deleteTableWithIndexBusyRetry({
        logicalId,
        physicalId,
        typeLabel: 'GlobalTable',
        ...(indexNoun !== undefined && { indexNoun }),
        // THIS type's budget, deliberately UNCHANGED at 8 while issue #1950
        // raised the sibling `AWS::DynamoDB::Table` to 14 — see the comment on
        // the re-arm below, and the derivation on
        // `GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`.
        maxRetries: GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
        // go-to-k/cdkd#2319: `withRetry`'s debug line quotes AWS's raw
        // message, which echoes the table name.
        logger: loopLogger,
        deleteTable: async () => {
          await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
          // AWS TOOK the delete. Nothing after this line may put the guard back
          // — the table is `DELETING`, so a later throw on this path is a wait
          // failing rather than the delete (issue #1978). That is not
          // hypothetical here: `waitForTableGone` below throws `Table X did not
          // disappear within Ns`, which matches no retryable pattern and is
          // therefore TERMINAL by the compensation's own predicate. Without
          // this record it would answer an accepted delete with an
          // `UpdateTable(true)` against a dying table and a log line calling
          // that table LIVE.
          flip.deleteAccepted = true;
        },
        // The re-arm is BOUNDED, and for a GSI deliberately far shorter than the
        // 15-minute poll the #1521 gate above uses: that gate runs ONCE, ahead
        // of the retry loop, while this one runs per retry, so the LOOP's wall
        // clock is the product. See {@link DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS}
        // for the arithmetic and for the per-resource deadline it stays under.
        //
        // That figure is the LOOP's, not `delete()`'s, and the difference used
        // to matter a great deal: the deadline is applied AROUND `delete()` —
        // in fact around `destroy-runner.ts`'s outer retry loop, which shares
        // one deadline across up to 4 `delete()` calls. The same call can
        // already have spent the #1521 gate's 900 polls (~18 min at the
        // measured ~1.2s per poll) just above, and 600 polls (~12 min) in
        // `waitForReplicaGone` per non-local replica before that, so a
        // REPLICATED table whose index is transitioning reached ~18 + 12 + 10.4
        // ~= 40 min and ended in exactly the generic `ResourceTimeoutError`
        // this bound exists to avoid (issue #1955).
        //
        // It no longer can. Every wait on this path — the replica waits, the
        // #1521 gate, this re-arm and the gone-wait below — now draws polls
        // from ONE shared `budget`, and the loop itself stops retrying when
        // that budget is spent, so `delete()` fails with AWS's own index-busy
        // sentence while the deadline still has minutes left rather than being
        // aborted mid-poll by a timer that does not cancel anything. The budget
        // is keyed by physical id, so the throttle re-entry that outer loop
        // performs continues this clock instead of restarting it. Sizing and
        // the full three-term argument: `./dynamodb-delete-budget.ts`.
        //
        // The per-type budget of 8 stays what it is, and its reason is
        // narrower now: #1950 raised the sibling `AWS::DynamoDB::Table` to 14,
        // and on THIS type the #1521 gate has already spent ~18 min of the
        // shared allowance by the time the loop starts, so a larger count would
        // buy retries the budget cannot fund rather than more patience.
        // `budget` is read INSIDE `waitForIndexesActive` on every call, not
        // captured once here: the loop runs for minutes and the allowance
        // drains as it goes, so the last retry must see the last remaining
        // figure rather than the first one.
        reArm: () =>
          this.waitForIndexesActive(physicalId, logicalId, {
            // go-to-k/cdkd#2762: the LONG cap serves a vector index building
            // alone (a build outlasts the short re-arm, go-to-k/cdkd#5574); a
            // GSI still stops at the short one.
            maxAttempts: VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
            shortCapUnlessVectorBusy: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
            proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
            budget,
            ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
          }),
        // The wall-clock half of the loop's bound. `isRetryable` ANDs this with
        // the index-busy classifier, so an exhausted budget makes AWS's refusal
        // terminal — which is what surfaces its actionable message instead of
        // the deadline's generic one.
        shouldKeepRetrying: () => {
          if (!budget.isExhausted()) return true;
          loopLogger.warn(
            `DynamoDB GlobalTable ${logicalId}: giving up the index-busy DeleteTable retry on ` +
              `${physicalId} — the delete path has spent its whole ` +
              `${Math.round(budget.totalMs / 60_000)}-minute budget, so the destroy fails on ` +
              `AWS's refusal; re-running it succeeds once the index is ACTIVE.`
          );
          return false;
        },
        sleepSeam: deleteTableRetryDelays,
      });
      // DeleteTable is async; wait until DescribeTable returns
      // ResourceNotFoundException so siblings / verify steps observing
      // the table after destroy see it actually gone.
      await this.waitForTableGone(
        physicalId,
        logicalId,
        TABLE_GONE_WAIT_ATTEMPTS,
        budget,
        context?.maskSecrets
      );
      this.logger.debug(`Successfully deleted DynamoDB GlobalTable ${logicalId}`);
      // TERMINAL success — the allowance has no second pass to fund, and the
      // flip record has nothing left to undo. Released together and keyed
      // together: a retained record would let a LATER destroy of a table with
      // the same name inherit this run's flip.
      this.deleteBudgets.release(deleteBudgetKey(physicalId, context?.expectedRegion));
      this.protectionFlips.release(deleteBudgetKey(physicalId, context?.expectedRegion));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.dynamoDBClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  DynamoDB GlobalTable ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`DynamoDB GlobalTable ${physicalId} does not exist, skipping`);
        }
        this.deleteBudgets.release(deleteBudgetKey(physicalId, context?.expectedRegion));
        // The table is GONE, so there is no guard to restore, and reaching this
        // line means `delete()` RETURNS rather than throwing — so the
        // compensation never runs on it. Released for the same hygiene as the
        // success path. Note the release is NOT reached when the
        // `assertRegionMatch` above throws: the record stays latched THROUGH
        // the compensation on purpose (the re-entered-delete contract), so its
        // own `UpdateTable` still goes out and is answered with the same
        // ResourceNotFound — which `compensateRemovedDeletionProtection`
        // reports at WARN, dropping the CLAIM that the table is live rather
        // than the line itself, because RNF from `UpdateTable` also covers a
        // live table whose status is merely not ACTIVE (issue #2224; an earlier
        // revision of this comment said `debug`, which that issue's fix
        // deliberately did not ship). `delete()`'s own `catch` then KEEPS the
        // record on that arm (issue #2244): the failure is terminal, but the
        // compensation reports `failed`, and a re-enable that did not land is
        // one cdkd still owes -- so a later delete of the same key may retry
        // it. Pinned by the `#2224` case in
        // `dynamodb-remove-protection-compensate.test.ts`.
        this.protectionFlips.release(deleteBudgetKey(physicalId, context?.expectedRegion));
        return;
      }
      // Deliberately NOT released on a throw: the outer retry loop may re-enter
      // `delete()` inside the SAME deadline (it classes throttles as
      // retryable), and that second pass has to keep spending this allowance
      // rather than start a fresh one. That is the whole compounding term of
      // issue #1955.
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        deleteLog,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete DynamoDB GlobalTable ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          ),
        indexNoun
      );
    }
  }

  /**
   * go-to-k/cdkd#4606: whether the global table a failed CREATE journaled is
   * the one the record under the same logical id holds (a fix-forward that
   * created a new global table there under another name).
   *
   * Both ids must be table NAMES (the physical id this provider records); an
   * ARN or anything else is `'unknown'`. A table name is unique per account
   * and region and a table cannot be renamed, and equal names are `'same'`
   * without a read: whatever table holds the name now is the record's, and
   * deleting by that name would delete it. After the region check the
   * record's table must read back in the stack's region (else `'unknown'`);
   * the journaled one is `'same'` when it reads back under the record's
   * `TableId` (immutable, AWS-generated, never given to a later table; each
   * replica region has its own, so only the stack region's is compared),
   * `'different'` under another, and `'different'` when AWS reports it gone:
   * the record's table answers to its own, other, name. Any other read
   * failure throws, which the caller reads as `'unknown'`.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== 'AWS::DynamoDB::GlobalTable') return 'unknown';
    if (!isTableName(journaledPhysicalId) || !isTableName(record.physicalId)) return 'unknown';
    if (journaledPhysicalId === record.physicalId) return 'same';
    const clientRegion = await this.dynamoDBClient.config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recordTableId = await this.readTableIdIfExists(record.physicalId);
    if (recordTableId === undefined) return 'unknown';
    const journaledTableId = await this.readTableIdIfExists(journaledPhysicalId);
    if (journaledTableId === undefined) return 'different';
    return journaledTableId === recordTableId ? 'same' : 'different';
  }

  /**
   * go-to-k/cdkd#4655 / #4606: the stack region's replica `TableId`, which
   * AWS generates, never changes and never gives a later table. A table
   * re-created under the name answers with another id, so the settle keeps it
   * rather than deleting it as the failed CREATE's orphan. A failed CREATE's
   * own token comes from its CreateTable response, on the failure's mark
   * (`markCreatedBeforeFailure`); this is the live read.
   *
   * `undefined` for another type, an id that is not a table name, or a client
   * in another region than `expectedRegion`. `RESOURCE_NOT_FOUND` only on
   * `ResourceNotFoundException`; any other failure, and a response naming
   * another table or no `TableId`, throws.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::DynamoDB::GlobalTable' || !isTableName(physicalId)) {
      return undefined;
    }
    const clientRegion = await this.dynamoDBClient.config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    const live = await this.readTableIdIfExists(physicalId);
    return live === undefined ? RESOURCE_NOT_FOUND : live;
  }

  /**
   * The table's `TableId` in the shared client's region, or `undefined` when
   * `DescribeTable` answers `ResourceNotFoundException`. Any other failure, a
   * response naming another table, and one naming no `TableId` throw: "could
   * not read" never reads as "gone".
   */
  private async readTableIdIfExists(tableName: string): Promise<string | undefined> {
    let response;
    try {
      response = await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
    if (response.Table?.TableName !== tableName) {
      throw new Error('DescribeTable answered for another table than the one asked for');
    }
    const tableId = response.Table.TableId;
    if (typeof tableId !== 'string' || tableId === '') {
      throw new Error('DescribeTable returned no TableId');
    }
    return tableId;
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing DynamoDB GlobalTable.
   *
   * Cached per `(physicalId, attribute)` for the deploy run to avoid
   * repeated `DescribeTable` calls.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // ENCODED, not separated (go-to-k/cdkd#3496). A PRINTABLE separator here,
    // and both halves are unchecked: `physicalId` comes from a state record
    // that `parseStateBody` casts, and `attributeName` is template text. The
    // cache is read BEFORE the attribute switch below, so a hit answers
    // whatever was asked -- one AWS::DynamoDB::GlobalTable's attribute served for
    // another's `Fn::GetAtt`.
    const cacheKey = injectiveKey(physicalId, attributeName);
    if (this.attributeCache.has(cacheKey)) {
      return this.attributeCache.get(cacheKey);
    }
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      let value: unknown;
      switch (attributeName) {
        case 'Arn':
          value = resp.Table?.TableArn;
          break;
        case 'StreamArn':
          value = resp.Table?.LatestStreamArn;
          break;
        case 'TableId':
          value = resp.Table?.TableId;
          break;
        default:
          value = undefined;
      }
      this.attributeCache.set(cacheKey, value);
      return value;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * go-to-k/cdkd#5487: the live values of a record's unsettled properties in
   * the template's shape, for the engine's convergence step:
   * `readCurrentState` shaped against the record (every replica read in its
   * own region), read STRICTLY so a failed read throws rather than omitting a
   * key, with two corrections:
   *
   * - a PAY_PER_REQUEST table reports no `WriteProvisionedThroughputSettings`
   *   (the readback's `{}` placeholder, which no template declares);
   * - every unsettled value goes through ONE projection (`projectNamed`) onto
   *   what the record or the template names, so convergence never removes or
   *   resets what neither named. Collections keyed by an identity — `Replicas`
   *   (by `Region`), `GlobalSecondaryIndexes` and each replica's
   *   `GlobalSecondaryIndexes` (by `IndexName`), `AttributeDefinitions` (by
   *   `AttributeName`) — keep only named entries (a live-only one is left in
   *   place, never deleted, and warned about); within an entry or object a live
   *   member (deletion protection, a KMS key, a policy, autoscaling settings, at
   *   any depth) is kept only when named, else the record's value stands.
   *   `Tags` always keep the record's value: tags merge (CloudFormation removes
   *   only the recorded tags a template dropped).
   */
  async readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const live = await strictReadScope.run(names, () =>
      this.readCurrentState(physicalId, logicalId, resourceType, recordedProperties)
    );
    if (typeof live !== 'object' || live === null) return live;
    const out: Record<string, unknown> = { ...live };
    if (out['BillingMode'] === 'PAY_PER_REQUEST') delete out['WriteProvisionedThroughputSettings'];
    // Every unsettled value goes through the one projection (`projectNamed`):
    // a collection keyed by an identity (replicas, indexes, each replica's
    // indexes, attribute definitions) and every object member below it.
    const unnamed: UnnamedLiveEntry[] = [];
    for (const name of names) {
      if (!Object.hasOwn(out, name)) continue;
      out[name] = projectNamed(
        out[name],
        recordedProperties?.[name],
        desiredProperties?.[name],
        name,
        unnamed,
        attemptedItems
      );
    }
    for (const entry of unnamed.filter((e) => e.ambiguous === true)) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): ${entry.path} on AWS has entries cdkd cannot key by an identity, so convergence keeps the recorded ${entry.path} rather than risk removing an entry neither the record nor the template declares. Check it with 'cdkd drift'.`
      );
    }
    for (const entry of unnamed.filter((e) => e.ambiguous !== true)) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): ${entry.path} on AWS holds ${entry.identity} ${entry.value}, which neither the record nor the template declares, so cdkd leaves it in place. If the failed update added it and it should not be there, remove it by hand (for a replica: aws dynamodb update-table --replica-updates Delete; for an index: --global-secondary-index-updates Delete; for a vector index: --vector-index-updates Delete).`
      );
    }
    return out;
  }

  /**
   * go-to-k/cdkd#5487: the unsettled names AWS is still changing. Only states
   * it is moving through count: a table CREATING / UPDATING / DELETING moves
   * every name but `TimeToLiveSpecification`; a replica in one of those states
   * moves `Replicas`; an index in one moves `GlobalSecondaryIndexes`; SSE
   * ENABLING / DISABLING / UPDATING moves `SSESpecification`; a vector index in
   * one moves `VectorIndexes`; a warm throughput UPDATING moves `WarmThroughput`
   * (go-to-k/cdkd#2762); TTL ENABLING
   * moves `TimeToLiveSpecification` (DISABLING reads as its destination). A
   * state at rest (an inaccessible key, an archived or disabled region) lets
   * the update run, so AWS's error names it. A failed read keeps every name.
   */
  async unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    const MOVING = new Set(['CREATING', 'UPDATING', 'DELETING']);
    try {
      const table = (
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: physicalId }))
      ).Table;
      const moving = new Set<string>();
      if (table?.TableStatus !== undefined && MOVING.has(table.TableStatus)) {
        for (const name of names) if (name !== 'TimeToLiveSpecification') moving.add(name);
      }
      if (
        names.has('Replicas') &&
        (table?.Replicas ?? []).some(
          (replica) => replica.ReplicaStatus !== undefined && MOVING.has(replica.ReplicaStatus)
        )
      ) {
        moving.add('Replicas');
      }
      if (
        names.has('GlobalSecondaryIndexes') &&
        (table?.GlobalSecondaryIndexes ?? []).some(
          (index) => index.IndexStatus !== undefined && MOVING.has(index.IndexStatus)
        )
      ) {
        moving.add('GlobalSecondaryIndexes');
      }
      if (
        names.has('VectorIndexes') &&
        (table?.VectorIndexes ?? []).some(
          (index) => index.IndexStatus !== undefined && MOVING.has(index.IndexStatus)
        )
      ) {
        moving.add('VectorIndexes');
      }
      if (names.has('WarmThroughput') && table?.WarmThroughput?.Status === 'UPDATING') {
        moving.add('WarmThroughput');
      }
      const sse = table?.SSEDescription?.Status;
      if (
        names.has('SSESpecification') &&
        (sse === 'ENABLING' || sse === 'DISABLING' || sse === 'UPDATING')
      ) {
        moving.add('SSESpecification');
      }
      if (names.has('TimeToLiveSpecification')) {
        const ttl = (
          await this.dynamoDBClient.send(new DescribeTimeToLiveCommand({ TableName: physicalId }))
        ).TimeToLiveDescription?.TimeToLiveStatus;
        if (ttl === 'ENABLING') moving.add('TimeToLiveSpecification');
      }
      return moving;
    } catch {
      return names;
    }
  }

  /**
   * Read the AWS-current DynamoDB GlobalTable configuration in CFn-property shape.
   *
   * Reverse-maps `DescribeTable` + `ListTagsOfResource` + `DescribeTimeToLive`
   * + per-replica `DescribeContributorInsights` /
   * `DescribeContinuousBackups` / `DescribeKinesisStreamingDestination`
   * into the `AWS::DynamoDB::GlobalTable` property set.
   *
   * Type-discriminator gating (memory rule
   * `feedback_always_emit_check_type_discriminator.md`):
   *  - StreamSpecification / SSESpecification follow the existing
   *    DynamoDB::Table provider's Class 1 guard: only surfaced when AWS
   *    reports the feature actually enabled.
   *  - `WriteProvisionedThroughputSettings` reverse-maps both shapes:
   *    flat `{WriteCapacityUnits}` (no autoscaling) and full
   *    `{WriteCapacityAutoScalingSettings}` (Issue #395; recovered from
   *    application-autoscaling's `DescribeScalableTargets` +
   *    `DescribeScalingPolicies` for the
   *    `dynamodb:table:WriteCapacityUnits` dimension).
   *  - Per-replica `ReadProvisionedThroughputSettings` reverse-maps the
   *    `{ReadCapacityAutoScalingSettings}` shape only — there is no
   *    per-replica flat read capacity in `DescribeTable`'s response
   *    (the local `ProvisionedThroughput` block is table-level, not
   *    replica-level), so non-autoscaled replicas omit the key.
   *
   * Per-replica sub-specifications (`ContributorInsightsSpecification` /
   * `PointInTimeRecoverySpecification` / `KinesisStreamSpecification`)
   * are surfaced for BOTH the LOCAL replica AND cross-region replicas
   * via per-region SDK clients cached in `regionalClientCache` (Issue
   * #389 lifted the v1 LOCAL-only limitation; the per-replica reads
   * happen in `readReplicaSubSpecs` below). Each cross-region call is
   * best-effort — a permissions gap in one region omits the offending
   * key rather than aborting the whole drift read.
   *
   * go-to-k/cdkd#5381: each replica entry also carries its
   * `SSESpecification.KMSMasterKeyId`, `TableClass` and
   * `DeletionProtectionEnabled` (the deploy region's included; none of them
   * is emitted top-level any more), the declared `ResourcePolicy` /
   * `ReplicaStreamSpecification.ResourcePolicy` (`readReplicaPolicies`), the
   * PITR `RecoveryPeriodInDays` and a declared Contributor Insights `Mode`,
   * plus a declared `DisassociationProtectionEnabled` (go-to-k/cdkd#5570).
   * `canonicalizeDriftPair` converts a baseline the older read-back wrote.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const afterOwnWrite = context?.afterOwnWrite === true;
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const table = resp.Table;
      if (!table) return undefined;

      const result: Record<string, unknown> = {};

      if (table.TableName !== undefined) result['TableName'] = table.TableName;
      if (table.KeySchema) result['KeySchema'] = table.KeySchema;
      if (table.AttributeDefinitions) {
        result['AttributeDefinitions'] = table.AttributeDefinitions;
      }
      const billingMode = table.BillingModeSummary?.BillingMode;
      if (billingMode) {
        result['BillingMode'] = billingMode;
      }

      // Type-discriminator-gated: LSI placeholder. AWS omits it when there
      // are none; an empty-array placeholder would round-trip as "remove all
      // LSIs" on any future update() that learns the field. The GSI reverse
      // map is built further down, once the local region is resolved — it
      // needs the region to know which replica entry carries the read half.
      if (table.LocalSecondaryIndexes && table.LocalSecondaryIndexes.length > 0) {
        result['LocalSecondaryIndexes'] = table.LocalSecondaryIndexes;
      }

      // StreamSpecification: only emit when actually enabled. CFn's
      // schema requires StreamViewType when present, so the disabled
      // placeholder would be a CFn-invalid round-trip.
      if (table.StreamSpecification?.StreamEnabled && table.StreamSpecification.StreamViewType) {
        result['StreamSpecification'] = {
          StreamEnabled: true,
          StreamViewType: table.StreamSpecification.StreamViewType,
        };
      }

      // SSE: only emit when enabled. KMSMasterKeyId / SSEType are only
      // valid under SSEEnabled=true; an SSEEnabled=false placeholder
      // with a KMS key set would be CFn-invalid.
      if (table.SSEDescription?.Status === 'ENABLED') {
        const sse: Record<string, unknown> = { SSEEnabled: true };
        if (table.SSEDescription.SSEType !== undefined) {
          sse['SSEType'] = table.SSEDescription.SSEType;
        }
        result['SSESpecification'] = sse;
      }

      // The local table's `TableClass` / `DeletionProtectionEnabled` (and its
      // KMS key) are emitted on its `Replicas` entry below, where the CFn
      // schema keeps them: it has no top-level member for either
      // (go-to-k/cdkd#5381). A baseline written by the read-back that put them
      // here is converted by `canonicalizeDriftPair`.

      // Replicas: always emit `[]` placeholder per PR #145 — a console-side
      // replica add on a previously single-region table must show as drift.
      // Map RegionName → Region (CFn's per-replica shape) and attach
      // per-replica sub-specifications (PITR / Kinesis /
      // ContributorInsights / Tags) for BOTH the local AND cross-region
      // replicas — cross-region uses per-region SDK clients
      // (`getRegionalClient`) so each replica's sub-spec state surfaces
      // as drift just like the local one (Issue #389 lifted the v1
      // LOCAL-only limitation).
      const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';
      const tableNameForSubs = table.TableName ?? physicalId;
      // `DescribeTable` only carries `Replicas` once a table actually HAS
      // replicas — a single-region GlobalTable (the common case: every
      // `TableV2` without `replicas`) returns none. But the CFn schema
      // REQUIRES `Replicas` to include the deploy region, so the state
      // baseline always has a local entry; emitting `[]` here made drift
      // compare `[{Region: <local>, …}]` against `[]` and, worse, left the
      // local-replica-homed members this provider reverse-maps
      // (`ReadOnDemandThroughputSettings`, the per-GSI read halves — issue
      // #1436 / #1420) with nowhere to land, so their drift detection was
      // silently dead for exactly the single-region case. Synthesize the
      // local entry; the sub-spec / Tags reads below work on it unchanged.
      //
      // A MULTI-region table needs the same synthesis (issue #3573): the
      // `Replicas` list `DescribeTable` returns in the deploy region names the
      // OTHER regions only (measured us-east-1 + eu-west-1, 2026-09-24), so the
      // local entry -- and every member homed on it -- was never read back.
      // Appended LAST, where CDK's `TableV2` renders the deploy region; the
      // comparison does not depend on it, since `getDriftUnorderedPaths`
      // declares `Replicas` a set. An unresolved `currentRegion` adds nothing:
      // an entry for region `''` would name no replica.
      const sdkReplicas =
        table.Replicas && table.Replicas.length > 0
          ? currentRegion && !table.Replicas.some((r) => r.RegionName === currentRegion)
            ? [...table.Replicas, { RegionName: currentRegion }]
            : table.Replicas
          : [{ RegionName: currentRegion }];
      const replicas = await Promise.all(
        sdkReplicas.map(async (r) =>
          strictReadScope.run(replicaStrictness(r.ReplicaStatus), async () => {
            const entry: Record<string, unknown> = { Region: r.RegionName };
            if (!r.RegionName) return entry;

            const isLocal = r.RegionName === currentRegion;
            // go-to-k/cdkd#5381: the replica's key, class and protection in the
            // CFn spellings `create()` / `update()` read. The key used to be a
            // flat `KMSMasterKeyId` (cross-region only), and the local table's
            // class and protection went top-level.
            const kmsKey = isLocal
              ? table.SSEDescription?.Status === 'ENABLED'
                ? table.SSEDescription.KMSMasterKeyArn
                : undefined
              : r.KMSMasterKeyId;
            if (kmsKey !== undefined && kmsKey !== '') {
              entry['SSESpecification'] = { KMSMasterKeyId: kmsKey };
            }
            // A replica without its own class summary inherits the source
            // table's, and a table that never set one is STANDARD — the same
            // reading `update()`'s class passes take.
            entry['TableClass'] =
              (isLocal ? undefined : r.ReplicaTableClassSummary?.TableClass) ??
              table.TableClassSummary?.TableClass ??
              'STANDARD';
            const declaredReplica = properties
              ? localReplicaEntry(properties, r.RegionName)
              : undefined;
            const client = isLocal ? this.dynamoDBClient : this.getRegionalClient(r.RegionName);
            const regionLabel = r.RegionName;
            const replicaArn = isLocal
              ? table.TableArn
              : table.TableArn
                ? this.replicaArnForRegion(table.TableArn, r.RegionName)
                : undefined;

            // Per-replica sub-specs (PITR / Kinesis / ContributorInsights).
            // Best-effort: errors per region per sub-spec omit the offending
            // key — a permissions gap in one region must NOT abort the
            // whole drift read.
            const subs = await this.readReplicaSubSpecs(
              client,
              tableNameForSubs,
              regionLabel,
              declaredReplica
            );
            Object.assign(entry, subs);

            // Protection, and the stream arn the stream policy lives on: the
            // local table's are in hand; a cross-region replica's come from its
            // own region (best-effort — a failed read omits the members, and
            // `update()` never reads that absence as "unprotect").
            let protection: boolean | undefined;
            let disassociationProtection: boolean | undefined;
            let streamArn: string | undefined;
            if (isLocal) {
              protection = table.DeletionProtectionEnabled;
              disassociationProtection = table.DisassociationProtectionEnabled;
              streamArn = table.LatestStreamArn;
            } else {
              try {
                const regional = await client.send(
                  new DescribeTableCommand({ TableName: tableNameForSubs })
                );
                protection = regional.Table?.DeletionProtectionEnabled;
                disassociationProtection = regional.Table?.DisassociationProtectionEnabled;
                streamArn = regional.Table?.LatestStreamArn;
              } catch (err) {
                // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
                if (strictFor('Replicas') && !(err instanceof ResourceNotFoundException)) throw err;
                if (err instanceof ResourceNotFoundException) {
                  this.logger.debug(
                    safeMsg`Cross-region replica ${regionLabel} returned RNF on DescribeTable; omitting its protection and stream policy`
                  );
                } else {
                  this.logger.debug(
                    safeMsg`Could not read the ${regionLabel} replica of ${tableNameForSubs}: ${describeAwsFailure(err).detail}`
                  );
                }
              }
            }
            if (typeof protection === 'boolean') entry['DeletionProtectionEnabled'] = protection;
            // go-to-k/cdkd#5570: only where declared. An undeclared one is the
            // AWS default (on) that `update()` never sends, so emitting it
            // would read as drift on every table that leaves it alone.
            if (
              typeof disassociationProtection === 'boolean' &&
              declaredReplica?.[DISASSOCIATION_PROTECTION_KEY] !== undefined
            ) {
              entry[DISASSOCIATION_PROTECTION_KEY] = disassociationProtection;
            }
            await this.readReplicaPolicies(
              client,
              tableNameForSubs,
              regionLabel,
              replicaArn,
              streamArn,
              declaredReplica,
              afterOwnWrite,
              entry
            );

            // Per-replica Tags. CFn `GlobalTable` schema places Tags
            // inside `Replicas[]` (no top-level `Tags`), so they MUST be
            // surfaced here — not at the top level of `result`.
            if (replicaArn) {
              try {
                const tagsResp = await client.send(
                  new ListTagsOfResourceCommand({ ResourceArn: replicaArn })
                );
                entry['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
              } catch (tagErr) {
                // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
                if (strictFor('Replicas') && !(tagErr instanceof ResourceNotFoundException))
                  throw tagErr;
                if (tagErr instanceof ResourceNotFoundException) {
                  // Only the LOCAL replica's RNF can be a real "table gone"
                  // signal. A cross-region RNF more likely means the
                  // replica is in CREATING / DELETING — treat as transient
                  // and omit the Tags key for that replica.
                  if (isLocal) throw tagErr;
                  this.logger.debug(
                    `Cross-region replica ${regionLabel} returned RNF on ListTagsOfResource; omitting Tags`
                  );
                  entry['Tags'] = [];
                } else {
                  this.logger.warn(
                    `Could not fetch tags for DynamoDB GlobalTable ${tableNameForSubs} in ${regionLabel}: ${describeAwsFailure(tagErr).detail}`
                  );
                  entry['Tags'] = [];
                }
              }
            } else {
              entry['Tags'] = [];
            }

            // Per-replica ReadProvisionedThroughputSettings (Issue #395).
            // Type-discriminator-gated: only meaningful on PROVISIONED
            // tables. Probes application-autoscaling in the REPLICA'S
            // region — each replica registers its own scaling target +
            // policy in its own region, so the local-region client can
            // only see the local replica's settings.
            //
            // No flat `{ReadCapacityUnits: <n>}` fallback is emitted here:
            // `DescribeTable` returns ONE `ProvisionedThroughput` block for
            // the table, not one per replica, so cdkd cannot synthesize
            // per-replica flat read capacity from the local read. When
            // autoscaling owns the replica's read dimension the full
            // settings shape is surfaced; otherwise the key is omitted
            // entirely (drift will not fire on missing key, matching the
            // pre-#395 behavior for non-autoscaled replicas).
            if (billingMode === 'PROVISIONED') {
              const replicaAutoScalingClient = isLocal
                ? undefined
                : this.getRegionalAutoScalingClient(regionLabel);
              const readAutoScaling = await this.readAutoScalingSettings(
                tableNameForSubs,
                'dynamodb:table:ReadCapacityUnits',
                replicaAutoScalingClient
              );
              if (readAutoScaling) {
                entry['ReadProvisionedThroughputSettings'] = {
                  ReadCapacityAutoScalingSettings: readAutoScaling,
                };
              }
            }
            return entry;
          })
        )
      );
      result['Replicas'] = replicas;

      // GlobalSecondaryIndexes: a real CFn-shaped REVERSE MAP (issue #1420).
      //
      // The pre-fix code assigned the raw SDK `GlobalSecondaryIndexDescription[]`
      // straight into the CFn-shaped state key. Those descriptions carry
      // members CFn has no concept of (`IndexArn` / `IndexStatus` / `ItemCount`
      // / `IndexSizeBytes` / `Backfilling`) and — since #1387 — model
      // throughput COMPLETELY differently from the CFn side, so `cdkd drift`
      // compared a CFn-shaped baseline against an SDK-shaped snapshot and
      // reported PERMANENT phantom drift on any GlobalTable with a GSI.
      //
      // #1420 offered a stopgap (declare the whole subtree in
      // `getDriftUnknownPaths`) precisely because a correct map needed the
      // per-index auto-scaling read, which was blocked on the registration
      // gap. That gap shipped in #1419, so the correct map is buildable now
      // and the stopgap — which would have turned drift OFF for the entire
      // GSI subtree — is not taken.
      // Renamed off the module-scope `localReplicaEntry` it used to SHADOW
      // (issue [#2610] review): the local wore the shared predicate's name
      // while keeping the raw `.find` spelling that predicate exists to retire,
      // which is the most misleading combination available.
      //
      // It does NOT call the shared predicate, and that is the considered
      // answer rather than an omission: `replicas` here is the array this
      // method just BUILT from `Promise.all` a few lines up, not a
      // `props['Replicas']` bag off a template or a state record. The shared
      // predicate's whole job is to survive a bag that is not an array, a
      // condition that cannot arise for a locally constructed one -- so routing
      // this through it would trade a true guarantee for a weaker one and read
      // as if a bag were involved.
      const localReplica = replicas.find((r) => r['Region'] === currentRegion);
      if (table.GlobalSecondaryIndexes && table.GlobalSecondaryIndexes.length > 0) {
        const cfnIndexes: Array<Record<string, unknown>> = [];
        const replicaIndexEntries: Array<Record<string, unknown>> = [];
        for (const gsi of table.GlobalSecondaryIndexes) {
          if (!gsi.IndexName) continue;
          const entry: Record<string, unknown> = { IndexName: gsi.IndexName };
          if (gsi.KeySchema) entry['KeySchema'] = gsi.KeySchema;
          if (gsi.Projection) entry['Projection'] = gsi.Projection;
          // WarmThroughput reverse-mapped to the CFn shape (issue #1742). AWS
          // returns a `GlobalSecondaryIndexWarmThroughputDescription`, which
          // carries a `Status` member (`CREATING` / `UPDATING` / `ACTIVE`) the
          // CFn `WarmThroughputType` has no concept of — so a template that
          // DECLARES `WarmThroughput` drifted permanently against its own
          // declaration, on the AWS-managed member alone. Surface only the two
          // user-settable sub-fields, the same shape the sibling
          // `AWS::DynamoDB::Table` readback takes for the table-level member.
          //
          // Dropping `Status` would ordinarily strand every ALREADY-WRITTEN
          // `observedProperties` record (the #1760 lesson: the baseline still
          // carries the member the readback stopped emitting, and the
          // comparator compares `GlobalSecondaryIndexes` wholesale). It does
          // not here, because `canonicalizeDriftProperties` below strips the
          // WHOLE `WarmThroughput` member from BOTH comparison sides — an old
          // record and this readback converge on having no member at all. The
          // two halves ship together for that reason; do not land one alone.
          //
          // That convergence is BOUNDED to records written by a post-#1420
          // binary. An `observedProperties` bag written before the #1420 CFn
          // reverse map holds the raw `GlobalSecondaryIndexDescription[]`
          // (`IndexArn` / `IndexStatus` / `ItemCount` / `IndexSizeBytes` /
          // `Backfilling`), which a one-member strip cannot converge — those
          // records were already drifting on five other members and are
          // outside what this closes.
          if (gsi.WarmThroughput) {
            const warm: Record<string, unknown> = {};
            if (gsi.WarmThroughput.ReadUnitsPerSecond !== undefined) {
              warm['ReadUnitsPerSecond'] = gsi.WarmThroughput.ReadUnitsPerSecond;
            }
            if (gsi.WarmThroughput.WriteUnitsPerSecond !== undefined) {
              warm['WriteUnitsPerSecond'] = gsi.WarmThroughput.WriteUnitsPerSecond;
            }
            if (Object.keys(warm).length > 0) entry['WarmThroughput'] = warm;
          }

          const replicaEntry: Record<string, unknown> = { IndexName: gsi.IndexName };
          if (billingMode === 'PROVISIONED') {
            // Same two sub-shapes as the table-level write settings, and the
            // same reason they are mutually exclusive: when auto-scaling owns
            // the dimension the template carries the settings block, and
            // emitting the flat number instead would fire drift on every
            // clean run of an autoscaled table.
            const writeAutoScaling = await this.readAutoScalingSettings(
              tableNameForSubs,
              'dynamodb:index:WriteCapacityUnits',
              undefined,
              gsi.IndexName
            );
            if (writeAutoScaling) {
              entry['WriteProvisionedThroughputSettings'] = {
                WriteCapacityAutoScalingSettings: writeAutoScaling,
              };
            } else if (gsi.ProvisionedThroughput?.WriteCapacityUnits !== undefined) {
              entry['WriteProvisionedThroughputSettings'] = {
                WriteCapacityUnits: gsi.ProvisionedThroughput.WriteCapacityUnits,
              };
            }
            // READ capacity lives on the local REPLICA's index entry, not on
            // the top-level GSI — the shape #1387 established. Reverse-mapping
            // it to the top level would fire drift against every CDK-authored
            // template, which puts it on the replica.
            const readAutoScaling = await this.readAutoScalingSettings(
              tableNameForSubs,
              'dynamodb:index:ReadCapacityUnits',
              undefined,
              gsi.IndexName
            );
            if (readAutoScaling) {
              replicaEntry['ReadProvisionedThroughputSettings'] = {
                ReadCapacityAutoScalingSettings: readAutoScaling,
              };
            } else if (gsi.ProvisionedThroughput?.ReadCapacityUnits !== undefined) {
              replicaEntry['ReadProvisionedThroughputSettings'] = {
                ReadCapacityUnits: gsi.ProvisionedThroughput.ReadCapacityUnits,
              };
            }
          } else {
            // On-demand ceilings split the same write-here / read-on-the-
            // replica way. A CLEARED ceiling reads back as ABSENCE, never as
            // the `-1` reset sentinel (live-verified, #1423 / #1434), so an
            // omitted key is the correct "no ceiling" representation and no
            // `{}` placeholder is emitted: the template omits the block
            // entirely in that case too.
            if (gsi.OnDemandThroughput?.MaxWriteRequestUnits !== undefined) {
              entry['WriteOnDemandThroughputSettings'] = {
                MaxWriteRequestUnits: gsi.OnDemandThroughput.MaxWriteRequestUnits,
              };
            }
            if (gsi.OnDemandThroughput?.MaxReadRequestUnits !== undefined) {
              replicaEntry['ReadOnDemandThroughputSettings'] = {
                MaxReadRequestUnits: gsi.OnDemandThroughput.MaxReadRequestUnits,
              };
            }
          }
          cfnIndexes.push(entry);
          if (Object.keys(replicaEntry).length > 1) replicaIndexEntries.push(replicaEntry);
        }
        result['GlobalSecondaryIndexes'] = cfnIndexes;
        // Only attach the replica-side half when there is one: an empty array
        // would read as "this replica overrides nothing", which is true but
        // is not what a template omitting the key says, and the comparator
        // only descends into keys the state baseline already has anyway.
        if (localReplica && replicaIndexEntries.length > 0) {
          localReplica['GlobalSecondaryIndexes'] = replicaIndexEntries;
        }
      }

      // Table-level on-demand ceilings. The WRITE half reverse-maps to the
      // top-level `WriteOnDemandThroughputSettings`; the READ half belongs on
      // the LOCAL REPLICA as `ReadOnDemandThroughputSettings` (issue #1436 —
      // `readCurrentState` had no read counterpart at all, so drift was blind
      // to it in exactly the same way `create()` / `update()` were). Always-
      // emit `{}` placeholder on the write side when on-demand has no
      // override so a console-side ADD on a previously-default table fires
      // drift (PR #145 pattern).
      if (table.OnDemandThroughput?.MaxWriteRequestUnits !== undefined) {
        result['WriteOnDemandThroughputSettings'] = {
          MaxWriteRequestUnits: table.OnDemandThroughput.MaxWriteRequestUnits,
        };
      } else {
        result['WriteOnDemandThroughputSettings'] = {};
      }
      if (localReplica && table.OnDemandThroughput?.MaxReadRequestUnits !== undefined) {
        localReplica['ReadOnDemandThroughputSettings'] = {
          MaxReadRequestUnits: table.OnDemandThroughput.MaxReadRequestUnits,
        };
      }

      // WriteProvisionedThroughputSettings — type-discriminator-gated on
      // `BillingMode === 'PROVISIONED'` (memory rule
      // `feedback_always_emit_check_type_discriminator.md`). Within the
      // PROVISIONED branch there is a SECOND discriminator: whether
      // application-autoscaling owns the write dimension. The two valid
      // shapes are mutually exclusive:
      //   - flat:        { WriteCapacityUnits: <n> }              (no autoscaling)
      //   - autoscaled:  { WriteCapacityAutoScalingSettings: ... } (Issue #395)
      // PAY_PER_REQUEST tables emit `{}` so a template that adds the key
      // after a BillingMode flip registers as drift, without committing
      // to either sub-shape on an on-demand table.
      if (billingMode === 'PROVISIONED') {
        const autoScaling = await this.readAutoScalingSettings(
          tableNameForSubs,
          'dynamodb:table:WriteCapacityUnits'
        );
        if (autoScaling) {
          result['WriteProvisionedThroughputSettings'] = {
            WriteCapacityAutoScalingSettings: autoScaling,
          };
        } else {
          const writeCapacity = table.ProvisionedThroughput?.WriteCapacityUnits;
          if (writeCapacity !== undefined) {
            result['WriteProvisionedThroughputSettings'] = {
              WriteCapacityUnits: writeCapacity,
            };
          } else {
            result['WriteProvisionedThroughputSettings'] = {};
          }
        }
      } else {
        // PAY_PER_REQUEST: type-discriminator-gated empty placeholder so a
        // template that adds `WriteProvisionedThroughputSettings` later
        // (after a BillingMode flip) registers as drift; neither sub-shape
        // is valid on on-demand tables.
        result['WriteProvisionedThroughputSettings'] = {};
      }

      // go-to-k/cdkd#2762: VectorIndexes in their CFn shape, only when AWS
      // reports any. A replica inherits the deploy region's list.
      const liveVectorIndexes = readbackVectorIndexes(table.VectorIndexes);
      if (liveVectorIndexes !== undefined) result['VectorIndexes'] = liveVectorIndexes;
      // go-to-k/cdkd#2762: AWS reports a warm throughput for EVERY table, so
      // only a declared block is read back, and only its declared members.
      const declaredWarm = coerceWarmThroughput(properties?.['WarmThroughput']).spec;
      if (declaredWarm && table.WarmThroughput) {
        const warm: Record<string, unknown> = {};
        for (const member of WARM_THROUGHPUT_MEMBERS) {
          const value = table.WarmThroughput[member];
          const declared = declaredWarm[member];
          if (declared === undefined || value === undefined) continue;
          // While UPDATING, AWS still reports the old value (measured on a
          // two-replica table, us-east-1 + us-east-2, 2026-11-01: minutes after
          // a raise), and the post-deploy baseline is read in that window: it
          // froze the old value, and the next drift reported the raise. The
          // value only rises, so the declared one is where it is moving.
          warm[member] =
            table.WarmThroughput.Status === 'UPDATING' ? Math.max(value, declared) : value;
        }
        if (Object.keys(warm).length > 0) result['WarmThroughput'] = warm;
      }
      // go-to-k/cdkd#2762: the table-level read settings, where the record
      // keeps them: DynamoDB holds one value, which the local replica's entry
      // also reports, and the comparison descends only into a recorded key.
      // A PROVISIONED table created without a mode reports no billing summary.
      if (
        properties?.[TABLE_READ_ON_DEMAND_KEY] !== undefined &&
        table.OnDemandThroughput?.MaxReadRequestUnits !== undefined
      ) {
        result[TABLE_READ_ON_DEMAND_KEY] = {
          MaxReadRequestUnits: table.OnDemandThroughput.MaxReadRequestUnits,
        };
      }
      if (
        properties?.[TABLE_READ_PROVISIONED_KEY] !== undefined &&
        billingMode !== 'PAY_PER_REQUEST' &&
        table.ProvisionedThroughput?.ReadCapacityUnits !== undefined
      ) {
        result[TABLE_READ_PROVISIONED_KEY] = {
          ReadCapacityUnits: table.ProvisionedThroughput.ReadCapacityUnits,
        };
      }

      // TimeToLiveSpecification: separate API call. Race-tolerant — when
      // AWS reports a transient `UPDATING` / `DISABLING` status, omit
      // the key rather than surface a transient state as drift.
      try {
        const ttlResp = await this.dynamoDBClient.send(
          new DescribeTimeToLiveCommand({ TableName: tableNameForSubs })
        );
        const ttlDesc = ttlResp.TimeToLiveDescription;
        const ttlStatus = ttlDesc?.TimeToLiveStatus;
        if (ttlStatus === 'ENABLED' && ttlDesc?.AttributeName) {
          result['TimeToLiveSpecification'] = {
            AttributeName: ttlDesc.AttributeName,
            Enabled: true,
          };
        } else if (ttlStatus === 'DISABLED') {
          // Disabled has no AttributeName; only surface if state held one
          // — the comparator will diff against state. For first-write
          // observed baselines, omit (matches "no TTL configured").
          // We intentionally do NOT emit a `{Enabled: false}` placeholder
          // because CFn rejects TimeToLiveSpecification without an
          // AttributeName.
        }
        // ENABLING / DISABLING: transient — omit so drift doesn't fire
        // on a momentary state.
      } catch (ttlErr) {
        // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
        if (strictFor('TimeToLiveSpecification')) throw ttlErr;
        this.logger.debug(
          `Could not read TimeToLive for ${tableNameForSubs}: ${describeAwsFailure(ttlErr).detail}`
        );
      }

      // Note: `Tags` are emitted INSIDE the local `Replicas[]` entry
      // above (the CFn `GlobalTable` schema has no top-level `Tags`).

      return result;
    } catch (err) {
      // Also reached by the LOCAL replica's ListTagsOfResource RNF rethrow above.
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
  }

  /**
   * Read per-replica sub-specifications against the given `DynamoDBClient`
   * (which may be the local client or a per-region client returned by
   * `getRegionalClient`):
   *  - `ContributorInsightsSpecification` via `DescribeContributorInsights`
   *    (table-level; GSI overrides are NOT surfaced in v1 — they would
   *    require one call per GSI and a different CFn nesting under the
   *    `Replicas[].GlobalSecondaryIndexes[]` shape).
   *  - `PointInTimeRecoverySpecification` via `DescribeContinuousBackups`.
   *  - `KinesisStreamSpecification` via
   *    `DescribeKinesisStreamingDestination` (filtered to the local
   *    region's destination when AWS reports more than one).
   *
   * Each call is best-effort: errors omit the offending key rather than
   * fail the whole drift read.
   *
   * Issue #389 lifted the LOCAL-only limitation by parameterizing the
   * client — the same reverse-mapping logic runs against any region's
   * client.
   */
  private async readReplicaSubSpecs(
    client: DynamoDBClient,
    tableName: string,
    regionLabel: string,
    declaredReplica: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};

    // ContributorInsights (table-level only in v1).
    try {
      const ci = await client.send(
        new DescribeContributorInsightsCommand({ TableName: tableName })
      );
      // go-to-k/cdkd#5381: `ENABLING` reads as enabled (the deploy that turned
      // insights on captures its baseline moments later), and a DECLARED
      // `Mode` is read back.
      const block = reverseMapReplicaContributorInsights(
        ci.ContributorInsightsStatus,
        ci.ContributorInsightsMode,
        declaredReplica?.['ContributorInsightsSpecification']
      );
      if (block !== undefined) out['ContributorInsightsSpecification'] = block;
    } catch (err) {
      // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
      // A replica region's not-found omits the member, strict or not: the replica
      // is being created or removed, which `unsettledInTransition` reports.
      if (strictFor('Replicas') && !(err instanceof ResourceNotFoundException)) throw err;
      this.logger.debug(
        `Could not read ContributorInsights for ${tableName} in ${regionLabel}: ${describeAwsFailure(err).detail}`
      );
    }

    // PointInTimeRecovery via DescribeContinuousBackups.
    try {
      const pitr = await client.send(
        new DescribeContinuousBackupsCommand({ TableName: tableName })
      );
      const description = pitr.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
      // go-to-k/cdkd#5381: `RecoveryPeriodInDays` is read back, so a
      // `drift --revert` re-sends the recorded period instead of none (which
      // `UpdateContinuousBackups` reads as DynamoDB's default), and a
      // transient status reads as its target.
      const block = reverseMapReplicaPitr(
        description?.PointInTimeRecoveryStatus,
        description?.RecoveryPeriodInDays,
        declaredReplica?.['PointInTimeRecoverySpecification']
      );
      if (block !== undefined) out['PointInTimeRecoverySpecification'] = block;
    } catch (err) {
      // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
      // A replica region's not-found omits the member, strict or not: the replica
      // is being created or removed, which `unsettledInTransition` reports.
      if (strictFor('Replicas') && !(err instanceof ResourceNotFoundException)) throw err;
      this.logger.debug(
        `Could not read PointInTimeRecovery for ${tableName} in ${regionLabel}: ${describeAwsFailure(err).detail}`
      );
    }

    // Kinesis streaming destination — pick the first ACTIVE destination
    // (CFn's per-replica shape only carries one StreamArn).
    try {
      const ks = await client.send(
        new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
      );
      const destinations = ks.KinesisDataStreamDestinations ?? [];
      const active = destinations.find(
        (d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING'
      );
      if (active?.StreamArn) {
        const ksOut: Record<string, unknown> = { StreamArn: active.StreamArn };
        if (active.ApproximateCreationDateTimePrecision !== undefined) {
          ksOut['ApproximateCreationDateTimePrecision'] =
            active.ApproximateCreationDateTimePrecision;
        }
        out['KinesisStreamSpecification'] = ksOut;
      }
    } catch (err) {
      // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
      // A replica region's not-found omits the member, strict or not: the replica
      // is being created or removed, which `unsettledInTransition` reports.
      if (strictFor('Replicas') && !(err instanceof ResourceNotFoundException)) throw err;
      this.logger.debug(
        `Could not read KinesisStreamingDestination for ${tableName} in ${regionLabel}: ${describeAwsFailure(err).detail}`
      );
    }

    return out;
  }

  /**
   * How long a resource-policy read that does NOT match the declaration is
   * re-asked before it is believed: one entry per extra attempt.
   */
  protected policyRereadDelaysMs: readonly number[] = [500, 1000, 2000];

  /**
   * Read a replica's `ResourcePolicy` (on its table arn) and
   * `ReplicaStreamSpecification.ResourcePolicy` (on its stream arn) into
   * `entry` (go-to-k/cdkd#5381), in the CFn `{ PolicyDocument }` shape and the
   * declared spelling of the document.
   *
   * Each is GATED on the replica's DECLARED entry naming a usable policy — the
   * reader the write plan runs. That keeps an undeclared policy out of a
   * `Replicas` entry drift compares whole, and spends no call on a replica
   * that declares none, as the sibling `AWS::DynamoDB::Table` read does.
   *
   * `GetResourcePolicy` is eventually consistent, and the deploy captures its
   * baseline right after the put: on that capture (`afterOwnWrite`) an answer
   * that differs from the declaration is re-asked a few times before it is
   * believed. Any other read takes the first answer. `afterOwnWrite`: a policy
   * still ABSENT then, or a read that failed transiently, keeps the declared
   * member rather than freeze an absence the settled replica never shows.
   * Every other read believes its answer, so a policy removed out of band is
   * drift. Policy text is never logged.
   */
  private async readReplicaPolicies(
    client: DynamoDBClient,
    tableName: string,
    regionLabel: string,
    tableArn: string | undefined,
    streamArn: string | undefined,
    declaredReplica: Record<string, unknown> | undefined,
    afterOwnWrite: boolean,
    entry: Record<string, unknown>
  ): Promise<void> {
    if (declaredReplica === undefined) return;
    const readOne = async (
      what: string,
      arn: string | undefined,
      container: unknown
    ): Promise<Record<string, unknown> | undefined> => {
      if (arn === undefined || arn === '') return undefined;
      const declaredMember = (): Record<string, unknown> | undefined =>
        declaredPolicyMember(container);
      let last: string | undefined;
      const read = async (): Promise<string | undefined> => {
        try {
          const response = await client.send(new GetResourcePolicyCommand({ ResourceArn: arn }));
          last = response.Policy;
        } catch (err) {
          if (!(err instanceof PolicyNotFoundException)) throw err;
          last = undefined;
        }
        return last;
      };
      try {
        let live = await read();
        // Only the capture right after cdkd's own write can be lagging behind
        // it; a drift read takes the first answer, so a real out-of-band
        // change costs no re-reads.
        for (const delayMs of afterOwnWrite ? this.policyRereadDelaysMs : []) {
          if (policyMatchesDeclared(live, container)) break;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          live = await read();
        }
        if (afterOwnWrite && (live === undefined || live === '')) {
          this.logger.debug(
            safeMsg`Kept the declared ${what} of the ${regionLabel} replica of ${tableName} in the baseline captured after its write: the read still found no policy`
          );
          return declaredMember();
        }
        return reverseMapPolicyMember(live, container);
      } catch (err) {
        // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
        // A replica region's not-found omits the member, strict or not: the replica
        // is being created or removed, which `unsettledInTransition` reports.
        if (strictFor('Replicas') && !(err instanceof ResourceNotFoundException)) throw err;
        this.logger.debug(
          safeMsg`Could not read the ${what} of the ${regionLabel} replica of ${tableName}: ${describeAwsFailure(err).detail}`
        );
        if (afterOwnWrite && last !== undefined && last !== '') {
          return reverseMapPolicyMember(last, container);
        }
        if (
          afterOwnWrite &&
          (isThrottlingError(err) ||
            isTransientServerError(err) ||
            isAmbiguousOutcomeError(err) ||
            err instanceof ResourceNotFoundException)
        ) {
          return declaredMember();
        }
        return undefined;
      }
    };
    if (readTablePolicy(declaredReplica).kind === 'usable') {
      const member = await readOne('ResourcePolicy', tableArn, declaredReplica);
      if (member !== undefined) entry['ResourcePolicy'] = member;
    }
    if (readStreamPolicy(declaredReplica).kind === 'usable') {
      const member = await readOne(
        'stream ResourcePolicy',
        streamArn,
        declaredReplica['ReplicaStreamSpecification']
      );
      if (member !== undefined) entry['ReplicaStreamSpecification'] = { ResourcePolicy: member };
    }
  }

  /**
   * Reverse-map application-autoscaling state for the given DynamoDB table
   * dimension into the CFn `*CapacityAutoScalingSettings` shape (Issue
   * #395). Used for BOTH the table-level write dimension
   * (`dynamodb:table:WriteCapacityUnits`) and the per-replica read
   * dimension (`dynamodb:table:ReadCapacityUnits`); the CFn shape is
   * symmetric.
   *
   * Returns shape (CFn-canonical PascalCase keys, verified via `cdk synth`
   * on a real `TableV2` with `Capacity.autoscaled(...)` on 2026-05-16 —
   * see PR notes for the probe transcript):
   *
   * ```
   * {
   *   MinCapacity: number;
   *   MaxCapacity: number;
   *   TargetTrackingScalingPolicyConfiguration: {
   *     TargetValue: number;
   *     DisableScaleIn?: boolean;
   *     ScaleInCooldown?: number;
   *     ScaleOutCooldown?: number;
   *   };
   * }
   * ```
   *
   * `SeedCapacity` is intentionally NOT round-tripped — it is a CFn
   * create-only field with no corresponding application-autoscaling
   * surface (AWS does not retain the initial seed value once the
   * scaling target is registered).
   *
   * Resolution order:
   *  1. `DescribeScalableTargets` → recover `MinCapacity` / `MaxCapacity`
   *     for the matching `ScalableDimension`. Returns `null` when no
   *     target is registered (= no autoscaling in play for this
   *     dimension — caller falls back to the flat capacity surface).
   *  2. `DescribeScalingPolicies` → find the `TargetTrackingScaling`
   *     policy (filter out `StepScaling` / `PredictiveScaling` — CFn's
   *     shape only carries the target-tracking variant). Returns `null`
   *     when no `TargetTrackingScaling` policy is present (a scaling
   *     target without a target-tracking policy is not cdkd-managed
   *     drift territory; surface the flat capacity instead).
   *
   * Best-effort: any error (permissions gap, throttle, network) returns
   * `null` and the caller falls back to the flat-capacity branch. Logged
   * at debug so a real permissions misconfiguration is still visible
   * under `--verbose`.
   *
   * @param tableName DynamoDB table name (the `physicalId`).
   * @param scalableDimension Any of the four dimensions a GlobalTable can
   *   register — the two `dynamodb:table:*` ones and, since issue #1420's
   *   GSI reverse map, the two `dynamodb:index:*` ones.
   * @param client Pre-built region-scoped autoscaling client. Defaults to
   *   a fresh client in the local region — pass an explicit client when
   *   reading from a cross-region replica.
   * @param indexName Required for a `dynamodb:index:*` dimension; the
   *   `ResourceId` is built through the shared {@link autoScalingResourceId}
   *   so the read cannot spell it differently from the register / deregister
   *   calls.
   */
  private async readAutoScalingSettings(
    tableName: string,
    scalableDimension: DynamoDBScalableDimension,
    client?: ApplicationAutoScalingClient,
    indexName?: string
  ): Promise<Record<string, unknown> | null> {
    const resourceId = autoScalingResourceId(tableName, indexName);
    try {
      const asClient =
        client ??
        new ApplicationAutoScalingClient({
          ...ambientClientDefaults(),
          region: (await this.dynamoDBClient.config.region()) ?? '',
        });

      // 1. Probe ScalableTargets for Min/Max.
      const targetsResp = await asClient.send(
        new DescribeScalableTargetsCommand({
          ServiceNamespace: 'dynamodb',
          ResourceIds: [resourceId],
          ScalableDimension: scalableDimension,
        })
      );
      const targets = targetsResp.ScalableTargets ?? [];
      if (targets.length === 0) return null;
      const target = targets[0]!;
      if (target.MinCapacity === undefined || target.MaxCapacity === undefined) {
        return null;
      }

      // 2. Probe ScalingPolicies for the TargetTrackingScaling policy.
      const policiesResp = await asClient.send(
        new DescribeScalingPoliciesCommand({
          ServiceNamespace: 'dynamodb',
          ResourceId: resourceId,
          ScalableDimension: scalableDimension,
        })
      );
      const policies = policiesResp.ScalingPolicies ?? [];
      const targetTracking = policies.find((p) => p.PolicyType === 'TargetTrackingScaling');
      if (!targetTracking) return null;
      const cfg = targetTracking.TargetTrackingScalingPolicyConfiguration;
      if (!cfg || cfg.TargetValue === undefined) return null;

      const tttConfig: Record<string, unknown> = { TargetValue: cfg.TargetValue };
      if (cfg.DisableScaleIn !== undefined) {
        tttConfig['DisableScaleIn'] = cfg.DisableScaleIn;
      }
      if (cfg.ScaleInCooldown !== undefined) {
        tttConfig['ScaleInCooldown'] = cfg.ScaleInCooldown;
      }
      if (cfg.ScaleOutCooldown !== undefined) {
        tttConfig['ScaleOutCooldown'] = cfg.ScaleOutCooldown;
      }

      return {
        MinCapacity: target.MinCapacity,
        MaxCapacity: target.MaxCapacity,
        TargetTrackingScalingPolicyConfiguration: tttConfig,
      };
    } catch (err) {
      // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
      if (
        strictFor(
          indexName !== undefined
            ? 'GlobalSecondaryIndexes'
            : scalableDimension.includes('Write')
              ? 'WriteProvisionedThroughputSettings'
              : 'Replicas'
        )
      )
        throw err;
      this.logger.debug(
        `Could not read application-autoscaling settings for ${resourceId} (${scalableDimension}): ${describeAwsFailure(err).detail}`
      );
      return null;
    }
  }

  /**
   * State property paths cdkd's GlobalTable readCurrentState cannot (yet)
   * reverse-map. The drift comparator skips these so a templated value
   * doesn't fire guaranteed false drift on every clean run.
   *
   * Issue #389 + #395 emptied this list:
   *  - `WriteProvisionedThroughputSettings` reverse-maps both the flat
   *    `{WriteCapacityUnits}` shape (no autoscaling) AND the full
   *    `{WriteCapacityAutoScalingSettings}` shape (autoscaling-managed;
   *    recovered from `DescribeScalableTargets` +
   *    `DescribeScalingPolicies`). PAY_PER_REQUEST tables emit `{}`.
   *  - Per-replica `ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings`
   *    reverse-maps from a region-scoped application-autoscaling client
   *    for the `dynamodb:table:ReadCapacityUnits` dimension. Non-
   *    autoscaled replicas omit the key (no per-replica flat read
   *    capacity available in `DescribeTable`).
   *  - `WriteOnDemandThroughputSettings` is reverse-mapped from
   *    `Table.OnDemandThroughput.MaxWriteRequestUnits`. Always-emit
   *    `{}` placeholder when AWS reports no override.
   *  - `TimeToLiveSpecification` is reverse-mapped via
   *    `DescribeTimeToLive` in `readCurrentState`.
   *
   * Issue #1420 + #1436 kept it empty rather than growing it:
   *  - `GlobalSecondaryIndexes` is a real CFn-shaped reverse map (SDK-only
   *    members stripped, write throughput at the top level, read throughput
   *    on the local replica's index entry, auto-scaling recovered per index
   *    via `dynamodb:index:*`). The alternative #1420 offered — declaring the
   *    subtree here — would have turned drift OFF for every GSI, which is a
   *    strictly worse trade than the phantom drift it removes.
   *  - The table-level on-demand READ ceiling is reverse-mapped onto
   *    `Replicas[local].ReadOnDemandThroughputSettings`, the CFn location it
   *    is authored at, and onto the top-level block when the record keeps it
   *    there (go-to-k/cdkd#2762).
   *
   * go-to-k/cdkd#2762 added the members no AWS read answers:
   *  - `TableType` is no API member. CloudFormation validates it and sends
   *    nothing (`GlobalTableReplica` on a one-replica table reads back
   *    `Regional`, measured us-east-1, 2026-11-01).
   *  - `ReadProvisionedThroughputSettings` on an on-demand table, which
   *    CloudFormation accepts and ignores (measured, same day).
   *  - A `WarmThroughput` that was not sent: AWS's value is its own, and only a
   *    usable declaration is read back.
   */
  getDriftUnknownPaths(_resourceType: string, properties?: Record<string, unknown>): string[] {
    const paths = ['TableType'];
    // An absent or empty bag says nothing recorded, not that a key is absent
    // (the `getDriftUnknownPaths` contract): compare by default.
    if (properties === undefined || Object.keys(properties).length === 0) return paths;
    if (properties['BillingMode'] !== 'PROVISIONED') paths.push(TABLE_READ_PROVISIONED_KEY);
    if (!coerceWarmThroughput(properties['WarmThroughput']).spec) paths.push('WarmThroughput');
    return paths;
  }

  /**
   * `AttributeDefinitions` is an unordered SET, and the comparator compares
   * arrays positionally (issue #1742).
   *
   * `DescribeTable` returns the definitions in an order matching neither the
   * request nor alphabetical — measured us-east-1 2026-08-13 on the
   * `rollback-replay-effective-props` fixture, where a table declaring
   * `[pk, gsipk]` read back as `[gsipk, pk]` — so an UNTOUCHED table drifted
   * forever. Sorting cannot hide a real change here because the list is a
   * genuine set: members are keyed by `AttributeName`, so adding, removing or
   * retyping one still changes the canonicalized form.
   *
   * Reachable whenever the drift baseline is `properties` rather than
   * `observedProperties` — i.e. after any reverse-replacement rollback, which
   * `rollback-executor.ts` strips `observedProperties` on. That is also why it
   * went unseen: on the ordinary path both sides come from the same readback.
   *
   * `KeySchema` is deliberately NOT declared, at the table level or per index:
   * it is order-SIGNIFICANT (HASH before RANGE), so sorting it would silently
   * hide a real key change — the failure direction this file's sibling rules
   * call the worse one.
   *
   * `Replicas` is a set too (issue #3573): the registry schema declares it
   * `insertionOrder: false` (measured via `DescribeType`, us-east-1,
   * 2026-09-25), and each entry is keyed by `Region`. Templates disagree on
   * where the deploy region goes -- CDK's `TableV2` renders it LAST, a
   * hand-written `CfnGlobalTable` often FIRST -- while the readback appends it
   * after the replicas `DescribeTable` lists, so one of the two always
   * compared positionally unequal on a `properties` baseline. Declared
   * LEAF-ONLY (`[]`) so the arrays inside each entry keep their own rules.
   *
   * `VectorIndexes` (go-to-k/cdkd#2762) is a SUBTREE entry: keyed by
   * `IndexName`, with no order-significant list inside an element, as on
   * `AWS::DynamoDB::Table`.
   */
  getDriftUnorderedPaths(_resourceType: string): string[] {
    return ['AttributeDefinitions', 'Replicas[]', 'VectorIndexes'];
  }

  /**
   * Strip the AWS-computed per-index `WarmThroughput` from BOTH drift
   * comparison sides (issue #1742 defect 2, on the #1784 seam).
   *
   * `DescribeTable` reports a `WarmThroughput` for EVERY index whether or not
   * the template asked for one — a default `{ReadUnitsPerSecond: 12000,
   * WriteUnitsPerSecond: 4000, Status: 'ACTIVE'}`, measured us-east-1
   * 2026-08-13 on the `rollback-replay-effective-props` fixture — so on a
   * `properties`-only baseline (what a reverse-replacement rollback leaves
   * behind, since `rollback-executor.ts` strips `observedProperties`) the
   * member is a permanent one-sided difference: `cdkd drift` reports the table
   * forever and `--revert` re-issues calls for it.
   *
   * Why this mechanism and not the two cheaper ones:
   *
   * - `getDriftUnknownPaths` (the #1760 answer for the sibling type's
   *   TOP-LEVEL member) cannot express it. `calculateResourceDrift` compares
   *   arrays wholesale, so `isIgnoredPath` is never asked about a path that
   *   crosses one; the only expressible suppression is the WHOLE
   *   `GlobalSecondaryIndexes` subtree, i.e. never detecting an index add /
   *   remove / capacity change again — the #1420 stopgap already refused.
   * - Gating the READBACK emission on the desired side (this issue's own
   *   second candidate answer) removes the phantom for the `properties`
   *   baseline and CREATES one for the far larger `observedProperties`
   *   population: every bag already in S3 was written by a binary that emitted
   *   the computed member, so the first `cdkd drift` after upgrading compares
   *   a baseline that HAS it against a readback that does not, and reports the
   *   whole array on an untouched table. It does not self-heal — the observed
   *   capture only runs on CREATE / UPDATE. That attempt was implemented,
   *   reviewed and REVERTED; do not re-propose it.
   *
   * Stripping from BOTH sides is what converges the two populations at once: a
   * stale observed record and a fresh readback both lose the member, and a
   * `properties` baseline that never had it now faces an AWS side without it.
   *
   * ACCEPTED COST, stated because it is a real loss: a template that DECLARES
   * a per-index `WarmThroughput` no longer has changes to it REPORTED by
   * `cdkd drift`. The value is still SENT (`toSdkGlobalSecondaryIndexes`
   * forwards it on create and on a new index), so this is a detection gap, not
   * a delivery one, and it is bounded by what cdkd could do about a difference
   * anyway: warm throughput only ever GROWS on the AWS side and cannot be
   * lowered, so `--revert` would issue a decrease AWS rejects — the residual
   * issue #1768 records for the sibling type's declared arm. A per-index
   * declared-gate is not expressible here in any case: this hook sees ONE bag
   * with no `side` argument and no reference to the desired side, which is the
   * symmetry the #1784 contract requires and the reason one-sided
   * normalization is refused.
   *
   * Scope is a CLOSED table rather than a walk for any key named
   * `WarmThroughput`: `Replicas[].GlobalSecondaryIndexes[]` entries carry only
   * the read-half throughput blocks (no `WarmThroughput` is emitted or
   * accepted there), and a blanket strip would remove a member from a path
   * nobody measured. The table is a FLAT list of `{listKey, member}` pairs —
   * the type is hardcoded one line below, not a key of it — and nothing
   * mechanically fences it against `readCurrentState`: a future per-replica
   * `WarmThroughput` emission would desync silently, so a member added to the
   * readback needs a row added here in the same change.
   *
   * The `resourceType` guard is kept but is UNREACHABLE, and the earlier
   * claim that it followed the #1784 CC-API-fallback caveat was WRONG — that
   * caveat is about the BAG SHAPE when a type has no `readCurrentState`, and
   * never produces a foreign `resourceType`. `drift.ts` resolves the provider
   * by `(resourceType, provisionedBy)` and then passes that SAME type back in,
   * and this provider is registered for exactly one type, so the `!==` arm
   * cannot fire. It stays as a cheap shape guard for a future second
   * registration, not because anything routes a foreign type here.
   *
   * UNCOVERED POPULATION, stated because the fix does NOT reach it: a
   * cc-api-routed GlobalTable gets neither half. A record created while
   * top-level `WarmThroughput` was a `silentDrop` property (before
   * go-to-k/cdkd#2762), or a template declaring a property that still is, sits
   * on the STICKY Cloud Control route — `drift.ts` then resolves `provider` to
   * `CloudControlProvider`, this hook is never invoked, and the AWS side comes
   * from CC's `GetResource`. So the `properties`-only-baseline phantom drift
   * this closes survives there.
   *
   * Pure, non-mutating, and identity-returning when nothing applies: the input
   * bag is the caller's state record / readback, an unaffected table pays
   * nothing, and only the index entries that actually carry the member are
   * rebuilt.
   */
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::DynamoDB::GlobalTable') return properties;
    let result = properties;
    for (const { listKey, member } of DRIFT_STRIPPED_INDEX_MEMBERS) {
      const list = result[listKey];
      if (!Array.isArray(list)) continue;
      let stripped = false;
      const canonical = list.map((element) => {
        const entry = asRecord(element);
        // A non-object entry (an unresolved intrinsic, a malformed record) is
        // passed through untouched — the comparator can still report it, which
        // is the honest answer for a value cdkd could not read.
        if (!entry || !(member in entry)) return element;
        stripped = true;
        const copy = { ...entry };
        delete copy[member];
        return copy;
      });
      if (stripped) result = { ...result, [listKey]: canonical };
    }
    return result;
  }

  /**
   * Diff-side twin of the `needsStream` record (issue #1723): a multi-replica
   * template declaring no `StreamSpecification` compares as declaring the
   * stream `create()` enables for it. Applied to BOTH sides, so a record
   * written before #1723 (no stream key) and one written after (stream key)
   * both diff NO_CHANGE against the unchanged template — and against a
   * template that later declares that same stream.
   *
   * Shares {@link replicationImpliedStreamSpecification} with `create()` and
   * `update()`. It only ADDS a key, so `DiffCalculator`'s "declared properties
   * are ignored" warning (which fires on a DROPPED key) stays silent.
   *
   * Bound: `DiffCalculator` folds the CURRENT side only for an SDK-routed
   * record, so on a Cloud Control record this fold would be one-sided.
   * Cloud Control never CREATES that population (CloudFormation refuses a
   * multi-replica table with no `StreamSpecification`, and a declared
   * `MultiRegionConsistency` stops the helper), but an SDK-created record can
   * MOVE there: a later template adding a property this provider does not
   * handle re-routes the update to Cloud Control with this record as the
   * previous side, and its patch then asks to remove the recorded stream.
   * With the replicas unchanged AWS refuses that on a multi-replica table and
   * the deploy fails; if the same template also drops to ONE replica, the
   * removal is allowed and the patch may disable the stream. Accepted: the
   * template that created the record (multi-replica, no `StreamSpecification`)
   * is one CloudFormation rejects, so the AWS CDK CLI never reaches this state.
   */
  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::DynamoDB::GlobalTable') return properties;
    const impliedStream = replicationImpliedStreamSpecification(properties);
    if (!impliedStream) return properties;
    return { ...properties, [STREAM_SPECIFICATION_KEY]: impliedStream };
  }

  /**
   * Complete a LEGACY drift baseline's missing local replica (issue #3573),
   * then bring a baseline the pre-#5381 read-back wrote to the current replica
   * shape ({@link canonicalizePre5381ReplicaBaseline}; go-to-k/cdkd#5381).
   * The rest of this comment is the #3573 half.
   *
   * Before #3573, `readCurrentState` left the deploy-region entry out of
   * `Replicas` on a multi-region table, so every `observedProperties` record a
   * deploy captured then lacks it, while the readback now carries it. Compared
   * as is, the first `cdkd drift` after upgrading would report `Replicas` on
   * every untouched multi-region GlobalTable.
   *
   * The rule (maintainer decision on the issue: absorb at comparison time):
   * when the BASELINE's `Replicas` has no entry for the local region, copy the
   * READBACK's local entry into the baseline. The AWS side is untouched. State
   * is not rewritten; the next deploy captures the new shape.
   *
   * Completing the baseline, rather than dropping the entry from the AWS side,
   * is what keeps the two write paths that consume these bags safe:
   * - `drift --revert` runs this on its DESIRED bag too (the legacy record),
   *   so the local entry it sends equals the live one. Sent without it,
   *   `update()` would read the local replica's tags as removed and untag
   *   the table.
   * - `--accept` persists the reported `awsValue`, which comes from the
   *   untouched AWS side, so an accepted `Replicas` change heals the record to
   *   the current shape instead of freezing the legacy one.
   *
   * Why it hides nothing that was visible: a current-shape baseline always
   * has the local entry, so it is compared in full; and the local replica is
   * the table itself, so its ABSENCE from a legacy baseline cannot be a real
   * removal -- the one thing this suppresses is the local entry's own members,
   * which that baseline never recorded. A replica added out of band in ANOTHER
   * region still differs. It is per-side-inexpressible, hence the pair hook:
   * {@link canonicalizeDriftProperties} sees one bag and cannot tell a legacy
   * baseline from a current one.
   *
   * "Local" is the region this provider's own client resolves -- the same
   * expression `readCurrentState` keys its local entry on -- so the two cannot
   * disagree about which entry is local. A baseline or AWS side whose
   * `Replicas` is not an array, or an unresolved region, is left untouched.
   */
  async canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    if (resourceType !== 'AWS::DynamoDB::GlobalTable') return { baseline, aws };
    const localRegion = (await this.dynamoDBClient.config.region()) ?? '';
    const completed = completeLegacyLocalReplica(baseline, aws, localRegion);
    // go-to-k/cdkd#5381: a baseline the pre-#5381 read-back wrote (top-level
    // class / protection, a flat replica key, none of the members #5381 reads)
    // is brought to the current shape — see the helper. Identity otherwise.
    const converted = canonicalizePre5381ReplicaBaseline(
      completed,
      aws,
      localRegion,
      completed !== baseline
    );
    return converted === baseline ? { baseline, aws } : { baseline: converted, aws };
  }

  /**
   * `SSESpecification`, while the template leaves the table on the AWS owned
   * key: no block (CDK's default) or `SSEEnabled: false` (CDK's
   * `dynamoOwnedKey()`). `readCurrentState` omits the block unless encryption
   * is ENABLED, so a baseline captured on the AWS owned key has none, and a
   * later move to a KMS key was compared nowhere at the top level and kept by
   * `drift --revert` (go-to-k/cdkd#5399). Sent absent, `update()` takes its
   * removal path: `SSESpecification: { Enabled: false }`, which returns every
   * region to the AWS owned key, as CloudFormation does (go-to-k/cdkd#5355).
   *
   * A template declaring encryption ON gets nothing: a baseline without the
   * block disagrees with that template, and it must not turn the declared
   * encryption off. A missing block is not proof of the AWS owned key on its
   * own (the read-back omits it for every status but ENABLED, e.g.
   * ENABLING, UPDATING, DISABLING or INACCESSIBLE_ENCRYPTION_CREDENTIALS), so the template's answer is what bounds the reset.
   */
  getDriftAbsentMeansDefaultKeys(
    resourceType: string,
    properties: Record<string, unknown>
  ): readonly string[] {
    if (resourceType !== 'AWS::DynamoDB::GlobalTable') return [];
    const declared = properties['SSESpecification'];
    if (declared === undefined) return ['SSESpecification'];
    return coerceCfnBoolean(asRecord(declared)?.['SSEEnabled']) === false
      ? ['SSESpecification']
      : [];
  }

  /**
   * Adopt an existing DynamoDB GlobalTable into cdkd state.
   *
   * Lookup order:
   *   1. `--resource` override or `Properties.TableName` → verify via DescribeTable.
   *
   * Same shape as `DynamoDBTableProvider.import()`. The provider returns
   * the physical id only; cdkd's import flow does the attribute capture
   * separately.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'TableName');
    if (explicit) {
      try {
        const resp = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: explicit })
        );
        // Issue #3627: the same map `create()` records. The resolver's
        // `StreamArn` arm refuses the reference without it (issue #4077).
        return {
          physicalId: explicit,
          attributes: definedAttributes({
            Arn: resp.Table?.TableArn,
            TableId: resp.Table?.TableId,
            StreamArn: resp.Table?.LatestStreamArn,
            TableName: resp.Table?.TableName ?? explicit,
          }),
        };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a table
    // reaching here needs an explicit `--resource` override.
    return null;
  }

  // ─── Polling helpers ─────────────────────────────────────────────────

  private async waitForTableActive(
    tableName: string,
    logicalId: string,
    maxAttempts = 120,
    // The create caller's masker (issue #2177): every line and throw below
    // names the resolved table name. Defaults to IDENTITY.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<{
    tableArn: string | undefined;
    tableId: string | undefined;
    streamArn: string | undefined;
  }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const status = response.Table?.TableStatus;
      this.logger.debug(
        maskSecrets(
          `Table ${maskSecrets(tableName)} status: ${status} (attempt ${attempt}/${maxAttempts})`
        )
      );

      if (status === 'ACTIVE') {
        return {
          tableArn: response.Table?.TableArn,
          tableId: response.Table?.TableId,
          streamArn: response.Table?.LatestStreamArn,
        };
      }
      if (status !== 'CREATING' && status !== 'UPDATING') {
        throw new ProvisioningError(
          maskSecrets(
            `Unexpected table status while waiting for ACTIVE on ${maskSecrets(tableName)}: ${status}`
          ),
          'AWS::DynamoDB::GlobalTable',
          logicalId,
          tableName
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ProvisioningError(
      maskSecrets(`Table ${maskSecrets(tableName)} did not reach ACTIVE within ${maxAttempts}s`),
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait for the table to reach ACTIVE after an UpdateTable call. Unlike
   * `waitForTableActive`, this tolerates any non-terminal status — the
   * table may already be ACTIVE on the no-op path (already-disabled
   * protection) or transition through UPDATING.
   *
   * **A table is ACTIVE while one of its INDEXES is still transitioning**, and
   * the next `UpdateTable` in the serialized sequence is then rejected with
   * `Attempt to change a resource which is still in use: Index is being
   * updated` (issue #1521). That is not hypothetical: it broke the
   * `PAY_PER_REQUEST -> PROVISIONED` flip that also drops a GSI — AWS applies
   * the flip to every index, and cdkd issued the index DELETE while the index
   * was still absorbing it. Reproduced on pristine `main`, three runs out of
   * four on 2026-08-10, and the failed deploy's own `cdkd destroy` then
   * ORPHANED the table for the same reason.
   *
   * So the wait has TWO conditions read off the SAME response (an extra
   * `DescribeTable` per wait would double this path's API traffic for
   * something the response already carries) — but they keep DIFFERENT failure
   * semantics, and conflating them is a real regression rather than a
   * simplification. A table that never reaches ACTIVE is a hard error: nothing
   * can proceed. A still-transitioning INDEX is best-effort: `IndexStatus`
   * stays `CREATING` for the whole BACKFILL of a newly added GSI, which on a
   * populated table routinely outlives any cap — so throwing there would fail
   * a deploy whose resources are all correct, and would do it on an unrelated
   * tag-only edit that merely ran while an earlier index was still building.
   * Past the cap the index half warns and proceeds, leaving AWS's own
   * rejection as the backstop, which is the behavior it had before #1521 for
   * every case except the one the wait exists to fix.
   */
  private async waitForTableActiveAfterUpdate(
    tableName: string,
    logicalId: string,
    maxAttempts = GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
    budget?: ElapsedBudget,
    // The caller's secret masker (issue #1997). Both the warning and the THROW
    // below name `tableName`, the resolved table name — and the throw matters
    // more than the warning here, because the deploy engine's CLI path logs
    // `error.message` RAW (only its events store masks). The DELETE-path caller
    // passes its `DeleteContext.maskSecrets` (issue #2007); IDENTITY for a
    // direct caller passing none.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    // Issue #1955: on the DELETE path (`--remove-protection`) this is the FIRST
    // wait of four sharing one per-resource deadline, and it is the slowest
    // kind — it returns only when the table is ACTIVE *and* no index is
    // transitioning, i.e. exactly the condition the rest of the path is about,
    // so it can spend its full ~12 min at t=0 and leave the #1521 gate and the
    // index-busy loop nothing. Its `Table`-provider twin took the allowance in
    // the first revision of this change and this one did not, which is the
    // half-applied shape a paired clamp exists to prevent. Every CREATE /
    // UPDATE caller passes no budget and keeps the full cap.
    const wait = beginDeleteWait(maxAttempts, budget);
    let tableReachedActive = false;
    while (wait.nextPoll()) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      if (response.Table?.TableStatus === 'ACTIVE') {
        tableReachedActive = true;
        if (!hasTransitionalTableIndex(response.Table)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // Both exits name WHICH clock ended the wait, and both count the polls
    // actually RUN rather than the ones granted — the loop can also stop
    // mid-way, when the allowance runs out under polls that cost more than the
    // ~1.2s the grant assumed.
    const budgetNote = wait.note();
    if (tableReachedActive) {
      this.logger.warn(
        maskSecrets(
          `Indexes on ${tableName} (${logicalId}) were still transitioning after ` +
            `${wait.pollsRun}s — a large index backfill can outlive this wait. Proceeding; ` +
            `AWS rejects the next call if it is still too early.${budgetNote}`
        )
      );
      return;
    }
    throw new ProvisioningError(
      maskSecrets(
        `Table ${tableName} did not reach ACTIVE within ${wait.pollsRun}s after UpdateTable${budgetNote}`
      ),
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait until every GSI reports `IndexStatus: ACTIVE` (Issue #1419).
   *
   * A GSI added by `UpdateTable` leaves the TABLE ACTIVE while the index
   * itself is still `CREATING` — application-autoscaling rejects a target
   * whose resource is not ready, so registering right after the GSI-add loop
   * would skip the very index the deploy just introduced.
   *
   * Since issue #1521 the same distinction is enforced INSIDE
   * {@link waitForTableActiveAfterUpdate} (which now reads both conditions off
   * its own response), so this helper is no longer the only place that knows
   * it. It remains the explicit wait for the two callers that have no
   * table-status wait to piggyback on: the autoscaling registration above and
   * the pre-`DeleteTable` gate, which AWS rejects while an index is
   * transitioning. An index that is `DELETING` still reports, so the shared
   * {@link hasTransitionalIndex} predicate covers `CREATING` / `UPDATING` /
   * `DELETING` alike.
   *
   * **Best-effort by design**: on timeout it warns and returns rather than
   * throwing. A missed registration self-heals on the next deploy (the
   * reconcile re-asserts anything not already present), whereas throwing
   * here would fail a deploy whose actual resources are all correct. Index
   * backfill on a large table can take a long time, hence the 15-minute
   * DEFAULT cap. The caller that follows it with a mutating call keeps AWS's
   * own error as the backstop for the case where even that cap is not enough.
   *
   * `opts.maxAttempts` exists because the cap is only right for a wait that
   * runs ONCE: the #1830 delete retry re-runs this per attempt, so the caller's
   * wall clock is the product and the default would blow past the per-resource
   * deadline `destroy-runner.ts` enforces.
   *
   * `opts.proceedNote` covers the OTHER thing that is caller-specific: what it
   * costs when the wait ends WITHOUT confirming. Both arms that end that way —
   * the timeout, and a `DescribeTable` that failed for a reason other than
   * throttling or a gone table — stop waiting and let the caller proceed, so
   * one note serves both. The consequences genuinely differ: on the delete
   * path AWS refuses the `DeleteTable` and that refusal is the backstop, while
   * the auto-scaling caller has NO backstop — `reconcileAutoScalingTargets`
   * simply skips an index that is not ready and nothing downstream refuses.
   * The default sentence is the auto-scaling one; every delete-path caller
   * passes {@link DELETE_INDEX_WAIT_PROCEED_NOTE}.
   */
  private async waitForIndexesActive(
    tableName: string,
    logicalId: string,
    opts?: {
      maxAttempts?: number;
      shortCapUnlessVectorBusy?: number;
      proceedNote?: string;
      budget?: ElapsedBudget;
      // The update caller's masker: the table name can be secret-derived, and
      // the wait's WARN lines name it (go-to-k/cdkd#4275). The delete callers
      // pass their `DeleteContext.maskSecrets` (issue #2007).
      maskSecrets?: SecretMasker;
    }
  ): Promise<void> {
    // The LOOP lives in `../dynamodb-index-busy-delete.ts` because the sibling
    // `AWS::DynamoDB::Table` provider needs the identical wait to re-arm its
    // own index-busy delete retry (issue #1931), and the tolerances it encodes
    // — throttle keeps waiting, gone returns, anything else gives up the WAIT
    // and not the operation — are exactly the ones a second spelling would get
    // subtly wrong. This method keeps the DEFAULTS, which are this provider's:
    // the 900-poll cap and the auto-scaling proceed note both belong to the
    // caller that has no backstop, and neither is right for the delete path.
    const gateWait = beginDeleteWait(opts?.maxAttempts ?? 900, opts?.budget);
    await waitForIndexesSettled({
      tableName,
      logicalId,
      // The name masked as a VALUE first, so one below the masker's substring
      // floor is caught too, then the whole line (AWS text can quote it).
      logger: maskedLogger(this.logger, opts?.maskSecrets, tableName),
      describeTable: () =>
        this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName })),
      // The cap is the SMALLER of this caller's own constant and what the
      // shared delete budget can still afford (issue #1955) — an absent budget
      // (every CREATE / UPDATE caller) leaves the constant untouched.
      maxAttempts: gateWait.grantedPolls,
      ...(opts?.shortCapUnlessVectorBusy !== undefined && {
        shortCapUnlessVectorBusy: opts.shortCapUnlessVectorBusy,
      }),
      // ...and the loop re-checks the allowance on every iteration, so a poll
      // that costs more than the grant assumed cannot run the wait past it.
      // The wait also owns its own give-up wording, so a budget-ended exit
      // cannot read as AWS failing to settle.
      budgetWait: gateWait,
      proceedNote:
        opts?.proceedNote ??
        `auto-scaling registration for a still-building index may have been skipped. The ` +
          `next deploy re-asserts it.`,
    });
  }

  /**
   * Wait until a specific replica's `ReplicaStatus` flips to ACTIVE.
   * Replica provisioning typically takes 1–5 min; capped at
   * {@link REPLICA_GONE_WAIT_ATTEMPTS} polls — ~12 min at the MEASURED ~1.2s
   * per poll (a sleep plus a `DescribeTable` round trip), not the ~10 min the
   * `1 poll = 1s` reading gives. The delete-path arithmetic in
   * `./dynamodb-delete-budget.ts` prices it at the measured figure, so the two
   * have to agree.
   */
  private async waitForReplicaActive(
    tableName: string,
    region: string,
    logicalId: string,
    maxAttempts = 600,
    // The create / update caller's masker (issue #2177): the throw below names
    // the resolved table name. Defaults to IDENTITY.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
      if (replica?.ReplicaStatus === 'ACTIVE') return;
      this.logger.debug(
        maskSecrets(
          `Replica ${region} status: ${replica?.ReplicaStatus} (attempt ${attempt}/${maxAttempts})`
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ProvisioningError(
      maskSecrets(
        `Replica ${region} for table ${maskSecrets(tableName)} did not reach ACTIVE within ${maxAttempts}s`
      ),
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait until a specific replica disappears from `Replicas[]` after a
   * Delete replica update. Replica deletion typically takes 1–5 min;
   * capped at {@link REPLICA_GONE_WAIT_ATTEMPTS} polls (~12 min at the
   * measured ~1.2s per poll).
   */
  private async waitForReplicaGone(
    tableName: string,
    region: string,
    logicalId: string,
    maxAttempts = REPLICA_GONE_WAIT_ATTEMPTS,
    budget?: ElapsedBudget,
    // The create-cleanup / update caller's masker (issue #2177): the interrupt
    // label and the throw below name the resolved table name. The DELETE
    // caller passes its `DeleteContext.maskSecrets` (issue #2007); IDENTITY
    // for a direct caller passing none.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    // Issue #1955: on the delete path this is one of THREE stacked waits inside
    // a single per-resource deadline, so it takes the smaller of its own cap
    // and what the shared budget can still afford. The partial-create cleanup
    // caller passes no budget and keeps the full cap.
    const wait = beginDeleteWait(maxAttempts, budget);
    // Interruptible (issue #1952): 600 polls is ~12 minutes, and the whole
    // point of interrupting only ONE wait on this path is that it buys little
    // — every bounded wait the delete path can sit in has to consult the same
    // signal. This one THROWS rather than returning, for the same reason the
    // exhaustion arm below throws: `DeleteTable` has NOT been issued yet and
    // AWS refuses it while a replica lives, so proceeding after a Ctrl-C would
    // trade a long wait for a confusing failure.
    const watch = startInterruptWatch(
      maskSecrets(`DynamoDB replica ${region} teardown on ${maskSecrets(tableName)}`)
    );
    try {
      while (wait.nextPoll()) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        try {
          const response = await this.dynamoDBClient.send(
            new DescribeTableCommand({ TableName: tableName })
          );
          const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
          if (!replica) return;
          await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_POLL_INTERVAL_MS));
        } catch (err) {
          if (err instanceof ResourceNotFoundException) return;
          throw err;
        }
      }
    } finally {
      watch.dispose();
    }
    // Still THROWS even when the allowance ended it, unlike the gone-wait
    // below, and the asymmetry is load-bearing — but NOT because nothing has
    // been accepted. The `UpdateTable{ReplicaUpdates:[{Delete}]}` that starts
    // this teardown WAS accepted (see `delete()`), so an earlier reading of
    // this comment was simply wrong. What differs is what comes NEXT: the
    // gone-wait is the LAST thing on the path, so giving up on it costs
    // nothing, while this wait is followed by a `DeleteTable` that AWS REFUSES
    // while the replica still lives. Proceeding optimistically here trades a
    // long wait for a confusing failure, which is why both the exhaustion arm
    // and the interrupt arm throw.
    throw new ProvisioningError(
      maskSecrets(
        `Replica ${region} for table ${maskSecrets(tableName)} did not disappear within ` +
          `${wait.pollsRun}s${wait.note()}`
      ),
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * go-to-k/cdkd#5581: deregister every application-autoscaling target still
   * registered for a REMOVED replica's table in that replica's own region.
   *
   * Adding a replica to an autoscaled PROVISIONED global table makes DynamoDB
   * itself (`replication.dynamodb.amazonaws.com`, measured in CloudTrail)
   * register targets for the new replica table in its region — the write
   * dimension included, which no cdkd call ever names there. Removing the
   * replica does NOT deregister them, so before this the write target (and any
   * index target) outlived the replica and the table, and a later table of the
   * same name in that region inherited it.
   *
   * Callers run it for EVERY removed non-local replica, not only one whose
   * template declared read auto-scaling: DynamoDB registers these targets on
   * its own, so the template is no evidence either way. Do not gate it on the
   * replica's settings.
   *
   * Runs AFTER `waitForReplicaGone`, and only once the replica's table reads
   * `DELETING` or `ResourceNotFound` in its region: those are the two states a
   * table never comes back from, so no target removed here can belong to a
   * live table. A table reading any other state gets a warning instead of a
   * deregistration.
   *
   * The targets are LISTED, not named: an index target exists for whatever
   * index the replica had, which the template may no longer declare. Matched
   * on the exact resource id `table/<name>` and the prefix
   * `table/<name>/index/`, so a sibling table sharing a name prefix is never
   * touched (`/` is not a legal table-name character). Every such target goes,
   * whoever registered it — one another stack declared in that region too: it
   * names a table that is DELETING or gone, so it scales nothing.
   *
   * Best-effort, like the rest of the auto-scaling teardown: every AWS failure
   * is a masked warning naming the command to finish by hand (AWS's class at
   * warn, its text at debug, go-to-k/cdkd#2319), and nothing but a user
   * interrupt is thrown — so a ResourceNotFound read here can never reach a
   * caller that reads it as the GLOBAL table being gone.
   */
  private async deregisterRemovedReplicaScalableTargets(
    tableName: string,
    region: string,
    options: {
      readonly budget?: ElapsedBudget | undefined;
      readonly maskSecrets?: SecretMasker | undefined;
      readonly progress?: DeleteProgress | undefined;
    } = {}
  ): Promise<void> {
    const mask: SecretMasker = options.maskSecrets ?? ((text: string) => text);
    const tableResourceId = autoScalingResourceId(tableName);
    const indexPrefix = `${tableResourceId}/index/`;
    const leaveTargets = (reason: string, awsDetail?: string): void => {
      this.logger.warn(
        mask(
          `The ${region} replica of ${tableName} was removed, but its application-autoscaling ` +
            `targets there were left registered: ${reason}. Once that table is gone, run: ` +
            `${pasteableAwsCommand(mask)`aws application-autoscaling describe-scalable-targets --service-namespace dynamodb --region ${region}`.render()} ` +
            `and deregister each target whose ResourceId is ${tableResourceId} or starts with ` +
            `${indexPrefix}.`
        )
      );
      if (awsDetail !== undefined) {
        this.logger.debug(mask(`${region} replica of ${tableName}: ${awsDetail}`));
      }
    };
    // ONE watch for the read and every listing page: a Ctrl-C aborts a throttle
    // backoff like every other retry on these paths, and is checked between
    // pages too (issue #2053).
    const watch = startInterruptWatch(
      mask(`application-autoscaling target cleanup for ${tableName} in ${region}`)
    );
    const found: Array<{ dimension: DynamoDBScalableDimension; indexName?: string }> = [];
    const asClient = this.getRegionalAutoScalingClient(region);
    try {
      const retired = await this.readReplicaTableRetired(tableName, region, options.budget, watch);
      if (retired !== true) {
        leaveTargets(retired.reason, retired.awsDetail);
        return;
      }

      try {
        let nextToken: string | undefined;
        do {
          if (watch.isInterrupted()) throw watch.onInterrupted();
          const token = nextToken;
          const res: DescribeScalableTargetsCommandOutput | undefined = await withRetry(
            () =>
              asClient.send(
                new DescribeScalableTargetsCommand({
                  ServiceNamespace: 'dynamodb',
                  ...(token ? { NextToken: token } : {}),
                })
              ),
            `${tableResourceId} targets in ${region}`,
            {
              isRetryable: (_message, error) => isThrottlingError(error),
              maxRetries: autoScalingRetriesWithinDeleteBudget(
                options.budget,
                AUTO_SCALING_TEARDOWN_MAX_RETRIES
              ),
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
              ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
            }
          );
          for (const target of res?.ScalableTargets ?? []) {
            const dimension = target.ScalableDimension;
            const resourceId = target.ResourceId;
            if (!resourceId || !isDynamoDBScalableDimension(dimension)) continue;
            if (resourceId === tableResourceId && dimension.startsWith('dynamodb:table:')) {
              found.push({ dimension });
            } else if (
              resourceId.startsWith(indexPrefix) &&
              resourceId.length > indexPrefix.length &&
              dimension.startsWith('dynamodb:index:')
            ) {
              found.push({ dimension, indexName: resourceId.slice(indexPrefix.length) });
            }
          }
          nextToken = res?.NextToken;
        } while (nextToken);
      } catch (err) {
        if (isInterruptedWaitError(err)) throw err;
        const failure = describeAwsFailure(err);
        leaveTargets(`listing them failed (${failure.summary})`, failure.detail);
        return;
      }
    } finally {
      watch.dispose();
    }

    for (const target of found) {
      // The teardown branch of the shared helper: policy delete, then the
      // deregister, each with its own masked warning and pasteable command,
      // `ObjectNotFoundException` silent.
      await this.applyAutoScalingDiff(
        tableName,
        target.dimension,
        {},
        undefined,
        asClient,
        target.indexName,
        options.budget,
        mask,
        options.progress
      );
    }
    if (found.length > 0) {
      this.logger.debug(
        mask(
          `Deregistered ${found.length} auto-scaling target(s) left by the removed ${region} ` +
            `replica of ${tableName}`
        )
      );
    }
  }

  /**
   * go-to-k/cdkd#5581: whether a removed replica's table reads `DELETING` or
   * `ResourceNotFound` in its own region. `true` when it does; otherwise the
   * reason for the caller's warning, and AWS's own text for its debug line.
   *
   * ONE read (throttle-retried), not a poll. `waitForReplicaGone` returns once
   * the SOURCE table's `Replicas[]` has dropped the entry, and by then the
   * regional copy is expected to be deleting: the `dynamodb-globaltable`
   * integ's step 12e sees it stay `DELETING` for minutes after that before its
   * ResourceNotFound. Both states are past the point of return, so `DELETING`
   * is accepted rather than waited out — that wait would add those minutes to
   * every replica removal. A table reading anything else keeps its targets,
   * with a warning.
   */
  private async readReplicaTableRetired(
    tableName: string,
    region: string,
    budget: ElapsedBudget | undefined,
    watch: ReturnType<typeof startInterruptWatch>
  ): Promise<true | { reason: string; awsDetail?: string }> {
    try {
      const response = await withRetry(
        () =>
          this.getRegionalClient(region).send(new DescribeTableCommand({ TableName: tableName })),
        `${tableName} in ${region}`,
        {
          isRetryable: (_message, error) => isThrottlingError(error),
          maxRetries: autoScalingRetriesWithinDeleteBudget(
            budget,
            AUTO_SCALING_TEARDOWN_MAX_RETRIES
          ),
          isInterrupted: watch.isInterrupted,
          onInterrupted: watch.onInterrupted,
          ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
        }
      );
      const status = response.Table?.TableStatus;
      if (status === 'DELETING') return true;
      return { reason: `the table there still reads ${status ?? 'no status'}` };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return true;
      if (isInterruptedWaitError(err)) throw err;
      const failure = describeAwsFailure(err);
      return {
        reason: `reading the table there failed (${failure.summary})`,
        awsDetail: failure.detail,
      };
    }
  }

  /**
   * Wait for `DescribeTable` to return `ResourceNotFoundException`,
   * confirming the table has actually been removed. `DeleteTable` is
   * async — the call returns immediately with `TableStatus: DELETING`
   * and AWS only removes the table some seconds later. Without this
   * wait, downstream observers (siblings deleted in the same destroy
   * run, integ scripts that re-check via `aws dynamodb describe-table`)
   * see "destroy succeeded" but the table is still listed by AWS.
   * Typical small-table delete completes in 5–30s; capped at
   * {@link TABLE_GONE_WAIT_ATTEMPTS} polls (~12 min at the measured ~1.2s per
   * poll) for worst-case large-table / replica-cascade scenarios. That 5-30s
   * figure is what {@link DELETE_SHORT_WAIT_POLLS} is calibrated against: past
   * roughly twice the top of it, cdkd HAS given AWS a real wait.
   */
  private async waitForTableGone(
    tableName: string,
    logicalId: string,
    maxAttempts = TABLE_GONE_WAIT_ATTEMPTS,
    budget?: ElapsedBudget,
    // The delete caller's `DeleteContext.maskSecrets` (go-to-k/cdkd#2007): the
    // interrupt label, both warnings and the throw name the table. IDENTITY
    // for a direct caller passing none.
    mask: SecretMasker = (text) => text
  ): Promise<void> {
    const shownName = mask(tableName);
    // Issue #1955: this is the LAST term of the delete path and the one that
    // only runs on a late loop SUCCESS — which is exactly why it was the term
    // that pushed the single-region shape to ~40.4 min. It draws from the same
    // shared budget as everything before it.
    const wait = beginDeleteWait(maxAttempts, budget);
    // Interruptible (issue #1952), and unlike `waitForReplicaGone` this one
    // RETURNS: by the time it runs AWS has ACCEPTED the `DeleteTable` and the
    // deletion is no longer in cdkd's hands, so a Ctrl-C here means "stop
    // watching", not "the delete failed". That is the same reading the
    // `cutShort` arm below already takes, and throwing would turn an accepted
    // delete into a reported FAILURE with state preserved.
    const watch = startInterruptWatch(mask(`DynamoDB table ${shownName} deletion wait`));
    try {
      while (wait.nextPoll()) {
        if (watch.isInterrupted()) {
          this.logger.warn(
            mask(
              `DynamoDB GlobalTable ${logicalId}: interrupted while waiting for ${shownName} to ` +
                `disappear. AWS ACCEPTED the DeleteTable and will finish it; cdkd stopped watching.`
            )
          );
          return;
        }
        try {
          await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }));
          await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_POLL_INTERVAL_MS));
        } catch (err) {
          if (err instanceof ResourceNotFoundException) return;
          throw err;
        }
      }
    } finally {
      watch.dispose();
    }
    // A wait the allowance CUT SHORT warns; a wait that was actually performed
    // still throws. The line is {@link DELETE_SHORT_WAIT_POLLS}, not
    // `granted < cap`, and the difference matters: with ~14 min of the
    // allowance already spent this wait is still granted ~500 polls — ten real
    // minutes of `DescribeTable` — and downgrading THAT to a warning would be a
    // decision made by two minutes of arithmetic rather than by evidence.
    //
    // Below the floor, cdkd barely looked, and `DeleteTable` has already been
    // ACCEPTED by the time this wait runs (it returned 200 and the table is
    // `DELETING`, and this method's only caller sits after the retry helper
    // resolved). The deletion is no longer in cdkd's hands and it WILL
    // complete; failing there turns an accepted delete into a reported FAILURE
    // with state preserved, and the user re-runs a destroy for a table AWS
    // already deleted. Above the floor, cdkd DID give AWS a real wait, so a
    // table still present is a signal about AWS and keeps the hard error the
    // method has always had.
    if (wait.cutShort) {
      this.logger.warn(
        mask(
          `DynamoDB GlobalTable ${logicalId}: DeleteTable on ${shownName} was ACCEPTED by AWS but ` +
            `cdkd stopped waiting for the table to disappear` +
            `${wait.note()} The delete completes on AWS's side; a later ` +
            `describe (or a re-run of this destroy) sees it gone.`
        )
      );
      return;
    }
    throw new ProvisioningError(
      mask(`Table ${shownName} did not disappear within ${wait.pollsRun}s${wait.note()}`),
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }
}

// ─── Pure-functional diff helpers (exported for testing) ───────────────

/**
 * Refuse a malformed desired `Replicas[].Tags` (go-to-k/cdkd#3994) before any
 * call, naming the replica by index and never its content. The type has no
 * top-level `Tags`; each replica's list is a CloudFormation `[{ Key, Value }]`
 * bag. Returns each replica entry's well-formed list, keyed by the entry. A
 * `Replicas` that is not a list, or an entry that is not an object, is left to
 * the readers that own it.
 */
function refuseMalformedReplicaTags(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): Map<Record<string, unknown>, CfnTagEntry[]> {
  const tagsByReplica = new Map<Record<string, unknown>, CfnTagEntry[]>();
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas)) return tagsByReplica;
  replicas.forEach((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const replica = entry as Record<string, unknown>;
    tagsByReplica.set(
      replica,
      refuseMalformedDesiredTags(
        replica['Tags'],
        resourceType,
        logicalId,
        physicalId,
        `Replicas[${index}].Tags`
      )
    );
  });
  return tagsByReplica;
}

const DISASSOCIATION_PROTECTION_KEY = 'DisassociationProtectionEnabled';

/**
 * The refusals of a declared `Replicas[].DisassociationProtectionEnabled`
 * (go-to-k/cdkd#5570), as one message, or `undefined` when there is none:
 *
 * - a value that is not a boolean (a CFn string `'true'` / `'false'` counts
 *   as a boolean). Never read as either value: `false` would let the replica
 *   be detached from the global table, and `true` would undo a disable
 *   nobody can read.
 * - a `false` on a table whose desired `Replicas` names a single Region,
 *   when it is new or changed. DynamoDB applies the member only to a replica
 *   of a multi-Region (MREC) global table: on a table with no other replica
 *   the solo `UpdateTable {DisassociationProtectionEnabled: false}` answered
 *   `InternalFailure` (HTTP 500) on every retry (integ, us-east-1,
 *   2026-10-30), so the disable the template asks for cannot be delivered. A
 *   `true` is not refused: it is the AWS default, a single-Region table has
 *   no global table to be detached from, so skipping it weakens nothing, and
 *   CloudFormation accepts the template. Nor is an unchanged `false` — a
 *   table that drops to one replica and keeps its declaration. The pass
 *   skips both ({@link isMultiRegionReplicaSet}).
 */
function disassociationProtectionRefusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  logicalId: string
): string | undefined {
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas)) return undefined;
  const malformed: string[] = [];
  const singleRegion: string[] = [];
  const multiRegion = isMultiRegionReplicaSet(properties);
  replicas.forEach((entry: unknown, index) => {
    const replica = asRecord(entry);
    if (replica === undefined) return;
    const refusal = configBooleanRefusal(
      replica,
      DISASSOCIATION_PROTECTION_KEY,
      `Replicas[${index}]`
    );
    if (refusal !== undefined) {
      malformed.push(refusal);
      return;
    }
    const declared = readReplicaDisassociationProtection(replica);
    if (declared === undefined || multiRegion) return;
    const region = replica['Region'];
    const previous =
      previousProperties === undefined || typeof region !== 'string'
        ? undefined
        : readReplicaDisassociationProtection(localReplicaEntry(previousProperties, region));
    if (declared === false && declared !== previous)
      singleRegion.push(`Replicas[${index}].${DISASSOCIATION_PROTECTION_KEY}`);
  });
  const parts: string[] = [];
  if (malformed.length > 0) {
    parts.push(
      `${malformed.join('; ')}. That replica's disassociation protection is left as it is.`
    );
  }
  if (singleRegion.length > 0) {
    parts.push(
      `${singleRegion.join(', ')} is applied by DynamoDB only to a replica of a multi-Region ` +
        "(MREC) global table, and this table's Replicas name a single Region, so cdkd does not send it. " +
        `Remove ${DISASSOCIATION_PROTECTION_KEY}, or add a replica in another Region.`
    );
  }
  if (parts.length === 0) return undefined;
  return `AWS::DynamoDB::GlobalTable ${logicalId}: ${parts.join(' ')}`;
}

/**
 * Whether a GlobalTable's desired `Replicas` names more than one Region — a
 * multi-Region global table, the only kind DynamoDB applies
 * `DisassociationProtectionEnabled` to (go-to-k/cdkd#5570). The protection
 * pass runs after every replica change has settled, so an update that adds
 * the second Region in the same deploy qualifies.
 */
function isMultiRegionReplicaSet(properties: Record<string, unknown>): boolean {
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas)) return false;
  const regions = new Set<string>();
  for (const entry of replicas) {
    const region = asRecord(entry)?.['Region'];
    if (typeof region === 'string' && region !== '') regions.add(region);
  }
  return regions.size > 1;
}

/**
 * A replica's declared `DisassociationProtectionEnabled`: the boolean (a CFn
 * string included), or `undefined` when it is absent or not a boolean — the
 * latter refused or warned up front by {@link disassociationProtectionRefusal}.
 */
function readReplicaDisassociationProtection(
  replica: Record<string, unknown> | undefined
): boolean | undefined {
  return coerceCfnBoolean(replica?.[DISASSOCIATION_PROTECTION_KEY]);
}

/**
 * The #3573 half of {@link DynamoDBGlobalTableProvider.canonicalizeDriftPair}:
 * a baseline whose `Replicas` has no entry for the local region gets the
 * read-back's local entry. Identity when nothing applies.
 */
function completeLegacyLocalReplica(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  localRegion: string
): Record<string, unknown> {
  const key = 'Replicas';
  const baselineReplicas = baseline[key];
  const awsReplicas = aws[key];
  if (!Array.isArray(baselineReplicas) || !Array.isArray(awsReplicas)) return baseline;
  if (!localRegion) return baseline;
  const isLocal = (element: unknown): boolean => asRecord(element)?.['Region'] === localRegion;
  if (baselineReplicas.some(isLocal)) return baseline;
  const liveLocal = awsReplicas.find(isLocal);
  if (liveLocal === undefined) return baseline;
  return { ...baseline, [key]: [...baselineReplicas, structuredClone(liveLocal)] };
}

/**
 * The `Replicas[]` entry for `region`, or `undefined`.
 *
 * ONE predicate, because two readers of the same field had drifted: issue
 * [#2610]'s review round guarded `extractLocalDeletionProtection` against a
 * non-array `Replicas` and left `update()`'s inline `extractLocalTags` on the
 * old `(props['Replicas'] ?? []) as Array<...>` -- which is the one that
 * actually throws FIRST on the apply path, ~400 lines earlier in the same
 * method, so guarding only the other produced no visible change and no test
 * went red. A shared predicate is what stops the next reader inheriting the
 * unguarded spelling; `derivePerCallProvisionedThroughput` documents the same
 * hazard for the same field and guards independently.
 *
 * `Array.isArray`, not `?? []`: a non-array `Replicas` -- an unresolved
 * intrinsic, or a hand-edited state record -- makes `.find` throw a bare
 * `TypeError`, and since [#2610] one caller sits on the REFUSAL path, where a
 * throw REPLACES three informative `ProvisioningError`s with a stack trace.
 * The `r?.` guards a null ENTRY inside an otherwise-valid array.
 */
export function localReplicaEntry(
  props: Record<string, unknown>,
  region: string
): Record<string, unknown> | undefined {
  const raw = props['Replicas'];
  if (!Array.isArray(raw)) return undefined;
  return (raw as Array<Record<string, unknown> | null | undefined>).find(
    (r) => r?.['Region'] === region
  ) as Record<string, unknown> | undefined;
}

/** The replica members {@link replicaSettingsRefusal} reads. */
const REPLICA_SETTING_MEMBERS = [
  'PointInTimeRecoverySpecification',
  'ContributorInsightsSpecification',
  'KinesisStreamSpecification',
  'ResourcePolicy',
  'ReplicaStreamSpecification',
  // Its entries' ContributorInsightsSpecification (go-to-k/cdkd#5489).
  'GlobalSecondaryIndexes',
] as const;

const REPLICATION_MODE_KEY = 'GlobalTableSettingsReplicationMode';
/** The table-level read settings (go-to-k/cdkd#2762), beside each replica's own. */
const TABLE_READ_ON_DEMAND_KEY = 'ReadOnDemandThroughputSettings';
const TABLE_READ_PROVISIONED_KEY = 'ReadProvisionedThroughputSettings';
const TABLE_WRITE_PROVISIONED_KEY = 'WriteProvisionedThroughputSettings';

/** One read of the declared `Replicas[].GlobalTableSettingsReplicationMode`. */
export type ReplicationModeRead =
  | { kind: 'absent' }
  | { kind: 'usable'; mode: string }
  | { kind: 'unusable'; reason: string };

/**
 * Read the settings replication mode (go-to-k/cdkd#5489). The CFn schema puts
 * it on each replica, but DynamoDB holds ONE per table (a `CreateTable` /
 * `UpdateTable` member), and CloudFormation refuses it unless the table has
 * exactly one replica: "GlobalTableSettingsReplicationMode can be specified
 * when exactly one replica is present" (CFn A/B, us-east-1 + us-west-2,
 * 2026-10-28, on a create with two replicas and on an update adding one). With
 * one replica it rides `CreateTable`, and a change goes out in its own
 * `UpdateTable`.
 */
export function readReplicationMode(properties: Record<string, unknown>): ReplicationModeRead {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  const declared = replicas
    .map((entry) => asRecord(entry)?.[REPLICATION_MODE_KEY])
    .filter((value) => value !== undefined && value !== null);
  if (declared.length === 0) return { kind: 'absent' };
  const [first] = declared;
  if (typeof first !== 'string' || first === '' || declared.some((v) => v !== first)) {
    return {
      kind: 'unusable',
      reason: `Replicas[].${REPLICATION_MODE_KEY} must be one non-empty string`,
    };
  }
  if (replicas.length !== 1) {
    return {
      kind: 'unusable',
      reason:
        `Replicas[].${REPLICATION_MODE_KEY} can be declared only on a table with exactly one ` +
        `replica, as CloudFormation refuses it ("GlobalTableSettingsReplicationMode can be ` +
        `specified when exactly one replica is present"); remove it, or keep one replica`,
    };
  }
  return { kind: 'usable', mode: first };
}

/** What a change to the mode, or to the replica count, is compared by. */
function replicationModeShape(properties: Record<string, unknown>): unknown {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  return replicas.map((entry) => asRecord(entry)?.[REPLICATION_MODE_KEY] ?? null);
}

/**
 * The mode an update must send, or `undefined` when none: the declared mode
 * when it changed, and `DISABLED` when the template removed one — what
 * CloudFormation sends for a removal (CFn A/B, 2026-10-28: `UpdateTable` with
 * `GlobalTableSettingsReplicationMode: DISABLED`). A mode that was never valid
 * on the recorded side (two replicas) was never sent, so it is not reset.
 */
export function replicationModeUpdate(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): string | undefined {
  const want = readReplicationMode(properties);
  if (want.kind === 'unusable') return undefined;
  const had = readReplicationMode(previousProperties);
  const desired = want.kind === 'usable' ? want.mode : undefined;
  const recorded = had.kind === 'usable' ? had.mode : undefined;
  if (desired === recorded) return undefined;
  return desired ?? 'DISABLED';
}

/**
 * The mode a DECLARED, UNCHANGED `GlobalTableSettingsReplicationMode` needs to
 * reach what the template says, given what `DescribeTable` reports, or
 * `undefined` (go-to-k/cdkd#5489). Before that issue the mode was never sent,
 * so a table deployed then holds DynamoDB's default
 * (`ENABLED_WITH_OVERRIDES`, measured) under a record that names the mode.
 * A table set to `DISABLED` reports no mode at all (measured), so an absent
 * live mode reads as `DISABLED`. A changed or unusable declaration is not a
 * correction: {@link replicationModeUpdate} and the refusal own those.
 */
export function replicationModeCorrection(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  liveMode: string | undefined
): string | undefined {
  const want = readReplicationMode(properties);
  if (want.kind !== 'usable') return undefined;
  if (replicationModeUpdate(properties, previousProperties) !== undefined) return undefined;
  return (liveMode ?? 'DISABLED') === want.mode ? undefined : want.mode;
}

/**
 * What CloudFormation's handler refuses of the table-level settings
 * go-to-k/cdkd#2762 wires, or `undefined` (measured us-east-1, 2026-11-01). The
 * refusals are the handler's, not DynamoDB's: `CreateTable` takes these values.
 *
 *  - `TableType: Regional` on more than one replica. `GlobalTableReplica` is
 *    accepted on one replica, where it reads back `Regional`: nothing is sent.
 *  - A table-level read block without settings replication ENABLED on a
 *    replica, or beside the same block on a replica.
 *  - `ReadOnDemandThroughputSettings` on a PROVISIONED table.
 */
function tableLevelSettingsRefusal(properties: Record<string, unknown>): string | undefined {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  if (properties['TableType'] === 'Regional' && replicas.length > 1) {
    return (
      `TableType Regional cannot be declared with more than one replica, as CloudFormation ` +
      `refuses it; declare TableType GlobalTableReplica or omit TableType`
    );
  }
  const mode = readReplicationMode(properties);
  for (const key of [TABLE_READ_ON_DEMAND_KEY, TABLE_READ_PROVISIONED_KEY]) {
    if (properties[key] === undefined || properties[key] === null) continue;
    if (mode.kind !== 'usable' || mode.mode !== 'ENABLED') {
      return (
        `${key} at the table level needs Replicas[].${REPLICATION_MODE_KEY} ENABLED, as ` +
        `CloudFormation refuses it otherwise; enable it on the replica, or move the block to ` +
        `the replica`
      );
    }
    if (replicas.some((entry) => asRecord(entry)?.[key] !== undefined)) {
      return (
        `${key} cannot be declared at both the table level and a replica, as CloudFormation ` +
        `refuses it; keep one`
      );
    }
  }
  if (
    properties[TABLE_READ_ON_DEMAND_KEY] !== undefined &&
    properties[TABLE_READ_ON_DEMAND_KEY] !== null &&
    properties['BillingMode'] === 'PROVISIONED'
  ) {
    return (
      `${TABLE_READ_ON_DEMAND_KEY} cannot be declared on a PROVISIONED table, as CloudFormation ` +
      `refuses it; remove it, or set BillingMode to PAY_PER_REQUEST`
    );
  }
  return undefined;
}

/** A replica's own read blocks, which the table-level ones may not sit beside. */
function replicaReadBlockShape(properties: Record<string, unknown>): unknown {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  return replicas.map((entry) => [
    asRecord(entry)?.[TABLE_READ_ON_DEMAND_KEY],
    asRecord(entry)?.[TABLE_READ_PROVISIONED_KEY],
  ]);
}

/** The inputs of {@link tableLevelSettingsRefusal}. */
const TABLE_LEVEL_SETTING_INPUTS = [
  'TableType',
  'BillingMode',
  TABLE_READ_ON_DEMAND_KEY,
  TABLE_READ_PROVISIONED_KEY,
] as const;

/**
 * The template-path refusal for the per-replica settings go-to-k/cdkd#5365
 * wires, or `undefined`. `previousProperties` is `undefined` on a create.
 *
 *  - A block the write plan cannot read, on a replica whose blocks changed (an
 *    unchanged one is not a pending operation).
 *  - A `ResourcePolicy` on a replica created in the same deploy, which
 *    CloudFormation refuses ("A replica cannot be created in the same stack
 *    update as putting a resource-based policy on that new replica", measured
 *    us-east-1 + us-west-2, 2026-10-27): on a create with a cross-region
 *    replica that is every replica's, the deploy region's included (a
 *    single-region create takes it); on an update, an added replica's
 *    (measured the same day: an update adding a replica that declares one is
 *    refused with the same message and rolled back).
 *
 * Names the region (an AWS region name, never a secret) and the member path,
 * never a value.
 */
export function replicaSettingsRefusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  currentRegion?: string
): string | undefined {
  // go-to-k/cdkd#5489: refused only when the mode or the replica list changed
  // (an unchanged one is not a pending operation).
  const mode = readReplicationMode(properties);
  const modeShapeChanged =
    previousProperties === undefined ||
    !deepEqual(replicationModeShape(properties), replicationModeShape(previousProperties));
  if (mode.kind === 'unusable' && modeShapeChanged) return mode.reason;
  // go-to-k/cdkd#2762: the same bound.
  if (
    modeShapeChanged ||
    previousProperties === undefined ||
    !deepEqual(replicaReadBlockShape(properties), replicaReadBlockShape(previousProperties)) ||
    TABLE_LEVEL_SETTING_INPUTS.some((key) => !deepEqual(properties[key], previousProperties?.[key]))
  ) {
    const tableLevelRefusal = tableLevelSettingsRefusal(properties);
    if (tableLevelRefusal !== undefined) return tableLevelRefusal;
  }
  // go-to-k/cdkd#2762: removing the table-level block from a table that stays
  // PROVISIONED, with no replica declaring its own, is refused by CloudFormation
  // ("You must specify ReadCapacityUnits or ReadCapacityAutoScalingSettings for
  // each global table replica", update rolled back and the capacity kept,
  // measured us-east-1, 2026-11-01), so it is no silent keep here.
  if (
    previousProperties?.[TABLE_READ_PROVISIONED_KEY] != null &&
    properties[TABLE_READ_PROVISIONED_KEY] == null &&
    properties['BillingMode'] === 'PROVISIONED' &&
    !(Array.isArray(properties['Replicas']) ? (properties['Replicas'] as unknown[]) : []).some(
      (entry) => asRecord(entry)?.[TABLE_READ_PROVISIONED_KEY] != null
    )
  ) {
    return (
      `${TABLE_READ_PROVISIONED_KEY} cannot be removed from a PROVISIONED table with no replica ` +
      `declaring its own, as CloudFormation refuses it; keep it, declare it on the replica, or ` +
      `set BillingMode to PAY_PER_REQUEST`
    );
  }
  const desired = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  const crossRegionCreate =
    previousProperties === undefined &&
    desired.some((entry) => {
      const region = asRecord(entry)?.['Region'];
      return typeof region === 'string' && region !== currentRegion;
    });
  for (const entry of desired) {
    const replica = asRecord(entry);
    const region = replica?.['Region'];
    if (typeof region !== 'string') continue;
    const previous =
      previousProperties === undefined ? undefined : localReplicaEntry(previousProperties, region);
    const changed =
      previous === undefined ||
      REPLICA_SETTING_MEMBERS.some((member) => !deepEqual(replica?.[member], previous[member]));
    if (!changed) continue;
    const [refusal] = replicaSettingRefusals(replica);
    if (refusal !== undefined) return `The ${region} replica: ${refusal}`;
    const created = previousProperties === undefined ? crossRegionCreate : previous === undefined;
    if (
      created &&
      replica?.['ResourcePolicy'] !== undefined &&
      replica['ResourcePolicy'] !== null
    ) {
      return (
        `The ${region} replica: Replicas[].ResourcePolicy cannot be set in the deploy that ` +
        `creates the replica — CloudFormation refuses it ("A replica cannot be created in the ` +
        `same stack update as putting a resource-based policy on that new replica"). ` +
        (previousProperties === undefined
          ? `Deploy the table and its replicas without it`
          : `Deploy the replica without it`) +
        `, then add the policy in a later deploy`
      );
    }
  }
  return undefined;
}

/**
 * Extract the local replica's `DeletionProtectionEnabled` from a CFn
 * properties shape. The `AWS::DynamoDB::GlobalTable` CFn schema places
 * the field inside `Replicas[?Region==<region>].DeletionProtectionEnabled`;
 * CDK 2.x's `deletionProtection: true` synthesizes there. Falls back
 * to the top-level `DeletionProtectionEnabled` for legacy or
 * hand-authored templates (the property doesn't formally exist at
 * the top level in the CFn schema, but cdkd tolerates it as a
 * pass-through to avoid breaking older state files).
 *
 * Returns `undefined` when neither shape carries a boolean — the
 * caller treats that as "unset" and does not include the field in
 * the SDK call.
 */
export function extractLocalDeletionProtection(
  props: Record<string, unknown>,
  region: string
): boolean | undefined {
  const local = localReplicaEntry(props, region);
  // `coerceCfnBoolean`: a template's `'true'` protects, as CloudFormation
  // reads it, and as the cross-region replicas' reads do (go-to-k/cdkd#5355).
  const perReplica = coerceCfnBoolean(local?.['DeletionProtectionEnabled']);
  if (perReplica !== undefined) return perReplica;
  const topLevel = props['DeletionProtectionEnabled'];
  return typeof topLevel === 'boolean' ? topLevel : undefined;
}

/**
 * Whether the table OR any cross-region replica is protected: the local
 * table's value (as {@link extractLocalDeletionProtection} reads it), `true`
 * when any replica's `DeletionProtectionEnabled` is. What the protection
 * locator reports, now that cdkd sets a replica's own guard and
 * `--remove-protection` turns it off (go-to-k/cdkd#5355).
 */
export function extractAnyDeletionProtection(
  props: Record<string, unknown>,
  region: string
): boolean | undefined {
  const replicas = Array.isArray(props['Replicas']) ? (props['Replicas'] as unknown[]) : [];
  if (replicas.some((r) => coerceCfnBoolean(asRecord(r)?.['DeletionProtectionEnabled']) === true)) {
    return true;
  }
  return extractLocalDeletionProtection(props, region);
}

/**
 * A replica's customer-managed KMS key, read where the CFn schema puts it:
 * `Replicas[].SSESpecification.KMSMasterKeyId` (`ReplicaSSESpecification`).
 * CDK's `TableV2` renders it there for every replica of a
 * `TableEncryptionV2.customerManagedKey(...)` table. The provider used to read
 * a flat `Replicas[].KMSMasterKeyId`, which the schema does not have
 * (`additionalProperties: false`), so the key was silently dropped and the
 * replica came up under the AWS managed key (go-to-k/cdkd#5355).
 */
export function readReplicaKmsMasterKeyId(replica: unknown): string | undefined {
  const sse = asRecord(asRecord(replica)?.['SSESpecification']);
  const key = sse?.['KMSMasterKeyId'];
  return typeof key === 'string' && key !== '' ? key : undefined;
}

/**
 * A replica's table class, read where the CFn schema puts it:
 * `Replicas[].TableClass`. The SDK spells the cross-region member
 * `TableClassOverride`, which is not a CFn property — reading THAT name from
 * the template dropped every table class (go-to-k/cdkd#5355).
 */
export function readReplicaTableClass(replica: unknown): ReplicaTableClass | undefined {
  const tableClass = asRecord(replica)?.['TableClass'];
  return typeof tableClass === 'string' && tableClass !== ''
    ? (tableClass as ReplicaTableClass)
    : undefined;
}

type ReplicaTableClass = 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS';

/** {@link readReplicaDeletionProtection}'s answer for a value that is not a boolean. */
export const UNUSABLE = Symbol('unusable');

/**
 * A replica's `DeletionProtectionEnabled`: the boolean (a CFn string
 * `'true'` / `'false'` included), `undefined` when absent, or
 * {@link UNUSABLE} for anything else — reported through `warn` when one is
 * given. Never read as `false`: that would turn a protected replica's guard
 * off on a value nobody can read (go-to-k/cdkd#5355).
 */
export function readReplicaDeletionProtection(
  replica: Record<string, unknown> | undefined,
  region: string,
  warn?: (message: string) => void
): boolean | undefined | typeof UNUSABLE {
  const refusal = configBooleanRefusal(
    replica,
    'DeletionProtectionEnabled',
    `AWS::DynamoDB::GlobalTable Replicas[${region}]`
  );
  if (refusal !== undefined) {
    warn?.(`${refusal}. The ${region} replica's deletion protection is left as it is.`);
    return UNUSABLE;
  }
  return coerceCfnBoolean(replica?.['DeletionProtectionEnabled']);
}

/**
 * Each replica's `SSESpecification` by region — what decides whether an update
 * re-sends the local table's SSE block (its key lives there), compared before
 * the client region is resolved.
 */
function replicaKeyBlocks(props: Record<string, unknown>): unknown[] {
  return (Array.isArray(props['Replicas']) ? (props['Replicas'] as unknown[]) : []).map((r) => [
    asRecord(r)?.['Region'],
    asRecord(r)?.['SSESpecification'],
  ]);
}

/** Whether a KMS key reference is a key ARN (what AWS reports back for a replica). */
function isKmsKeyArn(key: string | undefined): key is string {
  return key !== undefined && /^arn:aws[a-z-]*:kms:[^:]+:\d+:key\//.test(key);
}

/**
 * The table class an update sends, or `undefined` for none: a changed value,
 * or `STANDARD` when the template REMOVED a non-standard one — CloudFormation
 * resets a removed `Replicas[].TableClass` to `STANDARD` on the local table
 * and on a cross-region replica alike (CFn A/B, us-east-1 + us-west-2,
 * 2026-10-26, go-to-k/cdkd#5355). Before, a removal sent nothing and the old
 * class stayed.
 */
export function tableClassToSend(
  previous: ReplicaTableClass | undefined,
  desired: ReplicaTableClass | undefined
): ReplicaTableClass | undefined {
  if (desired !== undefined) return desired !== previous ? desired : undefined;
  return previous !== undefined && previous !== 'STANDARD' ? 'STANDARD' : undefined;
}

/**
 * The SDK `SSESpecification` for the LOCAL table: the top-level CFn block's
 * `{ SSEEnabled, SSEType }` plus the local replica's KMS key, which the CFn
 * schema keeps per replica. Shared by `create()` and `update()` so the two
 * cannot disagree on the key (go-to-k/cdkd#5355).
 */
function toSdkTableSseSpecification(
  block: unknown,
  kmsMasterKeyId: string | undefined
): { Enabled: boolean; SSEType?: 'KMS'; KMSMasterKeyId?: string } {
  const sse = asRecord(block) ?? {};
  return {
    // `coerceCfnBoolean`, not `Boolean(...)`: a template's `"false"` is a
    // truthy string, and read that way it ENABLED encryption it disabled.
    Enabled: coerceCfnBoolean(sse['SSEEnabled']) ?? true,
    ...(sse['SSEType'] !== undefined &&
      sse['SSEType'] !== '' && {
        SSEType: sse['SSEType'] as 'KMS',
      }),
    ...(kmsMasterKeyId !== undefined && { KMSMasterKeyId: kmsMasterKeyId }),
  };
}

/**
 * The table class the LOCAL table (the one `CreateTable` builds) should carry:
 * its `Replicas[?Region==<region>].TableClass`, falling back to a top-level
 * `TableClass`. The top-level spelling is not in the CFn schema (CloudFormation
 * refuses it at validation, measured for go-to-k/cdkd#5355), but it is the one
 * this provider always read, so it stays as the same legacy pass-through
 * {@link extractLocalDeletionProtection} keeps.
 */
export function extractLocalTableClass(
  props: Record<string, unknown>,
  region: string
): ReplicaTableClass | undefined {
  const perReplica = readReplicaTableClass(localReplicaEntry(props, region));
  if (perReplica !== undefined) return perReplica;
  const topLevel = props['TableClass'];
  return typeof topLevel === 'string' && topLevel !== ''
    ? (topLevel as ReplicaTableClass)
    : undefined;
}

/**
 * Derive the per-call `ProvisionedThroughput` shape required by
 * `CreateTableCommand` / `UpdateTableCommand` when BillingMode is
 * PROVISIONED. Shared between create() and the BillingMode-flip path in
 * update() so a user template's non-default read/write capacity is
 * preserved consistently across both code paths.
 *
 * Source of truth (CFn `AWS::DynamoDB::GlobalTable` shape):
 *  - WriteCapacityUnits → `properties.WriteProvisionedThroughputSettings`
 *    (top-level on the table). That block's ONLY member is
 *    `WriteCapacityAutoScalingSettings` — write capacity on a GlobalTable is
 *    always auto-scaled, so there is no literal `WriteCapacityUnits` to
 *    prefer. `CreateTable` needs one concrete number; which member of the
 *    auto-scaling block supplies it is context-dependent — see
 *    {@link CapacitySource}, which `source` selects. 5 if the block is absent.
 *  - ReadCapacityUnits → `Replicas[?Region==<region>].ReadProvisionedThroughputSettings`
 *    (per-replica, the deploy region's setting). That block DOES carry a
 *    literal `ReadCapacityUnits`, which is taken before its auto-scaling
 *    members; 5 if absent.
 */
export function derivePerCallProvisionedThroughput(
  properties: Record<string, unknown>,
  region: string,
  source: CapacitySource = 'min',
  diagnostics?: ThroughputDiagnostic[],
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): { ReadCapacityUnits: number; WriteCapacityUnits: number } {
  // `Array.isArray` rather than a bare cast: a non-array `Replicas` (an
  // unresolved intrinsic, a malformed template) would otherwise die on `.find`
  // with a bare `TypeError`. That was survivable while this helper only
  // computed numbers; it now also produces a user-facing diagnostic, so the
  // sibling `toSdkGlobalSecondaryIndexes` treatment applies here too.
  const rawReplicas = properties['Replicas'];
  const replicas = Array.isArray(rawReplicas) ? rawReplicas : [];
  const localReplica = replicas.find((r) => asRecord(r)?.['Region'] === region) as
    | Record<string, unknown>
    | undefined;
  // Read capacity is per-replica on a GlobalTable; the deploy region's
  // replica is the one `CreateTable` / `UpdateTable` provisions.
  // go-to-k/cdkd#2762: the table-level block takes its place on a table with
  // settings replication ENABLED (CloudFormation refuses it otherwise, and
  // refuses both at once).
  const rawRead =
    localReplica?.['ReadProvisionedThroughputSettings'] ?? properties[TABLE_READ_PROVISIONED_KEY];
  const rawWrite = properties['WriteProvisionedThroughputSettings'];
  const read = deriveReadCapacityUnits(asRecord(rawRead), source);
  const write = deriveWriteCapacityUnits(asRecord(rawWrite), source);
  // A DECLARED-but-unreadable value falling through to 5/5 is the silent
  // mis-size issue #1511 filed; an ABSENT block defaults silently, as before.
  if (read === undefined) {
    reportUnresolvedProvisionedCapacity(
      rawRead,
      'Read',
      source,
      { appliedUnits: DEFAULT_CAPACITY_UNITS },
      diagnostics,
      {
        blockName:
          localReplica?.['ReadProvisionedThroughputSettings'] !== undefined
            ? 'Replicas[local].ReadProvisionedThroughputSettings'
            : TABLE_READ_PROVISIONED_KEY,
      },
      maskSecrets
    );
  }
  if (write === undefined) {
    reportUnresolvedProvisionedCapacity(
      rawWrite,
      'Write',
      source,
      { appliedUnits: DEFAULT_CAPACITY_UNITS },
      diagnostics,
      { blockName: 'WriteProvisionedThroughputSettings' },
      maskSecrets
    );
  }
  return {
    ReadCapacityUnits: read ?? DEFAULT_CAPACITY_UNITS,
    WriteCapacityUnits: write ?? DEFAULT_CAPACITY_UNITS,
  };
}

/**
 * What an in-place update owes the table's `ProvisionedThroughput` while the
 * billing mode holds still: the literal capacity of each side whose block
 * changed, and the keys a moved read side leaves unsettled (the read block
 * lives on the local replica, or at the table level with settings replication
 * ENABLED; the two spell one value).
 *
 * A block carrying auto-scaling settings yields nothing, whatever else it
 * declares: the scaling policy owns that dimension, and its diff is applied by
 * step 4b and by {@link reconcileAutoScalingTargets}. A declared literal this
 * cannot read is reported, since the deploy otherwise succeeds with the old
 * capacity in place.
 */
function readTableCapacityChange(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  region: string,
  diagnostics: ThroughputDiagnostic[],
  maskSecrets: MaskerFn
): { read?: number; write?: number; readKeys: string[] } {
  const localBlockOf = (bag: Record<string, unknown>): unknown =>
    localReplicaEntry(bag, region)?.[TABLE_READ_PROVISIONED_KEY];
  const readBlockOf = (bag: Record<string, unknown>): unknown =>
    localBlockOf(bag) ?? bag[TABLE_READ_PROVISIONED_KEY];
  const literal = (
    block: unknown,
    previousBlock: unknown,
    side: 'Read' | 'Write',
    blockName: string
  ): number | undefined => {
    if (deepEqual(block, previousBlock)) return undefined;
    const settings = asRecord(block);
    if (settings?.[`${side}CapacityAutoScalingSettings`] !== undefined) return undefined;
    const units = coerceCfnInteger(settings?.[`${side}CapacityUnits`]);
    if (units === undefined) {
      reportUnresolvedProvisionedCapacity(
        block,
        side,
        'min',
        { suppressed: 'so cdkd sent no capacity for it and the old value stays on AWS' },
        diagnostics,
        { blockName },
        maskSecrets
      );
    }
    return units;
  };
  const read = literal(
    readBlockOf(properties),
    readBlockOf(previousProperties),
    'Read',
    localBlockOf(properties) !== undefined
      ? `Replicas[local].${TABLE_READ_PROVISIONED_KEY}`
      : TABLE_READ_PROVISIONED_KEY
  );
  const write = literal(
    properties[TABLE_WRITE_PROVISIONED_KEY],
    previousProperties[TABLE_WRITE_PROVISIONED_KEY],
    'Write',
    TABLE_WRITE_PROVISIONED_KEY
  );
  const declaredOnReplica =
    localBlockOf(properties) !== undefined || localBlockOf(previousProperties) !== undefined;
  const declaredOnTable =
    properties[TABLE_READ_PROVISIONED_KEY] !== undefined ||
    previousProperties[TABLE_READ_PROVISIONED_KEY] !== undefined;
  return {
    ...(read !== undefined && { read }),
    ...(write !== undefined && { write }),
    readKeys: [
      ...(declaredOnTable ? [TABLE_READ_PROVISIONED_KEY] : []),
      ...(declaredOnReplica ? ['Replicas'] : []),
    ],
  };
}

/**
 * Capacity units applied when a PROVISIONED template carries no usable
 * capacity value at all. Matches the pre-existing table-level default.
 */
const DEFAULT_CAPACITY_UNITS = 5;

/**
 * The four application-autoscaling scalable dimensions a DynamoDB
 * GlobalTable can register (Issue #1419). The `dynamodb:index:*` pair was
 * previously missing entirely, so a per-GSI `*CapacityAutoScalingSettings`
 * block never became a real scaling policy — the index stayed pinned at its
 * initial capacity forever.
 */
export type DynamoDBScalableDimension =
  | 'dynamodb:table:WriteCapacityUnits'
  | 'dynamodb:table:ReadCapacityUnits'
  | 'dynamodb:index:WriteCapacityUnits'
  | 'dynamodb:index:ReadCapacityUnits';

const DYNAMODB_SCALABLE_DIMENSIONS: ReadonlySet<string> = new Set<DynamoDBScalableDimension>([
  'dynamodb:table:WriteCapacityUnits',
  'dynamodb:table:ReadCapacityUnits',
  'dynamodb:index:WriteCapacityUnits',
  'dynamodb:index:ReadCapacityUnits',
]);

/** Whether an AWS-reported `ScalableDimension` is one of the four above. */
function isDynamoDBScalableDimension(value: unknown): value is DynamoDBScalableDimension {
  return typeof value === 'string' && DYNAMODB_SCALABLE_DIMENSIONS.has(value);
}

/**
 * One application-autoscaling target derivable from a CFn
 * `AWS::DynamoDB::GlobalTable` properties bag.
 */
export interface AutoScalingTargetSpec {
  dimension: DynamoDBScalableDimension;
  /** Index name for `dynamodb:index:*`; `undefined` at table level. */
  indexName?: string;
  /** Region whose application-autoscaling control plane owns the target. */
  region: string;
  /** The CFn `{Read,Write}CapacityAutoScalingSettings` block. */
  settings: Record<string, unknown>;
}

/**
 * Stable identity for an {@link AutoScalingTargetSpec}, used to diff the
 * previous template's targets against the desired ones.
 */
export function autoScalingTargetKey(spec: {
  dimension: DynamoDBScalableDimension;
  indexName?: string;
  region: string;
}): string {
  return `${spec.region}|${spec.dimension}|${spec.indexName ?? ''}`;
}

/**
 * The application-autoscaling `ResourceId` for a DynamoDB table or one of
 * its indexes. ONE spelling, shared by the register / policy / deregister
 * calls, the presence probe, and the target key — a divergence between any
 * two of those would silently register one target and look up another.
 */
export function autoScalingResourceId(tableName: string, indexName?: string): string {
  return indexName ? `table/${tableName}/index/${indexName}` : `table/${tableName}`;
}

/**
 * Test seam for the auto-scaling throttle retry's backoff, mirroring
 * `describeTypeRetryDelays`. Production leaves `sleep` undefined so
 * `withRetry`'s real schedule applies; a test injects a no-op so the ~47s
 * budget does not have to be waited out.
 */
export const autoScalingRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Polls `waitForReplicaGone` spends waiting for a replica to disappear.
 *
 * Named rather than inlined because it is a TERM of the per-resource deadline
 * arithmetic on this type's delete path (see
 * `GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`), which prices it through
 * {@link INDEX_SETTLE_POLL_INTERVAL_MS} — the sleep this loop now reads rather
 * than spelling its own `1000`, so the two cannot drift while that arithmetic
 * claims they agree.
 */
const REPLICA_GONE_WAIT_ATTEMPTS = 600;

/**
 * Polls the `--remove-protection` flip's ACTIVE wait spends
 * (`waitForTableActiveAfterUpdate`).
 *
 * EXPORTED and named rather than left as an inline default argument because it
 * is a TERM of the delete-path deadline arithmetic (see
 * `./dynamodb-delete-budget.ts`): on `cdkd destroy --remove-protection` it runs
 * FIRST, ahead of the #1521 gate, and the wait it performs is the same
 * indexes-settled one the rest of the path is about. The budget fence in the
 * unit suite reads THIS rather than a copied literal, after the sibling
 * arithmetic was twice found asserting a cap the provider no longer had.
 */
export const GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS = 600;

/**
 * Polls (1s apart) a vector index gets to settle: the `AWS::DynamoDB::Table`
 * index wait's budget, since a backfill runs as long there as here.
 */
const VECTOR_INDEX_SETTLE_ATTEMPTS = 1800;

/**
 * Polls `waitForTableGone` spends confirming the table is actually gone.
 *
 * EXPORTED, unlike its replica sibling, because the delete-path budget fence
 * reads it: this wait runs AFTER the index-busy retry loop and only when that
 * loop SUCCEEDS, which is what keeps it out of the loop's own worst case and
 * puts it into the late-success one (both spelled out on
 * `GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`).
 */
export const TABLE_GONE_WAIT_ATTEMPTS = 600;

/**
 * Test seam for the index-busy `DeleteTable` retry's backoff (issue #1830),
 * mirroring {@link autoScalingRetryDelays}. Production leaves `sleep`
 * undefined so `withRetry`'s real schedule applies; a test injects a no-op so
 * the ~47s of backoff at this type's budget
 * (`GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`) does not have to be waited
 * out. Kept SEPARATE from the
 * auto-scaling seam so a test can slow one path without silencing the other.
 */
export const deleteTableRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Resource ids per `DescribeScalableTargets` request. Kept at the API's
 * documented per-page ceiling rather than a larger guess — the request is
 * paginated anyway, and over-asking risks a `ValidationException` that would
 * degrade the probe to "presence unknown" for the whole region.
 */
const DESCRIBE_SCALABLE_TARGETS_BATCH = 50;

/**
 * Collect every application-autoscaling target a CFn GlobalTable properties
 * bag declares (Issue #1419).
 *
 * Where each dimension lives in the CFn shape — this is NOT symmetric, and
 * the asymmetry is the reason the per-index targets were missed:
 *
 * | dimension                            | CFn source                                                                    | region |
 * | ------------------------------------ | ----------------------------------------------------------------------------- | ------ |
 * | `dynamodb:table:WriteCapacityUnits`  | `WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings`          | local  |
 * | `dynamodb:index:WriteCapacityUnits`  | `GlobalSecondaryIndexes[].WriteProvisionedThroughputSettings.…`                | local  |
 * | `dynamodb:table:ReadCapacityUnits`   | `Replicas[].ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings` | replica's |
 * | `dynamodb:index:ReadCapacityUnits`   | `Replicas[].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings.…`      | replica's |
 *
 * WRITE capacity on a global table is owned by the source region only, so
 * both write dimensions register in the LOCAL region. READ capacity is
 * per-replica: each replica registers its own target with its own region's
 * application-autoscaling endpoint — including the LOCAL replica, whose
 * read target was never registered by any code path before this change
 * (`update()`'s replica loops all `continue` on the local region).
 *
 * A replica entry with no `Region` is skipped rather than defaulted: a
 * target registered against the wrong region's control plane is invisible
 * to every later diff and would leak on destroy.
 */
export function collectAutoScalingTargets(
  properties: Record<string, unknown>,
  localRegion: string
): AutoScalingTargetSpec[] {
  const specs: AutoScalingTargetSpec[] = [];

  const tableWrite = asRecord(
    asRecord(properties['WriteProvisionedThroughputSettings'])?.['WriteCapacityAutoScalingSettings']
  );
  if (tableWrite) {
    specs.push({
      dimension: 'dynamodb:table:WriteCapacityUnits',
      region: localRegion,
      settings: tableWrite,
    });
  }

  const cfnIndexes = properties['GlobalSecondaryIndexes'];
  if (Array.isArray(cfnIndexes)) {
    for (const entry of cfnIndexes) {
      const gsi = asRecord(entry);
      const indexName = gsi?.['IndexName'];
      if (!gsi || typeof indexName !== 'string') continue;
      const indexWrite = asRecord(
        asRecord(gsi['WriteProvisionedThroughputSettings'])?.['WriteCapacityAutoScalingSettings']
      );
      if (indexWrite) {
        specs.push({
          dimension: 'dynamodb:index:WriteCapacityUnits',
          indexName,
          region: localRegion,
          settings: indexWrite,
        });
      }
    }
  }

  const replicas = properties['Replicas'];
  if (Array.isArray(replicas)) {
    for (const replicaEntry of replicas) {
      const replica = asRecord(replicaEntry);
      const region = replica?.['Region'];
      if (!replica || typeof region !== 'string') continue;

      const replicaRead = asRecord(
        asRecord(replica['ReadProvisionedThroughputSettings'])?.['ReadCapacityAutoScalingSettings']
      );
      if (replicaRead) {
        specs.push({
          dimension: 'dynamodb:table:ReadCapacityUnits',
          region,
          settings: replicaRead,
        });
      }

      const replicaIndexes = replica['GlobalSecondaryIndexes'];
      if (!Array.isArray(replicaIndexes)) continue;
      for (const entry of replicaIndexes) {
        const replicaIndex = asRecord(entry);
        const indexName = replicaIndex?.['IndexName'];
        if (!replicaIndex || typeof indexName !== 'string') continue;
        const indexRead = asRecord(
          asRecord(replicaIndex['ReadProvisionedThroughputSettings'])?.[
            'ReadCapacityAutoScalingSettings'
          ]
        );
        if (indexRead) {
          specs.push({
            dimension: 'dynamodb:index:ReadCapacityUnits',
            indexName,
            region,
            settings: indexRead,
          });
        }
      }
    }
  }

  return specs;
}

/**
 * How long `addReplica` waits out a same-named regional copy that is still
 * DELETING (issue #3569): polls x interval, ~15 minutes. A regional copy has
 * been measured to linger for minutes after it left the source table's
 * `Replicas[]`.
 */
export const REPLICA_COPY_RELEASE_POLLS = 180;
export const REPLICA_COPY_RELEASE_POLL_MS = 5000;

/**
 * How long DynamoDB refuses a second `DeletionProtectionEnabled` change on one
 * table after the first (measured 15000 ms, us-west-2, 2026-10-26), plus a
 * second of margin (go-to-k/cdkd#5355).
 */
export const DELETION_PROTECTION_REFLIP_MS = 16_000;

/**
 * Restates DynamoDB's encryption-change quota in the update's wraps, which
 * withhold AWS's text (go-to-k/cdkd#5399's integ). A table takes 4
 * encryption changes in a 24-hour window and then one every 6 hours
 * (`LimitExceededException`: "Encryption mode changes are limited in the 24h
 * window ...", measured us-east-1, 2026-10-28); reduced to the class name, the
 * refusal told the operator nothing. Returns a leading space plus the
 * sentence, or `''`.
 */
export function relayedEncryptionChangeLimit(withheldText: string): string {
  return /Encryption mode changes are limited/i.test(withheldText)
    ? ' AWS limits a table to 4 encryption changes in 24 hours, then one every 6 hours; ' +
        'retry the change later (--verbose shows when AWS allows the next one).'
    : '';
}

/**
 * The Kinesis destination statuses a disable has not settled from
 * (go-to-k/cdkd#5399): the read-back's present set plus `DISABLING`.
 */
const KINESIS_DISABLE_UNSETTLED: ReadonlySet<string> = new Set([
  'ACTIVE',
  'ENABLING',
  'UPDATING',
  'DISABLING',
]);

/**
 * {@link DynamoDBGlobalTableProvider.waitForReplicaProtectionSettled}'s cap:
 * 60 polls 5 s apart, five minutes against the ~30 s a replica's protection
 * change took to settle when measured (go-to-k/cdkd#5355).
 */
export const REPLICA_PROTECTION_SETTLE_POLLS = 60;
export const REPLICA_PROTECTION_SETTLE_POLL_MS = 5000;
/**
 * {@link DynamoDBGlobalTableProvider.retrySettlingRefusal}'s schedule: 8
 * attempts, 2 s doubling to a 30 s cap — about two minutes, the bound the
 * `AWS::DynamoDB::Table` provider's twin uses for the same refusals.
 */
export const SETTLING_RETRY_ATTEMPTS = 8;
export const SETTLING_RETRY_INITIAL_MS = 2000;
/** Replica-add attempts in total, the first included. */
export const REPLICA_COPY_RELEASE_ATTEMPTS = 3;

/**
 * AWS's refusal of a `ReplicaUpdates[].Create` whose region already holds a
 * table of that name. Keyed on the MESSAGE: the error class is a generic
 * `ValidationException`, shared with every other malformed replica request.
 */
export function isReplicaCopyExistsRefusal(error: unknown): boolean {
  return (
    error instanceof Error && /one or more replicas already existed as tables/i.test(error.message)
  );
}

/**
 * `Replicas` with every entry's `GlobalSecondaryIndexes` key REMOVED — the
 * replay-CREATE GSI omit arm's prune of the per-replica index blocks (issue
 * #1741, second instance), which name indexes that create does not build.
 *
 * Copy-on-write: an entry that carries the key is copied without it, every
 * other entry (a non-object included — an unresolved intrinsic must reach AWS
 * as-is, not be rewritten) is passed through by reference, and the caller's
 * array is never mutated. The caller's bag IS `previousState.properties` on
 * this path. A non-array container is returned untouched with `changed: false`.
 *
 * `withdrawnRegions` lists the `Region` of each entry whose block was a
 * non-empty ARRAY, i.e. one `toSdkReplicaGlobalSecondaryIndexes` would have
 * turned into a real override on the wire; a malformed or empty block was
 * never sendable, so withdrawing it is not a loss worth announcing.
 */
export function withdrawReplicaIndexBlocks(replicas: unknown): {
  replicas: unknown;
  changed: boolean;
  withdrawnRegions: string[];
} {
  if (!Array.isArray(replicas)) return { replicas, changed: false, withdrawnRegions: [] };
  let changed = false;
  const withdrawnRegions: string[] = [];
  const out = replicas.map((entry) => {
    const replica = asRecord(entry);
    if (!replica || !Object.prototype.hasOwnProperty.call(replica, 'GlobalSecondaryIndexes')) {
      return entry;
    }
    changed = true;
    const block = replica['GlobalSecondaryIndexes'];
    const region = replica['Region'];
    if (Array.isArray(block) && block.length > 0 && typeof region === 'string') {
      withdrawnRegions.push(region);
    }
    const copy = { ...replica };
    delete copy['GlobalSecondaryIndexes'];
    return copy;
  });
  return { replicas: changed ? out : replicas, changed, withdrawnRegions };
}

/** Computed-key spelling of the stream block, for the issue #1723 folds. */
const STREAM_SPECIFICATION_KEY = 'StreamSpecification';

/**
 * The stream `create()` enables on a table whose template declares NONE, in
 * the CFn shape, when that is decidable from the bag alone (issue #1723) —
 * `undefined` otherwise.
 *
 * ONE helper for the three sites that must agree: `create()` records it,
 * `update()` records it (when the live table confirms it), and
 * `canonicalizeDesiredProperties` folds it into BOTH diff sides. Were any two to
 * key off different predicates, an unchanged template would redeploy forever.
 *
 * Fires only on the region-INDEPENDENT half of `create()`'s `needsStream`
 * (`replicas.length > 1`). The other half — a single replica in a region other
 * than the deploy region, or a single replica whose `Region` is still an
 * unresolved intrinsic — needs the deploy region, which the pure, synchronous
 * twin does not have; that half still auto-enables the stream and still records
 * nothing. That is harmless for drift (the walk visits only the top-level keys a
 * record HAS) and for the next diff: a later declaration of the same stream
 * diffs as an UPDATE, but `update()`'s live-stream gate sends nothing for it,
 * and the record then carries the declared stream. A table that DROPS to one
 * replica likewise loses the recorded stream from its record (a one-time diff
 * line beside its `Replicas` change) while AWS keeps the stream.
 *
 * Any `MultiRegionConsistency` at all disables it. The key is a silent-drop
 * for this provider, so the three sites see different bags for one template:
 * `create()` / `update()` read the RAW bag (key present), while the twin reads
 * `DiffCalculator`'s bags, which on the SDK route (`--allow-unsupported-properties`)
 * have the key STRIPPED from both sides — there the twin folds BOTH sides
 * alike whatever `create()` recorded, so the diff stays NO_CHANGE. On the Cloud
 * Control route (the key's default) nothing is stripped and only the desired
 * side is folded, so the key must stop the fold there, for EVENTUAL as much as
 * for STRONG: whether Cloud Control ever holds a stream-less multi-replica
 * EVENTUAL table is not something the fold should rest on.
 *
 * Keyed on ABSENCE, not `== null`: an explicitly declared `StreamSpecification`
 * (even a malformed `null` / `''`) is the template's own statement, and folding
 * a declared value would silence the diff that reports it.
 */
export function replicationImpliedStreamSpecification(
  properties: Record<string, unknown>
): { StreamViewType: 'NEW_AND_OLD_IMAGES' } | undefined {
  if (properties[STREAM_SPECIFICATION_KEY] !== undefined) return undefined;
  // See the JSDoc: any declared consistency mode leaves the bag unfolded.
  if (properties['MultiRegionConsistency'] !== undefined) return undefined;
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas) || replicas.length <= 1) return undefined;
  return { StreamViewType: 'NEW_AND_OLD_IMAGES' };
}

/**
 * Every attribute name some KEY SCHEMA in the desired template references:
 * the table's own `KeySchema`, each GSI's, and each LSI's. This is the set
 * the `AttributeDefinitions`-removal guard in `update()` tests membership
 * against — a removed attribute still in this set is a genuine
 * redefine-in-place (replacement required); one outside it is the normal
 * bookkeeping of a GSI deletion and must NOT force a replacement.
 *
 * Malformed / intrinsic-valued entries contribute nothing. For the `update()`
 * guard that errs on the PERMISSIVE side — correct there, because that guard's
 * failure mode is a forced replacement of a live table, and AWS still rejects a
 * genuinely-bad `UpdateTable` loudly. For the create-path prune below it errs
 * the other way (an unreadable LSI key schema prunes MORE), which is only
 * reachable on a bag AWS would reject anyway.
 *
 * `options.indexListKeys` narrows which index lists contribute, for the ONE
 * caller whose question is not "what does the template reference" but "what
 * will this call actually key on" — `create()`'s replay-CREATE GSI omit arm
 * (issue #1741), which sends NO indexes and therefore must not count the
 * omitted block's key attributes as still-referenced. It defaults to BOTH
 * lists, so the `update()` guard above reads exactly as it did before.
 */
export function collectDesiredKeyAttributeNames(
  properties: Record<string, unknown>,
  options?: { indexListKeys?: readonly ('GlobalSecondaryIndexes' | 'LocalSecondaryIndexes')[] }
): Set<string> {
  const names = new Set<string>();
  const addKeySchema = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const element of value) {
      const name = asRecord(element)?.['AttributeName'];
      if (typeof name === 'string') names.add(name);
    }
  };
  addKeySchema(properties['KeySchema']);
  const indexListKeys = options?.indexListKeys ?? [
    'GlobalSecondaryIndexes',
    'LocalSecondaryIndexes',
  ];
  for (const indexListKey of indexListKeys) {
    const indexes = properties[indexListKey];
    if (!Array.isArray(indexes)) continue;
    for (const index of indexes) {
      addKeySchema(asRecord(index)?.['KeySchema']);
    }
  }
  // go-to-k/cdkd#2762: a vector index's `SearchSchema` keys on a defined
  // attribute too, and no caller's narrowing omits the vector indexes.
  const vectorIndexes = properties['VectorIndexes'];
  if (Array.isArray(vectorIndexes)) {
    for (const index of vectorIndexes) addKeySchema(asRecord(index)?.['SearchSchema']);
  }
  return names;
}

/** Narrow an unknown CFn sub-object to a record (or `undefined`). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The sentinel DynamoDB accepts to CLEAR a per-GSI on-demand request-unit
 * ceiling (issue #1423). Live-verified against real AWS: `UpdateTable` with
 * `GlobalSecondaryIndexUpdates[].Update.OnDemandThroughput = {-1, -1}` is
 * accepted, and the member reads back ABSENT from `DescribeTable` afterwards —
 * so it is genuinely reset to unlimited rather than stored as -1. Any drift /
 * read-back comparison must therefore expect ABSENCE, not this value.
 */
const ON_DEMAND_LIMIT_RESET = -1;

// The index-busy DELETE rule — `hasTransitionalIndex`, the message-keyed
// `isIndexBusyDeleteError` classifier, the two per-type retry budgets /
// `DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS`, `DELETE_INDEX_WAIT_PROCEED_NOTE`, the
// settle poll and the retry loop itself — is IMPORTED from
// `../dynamodb-index-busy-delete.ts` rather than spelled here. It shipped in
// this file for issue #1830 and moved out for issue #1931, when
// `dynamodb-table-provider.ts` turned out to need every one of them for the
// same AWS refusal. Same reason as `../dynamodb-warm-throughput.ts`: a rule two
// providers answer is a rule that must not be answerable two ways.

// TWO numeric readers, chosen per site by what the number is FOR (issue #3135):
//
//  - `coerceCfnInteger` (`../config-shape.ts`) reads every value this file
//    FORWARDS to AWS — a `ProvisionedThroughput` / `OnDemandThroughput` member,
//    a `MinCapacity` / `SeedCapacity` the derivation turns into one — AND the
//    diagnostic / mirror predicates paired with a forwarder
//    (`reportUnresolvedRawMember`, `explicitCovers`, the `undefined` tests in
//    `collectUncomparableCapacityGsiNames` and `toSdkReplicaThroughputOverrides`). It is
//    CloudFormation's MEASURED DynamoDB Integer grammar, `/^[+-]?\d+$/` with NO
//    trim (table on `toCfnInteger` in `../dynamodb-warm-throughput.ts`): a
//    padded `" 7 "`, `"0x9"`, `"1e1"` or `"6.5"` is a template CloudFormation
//    REFUSES, and `Number()` forwarded `7` / `9` / `10` for it. A predicate
//    paired with a forwarder MUST read through the same function: on the wider
//    reader `" 7 "` counted as "covered" / "determined" while the forwarder
//    beside it dropped the value, so the default stood in silently or a live
//    baseline read a 5/5 fallback as a scale-down.
//  - `toFiniteNumber` (`../dynamodb-warm-throughput.ts`) reads the LIVE side
//    only — a `DescribeTable` number compared against the desired one. A guard
//    is safe on the wider set: over-acceptance can only skip fewer calls.
//
// `toFiniteNumber` was a local copy until the review of issue #1857's PR: this
// file's spelling, `dynamodb-table-provider.ts`'s `capacityNumber` and the
// shared module's own member parser were three hand-written statements of one
// rule, which is the divergence that module exists to prevent. Both readers
// refuse a whitespace-only string, which `Number('   ')` reads as **0** — a
// request for ZERO capacity that nobody declared.
//
// `WARM_THROUGHPUT_MEMBERS` / `WarmThroughputSpec` / `WarmThroughputCoercion` /
// `coerceWarmThroughput` live there too — the same stringly-typed-CFn coercion
// `AWS::DynamoDB::Table` shipped for issue #1808, so one type cannot start
// accepting a shape the other refuses. Only that Table spelling ever shipped;
// the GlobalTable side arrived with issue #1857, so this is the Table rule
// LIFTED rather than two shipped rules merged. The one shape the drafted
// GlobalTable spelling answered differently was a whitespace-only string, where
// a bare `Number('   ')` is 0 rather than NaN; the shared rule takes the
// REFUSING answer, since that is not a capacity anyone declared.

/**
 * The sentence every "did not resolve to a number" diagnostic ends with, so a
 * user whose value IS a number — `" 7 "`, `"1e1"` — learns why it was still
 * dropped (issue #3135). Named once because the three diagnostics that carry
 * it are worded per outcome and would otherwise each restate the grammar.
 */
const CFN_INTEGER_SPELLING_NOTE =
  ` CloudFormation types this member as an Integer and accepts only an optional sign ` +
  `and decimal digits (no surrounding whitespace, hex, exponent or decimal point), so a ` +
  `spelling it would reject is treated the same way.`;

/**
 * Build the {@link ThroughputDiagnostic} for a `WarmThroughput` block that did
 * not survive coercion intact, or `undefined` when it did.
 *
 * Two distinct outcomes, worded differently because the remedy differs:
 *  - PARTIAL — one member dropped, the other still sent. The call goes ahead;
 *    the user needs to know which half silently did not.
 *  - REFUSED — nothing sendable. No call is made for the property at all,
 *    which is the point (issue #1857 defect 3): forwarding the malformed block
 *    would surface as an AWS validation error that names neither cdkd nor the
 *    property.
 */
function warmThroughputDiagnostic(
  raw: unknown,
  coercion: WarmThroughputCoercion,
  indexName: string | undefined
): ThroughputDiagnostic | undefined {
  if (raw === undefined || raw === null) return undefined;
  const scope = { kind: 'unresolved-member' as const, member: 'WarmThroughput' };
  const dropped = coercion.droppedMembers.join(' / ');
  if (coercion.spec) {
    if (coercion.droppedMembers.length === 0) return undefined;
    const kept = WARM_THROUGHPUT_MEMBERS.filter((m) => coercion.spec?.[m] !== undefined).join(
      ' / '
    );
    return {
      ...scope,
      ...(indexName !== undefined && { indexName }),
      message:
        `WarmThroughput.${dropped} did not resolve to a number and was DROPPED; ` +
        `${kept} is still sent. AWS types these as numbers, so a quoted "12000" is ` +
        `fine but an unresolved intrinsic or an object is not. The dropped member ` +
        `keeps its current AWS value until the template supplies a usable one.` +
        CFN_INTEGER_SPELLING_NOTE,
    };
  }
  return {
    ...scope,
    ...(indexName !== undefined && { indexName }),
    message:
      `WarmThroughput is declared but no member resolved to a number` +
      `${dropped ? ` (${dropped})` : ''}, so the whole block is REFUSED and not sent. ` +
      `Forwarding it would fail as an opaque AWS validation error naming neither cdkd ` +
      `nor the property. Set WarmThroughput.ReadUnitsPerSecond / WriteUnitsPerSecond to ` +
      `numbers, or remove the block. Nothing else about the index is affected.` +
      CFN_INTEGER_SPELLING_NOTE,
  };
}

// `isWarmThroughputDecrease` — the decrease guard issue #1857 asked for —
// lives in `../dynamodb-warm-throughput.ts` alongside the coercion. It is the
// SAME rule `AWS::DynamoDB::Table` shipped for issue #1768, adopted verbatim
// rather than re-derived: the GlobalTable draft was compared against it over
// every declared / mixed / equal / above / absent-live / unusable-live /
// empty-spec combination and agreed on all of them, so writing a second copy
// would have been pure drift risk on a three-clause fail-open rule whose
// measured AWS evidence lives in the shared header.

/**
 * What went wrong with ONE throughput member, reported by the module-level
 * pure translators rather than logged by them (issues #1428 / #1444).
 *
 * These helpers have five call sites (`create`, `addReplica`, the replica
 * modify action, and both sides of the GSI diff) and no logger, so they
 * COLLECT instead of logging — which is also what makes the desired /
 * previous asymmetry expressible: only the DESIRED-side call sites pass a
 * collector, so a garbage value already recorded in cdkd state cannot make
 * every subsequent deploy shout about a template the user never wrote.
 *
 * `message` is a finished sentence: the caller's only job is to pick a level
 * and prefix the resource. Building it here keeps the wording identical
 * across the five sites.
 */
export interface ThroughputDiagnostic {
  /**
   * `unresolved-member` — the template DECLARED the member but its value did
   * not coerce to a number (an unresolved `{Ref: …}`, an object, `''`). What
   * FOLLOWS from that differs by side, and the message says which: an
   * ON-DEMAND ceiling is SUPPRESSED (nothing is sent, the live AWS value is
   * left alone), while a PROVISIONED capacity CANNOT be — AWS requires a
   * concrete `ProvisionedThroughput` on a provisioned table and on every GSI
   * of one — so cdkd substitutes {@link DEFAULT_CAPACITY_UNITS} and says so
   * (issue #1511). The one provisioned exception is a replica's
   * `ProvisionedThroughputOverride`, whose absence means "inherit the source
   * table", so it suppresses like the on-demand side.
   *
   * `billing-mode-mismatch` — an explicitly SDK-shaped block contradicts the
   * table's billing mode (a `ProvisionedThroughput` on a PAY_PER_REQUEST
   * table or vice versa). AWS rejects both, so the block is dropped instead
   * of forwarded into a guaranteed 400.
   */
  readonly kind: 'unresolved-member' | 'billing-mode-mismatch';
  /** The index the member belongs to; absent for a table-level member. */
  readonly indexName?: string;
  /** The CFn / SDK member name, for the caller's own bookkeeping. */
  readonly member: string;
  /** Finished, user-facing sentence. */
  readonly message: string;
}

/**
 * Merge an explicitly-supplied, already-SDK-shaped throughput block over a
 * derived one, PER MEMBER (issue #1428).
 *
 * The CFn schema forbids `ProvisionedThroughput` / `OnDemandThroughput` /
 * `*ThroughputOverride` on `AWS::DynamoDB::GlobalTable`, so this only fires
 * for pre-#1387 cdkd state and hand-authored templates — but those ARE a
 * first-class cdkd surface (`cdkd import --migrate-from-cloudformation`), and
 * the pre-fix code forwarded such a block VERBATIM. Three defects followed, and fixing any subset leaves a
 * live one, which is why this helper does all three at once:
 *
 *  1. **Coercion.** The verbatim forward was the ONE path that skipped the
 *     numeric reader (`coerceCfnInteger` since issue #3135), so a
 *     stringly-typed CFn `"5"` reached the SDK unnormalized while every
 *     derived value was a number.
 *  2. **Per-member merge.** Whole-block replacement meant a PARTIAL explicit
 *     block SUPPRESSED valid derived siblings — an explicit
 *     `{MaxReadRequestUnits: 41}` discarded a perfectly good
 *     `WriteOnDemandThroughputSettings.MaxWriteRequestUnits` from the same
 *     template.
 *  3. **Billing gate.** That is the CALLER's job (it owns `billingMode`), but
 *     it only works because this helper never emits a block the caller did
 *     not ask for.
 *
 * WARN-AND-FALL-BACK, never throw. Three earlier designs are recorded on
 * issue #1428 and each was broken by the same lever: a present-but-
 * uncoercible member that THREW made a stack whose STATE carried the garbage
 * permanently undeployable (the helper also runs on `previousProperties`),
 * and throwing from the replica path threw AFTER `CreateTable` had already
 * committed a real table. So an uncoercible member is dropped, reported
 * through `diagnostics`, and the derived value stands in.
 *
 * Returns `undefined` when neither side contributes a single member — an
 * EMPTY block is not a safe stand-in, because AWS documents an empty
 * `ProvisionedThroughputOverride` / `OnDemandThroughputOverride` as "inherit
 * the source table's settings".
 */
function mergeExplicitThroughputBlock<T>(
  explicit: Record<string, unknown> | undefined,
  derived: Partial<Record<keyof T & string, number>> | undefined,
  members: ReadonlyArray<keyof T & string>,
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string; blockName: string },
  // Trailing + identity-defaulted (issue #2178), matching the sibling
  // `dynamodb-table-provider.ts` convention: absent still means UNMASKED, so
  // every existing caller keeps compiling. The walk has to happen BEFORE the
  // `JSON.stringify` below, never after it: a provider's `properties` bag
  // arrives RESOLVED, so a `{{resolve:secretsmanager:...}}` member is already
  // plaintext here, and `JSON.stringify` escapes `"` / `\` / newlines out of
  // the finished line so a message-level mask can no longer find the needle.
  maskSecrets: MaskerFn = (text) => text
): T | undefined {
  const out: Record<string, number> = {};
  for (const member of members) {
    if (explicit && explicit[member] !== undefined) {
      const coerced = coerceCfnInteger(explicit[member]);
      if (coerced !== undefined) {
        out[member] = coerced;
        continue;
      }
      // Name what STANDS IN for the ignored member, when something does:
      // on an explicit-only shape (no CFn `*ProvisionedThroughputSettings`
      // block beside the SDK-shaped one) `reportUnresolvedProvisionedCapacity`
      // has no block to blame and never fires, so this line is the only place
      // the user learns that the derived default (5, on a PROVISIONED
      // capacity) went to AWS instead of the value they wrote.
      const standIn = derived?.[member];
      diagnostics?.push({
        kind: 'unresolved-member',
        ...(context.indexName !== undefined && { indexName: context.indexName }),
        member,
        message:
          `${context.blockName}.${member} is present but did not resolve to a number ` +
          `(${JSON.stringify(maskDeep(explicit[member], maskSecrets))?.slice(0, 80)}), so ` +
          (typeof standIn === 'number'
            ? `it was ignored and ${standIn} was sent instead. `
            : `it was ignored. `) +
          `This is usually an unresolved intrinsic; resolve it to a literal.` +
          CFN_INTEGER_SPELLING_NOTE,
      });
    }
    const derivedValue = derived?.[member];
    if (typeof derivedValue === 'number') out[member] = derivedValue;
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/**
 * Report a member the template DECLARED whose value did not coerce (#1444 A).
 *
 * The diagnostic has to be raised WHERE THE VALUE IS LOST — inside the
 * translation — not from the per-GSI reset gate in `update()`. That gate only
 * runs for an index the diff already classified `modified` AND only when a
 * previous ceiling happened to exist AND only when the billing mode did not
 * flip, so the very same template defect was silent in the two most likely
 * cases: a FIRST-TIME set (both translated sides lack the member, so the index
 * is not `modified` at all and the loop never runs) and a BILLING FLIP (the
 * gate short-circuits). The defect is identical in all three; only the
 * diagnostic was conditional.
 */
function reportUnresolvedRawMember(
  rawValue: unknown,
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string; blockName: string; member: string },
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): void {
  if (!diagnostics) return;
  if (rawValue === undefined) return;
  // The FORWARDER's reader, not the guard's: a value this predicate calls
  // usable is one `toSdkGlobalSecondaryIndexes` / `collectTableOnDemandCeilings`
  // will actually send, so a padded `" 7 "` is reported here exactly because
  // it is dropped there (issue #3135).
  if (coerceCfnInteger(rawValue) !== undefined) return;
  diagnostics.push({
    kind: 'unresolved-member',
    ...(context.indexName !== undefined && { indexName: context.indexName }),
    member: context.member,
    message:
      `${context.blockName}.${context.member} is declared but did not resolve to a ` +
      `number (${JSON.stringify(maskDeep(rawValue, maskSecrets))?.slice(0, 80)}), so no ` +
      `throughput value was ` +
      `sent for it and the live AWS setting was left unchanged. This is usually an ` +
      `unresolved intrinsic; resolve it to a literal to apply the limit, or remove the ` +
      `property entirely to clear it.` +
      CFN_INTEGER_SPELLING_NOTE,
  });
}

/**
 * Which member of a `*ProvisionedThroughputSettings` block to blame when the
 * derivation came back `undefined` (issue #1511).
 *
 * The derivation reports only "no number", so the member is re-derived here in
 * the SAME order {@link deriveWriteCapacityUnits} / {@link deriveReadCapacityUnits}
 * / {@link pickAutoScalingCapacity} consult members — the literal first, then
 * the auto-scaling block's `source`-selected member. Reaching this function at
 * all means every one of them failed, so the first DECLARED one is the value
 * the user was trying to set.
 *
 * `relPath` is relative to the block, `''` meaning the block ITSELF is the
 * unusable value (a string / array / bare unresolved intrinsic, or an object
 * carrying no capacity member at all).
 *
 * Returns `undefined` for an ABSENT block: defaulting there is the documented
 * pre-existing behavior for a template that never asked for a capacity, and
 * warning about it would shout on every deploy of a table that is fine.
 */
function blameUnresolvedProvisionedMember(
  rawSettings: unknown,
  side: 'Read' | 'Write',
  source: CapacitySource
): { relPath: string; value: unknown } | undefined {
  if (rawSettings === undefined) return undefined;
  const settings = asRecord(rawSettings);
  if (!settings || isUnresolvedIntrinsicBlock(settings)) return { relPath: '', value: rawSettings };
  const literal = settings[`${side}CapacityUnits`];
  if (literal !== undefined) return { relPath: `${side}CapacityUnits`, value: literal };
  const autoKey = `${side}CapacityAutoScalingSettings`;
  const rawAutoScaling = settings[autoKey];
  if (rawAutoScaling === undefined) return { relPath: '', value: rawSettings };
  const autoScaling = asRecord(rawAutoScaling);
  if (!autoScaling || isUnresolvedIntrinsicBlock(autoScaling)) {
    return { relPath: autoKey, value: rawAutoScaling };
  }
  const order =
    source === 'seed' ? ['SeedCapacity', 'MinCapacity'] : ['MinCapacity', 'SeedCapacity'];
  for (const member of order) {
    const value = autoScaling[member];
    if (value !== undefined) return { relPath: `${autoKey}.${member}`, value };
  }
  return { relPath: autoKey, value: rawAutoScaling };
}

/**
 * Report a DECLARED provisioned capacity the template could not resolve — the
 * PROVISIONED twin of {@link reportUnresolvedRawMember} (issue #1511).
 *
 * The two sides need different wording because they have different outcomes,
 * which is exactly why #1503 deferred this half. An unreadable ON-DEMAND
 * ceiling is SUPPRESSED (nothing is sent, the live ceiling stands), so its
 * diagnostic says "nothing was sent". A provisioned table cannot suppress —
 * AWS requires `ProvisionedThroughput` on the table and on every GSI of it —
 * so the derivation falls through to {@link DEFAULT_CAPACITY_UNITS} and a
 * table the template explicitly sized is deployed at 5/5. That is a throttling
 * symptom days later rather than an error, which is what makes naming it here
 * worth a warning at all. The one provisioned site that CAN suppress is a
 * replica's `ProvisionedThroughputOverride` (absent = inherit the source
 * table), hence the `suppressed` outcome arm.
 *
 * Caller decides WHEN: only when the derivation returned `undefined` AND no
 * explicit SDK-shaped member is standing in for it, so the warning always
 * describes what actually reached AWS.
 */
function reportUnresolvedProvisionedCapacity(
  rawSettings: unknown,
  side: 'Read' | 'Write',
  source: CapacitySource,
  outcome: { readonly appliedUnits: number } | { readonly suppressed: string },
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string; blockName: string },
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): void {
  if (!diagnostics) return;
  const blame = blameUnresolvedProvisionedMember(rawSettings, side, source);
  if (!blame) return;
  const path = blame.relPath ? `${context.blockName}.${blame.relPath}` : context.blockName;
  // Every substituting caller passes the default today, so the sentence names
  // it unconditionally; the value stays a parameter because it is what the
  // user has to recognize in `DescribeTable`, and hard-coding "5" here would
  // silently lie the day a caller substitutes something else.
  const consequence =
    'appliedUnits' in outcome
      ? `so cdkd sent ${outcome.appliedUnits} capacity units instead ` +
        `(its default — AWS requires a concrete provisioned capacity here, ` +
        `so there was nothing to suppress)`
      : outcome.suppressed;
  diagnostics.push({
    kind: 'unresolved-member',
    ...(context.indexName !== undefined && { indexName: context.indexName }),
    // The terminal member name — or, when the BLOCK itself is what could not be
    // read, the block's own last segment. Taken off `relPath` rather than the
    // joined path so a block name carrying dots
    // (`Replicas[local].GlobalSecondaryIndexes[].Read…Settings`) reports the
    // member it names, not the tail of its container chain.
    member: blame.relPath
      ? blame.relPath.slice(blame.relPath.lastIndexOf('.') + 1)
      : context.blockName.slice(context.blockName.lastIndexOf('.') + 1),
    message:
      `${path} is declared but did not resolve to a number ` +
      `(${JSON.stringify(maskDeep(blame.value, maskSecrets))?.slice(0, 80)}), ${consequence}. ` +
      `This is usually an ` +
      `unresolved intrinsic; resolve it to a literal to apply the capacity you declared.` +
      CFN_INTEGER_SPELLING_NOTE,
  });
}

/**
 * Derive a single WRITE capacity number from a CFn
 * `WriteProvisionedThroughputSettings` block.
 *
 * The `AWS::DynamoDB::GlobalTable` registry schema (verified 2026-08-09 via
 * `aws cloudformation describe-type`) declares this block with exactly ONE
 * member — `WriteCapacityAutoScalingSettings` — i.e. write capacity on a
 * GlobalTable is ALWAYS auto-scaled; there is no literal `WriteCapacityUnits`
 * (that is why CDK 2.244's `TableV2` rejects `Capacity.fixed()` for write).
 * `CreateTable` / `UpdateTable` still require a concrete starting number;
 * which member of the auto-scaling block supplies it is context-dependent
 * (`MinCapacity` on a create, `SeedCapacity` on a billing-mode flip) — see
 * {@link CapacitySource}, which `source` selects.
 *
 * A literal `WriteCapacityUnits` is still honored first: the CFn schema
 * forbids it, but hand-authored / imported templates, cdkd state written
 * before this helper existed and `readCurrentState`'s flat shape can carry it,
 * and honoring it is strictly more faithful than ignoring it. An in-place
 * change of it goes through {@link readTableCapacityChange}.
 *
 * `source` selects between the two contexts CloudFormation distinguishes —
 * see {@link CapacitySource}. Defaults to `'min'`, the common case.
 */
export function deriveWriteCapacityUnits(
  settings: Record<string, unknown> | undefined,
  source: CapacitySource = 'min'
): number | undefined {
  if (!settings) return undefined;
  const literal = coerceCfnInteger(settings['WriteCapacityUnits']);
  if (literal !== undefined) return literal;
  const autoScaling = asRecord(settings['WriteCapacityAutoScalingSettings']);
  if (!autoScaling) return undefined;
  return pickAutoScalingCapacity(autoScaling, source);
}

/**
 * Derive a single READ capacity number from a CFn
 * `ReadProvisionedThroughputSettings` block (both the per-replica shape,
 * which carries `ReadCapacityUnits` + `ReadCapacityAutoScalingSettings`, and
 * the GSI/table-level `GlobalReadProvisionedThroughputSettings` shape, which
 * carries only `ReadCapacityUnits`). Same {@link CapacitySource} precedence
 * as the write side.
 */
export function deriveReadCapacityUnits(
  settings: Record<string, unknown> | undefined,
  source: CapacitySource = 'min'
): number | undefined {
  if (!settings) return undefined;
  const literal = coerceCfnInteger(settings['ReadCapacityUnits']);
  if (literal !== undefined) return literal;
  const autoScaling = asRecord(settings['ReadCapacityAutoScalingSettings']);
  if (!autoScaling) return undefined;
  return pickAutoScalingCapacity(autoScaling, source);
}

/**
 * Which member of a CFn `*CapacityAutoScalingSettings` block supplies the
 * ONE concrete number `CreateTable` / `UpdateTable` needs (Issue #1435).
 *
 * CloudFormation does not use a fixed precedence here — it is
 * context-dependent, and `SeedCapacity` has a much narrower scope than the
 * `SeedCapacity ?? MinCapacity` chain cdkd used everywhere:
 *
 *  - `'min'` — a fresh `CREATE`, a new index, or any same-billing-mode
 *    edit. Live-verified against real AWS (stack `CdkdIssue1427Control`,
 *    us-east-1): a `TableV2` with `MinCapacity: 1 / SeedCapacity: 20`
 *    reached `CREATE_COMPLETE` with `WriteCapacityUnits: 1` at BOTH table
 *    and index level, and `NumberOfDecreasesToday: 0` ruled out a
 *    scale-down between create and read-back. `MinCapacity` / `MaxCapacity`
 *    are `Required: Yes` in the registry schema; `SeedCapacity` is not.
 *  - `'seed'` — ONLY the `PAY_PER_REQUEST -> PROVISIONED` billing flip,
 *    which is the single context AWS documents `SeedCapacity` for ("the
 *    table will use these provisioned values until CloudFormation creates
 *    the autoscaling policies you configured"). Falls back to
 *    `MinCapacity` when the template omits the seed.
 *
 * Taking the seed on create over-provisioned every autoscaled PROVISIONED
 * GlobalTable by the seed-to-min ratio — a silent billing symptom, not an
 * error. It was only safe-looking because `create()` registered no scaling
 * target at all (Issue #1419, fixed in the same change): the over-provision
 * was accidentally acting as headroom for the missing policy.
 */
export type CapacitySource = 'min' | 'seed';

/** Resolve a `*CapacityAutoScalingSettings` block to one number. */
function pickAutoScalingCapacity(
  autoScaling: Record<string, unknown>,
  source: CapacitySource
): number | undefined {
  const min = coerceCfnInteger(autoScaling['MinCapacity']);
  if (source === 'min') return min ?? coerceCfnInteger(autoScaling['SeedCapacity']);
  return coerceCfnInteger(autoScaling['SeedCapacity']) ?? min;
}

/**
 * The shape refusal for a present-but-NON-ARRAY `GlobalSecondaryIndexes`, or
 * `undefined` when the value is absent or an array.
 *
 * ONE predicate for the two places that ask: {@link toSdkGlobalSecondaryIndexes}
 * (which throws, or hands it to its replay downgrade) and `update()`'s
 * template-path pre-flight (issue #3740), so the refusal cannot be narrower or
 * wider than the downgrade it replaces on that path. The value is masked leaf
 * by leaf BEFORE `JSON.stringify` escapes anything (issue #2178).
 */
export function globalSecondaryIndexesShapeDetail(
  rawIndexes: unknown,
  maskSecrets: MaskerFn = (text) => text
): string | undefined {
  if (rawIndexes === undefined || Array.isArray(rawIndexes)) return undefined;
  return (
    `AWS::DynamoDB::GlobalTable GlobalSecondaryIndexes must be an array, got ` +
    `${typeof rawIndexes} (${JSON.stringify(maskDeep(rawIndexes, maskSecrets))?.slice(0, 200)}).`
  );
}

/**
 * Translate the CFn `AWS::DynamoDB::GlobalTable` `GlobalSecondaryIndexes[]`
 * blob into the SDK's `GlobalSecondaryIndex[]` shape (Issue #1387).
 *
 * The two schemas model per-GSI throughput COMPLETELY differently, and the
 * AWS SDK v3 serializer silently drops unknown members — so the pre-fix raw
 * cast meant a PROVISIONED GlobalTable with a GSI failed `CreateTable`
 * outright (AWS requires `ProvisionedThroughput` on every GSI), and every
 * `TableV2` per-GSI on-demand limit vanished without a trace.
 *
 * Verified mapping (CFn registry schema `AWS::DynamoDB::GlobalTable` +
 * `@aws-sdk/client-dynamodb` `models_0.d.ts`, both read 2026-08-09; the CFn
 * side additionally confirmed against a real `cdk synth` of `TableV2` with a
 * GSI under both billing modes):
 *
 * | CFn                                                                    | SDK                                     |
 * | ---------------------------------------------------------------------- | --------------------------------------- |
 * | `GSI.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings` | `ProvisionedThroughput.WriteCapacityUnits` |
 * | `Replicas[local].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings.ReadCapacityUnits` | `ProvisionedThroughput.ReadCapacityUnits` |
 * | `GSI.WriteOnDemandThroughputSettings.MaxWriteRequestUnits`             | `OnDemandThroughput.MaxWriteRequestUnits` |
 * | `Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughputSettings.MaxReadRequestUnits` | `OnDemandThroughput.MaxReadRequestUnits` |
 * | `GSI.WarmThroughput`                                                   | `WarmThroughput` (same spelling)        |
 *
 * READ capacity really does live on the REPLICA's GSI entry, not on the
 * top-level GSI — CDK's `globalSecondaryIndexes[].readCapacity` synthesizes
 * to `Replicas[?Region==<deploy region>].GlobalSecondaryIndexes[].
 * ReadProvisionedThroughputSettings`. `CreateTable` only ever provisions the
 * LOCAL replica, so the local entry is the right source. The GSI-level
 * `ReadProvisionedThroughputSettings` / `ReadOnDemandThroughputSettings`
 * (which the schema also permits) are honored as a fallback for
 * hand-authored templates.
 *
 * Already-SDK-shaped `ProvisionedThroughput` / `OnDemandThroughput` members
 * win over the derivation: the CFn schema forbids them, but cdkd state
 * written before this fix (and hand-authored templates) can carry them, and
 * silently re-deriving over an explicit value would be a regression.
 */
export function toSdkGlobalSecondaryIndexes(
  properties: Record<string, unknown>,
  region: string,
  billingMode: string,
  source: CapacitySource = 'min',
  diagnostics?: ThroughputDiagnostic[],
  onUnusableIndexes?: (message: string) => void,
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178). Threaded
  // on to every diagnostic helper this function calls, so the whole GSI
  // translation masks by construction rather than per author-memory.
  maskSecrets: MaskerFn = (text) => text
): GlobalSecondaryIndex[] {
  const rawIndexes = properties['GlobalSecondaryIndexes'];
  // A NON-ARRAY value (an unresolved `Fn::If`, a malformed template) must not
  // collapse to "no indexes": that would create the table with ZERO GSIs and
  // report success, which is the very silent-drop class this function exists
  // to close, one level up. Absent is legitimately empty; present-but-wrong
  // is an error, and naming it here beats AWS's opaque 400. Matches the
  // per-ENTRY policy below, which also refuses to swallow a bad entry.
  //
  // `onUnusableIndexes` (issue #1544) is the STATE-REPLAY downgrade, wired
  // from `replayWarn` at the `create()` call site and — since issue #1551 —
  // from `update()` too: on the rollback executor's reverse-replacement
  // replay (create) and on a rollback / `drift --revert` replay (update) the
  // properties are a cdkd state record the user cannot edit, so the refusal
  // would leave the old table unrestorable / un-rollbackable. This helper
  // always returns the well-defined EMPTY list on the downgrade — never a
  // fabricated value — and the CALLER states the consequence in its warning,
  // because the two differ: on create an empty list means "a table with no
  // indexes", while on update it would mean "delete every live index", which
  // is why `update()` suppresses its GSI diff instead of applying the result.
  // Any call site that leaves the hook undefined keeps the refusal.
  const shapeDetail = globalSecondaryIndexesShapeDetail(rawIndexes, maskSecrets);
  if (shapeDetail !== undefined) {
    if (onUnusableIndexes) {
      onUnusableIndexes(shapeDetail);
      return [];
    }
    // A plain Error on purpose: this is a module-level pure helper with no
    // logicalId to build a ProvisioningError from. `update()` runs inside a
    // wrapping catch that converts it; `create()` does NOT, so its call site
    // converts it explicitly. Both paths therefore surface a ProvisioningError
    // carrying the resource context.
    throw new Error(
      `${shapeDetail} An unresolved intrinsic here would otherwise deploy a table with no indexes.`
    );
  }
  const cfnIndexes = (rawIndexes ?? []) as unknown[];
  if (cfnIndexes.length === 0) return [];

  const replicas = (properties['Replicas'] ?? []) as Array<Record<string, unknown>>;
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  const localReplicaIndexes = (localReplica?.['GlobalSecondaryIndexes'] ?? []) as unknown[];
  const localByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(localReplicaIndexes)) {
    for (const entry of localReplicaIndexes) {
      const record = asRecord(entry);
      const name = record?.['IndexName'];
      if (record && typeof name === 'string') localByName.set(name, record);
    }
  }

  const result: GlobalSecondaryIndex[] = [];
  for (const entry of cfnIndexes) {
    const gsi = asRecord(entry);
    // A non-object entry is an unresolved intrinsic or a malformed
    // template — pass it through untouched so AWS surfaces the real
    // validation error instead of cdkd swallowing it.
    if (!gsi) {
      result.push(entry as GlobalSecondaryIndex);
      continue;
    }
    const indexName = gsi['IndexName'] as string | undefined;
    const localEntry = typeof indexName === 'string' ? localByName.get(indexName) : undefined;

    const sdk: GlobalSecondaryIndex = {
      IndexName: indexName,
      KeySchema: gsi['KeySchema'] as GlobalSecondaryIndex['KeySchema'],
      Projection: gsi['Projection'] as GlobalSecondaryIndex['Projection'],
    };
    // `WarmThroughput` is coerced HERE, in the one translation every send site
    // reads from (issue #1857). Doing it at the three `UpdateTable` sites
    // instead would leave `create()` forwarding the raw bag, and would let the
    // "did it change?" comparisons at two of those sites run on a raw previous
    // side against a coerced desired one — where a state-recorded `12000` and
    // a template's `'12000'` read as a change and re-issue a pointless call.
    // Translating once makes both sides numbers and the wire shape identical.
    const warmCoercion = coerceWarmThroughput(gsi['WarmThroughput']);
    if (warmCoercion.spec) {
      sdk.WarmThroughput = warmCoercion.spec;
    }
    const warmDiagnostic = warmThroughputDiagnostic(
      gsi['WarmThroughput'],
      warmCoercion,
      typeof indexName === 'string' ? indexName : undefined
    );
    if (warmDiagnostic) diagnostics?.push(warmDiagnostic);

    // An explicit already-SDK-shaped block is MERGED over the derived one, per
    // member, after coercion, and only on the side the billing mode allows
    // (issue #1428 — the pre-fix code forwarded it verbatim, which skipped
    // coercion, let a partial block suppress valid derived siblings, and sent
    // a PROVISIONED block on a PAY_PER_REQUEST table). The CFn schema forbids
    // these members, so this only fires for pre-#1387 cdkd state and
    // hand-authored templates.
    const explicitProvisioned = asRecord(gsi['ProvisionedThroughput']);
    const explicitOnDemand = asRecord(gsi['OnDemandThroughput']);
    // The billing gate drops the block AWS would reject rather than
    // forwarding it into a guaranteed 400. Reported, never silent: the
    // template did ask for something, and dropping it without a word is the
    // same silent-wrong-action class the merge exists to remove.
    if (explicitProvisioned && billingMode !== 'PROVISIONED') {
      diagnostics?.push({
        kind: 'billing-mode-mismatch',
        ...(typeof indexName === 'string' && { indexName }),
        member: 'ProvisionedThroughput',
        message:
          `an explicit ProvisionedThroughput block was dropped because the table's ` +
          `BillingMode is ${billingMode}; AWS rejects provisioned capacity on an ` +
          `on-demand table. Remove the block, or set BillingMode: PROVISIONED.`,
      });
    }
    if (explicitOnDemand && billingMode === 'PROVISIONED') {
      diagnostics?.push({
        kind: 'billing-mode-mismatch',
        ...(typeof indexName === 'string' && { indexName }),
        member: 'OnDemandThroughput',
        message:
          `an explicit OnDemandThroughput block was dropped because the table's ` +
          `BillingMode is PROVISIONED; AWS rejects on-demand ceilings on a ` +
          `provisioned table. Remove the block, or set BillingMode: PAY_PER_REQUEST.`,
      });
    }

    if (billingMode === 'PROVISIONED') {
      // Capacity diagnostics fire from HERE, where the value is lost, for the
      // same reason the on-demand ones do (#1444 A): the per-GSI reset gate in
      // `update()` never runs for a first-time set or across a billing flip,
      // which are the two likeliest ways to hit this (#1511).
      const rawLocalRead = localEntry?.['ReadProvisionedThroughputSettings'];
      const rawGsiRead = gsi['ReadProvisionedThroughputSettings'];
      const rawWrite = gsi['WriteProvisionedThroughputSettings'];
      const derivedRead =
        deriveReadCapacityUnits(asRecord(rawLocalRead), source) ??
        deriveReadCapacityUnits(asRecord(rawGsiRead), source);
      const derivedWrite = deriveWriteCapacityUnits(asRecord(rawWrite), source);
      // An explicit SDK-shaped member wins in the merge below, so a value it
      // supplies is what reaches AWS and there is nothing to warn about.
      // The merge's own reader (`coerceCfnInteger`), so "covers" means the
      // member really reaches AWS: on the wider `toFiniteNumber` a padded
      // `" 7 "` counted as covered while the merge dropped it and the derived
      // default stood in with no diagnostic (issue #3135).
      const explicitCovers = (member: string): boolean =>
        explicitProvisioned !== undefined &&
        coerceCfnInteger(explicitProvisioned[member]) !== undefined;
      if (derivedRead === undefined && !explicitCovers('ReadCapacityUnits')) {
        // The replica spelling is the canonical CDK one and is blamed when
        // DECLARED, matching the on-demand half's choice of which of the two
        // read spellings to name.
        const fromReplica = rawLocalRead !== undefined;
        reportUnresolvedProvisionedCapacity(
          fromReplica ? rawLocalRead : rawGsiRead,
          'Read',
          source,
          { appliedUnits: DEFAULT_CAPACITY_UNITS },
          diagnostics,
          {
            ...(typeof indexName === 'string' && { indexName }),
            blockName: fromReplica
              ? 'Replicas[local].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings'
              : 'ReadProvisionedThroughputSettings',
          },
          maskSecrets
        );
      }
      if (derivedWrite === undefined && !explicitCovers('WriteCapacityUnits')) {
        reportUnresolvedProvisionedCapacity(
          rawWrite,
          'Write',
          source,
          { appliedUnits: DEFAULT_CAPACITY_UNITS },
          diagnostics,
          {
            ...(typeof indexName === 'string' && { indexName }),
            blockName: 'WriteProvisionedThroughputSettings',
          },
          maskSecrets
        );
      }
      // The derived side always yields both members (defaulting to 5/5), so
      // the merge can never come back `undefined` here — AWS REQUIRES
      // `ProvisionedThroughput` on every GSI of a provisioned table.
      sdk.ProvisionedThroughput = mergeExplicitThroughputBlock<ProvisionedThroughput>(
        explicitProvisioned,
        {
          ReadCapacityUnits: derivedRead ?? DEFAULT_CAPACITY_UNITS,
          WriteCapacityUnits: derivedWrite ?? DEFAULT_CAPACITY_UNITS,
        },
        ['ReadCapacityUnits', 'WriteCapacityUnits'],
        diagnostics,
        {
          ...(typeof indexName === 'string' && { indexName }),
          blockName: 'ProvisionedThroughput',
        },
        maskSecrets
      );
    } else {
      // Raw-key diagnostics fire regardless of whether the value survives
      // coercion, and regardless of whether this index ends up `modified` —
      // that is the whole point of raising them here (#1444 A).
      const rawWrite = asRecord(gsi['WriteOnDemandThroughputSettings'])?.['MaxWriteRequestUnits'];
      const rawReadLocal = asRecord(localEntry?.['ReadOnDemandThroughputSettings'])?.[
        'MaxReadRequestUnits'
      ];
      const rawReadGsi = asRecord(gsi['ReadOnDemandThroughputSettings'])?.['MaxReadRequestUnits'];
      reportUnresolvedRawMember(
        rawWrite,
        diagnostics,
        {
          ...(typeof indexName === 'string' && { indexName }),
          blockName: 'WriteOnDemandThroughputSettings',
          member: 'MaxWriteRequestUnits',
        },
        maskSecrets
      );
      // The replica spelling is the canonical CDK one and wins when it
      // coerces, so only report the GSI-level fallback when the replica entry
      // contributed nothing — otherwise a hand-authored leftover would draw a
      // warning about a value that was never going to be used.
      const rawRead = rawReadLocal !== undefined ? rawReadLocal : rawReadGsi;
      reportUnresolvedRawMember(
        rawRead,
        diagnostics,
        {
          ...(typeof indexName === 'string' && { indexName }),
          blockName:
            rawReadLocal !== undefined
              ? 'Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughputSettings'
              : 'ReadOnDemandThroughputSettings',
          member: 'MaxReadRequestUnits',
        },
        maskSecrets
      );

      const maxWrite = coerceCfnInteger(rawWrite);
      const maxRead = coerceCfnInteger(rawReadLocal) ?? coerceCfnInteger(rawReadGsi);
      const merged = mergeExplicitThroughputBlock<OnDemandThroughput>(
        explicitOnDemand,
        {
          ...(maxRead !== undefined && { MaxReadRequestUnits: maxRead }),
          ...(maxWrite !== undefined && { MaxWriteRequestUnits: maxWrite }),
        },
        ['MaxReadRequestUnits', 'MaxWriteRequestUnits'],
        diagnostics,
        { ...(typeof indexName === 'string' && { indexName }), blockName: 'OnDemandThroughput' },
        maskSecrets
      );
      if (merged) sdk.OnDemandThroughput = merged;
    }

    result.push(sdk);
  }
  return result;
}

/**
 * Remove every PROVISIONED-only capacity member from a desired-property bag
 * (issue #1726).
 *
 * Used by `create()`'s `BillingMode` warn-and-SUBSTITUTE arm and by its ABSENT
 * sibling: whenever the create resolves to `PAY_PER_REQUEST` on a bag that was
 * not written for it, the same create skips `createParams.ProvisionedThroughput`
 * and every per-index / per-replica provisioned member is dropped before the
 * call (each of the reads below is gated on `billingMode === 'PROVISIONED'`).
 * Recording those keys describes capacity AWS never received.
 *
 * The set is the intersection of two questions, and BOTH are needed — taking
 * either alone is what the review of the first cut corrected:
 *
 * - **what could not have been SENT** — every member `toSdkGlobalSecondaryIndexes`
 *   / `toSdkReplicaThroughputOverrides` read behind a PROVISIONED gate, which
 *   includes the two legacy SDK-shaped spellings a pre-#1387 cdkd wrote into
 *   state (`GlobalSecondaryIndexes[].ProvisionedThroughput`,
 *   `Replicas[].ProvisionedThroughputOverride`). A state replay is exactly that
 *   population, so leaving them out made the strip narrower than its own rule.
 * - **what `readCurrentState` can REPORT under the new mode** — the top-level
 *   `WriteProvisionedThroughputSettings` emits `{}` for an on-demand table and
 *   every other member here is omitted entirely, so a surviving key is a record
 *   the readback can never match.
 *
 * DELIBERATELY NOT removed: every `*OnDemand*` member. `OnDemandThroughput` is
 * attached to `CreateTable` precisely when the mode is not PROVISIONED, so those
 * WERE sent — a blanket "strip anything throughput-shaped" would record a loss
 * that did not happen, and a unit row plus an integ phase fence exactly that.
 *
 * Pure and non-mutating at every level — the caller's bag is
 * `previousState.properties` on the replay path and the rollback executor
 * spreads the answer shallowly, so an in-place edit would corrupt a record the
 * caller still holds.
 */
export function stripProvisionedCapacityKeys(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...properties };
  delete result['WriteProvisionedThroughputSettings'];
  delete result[TABLE_READ_PROVISIONED_KEY];
  // Note the deliberate asymmetry with the replica-index husk pruning below: a
  // top-level array is left as-is (even when empty), while an ALREADY-empty
  // `Replicas[].GlobalSecondaryIndexes` is removed along with the husks.
  // `readCurrentState` never emits that key as `[]`, so removing it converges
  // either way, and special-casing "empty on the way in" would buy nothing.

  const indexes = result['GlobalSecondaryIndexes'];
  if (Array.isArray(indexes)) {
    result['GlobalSecondaryIndexes'] = indexes.map((entry) => {
      const gsi = asRecord(entry);
      if (!gsi) return entry;
      const copy = { ...gsi };
      delete copy['WriteProvisionedThroughputSettings'];
      // The hand-authored fallback the translator reads only under PROVISIONED
      // (the CFn shape puts the READ half on the replica), and the pre-#1387
      // SDK spelling.
      delete copy['ReadProvisionedThroughputSettings'];
      delete copy['ProvisionedThroughput'];
      return copy;
    });
  }

  const replicas = result['Replicas'];
  if (Array.isArray(replicas)) {
    result['Replicas'] = replicas.map((entry) => {
      const replica = asRecord(entry);
      if (!replica) return entry;
      const copy = { ...replica };
      delete copy['ReadProvisionedThroughputSettings'];
      delete copy['ProvisionedThroughputOverride'];
      const replicaIndexes = copy['GlobalSecondaryIndexes'];
      if (Array.isArray(replicaIndexes)) {
        const stripped = replicaIndexes.map((indexEntry) => {
          const gsi = asRecord(indexEntry);
          if (!gsi) return indexEntry;
          const indexCopy = { ...gsi };
          delete indexCopy['ReadProvisionedThroughputSettings'];
          delete indexCopy['ProvisionedThroughputOverride'];
          return indexCopy;
        });
        // An entry whose ONLY remaining member is `IndexName` is a HUSK: the
        // per-replica index block exists solely to carry capacity overrides,
        // and `readCurrentState` attaches `Replicas[].GlobalSecondaryIndexes`
        // only for entries with more than `IndexName`
        // (`Object.keys(replicaEntry).length > 1`). Leaving the husk behind
        // re-creates the phantom drift this strip exists to remove, one level
        // down — measured live: `cdkd drift` reported the whole `Replicas`
        // array as changed because the baseline carried `[{IndexName:"gsi1"}]`
        // and the readback carried no key at all. Drop the husks, and drop the
        // key entirely when none survives.
        const kept = stripped.filter((entry) => {
          const gsi = asRecord(entry);
          if (!gsi) return true;
          return Object.keys(gsi).some((k) => k !== 'IndexName');
        });
        if (kept.length > 0) {
          copy['GlobalSecondaryIndexes'] = kept;
        } else {
          delete copy['GlobalSecondaryIndexes'];
        }
      }
      return copy;
    });
  }

  return result;
}

/**
 * The capacity member keys that can only reach AWS while the table is
 * PROVISIONED, per container level (issue #1738).
 *
 * Identical to the set {@link stripProvisionedCapacityKeys} removes, and that
 * is not a coincidence: both answer "which members are unsendable once the mode
 * is PAY_PER_REQUEST". The two spellings a pre-#1387 cdkd wrote into state
 * (`ProvisionedThroughput` / `ProvisionedThroughputOverride`) are included for
 * the same reason — a state replay is exactly that population.
 */
const PROVISIONED_ONLY_CAPACITY_KEYS = {
  table: ['WriteProvisionedThroughputSettings', 'ReadProvisionedThroughputSettings'],
  index: [
    'WriteProvisionedThroughputSettings',
    'ReadProvisionedThroughputSettings',
    'ProvisionedThroughput',
  ],
  replica: ['ReadProvisionedThroughputSettings', 'ProvisionedThroughputOverride'],
  replicaIndex: ['ReadProvisionedThroughputSettings', 'ProvisionedThroughputOverride'],
} as const;

/**
 * The mirror set: capacity members that can only reach AWS while the table is
 * PAY_PER_REQUEST (issue #1738).
 *
 * `stripProvisionedCapacityKeys` has no equivalent because the create arm it
 * serves always substitutes PAY_PER_REQUEST — the mode under which these ARE
 * sent, which is why its header says they are deliberately not stripped. On the
 * UPDATE path the kept mode can be PROVISIONED, and then it is this half that
 * never leaves the process.
 */
const ON_DEMAND_ONLY_CAPACITY_KEYS = {
  table: ['WriteOnDemandThroughputSettings', 'ReadOnDemandThroughputSettings'],
  index: [
    'WriteOnDemandThroughputSettings',
    'ReadOnDemandThroughputSettings',
    'OnDemandThroughput',
  ],
  replica: ['ReadOnDemandThroughputSettings', 'OnDemandThroughputOverride'],
  replicaIndex: ['ReadOnDemandThroughputSettings', 'OnDemandThroughputOverride'],
} as const;

/**
 * Replace every capacity member the KEPT billing mode cannot send with the
 * PREVIOUS record's value (issue #1738).
 *
 * Called from `update()`'s `BillingMode` warn-and-KEEP arm, where an unusable
 * desired mode suppresses the flip: AWS is left holding the mode it already
 * had, so every block belonging to the OTHER mode was silently dropped on the
 * way out while the engine recorded what the template declared.
 *
 * **The split is per MEMBER against the KEPT mode**, and each side was read off
 * the gates in this file rather than off the member's name-shape (the
 * name-shape trap #1726 records — an on-demand ceiling looks like capacity and
 * goes on the wire under precisely the on-demand mode):
 *
 * - KEPT `PROVISIONED` — the on-demand half is unsendable. Step 3's table-level
 *   `OnDemandThroughput` is gated on `newBilling !== 'PROVISIONED'`;
 *   `toSdkGlobalSecondaryIndexes` and `toSdkReplicaThroughputOverrides` both
 *   drop their on-demand branch under PROVISIONED. The provisioned half is NOT
 *   retained: step 4b and step 6b's auto-scaling reconcile are live whenever
 *   either side is PROVISIONED, and step 6's GSI diff carries per-index
 *   `ProvisionedThroughput` — those blocks really are applied.
 * - KEPT `PAY_PER_REQUEST` — the provisioned half is unsendable. The table-level
 *   `ProvisionedThroughput` rides step 4's flip and nothing else, the two
 *   auto-scaling reconciles are gated on either side being PROVISIONED, and both
 *   translators drop their provisioned branch. The on-demand half is NOT
 *   retained: step 3 sends the table-level ceilings and step 6 the per-index
 *   ones under exactly this mode.
 *
 * One residual is deliberately NOT covered, because the suppression did not
 * create it: the TABLE-level provisioned capacity NUMBER rides step 4's flip
 * and nothing else, so on ANY non-flip PROVISIONED -> PROVISIONED update it is
 * unsent while its `*CapacityAutoScalingSettings` sibling in the same block IS
 * reconciled. Retaining the block wholesale under a kept PROVISIONED mode would
 * therefore erase a real auto-scaling update to hide a pre-existing gap — so
 * the block stays as declared and the gap stays where it already lives.
 *
 * Retaining rather than DROPPING is the UPDATE row of
 * `.claude/rules/providers.md`: the call never ran, so AWS still holds the
 * previously-applied block and that IS what state should describe. Dropping
 * would leave a later template that REMOVES the block deriving no removal, so
 * the live setting would survive forever.
 *
 * **The previous side is VALIDATED before it is retained** (the #1653-review
 * rule) through `asRecord` — the SAME predicate every wire read of these blocks
 * applies, so the two cannot disagree about what a bare string / an array / a
 * number means. Be honest about what that buys: it refuses exactly the
 * not-a-plain-object shapes, and a block whose NUMERIC member is an unresolved
 * intrinsic passes it, because the wire accepts that block too (and then sends
 * nothing for the member, which is the same "AWS keeps what it had" outcome).
 * When the previous side is unusable OR absent the key is DROPPED — there is no
 * value cdkd can vouch for either way.
 *
 * COPIES each retained block one level rather than aliasing it: the rollback
 * executor spreads the returned bag shallowly, so handing back the previous
 * record's own object would leave two state records sharing one mutable value.
 * Scope that claim honestly — it covers the retained blocks only; every other
 * key of the input bag stays aliased, exactly as the sibling arms leave it.
 *
 * Deliberately NOT paired with a `canonicalizeDesiredProperties` twin: this is
 * a SKIP, not a narrowing, so there is no pure function of the desired bag to
 * fold both comparison sides with, and folding one would derive a REMOVAL of a
 * live capacity block from a template whose only fault is `BillingMode`.
 *
 * Pure and non-mutating at every level.
 */
export function retainUnsendableCapacityMembers(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  keptBillingMode: string
): Record<string, unknown> {
  const unsendable =
    keptBillingMode === 'PROVISIONED'
      ? ON_DEMAND_ONLY_CAPACITY_KEYS
      : PROVISIONED_ONLY_CAPACITY_KEYS;

  const result = retainCapacityKeys({ ...desired }, previous, unsendable.table);

  const indexes = result['GlobalSecondaryIndexes'];
  if (Array.isArray(indexes)) {
    const previousIndexes = indexCapacityContainers(
      previous['GlobalSecondaryIndexes'],
      'IndexName'
    );
    result['GlobalSecondaryIndexes'] = indexes.map((entry) => {
      const gsi = asRecord(entry);
      if (!gsi) return entry;
      const previousGsi = previousIndexes.get(gsi['IndexName']);
      return retainCapacityKeys({ ...gsi }, previousGsi, unsendable.index);
    });
  }

  const replicas = result['Replicas'];
  if (Array.isArray(replicas)) {
    const previousReplicas = indexCapacityContainers(previous['Replicas'], 'Region');
    result['Replicas'] = replicas.map((entry) => {
      const replica = asRecord(entry);
      if (!replica) return entry;
      const previousReplica = previousReplicas.get(replica['Region']);
      const copy = retainCapacityKeys({ ...replica }, previousReplica, unsendable.replica);
      const replicaIndexes = copy['GlobalSecondaryIndexes'];
      if (Array.isArray(replicaIndexes)) {
        const previousReplicaIndexes = indexCapacityContainers(
          previousReplica?.['GlobalSecondaryIndexes'],
          'IndexName'
        );
        const retained = replicaIndexes.map((indexEntry) => {
          const gsi = asRecord(indexEntry);
          if (!gsi) return indexEntry;
          const previousGsi = previousReplicaIndexes.get(gsi['IndexName']);
          return retainCapacityKeys({ ...gsi }, previousGsi, unsendable.replicaIndex);
        });
        // Same HUSK prune `stripProvisionedCapacityKeys` applies, for the same
        // measured reason: a per-replica index block exists ONLY to carry
        // capacity overrides, and `readCurrentState` attaches
        // `Replicas[].GlobalSecondaryIndexes` only for entries with more than
        // `IndexName`. A DROP arm above can empty an entry down to that husk, so
        // without this the fix would close one never-matchable shape by opening
        // another — live-measured on the sibling as `cdkd drift` reporting the
        // whole `Replicas` array as changed.
        const kept = retained.filter((entry) => {
          const gsi = asRecord(entry);
          if (!gsi) return true;
          return Object.keys(gsi).some((k) => k !== 'IndexName');
        });
        if (kept.length > 0) {
          copy['GlobalSecondaryIndexes'] = kept;
        } else {
          delete copy['GlobalSecondaryIndexes'];
        }
      }
      return copy;
    });
  }

  return result;
}

/**
 * Retain (or drop) one container's unsendable capacity members, in place on a
 * bag the caller already copied.
 *
 * The counterpart container being `undefined` — no matching index / replica in
 * the previous record — is the ABSENT case, not a special one: there is nothing
 * to vouch for, so the key is dropped exactly as it is for an unusable value.
 */
function retainCapacityKeys(
  target: Record<string, unknown>,
  previousContainer: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> {
  for (const key of keys) {
    const previousValue = asRecord(previousContainer?.[key]);
    if (previousValue) {
      target[key] = { ...previousValue };
    } else {
      delete target[key];
    }
  }
  return target;
}

/**
 * Index a previous-side array by its identity member, so a per-index /
 * per-replica retain reads the counterpart entry rather than the positional
 * one — AWS does not guarantee readback order and a template edit can reorder
 * either list.
 */
function indexCapacityContainers(
  value: unknown,
  identityKey: 'IndexName' | 'Region'
): Map<unknown, Record<string, unknown>> {
  const byIdentity = new Map<unknown, Record<string, unknown>>();
  if (!Array.isArray(value)) return byIdentity;
  for (const entry of value) {
    const record = asRecord(entry);
    const identity = record?.[identityKey];
    if (record && typeof identity === 'string') byIdentity.set(identity, record);
  }
  return byIdentity;
}

/**
 * True when a CFn sub-object is nothing but an unresolved intrinsic
 * (`{"Fn::If": […]}` / `{"Ref": …}`), i.e. the template DID declare the block
 * but its value could not be resolved to a shape with members.
 *
 * Needed because presence is otherwise tested on the MEMBER key: an
 * intrinsic-valued block IS a record, so `asRecord` succeeds while
 * `['MaxReadRequestUnits']` is undefined — reporting "not declared" and firing
 * the destructive `-1` reset on a ceiling the template was trying to SET. That
 * is issue #1440 one level up from where the member test looks.
 */
function isUnresolvedIntrinsicBlock(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const keys = Object.keys(record);
  return keys.length > 0 && keys.every((k) => k === 'Ref' || k.startsWith('Fn::'));
}

/** Which on-demand members a GSI's CFn side actually DECLARES (issue #1440). */
export interface RawOnDemandDeclaration {
  readonly readDeclared: boolean;
  readonly writeDeclared: boolean;
}

/**
 * Per-index RAW presence of the two per-GSI on-demand members, keyed by
 * `IndexName` (issue #1440).
 *
 * The per-GSI reset needs to know "did the template DROP this member", and the
 * only faithful answer is whether the CFn key is THERE — not whether its value
 * coerced. `toSdkGlobalSecondaryIndexes` runs every value through
 * `coerceCfnInteger`, which returns `undefined` for a present-but-
 * unparseable value (an unresolved `{Ref: …}`, `''`, an object). Deciding
 * "dropped" from that collapsed view sent the `-1` reset for a member the
 * template was actively trying to SET, silently clearing the ceiling — the same
 * silent-wrong-action class the reset exists to remove, and the exact hazard
 * the table-level path was corrected for in #1434's PR.
 *
 * So this walks the same two sources as `toSdkGlobalSecondaryIndexes` — the
 * top-level GSI for the write half, the LOCAL replica's index entry (with the
 * GSI-level spelling as the documented fallback) for the read half — and
 * reports presence only. Keeping it beside that function is deliberate: the
 * two must agree on where each member lives, and a divergence between them is
 * exactly what would re-open the bug.
 *
 * A missing entry means "not declared", which lets the reset FIRE — i.e. the
 * DESTRUCTIVE direction, not a conservative one. Two DIFFERENT mechanisms keep
 * that safe, and neither is "the translation validates everything":
 *   - a non-array `GlobalSecondaryIndexes` is refused LOUDLY by
 *     `toSdkGlobalSecondaryIndexes` before any of this runs;
 *   - a malformed per-ENTRY shape is NOT refused — it is passed through
 *     untouched so AWS surfaces the real error — but such an entry carries no
 *     usable `IndexName`, so the reset loop skips it before consulting this map.
 * Do not relax either behavior on the assumption that this helper degrades
 * safely on its own; it does not.
 */
export function collectRawOnDemandDeclarations(
  properties: Record<string, unknown>,
  region: string
): Map<string, RawOnDemandDeclaration> {
  const out = new Map<string, RawOnDemandDeclaration>();
  const rawIndexes = properties['GlobalSecondaryIndexes'];
  if (!Array.isArray(rawIndexes)) return out;

  const replicas = properties['Replicas'];
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  const localReplicaIndexes = asRecord(localReplica)?.['GlobalSecondaryIndexes'];
  const localByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(localReplicaIndexes)) {
    for (const entry of localReplicaIndexes) {
      const record = asRecord(entry);
      const name = record?.['IndexName'];
      if (record && typeof name === 'string') localByName.set(name, record);
    }
  }

  for (const entry of rawIndexes) {
    const gsi = asRecord(entry);
    const name = gsi?.['IndexName'];
    if (!gsi || typeof name !== 'string') continue;
    const localEntry = localByName.get(name);
    // An already-SDK-shaped `OnDemandThroughput` no longer WINS over the
    // derived members — since #1428 the two are MERGED per member — so this
    // has to be the UNION of both sources, not the explicit block alone.
    // Reading only the explicit block would report a member not-declared that
    // the derived side does declare, and the reset would then clear a ceiling
    // the template was actively setting.
    const explicitOnDemand = asRecord(gsi['OnDemandThroughput']);
    // A block that is ITSELF an unresolved intrinsic counts as declared: the
    // member test cannot see into it, and reporting "not declared" would fire
    // the destructive reset on a ceiling the template was trying to set.
    // That applies to the EXPLICIT SDK-shaped block too — an
    // `OnDemandThroughput: {"Fn::If": …}` has no member keys, so without this
    // arm it reported "not declared" for BOTH members and the reset cleared a
    // ceiling a hand-authored template was setting (review catch on this PR;
    // the same class as #1440, one spelling over).
    const explicitIsIntrinsic = isUnresolvedIntrinsicBlock(gsi['OnDemandThroughput']);
    const readBlocks = [
      localEntry?.['ReadOnDemandThroughputSettings'],
      gsi['ReadOnDemandThroughputSettings'],
    ];
    const writeBlock = gsi['WriteOnDemandThroughputSettings'];
    out.set(name, {
      // Same sources as the SDK translation: replica entry first, GSI-level
      // spelling as the hand-authored fallback, explicit SDK-shaped block on
      // top. Declared in ANY place counts — the translation resolves "first
      // PARSEABLE", so an OR here is a safe superset for suppression (it can
      // never report not-declared for a member the translation did resolve).
      readDeclared:
        explicitOnDemand?.['MaxReadRequestUnits'] !== undefined ||
        explicitIsIntrinsic ||
        readBlocks.some(
          (block) =>
            asRecord(block)?.['MaxReadRequestUnits'] !== undefined ||
            isUnresolvedIntrinsicBlock(block)
        ),
      writeDeclared:
        explicitOnDemand?.['MaxWriteRequestUnits'] !== undefined ||
        explicitIsIntrinsic ||
        asRecord(writeBlock)?.['MaxWriteRequestUnits'] !== undefined ||
        isUnresolvedIntrinsicBlock(writeBlock),
    });
  }
  return out;
}

/**
 * Names of the GSIs whose PROVISIONED capacity must NOT be compared against
 * the live table (issue #1571). Two disjoint reasons, and both are about the
 * DESIRED side being a number the template did not actually choose:
 *
 * - **auto-scaled** — the live number is owned by Application Auto Scaling
 *   while the translation takes `MinCapacity` (see {@link CapacitySource}), so
 *   a live 10 against a template min of 1 reads as a scale-down NOBODY ASKED
 *   FOR. This was one of the three measured failure modes of the first
 *   value-carrying baseline (#1551), and the only one that cannot be resolved
 *   by reading the live side more carefully — both numbers are correct, they
 *   answer different questions.
 * - **not template-determined** — no capacity resolves to a finite number, so
 *   `toSdkGlobalSecondaryIndexes` substitutes `DEFAULT_CAPACITY_UNITS` (5/5,
 *   the issue #1511 class). Comparing that invented default against the live
 *   value turns it into a WRITE. Found by review, not by the first cut.
 *
 * Walks the same two sources as {@link toSdkGlobalSecondaryIndexes} and
 * {@link collectRawOnDemandDeclarations} — the LOCAL replica's index entry
 * first (the canonical CDK spelling), the GSI-level block as the
 * hand-authored fallback for read, the top-level GSI for write. A divergence
 * between the three is what would re-open the bug, so they are kept adjacent.
 *
 * The auto-scaling arm tests PRESENCE of the `*CapacityAutoScalingSettings`
 * key, not whether its members coerce: a block that is itself an unresolved
 * intrinsic still means "this index is autoscaled", and "might be" must read
 * as "is" — a false negative issues an unrequested scale-down.
 *
 * KNOWN BOUND: detection is TEMPLATE-side only. An index autoscaled OUT OF
 * BAND (no `*CapacityAutoScalingSettings` in the template) has a
 * template-determined capacity, so its live value IS compared and the recovery
 * deploy re-asserts the template's number — which is what a clean previous
 * side would also have done, so this matches ordinary cdkd semantics rather
 * than being a recovery-path defect.
 *
 * And the cost of a false positive is a PERMANENT divergence, not "one deploy
 * of lag": the deploy records the template value as state, so the next diff
 * sees previous == desired and never revisits it. That is the same self-heal
 * fallacy this PR corrects in the live-only warning; it is accepted here
 * because the alternative is writing a number the user never asked for.
 */
export function collectUncomparableCapacityGsiNames(
  properties: Record<string, unknown>,
  region: string
): Set<string> {
  const out = new Set<string>();
  const rawIndexes = properties['GlobalSecondaryIndexes'];
  if (!Array.isArray(rawIndexes)) return out;

  const replicas = properties['Replicas'];
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  const localReplicaIndexes = asRecord(localReplica)?.['GlobalSecondaryIndexes'];
  const localByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(localReplicaIndexes)) {
    for (const entry of localReplicaIndexes) {
      const record = asRecord(entry);
      const name = record?.['IndexName'];
      if (record && typeof name === 'string') localByName.set(name, record);
    }
  }

  for (const entry of rawIndexes) {
    const gsi = asRecord(entry);
    const name = gsi?.['IndexName'];
    if (!gsi || typeof name !== 'string') continue;
    const localEntry = localByName.get(name);
    const readBlocks = [
      localEntry?.['ReadProvisionedThroughputSettings'],
      gsi['ReadProvisionedThroughputSettings'],
    ];
    // (a) AUTO-SCALED. A block that is ITSELF an unresolved intrinsic counts
    // too: nothing can see inside it, and the two readings are not symmetric.
    const writeBlock = gsi['WriteProvisionedThroughputSettings'];
    const autoScaled =
      readBlocks.some(
        (block) =>
          asRecord(block)?.['ReadCapacityAutoScalingSettings'] !== undefined ||
          isUnresolvedIntrinsicBlock(block)
      ) ||
      asRecord(writeBlock)?.['WriteCapacityAutoScalingSettings'] !== undefined ||
      isUnresolvedIntrinsicBlock(writeBlock);
    if (autoScaled) {
      out.add(name);
      continue;
    }
    // (b) NOT TEMPLATE-DETERMINED. This is the arm a review caught, and it is
    // the destructive one: `toSdkGlobalSecondaryIndexes` runs every capacity
    // through `coerceCfnInteger` and falls through to `DEFAULT_CAPACITY_UNITS`
    // (5/5) when nothing resolves — the issue #1511 class. Outside this
    // recovery path both sides derive the same 5/5, so the invented default
    // never reaches AWS. With a live baseline it becomes a WRITE: live 25/25
    // versus a desired 5/5 reads as an edit and cdkd scales the table DOWN to
    // a number the template never contained. So the test is not "did the
    // template mention auto-scaling" but "did the template DETERMINE both
    // numbers" — mirroring `deriveRead/WriteCapacityUnits` returning
    // `undefined`, with the explicit SDK-shaped block counted because the
    // translation merges it over the derived side — read through the merge's
    // OWN reader (`coerceCfnInteger`, issue #3135): a padded `" 7 "` the
    // merge drops must count as NOT determined here, or the 5/5 fallback the
    // translation sends reads as a scale-down against the live baseline.
    const explicitProvisioned = asRecord(gsi['ProvisionedThroughput']);
    const derivedRead =
      coerceCfnInteger(explicitProvisioned?.['ReadCapacityUnits']) ??
      deriveReadCapacityUnits(asRecord(readBlocks[0])) ??
      deriveReadCapacityUnits(asRecord(readBlocks[1]));
    const derivedWrite =
      coerceCfnInteger(explicitProvisioned?.['WriteCapacityUnits']) ??
      deriveWriteCapacityUnits(asRecord(writeBlock));
    if (derivedRead === undefined || derivedWrite === undefined) out.add(name);
  }
  return out;
}

/** Inputs {@link buildLiveRecoveryGsiBaseline} needs beyond the two index lists. */
export interface LiveRecoveryBaselineOptions {
  /**
   * `false` keeps the baseline IDENTITY-ONLY (every carried entry is a
   * byte-copy of its desired counterpart, so only ADDs can come out of the
   * diff). Set by the caller whenever a BillingMode flip is in play or the
   * live mode disagrees with the desired one — across two billing modes every
   * index differs BY CONSTRUCTION, so a value comparison there measures the
   * translation, not the user's edit.
   */
  readonly carryLiveValues: boolean;
  /** The table's LIVE billing mode (`BillingModeSummary`, absent = PROVISIONED). */
  readonly liveBillingMode: string;
  /**
   * Result of {@link collectUncomparableCapacityGsiNames} for the DESIRED
   * template. Scoped to PROVISIONED capacity ONLY — an on-demand ceiling is
   * a literal the template either carries or does not, so auto-scaling has no
   * bearing on it and suppressing the whole entry would take the issue #1160
   * `-1` reset down with it (review catch).
   */
  readonly uncomparableCapacityIndexNames: ReadonlySet<string>;
}

/**
 * Build the GSI diff baseline used when the cdkd STATE record's
 * `GlobalSecondaryIndexes` is present-but-unusable (issue #1571, closing the
 * residual #1551 / PR #1562 measured and deliberately left open).
 *
 * The entries are the DESIRED indexes filtered to the names that EXIST live —
 * the live table is the only side that can answer "does this index exist",
 * which is what stops the permanent index loss #1562 was about. What #1562
 * could not settle was the VALUES: it copied the desired entry verbatim, so
 * the diff could only ever produce ADDs and every capacity / ceiling edit
 * silently lagged one deploy.
 *
 * This carries live VALUES, but only the ones that are safe to compare, and
 * the exclusions are the three measured failure modes of the first attempt
 * (recorded at the `liveIndexNames` call site) rather than a guess:
 *
 *  - **`ProvisionedThroughput` is gated on the LIVE billing mode.**
 *    `DescribeTable` reports `{ReadCapacityUnits: 0, WriteCapacityUnits: 0}`
 *    for every index of a PAY_PER_REQUEST table, so an ungated read produced a
 *    "modified" on every index and re-sent `{0, 0}`, which AWS rejects.
 *  - **An AUTOSCALED index keeps identity-only capacity.** The live number
 *    belongs to Application Auto Scaling; the desired side is `MinCapacity`.
 *    Comparing them reads as a scale-down the user never asked for.
 *  - **`KeySchema` / `Projection` / `WarmThroughput` are always the desired
 *    side.** All three are copied from `desired`, so they can never DIFFER —
 *    deliberately. `KeySchema` and `Projection` are immutable on an existing
 *    index (a difference produces only a "recreate the index" warning, and
 *    AWS's `Projection.NonKeyAttributes` READBACK ORDER is not guaranteed, so
 *    the comparison would be a coin flip); `WarmThroughput` reads back with a
 *    `Status` member the translated shape does not carry, and DynamoDB warm
 *    throughput is increase-only, so a manufactured difference is a real
 *    AWS-side risk.
 *
 * `OnDemandThroughput` IS carried from live on an on-demand table, and that is
 * the second thing this fixes: the `modified` loop derives the `-1` ceiling
 * RESET (the #1160 absent-field-removal class) from the PREVIOUS side, so with
 * a desired-copy baseline a template that dropped `MaxReadRequestUnits` left
 * the old ceiling live in AWS forever while cdkd reported success.
 *
 * REMOVES are still not derivable here and are deliberately absent: an index
 * live but not in the template is in NEITHER side, so no `Delete` is issued.
 * A junk state record cannot distinguish "cdkd created this and the template
 * dropped it" from "somebody added it out of band", the delete is irreversible
 * and a re-create costs a full backfill. The caller names the live-only
 * indexes and points at the remedy.
 */
export function buildLiveRecoveryGsiBaseline(
  desiredSdkIndexes: readonly GlobalSecondaryIndex[],
  liveIndexes: readonly GlobalSecondaryIndexDescription[] | undefined,
  options: LiveRecoveryBaselineOptions
): GlobalSecondaryIndex[] {
  const liveByName = new Map<string, GlobalSecondaryIndexDescription>();
  for (const live of liveIndexes ?? []) {
    if (typeof live.IndexName === 'string') liveByName.set(live.IndexName, live);
  }

  const baseline: GlobalSecondaryIndex[] = [];
  for (const desired of desiredSdkIndexes) {
    if (typeof desired.IndexName !== 'string') continue;
    const live = liveByName.get(desired.IndexName);
    if (!live) continue;
    // Spread FIRST so every member not overridden below is the desired
    // side's own value, and so compares equal to its translated counterpart.
    const entry: GlobalSecondaryIndex = { ...desired };
    if (!options.carryLiveValues) {
      baseline.push(entry);
      continue;
    }
    if (options.liveBillingMode === 'PROVISIONED') {
      // The capacity exclusion lives HERE, not above the mode branch: it is
      // about PROVISIONED capacity only, and short-circuiting the whole entry
      // suppressed the on-demand `-1` reset for an on-demand table whose
      // template still carried a leftover auto-scaling block.
      if (options.uncomparableCapacityIndexNames.has(desired.IndexName)) {
        baseline.push(entry);
        continue;
      }
      // Introduce the member only when the desired side HAS it. A baseline
      // carrying a block the desired side lacks reads as "the template removed
      // provisioned capacity", which on a provisioned table is not a thing the
      // user can express — the `modified` loop would then find no throughput
      // field to send and print the misleading "recreate the index" warning.
      const liveRead = toFiniteNumber(live.ProvisionedThroughput?.ReadCapacityUnits);
      const liveWrite = toFiniteNumber(live.ProvisionedThroughput?.WriteCapacityUnits);
      if (desired.ProvisionedThroughput && liveRead !== undefined && liveWrite !== undefined) {
        entry.ProvisionedThroughput = {
          ReadCapacityUnits: liveRead,
          WriteCapacityUnits: liveWrite,
        };
      }
    } else {
      // On-demand: the live ceilings ARE the previous side, including their
      // ABSENCE. Deleting the key when AWS reports no ceiling is load-bearing
      // in the other direction — a desired-side ceiling then reads as a
      // first-time SET and is applied, instead of being swallowed as "equal".
      const liveRead = toFiniteNumber(live.OnDemandThroughput?.MaxReadRequestUnits);
      const liveWrite = toFiniteNumber(live.OnDemandThroughput?.MaxWriteRequestUnits);
      if (liveRead === undefined && liveWrite === undefined) {
        delete entry.OnDemandThroughput;
      } else {
        entry.OnDemandThroughput = {
          ...(liveRead !== undefined && { MaxReadRequestUnits: liveRead }),
          ...(liveWrite !== undefined && { MaxWriteRequestUnits: liveWrite }),
        };
      }
    }
    baseline.push(entry);
  }
  return baseline;
}

/**
 * Translate a CFn `Replicas[].GlobalSecondaryIndexes[]` blob (the
 * `ReplicaGlobalSecondaryIndexSpecification` shape) into the SDK's
 * `ReplicaGlobalSecondaryIndex[]` used by `CreateReplicationGroupMemberAction`
 * / `UpdateReplicationGroupMemberAction` (Issue #1387).
 *
 * Verified mapping:
 *
 * | CFn                                                        | SDK                                            |
 * | ---------------------------------------------------------- | ---------------------------------------------- |
 * | `ReadProvisionedThroughputSettings.ReadCapacityUnits`      | `ProvisionedThroughputOverride.ReadCapacityUnits` |
 * | `ReadOnDemandThroughputSettings.MaxReadRequestUnits`       | `OnDemandThroughputOverride.MaxReadRequestUnits`  |
 *
 * `ContributorInsightsSpecification` is not mapped HERE: the replica-GSI SDK
 * shape has no member for it. It goes out as a separate
 * `UpdateContributorInsights(TableName, IndexName)` call in the replica's own
 * region (`planReplicaIndexInsightsOps`, go-to-k/cdkd#5489).
 */
export function toSdkReplicaGlobalSecondaryIndexes(
  replicaIndexes: unknown,
  billingMode: string,
  diagnostics?: ThroughputDiagnostic[],
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): ReplicaGlobalSecondaryIndex[] | undefined {
  if (!Array.isArray(replicaIndexes) || replicaIndexes.length === 0) return undefined;
  const translated = replicaIndexes.map((entry) => {
    const cfn = asRecord(entry);
    if (!cfn) return entry as ReplicaGlobalSecondaryIndex;
    const indexName = cfn['IndexName'] as string | undefined;
    const sdk: ReplicaGlobalSecondaryIndex = { IndexName: indexName };
    const overrides = toSdkReplicaThroughputOverrides(
      cfn,
      billingMode,
      diagnostics,
      { ...(typeof indexName === 'string' && { indexName }) },
      maskSecrets
    );
    if (overrides.ProvisionedThroughputOverride) {
      sdk.ProvisionedThroughputOverride = overrides.ProvisionedThroughputOverride;
    }
    if (overrides.OnDemandThroughputOverride) {
      sdk.OnDemandThroughputOverride = overrides.OnDemandThroughputOverride;
    }
    return sdk;
  });
  // go-to-k/cdkd#5489: an entry that carries no override has nothing to send.
  // The usual case is a replica index that declares only its
  // ContributorInsightsSpecification, which goes out as UpdateContributorInsights
  // instead. AWS refuses an `Update` holding only such entries ("There are no
  // actions specified in the Replica Update Action of the request", measured
  // on the dynamodb-globaltable-replica-settings integ). A non-object entry
  // (an unresolved intrinsic) is kept, so AWS still rejects it as before.
  const sendable = translated.filter(
    (sdk) =>
      asRecord(sdk) === undefined ||
      sdk.ProvisionedThroughputOverride !== undefined ||
      sdk.OnDemandThroughputOverride !== undefined
  );
  return sendable.length > 0 ? sendable : undefined;
}

/**
 * The `{Provisioned,OnDemand}ThroughputOverride` pair for ONE replica-scoped
 * CFn block — shared by the per-GSI replica entries and, since issue #1436,
 * by the replica's own TABLE-level entry, which carries the very same two CFn
 * spellings (`ReadProvisionedThroughputSettings` /
 * `ReadOnDemandThroughputSettings`) and maps to the very same two SDK members
 * on `{Create,Update}ReplicationGroupMemberAction`. One helper so the two
 * levels cannot disagree about the mapping.
 *
 * Same #1428 treatment as the GSI-level blocks: coerce, merge an explicit
 * SDK-shaped override PER MEMBER over the derived value, and gate on billing
 * mode. Both override members are READ-side only — a replica has no
 * independent write capacity, since writes replicate from the source table.
 */
function toSdkReplicaThroughputOverrides(
  cfn: Record<string, unknown>,
  billingMode: string,
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string },
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): {
  ProvisionedThroughputOverride?: { ReadCapacityUnits: number };
  OnDemandThroughputOverride?: { MaxReadRequestUnits: number };
} {
  const explicitProvisioned = asRecord(cfn['ProvisionedThroughputOverride']);
  const explicitOnDemand = asRecord(cfn['OnDemandThroughputOverride']);
  if (explicitProvisioned && billingMode !== 'PROVISIONED') {
    diagnostics?.push({
      kind: 'billing-mode-mismatch',
      ...context,
      member: 'ProvisionedThroughputOverride',
      message:
        `an explicit ProvisionedThroughputOverride was dropped because the table's ` +
        `BillingMode is ${billingMode}; AWS rejects provisioned capacity on an ` +
        `on-demand table.`,
    });
  }
  if (explicitOnDemand && billingMode === 'PROVISIONED') {
    diagnostics?.push({
      kind: 'billing-mode-mismatch',
      ...context,
      member: 'OnDemandThroughputOverride',
      message:
        `an explicit OnDemandThroughputOverride was dropped because the table's ` +
        `BillingMode is PROVISIONED; AWS rejects on-demand ceilings on a ` +
        `provisioned table.`,
    });
  }

  if (billingMode === 'PROVISIONED') {
    const rawRead = cfn['ReadProvisionedThroughputSettings'];
    const readCapacity = deriveReadCapacityUnits(asRecord(rawRead));
    // The one PROVISIONED site that CAN suppress: an absent
    // `ProvisionedThroughputOverride` means "inherit the source table", so an
    // unreadable value here silently keeps the inherited capacity rather than
    // defaulting to 5 (issue #1511).
    if (
      readCapacity === undefined &&
      coerceCfnInteger(explicitProvisioned?.['ReadCapacityUnits']) === undefined
    ) {
      reportUnresolvedProvisionedCapacity(
        rawRead,
        'Read',
        'min',
        {
          suppressed:
            `so no ProvisionedThroughputOverride was sent and the replica keeps the ` +
            `source table's read capacity`,
        },
        diagnostics,
        { ...context, blockName: 'ReadProvisionedThroughputSettings' },
        maskSecrets
      );
    }
    const merged = mergeExplicitThroughputBlock<{ ReadCapacityUnits: number }>(
      explicitProvisioned,
      readCapacity !== undefined ? { ReadCapacityUnits: readCapacity } : undefined,
      ['ReadCapacityUnits'],
      diagnostics,
      { ...context, blockName: 'ProvisionedThroughputOverride' },
      maskSecrets
    );
    return merged ? { ProvisionedThroughputOverride: merged } : {};
  }

  const rawMaxRead = asRecord(cfn['ReadOnDemandThroughputSettings'])?.['MaxReadRequestUnits'];
  reportUnresolvedRawMember(
    rawMaxRead,
    diagnostics,
    {
      ...context,
      blockName: 'ReadOnDemandThroughputSettings',
      member: 'MaxReadRequestUnits',
    },
    maskSecrets
  );
  const maxReadRequestUnits = coerceCfnInteger(rawMaxRead);
  const merged = mergeExplicitThroughputBlock<{ MaxReadRequestUnits: number }>(
    explicitOnDemand,
    maxReadRequestUnits !== undefined ? { MaxReadRequestUnits: maxReadRequestUnits } : undefined,
    ['MaxReadRequestUnits'],
    diagnostics,
    { ...context, blockName: 'OnDemandThroughputOverride' },
    maskSecrets
  );
  return merged ? { OnDemandThroughputOverride: merged } : {};
}

/** One CFn on-demand ceiling as the template states it, before coercion. */
export interface RawCeiling {
  /**
   * The CFn key is PRESENT (or its containing block is an unresolved
   * intrinsic). Distinguishing this from "coerced to a number" is what
   * separates a template REMOVAL — which must reset the live ceiling — from a
   * template that declared a value cdkd could not read, which must leave AWS
   * alone rather than clear it.
   */
  readonly declared: boolean;
  /** The coerced value, or `undefined` when absent OR present-but-unparseable. */
  readonly value: number | undefined;
}

/**
 * The TABLE-level on-demand ceilings, gathered from the two DIFFERENT places
 * the CFn `AWS::DynamoDB::GlobalTable` shape puts them (issue #1436).
 *
 * The write ceiling is top-level `WriteOnDemandThroughputSettings`, but the
 * READ ceiling lives on the LOCAL REPLICA as `ReadOnDemandThroughputSettings`
 * — the same write-here / read-on-the-replica split #1387 established one
 * level down for a GSI. The provider read only the write half, so the plain
 * CDK spelling
 *
 *     billing: Billing.onDemand({ maxReadRequestUnits: 100, maxWriteRequestUnits: 200 })
 *
 * deployed a table with NO read ceiling and reported success. That is a
 * drop on the way IN, not the absent-field-reset class of #1423 / #1434.
 *
 * The registry schema (`cloudformation:DescribeType`, 2026-08-09) confirms the
 * member on `ReplicaSpecification`:
 * `ReadOnDemandThroughputSettings: { MaxReadRequestUnits: integer, minimum 1 }`.
 */
export function collectTableOnDemandCeilings(
  properties: Record<string, unknown>,
  region: string,
  diagnostics?: ThroughputDiagnostic[],
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): { read: RawCeiling; write: RawCeiling } {
  const writeBlock = properties['WriteOnDemandThroughputSettings'];
  const replicas = properties['Replicas'];
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  // go-to-k/cdkd#2762: the table-level block takes the replica's place on a
  // table with settings replication ENABLED (CloudFormation refuses both at once).
  const replicaReadBlock = asRecord(localReplica)?.['ReadOnDemandThroughputSettings'];
  const readBlock = replicaReadBlock ?? properties[TABLE_READ_ON_DEMAND_KEY];
  const rawRead = asRecord(readBlock)?.['MaxReadRequestUnits'];
  const rawWrite = asRecord(writeBlock)?.['MaxWriteRequestUnits'];
  reportUnresolvedRawMember(
    rawRead,
    diagnostics,
    {
      blockName:
        replicaReadBlock !== undefined
          ? 'Replicas[local].ReadOnDemandThroughputSettings'
          : TABLE_READ_ON_DEMAND_KEY,
      member: 'MaxReadRequestUnits',
    },
    maskSecrets
  );
  reportUnresolvedRawMember(
    rawWrite,
    diagnostics,
    { blockName: 'WriteOnDemandThroughputSettings', member: 'MaxWriteRequestUnits' },
    maskSecrets
  );
  return {
    read: {
      declared: rawRead !== undefined || isUnresolvedIntrinsicBlock(readBlock),
      value: coerceCfnInteger(rawRead),
    },
    write: {
      declared: rawWrite !== undefined || isUnresolvedIntrinsicBlock(writeBlock),
      value: coerceCfnInteger(rawWrite),
    },
  };
}

/**
 * Diff CFn `Replicas[]` arrays. Keyed by `Region`. Returns adds, removes,
 * and modifies (entries whose other keys — SSESpecification,
 * GlobalSecondaryIndexes, TableClass, ... — differ from the old shape).
 */
export function diffReplicas(
  oldReplicas: Array<Record<string, unknown>>,
  newReplicas: Array<Record<string, unknown>>
): {
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  modified: Array<Record<string, unknown>>;
} {
  const oldByRegion = new Map<string, Record<string, unknown>>();
  const newByRegion = new Map<string, Record<string, unknown>>();
  for (const r of oldReplicas) {
    const region = r['Region'] as string | undefined;
    if (region) oldByRegion.set(region, r);
  }
  for (const r of newReplicas) {
    const region = r['Region'] as string | undefined;
    if (region) newByRegion.set(region, r);
  }

  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const modified: Array<Record<string, unknown>> = [];

  for (const [region, replica] of newByRegion) {
    if (!oldByRegion.has(region)) {
      added.push(replica);
    } else if (!deepEqual(oldByRegion.get(region), replica)) {
      modified.push(replica);
    }
  }
  for (const [region, replica] of oldByRegion) {
    if (!newByRegion.has(region)) {
      removed.push(replica);
    }
  }
  return { added, removed, modified };
}

/**
 * Diff CFn `GlobalSecondaryIndexes[]` arrays. Keyed by `IndexName`.
 * Modified = same IndexName but other fields (ProvisionedThroughput /
 * OnDemandThroughput) differ. KeySchema / Projection changes count as
 * "modified" too — AWS rejects those via UpdateGSI, but the diff caller
 * surfaces the AWS-side error rather than this helper second-guessing.
 */
export function diffGlobalSecondaryIndexes(
  oldGsi: GlobalSecondaryIndex[],
  newGsi: GlobalSecondaryIndex[]
): {
  added: GlobalSecondaryIndex[];
  removed: GlobalSecondaryIndex[];
  modified: GlobalSecondaryIndex[];
} {
  const oldByName = new Map<string, GlobalSecondaryIndex>();
  const newByName = new Map<string, GlobalSecondaryIndex>();
  for (const g of oldGsi) {
    if (g.IndexName) oldByName.set(g.IndexName, g);
  }
  for (const g of newGsi) {
    if (g.IndexName) newByName.set(g.IndexName, g);
  }
  const added: GlobalSecondaryIndex[] = [];
  const removed: GlobalSecondaryIndex[] = [];
  const modified: GlobalSecondaryIndex[] = [];
  for (const [name, gsi] of newByName) {
    if (!oldByName.has(name)) added.push(gsi);
    else if (!deepEqual(oldByName.get(name), gsi)) modified.push(gsi);
  }
  for (const [name, gsi] of oldByName) {
    if (!newByName.has(name)) removed.push(gsi);
  }
  return { added, removed, modified };
}

/**
 * Structural equality over the JSON form, ignoring object key order. Order is
 * not stable across the two sides: `aws-cdk-lib` renders a GSI `Projection` as
 * `{NonKeyAttributes, ProjectionType}` while an SDK readback is
 * `{ProjectionType, NonKeyAttributes}`. The JSON round-trip drops `undefined`
 * members and prototypes (`isDeepStrictEqual` checks both); array order stays
 * significant.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  try {
    return isDeepStrictEqual(asJson(a), asJson(b));
  } catch {
    return false;
  }
}

/**
 * A `LocalSecondaryIndexes` value for the immutability guard: absent, `null`
 * and `[]` all declare no index (go-to-k/cdkd#5489).
 */
function lsiListOrEmpty(value: unknown): unknown {
  if (value === undefined || value === null) return [];
  return value;
}
