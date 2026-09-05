import { spawn } from 'node:child_process';
import { inspect } from 'node:util';
import { getLogger, isStdoutReservedForPayload } from './logger.js';
import { escapeRegExp } from './regexp.js';

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
 * the chunks are ALSO mirrored live so the user sees build progress —
 * stderr always to `process.stderr`, and stdout to `process.stdout` EXCEPT
 * while a command holds a payload reservation
 * ({@link isStdoutReservedForPayload}), where it joins the logger on stderr
 * so a child's diagnostics cannot land in the payload
 * ([#2410](https://github.com/go-to-k/cdkd/issues/2410)). The same
 * reservation redirects `spawnForeground`'s inherited fd 1 to fd 2.
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

/**
 * Env vars the docker CLI itself reads to decide how / where to run. A resolved
 * ECS secret (or SecureString) whose NAME collides with one of these must NOT
 * override it in the docker client's own process environment: a secret named
 * `DOCKER_HOST` would redirect the client to a different daemon, and `PATH`
 * would break locating the docker binary. See issue
 * https://github.com/go-to-k/cdkd/issues/2183.
 */
export const DOCKER_CLIENT_ENV_KEYS: ReadonlySet<string> = new Set([
  // RULE for additions: anything the docker CLIENT (or a credential / connection
  // helper it execs) reads to decide WHAT CODE IT LOADS, WHAT IT TRUSTS, or
  // WHERE / HOW IT CONNECTS. A user-controlled secret NAME matching one of these
  // must never reach the client's own environment (issue #2183).
  // Process-level vars the client needs to run at all (incl. Windows HOME).
  // `PATHEXT` is here for the same code-execution reason as `PATH`: on Windows
  // Go's executable lookup reads it to choose which extension of an adjacent
  // helper (credential helper, `ssh`) to run, so a colliding secret can pick a
  // different program.
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Connection / transport (docs.docker.com/reference/cli/docker) — a colliding
  // secret here could redirect the client to a different daemon or downgrade TLS.
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'DOCKER_AUTH_CONFIG',
  // Execution / behavior.
  'DOCKER_DEFAULT_PLATFORM',
  'DOCKER_CUSTOM_HEADERS',
  'DOCKER_CONTENT_TRUST',
  'DOCKER_CONTENT_TRUST_SERVER',
  'DOCKER_HIDE_LEGACY_COMMANDS',
  'BUILDKIT_PROGRESS',
  // Loader — a colliding secret injects code into the client process (and the
  // credential / connection helpers it execs, which inherit its env). The docker
  // CLI here is dynamically linked, so the loader vars are live. The WHOLE `LD_*`
  // / `DYLD_*` family is caught by PREFIX in `isDockerClientEnvKey` rather than
  // enumerated here — an exact list of loader vars is always one release behind
  // (glibc `LD_*`, macOS `DYLD_ROOT_PATH` / `DYLD_IMAGE_SUFFIX` / ...); the
  // non-prefixed loader vars are named individually: `GLIBC_TUNABLES` (glibc
  // tuning) and `GCONV_PATH` (glibc loads gconv shared objects from it — a
  // code-load vector of the same class, ignored only for setuid binaries,
  // which the docker CLI is not).
  'GLIBC_TUNABLES',
  'GCONV_PATH',
  // `BASH_ENV` is sourced by bash in NON-interactive shells, so it bites when
  // a `docker-credential-*` helper is a shell-script wrapper (common for
  // `aws ecr get-login-password` wrappers). `ENV` is interactive-only and is
  // deliberately absent.
  'BASH_ENV',
  // SSH — the `ssh://`-context connection helper's exec/trust-bearing vars,
  // enumerated EXACTLY rather than by an `SSH_` prefix (#2186 review round 3):
  // the client-side exec/trust set is CLOSED (last addition
  // `SSH_ASKPASS_REQUIRE`, OpenSSH 8.4, 2020), while an `SSH_` prefix breaks
  // realistic secrets — `SSH_PRIVATE_KEY` is GitLab CI's canonical deploy-key
  // spelling. `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` /
  // `SSH_ORIGINAL_COMMAND` are sshd-SET, never client-read, and stay off the
  // list. The attack also needs the operator to already be on ssh transport
  // (`DOCKER_HOST` / `DOCKER_CONTEXT` are exact-denylisted above), so unlike
  // `LD_PRELOAD` it is not self-bootstrapping.
  'SSH_AUTH_SOCK', // agent hijack
  'SSH_ASKPASS', // OpenSSH execs the named program
  'SSH_ASKPASS_REQUIRE',
  'SSH_SK_HELPER', // security-key helper — OpenSSH execs it
  'SSH_SK_PROVIDER', // FIDO provider LIBRARY path — OpenSSH dlopens it (Codex review)
  'SSH_PKCS11_HELPER', // PKCS#11 helper — OpenSSH execs it
  'SSH_AGENT_PID', // not load-bearing, kept for completeness of the closed set
  // Credential-helper reach (#2186 review rounds 3-4): `docker run` on a
  // missing image pulls, the pull auths, and the auth execs
  // `docker-credential-ecr-login` — whose AWS SDK reads these to decide WHERE
  // to send a request signed with the OPERATOR's real credentials
  // (`dockerSpawnEnvWithSensitive` starts from `{ ...process.env }`, so those
  // credentials are in the client's env unless a same-named container secret —
  // they are in `SENSITIVE_ENV_KEYS` — overrides them). A secret named
  // `AWS_ENDPOINT_URL` would make the helper sign with them and send the
  // result to an attacker-chosen host — the `DOCKER_HOST` class, one helper
  // over. The file/profile vars repoint which credentials it loads;
  // `AWS_ROLE_ARN` is `AWS_WEB_IDENTITY_TOKEN_FILE`'s mandatory partner (an
  // attacker-set role ARN plus the operator's own token file assumes a
  // different identity), and `AWS_EC2_METADATA_SERVICE_ENDPOINT` redirects the
  // IMDS credential source. The per-service `AWS_ENDPOINT_URL_<SERVICE>` forms
  // (aws-sdk-go-v2 honours them) are caught by PREFIX in
  // `isDockerClientEnvKey`, since an exact list per service cannot keep up.
  'AWS_ENDPOINT_URL',
  'AWS_CA_BUNDLE',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_ROLE_ARN',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  // Trust — a colliding secret repoints the client's trusted CA bundle for the
  // daemon / registry TLS handshake (Go's x509 honours these on Linux) or tunes
  // the Go runtime.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GODEBUG',
  // Proxy vars the client honors for registry connections — a colliding secret
  // could route the client's traffic (incl. image pulls) through an attacker.
  // Only the upper-case spellings are listed: matching is case-insensitive
  // (`DOCKER_CLIENT_ENV_KEYS_UPPER`), so lower-case duplicates were unreachable.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
  'ALL_PROXY',
]);

const DOCKER_CLIENT_ENV_KEYS_UPPER: ReadonlySet<string> = new Set(
  [...DOCKER_CLIENT_ENV_KEYS].map((k) => k.toUpperCase())
);

/**
 * Env-var prefixes whose WHOLE family the docker client (or a helper it execs)
 * reads, so a NAMED list is always one release behind and a colliding secret in
 * ANY member is a hazard. `LD_*` / `DYLD_*` are the dynamic loader (code
 * injection, glibc + macOS); `AWS_ENDPOINT_URL_*` is the per-service endpoint
 * family aws-sdk-go-v2 (and so `docker-credential-ecr-login`) honours — a
 * secret named `AWS_ENDPOINT_URL_ECR` walks around the exact
 * `AWS_ENDPOINT_URL` entry and redirects a request signed with the operator's
 * real credentials (#2186 round 4). No plausible secret name collides with
 * any of the three. Matched by prefix rather than enumerated (issue #2183
 * review). `SSH_` was a prefix here and was demoted to an EXACT enumeration
 * in {@link DOCKER_CLIENT_ENV_KEYS} (#2186 review round 3): the family is not
 * uniformly dangerous and is not growing, while the prefix broke realistic,
 * currently-working secrets (`SSH_PRIVATE_KEY`, GitLab CI's canonical
 * deploy-key spelling). Exported so the test fence can assert the EXACT
 * contents — a hardcoded copy in the test made the anti-shadowing fence
 * one-directional (#2186 round 4 finding 2).
 */
export const DOCKER_CLIENT_ENV_PREFIXES: readonly string[] = ['LD_', 'DYLD_', 'AWS_ENDPOINT_URL_'];

/**
 * Is `key` the name of a var the docker client reads? Case-INSENSITIVE, because
 * Windows environment lookups are, so a lowercase `docker_host` must be caught
 * too (issue #2183). Matches the exact denylist OR a prefixed family — the
 * prefix families are fail-closed on the whole prefix, so an unlisted `LD_*` /
 * `DYLD_*` / `AWS_ENDPOINT_URL_*` secret is dropped (with a rename warning)
 * rather than reaching the client.
 */
export function isDockerClientEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DOCKER_CLIENT_ENV_KEYS_UPPER.has(upper)) return true;
  return DOCKER_CLIENT_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * A well-formed `docker run -e` variable NAME: non-empty, and containing
 * neither `=` (the OS parses the environ entry's name as everything before the
 * first one) nor NUL (Node refuses to spawn). A newline IS accepted, because it
 * is inside the class — not because of the anchor: JS `$` without the `m` flag
 * matches only at end of input (`/^abc$/.test('abc\n') === false`). That
 * matches the clause list this replaced, i.e. deliberately not stricter.
 */
const WELL_FORMED_ENV_KEY = /^[^=\0]+$/;

/**
 * Is `key` a shape that cannot be a well-formed `docker run -e` variable NAME?
 * Defined POSITIVELY as {@link WELL_FORMED_ENV_KEY}'s complement (#2186 rounds
 * 5-6). Enumerating the bad spellings one at a time closed `=` in round 4 and
 * left the empty key (`-e ''` — docker rejects it with an opaque error naming
 * no secret) and a NUL-bearing key still open; the complement closes any
 * further bad shape without another clause. A sensitive key matching this
 * takes the same fail-closed
 * collision path as a docker-client-var name: no `-e` flag, no spawn-env entry,
 * reported in `collisions`. (This is the NAME only; a secret VALUE containing a
 * NUL is a separate pre-existing leak tracked in issue #2189.)
 */
export function isMalformedEnvKey(key: string): boolean {
  return !WELL_FORMED_ENV_KEY.test(key);
}

/**
 * Split a container's environment into `docker run` `-e` flags and the values
 * that must travel through the spawn env instead of the argv.
 *
 * - a NON-sensitive key becomes `-e KEY=value` on the argv (unchanged);
 * - a sensitive key becomes a value-less `-e KEY`, its value returned in
 *   `sensitiveEnv` for {@link dockerSpawnEnvWithSensitive};
 * - a sensitive key that NAMES a docker-client var ({@link isDockerClientEnvKey}
 *   — the exact denylist plus the prefix families, so an external caller must
 *   use the predicate, not `DOCKER_CLIENT_ENV_KEYS.has`) gets NO flag at all,
 *   its value is dropped, and the key is reported in `collisions` so the
 *   caller can warn;
 * - a sensitive key of a MALFORMED shape ({@link isMalformedEnvKey} — empty,
 *   or containing `=` / NUL) takes the same fail-closed path (#2186 rounds
 *   4-5). The denylist matches the WHOLE key string, but Node serialises env
 *   as `key=value` and the OS parses the variable NAME as everything before
 *   the FIRST `=` — so a secret named `PATH=/tmp/evil:` is not a denylist
 *   match while the environ it produces (`PATH=/tmp/evil:=<secret>`) POISONS
 *   the client's `PATH`, and the poisoned duplicate wins (measured). The
 *   docker CLI execs `docker-credential-*` helpers off `PATH`, so that is code
 *   execution as the operator. Defining the GOOD shape positively also catches
 *   the empty key (`-e ''`, an opaque docker rejection) in one predicate.
 *
 * The collision case is why the argv half lives here beside the env half.
 * Emitting `-e KEY` for a key that `dockerSpawnEnvWithSensitive` refuses to
 * set makes docker resolve the flag against the CLIENT's own environment, so
 * the container silently receives the HOST's value for that var (issue #2183)
 * -- e.g. the host's `HTTPS_PROXY` credential, or a macOS `PATH` inside a
 * Linux image. Dropping the flag is what makes "not forwarded" literally true.
 */
export function partitionSensitiveEnv(
  env: Record<string, string>,
  sensitiveKeys: ReadonlySet<string>
): { flags: string[]; sensitiveEnv: Record<string, string>; collisions: string[] } {
  const flags: string[] = [];
  const sensitiveEnv: Record<string, string> = {};
  const collisions: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!sensitiveKeys.has(k)) {
      flags.push('-e', `${k}=${v}`);
      continue;
    }
    if (isMalformedEnvKey(k) || isDockerClientEnvKey(k)) {
      collisions.push(k);
      continue;
    }
    flags.push('-e', k);
    sensitiveEnv[k] = v;
  }
  return { flags, sensitiveEnv, collisions };
}

