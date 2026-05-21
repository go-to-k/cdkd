import { spawn } from 'node:child_process';
import { getLogger } from './logger.js';

/**
 * Shared helpers for invoking the docker-compatible CLI binary across cdkd.
 *
 * Two parity decisions with `aws-cdk-cli`'s `cdk-assets-lib`:
 *   1. `CDK_DOCKER` env var swaps the binary so podman / finch users can
 *      run cdkd without code changes (`CDK_DOCKER=podman cdkd deploy`).
 *   2. `runDockerStreaming` uses streaming spawn rather than `execFile`'s
 *      buffered `maxBuffer` ceiling. BuildKit's progress output can run to
 *      tens of MB on multi-stage builds with `# syntax=docker/dockerfile:1`
 *      frontend downloads + heredoc / `RUN --mount=...` features; the 50 MB
 *      `execFile` ceiling cdkd used to set silently killed those builds
 *      with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
 *
 * Output handling: stdout/stderr are collected in memory unconditionally so
 * `runDockerStreaming` can return them to the caller for error wrapping.
 * When the logger is at debug level (i.e. the user passed `--verbose`),
 * the chunks are ALSO mirrored to `process.stdout` / `process.stderr` so
 * the user sees live build progress.
 */

/**
 * Return the docker-compatible CLI binary to invoke. Matches CDK CLI:
 * `CDK_DOCKER` env var overrides the default `docker` so users on
 * podman / finch / nerdctl can swap without changing cdkd code.
 */
export function getDockerCmd(): string {
  const override = process.env['CDK_DOCKER'];
  return override && override.length > 0 ? override : 'docker';
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

export interface SpawnError extends Error {
  /** Captured stderr at the time of failure. */
  stderr: string;
  /** Captured stdout at the time of failure. */
  stdout: string;
  /** Process exit code (null when the process was killed by signal). */
  exitCode: number | null;
}

export interface RunDockerOptions {
  /** Optional working directory for the subprocess. */
  cwd?: string;
  /**
   * Additional environment variables to set. Merged on top of `process.env`
   * (so the user's `DOCKER_BUILDKIT=1` and friends propagate through).
   */
  env?: Record<string, string | undefined>;
  /** When set, written to stdin (used by `docker login --password-stdin`). */
  input?: string;
  /**
   * When true, mirror stdout/stderr chunks to `process.stdout` / `process.stderr`
   * as they arrive. Useful for `docker pull` / `docker build` where live
   * progress is desirable. Defaults to "true when the logger is at debug
   * level" — matches the existing `--verbose` UX.
   */
  streamLive?: boolean;
}

/**
 * Spawn a docker-compatible CLI binary (resolved via `getDockerCmd`) with
 * streaming I/O. Collects stdout/stderr in memory and resolves with both
 * on exit code 0; rejects with a `SpawnError` carrying both streams on any
 * non-zero exit so the caller can wrap with its own error class without
 * losing the upstream output.
 *
 * No `maxBuffer` ceiling: BuildKit progress output frequently exceeds the
 * `child_process.execFile` default of 1 MB (cdkd previously bumped to 50 MB
 * but BuildKit + frontend pulls can still exceed that on first-time builds).
 */
export async function runDockerStreaming(
  args: string[],
  options: RunDockerOptions = {}
): Promise<SpawnResult> {
  return spawnStreaming(getDockerCmd(), args, options);
}

/**
 * Generic streaming spawn — used by `runDockerStreaming` AND by the
 * `executable` source mode in `docker-build.ts` (which runs an arbitrary
 * user-supplied build command, not docker).
 */
export async function spawnStreaming(
  cmd: string,
  args: string[],
  options: RunDockerOptions = {}
): Promise<SpawnResult> {
  const streamLive = options.streamLive ?? getLogger().getLevel() === 'debug';
  const env = options.env ? mergeEnv(options.env) : undefined;

  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (streamLive) process.stdout.write(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (streamLive) process.stderr.write(chunk);
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `Failed to find and execute '${cmd}'. Install Docker (or set the ` +
              `'CDK_DOCKER' environment variable to a compatible binary such as podman / finch).`
          )
        );
      } else {
        reject(err);
      }
    });

    child.once('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message =
          stderr.trim() || stdout.trim() || `${cmd} ${args[0] ?? ''} exited with code ${code}`;
        const err = new Error(message) as SpawnError;
        err.stderr = stderr;
        err.stdout = stdout;
        err.exitCode = code;
        reject(err);
      }
    });

    if (options.input !== undefined) {
      child.stdin!.write(options.input);
      child.stdin!.end();
    }
  });
}

function mergeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }
  return merged;
}
