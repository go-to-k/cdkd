import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { injectiveKey } from '../../state/record-keys.js';
import { stringifyValue } from '../../utils/stringify.js';
import {
  MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES,
  type NamedRequestMasks,
  type ResolverContext,
  dynamicReferenceRetryDelays,
  quotedRender,
} from './support.js';
import { withRetry } from '../retry.js';
import { isThrottlingError, markNonRetryable } from '../retryable-errors.js';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';

/** `sendWithThrottleRetry` keeps its type parameter, which `OmitThisParameter` would erase. */
type SendWithThrottleRetry = <T>(
  operation: () => Promise<T>,
  ...rest: Parameters<OmitThisParameter<typeof sendWithThrottleRetry>> extends [unknown, ...infer R]
    ? R
    : never
) => Promise<T>;

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    resolveSecretsManagerReference: OmitThisParameter<typeof resolveSecretsManagerReference>;
    /** @internal */
    sendWithThrottleRetry: SendWithThrottleRetry;
    /** @internal */
    resolveSSMReference: OmitThisParameter<typeof resolveSSMReference>;
  }
}

/**
 * Resolve a Secrets Manager dynamic reference
 *
 * Format: secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID
 * SECRET_ID can be a simple name or an ARN (arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME)
 * which contains colons, so we cannot simply split on ':'.
 * Instead, we find ':SecretString:' or ':SecretBinary:' as the delimiter.
 *
 * The whole-secret form omits everything after the type segment and carries no trailing
 * colon: "secretsmanager:SECRET_ID:SecretString" (returns the full secret string). We detect
 * it with an end-anchored check so that, for the whole-secret form, a SECRET_ID that merely
 * contains ":SecretString" mid-name is not split incorrectly. (The end-anchored fallback only
 * runs when no mid-string ":SecretString:" delimiter is present, so the json-key / version
 * forms are unaffected.)
 */