/**
 * Build the environment for a `docker run` that forwards value-less `-e KEY`
 * flags (the pattern that keeps secret VALUES off the argv / `/proc/<pid>/cmdline`).
 * The child gets the full parent env plus the sensitive passthrough, but the
 * docker client's own critical vars ({@link isDockerClientEnvKey}) are kept
 * authoritative from `process.env`, so a user-controlled secret NAME cannot
 * hijack the client (issue #2183). Callers should partition through
 * {@link partitionSensitiveEnv}, which never puts a colliding key in
 * `sensitiveEnv`; the guard here is defence in depth.
 */
export function dockerSpawnEnvWithSensitive(
  sensitiveEnv: Record<string, string>
): NodeJS.ProcessEnv {
  // Start from the client's OWN environment and add only the sensitive keys
  // that do NOT name a docker-client var and are not malformed. A colliding /
  // malformed secret is never written, so it can neither hijack the client
  // (redirect the daemon, break PATH) nor leave a stale value behind —
  // regardless of whether the host set that var. The malformed-key guard is
  // belt-and-braces with `partitionSensitiveEnv`'s (#2186 rounds 4-5): this
  // function is EXPORTED, so a future caller may reach it without partitioning
  // first (every caller does today, `runDetached` included since #2187 / issue
  // #2184 — which is why this guard must not be read as dead). A key containing
  // `=` serialises as an environ entry whose
  // OS-parsed NAME is only the part before the first `=`, which the denylist
  // check cannot see, so the raw key must be refused here too.
  //
  // NOTE: case-insensitive Windows env handling (a case-differing HOST alias of
  // a passthrough key, and two sensitive keys differing only by case) is
  // DELIBERATELY not handled here — it needs the Windows-critical vars on the
  // denylist first and a real Windows execution path, neither of which exists
  // in this repo (CI is ubuntu-only). Tracked in issue #2190.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(sensitiveEnv)) {
    if (isMalformedEnvKey(k) || isDockerClientEnvKey(k)) continue;
    env[k] = v;
  }
  return env;
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

/** Replaces a redacted argv VALUE wherever this module masks one. */
const REDACTED_ARGV_VALUE = '***';

