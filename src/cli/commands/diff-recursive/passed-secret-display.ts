import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { PropertyChange, ResourceChange, ResourceState } from '../../../types/state.js';
import type { OutputChange } from '../../../analyzer/outputs-diff.js';
import type { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import type { SecurityDiff } from '../../../analyzer/security-diff.js';
import {
  SECRET_MASK,
  isSingleDynamicReferenceToken,
  readsNoEchoSource,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';

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

/** `value` when it is a plain object, else an empty record. */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A string holding a dynamic reference that is not one whole token. */
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

/** Does `node` read any of `tainted` (a parameter or a resource id), through any intrinsic? */
function readsTainted(node: unknown, tainted: ReadonlySet<string>): boolean {
  if (tainted.size === 0) return false;
  return readsNoEchoSource(node, {
    // A `Ref` / `${Name}` to a tainted parameter OR resource, and any
    // `Fn::GetAtt` of a tainted resource. No condition verdicts, so an
    // `Fn::If` counts both branches.
    parameters: tainted,
    attributeIsNoEcho: (logicalId) => tainted.has(logicalId),
  });
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
 * Every name in `template` whose value derives from `passed` (the node's
 * inherited mixed-secret parameters): those parameters plus each resource
 * whose properties read one, to a fixed point, so a `Ref` / `Fn::GetAtt` of
 * such a resource (a name built from the secret) taints its reader too.
 */
export function taintedNamesOf(
  template: CloudFormationTemplate,
  passed: ReadonlySet<string> | undefined
): Set<string> {
  const tainted = new Set<string>(passed ?? []);
  if (tainted.size === 0) return tainted;
  const resources = recordOf(template.Resources as unknown);
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

/** `change` with every side it carries shown as the mask. */
function maskedSides(change: PropertyChange): PropertyChange {
  const masked: PropertyChange = { ...change };
  if (masked.oldValue !== undefined) masked.oldValue = SECRET_MASK;
  if (masked.newValue !== undefined) masked.newValue = SECRET_MASK;
  if (masked.newValueTemplate !== undefined) masked.newValueTemplate = SECRET_MASK;
  return masked;
}

/** A `Parameters` side with the flagged keys masked; the whole side when it is no plain object. */
function maskParameterKeys(side: unknown, flagged: (key: string) => boolean): unknown {
  if (side === undefined || side === SECRET_MASK) return side;
  if (!isRecord(side)) return holdsMixedDynamicReference(side) ? SECRET_MASK : side;
  let changed = false;
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(side)) {
    if (value !== SECRET_MASK && (flagged(key) || holdsMixedDynamicReference(value))) {
      shown[key] = SECRET_MASK;
      changed = true;
    } else {
      shown[key] = value;
    }
  }
  return changed ? shown : side;
}

/** A nested-stack row's `Parameters` change with its mixed-secret keys masked. */
function maskRowParameters(
  change: PropertyChange,
  templateValue: unknown,
  rowKeys: ReadonlySet<string> | undefined,
  tainted: ReadonlySet<string>
): PropertyChange {
  // A `Parameters` that is itself an intrinsic over a tainted name: whole.
  if (templateValue !== undefined && !isRecord(templateValue)) {
    if (readsTainted(templateValue, tainted)) return maskedSides(change);
  }
  const raw = recordOf(templateValue);
  const flagged = (key: string): boolean =>
    rowKeys?.has(key) === true || (Object.hasOwn(raw, key) && readsTainted(raw[key], tainted));
  const next: PropertyChange = { ...change };
  let changed = false;
  for (const side of ['oldValue', 'newValue', 'newValueTemplate'] as const) {
    if (!Object.prototype.hasOwnProperty.call(change, side)) continue;
    const value = maskParameterKeys(change[side], flagged);
    if (value !== change[side]) {
      next[side] = value;
      changed = true;
    }
  }
  return changed ? next : change;
}

/**
 * One node's resource changes as `cdkd diff` prints them under go-to-k/cdkd#7068:
 * a property whose template reads a tainted name is shown as `***` on every
 * side, and a nested-stack row's `Parameters` key holding (or reading) a mixed
 * secret is shown as `***`. Returns `changes` itself when nothing is masked;
 * never mutates it.
 */
export function maskPassedSecretChanges(
  changes: Map<string, ResourceChange>,
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>,
  rowKeys: ReadonlyMap<string, ReadonlySet<string>>
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
          ? maskRowParameters(propertyChange, templateValue, rowKeys.get(logicalId), tainted)
          : readsTainted(templateValue, tainted)
            ? maskedSides(propertyChange)
            : propertyChange;
      if (next !== propertyChange) changed = true;
      return next;
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
  tainted: ReadonlySet<string>
): () => Promise<SecurityDiff> {
  const touched = [...changes.values()].some(
    (change) => change.changeType !== 'NO_CHANGE' && tainted.has(change.logicalId)
  );
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
