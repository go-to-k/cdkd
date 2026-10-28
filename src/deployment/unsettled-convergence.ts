/**
 * go-to-k/cdkd#5380 / #5487: converging what an earlier failed update left
 * unsettled (`ResourceState.unsettledProperties`), for every caller that hands
 * a provider's `update()` a previous bag — the deploy's in-place update, the
 * rollback revert arms and `cdkd drift --revert`.
 *
 * Two halves, each provider-agnostic:
 *
 * - BEFORE the removal step ({@link settleUnsettledPrevious}): a name AWS is
 *   still changing (`ResourceProvider.unsettledInTransition`) refuses the
 *   update — a moving value is never diffed. Otherwise each unsettled name's
 *   previous value becomes what AWS holds now (`readUnsettled`, else
 *   `readCurrentState`), or is removed when the read does not report it, and
 *   the EXISTING `prepareRemovalForUpdate` then derives removals and reset
 *   values from that bag, so a key the template omits but AWS now carries is
 *   reset like any removal. Only the unsettled names are touched.
 * - AFTER `update()` resolved ({@link unsettledAfterUpdate}): a name stays
 *   unsettled unless AWS is no longer changing it AND holds what the template
 *   declares under drift's comparator. The success of the call alone is not
 *   the proof.
 *
 * A merge-semantics key (`Tags`) is never substituted: CloudFormation removes
 * only the recorded tags the template dropped and leaves every other tag on
 * the resource, so the record's tags stay the previous side and the key is
 * re-sent (upserting the template's tags) because it is still in
 * `changedProperties`. A tag the failed update added that neither the record
 * nor the template holds cannot be named (the attempted bag is not persisted)
 * and is left in place, which the caller warns about.
 */
import { calculateResourceDrift } from '../analyzer/drift-calculator.js';
import type { ResourceProvider } from '../types/resource.js';
import { ProvisioningError } from '../utils/error-handler.js';
import type { ResourceState } from '../types/state.js';
import { withUnsettledProperties } from '../state/unsettled-properties.js';
import { safeMsg } from '../utils/display-safe.js';

/** Keys whose update merges into what AWS holds rather than replacing it. */
export const MERGE_SEMANTICS_KEYS: ReadonlySet<string> = new Set(['Tags']);

interface Identity {
  provider: ResourceProvider;
  logicalId: string;
  physicalId: string;
  resourceType: string;
  /** The record's own `properties`, for a read needing a parent id. */
  recordedProperties: Record<string, unknown>;
}

async function readLive(
  args: Identity,
  names: ReadonlySet<string>
): Promise<Record<string, unknown> | 'unreadable' | undefined> {
  const { provider, physicalId, logicalId, resourceType, recordedProperties } = args;
  let live: unknown;
  if (provider.readUnsettled !== undefined) {
    live = await provider.readUnsettled(
      physicalId,
      logicalId,
      resourceType,
      names,
      recordedProperties
    );
  } else if (provider.readCurrentState !== undefined) {
    live = await provider.readCurrentState(physicalId, logicalId, resourceType, recordedProperties);
  } else {
    // No read at all: the provider converges from `unsettledProperties`
    // itself, or not at all; nothing to substitute.
    return undefined;
  }
  if (typeof live !== 'object' || live === null || Array.isArray(live)) return 'unreadable';
  return live as Record<string, unknown>;
}

function refusal(args: Identity, names: Iterable<string>, why: string): ProvisioningError {
  const list = [...names].sort().join(', ');
  return new ProvisioningError(
    `${args.logicalId} (${args.resourceType}): an earlier failed update left ${list} unsettled, ` +
      `and ${why} — nothing was updated. Re-run the deploy once the resource has settled.`,
    args.resourceType,
    args.logicalId,
    args.physicalId
  );
}

/**
 * The previous bag to hand `prepareRemovalForUpdate` and `update()`, with each
 * unsettled non-merge name replaced by what AWS holds now. Refuses (before any
 * write, so the names stay unsettled) when a name is still in transition or
 * the resource cannot be read. Returns `previous` itself when nothing is
 * unsettled.
 */
export async function settleUnsettledPrevious(
  args: Identity & { names: ReadonlySet<string>; previous: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const { names, previous, provider } = args;
  if (names.size === 0) return previous;
  if (provider.unsettledInTransition !== undefined) {
    const moving = await provider.unsettledInTransition(
      args.physicalId,
      args.logicalId,
      args.resourceType,
      names,
      args.recordedProperties
    );
    // The hook answers every name when its own read fails, so the message
    // covers both causes rather than claiming the resource is moving.
    if (moving.size > 0) {
      throw refusal(args, moving, 'AWS is still changing it or cdkd could not confirm it settled');
    }
  }
  const substituted = new Set([...names].filter((name) => !MERGE_SEMANTICS_KEYS.has(name)));
  if (substituted.size === 0) return previous;
  let live: Awaited<ReturnType<typeof readLive>>;
  try {
    live = await readLive(args, substituted);
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const wrapped = refusal(args, substituted, 'the resource could not be read to converge it');
    if (error instanceof Error) (wrapped as { cause?: unknown }).cause = error;
    throw wrapped;
  }
  if (live === undefined) return previous;
  if (live === 'unreadable') {
    throw refusal(args, substituted, 'the resource could not be read to converge it');
  }
  const out = { ...previous };
  for (const name of substituted) {
    if (Object.hasOwn(live, name) && live[name] !== undefined) out[name] = live[name];
    else delete out[name];
  }
  return out;
}

/** Every desired tag (CFn `[{Key, Value}]` or a `{key: value}` map) is on the resource. */
function tagsHeld(desired: unknown, live: unknown): boolean {
  const asMap = (value: unknown): Map<string, unknown> | undefined => {
    if (value === undefined || value === null) return new Map();
    if (Array.isArray(value)) {
      const map = new Map<string, unknown>();
      for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) return undefined;
        const { Key, Value } = entry as { Key?: unknown; Value?: unknown };
        if (typeof Key !== 'string') return undefined;
        map.set(Key, Value);
      }
      return map;
    }
    if (typeof value === 'object') return new Map(Object.entries(value as Record<string, unknown>));
    return undefined;
  };
  const want = asMap(desired);
  const have = asMap(live);
  if (want === undefined || have === undefined) return false;
  for (const [key, value] of want) {
    if (!have.has(key) || JSON.stringify(have.get(key)) !== JSON.stringify(value)) return false;
  }
  return true;
}

