import {
  StartSchemaCreationCommand,
  UpdateDataSourceCommand,
  UpdateResolverCommand,
  UpdateApiKeyCommand,
  type DataSourceType,
  type UpdateDataSourceCommandInput,
  type UpdateResolverCommandInput,
  type UpdateApiKeyCommandInput,
} from '@aws-sdk/client-appsync';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { compositeIdFormatMessage } from '../../composite-id.js';
import type { ResourceUpdateResult } from '../../../types/resource.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import {
  APPSYNC_DATASOURCE_ID_FORMAT,
  APPSYNC_RESOLVER_ID_FORMAT,
  APPSYNC_APIKEY_ID_FORMAT,
  displayApiKeyPhysicalId,
  graphQLSchemaApiId,
  withApiKeyMasked,
} from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

export async function updateGraphQLSchema(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: MaskerFn = maskerOrIdentity(undefined)
): Promise<ResourceUpdateResult> {
  // An `ApiId` change is refused BEFORE the definition comparison: the
  // schema would otherwise be left on the old API whenever the SDL is
  // unchanged, a silent success (go-to-k/cdkd#5359). CloudFormation fails
  // this update too (measured: the change set says no replacement, and the
  // update ends `Internal Failure` and rolls back, with or without a
  // definition change), so cdkd does not move it in place. The physical id
  // names the API id, so it decides a secret-derived `ApiId` (go-to-k/cdkd#4275).
  const recordedApiId = graphQLSchemaApiId(physicalId);
  if (
    properties['ApiId'] !== undefined &&
    previousProperties['ApiId'] !== undefined &&
    properties['ApiId'] !== previousProperties['ApiId'] &&
    !(await unchangedBehindSecretReference({
      resourceType,
      key: 'ApiId',
      desired: properties['ApiId'],
      previous: previousProperties['ApiId'],
      physicalName: recordedApiId,
      maskSecrets: mask,
    }))
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'AWS AppSync GraphQLSchema.ApiId cannot move a schema to another API in place ' +
        '(CloudFormation fails a template change of it too) — deploy with --replace, or give the ' +
        'schema a new logical ID, to create it on the new API'
    );
  }

  // ApiId is immutable identity — physicalId tracks it. The mutable
  // surface is `Definition` (the SDL body) or its S3-sourced sibling
  // `DefinitionS3Location`. `StartSchemaCreation` re-uploads the SDL;
  // AWS rebuilds the schema asynchronously. `DefinitionS3Location` is
  // write-only (see getDriftUnknownPaths) and not round-trippable, so its
  // diff is on the URL: a changed URL re-fetches and re-uploads, an
  // unchanged URL is a no-op even if the S3 object content changed (CFn
  // parity — the template did not change, and CDK assets bake the content
  // hash into the key anyway). Inline `Definition` wins when both are set,
  // matching the create path.
  const newDef = properties['Definition'] as string | undefined;
  const oldDef = previousProperties['Definition'] as string | undefined;
  const newLoc = properties['DefinitionS3Location'];
  const oldLoc = previousProperties['DefinitionS3Location'];

  let definition: string | undefined;
  if (newDef !== undefined) {
    if (newLoc !== undefined) {
      // Same both-set warning the create path emits — inline wins.
      this.logger.warn(
        `${resourceType} ${logicalId}: both Definition and DefinitionS3Location are set — ` +
          'using the inline Definition and ignoring DefinitionS3Location (CFn treats them as alternatives)'
      );
    }
    if (newDef === oldDef) {
      return { physicalId, wasReplaced: false };
    }
    definition = newDef;
  } else if (newLoc !== undefined) {
    if (this.deepEqual(newLoc, oldLoc)) {
      return { physicalId, wasReplaced: false };
    }
    definition = await this.fetchS3LocationBody(
      newLoc,
      resourceType,
      logicalId,
      'DefinitionS3Location',
      mask
    );
  } else {
    return { physicalId, wasReplaced: false };
  }

  const apiId = (properties['ApiId'] ?? recordedApiId) as string;
  try {
    await this.getClient().send(
      new StartSchemaCreationCommand({
        apiId,
        definition: Buffer.from(definition, 'utf-8'),
      })
    );
  } catch (error) {
    throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'GraphqlSchema', mask);
  }
  return { physicalId, wasReplaced: false };
}

