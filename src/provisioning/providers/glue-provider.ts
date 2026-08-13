import {
  GlueClient,
  CreateDatabaseCommand,
  UpdateDatabaseCommand,
  DeleteDatabaseCommand,
  CreateTableCommand,
  UpdateTableCommand,
  DeleteTableCommand,
  GetDatabaseCommand,
  GetTableCommand,
  GetTagsCommand,
  CreateWorkflowCommand,
  UpdateWorkflowCommand,
  DeleteWorkflowCommand,
  GetWorkflowCommand,
  CreateSecurityConfigurationCommand,
  DeleteSecurityConfigurationCommand,
  GetSecurityConfigurationCommand,
  CreateJobCommand,
  UpdateJobCommand,
  DeleteJobCommand,
  GetJobCommand,
  CreateCrawlerCommand,
  UpdateCrawlerCommand,
  DeleteCrawlerCommand,
  GetCrawlerCommand,
  StartCrawlerScheduleCommand,
  StopCrawlerScheduleCommand,
  CreateConnectionCommand,
  UpdateConnectionCommand,
  DeleteConnectionCommand,
  GetConnectionCommand,
  CreateTriggerCommand,
  UpdateTriggerCommand,
  DeleteTriggerCommand,
  GetTriggerCommand,
  StartTriggerCommand,
  StopTriggerCommand,
  StopCrawlerCommand,
  EntityNotFoundException,
  CrawlerRunningException,
  ConcurrentModificationException,
  type DatabaseInput,
  type TableInput,
  type OpenTableFormatInput,
  type StorageDescriptor,
  type Column,
  type Order,
  type SerDeInfo,
  type SkewedInfo,
  type SchemaReference,
  type TableIdentifier,
  type ViewDefinitionInput,
  type EncryptionConfiguration,
  type S3Encryption,
  type CloudWatchEncryption,
  type JobBookmarksEncryption,
  type JobUpdate,
  type JobCommand as JobCommandShape,
  type ExecutionProperty,
  type NotificationProperty,
  type SourceControlDetails,
  type CrawlerTargets,
  type SchemaChangePolicy,
  type RecrawlPolicy,
  type LineageConfiguration,
  type LakeFormationConfiguration,
  type ConnectionInput,
  type TriggerUpdate,
  type Action as TriggerAction,
  type Predicate,
  type Condition as TriggerCondition,
  type EventBatchingCondition,
} from '@aws-sdk/client-glue';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  compositeIdFormatMessage,
  compositeIdSkipResult,
  packCompositeId,
  type CompositeIdFormat,
} from '../composite-id.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/** Shape of an `AWS::Glue::Table` physicalId, for every decode site (issue #1657). */
const GLUE_TABLE_ID_FORMAT: CompositeIdFormat = {
  label: 'Glue Table',
  segments: ['databaseName', 'tableName'],
};

/**
 * Read a template-borne value that is about to be forwarded to a Glue read
 * API as a string.
 *
 * `import()` runs against the RAW template, where `substituteOverrideRefs`
 * has resolved only the `Ref`s whose target is in the overrides map — a
 * pseudo parameter is never in that map, so `CatalogId: {Ref: AWS::AccountId}`
 * (what `@aws-cdk/aws-glue-alpha` renders for an environment-agnostic stack)
 * survives as an OBJECT. A bare `as string` cast then hands that object to
 * `GetTable` / `GetDatabase` as if it were an id. Dropping it instead matches
 * the API default (the caller's own account), which is what the intrinsic
 * would have resolved to anyway.
 */
function importableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The one pseudo parameter whose value IS the Glue API's `CatalogId` default. */
const ACCOUNT_ID_PSEUDO_PARAMETER = 'AWS::AccountId';
const ACCOUNT_ID_SUB_TEMPLATE = '${AWS::AccountId}';

/**
 * Is this unresolved intrinsic PROVABLY the caller's own account id?
 *
 * `@aws-cdk/aws-glue-alpha` sets `catalogId: Stack.of(this).account`, which
 * renders as `{Ref: AWS::AccountId}` (or an `Fn::Sub` wrapper) for an
 * environment-agnostic stack. A pseudo parameter is never in the import
 * overrides map, so a `cdkd import`-written state record holds the intrinsic
 * verbatim — but its resolved value is exactly what OMITTING `CatalogId` gives
 * the Glue API, so dropping it is not a loss and a NotFound afterwards is
 * ordinary idempotency, not the silent-leak shape.
 *
 * Kept deliberately narrow. An intrinsic object has exactly ONE key, and only
 * the two account-id spellings qualify: `{Ref: SomeParam}`, `Fn::ImportValue`,
 * an `Fn::Sub` of anything else, and every other shape stay UNUSABLE, because
 * their resolved value could be any catalog at all.
 */
function isAccountIdPseudoParameter(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return false;
  const bag = value as Record<string, unknown>;
  if (keys[0] === 'Ref') return bag['Ref'] === ACCOUNT_ID_PSEUDO_PARAMETER;
  if (keys[0] === 'Fn::Sub') {
    const arg = bag['Fn::Sub'];
    if (typeof arg === 'string') return arg === ACCOUNT_ID_SUB_TEMPLATE;
    // 2-arg form `['${AWS::AccountId}', {vars}]`. CFn forbids shadowing a
    // pseudo parameter in the variable map, so the template alone decides.
    return Array.isArray(arg) && arg[0] === ACCOUNT_ID_SUB_TEMPLATE;
  }
  return false;
}

/**
 * Coerce a template-borne `CatalogId` into the string the Glue API wants, or
 * `undefined` when no usable value is present (issue
 * [#1675](https://github.com/go-to-k/cdkd/issues/1675)).
 *
 * This is {@link importableString} plus a NUMBER arm, and the number arm is
 * load-bearing rather than defensive: `cdkd import --migrate-from-cloudformation`
 * reads the stack's ORIGINAL template (`cfn-stack-prefetch.ts`), where an
 * unquoted YAML `CatalogId: 123456789012` parses as a JSON number. Rejecting it
 * as "not a string" would drop the field and silently retarget the call at the
 * account's DEFAULT catalog — which on a DELETE can destroy a same-named
 * resource that happens to live there. `Number.isFinite` keeps `NaN` /
 * `Infinity` out (they fall through to the unusable arm, where they are
 * reported); a non-integer is stringified and AWS rejects it loudly, which is
 * the right failure.
 *
 * The coercion lives HERE rather than inside `importableString`: that helper is
 * shared with `DatabaseName` / `TableInput.Name` reads, where a number is a
 * malformed template rather than a YAML scalar to recover.
 */
function catalogIdForApi(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return importableString(value);
}

/**
 * The Data Catalog a Glue call must address, read out of a properties bag.
 *
 * `CatalogId` selects the Data Catalog; OMITTING it means the caller's own
 * account's DEFAULT catalog. So for a table / database / connection that lives
 * in a NON-default catalog (a cross-account Data Catalog, a Lake Formation
 * federated catalog) a call that drops the field targets the wrong catalog. On
 * a DELETE that is the issue-#1675 defect: AWS answers
 * `EntityNotFoundException`, the delete path's warn-and-continue idempotency
 * treats it as "already gone", and `cdkd destroy` reports SUCCESS while the
 * resource is still there — a silent LEAK, not a loud failure.
 *
 * cdkd's physical ids for these types encode no catalog (`<db>|<table>` for a
 * table, the bare name for a database / connection), so the id cannot carry it
 * — but the properties bag can, and `CatalogId` is a declared property of all
 * three types.
 *
 * `declaredButUnusable` is what lets the DELETE's NotFound arm DISCRIMINATE: a
 * NotFound after a correctly-targeted delete is legitimately idempotent, while
 * a NotFound after cdkd knowingly fell back to the default catalog is not
 * evidence of anything. It is deliberately FALSE for the account-id pseudo
 * parameter (see {@link isAccountIdPseudoParameter}) — dropping that one is
 * provably harmless, so warning about it would fire a leak alarm on every
 * ordinary destroy of an environment-agnostic CDK stack.
 *
 * SCOPE — the guard is applied to every read whose bag can be a RAW template:
 * the three deletes, the three `readCurrentState` readers, and the three
 * `import()` probes. The CREATE / UPDATE reads deliberately keep their bare
 * `as string | undefined` cast: the deploy engine resolves intrinsics before
 * the provider sees them, so guarding there is the separate issue-#1513
 * decision that #1651 already recorded. The one residual is a rollback replay
 * (`rollback-executor.ts` calls `update(..., previousState.properties, ...)`),
 * where an IMPORTED stack's raw bag does reach the update path — narrow enough
 * to leave to #1513 rather than widen this change into the deploy path.
 */
interface CatalogTarget {
  /** The value to send, or `undefined` to let the API default to this account. */
  catalogId: string | undefined;
  /** A catalog WAS declared, cdkd could not use it, and the drop is not provably safe. */
  declaredButUnusable: boolean;
}

function deleteCatalogId(properties: Record<string, unknown> | undefined): CatalogTarget {
  const raw = properties?.['CatalogId'];
  const catalogId = catalogIdForApi(raw);
  return {
    catalogId,
    declaredButUnusable: catalogId === undefined && raw != null && !isAccountIdPseudoParameter(raw),
  };
}

/** Human-readable name for the catalog a call addressed, for log messages. */
function describeCatalog(catalogId: string | undefined): string {
  return catalogId === undefined
    ? "this account's default Data Catalog"
    : `Data Catalog ${catalogId}`;
}

/**
 * Report the `EntityNotFoundException` arm of a Glue delete, at the severity
 * the evidence supports (issue #1675).
 *
 * With a correctly-targeted delete a NotFound means the resource is already
 * gone and the skip is ordinary idempotency — debug. When the template DECLARED
 * a `CatalogId` that {@link deleteCatalogId} could not use, cdkd addressed the
 * DEFAULT catalog instead, so a NotFound is equally consistent with "the
 * resource is alive in the declared catalog" — that is the silent-leak shape,
 * and it gets a warning.
 *
 * BOTH arms name the catalog actually addressed. A LITERAL-but-wrong
 * `CatalogId` (a typo, a stale account id) is otherwise indistinguishable from
 * an already-deleted resource in the log, and it takes the debug arm.
 */
function logCatalogScopedDeleteSkip(
  logger: { debug: (message: string) => void; warn: (message: string) => void },
  target: CatalogTarget,
  kind: 'Database' | 'Table' | 'Connection',
  logicalId: string,
  physicalId: string
): void {
  const where = describeCatalog(target.catalogId);
  if (!target.declaredButUnusable) {
    logger.debug(`Glue ${kind} ${physicalId} does not exist in ${where}, skipping deletion`);
    return;
  }
  logger.warn(
    `Glue ${kind} ${logicalId} (${physicalId}) was not found, so cdkd skipped its deletion — ` +
      `but the recorded CatalogId is not a usable value (likely an unresolved intrinsic), so ` +
      `the delete targeted ${where}. If the resource lives in a different Data Catalog it ` +
      `still exists. cdkd cannot retry this delete: the state record is dropped once the ` +
      `destroy completes, so check the intended catalog (aws glue get-${kind.toLowerCase()} ` +
      `--catalog-id <id> ...) and delete the resource there by hand.`
  );
}

/**
 * Resolve the `(databaseName, tableName)` pair an `AWS::Glue::Table` import
 * should probe, from either physicalId shape (issue #1651).
 *
 * cdkd's physicalId for a Glue Table is the composite `<databaseName>|<tableName>`
 * (built by `createTable`), because `GetTable` / `UpdateTable` / `DeleteTable`
 * all need both while `ResourceProvider`'s read-side methods receive a single
 * string. CloudFormation's physicalId for the same type is the TABLE NAME
 * ALONE — `Ref` returns it, and it never contains `|`. Auto-mode import merges
 * CloudFormation-derived ids into the overrides before the loop (#1128 / #1130),
 * so `knownPhysicalId` legitimately arrives in either shape and both must
 * resolve; treating the bare form as malformed reported every `cdk deploy`-managed
 * table as not-found while pointing the user at the very id it had just rejected.
 *
 * `|` is the discriminator, and its limit is worth stating precisely rather
 * than assuming: the "lowercase alphanumerics and underscore" rule usually
 * quoted for Glue names is the Athena / Data Catalog CONVENTION, not the API's
 * constraint. Live probe (us-east-1, 2026-08-12): `glue:CreateTable` ACCEPTS a
 * table literally named `a|b`.
 *
 * Such a table is not adoptable TODAY, and the refusal is deliberate — but the
 * limitation is cdkd's own and is fixable, so do not read this as a law of
 * nature. CloudFormation manages such a table fine: it keeps the physical id
 * and `DatabaseName` as separate values, whereas cdkd's `ResourceProvider`
 * passes a single identity string, so this provider PACKS both into
 * `<db>|<table>` with no escaping. `updateTable` / `deleteTable` / `readTable`
 * then destructure exactly two segments, so a three-segment `<db>|a|b` decodes
 * as database `<db>`, table `a` — a DIFFERENT table, which `deleteTable` would
 * delete. Issue #1672 tracks the real fix (the three decode sites already
 * receive the properties bag carrying `DatabaseName`, so the packing is not
 * even necessary for them) and notes that `createTable` has the SAME defect on
 * the deploy path, unguarded.
 *
 * Until then, refusing is right: writing a record cdkd cannot decode is the
 * failure mode of issue #1658 (`AWS::Route53::RecordSet` accepted
 * CloudFormation's id verbatim and made the stack undestroyable), which is
 * strictly worse than the loud not-found this returns. An earlier revision of
 * this fix retried the bare reading as a fallback and produced exactly that
 * record; three independent reviewers caught it.
 *
 * On failure it returns the REASON rather than a bare `undefined`, because the
 * three causes need three different messages and re-deriving the cause from the
 * inputs at the call site gets it wrong: `'db|'` contains a `|` but its real
 * defect is the empty segment, not the separator.
 */
type TableIdentityResult =
  | { ok: true; databaseName: string; tableName: string }
  /** A name contains `|`, cdkd's own separator — no id shape can represent it. */
  | { ok: false; reason: 'pipe-in-name' }
  /** An id was supplied but no usable `(database, table)` pair came out of it. */
  | { ok: false; reason: 'unpairable' }
  /** Nothing identified the table: no override and no usable template names. */
  | { ok: false; reason: 'unidentified' };

function resolveTableIdentity(input: {
  knownPhysicalId: string | undefined;
  templateDatabaseName: string | undefined;
  templateTableName: string | undefined;
}): TableIdentityResult {
  const { knownPhysicalId, templateDatabaseName, templateTableName } = input;

  let databaseName: string | undefined;
  let tableName: string | undefined;

  if (knownPhysicalId === undefined) {
    databaseName = templateDatabaseName;
    tableName = templateTableName;
  } else if (knownPhysicalId.includes('|')) {
    // EXACTLY two segments. Destructuring the first two out of three would
    // silently drop the rest: `mydb|a|b` would read as database `mydb`, table
    // `a` — a DIFFERENT table, adopted under an id that round-trips cleanly and
    // therefore never looks wrong again. That shape is on the INVITED path, not
    // a hypothetical: the refusal warning below tells the user to pass
    // `<databaseName>|<tableName>`, so someone whose table is named `a|b`
    // types exactly this.
    const parts = knownPhysicalId.split('|');
    if (parts.length !== 2) return { ok: false, reason: 'pipe-in-name' };
    databaseName = parts[0] || undefined;
    tableName = parts[1] || undefined;
  } else {
    // Bare CloudFormation id: the table name. The database comes from the
    // template, where CDK renders `DatabaseName` as a `Ref` to the sibling
    // `AWS::Glue::Database` — whose CFn physicalId IS the database name, so the
    // overrides map resolves it to a literal before `import()` is called.
    //
    // The override wins over the template's `TableInput.Name`: the user named a
    // specific resource to adopt, and probing a different one would adopt the
    // wrong table. `importableString` rejects the empty string, so a
    // `--resource-mapping` entry of `""` (which `parseMappingJson` accepts,
    // unlike the `--resource` flag) still returns not-found rather than sending
    // `GetTable({Name: ''})`, whose `InvalidInputException` is not
    // `EntityNotFoundException` and would abort the whole import.
    databaseName = templateDatabaseName;
    tableName = importableString(knownPhysicalId);
  }

  if (databaseName === undefined || tableName === undefined) {
    return { ok: false, reason: knownPhysicalId === undefined ? 'unidentified' : 'unpairable' };
  }

  // Neither segment may itself contain `|`, or the composite this becomes is
  // not decodable by the two-way `split('|')` in `updateTable` / `deleteTable` /
  // `readTable`. The composite and bare branches above are `|`-free by
  // construction (one is the product of a 2-part split, the other only runs for
  // a pipe-free id), so in practice this catches the TEMPLATE branch — a
  // `TableInput.Name` of `a|b` would otherwise be recorded as `<db>|a|b` and
  // decode to a different table. It is written as an unconditional post-check
  // rather than a per-branch one so a future branch cannot forget it.
  if (databaseName.includes('|') || tableName.includes('|')) {
    return { ok: false, reason: 'pipe-in-name' };
  }

  return { ok: true, databaseName, tableName };
}

