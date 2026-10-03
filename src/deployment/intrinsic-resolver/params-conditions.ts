import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { stripControlChars } from '../../utils/regexp.js';
import { displaySafe } from '../../utils/display-safe.js';
import { withSharedDrainBudget } from '../drain-budget.js';
import { recordAssumedConditions } from '../assumed-conditions.js';
import { ssmResolvedValueType } from '../../utils/parameter-types.js';
import {
  maskSecretsInText,
  hasMaskableValues,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  type AbandonedResolution,
  type ResolverContext,
  type ParameterDefinition,
  isDeliberateResolutionRefusal,
  collectReferencedParameterNames,
  isUnboundTemplateParameter,
  coerceParameterDefault,
  stringifyParameterForLog,
  quotedRender,
} from './support.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    resolveParameters: OmitThisParameter<typeof resolveParameters>;
    evaluateConditions: OmitThisParameter<typeof evaluateConditions>;
    /** @internal */
    resolveKeyUnit: OmitThisParameter<typeof resolveKeyUnit>;
  }
}

/**
 * Resolve parameter values from template Parameters section
 *
 * Merges default values from template with user-provided parameter values.
 * User-provided values take precedence over defaults.
 *
 * @param template CloudFormation template containing Parameters section
 * @param userParameters User-provided parameter values (e.g., from CLI)
 * @returns Record of parameter names to resolved values
 */
