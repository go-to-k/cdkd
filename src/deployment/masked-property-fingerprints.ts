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
 * TWO FIELDS.
 * - `maskedPropertyFingerprints` (`sha256:`, {@link maskedPropertyFingerprint}):
 *   the template value's TEXT, exactly as #4451 wrote it, so an older cdkd
 *   still reads it and still sends a template edit.
 * - `maskedPropertyInputFingerprints` (`inputs-sha256:<hex>+sha256:<hex>`,
 *   {@link maskedInputFingerprint}): the template value with each NON-SECRET
 *   input replaced by what it resolved to (a parameter's bound value, a
 *   `Ref` / `Fn::GetAtt` result, the branch an evaluated condition selects),
 *   then the text hash it is BOUND to. A `NoEcho` parameter, a
 *   `{{resolve:...}}` reference, and any input derived from one stay in their
 *   UNRESOLVED (template) form: the hash is computed from no secret value, so
 *   it is no confirm oracle (`.claude/rules/layout-deployment-secrets.md`).
 *   The classes are in {@link parameterInputsFor} and `inputForm` below.
 *   Non-`NoEcho` parameter values and cross-stack outputs are treated as
 *   public, so a low-entropy one may be recoverable from the hash: declare a
 *   sensitive one `NoEcho`.
 *
 * The one way a secret can still reach either hash is a template LITERAL
 * equal to a `NoEcho` parameter's value or to a value the same resource
 * resolved as a secret; such a property is refused a hash
 * ({@link REFUSED_FINGERPRINT}) and keeps the pre-#4451 comparison. The
 * parameter values are known from deploy start (backfill and every save); a
 * resolved value only to a save that resolved the resource.
 *
 * COMPATIBILITY. A record with no text fingerprint for a masked property
 * (every record a pre-#4451 cdkd wrote) is compared exactly as before. The
 * deploy backfills it from the template it deploys, the same template the
 * unchanged comparison has just accepted, so the FIRST deploy under this
 * version sends what it sent before, and a later edit is detected. A property
 * with a text fingerprint but no bound input fingerprint (a #4451 record, or
 * one an older cdkd rewrote: it carries the input field untouched, so the
 * binding breaks) is compared as text; while the text matches, the deploy's
 * diff RE-BASELINES its input fingerprint from today's inputs without
 * sending anything.
 */
import { createHash } from 'node:crypto';
import {
  carriesSecretMask,
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
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
/** An input fingerprint's prefix (its own field, go-to-k/cdkd#4543). */
const INPUT_FINGERPRINT_PREFIX = 'inputs-sha256:';
/** Joins an input fingerprint's input half to the text half it is bound to. */
const TEXT_HALF_SEPARATOR = '+';

/** An input fingerprint's two halves; the text half is `undefined` when malformed. */
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
  resolve(
    node: unknown
  ): Promise<{ value: unknown; secrets?: RecordedSecretValues; keepAsWritten?: boolean }>;
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
 * {@link classifyPassedParameters} over the parent's own template). A parent can pass a
 * resolved secret, or a value embedding one, as a plain parameter, and the
 * child cannot tell that from the value (the inherited corpus can miss a short
 * ancestor secret), so only the parent's class vouches for it; the rule
 * `parentSuppliedValues` in `condition-verdicts.ts` applies for the same
 * reason. `unknown`: a parameter with no bound value, one named in `unbound`,
 * and, in a nested child, a value the parent supplied and classified
 * `unknown` or did not classify at all. A parameter the parent did not supply
 * binds the child's `Default` (template text) and is a plain value.
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
    const noEcho =
      isPlainObject(definition) &&
      (definition['NoEcho'] === true || definition['NoEcho'] === 'true');
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
        // fingerprint sources), the value is unknown: neither compared nor
        // stamped, so nothing derived from it is hashed and a later classified
        // deploy re-baselines rather than reading a stale form as moved.
        const passed = args.passedClasses?.get(name);
        if (passed === undefined || passed === 'unknown') {
          inputs.set(name, { kind: 'unknown' });
          continue;
        }
        if (passed === 'secret') secret = true;
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

/**
 * Types whose attributes are handler- or child-defined, and so may be a
 * `NoEcho` value (a custom resource's `Data`, a nested stack's output): an
 * `Fn::GetAtt` on one is kept as written whatever it resolves to. A parent
 * reading a nested stack's output is therefore not sent when only that output
 * moves (go-to-k/cdkd#4565).
 */
const OPAQUE_ATTRIBUTE_TYPES = new Set([
  'AWS::CloudFormation::CustomResource',
  'AWS::CloudFormation::Stack',
]);

function hasOpaqueAttributes(logicalId: string, walk: Walk): boolean {
  const definition = walk.resources[logicalId];
  const type = isPlainObject(definition) ? definition['Type'] : undefined;
  return (
    typeof type === 'string' && (type.startsWith('Custom::') || OPAQUE_ATTRIBUTE_TYPES.has(type))
  );
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
      verdict =
        target === undefined ||
        (Object.hasOwn(walk.resources, target) && hasOpaqueAttributes(target, walk))
          ? 'tainted'
          : nameTaint(target);
    } else if (key === 'Fn::ImportValue' || key === 'Fn::GetStackOutput') verdict = 'tainted';
    else if (key === 'Fn::Sub') {
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
      for (const name of subPlaceholders(text)) {
        if (Object.hasOwn(explicit, name)) continue;
        const dot = name.indexOf('.');
        const part =
          dot > 0 && !name.startsWith('AWS::')
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

function newWalk(sources: MaskedInputSources): Walk {
  return {
    sources,
    resources: isPlainObject(sources.template.Resources) ? sources.template.Resources : {},
    parameters: isPlainObject(sources.template.Parameters) ? sources.template.Parameters : {},
    taint: new Map(),
    inProgress: new Set(),
  };
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
 * parent's sources. A passed parameter missing here reads as `unknown` in the
 * child (see {@link parameterInputsFor}).
 */
export async function classifyPassedParameters(
  parameters: unknown,
  sources: MaskedInputSources
): Promise<Map<string, PassedParameterClass>> {
  const classes = new Map<string, PassedParameterClass>();
  if (!isPlainObject(parameters)) return classes;
  for (const [name, expression] of Object.entries(parameters)) {
    let passedClass: PassedParameterClass;
    try {
      passedClass = (await inputForm(expression, newWalk(sources))).concrete ? 'clean' : 'secret';
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
 * each whose value holds the mask, a needle of `corpora` at or above the
 * needle floor, or a shorter needle as a WHOLE leaf (a superset of what the
 * save masks, which takes a sub-floor needle only whole; a key the save does
 * not mask is never stamped). A nested child with a short parent secret would
 * otherwise fingerprint nearly every key.
 */
export function possiblyMaskedKeys(
  resolvedProps: Record<string, unknown>,
  corpora: ReadonlyArray<RecordedSecretValues | undefined>
): string[] {
  const needles = new Set<string>();
  for (const corpus of corpora) {
    if (corpus === undefined) continue;
    for (const needle of printingCorpusOf(corpus).keys())
      if (needle.length > 0) needles.add(needle);
  }
  const short = [...needles].filter((needle) => needle.length < MIN_NEEDLE_LENGTH);
  const long = [...needles].filter((needle) => needle.length >= MIN_NEEDLE_LENGTH);
  const wholeShortLeaf = (value: unknown): boolean => {
    if (typeof value === 'string') return short.includes(value);
    if (Array.isArray(value)) return value.some(wholeShortLeaf);
    if (isPlainObject(value)) return Object.values(value).some(wholeShortLeaf);
    return false;
  };
  return Object.keys(resolvedProps).filter((key) => {
    const value = resolvedProps[key];
    if (carriesSecretMask(value) || wholeShortLeaf(value)) return true;
    const text = canonicalJson(value);
    return long.some(
      (needle) => text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))
    );
  });
}

/**
 * The input fingerprints of `keys` (what the save stamps on a record this
 * deploy writes); a key whose fingerprint is unknown is left out, and the
 * save stamps its text fingerprint alone.
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
 * The text fingerprint (`sha256:`, go-to-k/cdkd#4451) of every top-level
 * property whose RECORDED (redacted) value carries the mask, over the template
 * value `templateProps` gives it. `undefined` when there is none, so a record
 * with no masked property carries no field. Built through `Object.fromEntries`,
 * since the keys are template-controlled and a `__proto__` property must stay
 * an own key.
 */
export function maskedPropertyFingerprintsFor(
  recordedProperties: Record<string, unknown>,
  templateProps: Record<string, unknown>
): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const key of Object.keys(recordedProperties)) {
    if (!Object.hasOwn(templateProps, key)) continue;
    if (!carriesSecretMask(recordedProperties[key])) continue;
    entries.push([key, maskedPropertyFingerprint(templateProps[key])]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The record's text fingerprints (`maskedPropertyFingerprints`). A missing
 * field, a non-object, a non-string entry, an unknown prefix or a
 * {@link REFUSED_FINGERPRINT} is no fingerprint, which keeps the pre-#4451
 * comparison for it. Exactly what #4451's reader accepts.
 */
export function maskedPropertyFingerprintsOf(record: unknown): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyFingerprints?: unknown }).maskedPropertyFingerprints;
  if (!isPlainObject(field)) return read;
  for (const [key, value] of Object.entries(field)) {
    if (typeof value === 'string' && value.startsWith(FINGERPRINT_PREFIX)) read.set(key, value);
  }
  return read;
}

/**
 * The record's input fingerprints (`maskedPropertyInputFingerprints`,
 * go-to-k/cdkd#4543), each kept only while it is BOUND to the text fingerprint
 * the record holds for the same property: its text half must equal that
 * entry. An older cdkd rewrites the text field and carries this one untouched,
 * so an entry whose text half no longer matches describes a previous
 * generation and reads as absent (re-baselined, never compared).
 */
export function maskedPropertyInputFingerprintsOf(record: unknown): ReadonlyMap<string, string> {
  const read = new Map<string, string>();
  if (record === null || typeof record !== 'object') return read;
  const field = (record as { maskedPropertyInputFingerprints?: unknown })
    .maskedPropertyInputFingerprints;
  if (!isPlainObject(field)) return read;
  const text = maskedPropertyFingerprintsOf(record);
  for (const [key, value] of Object.entries(field)) {
    if (typeof value !== 'string' || !value.startsWith(INPUT_FINGERPRINT_PREFIX)) continue;
    const half = splitInputFingerprint(value).text;
    if (half !== undefined && text.get(key) === half) read.set(key, value);
  }
  return read;
}

/**
 * The input fingerprints a save stamps: one per property the text field holds
 * (an unrefused `sha256:` entry) for which the deploy computed one bound to
 * that same text. `undefined` when there is none.
 */
function boundInputFingerprints(
  textFingerprints: Readonly<Record<string, string>> | undefined,
  inputFingerprints: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (textFingerprints === undefined || inputFingerprints === undefined) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, text] of Object.entries(textFingerprints)) {
    if (!text.startsWith(FINGERPRINT_PREFIX) || !Object.hasOwn(inputFingerprints, key)) continue;
    const input = inputFingerprints[key]!;
    if (splitInputFingerprint(input).text === text) entries.push([key, input]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The top-level properties the record holds as the mask whose template value
 * or resolved inputs moved since it was written: the changes a `***` == `***`
 * comparison cannot see. Only a property the record fingerprinted, still
 * holds masked, and the template still declares counts; anything else the
 * ordinary comparison already decides (an added, removed or unmasked value
 * differs from `***`).
 *
 * The text fingerprint is compared first, as #4451 compared it. When the text
 * is unchanged, a bound input fingerprint is compared with what `fingerprinter`
 * computes; with no fingerprinter, or an input unknown on this side, the
 * property reads as unmoved. A property with NO bound input fingerprint (a
 * record #4451 wrote, or one an older cdkd rewrote since) is reported to
 * `onRebaseline` with today's input fingerprint, which the deploy stamps
 * without sending.
 */
export async function movedMaskedProperties(
  record: Pick<ResourceState, 'properties'> & {
    maskedPropertyFingerprints?: unknown;
    maskedPropertyInputFingerprints?: unknown;
  },
  templateProps: Record<string, unknown>,
  fingerprinter?: InputFingerprinter,
  onRebaseline?: (key: string, fingerprint: string) => void
): Promise<string[]> {
  const recorded = maskedPropertyFingerprintsOf(record);
  if (recorded.size === 0) return [];
  const properties = record.properties as unknown;
  if (properties === null || typeof properties !== 'object') return [];
  const inputs = maskedPropertyInputFingerprintsOf(record);
  const moved: string[] = [];
  for (const [key, fingerprint] of recorded) {
    if (!Object.hasOwn(templateProps, key) || !Object.hasOwn(properties, key)) continue;
    if (!carriesSecretMask((properties as Record<string, unknown>)[key])) continue;
    if (maskedPropertyFingerprint(templateProps[key]) !== fingerprint) {
      moved.push(key);
      continue;
    }
    if (fingerprinter === undefined) continue;
    const bound = inputs.get(key);
    if (bound === undefined && onRebaseline === undefined) continue;
    const now = await fingerprinter(key);
    if (now === undefined) continue;
    if (bound !== undefined) {
      if (splitInputFingerprint(now).input !== splitInputFingerprint(bound).input) moved.push(key);
    } else {
      onRebaseline!(key, now);
    }
  }
  return moved;
}

/**
 * `record` with `fingerprints` written into its input field (a new record
 * object; the bag it came from is not touched), each only while it is bound to
 * the text fingerprint the record holds for that property.
 */
export function withRebaselinedFingerprints<T extends object>(
  record: T,
  fingerprints: Readonly<Record<string, string>>
): T {
  const text = maskedPropertyFingerprintsOf(record);
  const field = (record as { maskedPropertyInputFingerprints?: unknown })
    .maskedPropertyInputFingerprints;
  const next: Array<[string, unknown]> = isPlainObject(field) ? Object.entries(field) : [];
  let changed = false;
  for (const [key, value] of Object.entries(fingerprints)) {
    if (text.get(key) !== splitInputFingerprint(value).text) continue;
    const at = next.findIndex(([k]) => k === key);
    if (at >= 0) next[at] = [key, value];
    else next.push([key, value]);
    changed = true;
  }
  return changed
    ? { ...record, maskedPropertyInputFingerprints: Object.fromEntries(next) }
    : record;
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
 * Otherwise `scrubbed` unchanged, carrying whatever fields it had, except
 * that an entry whose template text holds a needle of `secrets` (the
 * resource's own resolution) or of `noEchoParameterValues` (the stack's
 * `NoEcho` parameters) becomes {@link REFUSED_FINGERPRINT} and loses its input
 * fingerprint. `inputFingerprints` are the input fingerprints the deploy
 * computed when it resolved the resource (go-to-k/cdkd#4543); each is stamped
 * only while bound to the text fingerprint stamped beside it.
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
  const {
    maskedPropertyFingerprints: previous,
    maskedPropertyInputFingerprints: previousInputs,
    ...rest
  } = scrubbed;
  let fingerprints: Record<string, string> | undefined;
  let inputs: Record<string, string> | undefined;
  if (written) {
    fingerprints = maskedPropertyFingerprintsFor(scrubbed.properties, templateProps);
    inputs = boundInputFingerprints(fingerprints, inputFingerprints);
  } else {
    // Carried as it was, except that this save may hold the needles a
    // backfill or an earlier save could not see.
    if (!isPlainObject(previous)) return scrubbed;
    if (corpora.length === 0) return scrubbed;
    fingerprints = { ...(previous as Record<string, string>) };
    inputs = isPlainObject(previousInputs)
      ? { ...(previousInputs as Record<string, string>) }
      : undefined;
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
      // A refused property's input fingerprint hashes the same template text.
      if (inputs !== undefined) {
        const kept = Object.entries(inputs).filter(([key]) => !refused.includes(key));
        inputs = kept.length > 0 ? Object.fromEntries(kept) : undefined;
      }
    }
  }
  if (
    !written &&
    JSON.stringify(fingerprints) === JSON.stringify(previous) &&
    JSON.stringify(inputs) === JSON.stringify(previousInputs)
  ) {
    return scrubbed;
  }
  return {
    ...rest,
    ...(fingerprints !== undefined && { maskedPropertyFingerprints: fingerprints }),
    ...(inputs !== undefined && { maskedPropertyInputFingerprints: inputs }),
  };
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
