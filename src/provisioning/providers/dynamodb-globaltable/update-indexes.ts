import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexUpdate,
  type OnDemandThroughput,
  type TimeToLiveDescription,
  type UpdateGlobalSecondaryIndexAction,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  isTtlAlreadyDisabled,
  isTtlRateLimited,
  planTimeToLive,
  sendTtlWaitingOutRateLimit,
} from '../../dynamodb-ttl.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceWarmThroughput } from '../../dynamodb-warm-throughput.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAttemptedItems, markUnsettled, sentence } from './projection.js';
import {
  collectAutoScalingTargets,
  STREAM_SPECIFICATION_KEY,
  replicationImpliedStreamSpecification,
} from './capacity.js';
import { ON_DEMAND_LIMIT_RESET } from './throughput.js';
import { toSdkGlobalSecondaryIndexes, collectRawOnDemandDeclarations } from './gsi.js';
import {
  collectUncomparableCapacityGsiNames,
  buildLiveRecoveryGsiBaseline,
  diffGlobalSecondaryIndexes,
  deepEqual,
} from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import type { UpdateInScopeLocals } from './update.js';
import type { UpdatePhasePlanResult } from './update-plan.js';
import type { UpdatePhaseTableResult } from './update-table.js';
import type { UpdatePhaseReplicasResult } from './update-replicas.js';

/**
 * `updateInScope`, phase 4 of 4 (moved verbatim): the GSI diff, the index
 * auto-scaling diff, and the final `DescribeTable` the result is built from.
 */
export async function updatePhaseIndexes(
  this: DynamoDBGlobalTableProvider,
  scope: Pick<
    UpdateInScopeLocals,
    | 'previousProperties'
    | 'currentRegion'
    | 'maskSecrets'
    | 'properties'
    | 'warn'
    | 'logicalId'
    | 'physicalId'
    | 'debug'
    | 'newAttrs'
    | 'context'
    | 'log'
    | 'resourceType'
  > &
    Pick<
      UpdatePhasePlanResult,
      | 'oldBilling'
      | 'onUnusablePreviousGsiBlock'
      | 'desiredSdkIndexes'
      | 'describeResp'
      | 'newBilling'
      | 'liveBillingMode'
      | 'liveIndexNames'
      | 'liveWarmByIndexName'
      | 'vectorIndexPlan'
    > &
    Pick<
      UpdatePhaseTableResult,
      | 'previousGsiUnusable'
      | 'desiredGsiUnusable'
      | 'gsiHandledByBillingFlip'
      | 'autoScalingApplied'
      | 'effectiveProperties'
    > &
    Pick<UpdatePhaseReplicasResult, 'addedReplicaRegions' | 'replicaKeepOnRemoval'>
) {
  const {
    previousProperties,
    currentRegion,
    oldBilling,
    maskSecrets,
    desiredSdkIndexes,
    describeResp,
    newBilling,
    liveBillingMode,
    properties,
    liveIndexNames,
    warn,
    logicalId,
    physicalId,
    desiredGsiUnusable,
    debug,
    liveWarmByIndexName,
    newAttrs,
    gsiHandledByBillingFlip,
    vectorIndexPlan,
    autoScalingApplied,
    addedReplicaRegions,
    replicaKeepOnRemoval,
    context,
    log,
    resourceType,
  } = scope;
  let { previousGsiUnusable, effectiveProperties } = scope;
  // The closure the earlier phase built sets ITS copy of `previousGsiUnusable`; this phase reads its own copy, so it is set here too.
  const onUnusablePreviousGsiBlock: typeof scope.onUnusablePreviousGsiBlock = (message) => {
    previousGsiUnusable = true;
    scope.onUnusablePreviousGsiBlock(message);
  };
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
    ? buildLiveRecoveryGsiBaseline(desiredSdkIndexes, describeResp.Table?.GlobalSecondaryIndexes, {
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
      })
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
      newBilling === 'PAY_PER_REQUEST' ? [] : collectAutoScalingTargets(properties, currentRegion),
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
    !deepEqual(properties['TimeToLiveSpecification'], previousProperties['TimeToLiveSpecification'])
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
            await this.dynamoDBClient.send(new DescribeTimeToLiveCommand({ TableName: physicalId }))
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
}