export async function resolveParameters(
  this: IntrinsicFunctionResolver,
  template: CloudFormationTemplate,
  userParameters?: Record<string, string>,
  options?: {
    /**
     * The parent's `plaintext -> {{resolve:...}}` pairs, on a NESTED-STACK
     * CHILD engine only (issue #1903). Two things need it HERE, and both
     * are about the same seam — this method is where an already-decrypted
     * parent value first enters the child:
     *
     *  - the debug lines below print a parameter VALUE, and on this path
     *    that value is plaintext the child's own `recordedSecretValues`
     *    does not yet know about, so `stringifyParameterForLog`'s `NoEcho`
     *    test (the author's own declaration, which a CDK-synthesized
     *    nested-stack parameter never carries) is the only thing standing
     *    between `--verbose` and the secret;
     *  - `refuseCoercedInheritedSecret` needs the PRE-coercion string to
     *    decide whether the declared `Type` would push the value out of
     *    cdkd's string-keyed redaction model.
     */
    inheritedSecrets?: RecordedSecretValues;
  }
): Promise<Record<string, unknown>> {
  const inheritedSecrets = options?.inheritedSecrets;
  // SANITIZED as well as masked (go-to-k/cdkd#3426). The three lines below
  // print a template-supplied PARAMETER VALUE, so the control-character class
  // reaches them exactly as it reached the `Fn::ImportValue` bindings; they
  // are `debug` rather than `warn`, which changes when a reader sees it, not
  // whether. Mask, strip, mask — the {@link maskThenStripThenMask} order, and
  // for its reason: `stripControlChars` DELETES, so a plaintext split by an
  // invisible would be reconstituted contiguous by a strip after one mask.
  // Then `displaySafe`, for the class the strip does not cover. This is the
  // shape every masker reaching a render must have. This one is deliberately
  // narrower about BAGS than the builder: it masks against the INHERITED bag
  // alone, which is the only bag that can hold the needle at this seam, so a
  // FOURTH call site is a security decision rather than a copy.
  const maskInherited = (text: string): string => {
    // `hasMaskableValues` (go-to-k/cdkd#1998): an inherited bag holding
    // only the parent's LOG-ONLY needles still masks.
    const mask = (value: string): string =>
      inheritedSecrets && hasMaskableValues(inheritedSecrets)
        ? maskSecretsInText(value, inheritedSecrets)
        : value;
    return displaySafe(mask(stripControlChars(mask(text))));
  };
  // The context a user-provided value's leaves are masked against (issue
  // #3114): the inherited bag is the only one this method has, and it is also
  // the bag the parent registered its log twins under, so a value the parent
  // built around a short secret prints with the parent's mask.
  const inheritedLogContext: ResolverContext = {
    template,
    resources: {},
    ...(inheritedSecrets && { inheritedSecrets }),
  };
  // `Object.create(null)` (issue #2802). Every key here is a template
  // PARAMETER NAME, and the three writes below are plain assignments, so on a
  // plain object `parameters['__proto__'] = v` went to the inherited setter
  // and the value was lost. Safe as a null-prototype bag: the four callers of
  // `resolveParameters` index it or `Object.keys` it, and it is never coerced
  // or `Object.assign`ed. `diff-recursive.ts` DOES spread it, which is safe
  // for the opposite reason: a spread copies with DEFINE semantics, so a
  // `__proto__` own key survives into the target rather than hitting its
  // setter. An `Object.assign` would not, and there is none.
  const parameters: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const templateParameters = template.Parameters;

  if (!templateParameters || typeof templateParameters !== 'object') {
    return parameters;
  }

  // Computed lazily — only templates that actually carry an SSM-typed
  // default without a user-provided value pay for the template walk.
  let referencedNames: Set<string> | undefined;

  for (const [name, definition] of Object.entries(templateParameters)) {
    const paramDef = definition as ParameterDefinition;

    // No value provided and no default - this is an error. Decided by the
    // SHARED {@link isUnboundTemplateParameter} rather than by the shape of
    // the branches below, because `resolveSub`'s structural refusal asks the
    // very same question (issue #2285) and the two must not drift. Hoisted
    // above the branches so both sites read one definition of the population
    // instead of one site defining it and the other reconstructing it.
    // THE WHOLE LOOP BODY RENDERS `name`, and all six renders sanitize
    // (go-to-k/cdkd#3435 review round 2). The five debug lines below took
    // `maskInherited` -- already in scope, already the pass every VALUE on
    // this method uses -- rather than a second spelling. They are `debug`
    // rather than default-verbosity, which changes WHEN a reader sees the
    // line, not whether the bytes reach a terminal; and leaving five of six
    // on a premise the sixth refutes thirty lines down is the "sweep the
    // CLASS, not the instance" miss this repo keeps measuring.
    if (isUnboundTemplateParameter(name, template, userParameters)) {
      // SWEPT IN WITH THE 19 (go-to-k/cdkd#3432 review). This note carried
      // the SAME premise the eighteen logical-id ones could not support --
      // "CloudFormation requires a literal" -- and it is false here for the
      // same reason: cdkd reads the template as JSON, so a `Parameters` KEY is
      // only as constrained as the file, and `cdkd import
      // --migrate-from-cloudformation` reads a hand-written one. MEASURED by
      // the reviewer on this tree: a parameter named `Prod<ESC>[2K<CR>Evil`
      // put a live terminal-rewriting sequence on this THROW, which the user
      // sees at any verbosity.
      //
      // It sat outside go-to-k/cdkd#3432's own population because that issue
      // defined the population by grepping for the marker spelled with
      // `logicalId` in its parentheses, and this one names `name` instead.
      // (The literal tag is not written in this comment on purpose: the
      // checker scans raw text for it, so a prose mention parses as a marker
      // no site consumes -- which it then reports STALE. Measured while
      // writing this paragraph, exactly as `displayMasked`'s own doc warns.)
      // Fixed here rather than filed: it is the same class, in
      // the same file, one marker over -- and `scrub.ts`'s classification
      // note had just been edited to call this pattern's id "the only one
      // still rendered raw", which would have shipped as a standing
      // description of a live exposure.
      //
      // `maskInherited`, the same pass the five debug lines in this loop take
      // and the one this method already defines: it masks against the
      // INHERITED bag -- the only bag that can hold a needle at this seam --
      // then strips, masks again and runs `displaySafe`. An earlier revision
      // of this comment said the site had "no context to pass", which was
      // false: `inheritedLogContext` is in scope from the top of the method
      // (go-to-k/cdkd#3435 review round 2).
      throw new Error(
        `Parameter ${maskInherited(name)} is required but no value was provided and no default exists`
      );
    }

    // User-provided value takes precedence
    // `Object.hasOwn` (issue #2767): `name` is a declared parameter NAME, so
    // a bare `in` answered for an `Object.prototype` member and handed the
    // `Object` FUNCTION to `coerceParameterValue` as the user's value.
    if (userParameters && Object.hasOwn(userParameters, name)) {
      const userValue = userParameters[name];
      if (userValue !== undefined) {
        this.refuseCoercedInheritedSecret(name, paramDef, userValue, inheritedSecrets);
        parameters[name] = this.coerceParameterValue(userValue, paramDef.Type);
        this.logger.debug(
          `Parameter ${maskInherited(name)}: using user-provided value ${maskInherited(
            stringifyParameterForLog(paramDef, this.maskValueLeaves(userValue, inheritedLogContext))
          )}`
        );
        continue;
      }
    }

    // Use default value if available
    if ('Default' in paramDef) {
      // SSM Parameter type: resolve the default value (SSM parameter path) via SSM API
      if (paramDef.Type.startsWith('AWS::SSM::Parameter::Value')) {
        // Skip the SSM lookup for parameters nothing in Resources / Outputs /
        // Conditions consumes. The load-bearing case is the CDK default
        // synthesizer's `BootstrapVersion` parameter (default
        // `/cdk-bootstrap/<qualifier>/version`), which is referenced only by
        // the `Rules.CheckBootstrapVersion` assertion cdkd never evaluates —
        // resolving it eagerly makes every deploy require `cdk bootstrap` in
        // the target region (GetParameter throws ParameterNotFound
        // otherwise), defeating cdkd-owned asset storage (issue #1002).
        referencedNames ??= collectReferencedParameterNames(template);
        if (!referencedNames.has(name)) {
          this.logger.debug(
            `Parameter ${maskInherited(name)}: skipping SSM resolution (not referenced by Resources/Outputs/Conditions)`
          );
          continue;
        }
        const ssmPath = String(paramDef.Default);
        // `ssmPath` is an SSM path from the parameter DEFINITION in the
        // template -- the same untrusted JSON the NAME comes from, so it takes
        // the same pass.
        this.logger.debug(
          `Parameter ${maskInherited(name)}: resolving SSM parameter path ${maskInherited(ssmPath)}`
        );
        const resolved = await this.resolveSSMParameter(ssmPath);
        // Coerced against the INNER type peeled out of `Value<...>`, never
        // the declared outer one -- see {@link ssmResolvedValueType} for why
        // the outer type is a silent no-op here, and for the two
        // AWS-published contracts that settle the split and the trim. A
        // `Value<List<String>>` parameter used to reach consumers as the raw
        // comma-separated string `GetParameter` returns (issue #2367).
        //
        // STRICTLY AFTER the `referencedNames` skip above, which `continue`s
        // before this branch ever reaches `GetParameter`, so nothing here can
        // make an unreferenced parameter resolvable again (issue #1002's
        // `BootstrapVersion` carve-out). That parameter is
        // `Value<String>` in any case, whose inner type coerces to itself.
        //
        // OFF THE DOCUMENTED TYPE SPACE this newly coerces where it used to
        // pass through: `Value<Number>` is not a Systems Manager parameter
        // type CloudFormation defines (Parameter Store has String /
        // StringList / SecureString), but if a template spells it, the peeled
        // `Number` now yields `Number(resolved)` -- and `NaN` for a
        // non-numeric Parameter Store value -- rather than the raw string.
        const resolvedType = ssmResolvedValueType(paramDef.Type);
        parameters[name] =
          resolvedType === undefined ? resolved : this.coerceParameterValue(resolved, resolvedType);
        this.logger.debug(
          `Parameter ${maskInherited(name)}: resolved SSM value ${maskInherited(
            stringifyParameterForLog(paramDef, resolved)
          )}`
        );
        continue;
      }

      // Bound the way the user-supplied path binds a value, so a defaulted
      // `CommaDelimitedList` is a list rather than a comma-joined string
      // (issue #2367). Only a STRING default is coerced -- see
      // {@link coerceParameterDefault} for the measured parsed shapes.
      parameters[name] = coerceParameterDefault(paramDef.Default, paramDef.Type);
      this.logger.debug(
        `Parameter ${maskInherited(name)}: using default value ${maskInherited(
          stringifyParameterForLog(paramDef, paramDef.Default)
        )}`
      );
      continue;
    }
  }

  return parameters;
}

