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
 * two ways forward: grant the read, or stop tracking the resource with
 * `cdkd state orphan`. No `cause`: AWS's text stays off the error a
 * deployment event persists. Marked not gone: the logical id is interpolated, and
 * the delete classifiers read a `NotFound` needle as "already deleted".
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
  if (!isAccessDeniedError(error)) return undefined;
  const { label, permission, resourceType, logicalId, physicalId, context } = params;
  const name = (error as { name?: unknown }).name;
  const errorClass = typeof name === 'string' && /^[A-Za-z0-9]{1,64}$/.test(name) ? name : 'a 403';
  return markNotGone(
    markNonRetryable(
      new RecordedIdentityError(
        `Cannot delete ${label} ${logicalId}: AWS refused the ${permission} read cdkd makes to ` +
          `confirm it is the one cdkd created (${errorClass}), so cdkd sent no delete and kept ` +
          `the record. Grant ${permission} to the identity running cdkd and re-run, or, to stop ` +
          `managing it without deleting it, drop the record with ` +
          `${stateOrphanRecordRemedy(context, logicalId)}.`,
        resourceType,
        logicalId,
        physicalId
      )
    )
  );
}
