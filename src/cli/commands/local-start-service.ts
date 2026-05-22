import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling, LocalStartServiceError } from '../../utils/error-handler.js';
import { singleFlight } from '../../utils/single-flight.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { ensureDockerAvailable } from '../../local/docker-runner.js';
import {
  applyCrossStackResolverToTask,
  derivePartitionAndUrlSuffix,
  detectEcsImageResolutionNeeds,
  parseEcsTarget,
  TASK_ROLE_ACCOUNT_PLACEHOLDER,
  type EcsImageResolutionContext,
} from '../../local/ecs-task-resolver.js';
import { resolveEcsServiceTarget } from '../../local/ecs-service-resolver.js';
import {
  createServiceRunState,
  startEcsService,
  type ServiceController,
  type ServiceDiscoveryContext,
  type ServiceRunnerOptions,
  type ServiceRunState,
} from '../../local/ecs-service-runner.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { cleanupEcsRun, type RunEcsTaskOptions } from '../../local/ecs-task-runner.js';
import { matchStacks } from '../stack-matcher.js';
import { buildCrossStackResolver, loadStateForStack } from './local-state-loader.js';
import type { SubstitutionContext } from '../../local/state-resolver.js';
import { CloudMapRegistry } from '../../local/cloud-map-registry.js';
import { buildCloudMapIndex, type CloudMapIndex } from '../../local/cloud-map-resolver.js';

interface LocalStartServiceOptions {
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
  /** See `local-run-task.ts` for the same flag's three-state grammar. */
  assumeTaskRole?: string | boolean;
  pull: boolean;
  ecrRoleArn?: string;
  platform?: string;
  /** Cap on local replica count regardless of template `DesiredCount`. */
  maxTasks: number;
  /** Restart-on-exit policy: 'on-failure' (default), 'always', or 'none'. */
  restartPolicy: 'on-failure' | 'always' | 'none';
  fromState: boolean;
  stateBucket?: string;
  statePrefix: string;
  stackRegion?: string;
}

/**
 * `cdkd local start-service <Stack/Service>` — Phase 2 of #262. Spins up
 * `DesiredCount` task replicas locally (clamped by `--max-tasks`) using
 * the existing `ecs-task-runner` per replica. Long-running; ^C cleans
 * every replica + sidecar + per-task network.
 *
 * Deferred to follow-up PRs (matches the issue's PR-split):
 *   - Local LB emulator (listener + round-robin + target-group health
 *     check) — PR C of #466.
 *   - Rolling deployment (`--watch` / `--reload`) — PR D of #466.
 *   - Service Connect / Cloud Map — tracked separately in #460.
 */
