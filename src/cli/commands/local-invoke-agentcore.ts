import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { CdkdError, withErrorHandling } from '../../utils/error-handler.js';
import { listTargets } from 'cdk-local';
import { resolveSingleTarget } from '../../local/target-picker.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { readCdkPathOrUndefined } from '../cdk-path.js';
import { createLocalStateProvider, resolveCfnFallbackRegion } from './local-state-source.js';
import type { LocalStateProvider, LocalStateRecord } from 'cdk-local';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from 'cdk-local';
import {
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_AGUI_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  pickAgentCoreCandidateStack,
  resolveAgentCoreTarget,
  type AgentCoreCodeArtifact,
  type ResolvedAgentCoreRuntime,
} from '../../local/agentcore-resolver.js';
import { buildAgentCoreCodeImage } from '../../local/agentcore-code-build.js';
import { downloadAndExtractS3Bundle } from '../../local/agentcore-s3-bundle.js';
import {
  signAgentCoreInvocation,
  type SigV4Credentials,
} from '../../local/agentcore-sigv4-sign.js';
import {
  invokeAgentCore,
  waitForAgentCorePing,
  type AgentCoreInvokeResult,
} from '../../local/agentcore-client.js';
import {
  mcpInvokeOnce,
  MCP_CONTAINER_PORT,
  MCP_PATH,
  type McpInvokeResult,
  type McpJsonRpcRequest,
} from '../../local/agentcore-mcp-client.js';
import {
  a2aInvokeOnce,
  A2A_CONTAINER_PORT,
  A2A_PATH,
  type A2aInvokeResult,
  type A2aJsonRpcRequest,
} from '../../local/agentcore-a2a-client.js';
import { invokeAgentCoreWs, type AgentCoreWsResult } from '../../local/agentcore-ws-client.js';
import { createJwksCache, verifyJwtViaDiscovery } from '../../local/cognito-jwt.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import {
  substituteAgainstStateAsync,
  substituteEnvVarsFromStateAsync,
  type SubstitutionContext,
} from '../../local/state-resolver.js';
import {
  derivePseudoParametersFromRegion,
  type ImageResolutionContext,
} from '../../local/intrinsic-image.js';
import {
  ensureDockerAvailable,
  pickFreePort,
  pullImage,
  removeContainer,
  runDetached,
  streamLogs,
} from '../../local/docker-runner.js';
import { buildContainerImage } from '../../local/docker-image-builder.js';
import { parseEcrUri, pullEcrImage } from '../../local/ecr-puller.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../assets/asset-manifest-loader.js';
import type { FileAsset } from '../../types/assets.js';
import { singleFlight } from '../../utils/single-flight.js';
import { resolveProfileCredentials } from './local-start-api.js';
import {
  applyProfileCredentialsOverlay,
  resolveExecutionRoleArnFromState,
} from './local-invoke.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from './local-profile-credentials-file.js';

interface LocalInvokeAgentCoreOptions {
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
  pull: boolean;
  build: boolean;
  containerHost: string;
  /** `--platform <linux/amd64|linux/arm64>`. Defaults to AgentCore's required arm64. */
  platform: string;
  /**
   * `--ws`: use the HTTP-protocol agent's bidirectional `/ws` WebSocket
   * endpoint (on 8080) instead of `POST /invocations` — send `--event` as the
   * first frame and stream received frames to stdout until the agent closes.
   */
  ws?: boolean;
  /**
   * `--ws-interactive`: after the initial `--event` frame, read additional
   * frames from stdin (one frame per line, trailing newline stripped) and
   * send each as a text frame to the agent until stdin EOFs (Ctrl-D) or the
   * agent closes the connection. Only meaningful with `--ws`.
   */
  wsInteractive?: boolean;
  /** Session id forwarded via the AgentCore session-id header (auto-generated when omitted). */
  sessionId?: string;
  /**
   * Bearer JWT to present when the runtime declares a `customJwtAuthorizer`.
   * Verified against the runtime's OIDC discovery URL before the container
   * starts, then forwarded to `/invocations` as `Authorization: Bearer <jwt>`.
   */
  bearerToken?: string;
  /**
   * Commander maps `--no-verify-auth` to `verifyAuth: boolean` (default
   * `true`). When `false`, skip inbound JWT verification entirely (local-dev
   * escape hatch) — the token, if any, is still forwarded.
   */
  verifyAuth: boolean;
  /**
   * `--sigv4`: sign the `/invocations` POST with AWS SigV4 (service
   * `bedrock-agentcore`) using the resolved credentials — matching the
   * cloud's default IAM-auth behavior when the runtime declares no
   * `customJwtAuthorizer`. The local agent receives the same `Authorization:
   * AWS4-HMAC-SHA256 ...` + `X-Amz-Date` / `X-Amz-Content-Sha256` /
   * `X-Amz-Security-Token` headers it would in the cloud. Opt-in: default
   * unsigned (preserves existing behavior). Mutually exclusive with
   * `--bearer-token` and ignored on a JWT-protected runtime.
   */
  sigv4?: boolean;
  /**
   * Optional execution role to assume before invoking. Commander's `[arn]`
   * maps to `string | boolean`:
   *   - absent → `undefined` (dev creds pass through; SAM-compatible default)
   *   - `--assume-role` (bare) → `true` (use the runtime's literal RoleArn)
   *   - `--assume-role <arn>` → `'<arn>'`
   *   - `--no-assume-role` → `false`
   */
  assumeRole?: string | boolean;
  /** Role ARN to assume before authenticating against ECR for the container image pull. */
  ecrRoleArn?: string;
  /** `--from-state` — load cdkd's S3 state for the target stack. */
  fromState: boolean;
  /** S3 bucket for `--from-state`. Falls back to CDKD_STATE_BUCKET / cdk.json. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state` (commander always supplies the default). */
  statePrefix: string;
  /** `--from-cfn-stack` — read a deployed CFn stack via DescribeStackResources. */
  fromCfnStack?: string | boolean;
  /** `--stack-region` — region of the state record / CFn client (issue #606). */
  stackRegion?: string;
  /**
   * Per-request timeout in milliseconds, applied to the HTTP `/invocations`
   * POST, the MCP `POST /mcp` request, and the `/ws` open-to-close window.
   * Default 120000 (120s). Raise this for long-running agent calls that
   * exceed the default — the cloud's AgentCore quota goes well above 120s.
   */
  timeout: number;
}

/**
 * Parser for `--timeout <ms>`. Accepts a positive integer; rejects 0,
 * negatives, fractions, and non-numeric input.
 */
export function parseTimeoutMs(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CdkdError(
      `--timeout must be a positive integer number of milliseconds (got '${raw}').`,
      'LOCAL_INVOKE_AGENTCORE_TIMEOUT_INVALID'
    );
  }
  return parsed;
}

/**
 * Factory options for {@link createLocalInvokeAgentCoreCommand}.
 */
