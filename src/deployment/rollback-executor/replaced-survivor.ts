/**
 * go-to-k/cdkd#2631: whether the OLD resource of a replacement whose cleanup
 * delete was not confirmed (`CompletedOperation.oldResourceMaySurvive`) still
 * exists, read before the reverse replacement re-creates it.
 *
 * The read is the provider's `readCurrentState` — the drift read, which
 * answers `RESOURCE_NOT_FOUND` on AWS's not-found — through the provider the
 * re-create would take. Only that sentinel proves the resource gone. Only a
 * NON-EMPTY property bag proves it there: a few providers answer `{}` without
 * reading AWS at all. The replay refuses anything else rather than guess:
 * `'unreadable'` (no such read for the type, or the empty bag — a re-run
 * meets the same answer) and `'unknown'` (an error, no usable old id, or a
 * read that did not answer in time — a re-run reads again).
 */
import { isDeleteStarted, isRefusedByName } from '../../provisioning/delete-started.js';
import { RESOURCE_NOT_FOUND, type SurvivorIdentityRead } from '../../types/resource.js';
import type { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { withReplayDeletePrinting, type ReplayOpScope } from './replay-scope.js';
import { resolveReplacementOldType } from './plan/classify.js';
import type { CompletedOperation, RollbackExecutorContext } from './types.js';

/**
 * go-to-k/cdkd#2631: whether a replaced resource's failed delete was refused
 * by AWS outright (`'kept'`), by NAME (`isRefusedByName`). Anything else is
 * `'unconfirmed'`: the delete may have been accepted and still be running.
 * So is a refusal from a delete that had already stripped the resource
 * (`markDeleteStarted`, go-to-k/cdkd#4946): what survives is not what the
 * old record describes, so it is never re-adopted.
 */
export function replacedDeleteFailureVerdict(error: unknown): 'kept' | 'unconfirmed' {
  if (isDeleteStarted(error)) return 'unconfirmed';
  return isRefusedByName(error) ? 'kept' : 'unconfirmed';
}

/** How long the read may take; no SDK client here sets a request timeout. */
export const REPLACED_SURVIVOR_PROBE_TIMEOUT_MS = 30_000;

export type ReplacedSurvivorVerdict =
  | 'exists'
  | 'gone'
  | 'unreadable'
  | 'unknown'
  | 'interrupted'
  /**
   * go-to-k/cdkd#6393: AWS reports a resource under the old physical id, but
   * an AWS-minted identity the old record carries differs from it: another
   * resource took the name after the stack's was deleted. Never re-adopted.
   */
  | 'foreign'
  /**
   * go-to-k/cdkd#6621, {@link SURVIVOR_LIVE_READ_TYPES}: what else proves a
   * holder not the stack's: not this account's, in another region than the
   * stack's, a generation other than the journaled one where only a
   * re-create changes it, or absent when the rollback started.
   */
  | 'foreign-account'
  | 'foreign-region'
  | 'foreign-recreated'
  | 'foreign-appeared'
  /**
   * go-to-k/cdkd#6621: this account's resource under the old id, but its
   * generation differs from the journaled one where a configuration write
   * moves it too (an S3 bucket outside us-east-1): modified or re-created,
   * undecidable. Never re-adopted.
   */
  | 'modified';

/** Every verdict naming a holder that is not the stack's resource. */
export function isForeignSurvivor(
  verdict: ReplacedSurvivorVerdict
): verdict is ForeignSurvivorVerdict {
  return verdict.startsWith('foreign');
}
export type ForeignSurvivorVerdict = Extract<ReplacedSurvivorVerdict, `foreign${string}`>;

/**
 * go-to-k/cdkd#6621: types whose old id is a global, AWS-unminted name, so
 * the rollback asks the provider's `replacedSurvivorIdentity` who holds it
 * rather than trusting existence, and the deploy journals the generation it
 * read when it deferred the delete (`oldResourceIdentity`). The value is the
 * region whose generation token only a re-create changes (measured for
 * #6621: an S3 bucket's CreationDate moves on configuration writes
 * elsewhere).
 */
export const SURVIVOR_LIVE_READ_TYPES: Readonly<Record<string, string>> = {
  'AWS::S3::Bucket': 'us-east-1',
};

/** The bound on the deploy's one generation read at a deferral. */
export const DEFERRAL_IDENTITY_TIMEOUT_MS = 10_000;

/**
 * go-to-k/cdkd#6621: the generation to journal beside a `'deferred'` old
 * resource, or `undefined` (a type outside {@link SURVIVOR_LIVE_READ_TYPES},
 * an unanswered or slow read). Never throws.
 */
export async function readDeferralIdentity(
  registry: Pick<ProviderRegistry, 'getProvider'>,
  oldType: string,
  physicalId: string,
  region: string
): Promise<string | undefined> {
  if (SURVIVOR_LIVE_READ_TYPES[oldType] === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = registry.getProvider(oldType);
    if (typeof provider.replacedSurvivorIdentity !== 'function') return undefined;
    const read = await Promise.race([
      provider.replacedSurvivorIdentity(physicalId, oldType, { expectedRegion: region }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), DEFERRAL_IDENTITY_TIMEOUT_MS);
      }),
    ]);
    return read?.kind === 'owned' ? read.identity : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Key of a survivor in `RollbackExecutorContext.survivorIdentities`. */
