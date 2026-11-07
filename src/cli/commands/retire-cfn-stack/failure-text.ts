import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';

/**
 * Where to look for the copies a replacing Retain update superseded when cdkd
 * could not compare the ids itself (issue #4873). Shared by the waiter failure
 * here and the import's failed re-read.
 */
export const SUPERSEDED_COPY_HINT =
  'If that update completes (now or later), CloudFormation may have replaced resources; ' +
  'each superseded copy is RETAINED and managed by neither CloudFormation nor cdkd. ' +
  "Find them in the stack's events: rows whose reason reads " +
  '"Requested update requires the creation of a new physical resource" name the old ' +
  'physical id. A re-run does not report them, because the template then already ' +
  'carries the Retain policies and no update runs.';

/**
 * The route by hand, in the order that cannot record a superseded id (issue
 * #4873): Retain first, adopt second, delete last. The import step reads ids
 * from a same-named CloudFormation stack in auto mode (#1128).
 */
export const MANUAL_RETIREMENT_ROUTE =
  'To retire the stack by hand: (1) UpdateStack with DeletionPolicy=Retain and ' +
  'UpdateReplacePolicy=Retain on every resource, (2) `cdkd import` without ' +
  '--migrate-from-cloudformation (it reads the physical ids from a same-named ' +
  'CloudFormation stack), (3) DeleteStack. The import must adopt every resource ' +
  'before you delete the stack: check its summary.';

/**
 * What a CloudFormation stack waiter's failure may say in a message (issue
 * #4873). The SDK waiter throws `new Error(JSON.stringify(result))`, whose
 * `reason` is the last `DescribeStacks` response — Outputs and Parameters
 * included, so a NoEcho-derived Output would print in plaintext. Only the
 * waiter state and the stack's `StackStatus` / `StackStatusReason` are kept,
 * the precedent being `describeLambdaWaiterFailure` in
 * `custom-resource-provider.ts`. `undefined` when `error` is not a waiter
 * result.
 */
export function describeStackWaiterFailure(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('state' in parsed)) return undefined;
  const result = parsed as { state?: unknown; reason?: unknown };
  const state = typeof result.state === 'string' ? result.state : 'FAILURE';
  const reason = result.reason;
  const stacks =
    typeof reason === 'object' && reason !== null && 'Stacks' in reason
      ? (reason as { Stacks?: unknown }).Stacks
      : undefined;
  const stack = Array.isArray(stacks) && typeof stacks[0] === 'object' ? stacks[0] : undefined;
  const status = typeof stack?.StackStatus === 'string' ? stack.StackStatus : undefined;
  const statusReason =
    typeof stack?.StackStatusReason === 'string' ? stack.StackStatusReason : undefined;
  return (
    `waiter ${state}` +
    (status ? `, stack status ${status}` : typeof reason === 'string' ? `: ${reason}` : '') +
    (statusReason ? ` (${statusReason})` : '')
  );
}

/**
 * The text a message may carry for a CloudFormation call or waiter failure: the
 * reduced waiter text, else `describeAwsFailure(...).summary`. The withheld
 * detail goes to debug only. A waiter error kept as a `cause` has its own
 * message rewritten in place too, so a render that walks the chain cannot print
 * the payload either.
 */
export function cfnFailureText(error: unknown): string {
  const waiter = describeStackWaiterFailure(error);
  if (waiter !== undefined && error instanceof Error) {
    try {
      Object.defineProperty(error, 'message', {
        value: waiter,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(error, 'stack', {
        value: `${error.name}: ${waiter}`,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // A frozen error keeps its message; the text returned below is still reduced.
    }
    return waiter;
  }
  const failure = describeAwsFailure(error);
  if (failure.redacted)
    getLogger().debug(safeMsg`CloudFormation failure detail: ${failure.detail}`);
  // Callers append their own `. `; the summary's pointer already ends a sentence.
  return failure.summary.replace(/\.+$/, '');
}

/**
 * The Retain `UpdateStack` failed, or its wait did not see it finish, before
 * any cdkd state was written (issue #4873). The message carries the manual
 * route because the failure can be DETERMINISTIC — a custom-named resource
 * CloudFormation must replace fails the same way on every re-run — and the
 * flow that used to write state first no longer does.
 */
export class RetainUpdateFailedError extends Error {
  override readonly cause?: unknown;
  constructor(cfnStackName: string, kind: 'rejected' | 'unfinished', cause: unknown) {
    const text = cfnFailureText(cause);
    super(
      safeMsg`The Retain-policy UpdateStack on CloudFormation stack ${displaySafe(cfnStackName)} ` +
        (kind === 'rejected' ? 'was rejected' : 'did not complete') +
        safeMsg`: ${text}. cdkd state has not been written. ` +
        (kind === 'unfinished' ? `${SUPERSEDED_COPY_HINT} ` : '') +
        'Re-run the same command once the cause is fixed. When the cause is a replacement ' +
        'CloudFormation cannot perform (a custom-named resource whose update requires ' +
        'replacing it), the same update by hand fails too: give that resource no custom ' +
        'name or a new one, or take it out of the stack, then re-run. ' +
        MANUAL_RETIREMENT_ROUTE
    );
    this.name = 'RetainUpdateFailedError';
    this.cause = cause;
  }
}
