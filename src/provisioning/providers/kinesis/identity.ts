import type { KinesisStreamProvider } from '../kinesis-provider.js';
import { DescribeStreamSummaryCommand, ResourceNotFoundException } from '@aws-sdk/client-kinesis';
import type { ResourceNotFound, ResourceIdentityVerdict } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { isStreamName } from './shared.js';

/**
 * go-to-k/cdkd#4606: whether the stream a failed CREATE journaled is the
 * one the record under the same logical id holds (a fix-forward that
 * created a new stream there).
 *
 * Both ids must be stream NAMES (the physical id on either route: Cloud
 * Control's primary identifier is the name too); an ARN or anything else
 * is `'unknown'`. Stream names are case-sensitive and unique per account
 * and region, and a stream cannot be renamed, so two distinct names in the
 * stack's region name two distinct streams. After the region check: the record's stream must exist (else `'unknown'`);
 * the journaled one is `'same'` when it reads back under the record's ARN,
 * `'different'` under another ARN or when AWS reports it gone (it cannot
 * then be the record's live stream; its delete settles as already gone).
 * Equal names are `'same'` without a read: whatever stream holds the name
 * now is the record's, and deleting by that name would delete it.
 */
export async function isSameResource(
  this: KinesisStreamProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  _resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (!isStreamName(journaledPhysicalId) || !isStreamName(record.physicalId)) return 'unknown';
  if (journaledPhysicalId === record.physicalId) return 'same';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordArn = await this.readStreamArnIfExists(record.physicalId);
  if (recordArn === undefined) return 'unknown';
  const journaledArn = await this.readStreamArnIfExists(journaledPhysicalId);
  if (journaledArn === undefined) return 'different';
  return journaledArn === recordArn ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655: the stream's ARN and creation time, `<arn>@<epoch ms>`.
 * The ARN is built from the name, so a stream re-created under the same
 * name repeats it; the creation timestamp is what tells the two apart.
 * Only a stream NAME is read (an ARN or anything else is `undefined`), and
 * only through a client in `expectedRegion`. `RESOURCE_NOT_FOUND` on
 * AWS's not-found answer; a response without both fields is `undefined`.
 */
export async function resourceIdentity(
  this: KinesisStreamProvider,
  physicalId: string,
  _resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (!isStreamName(physicalId)) return undefined;
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  let response;
  try {
    response = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: physicalId })
    );
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw error;
  }
  const arn = response.StreamDescriptionSummary?.StreamARN;
  const created = response.StreamDescriptionSummary?.StreamCreationTimestamp;
  if (typeof arn !== 'string' || arn === '') return undefined;
  if (!(created instanceof Date) || Number.isNaN(created.getTime())) return undefined;
  return `${arn}@${created.getTime()}`;
}
