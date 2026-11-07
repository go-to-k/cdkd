import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayMasked } from '../masking-display.js';
import { displaySafe, displayStackName } from '../../../utils/display-safe.js';
import type { NamedRequestMasks, ResolverContext } from '../support.js';
import {
  hasMaskableValues,
  maskSecretsInError,
  unionOfSecretBags,
} from '../../secret-redaction.js';

/**
 * A text transform replacing each RAW name this frame handed to another
 * module with the masked spelling it holds for it (issue
 * [#3234](https://github.com/go-to-k/cdkd/issues/3234)), or `undefined` when
 * no pair carries a mask.
 *
 * This is what the BAGS structurally cannot do. A bag masks by VALUE, and a
 * plaintext shorter than `MIN_NEEDLE_LENGTH` matches only as the WHOLE text,
 * so a 1-3 character secret an `Fn::Sub` assembled into a longer name is
 * invisible to it — while this frame knows the exact spans.
 *
 * A pair that DOES carry a mask contributes its raw spelling AND the spelling
 * the reader will actually see. `S3StateBackend` prints names through
 * `displayStackName`, whose first step is
 * `displaySafe(..., { asciiOnly: true })`, which REPLACES every non-printable
 * character with a space and then trims, so a secret carrying one is a
 * DIFFERENT string by the time it is quoted back and matching the raw form
 * alone would miss it while reporting success — the one-string-space rule
 * `outputs-export-alias/secret-scan.ts` states for its own scan: the text that was tested
 * and the text that is printed must be the same text. The CloudFormation
 * fallback does NOT sanitize (it rethrows the SDK's message as it is), so the
 * second spelling is inert at that call site and costs one comparison.
 *
 * NO MINIMUM LENGTH beyond non-empty, deliberately. A one-character masked
 * name rewrites every occurrence of that character in the sentence
 * (`a` -> `***` turns `us-east-1` into `us-e***st-1`), which is unreadable
 * but SAFE — the direction this function must never get wrong is printing
 * too little, not too much, and a floor here would be a floor on masking.
 *
 * `raw !== ''` is DEFENSIVE, and it is NOT the guard that handles a name
 * whose sanitized form is empty — that one inspects `shown`, below, and its
 * own comment says why. What this clause is not is redundant against
 * `raw !== masked`: `rememberLogTwin` has no empty-key guard and
 * `splitLogTwins` registers every piece it produces, so `registeredLogTwin`
 * can answer `***` for the empty string and make `maskSecretsRaw('')`
 * differ from `''`. Neither call site can reach it — both refuse an empty
 * name upstream — so it fences nothing measured today.
 *
 * LONGEST KEY FIRST — over every key, raw and sanitized alike, which is what
 * the comparator sees — so a key that contains another is rewritten as itself
 * rather than having the inner one replaced underneath it. **That ordering
 * is DEFENSIVE and this suite does not distinguish it** — measured: reversing
 * the comparator leaves every case green. The reason is that no case here
 * builds two raws that NEST: the one case with two surviving pairs masks a
 * stack name and a region that share no substring, and everywhere else one
 * pair is dropped for carrying no mask. It earns its place on the shape that
 * DOES diverge — a shorter raw whose mask is not a prefix of the longer's
 * (`q7` -> `***` beside `q7x` -> `***` turns `q7x` into `***x` shortest-first,
 * leaking the `x`) — which needs two separately recorded secrets, one of them
 * masked WHOLE, and is not constructed here. Recorded as measured rather than
 * claimed fenced.
 */
