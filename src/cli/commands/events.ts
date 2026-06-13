import { Command } from 'commander';
import {
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { bold, cyan, gray, green, red, yellow } from '../../utils/colors.js';
import { CdkdError, withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import { DeploymentEventsReader } from '../../state/deployment-events-store.js';
import type { DeploymentEvent, DeploymentRunSummary } from '../../types/deployment-events.js';

/**
 * Options accepted by `cdkd events`. `stateBucket` / `statePrefix` /
 * `region` / `profile` / `verbose` come from the shared option blocks
 * (`commonOptions` + `stateOptions` + the deprecated region option).
 */
interface EventsCommandOptions {
  stateBucket?: string;
  statePrefix?: string;
  region?: string;
  profile?: string;
  verbose?: boolean;
  json?: boolean;
  /** Read a single run's full event stream instead of the run listing. */
  run?: string;
  /** Disambiguate a stack with deployment-event history in >1 region. */
  stackRegion?: string;
}

/**
 * `cdkd events <stack>` — read back the structured deployment events
 * (issue #808) cdkd persists per deploy / destroy run, the local
 * equivalent of CloudFormation's `DescribeStackEvents`.
 *
 * Two modes:
 *   - No `--run`: list the recorded runs for the stack, newest first
 *     (runId, command, cdkd version, result, started/finished, event count).
 *   - `--run <id>`: print the full ordered event stream for that one run.
 *
 * `--format json` (alias `--json`) emits machine-readable JSON for tooling
 * / AI-agent hand-off. Events survive `cdkd destroy` (they live under a
 * separate `deployments/` key family from `state.json`), so a destroyed
 * stack's failure history stays readable.
 */
export async function eventsCommand(
  stackName: string,
  options: EventsCommandOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }
  warnIfDeprecatedRegion(options);

  const asJson = options.json === true;

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
    const bucket = await resolveStateBucketWithDefault(options.stateBucket, region);
    const prefix = options.statePrefix ?? 'cdkd';
    const stateBackend = new S3StateBackend(
      awsClients.s3,
      { bucket, prefix },
      {
        region,
        ...(options.profile && { profile: options.profile }),
      }
    );
    await stateBackend.verifyBucketExists();

    const reader = new DeploymentEventsReader(stateBackend);

    // Resolve the region holding this stack's deployment-event history.
    // Region discovery is derived from the raw key listing (not state.json)
    // so a destroyed stack's events are still discoverable.
    const targetRegion = await resolveEventsRegion(reader, stackName, options.stackRegion);

    if (options.run) {
      const events = await reader.readRunEvents(stackName, targetRegion, options.run);
      if (events === null) {
        throw new CdkdError(
          `No deployment-event stream found for run '${options.run}' of stack '${stackName}' in region '${targetRegion}'.`,
          'EVENTS_RUN_NOT_FOUND'
        );
      }
      if (asJson) {
        process.stdout.write(JSON.stringify(events, null, 2) + '\n');
        return;
      }
      printRunEvents(stackName, targetRegion, options.run, events);
      return;
    }

    const runs = await reader.listRuns(stackName, targetRegion);
    if (asJson) {
      process.stdout.write(
        JSON.stringify({ stackName, region: targetRegion, runs }, null, 2) + '\n'
      );
      return;
    }
    printRunList(stackName, targetRegion, runs);
  } finally {
    awsClients.destroy();
  }
}

/**
 * Pick the region whose `deployments/` key family holds this stack's run
 * history. When `--stack-region` is supplied it is honored verbatim;
 * otherwise the single discovered region is used, and an ambiguous (>1)
 * or missing (0) history surfaces an actionable error.
 */
async function resolveEventsRegion(
  reader: DeploymentEventsReader,
  stackName: string,
  explicitRegion?: string
): Promise<string> {
  if (explicitRegion) return explicitRegion;
  const regions = await reader.listRegions(stackName);
  if (regions.length === 0) {
    throw new CdkdError(
      `No deployment-event history found for stack '${stackName}'. ` +
        `Events are recorded by 'cdkd deploy' / 'cdkd destroy' (issue #808); ` +
        `a stack deployed by an older cdkd version has none.`,
      'EVENTS_NOT_FOUND'
    );
  }
  if (regions.length > 1) {
    throw new CdkdError(
      `Stack '${stackName}' has deployment-event history in multiple regions: ${regions.join(', ')}. ` +
        `Re-run with '--stack-region <region>' to disambiguate.`,
      'EVENTS_REGION_AMBIGUOUS'
    );
  }
  return regions[0]!;
}