/**
 * `docker` argv flags whose NEXT token is a `KEY=VALUE` pair built from
 * user-supplied template data, and whose VALUE therefore must not reach a
 * user-visible error string:
 *
 * - `-e` / `--env` — a container's `Environment.Variables` (Lambda) or
 *   `ContainerDefinition.Environment` (ECS), plus `--env-vars` overrides.
 *   Values that cdkd classifies as sensitive never get here at all
 *   ({@link partitionSensitiveEnv} emits those as a value-less `-e KEY`),
 *   but everything else does: connection strings, endpoints, API base URLs.
 * - `--opt` — `DockerVolumeConfiguration.DriverOpts`, which for the `local`
 *   driver carries mount options (`o=addr=…,username=…,password=…`).
 * - `--label` — `DockerVolumeConfiguration.Labels`, user-authored metadata.
 * - `--build-arg` — a `DockerImageAsset`'s `buildArgs`, forwarded by
 *   `src/assets/docker-build.ts` on BOTH the deploy-time ECR publish path and
 *   `cdkd local run-task`'s image build
 *   ([#2623](https://github.com/go-to-k/cdkd/issues/2623)). The value is
 *   frequently NOT a secret and IS diagnostic (a version pin, a base-image
 *   tag), which is why this one needed arguing rather than assuming — the
 *   argument that settles it is RECOVERABILITY, not likelihood. The build-arg
 *   values sit unredacted in `cdk.out/*.assets.json` on the operator's own
 *   disk, so a masked `--verbose` line costs one `jq` against a file they
 *   already have; the log line is the copy that travels into a CI archive and
 *   a pasted issue, where a build-time registry / package token
 *   (`NPM_TOKEN`, `GITHUB_TOKEN` — a common, if discouraged, use of
 *   `buildArgs`) is disclosed irreversibly. The KEY survives, so "which build
 *   arg" — the half of the diagnostic that identifies the failure — is
 *   unaffected.
 *
 * A flag NOT in this list keeps its value. For most of the argv that is
 * because the value is cdkd-authored or infrastructure-shaped — a container
 * id, an image ref, a `--subnet` CIDR, a `--format` template — and is the
 * diagnostic.
 *
 * That is NOT true of the whole remainder, and the residual is recorded here
 * rather than quietly implied: `--health-cmd`, `--ulimit`, `--link`,
 * `--entrypoint`, `--workdir` and the positional image + container command are
 * all template-supplied and still echoed. They stay unmasked deliberately —
 * each is a COMMAND or a structural knob whose text IS what an operator reads
 * the failure for, and none is a documented place to put a secret, unlike
 * `Environment` / `Secrets` / `DriverOpts`. Revisit per flag if a real leak is
 * found through one; do not widen the set on suspicion, since every addition
 * trades away diagnostic text.
 *
 * Two `docker build` flags were considered WITH `--build-arg` and deliberately
 * left out, because both carry a LOCATOR rather than a value
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623)):
 *
 * - `--secret id=<id>,src=<path>` (or `,env=<NAME>`) — BuildKit resolves the
 *   material itself at build time and docker has NO inline-value syntax, so
 *   cdkd never holds the secret to leak. Masking would also blank the `id`,
 *   since the mask keys on the first `=` and `id` is what sits there — trading
 *   the whole diagnostic ("which secret, sourced from where") for a path.
 * - `--build-context <name>=<path|image-ref|git-url>` — a path or a ref, like
 *   the positional image. A URL form CAN embed a credential, but so can the
 *   image ref; masking one of the two would be a guarantee this set does not
 *   make, and neither is a documented place to put one.
 *
 * `--cache-from` / `--cache-to` were in that second bullet for one review
 * round and the security reviewer was right to refuse it: their value is a
 * comma-separated PARAM LIST, and BuildKit's cache backends take real
 * credentials inline there — s3's `access_key_id` / `secret_access_key` /
 * `session_token`, azblob's `secret_access_key`, gha's `token`. Those are not
 * locators, so they get their own structural mask keyed on the PARAM name:
 * {@link ARGV_PARAM_LIST_FLAGS} / {@link ARGV_PARAM_LIST_LOCATOR_PARAMS}.
 */
const ARGV_VALUE_BEARING_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--env',
  '--opt',
  '--label',
  '--build-arg',
]);

/**
 * `docker` argv flags whose NEXT token is a COMMA-SEPARATED `key=value` param
 * list rather than one `KEY=VALUE` pair ([#2623](https://github.com/go-to-k/cdkd/issues/2623)
 * security review).
 *
 * Only the params in {@link ARGV_PARAM_LIST_LOCATOR_PARAMS} survive, and the
 * rest of the list is masked — `type=s3,region=us-east-1,bucket=b` IS the
 * diagnostic ("which backend, where"), and blanking the whole value would
 * destroy it to hide one field.
 */
const ARGV_PARAM_LIST_FLAGS: ReadonlySet<string> = new Set(['--cache-from', '--cache-to']);

/**
 * Param names inside an {@link ARGV_PARAM_LIST_FLAGS} value that are LOCATORS
 * and therefore survive. **Everything else in the list is masked** — this is
 * an ALLOWLIST, and it is one deliberately.
 *
 * The first cut was a denylist of the credential params BuildKit's backends
 * spell (`secret_access_key`, `access_key_id`, `session_token`, `token`), and
 * both round-2 reviewers broke it the same way:
 * `DockerCacheOption.params` is an arbitrary user map that
 * `cacheOptionToFlag` joins with a bare `,` and no quoting, so a value
 * CONTAINING a comma (`token=aa,bb`, or BuildKit's own legal
 * `secret_access_key="ab,cd"`) split into a masked head and a bare tail that
 * printed verbatim — output that LOOKS redacted. Patching that one shape is
 * the enumerate-bad-shapes treadmill; inverting the test ends it, because a
 * CSV continuation fragment has no recognised param name and so masks by
 * construction.
 *
 * The trade is the right way round for a leak fix: a param missing from this
 * list costs one degraded diagnostic, a param missing from a denylist costs a
 * printed credential. The list covers every backend BuildKit ships —
 * `registry` (`ref`), `local` (`dest` / `src` / `digest` / `tag`), `s3`
 * (`region` / `bucket` / `name` / the prefixes / `use_path_style`), `azblob`
 * (`account_name` / `name` / `prefix`), `gha` (`scope` / `timeout`),
 * `inline` (none) — plus the shared export options, so the common case masks
 * nothing.
 *
 * The four URL-valued locators live in {@link ARGV_PARAM_LIST_URL_PARAMS}
 * instead: they survive only after their userinfo and query are stripped. An
 * earlier revision kept them HERE, whole, arguing the repo's locator policy;
 * that paragraph is gone rather than softened, because azblob makes it false.
 *
 * Matched case-INSENSITIVELY on the trimmed param name — the comparison is
 * over a user-supplied key and BuildKit's own option parsing is
 * case-insensitive, so a `Secret_Access_Key` spelling must not walk past.
 */
const ARGV_PARAM_LIST_LOCATOR_PARAMS: ReadonlySet<string> = new Set([
  // shared / export options
  'type',
  'mode',
  'compression',
  'compression-level',
  'force-compression',
  'ignore-error',
  'image-manifest',
  'oci-mediatypes',
  'timeout',
  // registry
  'ref',
  // local
  'dest',
  'src',
  'digest',
  'tag',
  // s3
  'region',
  'bucket',
  'name',
  'prefix',
  'manifests_prefix',
  'blobs_prefix',
  'use_path_style',
  'upload_parallelism',
  'touch_refresh',
  // azblob
  'account_name',
  // gha
  'scope',
]);

/**
 * Locator params whose value is a URL, and which therefore survive only after
 * their USERINFO, QUERY and FRAGMENT are stripped — and only when the value
 * parses at all
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623) round-3 security
 * review).
 *
 * These were plain allowlist entries for one round, on the reasoning that a
 * credential-in-URL is an incidental hazard shared with `--build-context` and
 * the positional image ref. That reasoning does not survive contact with
 * azblob: BuildKit builds an UNAUTHENTICATED client from `account_url` when
 * `secret_access_key` is absent, so a SAS token in its query string is that
 * backend's SUPPORTED auth path, not an accident. With every other param now
 * fail-closed, leaving the whole URL was the one entry carrying credential
 * material by design.
 *
 * Scheme and host survive, which is what "which endpoint" needs — on the
 * ordinary path. FOUR things mask more than that, and every one of them also
 * masks each param after it in the same value, because they all set `masked`.
 * Three take the value WHOLE: no recognisable `//` authority; a host that is
 * really `user:password` with its `@` cut away; and a later param carrying
 * this URL's severed `@` (the caller's rule, since only it still holds the
 * parts). The fourth is milder in what it keeps, not in what it cascades — a
 * `@` in the PATH costs the host but keeps scheme and tail (`https://h/x@y`
 * -> `https://***@y`). Over-masking is the deliberate direction: see
 * {@link redactUrlLocator} for what each boundary rule leaked before this one.
 */
const ARGV_PARAM_LIST_URL_PARAMS: ReadonlySet<string> = new Set([
  'account_url',
  'endpoint_url',
  'url',
  'url_v2',
]);

