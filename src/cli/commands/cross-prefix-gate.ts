/**
 * The deploy half of go-to-k/cdkd#4705 (`src/state/cross-prefix-stack-scan.ts`):
 * refuse a stack's FIRST deploy under this state prefix when the bucket
 * already records it under another prefix, before any provider call.
 *
 * Runs as part of the engine's `onCurrentStateLoaded` gate (post-lock, after
 * the state read, before parsing or provisioning). The scan itself was started
 * by the CLI as soon as the deploy set was known, so a first deploy waits on
 * it only if it is still running; a deploy that loaded a record never awaits
 * it at all.
 */

import type { StackState } from '../../types/state.js';
import { getLogger } from '../../utils/logger.js';
import {
  applyCrossPrefixScan,
  type CrossPrefixScanResult,
} from '../../state/cross-prefix-stack-scan.js';

/**
 * Build the gate for one top-level stack. It is a no-op for any other stack
 * name (nested children inherit the parent engine's options), for a loaded
 * record, and when no scan was started.
 */
export function createCrossPrefixDeployGate(opts: {
  stackName: string;
  region: string;
  bucket: string;
  scan: Promise<CrossPrefixScanResult> | undefined;
}): (stackName: string, state: StackState | undefined) => Promise<void> {
  return async (gateStackName, state) => {
    if (gateStackName !== opts.stackName) return;
    if (state !== undefined) return;
    if (opts.scan === undefined) return;
    applyCrossPrefixScan(
      await opts.scan,
      { stackName: opts.stackName, region: opts.region, bucket: opts.bucket },
      'deploy',
      (message) => getLogger().warn(message)
    );
  };
}
