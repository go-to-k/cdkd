import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { PropertyChange, ResourceChange, ResourceState } from '../../../types/state.js';
import type { OutputChange } from '../../../analyzer/outputs-diff.js';
import type { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import type { SecurityDiff } from '../../../analyzer/security-diff.js';
import { isScrutinizedProperty } from '../../../analyzer/security-changes.js';
import {
  SECRET_MASK,
  isSingleDynamicReferenceToken,
  readsNoEchoSource,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { displayIdent, displaySafe } from '../../../utils/display-safe.js';
import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';

/**
 * go-to-k/cdkd#7068: what `cdkd diff` must not print about a nested-stack
 * parameter that MIXES a secret dynamic reference with other text
 * (`q7/{{resolve:ssm-secure:/a}}`).
 *
 * The diff leaves secret references unresolved, so it never holds their
 * plaintext, and the value scan skips a needle under its length floor. The
 * text beside the reference can still BE a secret's plaintext (another
 * reference resolving to `q7`), and the deploy's child, which holds the
 * plaintext, masks the whole leaf it persists. So this is decided by
 * PROVENANCE, never by value: every displayed leaf whose template reads such a
 * parameter, through any intrinsic, is shown as `***` on every side. Display
 * only: the comparison and its verdicts already ran on the real values, so a
 * row stays the change it is.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A one-key `Ref` / `Fn::*` object: an intrinsic, not a bag of keys. */
function isIntrinsic(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

const SIDES = ['oldValue', 'newValue', 'newValueTemplate'] as const;

/** `value` when it is a plain object, else an empty record. */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * A string holding a dynamic reference that is not one whole token. A bare
 * `{{resolve:ssm:` counts: the diff resolves a public `String` / `StringList`
 * parameter (`skipDynamicReferences` looks each one up), so one still spelled
 * in a resolved value is a `SecureString`, or one the lookup could not answer,
 * where the mask is the safe side.
 */
export function mixesDynamicReference(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.includes('{{resolve:') &&
    !isSingleDynamicReferenceToken(value)
  );
}

/** Does any string leaf or key under `value` mix a dynamic reference with other text? */
function holdsMixedDynamicReference(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (mixesDynamicReference(next)) return true;
    if (next === null || typeof next !== 'object' || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) pending.push(...(next as unknown[]));
    else for (const [key, leaf] of Object.entries(next)) pending.push(key, leaf);
  }
  return false;
}

/** Does any string under `value` hold a `{{resolve:` token? */
function holdsDynamicReference(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string' && next.includes('{{resolve:')) return true;
    if (next === null || typeof next !== 'object' || seen.has(next)) continue;
    seen.add(next);
    pending.push(...Object.values(next as Record<string, unknown>));
  }
  return false;
}

/**
 * Can a TEMPLATE value resolve to a dynamic reference composed with other
 * text? Decided WITHOUT modelling the intrinsics, so no composition shape is
 * missed: a literal string mixing one, and ANY intrinsic holding one anywhere
 * beneath it. The one exception is an `Fn::If`, which yields one branch as it
 * is, so it is judged branch by branch (a whole token in a branch passes the
 * reference through). Read before any resolution, so a bare
 * `{{resolve:ssm:` counts whatever its parameter's type: a `SecureString` (or
 * a lookup that fails) cannot be told from a public `String` here, and a
 * reader of the row's outputs masked over a public one is the safe side.
 */
function templateMixesDynamicReference(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return mixesDynamicReference(value);
  if (!isRecord(value) || depth > 64) return holdsDynamicReference(value);
  const branches = value['Fn::If'];
  if (isIntrinsic(value) && Array.isArray(branches) && branches.length === 3) {
    return (
      templateMixesDynamicReference(branches[1], depth + 1) ||
      templateMixesDynamicReference(branches[2], depth + 1)
    );
  }
  return holdsDynamicReference(value);
}

/** Each entry of a nested row's `Parameters` / `Tags` (a `{Key, Value}` list or a map). */
function rowEntries(rowProperties: Record<string, unknown>): Array<[unknown, unknown]> {
  const entries: Array<[unknown, unknown]> = Object.entries(recordOf(rowProperties['Parameters']));
  const tags = rowProperties['Tags'];
  if (Array.isArray(tags)) {
    for (const tag of tags as unknown[])
      entries.push([recordOf(tag)['Key'], recordOf(tag)['Value']]);
  } else {
    entries.push(...Object.entries(recordOf(tags)));
  }
  return entries;
}

/** Stands for every tag key: a tainted tag whose key the template does not spell. */
export const ANY_TAG_KEY = '*';
/** Every tag KEY is tainted too: a key built from the secret. */
export const TAG_KEYS_TAINTED = '*key*';

/** A literal cross-stack read: an export by name, or a stack's output. */
export type CrossStackSource =
  | { kind: 'export'; name: string }
  | { kind: 'output'; stackName: string; outputName: string; region?: string };

/**
 * Every `Fn::ImportValue` / `Fn::GetStackOutput` under `node`; `undefined`
 * for one whose name, stack or output is not a literal string, which this
 * cannot match to a producer (go-to-k/cdkd#7090).
 */
function crossStackSourcesOf(node: unknown): Array<CrossStackSource | undefined> {
  const sources: Array<CrossStackSource | undefined> = [];
  const pending: unknown[] = [node];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === null || typeof next !== 'object' || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    for (const [key, arg] of Object.entries(next)) {
      if (key === 'Fn::ImportValue') {
        sources.push(typeof arg === 'string' ? { kind: 'export', name: arg } : undefined);
      } else if (key === 'Fn::GetStackOutput') {
        const { StackName, OutputName, Region } = recordOf(arg);
        sources.push(
          typeof StackName === 'string' && typeof OutputName === 'string'
            ? {
                kind: 'output',
                stackName: StackName,
                outputName: OutputName,
                ...(typeof Region === 'string' && { region: Region }),
              }
            : undefined
        );
      }
      pending.push(arg);
    }
  }
  return sources;
}

/**
 * The tainted name standing for a cross-stack read. Never a logical id or a
 * parameter name (those are alphanumeric); the region is left out, so a read
 * of the same name in another region is masked too (the safe side).
 */
function crossStackTaintKey(source: CrossStackSource | undefined): string {
  if (source === undefined) return 'Fn::ImportValue|Fn::GetStackOutput *';
  return source.kind === 'export'
    ? `Fn::ImportValue ${JSON.stringify(source.name)}`
    : `Fn::GetStackOutput ${JSON.stringify([source.stackName, source.outputName])}`;
}

/**
 * go-to-k/cdkd#7090: the tainted names a node's own template seeds from the
 * cross-stack reads it makes: each read `isTainted` answers true for (a
 * producer's output or export deriving from a secret, by provenance). A read
 * whose target is not a literal is asked as `undefined`.
 */
export function crossStackTaintSeeds(
  template: CloudFormationTemplate,
  isTainted: (source: CrossStackSource | undefined) => boolean
): Set<string> {
  const seeds = new Set<string>();
  for (const source of crossStackSourcesOf(template)) {
    if (isTainted(source)) seeds.add(crossStackTaintKey(source));
  }
  return seeds;
}

/**
 * Does `node` read any of `tainted` (a parameter, a resource id, or a
 * cross-stack read {@link crossStackTaintSeeds} seeded), through any intrinsic?
 */
export function readsTainted(node: unknown, tainted: ReadonlySet<string>): boolean {
  if (tainted.size === 0) return false;
  return (
    readsNoEchoSource(node, {
      // A `Ref` / `${Name}` to a tainted parameter OR resource, and any
      // `Fn::GetAtt` of a tainted resource. No condition verdicts, so an
      // `Fn::If` counts both branches.
      parameters: tainted,
      attributeIsNoEcho: (logicalId) => tainted.has(logicalId),
    }) || crossStackSourcesOf(node).some((source) => tainted.has(crossStackTaintKey(source)))
  );
}

/**
 * The keys of a nested-stack row's `Parameters` whose value the child must
 * treat as a passed mixed secret: the value resolved for the child mixes a
 * dynamic reference with other text, or the row's template value reads a
 * tainted name of this node.
 */
export function mixedSecretRowKeys(
  rowProperties: Record<string, unknown> | undefined,
  resolvedChildParameters: Record<string, unknown>,
  tainted: ReadonlySet<string>
): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(recordOf(rowProperties?.['Parameters']))) {
    if (readsTainted(value, tainted)) keys.add(key);
  }
  for (const [key, value] of Object.entries(resolvedChildParameters)) {
    if (mixesDynamicReference(value)) keys.add(key);
  }
  return keys;
}