export function survivorKey(oldType: string, physicalId: string): string {
  return JSON.stringify([oldType, physicalId]);
}

/**
 * go-to-k/cdkd#6621: read who holds each {@link SURVIVOR_LIVE_READ_TYPES}
 * survivor among `ops` BEFORE the replay applies any op, into
 * `ctx.survivorIdentities`: a revert running earlier (a bucket policy put
 * back) would move an S3 bucket's CreationDate outside us-east-1 first. A
 * later snapshot of the same id replaces an earlier one (each segment's
 * before its own replay). Never throws; a probe without a snapshot reads
 * live.
 */
export async function snapshotSurvivorIdentities(
  ctx: RollbackExecutorContext,
  ops: readonly CompletedOperation[]
): Promise<void> {
  const reads: Array<Promise<void>> = [];
  for (const op of ops) {
    if (op.oldResourceMaySurvive === undefined) continue;
    const oldType = resolveReplacementOldType(op);
    const physicalId = op.previousState?.physicalId;
    if (!oldType.ok || SURVIVOR_LIVE_READ_TYPES[oldType.oldType] === undefined) continue;
    if (typeof physicalId !== 'string' || physicalId === '') continue;
    const type = oldType.oldType;
    reads.push(
      liveSurvivorRead(ctx, type, physicalId).then((read) => {
        (ctx.survivorIdentities ??= new Map()).set(survivorKey(type, physicalId), read);
      })
    );
  }
  await Promise.all(reads);
}

/** {@link snapshotSurvivorIdentities} over every segment of a journal. */
export function snapshotSegmentSurvivors(
  ctx: RollbackExecutorContext,
  segments: ReadonlyArray<{ operations: readonly CompletedOperation[] }>
): Promise<void> {
  return snapshotSurvivorIdentities(
    ctx,
    segments.flatMap((segment) => segment.operations)
  );
}

