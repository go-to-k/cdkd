import { diffLogMasker } from '../masking.js';
import { getAccountInfo } from '../../intrinsic-function-resolver.js';
import { GeneratedNameGuard, type GeneratedNameGuardInput } from '../../generated-name-guard.js';
import { withStackScope } from '../../../provisioning/resource-name.js';
import { nextNameGeneration } from '../../../state/name-generation.js';
import { loadKeptInHistory } from '../../kept-in-history.js';
import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import {
  checkDestructivePlan,
  isNoEchoPromotionOnly,
  requireDeploymentApproval,
} from '../../deployment-approval.js';
import { recreateTargetIdsFor } from '../../recreate-target-promotion.js';
import { noteAbandonedRun } from '../../../provisioning/providers/create-token-ledger.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState, ResourceChange } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { PhaseClock } from '../../../utils/phase-timings.js';
import type { ResolverContext } from '../../intrinsic-resolver/context.js';
import type { StackScope } from '../../../provisioning/resource-name.js';
import type { RetainedResource } from '../../../state/s3-state-backend.js';
import type { KeptInHistory } from '../../generated-name-guard.js';
import { keptHistorySources } from './kept-history.js';

/**
 * The change path between the plan and the DAG: the generated-name guard, the
 * destructive-plan check, `--require-approval` and the first deploy's
 * instance id (moved from `deploy-flow.ts`).
 */
