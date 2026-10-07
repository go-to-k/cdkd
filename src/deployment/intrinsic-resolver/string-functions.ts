import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import {
  type LogTwin,
  type ResolverContext,
  allSettledKeepingFirstRejection,
  quotedRender,
  selectIndexPosition,
} from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  type DynamicReferenceSubstitution,
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
  intrinsicLeafResolutionOf,
  SECRET_MASK,
  carryLogOnlyValues,
  crossStackSourceKey,
  hasLogOnlyValues,
  recordLogOnlySplitFragments,
} from '../secret-redaction.js';

export type ParameterSpans = NonNullable<IntrinsicLeafResolution['parameterSpans']>;

/**
 * The reference spans `part`'s own record places on `resolved`, the string it
 * contributed to an enclosing `Fn::Join` / `Fn::Sub` (issues #4446, #4527):
 * the record a `{Ref}` answered by a parameter, a cross-stack read (an
 * `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt` object), or a
 * nested `Fn::Join` / `Fn::Sub` / `Fn::If`, wrote for that object in this
 * pass. `[]` whenever it places
 * none it can vouch for -- no record (a poisoned one reads as none), a record
 * without spans (a string-selected `Fn::If`, a part its own dynamic-reference
 * pass rewrote), or one of another output -- so the part's text is a GAP the
 * persist side keeps only where the value scan leaves it alone on its own
 * (issue #4469).
 */
export function partParameterSpans(
  context: ResolverContext,
  part: unknown,
  resolved: string
): ParameterSpans {
  if (context.recordedSecretValues === undefined) return [];
  if (typeof part !== 'object' || part === null) return [];
  const own = intrinsicLeafResolutionOf(context.recordedSecretValues, part);
  // `output !== resolved`: no test discriminates it, since a part is
  // re-recorded by its own resolution and a differing one poisons it. It
  // keeps a record of ANOTHER output from ever lending offsets.
  if (own === undefined || own.output !== resolved) return [];
  return own.parameterSpans ?? [];
}

/**
 * The span a reference places when its WHOLE resolved value is `value`: one
 * span keyed by `crossStackSourceKey(source)`, the RAW intrinsic the resolver
 * answered (issues #4446, #4527). `source` is `{Ref: <Param>}` for a parameter
 * the parameter arm answered, or the cross-stack read itself (an
 * `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt` object, or a dotted
 * `${Res.Attr}` placeholder as `{'Fn::GetAtt': 'Res.Attr'}`, the spelling
 * `resolveSub` hands `resolveGetAtt`). `[]` for a value that is not a
 * non-empty string, or a source with no key. The span says only WHERE that
 * reference's text lies; whether it is a secret is the association store's
 * answer, read under the same key, so a span with no association (a
 * same-stack attribute, a public output) stays text on the persist side.
 */
export function wholeReferenceSpans(
  source: Record<string, unknown>,
  value: unknown
): ParameterSpans {
  if (typeof value !== 'string' || value === '') return [];
  const key = crossStackSourceKey(source);
  return key === undefined ? [] : [{ start: 0, length: value.length, key }];
}

/** `spans` moved `by` characters to the right, appended to `out`. */
export function appendShiftedSpans(
  out: ParameterSpans[number][],
  spans: ParameterSpans,
  by: number
): void {
  for (const span of spans) {
    out.push({ start: span.start + by, length: span.length, key: span.key });
  }
}

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    resolveJoin: OmitThisParameter<typeof resolveJoin>;
    /** @internal */
    resolveSelect: OmitThisParameter<typeof resolveSelect>;
    /** @internal */
    renderGetAttArg: OmitThisParameter<typeof renderGetAttArg>;
    /** @internal */
    describeOperandShape: OmitThisParameter<typeof describeOperandShape>;
    /** @internal */
    describeSplitValueSource: OmitThisParameter<typeof describeSplitValueSource>;
    /** @internal */
    resolveSplit: OmitThisParameter<typeof resolveSplit>;
  }
}

