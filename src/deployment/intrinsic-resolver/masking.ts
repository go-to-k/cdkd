import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { displaySafe } from '../../utils/display-safe.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { UNSHOWABLE_VALUE } from '../../utils/pasteable-command.js';
import { stripControlChars } from '../../utils/regexp.js';
import {
  type AbandonedResolution,
  LOG_TWINS_BY_PASS,
  type LogTwin,
  NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX,
  type ResolverContext,
  boundAltered,
  carriesDynamicReference,
  carriesFetchableDynamicReference,
  isLogInert,
  isLogInertJson,
} from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
  SECRET_MASK,
  hasLogOnlyValues,
  hasMaskableValues,
  intrinsicLeafResolutionOf,
  maskRecordedSecretsInText,
  maskSecretsInText,
  recordIntrinsicLeafResolution,
  unionOfSecretBags,
} from '../secret-redaction.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    maskSecretsRaw: OmitThisParameter<typeof maskSecretsRaw>;
    /** @internal */
    abandonedUnit: OmitThisParameter<typeof abandonedUnit>;
    /** @internal */
    maskNeedlesForLog: OmitThisParameter<typeof maskNeedlesForLog>;
    /** @internal */
    hasLogOnlyNeedles: OmitThisParameter<typeof hasLogOnlyNeedles>;
    /** @internal */
    maskPrintedNeedlesForLog: OmitThisParameter<typeof maskPrintedNeedlesForLog>;
    /** @internal */
    maskRenderedNeedlesForLog: OmitThisParameter<typeof maskRenderedNeedlesForLog>;
    /** @internal */
    maskNeedlesOfBags: OmitThisParameter<typeof maskNeedlesOfBags>;
    /** @internal */
    isRecordedSecretForLog: OmitThisParameter<typeof isRecordedSecretForLog>;
    /** @internal */
    logTwinText: OmitThisParameter<typeof logTwinText>;
    /** @internal */
    splitLogTwins: OmitThisParameter<typeof splitLogTwins>;
    /** @internal */
    productLogTwin: OmitThisParameter<typeof productLogTwin>;
    /** @internal */
    logTextOfLeaf: OmitThisParameter<typeof logTextOfLeaf>;
    /** @internal */
    outputNameLogText: OmitThisParameter<typeof outputNameLogText>;
    /** @internal */
    regionLogText: OmitThisParameter<typeof regionLogText>;
    /** @internal */
    tokenAssembledFromSecret: OmitThisParameter<typeof tokenAssembledFromSecret>;
    /** @internal */
    tokenAssembledForRecording: OmitThisParameter<typeof tokenAssembledForRecording>;
    /** @internal */
    refuseSecretAssembledReference: OmitThisParameter<typeof refuseSecretAssembledReference>;
    /** @internal */
    straddleSafeTwin: OmitThisParameter<typeof straddleSafeTwin>;
    /** @internal */
    dynamicReferenceNameLogText: OmitThisParameter<typeof dynamicReferenceNameLogText>;
    /** @internal */
    logTwinBag: OmitThisParameter<typeof logTwinBag>;
    /** @internal */
    registeredLogTwin: OmitThisParameter<typeof registeredLogTwin>;
    /** @internal */
    logTwinOfProduct: OmitThisParameter<typeof logTwinOfProduct>;
    /** @internal */
    recordLeafResolution: OmitThisParameter<typeof recordLeafResolution>;
    /** @internal */
    nestedPartResolution: OmitThisParameter<typeof nestedPartResolution>;
    /** @internal */
    rememberLogTwin: OmitThisParameter<typeof rememberLogTwin>;
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
 * Resolve CloudFormation Dynamic References in a string value
 *
 * Supports:
 * - {{resolve:secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID}}
 * - {{resolve:ssm:PARAMETER_NAME}}
 *
 * Results are cached to avoid repeated API calls.
 */
