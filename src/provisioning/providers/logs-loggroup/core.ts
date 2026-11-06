import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import {
  DescribeLogGroupsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import { chunks, isAccessDeniedError, lookupEachName, withApiLimit } from '../../name-lookup.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';

/**
 * The failure wrap the create / update / delete catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through `mask`,
 * and the wrap is stamped `markRedactedCause`, so the retry classifiers read
 * the withheld text on the `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}), except from a create-time wiring call's
 * failure ({@link markAuxiliaryFailure}), where "it" would read as the log
 * group. A non-`Error` throw is withheld the same way, unstamped: it has no
 * chain to read.
 *
 * A cdkd-authored or transport error keeps its text, masked RAW (an AWS SDK
 * error can echo a request value such as a resolved tag value), stamped
 * exactly when the mask changed it (`wrapMaskedAwsError`, issue #4259). The
 * delete checks `ResourceNotFoundException` by type before it wraps. A
 * method, so `gen-update-wrap-coverage` sees the catch that throws it as a
 * wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: LogsLogGroupProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(`${mask(failure.summary)}${relay}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/** go-to-k/cdkd#4705: the name `create()` sends when the template names none. */
export function generatedCreateName(
  this: LogsLogGroupProvider,
  _resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>
): string | undefined {
  if (properties['LogGroupName']) return undefined;
  return generatedNameFor('AWS::Logs::LogGroup', logicalId);
}

/**
 * go-to-k/cdkd#4705: the log group's `creationTime` (epoch ms), so a kept
 * log group licenses only a holder created no later than it was kept.
 */
export async function holderCreatedAt(
  this: LogsLogGroupProvider,
  _resourceType: string,
  physicalId: string
): Promise<number | undefined> {
  const resp = await this.logsClient.send(
    new DescribeLogGroupsCommand({ logGroupNamePrefix: physicalId })
  );
  const group = resp.logGroups?.find((g) => g.logGroupName === physicalId);
  return typeof group?.creationTime === 'number' ? group.creationTime : undefined;
}

/**
 * go-to-k/cdkd#4705: `DescribeLogGroups` by `logGroupIdentifiers` -- exact
 * names, up to 50 per call -- the chunks in parallel through one run-wide
 * limiter, so N log groups cost ceil(N/50) calls and about one round trip,
 * never serial pages. Per-name lookups when the identifiers are refused (a
 * cross-account monitoring account takes ARNs there) or not granted.
 */
export async function lookupNames(
  this: LogsLogGroupProvider,
  _resourceType: string,
  names: readonly string[]
): Promise<Map<string, string>> {
  try {
    const found = new Map<string, string>();
    const wanted = new Set(names);
    await Promise.all(
      chunks(names, 50).map((chunk) =>
        withApiLimit('logs:DescribeLogGroups', 3, async () => {
          const resp = await this.logsClient.send(
            new DescribeLogGroupsCommand({ logGroupIdentifiers: chunk })
          );
          for (const group of resp.logGroups ?? []) {
            const name = group.logGroupName;
            if (name !== undefined && wanted.has(name)) found.set(name, name);
          }
        })
      )
    );
    return found;
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (
      !isAccessDeniedError(err) &&
      name !== 'InvalidParameterException' &&
      name !== 'ValidationException'
    ) {
      throw err;
    }
  }
  return lookupEachName(names, 'logs:DescribeLogGroups', 3, async (logGroupName) => {
    try {
      const resp = await this.logsClient.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName })
      );
      // The response is ASCII-sorted, so the exact name sorts first among
      // every name it prefixes: one page answers.
      return resp.logGroups?.some((g) => g.logGroupName === logGroupName)
        ? logGroupName
        : undefined;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  });
}
