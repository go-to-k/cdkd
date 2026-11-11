/**
 * The delete-first replacement (`replaceDeleteFirstAndRecreate`) and its
 * failure-text wraps.
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import type { NoEchoDeleteValues } from '../../noecho-delete-reresolution.js';
import { InterruptedError } from '../../deploy-engine.js';
import { printingSecretsFor, secretNameBagFor } from '../masking.js';
import type {
  CreateContext,
  ResourceDeleteResult,
  ResourceProvider,
} from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import { green } from '../../../utils/colors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import { deleteSkipReason, deleteSkippedMessage } from '../../delete-outcome.js';
import { reportDeleteGuards } from '../../delete-guard-scope.js';
import { withCurrentResourceSecrets, withPrintingSecrets } from '../../resource-secrets-scope.js';
import { withRetry } from '../../retry.js';
import { refuseRestoreFromItself } from '../../../provisioning/restore-source-guard.js';
import { isRecreateRetryableError, markRedactedCause } from '../../retryable-errors.js';
import {
  type RecordedSecretValues,
  createSecretMasker,
  createUnionSecretMasker,
  maskSecretsInError,
  maskSecretsInText,
  unionOfSecretBags,
} from '../../secret-redaction.js';
import { replacementDeleteContext, prepareFinalSnapshotForDelete } from './delete-context.js';
import type { ReplacementRunState, ReplacementDeps } from './run-state.js';

/**
 * `--replace` delete-first fallback for a property-driven replacement of a
 * custom-named resource: delete the old name holder, then re-create it
 * under the same name. Shared by the create-first collision catch (issue
 * #960 follow-up) and the name-idempotent same-id guard (issue #1238) so
 * the two --replace escape hatches cannot drift apart.
 */