/**
 * The SECRET answer alone: mask any resolved secret value out of `text`,
 * using the secrets recorded on the resolution pass (GHSA fix). No-op when
 * the pass recorded no secrets.
 *
 * ## NOT a display form, and the name says so
 *
 * This was `maskSecretsForLog` until go-to-k/cdkd#3426, and the name was the
 * defect. It answers "does this text contain a recorded secret" and makes no
 * claim about CONTROL CHARACTERS — but it read as "the spelling a log line
 * takes", so TEN local bindings took its result and interpolated it later,
 * one of them reaching an `Fn::ImportValue` warn and throw with a live
 * `ESC[2K` + CR from a template-supplied export name (measured on this tree,
 * at DEFAULT verbosity, on the DEFAULT path). Renaming it is what makes the
 * hazard visible at the BINDING rather than at the render: `const x =
 * this.maskSecretsRaw(...)` states that more work is owed.
 *
 * Reachable from ONE place, {@link maskThenStripThenMask}, which is itself
 * reachable only from {@link displayMasked}. That containment is the whole
 * mechanism. It used to be enforced by an AST walk that resolved an
 * interpolated identifier to its declaration; go-to-k/cdkd#3435 deleted that
 * checker, and what holds the containment now is
 * `tests/unit/deployment/resolver-display-masked-population.test.ts`, which
 * asserts the exact reference COUNTS from the AST (one caller each) and
 * refuses a direct `${this.<raw masker>(...)}` interpolation by line rule.
 * Do not call this from a new site: a binding of it interpolated LATER is
 * the shape neither survivor can see.
 *
 * ## What the masking itself does
 *
 * A value with a registered LOG TWIN prints as its twin first (issue
 * [#3150](https://github.com/go-to-k/cdkd/issues/3150)). The needle mask
 * matches a secret under {@link MIN_NEEDLE_LENGTH} only as the whole text,
 * so a name an `Fn::Sub` assembled around a 1-3 character secret (a map key,
 * a stack or output name, an attribute name, the secret id of a dynamic
 * reference) printed in the clear at every site that handed its RAW value
 * here, although the pass had registered where the secret sits. Looking the
 * twin up HERE, rather than at each such site, is what makes the class
 * closed for raw values: every one of those sites already reaches this
 * method through the builder.
 * The twin prints as it is: it is the raw text with masked spans, so it
 * holds no recorded needle the raw text lacks. When the needle mask ALSO
 * changes the raw text the whole text is masked instead, the rule
 * `logTwinText` applies to a Join / Sub line, since the two masks' spans
 * cannot be merged. What this cannot see is a value TRANSFORMED before it
 * arrives (a lowercased region, a sliced output name, an assembled
 * sentence); those sites derive their text from the twin themselves.
 *
 * ## The SELF-COMPARISON, and why it did not block the strip
 *
 * The line below compares `maskNeedlesForLog(text) !== text` — the NEEDLE
 * mask, not this method's own result — so making the RENDER path strip
 * changes no comparison anywhere. An earlier revision of `displayMasked`'s
 * comment said stripping could not move inside "the masker" because its
 * result is also a comparison; that was a claim about this expression, and
 * the expression's operand is a different function. The measurement that
 * settled it: every one of this method's 20 escaping call sites rendered
 * into a log line, a throw, or a `display:` field that becomes one — none
 * compared, persisted or re-parsed the result — so the render path could
 * take the strip whole.
 */
export function maskSecretsRaw(
  this: IntrinsicFunctionResolver,
  text: string,
  context?: ResolverContext
): string {
  const registered = this.registeredLogTwin(text, context);
  const needled = this.maskNeedlesForLog(text, context);
  // go-to-k/cdkd#1998: the LOG-ONLY needles join here, at the render, and
  // nowhere upstream of it. When they change nothing this is the recorded
  // answer byte for byte. When they do and no twin is registered, the
  // printing mask is the answer; with a twin, its spans cannot be merged
  // with the log-only ones, so the whole text is masked — the rule the two
  // lines below already apply to the recorded needles.
  if (this.hasLogOnlyNeedles(context) || hasMaskableValues(context?.printingSecrets)) {
    const printed = this.maskRenderedNeedlesForLog(text, context);
    if (printed !== needled) return registered === undefined ? printed : SECRET_MASK;
  }
  if (registered === undefined) return needled;
  return needled !== text ? SECRET_MASK : registered;
}

/**
 * Build one {@link AbandonedResolution}, masking BOTH of its text fields.
 *
 * One constructor for both walks so neither can grow a second masking rule:
 * `subject` and `message` are the only fields a consumer may render, and each
 * carries its own route to a plaintext — an assembled reference puts one in
 * the raw token (issue #2827), and an SDK rejection echoes the `Name` it was
 * handed — which `sendWithThrottleRetry` now masks by position before it
 * rethrows (go-to-k/cdkd#3171), so this is the second layer on that route.
 * `error` is not re-masked here and is documented as classification-only.
 */
