import type { CustomResourceProvider } from '../custom-resource-provider.js';
import {
  InvokeCommand,
  GetFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
  type InvocationResponse,
} from '@aws-sdk/client-lambda';
import { PublishCommand } from '@aws-sdk/client-sns';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { InterruptWatch } from '../../interrupt-watch.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import type { CfnCustomResourceResponse } from './lambda-payload.js';
import {
  WaiterRejections,
  observingLambdaClient,
  describeWaiterFailure,
  waitForLambdaFunctionActive,
  REFERENCED_LAMBDA_MAX_ARNS,
  REFERENCED_LAMBDA_MAX_WAIT_SECONDS,
  collectReferencedLambdaFunctionArns,
} from './lambda-waiter.js';
import {
  localCustomResourceRuntimeActive,
  noteSentToEmulatorRuntime,
} from '../../../local/custom-resource-runtime-gate.js';

/**
 * Send custom resource request via the appropriate service (Lambda or SNS)
 * For Lambda: invokes synchronously and returns the response
 * For SNS: publishes to topic and polls S3 for response
 *
 * Also returns the backing function's raw invocation `LogResult` when there
 * is one, so the caller can recover an authorization denial the handler
 * erased from the FAILED reason (issue #1674). Returned UNDECODED so the
 * happy path pays nothing — only a FAILED whose reason missed decodes it.
 * Absent on the SNS path: there is no Lambda invoke to attach a log to.
 *
 * `onDelivered` is invoked exactly once, the moment the `Invoke` / `Publish`
 * RETURNS — i.e. at the point after which a replay would re-deliver the
 * request to the handler and strand this attempt's pre-signed response URL.
 * The caller's retry-on-throw arm is fenced on it (issue #2033). Deliberately
 * called AFTER the send rather than before: a rejection at the API front door
 * (the IAM-propagation class this arm exists for) means the handler never ran,
 * and treating that as delivered would leave the reported failure single-shot.
 */
export async function sendRequest(
  this: CustomResourceProvider,
  serviceToken: string,
  request: Record<string, unknown>,
  responseKey: string,
  logicalId: string,
  operation: string,
  onDelivered: () => void,
  mask: MaskerFn | undefined
): Promise<{ response: CfnCustomResourceResponse; logResult?: string }> {
  if (this.isSnsServiceToken(serviceToken)) {
    this.logger.debug(`ServiceToken is SNS topic, publishing to: ${serviceToken}`);
    await this.publishToSns(serviceToken, request);
    onDelivered();
    return { response: await this.pollS3Response(responseKey, logicalId, operation) };
  }

  // Block until the backing Lambda is in a ready-to-Invoke state. The
  // Lambda CREATE / UPDATE returns synchronously while State / LastUpdateStatus
  // is still `Pending` / `InProgress`; a synchronous Invoke against
  // either fails with "The function is currently in the following
  // state: Pending" / "InProgress" (see PR #121). We wait HERE — at the
  // one consumer that breaks against not-ready Lambdas — instead of
  // gating every Lambda CREATE on Active, which doubled deploy time on
  // VPC-Lambda benchmark stacks.
  await this.waitForBackingLambdaReady(serviceToken, logicalId, mask);

  const invokeResponse = await this.invokeLambda(serviceToken, request);
  onDelivered();
  return {
    response: await this.getCustomResourceResponse(
      invokeResponse,
      responseKey,
      logicalId,
      operation,
      mask
    ),
    ...(invokeResponse.LogResult === undefined ? {} : { logResult: invokeResponse.LogResult }),
  };
}

