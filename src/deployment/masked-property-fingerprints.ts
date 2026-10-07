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
  /**
   * The template of the nested stack a `AWS::CloudFormation::Stack` row of
   * {@link template} names, read from the cloud assembly (go-to-k/cdkd#4565).
   * An `Fn::GetAtt` on that row's `Outputs.<Key>` is resolved only when the
   * output is classified clean from these templates (see
   * {@link nestedStackOutputClass}). Absent: every such read is kept as written.
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
class UnknownInput extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const DYNAMIC_REFERENCE_OPEN = '{{resolve:';
const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';
const NESTED_OUTPUT_PREFIX = 'Outputs.';

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
 * {@link classifyPassedParameters} over the parent's own template) or did not
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
  /** Nested-stack rows whose passed values are being classified above this walk. */
  stackChain: ReadonlySet<string>;
  /** Shared by every nested-output classification one entry point starts. */
  shared: NestedShared;
}

/**
 * What one entry point ({@link maskedInputFingerprint},
 * {@link classifyPassedParameters}, {@link nestedStackOutputClass}) learns
 * about nested-stack outputs, so each row's passed values and each child
 * output are classified once, however many reads reach them: the work is
 * linear in the templates, and `steps` is a backstop for a hostile tree only.
 * Every read is made in template order ({@link inputForms}), so the same
 * templates spend the same steps, in the same order, on every side.
 */
interface NestedShared {
  steps: number;
  /** A parent row's passed classes, by logical id. */
  passed: Map<string, ReadonlyMap<string, PassedParameterClass>>;
  /** A child output's class, by template identity, output name and passed classes. */
  outputs: Map<string, NestedOutputClass>;
  /** A child row's passed classes, by its template identity, that template's passed classes and the row. */
  rowsPassed: Map<string, ReadonlyMap<string, PassedParameterClass>>;
}

function newShared(): NestedShared {
  return { steps: 0, passed: new Map(), outputs: new Map(), rowsPassed: new Map() };
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
 * `Fn::GetAtt` on one is kept as written whatever it resolves to, and a
 * resource whose definition reads one counts as reading a secret. The one
 * exception is a masked property's DIRECT read of a nested stack's
 * `Outputs.<Key>` (an `Fn::GetAtt`, or an `Fn::Sub` placeholder): it is
 * resolved when the output is classified clean from the child's template
 * ({@link nestedStackOutputClass}, go-to-k/cdkd#4565). A custom resource's
 * attributes are fixed only when its handler runs, so they have no such path.
 */
const OPAQUE_ATTRIBUTE_TYPES = new Set(['AWS::CloudFormation::CustomResource', NESTED_STACK_TYPE]);

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
function conditionClosure(
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
function mapReadClass(
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
async function inputForm(value: unknown, walk: Walk): Promise<InputForm> {
  if (typeof value === 'string') {
    return { form: value, concrete: !value.includes(DYNAMIC_REFERENCE_OPEN) };
  }
  if (Array.isArray(value)) {
    const parts = await inputForms(value, walk);
    return { form: parts.map((p) => p.form), concrete: parts.every((p) => p.concrete) };
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

function newWalk(
  sources: MaskedInputSources,
  nested: { stackChain: ReadonlySet<string>; shared: NestedShared } = {
    stackChain: new Set(),
    shared: newShared(),
  }
): Walk {
  return {
    sources,
    resources: isPlainObject(sources.template.Resources) ? sources.template.Resources : {},
    parameters: isPlainObject(sources.template.Parameters) ? sources.template.Parameters : {},
    taint: new Map(),
    inProgress: new Set(),
    stackChain: nested.stackChain,
    shared: nested.shared,
  };
}

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

function isNestedStackRow(logicalId: string, walk: Walk): boolean {
  if (!Object.hasOwn(walk.resources, logicalId)) return false;
  const definition = walk.resources[logicalId];
  return isPlainObject(definition) && definition['Type'] === NESTED_STACK_TYPE;
}

/** The attribute an `Fn::GetAtt` operand names; `undefined` when not a literal. */
function getAttAttribute(operand: unknown, target: string): string | undefined {
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
    const noEcho =
      isPlainObject(definition) &&
      (definition['NoEcho'] === true || definition['NoEcho'] === 'true');
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
 * the parent side's {@link inputForms} is, so the memo and the step budget
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
async function nestedOutputInput(
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
 * {@link parameterInputsFor}).
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

/** Whether `bag` was written from the template this deploy resolved. */
export function isWrittenFromDeployedTemplate(bag: unknown): boolean {
  return bag !== null && typeof bag === 'object' && writtenFromDeployedTemplate.has(bag);
}

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