/**
 * The unsettled names that stay unsettled after a successful `update()`: one
 * AWS is still changing, or whose live value does not match the template under
 * drift's comparator (`Tags`: a desired tag missing from the resource). A name
 * the read does not report (a write-only property) is proven by the call that
 * sent it. A failed read keeps every name.
 */
export async function unsettledAfterUpdate(
  args: Identity & { names: ReadonlySet<string>; desired: Record<string, unknown> }
): Promise<string[]> {
  const { names, desired, provider } = args;
  if (names.size === 0) return [];
  try {
    const moving =
      provider.unsettledInTransition === undefined
        ? new Set<string>()
        : await provider.unsettledInTransition(
            args.physicalId,
            args.logicalId,
            args.resourceType,
            names,
            args.recordedProperties
          );
    const live = await readLive(args, names);
    if (live === undefined) return [...moving].sort();
    if (live === 'unreadable') return [...names].sort();
    const ignorePaths = provider.getDriftUnknownPaths?.(args.resourceType) ?? [];
    const unorderedPaths = provider.getDriftUnorderedPaths?.(args.resourceType) ?? [];
    const kept: string[] = [];
    for (const name of names) {
      if (moving.has(name)) {
        kept.push(name);
        continue;
      }
      if (MERGE_SEMANTICS_KEYS.has(name)) {
        if (!tagsHeld(desired[name], live[name])) kept.push(name);
        continue;
      }
      if (!Object.hasOwn(live, name) || desired[name] === undefined) continue;
      const drift = calculateResourceDrift(
        { [name]: desired[name] },
        { [name]: live[name] },
        { ignorePaths, unorderedPaths }
      );
      if (drift.length > 0) kept.push(name);
    }
    return kept.sort();
  } catch {
    return [...names].sort();
  }
}

/**
 * `record` (one a successful `update()` just rebuilt, carrying no unsettled
 * names) with the names {@link unsettledAfterUpdate} could not prove settled
 * put back, warning about them. The rollback revert arms and `cdkd drift
 * --revert` call it after their update, as the deploy's in-place update does.
 */
export async function withUnprovenUnsettled<R extends ResourceState>(
  record: R,
  args: Identity & { names: ReadonlySet<string>; desired: Record<string, unknown> },
  warn: (message: string) => void
): Promise<R> {
  const kept = await unsettledAfterUpdate(args);
  if (kept.length === 0) return record;
  warn(
    safeMsg`${args.logicalId} (${args.resourceType}): the update succeeded, but AWS does not yet show the requested ${kept.join(', ')}; cdkd keeps ${kept.length === 1 ? 'it' : 'them'} unsettled and converges again on the next deploy.`
  );
  return withUnsettledProperties(record, kept);
}

/**
 * go-to-k/cdkd#5487: `prepareRemovalForUpdate`'s unhandled removals, split by
 * cause. A name the convergence step put on the previous side from AWS — the
 * record never held it, so no template declared it — was not "removed from the
 * template": a failed update added it. Each list gets its own warning.
 */
export function splitUnhandledRemovals(
  unhandled: readonly string[],
  recordedPrevious: Record<string, unknown>,
  unsettled: ReadonlySet<string>
): { removedFromTemplate: string[]; addedByFailedUpdate: string[] } {
  const addedByFailedUpdate = unhandled.filter(
    (name) => unsettled.has(name) && !Object.hasOwn(recordedPrevious, name)
  );
  return {
    removedFromTemplate: unhandled.filter((name) => !addedByFailedUpdate.includes(name)),
    addedByFailedUpdate,
  };
}

/** The warning for {@link splitUnhandledRemovals}' `addedByFailedUpdate`. */
export function addedByFailedUpdateWarning(
  logicalId: string,
  resourceType: string,
  names: readonly string[]
): string {
  const one = names.length === 1;
  return safeMsg`${logicalId} (${resourceType}): ${one ? 'property' : 'properties'} ${names.join(', ')} ${one ? 'is' : 'are'} set on the resource but in no template: an earlier failed update applied ${one ? 'it' : 'them'}. cdkd has no default to reset ${one ? 'it' : 'them'} to, so the value stays; remove it by hand if it should not be there.`;
}
