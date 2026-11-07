/**
 * cdkd's error hierarchy and top-level error handling. The bodies live in the
 * sibling `error-handler/` directory (go-to-k/cdkd#5835); this module
 * re-exports every symbol it exported before, so importers are unchanged.
 */
export {
  CdkdError,
  AccountIdUnavailableError,
  StateError,
  LockError,
  SynthesisError,
  DeployCancelledError,
  DeploymentNotApprovedError,
  isSoftAbort,
  AssetError,
  LocalInvokeBuildError,
  ProvisioningError,
  ResourceTimeoutError,
} from './error-handler/base-errors.js';
export {
  IntrinsicResolutionRefusalError,
  CrossAccountSecretRefusalError,
  MalformedProducerRecordRefusalError,
  DynamicReferenceRegionAmbiguousError,
} from './error-handler/refusal-errors.js';
export {
  DependencyError,
  ConfigError,
  PartialFailureError,
  ResourceUpdateNotSupportedError,
  StackTerminationProtectionError,
  NestedStackChildDirectDestroyError,
  StackHasActiveImportsError,
} from './error-handler/deploy-errors.js';
export type { ActiveImportConsumer } from './error-handler/deploy-errors.js';
export {
  RouteDiscoveryError,
  StartApiServerError,
  LocalRunTaskError,
  LocalStartServiceError,
  MacroExpansionError,
} from './error-handler/command-errors.js';
export {
  isCdkdError,
  formatError,
  handleError,
  withErrorHandling,
} from './error-handler/format.js';
export { normalizeAwsError } from './error-handler/normalize-aws.js';
export type { NormalizeAwsErrorContext } from './error-handler/normalize-aws.js';
