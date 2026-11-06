import { safeMsg } from '../../../utils/display-safe.js';
import {
  GetTableCommand,
  EntityNotFoundException,
  type TableInput,
  type StorageDescriptor,
  type Column,
  type Order,
  type SerDeInfo,
  type SkewedInfo,
  type SchemaReference,
  type TableIdentifier,
  type ViewDefinitionInput,
} from '@aws-sdk/client-glue';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { logicalIdShown } from '../../composite-id.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  isPlainImportValue,
  isQuotableImportValue,
  quotedRemedyLogicalId,
  VALUE_NOT_SHOWN,
} from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import type { GlueProvider } from '../glue-provider.js';
import { preUpdateReadFailureMessage, asRecord, coerceNumber } from './shared.js';
import { stringifyParameterValues } from './job.js';
import {
  decodeTableId,
  importableString,
  catalogIdForApi,
  type TableReading,
} from './ids-catalog.js';
import { resolveTableIdentity } from './names.js';

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
export async function readLiveTableState(
  this: GlueProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  databaseName: string,
  tableName: string,
  catalogId: string | undefined,
  mask: MaskerFn
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
    throw this.wrapMaskedError(
      mask,
      error,
      (detail) =>
        new ProvisioningError(
          preUpdateReadFailureMessage('Table', 'glue:GetTable', logicalId, detail),
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        )
    );
  }
}

/**
 * Build TableInput for Glue API from CFn template properties
 */
