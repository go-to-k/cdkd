import {
  DynamoDBClient,
  type ApproximateCreationDateTimePrecision,
} from '@aws-sdk/client-dynamodb';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { clientDefaultsFor, type CredentialConfig } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { isAuxiliaryFailure } from '../auxiliary-failure.js';
import type { DeleteContext } from '../region-check.js';
import { TABLE_INDEX_NOUN, relayedIndexBusyDelete } from '../dynamodb-index-busy-delete.js';
import {
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS,
  ProtectionFlipRegistry,
} from './dynamodb-delete-budget.js';
import { ElapsedBudgetRegistry } from '../../utils/elapsed-budget.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
  ReadCurrentStateContext,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { create, rollBackCreatedTable } from './dynamodb-table/create.js';
import {
  deleteResource,
  deleteTableResource,
  waitForNameReleased,
} from './dynamodb-table/delete.js';
import {
  canonicalizeDriftPair,
  canonicalizeDriftProperties,
  getDriftUnknownPaths,
  getDriftUnorderedPaths,
  readUnsettled,
  unsettledInTransition,
} from './dynamodb-table/drift.js';
import {
  applyGsiUpdates,
  applyVectorIndexUpdates,
  runGsiOps,
} from './dynamodb-table/gsi-updates.js';
import {
  getAttribute,
  importResource,
  isSameResource,
  readTableIdIfExists,
  resourceIdentity,
} from './dynamodb-table/identity.js';
import {
  coerceIndexCapacityBlock,
  coerceIndexThroughputForCreate,
  coerceWarmThroughputForSend,
  indexCapacityForSend,
  indexCeilingForSend,
  indexScope,
  warnUndeclaredLiveIndexes,
} from './dynamodb-table/index-throughput.js';
import {
  coerceOnDemandCeilingsForSend,
  skipWarmThroughputDecrease,
  skipZeroCapacityIndexUpdate,
  warmThroughputOpFor,
  warnRefusedWarmThroughput,
  warnUnusableOnDemandCeiling,
  warnUnusableProvisionedCapacity,
} from './dynamodb-table/index-warnings.js';
import {
  applyKinesisStreamingDestination,
  updateKinesisStreamingPrecision,
  waitForKinesisDestinationSettled,
  waitForKinesisDisableSettled,
} from './dynamodb-table/kinesis.js';
import {
  reAskUntilSettled,
  readCurrentState,
  readIndexContributorInsights,
  readKinesisStreamSpecification,
  readPointInTimeRecovery,
  readStreamMembers,
  readTableContributorInsights,
  readTableResourcePolicy,
  readTableTags,
  readTimeToLive,
} from './dynamodb-table/read-current-state.js';
import {
  applyContributorInsights,
  applyIndexContributorInsights,
  applyStreamMembers,
  describeLatestStreamArn,
  resolveMintedStreamArn,
  sendContributorInsightsOp,
  sendStreamMemberOp,
} from './dynamodb-table/streams.js';
import {
  applyPointInTimeRecovery,
  applyResourcePolicy,
  applyTagDiff,
  applyTimeToLive,
  assertNoActiveTtlAttributeNameChange,
  retryOnTransientControlPlane,
} from './dynamodb-table/table-settings.js';
import { update } from './dynamodb-table/update.js';
import {
  waitForTableActive,
  waitForTableActiveAfterUpdate,
  waitForTableAndIndexesActive,
  waitForTableSseSettled,
} from './dynamodb-table/waits.js';
import type { Logger } from '../../types/config.js';

export { projectIndexesOnto } from './dynamodb-table/indexes.js';
export {
  TABLE_ACTIVE_WAIT_ATTEMPTS,
  deleteTableRetryDelays,
  mapSSESpecification,
  sseSpecificationToSend,
  tableDeleteGoneWait,
  tableNameReleaseWait,
} from './dynamodb-table/table-helpers.js';

