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
  if (!Object.hasOwn(record, 'unsettledProperties')) return record;
  const { unsettledProperties: _cleared, ...rest } = record;
  return rest as R;
}
