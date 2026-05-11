import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import graphlib from 'graphlib';
import { getLogger } from '../utils/logger.js';
import { DockerRunnerError, pullImage, removeContainer } from './docker-runner.js';
import { buildDockerImage } from '../assets/docker-build.js';
import { pullEcrImage } from './ecr-puller.js';
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { AssetManifestLoader } from '../assets/asset-manifest-loader.js';
import {
  buildMetadataEnv,
  createTaskNetwork,
  destroyTaskNetwork,
  type TaskNetwork,
} from './ecs-network.js';
import { resolveEcsSecrets, type ResolvedSecret } from './ecs-secrets-resolver.js';
import {
  checkVolumeHostPath,
  type ResolvedEcsContainer,
  type ResolvedEcsImage,
  type ResolvedEcsTask,
  type ResolvedEcsVolume,
} from './ecs-task-resolver.js';

const execFileAsync = promisify(execFile);

/**
 * Top-level orchestrator for `cdkd local run-task`. Coordinates image
 * preparation, secret resolution, docker-network bring-up, container
 * boot in `dependsOn` order, log streaming, exit propagation, and
 * teardown. Designed to be called from the CLI with an idempotent
 * `cleanup()` hook hoisted in the caller so SIGINT and the outer finally
 * share teardown semantics with `cdkd local invoke`.
 */

export class EcsTaskRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsTaskRunnerError';
    Object.setPrototypeOf(this, EcsTaskRunnerError.prototype);
  }
}

export interface RunEcsTaskOptions {
  /** `--cluster <name>`. Surfaced to metadata sidecar and the network prefix. */
  cluster: string;
  /** Override container env vars (SAM-style top-level keys are container names; `Parameters` is global). */
  envOverrides?: Record<string, Record<string, string | null> | undefined>;
  /** Host IP to bind published container ports to. Default `127.0.0.1`. */
  containerHost: string;
  /** Optional STS-issued temp credentials to expose via the metadata sidecar (`--assume-task-role`). */
  taskCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** ARN of the task role being assumed (forwarded to AWS_CONTAINER_CREDENTIALS_RELATIVE_URI). */
  taskRoleArn?: string;
  /** Force a `--platform` (default: inferred from task `RuntimePlatform.CpuArchitecture`). */
  platformOverride?: string;
  /** Skip `docker pull` on every image (sidecar + each container's image). */
  skipPull: boolean;
  /** Don't `docker rm -f` containers on task exit; useful for `docker exec` post-mortems. */
  keepRunning: boolean;
  /** Start the containers and return without streaming logs. */
  detach: boolean;
  /** AWS region for secret resolution + metadata sidecar. */
  region?: string;
  /**
   * Optional pre-resolved `ImagePlan` map — only used by tests. Production
   * callers leave undefined and let the runner walk every container's
   * Image / docker build / ECR pull path.
   */
  imagePlanByContainer?: Map<string, string>;
}

/**
 * Single struct that carries everything the orchestrator must tear down,
 * regardless of which step failed. Designed so the caller can hoist a
 * single `cleanup(state)` call in both the outer finally and the SIGINT
 * handler.
 */
export interface EcsRunState {
  network: TaskNetwork | undefined;
  /** Resolved docker volume names (`docker volume rm` on teardown). */
  dockerVolumeNames: string[];
  /** Container name → docker id, in start order. */
  startedContainers: { name: string; id: string }[];
  /** Active log streams (stop functions). Drained on teardown. */
  logStoppers: (() => void)[];
}

export interface RunEcsTaskResult {
  /** Exit code of the essential container (0 by default when `--keep-running` and no exit awaited). */
  exitCode: number;
  /** Name of the essential container whose exit drove the result. */
  essentialContainerName?: string;
  state: EcsRunState;
}

/**
 * Build a fresh, empty `EcsRunState`. Surfaces a single allocation point
 * so the CLI's `cleanup()` closure doesn't have to reach into runner
 * internals.
 */
