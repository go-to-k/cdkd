/**
 * One resource's delete in the destroy runner's reverse-DAG loop (split out
 * of `../destroy-runner.ts`, go-to-k/cdkd#5835).
 */
import { describeAwsFailure, safeStringify } from '../../../utils/aws-failure-text.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { readsNoEchoDeleteValues } from '../../../deployment/noecho-delete-reresolution.js';
import { formatResourceLine } from '../../../utils/resource-line.js';
import {
  deleteIndeterminateGuards,
  deleteLeftInPlace,
  deleteSkipReason,
  UNSPECIFIED_SKIP_REASON,
} from '../../../deployment/delete-outcome.js';
import { collectNestedChildUnaddressed } from '../../../provisioning/nested-stack-context.js';
import { getLiveRenderer } from '../../../utils/live-renderer.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedInstanceTakesNoSnapshot,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  effectiveDeletionPolicy,
  isFinalSnapshotError,
  unsupportedFinalSnapshotError,
} from '../../../provisioning/final-snapshot.js';
import type { RetainedResource } from '../../../state/s3-state-backend.js';
import { keptForRetainedRecord } from '../../../deployment/retained-readoption.js';
import { slowCcOperationTimeoutMs } from '../../../provisioning/slow-cc-operation-timeouts.js';
import { shouldRetainResource, type ResourceState, type StackState } from '../../../types/state.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { extractDeploymentEventError } from '../../../types/deployment-events.js';
import { withResourceDeadline } from '../../../deployment/resource-deadline.js';
import { recordedReferenceRegions } from '../../../deployment/reference-provenance-record.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../deployment/retryable-errors.js';
import { runDeleteAttempt } from '../../../provisioning/providers/deletion-protection-compensation.js';
import {
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  DEFAULT_RESOURCE_TIMEOUT_MS,
} from '../../../deployment/deploy-engine.js';
import { ProvisioningError, ResourceTimeoutError } from '../../../utils/error-handler.js';
import { isInterruptedWaitError } from '../../../provisioning/interrupt-watch.js';
import { isWaitAbandonedError } from '../../../provisioning/wait-abandoned.js';
import { isMarkedNotGone } from '../../../provisioning/not-gone.js';
import {
  destroyStackRecordsView,
  withStackRecords,
} from '../../../deployment/stack-records-scope.js';
import {
  createUnionSecretMasker,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import type { DestroyRunnerContext, DestroyRunnerResult, DestroyLogger } from './types.js';
import { NESTED_STACK_TYPE, maskedSnapshotLogger, recordDestroyEvent } from './helpers.js';
import type { HeldStackLock } from '../stack-lock-guard.js';

/** What {@link deleteStackResource} reads from `destroyStackUnderLock`. */
export interface DeleteResourceFrame {
  lock: HeldStackLock;
  state: StackState;
  ctx: DestroyRunnerContext;
  stackName: string;
  logger: DestroyLogger;
  result: DestroyRunnerResult;
  renderer: ReturnType<typeof getLiveRenderer>;
  blockedBy: Map<string, string>;
  blockedIds: string[];
  blockDependenciesOf: (logicalId: string) => void;
  retainedForReadoption: RetainedResource[];
  startRetainedEarlierRead: () => void;
  skippedStateTargets: Set<string>;
  failedStateTargets: Set<string>;
  stateTargetFor: (logicalId: string, resourceType: string) => string;
  guardIndeterminateTargets: Set<string>;
  remainingResources: Record<string, ResourceState>;
  persistStateAfterDelete: (logicalId: string) => void;
  printingBagOf: (logicalId: string) => RecordedSecretValues;
  destroyProviderRegistry: DestroyRunnerContext['providerRegistry'];
  destroyAwsClients: AwsClients | undefined;
  secretPrincipalRegions: string[] | undefined;
  secretPrincipalRegionsIncomplete: boolean;
}

/**
 * One resource's delete in the reverse-DAG loop, run under its printing bag:
 * the blocked / retained / unaddressable arms, the final snapshot, the
 * retried provider delete under its deadline, and the outcome's counters,
 * events and state persist.
 */
export async function deleteStackResource(
  {
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
  }: DeleteResourceFrame,
  logicalId: string,
  stackRegion: string
): Promise<void> {
  // Graceful SIGINT (issue #816): if the interrupt landed after this
  // level's promises were created but before this resource's delete was
  // dispatched, skip it. It stays in the preserved state for re-run.
  // (Deletes already in flight when the interrupt arrives are NOT
  // cancelled — they run to completion; only not-yet-dispatched ones
  // bail here.)
  if (lock.interrupted) return;

  const resource = state.resources[logicalId];
  if (!resource) {
    logger.warn(`Resource ${displaySafe(logicalId)} not found in state, skipping`);
    return;
  }

  // go-to-k/cdkd#5670: the delete of a resource that depends on this
  // one failed, so this one is not touched -- not even retained, which
  // would drop its record while a re-run may still need it. The
  // record stays for the re-run, as a skip's does.
  const blocker = blockedBy.get(logicalId);
  if (blocker !== undefined) {
    const blockReason = `${blocker} depends on it and its delete failed`;
    logger.info(
      safeMsg`  ${formatResourceLine('skipped', logicalId, resource.resourceType, `not deleted (${blockReason})`)}`
    );
    result.blockedCount++;
    blockedIds.push(logicalId);
    recordDestroyEvent(ctx.eventRecorder, {
      eventType: 'RESOURCE_SKIPPED',
      stackName,
      operation: 'DELETE',
      logicalId,
      resourceType: resource.resourceType,
      ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
      ...(resource.physicalId && { physicalId: resource.physicalId }),
      reason: blockReason,
    });
    return;
  }

  // Schema v5+: honor `state.deletionPolicy: Retain` / `RetainExceptOnCreate`.
  // The AWS resource is kept; only the cdkd state record is dropped
  // (state.json is removed wholesale at the end of a clean destroy).
  // Pre-v5 state has `deletionPolicy: undefined` here, so this branch
  // is a no-op on legacy state — preserves the pre-PR "delete every
  // resource in state" behavior for users who haven't redeployed yet.
  if (shouldRetainResource(resource.deletionPolicy)) {
    logger.info(
      `  ⊘ ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) retained — DeletionPolicy: ${displaySafe(resource.deletionPolicy)}`
    );
    result.retainedCount++;
    // go-to-k/cdkd#4705: a kept resource a later create of this stack
    // takes back by its generated name is recorded for that create;
    // go-to-k/cdkd#5064: every kept generated-name resource is, so the
    // next lifetime's first deploy can name `cdkd import` for it.
    if (keptForRetainedRecord(resource)) {
      retainedForReadoption.push({
        logicalId,
        resourceType: resource.resourceType,
        physicalId: resource.physicalId,
      });
      startRetainedEarlierRead();
    }
    recordDestroyEvent(ctx.eventRecorder, {
      eventType: 'RESOURCE_RETAINED',
      stackName,
      operation: 'DELETE',
      logicalId,
      resourceType: resource.resourceType,
      ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
    });
    return;
  }

  // go-to-k/cdkd#3211: a row with no usable physical id cannot be
  // ADDRESSED, so it takes issue #1752's skip — record kept, state
  // preserved, never a provider call. Per resource rather than refused at
  // the load: `isReadableResourceEntry` stops at `resourceType` by a
  // recorded decision, and the deploy accepts such a row. What the call
  // would have done is the reason it may not be made: the provider
  // addresses AWS by whatever the field holds, and the catch below reads
  // the resulting `*NotFound` as ALREADY DELETED, dropping the record of a
  // resource that is still live. BELOW the retention branch, which never
  // addresses the resource. A nested-stack row is EXEMPT: its delete finds
  // the child by `<parent>~<logicalId>` and never reads the id, so a skip
  // would leave every child resource standing and point the remedy at the
  // CHILD's record (`stateTargetFor`) while the torn field is the parent's.
  // A provider whose delete is a no-op is NOT exempted, deliberately: the
  // runner cannot see which providers ignore the id, and keeping a record
  // a repair clears is the safe direction.
  if (
    resource.resourceType !== NESTED_STACK_TYPE &&
    (typeof resource.physicalId !== 'string' || resource.physicalId.trim() === '')
  ) {
    const skipReason = 'state record has no physical id';
    logger.warn(
      `Resource ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) has no ` +
        `non-empty string 'physicalId' in its state record, so cdkd cannot address it in ` +
        `AWS and did not try to delete it. Repairing the record in state.json and re-running ` +
        `helps; the record is kept.`
    );
    logger.info(
      `  ${formatResourceLine('skipped', logicalId, resource.resourceType, `skipped (${skipReason})`)}`
    );
    result.skippedCount++;
    skippedStateTargets.add(stateTargetFor(logicalId, resource.resourceType));
    recordDestroyEvent(ctx.eventRecorder, {
      eventType: 'RESOURCE_SKIPPED',
      stackName,
      operation: 'DELETE',
      logicalId,
      resourceType: resource.resourceType,
      ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
      reason: skipReason,
    });
    return;
  }

  const baseLabel = `Deleting ${logicalId} (${resource.resourceType})`;
  renderer.addTask(logicalId, baseLabel);
  const resourceStartedAt = Date.now();
  recordDestroyEvent(ctx.eventRecorder, {
    eventType: 'RESOURCE_STARTED',
    stackName,
    operation: 'DELETE',
    logicalId,
    resourceType: resource.resourceType,
    ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
  });
  try {
    // Honor `DeletionPolicy: Snapshot` (issues #1352 / #1353) — the
    // template-less twin of the deploy engine's DELETE-branch gating:
    // atomic final-snapshot delete param for the SDK-routed Tier-A
    // types, pre-delete snapshot+wait for the CC-routed
    // `PRE_DELETE_SNAPSHOT_TYPES`, refusal otherwise (opt out with
    // `--skip-final-snapshot`). No recorded `deletionPolicy` (pre-v5
    // state, or a template without the attribute) is CloudFormation's
    // default: `Snapshot` for an RDS cluster or standalone instance
    // (issue #4030), else a plain delete.
    let finalSnapshotIdentifier: string | undefined;
    const policy = effectiveDeletionPolicy(
      resource.resourceType,
      resource.deletionPolicy,
      resource.properties
    );
    if (policy === 'Snapshot' && ctx.skipFinalSnapshot !== true) {
      if (
        ATOMIC_FINAL_SNAPSHOT_TYPES.has(resource.resourceType) &&
        resource.provisionedBy !== 'cc-api'
      ) {
        finalSnapshotIdentifier = buildFinalSnapshotIdentifier(
          resource.physicalId,
          resource.resourceType
        );
      } else if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resource.resourceType)) {
        // cc-api-routed atomic type: Cloud Control DeleteResource has
        // no final-snapshot parameter — refuse instead of silently
        // dropping the promised snapshot. A live RDS read replica or
        // cluster member is deleted without one, as CloudFormation does
        // (go-to-k/cdkd#6047).
        const takesNoSnapshot = await ccRoutedInstanceTakesNoSnapshot({
          resourceType: resource.resourceType,
          logicalId,
          physicalId: resource.physicalId,
          region: stackRegion,
          logger,
          mask: createUnionSecretMasker([printingBagOf(logicalId)]),
        });
        if (!takesNoSnapshot) {
          throw ccRoutedFinalSnapshotError(
            logicalId,
            resource.resourceType,
            '--skip-final-snapshot'
          );
        }
      } else if (PRE_DELETE_SNAPSHOT_TYPES.has(resource.resourceType)) {
        // destroyAwsClients is the region-scoped set when the stack
        // lives in a different region than the caller's base clients.
        await createPreDeleteFinalSnapshot(
          resource.resourceType,
          resource.physicalId,
          logicalId,
          destroyAwsClients ?? ctx.baseAwsClients,
          // The delete's own masker, as its DeleteContext carries: the
          // snapshot helper's debug line quotes a withheld AWS failure's
          // text (go-to-k/cdkd#2319).
          maskedSnapshotLogger(logger, createUnionSecretMasker([printingBagOf(logicalId)]))
        );
      } else {
        throw unsupportedFinalSnapshotError(
          logicalId,
          resource.resourceType,
          '--skip-final-snapshot'
        );
      }
    }

    // Schema v7+ (#614): route DELETE via state-recorded
    // `provisionedBy` so a CC-managed resource is deleted via Cloud
    // Control even if the SDK provider has since gained coverage.
    // Pre-v7 state has `provisionedBy: undefined` which the registry
    // treats as legacy `'sdk'` semantics (matches behavior before
    // this PR shipped).
    const provider = destroyProviderRegistry.getProviderFor({
      resourceType: resource.resourceType,
      provisionedBy: resource.provisionedBy,
    }).provider;

    // Per-resource-type overrides (v2) win over the global default.
    // Resolution order:
    //   1. per-type CLI override (`--resource-timeout TYPE=DURATION`).
    //   2. provider self-report raised against the global default
    //      (`max(getMinResourceTimeoutMs(), globalCli)`).
    //   3. CLI global default (`--resource-timeout 30m`).
    //   4. compile-time default (DEFAULT_RESOURCE_*_MS).
    const providerMinTimeoutMs = provider.getMinResourceTimeoutMs?.() ?? 0;
    const warnAfterMs =
      ctx.resourceWarnAfterByType?.[resource.resourceType] ??
      ctx.resourceWarnAfterMs ??
      DEFAULT_RESOURCE_WARN_AFTER_MS;
    const globalTimeoutMs = ctx.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
    // Known-slow types (OpenSearch domains, RDS / Redshift / ElastiCache
    // clusters) lift the outer deadline to match the CC inner poll cap so
    // a slow DELETE is not aborted by the 30-min default. A per-type CLI
    // override still wins (explicit escape hatch).
    const slowTypeMinTimeoutMs = slowCcOperationTimeoutMs(resource.resourceType, 'DELETE');
    const timeoutMs =
      ctx.resourceTimeoutByType?.[resource.resourceType] ??
      Math.max(providerMinTimeoutMs, slowTypeMinTimeoutMs, globalTimeoutMs);

    // Issue #1752: what the provider actually DID. `undefined` (the
    // back-compat `void` return) means "deleted"; a `'skipped'` outcome
    // means no AWS call was issued and the resource may still be alive.
    let deleteResult: ResourceDeleteResult | undefined;
    // go-to-k/cdkd#4738: what a nested child left in AWS with no
    // record (its journaled orphans), reported through the #1989 slot
    // by a nested-stack row that is otherwise deleted.
    let childLeftInAws = 0;
    // go-to-k/cdkd#4150: ONE opt-in object per resource, so every retry
    // below shares its `retryMemo`. go-to-k/cdkd#4879: with the regions
    // the record's v12 provenance names, read from the record in hand
    // (no AWS call).
    const recordedRegions =
      secretPrincipalRegions !== undefined ? recordedReferenceRegions(resource) : undefined;
    const secretPrincipalOptIn =
      secretPrincipalRegions !== undefined
        ? {
            importedProducerRegions: secretPrincipalRegions,
            ...(secretPrincipalRegionsIncomplete && { producerRegionsIncomplete: true }),
            retryMemo: { detached: new Set<string>() },
            ...(recordedRegions !== undefined && { recordedRegions }),
          }
        : undefined;

    // Wrap the entire retry loop in the per-resource deadline so a
    // genuinely-stuck delete (e.g. a hung Custom Resource handler or
    // a Cloud-Control polling loop that never terminates) aborts
    // instead of holding the destroy forever.
    await withResourceDeadline(
      async () => {
        // Retry DELETE for transient errors (throttle, dependency race).
        // Providers that opt out of outer retry (e.g. Custom Resources,
        // whose delete generates a fresh pre-signed S3 URL each call)
        // run exactly once.
        const maxAttempts = provider.disableOuterRetry ? 0 : 3;
        // go-to-k/cdkd#4682: today's values at the record's masked
        // NoEcho coordinates, re-resolved from the template this destroy
        // holds, for the two types that read them, inside the deadline
        // (it can reach SSM / STS). Never persisted or logged;
        // `undefined` keeps the provider's skip.
        const noEchoDeleteValues = readsNoEchoDeleteValues(resource.resourceType)
          ? await ctx.noEchoReresolver?.valuesFor(logicalId, resource)
          : undefined;
        let lastDeleteError: unknown;
        for (let attempt = 0; attempt <= maxAttempts; attempt++) {
          try {
            // Issue #4318: the attempt scope tells a `--remove-protection`
            // compensation whether this is the LAST attempt, where a
            // retryable failure still ends the delete.
            const { value: outcome, unaddressed } = await runDeleteAttempt(
              attempt >= maxAttempts,
              () =>
                // go-to-k/cdkd#4492: only a RETAINED record outlives the
                // destroy, so a resource it shares stays in place.
                collectNestedChildUnaddressed(() =>
                  withStackRecords(destroyStackRecordsView(state.resources), () =>
                    provider.delete(
                      logicalId,
                      resource.physicalId,
                      resource.resourceType,
                      resource.properties,
                      {
                        ...(state.region !== undefined && { expectedRegion: state.region }),
                        ...(ctx.removeProtection === true && { removeProtection: true }),
                        ...(finalSnapshotIdentifier !== undefined && {
                          finalSnapshotIdentifier,
                        }),
                        // Issue #4029: the EFFECTIVE policy, absent read as
                        // CloudFormation's `Delete` (RDS's `Snapshot` default is
                        // already in `policy`).
                        deletionPolicy: policy ?? 'Delete',
                        ...(ctx.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
                        ...(secretPrincipalOptIn !== undefined && {
                          resolveSecretDerivedPrincipals: secretPrincipalOptIn,
                        }),
                        // Issue #4157: the identity evidence of the record deleted.
                        recordedAttributes: resource.attributes,
                        recordedCreateOnlyDrops: resource.acceptedCreateOnlyDrops,
                        // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
                        recordedNoEchoLeaves: resource.noEchoLeaves,
                        ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
                        ...(ctx.noEchoReresolver !== undefined && {
                          noEchoReresolver: ctx.noEchoReresolver,
                        }),
                        // go-to-k/cdkd#2115: only a whole-stack teardown.
                        ...(ctx.stackDestroy === true && { stackDestroy: true }),
                        // go-to-k/cdkd#2007: the printing bag this delete
                        // runs under, so a provider that asks whether a
                        // name is secret-derived sees what the sink masks.
                        maskSecrets: createUnionSecretMasker([printingBagOf(logicalId)]),
                      }
                    )
                  )
                )
            );
            // Assign INSIDE the loop, not after it: the loop can
            // reach this line on a LATER attempt after an earlier one
            // threw, and the outcome must be that attempt's. (It can
            // never overwrite a previous non-throwing attempt — the
            // `break` below ends the loop on the first one.)
            deleteResult = outcome ?? undefined;
            childLeftInAws = unaddressed?.deleteSkipped ?? 0;
            lastDeleteError = null;
            break;
          } catch (retryError) {
            lastDeleteError = retryError;
            // Delegate transient-error classification to the shared
            // classifier so this destroy path (`cdkd destroy` /
            // `cdkd state destroy`) honors the same retryable patterns
            // as the deploy-engine delete loop — including the Lambda
            // EventSourceMapping "because it is in use" teardown lock
            // surfaced by the multi-resource real-AWS sweep (2026-06-02),
            // which the prior inline 4-pattern list silently failed
            // fast on. `'Too Many Requests'` (throttle) stays matched
            // explicitly: the wrapped ProvisioningError message carries
            // the phrasing even when the original 429 `$metadata` is
            // lost across the wrap.
            // Issue #1778: the `Too Many Requests` arm is load-bearing
            // (see above) but it is a raw message test, so it bypassed
            // the non-retryable marker the shared classifier honors —
            // the same hole `retry.ts` had for custom classifiers. The
            // marker gates BOTH arms rather than replacing either: a
            // deliberate cdkd refusal is terminal even if its message
            // happens to carry a throttle phrase, and a genuine throttle
            // (never marked) still retries exactly as before.
            // Issue #2302: BOTH arms classify on the chain text, not on
            // `msg`. This loop calls `provider.delete` directly rather
            // than through `withRetry`, so it is a SECOND message
            // classifier and `retry.ts`'s fix does not reach it. A
            // provider that redacts its thrown message (the S3 bucket
            // wraps do) empties exactly what both arms match on:
            // measured, `conflicting conditional operation` -- S3's
            // `OperationAborted`, HTTP 409 with a non-throttle name, so
            // neither `isThrottlingError` nor `isTransientServerError`
            // sees it and the substring was the ONLY arm -- went from
            // retryable to terminal. The `Too Many Requests` arm is worse
            // still: it exists (see above) precisely for the case where
            // the original 429 `$metadata` is LOST across the wrap, so
            // the message is the only carrier it has.
            //
            // This string is the union of what the redaction withholds
            // and must never be printed. Nothing here logs it: the
            // per-attempt line names only the resource and the backoff,
            // and the error itself is rethrown for the caller to report --
            // which is why the `msg` binding this replaced is GONE rather
            // than kept, unlike `retry.ts`'s, whose `message` still feeds
            // a `warn` and a `debug`.
            const classify = retryClassificationText(retryError);
            const isRetryable =
              !isMarkedNonRetryable(retryError) &&
              (isRetryableTransientError(retryError, classify) ||
                classify.includes('Too Many Requests'));
            if (!isRetryable || attempt >= maxAttempts) break;
            const delay = 5000 * Math.pow(2, attempt);
            logger.debug(
              `  ⏳ Retrying delete ${displaySafe(logicalId)} in ${delay / 1000}s (attempt ${attempt + 1}/${maxAttempts})`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
        if (lastDeleteError) throw lastDeleteError;
      },
      {
        warnAfterMs,
        timeoutMs,
        onWarn: (elapsedMs) => {
          const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
          renderer.updateTaskLabel(
            logicalId,
            `${baseLabel} [taking longer than expected, ${minutes}m+]`
          );
          renderer.printAbove(() => {
            logger.warn(
              `${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) has been deleting for ${minutes}m — still waiting`
            );
          });
        },
        onTimeout: (elapsedMs) =>
          new ResourceTimeoutError(
            logicalId,
            resource.resourceType,
            stackRegion,
            elapsedMs,
            'DELETE',
            timeoutMs
          ),
      }
    );

    renderer.removeTask(logicalId);

    // Issue #2301 item 3: a PRE-FLIGHT SAFETY GUARD that ran and could
    // not reach a verdict. Recorded BEFORE the outcome branch below, so
    // it applies to every outcome the branch can take — the guard runs
    // ahead of the delete and its verdict does not depend on how the
    // delete ended.
    //
    // ADDITIONAL to the resource's own RESOURCE_SUCCEEDED /
    // RESOURCE_SKIPPED row, never a replacement for it, which is the
    // shape issue #1819's partial-UPDATE skip already established. The
    // alternative (emit this INSTEAD of RESOURCE_SUCCEEDED) was rejected
    // on two grounds: it would delete the only per-resource success
    // signal existing consumers read, leaving a RESOURCE_STARTED with no
    // terminal row for that logical id; and `counts.deleted` on
    // RUN_FINISHED is driven by `deletedCount`, which this deliberately
    // does not touch, so the run summary would then name a deleted
    // resource whose event stream never says it was deleted.
    for (const guard of deleteIndeterminateGuards(deleteResult)) {
      result.guardIndeterminateCount++;
      guardIndeterminateTargets.add(logicalId);
      recordDestroyEvent(ctx.eventRecorder, {
        eventType: 'RESOURCE_GUARD_INDETERMINATE',
        stackName,
        operation: 'DELETE',
        logicalId,
        resourceType: resource.resourceType,
        ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
        ...(resource.physicalId && { physicalId: resource.physicalId }),
        guard: guard.guard,
        reason: guard.reason,
        // No `durationMs`, unlike the sibling rows: the guard ran BEFORE
        // the delete, so `Date.now() - resourceStartedAt` here would be
        // the DELETE's elapsed time wearing the guard's label. `timestamp`
        // already orders the row, and a field whose value means something
        // other than what its name says is worse than an absent one.
      });
    }

    // Issue #1752: a provider reporting `'skipped'` did not confirm the
    // delete — it could not ADDRESS the resource (no AWS call), or, since
    // issue #2054, a custom-resource Delete handler ran and refused — so
    // the resource may still be alive. Print a distinct
    // line, count it separately, and — critically — do NOT drop the
    // state record: without it the user has neither the AWS resource
    // deleted nor a cdkd record pointing at it, and no way to retry.
    if (deleteResult?.outcome === 'skipped') {
      // `reason` is REQUIRED by the discriminated union, so the line
      // always names a cause — a bare `skipped` would be barely more
      // useful than the `deleted` it replaced. Read through the shared
      // `deleteSkipReason` (issue #1762) rather than off the field, so
      // an untyped producer that omits it renders the same
      // `UNSPECIFIED_SKIP_REASON` here as on the deploy side instead of
      // printing `skipped (undefined)` and storing `reason: undefined`
      // in the durable event.
      const skipReason = deleteSkipReason(deleteResult) ?? UNSPECIFIED_SKIP_REASON;
      logger.info(
        `  ${formatResourceLine(
          'skipped',
          logicalId,
          resource.resourceType,
          `skipped (${skipReason})`
        )}`
      );
      result.skippedCount++;
      skippedStateTargets.add(stateTargetFor(logicalId, resource.resourceType));
      recordDestroyEvent(ctx.eventRecorder, {
        eventType: 'RESOURCE_SKIPPED',
        stackName,
        operation: 'DELETE',
        logicalId,
        resourceType: resource.resourceType,
        ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
        ...(resource.physicalId && { physicalId: resource.physicalId }),
        // The events store is the DURABLE post-mortem, and a bare
        // `RESOURCE_SKIPPED` there cannot tell the user why cdkd did not
        // confirm the delete. `reason` is required on the
        // `'skipped'` arm, and the shared reader defaults it when a
        // producer omits it anyway, so this is always populated.
        reason: skipReason,
        durationMs: Date.now() - resourceStartedAt,
      });
      // Deliberately NO `delete remainingResources[logicalId]` and no
      // persist call — the record must survive into the preserve-write
      // at the end of the run.
      return;
    }

    // go-to-k/cdkd#4738: a nested child that left resources in AWS
    // with no record. The child stack is gone, state included, so its
    // row is dropped like any deleted one; what it left counts as
    // skips that keep no record (exit 2). `formatResourceLine` passes
    // the verb through `displaySafe`.
    const leftInAws =
      childLeftInAws > 0
        ? (deleteLeftInPlace(deleteResult) ??
          `${childLeftInAws} resource(s) a failed deploy created were left in AWS`)
        : undefined;
    const deletedLine =
      leftInAws !== undefined
        ? formatResourceLine('skipped', logicalId, resource.resourceType, `deleted (${leftInAws})`)
        : formatResourceLine('deleted', logicalId, resource.resourceType);
    logger.info(`  ${deletedLine}`);
    result.skippedCount += childLeftInAws;
    result.journaledOrphanSkips += childLeftInAws;
    result.deletedCount++;
    recordDestroyEvent(ctx.eventRecorder, {
      eventType: 'RESOURCE_SUCCEEDED',
      stackName,
      operation: 'DELETE',
      logicalId,
      resourceType: resource.resourceType,
      ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
      ...(resource.physicalId && { physicalId: resource.physicalId }),
      durationMs: Date.now() - resourceStartedAt,
    });
    if (leftInAws !== undefined) {
      // Beside the row's own success, as #1819's partial update: the
      // child's run records no events, so this is the durable trace of
      // the skips RUN_FINISHED counts. No `physicalId`: the survivors
      // are the child's, named only in its warnings.
      recordDestroyEvent(ctx.eventRecorder, {
        eventType: 'RESOURCE_SKIPPED',
        stackName,
        operation: 'DELETE',
        logicalId,
        resourceType: resource.resourceType,
        ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
        reason: leftInAws,
        durationMs: Date.now() - resourceStartedAt,
      });
    }
    delete remainingResources[logicalId];
    persistStateAfterDelete(logicalId);
  } catch (error) {
    renderer.removeTask(logicalId);
    const msg = describeAwsFailure(error).detail;
    // Treat "not found" as already deleted — but NEVER for a typed
    // final-snapshot failure (issue #1352): the snapshot step runs
    // BEFORE the delete, so its error means the resource is still
    // live; reading a snapshot-poll NotFound as "already deleted"
    // would drop a live, un-snapshotted volume from state.
    //
    // ...and never for a USER ABORT either (issues #2053 / #1952), for the
    // same reason and by the same shape. This match is on the MESSAGE, and
    // an interrupt's message embeds a name the user chose — `DynamoDB
    // auto-scaling for ${tableName}`, `Custom resource ${logicalId}` — so
    // a logical id like `HandleNotFoundException` made an interrupted
    // delete read as "already deleted" and DROPPED a live resource's state
    // row while reporting success. The typed check has to come first
    // because the substring match cannot be made safe: any needle can
    // appear in a user-chosen name.
    //
    // ...and never for a DELIBERATE cdkd REFUSAL either (issue #2301) —
    // the third member of the same family, and the one this PR would
    // otherwise have introduced. `CloudControlProvider`'s pre-flight
    // region check refuses with a message that interpolates the LOGICAL
    // ID, so a construct id containing `NotFoundException` (or a CFn
    // logical id carried in by `--migrate-from-cloudformation`) would
    // make the refusal read as "already deleted": `deletedCount++`, the
    // state row dropped, success reported over a LIVE resource in
    // another region — the exact orphan class that guard exists to
    // prevent, arriving through its own throw. `isMarkedNonRetryable`
    // is the right predicate rather than a new error type: cdkd marks a
    // refusal non-retryable precisely because it is a deterministic
    // verdict rather than an AWS condition, and nothing AWS returns
    // carries the marker.
    // `isWaitAbandonedError` (issue go-to-k/cdkd#3236) is the fourth
    // member of this family and needs its own predicate rather than
    // riding `isMarkedNonRetryable`: a DELETE abandonment is
    // deliberately left RETRYABLE — the point is that this loop can
    // re-issue an idempotent delete — so it carries no non-retryable
    // marker and would fall straight through to the substring match.
    // Reading it as "already deleted" is the same orphan class the note
    // above describes, arriving from cdkd having stopped WATCHING a
    // delete rather than from a refusal.
    // `isMarkedNotGone` (go-to-k/cdkd#5228) is a provider's typed
    // verdict that the failure is not its resource's not-found. It is
    // apart from `isMarkedNonRetryable` so the retry loop above still
    // retries a transient failure that carries a needle.
    if (
      !isInterruptedWaitError(error) &&
      !isFinalSnapshotError(error) &&
      !isMarkedNonRetryable(error) &&
      !isWaitAbandonedError(error) &&
      !isMarkedNotGone(error) &&
      (msg.includes('does not exist') ||
        msg.includes('not found') ||
        msg.includes('No policy found') ||
        msg.includes('NoSuchEntity') ||
        msg.includes('NotFoundException'))
    ) {
      logger.debug(`  ${displaySafe(logicalId)} already deleted, removing from state`);
      result.deletedCount++;
      recordDestroyEvent(ctx.eventRecorder, {
        eventType: 'RESOURCE_SUCCEEDED',
        stackName,
        operation: 'DELETE',
        logicalId,
        resourceType: resource.resourceType,
        ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
        ...(resource.physicalId && { physicalId: resource.physicalId }),
        durationMs: Date.now() - resourceStartedAt,
      });
      delete remainingResources[logicalId];
      persistStateAfterDelete(logicalId);
    } else if (error instanceof ResourceTimeoutError) {
      // Surface the actionable timeout message wrapped as a
      // ProvisioningError (parity with deploy's failure path) and
      // count it as an error so the state file is preserved.
      const wrapped = new ProvisioningError(
        error.message,
        resource.resourceType,
        logicalId,
        resource.physicalId,
        error
      );
      logger.error(`  ✗ Failed to delete ${displaySafe(logicalId)}:`, wrapped.message);
      result.errorCount++;
      failedStateTargets.add(stateTargetFor(logicalId, resource.resourceType));
      blockDependenciesOf(logicalId);
      recordDestroyEvent(ctx.eventRecorder, {
        eventType: 'RESOURCE_FAILED',
        stackName,
        operation: 'DELETE',
        logicalId,
        resourceType: resource.resourceType,
        ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
        durationMs: Date.now() - resourceStartedAt,
        error: extractDeploymentEventError(wrapped),
      });
    } else {
      logger.error(`  ✗ Failed to delete ${displaySafe(logicalId)}:`, safeStringify(error));
      result.errorCount++;
      failedStateTargets.add(stateTargetFor(logicalId, resource.resourceType));
      blockDependenciesOf(logicalId);
      recordDestroyEvent(ctx.eventRecorder, {
        eventType: 'RESOURCE_FAILED',
        stackName,
        operation: 'DELETE',
        logicalId,
        resourceType: resource.resourceType,
        ...(resource.provisionedBy && { provisionedBy: resource.provisionedBy }),
        durationMs: Date.now() - resourceStartedAt,
        error: extractDeploymentEventError(error),
      });
    }
  } finally {
    renderer.removeTask(logicalId);
  }
}
