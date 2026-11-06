import type { NeptuneProvider } from '../neptune-provider.js';
import {
  NeptuneClient,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-neptune';
import { EC2Client } from '@aws-sdk/client-ec2';
import { markNotGone } from '../../not-gone.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { DeleteContext } from '../../region-check.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceIdentityVerdict,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { isDbIdentifier } from './shared.js';

export function getClient(this: NeptuneProvider): NeptuneClient {
  if (!this.neptuneClient) {
    // Built together with the create client, so both capture the identity
    // active at this ONE call (issue #4639).
    this.neptuneClient = new NeptuneClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
    this.createClient = withoutServerErrorRetries(
      new NeptuneClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.neptuneClient;
}

/** Only a removed DBCluster `VpcSecurityGroupIds` reaches EC2 (issue #1160). */
export function getEc2Client(this: NeptuneProvider): EC2Client {
  if (!this.ec2Client) {
    this.ec2Client = new EC2Client({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.ec2Client;
}

/**
 * The client `CreateDBSubnetGroup` / `CreateDBCluster` / `CreateDBInstance`
 * and both cluster restores go through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
 * keeps the full SDK retry.
 *
 * None of them carries an idempotency token, and each name is unique
 * per account and region, so the SDK's own replay of a 5xx whose request had
 * succeeded collides with what the first send made, and that "already
 * exists" surfaced from the engine's FIRST attempt as a name somebody else
 * holds. Refused here, the 5xx reaches the deploy engine's retry, which
 * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
 * adopted on that collision: a name is not attribution
 * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
 */
export function getCreateClient(this: NeptuneProvider): NeptuneClient {
  this.getClient();
  return this.createClient as NeptuneClient;
}

// ─── Dispatch ─────────────────────────────────────────────────────

export async function create(
  this: NeptuneProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = context?.maskSecrets;
  switch (resourceType) {
    case 'AWS::Neptune::DBSubnetGroup':
      return this.createDBSubnetGroup(logicalId, resourceType, properties, mask);
    case 'AWS::Neptune::DBCluster':
      return this.createDBCluster(
        logicalId,
        resourceType,
        properties,
        mask,
        context?.replayingState === true
      );
    case 'AWS::Neptune::DBInstance':
      return this.createDBInstance(
        logicalId,
        resourceType,
        properties,
        mask,
        context?.replayingState === true
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

export async function update(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  switch (resourceType) {
    case 'AWS::Neptune::DBSubnetGroup':
      return this.updateDBSubnetGroup(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets
      );
    case 'AWS::Neptune::DBCluster':
      return this.updateDBCluster(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::Neptune::DBInstance':
      return this.updateDBInstance(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
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
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  switch (resourceType) {
    case 'AWS::Neptune::DBSubnetGroup':
      return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType, context);
    case 'AWS::Neptune::DBCluster':
      return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
    case 'AWS::Neptune::DBInstance':
      return this.deleteDBInstance(logicalId, physicalId, resourceType, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * The failure wrap the DBSubnetGroup / DBCluster / DBInstance create, update
 * and delete catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * masker, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}), so a create-first
 * replacement still recognises the collision. A cdkd-authored or transport
 * error keeps its text, masked, stamped only when the mask changed it
 * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
 * an AWS one, unstamped (it has no chain). The delete catches test not-found
 * before they wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: NeptuneProvider,
  mask: ((text: string) => string) | undefined,
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
  this: NeptuneProvider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const thrown = this.wrapCaughtError(mask, error, build);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via Neptune's
 * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
 * `ResourceName=arn`).
 */
export async function applyTagDiff(
  this: NeptuneProvider,
  arn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown
): Promise<void> {
  // go-to-k/cdkd#3994: both sides are read through `planTagDiff`; an
  // unreadable record untags nothing.
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.getClient().send(
      new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
    );
    this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from Neptune resource ${arn}`);
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(
      new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
    );
    this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on Neptune resource ${arn}`);
  }
}

export function isNotFoundError(this: NeptuneProvider, error: unknown, faultName: string): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = error.message.toLowerCase();
  return name === faultName || message.includes('not found') || message.includes('does not exist');
}

/**
 * go-to-k/cdkd#4606: whether the DB cluster or DB instance a failed CREATE
 * journaled is the one the record under the same logical id holds (a
 * fix-forward that created a new one there under another identifier).
 *
 * Reached on the SDK route only (Cloud Control's provider has no
 * `isSameResource`, so a Cloud Control-routed orphan is `'unknown'`). Both
 * ids must be DB identifiers; an ARN or anything else is `'unknown'`, as
 * is a DBSubnetGroup. An identifier names at most one cluster (or
 * instance) per account and region at a time, across Neptune, RDS and
 * DocumentDB, and is compared case-insensitively (stored lower-cased), so
 * two spellings equal modulo case are `'same'` without a read. After the
 * region check the record's resource must read back as a Neptune one (else
 * `'unknown'`); the journaled one is `'same'` when it reads back under the
 * record's `DbClusterResourceId` / `DbiResourceId` (immutable, unique,
 * unchanged by a rename), `'different'` under another, and `'different'`
 * when AWS reports its identifier gone: the record's resource answers to
 * its own, other, identifier, so the gone one cannot name it. A read
 * answering with another engine's resource throws (`'unknown'` to the
 * caller): the identifier is no longer a Neptune one.
 */
export async function isSameResource(
  this: NeptuneProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::Neptune::DBCluster' && resourceType !== 'AWS::Neptune::DBInstance') {
    return 'unknown';
  }
  if (!isDbIdentifier(journaledPhysicalId) || !isDbIdentifier(record.physicalId)) {
    return 'unknown';
  }
  if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'same';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordResourceId = await this.readDbResourceIdIfExists(resourceType, record.physicalId);
  if (recordResourceId === undefined) return 'unknown';
  const journaledResourceId = await this.readDbResourceIdIfExists(
    resourceType,
    journaledPhysicalId
  );
  if (journaledResourceId === undefined) return 'different';
  return journaledResourceId === recordResourceId ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4606: the cluster's `DbClusterResourceId` or the instance's
 * `DbiResourceId`, which AWS generates, never changes (a rename keeps it)
 * and never gives a later resource. A cluster or instance re-created under
 * the identifier, in any case spelling and by any of the engines sharing
 * the namespace, answers with another id (or, for another engine, throws),
 * so the settle keeps it rather than deleting it as the failed CREATE's
 * orphan. A failed CREATE's own token comes from its create response, on
 * the failure's mark (`markCreatedBeforeFailure`); this is the live read.
 *
 * `undefined` for another type, an id that is not a DB identifier, or a
 * client in another region than `expectedRegion`. `RESOURCE_NOT_FOUND`
 * only on the describe's not-found fault NAME (or an empty list); any
 * other failure throws.
 */
export async function resourceIdentity(
  this: NeptuneProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::Neptune::DBCluster' && resourceType !== 'AWS::Neptune::DBInstance') {
    return undefined;
  }
  if (!isDbIdentifier(physicalId)) return undefined;
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const live = await this.readDbResourceIdIfExists(resourceType, physicalId);
  return live === undefined ? RESOURCE_NOT_FOUND : live;
}

/**
 * The Neptune cluster's `DbClusterResourceId` (or the instance's
 * `DbiResourceId`), or `undefined` when AWS reports the identifier gone
 * (its not-found fault NAME, or an empty describe list). Any other
 * failure, a response naming another identifier, one whose engine is not
 * `neptune` (the describe also answers for RDS and DocumentDB resources)
 * and one naming no resource id throw: "could not read" never reads as
 * "gone".
 */
export async function readDbResourceIdIfExists(
  this: NeptuneProvider,
  resourceType: 'AWS::Neptune::DBCluster' | 'AWS::Neptune::DBInstance',
  identifier: string
): Promise<string | undefined> {
  const isCluster = resourceType === 'AWS::Neptune::DBCluster';
  let found:
    | {
        identifier: string | undefined;
        engine: string | undefined;
        resourceId: string | undefined;
      }
    | undefined;
  try {
    if (isCluster) {
      const cluster = await this.describeDBCluster(identifier);
      found = cluster && {
        identifier: cluster.DBClusterIdentifier,
        engine: cluster.Engine,
        resourceId: cluster.DbClusterResourceId,
      };
    } else {
      const instance = await this.describeDBInstance(identifier);
      found = instance && {
        identifier: instance.DBInstanceIdentifier,
        engine: instance.Engine,
        resourceId: instance.DbiResourceId,
      };
    }
  } catch (error) {
    const notFound = isCluster ? 'DBClusterNotFoundFault' : 'DBInstanceNotFoundFault';
    if ((error as { name?: unknown } | null)?.name === notFound) return undefined;
    throw error;
  }
  if (found === undefined) return undefined;
  const api = isCluster ? 'DescribeDBClusters' : 'DescribeDBInstances';
  if (found.identifier?.toLowerCase() !== identifier.toLowerCase()) {
    throw new Error(`${api} answered for another identifier`);
  }
  if (found.engine !== 'neptune') {
    throw new Error(`${api} answered for a resource of another engine`);
  }
  if (typeof found.resourceId !== 'string' || found.resourceId === '') {
    throw new Error(`${api} returned no resource id`);
  }
  return found.resourceId;
}
