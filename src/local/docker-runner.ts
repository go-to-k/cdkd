import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import {
  dockerSpawnEnvWithSensitive,
  getDockerCmd,
  partitionSensitiveEnv,
  describeDockerCapturedOutput,
  describeDockerFailure,
  redactDockerArgvValues,
  runDockerForeground,
  runDockerStreaming,
} from '../utils/docker-cmd.js';
import { getLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Wraps `docker pull` / `docker run` / `docker rm` for `cdkd local invoke`.
 *
 * Mirrors the style of `src/assets/docker-asset-publisher.ts` (execFile for
 * one-shot calls, spawn for long-running ones). Kept as a separate file so
 * the command layer's wiring stays small; PR 5 (container Lambda) is
 * expected to add a second non-build call site, at which point the
 * common surface can be lifted into a shared helper.
 */

export class DockerRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerRunnerError';
    Object.setPrototypeOf(this, DockerRunnerError.prototype);
  }
}

export interface DockerRunOptions {
  /** Image to run (e.g. `public.ecr.aws/lambda/nodejs:20`). */
  image: string;
  /**
   * Bind mounts: `[hostPath, containerPath]` pairs. cdkd uses this to
   * expose the function's local code at `/var/task` (read-only). Empty
   * for container Lambdas (PR 5) — the image already has the code at
   * `/var/task`, no host bind-mount needed.
   */
  mounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /**
   * Additional bind mounts applied AFTER `mounts` (PR 6 of #224, issue
   * #232 — Lambda Layers). The split is purely organizational: it lets
   * the call site keep "the function's own code" (`mounts`) separate
   * from any extra mounts the caller wants to compose. The docker-runner
   * emits one `-v <hostPath>:<containerPath>:<ro?>` per entry, in
   * order, with NO target-path coalescing — Docker rejects duplicate
   * targets (`Error response from daemon: Duplicate mount point: ...`),
   * so the caller MUST ensure each entry's `containerPath` is unique
   * across `mounts` + `extraMounts`. For Lambda Layers specifically:
   * AWS's "last layer wins on file collision" semantic is realized by
   * the caller (`materializeLambdaLayers` in `local-invoke.ts` /
   * `local-start-api.ts`) `cpSync`-merging every layer's asset
   * directory into ONE host tmpdir in template order, then passing a
   * single `{hostPath: <tmpdir>, containerPath: '/opt'}` entry here —
   * NOT one mount per layer.
   */
  extraMounts?: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /** Environment variables to forward into the container. */
  env: Record<string, string>;
  /**
   * Container CMD. For ZIP Lambda base images this is the handler string,
   * e.g. `index.handler`. For container Lambdas (PR 5) this is the
   * `ImageConfig.Command` array — passed verbatim, may be empty when the
   * image's own CMD is sufficient.
   */
  cmd: string[];
  /** Host port to bind the container port to. */
  hostPort: number;
  /**
   * Container port to bind {@link hostPort} to. Defaults to 8080 (the RIE
   * port the Lambda local-invoke path uses); the AgentCore local-invoke path
   * passes 8000 (MCP Streamable-HTTP) or 9000 (A2A JSON-RPC) here so the
   * docker `-p` flag publishes the right port, not the RIE default.
   */
  containerPort?: number;
  /**
   * Extra env keys (beyond the always-sensitive AWS credential set) whose
   * VALUES must be routed through docker's value-from-process-env form
   * (`-e KEY` rather than `-e KEY=value`) so they never appear on the
   * `docker run` argv (`ps` / `/proc/<pid>/cmdline` / verbose debug logs).
   * The AgentCore local-invoke path passes the env keys that resolved to a
   * decrypted SSM `SecureString` value under `--from-cfn-stack` here so the
   * decrypted secret never lands on the argv. Always unioned with the
   * built-in AWS credential set ({@link SENSITIVE_ENV_KEYS}).
   */
  sensitiveEnvKeys?: ReadonlySet<string>;
  /** Host to bind to (default `127.0.0.1`). */
  host?: string;
  /**
   * Optional Node.js inspector port. When set the container also publishes
   * `<port>:<port>` and the caller is expected to have set
   * `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` in `env`.
   */
  debugPort?: number;
  /**
   * `--platform <linux/amd64|linux/arm64>`. PR 5: container Lambdas
   * declare `Architectures`, and the run-time platform must match the
   * built image. Without this an arm64 host running an x86_64 Lambda
   * hits emulation (slow) and an x86_64 host running arm64 fails with
   * `exec format error`. Omitted when undefined (the ZIP path on the
   * host's default arch is the original behavior).
   */
  platform?: string;
  /**
   * `--entrypoint <first>` for container Lambdas (PR 5,
   * `ImageConfig.EntryPoint`). When set, only the first entry is passed
   * to docker as `--entrypoint` (docker accepts a single binary there);
   * the remaining entries are pre-pended to `cmd` as positional args.
   * Most container Lambdas leave EntryPoint unset so `/lambda-entrypoint.sh`
   * stays in charge of dispatching to RIE.
   */
  entryPoint?: string[];
  /** `--workdir <dir>` for container Lambdas (PR 5, `ImageConfig.WorkingDirectory`). */
  workingDir?: string;
  /**
   * Optional `--name` for the container. `cdkd local start-api` sets a
   * stable `cdkd-local-<logicalId>-<pid>-<rand>` name so the verify.sh
   * trap can sweep orphans (`docker ps --filter name=cdkd-local-`)
   * regardless of how the server exited. `cdkd local invoke` leaves it
   * unset and lets docker auto-assign — short-lived containers don't
   * benefit from a stable name.
   */
  name?: string;
  /**
   * Optional `--network <name>` for the container. `cdkd local run-task`
   * uses this so every container in a task lands on the same per-task
   * docker network and can reach the metadata-endpoints sidecar at
   * `169.254.170.2`. Unset → docker's default bridge network (current
   * behavior for `cdkd local invoke` / `cdkd local start-api`).
   */
  network?: string;
  /**
   * Optional sized tmpfs mount (issue #440 — Lambda
   * `Properties.EphemeralStorage.Size`). When set, emits
   * `--tmpfs <target>:rw,size=<sizeMb>m` so the container's `<target>`
   * (typically `/tmp`) is a memory-backed filesystem capped at
   * `sizeMb` MiB. Handlers that exceed the cap fail with `ENOSPC`
   * the way they would on AWS, and handlers that detect free space
   * via `statvfs` / `df` see the configured cap rather than the
   * host's overlay-fs.
   *
   * Unset → no `--tmpfs` flag, the container's `/tmp` is whatever
   * the base image provides (preserves the pre-#440 behavior for
   * Lambdas without `EphemeralStorage`).
   */
  tmpfs?: { target: string; sizeMb: number };
  /**
   * Extra `--add-host <host>:<ip>` mappings written into the
   * container's `/etc/hosts`. Used by `cdkd local start-api`'s
   * WebSocket support (#462) to add
   * `host.docker.internal:host-gateway` so the Lambda container can
   * reach the host's `@connections` HTTP endpoint regardless of OS
   * (Docker Desktop on macOS / Windows already resolves
   * `host.docker.internal`; Linux native dockerd needs the explicit
   * `host-gateway` flag since 20.10+).
   */
  extraHosts?: { host: string; ip: string }[];
}

