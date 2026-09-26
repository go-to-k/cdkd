/**
 * Production's object graph for a synchronous Cloud Control "this type has no
 * UPDATE handler" rejection. Since issue
 * [go-to-k/cdkd#3810](https://github.com/go-to-k/cdkd/issues/3810)
 * `isUpdateUnsupportedError` reads no prose, so this shape (or the async
 * `CloudControlOperationFailedError` carrying `ccErrorCode`) is what reaches
 * the replacement fallback.
 *
 * Reconstructed from the two sources that build it rather than invented:
 *   - the AWS rejection: `aws cloudcontrol update-resource --type-name
 *     AWS::DocDB::DBCluster` answers an error whose `name` is
 *     `UnsupportedActionException` and whose `message` is `Resource type
 *     AWS::DocDB::DBCluster does not support UPDATE action` — the name is NOT
 *     repeated inside the message.
 *   - the wrapper: `CloudControlProvider.handleError` interpolates
 *     `err.message` only, into the "not supported by Cloud Control API"
 *     sentence, and passes the raw error as `cause`.
 *
 * Shared because every engine suite that drives the update-failure
 * replacement fallback needs it; a flat `new Error('... does not support
 * UPDATE action')` no longer reaches that fallback.
 */
import { ProvisioningError } from '../../src/utils/error-handler.js';

export function ccUnsupportedActionError(resourceType: string): Error {
  const raw = new Error(`Resource type ${resourceType} does not support UPDATE action`);
  raw.name = 'UnsupportedActionException';
  return raw;
}

export function handleErrorWrapper(
  resourceType: string,
  logicalId: string,
  cause: Error,
  physicalId = 'pid-1'
): ProvisioningError {
  return new ProvisioningError(
    `Resource type ${resourceType} is not supported by Cloud Control API and no SDK ` +
      `provider is registered.\nPlease report this issue at ` +
      `https://github.com/go-to-k/cdkd/issues so we can add SDK provider support.\n` +
      `Error: ${cause.message}`,
    resourceType,
    logicalId,
    physicalId,
    cause
  );
}

/** The wrapper over its named cause, as the deploy engine's catch receives it. */
export function ccUpdateUnsupportedRejection(
  resourceType: string,
  logicalId: string,
  physicalId?: string
): ProvisioningError {
  return handleErrorWrapper(
    resourceType,
    logicalId,
    ccUnsupportedActionError(resourceType),
    physicalId
  );
}
