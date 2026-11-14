import {
  UpdateTableCommand,
  type UpdateTableCommandInput,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexUpdate,
  type UpdateGlobalSecondaryIndexAction,
  type GlobalSecondaryIndexDescription,
} from '@aws-sdk/client-dynamodb';
import { cdkdRemedy, pasteableCommand, proseQuoted } from '../../../utils/pasteable-command.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { getCurrentStackName } from '../../resource-name/stack-scope.js';
import type { SecretMasker } from '../../../types/resource.js';
import type { VectorIndexPlan } from '../../dynamodb-vector-indexes.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { liveCapacityAlreadyMatches } from './capacity.js';
import { sameJsonValue } from './indexes.js';

/**
 * Apply a {@link planVectorIndexUpdates} plan (go-to-k/cdkd#2762): each op in
 * its own `UpdateTable`, as AWS takes one vector index add or remove per
 * call, waiting for the table and every index to settle first (a GSI op just
 * issued may still be backfilling) and after (the next op, and the settings
 * applied after this, are refused against an updating table). A Create
 * carries the desired `AttributeDefinitions`, as a GSI Create does, so an
 * attribute the index's `SearchSchema` names is defined.
 */
export async function applyVectorIndexUpdates(
  this: DynamoDBTableProvider,
  physicalId: string,
  plan: VectorIndexPlan,
  desiredAttributeDefinitions: AttributeDefinition[] | undefined,
  maskSecrets: SecretMasker,
  beforeFirstOp: () => void,
  onCreated: (indexName: string) => void
): Promise<void> {
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  for (const name of plan.alreadyGone) {
    debug(
      `${this.vectorIndexScopeAt(name, physicalId, maskSecrets)} is recorded in cdkd state but ` +
        `not live; skipping its Delete (already removed)`
    );
  }
  for (const name of plan.adopted) {
    warn(
      `${this.vectorIndexScopeAt(name, physicalId, maskSecrets)} already exists in AWS with the ` +
        `declared definition but is absent from cdkd's recorded previous state, so its ` +
        `Create is being skipped. This usually means an earlier deploy created the index ` +
        `and then failed before state was written.`
    );
  }
  if (plan.ops.length === 0) return;
  await this.waitForTableAndIndexesActive(physicalId, undefined, { maskSecrets });
  beforeFirstOp();
  for (const op of plan.ops) {
    const input: UpdateTableCommandInput = {
      TableName: physicalId,
      VectorIndexUpdates: [op],
    };
    if (op.Create && desiredAttributeDefinitions) {
      input.AttributeDefinitions = desiredAttributeDefinitions;
    }
    await this.dynamoDBClient.send(new UpdateTableCommand(input));
    if (op.Create?.IndexName !== undefined) onCreated(op.Create.IndexName);
    await this.waitForTableAndIndexesActive(physicalId, undefined, { maskSecrets });
    debug(
      `${op.Create ? 'created' : 'deleted'} ` +
        this.vectorIndexScopeAt(
          op.Create?.IndexName ?? op.Delete?.IndexName,
          physicalId,
          maskSecrets
        )
    );
  }
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
export async function applyGsiUpdates(
  this: DynamoDBTableProvider,
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
  //
  // REQUIRED rather than defaulted since issue
  // [#3364](https://github.com/go-to-k/cdkd/issues/3364), together with the
  // three parameters below it: a required parameter cannot follow an optional
  // one, and `maskSecrets` at the end of this list had to become required.
  // The sole call site already passes all four.
  handledByBillingFlip: ReadonlySet<string>,
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
  liveIndexNames: ReadonlySet<string> | undefined,
  // The live `DescribeTable` index descriptions, keyed by name (issue
  // #1630). Carries the whole description rather than just the capacity
  // because the Create arm also needs `IndexStatus` to tell a recovered
  // index from one that is on its way OUT. `undefined` = no snapshot to
  // reason from, which disables both idempotency arms.
  liveIndexByName: ReadonlyMap<string, GlobalSecondaryIndexDescription> | undefined,
  // Whether the live capacity NUMBERS mean anything. False for a table whose
  // LIVE billing mode is PAY_PER_REQUEST, where `DescribeTable` reports
  // `{0, 0}` for every index (the #1571 trap) — comparing that would be
  // meaningless, so the capacity half stays disabled while the EXISTENCE
  // half above still applies.
  liveCapacityComparable: boolean,
  // Whether this update leaves the table on PAY_PER_REQUEST, i.e. whether an
  // `OnDemandThroughput` member is sendable at all by the time the ops below
  // are issued (issue go-to-k/cdkd#3373, condition 4 of
  // {@link onDemandCeilingRemovals}). It gates the per-index REMOVAL only:
  // a DECLARED per-index ceiling on a PROVISIONED table is refused
  // PRE-FLIGHT by `update()` (issue go-to-k/cdkd#3392) and never reaches
  // here, while a removal declares nothing for that refusal to see.
  onDemandCeilingsSendable: boolean,
  // The caller's secret masker (issue #1932 item 3, adopted here by issue
  // #1997). Every warning below names a RESOLVED property value — an index
  // NAME, or a declared `WarmThroughput` / `ProvisionedThroughput` block — and
  // the helpers this method calls each install their own masked sink from it.
  // REQUIRED, with no identity default: see
  // {@link DynamoDBTableProvider.coerceOnDemandCeilingsForSend} for why the
  // typechecker is the only fence (issue #3364).
  maskSecrets: SecretMasker,
  // go-to-k/cdkd#5498: called with each index name a Create was ACCEPTED for.
  onCreated: (indexName: string) => void = () => undefined
): Promise<void> {
  // ONE masked sink for the warnings this method emits directly (issue
  // #1997); the helpers below take the masker itself so they can also mask
  // raw values before stringifying them.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  // ...and its DEBUG twin. Added by the go-to-k/cdkd#3380 round-2 review
  // (C4 / security S2): the two `logger.debug` lines below interpolate a raw
  // index NAME -- a RESOLVED property value -- and `logger.ts` masks nothing,
  // so a resolved secret used as an index name printed in plaintext under
  // `--verbose`. Pre-existing, and the sink is the fix rather than two inline
  // wraps for the reason `.claude/rules/provider-masking.md` gives: the next
  // debug line added here is masked by construction.
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
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
      debug(
        `${this.indexScopeAt(name, physicalId, maskSecrets)} is recorded in cdkd state but ` +
          `not live; skipping its Delete (already removed)`
      );
      continue;
    }
    ops.push({ Delete: { IndexName: name } });
  }

  for (const [name, gsi] of desiredByName) {
    if (!prevByName.has(name)) {
      const live = liveIndexByName?.get(name);
      // The Create arm's idempotency half (issue #1630), the sibling of the
      // Delete filter above. cdkd writes state only after `update()` RETURNS,
      // so a throw in any of the steps that follow `applyGsiUpdates` (PITR,
      // TTL, ResourcePolicy, Kinesis streaming, Contributor Insights) leaves
      // a just-created index unrecorded — the next deploy re-emits its
      // Create, AWS rejects it because the index now exists, and every later
      // deploy fails identically until the user runs `cdkd drift --accept`.
      // Skipping a Create for a name AWS already has is what makes the arm
      // converge instead.
      //
      // WARN rather than debug: reaching this means state and AWS disagree,
      // which is worth surfacing even though cdkd recovers from it.
      // The required-field check runs BEFORE the recovery skip: a template
      // missing `KeySchema` is broken regardless of what AWS happens to
      // hold, and skipping past it would record the broken bag into state.
      if (!gsi.KeySchema) {
        throw new ProvisioningError(
          `GlobalSecondaryIndex ${name} on DynamoDB table ${logicalId} is missing KeySchema`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      // `DELETING` deliberately does NOT count as live here: the index is on
      // its way out, so skipping its Create would leave it absent from AWS
      // while state records it. (The Delete arm's `liveIndexNames` DOES
      // include it, correctly — a Delete for an already-DELETING index is
      // the call that should be suppressed.)
      const recovered = live !== undefined && live.IndexStatus !== 'DELETING';
      if (recovered) {
        warn(
          `${this.indexScopeAt(name, physicalId, maskSecrets)} already exists in AWS ` +
            `but is absent ` +
            `from cdkd's recorded previous state, so its Create is being skipped. This ` +
            `usually means an earlier deploy created the index and then failed before ` +
            `state was written.`
        );
        // Skipping on the NAME alone would be a silent state divergence
        // (review of this PR): if the retry ALSO edits the recovered index,
        // no op is emitted, the engine records the DESIRED bag on success,
        // and no later diff converges — state claims one capacity while AWS
        // holds another, forever. Pre-fix this failed loudly at AWS, so the
        // skip must not trade a loud failure for a quiet lie.
        //
        // Capacity is comparable and is therefore repaired: fall through to
        // the same `Update` the same-name path would emit.
        // ONE action carrying whichever members need repair, for the same
        // reason as the same-name arm below.
        const adopted: UpdateGlobalSecondaryIndexAction = { IndexName: name };
        let adoptedHasMember = false;
        if (
          liveCapacityComparable &&
          gsi.ProvisionedThroughput &&
          !handledByBillingFlip.has(name) &&
          !liveCapacityAlreadyMatches(live.ProvisionedThroughput, gsi.ProvisionedThroughput) &&
          !this.skipZeroCapacityIndexUpdate(
            name,
            physicalId,
            gsi.ProvisionedThroughput,
            maskSecrets
          )
        ) {
          // COERCED, not forwarded verbatim (the review of issue #3255):
          // the GUARDS above read the DECLARED block through
          // `toFiniteNumber` exactly as before; only the wire value moves
          // onto CloudFormation's Integer grammar.
          adopted.ProvisionedThroughput = this.indexCapacityForSend(
            this.indexScopeAt(name, physicalId, maskSecrets),
            gsi.ProvisionedThroughput,
            maskSecrets
          );
          adoptedHasMember = true;
        }
        // WarmThroughput is repaired on the adopted index for the same reason
        // capacity is (issue #1768): the Create was skipped, so nothing else
        // in this deploy would ever send it. There is no recorded previous
        // side here, so the value is compared only against what AWS holds.
        const adoptedWarm = this.warmThroughputOpFor(
          name,
          physicalId,
          gsi,
          undefined,
          live,
          maskSecrets
        );
        if (adoptedWarm) {
          adopted.WarmThroughput = adoptedWarm;
          adoptedHasMember = true;
        }
        // The on-demand ceiling is repaired on the adopted index for exactly
        // the reason capacity and warm throughput are (issue #3287): the
        // Create was skipped, so nothing else in this deploy would ever send
        // it. There is no recorded previous side here, so — like the warm
        // arm — the only comparison available is against what AWS holds.
        const adoptedCeiling = this.indexCeilingForSend(
          name,
          physicalId,
          gsi,
          undefined,
          live,
          onDemandCeilingsSendable,
          maskSecrets
        );
        if (adoptedCeiling) {
          adopted.OnDemandThroughput = adoptedCeiling;
          adoptedHasMember = true;
        }
        if (adoptedHasMember) {
          ops.push({ Update: adopted });
        }
        // KeySchema / Projection are deliberately NOT compared here, and the
        // divergence is ANNOUNCED instead of refused. The same-name path can
        // compare them because both its sides are CFn-shaped; here the live
        // side is an AWS READBACK, where `Projection` is normalized and
        // `NonKeyAttributes` ordering is not guaranteed — structurally
        // comparing across that boundary is the #1571 "the comparator can
        // actually tell them apart" trap, and a false positive would refuse
        // a perfectly valid deploy. A visible warning naming `cdkd drift` is
        // the honest answer for the shape half.
        // `cdkd drift` takes a STACK, not the table name (go-to-k/cdkd#6262):
        // the top-level stack of the one being deployed, which a nested
        // child's drift is reported under; a hole outside a stack scope.
        const stack = getCurrentStackName()?.split('~')[0];
        const driftCommand = pasteableCommand('cdkd drift', [
          stack !== undefined
            ? { value: stack, hole: 'stack', opts: { patternMatched: true } }
            : { hole: 'stack' },
        ]).command;
        warn(
          `${this.indexScopeAt(name, physicalId, maskSecrets)} was adopted from AWS rather ` +
            `than created, so cdkd could ` +
            `not verify ` +
            `its KeySchema / Projection match the template. Run ${proseQuoted(driftCommand, '`')} ` +
            `to confirm, and ${proseQuoted(cdkdRemedy('cdkd drift', '--accept'), '`')} if AWS is the source of truth.`
        );
        continue;
      }
      // A declared-but-unsendable WarmThroughput is announced here rather
      // than vanishing into the spread below (PR review of issue #1768).
      this.warnRefusedWarmThroughput(
        this.indexScopeAt(name, physicalId, maskSecrets),
        gsi.WarmThroughput,
        maskSecrets
      );
      // COERCED, not forwarded verbatim (PR review round 5): a quoted
      // `'12000'` must reach AWS as a number, not as a string in a Long
      // field.
      const createWarm = this.coerceWarmThroughputForSend(
        this.indexScopeAt(name, physicalId, maskSecrets),
        gsi.WarmThroughput,
        maskSecrets
      );
      ops.push({
        Create: {
          IndexName: name,
          KeySchema: gsi.KeySchema,
          Projection: gsi.Projection,
          // COERCED, not forwarded verbatim (the review of issue #3255).
          // This is the site that made the divergence user-visible: with
          // only `create()` coerced, ONE template succeeded on a fresh
          // create and was rejected by AWS when the same index was added by
          // a later update.
          ...(gsi.ProvisionedThroughput
            ? {
                ProvisionedThroughput: this.indexCapacityForSend(
                  this.indexScopeAt(name, physicalId, maskSecrets),
                  gsi.ProvisionedThroughput,
                  maskSecrets
                ),
              }
            : {}),
          // COERCED, not forwarded verbatim (issue #3265) — the per-index
          // twin of the table-level forward, through the same reader, so a
          // GSI added by a later update cannot answer differently from the
          // same GSI created with the table.
          ...(gsi.OnDemandThroughput
            ? {
                OnDemandThroughput: this.coerceOnDemandCeilingsForSend(
                  this.indexScopeAt(name, physicalId, maskSecrets),
                  gsi.OnDemandThroughput,
                  maskSecrets
                ),
              }
            : {}),
          // A declared per-index WarmThroughput rides the Create action
          // (issue #1768): `CreateGlobalSecondaryIndexAction` accepts it, and
          // without it the property was silently dropped for every index
          // added after the table's own creation. This used to add that
          // `create()` "forwards it on the CreateTable path, so only this arm
          // was missing" — true when written, and made false by PR review
          // round 6, which found that forward was itself uncoerced and routed
          // it through the same helper. BOTH paths coerce now.
          ...(createWarm ? { WarmThroughput: createWarm } : {}),
        },
      });
    } else {
      const before = prevByName.get(name)!;
      // A same-name index's KeySchema / Projection are immutable in place —
      // AWS models such a change as a delete + re-create of the index. cdkd's
      // diff keys GSIs by name, so it would NOT emit a remove-then-add pair
      // for an in-place key/projection edit; applying only a throughput Update
      // (or nothing) would silently drop the change and record state as if it
      // applied. Fail loud instead (the no-SDK-unwired rule) so the user
      // renames the index (forcing remove + add) or accepts a table replace.
      if (
        !sameJsonValue(before.KeySchema, gsi.KeySchema) ||
        !sameJsonValue(before.Projection, gsi.Projection)
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
      // ONE Update action per index, carrying whichever members changed
      // (PR review of issue #1768). `UpdateGlobalSecondaryIndexAction` takes
      // `ProvisionedThroughput` AND `WarmThroughput`, both optional, so
      // splitting them cost a second `UpdateTable` PLUS a second full
      // index-ACTIVE wait against the 1800s budget for an index that changed
      // both. `runGsiOps` issues one call per op, so merging here is what
      // makes it one call.
      const update: UpdateGlobalSecondaryIndexAction = { IndexName: name };
      let updateHasMember = false;
      // Only ProvisionedThroughput is mutable in place on an existing index.
      // A numeric RCU/WCU change on a PROVISIONED GSI is issued as an Update;
      // a PROVISIONED->on-demand per-index drop is driven by the table-wide
      // BillingMode switch (handled above), not here.
      if (
        gsi.ProvisionedThroughput &&
        !handledByBillingFlip.has(name) &&
        JSON.stringify(before.ProvisionedThroughput) !== JSON.stringify(gsi.ProvisionedThroughput)
      ) {
        // The Update arm's idempotency half (issue #1630). The recorded
        // previous side says the capacity changed, but a throughput Update
        // that already LANDED before a later step threw is unrecorded — and
        // re-emitting it is rejected outright: "The provisioned throughput
        // for the index X will not change. The requested value equals the
        // current value." (the same rejection `gsiHandledByBillingFlip`
        // exists for, reached by a different route). Consulting what AWS
        // actually holds is what lets the deploy converge.
        if (
          liveCapacityComparable &&
          liveCapacityAlreadyMatches(
            liveIndexByName?.get(name)?.ProvisionedThroughput,
            gsi.ProvisionedThroughput
          )
        ) {
          debug(
            `${this.indexScopeAt(name, physicalId, maskSecrets)} already carries the ` +
              `requested capacity in AWS; skipping its throughput Update`
          );
        } else if (
          !this.skipZeroCapacityIndexUpdate(
            name,
            physicalId,
            gsi.ProvisionedThroughput,
            maskSecrets
          )
        ) {
          // COERCED, not forwarded verbatim (the review of issue #3255).
          // The change detector above compares the DECLARED block against
          // the RECORDED one, both raw, which is what keeps it symmetric;
          // this is only what goes on the wire.
          update.ProvisionedThroughput = this.indexCapacityForSend(
            this.indexScopeAt(name, physicalId, maskSecrets),
            gsi.ProvisionedThroughput,
            maskSecrets
          );
          updateHasMember = true;
        }
      }
      // WarmThroughput on an existing index (issue #1768), on the SAME action.
      const warm = this.warmThroughputOpFor(
        name,
        physicalId,
        gsi,
        before,
        liveIndexByName?.get(name),
        maskSecrets
      );
      if (warm) {
        update.WarmThroughput = warm;
        updateHasMember = true;
      }
      // OnDemandThroughput on an existing index (issue #3287), on the SAME
      // action. Until it landed, `UpdateGlobalSecondaryIndexAction`'s third
      // member was never set by either arm AND `updateHasMember` was set only
      // by the two arms above — so a ceiling-only edit produced no
      // `GlobalSecondaryIndexUpdates` entry at all, deployed GREEN, and was
      // recorded as applied. The sibling `Create` action has carried the
      // ceiling since issue #3265, so one template applied it when the index
      // was ADDED and silently ignored a later edit to it.
      const ceiling = this.indexCeilingForSend(
        name,
        physicalId,
        gsi,
        before,
        liveIndexByName?.get(name),
        onDemandCeilingsSendable,
        maskSecrets
      );
      if (ceiling) {
        update.OnDemandThroughput = ceiling;
        updateHasMember = true;
      }
      if (updateHasMember) {
        ops.push({ Update: update });
      }
    }
  }

  await this.runGsiOps(physicalId, ops, desiredAttributeDefinitions, maskSecrets, onCreated);
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
export async function runGsiOps(
  this: DynamoDBTableProvider,
  physicalId: string,
  ops: GlobalSecondaryIndexUpdate[],
  desiredAttributeDefinitions: AttributeDefinition[] | undefined,
  // The caller's masker (the go-to-k/cdkd#3380 round-3 security review, S3).
  // The per-op debug line below names an index NAME -- a RESOLVED property
  // value -- and `logger.ts` masks nothing, so a resolved secret used as an
  // index name printed in plaintext under `--verbose`. REQUIRED, with no
  // identity default: see
  // {@link DynamoDBTableProvider.coerceOnDemandCeilingsForSend} for why the
  // typechecker is the only fence (issue #3364).
  maskSecrets: SecretMasker,
  // go-to-k/cdkd#5498: called with each index name a Create was ACCEPTED for.
  onCreated: (indexName: string) => void = () => undefined
): Promise<void> {
  // ONE sink for this method, per `.claude/rules/provider-masking.md`: the
  // next debug line added here is masked by construction.
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
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
    // go-to-k/cdkd#5498: AFTER the call resolved: AWS accepted the Create, so
    // this index is one cdkd started (a call that throws added nothing).
    if (op.Create?.IndexName !== undefined) onCreated(op.Create.IndexName);
    // GSI create/delete is async: the table returns to ACTIVE quickly while a
    // new index is still CREATING -> BACKFILLING. AWS rejects the next GSI op
    // until every index is fully ACTIVE, and CloudFormation likewise waits for
    // the index to finish before completing — so wait on BOTH the table and
    // every GSI status, not just the table.
    await this.waitForTableAndIndexesActive(physicalId, undefined, { maskSecrets });
    const verb = op.Create ? 'created' : op.Delete ? 'deleted' : 'updated';
    debug(
      `${verb} ${this.indexScopeAt(
        op.Create?.IndexName ?? op.Delete?.IndexName ?? op.Update?.IndexName,
        physicalId,
        maskSecrets
      )}`
    );
  }
}
