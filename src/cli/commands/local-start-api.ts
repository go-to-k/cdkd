import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  parseAssumeRoleToken,
  effectiveAssumeRoleArn,
  type AssumeRoleOption,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import { resolveRuntimeFileExtension, resolveRuntimeImage } from '../../local/runtime-image.js';
import { ensureDockerAvailable, pullImage } from '../../local/docker-runner.js';
import { discoverRoutes, type DiscoveredRoute } from '../../local/route-discovery.js';
import {
  createContainerPool,
  type ContainerSpec,
  type ContainerPool,
} from '../../local/container-pool.js';
import { startApiServer, type ServerState } from '../../local/http-server.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import { matchStacks } from '../stack-matcher.js';
import { buildCorsConfigByApiId, type CorsConfig } from '../../local/cors-handler.js';
import {
  attachStageContext,
  buildStageMap,
  type ResolvedStage,
} from '../../local/stage-resolver.js';
import { createFileWatcher, type FileWatcher } from '../../local/file-watcher.js';
import {
  createReloadOrchestrator,
  type NextStateMaterial,
  type Orchestrator,
} from '../../local/reload-orchestrator.js';

interface LocalStartApiOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  /** Bind port (default 0 = auto-allocate). */
  port: string;
  /** Bind host (default 127.0.0.1). */
  host: string;
  /** Stack pattern (single-stack apps auto-detect). */
  stack?: string;
  /** Pre-warm one container per Lambda at server boot. */
  warm: boolean;
  /** Pool size cap per Lambda (default 2, max 4). */
  perLambdaConcurrency: string;
  /** Skip docker pull for images. */
  pull: boolean;
  /** Hostname/IP the container reaches the host on (default host.docker.internal). */
  containerHost: string;
  /** First Node.js inspector port; allocated contiguously per Lambda when set. */
  debugPortBase?: string;
  envVars?: string;
  /** D8.2: bare ARN (global) and/or `<LogicalId>=<arn>` (per-Lambda). */
  assumeRole?: AssumeRoleOption;
  /** PR 8c: enable hot reload on `cdk.out/` + asset-dir changes. */
  watch: boolean;
  /** PR 8c: select a Stage by `StageName`; default is the first attached. */
  stage?: string;
}

/**
 * `cdkd local start-api` — long-running local HTTP server that maps
 * synthesized API routes to Lambda invocations against the AWS Lambda
 * Runtime Interface Emulator (Docker required).
 *
 * Modeled on `sam local start-api` but reusing cdkd's synthesis /
 * route-discovery / container plumbing. PR 8a scope:
 *   - REST v1 (AWS::ApiGateway::*) + HTTP API (AWS::ApiGatewayV2::*) +
 *     Function URL (AWS::Lambda::Url).
 *   - AWS_PROXY integrations only.
 *
 * PR 8c additions (issue #235):
 *   - `--watch` enables hot reload on `cdk.out/` + asset-dir changes.
 *   - HTTP API v2 OPTIONS preflight is intercepted when the API has a
 *     `CorsConfiguration`; REST v1 CORS (Mock OPTIONS method) stays
 *     out of scope.
 *   - `event.stageVariables` is populated from the selected Stage's
 *     `Variables` / `StageVariables` map. `--stage <name>` selects a
 *     specific Stage by name; default is the first Stage attached.
 *
 * Still deferred: authorizers, VPC simulation, WebSocket APIs.
 *
 * See [docs/cli-reference.md](../../../docs/cli-reference.md) for the
 * full surface and out-of-scope items.
 */
