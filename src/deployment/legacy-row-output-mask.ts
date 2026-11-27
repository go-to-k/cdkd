import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState } from '../types/state.js';
import { displayIdent, displayStackName } from '../utils/display-safe.js';
import { cdkdRemedy, proseQuoted } from '../utils/pasteable-command.js';
import { SECRET_MASK } from './secret-redaction.js';
import { carriesSecretMask } from './secret-redaction/mask-only.js';
import { readsNoEchoSource, type NoEchoPositionSources } from './secret-redaction/noecho-leaves.js';
import { SPELLED_SECRET_REFERENCE_PREFIXES } from './secret-redaction/anchors.js';
import { markNonRetryable } from './retryable-errors.js';
import { NESTED_STACK_RESOURCE_TYPE } from './rollback-executor/types.js';
import type {
  ChildTemplateLoader,
  NestedTemplate,
} from './masked-property-fingerprints/input-walk.js';
import { childTemplateLoader } from './nested-output-templates.js';
import { getCurrentNestedStackContext } from '../provisioning/nested-stack-context.js';
import {
  mixesDynamicReference,
  templateMixesDynamicReference,
} from '../cli/commands/diff-recursive/passed-secret-display.js';

const OUTPUT_PREFIX = 'Outputs.';

/**
 * go-to-k/cdkd#7097: a nested-stack row record written before cdkd masked a
 * secret-derived child output holds that output's PLAINTEXT in
 * `attributes['Outputs.<K>']`, where a current record holds `***`. Served as
 * it is, a root output reading it (and its export) persisted the plaintext,
 * and every importing stack's deploy plan printed it.
 *
 * This makes such a record behave exactly as a current one, before anything
 * reads it: each `Outputs.<K>` the CHILD template's output `K` derives from a
 * parameter the row passes MIXED with a dynamic reference (#7068's shape), or
 * from a secret reference a row of the child (at any depth) composes with
 * other text, is read as `***`. From there the existing semantics apply
 * unchanged: a root output and its export persist `***`, and a property
 * reading it is refused.
 *
 * Precise by construction: an output of the same row that reads no such
 * source keeps its value (masking the whole row would change what consumers
 * import), and so does an id (`Ref`, `Arn`) of a resource that merely reads
 * one ({@link derivedOutputsOf}). When the child template cannot be read
 * while the record says the row is a secret's, the deploy is REFUSED rather
 * than guessed either way.
 *
 * Returns the reads it rewrote, for the export guard.
 */
