/**
 * Split a caught failure into the half that is safe to THROW and the half that
 * belongs at `logger.debug` (issue
 * [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * A LEAF module with no imports, for the reason `display-safe.ts` states: a
 * rule widened BY HAND one call site at a time misses an instance every round,
 * and this one has already shipped twice — once on the terminal warns PR
 * [#2290](https://github.com/go-to-k/cdkd/pull/2290) fixed, and again at the
 * four THROW sites it explicitly left out of its delta.
 *
 * ## Why a thrown message is a different surface from a logged one
 *
 * PR #2290 answered this class on the S3 provider's identity WARN: the error
 * CLASS at default verbosity, AWS's own text at `debug`. That surface is
 * terminal-only — a provider `logger.*` reaches no engine sink. A THROWN
 * message is not: it flows through `extractDeploymentEventError` into the
 * persisted `deployments/{runId}.jsonl` store, which outlives the run and is
 * explicitly restricted to error plus metadata. So the split has to happen
 * BEFORE the throw rather than at a log call, and that is the only part of the
 * sibling's answer that does not copy across unchanged.
 *
 * What makes AWS's text worth withholding: on the headline population — a
 * principal without the grant, or a bucket policy that `Deny`s it — S3 words
 * its `AccessDenied` as `User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...`, so interpolating it writes the caller's account id, role name
 * and session name into that durable store.
 *
 * ## Why it does not simply DROP the message
 *
 * Learned the expensive way on PR #2290: redaction that DISCARDS the text is
 * its own defect. AWS's wording is what separates a missing IAM grant from a
 * bucket-policy `Deny`, and that distinction is the operator's next action.
 * Both halves are therefore returned, and callers are expected to emit BOTH —
 * {@link AwsFailureText.summary} into the thrown message and
 * {@link AwsFailureText.detail} at `logger.debug`. A caller that emits only the
 * summary has turned this helper into the defect it exists to prevent.
 *
 * ## Why the redaction is NARROW, and why the obvious wider rule is wrong
 *
 * Only a failure AWS AUTHORED is reduced to its class. The obvious wider
 * polarity — "redact anything cdkd did not author, i.e. anything that is not a
 * `CdkdError`" — reads as the fail-safe choice and was MEASURED to be a
 * regression before it shipped: the four sites this exists for sit in broad
 * `catch` blocks, and `s3-bucket-provider.ts` alone raises SIX cdkd-authored
 * plain `Error`s inside them (the `BucketEncryption` / `OwnershipControls`
 * array refusals, the EventBridge and inventory `Enabled` refusals, the
 * destination-shape refusal, and the non-empty-bucket delete refusal, whose
 * text is the CloudFormation-parity remediation a user needs). Reducing each of
 * those to the token `Error` would delete the entire remedy the refusal exists
 * to deliver — the same defect as dropping AWS's message, arriving from the
 * other side. Wrong text is not made safe by being short.
 *
 * So the test is what SET the message, and {@link isAwsAuthoredFailure} is the
 * whole statement of it: a real SERVICE signal — `$fault`, or a NUMERIC
 * `$metadata.httpStatusCode` — plus the `CredentialsProviderError` name for the
 * one AWS-authored shape that carries neither. Nothing under `src/` sets any of
 * them.
 *
 * It was the mere PRESENCE of `$metadata` / `$fault` / `$response` until issue
 * [#3297](https://github.com/go-to-k/cdkd/issues/3297), on the premise that
 * those are fields only an SDK error carries. That premise is true and the
 * conclusion still did not follow: `@smithy/core`'s retry middleware stamps
 * `$metadata` onto every error it gives up on, socket errors included, so the
 * predicate answered YES for a transport failure and reduced
 * `connect ECONNREFUSED <ip>:443` to the bare token `Error`.
 *
 * **`extractDeploymentEventError` still keys its own AWS-shaped test on
 * `$metadata` presence, and that is a DIFFERENT question rather than a
 * divergence to reconcile.** It asks "is there wire metadata worth recording"
 * — the `requestId` and the wire `Code` it records for the events store —
 * where this asks "did AWS write this sentence". A socket error answers yes to the first and no to
 * the second. An earlier revision of this comment cited that function as
 * evidence that the presence test was "the repo's existing predicate"; it is
 * not evidence, and citing it that way is how the defect justified itself.
 *
 * The chain is deliberately NOT walked. A cdkd error WRAPPING an AWS one has
 * its own authored text at the top, and walking would reduce that to the
 * wrapper's class — re-creating the loss above one indirection out. The
 * residual that leaves is a cdkd-authored message that INTERPOLATES an AWS one
 * before this helper sees it; the sweep behind #2302 measured zero such throws
 * in `s3-bucket-provider.ts` after the three sites there were fixed, and the
 * grep for the shape is the same one that finds every other instance of this
 * class.
 *
 * ## Two PRECONDITIONS for adopting this helper at a new site
 *
 * Both are about what ELSE reads the message once it is shorter. Neither is
 * checkable from here, so a new caller has to establish them.
 *
 * 1. **Retry classification.** cdkd's retry classifiers match by SUBSTRING over
 *    a message, so withholding AWS's wording also withholds the substrings they
 *    match on -- measured on the S3 wraps, `not authorized to perform` and
 *    `conflicting conditional operation` both went from retryable to terminal.
 *    There is NOT one such classifier, and this list is deliberately NOT
 *    presented as complete -- an earlier revision said "THREE, not one" and
 *    spec review found three more the same day, in the very provider files the
 *    go-to-k/cdkd#2319 sweep targets. GREP before adopting this helper at a new
 *    site rather than trusting an enumeration:
 *      grep -rn "instanceof Error ? .*\.message" src/ | grep -iE "retry|transient"
 *    Known at the time of writing: `retry.ts`'s `withRetry`,
 *    `destroy-runner.ts`'s own delete-retry loop (which calls `provider.delete`
 *    DIRECTLY and so is not covered by the first),
 *    `deletion-protection-compensation.ts`'s `isTerminalDeleteFailure` (on the
 *    chain since go-to-k/cdkd#4318),
 *    `apigateway/account.ts`'s `isIamPropagationError` (top-level message,
 *    matches `not authorized` -- exactly the substring this helper withholds),
 *    `EC2Provider`'s `isDependencyViolationError` (`ec2/tags-errors.ts`), and
 *    `custom-resource-provider.ts`'s `isTransientAuthzThrow`.
 *
 *    The remedy is `markRedactedCause` (`src/deployment/retryable-errors.ts`),
 *    which tells `retryClassificationText` to read the `.cause` chain instead
 *    -- but it is correct only when TWO things hold, and stamping without the
 *    second is worse than not stamping at all:
 *      a. the throw is reachable from one of those classifiers -- established
 *         by the grep above, not by this list; AND
 *      b. the chain actually CARRIES the text this helper withheld, i.e. the
 *         error whose `detail` you dropped is the one threaded as `cause`.
 *    Where (b) fails the stamp recovers nothing and merely feeds an unrelated
 *    error's message to classification -- the same un-audited widening the
 *    opt-in design was built to refuse. `assertAssetBucketRegion` is the worked
 *    example: it threads the ORIGINATING error as `cause` rather than the probe
 *    failure it redacted, so it deliberately does NOT stamp, and relies on the
 *    `debug` line for the detail.
 * 2. **"Already deleted" detection.** `destroy-runner.ts` and
 *    `deploy-engine.ts` decide a resource is already gone by matching
 *    not-found wording against the SAME thrown message. Reducing it to a class
 *    name defeats that, and the failure is not cosmetic: an idempotent
 *    re-destroy becomes a hard failure that leaves the state row behind. The S3
 *    sites are safe because `S3BucketProvider.delete` has a TYPED
 *    `error instanceof NoSuchBucket` guard that returns before the wrap is ever
 *    built. A provider with no typed not-found guard must grow one BEFORE it
 *    adopts this helper -- do not rely on the substring surviving redaction.
 */
