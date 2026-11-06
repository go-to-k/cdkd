import type { CloudControlProvider } from '../cloud-control-provider.js';
import { GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  getAccountInfo,
  type AwsAccountInfo,
} from '../../deployment/intrinsic-function-resolver.js';
import { AccountIdUnavailableError, ProvisioningError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displayIdent, displaySafe, safeMsg } from '../../utils/display-safe.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../utils/json-parse-failure.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type { ResourceNotFound } from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { maskCallerIdentity, describeJsonKeys } from './caller-identity.js';
import { type IdLogSink, isLiteralDeployOnlyKey, maskLeavesDeep } from './id-log.js';

/**
 * Parse resource model JSON string.
 *
 * On a parse failure the WARN line logs the error's CLASS plus the model's
 * SHAPE. The `debug` line beside it DOES carry the raw parser message, echo
 * included, and naming that carve-out is the point (issue
 * [#3290](https://github.com/go-to-k/cdkd/issues/3290)): an unqualified
 * promise that a sibling line falsifies is exactly what that issue was filed
 * for. What follows is about the WARN line — never its
 * body (issue #1908, a GHSA-p5qg-v9gv-hc7w residual). The model is an AWS
 * readback, and a read handler cannot return write-only properties (the #809
 * premise), so the common secret shapes are absent — but a `{{resolve:...}}`
 * secret resolved into a NON-write-only property can round-trip back here,
 * and the previous `Raw model: <first 500 chars>` line would have printed it.
 * Truncation is not a mitigation: 500 characters is precisely where a
 * document's leading values sit.
 *
 * KEY NAMES are logged and values are not, which is the whole distinction —
 * a key is a property name from the type's schema, a value is the data. That
 * keeps the line diagnostic (it says WHICH document failed to parse) without
 * carrying anything sensitive.
 */
export function parseResourceModel(
  this: CloudControlProvider,
  resourceModel: string,
  log: IdLogSink = this.logger
): Record<string, unknown> {
  try {
    return JSON.parse(resourceModel) as Record<string, unknown>;
  } catch (error) {
    // The error's CLASS, never its message (issue go-to-k/cdkd#3290). The
    // comment above promises this line carries the model's SHAPE and not its
    // body, and `JSON.parse`'s own message breaks that promise: V8 ECHOES the
    // input around the failure point. Measured on Node 24 —
    // `JSON.parse('{"pw": hunter2SuperSecretValue}')` answers
    // `Unexpected token 'h', "{"pw": hunter2Sup"... is not valid JSON`, so
    // roughly thirty characters of the model reach a WARN line, i.e. default
    // verbosity. `describeAwsFailure` is the same instrument `abandonWait`
    // uses, and the `Model shape:` clause below already carries the
    // diagnosis this line exists for — WHICH document failed to parse.
    const described = describeAwsFailure(error);
    log.warn(
      `Failed to parse resource model: ${described.redacted ? described.summary : error instanceof Error ? error.name : 'Error'}\n` +
        `Model shape: ${resourceModel.length} chars, ${describeJsonKeys(resourceModel)}`
    );
    // Not at all when the call withholds its id (go-to-k/cdkd#3869): V8
    // TRUNCATES its echo, so the first characters of a longer secret-derived
    // name can print, and no needle matches a prefix. The WARN above already
    // names which document failed.
    if (log.withheld !== true) {
      log.debug(`Resource model parse failure detail: ${displaySafe(described.detail)}`);
    }
    return {};
  }
}

/**
 * Account info for an ARN / URI this provider SYNTHESIZES and records, or
 * `undefined` when it must not be built (issue
 * [#1730](https://github.com/go-to-k/cdkd/issues/1730)).
 *
 * `getAccountInfo` REFUSES when STS cannot name the account and
 * `AWS_ACCOUNT_ID` is unset. This runs AFTER the resource was created, inside
 * `enrichResourceAttributes`, so letting that refusal escape would fail a
 * create that already succeeded in AWS — and `cleanupFailedCreateRemnant`
 * does not run for it, so the resource would be orphaned.
 *
 * Omitting the attribute is the honest answer and mirrors
 * `AppSyncProvider.childImportAttributes`: the resolver then refuses an
 * `Fn::GetAtt` on it with a message naming the cause, instead of a green
 * deploy recording a value cdkd could not build, and the record heals on the
 * resource's next update. Any OTHER failure propagates as before.
 */
