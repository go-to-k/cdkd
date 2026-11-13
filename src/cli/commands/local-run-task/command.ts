import { createCallerDynamicReferenceResolver } from '../../../local/dynamic-reference.js';
import { parseContextOptions, warnIfDeprecatedRegion } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { groupWorkloadsRoutedApart, UNNAMED_WORKLOAD } from 'cdk-local/internal';
import {
  activateLocalAwsAndRoleArn,
  getActiveWorkloadAwsWiring,
} from '../../../local/local-aws-wiring.js';
import { assertFlagRoleArn } from '../../../utils/role-arn.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { resolveApp } from '../../config-loader.js';
import { ensureDockerAvailable, flushStdio } from '../../../local/docker-runner.js';
import { resolveHostGatewayExtraHosts } from '../../../local/docker-version.js';
import { strandedProfileCredentialsNotice } from '../local-profile-credentials-file.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { foldRegionOption } from '../../region-options.js';
import {
  applyCrossStackResolverToTask,
  assertEcsTaskImagesResolvable,
  detectEcsImageResolutionNeeds,
  parseEcsTarget,
  resolveEcsTaskTarget,
} from '../../../local/ecs-task-resolver.js';
import {
  cleanupEcsRun,
  createEcsRunState,
  describeDetachedForwarders,
  runEcsTask,
  type EcsRunState,
  type RunEcsTaskOptions,
} from '../../../local/ecs-task-runner.js';
import { createLocalStateProvider } from '../local-state-source.js';
import type { LocalStateProvider } from '../../../local/local-state-provider.js';
import type { SubstitutionContext } from '../../../local/state-resolver.js';
import type { LocalRunTaskOptions } from './types.js';
import {
  assumeTaskRole,
  resolvePlaceholderAccount,
  taskRoleNameIsLogicalIdWarning,
} from './stack-account.js';
import {
  buildEcsImageResolutionContext,
  taskRoleRecordIsEmulatorSide,
  pickCandidateStack,
  resolveEcsConsumerRegion,
} from './image-context.js';
import { readEnvOverridesFile } from './env-overrides.js';
import {
  buildRunEcsTaskOptions,
  planTaskRoleCredentials,
  resolveTaskCredentialChannels,
} from './credentials.js';
import { resolveRunTaskImageOverride } from './image-override.js';

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
export async function localRunTaskCommand(
  target: string,
  options: LocalRunTaskOptions
): Promise<void> {
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
  //
  // Issue #3622: `foldRegionOption` folds the `AWS_REGION` /
  // `AWS_DEFAULT_REGION` env vars as well. Folding only the flag left the SDK
  // clients this command builds with NO region (the `--from-state` S3 client
  // when `--region` is absent, `applyRoleArnIfSet`'s STS client, the
  // `--profile` credential resolver) reading the raw env spelling through the
  // SDK's own region chain, and the synth subprocess inheriting it. The raw env
  // spelling is captured FIRST: the bootstrap-marker probe needs it, and after
  // the fold `process.env` holds only the canonical one.
  const rawEnvRegion = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
  if (rawEnvRegion !== undefined) options.rawEnvRegion = rawEnvRegion;
  foldRegionOption(options);
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
        const disposeCreds = async (): Promise<void> => {
          if (!channels?.profileCredsFile) return;
          try {
            await channels.profileCredsFile.dispose();
            // Gone now: a second ^C from here on (the log drain, the flush)
            // must not tell the user to delete a file that no longer exists.
            credsHostPath = undefined;
          } catch (err) {
            getLogger().debug(
              `Failed to remove profile credentials tmpdir ${channels.profileCredsFile.hostPath}: ${
                describeAwsFailure(err).detail
              }`
            );
          }
        };
        try {
          // The credentials go as soon as the containers are stopped, BEFORE
          // the bounded log drain (#4480): a second ^C during the drain
          // force-exits, and would otherwise strand them.
          await cleanupEcsRun(state, {
            keepRunning: options.keepRunning,
            afterContainersStopped: disposeCreds,
          });
        } catch (err) {
          getLogger().debug(`cleanup failed: ${describeAwsFailure(err).detail}`);
        }
        // Idempotent (`rm --force`); covers a `cleanupEcsRun` that threw first.
        await disposeCreds();
        // Every exit after this — a ^C's `process.exit(130)`, or `handleError`'s
        // — drops writes still queued on a pipe (async on macOS), which is
        // where the drained container logs just went (#4480).
        await flushStdio();
      })();
    }
    await cleanupPromise;
  };

  try {
    // Refuse a malformed or EMPTY explicit role-ARN flag before any AWS call,
    // docker probe or synthesis (issue #2348) -- the same check each send
    // applies, earlier. Neither value is trimmed: it is sent as typed.
    if (typeof options.assumeTaskRole === 'string') {
      assertFlagRoleArn('--assume-task-role', options.assumeTaskRole);
    }
    if (options.ecrRoleArn !== undefined) {
      assertFlagRoleArn('--ecr-role-arn', options.ecrRoleArn);
    }
    // BEFORE `--role-arn` and every AWS client: under `--aws-emulator` the
    // role hop, `--from-state`, `{{resolve:...}}` and `--from-cfn-stack` all
    // follow the emulator (`local-aws-wiring.ts`).
    await activateLocalAwsAndRoleArn(options);
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
      failedLookupsCheckedByCaller: true,
    };
    const { stacks, failedLookups } = await synthesizer.synthesize(synthOpts);

    // Issue #606: pick a LocalStateProvider for whichever flag the user
    // passed (--from-state OR --from-cfn-stack). Constructed BEFORE the
    // candidate-stack picker so the same provider drives both the
    // image-context state-load AND the post-pass cross-stack resolver
    // — preserves the single-load behavior from #264 / #454. Disposed
    // in the outer `finally` alongside container cleanup.
    const parsed = parseEcsTarget(target);
    const candidate = pickCandidateStack(parsed, target, stacks);
    // A failed context lookup blocks only the stack this runs (go-to-k/cdkd#5807).
    // Checked on the candidate, before any state read so an expired credential
    // reports the lookup; the target resolver below picks the same stack.
    refuseFailedLookups(candidate ? [candidate] : [], stacks, failedLookups);
    // AWS Emulator mixed mode: the base record follows the exceptions every
    // container shares (`Parameters`); a container whose own section excepts
    // differently is re-resolved below with its own (go-to-k/cdkd#6150).
    stateProvider = createLocalStateProvider(
      options,
      candidate?.stackName ?? '',
      candidate?.region,
      getActiveWorkloadAwsWiring()?.mixed ? { workload: UNNAMED_WORKLOAD } : {}
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
    await applyPerContainerNames(task, target, stacks, candidate, options, imageContext);
    // An uncovered same-stack ECR image that nothing can cover any more (no
    // `--image-override`, and no boot prompt: not a terminal, or
    // `--no-interactive-overrides`) refuses HERE, before an `--assume-task-role`
    // STS call or a credentials file. Otherwise the check after the override
    // pass below decides (go-to-k/cdkd#5768).
    const canPrompt =
      options.interactiveOverrides !== false &&
      Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!options.imageOverride?.length && !canPrompt) assertEcsTaskImagesResolvable(task);
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
        const dynamicRefs = createCallerDynamicReferenceResolver(options.profile);
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
          // Issue #2056: a producer output persisted as its `{{resolve:...}}`
          // token resolves against the producer's region at this boundary.
          // cdk-local passes the container the value is for (mixed mode:
          // routed by that container's own exceptions, go-to-k/cdkd#6150).
          resolveDynamicReferences: (value, producerRegion, workload) =>
            dynamicRefs.resolveString(value, {
              region: producerRegion,
              consumer: `Task ${task.taskDefinitionLogicalId} cross-stack env value`,
              workload,
              // Overrides apply later, at docker-run time, so none can skip this.
              overridable: false,
            }),
        };
        try {
          await applyCrossStackResolverToTask(task, subContext);
        } finally {
          dynamicRefs.dispose();
        }
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
    // ARN is used. When TaskRoleArn references an inline same-stack IAM Role
    // the resolver emits the state record's deployed ARN under a state source
    // (go-to-k/cdkd#6189), else a synth-time placeholder ARN
    // (`arn:aws:iam::${AWS::AccountId}:role/<LogicalId>`); we fill in the account
    // segment lazily via STS only when bare `--assume-task-role` is set,
    // so the STS round-trip does not fire on the common pass-through path.
    //
    // Under `--aws-emulator` the role is assumed in the emulator; in mixed
    // mode in real AWS, for the containers that keep an STS exception
    // (`planTaskRoleCredentials`, go-to-k/cdkd#6147).
    const envOverrides = readEnvOverridesFile(options.envVars);
    const roleRequested =
      options.assumeTaskRole === true || typeof options.assumeTaskRole === 'string';
    const plan = planTaskRoleCredentials(task.containers, envOverrides, roleRequested);
    if (plan.ignoredInMixedMode) {
      logger.warn(
        '--assume-task-role has no effect in AWS Emulator mixed mode unless a container marks STS ' +
          'as an exception (AWS_ENDPOINT_URL_STS="real-aws"): calls to the emulator are re-signed ' +
          "with the emulator's keys, so the role is not assumed."
      );
    }
    let assumedCredentials: RunEcsTaskOptions['taskCredentials'];
    let emulatorTaskCredentials: RunEcsTaskOptions['taskCredentials'];
    let resolvedRoleArn: string | undefined;
    const assumes = plan.assumeInRealAws || plan.assumeInEmulator;
    // A flag mixed mode ignores (warned above) needs no TaskRoleArn either.
    if (options.assumeTaskRole === true && !task.taskRoleArn && assumes) {
      throw new Error(
        `--assume-task-role passed without an ARN but the task definition has no resolvable TaskRoleArn. ` +
          `Either the task definition does not set TaskRoleArn, or it points at a resource cdkd cannot resolve to an IAM Role at synth time. ` +
          `Pass the ARN explicitly: --assume-task-role '<arn>'`
      );
    }
    const roleArnTemplate =
      options.assumeTaskRole === true
        ? task.taskRoleArn
        : typeof options.assumeTaskRole === 'string'
          ? options.assumeTaskRole
          : undefined;
    // At most one STS: the emulator's under `--aws-emulator`, real otherwise.
    if (roleArnTemplate !== undefined && assumes) {
      const realAws = plan.assumeInRealAws;
      // The deployed name came from no state record (go-to-k/cdkd#6189).
      if (options.assumeTaskRole === true && task.taskRoleUnresolved !== undefined) {
        const { logicalId, reason } = task.taskRoleUnresolved;
        logger.warn(
          taskRoleNameIsLogicalIdWarning(
            logicalId,
            !stateProvider
              ? 'no-state-source'
              : taskRoleRecordIsEmulatorSide()
                ? 'mixed-mode-emulator-iam'
                : reason === 'no-state'
                  ? 'state-not-read'
                  : reason
          )
        );
      }
      // The bare flag's placeholder account is asked of the same STS: the
      // emulator's account and the real one differ.
      resolvedRoleArn =
        options.assumeTaskRole === true
          ? await resolvePlaceholderAccount(roleArnTemplate, options, { realAws })
          : roleArnTemplate;
      const creds = await assumeTaskRole(resolvedRoleArn, options.region, { realAws });
      if (realAws) assumedCredentials = creds;
      else emulatorTaskCredentials = creds;
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
      emulatorTaskCredentials,
      callerIdentityNeeded: plan.callerIdentityNeeded,
    });

    const runOpts = buildRunEcsTaskOptions(options, channels, {
      ...(envOverrides !== undefined && { envOverrides }),
      ...(resolvedRoleArn !== undefined && { resolvedRoleArn }),
      ...(stateRecordRegion !== undefined && { stateRecordRegion }),
    });
    // Let task containers reach a server on the host (an `AWS_ENDPOINT_URL_*`
    // local endpoint / tunneled VPC resource) via `host.docker.internal`.
    // Resolved once at boot; merged into the runner's `--add-host` flag list
    // alongside any Cloud Map peer-discovery entries. Degrades to no mapping
    // on an old / unavailable daemon (never throws). Mirrors cdk-local #483.
    const hostGatewayExtraHosts = await resolveHostGatewayExtraHosts();
    if (hostGatewayExtraHosts.length > 0) runOpts.hostGatewayExtraHosts = hostGatewayExtraHosts;
    if (stateProvider) runOpts.stateSourceGiven = true;

    // go-to-k/cdkd#5768 — `--image-override`: rebuild a pinned
    // (deployed-registry) task-def image from a local Dockerfile and thread
    // the built tag into the run.
    const imageOverrideResult = await resolveRunTaskImageOverride({
      task,
      target,
      options,
      cwd: process.cwd(),
    });
    if (imageOverrideResult.imageOverrideByContainer) {
      runOpts.imageOverrideByContainer = imageOverrideResult.imageOverrideByContainer;
    }
    // A same-stack ECR image no override covered has no URI to pull: refuse it
    // before the task network or any container exists (and before the
    // "local edits will not take effect" warning, which would mislead).
    assertEcsTaskImagesResolvable(task, runOpts.imageOverrideByContainer);
    if (!imageOverrideResult.imageOverrideByContainer && imageOverrideResult.pinnedUncovered) {
      logger.warn(
        'Task definition image is pinned to a deployed registry; local source edits will not take ' +
          'effect. Pass --image-override <dockerfile> to rebuild it from local source.'
      );
    }

    let result: Awaited<ReturnType<typeof runEcsTask>>;
    try {
      result = await runEcsTask(task, runOpts, state);
    } catch (err) {
      // A ^C began the teardown while the runner was mid-step (it then throws
      // `EcsTaskInterruptedError`, or a docker call fails against what the
      // teardown removed): the SIGINT handler's cleanup removes what it
      // started and exits 130 (issue #4495).
      if (state.closing) return;
      throw err;
    }

    if (options.detach) {
      logger.info('Task containers started in detached mode; cdkd is exiting.');
      logger.info(
        `Use 'docker ps -a --filter network=${result.state.network?.networkName ?? '<network>'}' to inspect; ` +
          `tear down with 'docker rm -f' and 'docker network rm'.`
      );
      // Under a loopback AWS endpoint a joined task container is not on the
      // network itself (go-to-k/cdkd#6142), so name it.
      const forwarderNotice = describeDetachedForwarders(result.state);
      if (forwarderNotice) logger.info(forwarderNotice);
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
    // Removed only AFTER the teardown: a ^C during its bounded log drain then
    // re-enters the same single-flight cleanup (and a second one takes the
    // force-exit arm, which names the credentials file only while it still
    // exists) instead of Node's default exit, which would skip `docker rm -f`
    // and the dispose.
    if (sigintHandler) process.off('SIGINT', sigintHandler);
  }
}

