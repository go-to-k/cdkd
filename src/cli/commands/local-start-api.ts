import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  startApiServer,
  type ServerState,
  type StartedApiServer,
} from '../../local/http-server.js';
import {
  availableApiIdentifiers,
  filterRoutesByApiIdentifier,
  groupRoutesByServer,
  type ApiServerGroup,
} from '../../local/api-server-grouping.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import { resolveLambdaLayers, type ResolvedLambdaLayer } from '../../local/lambda-resolver.js';
import { matchStacks } from '../stack-matcher.js';
import { buildCorsConfigByApiId, type CorsConfig } from '../../local/cors-handler.js';
import {
  attachStageContext,
  buildStageMap,
  type ResolvedStage,
} from '../../local/stage-resolver.js';
import { createFileWatcher, type FileWatcher } from '../../local/file-watcher.js';
import { type NextStateMaterial } from '../../local/reload-orchestrator.js';
import {
  attachAuthorizers,
  type AuthorizerInfo,
  type RouteWithAuth,
} from '../../local/authorizer-resolver.js';
import { createAuthorizerCache } from '../../local/authorizer-cache.js';
import {
  buildCognitoJwksUrl,
  buildJwksUrlFromIssuer,
  createJwksCache,
} from '../../local/cognito-jwt.js';
import { singleFlight } from '../../utils/single-flight.js';

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
  /** IP the host uses to bind/probe the RIE port (default 127.0.0.1). */
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
  /**
   * Issue #260: filter the discovered API surface to a single API by its
   * logical id (or, for Function URLs, the backing Lambda's logical id).
   * When unset, every discovered API gets its own server / port.
   */
  api?: string;
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
 * PR 8b additions:
 *   - Authorizers: REST v1 Lambda TOKEN/REQUEST + Cognito User Pool;
 *     HTTP v2 Lambda REQUEST + JWT. Allow → claims/context flow into
 *     `event.requestContext.authorizer`. Deny → 401/403 written without
 *     invoking the route handler. Cognito / JWT verification falls back
 *     to pass-through mode when the JWKS endpoint is unreachable.
 *   - VPC-config Lambdas surface a startup warn line: the local
 *     container does NOT get attached to the deployed VPC.
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
 * Still deferred: WebSocket APIs.
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
  // PR 6 (#232): track every tmpdir created by layer merging too —
  // `materializeLambdaLayers(...)` produces one merged tmpdir per
  // Lambda whose `Properties.Layers` contains 2+ entries (single-
  // layer Lambdas bind-mount the layer's asset dir directly).
  // Cleaned up alongside `inlineTmpDirs` in `shutdown(...)`. Hot
  // reload (PR 8c) reuses this same set across reload firings; on
  // each `synthesizeAndBuild` re-run we record the new merged
  // tmpdirs (the previous iteration's entries stay behind until
  // shutdown — a follow-up PR can prune them per-reload, but the
  // shutdown path is the single owner of cleanup so leaks are
  // bounded by server lifetime).
  const layerTmpDirs = new Set<string>();
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

  // PR 8b: per-server-lifecycle caches. Constructed once at server
  // startup; persisted across hot reloads (PR 8c) so authorizer
  // verdicts and JWKS keys aren't re-fetched on every reload. The
  // jwksWarnedUrls Set ensures the pass-through warn fires at most
  // ONCE per JWKS URL per server lifecycle.
  const authorizerCache = createAuthorizerCache();
  const jwksCache = createJwksCache();
  const jwksWarnedUrls = new Set<string>();

  /**
   * One synth + discover + build pass. Returns the next-state
   * material. Reused on initial boot AND every hot-reload firing.
   * Failures bubble up — the orchestrator catches them and keeps the
   * old state; the initial boot lets them propagate so the CLI exits
   * with a clear error before "Server listening" is ever printed.
   *
   * PR 8b: also runs `attachAuthorizers` after route discovery so the
   * resulting `RouteWithAuth[]` carries every route's authorizer info.
   * Hot reload picks up authorizer-config changes via this re-run.
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

    // PR 8b: attach authorizer info to every route. Routes without an
    // authorizer pass through as `{route, authorizer: undefined}`.
    // Routes referencing an unsupported authorizer kind hard-fail here.
    let routesWithAuth = attachAuthorizers(targetStacks, routes);

    // Issue #260: `--api <id>` filter — restrict the discovered surface
    // to a single API. Useful when the user wants exactly one server
    // (e.g. to free other ports, or to focus testing on one API).
    if (options.api) {
      const filtered = filterRoutesByApiIdentifier(routesWithAuth, options.api);
      if (filtered.length === 0) {
        const available = availableApiIdentifiers(routesWithAuth).join(', ') || '(none)';
        throw new Error(
          `--api '${options.api}' did not match any discovered API. Available identifiers: ${available}.`
        );
      }
      routesWithAuth = filtered;
    }

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
    // Authorizer Lambdas are also pooled — they're invoked just like
    // route handlers (PR 8b).
    const lambdaIds = uniqueLambdaIds(routes, routesWithAuth);
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
        layerTmpDirs,
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

    return { routes: routesWithAuth, specs, corsConfigByApiId, stacks: targetStacks };
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
  // Initial assignment is safe (no reload race possible before any
  // server is even listening).
  lastAssetPaths.value = computeAssetPaths(initialMaterial.specs);

  // PR 8b: pre-warm JWKS for Cognito / JWT authorizers so the first
  // request doesn't pay the fetch latency. Failures fall through to
  // pass-through mode with the warn line documented in cognito-jwt.ts.
  await prewarmJwks(initialMaterial.routes, jwksCache);

  // PR 8b: VPC-config Lambdas warn at startup. cdkd does NOT block
  // these routes, but the developer should know the local container
  // reaches external services via the host's network rather than
  // through the deployed VPC's NAT / private subnets. Re-runs on hot
  // reload would be noisy; we emit this once at initial boot only.
  warnVpcConfigLambdas(initialMaterial.routes, initialMaterial.stacks ?? []);

  // RIE invoke timeout: 2x the slowest Lambda's Timeout, floor 30s.
  let maxTimeoutSec = 0;
  for (const spec of initialMaterial.specs.values()) {
    if (spec.lambda.timeoutSec > maxTimeoutSec) maxTimeoutSec = spec.lambda.timeoutSec;
  }
  const rieTimeoutMs = Math.max(30_000, maxTimeoutSec * 2 * 1000);

  const basePort = parseInt(options.port, 10);
  if (!Number.isFinite(basePort) || basePort < 0 || basePort > 65535) {
    throw new Error(`--port must be 0..65535 (got ${options.port}).`);
  }

  // Issue #260: one HTTP server per API. Group the routes by API surface
  // (HTTP API logical id / REST API logical id / Function URL backing
  // Lambda) and launch one `startApiServer` per group. Each server gets
  // its own ContainerPool (filtered to the Lambdas reachable from that
  // group's routes) so authorizers, CORS configs, and stage variables
  // are scoped to the correct API and never bleed across them.
  const initialGroups = groupRoutesByServer(initialMaterial.routes);
  // basePort is the FIRST server's port; subsequent servers get
  // basePort+1, basePort+2, ... When basePort is 0 every server
  // auto-allocates. Auto-allocation is fine even across multiple
  // servers because the OS picks distinct ports.
  const servers: BootedApiServer[] = [];
  let nextPort = basePort;
  for (const group of initialGroups) {
    const groupSpecs = filterSpecsForGroup(group, initialMaterial.specs);
    const groupPool = buildPool(groupSpecs);
    const groupState: ServerState = {
      routes: group.routes,
      pool: groupPool,
      corsConfigByApiId: initialMaterial.corsConfigByApiId,
    };
    // Optional pre-warm: one container per Lambda, in parallel.
    if (options.warm) {
      logger.info(`Pre-warming ${groupSpecs.size} container(s) for ${group.displayName}...`);
      const handles = await Promise.allSettled(
        [...groupSpecs.keys()].map((id) => groupPool.acquire(id))
      );
      for (const result of handles) {
        if (result.status === 'fulfilled') {
          groupPool.release(result.value);
        } else {
          logger.warn(
            `Pre-warm failed for one Lambda in ${group.displayName} (cold start cost will apply on first request): ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          );
        }
      }
    }
    const started = await startApiServer({
      state: groupState,
      rieTimeoutMs,
      host: options.host,
      // Increment per server; basePort=0 leaves every server on auto-alloc.
      port: basePort === 0 ? 0 : nextPort,
      authorizerCache,
      jwksCache,
      jwksWarnedUrls,
    });
    servers.push({ group, server: started });
    if (basePort !== 0) nextPort += 1;
  }

  printPerServerRouteTables(servers);
  logger.info(
    `Per-Lambda concurrency: ${perLambdaConcurrency} (override with --per-lambda-concurrency)`
  );
  // D8.4 — load-bearing: verify.sh greps for this exact prefix.
  // Emit one line per server so verify.sh / users can match each API to
  // its port.
  for (const { group, server } of servers) {
    process.stdout.write(
      `Server listening on http://${server.host}:${server.port}  (${group.displayName})\n`
    );
  }
  process.stdout.write('^C to stop and clean up containers.\n');

  // PR 8c (extended for issue #260 to span N servers): hot reload
  // (`--watch`). For N-server topology we serialize re-synth ONCE per
  // watcher event, then per-server filter the material + swap state.
  // Adding/removing an entire API across a reload is not supported —
  // the user is warned and the server set stays static until restart.
  let watcher: FileWatcher | undefined;
  let reloadChain: Promise<unknown> = Promise.resolve();
  if (options.watch) {
    const initialWatchPaths = [options.output, ...lastAssetPaths.value];
    watcher = createFileWatcher({
      paths: initialWatchPaths,
      onChange: () => {
        logger.info('Detected file change; reloading...');
        const next = reloadChain.then(() =>
          reloadAllServers({
            synthesizeAndBuild,
            servers,
            buildPool,
            computeAssetPaths,
            lastAssetPaths,
            watcher,
            output: options.output,
            logger,
          })
        );
        reloadChain = next.catch(() => undefined);
      },
    });
    logger.info(`Watching ${options.output} (and ${lastAssetPaths.value.length} asset dir(s))`);
  }

  // Graceful shutdown: SIGINT / SIGTERM / uncaughtException /
  // unhandledRejection all run the same dispose path. Double-^C
  // bypasses dispose and exits immediately so the user can escape a
  // hung Docker daemon.
  //
  // Single-flight contract (closes the SIGINT-during-SIGTERM /
  // double-signal race): the actual cleanup body is wrapped in
  // `singleFlight(...)` so a second signal that lands while the first
  // shutdown is still draining `pool.dispose()` awaits the same
  // promise instead of starting a parallel run against the shared
  // `servers` / `inlineTmpDirs` / `layerTmpDirs` cells (which would
  // otherwise double-`server.close()` and corrupt the
  // mid-iteration tmpdir set). The first signal's `signal` + `exitCode`
  // win — subsequent signals' arguments are intentionally dropped.
  // The double-^C force-exit feature is preserved by tracking the
  // started + completed state separately from the in-flight cleanup.
  let shutdownStarted = false;
  let firstSignal: string | undefined;
  let firstExitCode = 0;
  let forceExitArmed = false;
  const runCleanup = singleFlight(async (): Promise<void> => {
    logger.info(`Received ${firstSignal}, shutting down...`);
    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        logger.warn(`watcher.close() failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Close every server in parallel, then dispose every (possibly hot-
    // reload-swapped) pool. Each pool's dispose() waits for in-flight
    // requests to drain; running them in parallel is the right shape
    // even for N servers because shutdown is signalled to all at once.
    await Promise.allSettled(
      servers.map(async ({ server, group }) => {
        try {
          await server.close();
        } catch (err) {
          logger.warn(
            `server.close() failed for ${group.displayName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );
    await Promise.allSettled(
      servers.map(async ({ server, group }) => {
        try {
          await server.getServerState().pool.dispose();
        } catch (err) {
          logger.warn(
            `pool.dispose() failed for ${group.displayName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );
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
    for (const dir of layerTmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `Failed to remove merged-layers tmpdir ${dir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  });
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shutdownStarted) {
      if (!forceExitArmed) {
        forceExitArmed = true;
        logger.warn(
          `Received second ${signal}; force-exiting. Orphan containers may remain — run 'docker ps --filter name=cdkd-local-' and 'docker rm -f' to clean up.`
        );
        process.exit(130);
      }
      return;
    }
    shutdownStarted = true;
    firstSignal = signal;
    firstExitCode = exitCode;
    await runCleanup();
    process.exit(firstExitCode);
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
 * discovered route OR referenced by a Lambda authorizer attached to one
 * of those routes. Stable order = first-occurrence order in the routes
 * list, then any newly-introduced authorizer Lambdas, which keeps the
 * route-table output deterministic.
 */
