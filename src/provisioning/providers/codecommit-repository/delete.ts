import {
  DeleteRepositoryCommand,
  RepositoryDoesNotExistException,
  type RepositoryMetadata,
} from '@aws-sdk/client-codecommit';
import type { CodeCommitRepositoryProvider } from '../codecommit-repository-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import type { IndeterminateGuard, ResourceDeleteResult } from '../../../types/resource.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { withIndeterminateGuard } from '../../../deployment/delete-outcome.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import {
  RECORDED_IDENTITY_DELETE_GUARD,
  recordedRepositoryId,
  recordedRepositoryIdMasked,
} from './shared.js';

/**
 * Delete a CodeCommit Repository
 *
 * `DeleteRepository` is idempotent on the AWS side: for an
 * already-deleted repository it does NOT throw — it returns a null
 * `repositoryId`. That silent-success shape would bypass the shared
 * region check entirely (the exact scenario `assertRegionMatch` exists
 * for: a client pointed at region B while the state says the repo lives
 * in region A), so a null `repositoryId` runs the region check before
 * being treated as idempotent success. A
 * `RepositoryDoesNotExistException` is additionally handled (same
 * check) for defense in depth.
 *
 * `DeleteRepository` takes a NAME, so with a recorded `RepositoryId`
 * (`DeleteContext.recordedAttributes`, go-to-k/cdkd#4157) the repository
 * holding the name is read first and a holder with another id is REFUSED,
 * with nothing deleted: returning normally would drop the record while the
 * foreign repository stays, and deleting it destroys a repository the stack
 * never created. A read that cannot confirm the holder's identity and is
 * not a retryable transient failure (a denied `GetRepository`, an
 * unavailable KMS key, any other error) proceeds with a warn and reports an
 * `IndeterminateGuard`, so cdkd's own repository is never wedged; a
 * throttled, 5xx or connection-level read is retried.
 * A record with no `RepositoryId` keeps the historical by-name delete.
 */
