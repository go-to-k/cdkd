import { type DeployEngine, crossStackReadsForPartialSave } from '../deploy-engine.js';
import { explicitNamePropertyFor, getCurrentSkipPrefix } from '../../provisioning/resource-name.js';
import { getCdkdVersion } from '../../state/deployment-events-store.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { RollbackJournalSegment } from '../../types/rollback-journal.js';
import type { ResourceState, StackOrphanRecord, StackState } from '../../types/state.js';
import { displayIdent, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { pasteableCommand, quotedOrDescribed } from '../../utils/pasteable-command.js';
import { recoveryCommandFlags } from '../../state/lock-contention-message.js';
import {
  NESTED_PENDING_PARENT_REASON,
  type SettledNestedRows,
  dropNestedChildJournals,
  dropSettledNestedJournals,
  nestedPendingSnapshot,
  withNestedRevertRun,
} from '../nested-child-journal.js';
import {
  type OrphanAdoptionOutcome,
  makeSiblingClaimReader,
  planOrphanAdoption,
} from '../orphan-adoption.js';
import { type ProducerRegionEvidence, inheritProducerRegions } from '../producer-regions-scope.js';
import {
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
  demoteSupersededOrphans,
  isJournaledOrphan,
  replacementNeverSwapped,
  producerRegionsFromState,
  replayFailedOperations,
  replayRollback,
} from '../rollback-executor.js';
import { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import {
  completedReplayEntries,
  maskEventTextWithBoundBags,
  orphanRecordsPrintingBag,
  secretNameNeedlesOf,
  secretNamesReadBy,
} from '../secret-name-needles.js';
import {
  type ForeignHolding,
  makeForeignHolderScan,
  settleJournaledOrphansOnSuccess,
} from '../rollback-executor/journaled-orphans.js';
import { hasReadableOrphans } from '../../state/malformed-resources-bag.js';
import {
  type RecordedSecretValues,
  STATE_SOURCED_READBACK_RULES,
  markSameGenerationBag,
  maskSecretsInText,
  recordLogOnlyValue,
  redactSecretsForState,
  scrubResourceRecord,
  maskAtCoordinates,
  noEchoCoordinatesOf,
  unionOfSecretBags,
} from '../secret-redaction.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    adoptRollbackOrphans: OmitThisParameter<typeof adoptRollbackOrphans>;
    /** @internal */
    performRollback: OmitThisParameter<typeof performRollback>;
    /** @internal */
    settleJournalAfterSuccess: OmitThisParameter<typeof settleJournalAfterSuccess>;
    /** @internal */
    deleteRollbackJournalBestEffort: OmitThisParameter<typeof deleteRollbackJournalBestEffort>;
    /** @internal */
    settleJournalAfterCleanRollback: OmitThisParameter<typeof settleJournalAfterCleanRollback>;
    /** @internal */
    settleNestedChildrenAfterCleanRollback: OmitThisParameter<
      typeof settleNestedChildrenAfterCleanRollback
    >;
    /** @internal */
    recoveryHint: OmitThisParameter<typeof recoveryHint>;
    /** @internal */
    rollbackExecutorContext: OmitThisParameter<typeof rollbackExecutorContext>;
    /** @internal */
    producerRegionEvidence: OmitThisParameter<typeof producerRegionEvidence>;
    /** @internal */
    writeRollbackJournalSegment: OmitThisParameter<typeof writeRollbackJournalSegment>;
    /** @internal */
    redactOperationsForJournal: OmitThisParameter<typeof redactOperationsForJournal>;
  }
}

