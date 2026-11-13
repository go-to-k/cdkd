/**
 * The input-fingerprint walk (layout 2, go-to-k/cdkd#4543): how a masked
 * property's template value is turned into the form its input fingerprint
 * hashes; split out of `masked-property-fingerprints.ts` (#5835).
 */
import {
  carriesSecretMask,
  printingCorpusOf,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { conditionsAssumedFalse } from '../assumed-conditions.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { declaresNoEcho } from '../noecho-declared.js';
import { canonicalJson } from './core.js';
import {
  getAttAttribute,
  isNestedStackRow,
  nestedOutputInput,
  type NestedOutputClass,
  type PassedParameterClass,
} from './nested-outputs.js';

// ---------------------------------------------------------------------------
// Layout 2: resolved non-secret inputs (go-to-k/cdkd#4543)
// ---------------------------------------------------------------------------

/**
 * What a template parameter contributes to an input fingerprint:
 * - `value`: its bound value, which is hashed;
 * - `secret`: it stays `{Ref: P}` (a `NoEcho` parameter, a value carrying a
 *   `{{resolve:...}}` reference or the mask, a value a nested child's parent
 *   supplied);
 * - `unknown`: this side cannot say what the deploy binds (an unbound
 *   parameter of `cdkd diff`), so no input fingerprint is computed.
 */
export type ParameterInput =
  | { kind: 'value'; value: unknown }
  | { kind: 'secret' }
  | { kind: 'unknown' };

/**
 * Where an input fingerprint's resolved inputs come from. The deploy's diff,
 * its provisioning arms and `cdkd diff` each build one; the rule that turns
 * them into a hash lives here only, so the side that RECORDS and the side
 * that COMPARES cannot drift apart.
 */
export interface MaskedInputSources {
  /** The template the properties come from: its `Parameters` and `Resources`. */
  template: CloudFormationTemplate;
  /** See {@link ParameterInput}; built by {@link parameterInputsFor}. */
  parameterInput(name: string): ParameterInput;
  /** The evaluated conditions (an assumed verdict reads as unknown). */
  conditions?: Readonly<Record<string, boolean>> | undefined;
  /**
   * Resolves one input node (a `Ref` to a resource or a pseudo parameter, an
   * `Fn::GetAtt`, a cross-stack read, `Fn::FindInMap`, `Fn::GetAZs`) WITHOUT
   * resolving any `{{resolve:...}}` reference, returning the value and the bag
   * that resolution recorded secrets into. A throw is an unknown input.
   */
  resolve(
    node: unknown
  ): Promise<{ value: unknown; secrets?: RecordedSecretValues; keepAsWritten?: boolean }>;
  /**
   * The template of the nested stack a `AWS::CloudFormation::Stack` row of
   * {@link template} names, read from the cloud assembly (go-to-k/cdkd#4565).
   * An `Fn::GetAtt` on that row's `Outputs.<Key>` is resolved only when the
   * output is classified clean from these templates (see
   * `nestedStackOutputClass`). Absent: every such read is kept as written.
   */
  childTemplate?: ChildTemplateLoader | undefined;
}

/** A nested stack's template, and the loader for the nested stacks IT declares. */
export interface NestedTemplate {
  template: CloudFormationTemplate;
  /** Identifies the template file, so a cyclic tree is refused rather than followed. */
  identity: string;
  childTemplate: ChildTemplateLoader;
}

/**
 * The template of the nested stack a row (by logical id) of the template this
 * loader belongs to names; `undefined` when there is none, or it cannot be
 * read, parsed or contained in the assembly.
 */
export type ChildTemplateLoader = (logicalId: string) => NestedTemplate | undefined;

/** Raised inside the walk when an input is unknown; caught by its entry points. */
export class UnknownInput extends Error {}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const DYNAMIC_REFERENCE_OPEN = '{{resolve:';
export const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';
export const NESTED_OUTPUT_PREFIX = 'Outputs.';

/**
 * Whether a value carries a `{{resolve:...}}` reference (the diff side never
 * resolves one), the mask (a redacted attribute read), or any needle of
 * `corpora` at ANY length.
 *
 * For an input node the only corpus is the bag ITS OWN resolution recorded
 * into: the node read a secret (a `NoEcho` custom resource's `Data`, a
 * recovered cross-stack output), which is provenance. A STACK-WIDE corpus
 * (the `NoEcho` values, a child's inherited secrets) is deliberately not
 * consulted: whether an unrelated input happens to CONTAIN a secret would
 * then decide the hash, and the hash would answer that question for anyone
 * holding the state file (and move when the secret rotates).
 */
export function carriesSecretValue(
  value: unknown,
  corpora: ReadonlyArray<RecordedSecretValues | undefined>
): boolean {
  // The mask is a WHOLE leaf wherever cdkd writes it, so only a whole leaf
  // counts: a cron or glob value containing `***` is ordinary text.
  if (carriesSecretMask(value)) return true;
  const text = canonicalJson(value);
  if (text.includes(DYNAMIC_REFERENCE_OPEN)) return true;
  for (const corpus of corpora) {
    if (corpus === undefined) continue;
    for (const needle of printingCorpusOf(corpus).keys()) {
      if (needle.length === 0) continue;
      if (text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))) return true;
    }
  }
  return false;
}

