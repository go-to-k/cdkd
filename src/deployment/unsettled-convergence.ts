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
import {
  isUsableAttemptedName,
  withUnsettledItems,
  withUnsettledProperties,
} from '../state/unsettled-properties.js';
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
  args: Identity & {
    desired?: Record<string, unknown>;
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>;
  },
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
      recordedProperties,
      args.desired,
      args.attemptedItems
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
      `and ${why} — nothing was updated. Re-run the deploy once the resource has settled` +
      // The escape hatch is named only where it exists: `cdkd drift` reads a
      // resource through `readCurrentState`, and its --accept records what AWS
      // holds (clearing the names) once nothing is still changing.
      (args.provider.readCurrentState !== undefined
        ? ", or, to keep what AWS holds instead, run 'cdkd drift --accept' once it has."
        : '.'),
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
  args: Identity & {
    names: ReadonlySet<string>;
    previous: Record<string, unknown>;
    /** The bag the update sends, for a read that projects onto what it names. */
    desired?: Record<string, unknown>;
    /** go-to-k/cdkd#5498: the record's attempted names per member path. */
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>;
  }
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
  // go-to-k/cdkd#5498: an unsettled merge key (`Tags`) with attempted names
  // needs the live read too, to remove exactly the attempted entries AWS holds.
  const attemptedTags = [...(args.attemptedItems?.get('Tags') ?? [])].filter(isUsableAttemptedName);
  const mergeNeedsLive = names.has('Tags') && attemptedTags.length > 0;
  if (substituted.size === 0 && !mergeNeedsLive) return previous;
  let live: Awaited<ReturnType<typeof readLive>>;
  try {
    live = await readLive(args, substituted.size > 0 ? substituted : new Set(['Tags']));
  } catch (error) {
    // Only the attempted tags needed the read: a missing name only KEEPS a
    // tag, so a failed read converges as before #5498 (the record's side).
    if (substituted.size === 0) return previous;
    if (error instanceof ProvisioningError) throw error;
    const wrapped = refusal(args, substituted, 'the resource could not be read to converge it');
    if (error instanceof Error) (wrapped as { cause?: unknown }).cause = error;
    throw wrapped;
  }
  if (live === undefined) return previous;
  if (live === 'unreadable') {
    if (substituted.size === 0) return previous;
    throw refusal(args, substituted, 'the resource could not be read to converge it');
  }
  const out = { ...previous };
  for (const name of substituted) {
    if (Object.hasOwn(live, name) && live[name] !== undefined) out[name] = live[name];
    else delete out[name];
  }
  if (mergeNeedsLive) {
    const withAttempted = withAttemptedTags(
      out['Tags'],
      live['Tags'],
      args.desired?.['Tags'],
      attemptedTags
    );
    if (withAttempted !== undefined) out['Tags'] = withAttempted;
  }
  return out;
}

/**
 * go-to-k/cdkd#5498: the recorded tags plus each live tag an earlier failed
 * update was accepted for adding (exact key, not redacted) that neither the
 * record nor the template declares — so the provider's own diff (previous vs
 * desired) removes exactly those and nothing else. List shape (`[{Key,
 * Value}]`) only; any other shape is left as recorded (`undefined`).
 */
function withAttemptedTags(
  recorded: unknown,
  live: unknown,
  desired: unknown,
  attempted: readonly string[]
): unknown[] | undefined {
  const keysOf = (value: unknown): Set<string> | undefined => {
    if (value === undefined || value === null) return new Set();
    if (!Array.isArray(value)) return undefined;
    const keys = new Set<string>();
    for (const entry of value) {
      const key = (entry as { Key?: unknown } | null)?.Key;
      if (typeof key !== 'string') return undefined;
      keys.add(key);
    }
    return keys;
  };
  const recordedKeys = keysOf(recorded);
  const desiredKeys = keysOf(desired);
  if (recordedKeys === undefined || desiredKeys === undefined || !Array.isArray(live))
    return undefined;
  const removable = live.filter((entry) => {
    const key = (entry as { Key?: unknown } | null)?.Key;
    return (
      typeof key === 'string' &&
      attempted.includes(key) &&
      !recordedKeys.has(key) &&
      !desiredKeys.has(key)
    );
  });
  if (removable.length === 0) return undefined;
  return [...((recorded as unknown[] | undefined) ?? []), ...removable];
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
  args: Identity & {
    names: ReadonlySet<string>;
    desired: Record<string, unknown>;
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>;
  }
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
  args: Identity & {
    names: ReadonlySet<string>;
    desired: Record<string, unknown>;
    /**
     * go-to-k/cdkd#5498: the attempted names of every record the caller read
     * (`unsettledContextOf(...)`); a kept key keeps its own.
     */
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>;
  },
  warn: (message: string) => void
): Promise<R> {
  const kept = await unsettledAfterUpdate(args);
  if (kept.length === 0) return record;
  warn(
    safeMsg`${args.logicalId} (${args.resourceType}): the update succeeded, but AWS does not yet show the requested ${kept.join(', ')}; cdkd keeps ${kept.length === 1 ? 'it' : 'them'} unsettled and converges again on the next deploy.`
  );
  const withNames = withUnsettledProperties(record, kept);
  // go-to-k/cdkd#5498: only the kept keys' attempted names, never the others'.
  // `withUnsettledItems` writes a path only under a name the record holds.
  return withUnsettledItems(withNames, args.attemptedItems ?? new Map());
}

/**
 * go-to-k/cdkd#5505: the automatic rollback's bounded wait before it reverts
 * what a failed update left unsettled. Polls `unsettledInTransition` until no
 * name is moving (`'settled'`), the bound passes (`'moving'`), or
 * `isInterrupted` answers true (`'interrupted'`). A provider without the hook
 * has nothing to wait for. A hook that throws counts as moving: the revert
 * never diffs a value it could not confirm at rest. `running` (the failed
 * update's own call, when the deadline abandoned it) is waited for first,
 * inside the same bound: until it returns it may still write.
 */
export async function waitForUnsettledSettled(
  args: Identity & {
    names: ReadonlySet<string>;
    timeoutMs: number;
    pollMs: number;
    isInterrupted: () => boolean;
    running?: Promise<unknown> | undefined;
  }
): Promise<'settled' | 'moving' | 'interrupted'> {
  const { provider, names } = args;
  const deadline = Date.now() + args.timeoutMs;
  if (args.running !== undefined) {
    let returned = false;
    const done = args.running.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      }
    );
    while (!returned) {
      if (args.isInterrupted()) return 'interrupted';
      const left = deadline - Date.now();
      if (left <= 0) return 'moving';
      await Promise.race([
        done,
        new Promise((resolve) => setTimeout(resolve, Math.min(250, left))),
      ]);
    }
  }
  if (provider.unsettledInTransition === undefined || names.size === 0) return 'settled';
  for (;;) {
    if (args.isInterrupted()) return 'interrupted';
    let moving = true;
    try {
      const inTransition = await provider.unsettledInTransition(
        args.physicalId,
        args.logicalId,
        args.resourceType,
        names,
        args.recordedProperties
      );
      moving = inTransition.size > 0;
    } catch {
      // Unconfirmed: keep waiting, then keep the names.
    }
    if (!moving) return 'settled';
    const left = deadline - Date.now();
    if (left <= 0) return 'moving';
    // Slept in short slices so a Ctrl-C ends the wait promptly.
    const until = Date.now() + Math.min(args.pollMs, left);
    while (Date.now() < until) {
      if (args.isInterrupted()) return 'interrupted';
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
    }
  }
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
