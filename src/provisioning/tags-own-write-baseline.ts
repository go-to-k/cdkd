/**
 * The `Tags` drift baseline the deploy captures right after cdkd's own tag
 * write (`ReadCurrentStateContext.afterOwnWrite`, go-to-k/cdkd#6609), for the
 * tag reads that MEASURED a lag behind `TagResource` / `UntagResource`.
 *
 * Measured in us-east-1 (2026-11-20, reads every ~200 ms for 4 s after each
 * write, three rounds): DynamoDB `ListTagsOfResource` answered the previous
 * tags for up to ~2.5 s after a tag, a re-tag or an untag; Secrets Manager
 * `DescribeSecret` missed a just-written tag on single reads, then showed it
 * again. Taken as the baseline, the previous tags make `cdkd drift` report an
 * untouched resource and `drift --revert` put them back. A tag sent inside
 * `CreateTable` / `CreateSecret` read back on the first read (0 of 101 reads
 * stale), so only an UPDATE's tag call is noted ({@link recordTagWrite}).
 *
 * On that capture, and only when THIS update sent a tag call for the
 * resource, an answer that is not the declared tag set is re-read on
 * {@link TAGS_BASELINE_REREAD_DELAYS_MS}; one matching answer settles it. A
 * declared set the schedule never sees is KEPT, in the read's shape
 * ({@link declaredTagsReadback}). Every other read takes the first answer.
 */
import { memberReadFailure } from './settle-after-own-write.js';
import { readTagList } from './tag-list.js';

/**
 * Waits between re-reads of a disagreeing answer: five reads, 7.5 s at most,
 * spent only when the first answer disagrees. The measured DynamoDB lag
 * reached ~2.5 s; a measurement, not a documented bound.
 */
export const TAGS_BASELINE_REREAD_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];

/** A tag as the reads record it (`normalizeAwsTagsToCfn`). */
export interface ReadTag {
  Key: string;
  Value: string;
}

/**
 * Per resource type, the resources whose tags the running update wrote (the
 * ARN or physical id the capture reads with). Process-wide: the write and the
 * capture can run on different client objects (a GlobalTable replica's
 * regional client).
 */
const tagWrites = new Map<string, Set<string>>();

/** Note that a tag call for `id` just succeeded in an update. */
export function recordTagWrite(resourceType: string, id: string): void {
  let ids = tagWrites.get(resourceType);
  if (ids === undefined) {
    ids = new Set();
    tagWrites.set(resourceType, ids);
  }
  ids.add(id);
}

/** Whether a tag write was noted for `id`, consumed by the capture that reads it. */
export function takeTagWrite(resourceType: string, id: string): boolean {
  return tagWrites.get(resourceType)?.delete(id) === true;
}

/**
 * Drop the notes of `resourceType` whose id `owned` accepts. Each update
 * calls it before any write: an earlier update that threw was followed by no
 * capture, and its note left behind would make this update's capture re-read
 * and keep the declared tags over an out-of-band change.
 */
export function clearTagWrites(resourceType: string, owned: (id: string) => boolean): void {
  const ids = tagWrites.get(resourceType);
  if (ids === undefined) return;
  for (const id of ids) {
    if (owned(id)) ids.delete(id);
  }
}

/**
 * The declared `Tags` in the shape the read records: one entry per key (the
 * last declaration of a key wins, as the tag call sends it), values as
 * strings, `aws:` keys dropped as the read drops them; `[]` for none
 * declared. `undefined` when the value is not a tag list the update would
 * send, so nothing can be settled on.
 */
export function declaredTagsReadback(desired: unknown): ReadTag[] | undefined {
  const read = readTagList(desired, 'desired');
  if (read.kind !== 'tags') return undefined;
  const byKey = new Map<string, string>();
  for (const tag of read.tags) byKey.set(tag.Key, tag.Value);
  return [...byKey]
    .filter(([key]) => !key.startsWith('aws:'))
    .map(([Key, Value]) => ({ Key, Value }));
}

/**
 * Whether a read tag list is exactly the declared set: the same keys with the
 * same values, in any order, `aws:` keys ignored on both sides. The ONE
 * comparator the post-write capture settles on and the drift heal skips on.
 */
export function tagsMatchDeclared(read: unknown, declared: readonly ReadTag[]): boolean {
  if (!Array.isArray(read)) return false;
  const live = new Map<string, unknown>();
  for (const entry of read) {
    if (typeof entry !== 'object' || entry === null) return false;
    const { Key: key, Value: value } = entry as Record<string, unknown>;
    if (typeof key !== 'string') return false;
    if (!key.startsWith('aws:')) live.set(key, value);
  }
  const want = declared.filter((t) => !t.Key.startsWith('aws:'));
  return live.size === want.length && want.every((t) => live.get(t.Key) === t.Value);
}

/**
 * The tag member of the post-write baseline. `first` is the answer the
 * resource read already has (or the call that gets it); while an answer is
 * not `declared`, `reRead` is asked after each delay.
 *
 * - settled: the matching answer, as AWS gave it;
 * - never settled (the schedule spent, or a re-read that threw): `declared`;
 * - a first read that threw transiently ({@link memberReadFailure}):
 *   `declared`; one that threw deterministically (`AccessDenied`): the
 *   error, as before this capture re-read.
 *
 * `settled` lets a caller end the schedule on an answer that is not a tag
 * list (a table gone under the read). `onUnsettled` runs once on every arm
 * that did not settle.
 */
export async function settleWrittenTags<T>(
  first: () => Promise<T | ReadTag[]>,
  reRead: () => Promise<T | ReadTag[]>,
  declared: ReadTag[],
  delaysMs: readonly number[],
  onUnsettled: () => void,
  settled: (answer: T | ReadTag[]) => boolean = () => false
): Promise<T | ReadTag[]> {
  const done = (answer: T | ReadTag[]): boolean =>
    settled(answer) || tagsMatchDeclared(answer, declared);
  let answer: T | ReadTag[];
  try {
    answer = await first();
  } catch (err) {
    if (memberReadFailure(err) === 'refused') throw err;
    onUnsettled();
    return declared;
  }
  if (done(answer)) return answer;
  for (const delayMs of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      answer = await reRead();
    } catch {
      break;
    }
    if (done(answer)) return answer;
  }
  onUnsettled();
  return declared;
}
