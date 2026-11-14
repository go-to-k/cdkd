import type { S3TablesProvider } from '../s3-tables-provider.js';
import { S3TablesClient, NotFoundException, GetTableCommand } from '@aws-sdk/client-s3tables';
import { definedAttributes } from '../../attribute-map.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { markRedactedCause, relayedNameCollision } from '../../../deployment/retryable-errors.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  CreateContext,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  desiredObject,
  recordedObject,
  refuseNonIntegers,
  UPDATABLE_CONFIG_KEYS,
  metricsEnabled,
  INTEGER_BEARING_CONFIGS,
  refuseMalformedLogging,
  parseTableCompositeId,
} from './shared.js';

/**
 * The failure wrap every catch that throws a `ProvisioningError` builds.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug`, and the wrap is
 * stamped `markRedactedCause`, so the retry classifiers read the withheld
 * text on the `cause` chain. That debug line goes through the operation's
 * `maskSecrets` (`mask`), since AWS can echo a resolved value back. An
 * "already exists" is restated ({@link relayedNameCollision}). A cdkd-authored or
 * transport error, or a non-`Error` throw, keeps its text, as in the
 * EventBridge bus provider's wrap (go-to-k/cdkd#5053); the thrown message is
 * masked by the deploy engine. Every delete checks `NotFoundException`
 * by type before it wraps, and stamps a wrap naming another `NotFound` class
 * `markNotGone`, so no "already deleted" reading depends on AWS's
 * wording.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: S3TablesProvider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
  const m = mask ?? ((text: string) => text);
  this.logger.debug(m(build(m(failure.detail)).message));
  return markRedactedCause(build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`));
}

export function getClient(this: S3TablesProvider): S3TablesClient {
  if (!this.client) {
    this.client = new S3TablesClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
    this.createClient = withoutServerErrorRetries(
      new S3TablesClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.client;
}

/**
 * The client `CreateTableBucket` / `CreateNamespace` / `CreateTable` go through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
 * keeps the full SDK retry; built in {@link getClient}'s step, so both
 * capture the region and identity active at that ONE call.
 *
 * None of `CreateTableBucket`, `CreateNamespace` or `CreateTable` carries an
 * idempotency token, and each name is unique in its scope (account and
 * region, table bucket, namespace), so the SDK's own replay of a 5xx whose request had
 * succeeded collides with what the first send made, and that "already
 * exists" surfaced from the engine's FIRST attempt as a name somebody else
 * holds. Refused here, the 5xx reaches the deploy engine's retry, which
 * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
 * adopted on that collision: a name is not attribution
 * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
 */
export function getCreateClient(this: S3TablesProvider): S3TablesClient {
  this.getClient();
  return this.createClient as S3TablesClient;
}

// ─── Dispatch ─────────────────────────────────────────────────────

