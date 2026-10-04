import { replacementDeletePolicy } from '../../provisioning/final-snapshot.js';
import { displaySafe } from '../../utils/display-safe.js';
import {
  createSecretMasker,
  recordNestedStackParameterExpressions,
  recordNoEchoAttributeValues,
  STATE_DERIVED_RULES,
} from '../secret-redaction.js';
import { updatePartialMessage, updatePartialReason } from '../update-outcome.js';
import { redactRollbackRecord } from './replay-secrets.js';
import { deepEqual } from './plan.js';
import {
  requireRestorableBaseline,
  replayPrefixScope,
  ABSENT_BASELINE_SKIP_CAUSE,
} from './names.js';
import {
  safe,
  throwIfDeleteSkipped,
  rollbackRetainsNewResource,
  retainedSurvivorMessages,
  rollbackFinalSnapshotId,
  rerunRollbackPhrase,
  recordRollbackSkip,
} from './messages.js';
import { resolveReplayProps, refuseMaskedReplayBaseline } from './replay-props.js';
import { updateWithRollbackRetry, recordAfterRollbackUpdate } from './replay-retry.js';
import type { ReplayOpScope } from './replay-scope.js';

/** `replaySingle`'s 'reverse-replacement-readopt' arm (#4426). */
export async function replayReadopt(s: ReplayOpScope): Promise<void> {
  const { op, stateResources, stackName, ctx, result, inlinePolicyWriters, afterOp, logger, mask } =
    s;
  // Replacement rollback where UpdateReplacePolicy: Retain orphaned
  // the OLD physical resource (issue #1199): it still exists with its
  // data, so delete the NEW resource and point state back at the old
  // one — a true clean revert, no re-create needed.
  const current = stateResources[op.logicalId]!;
  const prev = op.previousState!;
  logger.info(
    `  Rollback: Reversing replacement of ${safe(op.logicalId)} (${safe(op.resourceType)}) — ` +
      `deleting the new resource and re-adopting the retained old one ` +
      `(${displaySafe(mask(prev.physicalId))})`
  );
  /**
   * Set when this arm ORPHANS the replacement's new copy. Read at the
   * `ROLLBACK_RESOURCE_SUCCEEDED` event below, which is the only channel
   * that OUTLIVES the terminal (security review of issue #2598): a
   * rollback runs during an already-failing deploy, often non-TTY with
   * the log truncated or discarded, so a `logger.warn` is the least
   * likely thing the user still has. Without this the survivor's id dies
   * with the terminal -- `cdkd events` shows a clean success and state
   * names only the OLD resource, while a live, billing, untracked copy
   * remains. `Retain` is precisely the marker users put on data-bearing
   * resources, so that is the worst population to lose the id for.
   *
   * Same shape as the `rollbackPartial` survivor record ~700 lines down
   * and as the deploy engine's `RESOURCE_SKIPPED` twin.
   */
  let survivorReason: string | undefined;
  if (rollbackRetainsNewResource(current)) {
    // ON THIS ARM THIS IS THE ALWAYS-CASE, not an exception, and saying
    // so is the point (review of issue #2598). `oldResourceRetained` is
    // set only when the TEMPLATE being applied declared
    // `UpdateReplacePolicy: Retain`, and the SAME template read
    // populates the new record through `extractTemplateAttributes` — so
    // whenever `classifyRollbackOp` reaches `reverse-replacement-readopt`
    // for a journal any cdkd binary wrote, `current` carries `Retain`
    // too. Net effect: this rollback path no longer deletes the new copy
    // at all, which is a real behaviour change and is what CloudFormation
    // does (the A/B's `DELETE_SKIPPED` rows). The `else` below is kept
    // for a record that did NOT come from that pairing — a hand-edited
    // or externally-produced state file — rather than deleted, because
    // the classifier and this executor are separately reachable and a
    // dead-by-construction branch is cheaper than a crash when the
    // construction changes. The `reverse-replacement` twin is genuinely
    // conditional: a provider that re-creates inside its own `update()`
    // reaches it with either polarity.
    //
    // Issue #2598: the NEW copy declares `UpdateReplacePolicy: Retain`,
    // which the A/B on {@link rollbackRetainsNewResource} measured as
    // the attribute governing this very delete. CloudFormation reports
    // `DELETE_SKIPPED` here and orphans the copy out of the stack; cdkd
    // does the same, and the state re-point below leaves nothing naming
    // it. Warned rather than logged at info: the outcome is a live,
    // untracked, billing resource, the same class as the deploy engine's
    // `Retain` survivor warning.
    const survivorMessages = retainedSurvivorMessages(
      op.logicalId,
      op.resourceType,
      current.physicalId,
      `State is restored to the old resource (${prev.physicalId}).`,
      mask
    );
    logger.warn(survivorMessages.warn);
    survivorReason = survivorMessages.reason;
    result.warnings++;
  } else {
    // Resolved INSIDE this arm (review of issue #2598): the retain arm
    // above issues no AWS call at all, and `getProviderFor` THROWS for a
    // type the rollback command's registry cannot route (an
    // `--allow-unsupported-types` type, say). Hoisted, a readopt that
    // deletes nothing could fail on a lookup it never needed.
    const { provider: newDeleteProvider } = ctx.providerRegistry.getProviderFor({
      resourceType: op.resourceType,
      provisionedBy: current.provisionedBy ?? op.provisionedBy,
    });
    const finalSnapshotIdentifier = rollbackFinalSnapshotId(
      op.resourceType,
      current,
      op.provisionedBy
    );
    // go-to-k/cdkd#4225: as on the reverse replacement's deletes below.
    const readoptClaimed = inlinePolicyWriters.claimedFor(
      op.resourceType,
      op.logicalId,
      stateResources
    );
    const readoptDelete = await newDeleteProvider.delete(
      op.logicalId,
      current.physicalId,
      op.resourceType,
      current.properties,
      {
        expectedRegion: ctx.region,
        ...(readoptClaimed && { inlinePolicyClaimed: readoptClaimed }),
        ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
        // Issue #4029: the NEW copy's UpdateReplacePolicy governs.
        deletionPolicy: replacementDeletePolicy(current.updateReplacePolicy),
        recordedAttributes: current.attributes,
      }
    );
    // Issue #1762: BEFORE the state re-point, so a skip cannot leave
    // state naming the retained OLD resource while the NEW one is still
    // alive — two live resources with state describing one. The `Retain`
    // arm above reaches that same shape DELIBERATELY, which is why it
    // announces it rather than failing the op.
    throwIfDeleteSkipped(
      readoptDelete,
      op.logicalId,
      current.physicalId,
      'while reversing its replacement (re-adopting the retained old resource)'
    );
  }
  stateResources[op.logicalId] = prev;
  logger.info(`  Rollback: ${safe(op.logicalId)} restored to the retained old resource`);
  await afterOp?.(op.logicalId);
  // The SURVIVOR's routing layer, which is NOT the op's. Follow-up to
  // the security review of issue #2598: the layer field sitting beside
  // `physicalId` is what tells a cleanup pass WHICH API manages that id,
  // so shipping the id with a possibly-wrong layer beside it partly
  // defeats the fix -- a consumer reading the pair could dispatch the
  // wrong provider at a live, untracked resource. Before that fix these
  // events named no resource at all, so the mislabel was inert; the id
  // is what makes it bite. The deploy engine's `RESOURCE_SKIPPED` twin
  // snapshots the survivor's layer for exactly this reason.
  //
  // NO `?? op.provisionedBy` here, and that absence is deliberate: an
  // earlier revision had one and it was DEAD. When the record carries no
  // layer (a pre-v7 record) this override simply does not fire, and the
  // unconditional `op.provisionedBy` spread below already put the op's
  // layer on the event -- which is the right answer for that case and
  // the exact behaviour the fallback was written to produce. Measured:
  // deleting the `??` changed no emitted value, so nothing could ever
  // fence it. Pinned by the pre-v7 case, which fences the SPREAD.
  const survivorProvisionedBy = current.provisionedBy;
  ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
    stackName,
    operation: 'UPDATE',
    logicalId: op.logicalId,
    resourceType: op.resourceType,
    ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
    // The mask on `reason` below is a BELT here, and no case can tell it
    // apart: `retainedSurvivorMessages` already masked the survivor's id
    // and clause with the op's masker (issue #4037), which on this arm
    // carries no plaintext but does carry the ids of a record whose name
    // is still a `{{resolve:...}}` reference. Kept so the two twin event
    // sites stay literally identical.
    //
    // BOTH fields, and both gated on there actually BEING a survivor:
    // with no retention this event describes a completed revert, and a
    // `physicalId` here would then name the resource this rollback just
    // DELETED. The id rides as a FIELD, not only inside `reason` -- a
    // `--json` consumer should not have to parse prose, and it is the
    // one datum a cleanup pass needs. Masked because the record is
    // durable, the same reason the survivor record below masks.
    ...(survivorReason !== undefined && {
      physicalId: current.physicalId,
      reason: mask(survivorReason),
      // Overrides the op's layer spread above -- a later spread wins.
      // Gated with the other two, deliberately: on a non-retain revert
      // this event describes the OP, and the op's layer is correct there.
      ...(survivorProvisionedBy && { provisionedBy: survivorProvisionedBy }),
    }),
  });
  return;
}

