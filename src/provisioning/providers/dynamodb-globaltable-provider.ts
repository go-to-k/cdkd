import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexUpdate,
  type LocalSecondaryIndex,
  type OnDemandThroughput,
  type ProvisionedThroughput,
  type ReplicaGlobalSecondaryIndex,
  type StreamSpecification,
  type Tag,
  type ReplicationGroupUpdate,
  type CreateReplicationGroupMemberAction,
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
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { readConfigString, replayWarn, requireConfigString } from '../config-shape.js';
import { withRetry } from '../../deployment/retry.js';
import { isThrottlingError } from '../../deployment/retryable-errors.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
} from '../../types/resource.js';

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
export class DynamoDBGlobalTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
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
        // Note: `AWS::DynamoDB::GlobalTable` has NO top-level `Tags`
        // property. Tags live inside `Replicas[].Tags`, which is
        // already covered by the `Replicas` entry above.
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
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
    const client = new DynamoDBClient({ region });
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
    const client = new ApplicationAutoScalingClient({ region });
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
    this.localAutoScalingClient = new ApplicationAutoScalingClient({ region });
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
    this.logger.debug(`Creating DynamoDB GlobalTable ${logicalId}`);

    const tableName =
      (properties['TableName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });
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
    let billingMode: string;
    try {
      billingMode = requireConfigString(
        properties['BillingMode'],
        'PAY_PER_REQUEST',
        'AWS::DynamoDB::GlobalTable BillingMode',
        replayWarn(this.logger, context)
      );
    } catch (error) {
      throw new ProvisioningError(
        error instanceof Error ? error.message : String(error),
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
        diagnostics
      );
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
      try {
        // `replayWarn` (issue #1544): a state record written by an older
        // binary can carry `StreamSpecification: ''`, and on the rollback
        // executor's reverse-replacement replay the user cannot edit that
        // record — a hard refusal would leave the old table unrestorable. The
        // downgrade treats the malformed block as `{}` (stream enabled with
        // the NEW_AND_OLD_IMAGES default, exactly what an empty block means),
        // warns, and proceeds; template-path creates keep the refusal.
        streamViewType = readConfigString(
          streamSpecInput,
          'StreamViewType',
          'NEW_AND_OLD_IMAGES',
          'AWS::DynamoDB::GlobalTable StreamSpecification',
          replayWarn(this.logger, context)
        );
      } catch (error) {
        throw new ProvisioningError(
          error instanceof Error ? error.message : String(error),
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
    } else if (needsStream) {
      this.logger.info(
        `Auto-enabling streams (NEW_AND_OLD_IMAGES) on ${logicalId} — required for cross-region replication`
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
    try {
      // The trailing `onUnusableIndexes` hook is the GSI guard's replay
      // downgrade (issue #1544): on a reverse-replacement replay a non-array
      // `GlobalSecondaryIndexes` recorded in state warns and the block is
      // OMITTED (zero indexes) instead of stranding the rollback; on a
      // template-path create the hook is `undefined` and the refusal stands.
      const onUnusableCreateIndexes = replayWarn(this.logger, context).onUnusable;
      sdkIndexes = toSdkGlobalSecondaryIndexes(
        properties,
        currentRegion,
        billingMode,
        'min',
        diagnostics,
        onUnusableCreateIndexes &&
          ((message) =>
            onUnusableCreateIndexes(
              `${message} Omitting the malformed block, so this create carries NO ` +
                `indexes; the same value is REFUSED on a template-path create`
            ))
      );
    } catch (error) {
      throw new ProvisioningError(
        error instanceof Error ? error.message : String(error),
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
    if (sdkIndexes.length > 0) {
      createParams.GlobalSecondaryIndexes = sdkIndexes;
    }
    if (properties['LocalSecondaryIndexes']) {
      createParams.LocalSecondaryIndexes = properties[
        'LocalSecondaryIndexes'
      ] as LocalSecondaryIndex[];
    }

    // SSE: GlobalTable's CFn shape is { SSEEnabled, SSEType } with NO
    // top-level KMSMasterKeyId (per-replica only).
    if (properties['SSESpecification']) {
      const sse = properties['SSESpecification'] as Record<string, unknown>;
      const sseInput: { Enabled: boolean; SSEType?: 'KMS' } = {
        Enabled: sse['SSEEnabled'] !== undefined ? Boolean(sse['SSEEnabled']) : true,
      };
      if (sse['SSEType']) {
        sseInput.SSEType = sse['SSEType'] as 'KMS';
      }
      createParams.SSESpecification = sseInput;
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
    if (properties['TableClass']) {
      createParams.TableClass = properties['TableClass'] as
        | 'STANDARD'
        | 'STANDARD_INFREQUENT_ACCESS';
    }

    // Table-level on-demand ceilings. CDK's `Billing.onDemand({ maxRead…,
    // maxWrite… })` splits the pair across two CFn locations — the write half
    // at top-level `WriteOnDemandThroughputSettings`, the read half on the
    // LOCAL replica's `ReadOnDemandThroughputSettings` — and only the write
    // half was ever wired, so a user who capped read request units got a table
    // with NO read ceiling and a success report (issue #1436). Both halves go
    // into the SAME `CreateTable` member.
    const createCeilings = collectTableOnDemandCeilings(properties, currentRegion, diagnostics);
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
    const localReplicaTags = localReplicaForTags?.['Tags'] as Tag[] | undefined;
    if (localReplicaTags && localReplicaTags.length > 0) {
      createParams.Tags = localReplicaTags;
    }

    // Pre-flight the CROSS-REGION replica blocks through the same translators
    // the post-`CreateTable` wiring will use, discarding the result and
    // keeping only the diagnostics. Issue #1428's third rejected design
    // surfaced its complaint from inside that wiring, which meant a
    // statically-detectable garbage value created a real table first — and
    // under `DeletionProtectionEnabled: true` the compensating delete fails,
    // orphaning a billing table with no state record. Reporting is cheap and
    // pure, so it happens BEFORE the first mutating call instead.
    for (const replica of replicas) {
      const replicaRegion = replica['Region'] as string | undefined;
      if (!replicaRegion || replicaRegion === currentRegion) continue;
      toSdkReplicaGlobalSecondaryIndexes(
        replica['GlobalSecondaryIndexes'],
        billingMode,
        diagnostics
      );
      toSdkReplicaThroughputOverrides(replica, billingMode, diagnostics, {});
    }
    this.reportThroughputDiagnostics(diagnostics, logicalId, tableName);

    try {
      await this.dynamoDBClient.send(new CreateTableCommand(createParams));
      this.logger.debug(`CreateTable initiated for ${tableName}, waiting for ACTIVE`);
    } catch (error) {
      // CreateTable itself failed — AWS never committed the table, no
      // cleanup needed.
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB GlobalTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }

    // Inner try/catch wraps every post-CreateTable wiring call so a
    // wiring failure issues a best-effort DeleteTable before re-throwing.
    // Without this, an aborted deploy leaves a billing AWS-side table
    // with no cdkd state record (PR #374 pattern).
    try {
      const tableInfo = await this.waitForTableActive(tableName, logicalId);

      // Replica adds: one UpdateTable per region (AWS rejects multiple
      // ReplicaUpdates in a single call). Each call must complete before
      // the next — UpdateTable returns immediately but the table flips to
      // UPDATING until the replica is provisioned.
      for (const replica of replicas) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        // No diagnostics collector: the same translation already ran in the
        // pre-flight scan above, so passing one here would warn twice.
        await this.addReplica(tableName, replica, region, logicalId, billingMode);
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
        const replicaTags = replica['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
        if (!replicaTags || replicaTags.length === 0) continue;
        await this.applyCrossRegionReplicaTagsDiff(
          tableInfo.tableArn,
          region,
          undefined, // create() has no previous state — every tag is an add
          replicaTags,
          tableName
        );
      }

      // TTL is a separate API call (UpdateTimeToLive). Applied after
      // table + replicas are ACTIVE so the AWS-side request validates.
      if (properties['TimeToLiveSpecification']) {
        const ttl = properties['TimeToLiveSpecification'] as Record<string, unknown>;
        const attributeName = ttl['AttributeName'] as string | undefined;
        const enabled = ttl['Enabled'] !== undefined ? Boolean(ttl['Enabled']) : true;
        if (attributeName) {
          await this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: enabled, AttributeName: attributeName },
            })
          );
        }
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
            collectAutoScalingTargets(properties, currentRegion),
            currentRegion
          );
        } catch (autoScalingErr) {
          this.logger.warn(
            `Auto-scaling registration failed for ${tableName}: ` +
              `${autoScalingErr instanceof Error ? autoScalingErr.message : String(autoScalingErr)}. ` +
              `The table was created successfully; re-run the deploy to register the ` +
              `scaling targets.`
          );
        }
      }

      this.logger.debug(`Successfully created DynamoDB GlobalTable ${logicalId}: ${tableName}`);

      return {
        physicalId: tableName,
        attributes: {
          Arn: tableInfo.tableArn,
          TableId: tableInfo.tableId,
          StreamArn: tableInfo.streamArn,
          TableName: tableName,
        },
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
      this.logger.warn(
        `Wiring failed after CreateTable for ${tableName}; attempting best-effort cleanup`
      );
      try {
        const describe = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const replicasForCleanup = describe.Table?.Replicas ?? [];
        for (const replica of replicasForCleanup) {
          const region = replica.RegionName;
          if (!region || region === currentRegion) continue;
          try {
            await this.dynamoDBClient.send(
              new UpdateTableCommand({
                TableName: tableName,
                ReplicaUpdates: [{ Delete: { RegionName: region } }],
              })
            );
            await this.waitForReplicaGone(tableName, region, logicalId);
          } catch (replicaCleanupErr) {
            const msg =
              replicaCleanupErr instanceof Error
                ? replicaCleanupErr.message
                : String(replicaCleanupErr);
            this.logger.warn(
              `Partial-create cleanup: failed to drop replica ${region} on ${tableName}: ${msg}. ` +
                `Run: aws dynamodb update-table --table-name ${tableName} ` +
                `--replica-updates 'Delete={RegionName=${region}}' --region ${currentRegion}`
            );
          }
        }
        await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
      } catch (cleanupErr) {
        const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.logger.warn(
          `Partial-create cleanup failed for ${tableName}: ${cleanupMsg}. ` +
            `Run: aws dynamodb delete-table --table-name ${tableName} ` +
            `to remove the orphaned AWS-side table.`
        );
      }
      const cause = wiringError instanceof Error ? wiringError : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB GlobalTable ${logicalId}: ${wiringError instanceof Error ? wiringError.message : String(wiringError)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }
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
    physicalId: string
  ): void {
    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      const scope = diagnostic.indexName
        ? `GSI '${diagnostic.indexName}' on ${physicalId}`
        : physicalId;
      const line = `DynamoDB GlobalTable ${logicalId}: ${scope}: ${diagnostic.message}`;
      if (seen.has(line)) continue;
      seen.add(line);
      this.logger.warn(line);
    }
  }

  /**
   * Add a single replica region. Issues one `UpdateTableCommand` with
   * `ReplicaUpdates: [{ Create: { RegionName, ... } }]` and polls
   * `DescribeTable` until the replica's `ReplicaStatus` flips to ACTIVE.
   * Capped at 10 minutes per replica (AWS Replica provisioning typically
   * takes 1–5 min).
   *
   * DELIBERATELY UNMAPPED replica sub-keys (Issue #1387 — recorded rather
   * than silently dropped; `CreateReplicationGroupMemberAction` simply has
   * no member for them, so they need their own follow-up API calls):
   *  - `ReplicaStreamSpecification.ResourcePolicy` — the DynamoDB Streams
   *    resource policy is set by `PutResourcePolicy` against the replica's
   *    STREAM ARN, not by any `UpdateTable` field.
   *  - `ResourcePolicy` — the table-level resource policy, likewise a
   *    separate `PutResourcePolicy` call.
   *  - `GlobalSecondaryIndexes[].ContributorInsightsSpecification` — a
   *    per-index `UpdateContributorInsights` call.
   * `Replicas` is declared in `handledProperties` at the TOP level, which
   * is the granularity cdkd's pre-flight property-coverage check works at;
   * these nested keys are tracked as a known gap, not a supported surface.
   */
  private async addReplica(
    tableName: string,
    replica: Record<string, unknown>,
    region: string,
    logicalId: string,
    billingMode: string,
    diagnostics?: ThroughputDiagnostic[]
  ): Promise<void> {
    const create: CreateReplicationGroupMemberAction = {
      RegionName: region,
    };
    if (replica['KMSMasterKeyId']) {
      create.KMSMasterKeyId = replica['KMSMasterKeyId'] as string;
    }
    // Replica-level GSI overrides. The CFn
    // `ReplicaGlobalSecondaryIndexSpecification` spells the per-replica read
    // throughput `Read{Provisioned,OnDemand}ThroughputSettings`, while the SDK
    // wants `{Provisioned,OnDemand}ThroughputOverride` — translate (Issue #1387).
    const replicaIndexes = toSdkReplicaGlobalSecondaryIndexes(
      replica['GlobalSecondaryIndexes'],
      billingMode,
      diagnostics
    );
    if (replicaIndexes) {
      create.GlobalSecondaryIndexes = replicaIndexes;
    }
    // The replica's own TABLE-level read ceiling / read capacity, which uses
    // the SAME two CFn spellings one level up (issue #1436). A non-local
    // replica's `ReadOnDemandThroughputSettings` was dropped entirely before
    // this — the replica silently kept the source table's default.
    const tableOverrides = toSdkReplicaThroughputOverrides(replica, billingMode, diagnostics, {});
    if (tableOverrides.ProvisionedThroughputOverride) {
      create.ProvisionedThroughputOverride = tableOverrides.ProvisionedThroughputOverride;
    }
    if (tableOverrides.OnDemandThroughputOverride) {
      create.OnDemandThroughputOverride = tableOverrides.OnDemandThroughputOverride;
    }
    if (replica['TableClassOverride']) {
      create.TableClassOverride = replica['TableClassOverride'] as
        | 'STANDARD'
        | 'STANDARD_INFREQUENT_ACCESS';
    }

    const replicaUpdates: ReplicationGroupUpdate[] = [{ Create: create }];

    await this.dynamoDBClient.send(
      new UpdateTableCommand({
        TableName: tableName,
        ReplicaUpdates: replicaUpdates,
      })
    );

    await this.waitForReplicaActive(tableName, region, logicalId);
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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DynamoDB GlobalTable ${logicalId}: ${physicalId}`);

    // ─── Immutable property guards (defense-in-depth) ───────────────────
    if (
      properties['TableName'] !== undefined &&
      previousProperties['TableName'] !== undefined &&
      properties['TableName'] !== previousProperties['TableName']
    ) {
      throw new ProvisioningError(
        `TableName is immutable on AWS::DynamoDB::GlobalTable; replacement required (deploy with --replace, or destroy + redeploy)`,
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
        `KeySchema is immutable on AWS::DynamoDB::GlobalTable; replacement required (deploy with --replace, or destroy + redeploy)`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    if (
      properties['LocalSecondaryIndexes'] !== undefined &&
      previousProperties['LocalSecondaryIndexes'] !== undefined &&
      !deepEqual(properties['LocalSecondaryIndexes'], previousProperties['LocalSecondaryIndexes'])
    ) {
      throw new ProvisioningError(
        `LocalSecondaryIndexes is immutable on AWS::DynamoDB::GlobalTable; replacement required (deploy with --replace, or destroy + redeploy)`,
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
          `key schema still references them (offenders: ${removedButStillReferenced.map((a) => a.AttributeName).join(', ')}); ` +
          `replacement required`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // Resolve the client region ONCE for the whole update — the Tags
    // diff step, the BillingMode flip's capacity derivation, and the
    // Replicas diff loop all need it.
    const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';

    try {
      // 1. Wait for ACTIVE before any update — defensive against rare
      // states where a previous deploy left the table mid-transition.
      await this.waitForTableActiveAfterUpdate(physicalId, logicalId);

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
      const extractLocalTags = (
        props: Record<string, unknown>
      ): Array<{ Key?: string; Value?: string }> | undefined => {
        const replicas = (props['Replicas'] ?? []) as Array<Record<string, unknown>>;
        const local = replicas.find((r) => r['Region'] === currentRegion);
        return local?.['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
      };
      if (tableArn) {
        await this.applyTagDiff(
          tableArn,
          extractLocalTags(previousProperties),
          extractLocalTags(properties)
        );
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
      // this costs no extra call. An ABSENT previous keeps defaulting to
      // PAY_PER_REQUEST (the create-path default) — only the
      // present-but-unusable case consults AWS.
      const recordedOldBilling = previousProperties['BillingMode'];
      const recordedOldBillingUsable =
        recordedOldBilling === undefined ||
        (typeof recordedOldBilling === 'string' && recordedOldBilling.trim() !== '');
      const oldBilling = recordedOldBillingUsable
        ? ((recordedOldBilling as string | undefined) ?? 'PAY_PER_REQUEST')
        : // NOT this provider's create-path default: the two arms answer
          // different questions. An ABSENT recorded previous means "the
          // template declared no BillingMode", where PAY_PER_REQUEST is
          // GlobalTable's own default; an ABSENT `BillingModeSummary` is
          // AWS saying the table was created without an explicit mode, which
          // IS PROVISIONED (the same reading `AWS::DynamoDB::Table`'s
          // `readCurrentState` takes). Using the template default here would
          // read a live PROVISIONED table as on-demand and mask a real flip.
          (describeResp.Table?.BillingModeSummary?.BillingMode ?? 'PROVISIONED');
      if (!recordedOldBillingUsable) {
        this.logger.warn(
          `AWS::DynamoDB::GlobalTable ${logicalId}: the recorded previous BillingMode ` +
            `is unusable (${JSON.stringify(recordedOldBilling)}) — using the table's ` +
            `actual billing mode (${oldBilling}) as the comparison baseline for this ` +
            `update so a corrected template does not issue a same-mode UpdateTable.`
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
      let billingUnusable = false;
      const requestedBilling = requireConfigString(
        properties['BillingMode'],
        'PAY_PER_REQUEST',
        'AWS::DynamoDB::GlobalTable BillingMode',
        {
          onUnusable: (message) => {
            billingUnusable = true;
            this.logger.warn(
              `${message} The table's current billing mode (${oldBilling}) is kept for this ` +
                `update rather than flipped to the default.`
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
      const desiredCeilings = collectTableOnDemandCeilings(properties, currentRegion, diagnostics);
      // The TABLE-level provisioned capacity is only SENT by step 4's billing
      // flip, which is also the only place it can fall through to 5/5 — so the
      // #1511 diagnostic is gated on exactly that condition rather than on
      // `newBilling` alone, which would warn about a value nothing consumes.
      // Same `'seed'` source step 4 uses, so the blamed member matches what it
      // would have read. Result discarded: this call is for the diagnostics.
      const flippingToProvisioned = oldBilling !== newBilling && newBilling === 'PROVISIONED';
      if (flippingToProvisioned) {
        derivePerCallProvisionedThroughput(properties, currentRegion, 'seed', diagnostics);
      }
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
      // exactly as they are (keep-previous), never dropped.
      // The two sides get DIFFERENT treatment, because only one of them can be
      // recovered from AWS.
      let desiredGsiUnusable = false;
      const onUnusableGsiBlock = (message: string): void => {
        desiredGsiUnusable = true;
        this.logger.warn(
          `${message} No GlobalSecondaryIndexes change is applied by this update; ` +
            `the table's existing indexes are left untouched.`
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
        this.logger.warn(
          `${message} (recorded in cdkd state, not in the template) — using the ` +
            `table's LIVE indexes as the comparison baseline for this update, so a ` +
            `corrected template still applies.`
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
      // rejects); `deepEqual` is `JSON.stringify`, so AWS's member order
      // versus the translator's manufactured differences on any index
      // carrying both warm and provisioned throughput; and live capacity
      // fights auto-scaling (live 10 vs the template's min 1 reads as a
      // scale-down nobody asked for).
      //
      // Existence is the ONLY thing the live table can tell us that the junk
      // state record cannot, and it is the only thing needed to stop the
      // permanent loss — so it is the only thing taken. See
      // `previousSdkIndexes` for how the baseline is then built.
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
        onUnusableGsiBlock
      );
      if (flippingToProvisioned) {
        toSdkGlobalSecondaryIndexes(
          properties,
          currentRegion,
          newBilling,
          'seed',
          diagnostics,
          onUnusableGsiBlock
        );
      }
      for (const replica of (properties['Replicas'] ?? []) as Array<Record<string, unknown>>) {
        const replicaRegion = asRecord(replica)?.['Region'];
        if (typeof replicaRegion !== 'string' || replicaRegion === currentRegion) continue;
        toSdkReplicaGlobalSecondaryIndexes(
          replica['GlobalSecondaryIndexes'],
          newBilling,
          diagnostics
        );
        toSdkReplicaThroughputOverrides(replica, newBilling, diagnostics, {});
      }
      this.reportThroughputDiagnostics(diagnostics, logicalId, physicalId);

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
          this.logger.warn(
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
      if (
        properties['TableClass'] !== undefined &&
        properties['TableClass'] !== previousProperties['TableClass']
      ) {
        flatUpdate.TableClass = properties['TableClass'] as
          | 'STANDARD'
          | 'STANDARD_INFREQUENT_ACCESS';
        flatChanged = true;
      }
      if (
        properties['SSESpecification'] !== undefined &&
        !deepEqual(properties['SSESpecification'], previousProperties['SSESpecification'])
      ) {
        const sse = properties['SSESpecification'] as Record<string, unknown>;
        flatUpdate.SSESpecification = {
          Enabled: sse['SSEEnabled'] !== undefined ? Boolean(sse['SSEEnabled']) : true,
          ...(sse['SSEType'] !== undefined && { SSEType: sse['SSEType'] as 'KMS' }),
        };
        flatChanged = true;
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
        // strand the replay. The downgrade SKIPS the block entirely rather
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
              this.logger.warn(
                `${message} The table's existing stream configuration is left ` +
                  `untouched for this update rather than re-pointed at the default.`
              );
            },
          }
        );
        if (!streamSpecUnusable) {
          flatUpdate.StreamSpecification = {
            StreamEnabled: true,
            StreamViewType: streamViewType,
          } as StreamSpecification;
          flatChanged = true;
        }
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
        await this.dynamoDBClient.send(new UpdateTableCommand(flatUpdate));
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
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
            'seed'
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
            onUnusableGsiBlock
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
            onUnusablePreviousGsiBlock
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
            indexUpdates.push({
              Update: {
                IndexName: indexName,
                ProvisionedThroughput: gsi.ProvisionedThroughput,
                ...(warmChanged && { WarmThroughput: gsi.WarmThroughput }),
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
        await this.dynamoDBClient.send(new UpdateTableCommand(billingUpdate));
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }

      // 4a. The table-level on-demand ceilings a PROVISIONED ->
      // PAY_PER_REQUEST flip deferred (see step 3's `deferCeilingsPastFlip`):
      // now that the table IS on-demand, the declared ceilings are a plain
      // ceiling-set. Sent as its own UpdateTable — AWS's state-machine rule
      // wants the flip call to carry the flip, and the well-probed payload
      // shape here is the same one step 3 sends on a non-flip deploy.
      if (deferCeilingsPastFlip) {
        await this.dynamoDBClient.send(
          new UpdateTableCommand({ TableName: physicalId, OnDemandThroughput: onDemandPayload })
        );
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
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
          effectiveNewAutoScaling
        );
        autoScalingApplied.add(
          autoScalingTargetKey({
            dimension: 'dynamodb:table:WriteCapacityUnits',
            region: currentRegion,
          })
        );
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
            regionalAutoScalingClient
          );
          autoScalingApplied.add(
            autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
          );
        }

        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            ReplicaUpdates: [{ Delete: { RegionName: region } }],
          })
        );
        await this.waitForReplicaGone(physicalId, region, logicalId);
      }
      for (const replica of replicaDiff.added) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        // Diagnostics already emitted by the pre-flight scan at the top of
        // update(); passing the collector again would warn twice.
        await this.addReplica(physicalId, replica, region, logicalId, newBilling);

        // Cross-region Tags propagation for the newly-added replica
        // (Issue #441 follow-up — mirrors the create-side + modified
        // paths). `UpdateTable(ReplicaUpdates: [{Create: ...}])` does
        // not accept a `Tags` field, so any `Replicas[].Tags` declared
        // in the new replica entry must be applied via a separate
        // `TagResource` against the replica's region-scoped ARN.
        const newReplicaTags = replica['Tags'] as
          | Array<{ Key?: string; Value?: string }>
          | undefined;
        await this.applyCrossRegionReplicaTagsDiff(
          tableArn,
          region,
          undefined,
          newReplicaTags,
          physicalId
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
            regionalAutoScalingClient
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
        const oldReplicaTags = oldReplica?.['Tags'] as
          | Array<{ Key?: string; Value?: string }>
          | undefined;
        const newReplicaTags = replica['Tags'] as
          | Array<{ Key?: string; Value?: string }>
          | undefined;

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
          physicalId
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
            regionalAutoScalingClient
          );
          autoScalingApplied.add(
            autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
          );
        }

        const updateAction: UpdateReplicationGroupMemberAction = { RegionName: region };
        if (replica['KMSMasterKeyId'] !== undefined) {
          updateAction.KMSMasterKeyId = replica['KMSMasterKeyId'] as string;
        }
        // Same CFn -> SDK per-replica GSI throughput translation as the
        // create-side `addReplica` (Issue #1387).
        const replicaIndexes = toSdkReplicaGlobalSecondaryIndexes(
          replica['GlobalSecondaryIndexes'],
          newBilling
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
          {}
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
            {}
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
            this.logger.warn(
              `Cross-region replica ${region} of ${physicalId}: the template no longer ` +
                `declares ${droppedOverrides.join(' / ')}, but DynamoDB offers no way to ` +
                `CLEAR a replica-level throughput override — a -1 sentinel is stored ` +
                `literally, and an empty override block wedges the table in UPDATING ` +
                `(both live-probed, issue #1436). The previous override is STILL IN ` +
                `EFFECT on AWS. Set an explicit value, or remove and re-add the replica, ` +
                `to change it.`
            );
          }
        }
        if (replica['TableClassOverride']) {
          updateAction.TableClassOverride = replica['TableClassOverride'] as
            | 'STANDARD'
            | 'STANDARD_INFREQUENT_ACCESS';
        }
        // AWS rejects an UpdateReplica with no update fields
        // (ValidationException). When the only change in the modified
        // replica is `Tags` (now applied above via per-region client),
        // the updateAction has only `RegionName`. Skip the
        // UpdateReplica SDK call in that case — the Tags-only diff is
        // already in flight against the regional client.
        const hasUpdateField =
          updateAction.KMSMasterKeyId !== undefined ||
          updateAction.GlobalSecondaryIndexes !== undefined ||
          updateAction.TableClassOverride !== undefined ||
          updateAction.ProvisionedThroughputOverride !== undefined ||
          updateAction.OnDemandThroughputOverride !== undefined;
        if (!hasUpdateField) {
          this.logger.debug(
            `Cross-region replica ${region} of ${physicalId}: only Tags-style ` +
              `changes detected; UpdateReplica skipped (AWS rejects empty ` +
              `Update actions). Tags propagation handled above via per-region client.`
          );
          continue;
        }
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            ReplicaUpdates: [{ Update: updateAction }],
          })
        );
        await this.waitForReplicaActive(physicalId, region, logicalId);
      }

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
        onUnusablePreviousGsiBlock
      );
      // With a junk state record the baseline is built from the DESIRED side
      // filtered to the indexes that actually EXIST live. Three properties
      // follow, and each closes one of the ways a value-carrying live baseline
      // went wrong:
      //   - a desired index that exists live appears IDENTICALLY on both sides,
      //     so it is a no-op: no capacity, projection or key-order comparison
      //     against AWS-shaped values ever happens;
      //   - a desired index that does NOT exist live is ADDED, which is the
      //     permanent-loss case this whole fallback exists for;
      //   - an index live but absent from the template is in NEITHER side, so
      //     it is never DELETED. Deleting is irreversible and a junk state
      //     record cannot tell "cdkd used to manage this" from "somebody
      //     created it out of band", so the safe reading is to leave it and
      //     say so.
      const previousSdkIndexes = previousGsiUnusable
        ? desiredSdkIndexes.filter(
            (gsi) => typeof gsi.IndexName === 'string' && liveIndexNames.has(gsi.IndexName)
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
          this.logger.warn(
            `AWS::DynamoDB::GlobalTable ${logicalId}: ${liveOnly.join(', ')} exist(s) on the ` +
              `table but not in the template. No Delete is issued while the recorded ` +
              `GlobalSecondaryIndexes are unusable — a junk state record cannot prove cdkd ` +
              `created them. Re-deploy once state carries a valid block to remove them.`
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
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }
      for (const gsi of gsiDiff.added) {
        if (!gsi.IndexName || !gsi.KeySchema || !gsi.Projection) continue;
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
            ...(gsi.WarmThroughput && { WarmThroughput: gsi.WarmThroughput }),
          },
        };
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            AttributeDefinitions: newAttrs,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
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
        // `toFiniteNumber`, so a present-but-unparseable value (an unresolved
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
        if (
          gsi.WarmThroughput !== undefined &&
          !deepEqual(gsi.WarmThroughput, previousSdk?.WarmThroughput)
        ) {
          update.WarmThroughput = gsi.WarmThroughput;
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
          if (!billingFlipped && unresolvedMembers.length === 0) {
            this.logger.warn(
              `GSI '${gsi.IndexName}' on ${physicalId} changed in a way DynamoDB's ` +
                `UpdateTable cannot express (KeySchema / Projection are immutable on an ` +
                `existing index). Recreate the index under a new name to apply the change.`
            );
          }
          continue;
        }
        const gsiUpdate: GlobalSecondaryIndexUpdate = { Update: update };
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
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
        this.logger.warn(
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
          await this.waitForIndexesActive(physicalId, logicalId);
        }
        await this.reconcileAutoScalingTargets(
          physicalId,
          collectAutoScalingTargets(previousProperties, currentRegion),
          newBilling === 'PAY_PER_REQUEST'
            ? []
            : collectAutoScalingTargets(properties, currentRegion),
          currentRegion,
          autoScalingApplied
        );
      }

      // 7. TimeToLiveSpecification (separate API).
      // AWS enforces a 4-hour rate limit on TTL changes per table
      // ("Time to live has been modified multiple times within a fixed
      // interval"). Catch and rewrap with an actionable hint pointing
      // at the AWS-side limit, so a user redeploying a TTL-toggling
      // stack twice in tight succession sees what's happening instead
      // of a raw AWS error.
      if (
        !deepEqual(
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        )
      ) {
        const sendTtl = async (cmd: UpdateTimeToLiveCommand): Promise<void> => {
          try {
            await this.dynamoDBClient.send(cmd);
          } catch (ttlErr) {
            const msg = ttlErr instanceof Error ? ttlErr.message : String(ttlErr);
            if (msg.includes('Time to live has been modified multiple times')) {
              throw new ProvisioningError(
                `AWS rejected TimeToLive update on ${physicalId}: ${msg}. ` +
                  `AWS enforces a ~4-hour rate limit on TTL changes per table; ` +
                  `wait and redeploy, or keep the previous TTL state in this deploy.`,
                resourceType,
                logicalId,
                physicalId,
                ttlErr instanceof Error ? ttlErr : undefined
              );
            }
            throw ttlErr;
          }
        };
        const ttl = properties['TimeToLiveSpecification'] as Record<string, unknown> | undefined;
        if (ttl?.['AttributeName']) {
          await sendTtl(
            new UpdateTimeToLiveCommand({
              TableName: physicalId,
              TimeToLiveSpecification: {
                Enabled: ttl['Enabled'] !== undefined ? Boolean(ttl['Enabled']) : true,
                AttributeName: ttl['AttributeName'] as string,
              },
            })
          );
        } else if (previousProperties['TimeToLiveSpecification']) {
          // TTL removed from template: AWS requires the previous
          // AttributeName to disable it. Pull from old props.
          const prevTtl = previousProperties['TimeToLiveSpecification'] as Record<string, unknown>;
          if (prevTtl['AttributeName']) {
            await sendTtl(
              new UpdateTimeToLiveCommand({
                TableName: physicalId,
                TimeToLiveSpecification: {
                  Enabled: false,
                  AttributeName: prevTtl['AttributeName'] as string,
                },
              })
            );
          }
        }
      }

      // Resolve attributes for return.
      const finalDescribe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: finalDescribe.Table?.TableArn,
          TableId: finalDescribe.Table?.TableId,
          StreamArn: finalDescribe.Table?.LatestStreamArn,
          TableName: physicalId,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DynamoDB GlobalTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
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
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    await this.applyTagDiffOnClient(this.dynamoDBClient, tableArn, oldTagsRaw, newTagsRaw);
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
    oldTags: Array<{ Key?: string; Value?: string }> | undefined,
    newTags: Array<{ Key?: string; Value?: string }> | undefined,
    physicalIdForLogs: string
  ): Promise<void> {
    if (deepEqual(oldTags, newTags)) return;
    if (!tableArn) {
      this.logger.warn(
        `Local DescribeTable returned no TableArn — cannot propagate Tags to cross-region replica ${region} of ${physicalIdForLogs}`
      );
      return;
    }
    const replicaArn = this.replicaArnForRegion(tableArn, region);
    if (!replicaArn) {
      this.logger.warn(
        `Could not derive replica ARN for region ${region} from ${tableArn} — skipping Tags propagation for ${physicalIdForLogs}`
      );
      return;
    }
    try {
      const regionalClient = this.getRegionalClient(region);
      await this.applyTagDiffOnClient(regionalClient, replicaArn, oldTags, newTags);
    } catch (tagErr) {
      this.logger.warn(
        `Could not apply Tags diff to cross-region replica ${region} of ${physicalIdForLogs}: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}. The replica's Tags state will surface as drift until the next successful deploy.`
      );
    }
  }

  /**
   * Apply a Tags diff against the given `DynamoDBClient` (which may be
   * the local client or a per-region client returned by
   * `getRegionalClient`). Used by the local-replica path AND the
   * cross-region replica Tags propagation path (Issue #389 / #441).
   */
  private async applyTagDiffOnClient(
    client: DynamoDBClient,
    tableArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await client.send(new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove }));
      this.logger.debug(
        `Removed ${tagsToRemove.length} tag(s) from DynamoDB GlobalTable ${tableArn}`
      );
    }
    if (tagsToAdd.length > 0) {
      await client.send(new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd }));
      this.logger.debug(
        `Added/updated ${tagsToAdd.length} tag(s) on DynamoDB GlobalTable ${tableArn}`
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
    indexName?: string
  ): Promise<void> {
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

    if (newEnabled) {
      // Register OR update scalable target (idempotent on no-op).
      const minCapacity = Number(newSettings!['MinCapacity'] ?? 0);
      const maxCapacity = Number(newSettings!['MaxCapacity'] ?? 0);
      if (!Number.isFinite(minCapacity) || !Number.isFinite(maxCapacity)) {
        this.logger.warn(
          `Cannot apply auto-scaling diff on ${tableName} (${dimension}): ` +
            `MinCapacity / MaxCapacity must be numbers, got ` +
            `${String(newSettings!['MinCapacity'])} / ${String(newSettings!['MaxCapacity'])}`
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
            ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
          }
        );
      } catch (err) {
        this.logger.warn(
          `Could not register auto-scaling target on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling register-scalable-target ` +
            `--service-namespace dynamodb --resource-id ${resourceId} ` +
            `--scalable-dimension ${dimension} --min-capacity ${minCapacity} ` +
            `--max-capacity ${maxCapacity}`
        );
        return;
      }

      const tttCfg = (newSettings!['TargetTrackingScalingPolicyConfiguration'] ?? {}) as Record<
        string,
        unknown
      >;
      const targetValue = Number(tttCfg['TargetValue']);
      if (!Number.isFinite(targetValue)) {
        this.logger.warn(
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
      if (tttCfg['ScaleInCooldown'] !== undefined) {
        targetTrackingConfig['ScaleInCooldown'] = Number(tttCfg['ScaleInCooldown']);
      }
      if (tttCfg['ScaleOutCooldown'] !== undefined) {
        targetTrackingConfig['ScaleOutCooldown'] = Number(tttCfg['ScaleOutCooldown']);
      }
      if (tttCfg['DisableScaleIn'] !== undefined) {
        targetTrackingConfig['DisableScaleIn'] = Boolean(tttCfg['DisableScaleIn']);
      }
      try {
        // Same throttle-only retry as the register above — a swallowed
        // throttle here leaves a registered target with NO policy, which
        // scales nothing.
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
            ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
          }
        );
        this.logger.debug(
          `Upserted auto-scaling policy ${policyName} on ${tableName} (${dimension})`
        );
      } catch (err) {
        this.logger.warn(
          `Could not put auto-scaling policy on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling put-scaling-policy ` +
            `--policy-name ${policyName} --service-namespace dynamodb ` +
            `--resource-id ${resourceId} --scalable-dimension ${dimension} ` +
            `--policy-type TargetTrackingScaling`
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
      await asClient.send(
        new DeleteScalingPolicyCommand({
          PolicyName: policyName,
          ServiceNamespace: 'dynamodb',
          ResourceId: resourceId,
          ScalableDimension: dimension,
        })
      );
    } catch (err) {
      if (!isObjectNotFound(err)) {
        this.logger.warn(
          `Could not delete auto-scaling policy on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling delete-scaling-policy ` +
            `--policy-name ${policyName} --service-namespace dynamodb ` +
            `--resource-id ${resourceId} --scalable-dimension ${dimension}`
        );
      }
      // Continue to the Deregister attempt regardless — AWS may have
      // already cleaned up the policy, in which case the deregister
      // succeeds (or also returns ObjectNotFoundException, also
      // suppressed below).
    }
    try {
      await asClient.send(
        new DeregisterScalableTargetCommand({
          ServiceNamespace: 'dynamodb',
          ResourceId: resourceId,
          ScalableDimension: dimension,
        })
      );
      this.logger.debug(`Deregistered auto-scaling target ${resourceId} (${dimension})`);
    } catch (err) {
      if (!isObjectNotFound(err)) {
        this.logger.warn(
          `Could not deregister auto-scaling target on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling deregister-scalable-target ` +
            `--service-namespace dynamodb --resource-id ${resourceId} ` +
            `--scalable-dimension ${dimension}`
        );
      }
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
    localRegion: string
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
            `Could not probe existing auto-scaling targets on ${tableName} in ${region}: ` +
              `${err instanceof Error ? err.message : String(err)} — re-asserting every target instead.`
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
    alreadyApplied: ReadonlySet<string> = new Set()
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
        ? await this.probeRegisteredTargets(tableName, desiredSpecsToUse, localRegion)
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
        spec.indexName
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
        spec.indexName
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
    this.logger.debug(`Deleting DynamoDB GlobalTable ${logicalId}: ${physicalId}`);

    if (context?.removeProtection === true) {
      // Idempotent flip-off — AWS accepts the no-op already-disabled case.
      try {
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            DeletionProtectionEnabled: false,
          })
        );
        this.logger.debug(`Disabled DeletionProtectionEnabled on ${logicalId}, waiting for ACTIVE`);
        try {
          await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
        } catch (waitErr) {
          this.logger.debug(
            `Could not wait for table ${physicalId} ACTIVE after protection flip: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`
          );
        }
      } catch (flipError) {
        if (!(flipError instanceof ResourceNotFoundException)) {
          this.logger.debug(
            `Could not disable DeletionProtectionEnabled on ${physicalId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
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
    let preDeleteIndexes: ReadonlyArray<{ readonly IndexStatus?: string | undefined }> | undefined;
    try {
      const describe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const replicas = describe.Table?.Replicas ?? [];
      // Index names come from AWS, not from the template: `delete()` may be
      // running against state whose properties are stale, and an orphaned
      // scalable target is only findable by the index that actually exists.
      preDeleteIndexes = describe.Table?.GlobalSecondaryIndexes;
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
            this.getRegionalAutoScalingClient(region)
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
              indexName
            );
          }
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              ReplicaUpdates: [{ Delete: { RegionName: region } }],
            })
          );
          await this.waitForReplicaGone(physicalId, region, logicalId);
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
        localAsClient
      );
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:WriteCapacityUnits',
        {},
        undefined,
        localAsClient
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
          indexName
        );
        await this.applyAutoScalingDiff(
          physicalId,
          'dynamodb:index:ReadCapacityUnits',
          {},
          undefined,
          localAsClient,
          indexName
        );
      }
    } catch (describeErr) {
      if (!(describeErr instanceof ResourceNotFoundException)) {
        const cause = describeErr instanceof Error ? describeErr : undefined;
        throw new ProvisioningError(
          `Failed to describe DynamoDB GlobalTable ${logicalId} before delete: ${describeErr instanceof Error ? describeErr.message : String(describeErr)}`,
          resourceType,
          logicalId,
          physicalId,
          cause
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
      if (hasTransitionalIndex(preDeleteIndexes)) {
        this.logger.debug(
          `Waiting for indexes on ${physicalId} to settle before DeleteTable (issue #1521)`
        );
        await this.waitForIndexesActive(physicalId, logicalId);
      }
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
      // DeleteTable is async; wait until DescribeTable returns
      // ResourceNotFoundException so siblings / verify steps observing
      // the table after destroy see it actually gone.
      await this.waitForTableGone(physicalId, logicalId);
      this.logger.debug(`Successfully deleted DynamoDB GlobalTable ${logicalId}`);
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
        this.logger.debug(`DynamoDB GlobalTable ${physicalId} does not exist, skipping`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DynamoDB GlobalTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
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
    const cacheKey = `${physicalId}::${attributeName}`;
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
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
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

      if (table.TableClassSummary?.TableClass) {
        result['TableClass'] = table.TableClassSummary.TableClass;
      }
      if (table.DeletionProtectionEnabled !== undefined) {
        result['DeletionProtectionEnabled'] = table.DeletionProtectionEnabled;
      }

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
      const sdkReplicas =
        table.Replicas && table.Replicas.length > 0
          ? table.Replicas
          : [{ RegionName: currentRegion }];
      const replicas = await Promise.all(
        sdkReplicas.map(async (r) => {
          const entry: Record<string, unknown> = { Region: r.RegionName };
          if (r.KMSMasterKeyId !== undefined) entry['KMSMasterKeyId'] = r.KMSMasterKeyId;
          if (!r.RegionName) return entry;

          const isLocal = r.RegionName === currentRegion;
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
          const subs = await this.readReplicaSubSpecs(client, tableNameForSubs, regionLabel);
          Object.assign(entry, subs);

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
                  `Could not fetch tags for DynamoDB GlobalTable ${tableNameForSubs} in ${regionLabel}: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`
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
      const localReplicaEntry = replicas.find((r) => r['Region'] === currentRegion);
      if (table.GlobalSecondaryIndexes && table.GlobalSecondaryIndexes.length > 0) {
        const cfnIndexes: Array<Record<string, unknown>> = [];
        const replicaIndexEntries: Array<Record<string, unknown>> = [];
        for (const gsi of table.GlobalSecondaryIndexes) {
          if (!gsi.IndexName) continue;
          const entry: Record<string, unknown> = { IndexName: gsi.IndexName };
          if (gsi.KeySchema) entry['KeySchema'] = gsi.KeySchema;
          if (gsi.Projection) entry['Projection'] = gsi.Projection;
          if (gsi.WarmThroughput) entry['WarmThroughput'] = gsi.WarmThroughput;

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
        if (localReplicaEntry && replicaIndexEntries.length > 0) {
          localReplicaEntry['GlobalSecondaryIndexes'] = replicaIndexEntries;
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
      if (localReplicaEntry && table.OnDemandThroughput?.MaxReadRequestUnits !== undefined) {
        localReplicaEntry['ReadOnDemandThroughputSettings'] = {
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
        this.logger.debug(
          `Could not read TimeToLive for ${tableNameForSubs}: ${ttlErr instanceof Error ? ttlErr.message : String(ttlErr)}`
        );
      }

      // Note: `Tags` are emitted INSIDE the local `Replicas[]` entry
      // above (the CFn `GlobalTable` schema has no top-level `Tags`).

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
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
    regionLabel: string
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};

    // ContributorInsights (table-level only in v1).
    try {
      const ci = await client.send(
        new DescribeContributorInsightsCommand({ TableName: tableName })
      );
      if (ci.ContributorInsightsStatus) {
        out['ContributorInsightsSpecification'] = {
          Enabled: ci.ContributorInsightsStatus === 'ENABLED',
        };
      }
    } catch (err) {
      this.logger.debug(
        `Could not read ContributorInsights for ${tableName} in ${regionLabel}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // PointInTimeRecovery via DescribeContinuousBackups.
    try {
      const pitr = await client.send(
        new DescribeContinuousBackupsCommand({ TableName: tableName })
      );
      const pitrStatus =
        pitr.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
          ?.PointInTimeRecoveryStatus;
      if (pitrStatus) {
        out['PointInTimeRecoverySpecification'] = {
          PointInTimeRecoveryEnabled: pitrStatus === 'ENABLED',
        };
      }
    } catch (err) {
      this.logger.debug(
        `Could not read PointInTimeRecovery for ${tableName} in ${regionLabel}: ${err instanceof Error ? err.message : String(err)}`
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
      this.logger.debug(
        `Could not read KinesisStreamingDestination for ${tableName} in ${regionLabel}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return out;
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
      this.logger.debug(
        `Could not read application-autoscaling settings for ${resourceId} (${scalableDimension}): ${err instanceof Error ? err.message : String(err)}`
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
   *    is authored at.
   *
   * Returning an empty list is the canonical "no known-unknown paths"
   * shape — keeping the method present (rather than removing it) for
   * future additions and for backward compat on test reflection.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [];
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
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: explicit }));
        return { physicalId: explicit, attributes: {} };
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
    maxAttempts = 120
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
      this.logger.debug(`Table ${tableName} status: ${status} (attempt ${attempt}/${maxAttempts})`);

      if (status === 'ACTIVE') {
        return {
          tableArn: response.Table?.TableArn,
          tableId: response.Table?.TableId,
          streamArn: response.Table?.LatestStreamArn,
        };
      }
      if (status !== 'CREATING' && status !== 'UPDATING') {
        throw new ProvisioningError(
          `Unexpected table status while waiting for ACTIVE on ${tableName}: ${status}`,
          'AWS::DynamoDB::GlobalTable',
          logicalId,
          tableName
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ProvisioningError(
      `Table ${tableName} did not reach ACTIVE within ${maxAttempts}s`,
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
    maxAttempts = 600
  ): Promise<void> {
    let tableReachedActive = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      if (response.Table?.TableStatus === 'ACTIVE') {
        tableReachedActive = true;
        if (!hasTransitionalIndex(response.Table?.GlobalSecondaryIndexes)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (tableReachedActive) {
      this.logger.warn(
        `Indexes on ${tableName} (${logicalId}) were still transitioning after ` +
          `${maxAttempts}s — a large index backfill can outlive this wait. Proceeding; ` +
          `AWS rejects the next call if it is still too early.`
      );
      return;
    }
    throw new ProvisioningError(
      `Table ${tableName} did not reach ACTIVE within ${maxAttempts}s after UpdateTable`,
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
   * backfill on a large table can take a long time, hence the 15-minute cap.
   * The caller that follows it with a mutating call keeps AWS's own error as
   * the backstop for the case where even that cap is not enough.
   */
  private async waitForIndexesActive(tableName: string, logicalId: string): Promise<void> {
    const maxAttempts = 900;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const indexes = response.Table?.GlobalSecondaryIndexes ?? [];
        // Block on the TRANSITIONAL statuses, not on "!== ACTIVE": an absent
        // or unrecognized `IndexStatus` must not park the deploy for the full
        // cap on a table that is fine. AWS always sets the field, so the two
        // readings only differ for a partial response — where proceeding and
        // letting AWS answer is the better failure mode.
        if (!hasTransitionalIndex(indexes)) return;
      } catch (err) {
        this.logger.debug(
          `DescribeTable while waiting for indexes on ${tableName}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.logger.warn(
      `Indexes on ${tableName} (${logicalId}) did not all reach ACTIVE within ` +
        `${maxAttempts}s; auto-scaling registration for a still-building index may ` +
        `have been skipped. The next deploy re-asserts it.`
    );
  }

  /**
   * Wait until a specific replica's `ReplicaStatus` flips to ACTIVE.
   * Replica provisioning typically takes 1–5 min; cap at 10 min.
   */
  private async waitForReplicaActive(
    tableName: string,
    region: string,
    logicalId: string,
    maxAttempts = 600
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
      if (replica?.ReplicaStatus === 'ACTIVE') return;
      this.logger.debug(
        `Replica ${region} status: ${replica?.ReplicaStatus} (attempt ${attempt}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ProvisioningError(
      `Replica ${region} for table ${tableName} did not reach ACTIVE within ${maxAttempts}s`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait until a specific replica disappears from `Replicas[]` after a
   * Delete replica update. Replica deletion typically takes 1–5 min;
   * cap at 10 min.
   */
  private async waitForReplicaGone(
    tableName: string,
    region: string,
    logicalId: string,
    maxAttempts = 600
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
        if (!replica) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
    }
    throw new ProvisioningError(
      `Replica ${region} for table ${tableName} did not disappear within ${maxAttempts}s`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait for `DescribeTable` to return `ResourceNotFoundException`,
   * confirming the table has actually been removed. `DeleteTable` is
   * async — the call returns immediately with `TableStatus: DELETING`
   * and AWS only removes the table some seconds later. Without this
   * wait, downstream observers (siblings deleted in the same destroy
   * run, integ scripts that re-check via `aws dynamodb describe-table`)
   * see "destroy succeeded" but the table is still listed by AWS.
   * Typical small-table delete completes in 5–30s; cap at 10 min for
   * worst-case large-table / replica-cascade scenarios.
   */
  private async waitForTableGone(
    tableName: string,
    logicalId: string,
    maxAttempts = 600
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
    }
    throw new ProvisioningError(
      `Table ${tableName} did not disappear within ${maxAttempts}s`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }
}

// ─── Pure-functional diff helpers (exported for testing) ───────────────

/**
 * Diff CFn `Replicas[]` arrays. Keyed by `Region`. Returns adds, removes,
 * and modifies (entries whose other keys — KMSMasterKeyId,
 * GlobalSecondaryIndexes, TableClassOverride — differ from the old shape).
 */
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
  const replicas = (props['Replicas'] ?? []) as Array<Record<string, unknown>>;
  const local = replicas.find((r) => r['Region'] === region);
  const perReplica = local?.['DeletionProtectionEnabled'];
  if (typeof perReplica === 'boolean') return perReplica;
  const topLevel = props['DeletionProtectionEnabled'];
  return typeof topLevel === 'boolean' ? topLevel : undefined;
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
  diagnostics?: ThroughputDiagnostic[]
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
  // replica is the one `CreateTable` / `UpdateTable` provisions. (The
  // schema also has a TOP-LEVEL `ReadProvisionedThroughputSettings`, but
  // cdkd's pre-flight property-coverage check rejects that spelling as
  // unsupported, so it can never reach here — do not read it.)
  const rawRead = localReplica?.['ReadProvisionedThroughputSettings'];
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
      { blockName: 'Replicas[local].ReadProvisionedThroughputSettings' }
    );
  }
  if (write === undefined) {
    reportUnresolvedProvisionedCapacity(
      rawWrite,
      'Write',
      source,
      { appliedUnits: DEFAULT_CAPACITY_UNITS },
      diagnostics,
      { blockName: 'WriteProvisionedThroughputSettings' }
    );
  }
  return {
    ReadCapacityUnits: read ?? DEFAULT_CAPACITY_UNITS,
    WriteCapacityUnits: write ?? DEFAULT_CAPACITY_UNITS,
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
 * Every attribute name some KEY SCHEMA in the desired template references:
 * the table's own `KeySchema`, each GSI's, and each LSI's. This is the set
 * the `AttributeDefinitions`-removal guard in `update()` tests membership
 * against — a removed attribute still in this set is a genuine
 * redefine-in-place (replacement required); one outside it is the normal
 * bookkeeping of a GSI deletion and must NOT force a replacement.
 *
 * Malformed / intrinsic-valued entries contribute nothing, which errs on the
 * PERMISSIVE side of the guard — correct here, because the guard's failure
 * mode is a forced replacement of a live table, and AWS itself still rejects
 * a genuinely-bad `UpdateTable` loudly.
 */
export function collectDesiredKeyAttributeNames(properties: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const addKeySchema = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const element of value) {
      const name = asRecord(element)?.['AttributeName'];
      if (typeof name === 'string') names.add(name);
    }
  };
  addKeySchema(properties['KeySchema']);
  for (const indexListKey of ['GlobalSecondaryIndexes', 'LocalSecondaryIndexes'] as const) {
    const indexes = properties[indexListKey];
    if (!Array.isArray(indexes)) continue;
    for (const index of indexes) {
      addKeySchema(asRecord(index)?.['KeySchema']);
    }
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

/**
 * The GSI states during which AWS refuses another `UpdateTable` or a
 * `DeleteTable` on the table (issue #1521) — a table is ACTIVE while one of
 * its indexes is still transitioning, which is what made the serialized
 * update sequence race and what left a table ORPHANED when the follow-up
 * destroy hit the same rule.
 *
 * `DELETING` is included because a dropped index keeps reporting until it is
 * actually gone. The test is on the TRANSITIONAL values rather than on
 * `!== 'ACTIVE'`: an absent or unrecognized status must not park the caller
 * for its whole cap on a table that is fine.
 */
const INDEX_TRANSITIONAL_STATUSES = new Set(['CREATING', 'UPDATING', 'DELETING']);

function hasTransitionalIndex(
  indexes: ReadonlyArray<{ readonly IndexStatus?: string | undefined }> | undefined
): boolean {
  return (indexes ?? []).some((gsi) => INDEX_TRANSITIONAL_STATUSES.has(gsi.IndexStatus ?? ''));
}

/** Coerce a CFn numeric (CFn is stringly-typed) to a finite number. */
function toFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

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
 * first-class cdkd surface (`cdkd import --migrate-from-cloudformation`,
 * `cdkd migrate --from-cfn-stack`), and the pre-fix code forwarded such a
 * block VERBATIM. Three defects followed, and fixing any subset leaves a
 * live one, which is why this helper does all three at once:
 *
 *  1. **Coercion.** The verbatim forward was the ONE path that skipped
 *     {@link toFiniteNumber}, so a stringly-typed CFn `"5"` reached the SDK
 *     unnormalized while every derived value was a number.
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
  context: { indexName?: string; blockName: string }
): T | undefined {
  const out: Record<string, number> = {};
  for (const member of members) {
    if (explicit && explicit[member] !== undefined) {
      const coerced = toFiniteNumber(explicit[member]);
      if (coerced !== undefined) {
        out[member] = coerced;
        continue;
      }
      diagnostics?.push({
        kind: 'unresolved-member',
        ...(context.indexName !== undefined && { indexName: context.indexName }),
        member,
        message:
          `${context.blockName}.${member} is present but did not resolve to a number ` +
          `(${JSON.stringify(explicit[member])?.slice(0, 80)}), so it was ignored. ` +
          `This is usually an unresolved intrinsic; resolve it to a literal.`,
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
  context: { indexName?: string; blockName: string; member: string }
): void {
  if (!diagnostics) return;
  if (rawValue === undefined) return;
  if (toFiniteNumber(rawValue) !== undefined) return;
  diagnostics.push({
    kind: 'unresolved-member',
    ...(context.indexName !== undefined && { indexName: context.indexName }),
    member: context.member,
    message:
      `${context.blockName}.${context.member} is declared but did not resolve to a ` +
      `number (${JSON.stringify(rawValue)?.slice(0, 80)}), so no throughput value was ` +
      `sent for it and the live AWS setting was left unchanged. This is usually an ` +
      `unresolved intrinsic; resolve it to a literal to apply the limit, or remove the ` +
      `property entirely to clear it.`,
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
  context: { indexName?: string; blockName: string }
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
      `(${JSON.stringify(blame.value)?.slice(0, 80)}), ${consequence}. This is usually an ` +
      `unresolved intrinsic; resolve it to a literal to apply the capacity you declared.`,
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
 * forbids it, but hand-authored / imported templates and cdkd state written
 * before this helper existed can carry it, and honoring it is strictly more
 * faithful than ignoring it.
 *
 * `source` selects between the two contexts CloudFormation distinguishes —
 * see {@link CapacitySource}. Defaults to `'min'`, the common case.
 */
export function deriveWriteCapacityUnits(
  settings: Record<string, unknown> | undefined,
  source: CapacitySource = 'min'
): number | undefined {
  if (!settings) return undefined;
  const literal = toFiniteNumber(settings['WriteCapacityUnits']);
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
  const literal = toFiniteNumber(settings['ReadCapacityUnits']);
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
  const min = toFiniteNumber(autoScaling['MinCapacity']);
  if (source === 'min') return min ?? toFiniteNumber(autoScaling['SeedCapacity']);
  return toFiniteNumber(autoScaling['SeedCapacity']) ?? min;
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
  onUnusableIndexes?: (message: string) => void
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
  if (rawIndexes !== undefined && !Array.isArray(rawIndexes)) {
    const shapeDetail =
      `AWS::DynamoDB::GlobalTable GlobalSecondaryIndexes must be an array, got ` +
      `${typeof rawIndexes} (${JSON.stringify(rawIndexes)?.slice(0, 200)}).`;
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
    if (gsi['WarmThroughput'] !== undefined) {
      sdk.WarmThroughput = gsi['WarmThroughput'] as GlobalSecondaryIndex['WarmThroughput'];
    }

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
      const explicitCovers = (member: string): boolean =>
        explicitProvisioned !== undefined &&
        toFiniteNumber(explicitProvisioned[member]) !== undefined;
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
          }
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
          }
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
        { ...(typeof indexName === 'string' && { indexName }), blockName: 'ProvisionedThroughput' }
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
      reportUnresolvedRawMember(rawWrite, diagnostics, {
        ...(typeof indexName === 'string' && { indexName }),
        blockName: 'WriteOnDemandThroughputSettings',
        member: 'MaxWriteRequestUnits',
      });
      // The replica spelling is the canonical CDK one and wins when it
      // coerces, so only report the GSI-level fallback when the replica entry
      // contributed nothing — otherwise a hand-authored leftover would draw a
      // warning about a value that was never going to be used.
      const rawRead = rawReadLocal !== undefined ? rawReadLocal : rawReadGsi;
      reportUnresolvedRawMember(rawRead, diagnostics, {
        ...(typeof indexName === 'string' && { indexName }),
        blockName:
          rawReadLocal !== undefined
            ? 'Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughputSettings'
            : 'ReadOnDemandThroughputSettings',
        member: 'MaxReadRequestUnits',
      });

      const maxWrite = toFiniteNumber(rawWrite);
      const maxRead = toFiniteNumber(rawReadLocal) ?? toFiniteNumber(rawReadGsi);
      const merged = mergeExplicitThroughputBlock<OnDemandThroughput>(
        explicitOnDemand,
        {
          ...(maxRead !== undefined && { MaxReadRequestUnits: maxRead }),
          ...(maxWrite !== undefined && { MaxWriteRequestUnits: maxWrite }),
        },
        ['MaxReadRequestUnits', 'MaxWriteRequestUnits'],
        diagnostics,
        { ...(typeof indexName === 'string' && { indexName }), blockName: 'OnDemandThroughput' }
      );
      if (merged) sdk.OnDemandThroughput = merged;
    }

    result.push(sdk);
  }
  return result;
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
 * {@link toFiniteNumber}, which returns `undefined` for a present-but-
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
 * DELIBERATELY UNMAPPED: `ContributorInsightsSpecification`. The replica-GSI
 * SDK shape has no member for it — per-index contributor insights are toggled
 * by a separate `UpdateContributorInsights(TableName, IndexName)` call, which
 * this provider does not issue for any index (it only reads the TABLE-level
 * status back in `readCurrentState`). Recorded here rather than silently
 * dropped; tracked with the other GlobalTable nested-key gaps.
 */
export function toSdkReplicaGlobalSecondaryIndexes(
  replicaIndexes: unknown,
  billingMode: string,
  diagnostics?: ThroughputDiagnostic[]
): ReplicaGlobalSecondaryIndex[] | undefined {
  if (!Array.isArray(replicaIndexes) || replicaIndexes.length === 0) return undefined;
  return replicaIndexes.map((entry) => {
    const cfn = asRecord(entry);
    if (!cfn) return entry as ReplicaGlobalSecondaryIndex;
    const indexName = cfn['IndexName'] as string | undefined;
    const sdk: ReplicaGlobalSecondaryIndex = { IndexName: indexName };
    const overrides = toSdkReplicaThroughputOverrides(cfn, billingMode, diagnostics, {
      ...(typeof indexName === 'string' && { indexName }),
    });
    if (overrides.ProvisionedThroughputOverride) {
      sdk.ProvisionedThroughputOverride = overrides.ProvisionedThroughputOverride;
    }
    if (overrides.OnDemandThroughputOverride) {
      sdk.OnDemandThroughputOverride = overrides.OnDemandThroughputOverride;
    }
    return sdk;
  });
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
  context: { indexName?: string }
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
      toFiniteNumber(explicitProvisioned?.['ReadCapacityUnits']) === undefined
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
        { ...context, blockName: 'ReadProvisionedThroughputSettings' }
      );
    }
    const merged = mergeExplicitThroughputBlock<{ ReadCapacityUnits: number }>(
      explicitProvisioned,
      readCapacity !== undefined ? { ReadCapacityUnits: readCapacity } : undefined,
      ['ReadCapacityUnits'],
      diagnostics,
      { ...context, blockName: 'ProvisionedThroughputOverride' }
    );
    return merged ? { ProvisionedThroughputOverride: merged } : {};
  }

  const rawMaxRead = asRecord(cfn['ReadOnDemandThroughputSettings'])?.['MaxReadRequestUnits'];
  reportUnresolvedRawMember(rawMaxRead, diagnostics, {
    ...context,
    blockName: 'ReadOnDemandThroughputSettings',
    member: 'MaxReadRequestUnits',
  });
  const maxReadRequestUnits = toFiniteNumber(rawMaxRead);
  const merged = mergeExplicitThroughputBlock<{ MaxReadRequestUnits: number }>(
    explicitOnDemand,
    maxReadRequestUnits !== undefined ? { MaxReadRequestUnits: maxReadRequestUnits } : undefined,
    ['MaxReadRequestUnits'],
    diagnostics,
    { ...context, blockName: 'OnDemandThroughputOverride' }
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
  diagnostics?: ThroughputDiagnostic[]
): { read: RawCeiling; write: RawCeiling } {
  const writeBlock = properties['WriteOnDemandThroughputSettings'];
  const replicas = properties['Replicas'];
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  const readBlock = asRecord(localReplica)?.['ReadOnDemandThroughputSettings'];
  const rawRead = asRecord(readBlock)?.['MaxReadRequestUnits'];
  const rawWrite = asRecord(writeBlock)?.['MaxWriteRequestUnits'];
  reportUnresolvedRawMember(rawRead, diagnostics, {
    blockName: 'Replicas[local].ReadOnDemandThroughputSettings',
    member: 'MaxReadRequestUnits',
  });
  reportUnresolvedRawMember(rawWrite, diagnostics, {
    blockName: 'WriteOnDemandThroughputSettings',
    member: 'MaxWriteRequestUnits',
  });
  return {
    read: {
      declared: rawRead !== undefined || isUnresolvedIntrinsicBlock(readBlock),
      value: toFiniteNumber(rawRead),
    },
    write: {
      declared: rawWrite !== undefined || isUnresolvedIntrinsicBlock(writeBlock),
      value: toFiniteNumber(rawWrite),
    },
  };
}

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
 * Structural equality via JSON.stringify. Both inputs are CFn-shape
 * POJOs (no functions, no symbols, no cycles), so JSON round-trip is
 * sufficient and free of the property-order pitfalls of deeper
 * comparators. Object property order from `Object.keys` is insertion
 * order in modern engines; AWS-SDK shapes are constructed by the SDK
 * in stable order, so this is safe in practice.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
