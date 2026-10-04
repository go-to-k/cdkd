import {
  type DeployEngine,
  EMPTY_SECRETS,
  type ProvisionCounts,
  type ResourceOutcomeSignal,
} from '../deploy-engine.js';
import { slowCcOperationTimeoutMs } from '../../provisioning/slow-cc-operation-timeouts.js';
import {
  type DeploymentResourceOperation,
  extractDeploymentEventError,
} from '../../types/deployment-events.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange, ResourceState } from '../../types/state.js';
import { ProvisioningError, ResourceTimeoutError } from '../../utils/error-handler.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import { DEFAULT_RESOURCE_TIMEOUT_MS, DEFAULT_RESOURCE_WARN_AFTER_MS } from './options.js';
import { isReplacementCeiling } from '../deploy-value-equality.js';
import { withResourceDeadline } from '../resource-deadline.js';
import { maskSecretsInError } from '../secret-redaction.js';
import {
  type NestedChildUnaddressed,
  collectNestedChildUnaddressed,
} from '../../provisioning/nested-stack-context.js';
import {
  priorAttemptLookup,
  priorAttemptsInJournal,
  withPriorAttempts,
} from '../prior-attempt-scope.js';
import { withStackRecords } from '../stack-records-scope.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    provisionResource: OmitThisParameter<typeof provisionResource>;
    /** @internal */
    provisionResourceBody: OmitThisParameter<typeof provisionResourceBody>;
  }
}

/**
 * Provision a single resource (CREATE/UPDATE/DELETE)
 */
