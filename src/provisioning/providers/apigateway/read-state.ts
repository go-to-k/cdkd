import type { ApiGatewayProvider } from '../apigateway-provider.js';
import {
  GetAccountCommand,
  GetResourceCommand,
  GetDeploymentCommand,
  GetStageCommand,
  GetMethodCommand,
  GetAuthorizerCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  type CfnStageMethodSetting,
  METHOD_SETTING_PATCH_FIELDS,
  methodSettingKey,
} from './shared.js';

/**
 * Authorizer `ProviderARNs` and Method `AuthorizationScopes` are unordered:
 * the update path diffs them as multisets ({@link listPatchOps}) and sends
 * nothing for a reorder, and AWS returns them in append order, so a
 * template reorder would otherwise read as drift that `--revert` can never
 * clear on the template-`properties` baseline (go-to-k/cdkd#5408).
 */
/**
 * Method `AuthorizationScopes` is a set on the update path (see
 * `updateMethod`), so a repeated scope is compared once: a template
 * declaring `['a', 'a']` against a live `['a']` is not drift
 * (go-to-k/cdkd#5408). Pure; returns the input when nothing applies.
 */
export function canonicalizeDriftProperties(
  this: ApiGatewayProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::ApiGateway::Method') return properties;
  const scopes = properties['AuthorizationScopes'];
  if (!Array.isArray(scopes) || new Set(scopes).size === scopes.length) return properties;
  return { ...properties, AuthorizationScopes: [...new Set(scopes)] };
}

export function getDriftUnorderedPaths(this: ApiGatewayProvider, resourceType: string): string[] {
  if (resourceType === 'AWS::ApiGateway::Authorizer') return ['ProviderARNs'];
  if (resourceType === 'AWS::ApiGateway::Method') return ['AuthorizationScopes'];
  return [];
}

/**
 * Read the AWS-current API Gateway resource configuration in CFn-property
 * shape.
 *
 * **Coverage**:
 *   - `AWS::ApiGateway::Account` → `GetAccount` for `CloudWatchRoleArn`.
 *   - `AWS::ApiGateway::Method` → `GetMethod`. PhysicalId is the composite
 *     `restApiId|resourceId|httpMethod`, so we have everything needed
 *     without `Properties`.
 *   - `AWS::ApiGateway::Authorizer` / `Resource` / `Deployment` / `Stage`:
 *     each uses `properties.RestApiId` (passed through PR G's signature
 *     extension) to issue the appropriate `Get*` call.
 */
export async function readCurrentState(
  this: ApiGatewayProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::ApiGateway::Account':
      return this.readCurrentStateAccount();
    case 'AWS::ApiGateway::Method':
      return this.readCurrentStateMethod(physicalId);
    case 'AWS::ApiGateway::Authorizer':
      return this.readCurrentStateAuthorizer(physicalId, properties);
    case 'AWS::ApiGateway::Resource':
      return this.readCurrentStateResource(physicalId, properties);
    case 'AWS::ApiGateway::Deployment':
      return this.readCurrentStateDeployment(physicalId, properties);
    case 'AWS::ApiGateway::Stage':
      return this.readCurrentStateStage(physicalId, properties);
    default:
      return undefined;
  }
}

