import * as readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import {
  commonOptions,
  deprecatedRegionOption,
  parseDuration,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { bold, cyan, gray, green, red, yellow } from '../../utils/colors.js';
import { CdkdError, withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import {
  DeploymentEventsReader,
  DEPLOYMENT_EVENTS_MAX_INDEX_RUNS,
} from '../../state/deployment-events-store.js';
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

/**
 * Options accepted by `cdkd events prune`. Inherits the same state-bucket /
 * region / profile blocks as `cdkd events`; adds the retention knobs.
 */
interface EventsPruneCommandOptions {
  stateBucket?: string;
  statePrefix?: string;
  region?: string;
  profile?: string;
  verbose?: boolean;
  stackRegion?: string;
  /** Retain only the newest N runs. */
  keep?: number;
  /** Delete runs older than this duration; units are s/m/h (e.g. 24h, 90m). */
  olderThan?: string;
  /** Delete EVERY recorded run + the index. */
  all?: boolean;
  /** Skip the interactive confirmation. */
  yes?: boolean;
}

/**
 * `cdkd events prune <stack>` — reclaim S3 space by deleting old per-run
 * `{runId}.jsonl` event streams (issue #885). `cdkd destroy` deliberately
 * keeps event history as post-mortem context, so this is the explicit way
 * to purge it; the deploy/destroy writer also self-bounds to the last
 * {@link DEPLOYMENT_EVENTS_MAX_INDEX_RUNS} runs automatically.
 *
 * Retention selection:
 *   - `--all`              purge every run + the index.
 *   - `--keep <N>`         retain the newest N runs.
 *   - `--older-than <dur>` delete runs older than the duration.
 *   - both keep+older-than: delete runs that are BOTH beyond newest-N AND
 *                           older than the cutoff.
 *   - none of the above:   default to keeping the newest
 *                          {@link DEPLOYMENT_EVENTS_MAX_INDEX_RUNS}.
 */
export async function eventsPruneCommand(
  stackName: string,
  options: EventsPruneCommandOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }
  warnIfDeprecatedRegion(options);

  if (options.all === true && (options.keep !== undefined || options.olderThan !== undefined)) {
    throw new CdkdError(
      "'--all' purges every run and cannot be combined with '--keep' / '--older-than'.",
      'EVENTS_PRUNE_BAD_FLAGS'
    );
  }
  const olderThanMs =
    options.olderThan !== undefined ? parseDuration(options.olderThan) : undefined;

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
    const targetRegion = await resolveEventsRegion(reader, stackName, options.stackRegion);

    // Preview what would be deleted before touching anything.
    const runs = await reader.listRuns(stackName, targetRegion);
    const totalRuns = runs.length;
    const scope = options.all
      ? `ALL ${totalRuns} run(s)`
      : options.keep !== undefined && olderThanMs !== undefined
        ? `runs beyond the newest ${options.keep} AND older than ${options.olderThan}`
        : options.keep !== undefined
          ? `runs beyond the newest ${options.keep}`
          : olderThanMs !== undefined
            ? `runs older than ${options.olderThan}`
            : `runs beyond the newest ${DEPLOYMENT_EVENTS_MAX_INDEX_RUNS}`;

    if (options.yes !== true) {
      // On a non-interactive stdin (CI, piped) the readline prompt cannot be
      // answered and could hang or mis-default — mirror `cdkd destroy` and
      // refuse rather than prompt, pointing the user at --yes. Nothing is
      // deleted in this path.
      if (!process.stdin.isTTY) {
        logger.info(
          gray(
            `Refusing to prune deployment-event history for ${stackName} (${targetRegion}) ` +
              `without confirmation on a non-interactive terminal. Re-run with --yes to proceed.`
          )
        );
        return;
      }
      const ok = await confirmPrompt(
        `Prune deployment-event history for ${cyan(stackName)} ${gray(`(${targetRegion})`)}: ${scope}?`
      );
      if (!ok) {
        logger.info(gray('Aborted; nothing was deleted.'));
        return;
      }
    }

    const result = await reader.pruneRuns(stackName, targetRegion, {
      ...(options.all === true && { all: true }),
      ...(options.keep !== undefined && { keep: options.keep }),
      ...(olderThanMs !== undefined && { olderThanMs }),
    });

    if (result.deletedRunIds.length === 0) {
      logger.info(
        gray(
          result.indexDeleted
            ? `Removed the empty deployment-event index for ${stackName} (${targetRegion}); no run streams to delete.`
            : `No runs matched the prune criteria for ${stackName} (${targetRegion}).`
        )
      );
      return;
    }
    logger.info(
      `${green('Pruned')} ${result.deletedRunIds.length} deployment-event run(s) for ` +
        `${cyan(stackName)} ${gray(`(${targetRegion})`)}; ` +
        `${result.remainingRunIds.length} retained` +
        (result.indexDeleted ? gray(' (index removed)') : '') +
        '.'
    );
  } finally {
    awsClients.destroy();
  }
}

/** Minimal `(y/N)` confirmation prompt. */
async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
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
    const resultColored =
      run.result === 'SUCCEEDED'
        ? green(run.result)
        : run.result === 'UNKNOWN'
          ? gray(run.result)
          : red(run.result);
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

  cmd.addCommand(createEventsPruneCommand());

  return cmd;
}

/**
 * Create the `cdkd events prune <stack>` subcommand (issue #885).
 *
 * Only the prune-SPECIFIC options (`--keep` / `--older-than` / `--all`) are
 * declared here. The shared option blocks (`commonOptions` + `stateOptions`
 * + the deprecated region option) and `--stack-region` are inherited from
 * the parent `events` command — declaring the same flag on BOTH parent and
 * child makes Commander route a post-subcommand flag (`events prune X --yes`)
 * to the PARENT's storage, leaving the child's value at its default. The
 * action therefore reads the merged view via `command.optsWithGlobals()`.
 */
export function createEventsPruneCommand(): Command {
  const cmd = new Command('prune')
    .description('Delete old per-run deployment-event streams to reclaim S3 space')
    .argument('<stack>', 'Stack name (physical CloudFormation name)')
    .addOption(
      new Option('--keep <N>', 'Retain only the newest N runs').argParser((v) => {
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`Invalid --keep value "${v}": expected a non-negative integer.`);
        }
        return n;
      })
    )
    .option('--older-than <duration>', 'Delete runs older than this duration (e.g. 24h, 90m)')
    .option('--all', 'Delete every recorded run and the index (full purge)', false)
    .action(
      withErrorHandling((stack: string, _options: unknown, command: Command) =>
        eventsPruneCommand(stack, command.optsWithGlobals() as EventsPruneCommandOptions)
      )
    );

  return cmd;
}
