import {
  CreateTableCommand,
  UpdateTableCommand,
  DeleteTableCommand,
  EntityNotFoundException,
  ConcurrentModificationException,
  type TableInput,
  type OpenTableFormatInput,
  type StorageDescriptor,
} from '@aws-sdk/client-glue';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { compositeIdSkipResult } from '../../composite-id.js';
import { createMaskedLogSinks } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { markNotGone } from '../../not-gone.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import type { GlueProvider } from '../glue-provider.js';
import {
  glueOperationSinks,
  secretNamePairs,
  describeUnresolvedName,
  previousNamePairs,
  refuseNestedRename,
  refuseCatalogMove,
  updateCatalogId,
} from './names.js';
import {
  asRecord,
  enforceIcebergTableInputAbsent,
  findIcebergTableInputKey,
  icebergTableInputRefusalMessage,
  withoutFinalPeriod,
} from './shared.js';
import {
  decodeTableId,
  tableIdDecodeFailure,
  deleteCatalogId,
  describeCatalog,
  logCatalogScopedDeleteSkip,
} from './ids-catalog.js';
import { parameterKeySet } from './job.js';

// ─── AWS::Glue::Table ─────────────────────────────────────────────

export async function createTable(
  this: GlueProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177 -- see `createDatabase()`.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    secretNamePairs([
      properties['DatabaseName'],
      asRecord(properties['TableInput'])?.['Name'],
      properties['Name'],
      properties['CatalogId'],
    ])
  );
  const { value: v } = log;
  log.debug(`Creating Glue Table ${logicalId}`);

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
    warn: log.warn,
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

  // The id is `<databaseName>|<tableName>`, and EITHER name may contain `|`,
  // as CloudFormation allows: Glue accepts it in a table name (probe,
  // us-east-1 2026-08-12, issue #1672) and in a database name (probe through
  // the `glue-update-hardening` fixture, 2026-09-28, issue #3892). The id is
  // therefore not split by any reader. The provider's decode sites
  // (`decodeTableId`) and the `Ref` resolver (`glueTableRefFromPhysicalId`)
  // place the table name by the recorded `DatabaseName` — which this create
  // always records as a resolved string. Without a usable anchor the decode
  // sites read only an id with exactly one `|` and SKIP or refuse anything
  // longer, and `Ref` reports a masked anchor as a redacted read. So nothing
  // is refused here and nothing is packed through `packCompositeId`.
  // `import()` pairs a `|`-bearing name with the template's own
  // `DatabaseName` for the same reason (`resolveTableIdentity`).
  //
  // Both names must be STRINGS: the reads above are unvalidated casts, and a
  // template can put an array or object there (`Name: ['a|b']` is truthy and
  // passes the presence checks). Stringified into the id it would record a
  // value no reader can place, and `CreateTable` rejects it anyway — so this
  // refuses on every path, a state replay included: no replay of such a
  // value could have succeeded.
  for (const [field, value] of [
    ['DatabaseName', databaseName],
    ['TableInput.Name', tableName],
  ] as const) {
    if (typeof value !== 'string') {
      throw new ProvisioningError(
        `Glue Table ${logicalId}: ${field} must be a string, got ` +
          `${describeUnresolvedName(value, log.mask)}. Set it to the ${field === 'DatabaseName' ? 'database' : 'table'} name.`,
        resourceType,
        logicalId
      );
    }
  }
  const physicalId = `${databaseName}|${tableName}`;

  try {
    await this.getCreateClient().send(
      new CreateTableCommand({
        CatalogId: catalogId,
        DatabaseName: databaseName,
        TableInput: this.buildTableInput(tableInput, tableName),
        ...(openTableFormatInput !== undefined && {
          OpenTableFormatInput: openTableFormatInput as OpenTableFormatInput,
        }),
      })
    );

    log.debug(`Successfully created Glue Table ${logicalId}: ${v(databaseName)}|${v(tableName)}`);

    return {
      physicalId,
      attributes: {},
    };
  } catch (error) {
    // An `AlreadyExistsException` (an occupied table address) is relayed
    // like any other failure, so the engine's collision classifier sees it
    // (issue #3932). Who holds the address is the engine's question, not
    // this provider's: a rename, a `DatabaseName` or a `CatalogId` change
    // moves it (#3750), and the engine's holder proof
    // (`replacement-name-holder/name-keys.ts`, keyed by the name and scoped
    // by `DatabaseName` and `CatalogId`) refuses `--replace` for those, while
    // a replacement that keeps the address — a top-level `Name` change —
    // takes the `--replace` delete-first recovery.
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue Table ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function updateTable(
  this: GlueProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const decoded = decodeTableId(physicalId, previousProperties, properties);
  // Issue #2177 -- see `updateDatabase()`. Both halves of the recorded id are
  // needles when the previous value each came from is secret-derived.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    decoded
      ? [
          ...previousNamePairs(decoded.databaseName, [previousProperties?.['DatabaseName']]),
          ...previousNamePairs(decoded.tableName, [
            asRecord(previousProperties?.['TableInput'])?.['Name'],
            previousProperties?.['Name'],
          ]),
        ]
      : // No halves to place: the WHOLE recorded id is the needle when any
        // name it can have come from is secret-derived.
        previousNamePairs(physicalId, [
          previousProperties?.['DatabaseName'],
          asRecord(previousProperties?.['TableInput'])?.['Name'],
          previousProperties?.['Name'],
        ])
  );
  const { value: v } = log;
  // Each half RAW when the id decodes: the joined id is longer than either
  // secret, so only a per-half mask reaches one below the substring floor.
  const shownId = decoded ? `${v(decoded.databaseName)}|${v(decoded.tableName)}` : v(physicalId);
  log.debug(`Updating Glue Table ${logicalId}: ${shownId}`);

  if (!decoded) {
    throw new ProvisioningError(
      tableIdDecodeFailure(logicalId, physicalId, [previousProperties, properties], {
        mask: log.mask,
      }),
      resourceType,
      logicalId,
      physicalId
    );
  }
  const { databaseName, tableName } = decoded;

  const tableInput = properties['TableInput'] as Record<string, unknown> | undefined;
  if (!tableInput) {
    throw new ProvisioningError(
      `TableInput is required for Glue Table update ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // Before the pre-read: `readLiveTableState` reads the RECORDED table, and
  // its `VersionId` would then ride an `UpdateTable` aimed at another one.
  refuseNestedRename({
    resourceType,
    logicalId,
    field: 'TableInput.Name',
    noun: 'table',
    recordedName: tableName,
    desiredName: tableInput['Name'],
    foldCase: true,
    consequence: (desired) =>
      `UpdateTable addresses the table by TableInput.Name, so it would write to the table ` +
      `named '${desired}' in database '${v(databaseName)}' (possibly one cdkd ` +
      `does not manage) while the state record kept '${v(tableName)}'`,
    stateful: true,
    mask: log.mask,
  });
  await refuseCatalogMove({
    resourceType,
    logicalId,
    noun: 'table',
    // Each half masked RAW: the joined name is longer than either secret.
    entityName: `${v(databaseName)}.${v(tableName)}`,
    recorded: previousProperties?.['CatalogId'],
    desired: properties['CatalogId'],
    stateful: true,
    callerAccountId: this.callerAccountId,
    warn: log.warn,
    debug: log.debug,
    mask: log.mask,
  });

  const catalogId = updateCatalogId(properties['CatalogId']);

  // UPDATE only WARNS where create REFUSES, and the asymmetry is deliberate.
  //
  // Rollback restores a resource from cdkd STATE, not from the template
  // (`rollback-executor/replay-revert.ts` calls `provider.update(..., op.previousState.properties)`).
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
  // Kept as a warning on the TEMPLATE path too (re-decided in issue #3740,
  // now that `UpdateContext` can tell a template push from a replay): unlike
  // the `DatabaseInput` split in `updateDatabase`, no template edit makes the
  // declared value land in place — nothing is sent for it on update, whatever
  // its shape — so the only fix for the declared intent is a replacement.
  //
  // The other rollback arm is covered too, since issue #1463:
  // `replayRollback`'s reverse-replacement path revives the OLD resource by
  // calling `create()` with `previousState.properties`, and it now passes
  // `CreateContext.replayingState` so the create-side pre-flight downgrades
  // to the same warning instead of failing that rollback operation.
  const updateIcebergKey = findIcebergTableInputKey(properties);
  if (updateIcebergKey !== undefined) {
    log.warn(icebergTableInputRefusalMessage(logicalId, updateIcebergKey, 'update'));
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
    catalogId,
    log.mask
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

    log.debug(`Successfully updated Glue Table ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // A `ConcurrentModificationException` means someone else changed the
    // table under us. Say so explicitly — the generic wrap would leave the
    // user staring at a bare SDK error with no hint that a concurrent
    // Iceberg commit is the likely cause and that a re-run is the fix.
    //
    // The wording is gated on whether cdkd actually attached the `VersionId`
    // precondition. Without one, AWS raised this on its own and claiming
    // "cdkd refused" would be a lie about our own behavior.
    let hint = '';
    if (error instanceof ConcurrentModificationException) {
      hint +=
        `. Another writer changed the table between cdkd's pre-update read and its ` +
        `UpdateTable call.`;
      hint +=
        live.versionId !== undefined
          ? ` cdkd sent the version it read (${live.versionId}) as a precondition and AWS ` +
            `rejected the write, rather than let it put back the AWS-managed Parameters and ` +
            `StorageDescriptor members read a moment earlier — which for an Apache Iceberg ` +
            `table would have pinned it to an older metadata_location (an effective snapshot ` +
            `rollback).`
          : ` AWS returned no VersionId on the pre-update read, so cdkd could not attach a ` +
            `precondition; AWS rejected the write on its own.`;
      hint += ` Re-run the deploy to pick up the current values.`;
    }
    throw this.wrapMaskedError(
      log.mask,
      error,
      (detail) =>
        new ProvisioningError(
          // Each half brings its own sentence end: a redacted `detail` ends
          // in a period and `hint` opens with one.
          `Failed to update Glue Table ${logicalId}: ${hint ? withoutFinalPeriod(detail) : detail}${hint}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteTable(
  this: GlueProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#2007: the name can be secret-derived.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  // Each `<database>|<table>` part masked as a VALUE, so a part below the
  // masker's substring floor is caught too.
  const shownId = physicalId
    .split('|')
    .map((part) => log.value(part))
    .join('|');
  log.debug(`Deleting Glue Table ${logicalId}: ${shownId}`);

  // The bag's `DatabaseName` only DISAMBIGUATES the id; it never stands in
  // for one. An id that does not start with it and is not an exact
  // two-segment composite still skips, since deleting a table named by the
  // bag rather than by the record risks deleting one cdkd never created.
  const decoded = decodeTableId(physicalId, properties);
  if (!decoded) {
    this.logger.warn(
      tableIdDecodeFailure(logicalId, physicalId, [properties], {
        skipping: true,
        mask: log.mask,
      })
    );
    // Issue #1752: report the SKIP rather than returning void. A bare
    // `return` here is indistinguishable from a completed delete, so the
    // destroy summary counted this table as deleted while it stayed alive.
    return compositeIdSkipResult();
  }
  const { databaseName, tableName } = decoded;

  // `CatalogId` must be threaded here or the delete silently targets this
  // account's DEFAULT Data Catalog — see {@link deleteCatalogId} for the leak
  // this closes (issue #1675). `createTable` and `importTable` both forward
  // it; this call omitted it.
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
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      logCatalogScopedDeleteSkip(log, target, 'Table', logicalId, shownId);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue Table ${logicalId}: ${text}`,
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
 * position (docs/provider-rules.md#update-removal-semantics-clear-on-removal, issue #1155): a removal the
 * user expressed in the template still reaches AWS. Glue's update APIs are
 * full-replace, so removal needs no explicit reset sentinel — omitting the
 * key IS the reset, and the only thing this helper adds back is the set of
 * keys the user never authored in the first place. The generalized rule for
 * any full-replace update API lives in
 * docs/provider-rules.md#full-replace-update-apis-erase-aws-authored-values.
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
export function preserveAwsManagedParameters(
  this: GlueProvider,
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
export function preserveAwsManagedStorageDescriptor(
  this: GlueProvider,
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
    for (const [member, liveValue] of Object.entries(liveSd.SerdeInfo as Record<string, unknown>)) {
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

export const tableWriteMethods = {
  createTable,
  updateTable,
  deleteTable,
  preserveAwsManagedParameters,
  preserveAwsManagedStorageDescriptor,
};
