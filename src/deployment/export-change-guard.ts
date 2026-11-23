import { isDeepStrictEqual } from 'node:util';
import { extractGetAttRefs } from '../analyzer/diff-calculator/in-place-promotion.js';
import {
  IN_PLACE_UPDATE_DERIVED_ATTRS,
  IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES,
  REF_READ,
} from '../analyzer/diff-calculator/shared.js';
import { importableOutputKeys } from '../types/state.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { producerRecordKey } from '../state/record-keys.js';
import { SECRET_MASK } from './secret-redaction/pairs.js';
import type { ResourceChange, StackState } from '../types/state.js';
import type { CloudFormationTemplate, TemplateOutput } from '../types/resource.js';

/**
 * go-to-k/cdkd#6088: which of a stack's published exports a deploy's plan
 * would CHANGE or REMOVE. CloudFormation refuses such an update while another
 * stack imports the export (`Export ... cannot be updated as it is in use`);
 * cdkd refuses it from the consumers its state records (see
 * `refuseInUseExportChanges` in `deploy-engine/deploy-flow/plan-checks.ts`).
 *
 * This half reads no state bucket, so the everyday deploy never pays the
 * O(stacks) consumer scan: a stack that exports nothing returns at once, and
 * the scan runs only when this returns a non-empty list. A stack that does
 * export resolves each exported value against the plan's resolver context,
 * the same reads its outputs pass makes anyway.
 *
 * The verdict leans toward "affected" wherever it cannot decide, since an
 * affected export only triggers the scan and refuses only when a consumer
 * really imports it:
 *
 * - An export the record publishes that no condition-true template output
 *   names any more is REMOVED. An `Export.Name` that does not resolve to a
 *   string proves no name, so it keeps none.
 * - An export whose output references a resource this plan creates, deletes
 *   or replaces CHANGES: the new value is known only after deploy. The
 *   caller's `replaces` decides replacement.
 * - So does one reading an attribute an IN-PLACE update may move, by the
 *   diff calculator's own promotion rule (`in-place-promotion.ts`, arms 1-3):
 *   an attribute named after a changed property, or a derived attribute of
 *   the type (a launch template's version, a nested stack's `Outputs.*`). The
 *   diff context still holds the OLD value there, so resolving it would
 *   compare equal.
 * - One reading a CUSTOM RESOURCE this plan updates in place is DEFERRED
 *   (go-to-k/cdkd#6865): only the handler knows what it returns, and
 *   CloudFormation runs the update and refuses only when the export's value
 *   then differs (measured: it updates the custom resource, fails the stack,
 *   and its rollback re-invokes the handler with the old properties). The
 *   deploy re-checks it once the custom resources are updated
 *   (`refuseDeferredExportChanges`). It is `changed` up front instead when
 *   the value cannot be compared later (a published value holding `***`, a
 *   dynamic reference) or already differs at plan time.
 * - Otherwise the value is resolved and compared with the published one. A
 *   value that does not resolve counts as changing only when it references a
 *   resource this plan touches. A published `***` (a `NoEcho` source) cannot
 *   be compared and is left alone.
 * - Nothing holding a `{{resolve:...}}` dynamic reference is resolved: this
 *   check must not issue a lookup, let alone read a secret. Such a name proves
 *   no name, and such a value is judged by the resources it references alone.
 *
 * Not seen: a replacement decided only while provisioning (an update AWS
 * refuses, replaced instead), and a change to a dynamic reference's own text.
 */
export interface AffectedExport {
  exportName: string;
  reason: 'removed' | 'changed' | 'deferred';
  /** `deferred` only: the output's `Value`, resolved again after provisioning. */
  value?: unknown;
}

export async function findAffectedExports({
  template,
  conditions,
  changes,
  currentState,
  resolve,
  replaces,
}: {
  template: CloudFormationTemplate;
  conditions: Record<string, boolean>;
  changes: ReadonlyMap<string, ResourceChange>;
  currentState: Pick<StackState, 'outputs' | 'exportNames'>;
  resolve: (value: unknown) => Promise<unknown>;
  /** Whether the plan replaces `logicalId` (a `NO_CHANGE` row included). */
  replaces: (logicalId: string) => boolean;
}): Promise<AffectedExport[]> {
  const published = importableOutputKeys(currentState);
  if (published.length === 0) return [];
  const publishedSet = new Set(published);

  // The export names today's template still declares, with their output.
  // A record written before `exportNames` (schema v9) counts every outputs
  // key as importable, a plain output's own name included: such a key is
  // still published while today's template declares that output.
  const declared = new Map<string, TemplateOutput>();
  const legacy = currentState.exportNames === undefined;
  for (const [outputKey, output] of Object.entries(template.Outputs ?? {})) {
    if (output === null || typeof output !== 'object') continue;
    if (typeof output.Condition === 'string' && conditions[output.Condition] === false) continue;
    if (legacy && publishedSet.has(outputKey)) declared.set(outputKey, output);
    const exportName = (output.Export as { Name?: unknown } | undefined)?.Name;
    if (exportName === undefined) continue;
    let name: unknown = exportName;
    if (typeof name !== 'string') {
      if (holdsDynamicReference(exportName)) continue;
      try {
        name = await resolve(exportName);
      } catch {
        continue;
      }
    }
    if (typeof name === 'string' && publishedSet.has(name)) declared.set(name, output);
  }

  const affected: AffectedExport[] = [];
  for (const exportName of published) {
    const output = declared.get(exportName);
    if (output === undefined) {
      affected.push({ exportName, reason: 'removed' });
      continue;
    }
    const verdict = await valueMayChange(
      output,
      currentState.outputs[exportName],
      changes,
      resolve,
      replaces
    );
    if (verdict === 'changed') affected.push({ exportName, reason: 'changed' });
    else if (verdict === 'deferred') {
      affected.push({ exportName, reason: 'deferred', value: output.Value });
    }
  }
  return affected;
}

