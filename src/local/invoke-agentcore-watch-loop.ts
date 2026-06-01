/**
 * cdkd-owned `cdkd local invoke-agentcore --watch` reload loop.
 *
 * cdk-local PR #270's `runAgentCoreWatchLoop` hard-couples to cdk-local's OWN
 * `Synthesizer` / `LocalInvokeAgentCoreOptions` types, so it cannot be shimmed.
 * Instead this module re-implements the loop on top of cdk-local's already-
 * exported watch primitives (`createFileWatcher` / `createWatchPredicates` /
 * `resolveWatchConfig` / `classifySourceChange` + the `ReloadVerdict` /
 * `ReloadAssetContext` types) — the SAME pattern `cdkd local start-api --watch`
 * uses — and drives cdkd's OWN re-synth / image-build / docker pipeline through
 * the `rebuild` / `softReload` callbacks the command supplies.
 *
 * Behavior parity with cdk-local #270:
 *   - re-synth + reload the agent container on CDK source edits (watch the
 *     source tree, honoring `cdk.json` `watch.include` / `watch.exclude`);
 *   - per-firing classifier: an interpreted-language source edit inside a
 *     CodeConfiguration source tree takes a soft-reload FAST PATH (`docker cp`
 *     + `docker restart`, no rebuild); Dockerfile / compiled-source /
 *     asset-hash-changed / ambiguous edits force a full rebuild;
 *   - reload-chain serialization (no two reloads in parallel);
 *   - for the `--ws` session path: close the active socket cleanly on each
 *     reload (via the abort signal) and reopen against the new container;
 *   - for the default one-shot `/invocations` path: re-run the single shot
 *     after each reload (cdkd-specific — cdk-local treats single-shot as a
 *     no-op WARN).
 */

