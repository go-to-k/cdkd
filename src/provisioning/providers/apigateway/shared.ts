import { isDeepStrictEqual } from 'node:util';
import {
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodResponseCommand,
  DeleteIntegrationCommand,
  DeleteIntegrationResponseCommand,
  DeleteMethodResponseCommand,
} from '@aws-sdk/client-api-gateway';
import type { CanarySettings } from '@aws-sdk/client-api-gateway';
import type { CompositeIdFormat } from '../../composite-id.js';
import type { CreateContext, UpdateContext } from '../../../types/resource.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
} from '../../masked-retry-logger.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';

/**
 * Retry-safety state for the API Gateway creates that mint their id and
 * carry no idempotency token, `CreateAuthorizer` and `CreateDeployment`
 * (issue [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `orphan-report.ts`. Module-scoped: a provider instance is per
 * registry, and one process can build several.
 */
export const createAuthorizerLatch = new AmbiguousCreateLatch('apigateway:CreateAuthorizer');

export const createDeploymentLatch = new AmbiguousCreateLatch('apigateway:CreateDeployment');

/** `CreateRestApi` / `ImportRestApi` (go-to-k/cdkd#6139): same shape as the two above. */
export const createRestApiLatch = new AmbiguousCreateLatch('apigateway:CreateRestApi');

/**
 * Children this process created and recorded, never reported as orphan
 * candidates. Keyed by `(restApiId, id)`: a child id is unique only inside
 * its REST API.
 */
export const authorizersCreatedByThisProcess = new RecentIdSet();

export const deploymentsCreatedByThisProcess = new RecentIdSet();

/** REST APIs this process created and recorded; a REST API id is account-unique per Region. */
export const restApisCreatedByThisProcess = new RecentIdSet();

/** `limit` of each orphan-lookup list page (the API's maximum). */
export const ORPHAN_LIST_PAGE_SIZE = 500;

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetApiGatewayCreateRetryStateForTests(): void {
  createAuthorizerLatch.resetForTests();
  createDeploymentLatch.resetForTests();
  authorizersCreatedByThisProcess.resetForTests();
  deploymentsCreatedByThisProcess.resetForTests();
  createRestApiLatch.resetForTests();
  restApisCreatedByThisProcess.resetForTests();
}

/** Shape of an `AWS::ApiGateway::Method` physicalId (issue #1657). */
export const APIGW_METHOD_ID_FORMAT: CompositeIdFormat = {
  label: 'API Gateway Method',
  segments: ['restApiId', 'resourceId', 'httpMethod'],
};

/** The ApiGateway types whose delete addresses the child through `RestApiId`. */
export const REST_API_ID_ADDRESSED_TYPES: ReadonlySet<string> = new Set([
  'AWS::ApiGateway::Authorizer',
  'AWS::ApiGateway::Resource',
  'AWS::ApiGateway::Deployment',
  'AWS::ApiGateway::Stage',
]);

/**
 * The masked sinks ONE Stage `create()` / `update()` logs through (issue
 * #2177). A Stage's physical id IS its `StageName`, a template value that can
 * be secret-derived. The deploy's masker knows the name this deploy resolved;
 * what it cannot know is a name recorded from a PREVIOUS secret, which state
 * persists as its `{{resolve:` reference (or `***`) while the old plaintext
 * stays the physical id. `withDerivedNameMasks` masks the name whenever the
 * value it came from is secret-derived, including inside the stage ARN the tag
 * lines print. No length floor, per that helper's contract: a short
 * secret-derived name over-masks this operation's lines rather than printing.
 */
export function stageSinks(
  logger: { debug(message: string): void; warn(message: string): void },
  context: CreateContext | UpdateContext | undefined,
  pairs: ReadonlyArray<readonly [raw: unknown, name: string | undefined]>
): MaskedLogSinks {
  return withDerivedNameMasks(logger, createMaskedLogSinks(logger, context?.maskSecrets), pairs);
}

/**
 * CFn `AWS::ApiGateway::Stage.MethodSetting` entry (template shape). Per the
 * CFn docs, `ResourcePath` is ALREADY `~1`-escaped in the template (`/` in a
 * real path segment is encoded as `~1`, e.g. `/~1pets`; `/*` is the
 * all-resources wildcard CDK's `deployOptions` emits), so building the
 * UpdateStage patch path only needs the leading slash stripped.
 */
