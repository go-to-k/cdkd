/**
 * The deploy half of go-to-k/cdkd#4705 (`src/state/cross-prefix-stack-scan.ts`).
 *
 * Scans of the bucket's other state prefixes are LAZY, memoized per stack and
 * region in one `CrossPrefixScanCache` per run (one shared listing, one
 * run-wide probe cap), so an ordinary redeploy issues no listing and no probe:
 *
 * - {@link startCrossPrefixScans}: once synth has finished, each stack asks
 *   whether this prefix records it; only when it does not (a FIRST deploy) is
 *   its scan started, overlapping the pre-lock phase. The engine's
 *   `onCurrentStateLoaded` gate ({@link createCrossPrefixDeployGate}) awaits it
 *   when no record was loaded.
 * - {@link createCrossPrefixDestructiveGate} (`onDestructivePlan`): a plan that
 *   deletes, replaces or may replace a resource, or updates a nested-stack row
 *   (`checkDestructivePlan`), starts (or reuses) the scan on demand, before the
 *   approval prompt; so does a replacement decided late, on a readback
 *   (`stage` `'late'`), whose refusal keeps that resource.
 * - {@link createCrossPrefixHolder} (`crossPrefixHolder`): a successful deploy's
 *   settle starts (or reuses) it before deleting a journaled orphan.
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
  CrossPrefixScanCache,
  applyCrossPrefixScan,
  crossPrefixDeniedWarning,
  isAccessDenied,
  type CrossPrefixScanResult,
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
 * Once synth has finished, for every stack of a deploy set: ask whether this
 * prefix records it, and only when it does not (a first deploy) start its scan
 * through `cache`. Keyed by {@link crossPrefixScanKey}; each value is the
 * first-deploy answer (`own-record`, or the scan's result). `regionOf` must be
 * the engine's region for the stack (deploy.ts passes {@link deployStackRegion}).
 * Never rejects.
 */
export function startCrossPrefixScans(
  stacks: readonly { stackName: string; region?: string | undefined }[],
  cache: CrossPrefixScanCache,
  regionOf: (stack: { stackName: string; region?: string | undefined }) => string
): Map<string, Promise<CrossPrefixScanResult>> {
  return new Map(
    stacks.map((s) => {
      const region = regionOf(s);
      const firstDeploy = (async (): Promise<CrossPrefixScanResult> => {
        try {
          if (await cache.target.ownRecordExists(s.stackName, region)) {
            return { kind: 'own-record' };
          }
        } catch (error) {
          return isAccessDenied(error)
            ? { kind: 'denied', error, stage: 'probe' }
            : { kind: 'failed', error };
        }
        // Ahead of need: queued in stack order behind any scan a caller is
        // waiting on now. The gate promotes it once its engine waits on it.
        return cache.full(s.stackName, region, 'prestart');
      })();
      return [crossPrefixScanKey(s.stackName, region), firstDeploy];
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
  /** The engine now waits on the scan: raise its priority (go-to-k/cdkd#4705 review R6-3). */
  promote?: (() => void) | undefined;
}): (stackName: string, state: StackState | undefined) => Promise<void> {
  return async (gateStackName, state) => {
    if (gateStackName !== opts.stackName) return;
    if (state !== undefined) return;
    if (opts.scan === undefined) return;
    opts.promote?.();
    const result = await opts.scan;
    applyCrossPrefixScan(
      result,
      {
        stackName: opts.stackName,
        region: opts.region,
        bucket: opts.bucket,
        recovery: opts.recovery,
      },
      'deploy',
      ...reportOnce(result)
    );
  };
}

/**
 * The warn and info sinks for one scan RESULT, live only the first time it is
 * reported (go-to-k/cdkd#4705 review R7-3): a deploy's first-deploy gate, its
 * destructive gate and its settle can each act on the same memoized result,
 * and its 403 warning and stale-record note are printed once. A refusal still
 * throws every time. Keyed by the result object, which a cache memoizes per
 * stack and region for one run.
 */
const reported = new WeakSet<object>();
function reportOnce(
  result: CrossPrefixScanResult
): [(message: string) => void, (message: string) => void] {
  const first = !reported.has(result);
  reported.add(result);
  return first
    ? [(message) => getLogger().warn(message), (message) => getLogger().info(message)]
    : [() => undefined, () => undefined];
}

/**
 * Build the destructive-plan gate: scan (or reuse the memoized scan of) the
 * stack the engine names, on demand, and refuse when another prefix holds it.
 */
export function createCrossPrefixDestructiveGate(opts: {
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  cache: CrossPrefixScanCache;
}): (
  stackName: string,
  destructive: readonly DestructiveChange[],
  stage?: 'late'
) => Promise<void> {
  return async (stackName, _destructive, stage) => {
    const result = await opts.cache.full(stackName, opts.region);
    applyCrossPrefixScan(
      result,
      { stackName, region: opts.region, bucket: opts.bucket, recovery: opts.recovery },
      stage === 'late' ? 'deploy-late-replace' : 'deploy-destructive',
      ...reportOnce(result)
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
  region: string;
  bucket: string;
  cache: CrossPrefixScanCache;
}): (stackName: string) => Promise<ForeignHolding> {
  return async (stackName) => {
    const result = await opts.cache.full(stackName, opts.region);
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
          retryable: true,
        };
      case 'denied':
        reportOnce(result)[0](
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
 * The engine options of one top-level stack's cross-prefix checks: the
 * first-deploy gate over the scan {@link startCrossPrefixScans} may have
 * started, and the on-demand destructive gate and settle holder over the run's
 * `cache`. deploy.ts spreads this, so a test of it is a test of the real wiring.
 */
export function crossPrefixEngineOptions(opts: {
  stackName: string;
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  firstDeploy: Promise<CrossPrefixScanResult> | undefined;
  cache: CrossPrefixScanCache;
}): {
  firstDeployGate: (stackName: string, state: StackState | undefined) => Promise<void>;
  onDestructivePlan: (
    stackName: string,
    destructive: readonly DestructiveChange[],
    stage?: 'late'
  ) => Promise<void>;
  crossPrefixHolder: (stackName: string) => Promise<ForeignHolding>;
} {
  return {
    firstDeployGate: createCrossPrefixDeployGate({
      stackName: opts.stackName,
      region: opts.region,
      bucket: opts.bucket,
      recovery: opts.recovery,
      scan: opts.firstDeploy,
      promote: () => opts.cache.target.rank(opts.stackName, opts.region, 'now'),
    }),
    onDestructivePlan: createCrossPrefixDestructiveGate({
      region: opts.region,
      bucket: opts.bucket,
      recovery: opts.recovery,
      cache: opts.cache,
    }),
    crossPrefixHolder: createCrossPrefixHolder({
      region: opts.region,
      bucket: opts.bucket,
      cache: opts.cache,
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
