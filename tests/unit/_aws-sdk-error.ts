import { CloudControlOperationFailedError } from '../../src/provisioning/cloud-control-provider.js';

/**
 * An error shaped like an AWS SDK v3 `ServiceException`: a real `Error` whose
 * own `$metadata` envelope marks its text as AWS-authored.
 *
 * Since issue [go-to-k/cdkd#3816](https://github.com/go-to-k/cdkd/issues/3816)
 * `isNameCollisionErrorFrom` credits "already exists" prose only off a link
 * carrying `$metadata`, so a flat `new Error('Queue already exists')` no longer
 * stands in for an AWS collision. Thrown unwrapped, this is a provider letting
 * the SDK error escape; as a `cause`, it is the one a provider wrapper threads.
 */
export function awsSdkError(message: string, name = 'ResourceConflictException'): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode: 400, requestId: 'req-test' } });
  return error;
}

/**
 * The async Cloud Control collision: what `waitForOperation` throws when the
 * CREATE handler reports `AlreadyExists`. Its message is
 * `CREATE failed for <logicalId>: <StatusMessage>`, and the classifier reads
 * the `ccErrorCode`, not that text. The logical id is taken from the message,
 * so a fixture's wording and its anchor cannot drift apart.
 */
export function ccAlreadyExistsError(message: string, resourceType = 'AWS::Test::Thing'): Error {
  const logicalId = /^CREATE failed for ([^:]+):/.exec(message)?.[1] ?? 'Unknown';
  return new CloudControlOperationFailedError(
    message,
    resourceType,
    logicalId,
    undefined,
    'AlreadyExists',
    'CREATE'
  );
}