/**
 * CFn `AWS::ApiGateway::Stage.AccessLogSetting` block (template shape).
 * NOT a CreateStage parameter — applied via UpdateStage patch operations
 * (`replace /accessLogSettings/destinationArn` / `.../format`).
 */
export interface CfnStageAccessLogSetting {
  DestinationArn?: string;
  Format?: string;
}

/**
 * CFn `AWS::ApiGateway::Stage.CanarySetting` block (template shape). Maps
 * onto the SDK's `CanarySettings` (camelCase) via {@link toSdkCanarySettings}
 * on create; update rides field-level `/canarySettings/*` patch ops.
 */
export interface CfnStageCanarySetting {
  PercentTraffic?: number;
  DeploymentId?: string;
  StageVariableOverrides?: Record<string, string>;
  UseStageCache?: boolean;
}

/**
 * `PutMethod` refused because the method exists. API Gateway also answers
 * `ConflictException` for a concurrent modification, so the message decides.
 */
export function isMethodAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ConflictException' &&
    /already exists/i.test(error.message)
  );
}

/**
 * A nested CFn config block must be a plain object; a string, array, or
 * unresolved intrinsic that leaks through resolution indexes every sub-field
 * to `undefined` (#1471/#1493 class). Create refuses such a block; update
 * warns and skips the property.
 */