export async function replaceDeleteFirstAndRecreate(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  /** The TEMPLATE's type — what the re-create routes on. */
  resourceType: string,
  /**
   * The STATE RECORD's type — what the old resource's delete and final
   * snapshot route on (issue #2668). Equal to `resourceType` unless the
   * resource's `Type` changed.
   */
  oldResourceType: string,
  currentResource: ResourceState,
  oldDeleteProvider: ResourceProvider,
  replaceProvider: ResourceProvider,
  replaceProps: Record<string, unknown>,
  // Issue #1932 item 3. A PARAMETER rather than a field read inside the
  // method: this helper is shared by both --replace escape hatches, and both
  // call it from the UPDATE case where the resolution pass's own bag is in
  // scope. Reading `perResourceSecrets` here instead would work today but
  // would bind the masker to a map looked up by logical id rather than to
  // the bag the caller actually resolved with, which is a different (and
  // silently wrong under concurrency) thing.
  //
  // Issue #2038 review: it is the BAG, not the finished `CreateContext`, for
  // exactly that reason. The retry logger and the two wrap messages below
  // need the same bag the masker is built from, and re-deriving it from
  // `perResourceSecrets` inside this method would have made the file state
  // the rule above and then break it three lines on. The `CreateContext` is
  // built here from this argument, so the provider call is unchanged.
  secrets: RecordedSecretValues,
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  /** The layer `oldDeleteProvider` was routed to, for a guard row (issue #2422). */
  oldDeleteProvisionedBy: 'sdk' | 'cc-api' | undefined,
  /** go-to-k/cdkd#4682: today's values at the old record's NoEcho coordinates. */
  noEchoDeleteValues?: NoEchoDeleteValues
): Promise<Awaited<ReturnType<ResourceProvider['create']>>> {
  // go-to-k/cdkd#5638: before the delete, which is what would lose the source.
  refuseRestoreFromItself(resourceType, replaceProps, currentResource.physicalId, logicalId, {
    region: deps.stackRegion,
    account: deps.options.consumerAccount,
    attributes: currentResource.attributes,
  });
  const createContext: CreateContext = { maskSecrets: createSecretMasker(secrets) };
  // go-to-k/cdkd#2007: the bag this deploy resolved plus the name bag, which
  // covers a physical id derived from a secret: the old resource's delete and
  // its final snapshot's lines log under it.
  const deleteMask = createUnionSecretMasker([
    secrets,
    secretNameBagFor(deps.secretsRun(), logicalId),
  ]);
  // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the OLD
  // resource before the replacement delete, exactly like the destroy
  // paths honor `DeletionPolicy: Snapshot`. Deliberately OUTSIDE the
  // delete's try: a snapshot failure/refusal here must surface with its
  // own typed FINAL_SNAPSHOT_* error, not be rewrapped as "Failed to
  // delete old resource ..." for a delete that was never attempted.
  const finalSnapshotIdentifier = await prepareFinalSnapshotForDelete(
    deps,
    logicalId,
    oldResourceType,
    currentResource,
    updateReplacePolicy,
    deleteMask
  );
  let deleteResult: void | ResourceDeleteResult;
  try {
    deleteResult = await withPrintingSecrets(secrets, () =>
      oldDeleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        oldResourceType,
        currentResource.properties,
        {
          expectedRegion: deps.stackRegion,
          // Replacement delete: `--force-stateful-recreation` is the user's
          // explicit data-loss consent, so thread it to the provider's data
          // guard (issue #1340).
          forceDataDelete: deps.options.forceStatefulRecreation === true,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          ...replacementDeleteContext(deps, updateReplacePolicy),
          recordedAttributes: currentResource.attributes,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: currentResource.noEchoLeaves,
          ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
          // go-to-k/cdkd#2007: the bag this deploy resolved, which the call
          // also logs under; the physical id can be a name it derives.
          maskSecrets: deleteMask,
        }
      )
    );
  } catch (deleteError) {
    // Mirror the recreate-flagged path's wrapping: the delete is
    // load-bearing here (without it the re-create collides again).
    //
    // Issue #2038: masked at CONSTRUCTION, not only where it is logged. This
    // message lands in `provisionResource`'s `error` line, in the durable
    // `RESOURCE_FAILED` event, and in the `ProvisioningError` cause — all
    // three of which mask it again, so double-masking is a no-op. Masking
    // here means the plaintext never exists inside a thrown `Error` at all,
    // so a future reader of the `cause` chain cannot re-open the hole. The
    // delete's own payload is the STATE record, which is redacted; the wrap
    // is masked because a provider re-creating from `replaceProps` can echo
    // the resolved value back through this catch.
    //
    // MEASURED UNFENCEABLE, deliberately kept: removing this mask (and the
    // twin on the re-create wrap below) leaves the whole unit suite green,
    // because every reader downstream masks independently. It is
    // defense-in-depth against a future change to one of those readers, not
    // a fence — do not record it in a PR body as a tested behavior.
    //
    // go-to-k/cdkd#1889: the delete's error is chained as `cause` so its
    // markers (`markNonRetryable`, wait-abandoned, `$metadata` / `Code` for
    // `extractDeploymentEventError`) survive the wrap — a wrap with no cause
    // severs every one of them. Chained through `maskSecretsInError` with the
    // same bag as the message, for the message mask's reason: a bare cause
    // would carry, in the chain `formatError` prints, the plaintext the
    // message mask removed, held off only by the downstream reader.
    // go-to-k/cdkd#2676: the message is flattened HERE, so it is masked here
    // with the PRINTING bag too (a secret-derived name, #4741's previous NoEcho
    // value): a later mask sees only the flattened text and misses a needle
    // that holds a newline.
    const shownSecrets = unionOfSecretBags([
      secrets,
      printingSecretsFor(deps.secretsRun(), logicalId),
    ]);
    // go-to-k/cdkd#2319: an AWS-authored failure (an SDK error a provider let
    // escape) is named by its class, with AWS's text in `debug`
    // ({@link fallbackFailureText}). Nothing between here and the DAG
    // executor reads this message for "already gone".
    const deleteText = fallbackFailureText(
      deps,
      deleteError,
      shownSecrets,
      (failure) =>
        // Each value masked BEFORE `safeMsg` flattens it (go-to-k/cdkd#2676): a
        // flattened newline inside a secret would no longer match its needle.
        safeMsg`Failed to delete old resource ${maskSecretsInText(logicalId, shownSecrets)} ` +
        safeMsg`(${maskSecretsInText(currentResource.physicalId, shownSecrets)}) ` +
        `during the --replace delete-first fallback: ` +
        // go-to-k/cdkd#2676: the wrapped error's (masked) message is embedded
        // as-is and LAST: it can end in cdkd's own remedy command lines.
        safeMsg`${asIsMessage(failure)}`
    );
    throw stampRedacted(
      new Error(deleteText.message, {
        cause: deleteError instanceof Error ? maskSecretsInError(deleteError, secrets) : undefined,
      }),
      deleteText.redacted
    );
  }
  // Issue #1762: a skip here FAILS the resource, unlike the template-DELETE
  // branch. The old resource is still alive and the whole point of this
  // path is that the re-create needs its name released — proceeding would
  // either collide or, for a type with no name conflict, leave two live
  // resources with state describing one. Checked outside the catch above so
  // the wrapping never sees it (a return value, not a throw).
  // Issue #2422: before the skip check below, which throws.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType: oldResourceType,
    provisionedBy: oldDeleteProvisionedBy,
  });
  const replaceSkipReason = deleteSkipReason(deleteResult);
  if (replaceSkipReason !== undefined) {
    throw new Error(
      deleteSkippedMessage(
        logicalId,
        currentResource.physicalId,
        replaceSkipReason,
        'during the --replace delete-first fallback'
      )
    );
  }
  deps.logger.info(safeMsg`  ${green('✓')} Old resource deleted`);
  run.oldDeletedBeforeCreate.add(logicalId);
  // go-to-k/cdkd#5131: a type whose delete returns while AWS still holds the
  // name (a DynamoDB table, DELETING) waits here, where the delete is known to
  // be this run's own; no other path pays it.
  await oldDeleteProvider.waitForNameReleased?.(
    logicalId,
    currentResource.physicalId,
    oldResourceType,
    {
      isInterrupted: () => deps.userInterrupted(),
      maskSecrets: (text) => maskSecretsInText(text, secrets),
    }
  );
  deps.logger.info(safeMsg`  Re-creating ${logicalId}...`);
  try {
    // Some providers return from delete() before the name is
    // actually released (async deletes: Step Functions, Kinesis,
    // Pipes DELETING state). "already exists" is deliberately
    // NOT in the transient-retry patterns, so give the re-create
    // its own bounded collision retry instead of failing fast
    // with the old resource already gone. SQS additionally
    // enforces a ~60s same-name re-creation cooldown after the
    // delete (QueueDeletedRecently, issue #1206) — the schedule
    // (2s/4s/8s then capped at 10s over 8 retries ≈ 64s total
    // sleep) covers the full cooldown window even when the inner
    // generic retry's budget is exhausted first.
    return await withRetry(
      () =>
        deps.withRetry(
          // Issue #1903, same scope as the ordinary CREATE path: bind the
          // resolved-secrets bag around every provider create, so no
          // replacement route can silently skip the nested-stack seed.
          () =>
            withCurrentResourceSecrets(secrets, () =>
              replaceProvider.create(logicalId, resourceType, replaceProps, createContext)
            ),
          logicalId,
          undefined,
          undefined,
          replaceProvider,
          // The old resource is gone: only the user's interrupt stops it.
          true
        ),
      logicalId,
      {
        maxRetries: 8,
        initialDelayMs: 2_000,
        maxDelayMs: 10_000,
        // Issue #2038: `replaceProps` is RESOLVED, so mask the AWS message
        // this retry echoes. Bound to the CALLER's bag (the `secrets`
        // parameter above), not looked up by logical id -- see
        // `DeployEngine.maskingRetryLoggerFor`.
        logger: deps.maskingRetryLoggerFor(secrets),
        // The old resource is already deleted: only the user's interrupt
        // stops this re-create. A sibling's failure (which sets the same
        // flag) left the stack with neither copy (generated-name-lifecycle A5).
        isInterrupted: () => deps.userInterrupted(),
        onInterrupted: () => new InterruptedError('user'),
        isRetryable: isRecreateRetryableError,
      }
    );
  } catch (recreateError) {
    // The old resource is ALREADY deleted at this point — say so,
    // because state still records it and the next deploy's UPDATE
    // would otherwise chase a resource that no longer exists.
    //
    // Issue #2038: masked at construction, same reason as the delete wrap
    // above — and more acutely, since THIS one wraps a create that was
    // handed the RESOLVED `replaceProps`.
    //
    // Issue #2616 swept this site alongside its twin in the
    // UPDATE-not-supported fallback. The `cause` is chained through
    // `maskSecretsInError` with the message's bag, like the delete wrap
    // above (go-to-k/cdkd#1889). `provisionResource`'s catch masks the whole
    // chain again further up, so this is the same defense-in-depth as the
    // message mask: no resolved secret value exists inside the thrown chain.
    // (A name derived from a secret is masked only there, by the printing
    // bag `printingSecretsFor` adds.) The `cause` is what keeps the AWS
    // rejection behind the sentence readable — `extractDeploymentEventError`
    // walks the chain for `$metadata` / `Code`, so an unchained wrap sends a
    // `RESOURCE_FAILED` event with no `awsErrorCode` at all. Nothing between
    // here and the DAG executor re-classifies the throw (the retry loop is
    // the `withRetry` above, already exhausted), so chaining cannot revive a
    // retry off the cause's text.
    // go-to-k/cdkd#2676: the message is flattened HERE, so it is masked here
    // with the PRINTING bag too (a secret-derived name, #4741's previous NoEcho
    // value): a later mask sees only the flattened text and misses a needle
    // that holds a newline.
    const shownSecrets = unionOfSecretBags([
      secrets,
      printingSecretsFor(deps.secretsRun(), logicalId),
    ]);
    // go-to-k/cdkd#2319: as the delete wrap above ({@link fallbackFailureText}).
    const recreateText = fallbackFailureText(
      deps,
      recreateError,
      shownSecrets,
      (failure) =>
        safeMsg`Failed to re-create ${maskSecretsInText(logicalId, shownSecrets)} after the ` +
        safeMsg`--replace delete-first fallback already deleted the old resource (${maskSecretsInText(currentResource.physicalId, shownSecrets)}). ` +
        // go-to-k/cdkd#2676: the wrapped error's (masked) message is embedded
        // as-is and LAST: it can end in cdkd's own remedy command lines.
        safeMsg`Re-run the deploy to create it fresh. Cause: ${asIsMessage(failure)}`
    );
    throw stampRedacted(
      new Error(recreateText.message, {
        cause:
          recreateError instanceof Error ? maskSecretsInError(recreateError, secrets) : undefined,
      }),
      recreateText.redacted
    );
  }
}

