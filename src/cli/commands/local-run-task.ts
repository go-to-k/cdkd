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
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { ensureDockerAvailable } from '../../local/docker-runner.js';
import { resolveProfileCredentials } from './local-start-api.js';
import {
  applyCrossStackResolverToTask,
  derivePartitionAndUrlSuffix,
  detectEcsImageResolutionNeeds,
  parseEcsTarget,
  resolveEcsTaskTarget,
  TASK_ROLE_ACCOUNT_PLACEHOLDER,
  type EcsImageResolutionContext,
} from '../../local/ecs-task-resolver.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import {
  cleanupEcsRun,
  createEcsRunState,
  runEcsTask,
  type EcsRunState,
  type RunEcsTaskOptions,
} from '../../local/ecs-task-runner.js';
import { matchStacks } from '../stack-matcher.js';
import { createLocalStateProvider } from './local-state-source.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';
import type { SubstitutionContext } from '../../local/state-resolver.js';

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
  /**
   * Optional role ARN passed to `pullEcrImage` for cross-account /
   * centralized registry pulls (#455). Issues `sts:AssumeRole` via the
   * default credential chain and uses the resulting temp credentials to
   * authenticate against the target ECR repository. Same-account /
   * same-region pulls do not need this flag. Mirrors
   * `cdkd local invoke --ecr-role-arn`.
   */
  ecrRoleArn?: string;
  platform?: string;
  keepRunning: boolean;
  detach: boolean;
  /**
   * Issue #264: read cdkd's S3 state for the target stack so the resolver
   * can substitute `Fn::Sub` placeholders that reference a same-stack
   * `AWS::ECR::Repository`. Tier 1 (pseudo parameters only) does NOT need
   * this flag — STS GetCallerIdentity + the resolved region cover those.
   * Off by default.
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
  /**
   * Region of the state record to read. Required for `--from-state` when
   * the same stack name has state in multiple regions; reused as the
   * CFn client region for `--from-cfn-stack`. Mirrors `cdkd local
   * invoke --stack-region`.
   */
  stackRegion?: string;
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
  // Issue #606: the active state provider (--from-state / --from-cfn-stack).
  // Hoisted so the outer `finally` can dispose it even if the body
  // throws between provider creation and the normal exit path.
  let stateProvider: LocalStateProvider | undefined;

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
      // Threaded so the macro-expander has a real state bucket for the
      // > 51,200-byte template upload path when a stack carries a
      // CloudFormation macro (Issue #463).
      ...(options.stateBucket && { stateBucket: options.stateBucket }),
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
    };
    const { stacks } = await synthesizer.synthesize(synthOpts);

    // Issue #606: pick a LocalStateProvider for whichever flag the user
    // passed (--from-state OR --from-cfn-stack). Constructed BEFORE the
    // candidate-stack picker so the same provider drives both the
    // image-context state-load AND the post-pass cross-stack resolver
    // — preserves the single-load behavior from #264 / #454. Disposed
    // in the outer `finally` alongside container cleanup.
    const parsed = parseEcsTarget(target);
    const candidate = pickCandidateStack(parsed.stackPattern, stacks);
    stateProvider = createLocalStateProvider(
      options,
      candidate?.stackName ?? '',
      candidate?.region
    );

    // Issue #264: build the optional substitution context BEFORE resolving
    // the target, so `Fn::Sub`-shaped ECR image URIs (pseudo parameters +
    // same-stack ECR Repository refs) get rewritten in-place during
    // `parseContainerImage`. STS / state-load are lazy — we only fire them
    // when at least one stack's template references the placeholders.
    const imageContext = await buildEcsImageResolutionContext(candidate, stateProvider, options);
    const task = resolveEcsTaskTarget(target, stacks, imageContext);
    logger.info(
      `Target: ${task.stack.stackName}/${task.taskDefinitionLogicalId} (family=${task.family}, containers=${task.containers.length})`
    );

    // Issue #454 — cross-stack `Fn::ImportValue` / `Fn::GetStackOutput`
    // resolution in env vars / secrets. The sync `parseContainerDefinition`
    // pass dropped these with a warn-and-drop entry; the async post-pass
    // re-attempts them via the active state provider when the template
    // actually references a cross-stack output.
    const taskStack = stacks.find((s) => s.stackName === task.stack.stackName) ?? task.stack;
    const taskNeeds = detectEcsImageResolutionNeeds(taskStack);
    if (stateProvider && taskNeeds.needsCrossStackResolver) {
      const consumerRegion =
        options.region ??
        process.env['AWS_REGION'] ??
        process.env['AWS_DEFAULT_REGION'] ??
        task.stack.region ??
        'us-east-1';
      const resolver = await stateProvider.buildCrossStackResolver(consumerRegion);
      if (resolver) {
        const subContext: SubstitutionContext = {
          // The image / env / secret sync passes already consumed
          // `imageContext.stateResources` / `imageContext.pseudoParameters`
          // (when set); the post-pass reuses them so a cross-stack-only
          // env var doesn't re-build the state map.
          resources: imageContext?.stateResources ?? {},
          ...(imageContext?.pseudoParameters && {
            pseudoParameters: imageContext.pseudoParameters,
          }),
          consumerRegion,
          crossStackResolver: resolver,
        };
        await applyCrossStackResolverToTask(task, subContext);
      }
    } else if (!stateProvider && taskNeeds.needsCrossStackResolver) {
      logger.warn(
        'Container Environment / Secrets entries contain Fn::ImportValue / Fn::GetStackOutput intrinsics. ' +
          'Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) to substitute them against deployed state.'
      );
    }

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

    // `--assume-task-role` branches: bare flag (boolean `true`) uses the
    // task definition's resolved `TaskRoleArn`; otherwise the user-supplied
    // ARN is used. The resolver emits a synth-time placeholder ARN
    // (`arn:aws:iam::${AWS::AccountId}:role/<LogicalId>`) when TaskRoleArn
    // references an inline same-stack IAM Role; we fill in the account
    // segment lazily via STS only when bare `--assume-task-role` is set,
    // so the STS round-trip does not fire on the common pass-through path.
    let assumedCredentials: RunEcsTaskOptions['taskCredentials'];
    let resolvedRoleArn: string | undefined;
    if (options.assumeTaskRole === true) {
      if (!task.taskRoleArn) {
        throw new Error(
          `--assume-task-role passed without an ARN but the task definition has no resolvable TaskRoleArn. ` +
            `Either the task definition does not set TaskRoleArn, or it points at a resource cdkd cannot resolve to an IAM Role at synth time. ` +
            `Pass the ARN explicitly: --assume-task-role <arn>`
        );
      }
      resolvedRoleArn = await resolvePlaceholderAccount(task.taskRoleArn, options.region);
      assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
    } else if (typeof options.assumeTaskRole === 'string') {
      resolvedRoleArn = options.assumeTaskRole;
      assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
    }

    // Issue #658: when `--assume-task-role` is NOT effective but
    // `--profile <p>` IS set, resolve the profile via the SDK's default
    // credential provider chain (SSO / IAM Identity Center / fromIni /
    // role-assumption) and forward the resulting `{AKID, SAK,
    // sessionToken?}` to the metadata-endpoints sidecar. Without this,
    // the sidecar starts inside a fresh container with no SSO config and
    // no `~/.aws/credentials`, so every user container that hits
    // `169.254.170.2/role/<role>` gets a credential-provider failure.
    // Same gap class as #654/#655, which shipped the equivalent forward
    // for `cdkd local start-api`'s Lambda container path.
    const sidecarCredentials = await resolveSidecarCredentials(options, assumedCredentials);

    const envOverrides = readEnvOverridesFile(options.envVars);

    const runOpts: RunEcsTaskOptions = {
      cluster: options.cluster,
      containerHost: options.containerHost,
      skipPull: options.pull === false,
      keepRunning: options.keepRunning,
      detach: options.detach,
    };
    if (envOverrides) runOpts.envOverrides = envOverrides;
    if (sidecarCredentials) runOpts.taskCredentials = sidecarCredentials;
    if (resolvedRoleArn) runOpts.taskRoleArn = resolvedRoleArn;
    if (options.platform) runOpts.platformOverride = options.platform;
    if (options.region) runOpts.region = options.region;
    if (options.ecrRoleArn) runOpts.ecrRoleArn = options.ecrRoleArn;

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
    if (stateProvider) stateProvider.dispose();
    if (!options.detach) await cleanup();
  }
}

