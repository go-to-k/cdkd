import { markNonRetryable } from '../deployment/retryable-errors.js';
import { isAccessDeniedError } from './name-lookup.js';
import { markNotGone } from './not-gone.js';
import type { DeleteContext } from './region-check.js';
import { RecordedIdentityError } from './recorded-identity.js';
import { stateOrphanRecordRemedy } from './state-orphan-remedy.js';

/**
 * go-to-k/cdkd#6665: the refusal of a delete whose identity read (the
 * describe a record holding a recorded identity needs before the by-name
 * delete) AWS refused for authorization, or `undefined` for any other
 * failure, which stays with the retry classifiers.
 *
 * A denied read does not lift with time, so a retry only fails again; and
 * the by-name delete is what the read guards, so it is never the fallback.
 * Non-retryable; names the permission (static text) and the error class
 * (an SDK class name, never AWS's text, which can name the caller), then the
 * two ways forward: allow the read, or stop tracking the resource with
 * `cdkd state orphan`. "Allow", not "grant": the denial can come from an
 * IAM policy, a permission boundary, an SCP or a VPC endpoint policy, and
 * only the first is fixed by a grant. No `cause`: AWS's text stays off the
 * error a deployment event persists. Marked not gone: the logical id is
 * interpolated, and the delete classifiers read a `NotFound` needle as
 * "already deleted".
 *
 * A credential or clock failure (`CREDENTIAL_FAILURE_NAMES`) is not a
 * missing permission even when it answers 403 (RDS's `SignatureDoesNotMatch`
 * / `InvalidClientTokenId`): `undefined`, the normal path, whose text says
 * what is wrong with the credentials.
 */
export function deniedIdentityReadRefusal(
  error: unknown,
  params: {
    /** `log group`, `Step Functions state machine`, `ECR repository`. */
    label: string;
    /** `logs:DescribeLogGroups`, ... */
    permission: string;
    resourceType: string;
    logicalId: string;
    physicalId: string;
    context: DeleteContext | undefined;
  }
): RecordedIdentityError | undefined {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (typeof name === 'string' && CREDENTIAL_FAILURE_NAMES.has(name)) return undefined;
  if (!isAccessDeniedError(error)) return undefined;
  const { label, permission, resourceType, logicalId, physicalId, context } = params;
  const errorClass = typeof name === 'string' && /^[A-Za-z0-9]{1,64}$/.test(name) ? name : 'a 403';
  return markNotGone(
    markNonRetryable(
      new RecordedIdentityError(
        `Cannot delete ${label} ${logicalId}: AWS refused the ${permission} read cdkd makes to ` +
          `confirm it is the one cdkd created (${errorClass}), so cdkd sent no delete and kept ` +
          `the record. Allow ${permission} for the identity running cdkd (an IAM policy, ` +
          `permission boundary, SCP or VPC endpoint policy may deny it) and re-run, or, to stop ` +
          `managing it without deleting it, drop the record with ` +
          `${stateOrphanRecordRemedy(context, logicalId)}.`,
        resourceType,
        logicalId,
        physicalId
      )
    )
  );
}

/**
 * The error names of a request AWS refused for its credentials or its clock,
 * not its permissions. Several answer 403 (measured: RDS answers a wrong
 * secret `SignatureDoesNotMatch` and a bad session token
 * `InvalidClientTokenId`, both 403), which `isAccessDeniedError`'s status arm
 * would otherwise read as a denial; the JSON-protocol spellings (400) are
 * listed too so the set reads as one class.
 */
const CREDENTIAL_FAILURE_NAMES: ReadonlySet<string> = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'RequestExpired',
  'RequestTimeTooSkewed',
  'SignatureDoesNotMatch',
  'InvalidSignatureException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'InvalidAccessKeyId',
  'InvalidToken',
  'IncompleteSignature',
  'IncompleteSignatureException',
  'MissingAuthenticationToken',
  'MissingAuthenticationTokenException',
  'AuthFailure',
]);
