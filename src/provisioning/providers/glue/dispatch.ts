import { GlueClient } from '@aws-sdk/client-glue';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  type CreateContext,
  type ResourceCreateResult,
  type ResourceDeleteResult,
  type ResourceUpdateResult,
  type ResourceImportInput,
  type ResourceImportResult,
  type UpdateContext,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import type { GlueProvider } from '../glue-provider.js';
import { wrapGlueError, newGlueClients, withRecordedCatalogId } from './names.js';
import { catalogIdForApi, notFoundInCatalog } from './ids-catalog.js';
import { asRecord } from './shared.js';

/**
 * A failure wrap quoting the caught error's text through the operation's
 * masker (issue #2177), stamped when the mask changed it so the retry
 * classifiers read the unmasked `cause` chain (`wrapMaskedAwsError`, issue
 * #4244), and naming an AWS-authored failure by its class only
 * ({@link wrapGlueError}, go-to-k/cdkd#2319). Each Glue class carries this member rather than calling the module
 * function, so `gen-update-wrap-coverage` sees the catch that throws it as a
 * wrap.
 */
export function glueWrapMaskedError(
  this: GlueProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  return wrapGlueError(mask, (message) => this.logger.debug(message), error, build);
}

export function glueGetClient(this: GlueProvider): GlueClient {
  if (!this.client) {
    ({ client: this.client, createClient: this.createClient } = newGlueClients(
      this.providerRegion
    ));
  }
  return this.client;
}

/** The main create's client (issue #4639); see {@link newGlueClients}. */
export function glueGetCreateClient(this: GlueProvider): GlueClient {
  this.getClient();
  return this.createClient as GlueClient;
}

// ─── Dispatch ─────────────────────────────────────────────────────

