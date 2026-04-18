import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../utils/logger.js';

/**
 * CDK configuration loaded from cdk.json and environment variables
 */
export interface CdkConfig {
  app?: string;
  output?: string;
  context?: Record<string, unknown>;
}

/**
 * cdkd-specific configuration extracted from cdk.json context or environment
 */
export interface CdkdConfig {
  stateBucket?: string;
}

/**
 * Load a JSON config file and return as CdkConfig, or null if not found.
 */
function loadJsonConfig(filePath: string): CdkConfig | null {
  const logger = getLogger();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content) as CdkConfig;
    logger.debug(`Loaded config from ${filePath}`);
    return config;
  } catch (error) {
    logger.warn(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Load cdk.json from the current working directory
 */
export function loadCdkJson(cwd?: string): CdkConfig | null {
  const dir = cwd || process.cwd();
  return loadJsonConfig(resolve(dir, 'cdk.json'));
}

/**
 * Load user-level defaults from ~/.cdk.json
 *
 * CDK CLI reads this as user-level defaults (lowest priority).
 * Context values from ~/.cdk.json are merged below project cdk.json context.
 */
export function loadUserCdkJson(): CdkConfig | null {
  return loadJsonConfig(join(homedir(), '.cdk.json'));
}

/**
 * Resolve the --app option from CLI, cdk.json, or environment
 *
 * Priority: CLI option > CDKD_APP env > cdk.json app field
 */
export function resolveApp(cliApp?: string): string | undefined {
  if (cliApp) return cliApp;

  const envApp = process.env['CDKD_APP'];
  if (envApp) return envApp;

  const cdkJson = loadCdkJson();
  return cdkJson?.app ?? undefined;
}

/**
 * Resolve the --state-bucket option from CLI, cdk.json context, or environment
 *
 * Priority: CLI option > CDKD_STATE_BUCKET env > cdk.json context.cdkd.stateBucket
 */
export function resolveStateBucket(cliBucket?: string): string | undefined {
  if (cliBucket) return cliBucket;

  const envBucket = process.env['CDKD_STATE_BUCKET'];
  if (envBucket) return envBucket;

  const cdkJson = loadCdkJson();
  const cdkdContext = cdkJson?.context?.['cdkd'] as Record<string, unknown> | undefined;
  const bucket = cdkdContext?.['stateBucket'];
  return typeof bucket === 'string' ? bucket : undefined;
}

/**
 * Generate default state bucket name from account info
 * Format: cdkd-state-{accountId}-{region}
 */
export function getDefaultStateBucketName(accountId: string, region: string): string {
  return `cdkd-state-${accountId}-${region}`;
}

/**
 * Resolve state bucket with STS fallback
 *
 * Priority: CLI option > CDKD_STATE_BUCKET env > cdk.json > default (cdkd-state-{accountId}-{region})
 *
 * If no explicit bucket is configured, uses STS GetCallerIdentity to generate
 * a default bucket name. Requires AWS credentials to be configured.
 */
export async function resolveStateBucketWithDefault(
  cliBucket: string | undefined,
  region: string
): Promise<string> {
  // Try synchronous resolution first
  const syncResult = resolveStateBucket(cliBucket);
  if (syncResult) return syncResult;

  // Fall back to default bucket name from account info
  const logger = getLogger();
  logger.debug('No state bucket specified, resolving default from account...');

  const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const { getAwsClients } = await import('../utils/aws-clients.js');
  const awsClients = getAwsClients();
  const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;
  const bucketName = getDefaultStateBucketName(accountId, region);
  logger.info(`State bucket: ${bucketName}`);
  return bucketName;
}