/**
 * AWS Emulator mixed mode (go-to-k/cdkd#6150): give each container the names
 * ITS `"real-aws"` exceptions resolve to. The task was resolved against the
 * record of the exceptions every container shares (`Parameters`); a container
 * whose own section excepts a different set (a DynamoDB exception for one
 * container only, or a `null` clearing one) gets its `environment` and
 * `secrets` from a resolution against a record of its own set. Otherwise a
 * container excepting DynamoDB would get the EMULATOR's table name and address
 * it on real AWS, or the reverse. The image stays the base resolution's.
 *
 * The base context is reused: only the state record differs, loaded ONCE
 * per distinct excepted set, so the context's own lookups (STS for the pseudo
 * parameters) and their warnings are not repeated.
 */
export async function applyPerContainerNames(
  task: ReturnType<typeof resolveEcsTaskTarget>,
  target: string,
  stacks: Parameters<typeof resolveEcsTaskTarget>[1],
  candidate: Parameters<typeof buildEcsImageResolutionContext>[0],
  options: LocalRunTaskOptions,
  baseContext: Parameters<typeof resolveEcsTaskTarget>[2]
): Promise<void> {
  // No base context: the template needs no state, so no name differs by routing.
  if (!getActiveWorkloadAwsWiring()?.mixed || !candidate || !baseContext) return;
  // cdk-local's grouping (go-to-k/cdk-local#905): the containers whose own
  // section routes a different set than `UNNAMED_WORKLOAD`, by that set.
  const groups = groupWorkloadsRoutedApart(task.containers, (c) => ({ containerName: c.name }));
  for (const group of groups) {
    const names = group.items.map((c) => c.name);
    const provider = createLocalStateProvider(options, candidate.stackName, candidate.region, {
      workload: group.workload,
    });
    if (!provider) continue;
    try {
      const loaded = await provider.load(candidate.stackName, candidate.region);
      if (!loaded) continue;
      const own = resolveEcsTaskTarget(target, stacks, {
        ...baseContext,
        stateResources: loaded.resources,
      });
      for (const name of names) {
        const mine = own.containers.find((c) => c.name === name);
        const into = task.containers.find((c) => c.name === name);
        if (!mine || !into) continue;
        into.environment = mine.environment;
        into.secrets = mine.secrets;
      }
    } finally {
      provider.dispose();
    }
  }
}
