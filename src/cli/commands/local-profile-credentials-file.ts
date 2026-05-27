// Profile-aware credentials file mount for cdkd local Lambda containers.
//
// Background: PR #655 / #657 forward `--profile <p>`-resolved credentials to
// the Lambda container as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
// `AWS_SESSION_TOKEN` env vars. The SDK's default credential provider chain
// reads those env vars, so the common handler pattern
// (`new SecretsManagerClient({ region })`) works.
//
// What this module adds: handlers that explicitly call
// `fromIni({ profile: '<name>' })` bypass the env-var chain and look for
// `[<name>]` in `~/.aws/credentials` (or `AWS_SHARED_CREDENTIALS_FILE`).
// Inside the Lambda container neither file exists by default, so those
// handlers fail locally even when production AWS Lambda + IAM-role-baked-
// profile setups (Lambda Layer with credentials etc.) make them work.
//
// Fix: when `--profile <name>` is passed, ALSO write a temp credentials
// file with the resolved creds under `[<name>]`, bind-mount it into the
// container, and set `AWS_SHARED_CREDENTIALS_FILE=<containerPath>` +
// `AWS_PROFILE=<name>` env vars. Now both code paths work:
//
//   - Default chain: reads `AWS_ACCESS_KEY_ID` etc. (existing behavior)
//   - `fromIni({ profile: '<name>' })`: reads the mounted file via
//     `AWS_SHARED_CREDENTIALS_FILE`, finds `[<name>]`, returns the same
//     resolved creds
//
// The profile NAME inside the container matches what the user passed via
// `--profile` so handler code `fromIni({ profile: '<name>' })` matches
// without source changes.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * Path inside the container where the credentials file is mounted. Fixed
 * (not user-configurable) so the env-var injection is stable. `/cdkd-aws/`
 * is outside `/var/task` (the Lambda code mount) and outside `/root/`
 * (which the user's handler may bind-mount or modify), so there is no
 * collision risk with the user's payload.
 */
export const CONTAINER_AWS_CREDENTIALS_PATH = '/cdkd-aws/credentials';

/**
 * Resolved profile credentials file ready to mount into a Lambda container.
 *
 * `hostPath` is the absolute path on the host (`/tmp/cdkd-profile-creds-<rand>/credentials`).
 * `dispose` removes the host-side file + its parent tempdir; safe to call
 * multiple times (idempotent rm).
 */
export interface ProfileCredentialsFile {
  hostPath: string;
  containerPath: string;
  profileName: string;
  dispose: () => Promise<void>;
}

/**
 * Write a temporary AWS shared-credentials file containing the resolved
 * `--profile <name>` credentials, ready to bind-mount into a Lambda
 * container at {@link CONTAINER_AWS_CREDENTIALS_PATH}.
 *
 * The file content is the standard `[profile-name]` INI shape:
 *
 *   [<profileName>]
 *   aws_access_key_id = <accessKeyId>
 *   aws_secret_access_key = <secretAccessKey>
 *   aws_session_token = <sessionToken>   ← only when present
 *
 * `aws_session_token` is omitted when the resolved profile produced
 * long-lived (non-STS) credentials, mirroring the same logic
 * `applyProfileCredentialsOverlay` uses for env-var injection.
 *
 * Caller is responsible for invoking `dispose()` when the container pool
 * tears down (e.g., on `SIGINT` via `singleFlight` cleanup). Leaving the
 * file behind in `/tmp` is a security smell (temp credentials live on
 * disk).
 */
export async function writeProfileCredentialsFile(
  profileName: string,
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
): Promise<ProfileCredentialsFile> {
  // PR #670 code review finding #2: validate the profile name before
  // interpolating into the INI section header / AWS_PROFILE env var.
  // The injection surface is local-dev-only (the caller is the user's
  // own `--profile <name>` arg) so this is hardening, not security
  // boundary — but a value containing `]` would silently start a second
  // INI section, and a value containing newlines would break the
  // `-e AWS_PROFILE=...` docker-run env line. Reject at the helper
  // boundary so the caller never has to think about it.
  if (profileName === '') {
    throw new Error('writeProfileCredentialsFile: profile name must not be empty.');
  }
  if (/[\r\n[\]]/.test(profileName)) {
    throw new Error(
      `writeProfileCredentialsFile: profile name '${profileName}' contains a forbidden character ` +
        `(any of CR, LF, '[', ']' would corrupt the INI file or the docker -e env var).`
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'cdkd-profile-creds-'));
  const hostPath = path.join(dir, 'credentials');
  const lines: string[] = [
    `[${profileName}]`,
    `aws_access_key_id = ${creds.accessKeyId}`,
    `aws_secret_access_key = ${creds.secretAccessKey}`,
  ];
  if (creds.sessionToken) {
    lines.push(`aws_session_token = ${creds.sessionToken}`);
  }
  // Trailing newline for POSIX-text-file convention; some INI parsers
  // (including AWS SDK's older versions) reject files without a final
  // newline.
  await writeFile(hostPath, lines.join('\n') + '\n', { mode: 0o600 });
  return {
    hostPath,
    containerPath: CONTAINER_AWS_CREDENTIALS_PATH,
    profileName,
    dispose: async () => {
      // `recursive: true` removes the credentials file + its parent
      // tempdir in one shot. `force: true` makes the dispose idempotent
      // (multiple cleanup paths call this on SIGINT, single-flight
      // teardown, etc.).
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Build the docker-args fragment that mounts a profile credentials file
 * into the container + sets the env vars the SDK chain needs.
 *
 * Returns an array of `docker run` args that the caller splices into its
 * own argv builder. Empty array when `file` is `undefined` (the
 * `--profile` flag was not set).
 *
 * The `:ro` mount flag is load-bearing — the container has no business
 * writing to its credentials file; a writable mount would let a
 * compromised handler tamper with the host-side temp file.
 */
export function buildProfileCredentialsDockerArgs(
  file: ProfileCredentialsFile | undefined
): string[] {
  if (!file) return [];
  return [
    '-v',
    `${file.hostPath}:${file.containerPath}:ro`,
    '-e',
    `AWS_SHARED_CREDENTIALS_FILE=${file.containerPath}`,
    '-e',
    `AWS_PROFILE=${file.profileName}`,
  ];
}
