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
import {
  createLocalStateProvider,
  rejectExplicitCfnStackWithMultipleStacks,
} from './local-state-source.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';
import type { SubstitutionContext } from '../../local/state-resolver.js';
import { CloudMapRegistry } from '../../local/cloud-map-registry.js';
import { buildCloudMapIndex, type CloudMapIndex } from '../../local/cloud-map-resolver.js';
import {
  createSharedSvcNetwork,
  destroyTaskNetwork,
  type TaskNetwork,
} from '../../local/ecs-network.js';

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
  /**
   * Issue #264: read cdkd's S3 state for the target stack so the resolver
   * can substitute intrinsic-valued references (`Fn::Sub` / `Fn::GetAtt` /
   * `Ref` / `Fn::ImportValue` / `Fn::GetStackOutput`) in container images,
   * env vars, secrets, and role ARNs.
   */
  fromState: boolean;
  /**
   * Issue #606: alternative state source. Reads physical IDs from a
   * deployed CloudFormation stack via `DescribeStackResources` instead
   * of cdkd's S3 state. Mutually exclusive with `--from-state`.
   */
  fromCfnStack?: string | boolean;
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

  // Commander resolves `--no-pull` to `options.pull = false` (the
  // default is true). Compute the "should we skip docker pull?" flag
  // once here so the shared-network creation, the per-target task
  // boot, and any future call site share one source of truth (Issue
  // #544 NIT 2).
  const skipPull = options.pull === false;

  if (!targets || targets.length === 0) {
    throw new LocalStartServiceError(
      'cdkd local start-service requires at least one <target>. ' +
        "Pass one or more service paths like 'Stack/Orders' 'Stack/Frontend'."
    );
  }

  // Issue #606: reject explicit `--from-cfn-stack <name>` when multiple
  // service targets are booted in one invocation. The explicit name
  // would apply to every target and silently mismap logical IDs across
  // siblings that happen to share a `Ref` key. Bare `--from-cfn-stack`
  // is fine (each target uses its own cdkd stack name as the CFn name).
  // Conservative bound: a multi-target invocation always counts as
  // "multiple stacks" here even if every target maps to the same
  // underlying cdkd stack, because we don't have the synth result yet.
  rejectExplicitCfnStackWithMultipleStacks(options, targets.length);

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
  // Hoisted out of the try block so the single-flight cleanup closure
  // can teardown the shared network after every container is gone.
  // Assigned inside the try once the shared `cdkd-local-svc-<rand>`
  // network + sidecar are up; left undefined if the run failed to
  // create them.
  let sharedNetwork: TaskNetwork | undefined;

  // Single-flight cleanup so the SIGINT handler and the outer `finally`
  // collapse to one underlying invocation. Fans out across every
  // target's controller; falls back to per-replica cleanupEcsRun when
  // a controller never finished construction (early-failure case).
  // The shared network is torn down LAST so per-replica
  // `cleanupEcsRun()` calls (which only stop containers — they no
  // longer destroy the network in shared mode because the task
  // runner marks the network as caller-owned) finish first.
  const cleanup = singleFlight(
    async (): Promise<void> => {
      await Promise.allSettled(
        perTarget.map(async (pt) => {
          if (pt.controller) {
            await pt.controller.shutdown();
          } else {
            // SIGINT-during-bootOneTarget early-failure path: `pt.controller`
            // is still undefined because `bootOneTarget` was mid-flight
            // when the signal arrived. Each replica may have an
            // `inFlightBoot` promise that is still populating
            // `state.startedContainers` / `state.network`. Await each
            // such promise BEFORE iterating replicas for cleanup so
            // we don't tear down a half-built state and orphan the
            // containers / network the in-flight boot was about to
            // record. Mirrors `ServiceController.shutdown()`'s ordering.
            // `Promise.allSettled` swallows in-flight rejections —
            // those become per-replica leftover state that the
            // subsequent `cleanupEcsRun` still tears down.
            await Promise.allSettled(
              pt.runState.replicas
                .map((r) => r.inFlightBoot)
                .filter((p): p is Promise<void> => p !== undefined)
            );
            await Promise.allSettled(
              pt.runState.replicas.map((r) =>
                cleanupEcsRun(r.state, { keepRunning: false }).catch(() => undefined)
              )
            );
          }
        })
      );
      // Shared network teardown (design § 5 Option A). The sidecar +
      // network were created once at CLI startup and survived every
      // per-replica `cleanupEcsRun()`; we drop them once now that
      // every container has been removed. `destroyTaskNetwork` is
      // idempotent on undefined so we don't need a separate guard.
      if (sharedNetwork) {
        try {
          await destroyTaskNetwork(sharedNetwork);
        } catch (err) {
          getLogger().warn(
            `shared service network teardown failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        sharedNetwork = undefined;
      }
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
    // it to build per-replica `--add-host` flags. Created
    // unconditionally for every `cdkd local start-service` invocation
    // (per-service-runner short-circuits internally when the service
    // has no Cloud Map / Service Connect surfaces to publish). The
    // single-service no-discovery cost is one in-process Map allocation
    // — negligible compared to the cost of branching the CLI surface.
    const registry = new CloudMapRegistry();
    // Design doc § 5 Option A — create ONE shared docker network used
    // by every service-replica boot in this CLI invocation. The
    // alternative (one network per task — pre-PR-#522 shape) made
    // cross-service peer reachability impossible: docker bridge
    // networks are isolated by default, so a frontend container on
    // `169.254.171.0/24` could not reach an orders container on
    // `169.254.170.0/24` even with `--add-host orders:<ip>` populating
    // its `/etc/hosts`. With one shared network across all services,
    // every container can reach every peer by IP / network alias
    // without docker `network connect` choreography.
    //
    // The sidecar attached to this shared network serves the
    // metadata endpoint to every container. Per-service IAM role
    // emulation in multi-service runs is NOT supported in v1 — each
    // service's `TaskRoleArn` flows into its container env via
    // `buildMetadataEnv`, but the sidecar itself uses the user's
    // default AWS credential chain. Users who need per-service IAM
    // role emulation should split their run into multiple
    // `cdkd local start-service` invocations.
    try {
      sharedNetwork = await createSharedSvcNetwork({
        prefix: options.cluster,
        skipPull,
        cluster: options.cluster,
      });
    } catch (err) {
      throw new LocalStartServiceError(
        `Failed to create shared service network: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const discovery: ServiceDiscoveryContext = {
      registry,
      cloudMapIndexByStack,
      sharedNetwork,
    };

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
      pt.controller = await bootOneTarget(
        pt.target,
        pt.runState,
        stacks,
        options,
        discovery,
        skipPull
      );
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
  discovery: ServiceDiscoveryContext,
  skipPull: boolean
): Promise<ServiceController> {
  // Issue #606: pick the right LocalStateProvider per target (the cdkd
  // stack name varies per target). The provider is disposed in the
  // outer `finally` below so the AWS client allocated by either
  // implementation is closed even if `applyCrossStackResolverToTask`
  // throws mid-substitution. `createLocalStateProvider` returns
  // `undefined` when neither `--from-state` nor `--from-cfn-stack` was
  // set; the substitution paths short-circuit on `undefined` then.
  const parsed = parseEcsTarget(target);
  const candidate = pickCandidateStack(parsed.stackPattern, stacks);
  const stateProvider = createLocalStateProvider(
    options,
    candidate?.stackName ?? '',
    candidate?.region
  );

  try {
    return await runOneTarget(
      target,
      runState,
      stacks,
      options,
      discovery,
      skipPull,
      stateProvider
    );
  } finally {
    if (stateProvider) stateProvider.dispose();
  }
}

async function runOneTarget(
  target: string,
  runState: ServiceRunState,
  stacks: StackInfo[],
  options: LocalStartServiceOptions,
  discovery: ServiceDiscoveryContext,
  skipPull: boolean,
  stateProvider: LocalStateProvider | undefined
): Promise<ServiceController> {
  const logger = getLogger();

  const imageContext = await buildEcsImageResolutionContext(target, stacks, options, stateProvider);
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
  if (stateProvider && taskNeeds.needsCrossStackResolver) {
    const consumerRegion =
      options.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      service.stack.region ??
      'us-east-1';
    const resolver = await stateProvider.buildCrossStackResolver(consumerRegion);
    if (resolver) {
      const subContext: SubstitutionContext = {
        resources: imageContext?.stateResources ?? {},
        ...(imageContext?.pseudoParameters && {
          pseudoParameters: imageContext.pseudoParameters,
        }),
        consumerRegion,
        crossStackResolver: resolver,
      };
      await applyCrossStackResolverToTask(service.task, subContext);
    }
  } else if (!stateProvider && taskNeeds.needsCrossStackResolver) {
    logger.warn(
      'Container Environment / Secrets entries contain Fn::ImportValue / Fn::GetStackOutput intrinsics. ' +
        'Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) to substitute them against deployed state.'
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
    skipPull,
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
  options: LocalStartServiceOptions,
  stateProvider: LocalStateProvider | undefined
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

  const wantsPseudoForEnvOrSecret = !!stateProvider && needs.needsEnvOrSecretSubstitution;
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
  if (stateProvider && wantsState) {
    const loaded = await stateProvider.load(candidate.stackName, candidate.region);
    if (loaded) {
      ctx.stateResources = loaded.resources;
    }
  } else if (!stateProvider && needs.needsStateResources) {
    logger.warn(
      'Container Image references a same-stack AWS::ECR::Repository. Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) to substitute the deployed repository URI.'
    );
  } else if (!stateProvider && needs.needsEnvOrSecretSubstitution) {
    logger.warn(
      'Container Environment / Secrets entries contain CloudFormation intrinsics. ' +
        'Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) to substitute them against the deployed cdkd state.'
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
 * in `ecs-service-runner.ts:pickSubnetOctet`. The allocator walks the
 * link-local /24 range `169.254.170.0..169.254.253.0` and **skips 171**
 * because that octet is owned by the shared-service network
 * (`SHARED_SVC_SUBNET_OCTET`) — assigning a per-replica network the
 * same /24 would have docker reject the duplicate-subnet `network
 * create`. The usable count is therefore 83 (Issue #544); beyond
 * that, the modulo-wrap collapses replica N's `/24` onto replica 0's
 * allocation and docker rejects the duplicate-subnet network creation
 * with a cryptic "Pool overlaps with other one on this address space"
 * error 30s into the boot — by which time some early replicas may
 * have spent docker-run budget. Reject at parse time so the user
 * gets an actionable error before any boot work fires.
 *
 * Raising this requires extending the allocator to walk a different
 * IP range.
 */
export const MAX_TASKS_SUBNET_RANGE_CAP = 83;

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
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via DescribeStackResources and substitute Ref / Fn::ImportValue ' +
          'in container env vars / secrets / image URIs with the deployed physical IDs / exports. ' +
          'Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). ' +
          'Bare form uses the cdkd stack name; pass an explicit value when the CFn stack name differs. ' +
          'Mutually exclusive with --from-state. Fn::GetAtt is warn-and-dropped in v1 (CFn DescribeStackResources does not return per-attribute values).'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-state when the same stack name has state in multiple regions, ' +
          'and with --from-cfn-stack as the CFn client region (cdkd does not have a separate --cfn-stack-region flag).'
      )
    )
    .action(withErrorHandling(localStartServiceCommand));

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