/**
 * Every name in `template` whose value derives from a passed mixed secret:
 * `passed` (the node's inherited mixed-secret parameters), each nested-stack
 * row whose `Parameters` / `Tags` compose a dynamic reference with other text
 * (its outputs and stack ARN are read back from a child holding the
 * plaintext), and each resource whose properties read one of those, to a
 * fixed point, so a `Ref` / `Fn::GetAtt` of such a resource taints its reader
 * too.
 */
export function taintedNamesOf(
  template: CloudFormationTemplate,
  passed: Iterable<string> | undefined
): Set<string> {
  const tainted = new Set<string>(passed ?? []);
  const resources = recordOf(template.Resources as unknown);
  for (const [logicalId, raw] of Object.entries(resources)) {
    const resource = recordOf(raw);
    if (resource['Type'] !== NESTED_STACK_RESOURCE_TYPE) continue;
    const properties = recordOf(resource['Properties']);
    if (rowEntries(properties).some(([, value]) => templateMixesDynamicReference(value))) {
      tainted.add(logicalId);
    }
  }
  if (tainted.size === 0) return tainted;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (tainted.has(logicalId)) continue;
      if (readsTainted(recordOf(resource)['Properties'], tainted)) {
        tainted.add(logicalId);
        grew = true;
      }
    }
  }
  return tainted;
}

