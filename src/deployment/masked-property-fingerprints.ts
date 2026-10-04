/**
 * Fingerprints of the UNRESOLVED template expression behind a property that
 * state records as the secret mask (go-to-k/cdkd#4451).
 *
 * A property whose resolved value carries a mask-only needle (the CDK EC2
 * `UserData` shape: `Fn::Base64` over a script embedding a `{{resolve:...}}`
 * reference, go-to-k/cdkd#2759) is persisted as `***`. The mask identifies
 * nothing, so the deploy's no-change skip and the diff compared `***` with
 * `***`, and an edit around the reference, or a retarget of it, was never
 * sent. The record keeps, per such property, a hash of the TEMPLATE value it
 * was written from: an edit around the reference (or a retarget of it) moves
 * the hash and the property is updated, while a rotated secret behind an
 * unchanged template does not, as in CloudFormation. An input that changes
 * WITHOUT the template text changing (a parameter value, a replaced
 * resource's `Ref`, a flipped condition) moves the INPUT fingerprint
 * (go-to-k/cdkd#4543, below).
 *
 * TWO LAYOUTS, told apart by the entry's prefix.
 * - Layout 1 (`sha256:`, {@link maskedPropertyFingerprint}): the template
 *   value's TEXT. What #4451 wrote and what the deploy-start backfill still
 *   writes; an older cdkd reads only this one.
 * - Layout 2 (`inputs-sha256:`, {@link maskedInputFingerprint}): the template
 *   value with each NON-SECRET input replaced by what it resolved to: a
 *   parameter's bound value, a `Ref` / `Fn::GetAtt` result, the branch an
 *   evaluated condition selects. A `NoEcho` parameter, a `{{resolve:...}}`
 *   reference, and any input derived from one stay in their UNRESOLVED
 *   (template) form: the hash is computed from no secret value, so it is no confirm
 *   oracle (`.claude/rules/layout-deployment-secrets.md`). The classes are in
 *   {@link parameterInputsFor} and `inputForm` below. The entry also carries
 *   the layout-1 text hash after a `+`, which a side that cannot resolve the
 *   inputs (a nested child's `cdkd diff`, an unbound parameter) compares.
 *
 * The one way a secret can still reach either hash is a template LITERAL
 * equal to a `NoEcho` parameter's value or to a value the same resource
 * resolved as a secret; such a property is refused a hash
 * ({@link REFUSED_FINGERPRINT}) and keeps the pre-#4451 comparison. The
 * parameter values are known from deploy start (backfill and every save); a
 * resolved value only to a save that resolved the resource.
 *
 * COMPATIBILITY. A record with no fingerprint for a masked property (every
 * record a pre-#4451 cdkd wrote) is compared exactly as before. The deploy
 * backfills the field from the template it deploys, the same template the
 * unchanged comparison has just accepted, so the FIRST deploy under this
 * version sends what it sent before, and a later edit is detected. A layout-1
 * entry is compared as text, as #4451 compared it; when the text is unchanged
 * the deploy's diff RE-BASELINES it to layout 2 from today's inputs without
 * sending anything, and a record this deploy writes is stamped with layout 2.
 * An older cdkd ignores a layout-2 entry (an unknown prefix reads as no
 * fingerprint), so a downgrade sends nothing either.
 */
import { createHash } from 'node:crypto';
import {
  carriesSecretMask,
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
  SECRET_MASK,
  type RecordedSecretValues,
} from './secret-redaction.js';
import { conditionsAssumedFalse } from './assumed-conditions.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';

/** The version of the text hash's input layout (`sha256:` entries). */
const FINGERPRINT_LAYOUT = 1;
/** The version of the input hash's layout (`inputs-sha256:` entries, go-to-k/cdkd#4543). */
const INPUT_FINGERPRINT_LAYOUT = 2;