/**
 * How every declared parameter enters an input fingerprint, and the bound
 * values of the non-secret ones (what an input node is resolved against).
 * Decided by PROVENANCE, never by comparing the value with a secret (see
 * `carriesSecretValue`).
 *
 * `secret`: a `NoEcho` parameter; a value carrying a `{{resolve:...}}`
 * reference or the mask; and, in a nested child (`nestedChild`), a value the
 * parent SUPPLIED that the parent classified `secret` (`passedClasses`, from
 * `classifyPassedParameters` over the parent's own template) or did not
 * classify at all, even one equal to the `Default`. A parent can pass a
 * resolved secret, or a value embedding one, as a plain parameter, and the
 * child cannot tell that from the value (the inherited corpus can miss a short
 * ancestor secret), so only the parent's class vouches for it; the rule
 * `parentSuppliedValues` in `condition-verdicts.ts` applies for the same
 * reason. `unknown`: a parameter with no bound value, one named in `unbound`,
 * and, in a nested child, a value the parent supplied and classified
 * `unknown`. A parameter the parent did not supply binds the child's `Default`
 * (template text) and is a plain value.
 */
export function parameterInputsFor(args: {
  template: CloudFormationTemplate;
  values: Readonly<Record<string, unknown>> | undefined;
  unbound?: ReadonlySet<string>;
  nestedChild?: boolean;
  supplied?: Readonly<Record<string, unknown>> | undefined;
  passedClasses?: ReadonlyMap<string, PassedParameterClass> | undefined;
}): { parameterInput: (name: string) => ParameterInput; bound: Record<string, unknown> } {
  const declared = isPlainObject(args.template.Parameters) ? args.template.Parameters : {};
  const values = args.values ?? {};
  const inputs = new Map<string, ParameterInput>();
  const bound: Record<string, unknown> = {};
  for (const name of Object.keys(declared)) {
    const definition = declared[name] as unknown;
    if (args.unbound?.has(name) || !Object.hasOwn(values, name)) {
      inputs.set(name, { kind: 'unknown' });
      continue;
    }
    const value = values[name];
    const noEcho = isPlainObject(definition) && declaresNoEcho(definition);
    let secret = noEcho || carriesSecretValue(value, []);
    if (!secret && args.nestedChild === true && args.supplied !== undefined) {
      // PASSED is decidable only here, from the parameter map the parent
      // supplied: a name it holds was passed, any other name binds the
      // child's `Default`, which is template text and stays clean.
      if (Object.hasOwn(args.supplied, name)) {
        // Only the parent's class vouches for a passed value, a value equal to
        // the `Default` included (comparing with it would let the hash confirm
        // "the passed secret equals the Default"). With no class (a rollback
        // replay binds a bag the parent never classified, or the parent had no
        // fingerprint sources), the value is kept as written like a secret:
        // nothing derived from it is hashed, and the next classified deploy
        // sees its fingerprint move and sends once, which is what puts back
        // a value a rollback replayed.
        const passed = args.passedClasses?.get(name);
        if (passed === 'unknown') {
          inputs.set(name, { kind: 'unknown' });
          continue;
        }
        if (passed !== 'clean') secret = true;
      }
    }
    if (secret) {
      inputs.set(name, { kind: 'secret' });
    } else {
      inputs.set(name, { kind: 'value', value });
      bound[name] = value;
    }
  }
  return {
    parameterInput: (name) => inputs.get(name) ?? { kind: 'unknown' },
    bound,
  };
}

