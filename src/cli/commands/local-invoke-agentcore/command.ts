import { randomUUID } from 'node:crypto';
import { parseContextOptions, warnIfDeprecatedRegion } from '../../options.js';
import { getLogger, reserveStdoutForPayload } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { foldRegionOption } from '../../region-options.js';
import {
  activateLocalAwsAndRoleArn,
  profileCredentialsForWorkload,
} from '../../../local/local-aws-wiring.js';
import { assertFlagRoleArn, explicitRoleArnOrThrow } from '../../../utils/role-arn.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { listTargets } from 'cdk-local';
import { resolveSingleTarget } from '../../../local/target-picker.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { resolveApp } from '../../config-loader.js';
import { createLocalStateProvider, resolveCfnFallbackRegion } from '../local-state-source.js';
import type { LocalStateProvider } from 'cdk-local';
import { getEmbedConfig } from 'cdk-local';
import {
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_AGUI_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  pickAgentCoreCandidateStack,
  resolveAgentCoreTarget,
} from '../../../local/agentcore-resolver.js';
import { invokeAgentCore, waitForAgentCorePing } from '../../../local/agentcore-client.js';
import { mcpInvokeOnce, MCP_PATH } from '../../../local/agentcore-mcp-client.js';
import { a2aInvokeOnce, A2A_PATH } from '../../../local/agentcore-a2a-client.js';
import { invokeAgentCoreWs } from '../../../local/agentcore-ws-client.js';
import {
  runAgentCoreWatchLoop,
  softReloadAgentContainer,
} from '../../../local/invoke-agentcore-watch-loop.js';
import {
  ensureDockerAvailable,
  flushStdio,
  killAndDrainContainerLogs,
  removeContainer,
  type ContainerLogStream,
} from '../../../local/docker-runner.js';
import { singleFlight } from '../../../utils/single-flight.js';
import { resolveProfileCredentials } from '../local-start-api.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from '../local-profile-credentials-file.js';
import {
  isAgentCoreWatchEligible,
  type ContainerStartGuard,
  containerStartWait,
  settlesWithin,
  watchInterruptedError,
  bootAgentCoreContainer,
  rebuildAgentCoreContainer,
} from './container.js';
import { readEvent, readStdinLines, wrapWsOnMessage } from './event-input.js';
import { buildAgentCoreImageContext } from './image.js';
import {
  emitResult,
  emitWsResult,
  buildMcpRequest,
  emitMcpResult,
  buildA2aRequest,
  emitA2aResult,
} from './output.js';
import { resolveInboundAuthorization, buildSigV4HeadersIfRequested } from './sigv4.js';
import type { LocalInvokeAgentCoreOptions } from './types.js';

/**
 * `cdkd local invoke-agentcore <target>` — run a Bedrock AgentCore Runtime container
 * locally and invoke it once over the AgentCore HTTP contract. Resolves
 * the `AWS::BedrockAgentCore::Runtime`, pulls / builds its container,
 * starts it on port 8080, waits for `GET /ping`, POSTs the event to
 * `POST /invocations`, prints the response, and tears down. Covers the
 * container artifact and the CodeConfiguration managed-runtime artifact
 * (fromCodeAsset, built from source) on the HTTP + MCP protocols; the agent's
 * calls to real AWS go to real AWS (credentials injected like `cdkd local invoke`).
 */