export interface AwsFailureText {
  /**
   * Safe to interpolate into a THROWN (and therefore PERSISTED) message.
   *
   * The error CLASS plus a pointer to `--verbose` for an AWS-authored failure;
   * the failure's own message, verbatim, for anything else.
   */
  readonly summary: string;
  /**
   * The failure's own text, in full.
   *
   * Written as `logger.debug` ONLY, and that is no longer where it is used.
   * The out-throw sweeps (go-to-k/cdkd#3330, go-to-k/cdkd#3348) converted
   * ~215 sites from `x instanceof Error ? x.message : String(x)` to this
   * field, because it IS that expression minus the throw — so every
   * `logger.warn` and `logger.error` that already interpolated the ternary now
   * interpolates `detail`, at DEFAULT level. That is a restatement of where
   * the text already went, not a widening: no site's output changed.
   *
   * What still holds, and is the half worth keeping: this is the UNREDACTED
   * text, so a THROWN message built from it is persisted to
   * `deployments/{runId}.jsonl` and an AWS `AccessDenied` there spells out the
   * caller's assumed-role ARN. Those sites are go-to-k/cdkd#2319's, and a NEW
   * one needs that question answered first. No count is given on purpose: an
   * earlier revision said "ten", which was not re-derivable — every such site
   * reaches the throw through an intermediate binding, so there is no grep that
   * settles it, and a number nothing can check is one that silently goes stale.
   * Prefer {@link summary} wherever a wire class is enough — but never where
   * the text feeds a substring classifier, which `summary` blinds.
   */
  readonly detail: string;
  /**
   * Whether {@link summary} withheld the failure's own text.
   *
   * `true` for every AWS-authored failure and for a non-`Error` throw, `false`
   * for a pass-through. It reports WHICH BRANCH was taken, not the result of
   * comparing the two strings -- an earlier revision of this doc said "false
   * when the two are the same string", which the code never checks. The
   * distinction is only theoretical (a redacted `summary` always carries the
   * `--verbose` pointer, so it can never equal `detail`), but a doc describing a
   * comparison that does not exist is the kind of thing a later reader
   * implements against.
   *
   * Callers do not need it to compose their message (the pointer is already
   * inside `summary`); it exists so a caller can skip a `debug` line that would
   * only repeat the throw, and so a test can pin the branch rather than
   * inferring it from a substring.
   */
  readonly redacted: boolean;
}

