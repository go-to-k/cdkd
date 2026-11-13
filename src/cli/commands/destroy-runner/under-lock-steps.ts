/**
 * The steps `destroyStackUnderLock` runs (split out of
 * `../destroy-runner.ts`, go-to-k/cdkd#5835).
 */
import { refusePendingMovesOut } from '../../../state/pending-moves.js';
import { readRefactorMarker, refuseRefactorMarker } from '../../../state/refactor-marker.js';
import {
  cdkdRemedy,
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import { displaySafe, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import { bold, green, red, yellow } from '../../../utils/colors.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { DagBuilder } from '../../../analyzer/dag-builder.js';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../../../analyzer/implicit-delete-deps.js';
import { withStackScope } from '../../../provisioning/resource-name.js';
import { nameScopeOf } from '../../../state/name-generation.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import type { StackState } from '../../../types/state.js';
import { accountArgs, withheldAccountClause } from '../../../state/malformed-resources-bag.js';
import {
  CdkdError,
  StackHasActiveImportsError,
  StackTerminationProtectionError,
} from '../../../utils/error-handler.js';
import {
  loadJournaledOrphans,
  sameJournaledOrphans,
} from '../../../deployment/rollback-executor/journaled-orphans.js';
import {
  namingSecretsWithRecordedNoEcho,
  secretNamePrintingBags,
} from '../../../deployment/secret-name-needles.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';
import type { DestroyRunnerContext, DestroyRunnerResult, DestroyLogger } from './types.js';
import {
  SKIPPED_REMEDY,
  holdsSameResourcesAs,
  refuseNewPendingRequests,
  scanActiveConsumers,
} from './helpers.js';
import type { HeldStackLock } from '../stack-lock-guard.js';

/** What {@link recheckUnderLock} reads from `destroyStackUnderLock`. */
export interface RecheckFrame {
  ctx: DestroyRunnerContext;
  stackName: string;
  state: StackState;
  regionForState: string;
  refusalRecovery: LockRecoveryContext;
  lock: HeldStackLock;
  restoreBaseRegionAndClients: () => void;
  needsStrongRefCheck: boolean;
}

/**
 * Under the lock, before anything is deleted: the record re-read against the
 * snapshot the prompt answered, and the second strong-reference scan. Every
 * refusal releases the lock and restores the region first.
 */
export async function recheckUnderLock({
  ctx,
  stackName,
  state,
  regionForState,
  refusalRecovery,
  lock,
  restoreBaseRegionAndClients,
  needsStrongRefCheck,
}: RecheckFrame): Promise<void> {
  // Under the lock, re-read what the checks above saw BEFORE the confirmation
  // prompt (go-to-k/cdkd#5220): another command may have written this record
  // while the prompt waited -- a `cdkd refactor` that moved a resource to
  // another stack, a deploy that replaced one -- and deleting from the stale
  // snapshot would delete a resource the record no longer owns, and one added
  // since would be dropped with the record. The record must still hold exactly
  // the snapshot's resources. The refactor marker is read beside it
  // (go-to-k/cdkd#5212), this destroy's only read of it, so both cost one
  // concurrent round trip.
  try {
    const [current, marker] = await Promise.all([
      ctx.stateBackend.getState(stackName, regionForState),
      readRefactorMarker(ctx.stateBackend),
    ]);
    if (current === null || !holdsSameResourcesAs(state, current.state)) {
      throw new CdkdError(
        safeMsg`cdkd destroy refused stack ${stackName} (${regionForState}): its state ` +
          'changed after it was read (another command wrote it while this one waited for ' +
          `confirmation), so nothing was deleted. Re-run ${cdkdRemedy('cdkd destroy')}.`,
        'STATE_CHANGED'
      );
    }
    // go-to-k/cdkd#5238: a deploy turning termination protection on while
    // the prompt waited saves the record with the same rows, so the check
    // above passes it; the protection the callers checked before the prompt
    // is checked again here.
    if (current.state.terminationProtection === true && ctx.removeProtection !== true) {
      throw new StackTerminationProtectionError(
        stackName,
        undefined,
        {
          args: accountArgs(refusalRecovery),
          clause: withheldAccountClause(refusalRecovery, 'the command below prints'),
        },
        {
          command: ctx.stateDestroy === true ? 'cdkd state destroy' : 'cdkd destroy',
          stackRegion: regionForState,
        }
      );
    }
    refusePendingMovesOut(current.state, stackName, regionForState, 'cdkd destroy');
    refuseRefactorMarker(marker, stackName, regionForState, 'cdkd destroy');
  } catch (error) {
    await lock.release({ failureMessage: 'Failed to release lock after a state re-check refusal' });
    restoreBaseRegionAndClients();
    throw error;
  }

  // Second strong-reference scan, now under the producer's lock. The
  // pre-flight scan above is a UX optimization (fast-fail before the
  // prompt); this second scan is the safety boundary. A consumer that
  // started deploying after the pre-flight may have written its
  // imports[] in the meantime — refuse before any provider.delete
  // fires so we don't leave a half-deleted producer + a confused
  // consumer. There is still a small residual TOCTOU window between
  // this re-scan and the resource-level deletes below — a brand-new
  // consumer deploy that runs ENTIRELY between this scan and the
  // delete-loop start is invisible. Per-stack locks can't cover
  // cross-stack reads; this matches CloudFormation's own inherent
  // limitation. Documented in docs/cross-stack-references.md.
  if (needsStrongRefCheck) {
    // Any exit out of this block happens BEFORE the main try/finally that
    // owns the lock release, so it releases here — for the refusal throw AND
    // for an unexpected scan failure (`listStacks` is not caught inside
    // `scanActiveConsumers`). `release()` keeps the handler armed across the
    // round-trip and unregisters it last.
    const releaseThenUnregister = async (): Promise<void> => {
      await lock.release({
        failureMessage: 'Failed to release lock after strong-ref refusal/failure',
      });
      // This exit also happens BEFORE the main try/finally that restores the
      // process-global region / clients, so a cross-region destroy refused (or
      // failed) at the strong-ref scan would otherwise leak them for the rest
      // of a `--all` run — the same class as the acquire-failure path above
      // (issue #2161).
      restoreBaseRegionAndClients();
    };
    let consumers: Awaited<ReturnType<typeof scanActiveConsumers>>;
    try {
      consumers = await scanActiveConsumers(stackName, regionForState, ctx);
    } catch (error) {
      await releaseThenUnregister();
      throw error;
    }
    if (consumers.length > 0) {
      await releaseThenUnregister();
      throw new StackHasActiveImportsError(stackName, regionForState, consumers);
    }
  }
}

/** The summary's remedy-hint builders, for the run's region and account flags. */
export function makeSummaryHints(
  regionForState: string,
  refusalRecovery: LockRecoveryContext
): {
  hintFor: (command: string, targets: string[], label: string) => string;
  hintHolesClause: (targets: readonly string[]) => string;
} {
  /**
   * One labelled line per target — the hint both summary arms print.
   *
   * The PROSE quotes are gone, every target goes through the shared gate, and
   * each command gets its OWN line (go-to-k/cdkd#3436). The old
   * `'${command} ${t}'` wrapper is the shape whose paste ran an interpolated
   * value, and this builder was the issue's example of a command the repo-wide
   * grep cannot see, since neither `'cdkd ` nor the value is on the same line
   * as the other. The ` / ` join that first replaced it was its own defect:
   * pasted, it handed the second command to the first as arguments.
   */
  // The ONE builder both `hintFor` and `hintHolesClause` read, so the sentence
  // explaining a hole comes from the gate's own verdict rather than a second
  // predicate that can disagree with it (go-to-k/cdkd#3759).
  const hintCommand = (command: string, t: string) =>
    pasteableCommand(command, [
      { value: t, hole: 'stack', opts: { plainIdent: true } },
      { flag: '--stack-region', value: regionForState, hole: 'region', opts: { plainIdent: true } },
      // The run's account flags (go-to-k/cdkd#4648): a pasted drop removes the
      // record in the bucket this destroy read, not the default profile's.
      ...accountArgs(refusalRecovery),
    ]);
  const hintFor = (command: string, targets: string[], label: string): string =>
    // DEDUPED on the produced line, not on the target: one resource failing
    // while another is skipped puts the same state target in both sets, and a
    // name that fails the gate collapses EVERY target to the identical
    // `'<stack>'` line — N copies with nothing to tell them apart (m6 of the
    // go-to-k/cdkd#3499 review).
    [
      ...new Set(
        targets.map(
          (t) =>
            // `--stack-region` is not optional here: without it `state orphan`
            // drops the record for this NAME IN EVERY REGION, so an operator
            // repairing one region would orphan another region's resources with
            // no record of their ids (M2 of the go-to-k/cdkd#3499 review). The
            // `state show` hint carries it for the same reason — a readback of
            // the wrong region's record is the same mistake, one step earlier.
            // `plainIdent` on both values: a target beside a labelled line is
            // named only when it cannot spell one (go-to-k/cdkd#3759).
            `\n${label}: ${hintCommand(command, t).command}`
        )
      ),
    ].join('');

  /**
   * The ONE sentence explaining `hintFor`'s holes, for the prose BEFORE its
   * lines (go-to-k/cdkd#3759). `hintFor` prints one command per target, so a
   * per-hole `withheldTargetClause` would repeat once per line; this states the
   * rule once, and only when the gate actually withheld a value on some line.
   */
  const hintHolesClause = (targets: readonly string[]): string =>
    // IDENTITY holes only here; an account hole is explained by its own
    // sentence, from the same context (go-to-k/cdkd#4648).
    (targets.every((t) =>
      hintCommand('cdkd state show', t).withheld.every(
        (w) => w.hole !== 'stack' && w.hole !== 'region'
      )
    )
      ? ''
      : ` A target that is not a plain identifier is printed as a quoted '<stack>' or ` +
        `'<region>' placeholder; list the records as stored with ${proseQuoted(cdkdRemedy('cdkd state list', '--long'))}.`) +
    (targets.length === 0
      ? ''
      : ((clause) => (clause === '' ? '' : ` ${clause}`))(
          withheldAccountClause(refusalRecovery, 'the command lines below print').trimEnd()
        ));
  return { hintFor, hintHolesClause };
}

/** What {@link reReadJournaledOrphansUnderLock} reads from `destroyStackUnderLock`. */
export interface JournalReReadFrame {
  ctx: DestroyRunnerContext;
  stackName: string;
  regionForState: string;
  state: StackState;
  journaledOrphans: Awaited<ReturnType<typeof loadJournaledOrphans>>;
  logger: DestroyLogger;
}

/** The journaled orphans re-read under the lock; a changed set refuses. */
export async function reReadJournaledOrphansUnderLock({
  ctx,
  stackName,
  regionForState,
  state,
  journaledOrphans,
  logger,
}: JournalReReadFrame): Promise<Awaited<ReturnType<typeof loadJournaledOrphans>>> {
  // go-to-k/cdkd#4584: before the stack's own resources, which such a
  // resource may depend on (it was created after them), and under the lock.
  // A failure preserves the state, and with it the journal, for a re-run.
  // Re-read under the lock first: what the prompt listed was read before
  // it, and a deploy failing in between journals an orphan this run would
  // otherwise sweep unacted — so a changed SET (not just its size) refuses,
  // as the fast path's re-check does, rather than act on one nobody
  // confirmed. What is deleted is the set read under the lock.
  const journaledUnderLock = await loadJournaledOrphans(
    ctx.stateBackend,
    stackName,
    regionForState,
    state.orphans,
    // Warned once: silent only when the entry read already warned.
    journaledOrphans.unreadable === true ? { warn: () => undefined } : logger
  );
  if (journaledUnderLock.unreadable === true && journaledOrphans.unreadable !== true) {
    throw new Error(
      `The rollback journal of stack ${displayStackName(stackName)} (${displaySafe(regionForState, { asciiOnly: true })}) ` +
        `was readable when this run started and cannot be read now (see the warning above). ` +
        `Nothing was deleted; re-run the destroy once it can be read.`
    );
  }
  refuseNewPendingRequests(journaledUnderLock, stackName, regionForState);
  if (!sameJournaledOrphans(journaledUnderLock, journaledOrphans)) {
    throw new Error(
      `The rollback journal of stack ${displayStackName(stackName)} (${displaySafe(regionForState, { asciiOnly: true })}) ` +
        `recorded ${journaledOrphans.count} resource(s) a failed deploy created when this run started and ` +
        `${journaledUnderLock.count} now, not the same ones — another cdkd process wrote to it. ` +
        `Nothing was deleted; re-run the destroy to act on the current journal.`
    );
  }
  return journaledUnderLock;
}

/** The reverse-delete dependency graph of the stack's recorded resources. */
export function buildDeleteGraph(
  state: StackState,
  logger: DestroyLogger
): {
  dagBuilder: DagBuilder;
  blockingGraph: ReturnType<DagBuilder['buildGraph']>;
  executionLevels: string[][];
} {
  logger.info('Building dependency graph...');

  const template = {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {} as Record<
      string,
      { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
    >,
  };

  for (const [logicalId, resource] of Object.entries(state.resources)) {
    template.Resources[logicalId] = {
      Type: resource.resourceType,
      Properties: resource.properties || {},
      ...(resource.dependencies &&
        resource.dependencies.length > 0 && {
          DependsOn: resource.dependencies,
        }),
    };
  }

  // go-to-k/cdkd#5670: the edges a failed delete BLOCKS over -- the
  // per-resource ones, without the type-pair ordering below. A type-pair
  // rule orders EVERY resource of one type before EVERY one of another
  // (each subnet before each Lambda function), so blocking over it would
  // keep resources the failed one never referenced, which CloudFormation
  // deletes. Entries are replaced, never mutated, so a shallow copy holds.
  const blockingResources = { ...template.Resources };

  // Type-based implicit deletion ordering (shared with deploy DELETE phase).
  const typeToLogicalIds = new Map<string, string[]>();
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    const ids = typeToLogicalIds.get(resource.resourceType) ?? [];
    ids.push(logicalId);
    typeToLogicalIds.set(resource.resourceType, ids);
  }

  for (const [logicalId, resource] of Object.entries(state.resources)) {
    const mustDeleteAfter = IMPLICIT_DELETE_DEPENDENCIES[resource.resourceType];
    if (!mustDeleteAfter) continue;

    for (const depType of mustDeleteAfter) {
      const depIds = typeToLogicalIds.get(depType);
      if (!depIds) continue;
      for (const depId of depIds) {
        const existing = template.Resources[depId]?.DependsOn ?? [];
        const depsArray = Array.isArray(existing) ? existing : [existing];
        if (!depsArray.includes(logicalId)) {
          template.Resources[depId] = {
            ...template.Resources[depId]!,
            DependsOn: [...depsArray, logicalId],
          };
          logger.debug(
            `Implicit delete dependency: ${displaySafe(depId)} (${displaySafe(depType)}) must be deleted before ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)})`
          );
        }
      }
    }
  }

  // Per-resource implicit delete edges that cannot be inferred from a
  // type-pair rule (e.g. CompositeAlarm -> the metric alarms its AlarmRule
  // references by name, which carry no Ref / Fn::GetAtt edge). `before` must
  // be deleted before `after`, so `before` DependsOn `after` (creation order
  // is reversed for deletion, so `before` is torn down first).
  for (const { before, after } of computeImplicitDeleteEdges(state.resources)) {
    // Judged on its own: a type-pair rule may already have put this edge in
    // `template` but never in `blockingResources`.
    const blocking = blockingResources[before]?.DependsOn ?? [];
    const blockingArray = Array.isArray(blocking) ? blocking : [blocking];
    if (!blockingArray.includes(after)) {
      blockingResources[before] = {
        ...blockingResources[before]!,
        DependsOn: [...blockingArray, after],
      };
    }
    const existing = template.Resources[before]?.DependsOn ?? [];
    const depsArray = Array.isArray(existing) ? existing : [existing];
    if (!depsArray.includes(after)) {
      template.Resources[before] = {
        ...template.Resources[before]!,
        DependsOn: [...depsArray, after],
      };
      logger.debug(
        `Implicit delete dependency: ${displaySafe(before)} (${displaySafe(state.resources[before]?.resourceType)}) must be deleted before ${displaySafe(after)} (${displaySafe(state.resources[after]?.resourceType)})`
      );
    }
  }

  const dagBuilder = new DagBuilder();
  const graph = dagBuilder.buildGraph(template);
  const blockingGraph = dagBuilder.buildGraph({ ...template, Resources: blockingResources });
  const executionLevels = dagBuilder.getExecutionLevels(graph);

  logger.debug(`Dependency graph: ${executionLevels.length} level(s)`);
  return { dagBuilder, blockingGraph, executionLevels };
}

/** What {@link makePrintingBagOf} reads from `destroyStackUnderLock`. */
export interface PrintingBagFrame {
  ctx: DestroyRunnerContext;
  state: StackState;
  noEchoValues: RecordedSecretValues | undefined;
  stackName: string;
  logger: DestroyLogger;
}

/** Each resource's delete-time printing bag. */
export function makePrintingBagOf({
  ctx,
  state,
  noEchoValues,
  stackName,
  logger,
}: PrintingBagFrame): (logicalId: string) => RecordedSecretValues {
  // go-to-k/cdkd#3869: judged with the stack's `NoEcho` values too, each
  // record once (see `noEchoValues` above), plus what each record stores
  // where a `NoEcho` parameter of the template served it: a name taken from
  // a value since CHANGED, which the bound values no longer spell.
  const reresolver = ctx.noEchoReresolver;
  const judgedBagOf = secretNamePrintingBags(
    state.resources,
    reresolver === undefined
      ? noEchoValues
      : namingSecretsWithRecordedNoEcho(noEchoValues, (logicalId) => {
          // A masking-only judgment never stops a delete.
          try {
            return reresolver.recordedNoEchoValuesFor(
              logicalId,
              Object.hasOwn(state.resources, logicalId) ? state.resources[logicalId] : undefined
            );
          } catch (error) {
            // The class only: a message can quote a value.
            logger.debug(
              safeMsg`Could not read ${logicalId}'s stored NoEcho values for its printing bag (${error instanceof Error ? error.name : typeof error}).`
            );
            return undefined;
          }
        })
  );
  // A name its provider DERIVED from a plaintext one (the stack-name prefix
  // and the truncation `generateResourceNameWithFallback` applies) is
  // spelled in this stack's naming scope, as the deploy that created it
  // derived it (go-to-k/cdkd#5064: its lifetime too); a destroy binds none
  // of its own.
  const namingScope = nameScopeOf(
    stackName,
    stackInstanceIdOf(state, displayStackName(stackName)),
    state
  );
  const printingBagOf = (logicalId: string): RecordedSecretValues =>
    withStackScope(namingScope, () => judgedBagOf(logicalId));
  return printingBagOf;
}

/** What {@link printDestroySummary} reads from `destroyStackUnderLock`. */
export interface DestroySummaryFrame {
  result: DestroyRunnerResult;
  ctx: DestroyRunnerContext;
  stackName: string;
  logger: DestroyLogger;
  preserveState: boolean;
  guardIndeterminateTargets: Set<string>;
  skippedStateTargets: Set<string>;
  failedStateTargets: Set<string>;
  hintFor: (command: string, targets: string[], label: string) => string;
  hintHolesClause: (targets: readonly string[]) => string;
  journaledOrphanFailures: number;
}

/** The per-stack summary line, and the warnings that go with it. */
export function printDestroySummary({
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
}: DestroySummaryFrame): void {
  // Summary glyph distinguishes clean destroy (✓) from partial failure /
  // interrupt (⚠). The CLI's exit code reflects the same split (0 vs 2) —
  // see PartialFailureError in src/utils/error-handler/deploy-errors.ts. Without the
  // visual marker, a partial failure scrolls past in the same shape
  // as a successful destroy and gets missed in CI / bench output.
  const retainedSuffix = result.retainedCount > 0 ? `, ${result.retainedCount} retained` : '';
  // Issue #1752: `skipped` is only rendered when non-zero, so every existing
  // summary line (and the scripts / tests that grep it) is byte-identical on
  // a run with no skips.
  // go-to-k/cdkd#5670: appended to the skip count, so a summary with no
  // blocked resource is byte-identical to before.
  const skippedSuffix =
    (result.skippedCount > 0 ? `, ${yellow(result.skippedCount)} skipped` : '') +
    (result.blockedCount > 0 ? `, ${yellow(result.blockedCount)} blocked` : '');
  // Issue #2301: rendered on EVERY arm below, the clean-destroy one included
  // — which is the arm that matters most here. A suppressed guard does not
  // preserve state and does not fail the run, so a destroy that proceeded
  // without confirming its target reaches the `✓ Stack X destroyed` line;
  // that line is the summary an operator actually reads, and before this it
  // was byte-identical to a fully-confirmed destroy. Only rendered when
  // non-zero, so every existing summary line (and every script grepping one)
  // is unchanged on a run with no suppressed guard.
  const guardSuffix =
    result.guardIndeterminateCount > 0
      ? `, ${yellow(result.guardIndeterminateCount)} unverified`
      : '';
  if (result.guardIndeterminateCount > 0) {
    // The counter alone does not say what "unverified" means, and the
    // per-resource warns that said it have already scrolled past on any
    // stack of size. Names the resources and points at the durable record,
    // which is the whole point of issue #2301: the events OUTLIVE the run.
    // The pointer at `cdkd events` is GATED on a recorder existing, because
    // `NestedStackProvider.delete` drives this runner for a child stack with
    // no recorder in its context -- under ANY verb -- so that run writes no
    // `deployments/` object at all. Telling that caller to go read entries
    // nothing wrote sends them to an empty command and reads as cdkd having
    // lost the record -- worse than saying less. Both top-level verbs
    // (`cdkd destroy`, `cdkd state destroy` since go-to-k/cdkd#2423) thread a
    // recorder, so the nested-stack child is the only absent-recorder caller.
    const eventsCommand = pasteableCommand('cdkd events', [
      { value: stackName, hole: 'stack', opts: { plainIdent: true } },
    ]);
    const durablePointer =
      ctx.eventRecorder === undefined
        ? `This summary is the only record: this run wrote no deployment events, because ` +
          `it destroyed a nested-stack child, which threads no event recorder.`
        : `The RESOURCE_GUARD_INDETERMINATE entries name the check and the reason ` +
          `and survive the run.` +
          withheldTargetClause(eventsCommand, 'stack', 'cdkd events', "This stack's name") +
          `\nRead them with: ${eventsCommand.command}`;
    logger.warn(
      `\n${yellow('⚠')} ${result.guardIndeterminateCount} pre-flight safety check(s) could NOT ` +
        `be completed during this destroy and cdkd proceeded anyway: ` +
        `${[...guardIndeterminateTargets].map((t) => plainOrDescribed(t, 'logical id')).join(', ')}. ` +
        `A check can be suppressed by DENYING the permission it needs, so treat this as ` +
        `unconfirmed rather than benign. ${durablePointer}`
    );
  }
  if (result.journaledOrphanSkips > 0) {
    logger.warn(
      safeMsg`${result.journaledOrphanSkips} resource(s) a failed deploy created were left in AWS (each named in a ` +
        'warning above, which says what to do with it). This stack no longer records them.'
    );
  }
  if (!preserveState) {
    // go-to-k/cdkd#4658: with resources the failed deploy created left in
    // AWS the state is gone but the run exits 2, so not the green line:
    // the warning glyph, a heading that says so, and the skip count.
    const leftInAws = result.journaledOrphanSkips > 0;
    logger.info(
      `\n${leftInAws ? yellow('⚠') : green('✓')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} ${leftInAws ? 'destroyed, with resources left in AWS' : 'destroyed'}`)} (${green(result.deletedCount)} deleted${retainedSuffix}${leftInAws ? skippedSuffix : ''}${guardSuffix}, ${result.errorCount} errors)`
    );
  } else if (result.interrupted && result.errorCount === 0) {
    logger.warn(
      `\n${yellow('⚠')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} destroy interrupted`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}${guardSuffix}, ${result.errorCount} errors). ` +
        `State preserved — re-run ${proseQuoted(cdkdRemedy('cdkd destroy'))} / ${proseQuoted(cdkdRemedy('cdkd state destroy'))} to finish.`
    );
  } else if (result.errorCount === 0) {
    // Skips only. Nothing FAILED, so "partially destroyed" with an error
    // count would misdescribe the run — and the remedy is different too:
    // a skip is not a retry, and which remedy fits depends on its cause
    // (go-to-k/cdkd#2122), so the text names both and points at the lines
    // carrying the cause.
    const targets = [...skippedStateTargets];
    const showHint = hintFor('cdkd state show', targets, 'Inspect it with');
    const orphanHint = hintFor('cdkd state orphan', targets, 'Drop the record with');
    logger.warn(
      `\n${yellow('⚠')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} partially destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}${guardSuffix}, ${result.errorCount} errors). ` +
        `cdkd did not confirm the skipped resource(s) were deleted, so they may still exist ` +
        `in AWS. ${SKIPPED_REMEDY}` +
        hintHolesClause(targets) +
        // Labelled lines, one command each, with NO trailing punctuation: a
        // command inside a sentence is copied WITH the period after it, and
        // `cdkd state orphan TestStack.` addresses a different record
        // (go-to-k/cdkd#3436). `hintFor` opens each line itself, so adding a
        // `\n` here too would print a blank one.
        showHint +
        orphanHint
    );
  } else {
    // Issue #1777: the failing row can be a nested stack, and then the
    // resource that actually failed lives in the CHILD's state file. Naming
    // the parent here would tell the user to `cdkd state orphan <parent>`,
    // which drops the parent's `Child` row — the very pointer the throw was
    // added to preserve, and the user would be left with the child's state
    // file live but unreachable. Same targets-set treatment #1752 gave the
    // skip arm. The `stackName` fallback keeps the hint non-empty if a future
    // path ever increments `errorCount` without recording a target.
    const failedTargets = failedStateTargets.size > 0 ? [...failedStateTargets] : [stackName];
    // go-to-k/cdkd#4584: never while a journaled resource failed — dropping
    // the record deletes the journal, that resource's only record.
    const orphanHint =
      journaledOrphanFailures > 0
        ? ''
        : hintFor('cdkd state orphan', failedTargets, 'Drop the record with');
    // Issue #1777: a run can carry BOTH kinds at once, and this arm owns that
    // case (the skip-only arm above is unreachable once errorCount > 0). The
    // counters already print `, N skipped`, so saying nothing about them here
    // would name a remedy for the failures and silently drop #1752's guidance
    // for the skips — whose remedy is DIFFERENT in kind: a skip is not
    // retryable as it stands (go-to-k/cdkd#2122: which remedy fits depends
    // on its cause).
    const skippedTargets = [...skippedStateTargets];
    const skippedClause =
      skippedTargets.length > 0
        ? ` Separately, ${result.skippedCount} resource(s) were SKIPPED — cdkd did not confirm ` +
          `they were deleted, so they may still exist in AWS. ${SKIPPED_REMEDY}`
        : '';
    // Every command AFTER all the prose, one per line (go-to-k/cdkd#3436):
    // mid-sentence, a copy through the line end takes the words around it.
    // No length guard: `hintFor` maps over the targets, so an empty set
    // yields an empty string without reaching the builder. A conditional here
    // is a branch whose two sides produce identical output.
    // go-to-k/cdkd#4584: dropping THIS stack's record deletes its journal,
    // the only record of a journaled resource whose delete failed — so its
    // own target is never offered while one did (a nested child's is).
    const droppableSkipped =
      journaledOrphanFailures > 0 ? skippedTargets.filter((t) => t !== stackName) : skippedTargets;
    const skippedCommands =
      hintFor('cdkd state show', skippedTargets, 'Inspect it with') +
      hintFor('cdkd state orphan', droppableSkipped, 'Drop the record with');
    // ACROSS the two calls as well as within each: a stack with one FAILED
    // and one SKIPPED resource puts the same state target in both sets, and
    // `hintFor` cannot see the other call's output (m6 of the
    // go-to-k/cdkd#3499 review).
    const dedupedCommands = (lines: string): string =>
      [...new Set(lines.split('\n').filter((l) => l !== ''))].map((l) => `\n${l}`).join('');
    logger.warn(
      `\n${yellow('⚠')} ${bold(`Stack ${plainOrDescribed(stackName, 'stack name')} partially destroyed`)} (${green(result.deletedCount)} deleted${retainedSuffix}${skippedSuffix}${guardSuffix}, ${red(result.errorCount)} errors). ` +
        `State preserved — re-run ${proseQuoted(cdkdRemedy('cdkd destroy'))} / ${proseQuoted(cdkdRemedy('cdkd state destroy'))} to clean up. ` +
        (journaledOrphanFailures > 0
          ? `${journaledOrphanFailures} of the failures are resources a failed deploy created that ` +
            `only the rollback journal records: re-run the destroy to retry them. Do not drop ` +
            `this stack's state record — that also deletes the journal, their only record.`
          : `If the same resource keeps failing, dropping the state record is the last resort: ` +
            `it removes the record without deleting AWS resources.`) +
        skippedClause +
        // Only the targets that print a line: with a journaled failure the
        // drop is withheld, and a clause about holes in lines that are not
        // printed points at nothing (go-to-k/cdkd#4648 review).
        hintHolesClause([...(orphanHint === '' ? [] : failedTargets), ...skippedTargets]) +
        dedupedCommands(orphanHint + skippedCommands)
    );
  }
}
