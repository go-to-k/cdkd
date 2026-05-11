import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
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
  /** Host port to bind the RIE port (8080) to. */
  hostPort: number;
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
}

/**
 * Pull the image. No-op when `skipPull` is true.
 *
 * In verbose mode (`--verbose` / global log level `debug`), streams the
 * full `docker pull` progress to stdout so the user sees per-layer
 * downloads. In the default compact mode the call is silent (cached
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
    await runForeground('docker', ['pull', image]);
    return;
  }
  logger.debug(`Pulling ${image} (silent — pass --verbose to stream progress)`);
  await runCaptured('docker', ['pull', image], image);
}

/**
 * Run a child process with stdout / stderr captured (not inherited).
 * On success: discard the captured output (silent). On failure: fold
 * the captured stderr (or stdout as a fallback) into the rejection so
 * the error message names what actually went wrong instead of a bare
 * "exit code N".
 */
function runCaptured(cmd: string, args: string[], image: string): Promise<void> {
  return new Promise<void>((resolveProc, rejectProc) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err) =>
      rejectProc(new DockerRunnerError(`${cmd} pull ${image} failed: ${err.message}`))
    );
    proc.on('close', (code) => {
      if (code === 0) {
        resolveProc();
        return;
      }
      const detail = stderr.trim() || stdout.trim() || '(no output)';
      rejectProc(new DockerRunnerError(`docker pull ${image} exited with code ${code}: ${detail}`));
    });
  });
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
  if (opts.platform) {
    args.push('--platform', opts.platform);
  }

  const host = opts.host ?? '127.0.0.1';
  args.push('-p', `${host}:${opts.hostPort}:8080`);
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

  for (const [k, v] of Object.entries(opts.env)) {
    args.push('-e', `${k}=${v}`);
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
  logger.debug(`docker ${redactAwsCredentialsInArgs(args).join(' ')}`);

  try {
    const { stdout } = await execFileAsync('docker', args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new DockerRunnerError(
      `docker run failed: ${err.stderr?.trim() || err.message || String(error)}`
    );
  }
}

/**
 * `docker logs -f <id>` plumbed to stdout/stderr. Returns a function that
 * stops the stream (used by the caller in a `finally` block).
 */
export function streamLogs(containerId: string): () => void {
  const proc = spawn('docker', ['logs', '-f', containerId], {
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
  try {
    await execFileAsync('docker', ['rm', '-f', containerId]);
    logger.debug(`Removed container ${containerId}`);
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    logger.debug(
      `docker rm -f ${containerId} failed: ${err.stderr || err.message || String(error)}`
    );
  }
}

/**
 * Verify the docker daemon is reachable. Surfaces a friendlier error than
 * the raw `ENOENT` / "Cannot connect to the Docker daemon" the user would
 * otherwise see at the first run call. Called once up front.
 */
export async function ensureDockerAvailable(): Promise<void> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new DockerRunnerError(
        'docker is not installed or not on PATH. cdkd local invoke needs Docker — install Docker Desktop or the docker CLI and retry.'
      );
    }
    throw new DockerRunnerError(
      `docker daemon is not reachable: ${err.stderr?.trim() || err.message || String(error)}. ` +
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
 * AWS credential keys whose values must NOT be written to the debug log.
 * `forwardAwsEnv` / `assumeLambdaExecutionRole` (in `local-invoke.ts`)
 * push these via `-e <KEY>=<value>` flags into `runDetached`'s args
 * array, and `cdkd local invoke --verbose` would otherwise leak them
 * into stdout / log files. Only the matching `-e <KEY>=<value>` pair is
 * redacted; non-credential `-e KEY=val` entries pass through unchanged.
 */
const REDACTED_ENV_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/**
 * Returns a copy of `args` with any `-e <KEY>=<value>` pair whose KEY is
 * in {@link REDACTED_ENV_KEYS} replaced with `-e <KEY>=***`. The actual
 * `args` passed to `spawn` are never mutated — this is for log output
 * only.
 */
export function redactAwsCredentialsInArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]!;
    const next = args[i + 1];
    if (cur === '-e' && typeof next === 'string') {
      const eqIdx = next.indexOf('=');
      if (eqIdx > 0) {
        const key = next.substring(0, eqIdx);
        if (REDACTED_ENV_KEYS.has(key)) {
          out.push('-e', `${key}=***`);
          i++;
          continue;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Run a child process attached to the parent's stdio (so users see
 * progress lines as they happen). Resolves on exit code 0; rejects with
 * the captured stderr otherwise. Used for `docker pull`.
 */
function runForeground(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolveProc, rejectProc) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('error', (err) => rejectProc(new DockerRunnerError(`${cmd} failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolveProc();
      else rejectProc(new DockerRunnerError(`${cmd} exited with code ${code}`));
    });
  });
}