/**
 * The stack-tag KEYS a nested row hands its child whose value derives from a
 * passed mixed secret: the child merges its stack tags into every taggable
 * resource below it, so each such key is masked in the whole subtree. A tag
 * the row's template composes with a reference, or that reads a tainted name,
 * one whose resolved value mixes one, and every key `inherited` names. A
 * tainted tag whose key is not a literal stands for every key
 * ({@link ANY_TAG_KEY}), and a KEY built from the secret taints every key too
 * ({@link TAG_KEYS_TAINTED}).
 */
export function mixedSecretTagKeys(
  rowProperties: Record<string, unknown> | undefined,
  resolvedTags: Readonly<Record<string, string>> | undefined,
  tainted: ReadonlySet<string>,
  inherited: ReadonlySet<string> | undefined
): Set<string> {
  const keys = new Set<string>(inherited ?? []);
  const tags = rowProperties?.['Tags'];
  const pairs: Array<[unknown, unknown]> = Array.isArray(tags)
    ? (tags as unknown[]).map((tag) => [recordOf(tag)['Key'], recordOf(tag)['Value']])
    : Object.entries(recordOf(tags));
  const derived = (node: unknown): boolean =>
    templateMixesDynamicReference(node) || readsTainted(node, tainted);
  for (const [key, value] of pairs) {
    // A KEY built from the secret: every key and value of the subtree's tags.
    if (typeof key === 'string' ? mixesDynamicReference(key) : derived(key)) {
      keys.add(ANY_TAG_KEY).add(TAG_KEYS_TAINTED);
    } else if (derived(value)) {
      keys.add(typeof key === 'string' ? key : ANY_TAG_KEY);
    }
  }
  for (const [key, value] of Object.entries(resolvedTags ?? {})) {
    if (mixesDynamicReference(key)) keys.add(ANY_TAG_KEY).add(TAG_KEYS_TAINTED);
    else if (mixesDynamicReference(value)) keys.add(key);
  }
  return keys;
}

/**
 * A tag-bearing side with the value of every tag `keys` names masked: a
 * `{Key, Value}` entry anywhere under it, or a key of a tag MAP (the side
 * itself, or a `Tags` member under it).
 */