export async function accountInfoForSynthesizedArn(
  this: CloudControlProvider,
  resourceType: string,
  attributeName: string,
  physicalId: string,
  log: IdLogSink = this.logger
): Promise<AwsAccountInfo | undefined> {
  // The provider's OWN region, not the ambient one. `getAccountInfo()` with no
  // override resolves `process.env['AWS_REGION']`, which is process-wide and
  // cannot say which of several concurrently deploying stacks
  // (`--stack-concurrency`, default 4) is asking — so a multi-region deploy
  // could synthesize an ARN carrying a sibling stack's region (the per-stack
  // region lives in the stack AWS scope since #1981). Before issue #1746 this
  // call inherited whichever region the FIRST caller cached, which was wrong
  // in a different way; passing the client's region is the answer that is
  // right under both.
  const region = await this.cloudControlClient.config.region();
  try {
    return await getAccountInfo(region);
  } catch (error) {
    if (!(error instanceof AccountIdUnavailableError)) throw error;
    log.warn(
      `Not enriching ${resourceType} ${attributeName} for ${physicalId}: ${error.message} ` +
        `The resource itself is unaffected; the record heals on its next update.`
    );
    return undefined;
  }
}

/**
 * Generic sparse-model read-back (issue #1105). When the CREATE / UPDATE
 * `ProgressEvent.ResourceModel` yielded a sparse attribute map, issue ONE
 * best-effort `GetResource` read-back and merge the returned model over the
 * parsed attributes. Closes the "pure-CC type with a sparse CREATE model →
 * empty state attributes → `Fn::GetAtt` silently resolves to the bare
 * physicalId" class generically instead of per-type (previously fixed
 * type-by-type in #984 / #1103). Runs BEFORE `enrichResourceAttributes` so
 * the per-type overlays' `if (!enriched['X'])` gating composes naturally
 * (no second GetResource for a type the read-back already filled).
 * Best-effort: a failed read-back leaves the attributes as-is and never
 * fails the deploy (same never-throw contract as `readCcResourceModel`).
 */
export async function mergeSparseModelReadback(
  this: CloudControlProvider,
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown>,
  log: IdLogSink = this.logger
): Promise<Record<string, unknown>> {
  if (!this.isSparseAttributeMap(attributes, physicalId)) {
    return attributes;
  }
  const model = await this.readCcResourceModel(resourceType, physicalId, log);
  if (!model) {
    return attributes;
  }
  log.debug(
    `Merged CC GetResource read-back over sparse ${resourceType} attributes for ${physicalId}`
  );
  // Read-back wins: the sparseness predicate admits nothing beyond
  // identifier echoes, and on UPDATE the read-back is by definition fresher
  // than whatever the ProgressEvent omitted.
  return { ...attributes, ...model };
}

/**
 * Conservative sparseness predicate for `mergeSparseModelReadback`. A map
 * is sparse when it is empty or carries nothing beyond an echo of the
 * identifier — every value is a string equal to the physicalId or to one
 * segment of a compound `|`-joined CC primaryIdentifier. Sparseness is
 * empirically per-type: `AWS::ApiGatewayV2::Api` returns `ApiEndpoint` in
 * its CREATE model (NOT sparse — no extra GetResource), while Pipes /
 * S3 AccessPoint / ResourceGroups / Backup return nothing usable (sparse —
 * read-back fires). Any non-identifier value (a URL, an ARN, an echoed
 * input property, a nested object) means the model carried real
 * information, so we skip the extra API call.
 */
export function isSparseAttributeMap(
  this: CloudControlProvider,
  attributes: Record<string, unknown>,
  physicalId: string
): boolean {
  const values = Object.values(attributes);
  if (values.length === 0) {
    return true;
  }
  const identifierEchoes = new Set(physicalId.split('|'));
  identifierEchoes.add(physicalId);
  return values.every((value) => typeof value === 'string' && identifierEchoes.has(value));
}

/**
 * Read the Cloud Control GetResource model for a pure-CC resource and
 * return its parsed property map, or `undefined` on any failure. Types with
 * no SDK provider always route through Cloud Control, whose async CREATE
 * ResourceModel is sparse for several types, so this generic CC read-back is
 * the cleanest source of their readOnly attributes (ARNs, aliases,
 * VersionId, SelectionId) — the type's registry schema lists them under
 * readOnlyProperties, which the CC read handler does return. Originally
 * Backup-scoped (issue #984); generalized for Pipes / S3 AccessPoint /
 * ResourceGroups in issue #1103, and reused by the generic sparse-model
 * read-back (issue #1105). Best-effort: never throws.
 */
