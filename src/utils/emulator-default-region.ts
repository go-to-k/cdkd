/**
 * The region `--aws-emulator` copied into cdkd's own `AWS_REGION` from the
 * emulator run's `config` when the shell named none (go-to-k/cdkd#6270).
 *
 * The copy exists so every reader agrees on a region for an
 * environment-agnostic stack: the SDK chain reads the run's `config` file,
 * while some `cdkd local` paths read only the environment. But it is a
 * DEFAULT — the emulator's counterpart of the `region =` line in
 * `~/.aws/config` — not a region the user named. A chain that ranks the host
 * `AWS_REGION` above the stack's `env.region` or the state record's region
 * reads it through {@link namedEnvAwsRegion} and consults
 * {@link emulatorDefaultRegion} last, so a stack pinned to `us-west-2` and
 * deployed into the emulator's `us-west-2` also runs there under `cdkd local`,
 * as it does on real AWS with no `AWS_REGION` in the shell.
 *
 * A leaf module (no cdkd imports) so `src/local` can use it without reaching
 * into `src/cli`.
 */

let recorded: string | undefined;

/** Remember `region` as the emulator run's default that cdkd wrote into `AWS_REGION`. */
export function recordEmulatorDefaultRegion(region: string): void {
  recorded = region;
}

/**
 * The emulator run's default region while `AWS_REGION` still holds the copy,
 * else `undefined` (no emulator, the shell named a region, or a later
 * `--region` overwrote it).
 */
export function emulatorDefaultRegion(): string | undefined {
  return recorded !== undefined && process.env['AWS_REGION'] === recorded ? recorded : undefined;
}

/**
 * `process.env.AWS_REGION` unless it holds the emulator run's default — the
 * value of the variable as the user set it.
 */
export function namedEnvAwsRegion(): string | undefined {
  return emulatorDefaultRegion() === undefined ? process.env['AWS_REGION'] : undefined;
}

/** Test hook: forget the recorded default between cases. */
export function resetEmulatorDefaultRegionForTests(): void {
  recorded = undefined;
}
