import type { CustomResourceProvider } from '../custom-resource-provider.js';
import {
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import {
  WaiterRejections,
  observingLambdaClient,
  carriesResponseBody,
  waiterRejectionDebugLines,
  withholdWaiterPayload,
} from './lambda-waiter.js';
import {
  CR_RECYCLE_DESCRIPTION_PREFIX,
  CR_RECYCLE_RESTORE_CONFLICT_RETRIES,
  CR_RECYCLE_RESTORE_CONFLICT_WAIT_SECONDS,
  CR_RECYCLE_BUDGET_SECONDS,
  CR_RECYCLE_MIN_WAIT_SECONDS,
  recycleFunctionKey,
} from './retry-policy.js';

/**
 * Force the backing Lambda to drop its warm execution environment(s) so the
 * next invoke cold-starts and re-assumes the execution role, picking up the
 * now-propagated inline policy. A plain re-invoke would otherwise reuse the
 * same warm container that cached the stale credentials. Best-effort: any
 * failure (e.g. cdkd's own creds lack `lambda:UpdateFunctionConfiguration`)
 * degrades to a debug log and we still retry the invoke.
 *
 * A `Description` write is the least-intrusive way to invalidate warm
 * containers, but it is NOT invisible: CDK's own handlers declare one (e.g.
 * `AWS CloudFormation handler for "Custom::S3BucketNotifications" resources
 * (@aws-cdk/aws-s3)`), state records it, and a marker left behind is a
 * permanent `cdkd drift` that no redeploy repairs, since the template diff
 * is `NO_CHANGE` (issue #5738). So the prior Description is read first and
 * written back once the marker's update has settled. The restore is itself
 * a configuration update, so the next invoke still cold-starts.
 *
 * Serialised per function (`recycleChains`, keyed by `recycleFunctionKey`,
 * so a qualified and an unqualified ServiceToken for one function share a
 * chain): a concurrent recycle must read the restored text, not this one's
 * marker. A restore refused with `ResourceConflictException` (the marker's
 * update still in progress) waits and re-sends, within a small bound;
 * every wait in a recycle shares one `CR_RECYCLE_BUDGET_SECONDS` budget.
 * A read that returns a marker (an earlier restore failed) falls back to
 * the remembered original (`originalDescriptions`). A read that fails, or
 * answers with no `FunctionName` (no configuration at all), leaves the
 * original unknown: the recycle still runs and the restore is skipped, as
 * an unread value is never written. An EMPTY Description — `''` or the
 * member absent from a real configuration — is restored as empty.
 * Every failure here is best-effort, logged at debug, never fatal.
 */
export async function recycleBackingFunctionExecEnv(
  this: CustomResourceProvider,
  serviceToken: string,
  logicalId: string,
  mask: MaskerFn | undefined
): Promise<void> {
  // SNS-backed custom resources have no Lambda to recycle (the token is a
  // topic ARN); skip the pointless, guaranteed-to-fail API call.
  if (this.isSnsServiceToken(serviceToken)) return;
  const key = recycleFunctionKey(serviceToken);
  const previous = this.recycleChains.get(key) ?? Promise.resolve();
  const run = previous.then(() => this.recycleAndRestore(serviceToken, key, logicalId, mask));
  // `recycleAndRestore` never rejects, but a chain must not be poisoned by
  // one that did: every later recycle on this function would reject too.
  const tail = run.catch(() => undefined);
  this.recycleChains.set(key, tail);
  try {
    await run;
  } finally {
    if (this.recycleChains.get(key) === tail) this.recycleChains.delete(key);
  }
}

/** One serialised recycle: read the prior Description, mark, settle, restore, settle. */
export async function recycleAndRestore(
  this: CustomResourceProvider,
  serviceToken: string,
  key: string,
  logicalId: string,
  mask: MaskerFn | undefined
): Promise<void> {
  const deadline = Date.now() + CR_RECYCLE_BUDGET_SECONDS * 1000;
  // Whole seconds of the recycle's budget left, capped at `cap`.
  const remaining = (cap: number): number =>
    Math.min(cap, Math.floor((deadline - Date.now()) / 1000));
  const original = await this.readOriginalDescription(serviceToken, key, logicalId, mask);
  const rejections = new WaiterRejections();
  try {
    await this.lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: serviceToken,
        Description: `${CR_RECYCLE_DESCRIPTION_PREFIX}${logicalId})`,
      })
    );
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not recycle backing function for ${logicalId} (${this.describeRecycleFailure(error, rejections, mask)}); retrying invoke without a forced cold start`
    );
    // The marker never landed, so there is nothing to restore.
    return;
  }
  try {
    await this.waitForBackingFunctionUpdated(serviceToken, rejections, remaining(120));
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not recycle backing function for ${logicalId} (${this.describeRecycleFailure(error, rejections, mask)}); retrying invoke without a forced cold start`
    );
    this.debugWaiterRejections(logicalId, rejections);
    // The marker DID land: still try to put the original back below.
  }
  if (original === undefined) {
    this.logger.debug(
      safeMsg`Not restoring the backing function's Description for ${logicalId}: its prior value could not be read`
    );
    return;
  }
  // Writes back the value read before the marker. A change another process
  // made to this Description in between is overwritten — the marker write
  // itself always overwrote it the same way.
  const restoreRejections = new WaiterRejections();
  for (let attempt = 0; ; attempt++) {
    try {
      await this.lambdaClient.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: serviceToken,
          Description: original,
        })
      );
      break;
    } catch (error) {
      // The marker's update can still be InProgress (its waiter above gave
      // up), and Lambda refuses a second update until it settles. Giving up
      // on that FIRST conflict would leave the marker for good, so wait for
      // the function again and retry, within a small bound.
      const conflictWait = remaining(CR_RECYCLE_RESTORE_CONFLICT_WAIT_SECONDS);
      if (
        error instanceof Error &&
        error.name === 'ResourceConflictException' &&
        attempt < CR_RECYCLE_RESTORE_CONFLICT_RETRIES &&
        conflictWait >= CR_RECYCLE_MIN_WAIT_SECONDS
      ) {
        const conflictRejections = new WaiterRejections();
        try {
          await this.waitForBackingFunctionUpdated(serviceToken, conflictRejections, conflictWait);
        } catch {
          // Retried regardless: the next send reports whether it settled.
        }
        continue;
      }
      this.logger.debug(
        safeMsg`Could not restore the backing function's Description after the recycle for ${logicalId} (${this.describeRecycleFailure(error, restoreRejections, mask)}); \`cdkd drift\` will report it until the function is next updated`
      );
      return;
    }
  }
  const settleWait = remaining(120);
  if (settleWait < CR_RECYCLE_MIN_WAIT_SECONDS) {
    this.logger.debug(
      safeMsg`Restored the backing function's Description after the recycle for ${logicalId}, but the recycle's time budget ran out before the update settled`
    );
    return;
  }
  try {
    // Settled before the chain moves on: the next recycle's update would
    // otherwise hit `ResourceConflictException` against this one.
    await this.waitForBackingFunctionUpdated(serviceToken, restoreRejections, settleWait);
  } catch (error) {
    this.logger.debug(
      safeMsg`Restored the backing function's Description after the recycle for ${logicalId}, but the update did not settle (${this.describeRecycleFailure(error, restoreRejections, mask)})`
    );
    this.debugWaiterRejections(logicalId, restoreRejections);
  }
}

