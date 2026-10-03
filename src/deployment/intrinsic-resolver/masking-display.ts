import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { displaySafe } from '../../utils/display-safe.js';
import { UNSHOWABLE_VALUE } from '../../utils/pasteable-command.js';
import { stripControlChars } from '../../utils/regexp.js';
import { type ResolverContext, boundAltered, isLogInert, isLogInertJson } from './support.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    maskValueLeaves: OmitThisParameter<typeof maskValueLeaves>;
    /** @internal */
    maskThenStripThenMask: OmitThisParameter<typeof maskThenStripThenMask>;
    /** @internal */
    displayMasked: OmitThisParameter<typeof displayMasked>;
    /** @internal */
    logRender: OmitThisParameter<typeof logRender>;
    /** @internal */
    splitDelimiterRender: OmitThisParameter<typeof splitDelimiterRender>;
    /** @internal */
    displayMaskedIdent: OmitThisParameter<typeof displayMaskedIdent>;
    /** @internal */
    displayLeaf: OmitThisParameter<typeof displayLeaf>;
  }
}

/**
 * A copy of `value` with every string LEAF (and every object KEY) masked, for
 * a caller about to ENCODE it into a message (issue
 * [#2759](https://github.com/go-to-k/cdkd/issues/2759)).
 *
 * `stringifyValue` / `JSON.stringify` ESCAPE a leaf containing `"`, `\` or a
 * control character, and {@link maskSecretsInText} matches a needle
 * LITERALLY — so masking the ENCODED text misses exactly the plaintexts the
 * encoder rewrote (`pa"ss\word12` encodes to `["pa\"ss\\word12"]`, which no
 * needle matches). Masking each leaf first also buys the WHOLE-VALUE arm,
 * which has no {@link MIN_NEEDLE_LENGTH} floor, for a leaf that IS the
 * plaintext.
 *
 * Returns the STRUCTURE rather than a rendered string, deliberately: each
 * call site keeps its own encoder, so this changes which characters are
 * masked and nothing about how a value RENDERS. Encoding here instead
 * dropped `JSON.stringify`'s quotes around a bare string and made a `cdkd
 * scrub` log line unrecognisable to its own test.
 *
 * Object KEYS are masked too: a `Fn::Split` / `Fn::GetAtt` chain can put a
 * resolved value in key position, and an unmasked key discloses exactly as
 * much as an unmasked value.
 *
 * Cycle-safe by MEMOIZATION rather than a depth cap: a self-referential
 * structure terminates (the replacement is registered before its children are
 * walked, so the cycle closes on it) and a legal deep one is still walked to
 * the bottom. A repeated but NON-cyclic sub-object gets its real rendering
 * rather than a placeholder — see the note at the `Map`.
 */
/** @internal */
export function maskValueLeaves(
  this: IntrinsicFunctionResolver,
  value: unknown,
  context?: ResolverContext
): unknown {
  // MEMOIZED, not a visited-SET (issue #2827 review round 1). A `Set` that is
  // never popped cannot tell a CYCLE from a DAG: an object referenced twice
  // in the same structure — an `Fn::Split` result reused at two positions is
  // the ordinary way to get one — rendered as `null` the second time, which
  // this method's own doc claimed happened only to a cycle. A `Map` from node
  // to its already-computed replacement terminates a cycle just as a set
  // does (the entry is written BEFORE the children are walked) while giving a
  // repeat its real rendering.
  const done = new Map<object, unknown>();
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return this.displayMasked(node, context);
    }
    if (node === null || typeof node !== 'object') return node;
    const memo = done.get(node);
    if (memo !== undefined) return memo;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      // Registered BEFORE the walk, so a self-referential array terminates
      // against this same (still-growing) instance instead of recursing.
      done.set(node, out);
      for (const item of node) out.push(walk(item));
      return out;
    }
    // `Object.create(null)`, and a PLAIN assignment onto it (issue #2802's
    // rule; the shape `:6291` uses). This was `Object.assign(out, { [k]: v })`
    // — and `Object.assign` INVOKES a setter on the receiver's prototype
    // chain, so a masked key of `__proto__` ran `Object.prototype.__proto__`'s
    // setter: own keys `[]`, prototype hijacked, `JSON.stringify` `{}`. Not a
    // disclosure (every leaf is already masked) but the field vanishes from
    // the diagnostic, which is the failure this walk exists to avoid. A
    // null-prototype receiver has no such setter to reach, so the assignment
    // is an ordinary own-key write.
    //
    // ONE STATED COST of rendering the KEY through the builder: two DISTINCT
    // keys that produce the same display collapse to one entry, so the
    // rendering shows fewer fields than the value has. Since
    // go-to-k/cdkd#3426 that needs NO secret at all — the builder strips and
    // trims, so `" Name"` and `"Name"` collide, two keys differing only by a
    // control character collide, and an all-control key becomes the empty
    // string. (Before, the collapse required both keys to mask to `***`.)
    // Accepted rather than worked
    // around on the same terms as before: both keys are rendered either way,
    // and the loss is a field COUNT in a diagnostic, never a disclosure.
    // Disambiguating them would put an index into a masked key, which is a
    // worse trade.
    //
    // The memo's CYCLE arm is unreachable from `resolveValue`: a template is
    // parsed from JSON so it holds no cycle, and a hand-built one recurses in
    // the resolver's own walk long before this runs (measured, review round 3).
    // Kept as defence in depth for a caller arriving another way — and BOTH
    // memo arms are pinned by tests that call this method directly, which is
    // the only way to reach either (`resolveValue` REBUILDS the structure, so
    // a shared sub-object arriving through it is no longer one reference by
    // the time the walk runs).
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    done.set(node, out);
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // allow-template-keyed-bag-read: `out` is `Object.create(null)` two lines
      // up, so this write has no inherited setter to reach — which is the whole
      // reason the receiver was changed from `{}`. The critic's own
      // `Object.create(null)` arm does not fire here because the bag is
      // declared inside this arrow rather than an enclosing scope.
      out[this.displayMasked(key, context)] = walk(child);
    }
    return out;
  };
  return walk(value);
}