export function isPlainObjectBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip the `:*` suffix off a CloudWatch Logs log-group ARN.
 *
 * CDK's canonical `LogGroupLogDestination` emits `Fn::GetAtt [LogGroup, Arn]`
 * for `AccessLogSetting.DestinationArn`, and a log group's Arn attribute ends
 * with `:*` — a shape API Gateway's UpdateStage REJECTS ("Access log
 * destination must only contain characters a-z, ..."). CloudFormation's Stage
 * handler normalizes the suffix and accepts the template (proven by the
 * apigw-stage-throttling fixture's CC-routed history), so the SDK provider
 * must match for parity or every CDK `deployOptions.accessLogDestination`
 * app fails on deploy (caught live by that integ, 2026-08-11).
 */
export function normalizeAccessLogDestinationArn(arn: string): string {
  return arn.endsWith(':*') ? arn.slice(0, -2) : arn;
}

/**
 * Map the CFn `CanarySetting` block to the SDK `CreateStageCommand`
 * `canarySettings` shape (PascalCase -> camelCase member rename).
 */
export function toSdkCanarySettings(
  setting: CfnStageCanarySetting | undefined
): CanarySettings | undefined {
  if (setting == null) return undefined;
  return {
    percentTraffic: setting.PercentTraffic,
    deploymentId: setting.DeploymentId,
    stageVariableOverrides: setting.StageVariableOverrides,
    useStageCache: setting.UseStageCache,
  };
}

export interface CfnStageMethodSetting {
  ResourcePath?: string;
  HttpMethod?: string;
  ThrottlingRateLimit?: number;
  ThrottlingBurstLimit?: number;
  MetricsEnabled?: boolean;
  LoggingLevel?: string;
  DataTraceEnabled?: boolean;
  CachingEnabled?: boolean;
  CacheTtlInSeconds?: number;
  CacheDataEncrypted?: boolean;
  RequireAuthorizationForCacheControl?: boolean;
  UnauthorizedCacheControlHeaderStrategy?: string;
}

/**
 * CFn MethodSetting field → UpdateStage patch-path suffix under
 * `/{method_setting_key}/`. The get-stage response field for each is the
 * camelCase of the CFn name (used by the drift readback).
 */
export const METHOD_SETTING_PATCH_FIELDS: ReadonlyArray<{
  cfnKey: keyof CfnStageMethodSetting & string;
  patchSuffix: string;
  responseKey: string;
}> = [
  {
    cfnKey: 'ThrottlingRateLimit',
    patchSuffix: 'throttling/rateLimit',
    responseKey: 'throttlingRateLimit',
  },
  {
    cfnKey: 'ThrottlingBurstLimit',
    patchSuffix: 'throttling/burstLimit',
    responseKey: 'throttlingBurstLimit',
  },
  { cfnKey: 'MetricsEnabled', patchSuffix: 'metrics/enabled', responseKey: 'metricsEnabled' },
  { cfnKey: 'LoggingLevel', patchSuffix: 'logging/loglevel', responseKey: 'loggingLevel' },
  { cfnKey: 'DataTraceEnabled', patchSuffix: 'logging/dataTrace', responseKey: 'dataTraceEnabled' },
  { cfnKey: 'CachingEnabled', patchSuffix: 'caching/enabled', responseKey: 'cachingEnabled' },
  {
    cfnKey: 'CacheTtlInSeconds',
    patchSuffix: 'caching/ttlInSeconds',
    responseKey: 'cacheTtlInSeconds',
  },
  {
    cfnKey: 'CacheDataEncrypted',
    patchSuffix: 'caching/dataEncrypted',
    responseKey: 'cacheDataEncrypted',
  },
  {
    cfnKey: 'RequireAuthorizationForCacheControl',
    patchSuffix: 'caching/requireAuthorizationForCacheControl',
    responseKey: 'requireAuthorizationForCacheControl',
  },
  {
    cfnKey: 'UnauthorizedCacheControlHeaderStrategy',
    patchSuffix: 'caching/unauthorizedCacheControlHeaderStrategy',
    responseKey: 'unauthorizedCacheControlHeaderStrategy',
  },
];

/**
 * The `{method_setting_key}` API Gateway keys a stage's method settings by:
 * `{resource_path}/{http_method}` with the resource path's leading slash
 * stripped — CDK's stage-level `deployOptions` (`ResourcePath: '/*',
 * HttpMethod: '*'`) keys as the star-slash-star wildcard (the get-stage
 * `methodSettings` map key and the UpdateStage patch-path segment are the
 * same string).
 */
export function methodSettingKey(setting: CfnStageMethodSetting): string {
  const resourcePath = setting.ResourcePath ?? '/*';
  const httpMethod = setting.HttpMethod ?? '*';
  // The ROOT resource path is the bare `/` (CFn's documented root shape) and
  // API Gateway keys it as `~1` — `~1/GET` in the get-stage map and in the
  // UpdateStage patch path (verified live 2026-07-03). Bare leading-slash
  // stripping would produce the malformed `//GET` patch path.
  const escaped = resourcePath === '/' ? '~1' : resourcePath.replace(/^\//, '');
  return `${escaped}/${httpMethod}`;
}

/**
 * Build the UpdateStage patch operations that take a stage's method settings
 * from `previous` to `next` (both in the CFn `MethodSettings` list shape):
 *   - an entry present only in `next`: `replace` each specified field
 *     (`replace` both adds and changes a method-setting override)
 *   - an entry present in both with NO fields dropped: `replace` only the
 *     changed fields
 *   - an entry present in both with a field DROPPED: `remove /{key}` then
 *     `replace` every remaining specified field — API Gateway REJECTS a
 *     field-level `remove` (`remove <key>/throttling/rateLimit` fails with
 *     "Cannot remove method setting ... because there is no method setting
 *     for this method"), while whole-key remove followed by field replaces
 *     in the SAME UpdateStage call applies sequentially (both verified live
 *     2026-07-03), so the dropped field reverts to its default (CFn
 *     absent-field semantics)
 *   - an entry present only in `previous`: `remove /{key}` — drops every
 *     override for that method path at once (CFn absent-entry semantics)
 * Values are rendered as strings (the UpdateStage wire format).
 */
export function buildMethodSettingsPatchOps(
  previous: CfnStageMethodSetting[] | undefined,
  next: CfnStageMethodSetting[] | undefined
): Array<{ op: 'replace' | 'remove'; path: string; value?: string }> {
  const ops: Array<{ op: 'replace' | 'remove'; path: string; value?: string }> = [];
  const prevByKey = new Map((previous ?? []).map((s) => [methodSettingKey(s), s]));
  const nextByKey = new Map((next ?? []).map((s) => [methodSettingKey(s), s]));

  for (const key of prevByKey.keys()) {
    if (!nextByKey.has(key)) {
      ops.push({ op: 'remove', path: `/${key}` });
    }
  }

  for (const [key, setting] of nextByKey) {
    const prevSetting = prevByKey.get(key);
    const fieldDropped =
      prevSetting !== undefined &&
      METHOD_SETTING_PATCH_FIELDS.some(
        ({ cfnKey }) => prevSetting[cfnKey] !== undefined && setting[cfnKey] === undefined
      );
    if (fieldDropped) {
      // Reset-and-rebuild: clear the whole key, then re-apply every field the
      // new entry still specifies (see the JSDoc — leaf removes are rejected).
      ops.push({ op: 'remove', path: `/${key}` });
    }
    for (const { cfnKey, patchSuffix } of METHOD_SETTING_PATCH_FIELDS) {
      const nextValue = setting[cfnKey];
      const prevValue = fieldDropped ? undefined : prevSetting?.[cfnKey];
      if (nextValue !== undefined && String(nextValue) !== String(prevValue ?? '')) {
        ops.push({ op: 'replace', path: `/${key}/${patchSuffix}`, value: String(nextValue) });
      }
    }
  }

  return ops;
}

/**
 * Append RFC 6902 patch operations describing the diff between two map-shaped
 * properties (e.g. API Gateway Method `RequestParameters` /
 * `RequestModels`). For each key:
 *   - present in `next`, absent in `prev`         → `add`     `<basePath>/<key>` `value`
 *   - absent in `next`, present in `prev`         → `remove`  `<basePath>/<key>`
 *   - present in both with different values       → `replace` `<basePath>/<key>` `value`
 *
 * Slashes inside individual keys are escaped per RFC 6901
 * (`/` → `~1`, `~` → `~0`) so paths like
 *   `/requestModels/application~1json` are well-formed JSON Pointers.
 */
export function appendMapPatchOps(
  ops: Array<{ op: 'replace' | 'add' | 'remove'; path: string; value?: string }>,
  basePath: string,
  next: Record<string, unknown>,
  prev: Record<string, unknown>
): void {
  const escape = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

  // add / replace
  for (const [key, val] of Object.entries(next)) {
    const path = `${basePath}/${escape(key)}`;
    const stringValue = String(val);
    if (!Object.hasOwn(prev, key)) {
      ops.push({ op: 'add', path, value: stringValue });
    } else if (String(prev[key]) !== stringValue) {
      ops.push({ op: 'replace', path, value: stringValue });
    }
  }

  // remove keys present in prev but not in next
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key)) {
      ops.push({ op: 'remove', path: `${basePath}/${escape(key)}` });
    }
  }
}

