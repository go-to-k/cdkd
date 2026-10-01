import * as zlib from 'node:zlib';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  DeleteFunctionConcurrencyCommand,
  GetFunctionConcurrencyCommand,
  GetFunctionRecursionConfigCommand,
  GetFunctionCodeSigningConfigCommand,
  GetRuntimeManagementConfigCommand,
  PutFunctionConcurrencyCommand,
  PutFunctionRecursionConfigCommand,
  PutFunctionCodeSigningConfigCommand,
  PutRuntimeManagementConfigCommand,
  DeleteFunctionCodeSigningConfigCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
  type FunctionCode,
  type CreateFunctionCommandInput,
  type UpdateFunctionConfigurationCommandInput,
  type UpdateFunctionCodeCommandInput,
  type Runtime,
  type Architecture,
  type TracingConfig,
  type EphemeralStorage,
  type VpcConfig,
  type DeadLetterConfig,
  type FileSystemConfig,
  type ImageConfig,
  type SnapStart,
  type LoggingConfig,
  type RecursiveLoop,
  type DurableConfig,
  type TenancyConfig,
  type UpdateRuntimeOn,
} from '@aws-sdk/client-lambda';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
  DeleteNetworkInterfaceCommand,
} from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import {
  isRetryableTransientError,
  markNonRetryable,
  markRedactedCause,
} from '../../deployment/retryable-errors.js';
import { generateResourceName } from '../resource-name.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
} from '../../types/resource.js';
import {
  createMaskedLogSinks,
  isSecretDerivedValue,
  maskDeep,
  MASK_WALK_DEPTH_CAP_MARKER,
  MASK_WALK_MAX_DEPTH,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { withRemovalDefaults } from '../update-removal.js';

/** `[raw template value, function name it became]` (see {@link lambdaOperationSinks}). */
type NamePair = readonly [raw: unknown, name: string | undefined];

/**
 * Shortest function name {@link lambdaOperationSinks} makes a SUBSTRING needle.
 * A needle is replaced wherever it occurs, cdkd's own fixed wording included,
 * so a very short secret would mask letters of `Updating Lambda function` and
 * the masked positions would hint at it. The same floor as the Glue slice
 * (`glue-provider.ts`); it narrows that hint rather than closing it.
 *
 * Below the floor a secret name is still hidden at every site cdkd interpolates
 * it: those sites mask the value RAW, and the sinks render a secret-derived name
 * as `***` by whole-value equality, including a ROTATED recorded name whose old
 * plaintext is in no bag of this deploy. Only an AWS echo of a 1-2 character
 * name goes unmasked.
 */
const SELF_NEEDLE_MIN_LENGTH = 3;

/**
 * The masked sinks ONE Lambda `create()` / `update()` logs and refuses through
 * (issue [#2177](https://github.com/go-to-k/cdkd/issues/2177)):
 * `createMaskedLogSinks` over the context's masker, extended by `pairs`. A
 * function name is used verbatim (never rewritten from a secret), so what the
 * base masker cannot know is only a name RECORDED from a previous secret: state
 * persists that value as its `{{resolve:` reference (or as `***`), and after a
 * rotation the old plaintext is in no bag of this deploy. Each name whose raw
 * value is secret-derived (`isSecretDerivedValue`) is:
 *
 *  - rendered as `***` wherever a sink masks it as a WHOLE value, at any length;
 *  - and, at {@link SELF_NEEDLE_MIN_LENGTH} or longer, a substring needle, so it
 *    is also masked where it OCCURS inside other text (an AWS echo, an ARN).
 *
 * Built per call; never cached on the provider, which serves concurrent
 * resources.
 */
function lambdaOperationSinks(
  logger: { debug(message: string): void; warn(message: string): void },
  maskSecrets: MaskerFn | undefined,
  namePairs: readonly NamePair[],
  bag?: unknown
): MaskedLogSinks {
  const base = createMaskedLogSinks(logger, maskSecrets);
  const pairs = [...namePairs, ...jsonEscapedPairs(bag)];
  const secretNames = new Set<string>();
  for (const [raw, name] of pairs) {
    if (typeof name === 'string' && name !== '' && isSecretDerivedValue(raw, base.mask)) {
      secretNames.add(name);
    }
  }
  // The ORIGINAL pairs, not `[name, name]`: a rotated recorded name qualifies
  // only through its PREVIOUS raw value, so the name alone would fail the
  // predicate and an AWS error quoting it would print it.
  const needled = withDerivedNameMasks(
    logger,
    base,
    pairs.filter(
      (pair): pair is readonly [unknown, string] =>
        typeof pair[1] === 'string' && pair[1].length >= SELF_NEEDLE_MIN_LENGTH
    )
  );
  if (secretNames.size === 0) return needled;
  const mask: MaskerFn = (text: string) =>
    secretNames.has(text) ? MASK_WALK_DEPTH_CAP_MARKER : needled.mask(text);
  return {
    mask,
    value: (value: unknown) => mask(String(value)),
    debug: (message: string) => logger.debug(mask(message)),
    warn: (message: string) => logger.warn(mask(message)),
  };
}

/**
 * `[leaf, its JSON-escaped spelling]` for every string leaf of `bag` that
 * `JSON.stringify` would change, plus the twice-escaped spelling (JSON inside a
 * JSON string). A literal masker cannot find a secret once `"`, `\` or a
 * newline in it is escaped, and AWS quotes request content back that way: the
 * `Environment` 4 KB refusal prints the whole variables map as JSON. Fed to
 * {@link lambdaOperationSinks} as derived-name pairs, so a leaf counts only
 * when it is secret-derived and is masked base-first, like any other needle.
 */
function jsonEscapedPairs(bag: unknown): NamePair[] {
  const out: NamePair[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      const once = JSON.stringify(value).slice(1, -1);
      // An escape-free leaf adds nothing here: its literal spelling is the
      // base masker's (and the name pairs') job, with their floors.
      if (once === value) return;
      out.push([value, once]);
      out.push([value, JSON.stringify(once).slice(1, -1)]);
      return;
    }
    if (depth >= MASK_WALK_MAX_DEPTH || typeof value !== 'object' || value === null) return;
    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
      walk(entry, depth + 1);
    }
  };
  walk(bag, 0);
  return out;
}

/**
 * The function's own status fields out of a `GetFunction` response, as
 * `Key=value` parts. Literal reads, not a loop over a key table: only
 * AWS-authored status fields, never a template-derived one.
 */
function lambdaStatusParts(response: unknown): string[] {
  const config = (response as { Configuration?: unknown } | null | undefined)?.Configuration;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return [];
  const fields = config as Record<string, unknown>;
  const status: Array<[string, unknown]> = [
    ['State', fields['State']],
    ['StateReasonCode', fields['StateReasonCode']],
    ['StateReason', fields['StateReason']],
    ['LastUpdateStatus', fields['LastUpdateStatus']],
    ['LastUpdateStatusReasonCode', fields['LastUpdateStatusReasonCode']],
    ['LastUpdateStatusReason', fields['LastUpdateStatusReason']],
  ];
  const parts: string[] = [];
  for (const [key, value] of status) {
    if (typeof value === 'string' && value !== '') parts.push(`${key}=${value}`);
  }
  return parts;
}

/**
 * An `@smithy/util-waiter` error, described without its payload, or
 * `undefined` when `error` is not one (its message is not a JSON object
 * carrying a `state`).
 *
 * - A FAILURE throws `JSON.stringify(result)`, whose `reason` is the whole
 *   `GetFunction` response: `Configuration.Environment.Variables` in
 *   plaintext and the presigned `Code.Location`. `JSON.stringify` escapes a
 *   secret containing `"`, `\\` or a newline out of literal reach,
 *   `Code.Location` is in no secrets bag, and a function still holding a
 *   ROTATED secret's old plaintext holds one no bag of this deploy knows. So
 *   `reason` is WITHHELD: only the function's status fields, or an
 *   error-matching acceptor's exception name and `Message`, are kept.
 * - A TIMEOUT or ABORT carries a fixed `reason` and `observedResponses`, keyed
 *   by `createMessageFromResponse`: `<status>: OK` for a successful poll,
 *   `<status>: <AWS message>` for an error poll. Those status lines are the
 *   diagnosis (and the retry wording, such as `not authorized to perform`),
 *   so they are KEPT. A key that is itself a JSON document (a response with no
 *   status, which the SDK never produces) or that quotes a response body
 *   (`Deserialization error for body:`) is withheld instead.
 *
 * Everything kept goes through the operation's masker afterwards.
 */
function describeLambdaWaiterFailure(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('state' in parsed)) return undefined;
  const result = parsed as { state?: unknown; reason?: unknown; observedResponses?: unknown };
  const parts = lambdaStatusParts(result.reason);
  const reason = result.reason;
  if (typeof reason === 'object' && reason !== null) {
    // An error-matching acceptor hands back the SDK exception. Its own
    // `message` is non-enumerable and so never serialized; `Message` is the
    // AWS-modelled field that is.
    const r = reason as { name?: unknown; Message?: unknown };
    const name = typeof r.name === 'string' ? r.name : undefined;
    const message = typeof r.Message === 'string' ? r.Message : undefined;
    if (name !== undefined || message !== undefined) {
      parts.push(`error=${[name, message].filter((v) => v !== undefined).join(': ')}`);
    }
  }
  const observed = result.observedResponses;
  if (typeof observed === 'object' && observed !== null && !Array.isArray(observed)) {
    let withheldKeys = 0;
    const statusLines: Array<{ line: string; classifies: boolean }> = [];
    for (const [key, count] of Object.entries(observed)) {
      if (isResponseBodyKey(key)) {
        withheldKeys += 1;
        continue;
      }
      statusLines.push({
        line: `${key} (x${String(count)})`,
        classifies: classifiesAsRetryable(key),
      });
    }
    // Bounded: a service varying its error text per poll must not turn one
    // line into hundreds of entries. Two budgets, each keeping its LAST lines
    // (insertion order is first-seen order): lines carrying retry wording the
    // classifiers read (`not authorized to perform`, a throttle, ...) are
    // capped separately, so an early one is not crowded out by later plain
    // lines. First-seen order is kept in the output.
    const keep = new Set<number>();
    for (const classifies of [true, false]) {
      const indexes = statusLines.flatMap((entry, i) =>
        entry.classifies === classifies ? [i] : []
      );
      for (const i of indexes.slice(-MAX_OBSERVED_STATUS_LINES)) keep.add(i);
    }
    const omittedKeys = statusLines.length - keep.size;
    if (omittedKeys > 0) parts.push(`${omittedKeys} more observed status line(s) omitted`);
    parts.push(...statusLines.flatMap((entry, i) => (keep.has(i) ? [entry.line] : [])));
    if (withheldKeys > 0) parts.push(`${withheldKeys} observed response(s) withheld`);
  }
  const state = typeof result.state === 'string' ? result.state : 'failure';
  const fixed = typeof reason === 'string' && reason !== '' ? `: ${reason}` : '';
  return (
    `waiter ${state}${fixed} ` +
    `(${parts.length > 0 ? parts.join(', ') : 'no function status reported'}). ` +
    `Any response payload is withheld because it embeds the whole GetFunction ` +
    `response, environment variables included; run \`aws lambda get-function\` for the detail.`
  );
}

/**
 * Is an `observedResponses` key a response BODY rather than a status line: a
 * JSON document (`createMessageFromResponse`'s last resort for a response with
 * no status) or a deserialization failure quoting the body?
 */
function isResponseBodyKey(key: string): boolean {
  if (/(?:^|: )Deserialization error for body:/.test(key)) return true;
  // Shaped like a document, parseable or not: withhold rather than guess. A
  // status line always starts with its status code. `reason` is always an
  // object, so smithy's body key starts with `{`; `[` is defensive.
  return key.startsWith('{') || key.startsWith('[');
}

/**
 * How many distinct observed status lines a waiter description keeps, per
 * budget (retry-wording lines and the rest).
 */
const MAX_OBSERVED_STATUS_LINES = 5;

/**
 * Does a status line carry wording `withRetry`'s substring classifiers read?
 * `RETRYABLE_ERROR_MESSAGE_PATTERNS` already spreads the IAM-propagation
 * patterns, so no separate `isIamPropagationError` arm is needed.
 */