export function buildTableInput(
  this: GlueProvider,
  tableInput: Record<string, unknown>,
  fallbackName: string
): TableInput {
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
export function buildStorageDescriptor(
  this: GlueProvider,
  sd: Record<string, unknown>
): StorageDescriptor {
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

export async function readTable(
  this: GlueProvider,
  physicalId: string,
  catalogId?: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const decoded = decodeTableId(physicalId, properties);
  if (!decoded) return undefined;
  const { databaseName, tableName } = decoded;

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
    if (err instanceof EntityNotFoundException) return RESOURCE_NOT_FOUND;
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
    tableInput['StorageDescriptor'] = table.StorageDescriptor as unknown as Record<string, unknown>;
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

export async function importTable(
  this: GlueProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
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
        // Says what to change rather than suggesting another id: the only ids
        // that would work are the ones this message names. `|` is cdkd's own
        // separator (see `createTable`); AWS accepts it in a Glue name even
        // though the Athena convention does not.
        this.logger.warn(
          `AWS::Glue::Table ${input.logicalId}: cannot be imported because the '|' in a name ` +
            `cannot be placed. cdkd records this type's physical id as ` +
            `<databaseName>|<tableName>, with '|' as the separator: a name containing '|' is ` +
            `adopted only with the template's own DatabaseName (which is how cdkd later tells ` +
            `the two apart). Set the template's DatabaseName to the table's database, or ` +
            `manage this resource outside cdkd.`
        );
        break;
      case 'unpairable': {
        // Ends in a `--resource` remedy, so the logical id and the supplied
        // id are shown only when plain (a `|` is literal inside cdkd's
        // `'...'`), and the fragment names the logical id only when plain
        // (go-to-k/cdkd#4273): inside cdkd's own quotes, a `'` in either
        // closed them and the rest of a pasted line ran.
        const supplied = input.knownPhysicalId ?? '';
        this.logger.warn(
          `AWS::Glue::Table ${logicalIdShown(input.logicalId)}: cannot resolve a database for physical id ` +
            `${isQuotableImportValue(supplied) ? `'${supplied}'` : VALUE_NOT_SHOWN}. ` +
            (input.knownPhysicalId === ''
              ? `The supplied physical id is empty. `
              : `The template's DatabaseName is absent or is an unresolved intrinsic, so ` +
                `the bare table name cannot be paired. `) +
            `Pass the composite form instead: ` +
            `--resource '${quotedRemedyLogicalId(input.logicalId)}=<databaseName>|<tableName>' ` +
            `(quote it — '|' is a shell pipe).`
        );
        break;
      }
      case 'unidentified':
        // Nothing named the table at all. The caller already prints the
        // `--resource` hint for this case, so a second message would be noise.
        break;
    }
    return null;
  }

  // Probe EVERY reading, then adopt only an unambiguous one. Adopting the
  // first that exists would take the two-segment composite `(a, b)` for
  // CloudFormation's bare `a|b` whenever an unrelated table `b` happens to
  // exist in a database `a`, and the recorded `a|b` would then round-trip to
  // that other table — which `cdkd destroy` deletes. A non-not-found error is
  // an unknown answer, never "absent", so it stops the walk.
  const found: TableReading[] = [];
  for (const candidate of identity.candidates) {
    try {
      await this.getClient().send(
        new GetTableCommand({
          DatabaseName: candidate.databaseName,
          Name: candidate.tableName,
          ...(catalogId && { CatalogId: catalogId }),
        })
      );
      found.push(candidate);
    } catch (err) {
      if (err instanceof EntityNotFoundException) continue;
      // A lone reading keeps the AWS error as it was. With several, say WHICH
      // reading could not be answered — a bare-name probe the user never asked
      // for can hit a Lake Formation denial the reading they meant would not —
      // and still FAIL CLOSED: adopting another reading while this one is
      // unknown could take the wrong table. Named by error CLASS, not AWS's
      // message, which can quote the account and role; the original rides as
      // `cause`.
      if (identity.candidates.length === 1 || !(err instanceof Error)) throw err;
      throw new ProvisioningError(
        safeMsg`AWS::Glue::Table ${input.logicalId}: could not check whether table ${candidate.tableName} exists in database ${candidate.databaseName} (the ${candidate.reading} reading of physical id ${input.knownPhysicalId ?? ''}): ${err.name}. cdkd does not adopt a table while another reading of the id is unanswered. Grant glue:GetTable on that table and database, then re-run.`,
        'AWS::Glue::Table',
        input.logicalId,
        undefined,
        err
      );
    }
  }
  // More than one reading exists: the template's own `TableInput.Name`
  // settles it when exactly one of them carries it. (With a single reading
  // the id wins over the template name, as an explicit override always has.)
  const chosen =
    found.length > 1 && templateTableName !== undefined
      ? found.filter((pair) => pair.tableName === templateTableName)
      : found;
  if (chosen.length > 1 || (found.length > 1 && chosen.length === 0)) {
    // The remedies are the two inputs that settle it, NOT a re-spelled id:
    // any id with a `|` is read the same several ways again (the #1651 shape,
    // where the suggested remedy is the thing being refused).
    //
    // Ends in a `--resource` remedy, so every value on the line is shown
    // only when inert and described otherwise (go-to-k/cdkd#4273). The
    // table name is the supplied id or one of its segments, which in auto
    // mode is CloudFormation's physical id and so the template's
    // `TableInput.Name`; the database name is the template's `DatabaseName`.
    // GetTable only confirmed a table of that spelling exists, and Glue
    // accepts `'`, `;` and `$(` in a name. Inside cdkd's `'...'` a `|` is
    // literal, so a genuine separator-bearing table name is still shown; the
    // database name prints bare and must be plain, and also free of `,`
    // (`displayIdent`'s `listMember` rule), since this list is
    // `, `-joined and `a,b` would read as two entries.
    const existing = found
      .map(
        (pair) =>
          `${isQuotableImportValue(pair.tableName) ? `'${pair.tableName}'` : VALUE_NOT_SHOWN} in ` +
          (isPlainImportValue(pair.databaseName) && !pair.databaseName.includes(',')
            ? pair.databaseName
            : VALUE_NOT_SHOWN)
      )
      .join(', ');
    this.logger.warn(
      safeMsg`AWS::Glue::Table ${logicalIdShown(input.logicalId)}: cannot be imported because its physical id names more than one existing table (${existing}). Set the template's TableInput.Name to the table this resource is, which settles it. For a table whose own name starts with '<databaseName>|', you can instead pass --resource '${quotedRemedyLogicalId(input.logicalId)}=<databaseName>|<databaseName>|<rest of the name>'.`
    );
    return null;
  }
  const adopted = chosen[0];
  if (adopted === undefined) return null;
  // Always normalize to cdkd's composite form: `updateTable` /
  // `deleteTable` / `readTable` all decode the stored physicalId as
  // `<db>|<table>` ({@link decodeTableId}), so recording CloudFormation's
  // bare table name would adopt the resource into a state record the rest of
  // the provider cannot use — trading a visible not-found for a silent one.
  // That is the #1658 failure mode (`AWS::Route53::RecordSet` accepted CFn's
  // id verbatim and the stack became undestroyable). The composite is built
  // from the pair actually PROBED. A `|` in either name is only ever paired
  // with the template's `DatabaseName`, which later readers anchor on — provided
  // the recorded bag carries it resolved; when `cdkd import` cannot resolve
  // it, a three-segment record has no anchor and destroy SKIPS it (loudly,
  // keeping the record) rather than guessing.
  const physicalId = `${adopted.databaseName}|${adopted.tableName}`;
  // An id with more than one `|` is read only by anchoring on `DatabaseName`.
  // `cdkd import` records the TEMPLATE's bag, where that property can stay an
  // unresolved intrinsic, so the probed database also rides as an attribute:
  // the `Ref` resolver reads `properties` then `attributes`. (The decode sites
  // read only `properties`; without it they skip such a record loudly.)
  const needsAnchor = physicalId.indexOf('|') !== physicalId.lastIndexOf('|');
  return {
    physicalId,
    attributes: needsAnchor ? { DatabaseName: adopted.databaseName } : {},
  };
}

export const tableReadMethods = {
  readLiveTableState,
  buildTableInput,
  buildStorageDescriptor,
  readTable,
  importTable,
};
