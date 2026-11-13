// cdk-local's accessor rather than `local-aws-wiring.ts`'s `localAwsEmulatorActive`
// (the same one-line read): that module pulls CLI modules into the provider's
// import graph, which the provider must not depend on.
import { getActiveWorkloadAwsWiring } from 'cdk-local/internal';

function localAwsEmulatorActive(): boolean {
  return getActiveWorkloadAwsWiring()?.mode === 'emulator';
}

/**
 * The gate of the `--aws-emulator` custom-resource runtime
 * (`custom-resource-runtime.ts`, go-to-k/cdkd#6206), kept apart from it so
 * the custom-resource provider reads the gate without loading the Docker
 * machinery: the runtime module is imported only once the gate is open.
 */

/** The flag that turns the local runtime off. */
export const NO_LOCAL_CUSTOM_RESOURCES_FLAG = '--no-local-custom-resources';

let enabled = true;
let commandPath: string | undefined;

/**
 * `--no-local-custom-resources` as commander parses it (`false`), and the
 * running command's path (`destroy`, `state destroy`, `rollback`, ...); set
 * from the `preAction` hook.
 */
export function setLocalCustomResourceRuntimeEnabled(value: boolean, command?: string): void {
  enabled = value;
  commandPath = command;
}

/** The running command's path, for a fallback warning's remedy. */
export function localCustomResourceCommand(): string | undefined {
  return commandPath;
}

/**
 * Whether a custom resource's function runs locally: `--aws-emulator` active
 * (full emulator mode) and not turned off. The ONE gate the provider reads; a
 * real AWS run never gets past it.
 */
export function localCustomResourceRuntimeActive(): boolean {
  return enabled && localAwsEmulatorActive();
}
