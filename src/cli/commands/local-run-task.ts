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
  parseStackRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS } from '../../utils/display-safe.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { ensureDockerAvailable } from '../../local/docker-runner.js';
import { resolveHostGatewayExtraHosts } from '../../local/docker-version.js';
import { resolveProfileCredentials } from './local-start-api.js';
import {
  strandedProfileCredentialsNotice,
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from './local-profile-credentials-file.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
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
import { loadBootstrapContainerRepo } from './local-state-loader.js';
import { createLocalStateProvider } from './local-state-source.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';
import type { SubstitutionContext } from '../../local/state-resolver.js';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';

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
   * authenticate against the target ECR repository. A same-account pull in
   * ANY region does not need this flag — `pullEcrImage` builds its ECR client
   * for the image URI's own region, so crossing a region costs nothing extra
   * (issue #2536). Mirrors `cdkd local invoke --ecr-role-arn`.
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
   * deployed CloudFormation stack via `ListStackResources` instead
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
  /**
   * The user's UNFOLDED `--stack-region` spelling, captured at handler entry
   * before the fold above it (issue #1836 round 3). Consumed by exactly TWO
   * things in `local-state-loader.ts`, both of which need a spelling the fold
   * has destroyed: the state-record match in `loadStateForStack`, which resolves
   * an exactly-spelled region in preference to a case-variant record, and the
   * raw marker-key fallback probe in `loadBootstrapContainerRepo`, which this
   * file feeds from `options.rawStackRegion` further down (the `cdkd bootstrap`
   * WRITE side does not fold, so a canonical-only read would miss the
   * `cdkd-bootstrap/{RAW}.json` key an upper-cased bootstrap wrote). It never
   * reaches an SDK client or an endpoint. This differs from the three sibling
   * commands' copies of this comment, which say ONLY the record match: they do
   * not call `loadBootstrapContainerRepo` at all.
   */
  rawStackRegion?: string;
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
  // Issue #1795: fold `--region` ONCE, at the boundary, so every downstream
  // consumer sees the canonical spelling — the SDK clients this file builds
  // (`applyRoleArnIfSet` / `assumeTaskRole` / `resolvePlaceholderAccount` /
  // the bootstrap-marker read) and the ones `ecs-task-runner` builds further
  // down (`pullEcrImage`, and `ecs-secrets-resolver`'s SecretsManager / SSM
  // clients). AWS SDK endpoint resolution is case-sensitive, so a raw
  // `--region CN-NORTH-1` reached the COMMERCIAL endpoint at every one.
  if (options.region !== undefined) options.region = canonicalizeRegion(options.region);
  // Issue #1836: `--stack-region` needs the same fold at the same point — its
  // raw value is COMPARED against a state record's region and is forwarded to
  // cdk-local as the CFn client's region, both case-SENSITIVE. The RAW spelling
  // is captured first so the state-record match can honor an exactly-spelled
  // region — see the fuller rationale on the identical statement in
  // `local-invoke.ts`.
  if (options.stackRegion !== undefined) {
    options.rawStackRegion = options.stackRegion;
    options.stackRegion = canonicalizeRegion(options.stackRegion);
  }

  const state: EcsRunState = createEcsRunState();
  let sigintHandler: (() => void) | undefined;
  let sigintCount = 0;
  // Set only once the detach path has actually handed the containers off.
  let detachedSuccessfully = false;
  // Issue #606: the active state provider (--from-state / --from-cfn-stack).
  // Hoisted so the outer `finally` can dispose it even if the body
  // throws between provider creation and the normal exit path.
  let stateProvider: LocalStateProvider | undefined;
  // ECS analogue of PR #670: synthesized AWS shared credentials file
  // (one INI section) bind-mounted into every user container so
  // handlers using `fromIni({ profile })` resolve to the same creds.
  // Disposed in the cleanup chain below.
  //
  // ONE binding for BOTH consumers -- the docker mount and the dispose -- rather
  // than a second `profileCredsFile` local copied out of it. The copy was an
  // assignment nothing executed: `local-run-task.test.ts` covers only the
  // Commander surface, so mutating it to `undefined` left 161 tests green while
  // a tmpdir holding a plaintext AWS credentials file survived every run
  // (go-to-k/cdkd#3390 round 4, on go-to-k/cdkd#3394). With one binding the
  // mount side is COMPILER-enforced -- `buildRunEcsTaskOptions` takes the
  // non-optional shape, so emptying this cannot typecheck -- and the dispose
  // reads the same object rather than a copy that can drift from it.
  let channels: Awaited<ReturnType<typeof resolveTaskCredentialChannels>> | undefined;
  // The credentials tmpdir's path, assigned the INSTANT it exists rather than
  // when `channels` resolves (go-to-k/cdkd#3435 review).
  // `writeProfileCredentialsFile` does `mkdtemp` and then `await writeFile`, and
  // a double-`^C` inside that await force-exits with `channels` still
  // `undefined` -- so reading the path off `channels` alone left the
  // stranded-credentials notice naming nothing for exactly the window in which
  // the directory already exists. Assignment only: this runs inside the writer,
  // where a throw would strand the dir. Cleared again by `onDirRemoved` when a
  // failed write took the directory with it, so the notice never names a path
  // that no longer exists.
  let credsHostPath: string | undefined;

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
        if (channels?.profileCredsFile) {
          try {
            await channels.profileCredsFile.dispose();
          } catch (err) {
            getLogger().debug(
              `Failed to remove profile credentials tmpdir ${channels.profileCredsFile.hostPath}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
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

    logger.info(synthesisStatusMessage(appCmd, 'Synthesizing CDK app...'));
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
    const { context: imageContext, stateRecordRegion } = await buildEcsImageResolutionContext(
      candidate,
      stateProvider,
      options
    );
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
      const consumerRegion = resolveEcsConsumerRegion(
        stateRecordRegion,
        options,
        task.stack.region
      );
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
        // `process.exit` runs no `finally` and awaits nothing, so `cleanup()`
        // never fires here and the mode-0600 credentials tmpdir survives with
        // live AWS credentials in it (issue go-to-k/cdkd#3410). The message used
        // to say only "container cleanup skipped", which names the containers an
        // operator can already see in `docker ps` and says nothing about the one
        // artifact nothing else will ever report. `strandedProfileCredentialsNotice`
        // is the shared remedy sentence -- its doc carries why the remedy is to
        // NAME the path rather than `rmSync` it.
        //
        // `process.stderr.write` rather than the logger, and UNCHANGED from
        // before this issue -- the sink is not something go-to-k/cdkd#3410
        // decided. Stated as the local fact rather than as a rule, because the
        // sibling arm in `local-start-api.ts` uses `logger.warn` at the same
        // point and is equally correct: cdkd's logger writes synchronously, so
        // neither sink is at risk here. An earlier revision of this comment
        // asserted a buffering hazard that would have condemned the sibling
        // (go-to-k/cdkd#3435 review).
        //
        // Read off `credsHostPath`, NOT off `channels`. `channels` is assigned
        // only when `resolveTaskCredentialChannels` RESOLVES, and that call
        // contains an `await writeFile` -- so a double-`^C` inside it would find
        // `channels === undefined` while the mode-0600 directory already exists,
        // and the notice would name nothing for precisely the window this issue
        // is about (go-to-k/cdkd#3435 review; the comment that used to sit here
        // claimed the opposite). The early binding is set by `onDirCreated` at
        // `mkdtemp` time and stays `undefined` for a run that passed no
        // `--profile`, which is the case that must print nothing.
        const stranded = strandedProfileCredentialsNotice(credsHostPath);
        process.stderr.write(
          `Force-exit on second ^C; container cleanup skipped.${stranded ? ` ${stranded}` : ''}\n`
        );
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

    // Both credential channels this task gets, resolved together — see
    // `resolveTaskCredentialChannels` for why they are ONE call (issue
    // go-to-k/cdkd#3378).
    channels = await resolveTaskCredentialChannels(options, assumedCredentials, {
      onDirCreated: (hostPath) => {
        credsHostPath = hostPath;
      },
      onDirRemoved: () => {
        credsHostPath = undefined;
      },
    });

    const envOverrides = readEnvOverridesFile(options.envVars);

    const runOpts = buildRunEcsTaskOptions(options, channels, {
      ...(envOverrides !== undefined && { envOverrides }),
      ...(resolvedRoleArn !== undefined && { resolvedRoleArn }),
    });
    // Let task containers reach a server on the host (an `AWS_ENDPOINT_URL_*`
    // local endpoint / tunneled VPC resource) via `host.docker.internal`.
    // Resolved once at boot; merged into the runner's `--add-host` flag list
    // alongside any Cloud Map peer-discovery entries. Degrades to no mapping
    // on an old / unavailable daemon (never throws). Mirrors cdk-local #483.
    const hostGatewayExtraHosts = await resolveHostGatewayExtraHosts();
    if (hostGatewayExtraHosts.length > 0) runOpts.hostGatewayExtraHosts = hostGatewayExtraHosts;

    const result = await runEcsTask(task, runOpts, state);

    if (options.detach) {
      logger.info('Task containers started in detached mode; cdkd is exiting.');
      logger.info(
        `Use 'docker ps -a --filter network=${result.state.network?.networkName ?? '<network>'}' to inspect; ` +
          `tear down with 'docker rm -f' and 'docker network rm'.`
      );
      // Detach mode skips cleanup — the caller manages container lifecycle —
      // and that includes the profile credentials file, which is
      // mode-0600 but holds LIVE AWS credentials and is bind-mounted into the
      // containers that outlive this process. It cannot be disposed here for
      // exactly that reason, so NAME it: an operator who is not told the path
      // has no way to find it, and nothing else ever will
      // (go-to-k/cdkd#3390 security review). The `displayIdent` pass moved INTO
      // `strandedProfileCredentialsNotice` in go-to-k/cdkd#3410, so the rule is
      // stated once for all three sites rather than at each — the path is
      // cdkd's own `mkdtemp` output rather than user input, so sanitization is
      // the identity on it, but the rule belongs to the surface rather than to
      // the value.
      //
      // The sentence moved to `strandedProfileCredentialsNotice` in
      // go-to-k/cdkd#3410, which gave the two FORCE-EXIT arms the same remedy:
      // three hand-spelled copies that agree today is how one of them later
      // stops matching what an operator has learned to look for. The cause
      // clause stays here, because it is what differs per site.
      const detachedNotice = strandedProfileCredentialsNotice(channels.profileCredsFile?.hostPath);
      if (detachedNotice) {
        logger.info(`Detached mode leaves the mounted credentials file behind. ${detachedNotice}`);
      }
      // Only a REACHED detach hands the containers off; see the `finally`.
      detachedSuccessfully = true;
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
    // `detachedSuccessfully`, not `options.detach` (go-to-k/cdkd#3390 round 2).
    // The flag is what `--detach` MEANS here -- the containers were handed off
    // and outlive this process, so tearing down their network and unlinking the
    // credentials file they have mounted would break them. A detach run that
    // THREW before `runEcsTask` returned handed nothing off: the old condition
    // skipped cleanup for it anyway, stranding a 0600 file of live AWS
    // credentials in `/tmp` that nothing would ever remove, and no message named
    // it either because the notice above is on the success path too.
    if (!detachedSuccessfully) await cleanup();
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
  // `ignoreAssumedRole` -- this resolves the account filled into a task-role ARN that is then assumed FOR the container,
  // so it must be the caller's own identity, never a `--role-arn` assumed
  // for cdkd's own calls. See that option's JSDoc.
  const sts = new STSClient({
    ...awsClientDefaults({ ignoreAssumedRole: true }),
    ...(region && { region }),
  });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const account = identity.Account;
    if (!account) {
      throw new Error(
        `--assume-task-role: GetCallerIdentity returned no Account; cannot resolve placeholder ARN ${displayIdent(arn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}. ` +
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
  // `ignoreAssumedRole` -- this resolves the task role's credentials, served to the container by the metadata sidecar,
  // so it must be the caller's own identity, never a `--role-arn` assumed
  // for cdkd's own calls. See that option's JSDoc.
  const sts = new STSClient({
    ...awsClientDefaults({ ignoreAssumedRole: true }),
    ...(region && { region }),
  });
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
      throw new Error(
        `AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) returned no usable credentials.`
      );
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
 * Region the cross-stack resolver is scoped to for `cdkd local run-task`
 * (issue #1836).
 *
 * This value does THREE things (round 3 said TWO and was wrong — corrected in
 * round 4), and the first is why the state record's own spelling outranks the env
 * chain:
 *
 * 1. it becomes the exports-index KEY `cdkd/_index/{region}/exports.json`;
 * 2. it is the same-region filter of the index-miss per-stack scan; and
 * 3. via `SubstitutionContext.consumerRegion`, it is cdk-local's DEFAULT producer
 *    region for an `Fn::GetStackOutput` that carries no explicit `Region` — i.e.
 *    it becomes the `cdkd/{producer}/{region}/state.json` key that intrinsic
 *    reads.
 *
 * All three land in `buildCrossStackResolver` (`local-state-loader.ts`), whose
 * `resolveImport` scan (2) and — since round 4 — `resolveGetStackOutput` (3) fold
 * BOTH sides for the comparison / recovery, while (1) is deliberately raw.
 *
 * `local invoke` / `local invoke-agentcore` both pass `loaded.region` there; this
 * command passed a FOLDED env-chain value instead, so the two commands keyed one
 * index differently — and a key the state records do not spell makes
 * `ExportIndexStore`'s rebuild filter match zero refs and PUT an EMPTY index,
 * permanently degrading every `Fn::ImportValue` to the O(N) scan. Keyed by a
 * record's spelling the filter always matches.
 *
 * The env-chain arm remains for the case where no state record was loaded at all
 * (nothing in the task needed one), and it stays FOLDED for the reason the rest
 * of this file folds: both env-var links escape the handler-entry `--region`
 * fold, and a raw upper-cased spelling reaches an S3 key and an SDK client.
 *
 * @internal exported for unit tests.
 */
export function resolveEcsConsumerRegion(
  stateRecordRegion: string | undefined,
  options: Pick<LocalRunTaskOptions, 'region'>,
  synthRegion: string | undefined
): string {
  if (stateRecordRegion) return stateRecordRegion;
  return canonicalizeRegion(
    // Issue #1836 round 4: `||`, not `??`, on the FLAG link. Round 3's `??` let
    // `--region ''` beat `AWS_REGION` and yield `''` — which would then be the
    // exports-index key AND the bucket-resolution region, contradicting the
    // blank-is-absent rule this branch adopted at the four client boundaries. The
    // two env links keep `??` for parity with the sibling chains in this file
    // (an exported-but-empty `AWS_REGION` is not a shape this branch changed),
    // and `synthRegion` keeps `??` because a blank synth region is not user input.
    (options.region || process.env['AWS_REGION']) ??
      process.env['AWS_DEFAULT_REGION'] ??
      synthRegion ??
      'us-east-1'
  );
}

/**
 * Build the substitution context the ECS task resolver consumes (issue
 * #264), plus the region of the state record it loaded (if any — issue #1836;
 * see {@link resolveEcsConsumerRegion} for what reads it). `context` is
 * `undefined` when no container's `Image` field needs substitution — the
 * resolver behaves as before in that case.
 *
 * Tier 1 (pseudo parameters) fires `sts:GetCallerIdentity` once for
 * `${AWS::AccountId}`; region / partition / URL suffix come from the CLI
 * (`--region` → env vars → synth-derived stack region). Tier 2 (state
 * load) routes through the active {@link LocalStateProvider} so both
 * `--from-state` and `--from-cfn-stack` produce the same downstream
 * context shape (issue #606).
 *
 * The resolved region is CANONICALIZED (issue #1795) before anything consumes
 * it. That covers all four sources — `--region`, both env vars, and the
 * synth-derived stack region — and all three consumers: the STS client built
 * for `${AWS::AccountId}`, the `${AWS::URLSuffix}` / `${AWS::Partition}`
 * derivation, and the `${AWS::Region}` value itself.
 *
 * @internal exported for unit tests.
 */
export async function buildEcsImageResolutionContext(
  candidate: StackInfo | undefined,
  stateProvider: LocalStateProvider | undefined,
  options: LocalRunTaskOptions
): Promise<{ context?: EcsImageResolutionContext; stateRecordRegion?: string }> {
  const logger = getLogger();
  if (!candidate) return {};

  const needs = detectEcsImageResolutionNeeds(candidate);
  if (
    !needs.needsPseudoParameters &&
    !needs.needsStateResources &&
    !needs.needsEnvOrSecretSubstitution &&
    !needs.needsAssetRepoMarker
  ) {
    return {};
  }

  const ctx: EcsImageResolutionContext = {};
  // Region of the state record the load below resolved to, if any. Reported
  // separately rather than stashed on `ctx`: `EcsImageResolutionContext` is
  // cdk-local's `ImageResolutionContext` plus one cdkd field, and the region is
  // not part of the resolver's contract — it only scopes the cross-stack
  // resolver the caller builds afterwards (issue #1836).
  let stateRecordRegion: string | undefined;

  // Pseudo parameters are needed (a) by image Fn::Sub references to AWS::*,
  // and (b) by env / secret Fn::Join / Fn::Sub bodies when a state
  // provider is set — `ecs.Secret.fromSsmParameter` synthesizes a Fn::Join
  // that splices ${AWS::Partition} / ${AWS::Region} / ${AWS::AccountId}
  // around a Ref to the parameter. Issue #291.
  const wantsPseudoForEnvOrSecret = !!stateProvider && needs.needsEnvOrSecretSubstitution;
  if (needs.needsPseudoParameters || wantsPseudoForEnvOrSecret) {
    const region = canonicalizeRegion(
      options.region ??
        process.env['AWS_REGION'] ??
        process.env['AWS_DEFAULT_REGION'] ??
        candidate.region
    );
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
      stateRecordRegion = loaded.region;
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

  // Issue #1025: a container Image targets an ECR repo whose name does not
  // match the conventional container-assets shapes. When the stack was
  // deployed via cdkd (`--from-state`), the region may have been
  // bootstrapped with `cdkd bootstrap --container-repo <name>` — read the
  // bootstrap marker (best-effort, never fails the run) so the classifier
  // can recognize images in the custom-named repo as cdk assets and take
  // the local cdk.out-build fast path instead of an ECR pull. Gated on
  // `--from-state` only: `--from-cfn-stack` stacks were deployed via
  // CloudFormation, whose asset repos use conventional names the regex
  // already matches.
  if (needs.needsAssetRepoMarker && options.fromState) {
    const containerRepo = await loadBootstrapContainerRepo(candidate.region, {
      statePrefix: options.statePrefix,
      ...(options.stackRegion !== undefined && { stackRegion: options.stackRegion }),
      // Issue #1836: the raw spelling too, so the marker-key fallback probe can
      // reach the key an upper-cased `cdkd bootstrap` wrote (see
      // `loadBootstrapContainerRepo`'s `rawRegion` note).
      ...(options.rawStackRegion !== undefined && { rawStackRegion: options.rawStackRegion }),
      ...(options.stateBucket !== undefined && { stateBucket: options.stateBucket }),
      ...(options.region !== undefined && { region: options.region }),
      ...(options.profile !== undefined && { profile: options.profile }),
      logPrefix: '--from-state',
    });
    if (containerRepo !== undefined) {
      ctx.cdkAssetContainerRepo = containerRepo;
    }
  }

  return { context: ctx, ...(stateRecordRegion !== undefined && { stateRecordRegion }) };
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
  // `ignoreAssumedRole` -- this resolves the `${AWS::AccountId}` the emulated task sees,
  // so it must be the caller's own identity, never a `--role-arn` assumed
  // for cdkd's own calls. See that option's JSDoc.
  const sts = new STSClient({
    ...awsClientDefaults({ ignoreAssumedRole: true }),
    ...(region && { region }),
  });
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

/**
 * Resolve BOTH credential channels a locally-run ECS task receives, and decide
 * whether the second one exists at all.
 *
 * 1. `sidecarCredentials` — what the AWS-published
 *    `amazon-ecs-local-container-endpoints` sidecar serves at
 *    `169.254.170.2/role/<role>`; {@link resolveSidecarCredentials} owns the
 *    precedence (issue #658).
 * 2. `profileCredsFile` — the ECS analogue of PR #670 (Lambda-container
 *    fix-back finding #1). When `--profile <p>` is set AND `--assume-task-role`
 *    did NOT produce credentials for this task, a host-side AWS shared
 *    credentials file is written under `[<options.profile>]` and bind-mounted
 *    read-only into every user container, so handler code calling
 *    `fromIni({ profile: '<options.profile>' })` resolves to the same creds the
 *    sidecar serves. Without it the SDK looks for `[<options.profile>]` in
 *    `~/.aws/credentials` INSIDE the container and fails.
 *
 *    Gating on `!assumedCredentials` preserves the documented precedence
 *    (assume-task-role > profile-file > sidecar): when `--assume-task-role`
 *    won, the sidecar's `/role/<arn>` endpoint already serves the assumed creds
 *    and the file's env vars must NOT override them.
 *
 * ONE helper rather than two, and that is the substance of issue
 * go-to-k/cdkd#3378 rather than a tidying choice. Both of these lived inline in
 * `localRunTaskCommand`'s body, which meant the gate's annotation below was
 * fenced only for EXISTING (`local-surface-env-identity.test.ts` checks that an
 * annotation is there and carries a reason — it cannot check that the reason is
 * TRUE). And the reason is not a property of the `if` at all: it is a property
 * of the COMPOSITION, that `sidecarCredentials` on the `!assumedCredentials`
 * path can only have come from {@link resolveSidecarCredentials}'s `--profile`
 * arm. Extracting the three-line gate ALONE would have re-tested the same three
 * booleans and proved nothing; a test over this helper writes a real file and
 * can read the bytes back. `resolveSidecarCredentials`'s own doc already set
 * the precedent for the seam over a command-level harness — that harness would
 * have to mock the whole Synth + Docker + AWS pipeline, and a mock is exactly
 * what cannot answer "which identity's bytes landed in the file".
 *
 * cdkd-local-env-identity: the `!assumedCredentials` gate means
 * `resolveSidecarCredentials` reached its `--profile` arm, so this is
 * `resolveProfileCredentials` through
 * `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own chain,
 * never the `--role-arn` role — and never an `--assume-task-role` STS result,
 * which wins earlier and is served by the metadata sidecar instead.
 */
export async function resolveTaskCredentialChannels(
  options: { profile?: string },
  assumedCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined,
  /**
   * Forwarded to `writeProfileCredentialsFile` (go-to-k/cdkd#3435 review); its
   * own doc carries why the RETURN VALUE is the wrong moment for a caller that
   * has to survive a signal.
   */
  opts?: {
    onDirCreated?: (hostPath: string) => void;
    onDirRemoved?: (hostPath: string) => void;
  }
): Promise<{
  sidecarCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined;
  profileCredsFile: ProfileCredentialsFile | undefined;
}> {
  const sidecarCredentials = await resolveSidecarCredentials(options, assumedCredentials);
  if (options.profile && sidecarCredentials && !assumedCredentials) {
    return {
      sidecarCredentials,
      // cdkd-local-env-identity: the `!assumedCredentials` gate above means
      // `resolveSidecarCredentials` reached its `--profile` arm, so these bytes
      // are `resolveProfileCredentials` through
      // `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own
      // chain, never the `--role-arn` role — and never an `--assume-task-role`
      // STS result, which wins earlier and is served by the metadata sidecar
      // instead. The doc comment above carries why that reasoning needed a
      // SEAM to become checkable (go-to-k/cdkd#3378).
      profileCredsFile: await writeProfileCredentialsFile(
        options.profile,
        sidecarCredentials,
        opts
      ),
    };
  }
  return { sidecarCredentials, profileCredsFile: undefined };
}

/**
 * Build the `RunEcsTaskOptions` bag from the options and the resolved credential
 * channels.
 *
 * Extracted for the WIRING, which is the half
 * {@link resolveTaskCredentialChannels} could not cover (go-to-k/cdkd#3390 round
 * 2, on go-to-k/cdkd#3394). That helper decides WHETHER a credentials file
 * exists and whose bytes are in it; this one decides whether the answer reaches
 * the runner at all. Between them sat a single assignment, and mutating it to
 * `undefined` left 114 tests green across five files: no file is bind-mounted,
 * so every handler calling `fromIni({ profile })` inside the task container
 * fails -- the exact defect PR go-to-k/cdkd#670 shipped this path to fix. "A
 * probed callee says nothing about its WIRING" is the rule, and this is the
 * seam that lets a unit test say something about it.
 *
 * PURE, and it takes the whole `channels` object rather than a pre-destructured
 * file so the test subject is the same value the resolver returns -- a helper
 * taking `profileCredsFile` alone would move the untested assignment rather
 * than remove it.
 *
 * The file is COPIED field by field rather than passed through: `dispose` stays
 * with the command, which owns the lifetime, and `RunEcsTaskOptions` deliberately
 * declares only the three fields the runner mounts with.
 */
export function buildRunEcsTaskOptions(
  options: Pick<
    LocalRunTaskOptions,
    | 'cluster'
    | 'containerHost'
    | 'pull'
    | 'keepRunning'
    | 'detach'
    | 'platform'
    | 'region'
    | 'ecrRoleArn'
  >,
  // Derived from the producer rather than re-spelled: the two must agree, and a
  // structural copy is how they would come to disagree silently
  // (go-to-k/cdkd#3390 round 3).
  channels: Awaited<ReturnType<typeof resolveTaskCredentialChannels>>,
  extra: { envOverrides?: RunEcsTaskOptions['envOverrides']; resolvedRoleArn?: string } = {}
): RunEcsTaskOptions {
  const runOpts: RunEcsTaskOptions = {
    cluster: options.cluster,
    containerHost: options.containerHost,
    skipPull: options.pull === false,
    keepRunning: options.keepRunning,
    detach: options.detach,
  };
  if (extra.envOverrides) runOpts.envOverrides = extra.envOverrides;
  if (channels.sidecarCredentials) runOpts.taskCredentials = channels.sidecarCredentials;
  if (extra.resolvedRoleArn) runOpts.taskRoleArn = extra.resolvedRoleArn;
  if (options.platform) runOpts.platformOverride = options.platform;
  if (options.region) runOpts.region = options.region;
  if (options.ecrRoleArn) runOpts.ecrRoleArn = options.ecrRoleArn;
  if (channels.profileCredsFile) {
    runOpts.profileCredentialsFile = {
      hostPath: channels.profileCredsFile.hostPath,
      containerPath: channels.profileCredsFile.containerPath,
      profileName: channels.profileCredsFile.profileName,
    };
  }
  return runOpts;
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
          'A same-account pull in ANY region does not need this flag: the ECR client is built ' +
          "for the image URI's own region, so crossing a region costs nothing extra (issue #2536)."
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
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in container env vars / secrets / image URIs with the deployed physical IDs / exports. ' +
          'Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). ' +
          'Bare form uses the cdkd stack name; pass an explicit value when the CFn stack name differs. ' +
          'Mutually exclusive with --from-state. Fn::GetAtt is warn-and-dropped in v1 (CFn ListStackResources does not return per-attribute values).'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-state when the same stack name has state in multiple regions, ' +
          'and with --from-cfn-stack as the CFn client region (cdkd does not have a separate --cfn-stack-region flag).'
      ).argParser(parseStackRegion)
    )
    .action(withErrorHandling(localRunTaskCommand));

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