/** @internal */
export function abandonedUnit(
  this: IntrinsicFunctionResolver,
  unit: AbandonedResolution['unit'],
  subject: string,
  error: unknown,
  context: ResolverContext | undefined,
  rawInput: unknown,
  /**
   * Applied to {@link AbandonedResolution.message} BEFORE the needle mask.
   *
   * `subject` is twin-derived, so it is safe at any length. `message` is not:
   * it comes from the thrown error, which for an SDK rejection echoes the
   * NAME it was handed, and the needle mask alone has a `MIN_NEEDLE_LENGTH`
   * floor. Measured: an assembled reference whose variable resolves to a
   * SUB-FLOOR secret came back as `Parameter /deleted/pw1 not found.` in the
   * clear, out of the field this interface documents as masked. The token
   * loop passes a redactor that maps each raw reference segment through
   * `nameLogText`, which is twin-derived and therefore floor-free.
   */
  preRedact?: (text: string) => string
): AbandonedResolution {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    unit,
    subject: this.displayMasked(subject, context),
    message: this.displayMasked(preRedact === undefined ? raw : preRedact(raw), context),
    error,
    carriedDynamicReference: carriesDynamicReference(rawInput),
    carriedFetchableReference: carriesFetchableDynamicReference(rawInput),
  };
}

/**
 * The needle mask alone: {@link maskSecretsRaw} without the log-twin
 * lookup. For the two DETECTORS that must ask the needle mask apart from the
 * position mask: `logTwinText`, which asks it of a value that already has a
 * twin, and `resolveBase64`, whose other operand is the position mask. A
 * message masks through `displayMasked`.
 */
export function maskNeedlesForLog(
  this: IntrinsicFunctionResolver,
  text: string,
  context?: ResolverContext
): string {
  let masked = text;
  // BOTH BAGS, and the inherited one FIRST (issue #1903 review round 2). A
  // nested-stack CHILD engine is the only place `context.parameters` holds
  // DECRYPTED plaintext — the PARENT resolved the child's `Parameters` block
  // — and that plaintext is not in `recordedSecretValues` until some
  // resource's `{Ref: <Param>}` actually resolves and
  // `recordInheritedParameterSecrets` copies the pair across. Every log line
  // emitted BEFORE that moment (the two parameter lines, and any line the
  // child's own resolution reaches first) therefore had nothing to mask
  // against and printed the secret at `--verbose`.
  //
  // Masking against the inherited bag is never a widening: its keys are pairs
  // the parent PROVED secret, so anything it masks is a value that must not
  // be echoed regardless of which resource is being resolved.
  //
  // The RECORDED needles only (go-to-k/cdkd#1998): this answer is also a
  // DETECTOR — `resolveBase64` records what it persists from it, the
  // unsupported-service arm refuses on it, and the log-twin machinery that
  // `Fn::Base64` reads is built from it — so a log-only needle must not move
  // it. The render adds the log-only needles in {@link maskSecretsRaw}.
  //
  // ONE pass over both bags' entries (go-to-k/cdkd#4049): masked bag by bag,
  // the inherited bag's shorter needle cut a longer needle the pass bag held
  // and the rest of it printed. Whether the text CHANGES is the same either
  // way, so the detectors reading this answer are unaffected.
  const union: RecordedSecretValues = new Map([
    ...(context?.inheritedSecrets ?? []),
    ...(context?.recordedSecretValues ?? []),
  ]);
  if (union.size > 0) masked = maskRecordedSecretsInText(masked, union);
  return masked;
}

/**
 * Does either bag hold a LOG-ONLY needle (go-to-k/cdkd#1998)? The cheap
 * test that lets a print skip {@link maskPrintedNeedlesForLog} in the
 * common case, where there is none.
 */
export function hasLogOnlyNeedles(
  this: IntrinsicFunctionResolver,
  context?: ResolverContext
): boolean {
  return (
    hasLogOnlyValues(context?.inheritedSecrets) || hasLogOnlyValues(context?.recordedSecretValues)
  );
}

/**
 * The PRINTING mask: {@link maskNeedlesForLog} plus the pass's LOG-ONLY
 * needles (go-to-k/cdkd#1998), both bags in the same order, each in ONE
 * regex so a longer needle of either class wins over a shorter one it
 * overlaps. Never a detector: see {@link maskNeedlesForLog}.
 */
export function maskPrintedNeedlesForLog(
  this: IntrinsicFunctionResolver,
  text: string,
  context?: ResolverContext
): string {
  return this.maskNeedlesOfBags(text, context);
}

/**
 * {@link maskPrintedNeedlesForLog} plus {@link ResolverContext.printingSecrets}:
 * the RENDER mask only (go-to-k/cdkd#4043), never a detector.
 */
export function maskRenderedNeedlesForLog(
  this: IntrinsicFunctionResolver,
  text: string,
  context?: ResolverContext
): string {
  return this.maskNeedlesOfBags(text, context, context?.printingSecrets);
}

