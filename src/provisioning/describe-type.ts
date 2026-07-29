/**
 * Shared `cloudformation:DescribeType` invocation with throttle-only retry
 * (issue #1236).
 *
 * DescribeType is throttled per-account, and a deploy can issue a burst of
 * them (the #1182 create-only schema prefetch describes every type in the
 * template at deploy start). A lookup issued moments later — the write-only
 * property resolution during a CC-routed UPDATE is the critical case — can
 * then be throttled past the SDK's own short retry, and the caller's graceful
 * fallback turns the transient throttle into a real failure: the minimal
 * update patch drops a load-bearing write-only property and the update
 * hard-fails (`AWS::ECS::Service.VolumeConfigurations`), or a replacement is
 * mis-classified from a missing create-only schema.
 *
 * The fix is to retry ONLY throttle-shaped failures ({@link isThrottlingError})
 * with the standard backoff before surfacing the error. Non-throttle failures
 * (a missing `cloudformation:DescribeType` permission being the important one)
 * are rethrown immediately so the callers' warn-and-fall-back path stays as
 * fast as before — a caller permanently without the permission must not pay a
 * retry sleep on every lookup.
 */

import {
  DescribeTypeCommand,
  type DescribeTypeCommandOutput,
} from '@aws-sdk/client-cloudformation';
import { withRetry } from '../deployment/retry.js';
import { isThrottlingError } from '../deployment/retryable-errors.js';
import { getAwsClients, type AwsClients } from '../utils/aws-clients.js';
import { getLogger } from '../utils/logger.js';

/**
 * Test seam: overriding `sleep` lets unit tests drive the backoff schedule
 * without real waits (mirrors macro-expander's `retryDelays`).
 */
export const describeTypeRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Retries after the first attempt, throttle-shaped failures only. At the
 * default backoff (1s -> 2s -> 4s -> 8s) this adds at most ~15s of sleep —
 * enough to ride out a prefetch-burst throttle window, small next to the
 * failed-update + rollback cycle it prevents.
 */
const MAX_THROTTLE_RETRIES = 4;

/**
 * Issue `DescribeType` for a resource type, retrying throttle-shaped failures
 * with exponential backoff. Any other failure (or a throttle persisting past
 * the retry budget) is thrown to the caller unchanged.
 *
 * `client` defaults to the shared `AwsClients.cloudFormation`; callers that
 * carry their own injected client (`cdkd export`'s primary-identifier
 * resolution) pass it so test doubles keep intercepting.
 */
export function describeTypeWithThrottleRetry(
  resourceType: string,
  client?: AwsClients['cloudFormation']
): Promise<DescribeTypeCommandOutput> {
  return withRetry(
    () =>
      (client ?? getAwsClients().cloudFormation).send(
        new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
      ),
    resourceType,
    {
      maxRetries: MAX_THROTTLE_RETRIES,
      isRetryable: (_message, error) => isThrottlingError(error),
      logger: getLogger().child('DescribeType'),
      ...(describeTypeRetryDelays.sleep ? { sleep: describeTypeRetryDelays.sleep } : {}),
    }
  );
}

/**
 * Resource types that have NO CloudFormation registry schema, so
 * `DescribeType` can only ever fail for them:
 *
 * - `Custom::<Name>` — the two-segment form the `TypeName` parameter
 *   rejects outright at validation time.
 * - `AWS::CloudFormation::CustomResource` — the generic custom-resource
 *   alias; replacement semantics are handler-driven, not schema-driven.
 * - `AWS::CDK::Metadata` — the CDK-injected construct-tree marker. It is a
 *   synth-only sentinel that cdkd never provisions (the deploy pre-flight,
 *   the diff, `synth`, `import` and `export` all filter it), yet the
 *   create-only schema PREFETCH iterated the raw template type set and so
 *   issued a guaranteed-to-fail `DescribeType` for it on EVERY deploy —
 *   burning one API call and emitting a "Grant cloudformation:DescribeType"
 *   warning that named a pseudo-resource the user cannot act on.
 *
 * Callers must short-circuit on this predicate rather than paying the round
 * trip plus the misleading warning. Kept next to
 * {@link describeTypeWithThrottleRetry} so every DescribeType-backed
 * resolver shares ONE list instead of re-deriving its own inline literal.
 */
export function hasNoRegistrySchema(resourceType: string): boolean {
  return (
    resourceType === 'AWS::CDK::Metadata' ||
    resourceType === 'AWS::CloudFormation::CustomResource' ||
    resourceType.startsWith('Custom::')
  );
}
