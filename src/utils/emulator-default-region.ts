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
 * The record lives in cdk-local (its "ambient default region",
 * go-to-k/cdk-local#964), so the chains cdkd owns (`local invoke`,
 * `start-api`, `run-task`, `invoke-agentcore`) and the ones cdk-local owns
 * (`start-service`, `start-alb`, `start-web-function`, `start-microvm`,
 * `start-cloudfront`, `start-agentcore`) read ONE value: recording it here is
 * the handover. This module only names it in cdkd's vocabulary.
 */

import {
  ambientDefaultRegion,
  namedEnvAwsRegion,
  setAmbientDefaultRegion,
} from 'cdk-local/internal';

export { namedEnvAwsRegion };

/** Remember `region` as the emulator run's default that cdkd wrote into `AWS_REGION`. */
export function recordEmulatorDefaultRegion(region: string): void {
  setAmbientDefaultRegion(region);
}

/**
 * The emulator run's default region while `AWS_REGION` still holds the copy,
 * else `undefined` (no emulator, the shell named a region, or a later
 * `--region` overwrote it).
 */
export function emulatorDefaultRegion(): string | undefined {
  return ambientDefaultRegion();
}

/** Test hook: forget the recorded default between cases. */
export function resetEmulatorDefaultRegionForTests(): void {
  setAmbientDefaultRegion(undefined);
}
