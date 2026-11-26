import {
  healSlashedSsmParameterNames,
  slashedSsmNameHealNote,
  slashedSsmNameHealPendingNote,
  slashedSsmNameHealAdoptedNote,
} from '../../../deployment/ssm-slashed-name-heal.js';
import {
  healZonelessDbInstanceRecords,
  type LiveDbInstanceZoneReader,
} from '../../../deployment/zoneless-db-instance-heal.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import { logger } from './logger.js';

/**
 * go-to-k/cdkd#6274: the deploy re-spells a pre-#6272 generated SSM
 * parameter name `/<name>` as `<name>` before its diff; so does the preview,
 * so each dependent holding the old Ref shows the update the deploy makes.
 * A nested child whose row the deploy leaves alone runs no engine, so it is
 * only named, not healed (moved from `compute-stack-diff.ts`).
 */
export function previewSsmNameHeal(
  state: StackState,
  template: CloudFormationTemplate,
  stackName: string,
  mode: 'apply' | 'pending'
): StackState {
  const healed = healSlashedSsmParameterNames(state, template, stackName);
  if (healed.heals.length === 0) return state;
  for (const heal of healed.heals) {
    if (mode === 'apply') logger.info(slashedSsmNameHealNote(heal));
    else logger.info(slashedSsmNameHealPendingNote(heal, stackName));
  }
  return mode === 'apply' ? { ...state, resources: healed.resources } : state;
}

/**
 * An adopted record never saw the heal above; the deploy heals it after its
 * adoption. Only named here: this preview's resolver reads the records as
 * loaded, before the splice, so no dependent row could show the change.
 */
export function noteAdoptedSsmNameHeals(
  state: StackState,
  adoptedRecords: Record<string, ResourceState> | undefined,
  template: CloudFormationTemplate,
  stackName: string
): void {
  if (Object.keys(adoptedRecords ?? {}).length === 0) return;
  const adopted = { ...state, resources: adoptedRecords ?? {} };
  for (const heal of healSlashedSsmParameterNames(adopted, template, stackName).heals) {
    logger.info(slashedSsmNameHealAdoptedNote(heal));
  }
}

/**
 * go-to-k/cdkd#7057: the deploy's zone heal (`healZonelessDbInstanceRecords`),
 * on a copy of the records this node diffs, before the diff it changes: the
 * loaded state stays as read, and nothing is saved (the deploy persists its
 * own).
 */
export async function previewZonelessDbInstanceHeal(
  state: StackState,
  template: CloudFormationTemplate,
  resolve: (value: unknown) => Promise<unknown>,
  readLiveZone: LiveDbInstanceZoneReader | undefined
): Promise<StackState> {
  const resources = { ...state.resources };
  const healed = await healZonelessDbInstanceRecords({
    resources,
    template,
    resolve,
    readLiveZone,
    log: (line) => logger.debug(line),
  });
  return healed.length === 0 ? state : { ...state, resources };
}
