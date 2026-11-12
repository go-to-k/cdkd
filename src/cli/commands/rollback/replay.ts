import {
  holdsSupersededResources,
  supersededAfterRollback,
} from '../../../deployment/superseded-resources.js';
import { releaseRegistryMarkerQuietly } from '../registry-release.js';
import { recordRetainedForReadoption } from '../../../deployment/retained-readoption.js';
import { applyCrossPrefixScan } from '../../../state/cross-prefix-stack-scan.js';
import { CrossPrefixGuard } from '../../../state/stack-registry.js';
import { isIamRoleArn } from '../../../utils/role-arn.js';
import { plainOrDescribed, quotedOrDescribed } from '../../../utils/pasteable-command.js';
import { resolvePendingCloudControlRequests } from '../../../deployment/cc-pending-requests.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { forwardSigtermToSigint } from '../../../utils/interrupt-signals.js';
import { PartialFailureError } from '../../../utils/error-handler.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import { withNestedStackContext } from '../../../provisioning/nested-stack-context.js';
import {
  NESTED_PENDING_PARENT_REASON,
  dropSettledNestedJournals,
  nestedChildStackName,
  recordDisplacedSkips,
  revertedNestedRowIds,
  withNestedRevertRun,
  type NestedRevertRun,
} from '../../../deployment/nested-child-journal.js';
import { withSkipPrefix, withStackScope } from '../../../provisioning/resource-name.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import {
  nameScopeOf,
  retiredAfterRollback,
  type RolledBackCreate,
} from '../../../state/name-generation.js';
import { resolveSkipPrefix } from '../../config-loader.js';
import { startRunRecorder } from '../deployment-events-run.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import {
  completedReplayEntries,
  journaledOrphanPrintingBag,
  maskEventTextWithBoundBags,
} from '../../../deployment/secret-name-needles.js';
import {
  replayRollback,
  replayFailedOperations,
  demoteSupersededOrphans,
  isJournaledOrphan,
  producerRegionsFromState,
  type RollbackExecutorContext,
} from '../../../deployment/rollback-executor.js';
import { RollbackInlinePolicyWriters } from '../../../deployment/inline-policy-claims.js';
import {
  dropFailedHint,
  makeForeignHolderScan,
} from '../../../deployment/rollback-executor/journaled-orphans.js';
import { seedsDeleteFirstGuard } from '../../../deployment/rollback-executor/plan.js';
import { segmentCleanupOptions } from '../../../deployment/rollback-executor/replay-moved-id-cleanup.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type ResourceState,
  type StackState,
  orphansAfterRollback,
  stackInstanceIdCarriedFrom,
  type StackOrphanRecord,
  type SupersededResourceRecord,
} from '../../../types/state.js';
import { splitImportedOps } from '../../../types/rollback-journal.js';
import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedState,
} from '../../../state/malformed-resources-bag.js';
import {
  ledgerForStack,
  withCreateTokenLedger,
} from '../../../provisioning/providers/create-token-ledger.js';
import type { StateSetup } from '../state.js';
import type { ConsoleLogger } from '../../../utils/logger.js';
import {
  rerunRollback,
  backendErrorText,
  stackRegionShown,
  stackRegionIsPlain,
  STACK_REGION_DESCRIBED_NOTE,
  safe,
  safeStack,
  safeRoleArn,
  displacedOpLabel,
  failedOpsToReplay,
  confirm,
} from './render.js';
import type { RollbackOptions } from './options.js';
import {
  refuseDivergentRecordRegionForRollback,
  divergedDuringRollbackMessage,
  judgeNestedPendingRecords,
} from './guards.js';
import { printRollbackPlanSegments } from './preview.js';

/**
 * What {@link runRollbackReplay} reads from the enclosing
 * `rollbackCommand` call: its arguments and the locals it resolved
 * before entering the stack AWS client scope.
 */
export interface RollbackReplayContext {
  providerClasses: Awaited<ReturnType<typeof loadProviderClasses>>;
  setup: StateSetup;
  options: RollbackOptions;
  logger: ConsoleLogger;
  stackName: string;
  region: string;
  crossPrefixScan: ReturnType<CrossPrefixGuard['full']>;
  finalSnapshotClients: AwsClients;
  skipConfirmation: boolean;
}

/**
 * The body of `cdkd rollback` that runs inside the stack AWS client scope
 * (go-to-k/cdkd#4932): provider registration, the lock, the plan, the
 * confirmation and the replay. `rollbackCommand` awaits it under
 * `runWithStackAwsClients`; its outer `finally` restores the client set.
 */
