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
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { withReplayDeletePrinting, type ReplayOpScope } from './replay-scope.js';

/**
 * AWS error names that refuse a delete outright: the call changed nothing and
 * no deletion is running. Deliberately narrow — a `Conflict`, a
 * `ResourceInUse` (DynamoDB / Kinesis answer it for a resource already
 * DELETING, e.g. an SDK resend of an accepted delete) or an invalid state can
 * mean "already being deleted", and a waiter that gave up after an
 * accepted delete carries no AWS name at all; both stay `'unconfirmed'`.
 */
const DELETE_REFUSAL_NAMES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'AuthorizationError',
  'DependencyViolation',
  'DeleteConflict',
  'DeleteConflictException',
]);

/**
 * go-to-k/cdkd#2631: whether a replaced resource's failed delete was refused
 * by AWS outright (`'kept'`), read off the error's bounded `.cause` chain by
 * NAME (`name` / `Code` / `code`), never by message. Anything else is
 * `'unconfirmed'`: the delete may have been accepted and still be running.
 */
export function replacedDeleteFailureVerdict(error: unknown): 'kept' | 'unconfirmed' {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (typeof current !== 'object') break;
    const link = current as { name?: unknown; Code?: unknown; code?: unknown; cause?: unknown };
    for (const name of [link.name, link.Code, link.code]) {
      if (typeof name === 'string' && DELETE_REFUSAL_NAMES.has(name)) return 'kept';
    }
    current = link.cause;
  }
  return 'unconfirmed';
}

/** How long the read may take; no SDK client here sets a request timeout. */
export const REPLACED_SURVIVOR_PROBE_TIMEOUT_MS = 30_000;

export type ReplacedSurvivorVerdict = 'exists' | 'gone' | 'unreadable' | 'unknown' | 'interrupted';

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
    return Object.keys(read).length > 0 ? 'exists' : 'unreadable';
  } catch {
    return 'unknown';
  }
}
