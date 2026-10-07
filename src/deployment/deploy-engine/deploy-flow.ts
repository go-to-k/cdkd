import { freshNoEchoParametersWithDeclared } from './noecho.js';
import { type DeployEngine, crossStackReadsForPartialSave } from '../deploy-engine.js';
import { skippedOutputsEqual } from '../../analyzer/skipped-outputs.js';
import { makeCanonicalizePropertiesFn } from '../../provisioning/canonicalize-properties.js';
import type { CreateOnlyPrefetch } from '../../provisioning/create-only-properties.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedOutputs,
  refuseMalformedResourceEntriesForDeploy,
  refuseMalformedResourceProperties,
  refuseMalformedResourcesForDeploy,
} from '../../state/malformed-resources-bag.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type StackState,
  exportNamesCarriedFrom,
  importableOutputKeys,
  importableOutputs,
  orphansCarriedFrom,
} from '../../types/state.js';
import { green, red, yellow } from '../../utils/colors.js';
import { displayStackName, safeMsg } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import type { DeployResult } from './options.js';
import { outputMapsEqual } from '../deploy-value-equality.js';
import { withSharedDrainBudget } from '../drain-budget.js';
import { NESTED_PENDING_PARENT_REASON } from '../nested-child-journal.js';
import {
  type NoChangeOutputsMerge,
  bagHoldsSecretExpression,
  keptWholeReasonText,
  mergeNoChangeOutputs,
} from '../no-change-outputs-merge.js';
import { refuseNoValueOutputs } from '../output-value-preflight.js';
import {
  isNoEchoPromotionOnly,
  requireDeploymentApproval,
  requireOutputsOnlyApproval,
} from '../deployment-approval.js';
import {
  buildConditionVerdictRecord,
  conditionInputsFrom,
  conditionVerdictRecordsEqual,
  conditionsReadByDiff,
  deployConditionInputs,
  parentSuppliedValues,
  readRecordedConditionVerdicts,
} from '../condition-verdicts.js';
import {
  backfillMaskedPropertyFingerprints,
  parameterInputsFor,
  withRebaselinedFingerprints,
} from '../masked-property-fingerprints.js';
import { childTemplateLoader } from '../nested-output-templates.js';
import { noEchoParameterValueSeed } from '../outputs-export-alias.js';
import { getCurrentNestedStackContext } from '../../provisioning/nested-stack-context.js';
import { withProducerRegions } from '../producer-regions-scope.js';
import { promoteRecreateTargets, recreateTargetIdsFor } from '../recreate-target-promotion.js';
import { refuseStatefulReplacedReaders } from '../recreate-target-readers.js';
import { markNonRetryable } from '../retryable-errors.js';
import { hasMaskableValues, passedNoEchoParametersOf } from '../secret-redaction.js';
import {
  findNestedStackTypeChanges,
  renderNestedStackTypeChangeRefusal,
} from '../type-change-guard.js';
import {
  forgetRecordedCreateTokens,
  noteDeployStateRecord,
} from '../../provisioning/providers/create-token-ledger.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    doDeployWithPrefetch: OmitThisParameter<typeof doDeployWithPrefetch>;
  }
}