/**
 * If `arn` contains the `${AWS::AccountId}` placeholder emitted by the
 * resolver for inline same-stack IAM Roles, substitute the live caller
 * account via STS `GetCallerIdentity`. Otherwise pass through unchanged.
 * Lazy: callers should only invoke this when the resolved ARN is actually
 * going to be used (i.e. on the bare `--assume-task-role` path).
 */
async function resolvePlaceholderAccount(arn: string, region: string | undefined): Promise<string> {
  if (!arn.includes(TASK_ROLE_ACCOUNT_PLACEHOLDER)) return arn;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const account = identity.Account;
    if (!account) {
      throw new Error(
        `--assume-task-role: GetCallerIdentity returned no Account; cannot resolve placeholder ARN '${arn}'. ` +
          `Pass the ARN explicitly: --assume-task-role <arn>`
      );
    }
    return arn.split(TASK_ROLE_ACCOUNT_PLACEHOLDER).join(account);
  } finally {
    sts.destroy();
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
 * Build the substitution context the ECS task resolver consumes (issue
 * #264). Returns `undefined` when no container's `Image` field needs
 * substitution — the resolver behaves as before in that case.
 *
 * Tier 1 (pseudo parameters) fires `sts:GetCallerIdentity` once for
 * `${AWS::AccountId}`; region / partition / URL suffix come from the CLI
 * (`--region` → env vars → synth-derived stack region). Tier 2 (state
 * load) routes through the active {@link LocalStateProvider} so both
 * `--from-state` and `--from-cfn-stack` produce the same downstream
 * context shape (issue #606).
 */
async function buildEcsImageResolutionContext(
  candidate: StackInfo | undefined,
  stateProvider: LocalStateProvider | undefined,
  options: LocalRunTaskOptions
): Promise<EcsImageResolutionContext | undefined> {
  const logger = getLogger();
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

  // Pseudo parameters are needed (a) by image Fn::Sub references to AWS::*,
  // and (b) by env / secret Fn::Join / Fn::Sub bodies when a state
  // provider is set — `ecs.Secret.fromSsmParameter` synthesizes a Fn::Join
  // that splices ${AWS::Partition} / ${AWS::Region} / ${AWS::AccountId}
  // around a Ref to the parameter. Issue #291.
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
      'Container Image references a same-stack AWS::ECR::Repository. Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) ' +
        'to substitute the deployed repository URI. Otherwise the resolver will surface its existing error.'
    );
  } else if (!stateProvider && needs.needsEnvOrSecretSubstitution) {
    logger.warn(
      'Container Environment / Secrets entries contain CloudFormation intrinsics (Ref / Fn::GetAtt / Fn::Sub / Fn::Join). ' +
        'Pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) to substitute them against deployed state. Without a state source these entries are dropped (per-key warnings will follow).'
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

/**
 * Issue #658: pick the credentials forwarded to the AWS-published
 * `amazon-ecs-local-container-endpoints` sidecar. Precedence:
 *   1. `--assume-task-role <arn>` (or bare `--assume-task-role` against
 *      a resolvable `TaskRoleArn`) → STS-assumed temp creds. Highest
 *      priority — when the user opted in to IAM emulation, those creds
 *      drive the sidecar regardless of `--profile`.
 *   2. `--profile <p>` → resolved via {@link resolveProfileCredentials}
 *      (the SDK's default credential provider chain — SSO / IAM
 *      Identity Center / fromIni / role-assumption). NEW in this PR.
 *   3. Neither set → `undefined`; the sidecar runs with its own
 *      default credential chain (typically empty inside a fresh
 *      container — user containers will get 4xx from the credentials
 *      endpoint, mimicking IAM-misconfigured prod).
 *
 * Extracted as an exported helper so a unit test can exercise every
 * branch without having to mock the full Synth + Docker + AWS pipeline
 * (the strategy PR #655 used for the Lambda container path).
 */
export async function resolveSidecarCredentials(
  options: { profile?: string },
  assumedCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined> {
  if (assumedCredentials) return assumedCredentials;
  if (options.profile) return resolveProfileCredentials(options.profile);
  return undefined;
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
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized ' +
          'registries (#455). Issues sts:AssumeRole via the default credential chain and uses the ' +
          'temporary credentials for ecr:GetAuthorizationToken + docker pull. Required when the ' +
          'caller does not have direct cross-account access to the target repository. ' +
          'Same-account / same-region pulls do not need this flag.'
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
    .addOption(
      new Option(
        '--from-state',
        'Read cdkd S3 state for the target stack and substitute Fn::Sub / Fn::GetAtt references to ' +
          'same-stack AWS::ECR::Repository resources with the deployed URI. ' +
          'Off by default — only the AWS pseudo-parameter tier (${AWS::AccountId} / ${AWS::Region}) ' +
          'is resolved without this flag.'
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
    .action(withErrorHandling(localRunTaskCommand));

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