export class DynamoDBTableProvider implements ResourceProvider {
  dynamoDBClient: DynamoDBClient;
  private createClient: Promise<DynamoDBClient> | undefined;
  /** The credential half of the `AwsClients` `dynamoDBClient` came from (#4639). */
  private readonly credentialConfig: CredentialConfig;
  logger: Logger = getLogger().child('DynamoDBTableProvider');

  /**
   * The failure wrap the create / update / delete catches build.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug`, masked both raw
   * and as the finished line, since AWS can echo a resolved value back. The
   * wrap is stamped `markRedactedCause`, so the retry classifiers read the
   * withheld text on the `cause` chain. An "already exists" and an index-busy
   * refusal are restated ({@link relayedNameCollision},
   * {@link relayedIndexBusyDelete}); the "already exists" not from a
   * post-create step's failure ({@link markAuxiliaryFailure}), where "it" would
   * read as the table (#3826). A cdkd-authored or transport error keeps its
   * text, masked, stamped only when the mask changed it (`wrapMaskedAwsError`,
   * issue #4244); a non-`Error` throw is withheld like an AWS one, unstamped
   * (it has no chain). The delete checks `ResourceNotFoundException` by type
   * before it wraps, and marks a foreign not-found class {@link markNotGone}.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: SecretMasker | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    const m = maskerOrIdentity(mask);
    if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
    this.logger.debug(m(build(m(failure.detail)).message));
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(
      `${m(failure.summary)}${relay}${relayedIndexBusyDelete(failure.detail, TABLE_INDEX_NOUN)}`
    );
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DynamoDB::Table',
      new Set([
        'TableName',
        'KeySchema',
        'AttributeDefinitions',
        'BillingMode',
        'ProvisionedThroughput',
        'OnDemandThroughput',
        'WarmThroughput',
        'StreamSpecification',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'SSESpecification',
        'Tags',
        'DeletionProtectionEnabled',
        'TableClass',
        'PointInTimeRecoverySpecification',
        'TimeToLiveSpecification',
        'ResourcePolicy',
        'KinesisStreamSpecification',
        'ContributorInsightsSpecification',
        'VectorIndexes',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::DynamoDB::Table',
      new Map<string, string>([
        [
          'ImportSourceSpecification',
          'S3 import uses the separate ImportTable API (not CreateTable) and is create-only with no readback; deferred to a dedicated import-from-S3 PR',
        ],
      ]),
    ],
  ]);

  /**
   * The ONE wall-clock allowance each `delete()` spends, keyed by physical id
   * (issue #1955). Keyed rather than per-call because `destroy-runner.ts` can
   * RE-ENTER `delete()` from the top: a THROTTLED `DeleteTable` is not retried
   * by the index-busy loop below — that classifier is message-scoped by design
   * — so it escapes to the outer loop, which DOES class throttles as retryable
   * and pays the whole settle-and-retry sequence a second time inside the same
   * per-resource deadline (2 x ~19.6 min ~= ~39 min after issue #1950 raised
   * this type's retry budget to 14). A per-call budget would hand that second
   * pass a fresh allowance; this one does not. Keyed rather than per-instance
   * because a destroy level deletes its resources CONCURRENTLY through one
   * provider instance.
   */
  readonly deleteBudgets = new ElapsedBudgetRegistry();

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
  readonly protectionFlips = new ProtectionFlipRegistry();

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
  getCreateClient(): Promise<DynamoDBClient> {
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
   * deadline" from an assumption about the CLI default into a guarantee. It
   * equals today's `DEFAULT_RESOURCE_TIMEOUT_MS`, so at default settings this
   * changes nothing.
   *
   * **It is TYPE-level, not operation-level**, and that is a real consequence
   * rather than a detail: `deploy-engine.ts` and `destroy-runner.ts` both fold
   * it in through the same `Math.max(...)`, so a user running
   * `--resource-timeout 5m` for fail-fast CI gets 30 minutes for this type's
   * CREATE and UPDATE too, not only for the DELETE the budget is about. The
   * interface has no per-operation form, and the escape hatch for anyone who
   * wants the shorter deadline back is the per-type override
   * (`--resource-timeout AWS::DynamoDB::Table=5m`), which still wins.
   */
  getMinResourceTimeoutMs(): number {
    return DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  rollBackCreatedTable(
    ...args: Parameters<typeof rollBackCreatedTable>
  ): ReturnType<typeof rollBackCreatedTable> {
    return rollBackCreatedTable.call(this, ...args);
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    // Read for two things. `maskSecrets` (issue #1932 item 3, adopted here by
    // issue #1997): the update path carries the same RESOLVED bag as
    // `create()`, so the masking requirement is identical on both — a masker
    // present on one and absent from the other is not a partial fix, it is a fix
    // with a hole in the shape of whichever path a given deploy takes. And the
    // ORIGIN of the desired bag (`replayingState` / `desiredFromAwsReadback`),
    // which decides whether the pre-flight refusals below refuse (a template
    // deploy) or downgrade (a rollback revert or `cdkd drift --revert`).
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  async waitForNameReleased(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    context: { isInterrupted: () => boolean; maskSecrets?: (text: string) => string }
  ): Promise<void> {
    return waitForNameReleased.call(this, logicalId, physicalId, _resourceType, context);
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteResource.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  deleteTableResource(
    ...args: Parameters<typeof deleteTableResource>
  ): ReturnType<typeof deleteTableResource> {
    return deleteTableResource.call(this, ...args);
  }

  applyTagDiff(...args: Parameters<typeof applyTagDiff>): ReturnType<typeof applyTagDiff> {
    return applyTagDiff.call(this, ...args);
  }

  applyPointInTimeRecovery(
    ...args: Parameters<typeof applyPointInTimeRecovery>
  ): ReturnType<typeof applyPointInTimeRecovery> {
    return applyPointInTimeRecovery.call(this, ...args);
  }

  retryOnTransientControlPlane<T>(
    ...args: Parameters<typeof retryOnTransientControlPlane<T>>
  ): ReturnType<typeof retryOnTransientControlPlane<T>> {
    return (retryOnTransientControlPlane<T>).call(this, ...args);
  }

  assertNoActiveTtlAttributeNameChange(
    ...args: Parameters<typeof assertNoActiveTtlAttributeNameChange>
  ): ReturnType<typeof assertNoActiveTtlAttributeNameChange> {
    return assertNoActiveTtlAttributeNameChange.call(this, ...args);
  }

  applyTimeToLive(...args: Parameters<typeof applyTimeToLive>): ReturnType<typeof applyTimeToLive> {
    return applyTimeToLive.call(this, ...args);
  }

  /**
   * Extract the resource-policy document from the CFn `ResourcePolicy`
   * property and serialize it to the JSON string the DynamoDB APIs expect.
   *
   * CFn shape is `{ PolicyDocument: <JSON object | string> }`. Both
   * `CreateTable.ResourcePolicy` and `PutResourcePolicy.Policy` take a JSON
   * STRING, so a document already supplied as a string is passed through
   * verbatim (CDK can emit either an object or, post-intrinsic-resolution, a
   * string). Returns `undefined` when there is no policy document to apply.
   */
  extractResourcePolicyDocument(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const s = spec as Record<string, unknown>;
    const doc = s['PolicyDocument'];
    if (doc === undefined || doc === null) return undefined;
    return typeof doc === 'string' ? doc : JSON.stringify(doc);
  }

  applyResourcePolicy(
    ...args: Parameters<typeof applyResourcePolicy>
  ): ReturnType<typeof applyResourcePolicy> {
    return applyResourcePolicy.call(this, ...args);
  }

  applyKinesisStreamingDestination(
    ...args: Parameters<typeof applyKinesisStreamingDestination>
  ): ReturnType<typeof applyKinesisStreamingDestination> {
    return applyKinesisStreamingDestination.call(this, ...args);
  }

  waitForKinesisDisableSettled(
    ...args: Parameters<typeof waitForKinesisDisableSettled>
  ): ReturnType<typeof waitForKinesisDisableSettled> {
    return waitForKinesisDisableSettled.call(this, ...args);
  }

  extractKinesisStreamArn(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const arn = (spec as Record<string, unknown>)['StreamArn'];
    return typeof arn === 'string' ? arn : undefined;
  }

  extractKinesisPrecision(spec: unknown): ApproximateCreationDateTimePrecision | undefined {
    if (spec === undefined || spec === null) return undefined;
    const precision = (spec as Record<string, unknown>)['ApproximateCreationDateTimePrecision'];
    return typeof precision === 'string'
      ? (precision as ApproximateCreationDateTimePrecision)
      : undefined;
  }

  updateKinesisStreamingPrecision(
    ...args: Parameters<typeof updateKinesisStreamingPrecision>
  ): ReturnType<typeof updateKinesisStreamingPrecision> {
    return updateKinesisStreamingPrecision.call(this, ...args);
  }

  waitForKinesisDestinationSettled(
    ...args: Parameters<typeof waitForKinesisDestinationSettled>
  ): ReturnType<typeof waitForKinesisDestinationSettled> {
    return waitForKinesisDestinationSettled.call(this, ...args);
  }

  /**
   * Extract the `StreamViewType` from a CFn `StreamSpecification` block. Returns
   * undefined when the spec is absent (no stream) — which is how update() tells
   * an enable / disable apart from a view-type change. CDK always emits a
   * StreamViewType when a stream is enabled (there is no valid enabled stream
   * without one), so a present spec implies a present view type; defensively
   * returns undefined for a malformed spec with no StreamViewType.
   */
  extractStreamViewType(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const viewType = (spec as Record<string, unknown>)['StreamViewType'];
    return typeof viewType === 'string' && viewType.length > 0 ? viewType : undefined;
  }

  applyStreamMembers(
    ...args: Parameters<typeof applyStreamMembers>
  ): ReturnType<typeof applyStreamMembers> {
    return applyStreamMembers.call(this, ...args);
  }

  sendStreamMemberOp(
    ...args: Parameters<typeof sendStreamMemberOp>
  ): ReturnType<typeof sendStreamMemberOp> {
    return sendStreamMemberOp.call(this, ...args);
  }

  resolveMintedStreamArn(
    ...args: Parameters<typeof resolveMintedStreamArn>
  ): ReturnType<typeof resolveMintedStreamArn> {
    return resolveMintedStreamArn.call(this, ...args);
  }

  describeLatestStreamArn(
    ...args: Parameters<typeof describeLatestStreamArn>
  ): ReturnType<typeof describeLatestStreamArn> {
    return describeLatestStreamArn.call(this, ...args);
  }

  applyContributorInsights(
    ...args: Parameters<typeof applyContributorInsights>
  ): ReturnType<typeof applyContributorInsights> {
    return applyContributorInsights.call(this, ...args);
  }

  applyIndexContributorInsights(
    ...args: Parameters<typeof applyIndexContributorInsights>
  ): ReturnType<typeof applyIndexContributorInsights> {
    return applyIndexContributorInsights.call(this, ...args);
  }

  sendContributorInsightsOp(
    ...args: Parameters<typeof sendContributorInsightsOp>
  ): ReturnType<typeof sendContributorInsightsOp> {
    return sendContributorInsightsOp.call(this, ...args);
  }

  waitForTableActive(
    ...args: Parameters<typeof waitForTableActive>
  ): ReturnType<typeof waitForTableActive> {
    return waitForTableActive.call(this, ...args);
  }

  waitForTableActiveAfterUpdate(
    ...args: Parameters<typeof waitForTableActiveAfterUpdate>
  ): ReturnType<typeof waitForTableActiveAfterUpdate> {
    return waitForTableActiveAfterUpdate.call(this, ...args);
  }

  waitForTableSseSettled(
    ...args: Parameters<typeof waitForTableSseSettled>
  ): ReturnType<typeof waitForTableSseSettled> {
    return waitForTableSseSettled.call(this, ...args);
  }

  waitForTableAndIndexesActive(
    ...args: Parameters<typeof waitForTableAndIndexesActive>
  ): ReturnType<typeof waitForTableAndIndexesActive> {
    return waitForTableAndIndexesActive.call(this, ...args);
  }

  applyVectorIndexUpdates(
    ...args: Parameters<typeof applyVectorIndexUpdates>
  ): ReturnType<typeof applyVectorIndexUpdates> {
    return applyVectorIndexUpdates.call(this, ...args);
  }

  applyGsiUpdates(...args: Parameters<typeof applyGsiUpdates>): ReturnType<typeof applyGsiUpdates> {
    return applyGsiUpdates.call(this, ...args);
  }

  coerceWarmThroughputForSend(
    ...args: Parameters<typeof coerceWarmThroughputForSend>
  ): ReturnType<typeof coerceWarmThroughputForSend> {
    return coerceWarmThroughputForSend.call(this, ...args);
  }

  indexScope(...args: Parameters<typeof indexScope>): ReturnType<typeof indexScope> {
    return indexScope.call(this, ...args);
  }

  warnUndeclaredLiveIndexes(
    ...args: Parameters<typeof warnUndeclaredLiveIndexes>
  ): ReturnType<typeof warnUndeclaredLiveIndexes> {
    return warnUndeclaredLiveIndexes.call(this, ...args);
  }

  /** {@link indexScopeAt}'s vector-index twin (go-to-k/cdkd#2762): the name masked on its own. */
  vectorIndexScopeAt(indexName: unknown, physicalId: string, maskSecrets: SecretMasker): string {
    const name = typeof indexName === 'string' ? maskSecrets(indexName) : '<unnamed>';
    return `vector index ${name} on DynamoDB table ${maskSecrets(physicalId)}`;
  }

  indexScopeAt(indexName: unknown, physicalId: string, maskSecrets: SecretMasker): string {
    const name = typeof indexName === 'string' ? maskSecrets(indexName) : '<unnamed>';
    return `GSI ${name} on DynamoDB table ${physicalId}`;
  }

  indexCapacityForSend(
    ...args: Parameters<typeof indexCapacityForSend>
  ): ReturnType<typeof indexCapacityForSend> {
    return indexCapacityForSend.call(this, ...args);
  }

  indexCeilingForSend(
    ...args: Parameters<typeof indexCeilingForSend>
  ): ReturnType<typeof indexCeilingForSend> {
    return indexCeilingForSend.call(this, ...args);
  }

  coerceIndexThroughputForCreate(
    ...args: Parameters<typeof coerceIndexThroughputForCreate>
  ): ReturnType<typeof coerceIndexThroughputForCreate> {
    return coerceIndexThroughputForCreate.call(this, ...args);
  }

  coerceIndexCapacityBlock(
    ...args: Parameters<typeof coerceIndexCapacityBlock>
  ): ReturnType<typeof coerceIndexCapacityBlock> {
    return coerceIndexCapacityBlock.call(this, ...args);
  }

  coerceOnDemandCeilingsForSend(
    ...args: Parameters<typeof coerceOnDemandCeilingsForSend>
  ): ReturnType<typeof coerceOnDemandCeilingsForSend> {
    return coerceOnDemandCeilingsForSend.call(this, ...args);
  }

  warnUnusableOnDemandCeiling(
    ...args: Parameters<typeof warnUnusableOnDemandCeiling>
  ): ReturnType<typeof warnUnusableOnDemandCeiling> {
    return warnUnusableOnDemandCeiling.call(this, ...args);
  }

  warnUnusableProvisionedCapacity(
    ...args: Parameters<typeof warnUnusableProvisionedCapacity>
  ): ReturnType<typeof warnUnusableProvisionedCapacity> {
    return warnUnusableProvisionedCapacity.call(this, ...args);
  }

  warnRefusedWarmThroughput(
    ...args: Parameters<typeof warnRefusedWarmThroughput>
  ): ReturnType<typeof warnRefusedWarmThroughput> {
    return warnRefusedWarmThroughput.call(this, ...args);
  }

  skipZeroCapacityIndexUpdate(
    ...args: Parameters<typeof skipZeroCapacityIndexUpdate>
  ): ReturnType<typeof skipZeroCapacityIndexUpdate> {
    return skipZeroCapacityIndexUpdate.call(this, ...args);
  }

  warmThroughputOpFor(
    ...args: Parameters<typeof warmThroughputOpFor>
  ): ReturnType<typeof warmThroughputOpFor> {
    return warmThroughputOpFor.call(this, ...args);
  }

  runGsiOps(...args: Parameters<typeof runGsiOps>): ReturnType<typeof runGsiOps> {
    return runGsiOps.call(this, ...args);
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, resourceType, context);
  }

  readTableIdIfExists(
    ...args: Parameters<typeof readTableIdIfExists>
  ): ReturnType<typeof readTableIdIfExists> {
    return readTableIdIfExists.call(this, ...args);
  }

  skipWarmThroughputDecrease(
    ...args: Parameters<typeof skipWarmThroughputDecrease>
  ): ReturnType<typeof skipWarmThroughputDecrease> {
    return skipWarmThroughputDecrease.call(this, ...args);
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }

  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    return getDriftUnknownPaths.call(this, resourceType, properties);
  }

  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDriftProperties.call(this, resourceType, properties);
  }

  async canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    properties?: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    return canonicalizeDriftPair.call(this, resourceType, baseline, aws, properties);
  }

