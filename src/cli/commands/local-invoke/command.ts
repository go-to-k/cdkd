import { rmSync } from 'node:fs';
import { parseContextOptions, warnIfDeprecatedRegion } from '../../options.js';
import { getLogger, reserveStdoutForPayload } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  activateLocalAwsAndRoleArn,
  profileCredentialsForWorkload,
  warnAwsEmulatorStateSourceHint,
} from '../../../local/local-aws-wiring.js';
import { assertFlagRoleArn, explicitRoleArnOrThrow } from '../../../utils/role-arn.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { resolveApp } from '../../config-loader.js';
import { readCdkPathOrUndefined } from '../../cdk-path.js';
import { createLocalStateProvider } from '../local-state-source.js';
import {
  resolveLambdaTarget,
  type ResolvedImageLambda,
  type ResolvedLambda,
} from '../../../local/lambda-resolver.js';
import { resolveEnvVars } from '../../../local/env-resolver.js';
import {
  substituteEnvVarsFromStateAsync,
  type StateEnvSubstitutionAudit,
  type SubstitutionContext,
} from '../../../local/state-resolver.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { foldRegionOption } from '../../region-options.js';
import {
  ensureDockerAvailable,
  flushStdio,
  followContainerLogs,
  killAndDrainContainerLogs,
  pickFreePort,
  removeContainer,
  runDetached,
  type ContainerLogStream,
} from '../../../local/docker-runner.js';
import { resolveHostGatewayExtraHosts } from '../../../local/docker-version.js';
import {
  architectureToPlatform,
  buildContainerImage,
} from '../../../local/docker-image-builder.js';
import { pullEcrImage, parseEcrUri } from '../../../local/ecr-puller.js';
import { invokeRie, waitForRieReady } from '../../../local/rie-client.js';
import { resolveRieWrap } from '../../../local/rie-mount.js';
import { singleFlight } from '../../../utils/single-flight.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from '../local-profile-credentials-file.js';
import type { StackState } from '../../../types/state.js';
import { resolveProfileCredentials } from '../local-start-api.js';
import {
  type DynamicReferenceResolver,
  firstUsableRegion,
  keysNotFromTemplate,
  keysOverriddenBy,
  resolveDynamicReferencesInEnv,
  withoutKeys,
} from 'cdk-local/internal';
import { createCallerDynamicReferenceResolver } from '../../../local/dynamic-reference.js';
import { applyLambdaCredentialEnv } from './credentials.js';
import { readEvent } from './event.js';
import { maybeSuggestAssumeRole, resolveBareAssumeRoleFromState } from './execution-role.js';
import {
  type ImagePlan,
  resolveLocalBuildPlan,
  resolveTmpfsForLambda,
  resolveZipImagePlan,
} from './image-plan.js';
import {
  envHasCrossStackIntrinsic,
  envHasIntrinsicValue,
  getTemplateEnv,
  readEnvOverridesFile,
  resolvePseudoParametersForInvoke,
} from './template-env.js';
import { type LocalInvokeOptions } from './types.js';

/**
 * `cdkd local invoke <target>` — run a Lambda function locally inside a
 * Docker container that bundles the AWS Lambda Runtime Interface
 * Emulator (RIE). Modeled on `sam local invoke` but reusing cdkd's
 * synthesis / asset / construct-path plumbing.
 *
 * Supports every current AWS Lambda runtime (Node.js, Python, Ruby,
 * Java, .NET, and the OS-only `provided.al2` / `provided.al2023`) — see
 * `src/local/runtime-image.ts` for the canonical supported set. Docker
 * is required. Literal env vars pass through; intrinsic-valued env vars
 * require `--from-state` to substitute deployed physical IDs /
 * attributes. See [docs/cli-reference.md](../../../docs/cli-reference.md)
 * for the full surface and out-of-scope items.
 */
