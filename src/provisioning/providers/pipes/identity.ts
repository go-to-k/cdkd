import type { PipesPipeProvider } from '../pipes-provider.js';
import {
  RESOURCE_NOT_FOUND,
  type ResourceIdentityVerdict,
  type ResourceNotFound,
} from '../../../types/resource.js';
import { IDENTITY_STATES, PIPE_TYPE, isPipeName, pipeIdentityToken } from './shared.js';

/**
 * go-to-k/cdkd#4606: whether the pipe a failed CREATE journaled is the one
 * the record under the same logical id holds (a fix-forward that created a
 * new one there under another name).
 *
 * Only `AWS::Pipes::Pipe`; both ids must be pipe NAMES (the physical id
 * this provider records), else `'unknown'`, and so are two names differing
 * only in case: this check does not decide on the Pipes API's case rules.
 * Equal names are `'same'` without a read: whatever holds the name now is
 * the record's, and deleting by that name would delete it. A pipe name is
 * unique per account and region and cannot be changed (`Name` is
 * create-only). After the region check the record's pipe must read back
 * (else `'unknown'`); the journaled one is `'same'` when it reads back
 * under the record's ARN, `'different'` under another, and `'different'`
 * when AWS answers not-found: the record's pipe answers to its own, other,
 * name. Any other read failure throws, which the caller reads as
 * `'unknown'`.
 */
export async function isSameResource(
  this: PipesPipeProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== PIPE_TYPE) return 'unknown';
  if (!isPipeName(journaledPhysicalId) || !isPipeName(record.physicalId)) return 'unknown';
  if (journaledPhysicalId === record.physicalId) return 'same';
  if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'unknown';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordPipe = await this.describeIfExists(record.physicalId);
  if (recordPipe === undefined) return 'unknown';
  const recordArn = recordPipe.Arn;
  if (typeof recordArn !== 'string' || recordArn === '') return 'unknown';
  const journaledPipe = await this.describeIfExists(journaledPhysicalId);
  if (journaledPipe === undefined) return 'different';
  const journaledArn = journaledPipe.Arn;
  if (typeof journaledArn !== 'string' || journaledArn === '') return 'unknown';
  // Unreachable as 'same' while the names differ beyond case (the ARN ends
  // in the name); kept so the verdict rests on AWS's answer.
  return journaledArn === recordArn ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655 / #4606: the pipe's identity token,
 * `<pipeArn>@<creationTime epoch seconds>` ({@link pipeIdentityToken}),
 * from `DescribePipe`. A failed CREATE's token rides its mark from
 * `CreatePipe`'s answer; this read is the settle's, made before it deletes
 * the journaled pipe, so no ordinary deploy pays for it.
 *
 * `undefined` for another type, an id that is not a pipe name, a client in
 * another region than `expectedRegion`, an answer for another name, a pipe
 * in `DELETING` or a state {@link IDENTITY_STATES} does not list, and an
 * answer without a usable ARN or creation time. `RESOURCE_NOT_FOUND` only
 * when AWS answers `NotFoundException`; any other failure throws.
 */
export async function resourceIdentity(
  this: PipesPipeProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== PIPE_TYPE || !isPipeName(physicalId)) return undefined;
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const pipe = await this.describeIfExists(physicalId);
  if (pipe === undefined) return RESOURCE_NOT_FOUND;
  if (pipe.Name !== physicalId) return undefined;
  if (pipe.CurrentState === undefined || !IDENTITY_STATES.has(pipe.CurrentState)) {
    return undefined;
  }
  return pipeIdentityToken(physicalId, pipe.Arn, pipe.CreationTime);
}