/**
 * The message of a `--replace` delete-first fallback wrap (go-to-k/cdkd#2319).
 *
 * The thrown message is persisted to `deployments/{runId}.jsonl`, and an
 * AWS-authored failure (an SDK error a provider let escape) names the caller's
 * ARN on an access denial: `build` then gets the error's class plus the
 * `--verbose` pointer, and the message built from AWS's own text goes to
 * `debug`. A cdkd-authored failure (a provider's own wrap) or a transport
 * error is passed through as before. Every text is masked with `secrets`
 * before `build` flattens it. `redacted` says to stamp the wrap
 * `markRedactedCause`, so a classifier reads the withheld text on the chain.
 */
function fallbackFailureText(
  deps: Pick<ReplacementDeps, 'logger'>,
  error: unknown,
  secrets: RecordedSecretValues,
  build: (failure: string) => string
): { message: string; redacted: boolean } {
  const failure = describeAwsFailure(error);
  const detail = maskSecretsInText(failure.detail, secrets);
  if (!failure.redacted) return { message: build(detail), redacted: false };
  deps.logger.debug(build(detail));
  return { message: build(maskSecretsInText(failure.summary, secrets)), redacted: true };
}

/** {@link markRedactedCause} when `redacted` and the wrap has a cause to read. */
function stampRedacted(error: Error, redacted: boolean): Error {
  return redacted && error.cause instanceof Error ? markRedactedCause(error) : error;
}
