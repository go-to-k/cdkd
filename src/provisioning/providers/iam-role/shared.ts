import type { IAMRoleProvider } from '../iam-role-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';

/**
 * An IAM role NAME (1-64 of `A-Z a-z 0-9 + = , . @ _ -`, IAM's `RoleName`
 * pattern), the physical id this provider records. The identity answers
 * (`isSameResource`, `resourceIdentity`) refuse anything else, an ARN
 * included: this provider never records one.
 */
export function isRoleName(id: string): boolean {
  return /^[\w+=,.@-]{1,64}$/.test(id);
}

/**
 * go-to-k/cdkd#4606 / #4655: a role's identity token is its `RoleId` (the
 * `AROA…` unique id). IAM assigns it at `CreateRole` and never changes it; a
 * role deleted and re-created under the same name gets another one (IAM User
 * Guide, "IAM identifiers" → "Unique identifiers"; the
 * `iam-role-fix-forward-orphan` fixture measures the re-create). The wiring
 * calls a CREATE makes after `CreateRole` (policies) do not touch it.
 * `undefined` for a missing or empty one.
 */
export function roleIdentityToken(roleId: string | undefined): string | undefined {
  return typeof roleId === 'string' && roleId !== '' ? roleId : undefined;
}

/**
 * A failure wrap that never quotes AWS's own text (issue #2319). The thrown
 * message is persisted to `deployments/{runId}.jsonl`, and an IAM
 * `AccessDenied` names the caller's assumed-role ARN, so an AWS-authored
 * failure is named by its class plus the `--verbose` pointer: AWS's text
 * goes to `debug` through the masker, and the wrap is stamped
 * `markRedactedCause` so the retry classifiers read the withheld text (the
 * IAM-propagation wording included) on the unmasked `cause` chain. An
 * "already exists" is restated ({@link relayedNameCollision}); the class
 * name keeps `NoSuchEntity` in the message for the engine's not-found
 * matchers. A cdkd-authored or transport error, or a non-`Error` throw,
 * keeps its text masked (issue #2177, `wrapMaskedAwsError`, issue #4244).
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
 * sees the catch that throws it as a wrap.
 */
export function wrapMaskedError(
  this: IAMRoleProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error)) return build(mask(failure.detail));
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  // Not from a post-create step (`markAuxiliaryFailure`), where "it" would
  // read as the resource just created.
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  return markRedactedCause(build(`${mask(failure.summary)}${relay}`));
}
