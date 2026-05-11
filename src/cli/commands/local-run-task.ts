import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { ensureDockerAvailable } from '../../local/docker-runner.js';
import { resolveEcsTaskTarget } from '../../local/ecs-task-resolver.js';
import {
  cleanupEcsRun,
  createEcsRunState,
  runEcsTask,
  type EcsRunState,
  type RunEcsTaskOptions,
} from '../../local/ecs-task-runner.js';

interface LocalRunTaskOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  cluster: string;
  envVars?: string;
  containerHost: string;
  /**
   * Commander's `[<arg>]` syntax maps to `string | boolean` here:
   *   - flag absent → `undefined`
   *   - `--assume-task-role` (bare) → `true`
   *   - `--assume-task-role <arn>` → `'<arn>'`
   * The runner branches on `typeof options.assumeTaskRole`.
   */
  assumeTaskRole?: string | boolean;
  pull: boolean;
  platform?: string;
  keepRunning: boolean;
  detach: boolean;
}

/**
 * `cdkd local run-task <target>` — Phase 1 of the ECS local-execution
 * trilogy. Synthesizes the CDK app, locates the target
 * `AWS::ECS::TaskDefinition`, stands up a per-task docker network with
 * the AWS-published `amazon-ecs-local-container-endpoints` sidecar, and
 * starts every container in `dependsOn` order. The essential
 * container's exit code drives the CLI's exit.
 *
 * Phase 2 (`cdkd local start-service` — Service + ALB-emulated routing)
 * and Phase 3 (Service Connect / Cloud Map degraded mode) are out of
 * scope here and tracked separately.
 */
async function localRunTaskCommand(target: string, options: LocalRunTaskOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  const state: EcsRunState = createEcsRunState();
  let sigintHandler: (() => void) | undefined;
  let sigintCount = 0;

  // Single-flight cleanup: the SIGINT handler AND the outer `finally` both
  // call this, so we await the first invocation's promise on every later
  // call rather than running concurrently against the shared mutable
  // `state` arrays (which would otherwise double-`docker rm -f` containers
  // and corrupt the entries map mid-iteration).
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        try {
          await cleanupEcsRun(state, { keepRunning: options.keepRunning });
        } catch (err) {
          getLogger().debug(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
    await cleanupPromise;
  };

  try {
    await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });
    await ensureDockerAvailable();

    const appCmd = resolveApp(options.app);
    if (!appCmd) {
      throw new Error('No CDK app specified. Pass --app, set CDKD_APP, or add "app" to cdk.json.');
    }

    logger.info('Synthesizing CDK app...');
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const synthOpts: SynthesisOptions = {
      app: appCmd,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
    };
    const { stacks } = await synthesizer.synthesize(synthOpts);

    const task = resolveEcsTaskTarget(target, stacks);
    logger.info(
      `Target: ${task.stack.stackName}/${task.taskDefinitionLogicalId} (family=${task.family}, containers=${task.containers.length})`
    );

    // Double-^C exits 130 immediately (matches `cdkd local start-api`).
    sigintHandler = (): void => {
      sigintCount += 1;
      if (sigintCount >= 2) {
        process.stderr.write('Force-exit on second ^C; container cleanup skipped.\n');
        process.exit(130);
      }
      logger.info('Stopping task...');
      void cleanup().then(() => process.exit(130));
    };
    process.on('SIGINT', sigintHandler);

    // `--assume-task-role` branches: bare flag (boolean `true`) needs the
    // task definition's resolved `TaskRoleArn`; otherwise the user-supplied
    // ARN is used. When the template only carries an intrinsic-valued
    // TaskRoleArn, cdkd's static resolver returns `undefined` — we
    // surface a clear hard error pointing the user at the explicit form.
    let assumedCredentials: RunEcsTaskOptions['taskCredentials'];
    let resolvedRoleArn: string | undefined;
    if (options.assumeTaskRole === true) {
      if (!task.taskRoleArn) {
        throw new Error(
          `--assume-task-role passed without an ARN but the task definition's TaskRoleArn could not be resolved statically. ` +
            `Pass the ARN explicitly: --assume-task-role <arn>`
        );
      }
      resolvedRoleArn = task.taskRoleArn;
      assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
    } else if (typeof options.assumeTaskRole === 'string') {
      resolvedRoleArn = options.assumeTaskRole;
      assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
    }

    const envOverrides = readEnvOverridesFile(options.envVars);

    const runOpts: RunEcsTaskOptions = {
      cluster: options.cluster,
      containerHost: options.containerHost,
      skipPull: options.pull === false,
      keepRunning: options.keepRunning,
      detach: options.detach,
    };
    if (envOverrides) runOpts.envOverrides = envOverrides;
    if (assumedCredentials) runOpts.taskCredentials = assumedCredentials;
    if (resolvedRoleArn) runOpts.taskRoleArn = resolvedRoleArn;
    if (options.platform) runOpts.platformOverride = options.platform;
    if (options.region) runOpts.region = options.region;

    const result = await runEcsTask(task, runOpts, state);

    if (options.detach) {
      logger.info('Task containers started in detached mode; cdkd is exiting.');
      logger.info(
        `Use 'docker ps --filter network=${result.state.network?.networkName ?? '<network>'}' to inspect; ` +
          `tear down with 'docker rm -f' and 'docker network rm'.`
      );
      // Detach mode skips cleanup — the caller manages container lifecycle.
      sigintCount = 99;
      return;
    }

    if (result.essentialContainerName) {
      logger.info(
        `Essential container '${result.essentialContainerName}' exited with code ${result.exitCode}.`
      );
    }
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } finally {
    if (sigintHandler) process.off('SIGINT', sigintHandler);
    if (!options.detach) await cleanup();
  }
}