/**
 * Resolve Fn::Join intrinsic function
 *
 * Fn::Join: [delimiter, [value1, value2, ...]]
 */
export async function resolveJoin(
  this: IntrinsicFunctionResolver,
  joinArgs: [string, unknown],
  context: ResolverContext,
  source: object
): Promise<string> {
  const [delimiter, rawValues] = joinArgs;

  // The 2nd arg is normally a literal array, but CloudFormation also allows it
  // to be a SINGLE intrinsic that RETURNS a list (Fn::Cidr / Fn::GetAZs /
  // Fn::Split, or a Ref to a list-typed parameter -- any `List<...>` type
  // or `CommaDelimitedList`). In that case
  // resolve it first so it becomes an array before we map over it.
  let values: unknown = rawValues;
  if (!Array.isArray(values)) {
    values = await this.resolveValue(values, context);
  }

  if (!Array.isArray(values)) {
    throw markNonRetryable(
      new Error(
        `Fn::Join's second argument must be a list (an array literal or a list-returning intrinsic such as Fn::Cidr / Fn::GetAZs / Fn::Split / a Ref to a list-typed parameter — any List<...> type or CommaDelimitedList), but resolved to ${typeof values}`
      )
    );
  }

  // Resolve each value first, draining every part before a rejection
  // surfaces (issue #2563): a part that records a secret must finish
  // recording before a caller's `catch` / `finally` sees the failure.
  //
  // Each part carries its LOG TWIN (issue #3100, see `LogTwin`). A STRING
  // part is resolved here rather than through `resolveValue`, whose string
  // arm is exactly `resolveDynamicReferences` over a string holding a
  // `{{resolve:` opener and the string itself otherwise, so the value is
  // unchanged and the substitution's twin is kept. A part in a LITERAL list
  // that spells no reference keeps itself as its twin even when it equals a
  // recorded secret: a template literal is not a resolution product, and
  // masking it would be a needle mask with no floor. Every other part — an
  // intrinsic, or an element of a list an intrinsic returned — is a
  // resolution product, whose twin is decided only AFTER the drain: the
  // parts resolve concurrently, and a product checked as soon as it settled
  // would miss a secret a sibling part records later in the same Join.
  const literalList = Array.isArray(rawValues);
  // Each part also returns its `input` text and its own pass's evidence
  // (issue #3156), read only after the drain and in part order, so the
  // record does not depend on which part settled first.
  const resolvedParts = await allSettledKeepingFirstRejection(
    () =>
      values.map(
        async (
          v
        ): Promise<
          LogTwin & {
            readonly product: boolean;
            readonly raw?: { value: unknown };
            readonly input: string;
            readonly substitutions: readonly DynamicReferenceSubstitution[];
            readonly complete: boolean;
            readonly parameterSpans: ParameterSpans;
          }
        > => {
          if (typeof v === 'string') {
            // An element of a list an intrinsic returned can still spell a
            // reference after that intrinsic resolved it (a resolved value that
            // is itself reference text). Its second resolution starts from the
            // twin the first one registered, so the first stage's mask is kept
            // (issue #3114). A literal element's seed differs from its text only
            // when a product of this pass equals that text, or when the text is
            // itself a recorded secret (a token-shaped plaintext, issue #1917),
            // so for a literal the seed can only mask more.
            const part = v.includes('{{resolve:')
              ? await this.resolveDynamicReferencesWithLogTwin(
                  v,
                  this.logTwinOfProduct({ result: v, twin: v }, context).twin,
                  context
                )
              : { result: v, twin: v, substitutions: [], complete: true };
            return {
              result: part.result,
              twin: part.twin,
              product: !literalList,
              input: v,
              substitutions: part.substitutions,
              complete: part.complete,
              parameterSpans: [],
            };
          }
          const raw = await this.resolveValue(v, context);
          const resolved = String(raw);
          return {
            result: resolved,
            twin: resolved,
            product: true,
            raw: { value: raw },
            // Only a part the TEMPLATE spells: an element of a list an
            // intrinsic returned is a value, not a source object (issue #4446).
            // No test discriminates it, since no such value carries a record.
            parameterSpans: literalList ? partParameterSpans(context, v, resolved) : [],
            // A nested `Fn::Join` / `Fn::Sub` / `Fn::If` part lends its own
            // record (issue #3306).
            ...this.nestedPartResolution(context, v, resolved),
          };
        }
      ),
    (pending) => this.warnAbandonedParts(pending)
  );
  const parts = resolvedParts.map((part) => {
    if (!part.product) return part;
    // An intrinsic part is twinned from its RAW value, so a list keeps its
    // elements' twins through the stringification; a string element of a
    // list an intrinsic returned keeps its own twin rule.
    if (part.raw)
      return { result: part.result, twin: this.productLogTwin(part.raw.value, context) };
    return this.logTwinOfProduct(part, context);
  });

  let result = parts.map((part) => part.result).join(delimiter);
  let twin = parts.map((part) => part.twin).join(delimiter);
  const substitutions = resolvedParts.flatMap((part) => part.substitutions);
  let complete = resolvedParts.every((part) => part.complete);
  // Where each part's parameter values landed on the joined string (issue
  // #4446): each part's own spans, shifted by the text joined before it. A
  // part that cannot vouch for offsets INSIDE it (a string-selected `Fn::If`,
  // a nested part its own dynamic-reference pass rewrote) contributes no span
  // and is SKIPPED, its length still advancing the offset: its text is then a
  // GAP, which the persist side keeps only where the value scan leaves it
  // alone on its own (issue #4469).
  const parameterSpans: ParameterSpans[number][] = [];
  let offset = 0;
  for (const [index, part] of resolvedParts.entries()) {
    if (index > 0) offset += delimiter.length;
    appendShiftedSpans(parameterSpans, part.parameterSpans, offset);
    offset += part.result.length;
  }
  let spansValid = true;
  // Resolve any dynamic references in the joined result (secret refs are
  // left unresolved per-reference when skipDynamicReferences is set). The
  // CDK `secretValueFromJson` shape completes its token only HERE, so this
  // substitution is the write the twin most needs to see.
  if (result.includes('{{resolve:')) {
    const joined = await this.resolveDynamicReferencesWithLogTwin(result, twin, context);
    // The spans index the joined text; a pass that rewrote it moved them.
    if (joined.result !== result) spansValid = false;
    ({ result, twin } = joined);
    substitutions.push(...joined.substitutions);
    complete &&= joined.complete;
  }
  this.recordLeafResolution(context, source, {
    input: resolvedParts.map((part) => part.input).join(delimiter),
    output: result,
    substitutions,
    complete,
    ...(spansValid ? { parameterSpans } : {}),
  });
  this.rememberLogTwin(context, result, twin);
  this.logger.debug(
    `Resolved Fn::Join: ${this.logRender(this.logTwinText(result, twin, context), context)}`
  );
  return result;
}