export function redactOperationsForJournal<T extends CompletedOperation | FailedOperation>(
  this: DeployEngine,
  operations: T[]
): T[] {
  return operations.map((op) => {
    const secrets = this.perResourceSecrets.get(op.logicalId);
    const templateProps = this.perResourceTemplateProps.get(op.logicalId);
    // `previousState` is redactable with NO secrets map at all (#1900), so the
    // early return has to let that case through or the whole state-sourced
    // half is dead code.
    // go-to-k/cdkd#4043 (review B3): the positional `NoEcho` arm needs no
    // secrets, so a bag positioned by this deploy's template is masked even
    // when the resource recorded none.
    const sources = templateProps === undefined ? undefined : this.noEchoPositionSources();
    const byPosition = <B>(bag: B): B =>
      sources === undefined || templateProps === undefined
        ? bag
        : maskAtCoordinates(bag, noEchoCoordinatesOf(templateProps, bag, sources));
    if ((!secrets || secrets.size === 0) && !op.previousState && sources === undefined) return op;
    const ownSecrets = secrets ?? new Map<string, string>();
    const next = { ...op } as CompletedOperation & FailedOperation;
    if (next.properties) {
      next.properties = byPosition(
        redactSecretsForState(next.properties, ownSecrets, templateProps)
      );
    }
    if (next.attemptedProperties) {
      // Issue #2516: a FAILED op's attempted bag is the resolver's own
      // output of today's template — the provider threw, so
      // `propertiesToRecord` never marked it — and this journal is a
      // persisted S3 artifact of its own. Marked as a COPY, the no-change
      // re-check's pattern. Nothing reads the original after this journal
      // is written (a `--revert-failed` replay re-resolves the journaled
      // bag into a new object), so the copy guards a future reader rather
      // than a present one — stated so the choice is not mistaken for a
      // pinned behaviour.
      next.attemptedProperties = byPosition(
        redactSecretsForState(
          markSameGenerationBag({ ...next.attemptedProperties }),
          ownSecrets,
          templateProps
        )
      );
    }
    if (next.previousState) {
      // No `sourceProperties`: the previous record positions itself.
      //
      // `STATE_SOURCED_READBACK_RULES` is passed EXPLICITLY (issue #2886):
      // left to `scrubResourceRecord`'s derivation, an op whose resource
      // resolved nothing this deploy — a DELETE, an UPDATE with no reference
      // of its own — arrives here with an EMPTY map (the guard above admits
      // it whenever `previousState` exists) and would take the FAIL-CLOSED
      // baseline constant, masking every position the walk cannot certify in
      // this journal snapshot. `replayRollback` restores that record, so the
      // masks would land in `state.json` as permanent phantom drift on a
      // baseline that was intact before the deploy. The journal is a
      // REPLAYED baseline, not a fresh readback: its bag already sits in
      // `state.json`, so a mask here protects nothing a reader could still
      // be protected from and poisons the record a rollback rebuilds.
      const previous = next.previousState;
      // The `NoEcho` arms over the PREVIOUS record (review B3): its own
      // `noEchoLeaves` when it has them, else today's template positions for
      // the same logical id and type, so a pre-v11 record's plaintext does not
      // reach this journal on a failed migration deploy.
      next.previousState = this.applyNoEchoPersist(
        op.logicalId,
        previous,
        scrubResourceRecord(previous, ownSecrets, undefined, STATE_SOURCED_READBACK_RULES),
        undefined,
        {},
        undefined,
        true
      );
    }
    return next as unknown as T;
  });
}

/**
 * Re-adopt what a previous rollback left in AWS, before the diff runs
 * (issue #2934).
 *
 * MUTATES `currentState`: adopted records go into `resources` so the diff
 * sees them, and `orphans` is replaced by the surviving set so every save
 * on every path below persists the same object. Mutation rather than a
 * returned copy because `currentState` is read by ~a dozen later sites and
 * threading a second binding through all of them is how one gets missed.
 *
 * Refusals THROW. A record whose name this deploy is about to request, that
 * cdkd cannot vouch for, is exactly the go-to-k/cdkd#2916 situation: letting
 * the deploy run would collide and roll back anyway, adding another orphan
 * on the way.
 */
export async function adoptRollbackOrphans(
  this: DeployEngine,
  currentState: StackState,
  effectiveTemplate: CloudFormationTemplate
): Promise<OrphanAdoptionOutcome> {
  const records = currentState.orphans ?? [];
  // go-to-k/cdkd#3869: the planner's own lines (a vanished record's debug
  // line, a provider `import()`'s existence check) print a kept record's id
  // before provisioning binds any printing bag, so they run under one judged
  // from every record, as the notices and the refusal below are masked.
  const named = orphanRecordsPrintingBag(records);
  const plan = await withPrintingSecrets(named, () =>
    planOrphanAdoption({
      records,
      // Read BEFORE the splice below, so a record whose resource this same
      // pass adopts is not also read as "already managed".
      managedLogicalIds: new Set(Object.keys(currentState.resources)),
      template: effectiveTemplate,
      stackName: currentState.stackName,
      region: this.stackRegion,
      getProvider: (type, provisionedBy) =>
        this.providerRegistry.getProviderFor({
          resourceType: type,
          ...(provisionedBy !== undefined && { provisionedBy }),
        }).provider,
      nameProperties: (type) => {
        const property = explicitNamePropertyFor(type);
        return property === undefined ? [] : [property];
      },
      readSiblingClaims: makeSiblingClaimReader({
        stateBackend: this.stateBackend,
        selfStackName: currentState.stackName,
        selfRegion: this.stackRegion,
        logger: this.logger,
      }),
      logger: { debug: (m) => this.logger.debug(m) },
    })
  );

  // `notices` and `refusals` arrive already rendered through `displaySafe` /
  // `displayIdent`: `planOrphanAdoption` sanitizes each state-chosen field
  // where it builds the string, because `cdkd diff` consumes the same lines
  // (go-to-k/cdkd#3642). Only the `Adopting` line below is built HERE, so it
  // is the one this method sanitizes.
  // go-to-k/cdkd#3869: the same bag masks these lines, a record named from a
  // secret (its name still a `{{resolve:` reference) by its id spellings. One
  // log-only bag over every record: a line names one record, and a sibling's
  // needle only over-masks. The thrown refusal too: it names the id and
  // carries no command, and the logical id beside it is what the user acts on.
  for (const notice of plan.notices) this.logger.info(maskSecretsInText(notice, named));

  if (plan.refusals.length > 0) {
    throw new Error(
      `Deploy refused — cdkd left ${plan.refusals.length} resource(s) in AWS that it cannot ` +
        `safely re-adopt:\n  ${plan.refusals.map((r) => maskSecretsInText(r, named)).join('\n  ')}`
    );
  }

  for (const [logicalId, record] of Object.entries(plan.adopted)) {
    currentState.resources[logicalId] = record;
    this.logger.info(
      `Adopting ${displayIdent(logicalId)} (${displayIdent(record.resourceType)}) left in AWS ` +
        `by an earlier rollback as ${displaySafe(maskSecretsInText(record.physicalId, named))}`
    );
  }
  // Assigned unconditionally when there WERE records, so an adopted or
  // vanished one actually leaves the set. Left untouched when there were
  // none, so a stack that never orphaned keeps a byte-identical state.json.
  if (records.length > 0) currentState.orphans = plan.remaining;

  return plan;
}