async function valueMayChange(
  output: TemplateOutput,
  publishedValue: unknown,
  changes: ReadonlyMap<string, ResourceChange>,
  resolve: (value: unknown) => Promise<unknown>,
  replaces: (logicalId: string) => boolean
): Promise<'changed' | 'deferred' | 'unchanged'> {
  let touchesChangedResource = false;
  let readsUpdatedCustomResource = false;
  for (const [logicalId, reads] of extractGetAttRefs(output.Value)) {
    if (replaces(logicalId)) return 'changed';
    const change = changes.get(logicalId);
    if (change === undefined || change.changeType === 'NO_CHANGE') continue;
    if (change.changeType !== 'UPDATE') return 'changed';
    touchesChangedResource = true;
    if (isCustomResourceType(change.resourceType)) readsUpdatedCustomResource = true;
    else if (inPlaceUpdateMayMove(change, reads)) return 'changed';
  }
  // A custom resource's new value is known only after its update; a value
  // that cannot be compared then is judged now, as every in-place custom
  // resource read was before go-to-k/cdkd#6865.
  if (publishedValue === SECRET_MASK) return readsUpdatedCustomResource ? 'changed' : 'unchanged';
  // A value published with a mask inside it (a nested child's inherited
  // secret) compares the redacted plan-time value; the post-update compare
  // would see the real one and refuse a value that did not move.
  if (
    readsUpdatedCustomResource &&
    JSON.stringify(publishedValue)?.includes(SECRET_MASK) === true
  ) {
    return 'changed';
  }
  if (holdsDynamicReference(output.Value)) return touchesChangedResource ? 'changed' : 'unchanged';
  let desired: unknown;
  try {
    desired = await resolve(output.Value);
  } catch {
    return touchesChangedResource ? 'changed' : 'unchanged';
  }
  if (desired === undefined) return touchesChangedResource ? 'changed' : 'unchanged';
  if (!isDeepStrictEqual(desired, publishedValue)) return 'changed';
  return readsUpdatedCustomResource ? 'deferred' : 'unchanged';
}

function isCustomResourceType(type: string): boolean {
  return type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource';
}

/**
 * go-to-k/cdkd#6865: the `deferred` exports whose value moved, judged once
 * the custom resources they read are updated. `resolve` resolves against the
 * deploy's records as they stand after the create / update phase. A value
 * that does not resolve, or resolves to nothing, counts as changed: the
 * outputs pass will fail on it too, and a consumer must not be left behind.
 */
export async function findChangedDeferredExports(
  deferred: readonly AffectedExport[],
  currentState: Pick<StackState, 'outputs'>,
  resolve: (value: unknown) => Promise<unknown>
): Promise<AffectedExport[]> {
  const changed: AffectedExport[] = [];
  for (const entry of deferred) {
    if (entry.reason !== 'deferred') continue;
    let value: unknown;
    try {
      value = await resolve(entry.value);
    } catch {
      value = undefined;
    }
    if (value === undefined || !isDeepStrictEqual(value, currentState.outputs[entry.exportName])) {
      changed.push({ exportName: entry.exportName, reason: 'changed' });
    }
  }
  return changed;
}

/**
 * Whether an in-place `change` of a resource that is not a custom resource
 * may move one of `reads` (attribute names, or `REF_READ`):
 * `promoteInPlaceAttributeDependents`'s arms 1-3. Arm 4, any read of a custom
 * resource, is deferred by the caller (go-to-k/cdkd#6865).
 */
function inPlaceUpdateMayMove(change: ResourceChange, reads: ReadonlySet<string>): boolean {
  const type = change.resourceType;
  const changed = new Set((change.propertyChanges ?? []).map((pc) => pc.path));
  const derived = Object.hasOwn(IN_PLACE_UPDATE_DERIVED_ATTRS, type)
    ? IN_PLACE_UPDATE_DERIVED_ATTRS[type]
    : undefined;
  const prefixes = Object.hasOwn(IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES, type)
    ? IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES[type]
    : undefined;
  for (const attr of reads) {
    if (attr === REF_READ) continue;
    if (changed.has(attr) || derived?.has(attr) === true) return true;
    if (prefixes?.some((prefix) => attr.startsWith(prefix)) === true) return true;
  }
  return false;
}

function holdsDynamicReference(value: unknown): boolean {
  return JSON.stringify(value)?.includes('{{resolve:') === true;
}

/**
 * The `DeployEngineOptions.inRunStacks` key of a stack (name, region): the
 * record key, over the region canonicalized as the consumer scan compares it.
 */
export function inRunStackKey(stackName: string, region: string): string {
  return producerRecordKey(stackName, canonicalizeRegion(region));
}
