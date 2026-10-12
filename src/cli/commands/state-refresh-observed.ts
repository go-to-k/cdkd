import { readFileSync } from 'node:fs';
import { InvalidArgumentError } from 'commander';
import { resourcesNamingDeclaredParameter } from '../../analyzer/parameter-dependence.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../../utils/display-safe.js';
import { parseCfnTemplateWithFormat } from '../yaml-cfn.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { fsReadErrorCause } from './export.js';

/**
 * `cdkd state refresh-observed <stack> --accept-refused <LogicalId> --template
 * <file>` (issue [#3466](https://github.com/go-to-k/cdkd/issues/3466)): the
 * user-asserted exit from an `observedBaselineRefused` marker that no in-place
 * deploy clears.
 *
 * The record cannot say which of its leaves a template parameter bound, so the
 * gate reads the TEMPLATE the user deployed. It fails closed: the override is
 * offered only when that template no longer makes the resource depend on any
 * declared parameter, and no leaf of the recorded `properties` still equals a
 * declared parameter's `Default`. Everything else stays the caller's: the
 * capture goes through the same position-based redaction as an ordinary
 * refresh, and the markers are cleared only after it succeeded.
 */

/** Commander parser for `--accept-refused`: collects, so a second id is refused rather than silently winning. */
export function collectAcceptRefused(value: string, previous: string[] | undefined): string[] {
  if (value === '') {
    throw new InvalidArgumentError('--accept-refused takes one logical id.');
  }
  return [...(previous ?? []), value];
}

/**
 * Read the `--template` file. Neither failure echoes the parser's message,
 * which can quote template text, nor the fs error's, which repeats the path.
 */
export function readAcceptRefusedTemplate(path: string): Record<string, unknown> {
  const shown = displayIdent(path, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read the --template file ${shown}: ${fsReadErrorCause(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = parseCfnTemplateWithFormat(raw).template;
  } catch {
    parsed = undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `The --template file ${shown} is not a valid CloudFormation template (JSON or YAML).`
    );
  }
  return parsed as Record<string, unknown>;
}

/** The gate's answer. `legacy` is a marker recorded without a reason this cdkd recognizes. */
export type AcceptRefusedVerdict = { ok: true; legacy: boolean } | { ok: false; reason: string };

/**
 * Whether the refusal on `record` may be accepted, judged against the template
 * the user says they deployed. Every refusal reason names the logical id
 * through `displayIdent` and echoes no template or record VALUE.
 */
export function judgeAcceptRefused(
  record: ResourceState | undefined,
  logicalId: string,
  template: Record<string, unknown>,
  stack: DeployedShapeContext
): AcceptRefusedVerdict {
  const id = displayIdent(logicalId);
  if (record === undefined) {
    return { ok: false, reason: `The stack's state record has no resource ${id}.` };
  }
  if (record.observedBaselineRefused !== true) {
    return {
      ok: false,
      reason:
        `${id} carries no observed-baseline refusal, so there is nothing to accept. ` +
        `Run 'cdkd state refresh-observed' without --accept-refused to refresh it.`,
    };
  }
  // Read as unknown: the record is unvalidated input, and only the one known
  // non-parameter value is refused here. Absent or unknown is the legacy class.
  const reason: unknown = record.observedBaselineRefusalReason;
  if (reason === 'incomplete-resolution') {
    return {
      ok: false,
      reason:
        `The refusal on ${id} is not over a template parameter, and --accept-refused overrides only ` +
        `that class. A deploy that actually CHANGES the resource restores its baseline.`,
    };
  }
  const legacy = reason !== 'unverifiable-parameter';

  const verdict = resourcesNamingDeclaredParameter(
    template as unknown as CloudFormationTemplate | undefined
  );
  if (verdict.failedClosed !== undefined) {
    return {
      ok: false,
      reason:
        `The template's parameter dependence could not be judged (${verdict.failedClosed}), ` +
        `so the refusal on ${id} cannot be accepted.`,
    };
  }
  const resources = template['Resources'] as Record<string, unknown>;
  const definition = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    return {
      ok: false,
      reason:
        `The template defines no resource ${id}. Pass the template this stack was last ` +
        `deployed from (for a nested stack, the child's own template).`,
    };
  }
  if ((definition as Record<string, unknown>)['Type'] !== record.resourceType) {
    return {
      ok: false,
      reason:
        `The template's ${id} is not the resource type the state record holds, so the template ` +
        `does not describe this resource.`,
    };
  }
  if (verdict(logicalId)) {
    return {
      ok: false,
      reason:
        `In this template ${id} still depends on a template parameter, and cdkd binds a ` +
        `parameter's Default, which is not what AWS may hold. Make the template spell the ` +
        `value as a dynamic reference (or a literal), deploy it, then run this again.`,
    };
  }
  // The template only says what the resource SHOULD hold. Accept it as the
  // deployed shape only when the record PROVES it: every leaf of the recorded
  // `properties` is what this template's definition yields there, evaluated
  // against the stack's own records. Then no leaf the refusal distrusted
  // (a parameter-bound one) survives in the record, since the definition
  // reads no parameter. Anything the check cannot evaluate refuses.
  const shape = matchesDeployedShape(
    (definition as Record<string, unknown>)['Properties'] ?? {},
    record.properties,
    stack
  );
  if (shape === 'unprovable') {
    return {
      ok: false,
      reason:
        `The template defines ${id} with a function cdkd cannot work out from the state records ` +
        `(only Ref, Fn::GetAtt, Fn::Join, Fn::Sub and Fn::Select of what the stack records), so ` +
        `cdkd cannot prove the template was deployed to the resource. A deploy does not change ` +
        `that; replacing the resource clears the refusal.`,
    };
  }
  if (shape === 'differs') {
    return {
      ok: false,
      reason:
        `The state record of ${id} does not hold what this template defines for it, so cdkd ` +
        `cannot prove the template was deployed to the resource. Pass the template it was last ` +
        `deployed from, or deploy this one and run this again. If cdkd records this resource with ` +
        `fewer properties than the template sets (one it does not send), a deploy does not ` +
        `change that, and replacing the resource clears the refusal.`,
    };
  }
  const hit = parameterDefaultInProperties(template, record.properties);
  if (hit !== undefined) {
    return {
      ok: false,
      reason:
        `A recorded property of ${id} holds the Default of the template parameter ` +
        `${displayIdent(hit)}, so the record may still hold the placeholder the refusal ` +
        `distrusted. If the template no longer uses the parameter there, deploy it and run this ` +
        `again. If the value only coincides with that Default, change or remove the parameter's ` +
        `Default and deploy, or replace the resource.`,
    };
  }
  return { ok: true, legacy };
}

