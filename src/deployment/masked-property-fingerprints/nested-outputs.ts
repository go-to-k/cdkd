/**
 * Nested-stack output classification (go-to-k/cdkd#4565) and the
 * input-fingerprint entry points that start a walk; split out of
 * `masked-property-fingerprints.ts` (#5835).
 */
import { createHash } from 'node:crypto';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { declaresNoEcho } from '../noecho-declared.js';
import {
  canonicalJson,
  INPUT_FINGERPRINT_LAYOUT,
  INPUT_FINGERPRINT_PREFIX,
  maskedPropertyFingerprint,
  TEXT_HALF_SEPARATOR,
} from './core.js';
import {
  carriesSecretValue,
  conditionClosure,
  DYNAMIC_REFERENCE_OPEN,
  getAttTarget,
  hasOpaqueAttributes,
  inputForm,
  intrinsicKey,
  isPlainObject,
  mapReadClass,
  NESTED_OUTPUT_PREFIX,
  NESTED_STACK_TYPE,
  newShared,
  newWalk,
  resolvedInput,
  subPlaceholders,
  taintOf,
  UnknownInput,
  type ChildTemplateLoader,
  type InputForm,
  type MaskedInputSources,
  type NestedShared,
  type NestedTemplate,
  type ParameterInput,
  type Taint,
  type Walk,
} from './input-walk.js';

// ---------------------------------------------------------------------------
// Nested-stack outputs (go-to-k/cdkd#4565)
// ---------------------------------------------------------------------------

/**
 * How a nested stack's output may enter its parent's input fingerprint,
 * decided from the TEMPLATES alone (the parent's row and the child's tree in
 * the cloud assembly), so the deploy's diff pass, its provisioning arms and
 * `cdkd diff` decide it alike whether or not the child has run:
 * - `clean`: the output's `Value` is built only from non-secret inputs, so the
 *   parent resolves it (through the value checks every input takes);
 * - `secret`: it reads a `NoEcho` parameter, a `{{resolve:...}}` reference, a
 *   cross-stack value, a name the child does not declare, a secret-reading
 *   resource, a passed value the parent did not class clean, or a condition
 *   over any of these: kept as written;
 * - `unknown`: the template tree cannot say (no loader, a missing, unreadable
 *   or cyclic template, an undeclared output, a custom resource's attribute):
 *   kept as written;
 * - `unread`: a passed value the parent could not read THIS time: neither
 *   compared nor hashed, as for any unknown input, so a transient read never
 *   flips the hash.
 */
export type NestedOutputClass = 'clean' | 'secret' | 'unknown' | 'unread';

const NESTED_OUTPUT_ORDER: Readonly<Record<NestedOutputClass, number>> = {
  clean: 0,
  unread: 1,
  unknown: 2,
  secret: 3,
};

function worseOf(a: NestedOutputClass, b: NestedOutputClass): NestedOutputClass {
  return NESTED_OUTPUT_ORDER[a] >= NESTED_OUTPUT_ORDER[b] ? a : b;
}

/** Templates deeper than this below the parent are not followed (`unknown`). */
const MAX_NESTED_OUTPUT_DEPTH = 32;
/**
 * Classifications (uncached) one entry point may make before answering
 * `unknown`. With the memo a real tree spends one per row and per output read.
 */
const MAX_NESTED_OUTPUT_STEPS = 10_000;

/** One child template being classified, with what its parameters carry. */
interface OutputScope {
  walk: Walk;
  childTemplate: ChildTemplateLoader;
  /** Template identities from the first child down to this one. */
  chain: readonly string[];
  /** Nested-stack rows of THIS template whose passed values are being classified. */
  rows: ReadonlySet<string>;
  /** This template's identity and passed classes: the key of its rows' memo. */
  key: string;
  shared: NestedShared;
}

/** A passed-class map as a memo key (in the row's own parameter order). */
function passedKey(passed: ReadonlyMap<string, PassedParameterClass>): string {
  return JSON.stringify([...passed.entries()]);
}

export function isNestedStackRow(logicalId: string, walk: Walk): boolean {
  if (!Object.hasOwn(walk.resources, logicalId)) return false;
  const definition = walk.resources[logicalId];
  return isPlainObject(definition) && definition['Type'] === NESTED_STACK_TYPE;
}

/** The attribute an `Fn::GetAtt` operand names; `undefined` when not a literal. */
export function getAttAttribute(operand: unknown, target: string): string | undefined {
  if (Array.isArray(operand)) {
    return operand.length === 2 && typeof operand[1] === 'string' ? operand[1] : undefined;
  }
  return typeof operand === 'string' ? operand.slice(target.length + 1) : undefined;
}

