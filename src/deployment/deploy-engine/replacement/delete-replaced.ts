/**
 * The delete of the OLD resource after a create-first replacement
 * (`deleteReplacedAfterCreate`).
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import type { NoEchoDeleteValues } from '../../noecho-delete-reresolution.js';
import { secretNameBagFor } from '../masking.js';
import type { ResourceDeleteResult, ResourceProvider } from '../../../types/resource.js';
import type { ResourceState, SupersededResourceRecord } from '../../../types/state.js';
import {
  SUPERSEDED_KEPT_REMEDY,
  addSuperseded,
  canRecordSuperseded,
  deleteNeedsThisRunsNoEchoValues,
  isInlinePolicyType,
  removeSuperseded,
  retryWhileInUse,
} from '../../superseded-resources.js';
import { ATOMIC_FINAL_SNAPSHOT_TYPES } from '../../../provisioning/final-snapshot.js';
import { green } from '../../../utils/colors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import { deleteSkipReason, deleteSkippedMessage } from '../../delete-outcome.js';
import {
  DEFERRAL_IDENTITY_TIMEOUT_MS,
  SURVIVOR_LIVE_READ_TYPES,
  readDeferralIdentity,
  replacedDeleteFailureVerdict,
} from '../../rollback-executor/replaced-survivor.js';
import type { SurvivorIdentityRead } from '../../../types/resource.js';
import { reportDeleteGuards } from '../../delete-guard-scope.js';
import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';
import { isStandaloneInlinePolicyType } from '../../inline-policy-claims.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import {
  type RecordedSecretValues,
  createUnionSecretMasker,
  maskSecretsInText,
} from '../../secret-redaction.js';
import {
  owesPreDeleteSnapshot,
  replacementDeleteContext,
  takePreDeleteSnapshot,
} from './delete-context.js';
import type { ReplacementRunState, ReplacementDeps } from './run-state.js';

/**
 * The delete of a replaced resource once its replacement EXISTS.
 *
 * Inside a deploy it is DEFERRED to the cleanup phase (go-to-k/cdkd#6374),
 * as CloudFormation deletes replaced resources only after every other change
 * succeeded: the resources referencing the old one have not moved yet, and
 * deleting a container can take its children with it (a schedule group's
 * delete deletes its schedules). A failed deploy never sends it, so the
 * rollback finds the old resource whole (`'deferred'`) and takes it back.
 * The old record is kept in state until then (`recordSupersededForDeferral`,
 * go-to-k/cdkd#5111), so a deploy killed first leaves it for the next deploy
 * or `cdkd destroy`; a custom resource whose delete needs this run's NoEcho
 * values waits in memory only (go-to-k/cdkd#6445). Under
 * `UpdateReplacePolicy: Snapshot` the deferred delete takes the final
 * snapshot: through the delete call for RDS and the like, or right before it
 * for a type snapshotted before its delete (go-to-k/cdkd#6463). Where the
 * delete still runs inline, and why, is `deferToCleanupPhase`'s.
 *
 * A failure
 * or a skip warns rather than fails the resource (issue #1762): the new
 * resource is created and about to be recorded, so the old one is untracked
 * either way, and failing here would roll back a replacement that
 * succeeded. Neither is recorded as a retention: both mark the old resource
 * as one that may survive (`replacedOldMaySurvive`, go-to-k/cdkd#2631), so a
 * rollback reads AWS for it before re-creating it. The delete
 * error is masked with `secrets` BEFORE it is rendered: a provider can echo
 * a resolved value.
 */
