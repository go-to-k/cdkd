import { Option } from 'commander';

/**
 * Parse context key=value pairs from CLI arguments into a Record
 */
export function parseContextOptions(contextArgs?: string[]): Record<string, string> {
  const context: Record<string, string> = {};
  if (contextArgs) {
    for (const arg of contextArgs) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex > 0) {
        context[arg.substring(0, eqIndex)] = arg.substring(eqIndex + 1);
      }
    }
  }
  return context;
}

/**
 * Common CLI options
 */
export const commonOptions = [
  new Option('--verbose', 'Enable verbose logging').default(false),
  new Option('--region <region>', 'AWS region'),
  new Option('--profile <profile>', 'AWS profile'),
];

/**
 * App options
 *
 * --app is optional: falls back to CDKD_APP env var, then cdk.json "app" field
 */
export const appOptions = [
  new Option(
    '--app <command>',
    'CDK app command (e.g., "npx ts-node app.ts"). Falls back to cdk.json or CDKD_APP env'
  ),
  new Option('--output <path>', 'Output directory for synthesis').default('cdk.out'),
];

/**
 * State backend options
 *
 * --state-bucket is optional: falls back to CDKD_STATE_BUCKET env var,
 * then cdk.json context.cdkd.stateBucket
 */
export const stateOptions = [
  new Option(
    '--state-bucket <bucket>',
    'S3 bucket for state storage. Falls back to CDKD_STATE_BUCKET env or cdk.json'
  ),
  new Option('--state-prefix <prefix>', 'S3 key prefix for state files').default('cdkd'),
];

/**
 * Stack options
 */
export const stackOptions = [new Option('--stack <name>', 'Stack name to operate on')];

/**
 * Deploy options
 */
export const deployOptions = [
  new Option('--concurrency <number>', 'Maximum concurrent resource operations')
    .default(10)
    .argParser((value) => parseInt(value, 10)),
  new Option('--stack-concurrency <number>', 'Maximum concurrent stack deployments')
    .default(4)
    .argParser((value) => parseInt(value, 10)),
  new Option(
    '--asset-publish-concurrency <number>',
    'Maximum concurrent asset publish operations (S3 uploads + ECR push)'
  )
    .default(8)
    .argParser((value) => parseInt(value, 10)),
  new Option('--image-build-concurrency <number>', 'Maximum concurrent Docker image builds')
    .default(4)
    .argParser((value) => parseInt(value, 10)),
  new Option('--dry-run', 'Show changes without applying').default(false),
  new Option('--skip-assets', 'Skip asset publishing').default(false),
  new Option('--no-rollback', 'Skip rollback on deployment failure'),
  new Option('--no-wait', 'Skip waiting for async resources (CloudFront, RDS, etc.)'),
  new Option(
    '-e, --exclusively',
    'Only deploy requested stacks, do not include dependencies'
  ).default(false),
];

/**
 * Context options
 *
 * -c / --context can be specified multiple times to pass context key=value pairs
 */
export const contextOptions = [
  new Option(
    '-c, --context <key=value...>',
    'Set context values (can be specified multiple times)'
  ),
];

/**
 * Destroy options
 */
export const destroyOptions = [new Option('--force', 'Skip confirmation prompt').default(false)];