/**
 * Resolve Fn::Select intrinsic function
 *
 * Fn::Select: [index, [value1, value2, ...]]
 * Returns the value at the specified index in the list. The index may be an
 * intrinsic; it is resolved, then must name a position (issue #3574).
 */
export async function resolveSelect(
  this: IntrinsicFunctionResolver,
  selectArgs: unknown,
  context: ResolverContext
): Promise<unknown> {
  if (!Array.isArray(selectArgs) || selectArgs.length !== 2) {
    // Destructuring anything else either throws a bare `TypeError` (an
    // object is not iterable) or, for a STRING operand, silently reads its
    // first two characters as the index and the list.
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Fn::Select takes a two-element list [index, list], got ${this.describeOperandShape(selectArgs, context)}`
      )
    );
  }
  const [index, list] = selectArgs as [unknown, unknown];

  // The index is RESOLVED, then validated (issue #3574). CloudFormation
  // accepts a `Ref` to a parameter and an `Fn::FindInMap` here, and the raw
  // operand used to be the property key: an intrinsic index read the key
  // `"[object Object]"` and yielded `undefined` with no warning, and a
  // string coercing to `NaN` passed BOTH bounds checks, so `"constructor"`
  // read the `Array` function off the prototype chain. `selectIndexPosition`
  // admits only a non-negative safe integer, so the read below is an own
  // element by construction and the placeholder carries no template text.
  const resolvedIndex = await this.resolveValue(index, context);
  const position = selectIndexPosition(resolvedIndex);
  if (position === undefined) {
    const source = this.describeSplitValueSource(index);
    const sourceClause = source ? ` (from ${this.displayMasked(source.label, context)})` : '';
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Fn::Select: the index${sourceClause} must resolve to a non-negative integer ` +
          `(a number, or its decimal string with no leading zero), got ${this.describeOperandShape(resolvedIndex, context)}. ` +
          `Use a literal, a Ref to a parameter or an Fn::FindInMap that yields one.`
      )
    );
  }

  const resolvedList = await this.resolveValue(list, context);

  if (!Array.isArray(resolvedList)) {
    // A plain `Error`, unlike the two refusals above, and deliberately left
    // so: the LIST is often a resolution product (`Fn::GetAtt`, a
    // parameter), and `cdkd scrub`'s per-key recovery abandons a plain error
    // for that key alone, where a refusal class abandons the enclosing
    // property.
    throw markNonRetryable(
      new Error(`Fn::Select: list must be an array, got ${typeof resolvedList}`)
    );
  }

  // The position through the builder: a resolved index can come from a
  // parameter carrying a SECRET (a nested-stack child's inherited one), and
  // `displayMasked` masks it where the bare integer would not be.
  const loggedPosition = this.displayMasked(String(position), context);
  if (position >= resolvedList.length) {
    if (loggedPosition !== String(position)) {
      // The placeholder is a PROPERTY VALUE sent to AWS and persisted, so a
      // masked position cannot go into it.
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Fn::Select: the index ${loggedPosition} is out of bounds (array length: ` +
            `${resolvedList.length}), and it resolves from a secret value, so cdkd will ` +
            `not write it into the OutOfBounds placeholder.`
        )
      );
    }
    // Reached only when the position did not mask, so it renders as is.
    this.logger.warn(
      `Fn::Select: index ${position} out of bounds (array length: ${resolvedList.length})`
    );
    return `{{Fn::Select:${position}:OutOfBounds}}`;
  }

  const result: unknown = resolvedList[position];
  this.logger.debug(
    // LEAF-masked before the encoding, not after (issue
    // [#2759](https://github.com/go-to-k/cdkd/issues/2759)): `JSON.stringify`
    // escapes a leaf holding `"` / `\` / a control character, and a needle
    // matches literally — so a mask over the ENCODED text misses exactly the
    // secrets that carry those bytes. Leaf-masking also reaches the
    // whole-value arm, which has no {@link MIN_NEEDLE_LENGTH} floor.
    `Resolved Fn::Select: index ${loggedPosition} resolved to ${this.logRender(JSON.stringify(this.maskValueLeaves(result, context)), context, { structured: true })}`
  );
  return result;
}