/** The `Parameters` a nested-stack row passes, or `'unknown'` when not a plain map. */
function rowParameters(definition: unknown): Record<string, unknown> | 'unknown' {
  const properties = isPlainObject(definition) ? definition['Properties'] : undefined;
  if (properties === undefined) return {};
  if (!isPlainObject(properties)) return 'unknown';
  const parameters = properties['Parameters'];
  if (parameters === undefined) return {};
  if (!isPlainObject(parameters) || intrinsicKey(parameters) !== undefined) return 'unknown';
  return parameters;
}

/**
 * How each of a child template's parameters enters the TAINT of its outputs:
 * a `NoEcho` parameter is secret whatever was passed; a passed one takes the
 * class its parent gave the value; one not passed binds its `Default`
 * (template text, clean unless it carries a reference), or nothing at all,
 * which reads as secret. Only the KIND is used: no value is bound.
 */
function childParameterInputs(
  template: CloudFormationTemplate,
  passed: ReadonlyMap<string, PassedParameterClass>
): (name: string) => ParameterInput {
  const declared = isPlainObject(template.Parameters) ? template.Parameters : {};
  const inputs = new Map<string, ParameterInput>();
  for (const name of Object.keys(declared)) {
    const definition = declared[name] as unknown;
    const noEcho = isPlainObject(definition) && declaresNoEcho(definition);
    if (noEcho) {
      inputs.set(name, { kind: 'secret' });
    } else if (passed.has(name)) {
      const passedClass = passed.get(name);
      inputs.set(
        name,
        passedClass === 'clean'
          ? { kind: 'value', value: undefined }
          : passedClass === 'unknown'
            ? { kind: 'unknown' }
            : { kind: 'secret' }
      );
    } else if (
      isPlainObject(definition) &&
      Object.hasOwn(definition, 'Default') &&
      !carriesSecretValue(definition['Default'], [])
    ) {
      inputs.set(name, { kind: 'value', value: definition['Default'] });
    } else {
      inputs.set(name, { kind: 'secret' });
    }
  }
  return (name) => inputs.get(name) ?? { kind: 'secret' };
}

/**
 * `taintOf` answers `unknown` only for a parameter whose input is not known
 * this time (an undeclared name or an opaque attribute is `tainted`), so that
 * is `unread` here.
 */
function taintClass(taint: Taint): NestedOutputClass {
  return taint === 'clean' ? 'clean' : taint === 'tainted' ? 'secret' : 'unread';
}

/**
 * A condition's closure: a secret wins, then what the template fixes (an
 * undeclared condition, a resource or undeclared name), kept as written; a
 * parameter not read this time is `unread`.
 */
function closureClass(closure: ReturnType<typeof conditionClosure>): NestedOutputClass {
  if (closure.secret) return 'secret';
  if (closure.unknown) return 'unknown';
  return closure.unread ? 'unread' : 'clean';
}

/**
 * The class of output `outputName` of the child template `loaded`, whose
 * parameters were passed with `passed`. Never resolves anything: the TAINT of
 * the output's `Value` (and of its `Condition`'s closure) over the child's
 * template, following `Outputs.<Key>` reads into grandchildren.
 */
async function childOutputClass(
  loaded: NestedTemplate | undefined,
  outputName: string,
  passed: ReadonlyMap<string, PassedParameterClass>,
  chain: readonly string[],
  shared: NestedShared
): Promise<NestedOutputClass> {
  if (loaded === undefined || !isPlainObject(loaded.template)) return 'unknown';
  const scopeKey = JSON.stringify([loaded.identity, passedKey(passed)]);
  const memoKey = JSON.stringify([scopeKey, outputName]);
  const memo = shared.outputs.get(memoKey);
  if (memo !== undefined) return memo;
  const outputClass = await classifyChildOutput(
    loaded,
    outputName,
    passed,
    chain,
    shared,
    scopeKey
  );
  shared.outputs.set(memoKey, outputClass);
  return outputClass;
}

