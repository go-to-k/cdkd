import type { ElastiCacheProvider } from '../elasticache-provider.js';
import { markNotGone } from '../../not-gone.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { DeleteContext } from '../../region-check.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
} from '../../../types/resource.js';

/**
 * The failure wrap every SubnetGroup / CacheCluster create, update and
 * delete catch builds.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * `maskSecrets` (`mask`), and the wrap is stamped `markRedactedCause`, so the
 * retry classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}). A cdkd-authored or
 * transport error keeps its text, masked, stamped only when the mask changed
 * it (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
 * an AWS one, unstamped (it has no chain). The deletes check `*NotFoundFault` by name before
 * they wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: ElastiCacheProvider,
  mask: MaskerFn | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
  this.logger.debug(m(build(m(failure.detail)).message));
  const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
 * by its CLASS, and the delete classifiers read `NotFound` in a message as
 * "already deleted": a class naming ANOTHER object's not-found (this
 * resource's own not-found returned before the wrap) is marked
 * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
 */
export function wrapDeleteError(
  this: ElastiCacheProvider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const thrown = this.wrapCaughtError(mask, error, build);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

export async function create(
  this: ElastiCacheProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = context?.maskSecrets;
  switch (resourceType) {
    case 'AWS::ElastiCache::SubnetGroup':
      return this.createSubnetGroup(logicalId, resourceType, properties, mask);
    case 'AWS::ElastiCache::CacheCluster':
      return this.createCacheCluster(logicalId, resourceType, properties, mask);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

export async function update(
  this: ElastiCacheProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const mask = context?.maskSecrets;
  switch (resourceType) {
    case 'AWS::ElastiCache::SubnetGroup':
      return this.updateSubnetGroup(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        mask
      );
    case 'AWS::ElastiCache::CacheCluster':
      return this.updateCacheCluster(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        mask,
        context
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function deleteImpl(
  this: ElastiCacheProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  switch (resourceType) {
    case 'AWS::ElastiCache::SubnetGroup':
      return this.deleteSubnetGroup(logicalId, physicalId, resourceType, context);
    case 'AWS::ElastiCache::CacheCluster':
      return this.deleteCacheCluster(logicalId, physicalId, resourceType, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export function isNotFoundError(
  this: ElastiCacheProvider,
  error: unknown,
  faultName: string
): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = error.message.toLowerCase();
  return name === faultName || message.includes('not found') || message.includes('does not exist');
}