async function liveSurvivorRead(
  ctx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'>,
  oldType: string,
  physicalId: string
): Promise<SurvivorIdentityRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = ctx.providerRegistry.getProvider(oldType);
    if (typeof provider.replacedSurvivorIdentity !== 'function') return { kind: 'unknown' };
    return await Promise.race([
      provider.replacedSurvivorIdentity(physicalId, oldType, { expectedRegion: ctx.region }),
      new Promise<SurvivorIdentityRead>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'unknown' }), REPLACED_SURVIVOR_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { kind: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * go-to-k/cdkd#6393: per type, the recorded attribute holding the identity
 * AWS mints per resource (so a same-named successor carries another one),
 * whose value is exactly the token that type's SDK provider's
 * `resourceIdentity` reads live (#4655). A type whose physical id is already
 * AWS-minted (a KMS key id) needs none; one whose every id is name-derived
 * (an SNS topic ARN) has none to compare. Add a type only when its SDK
 * provider records the attribute at create and its `resourceIdentity` token
 * equals it.
 */
export const SURVIVOR_IDENTITY_ATTRIBUTES: Readonly<Record<string, string>> = {
  'AWS::IAM::Role': 'RoleId',
};

/** How often a running read checks for an interrupted rollback. */
const INTERRUPT_POLL_MS = 250;

/**
 * Read AWS for the replacement's old resource: `prev.physicalId` of `oldType`,
 * routed by the old record's `provisionedBy`. Never throws. An interrupted
 * rollback (`isInterrupted`) sends no read, and stops waiting for one: both
 * answer `'interrupted'`, which refuses the op with the journal kept.
 */
export async function probeReplacedSurvivor(
  s: Pick<ReplayOpScope, 'op' | 'ctx' | 'secrets' | 'isInterrupted'>,
  oldType: string,
  timeoutMs: number = REPLACED_SURVIVOR_PROBE_TIMEOUT_MS
): Promise<ReplacedSurvivorVerdict> {
  if (s.isInterrupted?.() === true) return 'interrupted';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopped = new Promise<'unknown' | 'interrupted'>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
    if (s.isInterrupted !== undefined) {
      const interrupted = s.isInterrupted;
      poll = setInterval(() => {
        if (interrupted()) resolve('interrupted');
      }, INTERRUPT_POLL_MS);
    }
  });
  try {
    return await Promise.race([readSurvivor(s, oldType), stopped]);
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
}

async function readSurvivor(
  s: Pick<ReplayOpScope, 'op' | 'ctx' | 'secrets'>,
  oldType: string
): Promise<ReplacedSurvivorVerdict> {
  const prev = s.op.previousState;
  const physicalId = prev?.physicalId;
  if (typeof physicalId !== 'string' || physicalId === '') return 'unknown';
  const existence = await readExistence(s, physicalId, oldType);
  if (existence === 'gone') return 'gone';
  if (SURVIVOR_LIVE_READ_TYPES[oldType] !== undefined) {
    return holderVerdict(s, physicalId, oldType, existence);
  }
  return existence === 'exists' ? identityVerdict(s, physicalId, oldType) : existence;
}

async function readExistence(
  s: Pick<ReplayOpScope, 'op' | 'ctx' | 'secrets'>,
  physicalId: string,
  oldType: string
): Promise<'exists' | 'gone' | 'unreadable' | 'unknown'> {
  const prev = s.op.previousState;
  try {
    const { provider } = s.ctx.providerRegistry.getProviderFor({
      resourceType: oldType,
      provisionedBy: prev?.provisionedBy,
    });
    if (typeof provider.readCurrentState !== 'function') return 'unreadable';
    const read = await withReplayDeletePrinting(s, () =>
      provider.readCurrentState!(physicalId, s.op.logicalId, oldType, prev?.properties)
    );
    if (read === RESOURCE_NOT_FOUND) return 'gone';
    // `undefined` is the contract's "not implemented" for this type.
    if (read === undefined) return 'unreadable';
    if (typeof read !== 'object' || read === null || Array.isArray(read)) return 'unknown';
    if (Object.keys(read).length === 0) return 'unreadable';
    return 'exists';
  } catch {
    return 'unknown';
  }
}

/**
 * go-to-k/cdkd#6621: a {@link SURVIVOR_LIVE_READ_TYPES} survivor, judged by
 * who holds its id: the read `snapshotSurvivorIdentities` took before the
 * replay applied any op, else a live one. A holder proven not the stack's is
 * foreign whatever the existence read answered (another account's bucket
 * fails it). Otherwise the existence read decides, then the generation: a
 * journaled one must equal the live one; none journaled (an older binary's
 * journal, an unanswered read at the deferral) keeps the re-adopt, as the
 * IAM arm does for a record without its RoleId.
 */
async function holderVerdict(
  s: Pick<ReplayOpScope, 'op' | 'ctx' | 'secrets'>,
  physicalId: string,
  oldType: string,
  existence: 'exists' | 'unreadable' | 'unknown'
): Promise<ReplacedSurvivorVerdict> {
  const snapshot = s.ctx.survivorIdentities?.get(survivorKey(oldType, physicalId));
  const read =
    snapshot ??
    (await withReplayDeletePrinting(s, () => liveSurvivorRead(s.ctx, oldType, physicalId)));
  if (read.kind === 'foreign') {
    return read.seen === 'other-account' ? 'foreign-account' : 'foreign-region';
  }
  if (existence !== 'exists') return existence;
  // Absent at the snapshot, there now: it appeared during this rollback.
  // A live read finding it gone saw it go between the two reads.
  if (read.kind === 'gone') return snapshot !== undefined ? 'foreign-appeared' : 'gone';
  if (read.kind === 'unknown') return 'unknown';
  const journaled = s.op.oldResourceIdentity;
  if (journaled === undefined) return 'exists';
  if (read.identity === undefined) return 'unknown';
  if (read.identity === journaled) return 'exists';
  const stableRegion = SURVIVOR_LIVE_READ_TYPES[oldType];
  return journaled.split('|')[0] === stableRegion ? 'foreign-recreated' : 'modified';
}

/**
 * go-to-k/cdkd#6393: the live resource under the old physical id, judged
 * against the identity the old record carries: `'foreign'` only when both
 * are known and differ, `'gone'` when the identity read finds nothing (it
 * went between the two reads). Anything less (no table entry, nothing
 * recorded or a masked value, no `resourceIdentity`, a failed or undecided
 * read) answers `'exists'`, the existence-only verdict it had before.
 *
 * Read through the TYPE's provider, not the record's route: a Cloud Control
 * record's provider has no `resourceIdentity`, and the token is the type's.
 */
async function identityVerdict(
  s: Pick<ReplayOpScope, 'op' | 'ctx' | 'secrets'>,
  physicalId: string,
  oldType: string
): Promise<'exists' | 'gone' | 'foreign'> {
  const key = SURVIVOR_IDENTITY_ATTRIBUTES[oldType];
  if (key === undefined) return 'exists';
  const recorded = s.op.previousState?.attributes?.[key];
  if (typeof recorded !== 'string' || recorded === '' || recorded.includes('***')) return 'exists';
  try {
    const provider = s.ctx.providerRegistry.getProvider(oldType);
    if (typeof provider.resourceIdentity !== 'function') return 'exists';
    const live = await withReplayDeletePrinting(s, () =>
      provider.resourceIdentity!(physicalId, oldType, { expectedRegion: s.ctx.region })
    );
    if (live === RESOURCE_NOT_FOUND) return 'gone';
    return typeof live === 'string' && live !== '' && live !== recorded ? 'foreign' : 'exists';
  } catch {
    return 'exists';
  }
}