export async function updateDataSource(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: MaskerFn
): Promise<ResourceUpdateResult> {
  // Identity fields are immutable: ApiId / Name. Reject diffs in
  // defense-in-depth against a missing replacement-rule entry. A
  // secret-derived value is recorded as its `{{resolve:...}}` reference and
  // handed here resolved, which is no change: the `<apiId>|<name>` physical
  // id decides ApiId and Name instead (go-to-k/cdkd#4275).
  const [idApiId, idName] = physicalId.split('|');
  for (const field of ['ApiId', 'Name'] as const) {
    const next = properties[field];
    const prev = previousProperties[field];
    if (
      next !== undefined &&
      prev !== undefined &&
      next !== prev &&
      !(await unchangedBehindSecretReference({
        resourceType,
        key: field,
        desired: next,
        previous: prev,
        physicalName: field === 'ApiId' ? idApiId : idName,
        maskSecrets: mask,
      }))
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS AppSync DataSource.${field} is immutable — destroy + redeploy to change`
      );
    }
  }

  const [apiId, name] = physicalId.split('|');
  if (!apiId || !name) {
    throw new ProvisioningError(
      compositeIdFormatMessage(APPSYNC_DATASOURCE_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }

  // `UpdateDataSource` REQUIRES `apiId`, `name`, and `type` on every call.
  // `Type` is mutable in place: CloudFormation changes it with
  // `UpdateDataSource` and keeps the data source (go-to-k/cdkd#5359,
  // measured: NONE to HTTP, same ARN). The recorded value fills a desired
  // bag that carries none.
  const type = (properties['Type'] ?? previousProperties['Type']) as DataSourceType;

  // Present-on-either-side AND differs, so a REMOVAL (defined -> undefined)
  // still fires the call. `UpdateDataSource` is a FULL-REPLACE write: the
  // input below carries the whole desired config, and a member the
  // template dropped is simply omitted — AppSync clears it server-side, so
  // no reset sentinel is needed (see `applyDataSourceConfig`).
  const mutableKeys = [
    'Type',
    'Description',
    'ServiceRoleArn',
    'DynamoDBConfig',
    'LambdaConfig',
    'HttpConfig',
    'ElasticsearchConfig',
    'OpenSearchServiceConfig',
    'EventBridgeConfig',
    'RelationalDatabaseConfig',
    'MetricsConfig',
  ] as const;

  const wantUpdate = mutableKeys.some(
    (key) =>
      (key in properties || key in previousProperties) &&
      !this.deepEqual(properties[key], previousProperties[key])
  );

  if (!wantUpdate) {
    return this.childUpdateResult(resourceType, physicalId, mask);
  }

  const input: UpdateDataSourceCommandInput = {
    apiId,
    name,
    type,
  };
  // Shared with createDataSource so create and update cannot diverge.
  this.applyDataSourceConfig(input, resourceType, logicalId, properties, mask);

  try {
    await this.getClient().send(new UpdateDataSourceCommand(input));
  } catch (error) {
    throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'DataSource', mask);
  }

  return this.childUpdateResult(resourceType, physicalId, mask);
}

export async function updateResolver(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: MaskerFn
): Promise<ResourceUpdateResult> {
  // Identity fields are immutable: ApiId / TypeName / FieldName. A
  // secret-derived value is recorded as its `{{resolve:...}}` reference and
  // handed here resolved, which is no change: the
  // `<apiId>|<typeName>|<fieldName>` physical id decides instead
  // (go-to-k/cdkd#4275).
  const identity = physicalId.split('|');
  for (const [index, field] of (['ApiId', 'TypeName', 'FieldName'] as const).entries()) {
    const next = properties[field];
    const prev = previousProperties[field];
    if (
      next !== undefined &&
      prev !== undefined &&
      next !== prev &&
      !(await unchangedBehindSecretReference({
        resourceType,
        key: field,
        desired: next,
        previous: prev,
        physicalName: identity.length === 3 ? identity[index] : undefined,
      }))
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS AppSync Resolver.${field} is immutable — destroy + redeploy to change`
      );
    }
  }

  const parts = physicalId.split('|');
  if (parts.length < 3) {
    throw new ProvisioningError(
      compositeIdFormatMessage(APPSYNC_RESOLVER_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }
  const [apiId, typeName, fieldName] = parts;

  // Present-on-either-side AND differs, so a REMOVAL (defined -> undefined)
  // still fires the call. `UpdateResolver` is a FULL-REPLACE write — an
  // omitted member is cleared server-side — so no reset sentinels are
  // needed (see `applyResolverConfig`). An `*S3Location` URL change fires
  // an update too; an unchanged URL whose S3 OBJECT content changed is not
  // detected (CFn parity: the template did not change, and CDK assets bake
  // the content hash into the key anyway).
  const mutableKeys = [
    'DataSourceName',
    'RequestMappingTemplate',
    'ResponseMappingTemplate',
    'Kind',
    'PipelineConfig',
    'Runtime',
    'Code',
    'CachingConfig',
    'SyncConfig',
    'MaxBatchSize',
    'MetricsConfig',
    'CodeS3Location',
    'RequestMappingTemplateS3Location',
    'ResponseMappingTemplateS3Location',
  ] as const;

  const wantUpdate = mutableKeys.some(
    (key) =>
      (key in properties || key in previousProperties) &&
      !this.deepEqual(properties[key], previousProperties[key])
  );

  if (!wantUpdate) {
    return this.childUpdateResult(resourceType, physicalId, mask);
  }

  const input: UpdateResolverCommandInput = {
    apiId: apiId as string,
    typeName: typeName as string,
    fieldName: fieldName as string,
  };

  // Shared with createResolver so create and update cannot diverge; the
  // `Kind` discriminator gating (never forward `dataSourceName` on a
  // PIPELINE resolver) lives inside the mapper, with the state-recorded
  // previous `Kind` as the fallback. Same shape as readCurrentState's
  // discriminator handling per memory rule
  // feedback_always_emit_check_type_discriminator.
  await this.applyResolverConfig(
    input,
    resourceType,
    logicalId,
    properties,
    previousProperties,
    true,
    mask
  );

  try {
    await this.getClient().send(new UpdateResolverCommand(input));
  } catch (error) {
    throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'Resolver', mask);
  }

  return this.childUpdateResult(resourceType, physicalId, mask);
}