/**
 * A node's form for the hash, and whether it holds no unresolved input.
 *
 * `proven` (go-to-k/cdkd#6209): every input under the node was resolved and
 * hashed, or is a reference to a parameter in `Walk.covered` (a `NoEcho`
 * parameter whose value MAC the caller compares), `AWS::NoValue`, or a
 * template leaf holding a `{{resolve:...}}` reference no intrinsic joins
 * into another value, which is compared as its text, as CloudFormation
 * compares it (one an intrinsic joins shares its result with the value it is
 * joined to: unproven). It never
 * changes `form` or `concrete`, which the diff and the masked-property skip
 * read, and it is computed only for a walk with a `covered` set (every other
 * walk does no work for it). Absent reads as `concrete`: a site that does not say is unproven
 * whenever it keeps an input as written.
 */
export interface InputForm {
  form: unknown;
  concrete: boolean;
  proven?: boolean;
}

/** Whether an intrinsic's operand joins a `{{resolve:...}}` reference into its result. */
function carriesReference(operand: unknown): boolean {
  return canonicalJson(operand).includes(DYNAMIC_REFERENCE_OPEN);
}

/**
 * `{ proven }` when `walk` computes proof (`covered` set), else nothing: the
 * diff's and the masked-property skip's walks pay no work for it.
 */
function proof(walk: Walk, proven: () => boolean): { proven?: boolean } {
  return walk.covered === undefined ? {} : { proven: proven() };
}

/** Whether every input under `part` is resolved and hashed or covered ({@link InputForm}). */
export function isProven(part: InputForm): boolean {
  return part.concrete || part.proven === true;
}

export type Taint = 'clean' | 'tainted' | 'unknown';

export interface Walk {
  sources: MaskedInputSources;
  resources: Record<string, unknown>;
  parameters: Record<string, unknown>;
  taint: Map<string, Taint>;
  inProgress: Set<string>;
  /** Nested-stack rows whose passed values are being classified above this walk. */
  stackChain: ReadonlySet<string>;
  /** Shared by every nested-output classification one entry point starts. */
  shared: NestedShared;
  /**
   * go-to-k/cdkd#6209: the parameters a reference to which counts as proven
   * though it is kept as written (see {@link InputForm}). Absent for every
   * caller but the NoEcho value MAC binding, so nothing else reads `proven`.
   */
  covered?: ReadonlySet<string> | undefined;
}

/**
 * What one entry point (`maskedInputFingerprint`,
 * `classifyPassedParameters`, `nestedStackOutputClass`) learns
 * about nested-stack outputs, so each row's passed values and each child
 * output are classified once, however many reads reach them: the work is
 * linear in the templates, and `steps` is a backstop for a hostile tree only.
 * Every read is made in template order ({@link inputForms}), so the same
 * templates spend the same steps, in the same order, on every side.
 */
export interface NestedShared {
  steps: number;
  /** A parent row's passed classes, by logical id. */
  passed: Map<string, ReadonlyMap<string, PassedParameterClass>>;
  /** A child output's class, by template identity, output name and passed classes. */
  outputs: Map<string, NestedOutputClass>;
  /** A child row's passed classes, by its template identity, that template's passed classes and the row. */
  rowsPassed: Map<string, ReadonlyMap<string, PassedParameterClass>>;
}

