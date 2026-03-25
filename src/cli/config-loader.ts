import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * cdkq-specific configuration extracted from cdk.json context or environment
 */
export interface CdkqConfig {
  stateBucket?: string;
}

/**
 * Load cdk.json from the current working directory
 */
export function loadCdkJson(cwd?: string): CdkConfig | null {
  const logger = getLogger();
  const dir = cwd || process.cwd();
  const cdkJsonPath = resolve(dir, 'cdk.json');

  if (!existsSync(cdkJsonPath)) {
    logger.debug('No cdk.json found in current directory');
    return null;
  }

  try {
    const content = readFileSync(cdkJsonPath, 'utf-8');
    const config = JSON.parse(content) as CdkConfig;
    logger.debug(`Loaded cdk.json from ${cdkJsonPath}`);
    return config;
  } catch (error) {
    logger.warn(`Failed to parse cdk.json: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolve the --app option from CLI, cdk.json, or environment
 *
 * Priority: CLI option > CDKQ_APP env > cdk.json app field
 */
export function resolveApp(cliApp?: string): string | undefined {
  if (cliApp) return cliApp;

  const envApp = process.env['CDKQ_APP'];
  if (envApp) return envApp;

  const cdkJson = loadCdkJson();
  return cdkJson?.app ?? undefined;
}

/**
 * Resolve the --state-bucket option from CLI, cdk.json context, or environment
 *
 * Priority: CLI option > CDKQ_STATE_BUCKET env > cdk.json context.cdkq.stateBucket
 */
export function resolveStateBucket(cliBucket?: string): string | undefined {
  if (cliBucket) return cliBucket;

  const envBucket = process.env['CDKQ_STATE_BUCKET'];
  if (envBucket) return envBucket;

  const cdkJson = loadCdkJson();
  const cdkqContext = cdkJson?.context?.['cdkq'] as Record<string, unknown> | undefined;
  const bucket = cdkqContext?.['stateBucket'];
  return typeof bucket === 'string' ? bucket : undefined;
}

/**
 * Generate default state bucket name from account info
 * Format: cdkq-state-{accountId}-{region}
 */
export function getDefaultStateBucketName(accountId: string, region: string): string {
  return `cdkq-state-${accountId}-${region}`;
}