/**
 * The backing function's Description as it stood before any cdkd recycle,
 * or `undefined` when unknown (see `recycleBackingFunctionExecEnv`).
 */
export async function readOriginalDescription(
  this: CustomResourceProvider,
  serviceToken: string,
  key: string,
  logicalId: string,
  mask: MaskerFn | undefined
): Promise<string | undefined> {
  let current: string | undefined;
  try {
    const config = await this.lambdaClient.send(
      new GetFunctionConfigurationCommand({ FunctionName: serviceToken })
    );
    // An absent `Description` on a real configuration is an empty one (the
    // SDK model declares the member optional): restore it as ''. A response
    // naming no function is no configuration at all, so nothing was read.
    if (config.FunctionName !== undefined) current = config.Description ?? '';
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not read the backing function's Description for ${logicalId} before recycling it (${this.describeRecycleFailure(error, new WaiterRejections(), mask)})`
    );
  }
  if (current !== undefined && !current.startsWith(CR_RECYCLE_DESCRIPTION_PREFIX)) {
    this.originalDescriptions.set(key, current);
    return current;
  }
  return this.originalDescriptions.get(key);
}

export async function waitForBackingFunctionUpdated(
  this: CustomResourceProvider,
  serviceToken: string,
  rejections: WaiterRejections,
  maxWaitTime = 120
): Promise<void> {
  await waitUntilFunctionUpdatedV2(
    // Explicit cadence per the repo-wide waiter rule (#1291 item 5);
    // matches the Lambda V2 waiters' own dense 1s default.
    {
      client: observingLambdaClient(this.lambdaClient, rejections),
      maxWaitTime,
      minDelay: 1,
      maxDelay: 5,
    },
    { FunctionName: serviceToken }
  );
}

/**
 * The detail a recycle / restore failure is logged with. A failed
 * `waitUntilFunctionUpdatedV2` carries the whole `GetFunction` response in
 * its message (see `describeLambdaWaiterFailure`), and this logger masks
 * nothing: withhold it. An `UpdateFunctionConfiguration` /
 * `GetFunctionConfiguration` failure is not waiter-shaped and keeps its AWS
 * detail — unless it failed to deserialize the response, a
 * `FunctionConfiguration` whose `Environment.Variables` the parse message
 * can quote (`carriesResponseBody`).
 */
export function describeRecycleFailure(
  this: CustomResourceProvider,
  error: unknown,
  rejections: WaiterRejections,
  mask: MaskerFn | undefined
): string {
  return (
    withholdWaiterPayload(error, rejections, (line) =>
      this.logger.debug(maskerOrIdentity(mask)(line))
    ) ??
    (error instanceof Error && carriesResponseBody(error)
      ? `${error.name} (response body withheld)`
      : describeAwsFailure(error).detail)
  );
}

/**
 * The full text of each rejection a failed readiness waiter recorded that
 * `describeAwsFailure` withheld from the thrown message (issue #2302): an
 * AWS `AccessDenied` names the caller's account, role and session, so it
 * belongs at `debug`, where it still separates a missing grant from a
 * policy `Deny`.
 */
export function debugWaiterRejections(
  this: CustomResourceProvider,
  logicalId: string,
  rejections: WaiterRejections
): void {
  for (const line of waiterRejectionDebugLines(rejections)) {
    this.logger.debug(safeMsg`Readiness waiter for ${logicalId} observed ${line}`);
  }
}
