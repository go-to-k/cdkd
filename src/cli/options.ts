import { Option } from 'commander';

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
 * --app is optional: falls back to CDKQ_APP env var, then cdk.json "app" field
 */
export const appOptions = [
  new Option(
    '--app <command>',
    'CDK app command (e.g., "npx ts-node app.ts"). Falls back to cdk.json or CDKQ_APP env'
  ),
  new Option('--output <path>', 'Output directory for synthesis').default('cdk.out'),
];

/**
 * State backend options
 *
 * --state-bucket is optional: falls back to CDKQ_STATE_BUCKET env var,
 * then cdk.json context.cdkq.stateBucket
 */
export const stateOptions = [
  new Option(
    '--state-bucket <bucket>',
    'S3 bucket for state storage. Falls back to CDKQ_STATE_BUCKET env or cdk.json'
  ),
  new Option('--state-prefix <prefix>', 'S3 key prefix for state files').default('cdkq'),
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
  new Option('--dry-run', 'Show changes without applying').default(false),
  new Option('--skip-assets', 'Skip asset publishing').default(false),
];

/**
 * Destroy options
 */
export const destroyOptions = [new Option('--force', 'Skip confirmation prompt').default(false)];