function uniqueLambdaIds(
  routes: readonly DiscoveredRoute[],
  routesWithAuth: readonly RouteWithAuth[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of routes) {
    if (!seen.has(r.lambdaLogicalId)) {
      seen.add(r.lambdaLogicalId);
      out.push(r.lambdaLogicalId);
    }
  }
  for (const entry of routesWithAuth) {
    const auth = entry.authorizer;
    if (!auth) continue;
    if (auth.kind === 'lambda-token' || auth.kind === 'lambda-request') {
      if (!seen.has(auth.lambdaLogicalId)) {
        seen.add(auth.lambdaLogicalId);
        out.push(auth.lambdaLogicalId);
      }
    }
  }
  return out;
}

/**
 * Prefetch the JWKS for every Cognito / JWT authorizer attached to a
 * discovered route. Failures degrade to pass-through mode (verifier
 * surfaces a warn line on first hit); we still issue the prefetch so
 * the warn lands at startup rather than mid-request.
 */
async function prewarmJwks(
  routesWithAuth: readonly RouteWithAuth[],
  jwksCache: import('../../local/cognito-jwt.js').JwksCache
): Promise<void> {
  const urls = new Set<string>();
  for (const entry of routesWithAuth) {
    const auth = entry.authorizer;
    if (!auth) continue;
    if (auth.kind === 'cognito') {
      urls.add(buildCognitoJwksUrl(auth.region, auth.userPoolId));
    } else if (auth.kind === 'jwt') {
      const url =
        auth.region && auth.userPoolId
          ? buildCognitoJwksUrl(auth.region, auth.userPoolId)
          : buildJwksUrlFromIssuer(auth.issuer);
      urls.add(url);
    }
  }
  await Promise.all([...urls].map((u) => jwksCache.fetchAndCache(u)));
}