export async function resolveSecretsManagerReference(
  this: IntrinsicFunctionResolver,
  inner: string,
  // For the two log lines below only (issue #2728): a reference ASSEMBLED
  // by `Fn::Sub` / `Fn::Join` from a value this pass resolved out of a
  // secret carries that plaintext in its secret id / JSON key, and the
  // debug echo and the retry label would print it.
  context: ResolverContext | undefined,
  // Each name's log text, from the token's twin (issue #3150,
  // `dynamicReferenceNameLogText`). Required: a default would print the
  // names raw for a caller that forgot it.
  nameLogText: (name: string) => string
): Promise<string> {
  // inner = "secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID"
  // Remove the "secretsmanager:" prefix
  const afterService = inner.substring('secretsmanager:'.length);

  // Find :SecretString: or :SecretBinary: as the delimiter between SECRET_ID and the rest
  let secretId: string;
  let jsonKey = '';
  let versionStage = '';
  let versionId = '';

  let secretStringIdx = afterService.indexOf(':SecretString:');
  let secretBinaryIdx = afterService.indexOf(':SecretBinary:');
  let delimiterLenAtBinary = ':SecretBinary:'.length;
  let delimiterLenAtString = ':SecretString:'.length;

  // Whole-secret form: "<SECRET_ID>:SecretString" / "<SECRET_ID>:SecretBinary" with NO
  // trailing colon and no JSON_KEY (end of string). The trailing-colon indexOf above misses
  // it, so fall back to an END-ANCHORED check. An end-anchored check (not a loose includes)
  // avoids a false split when a secret NAME legitimately contains ":SecretString" mid-name.
  if (secretStringIdx < 0 && afterService.endsWith(':SecretString')) {
    secretStringIdx = afterService.length - ':SecretString'.length;
    delimiterLenAtString = ':SecretString'.length;
  }
  if (secretBinaryIdx < 0 && afterService.endsWith(':SecretBinary')) {
    secretBinaryIdx = afterService.length - ':SecretBinary'.length;
    delimiterLenAtBinary = ':SecretBinary'.length;
  }

  const delimiterIdx =
    secretStringIdx >= 0 && secretBinaryIdx >= 0
      ? Math.min(secretStringIdx, secretBinaryIdx)
      : secretStringIdx >= 0
        ? secretStringIdx
        : secretBinaryIdx;
  const delimiterLen =
    delimiterIdx >= 0 && delimiterIdx === secretBinaryIdx
      ? delimiterLenAtBinary
      : delimiterLenAtString;

  if (delimiterIdx >= 0) {
    secretId = afterService.substring(0, delimiterIdx);
    // remaining = "JSON_KEY:VERSION_STAGE:VERSION_ID" (empty for the whole-secret form)
    const remaining = afterService.substring(delimiterIdx + delimiterLen);
    const remainingParts = remaining.split(':');
    jsonKey = remainingParts[0] || '';
    versionStage = remainingParts[1] || '';
    versionId = remainingParts[2] || '';
  } else {
    // No :SecretString: or :SecretBinary: found, treat entire afterService as SECRET_ID
    secretId = afterService;
  }

  // Empty strings should be treated as undefined (handles trailing :: in references)
  if (!versionStage) {
    versionStage = 'AWSCURRENT';
  }

  if (!secretId) {
    throw markNonRetryable(new Error('Dynamic reference: secretsmanager SECRET_ID is required'));
  }

  // MASKED PER RAW VALUE rather than over the assembled message (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `secretId` /
  // `jsonKey` come from the ASSEMBLED reference text — `resolveSub` /
  // `resolveJoin` re-enter `resolveDynamicReferences` with the assembled
  // string — so an `Fn::Sub` that builds either out of a value this same
  // pass decrypted puts that plaintext in every line and every throw below.
  // The raw-value form is what buys `maskSecretsInText`'s WHOLE-VALUE arm,
  // which has no {@link MIN_NEEDLE_LENGTH} floor; masking the finished
  // message reaches only the substring arm, where a sub-floor plaintext
  // prints in full. Same rule `masked-retry-logger.ts` states for a
  // provider's wrapped `error.message`.
  const loggedSecretId = this.displayMasked(nameLogText(secretId), context);
  const loggedJsonKey = this.displayMasked(nameLogText(jsonKey), context);

  this.logger.debug(
    `Resolving dynamic reference: secretsmanager:${loggedSecretId}:SecretString:${loggedJsonKey}:` +
      `${this.displayMasked(nameLogText(versionStage), context)}:` +
      `${this.displayMasked(nameLogText(versionId), context)}`
  );

  // Region-sensitive, and the reason issue #1957 is a security defect rather
  // than only a correctness one: the same secret NAME in two regions is two
  // different credentials.
  const client = this.clientsForRegion(this.explicitRegion).secretsManager;

  const command = new GetSecretValueCommand({
    SecretId: secretId,
    ...(versionStage && versionStage !== '' && { VersionStage: versionStage }),
    ...(versionId && versionId !== '' && { VersionId: versionId }),
  });

  const response = await this.sendWithThrottleRetry(
    () => client.send(command),
    `secretsmanager:${loggedSecretId}`,
    // Every name the REQUEST carries, as sent (go-to-k/cdkd#3171). The JSON
    // key is not sent, so no SDK text can quote it.
    this.namedRequestMasks(
      [
        [secretId, loggedSecretId],
        [versionStage, this.displayMasked(nameLogText(versionStage), context)],
        [versionId, this.displayMasked(nameLogText(versionId), context)],
      ],
      context
    )
  );
  const secretString = response.SecretString;

  if (!secretString) {
    throw markNonRetryable(
      new Error(
        `Dynamic reference: secret ${quotedRender(loggedSecretId, "'")} does not contain a SecretString value`
      )
    );
  }

  // If JSON_KEY is specified, parse JSON and extract the key
  if (jsonKey) {
    try {
      const parsed = JSON.parse(secretString) as Record<string, unknown>;
      // `Object.hasOwn` (issue #2767), and the worst site of the class:
      // `jsonKey` comes from the dynamic reference's own text, so
      // `{{resolve:secretsmanager:<id>:SecretString:constructor}}` read the
      // `Object` function out of the parsed secret, passed the not-found
      // throw below, and `stringifyValue` rendered its SOURCE TEXT as the
      // resolved secret value.
      const keyValue = Object.hasOwn(parsed, jsonKey) ? parsed[jsonKey] : undefined;
      if (keyValue === undefined) {
        throw markNonRetryable(
          new Error(
            `Dynamic reference: key ${quotedRender(loggedJsonKey, "'")} not found in secret ${quotedRender(loggedSecretId, "'")}`
          )
        );
      }
      // NOT part of the `stringifyValue` escaping class (issue #2759): the
      // encoding happens HERE, before `resolveDynamicReferences` records the
      // returned string as the needle, so what the bag holds IS the encoded
      // form and every later masker matches it literally.
      return stringifyValue(keyValue);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw markNonRetryable(
          new Error(
            `Dynamic reference: secret ${quotedRender(loggedSecretId, "'")} is not valid JSON but JSON_KEY ${quotedRender(loggedJsonKey, "'")} was specified`
          )
        );
      }
      throw error;
    }
  }

  // No JSON_KEY: return full secret string
  return secretString;
}

