import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContributorInsightsCommand,
  UpdateTableCommand,
  type UpdateTableCommandInput,
  UpdateContinuousBackupsCommand,
  type PointInTimeRecoverySpecification,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
  type ContributorInsightsAction,
  type ContributorInsightsMode,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexUpdate,
  type LocalSecondaryIndex,
  type StreamSpecification,
  type OnDemandThroughput,
  type WarmThroughput,
  type Tag,
} from '@aws-sdk/client-dynamodb';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
} from '../../types/resource.js';

/**
 * AWS DynamoDB Table Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::Table using the DynamoDB SDK.
 * WHY: The CC API polls for DynamoDB table creation with exponential backoff
 * (1s->2s->4s->8s->10s), but we can poll DescribeTable directly with shorter
 * intervals, eliminating the CC API intermediary overhead and reducing total
 * wait time.
 */
/**
 * Map CloudFormation's `SSESpecification` shape to the DynamoDB SDK's.
 *
 * The CFn property names the enable flag `SSEEnabled`, but the SDK
 * `CreateTableCommandInput.SSESpecification` field is `Enabled`. Passing the
 * CFn shape verbatim makes the SDK silently ignore the unknown `SSEEnabled`
 * key, so the table is created with AWS-owned (default) encryption instead of
 * the requested AWS-managed / customer-managed KMS encryption — a silent
 * security downgrade with no error. `SSEType` and `KMSMasterKeyId` keep the
 * same names across CFn and the SDK.
 *
 * Returns `undefined` for an absent / non-object value so the caller omits the
 * field entirely. Exported for unit testing.
 */
export function mapSSESpecification(
  raw: unknown
): CreateTableCommandInput['SSESpecification'] | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const cfn = raw as { SSEEnabled?: unknown; SSEType?: unknown; KMSMasterKeyId?: unknown };
  const out: NonNullable<CreateTableCommandInput['SSESpecification']> = {};
  if (cfn.SSEEnabled !== undefined) {
    // CDK synthesizes a real boolean, but tolerate the stringified form.
    out.Enabled = cfn.SSEEnabled === true || cfn.SSEEnabled === 'true';
  }
  if (typeof cfn.SSEType === 'string') {
    out.SSEType = cfn.SSEType as NonNullable<
      CreateTableCommandInput['SSESpecification']
    >['SSEType'];
  }
  if (typeof cfn.KMSMasterKeyId === 'string') {
    out.KMSMasterKeyId = cfn.KMSMasterKeyId;
  }
  return out;
}

/**
 * Read one capacity member out of a per-index `ProvisionedThroughput` block,
 * returning `undefined` for anything that is not a usable number.
 *
 * Deliberately has NO default (issue #1588 review). The BillingMode-flip caller
 * suppresses the per-index update path for every index it handles, so a
 * defaulted capacity would never be corrected by a later call and would land in
 * cdkd state as if the template had declared it. Returning `undefined` routes
 * the index to the same warn-and-omit path an absent block takes, letting AWS
 * name it — the CFn-handler outcome.
 *
 * CFn is stringly typed, so a numeric string is accepted and coerced; `NaN` /
 * `Infinity` / objects / unresolved intrinsics are not.
 */
