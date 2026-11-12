import { isDeepStrictEqual } from 'node:util';
import type { ApiGatewayProvider } from '../apigateway-provider.js';
import {
  CreateRestApiCommand,
  DeleteRestApiCommand,
  GetRestApiCommand,
  GetRestApisCommand,
  ImportRestApiCommand,
  NotFoundException,
  PutRestApiCommand,
  TagResourceCommand,
  UpdateRestApiCommand,
  type ApiKeySourceType,
  type CreateRestApiCommandOutput,
  type EndpointAccessMode,
  type EndpointConfiguration,
  type EndpointType,
  type IpAddressType,
  type PatchOperation,
  type PutMode,
  type SecurityPolicy,
} from '@aws-sdk/client-api-gateway';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getAwsClients } from '../../../utils/aws-clients.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { stringifyValue } from '../../../utils/stringify.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type {
  ResourceCreateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import type { MaskedLogSinks, MaskerFn } from '../../masked-retry-logger.js';
import { onlySecretReferencesDiffer } from '../../secret-reference-immutable.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { collectOrphanIds, reportPossibleOrphans } from '../orphan-report.js';
import {
  isInsideWindow,
  replayedSendWindow,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import {
  createRestApiLatch,
  restApisCreatedByThisProcess,
  ORPHAN_LIST_PAGE_SIZE,
} from './shared.js';

// ─── AWS::ApiGateway::RestApi ───────────────────────────────────────
//
// go-to-k/cdkd#6139. The semantics below were measured against
// CloudFormation's own handler (a CFn A/B in us-east-1):
//
// - No property is create-only: a `Name` change renames the API in place.
// - A REMOVED `Description`, `MinimumCompressionSize`, `ApiKeySourceType`,
//   `DisableExecuteApiEndpoint` or `Policy` is LEFT at its live value; a
//   removed `BinaryMediaTypes` is CLEARED; a removed `EndpointConfiguration`
//   resets the endpoint type to `EDGE`; removed `Tags` are untagged.
// - `Body` / `BodyS3Location` without `Name` creates the API from the
//   definition (ImportRestApi: the definition's title names it).
// - A changed body is applied with `PutRestApi` in `Mode` (`overwrite` when
//   omitted: a path the new body drops is deleted), after which the declared
//   top-level properties are re-applied (an overwrite clears
//   `binaryMediaTypes` and renames the API to the definition's title).
// - A body REMOVED from the template changes nothing.

/** The CFn properties that drive a body put. */
const BODY_KEYS = ['Body', 'BodyS3Location', 'Mode', 'FailOnWarnings', 'Parameters'] as const;

/** A top-level scalar and the UpdateRestApi patch path that sets it. */
const SCALAR_FIELDS: ReadonlyArray<{ key: string; path: string }> = [
  { key: 'Name', path: '/name' },
  { key: 'Description', path: '/description' },
  { key: 'Version', path: '/version' },
  { key: 'MinimumCompressionSize', path: '/minimumCompressionSize' },
  { key: 'ApiKeySourceType', path: '/apiKeySource' },
  { key: 'DisableExecuteApiEndpoint', path: '/disableExecuteApiEndpoint' },
  { key: 'SecurityPolicy', path: '/securityPolicy' },
  { key: 'EndpointAccessMode', path: '/endpointAccessMode' },
];

/** RFC 6901 escape for one JSON Pointer segment (`image/png` -> `image~1png`). */
function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The CFn `Policy` (a JSON object or a JSON string) as the string API Gateway takes. */
export function restApiPolicyString(policy: unknown): string | undefined {
  if (policy === undefined || policy === null) return undefined;
  return typeof policy === 'string' ? policy : JSON.stringify(policy);
}

/**
 * The policy `GetRestApi` returns, as a JSON object. API Gateway answers it
 * with every `"` and `/` backslash-escaped inside the string, and expands a
 * `execute-api:/...` resource to the API's full ARN. The expansion is folded
 * back when the recorded policy used the short form, so an unchanged policy
 * does not read as drift. Unparseable text is returned as-is.
 */
export function parseRestApiPolicy(
  raw: string | undefined,
  restApiId: string,
  recorded: unknown
): unknown {
  if (raw === undefined || raw === '') return undefined;
  let text = raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    text = raw.replace(/\\(["\\/])/g, '$1');
    try {
      parsed = JSON.parse(text);
    } catch {
      return raw;
    }
  }
  const recordedText = restApiPolicyString(recorded);
  if (recordedText !== undefined && recordedText.includes('execute-api:/')) {
    const expanded = new RegExp(`arn:[a-z-]+:execute-api:[a-z0-9-]+:\\d{12}:${restApiId}/`, 'g');
    parsed = JSON.parse(JSON.stringify(parsed).replace(expanded, 'execute-api:/'));
  }
  return parsed;
}

/** The SDK `RestApi` shape (a create / put / get answer) in CFn property shape. */
export function restApiAsCfn(
  api: {
    id?: string | undefined;
    name?: string | undefined;
    description?: string | undefined;
    version?: string | undefined;
    binaryMediaTypes?: string[] | undefined;
    minimumCompressionSize?: number | undefined;
    apiKeySource?: string | undefined;
    endpointConfiguration?: EndpointConfiguration | undefined;
    policy?: string | undefined;
    disableExecuteApiEndpoint?: boolean | undefined;
    securityPolicy?: string | undefined;
    endpointAccessMode?: string | undefined;
  },
  recordedPolicy?: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (api.name !== undefined) out['Name'] = api.name;
  if (api.description !== undefined) out['Description'] = api.description;
  if (api.version !== undefined) out['Version'] = api.version;
  out['BinaryMediaTypes'] = api.binaryMediaTypes ? [...api.binaryMediaTypes] : [];
  if (api.minimumCompressionSize !== undefined) {
    out['MinimumCompressionSize'] = api.minimumCompressionSize;
  }
  if (api.apiKeySource !== undefined) out['ApiKeySourceType'] = api.apiKeySource;
  if (api.disableExecuteApiEndpoint !== undefined) {
    out['DisableExecuteApiEndpoint'] = api.disableExecuteApiEndpoint;
  }
  const policy = parseRestApiPolicy(api.policy, api.id ?? '', recordedPolicy);
  if (policy !== undefined) out['Policy'] = policy;
  if (api.endpointConfiguration !== undefined) {
    const ec: Record<string, unknown> = {};
    if (api.endpointConfiguration.types !== undefined) {
      ec['Types'] = [...api.endpointConfiguration.types];
    }
    if (api.endpointConfiguration.vpcEndpointIds !== undefined) {
      ec['VpcEndpointIds'] = [...api.endpointConfiguration.vpcEndpointIds];
    }
    if (api.endpointConfiguration.ipAddressType !== undefined) {
      ec['IpAddressType'] = api.endpointConfiguration.ipAddressType;
    }
    out['EndpointConfiguration'] = ec;
  }
  if (api.securityPolicy !== undefined) out['SecurityPolicy'] = api.securityPolicy;
  if (api.endpointAccessMode !== undefined) out['EndpointAccessMode'] = api.endpointAccessMode;
  return out;
}

/**
 * The `x-amazon-apigateway-binary-media-types` an inline `Body` (an object or
 * JSON text) declares; empty for YAML, an S3 definition, or none.
 */
export function definitionBinaryMediaTypes(body: unknown): Set<string> {
  let definition: unknown = body;
  if (typeof body === 'string') {
    try {
      definition = JSON.parse(body);
    } catch {
      return new Set();
    }
  }
  return new Set(
    stringList(asRecord(definition)?.['x-amazon-apigateway-binary-media-types']) ?? []
  );
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The first endpoint type a CFn `EndpointConfiguration` declares. */
function endpointType(config: unknown): string | undefined {
  return stringList(asRecord(config)?.['Types'])?.[0];
}

/**
 * The UpdateRestApi patch operations that take the API's top-level
 * configuration from `current` (CFn shape: the previous template, or the live
 * API after a body put) to `desired`. `previous` is the last-deployed
 * template, which decides what a REMOVED property does (see the module
 * header). Endpoint operations go LAST: an endpoint-type change is applied
 * asynchronously, and API Gateway refuses another endpoint change while it is
 * in progress.
 */
export function restApiPatchOperations(
  desired: Record<string, unknown>,
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
  bodyPutMode?: PutMode
): PatchOperation[] {
  const ops: PatchOperation[] = [];
  for (const { key, path } of SCALAR_FIELDS) {
    const next = desired[key];
    // A removed scalar is left at its live value, as CloudFormation leaves it.
    if (next === undefined || next === null) continue;
    const value = stringifyValue(next);
    if (value !== (current[key] == null ? '' : stringifyValue(current[key]))) {
      ops.push({ op: 'replace', path, value });
    }
  }

  const nextPolicy = restApiPolicyString(desired['Policy']);
  if (nextPolicy !== undefined && nextPolicy !== restApiPolicyString(current['Policy'])) {
    ops.push({ op: 'replace', path: '/policy', value: nextPolicy });
  }

  // BinaryMediaTypes MERGE with the definition's
  // `x-amazon-apigateway-binary-media-types`, as CloudFormation merges them
  // (CFn A/B): right after an `overwrite` put (or an import) the live list is
  // the definition's, and the template's types are added to it, never removed
  // from it. Otherwise (no put, or a `merge` put, which keeps the old list) a
  // type the previous template declared and this one dropped is removed (a
  // removed list drops every one) unless the definition declares it too.
  const targetTypes =
    stringList(desired['BinaryMediaTypes']) ??
    (previous['BinaryMediaTypes'] !== undefined ? [] : undefined);
  if (targetTypes !== undefined) {
    const live = new Set(stringList(current['BinaryMediaTypes']) ?? []);
    const target = new Set(targetTypes);
    const fromDefinition = definitionBinaryMediaTypes(desired['Body']);
    const dropped =
      bodyPutMode === 'overwrite' ? [] : (stringList(previous['BinaryMediaTypes']) ?? []);
    for (const t of new Set(dropped)) {
      if (live.has(t) && !target.has(t) && !fromDefinition.has(t))
        ops.push({ op: 'remove', path: `/binaryMediaTypes/${pointerSegment(t)}` });
    }
    for (const t of target) {
      if (!live.has(t)) ops.push({ op: 'add', path: `/binaryMediaTypes/${pointerSegment(t)}` });
    }
  }

  // EndpointConfiguration: a removed block resets the type to EDGE, as
  // CloudFormation resets it. An API created without one is EDGE.
  const desiredEc = asRecord(desired['EndpointConfiguration']);
  const currentEc = asRecord(current['EndpointConfiguration']);
  const targetType =
    endpointType(desiredEc) ??
    (previous['EndpointConfiguration'] !== undefined ? 'EDGE' : undefined);
  const currentType = endpointType(currentEc) ?? 'EDGE';
  if (targetType !== undefined && targetType !== currentType) {
    ops.push({
      op: 'replace',
      path: `/endpointConfiguration/types/${currentType}`,
      value: targetType,
    });
  }
  if (desiredEc !== undefined) {
    const nextIds = stringList(desiredEc['VpcEndpointIds']);
    if (nextIds !== undefined || targetType === 'PRIVATE') {
      const live = new Set(stringList(currentEc?.['VpcEndpointIds']) ?? []);
      const target = new Set(nextIds ?? []);
      for (const id of target) {
        if (!live.has(id)) {
          ops.push({ op: 'add', path: '/endpointConfiguration/vpcEndpointIds', value: id });
        }
      }
      for (const id of live) {
        if (!target.has(id)) {
          ops.push({ op: 'remove', path: '/endpointConfiguration/vpcEndpointIds', value: id });
        }
      }
    }
    const ipType = desiredEc['IpAddressType'];
    if (typeof ipType === 'string' && ipType !== currentEc?.['IpAddressType']) {
      ops.push({ op: 'replace', path: '/endpointConfiguration/ipAddressType', value: ipType });
    }
  }
  return ops;
}

/** Whether the template asks for an OpenAPI body put. */
function declaresBody(properties: Record<string, unknown>): boolean {
  return properties['Body'] != null || properties['BodyS3Location'] != null;
}

/**
 * Whether the body put the template asks for differs from the recorded one.
 * The recorded side keeps a `{{resolve:...}}` reference where the desired
 * side holds its resolved value, so a difference made only of such
 * references is no change: the diff found the template unchanged there, and
 * an `overwrite` put would delete every resource the stack added to the API
 * outside the definition.
 */
export function restApiBodyChanged(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  maskSecrets?: MaskerFn
): boolean {
  if (!declaresBody(desired)) return false;
  return BODY_KEYS.some(
    (key) =>
      !isDeepStrictEqual(desired[key], previous[key]) &&
      !onlySecretReferencesDiffer(desired[key], previous[key], maskSecrets)
  );
}

/**
 * The definition's `info.title`, the name ImportRestApi gives the API, read
 * from the bytes about to be imported when they are JSON (an inline object,
 * JSON text, or a JSON S3 object). Undefined for YAML.
 */
function definitionTitle(body: Uint8Array): string | undefined {
  try {
    const info = asRecord(asRecord(JSON.parse(new TextDecoder().decode(body)))?.['info']);
    return typeof info?.['title'] === 'string' ? info['title'] : undefined;
  } catch {
    return undefined;
  }
}

/** The CFn `Parameters` map as the string map ImportRestApi / PutRestApi take. */
function bodyParameters(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, String(v)]));
}

/**
 * The OpenAPI definition bytes: `Body` (a JSON object, or JSON / YAML text)
 * or the `BodyS3Location` object, read the way CloudFormation reads it.
 */
export async function resolveRestApiBody(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: MaskerFn,
  physicalId?: string
): Promise<Uint8Array | undefined> {
  const body = properties['Body'];
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (typeof body === 'object') return new TextEncoder().encode(JSON.stringify(body));
    throw new ProvisioningError(
      `Body of ${resourceType} ${logicalId} must be an OpenAPI definition object or string`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  const location = asRecord(properties['BodyS3Location']);
  if (properties['BodyS3Location'] == null) return undefined;
  const bucket = location?.['Bucket'];
  const key = location?.['Key'];
  if (typeof bucket !== 'string' || typeof key !== 'string' || !bucket || !key) {
    throw new ProvisioningError(
      `BodyS3Location of ${resourceType} ${logicalId} must name a Bucket and a Key`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  const version = location?.['Version'];
  const etag = location?.['ETag'];
  const resp = await getAwsClients().s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(typeof version === 'string' && version && { VersionId: version }),
      ...(typeof etag === 'string' && etag && { IfMatch: etag }),
    })
  );
  const bytes = resp.Body ? await resp.Body.transformToByteArray() : undefined;
  if (!bytes || bytes.length === 0) {
    throw new ProvisioningError(
      `BodyS3Location of ${resourceType} ${logicalId} (s3://${mask(bucket)}/${mask(key)}) holds no definition`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  return bytes;
}

/** `arn:{partition}:apigateway:{region}::/restapis/{id}`, the ARN tagging takes. */
async function restApiArn(this: ApiGatewayProvider, restApiId: string): Promise<string> {
  const region = await this.apiGatewayClient.config.region();
  const { partition } = derivePartitionAndUrlSuffix(region);
  return `arn:${partition}:apigateway:${region}::/restapis/${restApiId}`;
}

/**
 * Create an API Gateway REST API.
 *
 * Without a body (or with `CloneFrom`) one `CreateRestApi` carries every
 * property. With `Body` / `BodyS3Location` the API is made by
 * `ImportRestApi` (the endpoint type rides its `endpointConfigurationTypes`
 * parameter, so an import is never created EDGE and switched), then the
 * declared top-level properties the definition does not set are patched and
 * the tags applied. `CloneFrom` with a body creates the clone, then puts the
 * body.
 *
 * The create call mints the id and takes no idempotency token, so it goes
 * through the create client with no 5xx replay and reports possible orphans
 * on the next attempt (go-to-k/cdkd#2080, the #4303 shape). A failure AFTER
 * the API exists deletes it and re-throws the original error, so nothing
 * unrecorded is left behind (go-to-k/cdkd#2169).
 */
export async function createRestApi(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(safeMsg`Creating API Gateway RestApi ${logicalId}`);
  const name = typeof properties['Name'] === 'string' ? properties['Name'] : undefined;
  const cloneFrom =
    typeof properties['CloneFrom'] === 'string' ? properties['CloneFrom'] : undefined;
  const hasBody = declaresBody(properties);
  if (!name && (!hasBody || cloneFrom)) {
    throw new ProvisioningError(
      `Name is required for API Gateway RestApi ${logicalId} unless Body or BodyS3Location defines the API`,
      resourceType,
      logicalId
    );
  }
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  let restApiId: string | undefined;
  try {
    const body = await resolveRestApiBody.call(
      this,
      logicalId,
      resourceType,
      properties,
      log.value
    );
    // ImportRestApi names the API after the definition's title, so a lost
    // import is found by that name; for a YAML definition only the window
    // narrows the candidates, and the report says so.
    const createdName = body && !cloneFrom ? definitionTitle(body) : name;
    const desiredEc = asRecord(properties['EndpointConfiguration']);

    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await this.orphanCommandRegionArg(aws);
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: body && !cloneFrom ? 'ImportRestApi' : 'CreateRestApi',
        listAction: 'GetRestApis',
        subject: createdName ? `a REST API named ${log.value(createdName)}` : 'a REST API',
        noun: 'REST API(s)',
        ...(createdName === undefined && {
          afterward:
            'The definition is not JSON, so its title could not be read: every REST API created in that window is listed, which can include another deploy or process. Creating a new one now.',
        }),
        list: () =>
          collectOrphanIds(
            async (position) => {
              const page = await this.apiGatewayClient.send(
                new GetRestApisCommand({
                  limit: ORPHAN_LIST_PAGE_SIZE,
                  ...(position && { position }),
                })
              );
              return { items: page.items ?? [], next: page.position };
            },
            (a) =>
              a.id &&
              (createdName === undefined || a.name === createdName) &&
              isInsideWindow(a.createdDate, lookupWindow) &&
              !restApisCreatedByThisProcess.has(a.id)
                ? a.id
                : undefined
          ),
        inspect: (id) => aws`aws apigateway get-rest-api --rest-api-id ${id}${regionArg}`.render(),
        remove: (id) =>
          aws`aws apigateway delete-rest-api --rest-api-id ${id}${regionArg}`.render(),
      });
    };
    const orphanWindow = createRestApiLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await reportOrphans(orphanWindow);
    }

    const createClient = await this.getCreateClient();
    const attemptStartMs = Date.now();
    let response: CreateRestApiCommandOutput;
    try {
      if (body && !cloneFrom) {
        const parameters = bodyParameters(properties['Parameters']) ?? {};
        const type = endpointType(desiredEc);
        if (type !== undefined && parameters['endpointConfigurationTypes'] === undefined) {
          parameters['endpointConfigurationTypes'] = type;
        }
        response = await createClient.send(
          new ImportRestApiCommand({
            body,
            failOnWarnings: properties['FailOnWarnings'] === true,
            ...(Object.keys(parameters).length > 0 && { parameters }),
          })
        );
      } else {
        response = await createClient.send(
          new CreateRestApiCommand({
            name,
            description: properties['Description'] as string | undefined,
            version: properties['Version'] as string | undefined,
            cloneFrom,
            binaryMediaTypes: stringList(properties['BinaryMediaTypes']),
            minimumCompressionSize: properties['MinimumCompressionSize'] as number | undefined,
            apiKeySource: properties['ApiKeySourceType'] as ApiKeySourceType | undefined,
            endpointConfiguration: desiredEc
              ? {
                  types: stringList(desiredEc['Types']) as EndpointType[] | undefined,
                  vpcEndpointIds: stringList(desiredEc['VpcEndpointIds']),
                  ipAddressType: desiredEc['IpAddressType'] as IpAddressType | undefined,
                }
              : undefined,
            policy: restApiPolicyString(properties['Policy']),
            tags:
              tags.length > 0 ? Object.fromEntries(tags.map((t) => [t.Key, t.Value])) : undefined,
            disableExecuteApiEndpoint: properties['DisableExecuteApiEndpoint'] as
              | boolean
              | undefined,
            securityPolicy: properties['SecurityPolicy'] as SecurityPolicy | undefined,
            endpointAccessMode: properties['EndpointAccessMode'] as EndpointAccessMode | undefined,
          })
        );
      }
    } catch (error) {
      createRestApiLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    if (!response.id) {
      throw new ProvisioningError(
        `API Gateway answered no id for RestApi ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    restApiId = response.id;
    restApisCreatedByThisProcess.add(restApiId);
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await reportOrphans(replayWindow);
    }

    let rootResourceId = response.rootResourceId;
    if (body) {
      let live: Record<string, unknown> = restApiAsCfn(response, properties['Policy']);
      if (cloneFrom) {
        const put = await this.apiGatewayClient.send(
          new PutRestApiCommand({
            restApiId,
            mode: (properties['Mode'] as PutMode | undefined) ?? 'overwrite',
            failOnWarnings: properties['FailOnWarnings'] === true,
            parameters: bodyParameters(properties['Parameters']),
            body,
          })
        );
        live = restApiAsCfn(put, properties['Policy']);
        rootResourceId = put.rootResourceId ?? rootResourceId;
      }
      const patchOperations = restApiPatchOperations(
        properties,
        live,
        {},
        cloneFrom ? ((properties['Mode'] as PutMode | undefined) ?? 'overwrite') : 'overwrite'
      );
      if (patchOperations.length > 0) {
        await this.apiGatewayClient.send(new UpdateRestApiCommand({ restApiId, patchOperations }));
      }
      if (tags.length > 0 && !cloneFrom) {
        await this.apiGatewayClient.send(
          new TagResourceCommand({
            resourceArn: await restApiArn.call(this, restApiId),
            tags: Object.fromEntries(tags.map((t) => [t.Key, t.Value])),
          })
        );
      }
    }
    if (rootResourceId === undefined) {
      rootResourceId = (await this.apiGatewayClient.send(new GetRestApiCommand({ restApiId })))
        .rootResourceId;
    }

    log.debug(safeMsg`Successfully created API Gateway RestApi ${logicalId}: ${restApiId}`);
    return {
      physicalId: restApiId,
      attributes: {
        RestApiId: restApiId,
        ...(rootResourceId !== undefined ? { RootResourceId: rootResourceId } : {}),
      },
    };
  } catch (error) {
    // A cdkd refusal raised before the API existed (an unreadable body) passes through.
    if (error instanceof CdkdError && restApiId === undefined) throw error;
    const cause = error instanceof Error ? error : undefined;
    const survivor =
      restApiId === undefined ? '' : await retireFailedRestApi.call(this, restApiId, log);
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway RestApi ${logicalId}: ${text}${survivor}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * Delete the REST API a failing create already made (go-to-k/cdkd#2169):
 * it is recorded nowhere, so nothing else would ever retire it. Returns ''
 * when it is gone, or a sentence naming the survivor and the command that
 * retires it. Deleting a REST API just created by this call is safe: nothing
 * else can reference an id no state records.
 */
async function retireFailedRestApi(
  this: ApiGatewayProvider,
  restApiId: string,
  log: MaskedLogSinks
): Promise<string> {
  try {
    await this.apiGatewayClient.send(new DeleteRestApiCommand({ restApiId }));
    log.debug(safeMsg`Deleted REST API ${restApiId} left by the failed create`);
    return '';
  } catch (cleanupError) {
    if (cleanupError instanceof NotFoundException) return '';
    const aws = pasteableAwsCommand(log.mask);
    const regionArg = await this.orphanCommandRegionArg(aws);
    return (
      ` The REST API ${restApiId} it created could not be deleted ` +
      `(${describeAwsFailure(cleanupError).summary}); delete it with: ` +
      aws`aws apigateway delete-rest-api --rest-api-id ${restApiId}${regionArg}`.render()
    );
  }
}

/**
 * Update an API Gateway REST API in place: a changed body first
 * (`PutRestApi` in `Mode`, `overwrite` when omitted), then the top-level
 * properties by `UpdateRestApi` patch operations, then the tags. After a
 * body put the patch is computed against the API the put answered with,
 * since an overwrite renames the API to the definition's title and clears
 * its binary media types. No property forces a replacement.
 */
export async function updateRestApi(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  changedProperties?: ReadonlySet<string>,
  noEchoOnlyChanged?: ReadonlySet<string>
): Promise<ResourceUpdateResult> {
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  try {
    let current = previousProperties;
    let bodyPutMode: PutMode | undefined;
    let rootResourceId: string | undefined;
    // The engine's verdict, template to template, when it gave one: it counts a
    // re-pointed `{{resolve:}}` reference or a newer secret version as a
    // change, which no comparison against the redacted record can tell from
    // an unchanged reference (go-to-k/cdkd#5112). Rollback, `drift --revert`
    // and a direct call carry none and compare the two bags.
    let bodyChanged =
      changedProperties !== undefined
        ? declaresBody(properties) && BODY_KEYS.some((key) => changedProperties.has(key))
        : restApiBodyChanged(properties, previousProperties, log.mask);
    // A body key the engine names changed ONLY because it carries a `NoEcho`
    // parameter value (its as-written form, `***` at those positions and any
    // dynamic reference as its token, equals the record) may be unchanged:
    // the record keeps only the mask and AWS never returns the body, so cdkd
    // cannot tell. An `overwrite` put would delete every resource the stack
    // declares on the API outside the definition, on every deploy, so it is
    // skipped and the deploy says so (maintainer decision on
    // go-to-k/cdkd#6140). A salted witness that would let cdkd compare the
    // value, as CloudFormation does, is go-to-k/cdkd#6146.
    if (bodyChanged && changedProperties !== undefined && noEchoOnlyChanged !== undefined) {
      const named = BODY_KEYS.filter((key) => changedProperties.has(key));
      if (named.length > 0 && named.every((key) => noEchoOnlyChanged.has(key))) {
        bodyChanged = false;
        log.warn(
          safeMsg`${logicalId} (${resourceType}): its Body embeds a NoEcho parameter value, which cdkd records only as *** and cannot compare, so the OpenAPI definition is not put again. A change to that value alone is NOT applied. To apply one, change a part of the Body that is not masked (its description or a version field, for example) in the same deploy.`
        );
      }
    }
    if (bodyChanged) {
      const body = await resolveRestApiBody.call(
        this,
        logicalId,
        resourceType,
        properties,
        log.value,
        physicalId
      );
      const put = await this.apiGatewayClient.send(
        new PutRestApiCommand({
          restApiId: physicalId,
          mode: (properties['Mode'] as PutMode | undefined) ?? 'overwrite',
          failOnWarnings: properties['FailOnWarnings'] === true,
          parameters: bodyParameters(properties['Parameters']),
          // `restApiBodyChanged` holds only when Body or BodyS3Location is declared.
          body: body!,
        })
      );
      log.debug(
        safeMsg`Put the OpenAPI definition of API Gateway RestApi ${logicalId}: ${physicalId}`
      );
      current = restApiAsCfn(put, properties['Policy']);
      bodyPutMode = (properties['Mode'] as PutMode | undefined) ?? 'overwrite';
      rootResourceId = put.rootResourceId;
    }

    const patchOperations = restApiPatchOperations(
      properties,
      current,
      previousProperties,
      bodyPutMode
    );
    if (patchOperations.length > 0) {
      await this.apiGatewayClient.send(
        new UpdateRestApiCommand({ restApiId: physicalId, patchOperations })
      );
      log.debug(
        safeMsg`Updated API Gateway RestApi ${logicalId} (${patchOperations.length} patch ops)`
      );
    }

    const arn = await restApiArn.call(this, physicalId);
    await this.applyTagDiff(
      arn,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      log,
      arn
    );

    return {
      physicalId,
      wasReplaced: false,
      ...(rootResourceId !== undefined
        ? { attributes: { RestApiId: physicalId, RootResourceId: rootResourceId } }
        : {}),
    };
  } catch (error) {
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway RestApi ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/** Delete an API Gateway REST API (its resources, methods and stages go with it). */
export async function deleteRestApi(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(safeMsg`Deleting API Gateway RestApi ${logicalId}: ${physicalId}`);
  try {
    await this.apiGatewayClient.send(new DeleteRestApiCommand({ restApiId: physicalId }));
    this.logger.debug(safeMsg`Successfully deleted API Gateway RestApi ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.apiGatewayClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        safeMsg`API Gateway RestApi ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway RestApi ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // Only the typed not-found above means this one is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/** `Fn::GetAtt` on a REST API: `RestApiId` is the physical id, `RootResourceId` is read live. */
export async function getRestApiAttribute(
  this: ApiGatewayProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'RestApiId') return physicalId;
  if (attributeName === 'RootResourceId') {
    const resp = await this.apiGatewayClient.send(new GetRestApiCommand({ restApiId: physicalId }));
    return resp.rootResourceId;
  }
  return undefined;
}

/**
 * The live REST API in CFn property shape, for drift. `Body`,
 * `BodyS3Location`, `CloneFrom`, `Mode`, `FailOnWarnings` and `Parameters`
 * are write-only (the response never carries them; see
 * `getDriftUnknownPaths`). `Tags` drops the `aws:` keys AWS manages.
 */
export async function readCurrentStateRestApi(
  this: ApiGatewayProvider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  try {
    const resp = await this.apiGatewayClient.send(new GetRestApiCommand({ restApiId: physicalId }));
    const result = restApiAsCfn(resp, properties?.['Policy']);
    // The definition's binary media types are merged into the live list; the
    // template's own list is what the record holds, so the definition's are
    // left out of the comparison unless the template declares them too. A
    // definition cdkd cannot read here (BodyS3Location, YAML text) leaves only
    // the declared types to compare.
    const fromDefinition = definitionBinaryMediaTypes(properties?.['Body']);
    const declared = new Set(stringList(properties?.['BinaryMediaTypes']) ?? []);
    const unreadable =
      properties?.['BodyS3Location'] != null ||
      (typeof properties?.['Body'] === 'string' && !isJsonText(properties['Body']));
    result['BinaryMediaTypes'] = (result['BinaryMediaTypes'] as string[]).filter((t) =>
      unreadable ? declared.has(t) : !fromDefinition.has(t) || declared.has(t)
    );
    result['Tags'] = Object.entries(resp.tags ?? {})
      .filter(([key]) => !key.startsWith('aws:'))
      .map(([Key, Value]) => ({ Key, Value }));
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/** The write-only RestApi inputs `GetRestApi` never returns. */
export const REST_API_WRITE_ONLY_PATHS: readonly string[] = [
  'Body',
  'BodyS3Location',
  'CloneFrom',
  'FailOnWarnings',
  'Mode',
  'Parameters',
];

/**
 * Adopt an existing REST API: explicit `--resource <logicalId>=<restApiId>`
 * only. A REST API name is not unique, and AWS refuses `aws:`-prefixed tag
 * writes, so there is no `aws:cdk:path` tag to look one up by.
 */
export async function importRestApi(
  this: ApiGatewayProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (!input.knownPhysicalId) return null;
  try {
    const resp = await this.apiGatewayClient.send(
      new GetRestApiCommand({ restApiId: input.knownPhysicalId })
    );
    return {
      physicalId: input.knownPhysicalId,
      attributes: {
        RestApiId: input.knownPhysicalId,
        ...(resp.rootResourceId !== undefined ? { RootResourceId: resp.rootResourceId } : {}),
      },
    };
  } catch (err) {
    if (err instanceof NotFoundException) return null;
    throw err;
  }
}
