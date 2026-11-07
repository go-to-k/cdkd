import { displayIdent, safeMsg } from '../display-safe.js';
import { getLogger } from '../logger.js';
import { defineOwnKey } from '../own-keys.js';
import { isDockerClientEnvKey, isMalformedEnvKey } from './client-env-keys.js';
import { getDockerCmd } from './spawn.js';

/**
 * Splitting a container's env so secret VALUES stay off the docker argv, and
 * the finch-on-a-VM refusal and warning. Part of the `docker-cmd.ts` split
 * (go-to-k/cdkd#5835); import from `../docker-cmd.js`, not from here.
 */

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
 * On win32 (`options.platform`, injectable for tests; #2190) a sensitive key
 * that {@link Win32EnvNames} calls AMBIGUOUS is dropped the same way, with
 * its own warning, and the surviving keys that differ only by letter case are
 * warned about. Both warnings are prefixed with `options.subject` when given.
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
  sensitiveKeys: ReadonlySet<string>,
  options: { platform?: NodeJS.Platform; subject?: string } = {}
): { flags: string[]; sensitiveEnv: Record<string, string>; collisions: string[] } {
  const platform = options.platform ?? process.platform;
  const flags: string[] = [];
  const sensitiveEnv: Record<string, string> = {};
  const collisions: string[] = [];
  const names = platform === 'win32' ? new Win32EnvNames(Object.keys(process.env)) : undefined;
  const ambiguous: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!sensitiveKeys.has(k)) {
      flags.push('-e', `${k}=${v}`);
      continue;
    }
    if (isMalformedEnvKey(k) || isDockerClientEnvKey(k)) {
      collisions.push(k);
      continue;
    }
    if (names) {
      if (names.lookup(k).ambiguous) {
        ambiguous.push(k);
        continue;
      }
      names.replace(k);
    }
    flags.push('-e', k);
    // Own-key define (issue #3515): a secret NAMED `__proto__` assigned onto
    // this `{}` literal ran Object.prototype's setter, so its value vanished
    // from the spawn env while the value-less `-e __proto__` stayed on the
    // argv. The value still never reaches the argv either way.
    defineOwnKey(sensitiveEnv, k, v);
  }
  if (ambiguous.length > 0) {
    getLogger().warn(
      (options.subject === undefined ? '' : safeMsg`${options.subject}: `) +
        safeMsg`Sensitive env var(s) ${ambiguous.map((k) => displayIdent(k)).join(', ')} ` +
        `were NOT passed to the container. On Windows each matches another variable's name ` +
        `(in your environment or another secret) only through a letter-case difference outside ` +
        `A-Z, which cdkd does not treat as the same variable. Rename the secret if the ` +
        `container needs it.`
    );
  }
  if (names) warnCaseVariantSensitiveKeys(Object.keys(sensitiveEnv), options.subject);
  return { flags, sensitiveEnv, collisions };
}

/**
 * Warn about sensitive keys that differ only by letter case (#2190). A Windows
 * environment holds ONE variable for all of them, so each value-less `-e KEY`
 * the client resolves reads the same value, the one
 * {@link dockerSpawnEnvWithSensitive} writes last. It runs inside
 * {@link partitionSensitiveEnv}, which every caller reaches before any
 * `docker run`, so an earlier container's failed start cannot suppress a later
 * container's warning. It reads only the keys that SURVIVED partitioning: a
 * dropped key reaches neither the argv nor the spawn env, so it collides with
 * nothing.
 */
function warnCaseVariantSensitiveKeys(keys: readonly string[], subject: string | undefined): void {
  const byUpper = new Map<string, string[]>();
  for (const k of keys) {
    const upper = asciiUpper(k);
    const group = byUpper.get(upper);
    if (group) group.push(k);
    else byUpper.set(upper, [k]);
  }
  for (const group of byUpper.values()) {
    if (group.length < 2) continue;
    getLogger().warn(
      (subject === undefined ? '' : safeMsg`${subject}: `) +
        safeMsg`Sensitive env vars ${group.map((k) => displayIdent(k)).join(', ')} differ only by letter case. ` +
        safeMsg`Windows treats them as one variable, so the container receives the value of ` +
        safeMsg`${displayIdent(group[group.length - 1]!)} under every one of these names. ` +
        `Rename them to distinct names if the container needs each value.`
    );
  }
}