export async function readCurrentStateAuthorizer(
  this: ApiGatewayProvider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const restApiId = properties?.['RestApiId'] as string | undefined;
  if (!restApiId) return undefined;

  try {
    const resp = await this.apiGatewayClient.send(
      new GetAuthorizerCommand({ restApiId, authorizerId: physicalId })
    );
    const result: Record<string, unknown> = { RestApiId: restApiId };
    result['Name'] = resp.name ?? '';
    if (resp.type !== undefined) result['Type'] = resp.type;
    // AuthType is a customer-defined label (free-form string used by
    // OpenAPI import/export tooling, no functional impact on the
    // deployed authorizer). Emit-when-present so an Authorizer that
    // never set AuthType does not grow a phantom field that would
    // round-trip into drift.
    if (resp.authType !== undefined) result['AuthType'] = resp.authType;
    result['ProviderARNs'] = resp.providerARNs ? [...resp.providerARNs] : [];
    result['AuthorizerUri'] = resp.authorizerUri ?? '';
    result['AuthorizerCredentials'] = resp.authorizerCredentials ?? '';
    result['IdentitySource'] = resp.identitySource ?? '';
    result['IdentityValidationExpression'] = resp.identityValidationExpression ?? '';
    if (resp.authorizerResultTtlInSeconds !== undefined) {
      result['AuthorizerResultTtlInSeconds'] = resp.authorizerResultTtlInSeconds;
    }
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

export async function readCurrentStateResource(
  this: ApiGatewayProvider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const restApiId = properties?.['RestApiId'] as string | undefined;
  if (!restApiId) return undefined;

  try {
    const resp = await this.apiGatewayClient.send(
      new GetResourceCommand({ restApiId, resourceId: physicalId })
    );
    const result: Record<string, unknown> = { RestApiId: restApiId };
    result['ParentId'] = resp.parentId ?? '';
    if (resp.pathPart !== undefined) result['PathPart'] = resp.pathPart;
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

export async function readCurrentStateDeployment(
  this: ApiGatewayProvider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const restApiId = properties?.['RestApiId'] as string | undefined;
  if (!restApiId) return undefined;

  try {
    const resp = await this.apiGatewayClient.send(
      new GetDeploymentCommand({ restApiId, deploymentId: physicalId })
    );
    const result: Record<string, unknown> = { RestApiId: restApiId };
    result['Description'] = resp.description ?? '';
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

export async function readCurrentStateStage(
  this: ApiGatewayProvider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const restApiId = properties?.['RestApiId'] as string | undefined;
  if (!restApiId) return undefined;

  try {
    const resp = await this.apiGatewayClient.send(
      new GetStageCommand({ restApiId, stageName: physicalId })
    );
    const result: Record<string, unknown> = { RestApiId: restApiId };
    if (resp.stageName !== undefined) result['StageName'] = resp.stageName;
    result['DeploymentId'] = resp.deploymentId ?? '';
    result['Description'] = resp.description ?? '';
    // #609 backfill: emit-when-present (do NOT emit a default when absent,
    // so a stage that never set these does not surface phantom drift).
    if (resp.tracingEnabled !== undefined) result['TracingEnabled'] = resp.tracingEnabled;
    if (resp.variables !== undefined) result['Variables'] = resp.variables;
    if (resp.cacheClusterEnabled !== undefined) {
      result['CacheClusterEnabled'] = resp.cacheClusterEnabled;
    }
    if (resp.cacheClusterSize !== undefined) result['CacheClusterSize'] = resp.cacheClusterSize;
    if (resp.clientCertificateId !== undefined) {
      result['ClientCertificateId'] = resp.clientCertificateId;
    }
    if (resp.documentationVersion !== undefined) {
      result['DocumentationVersion'] = resp.documentationVersion;
    }
    if (resp.accessLogSettings !== undefined) {
      const accessLog: Record<string, unknown> = {};
      if (resp.accessLogSettings.destinationArn !== undefined) {
        accessLog['DestinationArn'] = resp.accessLogSettings.destinationArn;
      }
      if (resp.accessLogSettings.format !== undefined) {
        accessLog['Format'] = resp.accessLogSettings.format;
      }
      result['AccessLogSetting'] = accessLog;
    }
    if (resp.canarySettings !== undefined) {
      const canary: Record<string, unknown> = {};
      if (resp.canarySettings.percentTraffic !== undefined) {
        canary['PercentTraffic'] = resp.canarySettings.percentTraffic;
      }
      if (resp.canarySettings.deploymentId !== undefined) {
        canary['DeploymentId'] = resp.canarySettings.deploymentId;
      }
      if (resp.canarySettings.stageVariableOverrides !== undefined) {
        canary['StageVariableOverrides'] = resp.canarySettings.stageVariableOverrides;
      }
      if (resp.canarySettings.useStageCache !== undefined) {
        canary['UseStageCache'] = resp.canarySettings.useStageCache;
      }
      result['CanarySetting'] = canary;
    }
    // MethodSettings (issue #966): rebuild the CFn list shape from the
    // get-stage `methodSettings` map, iterating the STATE's entries so the
    // list order matches the baseline (the drift comparator walks arrays
    // positionally) and emitting only the fields the state entry declares
    // (get-stage returns every setting with its default filled in, which
    // would otherwise surface phantom drift on undeclared fields).
    // NOTE this deliberately does NOT require `resp.methodSettings` to be
    // present: when every override was removed out-of-band, the entries
    // still emit (with the declared fields absent) so the drift surfaces
    // instead of the key silently dropping out of the comparison.
    const stateMethodSettings = properties?.['MethodSettings'] as
      | CfnStageMethodSetting[]
      | undefined;
    if (stateMethodSettings && stateMethodSettings.length > 0) {
      result['MethodSettings'] = stateMethodSettings.map((stateEntry) => {
        const awsEntry = (resp.methodSettings ?? {})[methodSettingKey(stateEntry)] as
          | Record<string, unknown>
          | undefined;
        const entry: Record<string, unknown> = {};
        if (stateEntry.ResourcePath !== undefined) entry['ResourcePath'] = stateEntry.ResourcePath;
        if (stateEntry.HttpMethod !== undefined) entry['HttpMethod'] = stateEntry.HttpMethod;
        for (const { cfnKey, responseKey } of METHOD_SETTING_PATCH_FIELDS) {
          if (stateEntry[cfnKey] !== undefined && awsEntry?.[responseKey] !== undefined) {
            entry[cfnKey] = awsEntry[responseKey];
          }
        }
        return entry;
      });
    }
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

export async function readCurrentStateAccount(
  this: ApiGatewayProvider
): Promise<Record<string, unknown> | undefined> {
  try {
    const resp = await this.apiGatewayClient.send(new GetAccountCommand({}));
    const result: Record<string, unknown> = {};
    result['CloudWatchRoleArn'] = resp.cloudwatchRoleArn ?? '';
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return undefined;
    throw err;
  }
}

export async function readCurrentStateMethod(
  this: ApiGatewayProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const parts = physicalId.split('|');
  if (parts.length !== 3) return undefined;
  const [restApiId, resourceId, httpMethod] = parts;

  try {
    const resp = await this.apiGatewayClient.send(
      new GetMethodCommand({ restApiId, resourceId, httpMethod })
    );
    const result: Record<string, unknown> = {};
    if (restApiId !== undefined) result['RestApiId'] = restApiId;
    if (resourceId !== undefined) result['ResourceId'] = resourceId;
    if (resp.httpMethod !== undefined) result['HttpMethod'] = resp.httpMethod;
    if (resp.authorizationType !== undefined) {
      result['AuthorizationType'] = resp.authorizationType;
    }
    // Class 1 (type-discriminator-dependent fields, see
    // docs/provider-rules.md#readcurrentstate-for-drift-detection). AuthorizerId is only valid
    // when AuthorizationType is CUSTOM or COGNITO_USER_POOLS — AWS
    // rejects PutMethod with "Invalid authorizer ID specified" or
    // "Authorizer not found" when sent on AuthorizationType=NONE /
    // AWS_IAM. Emitting `''` as a placeholder on a NONE method would
    // make `cdkd drift --revert`'s round-trip push that empty value
    // back as Method.update's `/authorizerId` patch. Drift
    // detection is not lost: a NONE method cannot legally have
    // AuthorizerId on AWS, so a console-side ADD is impossible.
    const authType = resp.authorizationType;
    if (authType === 'CUSTOM' || authType === 'COGNITO_USER_POOLS') {
      result['AuthorizerId'] = resp.authorizerId ?? '';
    }
    // Same Class 1 gate: AWS refuses scopes on any other authorization
    // type. Emitted (`[]` when none) so drift sees a console-side scope
    // change and `--revert` diffs against the LIVE scopes rather than an
    // absent key, which would `add` every recorded scope
    // (go-to-k/cdkd#5408).
    if (authType === 'COGNITO_USER_POOLS') {
      result['AuthorizationScopes'] = resp.authorizationScopes ? [...resp.authorizationScopes] : [];
    }
    result['Integration'] = resp.methodIntegration ?? {};
    result['MethodResponses'] = resp.methodResponses ?? {};
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * Adopt an existing API Gateway sub-resource into cdkd state.
 *
 * **Explicit override only.** API Gateway sub-resources (Authorizer,
 * Resource, Deployment, Stage, Method) live under a parent `RestApi`,
 * and their physical ids are not globally unique — they're scoped
 * `<restApiId>/<sub-id>`. Auto-lookup by `aws:cdk:path` would need to
 * walk every RestApi in the account, then every sub-resource within
 * each, which is impractical and error-prone.
 *
 * `AWS::ApiGateway::RestApi` itself is handled by the Cloud Control
 * API fallback (also explicit-override only — see
 * `cloud-control-provider.ts`).
 *
 * Users adopting an existing API Gateway should pass
 * `--resource <logicalId>=<physicalId>` for each sub-resource; the
 * physical id format follows what `create()` returns for the same
 * type. Note this is NOT uniformly a composite: `create()` returns a
 * BARE `resourceId` for `AWS::ApiGateway::Resource` (the parent
 * `RestApiId` is read from the recorded properties by every other
 * method), while `AWS::ApiGateway::Method` genuinely is
 * `<restApiId>|<resourceId>|<httpMethod>`.
 *
 * `import()` otherwise honours the supplied id verbatim, so a composite
 * passed for a type whose provider stores a SCALAR would be written to
 * state and then fed to the API as a resource id (issue #1663). That is
 * not merely a failed call: `deleteResource` treats `NotFoundException`
 * as an idempotent success, so the bad id would be reported as deleted
 * while the resource stayed live in AWS — a silent orphan, the same class
 * as issues #1651 / #1658. So the one type whose stored shape is
 * unambiguously scalar refuses a composite up front, where the user can
 * still act on it.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function importImpl(
  this: ApiGatewayProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    // Scoped to Resource deliberately: `Method` IS a composite, and this
    // type cannot take the #614 Cloud-Control route (all three of its CFn
    // properties are in `handledProperties`), so a `|` here is always the
    // user mis-following the old docstring rather than a CC-shaped id.
    if (input.resourceType === 'AWS::ApiGateway::Resource' && input.knownPhysicalId.includes('|')) {
      this.logger.warn(
        `AWS::ApiGateway::Resource ${input.logicalId}: '${input.knownPhysicalId}' looks like a ` +
          `composite, but cdkd stores a BARE resourceId for this type (the parent RestApiId ` +
          `comes from the template). Adopting it would send the whole string to the API as a ` +
          `resource id, and the delete path would then report success on the NotFound. Pass ` +
          `just the resourceId.`
      );
      return null;
    }
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }
  return null;
}
