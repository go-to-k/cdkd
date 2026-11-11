import { guardedReplacementCreate } from '../create.js';
import { InterruptedError, type DeployEngine } from '../../deploy-engine.js';
import { printingSecretsFor, secretNameBagFor } from '../masking.js';
import { prepareFinalSnapshotForDelete, replacementDeleteContext } from '../replacement.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { green } from '../../../utils/colors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { deleteSkipReason, deleteSkippedMessage } from '../../delete-outcome.js';
import { reportDeleteGuards } from '../../delete-guard-scope.js';
import { withCurrentResourceSecrets, withPrintingSecrets } from '../../resource-secrets-scope.js';
import { withRetry } from '../../retry.js';
import { isRecreateRetryableError, markRedactedCause } from '../../retryable-errors.js';
import {
  createSecretMasker,
  createUnionSecretMasker,
  maskSecretsInError,
  maskSecretsInText,
  unionOfSecretBags,
} from '../../secret-redaction.js';
import { noteRetainedResource } from '../../../provisioning/providers/create-token-ledger.js';
import { refuseRestoreFromItself } from '../../../provisioning/restore-source-guard.js';
import type { ReplacementArmInput } from './arm-input.js';

/**
 * `updateByReplacement`'s `--recreate-via-*` destroy-then-create arm
 * (`update-replace.ts`), split out of it (go-to-k/cdkd#5835). Returns the
 * replacement's create result.
 */
