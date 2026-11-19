/**
 * `cdkd drift --revert` never replaces a resource (go-to-k/cdkd#6638).
 *
 * The revert hands a provider's `update()` the recorded baseline as the
 * desired bag (`UpdateContext.desiredFromAwsReadback`). A provider whose
 * `update()` would DELETE AND RE-CREATE the resource itself to reach that bag
 * (a new SNS subscription ARN, certificate, `sgr-` id, statement, API Gateway
 * resource or route) refuses instead, before any AWS call, with this error.
 * `revert-apply.ts` counts it as update-not-supported: the resource is reported
 * as not reverted, the run exits non-zero, and the summary points at
 * `cdkd deploy --replace`. A deploy never sets the flag, so its replacement
 * arms are unchanged.
 *
 * Re-creating a CHILD the revert exists to restore (a security group's inline
 * rule, an IAM policy version) is not a replacement of the resource and does
 * not go through here.
 */
import { ResourceUpdateNotSupportedError } from '../utils/error-handler.js';
import { deployReplaceCommand } from '../utils/pasteable-command.js';
import type { UpdateContext } from '../types/resource.js';

/** Whether this `update()` call is a `cdkd drift --revert`. */
export function isDriftRevert(context: Pick<UpdateContext, 'desiredFromAwsReadback'> | undefined) {
  return context?.desiredFromAwsReadback === true;
}

/**
 * The refusal a provider throws when a revert would replace the resource.
 *
 * `reason` says what forces the replacement in cdkd-authored words, naming
 * property KEYS only: a value or physical id may be secret-derived, and the
 * message is printed on the revert's per-resource line.
 */
export function revertReplacementRefusal(
  resourceType: string,
  logicalId: string,
  reason: string
): ResourceUpdateNotSupportedError {
  return new ResourceUpdateNotSupportedError(
    resourceType,
    logicalId,
    `${reason}, so reverting it would replace it, and a drift revert never replaces a ` +
      `resource. Nothing was changed; re-deploy with ${deployReplaceCommand()} to replace it`
  );
}
