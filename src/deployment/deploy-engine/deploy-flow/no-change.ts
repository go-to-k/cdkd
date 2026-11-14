import { retryCarriedSupersededResources } from '../superseded-retry.js';
import { supersededResourcesOf } from '../../superseded-resources.js';
import { redactOutputs } from '../masking.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { settleJournalAfterSuccess } from '../rollback.js';
import { crossStackReadsForPartialSave } from '../../deploy-engine.js';
import { skippedOutputsEqual } from '../../../analyzer/skipped-outputs.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type StackState,
  exportNamesCarriedFrom,
  stackInstanceIdCarriedFrom,
  importableOutputKeys,
  importableOutputs,
  orphansCarriedFrom,
} from '../../../types/state.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import { outputMapsEqual } from '../../deploy-value-equality.js';
import { withSharedDrainBudget } from '../../drain-budget.js';
import {
  type NoChangeOutputsMerge,
  bagHoldsSecretExpression,
  keptWholeReasonText,
  mergeNoChangeOutputs,
} from '../../no-change-outputs-merge.js';
import { requireOutputsOnlyApproval } from '../../deployment-approval.js';
import {
  conditionVerdictRecordsEqual,
  readRecordedConditionVerdicts,
} from '../../condition-verdicts.js';
import { buildDisplayOutputs, resolveOutputs } from '../outputs.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { PhaseClock } from '../../../utils/phase-timings.js';
import type { DeployResult } from '../options.js';
import type { buildConditionVerdictRecord } from '../../condition-verdicts.js';

/**
 * The no-change path of a deploy: what it still saves, settles and reports
 * when the diff found nothing to do (moved from `deploy-flow.ts`).
 */
