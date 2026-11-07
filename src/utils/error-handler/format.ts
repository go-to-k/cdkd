import { displayAwsMessage } from '../display-safe.js';
import { getLogger } from '../logger.js';
import { safeStringify } from '../aws-failure-text.js';
import { CdkdError, isSoftAbort } from './base-errors.js';

/**
 * Check if error is a cdkd error
 */
export function isCdkdError(error: unknown): error is CdkdError {
  return error instanceof CdkdError;
}

/**
 * Format error for display
 */
export function formatError(error: unknown): string {
  if (isCdkdError(error)) {
    let message = `${error.name}: ${error.message}`;
    if (error.cause) {
      // Sanitized HERE, at the one place every cause is printed, rather than at
      // each thrower (issue #3003). A cause is routinely an underlying
      // `SyntaxError` from `JSON.parse`, and V8 quotes the offending INPUT in
      // that message — so a `state.json` or `lock.json` anyone with
      // `s3:PutObject` on the state bucket can write reaches the terminal
      // through this line. cdkd's output is line-oriented, so an injected
      // newline invents a line that reads like a row -- and it did so one line
      // BELOW a message the thrower had already sanitized.
      //
      // The DENYLIST class, not `asciiOnly`: a cause is free-form text from an
      // arbitrary error (AWS's own wording included), and the ascii allowlist
      // is for values with a known charset — `display-safe.ts`'s header draws
      // that line.
      //
      // FLATTENED, and the cost is accepted deliberately. Some causes are
      // multi-line on purpose — `CloudControlProvider`'s unsupported-type
      // diagnostic is three lines, re-wrapped as a `cause` by the deploy
      // engine — and they now print as one long line. No character is lost,
      // only the shape.
      //
      // The obvious repair is to split on `\n`, sanitize each line and rejoin.
      // It was considered and REFUSED: it cannot tell cdkd's own newline from
      // an injected one, so it preserves exactly the newline this guard exists
      // to remove and reopens the row forging. A structure-preserving version
      // would need the thrower to say which newlines are its own, which is a
      // wider change than this line.
      //
      // A cause that sanitizes to NOTHING drops its whole line rather than
      // printing a placeholder. It carried no readable information, and
      // `Caused by:` with an empty tail reads as a formatting bug, and so
      // would `Caused by: <unrenderable>` -- the `UNRENDERABLE` stand-in is
      // for a FIELD whose slot would otherwise read as absent, and a dropped
      // cause line is not a slot.
      // `displayAwsMessage`, not bare `displaySafe`: this line is where a cap
      // paid one line up is DEFEATED BY ITS OWN NEIGHBOUR
      // ([#3479](https://github.com/go-to-k/cdkd/issues/3479)). A thrower that
      // renders AWS's text through `displayAwsMessage` and then passes the SAME
      // error as `cause` printed `[cut: N more characters withheld]` on one
      // line and the whole untruncated text on the next, because this render
      // sanitized but did not bound. That is exactly the failure
      // `AWS_MESSAGE_MAX_CODE_POINTS`' own doc describes, one indirection away
      // from where it was guarded.
      //
      // MASKING IS UNAFFECTED, and the ORDER is why rather than the arithmetic:
      // `maskSecretsInError` rewrites the error OBJECT at the throw site, so the
      // `message` read here is already masked; `formatError` has exactly one
      // caller IN `src/` (`handleError` below) and `ConsoleLogger` masks nothing
      // after it. `src/index.ts` re-exports this function as package API, so
      // "one caller" is not an invariant the code enforces — it does not weaken
      // the order argument, since an external consumer is not a masker inside
      // cdkd's pipeline, but the narrower claim is the true one.
      // Truncation therefore only ever removes already-masked text — it cannot
      // split a plaintext secret, because none is left to split. Cutting the
      // MASK MARKER itself is harmless for the same reason. A masker running at
      // or after this point would invert that argument, which is why the
      // pipeline is named here and pinned in
      // `tests/unit/deployment/secret-redaction-error-masking.test.ts`.
      const cause = displayAwsMessage(error.cause.message);
      if (cause) message += `\nCaused by: ${cause}`;
    }
    return message;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return safeStringify(error);
}

/**
 * Global error handler
 *
 * Default exit code is 1 (general error). `PartialFailureError`
 * overrides it to 2 so callers can distinguish "command crashed /
 * unauthorized / bad arguments" from "command completed but some
 * resources are still in an error state, re-run to clean up".
 *
 * A {@link CdkdError} subclass may set `silent = true` to suppress the
 * default `logger.error` line — used by `cdkd drift` where the command
 * has already printed a richer report and only needs the exit code.
 */
export function handleError(error: unknown): never {
  const logger = getLogger();
  const silent = error instanceof CdkdError && (error as CdkdError & { silent?: boolean }).silent;
  if (isSoftAbort(error)) {
    // go-to-k/cdkd#5136: a declined prompt, as the AWS CDK CLI prints it.
    logger.warn((error as Error).message);
  } else if (!silent) {
    logger.error(formatError(error));
  }

  if (error instanceof Error && error.stack) {
    logger.debug('Stack trace:', error.stack);
  }

  // Honor any CdkdError subclass that declares a custom `exitCode`
  // field (PartialFailureError + ResourceUpdateNotSupportedError +
  // StackHasActiveImportsError + MacroExpansionError
  // etc.). Falling back to 1 covers `CdkdError` subclasses with no
  // override and every non-cdkd error.
  const customExitCode =
    error instanceof CdkdError ? (error as CdkdError & { exitCode?: number }).exitCode : undefined;
  const exitCode = typeof customExitCode === 'number' ? customExitCode : 1;
  process.exit(exitCode);
}

/**
 * Wrap async function with error handling
 *
 * Note: Uses `any[]` for args to support Commander.js action handlers
 * which can have various parameter types
 */
export function withErrorHandling<Args extends unknown[], Return extends Promise<void> | void>(
  fn: (...args: Args) => Return
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      handleError(error);
    }
  };
}
