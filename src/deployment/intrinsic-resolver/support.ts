import { stringifyValue } from '../../utils/stringify.js';
import { displayIdent, UNRENDERABLE } from '../../utils/display-safe.js';
import { isInertUnquoted } from '../../utils/pasteable-command.js';
import { isListParameterType } from '../../utils/parameter-types.js';
import { MIN_NEEDLE_LENGTH, SECRET_MASK, type RecordedSecretValues } from '../secret-redaction.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
export * from './ref-values.js';
export * from './context.js';
export * from './account-drain.js';

/**
 * Collect every name referenced (Ref / Fn::Sub placeholder / other intrinsic
 * argument) by the sections cdkd actually evaluates: Resources, Outputs, and
 * Conditions. Deliberately excludes `Rules` (assertion-only, never evaluated
 * by cdkd — CloudFormation evaluates them pre-deployment, cdkd has no
 * equivalent gate) and `Metadata`. Used to avoid resolving template
 * parameters nothing consumes.
 */
export function collectReferencedParameterNames(template: CloudFormationTemplate): Set<string> {
  const parser = new TemplateParser();
  const referenced = new Set<string>();
  for (const section of [template.Resources, template.Outputs, template.Conditions]) {
    if (!section || typeof section !== 'object') continue;
    for (const name of parser.extractReferences(section)) {
      referenced.add(name);
    }
  }
  return referenced;
}

/**
 * CloudFormation Parameter definition
 */
export interface ParameterDefinition {
  Type: string;
  Default?: unknown;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  MinLength?: number;
  MaxLength?: number;
  MinValue?: number;
  MaxValue?: number;
  Description?: string;
  ConstraintDescription?: string;
  NoEcho?: boolean;
}

/**
 * Is `name` a template Parameter this caller has left UNBOUND — declared, with
 * no `Default`, and with no value supplied?
 * (issue [#2285](https://github.com/go-to-k/cdkd/issues/2285))
 *
 * ONE predicate, consulted VERBATIM by the two sites that ask this same
 * question, rather than two spellings that agree until they do not:
 *
 *  - {@link IntrinsicFunctionResolver.resolveParameters} raises
 *    `Parameter <name> is required ...` for exactly this population. It is the
 *    UPFRONT validation, and it runs on every path that binds parameters at
 *    all (`deploy-engine`'s step 2.5, `diff-recursive`, `scrub`, `import`), so
 *    a plain `cdkd deploy` never reaches the resolver with this population at
 *    all -- it has already failed.
 *  - {@link IntrinsicFunctionResolver.subPlaceholderNamesADeclaredTemplateEntity}
 *    answers for the callers that CATCH that error and resolve anyway.
 *    `cdkd import` is the live one -- EVERY mode of it, not only
 *    `--migrate-from-cloudformation`: `resolveImportedProperties` sits on
 *    `importCommand`'s unconditional flow, so auto / selective / hybrid all
 *    reach it. It logs the parameter-resolution failure, RETRIES over the
 *    template's `Default`-carrying parameters alone (issue
 *    [#2321](https://github.com/go-to-k/cdkd/issues/2321)), and resolves
 *    against that partial bag on a context that is NOT `bestEffort`. The
 *    retry binds every parameter it can, and a parameter with no `Default` is
 *    exactly what it cannot bind -- so this population still arrives here,
 *    and a `${Tier}` over such a parameter used to be written verbatim into
 *    the imported resource's persisted properties, and from there into the
 *    next deploy's desired bag, which is how the literal reaches AWS.
 *    (The fixtures spell that parameter `Stage`; this doc says `Tier` because
 *    `import.ts`'s own #2321 comments use `Stage` for the opposite role -- the
 *    parameter that DOES carry a `Default` -- and one name for both roles in
 *    one change is how a reader mis-reads which population is which.)
 *    Before #2321 that caller continued with an EMPTY bag instead; the note
 *    below turns on the difference, and on what survives it.
 *
 * A key PRESENT with an `undefined` value is not a binding: `resolveParameters`
 * falls through such a key to the `Default` check, so the predicate must too.
 * That single edge is the reason this is shared code and not a paraphrase.
 *
 * A `Default`-carrying parameter the caller never merged is DELIBERATELY not
 * in this population, and issue
 * [#2321](https://github.com/go-to-k/cdkd/issues/2321) NARROWED the population
 * that reaches here without emptying it. Both halves matter, and an earlier
 * revision of this paragraph shipped only the first, claiming the exclusion
 * "describes a population that no live path produces". That was FALSE, and the
 * counter-example is in the very change that prompted the rewrite.
 *
 * What #2321 fixed is `import`'s retry SUCCESS path. `resolveParameters`
 * merges every `Default` it sees on the path that succeeds; `import` is the
 * one caller that catches its throw on a non-`bestEffort` context, and it now
 * retries over exactly the `Default`-carrying parameters instead of continuing
 * with an empty bag, so a `Default`-carrying parameter reaching the refusing
 * site from THAT path arrives BOUND. (`diff-recursive` and `scrub` also catch,
 * but both set `bestEffort: true` and `rethrowStructuralSubFailure` returns on
 * that flag BEFORE consulting this predicate, so neither reaches the refusing
 * site at all; `deploy-engine` does not catch.)
 *
 * What SURVIVES is `import`'s retry FAILURE path, and it is a live producer,
 * not a hypothetical one. When the `Default`-only retry itself throws -- an
 * SSM-typed default whose `GetParameter` is rejected is the reachable case --
 * `resolveImportedProperties` falls back to an empty bag rather than aborting
 * an import that already succeeded against AWS, and `import.ts` omits the
 * `parameters` key entirely when the bag is empty, so the context arrives with
 * `parameters: undefined`. A `Default`-carrying parameter is then unbound at
 * the refusing site, and this exclusion is the ONLY thing standing between it
 * and a refusal.
 *
 * So the clause below is PRESENT-TENSE LOAD-BEARING, not a courtesy kept for
 * some future caller: that fallback path exists right now, and the clause is
 * what keeps a `Default`-carrying parameter off the refusing site on it.
 * What removing the clause would DO downstream is deliberately not asserted
 * here -- it was not probed, and the residual note below is what carries the
 * observable consequence. It is also what
 * {@link IntrinsicFunctionResolver.subPlaceholderNamesADeclaredTemplateEntity}
 * cross-references.
 *
 * The cost of that fallback is that the #2321 defect persists on it -- the
 * placeholder is kept and written verbatim -- which is a KNOWN residual rather
 * than an oversight; `import.ts` records it at the fallback, and
 * `tests/unit/cli/import.test.ts` pins it so the residual cannot widen
 * silently.
 */