/**
 * Key-order-free JSON. An `undefined` object member is omitted, as
 * `JSON.stringify` omits it, and an `undefined` array element or root reads as
 * `null`, so a value built in code hashes as its serialized form does.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The entry a property gets instead of a hash when its template value
 * contains a value the same resource resolved as a secret. Read as no
 * fingerprint (the pre-#4451 comparison), and an entry the backfill does not
 * replace.
 */
export const REFUSED_FINGERPRINT = 'refused:secret-in-template';

const FINGERPRINT_PREFIX = 'sha256:';
/**
 * A prefix an older cdkd's reader does not accept (it reads `sha256:` only),
 * so it reads a layout-2 entry as no fingerprint rather than as a moved one.
 */
const INPUT_FINGERPRINT_PREFIX = 'inputs-sha256:';
/** Joins a layout-2 entry's input half to its text half. */
const TEXT_HALF_SEPARATOR = '+';

/** A layout-2 entry's two halves; the text half is `undefined` when malformed. */
function splitInputFingerprint(entry: string): { input: string; text: string | undefined } {
  const at = entry.indexOf(TEXT_HALF_SEPARATOR);
  if (at < 0) return { input: entry, text: undefined };
  const text = entry.slice(at + 1);
  return {
    input: entry.slice(0, at),
    text: text.startsWith(FINGERPRINT_PREFIX) ? text : undefined,
  };
}

/**
 * Whether `templateValue` contains, as text, a needle of `secrets` at or above
 * the needle floor (the plain and the JSON-escaped spelling, since the hash
 * reads the canonical JSON). The printing corpus, so a `NoEcho` parameter's
 * value counts too.
 */
function templateCarriesNeedle(templateValue: unknown, secrets: RecordedSecretValues): boolean {
  const text = canonicalJson(templateValue);
  for (const needle of printingCorpusOf(secrets).keys()) {
    if (needle.length < MIN_NEEDLE_LENGTH) continue;
    if (text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))) return true;
  }
  return false;
}

/** `sha256:<hex>` over one property's UNRESOLVED template value. */
export function maskedPropertyFingerprint(templateValue: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ layout: FINGERPRINT_LAYOUT, value: templateValue }))
    .digest('hex');
  return `${FINGERPRINT_PREFIX}${digest}`;
}

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
  resolve(node: unknown): Promise<{ value: unknown; secrets?: RecordedSecretValues }>;
}

/** Raised inside the walk when an input is unknown; caught by its entry points. */
class UnknownInput extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const DYNAMIC_REFERENCE_OPEN = '{{resolve:';

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
function carriesSecretValue(
  value: unknown,
  corpora: ReadonlyArray<RecordedSecretValues | undefined>
): boolean {
  const text = canonicalJson(value);
  if (text.includes(DYNAMIC_REFERENCE_OPEN) || text.includes(SECRET_MASK)) return true;
  for (const corpus of corpora) {
    if (corpus === undefined) continue;
    for (const needle of printingCorpusOf(corpus).keys()) {
      if (needle.length === 0) continue;
      if (text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))) return true;
    }
  }
  return false;
}

/** A scalar as CloudFormation spells it (`5` and `'5'` alike); anything else as JSON. */
function scalarText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : canonicalJson(value);
}

/**
 * How every declared parameter enters an input fingerprint, and the bound
 * values of the non-secret ones (what an input node is resolved against).
 * Decided by PROVENANCE, never by comparing the value with a secret (see
 * `carriesSecretValue`).
 *
 * `secret`: a `NoEcho` parameter; a value carrying a `{{resolve:...}}`
 * reference or the mask; and, in a nested child (`nestedChild`), every value
 * the parent SUPPLIED other than the `Default`. A parent can pass a resolved
 * secret, or a value embedding one, as a plain parameter, and the inherited
 * corpus can miss a short ancestor secret: the rule `parentSuppliedValues` in
 * `condition-verdicts.ts` applies for the same reason. `unknown`: a
 * parameter with no bound value, or one named in `unbound`.
 */
