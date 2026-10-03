/**
 * Condition verdicts a deploy RECORDS so `cdkd diff` can reuse them
 * (go-to-k/cdkd#4479).
 *
 * A condition that reads a parameter fed a secret `{{resolve:...}}` reference
 * has no verdict at plan time: `cdkd diff` never resolves a secret, and the
 * deploy evaluates the condition against the real value. Without a verdict,
 * an `Fn::If` on it takes its FALSE branch, so a stack deployed under the TRUE
 * branch diffs as a perpetual UPDATE.
 *
 * The deploy knows the verdict, so it records it, together with a FINGERPRINT
 * of everything the verdict was computed from:
 * - the condition's own definition, and the definition of every condition it
 *   reaches through `{Condition: X}`, transitively;
 * - the INPUT of every parameter that closure references. A secret-fed
 *   parameter contributes its `{{resolve:...}}` EXPRESSION, never the value;
 *   any other parameter contributes its bound value.
 *
 * The diff recomputes the fingerprint from the template and the inputs it
 * holds. It reuses a verdict only on an EXACT match. Then the deploy, given
 * the same definitions and inputs, computes the same verdict, unless the value
 * behind an unchanged expression changed. That is the diff's existing
 * contract for every secret-bearing property: it compares expressions, never
 * values. Any difference, or no record, keeps today's FALSE branch. Nothing is
 * inferred.
 *
 * NARROW BY DESIGN. A condition gets a fingerprint only when its closure is
 * built from `Fn::And` / `Fn::Or` / `Fn::Not` / `Fn::Equals`, `{Condition: X}`,
 * string literals and `{Ref: P}` to a DECLARED parameter whose input is
 * available. Each such parameter must be a scalar the deploy binds unchanged
 * (`coerceParameterTypedValue` is the identity), and must not be a `NoEcho`
 * parameter holding a plain value: a hash of a short secret can be brute
 * forced, so that value never enters the fingerprint. Every other shape gets
 * no fingerprint, so no record, and so the FALSE branch.
 *
 * SECURITY. A record holds a boolean and a sha256 digest. The boolean is one
 * bit: whether a parameter equals a literal the template spells, which the
 * branch values state holds normally show already. The digest's inputs are
 * template text, `{{resolve:...}}` expressions (which state already holds) and
 * plain parameter values. On the deploy side {@link deployConditionInputs}
 * marks every value that carries an inherited secret unavailable, so no
 * resolved secret enters the digest.
 */
import { createHash } from 'node:crypto';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { RecordedConditionVerdict, StackState } from '../types/state.js';
// From the leaf modules, not the `intrinsic-function-resolver.js` barrel:
// deploy-engine tests mock that barrel wholesale, and this module runs inside
// every deploy.
import { carriesDynamicReference } from './intrinsic-resolver/context.js';
import { coerceParameterTypedValue } from './intrinsic-resolver/support.js';
import { conditionsAssumedFalse } from './assumed-conditions.js';
import {
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  printingCorpusOf,
  redactSecretsForState,
} from './secret-redaction.js';
import type { RecordedSecretValues } from './secret-redaction.js';
import { nullPrototypeRecord } from '../utils/own-keys.js';

/**
 * What a parameter contributes to a fingerprint. `token` is a value fed from a
 * secret dynamic reference, carried as its `{{resolve:...}}` expression;
 * `value` is any other bound value. `undefined` means the input is not
 * available (for example a parameter the diff could not bind), so the
 * condition gets no fingerprint.
 */
export type ConditionParameterInput =
  | { kind: 'token'; expression: string }
  | { kind: 'value'; value: unknown }
  | undefined;

/**
 * The one way both sides build a fingerprint's parameter inputs, so the deploy
 * that records and the diff that compares cannot drift apart.
 * - `tokens`: each secret-fed parameter's `{{resolve:...}}` expression;
 * - `bound`: every other parameter's bound value;
 * - `unavailable`: parameters with no usable input (the diff's unbound ones).
 * A token wins over a bound value for the same name.
 */
export function conditionInputsFrom(args: {
  tokens: Readonly<Record<string, string>>;
  bound: Readonly<Record<string, unknown>>;
  unavailable?: ReadonlySet<string>;
}): (parameter: string) => ConditionParameterInput {
  return (parameter) => {
    if (args.unavailable?.has(parameter)) return undefined;
    if (Object.hasOwn(args.tokens, parameter)) {
      return { kind: 'token', expression: args.tokens[parameter]! };
    }
    if (Object.hasOwn(args.bound, parameter)) {
      return { kind: 'value', value: args.bound[parameter] };
    }
    return undefined;
  };
}