/**
 * Evaluate all conditions in the template
 *
 * Conditions are defined in the Conditions section of the CloudFormation template
 * and can reference parameters and pseudo parameters
 */
export async function evaluateConditions(
  this: IntrinsicFunctionResolver,
  context: ResolverContext
): Promise<Record<string, boolean>> {
  // `Object.create(null)` (issue #2767). This is the PRODUCER of the bag
  // `resolveIf` and `filterResourcesByCondition` read, and every key in it is
  // a template-controlled condition NAME: on a plain object the memo test
  // below answered for an `Object.prototype` member before the definition was
  // ever evaluated, and `conditions['__proto__'] = false` routed through the
  // inherited setter and was lost, so a resource CloudFormation omits was
  // kept. Unlike `resolveValue`'s bag this one holds only booleans and is
  // never coerced or `Object.assign`ed -- its three readers index it or call
  // `Object.keys` -- so the null prototype costs nothing here.
  const conditions: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
  const templateConditions = context.template.Conditions;
  // See `assumedConditionNames`. `inProgress` holds the evaluation path, so
  // marking it whenever a guess is made or read taints every condition whose
  // value that guess fed.
  const assumed = new Set<string>();
  recordAssumedConditions(conditions, assumed);

  if (!templateConditions || typeof templateConditions !== 'object') {
    return conditions;
  }

  // A CFn Condition can reference ANOTHER named condition via
  // `{Condition: OtherName}` inside `Fn::And` / `Fn::Or` / `Fn::Not`
  // (issue #840). Evaluation must therefore be DEPENDENCY-ORDERED, not
  // declaration-ordered: a composite condition referencing `IsPremium`
  // must see `IsPremium`'s evaluated boolean, regardless of which is
  // declared first. We evaluate lazily/recursively with memoization
  // (the `conditions` map doubles as the memo cache) and an in-progress
  // set as a cycle guard. `{Condition: X}` references inside the
  // definitions resolve through `evaluateByName` via the
  // `conditionResolver` hook threaded onto the context.
  // A PRIVATE needle bag when the caller brought none (issue #2748 review).
  // `maskSecretsRaw` is a no-op against absent bags, so the mask below is
  // worth exactly what this pass RECORDED — and two of the four callers hand
  // in a context literal with no bag at all: `cli/commands/diff-recursive.ts`
  // and `cli/commands/import.ts` (which also omits `skipDynamicReferences`,
  // so it really does fetch the secret). `deploy-engine`'s
  // `buildResolverContext` and `cdkd scrub`'s `resolverContext` both supply
  // one. MEASURED before this existed: `cdkd diff` on a template whose
  // `Conditions` entry assembles a reference out of its own resolved secret
  // printed the password in full at default verbosity.
  //
  // Fixed HERE rather than at the two call sites so a fifth caller cannot
  // reopen it — the per-site habit is what this class keeps costing.
  //
  // PRIVATE, and it dies with this call: it is never returned, never merged
  // into a caller's bag, and its `WeakMap`-keyed associations die with it. So
  // the bag this function INVENTS cannot become a redaction needle anywhere.
  //
  // That is a claim about the private bag ONLY, not about condition
  // evaluation in general — an earlier wording said "a conditions bag must
  // not reach an outputs bag" and was false for one caller: `cdkd scrub`
  // deliberately hands this pass its OUTPUTS bag (`scrub.ts`, so a condition's
  // secret IS a needle over `state.outputs` there), which is that caller's
  // decision and not something to undo from here. A caller that brought a bag
  // keeps it — the resolver fills it in place and the caller is entitled to
  // what this pass records.
  //
  // Residual, and it is NARROWER than it was: `maskSecretsInText` matches
  // LITERALLY, so a plaintext that reaches the message RE-ENCODED is not
  // masked by the bag alone. Issue
  // [#2759](https://github.com/go-to-k/cdkd/issues/2759) — which claimed
  // this note — closed the two spellings this file produces, each at the
  // site that still holds both forms: `Fn::Base64` registers its OUTPUT as a
  // derived mask-only needle, and the JSON encodings AT `maskValueLeaves`'s
  // call sites are leaf-masked before `stringifyValue` / `JSON.stringify`
  // runs.
  //
  // NOT A UNIVERSAL OVER THE FILE, and the qualifier is load-bearing: two
  // drafts of this note claimed one and a reviewer's grep refuted each. Since
  // issue #3114 the four `Fn::GetAtt` value lines, `Resolved Ref to
  // parameter` and the user-provided parameter line ARE among those call
  // sites, leaf-masked before `stringifyAttributeForLog` /
  // `stringifyParameterForLog` encodes them; the SSM-resolved and `Default`
  // parameter lines still pass the raw value to `stringifyParameterForLog`
  // and mask only its output. The checkable statement is
  // "`maskValueLeaves`'s call sites", not "every encoding". The FILE-WIDE
  // question -- "is every interpolating site masked or deliberately not" --
  // was answered by an AST checker that go-to-k/cdkd#3435 DELETED as
  // high-maintenance tooling, and nothing asks it now; each render is pinned
  // by its emitted bytes instead.
  //
  // WHAT STAYS OPEN, stated rather than implied: a re-encoding cdkd does not
  // perform — a URL escaping, a hash, an `Fn::Join` that transforms rather
  // than concatenates — still yields text no needle matches, and there is no
  // site at which to derive one. And the `Fn::Base64` derived needle is
  // MASK-ONLY, which `secret-redaction.ts` deliberately withholds from the
  // persist path's SUBSTRING arm — so an encoding EMBEDDED in a longer leaf
  // (`{"Fn::Join": ["", [{"Fn::Base64": <ref>}, "="]]}`) is not a whole-leaf
  // match and still reaches `state.json`. That withholding is a decision of
  // that module's, not an oversight here: an inline `***` is a value no
  // consumer can recognise or re-resolve, so widening it would be a
  // different and larger change. The needle FLOOR is a separate residual
  // (issues [#2516](https://github.com/go-to-k/cdkd/issues/2516) /
  // [#2745](https://github.com/go-to-k/cdkd/issues/2745)): a plaintext below
  // `MIN_NEEDLE_LENGTH` embedded in a longer string reaches only the
  // substring arm, so an `Fn::Base64` over such an input registers its
  // encoding only when the input has a registered log twin, its own pass's
  // or one a parent stack registered (the position mask, issues #3119 /
  // #3114), and nothing otherwise.
  const maskingContext: ResolverContext = context.recordedSecretValues
    ? context
    : { ...context, recordedSecretValues: new Map<string, string>() };

  const inProgress = new Set<string>();

  const evaluateByName = async (name: string): Promise<boolean> => {
    // `Object.hasOwn` rather than `in`. UNFALSIFIABLE while the bag above
    // carries no prototype -- a probe restoring `in` here is green, and that
    // is stated rather than left for the next reader to discover -- but this
    // memo decides whether a definition is evaluated at all, so it should not
    // depend on a property of a line 50 above it.
    if (Object.hasOwn(conditions, name)) {
      if (assumed.has(name)) for (const dependent of inProgress) assumed.add(dependent);
      return conditions[name]!;
    }
    if (inProgress.has(name)) {
      throw new Error(
        `Circular condition reference detected involving condition ${quotedRender(this.displayMasked(name, maskingContext), '"')}`
      );
    }
    // The TEMPLATE's own `Conditions` object comes from `JSON.parse`, so this
    // read needs the same own-key test (issue #2767): a condition named
    // `constructor` found the `Object` FUNCTION as its "definition", skipped
    // the not-declared arm below, and was handed to the resolver as a
    // condition body.
    const bag = templateConditions as Record<string, unknown>;
    const definition = Object.hasOwn(bag, name) ? bag[name] : undefined;
    if (definition === undefined) {
      // A `{Condition: X}` reference to an undeclared condition. Match the
      // Fn::If not-found behavior: warn and treat as false.
      this.logger.warn(
        `Condition ${this.displayMasked(name, maskingContext)} not found in template, assuming false`
      );
      conditions[name] = false;
      assumed.add(name);
      for (const dependent of inProgress) assumed.add(dependent);
      return false;
    }

    inProgress.add(name);
    try {
      // Resolve the definition with the condition-reference hook active so
      // nested `{Condition: Y}` references recurse through evaluateByName.
      const result = await this.resolveValue(definition, {
        ...maskingContext,
        conditionResolver: evaluateByName,
      });
      const value = Boolean(result);
      conditions[name] = value;
      // `value` carries nothing: it is `Boolean(result)`.
      this.logger.debug(
        `Evaluated condition ${this.displayMasked(name, maskingContext)} = ${value}`
      );
      return value;
    } finally {
      inProgress.delete(name);
    }
  };

  // Drive evaluation of every declared condition. Failures (including a
  // detected cycle) downgrade that condition to false rather than aborting
  // the whole deploy, matching the prior per-condition error tolerance.
  for (const name of Object.keys(templateConditions)) {
    try {
      // Its own drain budget, like `resolve`'s: a condition operand can
      // nest lists and joins just as deep, and without a store every level
      // would take a fresh cap (issue #2563). Opened per condition rather
      // than around the loop, because one condition's slow parts should not
      // spend the next one's budget. A condition that depends on another
      // re-enters `evaluateByName` INSIDE this store and inherits it.
      //
      // `withSharedDrainBudget` and NOT `drainDeadlines.run`, which always
      // installs a FRESH store. Both halves matter and the first cut of
      // this had only one: with no caller budget open, each condition gets
      // its own cap, which is what a downgraded-and-continue loop wants --
      // one condition's slow parts must not spend the next one's. INSIDE a
      // caller's budget it inherits instead, so the caller's aggregate
      // bound actually holds. `cdkd import` made that reachable: it calls
      // `evaluateConditions` inside the wrap around its resource loop
      // (`import.ts`), with a lock held and `saveState` downstream, so
      // `run` there would have cost `#conditions x` the cap on top.
      await withSharedDrainBudget(() => evaluateByName(name));
    } catch (error) {
      // MASKED (issue #2748). This catch renders a resolver error verbatim
      // at WARN level, so it is reached on an ordinary `cdkd deploy` with no
      // `--verbose`. `evaluateByName` reaches `resolveDynamicReferences`
      // below, and `resolveSub` / `resolveJoin` re-enter it with the
      // ASSEMBLED string — so a `Conditions` entry that builds a reference
      // out of a value this same pass resolved from a secret makes the
      // lookup fail NAMING that plaintext (`key 'key-<password>' not found
      // in secret '<id>'` — the EMBEDDED form, which is the one the residual
      // below is about; a key that is the plaintext WHOLE reads
      // `key '<password>' not found`). That throw is masked AT THE THROW since issue
      // [#2827](https://github.com/go-to-k/cdkd/issues/2827); this sentence
      // used to say it was "thrown unmasked by construction because every
      // other consumer masks at ITS own boundary", which that fix retired. Same class as the
      // lookup echoes issue #2728 closed further down this file, and this sink
      // was missed there because it lives in a different method and renders
      // ANY error, not only a lookup echo. What used to stand here as the
      // residual — a plaintext shorter than `MIN_NEEDLE_LENGTH` (4) embedded
      // in a longer name rather than whole, which no needle matches — is
      // CLOSED for the names THIS PASS ASSEMBLED, by issue
      // [#3150](https://github.com/go-to-k/cdkd/issues/3150): such a name is
      // masked BY POSITION, out of the log twin `resolveSub` / `resolveJoin`
      // BUILD for the assembled string — REGISTERED (`rememberLogTwin`) once
      // the substitution completes, so a later `Fn::FindInMap` throw finds
      // it, and HANDED to the dynamic-reference loop as a parameter for a
      // throw raised INSIDE that call, which is the example above: it prints
      // `key 'key-***' not found`
      // (`tests/unit/cli/import-resolver-error-masking.test.ts` pins it, and
      // `intrinsic-resolver-name-argument-log-twin.test.ts` pins this sink's
      // whole sentence). Do not shorten that to "registered": on the example's
      // own path `rememberLogTwin` has not run yet.
      //
      // What is closed is exactly what a twin can cover, and NOTHING WIDER:
      // a name this pass assembled. Any other text reaching this sink
      // carries no twin and gets the needle mask alone, whose substring arm
      // has a four-character floor — so a sub-floor plaintext can still
      // print here. **The ways that happens are NOT enumerated here, and a
      // count written here would be wrong.** State the DANGER DIRECTION;
      // each instance is stated where it is OWNED, which is the only place
      // that stays true when that code moves: an AWS SDK's text this sink
      // merely forwards
      // ([#3171](https://github.com/go-to-k/cdkd/issues/3171)); a name this
      // resolver hands to another module unmasked, where that module quotes
      // it back — `resolveGetStackOutput`'s state read was that, and
      // [#3234](https://github.com/go-to-k/cdkd/issues/3234) closed it by
      // masking at the hand-over frame, while the `Fn::ImportValue` sibling
      // still masks its caught message with the BAGS alone and so keeps the
      // positional half of the class open; and a PRODUCER's own output key,
      // whose bound `describeAvailableOutputs`' docstring owns.
      // Four review rounds on PR go-to-k/cdkd#3176 each found one more that
      // a tally here had missed, and `.claude/rules/layout-deployment-secrets.md`
      // records five rounds on go-to-k/cdkd#2803 refuting the same shape of
      // sentence. Do not restore a count.
      this.logger.warn(
        this.displayMasked(
          `Failed to evaluate condition ${name}: ${error instanceof Error ? error.message : String(error)}, assuming false`,
          maskingContext
        )
      );
      conditions[name] = false;
      assumed.add(name);
      inProgress.delete(name);
    }
  }

  return conditions;
}

