import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import {
  DescribeLogGroupsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';

/**
 * Adopt an existing CloudWatch Logs log group into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.LogGroupName` → verify via
 *     `DescribeLogGroups` (filtered by name prefix).
 */
export async function importImpl(
  this: LogsLogGroupProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'LogGroupName');
  if (explicit) {
    try {
      const resp = await this.logsClient.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: explicit })
      );
      // One page is enough: the response is ASCII-sorted by name, so the
      // exact name sorts first among every name it prefixes.
      const found = resp.logGroups?.find((g) => g.logGroupName === explicit);
      return found ? { physicalId: explicit, attributes: {} } : null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a log
  // group reaching here needs an explicit `--resource` override.
  return null;
}
