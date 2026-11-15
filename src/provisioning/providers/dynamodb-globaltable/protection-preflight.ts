import {
  DescribeTableCommand,
  ResourceNotFoundException,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
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
 * cannot answer (a missing grant, a throttle) is NOT a protected region. The
 * delete then proceeds as before, so a least-privilege caller loses no
 * destroy, and AWS's own refusal remains the backstop.
 */
export async function protectedRegionsBeforeDelete(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  localRegion: string,
  table: TableDescription | undefined,
  maskSecrets: SecretMasker
): Promise<string[]> {
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
      this.logger.debug(
        maskSecrets(
          `Could not read DeletionProtectionEnabled on the ${region} replica of ${tableName} ` +
            `before delete; proceeding: ${describeAwsFailure(readError).detail}`
        )
      );
    }
  }
  return found;
}

/**
 * The refusal TEXT for {@link protectedRegionsBeforeDelete}'s non-empty answer.
 * The caller throws it non-retryable, since a retry reads the same flags. It
 * avoids every phrase the already-deleted classifiers match, because the
 * resource still exists. The remedy depends on the caller: only `cdkd destroy`
 * takes `--remove-protection`, and a deploy's replacement or removal delete
 * never sets it.
 */
export function protectedDeleteMessage(
  logicalId: string,
  shownTable: string,
  regions: readonly string[],
  stackDestroy: boolean
): string {
  const remedy = stackDestroy
    ? `Re-run ${cdkdRemedy('cdkd destroy', '--remove-protection')}, or turn deletion protection off first.`
    : 'Turn deletion protection off in those regions first: a deploy never removes it.';
  return (
    safeMsg`DynamoDB GlobalTable ${logicalId} (${shownTable}) has deletion protection enabled in ${regions.join(', ')}; ` +
    `cdkd changed nothing, so no replica was dropped. ${remedy}`
  );
}