/** What {@link matchesDeployedShape} evaluates a template intrinsic against. */
export interface DeployedShapeContext {
  /** The stack's name as cdkd records it (`AWS::StackName`). */
  stackName: string;
  /** The stack's region (`AWS::Region`, and the partition and URL suffix it implies). */
  region: string;
  /** The stack's resource records, for `Ref` and `Fn::GetAtt`. */
  resources: Record<string, ResourceState>;
}

/** A 12-digit account id slot: `AWS::AccountId` is not in the record, and no parameter. */
const ACCOUNT = Symbol('account');
type Part = string | typeof ACCOUNT;
/**
 * A `Ref` / `Fn::GetAtt` whose target record or attribute the stack does not
 * hold yet: a difference a deploy of the template may remove, unlike a
 * function this check cannot evaluate at all (`undefined`).
 */
const MISSING = Symbol('missing');
type Evaluated = Part[] | typeof MISSING | undefined;

/**
 * Whether `recorded` is exactly what the template value `node` yields: equal
 * literals, equal keys and lengths, and each intrinsic evaluated (against
 * `stack`) to the recorded string. Fails closed. `'unprovable'` (an intrinsic
 * it cannot evaluate, which no deploy changes) wins over `'differs'` (a
 * difference a deploy of this template may remove), so the remedy named is
 * the one that can work. Iterative over the bag.
 */
function matchesDeployedShape(
  node: unknown,
  recorded: unknown,
  stack: DeployedShapeContext
): 'match' | 'differs' | 'unprovable' {
  let differs = false;
  let unprovable = false;
  const pending: Array<[unknown, unknown]> = [[node, recorded]];
  while (pending.length > 0) {
    const [t, r] = pending.pop()!;
    if (t === null || typeof t !== 'object') {
      if (t !== r) differs = true;
    } else if (Array.isArray(t)) {
      if (!Array.isArray(r) || r.length !== t.length) differs = true;
      else t.forEach((item, i) => pending.push([item, (r as unknown[])[i]]));
    } else if (isIntrinsic(t)) {
      const parts = evaluate(t, stack);
      if (parts === undefined) {
        unprovable = true;
        continue;
      }
      if (parts === MISSING) {
        differs = true;
        continue;
      }
      const text = typeof r === 'string' ? r : typeof r === 'number' ? String(r) : undefined;
      if (text === undefined || !partsPattern(parts).test(text)) differs = true;
    } else if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      differs = true;
    } else {
      const tKeys = Object.keys(t).sort();
      const rKeys = Object.keys(r).sort();
      if (tKeys.length !== rKeys.length || tKeys.some((k, i) => k !== rKeys[i])) differs = true;
      for (const k of tKeys) {
        if (!Object.hasOwn(r, k)) continue;
        pending.push([(t as Record<string, unknown>)[k], (r as Record<string, unknown>)[k]]);
      }
    }
  }
  return unprovable ? 'unprovable' : differs ? 'differs' : 'match';
}

