import { safeMsg } from '../../../utils/display-safe.js';
import { refuseNoValueOutputs } from '../../output-value-preflight.js';
import {
  buildConditionVerdictRecord,
  conditionInputsFrom,
  conditionsReadByDiff,
  deployConditionInputs,
  parentSuppliedValues,
} from '../../condition-verdicts.js';
import { buildResolverContext } from '../resolver-context.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';

/**
 * Step 2.6 of a deploy: the condition values, and the verdicts the final save
 * records for `cdkd diff` (moved from `deploy-flow.ts`).
 */
export async function evaluateDeployConditions(
  engine: DeployEngine,
  {
    stackName,
    template,
    currentState,
    parameterValues,
  }: {
    stackName: string;
    template: CloudFormationTemplate;
    currentState: StackState;
    parameterValues: Record<string, unknown>;
  }
): Promise<{
  conditions: Record<string, boolean>;
  conditionVerdicts: ReturnType<typeof buildConditionVerdictRecord>;
}> {
  // 2.6. Evaluate conditions from template
  const context = buildResolverContext(
    engine.resolverContextDeps(),
    {
      template,
      resources: currentState.resources,
      parameters: parameterValues,
    },
    stackName
  );
  const conditions = await engine.resolver.evaluateConditions(context);
  engine.logger.debug(
    safeMsg`Evaluated ${Object.keys(conditions).length} conditions: ${Object.keys(conditions).join(', ')}`
  );
  // CloudFormation rejects an Output whose Value evaluates to
  // AWS::NoValue before it creates anything (issue #4077), so refuse it
  // here, before provisioning, rather than publishing nothing after it.
  refuseNoValueOutputs(template.Outputs, conditions);
  // go-to-k/cdkd#4479: the verdicts `cdkd diff` cannot compute (a condition
  // over a parameter a nested child received from a secret), each with the
  // fingerprint the diff must recompute to reuse it. Persisted by the final
  // save and the no-change save below; the other saves of a deploy rebuild
  // state without it, so a failed or interrupted deploy leaves NO record and
  // the next diff falls back to the FALSE branch, never a stale verdict.
  // Skipped when the template has no condition the diff reads: the token
  // derivation redacts every parameter value, which a child with no such
  // condition does not need.
  let conditionVerdicts: ReturnType<typeof buildConditionVerdictRecord>;
  if (conditionsReadByDiff(template, conditions).size > 0) {
    // A parameter the resolver would serve from a STATE resource of the same
    // logical id (`Ref` checks resources first) is no input.
    const { tokens, unavailable } = deployConditionInputs(
      parameterValues,
      engine.options.inheritedSecrets,
      new Set(Object.keys(currentState.resources))
    );
    // A plain value the parent supplied is no input either: the inherited
    // corpus can miss a short ancestor secret embedded in it.
    for (const name of parentSuppliedValues(
      template,
      engine.options.parameters,
      new Set(Object.keys(tokens))
    )) {
      unavailable.add(name);
    }
    conditionVerdicts = buildConditionVerdictRecord(
      template,
      conditions,
      conditionInputsFrom({ tokens, bound: parameterValues, unavailable })
    );
  }
  return { conditions, conditionVerdicts };
}
