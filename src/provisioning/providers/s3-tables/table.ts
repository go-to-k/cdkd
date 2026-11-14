import type { S3TablesProvider } from '../s3-tables-provider.js';
import {
  CreateTableCommand,
  DeleteTableCommand,
  GetTableCommand,
  RenameTableCommand,
  PutTableMaintenanceConfigurationCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { markNotGone } from '../../not-gone.js';
import { definedAttributes } from '../../attribute-map.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { compositeIdFormatMessage, packCompositeId } from '../../composite-id.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  S3_TABLES_TABLE_ID_FORMAT,
  type TablePartsResolution,
  desiredObject,
  refuseNonIntegers,
  sdkStorageClass,
  sdkIcebergMetadata,
  type TableMaintenanceWrite,
  TABLE_MAINTENANCE,
} from './shared.js';

// ─── AWS::S3Tables::Table ─────────────────────────────────────────

export async function createTable(
  this: S3TablesProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating S3 Tables Table ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const tableBucketARN = properties['TableBucketARN'] as string | undefined;
  if (!tableBucketARN) {
    throw new ProvisioningError(
      `TableBucketARN is required for S3 Tables Table ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const namespace = properties['Namespace'] as string | undefined;
  if (!namespace) {
    throw new ProvisioningError(
      `Namespace is required for S3 Tables Table ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // CFn schema spells this property `TableName`; the AWS API call below
  // takes it as `name`. Accept both keys from the template and prefer the
  // CFn-canonical name.
  const name =
    (properties['TableName'] as string | undefined) ?? (properties['Name'] as string | undefined);
  if (!name) {
    throw new ProvisioningError(
      `TableName is required for S3 Tables Table ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // CFn schema spells this `OpenTableFormat`; the SDK API call uses
  // `format`. Accept the CFn-canonical name first, then the legacy
  // `Format` alias for state files written by older fixtures.
  const format =
    (properties['OpenTableFormat'] as string | undefined) ??
    (properties['Format'] as string | undefined);
  if (!format) {
    throw new ProvisioningError(
      `OpenTableFormat is required for S3 Tables Table ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // CFn `Tags: [{ Key, Value }]` → SDK `tags: Record<string, string>`.
  // CreateTableCommand accepts tags atomically (no separate TagResource
  // call needed); the SDK errors with InvalidRequestException on an empty
  // map, so omit the field entirely when no tags are set.
  const tags = this.tagListToSdkMap(desiredTags);

  // go-to-k/cdkd#2762: refused before any call, like Tags. `WithoutMetadata`
  // asks for a table with no schema: CreateTable without `metadata`.
  const icebergCfn = desiredObject(properties, 'IcebergMetadata', resourceType, logicalId);
  const iceberg =
    icebergCfn &&
    refuseNonIntegers(
      () => sdkIcebergMetadata(icebergCfn),
      'IcebergMetadata',
      resourceType,
      logicalId
    );
  const storageClass = desiredObject(
    properties,
    'StorageClassConfiguration',
    resourceType,
    logicalId
  );
  const maintenance: TableMaintenanceWrite[] = [];
  for (const [key, type, toSdk] of TABLE_MAINTENANCE) {
    const value = desiredObject(properties, key, resourceType, logicalId);
    if (value !== undefined) {
      maintenance.push({
        type,
        value: refuseNonIntegers(() => toSdk(value), key, resourceType, logicalId),
      });
    }
  }

  // Same guard, placement and replay downgrade as `createNamespace` above
  // (issue #1672): computed before the AWS call so a refusal cannot orphan a
  // table, and structurally unreachable because a table-bucket ARN carries
  // no `|` and S3 Tables constrains namespace / table names to lowercase
  // alphanumerics and underscores.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'tableBucketARN', value: tableBucketARN },
      { name: 'namespace', value: namespace },
      { name: 'name', value: name },
    ],
    {
      // Issue #2176: the refusal QUOTES the offending segment value, on the
      // thrown arm (durable) and the warn arm (terminal) alike, so the masker
      // goes through unconditionally -- it is absent on the paths that have no
      // context, where it degrades to identity.
      maskSecrets: context?.maskSecrets,
      ...(context?.replayingState === true && {
        onRefusal: (message: string) => this.logger.warn(message),
      }),
    }
  );

  // go-to-k/cdkd#4583: CreateTable returned, so the table exists under the
  // composite id delete() takes, whatever its response lacked.
  let tableCreated = false;
  try {
    const response = await this.getCreateClient().send(
      new CreateTableCommand({
        tableBucketARN,
        namespace,
        name,
        format: format as 'ICEBERG',
        ...(iceberg !== undefined && { metadata: { iceberg } }),
        ...(storageClass !== undefined && {
          storageClassConfiguration: sdkStorageClass(storageClass),
        }),
        ...(tags !== undefined && { tags }),
      })
    );
    tableCreated = true;
    reportCreatedResource(logicalId, resourceType, physicalId);

    // CreateTable has no maintenance member.
    for (const write of maintenance) {
      await this.getClient().send(
        new PutTableMaintenanceConfigurationCommand({ tableBucketARN, namespace, name, ...write })
      );
    }

    // Capture the REAL table ARN AWS returns — its actual format is
    // NOT inferrable from the compound parts (we tried; AWS rejected
    // `<bucketArn>/table/<ns>/<name>` with BadRequestException), so
    // we store it as an attribute so the resolver can return it for
    // `Fn::GetAtt: [Table, TableARN]` without a follow-up GetTable.
    // A missing tableARN in the response would mean the SDK / AWS
    // changed something underfoot — error LOUD rather than silently
    // propagating `''` to downstream consumers (which would receive
    // an empty ARN and surface cryptic AWS-side errors much later).
    if (!response.tableARN) {
      throw new ProvisioningError(
        `CreateTable did not return a tableARN for ${logicalId} (${physicalId}) — refusing to record an empty TableARN attribute`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const tableARN = response.tableARN;

    // `WarehouseLocation` is not in the CreateTable response, so one GetTable
    // reads it together with the current `VersionToken` (both CloudFormation
    // `Fn::GetAtt` attributes, issue #6238). The table exists by now, so a
    // failed read omits them rather than failing the create; the #1852 heal
    // fills them through `import()`.
    let warehouseLocation: string | undefined;
    let versionToken: string | undefined = response.versionToken;
    try {
      const read = await this.getClient().send(
        new GetTableCommand({ tableBucketARN, namespace, name })
      );
      warehouseLocation = read.warehouseLocation;
      versionToken = read.versionToken ?? versionToken;
    } catch (readError) {
      this.logger.debug(
        safeMsg`Could not read the warehouse location of ${logicalId} after create: ${describeAwsFailure(readError).detail}`
      );
    }

    this.logger.debug(`Successfully created S3 Tables Table ${logicalId}: ${physicalId}`);

    return {
      physicalId,
      attributes: definedAttributes({
        TableARN: tableARN,
        WarehouseLocation: warehouseLocation,
        VersionToken: versionToken,
      }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create S3 Tables Table ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (tableCreated) markCreatedBeforeFailure(thrown, logicalId, resourceType, physicalId);
    throw thrown;
  }
}

export async function deleteTable(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting S3 Tables Table ${logicalId}: ${physicalId}`);

  // Accepts cdkd's composite AND CloudFormation's bare TableARN — see
  // `resolveTableParts`. Rejecting the ARN here is what made a migrated
  // stack undestroyable (issue #1668).
  let resolved: TablePartsResolution;
  try {
    resolved = await this.resolveTableParts(physicalId);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to resolve S3 Tables Table ${logicalId} (${physicalId}): ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
  if (resolved === 'not-found') {
    // Already gone — delete is idempotent, same as the DeleteTable
    // NotFoundException arm below.
    const clientRegion = await this.getClient().config.region();
    assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
    this.logger.debug(`S3 Tables Table ${physicalId} does not exist, skipping deletion`);
    return;
  }
  if (resolved === 'unparseable') {
    throw new ProvisioningError(
      compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }

  const { tableBucketARN, namespace, name } = resolved;

  try {
    await this.getClient().send(
      new DeleteTableCommand({
        tableBucketARN,
        namespace,
        name,
      })
    );
    this.logger.debug(`Successfully deleted S3 Tables Table ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`S3 Tables Table ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete S3 Tables Table ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/**
 * The RenameTable a Table update owes, or `undefined` when the desired
 * `TableName` (or its `Name` alias) and `Namespace` match the table the
 * record names (go-to-k/cdkd#5313).
 *
 * Compared with the PHYSICAL ID, not the previous properties: the id names
 * the table AWS holds, and a record an older cdkd wrote after a silently
 * dropped rename carries the new name in its properties only. A key the
 * template omits keeps its current value.
 *
 * The new id keeps the stored shape: a composite gets the new namespace and
 * name; a bare table ARN (an imported row) stays as it is, since a rename
 * keeps the table's ARN.
 */
export async function planTableRename(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<
  | {
      command: RenameTableCommand;
      physicalId: string;
      target: { tableBucketARN: string; namespace: string; name: string };
    }
  | undefined
> {
  const desiredString = (key: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && value.length > 0) return value;
    throw new ProvisioningError(
      safeMsg`${key} for S3 Tables Table ${logicalId} must be a non-empty string; refusing the update`,
      resourceType,
      logicalId,
      physicalId
    );
  };
  const desiredNamespace = desiredString('Namespace', properties['Namespace']);
  const desiredName = desiredString('TableName', properties['TableName'] ?? properties['Name']);
  if (desiredNamespace === undefined && desiredName === undefined) return undefined;

  const current = await this.resolveTableParts(physicalId);
  if (current === 'not-found' || current === 'unparseable') {
    throw new ProvisioningError(
      current === 'not-found'
        ? safeMsg`S3 Tables Table '${physicalId}' no longer exists (state is out of sync); ` +
            `refusing to record a rename that did not happen`
        : compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }
  const newNamespace = desiredNamespace ?? current.namespace;
  const newName = desiredName ?? current.name;
  if (newNamespace === current.namespace && newName === current.name) return undefined;

  const newPhysicalId = physicalId.includes('|')
    ? packCompositeId(
        resourceType,
        logicalId,
        [
          { name: 'tableBucketARN', value: current.tableBucketARN },
          { name: 'namespace', value: newNamespace },
          { name: 'name', value: newName },
        ],
        { maskSecrets: mask }
      )
    : physicalId;
  return {
    physicalId: newPhysicalId,
    target: { tableBucketARN: current.tableBucketARN, namespace: newNamespace, name: newName },
    command: new RenameTableCommand({
      tableBucketARN: current.tableBucketARN,
      namespace: current.namespace,
      name: current.name,
      ...(newNamespace !== current.namespace && { newNamespaceName: newNamespace }),
      ...(newName !== current.name && { newName }),
    }),
  };
}

/**
 * Whether a RenameTable that answered `NotFoundException` had already been
 * applied: a replay of a rename whose first answer was lost (an SDK or
 * deploy-engine retry after a 5xx) finds the old name gone. Only on EXACT
 * attribution: the table now at the target name carries the `TableARN` the
 * record holds (its trailing table id is unique and a rename keeps it). A
 * record without one, or another table at the target name, is not this
 * table, and the NotFound is surfaced.
 */
export async function renameAlreadyApplied(
  this: S3TablesProvider,
  target: { tableBucketARN: string; namespace: string; name: string },
  recordedAttributes: Readonly<Record<string, unknown>> | undefined
): Promise<boolean> {
  const recordedArn = recordedAttributes?.['TableARN'];
  if (typeof recordedArn !== 'string' || recordedArn.length === 0) return false;
  // A failed lookup (AccessDenied, a throttle) attributes nothing; the
  // caller then rethrows the ORIGINAL NotFound, not this read's error.
  try {
    const liveArn = await this.lookupTableArn(target.tableBucketARN, target.namespace, target.name);
    return liveArn === recordedArn;
  } catch (lookupError) {
    this.logger.debug(
      safeMsg`Could not check whether the rename of ${target.name} was already applied: ${describeAwsFailure(lookupError).summary}`
    );
    return false;
  }
}

/**
 * Look up a table's real AWS ARN given its cdkd-compound physical
 * id parts. The real ARN is opaque (NOT `<bucketArn>/table/<ns>/<name>`
 * — that shape returns BadRequestException) and only AWS knows it,
 * so we call `GetTable` and pull `tableARN` from the response. Used
 * by the tag-diff path in update() and the readback's tag-fetch leg.
 * Returns null if the table is gone (NotFoundException → caller can
 * skip the tag op gracefully).
 */
export async function lookupTableArn(
  this: S3TablesProvider,
  tableBucketARN: string,
  namespace: string,
  name: string
): Promise<string | null> {
  try {
    const resp = await this.getClient().send(
      new GetTableCommand({ tableBucketARN, namespace, name })
    );
    return resp.tableARN ?? null;
  } catch (err) {
    if (err instanceof NotFoundException) return null;
    throw err;
  }
}