export function maskLegacyTaintedRowOutputs(
  state: StackState,
  template: CloudFormationTemplate,
  stackName: string,
  childTemplate: ChildTemplateLoader | undefined = childTemplateLoader(
    getCurrentNestedStackContext()?.nestedTemplates
  )
): LegacyMaskedReads {
  const masked = new Map<string, Set<string>>();
  const rows = (template.Resources ?? {}) as Record<string, unknown>;
  for (const [logicalId, rawRow] of Object.entries(rows)) {
    const row = rawRow as { Type?: unknown; Properties?: Record<string, unknown> } | null;
    if (row?.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const record = Object.hasOwn(state.resources ?? {}, logicalId)
      ? state.resources[logicalId]
      : undefined;
    const attributes = record?.attributes;
    if (attributes === undefined) continue;
    const plainOutputs = Object.keys(attributes).filter(
      (key) =>
        key.startsWith(OUTPUT_PREFIX) &&
        typeof attributes[key] === 'string' &&
        !carriesSecretMask(attributes[key])
    );
    if (plainOutputs.length === 0) continue;
    const mixedKeys = recordedSecretKeys(record?.properties);
    const child = childTemplate?.(logicalId);
    if (child === undefined) {
      // Nothing recorded says the row is a secret's: no evidence to refuse on.
      // A secret composed one level down is decided from the child template,
      // which a deployable tree always has (review: the depth-3 shape).
      if (mixedKeys.size === 0) continue;
      throw refusal(
        stackName,
        logicalId,
        plainOutputs.map((key) => key.slice(OUTPUT_PREFIX.length))
      );
    }
    const derived = derivedOutputsOf(
      child,
      mixedKeys,
      plainParameterValues(recordOf(record?.properties)['Parameters']),
      0
    );
    if (derived !== ALL_OUTPUTS && derived.size === 0) continue;
    for (const key of plainOutputs) {
      const name = key.slice(OUTPUT_PREFIX.length);
      if (derived !== ALL_OUTPUTS && !derived.has(name)) continue;
      attributes[key] = SECRET_MASK;
      let reads = masked.get(logicalId);
      if (reads === undefined) masked.set(logicalId, (reads = new Set()));
      reads.add(key);
    }
  }
  return masked;
}

/**
 * The `Fn::GetAtt` reads (row logical id -> `Outputs.<K>` attribute names)
 * {@link maskLegacyTaintedRowOutputs} rewrote from a legacy plaintext to the
 * mask. The export guard relaxes its compare for exports reading these alone.
 */
export type LegacyMaskedReads = ReadonlyMap<string, ReadonlySet<string>>;

/** Stands for every output of a stack whose template cannot be read. */
const ALL_OUTPUTS = Symbol('all-outputs');
type DerivedOutputs = ReadonlySet<string> | typeof ALL_OUTPUTS;

/** Deeper than any tree CDK synthesizes; a cyclic tree stops here, masking (never leaking). */
const MAX_DEPTH = 32;

/**
 * The outputs of the nested stack `entry` whose value derives from one of
 * `tainted` (its parameters the parent passes secret-derived), or from a
 * secret reference one of ITS rows composes with other text, at any depth.
 *
 * What counts as reading a tainted source, as a current record's value scan
 * would see it:
 *
 * - a `Ref` / `Fn::Sub` of a tainted parameter;
 * - an `Fn::GetAtt` of a nested row's `Outputs.<J>` that is derived in turn
 *   (that row's template decides; one that cannot be read counts whole);
 * - an `Fn::GetAtt` of a resource attribute NAMED after a property reading a
 *   tainted source (an attribute echoing its property, `Value` of an SSM
 *   parameter).
 *
 * Not: a resource's `Ref` or an id attribute (`Arn`) of a resource that merely
 * reads one. A current record keeps such an id copy as written
 * (go-to-k/cdkd#4849), and masking it would refuse a parent reading it.
 *
 * A row's parameter is tainted when it reads one of these, or when its
 * template value composes a `ssm-secure` / `secretsmanager` reference with
 * other text. A PUBLIC `ssm` reference is resolved into the record as its
 * value, as one level up, so it taints nothing.
 */
function derivedOutputsOf(
  entry: NestedTemplate,
  tainted: ReadonlySet<string>,
  passedValues: Readonly<Record<string, string>>,
  depth: number
): DerivedOutputs {
  if (depth > MAX_DEPTH) return ALL_OUTPUTS;
  const template = entry.template;
  const resources = recordOf(template.Resources);
  const rowMemo = new Map<string, DerivedOutputs>();
  // Resource id -> property name -> whether it reads a tainted source.
  const attributeMemo = new Map<string, Map<string, boolean>>();
  const sources: NoEchoPositionSources = {
    parameters: tainted,
    attributeIsNoEcho: (id, attribute) => attributeIsDerived(id, attribute),
    // Review: an `Fn::If` whose condition the passed values decide reads only
    // the branch it selects, as the value a current record holds does.
    conditions: knownConditions(template, passedValues),
  };
  const rowDerived = (id: string): DerivedOutputs => {
    const known = rowMemo.get(id);
    if (known !== undefined) return known;
    rowMemo.set(id, new Set()); // a cycle between rows reads nothing more
    const parameters = recordOf(recordOf(recordOf(resources[id])['Properties'])['Parameters']);
    const passed = new Set<string>();
    for (const [key, value] of Object.entries(parameters)) {
      if (composesSecretReference(value) || readsNoEchoSource(value, sources)) passed.add(key);
    }
    let result: DerivedOutputs = new Set();
    if (passed.size > 0) {
      const grandchild = entry.childTemplate(id);
      result =
        grandchild === undefined
          ? ALL_OUTPUTS
          : derivedOutputsOf(grandchild, passed, plainParameterValues(parameters), depth + 1);
    }
    rowMemo.set(id, result);
    return result;
  };
  const attributeIsDerived = (id: string, attribute: string): boolean => {
    if (!Object.hasOwn(resources, id)) return false;
    const resource = recordOf(resources[id]);
    if (resource['Type'] === NESTED_STACK_RESOURCE_TYPE) {
      if (!attribute.startsWith(OUTPUT_PREFIX)) return false;
      const derived = rowDerived(id);
      return derived === ALL_OUTPUTS || derived.has(attribute.slice(OUTPUT_PREFIX.length));
    }
    const property = attribute.split('.')[0]!;
    const properties = recordOf(resource['Properties']);
    if (!Object.hasOwn(properties, property)) return false;
    let memo = attributeMemo.get(id);
    if (memo === undefined) attributeMemo.set(id, (memo = new Map()));
    const known = memo.get(property);
    if (known !== undefined) return known;
    memo.set(property, false); // a cycle reads nothing more
    const reads =
      composesSecretReference(properties[property]) ||
      readsNoEchoSource(properties[property], sources);
    memo.set(property, reads);
    return reads;
  };
  const derived = new Set<string>();
  for (const [name, output] of Object.entries(recordOf(template.Outputs))) {
    if (readsNoEchoSource(recordOf(output)['Value'], sources)) derived.add(name);
  }
  return derived;
}

/**
 * The parameter values a row passes that are plain text: a recorded value, or
 * a template literal, holding no dynamic reference and no mask. Only these may
 * decide a condition.
 */
function plainParameterValues(parameters: unknown): Record<string, string> {
  const values = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(recordOf(parameters))) {
    if (typeof value !== 'string' || value.includes('{{resolve:') || carriesSecretMask(value)) {
      continue;
    }
    values[key] = value;
  }
  return values;
}