export async function create(
  this: S3TablesProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  switch (resourceType) {
    case 'AWS::S3Tables::TableBucket':
      return this.createTableBucket(logicalId, resourceType, properties, context);
    case 'AWS::S3Tables::Namespace':
      return this.createNamespace(logicalId, resourceType, properties, context);
    case 'AWS::S3Tables::Table':
      return this.createTable(logicalId, resourceType, properties, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

export async function update(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#2613: a table or table bucket is addressed by an ARN read
  // from the state record, and every call goes through the one S3 Tables
  // client, so a client in another region than the record would send the
  // lookup and the tag writes to a region this record was not written
  // through. Refused for all three types, Namespace included although its
  // update sends nothing, so a stack whose client region disagrees with its
  // state stops at its first update rather than partway through. Outside the
  // try: a refusal is not an AWS failure to re-label. The client's region is
  // resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  // go-to-k/cdkd#3994: a malformed desired Tags on a taggable type is
  // refused before any call (read as empty, it would untag every recorded
  // key). Namespaces are not taggable.
  if (resourceType === 'AWS::S3Tables::Table' || resourceType === 'AWS::S3Tables::TableBucket') {
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  }
  // go-to-k/cdkd#2762: likewise a non-object configuration property.
  for (const key of UPDATABLE_CONFIG_KEYS[resourceType] ?? []) {
    desiredObject(properties, key, resourceType, logicalId, physicalId);
  }
  // ...and a non-integer member of one, converted here once before any write.
  for (const [key, convert] of INTEGER_BEARING_CONFIGS[resourceType] ?? []) {
    const value = desiredObject(properties, key, resourceType, logicalId, physicalId);
    if (value !== undefined) {
      refuseNonIntegers(() => convert(value), key, resourceType, logicalId, physicalId);
    }
  }
  if (resourceType === 'AWS::S3Tables::TableBucket') {
    metricsEnabled(
      recordedObject(properties, 'MetricsConfiguration'),
      resourceType,
      logicalId,
      physicalId
    );
    // go-to-k/cdkd#6167: logging is the last write, so a malformed member is
    // refused here, before the earlier configuration writes land.
    const logging = recordedObject(properties, 'LoggingConfiguration');
    if (logging !== undefined) {
      refuseMalformedLogging(logging, resourceType, logicalId, physicalId);
    }
  }
  try {
    return await this.applyUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context?.maskSecrets,
      context?.recordedAttributes,
      (key) => context?.markUnsettled?.(key)
    );
  } catch (error) {
    // Pass through every cdkd-typed error untouched. For THIS provider the
    // live case is an inner ProvisioningError (the tag-diff helpers and
    // lookupTableArn raise their own, with precise messages this outer wrap
    // would replace); the guard is written against the CdkdError base so it
    // also covers a control-flow error if one is ever added here.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update S3 Tables resource ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Re-read a Table's attributes after an update (issue #6238): `VersionToken`
 * names the table's CURRENT metadata version, so the one recorded at create
 * goes stale. The map is `createTable`'s whole set (an `attributes` result
 * REPLACES the record's), and a failed read or one without `tableARN` returns
 * the result without one, so the recorded attributes carry forward instead.
 */
async function withTableAttributes(
  provider: S3TablesProvider,
  logicalId: string,
  result: ResourceUpdateResult
): Promise<ResourceUpdateResult> {
  const parts = parseTableCompositeId(result.physicalId);
  if (parts === undefined) return result;
  try {
    const read = await provider.getClient().send(new GetTableCommand(parts));
    if (!read.tableARN) return result;
    return {
      ...result,
      attributes: definedAttributes({
        TableARN: read.tableARN,
        WarehouseLocation: read.warehouseLocation,
        VersionToken: read.versionToken,
      }),
    };
  } catch (readError) {
    provider.logger.debug(
      `Could not re-read the attributes of ${logicalId} after update: ${describeAwsFailure(readError).detail}`
    );
    return result;
  }
}

export async function applyUpdate(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  recordedAttributes: Readonly<Record<string, unknown>> | undefined,
  markUnsettled: (key: string) => void
): Promise<ResourceUpdateResult> {
  // There is no UpdateTable / UpdateTableBucket / UpdateNamespace API.
  // TAGS are mutable via TagResource / UntagResource (Table #609 PR #739,
  // TableBucket #609), a Table's `TableName` / `Namespace` via
  // RenameTable (go-to-k/cdkd#5313), and the configuration properties by
  // their own Put* / Delete* calls (go-to-k/cdkd#2762). The Namespace case stays a no-op:
  // Namespaces are not taggable (ListTagsForResource only accepts
  // table-bucket or table ARNs) and both their properties are create-only.
  if (resourceType === 'AWS::S3Tables::Table') {
    // Planned (and refused) before any write, so a refusal changes nothing.
    const rename = await this.planTableRename(
      logicalId,
      physicalId,
      resourceType,
      properties,
      mask
    );
    // Tags against the CURRENT identity, the rename LAST: a failure before
    // the rename leaves the record naming the table AWS still has, and the
    // next deploy re-sends both (each is idempotent).
    await this.applyTableTagsDiff(
      logicalId,
      physicalId,
      resourceType,
      previousProperties['Tags'],
      properties['Tags'],
      mask
    );
    // Maintenance against the current identity too, before the rename.
    await this.applyTableMaintenanceUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      markUnsettled
    );
    if (rename === undefined) {
      return withTableAttributes(this, logicalId, { physicalId, wasReplaced: false });
    }
    try {
      await this.getClient().send(rename.command);
    } catch (error) {
      if (
        !(error instanceof NotFoundException) ||
        !(await this.renameAlreadyApplied(rename.target, recordedAttributes))
      ) {
        throw error;
      }
    }
    this.logger.debug(
      safeMsg`Renamed S3 Tables Table ${logicalId}: ${physicalId} -> ${rename.physicalId}`
    );
    // In place: the table ARN ends in a table id that a rename keeps, so the
    // recorded `TableARN` attribute carries forward (measured against
    // CloudFormation 2026-10-26: TableName and Namespace changes are both
    // `Replacement: False`, and `Fn::GetAtt TableARN` is unchanged).
    return withTableAttributes(this, logicalId, {
      physicalId: rename.physicalId,
      wasReplaced: false,
    });
  } else if (resourceType === 'AWS::S3Tables::TableBucket') {
    // TableBucket's physicalId IS the bucket ARN, so the tag-diff path
    // can use it directly (no GetTableBucket lookup hop needed — unlike
    // Table where the compound physicalId requires GetTable to recover
    // the real ARN).
    await this.applyTableBucketTagsDiff(
      logicalId,
      physicalId,
      resourceType,
      previousProperties['Tags'],
      properties['Tags'],
      mask
    );
    await this.applyTableBucketConfigUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      markUnsettled
    );
  } else {
    this.logger.debug(`Update is no-op for ${resourceType} ${logicalId}`);
  }
  return { physicalId, wasReplaced: false };
}

export async function deleteImpl(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  // go-to-k/cdkd#2613: a table bucket delete first EMPTIES the bucket
  // (deleting every namespace and table in it), so a client in another
  // region than the state record would empty and delete there. Refuse before
  // any call, for all three types, not only on NotFound; the client's region
  // is resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );
  switch (resourceType) {
    case 'AWS::S3Tables::TableBucket':
      return this.deleteTableBucket(logicalId, physicalId, resourceType, context);
    case 'AWS::S3Tables::Namespace':
      return this.deleteNamespace(logicalId, physicalId, resourceType, context);
    case 'AWS::S3Tables::Table':
      return this.deleteTable(logicalId, physicalId, resourceType, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}