export async function runRollbackReplay(ctx: RollbackReplayContext): Promise<void> {
  const {
    providerClasses,
    setup,
    options,
    logger,
    stackName,
    region,
    crossPrefixScan,
    finalSnapshotClients,
    skipConfirmation,
  } = ctx;
  // 2. Register providers (exactly like deploy / destroy).
  const providerRegistry = new ProviderRegistry();
  registerAllProviders(providerRegistry, providerClasses);
  providerRegistry.setCustomResourceResponseBucket(setup.bucket);

  // Interrupt handling, registered BEFORE the lock acquisition below
  // (issue #1348) so a signal landing during the acquisition's S3
  // round-trip flips the flag — the replay loop then stops before its
  // first operation and the `finally` releases the lock — instead of
  // killing the process with the just-written lock stranded.
  let interrupted = false;
  // Set when the retry save declined to write over a record rewritten mid-run
  // with a divergent body region (go-to-k/cdkd#3370). The segment in flight
  // FINISHES — deliberately NOT routed through `isInterrupted`, which the
  // executor also hands to in-arm retries, so a stop there can abort a
  // delete-new-first reverse-replacement between its delete and its re-create
  // and leave neither resource. Those ops act in the region the START-of-run
  // record agreed with, so finishing is safe. What the flag stops is the
  // pop — which also keeps the initial-deploy `deleteState` from removing
  // the very record this declined to overwrite, since that needs an empty
  // journal — and every older segment; the run then exits partial.
  let declinedDivergentRewrite = false;
  let declinedDivergentReason = '';
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
    // go-to-k/cdkd#5064: the replay re-derives names in the lifetime the
    // record names. No record (a first deploy that saved nothing) leaves
    // only creates to delete, which derive no name.
    const stackInstanceId = stackInstanceIdOf(stateData?.state, displayStackName(stackName));
    let journal = await setup.stateBackend.loadRollbackJournal(stackName, region);
    // go-to-k/cdkd#3252: settle the Cloud Control CREATEs a failed deploy
    // stopped waiting for before the journal is planned: one that made its
    // resource becomes a proven orphan `--revert-failed` deletes, one
    // still unknown refuses the rollback. Re-read only when it rewrote.
    if (
      await resolvePendingCloudControlRequests({
        journal: setup.stateBackend,
        loaded: journal,
        reader: () => providerRegistry.getCloudControlProvider(),
        stackName,
        region,
        command: 'rollback',
        logger,
        stateResources: stateData?.state.resources,
        // No record yet (a first deploy that saved nothing): its id is
        // only in the write-ahead sibling, read without minting so a
        // generated name the abandoned create made reads as a name.
        stackInstanceId:
          stateData === null
            ? () => setup.stateBackend.readStackInstanceSibling(stackName, region)
            : stackInstanceId,
      })
    ) {
      journal = await setup.stateBackend.loadRollbackJournal(stackName, region);
    }
    // Issue #3754: `nested-pending-parent` records, judged BEFORE the plan and
    // the prompt, and written only after the confirmation (below).
    const orphanedPending = journal
      ? await judgeNestedPendingRecords(setup, stackName, region, journal.segments)
      : 0;
    if (journal && orphanedPending > 0) {
      // Replayed from the in-memory journal; the S3 copy loses the same
      // segments once the user confirms, before any pop.
      journal = {
        ...journal,
        segments: journal.segments.filter((s) => s.reason !== NESTED_PENDING_PARENT_REASON),
      };
    }
    if (!journal || (journal.segments.length === 0 && orphanedPending === 0)) {
      throw new Error(
        // Named only when plain, described otherwise: the block carries the
        // `cdkd deploy` / `cdkd destroy` remedy (go-to-k/cdkd#3950's S1 rule).
        `Nothing to roll back for ${plainOrDescribed(stackName, 'stack name')} ` +
          `(${plainOrDescribed(region, 'region')}). ` +
          "Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up."
      );
    }
    applyCrossPrefixScan(
      await crossPrefixScan,
      {
        stackName,
        region,
        bucket: setup.bucket,
        recovery: { profile: options.profile, stateBucket: setup.bucket },
      },
      'rollback',
      (message) => logger.warn(message),
      (message) => logger.info(message)
    );
    if (!stateData) {
      throw new Error(
        `Rollback journal exists for ${safeStack(stackName)} (${safe(region)}) but its state.json is missing ` +
          // Rendered SEGMENT BY SEGMENT, not as one pre-joined string: this
          // key is the operator's only route to the record the sentence says
          // is corrupted, and joining first put the whole path under the
          // 255-code-point identifier default -- cutting it mid-path for
          // exactly the deep nested-stack names this file widens the cap for.
          `(keys: ${safe(setup.prefix)}/${safeStack(stackName)}/${safe(region)}/state.json ` +
          `and .../rollback-journal.json). ` +
          `State appears corrupted — inspect the bucket manually.`
      );
    }
    // go-to-k/cdkd#1710: before the plan and every replay, so a proven
    // failed-CREATE orphan later activity may own is skipped with a warning,
    // never deleted. A non-array `orphans` is refused below
    // (`refuseMalformedOrphans`) before anything acts on this verdict.
    demoteSupersededOrphans(
      journal.segments,
      Array.isArray(stateData.state.orphans) ? stateData.state.orphans : []
    );
    // Issue #3754: a nested child whose OWN deploy failed in a segment's run
    // left its completed ops in its journal, and only `--revert-failed`
    // replays that failed row. Without it the parent's older segments would
    // revert the child past those ops first, and a later rollback of the
    // child would then restore the failed run's values over the older ones.
    // Refused up front, before any replay, so the order cannot invert.
    if (!options.revertFailed) {
      for (const segment of journal.segments) {
        // go-to-k/cdkd#4523: an imported failed row is never replayed, so
        // it is not one this refusal's `--revert-failed` advice reaches.
        const failedRows = splitImportedOps(segment.failedOperations ?? [], segment).replay;
        for (const logicalId of revertedNestedRowIds(failedRows)) {
          const child = nestedChildStackName(stackName, logicalId);
          const childJournal = await setup.stateBackend
            .loadRollbackJournal(child, region)
            .catch(() => null);
          const unreverted = (childJournal?.segments ?? []).some(
            (s) =>
              s.runId === segment.runId &&
              s.reason !== NESTED_PENDING_PARENT_REASON &&
              splitImportedOps(s.operations, s).replay.length > 0
          );
          if (unreverted) {
            throw new Error(
              // Named only when plain, described otherwise: the child's name
              // carries the journal's logical id, and this line names
              // `--revert-failed` (go-to-k/cdkd#4214, go-to-k/cdkd#3950's S1
              // rule).
              `Nested stack ${plainOrDescribed(child, 'nested stack name')} failed during a deploy this journal records, and its ` +
                `own journal still holds that deploy's completed operations. Re-run with ` +
                `--revert-failed so they are reverted in order with the parent's.`
            );
          }
        }
      }
    }
    const baseState = stateData.state;
    // `cdkd rollback` replays journal segments and SAVES after each one, and
    // a spread of a null bag yields `{}` silently -- so without this the
    // command would replace an unreadable resource map with a well-formed
    // empty one, in the command a user reaches for when state is ALREADY
    // suspect (go-to-k/cdkd#3018).
    // `refusalRecovery` qualifies each refusal's pasteable commands with this
    // run's account flags, so they read the bucket this run read
    // (go-to-k/cdkd#3909).
    const refusalRecovery = {
      profile: options.profile,
      stateBucket: setup.bucket,
      statePrefix: options.statePrefix,
    };
    refuseMalformedState(baseState, stackName, region, refusalRecovery);
    // The `orphans` CONTAINER, ahead of every replay and of
    // `orphansAfterRollback` (go-to-k/cdkd#3379): that helper walks the
    // container with `for...of`, so a string comes back as a list of its
    // characters and this command SAVES it — a damaged container rewritten
    // into a differently damaged one, silently.
    refuseMalformedOrphans(baseState, stackName, region, refusalRecovery);
    // The ROWS (go-to-k/cdkd#3500). This command is where the collapse is
    // observable: `orphansAfterRollback` keys on `entry.logicalId`, so rows
    // MISSING one all write the SAME `undefined` entry and the record saved
    // below keeps one of them. Two distinct numeric ids do not collide; two
    // rows SHARING a string id do, and are refused here too (go-to-k/cdkd#3643).
    refuseMalformedOrphanRecords(baseState, stackName, region, refusalRecovery);
    // A record whose body `region` disagreed with the key it was read from
    // (go-to-k/cdkd#3370) — BELOW `refuseMalformedState`, which proves the
    // bag this counts can be read, and ABOVE the plan preview, the prompt and
    // every replay arm, so the refusal covers all of them at once.
    refuseDivergentRecordRegionForRollback(
      baseState,
      stackName,
      region,
      stateData.divergentBodyRegion,
      // go-to-k/cdkd#4584: a plain rollback deletes them too.
      journal.segments
        .flatMap((seg) => seg.failedOperations ?? [])
        .filter((op) => op.physicalIdRecoveredFromError === true).length
    );
    const stateResources: Record<string, ResourceState> = { ...baseState.resources };
    // Resources THIS command's replays leave in AWS under
    // `DeletionPolicy: Retain` (issue #2934). Declared beside
    // `stateResources` and NOT inside `saveState`, because both replay call
    // sites push into it and `saveState` runs repeatedly as they proceed —
    // it is read inside the state literal rather than captured, so each save
    // persists the set as it stands at that moment.
    const mintedOrphans: StackOrphanRecord[] = [];
    // go-to-k/cdkd#5064: the CREATEs the replay took back, read by every save as
    // it stands (as `mintedOrphans`), so each retires its generation.
    const rolledBackCreates: RolledBackCreate[] = [];
    // go-to-k/cdkd#5064: the new resources a renamed reversal's deferred
    // delete has yet to remove, kept in every save meanwhile.
    const supersededHost: { supersededResources?: SupersededResourceRecord[] } = {};
    const orphanLogicalIds = new Set(options.orphan ?? []);

    // Informational role-arn note (issue #1183): the newest segment recorded
    // a role, but --role-arn was not passed this run.
    // Absent when the journal held only orphaned nested records (issue #3754).
    const newestSegment = journal.segments[journal.segments.length - 1];
    if (newestSegment?.roleArn && !options.roleArn) {
      // `safe()`'s 255-code-point default is the WRONG cap for an ARN, and
      // this is the one site in this file holding one (issue
      // go-to-k/cdkd#3397 review). An AWS-legal role ARN reaches ~613 --
      // a 512-character path plus a 64-character name -- so the default cut
      // it at 255 and appended `[cut: N more characters withheld]` INSIDE the
      // sentence whose only job is to say which role to pass back, which is
      // verbatim the failure `ROLE_ARN_MAX_CODE_POINTS` exists to prevent.
      // Not caught by the display fence: it checks that a sanitizer was
      // CALLED, never which cap the call passed.
      // Named only when `safeRoleArn` is the identity on it, described
      // otherwise: the journal value sits beside `--role-arn`, the flag the
      // note asks the operator to pass it to (go-to-k/cdkd#4214).
      // `isIamRoleArn` too: `PLAIN_IDENT` admits a `--flag=` or `~user`
      // shape, which is not a role ARN (review of #4270).
      const roleArnIsPlain =
        isIamRoleArn(newestSegment.roleArn) &&
        safeRoleArn(newestSegment.roleArn) === newestSegment.roleArn;
      logger.info(
        (roleArnIsPlain
          ? `Note: the failed deploy ran with --role-arn ${safeRoleArn(newestSegment.roleArn)}; `
          : `Note: the failed deploy ran with --role-arn and a role ARN that is not a plain ` +
            `identifier (read it from the rollback journal); `) +
          `this rollback is running with ambient credentials (pass --role-arn to match).`
      );
    }

    // Issue #4018: each segment is replayed under the prefix flag its deploy
    // ran with, so a re-create asks AWS for the name that deploy (and its
    // in-process rollback) would. A segment an older cdkd wrote carries no
    // flag: fall back to the deploy's own resolution minus the CLI flag
    // (env, the cdk.json in the current directory, the default), resolved
    // once and only when needed, and say so BEFORE the confirmation.
    let fallbackSkipPrefix: boolean | undefined;
    const legacySkipPrefix = (): boolean =>
      (fallbackSkipPrefix ??= resolveSkipPrefix({ quiet: true }));
    const legacySegments = journal.segments.filter((s) => s.skipPrefix === undefined).length;
    if (legacySegments > 0) {
      logger.warn(
        safeMsg`${legacySegments} of ${journal.segments.length} rollback journal segment(s) ` +
          'were recorded by a cdkd that did not record the user-supplied-name prefix ' +
          'setting; replaying them with the stack-name prefix ' +
          (legacySkipPrefix() ? 'SKIPPED' : 'KEPT') +
          ' on user-supplied physical names (CDKD_PREFIX_USER_SUPPLIED_NAMES / ' +
          'context.cdkd.prefixUserSuppliedNames in ./cdk.json / the default). If the failed ' +
          'deploy ran with --prefix-user-supplied-names, re-run with ' +
          'CDKD_PREFIX_USER_SUPPLIED_NAMES=true instead.'
      );
    }
    // go-to-k/cdkd#4438: the stack's create-token ledger, so the replay's
    // re-creates send the stack's tokens and a Retain it honours rotates them.
    const createTokenLedger = ledgerForStack(setup.stateBackend, stackName, region);
    /** The async scope a segment replays in: its stack (name and lifetime) and its prefix flag. */
    const inSegmentScope = <T>(
      segment: { skipPrefix?: boolean },
      fn: () => Promise<T>
    ): Promise<T> =>
      withSkipPrefix(segment.skipPrefix ?? legacySkipPrefix(), () =>
        withStackScope(nameScopeOf(stackName, stackInstanceId, stateData?.state), () =>
          withCreateTokenLedger(createTokenLedger, fn)
        )
      );

    // 5. Plan — newest-first, one block per segment.
    logger.info(`\nRollback plan for ${stackRegionShown(stackName, region)}:`);
    if (!stackRegionIsPlain(stackName, region)) logger.info(STACK_REGION_DESCRIBED_NOTE);
    if (orphanedPending > 0) {
      logger.info(
        safeMsg`\n  Discard ${orphanedPending} record(s) of nested deploys whose parent run no longer ` +
          `has a journal to replay them (nothing else would ever replay them).`
      );
    }
    // Plan preview walks a COPY of state so it does not disturb replay.
    const planStateView: Record<string, ResourceState> = { ...stateResources };
    await printRollbackPlanSegments({
      journal,
      logger,
      options,
      inSegmentScope,
      planStateView,
      providerRegistry,
      region,
      setup,
      stackName,
      orphanLogicalIds,
    });
    logger.info('');

    if (!skipConfirmation) {
      // go-to-k/cdkd#4678: name the side effect, as destroy's prompt does.
      const ok = await confirm(
        `Roll back ${stackRegionShown(stackName, region)}` +
          (options.removeProtection === true
            ? ', TURNING DELETION PROTECTION OFF on the resources it deletes from this stack and the nested stacks it reverts?'
            : '?')
      );
      if (!ok) {
        logger.info('Rollback cancelled');
        return;
      }
    }

    // Issue #3754: the orphaned nested records go now — after the
    // confirmation, before the first pop, so the positional pops below act on
    // the journal the plan showed.
    if (orphanedPending > 0) {
      const discarded = await setup.stateBackend.dropRollbackJournalSegments(
        stackName,
        region,
        (s) => s.reason === NESTED_PENDING_PARENT_REASON
      );
      logger.info(
        safeMsg`Discarded ${discarded} record(s) of nested deploys whose parent run no longer has a ` +
          `journal to replay them.`
      );
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
      // go-to-k/cdkd#3869: masked by the printing bags bound where the event
      // is recorded (a failed-op replay's), as its log lines are.
      recordEvent: (e) => eventRecorder.record(maskEventTextWithBoundBags(e)),
      finalSnapshotClients,
      skipFinalSnapshot: options.skipFinalSnapshot === true,
      // go-to-k/cdkd#4678: only on an explicit flag.
      ...(options.removeProtection === true && { removeProtection: true }),
      // go-to-k/cdkd#4696: a journaled orphan another stack's record holds
      // now is not deleted, nor stripped of protection. Lazy: read only
      // when such an orphan reaches its delete.
      foreignHolder: makeForeignHolderScan(setup.stateBackend)({ stackName, region }),
      // Issue #2057: the producer regions this stack read across. A replayed
      // `{{resolve:...}}` expression that a cross-region read put in this
      // record carries no region of its own, so without this the replay
      // re-resolves it HERE and writes a same-named foreign secret to a live
      // resource. Derived from the state this command already loaded — see
      // `producerRegionsFromState`.
      importedProducerRegions: producerRegionsFromState(baseState),
      // go-to-k/cdkd#4174: a nested child rolled back on its own has no
      // parent to hand down the regions its parent reads from, and a
      // parent-supplied value is recorded region-less, so its evidence is
      // incomplete. The key is `<parent>~<id>` (CDK bars `~` in a stack
      // name), whatever the record's own `parentStack` says.
      ...((stackName.includes('~') || baseState.parentStack !== undefined) && {
        producerRegionsIncomplete: true,
      }),
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
      // Once a save declined a divergent rewrite, no later op's save may land
      // on that record either. Not left to the stale ETag alone: an explicit
      // skip does not depend on the backend refusing the conditional write.
      if (declinedDivergentRewrite) return;
      // `skippedOutputs` (issue #2740) is dropped rather than spread through,
      // as `cdkd import`, `cdkd drift --accept` and the orphan rewrite drop
      // it. Like `import`, this writer can ADD an attribute key: the
      // replacement / re-adopt arm rebuilds a record with
      // `attributes: createResult.attributes ?? {}`
      // (`rollback-executor/replay-reverse-replacement.ts`), the two UPDATE
      // arms take the attributes `update()` returned
      // (`recordAfterRollbackUpdate`, go-to-k/cdkd#4434), and either can
      // return a fuller set than the record the old state held — the same "a provider now builds
      // an attribute an output reads" shape the module doc lists as a blind
      // spot. Every resource then reports NO_CHANGE against the reverted
      // template, so the diff's change map cannot un-bind and the digest is
      // unmoved; carried, the record would preview a key as absent while the
      // next deploy publishes it.
      const { skippedOutputs: _droppedByRollback, ...carriedState } = baseState;
      const next = (): StackState => ({
        ...carriedState,
        ...stackInstanceIdCarriedFrom(baseState),
        ...supersededAfterRollback(baseState, supersededHost),
        version: STATE_SCHEMA_VERSION_CURRENT,
        region,
        resources: { ...stateResources },
        ...orphansAfterRollback(baseState, mintedOrphans),
        // go-to-k/cdkd#5064: what the rollback left in AWS is not taken back.
        ...retiredAfterRollback(baseState, mintedOrphans, rolledBackCreates),
        lastModified: Date.now(),
      });
      try {
        currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
          ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
        });
      } catch {
        try {
          const fresh = await setup.stateBackend.getState(stackName, region);
          // The record was rewritten under this run (the first save's
          // conditional write lost), and the rewrite carries a body region
          // that is not the key's (go-to-k/cdkd#3370). Saving `next()` over
          // it would stamp the KEY's region in — deciding the very question
          // the start-of-run refusal declines to decide. Leave it: the flag
          // keeps the journal segment and the record and exits partial once
          // this segment's replay returns; the throw lands in the warn below.
          if (fresh?.divergentBodyRegion !== undefined) {
            declinedDivergentRewrite = true;
            declinedDivergentReason = divergedDuringRollbackMessage(fresh.divergentBodyRegion);
            throw new Error(declinedDivergentReason);
          }
          currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
            ...(fresh?.etag !== undefined && { expectedEtag: fresh.etag }),
          });
        } catch (retryError) {
          // The decline gets its own text: the generic "re-run to reconcile"
          // below would send the operator straight into the start-of-run
          // refusal, which holds until the record's region field is repaired.
          if (declinedDivergentRewrite) {
            logger.warn(
              `Did not persist state after a rollback operation: ${declinedDivergentReason}. ` +
                `The resource was reverted in AWS. Repair the record's region field to match ` +
                `the key it is stored under, then run the rollback again to reconcile state.`
            );
            return;
          }
          logger.warn(
            `Failed to persist state after a rollback operation: ${backendErrorText(retryError, stackName, region)}. ` +
              `The resource was reverted in AWS; re-run the rollback to reconcile state.` +
              // `displayIdent` (what `safeStack` applies) bounds a JSON string,
              // not a shell word, so the name went on a trailing labelled line
              // behind the shared gate instead (go-to-k/cdkd#3436).
              rerunRollback(stackName)
          );
        }
      }
    };

    // 8. Replay segments strictly newest-first; pop each after a clean run.
    const oldestInitialDeploy = journal.segments[0]?.initialDeploy === true;
    let totalFailures = 0;
    let totalWarnings = 0;
    // go-to-k/cdkd#4633: proven orphans whose delete failed, for the
    // `--drop-failed` pointer on the exit below.
    const failedOrphanIds: string[] = [];
    // go-to-k/cdkd#4225: ONE record of completed writes across every replay
    // below, all over `stateResources`, so a revert keeps an inline policy
    // name an earlier replay (a failed op, an earlier segment) put back.
    const inlinePolicyWriters = new RollbackInlinePolicyWriters();
    // go-to-k/cdkd#3869: ONE printing bag over every segment's failed ops,
    // as `cdkd destroy`'s batch is, judged before any replay changes
    // `stateResources`: an orphan in one segment can name a resource an
    // entry of another segment holds. A failed op left as-is only over-masks.
    const failedOpsPrinting = journaledOrphanPrintingBag(
      journal.segments.flatMap((s) => s.failedOperations ?? []),
      stateResources
    );
    try {
      while (journal.segments.length > 0) {
        if (interrupted) break;
        const segment = journal.segments[journal.segments.length - 1]!;
        // go-to-k/cdkd#4523: the plan above listed these as left alone; the
        // replay below never sees them. A DISPLACED op (another resource the
        // import replaced under the id) is a warning: nothing reverts it.
        const completedSplit = splitImportedOps(segment.operations, segment, orphanLogicalIds);
        const completedOps = completedSplit.replay;
        // go-to-k/cdkd#6120: one cleanup queue for the segment's two replays.
        const cleanup = segmentCleanupOptions(completedOps.length > 0, supersededHost, baseState);
        // A displaced FAILED op counts whether or not `--revert-failed` is
        // passed: the plan lists it either way, and nothing ever reverts it,
        // so a run that then pops the segment must still say so (exit 2).
        const displaced = [
          ...completedSplit.displaced,
          ...splitImportedOps(segment.failedOperations ?? [], segment).displaced,
        ];
        for (const op of displaced) logger.warn(displacedOpLabel(op, segment).trim());
        recordDisplacedSkips(ctx.recordEvent, stackName, displaced);
        // Issue #3754: what the nested-stack rows' child replays reported
        // (completed rows, skipped ops), read once the segment has replayed.
        let nestedRun: NestedRevertRun | undefined;
        const result = await withNestedStackContext(
          {
            stateBackend: setup.stateBackend,
            lockManager: setup.lockManager,
            providerRegistry,
            parentStackName: stackName,
            parentRegion: region,
            accountId: 'unknown',
            // The stack's clients, as deploy passes (go-to-k/cdkd#4932): a
            // nested child's destroy takes its final snapshots through
            // them, and the CLI-region set would read a wrong-region
            // NotFound as "source gone" and delete with no snapshot.
            awsClients: finalSnapshotClients,
            stateBucket: setup.bucket,
            exportIndexStore: setup.exportIndexStore,
            destroyOptions: {
              ...(options.profile && { profile: options.profile }),
              statePrefix: options.statePrefix,
              // A nested child's revert (issue #3754) replays its own
              // journal through this context, so the opt-out must reach it.
              ...(options.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
              // go-to-k/cdkd#4703: and `--remove-protection`, only when
              // passed; the child replay pairs it with a child-scoped
              // foreign-holder scan.
              ...(options.removeProtection === true && { removeProtection: true }),
            },
          },
          // Issue #3754: a nested-stack row in this segment is reverted by
          // replaying its child's journal segments for the SAME run.
          () =>
            withNestedRevertRun(segment.runId, (run) => {
              nestedRun = run;
              return inSegmentScope(segment, async () => {
                // #1198: revert the segment's FAILED in-flight op(s) first
                // (opt-in). Their revert is independent of the completed-op
                // replay (one op per resource per deploy), so a failed-op
                // revert failure still lets the completed ops replay — the
                // summed failure count keeps the segment from popping.
                let failedOpFailures = 0;
                let failedOpWarnings = 0;
                // go-to-k/cdkd#4523: an imported id's failed op is left alone
                // too, and stays in the journal (below).
                const failedOps = splitImportedOps(segment.failedOperations ?? [], segment);
                // go-to-k/cdkd#4690: the delete-first guard reads the segment's
                // failed ops as they stood BEFORE the replay below strips them.
                const failedForGuard = segment.failedOperations ?? [];
                // go-to-k/cdkd#4584: a plain rollback replays the proven
                // orphans alone; the rest are kept by the strip below while
                // the segment stays, and leave with it once it pops.
                const failedToReplay = failedOpsToReplay(
                  failedOps.replay,
                  options.revertFailed === true
                );
                if (failedToReplay.length > 0) {
                  // go-to-k/cdkd#3869: the failed ops replay under a PRINTING
                  // bag judged from their journal entries, as `cdkd
                  // destroy`'s orphans do: a provider's delete lines and the
                  // events mask a name derived from a secret, and one an
                  // orphan READ from a record.
                  // Nested inside the batch bag: this segment's ops judged
                  // against the state as it stands NOW, so a name a newer
                  // segment's completed-op revert restored is caught too.
                  const failedResult = await withPrintingSecrets(failedOpsPrinting, () =>
                    withPrintingSecrets(
                      journaledOrphanPrintingBag(failedToReplay, stateResources),
                      () =>
                        replayFailedOperations(failedToReplay, stateResources, stackName, ctx, {
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
                          // The REPLAYED list, not `segment.operations`: an
                          // all-imported segment hands replayRollback nothing,
                          // and it then emits no envelope (cosmetic ordering
                          // only, unpinned on purpose).
                          emitEnvelope: completedOps.length === 0,
                          ...cleanup,
                          // Same reason as the sibling replay below: `afterOp`
                          // saves per op, so a record appended only after this
                          // returns is absent from every intermediate save
                          // (issue #2934).
                          onOrphan: (record) => mintedOrphans.push(record),
                          onRolledBackCreate: (create) => rolledBackCreates.push(create),
                          inlinePolicyWriters,
                        })
                    )
                  );
                  failedOpFailures = failedResult.failures;
                  failedOpWarnings = failedResult.warnings;
                  // Read only on the failures exit, never the interrupt one,
                  // so an op an interrupt left unreached is never named.
                  for (const op of failedResult.remainingFailedOps) {
                    if (isJournaledOrphan(op) && op.physicalIdRecoveredFromError === true) {
                      failedOrphanIds.push(op.logicalId);
                    }
                  }

                  // Idempotency: persist ONLY the still-pending failed ops
                  // (per-op strip). A handled op must never be re-issued on a
                  // re-run — replaying `attemptedProperties` as the previous
                  // diff side against an already-reverted resource would
                  // generate a patch undoing changes that no longer exist
                  // (fails on patch-based providers). Runs on the interrupt /
                  // failure paths too so partial progress is never lost.
                  // Best-effort: on a strip failure the re-run merely
                  // re-attempts the revert.
                  const remaining = [
                    ...failedOps.imported,
                    ...failedOps.displaced,
                    ...failedOps.replay.filter((op) => !failedToReplay.includes(op)),
                    ...failedResult.remainingFailedOps,
                    // go-to-k/cdkd#4690: a handled delete-first replacement
                    // stays while this segment's completed ops remain, so a
                    // re-run's delete-first guard still sees the resource it
                    // removed; it leaves with the segment once it pops. On a
                    // `--revert-failed` re-run, the `replacementOrphaned` shape
                    // re-classifies as the same skip and repeats its warning;
                    // the bare shape (no orphan) re-attempts its forced revert
                    // against the deleted old id, which normally fails
                    // not-found and keeps it pending.
                    ...(completedOps.length > 0
                      ? failedToReplay.filter(
                          (op) =>
                            seedsDeleteFirstGuard(op) &&
                            !failedResult.remainingFailedOps.includes(op)
                        )
                      : []),
                  ];
                  // NOT after a declined divergent rewrite (go-to-k/cdkd#3370):
                  // the handled ops' state rows were never saved, so stripping
                  // them would leave the record describing work the journal no
                  // longer carries. Kept, the re-run after the region repair
                  // replays them against the unsaved rows and reconciles (a
                  // failed-CREATE delete reads not-found as done).
                  if (
                    !declinedDivergentRewrite &&
                    remaining.length !== (segment.failedOperations ?? []).length
                  ) {
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
                        safeMsg`Failed to strip replayed failed-ops from the journal: ${backendErrorText(stripError, stackName, region)}`
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
                // go-to-k/cdkd#3869: the completed ops revert under a PRINTING
                // bag judged from their journal entries and the records they
                // replaced, against the state as it stands now: a provider's
                // delete of a resource the failed deploy created, named from
                // a secret, prints its name otherwise.
                const replayResult = await withPrintingSecrets(
                  journaledOrphanPrintingBag(completedReplayEntries(completedOps), stateResources),
                  () =>
                    replayRollback(completedOps, stateResources, stackName, ctx, {
                      orphanLogicalIds,
                      afterOp: saveState,
                      isInterrupted: () => interrupted,
                      // Pushed from INSIDE the replay, not after it returns: the
                      // `afterOp` above saves per op, so a record appended only
                      // on return would be missing from every intermediate save
                      // — and a crash there loses it for good (issue #2934).
                      onOrphan: (record) => mintedOrphans.push(record),
                      onRolledBackCreate: (create) => rolledBackCreates.push(create),
                      inlinePolicyWriters,
                      failedOperations: failedForGuard,
                      ...cleanup,
                    })
                );
                return {
                  failures: replayResult.failures + failedOpFailures,
                  warnings: replayResult.warnings + failedOpWarnings,
                  interrupted: replayResult.interrupted,
                };
              });
            })
        );
        totalFailures += result.failures;
        // A nested row whose child replay skipped ops reports `partial`,
        // which the executor counts as restored; count the skips here.
        totalWarnings += result.warnings + (nestedRun?.warnings ?? 0) + displaced.length;
        // Before the pop, and before the interrupt check so a Ctrl-C landing
        // in the same segment does not relabel this stop.
        if (declinedDivergentRewrite) break;
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
        // The nested children whose replay this segment COMPLETED are
        // settled with it (issue #3754): drop their pending segments for the
        // same run. Best-effort, and after the pop so a failed pop re-runs the
        // rows against segments that are still there.
        await dropSettledNestedJournals({
          stateBackend: setup.stateBackend,
          lockManager: setup.lockManager,
          parentStackName: stackName,
          region,
          settled: nestedRun?.settled ?? new Map(),
          runId: segment.runId,
          logger,
        });
      }
    } finally {
      await eventRecorder.finalize(
        totalFailures > 0 || interrupted || declinedDivergentRewrite ? 'FAILED' : 'SUCCEEDED'
      );
    }

    // 9. Terminal state: an initial-deploy rollback that emptied state
    // deletes state.json so `cdkd list` shows no ghost stack.
    //
    // ...UNLESS this rollback left something in AWS (issue #2934). A
    // `DeletionPolicy: Retain` resource survives the rollback, and the record
    // of it is the ONLY thing that lets the next deploy re-adopt it rather
    // than collide with the deterministic name it still holds. Deleting
    // state.json here would take that record with it — in exactly the
    // first-deploy-fails flow the record exists for, since that flow is
    // precisely where `resources` ends up empty.
    //
    // A stack with records is not a ghost: cdkd has left something in the
    // account and can still say what. The automatic rollback never deletes
    // state at all, so this also removes a disagreement between the two
    // paths — though only in the orphan case; with no records this command
    // still deletes and the automatic one still does not.
    const survivingOrphans = orphansAfterRollback(baseState, mintedOrphans).orphans ?? [];
    if (
      journal.segments.length === 0 &&
      oldestInitialDeploy &&
      Object.keys(stateResources).length === 0 &&
      survivingOrphans.length === 0 &&
      // go-to-k/cdkd#5111: an old resource still to delete keeps it.
      !holdsSupersededResources(baseState)
    ) {
      await setup.stateBackend.deleteState(stackName, region);
      // go-to-k/cdkd#4705: the record is gone, so the empty retained.json
      // (the tombstone that ends an older cdkd's history license) and then
      // the registry marker follow it -- record, tombstone, marker, as on
      // every other path that removes a record. Both non-fatal.
      await recordRetainedForReadoption(setup.stateBackend, stackName, region, [], logger);
      await releaseRegistryMarkerQuietly(setup.stateBackend, stackName, region, logger);
      logger.info(
        `State for ${stackRegionShown(stackName, region)} removed (stack fully rolled back).`
      );
    }

    // 10. Exit codes.
    if (declinedDivergentRewrite) {
      throw new PartialFailureError(
        `Rollback stopped: ${declinedDivergentReason}.` +
          (totalFailures > 0 ? ` ${totalFailures} operation(s) also failed.` : '') +
          ` Journal preserved (this segment, any older ones, and their failed operations) — ` +
          `re-run the rollback once the record's region field matches its key.`
      );
    }
    if (interrupted) {
      throw new PartialFailureError(
        `Rollback interrupted. Journal preserved — re-run the rollback to finish.` +
          rerunRollback(stackName)
      );
    }
    if (totalFailures > 0) {
      throw new PartialFailureError(
        `Rollback completed with ${totalFailures} failed operation(s). Journal preserved — ` +
          `re-run the rollback to retry.` +
          dropFailedHint(stackName, region, failedOrphanIds) +
          rerunRollback(stackName)
      );
    }
    if (totalWarnings > 0) {
      throw new PartialFailureError(
        `Rollback completed with ${totalWarnings} skipped/unrecoverable operation(s) (see warnings above).`
      );
    }
    logger.info(`\nRollback of ${stackRegionShown(stackName, region)} complete.`);
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
          `Failed to release lock for ${quotedOrDescribed(stackName, 'stack name')} (${plainOrDescribed(region, 'region')}): ${backendErrorText(err, stackName, region)}`
        );
      });
    } finally {
      process.removeListener('SIGINT', sigintHandler);
      unforwardSigterm();
    }
  }
}
