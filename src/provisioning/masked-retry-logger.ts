/**
 * The shared provider-side secret-masking module.
 *
 * Two capabilities, both built on a masker the DEPLOY ENGINE supplies through
 * `CreateContext` / `UpdateContext`: {@link createMaskedRetryLogger}, which
 * binds it into the two sinks a provider hands to `withRetry` (issue #2050),
 * and {@link maskDeep}, which masks a value's leaves BEFORE it is stringified
 * into a message (issue #2176). Providers reach for the second whenever they
 * interpolate anything derived from the `properties` bag; see its own note for
 * why masking the finished message is not a substitute.
 *
 * ## `createMaskedRetryLogger`
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

/**
 * Depth cap for {@link maskDeep}. Bounds a self-referential bag rather than
 * recursing until the stack blows; `JSON.stringify` would throw on one anyway,
 * and a throw is the better failure of the two.
 *
 * Deliberately generous. Every shape these warnings exist to describe is a
 * scalar, a list of scalars, or a small record, so the walk does not reach
 * depth 2 in practice — the cap is a guard, not a real bound, and no plausible
 * mis-shape should be left unmasked by it.
 */
export const MASK_WALK_MAX_DEPTH = 8;

/**
 * What {@link maskDeep} substitutes for a subtree it declines to descend into.
 *
 * MUST equal `SECRET_MASK` in `src/deployment/secret-redaction.ts`. It is
 * spelled here rather than imported so this module keeps its single-import leaf
 * property (see the module note above); the two are fenced against drift by a
 * test that imports both.
 */
export const MASK_WALK_DEPTH_CAP_MARKER = '***';

/**
 * Mask every string LEAF and KEY of an arbitrary value, returning a structure
 * safe to `JSON.stringify` into a log line or an error message (issue
 * [#2176](https://github.com/go-to-k/cdkd/issues/2176)).
 *
 * THE ORDERING IS THE WHOLE POINT, and it is why masking the finished message
 * is not a substitute. `maskSecretsInText` matches by literal occurrence, so:
 *
 *  1. ESCAPING. `JSON.stringify` escapes `"`, `\` and newlines, so a secret
 *     containing any of them no longer OCCURS in the stringified text and a
 *     mask applied afterwards cannot find it. That is not an exotic case — it
 *     is every Secrets Manager JSON document, the commonest real secret shape.
 *     Measured on the pre-fix tree for #2176: a plaintext of
 *     `{"user":"admin","pw":"hunter2"}` interpolated as
 *     `${JSON.stringify(value)}` came through a message-level mask COMPLETELY
 *     unchanged, while masking the leaves first rendered it `"***"`.
 *  2. LENGTH. A finished message is always longer than the value inside it, so
 *     it can only ever reach `maskSecretsInText`'s SUBSTRING arm, which ignores
 *     needles below `MIN_NEEDLE_LENGTH` (4). Handing the masker each RAW leaf
 *     reaches the WHOLE-VALUE arm, which has no floor. Measured the same way: a
 *     3-character secret survived `Value 'abc' at 'pin' failed ...` intact.
 *
 * Neither pass subsumes the other, so providers do BOTH — this walk on the
 * value, and the assembled message through the masker as well. The masker is
 * idempotent, so the overlap is free.
 *
 * Keys are masked as well as values: `JSON.stringify` renders them into the
 * same line, so a resolved secret used as a map key would otherwise escape.
 *
 * WHY THIS LIVES HERE rather than as a private walk per provider. SIX
 * hand-rolled copies had already accumulated — `elbv2-provider.ts`,
 * `cognito-provider.ts`, `sns-topic-provider.ts`, `dynamodb-table-provider.ts`,
 * `dynamodb-globaltable-provider.ts` and `apigatewayv2-provider.ts` — and
 * `elbv2-provider.ts` carried the standing instruction that "a THIRD site is
 * the point at which this should move into `../masked-retry-logger.ts` ... and
 * all three converge on it". That trigger had fired and been missed twice over,
 * and the copies had already diverged exactly as predicted: FOUR of the six
 * carried NO depth cap at all.
 *
 * Worth recording how the last two were nearly missed AGAIN, because it is the
 * same failure one level up: the first sweep for this issue grepped for
 * `maskDeep` / `MASK_WALK_MAX_DEPTH` — the SPELLINGS the known copies used —
 * and the two survivors spell it `maskLeaf` / `maskLeafValue` with no named
 * constant. Grep for the SHAPE, not the name. These copies encode a security
 * contract, and a hardening applied to one silently leaves the others behind.
 */
export function maskDeep(value: unknown, mask: MaskerFn, depth = 0): unknown {
  if (typeof value === 'string') return mask(value);
  // At the cap, SUBSTITUTE the subtree rather than returning it. Returning it
  // raw is silent DISCLOSURE -- every string leaf and key below this point
  // would be stringified in plaintext -- whereas substituting is silent
  // TRUNCATION, which is the failure a masker should prefer (issue #2176
  // security review).
  //
  // Stating the cap's real justification, because the obvious one is wrong: a
  // template-derived bag cannot be CYCLIC, so "guards against infinite
  // recursion" over-claims. What the cap actually bounds is unbounded WORK on a
  // pathologically deep bag, and what makes its direction matter is that this
  // helper is shared -- a future consumer may well walk something deeper than
  // the depth-2 shapes today's callers pass.
  if (depth >= MASK_WALK_MAX_DEPTH) return MASK_WALK_DEPTH_CAP_MARKER;
  if (Array.isArray(value)) return value.map((entry) => maskDeep(entry, mask, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        mask(k),
        maskDeep(v, mask, depth + 1),
      ])
    );
  }
  return value;
}