/**
 * Render ONE `Fn::GetAtt` argument for {@link describeSplitValueSource}'s
 * label. A string is emitted verbatim; anything else is named by its
 * intrinsic key (`<Fn::Sub>`) or, failing that, as `<intrinsic>` — never by
 * default stringification, whose answer for an object is `[object Object]`.
 */
export function renderGetAttArg(this: IntrinsicFunctionResolver, arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
    const keys = Object.keys(arg as Record<string, unknown>);
    const key = keys.length === 1 ? keys[0] : undefined;
    if (key !== undefined && (key === 'Ref' || key.startsWith('Fn::'))) return `<${key}>`;
  }
  return '<intrinsic>';
}

/**
 * Name a malformed operand's type, and its value when that is a scalar, for
 * a refusal message. The value is template text or a resolution product, so
 * it goes through the builder (issue #3479).
 */
export function describeOperandShape(
  this: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'string')
    return `string ${quotedRender(this.displayMasked(value, context), '"')}`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value} ${this.displayMasked(String(value), context)}`;
  }
  return typeof value;
}

/**
 * Name the UNRESOLVED value argument of an `Fn::Split` for its refusal
 * message (issue [#1874](https://github.com/go-to-k/cdkd/issues/1874)).
 *
 * `ResolverContext` carries no referencing logical id / attribute, and
 * threading one through this cross-cutting file for a message would be a
 * plumbing change out of proportion to the win. The value EXPRESSION is
 * already in hand, though, and for the shapes that actually reach the
 * refusal it is exactly what the user needs to find the site:
 *
 * - a list-valued `Fn::GetAtt` renders as `Fn::GetAtt [Zone, NameServers]`,
 *   naming both the resource and the attribute;
 * - a `Ref` to a LIST-TYPED parameter — any `List<...>` type or `CommaDelimitedList`, per the
 *   shared `isListParameterType` — the SECOND genuinely reachable array
 *   source, via `coerceParameterValue` — renders as `Ref MyListParam`,
 *   naming the parameter.
 *
 * Anything else degrades to its bare intrinsic key, or to `undefined` for a
 * literal (which the message then simply omits). `resolveSelect` borrows the
 * label for its index refusal (issue #3574); only `kind` is Split-specific.
 *
 * `kind` is not decoration: the caller uses it to pick the remedy, since the
 * `Fn::GetAtt` remedy (drop the `Fn::Split`, and the #1868 note for the
 * reader whose `Fn::Split` was that bug's workaround) is irrelevant and
 * confusing for a parameter reference or a hand-written literal.
 */
export function describeSplitValueSource(
  this: IntrinsicFunctionResolver,
  value: unknown
): { label: string; kind: 'getatt' | 'ref' | 'other' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return undefined;
  const key = keys[0] as string;
  // allow-template-keyed-bag-read: `key` came out of `Object.keys(value)` two
  // lines up, so it is an OWN key by construction.
  const args = (value as Record<string, unknown>)[key];

  if (key === 'Ref') {
    return typeof args === 'string'
      ? { label: `Ref ${args}`, kind: 'ref' }
      : { label: 'Ref', kind: 'ref' };
  }
  if (key !== 'Fn::GetAtt') {
    return key.startsWith('Fn::') ? { label: key, kind: 'other' } : undefined;
  }
  // Both CFn spellings: the `[logicalId, attribute]` list and the
  // `"logicalId.attribute"` string the shorthand YAML `!GetAtt` produces.
  if (Array.isArray(args)) {
    // The attribute name (arg 2) may itself be an intrinsic — CloudFormation
    // allows any string-valued expression there, and `resolveGetAtt` resolves
    // it — so an all-strings guard would drop the WHOLE label back to a bare
    // `Fn::GetAtt`, losing the logical id, which is the one piece of site
    // information the message has. Render each element instead, and never
    // interpolate an object directly: the default `String(...)` of one is
    // `[object Object]`, which names nothing.
    return {
      label: `Fn::GetAtt [${args.map((a) => this.renderGetAttArg(a)).join(', ')}]`,
      kind: 'getatt',
    };
  }
  if (typeof args === 'string') {
    // Split on the FIRST dot only. An attribute name may itself contain dots
    // (`Child.Outputs.Key` on a nested stack), and CloudFormation parses that
    // as `[Child, Outputs.Key]` — a naive split-on-every-dot renders a
    // three-element GetAtt that does not exist, which is worse than useless
    // in a message whose whole job is to name the site.
    //
    // This branch WAS unreachable end to end and its unit test pinned that
    // unreachability, on the note that it would red the day nested-path
    // `Fn::GetAtt` landed. It landed (issue #2270): `resolveGetAtt` now
    // splits the string spelling on the FIRST dot, so a 3+-segment
    // `Child.Outputs.Key` resolves and can reach `resolveSplit`'s refusal.
    // The rendering below was found already correct, and the test now drives
    // this branch through the live path instead of pinning the old throw.
    const dot = args.indexOf('.');
    const rendered = dot === -1 ? args : `${args.slice(0, dot)}, ${args.slice(dot + 1)}`;
    return { label: `Fn::GetAtt [${rendered}]`, kind: 'getatt' };
  }
  return { label: 'Fn::GetAtt', kind: 'getatt' };
}

/**
 * Resolve Fn::Split intrinsic function
 *
 * Fn::Split: [delimiter, string]
 * Splits a string into a list of strings using the specified delimiter
 *
 * A non-string value is REFUSED, and an ARRAY is refused with its own
 * message (issue [#1874](https://github.com/go-to-k/cdkd/issues/1874)).
 * Passing an array through unchanged was considered and rejected: real
 * CloudFormation rejects `Fn::Split` over a list too, so a template written
 * that way was never valid CFn. It only ever worked because cdkd resolved
 * `AWS::Route53::HostedZone.NameServers` to a comma-delimited STRING, which
 * was the defect PR #1868 fixed — so the post-upgrade failure is a correct
 * rejection of an invalid template, not a regression. Accepting the array
 * would let cdkd deploy templates that `cdkd export` /
 * `cdkd import --migrate-from-cloudformation` then cannot hand back to
 * CloudFormation, breaking the bidirectional-migration guarantee. What WAS
 * genuinely wrong is the message: `value must be a string, got object` names
 * neither the situation nor the remedy.
 *
 * Both refusals throw {@link IntrinsicResolutionRefusalError} rather than a
 * bare `Error`, matching the deliberate refusals already in this file. The
 * #1740 laundering path this class exists for is NOT reachable from here
 * today: `Fn::Sub`'s `${LogicalId.Attribute}` form cannot syntactically
 * contain an `Fn::Split`, and its 2-arg variable-map form resolves each
 * value through `resolveValue` OUTSIDE any catch, so either class would
 * propagate identically there. Using the class anyway keeps "deliberate
 * refusal" a property of the THROW rather than of the one catch that
 * happens to inspect it. It does NOT make the refusal un-launderable: this
 * file's own `evaluateConditions` catches everything per condition, warns,
 * and downgrades that condition to `false`, so an `Fn::Split`-over-a-list
 * inside a `Conditions` entry IS silently absorbed today — by both classes
 * alike, so the choice regresses nothing, but the class is not a guarantee
 * against a class-agnostic catch.
 *
 * Both are additionally `markNonRetryable` (issue #1838). The test is "can
 * this ever succeed on a retry" — an `Fn::Split` over an array never can —
 * NOT "does today's wording collide with a pattern", which is exactly the
 * criterion `retryable-errors.ts` documents as insufficient: the classifiers
 * match by SUBSTRING, and `sourceClause` interpolates template-controlled
 * text, so a logical id like `MyDependencyViolationHandler` puts
 * `DependencyViolation` (a whitespace-free entry in the table — the only
 * one until issue #2116 added the name-cooldown error codes) into the
 * message. Reachability is real even though resolution runs outside
 * `withRetry` on the flat path: `NestedStackProvider.create` runs a child
 * `DeployEngine.deploy()` and re-throws, and the parent wraps `create()` in
 * `withRetry` — so inside a nested stack each retry re-runs a full child
 * deploy plus rollback, up to the ~47s schedule, on a path that cannot
 * succeed. Marked at the THROW rather than in the constructor because the
 * class is retryable in general: its unknown-account arm (see
 * `constructGuardedAttribute`) IS genuinely time-dependent
 * (`getAccountInfo` never caches a failed lookup precisely so a later attempt
 * can heal), so a constructor-level marker would wrongly make that one
 * terminal too.
 */
export async function resolveSplit(
  this: IntrinsicFunctionResolver,
  splitArgs: [string, unknown],
  context: ResolverContext
): Promise<string[]> {
  const [delimiter, value] = splitArgs;

  // Resolve the value first
  const resolvedValue = await this.resolveValue(value, context);

  if (typeof resolvedValue !== 'string') {
    const source = this.describeSplitValueSource(value);
    // SANITIZED at the point the clause is BUILT (go-to-k/cdkd#3435 security
    // round 3, which measured it): `source.label` is `Ref <args>` /
    // `Fn::GetAtt [<arg>]` / a raw template key, all template-controlled, and
    // both throws below reach the user at any verbosity -- the same sink this
    // PR measured for `Resource <id> not found`. The three notes that used to
    // exempt it read "assembled from literals here", which is FALSE and is
    // contradicted by `describeSplitValueSource`'s own doc comment one method
    // up ("interpolates template-controlled text"). Wrapped once here rather
    // than at each throw, so a THIRD consumer of the clause inherits it.
    const sourceClause = source ? ` (from ${this.displayMasked(source.label, context)})` : '';
    if (Array.isArray(resolvedValue)) {
      // The remedy is per-source, and the DEFAULT is the neutral one. Only a
      // value that IS an Fn::GetAtt gets the Route 53 example and the #1868
      // note — that note is addressed to the reader whose Fn::Split was a
      // workaround for THAT attribute bug, so emitting it at a `Ref` to a
      // list-typed parameter, or at a literal array the user wrote
      // out by hand, only misdirects. A literal names nothing about itself,
      // so it takes the neutral text rather than the Fn::GetAtt one.
      const remedy =
        source?.kind === 'ref'
          ? `A list-typed parameter — any List<...> type (List<AWS::EC2::Subnet::Id>, ` +
            `List<Number>, …) or CommaDelimitedList — is already a list.`
          : source?.kind === 'getatt'
            ? `A list-valued Fn::GetAtt (for example ` +
              `AWS::Route53::HostedZone.NameServers or AWS::EC2::VPC.Ipv6CidrBlocks) ` +
              `already returns a list. If you wrote the Fn::Split as a workaround for ` +
              `cdkd resolving that attribute to a comma-delimited string, that bug is ` +
              `fixed (PR #1868) and the workaround is no longer needed.`
            : // Not an exhaustive list on purpose: the source clause above
              // already names the actual intrinsic, and several others reach
              // this arm (Fn::GetAZs, Fn::Cidr, a nested Fn::Split, an
              // Fn::If / Fn::FindInMap selecting a list).
              `Several intrinsics already return a list — among them a ` +
              `list-valued Fn::GetAtt, a Ref to a list-typed parameter (any ` +
              `List<...> type or CommaDelimitedList), Fn::GetAZs, Fn::Cidr, ` +
              `and Fn::Split itself.`;
      // `remedy` is a cdkd-authored sentence chosen by the arm above;
      // `sourceClause` is sanitized where it is built.
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Fn::Split: the value to split${sourceClause} is ALREADY a list ` +
            `(an array of ${resolvedValue.length} item${resolvedValue.length === 1 ? '' : 's'}), ` +
            `not a string. CloudFormation rejects Fn::Split over a list too, so this ` +
            `template is not valid CloudFormation either. Remove the Fn::Split and use ` +
            `the value directly. ${remedy}`
        )
      );
    }
    const got = resolvedValue === null ? 'null' : typeof resolvedValue;
    // `sourceClause` is sanitized where it is built.
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Fn::Split: the value to split${sourceClause} must be a string, got ${got}. ` +
          `Fn::Split accepts only a string; check the value or the intrinsic that ` +
          `produced it.`
      )
    );
  }

  const result = resolvedValue.split(delimiter);
  // go-to-k/cdkd#4049: a piece holding part of a LOG-ONLY needle (a `NoEcho`
  // parameter's value) becomes a log-only needle itself, recorded BEFORE the
  // debug line below so that line masks it, and into the pass's bag so the
  // provider's masker and the error / event masking do too. LOG-ONLY, so
  // nothing persisted moves. The print-only corpus's pieces go into that
  // corpus alone, as `resolveBase64` records its encodings.
  //
  // A context with no pass bag (an inherited-only one) records nothing it
  // could keep, so the pieces go into a bag of THIS call's own, read as a
  // print-only corpus by this call's line alone: it must not rely on some
  // earlier resolution having recorded them.
  let lineContext = context;
  if (this.hasLogOnlyNeedles(context)) {
    if (context.recordedSecretValues) {
      recordLogOnlySplitFragments(
        [context.inheritedSecrets, context.recordedSecretValues],
        context.recordedSecretValues,
        resolvedValue,
        String(delimiter)
      );
    } else {
      const linePieces: RecordedSecretValues = new Map();
      if (context.printingSecrets !== undefined) {
        carryLogOnlyValues(context.printingSecrets, linePieces);
      }
      recordLogOnlySplitFragments(
        [context.inheritedSecrets],
        linePieces,
        resolvedValue,
        String(delimiter)
      );
      lineContext = { ...context, printingSecrets: linePieces };
    }
  }
  if (context.printingSecrets !== undefined && hasLogOnlyValues(context.printingSecrets)) {
    recordLogOnlySplitFragments(
      [context.printingSecrets],
      context.printingSecrets,
      resolvedValue,
      String(delimiter)
    );
  }
  // go-to-k/cdkd#3869: a piece of a secret-derived name a command recorded
  // into its derived-name sink, so this line and an `Fn::Select` of the piece
  // mask it too.
  if (context.secretNameSink !== undefined && hasLogOnlyValues(context.secretNameSink)) {
    recordLogOnlySplitFragments(
      [context.secretNameSink],
      context.secretNameSink,
      resolvedValue,
      String(delimiter)
    );
  }
  // Issue #3100: a piece of a string an earlier write masked keeps its part
  // of that mask, on this line and on an outer Join over the pieces.
  // An EMPTY delimiter splits into single characters, which no needle can
  // mask without every character becoming one (go-to-k/cdkd#4049): when the
  // value carries a masked needle, the line prints every piece as `***`.
  // (That covers this line only: an `Fn::Join` / `Fn::Sub` over the pieces
  // prints them character-spaced, a documented residual. Registering each
  // character as a log twin would close it, but a twin also feeds the
  // `Fn::Base64` persist detector, which would move state.)
  const pieceTwins =
    String(delimiter) === '' &&
    this.maskRenderedNeedlesForLog(resolvedValue, lineContext) !== resolvedValue
      ? result.map(() => SECRET_MASK)
      : this.splitLogTwins(resolvedValue, delimiter, result, context);
  this.logger.debug(
    // Leaf-masked before the encoding — see `resolveSelect`'s twin comment
    // (issue [#2759](https://github.com/go-to-k/cdkd/issues/2759)). The
    // delimiter through the builder (issue #3479): it is raw template text,
    // and a structural operand is still arbitrary JSON.
    `Resolved Fn::Split: split by ${this.splitDelimiterRender(String(delimiter), lineContext)} resolved to ${this.logRender(JSON.stringify(this.maskValueLeaves(pieceTwins, lineContext)), lineContext, { structured: true })}`
  );
  return result;
}