export function positionalNameMask(
  _resolver: IntrinsicFunctionResolver,
  pairs: readonly (readonly [string, string])[]
): ((text: string) => string) | undefined {
  const substitutions = pairs
    // DROP AN UNMASKED PAIR FIRST, and the order is the whole correctness
    // argument rather than a tidying. Expanding first and filtering after
    // tests the tuple that came out of the expansion, so for a pair carrying
    // NO mask (`masked === raw`) the `[raw, raw]` entry is dropped while
    // `[shown, raw]` survives — a transform that rewrites the SANITIZED
    // spelling back into the RAW one. That un-does the `displaySafe` the
    // printing module applied on purpose (issue #3003), re-opening the
    // padded-name spoof `display-safe.ts` documents and putting a live
    // escape sequence back on the terminal, and it corrupts unrelated text
    // besides (`production` -> `prod uction` for a name `prod `). Measured,
    // and a leading space is enough to reach it — no non-ASCII needed,
    // because `trim()` is part of the transform.
    .filter(([raw, masked]) => raw !== '' && raw !== masked)
    .flatMap(([raw, masked]) => {
      // THE INVARIANT, and the only thing to check when touching this: a
      // substitution's REPLACEMENT must be at least as sanitized and at
      // least as masked as its KEY. Three review rounds each broke it a
      // different way and each was fixed by enumerating one more shape, so
      // it is stated once here and enforced at construction instead.
      //
      // PER ENTRY, and deliberately not a claim about the COMPOSITION. Each
      // replacement is masked against its OWN twin only, so one pair's
      // secret can survive as a literal inside another's replacement — the
      // longer key runs first and the shorter one no longer matches there.
      // Measured, and the twin's SPAN is what decides it, so the spelling
      // matters: stack `us-qq-1x` twinned `us-qq***x` beside region
      // `us-qq-1` twinned `us-***-1` leaves the region's `qq` inside the
      // stack entry's replacement. Twin the stack as `us-***-1x` instead —
      // the reading where both names mask the shared secret — and nothing
      // survives, which is why naming the span is part of the claim. That is
      // the `q7`/`q7x` residual recorded at the
      // sort, one composition over, and it is not a regression: every step
      // replaces text with a value at least as masked, so the result is
      // never weaker than the sentence the sink printed. Closing it means
      // feeding each replacement through the other entries' masks here.
      //
      // The raw key is what a sink that did NOT sanitize prints, so it takes
      // the twin as it is. The sanitized key is what a sink that DID prints,
      // and its replacement is sanitized to match — the twin keeps the
      // template's literal parts VERBATIM (only the secret span becomes
      // `***`), so an unsanitized replacement there puts the control
      // characters the printer had just removed back into the message, in
      // the top-level text neither `formatError` nor the logger sanitizes.
      const shown = displaySafe(raw, { asciiOnly: true });
      // A THIRD spelling (go-to-k/cdkd#3617): `S3StateBackend` now renders a
      // name through `displayStackName`, which puts a non-plain name inside a
      // JSON string -- so a `"` or `\` in it reaches the message ESCAPED, and
      // neither spelling above matches it there. Its replacement is escaped
      // the same way, so it is as sanitized and as masked as its key.
      const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);
      // ...and a FOURTH, the whole rendered token: `displayStackName` CUTS a
      // name past `STACK_REF_MAX_CODE_POINTS`, and a cut prefix matches none
      // of the whole-name keys -- a sub-floor secret inside it, or the shown
      // half of a secret straddling the cut, would print. The rendered token
      // is replaced with the rendering of the masked text, so it fails closed.
      const rendered = displayStackName(raw);
      const escapedPair = [
        ...(shown !== '' && escaped(shown) !== shown
          ? [[escaped(shown), escaped(displaySafe(masked, { asciiOnly: true }))] as const]
          : []),
        ...(rendered !== raw && rendered !== shown && rendered !== escaped(shown)
          ? [[rendered, displayStackName(displaySafe(masked, { asciiOnly: true }))] as const]
          : []),
      ];
      if (shown === raw) return [[raw, masked] as const, ...escapedPair];
      // Empty after sanitizing: substituting `''` splices the replacement
      // between every character, so that key contributes nothing. The
      // `shownMask` half of that test is UNREACHABLE and kept as the other
      // side of one rule rather than as a live case — `masked !== raw` is
      // already guaranteed above, so masking fired and the text contains
      // `***`, which `displaySafe` preserves.
      const shownMask = displaySafe(masked, { asciiOnly: true });
      return shown === '' || shownMask === ''
        ? [[raw, masked] as const]
        : ([[raw, masked] as const, [shown, shownMask] as const, ...escapedPair] as const);
    })
    .sort(([a], [b]) => b.length - a.length);
  if (substitutions.length === 0) return undefined;
  return (text: string): string => {
    let out = text;
    for (const [raw, masked] of substitutions) out = out.split(raw).join(masked);
    return out;
  };
}