export function newShared(): NestedShared {
  return { steps: 0, passed: new Map(), outputs: new Map(), rowsPassed: new Map() };
}

/** `${Name}` / `${Resource.Attr}` placeholders of an `Fn::Sub` string; `${!x}` is a literal. */
export function subPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    if (body.startsWith('!') || body.length === 0) continue;
    if (!names.includes(body)) names.push(body);
  }
  return names;
}

/** The intrinsic key of a one-key `{Ref}` / `{Fn::*}` object, if it is one. */
export function intrinsicKey(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  return key === 'Ref' || key.startsWith('Fn::') ? key : undefined;
}

/**
 * Types whose attributes are handler- or child-defined, and so may be a
 * `NoEcho` value (a custom resource's `Data`, a nested stack's output): an
 * `Fn::GetAtt` on one is kept as written whatever it resolves to, and a
 * resource whose definition reads one counts as reading a secret. The one
 * exception is a masked property's DIRECT read of a nested stack's
 * `Outputs.<Key>` (an `Fn::GetAtt`, or an `Fn::Sub` placeholder): it is
 * resolved when the output is classified clean from the child's template
 * (`nestedStackOutputClass`, go-to-k/cdkd#4565). A custom resource's
 * attributes are fixed only when its handler runs, so they have no such path.
 */
const OPAQUE_ATTRIBUTE_TYPES = new Set(['AWS::CloudFormation::CustomResource', NESTED_STACK_TYPE]);

export function hasOpaqueAttributes(logicalId: string, walk: Walk): boolean {
  const definition = walk.resources[logicalId];
  const type = isPlainObject(definition) ? definition['Type'] : undefined;
  return (
    typeof type === 'string' && (type.startsWith('Custom::') || OPAQUE_ATTRIBUTE_TYPES.has(type))
  );
}

/** The logical id an `Fn::GetAtt` operand names, either spelling. */
export function getAttTarget(operand: unknown): string | undefined {
  if (Array.isArray(operand) && typeof operand[0] === 'string') return operand[0];
  if (typeof operand === 'string' && operand.includes('.')) return operand.split('.')[0];
  return undefined;
}

/**
 * Whether a resource's own definition reads a secret, so that what it
 * resolves to (its physical id, an attribute) counts as derived from one: a
 * `{{resolve:...}}` reference anywhere in it, a secret parameter, a
 * cross-stack read (whose value may be another stack's secret output), or a
 * `Ref` / `Fn::GetAtt` / `Fn::Sub` placeholder naming a tainted resource.
 * Read off the TEMPLATE, so the deploy and the diff decide it alike.
 */
