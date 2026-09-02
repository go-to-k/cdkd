import { Command, Option } from 'commander';
import {
  commonOptions,
  stateOptions,
  deprecatedRegionOption,
  skipFinalSnapshotOption,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { AwsClients, setAwsClients } from '../../utils/aws-clients.js';
import { forwardSigtermToSigint } from '../../utils/interrupt-signals.js';
import { PartialFailureError, withErrorHandling } from '../../utils/error-handler.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { refusesFinalSnapshot } from '../../provisioning/final-snapshot.js';
import { withNestedStackContext } from '../../provisioning/nested-stack-context.js';
import { withStackName } from '../../provisioning/resource-name.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { setupStateBackend, resolveSingleRegion } from './state.js';
import { startRunRecorder } from './deployment-events-run.js';
import {
  replayRollback,
  replayFailedOperations,
  planRollback,
  planFailedOps,
  producerRegionsFromState,
  type RollbackExecutorContext,
  type RollbackPlanItem,
  type FailedOpPlanItem,
} from '../../deployment/rollback-executor.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type ResourceState,
  type StackState,
} from '../../types/state.js';
import type { StackStateRef } from '../../state/s3-state-backend.js';

interface RollbackOptions {
  force?: boolean;
  yes?: boolean;
  orphan?: string[];
  revertFailed?: boolean;
  skipFinalSnapshot?: boolean;
  stackRegion?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}

/**
 * `--stack-region <region>` — disambiguate when the same stackName has state
 * in multiple regions (same pattern + messages as the `state` subcommands).
 */
function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the target stack when the same name has state in multiple regions'
  );
}

/**
 * Discover every stack that currently has a rollback journal. One raw key
 * listing under the prefix (journals live at
 * `{prefix}/{stackName}/{region}/rollback-journal.json`), parsed back to
 * `(stackName, region)` refs.
 */
async function findJournalCandidates(
  backend: Awaited<ReturnType<typeof setupStateBackend>>['stateBackend'],
  prefix: string
): Promise<StackStateRef[]> {
  const keys = await backend.listRawKeys(`${prefix}/`);
  const refs: StackStateRef[] = [];
  const suffix = '/rollback-journal.json';
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key.endsWith(suffix)) continue;
    const rest = key.slice(prefix.length + 1, key.length - suffix.length);
    const segments = rest.split('/');
    // {stackName}/{region}
    if (segments.length !== 2) continue;
    const [stackName, region] = segments;
    if (!stackName || !region) continue;
    const dedupe = `${stackName}\0${region}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    refs.push({ stackName, region });
  }
  return refs;
}

/**
 * The `DeletionPolicy Snapshot — ...` note a planned Snapshot delete carries
 * (issue #1366). Consults the SAME mechanism matrix the replay will run, so
 * the preview cannot promise a final snapshot for a shape the executor is
 * about to REFUSE (a cc-api-routed atomic type, or a type with no snapshot
 * mechanism at all). `skipFinalSnapshot` is threaded in because the
 * classifier is pure and cannot see CLI flags — under the opt-out every shape
 * plain-deletes, refusals included, so the flag is checked first.
 */
function snapshotNote(
  resourceType: string,
  effectiveProvisionedBy: 'sdk' | 'cc-api' | undefined,
  skipFinalSnapshot: boolean
): string {
  if (skipFinalSnapshot) {
    return 'DeletionPolicy Snapshot — NO final snapshot (--skip-final-snapshot)';
  }
  if (refusesFinalSnapshot(resourceType, effectiveProvisionedBy)) {
    return (
      'DeletionPolicy Snapshot — cdkd cannot snapshot this resource; the rollback will ' +
      'REFUSE it (re-run with --skip-final-snapshot to delete without one)'
    );
  }
  return 'DeletionPolicy Snapshot — final snapshot, then delete';
}

/**
 * Human label for a planned rollback action (plan preview). `skipFinalSnapshot`
 * is threaded in because the classifier is pure (it cannot see CLI flags) and
 * the Snapshot label would otherwise promise a final snapshot the run is about
 * to skip — a data-loss-relevant lie in the one preview the user reads.
 */
function actionLabel(item: RollbackPlanItem, skipFinalSnapshot: boolean): string {
  const { op, action, replacement } = item;
  const rep = replacement ? ' [replacement occurred, best-effort revert]' : '';
  switch (action) {
    case 'delete':
      return `  - delete   ${op.logicalId} (${op.resourceType})${rep}`;
    case 'delete-with-final-snapshot':
      return (
        `  - delete   ${op.logicalId} (${op.resourceType}) ` +
        `[${snapshotNote(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)}]`
      );
    case 'orphan-retain':
      return `  - orphan   ${op.logicalId} (${op.resourceType}) [DeletionPolicy Retain — left in AWS]`;
    case 'orphan-flag':
      return `  - orphan   ${op.logicalId} (${op.resourceType}) [--orphan]`;
    case 'revert':
      return `  - revert   ${op.logicalId} (${op.resourceType})${rep}`;
    case 'reverse-replacement':
      return `  - reverse-replace ${op.logicalId} (${op.resourceType}) [re-create old resource, delete new]`;
    case 'reverse-replacement-readopt':
      return `  - reverse-replace ${op.logicalId} (${op.resourceType}) [delete new, re-adopt retained old resource]`;
    case 'unrecoverable-delete':
      return `  - (cannot restore) ${op.logicalId} (${op.resourceType}) — was DELETED, unrecoverable`;
    case 'skip-mismatch':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — physical id changed, needs manual attention`;
    case 'skip-absent':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — no longer in state`;
    case 'skip-already-done':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — already reverted`;
  }
}