/**
 * Mask `value`, STRIP its control characters, then mask again — the shape a
 * message that truncates its input needs (issue
 * [#2827](https://github.com/go-to-k/cdkd/issues/2827) review round 1).
 *
 * NEITHER SINGLE ORDER IS CORRECT, and both were measured. Masking AFTER
 * `stripControlChars` is what this fix was written to avoid: the strip
 * rewrites the text a literal needle has to match. But masking BEFORE it is
 * not safe either, because `stripControlChars` DELETES rather than replaces —
 * so a plaintext SPLIT by an invisible (`S3cret\u200ePassw0rd`) is missed by
 * the first mask and then RECONSTITUTED contiguous by the strip. That is the
 * go-to-k/cdkd#2874 class arriving through a different door.
 *
 * Masking in BOTH string spaces closes both: the first pass catches a needle
 * that occurs literally, the second catches one that only becomes contiguous
 * after stripping. `maskSecretsInText` is idempotent, so the overlap costs
 * nothing, and the caller truncates AFTERWARDS — never between the two.
 *
 * WHICH HALF IS FENCED, stated because a mutation probe made the difference
 * visible. The FIRST mask is demonstrated by a test: deleting it (masking
 * only after the strip) reds the split-needle case, because the recorded
 * needle is then the split form and the strip has destroyed it. The SECOND
 * mask earns its place when the bag holds a needle that is the STRIPPED form
 * of the text in hand. A value this resolver resolved cannot be that text
 * (the split copy is itself recorded, so the first mask catches it), but a
 * template LITERAL can: issue #3150's region-scoped clients refusal prints
 * a producer-region guest's region through {@link displayMasked}, and a
 * literal ARN region spelling a recorded `st-1` as `s` + U+0001 + `t-1` is
 * masked only by the second pass
 * (`intrinsic-resolver-name-argument-log-twin.test.ts` pins both halves on
 * that route).
 *
 * ONE CALLER, {@link displayMasked}, since go-to-k/cdkd#3426. It is most of
 * the answer and reads like all of it — it omits `displaySafe`, and
 * therefore `U+2028` / `U+2029` and the bidi overrides — so a site reaching
 * for it directly is the near-miss back onto the treadmill. A DIRECT
 * `${this.maskThenStripThenMask(...)}` interpolation is refused by
 * `resolver-display-masked-population.test.ts`'s line rule; a BINDING of it
 * rendered later is not seen by anything since go-to-k/cdkd#3435 deleted the
 * AST checker, which is why the one-caller containment above is the control
 * that matters.
 *
 * THE BOUND, since this file's job is to state them: this covers a needle
 * split by a character `stripControlChars` removes. A needle split by
 * anything else, or one whose canonical form differs for another reason, is
 * `outputs-export-alias/secret-scan.ts`'s `canonicalForSecretScan` problem and is not
 * solved here.
 */
export function maskThenStripThenMask(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): string {
  return this.maskSecretsRaw(stripControlChars(this.maskSecretsRaw(value, context)), context);
}