export async function localInvokeCommand(
  target: string,
  options: LocalInvokeOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Issue #2410: on `cdkd local invoke`, stdout MEANS "the function's
  // response payload" (the single `process.stdout.write(result.raw)` at the
  // end of the run). Reserved UNCONDITIONALLY and at command entry — there is
  // no `--json` flag to key off, and every status line below (`Target: ...`,
  // `Starting container ...`, plus the synth chatter `app-executor.ts`
  // re-emits at INFO) precedes the payload on the same stream otherwise, so
  // `cdkd local invoke MyStack/Fn | jq` corrupts on a DEFAULT run. `sam local
  // invoke` routes its status lines to stderr for exactly this reason.
  //
  // Lines are MOVED, not suppressed. Three writers that bypass cdkd's own
  // call sites are CLOSED by this same reservation. cdk-local's OWN
  // `ConsoleLogger` (the `Building container image (platform=...)` line every
  // re-exported shim such as `buildContainerImage` / `buildAgentCoreCodeImage`
  // / `downloadAndExtractS3Bundle` emits) hands each line to cdkd's logger
  // through the embed config `createLocalCommand` installs
  // ([#2429](https://github.com/go-to-k/cdkd/issues/2429)), and two raw
  // writers consult the reservation directly: `docker pull` progress under
  // `runDockerForeground` (`docker-cmd/spawn.ts` redirects that child's fd 1
  // to fd 2), and the CONTAINER's own stdout, piped in by `followContainerLogs`
  // (`src/local/docker-runner.ts`), where the RIE puts START/END/REPORT and
  // every handler log line — it now joins the container's stderr on ours
  // ([#2419](https://github.com/go-to-k/cdkd/issues/2419)). Do not re-file
  // either.
  reserveStdoutForPayload();

  warnIfDeprecatedRegion(options);
  // Issue #1795: fold `--region` ONCE, at the boundary, so every downstream
  // SDK client sees the canonical spelling (AWS SDK endpoint resolution is
  // case-sensitive, so a raw `--region CN-NORTH-1` reached the COMMERCIAL
  // endpoint). The pseudo-parameter resolver folds again from its own four
  // sources; double-folding is a no-op.
  //
  // Issue #3622: `foldRegionOption` folds the `AWS_REGION` /
  // `AWS_DEFAULT_REGION` env vars as well. Folding only the flag left the SDK
  // clients this command builds with NO region (the `--from-state` S3 client
  // when `--region` is absent, `applyRoleArnIfSet`'s STS client, the
  // `--profile` credential resolver) reading the raw env spelling through the
  // SDK's own region chain, and the synth subprocess inheriting it.
  foldRegionOption(options);
  // Issue #1836: `--stack-region` needs the SAME fold, at the same point. It is
  // not a chain-local derivation — it is a flag whose raw value is COMPARED
  // against a state record's region (`local-state-loader.ts`) and forwarded to
  // cdk-local as the CFn client's region, both case-SENSITIVE. Folding here
  // rather than at each consumer keeps ONE normalization point per command;
  // `canonicalizeRegion` is idempotent, so the boundary fold in
  // `local-state-source.ts`'s `--from-state` factory (which the ECS /
  // CloudFront / AgentCore engine commands need, since cdk-local owns THEIR
  // handler) double-folds harmlessly.
  //
  // The RAW spelling is captured FIRST, and it is not a nicety: the state-record
  // match in `local-state-loader.ts` resolves an exactly-spelled `--stack-region`
  // in preference to a case-variant record, and with only the folded value in
  // hand that rule could never fire from a real CLI invocation (round 3 of the
  // #1836 review — `--stack-region US-EAST-1` read the `us-east-1` record while
  // reporting it as the exact spelling). Nothing else reads `rawStackRegion`.
  if (options.stackRegion !== undefined) {
    options.rawStackRegion = options.stackRegion;
    options.stackRegion = canonicalizeRegion(options.stackRegion);
  }

  // Track tmpdirs that may be materialized below so the outer `finally`
  // (and the SIGINT handler) can clean them up regardless of where in
  // the function body a failure unwinds. Hoisted out of the previous
  // try/finally pair: `resolveImagePlan` runs `mkdtempSync` + the layer merge
  // before `runDetached` — if the failure landed between those two
  // calls (`pickFreePort`, `parseDebugPort`, etc.), unwind raced past
  // the per-block finally and we leaked the merged-layers tmpdir
  // (potentially hundreds of MB for node_modules-heavy layers).
  let imagePlan: ImagePlan | undefined;
  let containerId: string | undefined;
  let logStream: ContainerLogStream | undefined;
  let sigintHandler: (() => void) | undefined;
  // Issue #2 deferred from #655: synthesized AWS shared credentials file
  // (one INI section) bind-mounted into the container so handlers using
  // `fromIni({ profile })` explicitly resolve to the same creds.
  // Disposed in the shared `cleanup` single-flight.
  let profileCredsFile: ProfileCredentialsFile | undefined;

  /**
   * Kill the container, then wait (bounded) for `docker logs -f` to relay
   * its last lines — the handler's output and the RIE's END / REPORT — before
   * anything removes it (issue #4480). Single-flight, so the success path's
   * drain, the outer `finally` and a ^C all await the SAME drain.
   */
  const drainLogs = singleFlight(
    async (): Promise<void> => {
      await killAndDrainContainerLogs(containerId, logStream);
    },
    (err) => {
      getLogger().debug(safeMsg`container log drain failed: ${describeAwsFailure(err).detail}`);
    }
  );

  /**
   * Unified cleanup for both the success / failure unwind path AND the
   * SIGINT handler. Idempotent — every step guards on its own undefined
   * sentinel, so partial-init is safe (e.g. SIGINT during synth, before
   * the docker container is even created). Errors per step are logged
   * at debug; we never want cleanup itself to mask a real handler error.
   *
   * Wrapped in `singleFlight(...)` so a ^C that lands during the outer
   * `finally`'s normal unwind awaits the in-flight cleanup instead of
   * launching a parallel run against the shared `containerId` /
   * `logStream` / `imagePlan` cells (which would risk double
   * `docker rm -f` and corrupt mid-iteration mutation of `imagePlan`).
   */
  const cleanup = singleFlight(
    async (): Promise<void> => {
      await drainLogs();
      if (containerId) {
        try {
          await removeContainer(containerId);
        } catch (err) {
          getLogger().debug(
            `removeContainer(${containerId}) failed: ${describeAwsFailure(err).detail}`
          );
        }
      }
      if (imagePlan?.inlineTmpDir) {
        try {
          rmSync(imagePlan.inlineTmpDir, { recursive: true, force: true });
        } catch (err) {
          getLogger().debug(
            `Failed to remove inline-code tmpdir ${imagePlan.inlineTmpDir}: ${
              describeAwsFailure(err).detail
            }`
          );
        }
      }
      if (imagePlan?.layersTmpDir) {
        try {
          rmSync(imagePlan.layersTmpDir, { recursive: true, force: true });
        } catch (err) {
          getLogger().debug(
            `Failed to remove merged-layers tmpdir ${imagePlan.layersTmpDir}: ${
              describeAwsFailure(err).detail
            }`
          );
        }
      }
      if (imagePlan?.layerArnTmpDirs) {
        for (const dir of imagePlan.layerArnTmpDirs) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            getLogger().debug(
              `Failed to remove ARN-layer tmpdir ${dir}: ${describeAwsFailure(err).detail}`
            );
          }
        }
      }
      if (profileCredsFile) {
        try {
          await profileCredsFile.dispose();
        } catch (err) {
          getLogger().debug(
            `Failed to remove profile credentials tmpdir ${profileCredsFile.hostPath}: ${
              describeAwsFailure(err).detail
            }`
          );
        }
      }
      // Every exit after this — a ^C's `process.exit(130)`, or `handleError`'s
      // on a failed invoke — drops writes still queued on a pipe (async on
      // macOS), which is where the drained container logs just went (#4480).
      await flushStdio();
    },
    (err) => {
      getLogger().debug(`cleanup failed: ${describeAwsFailure(err).detail}`);
    }
  );

  try {
    // The role-arn helper accepts an optional region for the SDK fallback;
    // any AWS calls invoked indirectly (e.g. STS during synthesis context
    // probing) will pick up the assumed credentials.
    //
    // A malformed explicit `--assume-role <arn>` is refused HERE, before any
    // AWS call, docker probe or synthesis (issue #2348); the resolution below
    // repeats the same check where the value is used.
    if (typeof options.assumeRole === 'string') {
      explicitRoleArnOrThrow('--assume-role', options.assumeRole);
    }
    if (options.layerRoleArn !== undefined) {
      explicitRoleArnOrThrow('--layer-role-arn', options.layerRoleArn);
    }
    if (options.ecrRoleArn !== undefined) {
      assertFlagRoleArn('--ecr-role-arn', options.ecrRoleArn);
    }
    // BEFORE `--role-arn` and every AWS client: under `--aws-emulator` the
    // role hop, `--from-state`, `{{resolve:...}}` and `--from-cfn-stack` all
    // follow the emulator (`local-aws-wiring.ts`).
    await activateLocalAwsAndRoleArn(options);

    await ensureDockerAvailable();

    // Issue #657: when `--profile <p>` is set, resolve the profile to a
    // concrete credential set ONCE up-front so it can be overlaid onto
    // the Lambda container's env after `forwardAwsEnv` (which only reads
    // `process.env.AWS_*` — empty for SSO / IAM Identity Center / fromIni
    // profiles). Same fix shape as PR #655 (issue #654) for the
    // `cdkd local start-api` family; the helper itself is exported from
    // `local-start-api.ts` and shared. Resolved once per invoke
    // (per the issue spec: "ONCE per invoke (NOT per-container)").
    // Under `--aws-emulator` the container gets the emulator's keys only, so
    // the real `--profile` is neither resolved nor written to a file.
    const profileCredentials = await profileCredentialsForWorkload(
      options.profile,
      resolveProfileCredentials
    );

    // Issue #2 deferred from #655: synthesize an AWS shared credentials
    // file with the resolved creds under `[<options.profile>]` so handler
    // code that uses `fromIni({ profile: '<options.profile>' })` explicitly
    // (instead of the default credential chain) resolves to the same
    // creds locally. Mounted read-only into the container at the path
    // pointed to by `AWS_SHARED_CREDENTIALS_FILE` (set below). The
    // default-chain path (most handlers) keeps working through the
    // existing env-var injection; this file is the additive layer for
    // the explicit-profile case. Disposed in the shared `cleanup`
    // single-flight below.
    // cdkd-local-env-identity: `--profile`, resolved by
    // `resolveProfileCredentials` through
    // `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own chain,
    // never the `--role-arn` role. The same identity the env-var overlay writes;
    // the mounted file is the additive channel for `fromIni({ profile })`.
    if (options.profile && profileCredentials) {
      profileCredsFile = await writeProfileCredentialsFile(options.profile, profileCredentials);
    }

    // Synthesize. Default is "synth every time" (Q2 recommendation C):
    // safe-by-default, with `-a/--app cdk.out` as the explicit opt-out
    // for the watch / fast-path use case.
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

    const lambda = resolveLambdaTarget(target, stacks);
    // A failed context lookup blocks only the stack it invokes from (go-to-k/cdkd#5807).
    refuseFailedLookups([lambda.stack], stacks, failedLookups);
    const targetLabel = lambda.kind === 'zip' ? lambda.runtime : 'container image';
    logger.info(`Target: ${lambda.stack.stackName}/${lambda.logicalId} (${targetLabel})`);

    // Resolve the docker image + bind-mounts + cmd / entrypoint / workdir /
    // platform that depend on the function's `kind`. ZIP Lambdas use a
    // public Lambda base image and bind-mount the local code at
    // /var/task; container Lambdas (PR 5) build a CDK image asset locally
    // OR pull from ECR (any region; cross-account via --ecr-role-arn) and have
    // no bind-mount.
    // From this point on, `imagePlan` may carry tmpdirs (`inlineTmpDir`
    // / `layersTmpDir`) — the outer `finally` reads them off `imagePlan`
    // for cleanup.
    imagePlan = await resolveImagePlan(lambda, options);

    // The container's declared env: template literals, `--from-state` /
    // `--from-cfn-stack` substitution, `--env-vars` overrides, and resolved
    // CloudFormation dynamic references. See {@link resolveInvokeTemplateEnv}.
    const {
      env: templateEnvResolved,
      sensitiveEnvKeys,
      stateForRoleHint,
    } = await resolveInvokeTemplateEnv(lambda, options);

    // Auto-resolve the execution-role ARN from state when the user passed
    // bare `--assume-role` together with `--from-state`. Resolution: walk
    // `state.resources[<Fn>].properties.Role`; if it's a literal ARN, use
    // it verbatim; if it's `Fn::GetAtt: [<RoleId>, 'Arn']` / `Ref: <RoleId>`,
    // pull the sibling IAM Role resource's `attributes.Arn`. Resolution
    // failures fall through to the dev-creds path with a clear warn.
    //
    // Precedence:
    //   `--no-assume-role` (false)            → dev creds, no hint
    //   `--assume-role <arn>` (string)        → explicit ARN wins, even over state
    //   `--assume-role` bare (true) + state   → auto-resolved ARN
    //   `--assume-role` bare (true) no state  → warn + fall through to dev creds
    //   absent (undefined) + state            → one-line hint (legacy PR 2 behavior)
    //   absent (undefined) no state           → dev creds (SAM default)
    let resolvedAssumeRoleArn: string | undefined;
    if (typeof options.assumeRole === 'string') {
      // A malformed explicit ARN is a HARD error (issue #2348), matching
      // `local start-api`'s parse-time refusal; see `explicitRoleArnOrThrow`.
      resolvedAssumeRoleArn = explicitRoleArnOrThrow('--assume-role', options.assumeRole);
    } else if (options.assumeRole === true) {
      // Bare `--assume-role` — must have state to resolve the ARN.
      if (!stateForRoleHint) {
        logger.warn(
          '--assume-role passed without an ARN, but no cdkd state was loaded. ' +
            "Pair it with --from-state, or pass the ARN explicitly: --assume-role '<arn>'. " +
            "Falling back to the developer's shell credentials."
        );
      } else {
        resolvedAssumeRoleArn = resolveBareAssumeRoleFromState(stateForRoleHint, lambda.logicalId);
      }
    } else {
      // `--no-assume-role` (false) and an absent flag (undefined) BOTH land
      // here, and telling them apart is the entire point of registering the
      // negation — so the decision and the emission live together in
      // {@link maybeSuggestAssumeRole} rather than as a condition here. An
      // earlier cut split them, and a review probe restored the pre-fix
      // condition on this line with all 17 negation tests still green.
      maybeSuggestAssumeRole(options, stateForRoleHint, lambda.logicalId);
    }

    // Read the event payload. Default to {} (matches SAM).
    const event = await readEvent(options);

    // Build the env that the container sees. Lambda runtime conventions:
    // we always pass the standard AWS_LAMBDA_* vars so context.* fields
    // inside the handler look real, and forward AWS credentials so SDK
    // calls can hit AWS from inside the handler.
    const dockerEnv: Record<string, string> = {
      AWS_LAMBDA_FUNCTION_NAME: lambda.logicalId,
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(lambda.memoryMb),
      AWS_LAMBDA_FUNCTION_TIMEOUT: String(lambda.timeoutSec),
      AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
      AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${lambda.logicalId}`,
      AWS_LAMBDA_LOG_STREAM_NAME: 'local',
      ...templateEnvResolved,
    };
    // Swap the developer's credentials for STS-issued temporary credentials
    // scoped to the function's deployed execution role when one was resolved,
    // else forward the dev shell creds / `--profile` overlay. See
    // {@link applyLambdaCredentialEnv} for the full precedence + the
    // degrade-on-STS-failure rationale.
    await applyLambdaCredentialEnv(dockerEnv, {
      ...(resolvedAssumeRoleArn && { assumeRoleArn: resolvedAssumeRoleArn }),
      ...(options.region !== undefined && { region: options.region }),
      ...(lambda.stack.region !== undefined && { stackRegion: lambda.stack.region }),
      ...(profileCredentials && { profileCredentials }),
      ...(profileCredsFile && { profileCredsFile }),
    });

    // Optional inspector: --debug-port enables `node --inspect-brk` inside
    // the container. The Lambda Node.js base image's RIE entrypoint
    // forwards NODE_OPTIONS to node, so this is enough on the ZIP path.
    // On the IMAGE path, the Dockerfile's FROM is user-controlled — the
    // env-var still propagates but only matters when the runtime is Node;
    // surface a warn for non-Node container Lambdas so the user knows
    // why nothing happened.
    let debugPort: number | undefined;
    if (options.debugPort) {
      debugPort = Number(options.debugPort);
      if (!Number.isInteger(debugPort) || debugPort <= 0 || debugPort > 65535) {
        throw new Error(`--debug-port must be an integer in 1..65535, got '${options.debugPort}'`);
      }
      dockerEnv['NODE_OPTIONS'] = `--inspect-brk=0.0.0.0:${debugPort}`;
      if (lambda.kind === 'image') {
        logger.warn(
          '--debug-port sets NODE_OPTIONS unconditionally on container Lambdas. ' +
            "If the image's runtime is not Node.js, this flag is a no-op."
        );
      }
    }

    const hostPort = await pickFreePort();
    const containerHost = options.containerHost;

    // PR 6 (#232): when the function declares any layers, log the count
    // — multi-layer Lambdas merge into one bind mount on the host (Docker
    // rejects duplicate `/opt` mounts), but reporting "1 mount" here
    // would understate what the user templated, so we read the count
    // off the resolver's per-layer list instead. Image Lambdas always
    // have `layers: []` so this branch fires only on ZIP Lambdas.
    if (lambda.layers.length > 0) {
      logger.info(
        `Mounting ${lambda.layers.length} Lambda layer${lambda.layers.length === 1 ? '' : 's'} at /opt`
      );
    }
    logger.info(`Starting container (image=${imagePlan.image}, port=${hostPort})...`);
    // Issue #2 deferred from #655: append the profile credentials file
    // bind-mount to the existing extraMounts (which already carry the
    // /opt layer mount when present). Read-only — the container has no
    // business writing to its credentials file; a writable mount would
    // let a compromised handler tamper with the host-side temp file.
    const extraMountsWithProfile = profileCredsFile
      ? [
          ...(imagePlan.extraMounts ?? []),
          {
            hostPath: profileCredsFile.hostPath,
            containerPath: profileCredsFile.containerPath,
            readOnly: true,
          },
        ]
      : imagePlan.extraMounts;
    // Let the Lambda container reach a server on the host (an
    // `AWS_ENDPOINT_URL_*` local endpoint / tunneled VPC resource) via
    // `host.docker.internal`. Docker Desktop resolves the name natively;
    // Linux native dockerd needs the explicit `--add-host` (>= 20.10).
    // Resolved once; degrades to no mapping on an old / unavailable daemon
    // (never throws). cdk-local #483 gives its own `invoke` this; cdkd's
    // invoke is its own command path, so it adopts the same helper here.
    const hostGatewayExtraHosts = await resolveHostGatewayExtraHosts();
    containerId = await runDetached({
      image: imagePlan.image,
      mounts: imagePlan.mounts,
      extraMounts: extraMountsWithProfile,
      env: dockerEnv,
      ...(sensitiveEnvKeys.size > 0 && { sensitiveEnvKeys }),
      ...(hostGatewayExtraHosts.length > 0 && { extraHosts: hostGatewayExtraHosts }),
      cmd: imagePlan.cmd,
      hostPort,
      host: containerHost,
      ...(debugPort !== undefined && { debugPort }),
      ...(imagePlan.platform !== undefined && { platform: imagePlan.platform }),
      ...(imagePlan.entryPoint !== undefined && { entryPoint: imagePlan.entryPoint }),
      ...(imagePlan.workingDir !== undefined && { workingDir: imagePlan.workingDir }),
      ...(imagePlan.tmpfs !== undefined && { tmpfs: imagePlan.tmpfs }),
    });

    // Stream the container's logs to the user's terminal so they see the
    // handler's stdout/stderr as it runs. `drainLogs` ends the stream: it
    // kills the container and waits for the follower to relay the rest.
    logStream = followContainerLogs(containerId);

    // Make sure SIGINT (^C) cleans up the container — the user expects
    // ^C to stop both the CLI AND the daemonized container in one shot.
    // The handler runs the same `cleanup()` the outer `finally` does so
    // tmpdirs (`inlineTmpDir` / `layersTmpDir`) are removed regardless
    // of how the process exits — pre-fix, the SIGINT path skipped the
    // outer finally and leaked the merged-layers tmpdir (which can be
    // hundreds of MB for node_modules-heavy layers). process.on()
    // expects a `void`-returning handler; wrap the async cleanup in a
    // non-async closure so the lint rule about misused-promises doesn't
    // fire.
    sigintHandler = (): void => {
      void cleanup().then(() => {
        process.exit(130);
      });
    };
    process.on('SIGINT', sigintHandler);

    await waitForRieReady(containerHost, hostPort, 5000);

    // Invoke timeout: 2x the function's Timeout, floor 30s. RIE doesn't
    // enforce the function's Timeout itself, but we cap the HTTP wait
    // so a hung handler doesn't block the CLI forever.
    const invokeTimeoutMs = Math.max(30_000, lambda.timeoutSec * 2 * 1000);
    const result = await invokeRie(containerHost, hostPort, event, invokeTimeoutMs);

    // Every log line the invocation printed reaches stderr BEFORE the
    // response reaches stdout. The container served its one invocation, so
    // the drain may kill it here.
    await drainLogs();
    process.stdout.write(`${result.raw}\n`);
  } finally {
    // The handler stays installed while the teardown runs: a ^C during the
    // drain then awaits this same single-flight cleanup instead of taking
    // Node's default exit, which would skip `docker rm -f` and the
    // credentials dispose.
    await cleanup();
    if (sigintHandler) process.off('SIGINT', sigintHandler);
  }
}
/** The container env {@link resolveInvokeTemplateEnv} built from the function's template. */
export interface InvokeTemplateEnvResult {
  /** The function's resolved declared env vars (before the `AWS_LAMBDA_*` and credential keys). */
  env: Record<string, string>;
  /**
   * Keys whose VALUE must stay off the `docker run` argv (a value-less
   * `-e KEY`): a decrypted SecureString, a value resolved at the cross-stack
   * boundary, and a resolved CloudFormation dynamic reference.
   */
  sensitiveEnvKeys: Set<string>;
  /** The loaded state, when a state-source flag loaded one (the `--assume-role` hint path). */
  stateForRoleHint?: StackState;
}

/**
 * Build the function's declared env for `cdkd local invoke`.
 *
 * PR 2 — `--from-state`: load cdkd's S3 state for the target stack and
 * pre-substitute intrinsic-valued env vars before they hit the regular
 * env-resolver. State load failures are surfaced as warnings (we keep PR 1
 * behavior — drop intrinsic vars and continue) rather than hard errors, so a
 * missing / corrupt state file doesn't abort an invoke that the user wanted to
 * run with `--env-vars` overrides anyway.
 *
 * PR #294 follow-up (issue #293): when `--from-state` is set AND the
 * function's template env contains any intrinsic value, build a
 * `SubstitutionContext` carrying both the deployed `resources` map AND a
 * `pseudoParameters` bag so `Fn::Join` / `Fn::Sub` bodies that splice
 * `${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
 * `${AWS::URLSuffix}` resolve cleanly. The pseudo bag is sourced from the
 * resolved region (`--region` > AWS_REGION > AWS_DEFAULT_REGION >
 * synth-derived stack region) + a single `sts:GetCallerIdentity` call.
 * Mirrors the ECS run-task implementation so both `cdkd local * --from-state`
 * paths share semantics.
 *
 * Issue #2056 / go-to-k/cdk-local#784: CloudFormation dynamic references
 * (`{{resolve:...}}`) are resolved locally, with the developer's credentials
 * (`--profile` honoured), before the container starts — a same-stack env value
 * carrying one, and a cross-stack value whose producer output cdkd persisted
 * REDACTED back to its token (#1899). A lookup that fails throws, naming the
 * reference and the IAM permission, so the container never starts with the
 * token in place of the value. This mirrors cdk-local's
 * `resolveLambdaContainerEnv`, which cdkd's invoke does not use, with the same
 * `cdk-local/internal` helpers; keep the two in step.
 */
export async function resolveInvokeTemplateEnv(
  lambda: ResolvedLambda,
  options: LocalInvokeOptions
): Promise<InvokeTemplateEnvResult> {
  // One resolver per invoke, shared by the cross-stack boundary and the final
  // env pass, so each (reference, region) is fetched once.
  const dynamicRefs = createCallerDynamicReferenceResolver(options.profile);
  try {
    return await resolveInvokeTemplateEnvWith(lambda, options, dynamicRefs);
  } finally {
    dynamicRefs.dispose();
  }
}

async function resolveInvokeTemplateEnvWith(
  lambda: ResolvedLambda,
  options: LocalInvokeOptions,
  dynamicRefs: DynamicReferenceResolver
): Promise<InvokeTemplateEnvResult> {
  const logger = getLogger();
  let stateAudit: StateEnvSubstitutionAudit | undefined;
  let stateForRoleHint: StackState | undefined;
  // Region of the stack that owns the env: the loaded state record's.
  let ownerRegion: string | undefined;
  const declaredEnv = getTemplateEnv(lambda.resource);
  const overrides = readEnvOverridesFile(options.envVars);
  const lambdaCdkPath = readCdkPathOrUndefined(lambda.resource);
  // Keys an `--env-vars` override replaces never reach state substitution, so
  // an override also skips a cross-stack dynamic-reference lookup — the remedy
  // the resolver's error message names.
  const overriddenKeys = keysOverriddenBy(
    declaredEnv,
    (env) => resolveEnvVars(lambda.logicalId, lambdaCdkPath, env, overrides).resolved
  );
  let templateEnv = declaredEnv && withoutKeys(declaredEnv, overriddenKeys);
  // Issue #606: pick the right LocalStateProvider for the supplied
  // flags. `--from-state` and `--from-cfn-stack` are mutually
  // exclusive — the helper throws when both are set. Returns
  // `undefined` when neither is set (skip the substitution pass
  // entirely; PR 1 warn-and-drop behavior is preserved).
  // AWS Emulator mixed mode: names, `{{resolve:...}}` and SSM parameters
  // follow THIS function's own sentinels (go-to-k/cdkd#6150).
  const workload = { logicalId: lambda.logicalId, cdkPath: lambdaCdkPath };
  const stateProvider = createLocalStateProvider(
    options,
    lambda.stack.stackName,
    lambda.stack.region,
    { workload }
  );
  if (stateProvider) {
    try {
      const loaded = await stateProvider.load(lambda.stack.stackName, lambda.stack.region);
      if (loaded) {
        ownerRegion = loaded.region;
        // Synthetic StackState shape consumed by the legacy
        // `--assume-role` hint path. Sufficient for
        // `resolveExecutionRoleArnFromState`, which only touches
        // `state.resources[...].properties.Role` /
        // `attributes.Arn`. The CFn provider leaves both empty per
        // its v1 contract, so the auto-resolve fallback warns
        // exactly as it would for a partially-populated cdkd state.
        stateForRoleHint = {
          version: 1,
          stackName: lambda.stack.stackName,
          resources: loaded.resources,
          outputs: loaded.outputs,
          lastModified: 0,
        };
        const subContext: SubstitutionContext = {
          resources: loaded.resources,
          consumerRegion: loaded.region,
          // A cross-stack value carrying a token is resolved at the boundary,
          // against the PRODUCER's region, which cdk-local passes in. The key
          // then lands in the audit's `sensitiveKeys`.
          resolveDynamicReferences: (value, producerRegion) =>
            dynamicRefs.resolveString(value, {
              region: producerRegion,
              consumer: `Lambda ${lambda.logicalId} cross-stack env value`,
              workload,
            }),
        };
        if (envHasIntrinsicValue(templateEnv)) {
          const pseudo = await resolvePseudoParametersForInvoke(lambda.stack.region, options);
          if (pseudo) subContext.pseudoParameters = pseudo;
        }
        // Issue #454 — build the cross-stack resolver only when the env
        // actually references `Fn::ImportValue` / `Fn::GetStackOutput`.
        // The resolver opens an additional client; literal + same-stack-
        // intrinsic env maps shouldn't pay that cost.
        if (envHasCrossStackIntrinsic(templateEnv)) {
          const resolver = await stateProvider.buildCrossStackResolver(loaded.region);
          if (resolver) {
            subContext.crossStackResolver = resolver;
          }
        }
        const { env, audit } = await substituteEnvVarsFromStateAsync(templateEnv, subContext);
        templateEnv = env;
        stateAudit = audit;
        const label = stateProvider.label;
        for (const key of audit.resolvedKeys) {
          logger.debug(`${label}: substituted env var ${key}`);
        }
        for (const { key, reason } of audit.unresolved) {
          logger.warn(
            `${label}: could not substitute env var ${key} (${reason}). ` +
              `Override it via --env-vars or it will be dropped.`
          );
        }
      }
    } finally {
      stateProvider.dispose();
    }
  }

  // Resolve env vars. Intrinsic-valued template entries (i.e. the ones
  // `--from-state` could not substitute, plus all of them when the flag
  // is off) are warned about and dropped; the user can override them via
  // --env-vars (SAM-shape).
  const envResult = resolveEnvVars(lambda.logicalId, lambdaCdkPath, templateEnv, overrides);
  for (const key of envResult.unresolved) {
    // The state-resolver already warned for keys it tried + failed on, so
    // suppress the per-key duplicate warn here. The `--env-vars` /
    // wait-for-state hints still fire for the no-flag path, which is the
    // original PR 1 UX.
    if (stateAudit && stateAudit.unresolved.some((u) => u.key === key)) continue;
    // Prefer the L2 form (`MyStack/MyFn`) in the suggestion since that
    // matches docs/local-invoke.md's target-resolution guidance and the
    // `cdkd local invoke` target shape;
    // the resolver's prefix rule accepts either form.
    const overrideKeyExample = lambdaCdkPath?.replace(/\/Resource$/, '') ?? lambda.logicalId;
    logger.warn(
      `Environment variable ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${overrideKeyExample}":{"${key}":"<literal>"}}), or pass --from-state (cdkd-deployed) / --from-cfn-stack (cdk-deployed) to recover deployed values.`
    );
  }
  warnAwsEmulatorStateSourceHint(envResult.unresolved.length, stateProvider !== undefined);

  // Same-stack dynamic references, against the region of the stack that owns
  // the env. Left as they are: keys already holding plaintext (the audit's
  // `sensitiveKeys` — a decrypted SecureString, or a value resolved at the
  // cross-stack boundary; scanning plaintext could quote a fragment of it in
  // an error) and keys that did not come from the template unchanged
  // (`--env-vars` overrides), which CloudFormation never sees.
  const plaintextKeys = new Set<string>(stateAudit?.sensitiveKeys ?? []);
  for (const key of keysNotFromTemplate(templateEnv, envResult.resolved)) plaintextKeys.add(key);
  const dynamic = await resolveDynamicReferencesInEnv(envResult.resolved, {
    // Mixed mode: routed by THIS function's own sentinels (go-to-k/cdkd#6150).
    workload: { logicalId: lambda.logicalId, cdkPath: readCdkPathOrUndefined(lambda.resource) },
    region: firstUsableRegion(
      ownerRegion,
      options.stackRegion,
      lambda.stack.region,
      options.region
    ),
    label: `Lambda ${lambda.logicalId}`,
    skipKeys: plaintextKeys,
    resolver: dynamicRefs,
  });

  return {
    env: dynamic.env,
    sensitiveEnvKeys: new Set([...(stateAudit?.sensitiveKeys ?? []), ...dynamic.resolvedKeys]),
    ...(stateForRoleHint !== undefined && { stateForRoleHint }),
  };
}

/**
 * Resolve the image / bind-mount / CMD layout for the resolved Lambda. ZIP
 * vs IMAGE branches diverge here; everything downstream consumes a
 * uniform {@link ImagePlan}. Honors `--no-pull` per-path (PR 5 C3): ZIP
 * → skip `docker pull` of the public base; IMAGE local-build → no-op
 * (docker build's default is no-pull); IMAGE ECR-pull → skip the pull
 * AND error if the image isn't in the local cache.
 */
async function resolveImagePlan(
  lambda: ResolvedLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  if (lambda.kind === 'zip') {
    return resolveZipImagePlan(lambda, options);
  }
  return resolveContainerImagePlan(lambda, options);
}

/**
 * Container-Lambda branch (PR 5): try the local-build path first (asset
 * manifest lookup by hash; single-asset fallback when extraction fails),
 * then fall back to ECR pull. NOT same-region-only: `pullEcrImage` authenticates
 * against the image URI's OWN region, so a cross-region image pulls fine.
 * Cross-ACCOUNT needs either `--ecr-role-arn` or credentials already granted
 * `ecr:GetAuthorizationToken` + `ecr:BatchGetImage` on the repository (#455,
 * corrected in issue #2536).
 */
export async function resolveContainerImagePlan(
  lambda: ResolvedImageLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  const logger = getLogger();
  const platform = architectureToPlatform(lambda.architecture);

  // Asset manifest lookup. The stack's `assetManifestPath` is
  // `<cdk.out>/<stack>.assets.json`, or `<assembly-dir>/<artifactId>.assets.json`
  // for a Stage stack; we strip the filename to get the assembly directory the
  // build context lives under.
  const localBuild = await resolveLocalBuildPlan(lambda);
  let imageRef: string;
  if (localBuild) {
    imageRef = await buildContainerImage(localBuild.asset, localBuild.cdkOutDir, {
      // The containment bound for `source.directory` (go-to-k/cdkd#3503).
      assetOutdir: localBuild.assetOutdir,
      architecture: lambda.architecture,
      // `options.build === false` triggers the no-build path: skip
      // `docker build` and verify the deterministic tag is already
      // cached. Default `true` (build as usual). Closes #233.
      noBuild: options.build === false,
    });
  } else {
    // ECR-pull fallback. Surface a clear error when the URI isn't an
    // ECR shape we can authenticate against (most commonly: the user
    // pointed at `public.ecr.aws/...` directly).
    if (!parseEcrUri(lambda.imageUri)) {
      throw new Error(
        `Container Lambda '${lambda.logicalId}' has no matching asset in cdk.out, and Code.ImageUri ` +
          `'${lambda.imageUri}' is not an ECR URI cdkd can authenticate against. ` +
          'Re-synthesize the CDK app (so cdk.out includes the build context) or deploy the image to ECR first.'
      );
    }
    logger.info(
      `No matching cdk.out asset for ${lambda.imageUri}; falling back to ECR pull (cross-region is supported — the ECR client is built for the image URI's region; pass --ecr-role-arn for a cross-account image)...`
    );
    imageRef = await pullEcrImage(lambda.imageUri, {
      // Mixed mode: real ECR only when THIS function excepts ECR (#6179).
      workload: { logicalId: lambda.logicalId, cdkPath: readCdkPathOrUndefined(lambda.resource) },
      skipPull: options.pull === false,
      ...(options.region !== undefined && { region: options.region }),
      ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
    });
  }

  // PR 6 (#232): container Lambdas reject `Layers` at deploy time on
  // the AWS side — layers are baked into the image at build time, not
  // overlaid at runtime. The lambda-resolver normalizes `lambda.layers`
  // to `[]` for the IMAGE branch, so `extraMounts` never carries `/opt` here
  // (matches AWS's invoke-time behavior of silently ignoring layers on
  // container Lambdas); its only entry is the RIE mount below.
  //
  // Issue #440 — `EphemeralStorage.Size` is honored uniformly across
  // ZIP and IMAGE Lambdas. `--tmpfs /tmp:size=Nm` overlays on top of
  // whatever the user's Dockerfile placed there at build time, so
  // there's no shape-divergence to gate on the `kind` discriminator.
  const tmpfs = resolveTmpfsForLambda(lambda);

  // Issue #6018: run the image under a mounted Lambda RIE so an image on a
  // non-AWS base (no emulator of its own) still answers the invoke endpoint.
  // `undefined` keeps the pre-#6018 shape (already an RIE, or no binary).
  const rie = await resolveRieWrap({
    image: imageRef,
    platform,
    entryPoint: lambda.imageConfig.entryPoint,
    command: lambda.imageConfig.command,
    skipPull: options.pull === false,
  });

  return {
    image: imageRef,
    mounts: [],
    extraMounts: rie ? [rie.mount] : [],
    cmd: rie ? rie.cmd : (lambda.imageConfig.command ?? []),
    platform,
    ...(rie && { entryPoint: rie.entryPoint }),
    ...(!rie &&
      lambda.imageConfig.entryPoint &&
      lambda.imageConfig.entryPoint.length > 0 && {
        entryPoint: lambda.imageConfig.entryPoint,
      }),
    ...(lambda.imageConfig.workingDirectory !== undefined && {
      workingDir: lambda.imageConfig.workingDirectory,
    }),
    ...(tmpfs !== undefined && { tmpfs }),
  };
}