/**
 * Emit a one-line warn for every VPC-config Lambda. The handler still
 * runs locally, but its container does not get attached to the AWS
 * VPC's subnets — calls to private RDS / ElastiCache will fail. cdkd
 * surfaces this so the developer can pin the unexpected behavior to
 * the VPC config rather than chasing a "connection refused" rabbit
 * hole.
 */
function warnVpcConfigLambdas(
  routesWithAuth: readonly RouteWithAuth[],
  stacks: readonly StackInfo[]
): void {
  const logger = getLogger();
  // Walk every reachable Lambda (route handler + authorizer) once.
  const seen = new Set<string>();
  const reachable: string[] = [];
  for (const entry of routesWithAuth) {
    if (!seen.has(entry.route.lambdaLogicalId)) {
      seen.add(entry.route.lambdaLogicalId);
      reachable.push(entry.route.lambdaLogicalId);
    }
    const auth: AuthorizerInfo | undefined = entry.authorizer;
    if (auth && (auth.kind === 'lambda-token' || auth.kind === 'lambda-request')) {
      if (!seen.has(auth.lambdaLogicalId)) {
        seen.add(auth.lambdaLogicalId);
        reachable.push(auth.lambdaLogicalId);
      }
    }
  }
  for (const logicalId of reachable) {
    for (const stack of stacks) {
      const resource = stack.template.Resources?.[logicalId];
      if (!resource || resource.Type !== 'AWS::Lambda::Function') continue;
      const props = resource.Properties ?? {};
      const vpcConfig = props['VpcConfig'];
      if (vpcConfig && typeof vpcConfig === 'object' && Object.keys(vpcConfig).length > 0) {
        logger.warn(
          `Lambda ${logicalId} has VpcConfig — local container will reach external services via the host's network, NOT through the deployed VPC's NAT/private subnets. Calls to private RDS/ElastiCache will fail. See docs/cli-reference.md (cdkd local start-api — Limitations) for details.`
        );
      }
      break;
    }
  }
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
  /**
   * The caller's set of merged-layers tmpdirs (PR 6 of #224, issue
   * #232). Every multi-layer Lambda's `materializeLambdaLayers(...)`
   * call records its merged tmpdir here so `shutdown(...)` can remove
   * each one. Single-layer Lambdas bind-mount the layer's asset dir
   * directly and never write into this set.
   */
  layerTmpDirs: Set<string>;
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
    layerTmpDirs,
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

  // PR 6 (#232): pre-resolve the `/opt` bind-mount source. Single-
  // layer functions reuse the layer's asset dir directly; multi-
  // layer functions get a freshly-merged tmpdir (later layers
  // overwrite earlier files via `cpSync({force:true})` — the
  // load-bearing half of AWS's "last layer wins" semantic).
  const optDir = materializeLambdaLayers(lambda.layers, layerTmpDirs);

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
    ...(optDir !== undefined && { optDir }),
    ...(debugPort !== undefined && { debugPort }),
  };
  return spec;
}