export interface CreateLocalInvokeAgentCoreCommandOptions {
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl invoke-agentcore <target>` — run a Bedrock AgentCore Runtime container
 * locally and invoke it once over the AgentCore HTTP contract. Resolves
 * the `AWS::BedrockAgentCore::Runtime`, pulls / builds its container,
 * starts it on port 8080, waits for `GET /ping`, POSTs the event to
 * `POST /invocations`, prints the response, and tears down. Covers the
 * container artifact and the CodeConfiguration managed-runtime artifact
 * (fromCodeAsset, built from source) on the HTTP + MCP protocols; the agent's
 * calls to real AWS go to real AWS (credentials injected like `cdkl invoke`).
 */
async function localInvokeAgentCoreCommand(
  target: string | undefined,
  options: LocalInvokeAgentCoreOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  let containerId: string | undefined;
  let stopLogs: (() => void) | undefined;
  let sigintHandler: (() => void) | undefined;
  let profileCredsFile: ProfileCredentialsFile | undefined;
  let stateProvider: LocalStateProvider | undefined;

  const cleanup = singleFlight(
    async (): Promise<void> => {
      if (stateProvider) {
        try {
          stateProvider.dispose();
        } catch (err) {
          getLogger().debug(
            `state provider dispose failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
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
      if (profileCredsFile) {
        try {
          await profileCredsFile.dispose();
        } catch (err) {
          getLogger().debug(
            `Failed to remove profile credentials tmpdir ${profileCredsFile.hostPath}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    },
    (err) => {
      getLogger().debug(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  );

  try {
    await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });
    await ensureDockerAvailable();

    const profileCredentials = options.profile
      ? await resolveProfileCredentials(options.profile)
      : undefined;
    if (options.profile && profileCredentials) {
      profileCredsFile = await writeProfileCredentialsFile(options.profile, profileCredentials);
    }

    const appCmd = resolveApp(options.app);
    if (!appCmd) {
      throw new Error(
        `No CDK app specified. Pass --app, set ${getEmbedConfig().envPrefix}_APP, or add "app" to cdk.json.`
      );
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

    const resolvedTarget = await resolveSingleTarget(target, {
      entries: listTargets(stacks).agentCoreRuntimes,
      message: 'Select an AgentCore Runtime to invoke',
      noun: 'AgentCore Runtimes',
      onMissing: () =>
        new CdkdError(
          `${getEmbedConfig().cliName} invoke-agentcore requires a <target> (an AgentCore Runtime display path or logical ID). ` +
            `Run \`${getEmbedConfig().cliName} list\` to see them, or run it in a TTY to pick interactively.`,
          'LOCAL_INVOKE_AGENTCORE_TARGET_REQUIRED'
        ),
    });

    // Build a `--from-cfn-stack` image-resolution context BEFORE resolving the
    // target, so a same-stack AWS::ECR::Repository Fn::Join ContainerUri (or an
    // Fn::Sub asset URI) reduces to the deployed image URI. The state load is
    // shared with the env-substitution + role-from-state steps below.
    const candidate = pickAgentCoreCandidateStack(resolvedTarget, stacks);
    stateProvider = createLocalStateProvider(
      options,
      candidate?.stackName ?? '',
      await resolveCfnFallbackRegion(options, candidate?.region)
    );
    const { context: imageContext, loaded: loadedState } =
      stateProvider && candidate
        ? await buildAgentCoreImageContext(candidate, stateProvider, options)
        : { context: undefined, loaded: undefined };

    const resolved = resolveAgentCoreTarget(resolvedTarget, stacks, imageContext);
    logger.info(`Target: ${resolved.stack.stackName}/${resolved.logicalId} (${resolved.protocol})`);
    const isMcp = resolved.protocol === AGENTCORE_MCP_PROTOCOL;
    const isA2a = resolved.protocol === AGENTCORE_A2A_PROTOCOL;
    const isAgui = resolved.protocol === AGENTCORE_AGUI_PROTOCOL;
    if (isAgui) {
      // AG-UI's wire shape is HTTP-compatible: SSE on `POST /invocations` and a
      // bidirectional WebSocket on `/ws`, both on port 8080. So an AG-UI
      // runtime routes through the same client path as HTTP — the existing
      // SSE / WS handlers stream bytes transparently. Surface this in the
      // log so users aren't surprised the AGUI runtime "becomes" HTTP.
      logger.info(
        'AGUI runtime: routing through the HTTP /invocations + /ws path (AG-UI wire is SSE / WebSocket on port 8080).'
      );
    }
    if ((isMcp || isA2a) && options.ws) {
      logger.warn(
        `--ws applies only to the HTTP / AGUI protocols; ignoring it for this ${resolved.protocol} runtime.`
      );
    }
    if (options.wsInteractive && !options.ws) {
      logger.warn('--ws-interactive is meaningful only with --ws; ignoring.');
    }
    if (options.sigv4 && (isMcp || isA2a || options.ws)) {
      logger.warn(
        '--sigv4 signs the HTTP /invocations request only; ignoring it for the ' +
          (isMcp ? 'MCP' : isA2a ? 'A2A' : '/ws WebSocket') +
          ' path.'
      );
    }

    // Read + validate the event (and resolve the session id) BEFORE any
    // Docker work, so a bad --event / --event-stdin fails fast instead of
    // after paying for an image build + container boot.
    const sessionId = options.sessionId ?? randomUUID();
    const event = await readEvent(options);
    // For MCP, parse the event into a JSON-RPC request up front so a malformed
    // one fails fast too (default: tools/list).
    const mcpRequest = isMcp ? buildMcpRequest(event) : undefined;
    // A2A is JSON-RPC 2.0 too: parse the event up front into a method/params
    // (default: agent/getCard — the agent's discovery card).
    const a2aRequest = isA2a ? buildA2aRequest(event) : undefined;

    // Inbound JWT auth: when the runtime declares a customJwtAuthorizer,
    // verify the supplied bearer token against its OIDC discovery URL BEFORE
    // any Docker work — rejecting a missing / invalid token the way AgentCore
    // does. Returns the `Authorization` header to forward to the container.
    // MCP / A2A talk vanilla JSON-RPC directly to the container; their
    // bearer / session is an AgentCore managed-plane concern the front door
    // layers on top, so it is not applied to a direct local POST.
    let authorization: string | undefined;
    if (isMcp || isA2a) {
      if (resolved.jwtAuthorizer || options.bearerToken) {
        const pathLabel = isMcp ? MCP_PATH : A2A_PATH;
        logger.info(
          `${resolved.protocol} runtime: invoking the local container's ${pathLabel} directly (vanilla ${resolved.protocol}). ` +
            `An inbound JWT / --bearer-token is an AgentCore managed-plane concern and is not applied locally.`
        );
      }
    } else {
      authorization = await resolveInboundAuthorization(resolved, options);
    }

    // If the fromS3 bundle's Code.S3.Bucket is an intrinsic (Ref /
    // Fn::ImportValue / Fn::GetStackOutput), resolve it against --from-cfn-stack
    // state BEFORE the image step (which needs a literal bucket for the S3
    // download). Reuses the same substitution machinery env vars use, so
    // every cross-stack intrinsic the env path supports is supported here too.
    await resolveFromS3BucketIntrinsic(resolved, stateProvider, loadedState, imageContext);

    const image = await resolveAgentCoreImage(resolved, options, loadedState);

    const { env: dockerEnv, sensitiveEnvKeys } = await buildContainerEnv(
      resolved,
      options,
      profileCredentials,
      profileCredsFile,
      stateProvider,
      loadedState,
      imageContext
    );

