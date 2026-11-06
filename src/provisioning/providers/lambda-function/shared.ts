import { safeStringify } from '../../../utils/aws-failure-text.js';
import type { CapacityProviderConfig } from '@aws-sdk/client-lambda';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  isRetryableTransientError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import {
  createMaskedLogSinks,
  isSecretDerivedValue,
  MASK_WALK_DEPTH_CAP_MARKER,
  MASK_WALK_MAX_DEPTH,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../../masked-retry-logger.js';

/**
 * A Lambda function NAME (1-64 of `a-z A-Z 0-9 _ -`), the physical id this
 * provider records. The identity answers (`isSameResource`,
 * `resourceIdentity`) refuse anything else: `GetFunction` also takes an ARN,
 * a partial ARN or a qualified name, which this provider never records and
 * would only be guessing about.
 */
export function isFunctionName(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * go-to-k/cdkd#4606 / #4655: a function's identity token,
 * `<FunctionArn>@<LastModified epoch ms>`. The ARN is built from the name, so
 * a function re-created under the same name repeats it; `LastModified`, set
 * by `CreateFunction`, is what tells the two apart. The
 * `lambda-fix-forward-orphan` fixture measures that a re-create under the
 * name moves it, and that the Pending to Active transition and a successful
 * `PutFunctionRecursionConfig` do not; it measures `PutFunctionConcurrency`
 * where the account allows a reservation. A successful
 * `PutRuntimeManagementConfig` DOES move it, so `create` drops the
 * CreateFunction token after that call. A code or configuration update moves
 * it too. A moved one only keeps the orphan (the settle
 * warns instead of deleting). That includes cdkd's own update: `delete`'s VPC
 * pre-detach (`UpdateFunctionConfiguration`) moves it, so a VPC orphan whose
 * `DeleteFunction` then fails is never proven again and is left to delete by
 * hand. `undefined` for a missing ARN or an unparseable
 * time.
 */
export function functionIdentityToken(
  arn: string | undefined,
  lastModified: string | undefined
): string | undefined {
  if (typeof arn !== 'string' || arn === '') return undefined;
  if (typeof lastModified !== 'string' || lastModified === '') return undefined;
  const ms = Date.parse(lastModified);
  if (Number.isNaN(ms)) return undefined;
  return `${arn}@${ms}`;
}

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
export function lambdaOperationSinks(
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
export function withholdWaiterPayload(
  error: unknown,
  mask: MaskerFn
): { masked: string; described: string } | undefined {
  const described = describeLambdaWaiterFailure(error);
  if (described === undefined || !(error instanceof Error)) return undefined;
  const text = mask(described);
  const original = error.message;
  // `safeStringify`: a failure's `name` is as arbitrary as the failure, and
  // this runs inside the create / update catch (go-to-k/cdkd#3361).
  const name = safeStringify(error.name);
  const header = `${name}: ${original}`;
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
        ? `${name}: ${text}${stack.slice(header.length)}`
        : `${name}: ${text}`,
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
export const LAMBDA_CLEANUP_DELETE_MAX_ATTEMPTS = 3;

/** The version a Managed Instances function runs and scales from. */
export const LATEST_PUBLISHED = '$LATEST.PUBLISHED';

/**
 * The block CloudFormation sends on an update: an absent
 * `ExecutionEnvironmentMemoryGiBPerVCpu` goes as its default 2, so removing it
 * resets the live value. An absent `PerExecutionEnvironmentMaxConcurrency`
 * stays absent, and the live value stays (both measured, go-to-k/cdkd#5637).
 */
export function capacityProviderConfigForUpdate(
  config: CapacityProviderConfig | undefined
): CapacityProviderConfig | undefined {
  const managed = config?.LambdaManagedInstancesCapacityProviderConfig;
  if (managed === undefined) return config;
  return {
    LambdaManagedInstancesCapacityProviderConfig: {
      ...managed,
      ExecutionEnvironmentMemoryGiBPerVCpu: managed.ExecutionEnvironmentMemoryGiBPerVCpu ?? 2,
    },
  };
}

export function refuseManagedInstancesPropertiesWithoutCapacityProvider(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context: { replayingState?: boolean | undefined; physicalId?: string | undefined },
  warn: (message: string) => void
): void {
  if (properties['CapacityProviderConfig'] !== undefined) return;
  // CloudFormation refuses both ("can't be specified unless creating a Lambda
  // Managed Instance function"), so a template gets the same refusal before any
  // call (go-to-k/cdkd#5637). A record is different: an import, or a binary
  // that dropped them, holds them on a plain function that deployed fine, and
  // neither reaches a call here. So a replay warns, as
  // `.claude/rules/provider-replay-and-refusals.md` requires.
  const declared = [
    properties['PublishToLatestPublished'] !== undefined ? 'PublishToLatestPublished' : undefined,
    properties['FunctionScalingConfig'] !== undefined ? 'FunctionScalingConfig' : undefined,
  ].filter((key): key is string => key !== undefined);
  if (declared.length === 0) return;
  const named = declared.join(' and ');
  if (context.replayingState === true) {
    warn(
      `Lambda function ${logicalId} records ${named} without CapacityProviderConfig; ` +
        `ignoring ${declared.length === 1 ? 'it' : 'them'} for this replay.`
    );
    return;
  }
  throw markNonRetryable(
    new ProvisioningError(
      `Lambda function ${logicalId} declares ${named} without CapacityProviderConfig: AWS ` +
        `applies ${declared.length === 1 ? 'it' : 'them'} to Lambda Managed Instances functions ` +
        `only. Add a capacity provider, or remove ${named}.`,
      resourceType,
      logicalId,
      context.physicalId
    )
  );
}

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
export function refuseImageFunctionUnsupported(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  physicalId?: string
): void {
  if (properties['PackageType'] !== 'Image') return;
  // Literal reads, not a loop over a name table: each consumed property stays
  // visible (and greppable) as its own `properties['X']` read.
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
 * go-to-k/cdkd#5487: the keys `update()` applies with their own calls, which no
 * `State` / `LastUpdateStatus` transition covers.
 */
export const SEPARATELY_APPLIED_KEYS: ReadonlySet<string> = new Set([
  'Tags',
  'ReservedConcurrentExecutions',
  'RecursiveLoop',
  'CodeSigningConfigArn',
  'RuntimeManagementConfig',
  'FunctionScalingConfig',
]);