export function taintOf(logicalId: string, walk: Walk): Taint {
  const cached = walk.taint.get(logicalId);
  if (cached !== undefined) return cached;
  // A reference cycle is a template CloudFormation refuses; an in-progress
  // entry reads as tainted (fail closed) and is never cached as a verdict.
  if (walk.inProgress.has(logicalId)) return 'tainted';
  walk.inProgress.add(logicalId);
  let unknown = false;
  const nameTaint = (name: string): Taint => {
    if (name.startsWith('AWS::')) return 'clean';
    if (Object.hasOwn(walk.resources, name)) return taintOf(name, walk);
    if (Object.hasOwn(walk.parameters, name)) {
      const input = walk.sources.parameterInput(name);
      return input.kind === 'value' ? 'clean' : input.kind === 'secret' ? 'tainted' : 'unknown';
    }
    // A name the template does not declare (a shell `${VAR}` in an
    // `Fn::Sub`, a nested input the child does not declare): what it reads is
    // unknown, so the resource counts as reading a secret, on every side alike.
    return 'tainted';
  };
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(DYNAMIC_REFERENCE_OPEN);
    if (Array.isArray(value)) return value.some(visit);
    if (!isPlainObject(value)) return false;
    const key = intrinsicKey(value);
    const operand = key === undefined ? undefined : value[key];
    let verdict: Taint = 'clean';
    if (key === 'Ref' && typeof operand === 'string') verdict = nameTaint(operand);
    else if (key === 'Fn::GetAtt') {
      const target = getAttTarget(operand);
      verdict =
        target === undefined ||
        (Object.hasOwn(walk.resources, target) && hasOpaqueAttributes(target, walk))
          ? 'tainted'
          : nameTaint(target);
    } else if (key === 'Fn::ImportValue' || key === 'Fn::GetStackOutput') verdict = 'tainted';
    else if (key === 'Fn::FindInMap' && mapReadClass(operand, walk.sources.template) !== 'clean') {
      // A mapping leaf the operands never show, or a map name that is not a
      // literal: the resource reads it as a secret (go-to-k/cdkd#4565).
      verdict = 'tainted';
    } else if (key === 'Fn::Sub') {
      const text = Array.isArray(operand) ? operand[0] : operand;
      const vars = Array.isArray(operand) && isPlainObject(operand[1]) ? operand[1] : {};
      if (typeof text === 'string') {
        for (const name of subPlaceholders(text)) {
          if (Object.hasOwn(vars, name)) continue;
          const owner = name.includes('.') ? name.split('.')[0]! : name;
          const t =
            name.includes('.') &&
            Object.hasOwn(walk.resources, owner) &&
            hasOpaqueAttributes(owner, walk)
              ? 'tainted'
              : nameTaint(owner);
          if (t === 'tainted') return true;
          if (t === 'unknown') unknown = true;
        }
      }
    }
    if (verdict === 'tainted') return true;
    if (verdict === 'unknown') unknown = true;
    return Object.values(value).some(visit);
  };
  const definition = walk.resources[logicalId];
  const properties = isPlainObject(definition) ? definition['Properties'] : undefined;
  const result: Taint = visit(properties) ? 'tainted' : unknown ? 'unknown' : 'clean';
  walk.inProgress.delete(logicalId);
  walk.taint.set(logicalId, result);
  return result;
}

/**
 * Whether a condition's verdict may be hashed: `true`/`false` for a verdict
 * whose closure reads only non-secret inputs, `'secret'` when it reads a
 * secret parameter or a `{{resolve:...}}` reference (the `Fn::If` then stays
 * whole, so a flip of it is not seen: a verdict over a secret is one bit of
 * it), `'unknown'` when a verdict or an input is not known here.
 */
function conditionInput(name: string, walk: Walk): boolean | 'secret' | 'unknown' {
  const closure = conditionClosure(name, walk);
  if (closure.unknown || closure.unread) return 'unknown';
  if (closure.secret) return 'secret';
  const conditions = walk.sources.conditions;
  if (conditions === undefined || !Object.hasOwn(conditions, name)) return 'unknown';
  if (conditionsAssumedFalse(conditions as Record<string, boolean>).has(name)) return 'unknown';
  const verdict = conditions[name];
  return typeof verdict === 'boolean' ? verdict : 'unknown';
}

/**
 * What a condition's closure reads, never its verdict: `secret` when it reads
 * a secret parameter, a `{{resolve:...}}` reference, a cross-stack value or an
 * attribute; `unknown` when it names a definition it does not declare, or a
 * resource or undeclared name (fixed by the template); `unread` when a
 * parameter's input is not known this time.
 */
