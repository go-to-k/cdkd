/**
 * The cross-stack ownership scan a successful deploy runs before deleting a
 * proven journaled orphan (go-to-k/cdkd#4600). Split out of
 * `journaled-orphans.ts` (go-to-k/cdkd#5835), which re-exports it.
 */
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { StackState } from '../../../types/state.js';
import { physicalIdKey } from '../../replacement-name-holder/name-keys.js';
import {
  hasReadableOrphans,
  unreadableOrphanRecords,
} from '../../../state/malformed-resources-bag.js';
import { displayIdent, displaySafe, safeMsg } from '../../../utils/display-safe.js';

/** What another stack's record says about a resource (`makeForeignHolderScan`). */
export type ForeignHolding =
  | { kind: 'held'; by: string }
  /**
   * `retryable`: the check itself failed (go-to-k/cdkd#4705), so re-running
   * once it can succeed may settle the answer.
   */
  | { kind: 'unreadable'; what: string; retryable?: true }
  | undefined;

/**
 * go-to-k/cdkd#4600: the ownership check a successful deploy runs before
 * deleting a proven orphan, over every resource record of another stack under
 * the same state prefix. A user who removed the orphan by hand may
 * have let ANOTHER stack (a sibling, a nested child of the same tree, or the
 * same stack in another region for a global name) create a resource under the
 * same name, and that stack's record is the only evidence. One `listStacks`
 * and a read of every record, as the exports-index rebuild does, made lazily
 * on the first question and shared by every stack the settle asks about.
 *
 * Reads each record's `resources` and rollback-orphan records; a record that
 * cannot be read, listed or located (a legacy key with no region) makes every
 * answer `unreadable` (fail closed: the entry is kept).
 */
export function makeForeignHolderScan(
  stateBackend: Pick<S3StateBackend, 'listStacks' | 'getState'>
): (self: {
  stackName: string;
  region: string;
}) => (resourceType: string, physicalId: string) => Promise<ForeignHolding> {
  type Scan = {
    holders: Map<string, Array<{ stackName: string; region: string }>>;
    unreadable?: string;
  };
  let scan: Promise<Scan> | undefined;
  // Under the type's case rule (go-to-k/cdkd#4692): another stack's record
  // spelling the id `mycluster` holds the cluster a journal names `MyCluster`.
  const key = (type: string, id: string): string => JSON.stringify([type, physicalIdKey(type, id)]);
  const run = async (): Promise<Scan> => {
    const holders: Scan['holders'] = new Map();
    let refs: Awaited<ReturnType<S3StateBackend['listStacks']>>;
    try {
      refs = await stateBackend.listStacks();
    } catch {
      return { holders, unreadable: 'the state bucket listing (it could not be read)' };
    }
    let unreadable: string | undefined;
    await Promise.all(
      refs.map(async (ref) => {
        const named = (why: string): string =>
          safeMsg`the state record of stack ${displayIdent(ref.stackName)} (${why})`;
        // A legacy key whose body names no region: where its resources live
        // is unknown, so it cannot vouch for anything (fail closed).
        if (ref.region === undefined) {
          unreadable ??= named('its region cannot be read');
          return;
        }
        const region = ref.region;
        let state: StackState | undefined;
        try {
          state = (await stateBackend.getState(ref.stackName, region))?.state;
        } catch {
          unreadable ??= named('it could not be read');
          return;
        }
        if (state === undefined) return;
        const resources: unknown = state.resources;
        if (
          resources !== undefined &&
          (typeof resources !== 'object' || resources === null || Array.isArray(resources))
        ) {
          unreadable ??= named('its resources cannot be read');
          return;
        }
        // Its rollback-orphan records hold resources too (go-to-k/cdkd#3379's
        // container and row guards first).
        if (!hasReadableOrphans(state) || unreadableOrphanRecords(state).length > 0) {
          unreadable ??= named('its rollback-orphan records cannot be read');
          return;
        }
        const held: unknown[] = [
          ...Object.values((resources ?? {}) as Record<string, unknown>),
          ...(state.orphans ?? []).map((record) => record.state),
        ];
        for (const record of held) {
          const r = record as { resourceType?: unknown; physicalId?: unknown } | null;
          if (typeof r?.resourceType !== 'string' || typeof r.physicalId !== 'string') continue;
          const k = key(r.resourceType, r.physicalId);
          const list = holders.get(k) ?? [];
          list.push({ stackName: ref.stackName, region });
          holders.set(k, list);
        }
      })
    );
    return { holders, ...(unreadable !== undefined && { unreadable }) };
  };
  return (self) => async (resourceType, physicalId) => {
    scan ??= run();
    const { holders, unreadable } = await scan;
    const other = (holders.get(key(resourceType, physicalId)) ?? []).find(
      (h) => !(h.stackName === self.stackName && h.region === self.region)
    );
    if (other) {
      return {
        kind: 'held',
        by: safeMsg`the state record of stack ${displayIdent(other.stackName)} (${displaySafe(other.region)})`,
      };
    }
    return unreadable === undefined ? undefined : { kind: 'unreadable', what: unreadable };
  };
}
