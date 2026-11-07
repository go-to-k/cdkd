import { redactDockerArgvInText } from './argv-in-text.js';

/**
 * The composers every docker failure text and `cause` goes through. Part of
 * the `docker-cmd.ts` split (go-to-k/cdkd#5835); import from
 * `../docker-cmd.js`, not from here.
 */

/**
 * Compose a user-visible description of a `child_process` rejection from a
 * docker call, ALREADY REDACTED against that call's own argv.
 *
 * Moved here from `src/local/invoke-agentcore-watch-loop.ts` in issue #2440's
 * review round 3, and the move is the point: `args` is REQUIRED, so a call
 * site cannot obtain the text without handing over the argv to redact it
 * with. That is a stronger guarantee than any text fence over the call sites
 * — which is what the round-2 reviewers demonstrated, by writing four
 * spellings of an unredacted read that the fence could not see.
 *
 * Shape differs from the `stderr || message` composition the other sites use,
 * and deliberately so: `err.stderr` is where docker writes its actionable
 * diagnostics, while `err.message` carries the exit status, so the AgentCore
 * soft-reload path APPENDS rather than prefers — without stderr the wrapped
 * error would only say "Command failed with exit code N".
 */
export function describeDockerExecFailure(error: unknown, args: readonly string[]): string {
  // Redacted on EVERY branch. Returning `String(error)` raw was a fail-open
  // the extraction introduced: the code this replaced wrapped the whole call,
  // so a non-`Error` rejection used to be redacted and briefly stopped being.
  const message = thrownMessageText(error) || safeStringify(error);
  const stderrText = capturedStreamText(error, 'stderr');
  return redactDockerArgvInText(stderrText ? `${message}\n${stderrText}` : message, args);
}

/**
 * A captured stream of a `child_process` rejection as trimmed text, or `''`.
 *
 * Takes `unknown`, not `Error`, and duck-types the field. Every composer here
 * is called from a `catch`, where the value is whatever was thrown — and the
 * shapes the call sites actually see are plain objects
 * (`{ stderr, message }`), `SpawnError`, and cross-realm `Error`s that
 * `instanceof` misses. An earlier revision narrowed this to `Error` and the
 * standard composer then wrapped non-Errors in a FRESH `Error`, which has no
 * `.stderr` at all — so the whole diagnostic silently became
 * `'[object Object]'` for exactly the shape most of the call sites throw.
 *
 * `execFile` hands back a string under the default encoding and a `Buffer`
 * under `encoding: 'buffer'`; `ArrayBuffer.isView` covers a plain
 * `Uint8Array` too.
 */
function capturedStreamText(error: unknown, field: 'stderr' | 'stdout'): string {
  // The WHOLE body is guarded, not just a stringify. A property READ throws
  // for a Proxy with a throwing `get` or a throwing getter, and `Buffer.from`
  // throws on a DETACHED ArrayBuffer — each would escape a `catch`, and two
  // call sites are in `cleanupEcsRun`, where that aborts the remaining volume
  // / network teardown and leaks real Docker resources. An earlier revision
  // wrapped only `String()` while its own doc claimed the guarantee this now
  // actually provides.
  try {
    const raw = (error as Record<string, unknown> | null | undefined)?.[field];
    if (typeof raw === 'string') return raw.trim();
    if (ArrayBuffer.isView(raw)) {
      return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8').trim();
    }
  } catch {
    /* a diagnostic is never worth aborting cleanup for */
  }
  return '';
}