export function conditionClosure(
  name: string,
  walk: Walk
): { secret: boolean; unknown: boolean; unread: boolean } {
  const definitions = isPlainObject(walk.sources.template.Conditions)
    ? walk.sources.template.Conditions
    : {};
  let secret = false;
  let unknown = false;
  let unread = false;
  const seen = new Set<string>();
  const pending = [name];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes(DYNAMIC_REFERENCE_OPEN)) secret = true;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isPlainObject(value)) return;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'Condition' && typeof value['Condition'] === 'string') {
      pending.push(value['Condition']);
      return;
    }
    const classifyName = (ref: string): void => {
      if (ref.startsWith('AWS::')) return;
      if (!Object.hasOwn(walk.parameters, ref)) {
        // A resource (CloudFormation allows none here) or an undeclared name.
        unknown = true;
        return;
      }
      const input = walk.sources.parameterInput(ref);
      if (input.kind === 'secret') secret = true;
      if (input.kind === 'unknown') unread = true;
    };
    if (keys.length === 1 && keys[0] === 'Ref' && typeof value['Ref'] === 'string') {
      classifyName(value['Ref']);
      return;
    }
    // Every other way a condition can read a value is classified as strictly
    // as `taintOf` reads a resource: a verdict over a secret is one bit of it.
    const key = keys.length === 1 ? keys[0] : undefined;
    if (key === 'Fn::FindInMap') {
      const read = mapReadClass(value['Fn::FindInMap'], walk.sources.template);
      if (read === 'secret') secret = true;
      if (read === 'unknown') unknown = true;
    }
    if (key === 'Fn::ImportValue' || key === 'Fn::GetStackOutput' || key === 'Fn::GetAtt') {
      secret = true;
      return;
    }
    if (key === 'Fn::Sub') {
      const operand = value['Fn::Sub'];
      const text = Array.isArray(operand) ? operand[0] : operand;
      const vars = Array.isArray(operand) && isPlainObject(operand[1]) ? operand[1] : {};
      if (typeof text === 'string') {
        for (const name of subPlaceholders(text)) {
          if (Object.hasOwn(vars, name)) continue;
          if (name.includes('.') && !name.startsWith('AWS::')) secret = true;
          else classifyName(name);
        }
      }
    }
    Object.values(value).forEach(visit);
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!Object.hasOwn(definitions, current)) {
      unknown = true;
      continue;
    }
    visit(definitions[current]);
  }
  return { secret, unknown, unread };
}

/**
 * What an `Fn::FindInMap` reads, from the template alone: its value is a leaf
 * of `Mappings` the operands never show, so the WHOLE map it names counts.
 * `secret` when that map holds a `{{resolve:...}}` reference or the mask
 * anywhere; `unknown` for a map name that is not a literal or names no
 * declared map; else `clean` (the key operands are the caller's to read).
 */
export function mapReadClass(
  operand: unknown,
  template: CloudFormationTemplate
): 'clean' | 'secret' | 'unknown' {
  const mapName = Array.isArray(operand) ? operand[0] : undefined;
  if (typeof mapName !== 'string') return 'unknown';
  const mappings = template.Mappings as unknown;
  const map =
    isPlainObject(mappings) && Object.hasOwn(mappings, mapName) ? mappings[mapName] : undefined;
  if (!isPlainObject(map)) return 'unknown';
  return carriesSecretValue(map, []) ? 'secret' : 'clean';
}

/** Resolves an input node, keeping it as written when its value may be a secret. */
export async function resolvedInput(node: unknown, walk: Walk): Promise<InputForm> {
  let resolved: { value: unknown; secrets?: RecordedSecretValues; keepAsWritten?: boolean };
  try {
    resolved = await walk.sources.resolve(node);
  } catch {
    throw new UnknownInput();
  }
  if (resolved.keepAsWritten === true || carriesSecretValue(resolved.value, [resolved.secrets])) {
    return { form: node, concrete: false };
  }
  return { form: resolved.value, concrete: true };
}

