/**
 * The masking {@link RetryLogger} every `withRetry` caller that holds a
 * RESOLVED secret bag threads (issues
 * [#1914](https://github.com/go-to-k/cdkd/issues/1914) /
 * [#2018](https://github.com/go-to-k/cdkd/issues/2018) /
 * [#2038](https://github.com/go-to-k/cdkd/issues/2038)).
 *
 * `retry.ts` interpolates the AWS message VERBATIM into both the per-attempt
 * `debug` line and the give-up `warn` summary, and an AWS validation error
 * routinely quotes the offending property VALUE back (`Value 'hunter2' at
 * 'password' failed to satisfy constraint ...`). Wherever the payload handed to
 * the retried call was resolved from a `{{resolve:...}}` dynamic reference, that
 * value provably IS the secret — so the retry logger has to mask the
 * CONCATENATED string rather than forward it.
 *
 * `warn` matters more than `debug`, which is why {@link RetryLogger.warn} is
 * optional in the first place: the give-up summary prints at DEFAULT verbosity,
 * so forwarding it unmasked would defeat the #1914 fence at a HIGHER log level
 * than the one that fence was written for. A required `warn` would have been
 * silently satisfied by a raw `logger.warn`.
 *
 * **Why this module and not `secret-redaction.ts`.** That file is a documented
 * no-import LEAF (see its header) and this helper needs `RetryLogger`, which
 * lives in `retry.ts`. Homing it there would give the leaf an import edge; a
 * new module keeps both invariants and gives the three eager callers —
 * `rollback-executor.ts`, `src/cli/commands/drift.ts` and the deploy engine's
 * two `--replace` sites — ONE definition instead of three byte-identical
 * copies. The deploy engine additionally keeps a LAZY variant of its own
 * (`DeployEngine.maskingRetryLogger`), which resolves the bag per line from
 * `perResourceSecrets` because its generic `withRetry` wrapper is reached from
 * call sites that have no bag in scope; that one is a different shape, not a
 * fourth copy.
 */

import type { RetryLogger } from './retry.js';
import { maskSecretsInText, type RecordedSecretValues } from './secret-redaction.js';

/**
 * The minimum a caller's logger must provide. Structural rather than the
 * concrete `Logger` class so a `RollbackExecutorContext['logger']`, a
 * `ChildLogger` and a test double all satisfy it without importing
 * `src/utils/logger.ts` here.
 */
export interface MaskableRetryLogSink {
  debug(message: string): void;
  warn(message: string): void;
}

/**
 * Bind `logger` to `secrets`, masking every line the retry loop emits.
 *
 * No-op when the caller resolved no secret ({@link maskSecretsInText} returns
 * the text unchanged for an empty bag), so a non-secret resource's output is
 * byte-identical to threading the raw logger.
 */
export function maskingRetryLogger(
  logger: MaskableRetryLogSink,
  secrets: RecordedSecretValues
): RetryLogger {
  return {
    debug: (msg) => logger.debug(maskSecretsInText(msg, secrets)),
    warn: (msg) => logger.warn(maskSecretsInText(msg, secrets)),
  };
}