export function isUnboundTemplateParameter(
  name: string,
  template: CloudFormationTemplate | undefined,
  boundParameters: Record<string, unknown> | undefined
): boolean {
  const declaredParameters = template?.Parameters;
  if (
    declaredParameters === undefined ||
    declaredParameters === null ||
    typeof declaredParameters !== 'object'
  ) {
    return false;
  }
  if (!Object.hasOwn(declaredParameters, name)) return false;
  const definition = declaredParameters[name] as ParameterDefinition | undefined;
  if (definition === undefined || definition === null || typeof definition !== 'object') {
    return false;
  }
  if ('Default' in definition) return false;
  if (boundParameters === undefined) return true;
  // `Object.hasOwn` to match the declared-side test above (issue #2767):
  // a bare `in` read a parameter named `constructor` as BOUND, suppressing
  // the #2285 refusal for exactly the shape it exists to catch.
  return !Object.hasOwn(boundParameters, name) || boundParameters[name] === undefined;
}

/**
 * Does coercing to `type` risk destroying the plaintext cdkd redacts against?
 *
 * DERIVED from {@link coerceParameterTypedValue}, never enumerated beside it.
 * The previous shape was a hand-kept set naming `Number` / `List<Number>`,
 * whose doc cleared `CommaDelimitedList` as safe because it "produces an array
 * of strings (both of which the recording scan and the redactor handle)". That
 * holds only for a comma-FREE secret -- and the dominant Secrets Manager shape
 * is a JSON blob, which is nothing but commas, so `,`-splitting shreds the
 * plaintext into fragments matching neither arm of
 * {@link inheritedSecretsCarriedBy}. An audited allow-list was wrong about one
 * of its own three entries, which is why this is now measured, not listed.
 *
 * Probe the REAL coercion with a canary carrying the separators the arms use --
 * a comma and surrounding whitespace -- and call the type risky when the canary
 * does not survive as one string. A `Type` added to the switch is covered the
 * day it is added, with nothing to keep in sync.
 *
 * The DEPLOY path does better: `refuseCoercedInheritedSecret` measures the loss
 * on the ACTUAL value, so a comma-free secret in a `CommaDelimitedList` still
 * works. This coarser predicate is for `cdkd diff`, which holds no secrets bag
 * and therefore cannot measure.
 */