export async function provisionResource(
  this: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template?: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>,
  counts?: ProvisionCounts,
  progress?: { current: number; total: number }
): Promise<ResourceOutcomeSignal | void> {
  const resourceType = change.resourceType;

  const renderer = getLiveRenderer();
  // The SAME question the dispatch asks (`propertyDrivenReplacement ||
  // recreateFlagged`), computed once and used by BOTH the verb and the
  // routing tag. Splitting it is what produced three rounds of one class:
  // the tag was fixed to include the flag half while the verb kept the
  // property half alone, so a `--recreate-via-*` target whose property change
  // does not itself force a replacement still rendered `Updating` over a
  // destroy + recreate.
  const labelRecreateDirection = this.recreateDirectionFor(stackName, logicalId);
  // The Type-change half (issue #3036) is mirrored too: the dispatch treats a
  // recorded type that differs from the template's as a replacement whatever
  // `propertyChanges` says.
  const labelRecordedType = stateResources[logicalId]?.resourceType;
  //
  // A CEILING (go-to-k/cdkd#3662) does not count here: whether it stands is
  // decided only once the UPDATE arm resolves the value, and a label saying
  // `Replacing` over an in-place update narrates something that does not
  // happen. The UPDATE arm re-labels the resource when the ceiling stands.
  const needsReplacement =
    (change.changeType === 'UPDATE' &&
      ((change.propertyChanges?.some((pc) => pc.requiresReplacement && !isReplacementCeiling(pc)) ??
        false) ||
        (labelRecordedType !== undefined && labelRecordedType !== resourceType))) ||
    labelRecreateDirection !== undefined;
  const verb =
    change.changeType === 'CREATE'
      ? 'Creating'
      : change.changeType === 'DELETE'
        ? 'Deleting'
        : needsReplacement
          ? 'Replacing'
          : 'Updating';
  // #614 §9 live-progress annotation: distinguish CC-routed work from
  // SDK-routed work so the user sees WHY a particular resource is taking
  // longer than its sibling (CC API is async-polling). CREATE / UPDATE
  // consult `getProviderFor` with the template-side properties +
  // recorded `provisionedBy` (the latter so sticky-CC resources keep
  // the tag even when the update payload has no silent-drop property
  // of its own — design §8). DELETE short-circuits on recorded
  // `provisionedBy` since delete routing is fully driven by state, not
  // by the template. Routing is based on top-level property NAMES
  // which intrinsic resolution does not change, so the pre-routing
  // here matches the real decision in the provision arms. Errors
  // here never surface — if routing inference fails, we drop the tag
  // and the real `getProviderFor` call later will re-evaluate.
  const labelRouting = this.peekRoutingForLabel(
    change,
    stateResources[logicalId],
    stackName,
    logicalId,
    needsReplacement,
    labelRecreateDirection
  );
  const routingTag = labelRouting === 'cc-api' ? ' [CC API]' : '';
  const baseLabel = `${verb} ${logicalId} (${resourceType})${routingTag}`;
  renderer.addTask(logicalId, baseLabel);
  this.liveTaskLabels.set(logicalId, { label: baseLabel, replacing: needsReplacement });

  // Operation classification for the timeout error message. UPDATE and
  // its replacement-replacement form are both surfaced as 'UPDATE' since
  // the user-facing distinction (which immutable property triggered it)
  // is already in the renderer label.
  const operationKind: 'CREATE' | 'UPDATE' | 'DELETE' =
    change.changeType === 'CREATE'
      ? 'CREATE'
      : change.changeType === 'DELETE'
        ? 'DELETE'
        : 'UPDATE';

  // Per-resource-type overrides (v2) win over the global default.
  // Resolution order at the call site:
  //   1. per-type CLI override map for this resourceType — explicit
  //      escape hatch, always wins (`--resource-timeout TYPE=DURATION`).
  //   2. provider self-report (`getMinResourceTimeoutMs()`) raised
  //      against the global default — long-running providers
  //      (Custom Resource polls up to 1h) lift the deadline for their
  //      resources without forcing every user to remember
  //      `--resource-timeout 1h`.
  //   3. CLI global default (`--resource-timeout 30m`).
  //   4. compile-time default (DEFAULT_RESOURCE_*_MS).
  //
  // `getProvider` here only consults the resource type (no template
  // properties / no state-recorded layer) — it's used solely to read
  // `getMinResourceTimeoutMs`. The real routing decision (which can
  // promote a Tier 1 resource to Cloud Control under #614) happens
  // inside the provision arms via `getProviderFor`.
  const provider = this.providerRegistry.getProvider(resourceType);
  const providerMinTimeoutMs = provider.getMinResourceTimeoutMs?.() ?? 0;
  const warnAfterMs =
    this.options.resourceWarnAfterByType?.[resourceType] ??
    this.options.resourceWarnAfterMs ??
    DEFAULT_RESOURCE_WARN_AFTER_MS;
  const globalTimeoutMs = this.options.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
  // Known-slow types (OpenSearch domains, RDS / Redshift / ElastiCache
  // clusters) lift the outer deadline to match the CC inner poll cap so a
  // slow CREATE / UPDATE is not aborted by the 30-min default. A per-type CLI
  // override still wins (explicit escape hatch).
  const slowTypeMinTimeoutMs = slowCcOperationTimeoutMs(resourceType, operationKind);
  const timeoutMs =
    this.options.resourceTimeoutByType?.[resourceType] ??
    Math.max(providerMinTimeoutMs, slowTypeMinTimeoutMs, globalTimeoutMs);

  // #808 best-effort event: per-resource op started. `provisionedBy`
  // is the routing inference used for the live label (same decision the
  // real provider call makes); good enough for the event metadata.
  const eventOp: DeploymentResourceOperation = operationKind;
  const resourceStartedAt = Date.now();
  this.recordEvent({
    eventType: 'RESOURCE_STARTED',
    stackName,
    operation: eventOp,
    logicalId,
    resourceType,
    ...(labelRouting && { provisionedBy: labelRouting }),
  });

  // Issue #1762: set when the body's DELETE branch consumed a
  // `{ outcome: 'skipped' }` from the provider. Assigned inside the
  // deadline callback (same shape destroy-runner.ts uses for its own
  // `deleteResult`) because the body's return value is otherwise swallowed
  // by `withResourceDeadline`.
  let deleteSkipped: string | undefined;
  // Issue #1819: an UPDATE that left a resource behind. Unlike
  // `deleteSkipped` this does NOT suppress `RESOURCE_SUCCEEDED` — the row's
  // resource really was updated — it adds a second event naming the survivor.
  let updatePartial: string | undefined;
  // Snapshot BEFORE the body runs: a replacement re-points the state record
  // to the NEW physical id, so by the time the event is built the survivor's
  // id is gone from state and only the free-text reason would still carry it.
  const physicalIdBeforeUpdate = stateResources[logicalId]?.physicalId;
  const provisionedByBeforeUpdate = stateResources[logicalId]?.provisionedBy;
  // Issue #1989: what a nested child's deploy left unaddressed, when this row
  // is an `AWS::CloudFormation::Stack`. Added to `counts` only once the row
  // has succeeded, beside the row's own outcome, never in place of it.
  let nestedChildUnaddressed: NestedChildUnaddressed | undefined;
  try {
    await withResourceDeadline(
      async () => {
        const { value: bodyResult, unaddressed } = await collectNestedChildUnaddressed(() =>
          this.provisionResourceBody(
            logicalId,
            change,
            stateResources,
            stackName,
            template,
            parameterValues,
            conditions,
            counts,
            progress
          )
        );
        deleteSkipped = bodyResult?.deleteSkipped;
        updatePartial = bodyResult?.updatePartial;
        nestedChildUnaddressed = unaddressed;
      },
      {
        warnAfterMs,
        timeoutMs,
        onWarn: (elapsedMs) => {
          const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
          const warnSuffix = ` [taking longer than expected, ${minutes}m+]`;
          // Mutate the live renderer's task label in place (TTY mode)
          // and emit a warn line above the live area (non-TTY / verbose).
          const current = this.liveTaskLabels.get(logicalId);
          if (current !== undefined) current.warnSuffix = warnSuffix;
          renderer.updateTaskLabel(logicalId, `${current?.label ?? baseLabel}${warnSuffix}`);
          renderer.printAbove(() => {
            this.logger.warn(
              `${logicalId} (${resourceType}) has been ${operationKind === 'CREATE' ? 'creating' : operationKind === 'DELETE' ? 'deleting' : 'updating'} for ${minutes}m — still waiting`
            );
          });
        },
        onTimeout: (elapsedMs) =>
          new ResourceTimeoutError(
            logicalId,
            resourceType,
            this.stackRegion,
            elapsedMs,
            operationKind,
            timeoutMs
          ),
      }
    );
    // Issue #1989: the child's own rows already logged each survivor and
    // recorded its `RESOURCE_SKIPPED` (a nested child's events belong to this
    // run), so what was missing is only the COUNT. Adding it here carries it
    // to `DeployResult`, the summary rows, `RunCounts.skipped` and the exit
    // code, and up through every ancestor's `DeployResult` in turn.
    if (counts && nestedChildUnaddressed) {
      counts.deleteSkipped += nestedChildUnaddressed.deleteSkipped;
      counts.updatePartial += nestedChildUnaddressed.updatePartial;
      counts.nestedUpdatePartial += nestedChildUnaddressed.updatePartial;
    }
    // Issue #1762: a DELETE the provider refused to issue is NOT a
    // success — the events store is the durable post-mortem, and
    // `RESOURCE_SUCCEEDED` there would claim cdkd deleted a resource that
    // is still alive. Mirrors destroy-runner.ts's RESOURCE_SKIPPED emit,
    // `reason` included: a bare event cannot tell the user why.
    if (deleteSkipped !== undefined) {
      this.recordEvent({
        eventType: 'RESOURCE_SKIPPED',
        stackName,
        operation: eventOp,
        logicalId,
        resourceType,
        ...(stateResources[logicalId]?.provisionedBy
          ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
          : labelRouting && { provisionedBy: labelRouting }),
        ...(stateResources[logicalId]?.physicalId && {
          physicalId: stateResources[logicalId]?.physicalId,
        }),
        reason: deleteSkipped,
        durationMs: Date.now() - resourceStartedAt,
      });
      return { deleteSkipped };
    }
    // Issue #1819 / #1922: the row's resource WAS updated, so it still gets
    // `RESOURCE_SUCCEEDED` below. What did NOT happen is the retirement of
    // the resource the update owned, so that gets its own `RESOURCE_SKIPPED`
    // — whose documented invariant ("the resource this row names was not
    // destroyed") is exactly true of the survivor, and false of the updated
    // row. Emitting only the skip, as the issue first proposed, would have
    // put the events store at odds with its own contract.
    if (updatePartial !== undefined) {
      this.recordEvent({
        eventType: 'RESOURCE_SKIPPED',
        stackName,
        operation: eventOp,
        logicalId,
        resourceType,
        // The SURVIVOR's routing layer, snapshotted with its id below: the
        // post-update record describes the NEW resource, so a replacement
        // that re-routed would label the survivor with the wrong layer.
        ...(provisionedByBeforeUpdate
          ? { provisionedBy: provisionedByBeforeUpdate }
          : labelRouting && { provisionedBy: labelRouting }),
        // The SURVIVOR's id as a FIELD, not only inside `reason`: a `--json`
        // consumer should not have to parse prose, and this is the one datum
        // a cleanup pass actually needs.
        ...(physicalIdBeforeUpdate && { physicalId: physicalIdBeforeUpdate }),
        reason: updatePartial,
        durationMs: Date.now() - resourceStartedAt,
      });
    }
    // #808 best-effort event: per-resource op succeeded. Read the
    // freshly-stamped routing layer + physical id off the state record
    // the body just wrote (falls back to the label inference / undefined).
    this.recordEvent({
      eventType: 'RESOURCE_SUCCEEDED',
      stackName,
      operation: eventOp,
      logicalId,
      resourceType,
      ...(stateResources[logicalId]?.provisionedBy
        ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
        : labelRouting && { provisionedBy: labelRouting }),
      ...(stateResources[logicalId]?.physicalId && {
        physicalId: stateResources[logicalId]?.physicalId,
      }),
      durationMs: Date.now() - resourceStartedAt,
    });
  } catch (error) {
    renderer.removeTask(logicalId);
    const message = error instanceof Error ? error.message : String(error);
    // Issue #2038: MASKED, and at a strictly higher log level than the retry
    // give-up summary one statement below it. `perResourceSecrets` is
    // populated right after `resolver.resolve` and BEFORE the provider call
    // on both the CREATE and the UPDATE path, so whenever this resource
    // resolved a `{{resolve:...}}` reference the bag handed to the provider
    // was PLAINTEXT — and an AWS validation error routinely quotes the
    // offending value back (`Value '<secret>' at 'clientSecret' failed to
    // satisfy constraint ...`). The `recordEvent` below already masked (via
    // `maskSecretsInEvent`); this `error` line did not, so the durable sink
    // was clean while the terminal printed the secret at DEFAULT verbosity.
    // Masks the CONCATENATED line, matching `maskingRetryLogger`; forwards
    // verbatim for a resource with no recorded secret.
    this.logger.error(
      this.maskForResource(
        logicalId,
        `Failed to ${change.changeType.toLowerCase()} ${logicalId}: ${message}`
      )
    );

    // Issue #2901's sibling, #2902: a plain CREATE colliding with a name
    // cdkd itself derived. Emitted as its own line so the AWS sentence above
    // stays verbatim, and masked like it — the id is template-derived, so a
    // stack or logical id built from a resolved secret would otherwise reach
    // a DEFAULT-level line the one above is masked for.
    const orphanAdvice = this.orphanedNameCollisionAdvice(change.changeType, logicalId, error);
    if (orphanAdvice) {
      this.logger.error(this.maskForResource(logicalId, orphanAdvice));
    }

    // #808 best-effort event: per-resource op failed. Error metadata
    // only — no resource properties.
    this.recordEvent({
      eventType: 'RESOURCE_FAILED',
      stackName,
      operation: eventOp,
      logicalId,
      resourceType,
      ...(stateResources[logicalId]?.provisionedBy
        ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
        : labelRouting && { provisionedBy: labelRouting }),
      durationMs: Date.now() - resourceStartedAt,
      error: extractDeploymentEventError(error),
    });

    // Issue #2038 review: the CAUSE is masked too, and that is a THIRD sink
    // rather than a belt-and-braces repeat of the two above. `formatError`
    // renders a `CdkdError`'s cause as `Caused by: <cause.message>` and
    // `handleError` logs it at `error` level, so a deploy that fails on a
    // secret-bearing resource printed the plaintext at the CLI boundary even
    // with both log sites masked — the sink reads the error OBJECT, not the
    // text this method formatted. `maskSecretsInError` clones with every own
    // property descriptor (symbols included), so `markNonRetryable`'s marker,
    // `$metadata` and any nested `cause` survive for the classifiers, and it
    // returns the original by identity when nothing matched. Deliberately
    // AFTER `extractDeploymentEventError` above, which masks separately via
    // `recordEvent` and would otherwise mask twice for no benefit.
    throw new ProvisioningError(
      `Failed to ${change.changeType.toLowerCase()} resource ${logicalId}`,
      resourceType,
      logicalId,
      stateResources[logicalId]?.physicalId,
      error instanceof Error
        ? maskSecretsInError(error, this.perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS)
        : undefined
    );
  } finally {
    // Safety net for early-break paths (UPDATE skip, DeletionPolicy: Retain).
    // removeTask is idempotent, so calling it again after the explicit calls
    // above is a no-op.
    renderer.removeTask(logicalId);
  }
}