/**
 * Appended to a redacted summary so the withheld half is still reachable.
 *
 * EXPORTED for the TESTS, and that is now its only reason. It was exported
 * because `cloud-control-provider.ts`'s `abandonWait` reduced on its own wider
 * predicate and had to compose this sentence by hand; issue
 * [#3297](https://github.com/go-to-k/cdkd/issues/3297) removed that predicate
 * and the hand-copy with it, so no `src/` file spells this literal twice. The
 * remaining importer is `cloud-control-wait-abandoned.test.ts`, which asserts
 * the ABSENCE of the pointer and would silently stop discriminating if it
 * hard-coded the words instead.
 */
export const VERBOSE_POINTER = "Re-run with --verbose for AWS's own message.";

/**
 * Whether this run is already `--verbose` (go-to-k/cdkd#6162). Then
 * {@link VERBOSE_POINTER} is advice the user has already taken, and printing it
 * sends them to re-run for output they are looking at; so every summary drops
 * it. A PROBE rather than an import: this module stays a leaf, and `logger.ts`
 * registers it (`registerVerboseRunProbe`) when it loads. Unregistered (a test
 * that never loads the logger), the run counts as not verbose.
 */
let verboseRunProbe: () => boolean = () => false;

/** `logger.ts` points this at its own level; tests reset it. */
export function registerVerboseRunProbe(probe: () => boolean): void {
  verboseRunProbe = probe;
}

function verboseRun(): boolean {
  try {
    return verboseRunProbe();
  } catch {
    return false;
  }
}

/**
 * {@link VERBOSE_POINTER} plus a trailing space, or `''` on a `--verbose` run.
 * For the hand-written messages that spell the pointer mid-sentence.
 */