export function parameterInputsFor(args: {
  template: CloudFormationTemplate;
  values: Readonly<Record<string, unknown>> | undefined;
  unbound?: ReadonlySet<string>;
  nestedChild?: boolean;
  supplied?: Readonly<Record<string, unknown>> | undefined;
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
    const noEcho =
      isPlainObject(definition) &&
      (definition['NoEcho'] === true || definition['NoEcho'] === 'true');
    let secret = noEcho || carriesSecretValue(value, []);
    if (!secret && args.nestedChild === true && args.supplied !== undefined) {
      if (Object.hasOwn(args.supplied, name)) {
        const fallback = isPlainObject(definition) ? definition['Default'] : undefined;
        if (fallback === undefined || scalarText(fallback) !== scalarText(args.supplied[name])) {
          secret = true;
        }
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

/** A node's form for the hash, and whether it holds no unresolved input. */
interface InputForm {
  form: unknown;
  concrete: boolean;
}

type Taint = 'clean' | 'tainted' | 'unknown';

interface Walk {
  sources: MaskedInputSources;
  resources: Record<string, unknown>;
  parameters: Record<string, unknown>;
  taint: Map<string, Taint>;
  inProgress: Set<string>;
}

/** `${Name}` / `${Resource.Attr}` placeholders of an `Fn::Sub` string; `${!x}` is a literal. */
function subPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    if (body.startsWith('!') || body.length === 0) continue;
    if (!names.includes(body)) names.push(body);
  }
  return names;
}

/** The intrinsic key of a one-key `{Ref}` / `{Fn::*}` object, if it is one. */
function intrinsicKey(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  return key === 'Ref' || key.startsWith('Fn::') ? key : undefined;
}

/** The logical id an `Fn::GetAtt` operand names, either spelling. */
function getAttTarget(operand: unknown): string | undefined {
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
function taintOf(logicalId: string, walk: Walk): Taint {
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
      verdict = target === undefined ? 'tainted' : nameTaint(target);
    } else if (key === 'Fn::ImportValue' || key === 'Fn::GetStackOutput') verdict = 'tainted';
    else if (key === 'Fn::Sub') {
      const text = Array.isArray(operand) ? operand[0] : operand;
      const vars = Array.isArray(operand) && isPlainObject(operand[1]) ? operand[1] : {};
      if (typeof text === 'string') {
        for (const name of subPlaceholders(text)) {
          if (Object.hasOwn(vars, name)) continue;
          const t = nameTaint(name.includes('.') ? name.split('.')[0]! : name);
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
  const definitions = isPlainObject(walk.sources.template.Conditions)
    ? walk.sources.template.Conditions
    : {};
  let secret = false;
  let unknown = false;
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
      if (input.kind === 'unknown') unknown = true;
    };
    if (keys.length === 1 && keys[0] === 'Ref' && typeof value['Ref'] === 'string') {
      classifyName(value['Ref']);
      return;
    }
    // Every other way a condition can read a value is classified as strictly
    // as `taintOf` reads a resource: a verdict over a secret is one bit of it.
    const key = keys.length === 1 ? keys[0] : undefined;
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
  if (unknown) return 'unknown';
  if (secret) return 'secret';
  const conditions = walk.sources.conditions;
  if (conditions === undefined || !Object.hasOwn(conditions, name)) return 'unknown';
  if (conditionsAssumedFalse(conditions as Record<string, boolean>).has(name)) return 'unknown';
  const verdict = conditions[name];
  return typeof verdict === 'boolean' ? verdict : 'unknown';
}

/** Resolves an input node, keeping it as written when its value may be a secret. */
async function resolvedInput(node: unknown, walk: Walk): Promise<InputForm> {
  let resolved: { value: unknown; secrets?: RecordedSecretValues };
  try {
    resolved = await walk.sources.resolve(node);
  } catch {
    throw new UnknownInput();
  }
  if (carriesSecretValue(resolved.value, [resolved.secrets])) {
    return { form: node, concrete: false };
  }
  return { form: resolved.value, concrete: true };
}

async function nameInput(name: string, node: unknown, walk: Walk): Promise<InputForm> {
  if (name === 'AWS::NoValue') return { form: node, concrete: false };
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
    if (input.kind === 'secret') return { form: node, concrete: false };
    return { form: input.value, concrete: true };
  }
  // A name the template does not declare: kept as written on every side.
  return { form: node, concrete: false };
}

/**
 * The value an input fingerprint hashes for `value`: the same structure, with
 * each resolvable non-secret input replaced by what it resolved to. Pure
 * functions (`Fn::Join`, `Fn::Base64`, `Fn::Select`, ...) keep their shape, since
 * their result follows from their operands; an `Fn::Sub` keeps its text and
 * gains each placeholder's input.
 */
async function inputForm(value: unknown, walk: Walk): Promise<InputForm> {
  if (typeof value === 'string') {
    return { form: value, concrete: !value.includes(DYNAMIC_REFERENCE_OPEN) };
  }
  if (Array.isArray(value)) {
    const parts = await Promise.all(value.map((element) => inputForm(element, walk)));
    return { form: parts.map((p) => p.form), concrete: parts.every((p) => p.concrete) };
  }
  if (!isPlainObject(value)) return { form: value, concrete: true };
  const key = intrinsicKey(value);
  if (key === undefined) {
    const entries = Object.keys(value);
    const parts = await Promise.all(entries.map((k) => inputForm(value[k], walk)));
    return {
      form: Object.fromEntries(entries.map((k, i) => [k, parts[i]!.form])),
      concrete: parts.every((p) => p.concrete),
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
      if (target === undefined || !Object.hasOwn(walk.resources, target)) {
        return { form: value, concrete: false };
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
      for (const name of subPlaceholders(text)) {
        if (Object.hasOwn(explicit, name)) continue;
        const dot = name.indexOf('.');
        const part =
          dot > 0 && !name.startsWith('AWS::')
            ? Object.hasOwn(walk.resources, name.slice(0, dot))
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
      }
      return {
        form: { [key]: [text, vars.form, Object.fromEntries(placeholders)] },
        concrete,
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
      const args = await inputForm(operand, walk);
      return { form: { [key]: args.form }, concrete: args.concrete };
    }
  }
}

/**
 * `inputs-sha256:<hex>+sha256:<hex>`: the hash of one property's template
 * value with its non-secret inputs resolved (go-to-k/cdkd#4543), then the
 * layout-1 text hash of the same value, so a side that cannot resolve the
 * inputs still sees a template edit. `undefined` when an input is unknown on
 * this side (the caller then neither compares nor stamps the input half).
 */
export async function maskedInputFingerprint(
  templateValue: unknown,
  sources: MaskedInputSources
): Promise<string | undefined> {
  const walk: Walk = {
    sources,
    resources: isPlainObject(sources.template.Resources) ? sources.template.Resources : {},
    parameters: isPlainObject(sources.template.Parameters) ? sources.template.Parameters : {},
    taint: new Map(),
    inProgress: new Set(),
  };
  let form: unknown;
  try {
    form = (await inputForm(templateValue, walk)).form;
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
 * One property's input fingerprint by key, computed at most once per key. A
 * resolution that throws reads as `undefined`, never as a failed deploy: the
 * fingerprint only decides whether a masked property is re-sent.
 */
export type InputFingerprinter = (key: string) => Promise<string | undefined>;

export function inputFingerprinter(
  templateProps: Record<string, unknown>,
  sources: MaskedInputSources
): InputFingerprinter {
  const memo = new Map<string, Promise<string | undefined>>();
  return (key) => {
    let pending = memo.get(key);
    if (pending === undefined) {
      pending = Object.hasOwn(templateProps, key)
        ? maskedInputFingerprint(templateProps[key], sources).catch(() => undefined)
        : Promise.resolve(undefined);
      memo.set(key, pending);
    }
    return pending;
  };
}

/**
 * The top-level keys of a RESOLVED bag that the save may record as the mask:
 * each whose value holds the mask or any needle of `corpora`, at any length
 * (a superset; a key the save does not mask is never stamped).
 */
export function possiblyMaskedKeys(
  resolvedProps: Record<string, unknown>,
  corpora: ReadonlyArray<RecordedSecretValues | undefined>
): string[] {
  return Object.keys(resolvedProps).filter((key) => {
    const value = resolvedProps[key];
    return carriesSecretMask(value) || carriesSecretValue(value, corpora);
  });
}

/**
 * The input fingerprints of `keys` (what the save stamps on a record this
 * deploy writes); a key whose fingerprint is unknown is left out, and the
 * save writes layout 1 for it.
 */
export async function maskedInputFingerprintsFor(
  keys: readonly string[],
  fingerprinter: InputFingerprinter
): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const key of keys) {
    const fingerprint = await fingerprinter(key);
    if (fingerprint !== undefined) entries.push([key, fingerprint]);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * The fingerprint of every top-level property whose RECORDED (redacted) value
 * carries the mask: its input fingerprint from `inputFingerprints` where the
 * deploy computed one (layout 2), otherwise the text hash of the template
 * value `templateProps` gives it (layout 1). `undefined` when there is none,
 * so a record with no masked property carries no field. Built through
 * `Object.fromEntries`, since the keys are template-controlled and a
 * `__proto__` property must stay an own key.
 */
export function maskedPropertyFingerprintsFor(
  recordedProperties: Record<string, unknown>,
  templateProps: Record<string, unknown>,
  inputFingerprints?: Readonly<Record<string, string>>
): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const key of Object.keys(recordedProperties)) {
    if (!Object.hasOwn(templateProps, key)) continue;
    if (!carriesSecretMask(recordedProperties[key])) continue;
    entries.push([
      key,
      inputFingerprints !== undefined && Object.hasOwn(inputFingerprints, key)
        ? inputFingerprints[key]!
        : maskedPropertyFingerprint(templateProps[key]),
    ]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The record's fingerprints, either layout. A missing field, a non-object, a
 * non-string entry, an unknown prefix or a {@link REFUSED_FINGERPRINT} is no
 * fingerprint, which keeps the pre-#4451 comparison for it.
 */
export function maskedPropertyFingerprintsOf(record: unknown): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
  if (field === null || typeof field !== 'object' || Array.isArray(field)) return read;
  for (const [key, value] of Object.entries(field as Record<string, unknown>)) {
    if (
      typeof value === 'string' &&
      (value.startsWith(FINGERPRINT_PREFIX) || value.startsWith(INPUT_FINGERPRINT_PREFIX))
    ) {
      read.set(key, value);
    }
  }
  return read;
}

/**
 * The top-level properties the record holds as the mask whose template value
 * or resolved inputs moved since it was written: the changes a `***` == `***`
 * comparison cannot see. Only a property the record fingerprinted, still
 * holds masked, and the template still declares counts; anything else the
 * ordinary comparison already decides (an added, removed or unmasked value
 * differs from `***`).
 *
 * A layout-1 entry compares the template text. A layout-2 entry compares the
 * input half against what `fingerprinter` computes; with no fingerprinter, or
 * an input unknown on this side, it compares its text half, as layout 1.
 * A layout-1 entry whose text is unchanged is reported to `onRebaseline`
 * with today's input fingerprint, which the deploy stamps without sending.
 */
export async function movedMaskedProperties(
  record: Pick<ResourceState, 'properties'> & { maskedPropertyFingerprints?: unknown },
  templateProps: Record<string, unknown>,
  fingerprinter?: InputFingerprinter,
  onRebaseline?: (key: string, fingerprint: string) => void
): Promise<string[]> {
  const recorded = maskedPropertyFingerprintsOf(record);
  if (recorded.size === 0) return [];
  const properties = record.properties as unknown;
  if (properties === null || typeof properties !== 'object') return [];
  const moved: string[] = [];
  for (const [key, fingerprint] of recorded) {
    if (!Object.hasOwn(templateProps, key) || !Object.hasOwn(properties, key)) continue;
    if (!carriesSecretMask((properties as Record<string, unknown>)[key])) continue;
    if (fingerprint.startsWith(INPUT_FINGERPRINT_PREFIX)) {
      const recordedHalves = splitInputFingerprint(fingerprint);
      const now = fingerprinter === undefined ? undefined : await fingerprinter(key);
      if (now !== undefined) {
        if (splitInputFingerprint(now).input !== recordedHalves.input) moved.push(key);
      } else if (
        recordedHalves.text !== undefined &&
        maskedPropertyFingerprint(templateProps[key]) !== recordedHalves.text
      ) {
        // The inputs are unknown here, but the template text moved.
        moved.push(key);
      }
      continue;
    }
    if (maskedPropertyFingerprint(templateProps[key]) !== fingerprint) {
      moved.push(key);
      continue;
    }
    if (fingerprinter !== undefined && onRebaseline !== undefined) {
      const now = await fingerprinter(key);
      if (now !== undefined) onRebaseline(key, now);
    }
  }
  return moved;
}

/**
 * `record` with the re-baselined entries of `fingerprints` written over its
 * own (a new record object; the bag it came from is not touched). Only an
 * entry the record still holds as a layout-1 fingerprint is replaced.
 */
export function withRebaselinedFingerprints<T extends object>(
  record: T,
  fingerprints: Readonly<Record<string, string>>
): T {
  const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
  if (!isPlainObject(field)) return record;
  const next: Array<[string, unknown]> = Object.entries(field).map(([key, value]) => [
    key,
    Object.hasOwn(fingerprints, key) &&
    typeof value === 'string' &&
    value.startsWith(FINGERPRINT_PREFIX)
      ? fingerprints[key]
      : value,
  ]);
  return { ...record, maskedPropertyFingerprints: Object.fromEntries(next) };
}

/**
 * The properties bags a deploy WROTE from the template it is deploying (a
 * CREATE, an in-place UPDATE or a replacement, through `propertiesToRecord`).
 * Only such a record's fingerprints may be rebuilt from that template at the
 * save: a record whose provider call failed still holds the PREVIOUS bag, and
 * stamping today's template onto it would skip the retry.
 */
const writtenFromDeployedTemplate = new WeakSet<object>();

/** Marks `bag` as written from the template this deploy resolved. */
export function markWrittenFromDeployedTemplate<T extends object>(bag: T): T {
  writtenFromDeployedTemplate.add(bag);
  return bag;
}

/**
 * The save-time stamp: `scrubbed` (the persisted, redacted record) with its
 * fingerprints rebuilt from `templateProps` when `writtenBag` (the in-memory
 * record's `properties`, before the scrub) was written by this deploy.
 * Otherwise `scrubbed` unchanged, carrying whatever field it had, except
 * that an entry whose template text holds a needle of `secrets` (the
 * resource's own resolution) or of `noEchoParameterValues` (the stack's
 * `NoEcho` parameters) becomes {@link REFUSED_FINGERPRINT}.
 * `inputFingerprints` are the layout-2 fingerprints the deploy computed when
 * it resolved the resource (go-to-k/cdkd#4543); a masked key without one is
 * stamped with layout 1.
 */
export function withMaskedPropertyFingerprints(
  scrubbed: ResourceState,
  writtenBag: unknown,
  templateProps: Record<string, unknown> | undefined,
  secrets?: RecordedSecretValues,
  noEchoParameterValues?: RecordedSecretValues,
  inputFingerprints?: Readonly<Record<string, string>>
): ResourceState {
  if (templateProps === undefined) return scrubbed;
  const corpora = [secrets, noEchoParameterValues].filter(
    (corpus): corpus is RecordedSecretValues => corpus !== undefined
  );
  const written =
    writtenBag !== null &&
    typeof writtenBag === 'object' &&
    writtenFromDeployedTemplate.has(writtenBag);
  const { maskedPropertyFingerprints: previous, ...rest } = scrubbed;
  let fingerprints: Record<string, string> | undefined;
  if (written) {
    fingerprints = maskedPropertyFingerprintsFor(
      scrubbed.properties,
      templateProps,
      inputFingerprints
    );
  } else {
    // Carried as it was, except that this save may hold the needles a
    // backfill or an earlier save could not see.
    if (previous === undefined || previous === null || typeof previous !== 'object') {
      return scrubbed;
    }
    if (corpora.length === 0) return scrubbed;
    fingerprints = { ...(previous as Record<string, string>) };
  }
  if (fingerprints !== undefined && corpora.length > 0) {
    const refused = Object.keys(fingerprints).filter(
      (key) =>
        Object.hasOwn(templateProps, key) &&
        corpora.some((corpus) => templateCarriesNeedle(templateProps[key], corpus))
    );
    if (refused.length > 0) {
      fingerprints = Object.fromEntries(
        Object.entries(fingerprints).map(([key, value]) => [
          key,
          refused.includes(key) ? REFUSED_FINGERPRINT : value,
        ])
      );
    }
  }
  if (!written && JSON.stringify(fingerprints) === JSON.stringify(previous)) return scrubbed;
  return fingerprints === undefined ? rest : { ...rest, maskedPropertyFingerprints: fingerprints };
}

/**
 * The deploy-start backfill: each masked property with NO entry (every
 * property of a record an older cdkd wrote, or one a later writer such as
 * `cdkd scrub` masked after the record was stamped) gets the fingerprint of
 * today's template value. That asserts AWS holds what today's template
 * describes, which is exactly what the unchanged comparison of this same
 * deploy concludes for it, so this deploy sends what it sent before and the
 * next edit is seen. An existing entry, a {@link REFUSED_FINGERPRINT}
 * included, is kept. A property whose template text holds a `NoEcho`
 * parameter's value (`noEchoParameterValues`, known before anything resolves)
 * gets {@link REFUSED_FINGERPRINT}; one holding a value only a resolution
 * yields is checked by the first save that holds that resource's needles.
 *
 * Only a record whose field is absent or a plain object (a malformed one keeps
 * the old comparison and is left alone), whose logical id the template defines
 * with the same type. The RECORD object is replaced, the container updated in
 * place. Returns how many were stamped, so the no-change path knows to save.
 */
export function backfillMaskedPropertyFingerprints(
  resources: Record<string, ResourceState>,
  template: CloudFormationTemplate | undefined,
  noEchoParameterValues?: RecordedSecretValues
): number {
  const declared = template?.Resources;
  if (declared === undefined || declared === null) return 0;
  let stamped = 0;
  for (const [logicalId, record] of Object.entries(resources)) {
    if (record === null || typeof record !== 'object') continue;
    const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
    if (
      field !== undefined &&
      (field === null || typeof field !== 'object' || Array.isArray(field))
    ) {
      continue;
    }
    const existing = (field ?? {}) as Record<string, unknown>;
    if (!Object.hasOwn(declared, logicalId)) continue;
    const definition = declared[logicalId];
    if (definition === undefined || definition.Type !== record.resourceType) continue;
    const properties = record.properties as unknown;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      continue;
    }
    const fingerprints = maskedPropertyFingerprintsFor(
      properties as Record<string, unknown>,
      definition.Properties ?? {}
    );
    if (fingerprints === undefined) continue;
    const templateProps = definition.Properties ?? {};
    const added = Object.entries(fingerprints)
      .filter(([key]) => !Object.hasOwn(existing, key))
      .map(([key, value]): [string, string] =>
        noEchoParameterValues !== undefined &&
        templateCarriesNeedle(templateProps[key], noEchoParameterValues)
          ? [key, REFUSED_FINGERPRINT]
          : [key, value]
      );
    if (added.length === 0) continue;
    resources[logicalId] = {
      ...record,
      maskedPropertyFingerprints: Object.fromEntries([
        ...Object.entries(existing),
        ...added,
      ]) as Record<string, string>,
    };
    stamped++;
  }
  return stamped;
}
