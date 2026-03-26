/**
 * cdkd - CDK Direct
 *
 * Library exports for programmatic usage
 */

// Types
export type {
  StackState,
  ResourceState,
  LockInfo,
  ChangeType,
  ResourceChange,
  PropertyChange,
} from './types/state.js';
export type {
  CloudFormationTemplate,
  TemplateResource,
  TemplateParameter,
  TemplateOutput,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from './types/resource.js';
export type {
  CdkdConfig,
  DeployOptions,
  StateBackendConfig,
  Logger,
  LogLevel,
} from './types/config.js';

// Utilities
export { ConsoleLogger, getLogger, setLogger } from './utils/logger.js';
export {
  CdkdError,
  StateError,
  LockError,
  SynthesisError,
  AssetError,
  ProvisioningError,
  DependencyError,
  ConfigError,
  isCdkdError,
  formatError,
} from './utils/error-handler.js';
export { AwsClients, getAwsClients, setAwsClients, resetAwsClients } from './utils/aws-clients.js';

// Synthesis
export { Synthesizer, type SynthesisOptions } from './synthesis/synthesizer.js';
export { AssemblyLoader, type StackInfo } from './synthesis/assembly-loader.js';

// Assets
export { AssetPublisher, type AssetPublisherOptions } from './assets/asset-publisher.js';

// State Management
export { S3StateBackend } from './state/s3-state-backend.js';
export { LockManager } from './state/lock-manager.js';

// Analyzer
export { TemplateParser } from './analyzer/template-parser.js';
export { DagBuilder } from './analyzer/dag-builder.js';
export { DiffCalculator } from './analyzer/diff-calculator.js';

// Provisioning
export { CloudControlProvider } from './provisioning/cloud-control-provider.js';
export { ProviderRegistry } from './provisioning/provider-registry.js';
export { IAMRoleProvider } from './provisioning/providers/iam-role-provider.js';

// Deployment
export {
  DeployEngine,
  type DeployEngineOptions,
  type DeployResult,
} from './deployment/deploy-engine.js';

// SDK providers for CC API unsupported/problematic resources are in src/provisioning/providers/
