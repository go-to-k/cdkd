import { getLogger } from '../../../utils/logger.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import type { LocalStateProvider, LocalStateRecord } from 'cdk-local';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { getEmbedConfig } from 'cdk-local';
import {
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  pickAgentCoreCandidateStack,
  resolveAgentCoreTarget,
  type ResolvedAgentCoreRuntime,
} from '../../../local/agentcore-resolver.js';
import { MCP_CONTAINER_PORT, MCP_PATH } from '../../../local/agentcore-mcp-client.js';
import { A2A_CONTAINER_PORT, A2A_PATH } from '../../../local/agentcore-a2a-client.js';
import { WATCH_INTERRUPTED_CODE } from '../../../local/invoke-agentcore-watch-loop.js';
import { type ImageResolutionContext } from '../../../local/intrinsic-image.js';
import {
  followContainerLogs,
  pickFreePort,
  removeContainer,
  runDetached,
  type ContainerLogStream,
} from '../../../local/docker-runner.js';
import { type ProfileCredentialsFile } from '../local-profile-credentials-file.js';
import { buildContainerEnv } from './env.js';
import {
  resolveAgentCoreImage,
  resolveFromS3BucketIntrinsic,
  buildAgentCoreImageContext,
} from './image.js';
import type { LocalInvokeAgentCoreOptions } from './types.js';

/**
 * `--watch` is supported only on the long-running HTTP / AGUI paths (the
 * `--ws` session AND the default one-shot `POST /invocations`, which the
 * reload re-runs). The MCP `POST /mcp` and A2A `POST /` paths run once and
 * exit with no reconnect surface, so `--watch` is a no-op WARN for them.
 *
 * Exported so a unit test can lock the eligibility contract without driving
 * the full synth + docker pipeline.
 */
export function isAgentCoreWatchEligible(protocol: string): boolean {
  return protocol !== AGENTCORE_MCP_PROTOCOL && protocol !== AGENTCORE_A2A_PROTOCOL;
}

/**
 * How a `--watch` rebuild's container start stays visible to the command's
 * cleanup (issue #4488): `closing` reports that cleanup has begun, and
 * `starting` hands it the in-flight start, which settles only after a
 * container started under a closing command has been removed.
 */
export interface ContainerStartGuard {
  closing: () => boolean;
  /** `containerName` is the start's `--name`, so cleanup can remove it by name. */
  starting: (start: Promise<string>, containerName: string) => void;
}

/**
 * How long `cleanup()` waits for an in-flight `--watch` rebuild's
 * `docker run`, and then for the `docker rm -f` by name that replaces it.
 * Mutable only so a unit test can drive the bound without waiting it out.
 *
 * @internal
 */
export const containerStartWait = { ms: 15_000 };

/** Resolves `true` once `p` settles, or `false` after `ms`. Never rejects. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rebuild stopped because the command is closing; the watch loop exits
 * quietly on it. `what` says what the rebuild did about its container.
 */
export function watchInterruptedError(what: string): CdkdError {
  return new CdkdError(`Interrupted during the --watch rebuild; ${what}.`, WATCH_INTERRUPTED_CODE);
}

/**
 * Cold-boot (and rebuild) the agent container from an already-resolved runtime
 * descriptor: resolve an intrinsic fromS3 bucket, resolve the image, build the
 * container env, pick a free port, `docker run`, and start the log stream.
 *
 * Extracted from the main command so the `--watch` rebuild callback can re-run
 * the identical sequence against a fresh synth. The non-watch one-shot / `--ws`
 * paths and the watch loop both go through this helper, so the container boot
 * sequence is single-sourced.
 *
 * Exported so a unit test can drive the boot shape without the full command.
 */