export function maskNeedlesOfBags(
  this: IntrinsicFunctionResolver,
  text: string,
  context?: ResolverContext,
  printing?: RecordedSecretValues
): string {
  // ONE pass over both bags (go-to-k/cdkd#4049), as {@link maskNeedlesForLog}.
  const union = unionOfSecretBags([
    context?.inheritedSecrets,
    context?.recordedSecretValues,
    printing,
  ]);
  return hasMaskableValues(union) ? maskSecretsInText(text, union) : text;
}

/**
 * Is `value` WHOLE a secret either bag holds (issue #3100)? Asked of a
 * resolution PRODUCT only — never of a template literal — so an exact match
 * at any length is a verdict about what was written, not a floorless needle.
 */
export function isRecordedSecretForLog(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): boolean {
  // No `''` guard: no writer records an empty plaintext (every recording
  // site requires a truthy value), so `has('')` already answers false.
  return (
    context?.recordedSecretValues?.has(value) === true ||
    context?.inheritedSecrets?.has(value) === true
  );
}

/**
 * The text a `Resolved Fn::Join:` / `Resolved Fn::Sub:` line prints (issue
 * #3100): the twin through the needle mask — unless the needle mask ALSO
 * fires on the value itself, in which case the whole line is masked. The
 * twin splits the text at the spans it masked, so a 4+ character recorded
 * secret that overlaps one of them (or IS the whole value) is no longer a
 * contiguous needle in the twin, and masking the twin alone would print the
 * part of it outside the span. The value's own needle mask cannot be merged
 * with the twin's positions, so the line gives both up for `***`: never
 * more text than either mask alone would print. Returns the text BEFORE the
 * needle mask; each log line wraps it in `displayMasked` itself, so the
 * sanitization happens at the render rather than here.
 */
export function logTwinText(
  this: IntrinsicFunctionResolver,
  result: string,
  twin: string,
  context?: ResolverContext
): string {
  const bothMasksFire = twin !== result && this.maskNeedlesForLog(result, context) !== result;
  return bothMasksFire ? SECRET_MASK : twin;
}

/**
 * The log twins of `Fn::Split`'s pieces (issue #3100), each registered for
 * the pass so an outer `Fn::Join` over the pieces keeps the mask. A source
 * that is itself a recorded or inherited secret counts as a twin of `***`;
 * a source with neither is its pieces' own twin.
 *
 * The source's twin is split by the same delimiter. When both splits give
 * the same number of pieces they are paired by position; when they do not —
 * a secret carrying the delimiter, or a delimiter that occurs in the mask
 * itself — no pairing can be trusted, so every piece is masked whole. Every
 * masked piece is registered by VALUE, so an equal string elsewhere in the
 * pass is masked too: the over-masking direction `logTwinOfProduct` accepts.
 */
export function splitLogTwins(
  this: IntrinsicFunctionResolver,
  value: string,
  delimiter: string,
  pieces: string[],
  context: ResolverContext
): string[] {
  // A source that IS a recorded or inherited secret is masked whole even
  // with no registered twin — a `Ref` to a parameter holding one is never
  // registered, since no substitution in this pass wrote it.
  const sourceTwin = this.isRecordedSecretForLog(value, context)
    ? SECRET_MASK
    : this.registeredLogTwin(value, context);
  if (sourceTwin === undefined) return pieces;
  const twinPieces = sourceTwin.split(delimiter);
  // A delimiter that occurs in the mask itself splits `***` into pieces that
  // can coincide in COUNT with the value's while pairing nothing, so the
  // count test alone is not enough.
  const aligned = twinPieces.length === pieces.length && !SECRET_MASK.includes(delimiter);
  return pieces.map((piece, index) => {
    // Through `logTwinText`, like the Join / Sub lines: a piece's twin can
    // split a 4+ character secret the piece still holds whole.
    const twin = this.logTwinText(
      piece,
      aligned ? (twinPieces[index] ?? SECRET_MASK) : SECRET_MASK,
      context
    );
    this.rememberLogTwin(context, piece, twin);
    return twin;
  });
}

/**
 * The log twin of a resolution product as `String(value)` renders it (issue
 * #3100). A LIST is stringified element by element exactly as
 * `Array.prototype.join` does (`null` / `undefined` as the empty string,
 * nested lists recursively, comma-separated), so each element keeps its own
 * twin: `String()` over the whole list produced a string no registered twin
 * matched. No cycle guard: a product is JSON-sourced state or a fresh
 * resolution result, and neither can hold a self-referencing list.
 */