/**
 * Block until the backing Lambda function for a Custom Resource is in a
 * state that accepts a synchronous Invoke.
 *
 * Two sequential waiters:
 *   1. `waitUntilFunctionActiveV2` — handles the post-CreateFunction
 *      `Pending` window (image pull, VPC ENI attachment, layer init).
 *   2. `waitUntilFunctionUpdatedV2` — handles the post-Update
 *      `InProgress` window (configuration / code swap settling).
 * Together they cover the only two transient states that reject
 * synchronous Invokes.
 *
 * In the common case (Lambda has been Active for a while, no in-flight
 * Update), both waiters return on first poll → ~2 GetFunction calls →
 * ~200ms overhead. That's the price for correctness; the alternative
 * (whole-stack Active wait at Lambda CREATE) is ~5–10 minutes per
 * VPC-attached function.
 *
 * `serviceToken` is the Lambda function ARN; the Lambda SDK accepts
 * both name and ARN as `FunctionName`, so we pass the ARN through
 * unchanged.
 *
 * `maxWaitTime` is set generously (10 min) because VPC ENI attachment
 * has been observed to take 8+ minutes in pathological cases. The
 * deploy engine's per-resource `--resource-timeout` (default 30 min)
 * still bounds the outer Custom Resource provisioning attempt, so
 * this waiter cap is layered defense, not the only timeout.
 *
 * **The wrapped failure is `markNonRetryable`d, and its message is NOT the
 * waiter's** (issue #2033). Both halves are about `@smithy/util-waiter`'s
 * `checkExceptions`, which serializes its whole result into the `Error`
 * message:
 *
 *  - On TIMEOUT that includes `observedResponses`, whose keys read
 *    `403: User: … is not authorized to perform: lambda:GetFunction on
 *    resource: …`. The waiter's generated `checkState` catches EVERY
 *    exception and returns `RETRY`, so reaching here means a 600s budget was
 *    already spent — yet the message matched
 *    {@link CustomResourceProvider.isTransientAuthzThrow} exactly, so a
 *    PERMANENT `lambda:GetFunction` denial was replayed for 3 x 600s instead
 *    of 10 minutes, blowing any `--resource-timeout
 *    AWS::CloudFormation::CustomResource=15m`. The marker is a property of
 *    the error object, so unlike a wording test it cannot be defeated by AWS
 *    rephrasing the denial.
 *  - On the FAILURE arm (`State: Failed`, i.e. an ENI / VPC failure) the
 *    serialized result carries `reason` and `final`, which for this waiter
 *    are the ENTIRE `GetFunction` response — `Configuration.Environment.
 *    Variables` included. That message reached `ProvisioningError.message`
 *    and `extractDeploymentEventError` persisted it to
 *    `deployments/{runId}.jsonl`, a durable store that outlives
 *    `cdkd destroy` and is contractually "error + metadata only, never
 *    resource properties, because they may contain secrets"
 *    (`docs/deployment-events.md`).
 *  - On the TIMEOUT / ABORT arms `reason` is a fixed string, but an
 *    `observedResponses` key is the serialized response for one without
 *    `$metadata.httpStatusCode`, and a rejected poll's own message otherwise
 *    — the 403 above, which names the caller's account, role and session
 *    (issue #4255).
 *
 * So every arm is rendered by `describeWaiterFailure` from an allowlist (see
 * `describeLambdaWaiterFailure`): each rejection the waiter's client met is
 * RECORDED and summarized by `describeAwsFailure` — `403: AccessDeniedException`
 * in the thrown text, AWS's sentence at `logger.debug` before the throw. The
 * caught error is rewritten IN PLACE to the same text, since it stays this
 * wrapper's `cause`.
 */
