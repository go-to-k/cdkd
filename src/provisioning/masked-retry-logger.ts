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
 * locally so this module keeps its single-import leaf property. Providers use
 * whichever name is closer to hand -- most pass the contract's own
 * `SecretMasker` straight through, while a helper that only forwards the
 * capability (`ec2-provider.ts`, `ssm-parameter-provider.ts`) imports
 * `MaskerFn` from here. Both are the same type.
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
 * The masked sinks ONE provider operation routes every log line through
 * (issue [#2177](https://github.com/go-to-k/cdkd/issues/2177)).
 *
 * This is the `ssm-parameter-provider.ts` shape — one masked sink per
 * operation, so a line added later is masked by construction — shared rather
 * than re-spelled per file, for the reason this module's header gives for
 * {@link createMaskedRetryLogger}: per-file copies of a security contract
 * drift apart.
 *
 * Build it per CALL from the operation's own context; never cache it on the
 * provider instance, which serves concurrent resources.
 */
export interface MaskedLogSinks {
  /** The masker itself (identity when none was supplied), for a helper taking one. */
  readonly mask: MaskerFn;
  /**
   * Mask ONE interpolated value RAW, before it joins a sentence. Only the raw
   * value reaches the masker's WHOLE-VALUE arm, so a secret shorter than the
   * substring arm's floor is caught here and nowhere else (see
   * {@link maskDeep}'s LENGTH note). `String()` first, which renders exactly
   * what `${value}` would: a bag value typed only by a cast can be a
   * non-string at runtime, and the masker calls `.replace` on its input.
   */
  readonly value: (value: unknown) => string;
  /** `logger.debug`, with the finished message routed through the masker. */
  readonly debug: (message: string) => void;
  /** `logger.warn`, with the finished message routed through the masker. */
  readonly warn: (message: string) => void;
}

/**
 * Build {@link MaskedLogSinks} over `logger` and the masker a caller supplied.
 * Absent means identity, exactly as {@link maskerOrIdentity}.
 */
export function createMaskedLogSinks(
  logger: { debug(message: string): void; warn(message: string): void },
  maskSecrets: MaskerFn | undefined
): MaskedLogSinks {
  const mask = maskerOrIdentity(maskSecrets);
  return {
    mask,
    value: (value: unknown) => mask(String(value)),
    debug: (message: string) => logger.debug(mask(message)),
    warn: (message: string) => logger.warn(mask(message)),
  };
}

/**
 * Is `raw` secret-derived, in the sense {@link withDerivedNameMasks} documents:
 * the masker changes it, it still spells a `{{resolve:` reference, or it IS the
 * whole redaction mask. Exported for a caller that needs the same answer
 * without building sinks.
 */
export function isSecretDerivedValue(raw: unknown, mask: MaskerFn): raw is string {
  return (
    typeof raw === 'string' &&
    raw !== '' &&
    (mask(raw) !== raw || raw.includes('{{resolve:') || raw === MASK_WALK_DEPTH_CAP_MARKER)
  );
}

/**
 * Extend `sinks` so a name DERIVED from a secret-bearing template value is
 * masked too (issue [#2177](https://github.com/go-to-k/cdkd/issues/2177)
 * security review).
 *
 * A provider that builds its physical name with
 * `generateResourceNameWithFallback` hands the masker a REWRITTEN value — the
 * stack-name prefix, `[^A-Za-z0-9-]` replaced by `-`, and past `maxLength` a
 * truncation plus hash — and the masker matches LITERALLY, so neither of its
 * arms recognises `stack-alice-example-com` as the secret `alice@example.com`.
 * The derived spelling is what every log line, pasteable command and AWS echo
 * then carries.
 *
 * Each pair is `[raw template value, name derived from it]`. A derived name is
 * added as a needle ONLY when the raw value is secret-derived, so an ordinary
 * name is left alone. Secret-derived means either of:
 *
 *  - the caller's own masker changes it — a RESOLVED value this deploy recorded
 *    (the desired bag), or one embedding such a value;
 *  - it still spells a `{{resolve:` reference. That is the shape a PREVIOUS
 *    bag read from state carries: redaction persists a secret leaf as its
 *    reference, while a public ssm value is stored resolved, so a surviving
 *    reference IS a secret — and its plaintext need not be in THIS deploy's
 *    bag at all (a rotated or re-pointed secret), so the masker cannot say so;
 *  - it IS the whole redaction mask (`***`). Redaction persists a leaf it can
 *    only mask, such as a NoEcho custom-resource `GetAtt`, as that mask, so a
 *    previous value of exactly `***` was a secret too.
 *
 * {@link isSecretDerivedValue} is that predicate, exported for a caller that
 * needs the same answer without building sinks.
 *
 * NO length floor, unlike `maskSecretsInText`'s substring arm, and on purpose:
 * that floor trades a leak for fewer incidental matches, and a derived name
 * that is short is still the secret's spelling. The failure without a floor is
 * over-masking unrelated text in this operation's lines, never disclosure.
 *
 * The derived name is replaced wherever it OCCURS — including inside an ARN
 * built from it — and the returned `mask` is the extended one, so a
 * `pasteableAwsCommand(mask)` WITHHOLDS a command naming it.
 *
 * THE BASE MASKER RUNS FIRST, the needles after it (issue
 * [#4193](https://github.com/go-to-k/cdkd/issues/4193)). The base is one
 * pass over the recorded secrets, so a needle replaced BEFORE it
 * could cut a longer recorded secret containing the needle, which then no
 * longer occurs whole and its remainder prints. Each name is rendered as the
 * base renders it, on EVERY call (the base can read a bag that grows after
 * these sinks are built), and that rendering is the needle applied to the
 * base's output.
 *
 * THE INVARIANT: every occurrence of a derived name left in the line —
 * overlapping ones included — reads as exactly `base(name)` in the base's
 * output, or the WHOLE line is `***`. An
 * occurrence a recorded secret crosses or contains renders otherwise, and its
 * part outside that secret would print (a fragment of secret plaintext, since
 * a derived name may be a folded copy of the secret). The needles then only
 * replace with the mask, so the helper never reveals what the base hides:
 * what it prints is a subset of what the base alone prints. Occurrences that
 * overlap one another may not be masked whole (the split / join residual
 * below).
 *
 * Exempt from the check, as residuals:
 *
 *  - a name shorter than {@link BASE_MASKER_SUBSTRING_FLOOR} is applied as a
 *    raw needle and not checked, for the FALSE-POSITIVE rate (a short name
 *    sits inside unrelated secrets); a recorded secret crossing one can print
 *    at most two of its characters;
 *  - a name whose rendering is exactly `***` is a recorded secret itself, and
 *    renders as the base alone renders it.
 *
 * Two more residuals:
 *
 *  - the needles are replaced by split / join, so occurrences that overlap
 *    one another, or another name's occurrence, can leave the part outside
 *    the first replacement (`ababab` against the name `abab` prints
 *    `***ab`); unchanged from before issue #4193;
 *  - the check costs O(occurrences x line length) per name: a few KB of AWS
 *    echo or log line is cheap, and a very large leaf string walked through
 *    {@link maskDeep} is where it shows.
 *
 * False positives over-mask, the direction this module prefers: a recorded
 * secret crossing or containing an occurrence, or a prefix / suffix of the
 * line that coincidentally equals a short recorded secret, withholds the line.
 */
export function withDerivedNameMasks(
  logger: { debug(message: string): void; warn(message: string): void },
  sinks: MaskedLogSinks,
  pairs: ReadonlyArray<readonly [raw: unknown, derived: string | undefined]>
): MaskedLogSinks {
  const base = sinks.mask;
  const derivedNames = pairs
    .filter(
      (pair): pair is readonly [string, string] =>
        typeof pair[0] === 'string' &&
        pair[0] !== '' &&
        typeof pair[1] === 'string' &&
        pair[1] !== '' &&
        isSecretDerivedValue(pair[0], base)
    )
    .map(([, derived]) => derived);
  if (derivedNames.length === 0) return sinks;
  const mask: MaskerFn = (text: string) => {
    const masked = base(text);
    const needles: string[] = [];
    for (const derived of new Set(derivedNames)) {
      // The base never sees a name this short as a substring: a raw needle.
      if (derived.length < BASE_MASKER_SUBSTRING_FLOOR) {
        needles.push(derived);
        continue;
      }
      const rendered = base(derived);
      // The base hides it whole.
      if (rendered === MASK_WALK_DEPTH_CAP_MARKER) continue;
      // Each occurrence must read as `rendered` in the base's output (the
      // invariant above), or a recorded secret crosses or contains it.
      for (let i = text.indexOf(derived); i !== -1;) {
        const j = i + derived.length;
        if (masked !== base(text.slice(0, i)) + rendered + base(text.slice(j))) {
          return MASK_WALK_DEPTH_CAP_MARKER;
        }
        // `i + 1`, not `j`: an occurrence OVERLAPPING this one is checked too.
        i = text.indexOf(derived, i + 1);
      }
      needles.push(rendered);
    }
    // Longest first, so a needle that contains another is replaced whole. The
    // same marker the depth cap substitutes, which is fenced against
    // `SECRET_MASK` (see {@link MASK_WALK_DEPTH_CAP_MARKER}).
    let out = masked;
    for (const needle of needles.sort((a, b) => b.length - a.length)) {
      out = out.split(needle).join(MASK_WALK_DEPTH_CAP_MARKER);
    }
    return out;
  };
  return {
    mask,
    value: (value: unknown) => mask(String(value)),
    debug: (message: string) => logger.debug(mask(message)),
    warn: (message: string) => logger.warn(mask(message)),
  };
}

/**
 * Depth cap for {@link maskDeep}.
 *
 * What it actually bounds is unbounded WORK on a pathologically deep bag — see
 * the rationale at the cap itself, which is the authority. It is NOT primarily
 * a cycle guard: a template-derived bag cannot be cyclic, so that justification
 * over-claims (issue #2176 security review). It does still terminate one, which
 * is why the walk is safe to share with a caller that might hand it something
 * other than a template bag.
 *
 * Deliberately generous. Every shape these warnings exist to describe is a
 * scalar, a list of scalars, or a small record, so the walk does not reach
 * depth 2 in practice.
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
 * The length below which the deploy's base masker leaves a SUBSTRING alone
 * (it still masks a whole value of any length), so a derived-name needle this
 * short is stored as-is rather than passed through the base first — see
 * {@link withDerivedNameMasks}.
 *
 * MUST equal `MIN_NEEDLE_LENGTH` in `src/deployment/secret-redaction.ts`,
 * spelled here for the same leaf-module reason as
 * {@link MASK_WALK_DEPTH_CAP_MARKER} and fenced against drift the same way.
 */
export const BASE_MASKER_SUBSTRING_FLOOR = 4;

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