export function productLogTwin(
  this: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): string {
  if (Array.isArray(value)) {
    return value
      .map((element: unknown) =>
        element === null || element === undefined ? '' : this.productLogTwin(element, context)
      )
      .join(',');
  }
  const text = String(value);
  return this.logTwinOfProduct({ result: text, twin: text }, context).twin;
}

/**
 * The pre-mask log text of a string LEAF a debug line prints (issue #3100):
 * the leaf treated as a resolution product — masked whole when it is a
 * recorded secret, otherwise the masked twin this pass registered for it —
 * and then `logTwinText`'s whole-line guard. The caller still wraps the
 * result in `displayMasked`. Used where the text is needed BEFORE that
 * masker, or apart from it: the `Fn::Base64` line and its detector, and the
 * names issue [#3150](https://github.com/go-to-k/cdkd/issues/3150)
 * transforms or composes before printing (`regionLogText`,
 * `outputNameLogText`, the invalid-region refusals, the cross-stack `origin`
 * strings). A leaf printed as it is needs none of it: `displayMasked`
 * looks the twin up itself, which is how `maskValueLeaves` gives its lines
 * and the THROWN messages it masks (the `Fn::Cidr` argument refusals, for
 * one) the same position mask.
 */
/** @internal */
export function logTextOfLeaf(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): string {
  return this.logTwinText(
    value,
    this.logTwinOfProduct({ result: value, twin: value }, context).twin,
    context
  );
}

/**
 * The log text of a nested stack's OUTPUT name, the part of `attributeName`
 * after `Outputs.` (issue [#3150](https://github.com/go-to-k/cdkd/issues/3150)).
 * The twin registry is keyed by the exact string, so the suffix has no twin
 * of its own: it is sliced from the twin of the WHOLE attribute name. A twin
 * that no longer starts with the literal prefix has a mask over part of it
 * (a secret was written into the prefix), so the slice offset no longer
 * lines up and the suffix prints as `***`.
 */
/** @internal */
export function outputNameLogText(
  this: IntrinsicFunctionResolver,
  attributeName: string,
  context?: ResolverContext
): string {
  const twin = this.logTextOfLeaf(attributeName, context);
  return twin.startsWith(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX)
    ? twin.slice(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX.length)
    : SECRET_MASK;
}

/**
 * The log text of a template-supplied REGION as the resolver uses it, i.e.
 * after `canonicalizeRegion` (issue #3150). The twin is taken from the RAW
 * value, the string a write registered, and lowercased the same way: a
 * lookup of the canonical form finds no twin once the raw value had an
 * upper-case part, and lowercasing leaves every `***` span where it was.
 */
/** @internal */
export function regionLogText(
  this: IntrinsicFunctionResolver,
  rawRegion: string,
  context?: ResolverContext
): string {
  const canonical = canonicalizeRegion(rawRegion);
  const text = canonicalizeRegion(this.logTextOfLeaf(rawRegion, context));
  // Lowercasing can FORM a recorded needle the raw value's case hid, and it
  // may overlap a masked span, where masking the twin cannot see it: the
  // whole region is masked then, the rule `logTwinText` applies.
  return text !== canonical && this.maskNeedlesForLog(canonical, context) !== canonical
    ? SECRET_MASK
    : text;
}

/**
 * Whether the dynamic-reference token `fullMatch` was ASSEMBLED from a
 * secret (issue #2743): its log text differs from the token, so a
 * twin mask sits inside it (floor-free, which is how a substituted secret of
 * any length shows), or the needle mask changes the raw token (a recorded
 * plaintext of four or more characters sits in it with no twin, which is
 * how a `Ref` to a parameter a parent decrypted shows). A sub-floor secret
 * that merely coincides with the token's literal text trips neither.
 */
/** @internal */
export function tokenAssembledFromSecret(
  this: IntrinsicFunctionResolver,
  fullMatch: string,
  tokenLogText: string,
  context: ResolverContext | undefined
): boolean {
  return tokenLogText !== fullMatch || this.maskNeedlesForLog(fullMatch, context) !== fullMatch;
}

/**
 * The issue #4166 variant of {@link tokenAssembledFromSecret}: the twin half
 * as is, the needle half against `inheritedSecrets` ONLY. That half exists
 * for a `Ref` to a parameter a parent decrypted, which leaves no twin mask;
 * a secret substituted within this pass leaves one. The pass's own bag is
 * left out because it holds every secret this resource already resolved,
 * and one that merely coincides with a LITERAL token's text (`DB_USER`'s
 * `myapp` inside `DB_PASSWORD`'s secret id) discloses nothing, so refusing
 * on it would fail a template by property order alone.
 */
