/**
 * The destroy runner from the stack lock on (split out of
 * `../destroy-runner.ts`, go-to-k/cdkd#5835).
 */
import { cdkdRemedy, plainOrDescribed, proseQuoted } from '../../../utils/pasteable-command.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displaySafe, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import { getLiveRenderer } from '../../../utils/live-renderer.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import type { RetainedResource } from '../../../state/s3-state-backend.js';
import { recordRetainedForReadoption } from '../../../deployment/retained-readoption.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { acquireStackLock } from '../stack-lock-guard.js';
import { retiredNameGenerationsLeaving } from '../../../state/name-generation.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import {
  stackInstanceIdCarriedFrom,
  type ResourceState,
  type StackState,
} from '../../../types/state.js';
import {
  destroyProducerRegions,
  holdsSecretDerivedPrincipalRecord,
  holdsUnprovenSecretPrincipalRecord,
} from '../../../provisioning/secret-principal-resolution.js';
import { withStackRecords } from '../../../deployment/stack-records-scope.js';
import {
  deleteJournaledOrphans,
  isHandledOrphan,
  loadJournaledOrphans,
  makeForeignHolderScan,
} from '../../../deployment/rollback-executor/journaled-orphans.js';
import { producerRegionsFromState } from '../../../deployment/rollback-executor.js';
import { orphanRecordsPrintingBag } from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import {
  deleteSupersededEntry,
  holdsSupersededResources,
  isSupersededResourceRecord,
  supersededHeldByOtherTypeWarning,
  supersededHolderOf,
  supersededResourcesOf,
  withoutSuperseded,
} from '../../../deployment/superseded-resources.js';
import {
  createUnionSecretMasker,
  unionOfSecretBags,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import type {
  DestroyRunnerContext,
  DestroyRunnerResult,
  DestroyLogger,
  StackLockBase,
} from './types.js';
import {
  NESTED_STACK_TYPE,
  purgeStateHistoryIfOptedIn,
  releaseRegistryMarkerAfterDestroy,
} from './helpers.js';
import {
  recheckUnderLock,
  makeSummaryHints,
  reReadJournaledOrphansUnderLock,
  buildDeleteGraph,
  makePrintingBagOf,
  printDestroySummary,
} from './under-lock-steps.js';
import { deleteStackResource, type DeleteResourceFrame } from './delete-resource.js';
import { isCustomResourceType } from '../../../provisioning/custom-resource-secure-references.js';
import type { SupersededResourceRecord } from '../../../types/state.js';

/** What {@link destroyStackUnderLock} reads from `destroyStackInRegion`. */
export interface UnderLockFrame {
  stackName: string;
  state: StackState;
  ctx: DestroyRunnerContext;
  logger: DestroyLogger;
  result: DestroyRunnerResult;
  regionForState: string;
  refusalRecovery: LockRecoveryContext;
  stackLockBase: StackLockBase;
  journaledOrphans: Awaited<ReturnType<typeof loadJournaledOrphans>>;
  needsStrongRefCheck: boolean;
  stackNoEchoValues: () => Promise<RecordedSecretValues | undefined>;
  destroyProviderRegistry: DestroyRunnerContext['providerRegistry'];
  destroyAwsClients: AwsClients | undefined;
  restoreBaseRegionAndClients: () => void;
}

/**
 * The second half of a stack's destroy, from the lock on: the re-checks
 * under the lock, the journaled orphans, the reverse-DAG delete loop, the
 * superseded resources, the final state write and summary, and the lock
 * release and region restore.
 */
export async function destroyStackUnderLock({
  stackName,
  state,
  ctx,
  logger,
  result,
  regionForState,
  refusalRecovery,
  stackLockBase,
  journaledOrphans,
  needsStrongRefCheck,
  stackNoEchoValues,
  destroyProviderRegistry,
  destroyAwsClients,
  restoreBaseRegionAndClients,
}: UnderLockFrame): Promise<DestroyRunnerResult> {
  // go-to-k/cdkd#4705 / #5064: the kept resources under a generated name.
  const retainedForReadoption: RetainedResource[] = [];
  // Review H-2: their record's read, started with the first one, off the
  // critical path.
  let retainedEarlier: Promise<readonly RetainedResource[] | null> | undefined;
  // Issue #2301: the logical ids whose delete proceeded with a guard that
  // could not answer. Named in the aggregate warning so the operator can go
  // straight to `cdkd events` for the reason rather than scrolling back.
  const guardIndeterminateTargets = new Set<string>();
  // The read started by the first kept resource (`deleteStackResource`).
  const startRetainedEarlierRead = (): void => {
    if (retainedEarlier === undefined) {
      retainedEarlier = Promise.resolve().then(() =>
        ctx.stateBackend.loadRetainedRecord(stackName, regionForState)
      );
      retainedEarlier.catch(() => undefined);
    }
  };

  // Live progress renderer (multi-line in-flight display at bottom of TTY).
  // Self-disables on non-TTY and when CDKD_NO_LIVE=1 is set. Created (not
  // started) BEFORE the lock acquisition below because the SIGINT handler
  // routes its notice through it; `printAbove` falls through to a direct
  // write while the renderer is not yet started.
  const renderer = getLiveRenderer();

  // Graceful SIGINT handling (issue #816, Terraform parity). The first
  // Ctrl-C sets `lock.interrupted`: the reverse-DAG delete loop below stops
  // SCHEDULING new deletes (it checks the flag before each level and before
  // dispatching each resource), but the already-dispatched in-flight
  // `provider.delete` calls in the current level are awaited to completion.
  // Control then falls through to the `finally` block, which flushes the
  // incremental save-chain (issue #804) — leaving a clean, minimal preserved
  // state — and releases the stack lock. A SECOND Ctrl-C force-quits.
  //
  // The handler, its registration before the acquire (issue #1348; the
  // under-lock strong-reference scan below is a second S3 round-trip in that
  // window), the ownership gate on the force-quit release, and the
  // release-then-unregister ordering are `acquireStackLock`'s
  // (go-to-k/cdkd#2174). Nested-stack destroys recurse into
  // `runDestroyForStack`, registering one handler per level — Node delivers
  // SIGINT to every listener, so the first Ctrl-C drains the parent AND every
  // in-flight child, which is the intended behavior.
  //
  // "Did this stack finish, or is there work left in it?" — the ONE per-stack
  // answer, and the gate on the outer `finally`'s interrupt re-sync below.
  //
  // Set from `preserveState` at the moment that decision is taken (below), i.e.
  // BEFORE `deleteState` runs. `preserveState === false` means the state file
  // was removed, which is only ever done for a stack with zero errors, zero
  // skips and no interrupt — nothing to re-run. A signal arriving after that
  // point must therefore NOT be able to report this stack as interrupted; see
  // the re-sync's own comment for the window that made it possible.
  let statePreserved = false;
  // go-to-k/cdkd#4705: the writes that follow the record's delete and must
  // finish under this stack's lock -- the kept list or tombstone, then the
  // marker's release -- when the caller lets them overlap its next stack
  // (`ctx.deferRegistryTail`); `undefined` when they were awaited here.
  let heldTail: Promise<void> | undefined;
  // Set once this stack's destroy has ended: a first Ctrl-C while its lock is
  // still held for `heldTail` has nothing of this stack to drain.
  let stackFinished = false;
  // go-to-k/cdkd#4584: the share of `errorCount` that is journaled orphans,
  // whose remedy differs (the summary never offers `cdkd state orphan`).
  let journaledOrphanFailures = 0;
  const lock = await acquireStackLock({
    ...stackLockBase,
    // Route the notice through the live renderer so it doesn't collide with
    // the in-flight task display.
    onFirstSignal: () => {
      if (stackFinished) return;
      renderer.printAbove(() => {
        process.stderr.write(
          '\nInterrupted — finishing in-flight deletes, then flushing state and releasing the lock ' +
            '(press Ctrl-C again to force-quit)...\n'
        );
      });
    },
    // Inside the guarded acquire (not before it): `logger.info` reaches
    // `process.stdout.write`, which can EPIPE (`cdkd destroy | head`), and a
    // throw here must still restore the cross-region globals below.
    beforeAcquire: () => {
      logger.info(`\nAcquiring lock for stack ${displayStackName(stackName)}...`);
    },
    // The main try/finally (which owns the region restore) starts further
    // below, so an acquire failure — contention included (issue #2161) — must
    // not leak the process-global region / AWS clients this function switched
    // for a cross-region stack.
    onAcquireFailure: restoreBaseRegionAndClients,
  });

  await recheckUnderLock({
    ctx,
    stackName,
    state,
    regionForState,
    refusalRecovery,
    lock,
    restoreBaseRegionAndClients,
    needsStrongRefCheck,
  });

  // Incremental state persistence (issue #804) — the destroy-side mirror of
  // deploy's `saveStateAfterResource`. Successfully deleted resources are
  // removed from this working copy as they complete, and the trimmed state
  // is persisted to S3 after each removal (writes are serialized through
  // `saveChain` and happen under the stack lock we already hold). An
  // interrupted or partially-failed destroy then leaves a state file that
  // only lists resources that still exist, so a re-run never replays a
  // delete against an already-deleted resource — the Custom Resource case
  // stalled 10 minutes per CR on replay before this. Retained resources
  // (`DeletionPolicy: Retain`) are intentionally NOT removed here: their
  // record is only dropped by the wholesale state-file delete at the end of
  // a clean destroy, matching the pre-#804 partial-failure behavior.
  // Persist failures are non-fatal (warn-and-continue) — the final write
  // below (deleteState on success / preserve-write on failure) remains
  // authoritative, and any stale snapshot is a superset of what still
  // exists, which a re-run resolves via the idempotent "not found" path.
  const remainingResources: Record<string, ResourceState> = { ...state.resources };
  // go-to-k/cdkd#5111: the superseded resources not yet deleted; a preserved
  // state keeps exactly these (a malformed entry is carried, never acted on).
  let remainingSuperseded = state.supersededResources;

  // Issue #1752 (G): the state file a user must repair is NOT always this
  // stack's. A skipped nested-stack row's malformed record lives in the CHILD's
  // state file (`<parent>~<childLogicalId>`), so a remedy naming
  // `cdkd state show <parent>` sends the user to a file that does not contain
  // the bad id. Collected during the loop so the summary can name the real
  // target(s).
  const stateTargetFor = (logicalId: string, resourceType: string): string =>
    resourceType === NESTED_STACK_TYPE ? `${stackName}~${logicalId}` : stackName;
  const skippedStateTargets = new Set<string>();
  // Issue #1777: the same is true of a FAILED row, and reaching it is new —
  // `NestedStackProvider.delete` only started throwing (rather than reporting
  // the child deleted) in that issue, so a nested-stack row can now land in the
  // error arm. Its failing resource lives in the CHILD's state file, so the
  // error arm's `cdkd state orphan <parent>` last-resort hint would drop the
  // parent's `Child` row — the exact pointer the throw exists to preserve.
  const failedStateTargets = new Set<string>();
  const { hintFor, hintHolesClause } = makeSummaryHints(regionForState, refusalRecovery);

  // Build the partial-destroy snapshot persisted by both the incremental
  // writes and the final preserve-write (issue #804). `outputs` / `imports`
  // / `outputReads` are CLEARED in a persisted destroy snapshot (one
  // exception, below), NOT carried over from the loaded `state`:
  //
  //   - `outputs` is keyed by output NAME, not logical id, so it cannot be
  //     pruned precisely as the backing resources are deleted. A partially
  //     (or fully) destroyed stack has no meaningful outputs, so a preserved
  //     snapshot that still advertised them would name exports whose backing
  //     resources are gone — a phantom export the exports index / a
  //     cross-stack consumer scan could pick up.
  //   - `imports` (this stack's `Fn::ImportValue` consumer records) and
  //     `outputReads` (its `Fn::GetStackOutput` records) are likewise
  //     meaningless once the stack is being torn down; clearing them keeps
  //     another producer's `scanActiveConsumers` from treating a
  //     mid-teardown stack as a live importer. go-to-k/cdkd#4150 is the
  //     one exception: they are KEPT while a remaining record still needs
  //     them (`keepEvidence` below).
  //
  // This does NOT disturb the destroy's OWN strong-reference check: that
  // reads the in-memory `state.outputs` (lines ~323 / ~412) BEFORE this
  // loop, and the in-memory `state` object is never mutated here (each
  // snapshot is a fresh spread). The export index for this stack is removed
  // on a clean destroy via `exportIndexStore.removeStack`; on a partial
  // destroy the index may still list stale entries (a perf-only DERIVED
  // view that self-heals on the next deploy / fallback scan — see
  // export-index-store.ts), but the canonical state.json no longer carries
  // the phantom outputs.
  // go-to-k/cdkd#4150: read ONCE, from the record as loaded, before a
  // snapshot below can strip the evidence. ASSIGNED at the top of the main
  // `try` below, not here: the lock is held by now, and its warning writes to
  // stderr, which can EPIPE — a throw before that `try` would strand the lock.
  let secretPrincipalRegions: string[] | undefined;
  let secretPrincipalRegionsIncomplete = false;
  const buildDestroySnapshot = (): StackState => {
    // Strip `imports` / `outputReads` entirely (rather than writing `[]`) to
    // keep the persisted shape identical to a freshly-deployed stack that
    // has none — the deploy engine omits both keys when empty.
    const {
      imports: _imports,
      outputReads: _outputReads,
      supersededResources: _superseded,
      ...rest
    } = state;
    // go-to-k/cdkd#4150: EXCEPT while a remaining record's secret-derived
    // principal list still needs that producer-region evidence, or a re-run
    // would classify its reference `local` where this run read `ambiguous`.
    // A remaining nested stack counts too on a resolving destroy: its child
    // inherits THESE regions, which its own state does not record. (A
    // consumer scan then still sees this stack as an importer: the safe side.)
    const keepEvidence = Object.values(remainingResources).some(
      (r) =>
        holdsSecretDerivedPrincipalRecord(r) ||
        (secretPrincipalRegions !== undefined &&
          typeof r === 'object' &&
          r !== null &&
          r.resourceType === 'AWS::CloudFormation::Stack')
    );
    return {
      ...rest,
      // go-to-k/cdkd#5111: `supersededResources` is written below, from what is left.
      ...stackInstanceIdCarriedFrom(withoutSuperseded(state)),
      // go-to-k/cdkd#5064 phase 2: a partial destroy keeps the record; what it
      // deleted or kept left the stack, so a redeploy re-adding a logical id
      // asks for a name no earlier copy held.
      ...retiredNameGenerationsLeaving(state, remainingResources),
      ...(keepEvidence && _imports !== undefined && { imports: _imports }),
      ...(keepEvidence && _outputReads !== undefined && { outputReads: _outputReads }),
      resources: { ...remainingResources },
      // go-to-k/cdkd#5111: what is left of them; none left drops the field.
      ...(remainingSuperseded !== undefined &&
        !(Array.isArray(remainingSuperseded) && remainingSuperseded.length === 0) && {
          supersededResources: remainingSuperseded,
        }),
      outputs: {},
      // The bag is REWRITTEN (empty), so its export set is known — and empty
      // (issue #2193). Carrying the record's previous set through `...rest`
      // would pair a known set with a bag that no longer holds those keys.
      exportNames: [],
      lastModified: Date.now(),
    };
  };

  let saveChain: Promise<void> = Promise.resolve();
  const persistStateAfterDelete = (logicalId: string): void => {
    saveChain = saveChain.then(async () => {
      try {
        await ctx.stateBackend.saveState(stackName, regionForState, buildDestroySnapshot());
        logger.debug(`State persisted after deleting ${displaySafe(logicalId)}`);
      } catch (error) {
        logger.warn(
          `Failed to persist state after deleting ${displaySafe(logicalId)} (continuing): ${describeAwsFailure(error).detail}`
        );
      }
    });
  };

  try {
    // A nested child destroyed ON ITS OWN (`cdkd state destroy
    // '<parent>~<child>'`) has no parent to hand down the regions its parent
    // reads from, so its evidence is incomplete (go-to-k/cdkd#4887): a
    // reference its record places in a region still resolves there, and every
    // other region-less one is skipped. A parent whose own evidence was
    // incomplete hands the marker down.
    const optIn = ctx.resolveSecretDerivedPrincipals;
    secretPrincipalRegions =
      optIn !== undefined
        ? destroyProducerRegions(state, optIn.inheritedProducerRegions)
        : undefined;
    secretPrincipalRegionsIncomplete =
      optIn !== undefined &&
      (optIn.producerRegionsIncomplete === true ||
        (state.parentStack !== undefined && optIn.inheritedProducerRegions === undefined));
    if (
      secretPrincipalRegionsIncomplete &&
      Object.values(state.resources ?? {}).some((r) => holdsUnprovenSecretPrincipalRecord(r))
    ) {
      logger.warn(
        safeMsg`${stackName}: this nested child is destroyed without its parent stack, so the regions its parent reads from are unknown: a secret-derived principal record whose reference has no recorded region is skipped. To resolve it, destroy it through its parent stack (the top-level stack that holds it).`
      );
    }

    // Start the live area only now — the earlier phases (lock, strong-ref
    // scan) log plain lines; the renderer itself was created before the lock
    // acquisition above so the SIGINT handler could reference it. Started
    // INSIDE this `try` (issue #2161): `start()` writes to stdout and can throw
    // (EPIPE on `cdkd destroy | head`), and the lock is held by now, so a throw
    // outside the `try` would strand the lock and leak the cross-region
    // region/clients — the main `finally` below releases and restores both.
    renderer.start();
    // Beside the journal re-read below (see `stackNoEchoValues`).
    void stackNoEchoValues();

    const journaledUnderLock = await reReadJournaledOrphansUnderLock({
      ctx,
      stackName,
      regionForState,
      state,
      journaledOrphans,
      logger,
    });
    const noEchoValues = await stackNoEchoValues();
    if (journaledUnderLock.count > 0) {
      const orphanOutcome = await deleteJournaledOrphans(
        journaledUnderLock,
        { ...state.resources },
        stackName,
        stackInstanceIdOf(state, displayStackName(stackName)),
        {
          providerRegistry: destroyProviderRegistry,
          region: regionForState,
          logger,
          ...(ctx.eventRecorder !== undefined && {
            recordEvent: (event) => ctx.eventRecorder!.record(event),
          }),
          finalSnapshotClients: destroyAwsClients ?? ctx.baseAwsClients,
          skipFinalSnapshot: ctx.skipFinalSnapshot === true,
          // go-to-k/cdkd#4678: as the state-tracked deletes below take it.
          ...(ctx.removeProtection === true && { removeProtection: true }),
          // go-to-k/cdkd#4696: an orphan another stack's record holds now is
          // not deleted, nor stripped of protection. Lazy, as in `cdkd rollback`.
          foreignHolder: makeForeignHolderScan(ctx.stateBackend)({
            stackName,
            region: regionForState,
          }),
          importedProducerRegions: producerRegionsFromState(state),
          // A nested child's own record lacks the regions its parent reads.
          ...(state.parentStack !== undefined && { producerRegionsIncomplete: true }),
        },
        {
          isInterrupted: () => lock.interrupted,
          noEchoValues,
          retiredNameGenerations: state.retiredNameGenerations,
        }
      );
      result.errorCount += orphanOutcome.failures;
      journaledOrphanFailures = orphanOutcome.failures;
      // go-to-k/cdkd#4658: one left in AWS with a warning (another stack holds
      // it, or nothing proves it is the one the failed deploy made) is not
      // cleaned up: the destroy must not report success over it (exit 2). It
      // holds no state record, so it does not keep the state (see below).
      result.skippedCount += orphanOutcome.skipped;
      result.journaledOrphanSkips += orphanOutcome.skipped;
      // Mirror `cdkd rollback`'s per-op strip: a later failure keeps the
      // journal for a re-run, which must not re-send a settled delete.
      // Best-effort: a failed strip only makes that re-run repeat it, which
      // reads not-found as done.
      if (orphanOutcome.handled.length > 0) {
        try {
          await ctx.stateBackend.dropRollbackJournalFailedOperations(
            stackName,
            regionForState,
            (op, segment) => isHandledOrphan(orphanOutcome.handled, segment, op)
          );
        } catch (stripError) {
          logger.warn(
            safeMsg`Failed to strip the deleted journal entries (a re-run repeats their deletes): ${describeAwsFailure(stripError).detail}`
          );
        }
      }
    }

    const { dagBuilder, blockingGraph, executionLevels } = buildDeleteGraph(state, logger);

    // go-to-k/cdkd#5670: a resource whose delete FAILED may still need what it
    // depends on to be deleted later -- an ECS gateway's infrastructure role,
    // a VPC gateway attachment's internet gateway. So every resource it
    // TRANSITIVELY depends on (over `blockingGraph`) is left in AWS and in state, mapped to the first
    // failed resource that blocked it, as CloudFormation's DELETE_FAILED
    // leaves them; resources unrelated to it are still deleted, as
    // CloudFormation also does. A dependency always sits on a LATER deletion
    // level than its dependent, so marking it when the dependent's delete
    // settles is in time. A SKIP does not block: like the deploy engine's
    // DELETE phase, which stops on a failure but not on a skip, the destroy
    // still deletes what a skipped resource depends on -- the custom-resource
    // skip flow relies on its backing Lambda being gone for the re-run.
    const blockedBy = new Map<string, string>();
    const blockedIds: string[] = [];
    const blockDependenciesOf = (logicalId: string): void => {
      for (const dependency of dagBuilder.getAllDependencies(blockingGraph, logicalId)) {
        if (!blockedBy.has(dependency)) blockedBy.set(dependency, logicalId);
      }
    };

    const printingBagOf = makePrintingBagOf({ ctx, state, noEchoValues, stackName, logger });
    const resourceFrame: DeleteResourceFrame = {
      lock,
      state,
      ctx,
      stackName,
      logger,
      result,
      renderer,
      blockedBy,
      blockedIds,
      blockDependenciesOf,
      retainedForReadoption,
      startRetainedEarlierRead,
      skippedStateTargets,
      failedStateTargets,
      stateTargetFor,
      guardIndeterminateTargets,
      remainingResources,
      persistStateAfterDelete,
      printingBagOf,
      destroyProviderRegistry,
      destroyAwsClients,
      secretPrincipalRegions,
      secretPrincipalRegionsIncomplete,
    };

    // go-to-k/cdkd#5111: the old copies a replacement left to delete. A failure
    // or a skip keeps its entry, and with it the state, for a re-run.
    // `early` (go-to-k/cdkd#6117): an attempt before the stack's own resources,
    // whose failure or skip is neither counted nor dropped but answers `true`,
    // so the entry is sent again after them, as before #6117.
    const deleteSupersededRow = async (
      entry: SupersededResourceRecord,
      early = false
    ): Promise<boolean> => {
      const { logicalId } = entry;
      const { physicalId, resourceType } = entry.state;
      const drop = (): void => {
        remainingSuperseded = (remainingSuperseded ?? []).filter((row) => row !== entry);
      };
      // Every line names the id under the row's printing bag: the id can
      // spell a secret-derived name (go-to-k/cdkd#3869).
      // The OLD record's own needles too, judged as an orphan's are, beside
      // the row's current one (a rotated secret's name).
      const bag = unionOfSecretBags([
        printingBagOf(logicalId),
        orphanRecordsPrintingBag([entry], noEchoValues),
      ]);
      // A record names its id (a rollback took it back): deleted above, as
      // that record's resource, or kept with it -- never deleted here.
      const holder = supersededHolderOf(entry, state.resources);
      if (holder !== undefined) {
        drop();
        if (holder.resourceType !== resourceType) {
          withPrintingSecrets(bag, () =>
            logger.warn(
              safeMsg`  ⚠ ${supersededHeldByOtherTypeWarning(entry, holder.resourceType)}`
            )
          );
        }
        return false;
      }
      return withPrintingSecrets(bag, async (): Promise<boolean> => {
        logger.info(safeMsg`Deleting ${logicalId}'s superseded ${resourceType} (${physicalId})...`);
        let outcome: Awaited<ReturnType<typeof deleteSupersededEntry>>;
        try {
          outcome = await withStackRecords(
            {
              live: () => Object.entries(remainingResources),
              survivors: () => Object.entries(remainingResources),
            },
            () =>
              deleteSupersededEntry(entry, {
                provider: destroyProviderRegistry.getProviderFor({
                  resourceType,
                  ...(entry.state.provisionedBy !== undefined && {
                    provisionedBy: entry.state.provisionedBy,
                  }),
                }).provider,
                region: state.region ?? regionForState,
                ...(ctx.removeProtection === true && { removeProtection: true }),
                ...(ctx.stackDestroy === true && { stackDestroy: true }),
                maskSecrets: createUnionSecretMasker([bag]),
                stop: () => lock.interrupted,
              })
          );
        } catch (error) {
          outcome = { kind: 'failed', error };
        }
        if (outcome.kind === 'deleted') {
          result.deletedCount++;
          drop();
          logger.info(safeMsg`  ✓ Deleted ${logicalId}'s superseded ${resourceType}`);
          return false;
        }
        if (early) {
          // A not-yet-updated resource of a failed deploy may still use the
          // old id; nothing printed carries the failure's text.
          logger.info(
            safeMsg`  ${logicalId}'s superseded ${resourceType} (${physicalId}) was not deleted yet; retrying after the stack's own resources`
          );
          return true;
        }
        const why =
          outcome.kind === 'notDeleted'
            ? outcome.reason
            : maskSecretsInText(describeAwsFailure(outcome.error).detail, bag);
        if (outcome.kind === 'notDeleted') {
          // As the deploy treats it: a provider that will not address it
          // would refuse every re-run, so the record goes, with this line.
          drop();
          result.skippedCount++;
          result.journaledOrphanSkips++;
          logger.warn(
            safeMsg`  ⚠ ${logicalId}'s superseded ${resourceType} (${physicalId}) was not deleted: ${why}. ` +
              'Delete it manually — it is no longer tracked in state.'
          );
          return false;
        }
        result.errorCount++;
        logger.warn(
          safeMsg`  ⚠ ${logicalId}'s superseded ${resourceType} (${physicalId}) was not deleted: ${why}. ` +
            'State preserved: it stays recorded, and a re-run of the destroy retries it.'
        );
        return false;
      });
    };

    // go-to-k/cdkd#6117: a custom resource's old physical id is deleted
    // BEFORE the stack's own resources: its Delete runs through the handler
    // (the ServiceToken function, a provider framework), which those take
    // down. After a failed deploy a resource not yet updated may still name
    // the old id, so one that is not deleted here is sent again after them.
    const retryLate = new Set<SupersededResourceRecord>();
    for (const entry of supersededResourcesOf(state)) {
      if (lock.interrupted) break;
      if (!isCustomResourceType(entry.state.resourceType)) continue;
      if (await deleteSupersededRow(entry, true)) retryLate.add(entry);
    }

    // Process levels in reverse order for deletion.
    for (let levelIndex = executionLevels.length - 1; levelIndex >= 0; levelIndex--) {
      // Graceful SIGINT (issue #816): once draining, do not start a new
      // deletion level. Any level already in flight finished via its own
      // `Promise.all` below; remaining levels are left untouched and their
      // resources stay in the preserved state for a clean re-run.
      if (lock.interrupted) {
        logger.debug('Interrupted (draining) — not scheduling further deletion levels');
        break;
      }

      const level = executionLevels[levelIndex];
      if (!level) continue;

      logger.debug(
        `Deletion level ${executionLevels.length - levelIndex}/${executionLevels.length} (${level.length} resources)`
      );

      const stackRegion = state.region ?? ctx.baseRegion;

      // go-to-k/cdkd#3869: each resource's delete runs under a PRINTING bag of
      // its own name spellings and those of each secret-named sibling its
      // record holds, so its provider's delete lines, a deleted reader's
      // warnings and the final-snapshot lines mask a name derived from a
      // secret. `getCurrentResourceSecrets` never returns it.
      const deletePromises = level.map((logicalId) =>
        withPrintingSecrets(printingBagOf(logicalId), () =>
          deleteStackResource(resourceFrame, logicalId, stackRegion)
        )
      );

      await Promise.all(deletePromises);
    }

    // AFTER the stack's own resources, any of which may still have used one.
    // A custom resource's old physical id went BEFORE them (above), unless
    // that attempt did not delete it.
    for (const entry of supersededResourcesOf(state)) {
      if (lock.interrupted) break;
      if (isCustomResourceType(entry.state.resourceType) && !retryLate.has(entry)) continue;
      await deleteSupersededRow(entry);
    }

    // A superseded row cdkd cannot read is carried, never acted on, and may
    // name a live resource: a skip, so the state that holds it is kept.
    const unreadableSuperseded = Array.isArray(state.supersededResources)
      ? state.supersededResources.filter((row) => !isSupersededResourceRecord(row)).length
      : holdsSupersededResources(state)
        ? 1
        : 0;
    if (unreadableSuperseded > 0) {
      result.skippedCount += unreadableSuperseded;
      // The summary's skip hints name this record (`state show` / `state orphan`).
      skippedStateTargets.add(stackName);
      const one = unreadableSuperseded === 1;
      logger.warn(
        safeMsg`  ⚠ ${unreadableSuperseded} superseded resource ` +
          (one ? 'entry' : 'entries') +
          ' in state could not be read, so nothing was deleted for ' +
          (one ? 'it' : 'them') +
          '. State preserved: it may name a resource still in AWS.'
      );
    }

    // Carry the graceful-interrupt outcome (issue #816) into the result so the
    // CLI surfaces a non-zero exit. Read AFTER the level loop so a SIGINT that
    // arrived while the final level was draining is still observed.
    result.interrupted = lock.interrupted;

    // Flush pending incremental persists BEFORE the final state decision so
    // a chained write can never land after deleteState and re-create the
    // state file. The chain never rejects (each link catches internally).
    await saveChain;

    // Preserve state (rather than delete it) when there were delete errors OR
    // the destroy was gracefully interrupted (issue #816) OR a resource was
    // SKIPPED (issue #1752). An interrupt leaves not-yet-deleted resources, so
    // deleting the state file would orphan them; a skip leaves a resource cdkd
    // could not even address, so dropping its record orphans it permanently
    // and with no id to go on.
    // A journaled orphan's skip keeps nothing: no state row held it, and its
    // journal entry was settled above, so the state would be kept empty.
    const preserveState =
      result.errorCount > 0 ||
      result.interrupted ||
      result.blockedCount > 0 ||
      result.skippedCount > result.journaledOrphanSkips;
    // Publish the per-stack "is there work left in this stack" answer to the
    // outer `finally` BEFORE the branch below acts on it, so the re-sync there
    // can never contradict a `deleteState` that has already happened.
    statePreserved = preserveState;
    if (!preserveState) {
      await ctx.stateBackend.deleteState(stackName, regionForState);
      result.stateDeleted = true;
      logger.debug('State deleted');
      // go-to-k/cdkd#4705: what this destroy kept, which the stack's next
      // create here may take back by name -- or, kept nothing, the tombstone
      // (review D-1); exactly one of the two, so the tombstone is never
      // written over a kept list. With the marker's release, run beside the
      // exports-index update that always followed the record's delete, so
      // they add no round trip of their own (review P3, H-2/(h)). After
      // `deleteState` -- the marker must not be released while the record
      // exists -- and under this stack's lock. A failure, or a crash before
      // the kept write, leaves those resources unrecorded: warned, and their
      // re-create is refused with the `cdkd import` remedy. (A preserved
      // state keeps their rows instead, so it writes none of this.)
      //
      // The exports index: drop this stack's entries so the next resolver
      // lookup doesn't return stale values. Best-effort — failures don't fail
      // the destroy (state.json is the canonical record, and the index
      // self-heals on next deploy / fallback).
      //
      // With `ctx.deferRegistryTail` (`destroy --all`), the kept-list /
      // tombstone write and the marker's release are not awaited here: this
      // stack's lock is held until they settle (`holdUntil` below) while the
      // command moves on, so they cost no round trip per stack. The exports
      // index is still awaited here.
      // go-to-k/cdkd#2346: the history purge (`cdkd state destroy` only)
      // follows the kept write, so the generated-name guard's earlier-record
      // source is gone only once `retained.json` replaces it.
      const writeKept = (): Promise<void> =>
        recordRetainedForReadoption(
          ctx.stateBackend,
          stackName,
          regionForState,
          retainedForReadoption,
          logger,
          retainedEarlier
        ).then(() => purgeStateHistoryIfOptedIn(ctx, stackName, regionForState));
      const releaseMarker = (): Promise<void> =>
        releaseRegistryMarkerAfterDestroy(ctx, stackName, regionForState, logger);
      if (ctx.deferRegistryTail !== undefined) {
        // Off the critical path, so serialized as orphan, export and rollback
        // do: the kept list or tombstone, then the marker (review nit). Both
        // never throw.
        heldTail = writeKept().then(releaseMarker);
        await ctx.exportIndexStore?.removeStack(stackName, regionForState);
      } else {
        // A single destroy runs them concurrently with the exports-index
        // update it always awaited, so they cost no round trip of their own;
        // serializing them here would add one per stack.
        await Promise.all([
          writeKept(),
          releaseMarker(),
          ctx.exportIndexStore?.removeStack(stackName, regionForState),
        ]);
      }
    } else {
      // Final authoritative write of the remaining state (not-yet-deleted +
      // failed + retained resources). The incremental persists above are
      // best-effort, so re-write once here to cover the case where some of
      // them failed. Failure here is also non-fatal: the state file in S3
      // is then at worst a superset of what still exists, which a re-run
      // resolves via the idempotent "not found" path.
      try {
        await ctx.stateBackend.saveState(stackName, regionForState, buildDestroySnapshot());
      } catch (error) {
        logger.warn(
          `Failed to persist remaining state after partial destroy: ${describeAwsFailure(error).detail}. ` +
            `The state file may still list already-deleted resources; a re-run resolves them idempotently.`
        );
      }
      if (result.interrupted) {
        logger.warn(
          `Destroy interrupted — ${Object.keys(remainingResources).length} resource(s) not deleted. State preserved.`
        );
      } else if (result.errorCount > 0) {
        logger.warn(
          `${result.errorCount} resource(s) failed to delete` +
            (journaledOrphanFailures > 0
              ? ` (${journaledOrphanFailures} of them recorded only in the rollback journal)`
              : '') +
            `. State preserved.`
        );
      } else {
        // Only the skips a record holds: the journaled orphans have their own
        // line below.
        logger.warn(
          `${result.skippedCount - result.journaledOrphanSkips} resource(s) skipped — cdkd did not confirm they were deleted, ` +
            `so they may still exist in AWS. State preserved (the records are kept so the ` +
            `resources stay traceable).`
        );
      }
      if (result.blockedCount > 0) {
        logger.warn(
          safeMsg`${result.blockedCount} resource(s) not deleted because the delete of a resource that ` +
            'depends on them failed, as CloudFormation leaves them: ' +
            safeMsg`${blockedIds.map((id) => plainOrDescribed(id, 'logical id')).join(', ')}. ` +
            'Their records are kept: once the resource blocking them is deleted, a re-run of ' +
            safeMsg`${proseQuoted(cdkdRemedy('cdkd destroy'))} / ${proseQuoted(cdkdRemedy('cdkd state destroy'))} deletes them.`
        );
      }
    }

    printDestroySummary({
      result,
      ctx,
      stackName,
      logger,
      preserveState,
      guardIndeterminateTargets,
      skippedStateTargets,
      failedStateTargets,
      hintFor,
      hintHolesClause,
      journaledOrphanFailures,
    });
  } finally {
    // `lock.release()` releases FIRST and removes the listener LAST, in its own
    // `finally` (go-to-k/cdkd#2174). This block used to unregister first,
    // which left the lock held with NO handler of this command's until the
    // release resolved: a Ctrl-C there was answered by the provider-side
    // interrupt watch's last-listener force-quit
    // (`src/provisioning/interrupt-watch.ts`), the process exited 130, and the
    // release never ran — stranding the lock for its full 30-minute TTL (the
    // issue #1348 class). A SIGTERM landing mid-release is likewise still
    // forwarded through the handler rather than hitting the exit-143 fallback.
    //
    // `beforeRelease` runs with the handler still armed, and a throw in it
    // still removes the listener — one leaked per stack would keep the shared
    // watch from ever being alone, silently disabling its force-quit.
    //
    // Awaiting `release()` adds no window after the removal: its resolution is
    // a microtask, and a signal is delivered only from the event loop. DO NOT
    // add an I/O `await` between it and this function's return —
    // `watchCommandInterrupt` (issue #2117) takes over once the handler is
    // gone, and its force-quit prints only the hedged
    // `cdkd force-unlock <stack-name>` placeholder, on exactly the path where
    // a FAILED release (warned, not thrown) left the lock stranded.
    try {
      await lock.release({
        failureMessage: `Failed to release lock for stack ${displayStackName(stackName)}`,
        ...(heldTail !== undefined &&
          ctx.deferRegistryTail !== undefined && {
            holdUntil: { work: heldTail, defer: ctx.deferRegistryTail },
          }),
        beforeRelease: async () => {
          // Stop live renderer before releasing the lock so any pending
          // in-flight task lines are cleared cleanly.
          //
          // CAUGHT rather than allowed to propagate: `stop()` writes to stdout,
          // so an EPIPE on a closed pipe (`cdkd destroy | head`) would skip the
          // release entirely and strand the lock. `release()`'s `finally`
          // protects the LISTENER from that; only this catch protects the LOCK
          // (measured before both: `threw=EPIPE releaseLock=0
          // leakedListeners=1`). A teardown write failing is also the single
          // most swallowable error on this path — the terminal is already gone.
          try {
            renderer.stop();
          } catch (rendererError) {
            logger.debug(
              `Live renderer teardown failed (continuing to release the lock): ` +
                `${describeAwsFailure(rendererError).detail}`
            );
          }

          // Drain any still-pending incremental persists before releasing the
          // lock — on the happy path this resolved already (awaited above), but
          // a throw between scheduling and the flush must not let a state write
          // land after the lock is gone. Never rejects (links catch internally).
          await saveChain;

          logger.debug('Releasing lock...');
        },
      });
      stackFinished = true;
    } finally {
      // Restore the cross-region switch HERE, in a guaranteed `finally`, so a
      // throwing release step cannot skip it and leak the target region /
      // global clients into the rest of a `--all` run (issue #2161). The
      // helper is idempotent, so any earlier exit-path call is a no-op.
      restoreBaseRegionAndClients();
    }

    // RE-SYNC the interrupt outcome, because the reordering above MOVED the
    // window it is read in. `result.interrupted` is assigned once, inside the
    // `try`, after the level loop — and everything in this `finally` now runs
    // with the lock's SIGINT handler still armed, so a FIRST Ctrl-C landing in
    // the renderer teardown, the state flush or the lock release sets
    // `lock.interrupted` AFTER that read. It then stayed false, and
    // `destroy --all` deleted the NEXT STACK after the user asked to stop.
    //
    // That trade is worse than the bug the reordering fixed: before it, the same
    // signal hit the interrupt watch's force-quit and exited 130 — stranding the
    // lock, but never destroying stack B. `||=` rather than `=` because the
    // in-`try` read is the authoritative one for every signal that arrived
    // earlier; this only ever turns false into true. The `return` sits after
    // this `finally`, so the caller sees the corrected value.
    //
    // Kept, and no longer the only thing standing between a Ctrl-C and the next
    // stack. This line was TACTICAL by design: `result.interrupted` being the
    // ONLY channel from here to the `--all` loop was the actual defect, because
    // `destroy.ts` registered no SIGINT handler of its own where `deploy.ts`
    // did. https://github.com/go-to-k/cdkd/issues/2117 closed that — both
    // destroy commands now hold a command-scoped handler
    // (`watchCommandInterrupt`) for their whole run, and their loops read it
    // live, so a signal landing after this `finally` (or after the
    // guard's own listener removal, which this line cannot see either) still stops
    // the run.
    //
    // `&& statePreserved` is what makes this line mean what its readers need.
    // OWNERSHIP: `result.interrupted` is the ONE per-stack answer to "did THIS
    // stack finish, or is there work left in it?", and FOUR consumers read it —
    // this stack's state preservation, its summary line, (since this fix)
    // `destroy.ts`'s `--purge-events` skip, and `NestedStackProvider.delete`,
    // which reads a CHILD's result to decide the child row's
    // `{ outcome: 'skipped' }` and its `markNonRetryable` classification. That
    // fourth one was missing from this list for two review rounds; see
    // `interrupt-signals.ts`'s module doc for why the gate's effect on it is
    // the correct reading rather than a regression. The COMMAND-level "has
    // the user asked to stop" is a different question with a different owner:
    // `watchCommandInterrupt`, which the loops read live.
    //
    // Ungated, this line answered the command-level question in the per-stack
    // channel, and got the per-stack one WRONG. `preserveState` is decided
    // inside the `try` from the in-`try` read; a signal landing after it — in
    // `renderer.stop()`, the `saveChain` flush, the real `deleteState` S3
    // round-trip, or `releaseLock` — flipped `lock.interrupted` with the state
    // file ALREADY DELETED, and the caller then reported "State preserved —
    // re-run 'cdkd destroy' to finish" and exited 2 over a stack that had fully
    // completed. Both halves of that sentence false. The invariant this gate
    // fences: a stack whose state was deleted never reports `interrupted`.
    //
    // Note the correction is still needed for the OTHER half — a stack that
    // preserved state (errors / skips / an earlier interrupt) and then takes a
    // tail signal genuinely does have work left, and `||=` rather than `=`
    // keeps the in-`try` read authoritative for every signal that arrived
    // earlier. `statePreserved` starts false, so a `try` that threw before the
    // preserve decision cannot flip anything — and on that path `result` is
    // never returned anyway.
    result.interrupted ||= lock.interrupted && statePreserved;
    // (The cross-region region/client restore now runs in the inner `finally`
    // above, so it happens even if `releaseLock` rejected — issue #2161.)
  }

  return result;
}
