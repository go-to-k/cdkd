import type { ResourceTimeoutOption } from '../../options.js';
import type { RequireApprovalLevel } from '../../../deployment/deploy-engine/options.js';

/**
 * The options Commander hands the `cdkd deploy` handler.
 */
export interface DeployCommandOptions {
  app?: string;
  output: string;
  stateBucket?: string;
  statePrefix: string;
  stack?: string;
  all?: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  concurrency: number;
  stackConcurrency: number;
  assetPublishConcurrency: number;
  imageBuildConcurrency: number;
  dryRun: boolean;
  skipAssets: boolean;
  rollback: boolean;
  wait: boolean;
  fullWait?: boolean;
  captureObservedState: boolean;
  /** `--update-policy` / `--no-update-policy`; undefined when neither was passed (#6437). */
  updatePolicy?: boolean;
  prefixUserSuppliedNames: boolean;
  aggressiveVpcParallel: boolean;
  exclusively: boolean;
  yes: boolean;
  verbose: boolean;
  context?: string[];
  /** `--tags KEY=VALUE` (go-to-k/cdkd#6886). */
  tags?: string[];
  lookups?: boolean;
  allowUnsupportedTypes?: string[];
  preferSdkRoute?: string[];
  /** Deprecated alias for `preferSdkRoute` (issue go-to-k/cdkd#3000). */
  allowUnsupportedProperties?: string[];
  recreateViaCcApi?: string[];
  recreateViaSdkProvider?: string[];
  pinCcApi?: string[];
  forceStatefulRecreation?: boolean;
  skipFinalSnapshot?: boolean;
  replace?: boolean;
  /** `--replace-resource <logicalId>` (go-to-k/cdkd#7079). */
  replaceResource?: string[];
  strict?: boolean;
  ignoreErrors?: boolean;
  strictGetatt?: boolean;
  allowUnaddressed?: boolean;
  cfnFallback?: boolean;
  useCdkBootstrapAssets?: boolean;
  autoAssetStorage?: boolean;
  resourceWarnAfter?: ResourceTimeoutOption;
  resourceTimeout?: ResourceTimeoutOption;
  requireApproval?: RequireApprovalLevel;
  outputsFile?: string;
}