/**
 * Human label for a planned FAILED-op revert (issue #1198, --revert-failed).
 * Takes `skipFinalSnapshot` for the same reason {@link actionLabel} does: the
 * classifier is pure, so without the flag the Snapshot label would promise a
 * final snapshot the run is about to skip (issue #1362).
 */
function failedActionLabel(item: FailedOpPlanItem, skipFinalSnapshot: boolean): string {
  const { op, action } = item;
  switch (action) {
    case 'revert-failed-update':
      return `  - revert   ${op.logicalId} (${op.resourceType}) [FAILED update — remote state unknown, force-applying previous properties]`;
    case 'delete-failed-create':
      return `  - delete   ${op.logicalId} (${op.resourceType}) [FAILED create]`;
    case 'delete-failed-create-with-final-snapshot':
      return (
        `  - delete   ${op.logicalId} (${op.resourceType}) [FAILED create, ` +
        `${snapshotNote(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)}]`
      );
    case 'orphan-failed-create-retain':
      return `  - orphan   ${op.logicalId} (${op.resourceType}) [FAILED create, DeletionPolicy Retain — left in AWS]`;
    case 'skip-failed-unknown':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — failed CREATE recorded no physical id`;
    case 'skip-failed-noop':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — failed ${op.changeType} left nothing to revert`;
    case 'skip-failed-absent':
      return `  - skip     ${op.logicalId} (${op.resourceType}) — no previous state available`;
  }
}

/**
 * `cdkd rollback`'s confirmation prompt. Exported for unit testing — internal
 * to the rollback flow otherwise, whose only call site is inside the
 * `if (!skipConfirmation)` block below.
 *
 * The `(y/N): ` suffix is preserved verbatim from before issue #2275 folded
 * the non-interactive guard into `confirmOrRefuse`: it is user-visible output,
 * and only this site and `cdkd state orphan` ever spelled it that way.
 */
export async function confirm(question: string): Promise<boolean> {
  return confirmOrRefuse(question, {
    suffix: ' (y/N): ',
    refusal:
      'The cdkd rollback confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass --force (or -y / --yes) to confirm the rollback, or run ' +
      'the command from a real terminal.',
  });
}