async function nameInput(name: string, node: unknown, walk: Walk): Promise<InputForm> {
  // `AWS::NoValue` is template text: proven, though kept as written.
  if (name === 'AWS::NoValue') return { form: node, concrete: false, ...proof(walk, () => true) };
  if (name.startsWith('AWS::')) return resolvedInput(node, walk);
  if (Object.hasOwn(walk.resources, name)) {
    const taint = taintOf(name, walk);
    if (taint === 'unknown') throw new UnknownInput();
    if (taint === 'tainted') return { form: node, concrete: false };
    return resolvedInput(node, walk);
  }
  if (Object.hasOwn(walk.parameters, name)) {
    const input = walk.sources.parameterInput(name);
    if (input.kind === 'unknown') throw new UnknownInput();
    if (input.kind === 'secret') {
      // A covered parameter's value is compared by its MAC, not hashed here.
      return walk.covered?.has(name) === true
        ? { form: node, concrete: false, proven: true }
        : { form: node, concrete: false };
    }
    return { form: input.value, concrete: true };
  }
  // A name the template does not declare: kept as written on every side.
  return { form: node, concrete: false };
}

/**
 * The input forms of `values`, IN ORDER, one after another. Never
 * concurrently: a nested-stack output read spends the walk's shared step
 * budget and fills its memo ({@link NestedShared}), so the order of the reads
 * must be the template's, never the order resolutions happen to settle in.
 * Then the same template and the same resolved inputs give the same verdict
 * on every side, the deploy's diff pass and its provisioning arms included.
 */
async function inputForms(values: readonly unknown[], walk: Walk): Promise<InputForm[]> {
  const parts: InputForm[] = [];
  for (const element of values) parts.push(await inputForm(element, walk));
  return parts;
}

/**
 * The value an input fingerprint hashes for `value`: the same structure, with
 * each resolvable non-secret input replaced by what it resolved to. Pure
 * functions (`Fn::Join`, `Fn::Base64`, `Fn::Select`, ...) keep their shape, since
 * their result follows from their operands; an `Fn::Sub` keeps its text and
 * gains each placeholder's input.
 */