function maskTagValues(value: unknown, keys: ReadonlySet<string>, isMap: boolean): unknown {
  const named = (key: unknown): boolean =>
    keys.has(ANY_TAG_KEY) || (typeof key === 'string' && keys.has(key));
  if (Array.isArray(value)) {
    const shown = value.map((element: unknown) => maskTagValues(element, keys, false));
    return shown.every((element, index) => element === value[index]) ? value : shown;
  }
  if (!isRecord(value)) return value;
  const isEntry = Object.hasOwn(value, 'Key') && Object.hasOwn(value, 'Value');
  // A tag MAP whose keys may spell the secret: withheld whole.
  if (!isEntry && isMap && keys.has(TAG_KEYS_TAINTED)) return SECRET_MASK;
  let changed = false;
  const shown: Record<string, unknown> = {};
  for (const [key, leaf] of Object.entries(value)) {
    let next: unknown;
    if (isEntry && key === 'Key' && keys.has(TAG_KEYS_TAINTED)) next = SECRET_MASK;
    else if (isEntry && key === 'Value' && named(value['Key'])) next = SECRET_MASK;
    else if (isMap && named(key) && !isRecord(leaf) && !Array.isArray(leaf)) next = SECRET_MASK;
    else next = maskTagValues(leaf, keys, /tag/i.test(key));
    if (next !== leaf) changed = true;
    shown[key] = next;
  }
  return changed ? shown : value;
}

/** A property change with its tags `keys` names masked on every side. */
function maskTagProperty(change: PropertyChange, keys: ReadonlySet<string>): PropertyChange {
  if (keys.size === 0 || !/tag/i.test(change.path)) return change;
  const next: PropertyChange = { ...change };
  let changed = false;
  for (const side of SIDES) {
    if (!Object.prototype.hasOwnProperty.call(change, side) || change[side] === undefined) continue;
    // Any tag property's own record is a tag MAP (`Tags`, `UserPoolTags`).
    const shown = maskTagValues(change[side], keys, true);
    if (shown !== change[side]) {
      next[side] = shown;
      changed = true;
    }
  }
  return changed ? next : change;
}

/**
 * `shown` labelled `maskedExpressionChanged` when the mask made its two sides
 * read alike while the real ones differ: `*** -> ***` reads as no change, so
 * the renderer's `[masked input or expression changed]` note says it is one.
 * Display only: the copy is never read by a decision.
 */
function labelledWhenMaskedAlike(real: PropertyChange, shown: PropertyChange): PropertyChange {
  const alike = (change: PropertyChange): boolean =>
    JSON.stringify(change.oldValue) === JSON.stringify(change.newValue);
  return alike(shown) && !alike(real) ? { ...shown, maskedExpressionChanged: true } : shown;
}

/** `change` with every side it carries shown as the mask. */
function maskedSides(change: PropertyChange): PropertyChange {
  const masked: PropertyChange = { ...change };
  if (masked.oldValue !== undefined) masked.oldValue = SECRET_MASK;
  if (masked.newValue !== undefined) masked.newValue = SECRET_MASK;
  if (masked.newValueTemplate !== undefined) masked.newValueTemplate = SECRET_MASK;
  return masked;
}

/** A `Parameters` side with the flagged keys masked. */
function maskParameterKeys(
  side: Record<string, unknown>,
  flagged: ReadonlySet<string>
): Record<string, unknown> {
  let changed = false;
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(side)) {
    if (value !== SECRET_MASK && flagged.has(key)) {
      shown[key] = SECRET_MASK;
      changed = true;
    } else {
      shown[key] = value;
    }
  }
  return changed ? shown : side;
}

/**
 * A nested-stack row's `Parameters` change with its mixed-secret keys masked
 * on EVERY side: a key is flagged when any side holds a mixed value there (a
 * legacy record's old side may hold the plaintext with no reference left)
 * or its template value reads a tainted name.
 */