async function classifyChildOutput(
  loaded: NestedTemplate,
  outputName: string,
  passed: ReadonlyMap<string, PassedParameterClass>,
  chain: readonly string[],
  shared: NestedShared,
  scopeKey: string
): Promise<NestedOutputClass> {
  if (++shared.steps > MAX_NESTED_OUTPUT_STEPS) return 'unknown';
  if (chain.includes(loaded.identity) || chain.length >= MAX_NESTED_OUTPUT_DEPTH) return 'unknown';
  const template = loaded.template;
  const outputs = isPlainObject(template.Outputs) ? template.Outputs : {};
  // An undeclared name reads `undefined`, a prototype member a function or
  // `Object.prototype` (which has no own `Value`): `unknown` either way.
  const output = outputs[outputName] as unknown;
  if (!isPlainObject(output) || !Object.hasOwn(output, 'Value')) return 'unknown';
  const scope: OutputScope = {
    walk: newWalk({
      template,
      parameterInput: childParameterInputs(template, passed),
      // Nothing in the child is resolved here: the value comes from the
      // parent's own record of the output.
      resolve: () => Promise.reject(new Error('a nested output is classified, never resolved')),
    }),
    childTemplate: loaded.childTemplate,
    chain: [...chain, loaded.identity],
    rows: new Set(),
    key: scopeKey,
    shared,
  };
  let outputClass: NestedOutputClass = 'clean';
  if (Object.hasOwn(output, 'Condition')) {
    const condition = output['Condition'];
    // An output that exists or not by a condition over a secret is one bit
    // of it; one over clean inputs that is absent fails the parent's read.
    outputClass =
      typeof condition === 'string'
        ? closureClass(conditionClosure(condition, scope.walk))
        : 'unknown';
  }
  return worseOf(outputClass, await expressionClass(output['Value'], scope));
}

/** The class of a name a child expression reads (`Ref`, an `Fn::Sub` placeholder). */
function nameClass(name: string, scope: OutputScope): NestedOutputClass {
  if (name.startsWith('AWS::')) return 'clean';
  const walk = scope.walk;
  if (Object.hasOwn(walk.resources, name)) return taintClass(taintOf(name, walk));
  if (Object.hasOwn(walk.parameters, name)) {
    const input = walk.sources.parameterInput(name);
    return input.kind === 'value' ? 'clean' : input.kind === 'secret' ? 'secret' : 'unread';
  }
  return 'secret';
}

/** The class of an attribute a child expression reads off `target`. */
async function attributeClass(
  target: string,
  attribute: string | undefined,
  scope: OutputScope
): Promise<NestedOutputClass> {
  const walk = scope.walk;
  if (!Object.hasOwn(walk.resources, target)) return 'secret';
  if (isNestedStackRow(target, walk)) {
    if (attribute === undefined || !attribute.startsWith(NESTED_OUTPUT_PREFIX)) return 'unknown';
    if (scope.rows.has(target)) return 'unknown';
    const parameters = rowParameters(walk.resources[target]);
    if (parameters === 'unknown') return 'unknown';
    const rowKey = JSON.stringify([scope.key, target]);
    let passed = scope.shared.rowsPassed.get(rowKey);
    if (passed === undefined) {
      // The grandchild's passed values, classified over THIS (the child's)
      // template by the same taint rules.
      const inner: OutputScope = { ...scope, rows: new Set([...scope.rows, target]) };
      const classes = new Map<string, PassedParameterClass>();
      for (const [name, expression] of Object.entries(parameters)) {
        const passedClass = await expressionClass(expression, inner);
        classes.set(
          name,
          passedClass === 'clean' ? 'clean' : passedClass === 'unread' ? 'unknown' : 'secret'
        );
      }
      scope.shared.rowsPassed.set(rowKey, classes);
      passed = classes;
    }
    let loaded: NestedTemplate | undefined;
    try {
      loaded = scope.childTemplate(target);
    } catch {
      loaded = undefined;
    }
    return childOutputClass(
      loaded,
      attribute.slice(NESTED_OUTPUT_PREFIX.length),
      passed,
      scope.chain,
      scope.shared
    );
  }
  if (hasOpaqueAttributes(target, walk)) return 'unknown';
  return taintClass(taintOf(target, walk));
}

/**
 * The class of one expression inside a child template: the worst class of
 * every input it reads. Every read is awaited in turn (no `Promise.all`), as
 * the parent side's `inputForms` is, so the memo and the step budget
 * are spent in template order.
 */