export function verbosePointerSentence(): string {
  return verboseRun() ? '' : `${VERBOSE_POINTER} `;
}

/** `<lead>.` plus the pointer when the run is not verbose. */
function withVerbosePointer(lead: string): string {
  return `${lead}. ${verbosePointerSentence()}`.trimEnd();
}

/**
 * The summary {@link describeAwsFailure} builds for an `Error` it is reducing.
 *
 * UN-exported by issue [#3297](https://github.com/go-to-k/cdkd/issues/3297).
 * It was exported for one caller — `cloud-control-provider.ts`, whose own
 * authorship predicate was WIDER than this module's, so the helper handed it
 * raw text for a shape it wanted reduced and it had to build this string
 * itself. That predicate is gone and so is the divergence, leaving the export
 * with no callers and a doc citing one that no longer exists. Keep it private:
 * a re-export is the signal that a second predicate has appeared.
 */
function redactedAwsFailureSummary(error: Error): string {
  // `safeStringify`, not the template's own conversion: a failure's `name` is
  // as arbitrary as the failure, and every `describeAwsFailure` caller -- even
  // one reading only `.detail` -- runs this inside a catch (go-to-k/cdkd#3361).
  // Read once. Identical to the old `name || 'Error'` for every string `name`,
  // and a falsy one still gives `Error`. A truthy `name` that converts to `''`
  // (an empty array) now gives `Error` too, where the old form printed an empty
  // clause.
  const raw: unknown = error.name;
  const name = raw ? safeStringify(raw) : '';
  return withVerbosePointer(name || 'Error');
}