function maskRowParameters(
  change: PropertyChange,
  templateValue: unknown,
  tainted: ReadonlySet<string>
): PropertyChange {
  const present = SIDES.filter(
    (side) => Object.prototype.hasOwnProperty.call(change, side) && change[side] !== undefined
  );
  // A `Parameters` that is itself an intrinsic over a tainted name, or a side
  // that is no plain object and holds a mixed value: every side whole.
  if (
    ((!isRecord(templateValue) || isIntrinsic(templateValue)) &&
      readsTainted(templateValue, tainted)) ||
    present.some((side) => !isRecord(change[side]) && holdsMixedDynamicReference(change[side]))
  ) {
    return maskedSides(change);
  }
  const raw = recordOf(templateValue);
  const flagged = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (readsTainted(value, tainted)) flagged.add(key);
  }
  for (const side of present) {
    for (const [key, value] of Object.entries(recordOf(change[side]))) {
      if (holdsMixedDynamicReference(value)) flagged.add(key);
    }
  }
  if (flagged.size === 0) return change;
  const next: PropertyChange = { ...change };
  let changed = false;
  for (const side of present) {
    const value = change[side];
    if (!isRecord(value)) continue;
    const shown = maskParameterKeys(value, flagged);
    if (shown !== value) {
      next[side] = shown;
      changed = true;
    }
  }
  return changed ? next : change;
}

/**
 * One node's resource changes as `cdkd diff` prints them under go-to-k/cdkd#7068:
 * a property whose template reads a tainted name is shown as `***` on every
 * side, and a nested-stack row's `Parameters` key holding (or reading) a mixed
 * secret is shown as `***`, also at the root and without `--recursive`, as is
 * the value of every inherited tainted stack tag. Returns `changes` itself when
 * nothing is masked; never mutates it.
 */
export function maskPassedSecretChanges(
  changes: Map<string, ResourceChange>,
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>,
  /** Stack-tag keys inherited from a row passing a mixed secret ({@link mixedSecretTagKeys}). */
  tagKeys: ReadonlySet<string> = new Set()
): Map<string, ResourceChange> {
  const resources = recordOf(template.Resources as unknown);
  let anyChanged = false;
  const shown = new Map<string, ResourceChange>();
  for (const [logicalId, change] of changes) {
    const resource = recordOf(
      Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined
    );
    const properties = recordOf(resource['Properties']);
    const isNestedRow =
      change.resourceType === NESTED_STACK_RESOURCE_TYPE ||
      resource['Type'] === NESTED_STACK_RESOURCE_TYPE;
    let changed = false;
    const propertyChanges = change.propertyChanges?.map((propertyChange): PropertyChange => {
      const templateValue = Object.hasOwn(properties, propertyChange.path)
        ? properties[propertyChange.path]
        : undefined;
      const next =
        isNestedRow && propertyChange.path === 'Parameters'
          ? maskRowParameters(propertyChange, templateValue, tainted)
          : readsTainted(templateValue, tainted) ||
              // Any other property of a nested row (its `Tags`, the stack
              // tags it hands down): any side holding a mixed value, whole.
              (isNestedRow &&
                SIDES.some((side) => holdsMixedDynamicReference(propertyChange[side])))
            ? maskedSides(propertyChange)
            : maskTagProperty(propertyChange, tagKeys);
      if (next === propertyChange) return next;
      changed = true;
      return labelledWhenMaskedAlike(propertyChange, next);
    });
    if (changed && propertyChanges !== undefined) {
      anyChanged = true;
      shown.set(logicalId, { ...change, propertyChanges });
    } else {
      shown.set(logicalId, change);
    }
  }
  return anyChanged ? shown : changes;
}

/**
 * One node's Outputs changes under go-to-k/cdkd#7068: an output whose `Value`
 * reads a tainted name is shown as `***`, and so is every export alias row
 * when any such output exports (an alias row cannot name its output); an
 * `Export.Name` reading one withholds every export alias name.
 */
