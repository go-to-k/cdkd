import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import * as path from 'node:path';
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
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import {
  resolveLambdaTarget,
  type ResolvedImageLambda,
  type ResolvedLambda,
  type ResolvedZipLambda,
} from '../../local/lambda-resolver.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import {
  substituteEnvVarsFromState,
  type StateEnvSubstitutionAudit,
} from '../../local/state-resolver.js';
import {
  resolveRuntimeCodeMountPath,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
} from '../../local/runtime-image.js';
import {
  ensureDockerAvailable,
  pickFreePort,
  pullImage,
  removeContainer,
  runDetached,
  streamLogs,
} from '../../local/docker-runner.js';
import { architectureToPlatform, buildContainerImage } from '../../local/docker-image-builder.js';
import { pullEcrImage, parseEcrUri } from '../../local/ecr-puller.js';
import { invokeRie, waitForRieReady } from '../../local/rie-client.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../assets/asset-manifest-loader.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import type { StackState } from '../../types/state.js';
import { createLocalStartApiCommand } from './local-start-api.js';
import { createLocalRunTaskCommand } from './local-run-task.js';

interface LocalInvokeOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  event?: string;
  eventStdin?: boolean;
  envVars?: string;
  /**
   * Commander maps `--no-pull` to `pull: boolean` (default `true`). When
   * the user passes `--no-pull` the value flips to `false` and we skip
   * `docker pull`. Naming-wise `pull` reads as "should pull" so the
   * skip-when-false logic stays the right way around.
   */
  pull: boolean;
  /**
   * Commander maps `--no-build` to `build: boolean` (default `true`).
   * When the user passes `--no-build` the value flips to `false` and we
   * skip `docker build` on the IMAGE local-build path, requiring the
   * previously-built deterministic tag to already be in the local
   * registry. No-op for ZIP Lambdas and the IMAGE ECR-pull path
   * (matches `--no-pull`'s per-path behavior). Closes #233.
   */
  build: boolean;
  debugPort?: string;
  containerHost: string;
  /**
   * Q1 recommendation B: optional Lambda execution role to assume before
   * invoking. When set, cdkd calls `sts:AssumeRole` against this ARN and
   * forwards the resulting temporary credentials into the container so
   * the handler runs under the deployed function's narrow permissions
   * (instead of the developer's typically-admin shell credentials). PR 1
   * accepts an explicit ARN only — PR 2's `--from-state` adds a hint
   * pointing at the state-recorded role ARN (auto-assumption is still
   * out of scope). Off by default.
   */
  assumeRole?: string;
  /**
   * PR 2: when set, cdkd reads its S3 state for the target stack and
   * substitutes intrinsic-valued env vars (`Ref` / `Fn::GetAtt` /
   * `Fn::Sub`) with the deployed physical IDs / attributes. Closes the
   * "intrinsic-valued env vars are dropped" gap that PR 1 left
   * explicit. Off by default — PR 1 behavior is preserved when the
   * flag is not set.
   */
  fromState: boolean;
  stateBucket?: string;
  statePrefix: string;
  /**
   * Region of the state record to read. Required when the same stack
   * name has state in multiple regions. Mirrors `cdkd state show
   * --stack-region`.
   */
  stackRegion?: string;
}

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
async function localInvokeCommand(target: string, options: LocalInvokeOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  warnIfDeprecatedRegion(options);

  // Track tmpdirs that may be materialized below so the outer `finally`
  // (and the SIGINT handler) can clean them up regardless of where in
  // the function body a failure unwinds. Hoisted out of the previous
  // try/finally pair: `resolveImagePlan` runs `mkdtempSync` + `cpSync`
  // before `runDetached` — if the failure landed between those two
  // calls (`pickFreePort`, `parseDebugPort`, etc.), unwind raced past
  // the per-block finally and we leaked the merged-layers tmpdir
  // (potentially hundreds of MB for node_modules-heavy layers).
  let imagePlan: ImagePlan | undefined;
  let containerId: string | undefined;
  let stopLogs: (() => void) | undefined;
  let sigintHandler: (() => void) | undefined;

  /**
   * Unified cleanup for both the success / failure unwind path AND the
   * SIGINT handler. Idempotent — every step guards on its own undefined
   * sentinel, so partial-init is safe (e.g. SIGINT during synth, before
   * the docker container is even created). Errors per step are logged
   * at debug; we never want cleanup itself to mask a real handler error.
   */
  const cleanup = async (): Promise<void> => {
    if (stopLogs) {
      try {
        stopLogs();
      } catch (err) {
        getLogger().debug(
          `streamLogs stop failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (containerId) {
      try {
        await removeContainer(containerId);
      } catch (err) {
        getLogger().debug(
          `removeContainer(${containerId}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (imagePlan?.inlineTmpDir) {
      try {
        rmSync(imagePlan.inlineTmpDir, { recursive: true, force: true });
      } catch (err) {
        getLogger().debug(
          `Failed to remove inline-code tmpdir ${imagePlan.inlineTmpDir}: ${
            err instanceof Error ? err.message : String(err)
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
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  };

  try {
    // The role-arn helper accepts an optional region for the SDK fallback;
    // any AWS calls invoked indirectly (e.g. STS during synthesis context
    // probing) will pick up the assumed credentials.
    await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

    await ensureDockerAvailable();

    // Synthesize. Default is "synth every time" (Q2 recommendation C):
    // safe-by-default, with `-a/--app cdk.out` as the explicit opt-out
    // for the watch / fast-path use case.
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

    const lambda = resolveLambdaTarget(target, stacks);
    const targetLabel = lambda.kind === 'zip' ? lambda.runtime : 'container image';
    logger.info(`Target: ${lambda.stack.stackName}/${lambda.logicalId} (${targetLabel})`);

    // Resolve the docker image + bind-mounts + cmd / entrypoint / workdir /
    // platform that depend on the function's `kind`. ZIP Lambdas use a
    // public Lambda base image and bind-mount the local code at
    // /var/task; container Lambdas (PR 5) build a CDK image asset locally
    // OR pull from ECR (same-acct/region) and have no bind-mount.
    // From this point on, `imagePlan` may carry tmpdirs (`inlineTmpDir`
    // / `layersTmpDir`) — the outer `finally` reads them off `imagePlan`
    // for cleanup.
    imagePlan = await resolveImagePlan(lambda, options);

    // PR 2 — `--from-state`: load cdkd's S3 state for the target stack and
    // pre-substitute intrinsic-valued env vars before they hit the regular
    // env-resolver. State load failures are surfaced as warnings (we keep
    // PR 1 behavior — drop intrinsic vars and continue) rather than hard
    // errors, so a missing / corrupt state file doesn't abort an invoke
    // that the user wanted to run with `--env-vars` overrides anyway.
    let stateAudit: StateEnvSubstitutionAudit | undefined;
    let templateEnv = getTemplateEnv(lambda.resource);
    let stateForRoleHint: StackState | undefined;
    if (options.fromState) {
      const loaded = await loadStateForStack(lambda.stack.stackName, lambda.stack.region, {
        ...(options.stackRegion !== undefined && { stackRegion: options.stackRegion }),
        ...(options.stateBucket !== undefined && { stateBucket: options.stateBucket }),
        statePrefix: options.statePrefix,
        ...(options.region !== undefined && { region: options.region }),
        ...(options.profile !== undefined && { profile: options.profile }),
      });
      if (loaded) {
        stateForRoleHint = loaded.state;
        const { env, audit } = substituteEnvVarsFromState(templateEnv, loaded.state.resources);
        templateEnv = env;
        stateAudit = audit;
        for (const key of audit.resolvedKeys) {
          logger.debug(`--from-state: substituted env var ${key} from cdkd state`);
        }
        for (const { key, reason } of audit.unresolved) {
          logger.warn(
            `--from-state: could not substitute env var ${key} (${reason}). ` +
              `Override it via --env-vars or it will be dropped.`
          );
        }
      }
    }

    // Resolve env vars. Intrinsic-valued template entries (i.e. the ones
    // `--from-state` could not substitute, plus all of them when the flag
    // is off) are warned about and dropped; the user can override them via
    // --env-vars (SAM-shape).
    const overrides = readEnvOverridesFile(options.envVars);
    const envResult = resolveEnvVars(lambda.logicalId, templateEnv, overrides);
    for (const key of envResult.unresolved) {
      // The state-resolver already warned for keys it tried + failed on, so
      // suppress the per-key duplicate warn here. The `--env-vars` /
      // wait-for-state hints still fire for the no-flag path, which is the
      // original PR 1 UX.
      if (stateAudit && stateAudit.unresolved.some((u) => u.key === key)) continue;
      logger.warn(
        `Environment variable ${key} contains a CloudFormation intrinsic and was dropped. ` +
          `Override it with --env-vars (e.g. {"${lambda.logicalId}":{"${key}":"<literal>"}}) or pass --from-state to recover deployed values.`
      );
    }

    // Q1 follow-up: when `--from-state` is set but `--assume-role` is NOT,
    // peek at the function's `Role` property in state and surface the
    // deployed execution role's ARN as a one-line hint. We deliberately
    // do NOT auto-assume — that's a future PR's scope; v1 keeps the user's
    // explicit ARN as the only path to scoped credentials.
    if (options.fromState && !options.assumeRole && stateForRoleHint) {
      suggestAssumeRoleFromState(stateForRoleHint, lambda.logicalId);
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
      ...envResult.resolved,
    };
    // Q1 recommendation B: if --assume-role is set, swap the developer's
    // credentials for STS-issued temporary credentials scoped to the
    // function's deployed execution role. Otherwise pass the developer's
    // creds through (SAM-compatible default). Region precedence mirrors
    // the rest of cdkd: --region > AWS_REGION > AWS_DEFAULT_REGION.
    if (options.assumeRole) {
      const stsRegion =
        options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
      const creds = await assumeLambdaExecutionRole(options.assumeRole, stsRegion);
      dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
      dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
      dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
      if (stsRegion) dockerEnv['AWS_REGION'] = stsRegion;
    } else {
      forwardAwsEnv(dockerEnv);
    }

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
    containerId = await runDetached({
      image: imagePlan.image,
      mounts: imagePlan.mounts,
      extraMounts: imagePlan.extraMounts,
      env: dockerEnv,
      cmd: imagePlan.cmd,
      hostPort,
      host: containerHost,
      ...(debugPort !== undefined && { debugPort }),
      ...(imagePlan.platform !== undefined && { platform: imagePlan.platform }),
      ...(imagePlan.entryPoint !== undefined && { entryPoint: imagePlan.entryPoint }),
      ...(imagePlan.workingDir !== undefined && { workingDir: imagePlan.workingDir }),
    });

    // Stream the container's logs to the user's terminal so they see the
    // handler's stdout/stderr as it runs. The stop function is called from
    // the finally to detach before docker rm.
    stopLogs = streamLogs(containerId);

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

    // Settle a few hundred ms so logs fully flush before we tear down.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    process.stdout.write(`${result.raw}\n`);
  } finally {
    if (sigintHandler) process.off('SIGINT', sigintHandler);
    await cleanup();
  }
}

/**
 * Result of resolving the docker image, bind-mounts, and CMD / entrypoint /
 * workdir / platform fields that depend on the function's `kind`. Built by
 * {@link resolveImagePlan}; consumed by `runDetached`.
 *
 * For ZIP Lambdas: `image` is a public Lambda base image, `mounts` carries
 * one entry that bind-mounts the local code at /var/task, `cmd` is
 * `[handler]`. `platform` / `entryPoint` / `workingDir` are unset.
 *
 * For IMAGE Lambdas (PR 5): `image` is either a locally-built tag (asset
 * manifest hit) or the deployed ECR URI (fallback). `mounts` is empty (the
 * code is already in the image). `cmd` / `entryPoint` / `workingDir` come
 * from `ImageConfig`. `platform` is set per `Architectures` (D5.6).
 */
interface ImagePlan {
  image: string;
  mounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /**
   * Lambda Layer mounts (PR 6 of #224, issue #232). The function's
   * `Properties.Layers` references collapse to a single bind mount at
   * `/opt`. Why one mount, not one-per-layer: Docker rejects multiple
   * bind mounts at the same target path (`Error response from daemon:
   * Duplicate mount point: /opt`) — bind mounts are NOT layered the
   * way the OCI image stack is. AWS Lambda implements layer
   * stacking by extracting each layer's ZIP into `/opt` IN ORDER so
   * later layers overwrite earlier files; cdkd mirrors that on the
   * host by `cpSync`-merging each layer's asset directory into one
   * tmpdir and bind-mounting THAT at `/opt`. The single-layer case
   * skips the copy and bind-mounts the layer's asset dir directly.
   * Empty `[]` for container Lambdas and ZIP Lambdas with no layers.
   */
  extraMounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  cmd: string[];
  platform?: string;
  entryPoint?: string[];
  workingDir?: string;
  /**
   * Set when the ZIP-Lambda branch materialized inline `Code.ZipFile`
   * source to a tmpdir. The CLI's outer `finally` removes this dir
   * alongside the docker container so we don't leak per-invoke tmpdirs
   * (each invoke creates a fresh `cdkd-local-invoke-*` directory under
   * the OS tmp root). Asset-backed Lambdas leave this unset.
   */
  inlineTmpDir?: string;
  /**
   * Set when multiple `Properties.Layers` were merged into a single
   * tmpdir (see {@link extraMounts}). The CLI's outer `finally`
   * removes this dir alongside the docker container so we don't leak
   * per-invoke layer-merge tmpdirs. Single-layer or no-layer functions
   * leave this unset.
   */
  layersTmpDir?: string;
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
 * ZIP-Lambda branch: pull the public Lambda base image, bind-mount the
 * resolved code dir at /var/task, set CMD to `[handler]`. Inline
 * (Code.ZipFile) Lambdas materialize to a tmpdir using the
 * runtime-appropriate file extension before bind-mounting.
 */
async function resolveZipImagePlan(
  lambda: ResolvedZipLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  let inlineTmpDir: string | undefined;
  let codeDir = lambda.codePath;
  if (codeDir === null) {
    inlineTmpDir = materializeInlineCode(
      lambda.handler,
      lambda.inlineCode ?? '',
      resolveRuntimeFileExtension(lambda.runtime)
    );
    codeDir = inlineTmpDir;
  }

  const image = resolveRuntimeImage(lambda.runtime);

  // Commander surfaces `--no-pull` as `pull: false` (default `true`).
  await pullImage(image, options.pull === false);

  // PR 6 (#232): merge every same-stack `AWS::Lambda::LayerVersion`
  // referenced by `Properties.Layers` into a single bind mount at
  // `/opt`. AWS extracts layer ZIPs into `/opt` IN ORDER (later
  // layers overwrite earlier files); we mirror that on the host
  // before bind-mounting because Docker rejects multiple bind mounts
  // at the same target path.
  const layerPlan = materializeLambdaLayers(lambda.layers);

  // provided.al2 / provided.al2023 require the deployment package at
  // /var/runtime (where the base image's hardcoded entrypoint exec's
  // /var/runtime/bootstrap); every other runtime expects /var/task.
  const containerCodePath = resolveRuntimeCodeMountPath(lambda.runtime);

  return {
    image,
    mounts: [{ hostPath: codeDir, containerPath: containerCodePath, readOnly: true }],
    extraMounts: layerPlan.mount ? [layerPlan.mount] : [],
    cmd: [lambda.handler],
    ...(inlineTmpDir !== undefined && { inlineTmpDir }),
    ...(layerPlan.tmpDir !== undefined && { layersTmpDir: layerPlan.tmpDir }),
  };
}

/**
 * Build the `/opt` bind mount for a Lambda's resolved layers (PR 6 of
 * #224, issue #232).
 *
 * Three cases:
 *
 *   1. **No layers**: returns `{ mount: undefined }`. The caller emits
 *      no `/opt` mount.
 *   2. **Single layer**: returns `{ mount: { hostPath, '/opt', ro }, tmpDir: undefined }`.
 *      The layer's asset directory is bind-mounted directly — faster
 *      than copying since CDK has already unzipped the asset.
 *   3. **Multiple layers**: copies each layer's contents into a fresh
 *      tmpdir IN ORDER (later layers overwrite earlier files via
 *      `cpSync({force: true})`), then bind-mounts the merged tmpdir at
 *      `/opt`. Returns `{ mount, tmpDir: <path> }` so the caller can
 *      `rmSync` the tmpdir on cleanup.
 *
 * The merge case is the only way to honor AWS's "last layer wins on
 * file collision" semantics with bind mounts: Docker rejects multiple
 * `-v ...:/opt:ro` entries at the same target path, so we can't rely
 * on overlay layering at the docker-runner layer.
 */
export function materializeLambdaLayers(layers: { logicalId: string; assetPath: string }[]): {
  mount?: { hostPath: string; containerPath: string; readOnly: boolean };
  tmpDir?: string;
} {
  if (layers.length === 0) return {};
  if (layers.length === 1) {
    return {
      mount: { hostPath: layers[0]!.assetPath, containerPath: '/opt', readOnly: true },
    };
  }
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-invoke-layers-'));
  for (const layer of layers) {
    // `recursive: true` is required for directory copy. `force: true`
    // makes later layers overwrite earlier ones — the load-bearing
    // half of AWS's "last layer wins" semantic. cpSync merges into the
    // existing target rather than replacing it.
    //
    // **Contract pinned (Node 20+)**: cdkd relies on three default
    // behaviors of `fs.cpSync` that future readers should NOT change
    // without auditing every Lambda Layer the integ test exercises:
    //   - `mode` defaults to preserving the source's file-mode bits,
    //     including the `+x` execute bit. AWS layers commonly ship
    //     executable scripts under `bin/` (e.g. layer-version shipped
    //     binaries, the Python `bin/python` shim) and a Lambda handler
    //     that runs `bin/<script>` from `/opt` would fail with a bare
    //     "Permission denied" otherwise. Equivalent to `cp -a` semantics
    //     for the bits Lambda actually cares about.
    //   - `verbatimSymlinks` defaults to true on Node 20+; symlinks in
    //     the source are copied as symlinks (not dereferenced), which
    //     matches how AWS extracts a layer ZIP into `/opt`. Some build
    //     tools emit symlinks inside the layer asset directory and we
    //     don't want to silently flatten them.
    //   - `force: true` (above) makes a later layer's entry overwrite
    //     the previous layer's same-path entry; mirrors AWS's
    //     last-layer-wins file-collision rule.
    // The first two are Node 20+ defaults and require no explicit flag;
    // we document them here so a future "tighten the cpSync options"
    // refactor doesn't accidentally drop the `+x` bit or dereference
    // symlinks and silently break `/opt/bin/...` layers in the field.
    cpSync(layer.assetPath, tmpDir, { recursive: true, force: true });
  }
  return {
    mount: { hostPath: tmpDir, containerPath: '/opt', readOnly: true },
    tmpDir,
  };
}

/**
 * Container-Lambda branch (PR 5): try the local-build path first (asset
 * manifest lookup by hash; single-asset fallback when extraction fails),
 * then fall back to ECR pull (same-account / same-region only — D5.2).
 */
export async function resolveContainerImagePlan(
  lambda: ResolvedImageLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  const logger = getLogger();
  const platform = architectureToPlatform(lambda.architecture);

  // Asset manifest lookup. The stack's `assetManifestPath` is at
  // `<cdk.out>/<stack>.assets.json`; we strip the filename to get the
  // assembly directory the build context lives under.
  const localBuild = await resolveLocalBuildPlan(lambda);
  let imageRef: string;
  if (localBuild) {
    imageRef = await buildContainerImage(localBuild.asset, localBuild.cdkOutDir, {
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
      `No matching cdk.out asset for ${lambda.imageUri}; falling back to ECR pull (same-acct/region only)...`
    );
    imageRef = await pullEcrImage(lambda.imageUri, {
      skipPull: options.pull === false,
      ...(options.region !== undefined && { region: options.region }),
    });
  }

  // PR 6 (#232): container Lambdas reject `Layers` at deploy time on
  // the AWS side — layers are baked into the image at build time, not
  // overlaid at runtime. The lambda-resolver normalizes `lambda.layers`
  // to `[]` for the IMAGE branch, so `extraMounts` is always empty here
  // (matches AWS's invoke-time behavior of silently ignoring layers on
  // container Lambdas).
  return {
    image: imageRef,
    mounts: [],
    extraMounts: [],
    cmd: lambda.imageConfig.command ?? [],
    platform,
    ...(lambda.imageConfig.entryPoint &&
      lambda.imageConfig.entryPoint.length > 0 && {
        entryPoint: lambda.imageConfig.entryPoint,
      }),
    ...(lambda.imageConfig.workingDirectory !== undefined && {
      workingDir: lambda.imageConfig.workingDirectory,
    }),
  };
}

/**
 * Look up the docker image asset that backs a container Lambda. Returns
 * `undefined` when the asset manifest does not contain a matching entry
 * (and the single-asset fallback in `getDockerImageBySourceHash` did not
 * apply either) — the caller falls back to the ECR-pull path.
 */
async function resolveLocalBuildPlan(
  lambda: ResolvedImageLambda
): Promise<
  | { asset: { source: import('../../types/assets.js').DockerImageAssetSource }; cdkOutDir: string }
  | undefined
> {
  const manifestPath = lambda.stack.assetManifestPath;
  if (!manifestPath) return undefined;
  const cdkOutDir = dirname(manifestPath);

  const loader = new AssetManifestLoader();
  const manifest = await loader.loadManifest(cdkOutDir, lambda.stack.stackName);
  if (!manifest) return undefined;

  const entry = getDockerImageBySourceHash(manifest, lambda.imageUri);
  if (!entry) return undefined;
  return { asset: entry.asset, cdkOutDir };
}

/**
 * Pull the function's `Properties.Environment.Variables` map (when
 * present). Type-narrowed at the boundary so the env-resolver can stay
 * pure and accept `Record<string, unknown>`.
 */
function getTemplateEnv(resource: {
  Properties?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const props = resource.Properties ?? {};
  const env = props['Environment'];
  if (!env || typeof env !== 'object') return undefined;
  const vars = (env as Record<string, unknown>)['Variables'];
  if (!vars || typeof vars !== 'object') return undefined;
  return vars as Record<string, unknown>;
}

/**
 * Read the `--env-vars` JSON file. Returns `undefined` when the flag
 * was not passed; throws on parse failure with a clear pointer at the
 * file. SAM's accepted shape is loose; we only require it to be an
 * object at the top level.
 */
function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read --env-vars file '${filePath}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--env-vars file '${filePath}' must contain a JSON object at the top level.`);
  }
  return parsed as EnvOverrideFile;
}

/**
 * Read the event payload from `--event <file>`, `--event-stdin`, or
 * default `{}`. JSON-validated at parse time so a typo doesn't reach
 * the handler as a string blob.
 */
async function readEvent(options: LocalInvokeOptions): Promise<unknown> {
  if (options.event && options.eventStdin) {
    throw new Error('--event and --event-stdin are mutually exclusive.');
  }
  if (options.eventStdin) {
    const raw = await readStdin();
    return parseEvent(raw, '<stdin>');
  }
  if (options.event) {
    const raw = readFileSync(options.event, 'utf-8');
    return parseEvent(raw, options.event);
  }
  return {};
}

function parseEvent(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse event payload from ${source} as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Assume the Lambda execution role and return temporary credentials.
 *
 * Q1 recommendation B (PR 1): closes the "developer has admin creds, the
 * deployed function has narrow ones" skew that SAM users routinely hit.
 * Off by default; opt-in via `--assume-role <arn>`. PR 2's `--from-state`
 * will add auto-resolution from the template's `Role` property; for now
 * the user supplies the ARN explicitly.
 *
 * Mirrors the env-var-write pattern from `applyRoleArnIfSet` in
 * `src/utils/role-arn.ts` but writes the temp creds onto the container's
 * env block (not the cdkd process's env), so the developer's outer
 * shell credentials still flow into any cdkd-side AWS calls (synthesis
 * context probes, etc.).
 */
async function assumeLambdaExecutionRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-local-invoke-${Date.now()}`,
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
 * Forward the developer's AWS credentials into the container so the
 * handler's AWS SDK calls can authenticate. Used when `--assume-role`
 * is NOT set — SAM-compatible default.
 *
 * Region is inherited from `AWS_REGION` / `AWS_DEFAULT_REGION` so
 * `aws.config.region` inside the handler works without extra setup.
 */
function forwardAwsEnv(env: Record<string, string>): void {
  const passThrough = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
  ] as const;
  for (const key of passThrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
}

/**
 * Materialize an inline Lambda body (`Code.ZipFile`) to a tmpdir and
 * return the directory the container should mount at /var/task. The
 * filename is derived from the function's Handler property and the
 * runtime's source-file extension (`.js` for Node.js, `.py` for Python):
 *
 *   Handler "index.handler" + ext ".js"   → tmpdir/index.js
 *   Handler "index.handler" + ext ".py"   → tmpdir/index.py
 *   Handler "lib/handler.main" + ext ".js" → tmpdir/lib/handler.js
 *
 * (Drop the last segment, append the extension to the rest.)
 *
 * The Handler grammar is `<modulePath>.<funcName>` for both Node.js and
 * Python (the dot is the same module-vs-function separator), so the
 * parsing logic is identical across runtimes — only the file extension
 * varies.
 */
function materializeInlineCode(handler: string, source: string, fileExtension: string): string {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Handler '${handler}' is malformed: expected '<modulePath>.<exportName>'.`);
  }
  const modulePath = handler.substring(0, lastDot);
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-invoke-'));
  const filePath = path.join(dir, `${modulePath}${fileExtension}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, 'utf-8');
  return dir;
}

/**
 * Load cdkd state for the target stack so `--from-state` can substitute
 * intrinsic-valued env vars.
 *
 * Failure mode: returns `undefined` and logs at warn for every "expected"
 * miss (no state file, multi-region ambiguity without `--stack-region`,
 * bucket-resolution failure). `--from-state` is opt-in and the caller's
 * fallback is the existing PR 1 warn-and-drop, so a broken state file
 * shouldn't abort the whole invoke. Genuine errors (auth failures, etc.)
 * still propagate.
 *
 * Mirrors the orphan command's state-loading shape but without the lock
 * or save path — `cdkd local invoke` is purely read-only against state.
 */
async function loadStateForStack(
  stackName: string,
  synthRegion: string | undefined,
  opts: {
    stackRegion?: string;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    profile?: string;
  }
): Promise<{ state: StackState; region: string } | undefined> {
  const logger = getLogger();

  // Region resolution chain: --region > AWS_REGION > AWS_DEFAULT_REGION >
  // synth-derived stack region > us-east-1. The state-bucket S3 client is
  // re-targeted to the bucket's actual region inside the backend, but the
  // initial AWS clients still need a sensible default.
  const region =
    opts.region ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    synthRegion ??
    'us-east-1';

  let stateBucket: string;
  try {
    stateBucket = await resolveStateBucketWithDefault(opts.stateBucket, region);
  } catch (err) {
    logger.warn(
      `--from-state: could not resolve state bucket: ${err instanceof Error ? err.message : String(err)}. Falling back to PR 1 warn-and-drop semantics.`
    );
    return undefined;
  }

  const awsClients = new AwsClients({
    ...(opts.region !== undefined && { region: opts.region }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: opts.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(opts.region !== undefined && { region: opts.region }),
      ...(opts.profile !== undefined && { profile: opts.profile }),
    });
    await stateBackend.verifyBucketExists();

    // Disambiguate: if the user passed --stack-region, use it; else if the
    // synthesized stack carries a region, prefer that; else fall back to
    // the single state record for this stack name. Multi-region ambiguity
    // → warn and bail (mirrors `cdkd state show`'s semantics, just without
    // the hard-error treatment so an opt-in --from-state degrades cleanly).
    const refs = (await stateBackend.listStacks()).filter((r) => r.stackName === stackName);
    if (refs.length === 0) {
      logger.warn(
        `--from-state: no cdkd state found for stack '${stackName}' in bucket '${stateBucket}'. ` +
          `Was it deployed via 'cdkd deploy'? Falling back to PR 1 warn-and-drop semantics.`
      );
      return undefined;
    }

    let targetRegion: string;
    if (opts.stackRegion) {
      const found = refs.find((r) => r.region === opts.stackRegion);
      if (!found) {
        const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
        logger.warn(
          `--from-state: stack '${stackName}' has no state in region '${opts.stackRegion}' (available: ${seen}). Falling back.`
        );
        return undefined;
      }
      targetRegion = opts.stackRegion;
    } else if (synthRegion && refs.some((r) => r.region === synthRegion)) {
      targetRegion = synthRegion;
    } else if (refs.length === 1) {
      targetRegion = refs[0]!.region ?? synthRegion ?? region;
    } else {
      const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
      logger.warn(
        `--from-state: stack '${stackName}' has state in multiple regions (${seen}). ` +
          `Re-run with --stack-region <region>. Falling back.`
      );
      return undefined;
    }

    const stateData = await stateBackend.getState(stackName, targetRegion);
    if (!stateData) {
      logger.warn(
        `--from-state: state record for '${stackName}' (${targetRegion}) returned empty. Falling back.`
      );
      return undefined;
    }
    logger.debug(`--from-state: loaded state for ${stackName} (${targetRegion})`);
    return { state: stateData.state, region: targetRegion };
  } finally {
    awsClients.destroy();
  }
}

/**
 * When `--from-state` is set but `--assume-role` is not, log the function's
 * deployed execution role ARN once as a hint. Helps users discover the
 * scoped-credentials path without us silently auto-assuming (auto-assume
 * is a future PR's scope).
 */
function suggestAssumeRoleFromState(state: StackState, logicalId: string): void {
  const logger = getLogger();
  const lambda = state.resources[logicalId];
  if (!lambda) return;

  const roleRef = lambda.properties?.['Role'] ?? lambda.observedProperties?.['Role'];
  let roleArn: string | undefined;
  if (typeof roleRef === 'string' && roleRef.startsWith('arn:')) {
    roleArn = roleRef;
  } else if (typeof roleRef === 'object' && roleRef !== null) {
    // The template typically has `Fn::GetAtt: [<RoleId>, Arn]` — we look up
    // the referenced role's `Arn` attribute in the state's resources map.
    const refLogicalId = pickReferencedLogicalId(roleRef as Record<string, unknown>);
    if (refLogicalId) {
      const roleResource = state.resources[refLogicalId];
      const cached = roleResource?.attributes?.['Arn'];
      if (typeof cached === 'string' && cached.startsWith('arn:')) {
        roleArn = cached;
      }
    }
  }

  if (roleArn) {
    logger.info(
      `Hint: the deployed function uses execution role ${roleArn}. ` +
        `Re-run with --assume-role <that-arn> to invoke under the deployed function's narrow permissions.`
    );
  }
}

/**
 * Walk a single-key intrinsic and return the referenced logical ID, or
 * `undefined` for shapes we don't try to resolve in v1 (multi-key
 * intrinsics, nested intrinsics, etc.). Mirrors the narrow handling used
 * by `state-resolver.ts`.
 */
function pickReferencedLogicalId(intrinsic: Record<string, unknown>): string | undefined {
  if ('Ref' in intrinsic && typeof intrinsic['Ref'] === 'string') return intrinsic['Ref'];
  if ('Fn::GetAtt' in intrinsic) {
    const arg = intrinsic['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
    if (typeof arg === 'string') return arg.split('.')[0];
  }
  return undefined;
}

/**
 * Top-level `cdkd local` command. PR 1 added `invoke`; PR 8a adds
 * `start-api` (long-running HTTP server that maps API Gateway routes
 * to Lambda invocations). Both share the same Docker / RIE plumbing
 * under `src/local/`.
 */
export function createLocalCommand(): Command {
  const local = new Command('local').description(
    'Local execution of Lambda functions (RIE) and ECS task definitions (Docker required)'
  );

  const invoke = new Command('invoke')
    .description(
      'Run a Lambda function locally in a Docker container (RIE-backed). ' +
        'Target accepts a CDK display path (MyStack/MyApi/Handler) or stack-qualified logical ID ' +
        '(MyStack:MyApiHandler1234ABCD). Single-stack apps may omit the stack prefix.'
    )
    .argument('<target>', 'CDK display path or stack-qualified logical ID of the Lambda to invoke')
    .addOption(new Option('-e, --event <file>', 'JSON event payload file (default: {})'))
    .addOption(new Option('--event-stdin', 'Read event JSON from stdin').default(false))
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"LogicalId":{"KEY":"VALUE"}})'
      )
    )
    .addOption(
      new Option(
        '--no-pull',
        'Skip docker pull (use cached image) — no-op for IMAGE local-build path; ' +
          '`docker build` does not pull base layers by default'
      )
    )
    .addOption(
      new Option(
        '--no-build',
        'Skip docker build on the IMAGE local-build path (use the previously-built tag). ' +
          'Requires the deterministic tag to already be in the local registry; errors with ' +
          'an actionable message when missing. No-op for ZIP Lambdas and the IMAGE ECR-pull path. ' +
          'Compatible with --no-pull.'
      )
    )
    .addOption(new Option('--debug-port <port>', 'Node --inspect-brk port (default: off)'))
    .addOption(
      new Option('--container-host <host>', 'Host to bind the RIE port to').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-role <arn>',
        "Assume the Lambda's deployed execution role and forward STS-issued temp credentials " +
          "to the container so the handler runs with the deployed function's narrow permissions " +
          '(closes the "developer admin / function narrow" skew). Off by default — when omitted, ' +
          "the developer's shell credentials are forwarded unchanged (SAM-compatible default)."
      )
    )
    .addOption(
      new Option(
        '--from-state',
        'Read cdkd S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub ' +
          'in env vars with the deployed physical IDs / attributes. ' +
          'Off by default — keep PR 1 warn-and-drop semantics; turn on for stacks already deployed via cdkd deploy.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the cdkd state record to read (used with --from-state when the same stack name has state in multiple regions).'
      )
    )
    .action(withErrorHandling(localInvokeCommand));

  // Reuse standard option blocks. State options are added so --from-state
  // can read the cdkd state bucket (PR 2).
  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    invoke.addOption(opt)
  );
  invoke.addOption(deprecatedRegionOption);

  local.addCommand(invoke);
  local.addCommand(createLocalStartApiCommand());
  local.addCommand(createLocalRunTaskCommand());
  return local;
}
