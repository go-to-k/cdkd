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
        const usingOverride = process.env['CDK_DOCKER'] === cmd && cmd !== 'docker';
        reject(
          new Error(
            usingOverride
              ? `Failed to find and execute '${cmd}' (resolved via CDK_DOCKER). ` +
                  `Install '${cmd}' or unset CDK_DOCKER to fall back to 'docker'.`
              : `Failed to find and execute '${cmd}'. Install Docker (or set the ` +
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
      // Defensive: when spawn() fails (e.g. ENOENT race), the synchronous
      // write below could emit a stream 'error' event before the close /
      // error handlers above fire. Without a listener, Node escalates that
      // to "Unhandled 'error' event" on some versions. cdkd's only `input`
      // call site is `docker login --password-stdin` with short payloads
      // that complete well within the syscall, so this is unlikely to fire
      // in practice — but the no-op listener is free.
      child.stdin!.on('error', () => {
        /* surfaced via the outer error/close handlers above */
      });
      child.stdin!.write(options.input);
      child.stdin!.end();
    }
  });
}

/**
 * Spawn a docker-compatible CLI binary (resolved via `getDockerCmd`) attached
 * to the parent process's stdio so the user sees live output (`docker pull`
 * layer progress, `docker login` interactive prompts that should never fire
 * with `--password-stdin` but still safe to inherit, etc.). Resolves on exit
 * code 0; rejects with a plain `Error` carrying the exit code on any non-zero
 * exit, so the caller can wrap with its own error class.
 *
 * Differs from {@link runDockerStreaming} in two ways:
 *   1. `stdio: 'inherit'` — output is NOT captured, so terminal control codes
 *      (color, progress bar overwrites) flow through unchanged. This is the
 *      load-bearing reason for the split: `docker pull`'s progress bars only
 *      animate properly when stdout is a real TTY connected to the parent.
 *   2. No `input` / `streamLive` options — inherit-mode has nothing to
 *      capture and nothing to mirror.
 *
 * Used by the `--verbose`-mode `docker pull` plumbing in `docker-runner.ts`
 * and `ecr-puller.ts` (visible layer progress). Non-verbose pulls go through
 * {@link runDockerStreaming} so stderr can be folded into the error message.
 */
export async function runDockerForeground(
  args: string[],
  options: ForegroundOptions = {}
): Promise<void> {
  return spawnForeground(getDockerCmd(), args, options);
}

export interface ForegroundOptions {
  /** Optional working directory for the subprocess. */
  cwd?: string;
  /**
   * Additional environment variables to set. Merged on top of `process.env`
   * (same semantics as {@link RunDockerOptions.env}).
   */
  env?: Record<string, string | undefined>;
}

/**
 * Generic foreground (stdio-inherit) spawn — the inherit-mode counterpart to
 * {@link spawnStreaming}. Used by {@link runDockerForeground} and reusable
 * by any future call site that needs to run a non-docker binary attached to
 * the parent's stdio.
 */
export async function spawnForeground(
  cmd: string,
  args: string[],
  options: ForegroundOptions = {}
): Promise<void> {
  const env = options.env ? mergeEnv(options.env) : undefined;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env,
      stdio: 'inherit',
    });
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        const usingOverride = process.env['CDK_DOCKER'] === cmd && cmd !== 'docker';
        reject(
          new Error(
            usingOverride
              ? `Failed to find and execute '${cmd}' (resolved via CDK_DOCKER). ` +
                  `Install '${cmd}' or unset CDK_DOCKER to fall back to 'docker'.`
              : `Failed to find and execute '${cmd}'. Install Docker (or set the ` +
                  `'CDK_DOCKER' environment variable to a compatible binary such as podman / finch).`
          )
        );
      } else {
        reject(new Error(`${cmd} failed: ${err.message}`));
      }
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

/**
 * Format the stderr from a failed `docker login` so the surfaced cdkd
 * error gives the user an actionable workaround when the underlying
 * failure is a credential-helper persistence bug (which has nothing to
 * do with cdkd, AWS, or IAM perms — the docker CLI itself fails to
 * save the auth token to the platform's credential store). The most
 * common shape is `osxkeychain` on macOS rejecting an overwrite for
 * an existing entry, but `wincred` (Windows), `pass` (Linux), and
 * `secretservice` (Linux) hit the same class of `Error saving
 * credentials` failure, so the rewritten message stays platform-
 * agnostic — `docker logout <endpoint>` is the correct recovery on
 * every backend.
 *
 * Detected docker / docker-credential-* output patterns:
 *   - `error storing credentials - err: exit status 1, out: \`The
 *     specified item already exists in the keychain.\`` (osxkeychain)
 *   - `Error saving credentials: ...` (any backend)
 *
 * Non-matching failures (genuine IAM / network / endpoint problems)
 * pass through with just the stderr trimmed — the original message
 * stays load-bearing for diagnosis.
 */
export function formatDockerLoginError(stderr: string, endpoint: string): string {
  const trimmed = stderr.trim();
  const isCredentialHelperFailure =
    trimmed.includes('already exists in the keychain') ||
    trimmed.includes('Error saving credentials');
  if (isCredentialHelperFailure) {
    return (
      `docker's credential helper (osxkeychain on macOS / wincred on Windows / pass / secretservice on Linux) ` +
      `failed to persist the ECR auth token. The "already exists in the keychain" / "Error saving credentials" ` +
      `output is a known docker-credential-helpers issue — unrelated to cdkd, AWS credentials, or IAM perms. ` +
      `Quick fix: run \`docker logout ${endpoint}\` to clear the stale entry, then retry the cdkd command. ` +
      `Permanent fix: edit ~/.docker/config.json and remove (or empty) the platform-specific "credsStore" entry ` +
      `(e.g. "osxkeychain" → "" or "desktop" on macOS Docker Desktop). ` +
      `Original docker stderr: ${trimmed}`
    );
  }
  return trimmed;
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
