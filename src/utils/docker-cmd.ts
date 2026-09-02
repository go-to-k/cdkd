import { spawn } from 'node:child_process';
import { getLogger, isStdoutReservedForPayload } from './logger.js';

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
 * Foreground (stdio-inherit) spawn — the inherit-mode counterpart to
 * {@link spawnStreaming}. Used by {@link runDockerForeground} for docker-CLI
 * subprocesses.
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