async function localStartApiCommand(options: LocalStartApiOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  warnIfDeprecatedRegion(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  await ensureDockerAvailable();

  const appCmd = resolveApp(options.app);
  if (!appCmd) {
    throw new Error('No CDK app specified. Pass --app, set CDKD_APP, or add "app" to cdk.json.');
  }

  const overrides = readEnvOverridesFile(options.envVars);
  const debugPortBase = options.debugPortBase ? parseDebugPort(options.debugPortBase) : undefined;
  const perLambdaConcurrency = parsePerLambdaConcurrency(options.perLambdaConcurrency);
  // Track every tmpdir created by `materializeInlineCode` so the
  // graceful-shutdown path removes them. Long-running servers (this
  // command) would otherwise leak one tmpdir per inline-`Code.ZipFile`
  // Lambda per server invocation. Hot reload writes new tmpdirs into
  // the same set so the shutdown path is the single owner of cleanup.
  const inlineTmpDirs = new Set<string>();
  // Track every Lambda asset directory the server is currently
  // referencing; the file watcher uses this list to know what to
  // watch beyond `cdk.out/`. The value is updated AFTER the reload
  // orchestrator's atomic state swap completes (see the `.then(...)`
  // block on `orchestrator.reload()` below) — pre-fix, the assignment
  // happened mid-`synthesizeAndBuild`, so a concurrent file event
  // during a reload would call `watcher.update([...new asset dirs])`
  // while the server still serves the old state. Now the file
  // watcher's view of "what asset dirs to watch" stays in lockstep
  // with the server's state.
  const lastAssetPaths: { value: string[] } = { value: [] };

  /**
   * One synth + discover + build pass. Returns the next-state
   * material. Reused on initial boot AND every hot-reload firing.
   * Failures bubble up — the orchestrator catches them and keeps the
   * old state; the initial boot lets them propagate so the CLI exits
   * with a clear error before "Server listening" is ever printed.
   */
  const synthesizeAndBuild = async (): Promise<NextStateMaterial> => {
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

    const targetStacks = pickTargetStacks(stacks, options.stack);
    if (targetStacks.length === 0) {
      throw new Error('No stacks matched. Pass --stack <name> or run from a single-stack app.');
    }

    const routes = discoverRoutes(targetStacks);
    if (routes.length === 0) {
      throw new Error(
        'No supported API routes were discovered. cdkd local start-api supports AWS::ApiGateway::* (REST v1), AWS::ApiGatewayV2::* (HTTP), and AWS::Lambda::Url (Function URL) with AWS_PROXY integrations only.'
      );
    }

    // PR 8c: stage selection + variable injection. Build the per-API
    // Stage map for every target stack and attach it to the routes.
    // Stage selection is `--stage <name>` global override, otherwise
    // first-attached default. The CLI surfaces a warn line when
    // `--stage` was passed and at least one API doesn't have a Stage
    // with that name.
    const stageMap = new Map<string, ResolvedStage>();
    for (const stack of targetStacks) {
      const m = buildStageMap(stack.template, options.stage);
      for (const [k, v] of m) stageMap.set(k, v);
    }
    if (options.stage) {
      // Walk the routes looking for HTTP API v2 / REST v1 routes whose
      // API isn't in `stageMap` (i.e. the API had no Stage with the
      // override name). One warn per such API, deduplicated.
      const missingApis = new Set<string>();
      for (const r of routes) {
        if (!r.apiLogicalId) continue;
        if (!stageMap.has(r.apiLogicalId)) missingApis.add(r.apiLogicalId);
      }
      for (const apiId of missingApis) {
        logger.warn(
          `--stage '${options.stage}' did not match any Stage on API '${apiId}'; routes on that API will get stageVariables: null.`
        );
      }
    }
    attachStageContext(routes, stageMap);

    // PR 8c: per-API CORS config. HTTP API v2 only (REST v1 OPTIONS
    // Mock integrations are explicitly out of scope).
    const corsConfigByApiId = new Map<string, CorsConfig>();
    for (const stack of targetStacks) {
      const m = buildCorsConfigByApiId(stack.template);
      for (const [k, v] of m) corsConfigByApiId.set(k, v);
    }

    // Build the per-Lambda spec map. Every reachable logical ID is
    // resolved to its asset / inline code, env vars, optional STS creds
    // (--assume-role), optional --debug-port reservation. The container
    // pool then knows everything it needs to lazy-start a fresh one.
    const lambdaIds = uniqueLambdaIds(routes);
    const specs = new Map<string, ContainerSpec>();
    for (let i = 0; i < lambdaIds.length; i++) {
      const logicalId = lambdaIds[i]!;
      const spec = await buildContainerSpec({
        logicalId,
        stacks: targetStacks,
        overrides,
        assumeRole: options.assumeRole,
        containerHost: options.containerHost,
        ...(debugPortBase !== undefined && { debugPort: debugPortBase + i }),
        stsRegion: options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'],
        inlineTmpDirs,
      });
      specs.set(logicalId, spec);
    }

    // Pull every distinct image up front so the first request doesn't
    // pay the layer-pull cost. Mirrors `cdkd local invoke`'s pull pass.
    // NOTE: the watched-asset list (`lastAssetPaths.value`) is NOT
    // mutated here — the assignment happens AFTER the reload
    // orchestrator's atomic state swap completes. See the `.then(...)`
    // block on `orchestrator.reload()` below.
    const distinctImages = new Set<string>();
    for (const spec of specs.values()) {
      distinctImages.add(resolveRuntimeImage(spec.lambda.runtime));
    }
    for (const image of distinctImages) {
      await pullImage(image, options.pull === false);
    }

    return { routes, specs, corsConfigByApiId };
  };

  /**
   * Helper: build a {@link ContainerPool} from a spec map and tag it
   * with the spec map (via the non-enumerable `__cdkdSpecs` property)
   * so the reload orchestrator can compute spec diffs.
   */
  const buildPool = (specs: Map<string, ContainerSpec>): ContainerPool => {
    const pool = createContainerPool(specs, {
      perLambdaConcurrency,
      skipPull: options.pull === false,
    });
    Object.defineProperty(pool, '__cdkdSpecs', {
      value: specs,
      enumerable: false,
      configurable: true,
    });
    return pool;
  };

  /**
   * Compute the watched-asset list from a spec map. Pure helper —
   * keeps the side-effect (`lastAssetPaths.value = ...`) confined to
   * the post-swap call sites (initial boot + post-reload). `codeDir`
   * is either the unzipped asset directory or the inline-code tmpdir;
   * both are watch-worthy.
   */
  const computeAssetPaths = (specs: Map<string, ContainerSpec>): string[] => {
    const assetPaths = new Set<string>();
    for (const spec of specs.values()) {
      assetPaths.add(spec.codeDir);
    }
    return [...assetPaths];
  };

  // Initial boot.
  const initialMaterial = await synthesizeAndBuild();
  const initialPool = buildPool(initialMaterial.specs);
  // Initial assignment is safe (no reload race possible before the
  // server is even listening).
  lastAssetPaths.value = computeAssetPaths(initialMaterial.specs);

  // Optional pre-warm: one container per Lambda, in parallel.
  if (options.warm) {
    logger.info(`Pre-warming ${initialMaterial.specs.size} container(s)...`);
    const handles = await Promise.allSettled(
      [...initialMaterial.specs.keys()].map((id) => initialPool.acquire(id))
    );
    for (const result of handles) {
      if (result.status === 'fulfilled') {
        initialPool.release(result.value);
      } else {
        logger.warn(
          `Pre-warm failed for one Lambda (cold start cost will apply on first request): ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
    }
  }

  // RIE invoke timeout: 2x the slowest Lambda's Timeout, floor 30s.
  let maxTimeoutSec = 0;
  for (const spec of initialMaterial.specs.values()) {
    if (spec.lambda.timeoutSec > maxTimeoutSec) maxTimeoutSec = spec.lambda.timeoutSec;
  }
  const rieTimeoutMs = Math.max(30_000, maxTimeoutSec * 2 * 1000);

  const port = parseInt(options.port, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be 0..65535 (got ${options.port}).`);
  }

  const initialState: ServerState = {
    routes: initialMaterial.routes,
    pool: initialPool,
    corsConfigByApiId: initialMaterial.corsConfigByApiId,
  };
  const server = await startApiServer({
    state: initialState,
    rieTimeoutMs,
    host: options.host,
    port,
  });

  printRouteTable(initialMaterial.routes);
  logger.info(
    `Per-Lambda concurrency: ${perLambdaConcurrency} (override with --per-lambda-concurrency)`
  );
  // D8.4 — load-bearing: verify.sh greps for this exact prefix.
  process.stdout.write(`Server listening on http://${server.host}:${server.port}\n`);
  process.stdout.write('^C to stop and clean up containers.\n');

  // PR 8c: hot reload (`--watch`).
  let watcher: FileWatcher | undefined;
  let orchestrator: Orchestrator | undefined;
  if (options.watch) {
    orchestrator = createReloadOrchestrator({
      synthesizeAndBuild,
      buildPool,
      setServerState: server.setServerState,
      getServerState: server.getServerState,
    });
    const initialWatchPaths = [options.output, ...lastAssetPaths.value];
    watcher = createFileWatcher({
      paths: initialWatchPaths,
      onChange: () => {
        if (!orchestrator) return;
        logger.info('Detected file change; reloading...');
        void orchestrator
          .reload()
          .then((result) => {
            if (result.ok && watcher && result.newState) {
              // Pull the new pool's spec map (tagged via __cdkdSpecs by
              // buildPool) and recompute the watched-asset list AFTER
              // the orchestrator's atomic state swap. Pre-fix, the
              // mutation happened mid-`synthesizeAndBuild` — a
              // concurrent file event during reload would have called
              // `watcher.update(...)` against the new asset list while
              // the server still served the old state.
              const taggedSpecs = (
                result.newState.pool as unknown as {
                  __cdkdSpecs?: Map<string, ContainerSpec>;
                }
              ).__cdkdSpecs;
              if (taggedSpecs) {
                lastAssetPaths.value = computeAssetPaths(taggedSpecs);
              }
              // Update the watch list to follow new asset dirs.
              watcher.update([options.output, ...lastAssetPaths.value]);
              if (result.added.length > 0 || result.removed.length > 0) {
                printRouteTable(result.newState.routes);
              }
            }
          })
          .catch((err) => {
            logger.warn(
              `Reload failed: ${err instanceof Error ? err.message : String(err)}. Keeping previous version.`
            );
          });
      },
    });
    logger.info(`Watching ${options.output} (and ${lastAssetPaths.value.length} asset dir(s))`);
  }

  // Graceful shutdown: SIGINT / SIGTERM / uncaughtException /
  // unhandledRejection all run the same dispose path. Double-^C
  // bypasses dispose and exits immediately so the user can escape a
  // hung Docker daemon.
  let shuttingDown = false;
  let forceExitArmed = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      if (!forceExitArmed) {
        forceExitArmed = true;
        logger.warn(
          `Received second ${signal}; force-exiting. Orphan containers may remain — run 'docker ps --filter name=cdkd-local-' and 'docker rm -f' to clean up.`
        );
        process.exit(130);
      }
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        logger.warn(`watcher.close() failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await server.close();
    } catch (err) {
      logger.warn(`server.close() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      // Dispose the pool currently in the server state (which may have
      // been swapped via hot reload). The previous pool from each
      // reload was disposed in the background by the orchestrator.
      await server.getServerState().pool.dispose();
    } catch (err) {
      logger.warn(`pool.dispose() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Remove every tmpdir we materialized inline `Code.ZipFile` Lambdas
    // into. Each is `mkdtempSync(...)` under the OS tmpdir, so the only
    // owner of cleanup is this process. Best-effort: log + continue on
    // any per-dir failure.
    for (const dir of inlineTmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `Failed to remove inline-code tmpdir ${dir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 130);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.on('uncaughtException', (err) => {
    logger.error(
      `Uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
    );
    void shutdown('unhandledRejection', 1);
  });

  // Block forever — the signal handlers exit the process.
  await new Promise<never>(() => undefined);
}

/**
 * Match the `--stack` pattern (or single-stack auto-detect) to a list
 * of stacks the route-discovery walks. Mirrors the deploy/diff matcher
 * routing rules.
 */
function pickTargetStacks(stacks: StackInfo[], pattern: string | undefined): StackInfo[] {
  if (pattern) {
    return matchStacks(stacks, [pattern]);
  }
  if (stacks.length === 1) return stacks;
  if (stacks.length === 0) return [];
  // Multi-stack apps can be served as a union — every stack contributes
  // its routes — but for v1 we require an explicit selection so users
  // don't accidentally serve a side-stack's API.
  throw new Error(
    `Multi-stack app: pass --stack <name> to pick a target. Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
  );
}

/**
 * Distinct, stable list of Lambda logical IDs reachable through any
 * discovered route. Stable order = first-occurrence order in the
 * `routes` list, which keeps the route-table output deterministic.
 */
function uniqueLambdaIds(routes: readonly DiscoveredRoute[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of routes) {
    if (!seen.has(r.lambdaLogicalId)) {
      seen.add(r.lambdaLogicalId);
      out.push(r.lambdaLogicalId);
    }
  }
  return out;
}

/**
 * Build the per-Lambda container spec — code dir, env vars (template +
 * --env-vars overlay), STS-issued creds when --assume-role names this
 * Lambda, optional --debug-port reservation. Errors out with a clear
 * message if the Lambda's code can't be resolved (asset directory
 * missing, runtime not supported).
 */
async function buildContainerSpec(args: {
  logicalId: string;
  stacks: StackInfo[];
  overrides: EnvOverrideFile | undefined;
  assumeRole: AssumeRoleOption | undefined;
  containerHost: string;
  debugPort?: number;
  stsRegion: string | undefined;
  /**
   * The caller's set of materialized inline-code tmpdirs. Every dir
   * `materializeInlineCode` returns is also pushed here so the graceful
   * shutdown path can remove it. The set is shared across all calls
   * within one server boot.
   */
  inlineTmpDirs: Set<string>;
}): Promise<ContainerSpec> {
  const {
    logicalId,
    stacks,
    overrides,
    assumeRole,
    containerHost,
    debugPort,
    stsRegion,
    inlineTmpDirs,
  } = args;
  const lambda = resolveLambdaByLogicalId(logicalId, stacks);

  // Re-use `cdkd local invoke`'s materialization rules for inline
  // (Code.ZipFile) Lambdas; asset-backed Lambdas already point at an
  // unzipped CDK directory.
  const codeDir =
    lambda.codePath ??
    materializeInlineCode(
      lambda.handler,
      lambda.inlineCode ?? '',
      resolveRuntimeFileExtension(lambda.runtime),
      inlineTmpDirs
    );

  // Env vars: literal template values + --env-vars overlay. Intrinsic-
  // valued template entries are warned + dropped (matches PR 1 / 2
  // semantics; --from-state remains a `cdkd local invoke`-only flag in
  // v1, see deferred-features list).
  const templateEnv = getTemplateEnv(lambda.resource);
  const envResult = resolveEnvVars(logicalId, templateEnv, overrides);
  for (const key of envResult.unresolved) {
    getLogger().warn(
      `Lambda ${logicalId}: env var ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${logicalId}":{"${key}":"<literal>"}}) to surface a literal value.`
    );
  }

  const dockerEnv: Record<string, string> = {
    AWS_LAMBDA_FUNCTION_NAME: logicalId,
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(lambda.memoryMb),
    AWS_LAMBDA_FUNCTION_TIMEOUT: String(lambda.timeoutSec),
    AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
    AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${logicalId}`,
    AWS_LAMBDA_LOG_STREAM_NAME: 'local',
    ...envResult.resolved,
  };

  const roleArn = effectiveAssumeRoleArn(logicalId, assumeRole);
  if (roleArn) {
    const creds = await assumeLambdaExecutionRole(roleArn, stsRegion);
    dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
    dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
    dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
    if (stsRegion) dockerEnv['AWS_REGION'] = stsRegion;
  } else {
    forwardAwsEnv(dockerEnv);
  }

  if (debugPort !== undefined) {
    dockerEnv['NODE_OPTIONS'] = `--inspect-brk=0.0.0.0:${debugPort}`;
  }

  const spec: ContainerSpec = {
    lambda,
    codeDir,
    env: dockerEnv,
    containerHost,
    ...(debugPort !== undefined && { debugPort }),
  };
  return spec;
}

/**
 * Locate a Lambda by logical ID across the target stacks. Throws when
 * no stack contains a matching `AWS::Lambda::Function` — at this point
 * route discovery has already linked the routes to logical IDs, so a
 * miss here is a synthesis bug worth surfacing.
 */
interface ResolvedStartApiLambda {
  /**
   * `cdkd local start-api` v1 is ZIP-only — PR 5 introduced the
   * `kind: 'zip' | 'image'` discriminator on `ResolvedLambda` to support
   * container Lambdas in `cdkd local invoke`, but the start-api server
   * does not yet handle the per-Lambda image build / ECR pull / platform
   * threading that container Lambdas require. The discriminator is set
   * to `'zip'` here so this shape is structurally assignable to
   * `ResolvedZipLambda` (the type the container pool consumes).
   */
  kind: 'zip';
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
  runtime: string;
  handler: string;
  memoryMb: number;
  timeoutSec: number;
  codePath: string | null;
  inlineCode?: string;
}

function resolveLambdaByLogicalId(logicalId: string, stacks: StackInfo[]): ResolvedStartApiLambda {
  for (const stack of stacks) {
    const resource = stack.template.Resources?.[logicalId];
    if (!resource || resource.Type !== 'AWS::Lambda::Function') continue;
    const props = resource.Properties ?? {};
    const runtime = typeof props['Runtime'] === 'string' ? props['Runtime'] : '';
    const handler = typeof props['Handler'] === 'string' ? props['Handler'] : '';
    const memoryMb = typeof props['MemorySize'] === 'number' ? props['MemorySize'] : 128;
    const timeoutSec = typeof props['Timeout'] === 'number' ? props['Timeout'] : 3;
    if (!runtime) {
      throw new Error(
        `Lambda '${logicalId}' has no Runtime property. Container-image Lambdas (Code.ImageUri) are not supported in cdkd local start-api v1.`
      );
    }
    if (!handler) {
      throw new Error(`Lambda '${logicalId}' has no Handler property.`);
    }
    const code = (props['Code'] ?? {}) as Record<string, unknown>;
    const imageUri = code['ImageUri'];
    if (
      typeof imageUri === 'string' ||
      (typeof imageUri === 'object' && imageUri !== null && 'Fn::Sub' in imageUri)
    ) {
      throw new Error(
        `Lambda '${logicalId}' uses Code.ImageUri (container-image Lambda). 'cdkd local start-api' v1 supports ZIP Lambdas only — container-image support is deferred to a follow-up PR. Use 'cdkd local invoke' to exercise this function locally.`
      );
    }
    const inlineCode = typeof code['ZipFile'] === 'string' ? code['ZipFile'] : undefined;
    let codePath: string | null = null;
    if (!inlineCode) {
      codePath = resolveAssetCodePath(stack, logicalId, resource);
    }
    return {
      kind: 'zip',
      stack,
      logicalId,
      resource,
      runtime,
      handler,
      memoryMb,
      timeoutSec,
      codePath,
      ...(inlineCode !== undefined && { inlineCode }),
    };
  }
  throw new Error(
    `No AWS::Lambda::Function resource named '${logicalId}' found in target stacks. This is likely a synthesis bug — the route-discovery phase resolved a route to this logical ID.`
  );
}

/**
 * Locate the Lambda's local code directory using the CDK-blessed
 * `Metadata['aws:asset:path']` hint. Bind-mounted directly at
 * `/var/task` (read-only) by the docker-runner.
 */
function resolveAssetCodePath(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource
): string {
  const meta = resource.Metadata;
  const assetPath = meta?.['aws:asset:path'];
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    throw new Error(
      `Lambda '${logicalId}' has no Metadata['aws:asset:path']. cdkd local start-api needs this hint to find the local asset directory. Re-synthesize the app and retry.`
    );
  }
  const cdkOutDir = stack.assetManifestPath ? path.dirname(stack.assetManifestPath) : process.cwd();
  return path.isAbsolute(assetPath) ? assetPath : path.resolve(cdkOutDir, assetPath);
}

/**
 * Print the discovered route table to stdout. Format mirrors the spec
 * doc's example so verify.sh / users can read it at a glance.
 */
function printRouteTable(routes: readonly DiscoveredRoute[]): void {
  const sorted = [...routes].sort((a, b) => {
    if (a.pathPattern !== b.pathPattern) return a.pathPattern.localeCompare(b.pathPattern);
    return a.method.localeCompare(b.method);
  });
  const methodWidth = Math.max(...sorted.map((r) => r.method.length), 6);
  const pathWidth = Math.max(...sorted.map((r) => r.pathPattern.length), 8);
  process.stdout.write('Discovered routes:\n');
  for (const r of sorted) {
    const sourceLabel =
      r.source === 'http-api'
        ? 'HTTP API'
        : r.source === 'rest-v1'
          ? `REST v1, stage '${r.stage}'`
          : 'Function URL';
    process.stdout.write(
      `  ${r.method.padEnd(methodWidth)}  ${r.pathPattern.padEnd(pathWidth)}  -> ${r.lambdaLogicalId}  (${sourceLabel})\n`
    );
  }
  process.stdout.write('\n');
}

/**
 * Materialize an inline Lambda body (`Code.ZipFile`) to a tmpdir and
 * return the directory the container should mount at /var/task.
 * Mirrors `cdkd local invoke`'s implementation; the only divergence is
 * the long-running-server lifecycle: every tmpdir created here is
 * recorded in `tmpDirsOut` so the caller's shutdown path can `rmSync`
 * them. (`cdkd local invoke` runs once and `--rm` is the right model;
 * `cdkd local start-api` lives across requests, so leaks compound.)
 */
function materializeInlineCode(
  handler: string,
  source: string,
  fileExtension: string,
  tmpDirsOut: Set<string>
): string {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Handler '${handler}' is malformed: expected '<modulePath>.<exportName>'.`);
  }
  const modulePath = handler.substring(0, lastDot);
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-start-api-'));
  tmpDirsOut.add(dir);
  const filePath = path.join(dir, `${modulePath}${fileExtension}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, 'utf-8');
  return dir;
}

/** Pull `Properties.Environment.Variables` (when present). */
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

/** Read the SAM-shape `--env-vars` JSON file. */
function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
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
  return parsed as EnvOverrideFile;
}

/**
 * Forward the developer's AWS credentials into the container so the
 * handler's AWS SDK calls can authenticate. Used when --assume-role is
 * NOT set for that Lambda — SAM-compatible default.
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
 * Issue an STS AssumeRole and return temporary credentials. Mirrors
 * `cdkd local invoke`'s helper byte-for-byte; lifted here so the
 * start-api command stays self-contained.
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
        RoleSessionName: `cdkd-local-start-api-${Date.now()}`,
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
 * Parse / clamp the `--per-lambda-concurrency` flag. Above-cap values
 * are clamped to 4 with a warn line (per the spec doc's risk-mitigation
 * row).
 */
function parsePerLambdaConcurrency(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--per-lambda-concurrency must be a positive integer (got '${raw}')`);
  }
  if (parsed > 4) {
    getLogger().warn(
      `--per-lambda-concurrency ${parsed} exceeds the v1 cap of 4; clamping to 4. (Raise this in a follow-up PR if your workload needs more.)`
    );
    return 4;
  }
  return parsed;
}

/** Validate `--debug-port-base`. */
function parseDebugPort(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--debug-port-base must be 1..65535 (got '${raw}')`);
  }
  return parsed;
}

/**
 * Builder for the `start-api` subcommand. Wired up by `local.ts`.
 */
export function createLocalStartApiCommand(): Command {
  const startApi = new Command('start-api')
    .description(
      'Run a long-running local HTTP server that maps API Gateway routes (REST v1, HTTP API, Function URL) to Lambda invocations against the AWS Lambda Runtime Interface Emulator (Docker required).'
    )
    .addOption(
      new Option('--port <port>', 'HTTP server port (default: auto-allocate)').default('0')
    )
    .addOption(new Option('--host <host>', 'Bind address').default('127.0.0.1'))
    .addOption(new Option('--stack <name>', 'Stack to start (single-stack apps auto-detect)'))
    .addOption(
      new Option('--warm', 'Pre-start one container per Lambda at server boot').default(false)
    )
    .addOption(
      new Option(
        '--per-lambda-concurrency <n>',
        'Pool size cap per Lambda (default 2, max 4)'
      ).default('2')
    )
    .addOption(new Option('--no-pull', 'Skip docker pull (cached image)'))
    .addOption(
      new Option(
        '--container-host <host>',
        'Hostname/IP the container reaches the host on'
      ).default('host.docker.internal')
    )
    .addOption(
      new Option(
        '--debug-port-base <port>',
        'Reserve a contiguous --debug-port range (one per Lambda)'
      )
    )
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"LogicalId":{"KEY":"VALUE"}, "Parameters": {...}})'
      )
    )
    .addOption(
      new Option(
        '--assume-role <arn-or-pair>',
        "Assume the Lambda's execution role and forward STS-issued temp creds. Bare <arn> = global default; <LogicalId>=<arn> = per-Lambda override (repeatable). Per-Lambda > global > unset (developer creds passed through)."
      ).argParser((raw, prev: AssumeRoleOption | undefined) => parseAssumeRoleToken(raw, prev))
    )
    .addOption(
      new Option(
        '--watch',
        'Hot-reload: re-synth + re-discover routes when cdk.out/ or asset directories change. Off by default; the server keeps the previous version serving when synth fails mid-reload.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--stage <name>',
        "Select an API Gateway Stage by its 'StageName'. Default: the first Stage attached to each API. Drives event.stageVariables for both REST v1 and HTTP API v2. NOTE: For HTTP API v2 routes, requestContext.stage is always '$default' regardless of this flag (AWS-side limitation — HTTP API only exposes one stage to the integration event); only event.stageVariables is affected for v2 routes. For REST v1 routes the selected StageName is also threaded into requestContext.stage."
      )
    )
    .action(withErrorHandling(localStartApiCommand));

  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => startApi.addOption(opt));
  startApi.addOption(deprecatedRegionOption);

  return startApi;
}