export async function deleteImpl(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting CodeCommit Repository ${logicalId}: ${physicalId}`);

  const recordedId = recordedRepositoryId(context?.recordedAttributes);
  let guard: IndeterminateGuard | undefined;
  if (recordedId !== undefined || recordedRepositoryIdMasked(context?.recordedAttributes)) {
    // A client in another region would read a same-named repository there
    // and refuse it as foreign, naming a remedy that drops the record of the
    // live one: compare regions first, as the update does.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-delete'
    );
  }
  if (recordedId === undefined && recordedRepositoryIdMasked(context?.recordedAttributes)) {
    guard = this.proceedUnconfirmed(logicalId, 'the recorded repository id is masked');
  }
  let deletedRepositoryId: string | undefined;
  try {
    if (recordedId !== undefined) {
      guard = await this.confirmDeleteTarget(
        logicalId,
        resourceType,
        physicalId,
        recordedId,
        maskerOrIdentity(context?.maskSecrets)
      );
    }
    const response = await this.getClient().send(
      new DeleteRepositoryCommand({ repositoryName: physicalId })
    );
    deletedRepositoryId = response.repositoryId;
  } catch (error) {
    // The identity refusal: already named and marked non-retryable.
    if (error instanceof ProvisioningError) throw error;
    if (error instanceof RepositoryDoesNotExistException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`CodeCommit Repository ${physicalId} does not exist, skipping deletion`);
      return withIndeterminateGuard(undefined, guard);
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete CodeCommit Repository ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap now names the error CLASS, and the destroy / deploy delete
    // classifiers read `NotFound` / `NotFoundException` in a message as
    // "already deleted": `EncryptionKeyNotFoundException` (the repository's
    // KMS key is gone) would drop the record of a repository that still
    // exists. Only `RepositoryDoesNotExistException` (above) means it is
    // gone (go-to-k/cdkd#2319). Marked not gone rather than non-retryable
    // (go-to-k/cdkd#5228): whether a relayed AWS failure retries is the
    // retry classifiers' call, and none of them matches this class.
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }

  if (!deletedRepositoryId) {
    // Repository did not exist — verify we were even looking in the right
    // region before calling this an idempotent success. Outside the try
    // block so a region-mismatch error propagates unwrapped.
    const clientRegion = await this.getClient().config.region();
    assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
    this.logger.debug(`CodeCommit Repository ${physicalId} does not exist, skipping deletion`);
    return withIndeterminateGuard(undefined, guard);
  }
  if (recordedId !== undefined && deletedRepositoryId !== recordedId) {
    // The name changed hands between the read and the delete (CodeCommit has
    // no delete by id): say so, since it cannot be undone.
    this.logger.warn(
      safeMsg`CodeCommit Repository ${logicalId}: the repository deleted under the recorded name was not the one cdkd recorded (its repository id is not the recorded one).`
    );
  }
  this.logger.debug(`Successfully deleted CodeCommit Repository ${logicalId}`);
  return withIndeterminateGuard(undefined, guard);
}

/**
 * Before `DeleteRepository`, confirm the repository holding `physicalId` is
 * the recorded one (go-to-k/cdkd#4157). Three outcomes:
 *
 * - the recorded id, or the name held by nothing
 *   (`RepositoryDoesNotExistException`, rethrown to the idempotent arm):
 *   `undefined`, and the delete goes ahead;
 * - another id: THROWS a non-retryable refusal, and nothing is deleted;
 * - no answer (ANY read failure below, or a read with no id): the delete
 *   goes ahead with a warn and the guard reported — a denied read, an
 *   `EncryptionKey*` failure, an unexpected error alike, since a destroy of
 *   cdkd's own repository must not wedge on them and the delete was by name
 *   before this check existed. A throttled, 5xx or ambiguous socket
 *   failure is rethrown instead, so the delete is not sent; a throttle or
 *   5xx is retried by the caller, a socket error is not (no classifier
 *   retries one) and fails the delete. A connection never made
 *   (`ECONNREFUSED`, `ENOTFOUND`) is not ambiguous and takes the proceed
 *   arm; the delete that follows fails the same way. `EADDRNOTAVAIL` and
 *   `ETIMEDOUT` rethrow even in their connect form: the code alone cannot
 *   tell that form from a failure after the request was written.
 *
 * The guard stays on every return, an already-gone repository included: it
 * reports that the check did not run, whatever the delete then found.
 *
 * Name and id address the same repository only at the moment of the read:
 * CodeCommit has no delete-by-id, so a swap between the two calls is not
 * caught.
 */
export async function confirmDeleteTarget(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  recordedId: string,
  mask: MaskerFn
): Promise<IndeterminateGuard | undefined> {
  let holder: RepositoryMetadata | undefined;
  try {
    holder = await this.getRepositoryMetadata(physicalId);
  } catch (error) {
    // A throttle, a 5xx or a lost connection (`isAmbiguousOutcomeError`
    // covers both of the last two) is no answer about identity: rethrown,
    // so the delete is not sent. The caller's retry asks again for a
    // throttle or 5xx; a socket error is not retried and fails the delete.
    if (
      error instanceof RepositoryDoesNotExistException ||
      isThrottlingError(error) ||
      isAmbiguousOutcomeError(error)
    ) {
      throw error;
    }
    // The class, never AWS's text (it quotes the caller's role and session),
    // and masked: the class is AWS-authored text too (go-to-k/cdkd#2319).
    const failure = describeAwsFailure(error);
    this.logger.debug(
      safeMsg`GetRepository failed while confirming CodeCommit Repository ${logicalId}: ${mask(failure.detail)}`
    );
    return this.proceedUnconfirmed(
      logicalId,
      `the repository could not be read to compare its id with the recorded one: ${mask(failure.summary)}`
    );
  }
  const liveId = holder?.repositoryId;
  if (liveId === undefined) {
    return this.proceedUnconfirmed(logicalId, 'GetRepository returned no repository id');
  }
  if (liveId === recordedId) return undefined;
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`CodeCommit Repository ${logicalId}: the repository holding the name cdkd recorded for ` +
        `this resource is not this resource's (its repository id is not the one cdkd holds; ` +
        `the recorded repository was deleted or renamed outside cdkd) — cdkd did not delete ` +
        `it. Leave that repository alone. If cdkd still records this resource under that ` +
        `name (a destroy, or a deploy removing the resource), drop that record and re-run; a ` +
        `later deploy that creates this resource again needs a RepositoryName no repository ` +
        `holds (fill in the resource's construct path):\n` +
        pasteableCommand('cdkd orphan', [{ hole: 'constructPath' }]).command,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/** The proceed-anyway arm of {@link confirmDeleteTarget}, reported. */
export function proceedUnconfirmed(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  reason: string
): IndeterminateGuard {
  this.logger.warn(
    safeMsg`Could not confirm that CodeCommit Repository ${logicalId} is the repository cdkd recorded: ${reason.replace(/[.\s]+$/, '')}. Proceeding with the delete.`
  );
  return { guard: RECORDED_IDENTITY_DELETE_GUARD, reason };
}
