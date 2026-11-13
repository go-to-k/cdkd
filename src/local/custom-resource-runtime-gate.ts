// cdk-local's accessor rather than `local-aws-wiring.ts`'s `localAwsEmulatorActive`
// (the same one-line read): that module pulls CLI modules into the provider's
// import graph, which the provider must not depend on.
import { AsyncLocalStorage } from 'node:async_hooks';

import { getActiveWorkloadAwsWiring } from 'cdk-local/internal';

import { synthesizedStacks } from '../synthesis/synthesized-stacks.js';

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

/**
 * Whether a custom resource event of this run goes to AWS Emulator's own
 * Lambda runtime because the command read no cloud assembly (`cdkd state
 * destroy`, `cdkd rollback`, a destroy without the app): the local runtime is
 * on, but has no function code to run. That runtime fails CDK's own provider
 * functions every time (`Cannot find module 'https'` / `'zlib'`, `_signal`),
 * so a re-run of the same command cannot do better (go-to-k/cdkd#6246,
 * go-to-k/cdkd#6247).
 */
export function customResourcesRunWithoutApp(): boolean {
  return localCustomResourceRuntimeActive() && synthesizedStacks().length === 0;
}

const failedWithoutApp = new Set<string>();

/**
 * Record that custom resource `logicalId`'s handler failed while
 * {@link customResourcesRunWithoutApp} held, so `cdkd rollback` does not
 * advise re-running itself (go-to-k/cdkd#6247). A no-op otherwise.
 */
export function noteCustomResourceFailure(logicalId: string): void {
  if (customResourcesRunWithoutApp()) failedWithoutApp.add(logicalId);
}

/** The custom resources {@link noteCustomResourceFailure} recorded, in order. */
export function customResourcesFailedWithoutApp(): readonly string[] {
  return [...failedWithoutApp];
}

/** Test seam: forget {@link noteCustomResourceFailure}'s records. */
export function resetCustomResourceFailuresForTest(): void {
  failedWithoutApp.clear();
}

const destroyingStack = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `stackName` as the stack whose custom resources are being
 * deleted. A destroy binds no naming scope (`getCurrentStackName()` is
 * `undefined` there), so without this a custom resource whose logical id and
 * provider code also exist in another stack of the app could be matched to
 * that other stack's template entry, whose environment differs
 * (go-to-k/cdkd#6213: the `cr.Provider` second hop resolves its targets from
 * it).
 */
export function withCustomResourceStack<T>(stackName: string, fn: () => T): T {
  return destroyingStack.run(stackName, fn);
}

/** The stack {@link withCustomResourceStack} bound, if any. */
export function customResourceStackName(): string | undefined {
  return destroyingStack.getStore();
}
