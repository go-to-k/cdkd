/**
 * The deploy half of go-to-k/cdkd#4705 (`src/state/cross-prefix-stack-scan.ts`).
 *
 * For every top-level stack of a deploy, ONE scan of the bucket's other state
 * prefixes is started once synth has finished ({@link startCrossPrefixScans}),
 * through one shared listing, so it overlaps the pre-lock phase (macro
 * expansion, STS, asset publishing, the lock). It never rejects and refuses
 * nothing by itself: only a gate that awaits it acts on it.
 *
 * - {@link createCrossPrefixDeployGate} (the engine's `onCurrentStateLoaded`):
 *   a stack's FIRST deploy under this prefix is refused when another prefix
 *   holds it. A deploy that loaded a record never awaits the scan.
 * - {@link createCrossPrefixDestructiveGate} (`onDestructivePlan`): a deploy
 *   whose plan deletes, replaces or may replace a resource, or updates or
 *   deletes a nested-stack row (`checkDestructivePlan`), is refused the same way.
 * - {@link createCrossPrefixHolder} (`crossPrefixHolder`): a successful deploy's
 *   settle keeps a journaled orphan another prefix may hold.
 *
 * {@link crossPrefixEngineOptions} builds all three for one stack; deploy.ts
 * spreads its result into the engine options.
 */

import type { DestructiveChange } from '../../analyzer/destructive-changes.js';
import type { LockRecoveryContext } from '../../state/lock-contention-message.js';
import type { ForeignHolding } from '../../deployment/rollback-executor/journaled-orphans.js';
import type { StackState } from '../../types/state.js';
import { displayIdent, safeMsg } from '../../utils/display-safe.js';
import { getLogger } from '../../utils/logger.js';
import {
  applyCrossPrefixScan,
  crossPrefixDeniedWarning,
  isAccessDenied,
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

/** One stack's scans: the full scan, and the first-deploy view of it. */
export interface StackCrossPrefixScans {
  /** Every other prefix, whatever this prefix holds (`checkOwnRecord: false`). */
  full: Promise<CrossPrefixScanResult>;
  /** `own-record` when this prefix already holds the stack, else {@link full}'s result. */
  firstDeploy: Promise<CrossPrefixScanResult>;
}

/**
 * Start every stack's scan once synth has finished, through ONE shared bucket
 * listing, keyed by {@link crossPrefixScanKey}. The first-deploy view asks this
 * prefix about the stack in parallel and reuses the full scan's probes, so a
 * stack pays for one scan. `regionOf` must be the engine's region for the stack
 * (deploy.ts passes {@link deployStackRegion}).
 */
export function startCrossPrefixScans(
  stacks: readonly { stackName: string; region?: string | undefined }[],
  target: CrossPrefixScanTarget,
  regionOf: (stack: { stackName: string; region?: string | undefined }) => string
): Map<string, StackCrossPrefixScans> {
  const shared = withSharedListing(target);
  return new Map(
    stacks.map((s) => {
      const region = regionOf(s);
      const full = scanOtherPrefixesForStack(shared, s.stackName, region, {
        checkOwnRecord: false,
      });
      const firstDeploy = (async (): Promise<CrossPrefixScanResult> => {
        try {
          if (await shared.ownRecordExists(s.stackName, region)) return { kind: 'own-record' };
        } catch (error) {
          return isAccessDenied(error)
            ? { kind: 'denied', error, stage: 'probe' }
            : { kind: 'failed', error };
        }
        return full;
      })();
      return [crossPrefixScanKey(s.stackName, region), { full, firstDeploy }];
    })
  );
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
 * Build the destructive-plan gate for one top-level stack. It awaits the
 * stack's pre-started scan; a stack name with no pre-started scan is scanned
 * now through `target`.
 */
export function createCrossPrefixDestructiveGate(opts: {
  stackName?: string | undefined;
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  target: CrossPrefixScanTarget;
  scan?: Promise<CrossPrefixScanResult> | undefined;
}): (stackName: string, destructive: readonly DestructiveChange[]) => Promise<void> {
  return async (stackName) => {
    const result =
      opts.scan !== undefined && stackName === opts.stackName
        ? await opts.scan
        : await scanOtherPrefixesForStack(opts.target, stackName, opts.region, {
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
 * The settle's cross-prefix question (`DeployEngineOptions.crossPrefixHolder`):
 * before a successful deploy deletes a proven journaled orphan of `stackName`,
 * does the bucket record that stack under another state prefix?
 *
 * - `found`: such a record may hold the resource, so it is answered as an
 *   unreadable holding and the settle keeps the orphan, with its warning.
 * - `failed`: the check could not answer, so the same (fail closed).
 * - `denied`: S3 answered 403, which is the common case for an identity whose
 *   policy covers only its own prefix and has no second prefix at all. It warns,
 *   as every other 403 of this check does, and answers nothing, so the settle
 *   deletes as it did before the check existed.
 * - `clear`: nothing.
 */
export function createCrossPrefixHolder(opts: {
  stackName?: string | undefined;
  region: string;
  bucket: string;
  target: CrossPrefixScanTarget;
  scan?: Promise<CrossPrefixScanResult> | undefined;
}): (stackName: string) => Promise<ForeignHolding> {
  return async (stackName) => {
    const result =
      opts.scan !== undefined && stackName === opts.stackName
        ? await opts.scan
        : await scanOtherPrefixesForStack(opts.target, stackName, opts.region, {
            checkOwnRecord: false,
          });
    switch (result.kind) {
      case 'found':
        return {
          kind: 'unreadable',
          what: safeMsg`bucket ${opts.bucket} also records this stack under another state prefix (${displayIdent(result.prefixes[0])}), whose record may hold it`,
        };
      case 'failed':
        return {
          kind: 'unreadable',
          what: safeMsg`the other state prefixes of bucket ${opts.bucket} could not be checked`,
        };
      case 'denied':
        getLogger().warn(
          crossPrefixDeniedWarning(
            { stackName, region: opts.region, bucket: opts.bucket },
            result.error,
            result.stage
          )
        );
        return undefined;
      default:
        return undefined;
    }
  };
}

/**
 * The engine options of one top-level stack's cross-prefix checks, built from
 * its pre-started scans. deploy.ts spreads this, so a test of it is a test of
 * the real wiring.
 */
export function crossPrefixEngineOptions(opts: {
  stackName: string;
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  scans: StackCrossPrefixScans | undefined;
  target: CrossPrefixScanTarget;
}): {
  firstDeployGate: (stackName: string, state: StackState | undefined) => Promise<void>;
  onDestructivePlan: (
    stackName: string,
    destructive: readonly DestructiveChange[]
  ) => Promise<void>;
  crossPrefixHolder: (stackName: string) => Promise<ForeignHolding>;
} {
  return {
    firstDeployGate: createCrossPrefixDeployGate({
      stackName: opts.stackName,
      region: opts.region,
      bucket: opts.bucket,
      recovery: opts.recovery,
      scan: opts.scans?.firstDeploy,
    }),
    onDestructivePlan: createCrossPrefixDestructiveGate({
      stackName: opts.stackName,
      region: opts.region,
      bucket: opts.bucket,
      recovery: opts.recovery,
      target: opts.target,
      scan: opts.scans?.full,
    }),
    crossPrefixHolder: createCrossPrefixHolder({
      stackName: opts.stackName,
      region: opts.region,
      bucket: opts.bucket,
      target: opts.target,
      scan: opts.scans?.full,
    }),
  };
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