export async function deleteReplacedAfterCreate(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResourceType: string,
  currentResource: ResourceState,
  deleteProvider: ResourceProvider,
  deleteProperties: Record<string, unknown>,
  finalSnapshotIdentifier: string | undefined,
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  secrets: RecordedSecretValues,
  /** The layer `deleteProvider` was routed to, for a guard row (issue #2422). */
  deleteProvisionedBy: 'sdk' | 'cc-api' | undefined,
  /** go-to-k/cdkd#4682: today's values at the old record's NoEcho coordinates. */
  noEchoDeleteValues?: NoEchoDeleteValues,
  /** go-to-k/cdkd#4900: the post-DAG retry, which warns rather than defers. */
  isRetry = false,
  /**
   * Whether the new resource has the old one's physical id AND type (a Glue
   * table moved to another database keeps its id). The old resource's
   * superseded record would then be dropped at the row's save as held by a
   * same-type record, so it is deleted inline as before (go-to-k/cdkd#6374).
   * An equal id under another type (a Type change) is two resources and
   * defers as usual.
   */
  newHoldsOldIdAndType = false
): Promise<void> {
  if (
    !isRetry &&
    !newHoldsOldIdAndType &&
    deferToCleanupPhase(run, deps, logicalId, currentResource, updateReplacePolicy, {
      finalSnapshotIdentifier,
      noEchoDeleteValues,
    })
  ) {
    run.replacedOldMaySurvive.set(logicalId, 'deferred');
    // go-to-k/cdkd#6621: the generation a rollback re-adopting it must find
    // (one read, on a replacement of a global-name type only).
    const identity = await readDeferralIdentity(
      deps.providerRegistry(),
      oldResourceType,
      currentResource.physicalId,
      deps.stackRegion
    );
    if (identity !== undefined) run.replacedOldIdentity.set(logicalId, identity);
    else run.replacedOldIdentity.delete(logicalId);
    run.deferredReplacedDeletes?.set(logicalId, {
      physicalId: currentResource.physicalId,
      resourceType: oldResourceType,
      provisionedBy: deleteProvisionedBy,
      failureMessage: undefined,
      cleanupPhase: true,
      ...(currentResource.dependencies !== undefined && {
        dependencies: currentResource.dependencies,
      }),
      retry: () =>
        deleteReplacedAfterCreate(
          run,
          deps,
          logicalId,
          oldResourceType,
          currentResource,
          deleteProvider,
          deleteProperties,
          finalSnapshotIdentifier,
          updateReplacePolicy,
          secrets,
          deleteProvisionedBy,
          noEchoDeleteValues,
          true
        ),
    });
    deps.logger.info(
      safeMsg`  Old ${logicalId} (${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)}) is deleted after the rest of the deploy succeeds`
    );
    return;
  }
  if (!isRetry) {
    deps.logger.info(
      safeMsg`  Deleting old ${logicalId} (${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)})...`
    );
  } else if (
    !(await journaledHolderIsOurs(run, deps, logicalId, oldResourceType, currentResource))
  ) {
    return;
  }
  // go-to-k/cdkd#6463: a pre-delete-snapshot type's snapshot is taken here,
  // right before the delete is sent, inline or in the cleanup phase; the
  // identifier only marks it as owed, so the delete itself carries none (a
  // Cloud Control delete refuses one).
  let sentSnapshotIdentifier = finalSnapshotIdentifier;
  if (owesPreDeleteSnapshot(oldResourceType, finalSnapshotIdentifier)) {
    if (!(await takeOwedSnapshot(run, deps, logicalId, currentResource, secrets, isRetry))) {
      return;
    }
    sentSnapshotIdentifier = undefined;
  }
  // Initialized because the catch below can leave it unassigned.
  let deleteResult: void | ResourceDeleteResult = undefined;
  let deleteFailed = false;
  // go-to-k/cdkd#4821: a replaced standalone inline policy (`PolicyName` /
  // `RoleName` are create-only) removes its OLD name here, right after its
  // create; another writer of this deploy may have just put that name on the
  // same principal (a swap of names with an `AWS::IAM::Policy`). Only those
  // types are handed the predicate, so every other replacement is unchanged.
  const inlinePolicyClaimed = isStandaloneInlinePolicyType(oldResourceType)
    ? deps.inlinePolicyClaimedFor(oldResourceType, logicalId, deps.deployStateResources())
    : undefined;
  try {
    const sendDelete = (): Promise<void | ResourceDeleteResult> =>
      deleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        oldResourceType,
        deleteProperties,
        {
          expectedRegion: deps.stackRegion,
          forceDataDelete: deps.options.forceStatefulRecreation === true,
          ...(sentSnapshotIdentifier !== undefined && {
            finalSnapshotIdentifier: sentSnapshotIdentifier,
          }),
          ...replacementDeleteContext(deps, updateReplacePolicy),
          // Issue #4157: the identity evidence of the record deleted.
          recordedAttributes: currentResource.attributes,
          recordedCreateOnlyDrops: currentResource.acceptedCreateOnlyDrops,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: currentResource.noEchoLeaves,
          // go-to-k/cdkd#6309: a custom resource's Delete payload types.
          recordedTypedPayloadLeaves: currentResource.typedPayloadLeaves,
          ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
          ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
          // go-to-k/cdkd#2007: the bag the call logs under and the delete
          // error below is masked with.
          maskSecrets: createUnionSecretMasker([
            secrets,
            secretNameBagFor(deps.secretsRun(), logicalId),
          ]),
        }
      );
    deleteResult = await withPrintingSecrets(secrets, () =>
      // go-to-k/cdkd#5111: the post-DAG retry waits out an "in use" refusal
      // whose user this deploy already moved off (a deleted load balancer's
      // listeners go asynchronously); the first attempt defers instead.
      isRetry ? retryWhileInUse(sendDelete, () => deps.interrupted()) : sendDelete()
    );
  } catch (deleteError) {
    const deleteMsg = maskSecretsInText(describeAwsFailure(deleteError).detail, secrets);
    deleteFailed = true;
    // go-to-k/cdkd#2631: before the deferral below, whose retry runs only
    // after this row's op is journaled (and not at all if the deploy fails
    // first; `execute.ts` re-stamps the op after it). A retry that then
    // deletes it leaves the mark: the rollback's read finds it gone and
    // re-creates, as it would have.
    // A retry never upgrades an earlier `'unconfirmed'`: that delete may
    // still be running.
    run.replacedOldMaySurvive.set(
      logicalId,
      run.replacedOldMaySurvive.get(logicalId) === 'unconfirmed'
        ? 'unconfirmed'
        : replacedDeleteFailureVerdict(deleteError)
    );
    // go-to-k/cdkd#4900: a resource this deploy has yet to update may still
    // use the old one (an endpoint on a replaced revision refuses its
    // delete), so the first failure inside a deploy's DAG is retried once
    // after the rest of the deploy, as CloudFormation's cleanup phase
    // deletes old resources only after every update.
    const deferred = run.deferredReplacedDeletes;
    if (!isRetry && deferred !== undefined) {
      deps.logger.info(
        safeMsg`  Could not delete old ${logicalId} (${currentResource.physicalId}) yet: ${deleteMsg}. Retrying after the rest of the deploy.`
      );
      // go-to-k/cdkd#5111: recorded BEFORE the row's save, which persists it:
      // a deploy killed before the retry below left the old resource in AWS
      // with no record at all.
      // A pre-delete snapshot already taken above is not owed again.
      recordSupersededForDeferral(run, deps, logicalId, currentResource, {
        updateReplacePolicy,
        finalSnapshotIdentifier: sentSnapshotIdentifier,
        noEchoDeleteValues,
        inlinePolicyClaimed,
      });
      deferred.set(logicalId, {
        physicalId: currentResource.physicalId,
        resourceType: oldResourceType,
        provisionedBy: deleteProvisionedBy,
        failureMessage: deleteMsg,
        ...(currentResource.dependencies !== undefined && {
          dependencies: currentResource.dependencies,
        }),
        retry: () =>
          deleteReplacedAfterCreate(
            run,
            deps,
            logicalId,
            oldResourceType,
            currentResource,
            deleteProvider,
            deleteProperties,
            sentSnapshotIdentifier,
            updateReplacePolicy,
            secrets,
            deleteProvisionedBy,
            noEchoDeleteValues,
            true
          ),
      });
      return;
    }
    // Always a warning, a not-found included: an "already gone" read off the
    // MESSAGE cannot be made safe (go-to-k/cdkd#3236) — a logical id like
    // `PageNotFound`, or a delete failing on a KMS key or role "not found"
    // while the old resource is alive, would silence the one line telling
    // the user an untracked resource may be left.
    // go-to-k/cdkd#5111: the retry of a recorded delete keeps the record.
    const kept = isRetry && run.supersededEntries.has(logicalId);
    deps.logger.warn(
      kept
        ? safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}. ${SUPERSEDED_KEPT_REMEDY}.`
        : safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}`
    );
  }
  // go-to-k/cdkd#5111: a retry that deleted it, or that the provider skipped
  // (warned below as untracked), drops the record.
  const recorded = isRetry ? run.supersededEntries.get(logicalId) : undefined;
  if (recorded !== undefined && !deleteFailed && run.supersededHost !== undefined) {
    removeSuperseded(run.supersededHost, recorded);
    run.supersededEntries.delete(logicalId);
  }
  // Issue #2422.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType: oldResourceType,
    provisionedBy: deleteProvisionedBy,
  });
  const skipReason = deleteSkipReason(deleteResult);
  if (skipReason !== undefined) {
    // A skip does not say the delete was not sent (a custom-resource handler
    // that refused DID get it), so it never licenses a re-adopt.
    run.replacedOldMaySurvive.set(logicalId, 'unconfirmed');
    // go-to-k/cdkd#4043 (review MEDIUM-3): the old resource survives
    // untracked, so the row is a PARTIAL update and the deploy exits 2 unless
    // `--allow-unaddressed` (the #1819 survivor contract), not a clean one.
    run.replacedDeleteSkips.set(
      logicalId,
      `the replaced ${oldResourceType} (${currentResource.physicalId}) was not deleted (${skipReason}) and is no longer tracked by cdkd`
    );
    deps.logger.warn(
      safeMsg`  ⚠ ${deleteSkippedMessage(
        logicalId,
        currentResource.physicalId,
        skipReason,
        'while cleaning up the replaced resource',
        // No command on this line, and the id is the only trace left of the
        // resource: show it, bounded, rather than describe it
        // (go-to-k/cdkd#4265).
        { commandFreeLine: true }
      )}. Delete it manually — it is no longer tracked in state.`
    );
  } else if (!deleteFailed) {
    // go-to-k/cdkd#2631: the retry deleted it, so the mark goes: a rollback's
    // read of an eventually consistent API could still see the old resource
    // and re-adopt a deleted id.
    if (isRetry) run.replacedOldMaySurvive.delete(logicalId);
    deps.logger.info(
      isRetry
        ? safeMsg`  ${green('✓')} Old ${logicalId} (${currentResource.physicalId}) deleted`
        : safeMsg`  ${green('✓')} Old resource deleted`
    );
  }
}