/**
 * The ONE way a masked value reaches a message in this file — and, since
 * go-to-k/cdkd#3426, the ONLY exit from the masking machinery at all.
 *
 * ## Why this exists rather than a rule about call sites
 *
 * {@link maskSecretsRaw} answers "does this text contain a recorded secret"
 * and makes NO claim about control characters. That split produced a
 * four-round treadmill on go-to-k/cdkd#3408. Round 1 found the four
 * `Fn::GetStackOutput` throws rendering a masked name raw and fixed them.
 * Round 2 found the CloudFormation-fallback warn — the DEFAULT path, at
 * DEFAULT verbosity — and the self-reference throw. Round 3 found the
 * `reresolveCrossStackValue` origin builder and `describeAvailableOutputs`.
 * Each round fixed what it found and the next round found more, because the
 * population was never enumerated. Measured 2026-09-19 with a
 * comment-stripped scan: SEVENTY-ONE interpolations rendered a bare masker
 * result directly, plus thirteen hand-spelled
 * `displaySafe(maskThenStripThenMask(...))` compositions and two bare
 * `maskThenStripThenMask` interpolations — and three reviewers between them
 * reached eight of the eighty-six.
 *
 * ROUND FIVE was the BINDING shape: `const loggedExportName =
 * this.<masker>(...)` interpolated later, which a line-shaped scanner
 * forbidding `${this.<masker>(` structurally cannot see. Ten of them existed,
 * and `loggedExportName` was a LIVE exposure — an `Fn::ImportValue` export
 * name carrying `ESC[2K` + CR reached a warn AND a throw unstripped, at
 * default verbosity on the default path.
 *
 * Patching those ten sites would have been the fifth round of one
 * enumeration. What closes the class instead is that there is no longer a
 * masking answer a site can reach WITHOUT the strip: every escaping call of
 * the old `maskSecretsForLog` now calls this builder, the raw masker is
 * reachable only through {@link maskThenStripThenMask}, and that helper is
 * reachable only from here.
 *
 * ## What keeps it closed
 *
 * `tests/unit/deployment/resolver-display-masked-population.test.ts`, which
 * asserts from the AST that `maskSecretsRaw` is referenced only inside
 * `maskThenStripThenMask` and that helper only inside this builder — exact
 * reference counts, no inference — and refuses a direct
 * `${this.<raw masker>(...)}` interpolation by line rule.
 *
 * An AST walk that ALSO resolved an interpolated identifier to its
 * declaration used to cover the BINDING shape. go-to-k/cdkd#3435 deleted it
 * as high-maintenance tooling (23 commits across it and its suite in nine
 * days; a widening attempted one PR earlier produced nine defects inside
 * itself and was withdrawn), so that shape is now held by the containment
 * above — there is no bare masker to bind, because nothing outside this
 * builder may call one.
 *
 * KNOWN BOUND, stated rather than implied away: a site carrying an
 * exclusion marker is exempt from that walk, because the marker answers the
 * SECRET question ("this value cannot carry a plaintext"), which is not the
 * control-character question. Such a site sanitizes by hand or not at all —
 * `clientsForRegion`'s two region renders are both markered, and both
 * sanitize. Widening the walk to judge every interpolated value is
 * go-to-k/cdkd#3405's mixed-render scope, not this builder's.
 *
 * (The marker's literal spelling is deliberately not written in this comment:
 * the checker scans the raw text for it, and a prose mention parses as a
 * marker no site consumes — which it then reports STALE. Measured while
 * writing this paragraph.)
 *
 * ## What it does, in order
 *
 * `maskThenStripThenMask` first — mask, strip, mask — because
 * `stripControlChars` DELETES, so a plaintext split by an invisible would be
 * reconstituted contiguous by a strip applied after a single mask. Then
 * `displaySafe`, which covers the class `stripControlChars` does not:
 * `U+2028` / `U+2029` (line terminators to JSON and web log viewers) and the
 * Trojan-Source bidi overrides. That composition is what the `physicalId`
 * renders here already spelled by hand; this names it, and they now share it.
 *
 * It is the ONE sanctioned exit from the masking machinery, which is a
 * SECURITY decision and a sound one: every path through it passes the
 * needle-and-twin mask, twice, so it is strictly stronger than the bare
 * masker it replaced and cannot be weaker at any input.
 */
/** @internal */
export function displayMasked(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): string {
  return displaySafe(this.maskThenStripThenMask(value, context));
}