async function localStartServiceCommand(
  targets: string[],
  options: LocalStartServiceOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  if (!targets || targets.length === 0) {
    throw new LocalStartServiceError(
      'cdkd local start-service requires at least one <target>. ' +
        "Pass one or more service paths like 'Stack/Orders' 'Stack/Frontend'."
    );
  }

  // Per-target run-state + controller, plus a shared Cloud Map
  // registry across every service. Building everything upfront and
  // hoisting cleanup keeps SIGINT correctness in lock-step with the
  // pre-PR single-service shape.
  type PerTarget = {
    target: string;
    runState: ServiceRunState;
    controller?: ServiceController;
  };
  const perTarget: PerTarget[] = targets.map((t) => ({
    target: t,
    runState: createServiceRunState(),
  }));

  let sigintHandler: (() => void) | undefined;
  let sigintCount = 0;

  // Single-flight cleanup so the SIGINT handler and the outer `finally`
  // collapse to one underlying invocation. Fans out across every
  // target's controller; falls back to per-replica cleanupEcsRun when
  // a controller never finished construction (early-failure case).
  const cleanup = singleFlight(
    async (): Promise<void> => {
      await Promise.allSettled(
        perTarget.map(async (pt) => {
          if (pt.controller) {
            await pt.controller.shutdown();
          } else {
            await Promise.allSettled(
              pt.runState.replicas.map((r) =>
                cleanupEcsRun(r.state, { keepRunning: false }).catch(() => undefined)
              )
            );
          }
        })
      );
    },
    (err) =>
      getLogger().warn(
        `service cleanup failed: ${err instanceof Error ? err.message : String(err)}`
      )
  );

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
      ...(options.stateBucket && { stateBucket: options.stateBucket }),
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
    };
    const { stacks } = await synthesizer.synthesize(synthOpts);

    // Build the shared Cloud Map index once across every stack the
    // synth produced. Per-stack lookups in the runner then pick the
    // matching CloudMapIndex by stack name.
    const cloudMapIndexByStack = new Map<string, CloudMapIndex>();
    for (const stack of stacks) {
      const index = buildCloudMapIndex(stack);
      cloudMapIndexByStack.set(stack.stackName, index);
      for (const w of index.warnings) logger.warn(w);
    }

    // Shared Cloud Map registry — every per-service runner registers
    // into the same instance, and every per-service runner reads from
    // it to build per-replica `--add-host` flags. Created only when
    // we have more than one target OR any single target has Cloud Map
    // / Service Connect surfaces to publish; otherwise we leave it
    // undefined and the runner short-circuits all registry work.
    const registry = new CloudMapRegistry();
    const discovery: ServiceDiscoveryContext = { registry, cloudMapIndexByStack };

    // SIGINT pattern mirrors local-run-task: double-^C bypasses
    // cleanup and exits 130 immediately so users have an escape hatch
    // when docker hangs. Installed BEFORE any docker work so partial
    // boots are torn down.
    sigintHandler = (): void => {
      sigintCount += 1;
      if (sigintCount >= 2) {
        process.stderr.write('Force-exit on second ^C; container cleanup skipped.\n');
        process.exit(130);
      }
      logger.info('Stopping service(s)...');
      void cleanup().then(() => process.exit(130));
    };
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigintHandler);

    // Boot every target SEQUENTIALLY so a first-target failure
    // surfaces before we burn docker budget on the rest, AND so the
    // Cloud Map registry is populated in target order — peer services
    // booted later automatically see earlier services' registrations
    // and have them substituted via `--add-host` at boot.
    for (const pt of perTarget) {
      pt.controller = await bootOneTarget(pt.target, pt.runState, stacks, options, discovery);
    }

    const summary = perTarget
      .map(
        (pt) =>
          `${pt.controller!.service.serviceName} (${pt.controller!.activeReplicaCount()} replica(s))`
      )
      .join(', ');
    logger.info(`Service(s) running: ${summary}. Press ^C to shut down.`);

    // Block until ALL services shut down (in practice this happens on
    // SIGINT, which triggers cleanup() above which awaits every
    // controller.shutdown()).
    await Promise.all(perTarget.map((pt) => pt.controller!.waitForShutdown()));
  } finally {
    if (sigintHandler) {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigintHandler);
    }
    await cleanup();
  }
}

/**
 * Boot one target. Extracted from the loop so each per-service block
 * (image context, cross-stack resolver, task-role credentials, runner
 * options) is scoped locally. Returns the started controller for the
 * outer code to wait + tear down.
 */
