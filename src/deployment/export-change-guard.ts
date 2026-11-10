import { isDeepStrictEqual } from 'node:util';
import { referencedLogicalIds } from '../analyzer/skipped-outputs.js';
import { importableOutputKeys } from '../types/state.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
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
 * This is the ZERO-I/O half that keeps the everyday deploy fast: a stack
 * that exports nothing returns at once, and the O(stacks) consumer scan runs
 * only when this returns a non-empty list.
 *
 * The verdict leans toward "affected" wherever it cannot decide, since an
 * affected export only triggers the scan and refuses only when a consumer
 * really imports it:
 *
 * - An export the record publishes that no condition-true template output
 *   names any more is REMOVED. An `Export.Name` that does not resolve to a
 *   string proves no name, so it keeps none.
 * - An export whose output references a resource this plan creates, deletes
 *   or (possibly) replaces CHANGES: the new value is known only after deploy.
 *   The caller's `replaces` decides replacement; a `requiresReplacement`
 *   ceiling it over-calls is counted too.
 * - Otherwise the value is resolved against the plan's resolver context and
 *   compared with the published one. A value that does not resolve counts as
 *   changing only when it references a resource this plan touches. A
 *   published `***` (a `NoEcho` source) cannot be compared and is left alone.
 * - Nothing holding a `{{resolve:...}}` dynamic reference is resolved: this
 *   check must not issue a lookup, let alone read a secret. Such a name proves
 *   no name, and such a value is judged by the resources it references alone.
 */
export interface AffectedExport {
  exportName: string;
  reason: 'removed' | 'changed';
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
    if (
      await valueMayChange(output, currentState.outputs[exportName], changes, resolve, replaces)
    ) {
      affected.push({ exportName, reason: 'changed' });
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
): Promise<boolean> {
  let touchesChangedResource = false;
  for (const logicalId of referencedLogicalIds({ Value: output.Value })) {
    if (replaces(logicalId)) return true;
    const change = changes.get(logicalId);
    if (change === undefined || change.changeType === 'NO_CHANGE') continue;
    if (change.changeType !== 'UPDATE') return true;
    touchesChangedResource = true;
  }
  if (publishedValue === SECRET_MASK) return false;
  if (holdsDynamicReference(output.Value)) return touchesChangedResource;
  let desired: unknown;
  try {
    desired = await resolve(output.Value);
  } catch {
    return touchesChangedResource;
  }
  if (desired === undefined) return touchesChangedResource;
  return !isDeepStrictEqual(desired, publishedValue);
}

function holdsDynamicReference(value: unknown): boolean {
  return JSON.stringify(value)?.includes('{{resolve:') === true;
}

/** The `DeployEngineOptions.inRunStacks` key of a stack (name, region). */
export function inRunStackKey(stackName: string, region: string): string {
  return `${stackName}\u0000${canonicalizeRegion(region)}`;
}
