import { spawn } from 'node:child_process';
import { dockerRegistryEnv } from 'cdk-local/internal';
import { getLogger, isStdoutReservedForPayload } from '../logger.js';

/**
 * Binary resolution (`CDK_DOCKER`), streaming and foreground spawn, and the
 * `docker login` stderr formatter. Part of the `docker-cmd.ts` split
 * (go-to-k/cdkd#5835); import from `../docker-cmd.js`, not from here.
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
   * When true, mirror stdout/stderr chunks live as they arrive. Useful for
   * `docker pull` / `docker build` where progress is desirable. Defaults to
   * "true when the logger is at debug level" — matches the existing
   * `--verbose` UX.
   *
   * WHICH STREAM the mirror uses is not yours to choose: stderr chunks always
   * go to `process.stderr`, and stdout chunks go to `process.stdout` only
   * while no command holds a payload reservation. Under one they go to
   * stderr instead ([#2410](https://github.com/go-to-k/cdkd/issues/2410)), so
   * do NOT add a caller on a reserving command in the belief that this option
   * puts the child's output on fd 1. The captured `SpawnResult` is
   * unaffected either way — read that, not the stream.
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
  return spawnStreaming(getDockerCmd(), args, withRegistryEnv(options));
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
      // Issue #2410: on the DOCKER callers the child's stdout is diagnostic
      // output (pull / build progress, `docker login`'s `Login Succeeded`,
      // `docker image inspect`'s JSON), never the calling command's payload.
      // `docker-build.ts`'s `executable` source mode does treat it as data,
      // but it reads the captured `SpawnResult.stdout` rather than the live
      // mirror, and its callers (`local run-task`, `publish-assets`) reserve
      // nothing — so routing the mirror is safe for it too. On a command
      // that has reserved stdout it must therefore JOIN the logger on
      // stderr, exactly as `ConsoleLogger.emit` routes its own info lines.
      //
      // Without this, `--verbose` alone reopened the hole the reservation
      // closes: `cdkd local invoke Stack/ImageFn --no-pull --verbose` reaches
      // `ecr-puller.ts`'s `docker image inspect` (via the `skipPull` branch)
      // and put a multi-hundred-line inspect array — including the image's
      // baked-in `Config.Env` — on the payload stream. Found independently by
      // the code and security reviewers on the go-to-k/cdkd#2410 PR.
      //
      // Fixed HERE rather than by passing `streamLive: false` at the two
      // `ecr-puller.ts` call sites, because that would leave the next
      // `runDockerStreaming` caller to rediscover it, and because MOVING the
      // line keeps the `--verbose` diagnostic the flag was asked for. On a
      // command that reserves nothing this is byte-identical to before.
      if (streamLive) {
        if (isStdoutReservedForPayload()) process.stderr.write(chunk);
        else process.stdout.write(chunk);
      }
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
 *   1. The child INHERITS descriptors — output is NOT captured, so terminal
 *      control codes (color, progress bar overwrites) flow through
 *      unchanged. That is the load-bearing reason for the split:
 *      `docker pull`'s progress bars only animate when the child writes to a
 *      real TTY rather than a pipe. Under a payload reservation the child's
 *      fd 1 is redirected to the parent's fd 2 rather than piped, precisely
 *      so it keeps a descriptor and not a pipe — though the animation then
 *      depends on STDERR being a terminal, and degrades to plain lines under
 *      `2> file` (issue
 *      [#2410](https://github.com/go-to-k/cdkd/issues/2410)).
 *   2. No `input` / `streamLive` options — inherit-mode has nothing to
 *      capture and nothing to mirror.
 *
 * Used by the `docker pull` plumbing in `docker-runner.ts` and
 * `ecr-puller.ts`. Those two callers differ, and the difference matters
 * enough to state: `docker-runner.ts` reaches this only under `--verbose`,
 * while `ecr-puller.ts` runs it UNCONDITIONALLY, which is what made the
 * pre-#2410 stdout leak reachable with no flag at all. Non-verbose pulls in
 * `docker-runner.ts` go through {@link runDockerStreaming} instead, so
 * stderr can be folded into the error message.
 */
export async function runDockerForeground(
  args: string[],
  options: ForegroundOptions = {}
): Promise<void> {
  return spawnForeground(getDockerCmd(), args, withRegistryEnv(options));
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
 * Foreground (descriptor-inheriting) spawn — the inherit-mode counterpart to
 * {@link spawnStreaming}. Used by {@link runDockerForeground} for docker-CLI
 * subprocesses.
 *
 * "inherit" is not unqualified, and THIS is the function that qualifies it:
 * while a command holds a payload reservation
 * ({@link isStdoutReservedForPayload}) the child's fd 1 is redirected to the
 * parent's fd 2, so its output cannot land in the payload
 * ([#2410](https://github.com/go-to-k/cdkd/issues/2410)). stdin and stderr
 * are inherited either way. See the inline note at the `spawn` call.
 *
 * The ENOENT branch crafts a docker-specific install hint ("Install Docker
 * (or set CDK_DOCKER ...)"), so non-docker callers reusing this helper
 * would see a misleading error on missing-binary failures. Keep the binary
 * docker-shaped, or update the ENOENT message before adding a non-docker
 * call site.
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
      // Issue #2410, second half. `'inherit'` on fd 1 hands the child OUR
      // stdout, and on a command holding a payload reservation that is the
      // payload stream. This path is worse than the `spawnStreaming` one
      // fixed alongside it, not better: `src/local/ecr-puller.ts` runs
      // `runDockerForeground(['pull', ...])` UNCONDITIONALLY, so
      // `cdkd local invoke Stack/ImageFn > out.json` put `docker pull`
      // progress into the payload with no `--verbose` and no flag at all.
      //
      // fd 1 is redirected to OUR fd 2 rather than piped, so the child keeps
      // writing to a descriptor rather than a pipe — a pipe would make docker
      // fall back to plain lines. The bars animate when stderr is a terminal;
      // under `2> file` they degrade, which is the correct trade against
      // corrupting the payload.
      // stderr and stdin stay inherited, and a command that reserves nothing
      // gets the original `'inherit'` on all three.
      stdio: isStdoutReservedForPayload() ? ['inherit', 2, 'inherit'] : 'inherit',
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

/**
 * `options` with cdk-local's `dockerRegistryEnv()` answer under the caller's
 * own `env` (go-to-k/cdkd#6187, mirroring go-to-k/cdk-local#918): under
 * `--aws-emulator` with ECR not excepted, every docker spawn through
 * `runDocker*` (each `pull` and `build`) holds no credential for an ECR host.
 * A caller that knows its workload passes `dockerRegistryEnv(workload)` as
 * `env` to route by that workload's own exceptions instead.
 */
function withRegistryEnv<T extends { env?: Record<string, string | undefined> }>(options: T): T {
  const registry = dockerRegistryEnv();
  // Outside --aws-emulator (or with ECR excepted) the answer is the host's own
  // values: leave the spawn exactly as it was.
  if (
    registry['DOCKER_CONFIG'] === process.env['DOCKER_CONFIG'] &&
    registry['DOCKER_AUTH_CONFIG'] === process.env['DOCKER_AUTH_CONFIG'] &&
    registry['REGISTRY_AUTH_FILE'] === process.env['REGISTRY_AUTH_FILE']
  ) {
    return options;
  }
  return { ...options, env: { ...registry, ...options.env } };
}