    const hostPort = await pickFreePort();
    const containerHost = options.containerHost;
    // Stable `cdkl-`-prefixed name so the orphan sweep (`docker ps --filter
    // name=cdkl-`) used by `/cleanup` + `/run-integ` can find this container
    // if the process is killed before teardown — unlike a one-shot Lambda
    // invoke, the agent container runs a long-lived HTTP server.
    const containerName = `${getEmbedConfig().resourceNamePrefix}-agentcore-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const containerPort = isMcp ? MCP_CONTAINER_PORT : isA2a ? A2A_CONTAINER_PORT : undefined;
    const containerPortLabel = isMcp
      ? `${MCP_CONTAINER_PORT}${MCP_PATH}`
      : isA2a
        ? `${A2A_CONTAINER_PORT}${A2A_PATH}`
        : '8080';
    logger.info(
      `Starting agent container (image=${image}, port=${hostPort} -> ${containerPortLabel})...`
    );
    containerId = await runDetached({
      image,
      mounts: [],
      env: dockerEnv,
      cmd: [],
      hostPort,
      host: containerHost,
      platform: options.platform,
      name: containerName,
      ...(containerPort !== undefined && { containerPort }),
      // Keep decrypted SecureString SSM env values off the `docker run` argv.
      ...(sensitiveEnvKeys.size > 0 && { sensitiveEnvKeys }),
    });

    stopLogs = streamLogs(containerId);

    sigintHandler = (): void => {
      void cleanup().then(() => process.exit(130));
    };
    process.on('SIGINT', sigintHandler);

    if (isMcp && mcpRequest) {
      // MCP has no /ping: mcpInvokeOnce folds the boot-wait into a retried
      // `initialize`, then runs the session handshake + the one request.
      logger.info(`MCP request: ${mcpRequest.method}`);
      const mcp = await mcpInvokeOnce(containerHost, hostPort, mcpRequest, {
        requestTimeoutMs: options.timeout,
      });
      // Settle so container logs flush before teardown.
      await new Promise((r) => setTimeout(r, 250));
      emitMcpResult(mcp);
    } else if (isA2a && a2aRequest) {
      // A2A has no /ping either: a2aInvokeOnce folds the boot-wait into a
      // retried POST. One JSON-RPC round-trip — vanilla A2A.
      logger.info(`A2A request: ${a2aRequest.method}`);
      const a2a = await a2aInvokeOnce(containerHost, hostPort, a2aRequest, {
        requestTimeoutMs: options.timeout,
      });
      await new Promise((r) => setTimeout(r, 250));
      emitA2aResult(a2a);
    } else if (options.ws) {
      // Bidirectional `/ws` (same 8080 container as /invocations): send the
      // event as the first frame, stream every received frame to stdout, then
      // resolve when the agent closes the stream. With `--ws-interactive` we
      // additionally wire `process.stdin` (line-buffered) as a frame source,
      // so each typed line becomes a follow-up text frame until EOF / agent
      // close — a REPL on top of the same connection.
      await waitForAgentCorePing(containerHost, hostPort);
      const frameSource = options.wsInteractive ? readStdinLines() : undefined;
      logger.info(
        options.wsInteractive
          ? 'Opening the agent /ws WebSocket (interactive — stdin lines = follow-up frames; Ctrl-D to end)...'
          : 'Opening the agent /ws WebSocket and streaming frames...'
      );
      const wsResult = await invokeAgentCoreWs(containerHost, hostPort, event, {
        sessionId,
        timeoutMs: options.timeout,
        onMessage: (text) => process.stdout.write(text),
        ...(authorization && { authorization }),
        ...(frameSource && { frameSource }),
      });
      // Settle so container logs flush before teardown.
      await new Promise((r) => setTimeout(r, 250));
      emitWsResult(wsResult);
    } else {
      await waitForAgentCorePing(containerHost, hostPort);

      // `--sigv4` opt-in: sign the request with the resolved host credentials
      // (service `bedrock-agentcore`) so the agent receives the same
      // Authorization + X-Amz-* headers it would in the cloud. Mutually
      // exclusive with `--bearer-token`; ignored when a customJwtAuthorizer is
      // declared (the JWT path takes precedence).
      const additionalHeaders = await buildSigV4HeadersIfRequested(
        options,
        resolved,
        loadedState,
        containerHost,
        hostPort,
        event,
        sessionId
      );

      const result = await invokeAgentCore(containerHost, hostPort, event, {
        sessionId,
        timeoutMs: options.timeout,
        // Stream a text/event-stream response to stdout as it arrives, so a
        // token-streaming agent shows incrementally rather than all at once.
        onChunk: (text) => process.stdout.write(text),
        ...(authorization && { authorization }),
        ...(additionalHeaders && { additionalHeaders }),
      });

      // Settle so container logs flush before teardown.
      await new Promise((r) => setTimeout(r, 250));
      emitResult(result);
    }
  } finally {
    if (sigintHandler) process.off('SIGINT', sigintHandler);
    await cleanup();
  }
}

/**
 * Enforce the runtime's inbound JWT authorizer (when declared) and return
 * the `Authorization` header to forward to `/invocations`.
 *
 * - No authorizer → forward the token verbatim if one was given (no-op
 *   otherwise).
 * - `--no-verify-auth` → warn + forward without verifying (local-dev escape).
 * - Authorizer + no token → reject (AgentCore returns 401).
 * - Authorizer + token → verify against the OIDC discovery URL; reject on
 *   failure (AgentCore returns 403); forward on success. An unreachable
 *   discovery URL falls back to pass-through accept (offline-dev fallback in
 *   {@link verifyJwtViaDiscovery}).
 *
 * Exported so a unit test can drive the gate without the full Docker pipeline.
 */
export async function resolveInboundAuthorization(
  resolved: ResolvedAgentCoreRuntime,
  options: { bearerToken?: string; verifyAuth: boolean }
): Promise<string | undefined> {
  const logger = getLogger();
  const authorizer = resolved.jwtAuthorizer;
  const header = options.bearerToken ? `Bearer ${options.bearerToken}` : undefined;

  if (!authorizer) return header;

  if (options.verifyAuth === false) {
    logger.warn(
      `Runtime '${resolved.logicalId}' declares a customJwtAuthorizer, but --no-verify-auth was set — ` +
        `skipping inbound JWT verification (local-dev escape hatch).`
    );
    return header;
  }

  if (!header) {
    throw new CdkdError(
      `Runtime '${resolved.logicalId}' requires an inbound JWT (customJwtAuthorizer). ` +
        `Pass --bearer-token <jwt>, or --no-verify-auth to skip verification for local dev.`,
      'LOCAL_INVOKE_AGENTCORE_AUTH_REQUIRED'
    );
  }

  const result = await verifyJwtViaDiscovery(
    {
      discoveryUrl: authorizer.discoveryUrl,
      ...(authorizer.allowedAudience && { allowedAudience: authorizer.allowedAudience }),
      ...(authorizer.allowedClients && { allowedClients: authorizer.allowedClients }),
      ...(authorizer.allowedScopes && { allowedScopes: authorizer.allowedScopes }),
      ...(authorizer.customClaims && { customClaims: authorizer.customClaims }),
    },
    header,
    createJwksCache(),
    { warned: new Set() }
  );
  if (!result.allow) {
    throw new CdkdError(
      `Inbound JWT rejected by the runtime's customJwtAuthorizer ` +
        `(signature / issuer / expiry / audience check failed against ${authorizer.discoveryUrl}).`,
      'LOCAL_INVOKE_AGENTCORE_AUTH_DENIED'
    );
  }
  logger.info(`Inbound JWT verified against ${authorizer.discoveryUrl}.`);
  return header;
}

