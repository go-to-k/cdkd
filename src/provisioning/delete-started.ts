/**
 * Declare that a provider's `delete()` had already CHANGED the resource when
 * it threw (go-to-k/cdkd#4946).
 *
 * Some deletes strip the resource before the call that deletes it: an IAM
 * role's policies are detached and its inline policies deleted before
 * `DeleteRole`, a rule's targets are removed before `DeleteRule`. When AWS then
 * refuses that last call by name (`AccessDenied`, `DeleteConflict`, ...), the
 * resource survives, but not as it was. The replacement path reads a named
 * refusal as `'kept'` and a rollback re-adopts the survivor with its old
 * properties, so a stripped shell would replace the working new copy with
 * nothing left to show the difference. The mark makes that read
 * `'unconfirmed'`, which refuses and offers `--orphan` instead.
 *
 * Mark once a call that changes what the record describes may have landed,
 * never for a refusal before any (the initial read, an empty list): an
 * unmarked refusal keeps its `'kept'`. Set the flag AFTER a strip call
 * succeeds when its failure propagates (that failure's own name then
 * decides), and BEFORE it when its failure is swallowed and the delete goes
 * on. Over-marking only costs a refusal; under-marking re-adopts a shell.
 *
 * Stamped on `error` itself, non-enumerable and read-only like
 * `markCreatedBeforeFailure`'s mark, so it never serializes and survives
 * `maskSecretsInError`'s descriptor-copying clone. Returns `error`. A
 * primitive or non-extensible throw is left unmarked.
 *
 * A LEAF: no imports, so any provider can use it without an edge into
 * `src/deployment/**`. So is the refusal-by-name read below, which both the
 * replacement verdict and a provider resetting a swallowed strip consult.
 */

const DELETE_STARTED = Symbol.for('cdkd.deleteStarted');

/** Bounded like every other cause-chain walk in cdkd. */
const MAX_DEPTH = 10;

/**
 * What a delete's strip helpers report to it: set once one of them sent a
 * change. Optional on a helper shared with create or update, which pass none.
 */
export interface DeleteProgress {
  stripped: boolean;
}

/** Mark `error` as thrown by a delete that had already changed the resource. */
export function markDeleteStarted<E>(error: E): E {
  try {
    if (typeof error !== 'object' || error === null || !Object.isExtensible(error)) return error;
    Object.defineProperty(error, DELETE_STARTED, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // Unmarkable: left as it is.
  }
  return error;
}

/** Whether any link of `error`'s bounded cause chain carries the mark. Never throws. */
export function isDeleteStarted(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_DEPTH && typeof current === 'object' && current !== null;
      depth++
    ) {
      if ((current as Record<symbol, unknown>)[DELETE_STARTED] === true) return true;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: no mark.
  }
  return false;
}

/**
 * AWS error names that refuse a call outright: it changed nothing and no
 * deletion is running (go-to-k/cdkd#2631). Deliberately narrow — a `Conflict`,
 * a `ResourceInUse` (DynamoDB / Kinesis answer it for a resource already
 * DELETING, e.g. an SDK resend of an accepted delete) or an invalid state can
 * mean "already being deleted", and a waiter that gave up after an accepted
 * delete carries no AWS name at all.
 */
const REFUSAL_NAMES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'AuthorizationError',
  'DependencyViolation',
  'DeleteConflict',
  'DeleteConflictException',
]);

/**
 * Whether AWS refused the call outright, read off the error's bounded `.cause`
 * chain by NAME (`name` / `Code` / `code`), never by message. Never throws.
 */
export function isRefusedByName(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_DEPTH && current != null; depth++) {
      if (typeof current !== 'object') break;
      const link = current as { name?: unknown; Code?: unknown; code?: unknown; cause?: unknown };
      for (const name of [link.name, link.Code, link.code]) {
        if (typeof name === 'string' && REFUSAL_NAMES.has(name)) return true;
      }
      current = link.cause;
    }
  } catch {
    // Unreadable chain: no refusal.
  }
  return false;
}