/**
 * Mask a failure raised by a module this resolver handed RAW names to (issue
 * [#3234](https://github.com/go-to-k/cdkd/issues/3234)).
 *
 * Returns a masked CLONE of the whole cause chain, not a new wrapper, and
 * that is the point: `formatError` renders `Caused by: <cause>`, so masking
 * only a fresh top-level message leaves the original message one link down
 * and prints it anyway. The clone keeps the class, every own descriptor
 * (`markNonRetryable`'s non-enumerable symbol, `$metadata`, and `Code` /
 * `name` verbatim), other data values masked,
 * and the chain shape, so every reader that classifies this error still
 * does — see `maskSecretsInError`'s own doc.
 *
 * `pairs` are (raw, masked-log-text) for the names this frame handed over;
 * {@link positionalNameMask} turns them into the transform and owns why.
 */
export function maskStateReadError(
  resolver: IntrinsicFunctionResolver,
  error: unknown,
  pairs: readonly (readonly [string, string])[],
  context?: ResolverContext
): never {
  throw maskNamedError(resolver, error, positionalNameMask(resolver, pairs), context);
}

/**
 * {@link maskStateReadError}'s body, RETURNING the masked clone rather than
 * throwing it, so {@link namedRequestMasks} can hand the same answer to an
 * SDK call site (go-to-k/cdkd#3171). `extraMask` is a
 * {@link positionalNameMask} transform, or `undefined` for none.
 */
export function maskNamedError(
  _resolver: IntrinsicFunctionResolver,
  error: unknown,
  extraMask: ((text: string) => string) | undefined,
  context?: ResolverContext
): unknown {
  // The SAME two bags in the SAME order as `maskSecretsRaw`, for the same
  // reason (issue #1903 round 2): on a nested-stack child the parent's
  // decrypted parameter plaintext lives in the inherited bag alone until a
  // `{Ref: <Param>}` resolution copies it across.
  //
  // `extraMask` rides the FIRST pass only. It is not idempotent against
  // itself in general — a masked spelling could in principle contain another
  // pair's raw text — and re-running it over text the first pass already
  // rewrote is how a second substitution would corrupt the first. One pass
  // is also all it needs: `maskSecretsInError` walks the whole chain, so a
  // single call reaches every link.
  let masked: unknown = error;
  let positional = extraMask;
  // ONE pass over the UNION of both bags (go-to-k/cdkd#4049): masked bag by
  // bag, the first bag's shorter needle cut a longer needle the second bag
  // held, and the rest of it printed. `hasMaskableValues`, not `size`
  // (go-to-k/cdkd#1998): a bag holding only log-only needles still masks.
  // The print-only corpus joins it (go-to-k/cdkd#4043): an error is RENDERED.
  const union = unionOfSecretBags([
    context?.inheritedSecrets,
    context?.recordedSecretValues,
    context?.printingSecrets,
  ]);
  if (hasMaskableValues(union)) {
    masked = maskSecretsInError(masked, union, positional);
    positional = undefined;
  }
  // FAIL CLOSED when both bags are empty. An earlier revision deleted this
  // arm, reasoning that a pair carries a mask only when the masker changed
  // the name, which needs a twin or a bag, and a twin's spans come from a
  // recorded secret — so `extraMask` should imply a non-empty bag.
  //
  // THAT ARGUMENT IS NOW FALSE, and go-to-k/cdkd#3426 is what falsified it:
  // the pairs are built with `displayMasked`, whose result differs from its
  // input for a CONTROL CHARACTER alone — no twin, no bag, nothing recorded.
  // `positionalNameMask`'s filter is `raw !== masked`, so a hostile name with
  // both bags empty now reaches this line. It was written as a fail-closed
  // arm against an invariant nobody fenced; it is a REACHED arm today. The
  // cost of not having it is the RAW name rethrown in the clear.
  // `maskSecretsInError` with an empty bag and a transform is exactly the
  // shape its widened early return admits.
  if (positional) masked = maskSecretsInError(masked, new Map(), positional);
  return masked;
}