/**
 * Compute the SigV4 headers for the `/invocations` POST when `--sigv4` is
 * requested. Returns `undefined` (no header overlay) when:
 *
 * - `--sigv4` is not set,
 * - the runtime declares a `customJwtAuthorizer` (the JWT path wins; warns),
 *
 * Throws a {@link CdkdError} when `--sigv4` conflicts with
 * `--bearer-token`, or when no AWS credentials are resolvable for signing.
 *
 * Exported so a unit test can drive the gate without the full Docker pipeline.
 */
export async function buildSigV4HeadersIfRequested(
  options: LocalInvokeAgentCoreOptions,
  resolved: ResolvedAgentCoreRuntime,
  loaded: LocalStateRecord | undefined,
  host: string,
  port: number,
  event: unknown,
  sessionId: string
): Promise<Record<string, string> | undefined> {
  if (!options.sigv4) return undefined;
  if (options.bearerToken) {
    throw new CdkdError(
      `--sigv4 and --bearer-token are mutually exclusive: pick one inbound auth.`,
      'LOCAL_INVOKE_AGENTCORE_AUTH_CONFLICT'
    );
  }
  if (resolved.jwtAuthorizer) {
    getLogger().warn(
      `Runtime '${resolved.logicalId}' declares a customJwtAuthorizer; --sigv4 ignored (JWT path takes precedence).`
    );
    return undefined;
  }
  const region =
    options.region ??
    options.stackRegion ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    resolved.stack.region;
  if (!region) {
    throw new CdkdError(
      `--sigv4: no region resolved for the AgentCore signing scope. ` +
        `Pass --region <region>, set AWS_REGION, or use --from-cfn-stack with a region-bound stack.`,
      'LOCAL_INVOKE_AGENTCORE_SIGV4_NO_REGION'
    );
  }
  const credentials = await resolveHostCredentialsForSigV4(options, resolved, loaded, region);
  const signed = await signAgentCoreInvocation({
    credentials,
    region,
    host,
    port,
    path: '/invocations',
    body: JSON.stringify(event ?? {}),
    sessionId,
  });
  const headers: Record<string, string> = {
    Authorization: signed.authorization,
    'X-Amz-Date': signed.amzDate,
    'X-Amz-Content-Sha256': signed.amzContentSha256,
  };
  if (signed.amzSecurityToken) headers['X-Amz-Security-Token'] = signed.amzSecurityToken;
  getLogger().info(`Signed /invocations with SigV4 (region=${region}).`);
  return headers;
}

/**
 * Resolve credentials for host-side SigV4 signing. Precedence:
 *   1. `--assume-role` → STS temp creds (warn + fall through on STS failure);
 *   2. `--profile` → profile creds (sessionToken when the profile carries one);
 *   3. shell env (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / optional
 *      `AWS_SESSION_TOKEN`).
 *
 * Throws a {@link CdkdError} when none are available — `--sigv4` cannot
 * proceed without credentials, unlike the unsigned path.
 */
async function resolveHostCredentialsForSigV4(
  options: LocalInvokeAgentCoreOptions,
  resolved: ResolvedAgentCoreRuntime,
  loaded: LocalStateRecord | undefined,
  region: string
): Promise<SigV4Credentials> {
  const logger = getLogger();
  const assumeRoleArn = resolveAssumeRoleArn(options, resolved, loaded);
  if (assumeRoleArn) {
    try {
      return await assumeAgentCoreExecutionRole(assumeRoleArn, region);
    } catch (err) {
      logger.warn(
        `--assume-role: STS AssumeRole(${assumeRoleArn}) failed for --sigv4 signing: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Falling back to ${options.profile ? `--profile ${options.profile}` : 'shell credentials'}.`
      );
    }
  }
  if (options.profile) {
    const creds = await resolveProfileCredentials(options.profile);
    if (creds?.accessKeyId && creds.secretAccessKey) {
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken && { sessionToken: creds.sessionToken }),
      };
    }
  }
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY'];
  if (accessKeyId && secretAccessKey) {
    const sessionToken = process.env['AWS_SESSION_TOKEN'];
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken && { sessionToken }),
    };
  }
  throw new CdkdError(
    `--sigv4: no AWS credentials available to sign the request. ` +
      `Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, pass --profile <name>, or pass --assume-role <arn>.`,
    'LOCAL_INVOKE_AGENTCORE_SIGV4_NO_CREDENTIALS'
  );
}

/**
 * Acquire the agent image. A CODE artifact (managed runtime) is built from
 * source — a fromCodeAsset bundle from its cdk.out asset, a fromS3 bundle
 * downloaded + extracted from S3. A CONTAINER artifact mirrors the
 * container-Lambda path: build from a local cdk.out asset when the URI matches
 * one, else pull from ECR, else pull a plain registry image.
 *
 * `loaded` is the `--from-cfn-stack` state record (when available) — threaded
 * through so a bare `--assume-role` can resolve the execution-role ARN from
 * state for the fromS3 download.
 */
export async function resolveAgentCoreImage(
  resolved: ResolvedAgentCoreRuntime,
  options: LocalInvokeAgentCoreOptions,
  loaded?: LocalStateRecord
): Promise<string> {
  const logger = getLogger();
  const architecture = platformToArchitecture(options.platform);

  if (resolved.codeArtifact) {
    return resolveAgentCoreCodeImage(
      resolved,
      resolved.codeArtifact,
      options,
      architecture,
      loaded
    );
  }

  const containerUri = resolved.containerUri;
  if (containerUri === undefined) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' has neither a container image nor a code artifact to run.`,
      'LOCAL_INVOKE_AGENTCORE_NO_ARTIFACT'
    );
  }

  const manifestPath = resolved.stack.assetManifestPath;
  if (manifestPath) {
    const cdkOutDir = dirname(manifestPath);
    const loader = new AssetManifestLoader();
    const manifest = await loader.loadManifest(cdkOutDir, resolved.stack.stackName);
    if (manifest) {
      const entry = getDockerImageBySourceHash(manifest, containerUri);
      if (entry) {
        return buildContainerImage(entry.asset, cdkOutDir, {
          architecture,
          noBuild: options.build === false,
        });
      }
    }
  }

  if (parseEcrUri(containerUri)) {
    logger.info(`Pulling agent image from ECR: ${containerUri}`);
    return pullEcrImage(containerUri, {
      skipPull: options.pull === false,
      ...(options.region !== undefined && { region: options.region }),
      ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
      ...(options.profile !== undefined && { profile: options.profile }),
    });
  }

  await pullImage(containerUri, options.pull === false);
  return containerUri;
}

/**
 * Build a local image from a `CodeConfiguration` (managed-runtime) bundle.
 *
 * - fromS3 (`code.s3Source` set, a literal S3 object): download + extract the
 *   bundle, then run the from-source build over the extracted dir.
 * - fromCodeAsset: locate the source dir in cdk.out via its asset hash, then
 *   run the same from-source build (generated Dockerfile → install deps → run
 *   EntryPoint).
 */
