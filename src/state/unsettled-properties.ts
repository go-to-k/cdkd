/**
 * `ResourceState.unsettledProperties` (state schema v14, go-to-k/cdkd#5380):
 * the top-level property names a failed `update()` had started changing with
 * an irreversible call (`UpdateContext.markUnsettled`). The record keeps the
 * recorded VALUE; the name says only that AWS may no longer hold it, so the
 * next deploy re-sends the key and its provider converges it against AWS.
 *
 * Names only, never a value: a name is a top-level property of the resource
 * type's schema, so this field adds nothing a secret could reach.
 */
import type { ResourceState } from '../types/state.js';

/**
 * The record's unsettled property names. A malformed field (not an array, a
 * non-string or empty entry) reads as none for that entry: an unreadable mark
 * only loses the forced re-send, which is today's behaviour.
 */
export function unsettledPropertiesOf(record: unknown): ReadonlySet<string> {
  if (record === null || typeof record !== 'object') return new Set();
  const value = (record as { unsettledProperties?: unknown }).unsettledProperties;
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  );
}

/**
 * `record` with `names` added to its unsettled set (a union with what it
 * already carries: an earlier failure's names stay unsettled until an update
 * of them succeeds). Returns `record` itself when `names` adds nothing.
 */
export function withUnsettledProperties<R extends ResourceState>(
  record: R,
  names: Iterable<string>
): R {
  const merged = new Set(unsettledPropertiesOf(record));
  const before = merged.size;
  for (const name of names) {
    if (typeof name === 'string' && name !== '') merged.add(name);
  }
  if (merged.size === before && Array.isArray(record.unsettledProperties)) return record;
  if (merged.size === 0) return withoutUnsettledProperties(record);
  return { ...record, unsettledProperties: [...merged].sort() };
}

/**
 * `record` without the field: the writers that know AWS now holds what the
 * record says (a successful update, `--revert-failed`, `drift --accept` /
 * `--revert`). Returns `record` itself when it carries none.
 */
export function withoutUnsettledProperties<R extends ResourceState>(record: R): R {
  if (!Object.hasOwn(record, 'unsettledProperties') && !Object.hasOwn(record, 'unsettledItems')) {
    return record;
  }
  // go-to-k/cdkd#5498: the attempted items go with the names they belong to.
  const { unsettledProperties: _cleared, unsettledItems: _items, ...rest } = record;
  return rest as R;
}

/** go-to-k/cdkd#5498: more entries than this under one path drops the path. */
export const UNSETTLED_ITEMS_PER_PATH_CAP = 100;
/** go-to-k/cdkd#5498: an entry longer than this is dropped. */
export const UNSETTLED_ITEM_LENGTH_CAP = 255;

/** The unsettled top-level key a member path belongs to (`Replicas[x].Y` -> `Replicas`). */
export function unsettledItemsTopKey(path: string): string {
  const cut = path.search(/[.[]/);
  return cut === -1 ? path : path.slice(0, cut);
}

/**
 * go-to-k/cdkd#5498: the record's attempted item names per member path, ONLY
 * under a key the record still names unsettled (a path whose top key settled
 * is dropped). Malformed = none: a non-object field, a non-array path, a path
 * over {@link UNSETTLED_ITEMS_PER_PATH_CAP} entries (the whole path), an entry
 * that is not a non-empty string or is over {@link UNSETTLED_ITEM_LENGTH_CAP}
 * (that entry). A missing name only keeps an item instead of removing it.
 */
export function unsettledItemsOf(record: unknown): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  if (record === null || typeof record !== 'object') return out;
  const value = (record as { unsettledItems?: unknown }).unsettledItems;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  const unsettled = unsettledPropertiesOf(record);
  for (const [path, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!unsettled.has(unsettledItemsTopKey(path))) continue;
    if (!Array.isArray(entries) || entries.length > UNSETTLED_ITEMS_PER_PATH_CAP) continue;
    const names = entries.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry !== '' && entry.length <= UNSETTLED_ITEM_LENGTH_CAP
    );
    if (names.length > 0) out.set(path, new Set(names));
  }
  return out;
}

/**
 * Whether a stored attempted name may match a live item (go-to-k/cdkd#5498):
 * only a name that is neither a secret reference nor a mask. A redacted name
 * names nothing, so its item is kept (and warned about), never removed.
 */
export function isUsableAttemptedName(name: string): boolean {
  return !name.includes('{{resolve:') && !name.includes('***');
}

/**
 * `record` with `items` unioned into its attempted names, kept only under the
 * keys `record` names unsettled (call after {@link withUnsettledProperties}).
 * Returns `record` itself when nothing changes.
 */
export function withUnsettledItems<R extends ResourceState>(
  record: R,
  items: ReadonlyMap<string, Iterable<string>>
): R {
  const merged = new Map<string, Set<string>>();
  for (const [path, names] of unsettledItemsOf(record)) merged.set(path, new Set(names));
  const unsettled = unsettledPropertiesOf(record);
  let added = false;
  for (const [path, names] of items) {
    if (!unsettled.has(unsettledItemsTopKey(path))) continue;
    const set = merged.get(path) ?? new Set<string>();
    for (const name of names) {
      if (typeof name !== 'string' || name === '' || name.length > UNSETTLED_ITEM_LENGTH_CAP)
        continue;
      if (!set.has(name)) {
        set.add(name);
        added = true;
      }
    }
    if (set.size > 0) merged.set(path, set);
  }
  if (!added) return record;
  const field: Record<string, string[]> = {};
  for (const [path, set] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    // Over the cap the reader drops the path, so the write does too.
    if (set.size <= UNSETTLED_ITEMS_PER_PATH_CAP) field[path] = [...set].sort();
  }
  return { ...record, unsettledItems: field };
}

/**
 * `record`'s attempted names restricted to the paths under `keys` — what a
 * rebuilt record carries when only those keys stay unsettled.
 */
export function unsettledItemsField(
  source: unknown,
  keys: Iterable<string>
): { unsettledItems?: Record<string, string[]> } {
  const allowed = new Set(keys);
  const field: Record<string, string[]> = {};
  for (const [path, names] of unsettledItemsOf(source)) {
    if (allowed.has(unsettledItemsTopKey(path))) field[path] = [...names].sort();
  }
  return Object.keys(field).length > 0 ? { unsettledItems: field } : {};
}

/**
 * The `UpdateContext.unsettledProperties` a rollback revert hands `update()`
 * (go-to-k/cdkd#5380): the union of what the records name, spread as nothing
 * when there is none. The revert's record clears the field, so a key it names
 * must be converged against AWS rather than skipped because the two bags
 * agree there.
 */
export function unsettledContextOf(...records: unknown[]): {
  unsettledProperties?: ReadonlySet<string>;
  unsettledItems?: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const names = new Set<string>();
  const items = new Map<string, Set<string>>();
  for (const record of records) {
    for (const name of unsettledPropertiesOf(record)) names.add(name);
    // go-to-k/cdkd#5498: and the attempted names under those keys.
    for (const [path, set] of unsettledItemsOf(record)) {
      const merged = items.get(path) ?? new Set<string>();
      for (const name of set) merged.add(name);
      items.set(path, merged);
    }
  }
  if (names.size === 0) return {};
  return { unsettledProperties: names, ...(items.size > 0 && { unsettledItems: items }) };
}