/**
 * Assume `roleArn` and return temp credentials. Mirrors the same flow
 * `cdkd local invoke --assume-role` uses.
 */
async function assumeTaskRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-local-run-task-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new Error(`AssumeRole(${roleArn}) returned no usable credentials.`);
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}

/**
 * Read the `--env-vars` JSON file using the same SAM-style shape as
 * `cdkd local invoke --env-vars`: top-level keys are container names, with
 * `Parameters` reserved for global entries.
 */
function readEnvOverridesFile(
  filePath: string | undefined
): Record<string, Record<string, string | null> | undefined> | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read --env-vars file '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--env-vars file '${filePath}' must contain a JSON object at the top level.`);
  }
  return parsed as Record<string, Record<string, string | null> | undefined>;
}

export function createLocalRunTaskCommand(): Command {
  const cmd = new Command('run-task')
    .description(
      'Run an AWS::ECS::TaskDefinition locally — pulls/builds images, sets up a per-task docker network ' +
        'with the AWS-published metadata-endpoints sidecar, and starts every container in dependsOn order. ' +
        'Target accepts a CDK display path (MyStack/MyService/TaskDef) or stack-qualified logical ID ' +
        '(MyStack:MyServiceTaskDefXYZ1234). Single-stack apps may omit the stack prefix.'
    )
    .argument(
      '<target>',
      'CDK display path or stack-qualified logical ID of the AWS::ECS::TaskDefinition to run'
    )
    .addOption(
      new Option(
        '--cluster <name>',
        'Cluster name surfaced to ECS_CONTAINER_METADATA_URI_V4 and used as the docker network prefix'
      ).default('cdkd-local')
    )
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"ContainerName":{"KEY":"VALUE"}, "Parameters":{}})'
      )
    )
    .addOption(
      new Option(
        '--container-host <ip>',
        'Host IP to bind published container ports to. Must be a numeric IP (Docker rejects hostnames here)'
      ).default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-task-role [arn]',
        "Assume the task definition's TaskRoleArn (or the supplied ARN) and forward STS-issued temp " +
          'credentials via the metadata sidecar so containers run with the deployed function role. ' +
          "Bare flag uses the template's TaskRoleArn; pass an explicit ARN to override."
      )
    )
    .addOption(
      new Option('--no-pull', 'Skip docker pull for every container image and the metadata sidecar')
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'Force docker --platform (linux/amd64 or linux/arm64). Default: inferred from task RuntimePlatform.CpuArchitecture'
      )
    )
    .addOption(
      new Option(
        '--keep-running',
        "Don't docker rm -f the user containers on task exit (network + sidecar are still torn down). " +
          'Use when you want to docker exec into a stopped container for post-mortems.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--detach',
        'Start the containers in the background and exit (skip log streaming + auto teardown). ' +
          'Useful in CI smoke tests; caller manages container lifecycle.'
      ).default(false)
    )
    .action(withErrorHandling(localRunTaskCommand));

  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