export async function rollbackCommand(
  stackArg: string | undefined,
  options: RollbackOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }
  warnIfDeprecatedRegion(options);

  const setup = await setupStateBackend(options);
  const skipConfirmation = options.force === true || options.yes === true;
  // Stack-region-pinned client set installed as the process-global for the
  // replay (see the note at its construction below); the original set is
  // restored and this one disposed in the outer finally.
  let stackAwsClients: AwsClients | undefined;

  try {
    // 1. Resolve the target stack + region.
    let ref: StackStateRef;
    if (stackArg) {
      const refs = await setup.stateBackend.listStacks();
      ref = resolveSingleRegion(stackArg, refs, options.stackRegion);
    } else {
      const candidates = await findJournalCandidates(setup.stateBackend, setup.prefix);
      const scoped = options.stackRegion
        ? candidates.filter((c) => c.region === options.stackRegion)
        : candidates;
      if (scoped.length === 0) {
        logger.info(
          'Nothing to roll back — no stack has a rollback journal. ' +
            "Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up."
        );
        return;
      }
      if (scoped.length > 1) {
        const list = scoped.map((c) => `  - ${c.stackName} (${c.region})`).join('\n');
        throw new Error(
          `Multiple stacks have a rollback journal. Pick one:\n${list}\n` +
            `Re-run 'cdkd rollback <stack>' (add --stack-region if the same name spans regions).`
        );
      }
      ref = scoped[0]!;
    }
    const stackName = ref.stackName;
    const region = ref.region ?? setup.region;

    // Region-pinned clients for the whole replay: the pre-delete final
    // snapshots a `DeletionPolicy: Snapshot` rolled-back CREATE takes (issue
    // #1358) AND the provider deletes those snapshots precede. Both must run
    // against the TARGET STACK's region, which `--stack-region` can point
    // away from the CLI's --region / AWS_REGION: a wrong-region snapshot call
    // 404s as a NotFound, which reads as "source gone" and would silently
    // skip the snapshot, and a wrong-region delete trips `assertRegionMatch`.
    // Pinning only the snapshot would be worse than not pinning it at all —
    // it would take a real, billable snapshot and then fail the delete.
    //
    // Built UNCONDITIONALLY rather than under a `region !== setup.region`
    // guard: `setup.region` falls back to the literal 'us-east-1' when
    // neither --region nor AWS_REGION is set, while `setup.awsClients`
    // resolves through the SDK chain (AWS_DEFAULT_REGION, profile config), so
    // the two can disagree while the labels match. `setAwsClients` mirrors
    // what `destroy-runner.ts` does for a cross-region destroy; the original
    // set is restored in the outer finally.
    stackAwsClients = new AwsClients({
      region,
      ...(options.profile && { profile: options.profile }),
    });
    setAwsClients(stackAwsClients);
    const finalSnapshotClients = stackAwsClients;

    // 2. Register providers (exactly like deploy / destroy).
    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry);
    providerRegistry.setCustomResourceResponseBucket(setup.bucket);

    // Interrupt handling, registered BEFORE the lock acquisition below
    // (issue #1348) so a signal landing during the acquisition's S3
    // round-trip flips the flag — the replay loop then stops before its
    // first operation and the `finally` releases the lock — instead of
    // killing the process with the just-written lock stranded.
    let interrupted = false;
    const sigintHandler = () => {
      process.stderr.write('\nInterrupted — stopping rollback after the current operation...\n');
      interrupted = true;
    };
    process.on('SIGINT', sigintHandler);
    // CI cancellation delivers SIGTERM, not Ctrl-C (issue #1342) — route it
    // through the same graceful stop-after-current-operation path.
    const unforwardSigterm = forwardSigtermToSigint();

    // 3. Acquire the stack lock for the whole replay.
    try {
      await setup.lockManager.acquireLockWithRetry(stackName, region, undefined, 'rollback');
    } catch (error) {
      // The try/finally that owns the listener cleanup starts below — clean
      // up here so an acquire failure does not leak the handlers. No lock is
      // held on this path (`acquireLockWithRetry` throws only after the lock
      // was NOT taken), so there is nothing to release first; the pair is
      // ordered to match the teardown below rather than to contradict it.
      process.removeListener('SIGINT', sigintHandler);
      unforwardSigterm();
      throw error;
    }

    try {
      // 4. Load state + journal (write order guarantees state exists first).
      // A newer-version journal throws UnknownRollbackJournalVersionError from
      // loadRollbackJournal → parseRollbackJournal; it propagates as a hard
      // error telling the user to upgrade cdkd.
      const stateData = await setup.stateBackend.getState(stackName, region);
      const journal = await setup.stateBackend.loadRollbackJournal(stackName, region);
      if (!journal || journal.segments.length === 0) {
        throw new Error(
          `Nothing to roll back for '${stackName}' (${region}). ` +
            "Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up."
        );
      }
      if (!stateData) {
        throw new Error(
          `Rollback journal exists for '${stackName}' (${region}) but its state.json is missing ` +
            `(keys: ${setup.prefix}/${stackName}/${region}/state.json and .../rollback-journal.json). ` +
            `State appears corrupted — inspect the bucket manually.`
        );
      }
      const baseState = stateData.state;
      const stateResources: Record<string, ResourceState> = { ...baseState.resources };
      const orphanLogicalIds = new Set(options.orphan ?? []);

      // Informational role-arn note (issue #1183): the newest segment recorded
      // a role, but --role-arn was not passed this run.
      const newestSegment = journal.segments[journal.segments.length - 1]!;
      if (newestSegment.roleArn && !options.roleArn) {
        logger.info(
          `Note: the failed deploy ran with --role-arn ${newestSegment.roleArn}; ` +
            `this rollback is running with ambient credentials (pass --role-arn to match).`
        );
      }

      // 5. Plan — newest-first, one block per segment.
      logger.info(`\nRollback plan for '${stackName}' (${region}):`);
      // Plan preview walks a COPY of state so it does not disturb replay.
      const planStateView: Record<string, ResourceState> = { ...stateResources };
      for (let s = journal.segments.length - 1; s >= 0; s--) {
        const segment = journal.segments[s]!;
        logger.info(
          `\n  Segment ${s + 1}/${journal.segments.length} (${segment.reason}${segment.runId ? `, run ${segment.runId}` : ''}):`
        );
        // #1198: the segment's FAILED in-flight op(s) come first (they are
        // the newest work of the failed deploy).
        if (segment.failedOperations && segment.failedOperations.length > 0) {
          if (options.revertFailed) {
            const failedPlan = planFailedOps(segment.failedOperations, planStateView);
            for (const item of failedPlan)
              logger.info(failedActionLabel(item, options.skipFinalSnapshot === true));
            applyFailedPlanToPreview(failedPlan, planStateView, options.skipFinalSnapshot === true);
          } else {
            for (const fop of segment.failedOperations) {
              logger.info(
                `  - (left as-is) ${fop.logicalId} (${fop.resourceType}) — its ${fop.changeType} ` +
                  `FAILED mid-deploy; pass --revert-failed to attempt reverting it`
              );
            }
          }
        }
        const plan = planRollback(segment.operations, planStateView, orphanLogicalIds);
        for (const item of plan) logger.info(actionLabel(item, options.skipFinalSnapshot === true));
        // Apply the segment's effect to the preview so an earlier segment's
        // plan reflects the later segment's already-unwound state.
        applyPlanToPreview(plan, planStateView, options.skipFinalSnapshot === true);
      }
      logger.info('');

      if (!skipConfirmation) {
        const ok = await confirm(`Roll back '${stackName}' (${region})?`);
        if (!ok) {
          logger.info('Rollback cancelled');
          return;
        }
      }

      // 6. Events recorder for this rollback run.
      const eventRecorder = startRunRecorder({
        backend: setup.stateBackend,
        stackName,
        region,
        command: 'rollback',
      })!;

      const ctx: RollbackExecutorContext = {
        providerRegistry,
        region,
        logger: logger.child('rollback'),
        recordEvent: (e) => eventRecorder.record(e),
        finalSnapshotClients,
        skipFinalSnapshot: options.skipFinalSnapshot === true,
        // Issue #2057: the producer regions this stack read across. A replayed
        // `{{resolve:...}}` expression that a cross-region read put in this
        // record carries no region of its own, so without this the replay
        // re-resolves it HERE and writes a same-named foreign secret to a live
        // resource. Derived from the state this command already loaded — see
        // `producerRegionsFromState`.
        importedProducerRegions: producerRegionsFromState(baseState),
      };

      // 7. Serialized incremental state save after every mutating op.
      //
      // Best-effort by design: the AWS revert already succeeded by the time
      // this runs, so a state-save failure must NOT be counted as a rollback
      // failure (which would block the segment pop and mislabel a clean revert
      // as a per-op failure). It also must not desync `currentEtag`: on a
      // conflict we re-read the fresh ETag and retry once (mirrors the deploy
      // engine's post-rollback save) so a single transient blip cannot cascade
      // every remaining op into a 412. `afterOp` therefore never throws.
      let currentEtag = stateData.etag;
      const saveState = async (): Promise<void> => {
        const next = (): StackState => ({
          ...baseState,
          version: STATE_SCHEMA_VERSION_CURRENT,
          region,
          resources: { ...stateResources },
          lastModified: Date.now(),
        });
        try {
          currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
            ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
          });
        } catch {
          try {
            const fresh = await setup.stateBackend.getState(stackName, region);
            currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
              ...(fresh?.etag !== undefined && { expectedEtag: fresh.etag }),
            });
          } catch (retryError) {
            logger.warn(
              `Failed to persist state after a rollback operation: ${retryError instanceof Error ? retryError.message : String(retryError)}. ` +
                `The resource was reverted in AWS; re-run 'cdkd rollback ${stackName}' to reconcile state.`
            );
          }
        }
      };

      // 8. Replay segments strictly newest-first; pop each after a clean run.
      const oldestInitialDeploy = journal.segments[0]?.initialDeploy === true;
      let totalFailures = 0;
      let totalWarnings = 0;
      try {
        while (journal.segments.length > 0) {
          if (interrupted) break;
          const segment = journal.segments[journal.segments.length - 1]!;
          const result = await withNestedStackContext(
            {
              stateBackend: setup.stateBackend,
              lockManager: setup.lockManager,
              providerRegistry,
              parentStackName: stackName,
              parentRegion: region,
              accountId: 'unknown',
              awsClients: setup.awsClients,
              stateBucket: setup.bucket,
              exportIndexStore: setup.exportIndexStore,
              destroyOptions: {
                ...(options.profile && { profile: options.profile }),
                statePrefix: options.statePrefix,
              },
            },
            () =>
              withStackName(stackName, async () => {
                // #1198: revert the segment's FAILED in-flight op(s) first
                // (opt-in). Their revert is independent of the completed-op
                // replay (one op per resource per deploy), so a failed-op
                // revert failure still lets the completed ops replay — the
                // summed failure count keeps the segment from popping.
                let failedOpFailures = 0;
                let failedOpWarnings = 0;
                if (
                  options.revertFailed &&
                  segment.failedOperations &&
                  segment.failedOperations.length > 0
                ) {
                  const failedResult = await replayFailedOperations(
                    segment.failedOperations,
                    stateResources,
                    stackName,
                    ctx,
                    {
                      afterOp: saveState,
                      isInterrupted: () => interrupted,
                      // Failed-only segment: replayRollback below returns
                      // early without the STARTED/FINISHED envelope, so the
                      // failed-op replay owns it (events symmetry). For a
                      // MIXED segment the failed-op ROLLBACK_RESOURCE_*
                      // events land just before replayRollback's
                      // ROLLBACK_STARTED — accepted cosmetic ordering (the
                      // events stream is informational; the reader derives
                      // nothing from envelope position).
                      emitEnvelope: segment.operations.length === 0,
                    }
                  );
                  failedOpFailures = failedResult.failures;
                  failedOpWarnings = failedResult.warnings;
                  // Idempotency: persist ONLY the still-pending failed ops
                  // (per-op strip). A handled op must never be re-issued on a
                  // re-run — replaying `attemptedProperties` as the previous
                  // diff side against an already-reverted resource would
                  // generate a patch undoing changes that no longer exist
                  // (fails on patch-based providers). Runs on the interrupt /
                  // failure paths too so partial progress is never lost.
                  // Best-effort: on a strip failure the re-run merely
                  // re-attempts the revert.
                  const remaining = failedResult.remainingFailedOps;
                  if (remaining.length !== segment.failedOperations.length) {
                    try {
                      await setup.stateBackend.setRollbackJournalFailedOperations(
                        stackName,
                        region,
                        remaining
                      );
                      if (remaining.length === 0) delete segment.failedOperations;
                      else segment.failedOperations = remaining;
                    } catch (stripError) {
                      logger.warn(
                        `Failed to strip replayed failed-ops from the journal: ${stripError instanceof Error ? stripError.message : String(stripError)}`
                      );
                    }
                  }
                  if (failedResult.interrupted) {
                    return {
                      failures: failedOpFailures,
                      warnings: failedOpWarnings,
                      interrupted: true,
                    };
                  }
                }
                const replayResult = await replayRollback(
                  segment.operations,
                  stateResources,
                  stackName,
                  ctx,
                  {
                    orphanLogicalIds,
                    afterOp: saveState,
                    isInterrupted: () => interrupted,
                  }
                );
                return {
                  failures: replayResult.failures + failedOpFailures,
                  warnings: replayResult.warnings + failedOpWarnings,
                  interrupted: replayResult.interrupted,
                };
              })
          );
          totalFailures += result.failures;
          totalWarnings += result.warnings;
          if (result.interrupted) {
            interrupted = true;
            break;
          }
          if (result.failures > 0) {
            // A per-op failure keeps this (and older) segment(s) for a re-run.
            break;
          }
          // Segment fully replayed — pop it (persists the shortened journal).
          await setup.stateBackend.popRollbackJournalSegment(stackName, region);
          journal.segments.pop();
        }
      } finally {
        await eventRecorder.finalize(totalFailures > 0 || interrupted ? 'FAILED' : 'SUCCEEDED');
      }

      // 9. Terminal state: an initial-deploy rollback that emptied state
      // deletes state.json so `cdkd list` shows no ghost stack.
      if (
        journal.segments.length === 0 &&
        oldestInitialDeploy &&
        Object.keys(stateResources).length === 0
      ) {
        await setup.stateBackend.deleteState(stackName, region);
        logger.info(`State for '${stackName}' (${region}) removed (stack fully rolled back).`);
      }

      // 10. Exit codes.
      if (interrupted) {
        throw new PartialFailureError(
          `Rollback interrupted. Journal preserved — re-run 'cdkd rollback ${stackName}' to finish.`
        );
      }
      if (totalFailures > 0) {
        throw new PartialFailureError(
          `Rollback completed with ${totalFailures} failed operation(s). Journal preserved — ` +
            `re-run 'cdkd rollback ${stackName}' to retry.`
        );
      }
      if (totalWarnings > 0) {
        throw new PartialFailureError(
          `Rollback completed with ${totalWarnings} skipped/unrecoverable operation(s) (see warnings above).`
        );
      }
      logger.info(`\nRollback of '${stackName}' (${region}) complete.`);
    } finally {
      // Release FIRST, unregister LAST (issue #2118). While the release
      // round-trip is in flight the lock is still held, so the handlers must
      // stay armed: with them gone the process has ZERO SIGINT listeners and a
      // Ctrl-C landing there takes Node's default terminate, the release never
      // completes, and the lock sits for its full 30-minute TTL — blocking the
      // next `cdkd rollback` / `deploy` / `destroy` on that stack. Same rule
      // `destroy-runner.ts` states for its strong-ref refusal path, and the
      // mirror of issue #1348 at the other end of the lock's life.
      //
      // The unregistration lives in its own `finally` as defence in depth: the
      // `.catch` below covers a REJECTION, not a synchronous throw. Nothing in
      // `LockManager` can throw synchronously today (`releaseLock` is `async`,
      // so even a client-construction failure surfaces as a rejection), so this
      // guards a shape rather than a live leak — worth keeping because the leak
      // it would prevent is per-command and permanent.
      //
      // The order WITHIN the pair is consistency, not mechanism, and is called
      // out because an earlier draft of this comment claimed otherwise. The two
      // calls are adjacent and synchronous, so no signal can be delivered
      // between them; and `unforwardSigterm()` first would NOT empty the
      // listener set, because `sigintHandler` is still registered at that point.
      // Removing this command's own handler last simply keeps the whole block
      // reading in one direction — the real requirement is the release above.
      try {
        await setup.lockManager.releaseLock(stackName, region).catch((err) => {
          logger.warn(
            `Failed to release lock for '${stackName}' (${region}): ${err instanceof Error ? err.message : String(err)}`
          );
        });
      } finally {
        process.removeListener('SIGINT', sigintHandler);
        unforwardSigterm();
      }
    }
  } finally {
    // Restore the process-global client set BEFORE disposing ours, so a
    // later consumer in the same process never reaches a destroyed client.
    if (stackAwsClients) {
      setAwsClients(setup.awsClients);
      stackAwsClients.destroy();
    }
    setup.dispose();
  }
}

