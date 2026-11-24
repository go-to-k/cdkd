/**
 * go-to-k/cdkd#6887 — the stack tags each CloudFormation stack `cdkd export`
 * creates gets: the root takes the manifest's stack tags (`StackProps.tags`,
 * what `cdk deploy` passes), and each nested child the tags CloudFormation
 * gives a nested stack, its parent's with the row's own literal `Tags`
 * winning (`childStackTags`, the same rule `cdkd deploy` applies, #6871).
 */

import { childStackTags, literalRowTags } from '../../../provisioning/stack-tags.js';
import { hasOwnKey } from '../../../utils/own-keys.js';
import { quotedOrNotShown, rowIdent } from './render.js';

interface StackTagPlan {
  readonly cdkdName: string;
  readonly template: Record<string, unknown>;
  readonly nestedStackRows: ReadonlyArray<{ logicalId: string; childStackName: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `Tags` property of `logicalId`'s row in `template`, if any. */
function rowTagsProperty(template: Record<string, unknown>, logicalId: string): unknown {
  const resources = template['Resources'];
  if (!isRecord(resources) || !hasOwnKey(resources, logicalId)) return undefined;
  const row = resources[logicalId];
  const properties = isRecord(row) ? row['Properties'] : undefined;
  return isRecord(properties) ? properties['Tags'] : undefined;
}

/**
 * Per cdkd stack name, the stack tags its CloudFormation stack gets. A row
 * whose `Tags` are not literal (an intrinsic, or a dynamic reference) is warned and its child takes
 * the parent's tags alone: cdkd never guesses a resolved value.
 */
export function exportedStackTagsByStack(
  plans: readonly StackTagPlan[],
  rootStackName: string,
  rootStackTags: Readonly<Record<string, string>> | undefined,
  warn: (line: string) => void
): Map<string, Record<string, string>> {
  const planByName = new Map(plans.map((plan) => [plan.cdkdName, plan]));
  const tagsByName = new Map<string, Record<string, string>>();
  const visit = (cdkdName: string, tags: Record<string, string>): void => {
    tagsByName.set(cdkdName, tags);
    const plan = planByName.get(cdkdName);
    if (plan === undefined) return;
    for (const row of plan.nestedStackRows) {
      let rowTags = literalRowTags(rowTagsProperty(plan.template, row.logicalId));
      // A dynamic reference is resolved in a template, never in the stack-tag
      // API: sent there, the expression itself would replace the resolved
      // value on every resource.
      if (rowTags !== undefined && Object.values(rowTags).some((v) => v.includes('{{resolve:'))) {
        rowTags = undefined;
      }
      if (rowTags === undefined) {
        warn(
          `The Tags of nested stack row ${rowIdent(row.logicalId)} in ${quotedOrNotShown(cdkdName)} ` +
            `are not literal, so its exported CloudFormation stack gets only its parent's stack tags; ` +
            `the next 'cdk deploy' of the root stack applies the rest.`
        );
        rowTags = {};
      }
      visit(row.childStackName, childStackTags(tags, rowTags));
    }
  };
  visit(rootStackName, childStackTags(rootStackTags, {}));
  return tagsByName;
}

/**
 * CloudFormation's stack-tag limit: `ValidationError: Tags must have length
 * less than or equal to 50` on `UpdateStack` and `CreateStack` alike (measured
 * us-east-1, 2026-11-24, go-to-k/cdkd#6902).
 */
export const CFN_MAX_STACK_TAGS = 50;

/**
 * go-to-k/cdkd#6902: refuse, before the first changeset, a tree in which a
 * non-root stack's flip could not be sent. The flip adds
 * `cdkd:nested-export-flip` to the stack's own tags, so a stack already
 * holding {@link CFN_MAX_STACK_TAGS} would be refused there, half-way through
 * the export. The root takes no flip tag.
 */
export function refuseFlipTagBudget(
  tagsByName: ReadonlyMap<string, Readonly<Record<string, string>>>,
  rootStackName: string
): void {
  const over: string[] = [];
  for (const [cdkdName, tags] of tagsByName) {
    if (cdkdName === rootStackName) continue;
    const count = Object.keys(tags).length;
    if (count + 1 > CFN_MAX_STACK_TAGS) {
      over.push(`${quotedOrNotShown(cdkdName)} (${count} stack tags)`);
    }
  }
  if (over.length === 0) return;
  throw new Error(
    `Refusing to export: CloudFormation allows ${CFN_MAX_STACK_TAGS} stack tags, and each ` +
      `nested stack is moved out of IMPORT_COMPLETE by an update that adds one more ` +
      `('cdkd:nested-export-flip'). These nested stacks have no room for it: ${over.join(', ')}. ` +
      `Their tags are the parent's stack tags plus the nested stack resource's own Tags; remove ` +
      `enough to leave each at ${CFN_MAX_STACK_TAGS - 1} or fewer, deploy, and run the export ` +
      `again. Nothing was changed.`
  );
}