/**
 * RFC 6902 patch operations turning the list `prev` into `next` for an API
 * Gateway list field (Authorizer `ProviderARNs`, Method
 * `AuthorizationScopes`). API Gateway takes neither `replace` nor a
 * per-element path on these: each element is an `add` or `remove` against the
 * list path itself, with the element as `value` (measured in us-east-1,
 * go-to-k/cdkd#5408). A `remove` takes out ONE occurrence and fails the whole
 * call when the element is absent. `ProviderARNs` keeps duplicates on `add`,
 * so its diff counts occurrences; `AuthorizationScopes` ignores an `add` of a
 * scope already present (PutMethod alone stores a repeat), so it passes
 * `asSet`: membership is compared on deduplicated sides, and a dropped value
 * is removed once, or once per `prev` occurrence with
 * `removeEveryPrevOccurrence` (when `prev` is the live readback, which can
 * hold a repeat). Order is not compared, since AWS appends. On a
 * deploy `prev` is the last-deployed template, so an element already removed
 * out-of-band and then dropped from the template fails the call (`Existing
 * providerARNs list doesn't contain the value`) rather than being skipped.
 */
export function listPatchOps(
  path: string,
  next: readonly string[] | undefined,
  prev: readonly string[] | undefined,
  options: { asSet?: boolean; removeEveryPrevOccurrence?: boolean } = {}
): {
  adds: Array<{ op: 'add'; path: string; value: string }>;
  removes: Array<{ op: 'remove'; path: string; value: string }>;
} {
  if (options.asSet) {
    const nextSet = new Set(next ?? []);
    const prevSet = new Set(prev ?? []);
    const dropped = options.removeEveryPrevOccurrence ? (prev ?? []) : [...prevSet];
    return {
      adds: [...nextSet]
        .filter((v) => !prevSet.has(v))
        .map((value) => ({ op: 'add', path, value })),
      removes: dropped
        .filter((v) => !nextSet.has(v))
        .map((value) => ({ op: 'remove', path, value })),
    };
  }
  const remaining = new Map<string, number>();
  for (const value of prev ?? []) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  const adds: Array<{ op: 'add'; path: string; value: string }> = [];
  for (const value of next ?? []) {
    const count = remaining.get(value) ?? 0;
    if (count > 0) remaining.set(value, count - 1);
    else adds.push({ op: 'add', path, value });
  }
  const removes: Array<{ op: 'remove'; path: string; value: string }> = [];
  for (const [value, count] of remaining) {
    for (let i = 0; i < count; i++) removes.push({ op: 'remove', path, value });
  }
  return { adds, removes };
}

