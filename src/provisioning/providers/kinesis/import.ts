import type { KinesisStreamProvider } from '../kinesis-provider.js';
import { DescribeStreamCommand, ResourceNotFoundException } from '@aws-sdk/client-kinesis';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';

export async function importImpl(
  this: KinesisStreamProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'Name');
  if (explicit) {
    try {
      await this.getClient().send(new DescribeStreamCommand({ StreamName: explicit }));
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
  // tag never exists on a real resource and the walk could not match (issue
  // #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a stream
  // reaching here needs an explicit `--resource` override.
  return null;
}