/**
 * The PRINTING bag the automatic rollback replays its journaled orphans and
 * its completed ops under (go-to-k/cdkd#3869), one per replay; each entry is
 * an op's record (and, for a completed op, the record it replaced). Unlike
 * `cdkd rollback`'s, the ops and records here are
 * IN MEMORY, so a name this deploy resolved is plaintext and no `{{resolve:`
 * spelling marks it: the judge is the engine's own, which also sees a record
 * still spelling a reference (one loaded from state). The union of:
 *  - each entry's printing bag (`printingSecretsFor`): its resolved secrets
 *    and the derived-name registry `create.ts` filled right after resolving;
 *  - each entry's own record judged with its id;
 *  - the names each entry READ from a record, judged with that record's own
 *    resolution (`namingSecretsFor`), as `noteSecretNamedReads` judges them.
 * Log-only: bound with `withPrintingSecrets`, read by nothing that decides.
 */
function replayPrintingBag(
  engine: DeployEngine,
  entries: readonly {
    logicalId: string;
    resourceType: string;
    physicalId?: string | undefined;
    properties?: Record<string, unknown> | undefined;
  }[],
  stateResources: Record<string, ResourceState>
): RecordedSecretValues {
  const read: RecordedSecretValues = new Map();
  for (const entry of entries) {
    const names = secretNamesReadBy(
      entry.logicalId,
      { properties: entry.properties },
      stateResources,
      (otherId) => ({
        secrets: engine.namingSecretsFor(otherId),
        embedded: engine.perResourceSecrets.get(otherId),
      })
    );
    for (const needle of names) recordLogOnlyValue(read, needle);
  }
  // Each entry's own record WITH its id: the registry entry `create.ts` made
  // had no id yet, so its id-needing arms (an IAM `Path`'s whole id, a needle
  // embedded in the id) never fired.
  const own: RecordedSecretValues = new Map();
  for (const entry of entries) {
    const needles = secretNameNeedlesOf(
      entry.logicalId,
      {
        resourceType: entry.resourceType,
        physicalId: entry.physicalId,
        properties: entry.properties,
      },
      engine.namingSecretsFor(entry.logicalId),
      { embedded: engine.perResourceSecrets.get(entry.logicalId) }
    );
    for (const needle of needles ?? []) recordLogOnlyValue(own, needle);
  }
  return unionOfSecretBags([
    ...entries.map((entry) => engine.printingSecretsFor(entry.logicalId)),
    own,
    read,
  ]);
}

/**
 * Perform best-effort rollback of completed operations (issue #1183:
 * extracted into `rollback-executor.ts` so the standalone `cdkd rollback`
 * command drives identical semantics). Thin wrapper that builds the
 * executor context from the engine's collaborators and delegates.
 */