export async function glueCreate(
  this: GlueProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  switch (resourceType) {
    case 'AWS::Glue::Database':
      return this.createDatabase(logicalId, resourceType, properties, context);
    case 'AWS::Glue::Table':
      return this.createTable(logicalId, resourceType, properties, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

/**
 * `context` is read for the ORIGIN of the desired bag
 * (`replayingState` / `desiredFromAwsReadback`), which decides whether a
 * malformed `DatabaseInput` block refuses (a template-path update) or warns
 * (a rollback revert or `cdkd drift --revert`) — issue #3740 — and for its
 * masker (issue #2177).
 */
export async function glueUpdate(
  this: GlueProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  switch (resourceType) {
    case 'AWS::Glue::Database':
      return this.updateDatabase(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::Glue::Table':
      return this.updateTable(
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

export async function glueDelete(
  this: GlueProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would delete a same-named
  // database or table cdkd does not manage. Refuse before any call, not only
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
  switch (resourceType) {
    case 'AWS::Glue::Database':
      return this.deleteDatabase(logicalId, physicalId, resourceType, properties, context);
    case 'AWS::Glue::Table':
      return this.deleteTable(logicalId, physicalId, resourceType, properties, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

/**
 * Adopt an existing Glue Database or Table into cdkd state.
 *
 * Lookup (per type): explicit override / template name → verify with
 * `GetDatabase` or `GetTable`. There is no `aws:cdk:path` tag walk — AWS
 * rejects `aws:`-prefixed tag writes, so that tag never exists on a real
 * resource (issue #1134); auto-mode import resolves ids from
 * CloudFormation's `DescribeStackResources` instead.
 */
/**
 * Read the AWS-current Glue resource configuration in CFn-property shape.
 *
 * Dispatch per resource type:
 *  - `Database` → `GetDatabase` returning DatabaseInput-shape
 *    (`Name`, `Description`, `LocationUri`, `Parameters`).
 *  - `Table` → `GetTable` returning the same-named TableInput-shape
 *    fields (`Name`, `Description`, `Owner`, `Retention`, `TableType`,
 *    `PartitionKeys`, `Parameters`, `StorageDescriptor`, `ViewOriginalText`,
 *    `ViewExpandedText`, `TargetTable`). The table physicalId is
 *    `databaseName|tableName`; we recover both from the split.
 *
 * `CatalogId` is not READ — `GetDatabase` / `GetTable` do not echo it —
 * but the recorded usable value is carried back
 * ({@link withRecordedCatalogId}), so a `drift --revert` built from this
 * snapshot addresses the catalog it was read from.
 *
 * Returns `RESOURCE_NOT_FOUND` when the resource is gone
 * (`EntityNotFoundException`), unless the read fell back from an unusable
 * recorded `CatalogId` ({@link notFoundInCatalog}).
 * Other Glue resource types (`Job`, `Crawler`, `Connection`, `Trigger`,
 * `Workflow`, `SecurityConfiguration`, etc.) are out of scope for v1 —
 * the provider's `create()` only handles Database/Table; CC API picks
 * up drift detection for the rest.
 */
export async function glueReadCurrentState(
  this: GlueProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // `CatalogId` is threaded through the same way the pre-update readers do
  // it (issue #1461). On a cross-account / non-default Data Catalog, a
  // `GetTable` without it reads the ACCOUNT-DEFAULT catalog — so drift
  // compares against the wrong table, or reports the resource gone.
  //
  // Read through the shared guard rather than a bare cast (issue #1675): the
  // bag here is the STATE record, so for an imported stack it holds the raw
  // template value — an unresolved intrinsic OBJECT (which the cast would
  // hand to `GetTable` as if it were an id) or a YAML-numeric account id.
  const catalogId = catalogIdForApi(properties?.['CatalogId']);
  let snapshot: Record<string, unknown> | ResourceNotFound | undefined;
  switch (resourceType) {
    case 'AWS::Glue::Database':
      snapshot = await this.readDatabase(physicalId, catalogId);
      break;
    case 'AWS::Glue::Table':
      snapshot = await this.readTable(physicalId, catalogId, properties);
      break;
    default:
      return undefined;
  }
  if (snapshot === RESOURCE_NOT_FOUND) return notFoundInCatalog(properties);
  return snapshot && withRecordedCatalogId(snapshot, properties);
}

/**
 * `OpenTableFormatInput` is a create-time directive (`IcebergInput.MetadataOperation`
 * can only be `CREATE`). `GetTable` does NOT echo it back as an
 * `OpenTableFormatInput` field — an Iceberg table surfaces only via
 * `Table.Parameters['table_type'] == 'ICEBERG'`, which is not the same
 * round-trippable shape. There is therefore no clean emit-when-present
 * readback for it (and fabricating a placeholder would itself fire false
 * drift). Declaring it here keeps the drift comparator from false-positiving
 * on a state-recorded `OpenTableFormatInput` that the readback never surfaces.
 *
 * `AWS::Glue::Database` declares `DatabaseInput.CreateTableDefaultPermissions`
 * PER RESOURCE (the issue #1602 seam), and only for a database whose template
 * does NOT declare the block. AWS materializes a Lake Formation DEFAULT there
 * — `[{IAM_ALLOWED_PRINCIPALS, [ALL]}]` on a catalog that has not been
 * onboarded to Lake Formation (measured us-east-1, 2026-08-13) — so once
 * issue #1807 taught `readDatabase` to surface the block, comparing it would
 * report drift on EVERY existing database: the baseline is an
 * `observedProperties` capture written by a binary that did not read the key,
 * `drift.ts` walks the key UNION on that baseline (`unionWalkObjects`), and
 * `deploy-engine.ts` does not refresh a record that already has one — so the
 * phantom would persist until an unrelated UPDATE or a `drift --accept`.
 * This is the ELBv2 `Targets` shape one type over: a value a SIBLING owns is
 * ignored while the template declares none, and an explicit declaration —
 * including an empty list — IS a declaration and stays compared.
 *
 * `TargetDatabase` / `FederatedDatabase` need no such scoping: AWS reports
 * them only when they were actually set, so an appearance is real drift.
 */
export function glueGetDriftUnknownPaths(
  this: GlueProvider,
  resourceType: string,
  properties?: Record<string, unknown>
): string[] {
  if (resourceType === 'AWS::Glue::Table') {
    return ['OpenTableFormatInput'];
  }
  if (resourceType === 'AWS::Glue::Database') {
    // The usual default is to COMPARE when the bag is absent or unreadable —
    // hiding real drift is the worse failure. This one key inverts it, and
    // the reason is specific rather than a preference: AWS ALWAYS materializes
    // a Lake Formation default here, so a record cdkd cannot read the
    // declaration out of (an older import carrying only the top-level
    // `DatabaseName`) would report drift on EVERY run with no way to clear it.
    // The path is compared exactly when the template DECLARES the block.
    const declared = asRecord(properties?.['DatabaseInput']);
    if (declared?.['CreateTableDefaultPermissions'] === undefined) {
      return ['DatabaseInput.CreateTableDefaultPermissions'];
    }
  }
  return [];
}

export async function glueImport(
  this: GlueProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::Glue::Database':
      return this.importDatabase(input);
    case 'AWS::Glue::Table':
      return this.importTable(input);
    default:
      return null;
  }
}
