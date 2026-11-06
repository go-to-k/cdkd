import {
  GlueClient,
  CreateConnectionCommand,
  UpdateConnectionCommand,
  DeleteConnectionCommand,
  GetConnectionCommand,
  EntityNotFoundException,
  type ConnectionInput,
} from '@aws-sdk/client-glue';
import { STSClient } from '@aws-sdk/client-sts';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { createMaskedLogSinks, type MaskerFn } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { markNotGone } from '../../not-gone.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import { generatedNameFor } from '../../resource-name.js';
import type { GlueConnectionProvider } from '../glue-provider.js';
import {
  wrapGlueError,
  newGlueClients,
  glueOperationSinks,
  secretNamePairs,
  previousNamePairs,
  refuseNestedRename,
  refuseCatalogMove,
  updateCatalogId,
  withRecordedCatalogId,
} from './names.js';
import {
  buildGlueResourceArn,
  asRecord,
  desiredGlueTags,
  applyGlueTagDiff,
  pickDefined,
  fetchGlueTags,
} from './shared.js';
import {
  catalogIdForApi,
  deleteCatalogId,
  describeCatalog,
  logCatalogScopedDeleteSkip,
  notFoundInCatalog,
} from './ids-catalog.js';

/** {@link GlueProvider}'s `wrapMaskedError` (issue #4244). */
export function connectionWrapMaskedError(
  this: GlueConnectionProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  return wrapGlueError(mask, (message) => this.logger.debug(message), error, build);
}