export function createEcsRunState(): EcsRunState {
  return { network: undefined, dockerVolumeNames: [], startedContainers: [], logStoppers: [] };
}

/**
 * Cleanup the resources tracked in `state`. Idempotent and safe to call
 * from both the outer `finally` AND the SIGINT handler. Errors per-step
 * are logged at debug so cleanup never masks a real handler error.
 */
export async function cleanupEcsRun(
  state: EcsRunState,
  options: { keepRunning: boolean }
): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  for (const stop of state.logStoppers) {
    try {
      stop();
    } catch (err) {
      logger.debug(`log stream stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  state.logStoppers = [];

  if (!options.keepRunning) {
    for (const c of state.startedContainers) {
      try {
        await stopContainer(c.id, 10);
      } catch (err) {
        logger.debug(
          `docker stop ${c.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        await removeContainer(c.id);
      } catch (err) {
        logger.debug(
          `docker rm -f ${c.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    state.startedContainers = [];
  }

  // Sidecar + network teardown runs unconditionally (the docs spell out
  // that `--keep-running` only spares user containers — the network +
  // sidecar would otherwise leak across runs).
  await destroyTaskNetwork(state.network);
  state.network = undefined;

  for (const v of state.dockerVolumeNames) {
    try {
      await execFileAsync('docker', ['volume', 'rm', v]);
      logger.debug(`Removed docker volume ${v}`);
    } catch (err) {
      logger.debug(
        `docker volume rm ${v} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  state.dockerVolumeNames = [];
}

/**
 * Top-level entry point. Mutates `state` as it makes progress so the
 * caller's `cleanup(state)` can roll back partial side effects on any
 * thrown error.
 */
export async function runEcsTask(
  task: ResolvedEcsTask,
  options: RunEcsTaskOptions,
  state: EcsRunState
): Promise<RunEcsTaskResult> {
  const logger = getLogger();

  if (task.containers.length === 0) {
    throw new EcsTaskRunnerError(
      `Task '${task.taskDefinitionLogicalId}' has no containers — nothing to run.`
    );
  }

  for (const w of task.warnings) logger.warn(w);

  // Build the dependency DAG up front so cyclic configs fail before we
  // touch docker.
  const dag = buildDependencyGraph(task.containers);
  const startOrder = topoSort(dag, task.containers);

  // Resolve every container's image. Production callers leave
  // `imagePlanByContainer` undefined — the resolver below walks the asset
  // manifest / ECR / public-image path per image.
  const imagePlan = options.imagePlanByContainer ?? new Map<string, string>();
  if (!options.imagePlanByContainer) {
    await prepareImages(task, imagePlan, options);
  }

  // Resolve every container's secrets in parallel BEFORE network /
  // container boot — any failure short-circuits the whole task. Mirrors
  // the ECS Agent's "fail-fast on missing secret" UX.
  const allSecrets: { containerName: string; name: string; valueFrom: string }[] = [];
  for (const c of task.containers) {
    for (const s of c.secrets) {
      allSecrets.push({ containerName: c.name, name: s.name, valueFrom: s.valueFrom });
    }
  }
  const resolvedSecrets = await resolveEcsSecrets(allSecrets, {
    ...(options.region !== undefined && { region: options.region }),
  });
  const secretsByContainer = groupSecretsByContainer(resolvedSecrets);

  // Bring the network + sidecar up. From this point on the cleanup
  // path is non-trivial — any failure must `destroyTaskNetwork(state.network)`.
  const netCreateOpts: Parameters<typeof createTaskNetwork>[0] = {
    prefix: options.cluster,
    skipPull: options.skipPull,
  };
  if (options.taskCredentials) netCreateOpts.credentials = options.taskCredentials;
  if (options.cluster) netCreateOpts.cluster = options.cluster;
  state.network = await createTaskNetwork(netCreateOpts);

  // Realize docker volumes (per-task `Scope: 'task'` are torn down at
  // cleanup; `Scope: 'shared'` would survive but the docs explicitly
  // pin v1 to per-task semantics).
  const volumeByName = await realizeDockerVolumes(task.volumes, state);

  // Pre-compute every container's CMD args so the start loop only does
  // docker calls.
  const dockerCmds = new Map<string, string[]>();
  for (const container of task.containers) {
    const image = imagePlan.get(container.name);
    if (!image) {
      throw new EcsTaskRunnerError(
        `Internal: no resolved image for container '${container.name}'.`
      );
    }
    dockerCmds.set(
      container.name,
      buildDockerRunArgs({
        task,
        container,
        image,
        network: state.network.networkName,
        volumeByName,
        secrets: secretsByContainer.get(container.name) ?? [],
        envOverrides: options.envOverrides,
        containerHost: options.containerHost,
        roleArn: options.taskRoleArn,
        platformOverride: options.platformOverride,
        region: options.region,
      })
    );
  }

  // Boot containers in dependency order. Each container's `dependsOn`
  // gates its start: START condition needs `docker run` to have
  // returned; COMPLETE / SUCCESS / HEALTHY each wait for the dependency
  // container's lifecycle to reach the matching state. The DAG's
  // `startOrder` is the dependency-respecting topological order; any
  // remaining condition gating fires inside the per-container
  // `awaitDependencies` step.
  const startedByName = new Map<string, { id: string; container: ResolvedEcsContainer }>();
  for (const containerName of startOrder) {
    const container = task.containers.find((c) => c.name === containerName)!;
    await awaitDependencies(container, startedByName);

    const args = dockerCmds.get(container.name)!;
    logger.info(`Starting container '${container.name}' (image=${imagePlan.get(container.name)})`);
    let id: string;
    try {
      const { stdout } = await execFileAsync('docker', args, { maxBuffer: 10 * 1024 * 1024 });
      id = stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new DockerRunnerError(
        `docker run failed for container '${container.name}': ${e.stderr?.trim() || e.message || String(err)}`
      );
    }
    state.startedContainers.push({ name: container.name, id });
    startedByName.set(container.name, { id, container });

    if (!options.detach) {
      state.logStoppers.push(streamContainerLogs(container.name, id));
    }
  }

  if (options.detach) {
    return { exitCode: 0, state };
  }

  // Wait for the essential container to exit. AWS-side ECS treats the
  // first `essential: true` container as the task-driving one; cdkd
  // mirrors that. When no container declares `essential: false`, every
  // container is essential — we use `containers[0]` as the
  // task-driving one.
  const essential = task.containers.find((c) => c.essential) ?? task.containers[0]!;
  const essentialId = startedByName.get(essential.name)?.id;
  if (!essentialId) {
    throw new EcsTaskRunnerError(`Essential container '${essential.name}' did not start.`);
  }
  const exitCode = await waitForContainerExit(essentialId);
  return { exitCode, essentialContainerName: essential.name, state };
}

/**
 * Build the directed graph for `dependsOn` ordering. Each container is
 * a node; an edge `A -> B` means A must start AFTER B. graphlib's
 * topological sort returns B before A so the start loop walks the array
 * in correct order. Cyclic graphs are rejected up front with the
 * offending cycle named.
 */
export function buildDependencyGraph(containers: ResolvedEcsContainer[]): graphlib.Graph {
  const g = new graphlib.Graph({ directed: true });
  for (const c of containers) g.setNode(c.name);
  for (const c of containers) {
    for (const d of c.dependsOn) {
      g.setEdge(c.name, d.containerName);
    }
  }
  const cycles = graphlib.alg.findCycles(g);
  if (cycles.length > 0) {
    throw new EcsTaskRunnerError(
      `Cyclic DependsOn detected: ${cycles.map((c) => c.join(' -> ')).join('; ')}`
    );
  }
  return g;
}

export function topoSort(g: graphlib.Graph, containers: ResolvedEcsContainer[]): string[] {
  // graphlib.alg.topsort returns roots LAST given our edge direction; we
  // need dependencies (B) first, so we reverse. Fall back to template
  // order on a tie (preserves the user's intent for siblings with no
  // dependsOn relation).
  const sorted = graphlib.alg.topsort(g);
  const byPosition = new Map<string, number>();
  containers.forEach((c, idx) => byPosition.set(c.name, idx));
  return [...sorted].reverse().sort((a, b) => {
    // Sort within the topological order is deliberately stable; we use
    // template position as the secondary key. graphlib's algorithm
    // already produced a valid topological order; we only re-rank ties.
    return (byPosition.get(a) ?? 0) - (byPosition.get(b) ?? 0);
  });
}

/**
 * Await the dependency conditions for one container. Walks the
 * container's `dependsOn` list in order, blocking on each according to
 * its condition. START is a no-op when the dependency is already in
 * `startedByName` (graphlib has already ordered dependencies before
 * dependents).
 */
async function awaitDependencies(
  container: ResolvedEcsContainer,
  started: Map<string, { id: string; container: ResolvedEcsContainer }>
): Promise<void> {
  for (const dep of container.dependsOn) {
    const entry = started.get(dep.containerName);
    if (!entry) {
      throw new EcsTaskRunnerError(
        `Container '${container.name}' depends on '${dep.containerName}' but the latter never started.`
      );
    }
    switch (dep.condition) {
      case 'START':
        // already started — the topological order guarantees this.
        break;
      case 'COMPLETE':
        await waitForContainerExit(entry.id);
        break;
      case 'SUCCESS': {
        const code = await waitForContainerExit(entry.id);
        if (code !== 0) {
          throw new EcsTaskRunnerError(
            `Container '${container.name}' requires dependency '${dep.containerName}' to exit 0, but it exited ${code}.`
          );
        }
        break;
      }
      case 'HEALTHY':
        await waitForContainerHealthy(entry.id, dep.containerName);
        break;
    }
  }
}

/**
 * Poll `docker inspect --format '{{.State.Health.Status}}'` until the
 * container reports `healthy`, capped at 5 minutes (AWS-side ECS uses
 * the user-declared interval × retries × startPeriod budget but we keep
 * a fixed local cap so a hung healthcheck doesn't block teardown
 * indefinitely).
 */
async function waitForContainerHealthy(containerId: string, displayName: string): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{{.State.Health.Status}}',
        containerId,
      ]);
      const status = stdout.trim();
      if (status !== lastStatus) {
        logger.debug(`Container '${displayName}' health status: ${status}`);
        lastStatus = status;
      }
      if (status === 'healthy') return;
      if (status === 'unhealthy') {
        throw new EcsTaskRunnerError(
          `Container '${displayName}' health status is 'unhealthy'; aborting before dependents start.`
        );
      }
    } catch (err) {
      if (err instanceof EcsTaskRunnerError) throw err;
      // `docker inspect` may transiently fail right after start; log and retry.
      logger.debug(
        `docker inspect on '${displayName}' failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await sleep(1000);
  }
  throw new EcsTaskRunnerError(
    `Container '${displayName}' did not become healthy within 5 minutes.`
  );
}

async function waitForContainerExit(containerId: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('docker', ['wait', containerId], {
      maxBuffer: 1024 * 1024,
    });
    const code = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(code) ? code : 1;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new DockerRunnerError(
      `docker wait failed: ${e.stderr?.trim() || e.message || String(err)}`
    );
  }
}

async function stopContainer(containerId: string, graceSeconds: number): Promise<void> {
  try {
    await execFileAsync('docker', ['stop', '-t', String(graceSeconds), containerId]);
  } catch {
    // Ignore — the subsequent `docker rm -f` covers stuck containers.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Stream `docker logs -f <id>` with `[<container-name>]` prefixes on
 * every line. Returns a stop function for the caller's `finally`.
 */
function streamContainerLogs(containerName: string, containerId: string): () => void {
  const proc = spawn('docker', ['logs', '-f', containerId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${containerName}] `;
  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf = writePrefixed(prefix, stdoutBuf + chunk.toString('utf-8'), process.stdout);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf = writePrefixed(prefix, stderrBuf + chunk.toString('utf-8'), process.stderr);
  });
  proc.on('error', () => {
    /* surfaced through the parent's docker-wait result */
  });
  return () => {
    if (stdoutBuf) process.stdout.write(prefix + stdoutBuf + '\n');
    if (stderrBuf) process.stderr.write(prefix + stderrBuf + '\n');
    if (!proc.killed) proc.kill('SIGTERM');
  };
}

