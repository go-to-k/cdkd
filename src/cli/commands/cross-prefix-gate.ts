/**
 * The deploy half of go-to-k/cdkd#4705 (`src/state/stack-registry.ts`,
 * `src/state/cross-prefix-stack-scan.ts`).
 *
 * Every check reads the bucket's stack registry through one
 * `CrossPrefixGuard` per run, memoized per stack and region, so an ordinary
 * redeploy issues no request at all:
 *
 * - {@link createCrossPrefixDeployGate} (`onCurrentStateLoaded`): when no
 *   record was loaded (a FIRST deploy), claim the stack's marker, or act on the
 *   one there, before the first provider call.
 * - {@link createCrossPrefixDestructiveGate} (`onDestructivePlan`): a plan that
 *   deletes, replaces or may replace a resource, or adds or updates a
 *   nested-stack row (`checkDestructivePlan`), reads it before the approval
 *   prompt; so does a replacement decided late, on a readback (`stage`
 *   `'late'`), whose refusal keeps that resource.
 * - {@link createCrossPrefixHolder} (`crossPrefixHolder`): a successful
 *   deploy's settle, and a failed deploy's automatic rollback, read it before
 *   deleting a resource another deployment may hold.
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
  type CrossPrefixScanResult,
} from '../../state/cross-prefix-stack-scan.js';
import type { CrossPrefixGuard } from '../../state/stack-registry.js';

/** What a check consults: the run's guard (or, in a test, a bare scan cache). */
export type CrossPrefixSource = Pick<CrossPrefixGuard, 'full'> &
  Partial<Pick<CrossPrefixGuard, 'knownMarker'>>;

/**
 * The region a deploy runs a stack in: its synthesized region, else the run's
 * base region. The ONE expression both the engine (`runStackInner`) and the
 * cross-prefix checks use, so a check reads the key the engine's state load
 * does.
 */
export function deployStackRegion(
  stack: { region?: string | undefined },
  baseRegion: string
): string {
  return stack.region || baseRegion;
}

/**
 * Build the first-deploy gate for one top-level stack. A no-op for any other
 * stack name (nested children inherit the parent engine's options) and for a
 * loaded record. Otherwise it claims the stack's registry marker (or acts on
 * the one there) and refuses before any provider call when another prefix
 * holds the stack.
 */
export function createCrossPrefixDeployGate(opts: {
  stackName: string;
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  guard: Pick<CrossPrefixGuard, 'firstDeploy'>;
}): (stackName: string, state: StackState | undefined) => Promise<void> {
  return async (gateStackName, state) => {
    if (gateStackName !== opts.stackName) return;
    if (state !== undefined) return;
    const result = await opts.guard.firstDeploy(opts.stackName, opts.region);
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
 * Build the destructive-plan gate: read (or reuse the run's answer for) the
 * stack the engine names, on demand, and refuse when another prefix holds it.
 */
export function createCrossPrefixDestructiveGate(opts: {
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  cache: CrossPrefixSource;
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
 * The cross-prefix question (`DeployEngineOptions.crossPrefixHolder`) a
 * successful deploy's settle asks before deleting a proven journaled orphan of
 * `stackName`, and a failed deploy's automatic rollback before deleting a
 * resource it created: does the bucket record that stack under another state
 * prefix? (A nested child asks by its own name; the guard reads its top-level
 * stack's marker.)
 *
 * - `found`: such a record may hold the resource, so it is answered as an
 *   unreadable holding and the resource is kept, with a warning.
 * - `in-progress`: a deploy under the prefix the registry names may be
 *   running: the same.
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
  cache: CrossPrefixSource;
}): (stackName: string) => Promise<ForeignHolding> {
  return async (stackName) => {
    const result = await opts.cache.full(stackName, opts.region);
    switch (result.kind) {
      case 'found':
        return {
          kind: 'unreadable',
          what: safeMsg`bucket ${opts.bucket} also records this stack under another state prefix (${displayIdent(result.prefixes[0])}), whose record may hold it`,
        };
      case 'in-progress':
        return {
          kind: 'unreadable',
          what: safeMsg`bucket ${opts.bucket} assigns this stack to another state prefix (${displayIdent(result.prefix)}), where a deploy may be in progress`,
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
 * The engine options of one top-level stack's cross-prefix checks, all over
 * the run's `guard`: the first-deploy gate, the on-demand destructive gate,
 * and the settle and automatic-rollback holder. deploy.ts spreads this, so a
 * test of it is a test of the real wiring.
 */
export function crossPrefixEngineOptions(opts: {
  stackName: string;
  region: string;
  bucket: string;
  recovery?: LockRecoveryContext | undefined;
  guard: Pick<CrossPrefixGuard, 'full' | 'firstDeploy'>;
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
      guard: opts.guard,
    }),
    onDestructivePlan: createCrossPrefixDestructiveGate({
      region: opts.region,
      bucket: opts.bucket,
      recovery: opts.recovery,
      cache: opts.guard,
    }),
    crossPrefixHolder: createCrossPrefixHolder({
      region: opts.region,
      bucket: opts.bucket,
      cache: opts.guard,
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