/**
 * The three masks an AWS SDK call site owes the text the SDK produces about a
 * request that carried template-derived NAMES (go-to-k/cdkd#3171).
 *
 * The resolver masks every name it prints ITSELF through the name's log text
 * (go-to-k/cdkd#3150), but an SDK rejection QUOTES the name it refused back —
 * `ParameterNotFound: <name>`, a region in a describe failure — and that
 * text reached only the needle mask, whose substring arm has the
 * {@link MIN_NEEDLE_LENGTH} floor. A name an `Fn::Sub` assembled around a
 * 1-3 character secret printed masked in the resolver's own words and in the
 * clear a few characters later, in the SDK's.
 *
 * `pairs` are (raw name as SENT, that name's log text), the same shape
 * {@link positionalNameMask} takes and for the same reason; an unmasked pair
 * is dropped there. ONE helper returning all three, so a call site cannot
 * adopt one and miss the others:
 *
 * - `error` — a masked CLONE of the whole cause chain
 *   ({@link maskNamedError}), which keeps the class and every own descriptor,
 *   so `isThrottlingError` / `isMarkedNonRetryable` still classify it;
 * - `text` — a caught message about to be interpolated into a line or a
 *   throw, positional pass first, then {@link displayMasked};
 * - `retryLogger` — for `withRetry`, whose per-attempt `debug` line and
 *   give-up `warn` interpolate the SDK message verbatim.
 *
 * THE WHOLE NAME is the key, never its secret span alone: the substitution
 * rewrites every occurrence of the raw name wherever the SDK put it (inside
 * an ARN, after a colon). That is what reaches a sub-floor secret — the
 * whole name is longer than the secret — and it is also the bound: a name
 * the SDK re-encodes or truncates before quoting it is not matched, and a
 * masked name of 1-3 characters is matched only where the SDK quotes it
 * exactly, which may over-mask unrelated text (the SAFE direction
 * {@link positionalNameMask} documents).
 */
export function namedRequestMasks(
  resolver: IntrinsicFunctionResolver,
  pairs: readonly (readonly [string, string])[],
  context?: ResolverContext
): NamedRequestMasks {
  // A producer-region GUEST's own region rides along on every request: the
  // guest's clients are built for it, so an endpoint failure quotes it
  // (`getaddrinfo ENOTFOUND secretsmanager.<region>.amazonaws.com`) in text
  // no caller-supplied pair covers, and it is template-derived — the secret
  // ARN's region, which an `Fn::Sub` can assemble around a short secret
  // (go-to-k/cdkd#3171 review). An ordinary resolver's region has no log
  // text and adds nothing.
  const positional = positionalNameMask(
    resolver,
    resolver.explicitRegion !== undefined && resolver.explicitRegionLogText !== undefined
      ? [...pairs, [resolver.explicitRegion, resolver.explicitRegionLogText]]
      : pairs
  );
  const text = (message: string): string =>
    displayMasked(resolver, positional ? positional(message) : message, context);
  // `displaySafe` TRIMS, so a line `retry.ts` indents would lose its indent;
  // the leading SPACES are carried across (spaces only: nothing a terminal
  // interprets).
  const line = (message: string): string => {
    const indent = /^ */.exec(message)?.[0] ?? '';
    return indent + text(message.slice(indent.length));
  };
  return {
    error: (error) => maskNamedError(resolver, error, positional, context),
    text,
    retryLogger: {
      debug: (message) => resolver.logger.debug(line(message)),
      // UNREACHABLE from `sendWithThrottleRetry` today: `withRetry` warns only
      // after a propagation / cooldown / server-error retry, and a caller
      // passing its own `isRetryable` counts none. Masked anyway, since the
      // interface makes it optional rather than absent.
      warn: (message) => resolver.logger.warn(line(message)),
    },
  };
}