/** The three ids addressing one API Gateway method. */
export interface MethodAddress {
  restApiId: string;
  resourceId: string;
  httpMethod: string;
}

/**
 * The `PutIntegration` request for a CFn `Integration` block. Every mutable
 * field `PutIntegrationRequest` supports is forwarded; see `createMethod`'s
 * JSDoc for why (the `ResponseTransferMode` regression).
 */
export function putIntegrationInput(
  ids: MethodAddress,
  integration: Record<string, unknown>
): ConstructorParameters<typeof PutIntegrationCommand>[0] {
  return {
    ...ids,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    type: integration['Type'] as any,
    integrationHttpMethod: integration['IntegrationHttpMethod'] as string | undefined,
    uri: integration['Uri'] as string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    connectionType: integration['ConnectionType'] as any,
    connectionId: integration['ConnectionId'] as string | undefined,
    credentials: integration['Credentials'] as string | undefined,
    requestParameters: integration['RequestParameters'] as Record<string, string> | undefined,
    requestTemplates: integration['RequestTemplates'] as Record<string, string> | undefined,
    passthroughBehavior: integration['PassthroughBehavior'] as string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    contentHandling: integration['ContentHandling'] as any,
    timeoutInMillis: integration['TimeoutInMillis'] as number | undefined,
    cacheNamespace: integration['CacheNamespace'] as string | undefined,
    cacheKeyParameters: integration['CacheKeyParameters'] as string[] | undefined,
    // CFn emits TlsConfig.InsecureSkipVerification (PascalCase) but the
    // SDK input shape is { insecureSkipVerification } (camelCase);
    // passing the CFn object verbatim would silently drop the field.
    tlsConfig: integration['TlsConfig']
      ? {
          insecureSkipVerification: (integration['TlsConfig'] as Record<string, unknown>)[
            'InsecureSkipVerification'
          ] as boolean | undefined,
        }
      : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    responseTransferMode: integration['ResponseTransferMode'] as any,
    // The ALB / NLB ARN of a private integration through a VPC link
    // (go-to-k/cdkd#5391).
    integrationTarget: integration['IntegrationTarget'] as string | undefined,
  };
}

/** The `PutMethodResponse` request for one CFn `MethodResponses` entry. */
export function putMethodResponseInput(
  ids: MethodAddress,
  resp: Record<string, unknown>
): ConstructorParameters<typeof PutMethodResponseCommand>[0] {
  return {
    ...ids,
    statusCode: String(resp['StatusCode']),
    responseModels: resp['ResponseModels'] as Record<string, string> | undefined,
    responseParameters: resp['ResponseParameters'] as Record<string, boolean> | undefined,
  };
}

/** The `PutIntegrationResponse` request for one CFn `IntegrationResponses` entry. */
export function putIntegrationResponseInput(
  ids: MethodAddress,
  ir: Record<string, unknown>
): ConstructorParameters<typeof PutIntegrationResponseCommand>[0] {
  return {
    ...ids,
    statusCode: String(ir['StatusCode']),
    selectionPattern: ir['SelectionPattern'] as string | undefined,
    responseParameters: ir['ResponseParameters'] as Record<string, string> | undefined,
    responseTemplates: ir['ResponseTemplates'] as Record<string, string> | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    contentHandling: ir['ContentHandling'] as any,
  };
}

export type MethodChildCall =
  | {
      kind: 'delete';
      command:
        | DeleteIntegrationCommand
        | DeleteIntegrationResponseCommand
        | DeleteMethodResponseCommand;
    }
  | {
      kind: 'put';
      command: PutIntegrationCommand | PutIntegrationResponseCommand | PutMethodResponseCommand;
    };

/**
 * Whether `props` carries `Integration` / `MethodResponses` in CloudFormation's
 * shape (each absent, or an integration with a `Type` / an empty one, and an
 * array of method responses), not `readCurrentState`'s read-back shape.
 */
export function isCfnMethodChildShape(props: Record<string, unknown>): boolean {
  const integration = integrationBlock(props['Integration']);
  if (integration !== undefined && !('Type' in integration)) return false;
  const responses = props['MethodResponses'];
  return responses === undefined || Array.isArray(responses);
}

/** A CFn response list keyed by `StatusCode`; a malformed list reads as empty. */
export function responsesByStatus(value: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      out.set(String(record['StatusCode']), record);
    }
  }
  return out;
}

