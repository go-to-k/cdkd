import {
  DescribeTableCommand,
  type StreamSpecification,
  type UpdateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  configBooleanRefusal,
  configStringRefusal,
  readConfigString,
  requireConfigString,
} from '../../config-shape.js';
import { coerceWarmThroughput, type WarmThroughputSpec } from '../../dynamodb-warm-throughput.js';
import { planVectorIndexUpdates, vectorIndexesShapeDetail } from '../../dynamodb-vector-indexes.js';
import { maskLeafValue } from './projection.js';
import {
  localReplicaEntry,
  extractLocalDeletionProtection,
  readReplicaKmsMasterKeyId,
  isKmsKeyArn,
  tableClassToSend,
  toSdkTableSseSpecification,
  extractLocalTableClass,
} from './replica-shape.js';
import {
  derivePerCallProvisionedThroughput,
  declaredCrossRegions,
  writeSideScaled,
  literalWriteSideMoves,
  readTableCapacityChange,
  asRecord,
} from './capacity.js';
import { warmThroughputDiagnostic, type ThroughputDiagnostic } from './throughput.js';
import { toSdkGlobalSecondaryIndexes } from './gsi.js';
import {
  toSdkReplicaGlobalSecondaryIndexes,
  toSdkReplicaThroughputOverrides,
  collectTableOnDemandCeilings,
  deepEqual,
} from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import type { UpdateInScopeLocals } from './update.js';

export type UpdatePhasePlanResult = Awaited<ReturnType<typeof updatePhasePlan>>;

/**
 * `updateInScope`, phase 1 of 4 (moved verbatim): wait for ACTIVE, read the live
 * table, and settle the desired BillingMode, GSI translations, SSE / DPE /
 * TableClass changes this update applies.
 */
export async function updatePhasePlan(
  this: DynamoDBGlobalTableProvider,
  scope: Pick<
    UpdateInScopeLocals,
    | 'physicalId'
    | 'logicalId'
    | 'maskSecrets'
    | 'currentRegion'
    | 'properties'
    | 'previousProperties'
    | 'context'
    | 'warn'
    | 'resourceType'
    | 'log'
    | 'effectiveProperties'
  >
) {
  const {
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
  } = scope;
  let { effectiveProperties } = scope;
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
  const liveHasCrossRegionReplica = (describeResp.Table?.Replicas ?? []).some(
    (r) => r.RegionName !== undefined && r.RegionName !== currentRegion
  );
  // go-to-k/cdkd#5604: a table with a cross-region replica keeps an auto-scaled
  // write side. CloudFormation refuses a literal one, DynamoDB refuses every
  // `ReplicaUpdates` Update once the write target is gone (measured), and
  // `ProvisionedThroughput` would overwrite the other regions' read. Asked of
  // the table this update leaves: one dropping its last other region ends up
  // single-region, where a literal write side is fine. Before the first write
  // of this update. A state-borne bag has no template to fix and a throw would
  // strand what its revert applied, so it warns and skips.
  const declaredRegions = declaredCrossRegions(properties, currentRegion);
  const staysReplicated = liveHasCrossRegionReplica && declaredRegions.length > 0;
  const literalWriteMoves =
    staysReplicated &&
    literalWriteSideMoves(properties, previousProperties, currentRegion, describeResp.Table);
  const statePath = context?.replayingState === true || context?.desiredFromAwsReadback === true;
  // A region this update adds meets the same refusal from DynamoDB, mid-update.
  const addsRegionToLiteral =
    !statePath &&
    properties['BillingMode'] === 'PROVISIONED' &&
    !writeSideScaled(properties) &&
    declaredRegions.some(
      (region) => !describeResp.Table?.Replicas?.some((r) => r.RegionName === region)
    );
  if (literalWriteMoves || addsRegionToLiteral) {
    const refusal =
      `AWS::DynamoDB::GlobalTable ${logicalId}: a table with a cross-region replica needs ` +
      `an auto-scaled write side, and this update declares none: CloudFormation refuses a ` +
      `literal WriteCapacityUnits, and DynamoDB refuses every replica update without ` +
      `auto-scaling`;
    if (statePath) {
      warn(`${refusal}${refusal}. No capacity beyond what a billing flip carries was sent.`);
    } else {
      throw new ProvisioningError(
        maskSecrets(
          `${refusal}. Nothing was applied to the table; declare ` +
            `WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings`
        ),
        resourceType,
        logicalId,
        physicalId
      );
    }
  }
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
          describeResp.Table === undefined ? undefined : (describeResp.Table.VectorIndexes ?? [])
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
    if (warm.ReadUnitsPerSecond !== undefined) spec.ReadUnitsPerSecond = warm.ReadUnitsPerSecond;
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
  const onDemandCeilingLive = oldBilling === 'PAY_PER_REQUEST' && newBilling === 'PAY_PER_REQUEST';
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
    derivePerCallProvisionedThroughput(properties, currentRegion, 'seed', diagnostics, maskSecrets);
  }
  // Read here so a declared value step 4a' cannot read is reported with the
  // rest of this update's diagnostics. A flip carried the capacity already,
  // and a table turned on-demand out of band reports 0/0, no capacity to
  // send back.
  const tableCapacityChange =
    !literalWriteMoves &&
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
  const newLocalKmsKey = readReplicaKmsMasterKeyId(localReplicaEntry(properties, currentRegion));
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
      liveStreamSpec?.StreamEnabled === true && liveStreamSpec.StreamViewType === streamViewType;
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
  return {
    describeResp,
    tableArn,
    liveHasCrossRegionReplica,
    staysReplicated,
    literalWriteMoves,
    vectorIndexPlan,
    liveWarmByIndexName,
    recordedOldBilling,
    liveBillingMode,
    oldBilling,
    billingUnusable,
    newBilling,
    onDemandCeilingLive,
    desiredCeilings,
    tableCapacityChange,
    desiredGsiUnusable,
    onUnusableGsiBlock,
    previousGsiUnusable,
    onUnusablePreviousGsiBlock,
    liveIndexNames,
    desiredSdkIndexes,
    deferredSseUpdate,
    deferredSseFromTemplate,
    keylessSseFromTemplate,
    flatUpdate,
    flatChanged,
    tableClassUpdate,
    sseUpdate,
    sseFromTemplate,
    tableClassFromTemplate,
    effectiveProperties,
  };
}
