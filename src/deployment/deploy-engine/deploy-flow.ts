import { readRefactorMarker } from '../../state/refactor-marker.js';
import { seedPersistedNoEchoAttributes } from './noecho.js';
import { stampReasonlessParameterRefusals } from './observed-capture.js';
import { captureStoredNoEchoNamingValues, stateNamingSecrets } from './masking.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { withStackScope, type StackScope } from '../../provisioning/resource-name.js';
import { stackInstanceIdOf } from '../../state/stack-instance-id.js';
import { stackIdTailOf } from '../../state/stack-id-tail.js';
import type { StackInstanceIdentity } from '../../state/stack-instance-id.js';
import { randomUUID } from 'node:crypto';
import { StateError } from '../../utils/error-handler.js';
import { nameGenerationsOf } from '../../state/name-generation.js';
import { flushKeptForReadoption } from './delete.js';
import { adoptRollbackOrphans, producerRegionEvidence } from './rollback.js';
import { journalCanOwnResources } from '../../state/cross-prefix-stack-scan.js';
import { PhaseClock, phaseScopeForStack } from '../../utils/phase-timings.js';
import { loadKeptForWarning } from '../kept-in-history.js';
import type { DeployEngine } from '../deploy-engine.js';
import type { CreateOnlyPrefetch } from '../../provisioning/create-only-properties.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type StackState,
  importableOutputKeys,
} from '../../types/state.js';
import { green, red, yellow } from '../../utils/colors.js';
import { asIsMessage, displayStackName, safeMsg } from '../../utils/display-safe.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import type { DeployResult } from './options.js';
import {
  backfillMaskedPropertyFingerprints,
  withRebaselinedFingerprints,
} from '../masked-property-fingerprints.js';
import { withProducerRegions } from '../producer-regions-scope.js';
import {
  noteDeployStateRecord,
  prefetchCreateTokenLedger,
} from '../../provisioning/providers/create-token-ledger.js';
import { secretNamedRecordNeedles } from '../secret-name-needles.js';
import { isKnownTokenFreeState } from '../../state/token-free-state.js';
import { executeDeployment } from './execute.js';
import { refuseUnreadableLoadedState } from './deploy-flow/load-checks.js';
import { settleJournalAtStart } from './deploy-flow/journal-at-start.js';
import { resolveDeployParameters } from './deploy-flow/parameters.js';
import { evaluateDeployConditions } from './deploy-flow/conditions.js';
import { validateAndBuildGraph } from './deploy-flow/validate.js';
import { calculateDeployDiff } from './deploy-flow/diff.js';
import { getCurrentNestedStackContext } from '../../provisioning/nested-stack-context.js';
import {
  checkNestedSsmNames,
  forcedChildrenChecked,
  nestedSsmNameRowNote,
} from '../nested-ssm-name-check.js';
import { refuseUnsafePlan } from './deploy-flow/plan-checks.js';
import { deployWithoutChanges } from './deploy-flow/no-change.js';
import { prepareChangeExecution } from './deploy-flow/change-plan.js';
import { settleSuccessfulDeploy } from './deploy-flow/success-settle.js';
import { keptHistorySources } from './deploy-flow/kept-history.js';
import { createNoEchoValueMacs } from '../noecho-value-macs.js';
import {
  healSlashedSsmParameterNames,
  slashedSsmNameHealNote,
  type SlashedSsmNameHeal,
} from '../ssm-slashed-name-heal.js';

/**
 * Connections `warmConnections` opens before the tail (#4837): the state
 * save, then the events flush's two concurrent calls, all on the state
 * backend's client.
 */
const TAIL_WARM_CONNECTIONS = 3;