/** @internal */
export function tokenAssembledForRecording(
  this: IntrinsicFunctionResolver,
  fullMatch: string,
  tokenLogText: string,
  context: ResolverContext | undefined
): boolean {
  if (tokenLogText !== fullMatch) return true;
  const inherited = context?.inheritedSecrets;
  return (
    inherited !== undefined &&
    inherited.size > 0 &&
    maskRecordedSecretsInText(fullMatch, inherited) !== fullMatch
  );
}

/**
 * Refuse a SECRET result of a resolvable token ASSEMBLED from a secret
 * (issue #4166): `{{resolve:ssm:/app/${Name}}}` with `Name` a secret, where
 * `/app/<Name>` is a `SecureString`. Recording that result would make the
 * assembled token the expression of its plaintext, and every state writer
 * (the frame, skeleton, whole-value and substring arms) then puts that
 * expression, with the other secret inside it, into `state.json`. A writer
 * that refused the expression would leave the token's plaintext in the
 * clear instead, so the refusal belongs here, before anything is recorded
 * or cached.
 *
 * "Assembled" is {@link tokenAssembledForRecording}: a twin mask in the
 * token, or a secret a parent passed in. A secret this pass resolved that
 * merely coincides with a literal token's text is not counted.
 *
 * Called once the token is known to resolve to a secret: before the lookup
 * for `secretsmanager` / `ssm-secure`, secret by spelling (issue #4266), and
 * after it for `ssm`, whose failed lookup keeps its own masked error and
 * whose public result records no expression.
 * The caller exempts persisted text (`cdkd drift`, the rollback replay), as
 * the unsupported-service arm does (issue #2743).
 */
/** @internal */
export function refuseSecretAssembledReference(
  this: IntrinsicFunctionResolver,
  fullMatch: string,
  tokenLogText: string,
  context: ResolverContext | undefined
): void {
  if (!this.tokenAssembledForRecording(fullMatch, tokenLogText, context)) return;
  throw markNonRetryable(
    new IntrinsicResolutionRefusalError(
      `Refusing to resolve ${this.displayMasked(tokenLogText, context)}: the reference was ` +
        `assembled from a secret value and resolves to a secret, so recording it would write ` +
        `that value into state inside the reference. Build the reference name from non-secret values.`
    )
  );
}

/**
 * The log text of a name or token whose `twin` masks spans of `raw` (issue
 * [#3150](https://github.com/go-to-k/cdkd/issues/3150)). The twin prints
 * unless the needle mask ALSO changes `raw`; then the two must agree. When
 * the needle-masked `raw` IS the twin, both masked the same spans and the
 * twin is safe (`/probe/***` for a 4+ character secret the name holds
 * whole). When they differ, a recorded secret straddles a masked span
 * (`q7ab` across `id-***ab`), no text can honour both, and the name prints
 * as `***`. Coarser `logTwinText` gives up whenever both masks fire.
 */
/** @internal */
export function straddleSafeTwin(
  this: IntrinsicFunctionResolver,
  raw: string,
  twin: string,
  context?: ResolverContext
): string {
  if (twin === raw) return twin;
  const needled = this.maskNeedlesForLog(raw, context);
  if (needled === raw) return twin;
  return needled === twin ? twin : SECRET_MASK;
}

/**
 * The log text of a name parsed out of a dynamic-reference token (issue
 * [#3150](https://github.com/go-to-k/cdkd/issues/3150)). `resolveSub` /
 * `resolveJoin` re-enter the dynamic-reference loop with the ASSEMBLED string
 * and its twin, so a secret id, JSON key, version stage or id, SSM parameter
 * name, service or ARN region assembled around a short secret has its masked
 * spelling in `tokenTwin` only. Every such name is a run of the token's
 * `:`-separated pieces, so its log text is the twin's run over the same
 * pieces. Nothing is registered: the pass's log-twin registry also decides
 * what `Fn::Base64` persists, so the mapping lives in the returned function.
 *
 * `tokenTwin` is the twin's own `{{resolve:...}}` token paired with this one.
 * Each run's text goes through `straddleSafeTwin`, so a name whose needle
 * mask disagrees with its twin prints as `***`. A name whose runs carry different
 * twins, or a token whose pieces do not pair with the twin's (a mask
 * covering a `:`), prints as `***` too.
 *
 * A name that is no run of the token is a default the caller synthesized
 * (`AWSCURRENT` for an empty version stage, `''` for an absent version id),
 * printed as it is. Should the token spell such a non-empty name inside a longer
 * piece, it prints as `***`: the run rule says nothing about that text.
 */