async function expressionClass(value: unknown, scope: OutputScope): Promise<NestedOutputClass> {
  if (typeof value === 'string') {
    return value.includes(DYNAMIC_REFERENCE_OPEN) ? 'secret' : 'clean';
  }
  const all = async (values: readonly unknown[]): Promise<NestedOutputClass> => {
    let result: NestedOutputClass = 'clean';
    for (const element of values) result = worseOf(result, await expressionClass(element, scope));
    return result;
  };
  if (Array.isArray(value)) return all(value);
  if (!isPlainObject(value)) return 'clean';
  const key = intrinsicKey(value);
  if (key === undefined) return all(Object.values(value));
  const operand = value[key];
  switch (key) {
    case 'Ref':
      return typeof operand === 'string' ? nameClass(operand, scope) : 'unknown';
    case 'Fn::GetAtt': {
      const target = getAttTarget(operand);
      if (target === undefined) return 'secret';
      // An attribute NAME built from an intrinsic is an input too.
      const attribute = getAttAttribute(operand, target);
      const nameInput =
        attribute === undefined && Array.isArray(operand) ? await all(operand.slice(1)) : 'clean';
      return worseOf(nameInput, await attributeClass(target, attribute, scope));
    }
    case 'Fn::Sub': {
      const text = Array.isArray(operand) ? operand[0] : operand;
      if (typeof text !== 'string')
        return worseOf('unknown', await expressionClass(operand, scope));
      const vars = Array.isArray(operand) && isPlainObject(operand[1]) ? operand[1] : {};
      let result: NestedOutputClass = text.includes(DYNAMIC_REFERENCE_OPEN) ? 'secret' : 'clean';
      result = worseOf(result, await all(Object.values(vars)));
      for (const name of subPlaceholders(text)) {
        if (Object.hasOwn(vars, name)) continue;
        const dot = name.indexOf('.');
        result = worseOf(
          result,
          dot > 0 && !name.startsWith('AWS::')
            ? await attributeClass(name.slice(0, dot), name.slice(dot + 1), scope)
            : nameClass(name, scope)
        );
      }
      return result;
    }
    case 'Fn::If': {
      if (!Array.isArray(operand) || operand.length !== 3 || typeof operand[0] !== 'string') {
        return worseOf('unknown', await expressionClass(operand, scope));
      }
      // No verdict of the child's is evaluated: both branches must be clean,
      // and so must everything the condition reads.
      return worseOf(
        closureClass(conditionClosure(operand[0], scope.walk)),
        await all(operand.slice(1))
      );
    }
    case 'Fn::ImportValue':
    case 'Fn::GetStackOutput':
      return 'secret';
    case 'Fn::FindInMap': {
      // The value is a leaf of the child's `Mappings`, which the operands
      // never show: the whole map it names counts, a literal name only.
      const read = mapReadClass(operand, scope.walk.sources.template);
      if (read === 'unknown') return worseOf('unknown', await all([operand]));
      return worseOf(read, await all((operand as unknown[]).slice(1)));
    }
    default:
      return expressionClass(operand, scope);
  }
}

/**
 * The class of output `attribute` (`Outputs.<Key>`) of the nested stack
 * `stackLogicalId` declares in `sources.template` (go-to-k/cdkd#4565). The
 * values the row passes are classified as {@link classifyPassedParameters}
 * classifies them, the same class the child engine is handed; the child's
 * tree comes from {@link MaskedInputSources.childTemplate}. Never resolves
 * anything in the child and reads no child state, so it is the same before
 * and after the child runs.
 */
export async function nestedStackOutputClass(
  stackLogicalId: string,
  attribute: string | undefined,
  sources: MaskedInputSources
): Promise<NestedOutputClass> {
  return stackOutputClass(stackLogicalId, attribute, newWalk(sources));
}

async function stackOutputClass(
  stackLogicalId: string,
  attribute: string | undefined,
  walk: Walk
): Promise<NestedOutputClass> {
  const loader = walk.sources.childTemplate;
  if (loader === undefined || !isNestedStackRow(stackLogicalId, walk)) return 'unknown';
  if (attribute === undefined || !attribute.startsWith(NESTED_OUTPUT_PREFIX)) return 'unknown';
  // A row whose passed values read this row's own outputs is a cycle
  // CloudFormation refuses; it is not followed.
  if (walk.stackChain.has(stackLogicalId)) return 'unknown';
  const parameters = rowParameters(walk.resources[stackLogicalId]);
  if (parameters === 'unknown') return 'unknown';
  let passed = walk.shared.passed.get(stackLogicalId);
  if (passed === undefined) {
    if (++walk.shared.steps > MAX_NESTED_OUTPUT_STEPS) return 'unknown';
    passed = await classifyPassed(parameters, walk.sources, {
      stackChain: new Set([...walk.stackChain, stackLogicalId]),
      shared: walk.shared,
    });
    walk.shared.passed.set(stackLogicalId, passed);
  }
  let loaded: NestedTemplate | undefined;
  try {
    loaded = loader(stackLogicalId);
  } catch {
    loaded = undefined;
  }
  return childOutputClass(
    loaded,
    attribute.slice(NESTED_OUTPUT_PREFIX.length),
    passed,
    [],
    walk.shared
  );
}