function isIntrinsic(node: object): boolean {
  const keys = Object.keys(node);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

function partsPattern(parts: Part[]): RegExp {
  const body = parts
    .map((p) => (p === ACCOUNT ? '[0-9]{12}' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * A scalar the record can hold, as parts; {@link MISSING} for a reference to a
 * record or attribute the stack lacks; `undefined` for anything not evaluable
 * here, which wins over {@link MISSING} in a composite.
 */
function evaluate(node: unknown, stack: DeployedShapeContext): Evaluated {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number' && Number.isFinite(node)) return [String(node)];
  if (node === null || typeof node !== 'object' || Array.isArray(node) || !isIntrinsic(node)) {
    return undefined;
  }
  const [fn, arg] = Object.entries(node)[0]!;
  switch (fn) {
    case 'Ref':
      return typeof arg === 'string' ? reference(arg, stack) : undefined;
    case 'Fn::GetAtt': {
      const pair =
        typeof arg === 'string'
          ? arg.includes('.')
            ? [arg.slice(0, arg.indexOf('.')), arg.slice(arg.indexOf('.') + 1)]
            : undefined
          : arg;
      if (!Array.isArray(pair) || pair.length !== 2) return undefined;
      const [target, attribute] = pair as unknown[];
      return typeof target === 'string' && typeof attribute === 'string'
        ? attributeOf(target, attribute, stack)
        : undefined;
    }
    case 'Fn::Join': {
      if (!Array.isArray(arg) || arg.length !== 2) return undefined;
      const [delimiter, list] = arg as unknown[];
      if (typeof delimiter !== 'string' || !Array.isArray(list)) return undefined;
      const out: Part[] = [];
      let missing = false;
      for (let i = 0; i < list.length; i++) {
        const parts = evaluate(list[i], stack);
        if (parts === undefined) return undefined;
        if (i > 0 && delimiter !== '') out.push(delimiter);
        if (parts === MISSING) missing = true;
        else out.push(...parts);
      }
      return missing ? MISSING : out;
    }
    case 'Fn::Select': {
      if (!Array.isArray(arg) || arg.length !== 2) return undefined;
      const [index, list] = arg as unknown[];
      const i = typeof index === 'number' ? index : typeof index === 'string' ? Number(index) : NaN;
      if (!Number.isInteger(i) || !Array.isArray(list) || i < 0 || i >= list.length) {
        return undefined;
      }
      return evaluate(list[i], stack);
    }
    case 'Fn::Sub': {
      const [text, vars] = Array.isArray(arg) ? (arg as unknown[]) : [arg, {}];
      if (
        typeof text !== 'string' ||
        vars === null ||
        typeof vars !== 'object' ||
        Array.isArray(vars)
      ) {
        return undefined;
      }
      const out: Part[] = [];
      let missing = false;
      let last = 0;
      for (const m of text.matchAll(/\$\{([^}]*)\}/g)) {
        out.push(text.slice(last, m.index));
        last = m.index! + m[0].length;
        const name = m[1]!;
        if (name.startsWith('!')) {
          out.push(`\${${name.slice(1)}}`);
          continue;
        }
        const parts = Object.hasOwn(vars, name)
          ? evaluate((vars as Record<string, unknown>)[name], stack)
          : name.includes('.')
            ? attributeOf(
                name.slice(0, name.indexOf('.')),
                name.slice(name.indexOf('.') + 1),
                stack
              )
            : reference(name, stack);
        if (parts === undefined) return undefined;
        if (parts === MISSING) missing = true;
        else out.push(...parts);
      }
      out.push(text.slice(last));
      return missing ? MISSING : out;
    }
    default:
      return undefined;
  }
}

function reference(name: string, stack: DeployedShapeContext): Evaluated {
  switch (name) {
    case 'AWS::Region':
      return [stack.region];
    case 'AWS::Partition':
      return [derivePartitionAndUrlSuffix(stack.region).partition];
    case 'AWS::URLSuffix':
      return [derivePartitionAndUrlSuffix(stack.region).urlSuffix];
    case 'AWS::AccountId':
      return [ACCOUNT];
    case 'AWS::StackName':
      return [stack.stackName];
  }
  if (name.startsWith('AWS::')) return undefined;
  if (!Object.hasOwn(stack.resources, name)) return MISSING;
  const physicalId: unknown = stack.resources[name]?.physicalId;
  return typeof physicalId === 'string' ? [physicalId] : undefined;
}

function attributeOf(target: string, attribute: string, stack: DeployedShapeContext): Evaluated {
  if (!Object.hasOwn(stack.resources, target)) return MISSING;
  const attributes: unknown = stack.resources[target]?.attributes;
  if (attributes === null || typeof attributes !== 'object') return MISSING;
  if (!Object.hasOwn(attributes, attribute)) return MISSING;
  const value: unknown = (attributes as Record<string, unknown>)[attribute];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  return undefined;
}

/** Below this length a Default matches a whole leaf only; at or above it, any leaf containing it. */
const DEFAULT_SUBSTRING_MIN_LENGTH = 4;

/**
 * The name of a declared parameter whose non-empty `Default` some scalar leaf of
 * `properties` holds (each item too, for a list-typed parameter), or
 * `undefined`. A leaf holds a Default it equals, or, for a Default of at least
 * {@link DEFAULT_SUBSTRING_MIN_LENGTH} characters, one it contains (a Default
 * joined or substituted into a longer value). A Default that is not a string
 * or a finite number is skipped.
 */
function parameterDefaultInProperties(
  template: Record<string, unknown>,
  properties: unknown
): string | undefined {
  const parameters = template['Parameters'];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return undefined;
  }
  const needles = new Map<string, string>();
  for (const [name, decl] of Object.entries(parameters as Record<string, unknown>)) {
    if (decl === null || typeof decl !== 'object') continue;
    const raw: unknown = (decl as Record<string, unknown>)['Default'];
    let text: string | undefined;
    if (typeof raw === 'string') text = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw);
    if (text === undefined || text === '') continue;
    if (!needles.has(text)) needles.set(text, name);
    const type: unknown = (decl as Record<string, unknown>)['Type'];
    if (typeof type === 'string' && (type === 'CommaDelimitedList' || type.startsWith('List<'))) {
      for (const item of text.split(',')) {
        const trimmed = item.trim();
        if (trimmed !== '' && !needles.has(trimmed)) needles.set(trimmed, name);
      }
    }
  }
  if (needles.size === 0) return undefined;
  // Iterative, so a deep bag cannot overflow the call stack.
  const pending: unknown[] = [properties];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      const text = String(value);
      const exact = needles.get(text);
      if (exact !== undefined) return exact;
      for (const [needle, name] of needles) {
        if (needle.length >= DEFAULT_SUBSTRING_MIN_LENGTH && text.includes(needle)) return name;
      }
    } else if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (value !== null && typeof value === 'object') {
      pending.push(...Object.values(value as Record<string, unknown>));
    }
  }
  return undefined;
}

