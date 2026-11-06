import type { ConsoleLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import {
  attachWebSocketServer,
  handleManagementRequest,
  type AttachedWebSocketServer,
} from '../../../local/websocket-server.js';
import { buildMgmtEndpointEnvUrl } from '../../../local/websocket-mgmt-api.js';
import {
  HOST_GATEWAY_MIN_VERSION,
  probeHostGatewaySupport,
} from '../../../local/docker-version.js';
import type { ContainerSpec, ContainerPool } from '../../../local/container-pool.js';
import {
  startApiServer,
  type ServerState,
  type MtlsServerConfig,
} from '../../../local/http-server.js';
import { groupRoutesByServer } from '../../../local/api-server-grouping.js';
import { createAuthorizerCache, type AuthorizerCache } from '../../../local/authorizer-cache.js';
import type { JwksCache } from '../../../local/cognito-jwt.js';
import type { CredentialsLoader } from '../../../local/sigv4-verify.js';
import type {
  LocalStartApiOptions,
  NextStateMaterial,
  BootedApiServer,
  BootedWebSocketServer,
} from './types.js';
import { perStack, groupStackName } from './served-lambdas.js';
import {
  filterSpecsForGroup,
  corsConfigForGroup,
  warnUnsupportedWebSocketApis,
  filterSpecsForWebSocketApi,
} from './servers.js';
import { resolveMtlsConfig } from './flags.js';

/**
 * Boot every HTTP server (one per API surface, issue #260) and every
 * WebSocket API server (#462) for `localStartApiCommand`'s initial boot, and
 * return both arrays: the route tables, banners, `--watch` reload and the
 * shutdown path all read them.
 *
 * Moved out of `localStartApiCommand` verbatim (go-to-k/cdkd#5835). Every
 * input is read once, at the call, after its last assignment there: the JWKS
 * cache `prewarmJwks` already filled, and the SigV4 credentials loader the
 * handler constructed just before.
 */
export async function bootServers({
  options,
  logger,
  initialMaterial,
  buildPool,
  authorizerCaches,
  jwksCache,
  jwksWarnedAt,
  sigV4CredentialsLoader,
  sigV4WarnedForeignIds,
}: {
  options: LocalStartApiOptions;
  logger: ConsoleLogger;
  initialMaterial: NextStateMaterial;
  buildPool: (specs: Map<string, ContainerSpec>) => ContainerPool;
  authorizerCaches: Map<string, AuthorizerCache>;
  jwksCache: JwksCache;
  jwksWarnedAt: Map<string, number>;
  sigV4CredentialsLoader: CredentialsLoader;
  sigV4WarnedForeignIds: Set<string>;
}): Promise<{ servers: BootedApiServer[]; wsServers: BootedWebSocketServer[] }> {
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
    const groupSpecs = filterSpecsForGroup(group, initialMaterial);
    const groupPool = buildPool(groupSpecs);
    const groupState: ServerState = {
      routes: group.routes,
      pool: groupPool,
      corsConfigByApiId: corsConfigForGroup(group, initialMaterial),
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
            `Pre-warm failed for one Lambda in ${group.displayName} (cold start cost will apply on first request): ${describeAwsFailure(result.reason).detail}`
          );
        }
      }
    }
    // Issue #1843: folded — this is the API Gateway event's region and the
    // region cdk-local's server builds its service-integration clients with.
    const defaultRegion = canonicalizeRegion(
      options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? undefined
    );
    const started = await startApiServer({
      state: groupState,
      rieTimeoutMs,
      host: options.host,
      ...(mtlsConfig && { mtls: mtlsConfig }),
      // Increment per server; basePort=0 leaves every server on auto-alloc.
      port: basePort === 0 ? 0 : nextPort,
      authorizerCache: perStack(
        authorizerCaches,
        groupStackName(group, initialMaterial.stacks),
        createAuthorizerCache
      ),
      jwksCache,
      jwksWarnedAt,
      sigV4CredentialsLoader,
      sigV4WarnedForeignIds,
      // cdk-local's startApiServer takes `sigV4Strict` (opt-in to fail-closed).
      // cdkd follows the same polarity: warn-and-pass by default, opt IN via
      // `--strict-sigv4`.
      sigV4Strict: options.strictSigv4 === true,
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
    const wsSpecs = filterSpecsForWebSocketApi(api, initialMaterial);
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
      authorizerCache: perStack(authorizerCaches, api.apiStackName, createAuthorizerCache),
      jwksCache,
      jwksWarnedAt,
      sigV4WarnedForeignIds,
      // cdk-local's startApiServer takes `sigV4Strict` (opt-in to fail-closed).
      // cdkd follows the same polarity: warn-and-pass by default, opt IN via
      // `--strict-sigv4`.
      sigV4Strict: options.strictSigv4 === true,
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
    for (const spec of wsSpecs.values()) {
      spec.env['AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI'] = mgmtEndpoint;
      // cdkd-local-env-identity: AWS's own documentation-example key, a
      // PLACEHOLDER so the SDK will instantiate against the local management
      // endpoint. It is not an identity at all and names no real principal, and
      // the guard keeps it from displacing whatever the caller's own identity
      // put there.
      if (!spec.env['AWS_ACCESS_KEY_ID']) {
        spec.env['AWS_ACCESS_KEY_ID'] = 'AKIAIOSFODNN7EXAMPLE';
        spec.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      }
      // Ensure the SDK has a region — apigatewaymanagementapi
      // clients refuse to instantiate without one.
      // Issue #1843: folded, since it lands in the container's own env.
      if (!spec.env['AWS_REGION']) {
        spec.env['AWS_REGION'] = canonicalizeRegion(
          options.region ??
            process.env['AWS_REGION'] ??
            process.env['AWS_DEFAULT_REGION'] ??
            'us-east-1'
        );
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
  return { servers, wsServers };
}