/**
 * Pull the image. No-op when `skipPull` is true.
 *
 * In verbose mode (`--verbose` / global log level `debug`), streams the
 * full `docker pull` progress live so the user sees per-layer downloads.
 * NOT necessarily to stdout: on a command holding a payload reservation --
 * which `cdkd local invoke` and `cdkd local invoke-agentcore` both do, and
 * both reach this function -- the child's fd 1 is redirected to stderr by
 * `spawnForeground` (`src/utils/docker-cmd.ts`, issue
 * [#2410](https://github.com/go-to-k/cdkd/issues/2410)), so the progress
 * lands there instead. Do not build on the fd-1 assumption; that is the one
 * this file's own leak was made of. In the default compact mode the call is
 * silent (cached
 * images are the common case; a fresh pull still shows progress only
 * via `--verbose`). Errors are always surfaced: the captured stderr is
 * folded into the thrown `DockerRunnerError` message.
 */
export async function pullImage(image: string, skipPull: boolean): Promise<void> {
  const logger = getLogger().child('docker');
  if (skipPull) {
    logger.debug(`Skipping docker pull for ${image} (--no-pull)`);
    return;
  }
  if (getLogger().getLevel() === 'debug') {
    logger.info(`Pulling ${image}...`);
    try {
      await runDockerForeground(['pull', image]);
    } catch (err) {
      throw new DockerRunnerError(
        `docker pull ${image} failed: ${describeDockerFailure(err, ['pull', image])}`
      );
    }
    return;
  }
  logger.debug(`Pulling ${image} (silent — pass --verbose to stream progress)`);
  // Captured-mode pull: stdout/stderr collected, mirrored only when
  // --verbose is on (which the branch above already handles via
  // runDockerForeground), so streamLive: false keeps the silent
  // contract on the default compact log level.
  try {
    await runDockerStreaming(['pull', image], { streamLive: false });
  } catch (err) {
    const e = err as { exitCode?: number | null };
    // Distinguish spawn-level failure (ENOENT — docker binary missing,
    // surfaces with the helpful Install-Docker / CDK_DOCKER hint from
    // `spawnStreaming`'s ENOENT branch) from non-zero exit (genuine
    // pull failure with captured stderr). The ENOENT path rejects with
    // a plain `Error` (no `exitCode` field); the non-zero-exit path
    // rejects with `SpawnError` (`exitCode` + `stderr` + `stdout`).
    if (e.exitCode === undefined || e.exitCode === null) {
      throw new DockerRunnerError(
        `docker pull ${image} failed: ${describeDockerFailure(err, ['pull', image])}`
      );
    }
    // Redacted like every other docker failure text, even though this argv
    // is `['pull', <image>]` and carries no user data: the rule is uniform so
    // no future edit has to re-derive whether THIS site needs it (issue #2440
    // review round 2 found this exact site unwrapped, hidden from the first
    // fence by the intermediate variable).
    const detail = describeDockerCapturedOutput(err, ['pull', image], '(no output)');
    throw new DockerRunnerError(`docker pull ${image} exited with code ${e.exitCode}: ${detail}`);
  }
}