/**
 * Run one dynamic-reference lookup, retrying THROTTLE-shaped failures only
 * (issue #1933 review).
 *
 * Both lookups behind `{{resolve:...}}` were bare `send` calls, so a single
 * `Rate exceeded` aborted the deploy. That was already the wrong trade for a
 * read, and this PR raises the call count on both paths: the resolved-value
 * cache is per-resolver now (one lookup per stack rather than one per
 * process), and a value whose ssm `Type` came back unclassifiable is
 * deliberately not cached at all (one lookup per OCCURRENCE, so it re-asks
 * AWS rather than inheriting a transient verdict). Retrying only the throttle
 * shape keeps every real answer — `ParameterNotFound`, `AccessDenied`, a
 * malformed reference — failing fast and unchanged.
 *
 * Two bounds, both NAMED rather than fixed here:
 *
 * - No `isInterrupted` is threaded, so a Ctrl-C landing inside the backoff is
 *   only noticed when that sleep ends — worst case ~8s, ~15s across the whole
 *   schedule. `withRetry` supports the hook, but the only interrupt state in
 *   the tree is `DeployEngine.interrupted`, which reaches nothing here;
 *   wiring it means a resolver option threaded from that engine.
 * - It says NOTHING about concurrency. The client is captured before the
 *   first attempt, so a sibling stack's teardown (`stackAwsClients.destroy()`
 *   in `deploy.ts`) during a backoff surfaces as a raw, non-throttle-shaped
 *   failure on the next attempt, and the retry does not make that safe. Issue
 *   [#1957](https://github.com/go-to-k/cdkd/issues/1957) NARROWED this rather
 *   than removing it: a lookup whose region differs from the ambient one now
 *   runs on {@link clientsForRegion}'s own clients, which no sibling stack can
 *   destroy because nothing else in the process holds a reference to them. A
 *   sibling in the SAME region still shares the ambient instance, so the
 *   window survives exactly where the two stacks agree on the region.
 */
export async function sendWithThrottleRetry<T>(
  this: IntrinsicFunctionResolver,
  operation: () => Promise<T>,
  label: string,
  // REQUIRED (go-to-k/cdkd#3171): the lookup's request carries the
  // reference's names, and both SDK-text routes out of here quote them — the
  // retry line and the rethrown rejection. A default would print them raw
  // for a caller that forgot it.
  masks: NamedRequestMasks
): Promise<T> {
  try {
    return await withRetry(operation, label, {
      maxRetries: MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES,
      // Classifies the RAW error: the retry decision is made before any
      // masking, so masking cannot change which failures are retried.
      isRetryable: (_message, error) => isThrottlingError(error),
      logger: masks.retryLogger,
      ...(dynamicReferenceRetryDelays.sleep ? { sleep: dynamicReferenceRetryDelays.sleep } : {}),
    });
  } catch (error) {
    throw masks.error(error);
  }
}

/**
 * Resolve an `{{resolve:ssm:...}}` dynamic reference, reporting whether the
 * parameter is a `SecureString` (issue #1901).
 *
 * `secure` is read off the SAME `GetParameter` response that carries the
 * value, so classifying a reference costs no extra API call — which is what
 * makes it affordable on the comparison path too.
 *
 * `decrypt` maps straight to `WithDecryption`. SSM ignores it for `String` /
 * `StringList` (their `Value` is identical either way), so the only thing it
 * changes is whether a `SecureString`'s `Value` comes back as plaintext or as
 * its encrypted blob. Callers that only need the TYPE pass `false` and MUST
 * discard the value when `secure` is set — it is ciphertext, not the resolved
 * reference.
 */