export async function readCcResourceModel(
  this: CloudControlProvider,
  resourceType: string,
  physicalId: string,
  log: IdLogSink = this.logger
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await this.cloudControlClient.send(
      new GetResourceCommand({
        TypeName: resourceType,
        Identifier: physicalId,
      })
    );
    const raw = response.ResourceDescription?.Properties;
    if (typeof raw !== 'string' || raw.length === 0) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (parseError) {
      // V8 TRUNCATES its echo of the model, so while the call withholds its
      // id (go-to-k/cdkd#3869) the first characters of a longer
      // secret-derived name can print and no needle matches a prefix: the
      // gate `parseResourceModel` applies. The snippet-free rendering keeps
      // the line diagnosable then.
      const detail =
        log.withheld === true
          ? describeJsonParseFailure(parseError, utf8ByteLength(raw))
          : displaySafe(describeAwsFailure(parseError).detail);
      log.debug(`Failed to read CC model for ${resourceType} ${physicalId}: ${detail}`);
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    log.debug(
      `Failed to read CC model for ${resourceType} ${physicalId}: ${describeAwsFailure(error).detail}`
    );
    return undefined;
  }
}

/**
 * Handle errors and throw ProvisioningError
 */
export function handleError(
  this: CloudControlProvider,
  error: unknown,
  operation: string,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): never {
  const err = error as { name?: string; message?: string };
  // AWS's text is kept, with the caller's principal ARN and account id
  // masked: a `CreateResource` / `UpdateResource` / `DeleteResource`
  // denial quotes `User: arn:aws:sts::<account>:assumed-role/...`, and this
  // message is persisted (go-to-k/cdkd#2319). `cause` keeps the raw error.
  const rawMessage = err.message || 'Unknown error';
  const awsMessage = maskCallerIdentity(rawMessage);
  if (!(error instanceof ProvisioningError) && awsMessage !== rawMessage) {
    this.logger.debug(
      `${operation} ${logicalId}: AWS error before caller-identity masking: ${displaySafe(rawMessage)}`
    );
  }

  // Check if resource type is not supported
  if (err.name === 'UnsupportedActionException' || err.name === 'TypeNotFoundException') {
    throw new ProvisioningError(
      `Resource type ${resourceType} is not supported by Cloud Control API and no SDK provider is registered.\n` +
        `Please report this issue at https://github.com/go-to-k/cdkd/issues so we can add SDK provider support.\n` +
        `Error: ${awsMessage}`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }

  // Re-throw if already a ProvisioningError
  if (error instanceof ProvisioningError) {
    throw error;
  }

  // Wrap other errors
  throw new ProvisioningError(
    `${operation} failed for ${logicalId}: ${awsMessage}`,
    resourceType,
    logicalId,
    physicalId,
    error instanceof Error ? error : undefined
  );
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(this: CloudControlProvider, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the AWS-current properties of a resource managed via Cloud Control
 * API, for `cdkd drift` comparison.
 *
 * Strategy: `GetResource(TypeName, Identifier)` returns `ResourceModel` as
 * a JSON string of every property AWS reports for the resource. Parse and
 * surface it as the AWS-current snapshot — the drift command intersects
 * this against the keys present in cdkd state, so AWS-only keys (timestamps,
 * generated ids, etc.) are filtered out at compare time.
 *
 * Returns `RESOURCE_NOT_FOUND` when Cloud Control reports the resource does
 * not exist (`ResourceNotFoundException`), which `cdkd drift` reports as
 * `deleted` (go-to-k/cdkd#4283), and `undefined` when the response had no
 * Properties field ("drift unknown"). Re-throws on any other error so the
 * drift command can surface throttling / access-denied issues to the user.
 *
 * This single CC API implementation gives drift detection coverage to every
 * resource type that goes through CC API — the majority of cdkd's surface.
 * SDK Providers add their own `readCurrentState` incrementally (PR D).
 */
export async function readCurrentState(
  this: CloudControlProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  try {
    const response = await this.cloudControlClient.send(
      new GetResourceCommand({
        TypeName: resourceType,
        Identifier: physicalId,
      })
    );

    const raw = response.ResourceDescription?.Properties;
    if (typeof raw !== 'string' || raw.length === 0) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (parseError) {
      // V8's `SyntaxError` quotes a window of the model, which can hold a
      // plaintext property value, and the raw error reached `cdkd drift`'s
      // and `cdkd state refresh-observed`'s warn lines (issue #5254). So
      // V8's text goes to `debug` only, and what is thrown names the type,
      // the failure's offset when V8 reports one, and the model's size, with
      // no cause. It stays
      // a `SyntaxError`: `refresh-observed` routes that class to a
      // class-only line.
      this.logger.debug(
        safeMsg`Cloud Control resource model for ${displayIdent(resourceType)} failed to parse: ${parseFailureDebugDetail(parseError)}`
      );
      throw new SyntaxError(
        `Cloud Control returned a resource model for ${displayIdent(resourceType)} that is not ` +
          `valid JSON: ${describeJsonParseFailure(parseError, utf8ByteLength(raw))}`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === 'ResourceNotFoundException') {
      return RESOURCE_NOT_FOUND;
    }
    throw error;
  }
}

/**
 * The deploy-side half of the attribute narrowing (issue #2925; the import
 * side is {@link maskUncertifiedModelValues}). Every MODEL key of a
 * create / update result that is not an `Fn::GetAtt` attribute of the type
 * has its leaves replaced with {@link SECRET_MASK}, container shape kept.
 * Without it the first deploy after `cdkd import` rewrote the narrowed bag
 * with the whole model.
 *
 * THE DEPLOY'S SET IS WIDER THAN THE IMPORT'S, on purpose: every attribute
 * the resource specification lists stays clear
 * (`getTopLevelDeployAttributeNames`: the import's certified set plus the
 * shape-mismatched writable attributes, e.g. `AWS::DocDB::DBCluster` `Port`,
 * which CDK's `allowDefaultPortFrom` reads), because the deploy recorded
 * them before this narrowing and a template CloudFormation accepts reads
 * them. The one writable attribute held back for secrecy, `AWS::SSM::Parameter`
 * `Value`, stays clear unless the run's secret masker derives it from a
 * secret ({@link isLiteralDeployOnlyKey}). The schema lookup is started when the
 * create / update starts (`attributeNamesLookup`), so it adds no round trip
 * after it.
 *
 * MASK, never drop, for the reason the import side states: a missing key
 * makes `resolveGetAtt` fall back to the physical id, a wrong value sent to
 * AWS, where a masked one is refused by name.
 *
 * ONLY MODEL KEYS (`modelKeys`, taken before enrichment). The enrichment
 * adds computed attributes, some under flat dotted names (`Endpoint.Port`)
 * that no top-level set lists; those are attributes by construction.
 *
 * AN UNRESOLVABLE SCHEMA KEEPS THE MODEL, the OPPOSITE of the import side's
 * fail-closed arm, deliberately. On import, masking everything costs a
 * named refusal for one adopted resource until its next deploy. Here it
 * would refuse every `Fn::GetAtt` of every Cloud-Control-routed resource
 * for a user without `cloudformation:DescribeType`, on every deploy, with
 * no deploy left to clear it. Keeping the model is the behaviour before this
 * narrowing existed, and the deploy path's `scrubResourceRecord` still
 * redacts every template-sourced secret on save. Masking everything would
 * not take such a value out of `state.json` either: the drift baseline
 * (`observedProperties`, captured from `readCurrentState` unless
 * `--no-capture-observed-state`) holds the whole model whatever this
 * method does. This narrowing therefore closes the `attributes` copy, the
 * one `Fn::GetAtt` and same-run dependents read, not every copy.
 *
 * The bag is null-prototype for the same reason as the import side: a model
 * key `__proto__` must stay an own key.
 */
export async function maskDeployedNonAttributeKeys(
  this: CloudControlProvider,
  attributes: Record<string, unknown>,
  modelKeys: readonly string[],
  resourceType: string,
  physicalId: string,
  attributeNamesLookup: Promise<ReadonlySet<string> | undefined>,
  desired: Record<string, unknown>,
  mask: MaskerFn,
  log: IdLogSink = this.logger
): Promise<Record<string, unknown>> {
  const safeType = displaySafe(resourceType, { asciiOnly: true });
  const attributeNames = await attributeNamesLookup;
  if (attributeNames === undefined) {
    log.debug(
      `Could not resolve the CloudFormation schema for ${safeType}; recording its Cloud ` +
        `Control model unnarrowed for ${displaySafe(physicalId, { asciiOnly: true })}.`
    );
    return attributes;
  }
  const narrowed = new Set(
    modelKeys.filter(
      (key) => !attributeNames.has(key) && !isLiteralDeployOnlyKey(resourceType, key, desired, mask)
    )
  );
  if (narrowed.size === 0) return attributes;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(attributes)) {
    Object.defineProperty(out, key, {
      value: narrowed.has(key) ? maskLeavesDeep(value) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  log.debug(
    `Masked ${narrowed.size} non-attribute key(s) of the ${safeType} Cloud Control model for ` +
      `${displaySafe(physicalId, { asciiOnly: true })}: they are not Fn::GetAtt attributes of the type.`
  );
  return out;
}