function writePrefixed(prefix: string, buffer: string, out: NodeJS.WritableStream): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    out.write(prefix + line + '\n');
  }
  return remainder;
}

/**
 * Resolve every container's `Image` to a tag the runner can pass to
 * `docker run`. The map is keyed by container name; entries are
 * populated in parallel up to the asset-manifest bound (single
 * `docker build` for shared assets is left to docker's own cache).
 */
async function prepareImages(
  task: ResolvedEcsTask,
  out: Map<string, string>,
  options: RunEcsTaskOptions
): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  // Sequential is fine — most tasks have 1–3 containers and each
  // `docker build` / pull would saturate IO anyway.
  for (const container of task.containers) {
    const image = await prepareOneImage(task, container, options);
    out.set(container.name, image);
    logger.debug(`Container '${container.name}' image=${image}`);
  }
}

async function prepareOneImage(
  task: ResolvedEcsTask,
  container: ResolvedEcsContainer,
  options: RunEcsTaskOptions
): Promise<string> {
  const image: ResolvedEcsImage = container.image;
  switch (image.kind) {
    case 'public': {
      await pullImage(image.uri, options.skipPull);
      return image.uri;
    }
    case 'ecr': {
      return pullEcrImage(image.uri, {
        skipPull: options.skipPull,
        ...(options.region !== undefined && { region: options.region }),
      });
    }
    case 'cdk-asset': {
      const cdkOutDir = task.stack.assetManifestPath
        ? dirname(task.stack.assetManifestPath)
        : undefined;
      if (!cdkOutDir) {
        throw new EcsTaskRunnerError(
          `Container '${container.name}' uses a CDK asset image but the stack has no asset manifest. ` +
            'Re-synthesize the app (without `--output <stale-dir>`) and retry.'
        );
      }
      const loader = new AssetManifestLoader();
      const manifest = await loader.loadManifest(cdkOutDir, task.stack.stackName);
      if (!manifest) {
        throw new EcsTaskRunnerError(
          `No asset manifest at ${cdkOutDir} for stack ${task.stack.stackName}.`
        );
      }
      const dockerImages = manifest.dockerImages ?? {};
      const entries = Object.entries(dockerImages);
      let asset: { source: import('../types/assets.js').DockerImageAssetSource } | undefined;
      if (image.assetHash && dockerImages[image.assetHash]) {
        asset = dockerImages[image.assetHash];
      } else if (entries.length === 1) {
        asset = entries[0]![1];
      }
      if (!asset) {
        throw new EcsTaskRunnerError(
          `Container '${container.name}' references a CDK asset image but no matching entry was found in cdk.out. ` +
            'Re-synthesize the CDK app and retry.'
        );
      }
      const tag = `cdkd-local-run-task-${(image.assetHash ?? 'single').slice(0, 16)}`;
      await buildDockerImage(asset, cdkOutDir, tag, {
        ...(options.platformOverride !== undefined && { platform: options.platformOverride }),
        wrapError: (stderr) =>
          new LocalInvokeBuildError(
            `docker build failed for ECS container '${container.name}' (${asset.source.directory}): ${stderr}`
          ),
      });
      return tag;
    }
  }
}