export function connectionGetStsClient(this: GlueConnectionProvider): STSClient {
  if (!this.stsClient) {
    this.stsClient = new STSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.stsClient;
}

/**
 * The connection ARN `TagResource` / `UntagResource` / `GetTags` address. A
 * connection lives in a Data Catalog, and the ARN's account is the catalog's
 * owner, so a usable `CatalogId` names it; otherwise the caller's account
 * (the catalog `CatalogId` omitted means) is resolved through STS.
 */
export function connectionResourceArn(
  this: GlueConnectionProvider,
  name: string,
  catalogIdValue: unknown
): Promise<string> {
  return buildGlueResourceArn(
    this.getClient(),
    this.getStsClient(),
    'connection',
    name,
    catalogIdForApi(catalogIdValue)
  );
}

export function connectionGetClient(this: GlueConnectionProvider): GlueClient {
  if (!this.client) {
    ({ client: this.client, createClient: this.createClient } = newGlueClients(
      this.providerRegion
    ));
  }
  return this.client;
}

/** The main create's client (issue #4639); see {@link newGlueClients}. */
export function connectionGetCreateClient(this: GlueConnectionProvider): GlueClient {
  this.getClient();
  return this.createClient as GlueClient;
}

export async function connectionCreate(
  this: GlueConnectionProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation, every bag value masked RAW.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    secretNamePairs([asRecord(properties['ConnectionInput'])?.['Name'], properties['CatalogId']])
  );
  const { value: v } = log;
  log.debug(`Creating Glue Connection ${logicalId}`);
  const connectionInput = properties['ConnectionInput'] as Record<string, unknown> | undefined;
  if (!connectionInput) {
    throw new ProvisioningError(
      `ConnectionInput is required for Glue Connection ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  // go-to-k/cdkd#4073: a malformed Tags is refused before any call.
  const tags = desiredGlueTags(properties['Tags'], resourceType, logicalId);
  // go-to-k/cdkd#5095, as the Glue job's create.
  const name =
    (connectionInput['Name'] as string | undefined) ??
    generatedNameFor('AWS::Glue::Connection', logicalId);
  const catalogId = properties['CatalogId'] as string | undefined;
  try {
    await this.getCreateClient().send(
      new CreateConnectionCommand({
        ...(catalogId && { CatalogId: catalogId }),
        ConnectionInput: buildConnectionInput(connectionInput, name),
        ...(tags && { Tags: tags }),
      })
    );
    log.debug(`Successfully created Glue Connection ${logicalId}: ${v(name)}`);
    return { physicalId: name, attributes: {} };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue Connection ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function connectionUpdate(
  this: GlueConnectionProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177 -- the recorded name is a needle too after a rotated secret.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    previousNamePairs(physicalId, [asRecord(previousProperties?.['ConnectionInput'])?.['Name']])
  );
  const { value: v } = log;
  log.debug(`Updating Glue Connection ${logicalId}: ${v(physicalId)}`);
  const connectionInput = properties['ConnectionInput'] as Record<string, unknown> | undefined;
  if (!connectionInput) {
    throw new ProvisioningError(
      `ConnectionInput is required for Glue Connection update ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  // Exact comparison: Glue documents no case folding for connection names.
  refuseNestedRename({
    resourceType,
    logicalId,
    field: 'ConnectionInput.Name',
    noun: 'connection',
    recordedName: physicalId,
    desiredName: connectionInput['Name'],
    foldCase: false,
    consequence: () =>
      `UpdateConnection would address '${v(physicalId)}' with a different name inside its ` +
      `definition, and the state record would keep '${v(physicalId)}' whatever AWS did with it`,
    stateful: false,
    mask: log.mask,
  });
  await refuseCatalogMove({
    resourceType,
    logicalId,
    noun: 'connection',
    entityName: physicalId,
    recorded: previousProperties?.['CatalogId'],
    desired: properties['CatalogId'],
    stateful: false,
    callerAccountId: this.callerAccountId,
    warn: log.warn,
    debug: log.debug,
    mask: log.mask,
  });
  // go-to-k/cdkd#4073: a malformed desired Tags is refused before any call,
  // so a half-applied update never untags on the strength of it.
  desiredGlueTags(properties['Tags'], resourceType, logicalId, physicalId);
  const catalogId = updateCatalogId(properties['CatalogId']);
  try {
    await this.getClient().send(
      new UpdateConnectionCommand({
        // `!== undefined`, not truthiness: a falsy unusable value (NaN, '')
        // must reach AWS and be rejected, not silently drop to the default
        // catalog (issue #3756).
        ...(catalogId !== undefined && { CatalogId: catalogId }),
        Name: physicalId,
        ConnectionInput: buildConnectionInput(connectionInput, physicalId),
      })
    );
    // `UpdateConnection` carries no tags (go-to-k/cdkd#2762).
    await applyGlueTagDiff(
      this.getClient(),
      () => this.resourceArn(physicalId, properties['CatalogId']),
      previousProperties?.['Tags'],
      properties['Tags'],
      resourceType,
      logicalId,
      log.warn
    );
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Glue Connection ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function connectionDelete(
  this: GlueConnectionProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#2007: the name can be secret-derived.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  log.debug(`Deleting Glue Connection ${logicalId}: ${log.value(physicalId)}`);
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would delete a same-named
  // connection cdkd does not manage. Refuse before any call, not only
  // on NotFound; the client's region is resolved only when there is one
  // to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );
  // Same catalog-scoping rule as the Table / Database deletes — see
  // {@link deleteCatalogId} (issue #1675). This call already forwarded
  // `CatalogId`, but through a bare cast that would have sent an unresolved
  // intrinsic OBJECT to the API.
  // go-to-k/cdkd#3952: a redacted CatalogId names no catalog, and the
  // NotFound arm below reads a miss as "already deleted".
  const redactedSkip = redactedDeleteAddressSkip(
    this.logger,
    logicalId,
    resourceType,
    redactedDeleteAddressFields({ CatalogId: properties?.['CatalogId'] })
  );
  if (redactedSkip) return redactedSkip;
  const target = deleteCatalogId(properties);
  if (target.declaredButUnusable) {
    this.logger.debug(
      `Glue Connection ${logicalId}: CatalogId is not a usable value (likely an unresolved ` +
        `intrinsic), so DeleteConnection targets ${describeCatalog(target.catalogId)}.`
    );
  }
  try {
    await this.getClient().send(
      new DeleteConnectionCommand({
        ConnectionName: physicalId,
        ...(target.catalogId !== undefined && { CatalogId: target.catalogId }),
      })
    );
  } catch (error) {
    if (error instanceof EntityNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      logCatalogScopedDeleteSkip(log, target, 'Connection', logicalId, log.value(physicalId));
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue Connection ${logicalId}: ${text}`,
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

// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function connectionGetAttribute(
  this: GlueConnectionProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
    return physicalId;
  }
  return undefined;
}

export async function connectionReadCurrentState(
  this: GlueConnectionProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // Shared guard, not a bare cast — same reasoning as the Database / Table
  // `readCurrentState` above (issue #1675).
  const catalogId = catalogIdForApi(properties?.['CatalogId']);
  let conn;
  try {
    const resp = await this.getClient().send(
      new GetConnectionCommand({
        Name: physicalId,
        ...(catalogId !== undefined && { CatalogId: catalogId }),
      })
    );
    conn = resp.Connection;
  } catch (err) {
    if (err instanceof EntityNotFoundException) return notFoundInCatalog(properties);
    throw err;
  }
  if (!conn) return undefined;

  const ci: Record<string, unknown> = {
    Name: conn.Name ?? physicalId,
    ConnectionType: conn.ConnectionType ?? '',
    Description: conn.Description ?? '',
    MatchCriteria: conn.MatchCriteria ?? [],
    ConnectionProperties: conn.ConnectionProperties ?? {},
    SparkProperties: conn.SparkProperties ?? {},
    AthenaProperties: conn.AthenaProperties ?? {},
    PythonProperties: conn.PythonProperties ?? {},
    PhysicalConnectionRequirements: conn.PhysicalConnectionRequirements
      ? pickDefined(conn.PhysicalConnectionRequirements as Record<string, unknown>)
      : {},
  };
  const name = conn.Name ?? physicalId;
  return withRecordedCatalogId(
    {
      ConnectionInput: ci,
      Tags: await fetchGlueTags(
        this.getClient(),
        this.getStsClient(),
        'connection',
        name,
        catalogId,
        this.logger
      ),
    },
    properties
  );
}

export async function connectionImport(
  this: GlueConnectionProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicitName =
    input.knownPhysicalId ??
    ((input.properties['ConnectionInput'] as Record<string, unknown> | undefined)?.['Name'] as
      | string
      | undefined);
  if (!explicitName) return null;
  // `import()` runs against the RAW template, so this is exactly the shape
  // `importableString` exists for — the Table / Database import paths have
  // used it since #1651 and this one was the straggler (issue #1675).
  const catalogId = catalogIdForApi(input.properties['CatalogId']);
  try {
    await this.getClient().send(
      new GetConnectionCommand({
        Name: explicitName,
        ...(catalogId !== undefined && { CatalogId: catalogId }),
      })
    );
    return { physicalId: explicitName, attributes: {} };
  } catch (err) {
    if (err instanceof EntityNotFoundException) return null;
    throw err;
  }
}

// ─── helpers shared by GlueConnectionProvider ───────────────────────────

function buildConnectionInput(ci: Record<string, unknown>, fallbackName: string): ConnectionInput {
  const result: ConnectionInput = {
    Name: (ci['Name'] as string | undefined) ?? fallbackName,
    ConnectionType: ci['ConnectionType'] as ConnectionInput['ConnectionType'],
    ConnectionProperties:
      (ci['ConnectionProperties'] as ConnectionInput['ConnectionProperties'] | undefined) ?? {},
  };
  if (ci['Description'] !== undefined) result.Description = ci['Description'] as string;
  if (ci['MatchCriteria'] !== undefined) result.MatchCriteria = ci['MatchCriteria'] as string[];
  if (ci['SparkProperties'] !== undefined) {
    result.SparkProperties = ci['SparkProperties'] as Record<string, string>;
  }
  if (ci['AthenaProperties'] !== undefined) {
    result.AthenaProperties = ci['AthenaProperties'] as Record<string, string>;
  }
  if (ci['PythonProperties'] !== undefined) {
    result.PythonProperties = ci['PythonProperties'] as Record<string, string>;
  }
  if (ci['PhysicalConnectionRequirements'] !== undefined) {
    result.PhysicalConnectionRequirements = ci[
      'PhysicalConnectionRequirements'
    ] as ConnectionInput['PhysicalConnectionRequirements'];
  }
  if (ci['AuthenticationConfiguration'] !== undefined) {
    result.AuthenticationConfiguration = ci[
      'AuthenticationConfiguration'
    ] as ConnectionInput['AuthenticationConfiguration'];
  }
  if (ci['ValidateCredentials'] !== undefined) {
    result.ValidateCredentials = ci['ValidateCredentials'] as boolean;
  }
  if (ci['ValidateForComputeEnvironments'] !== undefined) {
    result.ValidateForComputeEnvironments = ci[
      'ValidateForComputeEnvironments'
    ] as ConnectionInput['ValidateForComputeEnvironments'];
  }
  return result;
}
