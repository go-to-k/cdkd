import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import { FSxClient } from '@aws-sdk/client-fsx';
import { describeAwsFailure, describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markRedactedCause, relayedNameCollision } from '../../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';

/**
 * The failure wrap every create / update / delete catch builds.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through the
 * operation's `maskSecrets` (`mask`), and the wrap is stamped
 * `markRedactedCause`, so the retry classifiers read the withheld text on the
 * `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}). A cdkd-authored or transport error, or a
 * non-`Error` throw, keeps its text; the deploy engine masks a thrown
 * message. The delete checks `FileSystemNotFound` by type before it wraps,
 * so no "already deleted" reading depends on AWS's wording.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
/**
 * The error a FAILED lifecycle or administrative action read off a
 * successful Describe throws (go-to-k/cdkd#2319). AWS's reason
 * (`FailureDetails.Message`) reaches the same persisted sink as a caught
 * failure and can name the account, so the message carries the `--verbose`
 * pointer instead ({@link describeAwsStatusReason}; FSx reports no reason
 * code). The reason goes to `debug` through the operation's masker, and
 * becomes the `cause` the wrap is stamped `markRedactedCause` over, so the
 * retry classifiers still read it as they read the message before. No reason
 * keeps cdkd's fallback text.
 *
 * `build` runs twice, so it must stay a side-effect-free constructor call
 * threading `cause`.
 */
export function wrapStatusReasonError(
  this: FSxFileSystemProvider,
  mask: MaskerFn | undefined,
  message: string | undefined,
  build: (text: string, cause: Error | undefined) => ProvisioningError
): ProvisioningError {
  const text = describeAwsStatusReason({ message }, 'no failure details reported');
  if (!text.redacted) return build(text.detail, undefined);
  const m = maskerOrIdentity(mask);
  const cause = new Error(text.detail);
  this.logger.debug(m(build(m(text.detail), cause).message));
  return markRedactedCause(build(m(text.summary), cause));
}

export function wrapCaughtError(
  this: FSxFileSystemProvider,
  mask: MaskerFn | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
  const m = maskerOrIdentity(mask);
  this.logger.debug(m(build(m(failure.detail)).message));
  return markRedactedCause(build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`));
}

/**
 * The cleanup-failure text a best-effort `warn` quotes after `head`
 * (go-to-k/cdkd#2319). An AWS-authored failure is named by its CLASS at
 * warn, since a denied call names the caller's assumed-role ARN; AWS's own
 * text goes to `debug` under the same `head`, masked. A cdkd-authored or
 * transport error keeps its text, masked.
 */
export function cleanupFailureText(
  this: FSxFileSystemProvider,
  head: string,
  error: unknown,
  mask: MaskerFn | undefined
): string {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return m(failure.detail);
  this.logger.debug(m(`${head}${m(failure.detail)}`));
  return m(failure.summary);
}

export function getClient(this: FSxFileSystemProvider): FSxClient {
  if (!this.client) {
    this.client = new FSxClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.client;
}