export async function performRollback(
  this: DeployEngine,
  completedOperations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  /**
   * The PRE-deploy state record, threaded in for issue #2057's
   * `importedProducerRegions`. Taken as a parameter rather than read off a
   * field because `currentState` is a local of `executeDeployment`, whose
   * automatic-rollback arm is this method's only caller.
   */
  previousState: StackState,
  /**
   * The attempt's failed operations. Only its journaled proven
   * failed-CREATE orphans are replayed (go-to-k/cdkd#4584): the rest stay
   * opt-in through `cdkd rollback --revert-failed`.
   */
  failedOperations: readonly FailedOperation[] = [],
  /**
   * The pre-deploy rollback-orphan records, read by the caller below the
   * deploy flow's orphans guard: one holding an orphan's id may own it.
   */
  priorOrphans: readonly StackOrphanRecord[] = []
): Promise<{
  failures: number;
  warnings: number;
  /**
   * go-to-k/cdkd#3338: the ops THIS replay declined and left unreverted. The
   * caller keeps the journal segment when non-zero. A nested child's skips
   * are not counted here: they already keep the child's own segments (its
   * row is not settled).
   */
  skipped: number;
  orphaned: StackOrphanRecord[];
  /**
   * Issue #3754: the nested-stack rows whose child replay COMPLETED (no
   * failure, no skip), with the grandchildren each completed. A row the
   * replay skipped never reached the provider, so it is not among them.
   */
  settledNested: SettledNestedRows;
  /**
   * The failed operations a later `cdkd rollback --revert-failed` still
   * needs: every one but the proven orphans this rollback handled
   * (go-to-k/cdkd#4584). The clean-rollback settle records these.
   */
  remainingFailedOps: FailedOperation[];
}> {
  // go-to-k/cdkd#4584: CloudFormation parity — a CREATE whose provider proved
  // it made the resource before failing is deleted by the rollback, per its
  // journaled DeletionPolicy, exactly as `--revert-failed` would. Replayed on
  // COPIES: the supersede pass below rewrites the flag, and the originals are
  // what the journal records. Only this attempt's segment can supersede its
  // own orphans (no newer one exists), so the pass reads the pre-deploy
  // rollback-orphan records alone (`priorOrphans`).
  const orphanIndexes: number[] = [];
  const orphanOps: FailedOperation[] = [];
  // go-to-k/cdkd#4604: with them, the failed UPDATE of a replacement whose
  // orphan is among them. It settles as a no-op (the old resource was never
  // written to), and it must not outlive its orphan's entry in the journal:
  // without it, a later `--revert-failed` would force-revert the old resource.
  failedOperations.forEach((op, i) => {
    if (
      !isJournaledOrphan(op) &&
      !(op.changeType === 'UPDATE' && replacementNeverSwapped(op, failedOperations))
    ) {
      return;
    }
    orphanIndexes.push(i);
    orphanOps.push({ ...op });
  });
  demoteSupersededOrphans(
    [{ operations: completedOperations, failedOperations: orphanOps }],
    priorOrphans
  );
  // go-to-k/cdkd#4705: a create may have been handed a resource that existed
  // under its generated name, which only the SAME stack name deployed under
  // another state prefix shares. So each delete asks the cross-prefix holder
  // alone (memoized, run only when something is to be deleted). Not the
  // same-prefix scan the settle runs: another stack there has other generated
  // names, and that scan fails closed on any unreadable record, which would
  // turn every rollback in the prefix into keep-everything.
  const crossPrefixHolder = this.options.crossPrefixHolder;
  let crossPrefixAnswer: Promise<ForeignHolding> | undefined;
  const ctx = {
    ...this.rollbackExecutorContext(previousState, stackName),
    // A `cdkd rollback` replays the journal the keep leaves, from the
    // top-level stack (a nested child's journal included).
    createdResourceRetryCommand: pasteableCommand(
      'cdkd rollback',
      [
        {
          value: (this.options.parentStackInfo?.parentStack ?? stackName).split('~')[0]!,
          hole: 'stack',
        },
      ],
      recoveryCommandFlags(this.options.refusalRecovery).flags
    ).command,
    createdResourceHolder:
      crossPrefixHolder === undefined
        ? undefined
        : (): Promise<ForeignHolding> => (crossPrefixAnswer ??= crossPrefixHolder(stackName)),
  };
  // go-to-k/cdkd#4225: one record of completed writes across both replays.
  const inlinePolicyWriters = new RollbackInlinePolicyWriters();
  // Issue #3754: a nested-stack row reverted here replays its child's
  // journal segments for THIS run, which `NestedStackProvider` reads from
  // the scope, and reports back into it.
  const runId = this.options.eventRecorder?.runId;
  const { result, failed, run } = await withNestedRevertRun(runId, async (scope) => {
    // The failed op is the newest work of the failed deploy, so it goes first
    // — as in `cdkd rollback`: it may depend on what the completed CREATEs
    // made, never the reverse.
    const failedResult =
      orphanOps.length > 0
        ? // go-to-k/cdkd#3869: the orphans' deletes run under a PRINTING bag,
          // so a provider's delete lines mask a name derived from a secret,
          // and the context's events mask a name an orphan READ from a record.
          await withPrintingSecrets(
            replayPrintingBag(
              this,
              orphanOps.map((op) => ({ ...op, properties: op.attemptedProperties })),
              stateResources
            ),
            () =>
              replayFailedOperations(orphanOps, stateResources, stackName, ctx, {
                // `replayRollback` emits no envelope over zero ops (a failed-only
                // attempt), so this replay owns it then.
                emitEnvelope: completedOperations.length === 0,
                inlinePolicyWriters,
              })
          )
        : undefined;
    return {
      failed: failedResult,
      // go-to-k/cdkd#3869: the completed ops revert under the same kind of
      // bag, judged from each op's record and the one it replaced, so a
      // provider's delete of a CREATE this deploy made masks its name.
      result: await withPrintingSecrets(
        replayPrintingBag(this, completedReplayEntries(completedOperations), stateResources),
        () =>
          replayRollback(completedOperations, stateResources, stackName, ctx, {
            inlinePolicyWriters,
          })
      ),
      run: scope,
    };
  });
  const pendingOrphans = new Set(failed?.remainingFailedOps ?? []);
  const handled = new Set(orphanIndexes.filter((_, k) => !pendingOrphans.has(orphanOps[k]!)));

  // `orphaned` is relayed rather than persisted here: this method holds no
  // state save. Its caller merges it into the post-rollback record (issue
  // #2934), which is the ONLY save on this path — dropping it there makes a
  // live, billing AWS resource untrackable and re-opens the deploy loop the
  // record closes.
  return {
    failures: result.failures + (failed?.failures ?? 0),
    // A child replay's skips surface on its row as a `partial` outcome,
    // which the executor does not count; the scope does.
    warnings: result.warnings + run.warnings + (failed?.warnings ?? 0),
    skipped: result.skipped + (failed?.skipped ?? 0),
    orphaned: [...(failed?.orphaned ?? []), ...result.orphaned],
    settledNested: run.settled,
    remainingFailedOps: failedOperations.filter((_, i) => !handled.has(i)),
  };
}

