import { nameGenerationOf } from '../../state/name-generation.js';
import { deployReplaceCommand } from '../../utils/pasteable-command.js';
import type { ResourceProvider } from '../../types/resource.js';
import { STATEFUL_TYPES } from '../../provisioning/stateful-types.js';
import { applyDefaultNameForFallback } from '../../provisioning/resource-name.js';
import { effectiveDeletionPolicy } from '../../provisioning/final-snapshot.js';
import { CdkdError } from '../../utils/error-handler.js';
import { safeMsg } from '../../utils/display-safe.js';
import { noEchoLeavesOf, recordNestedStackParameterExpressions } from '../secret-redaction.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  deleteFirstBlocker,
  resolveReplacementOldType,
  sameIdRecreated,
  sameIdReversalUndecidable,
  unroutableReplacementError,
} from './plan.js';
import { mayBeStoredIn } from '../child-of-recreated-parent.js';
import {
  requireRestorableBaseline,
  replayPrefixScope,
  ABSENT_BASELINE_SKIP_CAUSE,
} from './names.js';
import {
  safe,
  type RollbackDeleteGuardScope,
  rollbackRetainsNewResource,
  rerunRollbackPhrase,
  orphanRemedy,
  refusalPhysicalId,
  ownRemedyError,
  refusalLogicalId,
  refusalResourceType,
  describedPhysicalIdPointer,
  shownLogicalId,
  recordRollbackSkip,
  rollbackCannotAddress,
  skipUnaddressableReplay,
} from './messages.js';
import { resolveReplayProps, refuseMaskedReplayBaseline } from './replay-props.js';
import { refuseMarkedNoEchoRecreate } from './replay-noecho.js';
import type { ReplayOpScope } from './replay-scope.js';
import { replayReadopt } from './replay-revert.js';
import { hasAddressablePhysicalId } from '../../state/malformed-resources-bag.js';
import { probeReplacedSurvivor } from './replaced-survivor.js';
import type { MarkedRecreateScope } from './replay-reverse-replacement/failures.js';
import { recreateOldResource } from './replay-reverse-replacement/recreate.js';
import { finishReverseReplacement } from './replay-reverse-replacement/finish.js';
import type { ReverseReplacementScope } from './replay-reverse-replacement/scope.js';

/**
 * go-to-k/cdkd#5096: reversing a same-id re-create deletes the resource again,
 * and with it whatever AWS stores inside it (a function's permissions, a
 * topic's subscriptions, a role's inline policies). Those children are
 * reversed BEFORE their parent (reverse completion order) and nothing
 * re-creates them after it, so their records would claim resources AWS no
 * longer has. A record of such a child type that depends on this resource (or
 * records no dependencies) refuses the reversal, before anything is deleted.
 */