export async function prepareChangeExecution(
  engine: DeployEngine,
  {
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
  }: {
    stackName: string;
    currentState: StackState;
    effectiveTemplate: CloudFormationTemplate;
    parameterValues: Record<string, unknown>;
    changes: Map<string, ResourceChange>;
    diffResolverContext: ResolverContext;
    idArrivesLater: boolean;
    nameScope: () => StackScope;
    retainedAtFirstDeploy: Promise<RetainedResource[] | null> | undefined;
    retainedForWarning: Promise<RetainedResource[] | KeptInHistory[] | null> | undefined;
    resolveStackInstanceId: () => Promise<void>;
    startProvenanceCapture: () => void;
    clock: PhaseClock;
  }
): Promise<void> {
  // go-to-k/cdkd#4043: a stack whose only "changes" are readers of a
  // `NoEcho` parameter (state holds `***` there) has no template change; the
  // engine compares each with AWS and skips it when unchanged. Said so, as
  // the no-change path would, rather than reading as a pending update.
  const nonNoEchoChanges = [...changes.values()].filter(
    (c) => c.changeType !== 'NO_CHANGE' && !isNoEchoPromotionOnly(c)
  );
  if (nonNoEchoChanges.length === 0) {
    const readers = [...changes.values()].filter(isNoEchoPromotionOnly).length;
    engine.logger.info(
      safeMsg`No changes detected in the template. Comparing ${String(readers)} resource(s) that read a NoEcho parameter with AWS.`
    );
  }

  // go-to-k/cdkd#4705: every planned create of a name-adopting type whose
  // name cdkd generates is looked up NOW (exact reads, all at once),
  // overlapping the checks and the prompt below; each create awaits its
  // own verdict (`refuseUnlicensedGeneratedName`). Reads only: the intents
  // are written per type after the approval, and settled in the `finally`.
  const abandonedRunAt = (
    engine.lockManager as { abandonedRunEndedBy?: (s: string, r: string) => number | undefined }
  ).abandonedRunEndedBy?.(stackName, engine.stackRegion);
  if (abandonedRunAt !== undefined) await noteAbandonedRun(abandonedRunAt);
  const generatedNameGuardInput: GeneratedNameGuardInput = {
    stackName,
    region: engine.stackRegion,
    changes: changes.values(),
    providerFor: (input) => engine.providerRegistry.getProviderFor({ ...input, quiet: true }),
    records: currentState.resources,
    orphans: currentState.orphans,
    loadJournal: () => engine.stateBackend.loadRollbackJournal(stackName, engine.stackRegion),
    loadRetained: () =>
      retainedAtFirstDeploy ??
      engine.stateBackend.loadRetainedRecord(stackName, engine.stackRegion),
    loadKeptInHistory: () =>
      loadKeptInHistory(keptHistorySources(engine), stackName, engine.stackRegion),
    accountInfo: () => getAccountInfo(engine.stackRegion),
    warn: (message) => engine.logger.warn(message),
    // G-1: this deploy took over the lock an abandoned run left.
    ...(abandonedRunAt !== undefined && { abandonedRunAt }),
  };
  // go-to-k/cdkd#5064: the planned names are derived in the stack's naming
  // scope. A first deploy has no instance id until it is going ahead (past
  // the prompt below), so its lookups start then, before the first create;
  // a stack with a record looks up now, overlapping the checks and prompt.
  const startGeneratedNameGuard = (): void => {
    const scope = nameScope();
    const lifetimeId = scope.stackInstanceId;
    engine.generatedNameGuard = withStackScope(scope, () =>
      GeneratedNameGuard.start({
        ...generatedNameGuardInput,
        ...(lifetimeId !== undefined && {
          newScheme: true,
          // Phase 2: a planned replacement of the same type creates under
          // its next generation's name, checked like a create.
          replacementGeneration: (change) => {
            const record = currentState.resources[change.logicalId];
            if (
              record === undefined ||
              record.resourceType !== change.resourceType ||
              !(
                (change.propertyChanges ?? []).some((pc) => pc.requiresReplacement) ||
                // A `--recreate-via-*` target is a replacement too.
                recreateTargetIdsFor(engine.options.recreateTargets, stackName)?.has(
                  change.logicalId
                ) === true
              )
            ) {
              return undefined;
            }
            return nextNameGeneration(record, change.logicalId, lifetimeId);
          },
        }),
      })
    );
    if (engine.generatedNameGuard !== undefined) {
      engine.logger.debug(
        safeMsg`Generated-name check: looking up ${String(engine.generatedNameGuard.size)} planned create(s)`
      );
    }
  };
  if (!idArrivesLater) startGeneratedNameGuard();

  // go-to-k/cdkd#4705: a plan that destroys (or touches a nested-stack row)
  // is checked against the bucket's other state prefixes BEFORE the approval
  // prompt and any provider call.
  await checkDestructivePlan({
    options: engine.options,
    stackName,
    changes: changes.values(),
    records: currentState.resources,
    template: effectiveTemplate,
    recreateTargetIds: recreateTargetIdsFor(engine.options.recreateTargets, stackName),
  });

  // `--require-approval`: asked on the diff this deploy executes, before any
  // provider call. The lock is released by the `finally`.
  const prompted = await requireDeploymentApproval({
    options: engine.options,
    stackName,
    changes: changes.values(),
    records: currentState.resources,
    orphans: currentState.orphans,
    template: effectiveTemplate,
    recreateTargetIds: recreateTargetIdsFor(engine.options.recreateTargets, stackName),
    // go-to-k/cdkd#4601: the `broadening` table prints resolved values;
    // built only if that level asks.
    secretMask: () =>
      diffLogMasker(
        engine.secretsRun,
        engine.maskingDeps(),
        diffResolverContext.recordedSecretValues,
        effectiveTemplate,
        parameterValues,
        currentState.resources
      ),
  });
  // go-to-k/cdkd#4705: the prompt may have waited; the lookups made before
  // it are read again at each create.
  // A first deploy's guard starts after the prompt (below): nothing to re-read.
  if (prompted) engine.generatedNameGuard?.noteApprovalPrompted();
  startProvenanceCapture();

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
  // (`IntrinsicFunctionResolver.getPhysicalIdFallbackCount`).
  engine.resolver.resetPhysicalIdFallbackCount();

  clock.lap('plan checks, approval');
  await resolveStackInstanceId();
  if (idArrivesLater) {
    startGeneratedNameGuard();
    const kept = (await retainedForWarning) ?? [];
    if (kept.length > 0) {
      engine.logger.warn(
        safeMsg`An earlier deployment of ${displayStackName(stackName)} kept ${String(kept.length)} ` +
          'resource(s) here (DeletionPolicy: Retain). This deploy does not take ' +
          'them back: it creates new resources under new names, as CloudFormation does. To manage a ' +
          "kept resource again, adopt it with 'cdkd import'."
      );
    }
  }
  // The one intent write (review P1): past the prompt and the destructive
  // check, under the lock, before the first create (each awaits it).
  engine.generatedNameGuard?.recordPlannedIntents();
}