/**
 * A URL locator with its credential-bearing parts removed: `userinfo@`, and
 * everything from `?` or `#` on.
 *
 * Returns the input UNCHANGED when there was nothing to strip, which is the
 * signal the caller keys "was this masked?" on — so every other branch must
 * differ from its input. An unparseable or implausible value returns `***`
 * rather than itself: these four params are the only ones exempt from the
 * allowlist's mask-by-default rule, so this function is their whole
 * protection and it fails CLOSED.
 */
function redactUrlLocator(value: string): string {
  // An EMPTY value carries nothing, so `***` would assert a secret that is not
  // there — and because a mask here also masks every LATER param, it would
  // take the rest of the diagnostic with it. Same rule the param walk applies
  // to an empty part; round 5 added it there and not here.
  if (value === '') return value;
  // FAIL CLOSED on anything without a recognisable `//` authority. These four
  // params are the ONLY ones exempt from the allowlist's mask-by-default rule,
  // so this parse is their sole protection and an unrecognised shape must not
  // pass through whole. The first cut required `scheme://` and returned the
  // input unchanged otherwise, which printed
  // `endpoint_url=user:pw@minio.local:9000` verbatim — a real spelling, and
  // the enumerate-bad-shapes failure this PR argues against, inverted.
  const authority = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.exec(value);
  if (authority === null) return REDACTED_ARGV_VALUE;
  const prefix = authority[0];
  let rest = value.slice(prefix.length);

  // USERINFO FIRST, and anchored on the LAST `@` in the whole remainder — not
  // on a computed authority boundary. Every boundary rule tried here leaked,
  // because each one trusts the value to be well-formed and docker prints
  // whatever it was handed:
  //
  //   - bounded by the first `/`  -> `AKIA:wJal/rX@host` passed through whole
  //     (a literal `/` in userinfo is invalid syntax, and still printable).
  //   - bounded by the first `?`  -> `user:p?w@h/x` read as "no userinfo" and
  //     printed the password up to the `?`. Measured on this branch.
  //
  // Taking the last `@` cannot leak: whatever precedes it is gone. The cost is
  // over-masking when a `@` sits in the PATH or QUERY (`h/x@y` -> `***@y`,
  // losing the host) AND — because any mask here sets `masked` — every param
  // AFTER this one in the same value. That is the safe direction and the only
  // rule here that does not depend on the value parsing.
  const lastAt = rest.lastIndexOf('@');
  if (lastAt >= 0) {
    rest = `${REDACTED_ARGV_VALUE}${rest.slice(lastAt)}`;
  } else {
    // No `@` at all — which is ALSO what a userinfo containing a COMMA looks
    // like, because `maskArgvFlagValue` splits the param list on `,` before
    // this function ever sees the URL: `endpoint_url=https://AKIAX:wJalr,XyZ@h`
    // arrives here as `https://AKIAX:wJalr`.
    //
    // DEFENCE IN DEPTH ONLY. This shape-based rule recognises just the
    // `user:password` sub-case, and round-6 review measured two it cannot see
    // (a bare-token userinfo with no `:`, and an all-digit password). The
    // severed-comma class is closed by the CALLER, which still holds the
    // parts the split produced and can see the orphaned `@`; this stays
    // because a `:`-bearing head is not a host either way. `h:9000` and
    // `[::1]:9000` keep working.
    const host = rest.split(/[/?#]/)[0]!;
    // Strip a bracketed IPv6 literal before the colon test: its own colons are
    // not a `user:password` separator, and matching them made
    // `endpoint_url=http://[::1]:9000` mask -- AND, because a mask cascades,
    // take every later param with it. A legitimate local-MinIO spelling,
    // measured as a regression this rule introduced (round-6 review).
    //
    // Gated on the bracket actually holding an IPv6 LITERAL, not merely on a
    // leading `[`. Exempting all bracket content re-opened exactly the case
    // this rule is kept for: `https://[AKIA:wJalrSecret]` has no `@` anywhere,
    // so the caller's severed-`@` scan cannot see it either, and it printed
    // verbatim (both round-7 reviewers measured it). The hex-and-colon charset
    // refuses it because `K`, `w` and `J` are not hex digits. An UNTERMINATED
    // bracket does not match, so the whole host is tested -- fails closed, the
    // right direction.
    const ipv6 = /^\[[0-9A-Fa-f:.]+\]/.exec(host);
    const bare = ipv6 ? host.slice(ipv6[0].length) : host;
    // `\d{1,5}` rather than `\d*`: a port is at most 65535, so a longer digit
    // run is not one. Narrower by exactly the shapes it should refuse.
    if (/:(?!\d{1,5}$)/.test(bare)) return REDACTED_ARGV_VALUE;
  }

  // Query AND fragment: azblob's SAS rides the query, and a fragment is just
  // as printable even though Go's URL parser drops it before BuildKit sees it.
  for (const delimiter of ['?', '#']) {
    const at = rest.indexOf(delimiter);
    if (at >= 0) rest = `${rest.slice(0, at)}${delimiter}${REDACTED_ARGV_VALUE}`;
  }
  return `${prefix}${rest}`;
}

/**
 * The masked rendering of `value` for `flag`, or `undefined` when this flag
 * carries nothing to mask.
 *
 * The single place every argv spelling converges — `--flag VALUE` (two
 * tokens), `--flag=VALUE` (one), and pflag's shorthand cluster in both forms,
 * which reach it through {@link maskAttachedShortFlag} and through
 * {@link trailingShortFlagOfCluster} in {@link redactDockerArgvValues}. The joined form is valid docker syntax for every long
 * flag here, and it was UNMASKED until the [#2623](https://github.com/go-to-k/cdkd/issues/2623)
 * review: harmless while every argv this repo builds emits two tokens, but
 * `src/assets/docker-build.ts`'s `executable` source mode renders a
 * USER-AUTHORED command line, and a wrapper script spelling
 * `--build-arg=NPM_TOKEN=…` leaked it verbatim into both the `--verbose` log
 * and a thrown error.
 */
function maskArgvFlagValue(flag: string, value: string): string | undefined {
  if (ARGV_VALUE_BEARING_FLAGS.has(flag)) {
    const eqIdx = value.indexOf('=');
    // `>= 0`, not `> 0`: an EMPTY key (`-e =value`) still carries a value.
    // `partitionSensitiveEnv` fail-closes a malformed key only on its
    // SENSITIVE branch, so a non-sensitive `{ Name: '', Value: <secret> }`
    // reaches the argv as a literal `-e =<secret>` — and a `> 0` guard walks
    // straight past it. Same fail-closed posture as `isMalformedEnvKey`
    // (#2186 rounds 4-5).
    return eqIdx >= 0
      ? `${value.substring(0, eqIdx)}=${REDACTED_ARGV_VALUE}`
      : // A value-less `-e KEY` (the form `partitionSensitiveEnv` emits for a
        // sensitive key) has nothing to mask.
        undefined;
  }
  if (ARGV_PARAM_LIST_FLAGS.has(flag)) {
    let masked = false;
    const rawParts = value.split(',');
    const parts = rawParts.map((part, index) => {
      // Everything AFTER the first masked part is masked too. The join is
      // lossy: `token=aa,name=bb` is indistinguishable from a `token` whose
      // value literally contains `,name=bb`, so once a part is known to have
      // carried credential material, no later part can be trusted to be a
      // param rather than its tail. The params BEFORE the first credential
      // survive whole, and BuildKit's own documented ordering puts `type=`
      // there — so the "which backend, where" diagnostic is what is kept.
      // An EMPTY part carries nothing, at any index. Rendering `,,` as
      // `,***,` would assert a secret that does not exist -- the same reason
      // the index-0 carve-out below gives, applied consistently.
      if (part === '') return part;
      if (masked) return REDACTED_ARGV_VALUE;
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) {
        // buildx's legacy shorthand: `--cache-from <NAME>` is a bare image
        // ref — a pure locator, and the WHOLE diagnostic. It can only be
        // first; a bare part anywhere else is a continuation of the value
        // before it (`token=aa,bb` splits into `token=aa` and `bb`, and `bb`
        // is half the credential), so only index 0 survives.
        //
        // An EMPTY value lands here too (`''.split(',')` is `['']`) and is
        // likewise returned unchanged, which is the right answer for a
        // different reason: rendering `--cache-to ''` as `***` would assert a
        // secret that does not exist. A separate `value === ''` early return
        // said so explicitly for one round and was DEAD — its mutation probe
        // could not discriminate, because this line already produced the same
        // result. Both behaviours are pinned by tests, so a future narrowing
        // of this carve-out reds the empty case too.
        if (index === 0) return part;
        masked = true;
        return REDACTED_ARGV_VALUE;
      }
      const name = part.substring(0, eqIdx);
      const normalized = name.trim().toLowerCase();
      if (ARGV_PARAM_LIST_URL_PARAMS.has(normalized)) {
        // A `@` in any LATER part can only be THIS url's severed userinfo
        // terminator: the split destroyed a comma that was inside the value,
        // and nothing downstream of a URL param legitimately carries one.
        // The caller knows what the split destroyed, which is why this lives
        // here and not in `redactUrlLocator` — the head handed to that
        // function has already lost the evidence.
        //
        // The previous guard inferred the severance from the HEAD's shape (a
        // `:` whose right side is not a port) and only recognised
        // `user:password`. Round-6 security review measured two shapes still
        // printing: a bare-token userinfo (`https://ghp_TOKEN,TAIL@github.com`
        // — the dominant registry / GHA spelling, no `:` at all, so the head
        // is indistinguishable from a hostname) and an all-DIGIT password
        // (`admin:12345`, which satisfies the port test). Both are closed by
        // asking the array instead of the string.
        //
        // Cost: a cache config carrying BOTH a URL param and a later digest
        // ref (`ref=repo@sha256:…`) masks the URL it did not need to. Safe
        // direction, and the two do not co-occur in any BuildKit backend.
        if (rawParts.slice(index + 1).some((later) => later.includes('@'))) {
          masked = true;
          return `${name}=${REDACTED_ARGV_VALUE}`;
        }
        const rawUrl = part.substring(eqIdx + 1);
        const safeUrl = redactUrlLocator(rawUrl);
        if (safeUrl === rawUrl) return part;
        masked = true;
        return `${name}=${safeUrl}`;
      }
      if (ARGV_PARAM_LIST_LOCATOR_PARAMS.has(normalized)) return part;
      masked = true;
      return `${name}=${REDACTED_ARGV_VALUE}`;
    });
    return masked ? parts.join(',') : undefined;
  }
  return undefined;
}

/**
 * The masked rendering of an ATTACHED short-flag element (`-eKEY=VALUE`), or
 * `undefined` when this element is not one.
 *
 * pflag — which docker uses — accepts a short flag's value glued to it, so
 * `-eNPM_TOKEN=secret` is `-e NPM_TOKEN=secret`, and neither the two-token nor
 * the `--flag=VALUE` branch can see it ([#2623](https://github.com/go-to-k/cdkd/issues/2623)
 * round-2 security review). No argv this repo BUILDS uses the form, but
 * `src/assets/docker-build.ts`'s `executable` source mode hands a user's own
 * command line straight to `spawn`, which is the whole reason the joined form
 * is masked too.
 *
 * This OVER-MASKS relative to pflag, and the earlier claim that it "follows
 * docker's own parse" was wrong: pflag stops at the first cluster letter that
 * consumes a value, so it reads `-file=a=b` as `-f` taking `ile=a=b` while
 * this masks at the `e`. Every such divergence costs a diagnostic and hides
 * nothing that was not already a `KEY=VALUE` pair, so the direction is the
 * safe one — but it is a divergence, not parity.
 */
function maskAttachedShortFlag(arg: string): string | undefined {
  // A long flag is the joined branch's business. No `length` guard: `at < 0`
  // and `at === arg.length - 1` below already reject `-`, `-x` and a bare
  // `-e`, so one would be a line no mutation can kill.
  if (arg.startsWith('--') || !arg.startsWith('-')) return undefined;
  // pflag processes a shorthand CLUSTER left to right, so the flag letter may
  // sit anywhere in the run and everything after it is its value: `-itdeK=v`
  // is `-i -t -d -e K=v`. Anchoring on `startsWith(flag)` saw only the
  // un-clustered spelling, and `docker run -itd` is the most common docker
  // shorthand there is ([#2623](https://github.com/go-to-k/cdkd/issues/2623)
  // round-3 review measured `-itdeNPM_TOKEN=…` printing verbatim).
  //
  // LEFTMOST letter wins, across all short flags — that is pflag's own rule.
  // Iterating the Set and taking the first HIT instead made the result depend
  // on insertion order, so a second short flag could slice at a stray letter
  // further right and print the head of the value (round-4 review).
  //
  // UNEXERCISED, and deliberately said so: `-e` is the only short flag in the
  // set, so leftmost-wins and first-hit-wins agree on every input and no
  // behavioural test can tell them apart (probed — green). The pointer that
  // arrives WITH the second short flag rather than after it is the
  // one-short-flag assertion in
  // `tests/unit/local/docker-argv-redaction-fence.test.ts`, which reds the
  // moment one is added and names the case to write.
  let chosen: { at: number; flag: string } | undefined;
  for (const flag of ARGV_VALUE_BEARING_FLAGS) {
    // Short flags only: `-e`, never `--env`.
    if (flag.length !== 2 || !flag.startsWith('-') || flag[1] === '-') continue;
    const at = arg.indexOf(flag[1]!, 1);
    if (at < 0 || at === arg.length - 1) continue;
    if (chosen === undefined || at < chosen.at) chosen = { at, flag };
  }
  if (chosen === undefined) return undefined;
  const masked = maskArgvFlagValue(chosen.flag, arg.slice(chosen.at + 1));
  return masked === undefined ? undefined : `${arg.slice(0, chosen.at + 1)}${masked}`;
}

/**
 * The value-bearing short flag a shorthand CLUSTER ENDS in, if any — the form
 * that takes its value from the NEXT argv element.
 *
 * pflag's `parseSingleShortArg` falls through to `value = args[0]` when the
 * cluster runs out, so `-itde K=v` is `-i -t -d -e K=v` with the value in a
 * separate token. {@link maskAttachedShortFlag} bails on a flag letter in last
 * position (there is nothing attached to mask) and the two-token branch looked
 * `-itde` up as a whole flag and missed, so this spelling printed verbatim
 * until [#2623](https://github.com/go-to-k/cdkd/issues/2623)'s round-4 review
 * measured it. Pass 2 cannot rescue it either: its alternation needs a
 * whitespace-preceded `-e`.
 */
function trailingShortFlagOfCluster(arg: string): string | undefined {
  // No `length` guard: only `'-'` could reach one, and its last character is
  // `-`, which the loop already requires a flag's letter NOT to be. Removing
  // the redundant `< 3` from the sibling scan and reintroducing `< 2` here was
  // half-applying the same argument.
  if (arg.startsWith('--') || !arg.startsWith('-')) return undefined;
  const last = arg[arg.length - 1]!;
  for (const flag of ARGV_VALUE_BEARING_FLAGS) {
    if (flag.length === 2 && flag.startsWith('-') && flag[1] !== '-' && flag[1] === last) {
      return flag;
    }
  }
  return undefined;
}

/**
 * Structural, whitespace-delimited form of {@link ARGV_VALUE_BEARING_FLAGS}
 * for scanning a STRING that embeds a space-joined argv. Keyed on the FLAG's
 * position — never on the secret's value, so an unrelated literal that merely
 * coincides with a value is left alone.
 *
 * Covers the SEPARATED and JOINED spellings of
 * {@link ARGV_VALUE_BEARING_FLAGS} only. Two gaps, recorded rather than
 * implied. pflag's shorthand cluster is not modelled here in EITHER form —
 * attached (`-eKEY=VALUE` / `-itdeKEY=VALUE`) or separated (`-itde KEY=VALUE`,
 * which this pass's alternation cannot see because it needs a
 * whitespace-preceded `-e`) — this pass has no argv to resolve
 * the cluster against, and a bare `-e` prefix scan over free text would fire
 * on any word starting with `-e`; {@link redactDockerArgvValues} and passes 1
 * / 1b handle it wherever an argv IS available, which is every composer. And
 * {@link ARGV_PARAM_LIST_FLAGS}
 * is deliberately absent: this pass runs with NO argv to key on, and picking a
 * param name out of a free-text comma list is where a structural match stops
 * being structural. The param mask therefore rides passes 1 and 1b, both of
 * which derive from {@link redactDockerArgvValues} and so have the real argv —
 * i.e. a cache credential is masked in every text composed through a composer,
 * and not in a bare text handed to {@link redactDockerArgvInText} with no
 * `args`. Recorded rather than implied.
 *
 * DERIVED from the Set rather than re-spelled beside it
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623)). Until then this was
 * a hand-written literal listing the same four flags, i.e. the shape where
 * adding a flag to one spelling and not the other masks it on the argv pass
 * and leaks it on the text pass — a divergence no behavioural test of either
 * one can see. Deriving is stronger than fencing the pair: there is nothing
 * left to diverge.
 *
 * What each piece actually buys, since one of them was mis-credited in review:
 * the `(^|\s)` lead is what stops `-e` matching inside `--env` (there is no
 * `m` flag, so `^` is start-of-INPUT), NOT the alternation order — reordering
 * the branches leaves every test green. The order is kept as belt and braces
 * only, which is why the derivation sorts longest-first. The separator group
 * IS load-bearing: `\s+` is what stops `-easy` / `--environment` matching, and
 * the `=` alternative is the joined `--build-arg=KEY=VALUE` spelling
 * {@link maskArgvFlagValue} handles on the argv side (the group can never be
 * empty, so `--build-argument=X=y` still cannot match). The KEY is `[^\s=]*`
 * rather than `+` so an EMPTY key (`-e =value`) is masked too.
 *
 * The alternation is asserted NON-EMPTY at construction. An empty
 * {@link ARGV_VALUE_BEARING_FLAGS} would collapse it to `(^|\s)()(\s+|=)…`,
 * which masks EVERY whitespace-preceded `k=v` in any docker text — a
 * fail-OPEN that destroys the diagnostic wholesale, and the one failure mode
 * deriving from the Set introduced.
 */
const ARGV_VALUE_TOKEN_RE = ((): RegExp => {
  const alternation = [...ARGV_VALUE_BEARING_FLAGS]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|');
  // BOTH ways the alternation can carry an empty branch. `length === 0` catches
  // an empty Set; a Set holding `''` ALONGSIDE real flags yields
  // `-e|--env|...|` -- non-empty, no throw, and that trailing empty
  // alternative makes `(^|\s)()(\s+|=)...` match any whitespace-preceded
  // `k=v` while `maskArgvFlagValue('', v)` fires on every empty argv element.
  // Unreachable today (the Set is a literal), so this is an assertion that
  // stays true as the Set grows.
  // `.trim() === ''` rather than `.has('')`: a whitespace-only entry escapes a
  // bare empty-string check and still reaches the alternation as a branch that
  // matches nothing useful while `maskArgvFlagValue` compares against it.
  if (alternation.length === 0 || [...ARGV_VALUE_BEARING_FLAGS].some((f) => f.trim() === '')) {
    throw new Error(
      'ARGV_VALUE_BEARING_FLAGS is empty or holds an empty flag: the token scan would match every k=v'
    );
  }
  return new RegExp(`(^|\\s)(${alternation})(\\s+|=)([^\\s=]*)=\\S*`, 'g');
})();

/**
 * Return a copy of `args` with the VALUE of every
 * {@link ARGV_VALUE_BEARING_FLAGS} pair replaced by `***`, and the credential
 * PARAMS of every {@link ARGV_PARAM_LIST_FLAGS} value replaced likewise. The
 * KEY survives — "which variable" is the diagnostic, "what it was set to" is
 * the disclosure.
 *
 * All FOUR argv spellings are handled: `--flag VALUE` (two tokens, what every
 * argv this repo builds emits), `--flag=VALUE`, and pflag's shorthand cluster
 * in both its forms — attached (`-itdeKEY=VALUE`) and separated
 * (`-itde KEY=VALUE`, where the cluster ends in the flag letter and pflag
 * takes the NEXT token). The last three are handled because a user's own
 * build script may spell them
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623)).
 * A value-less `-e KEY` (the form {@link partitionSensitiveEnv} emits for a
 * sensitive key) has nothing to mask and is returned unchanged. `args` is
 * never mutated: the redacted copy is for DISPLAY only, never for `spawn`.
 */
export function redactDockerArgvValues(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]!;
    // Joined `--flag=VALUE` first. `> 0` here (not `>= 0`) because a leading
    // `=` means the element is not a flag at all — a bare `=value` positional
    // has no flag to key on, and treating `''` as one would consult the sets
    // for the empty string.
    const joinedEq = cur.indexOf('=');
    if (joinedEq > 0) {
      const maskedJoined = maskArgvFlagValue(
        cur.substring(0, joinedEq),
        cur.substring(joinedEq + 1)
      );
      if (maskedJoined !== undefined) {
        out.push(`${cur.substring(0, joinedEq)}=${maskedJoined}`);
        continue;
      }
    }
    // Attached short-flag form (`-eKEY=VALUE`), tried AFTER the joined form so
    // an exact long-flag match always wins over a two-character prefix.
    const maskedAttached = maskAttachedShortFlag(cur);
    if (maskedAttached !== undefined) {
      out.push(maskedAttached);
      continue;
    }
    const next = args[i + 1];
    if (typeof next === 'string') {
      // `cur` may be a whole flag (`-e`, `--build-arg`) OR a shorthand CLUSTER
      // ending in one (`-itde`), which pflag feeds from the next token.
      const pairFlag = ARGV_VALUE_BEARING_FLAGS.has(cur)
        ? cur
        : (trailingShortFlagOfCluster(cur) ?? cur);
      const maskedNext = maskArgvFlagValue(pairFlag, next);
      if (maskedNext !== undefined) {
        out.push(cur, maskedNext);
        i++;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Redact argv-borne values inside an error TEXT before it reaches the user.
 *
 * **Wrap EVERY `execFile`-derived docker failure text in this**, including one
 * whose argv carries no user data today — `execFile` puts the WHOLE command
 * line into `err.message` (`Command failed: <file> <args joined by ' '>\n<stderr>`,
 * measured on Node 24), so any argv that later gains a `-e` pair starts leaking
 * with no edit to the error site. That silent-gap shape is exactly what
 * [#2440](https://github.com/go-to-k/cdkd/issues/2440) reported: the debug log
 * one screen earlier redacted the same argv and the error path did not.
 *
 * Two passes, both structural (positional), never value-based — matching on a
 * secret's VALUE would also blank an unrelated string that happens to equal it:
 *
 * 1. **Exact command-line substitution** (only when `args` is given). The raw
 *    `args.join(' ')` is replaced by {@link redactDockerArgvValues}' rendering
 *    of the same array. This is the pass that matters, because it is the only
 *    one that can mask a value CONTAINING WHITESPACE (`-e CFG={"a": 1}`), which
 *    no token scan of a space-joined string can delimit.
 * 2. **Token scan** ({@link ARGV_VALUE_TOKEN_RE}) over the result. Catches an
 *    argv echoed in a shape pass 1 cannot see — a future Node message format,
 *    a docker stderr quoting the flag back, or a call site with no `args` to
 *    hand. Deliberately fail-loud rather than fail-open: a `-e X=y` occurring
 *    in unrelated stderr prose loses its value and keeps its key.
 *
 * Idempotent (`-e KEY=***` re-masks to itself), so double-wrapping is safe.
 *
 * **Call sites should use a composer** ({@link describeDockerFailure} and its
 * siblings) rather than this function: the composers take a REQUIRED `args`,
 * which is what makes the redaction impossible to forget. This is the
 * primitive they are built from, exported so the four passes can be tested
 * against Node's real message shapes directly — it has no other caller in
 * `src/`, and that is deliberate rather than an oversight.
 */
export function redactDockerArgvInText(text: string, args?: readonly string[]): string {
  let out = text;
  if (args && args.length > 0) {
    const maskedArgs = redactDockerArgvValues(args);
    const raw = args.join(' ');
    const masked = maskedArgs.join(' ');
    if (masked !== raw) out = out.split(raw).join(masked);
    // Pass 1b — per-TOKEN, for a message that quotes ONE argv element instead
    // of the joined command line. Node does exactly that when it refuses to
    // spawn at all: a NUL anywhere in an argv element rejects with a
    // TypeError and no joined command line for pass 1, no `-e ` prefix for
    // pass 2. MEASURED on Node 24.19.0 (`scripts`-free probe, this repo,
    // 2026-09-05):
    //
    //   The argument 'args[3]' must be a string without null bytes.
    //   Received 'K=abc\x00SUPERSECRET'
    //
    // Note the `\x00`: Node ESCAPES the control character, so the needle has
    // to be the escaped rendering as well as the raw one. The first cut
    // substituted only the raw token and left the value fully exposed — its
    // unit fixture had been built by interpolating the raw argv element, a
    // shape Node never emits, so the test passed for the wrong reason.
    //
    // The needle is the whole `KEY=VALUE` token cdkd itself built, not the
    // secret's value alone, so this stays a structural match: an unrelated
    // literal would have to reproduce the key too.
    for (let i = 0; i < args.length; i++) {
      const rawArg = args[i]!;
      const maskedArg = maskedArgs[i]!;
      if (maskedArg === rawArg) continue;
      if (!isSubstitutableToken(rawArg)) continue;
      out = out.split(rawArg).join(maskedArg);
      const escapedRaw = nodeQuotedRendering(rawArg);
      const escapedMasked = nodeQuotedRendering(maskedArg);
      if (escapedRaw !== undefined && escapedMasked !== undefined && escapedRaw !== rawArg) {
        out = out.split(escapedRaw).join(escapedMasked);
      }
    }
    out = repairSpawnRefusal(out, args, maskedArgs);
  }
  return out.replace(
    ARGV_VALUE_TOKEN_RE,
    (_match, lead: string, flag: string, gap: string, key: string) =>
      `${lead}${flag}${gap}${key}=${REDACTED_ARGV_VALUE}`
  );
}

/**
 * Shortest VALUE that pass 1b will substitute as a bare token.
 *
 * Pass 1b's needle is the whole `KEY=VALUE` element, and it is replaced
 * EVERYWHERE in the text — so a tiny needle is a liability rather than a
 * protection. The empty-key case makes that concrete: a non-sensitive
 * `{ Name: '', Value: '1' }` produces the two-character token `=1`, and
 * substituting that rewrites every `=1` in the message (`--cpus=1`,
 * `status=1`, a path segment). Below this floor the value is not worth
 * protecting by substring match, and passes 1 and 3 still cover it in the
 * message shapes that carry a `-e ` prefix or the joined command line.
 */
const MIN_SUBSTITUTABLE_VALUE_LENGTH = 4;

/** Is this `KEY=VALUE` element long enough to substitute as a bare token? */
function isSubstitutableToken(arg: string): boolean {
  const eqIdx = arg.indexOf('=');
  if (eqIdx < 0) return false;
  return arg.length - eqIdx - 1 >= MIN_SUBSTITUTABLE_VALUE_LENGTH;
}

/**
 * Render `value` the way Node renders an argv element it quotes back at you —
 * i.e. with the SAME function Node used, `util.inspect`, minus the quote
 * characters it chose.
 *
 * This started as a hand-rolled `\xNN` escaper and it was WRONG for 16 of the
 * first 128 code points. Measured against real `execFile` rejections on Node
 * 24.19.0 (this repo, 2026-09-05): hand-rolled matched 4 of 13 cases,
 * `inspect` matched 13 of 13.
 *
 *   input        Node emits          hand-rolled built
 *   LF           `K=a\nb\x00S`        `K=a\x0ab\x00S`   (Node uses a short escape)
 *   DEL          `K=a\x7Fb\x00S`      `K=a\x7fb\x00S`   (Node uses UPPERCASE hex)
 *   backslash    `K=a\\b\x00S`        `K=a\b\x00S`     (not escaped at all)
 *
 * Every miss printed the whole secret. The trigger for this path is a NUL in
 * a value — binary-ish data, which almost always carries a second control
 * byte or a backslash — so the table missed the REALISTIC case and hit only
 * the synthetic NUL-alone one its own fixture happened to use.
 *
 * `slice(1, -1)` is safe across the quote Node picks: `inspect` switches
 * between `'`, `"` and a backtick depending on content and escapes whichever
 * it chose; because this is the same call Node made, the rendering matches
 * whatever it picked (verified for a value containing a single quote, a
 * double quote, both, and a backtick).
 *
 * The general lesson, and why this is no longer a table: do not re-implement
 * another program's formatter — call it.
 */
function nodeQuotedRendering(value: string): string | undefined {
  const rendered = inspect(value);
  // `inspect` does not always produce a single quoted token: past
  // `breakLength` with a newline in the value it emits CONCATENATED CHUNKS
  // (`'a\n' +\n  'b'`), and past `maxStringLength` it appends
  // `... N more characters`. `slice(1, -1)` on either yields a needle that is
  // a substring of nothing — harmless, but it would make this function
  // quietly useless exactly where the value is long enough to matter. Say so
  // instead: `repairSpawnRefusal` handles those shapes by INDEX, needing no
  // needle at all.
  const quote = rendered[0];
  if (quote === undefined || !`'"\``.includes(quote)) return undefined;
  if (rendered.length < 2 || !rendered.endsWith(quote)) return undefined;
  const inner = rendered.slice(1, -1);
  return inner.includes(`${quote} +`) ? undefined : inner;
}

/**
 * Node's refusal to spawn, which QUOTES ONE argv element and names its INDEX:
 *
 *   The argument 'args[2]' must be a string without null bytes. Received '…'
 *
 * The one message shape where the index tells us exactly which of OUR args is
 * being echoed — so the clause can be REWRITTEN from cdkd's own copy of the
 * element rather than searched for. That matters because Node does not print
 * the element whole: it truncates near 200 characters and renders a
 * newline-bearing value as concatenated chunks, so no needle can match it.
 *
 * Global, and scanned to exhaustion rather than bailing on the first match.
 * Anchoring at `^` was an earlier attempt at forgery resistance and it was
 * WORSE: it made a refusal anywhere but position 0 unrepairable, which is a
 * LEAK, and a leak beats a truncated message every time. Pinning Node's
 * literal prefix keeps the forgery bar high without that trade.
 *
 * Pinning the wording has its own cost: if Node rewords the message the repair
 * silently stops firing. That is why `tests/unit/utils/docker-cmd.test.ts`
 * drives this path from a REAL rejection — a reword turns CI red instead of
 * turning the redaction off.
 */
const SPAWN_REFUSAL_RE = /The argument 'args\[(\d+)\]'[^']*?Received /g;

/**
 * The quoted element Node prints after `Received `.
 *
 * Three shapes, and the third is the one that matters. `inspect` renders a
 * newline-bearing value as chunks joined by ` +`, and Node then SLICES the
 * whole rendering at 128 characters and appends `...` — so the last chunk is
 * usually UNTERMINATED:
 *
 *   Received 'DB_URL=AAA…\n' +
 *     'hunter2SECRETCCC...
 *
 * A pattern that only accepts complete chunks stops after the second `'` and
 * leaves that tail in place. Measured on a real rejection: 272 of 288 probe
 * shapes leaked the secret verbatim, and the end-of-string version this
 * replaced did not — the bound was a regression, not a hardening, until the
 * trailing open chunk was admitted.
 *
 * The separator is Node's own (` +\n  `) with HORIZONTAL space only, and an
 * open chunk runs to end of LINE. Both are deliberate: `\s*\+\s*` and an
 * unbounded tail let a crafted value swallow the diagnostic lines that follow
 * the clause.
 */
const QUOTED_CHUNK = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\\n]|\\.)*\``;
/** An opening quote whose closing one was truncated away; bounded to its line. */
const OPEN_CHUNK = String.raw`['"\`](?:[^\\\n]|\\.)*`;
/** Node's chunk join: horizontal space, `+`, at most one newline, horizontal space. */
const CHUNK_SEPARATOR = String.raw`[^\S\n]*\+[^\S\n]*\n?[^\S\n]*`;
const QUOTED_ELEMENT_RE = new RegExp(
  `^(?:(?:${QUOTED_CHUNK})(?:${CHUNK_SEPARATOR}(?:${QUOTED_CHUNK}))*` +
    `(?:${CHUNK_SEPARATOR}(?:${OPEN_CHUNK}))?|(?:${OPEN_CHUNK}))`
);

/**
 * Replace the quoted argv element in a spawn-refusal message with the masked
 * rendering of the arg its OWN index names.
 *
 * Known cosmetic effect: the replacement prints the FULL key where Node had
 * truncated, so a pathologically long env-var NAME makes the message longer
 * than Node's ~200 characters. Keys are not secret, and the width is not worth
 * a second truncation rule with its own edge cases.
 */
function repairSpawnRefusal(
  text: string,
  args: readonly string[],
  maskedArgs: readonly string[]
): string {
  // A fresh regex per call: the shared one is global, so its `lastIndex`
  // would make a second call on the same text start midway.
  const scanner = new RegExp(SPAWN_REFUSAL_RE.source, 'g');
  let out = '';
  let cursor = 0;
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    // Every clause is repaired, not just the first. Returning after one left a
    // SECOND refusal in the same text leaking whole — and the loop was already
    // written to skip clauses it could not resolve, so stopping at the first
    // one it COULD was the odd case out.
    if (match.index < cursor) continue;
    const index = Number(match[1]);
    const rawArg = args[index];
    const maskedArg = maskedArgs[index];
    // A resolvable, NON value-bearing element is left alone: rewriting it
    // would replace the truncated prefix Node printed with the FULL value.
    if (rawArg !== undefined && maskedArg === rawArg) continue;
    const clauseEnd = match.index + match[0].length;
    const quoted = QUOTED_ELEMENT_RE.exec(text.slice(clauseEnd));
    // Node ALWAYS quotes after `Received `, so no match means this clause is
    // not Node's — a forged lookalike in an env KEY (which survives redaction
    // by design) reaches here with no NUL involved. Skipping it is what stops
    // the repair from becoming a diagnostic-destruction primitive: an earlier
    // version deleted to end-of-string here, and a crafted key erased both
    // real docker error lines.
    if (quoted === null) continue;
    // Fail CLOSED on an index that does not resolve (forged or out of range):
    // the clause matched Node's own wording, so something is quoting an argv
    // element and we cannot say which. Leaving it would keep it verbatim.
    const replacement = maskedArg === undefined ? `'${REDACTED_ARGV_VALUE}'` : inspect(maskedArg);
    out += text.slice(cursor, clauseEnd) + replacement;
    cursor = clauseEnd + quoted[0].length;
    scanner.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/**
 * Compose a user-visible description of a `child_process` rejection from a
 * docker call, ALREADY REDACTED against that call's own argv.
 *
 * Moved here from `src/local/invoke-agentcore-watch-loop.ts` in issue #2440's
 * review round 3, and the move is the point: `args` is REQUIRED, so a call
 * site cannot obtain the text without handing over the argv to redact it
 * with. That is a stronger guarantee than any text fence over the call sites
 * — which is what the round-2 reviewers demonstrated, by writing four
 * spellings of an unredacted read that the fence could not see.
 *
 * Shape differs from the `stderr || message` composition the other sites use,
 * and deliberately so: `err.stderr` is where docker writes its actionable
 * diagnostics, while `err.message` carries the exit status, so the AgentCore
 * soft-reload path APPENDS rather than prefers — without stderr the wrapped
 * error would only say "Command failed with exit code N".
 */
export function describeDockerExecFailure(error: unknown, args: readonly string[]): string {
  // Redacted on EVERY branch. Returning `String(error)` raw was a fail-open
  // the extraction introduced: the code this replaced wrapped the whole call,
  // so a non-`Error` rejection used to be redacted and briefly stopped being.
  const message = thrownMessageText(error) || safeStringify(error);
  const stderrText = capturedStreamText(error, 'stderr');
  return redactDockerArgvInText(stderrText ? `${message}\n${stderrText}` : message, args);
}

/**
 * A captured stream of a `child_process` rejection as trimmed text, or `''`.
 *
 * Takes `unknown`, not `Error`, and duck-types the field. Every composer here
 * is called from a `catch`, where the value is whatever was thrown — and the
 * shapes the call sites actually see are plain objects
 * (`{ stderr, message }`), `SpawnError`, and cross-realm `Error`s that
 * `instanceof` misses. An earlier revision narrowed this to `Error` and the
 * standard composer then wrapped non-Errors in a FRESH `Error`, which has no
 * `.stderr` at all — so the whole diagnostic silently became
 * `'[object Object]'` for exactly the shape most of the call sites throw.
 *
 * `execFile` hands back a string under the default encoding and a `Buffer`
 * under `encoding: 'buffer'`; `ArrayBuffer.isView` covers a plain
 * `Uint8Array` too.
 */
function capturedStreamText(error: unknown, field: 'stderr' | 'stdout'): string {
  // The WHOLE body is guarded, not just a stringify. A property READ throws
  // for a Proxy with a throwing `get` or a throwing getter, and `Buffer.from`
  // throws on a DETACHED ArrayBuffer — each would escape a `catch`, and two
  // call sites are in `cleanupEcsRun`, where that aborts the remaining volume
  // / network teardown and leaks real Docker resources. An earlier revision
  // wrapped only `String()` while its own doc claimed the guarantee this now
  // actually provides.
  try {
    const raw = (error as Record<string, unknown> | null | undefined)?.[field];
    if (typeof raw === 'string') return raw.trim();
    if (ArrayBuffer.isView(raw)) {
      return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8').trim();
    }
  } catch {
    /* a diagnostic is never worth aborting cleanup for */
  }
  return '';
}

/** A thrown value's `message` as text, or `''`. Duck-typed, for the same reason. */
function thrownMessageText(error: unknown): string {
  try {
    const raw = (error as Record<string, unknown> | null | undefined)?.['message'];
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * `String(value)` that cannot itself throw. A rejection with a null prototype
 * (or a `toString` that throws) would otherwise blow up INSIDE a `catch` — and
 * two of these call sites are in `cleanupEcsRun`, where an exception aborts
 * the remaining volume / network teardown and leaks real Docker resources.
 */
function safeStringify(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '[unstringifiable rejection]';
  }
}

/**
 * The STANDARD composer for a docker failure text: the captured stderr if
 * there is any, else the error's own message, else its string form —
 * ALREADY REDACTED against that call's argv.
 *
 * Use this at every site that wraps a docker `execFile` / spawn rejection.
 * `args` is REQUIRED, which is the whole point: a call site cannot obtain the
 * text without handing over the argv to redact it with, so the guarantee is
 * type-checked rather than fenced. Issue #2440's review spent three rounds
 * showing that a text fence over hand-composed sites is evadable — an
 * intermediate variable, an inline cast, a destructure, a computed member, a
 * concat — while this shape has nothing to evade.
 *
 * Prefer stderr over message because docker writes its actionable diagnostic
 * there, and `execFile`'s message is mostly the command line plus an exit
 * status. {@link describeDockerExecFailure} keeps BOTH, for a caller whose
 * wrapper text needs the status as well.
 */
export function describeDockerFailure(error: unknown, args: readonly string[]): string {
  return redactDockerArgvInText(
    capturedStreamText(error, 'stderr') || thrownMessageText(error) || safeStringify(error),
    args
  );
}

/**
 * Composer for a captured-output failure where the diagnostic may be on
 * STDOUT rather than stderr (`runDockerStreaming`'s non-zero-exit path, whose
 * `SpawnError` carries both). `fallback` is used when neither stream said
 * anything. Redacted, and `args` is required, for the same reason as
 * {@link describeDockerFailure}.
 */
export function describeDockerCapturedOutput(
  error: unknown,
  args: readonly string[],
  fallback: string
): string {
  return redactDockerArgvInText(
    capturedStreamText(error, 'stderr') || capturedStreamText(error, 'stdout') || fallback,
    args
  );
}