export async function resolveSSMReference(
  this: IntrinsicFunctionResolver,
  parts: string[],
  decrypt: boolean,
  // The spelling being resolved — `ssm` or, since issue #2482, `ssm-secure`.
  // Log-only: it names the reference in the debug / retry / warning lines so
  // an `ssm-secure` lookup is not reported as an `ssm` one.
  service: 'ssm' | 'ssm-secure',
  // For the log lines only (issue #2728) — see `resolveSecretsManagerReference`.
  context: ResolverContext | undefined,
  // As in `resolveSecretsManagerReference` (issue #3150), and required for
  // the same reason.
  nameLogText: (name: string) => string
): Promise<{ value: string; secure: boolean; type: string | undefined }> {
  const parameterName = parts.slice(1).join(':');

  if (!parameterName) {
    // not-in-class(service): the typed `service: 'ssm' | 'ssm-secure'` PARAMETER of resolveSSMReference, not the text parsed off an assembled reference.
    throw markNonRetryable(new Error(`Dynamic reference: ${service} PARAMETER_NAME is required`));
  }

  // MASKED PER RAW VALUE — see `resolveSecretsManagerReference`'s twin
  // comment for why the raw form and not the assembled message (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)).
  const loggedParameterName = this.displayMasked(nameLogText(parameterName), context);

  // not-in-class(service): the typed `service: 'ssm' | 'ssm-secure'` PARAMETER of resolveSSMReference, not the text parsed off an assembled reference.
  this.logger.debug(`Resolving dynamic reference: ${service}:${loggedParameterName}`);

  // Region-sensitive in BOTH of its outputs: the value, and the `Type` this
  // method reports back. A region-B `SecureString` classified against a
  // region-A `String` namesake is persisted in PLAINTEXT (issue #1957).
  const client = this.clientsForRegion(this.explicitRegion).ssm;

  const command = new GetParameterCommand({
    Name: parameterName,
    WithDecryption: decrypt,
  });

  const response = await this.sendWithThrottleRetry(
    () => client.send(command),
    `${service}:${loggedParameterName}`,
    // The one name the request carries (go-to-k/cdkd#3171).
    this.namedRequestMasks([[parameterName, loggedParameterName]], context)
  );
  const paramValue = response.Parameter?.Value;

  if (paramValue === undefined || paramValue === null) {
    throw markNonRetryable(
      new Error(
        `Dynamic reference: SSM parameter ${quotedRender(loggedParameterName, "'")} not found or has no value`
      )
    );
  }

  // A SecureString parameter reached through the plain `{{resolve:ssm:...}}`
  // form decrypts to a real secret, so the caller treats it exactly like a
  // `{{resolve:secretsmanager:...}}` value: hand the plaintext to the provider,
  // persist the unresolved expression. Plain `String` / `StringList` is public
  // config and stays resolved in state (issue #1901).
  //
  // The predicate names the PUBLIC types rather than testing for
  // `=== 'SecureString'`, so it fails CLOSED: an absent `Type` (the SDK types
  // every field optional), an unexpected spelling, or a type AWS adds later
  // is treated as SECRET. Testing for the secret type instead would classify
  // all three as public, which on the deploy path persists plaintext — the
  // exact disclosure this fix exists to close — and on the comparison path
  // would substitute and cache the `WithDecryption: false` CIPHERTEXT. The
  // cost of the safe direction is bounded and self-consistent: an unclassified
  // parameter is stored as its expression and compared as its expression, so
  // it does not become a perpetual UPDATE, and the two genuinely-public types
  // are named explicitly so no real `String` / `StringList` is affected.
  const paramType = response.Parameter?.Type;
  // `type` is reported alongside the verdict so the caller can tell a
  // DEFINITIVE `SecureString` (safe to memoize) from an unclassifiable one
  // (treated as secret, but not pinned — see the caller).
  const secure = paramType !== 'String' && paramType !== 'StringList';
  if (
    secure &&
    paramType !== 'SecureString' &&
    !this.warnedUnrecognizedSsmTypes.has(injectiveKey(parameterName, String(paramType)))
  ) {
    // Reached only if AWS stops returning `Type`, or returns one cdkd does not
    // know. The value is treated as a secret (see above), which is safe but
    // silently changes what state stores — so say so rather than let the
    // parameter quietly start persisting as its expression. Once per
    // (parameter, type) per resolver — see `warnedUnrecognizedSsmTypes`.
    // ENCODED, not separated (go-to-k/cdkd#3496). DEFENCE IN DEPTH: the
    // warned-once class of go-to-k/cdkd#3308, but only ONE half is ungated.
    // `parameterName` is template text; the other half is the SDK's own
    // `Type` string, so a collision would need AWS to return one carrying a
    // NUL. Encoded so the set does not depend on that, since what it would
    // cost is the SECOND warning about a parameter silently persisting as
    // its expression.
    this.warnedUnrecognizedSsmTypes.add(injectiveKey(parameterName, String(paramType)));
    // Through the builder (issue #3441): this arm is reached precisely
    // because the `Type` matched NONE of the names cdkd knows, so its text is
    // unconstrained — being a type name answers the secret question, not
    // the control-character one.
    const reported =
      paramType === undefined
        ? '(absent)'
        : quotedRender(this.displayMasked(String(paramType), context), "'");
    // Masked like the debug echo above (issue #2728), and per RAW VALUE
    // since issue #2827: the name may have been assembled from a value this
    // pass resolved out of a secret.
    // not-in-class(service): the typed `service: 'ssm' | 'ssm-secure'` PARAMETER of resolveSSMReference, not the text parsed off an assembled reference.
    this.logger.warn(
      `SSM parameter ${quotedRender(loggedParameterName, "'")} reported an unrecognized Type ${reported} — treating ` +
        `its value as a secret, so cdkd will persist the {{resolve:${service}:...}} expression rather ` +
        `than the resolved value. Declare the parameter as String / StringList if it is ` +
        `public config.`
    );
  }
  return { value: paramValue, secure, type: paramType };
}
