import {
  DynamoDBClient,
  TagResourceCommand,
  UntagResourceCommand,
  type AttributeDefinition,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';

import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import {
  coerceCfnBoolean,
  configBooleanRefusal,
  configStringRefusal,
  requireConfigString,
} from '../../config-shape.js';

import { vectorIndexesShapeDetail } from '../../dynamodb-vector-indexes.js';
import { protectedReplacementAdvice } from '../../replacement-protection-advice.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import type { ResourceUpdateResult, UpdateContext, SecretMasker } from '../../../types/resource.js';
import { keepUnreadReplicaMembers } from '../../dynamodb-replica-settings.js';
import {
  unsettledScope,
  REGION_SEGMENT,
  markAttemptedItems,
  markUnsettled,
  isUnsettled,
} from './projection.js';
import {
  refuseMalformedReplicaTags,
  disassociationProtectionRefusal,
  replicaSettingsRefusal,
  extractLocalDeletionProtection,
  replicaKeyBlocks,
} from './replica-shape.js';
import { collectDesiredKeyAttributeNames, asRecord } from './capacity.js';
import { globalSecondaryIndexesShapeDetail } from './throughput.js';

import { deepEqual, lsiListOrEmpty } from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import { updatePhasePlan } from './update-plan.js';
import { updatePhaseTable } from './update-table.js';
import { updatePhaseReplicas } from './update-replicas.js';
import { updatePhaseIndexes } from './update-indexes.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

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
export async function update(
  this: DynamoDBGlobalTableProvider,
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

/**
 * The `updateInScope` parameters and locals its phases read: the phases are its `try` block, moved verbatim and run in order.
 */
export interface UpdateInScopeLocals {
  physicalId: string;
  logicalId: string;
  maskSecrets: SecretMasker;
  currentRegion: string;
  properties: Record<string, unknown>;
  previousProperties: Record<string, unknown>;
  context: UpdateContext | undefined;
  warn: (message: string) => void;
  resourceType: string;
  log: MaskedLogSinks;
  effectiveProperties: Record<string, unknown> | undefined;
  debug: (message: string) => void;
  newAttrs: AttributeDefinition[];
}

export async function updateInScope(
  this: DynamoDBGlobalTableProvider,
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
      guardRegion === '' || extractLocalDeletionProtection(previousProperties, guardRegion) === true
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
    const changed = (key: string): boolean => !deepEqual(properties[key], previousProperties[key]);
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
    const p0 = await updatePhasePlan.call(this, {
      physicalId,
      logicalId,
      maskSecrets,
      currentRegion,
      properties,
      previousProperties,
      context,
      warn,
      resourceType,
      log,
      effectiveProperties,
    });
    const p1 = await updatePhaseTable.call(this, {
      desiredGsiUnusable: p0.desiredGsiUnusable,
      previousProperties,
      currentRegion,
      oldBilling: p0.oldBilling,
      maskSecrets,
      effectiveProperties: p0.effectiveProperties,
      properties,
      billingUnusable: p0.billingUnusable,
      recordedOldBilling: p0.recordedOldBilling,
      newBilling: p0.newBilling,
      describeResp: p0.describeResp,
      onDemandCeilingLive: p0.onDemandCeilingLive,
      desiredCeilings: p0.desiredCeilings,
      flatUpdate: p0.flatUpdate,
      flatChanged: p0.flatChanged,
      physicalId,
      logicalId,
      tableClassUpdate: p0.tableClassUpdate,
      tableClassFromTemplate: p0.tableClassFromTemplate,
      sseUpdate: p0.sseUpdate,
      liveHasCrossRegionReplica: p0.liveHasCrossRegionReplica,
      deferredSseUpdate: p0.deferredSseUpdate,
      deferredSseFromTemplate: p0.deferredSseFromTemplate,
      sseFromTemplate: p0.sseFromTemplate,
      keylessSseFromTemplate: p0.keylessSseFromTemplate,
      onUnusableGsiBlock: p0.onUnusableGsiBlock,
      onUnusablePreviousGsiBlock: p0.onUnusablePreviousGsiBlock,
      previousGsiUnusable: p0.previousGsiUnusable,
      resourceType,
      liveWarmByIndexName: p0.liveWarmByIndexName,
      debug,
      literalWriteMoves: p0.literalWriteMoves,
      tableCapacityChange: p0.tableCapacityChange,
      staysReplicated: p0.staysReplicated,
    });
    const p2 = await updatePhaseReplicas.call(this, {
      properties,
      previousProperties,
      physicalId,
      logicalId,
      maskSecrets,
      currentRegion,
      autoScalingApplied: p1.autoScalingApplied,
      newBilling: p0.newBilling,
      tableArn: p0.tableArn,
      resourceType,
      oldBilling: p0.oldBilling,
      warn,
      debug,
      describeResp: p0.describeResp,
      context,
      deferredSseUpdate: p1.deferredSseUpdate,
      deferredSseFromTemplate: p1.deferredSseFromTemplate,
      keylessSseFromTemplate: p1.keylessSseFromTemplate,
    });
    return await updatePhaseIndexes.call(this, {
      previousProperties,
      currentRegion,
      oldBilling: p0.oldBilling,
      onUnusablePreviousGsiBlock: p0.onUnusablePreviousGsiBlock,
      maskSecrets,
      previousGsiUnusable: p1.previousGsiUnusable,
      desiredSdkIndexes: p0.desiredSdkIndexes,
      describeResp: p0.describeResp,
      newBilling: p0.newBilling,
      liveBillingMode: p0.liveBillingMode,
      properties,
      liveIndexNames: p0.liveIndexNames,
      warn,
      logicalId,
      physicalId,
      desiredGsiUnusable: p1.desiredGsiUnusable,
      debug,
      liveWarmByIndexName: p0.liveWarmByIndexName,
      newAttrs,
      gsiHandledByBillingFlip: p1.gsiHandledByBillingFlip,
      vectorIndexPlan: p0.vectorIndexPlan,
      autoScalingApplied: p1.autoScalingApplied,
      addedReplicaRegions: p2.addedReplicaRegions,
      replicaKeepOnRemoval: p2.replicaKeepOnRemoval,
      context,
      log,
      resourceType,
      effectiveProperties: p1.effectiveProperties,
    });
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
export async function applyTagDiff(
  this: DynamoDBGlobalTableProvider,
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
export async function applyCrossRegionReplicaTagsDiff(
  this: DynamoDBGlobalTableProvider,
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
export async function applyTagDiffOnClient(
  this: DynamoDBGlobalTableProvider,
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
