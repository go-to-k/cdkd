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
import { createContainerPool, type ContainerSpec } from '../../local/container-pool.js';
import { startApiServer } from '../../local/http-server.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import { resolveLambdaLayers, type ResolvedLambdaLayer } from '../../local/lambda-resolver.js';
import { matchStacks } from '../stack-matcher.js';
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
}

/**
 * `cdkd local start-api` — long-running local HTTP server that maps
 * synthesized API routes to Lambda invocations against the AWS Lambda
 * Runtime Interface Emulator (Docker required).
 *
 * Modeled on `sam local start-api` but reusing cdkd's synthesis /
 * route-discovery / container plumbing. v1 scope (PR 8a):
 *   - REST v1 (AWS::ApiGateway::*) + HTTP API (AWS::ApiGatewayV2::*) +
 *     Function URL (AWS::Lambda::Url).
 *   - AWS_PROXY integrations only.
 *   - No authorizers, no CORS preflight, no hot reload, no stage
 *     variables, no WebSocket APIs (deferred to PR 8b / 8c).
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

  // Synthesize.
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

  // Pick the target stack — single-stack auto-detect or `--stack` filter
  // mirrors `cdkd local invoke`'s behavior (D4 lineage).
  const targetStacks = pickTargetStacks(stacks, options.stack);
  if (targetStacks.length === 0) {
    throw new Error('No stacks matched. Pass --stack <name> or run from a single-stack app.');
  }

  // Discover routes. Hard-error on any unsupported integration; the
  // server will not start in a half-working state.
  const routes = discoverRoutes(targetStacks);
  if (routes.length === 0) {
    throw new Error(
      'No supported API routes were discovered. cdkd local start-api supports AWS::ApiGateway::* (REST v1), AWS::ApiGatewayV2::* (HTTP), and AWS::Lambda::Url (Function URL) with AWS_PROXY integrations only.'
    );
  }

  // Attach authorizer info to every route. Routes without an authorizer
  // pass through as `{route, authorizer: undefined}`. Routes referencing
  // an unsupported authorizer kind hard-fail here.
  const routesWithAuth = attachAuthorizers(targetStacks, routes);

  // Build the per-Lambda spec map. Every reachable logical ID is
  // resolved to its asset / inline code, env vars, optional STS creds
  // (--assume-role), optional --debug-port reservation. The container
  // pool then knows everything it needs to lazy-start a fresh one.
  // Authorizer Lambdas are also pooled — they're invoked just like
  // route handlers (PR 8b).
  const lambdaIds = uniqueLambdaIds(routes, routesWithAuth);
  const overrides = readEnvOverridesFile(options.envVars);
  const debugPortBase = options.debugPortBase ? parseDebugPort(options.debugPortBase) : undefined;
  const specs = new Map<string, ContainerSpec>();
  // Track every tmpdir created by `materializeInlineCode` so the
  // graceful-shutdown path removes them. Long-running servers (this
  // command) would otherwise leak one tmpdir per inline-`Code.ZipFile`
  // Lambda per server invocation.
  const inlineTmpDirs = new Set<string>();
  // PR 6 (#232): track every tmpdir created by layer merging too —
  // `materializeLambdaLayers(...)` produces one merged tmpdir per
  // Lambda whose `Properties.Layers` contains 2+ entries (single-
  // layer Lambdas bind-mount the layer's asset dir directly).
  // Cleaned up alongside `inlineTmpDirs` in `shutdown(...)`.
  //
  // FORWARD-LOOK (PR 8c — hot reload): when the watcher re-runs
  // `materializeLambdaLayers(...)` after a layer asset changes, it
  // MUST `rmSync` the corresponding old entry in this set BEFORE the
  // re-merge produces a new tmpdir, then drop the old entry. Without
  // that, every reload leaks one tmpdir until the server exits.
  // The watcher implementation is intentionally NOT touched here —
  // PR 8c owns the watch path; this comment exists so the next
  // reviewer sees the contract before extending the watcher.
  const layerTmpDirs = new Set<string>();
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
  const distinctImages = new Set<string>();
  for (const spec of specs.values()) {
    distinctImages.add(resolveRuntimeImage(spec.lambda.runtime));
  }
  for (const image of distinctImages) {
    await pullImage(image, options.pull === false);
  }

  const perLambdaConcurrency = parsePerLambdaConcurrency(options.perLambdaConcurrency);
  const pool = createContainerPool(specs, {
    perLambdaConcurrency,
    skipPull: options.pull === false,
  });

  // Optional pre-warm: one container per Lambda, in parallel.
  if (options.warm) {
    logger.info(`Pre-warming ${specs.size} container(s)...`);
    const handles = await Promise.allSettled([...specs.keys()].map((id) => pool.acquire(id)));
    for (const result of handles) {
      if (result.status === 'fulfilled') {
        pool.release(result.value);
      } else {
        logger.warn(
          `Pre-warm failed for one Lambda (cold start cost will apply on first request): ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
    }
  }

  // RIE invoke timeout: 2x the slowest Lambda's Timeout, floor 30s.
  let maxTimeoutSec = 0;
  for (const spec of specs.values()) {
    if (spec.lambda.timeoutSec > maxTimeoutSec) maxTimeoutSec = spec.lambda.timeoutSec;
  }
  const rieTimeoutMs = Math.max(30_000, maxTimeoutSec * 2 * 1000);

  const port = parseInt(options.port, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be 0..65535 (got ${options.port}).`);
  }

  // PR 8b: per-route authorizer pass.
  const authorizerCache = createAuthorizerCache();
  const jwksCache = createJwksCache();
  // Single Set constructed once at server startup. The verifier inside
  // cognito-jwt.ts adds each JWKS URL whose fetch failed (pass-through
  // mode) on the first request that hits it; subsequent requests find
  // the URL already in the Set and the warn line is suppressed. Pre-fix
  // the Set was undefined at the call site so the warn fired every
  // request.
  const jwksWarnedUrls = new Set<string>();
  // Pre-warm JWKS for Cognito / JWT authorizers so the first request
  // doesn't pay the fetch latency. Failures fall through to pass-through
  // mode with the warn line documented in cognito-jwt.ts.
  await prewarmJwks(routesWithAuth, jwksCache);
  // VPC-config Lambdas: warn at startup. cdkd does NOT block these
  // routes, but the developer should know the local container reaches
  // external services via the host's network rather than through the
  // deployed VPC's NAT / private subnets.
  warnVpcConfigLambdas(routesWithAuth, targetStacks);

  const server = await startApiServer({
    routes: routesWithAuth,
    pool,
    rieTimeoutMs,
    host: options.host,
    port,
    authorizerCache,
    jwksCache,
    jwksWarnedUrls,
  });

  printRouteTable(routes);
  logger.info(
    `Per-Lambda concurrency: ${perLambdaConcurrency} (override with --per-lambda-concurrency)`
  );
  // D8.4 — load-bearing: verify.sh greps for this exact prefix.
  process.stdout.write(`Server listening on http://${server.host}:${server.port}\n`);
  process.stdout.write('^C to stop and clean up containers.\n');

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
    try {
      await server.close();
    } catch (err) {
      logger.warn(`server.close() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await pool.dispose();
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
    for (const dir of layerTmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `Failed to remove merged-layers tmpdir ${dir}: ${err instanceof Error ? err.message : String(err)}`
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
    .action(withErrorHandling(localStartApiCommand));

  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => startApi.addOption(opt));
  startApi.addOption(deprecatedRegionOption);

  return startApi;
}
