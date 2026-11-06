import {
  UpdateTableCommand,
  type UpdateTableCommandInput,
  type GlobalSecondaryIndexUpdate,
  type OnDemandThroughput,
  type GlobalSecondaryIndexDescription,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';
import type { SecretMasker } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import {
  ON_DEMAND_LIMIT_RESET,
  onDemandCeilingRemovals,
  tableCapacityForSend,
  withOnDemandCeilingRemovals,
} from './capacity.js';
import {
  BILLING_FLIP_ACTIVE_WAIT_ATTEMPTS,
  TABLE_ACTIVE_WAIT_ATTEMPTS,
  readCapacityNumber,
} from './table-helpers.js';

/**
 * The BillingMode / ProvisionedThroughput / TableClass `UpdateTable`.
 *
 * A verbatim slice of `DynamoDBTableProvider.update()`'s `try` body, in its
 * original position in the sequence: `update()` passes it the locals it reads.
 */
export async function applyBillingModeUpdate(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  markUnsettled: (key: string) => void,
  maskSecrets: SecretMasker,
  warn: (message: string) => void,
  normalizeTableClass: (v: unknown) => 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS',
  tableClassChanged: boolean,
  liveBillingMode: 'PROVISIONED' | 'PAY_PER_REQUEST',
  prevBillingMode: 'PROVISIONED' | 'PAY_PER_REQUEST',
  billingMode: 'PROVISIONED' | 'PAY_PER_REQUEST',
  billingOrThroughputChanged: boolean,
  liveIndexes: GlobalSecondaryIndexDescription[],
  desiredIndexByName: Map<string, Record<string, unknown>>,
  preFlipDeletedIndexNames: Set<string>,
  gsiHandledByBillingFlip: Set<string>
): Promise<void> {
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
      // Same reader as `create()` (issue #3147), so the two table-level
      // forwarders and `hasUsableTableCapacity` all answer from one
      // grammar: an absent member takes the 5 default, a DECLARED one
      // CloudFormation rejects is announced and OMITTED, and AWS then
      // names the member exactly as it does for an absent required one.
      const pt = properties['ProvisionedThroughput'] as Record<string, unknown>;
      const onUnusable = (member: string, raw: unknown): void =>
        this.warnUnusableProvisionedCapacity(
          `AWS::DynamoDB::Table ${logicalId}`,
          member,
          raw,
          maskSecrets
        );
      updateInput.ProvisionedThroughput = {
        ReadCapacityUnits: tableCapacityForSend(pt, 'ReadCapacityUnits', onUnusable),
        WriteCapacityUnits: tableCapacityForSend(pt, 'WriteCapacityUnits', onUnusable),
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
      (live) => typeof live.IndexName !== 'string' || !preFlipDeletedIndexNames.has(live.IndexName)
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
        warn(
          `AWS::DynamoDB::Table ${logicalId}: flipping BillingMode to PROVISIONED, but the ` +
            `template declares no usable ProvisionedThroughput for live index(es) ` +
            // Index NAMES, masked raw before the join — same reason as the
            // removal warning above.
            `${unspecified.map((n) => maskSecrets(n)).join(', ')}. AWS requires per-index ` +
            `capacity in the same ` +
            `UpdateTable and will reject the flip naming them. Declare ` +
            `GlobalSecondaryIndexes[].ProvisionedThroughput (both ReadCapacityUnits and ` +
            `WriteCapacityUnits) for each. An index this deploy REMOVES is deleted BEFORE ` +
            `the flip automatically, so a name here is one the template still ` +
            `keeps, one that exists in AWS but in neither the template nor cdkd state ` +
            `(created out of band), or one whose pre-flip removal was skipped for the reason ` +
            `warned above.`
        );
      }
    }
    // go-to-k/cdkd#5487: every key this one call changes, before it.
    if (billingMode !== prevBillingMode) markUnsettled('BillingMode');
    if (
      JSON.stringify(properties['ProvisionedThroughput']) !==
      JSON.stringify(previousProperties['ProvisionedThroughput'])
    ) {
      markUnsettled('ProvisionedThroughput');
    }
    if (tableClassChanged) markUnsettled('TableClass');
    if (updateInput.GlobalSecondaryIndexUpdates !== undefined) {
      markUnsettled('GlobalSecondaryIndexes');
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
      await this.waitForTableAndIndexesActive(physicalId, BILLING_FLIP_ACTIVE_WAIT_ATTEMPTS, {
        maskSecrets,
      });
    } else {
      await this.waitForTableActiveAfterUpdate(physicalId, TABLE_ACTIVE_WAIT_ATTEMPTS);
    }
    this.logger.debug(
      `Updated BillingMode/ProvisionedThroughput/TableClass on DynamoDB table ${physicalId}`
    );
  }
}