/** The version of the fingerprint's input layout; a change invalidates every record. */
const FINGERPRINT_LAYOUT = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON with object keys sorted, so equal values always hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  // `undefined`, a function or a symbol has no JSON form. The bare word is no
  // JSON encoding of anything, so it cannot collide with a real value.
  return encoded === undefined ? 'undefined' : encoded;
}

/**
 * Walks one condition definition in the modelled shape, collecting the
 * parameters and conditions it references. Returns false on any other shape.
 */
function walkModelledDefinition(
  value: unknown,
  declaredParameters: ReadonlySet<string>,
  parameters: Set<string>,
  conditions: Set<string>
): boolean {
  if (typeof value === 'string') return !carriesDynamicReference(value);
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const [key] = keys as [string];
  const operand = value[key];
  switch (key) {
    case 'Ref':
      if (typeof operand !== 'string' || !declaredParameters.has(operand)) return false;
      parameters.add(operand);
      return true;
    case 'Condition':
      if (typeof operand !== 'string') return false;
      conditions.add(operand);
      return true;
    case 'Fn::Equals':
      return (
        Array.isArray(operand) &&
        operand.length === 2 &&
        operand.every((element) =>
          walkModelledDefinition(element, declaredParameters, parameters, conditions)
        )
      );
    case 'Fn::Not':
      return (
        Array.isArray(operand) &&
        operand.length === 1 &&
        walkModelledDefinition(operand[0], declaredParameters, parameters, conditions)
      );
    case 'Fn::And':
    case 'Fn::Or':
      return (
        Array.isArray(operand) &&
        operand.length >= 1 &&
        operand.every((element) =>
          walkModelledDefinition(element, declaredParameters, parameters, conditions)
        )
      );
    default:
      return false;
  }
}

/**
 * The fingerprint of `name`'s verdict, or `undefined` when the condition is
 * outside the modelled shape or a parameter input is unavailable. See the
 * module doc. `hasToken` reports whether any input was a secret-fed token: only
 * such a condition is worth recording.
 */
export function conditionFingerprint(
  template: CloudFormationTemplate,
  name: string,
  inputOf: (parameter: string) => ConditionParameterInput
): { fingerprint: string; hasToken: boolean } | undefined {
  const definitions = template.Conditions;
  if (!isPlainObject(definitions)) return undefined;
  const declared = isPlainObject(template.Parameters) ? template.Parameters : {};
  const declaredNames = new Set(Object.keys(declared));

  const closure = nullPrototypeRecord<unknown>();
  const parameters = new Set<string>();
  const pending = [name];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (Object.hasOwn(closure, current)) continue;
    if (!Object.hasOwn(definitions, current)) return undefined;
    const definition = definitions[current];
    const referenced = new Set<string>();
    if (!walkModelledDefinition(definition, declaredNames, parameters, referenced)) {
      return undefined;
    }
    closure[current] = definition;
    for (const next of referenced) {
      // A reference cycle is a template CloudFormation refuses; the evaluator
      // downgrades it to an assumed FALSE, so it is never recorded.
      if (next === name) return undefined;
      pending.push(next);
    }
  }

  const inputs = nullPrototypeRecord<unknown>();
  let hasToken = false;
  for (const parameter of parameters) {
    const definition = declared[parameter];
    const type = isPlainObject(definition) ? definition['Type'] : undefined;
    if (typeof type !== 'string') return undefined;
    const input = inputOf(parameter);
    if (input === undefined) return undefined;
    if (input.kind === 'token') {
      if (!carriesDynamicReference(input.expression)) return undefined;
      // Only where the deploy binds the resolved string as it is: a list or
      // `Number` type coerces it into another value.
      if (coerceParameterTypedValue(input.expression, type) !== input.expression) {
        return undefined;
      }
      inputs[parameter] = { token: input.expression };
      hasToken = true;
    } else {
      if (isPlainObject(definition) && definition['NoEcho'] === true) return undefined;
      if (typeof input.value !== 'string') return undefined;
      if (carriesDynamicReference(input.value)) return undefined;
      if (coerceParameterTypedValue(input.value, type) !== input.value) return undefined;
      inputs[parameter] = { value: input.value };
    }
  }

  const digest = createHash('sha256')
    .update(canonicalJson({ layout: FINGERPRINT_LAYOUT, conditions: closure, parameters: inputs }))
    .digest('hex');
  return { fingerprint: `sha256:${digest}`, hasToken };
}