/**
 * Run the container detached. Returns the container ID.
 *
 * The caller is responsible for:
 *   - polling `host:port` for RIE readiness,
 *   - issuing the invoke,
 *   - calling `removeContainer` from a `try`/`finally` so the container
 *     is cleaned up on any error path including SIGINT.
 */
export async function runDetached(opts: DockerRunOptions): Promise<string> {
  const args: string[] = ['run', '-d', '--rm'];

  if (opts.name) {
    args.push('--name', opts.name);
  }
  if (opts.network) {
    args.push('--network', opts.network);
  }
  if (opts.platform) {
    args.push('--platform', opts.platform);
  }
  if (opts.extraHosts) {
    for (const entry of opts.extraHosts) {
      args.push('--add-host', `${entry.host}:${entry.ip}`);
    }
  }

  const host = opts.host ?? '127.0.0.1';
  args.push('-p', `${host}:${opts.hostPort}:${opts.containerPort ?? 8080}`);
  if (opts.debugPort !== undefined) {
    args.push('-p', `${host}:${opts.debugPort}:${opts.debugPort}`);
  }

  for (const mount of opts.mounts) {
    const ro = mount.readOnly ? ':ro' : '';
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${ro}`);
  }
  // PR 6 (#232): layer mounts are emitted after the function's own
  // mounts. Order within `extraMounts` is preserved — the caller (the
  // CLI's `resolveZipImagePlan`) feeds layers in the same order they
  // appear in `Properties.Layers`, so AWS's "last layer wins on file
  // collision" semantics hold.
  if (opts.extraMounts) {
    for (const mount of opts.extraMounts) {
      const ro = mount.readOnly ? ':ro' : '';
      args.push('-v', `${mount.hostPath}:${mount.containerPath}${ro}`);
    }
  }

  // Sensitive env keys (decrypted SecureString SSM values from
  // `--from-cfn-stack` + the always-sensitive AWS credential set) are emitted
  // as value-less `-e KEY` so the value is read from the spawn-time process env
  // rather than the `docker run` argv. A key that NAMES a docker-client var is
  // dropped entirely (no flag) — emitting `-e DOCKER_HOST` for a key the spawn
  // env refuses to set would make docker resolve it against the CLIENT's own
  // env and hand the container the HOST's value (issue #2184). Shared with the
  // ECS path via `partitionSensitiveEnv`.
  const sensitiveKeys =
    opts.sensitiveEnvKeys && opts.sensitiveEnvKeys.size > 0
      ? new Set<string>([...SENSITIVE_ENV_KEYS, ...opts.sensitiveEnvKeys])
      : SENSITIVE_ENV_KEYS;
  const {
    flags,
    sensitiveEnv: passthroughEnv,
    collisions,
  } = partitionSensitiveEnv(opts.env, sensitiveKeys);
  args.push(...flags);

  // Issue #440 — Lambda EphemeralStorage.Size: emit `--tmpfs
  // <target>:rw,size=<N>m` so the container's `/tmp` is capped at the
  // templated value. Placed AFTER -e flags and BEFORE --workdir to
  // keep the order stable with the existing `-p` / `-v` / `-e`
  // mount-shaped block; downstream `--workdir` / `--entrypoint`
  // / image / cmd ordering is unchanged.
  if (opts.tmpfs) {
    args.push('--tmpfs', `${opts.tmpfs.target}:rw,size=${opts.tmpfs.sizeMb}m`);
  }

  if (opts.workingDir) {
    args.push('--workdir', opts.workingDir);
  }

  // ImageConfig.EntryPoint maps to `--entrypoint <first>` plus the rest
  // as positional args before CMD. Docker only accepts a single value
  // for `--entrypoint`; multi-arg entrypoints carry their tail through
  // the positional CMD slot. Most container Lambdas omit EntryPoint
  // entirely so `/lambda-entrypoint.sh` stays in charge of RIE dispatch.
  let entryPointTail: string[] = [];
  if (opts.entryPoint && opts.entryPoint.length > 0) {
    args.push('--entrypoint', opts.entryPoint[0]!);
    entryPointTail = opts.entryPoint.slice(1);
  }

  args.push(opts.image, ...entryPointTail, ...opts.cmd);

  const logger = getLogger().child('docker');
  // ONE verdict about this argv, on both channels. This line used to run a
  // narrower redactor (AWS credential keys only) than the error path below,
  // which is the shape issue #2440 reported one level down — and the review
  // showed the divergence pointed the WRONG way: `--verbose` renders the argv
  // on EVERY run, while the error path reaches it only when docker writes no
  // stderr. The rare channel was hardened and the certain one left open.
  // Masking the VALUE keeps what `--verbose` is actually read for (which
  // variables were passed, in what order, with which mounts and flags).
  logger.debug(`${getDockerCmd()} ${redactDockerArgvValues(args).join(' ')}`);

  if (collisions.length > 0) {
    logger.warn(
      `Env var(s) ${collisions.map((k) => JSON.stringify(k)).join(', ')} share a name with a docker-client environment variable or have a malformed name (empty, or containing '=' / NUL), and were NOT passed to the container at all (a colliding name would hijack the docker client; a malformed name cannot form a valid environment variable). Rename the env var if the container needs it.`
    );
  }

  try {
    const { stdout } = await execFileAsync(getDockerCmd(), args, {
      maxBuffer: 10 * 1024 * 1024,
      // The value-less `-e KEY` flags read their values from here.
      // `dockerSpawnEnvWithSensitive` keeps the docker client's own critical
      // vars (DOCKER_HOST / PATH / ...) authoritative — but this is DEFENCE IN
      // DEPTH, redundant by construction, since `partitionSensitiveEnv` already
      // excluded every colliding key from `passthroughEnv`. Do not read a green
      // suite as proof this call is load-bearing; the guard lives in the
      // partition (issue #2184).
      env: dockerSpawnEnvWithSensitive(passthroughEnv),
    });
    return stdout.trim();
  } catch (error) {
    // `execFile` embeds the WHOLE `docker run` command line in `err.message`
    // (and in `String(error)`), so an unredacted fallback echoes every
    // `-e KEY=value` pair back to the user — the same argv the debug line
    // above masks (issue #2440). Both channels now use the same redactor;
    // they used to disagree, which is what the issue reported.
    throw new DockerRunnerError(`docker run failed: ${describeDockerFailure(error, args)}`);
  }
}

/**
 * `docker logs -f <id>` plumbed to stdout/stderr. Returns a function that
 * stops the stream (used by the caller in a `finally` block).
 */
export function streamLogs(containerId: string): () => void {
  const proc = spawn(getDockerCmd(), ['logs', '-f', containerId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  proc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  // Swallow the exit code; this child is just plumbing.
  proc.on('error', () => {
    /* the parent flow surfaces docker errors via runDetached / removeContainer */
  });
  return () => {
    if (!proc.killed) proc.kill('SIGTERM');
  };
}

/**
 * Best-effort `docker rm -f <id>`. Errors are swallowed (logged at debug)
 * because this typically runs from a `finally` and the parent has its own
 * error to surface.
 */
export async function removeContainer(containerId: string): Promise<void> {
  if (!containerId) return;
  const logger = getLogger().child('docker');
  const args = ['rm', '-f', containerId];
  try {
    await execFileAsync(getDockerCmd(), args);
    logger.debug(`Removed container ${containerId}`);
  } catch (error) {
    logger.debug(`docker rm -f ${containerId} failed: ${describeDockerFailure(error, args)}`);
  }
}

/**
 * Verify the docker daemon is reachable. Surfaces a friendlier error than
 * the raw `ENOENT` / "Cannot connect to the Docker daemon" the user would
 * otherwise see at the first run call. Called once up front.
 */
export async function ensureDockerAvailable(): Promise<void> {
  const cmd = getDockerCmd();
  const args = ['version', '--format', '{{.Server.Version}}'];
  try {
    await execFileAsync(cmd, args);
  } catch (error) {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new DockerRunnerError(
        `${cmd} is not installed or not on PATH. cdkd local invoke needs Docker (or a compatible CLI specified via CDK_DOCKER) — install it and retry.`
      );
    }
    throw new DockerRunnerError(
      `${cmd} daemon is not reachable: ${describeDockerFailure(error, args)}. ` +
        'Start Docker Desktop / the docker daemon and retry.'
    );
  }
}

/**
 * Allocate a free TCP port on `127.0.0.1`. Used to pick a host port for
 * publishing the RIE :8080 endpoint without colliding with whatever else
 * the user has running. The OS assigns a port via `port: 0` and we
 * close the probe before returning so docker can bind it next.
 *
 * There is a tiny race window between close and `docker run -p` — in
 * practice it's never been observed for local invoke; if it ever
 * surfaces, the caller can retry with a fresh port.
 */
export function pickFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Could not allocate a host port'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Built-in sensitive env keys whose VALUES are always routed through
 * docker's value-from-process-env form (`-e KEY` rather than
 * `-e KEY=value`) by {@link runDetached}. Stronger than any log-time
 * masking: the value is kept off the docker `run` argv entirely (and
 * therefore off `ps` / `/proc/<pid>/cmdline` as well as every rendering of
 * the argv) instead of only being hidden at display time. A caller
 * may extend this set via the `sensitiveEnvKeys` option (used by the
 * AgentCore local-invoke path to keep decrypted `--from-cfn-stack`
 * SecureString SSM values off the argv).
 */
export const SENSITIVE_ENV_KEYS: ReadonlySet<string> = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);