export function maskPassedSecretOutputs(
  outputChanges: OutputChange[],
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>
): OutputChange[] {
  if (tainted.size === 0 || outputChanges.length === 0) return outputChanges;
  const outputs = recordOf(template.Outputs as unknown);
  const taintedValues = new Set<string>();
  let taintedExportValue = false;
  let taintedExportName = false;
  for (const [name, rawOutput] of Object.entries(outputs)) {
    const output = recordOf(rawOutput);
    const exported = isRecord(output['Export']) ? output['Export'] : undefined;
    if (readsTainted(output['Value'], tainted)) {
      taintedValues.add(name);
      if (exported !== undefined) taintedExportValue = true;
    }
    if (exported !== undefined && readsTainted(exported['Name'], tainted)) taintedExportName = true;
  }
  let anyChanged = false;
  const shown = outputChanges.map((change): OutputChange => {
    const maskValues =
      (Object.hasOwn(outputs, change.name) && taintedValues.has(change.name)) ||
      (change.isExport && taintedExportValue);
    const withholdName = change.isExport && taintedExportName;
    if (!maskValues && !withholdName) return change;
    const next: OutputChange = { ...change };
    if (maskValues) {
      if (next.oldValue !== undefined) next.oldValue = SECRET_MASK;
      if (next.newValue !== undefined) next.newValue = SECRET_MASK;
    }
    if (withholdName) next.nameDisplay = { kind: 'withheld' };
    anyChanged = true;
    return next;
  });
  return anyChanged ? shown : outputChanges;
}

/**
 * `calculator` with its `--verbose` replacement line masked on both sides for
 * a property whose template reads a tainted name. The line's own masker is a
 * value scan, which cannot see a sub-floor fragment (an `Fn::Select` over an
 * `Fn::Split` of the mixed value); this decides by provenance, keyed by the
 * resource type and property the line names. Every other line, and every
 * method, is the calculator's own: it writes no instance state.
 */
export function calculatorMaskingPassedSecretLines(
  calculator: DiffCalculator,
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>
): DiffCalculator {
  if (tainted.size === 0) return calculator;
  const prefixes: string[] = [];
  for (const rawResource of Object.values(recordOf(template.Resources as unknown))) {
    const resource = recordOf(rawResource);
    if (typeof resource['Type'] !== 'string') continue;
    for (const [key, value] of Object.entries(recordOf(resource['Properties']))) {
      if (readsTainted(value, tainted)) {
        prefixes.push(`Property ${key} of ${resource['Type']} requires replacement (from `);
      }
    }
  }
  if (prefixes.length === 0) return calculator;
  const inner = calculator.logger;
  const logger = Object.create(inner) as typeof inner;
  logger.debug = (message: string, ...args: unknown[]): void => {
    const prefix = prefixes.find((candidate) => message.startsWith(candidate));
    inner.debug(
      prefix === undefined ? message : `${prefix}${SECRET_MASK} to ${SECRET_MASK})`,
      ...args
    );
  };
  const wrapped = Object.create(calculator) as DiffCalculator;
  Object.defineProperty(wrapped, 'logger', { value: logger, enumerable: true });
  return wrapped;
}

/**
 * The physical ids and string attribute values the records of `tainted`
 * resources store, as one bag of log-only needles: a `Ref` / `Fn::GetAtt` of
 * such a record prints them on the resolver's own lines. The masker still
 * skips one under its length floor.
 */
export function recordedValuesOf(
  resources: Readonly<Record<string, ResourceState>>,
  tainted: ReadonlySet<string>
): RecordedSecretValues {
  const needles: RecordedSecretValues = new Map();
  for (const name of tainted) {
    const record = Object.hasOwn(resources, name) ? resources[name] : undefined;
    if (record === undefined) continue;
    const pending: unknown[] = [record.physicalId, record.attributes];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const next = pending.pop();
      if (typeof next === 'string') {
        if (next.length > 0 && next !== SECRET_MASK) recordLogOnlyValue(needles, next);
      } else if (next !== null && typeof next === 'object' && !seen.has(next)) {
        seen.add(next);
        pending.push(...Object.values(next));
      }
    }
  }
  return needles;
}