/**
 * Resolve ONE key of a bag, recovering per key when the caller opted in.
 *
 * Shared by the two sequential key walks that had this defect — the generic
 * object walk in {@link resolveValue} and `resolveSub`'s variable map — so
 * the recovery and the REFUSAL partition cannot drift between them. Both were
 * bare `for … await` loops, so the first failing key abandoned every later
 * one (issue go-to-k/cdkd#3218; the variable map was found beside it and is
 * the same defect, not a second one).
 *
 * An abandoned key keeps its INPUT value, matching what the per-token
 * recovery does with an unfetched token. That is safe only because the bag
 * obliges its consumer to fail the operation — `ResolverContext`'s field doc
 * carries the obligation and why it is not optional.
 *
 * **The log-twin invariant (issue go-to-k/cdkd#3100) under the KEY ordering**,
 * which is a separate claim from the token one and was missing while the
 * token half was stated twice. `matches` / `twinTokens` are built inside
 * `resolveDynamicReferencesWithLogTwin`, once per STRING LEAF, so the
 * pairing is leaf-local: a key abandoned beside a leaf never enters that
 * function for it and cannot shift its indices. Skipping a key changes only
 * WHICH leaves are visited, never how any visited leaf pairs — and a leaf
 * that is skipped pairs nothing at all rather than pairing wrongly. Fenced
 * by the key case in
 * `tests/unit/deployment/intrinsic-resolver-recovered-sibling-log-masking.test.ts`.
 *
 * **Both call sites reach it only when a bag is present, and that gate lives
 * at the CALL SITE rather than in here on purpose.** `resolveValue` recurses
 * once per nesting level, so routing every level through a second async
 * frame roughly doubles the resolver's frame cost for a deeply nested
 * property and lowers the depth at which it raises `RangeError`. An early
 * return inside this method would not help — the frame is created by the
 * call. Gating outside leaves every caller that passes no bag (deploy, diff,
 * drift, rollback) on exactly the pre-#3218 call shape, which is what makes
 * "a bagless caller is unchanged" true in the stack dimension too. Measured,
 * not reasoned: the heavier shape inverted the frame-weight ordering that
 * `tests/unit/cli/import-observed-baseline-refusal-matrix.test.ts` bisects
 * for, and that is how it was caught rather than shipped.
 */
/** @internal */
export async function resolveKeyUnit(
  this: IntrinsicFunctionResolver,
  key: string,
  val: unknown,
  context: ResolverContext,
  abandoned: AbandonedResolution[]
): Promise<unknown> {
  try {
    return await this.resolveValue(val, context);
  } catch (err) {
    // The refusal gate, in the same order as the token loop's catch.
    if (isDeliberateResolutionRefusal(err)) throw err;
    abandoned.push(this.abandonedUnit('key', key, err, context, val));
    return val;
  }
}