/** Upper-cases `a`-`z` only: the letter-case relation cdkd treats as one variable. */
function asciiUpper(name: string): string {
  return name.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The names of a win32 spawn env, grouped the way Node's `spawn` dedups them
 * there: by `toUpperCase`, keeping only the first of a group in sort order
 * (#2190). Windows then compares names with its own one-to-one table, which
 * agrees with `toUpperCase` on `a`-`z` and not on every other letter (`ß`
 * becomes `SS`, `ı` becomes `I`). So a name is an ALIAS of a group member
 * when the two differ only in `a`-`z` case: cdkd removes the other spelling
 * and the secret wins. It is AMBIGUOUS when it shares a group with a name it
 * differs from in any other way (`AWS_ACCEß_KEY_ID` next to the operator's
 * `AWS_ACCESS_KEY_ID`): deleting the other name would strip it, and keeping
 * both leaves Node's sort order to drop one, so the secret is refused instead.
 * `isDockerClientEnvKey` keeps the full fold, where matching more names only
 * refuses more.
 */
class Win32EnvNames {
  private readonly groups = new Map<string, string[]>();

  constructor(names: Iterable<string>) {
    for (const name of names) {
      const key = name.toUpperCase();
      const group = this.groups.get(key);
      if (group) group.push(name);
      else this.groups.set(key, [name]);
    }
  }

  /** The other spellings of `name`, and whether any differs beyond `a`-`z` case. */
  lookup(name: string): { aliases: string[]; ambiguous: boolean } {
    const others = (this.groups.get(name.toUpperCase()) ?? []).filter((n) => n !== name);
    const folded = asciiUpper(name);
    return { aliases: others, ambiguous: others.some((n) => asciiUpper(n) !== folded) };
  }

  /** Record that `name` is now the only spelling of its group. */
  replace(name: string): void {
    this.groups.set(name.toUpperCase(), [name]);
  }
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
  sensitiveEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform
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
  // On win32 a key differing only by letter case names the SAME variable
  // (#2190). Left in, both spellings reach `spawn`, and Node keeps whichever
  // sorts first (measured: the host's), so before a sensitive key is written
  // every other spelling of it is removed: the host's alias, and an earlier
  // sensitive key (`partitionSensitiveEnv` warns about that pair). The secret
  // then replaces the host's variable exactly as the same spelling does on
  // every platform. A removed alias is never a docker-client var, since the
  // denylist check above is itself case-insensitive and the Windows system
  // vars (`ComSpec`, `SystemRoot`, ...) are on it. An AMBIGUOUS key
  // (`Win32EnvNames`) is skipped, as `partitionSensitiveEnv` refuses it. The
  // `windows-env-precedence` CI job runs this arm on a real Windows host. POSIX
  // env is case-sensitive, so elsewhere both spellings are distinct variables
  // and are left alone.
  const env: NodeJS.ProcessEnv = { ...process.env };
  const names = platform === 'win32' ? new Win32EnvNames(Object.keys(env)) : undefined;
  for (const [k, v] of Object.entries(sensitiveEnv)) {
    if (isMalformedEnvKey(k) || isDockerClientEnvKey(k)) continue;
    if (names) {
      const { aliases, ambiguous } = names.lookup(k);
      if (ambiguous) continue;
      for (const alias of aliases) delete env[alias];
      names.replace(k);
    }
    // Own-key define for the reason given in `partitionSensitiveEnv` (issue
    // #3515). Node's spawn serialises an own `__proto__` env key like any other.
    defineOwnKey(env as Record<string, unknown>, k, v);
  }
  return env;
}

/**
 * The env var that accepts, while it is set, that a container client puts secret
 * VALUES on a process command line ({@link finchSecretArgvRefusal}). Only `1`
 * or `true` (any case) opts in.
 */
export const ALLOW_SECRETS_ON_ARGV_ENV = 'CDKD_ALLOW_SECRETS_ON_ARGV';

/**
 * Is the container client finch running its Lima VM (macOS / Windows)? There
 * the value-less `-e KEY` that {@link partitionSensitiveEnv} emits does NOT
 * keep the value off argv (#3600): finch's `handleEnv` resolves each bare
 * `KEY` against its own environment and re-emits `-e KEY=<value>` on the argv
 * of the `limactl shell finch sudo -E nerdctl ...` child, and `--env-file` is
 * read on the host and re-emitted the same way (runfinch/finch
 * `cmd/finch/nerdctl_remote.go`, `handleEnv` / `handleEnvFile` and the
 * `envArgs` rebuild). Its `passedEnvs` list also puts `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` from its environment on that
 * argv for every command. finch on Linux passes the argv to nerdctl unchanged
 * and is NOT matched.
 *
 * Detection is by the BASENAME of the resolved binary (`finch`, `finch.exe`,
 * any case): a wrapper script or a symlink under another name is not
 * recognised, and neither is Lima's own `nerdctl.lima`.
 */
export function isFinchVmClient(
  cmd: string = getDockerCmd(),
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'darwin' && platform !== 'win32') return false;
  const base = (cmd.split(/[\\/]/).pop() ?? '').toLowerCase();
  return base === 'finch' || base === 'finch.exe';
}

function secretsOnArgvAllowed(): boolean {
  const v = process.env[ALLOW_SECRETS_ON_ARGV_ENV];
  return v !== undefined && ['1', 'true'].includes(v.trim().toLowerCase());
}

/**
 * The refusal text when template-sourced secrets (ECS `Secrets`, decrypted
 * SecureString parameters) would be forwarded under {@link isFinchVmClient},
 * or `undefined` when they may be forwarded: another client, no such secret,
 * or {@link ALLOW_SECRETS_ON_ARGV_ENV} set. The caller throws it in its own
 * error class BEFORE any `docker run`. The AWS credential set is not refused
 * here (it is warned about by {@link warnFinchArgvExposure}) so finch stays
 * usable for containers that need AWS access. Forwarding them IS what puts
 * them on that argv — notably `--assume-task-role` / `--assume-role` session
 * credentials and `--profile` / SSO-resolved ones, which are not in cdkd's
 * own environment
 * (finch itself forwards that environment's credentials, plus on Windows with
 * `ecr-login` what `aws configure export-credentials` resolves from it).
 * `subject` is caller-rendered context (e.g. the container name) and is not
 * sanitized here.
 */
export function finchSecretArgvRefusal(
  secretNames: readonly string[],
  subject: string
): string | undefined {
  if (secretNames.length === 0 || !isFinchVmClient() || secretsOnArgvAllowed()) return undefined;
  const names = [...new Set(secretNames)];
  return (
    `${subject}: refusing to forward secret(s) ${names.map((k) => displayIdent(k)).join(', ')} ` +
    `under CDK_DOCKER=finch on macOS / Windows. finch turns each value-less '-e KEY' into ` +
    `'-e KEY=<value>' on the command line of the limactl process it starts, where other local ` +
    `processes can read the plaintext. Use a container client that keeps the value off the command ` +
    `line (Docker, podman, nerdctl, or finch on Linux), or set ${ALLOW_SECRETS_ON_ARGV_ENV}=1 to ` +
    `accept that exposure while it stays set.`
  );
}

/** Key sets already warned about by {@link warnFinchArgvExposure} in this process. */
const finchArgvWarned = new Set<string>();

/** Test-only: forget which key sets {@link warnFinchArgvExposure} warned about. */
export function resetFinchArgvWarningsForTest(): void {
  finchArgvWarned.clear();
}

/**
 * Warn, once per process per distinct key set, that under
 * {@link isFinchVmClient} the values of `keys` (the sensitive env about to be
 * forwarded as value-less `-e KEY`) reach the `limactl` command line. Names
 * only, never a value.
 */
export function warnFinchArgvExposure(keys: readonly string[]): void {
  if (keys.length === 0 || !isFinchVmClient()) return;
  const names = [...new Set(keys)].sort();
  const latch = JSON.stringify(names);
  if (finchArgvWarned.has(latch)) return;
  finchArgvWarned.add(latch);
  getLogger().warn(
    `CDK_DOCKER=finch on macOS / Windows puts the values of ${names.map((k) => displayIdent(k)).join(', ')} ` +
      `on the command line of the limactl process it starts (finch turns a value-less '-e KEY' into ` +
      `'-e KEY=<value>'), where other local processes can read them. Docker, podman, nerdctl, or finch ` +
      `on Linux keep them off the command line.`
  );
}