/**
 * An `Integration` block, or `undefined` for none. An empty object is none:
 * `readCurrentState` emits `{}` for a method without an integration, and
 * putting it would send an integration with no type.
 */
export function integrationBlock(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The calls that move a method's integration and responses from `previous` to
 * `desired` (go-to-k/cdkd#5140), in the order API Gateway accepts, as
 * measured live:
 *
 * - `PutIntegration` REPLACES the integration and drops every integration
 *   response, so after it each desired integration response is put again.
 * - `PutIntegrationResponse` overwrites an existing status code.
 * - `PutMethodResponse` refuses an existing status code (`ConflictException`),
 *   so a changed method response is deleted first, and the integration
 *   response mapping onto it before that.
 * - Method responses are put before the integration responses that map onto
 *   them (see `createMethod`).
 *
 * Nothing is called when neither side changed.
 */
export function methodChildCalls(
  ids: MethodAddress,
  desired: Record<string, unknown>,
  previous: Record<string, unknown>
): MethodChildCall[] {
  // `cdkd drift --revert` hands either side as `readCurrentState` emits it:
  // the SDK's camelCase `methodIntegration` and a status-code-keyed map of
  // method responses. Read as CloudFormation's shape, that plans an
  // integration with no type and a put of every existing method response.
  // Such an update leaves both alone, as before go-to-k/cdkd#5140.
  if (!isCfnMethodChildShape(desired) || !isCfnMethodChildShape(previous)) return [];
  const newInt = integrationBlock(desired['Integration']);
  const oldInt = integrationBlock(previous['Integration']);
  const newMr = responsesByStatus(desired['MethodResponses']);
  const oldMr = responsesByStatus(previous['MethodResponses']);
  const newIr = responsesByStatus(newInt?.['IntegrationResponses']);
  const oldIr = responsesByStatus(oldInt?.['IntegrationResponses']);
  const withoutResponses = (b: Record<string, unknown> | undefined): unknown => {
    if (b === undefined) return undefined;
    const { IntegrationResponses: _dropped, ...rest } = b;
    return rest;
  };
  const integrationChanged = !isDeepStrictEqual(withoutResponses(newInt), withoutResponses(oldInt));
  const mrGoing = [...oldMr.keys()].filter(
    (code) => !newMr.has(code) || !isDeepStrictEqual(newMr.get(code), oldMr.get(code))
  );
  const mrComing = [...newMr.keys()].filter(
    (code) => !oldMr.has(code) || !isDeepStrictEqual(newMr.get(code), oldMr.get(code))
  );

  const calls: MethodChildCall[] = [];
  // Integration responses that live on until the integration is put again or
  // re-put below: the live set after the deletes in step 1.
  const liveIr = new Map(oldInt === undefined ? [] : oldIr);
  // 1. Integration gone: delete it (its responses go with it). Otherwise
  //    delete each integration response whose code leaves, or whose method
  //    response is about to be deleted.
  if (oldInt !== undefined && newInt === undefined) {
    calls.push({ kind: 'delete', command: new DeleteIntegrationCommand(ids) });
    liveIr.clear();
  } else if (oldInt !== undefined) {
    for (const code of oldIr.keys()) {
      if (!newIr.has(code) || mrGoing.includes(code)) {
        calls.push({
          kind: 'delete',
          command: new DeleteIntegrationResponseCommand({ ...ids, statusCode: code }),
        });
        liveIr.delete(code);
      }
    }
  }
  // 2. Method responses: delete the leaving and changed ones, then put the
  //    new and changed ones.
  for (const code of mrGoing) {
    calls.push({
      kind: 'delete',
      command: new DeleteMethodResponseCommand({ ...ids, statusCode: code }),
    });
  }
  for (const code of mrComing) {
    calls.push({
      kind: 'put',
      command: new PutMethodResponseCommand(putMethodResponseInput(ids, newMr.get(code)!)),
    });
  }
  // 3. The integration, then its responses.
  if (newInt !== undefined) {
    if (integrationChanged) {
      calls.push({
        kind: 'put',
        command: new PutIntegrationCommand(putIntegrationInput(ids, newInt)),
      });
      liveIr.clear();
    }
    for (const [code, ir] of newIr) {
      if (liveIr.has(code) && isDeepStrictEqual(liveIr.get(code), ir)) continue;
      calls.push({
        kind: 'put',
        command: new PutIntegrationResponseCommand(putIntegrationResponseInput(ids, ir)),
      });
    }
  }
  return calls;
}
