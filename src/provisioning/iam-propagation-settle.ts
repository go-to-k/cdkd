import { performance } from 'node:perf_hooks';
import { abortableSleep, deferReadiness } from './deferred-readiness.js';

/**
 * How long after an IAM permission write a custom resource downstream of it
 * waits before its handler is invoked.
 *
 * IAM accepts a policy write at once and propagates it later. cdkd writes a
 * custom resource handler's role policy and invokes the handler moments apart,
 * which no CloudFormation deploy does: CloudFormation reports an IAM resource
 * complete only after propagation has had time to settle. An invoke that
 * outruns propagation does not fail fast. The CDK Provider framework's
 * `onEvent` answers any failed invoke of the user handler by polling
 * `waitUntilFunctionActiveV2` (`maxWaitTime: 300`); in the runs measured for
 * go-to-k/cdkd#6967 that poll stayed denied until it timed out, so the deploy
 * lost 3 to 4 minutes before the transient-authz retry recycled the function.
 *
 * Performance gave way to CloudFormation parity here, narrowly: a custom
 * resource downstream of an IAM write of the same deploy now always waits out
 * what remains of the settle, even on a run where propagation would have been
 * quick enough. Nothing else waits, and a deploy that writes no IAM is
 * unchanged. A propagation slower than the settle still reaches the
 * transient-authz retry, as before. 10 s is measured, not documented by AWS:
 * no delay hit the 300 s poll every time, a delay of about 6 s after the write
 * never did.
 */
export const IAM_PROPAGATION_SETTLE_MS = 10_000;

/** Test seam for the settle's clock (monotonic: the settle is an interval). */
export const iamPropagationSettleClock = { now: (): number => performance.now() };

/**
 * Report that `logicalId` just wrote an IAM permission, so a custom resource
 * downstream of it waits until {@link IAM_PROPAGATION_SETTLE_MS} after this
 * call before its handler runs. Nothing else waits: a plain dependent (a
 * function whose `Role` is this role) proceeds at once, and the settle runs
 * only when such a custom resource is invoked, for what remains of it.
 *
 * Call it after the write succeeded, with the physical id the operation
 * returns. Outside a deploy operation it does nothing.
 */
export function deferIamPropagationSettle(
  logicalId: string,
  resourceType: string,
  physicalId: string
): void {
  const settledAt = iamPropagationSettleClock.now() + IAM_PROPAGATION_SETTLE_MS;
  deferReadiness(
    logicalId,
    resourceType,
    physicalId,
    (signal) =>
      abortableSleep(
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        Math.max(0, settledAt - iamPropagationSettleClock.now()),
        signal
      ),
    'iam-propagation'
  );
}