/**
 * Whether AWS wrote this failure's message.
 *
 * Keyed on a real SERVICE signal: `$fault`, which every modeled
 * `@smithy/smithy-client` `ServiceException` carries, or a NUMERIC
 * `$metadata.httpStatusCode`, which only a deserialized RESPONSE has. Nothing
 * under `src/` sets either, so a match cannot be a cdkd-authored error.
 *
 * **`$metadata` PRESENCE is deliberately NOT the signal, and an earlier
 * revision of this function used it** (issue
 * [#3297](https://github.com/go-to-k/cdkd/issues/3297)). `@smithy/core`'s retry
 * middleware stamps `$metadata = {attempts, totalRetryDelay}` onto EVERY error
 * it gives up on — socket errors included — and creates the object when it is
 * absent. Measured against a real `CloudControlClient` pointed at a closed
 * port:
 *
 *     name 'Error', code 'ECONNREFUSED', $fault undefined,
 *     message 'connect ECONNREFUSED 127.0.0.1:1',
 *     $metadata { attempts: 3, totalRetryDelay: 58 }
 *
 * So the old predicate classified a plain transport failure as AWS-authored and
 * reduced it to its `name` — which for a socket error is the bare token
 * `Error`, carrying no diagnosis at all. That deleted `connect ECONNREFUSED
 * <ip>:443`, the exact wording issue
 * [#3236](https://github.com/go-to-k/cdkd/issues/3236) was REPORTED with, from
 * the only durable record of the outage.
 *
 * The `CredentialsProviderError` name is the third arm because credential
 * resolution carries NEITHER signal — identity is resolved by
 * `httpAuthSchemeMiddleware` at step `serialize`, which WRAPS retry's
 * `finalizeRequest`, so an escaping credential error never enters retry's catch
 * (measured, and the mechanism is why: retry CREATES `$metadata` when absent,
 * so an error arriving without one proves it bypassed retry). It is also the
 * shape whose message carries the most: `@aws-sdk/credential-provider-process`
 * wraps EVERY exec failure in it, so the text interpolates the helper's ARGV
 * and its stderr.
 *
 * **Its siblings are deliberately NOT matched, and the reasons differ per class
 * rather than being one rule.** `@smithy/property-provider` exports a family of
 * three — `ProviderError`, and its subclasses `CredentialsProviderError` and
 * `TokenProviderError` — plus `@smithy/credential-provider-imds`'s
 * `InstanceMetadataV1FallbackError`, the only subclass OF
 * `CredentialsProviderError` in the installed tree. (All four set `name`; an
 * earlier revision read "the only subclass that overrides `name`", which is
 * false of the three siblings.) Each was read rather than reasoned about,
 * because the answers go BOTH ways:
 *
 *  - `TokenProviderError` must NOT be reduced. Its message IS the remedy —
 *    `Token is expired. To refresh this SSO session run 'aws sso login' with
 *    the corresponding profile.` — so reducing it to a wire name would delete
 *    the fix instruction. A revision matching the whole `*ProviderError` suffix
 *    did exactly that. The benefit is not realized on the Cloud Control poll
 *    path today, and claiming otherwise was measured false:
 *    `@aws-sdk/credential-provider-sso` catches every token failure and
 *    rethrows it as a `CredentialsProviderError`, so the shape cannot escape a
 *    SigV4 client there. The carve-out is a rule about the FAMILY, kept because
 *    the rewrap is upstream behaviour that can change.
 *  - `ProviderError` (the base) and `InstanceMetadataV1FallbackError` carry
 *    connectivity and CONFIG wording respectively — the IMDS one interpolates
 *    three fixed literals naming config keys, with no argv, stderr, profile
 *    value or identity in it. Both are more useful raw.
 *
 * So string EQUALITY is right here, and right by enumeration rather than by
 * assumption. Re-check the list when the SDK major moves; do not widen it to a
 * suffix. The specific mechanism to re-check is `ProviderError.from()`, which
 * does `Object.assign(new this(...), error)` — that copies a SOURCE error's own
 * `name` over the class field and would defeat string equality outright. It has
 * ZERO call sites anywhere in `node_modules` today, which is the only reason
 * equality is safe rather than merely correct-looking.
 *
 * `$response` is gone with the `$metadata` disjunct, and the reason is NOT the
 * obvious one -- an earlier revision of this comment said it "is only ever set
 * on a `ServiceException`, which carries `$fault` anyway", and review measured
 * that false. `@smithy/core`'s `deserializerMiddleware` stamps `$response` on
 * ANY error escaping the deserializer, and the very next line reads
 * `if (!("$metadata" in error))`, i.e. the library explicitly handles the
 * `$response`-without-`$metadata` shape (a `JSON.parse` `SyntaxError` out of
 * `parseJsonBody`). What actually preserves the verdict is the SIBLING line in
 * that same catch: `error.$metadata = { httpStatusCode: response.statusCode,
 * ... }`, so the `httpStatusCode` disjunct subsumes `$response` for every
 * response the middleware can read. The residual is a `response` failing
 * `HttpResponse.isInstance`, or a throw inside that block's own
 * `catch (ignored)` -- shapes with no HTTP status at all, which are not service
 * rejections and should not be reduced.
 *
 * A transport-level failure (a socket timeout, a DNS error) reaches a caller
 * with neither signal, and that is the correct answer rather than a gap: those
 * messages are written by the HTTP layer and name a host, never a caller.
 */
export function isAwsAuthoredFailure(error: Error): boolean {
  const candidate = error as {
    $metadata?: { httpStatusCode?: unknown };
    $fault?: unknown;
  };
  return (
    candidate.$fault !== undefined ||
    typeof candidate.$metadata?.httpStatusCode === 'number' ||
    error.name === 'CredentialsProviderError'
  );
}

/**
 * Exactly what `String(value)` produces, without the throw.
 *
 * `String(value)` is the only spelling that carries an `Error`'s NAME as well
 * as its message (`"AccessDenied: User ... is not authorized"`), and several
 * call sites depend on that: four build a persisted `outcome: 'partial'`
 * reason where the wire code is the discriminator an operator reads first.
 * {@link describeAwsFailure}'s `detail` is the MESSAGE only, so it is NOT a
 * drop-in for the bare form -- substituting it silently deletes the code.
 * Measured, after a sweep did exactly that at nine sites.
 *
 * So this is the 1:1 replacement: same output for every value `String` can
 * convert, and a stable sentence for the ones it cannot. A null-prototype
 * object throws `TypeError: Cannot convert object to primitive value`, and an
 * object with a hostile or `null` `toString` throws whatever it likes -- inside
 * a catch, that replaces the failure being reported.
 *
 * Use `describeAwsFailure(x).detail` where the site previously read
 * `x instanceof Error ? x.message : String(x)`; use THIS where it read a bare
 * `String(x)`.
 *
 * NOT a substitute for `displaySafe` in `display-safe.ts`, which guards the
 * same coercion and answers differently on purpose -- it falls back to
 * `Object.prototype.toString` and, more importantly, SANITISES the result for a
 * terminal. Anything about to be rendered or logged goes through that one; this
 * one is for the text a catch is about to record.
 */