/**
 * Who else holds a resource, for the success settle: one same-prefix scan of the bucket's other stacks
 * (`makeForeignHolderScan`, made lazily on the first question), then, only
 * when it found no holder, the bucket's OTHER state prefixes
 * (`options.crossPrefixHolder`, go-to-k/cdkd#4705), asked once per stack.
 */
function foreignHolderResolver(
  engine: DeployEngine
): (self: {
  stackName: string;
  region: string;
}) => (resourceType: string, physicalId: string) => Promise<ForeignHolding> {
  const sameBucketHolderFor = makeForeignHolderScan(engine.stateBackend);
  const crossPrefixHolder = engine.options.crossPrefixHolder;
  const crossPrefixAnswers = new Map<string, Promise<ForeignHolding>>();
  return (self) => async (resourceType, physicalId) => {
    const held = await sameBucketHolderFor(self)(resourceType, physicalId);
    if (held !== undefined || crossPrefixHolder === undefined) return held;
    let answer = crossPrefixAnswers.get(self.stackName);
    if (answer === undefined) {
      answer = crossPrefixHolder(self.stackName);
      crossPrefixAnswers.set(self.stackName, answer);
    }
    return answer;
  };
}

/**
 * The journal on a SUCCESSFUL deploy (issue #3754 split the one answer in
 * two).
 *
 * - A NESTED engine keeps its journal and appends a `nested-pending-parent`
 *   segment: its parent's deploy is still running, and if it fails, the
 *   revert of this child's row replays exactly these ops. The previous
 *   outputs ride along because the ops do not restore them. Older segments
 *   are kept too, since an older parent segment may still name them.
 * - The ROOT engine deletes its own journal (issue #1183: the baseline
 *   moved) and every descendant's, which is the same statement made for the
 *   whole tree — and it sweeps anything a crashed run left behind.
 *
 * go-to-k/cdkd#4600: a journal's proven failed-CREATE orphans are its only
 * record of a live resource, so the root first acts on each journal's
 * (`settleJournaledOrphansOnSuccess`: deleted, or skipped with a warning when
 * this deploy's outcome may own it) and keeps one whose entry could not be
 * acted on. Returns how many it left in AWS, which the caller counts as
 * unaddressed (the deploy exits 2).
 */
export async function settleJournalAfterSuccess(
  this: DeployEngine,
  stackName: string,
  completedOperations: CompletedOperation[],
  previousState: StackState,
  finalResources: Record<string, ResourceState>,
  initialDeploy: boolean
): Promise<number> {
  if (this.options.parentStackInfo) {
    await this.writeRollbackJournalSegment(
      stackName,
      completedOperations,
      [],
      NESTED_PENDING_PARENT_REASON,
      initialDeploy,
      nestedPendingSnapshot(previousState)
    );
    return 0;
  }
  let nestedLeft = 0;
  const foreignHolderFor = foreignHolderResolver(this);
  const deployRunId = this.options.eventRecorder?.runId;
  const stripOnFailure = new Map<string, () => Promise<void>>();
  const [ownLeft] = await Promise.all([
    (async (): Promise<number> => {
      // `previousState.orphans` is the surviving set `adoptRollbackOrphans`
      // left: what the saved record holds. The deploy flow guarded it before
      // either of this method's call sites.
      const own = await settleJournaledOrphansOnSuccess({
        stateBackend: this.stateBackend,
        stackName,
        region: this.stackRegion,
        stateResources: finalResources,
        rollbackOrphans: previousState.orphans,
        newerOperations: completedOperations,
        ...(deployRunId !== undefined && { deployRunId }),
        foreignHolder: foreignHolderFor({ stackName, region: this.stackRegion }),
        ctx: this.rollbackExecutorContext(previousState, stackName),
        isInterrupted: () => this.interrupted,
        logger: this.logger,
      });
      if (own.keepJournal) return own.unaddressed;
      // go-to-k/cdkd#4402: this run's completed ops supersede every older
      // failed attempt of their ids; if the delete fails they are carried
      // onto the journal instead, so no older attempt counts as evidence
      // again.
      const deleted = await this.deleteRollbackJournalBestEffort(
        stackName,
        completedOperations.map((op) => op.logicalId)
      );
      // A surviving journal must not keep what this settle cleared as proven.
      if (!deleted) await own.stripCleared?.();
      return own.unaddressed;
    })(),
    dropNestedChildJournals({
      stateBackend: this.stateBackend,
      lockManager: this.lockManager,
      parentStackName: stackName,
      region: this.stackRegion,
      resources: finalResources,
      logger: this.logger,
      beforeDelete: async (child, childRecord) => {
        // An unreadable orphans container is an unreadable record: a rollback-
        // orphan record in it may own the resource, so nothing is deleted.
        const childState =
          childRecord !== undefined && hasReadableOrphans(childRecord) ? childRecord : undefined;
        const settled = await settleJournaledOrphansOnSuccess({
          stateBackend: this.stateBackend,
          stackName: child,
          region: this.stackRegion,
          stateResources: childState?.resources,
          rollbackOrphans: childState?.orphans,
          // The child's own success appended its completed ops as a
          // `nested-pending-parent` segment of this run (`deployRunId`).
          newerOperations: [],
          ...(deployRunId !== undefined && { deployRunId }),
          foreignHolder: foreignHolderFor({ stackName: child, region: this.stackRegion }),
          isInterrupted: () => this.interrupted,
          ctx: {
            ...this.rollbackExecutorContext(childState ?? previousState, child),
            // Its parent's reads are not in the child's record (as destroy).
            producerRegionsIncomplete: true,
            nestedChildStack: child,
          },
          logger: this.logger,
        });
        nestedLeft += settled.unaddressed;
        if (settled.stripCleared) stripOnFailure.set(child, settled.stripCleared);
        return !settled.keepJournal;
      },
      onDeleteFailed: async (child) => {
        await stripOnFailure.get(child)?.();
      },
    }),
  ]);
  return ownLeft + nestedLeft;
}