/**
 * `securityDiff` with its rendered IAM / security-group table WITHHELD when a
 * changed resource of this node reads a tainted name: the table prints
 * resolved statement values, and its own mask is a value scan. Its verdict
 * (`broadening`) and whether it found anything (a non-empty `rendered`) are
 * kept, so `--fail-on` and the counts decide as before.
 */
export function securityDiffWithPassedSecretWithheld(
  securityDiff: () => Promise<SecurityDiff>,
  changes: ReadonlyMap<string, ResourceChange>,
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>
): () => Promise<SecurityDiff> {
  // A changed IAM / security-group property (what the table formats) whose
  // template reads a tainted name: a seeded nested row, or a reader of one
  // the table never shows, withholds nothing.
  const resources = recordOf(template.Resources as unknown);
  const touched = [...changes.values()].some((change) => {
    if (change.changeType === 'NO_CHANGE' || !tainted.has(change.logicalId)) return false;
    const properties = recordOf(
      recordOf(
        Object.hasOwn(resources, change.logicalId) ? resources[change.logicalId] : undefined
      )['Properties']
    );
    return (change.propertyChanges ?? []).some(
      (propertyChange) =>
        isScrutinizedProperty(change.resourceType, propertyChange.path) &&
        Object.hasOwn(properties, propertyChange.path) &&
        readsTainted(properties[propertyChange.path], tainted)
    );
  });
  if (!touched) return securityDiff;
  return async () => {
    const shown = await securityDiff();
    if (shown.rendered === '') return shown;
    return { ...shown, rendered: SECURITY_TABLE_WITHHELD };
  };
}

export const SECURITY_TABLE_WITHHELD =
  'IAM / security-group changes found; their table is withheld because this stack ' +
  'reads a parameter passed with a secret dynamic reference (go-to-k/cdkd#7068).';

/**
 * A node's `blocking` reasons under go-to-k/cdkd#7068. Two of them print a
 * VALUE, not just an id or a key: the ServiceToken refusal names the desired
 * token, and an orphan-adoption refusal names the orphan's recorded physical
 * id. Each is masked when its resource is tainted and, for the token, when
 * the template's `ServiceToken` reads a tainted name; every other reason names
 * ids, types, keys and counts only and is kept as it is. Display only: the
 * count of reasons (exit 3) is unchanged.
 */
export function maskPassedSecretReasons(
  reasons: string[],
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>,
  orphans: unknown
): string[] {
  if (tainted.size === 0 || reasons.length === 0) return reasons;
  const resources = recordOf(template.Resources as unknown);
  const tokenPrefixes: string[] = [];
  for (const logicalId of tainted) {
    if (!Object.hasOwn(resources, logicalId)) continue;
    const properties = recordOf(recordOf(resources[logicalId])['Properties']);
    if (readsTainted(properties['ServiceToken'], tainted)) {
      tokenPrefixes.push(`${displayIdent(logicalId)}: ServiceToken changes to `);
    }
  }
  const shownIds: string[] = [];
  for (const orphan of Array.isArray(orphans) ? (orphans as unknown[]) : []) {
    const entry = recordOf(orphan);
    const record = recordOf(entry['state']);
    if (typeof entry['logicalId'] !== 'string' || !tainted.has(entry['logicalId'])) continue;
    if (typeof record['physicalId'] !== 'string' || record['physicalId'] === '') continue;
    shownIds.push(
      displaySafe(String(displayPhysicalId(record['resourceType'], record['physicalId'])))
    );
  }
  let changed = false;
  const shown = reasons.map((reason) => {
    let next = reason;
    const prefix = tokenPrefixes.find((candidate) => next.startsWith(candidate));
    const end = next.indexOf(SERVICE_TOKEN_REASON_TAIL);
    if (prefix !== undefined && end > prefix.length) {
      next = `${prefix}${SECRET_MASK}${next.slice(end)}`;
    }
    for (const id of shownIds) next = next.split(id).join(SECRET_MASK);
    if (next !== reason) changed = true;
    return next;
  });
  return changed ? shown : reasons;
}

/** Where the ServiceToken refusal's desired token ends (`custom-resource-service-token.ts`). */
const SERVICE_TOKEN_REASON_TAIL = ', away from the handler its record names.';
