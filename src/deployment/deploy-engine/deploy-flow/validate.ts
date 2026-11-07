import { safeMsg } from '../../../utils/display-safe.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';

/**
 * Steps 3 to 4 of a deploy: type and property validation, then the dependency
 * graph (moved from `deploy-flow.ts`).
 */
export function validateAndBuildGraph(
  engine: DeployEngine,
  {
    currentState,
    effectiveTemplate,
  }: {
    currentState: StackState;
    effectiveTemplate: CloudFormationTemplate;
  }
): {
  dag: ReturnType<DeployEngine['dagBuilder']['buildGraph']>;
  executionLevels: string[][];
} {
  // 3. Validate resource types (before deployment starts)
  // Skip metadata resources as they don't actually deploy
  const resourceTypes = new Set(
    Object.values(effectiveTemplate.Resources || {})
      .map((r) => r.Type)
      .filter((type) => type !== 'AWS::CDK::Metadata')
  );
  engine.providerRegistry.validateResourceTypes(resourceTypes);
  engine.logger.debug(`All resource types validated`);

  // 3.5. Report top-level resource property routing decisions
  // (#614). For each resource using an SDK-unwired top-level property,
  // info-log that cdkd is auto-routing it via Cloud Control (which
  // forwards the full property map). For each resource explicitly
  // opted out via `--allow-unsupported-properties Type:Prop`, warn
  // that the property is left unwritten. Neither of those throws —
  // the legacy PR #608 fail-fast was reversed by #614 to a default-on
  // auto-route — but this step CAN still refuse, and the comment said
  // it could not until issue #3028. An SDK-unwired key on a type the Cloud Control
  // route cannot serve (`hasNoCloudControlHandlers`, or a provider declaring
  // `disableCcApiFallback`) has nowhere to be auto-routed, so
  // `ProviderRegistry.reportSdkUnwiredDecisions` throws rather than
  // letting the route fail later with an opaque error. That refusal
  // lands HERE — ahead of the DAG at step 4 and the diff at step 5 —
  // so the deploy ends having provisioned nothing. Skips
  // AWS::CDK::Metadata (filtered by the same predicate as the type
  // set).
  const resourcesForPropertyCheck = Object.entries(effectiveTemplate.Resources || {})
    .filter(([, r]) => r.Type !== 'AWS::CDK::Metadata')
    .map(([logicalId, r]) => ({
      logicalId,
      resourceType: r.Type,
      properties: r.Properties,
      // Thread the state-recorded routing layer so already-sticky CC
      // resources demote the info-log to debug (avoids "routing via
      // Cloud Control API" repeated on every redeploy).
      provisionedBy: currentState.resources[logicalId]?.provisionedBy,
      // The baseline an unrecognized property is compared against, so the
      // routing lines describe the route `getProviderFor` takes (#3713).
      previousProperties: currentState.resources[logicalId]?.properties,
    }));
  engine.providerRegistry.validateResourceProperties(resourcesForPropertyCheck);
  engine.logger.debug(`All resource properties validated`);

  // 4. Build dependency graph
  const dag = engine.dagBuilder.buildGraph(effectiveTemplate);
  const executionLevels = engine.dagBuilder.getExecutionLevels(dag);
  engine.logger.debug(safeMsg`Dependency graph: ${executionLevels.length} execution levels`);
  return { dag, executionLevels };
}