/**
 * Build the `/opt` bind-mount source for a Lambda's layers. Mirrors
 * the helper in `src/cli/commands/local-invoke.ts` but stores the
 * merged tmpdir into the shared `layerTmpDirs` set so the server's
 * graceful shutdown path can clean it up. Returns `undefined` when
 * the function declares no layers.
 *
 * Three branches:
 *   - 0 layers → `undefined` (no `/opt` mount).
 *   - 1 layer → bind-mount the layer's asset dir directly (no copy).
 *   - 2+ layers → copy each into a fresh tmpdir IN ORDER (later
 *     layers overwrite earlier files via `cpSync({force: true})`),
 *     bind-mount the tmpdir at `/opt`. Records the tmpdir in
 *     `layerTmpDirs` so `shutdown(...)` removes it.
 *
 * AWS Lambda's actual runtime extracts every layer ZIP into `/opt`
 * in template order — the merge mirrors that. Docker rejects multiple
 * `-v ...:/opt:ro` entries at the same target, so cdkd can't rely on
 * overlay layering and must produce a single merged dir on the host.
 */
function materializeLambdaLayers(
  layers: { logicalId: string; assetPath: string }[],
  layerTmpDirs: Set<string>
): string | undefined {
  if (layers.length === 0) return undefined;
  if (layers.length === 1) return layers[0]!.assetPath;
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-start-api-layers-'));
  for (const layer of layers) {
    // `recursive: true` enables the directory copy. `force: true`
    // implements AWS's "last layer wins" file-collision semantic: a
    // later layer's entry at the same relative path overwrites the
    // earlier one.
    //
    // **Contract pinned (Node 20+)**: this call relies on `fs.cpSync`
    // defaults that the integ-test fixture (`tests/integration/local-
    // invoke-layers/`) exercises end-to-end, and that future
    // refactors must NOT silently drop:
    //   - `mode` defaults to preserving the source's file-mode bits,
    //     including `+x`. AWS layers commonly ship executable scripts
    //     under `bin/` and a handler that runs `/opt/bin/<script>`
    //     would otherwise fail with "Permission denied".
    //   - `verbatimSymlinks` defaults to true on Node 20+; symlinks
    //     are copied as symlinks (not dereferenced), matching AWS's
    //     layer-ZIP extraction into `/opt`.
    // Mirrors the same contract pinned in `local-invoke.ts`'s
    // `materializeLambdaLayers`; keep the two call sites in sync if
    // they ever consolidate into one helper.
    cpSync(layer.assetPath, dir, { recursive: true, force: true });
  }
  layerTmpDirs.add(dir);
  return dir;
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
  /**
   * Same-stack `Properties.Layers` references resolved to local asset
   * directories (PR 6 of #224, issue #232). Empty `[]` when the function
   * declares no layers. Order is preserved from the template (last layer
   * wins on file collision per AWS).
   */
  layers: ResolvedLambdaLayer[];
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
    // PR 6 (#232): same-stack `Properties.Layers` references resolve to
    // local asset directories that bind-mount at `/opt`; start-api
    // routes through the same lambda-resolver helper as `cdkd local
    // invoke` so the warm container pool gets layer support out of
    // the box.
    const layers = resolveLambdaLayers(stack, logicalId, props);
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
      layers,
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
function printRouteTable(routes: readonly RouteWithAuth[]): void {
  const flat = routes.map((r) => r.route);
  const sorted = [...flat].sort((a, b) => {
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

/**
 * One booted HTTP server tied to a single API surface (issue #260).
 * The CLI keeps an array of these to drive per-server route tables,
 * shutdown, and hot-reload state swaps.
 */
interface BootedApiServer {
  readonly group: ApiServerGroup;
  readonly server: StartedApiServer;
}

/**
 * Filter the global Lambda spec map to just the Lambdas reachable from
 * one API server group. The container pool for that server is built
 * from this filtered map so per-API authorizer Lambdas + route
 * handlers stay scoped to their owning server — disposing one server's
 * pool on shutdown does NOT touch another server's still-warm
 * containers.
 *
 * Also includes any authorizer Lambdas attached to the group's routes
 * (a Lambda authorizer is a Lambda the pool needs to know about, even
 * though no route directly handles `lambdaLogicalId === auth.lambdaLogicalId`).
 */
function filterSpecsForGroup(
  group: ApiServerGroup,
  allSpecs: Map<string, ContainerSpec>
): Map<string, ContainerSpec> {
  const ids = new Set<string>();
  for (const rwa of group.routes) {
    ids.add(rwa.route.lambdaLogicalId);
    const auth = rwa.authorizer;
    if (auth && (auth.kind === 'lambda-token' || auth.kind === 'lambda-request')) {
      ids.add(auth.lambdaLogicalId);
    }
  }
  const out = new Map<string, ContainerSpec>();
  for (const id of ids) {
    const spec = allSpecs.get(id);
    if (spec) out.set(id, spec);
  }
  return out;
}

/**
 * Print one route table per server, with the server's display name as
 * the section header. Replaces the pre-issue #260 single flat table —
 * users now see exactly which routes belong to which API + port.
 */
function printPerServerRouteTables(servers: readonly BootedApiServer[]): void {
  for (const { group, server } of servers) {
    process.stdout.write(`\n${group.displayName}  (http://${server.host}:${server.port})\n`);
    printRouteTable(group.routes);
  }
}

/**
 * One reload cycle for the multi-server topology (issue #260). The
 * watcher serializes calls via a chain promise; this function:
 *
 *   1. Re-runs `synthesizeAndBuild()` once (failure → warn + keep
 *      previous version serving on every server).
 *   2. Re-groups the new routes by API server key.
 *   3. For each existing server, swaps state to the new group's
 *      routes + a freshly-built pool filtered to that group's
 *      Lambdas. Disposes the previous pool in the background.
 *   4. Warns about new groups (= an API was added in CDK code) and
 *      vanished groups (= an API was removed) — those require a
 *      server restart in v1.
 */
async function reloadAllServers(args: {
  synthesizeAndBuild: () => Promise<NextStateMaterial>;
  servers: readonly BootedApiServer[];
  buildPool: (specs: Map<string, ContainerSpec>) => ContainerPool;
  computeAssetPaths: (specs: Map<string, ContainerSpec>) => string[];
  lastAssetPaths: { value: string[] };
  watcher: FileWatcher | undefined;
  output: string;
  logger: ReturnType<typeof getLogger>;
}): Promise<void> {
  const {
    synthesizeAndBuild,
    servers,
    buildPool,
    computeAssetPaths,
    lastAssetPaths,
    watcher,
    output,
    logger,
  } = args;
  let material: NextStateMaterial;
  try {
    material = await synthesizeAndBuild();
  } catch (err) {
    logger.warn(
      `cdk synth failed during reload; keeping previous version. (${err instanceof Error ? err.message : String(err)})`
    );
    return;
  }
  const newGroups = groupRoutesByServer(material.routes);
  const newByKey = new Map(newGroups.map((g) => [g.serverKey, g] as const));
  const oldKeys = new Set(servers.map((s) => s.group.serverKey));
  const newKeys = new Set(newByKey.keys());

  // Warn on add/remove — v1 requires restart for topology changes.
  const added = [...newKeys].filter((k) => !oldKeys.has(k));
  const removed = [...oldKeys].filter((k) => !newKeys.has(k));
  if (added.length > 0) {
    logger.warn(
      `Reload detected new API surface(s): ${added.join(', ')}. Restart 'cdkd local start-api' to serve them.`
    );
  }
  if (removed.length > 0) {
    logger.warn(
      `Reload detected removed API surface(s): ${removed.join(', ')}. Their servers will keep serving stale routes until restart.`
    );
  }

  // Per-server: filter material → build pool → swap state → dispose old.
  for (const booted of servers) {
    const group = newByKey.get(booted.group.serverKey);
    if (!group) continue; // removed — skip swap, server keeps stale state until restart
    const groupSpecs = filterSpecsForGroup(group, material.specs);
    const newPool = buildPool(groupSpecs);
    const newState: ServerState = {
      routes: group.routes,
      pool: newPool,
      corsConfigByApiId: material.corsConfigByApiId,
    };
    const previousState = booted.server.setServerState(newState);
    // Dispose the previous pool in the background. `pool.dispose()`
    // waits for in-flight requests to drain (30s per-entry cap).
    void previousState.pool.dispose().catch((err) => {
      logger.debug(
        `Previous pool dispose() failed for ${group.displayName}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  // Update the watcher's asset-path list AFTER all swaps complete.
  lastAssetPaths.value = computeAssetPaths(material.specs);
  if (watcher) {
    watcher.update([output, ...lastAssetPaths.value]);
  }
  // Re-print the per-server route table when any routes changed.
  // Cheap heuristic: always re-print after a successful reload — the
  // user is watching for the diff and a stable table reassures them
  // that the swap landed.
  printPerServerRouteTables(servers);
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
      'Run a long-running local HTTP server that maps API Gateway routes (REST v1, HTTP API, Function URL) to Lambda invocations against the AWS Lambda Runtime Interface Emulator (Docker required). Supports Lambda TOKEN/REQUEST authorizers and Cognito User Pool / HTTP v2 JWT authorizers; when JWKS is unreachable, JWT authorizers fall back to pass-through (every token accepted) with a warn line — local dev fallback. VPC-config Lambdas run locally and surface a warn line at startup; their containers do NOT get attached to the deployed VPC subnets, so calls to private RDS / ElastiCache will fail.'
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
        'IP the host uses to bind/probe the RIE port (must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames). Defaults to 127.0.0.1.'
      ).default('127.0.0.1')
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
    .addOption(
      new Option(
        '--api <id>',
        "Restrict to a single API surface by its logical id (HTTP API / REST API logical id, or the backing Lambda's logical id for Function URLs). When unset, every discovered API gets its own server on its own port (basePort, basePort+1, ... when --port is set; auto-allocated otherwise)."
      )
    )
    .action(withErrorHandling(localStartApiCommand));

  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => startApi.addOption(opt));
  startApi.addOption(deprecatedRegionOption);

  return startApi;
}