export async function doDeployWithPrefetch(
  engine: DeployEngine,
  stackName: string,
  template: CloudFormationTemplate,
  createOnlyPrefetch: CreateOnlyPrefetch
): Promise<DeployResult> {
  const startTime = Date.now();
  // go-to-k/cdkd#5200: inert unless CDKD_PHASE_TIMINGS=1.
  const clock = new PhaseClock(phaseScopeForStack(stackName, engine.stackRegion));
  engine.logger.debug(safeMsg`Starting deployment for stack: ${displayStackName(stackName)}`);

  // Live progress renderer: shows in-flight resources as a multi-line area
  // at the bottom of the terminal. Self-disables on non-TTY and when
  // `CDKD_NO_LIVE=1` is set (the CLI sets this in verbose mode so debug
  // logs do not interleave with the live area). Created (not started)
  // before the lock acquisition below because the SIGINT handler routes
  // its notice through it; `printAbove` falls through to a direct write
  // while the renderer is not yet started.
  const renderer = getLiveRenderer();

  // Register SIGINT handler to save partial state on Ctrl+C. Registered
  // BEFORE `acquireLockWithRetry` (issue #1348) so a signal landing during
  // the acquisition's S3 round-trip flips the interrupt flag instead of
  // hitting the unhandled default (or the #1342 forwarder's exit-143
  // fallback) and stranding the just-written lock: with the flag set, the
  // DAG executor dispatches no work and the `finally` below releases the
  // lock through the normal path.
  engine.interrupted = false;
  engine.interruptCause = null;
  engine.userInterrupted = false;
  const sigintHandler = () => {
    // Route the interrupt notice through the live renderer so it does not
    // collide with the in-flight task display.
    renderer.printAbove(() => {
      process.stderr.write(
        '\nInterrupted — saving partial state after current operations complete...\n'
      );
    });
    engine.interrupted = true;
    engine.interruptCause ??= 'user';
    // Unconditional: a sibling's failure may already hold the cause.
    engine.userInterrupted = true;
  };
  process.on('SIGINT', sigintHandler);

  // Acquire lock with retry (retries up to 3 times with 2s delay for transient lock conflicts)
  try {
    await engine.lockManager.acquireLockWithRetry(
      stackName,
      engine.stackRegion,
      undefined,
      'deploy'
    );
  } catch (error) {
    // The try/finally that owns the listener removal starts below — clean
    // up here so an acquire failure does not leak the handler.
    process.removeListener('SIGINT', sigintHandler);
    throw error;
  }
  clock.lap('lock acquire');

  // go-to-k/cdkd#4705 review P4 / G-6: a first deploy's state gate runs
  // overlapped with the work before the plan is acted on. When that work
  // throws while the gate is still pending, the gate's refusal (if it
  // refuses) is the error reported -- it is the more fundamental one.
  let firstDeployStateGate: Promise<void> | undefined;
  // The exports index read step 1b starts (#4837); awaited before the lock
  // goes, like the journal purge. Never rejects.
  let exportsPrefetch: Promise<void> | undefined;
  // The final save's background cleanup (go-to-k/cdkd#5200): on a first
  // deploy, the write-ahead instance id's sibling. Awaited beside the
  // post-save writes and again before the lock goes. Never rejects.
  let finalSaveCleanup: Promise<void> | undefined;
  // go-to-k/cdkd#4705: this run found no record (a first deploy), and it
  // failed -- the `finally` then checks whether it left one.
  let firstDeploy = false;
  let failed = false;
  try {
    // Started INSIDE this `try` (issue #2171): `start()` writes to stdout and
    // can throw (EPIPE on `cdkd deploy | head`), and it sits AFTER the lock
    // acquisition, so a throw outside would strand the lock for its full TTL.
    // This is the same move issue #2161 made in `destroy-runner.ts`; the two
    // commands had the identical shape and only one of them was fixed.
    renderer.start();

    // 1. Load current state. The rollback journal step 1b reads is read
    // beside it (go-to-k/cdkd#5200): both are reads under the lock, and
    // nothing between the two writes the journal. Its failure is 1b's to
    // handle, so it is caught here and rethrown there.
    const journalRead = Promise.resolve().then(() =>
      engine.stateBackend.loadRollbackJournal(stackName, engine.stackRegion)
    );
    journalRead.catch(() => undefined);
    // The refactor marker (go-to-k/cdkd#5212) is read beside the state too,
    // under this stack's lock, so it adds no wait and cannot be older than the
    // lock: a refactor that started after this run did is seen.
    const [currentStateData, refactorMarker] = await Promise.all([
      engine.stateBackend.getState(stackName, engine.stackRegion),
      readRefactorMarker(engine.stateBackend),
    ]);
    clock.lap('state load');
    // The create-token ledger replaces one that outlived its state record
    // (go-to-k/cdkd#4438).
    noteDeployStateRecord(currentStateData?.state !== undefined);
    const currentState: StackState = currentStateData?.state ?? {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: engine.stackRegion,
      stackName,
      resources: {},
      outputs: {},
      // A record that does not exist yet exports nothing, and that is KNOWN
      // (issue #2193): a first deploy that fails before its outputs resolve
      // carries this bag forward, and must not persist it as "not known".
      exportNames: [],
      lastModified: Date.now(),
    };
    const currentEtag = currentStateData?.etag;
    // go-to-k/cdkd#5238: the record says what the DEPLOYED stack's
    // `terminationProtection` is, so `cdkd state destroy` (no CDK app) can
    // honor it. Set from this synth on the in-memory record, so every save
    // below writes it (the carrier copies it) and a no-change deploy that
    // only toggles it still saves. A nested child takes none: the setting is
    // the root stack's.
    const loadedTerminationProtection = currentState.terminationProtection === true;
    if (!engine.options.parentStackInfo) {
      if (engine.options.terminationProtection === true) currentState.terminationProtection = true;
      else delete currentState.terminationProtection;
    }
    const terminationProtectionChanged =
      (currentState.terminationProtection === true) !== loadedTerminationProtection;
    // go-to-k/cdkd#5064: the scope every generated name of this deploy is
    // derived in -- the record's stack instance id (`undefined` for a legacy
    // record, and for a first deploy until `resolveStackInstanceId` below
    // sets it; a `--dry-run` first deploy never has one). A malformed
    // recorded id is refused here, before anything acts.
    stackInstanceIdOf(currentState, displayStackName(stackName));
    // Phase 2: each logical id's name generation as the record holds it at
    // the load (a replacement binds the next one around its create). A
    // malformed generation is refused here too. A first deploy's record is
    // empty, so every create takes generation 0.
    const loadedNameGenerations = nameGenerationsOf(currentState);
    const nameScope = (): StackScope => {
      const stackInstanceId = stackInstanceIdOf(currentState, displayStackName(stackName));
      return {
        stackName,
        stackInstanceId,
        nameGenerations: stackInstanceId === undefined ? undefined : loadedNameGenerations,
      };
    };
    // A first deploy: its id is resolved once it is going ahead.
    const idArrivesLater =
      (currentStateData === null || currentStateData === undefined) &&
      currentState.stackInstanceId === undefined;
    // go-to-k/cdkd#5064: what an earlier lifetime of this stack kept here
    // (`retained.json`). The new lifetime's names differ, so none of it is
    // taken back; the deploy says so once, below. Read at once, beside the
    // diff, and shared with the generated-name guard.
    const retainedAtFirstDeploy =
      idArrivesLater && !engine.options.dryRun
        ? Promise.resolve().then(() =>
            engine.stateBackend.loadRetainedRecord(stackName, engine.stackRegion)
          )
        : undefined;
    // Its failure is the guard's to report (it refuses on unreadable
    // evidence); the warning below only reads a successful answer. An ABSENT
    // record is what an older cdkd's destroy leaves (it wrote none), so the
    // warning then reads this prefix's own history of what was kept
    // (go-to-k/cdkd#5760); an empty record is this cdkd's "nothing kept".
    const retainedForWarning = retainedAtFirstDeploy
      ?.then(
        (retained) =>
          retained ?? loadKeptForWarning(keptHistorySources(engine), stackName, engine.stackRegion)
      )
      .catch(() => null);
    // go-to-k/cdkd#5200: the read `resolveStackInstanceId` opens with, started
    // now so it overlaps the diff; the write-ahead itself still waits for the
    // approval. Optional for the test doubles.
    if (idArrivesLater && !engine.options.dryRun) {
      engine.stateBackend.prefetchStackInstanceSibling?.(stackName, engine.stackRegion);
    }
    // go-to-k/cdkd#6274: a pre-#6272 generated SSM parameter name `/<name>`
    // is re-spelled `<name>` (the same parameter) before anything reads the
    // records, so the diff updates each dependent holding the old Ref and
    // every save below records the new spelling. A nested child heals when
    // its engine runs, i.e. when its parent's row is provisioned.
    const ssmNameHeals: SlashedSsmNameHeal[] = [];
    const healSsmNames = (): void => {
      const healed = healSlashedSsmParameterNames(currentState, template, stackName);
      if (healed.heals.length === 0) return;
      currentState.resources = healed.resources;
      for (const heal of healed.heals) engine.logger.info(slashedSsmNameHealNote(heal));
      ssmNameHeals.push(...healed.heals);
    };
    healSsmNames();
    // go-to-k/cdkd#6282: ... and once per record, the nested children are read
    // for such a name, overlapping the work up to the diff. A marked record or
    // a stack with no nested-stack row reads nothing.
    const nestedSsmCheck = checkNestedSsmNames({
      state: currentState,
      template,
      stackName,
      region: engine.stackRegion,
      nestedTemplates: getCurrentNestedStackContext()?.nestedTemplates,
      readRecord: async (name, region) => (await engine.stateBackend.getState(name, region))?.state,
    });
    nestedSsmCheck.catch(() => undefined);
    engine.rebaseline(currentState.resources ?? {});
    engine.runProducerRegionEvidence = () =>
      producerRegionEvidence(engine.rollbackDeps(), currentState);
    // go-to-k/cdkd#6170: a first deploy's identity, settled BEFORE its
    // conditions, diff and approval table resolve `AWS::StackId`, so each of
    // them sees the tail the creates are sent with: the one an interrupted
    // earlier run wrote ahead (with the flag it recorded), else a candidate
    // id the write-ahead below writes. It shares the sibling read the
    // write-ahead takes, so a first deploy pays no extra call; an ordinary
    // deploy (a record exists) never reads it. Optional for the test doubles,
    // which keep the id the write-ahead returns.
    // `--dry-run` reads nothing and writes nothing: it previews with a
    // candidate id the real first deploy will not reuse.
    const firstDeployIdentityRead =
      idArrivesLater && engine.stateBackend.peekStackInstanceSibling
        ? engine.options.dryRun
          ? Promise.resolve(null)
          : engine.stateBackend.peekStackInstanceSibling(stackName, engine.stackRegion)
        : undefined;
    firstDeployIdentityRead?.catch(() => undefined);
    let firstDeployIdentity: StackInstanceIdentity | undefined;
    engine.runStackIdTail = () =>
      stackIdTailOf(
        currentState.stackInstanceId === undefined && firstDeployIdentity !== undefined
          ? {
              stackInstanceId: firstDeployIdentity.stackInstanceId,
              ...(firstDeployIdentity.stackIdFromInstance && { stackIdFromInstance: true }),
            }
          : currentState,
        stackName
      );
    refuseUnreadableLoadedState(engine, {
      stackName,
      currentState,
      currentStateData,
      refactorMarker,
    });
    // Set when we loaded a `version: 1` legacy record. The next save
    // migrates it to the new key.
    const migrationPending = currentStateData?.migrationPending ?? false;

    engine.logger.debug(
      safeMsg`Loaded current state: ${Object.keys(currentState.resources).length} resources`
    );

    // 1a-pre. Pre-provisioning gate. Runs before the journal note, the
    // observed-properties refresh, parsing, the diff and every provider
    // call — so a caller that declines here has changed nothing. Reuses
    // the state read just performed instead of making the CLI issue its
    // own pre-lock GET of the same object.
    // go-to-k/cdkd#4705 review P4: for a FIRST deploy (no record) the gate's
    // work -- the cross-prefix registry claim -- overlaps the journal read,
    // the parse and the diff, which make no provider call and change nothing
    // for a stack with no record; it is awaited before anything acts on the
    // plan (`firstDeployStateGate` below). A loaded record keeps the gate
    // strictly first.
    if (engine.options.onCurrentStateLoaded) {
      const gate = engine.options.onCurrentStateLoaded(stackName, currentStateData?.state);
      if (currentStateData === null || currentStateData === undefined) {
        firstDeployStateGate = gate;
        firstDeploy = true;
        gate.catch(() => undefined);
      } else {
        await gate;
      }
    }
    clock.lap('state checks + loaded-state gate');

    // go-to-k/cdkd#4837: reads and a purge the success path would otherwise
    // make after the last resource, started here beside the deploy instead
    // (under the stack lock, after `noteDeployStateRecord`). The two that can
    // write -- the journal-key purge, and the exports index's rebuild of a
    // missing index -- wait for a first deploy's gate, so a deploy it refuses
    // has changed nothing. The exports index is read only when the record
    // publishes no export: then no reader can patch an entry of this stack
    // into it while this deploy runs, so this copy decides the update as a
    // fresh read would.
    const gate = firstDeployStateGate;
    // Never rejects: the result is awaited in the `finally` below.
    const afterGate = (start: () => Promise<void>): Promise<void> =>
      (gate === undefined ? Promise.resolve() : gate)
        .then(start, () => undefined)
        .catch(() => undefined);
    if (!engine.options.dryRun) {
      void prefetchCreateTokenLedger();
      const exportIndexStore = engine.exportIndexStore;
      if (exportIndexStore && importableOutputKeys(currentState).length === 0) {
        exportsPrefetch = afterGate(() => exportIndexStore.prefetch());
      }
    }
    engine.absentJournalVersionPurge = undefined;

    await settleJournalAtStart(engine, {
      stackName,
      template,
      currentState,
      currentStateData,
      journalRead,
      nameScope,
      gate,
      afterGate,
    });

    // 1-pre. Issue #3468: read every REASON-LESS baseline refusal before
    // anything in this deploy can take a readback. See the function's doc.
    stampReasonlessParameterRefusals(engine.logger, currentState.resources, template);
    // 1a. Auto-refresh observedProperties for any state entry that lacks it
    // (state written by an older binary / direct edit). Fires
    // `provider.readCurrentState` fire-and-forget through the same
    // `kickOffObservedCapture` pipeline that successful CREATE / UPDATE
    // uses, so the in-flight set is drained right before the final
    // `saveState`. Latest-wins semantics (Map.set keyed by logicalId)
    // means a CREATE / UPDATE later in the same deploy overwrites
    // the auto-refresh entry — no double-write to state. CREATEs for
    // brand-new resources skip this loop because they're not yet in
    // `currentState.resources`. Closes the upgrade UX gap left by
    // v3 schema: the manual `cdkd state refresh-observed` command
    // remains for non-deploy refresh.
    engine.observedCapture.kickOffAutoRefreshObservedProperties(
      currentState.resources,
      currentState
    );

    // 2. Template parsing is handled by DagBuilder (dependency analysis) and
    // IntrinsicResolver (intrinsic function resolution) in later steps
    engine.logger.debug(
      safeMsg`Template has ${Object.keys(template.Resources || {}).length} resources`
    );

    // Issue #2740: the source the skipped-outputs digests are taken from,
    // snapshotted HERE — before `resolveParameters`, `evaluateConditions`
    // and every resolution below. A deep COPY, so that no resolution can be
    // visible to the digest however those steps are implemented: one that
    // could see a resolved value would both diverge from `cdkd diff`'s
    // digest (which snapshots at the same point of its own flow) and
    // fingerprint a decrypted secret into `state.json`. The invariant, and
    // why it does not rest on any one resolver's in-place behaviour, is in
    // `src/analyzer/skipped-outputs.ts`. `Resources` is dropped: the digest
    // never reads it, and it is the bulk of every template.
    const outputsDigestSource: CloudFormationTemplate = structuredClone({
      ...template,
      Resources: {},
    });

    const { parameterValues, backfillNoEchoValues } = await resolveDeployParameters(
      engine,
      template
    );
    // go-to-k/cdkd#6146: the run's KMS MACs of its `NoEcho` parameter values,
    // made only when a resource reading one is provisioned (nothing otherwise),
    // bound to the stack instance id the creates run under (read then, so a
    // first deploy's write-ahead id is in place).
    engine.noEchoRun.noEchoMacs = createNoEchoValueMacs({
      template,
      parameterValues,
      inherited: engine.noEchoRun.inheritedNoEchoParameters,
      stackName,
      region: engine.stackRegion,
      stackInstanceId: () => currentState.stackInstanceId,
      logger: engine.logger,
    });
    let maskedFingerprintsBackfilled =
      backfillMaskedPropertyFingerprints(currentState.resources, template, backfillNoEchoValues) >
      0;

    if (firstDeployIdentityRead !== undefined) {
      firstDeployIdentity = (await firstDeployIdentityRead) ?? {
        stackInstanceId: randomUUID(),
        stackIdFromInstance: true,
      };
    }
    const { conditions, conditionVerdicts } = await evaluateDeployConditions(engine, {
      stackName,
      template,
      currentState,
      parameterValues,
    });

    // 2.7. Prune resources whose `Condition:` key evaluated false (issue
    // #840). CFn does not strip condition-gated resources at synth time —
    // they sit in `Resources` with a `Condition:` key regardless of value,
    // and the deploy engine excludes them when the condition is false. From
    // here on the whole pipeline (type/property validation, DAG, diff,
    // provisioning) operates on this CFn-effective resource set, so a
    // condition-false resource that exists in prior state but is now absent
    // from the effective template flows through the diff's existing
    // "in state but not in desired -> DELETE" path (CFn removes it the same
    // way), and a condition-false resource is never created in the first
    // place.
    const effectiveTemplate = engine.templateParser.filterResourcesByCondition(
      template,
      conditions
    );
    // Every save from here on stamps each record's construct path from it.
    engine.noEchoRun.constructPathTemplate = effectiveTemplate;
    // go-to-k/cdkd#4043: the positional `NoEcho` arm opens only the `Fn::If`
    // branch this deploy selected, and reads the previous records' declared
    // `NoEcho` attributes (go-to-k/cdkd#2449).
    engine.noEchoRun.noEchoConditions = conditions;
    seedPersistedNoEchoAttributes(engine.noEchoRun, currentState.resources);

    // 2b. Re-adopt anything a previous rollback left in AWS (issue #2934).
    //
    // Runs HERE — after condition pruning, before the diff — for two reasons
    // that are each load-bearing. The diff decides CREATE by absence from
    // state, so splicing a recorded resource back into `currentState`
    // produces an ordinary UPDATE with no new change type and no branch in
    // the create path. And it must read the PRUNED template: against the raw
    // one a resource under a false `Fn::If` reads as declared, gets adopted,
    // and is then seen by the diff as state-only — re-orphaning it WITHOUT
    // re-issuing a record, which loses the record permanently and is worse
    // than never adopting.
    //
    // `currentState.orphans` is mutated to the surviving set so every save
    // below persists it; the carried-forward spreads read this same object.
    const orphanCountBeforeAdoption = (currentState.orphans ?? []).length;
    const orphanPlan = await adoptRollbackOrphans(
      engine.rollbackDeps(),
      currentState,
      effectiveTemplate
    );
    // go-to-k/cdkd#3869: the secret-named records as this deploy found them,
    // adopted ones included, before any replacement re-points one. Printing
    // only (a nested stack row's registry, provision.ts). Each record is also
    // judged with what it stored where a `NoEcho` parameter served it, for a
    // name taken from a value since changed (no AWS call).
    captureStoredNoEchoNamingValues(
      engine.secretsRun,
      engine.maskingDeps(),
      currentState.resources,
      effectiveTemplate,
      conditions
    );
    engine.secretsRun.preDeploySecretNamedRecords = secretNamedRecordNeedles(
      currentState.resources,
      stateNamingSecrets(engine.secretsRun)
    );
    // Issue #3468: an adopted record entered `resources` AFTER the deploy-start
    // stamp. No writer produces a marked orphan record today; re-reading here
    // keeps that from becoming load-bearing. Idempotent, and handed the same
    // `template` object as the first pass.
    if (Object.keys(orphanPlan.adopted).length > 0) {
      // An adopted record never saw the heal above.
      healSsmNames();
      stampReasonlessParameterRefusals(engine.logger, currentState.resources, template);
      // The same re-read for go-to-k/cdkd#4451's backfill.
      if (
        backfillMaskedPropertyFingerprints(currentState.resources, template, backfillNoEchoValues) >
        0
      ) {
        maskedFingerprintsBackfilled = true;
      }
    }
    // The no-change save below is gated on a fixed list of triggers, and
    // adoption trips none of them (issue #2934). Without this, a deploy whose
    // diff comes out entirely clean persists neither the resource the pre-pass
    // spliced in nor the record it consumed — so the stack keeps paying an
    // AWS existence read every run, forever, and `cdkd destroy` cannot delete
    // a resource that never reached the persisted `resources`.
    // Compared by COUNT, not by reference: `plan.remaining` is always a
    // fresh array, so identity would report a change on every deploy of a
    // stack that merely HOLDS a record — an S3 PUT and a `lastModified` bump
    // per run, forever, for a set that never moved. A count suffices because
    // the pre-pass only ADOPTS (which also lands in `plan.adopted`) or DROPS;
    // it never edits a kept record in place, so the two disjuncts below cover
    // every way the set can move.
    const orphansChanged =
      Object.keys(orphanPlan.adopted).length > 0 ||
      (currentState.orphans ?? []).length !== orphanCountBeforeAdoption;

    const { dag, executionLevels } = validateAndBuildGraph(engine, {
      currentState,
      effectiveTemplate,
    });

    // Each row whose child holds such a name updates, so its child's engine
    // runs. The mark is written by this deploy's successful save only when
    // every recorded child was read (an adopted nested row's was not).
    const nestedCheck = await nestedSsmCheck;
    for (const row of nestedCheck?.forcedRows ?? []) engine.logger.info(nestedSsmNameRowNote(row));
    const marksNestedCheck =
      nestedCheck?.complete === true &&
      !Object.values(orphanPlan.adopted).some(
        (r) => r.resourceType === 'AWS::CloudFormation::Stack'
      );
    const { diffResolverContext, maskedInputs, changes } = await calculateDeployDiff(engine, {
      stackName,
      currentState,
      effectiveTemplate,
      parameterValues,
      conditions,
      clock,
      forcedNestedChildRuns: nestedCheck?.forcedRows,
    });
    clock.lap('diff');
    // The diff was the prefetch's only consumer: withdraw what it did not
    // need, so it stops spending the account's DescribeType quota that the
    // deploy's own (write-only) lookups draw on.
    createOnlyPrefetch.cancel();
    // The re-baselined records, before anything provisions: an UPDATE row then
    // compares its provisioning-time inputs with today's, and the no-change
    // save below persists the rest.
    for (const [logicalId, fingerprints] of maskedInputs?.rebaselined ?? []) {
      const record = currentState.resources[logicalId];
      if (record === undefined) continue;
      currentState.resources[logicalId] = withRebaselinedFingerprints(record, fingerprints);
      maskedFingerprintsBackfilled = true;
    }

    await refuseUnsafePlan(engine, {
      stackName,
      ssmNameHeals,
      currentState,
      effectiveTemplate,
      parameterValues,
      conditions,
      changes,
      diffResolverContext,
    });

    // The first deploy's state gate (above), before any branch acts on the plan.
    if (firstDeployStateGate !== undefined) {
      const gate = firstDeployStateGate;
      firstDeployStateGate = undefined;
      await gate;
    }
    // State schema v13 (go-to-k/cdkd#5064): a stack with no record gets its
    // stack instance id at its first state write -- the one an earlier,
    // interrupted run wrote ahead, or a fresh one written ahead -- under the
    // lock, before the first save and the first create, and only once the
    // deploy is going ahead (past the gate, the destructive-plan check and
    // `--require-approval`), so a refused or declined deploy writes nothing.
    // It rides `currentState`, so every save of this deploy (the partial save
    // of a failure included) carries it through `stackInstanceIdCarriedFrom`.
    // A stack WITH a record never reaches here: an ordinary deploy pays
    // nothing, and a legacy record stays legacy. `--dry-run` writes nothing.
    const resolveStackInstanceId = async (): Promise<void> => {
      if (currentStateData !== null && currentStateData !== undefined) return;
      if (engine.options.dryRun || currentState.stackInstanceId !== undefined) return;
      const id = await engine.stateBackend.stackInstanceIdForFirstWrite(
        stackName,
        engine.stackRegion,
        { writeAhead: true, ...(firstDeployIdentity && { candidate: firstDeployIdentity }) }
      );
      // The plan resolved `AWS::StackId` from `firstDeployIdentity`; a
      // different id here would send creates a value the plan never showed.
      // Under the lock only this deploy writes the sibling, so this is a
      // concurrent writer outside the lock.
      if (firstDeployIdentity !== undefined && id !== firstDeployIdentity.stackInstanceId) {
        throw new StateError(
          `The write-ahead stack instance id of stack ${displayStackName(stackName)} changed ` +
            'while this deploy was planning. Nothing was created; re-run the deploy.'
        );
      }
      currentState.stackInstanceId = id;
      // State schema v16 (go-to-k/cdkd#6170): a stack born here takes its
      // `AWS::StackId` tail from this id, and so does a re-run of one whose
      // write-ahead recorded the flag; a re-run of an older binary's first
      // deploy (a version 1 sibling) keeps `cdkd`, the tail its creates used.
      if (firstDeployIdentity?.stackIdFromInstance ?? true) {
        currentState.stackIdFromInstance = true;
      }
    };
    // State schema v12 (go-to-k/cdkd#4847 / #4852): the one-time migration
    // capture of each unchanged record that holds a token and no provenance,
    // OFF the critical path (drained with the observed captures before a
    // save). Started once the change map is final (a recreate target is no
    // longer NO_CHANGE) and, on the change path, past `--require-approval`, so
    // a refused or declined deploy spends no lookup. A token-free stack never
    // enters it; `--dry-run` saves nothing.
    const startProvenanceCapture = (): void => {
      if (engine.options.dryRun || isKnownTokenFreeState(currentStateData?.state)) return;
      engine.provenanceCapture.kickOffProvenanceCapture({
        noChange: engine.diffCalculator
          .filterByType(changes, 'NO_CHANGE')
          .map((change) => change.logicalId),
        resources: currentState.resources,
        template: effectiveTemplate,
        parameters: parameterValues,
        conditions,
        stackName,
      });
    };
    const hasChanges = engine.diffCalculator.hasChanges(changes);

    clock.lap('post-diff checks');
    if (!hasChanges) {
      if (marksNestedCheck) currentState.nestedSsmNamesChecked = true;
      return await deployWithoutChanges(engine, {
        stackName,
        template,
        currentState,
        currentEtag,
        effectiveTemplate,
        outputsDigestSource,
        parameterValues,
        conditions,
        conditionVerdicts,
        migrationPending,
        maskedFingerprintsBackfilled,
        orphansChanged,
        terminationProtectionChanged,
        ssmNamesHealed: ssmNameHeals.length > 0,
        nestedSsmNamesMarked: marksNestedCheck,
        resolveStackInstanceId,
        startProvenanceCapture,
        startTime,
        clock,
      });
    }

    // Log changes summary
    const createChanges = engine.diffCalculator.filterByType(changes, 'CREATE');
    const updateChanges = engine.diffCalculator.filterByType(changes, 'UPDATE');
    const deleteChanges = engine.diffCalculator.filterByType(changes, 'DELETE');

    engine.logger.info(
      safeMsg`Changes: ${green(createChanges.length)} to create, ${yellow(updateChanges.length)} to update, ${red(deleteChanges.length)} to delete`
    );

    if (engine.options.dryRun) {
      engine.logger.info('Dry run mode - skipping actual deployment');
      return {
        stackName,
        created: createChanges.length,
        updated: updateChanges.length,
        deleted: deleteChanges.length,
        // A dry run issues no provider call, so nothing can be skipped.
        deleteSkipped: 0,
        updatePartial: 0,
        unchanged: engine.diffCalculator.filterByType(changes, 'NO_CHANGE').length,
        durationMs: Date.now() - startTime,
        attributeFallbackCount: engine.resolver.getPhysicalIdFallbackCount(),
      };
    }

    await prepareChangeExecution(engine, {
      stackName,
      currentState,
      effectiveTemplate,
      parameterValues,
      changes,
      diffResolverContext,
      idArrivesLater,
      nameScope,
      retainedAtFirstDeploy,
      retainedForWarning,
      resolveStackInstanceId,
      startProvenanceCapture,
      clock,
    });

    // Progress counter for tracking overall deployment progress
    const totalOperations = createChanges.length + updateChanges.length + deleteChanges.length;
    const progress = { current: 0, total: totalOperations };

    clock.lap('first-deploy instance id, name guard');
    // 6. Execute deployment (event-driven DAG dispatch with partial state saves)
    const {
      state: newState,
      actualCounts,
      completedOperations,
    } = await withProducerRegions(
      // go-to-k/cdkd#4174: for the child engine a nested-stack row builds.
      () => producerRegionEvidence(engine.rollbackDeps(), currentState),
      () =>
        withStackScope(nameScope(), () =>
          executeDeployment(
            engine,
            effectiveTemplate,
            currentState,
            changes,
            dag,
            executionLevels,
            stackName,
            outputsDigestSource,
            parameterValues,
            conditions,
            currentEtag,
            progress,
            migrationPending
          )
        )
    );
    clock.lap('resource DAG');

    // 7a. Drain in-flight readCurrentState promises so each resource's
    // observedProperties lands in newState before we persist it. By
    // this point the deploy critical path is over, so awaiting the
    // remaining captures only adds the longest still-pending read
    // (typically <300ms in practice for medium stacks; see PR notes).
    // The state save, the ledger and the events flush below share the state
    // backend's client; open its connections now, beside the drain (#4837).
    // A dry run returned before this point.
    try {
      void engine.stateBackend.warmConnections(
        stackName,
        engine.stackRegion,
        TAIL_WARM_CONNECTIONS
      );
    } catch {
      // Best-effort: never in the way of the save it serves.
    }
    await engine.observedCapture.drainObservedCaptures(newState.resources);
    clock.lap('observed-state drain');
    // A row updated for the check marks this record only once its child's
    // own check is done too (its record is marked, or it has no nested row).
    if (
      marksNestedCheck &&
      (await forcedChildrenChecked({
        forcedRows: nestedCheck?.forcedRows ?? new Set(),
        stackName,
        region: engine.stackRegion,
        nestedTemplates: getCurrentNestedStackContext()?.nestedTemplates,
        readRecord: async (name, region) =>
          (await engine.stateBackend.getState(name, region))?.state,
      }))
    ) {
      newState.nestedSsmNamesChecked = true;
    }

    // A part the drain cap stopped waiting for can record its secret after
    // the outputs pass redacted `newState.outputs`, and the drain above is
    // a real wait (issue #2814). The save below needs nothing extra for
    // it: `withParentInfo` redacts the outputs again, and `redactOutputs`
    // re-reads the pass map first. The exports index and the deploy
    // summary read `newState` after the save's own await, so each redacts
    // it again at that moment, against the recordings available then. That
    // is not a promise they equal the saved copy: a record arriving during
    // the save's await reaches them, while the save had already taken its
    // copy.

    // 7b. Save final state (ETag may have been updated by partial saves).
    // The legacy migration delete (when migrationPending) was already done by
    // the first per-resource save inside executeDeployment, so this final
    // save is unconditionally region-scoped.
    // go-to-k/cdkd#4705 review H-1/(g): what this deploy kept is recorded in
    // one write beside it (disjoint objects). A crash leaving either alone is
    // the documented residual: unrecorded, its re-create is refused with the
    // `cdkd import` remedy.
    const [newEtag] = await Promise.all([
      engine.stateBackend.saveState(
        stackName,
        engine.stackRegion,
        // The record joins here, on the save that ends a successful deploy
        // (go-to-k/cdkd#4479): `executeDeployment` builds its states field by
        // field, so none of its saves carries it.
        engine.withParentInfo(conditionVerdicts ? { ...newState, conditionVerdicts } : newState),
        {
          deferCleanup: (cleanup) => {
            finalSaveCleanup = cleanup;
          },
        }
      ),
      flushKeptForReadoption(engine),
    ]);
    engine.logger.debug(safeMsg`State saved (ETag: ${newEtag})`);
    clock.lap('final state save');
    return await settleSuccessfulDeploy(engine, {
      stackName,
      template,
      currentState,
      currentEtag,
      changes,
      newState,
      actualCounts,
      completedOperations,
      finalSaveCleanup,
      startTime,
      clock,
    });
  } catch (error) {
    failed = true;
    // G-6: the overlapped gate's refusal outranks an error from its window.
    if (firstDeployStateGate !== undefined) await firstDeployStateGate;
    throw error;
  } finally {
    // Stop live renderer (clears any remaining in-flight task display).
    //
    // Guarded for the same reason `start()` moved inside the `try` above
    // (issue #2171): `stop()` writes to stdout, and it is the FIRST statement
    // of the `finally` that releases the lock — a throw here would abort the
    // teardown before `releaseLock` and re-open the strand one line later.
    try {
      renderer.stop();
    } catch {
      // Deliberately silent: the whole point is that the stdout channel is
      // failing, so logging the failure through it is another throw on the
      // same pre-`releaseLock` path.
    }

    // Remove SIGINT handler.
    //
    // This unregisters BEFORE the lock release further down, which is the
    // ordering `destroy-runner.ts` (issues #2053 / #1952) and `rollback.ts`
    // (issue #2118) were both corrected AWAY from — so the last remaining
    // instance owes an explanation. It is safe HERE for a reason neither of those had:
    // `deploy.ts` registers its own top-level SIGINT handler that outlives
    // this whole method, so the process is never left with zero listeners
    // while the lock is held. `destroy.ts` / `state.ts` register none, which
    // is exactly why the same shape was a stranded lock there.
    //
    // If that top-level handler is ever removed or made conditional, this
    // block has to be reordered to release first.
    process.removeListener('SIGINT', sigintHandler);

    // On a rollback / SIGINT exit we may leave in-flight readCurrentState
    // promises in the map (the success path drains them above). Clear the
    // map to drop the references now (the next `deploy()` replaces the whole
    // capture anyway). The underlying promises already have a `.catch` so
    // dropping the references will not produce an unhandled rejection.
    engine.observedCapture.observedCaptureTasks.clear();

    // go-to-k/cdkd#4705: under the lock, drop the name-adopting intents whose
    // create was not sent or came back. Guarded like every step before
    // `releaseLock`.
    try {
      // A deploy that failed after keeping something still records it (a
      // no-op once the success path flushed).
      await flushKeptForReadoption(engine);
      await engine.generatedNameGuard?.settle();
    } catch {
      // Both warn on their own failures.
    }
    // What step 1b started -- the journal purge and the exports index read --
    // finishes before the lock goes and before the caller destroys the
    // client, on every path, not only the success settle that awaits the
    // purge. Neither rejects.
    await Promise.all([engine.absentJournalVersionPurge, exportsPrefetch, finalSaveCleanup]);

    // go-to-k/cdkd#4705: a first deploy that failed and left nothing that can
    // own a resource -- no record, and no rollback journal holding a completed
    // operation or a failed one with a physical id (the cross-prefix
    // classification, `journalCanOwnResources`) -- releases the registry
    // marker it claimed (or found naming this prefix), under the lock, so "a
    // marker exists" keeps meaning "this prefix can own the stack's
    // resources". Anything it did leave keeps the marker; a read that fails
    // keeps it too (fail closed). Best-effort.
    if (
      firstDeploy &&
      failed &&
      engine.options.onFirstDeployLeftNoRecord &&
      !engine.options.dryRun
    ) {
      try {
        const left = await engine.stateBackend.getState(stackName, engine.stackRegion);
        const journal =
          left === null
            ? await engine.stateBackend.loadRollbackJournal(stackName, engine.stackRegion)
            : undefined;
        if (left === null && !journalCanOwnResources(journal ?? null)) {
          await engine.options.onFirstDeployLeftNoRecord(stackName);
        }
      } catch (error) {
        engine.logger.debug(
          safeMsg`Could not check whether the failed first deploy left a record: ${describeAwsFailure(error).summary}`
        );
      }
    }

    // Always release lock
    try {
      await engine.lockManager.releaseLock(stackName, engine.stackRegion);
      engine.logger.debug('Lock released');
    } catch (lockError) {
      engine.logger.warn(
        safeMsg`Failed to release lock: ${asIsMessage(describeAwsFailure(lockError).detail)}`
      );
    }
    clock.lap('teardown + lock release');
  }
}
