import { describeAwsFailureForWarn, describeCredentialLoadFailure } from 'cdk-local/internal';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getLogger } from '../../utils/logger.js';

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
 * The one part that does not carry over is WHERE the withheld text goes.
 * cdk-local writes it to its OWN logger (go-to-k/cdkd#2429), whose level
 * cdkd's `--verbose` never raises, so the rendered line's "logged at debug
 * level under --verbose" would be false. This emits that line through cdkd's
 * logger instead. The withheld branch is recognised by equality with
 * `describeCredentialLoadFailure` -- exactly what cdk-local returns there --
 * rather than by matching its wording.
 *
 * A `CdkdError` is the one exception to the withhold: cdkd wrote that text
 * (`AssumeRole(<arn>) returned no usable credentials.`), so it is the
 * diagnosis rather than wire data, and is printed as-is.
 *
 * The result is passed through `displaySafe` as well, so a call site may place
 * it beside a sanitized identifier without depending on cdk-local's flattening.
 */
export function describeLocalAwsFailureForWarn(err: unknown, operation: string): string {
  if (err instanceof CdkdError) return displaySafe(err.message);
  const rendered = describeAwsFailureForWarn(err, operation);
  if (rendered === describeCredentialLoadFailure(err)) {
    getLogger().debug(
      safeMsg`${operation}: the AWS SDK's own failure message was: ${thrownText(err)}`
    );
  }
  return displaySafe(rendered);
}

/** `err.message` for an `Error`, `String(err)` otherwise -- without the throw. */
function thrownText(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return '[unstringifiable throw]';
  }
}