export async function deployWithoutChanges(
  engine: DeployEngine,
  {
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
    ssmNamesHealed,
    resolveStackInstanceId,
    startProvenanceCapture,
    startTime,
    clock,
  }: {
    stackName: string;
    template: CloudFormationTemplate;
    currentState: StackState;
    currentEtag: string | undefined;
    effectiveTemplate: CloudFormationTemplate;
    outputsDigestSource: CloudFormationTemplate;
    parameterValues: Record<string, unknown>;
    conditions: Record<string, boolean>;
    conditionVerdicts: ReturnType<typeof buildConditionVerdictRecord>;
    migrationPending: boolean;
    maskedFingerprintsBackfilled: boolean;
    orphansChanged: boolean;
    terminationProtectionChanged: boolean;
    /** go-to-k/cdkd#6274: a record's SSM parameter name was re-spelled in memory. */
    ssmNamesHealed: boolean;
    resolveStackInstanceId: () => Promise<void>;
    startProvenanceCapture: () => void;
    startTime: number;
    clock: PhaseClock;
  }
): Promise<DeployResult> {
  engine.logger.info('No changes detected. Stack is up to date.');
  startProvenanceCapture();
  // go-to-k/cdkd#5111: an earlier deploy's superseded resources are
  // retried by every deploy, an unchanged one included.
  const supersededChanged = engine.options.dryRun
    ? false
    : await retryCarriedSupersededResources(
        engine,
        currentState,
        supersededResourcesOf(currentState),
        currentState.resources
      );

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
  if (!engine.options.dryRun) {
    // Resolve against `effectiveTemplate` (condition-pruned) — the same
    // map the executeDeployment path resolves. Outputs reference
    // resources, which come from `currentState.resources` (the arg), and
    // condition pruning only touches `Resources`, so resolving against
    // `effectiveTemplate` vs the raw `template` is equivalent here.
    const resolvedOutputs = redactOutputs(
      engine.maskingDeps(),
      // One budget for the whole pass, as on the deploy path above.
      await withSharedDrainBudget(() =>
        resolveOutputs(
          engine.outputsRun,
          engine.outputsDeps(),
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
    const observedRefresh =
      (await engine.observedCapture.drainObservedCaptures(currentState.resources)) > 0;

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
          resolvedExportNames: engine.outputsRun.resolvedExportNames,
          // go-to-k/cdkd#4657: the outputs pass's own verdict. Always set by
          // a pass with `Outputs`, which is what a failed key needs; absent,
          // carry nothing.
          refusesCarriedAlias: (outputKey, exportName) =>
            engine.outputsRun.carriedExportAliasRefusal === undefined
              ? 'An export alias was not carried: no export-name verdict is available.'
              : engine.outputsRun.carriedExportAliasRefusal(outputKey, exportName),
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
        Reflect.deleteProperty(engine.outputsRun.outputsTemplateSource, key);
      }
      // The merge's own mixed-generation check read the bag BEFORE this
      // save's redaction, which can still give it a first expression (a
      // needle recorded late, during the drain above). Re-read it as the
      // save will write it. No await separates this check from the
      // save's own redaction below.
      if (
        merge.carriedKeys.length > 0 &&
        !bagHoldsSecretExpression(persistedOutputs) &&
        bagHoldsSecretExpression(redactOutputs(engine.maskingDeps(), merge.outputs))
      ) {
        merge = { kind: 'kept', reason: 'mixed-generation' };
      }
    }
    if (merge?.kind === 'kept') engine.outputsRun.outputsSourceUsable = false;
    // A carried alias the export-name verdict refused (go-to-k/cdkd#4657),
    // reported as the alias pass reports its own refusals. Only for a bag
    // that is written: a kept one holds the previous aliases whole.
    if (merge?.kind === 'merged') {
      for (const { reason } of merge.refusedAliases) engine.logger.warn(reason);
    }
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
        ? engine.outputsRun.resolvedExportNames
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
      engine.logger.warn(
        safeMsg`Outputs changed but one or more could not be resolved; keeping the previously persisted outputs. ${keptWholeReasonText(merge.reason)} ` +
          'A downstream Fn::ImportValue may fail until the next deploy.'
      );
    } else if (merge?.kind === 'merged' && merge.carriedKeys.length > 0) {
      engine.logger.debug(
        safeMsg`Kept the previously persisted value of ${merge.carriedKeys.length} output key(s), ` +
          'carried export aliases included, that could not be resolved (no-change path)'
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
      engine.outputsRun.skippedOutputs
    );

    // Issue #1852: a heal the outputs pass (or the diff pass above) read
    // must reach state even when nothing else changed. Otherwise every
    // later deploy pays the same read again, `cdkd diff` repeats it on
    // every run (its healer is read-only and saves nothing,
    // go-to-k/cdkd#3456), and `cdkd drift`, which re-reads nothing,
    // never sees the attribute at all.
    const healedAttributesPending = engine.attributeHealer.hasUnpersistedHeals(
      currentState.resources
    );

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
      await requireOutputsOnlyApproval({ options: engine.options, stackName });
    }

    // State schema v12: the outputs' share of the migration. A record
    // written before v12 has no `outputReferenceProvenance`; this deploy
    // resolved an equal bag, so its provenance is saved once.
    const outputProvenanceBackfill =
      !outputsChanged &&
      currentState.outputReferenceProvenance === undefined &&
      engine.provenanceBaseline?.tokenFree === false &&
      engine.outputReferenceProvenanceFor(
        persistedOutputs,
        redactOutputs(engine.maskingDeps(), persistedOutputs)
      ) !== undefined;

    if (
      observedRefresh ||
      outputProvenanceBackfill ||
      maskedFingerprintsBackfilled ||
      conditionVerdictsChanged ||
      outputsChanged ||
      exportSetChanged ||
      skippedOutputsChanged ||
      orphansChanged ||
      supersededChanged ||
      terminationProtectionChanged ||
      ssmNamesHealed ||
      healedAttributesPending
    ) {
      // A first deploy with nothing to create still writes its record here.
      await resolveStackInstanceId();
      try {
        const refreshedState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: engine.stackRegion,
          stackName: currentState.stackName,
          resources: currentState.resources,
          ...orphansCarriedFrom(currentState),
          ...stackInstanceIdCarriedFrom(currentState),
          outputs: (outputsChanged ? outputsToPersist : persistedOutputs) as Record<string, string>,
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
          ...(engine.outputsRun.skippedOutputs && {
            skippedOutputs: { ...engine.outputsRun.skippedOutputs },
          }),
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
            engine.recordedImports,
            engine.recordedOutputReads,
            engine.crossStackReadKeyNormalizer()
          ),
          ...(conditionVerdicts && { conditionVerdicts }),
          lastModified: Date.now(),
        };
        const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {};
        if (currentEtag !== undefined) saveOptions.expectedEtag = currentEtag;
        if (migrationPending) saveOptions.migrateLegacy = true;
        await engine.stateBackend.saveState(
          stackName,
          engine.stackRegion,
          engine.withParentInfo(refreshedState),
          saveOptions
        );
        if (outputsChanged || exportSetChanged) {
          persistedOutputs = refreshedState.outputs;
          if (outputsChanged) {
            engine.logger.info('Persisted Outputs-only change (no resource diff).');
          } else {
            engine.logger.debug(
              'Persisted export-set change (no outputs-value diff, no-change path)'
            );
          }
          // Update the persistent exports index so the newly-added export
          // resolves O(1) for consumers — with the EXPORTS only (#2193),
          // which on the backfill arm is what evicts the plain-name
          // entries a pre-v9 deploy published. Inside the try so a failed
          // state save doesn't publish an export that wasn't persisted;
          // updateForStack is itself best-effort (swallows + warns).
          if (engine.exportIndexStore) {
            await engine.exportIndexStore.updateForStack(
              stackName,
              engine.stackRegion,
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
                outputs: redactOutputs(engine.maskingDeps(), refreshedState.outputs),
              })
            );
          }
        } else if (observedRefresh) {
          engine.logger.debug('Persisted refreshed observedProperties (no-change path)');
        } else if (healedAttributesPending) {
          engine.logger.debug(
            'Persisted attributes re-read from AWS for a stale record (no-change path)'
          );
        } else {
          engine.logger.debug(
            'Persisted skipped-outputs record (no outputs-value diff, no-change path)'
          );
        }
      } catch (saveError) {
        engine.logger.warn(
          safeMsg`Failed to persist no-change state update: ${asIsMessage(describeAwsFailure(saveError).detail)} — drift baseline / outputs will be re-resolved on next deploy.`
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
  const journaledOrphansLeft = engine.options.dryRun
    ? 0
    : await settleJournalAfterSuccess(
        engine.rollbackDeps(),
        stackName,
        [],
        currentState,
        currentState.resources,
        currentEtag === undefined
      );
  clock.lap('no-change path');

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
    outputs: buildDisplayOutputs(template, redactOutputs(engine.maskingDeps(), persistedOutputs)),
    attributeFallbackCount: engine.resolver.getPhysicalIdFallbackCount(),
  };
}