/**
 * go-to-k/cdkd#6655: how often the cleanup pass reads a journaled holder that
 * did not answer, and the wait between reads. Exported for tests.
 */
export const journaledHolderRead = { attempts: 3, delayMs: 2_000 };

/** What the holder read proves about the name the delete addresses. */
type HolderJudgement = 'ours' | 'gone' | 'unreadable' | { notOurs: string };

/**
 * go-to-k/cdkd#6655: before the cleanup pass deletes a replaced resource BY
 * NAME, confirm the name still holds the resource this deploy deferred. Only
 * where the deferral journaled its generation (`run.replacedOldIdentity`,
 * go-to-k/cdkd#6621: a `SURVIVOR_LIVE_READ_TYPES` type, an S3 bucket); with
 * none journaled the delete is sent as before. Its read
 * (`replacedSurvivorIdentity`) runs on this retry only, never on an ordinary
 * deploy or destroy. Answers whether the delete may be sent.
 *
 * - A holder of another account or region, or another generation where only
 *   a re-create moves it, is PROVEN not the stack's: nothing is sent, and the
 *   superseded entry goes, since the resource it recorded is gone and a later
 *   run would delete the holder by name. For S3 that region is us-east-1,
 *   where versioning, tagging, encryption and policy writes (#4606 / #6621)
 *   and, measured for #6671 (2026-11-20), a policy's delete and an object's
 *   put and delete leave CreationDate alone. Elsewhere configuration writes
 *   move it, so it is not compared: a same-account re-create there gets the
 *   by-name delete of every release before this one.
 * - A holder that cannot be read is read again, up to
 *   `journaledHolderRead.attempts` reads (fewer once the deploy is
 *   interrupted); then nothing is sent and the entry is kept for the next
 *   run. An unanswered read never falls back to a by-name delete. One that
 *   no state tracks (an in-memory deferral, go-to-k/cdkd#6445) makes the row
 *   partial, as a provider skip does (the #1819 survivor contract).
 * - A name nothing holds needs no delete: none is sent (one would only race
 *   whoever takes the name next), and the old resource counts as deleted.
 */
