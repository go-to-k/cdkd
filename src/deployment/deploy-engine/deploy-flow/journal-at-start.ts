import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { NESTED_PENDING_PARENT_REASON } from '../../nested-child-journal.js';
import { carriesSecretMask } from '../../secret-redaction.js';
import { resolvePendingCloudControlRequests } from '../../cc-pending-requests.js';
import type { LoadedStateData } from './types.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { StackScope } from '../../../provisioning/resource-name.js';

/**
 * Steps 1b-pre and 1b of a deploy: the pending Cloud Control requests an
 * earlier run left, then the rollback journal note (moved from `deploy-flow.ts`).
 */
export async function settleJournalAtStart(
  engine: DeployEngine,
  {
    stackName,
    template,
    currentState,
    currentStateData,
    journalRead,
    nameScope,
    gate,
    afterGate,
  }: {
    stackName: string;
    template: CloudFormationTemplate;
    currentState: StackState;
    currentStateData: LoadedStateData;
    journalRead: ReturnType<DeployEngine['stateBackend']['loadRollbackJournal']>;
    nameScope: () => StackScope;
    gate: Promise<void> | undefined;
    afterGate: (start: () => Promise<void>) => Promise<void>;
  }
): Promise<void> {
  // 1b-pre. go-to-k/cdkd#3252: settle the Cloud Control CREATEs an earlier
  // run stopped waiting for, before anything reads the journal or plans. A
  // create that made its resource becomes a proven orphan; one still
  // unknown refuses the deploy (a re-create beside it would duplicate it).
  // Under the lock; after a first deploy's state gate, which must refuse
  // before anything is written. It reads the journal step 1b reads, so a
  // stack with nothing pending pays no extra read; the read error, if any,
  // is 1b's to swallow.
  let journalAtStart: Awaited<ReturnType<typeof engine.stateBackend.loadRollbackJournal>> = null;
  let journalReadError: unknown;
  try {
    journalAtStart = await journalRead;
  } catch (error) {
    journalReadError = error ?? new Error('unreadable rollback journal');
  }
  if (
    !engine.options.dryRun &&
    (await resolvePendingCloudControlRequests({
      journal: engine.stateBackend,
      loaded: journalAtStart,
      reader: () => engine.providerRegistry.getCloudControlProvider(),
      stackName,
      region: engine.stackRegion,
      command: 'deploy',
      logger: engine.logger,
      stateResources: currentState.resources,
      // Before a first deploy's record exists, a re-run after a crash has
      // its id only in the write-ahead sibling: read there (never minted),
      // and only when a request is pending, so the earlier attempt's
      // generated name reads as a name. An ordinary deploy reads nothing.
      stackInstanceId:
        currentStateData?.state === undefined
          ? () => engine.stateBackend.readStackInstanceSibling(stackName, engine.stackRegion)
          : nameScope().stackInstanceId,
      // A CREATE that completed is RESUMED when the template still declares
      // its logical id with the type and the journal holds the bag it sent
      // (no secret mask: the create path compares that bag with what it
      // would send now, create.ts). Anything else becomes a proven orphan.
      resume: (op, identifier) => {
        const attempted = op.attemptedProperties;
        if (
          template.Resources?.[op.logicalId]?.Type !== op.resourceType ||
          attempted === undefined ||
          carriesSecretMask(attempted) ||
          op.pendingCloudControlRequest === undefined ||
          // Another record already holds it (a `cdkd import` under another
          // logical id): taking it over would give it two owners.
          Object.values(currentState.resources).some(
            (r) => r.physicalId === identifier && r.resourceType === op.resourceType
          )
        ) {
          return false;
        }
        engine.resumedCreates.set(op.logicalId, {
          requestToken: op.pendingCloudControlRequest.requestToken,
          identifier,
          resourceType: op.resourceType,
          attemptedProperties: attempted,
        });
        return true;
      },
      ...(gate !== undefined && { beforeSettle: () => gate }),
    }))
  ) {
    try {
      journalAtStart = await engine.stateBackend.loadRollbackJournal(stackName, engine.stackRegion);
    } catch (error) {
      journalReadError = error ?? new Error('unreadable rollback journal');
    }
  }

  // 1b. If a rollback journal exists, a previous deploy failed / was
  // interrupted and has not yet been reverted (issue #1183). Note that
  // `cdkd rollback` can revert it; the deploy proceeds (fix-forward is
  // still supported). Best-effort — a journal read failure must not
  // block the deploy.
  try {
    if (journalReadError !== undefined) throw journalReadError;
    const loaded = journalAtStart;
    // No journal: purge what an earlier delete's unfinished purge left, now,
    // beside the deploy, so the success settle need not touch the key.
    if (loaded === null && !engine.options.parentStackInfo && !engine.options.dryRun) {
      engine.absentJournalVersionPurge = afterGate(() =>
        engine.stateBackend.purgeRollbackJournalVersions(stackName, engine.stackRegion)
      );
    }
    // A nested child's `nested-pending-parent` segments record a deploy
    // that SUCCEEDED while its parent's was still running (issue #3754);
    // they are its parent's to replay, not a failure to report here.
    const journal = loaded && {
      ...loaded,
      segments: loaded.segments.filter((s) => s.reason !== NESTED_PENDING_PARENT_REASON),
    };
    if (journal && journal.segments.length > 0) {
      // A journal whose every segment carries no completed ops is the
      // failed-only shape kept after a CLEAN automatic rollback (issue
      // #1208) — the stack is already back at its pre-deploy baseline,
      // so the generic "run cdkd rollback to revert" advice would be
      // misleading (a plain rollback is a no-op replay there). Detected
      // structurally, not by reason, so mixed journals keep the generic
      // note.
      const failedOnly =
        journal.segments.every((s) => s.operations.length === 0) &&
        journal.segments.some((s) => (s.failedOperations?.length ?? 0) > 0);
      engine.logger.info(
        failedOnly
          ? safeMsg`A previous deploy of ${displayStackName(stackName)} failed and was automatically rolled back. ` +
              `The failed resource may be partially applied — revert it, or continue ` +
              safeMsg`deploying to fix forward (${
                // Issue #3754: a nested child's journal is cleared by its
                // TOP-LEVEL stack's success, not by its own.
                engine.options.parentStackInfo
                  ? 'a successful deploy of the top-level stack clears this note'
                  : 'a successful deploy clears this note'
              }).` +
              safeMsg`\nRevert it with: ${
                pasteableCommand('cdkd rollback', [
                  { value: stackName, hole: 'stack' },
                  { literal: '--revert-failed' },
                ]).command
              }`
          : safeMsg`A previous deploy of ${displayStackName(stackName)} failed or was interrupted. Revert it, ` +
              `or continue deploying to fix forward.` +
              safeMsg`\nRevert it with: ${
                pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack' }]).command
              }`
      );
    }
  } catch {
    // ignore — journal is advisory here
  }
}
