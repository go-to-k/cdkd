import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { type ResolverContext, isUnboundTemplateParameter } from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import { type IntrinsicLeafResolution } from '../secret-redaction.js';
import { type ParameterSpans, appendShiftedSpans, partParameterSpans } from './string-functions.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    subPlaceholderWarning: OmitThisParameter<typeof subPlaceholderWarning>;
    /** @internal */
    subPlaceholderNamesADeclaredTemplateEntity: OmitThisParameter<
      typeof subPlaceholderNamesADeclaredTemplateEntity
    >;
    /** @internal */
    rethrowStructuralSubFailure: OmitThisParameter<typeof rethrowStructuralSubFailure>;
    /** @internal */
    subListRefusal: OmitThisParameter<typeof subListRefusal>;
    /** @internal */
    resolveSub: OmitThisParameter<typeof resolveSub>;
  }
}

/**
 * The warning emitted when `Fn::Sub` keeps a `${...}` placeholder verbatim.
 *
 * It carries the underlying reason (issue #1740 item 2): the old text
 * asserted `not found` for EVERY failure, which was the wrong cause whenever
 * the variable WAS found and its resolution failed for some other reason.
 * Deliberate refusals no longer reach this path at all — they re-throw.
 */
export function subPlaceholderWarning(
  this: IntrinsicFunctionResolver,
  varName: string,
  error: unknown
): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Fn::Sub variable ${varName} could not be resolved (${reason}), keeping placeholder`;
}

/**
 * Does this `Fn::Sub` placeholder NAME an entity of this template -- a
 * resource (issue [#2270](https://github.com/go-to-k/cdkd/issues/2270)) or
 * an unbound parameter (issue
 * [#2285](https://github.com/go-to-k/cdkd/issues/2285))?
 *
 * The discriminator `resolveSub`'s catch was missing. Two very different
 * things reach that catch and it collapsed both into "keep the placeholder":
 *
 *  - `${some_shell_var}` / `${config.value}` — ORDINARY TEXT that merely
 *    looks like a placeholder. Real CloudFormation rejects it (a `${}` in a
 *    `Fn::Sub` body must name something, or be escaped `${!...}`), but cdkd
 *    has always accepted it, and templates in the wild rely on that. Keeping
 *    it is right.
 *  - `${Child.Outputs.Foo}` — a REFERENCE to a resource this very template
 *    declares, whose resolution failed. Keeping it ships `${Child.Outputs.Foo}`
 *    into a live resource's property with a warn line as the only signal,
 *    which is the defect. Refusing is right.
 *
 * The test is on the HEAD SEGMENT (everything before the first dot — the
 * same split `template-parser.ts` uses to draw the DAG edge for this exact
 * placeholder, and the same one `resolveGetAtt` now uses). A head that names
 * a declared resource cannot be ordinary text: the template author picked
 * that logical id.
 *
 * BOTH the live `context.resources` map and the TEMPLATE's `Resources` block
 * count, and they answer for DIFFERENT populations rather than one being a
 * superset of the other:
 *
 * - the TEMPLATE arm is what fences the reported defect — a resource the
 *   template DECLARES which is absent from state, whose `Fn::GetAtt` throws
 *   `Resource X not found`. A `context.resources`-only test would leave that
 *   unfenced, which is why the template arm exists.
 * - the `context.resources` arm answers when the head IS live but the
 *   reference still fails for a NON-refusal reason: a malformed attribute
 *   (`${Child.}` reaches `Invalid Fn::GetAtt format`), or a transient SDK
 *   error surfacing out of `reresolveCrossStackValue`. It is also the ONLY
 *   arm that fires when the two maps DISAGREE in the other direction — a
 *   resource in state that the template no longer declares.
 *
 * Neither arm is redundant, and neither is dead: `tests/unit/deployment/
 * intrinsic-sub-nested-stack-outputs.test.ts` drives each one in isolation
 * (an empty `Resources` with a populated `resources`, and the reverse).
 *
 * PARAMETERS are included too, but only for the UNBOUND population
 * {@link isUnboundTemplateParameter} defines -- declared, no `Default`, no
 * bound value (issue
 * [#2285](https://github.com/go-to-k/cdkd/issues/2285)). `resolveRef` and
 * `resolvePseudoParameter` already answer for every parameter that HAS a
 * value, so that population is the whole of what this arm newly refuses,
 * and it is the one whose placeholder used to be persisted verbatim.
 *
 * The predicate is SHARED with `resolveParameters`, which raises
 * `Parameter <name> is required ...` for exactly the same population up
 * front -- so on a plain `cdkd deploy` this arm is unreachable by
 * construction, and what it actually covers is the caller that CATCHES that
 * error and resolves anyway (`cdkd import`, in every mode, on a context that
 * is not `bestEffort`).
 *
 * A parameter carrying a `Default` the caller never merged stays OUT, for
 * the reason recorded on the shared predicate.
 *
 * An earlier revision excluded parameters WHOLESALE and justified that by
 * "the routine `cdkd scrub` case (it takes no `--parameters`)". That reason
 * was FALSE and is recorded here so it is not reintroduced: `scrub.ts`'s `resolverContext` factory sets
 * `bestEffort: true` in the same object literal that binds `template` and
 * `resources`, so scrub short-circuits in `rethrowStructuralSubFailure`
 * before this predicate is consulted at all — it can neither benefit from
 * nor be harmed by what this function includes.
 */
export function subPlaceholderNamesADeclaredTemplateEntity(
  this: IntrinsicFunctionResolver,
  varName: string,
  context: ResolverContext
): boolean {
  const firstDot = varName.indexOf('.');
  const head = firstDot >= 0 ? varName.slice(0, firstDot) : varName;
  if (head === '') return false;
  // Not for a parameter or pseudo-parameter name (issue #3916): a record
  // planted under it must not decide refuse-vs-warn either.
  if (!this.nameIsNeverAResource(head, context) && Object.hasOwn(context.resources, head)) {
    return true;
  }
  const declared = context.template?.Resources;
  if (declared !== undefined && declared !== null && typeof declared === 'object') {
    if (Object.hasOwn(declared, head)) return true;
  }
  return isUnboundTemplateParameter(head, context.template, context.parameters);
}

/**
 * Refuse to launder a STRUCTURAL `Fn::Sub` failure into a literal
 * (issues [#2270](https://github.com/go-to-k/cdkd/issues/2270) and
 * [#2285](https://github.com/go-to-k/cdkd/issues/2285)).
 *
 * Called from both arms of `resolveSub`'s catch — the dotted (GetAtt) one
 * and the bare (Ref) one — after the
 * {@link IntrinsicResolutionRefusalError} re-throw that issue #1740 added.
 * That earlier fix made the DELIBERATE refusals loud; this one covers the
 * rest, which is where #2270 lived: `Invalid Fn::GetAtt format` and
 * `Resource X not found for Fn::GetAtt` are plain `Error`s, so they were
 * laundered.
 *
 * The ORIGINAL error is re-thrown UNCHANGED — not wrapped, not re-worded.
 * The retry classifiers in `retryable-errors.ts` match on the message by
 * SUBSTRING and `markNonRetryable` rides the error OBJECT, so wrapping would
 * silently re-classify a genuinely transient failure (an SDK error surfacing
 * out of the nested-stack output re-resolution below) as terminal, or a
 * terminal one as retryable via a template-controlled logical id spliced
 * into a new message. Loudness is the fix; changing the error is not part of
 * it.
 *
 * `bestEffort` is EXEMPT. That flag marks the diff / `cdkd scrub` callers,
 * whose documented expected case is a reference to a resource this same
 * deploy will CREATE (the CDK logical-id-churn dance, issue #1017) — exactly
 * the "declared but not in state" shape this refuses. Those callers also
 * catch resolution failures and keep the raw intrinsic, so refusing there
 * would change diff output for no gain.
 */
export function rethrowStructuralSubFailure(
  this: IntrinsicFunctionResolver,
  varName: string,
  error: unknown,
  context: ResolverContext
): void {
  if (context.bestEffort) return;
  if (!this.subPlaceholderNamesADeclaredTemplateEntity(varName, context)) return;
  throw error;
}

/**
 * Refuse a LIST where `Fn::Sub` needs a string (issue
 * [#3809](https://github.com/go-to-k/cdkd/issues/3809)). CloudFormation
 * rejects the template for every list source: a `${X}` resolving to a
 * `List<...>` / `CommaDelimitedList` parameter, a list-valued attribute or
 * `AWS::NotificationARNs` ("variable X in Fn::Sub expression does not resolve
 * to a string"), and a variable-map value that is a list, USED or not ("every
 * value of the context object of every Fn::Sub object must be a string or a
 * function that returns a string"). `String()` over the array used to render
 * `a,b` instead, so cdkd deployed a template CloudFormation refuses.
 *
 * RETURNS the refusal rather than throwing it: `resolveSub` keeps the FIRST
 * one and throws only after every variable and placeholder has resolved and
 * the final dynamic-reference pass has run, so a `{{resolve:...}}` behind
 * the list still records its needle (the go-to-k/cdkd#3218 class, which
 * `cdkd scrub` depends on).
 *
 * `subject` names template-controlled text, so it is masked here, once.
 * Marked non-retryable: no retry changes a template.
 */
export function subListRefusal(
  this: IntrinsicFunctionResolver,
  subject: string,
  value: unknown,
  context: ResolverContext
): IntrinsicResolutionRefusalError | undefined {
  if (!Array.isArray(value)) return undefined;
  const count = `${value.length} item${value.length === 1 ? '' : 's'}`;
  return markNonRetryable(
    new IntrinsicResolutionRefusalError(
      `Fn::Sub: ${this.displayMasked(subject, context)} resolves to a list (an array of ${count}), ` +
        `not a string. CloudFormation rejects this template too, because every Fn::Sub ` +
        `variable must resolve to a string. Render the list with Fn::Join in the variable ` +
        `map instead, for example ["ids=\${Ids}", {"Ids": {"Fn::Join": [",", {"Ref": "SubnetIds"}]}}].`
    )
  );
}

/**
 * Resolve Fn::Sub intrinsic function
 *
 * Fn::Sub supports two forms:
 * 1. String with ${VarName} placeholders
 * 2. [String, {VarName: value, ...}] with explicit variable mapping
 *
 * Note: This is a simplified implementation that doesn't handle async properly
 * inside replace(). For full async support, we'd need to collect all replacements
 * first, then do them synchronously.
 */
export async function resolveSub(
  this: IntrinsicFunctionResolver,
  subArgs: string | [string, Record<string, unknown>],
  context: ResolverContext,
  source: object
): Promise<string> {
  let template: string;
  // Resolved INTO A FRESH OBJECT, never back into the caller's map (issue
  // #2739). `subArgs[1]` is the object inside the caller's template — an
  // Output's `Value['Fn::Sub'][1]`, a resource property's — and writing the
  // resolved values into it left the template holding a plaintext where it
  // had held a `{{resolve:...}}` reference or an intrinsic. A template is a
  // description, not a cache: a later resolution of the same object with a
  // fresh recording map would then return the plaintext without recording
  // it (no token left for `resolveDynamicReferences` to see), and the
  // positioning source `DeployEngine.resolveOutputs` retains would carry
  // the secret. The plain-string form and `Fn::Join` never mutated theirs.
  //
  // `Object.create(null)`, not `{}`: the variable NAMES come from the
  // template, and `JSON.parse` makes `__proto__` an OWN key there, so a
  // plain object would route that one assignment through the inherited
  // prototype setter and render `${__proto__}` as `[object Object]` — the
  // same reason `redactByPath`'s object walk builds its output that way.
  // The membership test below therefore sees OWN keys only, on EITHER form
  // (the plain-string form used to test against a plain `{}` too), and it is
  // an `Object.hasOwn` besides (issue #2776): a placeholder
  // naming an `Object.prototype` member the map does not carry
  // (`${constructor}`, `${toString}`) used to substitute that member's
  // source text and now falls through to pseudo-parameter / `Ref`
  // resolution like any other unknown name.
  const variables: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // The LOG TWIN of each variable whose raw value was a STRING (issue #3100,
  // see `LogTwin`), null-prototype for the reason `variables` is. A string
  // variable is resolved here rather than through `resolveValue`, whose
  // string arm is exactly `resolveDynamicReferences` over a string holding a
  // `{{resolve:` opener and the string itself otherwise, so the value is
  // unchanged: a reference-bearing one keeps its substitution's twin, and a
  // LITERAL keeps itself even when it equals a recorded secret. A variable
  // with no entry here (an intrinsic) is a resolution product, masked whole
  // at the replacement below when it is a recorded secret.
  const variableTwins: Record<string, string> = Object.create(null) as Record<string, string>;
  // What each variable contributes to the object's record (issue #3156),
  // keyed like the two maps above. Read per placeholder USE below, so a
  // variable the template never names contributes nothing to the record. A
  // STRING variable contributes its RAW text with its own dynamic-reference
  // pass, so a token it holds reaches `input` as the token (issue #3306); an
  // intrinsic one contributes its own record when the pass kept one
  // (`nestedPartResolution`), and its resolved text otherwise -- looked up
  // from `variableSources` at the placeholder, so an unused variable is
  // never stringified here.
  const variableSources: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const variableRecords: Record<
    string,
    Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'>
  > = Object.create(null) as Record<
    string,
    Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'>
  >;
  // The FIRST list refusal (issue #3809), thrown only once the walk is done
  // -- see `subListRefusal`.
  let listRefusal: IntrinsicResolutionRefusalError | undefined;

  // The TEMPLATE must be a string on both forms (issue #2776), checked before
  // the variable map below. CloudFormation takes only a literal string there,
  // and without this guard a non-string died at `template.matchAll is not a
  // function` — a TypeError naming this function's internals rather than
  // the template's shape. Refused on the same terms as the second element:
  // the TYPE is named and never the value, and it is marked non-retryable
  // because no retry changes a template.
  const subTemplateKind = (value: unknown): string =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (Array.isArray(subArgs)) {
    const [templateString, variableMap] = subArgs as unknown[];
    if (typeof templateString !== 'string') {
      throw markNonRetryable(
        new Error(
          `Fn::Sub: the first element must be a string, got ${subTemplateKind(templateString)}`
        )
      );
    }
    template = templateString;
    // A `null` / primitive second element is refused UNCONDITIONALLY —
    // newly enforced validation. Before this change `null` always threw
    // (`Object.entries(null)`) and so did a non-empty string (its indexed
    // entries could not be assigned back onto the primitive), but a number,
    // a boolean or an empty string failed only once a placeholder reached
    // the `in` test, so a placeholder-free template beside one resolved.
    // The cross-stack reader in `secret-redaction.ts` relies on the shape
    // never being recorded, and copying into a fresh object would have made
    // those three variants resolve silently. An ARRAY second element still
    // resolves by index (`${0}`); its non-enumerable `length` is no longer
    // a variable (`${length}` used to render the count through `in`), since
    // `Object.entries` copies own ENUMERABLE keys.
    if (typeof variableMap !== 'object' || variableMap === null) {
      throw markNonRetryable(
        new Error(
          `Fn::Sub: the second element must be a variable map, got ${
            variableMap === null ? 'null' : typeof variableMap
          }`
        )
      );
    }
    for (const [key, val] of Object.entries(variableMap)) {
      if (typeof val === 'string') {
        // The string arm needs no per-key wrapper: it enters the token loop
        // directly, which recovers per TOKEN and only throws for a refusal —
        // and a refusal must abort this walk too.
        const resolved = val.includes('{{resolve:')
          ? await this.resolveDynamicReferencesWithLogTwin(val, val, context)
          : { result: val, twin: val, substitutions: [], complete: true };
        variables[key] = resolved.result;
        variableTwins[key] = resolved.twin;
        variableRecords[key] = {
          input: val,
          substitutions: resolved.substitutions,
          complete: resolved.complete,
        };
      } else {
        // Same sequential-walk defect as the object bag (issue
        // go-to-k/cdkd#3218), found beside it: `Fn::Sub: ["...", {A: {Ref:
        // "NoSuchThing"}, B: "{{resolve:secretsmanager:...}}"}]` loses `B`
        // identically. The non-string arm is the one that needs the wrapper,
        // because it is the arm that can throw for a reason the token loop
        // never sees.
        // Deliberately writes NO `variableTwins` entry, abandoned or not:
        // this arm never set one, and the substitution site below falls back
        // to `productLogTwin` for exactly the keys it omits. An abandoned key
        // keeps its INPUT — an intrinsic object — and that fallback masks it
        // the same way it masks any other non-string product.
        // Bag-gated at the call site, as in `resolveValue` — see
        // `resolveKeyUnit`'s doc for why the extra frame is not free.
        variables[key] =
          context.abandonedResolutions === undefined
            ? await this.resolveValue(val, context)
            : await this.resolveKeyUnit(key, val, context, context.abandonedResolutions);
        variableSources[key] = val;
        // Refused whether or not the template names it: CloudFormation
        // validates every value of the map (issue #3809).
        listRefusal ??= this.subListRefusal(
          `the variable-map value ${key}`,
          variables[key],
          context
        );
      }
    }
  } else {
    if (typeof subArgs !== 'string') {
      throw markNonRetryable(
        new Error(`Fn::Sub: the template must be a string, got ${subTemplateKind(subArgs)}`)
      );
    }
    template = subArgs;
  }

  // Collect all replacements
  // `twin` is the replacement's LOG TWIN (issue #3100); an entry no secret
  // can reach (an escape, an empty `${}`, a pseudo parameter, a kept
  // placeholder) carries its replacement as its own twin.
  // `record` is set only for a variable: what it contributes to the
  // object's record (issues #3156, #3306).
  // `parameterSpans` is where parameter values lie on `replacement` (issue
  // #4446): `[]` for an entry that places none it can vouch for, whose
  // replacement is then a gap.
  const replacements: Array<{
    match: string;
    replacement: string;
    twin: string;
    record?: Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'>;
    parameterSpans: ParameterSpans;
  }> = [];
  // Match BOTH the literal-escape form `${!X}` and the variable form `${X}`.
  // The CloudFormation rule: a `${` immediately followed by `!` is an escape —
  // it renders as the literal text `${X}` with NO variable substitution. We
  // capture the optional leading `!` so escaped tokens are special-cased here
  // (emit `${X}` literally) and never reach variable / Ref / GetAtt resolution.
  const matches = template.matchAll(/\$\{(!)?([^}]*)\}/g);

  for (const match of matches) {
    const isEscaped = match[1] === '!';
    const varNameStr = match[2];

    // Literal-escape form `${!X}` -> emit `${X}` verbatim, no resolution.
    if (isEscaped) {
      const escapedLiteral = `\${${varNameStr ?? ''}}`;
      replacements.push({
        match: match[0],
        replacement: escapedLiteral,
        twin: escapedLiteral,
        parameterSpans: [],
      });
      continue;
    }

    if (!varNameStr) {
      // An empty `${}` has nothing to resolve — leave it verbatim. Push an
      // entry so the positional single-pass replace below stays aligned.
      replacements.push({
        match: match[0],
        replacement: match[0],
        twin: match[0],
        parameterSpans: [],
      });
      continue;
    }

    let replacement: string;
    // Set only by the arms that RESOLVED something (issue #3100).
    let twinReplacement: string | undefined;
    let record: Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'> | undefined;
    let parameterSpans: ParameterSpans = [];

    // Check explicit variables first. `Object.hasOwn` rather than `in`
    // (issue #2776), on all three maps. UNFALSIFIABLE while they carry no
    // prototype -- a probe restoring `in` here is green, and that is stated
    // rather than left for the next reader to discover (the same note
    // `evaluateConditions`' memo carries) -- but whether a placeholder is
    // BOUND should not depend on how a map far above was allocated:
    // with a plain `{}` there, `${constructor}` rendered the `Object`
    // function's source text into a live property.
    if (Object.hasOwn(variables, varNameStr)) {
      replacement = String(variables[varNameStr]);
      twinReplacement = Object.hasOwn(variableTwins, varNameStr)
        ? variableTwins[varNameStr]
        : this.productLogTwin(variables[varNameStr], context);
      if (Object.hasOwn(variableRecords, varNameStr)) record = variableRecords[varNameStr];
      else if (Object.hasOwn(variableSources, varNameStr)) {
        record = this.nestedPartResolution(context, variableSources[varNameStr], replacement);
        // A bound intrinsic (`{V: {Ref: A}}`, a nested Sub / Join / If) places
        // its own record's spans (issue #4446).
        parameterSpans = partParameterSpans(context, variableSources[varNameStr], replacement);
      }
    } else {
      // Check if it's a pseudo parameter. `AWS::NotificationARNs` is a LIST
      // one, refused like any other list (issue #3809).
      const pseudoValue = await this.resolvePseudoParameter(varNameStr, context);
      const pseudoRefusal = this.subListRefusal(
        `the variable \${${varNameStr}}`,
        pseudoValue,
        context
      );
      listRefusal ??= pseudoRefusal;
      if (pseudoRefusal) {
        replacement = match[0];
      } else if (pseudoValue !== undefined) {
        replacement = String(pseudoValue);
      } else {
        // Try to resolve as Ref
        try {
          let fromParameter = false;
          const value = await this.resolveRef(varNameStr, context, () => {
            fromParameter = true;
          });
          const refusal = this.subListRefusal(`the variable \${${varNameStr}}`, value, context);
          listRefusal ??= refusal;
          replacement = refusal ? match[0] : String(value);
          if (!refusal) twinReplacement = this.productLogTwin(value, context);
          // The parameter arm answered: the whole replacement is that
          // parameter's value (issue #4446).
          if (!refusal && fromParameter && typeof value === 'string' && value !== '') {
            parameterSpans = [{ start: 0, length: value.length, parameter: varNameStr }];
          }
        } catch (refError) {
          // A DELIBERATE refusal (`lookupResourceRecord`'s malformed-record
          // one, #3576) is the final answer on both arms below (issue #1740),
          // re-raised ahead of the GetAtt fallback. A bare re-throw: the
          // refusal was masked at its own throw.
          if (refError instanceof IntrinsicResolutionRefusalError) throw refError;
          // If not found, try to resolve as GetAtt (e.g., "Resource.Attribute")
          if (varNameStr.includes('.')) {
            try {
              const value = await this.resolveGetAtt(varNameStr, context);
              const refusal = this.subListRefusal(`the variable \${${varNameStr}}`, value, context);
              listRefusal ??= refusal;
              replacement = refusal ? match[0] : String(value);
              if (!refusal) twinReplacement = this.productLogTwin(value, context);
            } catch (getAttError) {
              // A DELIBERATE refusal is re-raised, never laundered into a
              // literal `${...}` (issue #1740). Only a genuine miss — or an
              // unexpected failure whose cause the warning now names — falls
              // through to keeping the placeholder.
              // A bare re-throw composes no message: the refusal was masked at
              // its own throw one level down, which is a site this file's
              // coverage checker already governs. Masking it again here would
              // mask a mask.
              if (getAttError instanceof IntrinsicResolutionRefusalError) throw getAttError;
              // Issue #2270: a plain `Error` from a placeholder that NAMES a
              // resource of this template is structural too, and keeping it
              // ships `${Child.Outputs.Foo}` into a live property. Issue
              // #2285 adds the head segments that name an UNBOUND template
              // parameter on the same terms.
              this.rethrowStructuralSubFailure(varNameStr, getAttError, context);
              // MASKED (issue
              // [#2827](https://github.com/go-to-k/cdkd/issues/2827)'s
              // sweep), and DEFENCE IN DEPTH rather than a closed leak —
              // stated so the next reader does not assume a case exists for
              // it. Both operands of this warn are TEMPLATE literals: the
              // placeholder text, and a message whose reachable forms name
              // `varNameStr` (`Resource X not found for Fn::GetAtt`). A
              // plaintext can reach it only through an SDK rejection raised
              // inside an attribute lookup, which no unit fixture here
              // drives. The mask stays because the cost is one call and the
              // alternative is deciding, per future AWS error text, whether
              // this line is safe. Masked at the MESSAGE rather than per raw
              // value because the reason IS a caught message; the sub-floor
              // bound that implies is the one `evaluateConditions` states.
              this.logger.warn(
                this.displayMasked(this.subPlaceholderWarning(varNameStr, getAttError), context)
              );
              replacement = match[0]; // Keep original placeholder
            }
          } else {
            // Issue #2270's other half, on the SAME terms as the dotted arm
            // above: `${MyBucket}` naming a resource this template declares
            // is an implicit `Ref`, never ordinary text, so a `Ref MyBucket
            // not found` here is structural and must not become a literal.
            // This is also the arm issue #2285 lives on: `${Stage}` naming a
            // parameter the template DECLARES with no `Default` and no bound
            // value is an implicit `Ref` for the same reason.
            this.rethrowStructuralSubFailure(varNameStr, refError, context);
            // Masked for the reason its `Fn::GetAtt` twin above is.
            this.logger.warn(
              this.displayMasked(this.subPlaceholderWarning(varNameStr, refError), context)
            );
            replacement = match[0]; // Keep original placeholder
          }
        }
      }
    }

    replacements.push({
      match: match[0],
      replacement,
      twin: twinReplacement ?? replacement,
      ...(record ? { record } : {}),
      parameterSpans,
    });
  }

  // Apply all replacements in a SINGLE left-to-right pass over the same
  // regex, consuming the pre-collected replacements positionally. This avoids
  // the first-occurrence hazard of a sequential `String.replace(match, ...)`
  // loop — e.g. an escaped `${!X}` produces the literal `${X}`, which a later
  // `${X}` variable replacement's `.replace` would otherwise clobber — and
  // never re-scans an escaped token's literal output.
  // The same pass places each entry's parameter spans on `result` (issue
  // #4446): its offset in the template, moved by every replacement before it.
  // An entry placing no span is a gap, as an `Fn::Join` part is; only a
  // misaligned entry, which places nothing reliably, drops them all.
  let cursor = 0;
  let shift = 0;
  let parameterSpans: ParameterSpans[number][] | undefined = [];
  let result = template.replace(
    /\$\{(!)?([^}]*)\}/g,
    (whole: string, _bang: unknown, _name: unknown, at: number) => {
      const entry = replacements[cursor++];
      // Every regex match pushes exactly one entry during collection (including
      // the verbatim-kept empty `${}`), so this stays positionally aligned;
      // fall back to the matched text if a gap ever appears.
      const replacement = entry ? entry.replacement : whole;
      if (entry === undefined) parameterSpans = undefined;
      else if (parameterSpans !== undefined) {
        appendShiftedSpans(parameterSpans, entry.parameterSpans, at + shift);
      }
      shift += replacement.length - whole.length;
      return replacement;
    }
  );
  // The LOG TWIN (issue #3100): the same positional pass over the same
  // template, consuming each entry's twin instead.
  let twinCursor = 0;
  let twin = template.replace(/\$\{(!)?([^}]*)\}/g, (whole) => {
    const entry = replacements[twinCursor++];
    return entry ? entry.twin : whole;
  });

  // The record (issue #3156). `input` is the template with each USED
  // variable replaced by what it contributes (issue #3306): a string
  // variable's RAW text, an intrinsic one's own record input or its
  // resolved text, every other placeholder by its replacement. So a token a
  // variable holds stays a token in `input`, beside the replacement that
  // resolved it, and the replacements the used variables made count ahead of
  // the final pass's own over the substituted template.
  let inputCursor = 0;
  const input = template.replace(/\$\{(!)?([^}]*)\}/g, (whole) => {
    const entry = replacements[inputCursor++];
    return entry ? (entry.record?.input ?? entry.replacement) : whole;
  });
  const substitutions = replacements.flatMap((entry) => entry.record?.substitutions ?? []);
  let complete = replacements.every((entry) => entry.record?.complete ?? true);

  // Resolve any dynamic references in the substituted result (secret refs are
  // left unresolved per-reference when skipDynamicReferences is set).
  if (result.includes('{{resolve:')) {
    const substituted = await this.resolveDynamicReferencesWithLogTwin(result, twin, context);
    // The spans index the substituted template; a pass that rewrote it moved them.
    if (substituted.result !== result) parameterSpans = undefined;
    ({ result, twin } = substituted);
    substitutions.push(...substituted.substitutions);
    complete &&= substituted.complete;
  }
  // After the final pass, so every reference in the template has recorded.
  if (listRefusal) throw listRefusal;
  this.recordLeafResolution(context, source, {
    input,
    output: result,
    substitutions,
    complete,
    ...(parameterSpans === undefined ? {} : { parameterSpans }),
  });
  this.rememberLogTwin(context, result, twin);
  this.logger.debug(
    `Resolved Fn::Sub: ${this.logRender(this.logTwinText(result, twin, context), context)}`
  );
  return result;
}