/**
 * Will the replay REFUSE this planned Snapshot delete instead of performing
 * it (issue #1368)? The preview must not unwind a record for an op that
 * never runs — the same question {@link snapshotNote} answers for the label,
 * asked with the same predicate and the same route, so the label and the
 * previewed state cannot disagree.
 */
function planItemWillBeRefused(
  resourceType: string,
  effectiveProvisionedBy: 'sdk' | 'cc-api' | undefined,
  skipFinalSnapshot: boolean
): boolean {
  // Under the opt-out nothing is refused — every shape plain-deletes.
  if (skipFinalSnapshot) return false;
  return refusesFinalSnapshot(resourceType, effectiveProvisionedBy);
}

/**
 * Apply a planned segment's effect to the plan-preview state so the NEXT
 * (older) segment's plan is classified against already-unwound state.
 * Mirrors what `replayRollback` mutates, without touching AWS.
 */
function applyPlanToPreview(
  plan: RollbackPlanItem[],
  previewState: Record<string, ResourceState>,
  skipFinalSnapshot: boolean
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete-with-final-snapshot':
        // A refused Snapshot delete leaves the resource AND its record in
        // place (issue #1368). Keeping the record is not cosmetic: an older
        // segment's item for the same logical id is classified against it,
        // and its route is stamped from it — drop it and that item silently
        // falls back to the journaled route, the #1366 defect one layer up.
        if (
          planItemWillBeRefused(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)
        ) {
          break;
        }
        if (op.changeType === 'CREATE') delete previewState[op.logicalId];
        break;
      case 'delete':
      case 'orphan-retain':
      case 'orphan-flag':
        if (op.changeType === 'CREATE') delete previewState[op.logicalId];
        break;
      case 'revert':
      case 'reverse-replacement':
      case 'reverse-replacement-readopt':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}

