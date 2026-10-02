import { AsyncLocalStorage } from 'node:async_hooks';
import type { RollbackJournal } from '../types/rollback-journal.js';

/**
 * Evidence that THIS stack attempted a resource before the current operation
 * (go-to-k/cdkd#4355): the property bags its rollback journal recorded for the
 * logical id, from a deploy that failed or was interrupted.
 *
 * Read by a provider whose create API cannot tell "already exists" from "is
 * yours" — today only `AWS::EC2::SecurityGroupIngress`, whose
 * `InvalidPermission.Duplicate` says the same thing for a rule an interrupted
 * run of this stack left behind and for an identical rule another owner added.
 * Adopting the second records it as this stack's, and `cdkd destroy` then
 * revokes it. The provider adopts only a rule matching one of these bags.
 *
 * WHY AN ASYNC-LOCAL STORE rather than a `CreateContext` field: one provider
 * reads it, and only on its duplicate arm, so the journal is read lazily there
 * and never on an ordinary create (`resource-secrets-scope.ts` records the same
 * trade for its one reader).
 *
 * The state record is deliberately not a source. The diff emits a CREATE only
 * for a logical id the state lacks. On a replacement the record is the OLD
 * rule: a different rule from the one being created (create-first), or one the
 * provider has just revoked (`updateSecurityGroupIngress`). A create whose rule
 * state already records never reaches the provider.
 */
export interface PriorAttemptLookup {
  /** The logical id the evidence describes. A reader for another id gets none. */
  readonly logicalId: string;
  /**
   * The bags, read when called. Throws when the journal cannot be read; a
   * reader must treat that as "no evidence", never as "attempted".
   */
  readonly attempts: () => Promise<ReadonlyArray<Record<string, unknown>>>;
  /**
   * Record that an attempt of this resource's write, in THIS dispatch, may
   * have reached AWS (an ambiguous failure the engine's retry then repeats).
   * Shared by every retry of the dispatch, since the scope is bound around
   * them all.
   */
  readonly notePossiblyLanded: () => void;
  /** Whether {@link notePossiblyLanded} was called in this dispatch. */
  readonly possiblyLanded: () => boolean;
}

const priorAttemptStore = new AsyncLocalStorage<PriorAttemptLookup>();

/** Bound by the deploy engine around one resource's CREATE / UPDATE dispatch. */
export function withPriorAttempts<T>(lookup: PriorAttemptLookup, fn: () => T): T {
  return priorAttemptStore.run(lookup, fn);
}

/**
 * A lookup over `attempts` with its own possibly-landed flag, for the one
 * dispatch it is bound around.
 */
export function priorAttemptLookup(
  logicalId: string,
  attempts: () => Promise<ReadonlyArray<Record<string, unknown>>>
): PriorAttemptLookup {
  let landed = false;
  return {
    logicalId,
    attempts,
    notePossiblyLanded: () => {
      landed = true;
    },
    possiblyLanded: () => landed,
  };
}

/**
 * The bound lookup for `logicalId`, or `undefined` when none is bound for it
 * (a caller outside a deploy, such as `cdkd drift --revert`).
 */
export function getPriorAttempts(logicalId: string): PriorAttemptLookup | undefined {
  const bound = priorAttemptStore.getStore();
  return bound?.logicalId === logicalId ? bound : undefined;
}

/**
 * The CREATE or UPDATE bags `journal` holds for `logicalId` as `resourceType`
 * that no later op superseded: a completed op's recorded properties and a
 * failed op's attempted ones, walked in journal order (segments oldest first,
 * each segment's completed ops in completion order, then its failed ops). A
 * completed DELETE of the logical id clears every bag before it — the resource
 * those bags describe was deleted, so a rule matching them now is not ours. A
 * failed DELETE left the resource in place and clears nothing.
 */
export function priorAttemptsInJournal(
  journal: RollbackJournal | null,
  logicalId: string,
  resourceType: string
): Array<Record<string, unknown>> {
  let bags: Array<Record<string, unknown>> = [];
  for (const segment of journal?.segments ?? []) {
    for (const op of segment.operations) {
      if (op.logicalId !== logicalId) continue;
      if (op.changeType === 'DELETE') {
        bags = [];
        continue;
      }
      if (op.resourceType !== resourceType || !isBag(op.properties)) continue;
      bags.push(op.properties);
    }
    for (const op of segment.failedOperations ?? []) {
      if (op.logicalId !== logicalId || op.resourceType !== resourceType) continue;
      if (op.changeType === 'DELETE' || !isBag(op.attemptedProperties)) continue;
      bags.push(op.attemptedProperties);
    }
  }
  return bags;
}

function isBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REFUSED_BEFORE_APPLYING = Symbol.for('cdkd.refusedBeforeApplying');
const MAX_CAUSE_DEPTH = 10;

/**
 * Mark a failed create / update whose ATTEMPTED properties are provably not
 * this stack's resource: a refusal because the resource they describe belongs
 * to someone else, or a write AWS definitely did not apply
 * (go-to-k/cdkd#4355). The deploy engine then journals the failed op without
 * its attempted properties, so it never becomes the evidence
 * {@link priorAttemptsInJournal} reads on the next deploy — which would adopt
 * the very resource it refused, or one added by hand after the rejection.
 * Mark only on proof: an unmarked failure keeps its bag.
 *
 * A non-extensible error is returned unmarked, as `markNonRetryable` does.
 */
export function markRefusedBeforeApplying<E extends Error>(error: E): E {
  if (!Object.isExtensible(error)) return error;
  Object.defineProperty(error, REFUSED_BEFORE_APPLYING, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * True when the error, or a link of its bounded `.cause` chain, is marked —
 * walking only links that belong to `logicalId`. The walk stops at the first
 * link naming ANOTHER logical id (a nested stack's child resource, wrapped by
 * the parent `AWS::CloudFormation::Stack` row's error): a child's refusal says
 * nothing about the parent row's own attempted properties.
 */
export function isRefusedBeforeApplying(error: unknown, logicalId: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === 'object' || typeof current === 'function') {
      const linkId = (current as { logicalId?: unknown }).logicalId;
      if (typeof linkId === 'string' && linkId !== logicalId) return false;
      if ((current as Record<symbol, unknown>)[REFUSED_BEFORE_APPLYING] === true) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
