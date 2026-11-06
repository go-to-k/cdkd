import type { DocDBProvider } from '../docdb-provider.js';
import { isDeepStrictEqual } from 'node:util';
import { DocDBClient } from '@aws-sdk/client-docdb';
import { markNotGone } from '../../not-gone.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import { type DeleteContext } from '../../region-check.js';
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
import { wrapDocDBFailure } from '../docdb-shared.js';
import { isDbIdentifier } from './shared.js';

export function getClient(this: DocDBProvider): DocDBClient {
  if (!this.docdbClient) {
    // Built together with the create client, so both capture the identity
    // active at this ONE call (issue #4639).
    this.docdbClient = new DocDBClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
    this.createClient = withoutServerErrorRetries(
      new DocDBClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.docdbClient;
}

/**
 * The client `CreateDBCluster` / `CreateDBInstance` go through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
 * keeps the full SDK retry.
 *
 * Neither carries an idempotency token, and each identifier is unique per
 * account and region, so the SDK's own replay of a 5xx whose request had
 * succeeded collides with what the first send made, and that "already
 * exists" surfaced from the engine's FIRST attempt as a name somebody else
 * holds. Refused here, the 5xx reaches the deploy engine's retry, which
 * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
 * adopted on that collision: a name is not attribution
 * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
 */
export function getCreateClient(this: DocDBProvider): DocDBClient {
  this.getClient();
  return this.createClient as DocDBClient;
}

// ─── Dispatch ─────────────────────────────────────────────────────
export async function create(
  this: DocDBProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = context?.maskSecrets;
  switch (resourceType) {
    case 'AWS::DocDB::DBCluster':
      return this.createDBCluster(
        logicalId,
        resourceType,
        properties,
        mask,
        context?.replayingState === true
      );
    case 'AWS::DocDB::DBInstance':
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
  this: DocDBProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  switch (resourceType) {
    case 'AWS::DocDB::DBCluster':
      return this.updateDBCluster(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::DocDB::DBInstance':
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
  this: DocDBProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  switch (resourceType) {
    case 'AWS::DocDB::DBCluster':
      return this.deleteDBCluster(logicalId, physicalId, resourceType, properties, context);
    case 'AWS::DocDB::DBInstance':
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

// ─── Failure wrap ─────────────────────────────────────────────────

/**
 * The failure wrap the create, update and delete catches throw
 * ({@link wrapDocDBFailure}, go-to-k/cdkd#2319). A method, so
 * `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
 */
export function wrapCaughtError(
  this: DocDBProvider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  return wrapDocDBFailure(this.logger, mask, error, build);
}

/**
 * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
 * by its CLASS, and the delete classifiers read `NotFound` in a message as
 * "already deleted": a class naming ANOTHER object's not-found (this
 * resource's own not-found returned before the wrap) is marked
 * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
 */
export function wrapDeleteError(
  this: DocDBProvider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const thrown = this.wrapCaughtError(mask, error, build);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** go-to-k/cdkd#5380: mark each of `keys` the update sends, just before the call. */
export function markChangedUnsettled(
  this: DocDBProvider,
  keys: readonly string[],
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): void {
  for (const key of keys) {
    if (properties[key] != null && !isDeepStrictEqual(properties[key], previousProperties[key])) {
      context?.markUnsettled?.(key);
    }
  }
}

/** A refusal before any call: nothing reached AWS, and only key names are printed. */
export function refuseBlock(
  this: DocDBProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string | undefined,
  text: string
): never {
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`${resourceType === 'AWS::DocDB::DBInstance' ? 'DocDB DBInstance' : 'DocDB DBCluster'} ${logicalId}: ${text}; nothing was changed.`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * A boolean property as what it means, `undefined` when absent. Sending or
 * skipping a call hangs on it, so a value that is no boolean is refused before
 * any call, except from a state-borne bag: left out, with a warning.
 */
export function readBooleanProperty(
  this: DocDBProvider,
  key: 'ManageMasterUserPassword' | 'EnablePerformanceInsights',
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  origin: { stateBorne: boolean; physicalId?: string }
): boolean | undefined {
  const value = properties[key];
  if (value == null) return undefined;
  const flag = coerceCfnBoolean(value);
  if (flag !== undefined) return flag;
  if (!origin.stateBorne) {
    this.refuseBlock(logicalId, resourceType, origin.physicalId, `${key} must be a boolean`);
  }
  this.logger.warn(
    safeMsg`${logicalId} (${resourceType}): the recorded ${key} is unusable, so it is not sent.`
  );
  return undefined;
}

/**
 * go-to-k/cdkd#2762: the password a call carries beside
 * `ManageMasterUserPassword`. AWS manages that password, so a call asking for
 * both is never sent: refused before any call rather than dropping a password
 * the template spelled, and from a state-borne bag the password is left out.
 * `removedFromManaged` is the same conflict with the flag gone from the
 * template and the record managed: sending `false` too would delete the AWS
 * secret on a path no A/B measured, so leaving takes an explicit `false`. An
 * unchanged password on an update is already `undefined` here. The value is
 * never printed.
 */
export function passwordBesideManaged(
  this: DocDBProvider,
  managed: boolean | undefined,
  removedFromManaged: boolean,
  password: string | undefined,
  resourceType: string,
  logicalId: string,
  origin: { stateBorne: boolean; physicalId?: string }
): string | undefined {
  if ((managed !== true && !removedFromManaged) || password == null) return password;
  if (!origin.stateBorne) {
    this.refuseBlock(
      logicalId,
      resourceType,
      origin.physicalId,
      removedFromManaged
        ? 'MasterUserPassword cannot change while AWS manages the password; declare ManageMasterUserPassword: false beside it to leave managed mode'
        : 'MasterUserPassword cannot be set while ManageMasterUserPassword is true, because AWS manages that password'
    );
  }
  this.logger.warn(
    removedFromManaged
      ? safeMsg`${logicalId} (${resourceType}): the recorded MasterUserPassword is not sent: the cluster stays managed, because the recorded ManageMasterUserPassword is absent.`
      : safeMsg`${logicalId} (${resourceType}): the recorded MasterUserPassword is not sent, because ManageMasterUserPassword is true.`
  );
  return undefined;
}

/**
 * go-to-k/cdkd#4606: whether the DocDB DB cluster or DB instance a failed
 * CREATE journaled is the one the record under the same logical id holds (a
 * fix-forward that created a new one there under another identifier).
 *
 * Reached on the SDK route only (`disableCcApiFallback`: these types have no
 * Cloud Control route). Both ids must be DB identifiers; anything else is
 * `'unknown'`. An identifier names at most one cluster (or instance) per
 * account and region at a time, in a namespace DocumentDB shares with RDS
 * and Neptune, and identifiers compare case-insensitively (stored
 * lower-cased), so two spellings equal modulo case are `'same'` without a
 * read. After the region check the record's resource must read back (else
 * `'unknown'`); the journaled one is `'same'` when it reads back under the
 * record's `DbClusterResourceId` / `DbiResourceId` (immutable, unique),
 * `'different'` under another, and `'different'` when AWS reports its
 * identifier gone: the record's resource answers to its own, other,
 * identifier. A read answering with another engine's resource (the shared
 * describe returns RDS and Neptune resources too) throws, which the caller
 * reads as `'unknown'`: this provider's delete would remove that resource.
 */
export async function isSameResource(
  this: DocDBProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::DocDB::DBCluster' && resourceType !== 'AWS::DocDB::DBInstance') {
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
 * `DbiResourceId`, which AWS generates, never changes and never gives a
 * later resource. A resource re-created under the identifier, by any engine
 * and in any case spelling, answers with another id (or, for another
 * engine, throws), so the settle keeps it rather than deleting it as the
 * failed CREATE's orphan. A failed CREATE's own token comes from its create
 * response, on the failure's mark (`markCreatedBeforeFailure`); this is the
 * live read.
 *
 * `undefined` for another type, an id that is not a DB identifier, or a
 * client in another region than `expectedRegion`. `RESOURCE_NOT_FOUND` only
 * on the describe's not-found fault NAME (or an empty list); any other
 * failure throws.
 */
export async function resourceIdentity(
  this: DocDBProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::DocDB::DBCluster' && resourceType !== 'AWS::DocDB::DBInstance') {
    return undefined;
  }
  if (!isDbIdentifier(physicalId)) return undefined;
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const live = await this.readDbResourceIdIfExists(resourceType, physicalId);
  return live === undefined ? RESOURCE_NOT_FOUND : live;
}

/**
 * The DocDB cluster's `DbClusterResourceId` (or the instance's
 * `DbiResourceId`), or `undefined` when AWS reports the identifier gone (its
 * not-found fault NAME, or an empty describe list). Any other failure, a
 * response naming another identifier, another engine than `docdb`, or no
 * resource id throws: "could not read" never reads as "gone", and an RDS or
 * Neptune resource under the identifier is never this provider's.
 */
export async function readDbResourceIdIfExists(
  this: DocDBProvider,
  resourceType: 'AWS::DocDB::DBCluster' | 'AWS::DocDB::DBInstance',
  identifier: string
): Promise<string | undefined> {
  const isCluster = resourceType === 'AWS::DocDB::DBCluster';
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
  if (found.engine !== 'docdb') {
    throw new Error(`${api} answered with a resource of another engine`);
  }
  if (typeof found.resourceId !== 'string' || found.resourceId === '') {
    throw new Error(`${api} returned no resource id`);
  }
  return found.resourceId;
}

export function sleep(this: DocDBProvider, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