/**
 * What the user asserts by accepting. Printed as the prompt, and at `warn`
 * under `--yes` so the run's log records it. Never echoes the recorded reason.
 */
export function acceptRefusedAssertion(
  logicalId: string,
  resourceType: string,
  stackRef: string,
  legacy: boolean
): string {
  return (
    `Accepting the refused observed baseline of ${displayIdent(logicalId)} ` +
    `(${displayIdent(resourceType)}) in ${stackRef}. ` +
    (legacy
      ? `The refusal was recorded without a reason this cdkd recognizes, and is treated as one over a ` +
        `template parameter whose deployed value cdkd could not prove. `
      : `cdkd refused it because the resource reads a template parameter whose deployed value it ` +
        `could not prove. `) +
    `By accepting you assert that this template is deployed, and that AWS holds NO secret at any ` +
    `position of this resource that the template does not spell as a dynamic reference ` +
    `({{resolve:...}}): whatever AWS holds there now is written to state.json as the drift ` +
    `baseline, in plaintext. A deploy does not resend a value the record already holds, so a ` +
    `literal there need not be what AWS holds.`
  );
}

/**
 * The `--accept-refused` confirmation. Reached only without `--yes`, so
 * `confirmOrRefuse`'s non-interactive refusal fires only on an unflagged run.
 */
export async function confirmAcceptRefused(assertion: string): Promise<boolean> {
  return confirmOrRefuse(`${assertion}\nAccept it?`, {
    refusal:
      'The cdkd state refresh-observed --accept-refused confirmation prompt cannot run in a ' +
      'non-interactive environment. Pass -y / --yes to make the assertion, or run the command ' +
      'from a real terminal.',
  });
}