export async function updateApiKey(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: MaskerFn
): Promise<ResourceUpdateResult> {
  // ApiId is immutable identity. A secret-derived one is recorded as its
  // `{{resolve:...}}` reference and handed here resolved, which is no
  // change: the `<apiId>|<keyId>` physical id decides (go-to-k/cdkd#4275).
  if (
    properties['ApiId'] !== undefined &&
    previousProperties['ApiId'] !== undefined &&
    properties['ApiId'] !== previousProperties['ApiId'] &&
    !(await unchangedBehindSecretReference({
      resourceType,
      key: 'ApiId',
      desired: properties['ApiId'],
      previous: previousProperties['ApiId'],
      physicalName: physicalId.split('|')[0],
    }))
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'AWS AppSync ApiKey.ApiId is immutable — destroy + redeploy to change'
    );
  }

  const [apiId, apiKeyId] = physicalId.split('|');
  if (!apiId || !apiKeyId) {
    throw new ProvisioningError(
      compositeIdFormatMessage(
        APPSYNC_APIKEY_ID_FORMAT,
        logicalId,
        // The key segment is the credential (go-to-k/cdkd#5860).
        displayApiKeyPhysicalId(physicalId)
      ),
      resourceType,
      logicalId,
      physicalId
    );
  }

  const newDesc = properties['Description'] as string | undefined;
  const oldDesc = previousProperties['Description'] as string | undefined;
  const newExp = properties['Expires'] as number | undefined;
  const oldExp = previousProperties['Expires'] as number | undefined;

  if (newDesc === oldDesc && newExp === oldExp) {
    return this.childUpdateResult(resourceType, physicalId, mask);
  }

  const input: UpdateApiKeyCommandInput = {
    apiId,
    id: apiKeyId,
  };
  if (newDesc !== undefined) input.description = newDesc;
  if (newExp !== undefined) input.expires = newExp;

  try {
    await this.getClient().send(new UpdateApiKeyCommand(input));
  } catch (error) {
    // AWS's text may quote the key back (go-to-k/cdkd#5860).
    throw this.wrapUpdateError(
      error,
      resourceType,
      logicalId,
      physicalId,
      'ApiKey',
      withApiKeyMasked(mask, apiKeyId)
    );
  }

  return this.childUpdateResult(resourceType, physicalId, mask);
}