async function resolveAgentCoreCodeImage(
  resolved: ResolvedAgentCoreRuntime,
  code: AgentCoreCodeArtifact,
  options: LocalInvokeAgentCoreOptions,
  architecture: 'x86_64' | 'arm64',
  loaded?: LocalStateRecord
): Promise<string> {
  if (code.s3Source) {
    return resolveAgentCoreCodeImageFromS3(
      resolved,
      code,
      code.s3Source,
      options,
      architecture,
      loaded
    );
  }

  const manifestPath = resolved.stack.assetManifestPath;
  if (!manifestPath) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' uses a code artifact, but its stack has no asset ` +
        `manifest in cdk.out to read the bundle source from.`,
      'LOCAL_INVOKE_AGENTCORE_CODE_NO_MANIFEST'
    );
  }
  const cdkOutDir = dirname(manifestPath);
  const loader = new AssetManifestLoader();
  const manifest = await loader.loadManifest(cdkOutDir, resolved.stack.stackName);
  const fileAssets = manifest ? loader.getFileAssets(manifest) : undefined;
  // The manifest's `files` are keyed by SOURCE hash; for the default
  // synthesizer that equals the destination objectKey hash (`<hash>.zip`), so a
  // direct key lookup hits. Fall back to matching the destination objectKey so
  // a synthesizer that emits a prefixed / differing objectKey still resolves.
  const asset = fileAssets
    ? (fileAssets.get(code.codeAssetHash) ??
      findFileAssetByObjectKey(fileAssets, code.codeAssetHash))
    : undefined;
  if (!asset) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' code bundle (asset ${code.codeAssetHash}) was not found ` +
        `in the cdk.out asset manifest. ${getEmbedConfig().cliName} invoke-agentcore runs a local from-source ` +
        `build of a fromCodeAsset bundle — re-synthesize the app so the asset is staged in cdk.out and retry. ` +
        `(A fromS3 bundle is downloaded from S3 instead; this runtime has no literal Code.S3.Bucket.)`,
      'LOCAL_INVOKE_AGENTCORE_CODE_ASSET_NOT_FOUND'
    );
  }
  const sourceDir = loader.getAssetSourcePath(cdkOutDir, asset);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' code bundle source '${sourceDir}' does not exist or is not a ` +
        `directory. Re-synthesize the app and retry.`,
      'LOCAL_INVOKE_AGENTCORE_CODE_SOURCE_MISSING'
    );
  }
  return buildAgentCoreCodeImage({
    sourceDir,
    runtime: code.runtime,
    entryPoint: code.entryPoint,
    architecture,
    noBuild: options.build === false,
  });
}

/**
 * Build a local image from a fromS3 CodeConfiguration bundle: download +
 * extract the S3 object, run the from-source build over the extracted dir, then
 * clean up the temp dir.
 *
 * Credentials mirror the rest of the command: an `--assume-role` ARN (explicit,
 * or resolved from `--from-cfn-stack` state for the bare form) yields STS temp
 * creds for the download; otherwise `--profile` / the default chain is used.
 * The region is `--region` / `--stack-region` / env / the stack's region.
 */
async function resolveAgentCoreCodeImageFromS3(
  resolved: ResolvedAgentCoreRuntime,
  code: AgentCoreCodeArtifact,
  s3Source: NonNullable<AgentCoreCodeArtifact['s3Source']>,
  options: LocalInvokeAgentCoreOptions,
  architecture: 'x86_64' | 'arm64',
  loaded: LocalStateRecord | undefined
): Promise<string> {
  const logger = getLogger();
  // The bucket should be a literal string by this point — a template-literal
  // bucket falls through from the resolver, an intrinsic bucket was resolved by
  // `resolveFromS3BucketIntrinsic` in the outer command before we got here.
  if (typeof s3Source.bucket !== 'string' || s3Source.bucket.length === 0) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' fromS3 bundle reached the image step with no literal bucket. ` +
        `This is a cdk-local bug — please report it.`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_UNRESOLVED'
    );
  }
  const location = {
    bucket: s3Source.bucket,
    key: s3Source.key,
    ...(s3Source.versionId !== undefined && { versionId: s3Source.versionId }),
  };
  const region =
    options.region ??
    options.stackRegion ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    resolved.stack.region;

  const assumeRoleArn = resolveAssumeRoleArn(options, resolved, loaded);
  let credentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken: string }
    | undefined;
  if (assumeRoleArn) {
    try {
      credentials = await assumeAgentCoreExecutionRole(assumeRoleArn, region);
    } catch (err) {
      logger.warn(
        `--assume-role: STS AssumeRole(${assumeRoleArn}) failed for the fromS3 bundle download: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Falling back to ${options.profile ? `--profile ${options.profile}` : 'the default credentials'}.`
      );
    }
  }

  const bundle = await downloadAndExtractS3Bundle(location, {
    ...(region !== undefined && { region }),
    ...(options.profile !== undefined && { profile: options.profile }),
    ...(credentials !== undefined && { credentials }),
  });
  try {
    return await buildAgentCoreCodeImage({
      sourceDir: bundle.dir,
      runtime: code.runtime,
      entryPoint: code.entryPoint,
      architecture,
      noBuild: options.build === false,
    });
  } finally {
    await bundle.cleanup();
  }
}

/**
 * Find the file asset whose destination objectKey is `<hash>.zip` (matching the
 * `Code.S3.Prefix`'s hash) when the source-hash-keyed lookup misses — covers a
 * synthesizer whose source hash differs from the destination objectKey.
 */
function findFileAssetByObjectKey(
  fileAssets: Map<string, FileAsset>,
  hash: string
): FileAsset | undefined {
  const zip = `${hash}.zip`;
  for (const asset of fileAssets.values()) {
    const hit = Object.values(asset.destinations).some(
      (d) => d.objectKey === zip || d.objectKey.endsWith(`/${zip}`)
    );
    if (hit) return asset;
  }
  return undefined;
}

/**
 * Build the container env + the set of env keys to keep off the `docker run`
 * argv. Substitutes `--from-cfn-stack` state into the template env (reusing the
 * shared state load + image-resolution context — Ref / Fn::Sub / Fn::Join +
 * SSM parameters, with decrypted SecureString values flagged sensitive),
 * applies `--env-vars` overrides, then injects AWS credentials (`--assume-role`
 * STS temp creds — resolving an intrinsic RoleArn from state for bare
 * `--assume-role` — else `--profile` / dev creds).
 *
 * The state provider + loaded record + image context are built once by the
 * caller and shared here, so this does not re-load state.
 */