async function journaledHolderIsOurs(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResourceType: string,
  oldResource: ResourceState
): Promise<boolean> {
  const journaled = run.replacedOldIdentity.get(logicalId);
  if (journaled === undefined) return true;
  let judged: HolderJudgement = 'unreadable';
  let interrupted = false;
  for (let attempt = 0; attempt < journaledHolderRead.attempts; attempt++) {
    if (attempt > 0) {
      if (deps.interrupted()) {
        interrupted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, journaledHolderRead.delayMs));
    }
    judged = judgeHolder(
      await readHolder(deps, oldResourceType, oldResource.physicalId),
      journaled,
      oldResourceType
    );
    if (judged !== 'unreadable') break;
  }
  if (judged === 'ours') return true;
  const shown = displayPhysicalId(oldResource.resourceType, oldResource.physicalId);
  const recorded = run.supersededEntries.get(logicalId);
  if (judged === 'unreadable') {
    const why = interrupted
      ? 'the deploy was interrupted before cdkd could read what holds that name now'
      : 'cdkd could not read what holds that name now';
    if (recorded === undefined) {
      run.replacedOldMaySurvive.set(logicalId, 'unconfirmed');
      run.replacedDeleteSkips.set(
        logicalId,
        `the replaced ${oldResourceType} (${oldResource.physicalId}) was not deleted (${why}) and is no longer tracked by cdkd`
      );
    }
    deps.logger.warn(
      safeMsg`  ⚠ Old ${logicalId} (${shown}) was not deleted: ${why} to confirm it is the resource this deploy replaced, so no delete was sent. ` +
        (recorded !== undefined
          ? safeMsg`${SUPERSEDED_KEPT_REMEDY}.`
          : "It is no longer tracked in state: delete it manually once you confirm it is the stack's.")
    );
    return false;
  }
  if (recorded !== undefined && run.supersededHost !== undefined) {
    removeSuperseded(run.supersededHost, recorded);
    run.supersededEntries.delete(logicalId);
  }
  // The old resource is gone either way (a proven other holder means the
  // stack's left the name), so its rollback mark goes as after a delete. The
  // kept arm above leaves it: the old resource may still be whole.
  run.replacedOldMaySurvive.delete(logicalId);
  if (judged === 'gone') {
    deps.logger.info(
      safeMsg`  ${green('✓')} Old ${logicalId} (${shown}) is already gone; no delete was sent`
    );
    return false;
  }
  deps.logger.warn(
    safeMsg`  ⚠ Old ${logicalId} (${shown}) was not deleted: the ${oldResourceType} now under that name is not the one this deploy replaced (its ${judged.notOurs} differs from what cdkd read when it deferred the delete), so no delete was sent and that resource was left alone. The replaced resource is gone, and cdkd no longer tracks it in state.`
  );
  return false;
}