export const SECRET_IDENTITY_CANARY = 'a, b';

export function parameterTypeMayLoseSecretIdentity(type: string): boolean {
  return coerceParameterTypedValue(SECRET_IDENTITY_CANARY, type) !== SECRET_IDENTITY_CANARY;
}

/**
 * ONE definition of parameter-type coercion, at module scope so
 * {@link parameterTypeMayLoseSecretIdentity} probes the same code the resolver
 * runs rather than a copy of it.
 *
 * WHICH TYPES ARE LISTS is asked of the SHARED {@link isListParameterType}
 * rather than enumerated in the `switch` (issue #2347). The `switch` named only
 * `List<Number>` and `CommaDelimitedList`, so the nine `List<AWS::...>` types
 * CloudFormation defines -- `List<AWS::EC2::Subnet::Id>` and its siblings --
 * fell to `default` and a `Ref` to such a parameter resolved to the raw
 * comma-joined STRING, while `src/synthesis/macro-expander.ts` held the wider,
 * correct view of the very same question. Both sites now read one predicate.
 *
 * `List<Number>` keeps its own arm because it is the only list type whose
 * ELEMENTS are not strings; every other list type produces trimmed strings,
 * which is what CloudFormation says a `Ref` to one returns.
 */
export function coerceParameterTypedValue(value: string, type: string): unknown {
  switch (type) {
    case 'Number':
      return Number(value);
    case 'List<Number>':
      return value.split(',').map((v) => Number(v.trim()));
  }
  // `CommaDelimitedList` and the `List<...>` family. CloudFormation space-trims
  // each member of a comma-delimited value, so `.trim()` is the wire semantics,
  // not a convenience.
  if (isListParameterType(type)) {
    return value.split(',').map((v) => v.trim());
  }
  // `String`, the AWS-specific SCALAR types, the whole
  // `AWS::SSM::Parameter::Value<...>` family (whose value is a Parameter Store
  // KEY, not the resolved list), and any unrecognised spelling.
  return value;
}

/**
 * Bind a template-declared `Default` the way the USER-SUPPLIED path binds a
 * value (issue
 * [#2367](https://github.com/go-to-k/cdkd/issues/2367)).
 *
 * `resolveParameters` writes `parameters[name]` at three sites and only the
 * user-supplied one asked the coercion anything, so a parameter declared
 * `Type: CommaDelimitedList` with `Default: "a,b,c"` and no CLI override
 * reached every consumer as the raw string -- `Fn::Select` over it threw
 * `Fn::Select: list must be an array, got string`, and a bare `Ref` handed the
 * provider a comma-joined scalar where the resource schema declares a list.
 * The defect predates the #2347 widening: it hits `CommaDelimitedList` and
 * `List<Number>`, the two list types the `switch` has recognised all along.
 *
 * CloudFormation's own documentation is written in exactly these terms --
 * `parameters-section-structure.html`'s worked example declares
 * `VpcAzs: {Type: CommaDelimitedList, Default: "us-west-2a, us-west-2b,
 * us-west-2c"}` and then reads it with `Fn::Select`, which is the case that
 * threw.
 *
 * ONLY A STRING IS COERCED, and that is the whole of the rule. `Default` is
 * typed `unknown` because it is whatever the template parser produced, and the
 * shapes are not hypothetical -- measured 2026-08-29 on both parsers cdkd
 * feeds this from:
 *
 *  - `aws-cdk-lib`'s `CfnParameter._toCloudFormation` emits `Default:
 *    this.default` with no conversion, so `{type: 'Number', default: 42}`
 *    synthesizes the JSON NUMBER `42`, and `{type: 'CommaDelimitedList',
 *    default: ['a','b','c']}` synthesizes a JSON ARRAY;
 *  - `parseCfnTemplate` (`src/cli/yaml-cfn.ts`), on the `cdkd import
 *    --migrate-from-cloudformation` / `cdkd export` path, resolves `Default:
 *    42` to a number, `Default: "42"` to a string, a YAML sequence to an array
 *    and `Default: true` to a boolean.
 *
 * FOR THE SHAPES MEASURED ABOVE, a non-string default is already what the
 * declared type calls for -- `42` for a `Number`, `['a','b']` for a
 * `CommaDelimitedList` -- so coercing it could only damage it.
 * `String(['a,b','c'])` is `'a,b,c'`, which the split would then shred into
 * THREE elements, and `String(true)` would turn a boolean a consumer sees today
 * into text. Stringifying first is therefore not a harmless normalization, and
 * `coerceParameterTypedValue` takes a `string` precisely because parsing the
 * wire text is its whole job.
 *
 * THE CLAIM IS SCOPED TO THOSE SHAPES ON PURPOSE, because a mismatched pairing
 * is reachable and is NOT in it: YAML admits `Type: CommaDelimitedList` with
 * `Default: 42` or `Default: true`, and such a default is passed through as the
 * scalar it parsed to rather than becoming a one-element list. That is the
 * PRE-EXISTING behaviour, unchanged here and deliberately so -- a template
 * pairing a list type with a scalar default is malformed CloudFormation, and
 * inventing a coercion for it on a path that writes state is a bigger decision
 * than this fix.
 */