function readCapacityNumber(block: unknown, member: string): number | undefined {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return undefined;
  const raw = (block as Record<string, unknown>)[member];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Whether a desired `GlobalSecondaryIndexes[]` entry declares BOTH capacity
 * members usably — the same test the BillingMode flip's per-index block applies
 * before it forwards the index, expressed as a predicate for the pre-flip
 * removal's look-ahead (issue #1617).
 *
 * BOTH members are required, exactly as in the flip block: an entry declaring
 * only one is treated like an absent one there, so accepting it here would let
 * the pre-flip delete run ahead of a flip AWS still rejects.
 */
function hasUsableDeclaredCapacity(entry: Record<string, unknown> | undefined): boolean {
  const declared = entry?.['ProvisionedThroughput'];
  return (
    readCapacityNumber(declared, 'ReadCapacityUnits') !== undefined &&
    readCapacityNumber(declared, 'WriteCapacityUnits') !== undefined
  );
}

/**
 * Whether the desired TABLE-level `ProvisionedThroughput` is one the flip can
 * actually send (issue #1617 PR review).
 *
 * Deliberately NOT {@link hasUsableDeclaredCapacity}: the flip defaults each
 * member to 5 when absent (`Number(pt['ReadCapacityUnits'] ?? 5)`), so a
 * half-declared TABLE capacity is sendable while a half-declared per-INDEX one
 * is not.
 *
 * It mirrors the flip's GATE as well as its arithmetic, which the first version
 * did not and a second review round caught — both halves of that miss are real:
 *
 * - the gate is plain TRUTHINESS (`properties['ProvisionedThroughput']`), so a
 *   non-object truthy value sends `{5, 5}` and SUCCEEDS. Requiring a plain
 *   object refused it and skipped a removal that would have been fine.
 * - a DECLARED member that coerces to `0` (`''`, `false`, `[]`) is finite, so
 *   an arithmetic-only check accepted it — while AWS rejects a capacity below
 *   1, which is precisely the deterministic rejection this predicate exists to
 *   keep a delete from running ahead of.
 */
function hasUsableTableCapacity(value: unknown): boolean {
  // Falsy: the flip sends no throughput at all and AWS rejects the mode change.
  if (!value) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return true;
  const pt = value as Record<string, unknown>;
  // Each member the template DECLARES has to be a capacity AWS accepts; an
  // absent one takes the flip's own `?? 5` default and is fine.
  for (const member of ['ReadCapacityUnits', 'WriteCapacityUnits']) {
    if (pt[member] === undefined) continue;
    const n = Number(pt[member]);
    if (!Number.isFinite(n) || n < 1) return false;
  }
  return true;
}

/**
 * `DescribeTable` poll budget (seconds, 1 poll/s) after an ordinary
 * `UpdateTable` — capacity, TTL, tags, table class. Calibrated on those and
 * sufficient for them.
 */
const TABLE_ACTIVE_WAIT_ATTEMPTS = 60;

/**
 * The same budget for a BillingMode FLIP, which DynamoDB settles on a
 * different order of magnitude (measured 2026-08-11: a PAY_PER_REQUEST ->
 * PROVISIONED flip exceeded 60s and failed the deploy). Kept SEPARATE so a
 * genuinely wedged capacity edit still fails in a minute rather than ten.
 */
const BILLING_FLIP_ACTIVE_WAIT_ATTEMPTS = 600;

export class DynamoDBTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private logger = getLogger().child('DynamoDBTableProvider');
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

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
  }

  /**
   * Create a DynamoDB table
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DynamoDB table ${logicalId}`);

    const tableName =
      (properties['TableName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });
    const keySchema = properties['KeySchema'] as KeySchemaElement[] | undefined;
    const attributeDefinitions = properties['AttributeDefinitions'] as
      | AttributeDefinition[]
      | undefined;

    if (!keySchema) {
      throw new ProvisioningError(
        `KeySchema is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!attributeDefinitions) {
      throw new ProvisioningError(
        `AttributeDefinitions is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Tracks whether CreateTable succeeded this call, so the catch can roll
    // back a table whose post-ACTIVE config step (PITR / TTL) failed —
    // otherwise create() throws before returning the physicalId, the deploy
    // engine never learns the table exists, and it orphans.
    let tableCreated = false;

    try {
      // BillingMode (default: PROVISIONED). Guarded per issue #1545 — the
      // `|| 'PROVISIONED'` spelling silently substituted the default for a
      // present-but-unusable value (a `BillingMode: null`, an intrinsic the
      // resolver could not resolve, a hand-authored L1 typo), so a template
      // that says PAY_PER_REQUEST could create a continuously-billed
      // PROVISIONED table with no error anywhere. `BillingMode` is
      // ENUM-valued, so it does NOT take `coerceNumber`: a number here is a
      // template bug, not the unquoted-YAML scalar CFn coerces. The refusal
      // downgrades to a warning on a state replay (`replayWarn`) — the
      // rollback executor's reverse-replacement arm revives the OLD resource
      // from `previousState.properties`, which the user cannot edit from the
      // template. The read sits inside `create()`'s try, so the catch below
      // wraps the refusal into a ProvisioningError.
      const billingMode = requireConfigString(
        properties['BillingMode'],
        'PROVISIONED',
        'AWS::DynamoDB::Table BillingMode',
        replayWarn(this.logger, context)
      );

      const createParams: CreateTableCommandInput = {
        TableName: tableName,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
      };

      // Provisioned throughput (required when BillingMode is PROVISIONED)
      if (billingMode === 'PROVISIONED') {
        const pt = properties['ProvisionedThroughput'] as Record<string, unknown> | undefined;
        createParams.ProvisionedThroughput = {
          ReadCapacityUnits: Number(pt?.['ReadCapacityUnits'] ?? 5),
          WriteCapacityUnits: Number(pt?.['WriteCapacityUnits'] ?? 5),
        };
      }

      // On-demand throughput caps (PAY_PER_REQUEST tables). Rides directly
      // on CreateTable — unlike PITR / TTL it is NOT a post-ACTIVE control-
      // plane call. Pass it through verbatim when present; AWS validates the
      // PAY_PER_REQUEST-only constraint.
      if (properties['OnDemandThroughput']) {
        createParams.OnDemandThroughput = properties['OnDemandThroughput'] as OnDemandThroughput;
      }

      // Warm throughput — pre-warmed read/write capacity. Like
      // OnDemandThroughput it rides directly on CreateTable (the
      // WarmThroughput input field), NOT a post-ACTIVE control-plane call.
      // Works with BOTH PROVISIONED and PAY_PER_REQUEST billing modes. Pass
      // it through verbatim when present.
      if (properties['WarmThroughput']) {
        createParams.WarmThroughput = properties['WarmThroughput'] as WarmThroughput;
      }

      // Stream specification - CDK omits StreamEnabled, SDK requires it
      if (properties['StreamSpecification']) {
        const streamSpec = properties['StreamSpecification'] as Record<string, unknown>;
        createParams.StreamSpecification = {
          StreamEnabled: true,
          StreamViewType: streamSpec['StreamViewType'] as string,
        } as StreamSpecification;
      }

      // Global secondary indexes
      if (properties['GlobalSecondaryIndexes']) {
        createParams.GlobalSecondaryIndexes = properties[
          'GlobalSecondaryIndexes'
        ] as GlobalSecondaryIndex[];
      }

      // Local secondary indexes
      if (properties['LocalSecondaryIndexes']) {
        createParams.LocalSecondaryIndexes = properties[
          'LocalSecondaryIndexes'
        ] as LocalSecondaryIndex[];
      }

      // SSE specification. The CFn property uses `SSEEnabled`, but the SDK
      // CreateTable field is `Enabled` — passing the CFn shape verbatim makes
      // the SDK silently ignore the flag, so the table is created with
      // AWS-owned (default) encryption instead of the requested AWS-managed /
      // customer-managed KMS encryption. Map the field name explicitly.
      const sse = mapSSESpecification(properties['SSESpecification']);
      if (sse && Object.keys(sse).length > 0) {
        createParams.SSESpecification = sse;
      }

      // Tags
      if (properties['Tags']) {
        createParams.Tags = properties['Tags'] as Tag[];
      }

      // DeletionProtectionEnabled
      if (properties['DeletionProtectionEnabled'] !== undefined) {
        createParams.DeletionProtectionEnabled = properties['DeletionProtectionEnabled'] as boolean;
      }

      // Table class
      if (properties['TableClass']) {
        createParams.TableClass = properties['TableClass'] as
          | 'STANDARD'
          | 'STANDARD_INFREQUENT_ACCESS';
      }

      // ResourcePolicy — rides directly on CreateTable. The CFn shape is
      // `{ PolicyDocument: <JSON object> }`, but the SDK CreateTable input
      // takes a JSON STRING in its `ResourcePolicy` field, so serialize the
      // document. (update() uses the separate PutResourcePolicy /
      // DeleteResourcePolicy APIs — those are post-create only.)
      const createResourcePolicyDoc = this.extractResourcePolicyDocument(
        properties['ResourcePolicy']
      );
      if (createResourcePolicyDoc !== undefined) {
        createParams.ResourcePolicy = createResourcePolicyDoc;
      }

      await this.dynamoDBClient.send(new CreateTableCommand(createParams));
      tableCreated = true;

      this.logger.debug(`CreateTable initiated for ${tableName}, waiting for ACTIVE status`);

      // Poll until table is ACTIVE
      const tableInfo = await this.waitForTableActive(tableName);

      // PointInTimeRecoverySpecification and TimeToLiveSpecification do NOT
      // ride on CreateTable — both are separate post-ACTIVE API calls
      // (UpdateContinuousBackups / UpdateTimeToLive). AWS rejects them
      // against a still-CREATING table, which is why they run after the
      // wait above.
      await this.applyPointInTimeRecovery(
        tableName,
        properties['PointInTimeRecoverySpecification']
      );
      await this.applyTimeToLive(tableName, properties['TimeToLiveSpecification']);

      // KinesisStreamSpecification and ContributorInsightsSpecification are
      // also post-ACTIVE control-plane calls (separate
      // EnableKinesisStreamingDestination / UpdateContributorInsights APIs,
      // NOT fields on CreateTable), so they run after the ACTIVE wait too.
      await this.applyKinesisStreamingDestination(
        tableName,
        properties['KinesisStreamSpecification']
      );
      await this.applyContributorInsights(
        tableName,
        properties['ContributorInsightsSpecification']
      );

      this.logger.debug(`Successfully created DynamoDB table ${logicalId}: ${tableName}`);

      return {
        physicalId: tableName,
        attributes: {
          Arn: tableInfo.tableArn,
          TableId: tableInfo.tableId,
          StreamArn: tableInfo.streamArn,
          TableName: tableName,
        },
      };
    } catch (error) {
      // Atomicity: if CreateTable succeeded but a post-ACTIVE step (PITR / TTL)
      // failed, the table exists but create() is about to throw without
      // returning its physicalId — the deploy engine can't roll it back, so
      // best-effort delete it here to avoid an orphan + a "Table already
      // exists" failure on the next deploy attempt.
      if (tableCreated) {
        try {
          await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
          this.logger.debug(`Rolled back partially-created DynamoDB table ${tableName}`);
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to roll back partially-created DynamoDB table ${tableName}: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`
          );
        }
      }
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }
  }

  /**
   * Update a DynamoDB table
   *
   * DynamoDB tables have limited in-place update capabilities.
   * For immutable property changes (KeySchema, etc.), the deployment layer
   * handles replacement via DELETE + CREATE.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DynamoDB table ${logicalId}: ${physicalId}`);

    try {
      // Get current table description for attributes (also gives us the
      // table ARN we need for tag mutations).
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );

      const table = response.Table;

      // The StreamArn attribute returned to the deploy engine. Seeded from the
      // DescribeTable snapshot above, but the StreamSpecification branch below
      // overwrites it after an update-time enable / disable / view-type change
      // so `Fn::GetAtt [Table, StreamArn]` resolves to the freshly-materialized
      // (or cleared) stream ARN rather than the pre-update value.
      let latestStreamArn = table?.LatestStreamArn;

      // Apply tag diff if changed. DynamoDB's TagResource takes
      // [{ Key, Value }] arrays; UntagResource takes a TagKeys list.
      if (table?.TableArn) {
        await this.applyTagDiff(
          table.TableArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      // BillingMode / ProvisionedThroughput — both ride on UpdateTable and are
      // mutable (CFn createOnly = only TableName + ImportSourceSpecification).
      // Fire a SINGLE UpdateTable when either changed so:
      //  - a pure ProvisionedThroughput capacity bump (RCU/WCU change, mode
      //    stays PROVISIONED) actually reaches AWS instead of being silently
      //    dropped (state would otherwise record the new value as applied and
      //    the next deploy would see no diff — the throw-not-swallow / no-
      //    silent-drop rule);
      //  - a pure BillingMode switch (PROVISIONED <-> PAY_PER_REQUEST) reaches
      //    AWS;
      //  - a combined switch-to-PROVISIONED-with-caps sends both in ONE call,
      //    BEFORE the OnDemandThroughput branch below, so AWS sees a consistent
      //    request rather than a throughput change against a still-PAY_PER_-
      //    REQUEST table (or vice versa).
      // Constraints AWS enforces and we mirror here: PAY_PER_REQUEST must NOT
      // carry ProvisionedThroughput; PROVISIONED requires it. Numeric capacity
      // values arrive as strings from the template, so coerce via Number()
      // (matches create()).
      //
      // Per-index ProvisionedThroughput rides this same UpdateTable on a flip
      // TO PROVISIONED, because AWS requires it there (issue #1588 — see the
      // measured A/B at the GlobalSecondaryIndexUpdates block below). A GSI-only
      // capacity change on an already-PROVISIONED table is still handled by the
      // dedicated per-index update path further down, not here.
      // TableClass rides the same UpdateTable and is mutable (CFn "Update
      // requires: No interruption"). It previously had NO update branch at
      // all, so a STANDARD <-> STANDARD_INFREQUENT_ACCESS switch was silently
      // dropped: the deploy reported success while AWS kept the old class,
      // and the next diff saw no change (state recorded the new class), so it
      // could never self-heal. Only send TableClass when it actually changed
      // — AWS rejects an UpdateTable that re-asserts the current class.
      // Normalize BOTH comparison sides first: an absent property means the
      // DynamoDB default (STANDARD), so an explicit-STANDARD <-> absent
      // template edit is NOT a real change and must not issue the doomed
      // same-class UpdateTable.
      const normalizeTableClass = (v: unknown): 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS' =>
        typeof v === 'string' && v.length > 0
          ? (v as 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS')
          : 'STANDARD';
      const tableClassChanged =
        normalizeTableClass(properties['TableClass']) !==
        normalizeTableClass(previousProperties['TableClass']);
      // Shape-guard the DESIRED BillingMode before the change detection
      // (issue #1545). WARN, never throw: `rollback-executor.ts` replays a
      // rollback via `provider.update(..., previousState.properties, ...)`,
      // so the desired bag here can itself be a historical state record — a
      // hard refusal would make the table un-rollbackable with no
      // template-side remedy. An UNUSABLE desired value falls back to the
      // PREVIOUS billing mode, NOT the create-path default: defaulting would
      // make the change detection see a real flip and silently re-price a
      // live table, which is strictly worse than the pre-guard behavior (AWS
      // rejecting the junk value loudly, billing unchanged). An ABSENT value
      // keeps meaning "no flip requested" (no BillingMode sent). The PREVIOUS
      // side stays unguarded on purpose: it comes from cdkd STATE, so
      // refusing a malformed value an older binary recorded would make the
      // stack permanently un-updatable.
      //
      // A state-recorded previous that is itself UNUSABLE is replaced by the
      // table's ACTUAL billing mode (issue #1552). The warn path above keeps
      // the deploy SUCCEEDING, so the engine records the junk desired value
      // as the new state and the NEXT update sees it as the previous side.
      // Comparing a corrected template against that junk previous
      // (`null !== 'PAY_PER_REQUEST'`) reads as a real flip and sends a
      // same-mode `UpdateTable`, which DynamoDB rejects when no capacity
      // change rides along — the deploy fails, state stays unchanged, and the
      // rejection repeats on every deploy. The `DescribeTable` at the top of
      // this method already holds the live mode, so this costs no extra call.
      // An ABSENT previous is NOT unusable: it legitimately means "no billing
      // mode recorded", and seeding it from AWS would turn a no-op update
      // into a spurious change. `BillingModeSummary` is itself absent on a
      // table created without an explicit mode, which is PROVISIONED — the
      // same default `readCurrentState` assumes.
      //
      // An ABSENT value on EITHER side normalizes to the CFn type default
      // PROVISIONED (issue #1553), which is also what `create()` above
      // substitutes — so the two paths now agree on what "no BillingMode in
      // the template" means. Before this the update path left it `undefined`,
      // and a template that REMOVED the property produced a change ("undefined
      // !== PAY_PER_REQUEST") that carried no mutable field: the
      // `updateInput.BillingMode = ...` assignment was gated on the value
      // being truthy, so `UpdateTable({TableName})` went out with nothing to
      // update and DynamoDB rejected it.
      //
      // The reset semantic is MEASURED, not inferred from the type default
      // (live CFn A/B, us-east-1, 2026-08-11): a table deployed with
      // `BillingMode: PAY_PER_REQUEST` and then UPDATE'd with the property
      // REMOVED is FLIPPED to PROVISIONED — and when the template declares no
      // `ProvisionedThroughput` either, the CFn resource handler fails the
      // stack with `Property ProvisionedThroughput cannot be empty` rather
      // than retaining the old mode. So "removal retains" was the wrong
      // reading; removal resets, exactly like `TableClass` below.
      // AWS's own view, named once: the previous-side resolution, the flip
      // detection and the ACTIVE-wait budget all have to agree on it.
      const liveBillingMode = (table?.BillingModeSummary?.BillingMode ?? 'PROVISIONED') as
        | 'PROVISIONED'
        | 'PAY_PER_REQUEST';
      const recordedPrevBillingMode = previousProperties['BillingMode'];
      const recordedPrevBillingModeUsable =
        recordedPrevBillingMode === undefined ||
        (typeof recordedPrevBillingMode === 'string' && recordedPrevBillingMode.trim() !== '');
      const prevBillingMode = (
        recordedPrevBillingModeUsable
          ? ((recordedPrevBillingMode as string | undefined) ??
            // An ABSENT recorded previous resolves differently depending on
            // what the DESIRED side asks for, and the asymmetry is deliberate
            // (review catch):
            //   - desired ALSO absent -> the type default. Both sides
            //     normalize to PROVISIONED, so BillingMode contributes no
            //     change of its own — though a ProvisionedThroughput diff can
            //     still carry the resolved mode along, which is what converges
            //     a live on-demand table the template never declared.
            //   - desired EXPLICIT -> the table's LIVE mode. Taking the type
            //     default here would compare PROVISIONED against an explicit
            //     `BillingMode: PROVISIONED` and SUPPRESS the flip entirely,
            //     leaving a live PAY_PER_REQUEST table on-demand forever while
            //     state records PROVISIONED. Reachable via `cdkd import`,
            //     whose state properties come from the template, not from AWS.
            (properties['BillingMode'] !== undefined ? liveBillingMode : 'PROVISIONED'))
          : liveBillingMode
      ) as 'PROVISIONED' | 'PAY_PER_REQUEST';
      if (!recordedPrevBillingModeUsable) {
        this.logger.warn(
          `AWS::DynamoDB::Table ${logicalId}: the recorded previous BillingMode is ` +
            `unusable (${JSON.stringify(recordedPrevBillingMode)}) — using the table's ` +
            `actual billing mode (${prevBillingMode}) as the comparison baseline for ` +
            `this update so a corrected template does not issue a same-mode UpdateTable.`
        );
      }
      let billingModeUnusable = false;
      // ABSENT resolves to the CFn type default (see the reset note above);
      // present-but-unusable still falls back to the PREVIOUS mode, because
      // there the template DID ask for something and defaulting a junk value
      // would silently re-price a live table.
      const requestedBillingMode =
        properties['BillingMode'] === undefined
          ? 'PROVISIONED'
          : requireConfigString(
              properties['BillingMode'],
              'PROVISIONED',
              'AWS::DynamoDB::Table BillingMode',
              {
                onUnusable: (message) => {
                  billingModeUnusable = true;
                  this.logger.warn(
                    `${message} The table's current billing mode (${prevBillingMode}) is kept ` +
                      `for this update rather than flipped to the default.`
                  );
                },
              }
            );
      const billingMode = billingModeUnusable
        ? prevBillingMode
        : (requestedBillingMode as 'PROVISIONED' | 'PAY_PER_REQUEST');
      const billingOrThroughputChanged =
        billingMode !== prevBillingMode ||
        JSON.stringify(properties['ProvisionedThroughput']) !==
          JSON.stringify(previousProperties['ProvisionedThroughput']);
      // A flip INTO PROVISIONED while the template still declares
      // `OnDemandThroughput` is self-contradictory, and issue #1553 made it
      // newly reachable: the flip would be applied first and the on-demand
      // ceiling would then be REJECTED by AWS, leaving the table half-changed.
      //
      // REFUSE BEFORE ANY CALL rather than skipping the block. Skipping was
      // the first fix and a review showed it is the worse of the two: the
      // engine records the DESIRED properties as state after a successful
      // update, so the un-sent ceiling would be recorded as applied and the
      // next deploy would compare the new value against itself and never send
      // it — AWS stuck on the old ceiling permanently. That is the
      // silent-drop class this file refuses everywhere else.
      //
      // A refusal on the update path is normally the thing to avoid (a
      // rollback / `drift --revert` replays `update()` with a STATE record the
      // user cannot edit), but this shape cannot occur in a valid record: no
      // deploy that reaches state can carry it, and `readCurrentState` emits
      // `BillingMode` whenever `BillingModeSummary` exists, which is always
      // true for a live on-demand table. The value is template-borne in every
      // reachable case, so the user can act on the error.
      // `|| liveBillingMode === 'PAY_PER_REQUEST'` (PR review): this refusal
      // keys on the RECORDED previous while the flip itself keys on the LIVE
      // mode, and the two disagree after a `cdkd import` or an out-of-band
      // console flip. Before this change the mismatch was inert — the flip
      // failed anyway for an indexed table — but now that the flip SUCCEEDS,
      // a record saying PROVISIONED against a live on-demand table would slip
      // past the refusal, flip the table, and only then have its
      // `OnDemandThroughput` UpdateTable rejected against a now-provisioned
      // table: a half-applied deploy. Refusing on either side keeps the
      // pre-flight ahead of the mutation.
      // `billingOrThroughputChanged &&` leads (PR review round 2): without it
      // the widened live-mode arm OVER-refuses. When the recorded previous and
      // the desired side both omit `BillingMode`, both normalize to the type
      // default PROVISIONED, so no flip is sent at all — yet a live on-demand
      // table declaring `OnDemandThroughput` would hard-error on a deploy that
      // used to succeed. That shape DOES reach state (it succeeded before), so
      // it would also break the justification below and make a rollback /
      // `drift --revert` replay throw on a record the user cannot edit — the
      // exact class this file exists to avoid. The conjunct cannot weaken the
      // original arm: `prevBillingMode === 'PAY_PER_REQUEST'` with a desired
      // PROVISIONED is a mode change, so the flag is already true there.
      if (
        billingOrThroughputChanged &&
        billingMode === 'PROVISIONED' &&
        (prevBillingMode === 'PAY_PER_REQUEST' || liveBillingMode === 'PAY_PER_REQUEST') &&
        properties['OnDemandThroughput'] !== undefined
      ) {
        const absentNote =
          properties['BillingMode'] === undefined
            ? ' (BillingMode is absent from the template, which CloudFormation resets to PROVISIONED)'
            : '';
        throw new ProvisioningError(
          `AWS::DynamoDB::Table ${logicalId}: the template flips BillingMode to ` +
            `PROVISIONED${absentNote} while still declaring OnDemandThroughput, which AWS ` +
            `accepts only on a PAY_PER_REQUEST table. Nothing was applied. Remove ` +
            `OnDemandThroughput, or keep BillingMode: PAY_PER_REQUEST.`,
          logicalId,
          resourceType
        );
      }
      // The LIVE index list and the DESIRED index map, hoisted out of the flip
      // block because the pre-flip REMOVAL below needs both before the flip is
      // built, and the flip's per-index capacity block then needs the live list
      // MINUS whatever the removal deleted.
      const liveIndexes = table?.GlobalSecondaryIndexes ?? [];
      const desiredIndexByName = new Map<string, Record<string, unknown>>();
      for (const entry of Array.isArray(properties['GlobalSecondaryIndexes'])
        ? (properties['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)
        : []) {
        const name = entry?.['IndexName'];
        if (typeof name === 'string') desiredIndexByName.set(name, entry);
      }

      // Removing a GSI in the SAME deploy as a flip to PROVISIONED (issue
      // #1617). AWS demands per-index `ProvisionedThroughput` for every index
      // that is LIVE at flip time, and the template no longer declares the
      // removed one, so there is no capacity to send: the flip is rejected
      // (`ProvisionedThroughput must be specified for index: <name>`, measured
      // 2026-08-11) on every deploy, and `applyGsiUpdates` — which owns the
      // Delete op — runs AFTER the flip and is therefore never reached. The
      // deploy could not converge by any template-side edit.
      //
      // So issue the Delete FIRST, which is what CloudFormation does (it
      // succeeds on this shape). Only the removal moves: creates and capacity
      // updates stay after the flip, where the index they describe exists.
      //
      // Scoped to the flip-to-PROVISIONED shape because that is the only one
      // that enumerates live indexes — a flip to PAY_PER_REQUEST needs no
      // per-index capacity, and reordering its removals would be a behavior
      // change with no defect behind it.
      const preFlipDeletedIndexNames = new Set<string>();
      // A present-but-NON-ARRAY desired value (an unresolved intrinsic, a
      // mis-nested template value) reads as an empty desired set above, which
      // would classify EVERY live index as removed and delete them all before
      // the flip (PR review). That shape was non-destructive before this
      // change — the flip block warned and omitted, and `applyGsiUpdates` then
      // threw on `desired.filter` — so the removal is refused here rather than
      // newly destroying data on a malformed template.
      const desiredIndexesUnusable =
        properties['GlobalSecondaryIndexes'] != null &&
        !Array.isArray(properties['GlobalSecondaryIndexes']);
      if (
        billingOrThroughputChanged &&
        billingMode === 'PROVISIONED' &&
        liveBillingMode === 'PAY_PER_REQUEST' &&
        liveIndexes.length > 0 &&
        !desiredIndexesUnusable
      ) {
        // Only an index cdkd's PREVIOUS side knows about is removable here. A
        // live index in neither side was created out of band, and deleting it
        // is not something this deploy asked for — it stays live, lands in the
        // `unspecified` warning below, and AWS rejects the flip by name, which
        // is the same outcome as before this change.
        const previousIndexNames = new Set(
          (Array.isArray(previousProperties['GlobalSecondaryIndexes'])
            ? (previousProperties['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)
            : []
          )
            .map((entry) => entry?.['IndexName'])
            .filter((name): name is string => typeof name === 'string')
        );
        const removable: string[] = [];
        const remainingWithoutCapacity: string[] = [];
        for (const live of liveIndexes) {
          const indexName = live.IndexName;
          if (typeof indexName !== 'string') continue;
          if (!desiredIndexByName.has(indexName)) {
            if (previousIndexNames.has(indexName)) removable.push(indexName);
            else remainingWithoutCapacity.push(indexName);
            continue;
          }
          if (!hasUsableDeclaredCapacity(desiredIndexByName.get(indexName))) {
            remainingWithoutCapacity.push(indexName);
          }
        }
        // PRE-VALIDATE, because a Delete is not undoable. When the flip is
        // DOOMED for a reason already visible here, deleting first buys
        // nothing and leaves a PARTIALLY applied deploy (index gone, mode
        // unchanged) — so the shape is kept at "nothing applied".
        //
        // Two causes are foreseeable, and BOTH must be checked (PR review
        // found the second missing). AWS rejects the flip when an index that
        // will STILL be live declares no usable per-index capacity, and
        // equally when the TABLE-level `ProvisionedThroughput` is absent or
        // unusable — the flip block below deliberately leaves that one to AWS
        // (CFn parity), which is fine for the flip itself but is exactly the
        // deterministic failure a pre-flip delete must not run ahead of.
        const tableCapacityUnusable = !hasUsableTableCapacity(properties['ProvisionedThroughput']);
        if (
          removable.length > 0 &&
          (remainingWithoutCapacity.length > 0 || tableCapacityUnusable)
        ) {
          // BOTH reasons are reported when both fire (PR review): naming only
          // one sends the user round the loop again — they fix it, re-deploy,
          // and meet the second warning.
          const reasons: string[] = [];
          if (remainingWithoutCapacity.length > 0) {
            reasons.push(
              `index(es) ${remainingWithoutCapacity.join(', ')} stay live and declare no usable ` +
                `per-index ProvisionedThroughput (both ReadCapacityUnits and WriteCapacityUnits ` +
                `are required there)`
            );
          }
          if (tableCapacityUnusable) {
            reasons.push(`the template declares no usable table-level ProvisionedThroughput`);
          }
          this.logger.warn(
            `AWS::DynamoDB::Table ${logicalId}: this deploy removes global secondary index(es) ` +
              `${removable.join(', ')} and flips BillingMode to PROVISIONED. The removal would ` +
              `normally be applied BEFORE the flip, but ${reasons.join(' and ')}, so AWS rejects ` +
              `the flip either way. Nothing was removed.`
          );
        } else if (removable.length > 0) {
          this.logger.debug(
            `Deleting GSI(s) ${removable.join(', ')} on DynamoDB table ${physicalId} before the ` +
              `BillingMode flip to PROVISIONED`
          );
          // One op per UpdateTable with a full table+indexes ACTIVE wait
          // between each — AWS's one-GSI-op-per-call budget, and the wait is
          // what returns the table to a state that accepts the flip (the same
          // index-status race issue #1553 handles).
          await this.runGsiOps(
            physicalId,
            removable.map((name) => ({ Delete: { IndexName: name } })),
            undefined
          );
          for (const name of removable) preFlipDeletedIndexNames.add(name);
          // A failure BETWEEN the deletes and the flip leaves the index gone
          // and the mode unchanged. That partial application is accepted —
          // but only because the NEXT deploy converges, and that is a
          // property of the Delete arm below rather than something to assume.
          //
          // The first version of this comment claimed the next deploy is fine
          // "because the GSI diff is already satisfied", and a PR review
          // showed that was WRONG: cdkd writes state only after `update()`
          // RETURNS, so a mid-update failure leaves the deleted index still
          // recorded in the previous side, and the next deploy would emit a
          // Delete for an index AWS no longer has — the
          // `ResourceNotFoundException` that would fail every subsequent
          // deploy forever, re-creating the very unconvergeable class this
          // change exists to remove. `applyGsiUpdates` therefore skips a
          // Delete for a name that is not LIVE, which makes the arm
          // idempotent and is what actually makes this residual recoverable.
        }
      }

      // The names that are LIVE in AWS right now — the DescribeTable snapshot
      // minus whatever the pre-flip removal just deleted. `applyGsiUpdates`
      // uses it to make its Delete arm IDEMPOTENT (issue #1617 PR review):
      // without it, a state record naming an index AWS no longer has produces
      // a `ResourceNotFoundException` on every deploy forever. That covers the
      // pre-flip deletes AND the pre-existing case of a resource whose index
      // was removed out of band or by an earlier interrupted run.
      //
      // `undefined` when there is no snapshot to reason from, which keeps the
      // pre-change behavior rather than silently skipping every removal.
      const currentLiveIndexNames = table
        ? new Set(
            liveIndexes
              .map((live) => live.IndexName)
              .filter((name): name is string => typeof name === 'string')
              .filter((name) => !preFlipDeletedIndexNames.has(name))
          )
        : undefined;

      // Index names whose capacity the BillingMode flip below already delivered.
      // `applyGsiUpdates` must NOT re-assert them: real AWS rejects a no-op
      // capacity change outright (`The provisioned throughput for the index X
      // will not change. The requested value equals the current value.`), so
      // the second UpdateTable fails the whole deploy. Found by the
      // `dynamodb-ondemand` integ on the first run of this change — the unit
      // tests could not see it, because each mocks ONE call and the defect is
      // an interaction BETWEEN two of them (issue #1588). Same mechanism as
      // `gsiHandledByBillingFlip` in `dynamodb-globaltable-provider.ts`.
      const gsiHandledByBillingFlip = new Set<string>();
      if (billingOrThroughputChanged || tableClassChanged) {
        const updateInput: UpdateTableCommandInput = { TableName: physicalId };
        // Always defined now that both sides normalize, so the call can never
        // again go out with only a `TableName` — the empty-UpdateTable shape
        // issue #1553 is about.
        if (billingOrThroughputChanged) {
          updateInput.BillingMode = billingMode;
        }
        if (tableClassChanged) {
          // A removed TableClass property reverts to the DynamoDB default
          // (STANDARD) — matches CFn, which reverts an absent property to the
          // type default rather than leaving the old value in place.
          updateInput.TableClass = normalizeTableClass(properties['TableClass']);
        }
        // PAY_PER_REQUEST rejects ProvisionedThroughput; PROVISIONED requires
        // it, so forward the caps whenever the resolved mode is PROVISIONED.
        // Gated on billingOrThroughputChanged so a TableClass-only change does
        // not re-assert the current throughput — AWS rejects an UpdateTable
        // whose requested throughput equals the table's current value.
        //
        // A flip to PROVISIONED with NO `ProvisionedThroughput` in the template
        // is left to fail at AWS rather than pre-refused here: that is CFn
        // parity (its handler fails the same shape with `Property
        // ProvisionedThroughput cannot be empty`), DynamoDB's own error names
        // the missing member, and a pre-flight throw on the UPDATE path would
        // fire on a rollback / `drift --revert` replay of a state record the
        // user cannot edit.
        if (
          billingOrThroughputChanged &&
          billingMode !== 'PAY_PER_REQUEST' &&
          properties['ProvisionedThroughput']
        ) {
          const pt = properties['ProvisionedThroughput'] as Record<string, unknown>;
          updateInput.ProvisionedThroughput = {
            ReadCapacityUnits: Number(pt['ReadCapacityUnits'] ?? 5),
            WriteCapacityUnits: Number(pt['WriteCapacityUnits'] ?? 5),
          };
        }
        // Per-index ProvisionedThroughput must ride the SAME UpdateTable as a
        // flip TO PROVISIONED (issue #1588). Live-measured on 2026-08-11
        // against a PAY_PER_REQUEST table carrying one GSI:
        //
        //   A) BillingMode + table-level ProvisionedThroughput only (what this
        //      method sent before) -> ValidationException: "One or more
        //      parameter values were invalid: ProvisionedThroughput must be
        //      specified for index: gsi1". Nothing applied.
        //   B) the same call plus GlobalSecondaryIndexUpdates[].Update.
        //      ProvisionedThroughput -> ACCEPTED; readback showed the table at
        //      its declared capacity and the index at its own.
        //
        // So a table WITH a GSI could not be flipped at all — the pre-#1588
        // comment here called it "a separate concern" and "a silent gap", but
        // it is neither silent nor separate: it is a hard failure of the flip
        // this method performs. Only the flip needs this; a capacity bump on an
        // already-PROVISIONED table does not, and re-asserting an index's
        // current capacity is a call AWS rejects.
        //
        // The index list is the LIVE one, but be precise about what that buys
        // (PR review corrected an overclaim here). Capacity still comes from
        // the DESIRED template, so for an index that is live but no longer
        // declared the flip is NOT rescued — the index is named in a warning
        // and omitted, and AWS rejects the flip exactly as it would have with a
        // template-only list. What the live list buys is DIAGNOSTICS: cdkd
        // names the offending index up front instead of leaving the user to
        // decode an AWS error about an index their template no longer mentions.
        // (`dynamodb-globaltable-provider.ts` additionally falls back to the
        // PREVIOUS side there; that rarely helps here, because the previous
        // side of an on-demand table carries no per-index capacity either.)
        //
        // An index with no usable declared capacity is left out so AWS's own
        // error names it, matching the CFn handler rather than inventing a
        // capacity the user never asked for.
        // The `DescribeTable` snapshot predates the pre-flip removal above, so
        // drop whatever it deleted: AWS enumerates the indexes that are live
        // NOW, and naming a just-deleted one would re-introduce the very
        // rejection the removal exists to avoid (issue #1617).
        const flipLiveIndexes = liveIndexes.filter(
          (live) =>
            typeof live.IndexName !== 'string' || !preFlipDeletedIndexNames.has(live.IndexName)
        );
        if (
          billingOrThroughputChanged &&
          billingMode === 'PROVISIONED' &&
          liveBillingMode === 'PAY_PER_REQUEST' &&
          flipLiveIndexes.length > 0
        ) {
          const indexUpdates: GlobalSecondaryIndexUpdate[] = [];
          const unspecified: string[] = [];
          for (const live of flipLiveIndexes) {
            const indexName = live.IndexName;
            if (typeof indexName !== 'string') continue;
            // BOTH members must be present, numeric and finite. A `?? 5`
            // default here would contradict this block's own rule two comments
            // up — and worse than at create(), because the flip now SUPPRESSES
            // the per-index path for this index, so an invented capacity is
            // never corrected by a later call and lands in state as if the
            // user had declared it. A half-declared or non-numeric entry is
            // treated exactly like an absent one: omitted, named in the
            // warning, and left for AWS to reject by name (PR review).
            const declared = desiredIndexByName.get(indexName)?.['ProvisionedThroughput'];
            const read = readCapacityNumber(declared, 'ReadCapacityUnits');
            const write = readCapacityNumber(declared, 'WriteCapacityUnits');
            if (read === undefined || write === undefined) {
              unspecified.push(indexName);
              continue;
            }
            indexUpdates.push({
              Update: {
                IndexName: indexName,
                ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
              },
            });
            gsiHandledByBillingFlip.add(indexName);
          }
          if (indexUpdates.length > 0) {
            updateInput.GlobalSecondaryIndexUpdates = indexUpdates;
          }
          if (unspecified.length > 0) {
            // Not a refusal: AWS rejects the call by name a moment later, which
            // is the CFn-parity outcome and a better message than anything a
            // pre-flight guess could produce. The warning exists so the cause is
            // visible in cdkd's own output rather than only in the AWS error.
            this.logger.warn(
              `AWS::DynamoDB::Table ${logicalId}: flipping BillingMode to PROVISIONED, but the ` +
                `template declares no usable ProvisionedThroughput for live index(es) ` +
                `${unspecified.join(', ')}. AWS requires per-index capacity in the same ` +
                `UpdateTable and will reject the flip naming them. Declare ` +
                `GlobalSecondaryIndexes[].ProvisionedThroughput (both ReadCapacityUnits and ` +
                `WriteCapacityUnits) for each. An index this deploy REMOVES is deleted BEFORE ` +
                `the flip automatically (issue #1617), so a name here is one the template still ` +
                `keeps, one that exists in AWS but in neither the template nor cdkd state ` +
                `(created out of band), or one whose pre-flip removal was skipped for the reason ` +
                `warned above.`
            );
          }
        }
        await this.dynamoDBClient.send(new UpdateTableCommand(updateInput));
        // UpdateTable is async; wait for ACTIVE so later branches (and any
        // subsequent UpdateTable for OnDemand/Warm throughput) don't race a
        // still-UPDATING table.
        //
        // The flip test is against the table's LIVE mode, not the RECORDED
        // previous (review catch): when state and AWS disagree — an absent
        // recorded previous against a live on-demand table, or the
        // unusable-value arm under drift — `billingMode !== prevBillingMode`
        // is false while AWS performs a real flip, which is exactly the case
        // the long budget exists for.
        //
        // A flip also re-provisions every GSI, and `TableStatus` returns
        // ACTIVE before the indexes do; the branches below issue further
        // `UpdateTable`s that would race a still-UPDATING index and get
        // `ResourceInUseException`. So a flip waits on the INDEXES too.
        if (billingMode !== liveBillingMode) {
          await this.waitForTableAndIndexesActive(physicalId, BILLING_FLIP_ACTIVE_WAIT_ATTEMPTS);
        } else {
          await this.waitForTableActiveAfterUpdate(physicalId, TABLE_ACTIVE_WAIT_ATTEMPTS);
        }
        this.logger.debug(
          `Updated BillingMode/ProvisionedThroughput/TableClass on DynamoDB table ${physicalId}`
        );
      }

      // OnDemandThroughput — rides on UpdateTable (NOT a separate control-
      // plane API like PITR / TTL). Fire only when the value changed so a
      // no-op update doesn't issue a redundant UpdateTable; AWS validates
      // the PAY_PER_REQUEST-only constraint.
      if (
        JSON.stringify(properties['OnDemandThroughput']) !==
        JSON.stringify(previousProperties['OnDemandThroughput'])
      ) {
        if (properties['OnDemandThroughput']) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              OnDemandThroughput: properties['OnDemandThroughput'] as OnDemandThroughput,
            })
          );
          // UpdateTable is async; wait for ACTIVE so later branches (SSE /
          // Stream / GSI) don't race a still-UPDATING table.
          await this.waitForTableActiveAfterUpdate(physicalId);
          this.logger.debug(`Updated OnDemandThroughput on DynamoDB table ${physicalId}`);
        }
      }

      // WarmThroughput — rides on UpdateTable (NOT a separate control-plane
      // API like PITR / TTL). Fire only when the value changed so a no-op
      // update doesn't issue a redundant UpdateTable. A pure removal (new
      // absent, previous present) is a deliberate no-op — CFn has no clean
      // "drop warm throughput" mapping and AWS keeps the last-set value, so
      // there is no spec to send.
      if (
        JSON.stringify(properties['WarmThroughput']) !==
        JSON.stringify(previousProperties['WarmThroughput'])
      ) {
        if (properties['WarmThroughput']) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              WarmThroughput: properties['WarmThroughput'] as WarmThroughput,
            })
          );
          // UpdateTable is async; wait for ACTIVE so later branches (SSE /
          // Stream / GSI) don't race a still-UPDATING table.
          await this.waitForTableActiveAfterUpdate(physicalId);
          this.logger.debug(`Updated WarmThroughput on DynamoDB table ${physicalId}`);
        }
      }

      // SSESpecification — rides on its OWN UpdateTable (separate from the
      // billing/throughput call above and the GSI calls below). Fire only when
      // the value changed, and wait for ACTIVE afterwards so the GSI block does
      // not race an UPDATING table. The same SSEEnabled->Enabled mapping the
      // create path needs applies here. A removal (new absent, previous present)
      // is a deliberate no-op: CFn has no clean "drop SSE back to AWS-owned"
      // mapping and mapSSESpecification(undefined) returns undefined, so there
      // is no spec to send (mirrors the WarmThroughput removal stance).
      if (
        JSON.stringify(properties['SSESpecification']) !==
        JSON.stringify(previousProperties['SSESpecification'])
      ) {
        const sseUpdate = mapSSESpecification(properties['SSESpecification']);
        if (sseUpdate && Object.keys(sseUpdate).length > 0) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({ TableName: physicalId, SSESpecification: sseUpdate })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          this.logger.debug(`Updated SSESpecification on DynamoDB table ${physicalId}`);
        }
      }

      // StreamSpecification — DynamoDB Streams enable / disable / view-type
      // change, all via UpdateTable's StreamSpecification field (a separate
      // UpdateTable from the billing / SSE calls, mirroring their pattern).
      // It previously had NO update branch, so enabling a stream, changing the
      // StreamViewType, or removing a stream were ALL silently dropped: the
      // deploy reported success while AWS kept the old stream config, and the
      // next diff saw no change (state recorded the new spec), so it could
      // never self-heal (the throw-not-swallow / no-silent-drop rule).
      //
      // Three transitions, keyed off whether the spec is present on each side:
      //  - enable  (new present, previous absent): StreamEnabled: true + the
      //    new StreamViewType, then wait ACTIVE and capture LatestStreamArn.
      //  - disable (new absent, previous present): StreamEnabled: false; the
      //    stream ARN is cleared afterwards.
      //  - view-type change (both present, different StreamViewType): AWS
      //    REJECTS a direct StreamViewType switch on an enabled stream, so the
      //    change is applied as disable -> wait ACTIVE -> re-enable with the
      //    new view type -> wait ACTIVE. (DynamoDB also rejects a rapid
      //    disable-then-enable against a still-UPDATING table, so the wait
      //    between the two calls is load-bearing, not just cosmetic.)
      if (
        JSON.stringify(properties['StreamSpecification']) !==
        JSON.stringify(previousProperties['StreamSpecification'])
      ) {
        const newViewType = this.extractStreamViewType(properties['StreamSpecification']);
        const prevViewType = this.extractStreamViewType(previousProperties['StreamSpecification']);

        if (newViewType && prevViewType && newViewType !== prevViewType) {
          // View-type change on an enabled stream: disable, wait, re-enable.
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: { StreamEnabled: false } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          const reenable = await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: {
                StreamEnabled: true,
                StreamViewType: newViewType,
              } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          latestStreamArn =
            reenable.TableDescription?.LatestStreamArn ??
            (await this.describeLatestStreamArn(physicalId));
          this.logger.debug(
            `Changed StreamViewType on DynamoDB table ${physicalId} to ${newViewType}`
          );
        } else if (newViewType) {
          // Enable a stream (or re-assert with the same/new view type when the
          // previous side had no stream).
          const enable = await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: {
                StreamEnabled: true,
                StreamViewType: newViewType,
              } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          latestStreamArn =
            enable.TableDescription?.LatestStreamArn ??
            (await this.describeLatestStreamArn(physicalId));
          this.logger.debug(`Enabled DynamoDB Stream on table ${physicalId} (${newViewType})`);
        } else {
          // Removal (new absent, previous present): disable the stream.
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: { StreamEnabled: false } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          latestStreamArn = undefined;
          this.logger.debug(`Disabled DynamoDB Stream on table ${physicalId}`);
        }
      }

      // GlobalSecondaryIndexes — add / remove / per-index throughput change via
      // UpdateTable's GlobalSecondaryIndexUpdates. AWS permits only ONE GSI
      // create or delete per UpdateTable and rejects a concurrent update while
      // the table (or another index) is still mutating, so applyGsiUpdates
      // serializes the operations and waits for ACTIVE between each. A GSI
      // create must carry the new index's key AttributeDefinitions in the same
      // call — the full desired AttributeDefinitions array is forwarded.
      //
      // A removal may ALREADY have been applied above, ahead of a BillingMode
      // flip to PROVISIONED (issue #1617); `currentLiveIndexNames` is the
      // post-removal live set, so the Delete arm skips both those names and any
      // index the record still lists that AWS no longer has.
      if (
        JSON.stringify(properties['GlobalSecondaryIndexes']) !==
        JSON.stringify(previousProperties['GlobalSecondaryIndexes'])
      ) {
        await this.applyGsiUpdates(
          physicalId,
          resourceType,
          logicalId,
          previousProperties['GlobalSecondaryIndexes'] as GlobalSecondaryIndex[] | undefined,
          properties['GlobalSecondaryIndexes'] as GlobalSecondaryIndex[] | undefined,
          properties['AttributeDefinitions'] as AttributeDefinition[] | undefined,
          gsiHandledByBillingFlip,
          currentLiveIndexNames
        );
      }

      // PointInTimeRecoverySpecification — separate UpdateContinuousBackups
      // API. Fire only when the value changed; a removal disables PITR.
      if (
        JSON.stringify(properties['PointInTimeRecoverySpecification']) !==
        JSON.stringify(previousProperties['PointInTimeRecoverySpecification'])
      ) {
        await this.applyPointInTimeRecovery(
          physicalId,
          properties['PointInTimeRecoverySpecification'],
          // On removal (new absent, previous present) explicitly disable.
          previousProperties['PointInTimeRecoverySpecification']
        );
      }

      // TimeToLiveSpecification — separate UpdateTimeToLive API. Fire only
      // when the value changed; a removal disables TTL using the previous
      // AttributeName (AWS requires it to disable).
      if (
        JSON.stringify(properties['TimeToLiveSpecification']) !==
        JSON.stringify(previousProperties['TimeToLiveSpecification'])
      ) {
        this.assertNoActiveTtlAttributeNameChange(
          logicalId,
          resourceType,
          physicalId,
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        );
        await this.applyTimeToLive(
          physicalId,
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        );
      }

      // ResourcePolicy — separate PutResourcePolicy / DeleteResourcePolicy
      // APIs (the CreateTable `ResourcePolicy` field is create-only). Fire
      // only when the value changed; a removal deletes the policy. Needs the
      // table ARN, which the DescribeTable above gave us. Fail loud when a
      // change is detected but the ARN is missing (transient/partial
      // DescribeTable response) — a silent skip would write the new policy
      // into state as if applied, so the next deploy sees no diff and the
      // policy stays permanently stale (the throw-not-swallow rule).
      if (
        JSON.stringify(properties['ResourcePolicy']) !==
        JSON.stringify(previousProperties['ResourcePolicy'])
      ) {
        if (!table?.TableArn) {
          throw new ProvisioningError(
            `Cannot apply ResourcePolicy change for DynamoDB table ${logicalId}: DescribeTable returned no TableArn`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        await this.applyResourcePolicy(
          table.TableArn,
          properties['ResourcePolicy'],
          previousProperties['ResourcePolicy']
        );
      }

      // KinesisStreamSpecification — separate Enable/Disable/Update
      // KinesisStreamingDestination APIs. Fire only when the value changed; a
      // removal disables streaming to the previous stream ARN.
      if (
        JSON.stringify(properties['KinesisStreamSpecification']) !==
        JSON.stringify(previousProperties['KinesisStreamSpecification'])
      ) {
        await this.applyKinesisStreamingDestination(
          physicalId,
          properties['KinesisStreamSpecification'],
          previousProperties['KinesisStreamSpecification']
        );
      }

      // ContributorInsightsSpecification — separate UpdateContributorInsights
      // API. Fire only when the value changed; a removal disables insights.
      if (
        JSON.stringify(properties['ContributorInsightsSpecification']) !==
        JSON.stringify(previousProperties['ContributorInsightsSpecification'])
      ) {
        await this.applyContributorInsights(
          physicalId,
          properties['ContributorInsightsSpecification'],
          previousProperties['ContributorInsightsSpecification']
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: table?.TableArn,
          TableId: table?.TableId,
          StreamArn: latestStreamArn,
          TableName: physicalId,
        },
      };
    } catch (error) {
      // Preserve already-actionable ProvisioningErrors (e.g. the TTL
      // attribute-name-change guard, the ResourcePolicy-ARN guard) verbatim
      // instead of double-wrapping them behind a generic "Failed to update"
      // prefix. Mirrors the create() catch.
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a DynamoDB table
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DynamoDB table ${logicalId}: ${physicalId}`);

    // `--remove-protection`: flip DeletionProtectionEnabled off before
    // delete. UpdateTable is async — wait for ACTIVE before issuing
    // DeleteTable so the delete doesn't race the still-UPDATING table.
    // Idempotent — DynamoDB accepts the call when protection is already
    // disabled. Non-fatal: log at debug if the flip-off itself errors
    // (NotFound / similar) so the delete still proceeds.
    if (context?.removeProtection === true) {
      try {
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            DeletionProtectionEnabled: false,
          })
        );
        this.logger.debug(
          `Disabled DeletionProtectionEnabled on DynamoDB table ${logicalId}, waiting for ACTIVE`
        );
        try {
          await this.waitForTableActiveAfterUpdate(physicalId);
        } catch (waitErr) {
          this.logger.debug(
            `Could not wait for table ${physicalId} ACTIVE after disabling protection: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`
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

    try {
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
      this.logger.debug(`Successfully deleted DynamoDB table ${logicalId}`);
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
        this.logger.debug(`DynamoDB table ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via DynamoDB's
   * `TagResource` / `UntagResource` APIs. Both take the table ARN as
   * `ResourceArn`.
   */
  private async applyTagDiff(
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
      await this.dynamoDBClient.send(
        new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from DynamoDB table ${tableArn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.dynamoDBClient.send(
        new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on DynamoDB table ${tableArn}`);
    }
  }

  /**
   * Apply the table's `PointInTimeRecoverySpecification` via the separate
   * `UpdateContinuousBackups` API (PITR does NOT ride on CreateTable).
   *
   * CFn shape is `{ PointInTimeRecoveryEnabled: boolean, RecoveryPeriodInDays?: number }`.
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — when the
   * template drops the block but it was present before — we explicitly
   * disable PITR (`UpdateContinuousBackups` treats an absent spec as "no
   * change", so a dropped block must be turned into an explicit
   * `PointInTimeRecoveryEnabled: false`).
   */
  private async applyPointInTimeRecovery(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    let enabled: boolean | undefined;
    let recoveryPeriodInDays: number | undefined;
    if (spec !== undefined && spec !== null) {
      const s = spec as Record<string, unknown>;
      enabled = Boolean(s['PointInTimeRecoveryEnabled']);
      // RecoveryPeriodInDays only applies when PITR is enabled; AWS rejects it
      // alongside PointInTimeRecoveryEnabled: false.
      if (enabled && s['RecoveryPeriodInDays'] !== undefined) {
        recoveryPeriodInDays = Number(s['RecoveryPeriodInDays']);
      }
    } else if (previousSpec !== undefined && previousSpec !== null) {
      // Removed from the template: disable.
      enabled = false;
    }

    if (enabled === undefined) return;

    const pitrSpec: PointInTimeRecoverySpecification = { PointInTimeRecoveryEnabled: enabled };
    if (recoveryPeriodInDays !== undefined) {
      pitrSpec.RecoveryPeriodInDays = recoveryPeriodInDays;
    }

    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new UpdateContinuousBackupsCommand({
            TableName: tableName,
            PointInTimeRecoverySpecification: pitrSpec,
          })
        ),
      `enable PITR on ${tableName}`
    );
    this.logger.debug(
      `Set PointInTimeRecoveryEnabled=${enabled}${
        recoveryPeriodInDays !== undefined ? ` RecoveryPeriodInDays=${recoveryPeriodInDays}` : ''
      } on DynamoDB table ${tableName}`
    );
  }

  /**
   * Retry a DynamoDB control-plane call on the transient "settling" errors AWS
   * returns when two table-modifying operations land back-to-back. Enabling
   * PITR (`UpdateContinuousBackups`) puts the table in a transient state, and a
   * subsequent `UpdateTimeToLive` is then rejected with "Backups are being
   * enabled for the table ... Please retry later". `ResourceInUseException`
   * ("table is being updated") and `LimitExceededException` are the same class.
   * Backoff: ~2s,4s,8s,16s,30s,30s... bounded to ~2min total, which comfortably
   * covers the few-second PITR-enable window.
   */
  private async retryOnTransientControlPlane<T>(
    op: () => Promise<T>,
    label: string,
    maxAttempts = 8
  ): Promise<T> {
    let delayMs = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : '';
        const transient =
          /being enabled|being updated|please retry later|backups are being/i.test(msg) ||
          name === 'ResourceInUseException' ||
          name === 'LimitExceededException';
        if (!transient || attempt >= maxAttempts) throw error;
        this.logger.debug(
          `Transient error on "${label}" (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  /**
   * Apply the table's `TimeToLiveSpecification` via the separate
   * `UpdateTimeToLive` API (TTL does NOT ride on CreateTable).
   *
   * CFn shape is `{ AttributeName: string, Enabled: boolean }`. Called from
   * both `create()` (after the table is ACTIVE) and `update()` (only when the
   * value changed). On `update()`-side removal — when the template drops the
   * block but it was present before — we disable TTL using the PREVIOUS
   * `AttributeName` (AWS requires the attribute name even to disable TTL).
   */
  /**
   * Pre-emptively reject a TTL `AttributeName` change between two enabled
   * specs with a clear, actionable message.
   *
   * AWS allows TTL on only ONE attribute per table, so enabling TTL on a new
   * attribute while TTL is still active on the old one fails with the opaque
   * `TimeToLive is active on a different AttributeName: <old>`; and because
   * DynamoDB rate-limits `UpdateTimeToLive` to one modification per table per
   * ~1 hour, the user cannot disable-then-re-enable within a single deploy
   * either. CloudFormation hits the same wall (UPDATE_ROLLBACK). Surfacing the
   * two-deploy remediation up front beats letting the raw AWS error bubble.
   *
   * Only fires when BOTH the old and new specs are present and enabled with a
   * DIFFERENT `AttributeName`. Enable-from-disabled, disable, and same-name
   * Enabled toggles all pass through to {@link applyTimeToLive}.
   */
  private assertNoActiveTtlAttributeNameChange(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    spec: unknown,
    previousSpec: unknown
  ): void {
    const cur = this.readTtlSpec(spec);
    const prev = this.readTtlSpec(previousSpec);
    if (
      cur.enabled &&
      prev.enabled &&
      cur.attributeName !== undefined &&
      prev.attributeName !== undefined &&
      cur.attributeName !== prev.attributeName
    ) {
      throw new ProvisioningError(
        `DynamoDB table ${logicalId}: cannot change the TimeToLive AttributeName ` +
          `from '${prev.attributeName}' to '${cur.attributeName}' in a single deploy. ` +
          `AWS allows TTL on only one attribute and rejects enabling it on a new ` +
          `attribute while TTL is still active on '${prev.attributeName}' ` +
          `("TimeToLive is active on a different AttributeName"); DynamoDB also limits ` +
          `UpdateTimeToLive to one change per table per ~1 hour. To change the TTL ` +
          `attribute, do it in two deploys: (1) remove TimeToLiveSpecification (or set ` +
          `Enabled: false) to disable TTL on '${prev.attributeName}', then (2) after the ` +
          `disable settles (~1h), deploy again enabling TTL on '${cur.attributeName}'.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  /**
   * Normalize a `TimeToLiveSpecification` value into `{ enabled, attributeName }`.
   * Mirrors {@link applyTimeToLive}'s default (`Enabled` absent => true).
   */
  private readTtlSpec(spec: unknown): { enabled: boolean; attributeName: string | undefined } {
    if (spec === undefined || spec === null) {
      return { enabled: false, attributeName: undefined };
    }
    const s = spec as Record<string, unknown>;
    const attributeName = s['AttributeName'] as string | undefined;
    // CFn `Enabled` is a boolean for CDK L2 synth, but a hand-written L1
    // template can carry the stringified `"true"` / `"false"`. `Boolean("false")`
    // is `true`, so coerce strings case-insensitively rather than via the bare
    // `Boolean()` cast (which would treat `"false"` as enabled and either
    // re-enable a disabled TTL or fire the rename guard spuriously). Absent
    // `Enabled` defaults to `true` (CFn default).
    const rawEnabled = s['Enabled'];
    const enabled =
      rawEnabled === undefined
        ? true
        : typeof rawEnabled === 'string'
          ? rawEnabled.toLowerCase() === 'true'
          : Boolean(rawEnabled);
    return { enabled, attributeName };
  }

  private async applyTimeToLive(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    if (spec !== undefined && spec !== null) {
      const { enabled, attributeName } = this.readTtlSpec(spec);
      if (!attributeName) return;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: enabled, AttributeName: attributeName },
            })
          ),
        `set TTL on ${tableName}`
      );
      this.logger.debug(
        `Set TimeToLive Enabled=${enabled} AttributeName=${attributeName} on DynamoDB table ${tableName}`
      );
      return;
    }

    // Removed from the template: disable using the previous AttributeName.
    if (previousSpec !== undefined && previousSpec !== null) {
      const prev = previousSpec as Record<string, unknown>;
      const prevAttributeName = prev['AttributeName'] as string | undefined;
      if (!prevAttributeName) return;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: false, AttributeName: prevAttributeName },
            })
          ),
        `disable TTL on ${tableName}`
      );
      this.logger.debug(
        `Disabled TimeToLive (AttributeName=${prevAttributeName}) on DynamoDB table ${tableName}`
      );
    }
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
  private extractResourcePolicyDocument(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const s = spec as Record<string, unknown>;
    const doc = s['PolicyDocument'];
    if (doc === undefined || doc === null) return undefined;
    return typeof doc === 'string' ? doc : JSON.stringify(doc);
  }

  /**
   * Apply the table's `ResourcePolicy` via the separate `PutResourcePolicy` /
   * `DeleteResourcePolicy` APIs (used by `update()` — `create()` rides the
   * policy on CreateTable directly). On removal — when the template drops the
   * block but it was present before — the existing policy is deleted.
   */
  private async applyResourcePolicy(
    tableArn: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    const policyDoc = this.extractResourcePolicyDocument(spec);
    if (policyDoc !== undefined) {
      // Wrapped in the transient-control-plane retry like the Kinesis /
      // ContributorInsights post-ACTIVE ops: update() runs PITR -> TTL ->
      // ResourcePolicy, and a preceding UpdateContinuousBackups leaves the
      // table settling, so a back-to-back PutResourcePolicy can hit
      // ResourceInUseException / "being updated".
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new PutResourcePolicyCommand({ ResourceArn: tableArn, Policy: policyDoc })
          ),
        `put ResourcePolicy on ${tableArn}`
      );
      this.logger.debug(`Put ResourcePolicy on DynamoDB table ${tableArn}`);
      return;
    }

    // Removed from the template: delete the existing policy. NotFound is
    // idempotent success (no policy to remove).
    if (previousSpec !== undefined && previousSpec !== null) {
      try {
        await this.retryOnTransientControlPlane(
          () =>
            this.dynamoDBClient.send(new DeleteResourcePolicyCommand({ ResourceArn: tableArn })),
          `delete ResourcePolicy on ${tableArn}`
        );
        this.logger.debug(`Deleted ResourcePolicy on DynamoDB table ${tableArn}`);
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
      }
    }
  }

  /**
   * Apply the table's `KinesisStreamSpecification` via the separate
   * Enable/Disable/Update `KinesisStreamingDestination` APIs (NOT a field on
   * CreateTable). CFn shape is
   * `{ StreamArn: string, ApproximateCreationDateTimePrecision?: 'MICROSECOND' | 'MILLISECOND' }`.
   *
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — template drops
   * the block but it was present before — streaming is disabled to the PREVIOUS
   * stream ARN. A same-ARN change of only the precision is a deliberate no-op
   * (re-enabling against an already-enabled stream errors), matching the
   * pre-existing WarmThroughput "no clean remap" stance; precision changes flow
   * through on the create / first-enable path.
   */
  private async applyKinesisStreamingDestination(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    const newArn = this.extractKinesisStreamArn(spec);
    const prevArn = this.extractKinesisStreamArn(previousSpec);

    // No change in target stream ARN: nothing to do (enable is not idempotent
    // against an already-enabled destination). A same-ARN change of ONLY the
    // precision is a deliberate no-op — but warn so the user knows the
    // precision edit did not reach AWS (UpdateKinesisStreamingDestination
    // could carry it, but re-enabling against an already-enabled stream
    // errors; deferred to a dedicated precision-update path).
    if (newArn === prevArn) {
      if (
        newArn &&
        JSON.stringify(
          (spec as Record<string, unknown> | undefined)?.['ApproximateCreationDateTimePrecision']
        ) !==
          JSON.stringify(
            (previousSpec as Record<string, unknown> | undefined)?.[
              'ApproximateCreationDateTimePrecision'
            ]
          )
      ) {
        this.logger.warn(
          `Kinesis streaming ApproximateCreationDateTimePrecision change on ${tableName} was not applied (same stream ARN; precision-only updates are not yet supported)`
        );
      }
      return;
    }

    // Disable streaming to the previous stream when it changed or was removed.
    if (prevArn) {
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new DisableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: prevArn,
            })
          ),
        `disable Kinesis streaming on ${tableName}`
      );
      this.logger.debug(
        `Disabled Kinesis streaming destination ${prevArn} on DynamoDB table ${tableName}`
      );
    }

    // Enable streaming to the new stream when present.
    if (newArn) {
      const s = spec as Record<string, unknown>;
      const precision = s['ApproximateCreationDateTimePrecision'] as string | undefined;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new EnableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: newArn,
              ...(precision
                ? {
                    EnableKinesisStreamingConfiguration: {
                      ApproximateCreationDateTimePrecision: precision as
                        | 'MICROSECOND'
                        | 'MILLISECOND',
                    },
                  }
                : {}),
            })
          ),
        `enable Kinesis streaming on ${tableName}`
      );
      this.logger.debug(
        `Enabled Kinesis streaming destination ${newArn} on DynamoDB table ${tableName}`
      );
    }
  }

  private extractKinesisStreamArn(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const arn = (spec as Record<string, unknown>)['StreamArn'];
    return typeof arn === 'string' ? arn : undefined;
  }

  /**
   * Extract the `StreamViewType` from a CFn `StreamSpecification` block. Returns
   * undefined when the spec is absent (no stream) — which is how update() tells
   * an enable / disable apart from a view-type change. CDK always emits a
   * StreamViewType when a stream is enabled (there is no valid enabled stream
   * without one), so a present spec implies a present view type; defensively
   * returns undefined for a malformed spec with no StreamViewType.
   */
  private extractStreamViewType(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const viewType = (spec as Record<string, unknown>)['StreamViewType'];
    return typeof viewType === 'string' && viewType.length > 0 ? viewType : undefined;
  }

  /**
   * Fetch the table's current `LatestStreamArn` via DescribeTable. Used as a
   * fallback when an UpdateTable that enabled a stream did not echo the ARN
   * back in its TableDescription, so `Fn::GetAtt [Table, StreamArn]` still
   * resolves after an update-time enable.
   */
  private async describeLatestStreamArn(tableName: string): Promise<string | undefined> {
    const response = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    return response.Table?.LatestStreamArn;
  }

  /**
   * Apply the table's `ContributorInsightsSpecification` via the separate
   * `UpdateContributorInsights` API (NOT a field on CreateTable). CFn shape is
   * `{ Enabled: boolean, Mode?: 'ACCESSED_AND_THROTTLED_KEYS' | 'THROTTLED_KEYS' }`.
   *
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — template drops
   * the block but it was present before — insights is disabled.
   */
  private async applyContributorInsights(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    let action: ContributorInsightsAction | undefined;
    let mode: ContributorInsightsMode | undefined;
    if (spec !== undefined && spec !== null) {
      const s = spec as Record<string, unknown>;
      const enabled = Boolean(s['Enabled']);
      action = enabled ? 'ENABLE' : 'DISABLE';
      // Mode only applies while enabling; AWS rejects it alongside DISABLE.
      if (enabled && s['Mode'] !== undefined) {
        mode = s['Mode'] as ContributorInsightsMode;
      }
    } else if (previousSpec !== undefined && previousSpec !== null) {
      // Removed from the template: disable.
      action = 'DISABLE';
    }

    if (action === undefined) return;

    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new UpdateContributorInsightsCommand({
            TableName: tableName,
            ContributorInsightsAction: action,
            ...(mode ? { ContributorInsightsMode: mode } : {}),
          })
        ),
      `set ContributorInsights on ${tableName}`
    );
    this.logger.debug(
      `Set ContributorInsightsAction=${action}${
        mode !== undefined ? ` Mode=${mode}` : ''
      } on DynamoDB table ${tableName}`
    );
  }

  /**
   * Poll DescribeTable until the table reaches ACTIVE status
   *
   * Uses a tight polling loop (1s intervals) instead of CC API's exponential
   * backoff (1s->2s->4s->8s->10s), reducing total wait time.
   */
  private async waitForTableActive(
    tableName: string,
    maxAttempts = 60
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

      if (status !== 'CREATING') {
        throw new Error(`Unexpected table status: ${status}`);
      }

      // Wait 1 second between polls
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Table ${tableName} did not reach ACTIVE status within ${maxAttempts} seconds`);
  }

  /**
   * Poll `DescribeTable` until the table leaves `UPDATING`. Distinct from
   * `waitForTableActive` because `UpdateTable` transitions the table to
   * `UPDATING` (not `CREATING`), so a status mismatch must keep polling
   * rather than throw, and the call may return immediately ACTIVE.
   *
   * The 60-attempt (60s) default was calibrated on capacity / TTL / tag edits,
   * which settle in seconds. A **BillingMode flip does not** — measured
   * 2026-08-11 on the `dynamodb-ondemand` fixture, a PAY_PER_REQUEST ->
   * PROVISIONED flip exceeded 60s and failed the deploy with
   * `did not reach ACTIVE status within 60 seconds`, rolling the whole stack
   * back. It was invisible before issue #1553 because the removal that
   * triggers the flip never produced a valid `UpdateTable` at all; making the
   * call correct is what put a real flip on this path.
   *
   * So the timeout is per-OPERATION rather than global: a flip gets 600s (the
   * same order as the GlobalTable provider's own settle waits), everything
   * else keeps the 60s that has been sufficient for two years of integs. A
   * blanket raise would turn every genuinely wedged capacity edit into a
   * 10-minute hang.
   */
  private async waitForTableActiveAfterUpdate(
    tableName: string,
    maxAttempts = TABLE_ACTIVE_WAIT_ATTEMPTS
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const status = response.Table?.TableStatus;
      if (status === 'ACTIVE') {
        return;
      }
      // Sleep between polls; tolerate any non-terminal status (UPDATING,
      // and defensively CREATING / others) — we just wait for ACTIVE.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Table ${tableName} did not reach ACTIVE status within ${maxAttempts} seconds after UpdateTable`
    );
  }

  /**
   * Poll DescribeTable until the table is ACTIVE AND every Global Secondary
   * Index is ACTIVE (not CREATING / UPDATING / DELETING / BACKFILLING). Used
   * between GSI mutations because a freshly-created index keeps backfilling
   * after the table itself returns to ACTIVE, and AWS rejects the next GSI op
   * until the prior index settles.
   */
  private async waitForTableAndIndexesActive(tableName: string, maxAttempts = 1800): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const table = response.Table;
      const tableActive = table?.TableStatus === 'ACTIVE';
      const indexesActive = (table?.GlobalSecondaryIndexes ?? []).every(
        (gsi) => gsi.IndexStatus === 'ACTIVE'
      );
      if (tableActive && indexesActive) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Table ${tableName} and its global secondary indexes did not reach ACTIVE within ${maxAttempts} seconds after UpdateTable`
    );
  }

  /**
   * Apply Global Secondary Index add / remove / per-index throughput changes
   * via UpdateTable's `GlobalSecondaryIndexUpdates`.
   *
   * AWS constraints mirrored here:
   *  - At most ONE GSI Create or Delete per UpdateTable call; a second
   *    mutation while the table / an index is still building is rejected. Each
   *    op therefore runs in its own UpdateTable and waits for ACTIVE before the
   *    next (creating GSIs also go through a BACKFILLING phase that ACTIVE
   *    covers).
   *  - A GSI `Create` must carry the AttributeDefinitions for the new index's
   *    key attributes — the full desired AttributeDefinitions array is passed
   *    so every newly-referenced attribute is defined.
   *  - On an existing same-name index, only a PROVISIONED `ProvisionedThroughput`
   *    (RCU/WCU) change is mutable in place and is issued as an `Update`. A
   *    `KeySchema` / `Projection` change is immutable in place (AWS models it as
   *    a delete + re-create); since the diff keys GSIs by name it would not emit
   *    a remove-then-add pair, so this method throws on such a change rather than
   *    silently dropping it.
   */
  private async applyGsiUpdates(
    physicalId: string,
    resourceType: string,
    logicalId: string,
    previousGsis: GlobalSecondaryIndex[] | undefined,
    desiredGsis: GlobalSecondaryIndex[] | undefined,
    desiredAttributeDefinitions: AttributeDefinition[] | undefined,
    // Names whose capacity the BillingMode flip already delivered in its own
    // UpdateTable. Their throughput Update MUST be skipped here — AWS rejects a
    // capacity change that equals the current value, so re-asserting it fails
    // the deploy outright. Only the throughput arm is suppressed: an index that
    // was ADDED or REMOVED in the same deploy still needs its own op.
    handledByBillingFlip: ReadonlySet<string> = new Set<string>(),
    // The index names AWS actually has right now (issue #1617). A Delete is
    // emitted only for a name in this set, which makes the removal arm
    // IDEMPOTENT — covering both the indexes the pre-flip removal just deleted
    // (a second Delete would fail with `ResourceNotFoundException`) and the
    // pre-existing case of a state record naming an index that is already gone
    // in AWS, which otherwise fails every deploy forever because cdkd only
    // writes state after a SUCCESSFUL update.
    //
    // `undefined` means "no live snapshot to reason from" and disables the
    // filter, so a caller without a DescribeTable result keeps the original
    // behavior rather than silently skipping every removal.
    liveIndexNames?: ReadonlySet<string>
  ): Promise<void> {
    const prev = previousGsis ?? [];
    const desired = desiredGsis ?? [];
    const prevByName = new Map(prev.filter((g) => g.IndexName).map((g) => [g.IndexName!, g]));
    const desiredByName = new Map(desired.filter((g) => g.IndexName).map((g) => [g.IndexName!, g]));

    // Each entry is a single GlobalSecondaryIndexUpdates op applied in its own
    // UpdateTable call. Deletes first (free up the one-op-per-call budget and
    // any attribute no longer needed), then creates, then throughput updates.
    const ops: GlobalSecondaryIndexUpdate[] = [];

    for (const name of prevByName.keys()) {
      if (desiredByName.has(name)) continue;
      if (liveIndexNames !== undefined && !liveIndexNames.has(name)) {
        this.logger.debug(
          `GSI ${name} is recorded in cdkd state but not live on DynamoDB table ${physicalId}; ` +
            `skipping its Delete (already removed)`
        );
        continue;
      }
      ops.push({ Delete: { IndexName: name } });
    }

    for (const [name, gsi] of desiredByName) {
      if (!prevByName.has(name)) {
        if (!gsi.KeySchema) {
          throw new ProvisioningError(
            `GlobalSecondaryIndex ${name} on DynamoDB table ${logicalId} is missing KeySchema`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        ops.push({
          Create: {
            IndexName: name,
            KeySchema: gsi.KeySchema,
            Projection: gsi.Projection,
            ...(gsi.ProvisionedThroughput
              ? { ProvisionedThroughput: gsi.ProvisionedThroughput }
              : {}),
            ...(gsi.OnDemandThroughput ? { OnDemandThroughput: gsi.OnDemandThroughput } : {}),
          },
        });
      } else {
        const before = prevByName.get(name)!;
        // A same-name index's KeySchema / Projection are immutable in place —
        // AWS models such a change as a delete + re-create of the index. cdkd's
        // diff keys GSIs by name, so it would NOT emit a remove-then-add pair
        // for an in-place key/projection edit; applying only a throughput Update
        // (or nothing) would silently drop the change and record state as if it
        // applied. Fail loud instead (the no-silent-drop rule) so the user
        // renames the index (forcing remove + add) or accepts a table replace.
        if (
          JSON.stringify(before.KeySchema) !== JSON.stringify(gsi.KeySchema) ||
          JSON.stringify(before.Projection) !== JSON.stringify(gsi.Projection)
        ) {
          throw new ProvisioningError(
            `GlobalSecondaryIndex ${name} on DynamoDB table ${logicalId} changed its ` +
              `KeySchema or Projection, which DynamoDB cannot modify in place. Rename the ` +
              `index (so it is dropped and re-created) or replace the table.`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        // Only ProvisionedThroughput is mutable in place on an existing index.
        // A numeric RCU/WCU change on a PROVISIONED GSI is issued as an Update;
        // a PROVISIONED->on-demand per-index drop is driven by the table-wide
        // BillingMode switch (handled above), not here.
        if (
          gsi.ProvisionedThroughput &&
          !handledByBillingFlip.has(name) &&
          JSON.stringify(before.ProvisionedThroughput) !== JSON.stringify(gsi.ProvisionedThroughput)
        ) {
          ops.push({
            Update: { IndexName: name, ProvisionedThroughput: gsi.ProvisionedThroughput },
          });
        }
      }
    }

    await this.runGsiOps(physicalId, ops, desiredAttributeDefinitions);
  }

  /**
   * Issue a list of `GlobalSecondaryIndexUpdates` ops, one per `UpdateTable`,
   * waiting for the table AND every index to return to ACTIVE between each.
   *
   * Extracted from {@link applyGsiUpdates} so the pre-flip GSI removal (issue
   * #1617) drives the identical call + wait sequence rather than a second copy
   * of it — the wait is what makes the next op (there, the BillingMode flip)
   * legal.
   */
  private async runGsiOps(
    physicalId: string,
    ops: GlobalSecondaryIndexUpdate[],
    desiredAttributeDefinitions: AttributeDefinition[] | undefined
  ): Promise<void> {
    for (const op of ops) {
      const input: UpdateTableCommandInput = {
        TableName: physicalId,
        GlobalSecondaryIndexUpdates: [op],
      };
      // A Create references new key attributes, so it must include their
      // definitions. Forward the full desired set (AWS ignores already-known
      // attribute definitions and validates that every indexed attribute is
      // present).
      if (op.Create && desiredAttributeDefinitions) {
        input.AttributeDefinitions = desiredAttributeDefinitions;
      }
      await this.dynamoDBClient.send(new UpdateTableCommand(input));
      // GSI create/delete is async: the table returns to ACTIVE quickly while a
      // new index is still CREATING -> BACKFILLING. AWS rejects the next GSI op
      // until every index is fully ACTIVE, and CloudFormation likewise waits for
      // the index to finish before completing — so wait on BOTH the table and
      // every GSI status, not just the table.
      await this.waitForTableAndIndexesActive(physicalId);
      const verb = op.Create ? 'created' : op.Delete ? 'deleted' : 'updated';
      this.logger.debug(
        `${verb} GSI ${op.Create?.IndexName ?? op.Delete?.IndexName ?? op.Update?.IndexName} on DynamoDB table ${physicalId}`
      );
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing DynamoDB table.
   *
   * CloudFormation's `AWS::DynamoDB::Table` exposes `Arn`, `StreamArn`
   * (a.k.a. `LatestStreamArn` in the SDK; CFn returns the latest enabled
   * stream's ARN), and `LatestStreamLabel`. All three are sibling fields on
   * the same `DescribeTable` response, so a single API call covers every
   * supported attr. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#aws-resource-dynamodb-table-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      switch (attributeName) {
        case 'Arn':
          return resp.Table?.TableArn;
        case 'StreamArn':
          return resp.Table?.LatestStreamArn;
        case 'LatestStreamLabel':
          return resp.Table?.LatestStreamLabel;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read the AWS-current DynamoDB table configuration in CFn-property shape.
   *
   * `DescribeTable` returns every field cdkd manages in one call. AWS uses
   * the same property names CFn does (KeySchema, AttributeDefinitions,
   * BillingModeSummary.BillingMode, ProvisionedThroughput, etc.) — the only
   * shape differences are wrapping:
   *  - BillingMode lives under `BillingModeSummary.BillingMode` in the API
   *    response, but the CFn property is a flat `BillingMode` string.
   *  - StreamSpecification's CFn shape includes only `StreamViewType`; the
   *    API response carries `StreamEnabled` too. We surface both since the
   *    drift comparator only descends into keys present in state.
   *  - GSI / LSI in the API response include `IndexStatus`, `ItemCount` and
   *    sizing fields that cdkd never sets; the comparator filters them.
   *
   * Returns `undefined` when the table is gone (`ResourceNotFoundException`).
   *
   * Tags are surfaced via a follow-up `ListTagsOfResource` call (DynamoDB
   * doesn't include tags in `DescribeTable`). CDK's `aws:*` auto-tags are
   * filtered out by `normalizeAwsTagsToCfn` so they don't fire false-positive
   * drift, and the result key is omitted entirely when AWS reports no user
   * tags (matches `create()`'s behavior of only sending Tags when the
   * template carries them).
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
      if (table.BillingModeSummary?.BillingMode) {
        result['BillingMode'] = table.BillingModeSummary.BillingMode;
      }
      if (table.ProvisionedThroughput) {
        // AWS returns extra read-only fields (LastIncrease/DecreaseDateTime,
        // NumberOfDecreasesToday) — drop them to keep the snapshot tight.
        result['ProvisionedThroughput'] = {
          ReadCapacityUnits: table.ProvisionedThroughput.ReadCapacityUnits,
          WriteCapacityUnits: table.ProvisionedThroughput.WriteCapacityUnits,
        };
      }
      // OnDemandThroughput — DescribeTable returns it only on PAY_PER_REQUEST
      // tables that set capacity caps. Emit-when-present (no default when
      // absent) so a table that never configured caps doesn't grow a
      // placeholder that would round-trip through update() as a spurious
      // UpdateTable.
      if (table.OnDemandThroughput) {
        const odt: Record<string, unknown> = {};
        if (table.OnDemandThroughput.MaxReadRequestUnits !== undefined) {
          odt['MaxReadRequestUnits'] = table.OnDemandThroughput.MaxReadRequestUnits;
        }
        if (table.OnDemandThroughput.MaxWriteRequestUnits !== undefined) {
          odt['MaxWriteRequestUnits'] = table.OnDemandThroughput.MaxWriteRequestUnits;
        }
        if (Object.keys(odt).length > 0) {
          result['OnDemandThroughput'] = odt;
        }
      }
      // WarmThroughput — DescribeTable returns it (as a
      // TableWarmThroughputDescription carrying ReadUnitsPerSecond /
      // WriteUnitsPerSecond / Status) only on tables that set warm
      // throughput. Emit-when-present (no default when absent) and surface
      // ONLY the user-settable sub-fields — Status is AWS-managed — so a
      // table that never configured warm throughput doesn't grow a
      // placeholder that would round-trip through update() as a spurious
      // UpdateTable.
      if (table.WarmThroughput) {
        const wt: Record<string, unknown> = {};
        if (table.WarmThroughput.ReadUnitsPerSecond !== undefined) {
          wt['ReadUnitsPerSecond'] = table.WarmThroughput.ReadUnitsPerSecond;
        }
        if (table.WarmThroughput.WriteUnitsPerSecond !== undefined) {
          wt['WriteUnitsPerSecond'] = table.WarmThroughput.WriteUnitsPerSecond;
        }
        if (Object.keys(wt).length > 0) {
          result['WarmThroughput'] = wt;
        }
      }
      // Class 1 guard: StreamSpecification.StreamViewType is only valid when
      // a stream is enabled. AWS returns the StreamSpecification block on
      // tables that USED TO have a stream (StreamEnabled: false, no
      // StreamViewType) — emitting that placeholder back through a
      // round-trip drift --revert would push a CFn-invalid shape (a
      // StreamSpecification without StreamViewType is rejected). Only
      // surface the block when the stream is actually enabled.
      if (table.StreamSpecification?.StreamEnabled && table.StreamSpecification.StreamViewType) {
        result['StreamSpecification'] = {
          StreamEnabled: true,
          StreamViewType: table.StreamSpecification.StreamViewType,
        };
      }
      // Class 2 guard: GSI / LSI placeholders. AWS omits these blocks when
      // none exist; the previous `?? []` always-emitted an empty array
      // which round-trips through `update()` as an instruction to "remove
      // all GSIs", and on the LSI side LSIs are immutable post-create so
      // the empty-array placeholder is a guaranteed AWS rejection on any
      // future provider.update() that learns to handle the field. Only
      // surface when AWS reports indexes.
      if (table.GlobalSecondaryIndexes && table.GlobalSecondaryIndexes.length > 0) {
        result['GlobalSecondaryIndexes'] = table.GlobalSecondaryIndexes;
      }
      if (table.LocalSecondaryIndexes && table.LocalSecondaryIndexes.length > 0) {
        result['LocalSecondaryIndexes'] = table.LocalSecondaryIndexes;
      }
      // Class 1 guard: CFn's SSESpecification.KMSMasterKeyId / SSEType are
      // only valid when SSEEnabled=true. AWS reports SSEDescription.Status
      // = 'DISABLED' (or omits SSEDescription entirely) on tables without
      // SSE; the previous always-emit `{ SSEEnabled: false }` placeholder
      // round-trips fine when state matches but breaks the moment a
      // future SSE-aware update() learns to read `SSESpecification` —
      // `{ SSEEnabled: false, KMSMasterKeyId: '...' }` is rejected by
      // AWS. Only surface the block when SSE is actually enabled.
      if (table.SSEDescription?.Status === 'ENABLED') {
        const sse: Record<string, unknown> = { SSEEnabled: true };
        if (table.SSEDescription.KMSMasterKeyArn !== undefined) {
          sse['KMSMasterKeyId'] = table.SSEDescription.KMSMasterKeyArn;
        }
        if (table.SSEDescription.SSEType !== undefined) {
          sse['SSEType'] = table.SSEDescription.SSEType;
        }
        result['SSESpecification'] = sse;
      }
      if (table.DeletionProtectionEnabled !== undefined) {
        result['DeletionProtectionEnabled'] = table.DeletionProtectionEnabled;
      }
      if (table.TableClassSummary?.TableClass) {
        result['TableClass'] = table.TableClassSummary.TableClass;
      }

      // Tags via ListTagsOfResource — needs the table ARN we just got back.
      if (table.TableArn) {
        try {
          const tagsResp = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: table.TableArn })
          );
          const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
          result['Tags'] = tags;
        } catch (err) {
          // Tag fetch failures shouldn't tank the whole drift read; rethrow
          // only on hard "table gone" semantics.
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        }
      }

      // PointInTimeRecoverySpecification — separate DescribeContinuousBackups
      // call (not part of DescribeTable). Emit-when-present: only surface the
      // key when AWS reports a PITR status so a table that never configured
      // PITR doesn't grow a placeholder (keeps the comparator's state-keys-only
      // top-level walk + the "AWS minimum response" key-set test green).
      // Best-effort: a failed read omits the key rather than failing the
      // whole drift read.
      try {
        const pitrResp = await this.dynamoDBClient.send(
          new DescribeContinuousBackupsCommand({ TableName: physicalId })
        );
        const pitrDesc = pitrResp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
        const pitrStatus = pitrDesc?.PointInTimeRecoveryStatus;
        if (pitrStatus) {
          const pitr: Record<string, unknown> = {
            PointInTimeRecoveryEnabled: pitrStatus === 'ENABLED',
          };
          // RecoveryPeriodInDays is only meaningful while enabled; surface it
          // emit-when-present so a templated value is drift-comparable.
          if (pitrStatus === 'ENABLED' && pitrDesc?.RecoveryPeriodInDays !== undefined) {
            pitr['RecoveryPeriodInDays'] = pitrDesc.RecoveryPeriodInDays;
          }
          result['PointInTimeRecoverySpecification'] = pitr;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read PointInTimeRecovery for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // TimeToLiveSpecification — separate DescribeTimeToLive call.
      // Race-tolerant: only surface when AWS reports `ENABLED` with an
      // AttributeName. `DISABLED` carries no AttributeName and CFn rejects a
      // TimeToLiveSpecification without one, so we omit it; ENABLING /
      // DISABLING are transient and also omitted so drift doesn't fire on a
      // momentary state.
      try {
        const ttlResp = await this.dynamoDBClient.send(
          new DescribeTimeToLiveCommand({ TableName: physicalId })
        );
        const ttlDesc = ttlResp.TimeToLiveDescription;
        if (ttlDesc?.TimeToLiveStatus === 'ENABLED' && ttlDesc.AttributeName) {
          result['TimeToLiveSpecification'] = {
            AttributeName: ttlDesc.AttributeName,
            Enabled: true,
          };
        }
      } catch (err) {
        this.logger.debug(
          `Could not read TimeToLive for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ResourcePolicy — separate GetResourcePolicy call. Emit-when-present:
      // only surface the key when AWS reports an attached policy, and re-shape
      // the returned JSON string back into CFn's `{ PolicyDocument: <object> }`
      // form so it is drift-comparable against the templated value. A table
      // with no policy returns ResourceNotFoundException / PolicyNotFound —
      // omit the key rather than fail the whole drift read.
      if (table.TableArn) {
        try {
          const rpResp = await this.dynamoDBClient.send(
            new GetResourcePolicyCommand({ ResourceArn: table.TableArn })
          );
          if (rpResp.Policy) {
            let doc: unknown = rpResp.Policy;
            try {
              doc = JSON.parse(rpResp.Policy);
            } catch {
              // Leave as the raw string if AWS returned a non-JSON body.
            }
            result['ResourcePolicy'] = { PolicyDocument: doc };
          }
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) {
            this.logger.debug(
              `Could not read ResourcePolicy for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      // KinesisStreamSpecification — separate DescribeKinesisStreamingDestination
      // call. Emit-when-present: only surface the key when AWS reports an ACTIVE
      // or ENABLING destination (DISABLED entries linger in the list, so a
      // status filter avoids a stale placeholder). Surface only the user-set
      // fields (StreamArn + precision) so the drift comparator can match the
      // templated value.
      try {
        const kResp = await this.dynamoDBClient.send(
          new DescribeKinesisStreamingDestinationCommand({ TableName: physicalId })
        );
        const active = (kResp.KinesisDataStreamDestinations ?? []).find(
          (d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING'
        );
        if (active?.StreamArn) {
          const kspec: Record<string, unknown> = { StreamArn: active.StreamArn };
          if (active.ApproximateCreationDateTimePrecision !== undefined) {
            kspec['ApproximateCreationDateTimePrecision'] =
              active.ApproximateCreationDateTimePrecision;
          }
          result['KinesisStreamSpecification'] = kspec;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read KinesisStreamingDestination for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ContributorInsightsSpecification — separate DescribeContributorInsights
      // call. Emit-when-present: only surface the key when AWS reports a
      // terminal ENABLED / DISABLED status (ENABLING / DISABLING are transient
      // and omitted so drift doesn't fire on a momentary state). Surface
      // `Mode` only while ENABLED so a disabled table doesn't grow a CFn-invalid
      // placeholder.
      try {
        const ciResp = await this.dynamoDBClient.send(
          new DescribeContributorInsightsCommand({ TableName: physicalId })
        );
        const status = ciResp.ContributorInsightsStatus;
        if (status === 'ENABLED' || status === 'DISABLED') {
          const cspec: Record<string, unknown> = { Enabled: status === 'ENABLED' };
          if (status === 'ENABLED' && ciResp.ContributorInsightsMode !== undefined) {
            cspec['Mode'] = ciResp.ContributorInsightsMode;
          }
          result['ContributorInsightsSpecification'] = cspec;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read ContributorInsights for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing DynamoDB table into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.TableName` → verify via `DescribeTable`.
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
}