export function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'a value that could not be converted to text';
  }
}

/**
 * Describe a caught failure for a thrown message. See {@link AwsFailureText}.
 */
export function describeAwsFailure(error: unknown): AwsFailureText {
  if (error instanceof Error) {
    if (!isAwsAuthoredFailure(error)) {
      // cdkd (or Node) wrote this text, so there is nothing to withhold — and
      // reducing it would delete the refusal's remedy along with it.
      return { summary: error.message, detail: error.message, redacted: false };
    }
    // `name` is the wire error code for an AWS SDK error (`AccessDenied`,
    // `ThrottlingException`, ...) and is the discriminator an operator needs
    // most; it is a short token rather than a sentence, so it carries no caller
    // identity. Fall back to `Error` for the shapes that null it out, so the
    // summary is never an empty clause.
    return {
      summary: redactedAwsFailureSummary(error),
      detail: error.message,
      redacted: true,
    };
  }

  // A non-`Error` throw. `String(value)` is the whole payload and there is no
  // class to fall back to, so the value itself is withheld: it is the shape
  // with the fewest guarantees about what is inside it, not the most. Nothing
  // is lost — the caller still routes `detail` to `debug`.
  //
  // And `String(value)` is exactly where the fewest guarantees bite: a
  // null-prototype object throws `TypeError: Cannot convert object to
  // primitive value`, and an object with a throwing `toString` throws whatever
  // it likes. Every caller is INSIDE a catch — `abandonWait` builds the error
  // that carries #3236's `RequestToken` — so an exception here would replace
  // the failure this function exists to describe, which is precisely the defect
  // that issue is about. Same rule, and the same guard shape, as
  // `retryClassificationText`: a helper on a failure path must not out-throw
  // the failure it is describing.
  let detail: string;
  try {
    detail = String(error);
  } catch {
    detail = 'a value that could not be converted to text';
  }
  return {
    summary: withVerbosePointer(`a non-Error value of type ${typeof error}`),
    detail,
    redacted: true,
  };
}

/**
 * Describe an AWS STATUS REASON — text a SUCCESSFUL Describe reports about the
 * resource (EMR `Status.StateChangeReason`, FSx `FailureDetails`) — for a
 * thrown message (issue [#2319](https://github.com/go-to-k/cdkd/issues/2319)).
 *
 * It is not a caught error, so {@link describeAwsFailure} never sees it, yet it
 * reaches the same persisted sink when a provider throws it: AWS words an EMR
 * validation reason with IAM role ARNs, so it names the account. `summary` is
 * the reason's machine `code` (when the service reports one) plus
 * {@link VERBOSE_POINTER}; `detail` is AWS's text, for the `debug` log and for
 * a `cause` the retry classifiers can read. An absent or empty `message` has
 * nothing to withhold: both halves are `fallback`, unredacted.
 */
export function describeAwsStatusReason(
  reason: { code?: string | undefined; message?: string | undefined } | undefined,
  fallback: string
): AwsFailureText {
  const message = reason?.message;
  if (message === undefined || message === '') {
    return { summary: fallback, detail: fallback, redacted: false };
  }
  const code = reason?.code;
  return {
    summary: code
      ? withVerbosePointer(code)
      : verbosePointerSentence().trimEnd() || "AWS's reason is in the debug output.",
    detail: message,
    redacted: true,
  };
}