export async function doDeployWithPrefetch(
  this: DeployEngine,
  stackName: string,
  template: CloudFormationTemplate,
  createOnlyPrefetch: CreateOnlyPrefetch
): Promise<DeployResult> {
  const startTime = Date.now();
  this.logger.debug(`Starting deployment for stack: ${stackName}`);

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
  this.interrupted = false;
  this.interruptCause = null;
  const sigintHandler = () => {
    // Route the interrupt notice through the live renderer so it does not
    // collide with the in-flight task display.
    renderer.printAbove(() => {
      process.stderr.write(
        '\nInterrupted — saving partial state after current operations complete...\n'
      );
    });
    this.interrupted = true;
    this.interruptCause ??= 'user';
  };
  process.on('SIGINT', sigintHandler);

  // Acquire lock with retry (retries up to 3 times with 2s delay for transient lock conflicts)
  try {
    await this.lockManager.acquireLockWithRetry(stackName, this.stackRegion, undefined, 'deploy');
  } catch (error) {
    // The try/finally that owns the listener removal starts below — clean
    // up here so an acquire failure does not leak the handler.
    process.removeListener('SIGINT', sigintHandler);
    throw error;
  }

  try {
    // Started INSIDE this `try` (issue #2171): `start()` writes to stdout and
    // can throw (EPIPE on `cdkd deploy | head`), and it sits AFTER the lock
    // acquisition, so a throw outside would strand the lock for its full TTL.
    // This is the same move issue #2161 made in `destroy-runner.ts`; the two
    // commands had the identical shape and only one of them was fixed.
    renderer.start();

    // 1. Load current state
    const currentStateData = await this.stateBackend.getState(stackName, this.stackRegion);
    // The create-token ledger replaces one that outlived its state record
    // (go-to-k/cdkd#4438).
    noteDeployStateRecord(currentStateData?.state !== undefined);
    const currentState: StackState = currentStateData?.state ?? {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: this.stackRegion,
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
    this.healBaseline = currentState.resources ?? {};
    // AT THE LOAD, and REFUSE rather than repair (issue #3207). `deploy` is
    // the most write-capable consumer of this bag there is: the no-change
    // merge path below carries `currentState.outputs ?? {}` into
    // `persistedOutputs` and SAVES it, five failure-path saves write
    // `outputs: currentState.outputs` verbatim, and the next success
    // republishes the result into `cdkd/_index/<region>/exports.json` — the
    // namespace every other stack's `Fn::ImportValue` binds against. So a
    // string bag is rebuilt into a well-formed map of one fabricated export
    // per CHARACTER and the only signal the record was damaged is gone
    // permanently: the laundering go-to-k/cdkd#3192 exists to stop.
    //
    // Here rather than at the twelve later reads because every one of them is
    // dominated by this point, which is the placement rule
    // `repairMalformedResourcesForReadOnly`'s own note records: a per-walk
    // `?? {}` is inert for this class, since each flow dereferences the
    // container a line earlier.
    refuseMalformedOutputs(currentState, stackName, this.stackRegion, this.options.refusalRecovery);
    // And the `resources` bag, a SEPARATE container with a separate absence
    // rule, refused separately so the message names the one that is broken
    // (issue go-to-k/cdkd#3161).
    //
    // The gap go-to-k/cdkd#3317 measured and left: it closed the per-ENTRY
    // `properties` map at `DiffCalculator.calculateDiff`, and that
    // predicate returns `[]` for a record whose ROOT bag is itself
    // unreadable — so `"resources": "abcdef"` still reached the diff and
    // enumerated two fabricated logical ids, while a `[]` or a `5`
    // enumerated none and planned every template resource as a CREATE,
    // re-provisioning a stack that already exists.
    //
    // HERE rather than at `calculateDiff`, although that is the chokepoint
    // both diff callers share: this load DOMINATES the call and the reads
    // between them, the first of which is the `Object.keys(...)` debug line
    // immediately below — where a `null` bag raised the bare `TypeError`
    // go-to-k/cdkd#3018 exists to remove. `cdkd diff` keeps its repair-and-warn
    // half at its own load, so the preview this refusal points at still works.
    refuseMalformedResourcesForDeploy(
      currentState,
      stackName,
      this.stackRegion,
      this.options.refusalRecovery
    );
    // And each ROW of that bag (go-to-k/cdkd#3314). A `null` or typeless row
    // reads as absent in the diff and is planned as a CREATE of a resource
    // this stack already manages. `calculateDiff` refuses it too, but two
    // walks run before the diff and each died on the row first, with a bare
    // `TypeError`: the CLI's prefix-migration gate (`onCurrentStateLoaded`
    // below) and the observed-state auto-refresh. The load dominates both.
    // It does not dominate the CLI's PRE-lock `--recreate-via-*` check, which
    // reads the named rows itself (go-to-k/cdkd#3202 owns that site).
    refuseMalformedResourceEntriesForDeploy(
      currentState,
      stackName,
      this.stackRegion,
      this.options.refusalRecovery
    );
    // And each row's `properties` MAP (go-to-k/cdkd#3211), BELOW the row guard,
    // which names a typeless row with a torn map more precisely. `calculateDiff`
    // refuses it too, but the observed-state auto-refresh below hands the map
    // to `provider.readCurrentState` first, and the walks between here and the
    // diff read it. The load dominates every one of them.
    refuseMalformedResourceProperties(
      currentState,
      stackName,
      this.stackRegion,
      this.options.refusalRecovery
    );
    // The `orphans` CONTAINER, beside it and for the same placement reason
    // (go-to-k/cdkd#3379): the adoption pass below reads it on a bare `?? []`
    // and ASSIGNS `currentState.orphans` from what it read, so an unreadable
    // container is rewritten by a writer. AFTER the lock, so the guarantee is
    // "before any resource operation" rather than "before any lock".
    refuseMalformedOrphans(currentState, stackName, this.stackRegion, this.options.refusalRecovery);
    // The ROWS of a readable list (go-to-k/cdkd#3500). Its own call because
    // the questions are independent: the adoption pass below dereferences
    // each row's `state`, and `orphansAfterRollback` keys its merge map on
    // each row's `logicalId`, so a list that IS a list can still abort the
    // run, or collapse the rows MISSING a `logicalId` into one saved survivor.
    refuseMalformedOrphanRecords(
      currentState,
      stackName,
      this.stackRegion,
      this.options.refusalRecovery
    );
    // Set when we loaded a `version: 1` legacy record. The next save
    // migrates it to the new key.
    const migrationPending = currentStateData?.migrationPending ?? false;

    this.logger.debug(
      `Loaded current state: ${Object.keys(currentState.resources).length} resources`
    );

    // 1a-pre. Pre-provisioning gate. Runs before the journal note, the
    // observed-properties refresh, parsing, the diff and every provider
    // call — so a caller that declines here has changed nothing. Reuses
    // the state read just performed instead of making the CLI issue its
    // own pre-lock GET of the same object.
    if (this.options.onCurrentStateLoaded) {
      await this.options.onCurrentStateLoaded(stackName, currentStateData?.state);
    }

    // 1b. If a rollback journal exists, a previous deploy failed / was
    // interrupted and has not yet been reverted (issue #1183). Note that
    // `cdkd rollback` can revert it; the deploy proceeds (fix-forward is
    // still supported). Best-effort — a journal read failure must not
    // block the deploy.
    try {
      const loaded = await this.stateBackend.loadRollbackJournal(stackName, this.stackRegion);
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
        this.logger.info(
          failedOnly
            ? `A previous deploy of ${displayStackName(stackName)} failed and was automatically rolled back. ` +
                `The failed resource may be partially applied — revert it, or continue ` +
                `deploying to fix forward (${
                  // Issue #3754: a nested child's journal is cleared by its
                  // TOP-LEVEL stack's success, not by its own.
                  this.options.parentStackInfo
                    ? 'a successful deploy of the top-level stack clears this note'
                    : 'a successful deploy clears this note'
                }).` +
                `\nRevert it with: ${
                  pasteableCommand('cdkd rollback', [
                    { value: stackName, hole: 'stack' },
                    { literal: '--revert-failed' },
                  ]).command
                }`
            : `A previous deploy of ${displayStackName(stackName)} failed or was interrupted. Revert it, ` +
                `or continue deploying to fix forward.` +
                `\nRevert it with: ${
                  pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack' }]).command
                }`
        );
      }
    } catch {
      // ignore — journal is advisory here
    }

    // 1-pre. Issue #3468: read every REASON-LESS baseline refusal before
    // anything in this deploy can take a readback. See the method's doc.
    this.stampReasonlessParameterRefusals(currentState.resources, template);
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
    this.kickOffAutoRefreshObservedProperties(currentState.resources, currentState);

    // 2. Template parsing is handled by DagBuilder (dependency analysis) and
    // IntrinsicResolver (intrinsic function resolution) in later steps
    this.logger.debug(`Template has ${Object.keys(template.Resources || {}).length} resources`);

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

    // 2.5. Resolve parameters from template and user input
    // The inherited bag travels into `resolveParameters` as well as into the
    // per-resource contexts below (issue #1903 review round 2). This is the
    // seam where the PARENT's already-decrypted values first enter the child
    // engine, so it is where both the `--verbose` parameter lines are masked
    // and where a declared `Type` that would coerce the value out of cdkd's
    // string-keyed redaction model is refused.
    const parameterValues = await this.resolver.resolveParameters(
      template,
      this.options.parameters,
      {
        // `hasMaskableValues` (go-to-k/cdkd#1998): only the `--verbose`
        // lines read a bag holding log-only needles alone here; the
        // coercion refusal asks `size` itself.
        ...(this.options.inheritedSecrets &&
          hasMaskableValues(this.options.inheritedSecrets) && {
            inheritedSecrets: this.options.inheritedSecrets,
          }),
      }
    );
    this.logger.debug(
      `Resolved ${Object.keys(parameterValues).length} parameters: ${Object.keys(parameterValues).join(', ')}`
    );
    // go-to-k/cdkd#4043 (review round 9): a nested child positions each
    // parameter carrying its parent's `NoEcho` value as a `NoEcho` one, from
    // here on (every save, the journal, the outputs pass).
    this.inheritedNoEchoParameters = new Set([
      ...(this.freshNoEchoParameters(parameterValues) ?? []),
      ...(passedNoEchoParametersOf(this.options.inheritedSecrets) ?? []),
    ]);
    // go-to-k/cdkd#4451: a masked property with no fingerprint (every one an
    // older cdkd recorded) takes today's template's, which is what this
    // deploy's unchanged comparison concludes AWS holds anyway, so the deploy
    // sends what it sent before and the next edit is seen. Saved by the
    // no-change path too. After the parameters, so a template literal equal to
    // a `NoEcho` parameter's value is refused a hash here rather than
    // persisted; before the diff and the orphan adoption, which read it.
    const backfillNoEchoValues = noEchoParameterValueSeed(
      template.Parameters,
      parameterValues,
      this.options.inheritedSecrets,
      this.options.parameters
    );
    // The save reads the same corpus for a record it stamps or carries.
    this.fingerprintNoEchoValues = backfillNoEchoValues;
    // go-to-k/cdkd#4543: how each parameter enters a masked property's INPUT
    // fingerprint, decided once from the REAL values so the diff pass (which
    // binds a nested child's redacted bag) and the provisioning arms agree.
    this.fingerprintParameters = parameterInputsFor({
      template,
      values: parameterValues,
      nestedChild: this.options.parentStackInfo !== undefined,
      supplied: this.options.parameters,
      passedClasses: this.options.passedParameterClasses,
    });
    // go-to-k/cdkd#4565: the nested-stack templates one level below this
    // stack, from the assembly the surrounding nested-stack context carries
    // (the top-level run's `StackInfo.nestedTemplates`, or the provider's
    // index for a child). The loader is built once here, never from inside a
    // fingerprint walk; each file is read on first use and cached for the
    // rest of this deploy.
    this.fingerprintChildTemplates = childTemplateLoader(
      getCurrentNestedStackContext()?.nestedTemplates
    );
    let maskedFingerprintsBackfilled =
      backfillMaskedPropertyFingerprints(currentState.resources, template, backfillNoEchoValues) >
      0;

    // 2.6. Evaluate conditions from template
    const context = this.buildResolverContext(
      {
        template,
        resources: currentState.resources,
        parameters: parameterValues,
      },
      stackName
    );
    const conditions = await this.resolver.evaluateConditions(context);
    this.logger.debug(
      `Evaluated ${Object.keys(conditions).length} conditions: ${Object.keys(conditions).join(', ')}`
    );
    // CloudFormation rejects an Output whose Value evaluates to
    // AWS::NoValue before it creates anything (issue #4077), so refuse it
    // here, before provisioning, rather than publishing nothing after it.
    refuseNoValueOutputs(template.Outputs, conditions);
    // go-to-k/cdkd#4479: the verdicts `cdkd diff` cannot compute (a condition
    // over a parameter a nested child received from a secret), each with the
    // fingerprint the diff must recompute to reuse it. Persisted by the final
    // save and the no-change save below; the other saves of a deploy rebuild
    // state without it, so a failed or interrupted deploy leaves NO record and
    // the next diff falls back to the FALSE branch, never a stale verdict.
    // Skipped when the template has no condition the diff reads: the token
    // derivation redacts every parameter value, which a child with no such
    // condition does not need.
    let conditionVerdicts: ReturnType<typeof buildConditionVerdictRecord>;
    if (conditionsReadByDiff(template, conditions).size > 0) {
      // A parameter the resolver would serve from a STATE resource of the same
      // logical id (`Ref` checks resources first) is no input.
      const { tokens, unavailable } = deployConditionInputs(
        parameterValues,
        this.options.inheritedSecrets,
        new Set(Object.keys(currentState.resources))
      );
      // A plain value the parent supplied is no input either: the inherited
      // corpus can miss a short ancestor secret embedded in it.
      for (const name of parentSuppliedValues(
        template,
        this.options.parameters,
        new Set(Object.keys(tokens))
      )) {
        unavailable.add(name);
      }
      conditionVerdicts = buildConditionVerdictRecord(
        template,
        conditions,
        conditionInputsFrom({ tokens, bound: parameterValues, unavailable })
      );
    }

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
    const effectiveTemplate = this.templateParser.filterResourcesByCondition(template, conditions);
    // Every save from here on stamps each record's construct path from it.
    this.constructPathTemplate = effectiveTemplate;
    // go-to-k/cdkd#4043: the positional `NoEcho` arm opens only the `Fn::If`
    // branch this deploy selected, and reads the previous records' declared
    // `NoEcho` attributes (go-to-k/cdkd#2449).
    this.noEchoConditions = conditions;
    this.seedPersistedNoEchoAttributes(currentState.resources);

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
    const orphanPlan = await this.adoptRollbackOrphans(currentState, effectiveTemplate);
    // Issue #3468: an adopted record entered `resources` AFTER the deploy-start
    // stamp. No writer produces a marked orphan record today; re-reading here
    // keeps that from becoming load-bearing. Idempotent, and handed the same
    // `template` object as the first pass.
    if (Object.keys(orphanPlan.adopted).length > 0) {
      this.stampReasonlessParameterRefusals(currentState.resources, template);
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

    // 3. Validate resource types (before deployment starts)
    // Skip metadata resources as they don't actually deploy
    const resourceTypes = new Set(
      Object.values(effectiveTemplate.Resources || {})
        .map((r) => r.Type)
        .filter((type) => type !== 'AWS::CDK::Metadata')
    );
    this.providerRegistry.validateResourceTypes(resourceTypes);
    this.logger.debug(`All resource types validated`);

    // 3.5. Report top-level resource property routing decisions
    // (#614). For each resource using a silent-drop top-level property,
    // info-log that cdkd is auto-routing it via Cloud Control (which
    // forwards the full property map). For each resource explicitly
    // opted out via `--allow-unsupported-properties Type:Prop`, warn
    // that the silent drop has been accepted. Neither of those throws —
    // the legacy PR #608 fail-fast was reversed by #614 to a default-on
    // auto-route — but this step CAN still refuse, and the comment said
    // it could not until issue #3028. A drop on a type the Cloud Control
    // route cannot serve (`hasNoCloudControlHandlers`, or a provider declaring
    // `disableCcApiFallback`) has nowhere to be auto-routed, so
    // `ProviderRegistry.reportSilentDropDecisions` throws rather than
    // letting the route fail later with an opaque error. That refusal
    // lands HERE — ahead of the DAG at step 4 and the diff at step 5 —
    // so the deploy ends having provisioned nothing. Skips
    // AWS::CDK::Metadata (filtered by the same predicate as the type
    // set).
    const resourcesForPropertyCheck = Object.entries(effectiveTemplate.Resources || {})
      .filter(([, r]) => r.Type !== 'AWS::CDK::Metadata')
      .map(([logicalId, r]) => ({
        logicalId,
        resourceType: r.Type,
        properties: r.Properties,
        // Thread the state-recorded routing layer so already-sticky CC
        // resources demote the info-log to debug (avoids "routing via
        // Cloud Control API" repeated on every redeploy).
        provisionedBy: currentState.resources[logicalId]?.provisionedBy,
        // The baseline an unrecognized property is compared against, so the
        // routing lines describe the route `getProviderFor` takes (#3713).
        previousProperties: currentState.resources[logicalId]?.properties,
      }));
    this.providerRegistry.validateResourceProperties(resourcesForPropertyCheck);
    this.logger.debug(`All resource properties validated`);

    // 4. Build dependency graph
    const dag = this.dagBuilder.buildGraph(effectiveTemplate);
    const executionLevels = this.dagBuilder.getExecutionLevels(dag);
    this.logger.debug(`Dependency graph: ${executionLevels.length} execution levels`);

    // 5. Calculate diff
    // Pass a best-effort resolver so that changes hidden inside intrinsics (e.g.
    // `Fn::Join` literal args like "-value" -> "-value2") are detected against
    // the already-resolved values stored in state.
    const diffResolverContext = this.buildResolverContext(
      {
        template: effectiveTemplate,
        resources: currentState.resources,
        // The DIFF side binds the REDACTED parameter bag on a nested-stack
        // child (issue #1903). The provisioning contexts below deliberately
        // keep `parameterValues` — the real values are what reach AWS — and
        // so does the condition evaluation above, where substituting an
        // expression would flip an `Fn::Equals` over a parameter. See
        // `redactParametersForDiff`.
        parameters: this.redactParametersForDiff(parameterValues),
        conditions,
      },
      stackName
    );
    // The diff-phase resolution is best-effort (the calculator catches
    // failures and keeps the raw intrinsic): a Ref to a resource this
    // same deploy will CREATE is the expected case, so the resolver logs
    // it at debug, not warn (issue #1017). The provisioning-phase
    // resolver contexts do NOT set this — there, an unresolvable Ref is
    // a genuine error signal.
    diffResolverContext.bestEffort = true;
    // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED for the
    // diff (GHSA fix): state now stores the unresolved expression, so
    // comparing the desired side as its expression too avoids a spurious
    // perpetual UPDATE on every deploy of a secret-bearing resource, and
    // fetches no secret value at plan time. `cdkd diff --recursive` sets the
    // same flag when it resolves a nested child's input `Parameters`
    // (`resolveChildStackParameters`) — as of issue #1903, together with the
    // child-state half that makes the comparison self-consistent; setting it
    // there alone would have compared an expression against a child state
    // still holding plaintext. A changed expression still diffs.
    // An `ssm` reference is classified by the parameter's TYPE rather than by
    // its spelling (issue #1901), so unlike the secretsmanager case the diff
    // DOES issue one `GetParameter` per not-yet-classified reference — with
    // `WithDecryption: false`, so a `SecureString` never yields plaintext
    // here, while a `String` / `StringList` keeps resolving as the public
    // config state stores resolved.
    diffResolverContext.skipDynamicReferences = true;
    const diffResolveFn = (value: unknown) => this.resolver.resolve(value, diffResolverContext);
    const maskedInputSourcesForDiff = this.maskedInputSources(
      effectiveTemplate,
      currentState.resources,
      conditions,
      stackName
    );
    const maskedInputs = maskedInputSourcesForDiff && {
      sources: maskedInputSourcesForDiff,
      rebaselined: new Map<string, Record<string, string>>(),
    };
    const changes = await this.diffCalculator.calculateDiff(
      currentState,
      effectiveTemplate,
      diffResolveFn,
      // Shared with `cdkd diff` (issue #1591): a preview that narrows
      // differently from the apply forecasts a change the deploy will never
      // make, which is this issue's own bug class moved one command over.
      makeCanonicalizePropertiesFn(this.providerRegistry),
      // Issue #2750: the drops THIS deploy opted into via
      // `--allow-unsupported-properties` are not written, so comparing them
      // would report a change the SDK route will never make. `cdkd diff`
      // passes nothing here and that is correct — it registers no such flag,
      // so its preview is of a FLAG-LESS deploy, which is the one that
      // auto-routes and does write the property.
      //
      // Optional call for the TEST DOUBLES only. Many unit files hand-build
      // a registry object literal and cast it in; an unconditional call
      // failed 39 test FILES / 270 cases across `tests/unit/{deployment,cli}`
      // when measured, which is a count of what BROKE, not a survey of the
      // doubles. The sibling `makeCanonicalizePropertiesFn` survives them
      // only because it defers its registry reads into a closure the mocked
      // DiffCalculator never invokes. `undefined` degrades to "no flag",
      // which is what every one of those doubles means. The real class
      // always has the method — `providerRegistry` is typed as the concrete
      // class, so the `undefined` branch is unreachable in production, and
      // the method's existence is pinned directly on `ProviderRegistry` by
      // `provider-registry-report-silent-drops.test.ts`, since a mocked
      // registry cannot witness the real one losing it.
      this.providerRegistry.getAllowedUnsupportedProperties?.(),
      // go-to-k/cdkd#3717: a nested child's parameters carrying a `NoEcho`
      // value the parent supplied in THIS deploy. The diff side binds the
      // redacted bag above, where such a value is `***` like its record, so
      // the calculator promotes each reader instead.
      // go-to-k/cdkd#4043: and EVERY `NoEcho: true` parameter of this
      // template, at every level. Its readers persist `***`, so the diff
      // cannot see a changed value; each is promoted and the engine decides
      // with the value in hand (a readback, or the migration witness).
      // Review round 9: a nested child's parameters its parent fills from a
      // `NoEcho` source too (`inheritedNoEchoParameters`, set above).
      freshNoEchoParametersWithDeclared(this.inheritedNoEchoParameters, effectiveTemplate),
      // go-to-k/cdkd#4049: the diff pass resolves a `Ref` to a `NoEcho`
      // parameter to its plaintext and records it as a log-only needle of
      // THIS context's bag, so the calculator's replacement line masks with
      // it (and with a nested child's inherited bag). Printing only: the
      // changes it returns are unmasked.
      this.diffLogMasker(
        diffResolverContext.recordedSecretValues,
        effectiveTemplate,
        parameterValues
      ),
      // go-to-k/cdkd#4383: a recreate target is destroyed and re-created, so
      // its same-stack readers are promoted as for a property-driven
      // replacement, before anything below counts the changes. This stack's
      // targets only, never a nested child's or another stack's.
      recreateTargetIdsFor(this.options.recreateTargets, stackName),
      // go-to-k/cdkd#4543: a masked property's resolved inputs, so a changed
      // parameter or flipped condition behind unchanged template text diffs.
      // A layout-1 fingerprint whose text still matches is re-baselined to
      // layout 2 from these same inputs, stamped below without sending.
      maskedInputs,
      // go-to-k/cdkd#4159: the account flags the load's refusals above carry.
      this.options.refusalRecovery,
      // go-to-k/cdkd#4043: compare what the persist side writes for a value
      // a `NoEcho` source served, and read a pre-v11 record's plaintext as
      // the migration witness.
      this.noEchoDiffComparison(
        currentState.resources,
        effectiveTemplate,
        conditions,
        parameterValues,
        stackName
      )
    );
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

    // Issue #2668: refuse a Type change into or out of
    // `AWS::CloudFormation::Stack` before anything is provisioned. Every
    // other Type change is replaced normally — the old half routes on the
    // state record's type, the create on the template's — but for this pair
    // correct routing is not sufficient: the replacement's cleanup delete is
    // warn-and-continue, which for a nested row strands a whole child stack.
    // Full reasoning, and why there is no override, in
    // `type-change-guard.ts`.
    //
    // Placed HERE rather than in a CLI pre-flight for two reasons: nested
    // child stacks get their own `DeployEngine` from
    // `NestedStackProvider.runChildDeploy` and never pass through
    // `deploy.ts`, and this is the site that owns the very `changes` map the
    // routing decision is made from, so a pre-flight would have to
    // re-implement the diff's Type-change rule and could drift from it. It
    // is still before every provider call — and before the `--dry-run`
    // return below, so a dry run reports the refusal instead of previewing a
    // plan cdkd will not run. The lock acquired above is released by this
    // block's `finally`.
    const nestedStackTypeChanges = findNestedStackTypeChanges({
      changes,
      stateResources: currentState.resources,
    });
    if (nestedStackTypeChanges.length > 0) {
      // `markNonRetryable` for the same reason as the sibling refusals in
      // this file: the verdict is computed from a state record and a template
      // type, which no retry can change, while the message interpolates
      // TEMPLATE-CONTROLLED text (a logical id, the stack name, both type
      // strings, a physical id) into a string the SUBSTRING-matching
      // classifiers read.
      //
      // LATENT today, and deliberately marked anyway — the #1778 precedent,
      // and the same status `nested-stack-provider.ts` records for its own
      // mark. No claim is made here about WHICH loop would observe it:
      // two successive revisions of this comment named a loop that turned
      // out unreachable, so the honest statement is the one the mark itself
      // makes. `retry.ts` consults `isMarkedNonRetryable` ahead of
      // `opts.isRetryable`, so the DECLARATION survives any caller that
      // later opts back into retrying this path, which a message-only
      // classifier could not.
      throw markNonRetryable(
        new CdkdError(
          renderNestedStackTypeChangeRefusal(nestedStackTypeChanges, stackName),
          'TYPE_CHANGE_NESTED_STACK'
        )
      );
    }

    // Issue #2651: a `--recreate-via-*` target the diff calls NO_CHANGE is
    // still a resource the user named and consented to recreate, and the
    // template not changing is the usual reason to reach for the flag. Make
    // it an UPDATE before anything counts changes, so the dispatch, the
    // summary and `--dry-run` all see it. Before `hasChanges`, which is
    // what turned a run with only such a target into "No changes detected".
    const recreatePromotion = promoteRecreateTargets(
      changes,
      this.options.recreateTargets,
      stackName
    );
    for (const id of recreatePromotion.promoted) {
      this.logger.debug(
        safeMsg`UPDATE (recreate target): ${id} has no template change; recreating it as requested`
      );
    }
    for (const { logicalId, flag, changeType } of recreatePromotion.unreached) {
      this.logger.warn(
        changeType === undefined
          ? safeMsg`${flag} ${logicalId}: not recreated, this deploy has no such resource.`
          : safeMsg`${flag} ${logicalId}: not recreated, this deploy will ${changeType.toLowerCase()} it instead.`
      );
    }

    // go-to-k/cdkd#4383: a stateful resource the recreate would REPLACE (it
    // holds a target in a create-only property) needs
    // `--force-stateful-recreation`, as a stateful target does. Refused HERE,
    // on the condition-evaluated template this diff ran on and before any
    // provider call (and before `--dry-run` returns), rather than by the
    // replacement guard once the target has been destroyed and recreated.
    const ownRecreateTargets = recreateTargetIdsFor(this.options.recreateTargets, stackName);
    if (ownRecreateTargets !== undefined) {
      await refuseStatefulReplacedReaders({
        template: effectiveTemplate,
        state: currentState,
        targetIds: [...ownRecreateTargets],
        conditions,
        forceStatefulRecreation: this.options.forceStatefulRecreation === true,
      });
    }

    const hasChanges = this.diffCalculator.hasChanges(changes);

    if (!hasChanges) {
      this.logger.info('No changes detected. Stack is up to date.');

      // The diff only inspects Resources, so an Outputs-only change (a new
      // Export added because a downstream stack now references this one — its
      // Resources stay identical) lands here with hasChanges=false. If we
      // early-returned without persisting, the new export would never be
      // written to state / the exports index and the consumer's subsequent
      // Fn::ImportValue would fail (issue #875). So in the no-change path we
      // also resolve the template outputs against current state and persist
      // them when they differ — alongside the existing observed-properties
      // refresh (e.g. a v2 → v3 schema upgrade on a stack with nothing to
      // deploy). Both are skipped in dry-run.
      let persistedOutputs: Record<string, unknown> = currentState.outputs ?? {};
      if (!this.options.dryRun) {
        // Resolve against `effectiveTemplate` (condition-pruned) — the same
        // map the executeDeployment path resolves. Outputs reference
        // resources, which come from `currentState.resources` (the arg), and
        // condition pruning only touches `Resources`, so resolving against
        // `effectiveTemplate` vs the raw `template` is equivalent here.
        const resolvedOutputs = this.redactOutputs(
          // One budget for the whole pass, as on the deploy path above.
          await withSharedDrainBudget(() =>
            this.resolveOutputs(
              effectiveTemplate,
              currentState.resources,
              stackName,
              outputsDigestSource,
              parameterValues,
              conditions
            )
          )
        );
        // Drain any auto-refresh readCurrentState calls (drainObservedCaptures
        // short-circuits on an empty map) so the refreshed observed-properties
        // baseline lands in the same save. Drained BEFORE the outputs bag is
        // decided (issue #2771): it is the one await between the outputs pass
        // and the save, and a secret a released outputs-pass part records
        // during it must be visible to the save-time check below.
        const observedRefresh = (await this.drainObservedCaptures(currentState.resources)) > 0;

        // Without `--strict-getatt`, resolveOutputs stores `undefined` for any
        // output it could not resolve (warned about there when the resolver
        // threw, silently when it returned nothing); with the flag it throws
        // for either instead. In the no-change path every resource is
        // already in state so resolution usually succeeds.
        const resolutionFailed = Object.values(resolvedOutputs).some((v) => v === undefined);
        const currentEffectiveExports = new Set(importableOutputKeys(currentState));
        // Issue #2771: when one did not, persist what DID resolve instead of
        // keeping the previous bag whole. A failed key keeps its stored value
        // (the #875 guard: never overwrite a good value with nothing), a key
        // this pass did not produce is removed, and the shapes the merge
        // cannot do safely keep the whole previous bag as before. The rules
        // and the refusals are in `no-change-outputs-merge.ts`.
        let merge: NoChangeOutputsMerge | undefined = resolutionFailed
          ? mergeNoChangeOutputs({
              persisted: persistedOutputs,
              resolved: resolvedOutputs,
              declaredOutputs: effectiveTemplate.Outputs,
              previousExportNames: currentEffectiveExports,
              resolvedExportNames: this.resolvedExportNames,
            })
          : undefined;
        // Today's template may position only the keys THIS pass wrote. The save
        // redacts the bag again (`withParentInfo` -> `redactOutputs`), and
        // `redactByPath` returns a source leaf that is a whole secret expression
        // verbatim — so a carried key, or a whole kept bag, positioned by
        // today's template would be persisted as a reference its stored value
        // never came from. Those keys fall to the value scan instead.
        if (merge?.kind === 'merged') {
          for (const key of merge.carriedKeys) {
            Reflect.deleteProperty(this.outputsTemplateSource, key);
          }
          // The merge's own mixed-generation check read the bag BEFORE this
          // save's redaction, which can still give it a first expression (a
          // needle recorded late, during the drain above). Re-read it as the
          // save will write it. No await separates this check from the
          // save's own redaction below.
          if (
            merge.carriedKeys.length > 0 &&
            !bagHoldsSecretExpression(persistedOutputs) &&
            bagHoldsSecretExpression(this.redactOutputs(merge.outputs))
          ) {
            merge = { kind: 'kept', reason: 'mixed-generation' };
          }
        }
        if (merge?.kind === 'kept') this.outputsSourceUsable = false;
        // The bag and export set this save describes: this pass's when every
        // output resolved, the merge's when one did not, and the previous
        // bag itself when the merge keeps it whole — `undefined` for the set
        // then, because its own set travels with it (below). No separate
        // kept-whole guard on `outputsChanged`: a kept bag IS
        // `persistedOutputs`, so it compares equal by construction.
        const outputsToPersist =
          merge === undefined
            ? resolvedOutputs
            : merge.kind === 'merged'
              ? merge.outputs
              : persistedOutputs;
        const exportNamesToPersist: readonly string[] | undefined =
          merge === undefined
            ? this.resolvedExportNames
            : merge.kind === 'merged'
              ? merge.exportNames
              : undefined;
        const outputsChanged = !outputMapsEqual(persistedOutputs, outputsToPersist);
        // Issue #2193: the EFFECTIVE export set can change without the outputs
        // VALUES changing, and the no-change path is the only place that would
        // persist it. Two shapes reach here with `outputsChanged` false:
        //   - a pre-v9 record (`exportNames` undefined) still feeding the index
        //     every plain Output name — the legacy every-key set differs from
        //     the resolved exports whenever there is a plain name to suppress;
        //   - a SELF-NAMED export toggled on a v9 record: adding
        //     `Export: { Name: <same-as-output-key> }` (or removing it) rewrites
        //     the same key with the same value, so the bag is byte-equal, but
        //     `exportNames` flips between `[]` and `[<key>]`. Without this the
        //     added export never lands in state/index (consumer's Fn::ImportValue
        //     hard-fails), and the removed one is a phantom export served forever.
        // Detect it by comparing the CURRENTLY-effective set against the set
        // this save would write. Subsumes the old pre-v9 backfill and catches
        // both self-named directions. Kept OUT of `outputsChanged` deliberately:
        // this is not an outputs-VALUE change, so it must not flip the
        // "Outputs-only change" log or the bag choice. Never set when the
        // previous bag is kept whole: its own set is carried with it.
        const persistExportSet = new Set(exportNamesToPersist ?? []);
        const exportSetChanged =
          exportNamesToPersist !== undefined &&
          (currentEffectiveExports.size !== persistExportSet.size ||
            [...persistExportSet].some((k) => !currentEffectiveExports.has(k)));

        // Surface the case where outputs DID change but the merge refused and
        // the previous bag was kept whole. resolveOutputs already warns
        // per-output, but a call-site summary makes the "deploy reports
        // no-change yet a new export silently failed to land" path explicit
        // (a downstream Fn::ImportValue would otherwise break later with no
        // obvious link back to this deploy). The merged arm needs no such
        // line: everything that resolved is persisted, an output whose
        // resolver threw already has its own warning, and one whose resolver
        // returned nothing is silent here as it is on every path without
        // `--strict-getatt` (which fails the deploy for it before this
        // point) — the #2740 record still names it.
        if (merge?.kind === 'kept' && !outputMapsEqual(persistedOutputs, resolvedOutputs)) {
          this.logger.warn(
            'Outputs changed but one or more could not be resolved; keeping the previously ' +
              `persisted outputs. ${keptWholeReasonText(merge.reason)} ` +
              'A downstream Fn::ImportValue may fail until the next deploy.'
          );
        } else if (merge?.kind === 'merged' && merge.carriedKeys.length > 0) {
          this.logger.debug(
            `Kept the previously persisted value of ${merge.carriedKeys.length} output key(s), ` +
              'carried export aliases included, that could not be resolved (no-change path, #2771)'
          );
        }

        // Issue #2740: the skipped-outputs record needs its OWN trigger on
        // this path. The shape that produces it — an output failing inside
        // a secret lookup on a stack with no resource diff — lands here
        // with `resolutionFailed` true, and `outputsChanged` /
        // `exportSetChanged` stay false whenever the bag this save would
        // write equals the stored one (the usual case: the skipped key was
        // never stored) or the previous bag is kept whole, so without this
        // the field would never be written for exactly the case it exists
        // for. A difference in either direction saves: a key newly skipped
        // (or its digest moved), or one that resolved / left the template
        // and must be cleared. Also the upgrade path — a record with no
        // field yet whose broken output is skipped again today.
        const skippedOutputsChanged = !skippedOutputsEqual(
          currentState.skippedOutputs,
          this.skippedOutputs
        );

        // Issue #1852: a heal the outputs pass (or the diff pass above) read
        // must reach state even when nothing else changed. Otherwise every
        // later deploy pays the same read again, `cdkd diff` repeats it on
        // every run (its healer is read-only and saves nothing,
        // go-to-k/cdkd#3456), and `cdkd drift`, which re-reads nothing,
        // never sees the attribute at all.
        const healedAttributesPending = this.hasUnpersistedHeals(currentState.resources);

        // go-to-k/cdkd#4479: the record changed (a first record, another
        // verdict, or one to clear) on a run with no resource change, so it is
        // saved here with no provider call; the save below also keeps it
        // through any other refresh. A nested child reaches this only when its
        // engine runs: a parent skips an unchanged nested-stack row, so a child
        // an older binary deployed gains its record on the next deploy that
        // reaches it, not on a plain re-deploy of an unchanged tree.
        const conditionVerdictsChanged = !conditionVerdictRecordsEqual(
          readRecordedConditionVerdicts(currentState),
          conditionVerdicts
        );

        // `--require-approval=any-change` covers an Outputs-only change too,
        // asked before anything below writes it. An export-set change on a
        // record with no `exportNames` (written before v9) is the backfill of
        // that list, not a change the user made: asking there would fail every
        // non-interactive deploy of an unchanged stack.
        if (outputsChanged || (exportSetChanged && currentState.exportNames !== undefined)) {
          await requireOutputsOnlyApproval({ options: this.options, stackName });
        }

        if (
          observedRefresh ||
          maskedFingerprintsBackfilled ||
          conditionVerdictsChanged ||
          outputsChanged ||
          exportSetChanged ||
          skippedOutputsChanged ||
          orphansChanged ||
          healedAttributesPending
        ) {
          try {
            const refreshedState: StackState = {
              version: STATE_SCHEMA_VERSION_CURRENT,
              region: this.stackRegion,
              stackName: currentState.stackName,
              resources: currentState.resources,
              ...orphansCarriedFrom(currentState),
              outputs: (outputsChanged ? outputsToPersist : persistedOutputs) as Record<
                string,
                string
              >,
              // The set belongs to the bag written above: this pass's when
              // every output resolved (changed, or equal — either way the
              // resolved set describes it), the merge's when one did not, and
              // the previous record's when the previous bag was kept whole.
              ...(exportNamesToPersist === undefined
                ? exportNamesCarriedFrom(currentState)
                : { exportNames: [...exportNamesToPersist] }),
              // Unlike `exportNames`, ALWAYS this pass's: the record says
              // what THIS deploy skipped, which the resolution just decided
              // whether or not the bag was carried forward. Omitted when
              // nothing was skipped. COPIED, like the `exportNames` /
              // `imports` spreads beside it. Consistency, not a fix for an
              // observable bug: `collectSkippedOutputs` builds a FRESH
              // object each pass, so no alias outlives one and no test can
              // tell a copy from an alias here. Stated so the absence of a
              // fence is not read as an oversight.
              ...(this.skippedOutputs && { skippedOutputs: { ...this.skippedOutputs } }),
              // Preserve existing imports[] / outputReads[] (v8+) — otherwise
              // the refresh would silently strip the strong-reference record
              // on every diff-clean deploy. Unioned with this session's
              // records rather than taking the snapshot alone (issue #2057):
              // the no-change path resolves nothing new in the common case,
              // so the union is usually an identity, and applying one rule at
              // every non-success save leaves no exception to remember. See
              // `crossStackReadsForPartialSave`.
              ...crossStackReadsForPartialSave(
                currentState,
                this.recordedImports,
                this.recordedOutputReads,
                this.crossStackReadKeyNormalizer()
              ),
              ...(conditionVerdicts && { conditionVerdicts }),
              lastModified: Date.now(),
            };
            const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {};
            if (currentEtag !== undefined) saveOptions.expectedEtag = currentEtag;
            if (migrationPending) saveOptions.migrateLegacy = true;
            await this.stateBackend.saveState(
              stackName,
              this.stackRegion,
              this.withParentInfo(refreshedState),
              saveOptions
            );
            if (outputsChanged || exportSetChanged) {
              persistedOutputs = refreshedState.outputs;
              if (outputsChanged) {
                this.logger.info('Persisted Outputs-only change (no resource diff).');
              } else {
                this.logger.debug(
                  'Persisted export-set change (no outputs-value diff, no-change path, #2193)'
                );
              }
              // Update the persistent exports index so the newly-added export
              // resolves O(1) for consumers — with the EXPORTS only (#2193),
              // which on the backfill arm is what evicts the plain-name
              // entries a pre-v9 deploy published. Inside the try so a failed
              // state save doesn't publish an export that wasn't persisted;
              // updateForStack is itself best-effort (swallows + warns).
              if (this.exportIndexStore) {
                await this.exportIndexStore.updateForStack(
                  stackName,
                  this.stackRegion,
                  // Redacted again as the save above redacts it (issue
                  // #2814), so this path's index cannot diverge from what
                  // state holds. Since issue #2771 the call is load-bearing
                  // rather than only fail-safe: a released drain leaves an
                  // output unresolved, and the partial persist then writes
                  // the SIBLINGS that did resolve, so a needle a released
                  // part records after the outputs pass CAN reach this
                  // block. (The bag is not always this pass's either: on the
                  // `exportSetChanged`-only arm it is `persistedOutputs`,
                  // the PREVIOUS deploy's bag, and a second pass is not
                  // unconditionally idempotent; see
                  // `absorbOutputsPassSecrets`.) A needle arriving between
                  // the save and this call leaves the index more redacted
                  // than state, never less.
                  importableOutputs({
                    ...refreshedState,
                    outputs: this.redactOutputs(refreshedState.outputs),
                  })
                );
              }
            } else if (observedRefresh) {
              this.logger.debug('Persisted refreshed observedProperties (no-change path)');
            } else if (healedAttributesPending) {
              this.logger.debug(
                'Persisted attributes re-read from AWS for a stale record (no-change path, #1852)'
              );
            } else {
              this.logger.debug(
                'Persisted skipped-outputs record (no outputs-value diff, no-change path, #2740)'
              );
            }
          } catch (saveError) {
            this.logger.warn(
              `Failed to persist no-change state update: ${saveError instanceof Error ? saveError.message : String(saveError)} — drift baseline / outputs will be re-resolved on next deploy.`
            );
          }
        }
      }

      // A clean no-change deploy is still a SUCCESSFUL deploy — drop any
      // lingering rollback journal, matching the documented "deleted on
      // the next successful deploy" contract (the changes path does this
      // at its end too). This matters for the failed-only segment a clean
      // auto-rollback retains (issue #1208): the typical fix-forward is
      // REMOVING the failed resource from the template, which lands here
      // with hasChanges=false — without this delete the journal (and its
      // "previous deploy failed" note) would linger indefinitely.
      //
      // go-to-k/cdkd#4600: a journaled proven orphan it could not delete is
      // a resource left in AWS, counted with the skipped deletes (exit 2).
      const journaledOrphansLeft = this.options.dryRun
        ? 0
        : await this.settleJournalAfterSuccess(
            stackName,
            [],
            currentState,
            currentState.resources,
            currentEtag === undefined
          );

      return {
        stackName,
        created: 0,
        updated: 0,
        deleted: 0,
        deleteSkipped: journaledOrphansLeft,
        updatePartial: 0,
        unchanged: Object.keys(currentState.resources).length,
        durationMs: Date.now() - startTime,
        // Redacted again, as the save redacts the bag it writes (issue
        // #2814): a part the drain cap stopped waiting for can record after
        // the outputs pass, and the bag kept here may be the PREVIOUS
        // deploy's, holding a literal nothing resolved then.
        outputs: this.buildDisplayOutputs(template, this.redactOutputs(persistedOutputs)),
        attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
      };
    }

    // Log changes summary
    const createChanges = this.diffCalculator.filterByType(changes, 'CREATE');
    const updateChanges = this.diffCalculator.filterByType(changes, 'UPDATE');
    const deleteChanges = this.diffCalculator.filterByType(changes, 'DELETE');

    this.logger.info(
      `Changes: ${green(createChanges.length)} to create, ${yellow(updateChanges.length)} to update, ${red(deleteChanges.length)} to delete`
    );

    if (this.options.dryRun) {
      this.logger.info('Dry run mode - skipping actual deployment');
      return {
        stackName,
        created: createChanges.length,
        updated: updateChanges.length,
        deleted: deleteChanges.length,
        // A dry run issues no provider call, so nothing can be skipped.
        deleteSkipped: 0,
        updatePartial: 0,
        unchanged: this.diffCalculator.filterByType(changes, 'NO_CHANGE').length,
        durationMs: Date.now() - startTime,
        attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
      };
    }

    // go-to-k/cdkd#4043: a stack whose only "changes" are readers of a
    // `NoEcho` parameter (state holds `***` there) has no template change; the
    // engine compares each with AWS and skips it when unchanged. Said so, as
    // the no-change path would, rather than reading as a pending update.
    const nonNoEchoChanges = [...changes.values()].filter(
      (c) => c.changeType !== 'NO_CHANGE' && !isNoEchoPromotionOnly(c)
    );
    if (nonNoEchoChanges.length === 0) {
      const readers = [...changes.values()].filter(isNoEchoPromotionOnly).length;
      this.logger.info(
        safeMsg`No changes detected in the template. Comparing ${String(readers)} resource(s) that read a NoEcho parameter with AWS.`
      );
    }

    // `--require-approval`: asked on the diff this deploy executes, before any
    // provider call. The lock is released by the `finally`.
    await requireDeploymentApproval({
      options: this.options,
      stackName,
      changes: changes.values(),
      records: currentState.resources,
      template: effectiveTemplate,
      recreateTargetIds: recreateTargetIdsFor(this.options.recreateTargets, stackName),
    });

    // Issue #1111 item 3 (review fix): the diff phase above resolves
    // intrinsics through the SAME counted resolver, so a warn-path
    // fallback on a to-be-updated resource would otherwise count once
    // during diff and AGAIN during provisioning (~2x distinct sites in
    // the summary). Reset here so the change-path summary counts each
    // fallback site once (provisioning + final output resolution). The
    // no-change / dry-run early returns above keep the deploy()-start
    // reset: their only resolutions ARE the diff phase (+ the no-change
    // path's output resolution), so nothing double-counts there. Full
    // semantics in the counter's JSDoc
    // ({@link IntrinsicFunctionResolver.getPhysicalIdFallbackCount}).
    this.resolver.resetPhysicalIdFallbackCount();

    // Progress counter for tracking overall deployment progress
    const totalOperations = createChanges.length + updateChanges.length + deleteChanges.length;
    const progress = { current: 0, total: totalOperations };

    // 6. Execute deployment (event-driven DAG dispatch with partial state saves)
    const {
      state: newState,
      actualCounts,
      completedOperations,
    } = await withProducerRegions(
      // go-to-k/cdkd#4174: for the child engine a nested-stack row builds.
      () => this.producerRegionEvidence(currentState),
      () =>
        this.executeDeployment(
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
    );

    // 7a. Drain in-flight readCurrentState promises so each resource's
    // observedProperties lands in newState before we persist it. By
    // this point the deploy critical path is over, so awaiting the
    // remaining captures only adds the longest still-pending read
    // (typically <300ms in practice for medium stacks; see PR notes).
    await this.drainObservedCaptures(newState.resources);

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
    const newEtag = await this.stateBackend.saveState(
      stackName,
      this.stackRegion,
      // The record joins here, on the save that ends a successful deploy
      // (go-to-k/cdkd#4479): `executeDeployment` builds its states field by
      // field, so none of its saves carries it.
      this.withParentInfo(conditionVerdicts ? { ...newState, conditionVerdicts } : newState)
    );
    this.logger.debug(`State saved (ETag: ${newEtag})`);
    // go-to-k/cdkd#4438: the record now names every resource this deploy
    // created, so their create-token `sent` entries have done their job.
    await forgetRecordedCreateTokens(Object.keys(newState.resources));

    // 7c. Two independent post-save S3 writes, run CONCURRENTLY:
    //
    //   1. Delete the rollback journal. Deploy succeeded, so the stable
    //      baseline has moved and a journal from a prior failed attempt
    //      (fix-forward that now succeeded) must NOT be replayable past
    //      this point (issue #1183). Best-effort.
    //   2. Update the persistent exports index with this stack's outputs
    //      so subsequent `Fn::ImportValue` resolves hit O(1). Best-effort:
    //      failures are swallowed inside updateForStack and surfaced as
    //      warnings (state.json is canonical; a stale index self-heals on
    //      the next deploy/resolve fallback).
    //
    // They target DISJOINT S3 objects — `{prefix}/{stack}/{region}/
    // rollback-journal.json` vs the bucket-level exports index — and
    // neither reads what the other writes: `updateForStack` only ever
    // touches the exports index (plus, on a first-ever call, a rebuild
    // scan of `state.json` files, which the journal delete does not
    // affect), and the journal delete reads nothing at all. So the
    // previous sequential ordering carried no dependency; it was costing
    // a full extra S3 round trip on every successful deploy (measured
    // ~0.5s of the ~1.0s "State saved" -> "Lock released" window).
    //
    // BOTH stay strictly AFTER the state save above and strictly BEFORE
    // the lock release in the `finally` below, which is load-bearing:
    // deleting the journal before the new baseline is durable would lose
    // the ability to revert, and releasing the lock before these settle
    // would let a concurrent deploy of the same stack observe a journal
    // we are about to delete (spurious "a previous deploy failed" note)
    // or race the exports-index read-modify-write.
    // go-to-k/cdkd#4600: a journaled proven orphan the settle could not
    // delete is a resource left in AWS, counted with the skipped deletes.
    const [journaledOrphansLeft] = await Promise.all([
      this.settleJournalAfterSuccess(
        stackName,
        completedOperations,
        currentState,
        newState.resources,
        currentEtag === undefined
      ),
      this.exportIndexStore
        ? this.exportIndexStore.updateForStack(
            stackName,
            this.stackRegion,
            // The EXPORTS only (issue #2193): the bag also holds every plain
            // Output name, and an index fed the whole bag served those to
            // `Fn::ImportValue` — a same-named plain Output in an unrelated
            // stack could shadow a real export.
            importableOutputs({
              ...newState,
              outputs: this.redactOutputs(newState.outputs),
            })
          )
        : Promise.resolve(),
    ]);

    const durationMs = Date.now() - startTime;
    const unchangedCount =
      this.diffCalculator.filterByType(changes, 'NO_CHANGE').length + actualCounts.skipped;

    return {
      stackName,
      created: actualCounts.created,
      updated: actualCounts.updated,
      deleted: actualCounts.deleted,
      deleteSkipped: actualCounts.deleteSkipped + journaledOrphansLeft,
      updatePartial: actualCounts.updatePartial,
      nestedUpdatePartial: actualCounts.nestedUpdatePartial,
      unchanged: unchangedCount,
      durationMs,
      outputs: this.buildDisplayOutputs(template, this.redactOutputs(newState.outputs ?? {})),
      attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
    };
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
    // map so a re-used engine instance does not accumulate stale entries
    // across deploys. The underlying promises already have a `.catch` so
    // dropping the references will not produce an unhandled rejection.
    this.observedCaptureTasks.clear();

    // Always release lock
    try {
      await this.lockManager.releaseLock(stackName, this.stackRegion);
      this.logger.debug('Lock released');
    } catch (lockError) {
      this.logger.warn(
        `Failed to release lock: ${lockError instanceof Error ? lockError.message : String(lockError)}`
      );
    }
  }
}
