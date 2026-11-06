import {
  DescribeTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PolicyNotFoundException,
  ResourceNotFoundException,
  type Tag,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  CONTRIBUTOR_INSIGHTS_KEY,
  indexDeclaresContributorInsights,
  reverseMapIndexContributorInsights,
  reverseMapTableContributorInsights,
} from '../../dynamodb-contributor-insights.js';
import {
  STREAM_POLICY_KEY,
  STREAM_TAGS_KEY,
  declaredStreamPolicyMember,
  declaredStreamTagsMember,
  reverseMapStreamPolicy,
  streamDeclaresPolicy,
  streamDeclaresTags,
  streamPolicyMatchesDeclared,
  streamTagsMatchDeclared,
} from '../../dynamodb-stream-members.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  isTransientServerError,
} from '../../../deployment/retryable-errors.js';
import type { ReadCurrentStateContext, ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { readbackVectorIndexes } from '../../dynamodb-vector-indexes.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { desiredIndexEntriesByName, reverseMapSecondaryIndex } from './indexes.js';
import {
  declaresWarmThroughput,
  desiredBagIsInformative,
  readbackWarmThroughput,
  sentWarmThroughputMembers,
} from './warm-throughput.js';

/**
 * A stream-member read failure worth keeping the declared member over (issue
 * #4112): a throttle, a 5xx, a socket failure, or `ResourceNotFoundException` on a stream arn
 * the write just addressed. Deliberately NOT `isRetryableTransientError`,
 * whose message patterns count `not authorized to perform` as IAM propagation:
 * a role that can put but never read would then freeze a member every drift
 * read drops.
 */
export function isTransientStreamReadFailure(err: unknown): boolean {
  return (
    isThrottlingError(err) ||
    isTransientServerError(err) ||
    // A socket reset / timeout the SDK's own retries did not absorb.
    isAmbiguousOutcomeError(err) ||
    err instanceof ResourceNotFoundException
  );
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
 *  - StreamSpecification's CFn shape is `StreamViewType`, `ResourcePolicy`
 *    and `Tags`; the API response carries `StreamEnabled` and
 *    `StreamViewType` only. `StreamEnabled` is surfaced too, since the
 *    comparator descends a `properties` baseline by the keys state holds.
 *    `ResourcePolicy` / `Tags` (issue #3458) live on the STREAM arn and are
 *    read from it, each only when the desired block declares that member.
 *  - GSI / LSI in the API response include `IndexStatus`, `Backfilling`,
 *    `ItemCount`, `IndexArn` and sizing fields cdkd never sets. They used to
 *    be forwarded VERBATIM under a comment claiming "the comparator filters
 *    them" — it does NOT, and issue #1767 quotes that sentence as the bug:
 *    the filter is `calculateResourceDrift`'s state-keys-only walk, which
 *    only reaches an absent TOP-LEVEL key. These are members of an array
 *    under a key the baseline DOES carry, and arrays compare positionally,
 *    so every AWS-managed member participated — and `ItemCount` MOVES as
 *    data lands, so an in-use table with any index drifted against its own
 *    `observedProperties` on the ORDINARY path, on a schedule set by its own
 *    write traffic. Each entry is now reverse-mapped to its CFn shape by
 *    {@link reverseMapSecondaryIndex}.
 *
 * Returns {@link RESOURCE_NOT_FOUND} when the table is gone
 * (`ResourceNotFoundException`, also when it disappears mid-read under
 * `ListTagsOfResource`); `undefined` only for an empty `DescribeTable` body.
 *
 * Tags are surfaced via a follow-up `ListTagsOfResource` call (DynamoDB
 * doesn't include tags in `DescribeTable`). CDK's `aws:*` auto-tags are
 * filtered out by `normalizeAwsTagsToCfn` so they don't fire false-positive
 * drift, and the result key is omitted entirely when AWS reports no user
 * tags (matches `create()`'s behavior of only sending Tags when the
 * template carries them).
 *
 * `properties` is the DESIRED bag (the state-recorded template intent every
 * caller passes). It is consulted for the table-level `WarmThroughput` — see
 * {@link getDriftUnknownPaths} for the measurement and the reasoning — and,
 * since issue #1767, for the per-index throughput blocks of each secondary
 * index, matched by `IndexName`. Since issue #1782 it also gates the per-index
 * `ContributorInsightsSpecification` read, which costs one
 * `DescribeContributorInsights` per declaring index.
 */
export async function readCurrentState(
  this: DynamoDBTableProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
    // WriteUnitsPerSecond / Status) for EVERY table, not only for one that
    // set warm throughput: measured us-east-1 2026-08-13, a CreateTable
    // declaring none read back {ReadUnitsPerSecond: 12000,
    // WriteUnitsPerSecond: 4000, Status: 'ACTIVE'} (issue #1760). So the
    // emit is gated on the DESIRED bag declaring the property — a blanket
    // drop would hide a real change for a template that sets one, and an
    // ungated emit freezes an AWS-computed, AWS-owned value into the
    // observedProperties baseline, which `drift --revert` then re-sends
    // through update() as a spurious (and, once AWS has grown the value,
    // rejected) UpdateTable. An absent / empty bag keeps the pre-#1760
    // behavior, since the caller supplied nothing to decide with.
    // Surface ONLY the user-settable sub-fields — Status is AWS-managed —
    // and of those only the members cdkd SENT (issue #3777).
    if (table.WarmThroughput && declaresWarmThroughput(properties)) {
      const informative = properties !== undefined && desiredBagIsInformative(properties);
      const wt = readbackWarmThroughput(
        table.WarmThroughput,
        informative ? sentWarmThroughputMembers(properties['WarmThroughput']) : undefined,
        informative ? properties['WarmThroughput'] : undefined
      );
      if (wt !== undefined) result['WarmThroughput'] = wt;
    }
    // Class 1 guard: StreamSpecification.StreamViewType is only valid when
    // a stream is enabled. AWS returns the StreamSpecification block on
    // tables that USED TO have a stream (StreamEnabled: false, no
    // StreamViewType) — emitting that placeholder back through a
    // round-trip drift --revert would push a CFn-invalid shape (a
    // StreamSpecification without StreamViewType is rejected). Only
    // surface the block when the stream is actually enabled.
    // Every read below depends only on `DescribeTable`, so they run
    // concurrently: a deploy waits for this capture after its last resource,
    // where a serial chain was ~1.5s of a 5-resource stack's tail. Each
    // answer is placed into `result` afterwards in the original key order.
    let streamMembersRead: Promise<void> = Promise.resolve();
    if (table.StreamSpecification?.StreamEnabled && table.StreamSpecification.StreamViewType) {
      const streamBlock: Record<string, unknown> = {
        StreamEnabled: true,
        StreamViewType: table.StreamSpecification.StreamViewType,
      };
      result['StreamSpecification'] = streamBlock;
      streamMembersRead = this.readStreamMembers(
        physicalId,
        table.LatestStreamArn,
        properties?.['StreamSpecification'],
        streamBlock,
        context?.afterOwnWrite === true
      );
    }
    // Class 2 guard: GSI / LSI placeholders. AWS omits these blocks when
    // none exist; the previous `?? []` always-emitted an empty array
    // which round-trips through `update()` as an instruction to "remove
    // all GSIs", and on the LSI side LSIs are immutable post-create so
    // the empty-array placeholder is a guaranteed AWS rejection on any
    // future provider.update() that learns to handle the field. Only
    // surface when AWS reports indexes.
    //
    // Each entry is REVERSE-MAPPED to its CFn shape rather than forwarded
    // verbatim (issue #1767) — see {@link reverseMapSecondaryIndex} for the
    // measured description and the per-block gates.
    const bagInformative = desiredBagIsInformative(properties);
    if (table.GlobalSecondaryIndexes && table.GlobalSecondaryIndexes.length > 0) {
      const desiredByName = desiredIndexEntriesByName(properties?.['GlobalSecondaryIndexes']);
      result['GlobalSecondaryIndexes'] = table.GlobalSecondaryIndexes.map((live) =>
        reverseMapSecondaryIndex(
          live,
          live.IndexName === undefined ? undefined : desiredByName.get(live.IndexName),
          bagInformative
        )
      );
    }
    if (table.LocalSecondaryIndexes && table.LocalSecondaryIndexes.length > 0) {
      const desiredByName = desiredIndexEntriesByName(properties?.['LocalSecondaryIndexes']);
      result['LocalSecondaryIndexes'] = table.LocalSecondaryIndexes.map((live) =>
        reverseMapSecondaryIndex(
          live,
          live.IndexName === undefined ? undefined : desiredByName.get(live.IndexName),
          bagInformative
        )
      );
    }
    // go-to-k/cdkd#2762: VectorIndexes in their CFn shape, only when AWS
    // reports any (no `[]` placeholder, the GSI / LSI reason above).
    const liveVectorIndexes = readbackVectorIndexes(table.VectorIndexes);
    if (liveVectorIndexes !== undefined) result['VectorIndexes'] = liveVectorIndexes;
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

    const tableArn = table.TableArn;
    const [tags, pitr, ttl, resourcePolicy, kinesis, contributorInsights] = await Promise.all([
      // Tags via ListTagsOfResource — needs the table ARN we just got back.
      tableArn ? this.readTableTags(tableArn) : Promise.resolve(undefined),
      this.readPointInTimeRecovery(physicalId),
      this.readTimeToLive(physicalId),
      tableArn ? this.readTableResourcePolicy(physicalId, tableArn) : Promise.resolve(undefined),
      this.readKinesisStreamSpecification(physicalId),
      this.readTableContributorInsights(physicalId),
      this.readIndexContributorInsights(physicalId, result, properties, bagInformative),
      streamMembersRead,
    ]);
    // Tag fetch failures shouldn't tank the whole drift read; a table gone
    // under ListTagsOfResource is gone.
    if (tags === RESOURCE_NOT_FOUND) return RESOURCE_NOT_FOUND;
    if (tags !== undefined) result['Tags'] = tags;
    if (pitr !== undefined) result['PointInTimeRecoverySpecification'] = pitr;
    if (ttl !== undefined) result['TimeToLiveSpecification'] = ttl;
    if (resourcePolicy !== undefined) result['ResourcePolicy'] = resourcePolicy;
    if (kinesis !== undefined) result['KinesisStreamSpecification'] = kinesis;
    if (contributorInsights !== undefined) {
      result['ContributorInsightsSpecification'] = contributorInsights;
    }

    return result;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * `Tags` for {@link readCurrentState}. CDK's `aws:*` auto-tags are dropped
 * by `normalizeAwsTagsToCfn`. A vanished table answers
 * {@link RESOURCE_NOT_FOUND}; any other failure throws.
 */
export async function readTableTags(
  this: DynamoDBTableProvider,
  tableArn: string
): Promise<ReturnType<typeof normalizeAwsTagsToCfn> | ResourceNotFound> {
  try {
    const tagsResp = await this.dynamoDBClient.send(
      new ListTagsOfResourceCommand({ ResourceArn: tableArn })
    );
    return normalizeAwsTagsToCfn(tagsResp.Tags);
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * `PointInTimeRecoverySpecification` — separate DescribeContinuousBackups
 * call (not part of DescribeTable). Emit-when-present: only surface the key
 * when AWS reports a PITR status so a table that never configured PITR
 * doesn't grow a placeholder (keeps the comparator's state-keys-only
 * top-level walk + the "AWS minimum response" key-set test green).
 * Best-effort: a failed read omits the key rather than failing the whole
 * drift read.
 */
export async function readPointInTimeRecovery(
  this: DynamoDBTableProvider,
  physicalId: string,
  strict = false
): Promise<Record<string, unknown> | undefined> {
  try {
    const pitrResp = await this.dynamoDBClient.send(
      new DescribeContinuousBackupsCommand({ TableName: physicalId })
    );
    const pitrDesc = pitrResp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
    const pitrStatus = pitrDesc?.PointInTimeRecoveryStatus;
    if (!pitrStatus) return undefined;
    const pitr: Record<string, unknown> = {
      PointInTimeRecoveryEnabled: pitrStatus === 'ENABLED',
    };
    // RecoveryPeriodInDays is only meaningful while enabled; surface it
    // emit-when-present so a templated value is drift-comparable.
    if (pitrStatus === 'ENABLED' && pitrDesc?.RecoveryPeriodInDays !== undefined) {
      pitr['RecoveryPeriodInDays'] = pitrDesc.RecoveryPeriodInDays;
    }
    return pitr;
  } catch (err) {
    if (strict) throw err;
    this.logger.debug(
      `Could not read PointInTimeRecovery for ${physicalId}: ${describeAwsFailure(err).detail}`
    );
    return undefined;
  }
}

/**
 * `TimeToLiveSpecification` — separate DescribeTimeToLive call.
 * Race-tolerant: only surface when AWS reports `ENABLED` with an
 * AttributeName. `DISABLED` carries no AttributeName and CFn rejects a
 * TimeToLiveSpecification without one, so we omit it; ENABLING / DISABLING
 * are transient and also omitted so drift doesn't fire on a momentary state.
 */
export async function readTimeToLive(
  this: DynamoDBTableProvider,
  physicalId: string,
  strict = false
): Promise<Record<string, unknown> | undefined> {
  try {
    const ttlResp = await this.dynamoDBClient.send(
      new DescribeTimeToLiveCommand({ TableName: physicalId })
    );
    const ttlDesc = ttlResp.TimeToLiveDescription;
    if (ttlDesc?.TimeToLiveStatus === 'ENABLED' && ttlDesc.AttributeName) {
      return { AttributeName: ttlDesc.AttributeName, Enabled: true };
    }
    return undefined;
  } catch (err) {
    if (strict) throw err;
    this.logger.debug(
      `Could not read TimeToLive for ${physicalId}: ${describeAwsFailure(err).detail}`
    );
    return undefined;
  }
}

/**
 * `ResourcePolicy` — separate GetResourcePolicy call. Emit-when-present:
 * only surface the key when AWS reports an attached policy, and re-shape the
 * returned JSON string back into CFn's `{ PolicyDocument: <object> }` form so
 * it is drift-comparable against the templated value. A table with no policy
 * returns ResourceNotFoundException / PolicyNotFound — omit the key rather
 * than fail the whole drift read.
 */
export async function readTableResourcePolicy(
  this: DynamoDBTableProvider,
  physicalId: string,
  tableArn: string,
  strict = false
): Promise<Record<string, unknown> | undefined> {
  try {
    const rpResp = await this.dynamoDBClient.send(
      new GetResourcePolicyCommand({ ResourceArn: tableArn })
    );
    if (!rpResp.Policy) return undefined;
    let doc: unknown = rpResp.Policy;
    try {
      doc = JSON.parse(rpResp.Policy);
    } catch {
      // Leave as the raw string if AWS returned a non-JSON body.
    }
    return { PolicyDocument: doc };
  } catch (err) {
    // A table with no policy answers PolicyNotFoundException: "not set",
    // strict or not, or an unsettled ResourcePolicy would refuse forever.
    if (
      strict &&
      !(err instanceof ResourceNotFoundException) &&
      !(err instanceof PolicyNotFoundException)
    ) {
      throw err;
    }
    if (!(err instanceof ResourceNotFoundException)) {
      this.logger.debug(
        `Could not read ResourcePolicy for ${physicalId}: ${describeAwsFailure(err).detail}`
      );
    }
    return undefined;
  }
}

/**
 * `KinesisStreamSpecification` — separate DescribeKinesisStreamingDestination
 * call. Emit-when-present: only surface the key when AWS reports an ACTIVE,
 * ENABLING or UPDATING destination (DISABLED entries linger in the list, so a
 * status filter avoids a stale placeholder; an UPDATING one is a precision
 * change in flight, go-to-k/cdkd#5385, and still streams). Surface only the user-set fields
 * (StreamArn + precision) so the drift comparator can match the templated
 * value.
 */
export async function readKinesisStreamSpecification(
  this: DynamoDBTableProvider,
  physicalId: string,
  strict = false
): Promise<Record<string, unknown> | undefined> {
  try {
    const kResp = await this.dynamoDBClient.send(
      new DescribeKinesisStreamingDestinationCommand({ TableName: physicalId })
    );
    const active = (kResp.KinesisDataStreamDestinations ?? []).find(
      (d) =>
        d.DestinationStatus === 'ACTIVE' ||
        d.DestinationStatus === 'ENABLING' ||
        d.DestinationStatus === 'UPDATING'
    );
    if (!active?.StreamArn) return undefined;
    const kspec: Record<string, unknown> = { StreamArn: active.StreamArn };
    if (active.ApproximateCreationDateTimePrecision !== undefined) {
      kspec['ApproximateCreationDateTimePrecision'] = active.ApproximateCreationDateTimePrecision;
    }
    return kspec;
  } catch (err) {
    if (strict) throw err;
    this.logger.debug(
      `Could not read KinesisStreamingDestination for ${physicalId}: ${describeAwsFailure(err).detail}`
    );
    return undefined;
  }
}

/**
 * `ContributorInsightsSpecification` — separate DescribeContributorInsights
 * call. Emit-when-present: only surface the key when AWS reports a terminal
 * ENABLED / DISABLED status (ENABLING / DISABLING are transient and omitted
 * so drift doesn't fire on a momentary state). Surface `Mode` only while
 * ENABLED so a disabled table doesn't grow a CFn-invalid placeholder.
 */
export async function readTableContributorInsights(
  this: DynamoDBTableProvider,
  physicalId: string,
  strict = false
): Promise<ReturnType<typeof reverseMapTableContributorInsights>> {
  try {
    const ciResp = await this.dynamoDBClient.send(
      new DescribeContributorInsightsCommand({ TableName: physicalId })
    );
    return reverseMapTableContributorInsights(
      ciResp.ContributorInsightsStatus,
      ciResp.ContributorInsightsMode
    );
  } catch (err) {
    if (strict) throw err;
    this.logger.debug(
      `Could not read ContributorInsights for ${physicalId}: ${describeAwsFailure(err).detail}`
    );
    return undefined;
  }
}

/**
 * Per-index ContributorInsightsSpecification (issue #1782) — the same call
 * with `IndexName`, since `DescribeTable`'s index description has no
 * counterpart. ONE API call per index, so it is GATED: only an index whose
 * DESIRED entry declares a block cdkd would send is read, which is also what
 * keeps the block out of every other entry — it sits inside an array entry
 * whose key set is compared exactly, so an ungated `{Enabled: false}` would
 * be one-sided drift on every index. An uninformative bag reads NOTHING (the
 * pre-#1782 answer). A failed read omits the block, like the table-level
 * read; a TRANSIENT status reads as its target instead
 * (`reverseMapIndexContributorInsights` says why). Writes into the entries
 * of `result.GlobalSecondaryIndexes` in place.
 */
export async function readIndexContributorInsights(
  this: DynamoDBTableProvider,
  physicalId: string,
  result: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  bagInformative: boolean
): Promise<void> {
  const emittedGsis = result['GlobalSecondaryIndexes'];
  if (!bagInformative || !Array.isArray(emittedGsis)) return;
  const desiredByName = desiredIndexEntriesByName(properties?.['GlobalSecondaryIndexes']);
  // One index after another, as before: up to 20 indexes, and a throttled
  // read drops its block from the baseline.
  for (const emitted of emittedGsis as Array<Record<string, unknown>>) {
    const indexName = emitted['IndexName'];
    if (typeof indexName !== 'string') continue;
    const desiredEntry = desiredByName.get(indexName);
    if (!indexDeclaresContributorInsights(desiredEntry)) continue;
    try {
      const indexResp = await this.dynamoDBClient.send(
        new DescribeContributorInsightsCommand({
          TableName: physicalId,
          IndexName: indexName,
        })
      );
      const block = reverseMapIndexContributorInsights(
        indexResp.ContributorInsightsStatus,
        indexResp.ContributorInsightsMode,
        desiredEntry?.[CONTRIBUTOR_INSIGHTS_KEY]
      );
      if (block !== undefined) emitted[CONTRIBUTOR_INSIGHTS_KEY] = block;
    } catch (err) {
      this.logger.debug(
        `Could not read ContributorInsights for index ${indexName} of ${physicalId}: ${describeAwsFailure(err).detail}`
      );
    }
  }
}

/** Run `read`, re-asking after each configured delay until `settled` accepts the answer. */
export async function reAskUntilSettled<T>(
  this: DynamoDBTableProvider,
  read: () => Promise<T>,
  settled: (answer: T) => boolean
): Promise<T> {
  let answer = await read();
  for (const delayMs of this.streamMemberRereadDelaysMs) {
    if (settled(answer)) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    answer = await read();
  }
  return answer;
}

/**
 * Read `StreamSpecification.ResourcePolicy` / `.Tags` (issue #3458) off the
 * table's CURRENT stream arn into `streamBlock`.
 *
 * One API call per member, so each is GATED on the desired block declaring a
 * member cdkd would send — the same reader the write plan runs. The gate is
 * also what keeps an undeclared member out of an `observedProperties`
 * baseline, which is compared by the UNION of both sides' keys.
 *
 * No policy (`PolicyNotFoundException`) and an empty user tag set emit
 * NOTHING: that is "absent" in the template's own spelling, which a
 * declared member then reports as drift (a declared EMPTY list is the one
 * exception, and reads back as the empty list it is). `aws:`-prefixed system tags are
 * dropped like the table-level ones, and the list needs no unordered path —
 * the comparator sorts every `{Key, ...}` list on both sides. Any other
 * failed read omits the member and says why at debug level, like the sibling
 * reads of this method.
 *
 * Both reads are EVENTUALLY consistent — right after a write they can answer
 * "absent" or with the PREVIOUS value (their command docs say so) — and the
 * deploy captures `observedProperties` right after the writes. So an answer
 * that does not match the DECLARED member is re-asked a few times before it
 * is believed, or a lagging read would freeze a baseline the settled stream
 * can never equal. A member that really drifted costs those few seconds per
 * drift run.
 *
 * `afterOwnWrite` (issue #4112): the read captures the baseline right after
 * a successful create / update by this deploy, whose template declares the
 * member. There a member still ABSENT when the schedule is spent, or a read
 * that threw, keeps the DECLARED member instead of freezing "absent" into a
 * baseline the settled stream can never equal. Only absence: a PRESENT
 * answer that differs is recorded as read, since AWS may store a document
 * in another spelling and the declared one would then never match. An
 * update that sent no stream call keeps the declared member over an
 * out-of-band removal too, which drift then reports against it. A thrown
 * read keeps the declared member only when the failure is TRANSIENT
 * ({@link isTransientStreamReadFailure}); a deterministic one (a role that
 * may put but not read) fails the same way on every drift read, so keeping
 * the declared member there would report a removal forever. And a read that
 * throws after an earlier PRESENT answer records that answer, as a settled
 * one would. Every other caller (drift, import, a refresh) believes the last
 * answer, so a member that really is gone stays drift.
 *
 * `cdkd drift --revert` replays through `update()`, where the read-back is
 * the PREVIOUS side and {@link planStreamMemberOps} derives the restore.
 */
export async function readStreamMembers(
  this: DynamoDBTableProvider,
  tableName: string,
  streamArn: string | undefined,
  desiredBlock: unknown,
  streamBlock: Record<string, unknown>,
  afterOwnWrite: boolean
): Promise<void> {
  if (streamArn === undefined || streamArn === '') return;
  const keepDeclared = (member: 'ResourcePolicy' | 'Tags', why: string): void => {
    const declared =
      member === STREAM_POLICY_KEY
        ? declaredStreamPolicyMember(desiredBlock)
        : declaredStreamTagsMember(desiredBlock);
    if (declared === undefined) return;
    streamBlock[member] = declared;
    this.logger.debug(
      safeMsg`Kept the declared stream ${member} of ${tableName} in the baseline captured after its write: ${why}`
    );
  };
  if (streamDeclaresPolicy(desiredBlock)) {
    // The last answer the schedule got, for a read that throws after it.
    let lastPolicy: string | undefined;
    try {
      const livePolicy = await this.reAskUntilSettled(
        async () => {
          try {
            const response = await this.dynamoDBClient.send(
              new GetResourcePolicyCommand({ ResourceArn: streamArn })
            );
            lastPolicy = response.Policy;
          } catch (err) {
            if (!(err instanceof PolicyNotFoundException)) throw err;
            lastPolicy = undefined;
          }
          return lastPolicy;
        },
        (answer) => streamPolicyMatchesDeclared(answer, desiredBlock)
      );
      if (afterOwnWrite && (livePolicy === undefined || livePolicy === '')) {
        keepDeclared(STREAM_POLICY_KEY, 'the read still found no policy');
      } else {
        const member = reverseMapStreamPolicy(livePolicy, desiredBlock);
        if (member !== undefined) streamBlock[STREAM_POLICY_KEY] = member;
      }
    } catch (err) {
      this.logger.debug(
        `Could not read the stream ResourcePolicy for ${tableName}: ${describeAwsFailure(err).detail}`
      );
      if (afterOwnWrite && lastPolicy !== undefined && lastPolicy !== '') {
        const member = reverseMapStreamPolicy(lastPolicy, desiredBlock);
        if (member !== undefined) streamBlock[STREAM_POLICY_KEY] = member;
      } else if (afterOwnWrite && isTransientStreamReadFailure(err)) {
        keepDeclared(STREAM_POLICY_KEY, 'the read failed transiently');
      }
    }
  }
  if (streamDeclaresTags(desiredBlock)) {
    let lastTags: Array<{ Key: string; Value: string }> = [];
    try {
      const listOnce = async (): Promise<Array<{ Key: string; Value: string }>> => {
        const liveTags: Tag[] = [];
        let nextToken: string | undefined;
        do {
          const response = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: streamArn, NextToken: nextToken })
          );
          liveTags.push(...(response.Tags ?? []));
          nextToken = response.NextToken;
        } while (nextToken !== undefined && nextToken !== '');
        lastTags = normalizeAwsTagsToCfn(liveTags);
        return lastTags;
      };
      const tags = await this.reAskUntilSettled(listOnce, (answer) =>
        streamTagsMatchDeclared(answer, desiredBlock)
      );
      // A DECLARED empty list reads back as one, so it equals itself.
      const declared = (desiredBlock as Record<string, unknown>)[STREAM_TAGS_KEY];
      if (afterOwnWrite && tags.length === 0 && !streamTagsMatchDeclared(tags, desiredBlock)) {
        keepDeclared(STREAM_TAGS_KEY, 'the read still found no tags');
      } else if (tags.length > 0 || (Array.isArray(declared) && declared.length === 0)) {
        streamBlock[STREAM_TAGS_KEY] = tags;
      }
    } catch (err) {
      this.logger.debug(
        `Could not read the stream Tags for ${tableName}: ${describeAwsFailure(err).detail}`
      );
      if (afterOwnWrite && lastTags.length > 0) {
        streamBlock[STREAM_TAGS_KEY] = lastTags;
      } else if (afterOwnWrite && isTransientStreamReadFailure(err)) {
        keepDeclared(STREAM_TAGS_KEY, 'the read failed transiently');
      }
    }
  }
}