export function coerceParameterDefault(defaultValue: unknown, type: string): unknown {
  if (typeof defaultValue !== 'string') return defaultValue;
  return coerceParameterTypedValue(defaultValue, type);
}

/**
 * The inherited `plaintext -> expression` pairs that `value` CARRIES.
 *
 * ONE definition, shared by the RECORDING side
 * (`recordInheritedParameterSecrets`) and the REFUSAL side
 * (`refuseCoercedInheritedSecret`), because a refusal narrower than the
 * recording would let exactly the values it exists to catch through — and the
 * two drifting apart is how this class of bug reappears.
 *
 * TWO ARMS, mirroring the two `redactSecretsForState` performs, so the
 * recording side cannot be narrower than the redaction side:
 *
 * - WHOLE VALUE at any length — `{Ref: Param}` returning exactly the secret.
 * - SUBSTRING at or above {@link MIN_NEEDLE_LENGTH} — the parent built the
 *   parameter with an `Fn::Sub`, so the value is `postgres://u:<secret>@host`
 *   and only part of it is the secret. Short needles are excluded on this arm
 *   for the same reason the redactor excludes them: a 3-character secret
 *   matches half the alphabet's worth of ordinary identifiers.
 *
 * A LIST-TYPED parameter — any `List<...>` type or `CommaDelimitedList` — arrives as an
 * array, so the scan walks string elements too.
 */
export function inheritedSecretsCarriedBy(
  value: unknown,
  inherited: RecordedSecretValues
): Array<[string, string]> {
  const candidates: string[] = [];
  if (typeof value === 'string') {
    candidates.push(value);
  } else if (Array.isArray(value)) {
    for (const element of value) {
      if (typeof element === 'string') candidates.push(element);
    }
  }
  if (candidates.length === 0) return [];

  const carried: Array<[string, string]> = [];
  for (const [plaintext, expression] of inherited) {
    const hit = candidates.some(
      (candidate) =>
        candidate === plaintext ||
        (plaintext.length >= MIN_NEEDLE_LENGTH && candidate.includes(plaintext))
    );
    if (hit) carried.push([plaintext, expression]);
  }
  return carried;
}

/**
 * Render a parameter VALUE for a debug log line, honoring the definition's
 * `NoEcho` flag (issue #1329). `NoEcho: true` is the template author's
 * explicit "this value is sensitive" declaration — CloudFormation masks such
 * values everywhere it echoes them, so cdkd's `--verbose` output must not
 * print them either. Sibling of `stringifyAttributeForLog` (which redacts
 * `Fn::GetAtt` ATTRIBUTE values by name heuristic; here the author told us).
 */
export function stringifyParameterForLog(
  paramDef: ParameterDefinition | undefined,
  value: unknown
): string {
  if (paramDef?.NoEcho === true) return '<redacted>';
  return stringifyValue(value);
}

/**
 * `displayIdent` over text THIS file already sanitized, keeping its rule that
 * an ALTERED value takes a boundary (go-to-k/cdkd#3617). `displayIdent` tests
 * alteration against its own input, which here is already trimmed and blanked
 * -- so `ProdStack ` or `ProdStack<NBSP>` would print bare, byte-identical to
 * a genuine `ProdStack` (the #3164 spoof). Compared against the ORIGINAL, an
 * altered value is quoted even when what is left is plain.
 */