/**
 * {@link displayMasked} for a value or name on a `--verbose` `Resolved …`
 * line, bounded so a pasted line cannot run or redirect through it
 * (go-to-k/cdkd#4161): the masked display when {@link isLogInert} admits it,
 * so an ordinary value and a `***` mask print as they always did, and
 * otherwise `UNSHOWABLE_VALUE`, the description cdkd's other pasteable
 * prose uses (the go-to-k/cdkd#4229 decision). A description runs nothing
 * under either quote flip, which a JSON-quoted value does not. The mask runs
 * FIRST, so nothing it hid is shown. Not closed here: a PLAIN name that is
 * itself a command word right after a `: ` (go-to-k/cdkd#4249).
 *
 * Not `displayMaskedIdent`: that quotes every value a mask ALTERED
 * (`"port:***"`), cuts at 255 characters and blanks non-ASCII, and the
 * integ fixtures' masked-line checks read the bare mask
 * (`nested-stack-3level`'s `masked_whole` wants `<prefix>***` at the line's
 * end).
 *
 * Two opt-ins, each set by the CALLER from what produced the text, never
 * inferred from the text itself (go-to-k/cdkd#4243 review):
 * - `redacted`: the text is `stringifyParameterForLog` /
 *   `stringifyAttributeForLog`'s own `<redacted>` token, printed bare as it
 *   always was. A template value spelled `<redacted>` is a `<` and a `>`
 *   redirect and is described like any other.
 * - `structured`: the text is a JSON render (`stringifyValue`'s of an array
 *   or object, or a `JSON.stringify` the caller built). Kept while
 *   {@link isLogInertJson} admits it, so a list of plain or masked values
 *   still reads as one; otherwise described.
 */
/** @internal */
export function logRender(
  this: IntrinsicFunctionResolver,
  value: string,
  context: ResolverContext | undefined,
  opts: { readonly structured?: boolean; readonly redacted?: boolean } = {}
): string {
  const shown = this.displayMasked(value, context);
  if (opts.redacted === true && shown === '<redacted>') return shown;
  const inert = opts.structured === true ? isLogInertJson(shown) : isLogInert(shown);
  return inert ? shown : UNSHOWABLE_VALUE;
}

/**
 * The `Fn::Split` delimiter on its `Resolved` line: `"<d>"` when the masked
 * delimiter is {@link isLogInert}, otherwise described. `quotedRender`'s
 * class admits `|`, `<`, `>` and `*` because they are literal INSIDE cdkd's
 * `"…"`, but an unpaired `"` above the line flips that quote and leaves the
 * delimiter bare, where `>` redirects (go-to-k/cdkd#4229's `"` flip).
 */
export function splitDelimiterRender(
  this: IntrinsicFunctionResolver,
  delimiter: string,
  context: ResolverContext | undefined
): string {
  const shown = this.displayMasked(delimiter, context);
  return isLogInert(shown) ? `"${shown}"` : 'a delimiter (not shown: it is not a plain identifier)';
}

/**
 * {@link displayMasked}, then bounded as an IDENTIFIER (go-to-k/cdkd#3617):
 * bare when plain, otherwise one JSON string, so a template- or state-chosen
 * name cannot close a quote of cdkd's own and write a clause into the
 * message. Masked FIRST: `displayIdent` blanks non-ASCII and cuts, either of
 * which would stop a recorded plaintext inside the name from matching.
 */
/** @internal */
export function displayMaskedIdent(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext,
  maxCodePoints?: number
): string {
  // The ASCII allowlist runs BETWEEN two masks: `displayIdent` would blank a
  // non-ASCII character to a space after the mask, and a recorded secret
  // spelled with that space (`correct horse` beside `correct<NBSP>horse`)
  // would then print byte for byte.
  const asciiMasked = this.displayMasked(
    displaySafe(this.displayMasked(value, context), { asciiOnly: true }),
    context
  );
  return boundAltered(value, asciiMasked, maxCodePoints);
}

/**
 * The display form of a LOG-TWIN leaf — the second render route, named for
 * the same reason as {@link displayMasked} and closed by the same scanner.
 *
 * `logTextOfLeaf` resolves a value to its registered twin (or `SECRET_MASK`),
 * which is a MASKING answer and, like `maskSecretsRaw`'s, says nothing
 * about control characters. Four `origin` builders interpolated it raw — the
 * `Fn::ImportValue` pair, the `Fn::GetStackOutput` one and the nested-stack
 * attribute one — and those strings flow into `redactedAttributeReads[].display`
 * and out through a `ProvisioningError` message.
 *
 * This route is why fixing the secret masker alone did not close the class:
 * `displayMasked` covers every site that renders a needle-masked value, and
 * these render something else. Two routes, two names, one checker refusing
 * the raw form of both.
 *
 * Composed rather than re-derived. `maskSecretsInText` is idempotent (see
 * {@link maskThenStripThenMask}), so masking twin text again costs nothing
 * and cannot change the twin — which keeps this a STRICT addition of the
 * strip and the `displaySafe` pass, with the twin resolution untouched.
 */
/** @internal */
export function displayLeaf(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): string {
  return this.displayMasked(this.logTextOfLeaf(value, context), context);
}