/** One bounded `replacedSurvivorIdentity` read. Never throws. */
async function readHolder(
  deps: ReplacementDeps,
  oldResourceType: string,
  physicalId: string
): Promise<SurvivorIdentityRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = deps.providerRegistry().getProvider(oldResourceType);
    if (typeof provider.replacedSurvivorIdentity !== 'function') return { kind: 'unknown' };
    return await Promise.race([
      provider.replacedSurvivorIdentity(physicalId, oldResourceType, {
        expectedRegion: deps.stackRegion,
      }),
      new Promise<SurvivorIdentityRead>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'unknown' }), DEFERRAL_IDENTITY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { kind: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

function judgeHolder(
  read: SurvivorIdentityRead,
  journaled: string,
  oldResourceType: string
): HolderJudgement {
  switch (read.kind) {
    case 'gone':
      return 'gone';
    case 'foreign':
      return { notOurs: read.seen === 'other-account' ? 'owning account' : 'region' };
    case 'unknown':
      return 'unreadable';
    case 'owned': {
      if (read.identity === undefined) return 'unreadable';
      if (read.identity === journaled) return 'ours';
      // The token is `<region>|<generation>`; only where a re-create alone
      // moves the generation does a difference prove another resource.
      const stable = journaled.split('|')[0] === SURVIVOR_LIVE_READ_TYPES[oldResourceType];
      return stable ? { notOurs: 'creation time' } : 'ours';
    }
  }
}

/**
 * go-to-k/cdkd#6463: take the pre-delete snapshot a replaced resource's old
 * copy is owed, right before its delete, and answer whether the delete may
 * be sent. Never on an interrupted cleanup pass (a Redshift snapshot can wait
 * for an hour). AWS calling the copy unsnapshottable refuses rather than
 * skips: the copy is live, and may be paused or modifying. Once taken, the
 * kept entry no longer owes it, so a delete that then fails is retried by
 * the next deploy or `cdkd destroy` without another snapshot, as an inline
 * delete's retry is (go-to-k/cdkd#4900); a name-keyed snapshot is not reused
 * once complete, so each attempt would otherwise take one more.
 */
async function takeOwedSnapshot(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResource: ResourceState,
  secrets: RecordedSecretValues,
  isRetry: boolean
): Promise<boolean> {
  const recorded = isRetry ? run.supersededEntries.get(logicalId) : undefined;
  // Who still tracks the old copy, for the remedy a refusal names.
  const tracking = (): 'kept' | 'held' | 'untracked' =>
    recorded !== undefined
      ? 'kept'
      : oldIdHeldByAnotherRecord(deps, logicalId, oldResource)
        ? 'held'
        : 'untracked';
  if (isRetry && deps.interrupted()) {
    deps.logger.warn(
      safeMsg`  ⚠ Old ${logicalId} (${oldResource.physicalId}) was not deleted: the deploy was interrupted before its final snapshot (UpdateReplacePolicy: Snapshot). ` +
        (tracking() === 'kept'
          ? safeMsg`${SUPERSEDED_KEPT_REMEDY}.`
          : tracking() === 'held'
            ? 'Another resource of this stack records the same physical id.'
            : 'Delete it manually once you have a snapshot; it is no longer tracked in state.')
    );
    return false;
  }
  const snapshotMask = createUnionSecretMasker([
    secrets,
    secretNameBagFor(deps.secretsRun(), logicalId),
  ]);
  try {
    await takePreDeleteSnapshot(
      deps,
      logicalId,
      oldResource.resourceType,
      oldResource.physicalId,
      snapshotMask,
      {
        refuseUnsnapshottableState: true,
        // Only a snapshot taken for this delete stands in for one: an EBS
        // volume's from an older attempt predates writes since.
        reuseStartedAtOrAfter: reuseBound(recorded),
        // The cleanup pass's wait stops on Ctrl-C, its entry kept owing. An
        // inline delete's runs on: stopped, it would leave the old copy
        // untracked.
        ...(isRetry && { stop: () => deps.interrupted() }),
      }
    );
  } catch (snapshotError) {
    // The delete was never sent, so the old resource is whole: a rollback
    // may re-adopt it (go-to-k/cdkd#2631), and a recorded entry stays for a
    // later run to snapshot and delete.
    if (!isRetry) run.replacedOldMaySurvive.set(logicalId, 'kept');
    deps.logger.warn(
      safeMsg`  ⚠ Final snapshot for old ${logicalId} (${oldResource.physicalId}) ` +
        safeMsg`failed: ${asIsMessage(snapshotMask(describeAwsFailure(snapshotError).detail))}. ` +
        `The old resource was NOT deleted (UpdateReplacePolicy: Snapshot). ` +
        (tracking() === 'kept'
          ? safeMsg`${SUPERSEDED_KEPT_REMEDY}.`
          : tracking() === 'held'
            ? 'Another resource of this stack records the same physical id.'
            : 'Delete it manually once you have a snapshot; it is no longer tracked in state.')
    );
    return false;
  }
  if (recorded?.finalSnapshotIdentifier !== undefined && run.supersededHost !== undefined) {
    const { finalSnapshotIdentifier: _taken, ...taken } = recorded;
    addSuperseded(run.supersededHost, taken);
    run.supersededEntries.set(logicalId, taken);
  }
  return true;
}

/**
 * go-to-k/cdkd#6463: the earliest start a reused snapshot may have: when the
 * deferral was recorded, so an interrupted attempt of the same delete is
 * resumed; else this attempt's own start. A run killed after the snapshot
 * completed and before its cleared mark was saved leaves that snapshot inside
 * the bound, so the next attempt reuses it (an EBS volume's): writes between
 * the two are in no snapshot, as after a delete that fails once its snapshot
 * is taken (one snapshot per old copy, at its first delete attempt).
 */
function reuseBound(recorded: SupersededResourceRecord | undefined): number {
  return recorded !== undefined && Number.isFinite(recorded.supersededAt)
    ? recorded.supersededAt
    : Date.now();
}

/**
 * go-to-k/cdkd#6374: whether this delete waits for the cleanup phase. Only
 * inside a deploy (the deferred map is set), and only once the deploy can
 * still send it after a kill: its old record is on the live state, so the
 * next deploy or `cdkd destroy` deletes it. The exception is a delete that
 * reads this run's re-resolved NoEcho values (a custom resource or a nested
 * stack, go-to-k/cdkd#6445): those never go to state, so it waits in memory
 * only, and a hard kill before the cleanup phase leaves the old copy
 * untracked.
 *
 * `UpdateReplacePolicy: Snapshot` defers for an atomic type
 * (`ATOMIC_FINAL_SNAPSHOT_TYPES`: RDS and the like), whose delete call takes
 * the snapshot from the identifier the deferral carries (go-to-k/cdkd#6445).
 * A type snapshotted BEFORE its delete (`PRE_DELETE_SNAPSHOT_TYPES`) defers
 * too, with its snapshot moved into the deferred delete (go-to-k/cdkd#6463):
 * the create-first gate takes none and hands over the owed mark
 * (`prepareCreateFirstFinalSnapshot`), and the delete takes it right before
 * it is sent. Without the mark (a caller that took the snapshot already) it
 * still deletes right away, since a later delete would let the data move
 * past that snapshot. Both copies stay live, and billed, until the deploy
 * ends; writes that reach the old copy meanwhile are in its snapshot.
 *
 * Two cases delete right away by the maintainer's decision
 * (go-to-k/cdkd#6445):
 *
 *   - An IAM inline policy: both policies attached for the rest of the deploy
 *     would grant the union of their permissions, and deferring buys nothing,
 *     since the rollback journal re-creates the policy document exactly.
 *   - An old physical id another record of this deploy holds: a recorded
 *     deferral could make a later run delete that record's live resource,
 *     and the other resource must be able to move off the id.
 */
function deferToCleanupPhase(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResource: ResourceState,
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  context: {
    finalSnapshotIdentifier: string | undefined;
    noEchoDeleteValues: NoEchoDeleteValues | undefined;
  }
): boolean {
  if (run.deferredReplacedDeletes === undefined) return false;
  if (
    updateReplacePolicy === 'Snapshot' &&
    deps.options.skipFinalSnapshot !== true &&
    !ATOMIC_FINAL_SNAPSHOT_TYPES.has(oldResource.resourceType) &&
    // go-to-k/cdkd#6463: a pre-delete-snapshot type defers only while its
    // snapshot is still owed, so the deferred delete takes it.
    !owesPreDeleteSnapshot(oldResource.resourceType, context.finalSnapshotIdentifier)
  ) {
    return false;
  }
  // All four inline-policy types, `AWS::IAM::Policy` included: no other arm
  // may defer one, in memory or in state.
  if (isInlinePolicyType(oldResource.resourceType)) return false;
  if (oldIdHeldByAnotherRecord(deps, logicalId, oldResource)) return false;
  recordSupersededForDeferral(run, deps, logicalId, oldResource, {
    updateReplacePolicy,
    finalSnapshotIdentifier: context.finalSnapshotIdentifier,
    noEchoDeleteValues: context.noEchoDeleteValues,
    inlinePolicyClaimed: undefined,
  });
  if (run.supersededEntries.get(logicalId)?.state === oldResource) return true;
  return deleteNeedsThisRunsNoEchoValues(oldResource, context.noEchoDeleteValues);
}

/**
 * Whether ANOTHER record of this deploy holds the old physical id. (This
 * row's own record still names the old id until the row completes; an equal
 * new id never reaches here.)
 */
function oldIdHeldByAnotherRecord(
  deps: ReplacementDeps,
  logicalId: string,
  oldResource: ResourceState
): boolean {
  return Object.entries(deps.deployStateResources()).some(
    ([id, record]) => id !== logicalId && record?.physicalId === oldResource.physicalId
  );
}

/**
 * go-to-k/cdkd#5111: record a deferred delete's old resource on the deploy's
 * live state, BEFORE the row's save persists it, so a deploy killed before
 * the deferred delete runs leaves it tracked rather than lost. Only when a
 * later run can send the delete with this run's context
 * (`canRecordSuperseded`).
 */
export function recordSupersededForDeferral(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResource: ResourceState,
  context: {
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    finalSnapshotIdentifier: string | undefined;
    noEchoDeleteValues: NoEchoDeleteValues | undefined;
    inlinePolicyClaimed: unknown;
  }
): void {
  const host = run.supersededHost;
  if (
    host === undefined ||
    !canRecordSuperseded(oldResource, {
      noEchoDeleteValues: context.noEchoDeleteValues,
      inlinePolicyClaimed: context.inlinePolicyClaimed,
      // The record this deploy loaded from state, masked (go-to-k/cdkd#6445).
      persistedRecord: true,
    }) ||
    // Never an id ANOTHER record of this deploy holds: a later run would
    // delete that live resource.
    oldIdHeldByAnotherRecord(deps, logicalId, oldResource)
  ) {
    return;
  }
  const entry: SupersededResourceRecord = {
    logicalId,
    supersededAt: Date.now(),
    state: oldResource,
    ...(context.updateReplacePolicy !== undefined && {
      updateReplacePolicy: context.updateReplacePolicy,
    }),
    ...(context.finalSnapshotIdentifier !== undefined && {
      finalSnapshotIdentifier: context.finalSnapshotIdentifier,
    }),
    ...(deps.options.forceStatefulRecreation === true && { forceDataDelete: true as const }),
    ...(deps.options.skipFinalSnapshot === true && { skipFinalSnapshot: true as const }),
  };
  addSuperseded(host, entry);
  run.supersededEntries.set(logicalId, entry);
}