/** Every condition name an `Fn::If` reachable from a value names. */
function collectIfConditionNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectIfConditionNames(element, names);
    return;
  }
  if (!isPlainObject(value)) return;
  const ifArgs = value['Fn::If'];
  if (Array.isArray(ifArgs) && typeof ifArgs[0] === 'string') names.add(ifArgs[0]);
  for (const nested of Object.values(value)) collectIfConditionNames(nested, names);
}

/**
 * The conditions `cdkd diff` reads a verdict of: each resource's or output's
 * `Condition`, and each one an `Fn::If` names inside a resource or output.
 * Given the deploy's `conditions`, an entry whose `Condition` is FALSE
 * contributes only that name: it is pruned, so nothing inside it is deployed.
 */
export function conditionsReadByDiff(
  template: CloudFormationTemplate,
  conditions?: Readonly<Record<string, boolean>>
): Set<string> {
  const names = new Set<string>();
  for (const section of [template.Resources, template.Outputs] as unknown[]) {
    if (!isPlainObject(section)) continue;
    for (const entry of Object.values(section)) {
      if (!isPlainObject(entry)) continue;
      const gate = entry['Condition'];
      if (typeof gate === 'string') {
        names.add(gate);
        // An entry the verdicts PRUNE is never deployed, so no `Fn::If` inside
        // it shows in state; recording one would persist a verdict bit state
        // does not reveal (go-to-k/cdkd#4479).
        if (conditions !== undefined && Object.hasOwn(conditions, gate) && !conditions[gate]) {
          continue;
        }
      }
      collectIfConditionNames(entry, names);
    }
  }
  return names;
}

/**
 * The record a deploy persists (go-to-k/cdkd#4479): the verdict and the
 * fingerprint of each condition `cdkd diff` reads whose closure reaches a
 * secret-fed parameter. `undefined` when there is none, so a stack without
 * such a condition writes no field.
 *
 * `conditions` is the bag the deploy's `evaluateConditions` returned. A
 * verdict it only ASSUMED (an evaluation that threw) is not recorded.
 */
export function buildConditionVerdictRecord(
  template: CloudFormationTemplate,
  conditions: Record<string, boolean>,
  inputOf: (parameter: string) => ConditionParameterInput
): Record<string, RecordedConditionVerdict> | undefined {
  const assumed = conditionsAssumedFalse(conditions);
  const record = nullPrototypeRecord<RecordedConditionVerdict>();
  let any = false;
  for (const name of conditionsReadByDiff(template, conditions)) {
    if (!Object.hasOwn(conditions, name) || assumed.has(name)) continue;
    const verdict = conditions[name];
    if (typeof verdict !== 'boolean') continue;
    const fingerprinted = conditionFingerprint(template, name, inputOf);
    if (fingerprinted === undefined || !fingerprinted.hasToken) continue;
    record[name] = { verdict, fingerprint: fingerprinted.fingerprint };
    any = true;
  }
  return any ? record : undefined;
}

/**
 * The recorded verdicts of `state`, tolerant of any shape: a missing or
 * malformed field reads as no record, and a malformed entry is skipped. A
 * record an older binary dropped, or never wrote, simply is not there.
 */
export function readRecordedConditionVerdicts(
  state: Pick<StackState, 'conditionVerdicts'> | undefined
): Record<string, RecordedConditionVerdict> {
  const read = nullPrototypeRecord<RecordedConditionVerdict>();
  const field: unknown = state?.conditionVerdicts;
  if (!isPlainObject(field)) return read;
  for (const name of Object.keys(field)) {
    const entry = field[name];
    if (
      isPlainObject(entry) &&
      typeof entry['verdict'] === 'boolean' &&
      typeof entry['fingerprint'] === 'string'
    ) {
      read[name] = { verdict: entry['verdict'], fingerprint: entry['fingerprint'] };
    }
  }
  return read;
}