/**
 * The verdicts of the template's conditions that plain values decide:
 * `Fn::Equals` / `Fn::And` / `Fn::Or` / `Fn::Not` / `Condition` over literals
 * and `Ref`s of parameters passed plain (or left at a string `Default`). A
 * condition reading anything else is left out, so its `Fn::If` reads both
 * branches (masking, never leaking).
 */
function knownConditions(
  template: CloudFormationTemplate,
  passedValues: Readonly<Record<string, string>>
): Record<string, boolean> {
  const declared = recordOf(template.Conditions);
  const parameters = recordOf(template.Parameters);
  const verdicts = Object.create(null) as Record<string, boolean>;
  const visiting = new Set<string>();
  const valueOf = (node: unknown): string | undefined => {
    if (typeof node === 'string') return node;
    const ref = recordOf(node)['Ref'];
    if (typeof ref !== 'string' || Object.keys(recordOf(node)).length !== 1) return undefined;
    if (Object.hasOwn(passedValues, ref)) return passedValues[ref];
    if (!Object.hasOwn(parameters, ref)) return undefined;
    const fallback = recordOf(parameters[ref])['Default'];
    return typeof fallback === 'string' ? fallback : undefined;
  };
  const evaluate = (node: unknown): boolean | undefined => {
    const record = recordOf(node);
    if (Object.keys(record).length !== 1) return undefined;
    const [key, argument] = Object.entries(record)[0]!;
    const list = Array.isArray(argument) ? (argument as unknown[]) : undefined;
    if (key === 'Condition')
      return typeof argument === 'string' ? conditionOf(argument) : undefined;
    if (key === 'Fn::Equals' && list?.length === 2) {
      const [left, right] = [valueOf(list[0]), valueOf(list[1])];
      return left === undefined || right === undefined ? undefined : left === right;
    }
    if (key === 'Fn::Not' && list?.length === 1) {
      const inner = evaluate(list[0]);
      return inner === undefined ? undefined : !inner;
    }
    if ((key === 'Fn::And' || key === 'Fn::Or') && list !== undefined && list.length > 0) {
      const each = list.map(evaluate);
      if (each.some((verdict) => verdict === undefined)) return undefined;
      return key === 'Fn::And' ? each.every(Boolean) : each.some(Boolean);
    }
    return undefined;
  };
  const conditionOf = (name: string): boolean | undefined => {
    if (Object.hasOwn(verdicts, name)) return verdicts[name];
    if (!Object.hasOwn(declared, name) || visiting.has(name)) return undefined;
    visiting.add(name);
    const verdict = evaluate(declared[name]);
    visiting.delete(name);
    if (verdict !== undefined) verdicts[name] = verdict;
    return verdict;
  };
  for (const name of Object.keys(declared)) conditionOf(name);
  return verdicts;
}

/** Does a template value compose a SECRET-spelled dynamic reference with other text? */
function composesSecretReference(value: unknown): boolean {
  if (!templateMixesDynamicReference(value)) return false;
  const text = JSON.stringify(value) ?? '';
  return SPELLED_SECRET_REFERENCE_PREFIXES.some((prefix) => text.includes(prefix));
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The row's RECORDED `Parameters` keys the deploy that wrote the record
 * treated as secret: a value it persisted as a `{{resolve:...}}` expression
 * beside other text (a secret reference it kept rather than resolved), or as
 * the mask. Decided from the record, never from the template: a PUBLIC
 * `{{resolve:ssm:...}}` reference is resolved and persisted as its value,
 * so its row is no secret's and keeps every output (review: masking it would
 * change what consumers import). A grandchild row reading an inherited mixed
 * parameter is recorded the same way, so a child deploy decides it too.
 */
function recordedSecretKeys(properties: Record<string, unknown> | undefined): Set<string> {
  const keys = new Set<string>();
  const parameters = properties?.['Parameters'];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return keys;
  }
  for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (mixesDynamicReference(value) || carriesSecretMask(value)) keys.add(key);
  }
  return keys;
}

/** The fallback: the record predates the redaction and nothing can tell which outputs it covers. */
function refusal(stackName: string, rowId: string, outputs: readonly string[]): Error {
  return markNonRetryable(
    new Error(
      `Refusing to deploy ${displayStackName(stackName)}: the record of nested stack ${displayIdent(rowId)} ` +
        `holds output(s) ${outputs.map((output) => displayIdent(output)).join(', ')} as recorded before cdkd masked a ` +
        `secret-derived nested output, and the row passes a parameter mixing a secret ` +
        `reference with other text, but the child template cannot be read to tell which ` +
        `outputs derive from it. Redeploy that nested stack (change a property of the row, or run ` +
        `${proseQuoted(cdkdRemedy('cdkd deploy', '--replace-resource', rowId))} where a replacement is acceptable) ` +
        `so its outputs are recorded again.`
    )
  );
}
