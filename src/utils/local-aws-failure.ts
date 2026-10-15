import { describeAwsFailureForWarn } from 'cdk-local/internal';
import { displaySafe } from './display-safe.js';
import { CdkdError } from './error-handler.js';
import { redactedCause } from './docker-cmd.js';

/**
 * Render a failed AWS SDK call (STS `GetCallerIdentity` / `AssumeRole`) for a
 * default-level `warn` in the `cdkd local *` commands (issue go-to-k/cdkd#2300).
 *
 * The DECISION is cdk-local's `describeAwsFailureForWarn`, so the two CLIs
 * print one policy: a modeled service exception keeps its message (the
 * diagnosis -- `AccessDenied`'s "is not authorized to perform ..."), flattened
 * to one line and capped; anything else -- a credential-provider failure, a
 * transport error -- is withheld to a clamped class name, an optional clamped
 * `code` and a character count. Withheld because that text is not AWS's to
 * vouch for: `credential_process` copies the failed command line into its
 * error, and an `err.name` read off `x-amzn-errortype` can carry a newline.
 *
 * The withheld text goes to cdk-local's logger at `debug`, which hands it to
 * cdkd's own logger through the embed config `createLocalCommand` installs
 * (go-to-k/cdkd#2429), so the rendered line's "logged at debug level under
 * --verbose" holds under cdkd's `--verbose`.
 *
 * A `CdkdError` is the one exception to the withhold: cdkd wrote that text
 * (`AssumeRole(<arn>) returned no usable credentials.`), so it is the
 * diagnosis rather than wire data, and is printed as-is.
 *
 * The result is passed through `displaySafe` as well, so a call site may place
 * it beside a sanitized identifier without depending on cdk-local's flattening.
 */
export function describeLocalAwsFailureForWarn(err: unknown, operation: string): string {
  if (err instanceof CdkdError) return withoutTrailingPeriod(displaySafe(err.message));
  const rendered = describeAwsFailureForWarn(err, operation);
  return withoutTrailingPeriod(displaySafe(rendered));
}

/**
 * Every call site appends its own `. <next sentence>`, so a rendering that
 * already ends a sentence (a service message, a `CdkdError`'s remedy) would
 * print `..` (go-to-k/cdkd#4857).
 */
function withoutTrailingPeriod(text: string): string {
  return text.endsWith('.') && !text.endsWith('..') ? text.slice(0, -1) : text;
}

/**
 * A cause for a THROWN error whose message already carries the rendering of
 * `err` ({@link describeLocalAwsFailureForWarn}), go-to-k/cdkd#4857. `message`
 * names the failed operation only (`STS AssumeRole failed`): the rendering is
 * on the line above, so repeating it would print it twice.
 *
 * The SDK error must stay the thrower's `cause`, because the transient-error
 * classifiers walk `.cause` (`scripts/check-provider-error-cause.ts`) -- but
 * `formatError` prints a cause's message on its own `Caused by:` line, which
 * would put the withheld text back on the terminal one line below the
 * rendering that withheld it. So the cause is a redacted copy: `message` as
 * its message, the classification fields (`$retryable` included) and the
 * non-retryable marker carried across -- read off the SDK error a `CdkdError`
 * wrapper holds, when `err` is one. Registered in that critic's `CAUSE_COMPOSERS`.
 */
export function redactedAwsCause(err: unknown, message: string): Error | undefined {
  if (!(err instanceof Error)) return undefined;
  // A cdkd wrapper (`verifyBucketExists`'s StateError) carries no
  // classification fields of its own; the SDK error it wraps does -- possibly
  // one link further down, behind `normalizeAwsError`'s rewrite.
  let source: Error = err;
  if (err instanceof CdkdError) {
    for (
      let depth = 0;
      depth < 3 && source.cause instanceof Error && !hasSdkMetadata(source);
      depth++
    ) {
      source = source.cause;
    }
  }
  return redactedCause(source, message);
}

function hasSdkMetadata(error: Error): boolean {
  return (error as { $metadata?: unknown }).$metadata !== undefined;
}
