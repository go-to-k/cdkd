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
 * whole statement of it: the smithy marker fields (`$metadata` / `$fault` /
 * `$response`), which every AWS SDK v3 error carries and nothing in cdkd sets.
 * `extractDeploymentEventError` already keys its own AWS-shaped test on
 * `$metadata`, so this is the repo's existing predicate rather than a new one.
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
 *    `dynamodb-delete-budget.ts`'s `isTerminalDeleteFailure`,
 *    `apigateway-provider.ts`'s `isIamPropagationError` (top-level message,
 *    matches `not authorized` -- exactly the substring this helper withholds),
 *    `ec2-provider.ts`'s `isDependencyViolationError`, and
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
   * The failure's own text, in full. `logger.debug` ONLY — never a thrown
   * message, never a default-level line.
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

/** Appended to a redacted summary so the withheld half is still reachable. */
const VERBOSE_POINTER = "Re-run with --verbose for AWS's own message.";

/**
 * Whether AWS wrote this failure's message.
 *
 * Keyed on the marker fields `@aws-sdk/*` errors carry through
 * `@smithy/smithy-client`'s `ServiceException` — `$metadata` on every
 * deserialized error, `$fault` on every modeled one, `$response` where a
 * middleware attached the raw response. Nothing under `src/` sets any of them,
 * so a match cannot be a cdkd-authored error.
 *
 * A transport-level failure (a socket timeout, a DNS error) can reach a caller
 * without `$metadata`, and that is the correct answer rather than a gap: those
 * messages are written by the HTTP layer and name a host, never a caller.
 */
function isAwsAuthoredFailure(error: Error): boolean {
  const candidate = error as {
    $metadata?: unknown;
    $fault?: unknown;
    $response?: unknown;
  };
  return (
    candidate.$metadata !== undefined ||
    candidate.$fault !== undefined ||
    candidate.$response !== undefined
  );
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
      summary: `${error.name || 'Error'}. ${VERBOSE_POINTER}`,
      detail: error.message,
      redacted: true,
    };
  }

  // A non-`Error` throw. `String(value)` is the whole payload and there is no
  // class to fall back to, so the value itself is withheld: it is the shape
  // with the fewest guarantees about what is inside it, not the most. Nothing
  // is lost — the caller still routes `detail` to `debug`.
  return {
    summary: `a non-Error value of type ${typeof error}. ${VERBOSE_POINTER}`,
    detail: String(error),
    redacted: true,
  };
}