export function boundAltered(original: string, shown: string, maxCodePoints?: number): string {
  const bounded = displayIdent(shown, maxCodePoints === undefined ? undefined : { maxCodePoints });
  return shown !== original && !bounded.startsWith('"') && bounded !== UNRENDERABLE
    ? `${JSON.stringify(bounded.split(' [cut: ')[0])}${bounded.includes(' [cut: ') ? bounded.slice(bounded.indexOf(' [cut: ')) : ''}`
    : bounded;
}

/**
 * A render that may sit inside a quote of cdkd's own: the characters of
 * `displayIdent`'s plain identifier, plus `|` and `*` (a masked value prints
 * `***`) and `<` / `>` (a parameter type such as `List<Number>`). All are
 * literal inside either quote, and none is whitespace, so no pasted line,
 * sentence or clause can start or end inside the quoted render. Empty is
 * admitted, so an empty value still prints as `''`.
 */
export const QUOTABLE_RENDER = /^[A-Za-z0-9:_@./+=,~|*<>-]*$/;

/**
 * Whether a masked render may print BARE on a `--verbose` `Resolved …` line
 * (go-to-k/cdkd#4161): it is inert with its quotes stripped
 * (`isInertUnquoted`, the one measured predicate every pasted value is held
 * to, go-to-k/cdkd#4205) and is not a shell assignment word
 * ({@link LOG_ASSIGNMENT}). The mask `***` is the one exception to
 * `isInertUnquoted`: a `*` is a glob, but cdkd's own mask must stay readable,
 * and a glob as a clause's first word is go-to-k/cdkd#4249's class. Anything
 * else is DESCRIBED, never JSON-quoted (the go-to-k/cdkd#4229 decision): a
 * double quote still expands `$( )`, a backtick and `!`, and an unpaired `"`
 * above the selection turns every JSON boundary inside out. Empty is inert.
 */
export function isLogInert(text: string): boolean {
  return !LOG_ASSIGNMENT.test(text) && isInertUnquoted(text.split(SECRET_MASK).join('x'));
}

/**
 * Whether a JSON render may print as it is: it parses, and every key and
 * string leaf is {@link isLogInert}. Under an unpaired `"` above the line the
 * render's quotes flip and its strings come out bare, so each must be inert
 * on its own. Numbers, booleans and `null` are; the structure is not inert
 * (`[` / `]` glob and `{` / `}` brace-expand), but it runs nothing as an
 * argument, and a render as a clause's first word is go-to-k/cdkd#4249's.
 * A mask that ate a structural `"` (a secret spelled `abcd",`) fails the
 * parse and the render is described.
 */
export function isLogInertJson(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const inert = (node: unknown): boolean => {
    if (typeof node === 'string') return isLogInert(node);
    if (Array.isArray(node)) return node.every(inert);
    if (node !== null && typeof node === 'object') {
      return Object.entries(node).every(([key, child]) => isLogInert(key) && inert(child));
    }
    return true;
  };
  return inert(parsed);
}

/**
 * A render that would be a shell ASSIGNMENT word where it starts a pasted
 * clause (`Resolved Fn::Join: HISTFILE=~/victim`): it runs nothing the paste
 * harness sees, yet an interactive bash then truncates `~/victim` at exit,
 * and `PATH=.` hijacks every later command (go-to-k/cdkd#4243 review). The
 * APPEND form counts too: `PATH+=:.` appends the working directory to the
 * search path (on an unset variable `X+=v` is `X=v`). `isInertUnquoted`
 * admits a mid-word `=`, which is right for a value a command NAMES and wrong
 * for one that can start a pasted clause, so {@link isLogInert} rejects the
 * shape on its own.
 */
export const LOG_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Whether `stringifyValue` renders `value` as JSON (an array or object). */
export function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * The render inside `quote` when {@link QUOTABLE_RENDER} admits it, otherwise
 * `described` (go-to-k/cdkd#3950).
 *
 * The render is `displayMasked` / `displayLeaf` output, which keeps `'`, `"`,
 * `$`, `(`, a backtick and a space: inside cdkd's hand-written quote, a quote
 * in the value closed it, `$( )` runs inside double quotes anyway, and the
 * rest of a pasted sentence ran as shell. The test is on the RENDER, the text
 * that is printed, so the mask is kept: a masked `***` still prints quoted,
 * and nothing here reads the unmasked value.
 */
export function quotedRender(
  rendered: string,
  quote: "'" | '"',
  described = '(not shown: it is not a plain identifier)'
): string {
  return QUOTABLE_RENDER.test(rendered) ? `${quote}${rendered}${quote}` : described;
}