/**
 * Apply a planned FAILED-op revert's effect to the plan-preview state
 * (issue #1198). Mirrors `replayFailedOperations` without touching AWS.
 */
function applyFailedPlanToPreview(
  plan: FailedOpPlanItem[],
  previewState: Record<string, ResourceState>,
  skipFinalSnapshot: boolean
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete-failed-create-with-final-snapshot':
        // Same refusal carve-out as the completed-op path (issue #1368).
        if (
          planItemWillBeRefused(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)
        ) {
          break;
        }
        delete previewState[op.logicalId];
        break;
      case 'delete-failed-create':
      // Retain-orphan drops the record too (issue #1362) — the resource
      // stops being cdkd-managed either way.
      case 'orphan-failed-create-retain':
        delete previewState[op.logicalId];
        break;
      case 'revert-failed-update':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}

export function createRollbackCommand(): Command {
  const cmd = new Command('rollback')
    .description(
      'Revert a stack to its pre-deploy state after a failed --no-rollback / interrupted deploy ' +
        'or a partially-failed automatic rollback (state-driven, no synth needed).'
    )
    .argument('[stack]', 'Stack name to roll back (defaults to the single journaled stack)')
    .addOption(new Option('--force', 'Skip the confirmation prompt').default(false))
    .addOption(
      new Option(
        '--orphan <logicalId>',
        'Skip the given resource during replay (repeatable). Mirrors cdk rollback --orphan.'
      ).argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
    )
    .addOption(
      new Option(
        '--revert-failed',
        'Also attempt to revert the resource whose operation FAILED mid-deploy. Off by ' +
          'default: the remote state of the failed resource is unknown, so force-applying ' +
          'its previous state is opt-in.'
      ).default(false)
    )
    .addOption(skipFinalSnapshotOption)
    .addOption(stackRegionOption())
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  cdkd rollback MyStack',
        '  cdkd rollback                       # single journaled stack',
        '  cdkd rollback MyStack --force',
        '  cdkd rollback MyStack --orphan MyBucket --orphan MyTable',
        '  cdkd rollback MyStack --revert-failed   # also revert the failed in-flight resource',
        '  cdkd rollback MyStack --skip-final-snapshot  # DeletionPolicy Snapshot → delete without the snapshot',
        '  cdkd rollback MyStack --stack-region us-west-2',
        '',
        'Exit codes: 0 = clean, 2 = partial (journal kept for re-run), 1 = hard error.',
      ].join('\n')
    )
    .action(withErrorHandling(rollbackCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
