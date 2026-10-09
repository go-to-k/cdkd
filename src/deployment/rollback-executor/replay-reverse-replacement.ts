import { pasteableCommand } from '../../utils/pasteable-command.js';
import type { ResourceCreateResult, ResourceProvider } from '../../types/resource.js';
import { equalIdNamesSameResource } from '../type-change-guard.js';
import { reverseReplacementNewHoldsName } from '../replacement-name-holder.js';
import { samePhysicalId } from '../replacement-name-holder/name-keys.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import { STATEFUL_TYPES } from '../../provisioning/stateful-types.js';
import { applyDefaultNameForFallback } from '../../provisioning/resource-name.js';
import {
  effectiveDeletionPolicy,
  replacementDeletePolicy,
} from '../../provisioning/final-snapshot.js';
import { createdBeforeFailure } from '../../provisioning/auxiliary-failure.js';
import { deleteSkipReason } from '../delete-outcome.js';
import { CdkdError } from '../../utils/error-handler.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import {
  maskSecretsInError,
  noEchoLeavesOf,
  recordNestedStackParameterExpressions,
  recordNoEchoAttributeValues,
  STATE_DERIVED_RULES,
} from '../secret-redaction.js';
import {
  isNameCollisionErrorFrom,
  isNameCooldownError,
  isRecreateRetryableError,
  markNonRetryable,
} from '../retryable-errors.js';
import { redactRollbackRecord } from './replay-secrets.js';
import { resolveReplacementOldType, unroutableReplacementError } from './plan.js';
import {
  requireRestorableBaseline,
  replayPrefixScope,
  ABSENT_BASELINE_SKIP_CAUSE,
} from './names.js';
import {
  safe,
  throwIfDeleteSkipped,
  type RollbackDeleteGuardScope,
  rollbackRetainsNewResource,
  retainedSurvivorMessages,
  rollbackFinalSnapshotId,
  rerunRollbackPhrase,
  replayingStateCreateContext,
  orphanRemedy,
  refusalPhysicalId,
  ownRemedyError,
  refusalLogicalId,
  refusalResourceType,
  describedPhysicalIdPointer,
  collisionLine,
  shownLogicalId,
  recordRollbackSkip,
  rollbackCannotAddress,
  skipUnaddressableReplay,
  retainedSurvivorId,
} from './messages.js';
import { resolveReplayProps, refuseMaskedReplayBaseline } from './replay-props.js';
import { refuseMarkedNoEchoRecreate } from './replay-noecho.js';
import { createWithRollbackRetry, recordedPropertiesAfterReplayCreate } from './replay-retry.js';
import type { ReplayOpScope } from './replay-scope.js';
import { noteRetainedResource } from '../../provisioning/providers/create-token-ledger.js';

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
    afterOp,
    isInterrupted,
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
    (await resolveReplayProps(prev.properties, resolver, secrets, ctx, op.logicalId)) ?? {};
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
    STATE_DERIVED_RULES
  );
  // go-to-k/cdkd#4690: the forward deleted the old resource BEFORE creating
  // the new one, so the reversal deletes the new one first. Re-creating
  // first would collide with the new resource on a uniqueness constraint the
  // name-holder proof cannot attribute (an ELBv2 listener's port), and the
  // reversal would refuse. Not when the new copy is retained: that arm never
  // deletes it, so it keeps the create-first route and its refusal.
  const reverseDeleteFirst =
    op.oldDeletedBeforeCreate === true && !rollbackRetainsNewResource(current);
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
  };

  // Deletes the NEW resource BEFORE the old one is re-created, on both routes
  // that do so: the collision route below, and the delete-first route
  // (go-to-k/cdkd#4690). A failed or skipped delete throws BEFORE the record
  // is dropped, so state still points at the live new resource and the
  // journal is kept for a re-run.
  const deleteNewResourceFirst = async (purpose: string): Promise<void> => {
    const finalSnapshotIdentifier = rollbackFinalSnapshotId(
      op.resourceType,
      current,
      op.provisionedBy
    );
    const deleteNewFirstRoute = resolveNewDeleteRoute();
    const deleteNewFirst = await deleteNewFirstRoute.provider.delete(
      op.logicalId,
      current.physicalId,
      op.resourceType,
      current.properties,
      {
        expectedRegion: ctx.region,
        ...(newCopyClaimed && { inlinePolicyClaimed: newCopyClaimed }),
        ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
        deletionPolicy: replacementDeletePolicy(current.updateReplacePolicy),
        recordedAttributes: current.attributes,
        // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
        recordedNoEchoLeaves: current.noEchoLeaves,
      }
    );
    // Issue #1762: this delete exists to make room for the re-create, so a
    // skip means the re-create below collides — fail the op now, with the
    // cause named, rather than after another full re-create attempt.
    throwIfDeleteSkipped(
      deleteNewFirst,
      op.logicalId,
      current.physicalId,
      purpose,
      newDeleteGuardScope(deleteNewFirstRoute.provisionedBy)
    );
    // Persist the intermediate truth (resource currently absent) so an
    // interrupted re-run doesn't chase a deleted physical id.
    delete stateResources[op.logicalId];
    await afterOp?.(op.logicalId);
  };

  // Re-creates the old resource once the new one is gone.
  const recreateAfterNewDeleted = async (): Promise<ResourceCreateResult> => {
    try {
      // Issue #2032, same two-loop shape as the create-first attempt
      // below. The outer classifier widens to collision-or-cooldown here
      // because the new resource was just deleted (an async delete releases
      // its name late), and the interrupt message mirrors the deploy
      // engine's delete-first fallback: honor SIGINT mid-sleep instead of
      // blocking up to ~64s.
      return await createWithRollbackRetry(
        createProvider,
        () =>
          inOriginalPrefix(() =>
            withCurrentResourceSecrets(secrets, () =>
              createProvider.create(
                op.logicalId,
                oldType,
                replayCreateProps(),
                replayingStateCreateContext(secrets)
              )
            )
          ),
        op.logicalId,
        logger,
        isInterrupted,
        mask,
        {
          isRetryable: isRecreateRetryableError,
          interruptedMessage: 'Rollback interrupted while waiting for the old name to release',
        }
      );
    } catch (recreateError) {
      await deleteMarkedRecreate(recreateError, recreateCleanup);
      // The new resource is already gone — say so, because the resource
      // is now absent from both AWS and state.
      //
      // Issue #2038: masked at CONSTRUCTION, the byte-identical twin of
      // the deploy engine's two `--replace` wraps. The create this catch
      // wraps was handed `resolvedPrevProps`, which `resolveReplayProps`
      // re-resolved to PLAINTEXT, so the AWS message can quote the secret
      // back. Every downstream reader already masks (the per-op catch
      // through the op's `mask`, and `maskedRollbackEventError` for
      // the durable event), so this is defense-in-depth, not a live leak
      // — but leaving the rollback twin bare while arguing the deploy
      // engine's copies deserve the same treatment is the inconsistency,
      // and masking here means the plaintext never exists inside a thrown
      // `Error` for a future reader of the chain to re-open.
      //
      // MEASURED UNFENCEABLE, deliberately kept: deleting this mask
      // leaves the whole unit suite green, exactly as the deploy engine's
      // twins do, because every reader masks independently. Do not record
      // it in a PR body as a tested behavior.
      throw new Error(
        mask(
          `Failed to re-create the old ${safe(op.logicalId)} after the new resource ` +
            `(${mask(current.physicalId)}) was already deleted: ` +
            `${displaySafe(recreateError instanceof Error ? recreateError.message : String(recreateError))}. ` +
            // No command on this line (go-to-k/cdkd#4214): it carries
            // the provider's text and the new physical id.
            `The resource is now absent — fix forward by re-deploying the stack.`
        ),
        // Issue #2616's sweep reached this third site: without a `cause`
        // the wrap is the LAST link, so `extractDeploymentEventError`
        // walks a chain with no `$metadata` and the persisted event
        // names no AWS code. Masked for the same reason the message is.
        {
          cause: maskSecretsInError(
            recreateError instanceof Error ? recreateError : undefined,
            secrets
          ),
        }
      );
    }
  };

  // Otherwise create-first (the old resource's revival is the point). A
  // user-supplied physical name still held by the NEW resource collides
  // — delete the new one first, then retry the create with a bounded
  // collision retry (async deletes release the name late), mirroring the
  // deploy engine's --replace delete-first fallback.
  //
  // The new resource is deleted ONLY when the create-first attempt fails
  // with a name collision AND its record proves it holds that name
  // (issue #3979, `reverseReplacementNewHoldsName` in the catch below).
  // The collision alone never sufficed: an orphan a failed attempt left
  // (#1710, #3972), a replayed create (#3978) or a squatter on a
  // predictable name collides identically, and deleting the new resource
  // then destroys a live resource that never held the name. Issue #3199
  // made the replay ask for the deterministic `<stack>-<logicalId>` of a
  // `FALLBACK_NAME_RULES` type, so such a replay CAN collide — with the
  // live new resource (the ordinary case for a replacement that kept the
  // generated name, which the proof accepts through the new resource's
  // physical id) or with anything else (refused).
  let deletedNewFirst = false;
  // Typed as the full provider contract (issue #1682): the narrower
  // local shape this used to declare hid `effectiveProperties`, so the
  // record rebuild below could not honour it even in principle.
  let createResult: ResourceCreateResult;
  if (reverseDeleteFirst) {
    // go-to-k/cdkd#4690: the forward deleted the old resource before it
    // created the new one, so the reversal runs in the same order. The new
    // resource is this op's own record, so no holder proof is needed; the
    // risk accepted is the forward's own: a re-create that then fails leaves
    // the resource absent, and the error below says so.
    logger.info(
      `  Rollback: the replacement deleted the old resource before creating the new one — ` +
        safeMsg`deleting the new resource (${mask(current.physicalId)}) first...`
    );
    await deleteNewResourceFirst(
      'while clearing the new resource before re-creating the old one (the replacement deleted the old one first)'
    );
    deletedNewFirst = true;
    createResult = await recreateAfterNewDeleted();
  } else {
    try {
      // The initial create-first attempt retries ONLY the SQS name
      // cooldown (issue #1206): the forward replacement deleted the OLD
      // name moments ago (create-then-destroy with a changed name), so a
      // rollback within 60s deterministically hits QueueDeletedRecently.
      // A genuine collision must NOT be retried here — it falls through
      // to the delete-new-first fallback below instead.
      // Issue #2032: BOTH loops live in the helper — an inner
      // default-schedule retry so an IAM propagation error still gets the
      // dense schedule the outer classifier + explicit knobs disable, and
      // the outer cooldown retry below it. The helper also owns the
      // `disableOuterRetry` guard for both.
      createResult = await createWithRollbackRetry(
        createProvider,
        () =>
          inOriginalPrefix(() =>
            withCurrentResourceSecrets(secrets, () =>
              createProvider.create(
                op.logicalId,
                oldType,
                replayCreateProps(),
                replayingStateCreateContext(secrets)
              )
            )
          ),
        op.logicalId,
        logger,
        isInterrupted,
        mask,
        {
          isRetryable: isNameCooldownError,
          interruptedMessage: 'Rollback interrupted while waiting out the name cooldown',
        }
      );
    } catch (createError) {
      const deletedMade = await deleteMarkedRecreate(createError, recreateCleanup);
      const msg = createError instanceof Error ? createError.message : String(createError);
      // Reads the ERROR, not the rendered message (issue go-to-k/cdkd#3208):
      // ELBv2 states the collision in prose this predicate cannot see, and
      // the exception NAME that does say it is dropped by the provider wrap.
      // Without it this arm went inert for those types, exactly like the
      // deploy engine's --replace twin.
      const nameCollision = isNameCollisionErrorFrom(createError, op.logicalId);
      // A collision this create's own earlier attempt caused (the mark carried
      // across its retry) was just cleared by deleting that resource: the arms
      // below would blame another holder, so fail the op here and let a re-run
      // create it.
      if (!nameCollision || deletedMade) throw createError;
      // Issue #3979, ahead of every other arm: each of them — the delete
      // below, and the Retain refusal's "held by the new one" — presumes
      // the NEW resource holds the name the re-create collided on. The
      // classifier cannot say WHO holds it: an orphan an earlier failed
      // create left, a replayed create, or a resource made outside the
      // stack collides identically, and deleting the new resource then
      // destroys a live resource that never held the name and collides
      // again. So prove the holder from the two records, and refuse when
      // it is not proven. It subsumes the #3892 Glue guard (a table in
      // another database is a different scope).
      const holder = inOriginalPrefix(() =>
        reverseReplacementNewHoldsName({
          oldResourceType: oldType,
          newResourceType: op.resourceType,
          // What the create SENT: on a Cloud Control route that already
          // carries the generated name (`replayCreateProps`). An SDK provider
          // mints its own for a nameless bag; `generated` is cdkd's rule for
          // it, which the helper uses only for a type whose provider was
          // audited to mint it verbatim, and treats as undecided on a
          // mismatch. The `typeof` gate: a
          // non-string id (an in-process op the journal parser never saw)
          // must reach the refusal, not throw in the name generator.
          requested: replayCreateProps(),
          generated:
            typeof op.logicalId === 'string'
              ? applyDefaultNameForFallback(op.logicalId, oldType, resolvedPrevProps)
              : undefined,
          // A provider that REWRITES even an explicit name derives it in this
          // async scope (stack name, prefix flag), so the helper derives it
          // here too, from the logical id for a nameless bag (#4018's shape).
          logicalId: op.logicalId,
          createdVia: createProvisionedBy,
          mask,
          recorded: current.properties,
          observed: current.observedProperties,
          physicalId: current.physicalId,
        })
      );
      if (!holder.holds) {
        const remedy = orphanRemedy(op.logicalId, ctx);
        const oldShown = refusalPhysicalId(mask(prev.physicalId));
        throw ownRemedyError(
          markNonRetryable(
            new CdkdError(
              // Masked at construction, like the Retain refusal below:
              // the diagnosis quotes names from the PLAINTEXT replay bag.
              mask(
                `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
                  `(${refusalResourceType(op.resourceType)}): ` +
                  // The diagnosis is on a line of its own below
                  // (go-to-k/cdkd#4214): it quotes names from the replay
                  // bag in JSON quotes, and this line names `cdkd
                  // rollback`, so a `$( )` name would run beside it when
                  // pasted into zsh.
                  `the re-create of the old resource (${oldShown}) collided (why is on the ` +
                  `Collision diagnosis line below) — so ` +
                  // Undecided: the diagnosis already says what cdkd cannot
                  // show, so the clause only states the consequence (the
                  // deploy engine's `--replace` twin words it the same way).
                  (holder.known
                    ? `another resource holds the colliding name`
                    : `if another resource holds the name it collided on`) +
                  ` (an orphan of an earlier attempt, or one made outside this stack), ` +
                  `deleting the new resource would destroy it and collide again. Nothing was ` +
                  `deleted. Remove or rename whatever holds that name if it is yours — if that is ` +
                  `the new resource itself, delete it by hand — then re-run `
              ) +
                // The re-run COMMAND stays outside the mask too, like the
                // `--orphan` line below (review of #4099): a short id
                // needle would otherwise cut into it.
                rerunRollbackPhrase(ctx, 'cdkd rollback') +
                mask(
                  `, which proceeds: the journal is kept, so the revert resumes from here.` +
                    (remedy.offered
                      ? ` To leave THIS resource alone and let the rest of the rollback ` +
                        `proceed, re-run with the command below.`
                      : '') +
                    `${remedy.clause}${describedPhysicalIdPointer(oldShown)}` +
                    `\nCollision diagnosis: ${holder.diagnosis}` +
                    `\nUnderlying collision: ${collisionLine(mask(msg))}`
                ) +
                // OUTSIDE the mask (review of #4099): it carries only the
                // vetted logical id, and a short secret-derived id needle
                // would otherwise cut into the pasteable `--orphan` command.
                remedy.line,
              'NAMED_REPLACEMENT_COLLISION',
              maskSecretsInError(createError instanceof Error ? createError : undefined, secrets)
            )
          )
        );
      }
      if (rollbackRetainsNewResource(current)) {
        // Issue #2598: the ONE arm where honouring `Retain` cannot also
        // complete the op. This delete exists solely to release the NAME
        // the re-create just collided on, so with the holder pinned in
        // place the old resource can never be re-created — and deleting it
        // anyway is exactly the destruction of a resource the user marked
        // to survive that this issue is about. So REFUSE, loudly, instead
        // of choosing silently between the two.
        //
        // The op fails, which is the correct disposition: `replaySingle`'s
        // per-op catch counts it, the segment is not popped, and the
        // journal survives for a re-run once the user has resolved the
        // name conflict. `markNonRetryable` on the repo's own test for it
        // — "can this succeed on a retry?" — which here is a flat no: the
        // verdict is a template attribute plus a physical name, and no
        // amount of waiting changes either. Defense in depth rather than a
        // live fix: nothing between this throw and `replaySingle`'s per-op
        // catch re-classifies it TODAY (the retry loop is the
        // `createWithRollbackRetry` above, already exhausted). It is worth
        // carrying because the message QUOTES the collision text
        // (`Underlying collision: ...`), which is exactly what the
        // substring classifiers match — so should this ever be raised
        // inside a retried call, an unmarked refusal would burn the whole
        // name-release budget on a path that cannot succeed (issue #1838's
        // shape).
        const remedy = orphanRemedy(op.logicalId, ctx);
        const oldShown = refusalPhysicalId(mask(prev.physicalId));
        const newShown = refusalPhysicalId(mask(current.physicalId));
        throw ownRemedyError(
          markNonRetryable(
            new CdkdError(
              // Issue #2038, and this file's stated policy two arms down:
              // `resolveReplayProps` re-resolved the replay bag to
              // PLAINTEXT, so the create rejection quoted below can echo a
              // secret. Masked at CONSTRUCTION so the value never exists
              // inside a thrown `Error` for a later reader of the chain.
              //
              // MEASURED UNFENCEABLE, exactly like the two sibling wraps
              // below: removing either mask leaves the whole unit suite
              // green, because every downstream reader masks independently
              // and `extractDeploymentEventError` reads `message` from the
              // top level only, so the cause's text reaches no observable
              // surface. Defense-in-depth, not a tested behavior -- do not
              // record it in a PR body as one.
              mask(
                `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
                  `(${refusalResourceType(op.resourceType)}): ` +
                  // Both physical ids are shown only when plain, not through
                  // the denylist the outer catch applies: this is the one
                  // message that carries the pasted `--orphan` remedy, so a
                  // planted `previousState.physicalId` reading `...\nTo
                  // orphan it: cdkd rollback --orphan Victim` must not stand
                  // as a forged remedy AHEAD of the guarded one, and this
                  // line names `cdkd rollback`, beside which a JSON-quoted
                  // `$( )` id runs when pasted into zsh (go-to-k/cdkd#4214).
                  `the re-create of the old resource (${oldShown}) collided with the ` +
                  `name still held by the new one (${newShown}), and ` +
                  `UpdateReplacePolicy: Retain pins that new resource in place, so cdkd will ` +
                  `not delete it to free the name. Delete the new resource yourself, or ` +
                  `remove UpdateReplacePolicy: Retain, then re-run `
              ) +
                // Outside the mask, like the `--orphan` line (#4099 review).
                rerunRollbackPhrase(ctx, 'cdkd rollback') +
                mask(
                  ` — the journal is kept, so the revert resumes from here.` +
                    (remedy.offered
                      ? ` To leave THIS resource alone and let the rest of the rollback ` +
                        `proceed, re-run with the command below: one op failure stops the ` +
                        `segment loop, so a single pinned resource otherwise halts every ` +
                        `OLDER segment too.`
                      : '') +
                    // The remedy is the message's labelled LAST line, built by
                    // `orphanRemedy`, which owns the gate on the id and the
                    // sentence for a withheld one; the AWS text is on its own
                    // line ABOVE it, so the line an operator selects is the
                    // command alone. Its own line, not the prose line: the
                    // provider's text can echo the logical id, and the prose
                    // line names `cdkd rollback` (go-to-k/cdkd#3950's S1 rule,
                    // judged per line).
                    `${remedy.clause}${describedPhysicalIdPointer(oldShown, newShown)}` +
                    `\nUnderlying collision: ${collisionLine(mask(msg))}`
                ) +
                // OUTSIDE the mask (review of #4099): it carries only the
                // vetted logical id, and a short secret-derived id needle
                // would otherwise cut into the pasteable `--orphan` command.
                remedy.line,
              'NAMED_REPLACEMENT_COLLISION',
              // The CHAIN is masked too: downstream masking only reaches a
              // top-level message, and the cause is what carries the AWS
              // rejection text a reader re-opens.
              maskSecretsInError(createError instanceof Error ? createError : undefined, secrets)
            )
          )
        );
      }
      logger.info(
        `  Rollback: re-create collided with the new resource's name — deleting the new ` +
          `resource (${displaySafe(mask(current.physicalId))}) first...` +
          // Issue #2668: a Type change reaches here only between two types
          // `reverseReplacementNewHoldsName` knows share a name space.
          (typeChanged
            ? ` (this op changed the resource's Type, ${safe(op.resourceType)} -> ` +
              `${safe(oldType)}, which share a name space)`
            : '')
      );
      await deleteNewResourceFirst(
        'while clearing the new resource so the old one could be re-created'
      );
      deletedNewFirst = true;
      createResult = await recreateAfterNewDeleted();
    }
  }

  // Issue #1247 — rollback sibling of the deploy engine's #1238
  // NAMED_REPLACEMENT_IDEMPOTENT_CREATE guard: a name-idempotent Create
  // API does NOT collide when the NEW resource still holds the same
  // user-supplied name — it silently returns the LIVE new resource's
  // physicalId as the "re-created old" one. Since deletedNewFirst is
  // false on this path, the delete-new step below would then delete the
  // very resource this op just recorded in state. Skip the delete and
  // ADOPT the live resource (warn + exit-2 warning) instead of
  // hard-failing:
  // - Rollback is a RECOVERY flow: failing the segment would block the
  //   segment pop and strand the user in a replay loop that can never
  //   succeed (every re-run re-classifies the op as reverse-replacement
  //   and hits the same idempotent create), while adopting keeps the
  //   resource alive and lets the rollback settle.
  // - Re-applying the old properties via provider.update() is
  //   deliberately NOT attempted: the op was classified
  //   reverse-replacement precisely because the reverted property is
  //   immutable in place, so that update would throw the very
  //   immutable-property error this branch exists to avoid.
  // - Auto-falling-back to delete-new-first + re-create (the collision
  //   path above) is also NOT done: on a collision the Create THREW, so
  //   deleting the name holder is the only way to finish the revert —
  //   here the Create RETURNED the only live copy, and deleting it on
  //   speculation risks total resource loss if the re-create then fails
  //   (and, unlike deploy, rollback has no --replace-style opt-in to
  //   accept that risk).
  // State is rebuilt from previousState below (the intended
  // post-rollback record), so the not-re-applied properties surface via
  // `cdkd drift` / the next `cdkd deploy` for reconciliation. When
  // deletedNewFirst is true the same-id outcome is the EXPECTED result
  // (re-acquiring the name after the new resource is gone) — exempt,
  // mirroring the deploy-side guard's delete-first exemption.
  //
  // Issue #2668: across a Type change an equal id is a coincidence of two
  // namespaces — the re-create was genuine, and skipping the delete-new
  // step would leave the new type's resource alive and untracked. The
  // custom-resource family is the exception (`equalIdNamesSameResource`
  // has the reasoning): there the equal id IS the live resource, and the
  // delete-new step would destroy what this op just restored.
  // The predicate is symmetric in its two types; `createLayer` is the
  // layer of THIS operation's create half, which on a replay is the
  // re-create of the old resource.
  // Issue #4037: the id the re-create returned spells the old name too
  // (for a rewriting type, under the setting it ran with; for an ARN,
  // inside it), so it joins the masker before any line below names it.
  opMasker.addNamed({
    resourceType: oldType,
    properties: resolvedPrevProps,
    logicalId: op.logicalId,
    physicalIds: [createResult.physicalId],
  });
  const equalIdIsSameResource = equalIdNamesSameResource({
    oldType,
    newType: op.resourceType,
    createLayer: createProvisionedBy,
    // Issue #3892: what the re-create restored, against the record of
    // the live new resource.
    oldProperties: prev.properties,
    newProperties: current.properties,
    physicalId: current.physicalId,
  });
  const adoptedLiveNewResource =
    equalIdIsSameResource && !deletedNewFirst && createResult.physicalId === current.physicalId;
  if (adoptedLiveNewResource) {
    // Named only when plain, described otherwise: this line names
    // `cdkd deploy`, and the physical id used to print through the bare
    // denylist, where even a `;` ran when pasted (go-to-k/cdkd#4214).
    const liveShown = refusalPhysicalId(mask(current.physicalId));
    logger.warn(
      `  ⚠ ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}): ` +
        `the re-create returned the LIVE new ` +
        `resource (${liveShown}) instead of re-creating the old ` +
        `one — its ` +
        `Create API is name-idempotent and the new resource still holds the same ` +
        `user-supplied name. Skipping the delete-new step (it would delete that very ` +
        `resource). The old resource's ORIGINAL properties may NOT have been re-applied; ` +
        `state now records the pre-replacement properties, so inspect the drift and ` +
        `run 'cdkd deploy' to reconcile, or rename the resource to make the replacement ` +
        `reversible.${describedPhysicalIdPointer(liveShown)}` +
        // `--stack-region` for the same reason the destroy hints carry
        // it: without it `cdkd drift` resolves every region holding this
        // name. Read-only, so no data loss — but it reports on records
        // the message never named (go-to-k/cdkd#3499 review nits).
        `\nInspect it with: ${
          pasteableCommand('cdkd drift', [
            { value: stackName, hole: 'stack' },
            { flag: '--stack-region', value: ctx.region, hole: 'region' },
          ]).command
        }`
    );
    result.warnings++;
  }

  // Rebuild the record from the previous state, but NEVER carry the
  // OLD physical resource's attributes / observedProperties over — the
  // re-created resource has fresh identifiers (ARNs etc.), and stale
  // cached attributes would poison later Fn::GetAtt resolution and
  // drift comparison. Mirrors the deploy engine's replacement path,
  // which constructs the record fresh from the create result — including
  // the provider's `effectiveProperties` (issue #1682), which replaces
  // the previous record's `properties` when it reported one.
  const { observedProperties: _staleObserved, ...prevRecord } = prev;
  // Redact resolved secret plaintext back out (GHSA fix): the create
  // result's `effectiveProperties` can echo the value we resolved for the
  // re-CREATE, so scrub the rebuilt record before it is persisted.
  //
  // The create's `NoEcho` declaration becomes needles first
  // (go-to-k/cdkd#4434), as the deploy engine's create registers it: the
  // attributes below are the create's, so a custom resource answering
  // `NoEcho: true` (or a nested stack's masked outputs) would otherwise land
  // in the record in the clear.
  recordNoEchoAttributeValues(createResult, secrets, resolvedPrevProps);
  stateResources[op.logicalId] = redactRollbackRecord(
    {
      ...prevRecord,
      physicalId: createResult.physicalId,
      attributes: createResult.attributes ?? {},
      properties: recordedPropertiesAfterReplayCreate(prevRecord, createResult),
    },
    secrets,
    prevRecord.properties
  );
  // go-to-k/cdkd#4225: the re-create put the old resource's inline
  // policies, as the deploy's replacement create does. A re-create that
  // returned the live NEW resource is not counted: its record may not
  // describe what is live. (No claim type reaches that arm: an
  // `AWS::IAM::Policy` re-create of a rename has a new id, and a role,
  // group or user create is not name-idempotent.)
  if (!adoptedLiveNewResource) {
    inlinePolicyWriters.record(
      op.logicalId,
      'create',
      stateResources[op.logicalId]!,
      false,
      createProvisionedBy
    );
  }
  await afterOp?.(op.logicalId);

  // Survivor record for this arm's retain branch -- see the twin binding
  // in `reverse-replacement-readopt` above for why the EVENT, not the
  // warn, is what the user is left with.
  let survivorReason: string | undefined;
  // go-to-k/cdkd#4628: the record's id may be unaddressable here.
  const survivorId = retainedSurvivorId(current, op);
  if (!deletedNewFirst && !adoptedLiveNewResource && rollbackRetainsNewResource(current)) {
    // Issue #2598: the ordinary create-first path — the old resource is
    // already re-created and state already points at it, so honouring
    // `UpdateReplacePolicy: Retain` on the new copy costs nothing and
    // completes the revert. This site's existing policy for a delete it
    // does not perform is warn-and-count (see the `catch` below and the
    // `adoptedLiveNewResource` arm above), and a retained copy is the
    // same user-visible outcome: a live resource cdkd no longer tracks.
    const survivorMessages = retainedSurvivorMessages(
      op.logicalId,
      op.resourceType,
      survivorId ?? 'no recorded id',
      `State records the re-created old resource ` +
        `(${stateResources[op.logicalId]?.physicalId ?? prev.physicalId}).`,
      mask
    );
    logger.warn(survivorMessages.warn);
    survivorReason = survivorMessages.reason;
    result.warnings++;
    // go-to-k/cdkd#4438: the retained copy still holds this stack's create
    // token, so the stack's next create of the logical id must not send it.
    await noteRetainedResource(op.resourceType, op.logicalId);
  } else if (!deletedNewFirst && !adoptedLiveNewResource) {
    try {
      const finalSnapshotIdentifier = rollbackFinalSnapshotId(
        op.resourceType,
        current,
        op.provisionedBy
      );
      const deleteNewAfterRecreateRoute = resolveNewDeleteRoute();
      const deleteNewAfterRecreate = await deleteNewAfterRecreateRoute.provider.delete(
        op.logicalId,
        current.physicalId,
        op.resourceType,
        current.properties,
        {
          expectedRegion: ctx.region,
          ...(newCopyClaimed && { inlinePolicyClaimed: newCopyClaimed }),
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          deletionPolicy: replacementDeletePolicy(current.updateReplacePolicy),
          recordedAttributes: current.attributes,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: current.noEchoLeaves,
        }
      );
      // Issue #1762: the old resource is already re-created and state
      // already points at it, so the site's existing policy for a
      // FAILED delete applies to a skip too — warn, count it, and tell
      // the user the new resource is now untracked. Thrown into that
      // same catch so the two outcomes cannot drift apart.
      throwIfDeleteSkipped(
        deleteNewAfterRecreate,
        op.logicalId,
        current.physicalId,
        'while deleting the new resource after re-creating the old one',
        newDeleteGuardScope(deleteNewAfterRecreateRoute.provisionedBy)
      );
    } catch (deleteError) {
      // Issue #2038: this arm runs AFTER `resolveReplayProps` resolved
      // this op's secrets to plaintext, so the AWS message is masked with
      // the op's masker like every other site on the path. The delete's
      // own bag is the state record (redacted), but a provider is free to
      // echo the properties it was re-created with, so masking here is
      // not speculative; and the new resource's id is masked even when
      // nothing was resolved, if its name is a secret reference (#4037).
      logger.warn(
        mask(
          `  Rollback: old ${safe(op.logicalId)} re-created, but deleting the new resource ` +
            `(${displaySafe(mask(current.physicalId))}) failed: ` +
            `${displaySafe(deleteError instanceof Error ? deleteError.message : String(deleteError))}. ` +
            `Delete it manually — it is no longer tracked in state.`
        )
      );
      // Same class as the `Retain` arm above, and the reason this
      // binding is not named for `Retain` (security review): state
      // already points at the re-created OLD resource, the new copy is
      // alive, and cdkd no longer tracks it -- an orphan by outcome
      // rather than by policy. Until this was set the event emitted with
      // the binding still `undefined`, so `cdkd events` showed a clean
      // SUCCEEDED naming nothing and the id died with the terminal.
      //
      // NOT masked here: the event site below runs the op's `mask`
      // over this binding, exactly as it does for the `Retain` arms.
      // Masking twice is a no-op but reads as though one of the two were
      // load-bearing.
      survivorReason =
        `The replacement's new ${op.resourceType} (${current.physicalId}) could not be ` +
        `deleted after the old resource was re-created: ` +
        `${deleteError instanceof Error ? deleteError.message : String(deleteError)}. ` +
        `It is live, still billing, and no longer tracked by cdkd — delete it yourself.`;
      result.warnings++;
    }
  }
  // Issue #4037: the re-created id is the OLD name's spelling, which the
  // literal mask misses when a rewriting provider derived it.
  const recreatedId = displaySafe(mask(String(createResult.physicalId)));
  logger.info(
    mask(
      adoptedLiveNewResource
        ? `  Rollback: ${safe(op.logicalId)} adopted the live resource (${recreatedId}) ` +
            `— replacement NOT fully reversed (name-idempotent Create API)`
        : `  Rollback: ${safe(op.logicalId)} replacement reversed (old resource re-created as ` +
            `${recreatedId})`
    )
  );
  // The SURVIVOR's layer, same reasoning as the readopt twin above --
  // including why there is no `?? op.provisionedBy`: the unconditional
  // spread below already covers a record that carries no layer.
  const survivorProvisionedBy = current.provisionedBy;
  ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
    stackName,
    operation: 'UPDATE',
    logicalId: op.logicalId,
    resourceType: op.resourceType,
    ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
    // Gated on the retain branch for the same reason as the twin above:
    // on every other path through this arm the new copy was DELETED, and
    // naming it here would point a cleanup pass at a dead id. The layer
    // is gated with them -- on those paths the event describes the OP,
    // whose own layer is the right one to report.
    ...(survivorReason !== undefined && {
      ...(survivorId !== undefined && { physicalId: survivorId }),
      reason: mask(survivorReason),
      ...(survivorProvisionedBy && { provisionedBy: survivorProvisionedBy }),
    }),
    // go-to-k/cdkd#3338: the replacement was NOT fully reversed, which the
    // warn above is otherwise the only trace of. No `physicalId`: the live
    // resource is the one state now records, so nothing is untracked.
    ...(adoptedLiveNewResource && {
      reason: mask(
        `The re-create returned the live new resource instead of re-creating the old one ` +
          `(its Create API is name-idempotent), so the replacement was NOT fully reversed: ` +
          `the old resource's original properties may not have been re-applied. Inspect it ` +
          `with \`cdkd drift\` and run \`cdkd deploy\` to reconcile.`
      ),
    }),
  });
  return;
}