/**
 * The deploy-side inputs for {@link conditionInputsFrom}: each parameter a
 * nested child received from a secret, as the `{{resolve:...}}` expression its
 * parent passed (`tokens`), and every parameter whose input must NOT enter a
 * fingerprint (`unavailable`).
 *
 * TOKENS. The child engine holds the plaintext; redacting it through the
 * inherited map (`plaintext -> expression`) gives back the expression the
 * diff receives for that parameter, which resolves the parent's row with
 * `skipDynamicReferences`. Where two expressions resolve to one plaintext the
 * map keeps one of them, and a token may then differ from the diff's spelling;
 * that pair never matches, and the diff keeps its FALSE branch.
 *
 * UNAVAILABLE, so no secret is ever hashed (an unsalted digest of a short
 * value can be brute forced). A string value is unavailable when it CONTAINS
 * any needle the child inherited, at any length the corpus holds it and
 * including the log-only ones (a parent `NoEcho` value, `Fn::Split` pieces).
 * The corpus itself is not floorless: a deeper child gets a short embedded
 * ancestor secret through a carry that applies the redaction floor, which is
 * why {@link parentSuppliedValues} also withholds every parent-supplied plain
 * value. The needle rule holds unless redaction turns
 * it into a clean token: one that carries a dynamic reference and leaves no
 * needle outside its `{{resolve:...}}` spans. A value redaction changes
 * without containing a needle is unavailable too. Any other value of a
 * child holding inherited secrets that is not a string is unavailable. So is
 * every parameter named in `shadowedBy` (logical ids the resolver serves from
 * a state resource before the parameter). Over-marking only costs the
 * diff its FALSE fallback.
 */
export function deployConditionInputs(
  parameterValues: Readonly<Record<string, unknown>>,
  inheritedSecrets: RecordedSecretValues | undefined,
  shadowedBy: ReadonlySet<string> = new Set()
): { tokens: Record<string, string>; unavailable: Set<string> } {
  const tokens = nullPrototypeRecord<string>();
  const unavailable = new Set<string>();
  for (const name of Object.keys(parameterValues)) if (shadowedBy.has(name)) unavailable.add(name);
  if (inheritedSecrets === undefined) return { tokens, unavailable };
  const needles = [...printingCorpusOf(inheritedSecrets).keys()].filter((n) => n.length > 0);
  if (needles.length === 0) return { tokens, unavailable };
  const containsNeedle = (text: string): boolean => needles.some((n) => text.includes(n));
  for (const [name, value] of Object.entries(parameterValues)) {
    if (unavailable.has(name)) continue;
    if (typeof value !== 'string') {
      unavailable.add(name);
      continue;
    }
    const redacted: unknown = redactSecretsForState(value, inheritedSecrets);
    if (!containsNeedle(value)) {
      if (redacted !== value) unavailable.add(name);
      continue;
    }
    if (
      typeof redacted === 'string' &&
      carriesDynamicReference(redacted) &&
      !containsNeedle(redacted.replace(DYNAMIC_REFERENCE_TOKEN_SCAN, ''))
    ) {
      tokens[name] = redacted;
    } else {
      unavailable.add(name);
    }
  }
  return { tokens, unavailable };
}

/**
 * The parameters a parent SUPPLIED with a value other than the template's own
 * `Default` (go-to-k/cdkd#4479), minus `tokens`. Both sides add these to
 * `unavailable`, so a parent-borne plain value never enters a fingerprint.
 *
 * Needed beyond {@link deployConditionInputs}' needle check because the
 * inherited corpus is not complete for short values: a deeper child receives
 * an ancestor's 1-3 character secret EMBEDDED in a string only through a
 * carry that applies the redaction floor, so no needle names it there. A
 * value equal to the `Default` is template text and stays usable; so is any
 * parameter the parent did not pass.
 */
export function parentSuppliedValues(
  template: CloudFormationTemplate,
  supplied: Readonly<Record<string, unknown>> | undefined,
  tokens: ReadonlySet<string>
): Set<string> {
  const names = new Set<string>();
  if (supplied === undefined) return names;
  const declared = isPlainObject(template.Parameters) ? template.Parameters : {};
  for (const [name, value] of Object.entries(supplied)) {
    if (tokens.has(name)) continue;
    const definition = declared[name];
    const fallback = isPlainObject(definition) ? definition['Default'] : undefined;
    if (fallback === undefined || String(fallback) !== String(value)) names.add(name);
  }
  return names;
}

/** Whether two records hold the same verdicts and fingerprints (absent = empty). */
export function conditionVerdictRecordsEqual(
  a: Readonly<Record<string, RecordedConditionVerdict>> | undefined,
  b: Readonly<Record<string, RecordedConditionVerdict>> | undefined
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const names = Object.keys(left);
  if (names.length !== Object.keys(right).length) return false;
  return names.every(
    (name) =>
      Object.hasOwn(right, name) &&
      left[name]!.verdict === right[name]!.verdict &&
      left[name]!.fingerprint === right[name]!.fingerprint
  );
}
