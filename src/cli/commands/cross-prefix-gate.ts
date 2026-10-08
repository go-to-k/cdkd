/**
 * The deploy half of go-to-k/cdkd#4705 (`src/state/cross-prefix-stack-scan.ts`).
 *
 * - {@link createCrossPrefixDeployGate}: refuse a stack's FIRST deploy under
 *   this state prefix when the bucket already records it under another prefix.
 *   Runs in the engine's `onCurrentStateLoaded` gate (post-lock, after the
 *   state read, before parsing or provisioning). The scan was started by the
 *   CLI once synth had finished, so a first deploy waits on it only if it
 *   outlasts the pre-lock phase; a deploy that loaded a record never awaits it.
 * - {@link createCrossPrefixDestructiveGate}: refuse a deploy whose plan
 *   deletes or replaces, when another prefix records the stack -- the pair
 *   that predates the first-deploy check. Runs only on such a plan, through the
 *   engine's `onDestructivePlan`, so an everyday deploy pays nothing.
 */

import type { DestructiveChange } from '../../analyzer/destructive-changes.js';
import type { LockRecoveryContext } from '../../state/lock-contention-message.js';
import type { ForeignHolding } from '../../deployment/rollback-executor/journaled-orphans.js';
import { safeMsg } from '../../utils/display-safe.js';
import type { StackState } from '../../types/state.js';
import { getLogger } from '../../utils/logger.js';
import {
  applyCrossPrefixScan,
  scanOtherPrefixesForStack,
  withSharedListing,
  type CrossPrefixScanResult,
  type CrossPrefixScanTarget,
} from '../../state/cross-prefix-stack-scan.js';

/**
 * The region a deploy runs a stack in: its synthesized region, else the run's
 * base region. The ONE expression both the engine (`runStackInner`) and the
 * cross-prefix scans use, so a scan reads the key the engine's state load does.
 */
export function deployStackRegion(
  stack: { region?: string | undefined },
  baseRegion: string
): string {
  return stack.region || baseRegion;
}

/** The key a deploy's scans are stored under: one per stack AND region. */
export function crossPrefixScanKey(stackName: string, region: string): string {
  return JSON.stringify([stackName, region]);
}

/**
 * Build the first-deploy gate for one top-level stack. A no-op for any other
 * stack name (nested children inherit the parent engine's options), for a
 * loaded record, and when no scan was started.
 */
export function createCrossPrefixDeployGate(opts: {
  stackName: string;
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  scan: Promise<CrossPrefixScanResult> | undefined;
}): (stackName: string, state: StackState | undefined) => Promise<void> {
  return async (gateStackName, state) => {
    if (gateStackName !== opts.stackName) return;
    if (state !== undefined) return;
    if (opts.scan === undefined) return;
    applyCrossPrefixScan(
      await opts.scan,
      {
        stackName: opts.stackName,
        region: opts.region,
        bucket: opts.bucket,
        recovery: opts.recovery,
      },
      'deploy',
      (message) => getLogger().warn(message),
      (message) => getLogger().info(message)
    );
  };
}

/**
 * Build the destructive-plan gate for one deploy: scan for the stack the
 * engine names (the top-level stack, or a nested child with its own record)
 * and refuse when another prefix holds it.
 */
export function createCrossPrefixDestructiveGate(opts: {
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  target: CrossPrefixScanTarget;
}): (stackName: string, destructive: readonly DestructiveChange[]) => Promise<void> {
  return async (stackName) => {
    const result = await scanOtherPrefixesForStack(opts.target, stackName, opts.region, {
      checkOwnRecord: false,
    });
    applyCrossPrefixScan(
      result,
      { stackName, region: opts.region, bucket: opts.bucket, recovery: opts.recovery },
      'deploy-destructive',
      (message) => getLogger().warn(message),
      (message) => getLogger().info(message)
    );
  };
}

/**
 * Start the first-deploy scan of every stack in a deploy set, through ONE
 * shared bucket listing, keyed by {@link crossPrefixScanKey}. `regionOf` must
 * be the region the engine deploys the stack to, which is what its state key
 * and the scan both use.
 */
export function startCrossPrefixScans(
  stacks: readonly { stackName: string; region?: string | undefined }[],
  target: CrossPrefixScanTarget,
  regionOf: (stack: { stackName: string; region?: string | undefined }) => string
): Map<string, Promise<CrossPrefixScanResult>> {
  const shared = withSharedListing(target);
  return new Map(
    stacks.map((s) => [
      crossPrefixScanKey(s.stackName, regionOf(s)),
      scanOtherPrefixesForStack(shared, s.stackName, regionOf(s), { checkOwnRecord: true }),
    ])
  );
}

/** The engine's `onCurrentStateLoaded`: the cross-prefix gate first, then the prefix-migration gate. */
export function composeStateLoadedGates(
  crossPrefix: (stackName: string, state: StackState | undefined) => Promise<void>,
  migration: ((stackName: string, state: StackState | undefined) => Promise<void>) | undefined
): (stackName: string, state: StackState | undefined) => Promise<void> {
  return async (stackName, state) => {
    await crossPrefix(stackName, state);
    if (migration) await migration(stackName, state);
  };
}

/**
 * The settle's cross-prefix question (`DeployEngineOptions.crossPrefixHolder`):
 * before a successful deploy deletes a proven journaled orphan of `stackName`,
 * does the bucket record that stack under another state prefix? Such a record
 * may hold the resource, so it is answered as an unreadable holding: the settle
 * keeps the orphan and warns. A check that could not run answers the same way.
 */
export function createCrossPrefixHolder(opts: {
  region: string;
  bucket: string;
  target: CrossPrefixScanTarget;
}): (stackName: string) => Promise<ForeignHolding> {
  return async (stackName) => {
    const result = await scanOtherPrefixesForStack(opts.target, stackName, opts.region, {
      checkOwnRecord: false,
    });
    if (result.kind === 'found') {
      return {
        kind: 'unreadable',
        what: safeMsg`bucket ${opts.bucket} also records this stack under another state prefix (${result.prefixes[0]}), whose record may hold it`,
      };
    }
    if (result.kind === 'failed' || result.kind === 'denied') {
      return {
        kind: 'unreadable',
        what: safeMsg`the other state prefixes of bucket ${opts.bucket} could not be checked`,
      };
    }
    return undefined;
  };
}