/**
 * Best-effort rollback-journal deletion (issue #1183) used on the deploy
 * success path and after a clean automatic rollback. Never throws — a
 * failed delete only warns (the journal is advisory; the worst case is a
 * spurious "previous deploy failed" note on the next deploy).
 *
 * `supersededLogicalIds` (go-to-k/cdkd#4402): the ids this run's completed
 * ops recorded. The delete is a segment removal like any other, so when it
 * fails they are written onto the surviving journal's newest segment
 * (`markRollbackJournalSuperseded`) — or an older failed attempt of one of
 * them would count as adoption evidence again.
 *
 * Returns whether the journal is gone (go-to-k/cdkd#4600: a caller that
 * settled entries in it strips them when it is not).
 */
export async function deleteRollbackJournalBestEffort(
  this: DeployEngine,
  stackName: string,
  supersededLogicalIds: readonly string[] = []
): Promise<boolean> {
  let deleted: boolean | void;
  try {
    // The backend REPORTS a DeleteObject failure (`false`) rather than
    // throwing; a throw here comes from before the delete (client setup).
    deleted = await this.stateBackend.deleteRollbackJournal(stackName, this.stackRegion);
  } catch (err) {
    this.logger.debug(
      safeMsg`Failed to delete rollback journal for ${stackName}: ${err instanceof Error ? err.message : String(err)}`
    );
    deleted = false;
  }
  // Only an explicit `false` (or a throw) is a journal that may survive.
  if (deleted !== false) return true;
  if (supersededLogicalIds.length === 0) return false;
  try {
    await this.stateBackend.markRollbackJournalSuperseded(
      stackName,
      this.stackRegion,
      supersededLogicalIds
    );
  } catch (markErr) {
    this.logger.debug(
      safeMsg`Failed to record superseded logical ids on the rollback journal for ${stackName}: ${markErr instanceof Error ? markErr.message : String(markErr)}`
    );
  }
  return false;
}

/**
 * Settle the rollback journal after a CLEAN automatic rollback (issue
 * #1208). The completed ops are reverted, but the op that FAILED mid-deploy
 * may have left its resource half-applied — and its journaled record is the
 * ONLY input `cdkd rollback --revert-failed` has. So instead of deleting the
 * journal outright (which made --revert-failed unusable in the DEFAULT
 * deploy flow), pop this attempt's segment and re-record a failed-only one
 * (`operations: []` + the failed ops). Older segments from prior
 * un-reverted attempts are preserved by the pop. The next successful deploy
 * still deletes the whole journal, bounding the lingering window. With no
 * failed ops there is nothing left to revert from THIS attempt — but only
 * this attempt's segment is popped, NOT the whole journal (issue #1215):
 * the clean rollback reverted only this attempt's ops, so older segments'
 * completed ops are still live in AWS/state and must keep their revert
 * records; pop deletes the object itself when the last segment goes, so
 * the common single-segment case still ends with no journal.
 *
 * Best-effort like every journal write: a pop failure warns and leaves the
 * full segment in place (the pre-#1208 partial-rollback shape — replay is
 * idempotent, so a later `cdkd rollback` is still safe).
 *
 * Returns whether this attempt's segment was popped, i.e. whether a later
 * `cdkd rollback` can still re-run it (issue #3754 gates dropping the
 * reverted children's segments on this).
 */
