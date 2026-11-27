import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceChange, StackState } from '../../../types/state.js';
import {
  planReplaceResourceTargets,
  refuseStatefulReplaceResourceTargets,
  renderUnreplacedTarget,
} from '../../../deployment/replace-resource-targets.js';
import { refuseStatefulReplacedReaders } from '../../../deployment/recreate-target-readers.js';
import { CdkdError } from '../../../utils/error-handler.js';

/**
 * go-to-k/cdkd#7089: `cdkd diff --replace-resource`, the preview of the plan
 * `cdkd deploy --replace-resource` makes (`refuseUnsafePlan`, `plan-checks.ts`).
 * The same `planReplaceResourceTargets` turns each target's UPDATE row into
 * the replacement the deploy plans (its readers were promoted by the diff,
 * which took the targets as forced replacements), and prints the same warning
 * for a target it does not replace.
 *
 * Returns the deploy's plan refusals of a target as `blocking` reasons (exit
 * 3: the deploy refuses to start), as the diff previews the deploy's other
 * plan refusals. The stateful refusals are lifted by
 * `--force-stateful-recreation`, which `cdkd diff` does not take, so they are
 * WARNINGS: a stack always deployed with that flag would otherwise exit 3 on
 * every diff (the reason `findUnwrittenCreateOnlyRefusals` warns).
 *
 * Mutates `changes` in place, as the deploy's plan does.
 */
export async function previewReplaceResourceTargets(input: {
  changes: Map<string, ResourceChange>;
  targetIds: ReadonlySet<string> | undefined;
  stackName: string;
  state: StackState;
  template: CloudFormationTemplate;
  /** The condition verdicts this diff knows; an unknown one reads both `Fn::If` arms. */
  conditions: Readonly<Record<string, boolean>>;
  warn: (message: string) => void;
}): Promise<string[]> {
  if (input.targetIds === undefined || input.targetIds.size === 0) return [];
  let replaced: string[];
  try {
    const plan = planReplaceResourceTargets(input.changes, input.targetIds);
    replaced = plan.replaced;
    for (const target of plan.unreplaced) input.warn(renderUnreplacedTarget(input.stackName, target));
  } catch (error) {
    if (error instanceof CdkdError && error.code === 'REPLACE_RESOURCE_REFUSED') {
      return [error.message];
    }
    throw error;
  }
  const stateful = async (check: () => void | Promise<void>): Promise<void> => {
    try {
      await check();
    } catch (error) {
      if (!(error instanceof CdkdError && error.code === 'STATEFUL_REPLACE_BLOCKED')) throw error;
      input.warn(
        `cdkd deploy refuses this plan unless --force-stateful-recreation is passed:\n${error.message}`
      );
    }
  };
  await stateful(() =>
    refuseStatefulReplaceResourceTargets({
      targetIds: replaced,
      state: input.state,
      template: input.template,
      forceStatefulRecreation: false,
    })
  );
  await stateful(() =>
    refuseStatefulReplacedReaders({
      template: input.template,
      state: input.state,
      targetIds: replaced,
      conditions: input.conditions,
      forceStatefulRecreation: false,
      targetFlag: '--replace-resource',
    })
  );
  return [];
}
