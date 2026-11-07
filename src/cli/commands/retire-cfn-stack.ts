// The bodies live in the sibling `retire-cfn-stack/` directory (go-to-k/cdkd#5835);
// this module re-exports every symbol it exported before, so importers are unchanged.
export {
  NESTED_STACK_RESOURCE_TYPE,
  type CfnStackResourceTree,
  type RetireCloudFormationStackOptions,
  type CloudFormationRetirementPreparation,
} from './retire-cfn-stack/types.js';
export { prepareCloudFormationStackRetirement, confirmPrompt } from './retire-cfn-stack/prepare.js';
export {
  SUPERSEDED_COPY_HINT,
  MANUAL_RETIREMENT_ROUTE,
  describeStackWaiterFailure,
  cfnFailureText,
  RetainUpdateFailedError,
} from './retire-cfn-stack/failure-text.js';
export { deleteRetiredCloudFormationStack } from './retire-cfn-stack/delete-stack.js';
export {
  uploadTemplateForUpdateStack,
  injectRetainPolicies,
  injectRetainPoliciesRecursive,
  RecursiveRetainInjectionError,
} from './retire-cfn-stack/retain-injection.js';
export {
  getCloudFormationResourceTree,
  type ReplacedCfnResource,
  findReplacedCfnResources,
  tryGetCloudFormationResourceMap,
  isStackNotFoundError,
} from './retire-cfn-stack/resource-tree.js';