async function bootOneTarget(
  target: string,
  runState: ServiceRunState,
  stacks: StackInfo[],
  options: LocalStartServiceOptions,
  discovery: ServiceDiscoveryContext
): Promise<ServiceController> {
  const logger = getLogger();

  const imageContext = await buildEcsImageResolutionContext(target, stacks, options);
  const service = resolveEcsServiceTarget(target, stacks, imageContext);
  logger.info(
    `Target: ${service.stack.stackName}/${service.serviceLogicalId} ` +
      `(service=${service.serviceName}, desiredCount=${service.desiredCount}, ` +
      `task=${service.task.taskDefinitionLogicalId})`
  );
  for (const w of service.warnings) logger.warn(w);
  if (service.serviceConnect) {
    logger.info(
      `Service Connect: namespace='${service.serviceConnect.namespaceName}', ` +
        `${service.serviceConnect.services.length} service(s) registered for peer discovery.`
    );
  }
  if (service.serviceRegistries.length > 0) {
    logger.info(`Cloud Map: ${service.serviceRegistries.length} ServiceRegistry binding(s).`);
  }

  // Cross-stack env / secret resolution post-pass (mirrors local-run-task).
  const taskStack = stacks.find((s) => s.stackName === service.stack.stackName) ?? service.stack;
  const taskNeeds = detectEcsImageResolutionNeeds(taskStack);
  if (options.fromState && taskNeeds.needsCrossStackResolver) {
    const consumerRegion =
      options.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      service.stack.region ??
      'us-east-1';
    const built = await buildCrossStackResolver(consumerRegion, {
      ...(options.stateBucket !== undefined && { stateBucket: options.stateBucket }),
      statePrefix: options.statePrefix,
      ...(options.region !== undefined && { region: options.region }),
      ...(options.profile !== undefined && { profile: options.profile }),
    });
    if (built) {
      try {
        const subContext: SubstitutionContext = {
          resources: imageContext?.stateResources ?? {},
          ...(imageContext?.pseudoParameters && {
            pseudoParameters: imageContext.pseudoParameters,
          }),
          consumerRegion,
          crossStackResolver: built.resolver,
        };
        await applyCrossStackResolverToTask(service.task, subContext);
      } finally {
        built.dispose();
      }
    }
  } else if (!options.fromState && taskNeeds.needsCrossStackResolver) {
    logger.warn(
      'Container Environment / Secrets entries contain Fn::ImportValue / Fn::GetStackOutput intrinsics. ' +
        'Pass --from-state to substitute them against deployed cdkd state.'
    );
  }

  // Per-service task-role credentials. Each service can have its own
  // TaskRoleArn — when multiple services share `--assume-task-role`
  // (bare flag), each gets its own STS hop. Explicit `--assume-task-role <arn>`
  // applies the same ARN across every service.
  let assumedCredentials: RunEcsTaskOptions['taskCredentials'];
  let resolvedRoleArn: string | undefined;
  if (options.assumeTaskRole === true) {
    if (!service.task.taskRoleArn) {
      throw new LocalStartServiceError(
        `--assume-task-role passed without an ARN but service '${service.serviceLogicalId}' ` +
          `has no resolvable TaskRoleArn. Pass the ARN explicitly: --assume-task-role <arn>`
      );
    }
    resolvedRoleArn = await resolvePlaceholderAccount(service.task.taskRoleArn, options.region);
    assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
  } else if (typeof options.assumeTaskRole === 'string') {
    resolvedRoleArn = options.assumeTaskRole;
    assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
  }

  const envOverrides = readEnvOverridesFile(options.envVars);

  const taskOpts: RunEcsTaskOptions = {
    cluster: options.cluster,
    containerHost: options.containerHost,
    skipPull: options.pull === false,
    keepRunning: false,
    detach: true,
  };
  if (envOverrides) taskOpts.envOverrides = envOverrides;
  if (assumedCredentials) taskOpts.taskCredentials = assumedCredentials;
  if (resolvedRoleArn) taskOpts.taskRoleArn = resolvedRoleArn;
  if (options.platform) taskOpts.platformOverride = options.platform;
  if (options.region) taskOpts.region = options.region;
  if (options.ecrRoleArn) taskOpts.ecrRoleArn = options.ecrRoleArn;

  const runnerOpts: ServiceRunnerOptions = {
    maxTasks: options.maxTasks,
    restartPolicy: options.restartPolicy,
    taskOptions: taskOpts,
    discovery,
  };

  return startEcsService(service, runnerOpts, runState);
}