function refuseSameIdParentReversal(s: ReplayOpScope): void {
  const { op, stateResources, ctx, createdInSegment, orphanLogicalIds } = s;
  const children = Object.entries(stateResources)
    .filter(
      ([logicalId, record]) =>
        logicalId !== op.logicalId &&
        // A child this segment created is deleted by its CREATE pass, and one
        // the user orphans is left alone: neither needs restoring.
        !createdInSegment.has(logicalId) &&
        !orphanLogicalIds.has(logicalId) &&
        mayBeStoredIn(record.resourceType, op.resourceType) &&
        (!Array.isArray(record.dependencies) || record.dependencies.includes(op.logicalId))
    )
    .map(([logicalId]) => logicalId)
    .sort();
  if (children.length === 0) return;
  const remedy = orphanRemedy(op.logicalId, ctx);
  const shown = children.slice(0, 5).map(refusalLogicalId).join(', ');
  const more = children.length > 5 ? ` and ${children.length - 5} more` : '';
  throw ownRemedyError(
    markNonRetryable(
      new CdkdError(
        `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
          `(${refusalResourceType(op.resourceType)}): ` +
          `the deploy deleted it and re-created it under the same physical id, so reversing it ` +
          `deletes it again, and with it what AWS stores inside it (${shown}${more}), which this ` +
          `rollback does not re-create. Nothing was deleted. The journal is kept: fix forward ` +
          `by deploying the previous version of the template with ${deployReplaceCommand()}, which ` +
          `re-creates both` +
          (remedy.offered
            ? `, or leave this resource as it is and let the rest of the rollback proceed by ` +
              `re-running with the command below.`
            : '.') +
          `${remedy.clause}${remedy.line}`,
        'ROLLBACK_SAME_ID_PARENT'
      )
    )
  );
}

/**
 * go-to-k/cdkd#5096: a same-id re-create whose record cannot say whether a
 * prior run already reversed it ({@link sameIdReversalUndecidable}): its bags
 * read the same before and after and hold the mask, or the journal holds no
 * forward bag. Reversing it again deletes what may be the restored
 * resource, and skipping it may leave the new one under the old record, so
 * it refuses before anything is deleted.
 */
function refuseUndecidableSameIdReversal(s: ReplayOpScope): void {
  const { op, stateResources, ctx } = s;
  if (!sameIdReversalUndecidable(op, stateResources[op.logicalId])) return;
  const remedy = orphanRemedy(op.logicalId, ctx);
  throw ownRemedyError(
    markNonRetryable(
      new CdkdError(
        `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
          `(${refusalResourceType(op.resourceType)}): ` +
          `the deploy deleted it and re-created it under the same physical id, and its state ` +
          `record cannot tell whether an earlier rollback already reversed it (its recorded ` +
          `properties read the same before and after the deploy and hold a redacted value, which ` +
          `may hide what changed, or the deploy's properties were not journaled). Nothing was deleted. ` +
          `The journal is kept: fix forward by deploying the previous version of the template ` +
          `with ${deployReplaceCommand()}` +
          (remedy.offered
            ? `, or leave this resource as it is and let the rest of the rollback proceed by ` +
              `re-running with the command below.`
            : '.') +
          `${remedy.clause}${remedy.line}`,
        'ROLLBACK_SAME_ID_UNDECIDABLE'
      )
    )
  );
}

