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
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  /**
   * Called with `hostPath` the INSTANT the tmpdir exists, before any byte is
   * written to it (go-to-k/cdkd#3435 review).
   *
   * It exists because the RETURN VALUE is the wrong moment for a caller that
   * has to survive a signal. Between `mkdtemp` and this function returning sits
   * an `await writeFile`, a real I/O boundary — and a double-`^C` delivered
   * inside it force-exits with the caller's `profileCredsFile` still
   * `undefined`, so the stranded-credentials notice names nothing while a
   * mode-0600 directory (possibly already holding the file) is on disk. That is
   * the very leak go-to-k/cdkd#3410 closed, reachable through its own fix's
   * blind spot; two reviewers found the comment asserting it could not happen.
   *
   * Fired BEFORE the write rather than after, deliberately: the hazard is the
   * DIRECTORY, which exists from `mkdtemp` onward whatever the write does. An
   * exception here would strand the dir with no cleanup, so the caller's
   * handler must only assign.
   */
  opts?: {
    onDirCreated?: (hostPath: string) => void;
    /**
     * Called when a FAILED write has removed the directory `onDirCreated` just
     * announced, so a caller holding that path can drop it rather than name a
     * path that no longer exists.
     *
     * NOT called when the cleanup `rm` itself failed: the directory is then
     * still on disk, possibly holding a partial credentials file, and a caller
     * that dropped the path would print nothing on a force-exit.
     */
    onDirRemoved?: (hostPath: string) => void;
  }
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
  opts?.onDirCreated?.(hostPath);
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
    // GATED on the removal actually happening (go-to-k/cdkd#3435 review round
    // 3). `rm` is best-effort so a failing one cannot replace the real cause --
    // but an `rm` that REJECTED leaves the directory on disk, possibly holding
    // a partially written mode-0600 `credentials`, and retracting the path
    // there would silence the very notice go-to-k/cdkd#3410 exists for.
    let removed = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {
      removed = false;
    });
    // RETRACT the path the hook published (go-to-k/cdkd#3435 review round 2).
    // The cleanup above means the directory is GONE, so a caller that kept the
    // path from `onDirCreated` would later tell an operator to delete something
    // that does not exist -- reachable and persistent, because
    // `local-start-api.ts`'s `reloadAllServers` catches a failed reload and
    // keeps serving. Retracting is the other half of publishing early: the hook
    // says "this directory exists", and it has to be able to say it no longer
    // does. Best-effort like the `rm`, so a throwing handler cannot replace the
    // real cause.
    if (removed) {
      try {
        opts?.onDirRemoved?.(hostPath);
      } catch {
        /* the original error is what the caller needs */
      }
    }
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
 * The sentence an exit path owes when it leaves this file on disk
 * (issue [#3410](https://github.com/go-to-k/cdkd/issues/3410)).
 *
 * Takes the PATH rather than the `ProfileCredentialsFile` (go-to-k/cdkd#3435
 * review): a caller on a signal path may hold the path from
 * `writeProfileCredentialsFile`'s `onDirCreated` hook while the file object
 * itself is still an unresolved promise, and the sentence is the same either
 * way. `undefined` renders nothing, so a run that passed no `--profile` is not
 * told about a path that does not exist.
 *
 * ## Why the remedy is to NAME the path rather than to remove it
 *
 * Every exit path that can reach this notice leaves the CONTAINERS running with
 * this file bind-mounted, and that is the premise `local-run-task.ts`'s detach
 * arm already records: the file cannot be disposed there precisely because the
 * containers outlive the process. A force-exit is the same situation reached a
 * different way -- "container cleanup skipped" is what it announces -- so the
 * synchronous `rmSync` that suggests itself would be removing a mount the
 * surviving containers are still reading, on the strength of a premise this
 * repo has not measured either way. What the file is instead is INVISIBLE: it
 * is mode-0600 in `$TMPDIR`, nothing reports it, and one accumulates per
 * force-quit. Naming it is what the operator can act on, and it is what the
 * detach arm already does.
 *
 * ONE BUILDER FOR ALL THREE SITES, not three sentences that agree today. They
 * say the same thing for the same reason -- the two force-exit arms
 * (`local-run-task.ts`, `local-start-api.ts`) and the detach notice -- and a
 * wording that drifts between them is how an operator learns to read one shape
 * and miss another. Each CALLER supplies its own cause clause; this supplies
 * the remedy.
 *
 * `displayIdent` for the same reason the detach arm gives: the path is cdkd's
 * own `mkdtemp` output, so sanitization is the identity on it, but the rule
 * belongs to the SURFACE rather than to the value.
 */
export function strandedProfileCredentialsNotice(hostPath: string | undefined): string | undefined {
  if (hostPath === undefined) return undefined;
  return (
    `The AWS credentials file mounted into the containers is NOT removed: ` +
    `delete ${displayIdent(hostPath)} once you tear them down.`
  );
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
