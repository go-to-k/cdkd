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
import { resolveApp } from '../config-loader.js';
import { createLocalStateProvider } from './local-state-source.js';
import {
  resolveLambdaTarget,
  type ResolvedImageLambda,
  type ResolvedLambda,
  type ResolvedLambdaLayer,
  type ResolvedZipLambda,
} from '../../local/lambda-resolver.js';
import { materializeLayerFromArn } from '../../local/layer-arn-materializer.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import {
  substituteEnvVarsFromStateAsync,
  type StateEnvSubstitutionAudit,
  type SubstitutionContext,
} from '../../local/state-resolver.js';
import { derivePartitionAndUrlSuffix } from '../../local/ecs-task-resolver.js';
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
import { singleFlight } from '../../utils/single-flight.js';
import type { StackState } from '../../types/state.js';
import { createLocalStartApiCommand, resolveProfileCredentials } from './local-start-api.js';
import { createLocalRunTaskCommand } from './local-run-task.js';
import { createLocalStartServiceCommand } from './local-start-service.js';

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
   * Optional Lambda execution role to assume before invoking. When set,
   * cdkd calls `sts:AssumeRole` against the resolved ARN and forwards
   * the resulting temporary credentials into the container so the
   * handler runs under the deployed function's narrow permissions
   * (instead of the developer's typically-admin shell credentials).
   *
   * Commander's `[arn]` syntax maps to `string | boolean` here:
   *   - flag absent → `undefined` (pass dev creds through; SAM-compatible default)
   *   - `--assume-role` (bare) → `true` (auto-resolve from state; requires `--from-state`)
   *   - `--assume-role <arn>` → `'<arn>'` (explicit ARN; precedence wins)
   *   - `--no-assume-role` → `false` (explicit opt-out; forces dev creds even with `--from-state`)
   *
   * Auto-resolve walks the function's `Properties.Role` in cdkd state
   * (`Fn::GetAtt: [<RoleId>, 'Arn']` is resolved against the sibling
   * IAM Role resource's `attributes.Arn`; literal ARNs pass through).
   * STS failures degrade to a warn + dev-creds fallback — this is a
   * developer-loop tool, not a security boundary.
   */
  assumeRole?: string | boolean;
  /**
   * Issue #448: explicit role to `sts:AssumeRole` into before calling
   * `lambda:GetLayerVersion` for every literal-ARN entry in a Lambda's
   * `Properties.Layers`. Required only when the dev's default
   * credentials cannot read the layer — typically cross-account layers
   * (AWS-published `public` layers like Lambda Powertools are readable
   * from every account and need no role).
   *
   * Independent of `--assume-role`: that flag scopes the Lambda
   * handler's runtime AWS calls, this flag scopes only the layer-fetch
   * step. Carrying it on a separate switch keeps the cross-account
   * layer use case decoupled from the rest of the credential plumbing.
   */
  layerRoleArn?: string;
  /**
   * Optional role ARN passed to `pullEcrImage` when the IMAGE ECR-pull
   * path fires (no matching cdk.out asset and `Code.ImageUri` is an ECR
   * URI). Used to authenticate against a centralized / cross-account
   * registry whose `ecr:GetAuthorizationToken` permission is granted to
   * the assumed role rather than the developer's identity. Closes #455.
   * When omitted, cdkd uses the default credential chain (which is
   * sufficient for same-account pulls AND for cross-account pulls when
   * the ECR repository's resource policy grants the caller directly).
   */
  ecrRoleArn?: string;
  /**
   * PR 2: when set, cdkd reads its S3 state for the target stack and
   * substitutes intrinsic-valued env vars (`Ref` / `Fn::GetAtt` /
   * `Fn::Sub`) with the deployed physical IDs / attributes. Closes the
   * "intrinsic-valued env vars are dropped" gap that PR 1 left
   * explicit. Off by default — PR 1 behavior is preserved when the
   * flag is not set.
   */
  fromState: boolean;
  /**
   * Issue #606: alternative state source for CDK apps deployed via the
   * upstream CDK CLI (`cdk deploy` → CloudFormation). Reads the named
   * CFn stack via `DescribeStackResources` to populate physical IDs.
   * Mutually exclusive with `--from-state`. Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true` (use the cdkd stack name)
   *   - `--from-cfn-stack <name>` → `'<name>'`
   */
  fromCfnStack?: string | boolean;
  stateBucket?: string;
  statePrefix: string;
  /**
   * Region of the state record to read. Required when the same stack
   * name has state in multiple regions. Mirrors `cdkd state show
   * --stack-region`. Also drives the CFn client's region when
   * `--from-cfn-stack` is set (issue #606 — no separate
   * `--cfn-stack-region` flag).
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
   *
   * Wrapped in `singleFlight(...)` so a ^C that lands during the outer
   * `finally`'s normal unwind awaits the in-flight cleanup instead of
   * launching a parallel run against the shared `containerId` /
   * `stopLogs` / `imagePlan` cells (which would risk double
   * `docker rm -f` and corrupt mid-iteration mutation of `imagePlan`).
   */
  const cleanup = singleFlight(
    async (): Promise<void> => {
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
      if (imagePlan?.layerArnTmpDirs) {
        for (const dir of imagePlan.layerArnTmpDirs) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            getLogger().debug(
              `Failed to remove ARN-layer tmpdir ${dir}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      }
    },
    (err) => {
      getLogger().debug(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  );

  try {
    // The role-arn helper accepts an optional region for the SDK fallback;
    // any AWS calls invoked indirectly (e.g. STS during synthesis context
    // probing) will pick up the assumed credentials.
    await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

    await ensureDockerAvailable();

    // Issue #657: when `--profile <p>` is set, resolve the profile to a
    // concrete credential set ONCE up-front so it can be overlaid onto
    // the Lambda container's env after `forwardAwsEnv` (which only reads
    // `process.env.AWS_*` — empty for SSO / IAM Identity Center / fromIni
    // profiles). Same fix shape as PR #655 (issue #654) for the
    // `cdkd local start-api` family; the helper itself is exported from
    // `local-start-api.ts` and shared. Resolved once per invoke
    // (per the issue spec: "ONCE per invoke (NOT per-container)").
    const profileCredentials = options.profile
      ? await resolveProfileCredentials(options.profile)
      : undefined;

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
      // Threaded so the macro-expander has a real state bucket for the
      // > 51,200-byte template upload path when a stack carries a
      // CloudFormation macro (Issue #463).
      ...(options.stateBucket && { stateBucket: options.stateBucket }),
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
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
    //
    // PR #294 follow-up (issue #293): when `--from-state` is set AND the
    // function's template env contains any intrinsic value, build a
    // `SubstitutionContext` carrying both the deployed `resources` map
    // AND a `pseudoParameters` bag so `Fn::Join` / `Fn::Sub` bodies that
    // splice `${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
    // `${AWS::URLSuffix}` resolve cleanly. The pseudo bag is sourced from
    // the resolved region (`--region` > AWS_REGION > AWS_DEFAULT_REGION >
    // synth-derived stack region) + a single `sts:GetCallerIdentity` call.
    // Mirrors the ECS run-task implementation so both `cdkd local *
    // --from-state` paths share semantics.
    let stateAudit: StateEnvSubstitutionAudit | undefined;
    let templateEnv = getTemplateEnv(lambda.resource);
    let stateForRoleHint: StackState | undefined;
    // Issue #606: pick the right LocalStateProvider for the supplied
    // flags. `--from-state` and `--from-cfn-stack` are mutually
    // exclusive — the helper throws when both are set. Returns
    // `undefined` when neither is set (skip the substitution pass
    // entirely; PR 1 warn-and-drop behavior is preserved).
    const stateProvider = createLocalStateProvider(
      options,
      lambda.stack.stackName,
      lambda.stack.region
    );
    if (stateProvider) {
      try {
        const loaded = await stateProvider.load(lambda.stack.stackName, lambda.stack.region);
        if (loaded) {
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
          `Override it with --env-vars (e.g. {"${lambda.logicalId}":{"${key}":"<literal>"}}), or pass --from-state (cdkd-deployed) / --from-cfn-stack (cdk-deployed) to recover deployed values.`
      );
    }

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
      resolvedAssumeRoleArn = options.assumeRole;
    } else if (options.assumeRole === true) {
      // Bare `--assume-role` — must have state to resolve the ARN.
      if (!stateForRoleHint) {
        logger.warn(
          '--assume-role passed without an ARN, but no cdkd state was loaded. ' +
            'Pair it with --from-state, or pass the ARN explicitly: --assume-role <arn>. ' +
            "Falling back to the developer's shell credentials."
        );
      } else {
        const arn = resolveExecutionRoleArnFromState(stateForRoleHint, lambda.logicalId);
        if (arn) {
          resolvedAssumeRoleArn = arn;
          logger.info(`--assume-role: auto-resolved execution role from cdkd state: ${arn}`);
        } else {
          logger.warn(
            `--assume-role: could not resolve the execution role ARN from cdkd state for '${lambda.logicalId}'. ` +
              "Pass the ARN explicitly: --assume-role <arn>. Falling back to the developer's shell credentials."
          );
        }
      }
    } else if (options.assumeRole === undefined && options.fromState && stateForRoleHint) {
      // Legacy hint path: user did not opt in, but `--from-state` set; surface
      // the deployed role ARN so they can re-run with `--assume-role`.
      suggestAssumeRoleFromState(stateForRoleHint, lambda.logicalId);
    }
    // `options.assumeRole === false` (--no-assume-role) is an explicit opt-out
    // — skip every assume-role path entirely.

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
    // Swap the developer's credentials for STS-issued temporary credentials
    // scoped to the function's deployed execution role when one was resolved.
    // STS failures degrade to a warn + dev-creds fallback rather than hard
    // error — this is a developer-loop tool, not a security boundary, and
    // the most common cause is the role's `AssumeRolePolicy` not trusting
    // the developer's IAM principal (a config gap, not a cdkd bug).
    let assumeSucceeded = false;
    if (resolvedAssumeRoleArn) {
      const stsRegion =
        options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
      try {
        const creds = await assumeLambdaExecutionRole(resolvedAssumeRoleArn, stsRegion);
        dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
        dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
        dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
        if (stsRegion) dockerEnv['AWS_REGION'] = stsRegion;
        assumeSucceeded = true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(
          `--assume-role: STS AssumeRole(${resolvedAssumeRoleArn}) failed: ${reason}. ` +
            "Falling back to the developer's shell credentials."
        );
      }
    }
    if (!assumeSucceeded) {
      forwardAwsEnv(dockerEnv);
      // Issue #657: when `--profile <p>` was supplied AND assume-role
      // did not produce creds for this Lambda (either not asked for or
      // STS failed), overlay the profile-resolved {AKID, SAK,
      // sessionToken?} on top of whatever `forwardAwsEnv` copied from
      // `process.env`. See `applyProfileCredentialsOverlay`'s doc for
      // the full precedence table + session-token-strip rationale.
      applyProfileCredentialsOverlay(dockerEnv, profileCredentials, false);
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
      ...(imagePlan.tmpfs !== undefined && { tmpfs: imagePlan.tmpfs }),
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
  /**
   * Issue #448: per-ARN unzip tmpdirs for literal-ARN layers
   * (`Properties.Layers: ['arn:aws:lambda:...']`). One entry per ARN
   * layer regardless of whether multiple-layer merge fires above. The
   * CLI's outer `finally` walks the list with `rmSync` so the
   * downloaded layer ZIPs do not accumulate across invokes.
   */
  layerArnTmpDirs?: string[];
  /**
   * Sized tmpfs mount for `/tmp` (issue #440 — Lambda
   * `Properties.EphemeralStorage.Size`). Set when the function's
   * template declares `EphemeralStorage`; threaded through to
   * `runDetached`'s `tmpfs` option which emits
   * `--tmpfs /tmp:rw,size=<N>m`. Undefined when the property is
   * absent, in which case the container's `/tmp` is whatever the
   * base image provides (no cap). Applies to both ZIP and IMAGE
   * Lambdas.
   */
  tmpfs?: { target: string; sizeMb: number };
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
  //
  // Issue #448: literal-ARN layers (`{kind: 'arn', ...}`) are
  // pre-materialized via `lambda:GetLayerVersion` + presigned-URL
  // download + unzip BEFORE the same `cpSync`-merge path runs, so the
  // downstream code path is identical for asset-backed and ARN-backed
  // layers. The per-ARN unzip tmpdirs are tracked alongside the merged
  // `/opt` tmpdir so the outer cleanup can remove all of them.
  const layerPlan = await materializeLambdaLayersIncludingArns(lambda.layers, options);

  // provided.al2 / provided.al2023 require the deployment package at
  // /var/runtime (where the base image's hardcoded entrypoint exec's
  // /var/runtime/bootstrap); every other runtime expects /var/task.
  const containerCodePath = resolveRuntimeCodeMountPath(lambda.runtime);

  const tmpfs = resolveTmpfsForLambda(lambda);

  return {
    image,
    mounts: [{ hostPath: codeDir, containerPath: containerCodePath, readOnly: true }],
    extraMounts: layerPlan.mount ? [layerPlan.mount] : [],
    cmd: [lambda.handler],
    ...(inlineTmpDir !== undefined && { inlineTmpDir }),
    ...(layerPlan.tmpDir !== undefined && { layersTmpDir: layerPlan.tmpDir }),
    ...(layerPlan.extraTmpDirs.length > 0 && { layerArnTmpDirs: layerPlan.extraTmpDirs }),
    ...(tmpfs !== undefined && { tmpfs }),
  };
}

/**
 * Two-stage layer materialization (issue #448).
 *
 *   - Stage 1: every `{kind: 'arn'}` entry is downloaded + unzipped
 *     into its own tmpdir via `materializeLayerFromArn`. The per-ARN
 *     tmpdirs are tracked in `extraTmpDirs` so the outer cleanup can
 *     remove them.
 *   - Stage 2: the resulting `{logicalId, assetPath}[]` list (in
 *     template order — ARN entries surface their `arn` as the
 *     `logicalId` for log lines) is handed to the existing
 *     `materializeLambdaLayers` `cpSync`-merge path. AWS's "last layer
 *     wins" file-collision semantic is preserved across both layer
 *     kinds because the merge step is unchanged.
 */
export async function materializeLambdaLayersIncludingArns(
  layers: ResolvedLambdaLayer[],
  options: LocalInvokeOptions
): Promise<{
  mount?: { hostPath: string; containerPath: string; readOnly: boolean };
  tmpDir?: string;
  extraTmpDirs: string[];
}> {
  const extraTmpDirs: string[] = [];
  const flat: { logicalId: string; assetPath: string }[] = [];
  for (const layer of layers) {
    if (layer.kind === 'asset') {
      flat.push({ logicalId: layer.logicalId, assetPath: layer.assetPath });
      continue;
    }
    const dir = await materializeLayerFromArn(layer, {
      ...(options.layerRoleArn !== undefined && { roleArn: options.layerRoleArn }),
    });
    extraTmpDirs.push(dir);
    flat.push({ logicalId: layer.arn, assetPath: dir });
  }
  const plan = materializeLambdaLayers(flat);
  return { ...plan, extraTmpDirs };
}

/**
 * Build the `--tmpfs /tmp:rw,size=<N>m` plan for a Lambda (issue #440).
 *
 * The shape is identical for ZIP and IMAGE Lambdas — `--tmpfs` overlays
 * mount-time inside any container, regardless of whether the image is a
 * public Lambda base image (ZIP path) or a user-built container Lambda.
 * Returns `undefined` when the template did not declare
 * `EphemeralStorage`, in which case the caller emits no `--tmpfs` flag
 * and the container's `/tmp` is whatever the base image provides
 * (matches pre-#440 behavior). The lambda-resolver's
 * `extractEphemeralStorageMb` already enforces the AWS 10240 MiB
 * ceiling at parse time.
 *
 * Target path is always `/tmp` — AWS Lambda's `/tmp` is the ONLY
 * sized-tmpfs surface the `EphemeralStorage.Size` property controls,
 * and the constant is centralized here so a future fixture / docs
 * update has a single grep target.
 */
export function resolveTmpfsForLambda(
  lambda: ResolvedLambda
): { target: string; sizeMb: number } | undefined {
  if (lambda.ephemeralStorageMb === undefined) return undefined;
  const logger = getLogger();
  if (lambda.kind === 'image') {
    // Container Lambdas: surface the cap at info level so users notice
    // when `--tmpfs /tmp` overlays whatever their Dockerfile placed
    // there at build time. Matches the issue spec note about logging
    // a single line on container images.
    logger.info(
      `Lambda ${lambda.logicalId}: capping /tmp at ${lambda.ephemeralStorageMb} MiB via --tmpfs (overlays any base-image /tmp content)`
    );
  } else {
    // ZIP Lambdas: base image's /tmp is just an overlay-fs path, so
    // the cap is uneventful — debug-level keeps the default output clean.
    logger.debug(
      `Lambda ${lambda.logicalId}: applying EphemeralStorage cap via --tmpfs /tmp:size=${lambda.ephemeralStorageMb}m`
    );
  }
  return { target: '/tmp', sizeMb: lambda.ephemeralStorageMb };
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
      ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
    });
  }

  // PR 6 (#232): container Lambdas reject `Layers` at deploy time on
  // the AWS side — layers are baked into the image at build time, not
  // overlaid at runtime. The lambda-resolver normalizes `lambda.layers`
  // to `[]` for the IMAGE branch, so `extraMounts` is always empty here
  // (matches AWS's invoke-time behavior of silently ignoring layers on
  // container Lambdas).
  //
  // Issue #440 — `EphemeralStorage.Size` is honored uniformly across
  // ZIP and IMAGE Lambdas. `--tmpfs /tmp:size=Nm` overlays on top of
  // whatever the user's Dockerfile placed there at build time, so
  // there's no shape-divergence to gate on the `kind` discriminator.
  const tmpfs = resolveTmpfsForLambda(lambda);

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
    ...(tmpfs !== undefined && { tmpfs }),
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
 * Returns true when any value in the function's template env map is a
 * CFn intrinsic (non-primitive). Used to gate the `sts:GetCallerIdentity`
 * call inside the `--from-state` flow: literal-only env maps don't need
 * the pseudo-parameter bag and shouldn't pay for an STS hop. Mirrors the
 * ECS `containerHasIntrinsicEnvOrSecret` gating in `ecs-task-resolver.ts`.
 */
export function envHasIntrinsicValue(templateEnv: Record<string, unknown> | undefined): boolean {
  if (!templateEnv) return false;
  for (const v of Object.values(templateEnv)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') continue;
    return true;
  }
  return false;
}

/**
 * Returns true when any value in the function's template env map carries
 * a top-level `Fn::ImportValue` / `Fn::GetStackOutput` intrinsic. Used to
 * gate the cross-stack resolver construction inside the `--from-state`
 * flow: literal + same-stack-intrinsic env maps shouldn't pay for the
 * extra S3 client / index-load cost (issue #454).
 *
 * Detection is one level deep — same heuristic CDK 2.x uses for these
 * intrinsics in practice. Nested cross-stack intrinsics (e.g. an
 * `Fn::ImportValue` buried inside a `Fn::Join`) are not detected here;
 * those won't resolve in v1 anyway because the async resolver path
 * defers to the sync helper for `Fn::Join` / `Fn::Sub` bodies (see
 * `substituteAgainstStateAsync` docstring).
 */
export function envHasCrossStackIntrinsic(
  templateEnv: Record<string, unknown> | undefined
): boolean {
  if (!templateEnv) return false;
  for (const v of Object.values(templateEnv)) {
    if (!v || typeof v !== 'object') continue;
    const obj = v as Record<string, unknown>;
    if ('Fn::ImportValue' in obj || 'Fn::GetStackOutput' in obj) return true;
  }
  return false;
}

/**
 * Build the AWS pseudo-parameter bag for `--from-state` env-var
 * substitution. Issues a single `sts:GetCallerIdentity` for the account
 * id and derives `partition` / `urlSuffix` from the resolved region. Any
 * failure is reduced to a warn — the bag is best-effort and an empty
 * bag still works for env vars that only reference real logical IDs.
 *
 * Region precedence (mirrors `local-run-task`): `--region` > `AWS_REGION`
 * > `AWS_DEFAULT_REGION` > the synth-derived stack region.
 */
async function resolvePseudoParametersForInvoke(
  stackRegion: string | undefined,
  options: LocalInvokeOptions
): Promise<
  { accountId?: string; region?: string; partition?: string; urlSuffix?: string } | undefined
> {
  const logger = getLogger();
  const region =
    options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? stackRegion;
  if (!region) {
    logger.warn(
      '--from-state: resolver references ${AWS::Region} but cdkd could not determine the target region. ' +
        'Pass --region, set AWS_REGION, or declare env.region on the CDK stack.'
    );
  }
  let accountId: string | undefined;
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const sts = new STSClient({ ...(region && { region }) });
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account;
    } finally {
      sts.destroy();
    }
  } catch (err) {
    logger.warn(
      `--from-state: resolver needs \${AWS::AccountId} but STS GetCallerIdentity failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Substitution will be skipped; affected env entries will be dropped with per-key warnings.'
    );
  }
  const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
  const bag: {
    accountId?: string;
    region?: string;
    partition?: string;
    urlSuffix?: string;
  } = {
    ...(accountId !== undefined && { accountId }),
    ...(region !== undefined && { region }),
    ...(partitionAndSuffix && {
      partition: partitionAndSuffix.partition,
      urlSuffix: partitionAndSuffix.urlSuffix,
    }),
  };
  return Object.keys(bag).length === 0 ? undefined : bag;
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
 * Closes the "developer has admin creds, the deployed function has narrow
 * ones" skew that SAM users routinely hit. Off by default; opt-in via
 * `--assume-role <arn>` (explicit) or `--assume-role` (bare, auto-resolved
 * from cdkd state via `resolveExecutionRoleArnFromState`).
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
 * Issue #657: overlay `--profile <p>`-resolved credentials onto the
 * Lambda container's env block AFTER `forwardAwsEnv` has copied
 * `process.env.AWS_*`. The overlay covers SSO / IAM Identity Center /
 * fromIni / role-assumption profiles uniformly (resolved via the SDK's
 * default credential chain in `resolveProfileCredentials`). Without
 * this overlay, a dev who runs `cdkd local invoke --profile dev`
 * AND has no `AWS_ACCESS_KEY_ID` env var (the common SSO / Identity
 * Center case) sees the Lambda boot with no creds → handler's AWS SDK
 * call fails with `Could not load credentials from any providers`.
 *
 * Precedence (codifies existing semantics + this new layer):
 *   1. `--assume-role <arn>` (per-Lambda STS creds) — unchanged
 *   2. NEW: `--profile <p>` resolved + cached (this helper)
 *   3. `process.env.AWS_*` forwarded — when `--profile` not set
 *
 * Region from `forwardAwsEnv` is preserved — only the credential
 * triple is overlaid.
 *
 * When the resolved profile is long-lived (no `sessionToken`), any
 * inherited `AWS_SESSION_TOKEN` is stripped — a mismatched (long-
 * lived AKID + foreign session) would otherwise cause an SDK error
 * inside the container.
 *
 * No-op when `profileCreds` is `undefined` (profile not set) or when
 * `assumeRoleActive` is true (assume-role already won; its STS-issued
 * creds must not be clobbered by the profile overlay).
 *
 * Exported for unit-test isolation (see `local-invoke-profile-creds.test.ts`).
 */
export function applyProfileCredentialsOverlay(
  env: Record<string, string>,
  profileCreds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined,
  assumeRoleActive: boolean
): void {
  if (!profileCreds) return;
  if (assumeRoleActive) return;
  env['AWS_ACCESS_KEY_ID'] = profileCreds.accessKeyId;
  env['AWS_SECRET_ACCESS_KEY'] = profileCreds.secretAccessKey;
  if (profileCreds.sessionToken) {
    env['AWS_SESSION_TOKEN'] = profileCreds.sessionToken;
  } else {
    // The profile resolved to long-lived creds (no session token).
    // Strip any inherited session token to avoid the SDK trying to
    // use a mismatched (long-lived AKID + foreign session).
    delete env['AWS_SESSION_TOKEN'];
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
 * When `--from-state` is set but `--assume-role` was NOT passed (not even
 * bare), log the function's deployed execution role ARN once as a hint.
 * This is the pre-(#442) behavior — kept for backward compatibility with
 * users who don't want auto-assume. The bare-`--assume-role` path opts
 * in to actually assuming the resolved ARN; this hint path stays
 * informational only.
 */
function suggestAssumeRoleFromState(state: StackState, logicalId: string): void {
  const logger = getLogger();
  const roleArn = resolveExecutionRoleArnFromState(state, logicalId);
  if (roleArn) {
    logger.info(
      `Hint: the deployed function uses execution role ${roleArn}. ` +
        `Re-run with --assume-role to invoke under the deployed function's narrow permissions.`
    );
  }
}

/**
 * Resolve the execution-role ARN for a Lambda from cdkd state. Used by
 * both the `--assume-role` auto-resolve path and the legacy hint path.
 *
 * Resolution rules (mirrors the v1 scope spelled out in (#442)):
 *
 *   - Literal-string `Role` starting with `arn:` → returned verbatim.
 *   - `{ Fn::GetAtt: [<RoleId>, 'Arn'] }` or `{ Ref: <RoleId> }` → looked up
 *     against the sibling IAM Role resource's `attributes.Arn` (recorded
 *     at deploy time by `IAMRoleProvider.create` / drift refresh).
 *   - Any other shape (`Fn::Sub` / `Fn::Join` / cross-stack imports) → not
 *     resolved in v1; the caller surfaces a warn and falls back to dev
 *     creds. Once real CDK apps emit those shapes for `Role` we can
 *     extend the resolver per `feedback_verify_cdk_synth_shape_before_resolver.md`.
 *
 * Returns `undefined` when state has no entry for the Lambda, the `Role`
 * is missing entirely, the referenced sibling has no `Arn` attribute
 * captured, or the shape is one we don't try to resolve.
 *
 * Exported for unit testing.
 */
export function resolveExecutionRoleArnFromState(
  state: StackState,
  logicalId: string
): string | undefined {
  const lambda = state.resources[logicalId];
  if (!lambda) return undefined;

  const roleRef = lambda.properties?.['Role'] ?? lambda.observedProperties?.['Role'];
  if (typeof roleRef === 'string' && roleRef.startsWith('arn:')) {
    return roleRef;
  }
  if (typeof roleRef === 'object' && roleRef !== null) {
    const refLogicalId = pickReferencedLogicalId(roleRef as Record<string, unknown>);
    if (refLogicalId) {
      const roleResource = state.resources[refLogicalId];
      const cached = roleResource?.attributes?.['Arn'];
      if (typeof cached === 'string' && cached.startsWith('arn:')) {
        return cached;
      }
    }
  }
  return undefined;
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
        '--assume-role [arn]',
        "Assume the Lambda's deployed execution role and forward STS-issued temp credentials " +
          "to the container so the handler runs with the deployed function's narrow permissions " +
          '(closes the "developer admin / function narrow" skew). Three forms: ' +
          '(1) `--assume-role <arn>` assumes the explicit ARN; ' +
          "(2) `--assume-role` (bare) auto-resolves the function's execution role ARN from cdkd " +
          'state (requires --from-state); ' +
          '(3) `--no-assume-role` explicitly opts out (forces dev creds even with --from-state). ' +
          "Off by default — when omitted, the developer's shell credentials are forwarded " +
          'unchanged (SAM-compatible default). STS failures degrade to a warn + dev-creds fallback.'
      )
    )
    .addOption(
      new Option(
        '--layer-role-arn <arn>',
        'Role to sts:AssumeRole before calling lambda:GetLayerVersion on every literal-ARN ' +
          'entry in Properties.Layers (issue #448). Use only when the dev credentials cannot ' +
          'read the layer — typically cross-account layers. AWS-published public layers (e.g. ' +
          'Lambda Powertools) are readable from every account and need no role.'
      )
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
        '--from-state',
        'Read cdkd S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub ' +
          'in env vars with the deployed physical IDs / attributes. ' +
          'Off by default — keep PR 1 warn-and-drop semantics; turn on for stacks already deployed via cdkd deploy.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via DescribeStackResources and substitute Ref / Fn::ImportValue ' +
          'in env vars with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream ' +
          'CDK CLI (`cdk deploy`). Bare form uses the cdkd stack name; pass an explicit value when CFn stack name differs. ' +
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
  local.addCommand(createLocalStartServiceCommand());
  return local;
}