/**
 * Everything an SDK failure carries, for ONE `logger.debug` line
 * (go-to-k/cdkd#6162).
 *
 * {@link describeAwsFailure}'s `detail` is the error's `message`, and for a
 * response whose body S3 left EMPTY the SDK fills that with the placeholder
 * `UnknownError` (name `Unknown`). AWS Emulator answers an oversized
 * `PutObject` that way (`413`, `content-length: 0`), so a `--verbose` run
 * still showed nothing but the placeholder. This line names the HTTP status,
 * the request ids, the wire `Code`, the fault side and the `cause` chain, and
 * says plainly when AWS sent no message at all, or when no response arrived.
 *
 * Debug-only: it holds AWS's text unredacted, like `detail`. Never throws.
 */
export function describeAwsErrorDiagnostics(error: unknown): string {
  try {
    return awsErrorDiagnostics(error);
  } catch {
    return 'the failure could not be inspected';
  }
}

/** The SDK's own text for a failure whose response carried no error body. */
const SDK_PLACEHOLDER_MESSAGES = new Set(['', 'UnknownError', 'Unknown']);

function awsErrorDiagnostics(error: unknown): string {
  if (!(error instanceof Error)) {
    return `a non-Error value of type ${typeof error}: ${safeStringify(error)}`;
  }
  const e = error as Error & {
    Code?: unknown;
    code?: unknown;
    $fault?: unknown;
    $metadata?: {
      httpStatusCode?: unknown;
      requestId?: unknown;
      extendedRequestId?: unknown;
      cfId?: unknown;
      attempts?: unknown;
    };
    $response?: { statusCode?: unknown; headers?: Record<string, unknown> };
  };
  const parts: string[] = [];
  const status = e.$metadata?.httpStatusCode ?? e.$response?.statusCode;
  const responded = typeof status === 'number';
  if (responded) parts.push(`HTTP ${status}`);
  parts.push(`name ${safeStringify(e.name)}`);
  if (e.Code !== undefined && e.Code !== e.name) parts.push(`Code ${safeStringify(e.Code)}`);
  if (e.code !== undefined) parts.push(`code ${safeStringify(e.code)}`);
  const message = typeof e.message === 'string' ? e.message : safeStringify(e.message);
  parts.push(`message ${JSON.stringify(message)}`);
  if (e.$fault !== undefined) parts.push(`fault ${safeStringify(e.$fault)}`);
  const meta = e.$metadata;
  if (meta?.requestId !== undefined) parts.push(`request id ${safeStringify(meta.requestId)}`);
  if (meta?.extendedRequestId !== undefined) {
    parts.push(`extended request id ${safeStringify(meta.extendedRequestId)}`);
  }
  if (meta?.cfId !== undefined) parts.push(`cf id ${safeStringify(meta.cfId)}`);
  if (meta?.attempts !== undefined) parts.push(`attempts ${safeStringify(meta.attempts)}`);
  const length = e.$response?.headers?.['content-length'];
  if (length !== undefined) parts.push(`response content-length ${safeStringify(length)}`);

  // The `cause` chain, bounded: a socket error (`EPIPE`, `ECONNRESET`) rides
  // here when the SDK wraps it.
  let cause: unknown = (e as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth++) {
    if (cause instanceof Error) {
      const c = cause as Error & { code?: unknown };
      parts.push(
        `cause ${safeStringify(c.name)}${c.code !== undefined ? ` (${safeStringify(c.code)})` : ''}: ` +
          JSON.stringify(c.message)
      );
      cause = (c as { cause?: unknown }).cause;
    } else {
      parts.push(`cause ${safeStringify(cause)}`);
      break;
    }
  }

  let verdict = '';
  if (!responded && e.$fault === undefined) {
    verdict = ' No AWS response was received: the request failed before AWS answered.';
  } else if (SDK_PLACEHOLDER_MESSAGES.has(message) && e.Code === undefined) {
    verdict =
      ' AWS returned no error message' +
      (length === '0' || length === 0 ? ' (the response body was empty).' : '.');
  }
  return `${parts.join(', ')}.${verdict}`;
}