export async function buildContainerEnv(
  resolved: ResolvedAgentCoreRuntime,
  options: LocalInvokeAgentCoreOptions,
  profileCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined,
  stateProvider: LocalStateProvider | undefined,
  loaded: LocalStateRecord | undefined,
  imageContext: ImageResolutionContext | undefined
): Promise<{ env: Record<string, string>; sensitiveEnvKeys: Set<string> }> {
  const logger = getLogger();
  let templateEnv: Record<string, unknown> = resolved.environmentVariables;
  const sensitiveEnvKeys = new Set<string>();

  if (stateProvider && loaded) {
    const subContext: SubstitutionContext = {
      resources: imageContext?.stateResources ?? loaded.resources,
      consumerRegion: loaded.region,
    };
    const pseudo =
      imageContext?.pseudoParameters ?? derivePseudoParametersFromRegion(loaded.region);
    if (pseudo) subContext.pseudoParameters = pseudo;
    if (imageContext?.stateParameters) subContext.parameters = imageContext.stateParameters;
    if (imageContext?.stateSensitiveParameters?.length) {
      subContext.sensitiveParameters = new Set(imageContext.stateSensitiveParameters);
    }
    const resolver = await stateProvider.buildCrossStackResolver(loaded.region);
    if (resolver) subContext.crossStackResolver = resolver;
    const { env, audit } = await substituteEnvVarsFromStateAsync(templateEnv, subContext);
    templateEnv = env;
    for (const key of audit.resolvedKeys) {
      logger.debug(`${stateProvider.label}: substituted env var ${key}`);
    }
    // Decrypted SecureString SSM values: keep them off the `docker run` argv.
    for (const key of audit.sensitiveKeys) sensitiveEnvKeys.add(key);
    for (const { key, reason } of audit.unresolved) {
      logger.warn(
        `${stateProvider.label}: could not substitute env var ${key} (${reason}). ` +
          `Override it via --env-vars or it will be dropped.`
      );
    }
  }

  const overrides = readEnvOverridesFile(options.envVars);
  const cdkPath = readCdkPathOrUndefined(resolved.resource);
  const envResult = resolveEnvVars(resolved.logicalId, cdkPath, templateEnv, overrides);
  for (const key of envResult.unresolved) {
    const overrideKeyExample = cdkPath?.replace(/\/Resource$/, '') ?? resolved.logicalId;
    logger.warn(
      `Environment variable ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${overrideKeyExample}":{"${key}":"<literal>"}}), ` +
        `or pass a state-source flag (e.g. --from-cfn-stack) to recover deployed values.`
    );
  }

  const dockerEnv: Record<string, string> = { ...envResult.resolved };
  const assumeRoleArn = resolveAssumeRoleArn(options, resolved, loaded);
  await applyAgentCoreCredentialEnv(dockerEnv, {
    ...(assumeRoleArn !== undefined && { assumeRoleArn }),
    ...(options.region !== undefined && { region: options.region }),
    ...(profileCredentials !== undefined && { profileCredentials }),
    ...(profileCredsFile !== undefined && {
      profileCredsFile: {
        containerPath: profileCredsFile.containerPath,
        profileName: profileCredsFile.profileName,
      },
    }),
  });
  return { env: dockerEnv, sensitiveEnvKeys };
}

/**
 * Resolve a fromS3 bundle's intrinsic `Code.S3.Bucket` to a literal bucket
 * name in place on `resolved.codeArtifact.s3Source.bucket`. Uses the SAME
 * state-substitution machinery env vars use under `--from-cfn-stack`, so
 * every cross-stack intrinsic that path supports (`Ref` / `Fn::ImportValue` /
 * `Fn::GetStackOutput`) is supported transparently here.
 *
 * No-op when there is no intrinsic to resolve. Errors when no state is
 * available, or when the substitution returns a non-string / unresolved value.
 *
 * Exported so a unit test can drive the gate without the full Docker pipeline.
 */
export async function resolveFromS3BucketIntrinsic(
  resolved: ResolvedAgentCoreRuntime,
  stateProvider: LocalStateProvider | undefined,
  loaded: LocalStateRecord | undefined,
  imageContext: ImageResolutionContext | undefined
): Promise<void> {
  const s3Source = resolved.codeArtifact?.s3Source;
  if (!s3Source || s3Source.bucketIntrinsic === undefined) return;
  if (s3Source.bucket !== undefined) return; // already resolved

  if (!stateProvider || !loaded) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' fromS3 bundle's Code.S3.Bucket is an unresolved intrinsic ` +
        `(${describeIntrinsic(s3Source.bucketIntrinsic)}). ` +
        `Pass --from-cfn-stack so its physical bucket name can be resolved against the deployed stack state.`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_INTRINSIC_NO_STATE'
    );
  }

  const subContext: SubstitutionContext = {
    resources: imageContext?.stateResources ?? loaded.resources,
    consumerRegion: loaded.region,
  };
  const pseudo = imageContext?.pseudoParameters ?? derivePseudoParametersFromRegion(loaded.region);
  if (pseudo) subContext.pseudoParameters = pseudo;
  const crossStackResolver = await stateProvider.buildCrossStackResolver(loaded.region);
  if (crossStackResolver) subContext.crossStackResolver = crossStackResolver;

  const result = await substituteAgainstStateAsync(s3Source.bucketIntrinsic, subContext);
  if (result.kind !== 'literal') {
    throw new CdkdError(
      `Could not resolve AgentCore Runtime '${resolved.logicalId}' fromS3 Code.S3.Bucket intrinsic ` +
        `(${describeIntrinsic(s3Source.bucketIntrinsic)}) against the --from-cfn-stack state: ${result.reason}. ` +
        `Confirm the referenced resource / export exists in the deployed stack.`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_INTRINSIC_UNRESOLVED'
    );
  }
  if (typeof result.value !== 'string' || result.value.length === 0) {
    throw new CdkdError(
      `AgentCore Runtime '${resolved.logicalId}' fromS3 Code.S3.Bucket intrinsic resolved to a ` +
        `${typeof result.value} value, not a bucket name string. ` +
        `(${describeIntrinsic(s3Source.bucketIntrinsic)})`,
      'LOCAL_INVOKE_AGENTCORE_FROMS3_BUCKET_INTRINSIC_NOT_STRING'
    );
  }
  s3Source.bucket = result.value;
  getLogger().info(
    `Resolved fromS3 Code.S3.Bucket from state: ${describeIntrinsic(s3Source.bucketIntrinsic)} -> ${result.value}`
  );
}

/** Render the intrinsic key for an error / log message (e.g. `Ref:Bucket1`). */
function describeIntrinsic(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const obj = value as Record<string, unknown>;
  const key = Object.keys(obj)[0] ?? '?';
  const arg = obj[key];
  if (typeof arg === 'string') return `${key}:${arg}`;
  return key;
}

/**
 * Build the `--from-cfn-stack` image-resolution context + return the loaded
 * state record (loaded once, reused by env substitution + role resolution).
 * Mirrors `run-task`'s `buildEcsImageResolutionContext`: pseudo parameters
 * (region + STS account id), the deployed resources, and SSM template
 * parameters (decrypted SecureString logical ids flagged sensitive).
 */
export async function buildAgentCoreImageContext(
  candidate: StackInfo,
  stateProvider: LocalStateProvider,
  options: LocalInvokeAgentCoreOptions
): Promise<{ context: ImageResolutionContext | undefined; loaded: LocalStateRecord | undefined }> {
  const logger = getLogger();
  const region =
    options.region ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    candidate.region;

  let accountId: string | undefined;
  try {
    accountId = await resolveCallerAccountId(region, options.profile);
  } catch (err) {
    logger.warn(
      `--from-cfn-stack: STS GetCallerIdentity failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'A same-stack ECR image URI referencing ${AWS::AccountId} may not resolve.'
    );
  }

  const context: ImageResolutionContext = {};
  const pseudo = derivePseudoParametersFromRegion(region, accountId);
  if (pseudo) context.pseudoParameters = pseudo;

  const loaded = await stateProvider.load(candidate.stackName, candidate.region);
  if (loaded) {
    context.stateResources = loaded.resources;
    if (stateProvider.resolveTemplateSsmParameters) {
      const ssm = await stateProvider.resolveTemplateSsmParameters(candidate.template);
      if (Object.keys(ssm.values).length > 0) context.stateParameters = ssm.values;
      if (ssm.secureStringLogicalIds.length > 0) {
        context.stateSensitiveParameters = ssm.secureStringLogicalIds;
      }
    }
  }
  return { context, loaded: loaded ?? undefined };
}