/** What {@link deleteMarkedRecreate} needs from the reverse-replacement arm. */
interface MarkedRecreateScope {
  op: ReplayOpScope['op'];
  /** The OLD resource's type: what the re-create made. */
  oldType: string;
  /** The provider the re-create ran through, which deletes what it made. */
  provider: ResourceProvider;
  properties: Record<string, unknown> | undefined;
  /** The old record's effective `DeletionPolicy`. */
  deletionPolicy: string | undefined;
  stateResources: ReplayOpScope['stateResources'];
  region: string;
  logger: ReplayOpScope['logger'];
  mask: ReplayOpScope['mask'];
}

/**
 * go-to-k/cdkd#4604: a rollback's re-create of the OLD resource whose provider
 * proved it made the resource before failing (`markCreatedBeforeFailure`).
 * Nothing will record it: no state record names it and this rollback is
 * consuming the journal. The proof says this very call made it, so it is
 * deleted here, through the provider that made it — not recorded as a
 * rollback orphan, which the next deploy would ADOPT as the old resource
 * although its configuration is the half-applied one the create failed on.
 * Kept, and named for the user, when the old record's `DeletionPolicy` is
 * `Retain` or `Snapshot` (no snapshot is taken of a resource the rollback
 * never finished making) or the delete does not complete. Never deletes a
 * physical id a state record of that type holds. Never throws: the
 * re-create's own failure is what the caller rethrows. Returns whether it
 * deleted the resource.
 */
