/**
 * The per-stack create-token ledger (go-to-k/cdkd#4438).
 *
 * Key: `s3://bucket/{prefix}/{stackName}/{region}/create-tokens.json`, a
 * sibling of `state.json`. Deliberately NOT part of the state schema, for the
 * same reasons the rollback journal is not: no `StackState.version` bump, and
 * old binaries never read it.
 *
 * WHAT IT IS FOR. The FSx `ClientRequestToken`, the EFS `CreationToken` and
 * the CloudFront OAI `CallerReference` bind the token to the resource for its
 * whole life, so the token a create sends decides which resource it gets back.
 * #4428 made them deterministic per stack. That left two cases wrong:
 *
 *  - a resource that survived cdkd's record of it -- kept by a destroy
 *    (RETAIN / RetainExceptOnCreate) or removed by `cdkd orphan` -- held the
 *    token the stack's NEXT create of that logical id sent, so the redeploy
 *    was refused (EFS, FSx) or handed the old resource back (OAI) where the
 *    AWS CDK CLI creates a new one;
 *  - a create interrupted after AWS made the resource but before cdkd recorded
 *    it could not be told apart from those, so its re-run refused the
 *    resource it had itself made.
 *
 * The ledger separates them. `nonce` is folded into every token, and it is
 * replaced exactly when cdkd lets go of resources it made: the ledger is
 * deleted with the state record (`deleteState`: destroy, `state orphan`,
 * export, a rolled-back first deploy), and rotated -- dropping the let-go
 * logical ids' `sent` entries -- by `cdkd orphan` and by a Retain that keeps a
 * resource. `sent` records, BEFORE each create is sent, the token and first
 * send of the latest create of each logical id, and is kept until the stack's
 * lineage ends or the logical id is let go: a re-run after an interruption
 * anywhere in the deploy -- before or after the create returned, before the
 * state record named the resource -- sends the same token and knows when its
 * earlier attempt was first sent. A token in `sent` is only ever held by a
 * resource this lineage made, which is what makes keeping it safe.
 *
 * It holds no secret: a random nonce, logical ids, tokens and timestamps.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Ledger format version, independent of the state schema. */
export const CREATE_TOKEN_LEDGER_VERSION = 1;

/** A create this stack lineage sent. */
export interface SentCreateToken {
  /** The nonce-free token (`stackScopedCreateToken`) the create was derived from. */
  base: string;
  /** The token the create SENT. A later create with the same `base` sends it again. */
  token: string;
  /** Local epoch ms of the create's first send. */
  firstSentAt: number;
}

/** A ledger with a fresh nonce and nothing pending. */
export function emptyCreateTokenLedger(nonce: string): CreateTokenLedgerDoc {
  return {
    ledgerVersion: CREATE_TOKEN_LEDGER_VERSION,
    nonce,
    sent: Object.create(null) as Record<string, SentCreateToken>,
  };
}

/** On-disk shape of `create-tokens.json`. */
export interface CreateTokenLedgerDoc {
  ledgerVersion: number;
  /** Folded into every create token of the stack. */
  nonce: string;
  /** By logical id: the create token this stack lineage last sent for it. */
  sent: Record<string, SentCreateToken>;
  /**
   * Set once a state record of this lineage has been saved. A deploy that
   * finds NO state record but a ledger carrying this flag knows the record
   * was deleted without the ledger -- by a cdkd version that predates it --
   * and starts a fresh ledger instead of resuming: the `sent` entries name
   * creates a destroy may have kept. A first deploy interrupted before any
   * state save never set it, so its re-run still resumes.
   */
  stateRecorded?: boolean;
}

const isSent = (value: unknown): value is SentCreateToken => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['base'] === 'string' &&
    typeof v['token'] === 'string' &&
    typeof v['firstSentAt'] === 'number' &&
    Number.isFinite(v['firstSentAt'])
  );
};

/**
 * Parse a ledger body. Returns `null` for anything this binary does not
 * understand -- an unknown version, a malformed body. The state backend reads
 * that as an UNREADABLE ledger (it throws), so a deploy refuses the creates
 * that need it rather than minting a fresh nonce over a body a newer binary
 * may have written. A malformed `sent` entry is dropped alone.
 */
export function parseCreateTokenLedger(body: string): CreateTokenLedgerDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (doc['ledgerVersion'] !== CREATE_TOKEN_LEDGER_VERSION) return null;
  if (typeof doc['nonce'] !== 'string' || doc['nonce'] === '') return null;
  // Null-prototype: keyed by logical ids read out of a file nothing validates,
  // so a `__proto__` / `constructor` key must stay an ordinary entry.
  const sent: Record<string, SentCreateToken> = Object.create(null);
  const rawSent = doc['sent'];
  if (typeof rawSent === 'object' && rawSent !== null && !Array.isArray(rawSent)) {
    for (const [logicalId, entry] of Object.entries(rawSent)) {
      if (isSent(entry)) {
        sent[logicalId] = {
          base: entry.base,
          token: entry.token,
          firstSentAt: entry.firstSentAt,
        };
      }
    }
  }
  return {
    ledgerVersion: CREATE_TOKEN_LEDGER_VERSION,
    nonce: doc['nonce'],
    sent,
    ...(doc['stateRecorded'] === true && { stateRecorded: true }),
  };
}

/** Told when a stack's state record was saved. Never throws. */
export type StateSavedObserver = (stackName: string, region: string) => Promise<void>;

const stateSavedObserver = new AsyncLocalStorage<StateSavedObserver>();

/**
 * Run `fn` with `observer` told of every state save inside it (the
 * create-token ledger sets {@link CreateTokenLedgerDoc.stateRecorded}).
 */
export function withStateSavedObserver<T>(observer: StateSavedObserver, fn: () => T): T {
  return stateSavedObserver.run(observer, fn);
}

/** `S3StateBackend.saveState` saved `{stackName}/{region}`'s record. */
export async function notifyStateSaved(stackName: string, region: string): Promise<void> {
  await stateSavedObserver.getStore()?.(stackName, region);
}