/** @internal */
export function dynamicReferenceNameLogText(
  this: IntrinsicFunctionResolver,
  inner: string,
  tokenTwin: string,
  context?: ResolverContext
): (name: string) => string {
  const twinPieces = tokenTwin.slice('{{resolve:'.length, -'}}'.length).split(':');
  const pieces = inner.split(':');
  if (twinPieces.length !== pieces.length) return () => SECRET_MASK;
  return (name) => {
    let text: string | undefined;
    for (let start = 0; start < pieces.length; start++) {
      for (let end = start + 1; end <= pieces.length; end++) {
        if (pieces.slice(start, end).join(':') !== name) continue;
        // Through `straddleSafeTwin`: a 4+ character recorded secret that
        // overlaps a masked span is split in the twin, and only the raw
        // name's needle mask can still see it.
        const twin = this.straddleSafeTwin(name, twinPieces.slice(start, end).join(':'), context);
        if (text !== undefined && text !== twin) return SECRET_MASK;
        text = twin;
        // A longer run from the same start is a longer string.
        break;
      }
    }
    return text ?? (name !== '' && inner.includes(name) ? SECRET_MASK : name);
  };
}

/** The bag a pass's log twins are keyed by (issue #3100): the recorded one, else the inherited one. */
export function logTwinBag(
  this: IntrinsicFunctionResolver,
  context?: ResolverContext
): RecordedSecretValues | undefined {
  return context?.recordedSecretValues ?? context?.inheritedSecrets;
}

/**
 * The masked twin registered for `value`, looked up under the pass's OWN bag
 * and under the INHERITED one (issue
 * [#3114](https://github.com/go-to-k/cdkd/issues/3114)). A nested-stack
 * child receives, as `inheritedSecrets`, the very object its parent resolved
 * the `AWS::CloudFormation::Stack` resource with: the deploy engine binds the
 * resource context's `recordedSecretValues` as the resource's secrets, and
 * `NestedStackProvider` hands that binding to the child. So a parameter value
 * the parent built around a short secret (`port:q7` -> `port:***`) is
 * registered under the child's inherited bag, while the child registers its
 * own writes under its own bag. Two DIFFERENT registered twins mask the
 * whole string, the rule `rememberLogTwin` applies within one bag. Lookups
 * only: `rememberLogTwin` still registers under `logTwinBag`, the context's
 * own `recordedSecretValues` whenever it carries one (every context
 * `buildResolverContext` returns does; the log-only context
 * `resolveParameters` builds carries none, and nothing on that path
 * registers), so such a child never writes into its parent's registry. A
 * context with ONLY an inherited bag registers into that bag, as it did
 * before this lookup existed.
 *
 * ONE LEVEL ONLY. The bag a child hands its own nested stack is the child's
 * OWN resource bag, so no twin registered ABOVE the child is reachable from a
 * grandchild. Where the middle stack passes the value THROUGH
 * (`{ Ref: Param }` straight into the grandchild's `Parameters`) nothing ever
 * registers a twin in that bag, so the grandchild prints the value whether or
 * not the bag holds pairs. Where the middle RE-WRAPS it (an `Fn::Join` around
 * the `Ref`) the middle registers its own twin, and the hand-off still drops
 * a bag holding no pairs (it passes `inheritedSecrets` only when `size` is
 * nonzero). What reaches a grandchild instead is the parent's WHOLE-VALUE
 * entry: the middle's `{ Ref }` copies it into the middle's bag, which is then
 * non-empty and handed down. Issue #3156 made the carry record that entry for
 * the intrinsic frames it used to refuse; a frame it still refuses (listed on
 * `recordNestedStackParameterExpressions`) keeps both gaps.
 *
 * The registry is keyed by VALUE, and `splitLogTwins`' unaligned arm
 * registers every piece, public ones included. So a child `Fn::Base64` over a
 * string exactly equal to such a piece of its parent's persists `***` for a
 * non-secret property, the over-masking hazard issue #3119 already accepts
 * within one pass, now reachable across the parent / child boundary.
 */
export function registeredLogTwin(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): string | undefined {
  const own = context?.recordedSecretValues
    ? LOG_TWINS_BY_PASS.get(context.recordedSecretValues)?.get(value)
    : undefined;
  const inherited = context?.inheritedSecrets
    ? LOG_TWINS_BY_PASS.get(context.inheritedSecrets)?.get(value)
    : undefined;
  if (own === undefined) return inherited;
  return inherited === undefined || inherited === own ? own : SECRET_MASK;
}