/**
 * `docker volume create` for every `DockerVolumeConfiguration` entry.
 * Anonymous + host-path volumes need no create call — they're realized
 * at `docker run` time via `-v <hostPath>:<containerPath>`.
 */
async function realizeDockerVolumes(
  volumes: ResolvedEcsVolume[],
  state: EcsRunState
): Promise<Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>> {
  const logger = getLogger().child('ecs-runner');
  const out = new Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>();
  for (const v of volumes) {
    if (v.kind === 'host') {
      if (v.hostPath && !checkVolumeHostPath(v.hostPath)) {
        logger.warn(
          `Volume '${v.name}': host path '${v.hostPath}' does not exist or is not a directory. ` +
            'Docker will create an anonymous bind mount; create the host path before run-task if you expected to bind-mount it.'
        );
      }
      out.set(v.name, v);
      continue;
    }
    const cfg = v.dockerVolumeConfig;
    const args: string[] = ['volume', 'create'];
    if (cfg?.driver) args.push('--driver', cfg.driver);
    if (cfg?.driverOpts) {
      for (const [k, val] of Object.entries(cfg.driverOpts)) args.push('--opt', `${k}=${val}`);
    }
    if (cfg?.labels) {
      for (const [k, val] of Object.entries(cfg.labels)) args.push('--label', `${k}=${val}`);
    }
    const dockerVolumeName = `cdkd-local-${v.name}-${randHex(4)}`;
    args.push(dockerVolumeName);
    try {
      await execFileAsync('docker', args);
      state.dockerVolumeNames.push(dockerVolumeName);
      logger.debug(`Created docker volume ${dockerVolumeName} for task volume '${v.name}'`);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new DockerRunnerError(
        `docker volume create failed for '${v.name}': ${e.stderr?.trim() || e.message || String(err)}`
      );
    }
    out.set(v.name, { ...v, dockerVolumeName });
  }
  return out;
}

function randHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function groupSecretsByContainer(
  resolved: ResolvedSecret[]
): Map<string, { name: string; value: string }[]> {
  const out = new Map<string, { name: string; value: string }[]>();
  for (const r of resolved) {
    const arr = out.get(r.containerName) ?? [];
    arr.push({ name: r.name, value: r.value });
    out.set(r.containerName, arr);
  }
  return out;
}

interface BuildDockerRunArgs {
  task: ResolvedEcsTask;
  container: ResolvedEcsContainer;
  image: string;
  network: string;
  volumeByName: Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>;
  secrets: { name: string; value: string }[];
  envOverrides: Record<string, Record<string, string | null> | undefined> | undefined;
  containerHost: string;
  roleArn: string | undefined;
  platformOverride: string | undefined;
  region: string | undefined;
}

/**
 * Build the full `docker run -d` argument list for one container.
 * Exported (no-leading-underscore) so the unit tests can assert against
 * the shape directly without spawning a process.
 */
export function buildDockerRunArgs(opts: BuildDockerRunArgs): string[] {
  const { task, container, image, network, volumeByName, secrets, containerHost, roleArn } = opts;
  const args: string[] = ['run', '-d'];

  // Stable name so siblings can reach this container via DNS.
  args.push('--name', `cdkd-local-${task.family}-${container.name}-${randHex(3)}`);
  args.push('--network', network);
  args.push('--network-alias', container.name);

  if (opts.platformOverride) {
    args.push('--platform', opts.platformOverride);
  } else if (task.runtimePlatform) {
    args.push(
      '--platform',
      task.runtimePlatform.cpuArchitecture === 'ARM64' ? 'linux/arm64' : 'linux/amd64'
    );
  }

  for (const pm of container.portMappings) {
    const hostPort = pm.hostPort ?? pm.containerPort;
    args.push('-p', `${containerHost}:${hostPort}:${pm.containerPort}/${pm.protocol}`);
  }

  // Mounts: walk the container's `MountPoints` and look up the matching
  // volume to decide bind-mount vs docker volume.
  for (const mp of container.mountPoints) {
    const v = volumeByName.get(mp.sourceVolume);
    if (!v) continue;
    if (v.kind === 'host') {
      if (v.hostPath) {
        const ro = mp.readOnly ? ':ro' : '';
        args.push('-v', `${v.hostPath}:${mp.containerPath}${ro}`);
      } else {
        // Anonymous: only the container path, docker manages the volume.
        args.push('-v', mp.containerPath);
      }
    } else {
      const name = v.dockerVolumeName ?? v.name;
      const ro = mp.readOnly ? ':ro' : '';
      args.push('-v', `${name}:${mp.containerPath}${ro}`);
    }
  }

  // Env precedence (highest wins):
  //   1. function-specific `--env-vars` entry
  //   2. global `Parameters` `--env-vars` entry
  //   3. resolved secrets
  //   4. template literal env
  //   5. metadata sidecar env (sidecar URL / role URL)
  const finalEnv: Record<string, string> = {};
  const metaEnv = buildMetadataEnv({
    containerName: container.name,
    ...(roleArn !== undefined && { roleArn }),
    ...(opts.region !== undefined && { region: opts.region }),
  });
  Object.assign(finalEnv, metaEnv);
  Object.assign(finalEnv, container.environment);
  for (const s of secrets) finalEnv[s.name] = s.value;

  const overrides = opts.envOverrides;
  if (overrides) {
    applyOverrideMap(finalEnv, overrides['Parameters']);
    applyOverrideMap(finalEnv, overrides[container.name]);
  }

  for (const [k, v] of Object.entries(finalEnv)) {
    args.push('-e', `${k}=${v}`);
  }

  if (container.user) args.push('--user', container.user);
  if (container.privileged) args.push('--privileged');
  if (container.readonlyRootFilesystem) args.push('--read-only');
  if (container.workingDirectory) args.push('--workdir', container.workingDirectory);
  for (const u of container.ulimits) {
    args.push('--ulimit', `${u.name}=${u.softLimit}:${u.hardLimit}`);
  }
  for (const link of container.links) args.push('--link', link);

  if (container.healthCheck) {
    args.push('--health-cmd', shellJoin(container.healthCheck.command));
    if (container.healthCheck.interval !== undefined) {
      args.push('--health-interval', `${container.healthCheck.interval}s`);
    }
    if (container.healthCheck.timeout !== undefined) {
      args.push('--health-timeout', `${container.healthCheck.timeout}s`);
    }
    if (container.healthCheck.retries !== undefined) {
      args.push('--health-retries', String(container.healthCheck.retries));
    }
    if (container.healthCheck.startPeriod !== undefined) {
      args.push('--health-start-period', `${container.healthCheck.startPeriod}s`);
    }
  }

  // EntryPoint maps the same way as docker — first item to --entrypoint,
  // the rest become positional args before CMD.
  let entryPointTail: string[] = [];
  if (container.entryPoint && container.entryPoint.length > 0) {
    args.push('--entrypoint', container.entryPoint[0]!);
    entryPointTail = container.entryPoint.slice(1);
  }

  args.push(image, ...entryPointTail, ...(container.command ?? []));
  return args;
}

function applyOverrideMap(
  acc: Record<string, string>,
  map: Record<string, string | null> | undefined
): void {
  if (!map) return;
  for (const [k, v] of Object.entries(map)) {
    if (v === null) delete acc[k];
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      acc[k] = String(v);
    }
  }
}

/**
 * Quote each arg for `docker --health-cmd`. Docker's healthcheck takes
 * a single string which is passed to `/bin/sh -c`, so multi-word commands
 * need to be space-joined. We escape single quotes / `$` characters to
 * avoid shell injection from CFn-supplied values.
 */
function shellJoin(parts: string[]): string {
  return parts
    .map((p) => {
      if (/^[A-Za-z0-9_\-./=:]+$/.test(p)) return p;
      return `'${p.replace(/'/g, "'\\''")}'`;
    })
    .join(' ');
}
