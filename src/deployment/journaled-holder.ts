/**
 * go-to-k/cdkd#6655 / go-to-k/cdkd#6668: whether the name a replaced
 * resource's deferred delete addresses still holds the resource the deploy
 * replaced, judged against the generation read when the delete was deferred
 * (go-to-k/cdkd#6621, `readDeferralIdentity`). One helper for every delete
 * that addresses such a name: the deploy's cleanup phase
 * (`deleteReplacedAfterCreate`) and a superseded entry's carried delete in a
 * later deploy or `cdkd destroy` (`deleteSupersededEntry`).
 */
import {
  DEFERRAL_IDENTITY_TIMEOUT_MS,
  SURVIVOR_LIVE_READ_TYPES,
} from './rollback-executor/replaced-survivor.js';
import type { ResourceProvider, SurvivorIdentityRead } from '../types/resource.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';

/**
 * How often a holder that did not answer is read, and the wait between
 * reads. Mutable for tests only.
 */
export const journaledHolderRead = { attempts: 3, delayMs: 2_000 };

/**
 * What the holder read proves about the name:
 *
 * - `'ours'`: the journaled generation holds it, or one the type cannot tell
 *   apart from it (another generation outside the region where only a
 *   re-create moves it; there configuration writes move it too, so a
 *   same-account re-create is not caught). Send the delete.
 * - `'gone'`: nothing holds the name. No delete is needed; one would only
 *   race whoever takes the name next.
 * - `{ notOurs }`: PROVEN another resource: another account, another region,
 *   or another generation where only a re-create moves it (us-east-1 for S3:
 *   versioning, tagging, encryption and policy writes, #4606 / #6621, and a
 *   policy's delete and an object's put and delete, measured for #6671, leave
 *   CreationDate alone). `notOurs` names the attribute, never its value.
 * - `'unreadable'` / `'interrupted'`: no read answered, after
 *   {@link journaledHolderRead} attempts or an interrupt. A later run may
 *   answer, so the entry is kept; never a reason to delete by name.
 * - `{ incomparable }`: the comparison can NEVER be made, so every run
 *   would repeat it (a token naming another region than the read's, a
 *   malformed one, a type with no holder read). Kept, the entry would never
 *   leave state; the caller warns, naming `incomparable` (never a value),
 *   and sends the by-name delete an entry without `identity` gets.
 */
export type HolderJudgement =
  | 'ours'
  | 'gone'
  | UnreadHolder
  | { notOurs: 'owning account' | 'region' | 'creation time' }
  | { incomparable: string };

/** A judgement that sends nothing and keeps the entry. */
export type UnreadHolder = 'unreadable' | 'interrupted';

export function isUnreadHolder(judged: HolderJudgement): judged is UnreadHolder {
  return judged === 'unreadable' || judged === 'interrupted';
}

/**
 * Read who holds `physicalId` through the TYPE's provider (a Cloud
 * Control-routed record's provider has no `replacedSurvivorIdentity`) and
 * judge it against `journaled`. Never throws.
 */
export async function judgeJournaledHolder(input: {
  provider: () => Pick<ResourceProvider, 'replacedSurvivorIdentity'>;
  resourceType: string;
  physicalId: string;
  region: string;
  journaled: string;
  interrupted: () => boolean;
}): Promise<HolderJudgement> {
  // The token is `<region>|<generation>`, read in the stack's region. One
  // naming another region (a hand edit, a record whose region was lost)
  // compares with nothing, in this run or any later one.
  if (input.journaled.split('|')[0] !== canonicalizeRegion(input.region)) {
    return { incomparable: "the recorded generation names another region than the stack's" };
  }
  try {
    if (typeof input.provider().replacedSurvivorIdentity !== 'function') {
      return { incomparable: 'cdkd reads no holder for this resource type' };
    }
  } catch {
    return { incomparable: 'cdkd reads no holder for this resource type' };
  }
  let judged: HolderJudgement = 'unreadable';
  for (let attempt = 0; attempt < journaledHolderRead.attempts; attempt++) {
    if (attempt > 0) {
      if (input.interrupted()) return 'interrupted';
      await new Promise((resolve) => setTimeout(resolve, journaledHolderRead.delayMs));
    }
    judged = judge(await readHolder(input), input.journaled, input.resourceType);
    if (judged !== 'unreadable') break;
  }
  return judged;
}

/**
 * Why no delete was sent for a holder that was not read, as a clause after
 * "was not deleted: " or "No delete was sent: ".
 */
export function unreadHolderCause(judged: UnreadHolder): string {
  return judged === 'interrupted'
    ? 'the run was interrupted before cdkd could read what holds that name now to confirm it is the resource the deploy replaced'
    : 'cdkd could not read what holds that name now to confirm it is the resource the deploy replaced';
}

/** The warning for an {@link HolderJudgement} `incomparable`, as a clause. */
export function incomparableHolderNote(reason: string): string {
  return (
    `cdkd cannot compare what holds that name now with the generation it recorded (${reason}), ` +
    `so the delete is sent by name, as for an entry recorded without one`
  );
}

/** Why no delete was sent for a holder proven not the replaced resource, as a clause. */
export function notOursHolderCause(resourceType: string, attribute: string): string {
  return (
    `the ${resourceType} now under that name is not the one the deploy replaced (its ` +
    `${attribute} differs from what cdkd read when it deferred the delete), so no delete was ` +
    `sent and that resource was left alone`
  );
}

async function readHolder(input: {
  provider: () => Pick<ResourceProvider, 'replacedSurvivorIdentity'>;
  resourceType: string;
  physicalId: string;
  region: string;
}): Promise<SurvivorIdentityRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = input.provider();
    if (typeof provider.replacedSurvivorIdentity !== 'function') return { kind: 'unknown' };
    return await Promise.race([
      provider.replacedSurvivorIdentity(input.physicalId, input.resourceType, {
        expectedRegion: input.region,
      }),
      new Promise<SurvivorIdentityRead>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'unknown' }), DEFERRAL_IDENTITY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { kind: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

function judge(
  read: SurvivorIdentityRead,
  journaled: string,
  resourceType: string
): HolderJudgement {
  switch (read.kind) {
    case 'gone':
      return 'gone';
    case 'foreign':
      return { notOurs: read.seen === 'other-account' ? 'owning account' : 'region' };
    case 'unknown':
      return 'unreadable';
    case 'owned': {
      if (read.identity === undefined) return 'unreadable';
      if (read.identity === journaled) return 'ours';
      // Only where a re-create alone moves the generation does a difference
      // prove another resource.
      const stable = journaled.split('|')[0] === SURVIVOR_LIVE_READ_TYPES[resourceType];
      return stable ? { notOurs: 'creation time' } : 'ours';
    }
  }
}