export async function inputForm(value: unknown, walk: Walk): Promise<InputForm> {
  if (typeof value === 'string') {
    return value.includes(DYNAMIC_REFERENCE_OPEN)
      ? { form: value, concrete: false, ...proof(walk, () => true) }
      : { form: value, concrete: true };
  }
  if (Array.isArray(value)) {
    const parts = await inputForms(value, walk);
    return {
      form: parts.map((p) => p.form),
      concrete: parts.every((p) => p.concrete),
      ...proof(walk, () => parts.every(isProven)),
    };
  }
  if (!isPlainObject(value)) return { form: value, concrete: true };
  const key = intrinsicKey(value);
  if (key === undefined) {
    const entries = Object.keys(value);
    const parts = await inputForms(
      entries.map((k) => value[k]),
      walk
    );
    return {
      form: Object.fromEntries(entries.map((k, i) => [k, parts[i]!.form])),
      concrete: parts.every((p) => p.concrete),
      ...proof(walk, () => parts.every(isProven)),
    };
  }
  const operand = value[key];
  switch (key) {
    case 'Ref':
      return typeof operand === 'string'
        ? nameInput(operand, value, walk)
        : { form: value, concrete: false };
    case 'Fn::GetAtt': {
      const target = getAttTarget(operand);
      if (target !== undefined && isNestedStackRow(target, walk)) {
        return nestedOutputInput(target, getAttAttribute(operand, target), value, walk);
      }
      if (
        target === undefined ||
        !Object.hasOwn(walk.resources, target) ||
        hasOpaqueAttributes(target, walk)
      ) {
        return { form: value, concrete: false };
      }
      // An attribute NAME built from an intrinsic is itself an input: unless it
      // resolves to a known non-secret value, the node stays as written.
      if (Array.isArray(operand) && operand.length > 1 && typeof operand[1] !== 'string') {
        const attribute = await inputForm(operand[1], walk);
        if (!attribute.concrete) {
          return { form: { [key]: [operand[0], attribute.form] }, concrete: false };
        }
      }
      return nameInput(target, value, walk);
    }
    case 'Fn::If': {
      if (!Array.isArray(operand) || typeof operand[0] !== 'string') {
        const args = await inputForm(operand, walk);
        return { form: { [key]: args.form }, concrete: false };
      }
      const verdict = conditionInput(operand[0], walk);
      if (verdict === 'unknown') throw new UnknownInput();
      if (verdict === 'secret') {
        const args = await inputForm(operand.slice(1), walk);
        return { form: { [key]: [operand[0], ...(args.form as unknown[])] }, concrete: false };
      }
      return inputForm(verdict ? operand[1] : operand[2], walk);
    }
    case 'Fn::Sub': {
      const text = Array.isArray(operand) ? operand[0] : operand;
      if (typeof text !== 'string') {
        const args = await inputForm(operand, walk);
        return { form: { [key]: args.form }, concrete: false };
      }
      const explicit = Array.isArray(operand) && isPlainObject(operand[1]) ? operand[1] : {};
      const vars = await inputForm(explicit, walk);
      const placeholders: Array<[string, unknown]> = [];
      let concrete = vars.concrete && !text.includes(DYNAMIC_REFERENCE_OPEN);
      // Computed only for a walk with a cover (`proof`).
      let proven = walk.covered !== undefined && isProven(vars) && !carriesReference(operand);
      for (const name of subPlaceholders(text)) {
        if (Object.hasOwn(explicit, name)) continue;
        const dot = name.indexOf('.');
        const part =
          dot > 0 && !name.startsWith('AWS::') && isNestedStackRow(name.slice(0, dot), walk)
            ? await nestedOutputInput(
                name.slice(0, dot),
                name.slice(dot + 1),
                { 'Fn::GetAtt': [name.slice(0, dot), name.slice(dot + 1)] },
                walk
              )
            : dot > 0 && !name.startsWith('AWS::')
              ? Object.hasOwn(walk.resources, name.slice(0, dot)) &&
                !hasOpaqueAttributes(name.slice(0, dot), walk)
                ? await nameInput(
                    name.slice(0, dot),
                    { 'Fn::GetAtt': [name.slice(0, dot), name.slice(dot + 1)] },
                    walk
                  )
                : {
                    form: { 'Fn::GetAtt': [name.slice(0, dot), name.slice(dot + 1)] },
                    concrete: false,
                  }
              : await nameInput(name, { Ref: name }, walk);
        placeholders.push([name, part.form]);
        concrete &&= part.concrete;
        proven &&= walk.covered !== undefined && isProven(part);
      }
      return {
        form: { [key]: [text, vars.form, Object.fromEntries(placeholders)] },
        concrete,
        ...proof(walk, () => proven),
      };
    }
    case 'Fn::ImportValue':
    case 'Fn::GetStackOutput':
    case 'Fn::FindInMap':
    case 'Fn::GetAZs': {
      // Resolved whole, but only when every operand is itself a known
      // non-secret input: what the node reads then follows from them.
      const args = await inputForm(operand, walk);
      if (!args.concrete) return { form: { [key]: args.form }, concrete: false };
      const resolved = await resolvedInput(value, walk);
      return resolved.concrete ? resolved : { form: { [key]: args.form }, concrete: false };
    }
    default: {
      // A pure function of its operands (`Fn::Join`, `Fn::Base64`, ...).
      const args = await inputForm(operand, walk);
      return {
        form: { [key]: args.form },
        concrete: args.concrete,
        ...proof(walk, () => isProven(args) && !carriesReference(operand)),
      };
    }
  }
}

export function newWalk(
  sources: MaskedInputSources,
  nested: { stackChain: ReadonlySet<string>; shared: NestedShared } = {
    stackChain: new Set(),
    shared: newShared(),
  },
  covered?: ReadonlySet<string>
): Walk {
  return {
    ...(covered !== undefined && { covered }),
    sources,
    resources: isPlainObject(sources.template.Resources) ? sources.template.Resources : {},
    parameters: isPlainObject(sources.template.Parameters) ? sources.template.Parameters : {},
    taint: new Map(),
    inProgress: new Set(),
    stackChain: nested.stackChain,
    shared: nested.shared,
  };
}