export async function waitForBackingLambdaReady(
  this: CustomResourceProvider,
  serviceToken: string,
  logicalId: string,
  mask: MaskerFn | undefined
): Promise<void> {
  // One record per waiter: rejections the first waiter polled through
  // before succeeding say nothing about why the second one failed.
  let rejections = new WaiterRejections();
  try {
    await waitUntilFunctionActiveV2(
      // Explicit cadence per the repo-wide waiter rule (#1291 item 5);
      // matches the Lambda V2 waiters' own dense 1s default.
      {
        client: observingLambdaClient(this.lambdaClient, rejections),
        maxWaitTime: 600,
        minDelay: 1,
        maxDelay: 5,
      },
      { FunctionName: serviceToken }
    );
    rejections = new WaiterRejections();
    await waitUntilFunctionUpdatedV2(
      // Explicit cadence per the repo-wide waiter rule (#1291 item 5);
      // matches the Lambda V2 waiters' own dense 1s default.
      {
        client: observingLambdaClient(this.lambdaClient, rejections),
        maxWaitTime: 600,
        minDelay: 1,
        maxDelay: 5,
      },
      { FunctionName: serviceToken }
    );
  } catch (error) {
    this.debugWaiterRejections(logicalId, rejections);
    throw markNonRetryable(
      new Error(
        `Lambda backing custom resource ${logicalId} (${serviceToken}) did not reach a ready state for Invoke: ${describeWaiterFailure(
          error,
          rejections,
          (line) => this.logger.debug(maskerOrIdentity(mask)(line))
        )}`,
        { cause: error }
      )
    );
  }
}

/**
 * Wait for each Lambda function the resource's properties point at (other
 * than its own backing function) to leave `Pending`, before the handler runs
 * (go-to-k/cdkd#5002 class; the first instance seen was an S3 notification
 * destination: `PutBucketNotificationConfiguration` answers "Unable to
 * validate the following destination configurations" for a `Pending` function).
 * `LambdaFunctionProvider.create` returns while the function is `Pending`, and
 * only a handler can tell what it will do with the ARN, so the wait lives here.
 *
 * **Best effort, never fatal.** One `GetFunctionConfiguration` per ARN, and
 * only a `Pending` function starts the waiter: the waiter's generated
 * `checkState` turns EVERY exception into RETRY, so calling it for an ARN cdkd
 * cannot read (deleted, another account or region, `lambda:GetFunction`
 * denied) would burn its whole 600s budget on a property the handler may never
 * touch. A read error, a `Failed` function or a spent waiter therefore skips
 * the wait and leaves the verdict to the handler, which is what a deploy did
 * before this wait existed. Only Ctrl-C throws.
 *
 * **One budget for the whole scan**: the waiters share a single
 * {@link REFERENCED_LAMBDA_MAX_WAIT_SECONDS} deadline, so several stuck
 * functions cannot turn a fast handler failure into a long hang.
 *
 * On update only an ARN absent from `previousProperties` is read: one that was
 * already there belongs to a function an earlier deploy created.
 *
 * Costs nothing for a custom resource whose properties name no function ARN.
 */