/**
 * The log twin of a RESOLUTION PRODUCT — an intrinsic part, variable or
 * placeholder — for issue #3100. Masked whole when its value is a recorded
 * secret. Otherwise a part that carries no mask of its own takes the masked
 * twin an earlier write of this pass registered for that exact string
 * (`rememberLogTwin`) — how a Join part that is itself an `Fn::Sub`, or a
 * `Fn::Select` over a reference-bearing string, keeps the inner mask. A part
 * whose OWN masked twin disagrees with the registered one (a list element
 * still spelling a reference) is masked whole, since the two span sets
 * cannot be merged; one that agrees keeps its twin.
 *
 * The registry is keyed by VALUE, so a product equal to a registered string
 * from another provenance takes its mask too. That over-masks a line whose
 * text holds a recorded secret at a position some write in this pass put
 * one. The registry holds masked twins only, so a lookup never unmasks.
 *
 * The whole-secret check reads the bags as they stand when the product is
 * placed, before the enclosing Join / Sub runs its final substitution. A
 * secret that substitution records is therefore not matched against an
 * earlier product equal to it. Such a product did not come from that secret:
 * a parameter holding one arrives in the inherited bag before its `Ref`
 * resolves, so what stays printed is a public value that coincides with it.
 */
export function logTwinOfProduct(
  this: IntrinsicFunctionResolver,
  part: LogTwin,
  context?: ResolverContext
): LogTwin {
  if (this.isRecordedSecretForLog(part.result, context)) {
    return { result: part.result, twin: SECRET_MASK };
  }
  const registered = this.registeredLogTwin(part.result, context);
  if (registered === undefined || registered === part.twin) return part;
  return { result: part.result, twin: part.twin === part.result ? registered : SECRET_MASK };
}

/**
 * Record the `Fn::Join` / `Fn::Sub` / `Fn::If` object `source`'s own
 * resolution under the pass bag the nested-stack carry reads (issues
 * [#3156](https://github.com/go-to-k/cdkd/issues/3156),
 * [#3306](https://github.com/go-to-k/cdkd/issues/3306)). The key is the
 * object `resolveValue` dispatched on, and a context with no bag has no pass
 * to scope it to.
 */
export function recordLeafResolution(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  source: object,
  resolution: IntrinsicLeafResolution
): void {
  if (context.recordedSecretValues === undefined) return;
  recordIntrinsicLeafResolution(context.recordedSecretValues, source, resolution);
}

/**
 * What a NESTED intrinsic part contributes to its outer object's record
 * (issue [#3306](https://github.com/go-to-k/cdkd/issues/3306)): the part's
 * own record when this pass kept one for that object, so a token the part
 * spelled reaches the outer `input` raw with
 * the replacement that resolved it. Any other part contributes its resolved
 * text and no replacement, as before. A record the pass kept describes THIS
 * resolution: the part was just resolved into the same bag, and a
 * resolution that differs from an earlier one poisons the record, which
 * reads as none. `complete` is lent with the rest, though for every record
 * the resolver writes a token the part left unreplaced also stays in its
 * `input`, a second span the carry refuses on its own, so no case pins it.
 */
export function nestedPartResolution(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  part: unknown,
  resolved: string
): Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'> {
  const own =
    context.recordedSecretValues !== undefined && typeof part === 'object' && part !== null
      ? intrinsicLeafResolutionOf(context.recordedSecretValues, part)
      : undefined;
  if (own === undefined) return { input: resolved, substitutions: [], complete: true };
  return { input: own.input, substitutions: own.substitutions, complete: own.complete };
}

/**
 * Register a MASKED `twin` as the log twin of `result` for this pass (issue
 * #3100). An unmasked twin is not registered, so a later literal that
 * resolves to the same string cannot replace an earlier write's mask, and
 * two DIFFERENT masked twins for one string register `***` for the whole
 * string, since their spans cannot be merged. Scoped to the pass's bag
 * through a `WeakMap`, like the cross-stack associations, so it dies with
 * the bag. An unrelated pass cannot reach these strings; a nested child
 * whose `inheritedSecrets` is this bag reads them (`registeredLogTwin`).
 */
/** @internal */
export function rememberLogTwin(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  result: string,
  twin: string
): void {
  if (twin === result) return;
  const bag = this.logTwinBag(context);
  if (!bag) return;
  let twins = LOG_TWINS_BY_PASS.get(bag);
  if (!twins) {
    twins = new Map<string, string>();
    LOG_TWINS_BY_PASS.set(bag, twins);
  }
  const existing = twins.get(result);
  twins.set(result, existing === undefined || existing === twin ? twin : SECRET_MASK);
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
 * `outputs-export-alias.ts`'s `canonicalForSecretScan` problem and is not
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
