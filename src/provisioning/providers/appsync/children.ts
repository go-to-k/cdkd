import {
  CreateDataSourceCommand,
  DeleteDataSourceCommand,
  CreateResolverCommand,
  DeleteResolverCommand,
  StartSchemaCreationCommand,
  type DataSourceType,
  type CreateDataSourceCommandInput,
  type CreateResolverCommandInput,
} from '@aws-sdk/client-appsync';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  compositeIdFormatMessage,
  compositeIdSkipResult,
  packCompositeId,
} from '../../composite-id.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
} from '../../../types/resource.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import { APPSYNC_DATASOURCE_ID_FORMAT, APPSYNC_RESOLVER_ID_FORMAT } from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

// ─── AWS::AppSync::GraphQLSchema ───────────────────────────────────

export async function createGraphQLSchema(
  this: AppSyncProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating GraphQL Schema ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required for GraphQLSchema ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const definition = properties['Definition'] as string | undefined;
  const definitionS3Location = properties['DefinitionS3Location'];

  try {
    if (definition) {
      // Inline wins when both are present — same precedence as the
      // Resolver *S3Location pairs (see resolveInlineOrS3Template).
      if (definitionS3Location !== undefined) {
        this.logger.warn(
          `${resourceType} ${logicalId}: both Definition and DefinitionS3Location are set — ` +
            'using the inline Definition and ignoring DefinitionS3Location (CFn treats them as alternatives)'
        );
      }
      await this.getClient().send(
        new StartSchemaCreationCommand({
          apiId,
          definition: new TextEncoder().encode(definition),
        })
      );
    } else if (definitionS3Location !== undefined) {
      // CloudFormation fetches the S3 object and submits its BODY as the
      // SDL — StartSchemaCreation has no S3-URL member. Same fetch helper
      // as the Resolver *S3Location properties (#609).
      const body = await this.fetchS3LocationBody(
        definitionS3Location,
        resourceType,
        logicalId,
        'DefinitionS3Location',
        maskerOrIdentity(context?.maskSecrets)
      );
      await this.getClient().send(
        new StartSchemaCreationCommand({
          apiId,
          definition: new TextEncoder().encode(body),
        })
      );
    }

    this.logger.debug(`Successfully started schema creation for ${logicalId}`);

    // Schema is tied to the API, use apiId as physical ID
    return {
      physicalId: apiId,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create GraphQL Schema ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

// ─── AWS::AppSync::DataSource ──────────────────────────────────────

export async function createDataSource(
  this: AppSyncProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating DataSource ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  const name = properties['Name'] as string;
  const type = properties['Type'] as DataSourceType;

  if (!apiId || !name || !type) {
    throw new ProvisioningError(
      `ApiId, Name, and Type are required for DataSource ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Refuse a `|` in either segment BEFORE `CreateDataSource` runs (issue
  // #1672). `Name` is the only segment cdkd's own guards would let through as
  // an arbitrary string — it is user-chosen, where `ApiId` is AWS-generated —
  // but that is NOT the same as saying AWS accepts a `|` in it: AppSync
  // documents the field as `[_A-Za-z][_0-9A-Za-z]*`, and unlike the Glue
  // sibling this has NOT been probed live, so treat the guard as
  // defense-in-depth rather than a measured hazard. Computed here so the
  // refusal cannot orphan a data source AWS has already created.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'apiId', value: apiId },
      { name: 'name', value: name },
    ],
    // A reverse-replacement rollback creates from a STATE record, so the
    // refusal downgrades to a warning — no template edit can repair a value
    // recorded by an older binary.
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

  let reportedArn: string | undefined;
  try {
    const input: CreateDataSourceCommandInput = {
      apiId,
      name,
      type,
    };

    // Shared with updateDataSource so create and update cannot diverge.
    this.applyDataSourceConfig(
      input,
      resourceType,
      logicalId,
      properties,
      maskerOrIdentity(context?.maskSecrets)
    );

    const response = await this.getClient().send(new CreateDataSourceCommand(input));
    // Recorded, not consumed, inside the try — see the return below.
    reportedArn = response.dataSource?.dataSourceArn;

    this.logger.debug(`Successfully created DataSource ${logicalId}: ${physicalId}`);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create DataSource ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }

  // OUTSIDE the try, and non-throwing: the data source EXISTS from here on.
  // Placement alone only stops the failure being MIS-LABELLED as a creation
  // failure — `create()` would still throw, and a failed CREATE journals no
  // physicalId, so the rollback executor would skip it and leave the resource
  // in AWS invisible to state (the issue #1710 class). `buildAppSyncArnOrWarn`
  // is what actually closes that: the ARN is bookkeeping, the resource is
  // already real, so a failure warns and omits rather than failing the create.
  const dataSourceArn =
    reportedArn ??
    (await this.buildAppSyncArnOrWarn(`apis/${apiId}/datasources/${name}`, logicalId, physicalId));
  return {
    physicalId,
    attributes: {
      // CFn's `Ref` AND `Fn::GetAtt DataSourceArn` both return the data
      // source ARN `.../apis/<apiId>/datasources/<name>` (docs-verified
      // 2026-08-12). `CreateDataSource` reports the real one, so take it
      // verbatim rather than string-building; see `buildAppSyncArn` for why
      // the fallback exists and what the pre-#1681 placeholder broke.
      ...(dataSourceArn !== undefined && { DataSourceArn: dataSourceArn }),
      Name: name,
    },
  };
}

export async function deleteDataSource(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting DataSource ${logicalId}: ${physicalId}`);

  const [apiId, name] = physicalId.split('|');
  if (!apiId || !name) {
    this.logger.warn(
      compositeIdFormatMessage(APPSYNC_DATASOURCE_ID_FORMAT, logicalId, physicalId, {
        skipping: true,
      })
    );
    // Issue #1752: report the SKIP rather than returning void — a bare
    // `return` was counted as a successful delete by the destroy summary.
    return compositeIdSkipResult();
  }

  try {
    await this.getClient().send(new DeleteDataSourceCommand({ apiId, name }));
    this.logger.debug(`Successfully deleted DataSource ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`DataSource ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete DataSource ${logicalId}: ${text}`,
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

// ─── AWS::AppSync::Resolver ────────────────────────────────────────

export async function createResolver(
  this: AppSyncProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Resolver ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  const typeName = properties['TypeName'] as string;
  const fieldName = properties['FieldName'] as string;

  if (!apiId || !typeName || !fieldName) {
    throw new ProvisioningError(
      `ApiId, TypeName, and FieldName are required for Resolver ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Refuse a `|` in any segment BEFORE `CreateResolver` runs (issue #1672).
  // `TypeName` / `FieldName` are the user-chosen pair (`ApiId` is
  // AWS-generated), but both are GraphQL identifiers — `[_A-Za-z][_0-9A-Za-z]*`
  // by the spec — so a `|` should be rejected upstream of cdkd and this
  // guard is unverified defense-in-depth, not a measured hazard like the Glue
  // sibling. Computed here so the refusal cannot orphan a resolver AWS has
  // already created.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'apiId', value: apiId },
      { name: 'typeName', value: typeName },
      { name: 'fieldName', value: fieldName },
    ],
    // A reverse-replacement rollback creates from a STATE record, so the
    // refusal downgrades to a warning.
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

  let reportedArn: string | undefined;
  try {
    const input: CreateResolverCommandInput = {
      apiId,
      typeName,
      fieldName,
    };

    // Shared with updateResolver so create and update cannot diverge
    // (incl. the Kind discriminator gating and the *S3Location fetches).
    await this.applyResolverConfig(
      input,
      resourceType,
      logicalId,
      properties,
      undefined,
      false,
      maskerOrIdentity(context?.maskSecrets)
    );

    const response = await this.getClient().send(new CreateResolverCommand(input));
    // Recorded, not consumed, inside the try — see the return below.
    reportedArn = response.resolver?.resolverArn;

    this.logger.debug(`Successfully created Resolver ${logicalId}: ${physicalId}`);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Resolver ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }

  // OUTSIDE the try, and non-throwing — see `createDataSource` for the full
  // reasoning (issue #1710: a throw after a successful create orphans the
  // resource, and placement alone does not prevent that).
  const resolverArn =
    reportedArn ??
    (await this.buildAppSyncArnOrWarn(
      `apis/${apiId}/types/${typeName}/resolvers/${fieldName}`,
      logicalId,
      physicalId
    ));
  return {
    physicalId,
    attributes: {
      // CFn's `Ref` AND `Fn::GetAtt ResolverArn` both return the resolver
      // ARN `.../apis/<apiId>/types/<type>/resolvers/<field>`
      // (docs-verified 2026-08-12); `CreateResolver` reports the real one.
      ...(resolverArn !== undefined && { ResolverArn: resolverArn }),
    },
  };
}

export async function deleteResolver(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting Resolver ${logicalId}: ${physicalId}`);

  const parts = physicalId.split('|');
  if (parts.length < 3) {
    this.logger.warn(
      compositeIdFormatMessage(APPSYNC_RESOLVER_ID_FORMAT, logicalId, physicalId, {
        skipping: true,
      })
    );
    // Issue #1752: report the SKIP rather than returning void — a bare
    // `return` was counted as a successful delete by the destroy summary.
    return compositeIdSkipResult();
  }
  const [apiId, typeName, fieldName] = parts;

  try {
    await this.getClient().send(new DeleteResolverCommand({ apiId, typeName, fieldName }));
    this.logger.debug(`Successfully deleted Resolver ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Resolver ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Resolver ${logicalId}: ${text}`,
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