/**
 * A masked property's read of a nested stack's output: resolved, through the
 * value checks every input takes (a `***`, a reference, a value whose read
 * recorded a secret are still kept), only when the output is classified clean.
 */
export async function nestedOutputInput(
  stackLogicalId: string,
  attribute: string | undefined,
  node: unknown,
  walk: Walk
): Promise<InputForm> {
  const outputClass = await stackOutputClass(stackLogicalId, attribute, walk);
  if (outputClass === 'unread') throw new UnknownInput();
  if (outputClass !== 'clean') return { form: node, concrete: false };
  return resolvedInput(node, walk);
}

/**
 * `inputs-sha256:<hex>+sha256:<hex>`: the hash of one property's template
 * value with its non-secret inputs resolved (go-to-k/cdkd#4543), then the
 * text fingerprint of the same value, which binds it to the text entry the
 * record holds. `undefined` when an input is unknown on this side (the caller
 * then neither compares nor stamps one).
 */
export async function maskedInputFingerprint(
  templateValue: unknown,
  sources: MaskedInputSources
): Promise<string | undefined> {
  let form: unknown;
  try {
    form = (await inputForm(templateValue, newWalk(sources))).form;
  } catch (error) {
    if (error instanceof UnknownInput) return undefined;
    throw error;
  }
  const digest = createHash('sha256')
    .update(canonicalJson({ layout: INPUT_FINGERPRINT_LAYOUT, value: form }))
    .digest('hex');
  return `${INPUT_FINGERPRINT_PREFIX}${digest}${TEXT_HALF_SEPARATOR}${maskedPropertyFingerprint(templateValue)}`;
}

/**
 * How a nested child may use a value its parent passes (go-to-k/cdkd#4543):
 * `clean` when the PARENT'S expression for it is built only from known
 * non-secret inputs (the same rules as {@link maskedInputFingerprint}: no
 * `NoEcho` parameter, `{{resolve:...}}` reference, secret-reading resource,
 * cross-stack read or opaque attribute anywhere in it), `secret` when it
 * keeps any input as written, `unknown` when an input could not be read this
 * time (a failed or not-yet-known resolution): the child then neither compares
 * nor stamps what reads it, the same-stack rule for an unknown input, so a
 * transient read never flips the class between deploys.
 */
export type PassedParameterClass = 'clean' | 'secret' | 'unknown';

/**
 * Each parameter an `AWS::CloudFormation::Stack` row passes (its template
 * `Parameters` object), classified over the PARENT's template with the
 * parent's sources. A passed parameter missing here reads as `secret` in the
 * child, even when it equals the child's `Default` (see
 * `parameterInputsFor`).
 */
export async function classifyPassedParameters(
  parameters: unknown,
  sources: MaskedInputSources
): Promise<Map<string, PassedParameterClass>> {
  return classifyPassed(parameters, sources, { stackChain: new Set(), shared: newShared() });
}

async function classifyPassed(
  parameters: unknown,
  sources: MaskedInputSources,
  nested: { stackChain: ReadonlySet<string>; shared: NestedShared }
): Promise<Map<string, PassedParameterClass>> {
  const classes = new Map<string, PassedParameterClass>();
  if (!isPlainObject(parameters)) return classes;
  for (const [name, expression] of Object.entries(parameters)) {
    let passedClass: PassedParameterClass;
    try {
      passedClass = (await inputForm(expression, newWalk(sources, nested))).concrete
        ? 'clean'
        : 'secret';
    } catch {
      passedClass = 'unknown';
    }
    classes.set(name, passedClass);
  }
  return classes;
}

/**
 * The classification a parent recorded for the child it is about to deploy,
 * keyed by the per-resource secrets bag `withCurrentResourceSecrets` binds
 * around that provider call: the one object both sides already share
 * (`NestedStackProvider` reads it through `getCurrentResourceSecrets`).
 */
const passedParameterClasses = new WeakMap<object, ReadonlyMap<string, PassedParameterClass>>();

export function recordPassedParameterClasses(
  bag: object,
  classes: ReadonlyMap<string, PassedParameterClass>
): void {
  passedParameterClasses.set(bag, classes);
}

export function passedParameterClassesOf(
  bag: object | undefined
): ReadonlyMap<string, PassedParameterClass> | undefined {
  return bag === undefined ? undefined : passedParameterClasses.get(bag);
}