export async function bootAgentCoreContainer(args: {
  resolved: ResolvedAgentCoreRuntime;
  options: LocalInvokeAgentCoreOptions;
  /** Assembly root from `Synthesizer.synthesize`; see {@link resolveAgentCoreImage}. */
  assemblyDir: string;
  profileCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined;
  profileCredsFile: ProfileCredentialsFile | undefined;
  stateProvider: LocalStateProvider | undefined;
  loadedState: LocalStateRecord | undefined;
  imageContext: ImageResolutionContext | undefined;
  isMcp: boolean;
  isA2a: boolean;
  /** A `--watch` rebuild's; see {@link ContainerStartGuard}. */
  startGuard?: ContainerStartGuard;
}): Promise<{ containerId: string; hostPort: number; logStream: ContainerLogStream }> {
  const logger = getLogger();
  const {
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
    startGuard,
  } = args;

  // If the fromS3 bundle's Code.S3.Bucket is an intrinsic, resolve it against
  // --from-cfn-stack state BEFORE the image step (which needs a literal bucket
  // for the S3 download).
  await resolveFromS3BucketIntrinsic(resolved, stateProvider, loadedState, imageContext);

  const image = await resolveAgentCoreImage(resolved, options, assemblyDir, loadedState);

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
  // Stable `cdkd-local-`-prefixed name so the orphan sweep (`docker ps --filter
  // name=cdkd-local-`) used by `/cleanup` + `/run-integ` can find this container
  // if the process is killed before teardown — unlike a one-shot Lambda invoke,
  // the agent container runs a long-lived HTTP server.
  const containerName = `${getEmbedConfig().resourceNamePrefix}-agentcore-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const containerPort = isMcp ? MCP_CONTAINER_PORT : isA2a ? A2A_CONTAINER_PORT : undefined;
  const containerPortLabel = isMcp
    ? `${MCP_CONTAINER_PORT}${MCP_PATH}`
    : isA2a
      ? `${A2A_CONTAINER_PORT}${A2A_PATH}`
      : '8080';
  // A `--watch` rebuild's synth and image step can outlast a ^C; once the
  // command is closing, start nothing (issue #4488).
  if (startGuard?.closing()) throw watchInterruptedError('not starting a new container');
  logger.info(
    `Starting agent container (image=${image}, port=${hostPort} -> ${containerPortLabel})...`
  );
  const start = (async (): Promise<string> => {
    const id = await runDetached({
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
    // The command began closing while `docker run` was in flight: its cleanup
    // could not see this id, so the start removes the container itself.
    if (startGuard?.closing()) {
      await removeContainer(id).catch(() => {});
      throw watchInterruptedError('removed the container it had just started');
    }
    return id;
  })();
  startGuard?.starting(start, containerName);
  // Nothing from here to the caller recording `containerId` may yield to a
  // macrotask: a ^C landing there would find neither a pending start nor a
  // recorded id, and the container would be left behind again (issue #4488).
  const containerId = await start;

  // If anything after `runDetached` throws, the container is already up but
  // the caller has not yet captured its id (on a `--watch` rebuild the loop's
  // `containerId` was nulled by `cleanupBefore`), so `cleanup()` could not
  // remove it -> orphan. Tear the just-started container down before
  // re-throwing so a boot-tail failure never leaks a container.
  let logStream: ContainerLogStream;
  try {
    logStream = followContainerLogs(containerId);
  } catch (err) {
    await removeContainer(containerId).catch(() => {});
    throw err;
  }
  return { containerId, hostPort, logStream };
}

/**
 * Rebuild the agent container for the `--watch` loop: tear down the OLD
 * container (via the supplied `cleanupBefore`), re-synth the CDK app, re-pick
 * the candidate stack + re-resolve the runtime (so a new asset hash / env /
 * image is picked up), then re-run {@link bootAgentCoreContainer}. The inbound
 * auth (bearer token / OIDC discovery URL) is NOT re-resolved — it is stable
 * across a CDK source edit, so the caller threads its boot-time `authorization`
 * back into the next invocation.
 *
 * Exported so a unit test can drive the rebuild shape without the full command.
 */
export async function rebuildAgentCoreContainer(args: {
  cleanupBefore: () => Promise<void>;
  /** See {@link ContainerStartGuard}. */
  startGuard: ContainerStartGuard;
  resolvedTarget: string;
  options: LocalInvokeAgentCoreOptions;
  synthesizer: Synthesizer;
  synthOpts: SynthesisOptions;
  profileCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined;
  profileCredsFile: ProfileCredentialsFile | undefined;
  stateProvider: LocalStateProvider | undefined;
  isMcp: boolean;
  isA2a: boolean;
}): Promise<{
  containerId: string;
  hostPort: number;
  logStream: ContainerLogStream;
  stacks: StackInfo[];
}> {
  const {
    cleanupBefore,
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
  } = args;

  await cleanupBefore();

  const {
    stacks: newStacks,
    assemblyDir: newAssemblyDir,
    failedLookups: newFailed,
  } = await synthesizer.synthesize(synthOpts);
  const newCandidate = pickAgentCoreCandidateStack(resolvedTarget, newStacks);
  refuseFailedLookups(newCandidate ? [newCandidate] : [], newStacks, newFailed);
  const { context: newImageContext, loaded: newLoaded } =
    stateProvider && newCandidate
      ? await buildAgentCoreImageContext(newCandidate, stateProvider, options)
      : { context: undefined, loaded: undefined };
  const newResolved = resolveAgentCoreTarget(resolvedTarget, newStacks, newImageContext);

  const boot = await bootAgentCoreContainer({
    resolved: newResolved,
    options,
    // The rebuild re-synthesizes, so the bound comes from THAT run's assembly
    // root rather than the cold boot's (issue go-to-k/cdkd#3489).
    assemblyDir: newAssemblyDir,
    profileCredentials,
    profileCredsFile,
    stateProvider,
    loadedState: newLoaded,
    imageContext: newImageContext,
    isMcp,
    isA2a,
    startGuard,
  });
  return { ...boot, stacks: newStacks };
}
