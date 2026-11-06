import {
  CreateDatabaseCommand,
  UpdateDatabaseCommand,
  DeleteDatabaseCommand,
  GetDatabaseCommand,
  EntityNotFoundException,
  type DatabaseInput,
  type DatabaseIdentifier,
  type FederatedDatabase,
  type PrincipalPermissions,
  type DataLakePrincipal,
  type Permission,
} from '@aws-sdk/client-glue';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { createMaskedLogSinks, type MaskerFn } from '../../masked-retry-logger.js';
import {
  replayWarn,
  requireConfigArray,
  requireConfigObject,
  type ConfigArrayOptions,
} from '../../config-shape.js';
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
import { markNotGone } from '../../not-gone.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import type { GlueProvider } from '../glue-provider.js';
import {
  glueOperationSinks,
  secretNamePairs,
  previousNamePairs,
  refuseNestedRename,
  refuseCatalogMove,
  updateCatalogId,
} from './names.js';
import {
  asRecord,
  preUpdateReadFailureMessage,
  isSendableLeaf,
  emptyBlockMessage,
  TARGET_DATABASE_MEMBERS,
  FEDERATED_DATABASE_MEMBERS,
} from './shared.js';
import {
  deleteCatalogId,
  describeCatalog,
  logCatalogScopedDeleteSkip,
  importableString,
  catalogIdForApi,
} from './ids-catalog.js';
import { stringifyParameterValues } from './job.js';

// ─── AWS::Glue::Database ──────────────────────────────────────────