export async function waitForReferencedLambdasActive(
  this: CustomResourceProvider,
  logicalId: string,
  serviceToken: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  watch: InterruptWatch,
  mask: MaskerFn | undefined
): Promise<void> {
  // An ARN can come from an SSM or NoEcho value, and an AWS failure summary can echo
  // it, so every line is masked as a whole.
  const debug = (line: string): void => this.logger.debug(maskerOrIdentity(mask)(line));
  // Neither scan is capped: the cap applies to what is left AFTER the filter, so
  // an ARN that is new on update is read even when 16 older ones precede it.
  const already = new Set(
    previousProperties === undefined
      ? []
      : collectReferencedLambdaFunctionArns(previousProperties, serviceToken, Infinity)
  );
  const fresh = collectReferencedLambdaFunctionArns(properties, serviceToken, Infinity).filter(
    (arn) => !already.has(arn)
  );
  if (fresh.length > REFERENCED_LAMBDA_MAX_ARNS) {
    debug(
      safeMsg`${logicalId} references ${fresh.length} Lambda functions; only the first ${REFERENCED_LAMBDA_MAX_ARNS} are waited for`
    );
  }
  const arns = fresh.slice(0, REFERENCED_LAMBDA_MAX_ARNS);
  const deadline = Date.now() + REFERENCED_LAMBDA_MAX_WAIT_SECONDS * 1000;
  // One controller for the reads and the waiters: a Ctrl-C aborts whichever is running.
  const abort = new AbortController();
  const poll = setInterval(() => {
    if (watch.isInterrupted()) abort.abort();
  }, 1000);
  try {
    for (const arn of arns) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      let state: string | undefined;
      try {
        const config = await this.lambdaClient.send(
          new GetFunctionConfigurationCommand({ FunctionName: arn }),
          { abortSignal: abort.signal }
        );
        state = config.State;
      } catch (error) {
        // A Ctrl-C that landed during the read aborts it and is seen here.
        if (watch.isInterrupted()) throw watch.onInterrupted();
        debug(
          safeMsg`Not waiting for ${arn} referenced by ${logicalId}: ${describeAwsFailure(error).summary}`
        );
        continue;
      }
      if (watch.isInterrupted()) throw watch.onInterrupted();
      if (state !== 'Pending') continue;

      // `waitUntil*` rejects a `maxWaitTime` that is not above its 1s minimum delay.
      const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
      if (remainingSeconds <= 1) {
        debug(
          safeMsg`The wait budget for the functions referenced by ${logicalId} is spent; leaving ${arn} to the handler`
        );
        break;
      }
      debug(safeMsg`Waiting for ${arn} referenced by ${logicalId} to become Active`);
      try {
        await waitForLambdaFunctionActive(this.lambdaClient, arn, abort.signal, remainingSeconds);
      } catch (error) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        debug(
          safeMsg`Referenced function ${arn} of ${logicalId} did not become Active; leaving it to the handler: ${describeAwsFailure(error).summary}`
        );
      }
    }
  } finally {
    clearInterval(poll);
  }
}

/**
 * Publish custom resource request to an SNS topic
 */
export async function publishToSns(
  this: CustomResourceProvider,
  topicArn: string,
  request: Record<string, unknown>
): Promise<void> {
  await this.snsClient.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(request),
    })
  );
}

/**
 * Invoke Lambda function synchronously
 *
 * `LogType: 'Tail'` makes Lambda return the last 4 KB of THIS invocation's
 * log, base64-encoded, in `LogResult` (issue #1674). It is only valid with
 * `RequestResponse`, which is what this path always uses. This is deliberately
 * preferred over reading the function's CloudWatch log group after the fact:
 * it needs no CloudWatch Logs client, no `logs:GetLogEvents` on cdkd's own
 * credentials, and no extra API call — the tail rides the invoke response
 * cdkd already waits for, and is scoped to the exact invocation that failed
 * rather than to whatever happens to be latest in the log stream.
 */
export async function invokeLambda(
  this: CustomResourceProvider,
  serviceToken: string,
  request: Record<string, unknown>
): Promise<InvocationResponse> {
  // go-to-k/cdkd#6206: under `--aws-emulator` only, the function runs in the
  // official Lambda runtime image on this machine. `undefined` (always, off
  // the emulator) sends the event exactly as before.
  if (localCustomResourceRuntimeActive()) {
    const { invokeCustomResourceFunctionLocally } =
      await import('../../../local/custom-resource-runtime.js');
    const local = await invokeCustomResourceFunctionLocally(
      { lambda: this.lambdaClient, s3: this.s3Client },
      serviceToken,
      request
    );
    if (local !== undefined) return local;
    // go-to-k/cdkd#6247: the event goes to the emulator's own runtime.
    if (typeof request['LogicalResourceId'] === 'string') {
      noteSentToEmulatorRuntime(request['LogicalResourceId']);
    }
  }
  return await this.lambdaClient.send(
    new InvokeCommand({
      FunctionName: serviceToken,
      InvocationType: 'RequestResponse',
      LogType: 'Tail',
      Payload: Buffer.from(JSON.stringify(request)),
    })
  );
}