import { basename, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { getLogger } from '../utils/logger.js';
import { getDockerCmd } from '../utils/docker-cmd.js';
import { CdkdError } from '../utils/error-handler.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../assets/asset-manifest-loader.js';
import {
  classifySourceChange,
  createFileWatcher,
  createWatchPredicates,
  pickAgentCoreCandidateStack,
  resolveWatchConfig,
  type FileWatcher,
  type ReloadAssetContext,
  type ReloadVerdict,
  type ResolvedAgentCoreRuntime,
} from 'cdk-local/internal';
import type { Synthesizer, SynthesisOptions } from '../synthesis/synthesizer.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import { invokeAgentCoreWs } from './agentcore-ws-client.js';
import { waitForAgentCorePing } from './agentcore-client.js';

const execFileAsync = promisify(execFileCb);

/**
 * Per-iteration invoke result, returned by the command's `invokeOnce`
 * callback. `pendingReload` is read by the loop to decide whether to
 * re-enter (a reload fired during the invoke) or exit (a benign close /
 * a one-shot finished with no reload pending).
 */
export interface AgentCoreWatchInvokeOutcome {
  /** `true` when a watcher firing requested a reload during this invoke. */
  pendingReload: boolean;
}

export interface RunAgentCoreWatchLoopArgs {
  containerHost: string;
  hostPort: number;
  options: { output: string };
  /** Original CDK target string (display path / logical id) so the resolver can re-pick the stack on reload. */
  resolvedTarget: string;
  resolved: ResolvedAgentCoreRuntime;
  synthesizer: Synthesizer;
  synthOpts: SynthesisOptions;
  stacks: StackInfo[];
  /**
   * Open one invocation session against `hostPort`. For the `--ws` path this
   * opens the bidirectional WebSocket (closed cleanly via `abortSignal` on a
   * reload); for the one-shot `/invocations` path it POSTs once. Returns the
   * outcome so the loop knows whether a reload fired during the session.
   *
   * `firstIteration` lets the callback vary its log line (initial open vs.
   * re-open against the rebuilt container).
   */
  invokeOnce: (args: {
    hostPort: number;
    abortSignal: AbortSignal;
    firstIteration: boolean;
  }) => Promise<AgentCoreWatchInvokeOutcome>;
  /**
   * Rebuild the agent container from scratch: tear down the OLD container,
   * re-resolve the image (re-running the same `cdk synth` + image-build
   * pipeline the cold start runs), then `docker run` a fresh one. Returns the
   * new `(containerId, hostPort, stacks)` so the loop can update its state.
   */
  rebuild: () => Promise<{ containerId: string; hostPort: number; stacks: StackInfo[] }>;
  /**
   * Soft-reload the agent container in place: `docker cp` the freshly-synthed
   * asset directory into the existing container's WORKDIR + `docker restart`.
   * No `docker build`, no swap — the container ID + host port are preserved.
   * Returns the freshly-synthed stacks for the next firing's asset-context
   * lookup.
   */
  softReload: (newAssetSourceDir: string) => Promise<{ stacks: StackInfo[] }>;
  /** Test hook for the watcher factory. */
  __watcherFactory?: (onChange: (changedPaths: readonly string[]) => void) => FileWatcher;
  /** Test hook for the ping wait between container boot + invoke open. */
  __waitForPing?: (host: string, port: number) => Promise<void>;
  /**
   * Test hook for the per-firing classifier context builder. The default runs
   * a fresh `synthesizer.synthesize(synthOpts)` + the
   * {@link loadAgentCoreAssetContext} + {@link deriveOldAssetHash} pipeline; the
   * override lets a unit test drive the rebuild vs soft-reload branches
   * directly without standing up a real AssetManifestLoader.
   */
  __classifierContext?: (
    changedPaths: readonly string[]
  ) => Promise<ReloadAssetContext | undefined>;
}

/**
 * Run the `--watch` reload loop. Returns when the invocation closes naturally
 * with no pending reload (one-shot finished, or `--ws` agent closed), or when
 * a reload callback throws (the previous container may already be torn down,
 * so blocking on the next ping would hang). SIGINT runs the outer command's
 * cleanup + `process.exit`, so this loop is not the termination path on
 * user-initiated shutdown.
 */
export async function runAgentCoreWatchLoop(args: RunAgentCoreWatchLoopArgs): Promise<void> {
  const logger = getLogger();
  const waitForPing = args.__waitForPing ?? waitForAgentCorePing;

  let currentHostPort = args.hostPort;
  let currentStacks = args.stacks;

  // Reload queue: serialize reload events so two rapid edits don't run two
  // rebuilds in parallel. The chain `then`s every new event onto the previous
  // one, just like start-api + the ECS service emulator.
  let reloadChain: Promise<unknown> = Promise.resolve();
  // Per-iteration AbortController the watcher's onChange fires to close the
  // in-flight invocation so the reload can swap the container. Recreated each
  // iteration so a fresh session gets a fresh signal.
  let currentAbort: AbortController | undefined;
  // Flips to true when a reload was triggered for the CURRENT session — used
  // to decide whether the post-invoke path enters another iteration (reload)
  // or exits the loop.
  let pendingReload = false;
  // Flips to true if a rebuild or soft-reload callback throws — both paths
  // teardown the old container before bringing the replacement up, so
  // `currentHostPort` may point at a torn-down container. The main loop checks
  // this BEFORE the next waitForPing so we bail out instead of blocking for
  // the ~30s ping timeout.
  let reloadFailed = false;

  const watcherFactory =
    args.__watcherFactory ??
    ((onChange) => {
      const watchRoot = process.cwd();
      const { ignored, shouldTrigger, excludePatterns } = createWatchPredicates({
        watchRoot,
        output: args.options.output,
        watchConfig: resolveWatchConfig(),
      });
      logger.info(
        `Watching ${watchRoot} for source changes (excluding ${excludePatterns.join(', ')}).`
      );
      return createFileWatcher({ paths: [watchRoot], ignored, shouldTrigger, onChange });
    });

  const cdkOutDir = args.options.output;
  const assetLoader = new AssetManifestLoader();

  const watcher = watcherFactory((changedPaths) => {
    const next = reloadChain.then(async () => {
      // Classify per firing. The classifier needs the OLD + NEW asset hashes +
      // the new asset source directory; we re-derive against the freshly-
      // synthed stacks before deciding rebuild vs soft-reload. A classifier-
      // context build failure (e.g. asset manifest missing) falls back to
      // rebuild — the conservative default.
      let verdict: ReloadVerdict = { kind: 'rebuild', reason: 'classifier not consulted' };
      try {
        let assetCtx: ReloadAssetContext | undefined;
        if (args.__classifierContext) {
          assetCtx = await args.__classifierContext(changedPaths);
        } else {
          const { stacks: freshStacks } = await args.synthesizer.synthesize(args.synthOpts);
          const oldAssetHash = await deriveOldAssetHash({
            resolvedTarget: args.resolvedTarget,
            resolved: args.resolved,
            stacks: currentStacks,
            cdkOutDir,
            assetLoader,
          });
          assetCtx = await loadAgentCoreAssetContext({
            resolvedTarget: args.resolvedTarget,
            resolved: args.resolved,
            stacks: freshStacks,
            cdkOutDir,
            assetLoader,
            ...(oldAssetHash !== undefined && { oldAssetHash }),
          });
        }
        verdict = classifySourceChange(changedPaths, assetCtx);
        logger.info(
          `Detected source change (${changedPaths.length} path(s)); verdict=${verdict.kind} (${verdict.reason}).`
        );
      } catch (err) {
        logger.warn(
          `Reload: classifier context unavailable ` +
            `(${err instanceof Error ? err.message : String(err)}); falling back to rebuild.`
        );
        verdict = {
          kind: 'rebuild',
          reason: 'classifier context unavailable; falling back to rebuild',
        };
      }
      // Mark the pending reload BEFORE aborting so the invoke promise (which
      // resolves on abort) knows to re-enter the loop instead of exiting.
      pendingReload = true;
      logger.warn(
        'cdkd local invoke-agentcore --watch: source change detected; closing the active ' +
          'invocation so the client can reconnect to the rebuilt container.'
      );
      currentAbort?.abort();
      try {
        if (verdict.kind === 'soft-reload') {
          const { stacks: newStacks } = await args.softReload(verdict.newAssetSourceDir);
          currentStacks = newStacks;
          logger.info(
            `Reload: soft-reloaded the agent container (docker cp + docker restart; ` +
              `container ID + host port preserved).`
          );
        } else {
          const { hostPort: newHostPort, stacks: newStacks } = await args.rebuild();
          currentHostPort = newHostPort;
          currentStacks = newStacks;
          logger.info(`Reload: rebuilt the agent container.`);
        }
      } catch (err) {
        logger.error(
          `Reload failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'The previous container may already be torn down; exiting --watch loop. ' +
            'Re-run cdkd local invoke-agentcore --watch to recover.'
        );
        reloadFailed = true;
        currentAbort?.abort();
      }
    });
    reloadChain = next.catch((err) => {
      logger.error(`Reload chain threw: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  try {
    let firstIteration = true;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (reloadFailed) break;
      await waitForPing(args.containerHost, currentHostPort);
      const abort = new AbortController();
      currentAbort = abort;
      pendingReload = false;
      try {
        const outcome = await args.invokeOnce({
          hostPort: currentHostPort,
          abortSignal: abort.signal,
          firstIteration,
        });
        firstIteration = false;
        // `invokeOnce` reports whether a reload fired during the session; the
        // loop's own `pendingReload` flag is also flipped by the watcher's
        // onChange before the abort, so combine both signals.
        if (outcome.pendingReload) pendingReload = true;
      } finally {
        currentAbort = undefined;
      }
      if (!pendingReload) {
        // Closed naturally — drain the reload chain (in case a late firing
        // landed) and exit. SIGINT remains the termination path the outer
        // command relies on for shutdown.
        await reloadChain.catch(() => undefined);
        if (!pendingReload) break;
      }
      // Wait for the reload to finish before re-opening. The reload updates
      // `currentHostPort` / `currentStacks` in place.
      await reloadChain.catch(() => undefined);
    }
  } finally {
    try {
      await watcher.close();
    } catch (err) {
      logger.warn(`Watcher close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Test hook re-export so the command can default to cdk-local's WS dispatch. */
export { invokeAgentCoreWs };

/**
 * Soft-reload the agent container in place: `docker cp` the freshly-synthed
 * asset directory contents into the running container's WORKDIR + `docker
 * restart`.
 *
 * - WORKDIR is resolved from the live container's image config via
 *   `docker inspect --format '{{.Config.WorkingDir}}'`. An empty WORKDIR
 *   (Docker runtime default) maps to `/`. For CodeConfiguration runtimes the
 *   generated Dockerfile sets `WORKDIR /app`, so the copy lands there.
 * - The trailing `/.` on the source ensures CONTENTS are copied (not the
 *   directory itself); the trailing `/` on the dest forces docker cp to treat
 *   it as a directory.
 * - `docker restart` cycles PID 1 — the new source is picked up by the
 *   interpreted-language runtime on its next startup. The container ID + host
 *   port + network are preserved across the restart.
 *
 * @internal — exported for unit tests of the docker-cp + docker-restart shape
 * without standing up a real container.
 */
export async function softReloadAgentContainer(
  containerId: string,
  newAssetSourceDir: string
): Promise<void> {
  const logger = getLogger();
  const dockerCmd = getDockerCmd();

  let workdir: string;
  try {
    const { stdout } = await execFileAsync(dockerCmd, [
      'inspect',
      '--format',
      '{{.Config.WorkingDir}}',
      containerId,
    ]);
    workdir = stdout.trim() || '/';
  } catch (err) {
    throw new CdkdError(
      `softReloadAgentContainer: docker inspect of container '${containerId}' failed: ` +
        `${describeExecError(err)}.`,
      'LOCAL_INVOKE_AGENTCORE_WATCH_SOFT_RELOAD_INSPECT_FAILED'
    );
  }
  const workdirDest = workdir.endsWith('/') ? workdir : `${workdir}/`;
  logger.info(
    `Soft-reload: docker cp ${newAssetSourceDir} -> ${containerId}:${workdirDest}; restart.`
  );
  try {
    await execFileAsync(
      dockerCmd,
      ['cp', `${newAssetSourceDir}/.`, `${containerId}:${workdirDest}`],
      { maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (err) {
    throw new CdkdError(
      `softReloadAgentContainer: docker cp into '${containerId}:${workdir}' failed: ` +
        `${describeExecError(err)}.`,
      'LOCAL_INVOKE_AGENTCORE_WATCH_SOFT_RELOAD_CP_FAILED'
    );
  }
  try {
    await execFileAsync(dockerCmd, ['restart', containerId]);
  } catch (err) {
    throw new CdkdError(
      `softReloadAgentContainer: docker restart of '${containerId}' failed: ` +
        `${describeExecError(err)}.`,
      'LOCAL_INVOKE_AGENTCORE_WATCH_SOFT_RELOAD_RESTART_FAILED'
    );
  }
}

// Stringify a child_process / execFile rejection. `err.stderr` is where docker
// writes its actionable diagnostics; without it the wrapped error only carries
// the generic "Command failed with exit code N" message.
function describeExecError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const stderr = (err as { stderr?: unknown }).stderr;
  const stderrText =
    typeof stderr === 'string'
      ? stderr.trim()
      : stderr instanceof Buffer
        ? stderr.toString('utf8').trim()
        : '';
  return stderrText ? `${err.message}\n${stderrText}` : err.message;
}

/**
 * Build the per-firing classifier context for the agent container. Mirrors the
 * ECS service emulator's `loadAssetContextForTarget` shape: returns `undefined`
 * (and the classifier defaults to `'rebuild'`) when the runtime's image is not
 * a CDK docker-image asset, or when the asset manifest lookup misses.
 *
 * For a CodeConfiguration (`fromCodeAsset`) runtime we treat the bundle's
 * `codeAssetHash` as the asset hash + the staged source directory as
 * `newAssetSourceDir`, and synthesize a `Dockerfile` basename that never
 * matches a real file (the generated Dockerfile lives in a build tmpdir, not
 * the source tree, so chokidar can't observe an edit to it). A `fromS3` bundle
 * has no local source tree, so it returns `undefined` and the classifier
 * defaults to rebuild.
 *
 * NOTE: `loadAgentCoreAssetContext` is NOT exported from `cdk-local/internal`
 * (verified against `node_modules/cdk-local/dist/internal.d.ts`), so this
 * helper is copied locally; `deriveOldAssetHash` is copied for the same reason.
 *
 * @internal — exported for the watch loop's classifier dispatch test.
 */
export async function loadAgentCoreAssetContext(args: {
  resolvedTarget: string;
  resolved: ResolvedAgentCoreRuntime;
  stacks: StackInfo[];
  cdkOutDir: string;
  assetLoader: AssetManifestLoader;
  oldAssetHash?: string;
}): Promise<ReloadAssetContext | undefined> {
  const { resolvedTarget, resolved, stacks, cdkOutDir, assetLoader, oldAssetHash } = args;
  const newCandidate = pickAgentCoreCandidateStack(resolvedTarget, stacks);
  if (!newCandidate) return undefined;
  if (resolved.codeArtifact) {
    if (resolved.codeArtifact.s3Source) return undefined;
    const manifest = await assetLoader.loadManifest(cdkOutDir, newCandidate.stackName);
    if (!manifest) return undefined;
    const fileAssets = assetLoader.getFileAssets(manifest);
    const asset = fileAssets.get(resolved.codeArtifact.codeAssetHash);
    if (!asset) return undefined;
    const sourceDir = assetLoader.getAssetSourcePath(cdkOutDir, asset);
    return {
      ...(oldAssetHash !== undefined && { oldAssetHash }),
      newAssetHash: resolved.codeArtifact.codeAssetHash,
      newAssetSourceDir: sourceDir,
      // The Dockerfile is generated inside `buildAgentCoreCodeImage`'s build
      // tmpdir, not the source tree, so chokidar can never report an edit to
      // it. Use a sentinel basename that can't collide with anything in the
      // user's source tree, so the classifier's `basename === dockerFile`
      // check is effectively dead — interpreted-language source edits route to
      // soft-reload, every other rebuild trigger still works.
      dockerFile: '.cdkd-agentcore-generated-Dockerfile',
    };
  }
  if (resolved.containerUri === undefined) return undefined;
  const manifest = await assetLoader.loadManifest(cdkOutDir, newCandidate.stackName);
  if (!manifest) return undefined;
  const dockerImageEntry = getDockerImageBySourceHash(manifest, resolved.containerUri);
  if (!dockerImageEntry) return undefined;
  const newDockerImage = dockerImageEntry.asset;
  if (!newDockerImage.source.directory) return undefined;
  const newAssetSourceDir = resolvePath(cdkOutDir, newDockerImage.source.directory);
  return {
    ...(oldAssetHash !== undefined && { oldAssetHash }),
    newAssetHash: dockerImageEntry.hash,
    newAssetSourceDir,
    dockerFile: basename(newDockerImage.source.dockerFile ?? 'Dockerfile'),
  };
}

/**
 * Derive the OLD (pre-reload) asset hash for the classifier's `oldAssetHash`
 * field. Code-artifact runtimes carry the hash on the boot-time
 * `resolved.codeArtifact.codeAssetHash`; container runtimes need a manifest
 * lookup against the previous-synth stacks to extract it. Returns `undefined`
 * when the OLD hash can't be derived — the classifier treats `undefined` as
 * "force rebuild", which is the conservative default.
 *
 * NOT exported from `cdk-local/internal`, so copied locally.
 */
async function deriveOldAssetHash(args: {
  resolvedTarget: string;
  resolved: ResolvedAgentCoreRuntime;
  stacks: StackInfo[];
  cdkOutDir: string;
  assetLoader: AssetManifestLoader;
}): Promise<string | undefined> {
  const { resolvedTarget, resolved, stacks, cdkOutDir, assetLoader } = args;
  if (resolved.codeArtifact) return resolved.codeArtifact.codeAssetHash;
  if (resolved.containerUri === undefined) return undefined;
  const candidate = pickAgentCoreCandidateStack(resolvedTarget, stacks);
  if (!candidate) return undefined;
  const manifest = await assetLoader.loadManifest(cdkOutDir, candidate.stackName);
  if (!manifest) return undefined;
  const entry = getDockerImageBySourceHash(manifest, resolved.containerUri);
  return entry?.hash;
}
