import type { StackInfo } from './assembly-reader.js';

/**
 * The stacks of the cloud assembly this process last synthesized (or read
 * with `--app <cdk.out>`), for a consumer that runs below the command layer
 * and needs a function's local code: the custom-resource provider runs the
 * function a `ServiceToken` points at from the assembly under `--aws-emulator`
 * (go-to-k/cdkd#6206). The objects are the ones `Synthesizer.synthesize`
 * returned, so a deferred macro expansion that rewrites their templates in
 * place is seen here too.
 */
let lastSynthesizedStacks: readonly StackInfo[] = [];

/** Record the stacks `Synthesizer.synthesize` is about to return. */
export function rememberSynthesizedStacks(stacks: readonly StackInfo[]): void {
  lastSynthesizedStacks = stacks;
}

/** The stacks of the last synthesis in this process; empty when none ran. */
export function synthesizedStacks(): readonly StackInfo[] {
  return lastSynthesizedStacks;
}
