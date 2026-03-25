/**
 * Global configuration for cdkq
 */
export interface CdkqConfig {
  /** CDK app command (e.g., "npx ts-node app.ts") */
  app: string;

  /** S3 bucket for state storage */
  stateBucket: string;

  /** S3 key prefix for state files */
  statePrefix?: string;

  /** Stack name to deploy */
  stack?: string;

  /** AWS region */
  region?: string;

  /** AWS profile */
  profile?: string;

  /** Maximum concurrent resource operations */
  concurrency?: number;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Dry run mode (show changes without applying) */
  dryRun?: boolean;

  /** Output directory for CDK synthesis */
  output?: string;
}

/**
 * Deployment options
 */
export interface DeployOptions {
  /** Stack name */
  stackName: string;

  /** CloudFormation template */
  template: string;

  /** S3 state backend configuration */
  stateBackend: StateBackendConfig;

  /** Maximum concurrent operations */
  concurrency: number;

  /** Dry run mode */
  dryRun: boolean;

  /** Skip asset publishing */
  skipAssets?: boolean;
}

/**
 * State backend configuration
 */
export interface StateBackendConfig {
  /** S3 bucket name */
  bucket: string;

  /** S3 key prefix */
  prefix: string;
}

/**
 * Logger level
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
