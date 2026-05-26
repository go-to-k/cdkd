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
  stateOptions,
  type AssumeRoleOption,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import {
  createLocalStateProvider,
  isCfnFlagPresent,
  rejectExplicitCfnStackWithMultipleStacks,
} from './local-state-source.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import type { StackState } from '../../types/state.js';
import {
  substituteEnvVarsFromState,
  type PseudoParameters,
  type SubstitutionContext,
} from '../../local/state-resolver.js';
import { derivePartitionAndUrlSuffix } from '../../local/ecs-task-resolver.js';
import { resolveRuntimeFileExtension, resolveRuntimeImage } from '../../local/runtime-image.js';
import { ensureDockerAvailable, pullImage } from '../../local/docker-runner.js';
import { architectureToPlatform, buildContainerImage } from '../../local/docker-image-builder.js';
import { parseEcrUri, pullEcrImage } from '../../local/ecr-puller.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../assets/asset-manifest-loader.js';
import type { DockerImageAssetSource } from '../../types/assets.js';
import { discoverRoutes, type DiscoveredRoute } from '../../local/route-discovery.js';
import {
  discoverWebSocketApis,
  type DiscoveredWebSocketApi,
} from '../../local/websocket-route-discovery.js';
import {
  attachWebSocketServer,
  handleManagementRequest,
  type AttachedWebSocketServer,
} from '../../local/websocket-server.js';
import { buildMgmtEndpointEnvUrl } from '../../local/websocket-mgmt-api.js';
import { HOST_GATEWAY_MIN_VERSION, probeHostGatewaySupport } from '../../local/docker-version.js';
import { warnSsrfRiskyUri } from '../../local/rest-v1-integrations.js';
import {
  createContainerPool,
  type ContainerSpec,
  type ContainerPool,
} from '../../local/container-pool.js';
import {
  startApiServer,
  readMtlsMaterialsFromDisk,
  type ServerState,
  type StartedApiServer,
  type MtlsServerConfig,
} from '../../local/http-server.js';
import {
  availableApiIdentifiers,
  filterRoutesByApiIdentifier,
  groupRoutesByServer,
  type ApiServerGroup,
} from '../../local/api-server-grouping.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import {
  extractEphemeralStorageMb,
  resolveLambdaLayers,
  type ResolvedLambdaLayer,
} from '../../local/lambda-resolver.js';
import { materializeLayerFromArn } from '../../local/layer-arn-materializer.js';
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
import { defaultCredentialsLoader, type CredentialsLoader } from '../../local/sigv4-verify.js';
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
  /**
   * Issue #448: role to sts:AssumeRole before calling
   * `lambda:GetLayerVersion` for every literal-ARN entry in any
   * routed Lambda's `Properties.Layers`. Independent of `--assume-role`
   * (which scopes the handler's runtime AWS calls). Use only when the
   * dev credentials cannot read the layer (cross-account case);
   * AWS-published public layers like Lambda Powertools need no role.
   */
  layerRoleArn?: string;
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
  /**
   * When set, cdkd reads its S3 state for each routed stack and
   * substitutes intrinsic-valued env vars (`Ref` / `Fn::GetAtt` /
   * `Fn::Sub` / `Fn::Join`) — including AWS pseudo parameters
   * (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
   * `${AWS::URLSuffix}`) — with the deployed physical IDs / attributes
   * before they reach the regular env-resolver. Mirrors
   * `cdkd local invoke --from-state` and `cdkd local run-task
   * --from-state`. Off by default — the pre-PR warn-and-drop behavior
   * is preserved when the flag is unset.
   */
  fromState: boolean;
  /**
   * Issue #606: alternative state source. Reads physical IDs from a
   * deployed CloudFormation stack via `DescribeStackResources` instead
   * of cdkd's S3 state. Mutually exclusive with `--from-state`.
   * Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true` (use the cdkd stack name per routed stack)
   *   - `--from-cfn-stack <name>` → `'<name>'` (single named CFn stack)
   */
  fromCfnStack?: string | boolean;
  /**
   * Opt-in: allow AWS_IAM SigV4 requests that cannot be cryptographically
   * verified (foreign access-key-id, or no local AWS credentials) to
   * pass through with a placeholder principalId. Default `false` (fail-
   * closed). Mirrors the `--allow-unverified-sigv4` CLI flag.
   */
  allowUnverifiedSigv4?: boolean;
  /**
   * S3 bucket holding cdkd state. Used only when `--from-state` is set.
   * Falls back to `CDKD_STATE_BUCKET` env / `cdk.json` / the default
   * `cdkd-state-{accountId}` bucket via `resolveStateBucketWithDefault`.
   */
  stateBucket?: string;
  /** S3 key prefix for state files. Used only when `--from-state` is set. */
  statePrefix: string;
  /**
   * Region of the state record to read. Required when the same stack
   * name has state in multiple regions. Used only when `--from-state`
   * is set.
   */
  stackRegion?: string;
  /**
   * Path to a PEM-encoded CA bundle. Client certificates that don't
   * chain to one of these CAs are rejected at the TLS handshake.
   * mTLS is enabled when ALL THREE `--mtls-truststore` / `--mtls-cert` /
   * `--mtls-key` flags are set; a partial set is a CLI-parse error.
   */
  mtlsTruststore?: string;
  /** Server-side mTLS certificate (PEM). Self-signed is fine for local dev. */
  mtlsCert?: string;
  /** Server-side mTLS private key (PEM). Must match `--mtls-cert`. */
  mtlsKey?: string;
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
async function localStartApiCommand(
  target: string | undefined,
  options: LocalStartApiOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Resolve the API filter: positional `<target>` wins over `--api`.
  // `--api` is kept as a backward-compat alias for one release cycle —
  // every invocation that goes through it emits a deprecation warn so
  // users see the migration path before the next major bump removes it.
  let apiFilter: string | undefined = target;
  if (options.api !== undefined) {
    if (target !== undefined) {
      throw new Error(
        `Cannot specify both positional target ('${target}') and --api flag ('${options.api}'). ` +
          `Use one or the other. The positional form is preferred — '--api' is a deprecated alias.`
      );
    }
    logger.warn(
      "[deprecated] --api <id> will be removed in a future major release. Use the positional argument instead: 'cdkd local start-api <id>'."
    );
    apiFilter = options.api;
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
  // #447: SigV4 verifier state for `AuthorizationType: 'AWS_IAM'` routes.
  // The credentials loader is constructed eagerly but the credential
  // chain itself is only hit on the first IAM-protected request — see
  // `defaultCredentialsLoader` for the caching contract.
  let sigV4CredentialsLoader: CredentialsLoader | undefined;
  const sigV4WarnedForeignIds = new Set<string>();

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
      // Threaded so the macro-expander has a real state bucket for the
      // > 51,200-byte template upload path when a stack carries a
      // CloudFormation macro (Issue #463).
      ...(options.stateBucket && { stateBucket: options.stateBucket }),
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
    };
    const { stacks } = await synthesizer.synthesize(synthOpts);

    const targetStacks = pickTargetStacks(stacks, options.stack);
    if (targetStacks.length === 0) {
      throw new Error('No stacks matched. Pass --stack <name> or run from a single-stack app.');
    }

    const routes = discoverRoutes(targetStacks);
    // #462: WebSocket APIs (ProtocolType: 'WEBSOCKET') are discovered
    // through a sibling pipeline so the resulting routes (keyed by
    // RouteKey rather than by method+path) stay structurally separate
    // from the HTTP / REST / Function URL `DiscoveredRoute[]`. Errors
    // are aggregated into the same boot-time warn pass so a malformed
    // WebSocket API does not abort sibling HTTP API boot.
    const wsDiscovery = discoverWebSocketApis(targetStacks);
    if (wsDiscovery.errors.length > 0) {
      for (const e of wsDiscovery.errors) {
        logger.warn(`WebSocket discovery: ${e}`);
      }
    }
    const webSocketApis = wsDiscovery.apis;
    if (routes.length === 0 && webSocketApis.length === 0) {
      throw new Error(
        'No supported API routes were discovered. cdkd local start-api supports AWS::ApiGateway::* (REST v1), AWS::ApiGatewayV2::* (HTTP + WebSocket), and AWS::Lambda::Url (Function URL) with AWS_PROXY integrations only.'
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

    // Issue #260: target filter — restrict the discovered surface to a
    // single API. Useful when the user wants exactly one server (e.g. to
    // free other ports, or to focus testing on one API).
    //
    // Strict multi-stack rejection for the bare-logical-id form (no `:`,
    // no `/`): mirrors `cdkd local invoke` / `cdkd local run-task`'s
    // resolver behavior. A bare id in a multi-stack app is ambiguous,
    // because two stacks can legitimately have the same logical id —
    // pre-PR the filter would silently match both and collide in
    // `groupRoutesByServer`'s serverKey (now disambiguated via PR 8d).
    // We reject upfront with the same disambiguation hint invoke uses.
    if (apiFilter !== undefined) {
      const isBareId = !apiFilter.includes(':') && !apiFilter.includes('/');
      if (isBareId && targetStacks.length > 1) {
        throw new Error(
          `Multiple stacks in app, target '${apiFilter}' is missing a stack prefix. ` +
            `Use 'StackName:${apiFilter}' or 'StackName/${apiFilter}' (Construct path form). ` +
            `Available stacks: ${targetStacks.map((s) => s.stackName).join(', ')}.`
        );
      }
      const filtered = filterRoutesByApiIdentifier(routesWithAuth, apiFilter);
      if (filtered.length === 0) {
        const available = availableApiIdentifiers(routesWithAuth).join(', ') || '(none)';
        throw new Error(
          `Target '${apiFilter}' did not match any discovered API. Available identifiers: ${available}.`
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

    // `--from-state` / `--from-cfn-stack` (issue #606): load deployed
    // state for every routed stack once per synth (= initial boot AND
    // every hot-reload firing). We do this outside the per-Lambda loop
    // so a stack with N reachable Lambdas only pays one state-load
    // round-trip. Pseudo parameters are also resolved once per stack —
    // STS GetCallerIdentity is account-wide so the bag is identical
    // across same-region stacks, but the partition / URL suffix can
    // differ if stacks span partitions. Per-stack failures degrade to
    // warn-and-fall-back (the PR 1 behavior is preserved) so a missing
    // or unreadable state file never aborts the server boot.
    const stateSourceActive = options.fromState || isCfnFlagPresent(options);
    const stateByStack = stateSourceActive
      ? await loadStateForRoutedStacks(targetStacks, routes, routesWithAuth, options)
      : new Map<string, StackStateBundle>();

    // Build the per-Lambda spec map. Every reachable logical ID is
    // resolved to its asset / inline code, env vars, optional STS creds
    // (--assume-role), optional --debug-port reservation. The container
    // pool then knows everything it needs to lazy-start a fresh one.
    // Authorizer Lambdas are also pooled — they're invoked just like
    // route handlers (PR 8b).
    const lambdaIds = uniqueLambdaIds(routes, routesWithAuth, webSocketApis);
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
        stateByStack,
        skipPull: options.pull === false,
        ...(options.layerRoleArn !== undefined && { layerRoleArn: options.layerRoleArn }),
      });
      specs.set(logicalId, spec);
    }

    // Pull every distinct base image up front so the first request
    // doesn't pay the layer-pull cost. Mirrors `cdkd local invoke`'s
    // pull pass. Only the ZIP branch needs a base-image pull here —
    // IMAGE-variant specs already have their per-Lambda image
    // resolved by `buildContainerSpec` (`resolveContainerImageForStartApi`
    // ran the local build or ECR pull before this point), so the
    // ContainerPool can `docker run` against it without any further
    // pull step. NOTE: the watched-asset list (`lastAssetPaths.value`)
    // is NOT mutated here — the assignment happens AFTER the reload
    // orchestrator's atomic state swap completes. See the `.then(...)`
    // block on `orchestrator.reload()` below.
    const distinctImages = new Set<string>();
    for (const spec of specs.values()) {
      if (spec.kind === 'zip') {
        distinctImages.add(resolveRuntimeImage(spec.lambda.runtime));
      }
    }
    for (const image of distinctImages) {
      await pullImage(image, options.pull === false);
    }

    return {
      routes: routesWithAuth,
      specs,
      corsConfigByApiId,
      webSocketApis,
      stacks: targetStacks,
    };
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
   * the post-swap call sites (initial boot + post-reload). For ZIP
   * Lambdas `codeDir` is either the unzipped asset directory or the
   * inline-code tmpdir; both are watch-worthy. IMAGE Lambdas
   * (`kind: 'image'`) don't have a host-side bind-mount source — the
   * code is baked into the docker image at build time. Their build
   * context (Dockerfile + source directory) is rebuilt on every
   * reload via `synthesizeAndBuild` → `buildContainerSpec` →
   * `resolveContainerImageForStartApi`, so a source edit DOES trigger
   * rebuild AND the deterministic `image` tag changes — but watching
   * the build-context dir explicitly here is deferred to a follow-up
   * (the watched-asset list is currently sourced from `cdk.out/`
   * which transitively covers most container-Lambda asset dirs since
   * `cdk synth` re-stages them on every synth call).
   */
  const computeAssetPaths = (specs: Map<string, ContainerSpec>): string[] => {
    const assetPaths = new Set<string>();
    for (const spec of specs.values()) {
      if (spec.kind === 'zip') {
        assetPaths.add(spec.codeDir);
      }
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

  // #447: AWS_IAM-protected routes warn at startup. The local server
  // verifies SigV4 signatures only — IAM policy evaluation (resource /
  // action / condition) is NOT emulated.
  //
  // The credentials loader is ALWAYS constructed at boot (not gated on
  // the initial template having IAM routes) so that hot-reload
  // (`--watch`) paths that ADD a new IAM route after boot have the
  // loader already wired up. The loader is internally lazy
  // (`defaultCredentialsLoader()` memoizes the actual STSClient +
  // credential resolution until first call), so unused boots pay zero
  // cost. Pre-fix the loader was conditionally constructed at this
  // point only when the initial template had IAM routes, which caused
  // post-hot-reload IAM routes to hit the http-server's defensive
  // "no SigV4 credentials loader configured — denying" deny path with
  // no explanation. PR #484 review MAJOR.
  sigV4CredentialsLoader = defaultCredentialsLoader();
  warnIamRoutes(initialMaterial.routes);

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

  // mTLS resolution: all-or-none. When any of the three flags is set,
  // ALL THREE must be set — partial flag sets are rejected at CLI-parse
  // time so the server never boots in a half-configured state. The TLS
  // handshake itself (in `https.createServer({requestCert: true,
  // rejectUnauthorized: true, ca, cert, key})`) enforces the
  // client-cert chain check against the CA bundle — there is no
  // per-request validation in cdkd's code path.
  const mtlsConfig: MtlsServerConfig | undefined = resolveMtlsConfig(options);
  if (mtlsConfig) {
    logger.info(
      'mTLS enabled: client certificates required (chain check against --mtls-truststore at TLS handshake).'
    );
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
    const defaultRegion =
      options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? undefined;
    const started = await startApiServer({
      state: groupState,
      rieTimeoutMs,
      host: options.host,
      ...(mtlsConfig && { mtls: mtlsConfig }),
      // Increment per server; basePort=0 leaves every server on auto-alloc.
      port: basePort === 0 ? 0 : nextPort,
      authorizerCache,
      jwksCache,
      jwksWarnedUrls,
      sigV4CredentialsLoader,
      sigV4WarnedForeignIds,
      sigV4AllowUnverified: options.allowUnverifiedSigv4 === true,
      // #458: surfaces as the per-route fallback region for HTTP API
      // v2 service integrations. Per-request `RequestParameters.Region`
      // overrides this — matches AWS API Gateway behavior.
      ...(defaultRegion && { defaultRegion }),
    });
    servers.push({ group, server: started });
    if (basePort !== 0) nextPort += 1;
  }

  // #462: WebSocket API server boot loop. One HTTP server per
  // discovered WebSocket API; each server hosts an upgrade-event
  // listener via `attachWebSocketServer` AND a pre-pass HTTP handler
  // for the `@connections/<id>` data plane. Lambda containers in the
  // pool are injected with `AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI`
  // pointing at the same port so `apigatewaymanagementapi:PostToConnection`
  // from inside the handler lands on cdkd's local endpoint.
  const wsServers: BootedWebSocketServer[] = [];
  const initialWsApis = initialMaterial.webSocketApis ?? [];
  warnUnsupportedWebSocketApis(initialWsApis, logger);

  // Issue #527 M2: probe Docker server version ONCE per session before
  // any WebSocket API attaches. The `--add-host=host.docker.internal:host-gateway`
  // mapping cdkd injects requires Docker 20.10+; older daemons silently
  // fail with `ENOTFOUND host.docker.internal` at SDK-call time. Only
  // probe when at least one ATTACHABLE WebSocket API exists — HTTP /
  // REST-only sessions don't use the host-gateway mapping and shouldn't
  // pay the docker subprocess hop. `unsupported`-tagged APIs are also
  // skipped (they never enter the attach loop).
  const attachableWsApis = initialWsApis.filter((api) => !api.unsupported);
  if (attachableWsApis.length > 0) {
    const probe = await probeHostGatewaySupport();
    if (!probe.supported) {
      throw new Error(
        `cdkd local start-api requires Docker ${HOST_GATEWAY_MIN_VERSION.major}.${HOST_GATEWAY_MIN_VERSION.minor}+ ` +
          `for WebSocket API support (--add-host=host.docker.internal:host-gateway needs the 20.10 host-gateway alias). ` +
          `Detected server version: ${probe.rawVersion || '<empty — daemon unreachable or output stripped>'}. ` +
          `Upgrade Docker, or remove the WebSocket API from this app to fall back to HTTP-only start-api.`
      );
    }
    if (probe.parsed === null) {
      logger.warn(
        `Docker server version "${probe.rawVersion}" did not match the canonical "<major>.<minor>" shape; ` +
          `assuming host-gateway support. If WebSocket containers fail to reach the local server, ` +
          `verify your Docker-compatible CLI honors --add-host=host.docker.internal:host-gateway.`
      );
    }
  }

  for (const api of initialWsApis) {
    // Skip APIs flagged unsupported at discovery — typical cause is a
    // non-NONE `AuthorizationType` on `$connect` (cdkd v1 does not
    // emulate WebSocket authorizers; admitting unauthenticated clients
    // would diverge from AWS-deployed behavior). The warn fired above
    // names the affected routes; here we just skip the attach loop so
    // no upgrade is accepted on this API.
    if (api.unsupported) continue;
    const wsLambdaIds = new Set(api.routes.map((r) => r.targetLambdaLogicalId));
    const wsSpecs = new Map<string, ContainerSpec>();
    for (const id of wsLambdaIds) {
      const spec = initialMaterial.specs.get(id);
      if (spec) wsSpecs.set(id, spec);
    }
    if (wsSpecs.size === 0) {
      logger.warn(
        `WebSocket API ${api.declaredAt}: no resolvable Lambda backing routes; skipping.`
      );
      continue;
    }
    const wsPool = buildPool(wsSpecs);
    const wsState: ServerState = {
      routes: [],
      pool: wsPool,
      corsConfigByApiId: new Map(),
    };
    // The HTTP server hosting the WebSocket also serves the
    // management-API `@connections/<id>` calls. Build the
    // {@link AttachedWebSocketServer} AFTER the http server is bound
    // so we know the port — needed to inject
    // `AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI` into every WebSocket
    // Lambda's env map BEFORE the pool starts the first container.
    const wsApiPath = `/${api.stage}`;
    // Forward-decl the registry pointer so the preDispatch closure
    // can read it once we attach below.
    let registryRef: AttachedWebSocketServer | undefined;
    const started = await startApiServer({
      state: wsState,
      rieTimeoutMs,
      host: options.host,
      port: basePort === 0 ? 0 : nextPort,
      authorizerCache,
      jwksCache,
      jwksWarnedUrls,
      sigV4WarnedForeignIds,
      sigV4AllowUnverified: options.allowUnverifiedSigv4 === true,
      preDispatch: async (req, res) => {
        if (!registryRef) return false;
        return handleManagementRequest(req, res, registryRef.registry);
      },
    });
    const attached = attachWebSocketServer({
      httpServer: started.server,
      pool: wsPool,
      rieTimeoutMs,
      apis: [{ api, apiPath: wsApiPath }],
    });
    registryRef = attached;

    // Inject the management-API endpoint URL into every WebSocket
    // Lambda's container env BEFORE any cold-start. The container
    // pool reads `spec.env` at `acquire()` time, so mutating the
    // shared map after the server is bound but before the first
    // request hits the route is correct. The mutation is per-Lambda:
    // only Lambdas backing this WebSocket API see the override; the
    // sibling HTTP / REST Lambdas' env maps stay untouched.
    //
    // Placeholder credentials: the AWS SDK v3 client constructor
    // requires SOME credentials to sign requests, even when the
    // endpoint override points at a local server that ignores
    // SigV4. When neither `--assume-role` nor inherited
    // `AWS_ACCESS_KEY_ID` etc. are set, the SDK errors with
    // `CredentialsProviderError: Could not load credentials from
    // any providers`. We populate fake credentials per the
    // ecs-network.ts metadata-sidecar precedent — cdkd's
    // `@connections` handler doesn't verify SigV4, so the values
    // are opaque.
    //
    // Endpoint hostname: the URL is consumed INSIDE the Lambda
    // container, so `127.0.0.1` would be the container's own
    // loopback — not the host. On Docker Desktop (macOS / Windows)
    // `host.docker.internal` resolves to the host. Linux native
    // dockerd doesn't expose this hostname by default but Docker
    // 20.10+ supports `--add-host=host.docker.internal:host-gateway`
    // at runtime; we forward that flag via `extraHostMappings` on
    // the container spec for every WebSocket Lambda so the URL
    // always resolves on every platform. The host port is the
    // local server's bound port.
    //
    // Stage path: the URL INCLUDES `/${api.stage}` to match the
    // AWS-docs-canonical handler shape. The deployed
    // apigatewaymanagementapi endpoint URL is
    // `https://<api-id>.execute-api.<region>.amazonaws.com/<stage>`,
    // so SDK clients built from `domainName + stage` produce
    // `POST /<stage>/@connections/<id>`. Mirror that exactly for the
    // env-var override path so handlers that build the SDK client
    // with `new ApiGatewayManagementApiClient({})` (and let the
    // SDK pick up the env override) AND handlers that build it
    // with the explicit `{endpoint: 'https://' + domainName + '/' + stage}`
    // shape both work without per-handler code differences.
    // The pre-fix endpoint dropped `/${stage}` and any SDK call
    // that included the stage segment hit a 404 against the local
    // parser.
    const mgmtEndpoint = buildMgmtEndpointEnvUrl('host.docker.internal', started.port, api.stage);
    const hostGatewayMapping: { host: string; ip: string }[] = [
      { host: 'host.docker.internal', ip: 'host-gateway' },
    ];
    for (const id of wsLambdaIds) {
      const spec = initialMaterial.specs.get(id);
      if (!spec) continue;
      spec.env['AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI'] = mgmtEndpoint;
      if (!spec.env['AWS_ACCESS_KEY_ID']) {
        spec.env['AWS_ACCESS_KEY_ID'] = 'AKIAIOSFODNN7EXAMPLE';
        spec.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      }
      // Ensure the SDK has a region — apigatewaymanagementapi
      // clients refuse to instantiate without one.
      if (!spec.env['AWS_REGION']) {
        spec.env['AWS_REGION'] =
          options.region ??
          process.env['AWS_REGION'] ??
          process.env['AWS_DEFAULT_REGION'] ??
          'us-east-1';
      }
      // Mutate the spec to include host.docker.internal mapping so
      // the Lambda's `apigatewaymanagementapi:PostToConnection` URL
      // resolves to the host's cdkd server on every OS (Linux native
      // dockerd does NOT auto-expose `host.docker.internal`; macOS /
      // Windows Docker Desktop does).
      const merged = [...(spec.extraHosts ?? []), ...hostGatewayMapping];
      spec.extraHosts = merged;
    }

    wsServers.push({ api, server: started, attached, apiPath: wsApiPath });
    if (basePort !== 0) nextPort += 1;
  }

  printPerServerRouteTables(servers);
  const allRoutes = servers.flatMap((s) => s.group.routes.map((r) => r.route));
  warnUnsupportedRoutes(allRoutes, logger);
  warnSsrfRiskyIntegrations(allRoutes, logger);
  logger.info(
    `Per-Lambda concurrency: ${perLambdaConcurrency} (override with --per-lambda-concurrency)`
  );
  // D8.4 — load-bearing: verify.sh greps for this exact prefix.
  // Emit one line per server so verify.sh / users can match each API to
  // its port. When mTLS is active, the scheme flips to `https://` and
  // verify.sh / users have to pass `--cacert` + `--cert` + `--key` to
  // curl; both schemes share the "Server listening on " prefix so the
  // verify.sh marker scan is unchanged.
  for (const { group, server } of servers) {
    process.stdout.write(
      `Server listening on ${server.scheme}://${server.host}:${server.port}  (${group.displayName})\n`
    );
  }
  // #462: emit one banner per WebSocket server. The protocol prefix
  // is `ws://` / `wss://` rather than `http://` / `https://` so users
  // copy-paste the URL straight into `wscat -c <URL>` / browser
  // `new WebSocket(url)`.
  for (const ws of wsServers) {
    const scheme = ws.server.scheme === 'https' ? 'wss' : 'ws';
    process.stdout.write(
      `Server listening on ${scheme}://${ws.server.host}:${ws.server.port}${ws.apiPath}  (${ws.api.apiLogicalId} (WebSocket API))\n`
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
    //
    // WebSocket-server shutdown layers on top: each
    // `AttachedWebSocketServer.close()` sends close-frame 1001 (going
    // away) to every live socket BEFORE we kill the underlying http
    // server, so the client sees a clean close instead of a
    // mid-frame disconnect.
    await Promise.allSettled(
      wsServers.map(async (ws) => {
        try {
          await ws.attached.close();
        } catch (err) {
          logger.warn(
            `WebSocket close() failed for ${ws.api.apiLogicalId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );
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
      wsServers.map(async (ws) => {
        try {
          await ws.server.close();
        } catch (err) {
          logger.warn(
            `WebSocket server.close() failed for ${ws.api.apiLogicalId}: ${err instanceof Error ? err.message : String(err)}`
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
    await Promise.allSettled(
      wsServers.map(async (ws) => {
        try {
          await ws.server.getServerState().pool.dispose();
        } catch (err) {
          logger.warn(
            `WebSocket pool.dispose() failed for ${ws.api.apiLogicalId}: ${err instanceof Error ? err.message : String(err)}`
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
  routesWithAuth: readonly RouteWithAuth[],
  webSocketApis: readonly DiscoveredWebSocketApi[] = []
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of routes) {
    // Skip deferred-error unsupported routes, synthetic mockCors
    // routes, and service-integration routes — none of them dispatch
    // to a Lambda, so spinning up their containers (when a
    // lambdaLogicalId IS attached, e.g. on a Function URL with
    // AuthType=AWS_IAM) would be wasted boot time.
    if (r.unsupported || r.mockCors || r.serviceIntegration) continue;
    if (r.lambdaLogicalId.length === 0) continue;
    if (!seen.has(r.lambdaLogicalId)) {
      seen.add(r.lambdaLogicalId);
      out.push(r.lambdaLogicalId);
    }
  }
  for (const entry of routesWithAuth) {
    // An unsupported / mockCors / service-integration route never
    // reaches the authorizer pass, so its authorizer Lambda doesn't
    // need a container either.
    if (entry.route.unsupported || entry.route.mockCors || entry.route.serviceIntegration) {
      continue;
    }
    const auth = entry.authorizer;
    if (!auth) continue;
    if (auth.kind === 'lambda-token' || auth.kind === 'lambda-request') {
      if (!seen.has(auth.lambdaLogicalId)) {
        seen.add(auth.lambdaLogicalId);
        out.push(auth.lambdaLogicalId);
      }
    }
  }
  // #462: pull every WebSocket route's backing Lambda into the
  // unified spec map so the shared container pool can dispatch them
  // alongside HTTP / REST routes.
  for (const api of webSocketApis) {
    for (const r of api.routes) {
      if (!seen.has(r.targetLambdaLogicalId)) {
        seen.add(r.targetLambdaLogicalId);
        out.push(r.targetLambdaLogicalId);
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
      // Multi-pool federation: pre-warm JWKS for EVERY pool in
      // ProviderARNs[], so issuer-matched verification at request time
      // doesn't pay a cold-start latency on the first request to each
      // tenant's pool.
      for (const pool of auth.pools) {
        urls.add(buildCognitoJwksUrl(pool.region, pool.userPoolId));
      }
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
 * Walk the discovered routes for `AuthorizationType: 'AWS_IAM'` and emit
 * a one-line warn naming the affected routes. Returns `true` when at
 * least one IAM route is present so the caller wires the SigV4
 * credentials loader. Re-runs across hot reloads are silent — the warn
 * fires only at initial boot (matches `warnVpcConfigLambdas`'s policy).
 *
 * Implementation note: signature verification only — IAM policy
 * evaluation (resource / action / condition) is NOT emulated. See
 * `src/local/sigv4-verify.ts` and the help text in `docs/cli-reference.md`.
 */
function warnIamRoutes(routesWithAuth: readonly RouteWithAuth[]): boolean {
  const logger = getLogger();
  const iamRoutes: string[] = [];
  for (const entry of routesWithAuth) {
    if (entry.authorizer?.kind === 'iam') {
      iamRoutes.push(entry.route.declaredAt);
    }
  }
  if (iamRoutes.length === 0) return false;
  logger.warn(
    `${iamRoutes.length} route(s) declare AuthorizationType: AWS_IAM — cdkd local start-api ` +
      `verifies SigV4 signatures against your local AWS credentials, but does NOT emulate IAM ` +
      `policy evaluation (resource / action / condition rules). Signature-verified callers reach ` +
      `the handler under their own identity; downstream authorization is the dev's responsibility. ` +
      `See docs/cli-reference.md (cdkd local start-api — AWS_IAM authorizer) for details.`
  );
  for (const declaredAt of iamRoutes) {
    logger.warn(`  - ${declaredAt}`);
  }
  return true;
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
  /**
   * `--from-state` substitution input keyed by stack name. Empty when
   * the flag is unset OR when no routed stack had loadable state. Per-
   * stack entries supply state.resources + the pseudo-parameter bag
   * the env-resolver consults for `Ref AWS::*` / `${AWS::*}` placeholders.
   */
  stateByStack: Map<string, StackStateBundle>;
  /**
   * `--no-pull` flag, threaded to the IMAGE branch's ECR-pull fallback
   * (`pullEcrImage(... {skipPull})`). ZIP branch ignores this — the
   * base-image pull happens once up the call chain
   * (`synthesizeAndBuild`'s `pullImage` loop) and is independently
   * gated by the same flag.
   */
  skipPull: boolean;
  /**
   * Issue #448: optional `--layer-role-arn` value. Forwarded into
   * {@link materializeLambdaLayers}, which `sts:AssumeRole`s into this
   * role before calling `lambda:GetLayerVersion` for every literal-ARN
   * entry. Same role applies to every routed Lambda — if the user's
   * apps reference layers in multiple accounts they need a single
   * cross-account role that can read all of them.
   */
  layerRoleArn?: string;
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
    stateByStack,
    skipPull,
    layerRoleArn,
  } = args;
  const lambda = resolveLambdaByLogicalId(logicalId, stacks);

  // ZIP / IMAGE divergence (closes #453). ZIP needs `codeDir` (bind-
  // mount source for /var/task) + `optDir` (bind-mount source for
  // /opt from same-stack Layers). IMAGE needs a pre-built local
  // docker image tag — resolved here once at server boot, then the
  // container pool runs `docker run` against it without further
  // resolution. Layers are silently ignored on the IMAGE branch
  // (matches AWS's invoke-time behavior: container Lambdas can't
  // declare Layers).
  let codeDir: string | undefined;
  let optDir: string | undefined;
  let imageRef: string | undefined;
  let platform: string | undefined;
  if (lambda.kind === 'zip') {
    // Re-use `cdkd local invoke`'s materialization rules for inline
    // (Code.ZipFile) Lambdas; asset-backed Lambdas already point at an
    // unzipped CDK directory.
    codeDir =
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
    //
    // Issue #448: literal-ARN entries are downloaded + unzipped via
    // `lambda:GetLayerVersion` before the cpSync-merge step. The per-ARN
    // tmpdirs are tracked in `layerTmpDirs` alongside multi-layer merge
    // dirs so the same shutdown path cleans every one.
    optDir = await materializeLambdaLayers(lambda.layers, layerTmpDirs, layerRoleArn);
  } else {
    // IMAGE branch (closes #453): build locally from cdk.out asset
    // manifest, OR pull from ECR when no matching asset is found.
    // Same-account/region only on the ECR-pull path — cross-account /
    // cross-region is deferred to a sibling PR (W2-1).
    const built = await resolveContainerImageForStartApi(lambda, skipPull);
    imageRef = built.imageRef;
    platform = architectureToPlatform(lambda.architecture);
  }

  // Env vars: literal template values + --env-vars overlay. When
  // `--from-state` was passed (and state for this Lambda's stack
  // loaded), intrinsic-valued template entries are first substituted
  // against deployed cdkd state + AWS pseudo parameters via
  // `substituteEnvVarsFromState`. Per-key failures (state missing for
  // a referenced logical id, attribute not captured at deploy time,
  // unsupported intrinsic shape) warn-and-drop with context. Keys the
  // state-resolver already warned about are suppressed in the downstream
  // env-resolver's generic warn loop so the user sees one warn per key.
  let templateEnv = getTemplateEnv(lambda.resource);
  const stateBundle = stateByStack.get(lambda.stack.stackName);
  let stateAudit: ReturnType<typeof substituteEnvVarsFromState>['audit'] | undefined;
  if (stateBundle) {
    const context: SubstitutionContext = { resources: stateBundle.state.resources };
    if (stateBundle.pseudoParameters) {
      context.pseudoParameters = stateBundle.pseudoParameters;
    }
    const { env, audit } = substituteEnvVarsFromState(templateEnv, context);
    templateEnv = env;
    stateAudit = audit;
    for (const key of audit.resolvedKeys) {
      getLogger().debug(`Lambda ${logicalId}: --from-state substituted env var ${key}`);
    }
    for (const { key, reason } of audit.unresolved) {
      getLogger().warn(
        `Lambda ${logicalId}: --from-state could not substitute env var ${key} (${reason}). ` +
          `Override it via --env-vars or it will be dropped.`
      );
    }
  }
  const envResult = resolveEnvVars(logicalId, templateEnv, overrides);
  for (const key of envResult.unresolved) {
    // The state-resolver already warned for keys it tried + failed on
    // (defensive: substituteEnvVarsFromState drops unresolved keys from
    // the returned env so the env-resolver never sees them, but mirror
    // `cdkd local invoke --from-state`'s safety dedupe in case the
    // state-resolver evolves).
    if (stateAudit && stateAudit.unresolved.some((u) => u.key === key)) continue;
    getLogger().warn(
      `Lambda ${logicalId}: env var ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${logicalId}":{"${key}":"<literal>"}}) ` +
        `or pass --from-state to recover deployed values.`
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

  // Issue #440 — Lambda EphemeralStorage.Size: when the function's
  // template declared `EphemeralStorage`, plumb the configured `/tmp`
  // cap through to every cold-start of this Lambda's warm pool so
  // the local container's `/tmp` matches the deployed function's
  // sized tmpfs. Resolved here (once at server boot) rather than at
  // acquire-time because the value is template-static for the
  // server's lifetime. Applies to BOTH ZIP and IMAGE Lambdas.
  const tmpfs =
    lambda.ephemeralStorageMb !== undefined
      ? { target: '/tmp', sizeMb: lambda.ephemeralStorageMb }
      : undefined;

  if (lambda.kind === 'zip') {
    const spec: ContainerSpec = {
      kind: 'zip',
      lambda,
      codeDir: codeDir!,
      env: dockerEnv,
      containerHost,
      ...(optDir !== undefined && { optDir }),
      ...(debugPort !== undefined && { debugPort }),
      ...(tmpfs !== undefined && { tmpfs }),
    };
    return spec;
  }

  const spec: ContainerSpec = {
    kind: 'image',
    lambda,
    image: imageRef!,
    platform: platform!,
    command: lambda.imageConfig.command ?? [],
    ...(lambda.imageConfig.entryPoint !== undefined &&
      lambda.imageConfig.entryPoint.length > 0 && {
        entryPoint: lambda.imageConfig.entryPoint,
      }),
    ...(lambda.imageConfig.workingDirectory !== undefined && {
      workingDir: lambda.imageConfig.workingDirectory,
    }),
    env: dockerEnv,
    containerHost,
    ...(debugPort !== undefined && { debugPort }),
    ...(tmpfs !== undefined && { tmpfs }),
  };
  return spec;
}

/**
 * Resolve a container Lambda's local docker image — local build from
 * `cdk.out` asset manifest first, ECR-pull fallback when the asset
 * manifest has no matching entry. Mirrors `cdkd local invoke`'s
 * `resolveContainerImagePlan` shape; the start-api server doesn't
 * need the no-build flag (deterministic-tag cache reuse is automatic
 * across reloads because the per-Lambda tag is content-addressed).
 *
 * Same-account / same-region only on the ECR-pull path (matches the
 * `cdkd local invoke` PR 5 of #224 boundary). Cross-account /
 * cross-region ECR pull is the W2-1 deferred follow-up.
 */
export async function resolveContainerImageForStartApi(
  lambda: ResolvedStartApiImageLambda,
  skipPull: boolean
): Promise<{ imageRef: string }> {
  const logger = getLogger();
  const localBuild = await resolveLocalBuildPlan(lambda);
  if (localBuild) {
    const imageRef = await buildContainerImage(localBuild.asset, localBuild.cdkOutDir, {
      architecture: lambda.architecture,
    });
    return { imageRef };
  }
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
  const imageRef = await pullEcrImage(lambda.imageUri, { skipPull });
  return { imageRef };
}

/**
 * Look up the docker image asset that backs a container Lambda.
 * Returns `undefined` when the asset manifest has no matching entry —
 * the caller falls back to the ECR-pull path.
 *
 * Mirrors `local-invoke.ts:resolveLocalBuildPlan`; kept separate so
 * the two commands evolve their asset-lookup heuristics independently.
 */
async function resolveLocalBuildPlan(
  lambda: ResolvedStartApiImageLambda
): Promise<{ asset: { source: DockerImageAssetSource }; cdkOutDir: string } | undefined> {
  const manifestPath = lambda.stack.assetManifestPath;
  if (!manifestPath) return undefined;
  const cdkOutDir = path.dirname(manifestPath);
  const loader = new AssetManifestLoader();
  const manifest = await loader.loadManifest(cdkOutDir, lambda.stack.stackName);
  if (!manifest) return undefined;
  const entry = getDockerImageBySourceHash(manifest, lambda.imageUri);
  if (!entry) return undefined;
  return { asset: entry.asset, cdkOutDir };
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
 *   - 1 layer → bind-mount the layer's asset dir directly (no copy)
 *     when the entry is a same-stack asset. Literal-ARN entries always
 *     pre-materialize first.
 *   - 2+ layers → copy each into a fresh tmpdir IN ORDER (later
 *     layers overwrite earlier files via `cpSync({force: true})`),
 *     bind-mount the tmpdir at `/opt`. Records the tmpdir in
 *     `layerTmpDirs` so `shutdown(...)` removes it.
 *
 * Issue #448: literal-ARN entries (`{kind: 'arn', ...}`) are downloaded
 * + unzipped via `lambda:GetLayerVersion` BEFORE the cpSync-merge
 * branches run. Every per-ARN tmpdir is also recorded in `layerTmpDirs`
 * so the same shutdown path cleans it up — even for the single-layer
 * fast path that bind-mounts the dir directly.
 *
 * AWS Lambda's actual runtime extracts every layer ZIP into `/opt`
 * in template order — the merge mirrors that. Docker rejects multiple
 * `-v ...:/opt:ro` entries at the same target, so cdkd can't rely on
 * overlay layering and must produce a single merged dir on the host.
 */
export async function materializeLambdaLayers(
  layers: ResolvedLambdaLayer[],
  layerTmpDirs: Set<string>,
  layerRoleArn: string | undefined
): Promise<string | undefined> {
  if (layers.length === 0) return undefined;

  // Stage 1: pre-materialize every literal-ARN entry into its own
  // tmpdir (issue #448). The resulting flat list of `assetPath`
  // entries is what the existing single-layer / multi-layer merge
  // branches consume.
  const flat: { logicalId: string; assetPath: string }[] = [];
  for (const layer of layers) {
    if (layer.kind === 'asset') {
      flat.push({ logicalId: layer.logicalId, assetPath: layer.assetPath });
      continue;
    }
    const dir = await materializeLayerFromArn(layer, {
      ...(layerRoleArn !== undefined && { roleArn: layerRoleArn }),
    });
    layerTmpDirs.add(dir);
    flat.push({ logicalId: layer.arn, assetPath: dir });
  }

  if (flat.length === 1) return flat[0]!.assetPath;
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-start-api-layers-'));
  for (const layer of flat) {
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
/**
 * Discriminated union covering both ZIP and container Lambdas (closes
 * #453). The ZIP variant is the original `cdkd local start-api` v1
 * shape; the IMAGE variant was unlocked here in this PR — the per-
 * Lambda image build / ECR pull / `--platform` threading lives below
 * in `buildContainerSpec`'s `kind === 'image'` branch.
 */
type ResolvedStartApiLambda = ResolvedStartApiZipLambda | ResolvedStartApiImageLambda;

interface ResolvedStartApiLambdaBase {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
  memoryMb: number;
  timeoutSec: number;
  /**
   * Resolved same-stack `Properties.Layers` references. Populated on
   * the ZIP branch; always `[]` on the IMAGE branch — container
   * Lambdas reject `Layers` at deploy time on the AWS side (layers
   * are baked into the image at build time, not overlaid at
   * runtime), so cdkd silently ignores any `Layers` property to
   * match AWS's invoke-time behavior. The base-shape `[]` keeps the
   * ResolvedImageLambda → `lambda-resolver.ResolvedImageLambda`
   * cast structurally valid in the container-pool spec.
   */
  layers: ResolvedLambdaLayer[];
  /**
   * `Properties.EphemeralStorage.Size` (issue #440), MiB. Parsed via
   * the shared `extractEphemeralStorageMb` helper so the CFn-range
   * validation (reject > 10240) matches `cdkd local invoke`. Plumbed
   * into the warm container's `--tmpfs /tmp:size=Nm` so handlers in
   * the start-api server see the same sized `/tmp` cap they would on
   * the deployed function. Applies to BOTH ZIP and IMAGE Lambdas —
   * Docker `--tmpfs` overlays inside any container image just like on
   * the public base images. Undefined when the property is absent.
   */
  ephemeralStorageMb?: number;
}

interface ResolvedStartApiZipLambda extends ResolvedStartApiLambdaBase {
  kind: 'zip';
  runtime: string;
  handler: string;
  codePath: string | null;
  inlineCode?: string;
}

export interface ResolvedStartApiImageLambda extends ResolvedStartApiLambdaBase {
  kind: 'image';
  /**
   * Raw `Code.ImageUri` value, surfaced for the local-build path's
   * asset-hash extraction AND for the ECR-pull fallback. Already
   * resolved through cdk-assets bootstrap-placeholder substitution
   * upstream — `${AWS::*}` pseudo-parameters are still present and
   * substituted at the lookup site.
   */
  imageUri: string;
  /**
   * `ImageConfig` (all fields optional). Most container Lambdas leave
   * `EntryPoint` unset so `/lambda-entrypoint.sh` stays in charge of
   * RIE dispatch. `Command` is typically the handler reference, e.g.
   * `['app.handler']`.
   */
  imageConfig: {
    command?: string[];
    entryPoint?: string[];
    workingDirectory?: string;
  };
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through
   * to `--platform linux/amd64` / `linux/arm64` on BOTH `docker build`
   * AND `docker run` so an arm64 host running an x86_64 Lambda doesn't
   * hit silent emulation, and an x86_64 host running an arm64 Lambda
   * doesn't fail with `exec format error`.
   */
  architecture: 'x86_64' | 'arm64';
}

export function resolveLambdaByLogicalId(
  logicalId: string,
  stacks: StackInfo[]
): ResolvedStartApiLambda {
  for (const stack of stacks) {
    const resource = stack.template.Resources?.[logicalId];
    if (!resource || resource.Type !== 'AWS::Lambda::Function') continue;
    const props = resource.Properties ?? {};
    const memoryMb = typeof props['MemorySize'] === 'number' ? props['MemorySize'] : 128;
    const timeoutSec = typeof props['Timeout'] === 'number' ? props['Timeout'] : 3;

    const code = (props['Code'] ?? {}) as Record<string, unknown>;
    const imageUri = extractImageUri(code['ImageUri']);
    if (imageUri !== undefined) {
      return resolveImageLambda({
        stack,
        logicalId,
        resource,
        props,
        memoryMb,
        timeoutSec,
        imageUri,
      });
    }

    // ZIP branch: Runtime + Handler mandatory.
    const runtime = typeof props['Runtime'] === 'string' ? props['Runtime'] : '';
    const handler = typeof props['Handler'] === 'string' ? props['Handler'] : '';
    if (!runtime) {
      throw new Error(
        `Lambda '${logicalId}' has no Runtime property and no Code.ImageUri. ` +
          'cdkd local start-api cannot tell if this is a ZIP or a container Lambda.'
      );
    }
    if (!handler) {
      throw new Error(`Lambda '${logicalId}' has no Handler property.`);
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
    const ephemeralStorageMb = extractEphemeralStorageMb(props, logicalId);
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
      ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
    };
  }
  throw new Error(
    `No AWS::Lambda::Function resource named '${logicalId}' found in target stacks. This is likely a synthesis bug — the route-discovery phase resolved a route to this logical ID.`
  );
}

/**
 * Extract `Code.ImageUri` across the shapes CDK actually synthesizes.
 * Mirrors the simpler subset of `lambda-resolver.ts:extractImageUri`
 * scoped to the shapes `cdkd local start-api` consumes — flat string
 * and `Fn::Sub` (the canonical asset shape for
 * `lambda.DockerImageCode.fromImageAsset`). `Fn::Join` shapes for
 * `lambda.DockerImageCode.fromEcr` are deferred to a follow-up: the
 * start-api boot flow doesn't yet load cdkd state up front, and the
 * `Fn::Join` resolver needs it to recover same-stack ECR repository
 * URIs. When the user hits the unsupported shape, the downstream
 * resolveLocalBuildPlan / pullEcrImage path surfaces a clear error.
 *
 * Returns `undefined` when the field is absent or non-recognized,
 * which routes the caller to the ZIP branch (with its existing
 * "no Runtime / no Handler" validations).
 */
function extractImageUri(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string' && sub.length > 0) return sub;
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];
  }
  return undefined;
}

/**
 * Build the IMAGE-variant `ResolvedStartApiLambda` from a Lambda
 * template entry with `Code.ImageUri`. Mirrors
 * `lambda-resolver.ts:extractImageLambdaProperties` but trimmed to the
 * fields `cdkd local start-api` actually consumes.
 */
function resolveImageLambda(args: {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
  props: Record<string, unknown>;
  memoryMb: number;
  timeoutSec: number;
  imageUri: string;
}): ResolvedStartApiImageLambda {
  const { stack, logicalId, resource, props, memoryMb, timeoutSec, imageUri } = args;

  const rawImageConfig = (props['ImageConfig'] ?? {}) as Record<string, unknown>;
  const imageConfig: ResolvedStartApiImageLambda['imageConfig'] = {};
  if (Array.isArray(rawImageConfig['Command'])) {
    imageConfig.command = rawImageConfig['Command'].filter(
      (s): s is string => typeof s === 'string'
    );
  }
  if (Array.isArray(rawImageConfig['EntryPoint'])) {
    imageConfig.entryPoint = rawImageConfig['EntryPoint'].filter(
      (s): s is string => typeof s === 'string'
    );
  }
  if (typeof rawImageConfig['WorkingDirectory'] === 'string') {
    imageConfig.workingDirectory = rawImageConfig['WorkingDirectory'];
  }

  // Architectures defaults to x86_64. CDK only ever sets one entry.
  const arches = props['Architectures'];
  let architecture: 'x86_64' | 'arm64' = 'x86_64';
  if (Array.isArray(arches) && arches.length > 0) {
    const first: unknown = arches[0];
    if (first === 'arm64') architecture = 'arm64';
    else if (first === 'x86_64') architecture = 'x86_64';
    else {
      throw new Error(
        `Lambda '${logicalId}' has unsupported Architectures value '${String(first)}'. ` +
          'cdkd local start-api supports x86_64 and arm64.'
      );
    }
  }

  // Issue #440 — EphemeralStorage.Size applies to container Lambdas
  // too; AWS accepts it on `lambda.DockerImageFunction`. Parse via the
  // shared helper for CFn-range validation parity with the ZIP branch.
  const ephemeralStorageMb = extractEphemeralStorageMb(props, logicalId);

  return {
    kind: 'image',
    stack,
    logicalId,
    resource,
    memoryMb,
    timeoutSec,
    imageUri,
    imageConfig,
    architecture,
    layers: [],
    ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
  };
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
 *
 * Routes with `unsupported` or `mockCors` are annotated so the user can
 * tell at a glance which routes will dispatch to a Lambda vs which
 * return 501 / 204 directly:
 *   - normal:        `GET /items -> Handler  (HTTP API)`
 *   - mockCors:      `OPTIONS /items -> [MOCK CORS preflight]  (REST v1, stage 'prod')`
 *   - unsupported:   `POST /admin -> [501 Not Implemented]  (HTTP API)`
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
    const target = r.mockCors
      ? '[MOCK CORS preflight]'
      : r.unsupported
        ? '[501 Not Implemented]'
        : r.serviceIntegration
          ? `[${r.serviceIntegration.subtype}]`
          : r.restV1Integration
            ? formatRestV1IntegrationLabel(r.restV1Integration)
            : r.lambdaLogicalId;
    process.stdout.write(
      `  ${r.method.padEnd(methodWidth)}  ${r.pathPattern.padEnd(pathWidth)}  -> ${target}  (${sourceLabel})\n`
    );
  }
  process.stdout.write('\n');
}

/**
 * Format the route-table label for a REST v1 non-AWS_PROXY integration.
 * `MOCK` / `HTTP` / `HTTP_PROXY` show their integration kind directly;
 * `AWS` (Lambda non-proxy) shows the Lambda logical id with an `[AWS]`
 * suffix so it's distinguishable from AWS_PROXY rows. Closes #457.
 */
function formatRestV1IntegrationLabel(
  integration: NonNullable<DiscoveredRoute['restV1Integration']>
): string {
  switch (integration.kind) {
    case 'mock':
      return '[MOCK]';
    case 'http-proxy':
      return `[HTTP_PROXY ${integration.uri}]`;
    case 'http':
      return `[HTTP ${integration.uri}]`;
    case 'aws-lambda':
      return `${integration.lambdaLogicalId} [AWS]`;
  }
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
 *
 * `group` is intentionally **mutable** — hot-reload swaps the group
 * in place after `setServerState` so post-reload route-table reprints
 * (`printPerServerRouteTables(servers)`) reflect the new routes,
 * including any new `mockCors` / `unsupported` classifications.
 * Pre-fix the field was readonly and the printed table after reload
 * always showed the boot-time routes.
 */
interface BootedApiServer {
  group: ApiServerGroup;
  readonly server: StartedApiServer;
}

/**
 * One booted WebSocket API server (#462). Mirrors `BootedApiServer`
 * for the upgrade-event-driven WebSocket family. Each instance owns:
 *
 *   - `server`: the underlying `node:http` (or `https` under mTLS)
 *     server hosting both the upgrade-listener AND the
 *     `@connections/<id>` HTTP data plane via the preDispatch hook.
 *   - `attached`: the WebSocket-server wrapper (connection registry +
 *     close handle). The HTTP server's preDispatch closure reads the
 *     registry to route management-API POST calls.
 *   - `apiPath`: the URL path the upgrade request must match
 *     (default `/<stage>` so multi-API setups stay disambiguated).
 *
 * Hot reload (`--watch`) for WebSocket APIs is restart-only in v1 —
 * see design doc §12 Q5. The CLI surfaces a warn line when a watched
 * file change implies a WebSocket route / Lambda change so the user
 * knows to restart.
 */
interface BootedWebSocketServer {
  api: DiscoveredWebSocketApi;
  readonly server: StartedApiServer;
  readonly attached: AttachedWebSocketServer;
  readonly apiPath: string;
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
 * Surface every `unsupported` route (deferred 501) as a startup warn so
 * the user sees what isn't reachable BEFORE they try to curl it. One
 * warn line per route — the route's `unsupported.reason` already names
 * the offender + the underlying limitation, so we just prefix with
 * method + path. Returns the number of unsupported routes so the caller
 * can emit a single-line summary header above the list.
 */
function warnUnsupportedRoutes(
  routes: readonly DiscoveredRoute[],
  logger: ReturnType<typeof getLogger>
): number {
  const unsupported = routes.filter((r) => r.unsupported);
  if (unsupported.length === 0) return 0;
  logger.warn(
    `${unsupported.length} route(s) will respond HTTP 501 Not Implemented when hit (boot continued):`
  );
  for (const r of unsupported) {
    logger.warn(`  - ${r.method} ${r.pathPattern}: ${r.unsupported!.reason}`);
  }
  return unsupported.length;
}

/**
 * Surface every WebSocket API tagged as unsupported at discovery as a
 * startup warn. The boot loop above skips attaching the server for
 * these APIs, so no upgrade requests are ever accepted on them —
 * mirrors `warnUnsupportedRoutes`'s shape but for the WebSocket axis.
 * Typical trigger: a Route declaring `AuthorizationType !== 'NONE'` on
 * `$connect` (cdkd v1 does not emulate WebSocket authorizers; closing
 * this gap structurally rather than silently admitting
 * unauthenticated clients matches the security-by-default precedent
 * PR #514 set for HTTP API v2 service integrations).
 */
function warnUnsupportedWebSocketApis(
  apis: readonly DiscoveredWebSocketApi[],
  logger: ReturnType<typeof getLogger>
): number {
  const unsupported = apis.filter((api) => api.unsupported);
  if (unsupported.length === 0) return 0;
  logger.warn(
    `${unsupported.length} WebSocket API(s) will NOT accept upgrade requests (boot continued):`
  );
  for (const api of unsupported) {
    logger.warn(`  - ${api.declaredAt}: ${api.unsupported!.reason}`);
  }
  return unsupported.length;
}

/**
 * Surface a one-line warn per HTTP / HTTP_PROXY integration whose
 * `Integration.Uri` points at a well-known internal address space
 * (AWS IMDS, loopback, link-local, RFC1918). PR #505 / issue #457
 * follow-up: cdkd does NOT block these — warn-and-proceed matches the
 * cognito JWKS pass-through pattern — but the user should see the
 * destination at boot so a malicious / typo'd template Uri does not
 * silently exfiltrate credentials in CI. Deduplicated per-Uri.
 */
function warnSsrfRiskyIntegrations(
  routes: readonly DiscoveredRoute[],
  logger: ReturnType<typeof getLogger>
): void {
  const seen = new Set<string>();
  for (const r of routes) {
    const integ = r.restV1Integration;
    if (!integ) continue;
    if (integ.kind !== 'http' && integ.kind !== 'http-proxy') continue;
    if (seen.has(integ.uri)) continue;
    seen.add(integ.uri);
    warnSsrfRiskyUri(integ.uri, `${r.method} ${r.pathPattern}`, (msg) => logger.warn(msg));
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
    // Update the BootedApiServer's `group` in place so post-reload
    // `printPerServerRouteTables(servers)` reads the new routes,
    // including any new mockCors / unsupported classifications. Pre-fix
    // the printed table always reflected the boot-time routes.
    booted.group = group;
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
  // that the swap landed. `booted.group` was mutated above so this
  // reflects the post-swap routes (including any new mockCors /
  // unsupported classifications introduced mid-edit).
  printPerServerRouteTables(servers);
  const allRoutes = servers.flatMap((s) => s.group.routes.map((r) => r.route));
  warnUnsupportedRoutes(allRoutes, logger);
  warnSsrfRiskyIntegrations(allRoutes, logger);
}

/**
 * Per-stack `--from-state` substitution input consumed by
 * {@link buildContainerSpec}. Built once per `synthesizeAndBuild` pass
 * — initial boot AND every hot-reload firing — by
 * {@link loadStateForRoutedStacks}. Empty (no stack-level entry) when
 * the stack's state could not be loaded or the user did not pass
 * `--from-state`.
 */
interface StackStateBundle {
  state: StackState;
  /**
   * AWS pseudo parameters (account / region / partition / URL suffix).
   * `undefined` when none of the stack's reachable Lambdas has a
   * pseudo-parameter intrinsic in its env map (skips the STS hop) OR
   * the STS resolution failed (substitution still runs for non-`AWS::*`
   * refs).
   */
  pseudoParameters?: PseudoParameters;
}

/**
 * Returns true when any value in the function's template env map is a
 * CFn intrinsic (non-primitive). Used to gate the pseudo-parameter STS
 * hop inside the `--from-state` flow: literal-only env maps don't need
 * the pseudo-parameter bag and shouldn't pay for an STS call. Mirrors
 * the same gating in `local-invoke.ts` (`envHasIntrinsicValue`) and
 * `ecs-task-resolver.ts` (`containerHasIntrinsicEnvOrSecret`).
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
 * Load deployed state for every stack that owns a routed Lambda. Once
 * per `synthesizeAndBuild` pass (initial boot + every reload), so a
 * Lambda's per-spec build does not pay one round-trip per Lambda. Per-
 * stack failures (no state, ambiguous region, bucket resolution error)
 * degrade to warn-and-fall-back via the active `LocalStateProvider` —
 * the affected stack's reachable Lambdas behave as if `--from-state` /
 * `--from-cfn-stack` were not set, while sibling stacks with loadable
 * state still substitute.
 *
 * Pseudo parameters are resolved per stack and only when at least one
 * reachable Lambda in that stack has an intrinsic-valued env entry
 * (gated via {@link envHasIntrinsicValue}). STS failures degrade to
 * warn and leave `pseudoParameters: undefined` — substitution still
 * runs for non-`AWS::*` refs.
 */
async function loadStateForRoutedStacks(
  stacks: readonly StackInfo[],
  routes: readonly DiscoveredRoute[],
  routesWithAuth: readonly RouteWithAuth[],
  options: LocalStartApiOptions
): Promise<Map<string, StackStateBundle>> {
  const logger = getLogger();
  const out = new Map<string, StackStateBundle>();

  // Collect the set of (stackName, region) pairs that contain at least
  // one routed Lambda OR an attached authorizer Lambda. The stack
  // resolution mirrors `resolveLambdaByLogicalId`'s walk so we never
  // load state for a stack whose Lambdas are not actually reachable
  // from the discovered API surface.
  const lambdaIds = uniqueLambdaIds(routes, routesWithAuth);
  const reachableStackNames = new Set<string>();
  for (const logicalId of lambdaIds) {
    for (const stack of stacks) {
      const resource = stack.template.Resources?.[logicalId];
      if (resource && resource.Type === 'AWS::Lambda::Function') {
        reachableStackNames.add(stack.stackName);
        break;
      }
    }
  }

  // Pre-compute "does any reachable Lambda in this stack have an
  // intrinsic-valued env map" — gates the per-stack STS hop.
  const stackHasIntrinsicEnv = (stackName: string): boolean => {
    for (const logicalId of lambdaIds) {
      for (const stack of stacks) {
        if (stack.stackName !== stackName) continue;
        const resource = stack.template.Resources?.[logicalId];
        if (!resource || resource.Type !== 'AWS::Lambda::Function') continue;
        if (envHasIntrinsicValue(getTemplateEnv(resource))) return true;
      }
    }
    return false;
  };

  // Issue #606: route through `createLocalStateProvider` so the same
  // code path drives both `--from-state` (S3) and `--from-cfn-stack`
  // (CFn). One provider PER reachable stack — bare `--from-cfn-stack`
  // uses the cdkd stack name per routed stack, so the dispatcher needs
  // each stack's name at construction time. Each provider is disposed
  // after its `load` call returns so the AWS client tied to that
  // provider doesn't outlive the boot pass.
  //
  // Reject explicit `--from-cfn-stack <name>` when multiple cdkd stacks
  // are routed: the explicit name would apply to every routed stack
  // and silently misresolve `Ref` lookups when logical IDs happen to
  // collide between siblings (see local-state-source.ts for the
  // rationale). Bare `--from-cfn-stack` is safe because each routed
  // stack uses its own cdkd stack name.
  rejectExplicitCfnStackWithMultipleStacks(options, reachableStackNames.size);
  for (const stackName of reachableStackNames) {
    const stack = stacks.find((s) => s.stackName === stackName);
    if (!stack) continue;
    const provider = createLocalStateProvider(options, stack.stackName, stack.region);
    if (!provider) continue;
    try {
      const loaded = await provider.load(stack.stackName, stack.region);
      if (!loaded) continue;

      // Synthesize a `StackState` shape from the provider's
      // `LocalStateRecord` so the downstream `buildContainerSpec` path
      // (which reads `stateBundle.state.resources`) keeps working
      // verbatim. Outputs is an unused field at this call site but
      // populated for completeness; the StackState `version` /
      // `lastModified` carry placeholder values — the
      // sync `substituteEnvVarsFromState` resolver only reads
      // `resources`.
      const syntheticState: StackState = {
        version: 1,
        stackName: stack.stackName,
        resources: loaded.resources,
        outputs: loaded.outputs,
        lastModified: 0,
      };
      const bundle: StackStateBundle = { state: syntheticState };
      if (stackHasIntrinsicEnv(stackName)) {
        const pseudo = await resolvePseudoParametersForStartApi(loaded.region, options);
        if (pseudo) bundle.pseudoParameters = pseudo;
      }
      out.set(stackName, bundle);
      logger.debug(`${provider.label}: loaded state for ${stackName} (${loaded.region})`);
    } finally {
      provider.dispose();
    }
  }
  return out;
}

/**
 * Build the AWS pseudo-parameter bag for `--from-state` env-var
 * substitution. Mirrors `resolvePseudoParametersForInvoke` in
 * `local-invoke.ts` byte-for-byte — kept inlined here rather than
 * extracted into a shared helper because the two call sites differ in
 * region precedence (this one is per-stack so the resolved state
 * region takes priority).
 *
 * Region precedence: `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` >
 * the state record's region (returned by the active `LocalStateProvider`).
 */
async function resolvePseudoParametersForStartApi(
  stateRegion: string,
  options: LocalStartApiOptions
): Promise<PseudoParameters | undefined> {
  const logger = getLogger();
  const region =
    options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? stateRegion;
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
        'Substitution will be skipped for AWS::AccountId; affected env entries will be dropped with per-key warnings.'
    );
  }
  const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
  const bag: PseudoParameters = {
    ...(accountId !== undefined && { accountId }),
    ...(region !== undefined && { region }),
    ...(partitionAndSuffix && {
      partition: partitionAndSuffix.partition,
      urlSuffix: partitionAndSuffix.urlSuffix,
    }),
  };
  return Object.keys(bag).length === 0 ? undefined : bag;
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
 * Resolve the mTLS configuration from CLI options. Returns `undefined`
 * when none of the three `--mtls-*` flags is set (the server stays
 * plain-HTTP). When any of the three is set, ALL THREE must be set —
 * partial configurations are rejected at parse time so the server
 * never boots in a half-configured state.
 *
 * Exported for unit testing.
 */
export function resolveMtlsConfig(
  options: Pick<LocalStartApiOptions, 'mtlsTruststore' | 'mtlsCert' | 'mtlsKey'>
): MtlsServerConfig | undefined {
  const present: string[] = [];
  const absent: string[] = [];
  if (options.mtlsTruststore !== undefined && options.mtlsTruststore !== '') {
    present.push('--mtls-truststore');
  } else {
    absent.push('--mtls-truststore');
  }
  if (options.mtlsCert !== undefined && options.mtlsCert !== '') {
    present.push('--mtls-cert');
  } else {
    absent.push('--mtls-cert');
  }
  if (options.mtlsKey !== undefined && options.mtlsKey !== '') {
    present.push('--mtls-key');
  } else {
    absent.push('--mtls-key');
  }
  if (present.length === 0) return undefined;
  if (absent.length > 0) {
    throw new Error(
      `mTLS configuration is incomplete: ${present.join(', ')} set but ${absent.join(', ')} missing. ` +
        'All three of --mtls-truststore, --mtls-cert, and --mtls-key must be set together to enable mTLS, ' +
        'or all three left unset for plain HTTP.'
    );
  }
  // All three set — read the PEM materials from disk. Failures surface
  // a clear error naming the offending flag + path before the server
  // starts.
  return readMtlsMaterialsFromDisk({
    truststorePath: options.mtlsTruststore!,
    certPath: options.mtlsCert!,
    keyPath: options.mtlsKey!,
  });
}

/**
 * Builder for the `start-api` subcommand. Wired up by `local.ts`.
 */
export function createLocalStartApiCommand(): Command {
  const startApi = new Command('start-api')
    .description(
      'Run a long-running local HTTP server that maps API Gateway routes (REST v1, HTTP API, Function URL) to Lambda invocations against the AWS Lambda Runtime Interface Emulator (Docker required). Supports Lambda TOKEN/REQUEST authorizers, Cognito User Pool / HTTP v2 JWT authorizers, and REST v1 AWS_IAM (SigV4 signature verification only — IAM policy evaluation is NOT emulated; see docs/local-emulation.md). When JWKS is unreachable, JWT authorizers fall back to pass-through (every token accepted) with a warn line — local dev fallback. VPC-config Lambdas run locally and surface a warn line at startup; their containers do NOT get attached to the deployed VPC subnets, so calls to private RDS / ElastiCache will fail.'
    )
    .argument(
      '[target]',
      "Optional API filter. Accepts the bare CDK logical id ('MyHttpApi'; single-stack apps only), stack-qualified logical id ('MyStack:MyHttpApi'), full CDK Construct path ('MyStack/MyHttpApi/Resource'), or an ancestor Construct path that prefix-matches ('MyStack/MyHttpApi'). When omitted, every discovered API gets its own server. Mirrors `cdkd local invoke` / `cdkd local run-task` target syntax."
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
        'DEPRECATED — use the positional <target> argument instead. Same accepted forms (bare logical id, stack-qualified, Construct path, ancestor prefix). Will be removed in a future major release.'
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
        '--from-state',
        'Read cdkd S3 state for every routed stack and substitute Ref / Fn::GetAtt / Fn::Sub / Fn::Join ' +
          '(and AWS pseudo parameters) in Lambda env vars with the deployed physical IDs / attributes. ' +
          'Off by default — pre-PR warn-and-drop semantics are preserved. Turn on for stacks already deployed via cdkd deploy. ' +
          'Mirrors `cdkd local invoke --from-state` / `cdkd local run-task --from-state`. ' +
          'Re-runs against fresh state on every hot-reload firing (--watch).'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via DescribeStackResources and substitute Ref / Fn::ImportValue ' +
          'in Lambda env vars with the deployed physical IDs / exports. ' +
          'Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). ' +
          'Bare form uses the cdkd stack name per routed stack; pass an explicit value when a single CFn stack should serve every routed stack. ' +
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
    .addOption(
      new Option(
        '--mtls-truststore <path>',
        'PEM-encoded CA bundle for client-certificate verification (mutual TLS). ' +
          'When set, the local server switches from HTTP to HTTPS and the TLS handshake rejects ' +
          "clients whose certificate doesn't chain to one of these CAs. Verified certs are surfaced " +
          'on the Lambda event under requestContext.identity.clientCert (REST v1) / ' +
          'requestContext.authentication.clientCert (HTTP API v2). Must be set together with ' +
          '--mtls-cert + --mtls-key; partial flag sets are rejected. ' +
          'Generate a CA + server + client cert for local dev: ' +
          'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -subj "/CN=cdkd-local-ca" -days 365; ' +
          'openssl req -newkey rsa:2048 -nodes -keyout server-key.pem -out server-csr.pem -subj "/CN=localhost"; ' +
          'openssl x509 -req -in server-csr.pem -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -days 365; ' +
          'openssl req -newkey rsa:2048 -nodes -keyout client-key.pem -out client-csr.pem -subj "/CN=client"; ' +
          'openssl x509 -req -in client-csr.pem -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out client-cert.pem -days 365; ' +
          'curl --cacert ca.pem --cert client-cert.pem --key client-key.pem https://localhost:<port>/...'
      )
    )
    .addOption(
      new Option(
        '--mtls-cert <path>',
        'PEM-encoded server certificate for mutual TLS. Self-signed is fine for local dev. ' +
          'Must be set together with --mtls-truststore + --mtls-key.'
      )
    )
    .addOption(
      new Option(
        '--mtls-key <path>',
        'PEM-encoded server private key matching --mtls-cert. ' +
          'Must be set together with --mtls-truststore + --mtls-cert.'
      )
    )
    .addOption(
      new Option(
        '--allow-unverified-sigv4',
        'Opt-in: allow AWS_IAM SigV4 requests that cannot be cryptographically verified ' +
          '(foreign access-key-id, OR no local AWS credentials configured) to pass through ' +
          'with a placeholder principalId. DEFAULT off — fail-closed so unauthenticated bypass ' +
          'is impossible against `event.requestContext.identity.accessKey`-trusting handler code. ' +
          'Use only in dev loops where you understand the risk.'
      ).default(false)
    )
    .action(withErrorHandling(localStartApiCommand));

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    startApi.addOption(opt)
  );
  startApi.addOption(deprecatedRegionOption);

  return startApi;
}