/** A thrown value's `message` as text, or `''`. Duck-typed, for the same reason. */
function thrownMessageText(error: unknown): string {
  try {
    const raw = (error as Record<string, unknown> | null | undefined)?.['message'];
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * `String(value)` that cannot itself throw. A rejection with a null prototype
 * (or a `toString` that throws) would otherwise blow up INSIDE a `catch` — and
 * two of these call sites are in `cleanupEcsRun`, where an exception aborts
 * the remaining volume / network teardown and leaks real Docker resources.
 */
function safeStringify(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '[unstringifiable rejection]';
  }
}

/**
 * The STANDARD composer for a docker failure text: the captured stderr if
 * there is any, else the error's own message, else its string form —
 * ALREADY REDACTED against that call's argv.
 *
 * Use this at every site that wraps a docker `execFile` / spawn rejection.
 * `args` is REQUIRED, which is the whole point: a call site cannot obtain the
 * text without handing over the argv to redact it with, so the guarantee is
 * type-checked rather than fenced. Issue #2440's review spent three rounds
 * showing that a text fence over hand-composed sites is evadable — an
 * intermediate variable, an inline cast, a destructure, a computed member, a
 * concat — while this shape has nothing to evade.
 *
 * Prefer stderr over message because docker writes its actionable diagnostic
 * there, and `execFile`'s message is mostly the command line plus an exit
 * status. {@link describeDockerExecFailure} keeps BOTH, for a caller whose
 * wrapper text needs the status as well.
 */
export function describeDockerFailure(error: unknown, args: readonly string[]): string {
  return redactDockerArgvInText(
    capturedStreamText(error, 'stderr') || thrownMessageText(error) || safeStringify(error),
    args
  );
}

/**
 * A `cause` that is safe to CHAIN onto a wrapper error, for a caller that
 * wants the retry classifiers to see the failure as an object rather than as
 * an interpolated string (issue go-to-k/cdkd#2075).
 *
 * Attaching the raw `execFile` error reopens the channel go-to-k/cdkd#2440
 * closed. The mandate above applies to every docker failure text this module
 * hands out, "including one whose argv carries no user data today" — and a
 * chained cause IS such a text: `formatError` prints `cause.message`, and the
 * CLI's top-level handler walks the whole chain. The raw message is the
 * command line, so the moment an argv gains a `-e` or a `--build-arg` the
 * secret is in a printed line again, from a call site nobody re-reads.
 *
 * So the returned cause carries the REDACTED description as its message, and
 * chains nothing further. What the classifiers read is copied across — but
 * through an ALLOWLIST ({@link CLASSIFICATION_FIELDS}), never by sweeping the
 * original's own keys.
 *
 * The allowlist is the whole point, and a denylist was the first cut: it
 * skipped `message` / `stack` / `cause` and copied the rest, which carried
 * `err.cmd` — the full command line — onto the new error verbatim. That is
 * the SAME field that defeated four rounds of the go-to-k/cdkd#2440 fence
 * (`.claude/rules/docker-argv-redaction.md`), reintroduced inside the function
 * written to close it. `stderr` / `stdout` are excluded for the same reason:
 * the composer above has already read and REDACTED them into the message, so
 * copying the raw streams would hand back exactly what it removed.
 *
 * Fail-closed is the correct direction here for the reason the cache-param
 * allowlist gives: a field missing from the allowlist costs one degraded retry
 * classification, while a field missing from a denylist costs a printed
 * credential.
 */
/**
 * The fields {@link redactedDockerCause} carries from the original error onto
 * the redacted one.
 *
 * WHAT EACH HALF IS FOR, stated precisely because an earlier revision of this
 * comment got it wrong in a way that reads as more than it is. The AWS-shaped
 * entries (`$metadata`, `$fault`, `__type`, `code`, `statusCode`) are what
 * `isThrottlingError` / `isTransientServerError` /
 * `describeRetryClassificationSignals` actually consult, and they are reachable
 * here only when an SDK error is the cause -- the ECR-login path, whose
 * `GetAuthorizationToken` failure can be one.
 *
 * `exitCode` is NOT read by any classifier. It is carried because it is the
 * ONLY field the DOMINANT failure has: these four sites reject through
 * `spawnStreaming`, whose `SpawnError` sets `stderr` / `stdout` / `exitCode`
 * and nothing else, so without it a non-zero docker exit produced a cause with
 * a name and a message and no other content at all. What that buys is the
 * DIAGNOSTIC -- `cli/index.ts` renders the chain's own enumerable props -- not
 * a retry decision. Do not restate it as a classification field.
 *
 * `stderr` / `stdout` stay OFF: the composer has already read and REDACTED
 * them into the message, so copying the raw streams would hand back exactly
 * what it removed.
 */
const CLASSIFICATION_FIELDS = [
  'exitCode',
  'code',
  'errno',
  'signal',
  'status',
  'statusCode',
  '$metadata',
  '$fault',
  '$retryable',
  '__type',
] as const;

export function redactedDockerCause(error: unknown, args: readonly string[]): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  return redactedCause(error, describeDockerFailure(error, args));
}

/**
 * The field-carrying half of {@link redactedDockerCause}, for any caller that
 * has already rendered a SAFE message for `error`: a new `Error` with that
 * message, the original's name, the {@link CLASSIFICATION_FIELDS} and the
 * non-retryable marker. `redactedAwsCause` (go-to-k/cdkd#4857) is the other
 * caller.
 */
export function redactedCause(error: Error, message: string): Error {
  const cause = new Error(message);
  // Every read below is guarded, for the reason `capturedStreamText` and
  // `safeStringify` in this file are: this helper runs ONLY inside a `catch`,
  // so a throwing getter or a Proxy on the caught value would escape that
  // catch and replace a docker diagnostic with an unrelated crash.
  try {
    cause.name = error.name;
  } catch {
    /* leave the default 'Error' */
  }
  // The non-retryable MARKER, which no string allowlist can reach: it is a
  // symbol property, so copying the named fields silently drops it and an
  // error someone marked non-retryable would be retried. `Symbol.for` puts it
  // in the global registry, so this file can name it without importing from
  // `src/deployment/**` and inverting the layering. Nothing on the docker path
  // marks one TODAY -- it is carried so that adding a `markNonRetryable` there
  // later does not need anyone to remember this function exists.
  const NON_RETRYABLE_MARKER = Symbol.for('cdkd.nonRetryable');
  try {
    if ((error as unknown as Record<symbol, unknown>)[NON_RETRYABLE_MARKER] === true) {
      Object.defineProperty(cause, NON_RETRYABLE_MARKER, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    /* a marker that cannot be read is simply not carried */
  }

  const source = error as unknown as Record<string, unknown>;
  const target = cause as unknown as Record<string, unknown>;
  for (const key of CLASSIFICATION_FIELDS) {
    try {
      if (key in source) target[key] = source[key];
    } catch {
      /* a field that cannot be read is simply not carried */
    }
  }
  return cause;
}

/**
 * Composer for a captured-output failure where the diagnostic may be on
 * STDOUT rather than stderr (`runDockerStreaming`'s non-zero-exit path, whose
 * `SpawnError` carries both). `fallback` is used when neither stream said
 * anything. Redacted, and `args` is required, for the same reason as
 * {@link describeDockerFailure}.
 */
export function describeDockerCapturedOutput(
  error: unknown,
  args: readonly string[],
  fallback: string
): string {
  return redactDockerArgvInText(
    capturedStreamText(error, 'stderr') || capturedStreamText(error, 'stdout') || fallback,
    args
  );
}
