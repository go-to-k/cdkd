/**
 * `cdkd destroy`: stack ordering, the planned destroy region and the
 * `--purge-events` purge. Split out of `../destroy.ts`, which re-exports the
 * public names.
 */
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { DeploymentRunResult } from '../../../types/deployment-events.js';
import type {
  DeploymentEventsReader,
  DeploymentEventsPruneResult,
} from '../../../state/deployment-events-store.js';

/**
 * Topologically order `stackNames` so that every consumer is destroyed BEFORE
 * its producers. `consumerToProducers` maps consumer → set of producer stack
 * names (the deploy-direction edges from `inferCrossStackStackDeps`); destroy
 * is the reverse, so a stack must appear before all of its producers.
 *
 * Kahn-style with a deterministic tie-break: among nodes currently free to be
 * emitted (no remaining unemitted consumer pointing at them), pick the one
 * earliest in the original `stackNames` order so the output is stable and the
 * original order is preserved whenever there are no cross-stack edges. A cycle
 * (should not happen for valid templates) degrades gracefully — any leftover
 * nodes are appended in original order rather than dropped.
 */
export function orderConsumersBeforeProducers(
  stackNames: string[],
  consumerToProducers: Map<string, Set<string>>
): string[] {
  // Build producer -> consumers (reverse edges). For destroy we emit a node
  // only once every consumer that imports from it has already been emitted.
  const pendingConsumers = new Map<string, Set<string>>();
  for (const name of stackNames) {
    pendingConsumers.set(name, new Set());
  }
  for (const [consumer, producers] of consumerToProducers) {
    for (const producer of producers) {
      pendingConsumers.get(producer)?.add(consumer);
    }
  }

  const emitted = new Set<string>();
  const ordered: string[] = [];
  while (ordered.length < stackNames.length) {
    // Earliest-in-original-order node whose consumers are all emitted.
    const next = stackNames.find(
      (name) =>
        !emitted.has(name) && [...(pendingConsumers.get(name) ?? [])].every((c) => emitted.has(c))
    );
    if (!next) {
      // Cycle / unresolvable remainder: append the rest in original order.
      for (const name of stackNames) {
        if (!emitted.has(name)) {
          emitted.add(name);
          ordered.push(name);
        }
      }
      break;
    }
    emitted.add(next);
    ordered.push(next);
  }
  return ordered;
}

/**
 * Issue [#885] — apply `cdkd destroy --purge-events` for one stack.
 *
 * Purges the stack's deployment-event history (the post-mortem `deployments/`
 * store cdkd keeps by default) ONLY after a clean, non-interrupted destroy,
 * earlier versions included. Deliberately
 * skipped on a failed / interrupted destroy — those events ARE the post-mortem
 * the user wants on the retry — and a no-op when `--purge-events` was not
 * passed.
 *
 * On the versioned state bucket a delete by key only writes DELETE MARKERS,
 * so `DeploymentEventsReader.pruneRuns({ all: true })` also purges every
 * noncurrent version under the stack's `deployments/` prefix (issue
 * [#2624](https://github.com/go-to-k/cdkd/issues/2624)). That reaches a
 * stream already behind a delete marker (pruned before this purge existed, or
 * by a purge that warned) as well as the keys this run deletes. The purge is
 * fail-soft and prints its own warning before the log line below when it
 * cannot finish or the bucket is replicated, which is why the line defers to
 * "a warning above".
 *
 * MUST be called AFTER the run's `eventRecorder.finalize()` (which writes this
 * run's own events + index): purging first would just be re-created by the
 * finalize. Best-effort — a purge failure warns but never fails the
 * already-successful destroy (the resources are gone regardless). The
 * equivalent for an already-destroyed stack is `cdkd events prune <stack> --all`.
 *
 * Returns the prune result when a purge ran, or `null` when it was skipped
 * (flag off / failed / interrupted) or the purge itself errored. Extracted
 * from the destroy loop so the gating is unit-testable without the full
 * synth / AWS-client harness.
 */
/**
 * The region `cdkd destroy` destroys a stack in, from its state records: the
 * only one (a legacy record with no region falls back to the CLI region), or,
 * with several, the synthesized stack's region when one of them matches.
 * `undefined` when there is no record, or several and none is chosen (the
 * loop refuses). The cross-prefix pre-start (go-to-k/cdkd#4705) and the loop
 * share it, so a scan never runs for a region the run will not destroy.
 */
export function plannedDestroyRegion(
  refs: ReadonlyArray<{ region?: string | undefined }>,
  synthRegion: string | undefined,
  cliRegion: string
): string | undefined {
  if (refs.length === 1) return refs[0]?.region || cliRegion;
  if (refs.length > 1 && synthRegion && refs.some((r) => r.region === synthRegion)) {
    return synthRegion;
  }
  return undefined;
}

export async function purgeEventsAfterDestroy(
  reader: Pick<DeploymentEventsReader, 'pruneRuns'>,
  stackName: string,
  region: string,
  opts: { purgeEvents: boolean | undefined; runResult: DeploymentRunResult; interrupted: boolean },
  logger: { info: (message: string) => void; warn: (message: string) => void }
): Promise<DeploymentEventsPruneResult | null> {
  if (opts.purgeEvents !== true || opts.runResult !== 'SUCCEEDED' || opts.interrupted) {
    return null;
  }
  try {
    const purge = await reader.pruneRuns(stackName, region, { all: true });
    // `indexDeleted` is true only when an index EXISTED in the prune's listing
    // (issue #2624) — not merely because the idempotent `DeleteObjects`
    // succeeded — so a prefix with no history prints nothing here. In a live
    // destroy that is rare: `eventRecorder.finalize()` runs first and writes
    // this run's record plus `index.json`, so the prefix is empty only when
    // those writes did not land.
    //
    // The prefix sweep counts what it deleted (issue #2624), and that count
    // is the same evidence `cdkd events prune --all` reports on: a prefix with
    // nothing current but earlier versions left by an earlier delete still
    // gets a line, scoped to those versions, and an empty one gets none.
    if (purge.deletedRunIds.length > 0 || purge.indexDeleted) {
      logger.info(
        `  Purged deployment-event history for ${displaySafe(stackName)} (${displaySafe(region)}) ` +
          `and every earlier version under its deployments/ prefix, unless a warning above says otherwise.`
      );
    } else if ((purge.earlierVersions?.deletedBodies ?? 0) > 0) {
      logger.info(
        safeMsg`  Purged earlier deployment-event versions left under the deployments/ prefix of ${displaySafe(stackName)} (${displaySafe(region)}), unless a warning above says otherwise.`
      );
    }
    return purge;
  } catch (purgeError) {
    logger.warn(
      `  Failed to purge deployment-event history for ${displaySafe(stackName)}: ` +
        `${displaySafe(describeAwsFailure(purgeError).detail)}`
    );
    return null;
  }
}