function classifiesAsRetryable(line: string): boolean {
  return isRetryableTransientError(undefined, line);
}

/**
 * If `error` is a failed Lambda waiter, overwrite its `message` (and the first
 * line of its `stack`) IN PLACE with the MASKED
 * {@link describeLambdaWaiterFailure} text, and return both spellings;
 * otherwise return `undefined` and leave `error` alone.
 *
 * In place, not by wrapping, because the caught error must stay the direct
 * `cause` (the classifiers read its fields through the chain, and
 * `scripts/check-provider-error-cause.ts` requires the caught value itself).
 * MASKED there, with the OPERATION's masker, because a printer rendering the
 * provider error prints this link as its `Caused by:` line, and only the
 * operation's masker knows the derived needles (a 3-character name, a rotated
 * recorded name, a JSON-escaped secret) the engine's bag does not.
 *
 * The UNMASKED described text (payload-free: state, status fields and AWS
 * status lines only) rides one level deeper, as this link's own `cause`, when
 * the mask changed it. That is the link `retryClassificationText` reads to keep
 * AWS's wording whole (a needle cutting `not authorized to perform` must not
 * turn a retryable failure terminal). `formatError` prints one cause level and
 * never reaches it. The only multi-level renderer, `runCli`'s fatal
 * `console.error('Fatal error:', error)` (`src/cli/run-cli.ts`), would print
 * it in full, and is reachable only if a command escapes `withErrorHandling`
 * (whose `handleError` always exits): every `.action(` is wrapped today.
 */
