import { DescribeTableCommand, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { definedAttributes } from '../../attribute-map.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { isTableName } from './table-helpers.js';

/**
 * Resolve a single `Fn::GetAtt` attribute for an existing DynamoDB table.
 *
 * CloudFormation's `AWS::DynamoDB::Table` exposes `Arn`, `StreamArn`
 * (a.k.a. `LatestStreamArn` in the SDK; CFn returns the latest enabled
 * stream's ARN), and `LatestStreamLabel`. All three are sibling fields on
 * the same `DescribeTable` response, so a single API call covers every
 * supported attr. See:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#aws-resource-dynamodb-table-return-values
 *
 * Used by `cdkd orphan` to live-fetch attribute values that need to be
 * substituted into sibling references.
 */
export async function getAttribute(
  this: DynamoDBTableProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  try {
    const resp = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: physicalId })
    );
    switch (attributeName) {
      case 'Arn':
        return resp.Table?.TableArn;
      case 'StreamArn':
        return resp.Table?.LatestStreamArn;
      case 'LatestStreamLabel':
        return resp.Table?.LatestStreamLabel;
      default:
        return undefined;
    }
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  }
}

/**
 * go-to-k/cdkd#4606: whether the table a failed CREATE journaled is the one
 * the record under the same logical id holds (a fix-forward that created a
 * new table there under another name).
 *
 * Both ids must be table NAMES (the physical id this provider records); an
 * ARN or anything else is `'unknown'`. A table name is unique per account
 * and region and a table cannot be renamed, and equal names are `'same'`
 * without a read: whatever table holds the name now is the record's, and
 * deleting by that name would delete it. After the region check the
 * record's table must read back (else `'unknown'`); the journaled one is
 * `'same'` when it reads back under the record's `TableId` (immutable,
 * AWS-generated, never given to a later table), `'different'` under
 * another, and `'different'` when AWS reports it gone: the record's table
 * answers to its own, other, name. Any other read failure throws, which the
 * caller reads as `'unknown'`.
 */
export async function isSameResource(
  this: DynamoDBTableProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::DynamoDB::Table') return 'unknown';
  if (!isTableName(journaledPhysicalId) || !isTableName(record.physicalId)) return 'unknown';
  if (journaledPhysicalId === record.physicalId) return 'same';
  const clientRegion = await this.dynamoDBClient.config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordTableId = await this.readTableIdIfExists(record.physicalId);
  if (recordTableId === undefined) return 'unknown';
  const journaledTableId = await this.readTableIdIfExists(journaledPhysicalId);
  if (journaledTableId === undefined) return 'different';
  return journaledTableId === recordTableId ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655 / #4606: the table's `TableId`, which AWS generates,
 * never changes and never gives a later table. A table re-created under the
 * name answers with another id, so the settle keeps it rather than deleting
 * it as the failed CREATE's orphan. A failed CREATE's own token comes from
 * its CreateTable response, on the failure's mark
 * (`markCreatedBeforeFailure`); this is the live read.
 *
 * `undefined` for another type, an id that is not a table name, or a client
 * in another region than `expectedRegion`. `RESOURCE_NOT_FOUND` only on
 * `ResourceNotFoundException`; any other failure, and a response naming
 * another table or no `TableId`, throws.
 */
export async function resourceIdentity(
  this: DynamoDBTableProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::DynamoDB::Table' || !isTableName(physicalId)) return undefined;
  const clientRegion = await this.dynamoDBClient.config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const live = await this.readTableIdIfExists(physicalId);
  return live === undefined ? RESOURCE_NOT_FOUND : live;
}

/**
 * The table's `TableId`, or `undefined` when `DescribeTable` answers
 * `ResourceNotFoundException`. Any other failure, a response naming another
 * table, and one naming no `TableId` throw: "could not read" never reads as
 * "gone".
 */
export async function readTableIdIfExists(
  this: DynamoDBTableProvider,
  tableName: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
  if (response.Table?.TableName !== tableName) {
    throw new Error('DescribeTable answered for another table than the one asked for');
  }
  const tableId = response.Table.TableId;
  if (typeof tableId !== 'string' || tableId === '') {
    throw new Error('DescribeTable returned no TableId');
  }
  return tableId;
}

/**
 * Adopt an existing DynamoDB table into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.TableName` → verify via `DescribeTable`.
 */
export async function importResource(
  this: DynamoDBTableProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'TableName');
  if (explicit) {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: explicit })
      );
      // Issue #3627: the same map `create()` records. The resolver's
      // `StreamArn` arm refuses the reference without it (issue #4077).
      return {
        physicalId: explicit,
        attributes: definedAttributes({
          Arn: resp.Table?.TableArn,
          TableId: resp.Table?.TableId,
          StreamArn: resp.Table?.LatestStreamArn,
          TableName: resp.Table?.TableName ?? explicit,
        }),
      };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a table
  // reaching here needs an explicit `--resource` override.
  return null;
}
