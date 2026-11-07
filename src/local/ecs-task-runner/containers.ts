import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import graphlib from 'graphlib';
import { describeDockerFailure, getDockerCmd } from '../../utils/docker-cmd.js';
import { getLogger } from '../../utils/logger.js';
import {
  DockerRunnerError,
  followContainerLogs,
  type ContainerLogStream,
} from '../docker-runner.js';
import type { ResolvedEcsContainer } from '../ecs-task-resolver.js';
import { EcsTaskRunnerError } from './types.js';

const execFileAsync = promisify(execFile);

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
      `Cyclic DependsOn detected: ${cycles.map((c) => c.join(' then ')).join(', and ')}`
    );
  }
  return g;
}

export function topoSort(g: graphlib.Graph, containers: ResolvedEcsContainer[]): string[] {
  // Layered topological sort with template-order tiebreak. Each node's
  // depth = max(depth of nodes it depends on) + 1; nodes with no
  // dependencies are at depth 0. Sorting by (depth, templateIndex)
  // guarantees dependencies are listed before dependents (valid topo
  // order) AND that siblings at the same depth follow the user's
  // template order. The pre-fix double-sort (`topsort.reverse().sort()`)
  // re-ranked globally by template index and could violate topo order
  // when an adversarial template listed a dependent BEFORE its
  // dependency.
  //
  // Edges point dependent -> dependency; a node's depth is one more
  // than the max depth of any node it points to. Cycles are rejected up
  // front in `buildDependencyGraph`, so memoized recursion terminates.
  const depth = new Map<string, number>();
  const computeDepth = (name: string): number => {
    const cached = depth.get(name);
    if (cached !== undefined) return cached;
    let max = -1;
    const successors = g.successors(name) ?? [];
    for (const s of successors) {
      const d = computeDepth(s);
      if (d > max) max = d;
    }
    const result = max + 1;
    depth.set(name, result);
    return result;
  };
  for (const node of g.nodes()) computeDepth(node);

  const byPosition = new Map<string, number>();
  containers.forEach((c, idx) => byPosition.set(c.name, idx));

  return containers
    .map((c) => c.name)
    .filter((n) => depth.has(n))
    .sort((a, b) => {
      const da = depth.get(a)!;
      const db = depth.get(b)!;
      if (da !== db) return da - db;
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
export async function awaitDependencies(
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
  const inspectArgs = ['inspect', '--format', '{{.State.Health.Status}}', containerId];
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(getDockerCmd(), inspectArgs);
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
        `docker inspect on '${displayName}' failed: ${describeDockerFailure(err, inspectArgs)}`
      );
    }
    await sleep(1000);
  }
  throw new EcsTaskRunnerError(
    `Container '${displayName}' did not become healthy within 5 minutes.`
  );
}

export async function waitForContainerExit(containerId: string): Promise<number> {
  const waitArgs = ['wait', containerId];
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), waitArgs, {
      maxBuffer: 1024 * 1024,
    });
    const code = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(code) ? code : 1;
  } catch (err) {
    throw new DockerRunnerError(`docker wait failed: ${describeDockerFailure(err, waitArgs)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Stream `docker logs -f <id>` with `[<container-name>]` prefixes on
 * every line. A trailing partial line is written when the follower is
 * stopped or drained.
 */
export function streamContainerLogs(
  containerName: string,
  containerId: string
): ContainerLogStream {
  const prefix = `[${containerName}] `;
  let stdoutBuf = '';
  let stderrBuf = '';
  const flushPartialLines = (): void => {
    if (stdoutBuf) process.stdout.write(prefix + stdoutBuf + '\n');
    if (stderrBuf) process.stderr.write(prefix + stderrBuf + '\n');
    stdoutBuf = '';
    stderrBuf = '';
  };
  const follower = followContainerLogs(containerId, {
    stdout: (chunk) => {
      stdoutBuf = writePrefixed(prefix, stdoutBuf + chunk.toString('utf-8'), process.stdout);
    },
    stderr: (chunk) => {
      stderrBuf = writePrefixed(prefix, stderrBuf + chunk.toString('utf-8'), process.stderr);
    },
  });
  return {
    stop: (): void => {
      flushPartialLines();
      follower.stop();
    },
    drain: async (timeoutMs: number): Promise<boolean> => {
      const drained = await follower.drain(timeoutMs);
      flushPartialLines();
      return drained;
    },
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
