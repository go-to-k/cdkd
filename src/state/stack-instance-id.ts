/**
 * The per-stack-instance id (state schema v13, go-to-k/cdkd#5064).
 *
 * `StackState.stackInstanceId` names one LIFETIME of a stack: minted with
 * `crypto.randomUUID()` at the stack's first state write, kept until its
 * record is deleted. A recreated stack gets a new one. A record without it is
 * a LEGACY stack and stays legacy: nothing mints an id for a stack that
 * already has a record.
 *
 * WRITE-AHEAD SIBLING. A first deploy writes `state.json` only at its end, so
 * the id is first written to `{prefix}/{stackName}/{region}/stack-instance.json`
 * -- under the stack lock, before any resource create, with `If-None-Match: *`
 * -- and a re-run after a crash READS it back instead of minting a fresh one.
 * It is read only while `state.json` is absent, so an ordinary deploy makes no
 * extra call. `S3StateBackend` deletes it right after the first state save
 * that carries its id, and with the record (`deleteState`). Like the
 * create-token ledger it is NOT part of the state schema: its own
 * `stackInstanceVersion`, no `StackState.version` bump.
 *
 * The id is NEVER logged or put in an error message: the names a later cdkd
 * derives from it must not be predictable from a log.
 */

/** Sibling format version, independent of the state schema. */
export const STACK_INSTANCE_SIBLING_VERSION = 1;

/** The sibling's file name, beside `state.json`. */
export const STACK_INSTANCE_SIBLING_FILE = 'stack-instance.json';

/** On-disk shape of `stack-instance.json`. */
export interface StackInstanceSiblingDoc {
  stackInstanceVersion: number;
  stackInstanceId: string;
}

/** What `crypto.randomUUID()` produces (RFC 4122 v4), lowercase. */
const STACK_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Is `value` a well-formed stack instance id? */
export function isStackInstanceId(value: unknown): value is string {
  return typeof value === 'string' && STACK_INSTANCE_ID_PATTERN.test(value);
}

/** The sibling body for `id`. */
export function stackInstanceSiblingBody(id: string): string {
  const doc: StackInstanceSiblingDoc = {
    stackInstanceVersion: STACK_INSTANCE_SIBLING_VERSION,
    stackInstanceId: id,
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse a sibling body. `null` for anything this binary does not understand
 * (an unknown version, a malformed body or id): the caller refuses rather than
 * minting over a body a newer binary may have written.
 */
export function parseStackInstanceSibling(body: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (doc['stackInstanceVersion'] !== STACK_INSTANCE_SIBLING_VERSION) return null;
  return isStackInstanceId(doc['stackInstanceId']) ? doc['stackInstanceId'] : null;
}

/** A recorded `stackInstanceId` that is not a well-formed id. */
export class MalformedStackInstanceIdError extends Error {
  constructor(stackLabel: string) {
    // The value is never echoed: it may be the id itself, slightly damaged.
    super(
      `The state record of ${stackLabel} holds a stackInstanceId that is not a well-formed id. ` +
        'cdkd does not guess which lifetime of the stack it names, since names derive from it; ' +
        'restore the field from an earlier version of state.json.'
    );
    this.name = 'MalformedStackInstanceIdError';
  }
}

/**
 * The stack instance id a record carries: `undefined` for a legacy record
 * (absent field). A PRESENT value that is not a well-formed id throws
 * {@link MalformedStackInstanceIdError}: reading it as absent would turn the
 * stack legacy, which is the direction a later name derivation must not take
 * silently.
 */
export function stackInstanceIdOf(
  state: { stackInstanceId?: unknown } | null | undefined,
  stackLabel: string
): string | undefined {
  const value = state?.stackInstanceId;
  if (value === undefined) return undefined;
  if (!isStackInstanceId(value)) throw new MalformedStackInstanceIdError(stackLabel);
  return value;
}

/** What `cdkd state show --json` prints in place of a recorded id. */
export const STACK_INSTANCE_ID_WITHHELD = '<withheld>';

/**
 * `state` for DISPLAY: a recorded id replaced by
 * {@link STACK_INSTANCE_ID_WITHHELD} (its presence still says the stack is not
 * a legacy one), an absent one left absent. Output a user may paste into an
 * issue or a CI log must not carry the id the stack's names derive from.
 */
export function withStackInstanceIdWithheld<T extends { stackInstanceId?: unknown }>(state: T): T {
  if (state === null || typeof state !== 'object' || state.stackInstanceId === undefined) {
    return state;
  }
  return { ...state, stackInstanceId: STACK_INSTANCE_ID_WITHHELD };
}
