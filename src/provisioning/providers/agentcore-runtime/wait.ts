/**
 * The AgentCore Runtime status waits (go-to-k/cdkd#6490).
 *
 * `CreateAgentRuntime` and `UpdateAgentRuntime` return while the runtime is
 * `CREATING` / `UPDATING`, and Cloud Control's handler waits for `READY`
 * before it reports the operation done. The SDK provider waits the same way,
 * so a resource depending on the runtime, or the next call on it, never meets
 * one still in flight. `--no-wait` skips the create / update wait, which the
 * provider decides; the pre-delete wait runs in every mode, since a delete
 * AWS refuses while the runtime is in flight would fail the destroy.
 */
import {
  GetAgentRuntimeCommand,
  type BedrockAgentCoreControlClient,
  type GetAgentRuntimeCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  isRetryableTransientError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { MaskerFn } from '../../masked-retry-logger.js';

/** The time between two status reads. */
export const RUNTIME_WAIT_POLL_MS = 5_000;
/**
 * The reads a wait makes before it gives up: 30 minutes at
 * {@link RUNTIME_WAIT_POLL_MS}, the default per-resource deadline, which
 * stops the wait first unless `--resource-timeout` allows more.
 */
export const RUNTIME_WAIT_MAX_POLLS = 360;

/** Statuses AWS reports while a create or update is still in flight. */
const IN_FLIGHT: ReadonlySet<string> = new Set(['CREATING', 'UPDATING']);

/** What a wait needs from the provider. */
export interface RuntimeWaitDeps {
  client: Pick<BedrockAgentCoreControlClient, 'send'>;
  sleep: (ms: number) => Promise<void>;
  debug: (message: string) => void;
}

/**
 * Poll `GetAgentRuntime` until the runtime is `READY`, and return that read.
 *
 * `CREATE_FAILED` / `UPDATE_FAILED`, any status other than `READY` or the
 * in-flight one, a read that fails for a reason other than a transient one,
 * and a runtime still in flight after {@link RUNTIME_WAIT_MAX_POLLS} reads
 * each throw a NON-retryable `ProvisioningError`: the deploy engine's retry
 * would re-send the whole create, and a second `CreateAgentRuntime` under the
 * same name collides with the runtime that is settling. A transient read
 * failure (throttle, 5xx, a dropped connection) counts as a poll and the wait
 * goes on. AWS's `failureReason` goes to `debug` through `mask` only, because a
 * thrown message is persisted to the deployment events.
 */
export async function waitForRuntimeReady(
  deps: RuntimeWaitDeps,
  agentRuntimeId: string,
  logicalId: string,
  resourceType: string,
  operation: 'create' | 'update',
  mask: MaskerFn
): Promise<GetAgentRuntimeCommandOutput> {
  deps.debug(
    `Waiting for BedrockAgentCore Runtime ${agentRuntimeId} to be READY after ${operation}`
  );
  const failure = (text: string): ProvisioningError =>
    new ProvisioningError(
      `BedrockAgentCore Runtime ${logicalId} (${agentRuntimeId}) ${text}`,
      resourceType,
      logicalId,
      agentRuntimeId
    );
  const watch = startInterruptWatch(`BedrockAgentCore Runtime ${logicalId} ${operation} wait`);
  try {
    let status: string | undefined;
    for (let poll = 1; poll <= RUNTIME_WAIT_MAX_POLLS; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      let runtime: GetAgentRuntimeCommandOutput;
      try {
        runtime = (await deps.client.send(
          new GetAgentRuntimeCommand({ agentRuntimeId })
        )) as GetAgentRuntimeCommandOutput;
      } catch (error) {
        const failed = describeAwsFailure(error);
        if (isRetryableTransientError(error, error instanceof Error ? error.message : '')) {
          deps.debug(
            mask(
              `Status read of runtime ${agentRuntimeId} failed transiently (${failed.detail}); polling on`
            )
          );
          await deps.sleep(RUNTIME_WAIT_POLL_MS);
          continue;
        }
        throw markNonRetryable(
          new ProvisioningError(
            `BedrockAgentCore Runtime ${logicalId} (${agentRuntimeId}) could not be read while cdkd waited for READY after ${operation}: ${failed.summary}`,
            resourceType,
            logicalId,
            agentRuntimeId,
            error instanceof Error ? error : undefined
          )
        );
      }
      status = runtime.status;
      if (status === 'READY') return runtime;
      if (status === 'CREATE_FAILED' || status === 'UPDATE_FAILED') {
        deps.debug(
          mask(`Runtime ${agentRuntimeId} failureReason: ${runtime.failureReason ?? '(none)'}`)
        );
        throw markNonRetryable(
          failure(
            `entered ${status} during ${operation}; its failureReason (GetAgentRuntime) says why`
          )
        );
      }
      if (status === undefined || !IN_FLIGHT.has(status)) {
        throw markNonRetryable(
          failure(
            `reported status ${status ?? '(none)'} while cdkd waited for READY after ${operation}`
          )
        );
      }
      deps.debug(`Runtime ${agentRuntimeId} is ${status} (poll ${poll}/${RUNTIME_WAIT_MAX_POLLS})`);
      await deps.sleep(RUNTIME_WAIT_POLL_MS);
    }
    throw markNonRetryable(
      failure(
        `was still ${status} ${(RUNTIME_WAIT_MAX_POLLS * RUNTIME_WAIT_POLL_MS) / 1000}s after the ${operation}; ` +
          `re-run once it is READY, or pass --no-wait to return without waiting`
      )
    );
  } finally {
    watch.dispose();
  }
}

/**
 * Before a delete: wait while the runtime is `CREATING` or `UPDATING`, so the
 * delete does not meet a runtime still in flight (a `--no-wait` deploy, or an
 * interrupted one, leaves it that way).
 *
 * Best effort: a read that fails (not found, a missing
 * `bedrock-agentcore:GetAgentRuntime` grant, a throttle) and a runtime still
 * in flight after {@link RUNTIME_WAIT_MAX_POLLS} reads both return, and the
 * delete goes ahead and gets AWS's own answer. Only an interrupt throws.
 */
export async function waitForRuntimeSettledBeforeDelete(
  deps: RuntimeWaitDeps,
  agentRuntimeId: string,
  logicalId: string
): Promise<void> {
  const watch = startInterruptWatch(`BedrockAgentCore Runtime ${logicalId} pre-delete wait`);
  try {
    for (let poll = 1; poll <= RUNTIME_WAIT_MAX_POLLS; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      let status: string | undefined;
      try {
        status = (
          (await deps.client.send(
            new GetAgentRuntimeCommand({ agentRuntimeId })
          )) as GetAgentRuntimeCommandOutput
        ).status;
      } catch (error) {
        deps.debug(
          `Pre-delete read of runtime ${agentRuntimeId} failed (${describeAwsFailure(error).summary}); deleting without waiting`
        );
        return;
      }
      if (status === undefined || !IN_FLIGHT.has(status)) return;
      deps.debug(
        `Runtime ${agentRuntimeId} is ${status}; waiting before the delete (poll ${poll}/${RUNTIME_WAIT_MAX_POLLS})`
      );
      await deps.sleep(RUNTIME_WAIT_POLL_MS);
    }
    deps.debug(`Runtime ${agentRuntimeId} is still in flight; deleting anyway`);
  } finally {
    watch.dispose();
  }
}