export async function settleJournalAfterCleanRollback(
  this: DeployEngine,
  stackName: string,
  failedOperations: FailedOperation[],
  initialDeploy: boolean
): Promise<boolean> {
  if (failedOperations.length === 0) {
    try {
      await this.stateBackend.popRollbackJournalSegment(stackName, this.stackRegion);
    } catch (err) {
      this.logger.debug(
        `Failed to pop the rollback journal segment after the clean rollback: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    return true;
  }
  try {
    await this.stateBackend.popRollbackJournalSegment(stackName, this.stackRegion);
  } catch (err) {
    this.logger.warn(
      safeMsg`Failed to settle the rollback journal after the clean rollback: ${err instanceof Error ? err.message : String(err)}. ` +
        // No command named: a nested child's stack-less `cdkd rollback` would
        // resolve to the top-level stack (go-to-k/cdkd#3864).
        `The journal keeps the full segment; a later rollback replay is idempotent.`
    );
    return false;
  }
  const kept = await this.writeRollbackJournalSegment(
    stackName,
    [],
    failedOperations,
    'auto-rollback-clean',
    initialDeploy
  );
  // The write warns on its own failure; claiming a kept record would contradict it.
  if (!kept) return true;
  this.logger.info(
    `The automatic rollback restored the pre-deploy state. The failed resource's pre-failure ` +
      `record was kept — if it was left partially applied, revert it.` +
      `\nRevert it with: ${
        pasteableCommand('cdkd rollback', [
          { value: stackName, hole: 'stack' },
          { literal: '--revert-failed' },
        ]).command
      }`
  );
  return true;
}

/**
 * Issue #3754: once a clean automatic rollback is SETTLED — its state saved
 * and its segment popped — the nested children it reverted no longer need
 * their pending segments for this run. Gated on `settled` because a rollback
 * whose save or pop failed is re-run by `cdkd rollback`, which replays the
 * same rows and must find them.
 */
export async function settleNestedChildrenAfterCleanRollback(
  this: DeployEngine,
  stackName: string,
  settledNested: SettledNestedRows,
  settled: boolean
): Promise<void> {
  if (!settled) return;
  await dropSettledNestedJournals({
    stateBackend: this.stateBackend,
    lockManager: this.lockManager,
    parentStackName: stackName,
    region: this.stackRegion,
    settled: settledNested,
    runId: this.options.eventRecorder?.runId,
    logger: this.logger,
  });
}

/**
 * The recovery sentence a `--no-rollback` failure ends on. A NESTED child
 * engine does not name a command: a stack-less `cdkd rollback` resolves to
 * the top-level stack, and the child's failure fails the parent's row, whose
 * engine (sharing `noRollback` through the option spread) prints its own
 * `--no-rollback` message right after (go-to-k/cdkd#3864). NOT used on the
 * interrupted path: a child's poll `InterruptedError` reaches the parent
 * wrapped and is not recognised as an interrupt there (go-to-k/cdkd#3875),
 * so no message of the parent's can be promised to follow.
 */
export function recoveryHint(this: DeployEngine, topLevel: string): string {
  const parent = this.options.parentStackInfo;
  if (parent === undefined) return topLevel;
  return (
    `This is a nested stack: recover it through its top-level stack ` +
    `${quotedOrDescribed(parent.parentStack.split('~')[0]!, 'stack name')}, whose own message follows.`
  );
}

/** Build the {@link RollbackExecutorContext} from the engine's fields. */
export function rollbackExecutorContext(
  this: DeployEngine,
  previousState: StackState,
  stackName: string
): RollbackExecutorContext {
  const producerRegions = this.producerRegionEvidence(previousState);
  return {
    providerRegistry: this.providerRegistry,
    region: this.stackRegion,
    logger: this.logger,
    // go-to-k/cdkd#3869: masked by the printing bags bound where the event
    // is recorded too (a journaled orphan batch's), as its log lines are.
    recordEvent: (event) => this.recordEvent(maskEventTextWithBoundBags(event)),
    // `DeletionPolicy: Snapshot` on a rolled-back CREATE (issue #1358) —
    // the executor needs the same region-pinned clients + data-loss
    // opt-out the engine's own delete sites use.
    finalSnapshotClients: this.options.finalSnapshotClients,
    skipFinalSnapshot: this.options.skipFinalSnapshot,
    // A nested child's own rollback: its segment is replayed only by a
    // rollback of the CHILD, so the refusals' `--orphan` command names it
    // (go-to-k/cdkd#3859).
    ...(this.options.parentStackInfo && { nestedChildStack: stackName }),
    // go-to-k/cdkd#1998: the LOG-ONLY needles (a `NoEcho` parameter's
    // value) this deploy recorded per resource, which the replay's own
    // re-resolution of the journal cannot re-derive.
    logOnlyNeedlesFor: (logicalId) => this.perResourceSecrets.get(logicalId),
    // See `producerRegionEvidence`.
    importedProducerRegions: producerRegions.regions,
    producerRegionsIncomplete: !producerRegions.complete,
  };
}

/**
 * The producer regions this stack reads across (issue #2057), so a replay
 * refuses a region-LESS `{{resolve:...}}` expression rather than
 * re-resolving it here and writing a same-named foreign secret to a live
 * resource. The UNION is what makes this reachable at all — a rollback runs
 * only after a FAILED deploy, and the read this deploy INTRODUCED is in
 * `recordedImports` / `recordedOutputReads`, never yet in the persisted
 * snapshot. Strictly more evidence than `cdkd rollback` can derive on its
 * own, which sees only what a save persisted.
 *
 * A nested child adds its parent's (go-to-k/cdkd#4174), and is complete
 * only when those are.
 */
export function producerRegionEvidence(
  this: DeployEngine,
  previousState: StackState
): ProducerRegionEvidence {
  const own = producerRegionsFromState(
    crossStackReadsForPartialSave(
      previousState,
      this.recordedImports,
      this.recordedOutputReads,
      this.crossStackReadKeyNormalizer()
    )
  );
  if (!this.options.parentStackInfo) return { regions: own, complete: true };
  return inheritProducerRegions(own, this.options.inheritedProducerRegions?.());
}

/**
 * Record one rollback-journal segment (issue #1183) so the failed /
 * interrupted / about-to-auto-rollback deploy can be reverted later by
 * `cdkd rollback`. Best-effort like the partial-state save, but warns
 * LOUDLY on failure — the user just lost the ability to `cdkd rollback`.
 *
 * Returns whether THIS call appended a segment: `false` for the empty-segment
 * skip and for a failed write. The clean auto-rollback's settle pops the
 * NEWEST segment, so it may run only when this attempt wrote it; otherwise it
 * pops an OLDER attempt's revert record (a refused-before-applying CREATE
 * journals nothing since go-to-k/cdkd#4356, so its attempt can be empty).
 */
export async function writeRollbackJournalSegment(
  this: DeployEngine,
  stackName: string,
  completedOperations: CompletedOperation[],
  failedOperations: FailedOperation[],
  reason: RollbackJournalSegment['reason'],
  initialDeploy: boolean,
  /**
   * Issue #3754: a nested child's success segment is written even when EMPTY
   * — its presence is what tells the parent's revert that the child had
   * nothing to undo, as opposed to having no record at all — and carries the
   * child's pre-deploy outputs.
   */
  nestedPending?: Pick<RollbackJournalSegment, 'previousOutputs' | 'previousCrossStackReads'>
): Promise<boolean> {
  // A segment with no operations carries nothing to revert — skip it so a
  // failure before any resource completed does not create an empty journal.
  // A failed op alone (#1198) IS worth journaling: `cdkd rollback
  // --revert-failed` can act on it even with zero completed ops.
  if (!nestedPending && completedOperations.length === 0 && failedOperations.length === 0) {
    return false;
  }
  // Redact resolved secret plaintext out of the journal (GHSA fix): the ops
  // carry resolved / attempted properties and previous-state snapshots read
  // from the in-memory working map, which is NOT run through the state save
  // choke point, so plaintext would otherwise land in rollback-journal.json.
  const redactedCompleted = this.redactOperationsForJournal(completedOperations);
  const redactedFailed = this.redactOperationsForJournal(failedOperations);
  try {
    const segment: RollbackJournalSegment = {
      ...(this.options.eventRecorder?.runId !== undefined && {
        runId: this.options.eventRecorder.runId,
      }),
      timestamp: Date.now(),
      reason,
      initialDeploy,
      ...(this.options.roleArn && { roleArn: this.options.roleArn }),
      cdkdVersion: getCdkdVersion(),
      // Issue #4018: the prefix flag this deploy's providers derived names
      // under, so `cdkd rollback` replays the segment in the same scope.
      skipPrefix: getCurrentSkipPrefix(),
      operations: redactedCompleted,
      ...(redactedFailed.length > 0 && { failedOperations: redactedFailed }),
      // go-to-k/cdkd#4043 (review B3): the pre-deploy outputs a pre-v11
      // record held in the clear go through the same positional arm.
      ...(nestedPending?.previousOutputs && {
        previousOutputs: {
          ...nestedPending.previousOutputs,
          outputs: this.maskOutputsByPosition(nestedPending.previousOutputs.outputs),
        },
      }),
      ...(nestedPending?.previousCrossStackReads && {
        previousCrossStackReads: nestedPending.previousCrossStackReads,
      }),
    };
    await this.stateBackend.appendRollbackJournalSegment(stackName, this.stackRegion, segment);
    this.logger.debug(`Rollback journal segment written (${reason})`);
    return true;
  } catch (journalError) {
    this.logger.warn(
      `Failed to write rollback journal: ${journalError instanceof Error ? journalError.message : String(journalError)}. ` +
        `'cdkd rollback' will NOT be able to revert this deploy — use 'cdkd deploy' to resume or 'cdkd destroy' to clean up.`
    );
    return false;
  }
}