/** STS `GetCallerIdentity` for the `${AWS::AccountId}` pseudo parameter (threads `--profile`). */
async function resolveCallerAccountId(
  region: string | undefined,
  profile: string | undefined
): Promise<string | undefined> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }), ...(profile && { profile }) });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account;
  } finally {
    sts.destroy();
  }
}

/**
 * Inject AWS credentials into the container env. Precedence:
 *   1. `--assume-role` → STS-issued temp creds for the resolved ARN (on
 *      STS failure, warn + fall through to dev creds).
 *   2. dev shell creds (`forwardAwsEnv`) + `--profile` overlay
 *      ({@link applyProfileCredentialsOverlay}) + the bind-mounted
 *      credentials-file env so handler `fromIni({ profile })` resolves.
 *
 * Exported so a unit test can lock the binding (mock STS) without driving
 * the full synth + docker pipeline.
 */
export async function applyAgentCoreCredentialEnv(
  dockerEnv: Record<string, string>,
  args: {
    assumeRoleArn?: string;
    region?: string;
    profileCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    profileCredsFile?: { containerPath: string; profileName: string };
  }
): Promise<void> {
  const logger = getLogger();
  let assumeSucceeded = false;
  if (args.assumeRoleArn) {
    const stsRegion = args.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
    try {
      const creds = await assumeAgentCoreExecutionRole(args.assumeRoleArn, stsRegion);
      dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
      dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
      dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
      if (stsRegion) dockerEnv['AWS_REGION'] = stsRegion;
      assumeSucceeded = true;
    } catch (err) {
      logger.warn(
        `--assume-role: STS AssumeRole(${args.assumeRoleArn}) failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Falling back to the developer's shell credentials."
      );
    }
  }
  if (!assumeSucceeded) {
    forwardAwsEnv(dockerEnv);
    applyProfileCredentialsOverlay(dockerEnv, args.profileCredentials, false);
    if (args.profileCredsFile) {
      dockerEnv['AWS_SHARED_CREDENTIALS_FILE'] = args.profileCredsFile.containerPath;
      dockerEnv['AWS_PROFILE'] = args.profileCredsFile.profileName;
    }
  }
}

/**
 * Resolve the role ARN to assume, honoring the three `--assume-role` forms.
 * Bare `--assume-role` uses the runtime's literal `RoleArn`; when that is an
 * intrinsic (the common L2 case — `Fn::GetAtt` to an auto-created role) it
 * resolves the execution-role ARN from `--from-cfn-stack` state, and only
 * warns + falls back to dev creds when neither is available.
 */
export function resolveAssumeRoleArn(
  options: LocalInvokeAgentCoreOptions,
  resolved: ResolvedAgentCoreRuntime,
  loaded: LocalStateRecord | undefined
): string | undefined {
  if (typeof options.assumeRole === 'string') return options.assumeRole;
  if (options.assumeRole === true) {
    if (resolved.roleArn) return resolved.roleArn;
    if (loaded) {
      const fromState = resolveExecutionRoleArnFromState(loaded, resolved.logicalId, 'RoleArn');
      if (fromState) {
        getLogger().debug(`--assume-role: resolved RoleArn from state: ${fromState}`);
        return fromState;
      }
    }
    getLogger().warn(
      "--assume-role passed without an ARN, but the runtime's RoleArn is not a literal ARN in the template " +
        (loaded
          ? 'and could not be resolved from the deployed stack state. '
          : 'and no --from-cfn-stack state is available to resolve it. ') +
        'Pass the ARN explicitly: --assume-role <arn>. ' +
        "Falling back to the developer's shell credentials."
    );
  }
  return undefined;
}

export function emitResult(result: AgentCoreInvokeResult): void {
  const logger = getLogger();
  if (result.status >= 400) {
    logger.warn(`Agent /invocations returned HTTP ${result.status}.`);
    process.exitCode = 1;
  }
  if (result.streamed) {
    // The SSE body was already written chunk-by-chunk via the onChunk sink;
    // just terminate with a newline so the shell prompt resumes cleanly.
    process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${result.raw}\n`);
}

/**
 * Finish a `/ws` exchange: the frames were already streamed to stdout via the
 * onMessage sink, so just terminate with a newline (so the shell prompt resumes
 * cleanly) and note the frame count at debug level.
 */
export function emitWsResult(result: AgentCoreWsResult): void {
  process.stdout.write('\n');
  getLogger().debug(`Agent /ws closed after ${result.frames} frame(s).`);
}

/**
 * Build the JSON-RPC request to send to an MCP runtime from `--event`:
 *   - no `--event` (empty object) → `tools/list` (discover the server's tools),
 *   - an object with a string `method` → that method + its `params`,
 *   - anything else → a fail-fast error.
 *
 * Exported for unit testing.
 */
export function buildMcpRequest(event: unknown): McpJsonRpcRequest {
  if (event === undefined || event === null) return { method: 'tools/list', params: {} };
  if (typeof event !== 'object' || Array.isArray(event)) {
    throw new CdkdError(
      'MCP --event must be a JSON object describing a JSON-RPC request ' +
        '(e.g. {"method":"tools/call","params":{"name":"...","arguments":{...}}}).',
      'LOCAL_INVOKE_AGENTCORE_MCP_EVENT_INVALID'
    );
  }
  const obj = event as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return { method: 'tools/list', params: {} };
  if (typeof obj['method'] !== 'string') {
    throw new CdkdError(
      'MCP --event must include a string "method" (a JSON-RPC method such as ' +
        `"tools/list" or "tools/call"). Got keys: ${Object.keys(obj).join(', ')}.`,
      'LOCAL_INVOKE_AGENTCORE_MCP_EVENT_INVALID'
    );
  }
  return {
    method: obj['method'],
    ...(obj['params'] !== undefined && { params: obj['params'] }),
  };
}

/** Print the MCP JSON-RPC response; exit 1 when it carried a JSON-RPC error. */
export function emitMcpResult(result: McpInvokeResult): void {
  if (!result.ok) {
    getLogger().warn('MCP server returned a JSON-RPC error.');
    process.exitCode = 1;
  }
  process.stdout.write(`${result.raw}\n`);
}

/**
 * Build the JSON-RPC request to send to an A2A runtime from `--event`:
 *   - no `--event` (empty object) → `agent/getCard` (discover the agent's card),
 *   - an object with a string `method` → that method + its `params`,
 *   - anything else → a fail-fast error.
 *
 * Exported for unit testing.
 */
export function buildA2aRequest(event: unknown): A2aJsonRpcRequest {
  if (event === undefined || event === null) return { method: 'agent/getCard', params: {} };
  if (typeof event !== 'object' || Array.isArray(event)) {
    throw new CdkdError(
      'A2A --event must be a JSON object describing a JSON-RPC request ' +
        '(e.g. {"method":"tasks/send","params":{"id":"...","message":{...}}}).',
      'LOCAL_INVOKE_AGENTCORE_A2A_EVENT_INVALID'
    );
  }
  const obj = event as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return { method: 'agent/getCard', params: {} };
  if (typeof obj['method'] !== 'string') {
    throw new CdkdError(
      'A2A --event must include a string "method" (a JSON-RPC method such as ' +
        `"agent/getCard" or "tasks/send"). Got keys: ${Object.keys(obj).join(', ')}.`,
      'LOCAL_INVOKE_AGENTCORE_A2A_EVENT_INVALID'
    );
  }
  return {
    method: obj['method'],
    ...(obj['params'] !== undefined && { params: obj['params'] }),
  };
}

/** Print the A2A JSON-RPC response; exit 1 when it carried a JSON-RPC error. */
export function emitA2aResult(result: A2aInvokeResult): void {
  if (!result.ok) {
    getLogger().warn('A2A server returned a JSON-RPC error.');
    process.exitCode = 1;
  }
  process.stdout.write(`${result.raw}\n`);
}

/** Map a `--platform` value to the architecture `buildContainerImage` expects. */
export function platformToArchitecture(platform: string): 'x86_64' | 'arm64' {
  return platform === 'linux/amd64' ? 'x86_64' : 'arm64';
}

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

async function assumeAgentCoreExecutionRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `${getEmbedConfig().resourceNamePrefix}-invoke-agentcore-${Date.now()}`,
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

export async function readEvent(options: LocalInvokeAgentCoreOptions): Promise<unknown> {
  if (options.event && options.eventStdin) {
    throw new Error('--event and --event-stdin are mutually exclusive.');
  }
  if (options.eventStdin) {
    return parseEvent(await readStdin(), '<stdin>');
  }
  if (options.event) {
    let raw: string;
    try {
      raw = readFileSync(options.event, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read --event file '${options.event}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return parseEvent(raw, options.event);
  }
  return {};
}

function parseEvent(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse event payload from ${source} as JSON: ${err instanceof Error ? err.message : String(err)}`
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
 * Read `process.stdin` line-buffered and yield each line as a string (trailing
 * `\r?\n` stripped). The async iterable completes when stdin EOFs (Ctrl-D /
 * end-of-pipe), and surrenders the underlying stream when its `return()` is
 * called — so the WS client can close down the source when the server closes
 * first without leaving stdin held open.
 *
 * Exported so a unit test can drive the iterable shape directly.
 */
export async function* readStdinLines(): AsyncIterable<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
  }
}

export function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
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

export function createLocalInvokeAgentCoreCommand(
  opts: CreateLocalInvokeAgentCoreCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('invoke-agentcore')
    .description(
      'Run a Bedrock AgentCore Runtime container locally and invoke it once over its protocol ' +
        'contract: HTTP (POST /invocations + GET /ping on 8080) or MCP (POST /mcp Streamable HTTP ' +
        'on 8000). Resolves the AWS::BedrockAgentCore::Runtime, pulls/builds its container, injects ' +
        'env vars + AWS credentials, and prints the response. For an MCP runtime, runs the session ' +
        'handshake then sends one JSON-RPC request (tools/list by default, or the method/params from ' +
        '--event). Target accepts a CDK display path (MyStack/MyAgent) or stack-qualified logical ID ' +
        '(MyStack:MyAgentRuntime1234). Single-stack apps may omit the stack prefix. ' +
        'Omit <target> in an interactive terminal to pick from a list. ' +
        'Supports the container artifact and the CodeConfiguration managed-runtime artifact ' +
        '(fromCodeAsset, built from source) on the HTTP + MCP protocols; the agent calls real AWS for managed services.'
    )
    .argument(
      '[target]',
      'CDK display path or stack-qualified logical ID of the AgentCore Runtime to invoke (omit to pick interactively in a TTY)'
    )
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
        '--session-id <id>',
        'AgentCore runtime session id header value (default: a random UUID)'
      )
    )
    .addOption(
      new Option(
        '--ws',
        "Stream over the HTTP-protocol agent's bidirectional /ws WebSocket endpoint (on 8080) " +
          'instead of POST /invocations: send --event as the first frame and print every received ' +
          'frame to stdout until the agent closes. Ignored for an MCP runtime.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--ws-interactive',
        'REPL mode for --ws: after the initial --event frame, read additional frames from stdin ' +
          '(one frame per line, trailing newline stripped) and send each as a text frame until ' +
          'stdin EOFs (Ctrl-D) or the agent closes. Only meaningful with --ws.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--bearer-token <jwt>',
        'Bearer JWT to present when the runtime declares a customJwtAuthorizer. ' +
          'Verified against the runtime OIDC discovery URL (signature / issuer / expiry / ' +
          'audience) before the container starts, then forwarded to /invocations as ' +
          'Authorization: Bearer <jwt>.'
      )
    )
    .addOption(
      new Option(
        '--no-verify-auth',
        'Skip inbound JWT verification even when the runtime declares a customJwtAuthorizer ' +
          '(local-dev escape hatch). A --bearer-token, if given, is still forwarded.'
      )
    )
    .addOption(
      new Option(
        '--sigv4',
        'Sign the /invocations POST with AWS SigV4 (service bedrock-agentcore) using the resolved ' +
          'credentials, matching the cloud default when the runtime declares no customJwtAuthorizer. ' +
          'Opt-in: default unsigned. Mutually exclusive with --bearer-token; ignored on a JWT-protected runtime.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'docker --platform for the agent container (linux/amd64 or linux/arm64)'
      )
        .choices(['linux/amd64', 'linux/arm64'])
        .default('linux/arm64')
    )
    .addOption(
      new Option(
        '--no-pull',
        'Skip docker pull (use cached image) — no-op for the local-build path'
      )
    )
    .addOption(
      new Option(
        '--no-build',
        'Skip docker build on the local-asset path (use the previously-built tag). No-op for the ECR / registry pull paths.'
      )
    )
    .addOption(
      new Option('--container-host <host>', 'Host to bind the agent port to').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--timeout <ms>',
        'Per-request timeout in milliseconds. Applied to POST /invocations, POST /mcp, and the ' +
          '/ws open-to-close window. Raise this for long-running agent calls that exceed the default.'
      )
        .default(120000)
        .argParser(parseTimeoutMs)
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume the runtime's execution role and forward STS-issued temp credentials to the container " +
          'so the agent runs with the deployed role. Three forms: ' +
          '(1) `--assume-role <arn>` assumes the explicit ARN; ' +
          "(2) `--assume-role` (bare) uses the runtime's RoleArn when it is a literal ARN; " +
          '(3) `--no-assume-role` opts out. ' +
          "Off by default — the developer's shell credentials are forwarded unchanged."
      )
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized registries. ' +
          'Same-account / same-region pulls do not need this flag.'
      )
    )
    .addOption(
      new Option(
        '--from-state',
        "Load cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / Fn::ImportValue " +
          'in env vars with the deployed physical IDs / cross-stack exports. Mutually exclusive with --from-cfn-stack.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via DescribeStackResources and substitute Ref / Fn::ImportValue ' +
          'in env vars with the deployed physical IDs / exports. For CDK apps deployed via the upstream CDK CLI. ' +
          'Bare form uses the resolved stack name; pass an explicit value when the CFn stack name differs. ' +
          'Mutually exclusive with --from-state.'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      )
    )
    .action(
      withErrorHandling(
        async (target: string | undefined, options: LocalInvokeAgentCoreOptions) => {
          await localInvokeAgentCoreCommand(target, options);
        }
      )
    );

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