/** `replaySingle`'s 'revert' arm (#4426). */
export async function replayRevert(s: ReplayOpScope): Promise<void> {
  const {
    op,
    stateResources,
    stackName,
    ctx,
    resolver,
    inlinePolicyWriters,
    afterOp,
    isInterrupted,
    logger,
    secrets,
    opMasker,
    mask,
  } = s;
  if (!op.previousState) {
    logger.warn(`  Rollback: Cannot restore ${safe(op.logicalId)} — no previous state available`);
    recordRollbackSkip(
      s,
      op,
      'No previous state is recorded for it, so there is nothing to restore it to.'
    );
    return;
  }
  // Bound before the retry closure below: the narrowing from the guard
  // above does not survive into a deferred callback.
  const previousState = op.previousState;
  const current = stateResources[op.logicalId];
  if (!current) {
    logger.warn(
      `  Rollback: Cannot restore ${safe(op.logicalId)} — resource not found in current state`
    );
    recordRollbackSkip(
      s,
      op,
      'The resource is not in the current state, so the rollback had nothing to restore.'
    );
    return;
  }
  // Issue #3203, BEFORE the `Restoring ...` line below: announcing a
  // restore and then refusing it reads as a failure mid-flight. The
  // desired-side `?? {}` further down is now DEAD AT RUNTIME --
  // `resolveReplayProps` returns `undefined` only for an absent bag,
  // which this rejects -- and is kept because that function's DECLARED
  // return type is unconditionally `| undefined`, so narrowing its
  // ARGUMENT says nothing about its result. (The first spelling of this
  // comment blamed the property access not narrowing; the review
  // measured that against tsc and it is false.)
  if (
    !requireRestorableBaseline(previousState.properties, logger, {
      logicalId: op.logicalId,
      consequence:
        'be applied as a complete desired state: a patch provider removes every property, and an SDK provider may reset a subset or replace the resource',
      remedy: 'Re-run `cdkd deploy` to re-converge it.',
      retry: `re-running ${rerunRollbackPhrase(ctx, '`cdkd rollback`')} retries this op`,
    })
  ) {
    recordRollbackSkip(s, op, ABSENT_BASELINE_SKIP_CAUSE);
    return;
  }
  logger.info(
    `  Rollback: Restoring ${safe(op.logicalId)} (${safe(op.resourceType)}) to previous state`
  );
  // Route via the provider that owns the resource right now per state.
  const { provider, provisionedBy: revertVia } = ctx.providerRegistry.getProviderFor({
    resourceType: op.resourceType,
    provisionedBy: op.provisionedBy,
  });
  // Re-resolve the redacted secret expressions in BOTH sides of the diff
  // to the concrete secret for the provider call (GHSA fix): a patch-based
  // provider diffs previous-vs-desired, so an unresolved expression on
  // either side would either replay the literal string or wrongly compute a
  // no-op. `secrets` (hoisted to the top of this function) captures
  // plaintext->expression to redact the record AND to mask every log site
  // downstream, the shared catch included.
  const desiredProps = await resolveReplayProps(
    previousState.properties,
    resolver,
    secrets,
    ctx,
    op.logicalId
  );
  // Issue #2274: the DESIRED side only — that is the bag `update()`
  // writes. `currentProps` below becomes `previousProperties`, where a
  // mask is harmless.
  refuseMaskedReplayBaseline(desiredProps, op.logicalId);
  const currentProps = await resolveReplayProps(
    current.properties,
    resolver,
    secrets,
    ctx,
    op.logicalId
  );
  // Issue #2291, the UPDATE twin of the reverse-replacement re-create
  // arm's recording, whose note says why a CHILD engine seeded from this
  // bag needs the per-parameter table. Since issue #3754 no child engine
  // is built on THIS arm: the `update()` below passes `replayingState`,
  // so a nested-stack row returns through `NestedStackProvider`'s
  // journal-replay arm, which seeds nothing from this bag.
  //
  // The call stays anyway, for two reasons. It still writes any carried
  // framed value into `secrets` (the recorder's frame carry in
  // `secret-redaction.ts`), which `redactRollbackRecord` reads for THIS
  // row's own record. And it keeps the arm correct should an update ever
  // reach `runChildDeploy` again without `replayingState`. The notes
  // below describe what it records for a child engine that reads it.
  //
  // THE SOURCE IS THE JOURNAL, not the child's template. The journaled
  // record is the UNCOLLAPSED one -- since issue #1904 each of its leaves
  // holds its OWN `{{resolve:...}}` token -- which is exactly what the
  // position pass needs, and it is also the bag `resolveReplayProps` just
  // produced this resolved side FROM.
  //
  // `STATE_DERIVED_RULES`, not the recorder's `TEMPLATE_DERIVED_RULES`
  // default: the source is a persisted record, so it holds no PUBLIC
  // `ssm:` reference (a `String` parameter is stored resolved), and it IS
  // the same generation the bag was resolved from one statement earlier.
  // That is the identical pairing `redactRollbackRecord` makes for the
  // record it positions.
  //
  // THE FIRST HALF OF THAT PREMISE HAS A DOCUMENTED CARVE-OUT, and saying
  // it unqualified -- as this note first did -- restates something
  // `PathSourceRules`' own doc contradicts: `cdkd import` WARNS and
  // persists the RAW template intrinsic, so a public `ssm:` expression CAN
  // sit in a record's `properties`. Measured in review: the POSITION
  // pass certifies such a token here and refuses it under
  // `TEMPLATE_DERIVED_RULES`. Since issue #3090 the recorder no longer
  // RECORDS it either way -- its refusal 5 asks the pass's pair table,
  // which a public token (resolved as public, never paired) is not in --
  // so the child's leaf falls to the value scan. The cost before that
  // was bounded to the issue #1901 class (a spurious UPDATE, never a
  // disclosure: a reference either way); what remains is the ordinary
  // value-scan answer, and every replay of an imported stack's nested
  // parameters still runs.
  //
  // The WRONG fix, ruled out explicitly: do NOT gate this on
  // `isKnownSecretExpression`. That reopens refusal 2b's hole, where an
  // `ssm` reference whose verdict is unpinned falls to the value scan and
  // the losing parameter is recorded against the SIBLING's expression.
  //
  // ONLY THE DESIRED SIDE. The other bag each arm resolves (`currentProps`
  // / `attemptedProps`) is a DIFFERENT generation, and
  // `NestedStackProvider` forwards only `properties` -- the desired side --
  // as the child's `Parameters`. Recording both would POISON every
  // parameter name whose expression changed between the two generations,
  // which refuses the very population this exists to serve.
  recordNestedStackParameterExpressions(
    secrets,
    op.resourceType,
    desiredProps,
    previousState.properties,
    STATE_DERIVED_RULES
  );
  // Issue #4037: both sides are PLAINTEXT now; each name derives its own
  // record's id.
  opMasker.addNamed({
    resourceType: op.resourceType,
    properties: desiredProps,
    logicalId: op.logicalId,
    physicalIds: [previousState.physicalId],
  });
  opMasker.addNamed({
    resourceType: op.resourceType,
    properties: currentProps,
    logicalId: op.logicalId,
    physicalIds: [current.physicalId],
  });
  // go-to-k/cdkd#4225: an `AWS::IAM::Policy` revert keeps a name a
  // completed revert of this replay has put back on a principal.
  const revertClaimed = inlinePolicyWriters.claimedFor(
    op.resourceType,
    op.logicalId,
    stateResources
  );
  // Issue #4024: an IAM Role / ManagedPolicy `update()` re-derives the
  // name and REPLACES the resource when it differs from the physical id,
  // so the revert runs under the prefix setting that derives THIS id.
  const inOriginalPrefix = replayPrefixScope(
    {
      resourceType: op.resourceType,
      properties: desiredProps,
      logicalId: op.logicalId,
      physicalId: current.physicalId,
      via: revertVia,
    },
    logger,
    mask,
    false
  );
  // See {@link updateWithRollbackRetry} for why this is not a bare
  // `provider.update()` and not a bare `withRetry` either.
  const revertResult = await inOriginalPrefix(() =>
    updateWithRollbackRetry(
      provider,
      [
        op.logicalId,
        current.physicalId,
        op.resourceType,
        desiredProps ?? {},
        // The PREVIOUS side is deliberately NOT guarded by issue #3203's
        // check, and that is a recorded decision rather than an oversight
        // the review had to infer. A malformed `current.properties` reaches
        // the provider here verbatim, but it cannot strip a real property,
        // and the reason is the OPPOSITE of what an earlier spelling of
        // this comment said (it claimed no `remove` is derived from the
        // previous side -- false: `JsonPatchGenerator.generatePatch` walks
        // `Object.keys(previousProperties)` and every `remove` comes from
        // exactly there). A malformed previous side can only UNDER-supply
        // keys: `{}` yields no removes at all and turns the whole desired
        // bag into `add`s, while a string or an array yields only junk
        // numeric keys that name no live property. So the failure mode is a
        // wrong patch, never a stripped resource -- and guarding it would
        // refuse rollbacks that can still succeed. go-to-k/cdkd#3211 owns
        // the malformed-state-record class this belongs to.
        currentProps ?? {},
        // Issue #1932 item 3: the UPDATE twin of the re-create arms above.
        // No `desiredFromAwsReadback` — this bag is `previousState.properties`,
        // a TEMPLATE recorded earlier, and setting that flag here would delete
        // a live configuration on rollback (see `UpdateContext`'s own doc).
        //
        // `replayingState` (issue #3141) says the OTHER thing, and the two
        // are not interchangeable: this bag IS a cdkd state record, so a
        // provider refusal written for a bad TEMPLATE has no template-side
        // remedy here and must downgrade to whatever the binary that WROTE
        // the record did. It is the UPDATE twin of
        // `REPLAYING_STATE_CREATE_CONTEXT` above — same arm of the same
        // rollback, one taking `create()` and one `update()` — and until it
        // existed the `update()` half simply could not be told apart from a
        // template deploy (`logs-loggroup-provider.ts` carried the accepted
        // residual that named this issue).
        //
        // `expectedRegion` (issue #2301 item 1): the same `ctx.region` this
        // executor already puts on every `DeleteContext` it builds. This arm
        // is addressed BY `current.physicalId`, read out of the state record
        // being reverted, so it carries the same wrong-region hazard.
        //
        // `recordedAttributes` (issue #4051): the identity evidence of
        // the record `current.physicalId` came from.
        {
          maskSecrets: createSecretMasker(secrets),
          expectedRegion: ctx.region,
          replayingState: true,
          recordedAttributes: current.attributes,
          ...(revertClaimed && { inlinePolicyClaimed: revertClaimed }),
        },
      ],
      op.logicalId,
      logger,
      isInterrupted,
      secrets,
      mask
    )
  );
  // go-to-k/cdkd#4434: the record now takes the attributes `update()` returned,
  // so a `NoEcho` declaration on them (a custom resource's response, a nested
  // stack's masked outputs) must become needles BEFORE the redaction below,
  // exactly as the deploy engine registers them — or they persist in the clear.
  if (revertResult) recordNoEchoAttributeValues(revertResult, secrets, desiredProps);
  stateResources[op.logicalId] = redactRollbackRecord(
    recordAfterRollbackUpdate(previousState, revertResult),
    secrets,
    previousState.properties
  );
  // go-to-k/cdkd#4225: a PARTIAL revert is no completed writer, as on
  // the deploy side.
  if (updatePartialReason(revertResult) === undefined) {
    inlinePolicyWriters.record(
      op.logicalId,
      'update',
      stateResources[op.logicalId]!,
      !deepEqual(previousState.properties?.['Policies'], current.properties?.['Policies']),
      revertVia
    );
  }
  // Issue #1819: the rollback restored the resource, but the provider may
  // have left something behind (a replacement whose old resource
  // survives). Saying "restored successfully" over that is the same
  // silence the channel exists to end — and a rollback is exactly when a
  // user is least able to go looking for an untracked resource.
  const rollbackPartial = updatePartialReason(revertResult);
  if (rollbackPartial !== undefined) {
    // Issue #2038: `updatePartialMessage` renders PROVIDER-authored prose
    // about a bag this replay resolved to plaintext — the same site
    // `drift.ts` masks on its own revert path.
    logger.warn(
      mask(`  Rollback: ${safe(op.logicalId)} restored, ${updatePartialMessage(rollbackPartial)}`)
    );
    // Deliberately NOT `result.warnings++`, matching this file's own
    // precedent for the stateful reverse-replacement advisory: warnings
    // map to `PartialFailureError` and exit 2, and the rollback op ITSELF
    // succeeded -- the resource is back at its previous state. Reporting
    // a fully-successful rollback as "skipped/unrecoverable" would be
    // false, and inventing an exit-code rule here for "left something
    // behind" is the decision issue #1960 exists to make across deploy
    // and rollback together. The survivor is still announced on the warn
    // line and, unlike a log line, durably on the event below.
  } else {
    logger.info(`  Rollback: ${safe(op.logicalId)} restored successfully`);
  }
  await afterOp?.(op.logicalId);
  ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
    stackName,
    operation: 'UPDATE',
    logicalId: op.logicalId,
    resourceType: op.resourceType,
    ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
    // Carry the survivor into the DURABLE record. A rollback runs during
    // an already-failing deploy, so a log line is the least likely thing
    // a user still has; without this the orphan's id dies with the
    // terminal.
    // Masked for the same reason as the warn line above, and doubly so:
    // this one is DURABLE (issue #2031 acceptance item 2).
    ...(rollbackPartial !== undefined && {
      reason: mask(rollbackPartial),
    }),
  });
  return;
}
