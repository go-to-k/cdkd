import type { AssumeRoleOption } from '../../options.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { DiscoveredWebSocketApi } from '../../../local/websocket-route-discovery.js';
import type { AttachedWebSocketServer } from '../../../local/websocket-server.js';
import type { ContainerSpec } from '../../../local/container-pool.js';
import type { StartedApiServer } from '../../../local/http-server.js';
import type { ApiServerGroup } from '../../../local/api-server-grouping.js';
import type { CorsConfig } from '../../../local/cors-handler.js';
import type { RouteWithAuth } from '../../../local/authorizer-resolver.js';

/**
 * What one synth + discovery pass produces: the initial boot and every
 * `--watch` reload (`reloadAllServers`) build the servers from it.
 */
export interface NextStateMaterial {
  /** Discovered routes with attached authorizer info (`authorizer: undefined` when none). */
  routes: RouteWithAuth[];
  /**
   * Full per-Lambda spec map (every Lambda reachable through `routes` or a
   * WebSocket route), keyed by {@link servedLambdaKey}: (stack, logical id),
   * so two stacks reusing a construct id keep two specs (#5181).
   */
  specs: Map<string, ContainerSpec>;
  /** Per-API CORS config, per stack name: each server reads its own stack's (#5181). */
  corsConfigByStack: Map<string, Map<string, CorsConfig>>;
  /**
   * Discovered WebSocket APIs (#462). `reloadAllServers` does not reload a
   * WebSocket server: a route-set or Lambda change needs a manual restart,
   * since the protocol has no equivalent of `setServerState`'s atomic swap.
   */
  webSocketApis?: readonly DiscoveredWebSocketApi[];
  /**
   * The target stacks this material was built from, so the initial boot can
   * run startup-only side effects (`warnVpcConfigLambdas`) without
   * re-synthesizing, and each server finds its routes' Lambdas' specs.
   */
  stacks: readonly StackInfo[];
}

export interface LocalStartApiOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  /** `--aws-emulator [url]`: `true` for the bare flag (go-to-k/cdkd#6132). */
  awsEmulator?: string | boolean;
  /** `--ca-bundle <file>`: mounted into every workload container (go-to-k/cdkd#6131). */
  caBundle?: string;
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
   * Issue #256 Option 1 - `--assume-role-auto`: auto-resolve EACH
   * routed Lambda's own execution role per-Lambda (literal ARN /
   * Fn::GetAtt against the synthesized template / --from-cfn-stack
   * state). Composed with {@link LocalStartApiOptions.assumeRole} at
   * boot via {@link normalizeStartApiAssumeRole} (which also enforces
   * the `--assume-role-auto` vs global-ARN mutual exclusion guard)
   * before downstream use, so this raw boolean is never read directly
   * past the handler entry point.
   */
  assumeRoleAuto?: boolean;
  /**
   * Issue #448: role to sts:AssumeRole before calling
   * `lambda:GetLayerVersion` for every literal-ARN entry in any
   * routed Lambda's `Properties.Layers`. Independent of `--assume-role`
   * (which scopes the handler's runtime AWS calls). Use only when the
   * dev credentials cannot read the layer (cross-account case);
   * AWS-published public layers like Lambda Powertools need no role.
   */
  layerRoleArn?: string;
  /** Enable hot reload on CDK app source-tree changes (re-synth on edit). */
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
   * deployed CloudFormation stack via `ListStackResources` instead
   * of cdkd's S3 state. Mutually exclusive with `--from-state`.
   * Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true` (use the cdkd stack name per routed stack)
   *   - `--from-cfn-stack <name>` → `'<name>'` (single named CFn stack)
   */
  fromCfnStack?: string | boolean;
  /**
   * Opt-in: enforce strict AWS_IAM SigV4 verification. When set, requests
   * whose signature cannot be cryptographically verified (foreign
   * access-key-id, or no local AWS credentials) are denied. Default
   * `false` (warn-and-pass, matching cdk-local's `cdkl start-api`).
   * Mirrors the `--strict-sigv4` CLI flag.
   */
  strictSigv4?: boolean;
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
   * The user's UNFOLDED `--stack-region` spelling, captured at handler entry
   * before the fold above it (issue #1836 round 3). Consumed ONLY by the
   * state-record match in `local-state-loader.ts`, which resolves an
   * exactly-spelled region in preference to a case-variant record — a rule the
   * folded value cannot express. Never reaches an SDK client or an endpoint.
   */
  rawStackRegion?: string;
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
export interface BootedApiServer {
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
export interface BootedWebSocketServer {
  api: DiscoveredWebSocketApi;
  readonly server: StartedApiServer;
  readonly attached: AttachedWebSocketServer;
  readonly apiPath: string;
}
