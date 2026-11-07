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
 *
 * This file is the public entry point: every importer keeps importing from
 * `docker-cmd.js`. The code lives in the `docker-cmd/` companion directory
 * (go-to-k/cdkd#5835):
 *
 * - `spawn.ts` - binary resolution, streaming / foreground spawn, and the
 *   `docker login` stderr formatter.
 * - `client-env-keys.ts` - the env vars the container CLIENT reads, and the
 *   malformed-key predicate.
 * - `sensitive-env.ts` - splitting a container's env so secret values stay
 *   off argv, and the finch-on-a-VM refusal and warning.
 * - `argv-redaction.ts` - masking argv VALUES element by element.
 * - `argv-in-text.ts` - masking argv values inside an error TEXT.
 * - `failure.ts` - the composers every docker failure text and `cause`
 *   goes through.
 */
export type {
  SpawnResult,
  SpawnError,
  RunDockerOptions,
  ForegroundOptions,
} from './docker-cmd/spawn.js';
export {
  getDockerCmd,
  runDockerStreaming,
  spawnStreaming,
  runDockerForeground,
  spawnForeground,
  formatDockerLoginError,
} from './docker-cmd/spawn.js';
export {
  DOCKER_CLIENT_ENV_KEYS,
  DOCKER_CLIENT_ENV_PREFIXES,
  DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS,
  isDockerClientEnvKey,
  isMalformedEnvKey,
} from './docker-cmd/client-env-keys.js';
export {
  partitionSensitiveEnv,
  dockerSpawnEnvWithSensitive,
  ALLOW_SECRETS_ON_ARGV_ENV,
  isFinchVmClient,
  finchSecretArgvRefusal,
  resetFinchArgvWarningsForTest,
  warnFinchArgvExposure,
} from './docker-cmd/sensitive-env.js';
export { redactDockerArgvValues } from './docker-cmd/argv-redaction.js';
export { redactDockerArgvInText } from './docker-cmd/argv-in-text.js';
export {
  describeDockerExecFailure,
  describeDockerFailure,
  redactedDockerCause,
  redactedCause,
  describeDockerCapturedOutput,
} from './docker-cmd/failure.js';
