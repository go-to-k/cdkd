import { type RecordedSecretValues } from './pairs.js';
import { sideSetOf } from './mask-only.js';

/**
 * The PHYSICAL IDS a pass read through `Ref` / `Fn::GetAtt` (go-to-k/cdkd#4810),
 * keyed by the pass's map like the log-only set.
 *
 * A physical id is stored in plaintext by design (it is how cdkd finds the
 * resource again), and a reader's copy of it is too: an `AWS::SQS::QueuePolicy`'s
 * `Queues` URL is what its provider deletes by. When the reader's own bag also
 * holds a plaintext that occurs inside that id (a queue NAMED from a secret,
 * whose ARN the reader re-resolved, or a literal `{{resolve:` reference beside
 * it), the persist-time value scan rewrote the copy into the reference, and the
 * next `cdkd destroy` sent `https://sqs.../{{resolve:...}}` to AWS.
 *
 * So the value scan KEEPS a recorded-plaintext match that lies inside an
 * occurrence of one of these ids, and a leaf equal to one. Nothing new reaches
 * state: the id itself is in the producer's record. A match straddling an
 * occurrence's edge, or outside every occurrence, is still replaced.
 */
export const physicalNameCopiesOf = new WeakMap<RecordedSecretValues, Set<string>>();

/** Record `physicalId` as a name the pass that owns `secrets` copied (see {@link physicalNameCopiesOf}). */
export function recordPhysicalNameCopy(secrets: RecordedSecretValues, physicalId: string): void {
  if (physicalId === '') return;
  sideSetOf(physicalNameCopiesOf, secrets).add(physicalId);
}

/** The `[start, end)` spans of every occurrence of a recorded physical name in `value`. */
export function physicalNameSpans(
  names: ReadonlySet<string> | undefined,
  value: string
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  if (names === undefined) return spans;
  for (const name of names) {
    for (let at = value.indexOf(name); at !== -1; at = value.indexOf(name, at + 1)) {
      spans.push({ start: at, end: at + name.length });
    }
  }
  return spans;
}