/**
 * The table-level OnDemandThroughput and WarmThroughput `UpdateTable` calls.
 *
 * A verbatim slice of `DynamoDBTableProvider.update()`'s `try` body, in its
 * original position in the sequence: `update()` passes it the locals it reads.
 */
export async function applyThroughputUpdates(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  markUnsettled: (key: string) => void,
  maskSecrets: SecretMasker,
  debug: (message: string) => void,
  table: TableDescription | undefined,
  effectiveBillingMode: 'PROVISIONED' | 'PAY_PER_REQUEST'
): Promise<void> {
  // OnDemandThroughput — rides on UpdateTable (NOT a separate control-
  // plane API like PITR / TTL). Fire only when the value changed so a
  // no-op update doesn't issue a redundant UpdateTable; AWS validates
  // the PAY_PER_REQUEST-only constraint.
  // The detector compares the RAW declared block against the RAW recorded
  // one, deliberately. Coercing both sides was proposed by the
  // go-to-k/cdkd#3291 review, to stop a later `'100'` -> `100` template
  // correction issuing an `UpdateTable` carrying the value AWS already
  // holds. It is NOT done here, because both spellings of it are worse:
  // coercing the PREVIOUS side warns about a cdkd STATE record the user
  // cannot edit, and comparing through a silent pure coercion instead makes
  // a still-malformed template compare EQUAL, so the provider is never
  // called and the warning that tells the user what to fix STOPS -- the
  // concealment `.claude/rules/provider-diff-record-folds.md` refuses.
  // The redundant call is also bounded: it needs a template EDIT, fires
  // once, and DynamoDB's answer to a same-value ceiling is unmeasured. A
  // malformed template no longer reaches this detector at all: the
  // pre-flight at the top of this method refuses it (issue #3286).
  if (
    JSON.stringify(properties['OnDemandThroughput']) !==
    JSON.stringify(previousProperties['OnDemandThroughput'])
  ) {
    // A pure REMOVAL (new absent, previous present) used to fire the
    // detector and then send NOTHING, so the live ceiling survived forever
    // while state recorded the removal as applied. Issue
    // [#3373](https://github.com/go-to-k/cdkd/issues/3373) closes that at
    // BOTH of this property's positions in the same change — its per-index
    // twin is in {@link indexCeilingForSend} — because implementing it at
    // one of the two would make the same property behave differently at the
    // table and at an index of the same table.
    //
    // {@link onDemandCeilingRemovals} owns every condition; read its doc
    // before touching this. The live block it reads is the `DescribeTable`
    // from the top of this method, which is also what keeps the reset off a
    // PROVISIONED table.
    const ceilingRemovals = onDemandCeilingRemovals(
      properties['OnDemandThroughput'],
      previousProperties['OnDemandThroughput'],
      table?.OnDemandThroughput,
      effectiveBillingMode === 'PAY_PER_REQUEST'
    );
    if (properties['OnDemandThroughput'] || ceilingRemovals.length > 0) {
      const declaredForSend = properties['OnDemandThroughput']
        ? // COERCED, not forwarded verbatim (issue #3265), through the same
          // reader `create()` uses — the change DETECTOR above compares the
          // declared block against the recorded one, both raw, which is
          // what keeps it symmetric; this is only what goes on the wire.
          this.coerceOnDemandCeilingsForSend(
            `AWS::DynamoDB::Table ${logicalId}`,
            properties['OnDemandThroughput'],
            maskSecrets
          )
        : {};
      if (ceilingRemovals.length > 0) {
        debug(
          `AWS::DynamoDB::Table ${logicalId}: removing the OnDemandThroughput ` +
            `${ceilingRemovals.join(' / ')} the template no longer declares (sending ` +
            `${ON_DEMAND_LIMIT_RESET}, DynamoDB's reset sentinel)`
        );
      }
      markUnsettled('OnDemandThroughput');
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: physicalId,
          OnDemandThroughput: withOnDemandCeilingRemovals(
            declaredForSend,
            ceilingRemovals
          ) as OnDemandThroughput,
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
  // there is no spec to send. The send rule is shared with `create()` and
  // with the drift side via `isSendableWarmThroughput` (issue #1760).
  if (
    JSON.stringify(properties['WarmThroughput']) !==
    JSON.stringify(previousProperties['WarmThroughput'])
  ) {
    // Placed on the CHANGE gate, not inside the send gate below, so the
    // warning fires exactly when a user's edit was dropped — once per
    // changed value rather than on every no-op deploy that re-presents the
    // same unusable block. (An earlier draft justified the placement by
    // saying it stops this warning and the decrease skip's from both
    // firing; that was never the reason — the `&&` short-circuits, so a
    // value `isSendableWarmThroughput` refuses never reaches
    // `skipWarmThroughputDecrease` wherever this call sits.)
    this.warnRefusedWarmThroughput(
      `AWS::DynamoDB::Table ${logicalId}`,
      properties['WarmThroughput'],
      maskSecrets
    );
    // COERCED ONCE, here, and used for BOTH the gate below and the wire
    // (PR review round 7). Two rules meet at this line:
    //  - every gate that analyses a value before sending it must analyse
    //    what will ACTUALLY be sent. Reading the raw bag let
    //    `isWarmThroughputDecrease` fail open on an unusable member and
    //    then send the coerced remainder — for
    //    `{ReadUnitsPerSecond: {Ref: 'X'}, WriteUnitsPerSecond: 2000}`
    //    against a live `{12000, 4000}` that is a `{WriteUnitsPerSecond:
    //    2000}` decrease, i.e. the exact call this branch exists to
    //    withhold, so the DEPLOY FAILED while the per-index arm warned and
    //    continued on the identical input.
    //  - the dropped-member announcement must not depend on the gate
    //    letting the call through. `coerceWarmThroughputForSend` is the
    //    only site that names a dropped member, so calling it on the send
    //    path alone meant a skip swallowed that half of the diagnosis.
    //    Placed inside the CHANGE gate, so it still says it once per
    //    changed value rather than on every deploy.
    const warmThroughputToSend = this.coerceWarmThroughputForSend(
      `AWS::DynamoDB::Table ${logicalId}`,
      properties['WarmThroughput'],
      maskSecrets
    );
    if (
      warmThroughputToSend !== undefined &&
      // A DECREASE is refused by AWS, so the call can only fail (issue
      // #1768, measured — see `isWarmThroughputDecrease`). Skipping it with
      // a warning is right for EVERY caller of `update()`, which is the
      // question a skip has to answer:
      //  - the deploy engine (template-borne): a template asking for less
      //    than AWS holds is not applicable, and failing the whole deploy
      //    over it helps nobody. `cdkd drift` keeps REPORTING the
      //    difference, which is the user's signal to edit the template —
      //    hence no `effectiveProperties` here: recording AWS's value
      //    would make the comparison equal and silence exactly that
      //    report.
      //  - `cdkd drift --revert`: the arm the issue was filed from. It
      //    overlays the declared value onto the readback and lands here,
      //    where the call could never succeed; the resource used to fail
      //    with `could not revert — <AWS message>` (exit 2) instead of
      //    reverting everything else and saying why this key stayed.
      //  - the rollback executor's `revert` / `revert-failed-update` arms:
      //    the desired bag is an older TEMPLATE from cdkd state, so the
      //    same reasoning applies — and a throw there would leave the
      //    resource un-rollbackable with no template-side remedy.
      !this.skipWarmThroughputDecrease(
        logicalId,
        physicalId,
        warmThroughputToSend,
        table?.WarmThroughput,
        maskSecrets
      )
    ) {
      markUnsettled('WarmThroughput');
      await this.dynamoDBClient.send(
        new UpdateTableCommand({ TableName: physicalId, WarmThroughput: warmThroughputToSend })
      );
      // UpdateTable is async; wait for ACTIVE so later branches (SSE /
      // Stream / GSI) don't race a still-UPDATING table.
      await this.waitForTableActiveAfterUpdate(physicalId);
      this.logger.debug(`Updated WarmThroughput on DynamoDB table ${physicalId}`);
    }
  }
}
