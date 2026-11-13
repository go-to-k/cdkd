import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTagsOfResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { WARM_THROUGHPUT_MEMBERS, coerceWarmThroughput } from '../../dynamodb-warm-throughput.js';
import { readbackVectorIndexes } from '../../dynamodb-vector-indexes.js';
import {
  RESOURCE_NOT_FOUND,
  type ResourceNotFound,
  type ResourceIdentityVerdict,
  type ReadCurrentStateContext,
} from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { injectiveKey } from '../../../state/record-keys.js';
import {
  isTableName,
  projectNamed,
  strictReadScope,
  strictFor,
  replicaStrictness,
  type UnnamedLiveEntry,
} from './projection.js';
import {
  DISASSOCIATION_PROTECTION_KEY,
  localReplicaEntry,
  TABLE_READ_ON_DEMAND_KEY,
  TABLE_READ_PROVISIONED_KEY,
} from './replica-shape.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

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
export async function isSameResource(
  this: DynamoDBGlobalTableProvider,
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
export async function resourceIdentity(
  this: DynamoDBGlobalTableProvider,
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
export async function readTableIdIfExists(
  this: DynamoDBGlobalTableProvider,
  tableName: string
): Promise<string | undefined> {
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
export async function getAttribute(
  this: DynamoDBGlobalTableProvider,
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
export async function readUnsettled(
  this: DynamoDBGlobalTableProvider,
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
      safeMsg`${logicalId} (${resourceType}): ${entry.path} on AWS has entries cdkd cannot key by an identity, so convergence keeps the recorded ${entry.path} rather than risk removing an entry neither the record nor the template declares. Check it with ${proseQuoted(cdkdRemedy('cdkd drift'))}.`
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
export async function unsettledInTransition(
  this: DynamoDBGlobalTableProvider,
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
export async function readCurrentState(
  this: DynamoDBGlobalTableProvider,
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
          let regionalRead: number | undefined;
          if (isLocal) {
            regionalRead = table.ProvisionedThroughput?.ReadCapacityUnits;
            protection = table.DeletionProtectionEnabled;
            disassociationProtection = table.DisassociationProtectionEnabled;
            streamArn = table.LatestStreamArn;
          } else {
            try {
              const regional = await client.send(
                new DescribeTableCommand({ TableName: tableNameForSubs })
              );
              regionalRead = regional.Table?.ProvisionedThroughput?.ReadCapacityUnits;
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
          // When autoscaling owns the replica's read dimension the full
          // settings shape is surfaced. Otherwise the plain read omits the key
          // (drift will not fire on a missing key, matching the pre-#395
          // behavior for non-autoscaled replicas), and only the strict read
          // of an unsettled `Replicas` reports the flat read below, from the
          // region's own `DescribeTable`.
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
            } else if (strictFor('Replicas') && regionalRead !== undefined) {
              // go-to-k/cdkd#5604: an unsettled `Replicas` has to read what was
              // sent, or it never settles and every deploy sends it again. Only
              // there: the plain read stays free of a value drift would compare.
              entry['ReadProvisionedThroughputSettings'] = { ReadCapacityUnits: regionalRead };
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