async function resolvePlaceholderAccount(arn: string, region: string | undefined): Promise<string> {
  if (!arn.includes(TASK_ROLE_ACCOUNT_PLACEHOLDER)) return arn;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const account = identity.Account;
    if (!account) {
      throw new LocalStartServiceError(
        `--assume-task-role: GetCallerIdentity returned no Account; cannot resolve placeholder ARN '${arn}'.`
      );
    }
    return arn.split(TASK_ROLE_ACCOUNT_PLACEHOLDER).join(account);
  } finally {
    sts.destroy();
  }
}

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
        RoleSessionName: `cdkd-local-start-service-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new LocalStartServiceError(`AssumeRole(${roleArn}) returned no usable credentials.`);
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
 * Build the substitution context the ECS resolver consumes. Identical
 * shape to `local-run-task.ts:buildEcsImageResolutionContext` — only
 * the candidate stack picker differs because services and tasks share
 * the same stack-pattern grammar.
 */
async function buildEcsImageResolutionContext(
  target: string,
  stacks: StackInfo[],
  options: LocalStartServiceOptions
): Promise<EcsImageResolutionContext | undefined> {
  const logger = getLogger();
  const parsed = parseEcsTarget(target);
  const candidate = pickCandidateStack(parsed.stackPattern, stacks);
  if (!candidate) return undefined;

  const needs = detectEcsImageResolutionNeeds(candidate);
  if (
    !needs.needsPseudoParameters &&
    !needs.needsStateResources &&
    !needs.needsEnvOrSecretSubstitution
  ) {
    return undefined;
  }

  const ctx: EcsImageResolutionContext = {};

  const wantsPseudoForEnvOrSecret = options.fromState && needs.needsEnvOrSecretSubstitution;
  if (needs.needsPseudoParameters || wantsPseudoForEnvOrSecret) {
    const region =
      options.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      candidate.region;
    if (!region) {
      logger.warn(
        'Resolver references ${AWS::Region} but cdkd could not determine the target region. ' +
          'Pass --region, set AWS_REGION, or declare env.region on the CDK stack.'
      );
    }
    let accountId: string | undefined;
    try {
      accountId = await resolveCallerAccountId(region);
    } catch (err) {
      logger.warn(
        `Resolver needs \${AWS::AccountId} but STS GetCallerIdentity failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Substitution will be skipped; affected env / secret entries will be dropped with per-key warnings.'
      );
    }
    const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
    ctx.pseudoParameters = {
      ...(accountId !== undefined && { accountId }),
      ...(region !== undefined && { region }),
      ...(partitionAndSuffix && {
        partition: partitionAndSuffix.partition,
        urlSuffix: partitionAndSuffix.urlSuffix,
      }),
    };
  }

  const wantsState = needs.needsStateResources || needs.needsEnvOrSecretSubstitution;
  if (options.fromState && wantsState) {
    const loaded = await loadStateForStack(candidate.stackName, candidate.region, {
      ...(options.stackRegion !== undefined && { stackRegion: options.stackRegion }),
      ...(options.stateBucket !== undefined && { stateBucket: options.stateBucket }),
      statePrefix: options.statePrefix,
      ...(options.region !== undefined && { region: options.region }),
      ...(options.profile !== undefined && { profile: options.profile }),
    });
    if (loaded) {
      ctx.stateResources = loaded.state.resources;
    }
  } else if (!options.fromState && needs.needsStateResources) {
    logger.warn(
      'Container Image references a same-stack AWS::ECR::Repository. Pass --from-state to substitute the deployed repository URI.'
    );
  } else if (!options.fromState && needs.needsEnvOrSecretSubstitution) {
    logger.warn(
      'Container Environment / Secrets entries contain CloudFormation intrinsics. ' +
        'Pass --from-state to substitute them against the deployed cdkd state.'
    );
  }

  return ctx;
}

function pickCandidateStack(
  stackPattern: string | null,
  stacks: StackInfo[]
): StackInfo | undefined {
  if (stackPattern === null) {
    if (stacks.length === 1) return stacks[0];
    return undefined;
  }
  const matched = matchStacks(stacks, [stackPattern]);
  if (matched.length === 1) return matched[0];
  return undefined;
}

async function resolveCallerAccountId(region: string | undefined): Promise<string | undefined> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account;
  } finally {
    sts.destroy();
  }
}