/**
 * Inner body of provisionResource, extracted so the outer wrapper can
 * apply the per-resource deadline (`withResourceDeadline`) without
 * having the timeout / warn timer code dwarf the real provisioning
 * logic. Behaviour is unchanged from the pre-deadline implementation.
 */
export async function provisionResourceBody(
  this: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template?: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>,
  counts?: ProvisionCounts,
  progress?: { current: number; total: number }
): Promise<ResourceOutcomeSignal | void> {
  // go-to-k/cdkd#4355: what this stack's rollback journal recorded for the
  // resource, for a provider that cannot otherwise tell its own leftover from
  // another owner's identical resource. Read only when a provider asks.
  const priorAttempts = priorAttemptLookup(logicalId, async () =>
    priorAttemptsInJournal(
      await this.stateBackend.loadRollbackJournal(stackName, this.stackRegion),
      logicalId,
      change.resourceType
    )
  );
  // go-to-k/cdkd#4492: bound for every change type — a DELETE asks which other
  // records of the stack still hold its resource.
  return withStackRecords(
    this.stackRecordsView,
    (): Promise<ResourceOutcomeSignal | void> | undefined => {
      switch (change.changeType) {
        case 'CREATE':
          return withPriorAttempts(priorAttempts, () =>
            this.provisionCreate(
              logicalId,
              change,
              stateResources,
              stackName,
              template,
              parameterValues,
              conditions,
              counts,
              progress
            )
          );
        case 'UPDATE':
          return withPriorAttempts(priorAttempts, () =>
            this.provisionUpdate(
              logicalId,
              change,
              stateResources,
              stackName,
              template,
              parameterValues,
              conditions,
              counts,
              progress
            )
          );
        case 'DELETE':
          return this.provisionDelete(
            logicalId,
            change,
            stateResources,
            stackName,
            template,
            counts,
            progress
          );
      }
      return undefined;
    }
  );
}