export async function createDatabase(
  this: GlueProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation, and every bag-derived value
  // masked RAW as well. Absent context means identity.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    secretNamePairs([
      asRecord(properties['DatabaseInput'])?.['Name'],
      properties['DatabaseName'],
      properties['CatalogId'],
    ])
  );
  const { value: v } = log;
  log.debug(`Creating Glue Database ${logicalId}`);

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
    await this.getCreateClient().send(
      new CreateDatabaseCommand({
        CatalogId: catalogId,
        // No `onUnusable` on an ordinary template-path create, so a
        // malformed nested block is REFUSED before the AWS call; a
        // reverse-replacement replay downgrades it to a warning, because the
        // desired bag is then a STATE record (issue #1463).
        DatabaseInput: this.buildDatabaseInput(databaseInput, databaseName, {
          ...replayWarn(log, context),
        }),
      })
    );

    log.debug(`Successfully created Glue Database ${logicalId}: ${v(databaseName)}`);

    return {
      physicalId: databaseName,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue Database ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function updateDatabase(
  this: GlueProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177 -- see `createDatabase()`. The recorded name is ALSO a needle
  // when the PREVIOUS value it came from is secret-derived: after a rotated or
  // re-pointed secret, that value is the `{{resolve:` reference state holds
  // and the OLD plaintext is in no masker bag of this deploy.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    previousNamePairs(physicalId, [
      asRecord(previousProperties?.['DatabaseInput'])?.['Name'],
      previousProperties?.['DatabaseName'],
    ])
  );
  const { value: v } = log;
  log.debug(`Updating Glue Database ${logicalId}: ${v(physicalId)}`);

  const databaseInput = properties['DatabaseInput'] as Record<string, unknown> | undefined;
  if (!databaseInput) {
    throw new ProvisioningError(
      `DatabaseInput is required for Glue Database update ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  refuseNestedRename({
    resourceType,
    logicalId,
    field: 'DatabaseInput.Name',
    noun: 'database',
    recordedName: physicalId,
    desiredName: databaseInput['Name'],
    foldCase: true,
    consequence: () =>
      `UpdateDatabase would address '${v(physicalId)}' with a different name inside its ` +
      `definition, and the state record would keep '${v(physicalId)}' whatever AWS did with it`,
    stateful: true,
    mask: log.mask,
  });
  await refuseCatalogMove({
    resourceType,
    logicalId,
    noun: 'database',
    entityName: physicalId,
    recorded: previousProperties?.['CatalogId'],
    desired: properties['CatalogId'],
    stateful: true,
    callerAccountId: this.callerAccountId,
    warn: log.warn,
    debug: log.debug,
    mask: log.mask,
  });

  const catalogId = updateCatalogId(properties['CatalogId']);

  const previousDatabaseInput = asRecord(previousProperties?.['DatabaseInput']);

  // Split on the ORIGIN of the desired bag (issue #3740, the #3728 shape).
  // On a TEMPLATE-path update a malformed `TargetDatabase` /
  // `FederatedDatabase` / `CreateTableDefaultPermissions` block is
  // template-borne, and `DatabaseInput` is mutable in place (only
  // `DatabaseName` is createOnly), so the template is where it gets fixed:
  // REFUSE, as `create()` does, before the first AWS call below (the
  // `GetDatabase` read) and so before `UpdateDatabase`. NOT gated on the
  // block having changed: `UpdateDatabase` replaces `DatabaseInput`
  // wholesale, so every declared block is sent on every update — an
  // unchanged malformed one would be retained from a previous side that is
  // just as unusable, and DROPPED, which erases the live block. The two
  // state-borne callers keep the warning and the retain-previous ladder —
  // the rollback executor's revert arms (`replayingState`) and
  // `cdkd drift --revert` (`desiredFromAwsReadback`) — because refusing a bag
  // the user cannot edit from the template would leave the database
  // un-rollbackable. The build is pure, so it moves ahead of the read; the
  // messages it raises name the block and the value's TYPE, never the value.
  const stateBorneDesired =
    context?.replayingState === true || context?.desiredFromAwsReadback === true;
  let builtDatabaseInput: DatabaseInput;
  try {
    builtDatabaseInput = this.buildDatabaseInput(databaseInput, physicalId, {
      ...(stateBorneDesired && {
        onUnusable: log.warn,
      }),
      previousDatabaseInput,
    });
  } catch (error) {
    // Outside the `try` below, so the refusal is not re-labelled as an AWS
    // update failure. Only the template path reaches here: given the warn
    // callback, every arm of the builder warns instead of throwing.
    throw new ProvisioningError(
      `${v(describeAwsFailure(error).detail)}. Nothing was applied to ` +
        `Glue Database ${logicalId}; fix the template value`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }

  // Read-merge-write for AWS-authored `DatabaseInput.Parameters` — see
  // {@link preserveAwsManagedParameters}. The read sits outside the `try`,
  // because it raises a typed `ProvisioningError` the catch wrapper below
  // would re-label.
  const liveParameters = await this.readLiveDatabaseParameters(
    logicalId,
    resourceType,
    physicalId,
    catalogId,
    log.mask
  );

  try {
    this.preserveAwsManagedParameters(
      builtDatabaseInput,
      databaseInput['Parameters'],
      previousDatabaseInput?.['Parameters'],
      liveParameters
    );

    await this.getClient().send(
      new UpdateDatabaseCommand({
        ...(catalogId !== undefined && { CatalogId: catalogId }),
        Name: physicalId,
        DatabaseInput: builtDatabaseInput,
      })
    );

    log.debug(`Successfully updated Glue Database ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Glue Database ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteDatabase(
  this: GlueProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#2007: the name can be secret-derived.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  log.debug(`Deleting Glue Database ${logicalId}: ${log.value(physicalId)}`);

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
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      logCatalogScopedDeleteSkip(log, target, 'Database', logicalId, log.value(physicalId));
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue Database ${logicalId}: ${text}`,
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
export async function readLiveDatabaseParameters(
  this: GlueProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  catalogId: string | undefined,
  mask: MaskerFn
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
    throw this.wrapMaskedError(
      mask,
      error,
      (detail) =>
        new ProvisioningError(
          preUpdateReadFailureMessage('Database', 'glue:GetDatabase', logicalId, detail),
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        )
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
 *
 * `options` carries the shape-guard policy for the three nested blocks added
 * by issue #1807, and the two call sites answer differently because their
 * desired bag has a different provenance (`.claude/rules/providers.md`):
 *
 *   - CREATE passes NO `onUnusable`, so a malformed block is REFUSED before
 *     the AWS call — the value is template-borne, and the alternative is
 *     sending an empty `{}` block AWS would reject with a far less
 *     actionable message. Under `CreateContext.replayingState` the refusal
 *     downgrades through the shared `replayWarn`, since a reverse-replacement
 *     re-create reads a STATE record the user cannot edit from the template.
 *   - UPDATE splits on the desired bag's ORIGIN (issue #3740). A
 *     template-path update passes NO `onUnusable` and so REFUSES like
 *     CREATE, before any AWS call. The state-borne callers — the rollback
 *     revert arms (`UpdateContext.replayingState`) and `drift --revert`
 *     (`desiredFromAwsReadback`) — pass a warn callback, and the builder
 *     then RETAINS the PREVIOUS side's block, which is why
 *     `previousDatabaseInput` is threaded in. Omitting instead would ERASE a
 *     live resource link, because `UpdateDatabase` replaces `DatabaseInput`
 *     wholesale — the #1612 "UPDATE retains the previous value" row, reached
 *     here through a whole-blob API rather than a per-item one. When the
 *     previous side is unusable too the key is DROPPED: there is no value
 *     cdkd can vouch for either way (#1653 review).
 */
export function buildDatabaseInput(
  this: GlueProvider,
  databaseInput: Record<string, unknown>,
  fallbackName: string,
  options?: {
    onUnusable?: ((message: string) => void) | undefined;
    previousDatabaseInput?: Record<string, unknown> | undefined;
  }
): DatabaseInput {
  // A guard with no callback THROWS; `replayWarn` / a state-borne update
  // supply one. Spread rather than passed as `{ onUnusable: undefined }`, because
  // the guards branch on the KEY being present.
  const guardOptions = options?.onUnusable ? { onUnusable: options.onUnusable } : undefined;
  const previous = options?.previousDatabaseInput;
  /**
   * The record a nested block is BUILT FROM: the desired side when it names
   * at least one sendable member, else the previous side when IT does, else
   * nothing.
   *
   * The emptiness test is what makes the ladder complete, and getting it
   * wrong is how the first cut of this guard still erased a live resource
   * link: a bare `{}` and an unresolved `{Ref: ...}` are plain OBJECTS, so
   * the shape guard accepts them and a `?? previous` fallback never fires —
   * the block then built empty and `UpdateDatabase`, which replaces
   * `DatabaseInput` wholesale, dropped a link the template still declared.
   *
   * A member counts as sendable only when it is a STRING or a NUMBER: the
   * leaf casts below are unchecked, so an intrinsic-valued `DatabaseName`
   * would otherwise put an OBJECT on the wire — the same defect one level in.
   */
  const pickBlockSource = (
    desiredRaw: unknown,
    previousRaw: unknown,
    path: string,
    block: string,
    members: readonly string[]
  ): Record<string, unknown> | undefined => {
    // Usable means EVERY declared member that is present is sendable, AND at
    // least one is. `some` alone was the silent-narrowing shape this guard
    // exists to refuse (both re-reviewers found it): one literal member would
    // license the block while an intrinsic-valued sibling was dropped with no
    // message, so `{DatabaseName: 'src', CatalogId: {Ref: 'Acct'}}` shipped
    // WITHOUT `CatalogId` — a cross-account resource link silently retargeted
    // at the caller's own catalog. It also made the guard's strictness depend
    // on siblings: `{CatalogId: {Ref}}` alone was refused, the same value next
    // to a literal `DatabaseName` was not.
    const namesSendable = (bag: Record<string, unknown> | undefined): boolean => {
      if (bag === undefined) return false;
      const present = members.filter((m) => bag[m] !== undefined);
      return present.length > 0 && present.every((m) => isSendableLeaf(bag[m]));
    };
    const desired = guardOptions
      ? requireConfigObject(desiredRaw, path, guardOptions)
      : requireConfigObject(desiredRaw, path);
    if (namesSendable(desired)) return desired;
    if (desired !== undefined) {
      // Right SHAPE, nothing cdkd can send. Same ladder as a wrong shape.
      const message = emptyBlockMessage(block);
      if (options?.onUnusable) options.onUnusable(message);
      else throw new Error(message);
    }
    const retained = asRecord(previousRaw);
    return namesSendable(retained) ? retained : undefined;
  };
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

  // `TargetDatabase` (resource links), `FederatedDatabase` (an entity outside
  // the Glue Data Catalog) and `CreateTableDefaultPermissions` (Lake Formation
  // defaults) complete the CFn `DatabaseInput` member set. Until issue #1807
  // this builder named only Description / LocationUri / Parameters, so a
  // template setting any of the three deployed "successfully" as a plain empty
  // database — no error, no warning, and nothing for `cdkd drift` to report
  // because `readDatabase` did not surface them either.
  //
  // Every member is named INDIVIDUALLY rather than cast through verbatim
  // (both spellings agree, so a cast would typecheck). The shape was chosen
  // for the nested-key critic's write pass, which could only see per-member
  // writes; that pass was retired by issue #3723.
  if (databaseInput['TargetDatabase'] !== undefined) {
    const target = pickBlockSource(
      databaseInput['TargetDatabase'],
      previous?.['TargetDatabase'],
      'AWS::Glue::Database DatabaseInput.TargetDatabase',
      'TargetDatabase',
      TARGET_DATABASE_MEMBERS
    );
    if (target !== undefined) {
      const targetDatabase: DatabaseIdentifier = {};
      if (isSendableLeaf(target['CatalogId'])) {
        targetDatabase.CatalogId = String(target['CatalogId']);
      }
      if (isSendableLeaf(target['DatabaseName'])) {
        targetDatabase.DatabaseName = String(target['DatabaseName']);
      }
      if (isSendableLeaf(target['Region'])) {
        targetDatabase.Region = String(target['Region']);
      }
      result.TargetDatabase = targetDatabase;
    }
  }

  if (databaseInput['FederatedDatabase'] !== undefined) {
    const federated = pickBlockSource(
      databaseInput['FederatedDatabase'],
      previous?.['FederatedDatabase'],
      'AWS::Glue::Database DatabaseInput.FederatedDatabase',
      'FederatedDatabase',
      FEDERATED_DATABASE_MEMBERS
    );
    if (federated !== undefined) {
      const federatedDatabase: FederatedDatabase = {};
      if (isSendableLeaf(federated['ConnectionName'])) {
        federatedDatabase.ConnectionName = String(federated['ConnectionName']);
      }
      if (isSendableLeaf(federated['Identifier'])) {
        federatedDatabase.Identifier = String(federated['Identifier']);
      }
      // The SDK also declares `ConnectionType`, which the CFn schema does not,
      // so no template can set it and it is deliberately not mapped.
      result.FederatedDatabase = federatedDatabase;
    }
  }

  if (databaseInput['CreateTableDefaultPermissions'] !== undefined) {
    const permissions =
      this.usableDefaultPermissions(databaseInput['CreateTableDefaultPermissions'], guardOptions) ??
      this.usableDefaultPermissions(previous?.['CreateTableDefaultPermissions'], {
        // The PREVIOUS side is validated with the SAME predicate (#1653
        // review) but SILENTLY: the desired side has already warned, and a
        // second message about a historical record helps nobody.
        onUnusable: () => undefined,
      });
    if (permissions !== undefined) {
      result.CreateTableDefaultPermissions = permissions.map((entry) => {
        const permission: PrincipalPermissions = {};
        if (entry['Permissions'] !== undefined) {
          permission.Permissions = entry['Permissions'] as Permission[];
        }
        const declaredPrincipal = asRecord(entry['Principal']);
        if (declaredPrincipal !== undefined) {
          const principal: DataLakePrincipal = {};
          if (isSendableLeaf(declaredPrincipal['DataLakePrincipalIdentifier'])) {
            // Coerced like every other leaf: the entry guard accepts a NUMBER
            // (CFn is stringly typed), and the SDK member is a string.
            principal.DataLakePrincipalIdentifier = String(
              declaredPrincipal['DataLakePrincipalIdentifier']
            );
          }
          permission.Principal = principal;
        }
        return permission;
      });
    }
  }

  return result;
}

/**
 * `DatabaseInput.CreateTableDefaultPermissions` as a USABLE list, or
 * `undefined` when the declared value is a shape cdkd refuses to narrow.
 *
 * The block is validated ALL-OR-NOTHING rather than per entry, which is the
 * opposite of the S3 per-`Id` appliers and deliberate: this is a Lake
 * Formation grant list delivered by ONE wholesale `CreateDatabase` /
 * `UpdateDatabase` call, so dropping the entries cdkd cannot read would
 * silently NARROW the permissions the template declared — the failure this
 * guard exists to prevent, one level in from the block itself. A malformed
 * ENTRY therefore invalidates the block, and the caller then refuses (create)
 * or retains the previous list (update).
 *
 * `Permissions` is checked for ARRAY-ness for the same reason: the SDK member
 * is `Permission[]`, so a bare string would be forwarded verbatim and the
 * serializer would drop it, granting nothing while the deploy reports success.
 */
export function usableDefaultPermissions(
  this: GlueProvider,
  value: unknown,
  guardOptions?: ConfigArrayOptions
): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const path = 'AWS::Glue::Database DatabaseInput.CreateTableDefaultPermissions';
  const entries = guardOptions
    ? requireConfigArray(value, path, guardOptions)
    : requireConfigArray(value, path);
  if (entries === undefined) return undefined;

  for (const entry of entries) {
    // `entries` is typed as records but is only ARRAY-checked, so an entry
    // can be `null` or a scalar: read `Principal` off the guarded record,
    // or a `[null]` list throws a raw TypeError past the warn ladder.
    const record = asRecord(entry);
    const principal = asRecord(record?.['Principal']);
    const usable =
      record !== undefined &&
      (entry['Permissions'] !== undefined || entry['Principal'] !== undefined) &&
      (entry['Permissions'] === undefined || Array.isArray(entry['Permissions'])) &&
      // A `Principal` naming no sendable identifier is the empty-block defect
      // one level in: it would ride an unchecked cast onto the wire as `{}`.
      (entry['Principal'] === undefined ||
        (principal !== undefined && isSendableLeaf(principal['DataLakePrincipalIdentifier'])));
    if (usable) continue;
    const detail = `${path} carries an entry cdkd cannot read (each entry must be an object naming Permissions as a list and/or Principal as an object whose DataLakePrincipalIdentifier is a string or a number)`;
    if (guardOptions?.onUnusable) {
      guardOptions.onUnusable(
        `${detail}. Leaving the whole block unapplied rather than sending a NARROWED grant list. ` +
          `On an UPDATE that is a RESET: UpdateDatabase replaces DatabaseInput wholesale, so ` +
          `unless a usable previous list is retained the database falls back to the account default ` +
          `(IAM_ALLOWED_PRINCIPALS / ALL) until a readable list restores the declared grants`
      );
      return undefined;
    }
    throw new Error(detail);
  }
  return entries;
}

export async function readDatabase(
  this: GlueProvider,
  physicalId: string,
  catalogId?: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
    if (err instanceof EntityNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!db) return undefined;

  const dbInput: Record<string, unknown> = {};
  if (db.Name !== undefined) dbInput['Name'] = db.Name;
  dbInput['Description'] = db.Description ?? '';
  if (db.LocationUri !== undefined) dbInput['LocationUri'] = db.LocationUri;
  dbInput['Parameters'] = db.Parameters ?? {};
  // The three members the write side gained with issue #1807, reverse-mapped
  // so `cdkd drift` can see them at all. EMIT-WHEN-PRESENT rather than the
  // always-emit placeholder Description / Parameters use: AWS reports a
  // Lake Formation DEFAULT for `CreateTableDefaultPermissions` on databases
  // whose template never declared one (`IAM_ALLOWED_PRINCIPALS` / `ALL` on a
  // catalog that has not been onboarded to Lake Formation), and a placeholder
  // would have to invent one of the two shapes and be wrong on the other
  // population.
  //
  // That AWS default is ALSO why emitting it is not enough on its own: on the
  // `observedProperties` baseline the comparator walks the key UNION
  // (`unionWalkObjects`), so a record written before this member was read
  // would report the default as drift. `getDriftUnknownPaths` scopes the path
  // out PER RESOURCE for a database whose template declares no block — see
  // its JSDoc; only the `properties`-fallback baseline is covered by the
  // comparator's own baseline-keys-only rule.
  //
  // The always-emitted `Description: ''` placeholder is safe next to a
  // resource link, which is not obvious: AWS REFUSES a database carrying both
  // a description and a `TargetDatabase`. Measured us-east-1 2026-08-13 — the
  // refusal is on a NON-EMPTY description; `Description: ''` is accepted on
  // both `CreateDatabase` and `UpdateDatabase` alongside a link (and reads
  // back as null), so the `cdkd drift --revert` round-trip through this
  // readback does not trip it.
  if (db.TargetDatabase !== undefined) {
    dbInput['TargetDatabase'] = { ...db.TargetDatabase };
  }
  if (db.FederatedDatabase !== undefined) {
    dbInput['FederatedDatabase'] = { ...db.FederatedDatabase };
  }
  if (db.CreateTableDefaultPermissions !== undefined) {
    dbInput['CreateTableDefaultPermissions'] = db.CreateTableDefaultPermissions.map((entry) => ({
      ...entry,
    }));
  }
  // CFn schema accepts BOTH nested `DatabaseInput.Name` AND top-level
  // `DatabaseName` (see #613 B-bucket fix in createDatabase). Surface
  // both so drift comparison works for either template shape.
  const result: Record<string, unknown> = { DatabaseInput: dbInput };
  if (db.Name !== undefined) result['DatabaseName'] = db.Name;
  return result;
}

export async function importDatabase(
  this: GlueProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
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

export const databaseMethods = {
  createDatabase,
  updateDatabase,
  deleteDatabase,
  readLiveDatabaseParameters,
  buildDatabaseInput,
  usableDefaultPermissions,
  readDatabase,
  importDatabase,
};