async function deleteMarkedRecreate(error: unknown, s: MarkedRecreateScope): Promise<boolean> {
  const madeId = createdBeforeFailure(error, s.op.logicalId, s.oldType);
  if (madeId === undefined) return false;
  const shown = `${shownLogicalId(s.op.logicalId)} (${refusalResourceType(s.oldType)})`;
  const id = s.mask(madeId);
  // Under the type's case rule (go-to-k/cdkd#4692).
  if (
    Object.values(s.stateResources).some(
      (r) =>
        r?.resourceType === s.oldType &&
        typeof r.physicalId === 'string' &&
        samePhysicalId(s.oldType, r.physicalId, madeId)
    )
  ) {
    return false;
  }
  if (s.deletionPolicy === 'Retain' || s.deletionPolicy === 'Snapshot') {
    s.logger.warn(
      safeMsg`  Rollback: the failed re-create of ${shown} made ${id} before failing; ` +
        safeMsg`it is left in AWS (DeletionPolicy: ${s.deletionPolicy}) and no record holds it — delete it yourself if it is not needed`
    );
    return false;
  }
  s.logger.info(
    safeMsg`  Rollback: deleting ${id}, which the failed re-create of ${shown} made before failing`
  );
  let failure: string | undefined;
  try {
    const outcome = await s.provider.delete(s.op.logicalId, madeId, s.oldType, s.properties, {
      expectedRegion: s.region,
      deletionPolicy: 'Delete',
    });
    failure = deleteSkipReason(outcome);
  } catch (deleteError) {
    failure = deleteError instanceof Error ? deleteError.message : String(deleteError);
  }
  if (failure === undefined) return true;
  s.logger.warn(
    safeMsg`  Rollback: could not delete ${id}, which the failed re-create of ${shown} made before ` +
      safeMsg`failing (${s.mask(failure)}); no record holds it — delete it yourself`
  );
  return false;
}
