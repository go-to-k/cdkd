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
 * stale), so only a separate tag call is noted ({@link recordTagWrite}).
 *
 * The tags are DIFF-applied, so the note holds exactly what the calls that
 * succeeded wrote: keys set with their values, keys removed. On the capture,
 * an answer that does not show that write is re-read on
 * {@link TAGS_BASELINE_REREAD_DELAYS_MS}; every other key, a tag outside the
 * template included, is taken as read. An answer the schedule never settles
 * is recorded with the written keys overlaid ({@link overlayTagWrite}). Every
 * other read takes the first answer.
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

/** What the tag calls of one update wrote to one resource. */
export interface TagWrite {
  /** Keys a `TagResource` set, with the value it sent. */
  set: Map<string, string>;
  /** Keys an `UntagResource` removed. */
  removed: Set<string>;
}

/**
 * Per resource type, per resource (the ARN or physical id the capture reads
 * with), what the running update's successful tag calls wrote. Process-wide:
 * the write and the capture can run on different client objects (a
 * GlobalTable replica's regional client). Held in memory only.
 */
const tagWrites = new Map<string, Map<string, TagWrite>>();

/**
 * Note a tag call for `id` that just SUCCEEDED: `set` for a `TagResource`
 * (key, value), `removed` for an `UntagResource` (keys). Later calls of the
 * same update win per key.
 */
export function recordTagWrite(
  resourceType: string,
  id: string,
  set: ReadonlyArray<readonly [string, string]>,
  removed: readonly string[]
): void {
  let byId = tagWrites.get(resourceType);
  if (byId === undefined) {
    byId = new Map();
    tagWrites.set(resourceType, byId);
  }
  const write = byId.get(id) ?? { set: new Map<string, string>(), removed: new Set<string>() };
  for (const key of removed) {
    write.set.delete(key);
    write.removed.add(key);
  }
  for (const [key, value] of set) {
    write.removed.delete(key);
    write.set.set(key, value);
  }
  byId.set(id, write);
}

/** The tag write noted for `id`, consumed by the capture that reads it. */
export function takeTagWrite(resourceType: string, id: string): TagWrite | undefined {
  const byId = tagWrites.get(resourceType);
  const write = byId?.get(id);
  byId?.delete(id);
  return write;
}

/**
 * Drop the notes of `resourceType` whose id `owned` accepts. Each update
 * calls it before any write: an earlier update that threw was followed by no
 * capture, and its note left behind would make this update's capture re-read.
 */
export function clearTagWrites(resourceType: string, owned: (id: string) => boolean): void {
  const byId = tagWrites.get(resourceType);
  if (byId === undefined) return;
  for (const id of byId.keys()) {
    if (owned(id)) byId.delete(id);
  }
}

/**
 * Whether `arn` names the DynamoDB table `tableName` in one of `regions`: the
 * owner test a table / global table update clears its notes with, so a
 * same-named table in another region (`deploy --all`) keeps its note.
 */
export function isDynamoDBTableArnIn(
  arn: string,
  tableName: string,
  regions: ReadonlySet<string>
): boolean {
  const parts = arn.split(':');
  return (
    parts.length === 6 &&
    parts[2] === 'dynamodb' &&
    regions.has(parts[3] ?? '') &&
    parts[5] === `table/${tableName}`
  );
}

/** Whether a read tag list shows `write`: every set key with its value, every removed key gone. */
export function tagsShowWrite(read: unknown, write: TagWrite): boolean {
  if (!Array.isArray(read)) return false;
  const live = new Map<string, unknown>();
  for (const entry of read) {
    if (typeof entry !== 'object' || entry === null) return false;
    const { Key: key, Value: value } = entry as Record<string, unknown>;
    if (typeof key !== 'string') return false;
    live.set(key, value);
  }
  for (const [key, value] of write.set) if (live.get(key) !== value) return false;
  for (const key of write.removed) if (live.has(key)) return false;
  return true;
}

/**
 * `read` with `write` applied: a removed key dropped, a set key given its
 * written value (in place, or appended in write order). Every other key, a
 * tag outside the template included, is kept as read.
 */
export function overlayTagWrite(read: readonly ReadTag[], write: TagWrite): ReadTag[] {
  const seen = new Set<string>();
  const out: ReadTag[] = [];
  for (const tag of read) {
    if (write.removed.has(tag.Key) || seen.has(tag.Key)) continue;
    seen.add(tag.Key);
    const value = write.set.get(tag.Key);
    out.push(value === undefined ? tag : { Key: tag.Key, Value: value });
  }
  for (const [Key, Value] of write.set) if (!seen.has(Key)) out.push({ Key, Value });
  return out;
}

/**
 * The tag member of the post-write baseline. `first` gets the first answer
 * (or hands over the one the resource read already has); while an answer
 * does not show `write`, `reRead` is asked after each delay.
 *
 * - settled: the answer, as AWS gave it;
 * - never settled (the schedule spent, or a re-read that threw after an
 *   answer): the newest answer with `write` overlaid;
 * - a first read that threw deterministically (`AccessDenied`): the error, as
 *   before this capture re-read; one that threw transiently
 *   ({@link memberReadFailure}) is re-read, and when no read ever answers,
 *   its error is thrown, as before.
 *
 * `terminal` ends the schedule on an answer that is not a tag list (a table
 * gone under the read), returned as is. `onUnsettled` runs once when an
 * overlaid answer is recorded.
 */
export async function settleWrittenTags<T>(
  first: () => Promise<T | ReadTag[]>,
  reRead: () => Promise<T | ReadTag[]>,
  write: TagWrite,
  delaysMs: readonly number[],
  onUnsettled: () => void,
  terminal: (answer: T | ReadTag[]) => boolean = () => false
): Promise<T | ReadTag[]> {
  let newest: ReadTag[] | undefined;
  let firstError: unknown;
  let answered = false;
  // `true` when `answer` ends the schedule as is.
  const take = (answer: T | ReadTag[]): boolean => {
    if (terminal(answer) || tagsShowWrite(answer, write)) return true;
    newest = answer as ReadTag[];
    return false;
  };
  try {
    const answer = await first();
    answered = true;
    if (take(answer)) return answer;
  } catch (err) {
    if (memberReadFailure(err) === 'refused') throw err;
    firstError = err;
  }
  for (const delayMs of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    let answer: T | ReadTag[];
    try {
      answer = await reRead();
    } catch (err) {
      if (!answered && memberReadFailure(err) === 'failed') continue;
      break;
    }
    answered = true;
    if (take(answer)) return answer;
  }
  if (newest === undefined) throw firstError;
  onUnsettled();
  return overlayTagWrite(newest, write);
}

/**
 * The declared `Tags` in the shape the read records: one entry per key (the
 * last declaration of a key wins, as the tag call sends it), values as
 * strings, `aws:` keys dropped as the read drops them; `[]` for none
 * declared. `undefined` for a value that is not a tag list. Read by the drift
 * heal for a baseline captured before #6609.
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
 * Whether a read tag list is EXACTLY the declared set: the same keys with the
 * same values, in any order, `aws:` keys ignored on both sides. A superset (a
 * tag outside the template) or a subset is not.
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
