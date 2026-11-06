import {
  UpdateTableCommand,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexUpdate,
  type OnDemandThroughput,
  type UpdateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markUnsettled } from './projection.js';
import { TABLE_READ_PROVISIONED_KEY, TABLE_WRITE_PROVISIONED_KEY } from './replica-shape.js';
import { derivePerCallProvisionedThroughput, autoScalingTargetKey } from './capacity.js';
import { ON_DEMAND_LIMIT_RESET } from './throughput.js';
import { toSdkGlobalSecondaryIndexes, retainUnsendableCapacityMembers } from './gsi.js';
import { deepEqual, type RawCeiling } from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import type { UpdateInScopeLocals } from './update.js';
import type { UpdatePhasePlanResult } from './update-plan.js';

export type UpdatePhaseTableResult = Awaited<ReturnType<typeof updatePhaseTable>>;

/**
 * `updateInScope`, phase 2 of 4 (moved verbatim): the table-level `UpdateTable`
 * calls (SSE, BillingMode flip, on-demand ceilings, warm throughput) and the
 * table's auto-scaling diff.
 */
export async function updatePhaseTable(
  this: DynamoDBGlobalTableProvider,
  scope: Pick<
    UpdateInScopeLocals,
    | 'previousProperties'
    | 'currentRegion'
    | 'maskSecrets'
    | 'properties'
    | 'physicalId'
    | 'logicalId'
    | 'resourceType'
    | 'debug'
  > &
    Pick<
      UpdatePhasePlanResult,
      | 'desiredGsiUnusable'
      | 'oldBilling'
      | 'effectiveProperties'
      | 'billingUnusable'
      | 'recordedOldBilling'
      | 'newBilling'
      | 'describeResp'
      | 'onDemandCeilingLive'
      | 'desiredCeilings'
      | 'flatUpdate'
      | 'flatChanged'
      | 'tableClassUpdate'
      | 'tableClassFromTemplate'
      | 'sseUpdate'
      | 'liveHasCrossRegionReplica'
      | 'deferredSseUpdate'
      | 'deferredSseFromTemplate'
      | 'sseFromTemplate'
      | 'keylessSseFromTemplate'
      | 'onUnusableGsiBlock'
      | 'onUnusablePreviousGsiBlock'
      | 'previousGsiUnusable'
      | 'liveWarmByIndexName'
      | 'literalWriteMoves'
      | 'tableCapacityChange'
      | 'staysReplicated'
    >
) {
  const {
    previousProperties,
    currentRegion,
    oldBilling,
    maskSecrets,
    properties,
    billingUnusable,
    recordedOldBilling,
    newBilling,
    describeResp,
    onDemandCeilingLive,
    desiredCeilings,
    flatUpdate,
    physicalId,
    logicalId,
    tableClassUpdate,
    tableClassFromTemplate,
    sseUpdate,
    liveHasCrossRegionReplica,
    sseFromTemplate,
    resourceType,
    liveWarmByIndexName,
    debug,
    literalWriteMoves,
    tableCapacityChange,
    staysReplicated,
  } = scope;
  let {
    desiredGsiUnusable,
    effectiveProperties,
    flatChanged,
    deferredSseUpdate,
    deferredSseFromTemplate,
    keylessSseFromTemplate,
    previousGsiUnusable,
  } = scope;
  // The closure the earlier phase built sets ITS copy of `desiredGsiUnusable`; this phase reads its own copy, so it is set here too.
  const onUnusableGsiBlock: typeof scope.onUnusableGsiBlock = (message) => {
    desiredGsiUnusable = true;
    scope.onUnusableGsiBlock(message);
  };
  // The closure the earlier phase built sets ITS copy of `previousGsiUnusable`; this phase reads its own copy, so it is set here too.
  const onUnusablePreviousGsiBlock: typeof scope.onUnusablePreviousGsiBlock = (message) => {
    previousGsiUnusable = true;
    scope.onUnusablePreviousGsiBlock(message);
  };
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
  const resolveCeiling = (desired: RawCeiling, live: number | undefined): number | undefined => {
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
    markUnsettled('BillingMode', 'WriteProvisionedThroughputSettings', TABLE_READ_PROVISIONED_KEY);
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
  const billingFlippedToOnDemand = oldBilling === 'PROVISIONED' && newBilling === 'PAY_PER_REQUEST';
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
  // Ahead of step 4a': DynamoDB refuses `ReplicaUpdates` on a table with a
  // cross-region replica until its write side is auto-scaled (measured), and
  // declaring that with a read change is the way out of the refusal above.
  if (literalWriteMoves) {
    autoScalingApplied.add(
      autoScalingTargetKey({
        dimension: 'dynamodb:table:WriteCapacityUnits',
        region: currentRegion,
      })
    );
  }
  if (
    autoScalingMeaningful &&
    !literalWriteMoves &&
    !deepEqual(writeAutoScalingOld, effectiveNewAutoScaling)
  ) {
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
  // 4a'. go-to-k/cdkd#2762, go-to-k/cdkd#5604: a changed literal capacity,
  // on either side. `ProvisionedThroughput` takes both members, so a side
  // this update does not change goes out as AWS holds it, which is also how
  // an auto-scaled side stays with its scaling policy. A value AWS holds is
  // not sent: DynamoDB refuses a `ProvisionedThroughput` that changes nothing.
  //
  // `ProvisionedThroughput` on a table with a cross-region replica sets
  // every region to the sent read capacity and clears its
  // `ProvisionedThroughputOverride`, a write-only change included (measured),
  // so such a table never gets one: its read goes out as the local region's
  // override, which leaves the others alone (the result CloudFormation
  // reaches, measured), and its write side is auto-scaled (`literalWriteMoves`).
  if (tableCapacityChange) {
    const liveThroughput = describeResp.Table?.ProvisionedThroughput;
    const sendRead = tableCapacityChange.read ?? liveThroughput?.ReadCapacityUnits;
    const sendWrite = tableCapacityChange.write ?? liveThroughput?.WriteCapacityUnits;
    const readMoves = sendRead !== liveThroughput?.ReadCapacityUnits;
    const writeMoves = sendWrite !== liveThroughput?.WriteCapacityUnits;
    if (sendRead !== undefined && sendWrite !== undefined && (readMoves || writeMoves)) {
      markUnsettled(
        ...(readMoves ? tableCapacityChange.readKeys : []),
        ...(writeMoves ? [TABLE_WRITE_PROVISIONED_KEY] : [])
      );
      await this.dynamoDBClient.send(
        new UpdateTableCommand(
          staysReplicated
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
    }
  }
  return {
    gsiHandledByBillingFlip,
    autoScalingApplied,
    effectiveProperties,
    deferredSseUpdate,
    deferredSseFromTemplate,
    keylessSseFromTemplate,
    desiredGsiUnusable,
    previousGsiUnusable,
  };
}