/** Human-readable run listing (newest first). */
function printRunList(stackName: string, region: string, runs: DeploymentRunSummary[]): void {
  const logger = getLogger();
  logger.info(`${bold('Deployment runs for')} ${cyan(stackName)} ${gray(`(${region})`)}`);
  if (runs.length === 0) {
    logger.info(gray('  (no runs recorded)'));
    return;
  }
  for (const run of runs) {
    const resultColored = run.result === 'SUCCEEDED' ? green(run.result) : red(run.result);
    logger.info(
      `  ${cyan(run.runId)}  ${run.command}  ${resultColored}  ` +
        `${gray(run.startedAt || '?')} -> ${gray(run.finishedAt || '?')}  ` +
        `${gray(`cdkd ${run.cdkdVersion}`)}  ${gray(`${run.eventCount} events`)}`
    );
  }
  logger.info(gray(`\nUse 'cdkd events ${stackName} --run <runId>' to read one run's events.`));
}

/** Human-readable single-run event stream (in recorded order). */
function printRunEvents(
  stackName: string,
  region: string,
  runId: string,
  events: DeploymentEvent[]
): void {
  const logger = getLogger();
  logger.info(`${bold('Events for run')} ${cyan(runId)} ${gray(`(${stackName}, ${region})`)}`);
  if (events.length === 0) {
    logger.info(gray('  (no events)'));
    return;
  }
  for (const e of events) {
    const parts: string[] = [gray(e.timestamp), colorizeEventType(e.eventType)];
    if (e.logicalId) {
      parts.push(`${e.logicalId}${e.resourceType ? ` (${e.resourceType})` : ''}`);
    }
    if (e.operation) parts.push(gray(e.operation));
    if (e.provisionedBy) parts.push(gray(`[${e.provisionedBy}]`));
    if (e.command) parts.push(gray(e.command));
    if (e.region) parts.push(gray(e.region));
    if (e.cdkdVersion) parts.push(gray(`cdkd ${e.cdkdVersion}`));
    if (e.result) {
      parts.push(e.result === 'SUCCEEDED' ? green(e.result) : red(e.result));
    }
    if (typeof e.durationMs === 'number') parts.push(gray(`${e.durationMs}ms`));
    if (e.counts) {
      parts.push(
        gray(
          `+${e.counts.created}/~${e.counts.updated}/-${e.counts.deleted}` +
            (e.counts.failed ? ` !${e.counts.failed}` : '')
        )
      );
    }
    logger.info(`  ${parts.join('  ')}`);
    if (e.error) {
      const code = e.error.awsErrorCode ? ` (${e.error.awsErrorCode})` : '';
      const reqId = e.error.requestId ? gray(` requestId=${e.error.requestId}`) : '';
      logger.info(`      ${red(`${e.error.name}${code}: ${e.error.message}`)}${reqId}`);
    }
  }
}

/** Color the event-type token by its lifecycle phase. */
function colorizeEventType(eventType: DeploymentEvent['eventType']): string {
  if (eventType.endsWith('FAILED')) return red(eventType);
  if (eventType.endsWith('SUCCEEDED') || eventType === 'RUN_FINISHED') return green(eventType);
  if (eventType.startsWith('ROLLBACK')) return yellow(eventType);
  return cyan(eventType);
}

/**
 * Create the `cdkd events` command.
 */
export function createEventsCommand(): Command {
  const cmd = new Command('events')
    .description(
      "Read back structured deployment events (cdkd's DescribeStackEvents equivalent, issue #808)"
    )
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .option('--run <runId>', "Read a single run's full event stream instead of the run listing")
    .option(
      '--stack-region <region>',
      'Disambiguate a stack with event history in multiple regions'
    )
    .option('--json', 'Output as JSON', false)
    .option('--format <format>', "Output format ('json' is equivalent to --json)")
    .action(
      withErrorHandling((stack: string, options: EventsCommandOptions & { format?: string }) => {
        // `--format json` is the issue's spelling; map it onto the boolean.
        const merged: EventsCommandOptions = {
          ...options,
          json: options.json === true || options.format === 'json',
        };
        return eventsCommand(stack, merged);
      })
    );

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