/**
 * SDK Provider for AWS Glue resources
 *
 * Supports:
 * - AWS::Glue::Database
 * - AWS::Glue::Table
 *
 * Glue CreateDatabase/CreateTable are synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
export class GlueProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::Database', new Set(['DatabaseInput', 'DatabaseName', 'CatalogId'])],
    [
      'AWS::Glue::Table',
      new Set(['DatabaseName', 'TableInput', 'Name', 'CatalogId', 'OpenTableFormatInput']),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::Glue::Database':
        return this.createDatabase(logicalId, resourceType, properties);
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

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::Glue::Database':
        return this.updateDatabase(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::Glue::Table':
        return this.updateTable(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
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

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
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

  // ─── AWS::Glue::Database ──────────────────────────────────────────

  private async createDatabase(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Database ${logicalId}`);

    const databaseInput = properties['DatabaseInput'] as Record<string, unknown> | undefined;
    if (!databaseInput) {
      throw new ProvisioningError(
        `DatabaseInput is required for Glue Database ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn schema accepts both top-level `DatabaseName` (the canonical
    // resource identifier) and nested `DatabaseInput.Name`. Prefer the
    // nested value when set so existing templates keep working; fall back
    // to top-level when only the resource-level identifier is provided.
    const databaseName =
      (databaseInput['Name'] as string | undefined) ??
      (properties['DatabaseName'] as string | undefined);
    if (!databaseName) {
      throw new ProvisioningError(
        `DatabaseInput.Name or top-level DatabaseName is required for Glue Database ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    try {
      await this.getClient().send(
        new CreateDatabaseCommand({
          CatalogId: catalogId,
          DatabaseInput: this.buildDatabaseInput(databaseInput, databaseName),
        })
      );

      this.logger.debug(`Successfully created Glue Database ${logicalId}: ${databaseName}`);

      return {
        physicalId: databaseName,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Database ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateDatabase(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Database ${logicalId}: ${physicalId}`);

    const databaseInput = properties['DatabaseInput'] as Record<string, unknown> | undefined;
    if (!databaseInput) {
      throw new ProvisioningError(
        `DatabaseInput is required for Glue Database update ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    // Read-merge-write for AWS-authored `DatabaseInput.Parameters` — see
    // {@link preserveAwsManagedParameters}. ONLY the read sits outside the
    // `try`, because only IT raises a typed `ProvisioningError` the catch
    // wrapper below would re-label. The build + merge stay inside so a
    // malformed template (`Parameters: null`) still surfaces as a
    // `ProvisioningError` rather than a raw `TypeError`.
    const liveParameters = await this.readLiveDatabaseParameters(
      logicalId,
      resourceType,
      physicalId,
      catalogId
    );

    try {
      const builtDatabaseInput = this.buildDatabaseInput(databaseInput, physicalId);
      this.preserveAwsManagedParameters(
        builtDatabaseInput,
        databaseInput['Parameters'],
        (previousProperties?.['DatabaseInput'] as Record<string, unknown> | undefined)?.[
          'Parameters'
        ],
        liveParameters
      );

      await this.getClient().send(
        new UpdateDatabaseCommand({
          ...(catalogId !== undefined && { CatalogId: catalogId }),
          Name: physicalId,
          DatabaseInput: builtDatabaseInput,
        })
      );

      this.logger.debug(`Successfully updated Glue Database ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Database ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDatabase(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Database ${logicalId}: ${physicalId}`);

    const target = deleteCatalogId(properties);
    if (target.declaredButUnusable) {
      this.logger.debug(
        `Glue Database ${logicalId}: CatalogId is not a usable value (likely an unresolved ` +
          `intrinsic), so DeleteDatabase targets ${describeCatalog(target.catalogId)}.`
      );
    }

    try {
      await this.getClient().send(
        new DeleteDatabaseCommand({
          Name: physicalId,
          ...(target.catalogId !== undefined && { CatalogId: target.catalogId }),
        })
      );
      this.logger.debug(`Successfully deleted Glue Database ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        logCatalogScopedDeleteSkip(this.logger, target, 'Database', logicalId, physicalId);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Database ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::Glue::Table ─────────────────────────────────────────────

  private async createTable(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Table ${logicalId}`);

    const databaseName = properties['DatabaseName'] as string | undefined;
    if (!databaseName) {
      throw new ProvisioningError(
        `DatabaseName is required for Glue Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const tableInput = properties['TableInput'] as Record<string, unknown> | undefined;
    if (!tableInput) {
      throw new ProvisioningError(
        `TableInput is required for Glue Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn schema accepts both top-level `Name` (the canonical resource
    // identifier) and nested `TableInput.Name`. Prefer the nested value
    // when set; fall back to top-level when only the resource-level
    // identifier is provided.
    const tableName =
      (tableInput['Name'] as string | undefined) ?? (properties['Name'] as string | undefined);
    if (!tableName) {
      throw new ProvisioningError(
        `TableInput.Name or top-level Name is required for Glue Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    enforceIcebergTableInputAbsent(logicalId, resourceType, properties, {
      warn: (message) => this.logger.warn(message),
      replayingState: context?.replayingState === true,
    });

    // `OpenTableFormatInput` (Apache Iceberg) is a top-level `CreateTableCommand`
    // param — a SIBLING of `TableInput`, NOT nested inside it. Omit when absent.
    // Iceberg's `MetadataOperation: 'CREATE'` is a create-time directive, so it
    // is intentionally wired on create only — `UpdateTableCommandInput` has no
    // `OpenTableFormatInput` member at all (it carries the different,
    // update-only `UpdateOpenTableFormatInput` shape, which CFn does not model;
    // verified against @aws-sdk/client-glue `UpdateTableRequest`).
    //
    // Every member of the DEPLOYABLE shape (`IcebergInput.MetadataOperation` /
    // `.Version`) is spelled identically in CFn and the SDK, so the blob is
    // forwarded verbatim. The one divergent member —
    // `IcebergInput.IcebergTableInput` — is refused pre-flight just above on a
    // TEMPLATE-driven create, so it never reaches here from that path. On a
    // STATE REPLAY (`CreateContext.replayingState`, issue #1463) the pre-flight
    // only WARNS, so the blob DOES arrive carrying it and is forwarded verbatim
    // — deliberately: that reproduces the degraded table the replay is
    // restoring rather than failing the rollback. See
    // {@link enforceIcebergTableInputAbsent} for the full reasoning, and read
    // its warning before ever relaxing the refusal.
    const openTableFormatInput = properties['OpenTableFormatInput'] as
      | Record<string, unknown>
      | undefined;

    // Refuse a `|` in either segment BEFORE `CreateTable` runs (issue #1672).
    // This is the ONE site in the composite-id family with LIVE evidence that
    // the hazard is real: `glue:CreateTable` with `TableInput.Name: 'a|b'`
    // SUCCEEDS (probe, us-east-1 2026-08-12), so the recorded `<db>|a|b` would
    // decode to a DIFFERENT table — which `deleteTable` would then delete, or
    // warn-and-skip while reporting success. `DatabaseName` is guarded on the
    // same footing but was NOT probed: both segments are user-chosen and the
    // Athena / Data Catalog "lowercase alphanumerics and underscore" rule that
    // would rule it out is a convention rather than an API constraint, so
    // guarding it is the conservative reading, not a measured one. Computed
    // here rather than after the call so the refusal cannot orphan a table AWS
    // has already created. `import()` refuses the same shape via
    // `resolveTableIdentity` (issue #1651), which is why the composite it
    // builds needs no second guard.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'databaseName', value: databaseName },
        { name: 'tableName', value: tableName },
      ],
      // A reverse-replacement rollback creates from a STATE record, so the
      // refusal downgrades to a warning: the user cannot edit a state record
      // from their template, and a table recorded by an older binary under the
      // ambiguous id must still be restorable.
      context?.replayingState === true
        ? { onRefusal: (message) => this.logger.warn(message) }
        : undefined
    );

    try {
      await this.getClient().send(
        new CreateTableCommand({
          CatalogId: catalogId,
          DatabaseName: databaseName,
          TableInput: this.buildTableInput(tableInput, tableName),
          ...(openTableFormatInput !== undefined && {
            OpenTableFormatInput: openTableFormatInput as OpenTableFormatInput,
          }),
        })
      );

      this.logger.debug(`Successfully created Glue Table ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Table ${logicalId}: ${physicalId}`);

    const [databaseName, tableName] = physicalId.split('|');
    if (!databaseName || !tableName) {
      throw new ProvisioningError(
        compositeIdFormatMessage(GLUE_TABLE_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }

    const tableInput = properties['TableInput'] as Record<string, unknown> | undefined;
    if (!tableInput) {
      throw new ProvisioningError(
        `TableInput is required for Glue Table update ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    // UPDATE only WARNS where create REFUSES, and the asymmetry is deliberate.
    //
    // Rollback restores a resource from cdkd STATE, not from the template
    // (`rollback-executor.ts` calls `provider.update(..., op.previousState.properties)`).
    // A table created by a cdkd build older than #1390 succeeded with the
    // property silently dropped by the SDK serializer, so its state record
    // still carries the key. Refusing here would hard-fail both any UPDATE to
    // such a table AND its ROLLBACK — and for the rollback there is no
    // template-side remedy, only hand-editing state.json. That is a worse
    // outcome than the one this refusal exists to prevent.
    //
    // Warning costs nothing HERE: cdkd does not wire Glue's update-only
    // `UpdateOpenTableFormatInput` shape, and `buildTableInput` is an explicit
    // allow-list, so no `OpenTableFormatInput` value can reach AWS from this
    // path by any route. The user still gets the full actionable message, and
    // the CREATE path (where the property could actually be sent) still refuses.
    //
    // The other rollback arm is covered too, since issue #1463:
    // `replayRollback`'s reverse-replacement path revives the OLD resource by
    // calling `create()` with `previousState.properties`, and it now passes
    // `CreateContext.replayingState` so the create-side pre-flight downgrades
    // to the same warning instead of failing that rollback operation.
    const updateIcebergKey = findIcebergTableInputKey(properties);
    if (updateIcebergKey !== undefined) {
      this.logger.warn(icebergTableInputRefusalMessage(logicalId, updateIcebergKey, 'update'));
    }

    // Read-merge-write for AWS-authored `TableInput.Parameters` — see
    // {@link preserveAwsManagedParameters}. ONLY the read sits outside the
    // `try`, because only IT raises a typed `ProvisioningError` the catch
    // wrapper below would re-label. The build + merge stay inside so a
    // malformed template (`Parameters: null`) still surfaces as a
    // `ProvisioningError` rather than a raw `TypeError`.
    const live = await this.readLiveTableState(
      logicalId,
      resourceType,
      physicalId,
      databaseName,
      tableName,
      catalogId
    );

    try {
      const builtTableInput = this.buildTableInput(tableInput, tableName);
      this.preserveAwsManagedParameters(
        builtTableInput,
        tableInput['Parameters'],
        (previousProperties?.['TableInput'] as Record<string, unknown> | undefined)?.['Parameters'],
        live.parameters
      );
      this.preserveAwsManagedStorageDescriptor(
        builtTableInput,
        tableInput,
        previousProperties?.['TableInput'],
        live.storageDescriptor
      );

      await this.getClient().send(
        new UpdateTableCommand({
          ...(catalogId !== undefined && { CatalogId: catalogId }),
          DatabaseName: databaseName,
          TableInput: builtTableInput,
          // Optimistic-concurrency guard for the read-modify-write window.
          // Sent whenever the pre-read returned a version — see
          // {@link readLiveTableState} for why this is unconditional.
          ...(live.versionId !== undefined && { VersionId: live.versionId }),
        })
      );

      this.logger.debug(`Successfully updated Glue Table ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      // A `ConcurrentModificationException` means someone else changed the
      // table under us. Say so explicitly — the generic wrap would leave the
      // user staring at a bare SDK error with no hint that a concurrent
      // Iceberg commit is the likely cause and that a re-run is the fix.
      //
      // The wording is gated on whether cdkd actually attached the `VersionId`
      // precondition. Without one, AWS raised this on its own and claiming
      // "cdkd refused" would be a lie about our own behavior.
      let message = `Failed to update Glue Table ${logicalId}: ${detail}`;
      if (error instanceof ConcurrentModificationException) {
        message +=
          `. Another writer changed the table between cdkd's pre-update read and its ` +
          `UpdateTable call.`;
        message +=
          live.versionId !== undefined
            ? ` cdkd sent the version it read (${live.versionId}) as a precondition and AWS ` +
              `rejected the write, rather than let it put back the AWS-managed Parameters and ` +
              `StorageDescriptor members read a moment earlier — which for an Apache Iceberg ` +
              `table would have pinned it to an older metadata_location (an effective snapshot ` +
              `rollback).`
            : ` AWS returned no VersionId on the pre-update read, so cdkd could not attach a ` +
              `precondition; AWS rejected the write on its own.`;
        message += ` Re-run the deploy to pick up the current values.`;
      }
      throw new ProvisioningError(message, resourceType, logicalId, physicalId, cause);
    }
  }

  private async deleteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting Glue Table ${logicalId}: ${physicalId}`);

    // DECISION on issue #1675's "decide together with #1672" note: the
    // `DatabaseName` this arm is missing IS reachable from the `properties` bag
    // below, so this skip could be replaced by a bag-derived fallback. It is
    // deliberately NOT done here. #1672 is about the id PACKING (an unescaped
    // `|` making a legally-named table undestroyable), and its fix changes what
    // a decodable id even is — a fallback added now would have to be reworked
    // by it, and would meanwhile make an id cdkd cannot decode look survivable.
    // Every id cdkd itself writes is a well-formed 2-segment composite
    // (`createTable` and `importTable`'s round-trip fence both guarantee it), so
    // this arm is only reachable from a hand-edited state record today.
    const [databaseName, tableName] = physicalId.split('|');
    if (!databaseName || !tableName) {
      this.logger.warn(
        compositeIdFormatMessage(GLUE_TABLE_ID_FORMAT, logicalId, physicalId, { skipping: true })
      );
      // Issue #1752: report the SKIP rather than returning void. A bare
      // `return` here is indistinguishable from a completed delete, so the
      // destroy summary counted this table as deleted while it stayed alive.
      return compositeIdSkipResult();
    }

    // `CatalogId` must be threaded here or the delete silently targets this
    // account's DEFAULT Data Catalog — see {@link deleteCatalogId} for the leak
    // this closes (issue #1675). `createTable` and `importTable` both forward
    // it; this call omitted it.
    const target = deleteCatalogId(properties);
    if (target.declaredButUnusable) {
      this.logger.debug(
        `Glue Table ${logicalId}: CatalogId is not a usable value (likely an unresolved ` +
          `intrinsic), so DeleteTable targets ${describeCatalog(target.catalogId)}.`
      );
    }

    try {
      await this.getClient().send(
        new DeleteTableCommand({
          ...(target.catalogId !== undefined && { CatalogId: target.catalogId }),
          DatabaseName: databaseName,
          Name: tableName,
        })
      );
      this.logger.debug(`Successfully deleted Glue Table ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        logCatalogScopedDeleteSkip(this.logger, target, 'Table', logicalId, physicalId);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Merge AWS-AUTHORED `Parameters` back into a full-replace update payload
   * (issue [#1461](https://github.com/go-to-k/cdkd/issues/1461)).
   *
   * `UpdateTable` / `UpdateDatabase` replace `TableInput` / `DatabaseInput`
   * **wholesale**: whatever the payload omits is erased. `Parameters` is a
   * general-purpose bag that AWS itself writes into, so keys with NO template
   * representation were wiped by the first unrelated edit. For an Apache
   * Iceberg table that is not cosmetic — `table_type: ICEBERG` and
   * `metadata_location` are what make the table readable as Iceberg by
   * Athena / Spark / EMR, and losing them silently degrades it to a plain
   * external table pointing at Iceberg data files. Verified live 2026-08-10
   * in us-east-1: a deploy changing only `TableInput.Description` left
   * `Table.Parameters` as `null`. The same exposure covers a Glue crawler's
   * `classification`, `EXTERNAL`, `comment`, and Lake Formation markers.
   *
   * The merge is keyed on **"present in NEITHER template side"**, not on
   * "absent from the desired side" — the latter would make user-authored
   * parameters unremovable, i.e. the mirror image of the bug:
   *
   * | key in desired | key in previous | outcome                              |
   * | -------------- | --------------- | ------------------------------------ |
   * | yes            | (either)        | the user's value wins                |
   * | no             | yes             | the USER REMOVED it -> stays removed |
   * | no             | no              | AWS-AUTHORED -> preserved from live  |
   *
   * That keeps this provider on the repo's established clear-on-removal
   * position (docs/provider-development.md §2a, issue #1155): a removal the
   * user expressed in the template still reaches AWS. Glue's update APIs are
   * full-replace, so removal needs no explicit reset sentinel — omitting the
   * key IS the reset, and the only thing this helper adds back is the set of
   * keys the user never authored in the first place. The generalized rule for
   * any full-replace update API lives in docs/provider-development.md §2b.
   *
   * Audited siblings that do NOT get this treatment: `JobUpdate`'s
   * `DefaultArguments` / `NonOverridableArguments`, `ConnectionInput`'s
   * `ConnectionProperties`, `WorkflowUpdate.DefaultRunProperties` and
   * `Crawler.Configuration` are purely USER-authored bags — AWS does not
   * write into them, so merging live values back would only resurrect
   * console-side additions and break `cdkd drift --revert`.
   *
   * `desiredParameters` / `previousParameters` are the raw CFn-side maps
   * (their KEY SET is all that matters here; `buildTableInput` already
   * stringified the desired VALUES into `built.Parameters`).
   */
  private preserveAwsManagedParameters(
    built: { Parameters?: Record<string, string> | undefined },
    desiredParameters: unknown,
    previousParameters: unknown,
    liveParameters: Record<string, string> | undefined
  ): void {
    if (!liveParameters || Object.keys(liveParameters).length === 0) return;

    const desiredKeys = parameterKeySet(desiredParameters);
    const previousKeys = parameterKeySet(previousParameters);

    const awsAuthored: Record<string, string> = {};
    for (const [key, value] of Object.entries(liveParameters)) {
      // Present in the desired template -> the user's value wins.
      // Present only in the previous template -> the user removed it.
      if (desiredKeys.has(key) || previousKeys.has(key)) continue;
      awsAuthored[key] = value;
    }
    if (Object.keys(awsAuthored).length === 0) return;

    // Desired values are spread LAST so a template-declared key always wins
    // over the live readback (which is a snapshot from before this update).
    built.Parameters = { ...awsAuthored, ...(built.Parameters ?? {}) };
  }

  /**
   * Read-merge-write for out-of-band-authored `TableInput.StorageDescriptor`
   * members (issue #1479) — the subtree sibling of
   * {@link preserveAwsManagedParameters}, applied per SD MEMBER, with the two
   * nested bags (`StorageDescriptor.Parameters`, `SerdeInfo.Parameters`)
   * getting the same per-KEY rule one level down.
   *
   * Live probes (2026-08-10, us-east-1 — recorded on issue #1479) established
   * WHO authors what, which is why this is per-member rather than a blanket
   * merge:
   *
   * - A USER-authored `EXTERNAL_TABLE`: re-sending the template verbatim
   *   reads back identical — the service itself authors only scalar defaults
   *   (`Compressed: false`, `NumberOfBuckets: 0`, ...). Full-replace is
   *   CORRECT for template-declared members, and `drift --revert` depends on
   *   it to clear console-side edits.
   * - A CRAWLER-populated table: the crawler authors `Columns`,
   *   `InputFormat` / `OutputFormat`, `SerdeInfo` (incl. its `Parameters`
   *   bag), and `StorageDescriptor.Parameters`; an UpdateTable restating only
   *   a minimal template wiped ALL of them (`Columns` -> `[]`, `SerdeInfo`
   *   gone) while reporting success.
   * - An ICEBERG table: an UpdateTable omitting `Columns` was ACCEPTED and
   *   wiped the catalog schema to `[]` (Glue re-derives Iceberg columns from
   *   table metadata, so the catalog copy is metadata-authored between
   *   engine commits).
   *
   * The preservation key is the SAME "present in NEITHER template side" test
   * as {@link preserveAwsManagedParameters}, per member:
   *
   * | member in desired | member in previous | outcome                            |
   * | ----------------- | ------------------ | ---------------------------------- |
   * | yes               | (either)           | template wins                      |
   * | no                | yes                | the USER REMOVED it -> stays removed |
   * | no                | no                 | out-of-band authored -> carried forward from live |
   *
   * A template that never declared `StorageDescriptor` on EITHER side (a
   * crawler-managed table adopted into a minimal template) carries the whole
   * live block forward. Deliberately scoped to the `StorageDescriptor`
   * subtree per issue #1479 — the crawler also authors `PartitionKeys` /
   * `Owner`, but widening beyond the issue's member set is a separate
   * decision (recorded there).
   *
   * TOCTOU: the write rides the same unconditional `VersionId` precondition
   * as the Parameters merge (see {@link readLiveTableState}), so a concurrent
   * out-of-band write fails the update loudly instead of being clobbered.
   */
  private preserveAwsManagedStorageDescriptor(
    built: TableInput,
    desiredTableInput: Record<string, unknown>,
    previousTableInput: unknown,
    liveSd: StorageDescriptor | undefined
  ): void {
    if (!liveSd || Object.keys(liveSd).length === 0) return;

    const desiredSdRaw = desiredTableInput['StorageDescriptor'];
    const previousSdRaw = asRecord(previousTableInput)?.['StorageDescriptor'];

    // Neither template side ever declared the block -> it is entirely
    // out-of-band authored (crawler / Iceberg metadata); carry it forward
    // whole. `undefined` (not key-set emptiness) is the declaration test, so
    // a declared-but-empty `StorageDescriptor: {}` takes the per-member path.
    if (desiredSdRaw === undefined && previousSdRaw === undefined) {
      built.StorageDescriptor = liveSd;
      return;
    }

    const desiredKeys = parameterKeySet(desiredSdRaw);
    const previousKeys = parameterKeySet(previousSdRaw);
    const sdOut: Record<string, unknown> = {
      ...((built.StorageDescriptor as Record<string, unknown> | undefined) ?? {}),
    };

    for (const [member, liveValue] of Object.entries(liveSd as Record<string, unknown>)) {
      if (liveValue === undefined) continue;
      if (desiredKeys.has(member) || previousKeys.has(member)) continue;
      sdOut[member] = liveValue;
    }

    // The two nested BAGS get the per-KEY rule whenever EITHER template side
    // declares the containing member — when neither does, the member loop
    // above already carried the whole bag forward. Gating on the desired side
    // alone would make removing the whole bag wipe its AWS-authored keys, the
    // exact action the top-level #1461 helper handles per key (desired absent
    // + previous declared -> user keys removed, AWS-authored keys survive);
    // the OR keeps the two levels on one semantic. SerdeInfo is deliberately
    // different — see its gate below.
    const desiredSd = asRecord(desiredSdRaw);
    const previousSd = asRecord(previousSdRaw);
    if (desiredKeys.has('Parameters') || previousKeys.has('Parameters')) {
      this.preserveAwsManagedParameters(
        sdOut as { Parameters?: Record<string, string> | undefined },
        desiredSd?.['Parameters'],
        previousSd?.['Parameters'],
        liveSd.Parameters
      );
    }
    // SerdeInfo is STRUCTURAL, not a bag: its members (SerializationLibrary,
    // Name) are user-authored in every template shape, so removing the whole
    // block from the template is a whole-member removal the member loop above
    // honors — resurrecting a partial SerdeInfo carrying only the crawler's
    // Parameters would leave an incoherent serde. Hence the desired-only gate
    // here, unlike the Parameters bags.
    if (desiredKeys.has('SerdeInfo') && liveSd.SerdeInfo) {
      const desiredSerde = asRecord(desiredSd?.['SerdeInfo']);
      const previousSerde = asRecord(previousSd?.['SerdeInfo']);
      const desiredSerdeKeys = parameterKeySet(desiredSerde);
      const previousSerdeKeys = parameterKeySet(previousSerde);
      const serdeOut: Record<string, unknown> = {
        ...((sdOut['SerdeInfo'] as Record<string, unknown> | undefined) ?? {}),
      };
      for (const [member, liveValue] of Object.entries(
        liveSd.SerdeInfo as Record<string, unknown>
      )) {
        if (liveValue === undefined) continue;
        if (desiredSerdeKeys.has(member) || previousSerdeKeys.has(member)) continue;
        serdeOut[member] = liveValue;
      }
      // Same OR gate as StorageDescriptor.Parameters — the inner bag keeps
      // per-key semantics even when the user removes the whole bag.
      if (desiredSerdeKeys.has('Parameters') || previousSerdeKeys.has('Parameters')) {
        this.preserveAwsManagedParameters(
          serdeOut as { Parameters?: Record<string, string> | undefined },
          desiredSerde?.['Parameters'],
          previousSerde?.['Parameters'],
          liveSd.SerdeInfo.Parameters
        );
      }
      if (Object.keys(serdeOut).length > 0) {
        sdOut['SerdeInfo'] = serdeOut;
      }
    }

    if (Object.keys(sdOut).length > 0) {
      built.StorageDescriptor = sdOut as StorageDescriptor;
    }
  }

  /**
   * The live table state the two merges need: its current `Parameters` (for
   * {@link preserveAwsManagedParameters}), its `StorageDescriptor` (for
   * {@link preserveAwsManagedStorageDescriptor}, issue #1479), plus the
   * `VersionId` that pins both.
   *
   * A missing table returns empty rather than throwing: `UpdateTable` is about
   * to surface the real, more actionable error. Any OTHER failure is fatal by
   * design — degrading to "skip the merge" would silently reinstate the very
   * wipe this read exists to prevent, and the wrapped cause keeps a transient
   * throttle retryable by the deploy engine's outer `withRetry` (every
   * `provider.update()` call site wraps it, including both rollback arms since
   * this issue).
   *
   * **Why `VersionId` matters and why it is SCOPED.** Reading `Parameters`
   * here and writing them back in the next call opens a TOCTOU window: an
   * Apache Iceberg commit from Spark / Athena / EMR landing in between would
   * be undone by writing back the `metadata_location` we read, pinning the
   * table to an older snapshot — silent data-visibility loss, strictly worse
   * than the bug this read fixes. `UpdateTableRequest.VersionId` is AWS's
   * optimistic-concurrency token for exactly this
   * (`ConcurrentModificationException` is a documented `UpdateTable` error),
   * so the caller sends the version it read and a concurrent commit makes the
   * update fail loudly instead of silently rolling back.
   *
   * It is sent UNCONDITIONALLY whenever this read returned a version, and the
   * earlier attempt to scope it to "only when the merge wrote back live
   * values" was wrong on both counts. Wrong on SAFETY: the merge also reports
   * nothing-written-back when the live read came back EMPTY, and that update
   * still ships a wholesale `TableInput` replace — so a commit landing in the
   * window would have been wiped with no guard at all, i.e. #1461 surviving
   * its own fix. Wrong on its PREMISE: this read runs milliseconds before the
   * send on every update, so a pure template push (`cdkd drift --revert`, the
   * case the scoping was meant to protect) carries a FRESH version too. An
   * unconditional guard therefore cannot fire spuriously — it fires only when
   * somebody else genuinely wrote in between, which is exactly when a revert
   * should stop and be re-run against current values rather than clobber a
   * change it never saw.
   *
   * The precondition's real-AWS semantics are pinned by the `data-analytics`
   * integ, which advances a table's version out of band and asserts cdkd's
   * update is REFUSED — without that, "AWS silently ignores a stale VersionId"
   * would make this guard a placebo.
   */
  private async readLiveTableState(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    databaseName: string,
    tableName: string,
    catalogId: string | undefined
  ): Promise<{
    parameters: Record<string, string> | undefined;
    storageDescriptor: StorageDescriptor | undefined;
    versionId: string | undefined;
  }> {
    try {
      const resp = await this.getClient().send(
        new GetTableCommand({
          ...(catalogId !== undefined && { CatalogId: catalogId }),
          DatabaseName: databaseName,
          Name: tableName,
        })
      );
      return {
        parameters: resp.Table?.Parameters,
        storageDescriptor: resp.Table?.StorageDescriptor,
        versionId: resp.Table?.VersionId,
      };
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        return { parameters: undefined, storageDescriptor: undefined, versionId: undefined };
      }
      throw new ProvisioningError(
        preUpdateReadFailureMessage('Table', 'glue:GetTable', logicalId, error),
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * `Database.Parameters` as AWS currently holds them, for
   * {@link preserveAwsManagedParameters}. Same not-found / fail-closed
   * contract as {@link readLiveTableState}.
   *
   * There is NO `VersionId` analogue here: `UpdateDatabaseRequest` has no such
   * member (verified against `@aws-sdk/client-glue`), so the database merge
   * carries the TOCTOU exposure the table merge closes. It is far narrower in
   * practice — nothing commits to a Glue DATABASE out of band the way an
   * Iceberg engine commits to a table — but it is real, and is written up in
   * docs/supported-resources.md rather than left implicit.
   */
  private async readLiveDatabaseParameters(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    catalogId: string | undefined
  ): Promise<Record<string, string> | undefined> {
    try {
      const resp = await this.getClient().send(
        new GetDatabaseCommand({
          ...(catalogId !== undefined && { CatalogId: catalogId }),
          Name: physicalId,
        })
      );
      return resp.Database?.Parameters;
    } catch (error) {
      if (error instanceof EntityNotFoundException) return undefined;
      throw new ProvisioningError(
        preUpdateReadFailureMessage('Database', 'glue:GetDatabase', logicalId, error),
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Build DatabaseInput for Glue API from CFn template properties.
   *
   * Used by both `createDatabase` and `updateDatabase` so the same
   * field-by-field shape is sent on both paths. Optional fields use
   * `!== undefined` gates (per `feedback_update_optional_field_undefined_check.md`)
   * so empty-string Description, empty Parameters map, etc. reach AWS
   * intact — `cdkd drift --revert` relies on this to clear console-side
   * additions.
   */
  private buildDatabaseInput(
    databaseInput: Record<string, unknown>,
    fallbackName: string
  ): DatabaseInput {
    const result: DatabaseInput = {
      Name: (databaseInput['Name'] as string | undefined) ?? fallbackName,
    };

    if (databaseInput['Description'] !== undefined) {
      result.Description = databaseInput['Description'] as string;
    }
    if (databaseInput['LocationUri'] !== undefined) {
      result.LocationUri = databaseInput['LocationUri'] as string;
    }
    if (databaseInput['Parameters'] !== undefined) {
      // Stringified like `buildTableInput` does: CFn may deliver booleans /
      // numbers, and the SDK member is `Record<string, string>`. The two
      // builders diverging here was a latent inconsistency, not a decision.
      result.Parameters = stringifyParameterValues(databaseInput['Parameters']);
    }

    return result;
  }

  /**
   * Build TableInput for Glue API from CFn template properties
   */
  private buildTableInput(tableInput: Record<string, unknown>, fallbackName: string): TableInput {
    const result: TableInput = {
      Name: (tableInput['Name'] as string | undefined) ?? fallbackName,
    };

    if (tableInput['Description'] !== undefined) {
      result.Description = tableInput['Description'] as string;
    }

    if (tableInput['TableType'] !== undefined) {
      result.TableType = tableInput['TableType'] as string;
    }

    if (tableInput['Parameters'] !== undefined) {
      // Convert all values to strings (CDK may pass booleans/numbers)
      result.Parameters = stringifyParameterValues(tableInput['Parameters']);
    }

    if (tableInput['Owner'] !== undefined) {
      result.Owner = tableInput['Owner'] as string;
    }

    if (tableInput['Retention'] !== undefined) {
      result.Retention = tableInput['Retention'] as number;
    }

    if (tableInput['ViewOriginalText'] !== undefined) {
      result.ViewOriginalText = tableInput['ViewOriginalText'] as string;
    }

    if (tableInput['ViewExpandedText'] !== undefined) {
      result.ViewExpandedText = tableInput['ViewExpandedText'] as string;
    }

    // StorageDescriptor
    if (tableInput['StorageDescriptor'] !== undefined) {
      const sd = tableInput['StorageDescriptor'] as Record<string, unknown>;
      result.StorageDescriptor = this.buildStorageDescriptor(sd);
    }

    // PartitionKeys
    if (tableInput['PartitionKeys'] !== undefined) {
      result.PartitionKeys = tableInput['PartitionKeys'] as Column[];
    }

    // `TargetTable` (resource-link tables) and `ViewDefinition` complete the CFn
    // `TableInput` member set. Found by diffing the WHOLE blob against the live
    // registry schema while fixing the StorageDescriptor allow-list (issue
    // #1505) — the same silent-drop class one level up, and WORSE there: the
    // #1479 read-merge-write only covers the `StorageDescriptor` subtree and
    // `Parameters`, so nothing carries these forward and `UpdateTable`'s full
    // replace erased a live value unconditionally. `readCurrentState` already
    // reads `TargetTable` back, so drift surfaced a member deploy could never
    // send.
    //
    // Both forward verbatim: all 12 CFn `TableInput` members were compared
    // against `@aws-sdk/client-glue`, and `TableIdentifier`
    // ({CatalogId, DatabaseName, Name, Region}) plus `ViewDefinition`
    // ({Definer, SubObjects, Representations, IsProtected}, whose
    // `ViewRepresentation` is {Dialect, DialectVersion, ValidationConnection,
    // ViewExpandedText, ViewOriginalText}) are same-spelled and same-shaped.
    if (tableInput['TargetTable'] !== undefined) {
      result.TargetTable = tableInput['TargetTable'] as TableIdentifier;
    }

    if (tableInput['ViewDefinition'] !== undefined) {
      result.ViewDefinition = tableInput['ViewDefinition'] as ViewDefinitionInput;
    }

    return result;
  }

  /**
   * Build StorageDescriptor for Glue API
   */
  private buildStorageDescriptor(sd: Record<string, unknown>): StorageDescriptor {
    const result: StorageDescriptor = {};

    if (sd['Columns'] !== undefined) {
      result.Columns = sd['Columns'] as Column[];
    }

    if (sd['Location'] !== undefined) {
      result.Location = sd['Location'] as string;
    }

    if (sd['InputFormat'] !== undefined) {
      result.InputFormat = sd['InputFormat'] as string;
    }

    if (sd['OutputFormat'] !== undefined) {
      result.OutputFormat = sd['OutputFormat'] as string;
    }

    if (sd['Compressed'] !== undefined) {
      result.Compressed = sd['Compressed'] as boolean;
    }

    if (sd['NumberOfBuckets'] !== undefined) {
      result.NumberOfBuckets = sd['NumberOfBuckets'] as number;
    }

    if (sd['SerdeInfo'] !== undefined) {
      const serde = sd['SerdeInfo'] as Record<string, unknown>;
      if (serde['Parameters']) {
        // Copy rather than mutate: `sd` is the caller's template object, and
        // the same block is re-read by the #1479 merge's key-set walk.
        result.SerdeInfo = {
          ...serde,
          Parameters: stringifyParameterValues(serde['Parameters']),
        } as SerDeInfo;
      } else {
        result.SerdeInfo = serde as SerDeInfo;
      }
    }

    if (sd['BucketColumns'] !== undefined) {
      result.BucketColumns = sd['BucketColumns'] as string[];
    }

    if (sd['SortColumns'] !== undefined) {
      result.SortColumns = sd['SortColumns'] as Order[];
    }

    if (sd['Parameters'] !== undefined) {
      result.Parameters = sd['Parameters'] as Record<string, string>;
    }

    if (sd['StoredAsSubDirectories'] !== undefined) {
      result.StoredAsSubDirectories = sd['StoredAsSubDirectories'] as boolean;
    }

    // `SkewedInfo` / `SchemaReference` complete the CFn `StorageDescriptor`
    // member set (issue #1505). Before this they were dropped by the
    // allow-list, and the #1479 merge made that WORSE than a plain drop: its
    // key sets come from the RAW template, so DECLARING one suppressed the
    // live carry-forward (the member counts as user-authored) while the
    // builder never sent a value — erasing the live value with nothing
    // replacing it. An UNDECLARED member was, and still is, preserved by the
    // carry-forward.
    //
    // The issue also named `AdditionalLocations`, but the live CFn registry
    // schema declares exactly the 13 members handled here with
    // `additionalProperties: false` — that one exists only in the SDK model,
    // so no template can reach it and forwarding it would be dead code.
    if (sd['SkewedInfo'] !== undefined) {
      // `asRecord` rather than a cast: a malformed / null block would otherwise
      // throw a raw TypeError from the member read below, surfacing as
      // "Cannot read properties of null" instead of AWS's real validation
      // error. Same convention as `parameterKeySet` / the #1471 shape guards.
      const skewed = asRecord(sd['SkewedInfo']) ?? {};
      // CFn types `SkewedColumnValueLocationMaps` as a free-form object while
      // the SDK member is `Record<string, string>` — the same CFn-delivers-
      // non-strings case `Parameters` handles.
      result.SkewedInfo =
        skewed['SkewedColumnValueLocationMaps'] !== undefined
          ? ({
              ...skewed,
              SkewedColumnValueLocationMaps: stringifyParameterValues(
                skewed['SkewedColumnValueLocationMaps']
              ),
            } as SkewedInfo)
          : (skewed as SkewedInfo);
    }

    if (sd['SchemaReference'] !== undefined) {
      // Every member (`SchemaId.{RegistryName,SchemaName,SchemaArn}`,
      // `SchemaVersionId`, `SchemaVersionNumber`) is same-spelled and
      // same-shaped between the CFn schema and `@aws-sdk/client-glue`, so the
      // block forwards verbatim.
      // `SchemaVersionNumber` is the one member needing coercion: CFn types it
      // as an integer, but a hand-authored template (or a `Ref` to a Number
      // parameter) can deliver "2", which the SDK's number field rejects with a
      // SerializationException. Same treatment the Job numerics get.
      const schemaRef = asRecord(sd['SchemaReference']) ?? {};
      result.SchemaReference = (
        schemaRef['SchemaVersionNumber'] !== undefined
          ? { ...schemaRef, SchemaVersionNumber: coerceNumber(schemaRef['SchemaVersionNumber']) }
          : schemaRef
      ) as SchemaReference;
    }

    return result;
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
   * `CatalogId` is intentionally not surfaced — `GetDatabase` /
   * `GetTable` do not echo it back, and cdkd state's `CatalogId` is
   * usually the AWS account id (defaulted by the API). Comparator only
   * descends into keys present in state, so an absent surface key cannot
   * fire false drift here.
   *
   * Returns `undefined` when the resource is gone (`EntityNotFoundException`).
   * Other Glue resource types (`Job`, `Crawler`, `Connection`, `Trigger`,
   * `Workflow`, `SecurityConfiguration`, etc.) are out of scope for v1 —
   * the provider's `create()` only handles Database/Table; CC API picks
   * up drift detection for the rest.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
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
    switch (resourceType) {
      case 'AWS::Glue::Database':
        return this.readDatabase(physicalId, catalogId);
      case 'AWS::Glue::Table':
        return this.readTable(physicalId, catalogId);
      default:
        return undefined;
    }
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
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::Glue::Table') {
      return ['OpenTableFormatInput'];
    }
    return [];
  }

  private async readDatabase(
    physicalId: string,
    catalogId?: string
  ): Promise<Record<string, unknown> | undefined> {
    let db;
    try {
      const resp = await this.getClient().send(
        new GetDatabaseCommand({
          ...(catalogId !== undefined && { CatalogId: catalogId }),
          Name: physicalId,
        })
      );
      db = resp.Database;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!db) return undefined;

    const dbInput: Record<string, unknown> = {};
    if (db.Name !== undefined) dbInput['Name'] = db.Name;
    dbInput['Description'] = db.Description ?? '';
    if (db.LocationUri !== undefined) dbInput['LocationUri'] = db.LocationUri;
    dbInput['Parameters'] = db.Parameters ?? {};
    // CFn schema accepts BOTH nested `DatabaseInput.Name` AND top-level
    // `DatabaseName` (see #613 B-bucket fix in createDatabase). Surface
    // both so drift comparison works for either template shape.
    const result: Record<string, unknown> = { DatabaseInput: dbInput };
    if (db.Name !== undefined) result['DatabaseName'] = db.Name;
    return result;
  }

  private async readTable(
    physicalId: string,
    catalogId?: string
  ): Promise<Record<string, unknown> | undefined> {
    const [databaseName, tableName] = physicalId.split('|');
    if (!databaseName || !tableName) return undefined;

    let table;
    try {
      const resp = await this.getClient().send(
        new GetTableCommand({
          ...(catalogId !== undefined && { CatalogId: catalogId }),
          DatabaseName: databaseName,
          Name: tableName,
        })
      );
      table = resp.Table;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!table) return undefined;

    const tableInput: Record<string, unknown> = {};
    if (table.Name !== undefined) tableInput['Name'] = table.Name;
    tableInput['Description'] = table.Description ?? '';
    if (table.Owner !== undefined) tableInput['Owner'] = table.Owner;
    if (table.Retention !== undefined) tableInput['Retention'] = table.Retention;
    if (table.TableType !== undefined) tableInput['TableType'] = table.TableType;
    tableInput['PartitionKeys'] = (table.PartitionKeys ?? []).map(
      (k) => k as unknown as Record<string, unknown>
    );
    tableInput['Parameters'] = table.Parameters ?? {};
    if (table.StorageDescriptor) {
      tableInput['StorageDescriptor'] = table.StorageDescriptor as unknown as Record<
        string,
        unknown
      >;
    }
    if (table.ViewOriginalText !== undefined) {
      tableInput['ViewOriginalText'] = table.ViewOriginalText;
    }
    if (table.ViewExpandedText !== undefined) {
      tableInput['ViewExpandedText'] = table.ViewExpandedText;
    }
    if (table.TargetTable) {
      tableInput['TargetTable'] = table.TargetTable as unknown as Record<string, unknown>;
    }

    // CFn schema accepts BOTH nested `TableInput.Name` AND top-level
    // `Name` (see #613 B-bucket fix in createTable). Surface both so
    // drift comparison works for either template shape.
    const result: Record<string, unknown> = {
      DatabaseName: databaseName,
      TableInput: tableInput,
    };
    if (table.Name !== undefined) result['Name'] = table.Name;
    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::Glue::Database':
        return this.importDatabase(input);
      case 'AWS::Glue::Table':
        return this.importTable(input);
      default:
        return null;
    }
  }

  private async importDatabase(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName =
      input.knownPhysicalId ??
      importableString(
        (input.properties['DatabaseInput'] as Record<string, unknown> | undefined)?.['Name']
      );
    const catalogId = catalogIdForApi(input.properties['CatalogId']);

    if (explicitName) {
      try {
        await this.getClient().send(
          new GetDatabaseCommand({ Name: explicitName, ...(catalogId && { CatalogId: catalogId }) })
        );
        return { physicalId: explicitName, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // database reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importTable(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const databaseName = importableString(input.properties['DatabaseName']);
    const tableInput = input.properties['TableInput'] as Record<string, unknown> | undefined;
    const templateTableName = importableString(tableInput?.['Name']);
    const catalogId = catalogIdForApi(input.properties['CatalogId']);

    const identity = resolveTableIdentity({
      knownPhysicalId: input.knownPhysicalId,
      templateDatabaseName: databaseName,
      templateTableName,
    });
    if (!identity.ok) {
      // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
      // that tag never exists on a real resource and the walk could not match
      // (issue #1134). Auto-mode import resolves ids from CloudFormation's
      // `DescribeStackResources` or the template's physical-name property; a
      // table reaching here needs an explicit `--resource` override.
      //
      // Each cause gets its own message. A single text would be FALSE for two
      // of the three, and the caller-side hint (`pass --resource
      // <LogicalId>=<physicalId>`) is actionable for only one of them — the
      // original #1651 bug WAS a dead end where the suggested remedy was the
      // thing being rejected, so being vague here would reproduce it.
      switch (identity.reason) {
        case 'pipe-in-name':
          // Not a user error to correct by re-running with a different id —
          // there is no id shape that would work — so say what to change
          // instead of suggesting one. `|` is cdkd's own separator (see
          // `createTable`); AWS accepts it in a Glue name even though the
          // Athena convention does not.
          this.logger.warn(
            `AWS::Glue::Table ${input.logicalId}: cannot be imported because a name contains ` +
              `'|', which cdkd currently uses as the separator in this type's physical id ` +
              `(<databaseName>|<tableName>). Adopting it would record an id cdkd cannot decode ` +
              `back to the same table. CloudFormation manages such a table fine; this is a ` +
              `cdkd limitation tracked in ` +
              `https://github.com/go-to-k/cdkd/issues/1672. Until it is lifted, rename the ` +
              `table or database to omit '|', or manage this resource outside cdkd.`
          );
          break;
        case 'unpairable':
          this.logger.warn(
            `AWS::Glue::Table ${input.logicalId}: cannot resolve a database for physical id ` +
              `'${input.knownPhysicalId}'. ` +
              (input.knownPhysicalId === ''
                ? `The supplied physical id is empty. `
                : `The template's DatabaseName is absent or is an unresolved intrinsic, so ` +
                  `the bare table name cannot be paired. `) +
              `Pass the composite form instead: ` +
              `--resource '${input.logicalId}=<databaseName>|<tableName>' ` +
              `(quote it — '|' is a shell pipe).`
          );
          break;
        case 'unidentified':
          // Nothing named the table at all. The caller already prints the
          // `--resource` hint for this case, so a second message would be noise.
          break;
      }
      return null;
    }

    const { databaseName: dbName, tableName: tName } = identity;
    try {
      await this.getClient().send(
        new GetTableCommand({
          DatabaseName: dbName,
          Name: tName,
          ...(catalogId && { CatalogId: catalogId }),
        })
      );
      // Always normalize to cdkd's composite form: `updateTable` /
      // `deleteTable` / `readTable` all split the stored physicalId on `|`, so
      // recording CloudFormation's bare table name would adopt the resource
      // into a state record the rest of the provider cannot use — trading a
      // visible not-found for a silent one. That is the #1658 failure mode
      // (`AWS::Route53::RecordSet` accepted CFn's id verbatim and the stack
      // became undestroyable). The composite is built from the pair actually
      // PROBED, and `resolveTableIdentity` has already refused any segment
      // containing `|`, so the recorded id decodes back to the same pair.
      return { physicalId: `${dbName}|${tName}`, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}

// ─── AWS::Glue::Workflow ───────────────────────────────────────────
//
// Glue Workflow has a clean SDK update path (`UpdateWorkflow`) covering
// every mutable top-level field — `Description`, `DefaultRunProperties`,
// `MaxConcurrentRuns`. `Name` is immutable on create. Tags ride on
// `CreateWorkflow.Tags` but cdkd updates them out-of-band via
// `TagResource` / `UntagResource` (kept simple here — tag updates are
// always done by `cdkd drift --revert` against the current AWS shape).
//
// Surface used by `cdkd drift`:
//   - `readCurrentState` reads via `GetWorkflow` and reverse-maps every
//     user-controllable top-level key to the CFn shape with PR #145
//     always-emit placeholders (`Description: ''`, `DefaultRunProperties: {}`,
//     `MaxConcurrentRuns: undefined` only when AWS reports nothing — same
//     pattern used by other providers' optional integer fields).
//   - `getDriftUnknownPaths` is empty: no AWS-managed read-only fields are
//     templated into cdkd state for this type.

/**
 * SDK Provider for `AWS::Glue::Workflow`.
 *
 * Workflow is a top-level Glue catalog entry that orchestrates Triggers,
 * Jobs, and Crawlers via a DAG. The CFn shape carries `Name` (required,
 * immutable on create), `Description`, `DefaultRunProperties` (string→string
 * map), `MaxConcurrentRuns`, and `Tags`.
 *
 * Read-update round-trip: `cdkd drift --revert` calls `update(...,
 * awsCurrent, observedSnapshot)` so the same `UpdateWorkflow` payload is
 * built from either side. `Description` and `DefaultRunProperties` use
 * `!== undefined` gates so empty-string / empty-map values reach AWS
 * (matches `feedback_update_optional_field_undefined_check.md`).
 */
export class GlueWorkflowProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueWorkflowProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Workflow',
      new Set(['Name', 'Description', 'DefaultRunProperties', 'MaxConcurrentRuns', 'Tags']),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Workflow ${logicalId}`);

    const name = properties['Name'] as string | undefined;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for Glue Workflow ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Glue Workflow Tags may arrive as a CFn `{Key,Value}[]` list OR a tag map
      // (CDK can synth either shape); use the map-tolerant helper so a map shape
      // is not silently dropped. Elide the key when there are no tags.
      const tagsMap = cfnTagsToMap(properties['Tags']);
      const tags = tagsMap && Object.keys(tagsMap).length > 0 ? tagsMap : undefined;
      await this.getClient().send(
        new CreateWorkflowCommand({
          Name: name,
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(properties['DefaultRunProperties'] !== undefined && {
            DefaultRunProperties: properties['DefaultRunProperties'] as Record<string, string>,
          }),
          ...(properties['MaxConcurrentRuns'] !== undefined && {
            MaxConcurrentRuns: coerceNumber(properties['MaxConcurrentRuns']) as number,
          }),
          ...(tags && { Tags: tags }),
        })
      );

      this.logger.debug(`Successfully created Glue Workflow ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Workflow ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Workflow ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new UpdateWorkflowCommand({
          Name: physicalId,
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(properties['DefaultRunProperties'] !== undefined && {
            DefaultRunProperties: properties['DefaultRunProperties'] as Record<string, string>,
          }),
          ...(properties['MaxConcurrentRuns'] !== undefined && {
            MaxConcurrentRuns: coerceNumber(properties['MaxConcurrentRuns']) as number,
          }),
        })
      );

      this.logger.debug(`Successfully updated Glue Workflow ${logicalId}`);
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Workflow ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Workflow ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteWorkflowCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted Glue Workflow ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Workflow ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Workflow ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  /**
   * Read AWS-current Workflow shape via `GetWorkflow`. Surfaces every
   * user-controllable top-level CFn key with always-emit placeholders
   * (PR #145):
   *  - `Description` → `?? ''`
   *  - `DefaultRunProperties` → `?? {}`
   *  - `MaxConcurrentRuns` → omitted when AWS reports `undefined` (no
   *    AWS-side default to anchor a placeholder against; cdkd state may
   *    legitimately leave this unset)
   *  - `Tags` → `?? []` (filtered against `aws:cdk:path` and the rest of
   *    the `aws:`-prefixed reserved space)
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let workflow;
    try {
      const resp = await this.getClient().send(
        new GetWorkflowCommand({ Name: physicalId, IncludeGraph: false })
      );
      workflow = resp.Workflow;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!workflow) return undefined;

    const result: Record<string, unknown> = {
      Name: workflow.Name ?? physicalId,
      Description: workflow.Description ?? '',
      DefaultRunProperties: workflow.DefaultRunProperties ?? {},
    };

    if (workflow.MaxConcurrentRuns !== undefined) {
      result['MaxConcurrentRuns'] = workflow.MaxConcurrentRuns;
    }

    // Tags via separate GetTags(ResourceArn) call.
    const arn = await this.buildWorkflowArn(physicalId);
    let tags: Array<{ Key: string; Value: string }> = [];
    try {
      const tagResp = await this.getClient().send(new GetTagsCommand({ ResourceArn: arn }));
      tags = normalizeAwsTagsToCfn(tagResp.Tags);
    } catch (err) {
      // Best-effort — `GetTags` failure should not abort the drift read.
      this.logger.debug(
        `GetTags failed for Glue Workflow ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    result['Tags'] = tags;

    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);

    if (explicitName) {
      try {
        await this.getClient().send(new GetWorkflowCommand({ Name: explicitName }));
        return { physicalId: explicitName, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // workflow reaching here needs an explicit `--resource` override.
    return null;
  }

  private async buildWorkflowArn(workflowName: string): Promise<string> {
    const region = await this.getRegion();
    const account = await this.getAccountId();
    return `arn:aws:glue:${region}:${account}:workflow/${workflowName}`;
  }

  private async getRegion(): Promise<string> {
    const region = await this.getClient().config.region();
    return region || this.providerRegion || 'us-east-1';
  }

  private async getAccountId(): Promise<string> {
    if (this.cachedAccountId) return this.cachedAccountId;
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    if (!identity.Account) {
      throw new Error('Failed to resolve AWS account id from STS');
    }
    this.cachedAccountId = identity.Account;
    return this.cachedAccountId;
  }
}

// ─── AWS::Glue::SecurityConfiguration ──────────────────────────────
//
// SecurityConfiguration is **immutable on update** per AWS docs — the
// only mutators are `CreateSecurityConfiguration` and
// `DeleteSecurityConfiguration`. Any update path therefore surfaces
// `ResourceUpdateNotSupportedError` so `cdkd drift --revert` reports a
// clean "use cdkd deploy --replace" outcome instead of silently no-op'ing.
//
// `EncryptionConfiguration` carries three sub-configs (CFn names):
//   - `S3Encryptions[]` (plural in CFn; maps to the SDK `S3Encryption` singular
//     field) — array of `{S3EncryptionMode, KmsKeyArn}`
//   - `CloudWatchEncryption` — `{CloudWatchEncryptionMode, KmsKeyArn}`
//   - `JobBookmarksEncryption` — `{JobBookmarksEncryptionMode, KmsKeyArn}`
// AWS docs also surface `DataQualityEncryption` on the SDK shape but
// CloudFormation does NOT model it (`AWS::Glue::SecurityConfiguration`
// has only the three above), so we ignore it on read to avoid false
// drift on the v3 baseline.

/**
 * SDK Provider for `AWS::Glue::SecurityConfiguration`.
 *
 * Immutable resource — `update()` always throws
 * `ResourceUpdateNotSupportedError`. Replacement falls through to the
 * deploy engine's CREATE→DELETE replacement path.
 *
 * Tags are NOT supported on `CreateSecurityConfiguration` (verified
 * against the SDK shape — `CreateSecurityConfigurationRequest` has only
 * `Name` + `EncryptionConfiguration`), so cdkd does not surface a `Tags`
 * key in `readCurrentState` even with an always-emit placeholder.
 */
export class GlueSecurityConfigurationProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueSecurityConfigurationProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::SecurityConfiguration', new Set(['Name', 'EncryptionConfiguration'])],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue SecurityConfiguration ${logicalId}`);

    const name = properties['Name'] as string | undefined;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for Glue SecurityConfiguration ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const encryptionConfiguration = properties['EncryptionConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (!encryptionConfiguration) {
      throw new ProvisioningError(
        `EncryptionConfiguration is required for Glue SecurityConfiguration ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.getClient().send(
        new CreateSecurityConfigurationCommand({
          Name: name,
          EncryptionConfiguration: buildEncryptionConfiguration(encryptionConfiguration),
        })
      );

      this.logger.debug(`Successfully created Glue SecurityConfiguration ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue SecurityConfiguration ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async update(
    logicalId: string,
    _physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // SecurityConfiguration is immutable per AWS — no `UpdateSecurity*`
    // command exists. `cdkd drift --revert` and replacement-detection
    // both end up here; the latter expects the CREATE→DELETE replacement
    // layer to handle it. Surface the error so revert reports a clean
    // "could not revert" outcome instead of silently succeeding.
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'AWS Glue SecurityConfiguration is immutable on AWS — there is no UpdateSecurityConfiguration API; every change requires DeleteSecurityConfiguration + CreateSecurityConfiguration. Use cdkd deploy --replace, or destroy + redeploy with the new EncryptionConfiguration.'
    );
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue SecurityConfiguration ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteSecurityConfigurationCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted Glue SecurityConfiguration ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `Glue SecurityConfiguration ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue SecurityConfiguration ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  /**
   * Read AWS-current SecurityConfiguration shape via
   * `GetSecurityConfiguration`. Always emits the three CFn-modeled
   * sub-configs (`S3Encryptions: []`, `CloudWatchEncryption: {}`,
   * `JobBookmarksEncryption: {}`) per PR #145 even when AWS reports
   * nothing — closes the "console-side encryption enable on a previously
   * default config" detection gap on the v3 baseline.
   *
   * `DataQualityEncryption` is silently dropped: the CFn schema for
   * `AWS::Glue::SecurityConfiguration` does not model it, so surfacing it
   * would fire false drift on every clean run for a key cdkd state can
   * never carry.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let cfg;
    try {
      const resp = await this.getClient().send(
        new GetSecurityConfigurationCommand({ Name: physicalId })
      );
      cfg = resp.SecurityConfiguration;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!cfg) return undefined;

    return {
      Name: cfg.Name ?? physicalId,
      EncryptionConfiguration: mapEncryptionConfigurationToCfn(cfg.EncryptionConfiguration),
    };
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);

    if (explicitName) {
      try {
        await this.getClient().send(new GetSecurityConfigurationCommand({ Name: explicitName }));
        return { physicalId: explicitName, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    // Nothing left to look up. SecurityConfiguration is not taggable at all
    // (the type has no ARN to hand to `GetTags`), so it never had even the
    // now-removed `aws:cdk:path` walk to fall back on — and without an
    // explicit name there is no other key to match a candidate against.
    // Import users must pass `--resource <logicalId>=<name>` for this type.
    //
    // This previously paginated all of `GetSecurityConfigurations` into a
    // loop whose body was an explicit no-op, burning a full listing on every
    // call to reach the same `null` (issue #1134).
    return null;
  }
}

// ─── Helpers (file-level) ──────────────────────────────────────────

/** Max GetCrawler polls while waiting for a stopped crawler to settle. */
const CRAWLER_STOP_MAX_ATTEMPTS = 30;
/** Delay between GetCrawler polls while waiting for a crawler to stop. */
const CRAWLER_STOP_POLL_INTERVAL_MS = 2000;
/** Max GetTrigger polls while waiting for a trigger to reach DEACTIVATED. */
const TRIGGER_DEACTIVATE_MAX_ATTEMPTS = 30;
/** Delay between GetTrigger polls while waiting for a trigger to deactivate. */
const TRIGGER_DEACTIVATE_POLL_INTERVAL_MS = 1000;

/** Promise-based sleep used by the crawler / trigger state-machine waiters. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Both spellings of the Iceberg table spec cdkd refuses inside
 * `OpenTableFormatInput.IcebergInput`: the CFn registry schema's
 * `IcebergTableInput` and `@aws-sdk/client-glue`'s `CreateIcebergTableInput`.
 * A hand-written template can carry either, and neither is deployable, so the
 * pre-flight matches both and names whichever it found.
 */
const ICEBERG_TABLE_INPUT_KEYS = ['IcebergTableInput', 'CreateIcebergTableInput'] as const;

/**
 * Return whichever {@link ICEBERG_TABLE_INPUT_KEYS} spelling the template
 * carries under `OpenTableFormatInput.IcebergInput`, or `undefined`.
 *
 * Non-object shapes at either level (an unresolved intrinsic) are treated as
 * "absent" so AWS surfaces the real validation error rather than this refusal.
 */
function findIcebergTableInputKey(properties: Record<string, unknown>): string | undefined {
  const openTableFormatInput = properties['OpenTableFormatInput'];
  if (
    typeof openTableFormatInput !== 'object' ||
    openTableFormatInput === null ||
    Array.isArray(openTableFormatInput)
  ) {
    return undefined;
  }
  const iceberg = (openTableFormatInput as Record<string, unknown>)['IcebergInput'];
  if (typeof iceberg !== 'object' || iceberg === null || Array.isArray(iceberg)) {
    return undefined;
  }
  return ICEBERG_TABLE_INPUT_KEYS.find((key) => key in iceberg);
}

/**
 * PRE-FLIGHT REFUSAL of `AWS::Glue::Table`
 * `OpenTableFormatInput.IcebergInput.IcebergTableInput` (issue #1454).
 *
 * **This is a deliberate PARITY DIVERGENCE, and it was a conscious choice.**
 * cdkd's compatibility target is CloudFormation, and CloudFormation does not
 * validate this property — it forwards it and lets the deploy roll back. cdkd
 * refuses it EARLIER and with a better message instead. The justification is
 * that no user is losing a working deployment: the live probe on issue #1408
 * (2026-08-09, us-east-1 — 5 raw `glue:CreateTable` shapes plus 5
 * `AWS::Glue::Table` CloudFormation stacks) proved the property is undeployable
 * on BOTH paths.
 *
 * - **The raw `glue:CreateTable` API — the call cdkd itself makes** — rejects
 *   every `CreateIcebergTableInput` shape: without a
 *   `TableInput.StorageDescriptor` it fails `Location information cannot be
 *   null while creating an iceberg table`, and with one it fails `Table
 *   metadata information present at multiple parts of input request`. The
 *   spec's own `Location` is never read. So this is NOT merely cdkd declining
 *   what CloudFormation declines — cdkd's own path cannot deploy it either.
 * - **CloudFormation** rolls back all three variants with `Table metadata is
 *   expected only via TableInput or via IcebergTableInputProperties inside
 *   OpenTableFormatInput` — naming a property that exists in NEITHER the CFn
 *   registry schema (`IcebergInput.IcebergTableInput`) NOR
 *   `@aws-sdk/client-glue` (`IcebergInput.CreateIcebergTableInput`). That
 *   three-way contract mismatch is an AWS-side bug.
 *
 * Because there is no shape in which the property works, forwarding it can only
 * produce a late, cryptic AWS error. Failing fast with the working shape spelled
 * out is strictly more useful.
 *
 * **TEMPLATE creates only — every STATE REPLAY warns instead.** The refusal is
 * conditioned on the ORIGIN of the properties, not on the operation name:
 *
 * - `update()` warns unconditionally. Rollback replays from cdkd STATE, and a
 *   table created by a pre-#1390 build carries the key in its state record, so
 *   refusing there would make such a table unrollbackable with no
 *   template-side remedy. cdkd does not wire Glue's update-only
 *   `UpdateOpenTableFormatInput` shape and `buildTableInput` is an explicit
 *   allow-list, so warning forwards nothing and loses no protection.
 * - `create()` warns when {@link CreateContext.replayingState} is set — the
 *   rollback executor's reverse-replacement arm, which revives the OLD
 *   resource from `previousState.properties` (issue #1463). Same reasoning:
 *   the user cannot edit a state record from the template. Unlike the update
 *   path this one DOES forward the value, so the re-created table is degraded
 *   in exactly the way the original was (the CFn spelling is dropped by the
 *   SDK serializer per #1390; the SDK spelling is sent and Glue rejects it) —
 *   the warning says so, and the fix-forward is a `cdkd deploy`.
 * - Every deploy-engine `create()` refuses: the CREATE branch, the
 *   property-driven replacement, the `--recreate-via-*` destroy-then-create,
 *   the `--replace` delete-first fallback, and the update-failure replacement.
 *   All are driven by freshly resolved TEMPLATE properties, so the user CAN
 *   fix the input and a fast, actionable refusal is strictly better.
 *
 * The asymmetry constrains where this provider may re-create. `GlueProvider`
 * must never call `this.create()` from inside its own `update()` the way ACM /
 * IAM / Lambda-permission / SNS-subscription do: those internal re-creates
 * forward `update()`'s `properties` — a STATE record during a rollback replay —
 * and `update()` has no context parameter to carry the flag, so this refusal
 * would fire on a replay with no way to detect it.
 *
 * **Known bypass: the sticky Cloud Control route.** This is a GlueProvider
 * pre-flight, so it only runs on the SDK route. When a table's state record
 * carries `provisionedBy: 'cc-api'`, `ProviderRegistry.getProviderFor` sticky-
 * routes it to `CloudControlProvider`, which forwards the property to
 * CloudFormation and gets AWS's rollback instead of this message. That route is
 * opt-in only (`--recreate-via-cc-api`, or a legacy state record) —
 * `AWS::Glue::Table` has an empty `silentDrop` map, so no ordinary deploy takes
 * it. The outcome there is still a failure, just a later and less helpful one,
 * which is why this is documented rather than duplicated into the CC provider.
 *
 * **WARNING before relaxing this refusal.** cdkd used to RENAME the CFn
 * `IcebergTableInput` to the SDK's `CreateIcebergTableInput` (issue #1390); that
 * rename existed because the AWS SDK v3 serializer DROPS unknown members, so the
 * CFn spelling silently discarded the entire Iceberg spec while `CreateTable`
 * reported success. The rename was removed here as unreachable once this
 * refusal landed. If AWS ever ships a deployable shape and this check is
 * relaxed, the rename MUST be restored in the same change — otherwise the
 * silent-drop bug of #1390 comes straight back.
 */
function enforceIcebergTableInputAbsent(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  options: { warn: (message: string) => void; replayingState: boolean }
): void {
  const key = findIcebergTableInputKey(properties);
  if (key === undefined) {
    return;
  }
  if (options.replayingState) {
    options.warn(icebergTableInputRefusalMessage(logicalId, key, 'create-replay'));
    return;
  }
  throw new ProvisioningError(
    icebergTableInputRefusalMessage(logicalId, key, 'create'),
    resourceType,
    logicalId
  );
}

/**
 * The shared #1454 message body, so the CREATE refusal, the UPDATE warning and
 * the rollback-replay CREATE warning cannot drift apart. `mode` only changes
 * the lead clause — everything after it (the probe evidence and the working
 * shape) is identical, because the user's next action is the same either way.
 */
function icebergTableInputRefusalMessage(
  logicalId: string,
  key: string,
  mode: 'create' | 'create-replay' | 'update'
): string {
  const lead =
    mode === 'create'
      ? `cannot be deployed by AWS in any shape, so cdkd refuses it before calling Glue (issue #1454).`
      : mode === 'create-replay'
        ? `cannot be deployed by AWS in any shape, so cdkd normally refuses it before calling ` +
          `Glue (issue #1454) — but this create is REPLAYING a historical cdkd STATE record (a ` +
          `rollback reverse-replacement re-creating the OLD table), not your template, and ` +
          `refusing would leave that table unrestorable with no template-side remedy, only a ` +
          `hand-edit of state.json. cdkd therefore warns and proceeds (issue #1463). The ` +
          `re-created table is DEGRADED exactly as the original was: under the CFn spelling ` +
          `IcebergTableInput the AWS SDK serializer drops the unknown member (issue #1390), so ` +
          `the table comes back without its Iceberg metadata; under the SDK spelling ` +
          `CreateIcebergTableInput the value IS sent and Glue rejects the call, failing this ` +
          `one rollback operation. Either way, fix it forward with 'cdkd deploy' using the ` +
          `working shape below.`
        : `cannot be deployed by AWS in any shape and is IGNORED on update — cdkd does not wire ` +
          `Glue's update-only UpdateOpenTableFormatInput shape, so it forwards nothing here and ` +
          `only warns (issue #1454). A CREATE of this table would be refused outright.`;
  return (
    `AWS::Glue::Table ${logicalId}: OpenTableFormatInput.IcebergInput.${key} ${lead}\n` +
    `  Live-probed 2026-08-09 in us-east-1 (issue #1408): glue:CreateTable — the API cdkd ` +
    `calls — rejects every Iceberg table spec ("Location information cannot be null while ` +
    `creating an iceberg table" without a TableInput.StorageDescriptor, "Table metadata ` +
    `information present at multiple parts of input request" with one), and CloudFormation ` +
    `rolls the same template back with "Table metadata is expected only via TableInput or ` +
    `via IcebergTableInputProperties inside OpenTableFormatInput" — a property name that ` +
    `exists in neither the CFn registry schema (IcebergInput.IcebergTableInput) nor ` +
    `@aws-sdk/client-glue (IcebergInput.CreateIcebergTableInput).\n` +
    `  Working shape — put the table metadata in TableInput and leave IcebergInput carrying ` +
    `only the create-time directive:\n` +
    `    TableInput: { Name, TableType: 'EXTERNAL_TABLE', StorageDescriptor: { Location: ` +
    `'s3://your-bucket/prefix/', Columns: [...] } }\n` +
    `    OpenTableFormatInput: { IcebergInput: { MetadataOperation: 'CREATE' } }   ` +
    `// Version: '2' is also accepted\n` +
    `  Glue then writes the Iceberg metadata itself — the created table comes back with ` +
    `Parameters.table_type = ICEBERG and a populated Parameters.metadata_location.`
  );
}

/**
 * Build the SDK `EncryptionConfiguration` from the CFn-shape input
 * (`AWS::Glue::SecurityConfiguration.EncryptionConfiguration`). Each
 * sub-config (`S3Encryptions[]` / `CloudWatchEncryption` /
 * `JobBookmarksEncryption`) maps to the SDK member names — `CloudWatchEncryption`
 * / `JobBookmarksEncryption` match verbatim, but the CFn `S3Encryptions` (plural)
 * list maps to the SDK `S3Encryption` (singular) field.
 */
function buildEncryptionConfiguration(input: Record<string, unknown>): EncryptionConfiguration {
  const result: EncryptionConfiguration = {};

  // CFn names this property `S3Encryptions` (PLURAL); the SDK input field is
  // `S3Encryption` (singular). Reading the singular CFn key silently dropped
  // S3 encryption on every create (CDK / a hand-authored template always emits
  // the plural form). CloudWatchEncryption / JobBookmarksEncryption ARE singular
  // in both CFn and the SDK, so only this one diverges.
  if (Array.isArray(input['S3Encryptions'])) {
    result.S3Encryption = input['S3Encryptions'].map((entry) => {
      const e = entry as Record<string, unknown>;
      const item: S3Encryption = {};
      if (typeof e['S3EncryptionMode'] === 'string') {
        item.S3EncryptionMode = e['S3EncryptionMode'] as S3Encryption['S3EncryptionMode'];
      }
      if (typeof e['KmsKeyArn'] === 'string') {
        item.KmsKeyArn = e['KmsKeyArn'];
      }
      return item;
    });
  }

  if (input['CloudWatchEncryption'] !== undefined) {
    const cw = input['CloudWatchEncryption'] as Record<string, unknown>;
    const item: CloudWatchEncryption = {};
    if (typeof cw['CloudWatchEncryptionMode'] === 'string') {
      item.CloudWatchEncryptionMode = cw[
        'CloudWatchEncryptionMode'
      ] as CloudWatchEncryption['CloudWatchEncryptionMode'];
    }
    if (typeof cw['KmsKeyArn'] === 'string') {
      item.KmsKeyArn = cw['KmsKeyArn'];
    }
    result.CloudWatchEncryption = item;
  }

  if (input['JobBookmarksEncryption'] !== undefined) {
    const jb = input['JobBookmarksEncryption'] as Record<string, unknown>;
    const item: JobBookmarksEncryption = {};
    if (typeof jb['JobBookmarksEncryptionMode'] === 'string') {
      item.JobBookmarksEncryptionMode = jb[
        'JobBookmarksEncryptionMode'
      ] as JobBookmarksEncryption['JobBookmarksEncryptionMode'];
    }
    if (typeof jb['KmsKeyArn'] === 'string') {
      item.KmsKeyArn = jb['KmsKeyArn'];
    }
    result.JobBookmarksEncryption = item;
  }

  return result;
}

/**
 * Reverse-map AWS's `EncryptionConfiguration` SDK shape into the CFn
 * shape with always-emit placeholders (PR #145):
 *   - `S3Encryptions[]` → `?? []` (so console-side ADD is detectable)
 *   - `CloudWatchEncryption` → `?? {}`
 *   - `JobBookmarksEncryption` → `?? {}`
 *   - `DataQualityEncryption` → silently dropped (not in CFn schema)
 */
function mapEncryptionConfigurationToCfn(
  cfg: EncryptionConfiguration | undefined
): Record<string, unknown> {
  const c = cfg ?? {};
  return {
    // CFn shape uses `S3Encryptions` (plural) — see buildEncryptionConfiguration.
    S3Encryptions: (c.S3Encryption ?? []).map((entry) => {
      const out: Record<string, unknown> = {};
      if (entry.S3EncryptionMode !== undefined) out['S3EncryptionMode'] = entry.S3EncryptionMode;
      if (entry.KmsKeyArn !== undefined) out['KmsKeyArn'] = entry.KmsKeyArn;
      return out;
    }),
    CloudWatchEncryption: c.CloudWatchEncryption
      ? cleanCfnObject({
          CloudWatchEncryptionMode: c.CloudWatchEncryption.CloudWatchEncryptionMode,
          KmsKeyArn: c.CloudWatchEncryption.KmsKeyArn,
        })
      : {},
    JobBookmarksEncryption: c.JobBookmarksEncryption
      ? cleanCfnObject({
          JobBookmarksEncryptionMode: c.JobBookmarksEncryption.JobBookmarksEncryptionMode,
          KmsKeyArn: c.JobBookmarksEncryption.KmsKeyArn,
        })
      : {},
  };
}

function cleanCfnObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ─── Shared helpers for sibling Glue providers ──────────────────────────

/**
 * Build the ARN for a Glue resource. Used by tag-fetch via
 * `GetTagsCommand` which only accepts an ARN. Account id falls back
 * to STS when not provided.
 */
async function buildGlueResourceArn(
  client: GlueClient,
  stsClient: STSClient,
  resource: 'job' | 'crawler' | 'connection' | 'trigger',
  name: string,
  accountId: string | undefined
): Promise<string> {
  const region = (await client.config.region()) || process.env['AWS_REGION'] || 'us-east-1';
  const account = accountId ?? (await resolveAccountId(stsClient));
  return `arn:aws:glue:${region}:${account}:${resource}/${name}`;
}

async function resolveAccountId(stsClient: STSClient): Promise<string> {
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new Error('Failed to resolve AWS account id from STS');
  }
  return identity.Account;
}

/**
 * Best-effort fetch of CFn-shape `Tags: [{Key, Value}]` for a Glue resource.
 * Returns `[]` when no tags or on error (tags are non-critical for drift —
 * a permission failure should not abort the whole drift read).
 */
async function fetchGlueTags(
  client: GlueClient,
  stsClient: STSClient,
  resource: 'job' | 'crawler' | 'connection' | 'trigger',
  name: string,
  accountId: string | undefined,
  logger: ReturnType<typeof getLogger>
): Promise<Array<{ Key: string; Value: string }>> {
  try {
    const arn = await buildGlueResourceArn(client, stsClient, resource, name, accountId);
    const resp = await client.send(new GetTagsCommand({ ResourceArn: arn }));
    return normalizeAwsTagsToCfn(resp.Tags);
  } catch (err) {
    logger.debug(
      `GetTags failed for ${resource}/${name}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * SDK Provider for `AWS::Glue::Job`.
 *
 * CFn properties (subset cdkd manages on create/update):
 *   Name, Role, Command, Description, MaxCapacity, MaxRetries, Timeout,
 *   ExecutionProperty, GlueVersion, NumberOfWorkers, WorkerType,
 *   DefaultArguments, NonOverridableArguments, Connections, LogUri,
 *   SecurityConfiguration, NotificationProperty, ExecutionClass,
 *   JobMode, JobRunQueuingEnabled, MaintenanceWindow, AllocatedCapacity,
 *   SourceControlDetails, Tags.
 *
 * `physicalId` is the Glue job name. Tags on a Job are managed via the
 * separate `GetTags` / `TagResource` / `UntagResource` API since
 * `UpdateJob` / `JobUpdate` does not carry tags.
 */
export class GlueJobProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueJobProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Job',
      new Set([
        'Name',
        'Role',
        'Command',
        'Description',
        'MaxCapacity',
        'MaxRetries',
        'Timeout',
        'ExecutionProperty',
        'GlueVersion',
        'NumberOfWorkers',
        'WorkerType',
        'DefaultArguments',
        'NonOverridableArguments',
        'Connections',
        'LogUri',
        'SecurityConfiguration',
        'NotificationProperty',
        'ExecutionClass',
        'JobMode',
        'JobRunQueuingEnabled',
        'MaintenanceWindow',
        'AllocatedCapacity',
        'SourceControlDetails',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.stsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Job ${logicalId}`);
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const role = properties['Role'] as string | undefined;
    const command = properties['Command'] as Record<string, unknown> | undefined;
    if (!role) {
      throw new ProvisioningError(
        `Role is required for Glue Job ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!command) {
      throw new ProvisioningError(
        `Command is required for Glue Job ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    try {
      const tags = cfnTagsToMap(properties['Tags']);
      await this.getClient().send(
        new CreateJobCommand({
          Name: name,
          Role: role,
          Command: buildJobCommand(command),
          ...buildJobCommonFields(properties),
          ...(tags && { Tags: tags }),
        })
      );
      this.logger.debug(`Successfully created Glue Job ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Job ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Job ${logicalId}: ${physicalId}`);
    try {
      const command = properties['Command'] as Record<string, unknown> | undefined;
      const update: JobUpdate = {
        ...(command !== undefined && { Command: buildJobCommand(command) }),
        ...buildJobCommonFields(properties),
        // Role is required at create but mutable on update; include only when defined
        ...(properties['Role'] !== undefined && { Role: properties['Role'] as string }),
      };
      await this.getClient().send(new UpdateJobCommand({ JobName: physicalId, JobUpdate: update }));

      // Tags are not part of JobUpdate; reconcile via TagResource diff if tags changed.
      const oldTags = cfnTagsToMap(previousProperties['Tags']) ?? {};
      const newTags = cfnTagsToMap(properties['Tags']) ?? {};
      await this.applyTagDiff(physicalId, oldTags, newTags);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Job ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Job ${logicalId}: ${physicalId}`);
    try {
      await this.getClient().send(new DeleteJobCommand({ JobName: physicalId }));
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Job ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Job ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  /**
   * Read the AWS-current Glue Job in CFn-property shape.
   *
   * Always-emit placeholders for user-controllable top-level keys per
   * PR #145 (`?? '' | [] | {}`) so the v3 `observedProperties` baseline
   * detects console-side ADDs to fields that weren't templated. Tags
   * always emit `[]` (PR H pattern).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let job;
    try {
      const resp = await this.getClient().send(new GetJobCommand({ JobName: physicalId }));
      job = resp.Job;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!job) return undefined;

    const result: Record<string, unknown> = {
      Name: job.Name ?? physicalId,
      Role: job.Role ?? '',
      Command: pickDefined({
        Name: job.Command?.Name,
        ScriptLocation: job.Command?.ScriptLocation,
        PythonVersion: job.Command?.PythonVersion,
        Runtime: job.Command?.Runtime,
      }),
      Description: job.Description ?? '',
      LogUri: job.LogUri ?? '',
      DefaultArguments: job.DefaultArguments ?? {},
      NonOverridableArguments: job.NonOverridableArguments ?? {},
      Connections: { Connections: job.Connections?.Connections ?? [] },
      MaxRetries: job.MaxRetries ?? 0,
      Timeout: job.Timeout ?? 0,
      ExecutionProperty: { MaxConcurrentRuns: job.ExecutionProperty?.MaxConcurrentRuns ?? 1 },
      NotificationProperty: { NotifyDelayAfter: job.NotificationProperty?.NotifyDelayAfter ?? 0 },
      GlueVersion: job.GlueVersion ?? '',
      NumberOfWorkers: job.NumberOfWorkers ?? 0,
      WorkerType: job.WorkerType ?? '',
      MaxCapacity: job.MaxCapacity ?? 0,
      AllocatedCapacity: job.AllocatedCapacity ?? 0,
      SecurityConfiguration: job.SecurityConfiguration ?? '',
      ExecutionClass: job.ExecutionClass ?? '',
      JobMode: job.JobMode ?? '',
      JobRunQueuingEnabled: job.JobRunQueuingEnabled ?? false,
      MaintenanceWindow: job.MaintenanceWindow ?? '',
      SourceControlDetails: job.SourceControlDetails
        ? pickDefined(job.SourceControlDetails as Record<string, unknown>)
        : {},
    };
    result['Tags'] = await fetchGlueTags(
      this.getClient(),
      this.getStsClient(),
      'job',
      job.Name ?? physicalId,
      this.cachedAccountId,
      this.logger
    );
    return result;
  }

  private async applyTagDiff(
    physicalId: string,
    oldTags: Record<string, string>,
    newTags: Record<string, string>
  ): Promise<void> {
    const arn = await buildGlueResourceArn(
      this.getClient(),
      this.getStsClient(),
      'job',
      physicalId,
      this.cachedAccountId
    );
    const toAdd: Record<string, string> = {};
    const toRemove: string[] = [];
    for (const [k, v] of Object.entries(newTags)) {
      if (oldTags[k] !== v) toAdd[k] = v;
    }
    for (const k of Object.keys(oldTags)) {
      if (!(k in newTags)) toRemove.push(k);
    }
    // TagResource / UntagResource use the same Glue API (TagResource for add).
    if (Object.keys(toAdd).length > 0 || toRemove.length > 0) {
      // Lazy-import to avoid bundle bloat in delete-only paths.
      const { TagResourceCommand, UntagResourceCommand } = await import('@aws-sdk/client-glue');
      if (Object.keys(toAdd).length > 0) {
        await this.getClient().send(new TagResourceCommand({ ResourceArn: arn, TagsToAdd: toAdd }));
      }
      if (toRemove.length > 0) {
        await this.getClient().send(
          new UntagResourceCommand({ ResourceArn: arn, TagsToRemove: toRemove })
        );
      }
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
    if (!explicitName) return null;
    try {
      await this.getClient().send(new GetJobCommand({ JobName: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}

// ─── helpers shared by GlueJobProvider ──────────────────────────────────

function buildJobCommand(c: Record<string, unknown>): JobCommandShape {
  const result: JobCommandShape = {};
  if (c['Name'] !== undefined) result.Name = c['Name'] as string;
  if (c['ScriptLocation'] !== undefined) result.ScriptLocation = c['ScriptLocation'] as string;
  if (c['PythonVersion'] !== undefined) result.PythonVersion = c['PythonVersion'] as string;
  if (c['Runtime'] !== undefined) result.Runtime = c['Runtime'] as string;
  return result;
}

/**
 * Fields shared by `CreateJob` and `UpdateJob.JobUpdate` (everything except
 * `Name` / `Role` / `Command`). Each is gated on `!== undefined` so empty
 * strings / `false` / `0` round-trip cleanly via `cdkd drift --revert`.
 */
function buildJobCommonFields(p: Record<string, unknown>): Partial<JobUpdate> {
  const r: Partial<JobUpdate> = {};
  // String pass-through props (CFn delivers these as strings and the SDK types
  // them as strings too).
  const stringPassThrough: Array<keyof JobUpdate> = [
    'JobMode',
    'JobRunQueuingEnabled',
    'Description',
    'LogUri',
    'DefaultArguments',
    'NonOverridableArguments',
    'WorkerType',
    'SecurityConfiguration',
    'GlueVersion',
    'ExecutionClass',
    'MaintenanceWindow',
  ];
  for (const k of stringPassThrough) {
    if (p[k as string] !== undefined) {
      // Cast to any: union of multiple field types, type-gated by AWS SDK at the wire layer.
      (r as Record<string, unknown>)[k as string] = p[k as string];
    }
  }
  // Numeric props: CFn delivers these as STRINGS (CDK synths e.g. "10"), but the
  // Glue SDK types them as int/double. `as number` is compile-only and does NOT
  // coerce at runtime, so the SDK would receive a string for a number-typed field.
  // Coerce at the wire boundary. See feedback_cfn_stringly_typed_numerics_need_coerce.
  const numericPassThrough: Array<keyof JobUpdate> = [
    'MaxRetries',
    'AllocatedCapacity',
    'Timeout',
    'MaxCapacity',
    'NumberOfWorkers',
  ];
  for (const k of numericPassThrough) {
    const v = p[k as string];
    if (v !== undefined) {
      (r as Record<string, unknown>)[k as string] = coerceNumber(v);
    }
  }
  if (p['ExecutionProperty'] !== undefined) {
    const ep = { ...(p['ExecutionProperty'] as Record<string, unknown>) };
    if (ep['MaxConcurrentRuns'] !== undefined) {
      ep['MaxConcurrentRuns'] = coerceNumber(ep['MaxConcurrentRuns']);
    }
    r.ExecutionProperty = ep as ExecutionProperty;
  }
  if (p['Connections'] !== undefined) {
    const conn = p['Connections'] as Record<string, unknown>;
    r.Connections = { Connections: (conn['Connections'] as string[] | undefined) ?? [] };
  }
  if (p['NotificationProperty'] !== undefined) {
    const np = { ...(p['NotificationProperty'] as Record<string, unknown>) };
    if (np['NotifyDelayAfter'] !== undefined) {
      np['NotifyDelayAfter'] = coerceNumber(np['NotifyDelayAfter']);
    }
    r.NotificationProperty = np as NotificationProperty;
  }
  if (p['SourceControlDetails'] !== undefined) {
    r.SourceControlDetails = p['SourceControlDetails'] as SourceControlDetails;
  }
  return r;
}

/**
 * CFn `Parameters` map -> the SDK's `Record<string, string>`. CDK may deliver
 * booleans / numbers; the SDK member is string-valued.
 */
function stringifyParameterValues(raw: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  // A non-object (a string / array / unresolved intrinsic) must contribute NO
  // keys: `Object.entries('s3://x')` yields {'0':'s','1':'3',...}, which would
  // be written to AWS as a real map. Same refusal as `parameterKeySet` /
  // `asRecord` (the #1471 convention).
  const source = asRecord(raw);
  if (source === undefined) return params;
  for (const [k, v] of Object.entries(source)) {
    params[k] = String(v);
  }
  return params;
}

/**
 * Key set of a CFn-side `Parameters` map, for
 * {@link GlueProvider.preserveAwsManagedParameters}.
 *
 * A non-object (absent, or an unresolved intrinsic) contributes NO keys — so
 * a template that declares no `Parameters` at all can never be mistaken for
 * one that removed a key, and every live key stays preserved.
 */
function parameterKeySet(value: unknown): Set<string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return new Set<string>();
  }
  return new Set(Object.keys(value as Record<string, unknown>));
}

/**
 * Narrow an unknown template / state value to a plain object, or `undefined`.
 * A malformed side (string / array / null) yields `undefined` and therefore
 * an empty key set — the tolerant treatment `parameterKeySet` already gives
 * bags, extended to the StorageDescriptor merge's containers. (An unresolved
 * intrinsic is itself a plain object, so it passes through and contributes
 * its `Fn::*`/`Ref` key — harmless here, since providers only ever see
 * resolved values.)
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Message for a failed pre-update `Get*` read (issue #1461). Names the IAM
 * action so a permission gap is one line away from fixed, and says what the
 * read is FOR so the failure does not read as gratuitous.
 */
function preUpdateReadFailureMessage(
  kind: 'Table' | 'Database',
  iamAction: string,
  logicalId: string,
  error: unknown
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `Failed to read the current Glue ${kind} ${logicalId} before update: ${detail}. ` +
    `cdkd reads the live ${kind.toLowerCase()} so AWS-managed Parameters (Apache Iceberg's ` +
    `table_type / metadata_location, a crawler's classification, Lake Formation markers) ` +
    `survive an update that Glue applies as a full replace. Grant ${iamAction} to the ` +
    `deploy identity — proceeding without the read would silently erase them.`
  );
}

/**
 * Coerce a CFn-delivered numeric property (often a string like `"10"`) to a
 * JS number at the SDK wire boundary. Non-finite / unparseable inputs are
 * returned unchanged so AWS surfaces a clear validation error rather than
 * silently sending `NaN`.
 */
function coerceNumber(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

/**
 * Convert CFn `Tags: [{Key,Value}]` (or a tag map) to AWS Glue's
 * `Record<string,string>` shape used by Create commands and TagResource. Returns
 * `undefined` when the input is undefined so callers can elide the key.
 */
function cfnTagsToMap(tagsInput: unknown): Record<string, string> | undefined {
  if (tagsInput === undefined) return undefined;
  const out: Record<string, string> = {};
  if (Array.isArray(tagsInput)) {
    for (const entry of tagsInput) {
      const e = entry as Record<string, unknown>;
      const k = e['Key'];
      const v = e['Value'];
      if (typeof k === 'string') out[k] = typeof v === 'string' ? v : '';
    }
    return out;
  }
  if (typeof tagsInput === 'object' && tagsInput !== null) {
    for (const [k, v] of Object.entries(tagsInput as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : '';
    }
    return out;
  }
  return out;
}

/**
 * Recursively strip undefined / null values and empty objects from a plain
 * record, returning the cleaned shape. Used by `readCurrentState` to emit
 * tight CFn-shape sub-objects without leaking SDK-injected `undefined` keys.
 */
function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = pickDefined(v as Record<string, unknown>);
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * SDK Provider for `AWS::Glue::Crawler`.
 *
 * CFn `Schedule` is the structured `{ScheduleExpression: 'cron(...)'}`
 * object; SDK `CreateCrawler.Schedule` is a bare cron string. cdkd
 * unwraps the CFn shape on create / update and re-wraps on
 * readCurrentState. Schedule START / STOP is exposed via separate
 * `StartCrawlerSchedule` / `StopCrawlerSchedule` calls (not part of
 * Update).
 *
 * `physicalId` is the crawler name.
 */
export class GlueCrawlerProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueCrawlerProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Crawler',
      new Set([
        'Name',
        'Role',
        'Targets',
        'DatabaseName',
        'Description',
        'Schedule',
        'Classifiers',
        'TablePrefix',
        'SchemaChangePolicy',
        'RecrawlPolicy',
        'LineageConfiguration',
        'LakeFormationConfiguration',
        'Configuration',
        'CrawlerSecurityConfiguration',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.stsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Crawler ${logicalId}`);
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const role = properties['Role'] as string | undefined;
    const targets = properties['Targets'] as Record<string, unknown> | undefined;
    if (!role) {
      throw new ProvisioningError(
        `Role is required for Glue Crawler ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!targets) {
      throw new ProvisioningError(
        `Targets is required for Glue Crawler ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    try {
      const tags = cfnTagsToMap(properties['Tags']);
      await this.getClient().send(
        new CreateCrawlerCommand({
          Name: name,
          Role: role,
          Targets: toSdkCrawlerTargets(targets),
          ...buildCrawlerCommonFields(properties),
          ...(tags && { Tags: tags }),
        })
      );
      this.logger.debug(`Successfully created Glue Crawler ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Crawler ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Crawler ${logicalId}: ${physicalId}`);
    try {
      const updateInput = {
        Name: physicalId,
        ...(properties['Role'] !== undefined && { Role: properties['Role'] as string }),
        ...(properties['Targets'] !== undefined && {
          Targets: toSdkCrawlerTargets(properties['Targets'] as Record<string, unknown>),
        }),
        ...buildCrawlerCommonFields(properties),
      };
      try {
        await this.getClient().send(new UpdateCrawlerCommand(updateInput));
      } catch (err) {
        // UpdateCrawler rejects a mid-run crawler with CrawlerRunningException.
        // Stop it, wait for it to settle, then retry the update.
        if (err instanceof CrawlerRunningException) {
          this.logger.debug(
            `Glue Crawler ${physicalId} is running; stopping before update and retrying`
          );
          await this.stopCrawlerAndWait(physicalId);
          await this.getClient().send(new UpdateCrawlerCommand(updateInput));
        } else {
          throw err;
        }
      }

      const oldTags = cfnTagsToMap(previousProperties['Tags']) ?? {};
      const newTags = cfnTagsToMap(properties['Tags']) ?? {};
      await this.applyTagDiff(physicalId, oldTags, newTags);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Crawler ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Crawler ${logicalId}: ${physicalId}`);
    try {
      await this.getClient().send(new DeleteCrawlerCommand({ Name: physicalId }));
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Crawler ${physicalId} does not exist, skipping deletion`);
        return;
      }
      // A crawler that is mid-run rejects DeleteCrawler with
      // CrawlerRunningException. Stop it, wait for it to settle, then retry the
      // delete so destroy does not fail on an actively-crawling crawler.
      if (error instanceof CrawlerRunningException) {
        this.logger.debug(
          `Glue Crawler ${physicalId} is running; stopping before delete and retrying`
        );
        await this.stopCrawlerAndWait(physicalId);
        await this.getClient().send(new DeleteCrawlerCommand({ Name: physicalId }));
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Crawler ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Stop a running crawler and poll until it leaves the RUNNING / STOPPING
   * state (or until {@link CRAWLER_STOP_MAX_ATTEMPTS} is exhausted). Tolerates a
   * CrawlerStoppingException / "not running" race (the crawler may have just
   * finished on its own) so callers can unconditionally retry their delete /
   * update afterwards.
   */
  private async stopCrawlerAndWait(physicalId: string): Promise<void> {
    try {
      await this.getClient().send(new StopCrawlerCommand({ Name: physicalId }));
    } catch (err) {
      // CrawlerNotRunningException / CrawlerStoppingException etc. mean the
      // crawler is already stopping or stopped — nothing to do but wait it out.
      this.logger.debug(
        `StopCrawler for ${physicalId} returned ${
          err instanceof Error ? err.name : String(err)
        }; continuing to wait`
      );
    }
    for (let attempt = 0; attempt < CRAWLER_STOP_MAX_ATTEMPTS; attempt++) {
      try {
        const cur = await this.getClient().send(new GetCrawlerCommand({ Name: physicalId }));
        const state = cur.Crawler?.State;
        if (state !== 'RUNNING' && state !== 'STOPPING') return;
      } catch (err) {
        if (err instanceof EntityNotFoundException) return;
        // Inconclusive read — keep polling until the attempt budget is gone.
      }
      await sleep(CRAWLER_STOP_POLL_INTERVAL_MS);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let crawler;
    try {
      const resp = await this.getClient().send(new GetCrawlerCommand({ Name: physicalId }));
      crawler = resp.Crawler;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!crawler) return undefined;

    const result: Record<string, unknown> = {
      Name: crawler.Name ?? physicalId,
      Role: crawler.Role ?? '',
      // SDK `DynamoDBTarget.{scanAll,scanRate}` -> the CFn `ScanAll` / `ScanRate`
      // spelling recorded in state, so drift compares like with like.
      Targets: crawler.Targets
        ? toCfnCrawlerTargets(pickDefined(crawler.Targets as Record<string, unknown>))
        : {},
      DatabaseName: crawler.DatabaseName ?? '',
      Description: crawler.Description ?? '',
      // CFn `Schedule` is the structured wrapper; reverse-map from the
      // SDK's `Schedule { ScheduleExpression, State }` Description shape.
      Schedule: crawler.Schedule?.ScheduleExpression
        ? { ScheduleExpression: crawler.Schedule.ScheduleExpression }
        : {},
      Classifiers: crawler.Classifiers ?? [],
      TablePrefix: crawler.TablePrefix ?? '',
      SchemaChangePolicy: crawler.SchemaChangePolicy
        ? pickDefined(crawler.SchemaChangePolicy as Record<string, unknown>)
        : {},
      RecrawlPolicy: crawler.RecrawlPolicy
        ? pickDefined(crawler.RecrawlPolicy as Record<string, unknown>)
        : {},
      LineageConfiguration: crawler.LineageConfiguration
        ? pickDefined(crawler.LineageConfiguration as Record<string, unknown>)
        : {},
      LakeFormationConfiguration: crawler.LakeFormationConfiguration
        ? pickDefined(crawler.LakeFormationConfiguration as Record<string, unknown>)
        : {},
      Configuration: crawler.Configuration ?? '',
      CrawlerSecurityConfiguration: crawler.CrawlerSecurityConfiguration ?? '',
    };
    result['Tags'] = await fetchGlueTags(
      this.getClient(),
      this.getStsClient(),
      'crawler',
      crawler.Name ?? physicalId,
      this.cachedAccountId,
      this.logger
    );
    return result;
  }

  /**
   * Start (or stop) a crawler's schedule. Exposed for downstream tooling
   * — not part of `update()` because AWS treats schedule activation as a
   * separate side-effect from crawler config update.
   */
  async startSchedule(physicalId: string): Promise<void> {
    await this.getClient().send(new StartCrawlerScheduleCommand({ CrawlerName: physicalId }));
  }
  async stopSchedule(physicalId: string): Promise<void> {
    await this.getClient().send(new StopCrawlerScheduleCommand({ CrawlerName: physicalId }));
  }

  private async applyTagDiff(
    physicalId: string,
    oldTags: Record<string, string>,
    newTags: Record<string, string>
  ): Promise<void> {
    const arn = await buildGlueResourceArn(
      this.getClient(),
      this.getStsClient(),
      'crawler',
      physicalId,
      this.cachedAccountId
    );
    const toAdd: Record<string, string> = {};
    const toRemove: string[] = [];
    for (const [k, v] of Object.entries(newTags)) {
      if (oldTags[k] !== v) toAdd[k] = v;
    }
    for (const k of Object.keys(oldTags)) {
      if (!(k in newTags)) toRemove.push(k);
    }
    if (Object.keys(toAdd).length > 0 || toRemove.length > 0) {
      const { TagResourceCommand, UntagResourceCommand } = await import('@aws-sdk/client-glue');
      if (Object.keys(toAdd).length > 0) {
        await this.getClient().send(new TagResourceCommand({ ResourceArn: arn, TagsToAdd: toAdd }));
      }
      if (toRemove.length > 0) {
        await this.getClient().send(
          new UntagResourceCommand({ ResourceArn: arn, TagsToRemove: toRemove })
        );
      }
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
    if (!explicitName) return null;
    try {
      await this.getClient().send(new GetCrawlerCommand({ Name: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}

// ─── helpers shared by GlueCrawlerProvider ──────────────────────────────

/**
 * Crawler optional fields shared by `CreateCrawler` and `UpdateCrawler`.
 * `Schedule` is the bare cron string at the SDK layer, but CFn wraps it
 * in `{ ScheduleExpression: '...' }`. cdkd unwraps here.
 */
function buildCrawlerCommonFields(p: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (p['DatabaseName'] !== undefined) r['DatabaseName'] = p['DatabaseName'] as string;
  if (p['Description'] !== undefined) r['Description'] = p['Description'] as string;
  if (p['Classifiers'] !== undefined) r['Classifiers'] = p['Classifiers'] as string[];
  if (p['TablePrefix'] !== undefined) r['TablePrefix'] = p['TablePrefix'] as string;
  if (p['Schedule'] !== undefined) {
    // Accept both the CFn structured shape and a bare string for forward-compat.
    const sched = p['Schedule'];
    if (typeof sched === 'string') {
      r['Schedule'] = sched;
    } else if (typeof sched === 'object' && sched !== null) {
      const wrap = sched as Record<string, unknown>;
      if (wrap['ScheduleExpression'] !== undefined) {
        r['Schedule'] = wrap['ScheduleExpression'] as string;
      }
    }
  }
  if (p['SchemaChangePolicy'] !== undefined) {
    r['SchemaChangePolicy'] = p['SchemaChangePolicy'] as SchemaChangePolicy;
  }
  if (p['RecrawlPolicy'] !== undefined) {
    r['RecrawlPolicy'] = p['RecrawlPolicy'] as RecrawlPolicy;
  }
  if (p['LineageConfiguration'] !== undefined) {
    r['LineageConfiguration'] = p['LineageConfiguration'] as LineageConfiguration;
  }
  if (p['LakeFormationConfiguration'] !== undefined) {
    r['LakeFormationConfiguration'] = p['LakeFormationConfiguration'] as LakeFormationConfiguration;
  }
  if (p['Configuration'] !== undefined) r['Configuration'] = p['Configuration'] as string;
  if (p['CrawlerSecurityConfiguration'] !== undefined) {
    r['CrawlerSecurityConfiguration'] = p['CrawlerSecurityConfiguration'] as string;
  }
  return r;
}

/**
 * CFn -> SDK key renames for `Targets.DynamoDBTargets[]`.
 *
 * The SDK's `DynamoDBTarget` is a lowercase island in an otherwise-PascalCase
 * model: `Path` is PascalCase but the scan-tuning members are `scanAll` /
 * `scanRate` (@aws-sdk/client-glue `models_0.d.ts` `DynamoDBTarget`), while CFn
 * spells them `ScanAll` / `ScanRate`. The AWS SDK v3 serializer drops unknown
 * members, so forwarding the CFn spelling silently loses the scan tuning while
 * the target itself (matched by `Path`) still reaches AWS. Every other
 * `CrawlerTargets` sub-type (`S3Target` / `JdbcTarget` / `MongoDBTarget` —
 * whose own `ScanAll` IS PascalCase — `CatalogTarget` / `DeltaTarget` /
 * `IcebergTarget` / `HudiTarget`) spells every member exactly as CFn does.
 */
const CFN_TO_SDK_DYNAMODB_TARGET_KEYS: Record<string, string> = {
  ScanAll: 'scanAll',
  ScanRate: 'scanRate',
};

/**
 * CFn is stringly typed, so a template (or an unresolved-then-resolved
 * intrinsic) can carry `ScanRate: "0.9"`. The SDK models it as a double and the
 * serializer forwards a string verbatim, so the value has to be coerced HERE —
 * this converter is the wire boundary for `Targets` now that it re-shapes the
 * blob. Non-numeric input passes through so AWS surfaces the real validation
 * error rather than cdkd mangling it.
 */
const SDK_DYNAMODB_TARGET_NUMERIC_KEYS: readonly string[] = ['scanRate'];

/**
 * Same stringly-typed-CFn reasoning as {@link SDK_DYNAMODB_TARGET_NUMERIC_KEYS},
 * for the boolean member: a hand-written `ScanAll: "false"` would otherwise
 * forward the STRING `"false"` — which is truthy — to a boolean member.
 */
const SDK_DYNAMODB_TARGET_BOOLEAN_KEYS: readonly string[] = ['scanAll'];

/** CFn booleans arrive as `true` / `false` or as the strings `"true"` / `"false"`. */
function coerceBoolean(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return value;
}

const SDK_TO_CFN_DYNAMODB_TARGET_KEYS: Record<string, string> = {
  scanAll: 'ScanAll',
  scanRate: 'ScanRate',
};

/**
 * Shallow-rename an object's keys per `renames`, leaving unlisted keys — and
 * non-object values (an unresolved intrinsic) — untouched.
 */
function renameRecordKeys(
  entry: unknown,
  renames: Record<string, string>,
  numericKeys: readonly string[] = [],
  booleanKeys: readonly string[] = []
): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
    const key = renames[k] ?? k;
    if (numericKeys.includes(key)) out[key] = coerceNumber(v);
    else if (booleanKeys.includes(key)) out[key] = coerceBoolean(v);
    else out[key] = v;
  }
  return out;
}

/**
 * Apply `renames` to every element of `targets[key]` when that entry is an
 * array, returning the original object untouched otherwise so a non-array value
 * reaches AWS verbatim and surfaces the real validation error.
 */
function renameCrawlerTargetList(
  targets: Record<string, unknown>,
  key: string,
  renames: Record<string, string>,
  numericKeys: readonly string[] = [],
  booleanKeys: readonly string[] = []
): Record<string, unknown> {
  const list = targets[key];
  if (!Array.isArray(list)) return targets;
  return {
    ...targets,
    [key]: list.map((entry) => renameRecordKeys(entry, renames, numericKeys, booleanKeys)),
  };
}

/**
 * Convert the CFn `AWS::Glue::Crawler.Targets` blob to the SDK `CrawlerTargets`
 * shape — see {@link CFN_TO_SDK_DYNAMODB_TARGET_KEYS} for the one divergence.
 */
function toSdkCrawlerTargets(targets: Record<string, unknown>): CrawlerTargets {
  return renameCrawlerTargetList(
    targets,
    'DynamoDBTargets',
    CFN_TO_SDK_DYNAMODB_TARGET_KEYS,
    SDK_DYNAMODB_TARGET_NUMERIC_KEYS,
    SDK_DYNAMODB_TARGET_BOOLEAN_KEYS
  ) as CrawlerTargets;
}

/**
 * Inverse of {@link toSdkCrawlerTargets}: re-shape a `GetCrawler` `Targets`
 * blob back into the CFn spelling so `cdkd drift` compares like with like
 * instead of reporting a phantom `ScanRate` removal + `scanRate` addition.
 */
function toCfnCrawlerTargets(targets: Record<string, unknown>): Record<string, unknown> {
  return renameCrawlerTargetList(targets, 'DynamoDBTargets', SDK_TO_CFN_DYNAMODB_TARGET_KEYS);
}

/**
 * SDK Provider for `AWS::Glue::Connection`.
 *
 * `physicalId` is the connection name. `ConnectionInput.ConnectionProperties`
 * is a free-form `Record<string, string>` (e.g. `JDBC_CONNECTION_URL`,
 * `USERNAME` for JDBC), surfaced as-is on read for state-shape parity.
 */
export class GlueConnectionProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueConnectionProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::Connection', new Set(['ConnectionInput', 'CatalogId'])],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Connection ${logicalId}`);
    const connectionInput = properties['ConnectionInput'] as Record<string, unknown> | undefined;
    if (!connectionInput) {
      throw new ProvisioningError(
        `ConnectionInput is required for Glue Connection ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const name = (connectionInput['Name'] as string | undefined) ?? logicalId;
    const catalogId = properties['CatalogId'] as string | undefined;
    try {
      await this.getClient().send(
        new CreateConnectionCommand({
          ...(catalogId && { CatalogId: catalogId }),
          ConnectionInput: buildConnectionInput(connectionInput, name),
        })
      );
      this.logger.debug(`Successfully created Glue Connection ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Connection ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Connection ${logicalId}: ${physicalId}`);
    const connectionInput = properties['ConnectionInput'] as Record<string, unknown> | undefined;
    if (!connectionInput) {
      throw new ProvisioningError(
        `ConnectionInput is required for Glue Connection update ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const catalogId = properties['CatalogId'] as string | undefined;
    try {
      await this.getClient().send(
        new UpdateConnectionCommand({
          ...(catalogId && { CatalogId: catalogId }),
          Name: physicalId,
          ConnectionInput: buildConnectionInput(connectionInput, physicalId),
        })
      );
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Connection ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Connection ${logicalId}: ${physicalId}`);
    // Same catalog-scoping rule as the Table / Database deletes — see
    // {@link deleteCatalogId} (issue #1675). This call already forwarded
    // `CatalogId`, but through a bare cast that would have sent an unresolved
    // intrinsic OBJECT to the API.
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
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        logCatalogScopedDeleteSkip(this.logger, target, 'Connection', logicalId, physicalId);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Connection ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
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
      if (err instanceof EntityNotFoundException) return undefined;
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
    return { ConnectionInput: ci };
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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

/**
 * SDK Provider for `AWS::Glue::Trigger`.
 *
 * Trigger has a state machine: `ACTIVATED` (running) ↔ `DEACTIVATED`
 * (paused). `UpdateTrigger` requires the trigger to be DEACTIVATED. If
 * the AWS-current state is ACTIVATED when an update is requested, this
 * provider:
 *   1. `StopTrigger` (DEACTIVATED).
 *   2. `UpdateTrigger`.
 *   3. `StartTrigger` (re-ACTIVATED) so the user-visible state is
 *      preserved across the update.
 *
 * `physicalId` is the trigger name. Tags are managed via the Glue
 * `GetTags` / `TagResource` / `UntagResource` API (not in
 * `TriggerUpdate`).
 */
export class GlueTriggerProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueTriggerProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Trigger',
      new Set([
        'Name',
        'Type',
        'Schedule',
        'Actions',
        'Predicate',
        'Description',
        'StartOnCreation',
        'EventBatchingCondition',
        'WorkflowName',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.stsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Trigger ${logicalId}`);
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const type = properties['Type'] as string | undefined;
    const actions = properties['Actions'] as TriggerAction[] | undefined;
    if (!type) {
      throw new ProvisioningError(
        `Type is required for Glue Trigger ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!actions) {
      throw new ProvisioningError(
        `Actions is required for Glue Trigger ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    try {
      const tags = cfnTagsToMap(properties['Tags']);
      await this.getClient().send(
        new CreateTriggerCommand({
          Name: name,
          Type: type as 'SCHEDULED' | 'CONDITIONAL' | 'ON_DEMAND' | 'EVENT',
          Actions: actions,
          ...(properties['Schedule'] !== undefined && {
            Schedule: properties['Schedule'] as string,
          }),
          ...(properties['Predicate'] !== undefined && {
            Predicate: properties['Predicate'] as Predicate,
          }),
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(properties['StartOnCreation'] !== undefined && {
            StartOnCreation: properties['StartOnCreation'] as boolean,
          }),
          ...(properties['WorkflowName'] !== undefined && {
            WorkflowName: properties['WorkflowName'] as string,
          }),
          ...(properties['EventBatchingCondition'] !== undefined && {
            EventBatchingCondition: properties['EventBatchingCondition'] as EventBatchingCondition,
          }),
          ...(tags && { Tags: tags }),
        })
      );
      this.logger.debug(`Successfully created Glue Trigger ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Trigger ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Trigger ${logicalId}: ${physicalId}`);
    try {
      // Glue requires the trigger be DEACTIVATED before UpdateTrigger. Read the
      // current state to decide whether we need to stop+restart.
      let restart = false;
      try {
        const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
        if (cur.Trigger?.State === 'ACTIVATED') {
          restart = true;
          await this.getClient().send(new StopTriggerCommand({ Name: physicalId }));
          // StopTrigger is async — UpdateTrigger fails if the trigger has not
          // yet transitioned out of ACTIVATED, so wait for DEACTIVATED first.
          await this.waitForTriggerDeactivated(physicalId);
        }
      } catch (err) {
        // If GetTrigger fails for any reason other than NotFound, fall
        // through and let UpdateTrigger surface a clear AWS error.
        if (!(err instanceof EntityNotFoundException)) {
          this.logger.debug(
            `GetTrigger pre-check failed for ${physicalId}; continuing anyway: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      const update: TriggerUpdate = {
        ...(properties['Description'] !== undefined && {
          Description: properties['Description'] as string,
        }),
        ...(properties['Schedule'] !== undefined && {
          Schedule: properties['Schedule'] as string,
        }),
        ...(properties['Actions'] !== undefined && {
          Actions: properties['Actions'] as TriggerAction[],
        }),
        ...(properties['Predicate'] !== undefined && {
          Predicate: properties['Predicate'] as Predicate,
        }),
        ...(properties['EventBatchingCondition'] !== undefined && {
          EventBatchingCondition: properties['EventBatchingCondition'] as EventBatchingCondition,
        }),
      };
      // Restore the ACTIVATED state even if UpdateTrigger throws — otherwise a
      // failed update would leave a previously-running trigger stuck
      // DEACTIVATED. Capture the update error rather than using `finally` so
      // that if BOTH the update and the re-activation throw, the root-cause
      // update error wins (a bare `finally` would let the secondary
      // "failed to re-activate" error mask it). A re-activation failure on an
      // OTHERWISE-successful update still surfaces (the trigger really is stuck
      // deactivated in that case).
      let updateError: unknown;
      try {
        await this.getClient().send(
          new UpdateTriggerCommand({ Name: physicalId, TriggerUpdate: update })
        );
      } catch (err) {
        updateError = err;
      }
      if (restart) {
        try {
          await this.getClient().send(new StartTriggerCommand({ Name: physicalId }));
        } catch (restartError) {
          if (updateError === undefined) throw restartError;
          this.logger.warn(
            `Failed to re-activate Glue Trigger ${physicalId} after a failed update: ${
              (restartError as Error).message
            }`
          );
        }
      }
      if (updateError !== undefined) throw updateError;

      const oldTags = cfnTagsToMap(previousProperties['Tags']) ?? {};
      const newTags = cfnTagsToMap(properties['Tags']) ?? {};
      await this.applyTagDiff(physicalId, oldTags, newTags);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Trigger ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Poll GetTrigger until the trigger leaves the ACTIVATED / ACTIVATING state
   * (StopTrigger is async). Returns once DEACTIVATED (or any non-active state)
   * is observed, the trigger is gone, or the attempt budget is exhausted —
   * callers then proceed with UpdateTrigger / DeleteTrigger.
   */
  private async waitForTriggerDeactivated(physicalId: string): Promise<void> {
    for (let attempt = 0; attempt < TRIGGER_DEACTIVATE_MAX_ATTEMPTS; attempt++) {
      try {
        const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
        const state = cur.Trigger?.State;
        if (state !== 'ACTIVATED' && state !== 'ACTIVATING') return;
      } catch (err) {
        if (err instanceof EntityNotFoundException) return;
        // Inconclusive read — keep polling until the budget is gone.
      }
      await sleep(TRIGGER_DEACTIVATE_POLL_INTERVAL_MS);
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Trigger ${logicalId}: ${physicalId}`);
    try {
      // An ACTIVATED scheduled / conditional trigger should be stopped before
      // deletion so a firing trigger does not race the delete.
      try {
        const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
        if (cur.Trigger?.State === 'ACTIVATED') {
          await this.getClient().send(new StopTriggerCommand({ Name: physicalId }));
          await this.waitForTriggerDeactivated(physicalId);
        }
      } catch (err) {
        // Pre-check is best-effort; if it fails for anything other than NotFound
        // (which DeleteTrigger handles below) let DeleteTrigger surface the error.
        if (!(err instanceof EntityNotFoundException)) {
          this.logger.debug(
            `GetTrigger pre-delete check failed for ${physicalId}; continuing: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      await this.getClient().send(new DeleteTriggerCommand({ Name: physicalId }));
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Trigger ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Trigger ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let trig;
    try {
      const resp = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
      trig = resp.Trigger;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!trig) return undefined;

    // Predicate.Conditions[]: AWS preserves the array order on read; we
    // surface entries as-is since cdkd state holds the same shape.
    const result: Record<string, unknown> = {
      Name: trig.Name ?? physicalId,
      Type: trig.Type ?? '',
      Schedule: trig.Schedule ?? '',
      Description: trig.Description ?? '',
      WorkflowName: trig.WorkflowName ?? '',
      Actions: (trig.Actions ?? []).map((a) =>
        pickDefined(a as unknown as Record<string, unknown>)
      ),
      Predicate: trig.Predicate
        ? {
            Logical: trig.Predicate.Logical ?? '',
            Conditions: (trig.Predicate.Conditions ?? []).map((c: TriggerCondition) =>
              pickDefined(c as unknown as Record<string, unknown>)
            ),
          }
        : {},
      EventBatchingCondition: trig.EventBatchingCondition
        ? pickDefined(trig.EventBatchingCondition as unknown as Record<string, unknown>)
        : {},
    };
    result['Tags'] = await fetchGlueTags(
      this.getClient(),
      this.getStsClient(),
      'trigger',
      trig.Name ?? physicalId,
      this.cachedAccountId,
      this.logger
    );
    return result;
  }

  private async applyTagDiff(
    physicalId: string,
    oldTags: Record<string, string>,
    newTags: Record<string, string>
  ): Promise<void> {
    const arn = await buildGlueResourceArn(
      this.getClient(),
      this.getStsClient(),
      'trigger',
      physicalId,
      this.cachedAccountId
    );
    const toAdd: Record<string, string> = {};
    const toRemove: string[] = [];
    for (const [k, v] of Object.entries(newTags)) {
      if (oldTags[k] !== v) toAdd[k] = v;
    }
    for (const k of Object.keys(oldTags)) {
      if (!(k in newTags)) toRemove.push(k);
    }
    if (Object.keys(toAdd).length > 0 || toRemove.length > 0) {
      const { TagResourceCommand, UntagResourceCommand } = await import('@aws-sdk/client-glue');
      if (Object.keys(toAdd).length > 0) {
        await this.getClient().send(new TagResourceCommand({ ResourceArn: arn, TagsToAdd: toAdd }));
      }
      if (toRemove.length > 0) {
        await this.getClient().send(
          new UntagResourceCommand({ ResourceArn: arn, TagsToRemove: toRemove })
        );
      }
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
    if (!explicitName) return null;
    try {
      await this.getClient().send(new GetTriggerCommand({ Name: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}