  async readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUnsettled.call(
      this,
      physicalId,
      logicalId,
      resourceType,
      names,
      recordedProperties,
      desiredProperties,
      attemptedItems
    );
  }

  async unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    return unsettledInTransition.call(this, physicalId, _logicalId, _resourceType, names);
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType, properties, context);
  }

  readTableTags(...args: Parameters<typeof readTableTags>): ReturnType<typeof readTableTags> {
    return readTableTags.call(this, ...args);
  }

  readPointInTimeRecovery(
    ...args: Parameters<typeof readPointInTimeRecovery>
  ): ReturnType<typeof readPointInTimeRecovery> {
    return readPointInTimeRecovery.call(this, ...args);
  }

  readTimeToLive(...args: Parameters<typeof readTimeToLive>): ReturnType<typeof readTimeToLive> {
    return readTimeToLive.call(this, ...args);
  }

  readTableResourcePolicy(
    ...args: Parameters<typeof readTableResourcePolicy>
  ): ReturnType<typeof readTableResourcePolicy> {
    return readTableResourcePolicy.call(this, ...args);
  }

  readKinesisStreamSpecification(
    ...args: Parameters<typeof readKinesisStreamSpecification>
  ): ReturnType<typeof readKinesisStreamSpecification> {
    return readKinesisStreamSpecification.call(this, ...args);
  }

  readTableContributorInsights(
    ...args: Parameters<typeof readTableContributorInsights>
  ): ReturnType<typeof readTableContributorInsights> {
    return readTableContributorInsights.call(this, ...args);
  }

  readIndexContributorInsights(
    ...args: Parameters<typeof readIndexContributorInsights>
  ): ReturnType<typeof readIndexContributorInsights> {
    return readIndexContributorInsights.call(this, ...args);
  }

  /**
   * How long an eventually-consistent stream-member read that does NOT match
   * the declaration is re-asked before it is believed: one entry per extra
   * attempt.
   */
  protected streamMemberRereadDelaysMs: readonly number[] = [500, 1000, 2000];

  reAskUntilSettled<T>(
    ...args: Parameters<typeof reAskUntilSettled<T>>
  ): ReturnType<typeof reAskUntilSettled<T>> {
    return (reAskUntilSettled<T>).call(this, ...args);
  }

  readStreamMembers(
    ...args: Parameters<typeof readStreamMembers>
  ): ReturnType<typeof readStreamMembers> {
    return readStreamMembers.call(this, ...args);
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importResource.call(this, input);
  }
}