function withholdWaiterPayload(
  error: unknown,
  mask: MaskerFn
): { masked: string; described: string } | undefined {
  const described = describeLambdaWaiterFailure(error);
  if (described === undefined || !(error instanceof Error)) return undefined;
  const text = mask(described);
  const original = error.message;
  const header = `${error.name}: ${original}`;
  const stack = typeof error.stack === 'string' ? error.stack : '';
  try {
    Object.defineProperty(error, 'message', {
      value: text,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(error, 'stack', {
      value: stack.startsWith(header)
        ? `${error.name}: ${text}${stack.slice(header.length)}`
        : `${error.name}: ${text}`,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    // Unprinted only while every command stays inside `withErrorHandling`:
    // `runCli`'s fatal `console.error` would `util.inspect` this link.
    if (text !== described && (error as { cause?: unknown }).cause === undefined) {
      Object.defineProperty(error, 'cause', {
        value: new Error(described),
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  } catch {
    // A frozen error cannot be rewritten: the wrap's message still withholds
    // the payload, but the `Caused by:` line would not. Unreachable for
    // `@smithy/util-waiter`, which throws a plain, extensible `Error`.
  }
  return { masked: text, described };
}

/**
 * Attempts the create path's atomicity cleanup makes when DeleteFunction is
 * refused because the function is still settling. Three attempts with the
 * linear backoff in `cleanupDeleteRetryDelayMs` covers the few seconds a
 * `Pending` -> terminal transition takes without stalling a failed deploy.
 */
const LAMBDA_CLEANUP_DELETE_MAX_ATTEMPTS = 3;

/**
 * Refuse `CodeSigningConfigArn` / `RuntimeManagementConfig` on a
 * container-image function (`PackageType: Image`), BEFORE any Lambda call.
 * AWS rejects both there with `InvalidParameterValueException`: the image
 * carries its own runtime, so there are no runtime-management controls, and
 * Lambda code signing does not apply to images (issue
 * [#1894](https://github.com/go-to-k/cdkd/issues/1894)). The READ side skips
 * the matching `Get*` calls for the same reason (see `readCurrentState`). Without it the create either
 * fails on `CreateFunction` (code signing) or creates the function, fails the
 * post-create `PutRuntimeManagementConfig` and deletes it again; the update
 * fails part-way through on the Put.
 *
 * Unconditional, including on a rollback replay (`replayingState`): AWS
 * rejects the combination every time, so no state record can carry it and a
 * downgraded warning could only report success over a call that then fails
 * (the `.claude/rules/provider-replay-and-refusals.md` exception).
 */
function refuseImageFunctionUnsupported(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  physicalId?: string
): void {
  if (properties['PackageType'] !== 'Image') return;
  // Literal reads, not a loop over a name table: the handled-property wiring
  // walk records a computed key as a whole-bag blind spot.
  const declared = [
    properties['CodeSigningConfigArn'] !== undefined ? 'CodeSigningConfigArn' : undefined,
    properties['RuntimeManagementConfig'] !== undefined ? 'RuntimeManagementConfig' : undefined,
  ].filter((key): key is string => key !== undefined);
  if (declared.length === 0) return;
  // `markNonRetryable`: the message interpolates the user-chosen logical id,
  // which the substring retry table must not be able to match.
  throw markNonRetryable(
    new ProvisioningError(
      `Lambda function ${logicalId} is a container-image function (PackageType: Image), ` +
        `and AWS rejects ${declared.join(' and ')} on one: an image carries its own runtime ` +
        `and Lambda code signing does not apply to images. Remove ` +
        `${declared.length === 1 ? 'it' : 'them'} from the function's properties.`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * Pick the inline-code filename for a Lambda runtime.
 *
 * CloudFormation's `Code.ZipFile` auto-zips inline code into a file named
 * `index.<ext>` where the extension matches the runtime (`index.js` for
 * `nodejs*`, `index.py` for `python*`). The Lambda SDK's `ZipFile` parameter
 * accepts a binary zip but does no equivalent runtime-aware naming, so we
 * have to mirror the CFn behavior here. Defaults to `index.js` since `nodejs`
 * is the only `Code.fromInline`-supported runtime alongside `python` and is
 * the more common case in CDK apps.
 */
export function inlineCodeFileNameForRuntime(runtime: string | undefined): string {
  if (runtime?.startsWith('python')) return 'index.py';
  return 'index.js';
}

/**
 * AWS Lambda Function Provider
 *
 * Implements resource provisioning for AWS::Lambda::Function using the Lambda SDK.
 * WHY: Lambda CreateFunction is synchronous - the CC API adds unnecessary polling
 * overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class LambdaFunctionProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private ec2Client: EC2Client;
  private logger = getLogger().child('LambdaFunctionProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Function',
      new Set([
        'FunctionName',
        'Code',
        'Role',
        'Tags',
        'Handler',
        'Runtime',
        'Timeout',
        'MemorySize',
        'Description',
        'Environment',
        'Layers',
        'Architectures',
        'PackageType',
        'TracingConfig',
        'EphemeralStorage',
        'VpcConfig',
        'DeadLetterConfig',
        'KmsKeyArn',
        'FileSystemConfigs',
        'ImageConfig',
        'SnapStart',
        'LoggingConfig',
        'RecursiveLoop',
        'ReservedConcurrentExecutions',
        'CodeSigningConfigArn',
        'RuntimeManagementConfig',
        'DurableConfig',
        'TenancyConfig',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalDefaults`): the CFn default each
   * UpdateFunctionConfiguration field is reset to when the template removes
   * it, since an absent field there means "no change" (#1155, #1157).
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::Lambda::Function',
      new Map<string, unknown>([
        ['Timeout', 3],
        ['MemorySize', 128],
        // Empty string clears the description.
        ['Description', ''],
        // Empty Variables map removes all env vars (the whole-block removal
        // twin of the per-key removal the diff already handles).
        ['Environment', { Variables: {} }],
        // Empty list detaches all layers.
        ['Layers', []],
        ['TracingConfig', { Mode: 'PassThrough' }],
        ['EphemeralStorage', { Size: 512 }],
        // Empty TargetArn detaches the DLQ.
        ['DeadLetterConfig', { TargetArn: '' }],
        // Empty string resets to the AWS-managed default key.
        ['KmsKeyArn', ''],
        // Empty list removes all EFS mounts.
        ['FileSystemConfigs', []],
        // Empty object resets container image overrides to the image defaults.
        ['ImageConfig', {}],
        // ApplyOn: 'None' disables SnapStart.
        ['SnapStart', { ApplyOn: 'None' }],
        // LogFormat: 'Text' is the CFn default (Text format clears the
        // JSON-only ApplicationLogLevel / SystemLogLevel filters).
        ['LoggingConfig', { LogFormat: 'Text' }],
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every other
   * property whose removal `update()` handles. `RecursiveLoop` is absent on
   * purpose: a removal keeps its live value, so the caller names it.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Function',
      new Set([
        // Required, or create-only (a removal replaces the function).
        'Code',
        'Role',
        'Handler',
        'Runtime',
        'FunctionName',
        'PackageType',
        'TenancyConfig',
        // A presence toggle is routed to replacement (replacement-rules.ts).
        'DurableConfig',
        // Diffed, or reset by their own call.
        'Tags',
        'Architectures',
        'VpcConfig',
        'ReservedConcurrentExecutions',
        'CodeSigningConfigArn',
        'RuntimeManagementConfig',
      ]),
    ],
  ]);

  /**
   * Properties the provider deliberately does NOT wire (issue #391 /
   * see `ResourceProvider.unhandledByDesign`).
   *
   * `CapacityProviderConfig` / `FunctionScalingConfig` are deliberately NOT
   * here — they stay in `silentDrop` (pre-flight rejection with the
   * `--allow-unsupported-properties` escape hatch) rather than being declared
   * un-wirable, because they ARE wirable once Lambda managed instances are
   * supported. They are one coupled feature: `PutFunctionScalingConfig` fails
   * with `AccessDeniedException: The function provided by the arn does not
   * contain a capacity provider configuration` unless the function already
   * carries a capacity provider (live-probed us-east-1, 2026-08-11). Tracked
   * in issue #1616.
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Lambda::Function',
      new Map([
        [
          'PublishToLatestPublished',
          // A CloudFormation-ORCHESTRATION directive, not a Lambda API field:
          // it tells CFn whether to move the `$LATEST.PUBLISHED` pointer as
          // part of the stack update. `@aws-sdk/client-lambda` 3.1018.0 has no
          // corresponding member on ANY request shape (verified by grepping
          // the whole dist-types tree: 0 hits, while the other six silent-drop
          // properties of this type all resolve to real members), so there is
          // nothing for an SDK provider to send. cdkd has no CFn-side
          // version-publishing step to gate, so the flag is inert here.
          'CloudFormation-only version-publishing directive with no AWS SDK equivalent',
        ],
      ]),
    ],
  ]);

  // ENI detach polling configuration (overridable for tests).
  // Lambda VPC ENI detach is async and can take 20-40 minutes in the worst case;
  // we poll up to 10 minutes and then warn-and-continue, since downstream Subnet/SG
  // deletion has its own retry logic that handles a small remaining window.
  // Budget for waiting on UpdateFunctionConfiguration to fully apply
  // (LastUpdateStatus -> Successful) after pre-delete VPC detach.
  // Cleanup-delete retry budget for `applyPostCreateConfig` (see there): a
  // function that is still `Pending` rejects DeleteFunction, so the atomicity
  // cleanup needs a few bounded attempts rather than one shot. Overridable in
  // tests so the retry path costs no wall-clock.
  private readonly cleanupDeleteRetryDelayMs: number = 2000;

  private readonly eniWaitTimeoutMs: number = 10 * 60 * 1000;
  private readonly eniWaitInitialDelayMs: number = 10_000;
  private readonly eniWaitMaxDelayMs: number = 10_000;

  // Budget for the post-Update wait that blocks until LastUpdateStatus
  // === 'Successful'. Required to prevent the SECOND in-flight call (e.g.
  // UpdateFunctionCode immediately after UpdateFunctionConfiguration)
  // from racing the first with "function is currently in the following
  // state: InProgress". Update typically settles in seconds; the 10-min
  // cap is generous slack for layer-update / VPC-detach edge cases.
  // Seconds (the SDK waiter contract is seconds, not ms).
  //
  // The post-CreateFunction `State=Active` wait used to live here too
  // (PR #121) but doubled deploy time on benchmark stacks because every
  // Lambda paid the cost regardless of whether anything synchronously
  // invoked it. The Active wait now lives in `CustomResourceProvider`
  // (the only deploy-time consumer that breaks against Pending).
  private readonly functionUpdateMaxWaitSeconds: number = 10 * 60;

  // delstack-style ENI cleanup tunables.
  // - initial sleep: gives AWS time to publish post-detach ENI state via
  //   DescribeNetworkInterfaces (right after the update, the API can return
  //   an empty list even though ENIs still exist).
  // - per-ENI retry budget: an in-use ENI cannot be deleted until AWS
  //   finishes the asynchronous detach. AWS's hyperplane ENI release is
  //   eventually-consistent and can take 5-30 minutes in practice — the
  //   budget here must cover that worst case so downstream Subnet/SG
  //   deletes don't race ahead and fail with "has dependencies".
  // - retry interval: polling cadence inside the per-ENI loop.
  private readonly eniInitialSleepMs: number = 10_000;
  private readonly eniDeleteRetryBudgetMs: number = 30 * 60 * 1000;
  private readonly eniDeleteRetryIntervalMs: number = 15_000;

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
    this.ec2Client = awsClients.ec2;
  }

  /**
   * Create a Lambda function
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const functionName =
      (properties['FunctionName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
    // Issue #2177: every create() line and refusal goes through this one sink
    // set. A provider's own logger reaches no engine mask.
    const log = lambdaOperationSinks(
      this.logger,
      context?.maskSecrets,
      [[properties['FunctionName'], functionName]],
      properties
    );

    log.debug(`Creating Lambda function ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const code = properties['Code'] as Record<string, unknown> | undefined;
    const role = properties['Role'] as string | undefined;

    if (!code) {
      throw new ProvisioningError(
        `Code is required for Lambda function ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!role) {
      throw new ProvisioningError(
        `Role is required for Lambda function ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    refuseImageFunctionUnsupported(logicalId, resourceType, properties);

    // Set once CreateFunction returns: every failure after it is an auxiliary
    // call's and must not classify as this function's name collision (#3826).
    let functionCreated = false;
    try {
      // Build tags map from CDK tag format [{Key, Value}]
      const tags: Record<string, string> | undefined = properties['Tags']
        ? Object.fromEntries(desiredTags.map((tag) => [tag.Key, tag.Value]))
        : undefined;

      const createParams: CreateFunctionCommandInput = {
        FunctionName: functionName,
        Role: role,
        Code: this.buildCode(code, properties['Runtime'] as string | undefined),
        Handler: properties['Handler'] as string | undefined,
        Runtime: properties['Runtime'] as Runtime | undefined,
        Timeout: properties['Timeout'] as number | undefined,
        MemorySize: properties['MemorySize'] as number | undefined,
        Description: properties['Description'] as string | undefined,
        Environment: properties['Environment'] as
          | { Variables?: Record<string, string> }
          | undefined,
        Layers: properties['Layers'] as string[] | undefined,
        Architectures: properties['Architectures'] as Architecture[] | undefined,
        PackageType: properties['PackageType'] as 'Zip' | 'Image' | undefined,
        TracingConfig: properties['TracingConfig'] as TracingConfig | undefined,
        EphemeralStorage: properties['EphemeralStorage'] as EphemeralStorage | undefined,
        VpcConfig: this.buildVpcConfig(properties['VpcConfig']),
        DeadLetterConfig: properties['DeadLetterConfig'] as DeadLetterConfig | undefined,
        // CFn names this `KmsKeyArn`; the Lambda SDK input field is `KMSKeyArn`.
        KMSKeyArn: properties['KmsKeyArn'] as string | undefined,
        FileSystemConfigs: properties['FileSystemConfigs'] as FileSystemConfig[] | undefined,
        ImageConfig: properties['ImageConfig'] as ImageConfig | undefined,
        SnapStart: properties['SnapStart'] as SnapStart | undefined,
        LoggingConfig: properties['LoggingConfig'] as LoggingConfig | undefined,
        // Durable-execution retention / timeout. CREATE-ONLY IN PRACTICE
        // even though UpdateFunctionConfiguration declares the member:
        // AWS rejects adding one to a function created without it
        // ("You cannot add a durable configuration to a function that was
        // originally created with no durable configuration" —
        // InvalidParameterValueException, live-probed us-east-1 2026-08-11),
        // and omitting it on update KEEPS the live value rather than
        // resetting it. Both transitions are therefore routed to REPLACEMENT
        // by the conditional rule in `replacement-rules.ts`; a change with
        // the block present on both sides IS applied in place.
        DurableConfig: properties['DurableConfig'] as DurableConfig | undefined,
        // Tenant isolation mode. Create-only per the CFn registry schema
        // (`createOnlyProperties`) AND per the SDK — the member exists on
        // CreateFunctionRequest and NOT on UpdateFunctionConfigurationRequest.
        TenancyConfig: properties['TenancyConfig'] as TenancyConfig | undefined,
        // Code-signing enforcement. Settable on create; on update it moves to
        // the separate Put/DeleteFunctionCodeSigningConfig control-plane pair
        // (there is no member on UpdateFunctionConfiguration).
        CodeSigningConfigArn: properties['CodeSigningConfigArn'] as string | undefined,
        Tags: tags,
      };

      const response = await this.lambdaClient.send(new CreateFunctionCommand(createParams));
      functionCreated = true;

      // RecursiveLoop is a post-create control-plane prop: AWS sets it via
      // a SEPARATE `PutFunctionRecursionConfig` API, NOT on `CreateFunction`.
      // Wire it after a successful function create. If this call fails, the
      // function exists on AWS without the user-requested config — clean up
      // by deleting the function (atomicity) so the next deploy retry sees
      // a fresh slate instead of an orphan that already exists.
      //
      // VPC-attached Lambda caveat: the cleanup uses a bare `DeleteFunction`
      // (not the provider's own `delete()`), so hyperplane ENIs are NOT
      // pre-detached / awaited. For a VPC-attached function whose Put
      // fails, the next deploy retry's downstream Subnet/SG creation can
      // race the asynchronous ENI release (5-30min in practice) until AWS
      // finishes the detach. The "concurrent update operation" substring
      // is preserved in the wrapped error message so the outer
      // `withRetry` classifier still retries cleanly; non-transient Put
      // failures surface to the user as the named ProvisioningError below.
      const recursiveLoop = properties['RecursiveLoop'] as RecursiveLoop | undefined;
      if (recursiveLoop !== undefined) {
        await this.applyPostCreateConfig(
          () =>
            this.lambdaClient.send(
              new PutFunctionRecursionConfigCommand({
                FunctionName: functionName,
                RecursiveLoop: recursiveLoop,
              })
            ),
          {
            apiName: 'PutFunctionRecursionConfig',
            propertyName: 'RecursiveLoop',
            logicalId,
            resourceType,
            functionName,
            log,
          }
        );
      }

      // ReservedConcurrentExecutions: post-create control-plane prop set
      // via a SEPARATE `PutFunctionConcurrency` API (NOT on CreateFunction).
      // Same atomicity contract as RecursiveLoop above: on failure delete
      // the just-created function so the next deploy retry sees a fresh
      // slate. The VPC ENI caveat applies identically (see the RecursiveLoop
      // comment for the full detail). A value of 0 is meaningful — it
      // throttles the function to zero concurrency — so the gate uses
      // `!== undefined`, NOT a truthy check.
      const reservedConcurrentExecutions = properties['ReservedConcurrentExecutions'] as
        | number
        | undefined;
      if (reservedConcurrentExecutions !== undefined) {
        await this.applyPostCreateConfig(
          () =>
            this.lambdaClient.send(
              new PutFunctionConcurrencyCommand({
                FunctionName: functionName,
                ReservedConcurrentExecutions: reservedConcurrentExecutions,
              })
            ),
          {
            apiName: 'PutFunctionConcurrency',
            propertyName: 'ReservedConcurrentExecutions',
            logicalId,
            resourceType,
            functionName,
            log,
          }
        );
      }

      // RuntimeManagementConfig: a third post-create control-plane prop, set
      // via `PutRuntimeManagementConfig` (NOT on CreateFunction — the SDK
      // declares no member for it on any create/update request shape). Same
      // atomicity contract as the two above.
      const runtimeManagementConfig = properties['RuntimeManagementConfig'] as
        | Record<string, unknown>
        | undefined;
      if (runtimeManagementConfig !== undefined) {
        await this.applyPostCreateConfig(
          async () => {
            // UNLIKE its two siblings, this API REJECTS a function that is
            // still settling: `CreateFunction` returns while the function is
            // `Pending`, and `PutRuntimeManagementConfig` answers "The
            // operation cannot be performed at this time. The resource ... is
            // currently in the following state: 'Pending'" (caught by the
            // lambda-config-field-removal integ, 2026-08-11 — the unit tests
            // mock the call and cannot see it). PutFunctionRecursionConfig and
            // PutFunctionConcurrency both accept a Pending function, which is
            // why neither needed this.
            //
            // The wait is deliberately INSIDE this `if`, not hoisted after
            // CreateFunction: the provider's documented design is to NOT block
            // the deploy DAG on every Lambda's Active transition (5-10 min for
            // VPC-attached functions — see the comment further down). Scoping
            // it to the opt-in property keeps that property's cost on the
            // templates that ask for it and leaves every other Lambda's deploy
            // time unchanged.
            await waitUntilFunctionActiveV2(
              {
                client: this.lambdaClient,
                maxWaitTime: this.functionUpdateMaxWaitSeconds,
                minDelay: 1,
                maxDelay: 5,
              },
              { FunctionName: functionName }
            );
            await this.putRuntimeManagementConfig(functionName, runtimeManagementConfig);
          },
          {
            apiName: 'PutRuntimeManagementConfig',
            propertyName: 'RuntimeManagementConfig',
            logicalId,
            resourceType,
            functionName,
            log,
          }
        );
      }

      // We deliberately do NOT wait for State=Active here. CreateFunction
      // returns synchronously while the function is still in `Pending`,
      // but the only deploy-time consumer that actually breaks against a
      // Pending function is a synchronous Lambda Invoke (Custom Resources).
      // Other downstream resources — EventSourceMapping, AddPermission,
      // FunctionUrlConfig — accept the function in Pending state and
      // either succeed immediately or auto-progress once the function
      // transitions. Blocking the entire deploy DAG behind every Lambda's
      // Active transition (which can take 5–10 minutes for VPC-attached
      // functions) more than doubled deploy time in benchmark stacks.
      //
      // The Active wait now lives in `CustomResourceProvider.sendRequest`,
      // gated to the only path that needs it (`waitUntilFunctionActiveV2`
      // immediately before the synchronous Invoke). See PR #121 for the
      // bug report this addresses and the follow-up that moved the wait.
      log.debug(`Successfully created Lambda function ${logicalId}: ${log.value(functionName)}`);

      return {
        physicalId: response.FunctionName || functionName,
        attributes: {
          Arn: response.FunctionArn,
          FunctionName: response.FunctionName,
        },
      };
    } catch (error) {
      if (functionCreated) markAuxiliaryFailure(error, logicalId);
      // The cause stays unmasked: a masked message is stamped so the retry
      // classifiers read the chain (`wrapMaskedError`).
      // A non-Error throw still gets a cause, so a stamp has a chain to read.
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create Lambda function ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            functionName,
            cause ?? new Error(String(error))
          )
      );
    }
  }

  /**
   * A failure wrap whose message quotes `error`'s text MASKED: AWS quotes request
   * values (a role, a layer, a subnet) back in its own words.
   *
   * When the mask changed that text, the wrap is stamped `markRedactedCause`, so
   * `withRetry`'s substring classifiers read the unmasked cause chain rather than
   * the masked message (the `concurrent update operation` / `currently in the
   * following state` wording a secret needle could otherwise cut). A method,
   * not a module function, so `gen-update-wrap-coverage` sees the catch that
   * throws it as a `ProvisioningError` wrap factory.
   */
  private wrapMaskedError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    const raw = error instanceof Error ? error.message : String(error);
    // A failed waiter's payload is withheld in the caught error itself.
    const text = withholdWaiterPayload(error, log.mask)?.masked ?? log.mask(raw);
    const wrapped = build(text);
    return text === raw ? wrapped : markRedactedCause(wrapped);
  }

  /**
   * Run a post-create control-plane call under the create path's atomicity
   * contract: on failure, DELETE the just-created function so the next deploy
   * retry sees a fresh slate instead of an orphan that already exists.
   *
   * Extracted from the (previously duplicated) `RecursiveLoop` /
   * `ReservedConcurrentExecutions` blocks when `RuntimeManagementConfig`
   * became the third caller — the wording of all three log lines and of the
   * thrown error is preserved verbatim, parameterized only by the API name
   * and the CFn property name.
   *
   * VPC-attached Lambda caveat (unchanged): the cleanup uses a bare
   * `DeleteFunction`, not the provider's own `delete()`, so hyperplane ENIs
   * are NOT pre-detached / awaited. For a VPC-attached function whose call
   * fails, the next deploy retry's downstream Subnet/SG creation can race the
   * asynchronous ENI release until AWS finishes the detach. The "concurrent
   * update operation" substring is preserved in the wrapped error message so
   * the outer `withRetry` classifier still retries cleanly.
   */
  private async applyPostCreateConfig(
    send: () => Promise<unknown>,
    ctx: {
      apiName: string;
      propertyName: string;
      logicalId: string;
      resourceType: string;
      functionName: string;
      /** The create operation's sinks (issue #2177): every line below goes through them. */
      log: MaskedLogSinks;
    }
  ): Promise<void> {
    const { log } = ctx;
    try {
      await send();
    } catch (error) {
      // `message` is NOT warn-only: the `throw new ProvisioningError(...)` at
      // the end of this handler interpolates it too, and
      // `extractDeploymentEventError` persists that into
      // `deployments/{runId}.jsonl`. So this is one of TEN thrown-and-persisted
      // sites in this sweep, not the warn-only site it reads as; an audit
      // reading only the warn above misses it, and review missed seven of the
      // ten for exactly that reason before counting them from the throws.
      // `.detail` keeps AWS's own sentence, and the disclosure question for
      // every site of that shape is issue go-to-k/cdkd#2319's.
      //
      // Masked before it joins either line (issue #2177): AWS quotes request
      // values back, and the warn below reaches no engine sink at all.
      //
      // The Active wait below can fail with the waiter's whole GetFunction
      // payload as its message: that is withheld, not relayed
      // (`describeLambdaWaiterFailure`).
      const rawMessage = describeAwsFailure(error).detail;
      const withheld = withholdWaiterPayload(error, log.mask);
      const message = withheld?.masked ?? log.mask(rawMessage);
      // Masked once, over the finished line, like the cleanup line below: it
      // is built from the UNMASKED described text.
      this.logger.warn(
        log.mask(
          `${ctx.apiName} failed for ${ctx.logicalId}: ${withheld?.described ?? rawMessage} — deleting partially-created function to maintain atomicity`
        )
      );
      // The cleanup delete is RETRIED on a still-settling function. When the
      // failure above was an Active-wait TIMEOUT, the function is by
      // definition still `Pending`, and `DeleteFunction` answers
      // `ResourceConflictException` for a Pending function — so a
      // single-shot cleanup would fail and genuinely orphan it. (The
      // non-timeout arms self-heal without this: the Pending message is in
      // `retryable-errors.ts`, so the deploy engine's outer `withRetry`
      // re-creates. A waiter-timeout message is NOT in that table, which is
      // exactly the case that reaches here and must clean up after itself.)
      let cleanupFailure: string | undefined;
      for (let attempt = 0; attempt < LAMBDA_CLEANUP_DELETE_MAX_ATTEMPTS; attempt++) {
        try {
          await this.lambdaClient.send(
            new DeleteFunctionCommand({ FunctionName: ctx.functionName })
          );
          cleanupFailure = undefined;
          break;
        } catch (deleteError) {
          // `.detail`, never `.summary`: the classifier three lines down
          // matches AWS's OWN wording. `.summary` is `${name || 'Error'}. ...`,
          // so `/ResourceConflict/i` would still match on a
          // `ResourceConflictException` -- but the `currently in the following
          // state` alternative would be blinded, and AWS sends that wording for
          // a function still updating. Losing it breaks on the first attempt
          // and leaves an ORPHANED function, not merely a worse message.
          const deleteMessage = describeAwsFailure(deleteError).detail;
          cleanupFailure = deleteMessage;
          // Only a state conflict is worth waiting out; anything else
          // (auth, already-deleted) will not change on a retry.
          if (!/currently in the following state|ResourceConflict/i.test(deleteMessage)) break;
          if (attempt < LAMBDA_CLEANUP_DELETE_MAX_ATTEMPTS - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.cleanupDeleteRetryDelayMs * (attempt + 1))
            );
          }
        }
      }
      if (cleanupFailure !== undefined) {
        // `error` has no sink of its own: the finished line goes through the
        // same masker. The classifier above read the RAW text.
        this.logger.error(
          log.mask(
            `Cleanup DeleteFunction failed for ${ctx.logicalId} after ${ctx.apiName} failure — function may be orphaned: ${cleanupFailure}`
          )
        );
      }
      const cause = error instanceof Error ? error : undefined;
      const refusal = new ProvisioningError(
        `Failed to set ${ctx.propertyName} on Lambda function ${ctx.logicalId} (function was deleted to maintain atomicity): ${message}`,
        ctx.resourceType,
        ctx.logicalId,
        ctx.functionName,
        cause ?? new Error(rawMessage)
      );
      // The retry wording this message keeps on purpose (see create()) must
      // still classify when the mask cut it: read the cause chain instead.
      throw message === rawMessage ? refusal : markRedactedCause(refusal);
    }
  }

  /**
   * Send the CFn `RuntimeManagementConfig` block to `PutRuntimeManagementConfig`.
   *
   * CFn spells the block `{ UpdateRuntimeOn, RuntimeVersionArn }` and the SDK
   * request carries the same two members flat on the request (plus the
   * function name), so this is a straight lift rather than a re-shape.
   * `UpdateRuntimeOn` is required by the API; a template that omits it is
   * refused by AWS with its own validation error, which is the behavior we
   * want to surface rather than paper over with a cdkd-invented default.
   */
  private async putRuntimeManagementConfig(
    functionName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    await this.lambdaClient.send(
      new PutRuntimeManagementConfigCommand({
        FunctionName: functionName,
        UpdateRuntimeOn: config['UpdateRuntimeOn'] as UpdateRuntimeOn,
        RuntimeVersionArn: config['RuntimeVersionArn'] as string | undefined,
      })
    );
  }

  /**
   * Update a Lambda function
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    properties = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    // Issues #2178 / #2177: every update() line and refusal goes through this
    // one sink set. `properties` arrives RESOLVED, and a provider's own logger
    // reaches no engine mask. Absent means unmasked. The recorded name is
    // secret-derived when this deploy's bag holds it, or when the PREVIOUS
    // `FunctionName` was a secret (state keeps its `{{resolve:` reference, or
    // `***`, so a rotated name's plaintext is in no bag of this deploy). There
    // is no desired `FunctionName` pair: it could only mark `physicalId`, and
    // these two pairs already catch every redacted state record (a name still
    // in this deploy's bag, or one recorded from a previous secret).
    const log = lambdaOperationSinks(
      this.logger,
      context?.maskSecrets,
      [
        [physicalId, physicalId],
        [previousProperties['FunctionName'], physicalId],
      ],
      properties
    );

    // Typed as the capability so `audit:provider-secret-mask` sees the
    // `maskDeep` below reach a masker (a `log.mask` property read off a
    // non-`this` receiver is not one it accepts).
    const operationMask: MaskerFn = log.mask;

    log.debug(`Updating Lambda function ${logicalId}: ${log.value(physicalId)}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    refuseImageFunctionUnsupported(logicalId, resourceType, properties, physicalId);

    try {
      // Check for configuration changes
      const configFields = [
        'Role',
        'Handler',
        'Runtime',
        'Timeout',
        'MemorySize',
        'Description',
        'Environment',
        'Layers',
        'TracingConfig',
        'EphemeralStorage',
        'VpcConfig',
        'DeadLetterConfig',
        'KmsKeyArn',
        'FileSystemConfigs',
        'ImageConfig',
        'SnapStart',
        'LoggingConfig',
        'DurableConfig',
      ];

      let hasConfigChanges = false;
      for (const field of configFields) {
        if (JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field])) {
          hasConfigChanges = true;
          break;
        }
      }

      if (hasConfigChanges) {
        const configParams: UpdateFunctionConfigurationCommandInput = {
          FunctionName: physicalId,
          Role: properties['Role'] as string | undefined,
          Handler: properties['Handler'] as string | undefined,
          Runtime: properties['Runtime'] as Runtime | undefined,
          // Every optional field below is cleared-on-removal through
          // `removalDefaults` (issue #1160): UpdateFunctionConfiguration treats
          // an ABSENT field as "no change", so a template that drops a
          // previously-set field must send an explicit reset value or AWS
          // silently keeps the old one — while CFn resets it to the
          // property's default. The caller (or `withRemovalDefaults` above,
          // on a direct call) has already put that value in `properties`.
          // VpcConfig is the exception: buildVpcConfigForUpdate. (Role/Handler/
          // Runtime are required by CFn for their package type, so removal is
          // not a valid template transition and they pass through directly.)
          Timeout: properties['Timeout'] as number | undefined,
          MemorySize: properties['MemorySize'] as number | undefined,
          Description: properties['Description'] as string | undefined,
          // The new side is normalized: `Environment: {}` (present, no
          // Variables key) must become `{Variables: {}}` — live-verified
          // 2026-07-22 that the API keeps the old env vars for a
          // Variables-less Environment, while the template's declarative
          // meaning is "no env vars" (issue #1158).
          Environment: this.normalizeEnvironmentForUpdate(
            properties['Environment'] as { Variables?: Record<string, string> } | undefined
          ),
          Layers: properties['Layers'] as string[] | undefined,
          TracingConfig: properties['TracingConfig'] as TracingConfig | undefined,
          EphemeralStorage: properties['EphemeralStorage'] as EphemeralStorage | undefined,
          VpcConfig: this.buildVpcConfigForUpdate(
            properties['VpcConfig'],
            previousProperties['VpcConfig']
          ),
          DeadLetterConfig: properties['DeadLetterConfig'] as DeadLetterConfig | undefined,
          // CFn names this `KmsKeyArn`; the Lambda SDK input field is `KMSKeyArn`.
          KMSKeyArn: properties['KmsKeyArn'] as string | undefined,
          FileSystemConfigs: properties['FileSystemConfigs'] as FileSystemConfig[] | undefined,
          // Kept-but-partial (a sub-field dropped from a still-present
          // ImageConfig) is WHOLE-OBJECT REPLACE, so passing the new block
          // through verbatim IS CloudFormation parity and no sub-field
          // normalization belongs here (issue #1225, live A/B 2026-08-11 on a
          // container Lambda in us-east-1):
          //   - SDK: UpdateFunctionConfiguration with
          //     `ImageConfig: {EntryPoint}` after a create carrying
          //     {EntryPoint, Command, WorkingDirectory} left ONLY EntryPoint
          //     live — the two unspecified sub-fields were cleared, not merged.
          //   - CFn: dropping `Command` + `WorkingDirectory` from a kept
          //     `ImageConfig` block reached the same end state.
          //   - The `{}` removal value is verified too: the SDK call with
          //     `ImageConfig: {}` and a CFn template dropping the whole block
          //     both leave `ImageConfigResponse` absent.
          ImageConfig: properties['ImageConfig'] as ImageConfig | undefined,
          SnapStart: properties['SnapStart'] as SnapStart | undefined,
          LoggingConfig: properties['LoggingConfig'] as LoggingConfig | undefined,
          // DELIBERATELY NOT in `removalDefaults` — the only property in this
          // block for which the reset-to-default idiom does not apply. Live
          // probe (us-east-1, 2026-08-11) established both halves:
          //   - ADD (previous absent -> desired present) is REJECTED by AWS
          //     ("You cannot add a durable configuration to a function that
          //     was originally created with no durable configuration").
          //   - REMOVE (previous present -> desired absent) cannot be
          //     expressed: omitting the member KEEPS the live value, and
          //     there is no documented reset payload — an empty object is
          //     rejected for the required `ExecutionTimeout`.
          // So a presence TOGGLE in either direction is routed to replacement
          // by `replacement-rules.ts`, and this pass-through only ever carries
          // a block that is present on BOTH sides (a genuine in-place edit,
          // which the API accepts and applies).
          DurableConfig: properties['DurableConfig'] as DurableConfig | undefined,
        };

        await this.lambdaClient.send(new UpdateFunctionConfigurationCommand(configParams));
        log.debug(`Updated configuration for Lambda function ${log.value(physicalId)}`);
        // Wait for the configuration update to fully apply before any
        // follow-up call. UpdateFunctionConfiguration is async; an
        // immediate UpdateFunctionCode (or any downstream Invoke) against
        // the in-flight update fails with "The operation cannot be
        // performed at this time. The function is currently in the
        // following state: Pending" / "...InProgress".
        await this.waitForFunctionUpdated(logicalId, resourceType, physicalId, log);
      }

      // CodeSigningConfigArn DETACH must precede the code update below.
      // `UpdateFunctionCode` is validated against the config that is attached
      // AT THE TIME OF THE CALL, so a template that drops an enforcing
      // code-signing config AND ships an unsigned artifact in the same change
      // would fail with `CodeVerificationFailedException` if the detach ran
      // after the code update. The ATTACH arm deliberately stays below the
      // code update for the mirror-image reason: enforcement should only be
      // turned on once the newly-signed artifact is in place.
      const newCodeSigningConfigArn = properties['CodeSigningConfigArn'] as string | undefined;
      const prevCodeSigningConfigArn = previousProperties['CodeSigningConfigArn'] as
        | string
        | undefined;
      const codeSigningChanged = newCodeSigningConfigArn !== prevCodeSigningConfigArn;
      if (codeSigningChanged && newCodeSigningConfigArn === undefined) {
        await this.lambdaClient.send(
          new DeleteFunctionCodeSigningConfigCommand({ FunctionName: physicalId })
        );
        log.debug(
          `Detached CodeSigningConfigArn from Lambda function ${log.value(physicalId)} (template removed the property)`
        );
      }

      // Update function code if changed. Architectures rides on
      // UpdateFunctionCode (NOT UpdateFunctionConfiguration — the Lambda API
      // ties the instruction set to a code deployment), so an x86_64 <->
      // arm64 switch must ALSO fire this branch even when the code itself is
      // byte-identical; it was previously silently dropped (deploy reported
      // success while AWS kept the old architecture, and the next diff saw no
      // change since state recorded the new value). CFn applies it in place
      // ("Update requires: No interruption") by re-sending the code with the
      // new Architectures.
      const newCode = properties['Code'] as Record<string, unknown> | undefined;
      const oldCode = previousProperties['Code'] as Record<string, unknown> | undefined;
      // Normalize BOTH comparison sides: an absent property means the Lambda
      // default (['x86_64']), so an explicit-x86_64 <-> absent template edit
      // is NOT a real change and must not fire a needless code redeploy.
      const normalizeArchitectures = (v: unknown): Architecture[] =>
        Array.isArray(v) && v.length > 0 ? (v as Architecture[]) : (['x86_64'] as Architecture[]);
      const architecturesChanged =
        JSON.stringify(normalizeArchitectures(properties['Architectures'])) !==
        JSON.stringify(normalizeArchitectures(previousProperties['Architectures']));

      if (
        newCode &&
        (architecturesChanged || JSON.stringify(newCode) !== JSON.stringify(oldCode))
      ) {
        const builtCode = this.buildCode(newCode, properties['Runtime'] as string | undefined);
        const codeParams: UpdateFunctionCodeCommandInput = {
          FunctionName: physicalId,
          S3Bucket: builtCode.S3Bucket,
          S3Key: builtCode.S3Key,
          S3ObjectVersion: builtCode.S3ObjectVersion,
          ZipFile: builtCode.ZipFile,
          ImageUri: builtCode.ImageUri,
          // A removed Architectures property reverts to the Lambda default
          // (x86_64) — matches CFn's absent-property default semantics.
          Architectures: architecturesChanged
            ? normalizeArchitectures(properties['Architectures'])
            : undefined,
        };

        await this.lambdaClient.send(new UpdateFunctionCodeCommand(codeParams));
        log.debug(`Updated code for Lambda function ${log.value(physicalId)}`);
        // Same reason as above: UpdateFunctionCode is async too, and
        // downstream resources / a subsequent deploy must not race the
        // in-flight code swap.
        await this.waitForFunctionUpdated(logicalId, resourceType, physicalId, log);
      }

      // RecursiveLoop is set via a SEPARATE `PutFunctionRecursionConfig`
      // API (not part of UpdateFunctionConfiguration). On change, issue
      // the post-update control-plane call. The transient
      // "concurrent update operation" retry is already covered by
      // `src/deployment/retryable-errors.ts` (added by PR #711).
      const newRecursiveLoop = properties['RecursiveLoop'] as RecursiveLoop | undefined;
      const prevRecursiveLoop = previousProperties['RecursiveLoop'] as RecursiveLoop | undefined;
      if (newRecursiveLoop !== undefined && newRecursiveLoop !== prevRecursiveLoop) {
        await this.lambdaClient.send(
          new PutFunctionRecursionConfigCommand({
            FunctionName: physicalId,
            RecursiveLoop: newRecursiveLoop,
          })
        );
        log.debug(
          `Updated RecursiveLoop for Lambda function ${log.value(physicalId)} to '${log.value(newRecursiveLoop)}'`
        );
      }

      // ReservedConcurrentExecutions: set via a SEPARATE
      // `PutFunctionConcurrency` API (or cleared via
      // `DeleteFunctionConcurrency` — UpdateFunctionConfiguration does NOT
      // accept this field). On change, issue the matching call. Removal
      // (`prev: number, next: undefined`) maps to DeleteFunctionConcurrency
      // so a user dropping the property from their template actually
      // un-throttles the function instead of silently leaving the old
      // reserved value pinned. 0 is a meaningful value (zero concurrency
      // = full throttle), so the gates use `!== undefined` / `!==` strict
      // compare.
      const newReservedConcurrentExecutions = properties['ReservedConcurrentExecutions'] as
        | number
        | undefined;
      const prevReservedConcurrentExecutions = previousProperties[
        'ReservedConcurrentExecutions'
      ] as number | undefined;
      if (newReservedConcurrentExecutions !== prevReservedConcurrentExecutions) {
        if (newReservedConcurrentExecutions === undefined) {
          await this.lambdaClient.send(
            new DeleteFunctionConcurrencyCommand({ FunctionName: physicalId })
          );
          log.debug(
            `Cleared ReservedConcurrentExecutions for Lambda function ${log.value(physicalId)} (template removed the property)`
          );
        } else {
          await this.lambdaClient.send(
            new PutFunctionConcurrencyCommand({
              FunctionName: physicalId,
              ReservedConcurrentExecutions: newReservedConcurrentExecutions,
            })
          );
          log.debug(
            `Updated ReservedConcurrentExecutions for Lambda function ${log.value(physicalId)} to ${log.value(newReservedConcurrentExecutions)}`
          );
        }
      }

      // CodeSigningConfigArn ATTACH / CHANGE. Set via a SEPARATE
      // `PutFunctionCodeSigningConfig` API (UpdateFunctionConfiguration does
      // NOT accept this field). The DETACH half runs earlier, before the code
      // update — see the comment there for why the two arms are split. Removal
      // mapping to a real Delete call is the #1160 absent-field-removal class,
      // which for a SECURITY control is the direction that matters.
      if (codeSigningChanged && newCodeSigningConfigArn !== undefined) {
        await this.lambdaClient.send(
          new PutFunctionCodeSigningConfigCommand({
            FunctionName: physicalId,
            CodeSigningConfigArn: newCodeSigningConfigArn,
          })
        );
        log.debug(
          `Updated CodeSigningConfigArn for Lambda function ${log.value(physicalId)} to ${log.value(newCodeSigningConfigArn)}`
        );
      }

      // RuntimeManagementConfig: set via a SEPARATE
      // `PutRuntimeManagementConfig` API. There is no delete counterpart, so
      // REMOVAL is expressed by re-sending the AWS default (`UpdateRuntimeOn:
      // 'Auto'`), which is what CFn resets the property to — the same
      // reset-to-default idiom `removalDefaults` applies to the
      // UpdateFunctionConfiguration fields above. `RuntimeVersionArn` is only
      // meaningful under `Manual` and is dropped by the reset.
      const newRuntimeManagementConfig = properties['RuntimeManagementConfig'] as
        | Record<string, unknown>
        | undefined;
      const prevRuntimeManagementConfig = previousProperties['RuntimeManagementConfig'] as
        | Record<string, unknown>
        | undefined;
      // Compared member-by-member, NOT via JSON.stringify: the block has
      // exactly two members and a stringify compare is key-ORDER sensitive, so
      // a template that merely reorders them would issue a redundant Put.
      const runtimeManagementChanged =
        newRuntimeManagementConfig?.['UpdateRuntimeOn'] !==
          prevRuntimeManagementConfig?.['UpdateRuntimeOn'] ||
        newRuntimeManagementConfig?.['RuntimeVersionArn'] !==
          prevRuntimeManagementConfig?.['RuntimeVersionArn'];
      if (runtimeManagementChanged) {
        await this.putRuntimeManagementConfig(
          physicalId,
          newRuntimeManagementConfig ?? { UpdateRuntimeOn: 'Auto' }
        );
        log.debug(
          `Updated RuntimeManagementConfig for Lambda function ${log.value(physicalId)} to ${JSON.stringify(
            maskDeep(newRuntimeManagementConfig ?? { UpdateRuntimeOn: 'Auto' }, operationMask)
          )}`
        );
      }

      // Get updated function info for attributes (also gives us the ARN
      // we need for tag mutations).
      const getResponse = await this.lambdaClient.send(
        new GetFunctionCommand({ FunctionName: physicalId })
      );
      const functionArn = getResponse.Configuration?.FunctionArn;

      // Update tags if changed. Lambda's TagResource takes a map shape
      // (Tags: { key: value }); UntagResource takes a key list. cdkd
      // state holds Tags in CFn shape ([{ Key, Value }]).
      await this.applyTagDiff(
        functionArn,
        physicalId,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        log
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: functionArn,
          FunctionName: getResponse.Configuration?.FunctionName,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Lambda function ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause ?? new Error(String(error))
          )
      );
    }
  }

  /**
   * Delete a Lambda function
   *
   * For VPC-enabled Lambda functions, AWS detaches the hyperplane ENIs
   * asynchronously after DeleteFunction returns. If we let downstream
   * resource deletion (Subnet / SecurityGroup) proceed immediately, those
   * deletions fail with "has dependencies" / "has a dependent object".
   *
   * To smooth this out, when properties carry a VpcConfig with subnets or
   * security groups, we poll DescribeNetworkInterfaces for the function's
   * managed ENIs and only return once they are gone (or the timeout elapses).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda function ${logicalId}: ${physicalId}`);

    const hasVpcConfig = this.hasVpcConfig(properties?.['VpcConfig']);

    // For VPC-attached functions, detach the VPC config BEFORE deletion.
    // DeleteFunction does not synchronously release Lambda hyperplane ENIs;
    // AWS reclaims them eventually, often well past any reasonable wait
    // window. UpdateFunctionConfiguration with empty SubnetIds / SecurityGroupIds
    // triggers an explicit ENI release that completes in seconds-to-minutes,
    // letting downstream Subnet / SecurityGroup deletes proceed.
    if (hasVpcConfig) {
      try {
        await this.lambdaClient.send(
          new UpdateFunctionConfigurationCommand({
            FunctionName: physicalId,
            VpcConfig: { SubnetIds: [], SecurityGroupIds: [] },
          })
        );
        this.logger.debug(`Detached VPC config from Lambda ${physicalId} before deletion`);
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          const clientRegion = await this.lambdaClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          // Function is already gone — nothing more to do, including ENI wait
          // (AWS owns the cleanup at this point).
          return;
        }
        // Best-effort: don't fail the entire delete if pre-detach errors.
        // The post-DeleteFunction ENI wait below remains as a safety net.
        this.logger.warn(
          `Pre-delete VPC detach failed for ${physicalId}: ${
            describeAwsFailure(error).detail
          } — continuing with delete`
        );
      }

      // Wait for the UpdateFunctionConfiguration to fully apply before
      // calling DeleteFunction. Lambda processes the VPC detach
      // asynchronously: LastUpdateStatus transitions InProgress -> Successful,
      // and the hyperplane ENIs only flip from `in-use` to `available` once
      // that completes. Calling DeleteFunction while LastUpdateStatus is
      // still `InProgress` aborts the detach mid-flight, leaving ENIs
      // attached and blocking downstream Subnet / SG deletion.
      await this.waitForLambdaUpdateCompleted(physicalId);
    }

    try {
      await this.lambdaClient.send(new DeleteFunctionCommand({ FunctionName: physicalId }));
      this.logger.debug(`Successfully deleted Lambda function ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Lambda function ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda function ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    if (hasVpcConfig) {
      await this.cleanupLambdaEnis(physicalId);
    }
  }

  /**
   * Build Lambda VpcConfig parameter from CDK properties.
   *
   * Returns undefined when VpcConfig is unset, so the SDK leaves the function
   * outside any VPC. Returns an empty config (no subnets, no SGs) when caller
   * explicitly clears it on update — that detaches the function from its VPC.
   */
  private buildVpcConfig(raw: unknown): VpcConfig | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== 'object') {
      return undefined;
    }
    const vpc = raw as Record<string, unknown>;
    const result: VpcConfig = {};
    if (Array.isArray(vpc['SubnetIds'])) {
      result.SubnetIds = vpc['SubnetIds'] as string[];
    }
    if (Array.isArray(vpc['SecurityGroupIds'])) {
      result.SecurityGroupIds = vpc['SecurityGroupIds'] as string[];
    }
    if (typeof vpc['Ipv6AllowedForDualStack'] === 'boolean') {
      result.Ipv6AllowedForDualStack = vpc['Ipv6AllowedForDualStack'];
    }
    return result;
  }

  /**
   * Build VpcConfig for an update call, accounting for VPC detach.
   *
   * UpdateFunctionConfiguration treats an absent VpcConfig as "no change",
   * so omitting it cannot move a function out of its existing VPC. To
   * detach we must explicitly send empty SubnetIds / SecurityGroupIds.
   */
  private buildVpcConfigForUpdate(newRaw: unknown, previousRaw: unknown): VpcConfig | undefined {
    const next = this.buildVpcConfig(newRaw);
    if (next) {
      return next;
    }
    if (this.hasVpcConfig(previousRaw)) {
      return { SubnetIds: [], SecurityGroupIds: [] };
    }
    return undefined;
  }

  /**
   * Normalize a template `Environment` block for UpdateFunctionConfiguration.
   *
   * `Environment: {}` (present, but no `Variables` key — a hand-written L1 /
   * imported-template shape CDK never emits) passed through verbatim does NOT
   * clear the live env vars: the API keeps the old `Variables` when the input
   * `Environment` carries none (live-verified 2026-07-22, issue #1158). The
   * template's declarative meaning is "no env vars", so a Variables-less
   * block is rewritten to the explicit-clear `{Variables: {}}`. A present
   * `Variables` map (even empty) and an absent `Environment` pass through
   * unchanged — removal handling stays with `removalDefaults`. A `null`
   * block (hand-written JSON) is treated like absent rather than crashing on
   * the property read.
   */
  private normalizeEnvironmentForUpdate(
    environment: { Variables?: Record<string, string> } | undefined
  ): { Variables?: Record<string, string> } | undefined {
    if (environment == null) return undefined;
    if (environment.Variables === undefined) return { Variables: {} };
    return environment;
  }

  /**
   * Determine whether the function actually attaches to a VPC, i.e. has at
   * least one Subnet ID. A bare VpcConfig with empty arrays does not create
   * any ENIs, so we skip the wait in that case.
   */
  private hasVpcConfig(raw: unknown): boolean {
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      return false;
    }
    const vpc = raw as Record<string, unknown>;
    const subnets = vpc['SubnetIds'];
    return Array.isArray(subnets) && subnets.length > 0;
  }

  /**
   * Clean up Lambda-managed ENIs for the given function: list, then attempt
   * DeleteNetworkInterface on each. Repeat until no matching ENIs remain
   * or the configured timeout elapses.
   *
   * Why direct delete (not just wait): an `available` ENI still counts as a
   * Subnet / SecurityGroup dependency, so DeleteSubnet / DeleteSecurityGroup
   * fail until the ENI itself is gone. AWS's eventual cleanup of unused
   * Lambda hyperplane ENIs can take well over an hour, which is far longer
   * than any reasonable destroy budget. Calling DeleteNetworkInterface
   * ourselves (best-effort) clears `available` ENIs in seconds.
   *
   * In-use ENIs (e.g. immediately after the pre-delete VPC detach) cannot
   * be deleted yet — we swallow that error and retry on the next iteration
   * once they transition to `available`.
   *
   * Lambda VPC ENI Descriptions follow the pattern
   *   "AWS Lambda VPC ENI-<functionName>"
   * (and historically "AWS Lambda VPC ENI-<functionName>-<uuid>"). We
   * narrow the query with a `requester-id` filter and then match the
   * function name as a hyphen-bounded token to avoid false positives like
   * "myfn" matching for function "fn".
   *
   * Polling: starts at eniWaitInitialDelayMs (10s), exponential backoff up
   * to eniWaitMaxDelayMs (10s), bounded by eniWaitTimeoutMs (10min).
   * Timeout is a soft warning — downstream Subnet/SG deletion has its own
   * retries.
   */
  /**
   * Block until the function's LastUpdateStatus === 'Successful'.
   *
   * Used after UpdateFunctionConfiguration / UpdateFunctionCode. Wraps the
   * SDK's `waitUntilFunctionUpdatedV2` (acceptors: SUCCESS=Successful,
   * FAILURE=Failed, RETRY=InProgress). Errors are surfaced as
   * `ProvisioningError` so the deploy engine's per-resource error
   * handling treats them identically to an Update API failure.
   *
   * NOTE: post-CreateFunction `State=Active` wait was deliberately moved
   * out of this provider in favor of an on-demand wait inside
   * `CustomResourceProvider.sendRequest` (the only deploy-time consumer
   * that breaks against a Pending Lambda). Blocking the entire deploy
   * DAG behind every Lambda's Active transition more than doubled
   * deploy time on benchmark stacks; the on-demand wait scoped to the
   * one resource type that actually needs it preserves the bug fix
   * without paying the whole-stack tax.
   */
  /**
   * Apply a diff between old and new CFn-shape Tags arrays via Lambda's
   * `TagResource` / `UntagResource` APIs. Without this, `cdkd deploy`
   * and `cdkd drift --revert` silently no-op tag changes — the
   * `UpdateFunctionConfiguration` command does NOT accept a Tags
   * parameter (Lambda treats tags as a separate API surface). Both sides
   * are read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable
   * record untags nothing.
   */
  private async applyTagDiff(
    functionArn: string | undefined,
    functionName: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    if (!functionArn) return;

    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      log.warn(tagWarning);
    }
    const tagsToAdd = Object.fromEntries(plan.set);
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.lambdaClient.send(
        new UntagResourceCommand({ Resource: functionArn, TagKeys: tagsToRemove })
      );
      // The function NAME through `value`, not the ARN: the ARN embeds the
      // name, and a secret name below the substring needle floor would print
      // inside it.
      log.debug(
        `Removed ${tagsToRemove.length} tag(s) from Lambda function ${log.value(functionName)}`
      );
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.lambdaClient.send(
        new TagResourceCommand({ Resource: functionArn, Tags: tagsToAdd })
      );
      log.debug(
        `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on Lambda function ${log.value(functionName)}`
      );
    }
  }

  private async waitForFunctionUpdated(
    logicalId: string,
    resourceType: string,
    functionName: string,
    log: MaskedLogSinks
  ): Promise<void> {
    try {
      await waitUntilFunctionUpdatedV2(
        // Explicit cadence per the repo-wide waiter rule (#1291 item 5). The
        // Lambda V2 waiters' own default is already dense (1s first poll);
        // pinning it here keeps that a recorded decision instead of an SDK
        // default we happen to inherit.
        {
          client: this.lambdaClient,
          maxWaitTime: this.functionUpdateMaxWaitSeconds,
          minDelay: 1,
          maxDelay: 5,
        },
        { FunctionName: functionName }
      );
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log,
        error,
        (text) =>
          new ProvisioningError(
            `Lambda function ${logicalId} update did not complete: ${text}`,
            resourceType,
            logicalId,
            functionName,
            cause ?? new Error(String(error))
          )
      );
    }
  }

  /**
   * Poll GetFunction until LastUpdateStatus is no longer `InProgress`.
   *
   * After UpdateFunctionConfiguration the Lambda service processes the
   * change (including VPC detach + hyperplane ENI release) asynchronously.
   * Returning early — i.e. calling DeleteFunction while the update is still
   * `InProgress` — aborts the detach, leaving ENIs attached and blocking
   * downstream Subnet / SG deletion.
   *
   * Bounded by eniWaitTimeoutMs (10min) and treated as a soft warning on
   * timeout: the subsequent ENI cleanup loop and downstream retries cover
   * the residual edge case.
   *
   * NOTE: deliberately separate from `waitForFunctionUpdated` (which uses
   * the SDK's `waitUntilFunctionUpdatedV2` and throws on FAILURE). The
   * pre-delete path needs a more lenient acceptor: if a prior update
   * failed, we still want to proceed with DeleteFunction rather than
   * abort, because the function is going away anyway.
   */
  private async waitForLambdaUpdateCompleted(functionName: string): Promise<void> {
    const start = Date.now();
    let delay = this.eniWaitInitialDelayMs;

    for (;;) {
      let status: string | undefined;
      try {
        const resp = await this.lambdaClient.send(
          new GetFunctionCommand({ FunctionName: functionName })
        );
        status = resp.Configuration?.LastUpdateStatus;
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          // Function disappeared — caller will skip ENI cleanup too.
          return;
        }
        // Transient error — log and retry.
        this.logger.debug(
          `GetFunction failed while waiting for ${functionName} update: ${
            describeAwsFailure(error).detail
          }`
        );
      }

      if (status && status !== 'InProgress') {
        this.logger.debug(
          `Lambda ${functionName} update completed (LastUpdateStatus=${status}) after ${
            Date.now() - start
          }ms`
        );
        return;
      }

      const elapsed = Date.now() - start;
      if (elapsed >= this.eniWaitTimeoutMs) {
        this.logger.warn(
          `Timeout (${this.eniWaitTimeoutMs}ms) waiting for Lambda ${functionName} update to complete; proceeding with delete`
        );
        return;
      }

      const remaining = this.eniWaitTimeoutMs - elapsed;
      const sleepMs = Math.min(delay, remaining);
      await this.sleep(sleepMs);
      delay = Math.min(delay * 2, this.eniWaitMaxDelayMs);
    }
  }

  private async cleanupLambdaEnis(functionName: string): Promise<void> {
    this.logger.debug(`Cleaning up Lambda VPC ENIs for function ${functionName}`);

    // Mirror delstack's ENI cleanup pattern: an unconditional initial sleep
    // gives AWS time to register the post-detach ENI state in the API plane
    // (DescribeNetworkInterfaces can transiently return an empty list right
    // after UpdateFunctionConfiguration, even though ENIs still exist), then
    // delete each matched ENI in parallel with a per-ENI retry budget.
    await this.sleep(this.eniInitialSleepMs);

    let enis: { id: string; status: string }[] = [];
    try {
      enis = await this.listLambdaEnis(functionName);
    } catch (error) {
      this.logger.warn(
        `DescribeNetworkInterfaces failed for ${functionName}: ${
          describeAwsFailure(error).detail
        } — downstream Subnet/SG deletion will fall back to its own ENI cleanup`
      );
      return;
    }

    if (enis.length === 0) {
      this.logger.debug(`No Lambda ENIs found for ${functionName} after initial sleep`);
      return;
    }

    // Per-ENI parallel delete with retry. An in-use ENI cannot be deleted
    // until AWS finishes the asynchronous detach triggered by the prior
    // UpdateFunctionConfiguration; budget gives that detach time to land.
    await Promise.all(enis.map((eni) => this.deleteEniWithRetry(eni.id, functionName)));
  }

  private async deleteEniWithRetry(eniId: string, functionName: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      try {
        await this.ec2Client.send(new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eniId }));
        this.logger.debug(`Deleted Lambda ENI ${eniId} for ${functionName}`);
        return;
      } catch (error) {
        const msg = describeAwsFailure(error).detail;
        if (msg.includes('InvalidNetworkInterfaceID.NotFound') || msg.includes('does not exist')) {
          // Already gone — treat as success.
          return;
        }
        const elapsed = Date.now() - start;
        if (elapsed >= this.eniDeleteRetryBudgetMs) {
          this.logger.warn(
            `Gave up deleting ENI ${eniId} for ${functionName} after ${elapsed}ms: ${msg} — ` +
              `downstream Subnet/SG deletion will retry`
          );
          return;
        }
        await this.sleep(this.eniDeleteRetryIntervalMs);
      }
    }
  }

  /**
   * List Lambda-managed ENIs for the given function, paginating through
   * DescribeNetworkInterfaces and filtering on Description.
   *
   * We filter directly on `description=AWS Lambda VPC ENI-*` (the EC2 API
   * supports `*` wildcards on this filter — same approach as delstack). An
   * earlier attempt narrowed with `requester-id=*:awslambda_*`, but real
   * Lambda hyperplane ENIs carry a RequesterId of the form
   * `AROAXXX...:<account-id>` (no literal "awslambda" substring), so that
   * filter matched nothing and the cleanup loop quietly listed zero ENIs.
   */
  private async listLambdaEnis(functionName: string): Promise<{ id: string; status: string }[]> {
    const enis: { id: string; status: string }[] = [];
    const descriptionPrefix = 'AWS Lambda VPC ENI-';
    let nextToken: string | undefined;
    do {
      const resp = await this.ec2Client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [{ Name: 'description', Values: [`${descriptionPrefix}*`] }],
          NextToken: nextToken,
        })
      );

      for (const ni of resp.NetworkInterfaces ?? []) {
        const desc = ni.Description ?? '';
        if (!ni.NetworkInterfaceId || !desc.startsWith(descriptionPrefix)) {
          continue;
        }
        // The portion after `AWS Lambda VPC ENI-` is the function-name token
        // AWS uses on the ENI. It usually omits the CDK auto-generated 8-char
        // suffix at the end of the physical function name, so match by
        // checking that physicalId starts with `<token>-` (allowing the
        // suffix) or equals it exactly. This is hyphen-bounded so a function
        // named `fn` does NOT match an ENI whose token is `myfn`.
        const token = desc.slice(descriptionPrefix.length);
        if (functionName === token || functionName.startsWith(`${token}-`)) {
          enis.push({ id: ni.NetworkInterfaceId, status: ni.Status ?? 'unknown' });
        }
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    return enis;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Build Lambda Code parameter from CDK properties
   */
  private buildCode(code: Record<string, unknown>, runtime: string | undefined): FunctionCode {
    const result: FunctionCode = {};

    if (code['S3Bucket']) {
      result.S3Bucket = code['S3Bucket'] as string;
    }
    if (code['S3Key']) {
      result.S3Key = code['S3Key'] as string;
    }
    if (code['S3ObjectVersion']) {
      result.S3ObjectVersion = code['S3ObjectVersion'] as string;
    }
    if (code['ZipFile']) {
      // Lambda SDK expects a zip binary, not raw text.
      // CloudFormation's ZipFile property auto-zips inline code, but SDK does not.
      // Create a minimal zip with the code as index.* file.
      result.ZipFile = this.createZipFromInlineCode(code['ZipFile'] as string, runtime);
    }
    if (code['ImageUri']) {
      result.ImageUri = code['ImageUri'] as string;
    }

    return result;
  }

  /**
   * Create a zip file from inline code text.
   *
   * CloudFormation's ZipFile property automatically wraps inline code in a zip,
   * but the Lambda SDK expects actual zip binary. This creates a minimal zip
   * containing the code as index.* (extension derived from runtime — nodejs
   * runtimes use index.js, python runtimes use index.py; see CFn ZipFile docs).
   */
  private createZipFromInlineCode(code: string, runtime: string | undefined): Uint8Array {
    const fileData = Buffer.from(code, 'utf-8');
    const crc32 = this.crc32(fileData);
    const compressedData = zlib.deflateRawSync(fileData);

    const fileName = Buffer.from(inlineCodeFileNameForRuntime(runtime));
    const now = new Date();
    const modTime =
      ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const modDate =
      (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    // Local file header
    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // compression: deflate
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(fileData.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    fileName.copy(localHeader, 30);

    // Central directory
    const centralDir = Buffer.alloc(46 + fileName.length);
    centralDir.writeUInt32LE(0x02014b50, 0);
    centralDir.writeUInt16LE(20, 4);
    centralDir.writeUInt16LE(20, 6);
    centralDir.writeUInt16LE(0, 8);
    centralDir.writeUInt16LE(8, 10);
    centralDir.writeUInt16LE(modTime, 12);
    centralDir.writeUInt16LE(modDate, 14);
    centralDir.writeUInt32LE(crc32, 16);
    centralDir.writeUInt32LE(compressedData.length, 20);
    centralDir.writeUInt32LE(fileData.length, 24);
    centralDir.writeUInt16LE(fileName.length, 28);
    centralDir.writeUInt32LE(0, 42); // offset to local header
    fileName.copy(centralDir, 46);

    // End of central directory
    const endRecord = Buffer.alloc(22);
    const cdOffset = localHeader.length + compressedData.length;
    const cdSize = centralDir.length;
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(1, 8); // entries on disk
    endRecord.writeUInt16LE(1, 10); // total entries
    endRecord.writeUInt32LE(cdSize, 12);
    endRecord.writeUInt32LE(cdOffset, 16);

    return Buffer.concat([localHeader, compressedData, centralDir, endRecord]);
  }

  private crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing Lambda function.
   *
   * CloudFormation's `AWS::Lambda::Function` exposes `Arn`,
   * `SnapStartResponse.ApplyOn`, and `SnapStartResponse.OptimizationStatus`
   * as documented at
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html#aws-resource-lambda-function-return-values.
   *
   * All three live in the same `GetFunction` response (`Configuration.FunctionArn`
   * and `Configuration.SnapStart.{ApplyOn,OptimizationStatus}`), so a single API
   * call covers every supported attr. Used by `cdkd orphan` to live-fetch
   * attribute values that need to be substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (
      attributeName !== 'Arn' &&
      attributeName !== 'SnapStartResponse.ApplyOn' &&
      attributeName !== 'SnapStartResponse.OptimizationStatus'
    ) {
      return undefined;
    }
    try {
      const resp = await this.lambdaClient.send(
        new GetFunctionCommand({ FunctionName: physicalId })
      );
      switch (attributeName) {
        case 'Arn':
          return resp.Configuration?.FunctionArn;
        case 'SnapStartResponse.ApplyOn':
          return resp.Configuration?.SnapStart?.ApplyOn;
        case 'SnapStartResponse.OptimizationStatus':
          return resp.Configuration?.SnapStart?.OptimizationStatus;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read the AWS-current Lambda function configuration in CFn-property shape.
   *
   * Issues a single `GetFunction` and surfaces the same property keys
   * `create()` accepts (`Runtime`, `Handler`, `Role`, `Timeout`, `MemorySize`,
   * `Description`, `Environment`, `Layers`, `Architectures`, `PackageType`,
   * `TracingConfig`, `EphemeralStorage`, `VpcConfig`, `DeadLetterConfig`,
   * `KmsKeyArn`, `FileSystemConfigs`, `ImageConfig`, `SnapStart`,
   * `LoggingConfig`, plus the physical `FunctionName`). The drift comparator
   * only descends into keys
   * present in
   * cdkd state, so AWS-managed fields (timestamps, FunctionArn, RevisionId,
   * etc.) are filtered at compare time — we still avoid serializing them on
   * the wire.
   *
   * `Code.S3Bucket` / `Code.S3Key` / `Code.S3ObjectVersion` / `Code.ZipFile`
   * are not surfaced: `GetFunction` returns a pre-signed S3 URL for the
   * deployed code, not the asset hash cdkd state holds, so they could
   * never match. Those keys are declared via `getDriftUnknownPaths` so
   * the drift comparator skips them. `Code.ImageUri` IS surfaced for
   * container Lambdas (`PackageType: 'Image'`) — AWS returns it on the
   * `GetFunction.Code.ImageUri` field, so a console-side image swap is
   * detectable as drift.
   *
   * `Tags` is surfaced from the `Tags` map on the same `GetFunction`
   * response. CDK's auto-injected `aws:cdk:*` tags (which AWS happily
   * returns) are filtered out by `normalizeAwsTagsToCfn` so they don't
   * fire false-positive drift against state. The result key is omitted
   * entirely when AWS reports no user tags, matching `create()`'s
   * behavior of only sending `Tags` when the user explicitly passes
   * them.
   *
   * Returns `undefined` when the function is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.lambdaClient.send(
        new GetFunctionCommand({ FunctionName: physicalId })
      );
      const cfg = resp.Configuration;
      if (!cfg) return undefined;

      const result: Record<string, unknown> = {};

      if (cfg.FunctionName !== undefined) result['FunctionName'] = cfg.FunctionName;
      if (cfg.Runtime !== undefined) result['Runtime'] = cfg.Runtime;
      if (cfg.Handler !== undefined) result['Handler'] = cfg.Handler;
      if (cfg.Role !== undefined) result['Role'] = cfg.Role;
      if (cfg.Timeout !== undefined) result['Timeout'] = cfg.Timeout;
      if (cfg.MemorySize !== undefined) result['MemorySize'] = cfg.MemorySize;
      result['Description'] = cfg.Description ?? '';
      result['Environment'] = { Variables: cfg.Environment?.Variables ?? {} };
      // GetFunction returns Layers as [{Arn, CodeSize, ...}]; CFn shape
      // is a flat string[] of ARNs.
      result['Layers'] = (cfg.Layers ?? []).map((l) => l.Arn).filter((arn): arn is string => !!arn);
      result['Architectures'] = cfg.Architectures ? [...cfg.Architectures] : [];
      if (cfg.PackageType !== undefined) result['PackageType'] = cfg.PackageType;
      // Code.ImageUri is surfaced for container Lambdas only. AWS returns
      // `Code.ImageUri` on `GetFunction.Code.ImageUri` for Image-package
      // functions; ZIP-package functions return a pre-signed S3 URL on
      // `Code.Location` which is NOT the asset key cdkd state carries
      // (the ZIP-side sub-paths stay declared via getDriftUnknownPaths).
      // The Code subtree is only emitted when AWS reports an ImageUri so
      // ZIP-package functions don't get a misleading `Code: {}` placeholder.
      if (resp.Code?.ImageUri !== undefined) {
        result['Code'] = { ImageUri: resp.Code.ImageUri };
      }
      result['TracingConfig'] = { Mode: cfg.TracingConfig?.Mode ?? 'PassThrough' };
      if (cfg.EphemeralStorage?.Size !== undefined) {
        result['EphemeralStorage'] = { Size: cfg.EphemeralStorage.Size };
      }
      // Always emit VpcConfig so a console-side VPC attach is detected even
      // when the function was deployed without VpcConfig (Lambda's
      // GetFunction returns VpcConfig with empty arrays for non-VPC
      // functions; that empty shape becomes our placeholder).
      // AWS's GetFunction sometimes returns Ipv6AllowedForDualStack=undefined
      // and sometimes false (the default) for the same non-VPC function —
      // observed empirically after UpdateFunctionConfiguration. Emit it
      // unconditionally with `?? false` so the comparator sees a stable
      // shape and doesn't fire false-positive drift on every other
      // refresh.
      result['VpcConfig'] = {
        SubnetIds: cfg.VpcConfig?.SubnetIds ? [...cfg.VpcConfig.SubnetIds] : [],
        SecurityGroupIds: cfg.VpcConfig?.SecurityGroupIds
          ? [...cfg.VpcConfig.SecurityGroupIds]
          : [],
        Ipv6AllowedForDualStack: cfg.VpcConfig?.Ipv6AllowedForDualStack ?? false,
      };

      // The following fields are emitted ONLY when AWS reports a value (unlike
      // the always-emit placeholders above). AWS echoes back exactly what
      // create()/update() sent, so emit-when-present cannot drop a
      // user-templated value, and the drift comparator's state-keys-only
      // top-level walk ignores any key not present in state — so emitting an
      // AWS-default value the user never templated (e.g. SnapStart.ApplyOn=None)
      // never fires false-positive drift. Emitting them unconditionally would
      // instead break the "AWS minimum response" key-set regression test
      // (lambda-function-provider-readcurrentstate.test.ts).
      if (cfg.DeadLetterConfig?.TargetArn !== undefined) {
        result['DeadLetterConfig'] = { TargetArn: cfg.DeadLetterConfig.TargetArn };
      }
      // CFn names this `KmsKeyArn`; GetFunction returns it as `KMSKeyArn`.
      if (cfg.KMSKeyArn !== undefined) {
        result['KmsKeyArn'] = cfg.KMSKeyArn;
      }
      if (cfg.FileSystemConfigs !== undefined && cfg.FileSystemConfigs.length > 0) {
        result['FileSystemConfigs'] = cfg.FileSystemConfigs.map((f) => ({
          Arn: f.Arn,
          LocalMountPath: f.LocalMountPath,
        }));
      }
      // Container Lambdas: GetFunction nests ImageConfig under ImageConfigResponse.
      const imageConfig = cfg.ImageConfigResponse?.ImageConfig;
      if (imageConfig !== undefined) {
        const ic: Record<string, unknown> = {};
        if (imageConfig.EntryPoint !== undefined) ic['EntryPoint'] = [...imageConfig.EntryPoint];
        if (imageConfig.Command !== undefined) ic['Command'] = [...imageConfig.Command];
        if (imageConfig.WorkingDirectory !== undefined)
          ic['WorkingDirectory'] = imageConfig.WorkingDirectory;
        if (Object.keys(ic).length > 0) result['ImageConfig'] = ic;
      }
      if (cfg.SnapStart?.ApplyOn !== undefined) {
        // CFn SnapStart is { ApplyOn } only; OptimizationStatus is AWS-managed.
        result['SnapStart'] = { ApplyOn: cfg.SnapStart.ApplyOn };
      }
      // AWS always returns LoggingConfig (even for the Text-format default), so
      // this is effectively emit-always on real AWS — but the comparator's
      // state-keys-only walk ignores it unless the user templated LoggingConfig.
      // Emit only the user-controllable sub-fields (LogGroup is templatable too);
      // ApplicationLogLevel / SystemLogLevel only apply to JSON format and AWS
      // omits them under Text, so they stay emit-when-present.
      if (cfg.LoggingConfig?.LogFormat !== undefined) {
        const lc: Record<string, unknown> = { LogFormat: cfg.LoggingConfig.LogFormat };
        if (cfg.LoggingConfig.ApplicationLogLevel !== undefined)
          lc['ApplicationLogLevel'] = cfg.LoggingConfig.ApplicationLogLevel;
        if (cfg.LoggingConfig.SystemLogLevel !== undefined)
          lc['SystemLogLevel'] = cfg.LoggingConfig.SystemLogLevel;
        if (cfg.LoggingConfig.LogGroup !== undefined) lc['LogGroup'] = cfg.LoggingConfig.LogGroup;
        result['LoggingConfig'] = lc;
      }

      // DurableConfig / TenancyConfig ride on the SAME GetFunction response
      // (both are members of `FunctionConfiguration`), so they need no extra
      // call — emit-when-present like the block above. Live readback shapes
      // (us-east-1, 2026-08-11): `{RetentionPeriodInDays, ExecutionTimeout}`
      // and `{TenantIsolationMode}`, i.e. the CFn spellings verbatim.
      if (cfg.DurableConfig !== undefined) {
        const dc: Record<string, unknown> = {};
        if (cfg.DurableConfig.ExecutionTimeout !== undefined)
          dc['ExecutionTimeout'] = cfg.DurableConfig.ExecutionTimeout;
        if (cfg.DurableConfig.RetentionPeriodInDays !== undefined)
          dc['RetentionPeriodInDays'] = cfg.DurableConfig.RetentionPeriodInDays;
        if (Object.keys(dc).length > 0) result['DurableConfig'] = dc;
      }
      if (cfg.TenancyConfig?.TenantIsolationMode !== undefined) {
        result['TenancyConfig'] = { TenantIsolationMode: cfg.TenancyConfig.TenantIsolationMode };
      }

      // Tags: GetFunction returns a map keyed by tag name. Filter
      // CDK / aws:* auto-tags, re-shape to CFn's `[{Key, Value}]`, and
      // omit the key entirely when AWS reports no user tags (matches
      // `create()`'s behavior of only sending Tags when the template
      // carries them).
      const tags = normalizeAwsTagsToCfn(resp.Tags);
      result['Tags'] = tags;

      // RecursiveLoop lives on a SEPARATE control-plane API
      // (GetFunctionRecursionConfig), not on GetFunction. Issue the
      // extra call and emit-when-present (AWS returns the default
      // 'Terminate' if the function never had the prop set; the drift
      // comparator's state-keys-only walk ignores the field unless
      // state carries it, so the always-emit shape from AWS does not
      // produce false-positive drift on functions that never used
      // RecursiveLoop).
      try {
        const rlResp = await this.lambdaClient.send(
          new GetFunctionRecursionConfigCommand({ FunctionName: physicalId })
        );
        if (rlResp.RecursiveLoop !== undefined) {
          result['RecursiveLoop'] = rlResp.RecursiveLoop;
        }
      } catch (rlErr) {
        // Non-fatal: tolerate transient access failures on the
        // secondary read so the primary read still produces a usable
        // snapshot. The drift report just omits RecursiveLoop on the
        // (rare) failure.
        if (!(rlErr instanceof ResourceNotFoundException)) {
          this.logger.debug(
            `GetFunctionRecursionConfig failed for ${physicalId}: ${describeAwsFailure(rlErr).detail}`
          );
        }
      }

      // ReservedConcurrentExecutions: a SEPARATE control-plane read
      // (GetFunctionConcurrency), emit-when-present. AWS returns an
      // empty response (no `ReservedConcurrentExecutions` field) for
      // functions that never set the limit, so a zero / undefined
      // response correctly maps to omit-from-readback — no phantom
      // drift on the typical un-throttled function.
      try {
        const pcResp = await this.lambdaClient.send(
          new GetFunctionConcurrencyCommand({ FunctionName: physicalId })
        );
        if (pcResp.ReservedConcurrentExecutions !== undefined) {
          result['ReservedConcurrentExecutions'] = pcResp.ReservedConcurrentExecutions;
        }
      } catch (pcErr) {
        if (!(pcErr instanceof ResourceNotFoundException)) {
          this.logger.debug(
            `GetFunctionConcurrency failed for ${physicalId}: ${describeAwsFailure(pcErr).detail}`
          );
        }
      }

      // Runtime-management controls and code signing apply to managed-runtime
      // ZIP functions only. Container-image functions own their runtime in the
      // image and do not support Lambda code signing, so AWS rejects both
      // secondary reads with `InvalidParameterValueException` (the write side
      // refuses the same two properties: `refuseImageFunctionUnsupported`).
      // Skipping them when GetFunction already identified the package as Image
      // saves two calls per readback and the two spurious `... failed`
      // warnings (neither rejection is a `ResourceNotFoundException`) each
      // drift snapshot of an image function printed. It prevents no false removal: AWS never
      // accepted either property on an image, so no baseline can carry them.
      if (cfg.PackageType !== 'Image') {
        // RuntimeManagementConfig: a SEPARATE control-plane read
        // (GetRuntimeManagementConfig), emit-when-present. AWS returns the
        // default `UpdateRuntimeOn: 'Auto'` for functions that never set it;
        // the comparator's state-keys-only walk ignores the field unless state
        // carries it, so the always-emit shape produces no phantom drift.
        try {
          const rmResp = await this.lambdaClient.send(
            new GetRuntimeManagementConfigCommand({ FunctionName: physicalId })
          );
          if (rmResp.UpdateRuntimeOn !== undefined) {
            const rm: Record<string, unknown> = { UpdateRuntimeOn: rmResp.UpdateRuntimeOn };
            // Only meaningful under Manual; AWS omits it otherwise.
            if (rmResp.RuntimeVersionArn !== undefined) {
              rm['RuntimeVersionArn'] = rmResp.RuntimeVersionArn;
            }
            result['RuntimeManagementConfig'] = rm;
          }
        } catch (rmErr) {
          if (!(rmErr instanceof ResourceNotFoundException)) {
            // WARN, not debug: this read backs a drift-compared key, so a
            // permission / throttle failure omits RuntimeManagementConfig from
            // the snapshot and `cdkd drift` then reports it as a REMOVAL against
            // state. The warning is what makes that false drift explainable.
            this.logger.warn(
              `GetRuntimeManagementConfig failed for ${physicalId} — RuntimeManagementConfig omitted from the drift snapshot (may surface as a false removal): ${describeAwsFailure(rmErr).detail}`
            );
          }
        }

        // CodeSigningConfigArn: a SEPARATE control-plane read
        // (GetFunctionCodeSigningConfig), emit-when-present. AWS raises
        // ResourceNotFoundException for a function with no code-signing config
        // attached, which the shared catch below maps to omit-from-readback —
        // no phantom drift on the typical function.
        try {
          const csResp = await this.lambdaClient.send(
            new GetFunctionCodeSigningConfigCommand({ FunctionName: physicalId })
          );
          if (csResp.CodeSigningConfigArn !== undefined) {
            result['CodeSigningConfigArn'] = csResp.CodeSigningConfigArn;
          }
        } catch (csErr) {
          if (!(csErr instanceof ResourceNotFoundException)) {
            // WARN for the same reason as the read above — an omitted
            // CodeSigningConfigArn reads as a removed security control.
            this.logger.warn(
              `GetFunctionCodeSigningConfig failed for ${physicalId} — CodeSigningConfigArn omitted from the drift snapshot (may surface as a false removal): ${describeAwsFailure(csErr).detail}`
            );
          }
        }
      }

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Lambda ZIP-package `Code` sub-paths AWS does not return on read.
   *
   * `GetFunction` returns a pre-signed S3 URL for ZIP-deployed code
   * (`Code.Location`), not the original `S3Bucket` / `S3Key` cdkd state
   * holds. `ZipFile` is inline source that AWS never echoes back. These
   * three fields are write-only via the GetFunction API (Category 1).
   *
   * `Code.ImageUri` IS recoverable — `GetFunction.Code.ImageUri` returns
   * the templated image URI for container Lambdas — so it is surfaced by
   * `readCurrentState` and NOT declared drift-unknown. `Code.SourceKMSKeyArn`
   * is also write-only on the FunctionCodeLocation read shape.
   *
   * Pre-PR this method returned the whole `['Code']` subtree as
   * drift-unknown, which also hid `Code.ImageUri` drift on container
   * Lambdas. Narrowing the skip-list re-enables that detection.
   */
  getDriftUnknownPaths(): string[] {
    return [
      'Code.S3Bucket',
      'Code.S3Key',
      'Code.S3ObjectVersion',
      'Code.ZipFile',
      'Code.SourceKMSKeyArn',
    ];
  }

  /**
   * Adopt an existing Lambda function into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.FunctionName` → use directly,
   *     verify via `GetFunction`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'FunctionName');
    if (explicit) {
      try {
        await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // function reaching here needs an explicit `--resource` override.
    return null;
  }
}