/** `replaySingle`'s 'reverse-replacement' arm (#4426). */
export async function replayReverseReplacement(s: ReplayOpScope): Promise<void> {
  const {
    op,
    stateResources,
    stackName,
    ctx,
    resolver,
    result,
    inlinePolicyWriters,
    logger,
    secrets,
    opMasker,
    mask,
  } = s;
  // Replacement rollback (issue #1199): the OLD physical resource is
  // already destroyed, so an in-place update against the NEW resource
  // would throw on the immutable property. Instead re-CREATE the old
  // resource from its journaled previousState and delete the new one.
  const current = stateResources[op.logicalId]!;
  const prev = op.previousState!;
  // Issue #2668: a replacement has TWO types. Everything below that
  // re-creates the OLD resource routes on `oldType`; everything that
  // deletes the NEW one keeps `op.resourceType`. `classifyRollbackOp`
  // already refused an op whose old type cannot be named, so the `throw`
  // is for a caller that reaches this arm without it.
  const oldTypeRouting = resolveReplacementOldType(op);
  if (!oldTypeRouting.ok) {
    throw unroutableReplacementError(op, oldTypeRouting.reason, ctx);
  }
  const oldType = oldTypeRouting.oldType;
  if (sameIdRecreated(op)) {
    refuseUndecidableSameIdReversal(s);
    refuseSameIdParentReversal(s);
  }
  // go-to-k/cdkd#2631: the deploy's delete of the old resource was not
  // confirmed, so it may still exist. Read AWS first: re-creating a live one
  // duplicates it (auto-named) or collides with it (named).
  if (op.oldResourceMaySurvive !== undefined) {
    const survivor = await probeReplacedSurvivor(s, oldType);
    // Alive but `'unconfirmed'`: an accepted delete may still be running
    // (a read of a `deleting` RDS instance answers like a live one), and
    // re-adopting it would delete the new copy for a resource about to go.
    if (survivor === 'exists' && op.oldResourceMaySurvive !== 'kept') {
      throw survivorUnprovenRefusal(s, oldType, 'maybe-deleting');
    }
    if (survivor === 'exists') {
      // As a retained one: delete the new copy, point state back at the old.
      // A warning, since a provider's delete may have run earlier steps
      // before AWS refused it (a managed policy's detaches).
      // The line names `cdkd drift`, so each value is shown only when plain.
      const oldShown = refusalPhysicalId(mask(String(prev.physicalId)));
      logger.warn(
        safeMsg`  ⚠ Rollback: the old resource of ${shownLogicalId(op.logicalId)} (${oldShown}) still ` +
          `exists — the deploy's delete of it was not confirmed — so it is re-adopted instead of ` +
          `re-created. Part of it may have been removed before that delete failed: check it ` +
          safeMsg`with cdkd drift after the rollback.${describedPhysicalIdPointer(oldShown)}`
      );
      result.warnings++;
      return replayReadopt(s, {
        reason:
          `the old resource survived a delete that was refused or never sent during the ` +
          `deploy and was re-adopted instead of re-created; the provider may have run part of ` +
          `that delete, so check it with cdkd drift`,
      });
    }
    if (survivor !== 'gone') throw survivorUnprovenRefusal(s, oldType, survivor);
    logger.info(
      safeMsg`  Rollback: the old resource of ${safe(op.logicalId)} (${mask(String(prev.physicalId))}) is gone — re-creating it`
    );
  }
  const typeChanged = oldType !== op.resourceType;
  // Issue #3203, BEFORE any AWS call and before the secret resolution:
  // `{}` here would create a default-configured resource and then delete
  // the live one.
  if (
    !requireRestorableBaseline(prev.properties, logger, {
      logicalId: op.logicalId,
      consequence: 'create a default-configured resource and then delete the live one',
      remedy: 'Re-run `cdkd deploy` to re-converge it.',
      retry: `re-running ${rerunRollbackPhrase(ctx, '`cdkd rollback`')} retries this op`,
    })
  ) {
    recordRollbackSkip(s, op, ABSENT_BASELINE_SKIP_CAUSE);
    return;
  }
  // go-to-k/cdkd#4628: both routes delete the NEW resource by the record's
  // id, one of them before the re-create, which a `*NotFound` would then let
  // run with the new resource still alive. Before ANY AWS call. Not when the
  // new copy is retained: that arm never deletes it.
  if (
    !rollbackRetainsNewResource(current) &&
    rollbackCannotAddress(
      current,
      op.resourceType,
      current.provisionedBy ?? op.provisionedBy,
      current.physicalId
    )
  ) {
    skipUnaddressableReplay(s, logger, op, 'reverse the replacement of');
    return;
  }
  // Re-resolve the redacted secret expressions for the re-CREATE (GHSA
  // fix): the old resource must be re-created with the concrete secret,
  // not the literal `{{resolve:...}}` string. `secrets` (hoisted to the
  // top of this function) captures plaintext->expression to redact the
  // rebuilt state record below AND to mask every log site downstream.
  // The `?? {}` is DEAD AT RUNTIME since issue #3203's guard above --
  // see the `revert` arm's note for the full reason; it is kept because
  // `resolveReplayProps` DECLARES `| undefined` unconditionally.
  const resolvedPrevProps =
    (await resolveReplayProps(prev.properties, resolver, secrets, ctx, op.logicalId, prev)) ?? {};
  // Issue #2274: this bag is about to be CREATED with. Refuse before the
  // AWS call rather than after, so nothing is half-applied. A mask only at
  // the coordinates a NoEcho source served gets its own remedy
  // (go-to-k/cdkd#4043 Phase C): no live resource exists to read it from.
  refuseMarkedNoEchoRecreate(resolvedPrevProps, noEchoLeavesOf(prev), op.logicalId);
  refuseMaskedReplayBaseline(resolvedPrevProps, op.logicalId);
  // Issue #4037: the old name is PLAINTEXT now, so its derived spellings
  // (the old id, the names its provider sends) join the op's masker.
  opMasker.addNamed({
    resourceType: oldType,
    properties: resolvedPrevProps,
    logicalId: op.logicalId,
    physicalIds: [prev.physicalId],
  });
  // Issue #2291: a nested-stack row replayed here hands the CHILD engine
  // this same `secrets` bag (`withCurrentResourceSecrets` binds it around
  // the provider call below, and `NestedStackProvider` seeds the child
  // from it). The bag is keyed by PLAINTEXT, so two child `Parameters`
  // resolving to one value have already collapsed in it -- and without
  // the per-parameter table the child re-persists the SURVIVOR for both
  // leaves, silently rewriting correct state back into the #2291 shape.
  // A `cdkd drift --revert` inside that window then pushes the WRONG
  // secret version to the live child resource (the
  // GHSA-p5qg-v9gv-hc7w replay class). Waiting for the next deploy to
  // heal it is not an answer: `--revert` is used precisely then.
  //
  // WHICH RECORD DRIFTS, precisely, because a review round proposed
  // softening this on the grounds that `NestedStackProvider` declares no
  // `readCurrentState`. That is true of the `AWS::CloudFormation::Stack`
  // ROW only -- that row never drifts. The CHILD's own records do:
  // `S3StateBackend.listStacks` has no filter excluding a
  // `{parent}~{Child}` key (it is exactly `NEW_KEY_DEPTH`), so the child
  // state is enumerated as an ordinary stack and `drift.ts` re-resolves
  // its persisted expressions like any other. The claim stands as
  // written.
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
    oldType,
    resolvedPrevProps,
    prev.properties,
    'state-derived'
  );
  // go-to-k/cdkd#4690: the forward deleted the old resource BEFORE creating
  // the new one, so the reversal deletes the new one first. Re-creating
  // first would collide with the new resource on a uniqueness constraint the
  // name-holder proof cannot attribute (an ELBv2 listener's port), and the
  // reversal would refuse. Not when the new copy is retained: that arm never
  // deletes it, so it keeps the create-first route (the Retain refusal on a
  // name collision, the create's own error otherwise).
  //
  // Nor when the old properties name a resource another op of this segment
  // took away (`markDeleteFirstBlocked`): the re-create could then fail after
  // the new resource is gone, losing it, where create-first fails and keeps it
  // (its collision route refuses the delete for such an op too, below).
  // The warning names the blocker by LOGICAL id only: its physical id can spell
  // a secret-derived name this op's masker never learned (#3869's class).
  const deleteFirstBlocked =
    op.oldDeletedBeforeCreate === true && !rollbackRetainsNewResource(current)
      ? deleteFirstBlocker(op)
      : undefined;
  if (deleteFirstBlocked !== undefined) {
    logger.warn(
      mask(
        safeMsg`  Rollback: not deleting the new ${shownLogicalId(op.logicalId)} first: its old properties ` +
          safeMsg`name the resource ${shownLogicalId(deleteFirstBlocked.logicalId)} had before the same deploy ` +
          `replaced or deleted it, which this rollback may not be able to restore under that id — ` +
          `re-creating the old resource first, which keeps the new one if that fails`
      )
    );
  }
  const reverseDeleteFirst =
    op.oldDeletedBeforeCreate === true &&
    !rollbackRetainsNewResource(current) &&
    deleteFirstBlocked === undefined;
  logger.info(
    `  Rollback: Reversing replacement of ${safe(op.logicalId)} ` +
      `(${typeChanged ? `${safe(op.resourceType)} -> ${safe(oldType)}` : safe(op.resourceType)}) — ` +
      (reverseDeleteFirst
        ? `deleting the new resource and re-creating the old one`
        : `re-creating the old resource and deleting the new one`)
  );
  // Advisory only (issue #1199 non-goal: cdkd does not recover the data —
  // surface clearly rather than silently "revert"). NOT counted in
  // result.warnings: the reverse-replacement op itself succeeds, and
  // warnings map to exit code 2.
  //
  // The claim is scoped to what THIS ROLLBACK does, not to what AWS
  // permits. `STATEFUL_TYPES` is not uniform on that second question:
  // most members' data is gone the moment the replacement's delete
  // lands, but `KMSProvider.delete` deletes an `AWS::KMS::Key` by
  // SCHEDULING a deletion, which a user may be able to act on out of
  // band. (`AWS::KMS::ReplicaKey` has no SDK provider, so its delete
  // routes through Cloud Control and this repo has not measured what
  // that does.) A blanket "CANNOT be recovered" would be a statement
  // about AWS that this repo has not measured — and, for KMS, would
  // steer a user away from a recovery that may still exist.
  // The OLD type (issue #2668): it is the old resource's data this is about.
  if (STATEFUL_TYPES.has(oldType)) {
    logger.warn(
      `  ⚠ ${safe(op.logicalId)} (${safe(oldType)}) is a stateful type — the old physical ` +
        `resource's data was destroyed by the replacement and is NOT recovered by this ` +
        `rollback; the re-created resource starts empty.`
    );
  }
  // Route the re-create via the OLD resource's recorded layer AND TYPE,
  // and the new resource's delete via ITS layer and type (the layers can
  // differ — e.g. a --recreate-via-cc-api migration; the types differ on
  // a `Type` change, issue #2668, where the single `op.resourceType` used
  // to re-create the old resource through the NEW type's provider).
  const { provider: createProvider, provisionedBy: createProvisionedBy } =
    ctx.providerRegistry.getProviderFor({
      resourceType: oldType,
      provisionedBy: prev.provisionedBy,
    });
  // The bag the two replay-CREATEs below hand the provider (issue #3199).
  //
  // `resolvedPrevProps` is the RECORDED bag, which `propertiesToRecord`
  // fills from the template's resolved properties — so it never carries a
  // name cdkd GENERATED, by the same invariant the deploy engine's Cloud
  // Control UPDATE path relies on. A Cloud Control CREATE, however, is
  // exactly where that name is required: `preparePropertiesForCcApi`
  // fills it at all three of the engine's create sites, and these two
  // replay sites are the FOURTH. Without it the replay re-creates under
  // an AWS-random name, so the restored resource silently stops matching
  // the name the forward path mints for it.
  //
  // The shape that reaches this is WIDER than "a deploy that added an
  // explicit name": the arm is selected by a CHANGED PHYSICAL ID, so for
  // any table type whose physical id is NOT its name, an ordinary
  // create-only edit elsewhere gets here with a nameless recorded bag —
  // `AWS::ElasticLoadBalancingV2::TargetGroup` (id `TargetGroupArn`,
  // create-only `Port` / `VpcId` / ...), its `LoadBalancer` sibling
  // (`Scheme` / `Type`) and `AWS::WAFv2::WebACL` (`Scope`) all do.
  //
  // A type whose Cloud Control handler REJECTS a nameless create fails
  // the replay outright instead, which on the delete-new-first arm below
  // leaves the resource absent from AWS AND from state. No such type is
  // in `FALLBACK_NAME_RULES` yet — `AWS::Lambda::CapacityProvider` is the
  // known one and its entry arrives with go-to-k/cdkd#3182 — so today
  // this fix is about the silent-divergence half.
  //
  // Gated on the ROUTING DECISION rather than `prev.provisionedBy`: the
  // recorded hint is absent on a pre-v7 record, the registry may route a
  // type with no SDK provider to Cloud Control regardless, and the sticky
  // rule's `sdk-coverage` exemption can return an SDK provider for a
  // `cc-api` hint — so the decision is the only reading that matches what
  // the create will actually call. An SDK-routed create is left alone:
  // its provider mints the name itself, which is what
  // `FALLBACK_NAME_RULES` mirrors.
  //
  // The OUTER SPREAD is load-bearing, not redundant:
  // `applyDefaultNameForFallback` returns its argument BY IDENTITY when
  // the type has no rule or the name is already set, so removing it would
  // hand `resolvedPrevProps` to the provider by reference and give up the
  // fresh copy the pre-#3199 `{ ...resolvedPrevProps }` guaranteed.
  //
  // Applied ONLY to the bag handed to `create()`, never to
  // `resolvedPrevProps` itself: that value also feeds
  // `recordNestedStackParameterExpressions` and the record rebuild below,
  // and writing a generated name back into the RECORD would break the
  // very invariant this comment opens with. That the name cannot reach
  // the record is conditional on a FACT ABOUT ROUTING, not on this call:
  // the rebuild honours `createResult.effectiveProperties` (#1682), and
  // every `provisionedBy: 'cc-api'` route returns `CloudControlProvider`,
  // which never reports one. A future CC-routed provider that did would
  // put the generated name into `properties` — fenced by the
  // record-leak case in
  // `tests/unit/deployment/rollback-executor-replay-fallback-name.test.ts`.
  //
  // KNOWN BOUND: the engine's `preparePropertiesForCcApi` prefers an SDK
  // provider's `preparePropertiesForFallback` hook and falls back to
  // `applyDefaultNameForFallback`; this call skips the hook. No provider
  // implements it today (grep: the interface declaration and the engine's
  // dispatch are the only hits), so the two agree — but the first
  // implementor makes rollback mint a different name than deploy.
  const replayCreateProps = (): Record<string, unknown> => ({
    ...(createProvisionedBy === 'cc-api'
      ? applyDefaultNameForFallback(op.logicalId, oldType, resolvedPrevProps)
      : resolvedPrevProps),
  });
  // Issue #4024: the prefix flag the OLD resource was created under,
  // which may not be the failed deploy's. BOTH creates below and the
  // name-holder proof run in it: the proof derives the name the create
  // SENT, so a proof in the failed deploy's scope would name a different
  // one — and could prove the live new resource the holder of a name it
  // never had, then delete it.
  const inOriginalPrefix = replayPrefixScope(
    {
      resourceType: oldType,
      properties: resolvedPrevProps,
      logicalId: op.logicalId,
      physicalId: prev.physicalId,
      via: createProvisionedBy,
      // go-to-k/cdkd#5064 phase 2: the OLD resource's own generation, never
      // the one the replacement moved the record to.
      nameGeneration: nameGenerationOf(prev, op.logicalId),
    },
    logger,
    mask,
    true
  );
  // LAZY, for the same reason the readopt arm resolves inside its `else`
  // (review of issue #2598): `getProviderFor` THROWS for a type this
  // registry cannot route, and THREE paths below never delete anything --
  // the `Retain` warn arm, the collision REFUSAL, and the
  // `adoptedLiveNewResource` arm (whose `else if` skips the delete).
  // Resolved eagerly, any of them could fail on a lookup it never
  // needed, before the re-create is even attempted. Called at each
  // delete site instead; the two sites are mutually exclusive via
  // `!deletedNewFirst`, so at most one lookup runs per op.
  //
  // ONE SEVERITY CHANGE this makes, stated because it is not obvious:
  // at the `deleteNewAfterRecreate` site the call now sits INSIDE that
  // block's `try`, so an unroutable type there degrades to the site's
  // warn-and-count policy (op succeeds, exit 2) where the eager lookup
  // failed the op outright (exit 1). That matches the site's existing
  // treatment of a delete it cannot perform -- the old resource is
  // already re-created and state already points at it -- and the
  // `deleteNewFirst` site is unaffected, since its throw still
  // propagates.
  const resolveNewDeleteRoute = (): {
    provider: ResourceProvider;
    provisionedBy: 'sdk' | 'cc-api' | undefined;
  } =>
    ctx.providerRegistry.getProviderFor({
      resourceType: op.resourceType,
      provisionedBy: current.provisionedBy ?? op.provisionedBy,
    });
  // Issue #2422: what the two deletes of the NEW copy record a guard row with,
  // naming the layer `resolveNewDeleteRoute` actually routed the delete to (a
  // legacy record names none).
  const newDeleteGuardScope = (
    provisionedBy: 'sdk' | 'cc-api' | undefined
  ): RollbackDeleteGuardScope => ({
    ctx,
    stackName,
    resourceType: op.resourceType,
    provisionedBy,
    mask,
  });
  // go-to-k/cdkd#4225: an `AWS::IAM::Policy` rename is journaled with a
  // new physical id (its name), so its rollback reverses it here: the
  // re-create puts the old name, and the delete of the new copy after it
  // removes the new one. A name a completed revert of this replay has put
  // back on a principal (the other half of a swap) is kept. Read live at
  // the removal. The delete-new-FIRST helper passes it too: its collision
  // route never reaches an `AWS::IAM::Policy` (a `Put*Policy` overwrites and
  // never collides), but its delete-first route (go-to-k/cdkd#4690) does,
  // after a `--recreate-via-*` of the policy. A role, group or user delete
  // removes the whole principal.
  const newCopyClaimed = inlinePolicyWriters.claimedFor(
    op.resourceType,
    op.logicalId,
    stateResources
  );

  // go-to-k/cdkd#4604: what either re-create's catch needs to delete a
  // resource that re-create made before failing.
  const recreateCleanup: MarkedRecreateScope = {
    op,
    oldType,
    provider: createProvider,
    // The persisted bag, as the arm's other deletes pass: a delete reads only
    // guard opt-ins, and the resolved one would carry plaintext secrets into a
    // provider call no secret bag is bound around.
    properties: prev.properties,
    deletionPolicy: effectiveDeletionPolicy(oldType, prev.deletionPolicy, prev.properties),
    stateResources,
    region: ctx.region,
    logger,
    mask,
    ctx,
    secrets,
  };
  const scope: ReverseReplacementScope = {
    current,
    prev,
    oldType,
    typeChanged,
    resolvedPrevProps,
    deleteFirstBlocked,
    reverseDeleteFirst,
    createProvider,
    createProvisionedBy,
    replayCreateProps,
    inOriginalPrefix,
    resolveNewDeleteRoute,
    newDeleteGuardScope,
    newCopyClaimed,
    recreateCleanup,
  };
  const { createResult, deletedNewFirst } = await recreateOldResource(s, scope);
  await finishReverseReplacement(s, scope, createResult, deletedNewFirst);
}

