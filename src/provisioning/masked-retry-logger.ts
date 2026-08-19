/**
 * Bind a caller's secret masker into the two sinks a provider hands to
 * `withRetry` (issue #2050).
 *
 * WHY THIS EXISTS. `withRetry` interpolates the AWS error message VERBATIM
 * into its per-attempt `debug` line and into the give-up `warn` summary added
 * for issue #2018 — and that summary prints at DEFAULT verbosity. A provider
 * retrying a command whose payload came out of the `properties` bag is
 * therefore a plaintext-secret sink on an exhausted retry: by the time a
 * provider is called, a `{{resolve:secretsmanager:...}}` scalar is already
 * PLAINTEXT, and AWS routinely quotes the offending value back in a validation
 * message.
 *
 * WHY A SHARED MODULE RATHER THAN ONE PRIVATE METHOD PER PROVIDER. The first
 * cut of issue #2050 hand-rolled a byte-identical private method in each of
 * `elbv2-provider.ts` and `servicediscovery-provider.ts`, on the argument that
 * "one factory each keeps that file's call sites from drifting apart". That
 * argument is only half of the problem and review said so: one factory PER FILE
 * is exactly the thing that lets the two FILES drift, which is the drift that
 * matters here — the two copies encode a security contract, and a fix or a
 * hardening applied to one silently leaves the other behind. A third
 * hand-rolled copy already exists at `src/cli/commands/drift.ts` (issue #1914),
 * which is the same shape reached independently, so the pattern was already
 * proven to recur before this module existed.
 *
 * A LEAF MODULE ON PURPOSE. It imports one TYPE and nothing else, so it adds no
 * edge to the dependency graph and can be imported from anywhere in
 * `src/provisioning/**` without a cycle. It deliberately does NOT import
 * `src/deployment/secret-redaction.ts`: providers receive the masking
 * CAPABILITY, never the secrets BAG — see `SecretMaskingContext` in
 * `src/types/resource.ts` for why that asymmetry is load-bearing.
 */

import type { RetryLogger } from '../deployment/retry.js';

/**
 * The provider-facing masker shape.
 *
 * Structurally identical to `SecretMasker` in `src/types/resource.ts` (which
 * re-exports it from the deployment layer) and assignable both ways. Spelled
 * locally so this module keeps its single-import leaf property; the providers
 * that call in here import the contract's own `SecretMasker` and pass it
 * straight through.
 */
export type MaskerFn = (text: string) => string;

/**
 * The masker a caller supplied, or the identity function when it supplied
 * none.
 *
 * ABSENT MEANS UNMASKED, and that is the back-compatible default the contract
 * mandates — `create()` / `update()` are also reached from the import path,
 * from `cdkd drift --revert`, and from tests, and a provider must not care
 * which caller it got. Centralised here so no call site re-spells the `??`
 * and accidentally makes the capability required.
 */
export function maskerOrIdentity(maskSecrets: MaskerFn | undefined): MaskerFn {
  return maskSecrets ?? ((text: string) => text);
}

/**
 * A {@link RetryLogger} whose every line is routed through `maskSecrets`.
 *
 * `warn` is ALWAYS provided, never omitted. It is optional on `RetryLogger`,
 * and dropping it would silence the give-up summary on the calling path only —
 * trading a disclosure for the reporting hole issue #2018 closed. It goes
 * through the SAME mask as `debug` precisely because it is the line that
 * survives a run without `--verbose`; forwarding it unmasked would defeat the
 * fence at a HIGHER log level than the one the fence was written for.
 *
 * `logger` is typed structurally rather than as the concrete `Logger` so this
 * module stays a leaf and a test can pass two spies. That matches the
 * precedent already in the tree (`buildMfaConfigRequest` in
 * `cognito-provider.ts` takes an injected `logger?: { warn }`).
 */
export function createMaskedRetryLogger(
  logger: { debug(message: string): void; warn(message: string): void },
  maskSecrets: MaskerFn | undefined
): RetryLogger {
  const mask = maskerOrIdentity(maskSecrets);
  return {
    debug: (message: string) => logger.debug(mask(message)),
    warn: (message: string) => logger.warn(mask(message)),
  };
}