export async function localInvokeAgentCoreCommand(
  target: string | undefined,
  options: LocalInvokeAgentCoreOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  // Issue #2410: on `cdkd local invoke-agentcore`, stdout MEANS "the agent's
  // response" — the terminal emitters (`emitResult` / `emitMcpResult` /
  // `emitA2aResult` / `emitWsResult`) plus the streamed SSE / WebSocket chunk
  // sinks, which write the body incrementally as it arrives. Reserved
  // UNCONDITIONALLY and at command entry, for the same reason as
  // `local-invoke.ts`: there is no `--json` flag to key off, and the status
  // prose (`Target: ...`, image resolution, container startup, plus the synth
  // chatter `app-executor.ts` re-emits at INFO) otherwise interleaves with a
  // streamed body on the same stream — worse here than on a buffered payload,
  // because a prose line can land BETWEEN two frames of one document.
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

  // Fold `--region` to its canonical lower-case spelling once, at the handler
  // entry, exactly as `local-start-api.ts` / `local-invoke.ts` / `local-run-task.ts`
  // do (issue [#1795](https://github.com/go-to-k/cdkd/issues/1795)). This command
  // was the one region-taking `cdkd local` command that fix skipped, so its raw
  // value still reached the consumers that are case-SENSITIVE in the same
  // direction the partition table is: the SigV4 signing scope (where `--region`
  // has the highest precedence), the `STSClient` endpoint resolution, and
  // `applyRoleArnIfSet`. Folding here rather than at each consumer keeps ONE
  // normalization point per command; the pseudo-parameter resolver folds again
  // from its own sources and double-folding is a no-op.
  //
  // This statement covers `options.region` ONLY, which is NOT the whole story
  // in this command and was a review finding on the first cut: unlike its three
  // siblings, agentcore derives a region through FOUR further chains that fall
  // through past `options.region` — two of them to `options.stackRegion` (a real
  // flag; cdk-local declares `--stack-region`), all of them to the two env vars,
  // and then to the resolved stack's or candidate's own region. `stsRegion` in
  // `applyAgentCoreCredentialEnv` reads its own `args.region` parameter and so
  // escapes this fold entirely. Each of the four therefore folds its WHOLE
  // result too; without that, `--sigv4 --stack-region CN-NORTH-1` still reached
  // the signing scope, and `--assume-role` with an upper-cased `AWS_REGION`
  // still reached the AssumeRole STS client and the container's own env.
  //
  // Issue #3622: `foldRegionOption` folds the `AWS_REGION` /
  // `AWS_DEFAULT_REGION` env vars as well. Folding only the flag left the SDK
  // clients this command builds with NO region (the `--from-state` S3 client
  // when `--region` is absent, `applyRoleArnIfSet`'s STS client, the
  // `--profile` credential resolver) reading the raw env spelling through the
  // SDK's own region chain, and the synth subprocess inheriting it.
  foldRegionOption(options);
  // Issue #1836 folds `options.stackRegion` here too, which narrows the note
  // above: the two chains that fall through to it now receive a value that is
  // ALREADY canonical (their own folds stay, and are what cover the env-var and
  // stack-region-of-record fall-throughs). The flag needs its own fold because
  // it is not only a chain link — its raw value is COMPARED against a state
  // record's region (`local-state-loader.ts`) and forwarded to cdk-local as the
  // CFn client's region, both case-SENSITIVE. The RAW spelling is captured first
  // so the state-record match can honor an exactly-spelled region (see the
  // identical statement in `local-invoke.ts`).
  if (options.stackRegion !== undefined) {
    options.rawStackRegion = options.stackRegion;
    options.stackRegion = canonicalizeRegion(options.stackRegion);
  }

  let containerId: string | undefined;
  let logStream: ContainerLogStream | undefined;
  let sigintHandler: (() => void) | undefined;
  let profileCredsFile: ProfileCredentialsFile | undefined;
  let stateProvider: LocalStateProvider | undefined;

  // Kill the container, then wait (bounded) for `docker logs -f` to relay its
  // last lines before anything removes it (issue #4480). Taking the stream out
  // of its cell makes a second call a no-op; the in-flight promise makes a ^C
  // during the drain await it rather than remove the container under it. Not
  // a `singleFlight`: a `--watch` rebuild drains one container and then
  // follows the next.
  let drainInFlight: Promise<void> | undefined;
  /**
   * Set once `cleanup()` begins (a ^C, or the command's own exit): from then
   * on a `--watch` rebuild starts no container, and removes one whose
   * `docker run` was already in flight (see {@link teardownForRebuild} and
   * {@link startGuard}).
   */
  let closing = false;
  /**
   * A `--watch` rebuild's container start while it is in flight, settled only
   * once a container started under a closing command has been removed (issue
   * #4488). `cleanup()` awaits it: its `process.exit` would otherwise run while
   * that `docker run` was still starting a container nothing then removes.
   */
  let startInFlight: Promise<void> | undefined;
  let startPending = false;
  /** The in-flight start's `--name`, for removing it by name if it never settles. */
  let startName: string | undefined;
  const startGuard: ContainerStartGuard = {
    closing: () => closing,
    starting: (start, containerName) => {
      startPending = true;
      startName = containerName;
      // Never rejects: a rejection would end `cleanup()` here, before it
      // disposes the credentials file and flushes stdio.
      startInFlight = start.then(
        () => undefined,
        () => undefined
      );
      void startInFlight.then(() => {
        startPending = false;
      });
    },
  };
  const drainLogs = (): Promise<void> => {
    if (!drainInFlight) {
      const stream = logStream;
      logStream = undefined;
      drainInFlight = killAndDrainContainerLogs(containerId, stream)
        .catch((err: unknown) => {
          getLogger().debug(safeMsg`container log drain failed: ${describeAwsFailure(err).detail}`);
        })
        .finally(() => {
          drainInFlight = undefined;
        });
    }
    return drainInFlight;
  };

  /**
   * A `--watch` rebuild's teardown of the OLD container: drain, then remove.
   * A ^C during the drain runs `cleanup()`, which exits once it is done; a
   * rebuild that went on to boot the next container in that window would
   * leave it running with nothing to remove it, so it stops here instead.
   */
  const teardownForRebuild = async (): Promise<void> => {
    await drainLogs();
    if (containerId) {
      await removeContainer(containerId);
      containerId = undefined;
    }
    if (closing) throw watchInterruptedError('not starting a new container');
  };

  const cleanup = singleFlight(
    async (): Promise<void> => {
      closing = true;
      if (stateProvider) {
        try {
          stateProvider.dispose();
        } catch (err) {
          getLogger().debug(`state provider dispose failed: ${describeAwsFailure(err).detail}`);
        }
      }
      // A rebuild's `docker run` in flight: its container is not `containerId`
      // yet, and the start removes it itself once it sees `closing`.
      if (startPending) {
        getLogger().info('Waiting for the in-flight docker run so its container can be removed...');
      }
      // Bounded: `docker run` has no timeout of its own, and a hung daemon
      // must not turn ^C into a process that cannot exit. Past the bound the
      // container is removed by its deterministic `--name` instead.
      if (startInFlight && !(await settlesWithin(startInFlight, containerStartWait.ms))) {
        const secs = containerStartWait.ms / 1000;
        if (startName) {
          // The `docker rm -f` can run before the hung daemon has created the
          // container, and the `docker run` child outlives this process, so
          // the warning cannot promise the container is gone.
          await settlesWithin(removeContainer(startName), containerStartWait.ms);
          getLogger().warn(
            safeMsg`The in-flight docker run did not finish within ${secs}s; removed '${startName}' if it existed, but a docker run that completes later can still start it -- run 'docker rm -f ${startName}' if it appears.`
          );
        } else {
          getLogger().warn(safeMsg`The in-flight docker run did not finish within ${secs}s.`);
        }
      }
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
    // Refuse a malformed explicit `--assume-role <arn>` BEFORE any AWS call,
    // docker probe or synthesis (issue #2348); `resolveAssumeRoleArn` repeats
    // the same check where the value is used.
    if (typeof options.assumeRole === 'string') {
      explicitRoleArnOrThrow(
        '--assume-role',
        options.assumeRole,
        (message) => new CdkdError(message, 'LOCAL_INVOKE_AGENTCORE_ASSUME_ROLE_INVALID')
      );
    }
    if (options.ecrRoleArn !== undefined) {
      assertFlagRoleArn(
        '--ecr-role-arn',
        options.ecrRoleArn,
        (message) => new CdkdError(message, 'LOCAL_INVOKE_AGENTCORE_ECR_ROLE_ARN_INVALID')
      );
    }
    // BEFORE `--role-arn` and every AWS client: under `--aws-emulator` the
    // role hop, `--from-state`, `{{resolve:...}}` and `--from-cfn-stack` all
    // follow the emulator (`local-aws-wiring.ts`).
    await activateLocalAwsAndRoleArn(options);
    await ensureDockerAvailable();

    // Under `--aws-emulator` the container gets the emulator's keys only, so
    // the real `--profile` is neither resolved nor written to a file.
    const profileCredentials = await profileCredentialsForWorkload(
      options.profile,
      resolveProfileCredentials
    );
    // cdkd-local-env-identity: `--profile`, resolved by
    // `resolveProfileCredentials` through
    // `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own chain,
    // never the `--role-arn` role. The same identity the env-var overlay writes;
    // the mounted file is the additive channel for `fromIni({ profile })`.
    if (options.profile && profileCredentials) {
      profileCredsFile = await writeProfileCredentialsFile(options.profile, profileCredentials);
    }

    const appCmd = resolveApp(options.app);
    if (!appCmd) {
      throw new CdkdError(
        `No CDK app specified. Pass --app, set ${getEmbedConfig().envPrefix}_APP, or add "app" to cdk.json.`,
        'LOCAL_INVOKE_AGENTCORE_NO_APP'
      );
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
      // Every synthesis below (the first and each watch reload) refuses a
      // failed context lookup only for the invoked stack (go-to-k/cdkd#5807).
      failedLookupsCheckedByCaller: true,
    };
    const { stacks, assemblyDir, failedLookups } = await synthesizer.synthesize(synthOpts);

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

    // Build a state-source (`--from-state` / `--from-cfn-stack`)
    // image-resolution context BEFORE resolving the target, so a same-stack
    // AWS::ECR::Repository Fn::Join ContainerUri (or an Fn::Sub asset URI)
    // reduces to the deployed image URI. The state load is shared with the
    // env-substitution + role-from-state steps below.
    const candidate = pickAgentCoreCandidateStack(resolvedTarget, stacks);
    // A failed context lookup blocks only the stack this runs (go-to-k/cdkd#5807).
    // Checked on the candidate, before any state read so an expired credential
    // reports the lookup; the target resolver below picks the same stack.
    refuseFailedLookups(candidate ? [candidate] : [], stacks, failedLookups);
    stateProvider = createLocalStateProvider(
      options,
      candidate?.stackName ?? '',
      await resolveCfnFallbackRegion(options, candidate?.region),
      // Mixed mode: names follow THIS runtime's own "real-aws" exceptions (go-to-k/cdkd#6150).
      { workload: agentCoreTargetWorkload(resolvedTarget, stacks) }
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

    // Issue follows cdk-local #270 — `--watch` is only meaningful on the
    // long-running HTTP / AGUI paths (the `--ws` session AND the default
    // one-shot `POST /invocations`, which the reload re-runs). The MCP
    // `POST /mcp` and A2A `POST /` paths run once and exit with no reconnect
    // surface, so a watch loop has nothing to drive: log a one-line WARN and
    // let the single shot proceed.
    const watchEligible = isAgentCoreWatchEligible(resolved.protocol);
    const watchActive = options.watch === true && watchEligible;
    if (options.watch === true && !watchEligible) {
      logger.warn(
        `--watch is supported only on the HTTP / AGUI protocols; ` +
          `ignoring it for this ${resolved.protocol} runtime (its single shot runs once and exits).`
      );
    }

    const containerHost = options.containerHost;

    // Cold boot: resolve the image + env (re-resolving an intrinsic fromS3
    // bucket first), pick a free port, `docker run`, and start the log stream.
    // Extracted into `bootAgentCoreContainer` so the `--watch` rebuild callback
    // can re-run the same sequence against a fresh synth.
    const boot = await bootAgentCoreContainer({
      resolved,
      options,
      assemblyDir,
      profileCredentials,
      profileCredsFile,
      stateProvider,
      loadedState,
      imageContext,
      isMcp,
      isA2a,
    });
    containerId = boot.containerId;
    const hostPort = boot.hostPort;
    logStream = boot.logStream;

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
      // Every container log line reaches stderr before the result reaches
      // stdout; the one request is done, so the drain may kill the container.
      await drainLogs();
      emitMcpResult(mcp);
    } else if (isA2a && a2aRequest) {
      // A2A has no /ping either: a2aInvokeOnce folds the boot-wait into a
      // retried POST. One JSON-RPC round-trip — vanilla A2A.
      logger.info(`A2A request: ${a2aRequest.method}`);
      const a2a = await a2aInvokeOnce(containerHost, hostPort, a2aRequest, {
        requestTimeoutMs: options.timeout,
      });
      await drainLogs();
      emitA2aResult(a2a);
    } else if (options.ws) {
      // Bidirectional `/ws` (same 8080 container as /invocations): send the
      // event as the first frame, stream every received frame to stdout, then
      // resolve when the agent closes the stream. When stdin is a TTY (real
      // terminal — `process.stdin.isTTY === true`) we additionally wire
      // `process.stdin` (line-buffered) as a frame source, so each typed line
      // becomes a follow-up text frame until EOF / agent close — a REPL on top
      // of the same connection. Piped / redirected stdin (non-TTY) stays the
      // one-shot, wire-faithful shape (force it in a TTY with `--ws </dev/null`).
      const interactive = process.stdin.isTTY === true;
      // Issue #2410: `interactive` answers TWO different questions and only
      // one of them is about stdin. Reading follow-up frames from stdin is a
      // stdin concern, so it keeps the check above. Appending `\n` plus the
      // `> ` prompt is a STDOUT concern -- and stdout is this command's
      // PAYLOAD stream, so the prompt must not be written when it is
      // redirected. Gated on stdin alone, `cdkd local invoke-agentcore Agent
      // --ws > frames.txt` from a terminal appended `> ` after every frame,
      // and the `| tail -1` this command's own docs prescribe returned `> `
      // instead of the last frame -- the documented workaround, broken by the
      // thing it works around. cdk-local's `isInteractive()` requires both
      // for the same reason.
      const promptOnStdout = interactive && process.stdout.isTTY === true;
      if (watchActive) {
        // `--watch` wraps the /ws dispatch in a reload-driven loop. The socket
        // is closed cleanly on every reload firing (via the abort signal) and
        // re-opened against the rebuilt / soft-reloaded container; host-side
        // teardown is otherwise identical to the non-watch path. The loop only
        // returns when the agent closes with no pending reload (SIGINT runs the
        // outer cleanup + process.exit).
        await runAgentCoreWatchLoop({
          containerHost,
          hostPort,
          options,
          resolvedTarget,
          resolved,
          synthesizer,
          synthOpts,
          stacks,
          invokeOnce: async ({ hostPort: port, abortSignal, firstIteration }) => {
            const frameSource = interactive ? readStdinLines() : undefined;
            logger.info(
              firstIteration
                ? interactive
                  ? 'Opening the agent /ws WebSocket (interactive — stdin lines = follow-up frames; Ctrl-D to end)...'
                  : 'Opening the agent /ws WebSocket and streaming frames...'
                : interactive
                  ? 'Re-opening the agent /ws WebSocket (interactive) against the rebuilt container...'
                  : 'Re-opening the agent /ws WebSocket against the rebuilt container...'
            );
            const wsResult = await invokeAgentCoreWs(containerHost, port, event, {
              sessionId,
              timeoutMs: options.timeout,
              onMessage: wrapWsOnMessage((text) => process.stdout.write(text), promptOnStdout),
              abortSignal,
              ...(authorization && { authorization }),
              ...(frameSource && { frameSource }),
            });
            // The container serves the NEXT iteration, so it cannot be killed
            // to drain its logs here: a settle orders this iteration's lines
            // before its result, and the teardown drain relays the rest.
            await new Promise((r) => setTimeout(r, 250));
            emitWsResult(wsResult);
            return { pendingReload: abortSignal.aborted };
          },
          rebuild: async () => {
            const result = await rebuildAgentCoreContainer({
              cleanupBefore: teardownForRebuild,
              startGuard,
              resolvedTarget,
              options,
              synthesizer,
              synthOpts,
              profileCredentials,
              profileCredsFile,
              stateProvider,
              isMcp,
              isA2a,
            });
            containerId = result.containerId;
            logStream = result.logStream;
            return {
              containerId: result.containerId,
              hostPort: result.hostPort,
              stacks: result.stacks,
            };
          },
          softReload: async (newSourceDir) => {
            if (!containerId) {
              throw new CdkdError(
                'softReload: no live container to docker cp / docker restart into.',
                'LOCAL_INVOKE_AGENTCORE_WATCH_NO_CONTAINER'
              );
            }
            await softReloadAgentContainer(containerId, newSourceDir);
            // Re-synth so the caller has the freshly-resolved stacks for the
            // next classifier firing's asset-context lookup; env / image
            // changes are intentionally discarded (soft-reload only swaps source).
            const { stacks: newStacks, failedLookups: newFailed } =
              await synthesizer.synthesize(synthOpts);
            refuseFailedLookups(
              newStacks.filter((st) => st.stackName === resolved.stack.stackName),
              newStacks,
              newFailed
            );
            return { stacks: newStacks };
          },
        });
      } else {
        await waitForAgentCorePing(containerHost, hostPort);
        const frameSource = interactive ? readStdinLines() : undefined;
        logger.info(
          interactive
            ? 'Opening the agent /ws WebSocket (interactive — stdin lines = follow-up frames; Ctrl-D to end)...'
            : 'Opening the agent /ws WebSocket and streaming frames...'
        );
        const wsResult = await invokeAgentCoreWs(containerHost, hostPort, event, {
          sessionId,
          timeoutMs: options.timeout,
          onMessage: wrapWsOnMessage((text) => process.stdout.write(text), promptOnStdout),
          ...(authorization && { authorization }),
          ...(frameSource && { frameSource }),
        });
        await drainLogs();
        emitWsResult(wsResult);
      }
    } else if (watchActive) {
      // One-shot `POST /invocations` under `--watch`: the reload re-runs the
      // single shot against the rebuilt / soft-reloaded container. cdk-local
      // #270 treats single-shot HTTP as a no-op WARN; cdkd extends the loop to
      // re-invoke so an iterate-and-re-run workflow works without `--ws`.
      await runAgentCoreWatchLoop({
        containerHost,
        hostPort,
        options,
        resolvedTarget,
        resolved,
        synthesizer,
        synthOpts,
        stacks,
        invokeOnce: async ({ hostPort: port, abortSignal }) => {
          const additionalHeaders = await buildSigV4HeadersIfRequested(
            options,
            resolved,
            loadedState,
            containerHost,
            port,
            event,
            sessionId
          );
          const result = await invokeAgentCore(containerHost, port, event, {
            sessionId,
            timeoutMs: options.timeout,
            onChunk: (text) => process.stdout.write(text),
            ...(authorization && { authorization }),
            ...(additionalHeaders && { additionalHeaders }),
          });
          // The container serves the next iteration; see the `/ws` loop above.
          await new Promise((r) => setTimeout(r, 250));
          emitResult(result);
          // A one-shot POST is not abortable mid-flight, so a reload firing
          // during the request is observed AFTER it returns: `abortSignal.aborted`
          // reports whether the watcher fired, so the loop re-runs the shot.
          return { pendingReload: abortSignal.aborted };
        },
        rebuild: async () => {
          const result = await rebuildAgentCoreContainer({
            cleanupBefore: teardownForRebuild,
            startGuard,
            resolvedTarget,
            options,
            synthesizer,
            synthOpts,
            profileCredentials,
            profileCredsFile,
            stateProvider,
            isMcp,
            isA2a,
          });
          containerId = result.containerId;
          logStream = result.logStream;
          return {
            containerId: result.containerId,
            hostPort: result.hostPort,
            stacks: result.stacks,
          };
        },
        softReload: async (newSourceDir) => {
          if (!containerId) {
            throw new CdkdError(
              'softReload: no live container to docker cp / docker restart into.',
              'LOCAL_INVOKE_AGENTCORE_WATCH_NO_CONTAINER'
            );
          }
          await softReloadAgentContainer(containerId, newSourceDir);
          const { stacks: newStacks, failedLookups: newFailed } =
            await synthesizer.synthesize(synthOpts);
          refuseFailedLookups(
            newStacks.filter((st) => st.stackName === resolved.stack.stackName),
            newStacks,
            newFailed
          );
          return { stacks: newStacks };
        },
      });
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

      await drainLogs();
      emitResult(result);
    }
  } finally {
    // The handler stays installed while the teardown runs: a ^C during the
    // drain then awaits this same single-flight cleanup instead of taking
    // Node's default exit, which would skip `docker rm -f` and the
    // credentials dispose.
    await cleanup();
    if (sigintHandler) process.off('SIGINT', sigintHandler);
  }
}

/**
 * The AWS Emulator mixed-mode workload of the runtime `target` names (its
 * logical ID and `aws:cdk:path`), found BEFORE full resolution so the state
 * provider built ahead of it resolves names by this runtime's own "real-aws" exceptions
 * (go-to-k/cdkd#6150). `undefined` when the target names no single runtime:
 * the names then follow the run's routing, and the resolver reports the
 * target itself.
 */
export function agentCoreTargetWorkload(
  target: string,
  stacks: readonly Parameters<typeof listTargets>[0][number][]
): { logicalId: string; cdkPath: string | undefined } | undefined {
  const hits = listTargets([...stacks]).agentCoreRuntimes.filter(
    (e) => e.qualifiedId === target || e.displayPath === target || e.logicalId === target
  );
  if (hits.length !== 1) return undefined;
  const hit = hits[0]!;
  const resource = stacks.find((s) => s.stackName === hit.stackName)?.template.Resources?.[
    hit.logicalId
  ];
  const path = (resource?.Metadata as Record<string, unknown> | undefined)?.['aws:cdk:path'];
  return { logicalId: hit.logicalId, cdkPath: typeof path === 'string' ? path : undefined };
}