/**
 * go-to-k/cdkd#2631: the old resource of a replacement whose delete was not
 * confirmed may still exist, and the read could not tell. Re-creating it blind
 * duplicates it (auto-named) or collides with it (named), so the op is
 * refused, journal kept, before any AWS write. Its own lines
 * (`ownRemedyError`): every value is described or masked, and the pasteable
 * `--orphan` command is the last line.
 */
function survivorUnprovenRefusal(
  s: Pick<ReplayOpScope, 'op' | 'ctx' | 'mask'>,
  oldType: string,
  verdict: 'unreadable' | 'unknown' | 'interrupted' | 'maybe-deleting'
): Error {
  const { op, ctx, mask } = s;
  const remedy = orphanRemedy(op.logicalId, ctx);
  const oldId = op.previousState?.physicalId;
  const oldShown = hasAddressablePhysicalId({ physicalId: oldId })
    ? refusalPhysicalId(mask(String(oldId)))
    : 'no recorded id';
  const rerun = rerunRollbackPhrase(ctx, 'cdkd rollback');
  const why =
    verdict === 'unreadable'
      ? `cdkd has no read for this resource type that can tell whether it does. Re-creating ` +
        `it could duplicate it or collide with it`
      : verdict === 'interrupted'
        ? `the rollback was interrupted before cdkd could read whether it does; re-running ` +
          `${rerun} reads it`
        : verdict === 'unknown'
          ? `cdkd could not read whether it does (the read failed or did not answer in time); ` +
            `re-running ${rerun} reads it again. Re-creating it could duplicate it or collide ` +
            `with it`
          : // go-to-k/cdkd#4911 / go-to-k/cdkd#4946: also a delete that stripped
            // the resource before AWS refused it, so "accepted" is not the only cause.
            `AWS still reports it, but its failed delete may have been accepted and still be ` +
            `running, or only partly ran. Re-adopting it could leave neither resource once a ` +
            `running delete finishes, or one that delete already stripped; once ` +
            `AWS reports it gone, re-running ${rerun} re-creates it. A refused delete is not ` +
            `running, so waiting does not help: if its delete was refused, delete it by hand, ` +
            `then re-run ${rerun}`;
  return ownRemedyError(
    markNonRetryable(
      new CdkdError(
        `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
          `(${refusalResourceType(oldType)}): the deploy did not confirm that it deleted the old ` +
          `resource (${oldShown}), so it may still exist, and ${why}. Nothing was sent and the ` +
          `journal is kept.` +
          (remedy.offered
            ? ` To keep the new resource in its place instead, re-run with the command below, ` +
              `then delete the old resource by hand if it still exists.`
            : '') +
          `${remedy.clause}${describedPhysicalIdPointer(oldShown)}` +
          remedy.line,
        'REPLACED_SURVIVOR_UNPROVEN'
      )
    )
  );
}