export async function recreateDestroyThenCreate(
  engine: DeployEngine,
  {
    currentResource,
    equalIdIsSameResource,
    logicalId,
    noEchoDeleteValues,
    oldDeleteProvider,
    oldDeleteRoute,
    oldResourceType,
    replaceDecision,
    replaceProps,
    replaceProvider,
    resolvedProps,
    resourceType,
    stackName,
    updateReplacePolicy,
    updateSecrets,
    recreateViaCcApi,
  }: ReplacementArmInput & { recreateViaCcApi: boolean }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
  let createResult: any;
  // go-to-k/cdkd#5638: before the delete, which is what would lose the source.
  refuseRestoreFromItself(resourceType, replaceProps, currentResource.physicalId, logicalId, {
    region: engine.stackRegion,
    account: engine.options.consumerAccount,
    attributes: currentResource.attributes,
  });
  // Destroy-then-create path. Same `UpdateReplacePolicy:
  // Retain` semantics — retained old resources leak (named the
  // same as the new); document via warning. CFn would refuse a
  // Retain + replace combo at template-author time; cdkd warns
  // and proceeds since the user explicitly opted in.
  const recreateFlagName = recreateViaCcApi
    ? '--recreate-via-cc-api'
    : '--recreate-via-sdk-provider';
  if (updateReplacePolicy === 'Retain') {
    // Issue #2603: the delete below is SKIPPED, so record that this
    // deploy left the old resource alive — the rollback classifier
    // reads this rather than re-deriving the verdict from the
    // previous state record's policy.
    engine.replacementRun.retainedOldOnReplacement.add(logicalId);
    // go-to-k/cdkd#4438: as on the create-first arm above.
    await noteRetainedResource(oldResourceType, logicalId);
    engine.logger.warn(
      safeMsg`  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} will ` +
        safeMsg`leak the old physical resource (${currentResource.physicalId}). The new ` +
        `resource shares the same name where applicable; if the type ` +
        `has user-supplied names (e.g. functionName, bucketName), the create will ` +
        `deterministically collide with the retained orphan.`
    );
  } else {
    engine.logger.info(
      safeMsg`  Destroying old ${logicalId} (${currentResource.physicalId}) before recreate...`
    );
    // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
    // old resource before the recreate's delete. OUTSIDE the try
    // so a snapshot failure/refusal keeps its typed
    // FINAL_SNAPSHOT_* error instead of being rewrapped as a
    // delete failure that never happened.
    const recreateFinalSnapshotId = await prepareFinalSnapshotForDelete(
      engine.replacementDeps(),
      logicalId,
      oldResourceType,
      currentResource,
      updateReplacePolicy,
      // The recreate delete's own masker (below), go-to-k/cdkd#2319.
      createUnionSecretMasker([updateSecrets, secretNameBagFor(engine.secretsRun, logicalId)])
    );
    let recreateDeleteResult: void | ResourceDeleteResult;
    try {
      recreateDeleteResult = await withPrintingSecrets(updateSecrets, () =>
        oldDeleteProvider.delete(
          logicalId,
          currentResource.physicalId,
          oldResourceType,
          currentResource.properties,
          {
            expectedRegion: engine.stackRegion,
            forceDataDelete: engine.options.forceStatefulRecreation === true,
            ...(recreateFinalSnapshotId !== undefined && {
              finalSnapshotIdentifier: recreateFinalSnapshotId,
            }),
            ...replacementDeleteContext(engine.replacementDeps(), updateReplacePolicy),
            recordedAttributes: currentResource.attributes,
            // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
            recordedNoEchoLeaves: currentResource.noEchoLeaves,
            ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
            // go-to-k/cdkd#2007: the bag the call logs under and the delete
            // error below is masked with.
            maskSecrets: createUnionSecretMasker([
              updateSecrets,
              secretNameBagFor(engine.secretsRun, logicalId),
            ]),
          }
        )
      );
    } catch (deleteError) {
      // Re-throw so the deploy engine's existing rollback path
      // sees the failure — recreate's destroy is load-bearing
      // (without it the subsequent create collides with the
      // pre-existing resource), so a swallowed failure would
      // produce a confusing AlreadyExists later.
      //
      // go-to-k/cdkd#1889: the delete's error is chained as `cause` so
      // its markers survive the wrap, through `maskSecretsInError` so the
      // chain carries no plaintext the message would not; the message is
      // masked at construction like the delete-first fallback's twin in
      // `replacement.ts`.
      // go-to-k/cdkd#2676: the message is flattened HERE, so it is masked here
      // with the PRINTING bag too (a secret-derived name, #4741's previous NoEcho
      // value): a later mask sees only the flattened text and misses a needle
      // that holds a newline.
      const shownSecrets = unionOfSecretBags([
        updateSecrets,
        printingSecretsFor(engine.secretsRun, logicalId),
      ]);
      // go-to-k/cdkd#2319: this message is persisted, and an AWS-authored
      // delete failure (a raw SDK or Cloud Control error) names the caller
      // on a denial. It is named by its class plus the `--verbose` pointer,
      // AWS's text goes to `debug` masked, and the wrap is stamped so a
      // classifier reads that text on the `cause` chain. A provider's own
      // wrap or a transport failure keeps its text.
      const deleteFailure = describeAwsFailure(deleteError);
      const destroyFailureText = (text: string): string =>
        // Each value masked BEFORE `safeMsg` flattens it (go-to-k/cdkd#2676).
        safeMsg`Failed to destroy old resource ${maskSecretsInText(logicalId, shownSecrets)} ` +
        safeMsg`(${maskSecretsInText(currentResource.physicalId, shownSecrets)}) during ${recreateFlagName}: ` +
        // go-to-k/cdkd#2676: the wrapped error's (masked) message is
        // embedded as-is and LAST: it can end in cdkd's own remedy lines.
        safeMsg`${asIsMessage(maskSecretsInText(text, shownSecrets))}`;
      if (deleteFailure.redacted) {
        engine.logger.debug(destroyFailureText(deleteFailure.detail));
      }
      const destroyFailure = new Error(
        destroyFailureText(deleteFailure.redacted ? deleteFailure.summary : deleteFailure.detail),
        {
          cause:
            deleteError instanceof Error
              ? maskSecretsInError(deleteError, updateSecrets)
              : undefined,
        }
      );
      throw deleteFailure.redacted && deleteError instanceof Error
        ? markRedactedCause(destroyFailure)
        : destroyFailure;
    }
    // Issue #1762: same reasoning as the delete-first fallback —
    // this destroy is load-bearing, so a skip has to fail the
    // resource rather than let the create run beside a live old one.
    // Issue #2422: before the skip check below, which throws.
    reportDeleteGuards(recreateDeleteResult, {
      physicalId: currentResource.physicalId,
      resourceType: oldResourceType,
      provisionedBy: oldDeleteRoute.provisionedBy,
    });
    const recreateSkipReason = deleteSkipReason(recreateDeleteResult);
    if (recreateSkipReason !== undefined) {
      throw new Error(
        deleteSkippedMessage(
          logicalId,
          currentResource.physicalId,
          recreateSkipReason,
          `during ${recreateFlagName}`
        )
      );
    }
    engine.logger.info(safeMsg`  ${green('✓')} Old resource deleted`);
    engine.replacementRun.oldDeletedBeforeCreate.add(logicalId);
    // go-to-k/cdkd#5131: as the --replace fallback, for a type whose delete
    // returns while AWS still holds the name.
    await oldDeleteProvider.waitForNameReleased?.(
      logicalId,
      currentResource.physicalId,
      oldResourceType,
      {
        isInterrupted: () => engine.userInterrupted,
        maskSecrets: createSecretMasker(updateSecrets),
      }
    );
  }

  engine.logger.info(safeMsg`  Creating new ${logicalId}...`);
  // Delete-then-create just released the old resource's name, so
  // the re-create can hit a late name release ("already exists"
  // from an async delete) or the SQS 60s same-name cooldown
  // (QueueDeletedRecently, issue #1214). The inner retry matches
  // the cooldown — and since issue #2116 it rides the name-cooldown
  // grid (2s/4s/8s then 10s, ≈64s), not the generic ~47s one it used
  // to inherit, so the inner loop alone now covers the 60s window
  // rather than typically ending inside it.
  //
  // This outer loop is kept anyway, and the reason has MOVED rather
  // than disappeared: it is no longer "the inner budget is too
  // short" but that the outer filter is `isRecreateRetryableError`,
  // which also covers the late name RELEASE ("already exists" from
  // an async delete) that the inner default classifier deliberately
  // rejects. Note the two now COMPOUND — the outer loop re-enters an
  // inner loop that is itself 64s — measured at 640s total sleep on
  // a cooldown, inside the 30-minute per-resource deadline. See
  // `NAME_COOLDOWN_INITIAL_DELAY_MS` in retry.ts.
  createResult = await guardedReplacementCreate(
    engine,
    {
      logicalId,
      resourceType,
      stackName,
      createdVia: replaceDecision.provisionedBy,
      resolvedProps,
    },
    () =>
      withRetry(
        () =>
          engine.withRetry(
            () =>
              withCurrentResourceSecrets(updateSecrets, () =>
                replaceProvider.create(logicalId, resourceType, replaceProps, {
                  maskSecrets: createSecretMasker(updateSecrets),
                })
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
          // Issue #2038, same reason as the --replace fallback above --
          // and bound to `updateSecrets`, the bag this UPDATE resolved
          // with and the very one the `createSecretMasker` one statement
          // up is built from, rather than looked up by logical id.
          logger: engine.maskingRetryLoggerFor(updateSecrets),
          // The old resource is already deleted: only the user's interrupt
          // stops this re-create, never a sibling's failure.
          isInterrupted: () => engine.userInterrupted,
          onInterrupted: () => new InterruptedError('user'),
          isRetryable: isRecreateRetryableError,
        }
      )
  );

  // Issue #1238: under `UpdateReplacePolicy: Retain` the old
  // resource was NOT destroyed above, so a name-idempotent Create
  // API (e.g. SQS CreateQueue with an unchanged QueueName) can
  // silently return the EXISTING resource instead of colliding.
  // Recording that id as the "new" resource would re-adopt the
  // resource the Retain policy just orphaned — without the new
  // properties ever being applied. Fail before the state
  // bookkeeping runs; the old resource and its state record stay
  // intact.
  //
  // `equalIdIsSameResource` (issue #2668): across a Type change an
  // equal id is a coincidence of two namespaces, and the create was a
  // genuine one — the custom-resource family excepted.
  if (
    equalIdIsSameResource &&
    updateReplacePolicy === 'Retain' &&
    createResult.physicalId === currentResource.physicalId
  ) {
    throw new CdkdError(
      safeMsg`${logicalId} (${resourceType}) recreate returned the existing resource ` +
        safeMsg`(${currentResource.physicalId}) instead of creating a new one — its Create ` +
        `API is name-idempotent — and UpdateReplacePolicy: Retain means the old ` +
        `resource was never destroyed, so the new properties were not applied. ` +
        `Rename the resource in your CDK code (or remove the explicit physical ` +
        `name) so the recreate can produce a genuinely new resource.`,
      'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
    );
  }
  return createResult;
}
