import type { StackState } from '../../../types/state.js';
import type { ResolverContext } from '../support.js';

/** Per engine run (keyed by its shared `recordedImports`, else the pass's bag): one read per producer. */
const producerStateReads = new WeakMap<
  object,
  Map<string, Promise<{ state: StackState | undefined; failed: boolean }>>
>();

/**
 * A producer stack's state, read once per `scope` (an engine run; go-to-k/cdkd#4819,
 * go-to-k/cdkd#4852); `undefined` when the read fails (each caller's
 * `onFailure` runs, so every reader of a failed read can say what it lost) or
 * finds nothing. A producer deployed earlier in the same process saved its
 * state before the consumer's engine started. A state the caller already
 * holds is cached for the run instead of being read again.
 *
 * Exported for the deploy's and `cdkd diff`'s read-provenance arm, which reads
 * the producer of a cross-stack consumer through this same cache.
 */
export async function readProducerStateOnce(
  scope: object,
  stateBackend: Pick<NonNullable<ResolverContext['stateBackend']>, 'getState'> | undefined,
  stackName: string,
  region: string,
  onFailure: () => void,
  inHand?: StackState
): Promise<StackState | undefined> {
  let reads = producerStateReads.get(scope);
  if (reads === undefined) {
    reads = new Map();
    producerStateReads.set(scope, reads);
  }
  const key = JSON.stringify([stackName, region]);
  let read = reads.get(key);
  if (read === undefined) {
    read =
      inHand !== undefined
        ? Promise.resolve({ state: inHand, failed: false })
        : (async () => {
            if (stateBackend === undefined) return { state: undefined, failed: false };
            try {
              const data = await stateBackend.getState(stackName, region);
              return { state: data?.state ?? undefined, failed: false };
            } catch {
              // Fail closed: no id is kept, no version pinned.
              return { state: undefined, failed: true };
            }
          })();
    reads.set(key, read);
  }
  const { state, failed } = await read;
  if (failed) onFailure();
  return state;
}

/** {@link readProducerStateOnce} for a cross-stack read of `context`'s engine run. */
export function producerStateOnce(
  resolverRegion: string | undefined,
  context: ResolverContext,
  producerOutput: { stackName: string; region: string; state?: StackState },
  onFailure: () => void
): Promise<StackState | undefined> {
  return readProducerStateOnce(
    context.recordedImports ?? context.recordedSecretValues ?? context,
    context.stateBackend,
    producerOutput.stackName,
    // An index entry can carry an empty region; the resolver reads that as
    // its own (`resolverForProducerRegion`), and so does this read.
    producerOutput.region || resolverRegion || '',
    onFailure,
    producerOutput.state
  );
}

const physicalIdsByState = new WeakMap<object, ReadonlySet<string>>();

/** The physical ids of `state`'s records (go-to-k/cdkd#4819), computed once per state. */
export function physicalIdsOf(state: StackState | undefined): ReadonlySet<string> {
  if (state === undefined) return new Set();
  let ids = physicalIdsByState.get(state);
  if (ids === undefined) {
    const out = new Set<string>();
    const resources: unknown = state.resources;
    if (resources !== null && typeof resources === 'object') {
      for (const record of Object.values(resources)) {
        const id = (record as { physicalId?: unknown } | null)?.physicalId;
        if (typeof id === 'string' && id !== '') out.add(id);
      }
    }
    ids = out;
    physicalIdsByState.set(state, ids);
  }
  return ids;
}