function readEnvOverridesFile(
  filePath: string | undefined
): Record<string, Record<string, string | null> | undefined> | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new LocalStartServiceError(
      `Failed to read --env-vars file '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LocalStartServiceError(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalStartServiceError(
      `--env-vars file '${filePath}' must contain a JSON object at the top level.`
    );
  }
  return parsed as Record<string, Record<string, string | null> | undefined>;
}

function parsePositiveInt(raw: string, flagName: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new LocalStartServiceError(`${flagName} must be a positive integer (got '${raw}').`);
  }
  return parsed;
}

/**
 * Hard cap on `--max-tasks` driven by the per-replica subnet allocator
 * in `ecs-service-runner.ts:bootReplica` (`170 + (index % 84)`). The
 * `% 84` modulo wraps at index 84, collapsing replica 84's `/24` onto
 * replica 0's allocation. Docker rejects the duplicate-subnet network
 * creation with a cryptic "Pool overlaps with other one on this address
 * space" error 30s into the boot — by which time some early replicas
 * may have spent docker-run budget. Reject at parse time so the user
 * gets an actionable error before any boot work fires.
 *
 * 84 is the count of usable link-local /24 octets in the range
 * `169.254.170.0..169.254.253.0` (255 reserved for broadcast). Raising
 * this requires extending the allocator to walk a different IP range.
 */
export const MAX_TASKS_SUBNET_RANGE_CAP = 84;

function parseMaxTasks(raw: string): number {
  const parsed = parsePositiveInt(raw, '--max-tasks');
  if (parsed > MAX_TASKS_SUBNET_RANGE_CAP) {
    throw new LocalStartServiceError(
      `--max-tasks ${parsed} exceeds the per-replica link-local /24 subnet allocator's range ` +
        `(${MAX_TASKS_SUBNET_RANGE_CAP}). The allocator in ecs-service-runner.ts assigns each replica its own ` +
        `169.254.x.0/24 from the range 169.254.170.0..169.254.253.0; replica indices >= ${MAX_TASKS_SUBNET_RANGE_CAP} ` +
        `would collide with earlier replicas via modulo wrap. Lower --max-tasks to <= ${MAX_TASKS_SUBNET_RANGE_CAP}, ` +
        `or accept reduced local concurrency for high-DesiredCount services.`
    );
  }
  return parsed;
}

function parseRestartPolicy(raw: string): 'on-failure' | 'always' | 'none' {
  if (raw === 'on-failure' || raw === 'always' || raw === 'none') return raw;
  throw new LocalStartServiceError(
    `--restart-policy must be one of 'on-failure', 'always', or 'none' (got '${raw}').`
  );
}

export function createLocalStartServiceCommand(): Command {
  const cmd = new Command('start-service')
    .description(
      'Run one or more AWS::ECS::Service resources locally as a long-running emulator. Spins up ' +
        'DesiredCount task replicas per service (clamped by --max-tasks) using the same per-task ' +
        'docker network + metadata sidecar pattern as `cdkd local run-task`, then keeps each ' +
        'replica running and restarts it on exit per --restart-policy. ^C tears every replica + ' +
        'sidecar + network down. Each <target> accepts a CDK display path (MyStack/MyService) ' +
        'or stack-qualified logical ID (MyStack:MyServiceXYZ); single-stack apps may omit the ' +
        'stack prefix. When two or more <target>s are supplied, every service is booted into a ' +
        'shared Cloud Map / Service Connect registry so peer services discover each other via ' +
        'docker --add-host overlay (Issue #460).'
    )
    .argument(
      '<targets...>',
      'One or more CDK display paths or stack-qualified logical IDs of the AWS::ECS::Service resources to run'
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
          'credentials via the metadata sidecar so containers run with the deployed task role. ' +
          "Bare flag uses the template's TaskRoleArn; pass an explicit ARN to override."
      )
    )
    .addOption(
      new Option('--no-pull', 'Skip docker pull for every container image and the metadata sidecar')
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized registries.'
      )
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'Force docker --platform (linux/amd64 or linux/arm64). Default: inferred from task RuntimePlatform.CpuArchitecture'
      )
    )
    .addOption(
      new Option(
        '--max-tasks <n>',
        'Hard cap on local replica count. Caps the template DesiredCount so local dev machines ' +
          "don't run an unbounded number of containers. Cannot exceed " +
          `${MAX_TASKS_SUBNET_RANGE_CAP} due to the per-replica link-local /24 subnet allocator's range.`
      )
        .default(3)
        .argParser(parseMaxTasks)
    )
    .addOption(
      new Option(
        '--restart-policy <policy>',
        "How to react when an essential container exits. 'on-failure' (default) restarts only " +
          "on non-zero exit; 'always' restarts on every exit; 'none' shuts the replica down " +
          'and runs the service degraded.'
      )
        .default('on-failure')
        .argParser(parseRestartPolicy)
    )
    .addOption(
      new Option(
        '--from-state',
        'Read cdkd S3 state for the target stack and substitute Fn::Sub / Fn::GetAtt / Fn::ImportValue / Fn::GetStackOutput intrinsics in container images, environment variables, secrets, role ARNs, and volumes.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the cdkd state record to read (used with --from-state when the same stack name has state in multiple regions).'
      )
    )
    .action(withErrorHandling(localStartServiceCommand));

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
