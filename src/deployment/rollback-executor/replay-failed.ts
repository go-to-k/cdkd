/** The failed-op replay, split out of `rollback-executor.ts` (go-to-k/cdkd#5835). */

import {
  journaledOrphanKeepReason,
  nonEmptyOrUndefined,
  ownRecord,
  protectionRemovalProven,
  withKeysFrom,
  type ReplayFailedOperationsOptions,
} from './replay-failed-checks.js';
import { nameGenerationOf, withNameGenerationReached } from '../../state/name-generation.js';
import { noteRolledBackCreate, withReplayDeletePrinting } from './replay-scope.js';
import type { ResourceState } from '../../types/state.js';
import {
  createSecretMasker,
  maskedLeafCoordinatesOf,
  recordNestedStackParameterExpressions,
  recordNoEchoAttributeValues,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { updatePartialMessage, updatePartialReason } from '../update-outcome.js';
import { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import { restoreHeldInlinePolicies } from './replay-inline-policy-restore.js';
import type { RollbackExecutorContext, FailedOperation, FailedOpReplayResult } from './types.js';
import { ReplayResolvers, redactRollbackRecord } from './replay-secrets.js';
import {
  deepEqual,
  classifyFailedOp,
  failedOpOwnRecord,
  recordUnderIdIsNotOwn,
  recheckMismatchedFailedCreate,
} from './plan.js';
import {
  createOpMasker,
  addRecordNames,
  prepareCreateRollbackFinalSnapshot,
  requireRestorableBaseline,
  replayPrefixScope,
  ABSENT_BASELINE_SKIP_CAUSE,
} from './names.js';
import {
  safe,
  effectiveProvisionedBy,
  throwIfDeleteSkipped,
  refusalResourceType,
  shownLogicalId,
  maskedFailureText,
  shownChangeType,
  maskedRollbackEventError,
  recordRollbackSkip,
  rollbackCannotAddress,
  skipUnaddressableReplay,
  keptForAnotherHolder,
} from './messages.js';
import { resolveReplayProps, refuseMaskedReplayBaseline } from './replay-props.js';
import { updateWithRollbackRetry, recordAfterRollbackUpdate } from './replay-retry.js';
import {
  newMovedIdCleanupQueue,
  queueMovedIdCleanup,
  runMovedIdCleanups,
} from './replay-moved-id-cleanup.js';
import { maskRestoredNoEchoRecord, substituteMarkedNoEchoLeaves } from './replay-noecho.js';
import { safeMsg } from '../../utils/display-safe.js';
import { deleteLeftInPlace } from '../delete-outcome.js';
import {
  unsettledContextOf,
  unsettledItemsOf,
  unsettledPropertiesOf,
  withUnsettledItems,
  withUnsettledProperties,
} from '../../state/unsettled-properties.js';
import { withUnprovenUnsettled } from '../unsettled-convergence.js';
import { skippedAsDeletedOutsideCdkd } from './replay-deleted-outside.js';
import { noteRetainedResource } from '../../provisioning/providers/create-token-ledger.js';
import { runDeleteAttempt } from '../../provisioning/providers/deletion-protection-compensation.js';

/**
 * Revert a segment's FAILED in-flight operations (issue #1198). Opt-in via
 * `cdkd rollback --revert-failed` — the failed resource's remote state is
 * unknown (the op died partway), so force-applying `previousState` is a
 * deliberate user decision, never the default. Runs BEFORE the segment's
 * completed ops (the failed op is the newest work of the failed deploy).
 *
 * Best-effort like `replayRollback`: per-op failures are caught,
 * warned, and counted.
 */
export async function replayFailedOperationsUnbound(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: ReplayFailedOperationsOptions = {}
): Promise<FailedOpReplayResult> {
  const inlinePolicyWriters = options.inlinePolicyWriters ?? new RollbackInlinePolicyWriters();
  const result: FailedOpReplayResult = {
    failures: 0,
    warnings: 0,
    skipped: 0,
    interrupted: false,
    remainingFailedOps: [],
    skippedOps: [],
    orphaned: [],
    rolledBackCreates: [],
    leftInPlace: 0,
  };
  const { logger } = ctx;
  const rolledBack = { result, onRolledBackCreate: options.onRolledBackCreate };
  // Re-resolves redacted `{{resolve:secretsmanager:...}}` expressions to the
  // concrete secret for the failed-op provider replay (GHSA fix).
  const resolver = new ReplayResolvers(ctx.region);
  // go-to-k/cdkd#6120: the ids a `--revert-failed` update moved off, deleted
  // after the last op, as `replayRollback` deletes its own.
  const movedIdCleanups = newMovedIdCleanupQueue({
    onSuperseded: options.onSuperseded,
    onSupersededSettled: options.onSupersededSettled,
  });
  const emitEnvelope = options.emitEnvelope === true && failedOps.length > 0;
  if (emitEnvelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_STARTED', stackName });

  // Ops still pending after this replay: revert threw, or never reached due
  // to an interrupt. Everything else (reverted, deleted, or skipped — a skip
  // has nothing left to act on and its warning was already shown once) is
  // considered handled and drops out of the journal.
  const pending = new Set<FailedOperation>();

  for (let i = failedOps.length - 1; i >= 0; i--) {
    if (options.isInterrupted?.()) {
      result.interrupted = true;
      for (let j = i; j >= 0; j--) pending.add(failedOps[j]!);
      break;
    }
    const op = failedOps[i]!;
    // go-to-k/cdkd#4754: a replay with the holder scan (`foreignHolder`:
    // `cdkd rollback`, `cdkd destroy`, and a successful deploy's settle,
    // whose ops are already proven or demoted and so never reach this skip)
    // re-asks a kept fix-forward orphan the settle's question before skipping
    // it unchecked; the delete arm then runs the holder and identity checks.
    // No read for any other op, nor in the automatic rollback, which runs
    // neither check.
    const classified = classifyFailedOp(op, stateResources, failedOps);
    const action =
      ctx.foreignHolder === undefined
        ? classified
        : await recheckMismatchedFailedCreate(op, classified, stateResources, failedOps, ctx);
    // The re-check can wait on AWS: an interrupt that arrived meanwhile keeps
    // this op and the rest pending, as one seen before it would.
    if (classified === 'skip-failed-mismatch' && options.isInterrupted?.()) {
      result.interrupted = true;
      for (let j = i; j >= 0; j--) pending.add(failedOps[j]!);
      break;
    }
    /**
     * This op's re-resolved secret bag — the twin of `replaySingle`'s, and
     * hoisted above this iteration's `try` for the same reason (issues #2038 /
     * #2031): the shared catch below logs the thrown AWS message and persists it
     * to the events store, and could not see a binding scoped to the arm that
     * threw. Re-created per ITERATION, so one op's secrets can never mask
     * another's text.
     */
    const secrets: RecordedSecretValues = new Map();
    // This iteration's masker (issue #4037), `replaySingle`'s twin, over the
    // failed deploy's bag too (go-to-k/cdkd#2007).
    const opMasker = createOpMasker(logger, secrets, ctx.logOnlyNeedlesFor?.(op.logicalId));
    const mask = opMasker.mask;
    // go-to-k/cdkd#3338: what a skip arm below records its event through.
    const skipScope = { ctx, stackName, result, mask, stateResources };
    // The route a CREATE arm resolved (issue #1366), so the shared catch's
    // ROLLBACK_RESOURCE_FAILED names the route the delete was going to take —
    // the one a Snapshot refusal is about. Undefined on the UPDATE arm.
    let createRollbackRoute: 'sdk' | 'cc-api' | undefined;
    // go-to-k/cdkd#4408: the op completed when it replaced or dropped the
    // record, or found nothing applied (`skip-failed-noop`), or left a record
    // that is not its own (`skip-failed-mismatch`).
    const recordBefore = ownRecord(stateResources, op.logicalId);
    const skippedBefore = result.skipped;
    try {
      addRecordNames(opMasker, op, stateResources[op.logicalId]);
      switch (action) {
        case 'skip-failed-noop': {
          logger.info(
            `  Rollback: failed ${safe(op.changeType)} of ${safe(op.logicalId)} (${safe(op.resourceType)}) ` +
              `left nothing to revert, skipping`
          );
          break;
        }

        case 'skip-failed-mismatch': {
          // go-to-k/cdkd#4552: the failed CREATE may have provisioned the
          // resource it recorded, which state no longer tracks. Nothing is
          // deleted (state names another resource here); the recorded one is
          // named, masked, since once the op leaves the journal this line is
          // the only place it appears. The event, like every skip event,
          // carries no physical id.
          logger.warn(
            safeMsg`  Rollback: Skipping failed CREATE of ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) — it recorded ${mask(String(op.physicalId))}, which is not the resource state tracks under this id; manual attention may be required`
          );
          recordRollbackSkip(
            skipScope,
            op,
            'The failed CREATE recorded a physical id other than the one state now tracks under this logical id, so the rollback left it as it is; manual attention may be required.'
          );
          break;
        }

        case 'skip-failed-replaced-deleted': {
          // go-to-k/cdkd#4604: a delete-first replacement removed the old
          // resource before its create failed. Nothing is reverted (there is
          // nothing to revert onto); the record still names the removed id.
          // Cleared with its orphan like every warned skip: kept alone, a
          // later `--revert-failed` would aim a force-revert at a resource
          // that is gone.
          logger.warn(
            safeMsg`  Rollback: Skipping failed UPDATE of ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) — its replacement deleted the old resource ${mask(String(op.physicalId))} before the new one's create failed, so there is nothing to revert` +
              (options.forDestroy === true
                ? '; the destroy drops its record with the stack'
                : '; state still records it, and a deploy whose template still replaces it creates it again')
          );
          recordRollbackSkip(
            skipScope,
            op,
            'The failed UPDATE was a replacement that deleted the old resource before its create failed, so there is nothing to revert it onto; state still records the deleted resource.'
          );
          break;
        }

        case 'skip-failed-superseded': {
          // go-to-k/cdkd#1710: a CREATE that made its resource before failing,
          // but later activity (a newer deploy, a retained re-create) may own
          // a resource under that id now. Nothing is deleted; the recorded id
          // is named, masked, since once the op leaves the journal this line is
          // the only place it appears.
          logger.warn(
            safeMsg`  Rollback: Skipping failed CREATE of ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) — it created ${mask(String(op.physicalId))} before failing, and a later deploy or rollback may own a resource under that id now; if it is not in use, delete it manually`
          );
          recordRollbackSkip(
            skipScope,
            op,
            'The failed CREATE created its resource before failing, but a later deploy or rollback may own a resource under that id now, so the rollback left it as it is; manual attention may be required.'
          );
          break;
        }

        case 'skip-failed-unknown': {
          logger.warn(
            `  Rollback: failed CREATE of ${safe(op.logicalId)} (${safe(op.resourceType)}) recorded no ` +
              `physical id — if it was partially created in AWS, delete it manually`
          );
          recordRollbackSkip(
            skipScope,
            op,
            'The failed CREATE recorded no physical id, so the rollback cannot address it; if it was partially created in AWS, delete it manually.'
          );
          break;
        }

        case 'skip-failed-absent': {
          logger.warn(
            `  Rollback: cannot revert failed UPDATE of ${safe(op.logicalId)} — no previous state ` +
              `available, skipping`
          );
          recordRollbackSkip(
            skipScope,
            op,
            'No previous state is available for the failed UPDATE, so there is nothing to revert it to.'
          );
          break;
        }

        case 'skip-failed-type-change': {
          logger.warn(
            // Named only when plain, described otherwise: this line names
            // `cdkd drift` and `cdkd deploy` (go-to-k/cdkd#4214).
            `  Rollback: cannot revert failed UPDATE of ${shownLogicalId(op.logicalId)} in place — it was a ` +
              `Type change (${refusalResourceType(op.previousState?.resourceType)} -> ` +
              `${refusalResourceType(op.resourceType)}), ` +
              `which is a replacement, and its remote state is unknown. Inspect it with ` +
              `\`cdkd drift\` and re-converge with \`cdkd deploy\`. Skipping.`
          );
          recordRollbackSkip(
            skipScope,
            op,
            `The failed UPDATE was a Type change (${String(op.previousState?.resourceType)} -> ` +
              `${String(op.resourceType)}), which is a replacement, and its remote state is unknown, ` +
              `so it cannot be reverted in place.`
          );
          break;
        }

        case 'orphan-failed-create-retain': {
          // `DeletionPolicy: Retain` on a FAILED in-flight CREATE (issue
          // #1362): the resource WAS provisioned (physical id recorded, and
          // state agrees or the provider proved it, #1710), so the policy applies to its rollback delete — keep it
          // in AWS and drop the record, exactly as the completed-CREATE
          // rollback does. `RetainExceptOnCreate` deliberately does NOT land
          // here; it keeps deleting.
          //
          // Resolved BEFORE the record is dropped (issue #1366): the event
          // reports the resource's effective route, and the record — the
          // authoritative side — is about to go away.
          // go-to-k/cdkd#4604: a replacement orphan's logical id holds the
          // resource it was replacing, which this arm must neither orphan nor
          // drop.
          const failedCreateRecord = failedOpOwnRecord(op, stateResources);
          const orphanProvisionedBy = effectiveProvisionedBy(failedCreateRecord, op.provisionedBy);
          createRollbackRoute = orphanProvisionedBy;
          // The `orphan-retain` twin's record, for the same reason (issue
          // #2934) — see that arm for why the whole `ResourceState` is kept.
          //
          // No record exists for a CREATE whose provider proved it made the
          // resource before failing (go-to-k/cdkd#1710): nothing is orphaned
          // FROM state, so no `orphaned` entry is minted — one with an
          // undefined `state` is a record no consumer can act on.
          if (failedCreateRecord) {
            const orphaned = {
              logicalId: op.logicalId,
              orphanedAt: Date.now(),
              state: failedCreateRecord,
            };
            result.orphaned.push(orphaned);
            options.onOrphan?.(orphaned);
          }
          if (!recordUnderIdIsNotOwn(op, stateResources)) {
            delete stateResources[op.logicalId];
            // go-to-k/cdkd#5064: the kept resource holds its name in AWS.
            noteRolledBackCreate(rolledBack, op, failedCreateRecord);
          }
          // go-to-k/cdkd#4438: as on the `orphan-retain` arm.
          await noteRetainedResource(op.resourceType, op.logicalId);
          logger.info(
            `  Rollback: leaving partially-created ${safe(op.logicalId)} (${safe(op.resourceType)}) in AWS ` +
              `(DeletionPolicy: Retain)` +
              (failedCreateRecord ? ' — removed from state' : ' — it was never in state')
          );
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(orphanProvisionedBy && { provisionedBy: orphanProvisionedBy }),
          });
          break;
        }

        case 'delete-failed-create':
        case 'delete-failed-create-with-final-snapshot': {
          // Resolve the routing layer ONCE and use it for BOTH the snapshot
          // gate and the provider lookup (the #1358 alignment): the gate's
          // cc-api refusal is only meaningful if it judges the route the
          // delete actually takes. The state record wins over the journaled
          // op for the same reason it does on the completed-CREATE path.
          // go-to-k/cdkd#4604: none for a replacement orphan, as on the
          // Retain arm above.
          const failedCreateRecord = failedOpOwnRecord(op, stateResources);
          const deleteProvisionedBy = effectiveProvisionedBy(failedCreateRecord, op.provisionedBy);
          // go-to-k/cdkd#4628: `classifyFailedOp` already skipped a falsy id
          // (`skip-failed-unknown`); a present one must also be addressable.
          // Above the final-snapshot preparation, which names the snapshot
          // after the id. A recovered orphan has no record: none is exempt.
          if (
            rollbackCannotAddress(
              failedCreateRecord,
              op.resourceType,
              deleteProvisionedBy,
              op.physicalId
            )
          ) {
            skipUnaddressableReplay(
              skipScope,
              logger,
              op,
              'delete partially-created resource',
              failedCreateRecord ? 'record' : 'journal'
            );
            break;
          }
          // go-to-k/cdkd#4705: as on the completed-CREATE arm. Kept in the
          // journal (`pending`), so a later `cdkd rollback` still sees it.
          if (await keptForAnotherHolder(skipScope, logger, op, op.physicalId!)) {
            pending.add(op);
            break;
          }
          // go-to-k/cdkd#4696 / #4658: a replay of an earlier run's journal
          // (a `foreignHolder` is supplied) deletes a journaled orphan only
          // as the success settle would. Above the final-snapshot preparation
          // and the `deleting` line: a kept resource is neither snapshotted
          // nor announced. An orphan the settle already proved is not asked
          // again. The automatic rollback supplies no `foreignHolder` (see
          // `RollbackExecutorContext.foreignHolder`).
          const orphanDeleteChecked =
            op.physicalIdRecoveredFromError === true &&
            ctx.foreignHolder !== undefined &&
            ctx.orphanDeleteProven?.has(op) !== true;
          if (orphanDeleteChecked) {
            const verdict = await journaledOrphanKeepReason(
              { ...op, physicalId: op.physicalId! },
              ctx.foreignHolder!,
              ctx
            );
            if (verdict === 'gone') {
              logger.info(
                safeMsg`  Rollback: partially-created ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) is already gone — nothing to delete`
              );
              if (!recordUnderIdIsNotOwn(op, stateResources)) {
                delete stateResources[op.logicalId];
                noteRolledBackCreate(rolledBack, op, failedCreateRecord);
              }
              await options.afterOp?.(op.logicalId);
              ctx.recordEvent?.({
                eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
                stackName,
                operation: 'CREATE',
                logicalId: op.logicalId,
                resourceType: op.resourceType,
                ...(deleteProvisionedBy && { provisionedBy: deleteProvisionedBy }),
              });
              break;
            }
            if (verdict !== undefined && 'retry' in verdict) {
              // A read that gave no answer is not a verdict: the shared catch
              // counts it a failure and keeps the op for a re-run
              // (`--drop-failed` drops one that can never be read).
              throw new Error(
                `${String(op.physicalId)} is not deleted: ${verdict.retry}. The journal keeps it for ` +
                  `a re-run; \`cdkd rollback --drop-failed\` removes only that record and leaves the ` +
                  `resource in AWS`
              );
            }
            if (verdict !== undefined) {
              const keep = verdict.keep;
              const finish = verdict.finish ?? 'if it is not in use, delete it by hand';
              // As `skip-failed-superseded`: nothing is deleted, the recorded
              // id is named, masked, and the skip counts as unaddressed.
              logger.warn(
                safeMsg`  Rollback: Skipping failed CREATE of ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) — it created ${mask(String(op.physicalId))} before failing, but ${keep}. It is left in AWS: ${finish}`
              );
              recordRollbackSkip(
                skipScope,
                op,
                `The failed CREATE created its resource before failing, but ${keep}, so it is left in AWS; ${finish}.`
              );
              break;
            }
          }
          createRollbackRoute = deleteProvisionedBy;
          // `DeletionPolicy: Snapshot` (issue #1362): snapshot BEFORE the
          // delete, through the same mechanism matrix as the completed-CREATE
          // rollback. A shape cdkd cannot snapshot is REFUSED (per-op
          // failure, journal kept) rather than plain-deleted — a half-created
          // resource that is not snapshot-capable YET (an RDS instance still
          // `creating` rejects a final-snapshot delete) becomes snapshot-able
          // once it settles, so a re-run can finish the job. Destroying the
          // data on the first refusal would be unrecoverable;
          // `--skip-final-snapshot` is the explicit opt-out.
          const snapshotPolicy = action === 'delete-failed-create-with-final-snapshot';
          const takeFinalSnapshot = snapshotPolicy && ctx.skipFinalSnapshot !== true;
          let finalSnapshotIdentifier: string | undefined;
          if (takeFinalSnapshot) {
            finalSnapshotIdentifier = await prepareCreateRollbackFinalSnapshot(
              op,
              deleteProvisionedBy,
              ctx,
              mask
            );
          }
          logger.info(
            // No flag named: a plain rollback, the automatic rollback and a
            // destroy reach this arm too (go-to-k/cdkd#4584).
            `  Rollback: deleting partially-created ${safe(op.logicalId)} (${safe(op.resourceType)})` +
              (takeFinalSnapshot ? ' — DeletionPolicy: Snapshot' : '') +
              // Keep the opt-out auditable: without this the line is
              // byte-identical to a plain delete, so nothing records that a
              // Snapshot-policy resource was destroyed with no snapshot.
              (snapshotPolicy && !takeFinalSnapshot
                ? ' — DeletionPolicy: Snapshot NOT taken (--skip-final-snapshot)'
                : '')
          );
          const { provider, provisionedBy: deleteRoutedVia } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: deleteProvisionedBy,
          });
          // Pass the ATTEMPTED properties so template-borne data-guard
          // opt-ins (issue #1340: CDK auto-delete tags, EmptyOnDelete) stay
          // visible to the provider's delete — with `undefined` a
          // partially-created bucket/repo that already received data would
          // guard-fail this rollback delete even though the template opted in.
          // NOT re-resolved (unlike the update/create arms): a delete reads only
          // physical id + these guard opt-ins, never a secret value, so a
          // `{{resolve:...}}` expression left in a non-guard property is inert —
          // resolving here would only fetch the secret needlessly. The one
          // property a delete ADDRESSES through is a custom resource's
          // `ServiceToken`; its provider skips an expression there with a named
          // reason (go-to-k/cdkd#3960), which `throwIfDeleteSkipped` surfaces.
          // go-to-k/cdkd#4225, as on the completed-CREATE arm.
          const failedCreateClaimed = inlinePolicyWriters.claimedFor(
            op.resourceType,
            op.logicalId,
            stateResources
          );
          // go-to-k/cdkd#4678: `cdkd destroy --remove-protection` and `cdkd
          // rollback --remove-protection` (incl. `--revert-failed`) reach a
          // protected resource here; a deploy and its settle never set the
          // flag: a nested child's revert under a deploy's automatic rollback
          // never sets it; under `cdkd rollback --remove-protection` the child
          // replay does (go-to-k/cdkd#4703). Only on a
          // resource proven to be the one the failed CREATE made: AWS's refusal
          // is the last guard on a name another resource reused. ONE attempt,
          // no outer re-entry: the scope tells a protection flip's
          // compensation that any failure is the last, so the guard is put back.
          const removeProtection =
            ctx.removeProtection === true &&
            protectionRemovalProven(
              op,
              orphanDeleteChecked || ctx.orphanDeleteProven?.has(op) === true
            );
          const deleteFailedCreate = (): ReturnType<typeof provider.delete> =>
            withReplayDeletePrinting({ ctx, op, secrets }, () =>
              provider.delete(
                op.logicalId,
                op.physicalId!,
                op.resourceType,
                op.attemptedProperties,
                {
                  expectedRegion: ctx.region,
                  ...(removeProtection && { removeProtection: true }),
                  ...(failedCreateClaimed && { inlinePolicyClaimed: failedCreateClaimed }),
                  ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
                  ...(ctx.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
                  deletionPolicy: snapshotPolicy ? 'Snapshot' : 'Delete',
                  // #4157 / #6104: the record names `op.physicalId` (as on the CREATE arm).
                  recordedAttributes: failedCreateRecord?.attributes,
                  recordedCreateOnlyDrops: failedCreateRecord?.acceptedCreateOnlyDrops,
                  // go-to-k/cdkd#4043: where the bag holds a NoEcho mask. The
                  // journal records no coordinates, and its bag is masked by
                  // position, so every whole-`***` leaf of it counts (review
                  // round 9 n1): the caller decides the coordinates, and this
                  // caller has no list. Only `CustomResourceProvider` reads the
                  // field, and a custom resource reaches this arm only through a
                  // record naming the op's physical id (it never marks
                  // `createdBeforeFailure`), so this is a fail-safe, not a path
                  // a handler is known to take (review round 10).
                  recordedNoEchoLeaves: nonEmptyOrUndefined([
                    ...maskedLeafCoordinatesOf(op.attemptedProperties ?? {}),
                    ...(failedCreateRecord?.noEchoLeaves ?? []),
                  ]),
                  // go-to-k/cdkd#4612: a proven orphan, never a record's own delete.
                  // The bag is the journal's, secrets redacted: a provider that
                  // compares it with AWS re-resolves it through this, lazily.
                  ...(op.physicalIdRecoveredFromError === true && {
                    failedCreateOrphan: true,
                    resolveAttemptedProperties: () =>
                      resolveReplayProps(
                        op.attemptedProperties,
                        resolver,
                        secrets,
                        ctx,
                        op.logicalId
                      ),
                    ...(ctx.writtenThisRun !== undefined && { writtenThisRun: ctx.writtenThisRun }),
                  }),
                  // go-to-k/cdkd#2007: the op's mask, the failed deploy's bag included.
                  maskSecrets: mask,
                }
              )
            );
          const failedCreateDelete = removeProtection
            ? await runDeleteAttempt(true, deleteFailedCreate)
            : await deleteFailedCreate();
          // Issue #1762: the partially-created resource is still there, so
          // the op did NOT happen — let the shared catch record the failure
          // and keep it in `remainingFailedOps` for a re-run.
          throwIfDeleteSkipped(
            failedCreateDelete,
            op.logicalId,
            op.physicalId!,
            'while deleting the partially-created resource',
            {
              ctx,
              stackName,
              resourceType: op.resourceType,
              // The layer the delete was routed to; a legacy record names none.
              provisionedBy: deleteRoutedVia,
              mask,
            }
          );
          // go-to-k/cdkd#4612: the provider deleted it but left a part it
          // could not prove was still its own: warned, counted (exit 2).
          const leftInPlace = deleteLeftInPlace(failedCreateDelete);
          if (leftInPlace !== undefined) {
            logger.warn(
              safeMsg`  Rollback: deleted partially-created ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) only in part — ${leftInPlace}; manual attention may be required`
            );
            result.warnings++;
            result.leftInPlace++;
          }
          if (!recordUnderIdIsNotOwn(op, stateResources)) {
            delete stateResources[op.logicalId];
            // go-to-k/cdkd#5064: the next create asks for a new name.
            noteRolledBackCreate(rolledBack, op, failedCreateRecord);
          }
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            // The route the delete ACTUALLY took (issue #1366).
            ...(deleteProvisionedBy && { provisionedBy: deleteProvisionedBy }),
          });
          break;
        }

        case 'revert-failed-update': {
          const current = stateResources[op.logicalId]!;
          const prev = op.previousState!;
          // Issue #3203, as on the `revert` arm, and the sibling of
          // `skip-failed-absent` above: that one has no previous state at all,
          // this one has a record with no `properties` bag. `break` rather
          // than `return` -- this switch sits inside the failed-op loop, so
          // one unrestorable op must not end the pass.
          //
          // ABOVE the `force-reverting ...` line below, for the reason round 3
          // moved the `revert` arm's guard above its `Restoring ...` line:
          // announcing a restore and then refusing it reads as a failure
          // mid-flight. It is worse on THIS arm, whose announcement also
          // asserts the remote state is unknown -- three reviewers read the
          // guard's own "as on the `revert` arm" as a parity claim the old
          // placement contradicted on the one dimension round 3 changed.
          if (
            !requireRestorableBaseline(prev.properties, logger, {
              logicalId: op.logicalId,
              consequence:
                'be applied as a complete desired state: a patch provider removes every property, and an SDK provider may reset a subset or replace the resource',
              // NOT `cdkd deploy` here: this arm's own line says the remote
              // state is unknown, and `cdkd diff` compares the template against
              // `state.properties` rather than an AWS readback, so a
              // half-applied resource shows no change and is never
              // re-converged. `cdkd drift` is the command that reads AWS.
              remedy:
                'Inspect it with `cdkd drift` (this op died mid-flight, so its remote state is ' +
                'unknown) and re-converge with `cdkd drift --revert` or `cdkd deploy`.',
              retry:
                're-running `cdkd rollback --revert-failed` retries this op (a plain `cdkd rollback` replays only the COMPLETED ops and then pops the whole segment, discarding this record)',
            })
          ) {
            recordRollbackSkip(skipScope, op, ABSENT_BASELINE_SKIP_CAUSE);
            break;
          }
          // go-to-k/cdkd#4628: the force-revert below addresses AWS by the
          // record's id. A refused UPDATE is still journaled (deploy's
          // #3211 refusal), so this op reaches here over such a record. Above
          // the `force-reverting ...` line, as the baseline guard is.
          if (
            rollbackCannotAddress(
              current,
              op.resourceType,
              op.provisionedBy ?? current.provisionedBy,
              current.physicalId
            )
          ) {
            skipUnaddressableReplay(skipScope, logger, op, 'force-revert failed UPDATE of');
            break;
          }
          // go-to-k/cdkd#5505: the automatic rollback's revert names its own
          // cause, not a flag the user never passed.
          const own = options.previousFromRecord?.get(op.logicalId);
          const fromRecord = own !== undefined;
          const attemptedBag = fromRecord ? undefined : op.attemptedProperties;
          // The keys this revert converges: this run's own on the automatic
          // rollback, every record's under `--revert-failed`.
          const revertUnsettled = fromRecord
            ? own.names.size === 0
              ? {}
              : {
                  unsettledProperties: own.names,
                  ...(own.items.size > 0 && { unsettledItems: own.items }),
                }
            : unsettledContextOf(current, prev);
          logger.info(
            !fromRecord
              ? `  Rollback: force-reverting failed UPDATE of ${safe(op.logicalId)} (${safe(op.resourceType)}) ` +
                  `to its pre-deploy properties (--revert-failed; remote state is unknown)`
              : own.lateSuccess
                ? // The deadline-abandoned call completed and rewrote the
                  // record: the whole update is undone.
                  `  Rollback: reverting the failed UPDATE of ${safe(op.logicalId)} (${safe(op.resourceType)}), ` +
                  `whose call completed after the deploy gave up on it, to its pre-deploy properties`
                : `  Rollback: reverting what the failed UPDATE of ${safe(op.logicalId)} (${safe(op.resourceType)}) ` +
                  `left unsettled (${[...own.names].map(safe).join(', ')}) to its pre-deploy properties`
          );
          const { provider, provisionedBy: revertVia } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: op.provisionedBy ?? current.provisionedBy,
          });
          // Previous side of the diff = the ATTEMPTED properties (what the
          // failed op may have partially applied), so a patch-based provider
          // generates ops that undo them. Falls back to the current state
          // properties when resolution never got that far.
          // Re-resolve redacted secret expressions on BOTH sides for the
          // provider call (GHSA fix); `secrets` redacts the rebuilt record.
          // See {@link updateWithRollbackRetry} — same three concerns as the
          // `revert` arm (retry / disableOuterRetry / interrupt). `secrets` is
          // this iteration's bag, hoisted above the `try` so the shared catch
          // can mask with it too.
          // go-to-k/cdkd#4043 Phase C, the `revert` arm's twin: a marked
          // NoEcho leaf takes the value AWS holds, or the op refuses.
          const noEcho = await substituteMarkedNoEchoLeaves({
            desired: await resolveReplayProps(
              prev.properties,
              resolver,
              secrets,
              ctx,
              op.logicalId,
              prev
            ),
            baseline: prev,
            live: current,
            logicalId: op.logicalId,
            ctx,
            secrets,
            routedVia: [op.provisionedBy ?? current.provisionedBy, revertVia],
            stackName,
          });
          const desiredProps = noEcho.desired;
          // Issue #2274: the `--revert-failed` twin of the `revert` arm's
          // refusal. Desired side only, same reason.
          refuseMaskedReplayBaseline(desiredProps, op.logicalId, noEcho.inert);
          const resolvedPrevious = noEcho.onPreviousSide(
            await resolveReplayProps(
              attemptedBag ?? current.properties,
              resolver,
              secrets,
              ctx,
              op.logicalId,
              // The record's provenance describes its own bag only.
              attemptedBag === undefined ? current : undefined
            )
          );
          // go-to-k/cdkd#5505: a late success rewrote the whole record, so its
          // bag may hold what an earlier failed deploy left unsettled (its
          // convergence took that in). Those keys are left out of this revert:
          // equal on both sides, so nothing of an earlier deploy's is undone
          // or deleted; the record keeps their names for the next deploy.
          const excludedKeys = own?.lateSuccess === true ? [...unsettledPropertiesOf(prev)] : [];
          const attemptedProps =
            excludedKeys.length === 0 || resolvedPrevious === undefined
              ? resolvedPrevious
              : withKeysFrom(resolvedPrevious, desiredProps, excludedKeys);
          if (excludedKeys.length > 0) {
            const one = excludedKeys.length === 1;
            logger.warn(
              safeMsg`  Rollback: ${safe(op.logicalId)} (${safe(op.resourceType)}): ${excludedKeys.map(safe).join(', ')} ${one ? 'was' : 'were'} left unsettled by an earlier failed deploy, so this revert leaves ${one ? 'it' : 'them'} as AWS holds ${one ? 'it' : 'them'}; the next deploy converges ${one ? 'it' : 'them'}.`
            );
          }
          // Issue #2291, the `--revert-failed` twin of the two arms in
          // `replaySingle` — see the long note on the `revert` arm for why the
          // call stays although this `update()` builds no child engine either
          // (`replayingState`, issue #3754), why the journal is the source, why
          // `STATE_DERIVED_RULES`, and why only the desired side is recorded.
          recordNestedStackParameterExpressions(
            secrets,
            op.resourceType,
            desiredProps,
            prev.properties,
            'state-derived'
          );
          // Issue #4037, the `revert` arm's twin.
          opMasker.addNamed({
            resourceType: op.resourceType,
            properties: desiredProps,
            logicalId: op.logicalId,
            physicalIds: [prev.physicalId],
          });
          opMasker.addNamed({
            resourceType: op.resourceType,
            properties: attemptedProps,
            logicalId: op.logicalId,
            physicalIds: [current.physicalId, op.physicalId],
          });
          // go-to-k/cdkd#4225, the `revert` arm's twin.
          const revertFailedClaimed = inlinePolicyWriters.claimedFor(
            op.resourceType,
            op.logicalId,
            stateResources
          );
          // Issue #4024, the `revert` arm's twin: the in-place update runs
          // under the prefix setting that derives this resource's own id.
          const inOriginalPrefix = replayPrefixScope(
            {
              resourceType: op.resourceType,
              properties: desiredProps,
              logicalId: op.logicalId,
              physicalId: current.physicalId,
              via: revertVia,
              nameGeneration: nameGenerationOf(current, op.logicalId),
            },
            logger,
            mask,
            false
          );
          const revertFailedResult = await inOriginalPrefix(() =>
            updateWithRollbackRetry(
              provider,
              [
                op.logicalId,
                current.physicalId,
                op.resourceType,
                // Desired-side `?? {}` DEAD AT RUNTIME since issue #3203's guard
                // above (same reason as the other two sites). The previous-side
                // one below is LIVE, but not for the reason an earlier spelling
                // of this comment gave: `op.attemptedProperties` being optional
                // does NOT reach it, because `?? current.properties` already
                // covers that and `ResourceState.properties` is required. It is
                // live because a malformed STATE record can lack `properties`
                // altogether -- the same premise this whole guard rests on.
                desiredProps ?? {},
                attemptedProps ?? {},
                // Same as the `revert` arm: masker, no readback flag,
                // `ctx.region` as `expectedRegion` (issue #2301 item 1), and
                // `replayingState` (issue #3141). The DESIRED bag here is
                // `prev.properties` — a cdkd state record, exactly as on the
                // `revert` arm — so the replay licence is the same one. (The
                // PREVIOUS side is `op.attemptedProperties`, the failed attempt's
                // desired bag; `replayingState` describes the desired side, which
                // is the side a provider's refusals read.) `recordedAttributes` (issue
                // #4051) and `recordedCreateOnlyDrops` (#6104), as on the `revert` arm.
                {
                  maskSecrets: createSecretMasker(secrets),
                  expectedRegion: ctx.region,
                  replayingState: true,
                  recordedAttributes: current.attributes,
                  recordedCreateOnlyDrops: current.acceptedCreateOnlyDrops,
                  ...(revertFailedClaimed && { inlinePolicyClaimed: revertFailedClaimed }),
                  // go-to-k/cdkd#5380: the failed update's unsettled keys may
                  // hold either side in AWS while the attempted bag equals the
                  // restored one there, so the provider converges them against
                  // AWS; the record built below clears them only on success.
                  ...revertUnsettled,
                },
              ],
              op.logicalId,
              logger,
              options.isInterrupted,
              secrets,
              mask
            )
          );
          // go-to-k/cdkd#4434, the `revert` arm's twin: the returned
          // attributes' `NoEcho` needles, before the redaction below.
          if (revertFailedResult) {
            recordNoEchoAttributeValues(revertFailedResult, secrets, desiredProps);
          }
          stateResources[op.logicalId] = maskRestoredNoEchoRecord(
            redactRollbackRecord(
              // go-to-k/cdkd#5064 phase 2: the failed replacement's create may
              // have made a resource under the generation it asked for.
              withNameGenerationReached(
                recordAfterRollbackUpdate(prev, revertFailedResult),
                op.logicalId,
                op.nameGeneration
              ),
              secrets,
              prev.properties,
              prev.attributes
            ),
            prev,
            noEcho.substituted
          );
          // go-to-k/cdkd#5487: settled only on proof, as on the deploy side.
          stateResources[op.logicalId] = await withUnprovenUnsettled(
            stateResources[op.logicalId]!,
            {
              provider,
              logicalId: op.logicalId,
              physicalId: current.physicalId,
              resourceType: op.resourceType,
              recordedProperties: current.properties ?? {},
              names: revertUnsettled.unsettledProperties ?? new Set(),
              desired: desiredProps ?? {},
              ...(revertUnsettled.unsettledItems !== undefined && {
                attemptedItems: revertUnsettled.unsettledItems,
              }),
            },
            (message) => logger.warn(mask(message))
          );
          // go-to-k/cdkd#5505: what an earlier failed deploy left (the
          // pre-deploy record's names and items) was not converged here, so it
          // stays: even a name this run shares, whose proof covers only what
          // this run sent (a merge key holds extra live tags).
          if (fromRecord) {
            stateResources[op.logicalId] = withUnsettledItems(
              withUnsettledProperties(stateResources[op.logicalId]!, unsettledPropertiesOf(prev)),
              unsettledItemsOf(prev)
            );
          }
          // go-to-k/cdkd#4225, the `revert` arm's twin: its previous side is
          // the failed attempt's bag.
          if (updatePartialReason(revertFailedResult) === undefined) {
            inlinePolicyWriters.record(
              op.logicalId,
              'update',
              stateResources[op.logicalId]!,
              !deepEqual(
                prev.properties?.['Policies'],
                (attemptedBag ?? current.properties)?.['Policies']
              ),
              revertVia
            );
          }
          // Issue #1819: the FOURTH `provider.update()` call site -- the
          // `--revert-failed` arm. Missing it left `cdkd rollback
          // --revert-failed` printing "reverted successfully" over a stranded
          // resource: the exact pre-#1819 silence, on the command a user
          // reaches for when a deploy has already gone wrong.
          const revertFailedPartial = updatePartialReason(revertFailedResult);
          if (revertFailedPartial !== undefined) {
            // Issue #2038: provider-authored prose about a plaintext bag —
            // the `revert` arm's twin.
            logger.warn(
              mask(
                `  Rollback: ${safe(op.logicalId)} reverted, ${updatePartialMessage(revertFailedPartial)}`
              )
            );
            // Not counted, for the same reason as the revert arm above.
          } else {
            logger.info(`  Rollback: ${safe(op.logicalId)} reverted successfully`);
          }
          // go-to-k/cdkd#6120: the `revert` arm's twin.
          queueMovedIdCleanup(movedIdCleanups, {
            logicalId: op.logicalId,
            sent: current,
            recordedId: stateResources[op.logicalId]!.physicalId,
            oldPhysicalIdLeftForCleanup: revertFailedResult?.oldPhysicalIdLeftForCleanup === true,
            provider,
            provisionedBy: revertVia,
            ctx,
            result,
            secrets,
            mask,
          });
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'UPDATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
            // Masked because this one is DURABLE (issue #2031 item 2).
            ...(revertFailedPartial !== undefined && {
              reason: mask(revertFailedPartial),
            }),
          });
          break;
        }
      }
    } catch (revertError) {
      // go-to-k/cdkd#6106: a gone resource's force-revert is skipped, not failed.
      if (!(await skippedAsDeletedOutsideCdkd(action, op, logger, skipScope))) {
        // Issue #2031: the `--revert-failed` twin of `replaySingle`'s catch —
        // same plaintext bag, same DEFAULT-verbosity exposure. No registered
        // refusal is thrown on this path, so `rollbackFailureText` always takes
        // its flat arm here; it is called for the one spelling, not for a line.
        logger.warn(
          maskedFailureText(
            // As `replaySingle`'s catch line (go-to-k/cdkd#4214).
            `  Rollback failed for failed-op ${shownLogicalId(op.logicalId)} (${shownChangeType(op.changeType)}): `,
            revertError,
            mask
          )
        );
        result.failures++;
        pending.add(op);
        const failedRoute = createRollbackRoute ?? op.provisionedBy;
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_FAILED',
          stackName,
          operation: op.changeType,
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(failedRoute && { provisionedBy: failedRoute }),
          error: maskedRollbackEventError(revertError, mask),
        });
      }
    }
    if (result.skipped > skippedBefore) result.skippedOps!.push(op);
    inlinePolicyWriters.noteOutcome(
      op,
      // `skip-failed-mismatch` (go-to-k/cdkd#4552) settles like the no-op it
      // was split from: the record is not the failed op's, so it stands.
      action === 'skip-failed-noop' ||
        action === 'skip-failed-mismatch' ||
        action === 'skip-failed-superseded' ||
        action === 'skip-failed-replaced-deleted' ||
        ownRecord(stateResources, op.logicalId) !== recordBefore ||
        // go-to-k/cdkd#4604: a replacement orphan's arm acts on its resource
        // and leaves the record under its id, the replaced one, as it found
        // it: completed when it did not throw. go-to-k/cdkd#4606: as does an
        // orphan proven distinct from the record under its id.
        (recordUnderIdIsNotOwn(op, stateResources) &&
          !pending.has(op) &&
          (action === 'delete-failed-create' ||
            action === 'delete-failed-create-with-final-snapshot' ||
            action === 'orphan-failed-create-retain'))
    );
  }
  // go-to-k/cdkd#4408: no put-back here — the caller's `replayRollback` of
  // the segment's completed ops runs next over the same writers and does it,
  // once their records are final. An interrupt returns before that replay
  // (`cdkd rollback`), and the handled ops leave the journal, so a re-run
  // would never repeat their removals. Their holders' records may still be
  // the failed deploy's (the segment's completed ops are not reverted), so
  // each is warned about, not put back.
  if (result.interrupted) {
    await restoreHeldInlinePolicies(inlinePolicyWriters, stateResources, stackName, ctx, result, {
      refuseAll: true,
    });
  }
  await runMovedIdCleanups(movedIdCleanups, {
    stateResources,
    stackName,
    ctx,
    result,
    afterOp: options.afterOp,
    interrupted: result.interrupted || options.isInterrupted?.() === true,
  });
  if (emitEnvelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  result.remainingFailedOps = failedOps.filter((op) => pending.has(op));
  return result;
}
