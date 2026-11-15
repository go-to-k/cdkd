import {
  DescribeTableCommand,
  ResourceNotFoundException,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { isThrottlingError, isTransientServerError } from '../../../deployment/retryable-errors.js';
import { isInterruptedWaitError } from '../../interrupt-watch.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { SecretMasker } from '../../../types/resource.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * go-to-k/cdkd#6367: the regions whose copy of the table has deletion
 * protection ON, read BEFORE `delete()` makes its first write.
 *
 * Without `--remove-protection`, the delete drops every cross-region replica
 * first and only then sends `DeleteTable`. A protected LOCAL table refused that
 * call after every other region's copy was already gone. A protected
 * cross-region replica refused its own drop after the replicas before it in
 * the loop were gone. Either way the table was left stripped, and state no
 * longer matched AWS.
 *
 * The local flag comes from the `DescribeTable` the delete already made. Each
 * cross-region replica is read in its own region, because a replica's
 * `ReplicaDescription` carries no `DeletionProtectionEnabled`. A read that
 * cannot answer has two arms. A throttle or 5xx is RETHROWN, so the destroy
 * loop re-enters and reads again. Reading it as "not protected" would reopen
 * the partial strip this guard exists to stop. Any other failure, typically a
 * missing grant, proceeds with a WARNING naming the region, so a
 * least-privilege caller loses no destroy, and AWS's own refusal stays the
 * backstop.
 *
 * Residual (accepted): protection turned on between this read and the replica
 * loop is seen only by AWS's refusal, after the replicas before it in the loop
 * are dropped. The reads are single calls, so they are not clamped by the
 * delete budget.
 */
export async function protectedRegionsBeforeDelete(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  localRegion: string,
  table: TableDescription | undefined,
  maskSecrets: SecretMasker
): Promise<string[]> {
  // The name is masked as a VALUE, so one below the substring floor is caught.
  const shownTable = maskSecrets(tableName);
  const found: string[] = [];
  if (table?.DeletionProtectionEnabled === true) found.push(localRegion);
  for (const replica of table?.Replicas ?? []) {
    const region = replica.RegionName;
    if (!region || region === localRegion) continue;
    try {
      const regional = await this.getRegionalClient(region).send(
        new DescribeTableCommand({ TableName: tableName })
      );
      if (regional.Table?.DeletionProtectionEnabled === true) found.push(region);
    } catch (readError) {
      if (isInterruptedWaitError(readError)) throw readError;
      // Gone already: nothing there to strip or protect.
      if (readError instanceof ResourceNotFoundException) continue;
      if (isThrottlingError(readError) || isTransientServerError(readError)) throw readError;
      this.logger.warn(
        maskSecrets(
          safeMsg`Could not read DeletionProtectionEnabled on the ${region} replica of ${shownTable} ` +
            `before delete (${describeAwsFailure(readError).summary}); proceeding. If that replica is ` +
            `protected, AWS refuses its removal after the replicas before it are dropped.`
        )
      );
      this.logger.debug(maskSecrets(describeAwsFailure(readError).detail));
    }
  }
  return found;
}

/**
 * The refusal TEXT for {@link protectedRegionsBeforeDelete}'s non-empty answer.
 * The caller throws it non-retryable, since a retry reads the same flags. It
 * avoids every phrase the already-deleted classifiers match, because the
 * resource still exists.
 *
 * `alreadyDropped` holds the regions an EARLIER attempt of this delete dropped
 * (a re-entry). This attempt changed nothing, but the table may already be
 * missing those regions, so the message says so rather than claiming no
 * replica was dropped. The remedy names no command: `cdkd destroy`,
 * `cdkd state destroy` and `cdkd rollback` all take `--remove-protection`, and
 * a deploy's removal or replacement delete takes none.
 */
export function protectedDeleteMessage(
  logicalId: string,
  shownTable: string,
  regions: readonly string[],
  stackDestroy: boolean,
  alreadyDropped: readonly string[]
): string {
  const changed =
    alreadyDropped.length === 0
      ? 'cdkd changed nothing, so no replica was dropped.'
      : safeMsg`cdkd changed nothing on this attempt; an earlier attempt already dropped the replica in ${alreadyDropped.join(', ')}.`;
  const remedy = stackDestroy
    ? 'Re-run the destroy with --remove-protection, or turn deletion protection off first.'
    : 'Turn deletion protection off in those regions, or pass --remove-protection where the command takes it, then retry.';
  return (
    safeMsg`DynamoDB GlobalTable ${logicalId} (${shownTable}) has deletion protection enabled in ${regions.join(', ')}; ` +
    `${changed} ${remedy}`
  );
}
