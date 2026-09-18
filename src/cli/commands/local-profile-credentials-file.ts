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

import { displayIdent } from '../../utils/display-safe.js';

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
  // TWO DIFFERENT QUESTIONS, and the fix for issue
  // [#3377](https://github.com/go-to-k/cdkd/issues/3377) is the second of them.
  //
  // The predicate below asks what corrupts the ARTIFACT: `[` / `]` would open a
  // second INI section in the file written a few lines down, and CR / LF would
  // break the `-e AWS_PROFILE=<name>` docker-run env line `buildProfileCredentialsDockerArgs`
  // emits. That is a write-side check, and it stays exactly as it was.
  //
  // `displayIdent` asks what corrupts the TERMINAL the refusal is printed on:
  // ESC / the C1 range / the Trojan-Source bidi overrides, none of which this
  // predicate rejects and none of which it should -- an ESC in a profile name
  // does not corrupt the INI file at all. The two sets barely overlap: CR and
  // LF are in BOTH, `[` and `]` are terminal-harmless, and everything ELSE
  // `displayIdent` strips is file-harmless. ("Else" is load-bearing -- CR and
  // LF are exactly the characters the first clause just put in both sets, so
  // without it the sentence contradicts itself; go-to-k/cdkd#3390 review.) So
  // the refusal has to sanitize the name IT IS REFUSING on its own account,
  // which is what it did not do -- interpolating raw bytes that reached here
  // precisely because they are unusual.
  //
  // One recorded RESIDUAL of this predicate, out of scope and non-silent: NUL
  // is not rejected, so a profile name carrying one reaches the INI file and
  // the `-e AWS_PROFILE=<name>` argv -- where Node itself refuses it, so the
  // spawn FAILS rather than corrupting anything.
  //
  // `displayIdent` rather than `displaySafe`: a profile name is an untrusted
  // IDENTIFIER, so it takes the ASCII allowlist, the length cap, and the
  // JSON-quoted BOUNDARY for a value outside the plain-identifier set. It is
  // NOT `isPasteableIdent` -- that is the check for a value going into a
  // command cdkd tells an operator to RUN, and this sentence is a message.
  // `local-start-api.ts`'s `resolveProfileCredentials` is the site that carries
  // both, because it prints both shapes.
  //
  // The hand-written `'...'` quotes are GONE rather than kept around the
  // rendering. `displayIdent` quotes conditionally -- bare for a plain
  // identifier, JSON-quoted for anything else -- and every value that reaches
  // this throw is non-plain by construction (CR / LF sanitize to a space and
  // so read as ALTERED; `[` and `]` are outside `PLAIN_IDENT`), so the value
  // always arrives already quoted and a second pair would only be ambiguous
  // about which quote the name ends at.
  if (/[\r\n[\]]/.test(profileName)) {
    throw new Error(
      `writeProfileCredentialsFile: profile name ${displayIdent(profileName)} contains a ` +
        `forbidden character (any of CR, LF, '[', ']' would corrupt the INI file or the ` +
        `docker -e env var).`
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'cdkd-profile-creds-'));
  const hostPath = path.join(dir, 'credentials');
  // cdkd-local-env-identity: this writer chooses NO identity — it renders the
  // credential set its caller hands it, so the verdict belongs at the four call
  // sites and each carries one. It is a site anyway because the file below is
  // bind-mounted into the container: whatever reaches here reaches the user's
  // code, through a LOWERCASE INI key that neither fence saw until issue #3250
  // item 7. A future call site passing the raw `process.env` triple — which
  // `--role-arn` has already overwritten — now fails this fence instead of
  // being silent.
  // cdkd-profile-display: FILE BYTES, not a terminal. This is the INI section
  // header the container's `fromIni({ profile: '<name>' })` matches on, so it
  // must be the name the user passed, byte for byte -- a `displayIdent` pass
  // here would make a legitimate non-ASCII profile unfindable inside the
  // container. What corrupts THIS artifact is `[` / `]` / CR / LF, and the
  // predicate above rejects all four before reaching this line (issue
  // go-to-k/cdkd#3377 draws the line between the two questions).
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
  //
  // The write is wrapped because a FAILING one strands the tempdir: the caller
  // only ever receives a `dispose` through the return below, so an ENOSPC or
  // EACCES here leaves a `/tmp/cdkd-profile-creds-*` behind that nothing will
  // ever remove (go-to-k/cdkd#3390 review). The dir is empty in that case — no
  // credentials landed — so this is hygiene rather than a disclosure fix, but
  // it is the one exit from this function that had no cleanup at all. The
  // original error is re-thrown unchanged; the cleanup is best-effort so a
  // failing `rm` cannot replace the real cause with its own.
  try {
    await writeFile(hostPath, lines.join('\n') + '\n', { mode: 0o600 });
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
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
    // cdkd-profile-display: a `docker run` ARGUMENT, not a terminal line. It
    // must agree byte-for-byte with the INI section header written above, or
    // the SDK inside the container looks up a profile the file does not carry.
    // The CR / LF half of `writeProfileCredentialsFile`'s validator exists for
    // exactly this argument. Should this value ever be RENDERED in a failure
    // message, that render is its own site and takes `displayIdent` --
    // `docker-argv-redaction.ts` owns the display side of a docker argv.
    `AWS_PROFILE=${file.profileName}`,
  ];
}
