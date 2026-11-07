/**
 * go-to-k/cdkd#4225 / #4408: the rollback side of the inline-policy claims --
 * `RollbackInlinePolicyWriters` and the record reader `inlinePolicyHolders`
 * its put-back reads. Split out of `inline-policy-claims.ts`
 * (go-to-k/cdkd#5835), which re-exports them.
 */
import type { InlinePolicyClaimed, InlinePolicyPrincipalKind } from '../../types/resource.js';
import type { ResourceChange, ResourceState } from '../../types/state.js';
import { type InlinePolicyWrite, isInlinePolicyClaimedByCompletedWriter } from './claimed.js';
import {
  IAM_NAME,
  POLICY_LIST_FIELDS,
  PRINCIPAL_KINDS,
  isStandaloneInlinePolicyType,
  removalKey,
  sameIamName,
  standaloneInlinePolicyOf,
} from './names.js';

/**
 * go-to-k/cdkd#4225: the rollback twin of the deploy engine's writer map. A
 * rollback revert of an `AWS::IAM::Policy` removes names from principals just
 * as a deploy update does, so reverting a same-deploy swap or hand-off (A
 * `x -> y` and B `y -> x` on one role) let the second revert remove the name
 * the first one had just restored.
 *
 * One instance per state bag's rollback, shared by every replay over that bag
 * (each segment's failed-op reverts, its completed ops, older segments); a
 * nested child's revert has its own. It records
 * each op whose provider write COMPLETED — a revert as `'update'`, a reverse
 * replacement's re-create as `'create'` — together with the state record that
 * write produced, and the predicate {@link claimedFor} hands out reads it
 * through {@link isInlinePolicyClaimedByCompletedWriter} at the moment of each
 * removal. Every rule of that predicate holds unchanged here. The rollback
 * adds the identity rule, the `policiesChanged` rule and the route rule, each
 * answering `false` (the removal proceeds):
 *
 * - A writer counts only while the live record is still the one its write
 *   produced. A later op of the same replay that replaced or dropped that
 *   record (an older segment's revert or delete, a re-adopt) wrote something
 *   else, or nothing.
 * - A rollback has no deploy diff, so a role / group / user revert counts as
 *   having put its `Policies` only when the two records the revert was handed
 *   differ there (`policiesChanged`).
 * - A write whose ACTUAL route was Cloud Control is not recorded, except a
 *   standalone inline policy's (see {@link RollbackInlinePolicyWriters.record}).
 *
 * go-to-k/cdkd#4408: every `false` it answers is a removal that proceeds, and
 * it notes each one. A removal can take a name off a principal while a record
 * that wrote nothing in this rollback still holds it there: the deploy's new
 * policy took an old policy's name and the rollback deletes it, a swap's
 * reversal deletes a copy whose name a sibling still records, or a re-adopted
 * retained copy whose name a sibling's reversal deleted. Keeping the name
 * instead would keep the remover's document, owned by no record (fail-open),
 * so the removal proceeds and {@link takeHeldRemovals} hands the replay each
 * removed name a record still holds, for it to put that record's document back.
 */
export class RollbackInlinePolicyWriters {
  private readonly entries = new Map<
    string,
    { write: InlinePolicyWrite; record: ResourceState; policiesChanged: boolean }
  >();
  /**
   * The removals this rollback let proceed, keyed case-insensitively, each
   * with the record every remover had in the bag when it asked.
   */
  private readonly removals = new Map<
    string,
    {
      kind: InlinePolicyPrincipalKind;
      principal: string;
      policyName: string;
      removers: Map<string, ResourceState | undefined>;
    }
  >();
  /**
   * The journaled ops of the replays over this bag that have not COMPLETED:
   * `'pending'` until attempted, `'failed'` when attempted and not completed.
   * Keyed by the op OBJECT, so registering one twice is a no-op.
   */
  private readonly unsettled = new Map<
    object,
    { logicalId: string; state: 'pending' | 'failed' }
  >();

  /**
   * go-to-k/cdkd#4408: a replay registers its ops before running any. Until
   * an op completes, its resource's record is the failed DEPLOY's post-op
   * record, not the state before that deploy, so it is no holder to put back
   * from ({@link takeHeldRemovals}).
   */
  notePending(ops: ReadonlyArray<{ logicalId: string }>): void {
    for (const op of ops) {
      if (!this.unsettled.has(op))
        this.unsettled.set(op, { logicalId: op.logicalId, state: 'pending' });
    }
  }

  /**
   * How a registered op ended: `completed` settles it, otherwise it failed.
   * A completed op settles every earlier entry of its logical id too: its
   * record is now the one the rollback restored, whatever a newer segment's
   * op of that id (a skip, an unrecoverable delete) left unsettled. A deploy
   * journals one op per logical id per segment, except a failed replacement's
   * UPDATE beside its orphan (go-to-k/cdkd#4604): both leave the record the
   * pre-deploy one, so either completing settles it correctly.
   */
  noteOutcome(op: { logicalId: string }, completed: boolean): void {
    if (!completed) {
      this.unsettled.set(op, { logicalId: op.logicalId, state: 'failed' });
      return;
    }
    for (const [key, entry] of this.unsettled) {
      if (key === op || entry.logicalId === op.logicalId) this.unsettled.delete(key);
    }
  }

  /**
   * Record a completed provider write. `record` is the object the caller has
   * just stored in the replay's state bag for `logicalId`; `via` is the route
   * the write ACTUALLY took. A revert keeps its previous record's
   * `provisionedBy` while it is routed by the journaled op's, so a write
   * through Cloud Control can sit under an `'sdk'` record: such a write is
   * not recorded, for the reason the predicate skips a `'cc-api'` record.
   */
  record(
    logicalId: string,
    write: InlinePolicyWrite,
    record: ResourceState,
    policiesChanged: boolean,
    via: 'sdk' | 'cc-api' | undefined
  ): void {
    // go-to-k/cdkd#4821: a standalone inline policy's write is its one name,
    // whatever the route.
    if (via === 'cc-api' && !isStandaloneInlinePolicyType(record.resourceType)) {
      this.entries.delete(logicalId);
      return;
    }
    this.entries.set(logicalId, { write, record, policiesChanged });
  }

  /**
   * The predicate an `AWS::IAM::Policy` update or delete of this replay is
   * handed, and an `AWS::IAM::Role` / `Group` / `User` revert too, whose
   * provider asks it before removing a name its own `Policies` drops (a
   * hand-off to the principal's `Policies`, reverted: the policy's reverse
   * re-create puts the name back first, then the principal's revert would
   * remove it), and a standalone `AWS::IAM::RolePolicy` / `GroupPolicy` /
   * `UserPolicy` delete, whose Cloud Control delete leaves a name another
   * completed revert put back (go-to-k/cdkd#4821). `undefined` for every
   * other type.
   */
  claimedFor(
    resourceType: string,
    logicalId: string,
    stateResources: Record<string, ResourceState>
  ): InlinePolicyClaimed | undefined {
    if (
      resourceType !== 'AWS::IAM::Policy' &&
      !Object.hasOwn(PRINCIPAL_KINDS, resourceType) &&
      !isStandaloneInlinePolicyType(resourceType)
    ) {
      return undefined;
    }
    return (kind, principal, policyName) => {
      const writers = new Map<string, InlinePolicyWrite>();
      const changes = new Map<string, ResourceChange>();
      for (const [lid, entry] of this.entries) {
        if (!Object.hasOwn(stateResources, lid) || stateResources[lid] !== entry.record) continue;
        writers.set(lid, entry.write);
        if (entry.policiesChanged) {
          changes.set(lid, {
            logicalId: lid,
            changeType: 'UPDATE',
            resourceType: entry.record.resourceType,
            propertyChanges: [
              {
                path: 'Policies',
                oldValue: undefined,
                newValue: undefined,
                requiresReplacement: false,
              },
            ],
          });
        }
      }
      const claimed = isInlinePolicyClaimedByCompletedWriter(
        { selfLogicalId: logicalId, writers, changes, stateResources },
        kind,
        principal,
        policyName
      );
      // A value outside IAM's name charset is noted too; no record holds it.
      if (!claimed) {
        const key = removalKey(kind, principal, policyName);
        const noted = this.removals.get(key) ?? {
          kind,
          principal,
          policyName,
          removers: new Map(),
        };
        noted.removers.set(logicalId, stateResources[logicalId]);
        this.removals.set(key, noted);
      }
      return claimed;
    };
  }

  /**
   * go-to-k/cdkd#4408: the removals this rollback let proceed whose name a
   * record of `stateResources` holds on that principal NOW, each with every
   * such record ({@link inlinePolicyHolders}). Read at the end of each
   * completed-op replay, when every record of the segment is the one the
   * rollback leaves. Each is handed out once; a removal no record holds yet
   * stays for a later replay over the same bag (an older segment can re-adopt
   * the record that holds it).
   *
   * A REMOVER never holds its own removal while its record is still the one
   * it had when it asked: the removal is noted BEFORE the call, so a delete
   * that failed or was skipped part-way (one principal detached, the next
   * refused) keeps that record, and putting its document back would re-grant
   * what this rollback had just revoked. A remover that completed replaced or
   * dropped its record, which then no longer names the removal.
   *
   * A holder whose own op of this rollback has not completed
   * ({@link notePending}) holds the failed deploy's grant, not the state
   * before it: such a removal is handed out with that holder in `unsettled`,
   * and nothing is put back.
   */
  takeHeldRemovals(stateResources: Record<string, ResourceState>): HeldInlinePolicyRemoval[] {
    const held: HeldInlinePolicyRemoval[] = [];
    for (const [key, { kind, principal, policyName, removers }] of this.removals) {
      const { holders, unreadable } = inlinePolicyHolders(
        stateResources,
        kind,
        principal,
        policyName
      );
      const others = holders.filter(
        (h) =>
          !removers.has(h.logicalId) || stateResources[h.logicalId] !== removers.get(h.logicalId)
      );
      if (others.length === 0) continue;
      this.removals.delete(key);
      const open = new Set([...this.unsettled.values()].map((u) => u.logicalId));
      const unsettled = [...new Set(others.map((h) => h.logicalId))].filter((id) => open.has(id));
      held.push({ kind, holders: others, unreadable, unsettled });
    }
    return held;
  }
}

/** A removed inline policy name, and the records that hold it on that principal. */
export interface HeldInlinePolicyRemoval {
  kind: InlinePolicyPrincipalKind;
  /** Never empty. */
  holders: InlinePolicyHolder[];
  /**
   * Records that may hold the name on the principal too, but whose name for
   * it is redacted (a secret reference or the mask), so their document cannot
   * be compared.
   */
  unreadable: string[];
  /**
   * Holders whose own op of this rollback has not completed, so their record
   * is the failed deploy's, not the state before it.
   */
  unsettled: string[];
}

/** One record's claim to an inline policy name on a principal. */
export interface InlinePolicyHolder {
  logicalId: string;
  /** The principal and the policy name, spelled as this record spells them. */
  principal: string;
  policyName: string;
  /** The document the record holds under that name, as recorded. */
  document: unknown;
}

/**
 * go-to-k/cdkd#4408: every record of `stateResources` that holds the inline
 * policy `policyName` on `principal`, by the record-reading rules of
 * {@link isInlinePolicyClaimedByCompletedWriter} without its writer and route
 * rules: an `AWS::IAM::Policy` whose physical id is the name and whose list
 * for `kind` names the principal, and a role / group / user of that kind whose
 * physical id is the principal, once per `Policies` entry of that name. What
 * a record holds is what cdkd state says the principal holds, whoever wrote
 * it last. A standalone `AWS::IAM::RolePolicy` / `GroupPolicy` / `UserPolicy`
 * holds its `PolicyName` on its principal-name property (go-to-k/cdkd#4821).
 * A Cloud Control record holds too: the put-back writes what it
 * records, it does not trust a write it made. `unreadable` names the records
 * that may hold it unseen: one whose policy name or principal (either can be
 * its physical id) or principal-list entry is not an IAM name (a redacted
 * value) where the rest of the record would match.
 */
export function inlinePolicyHolders(
  stateResources: Record<string, ResourceState>,
  kind: InlinePolicyPrincipalKind,
  principal: string,
  policyName: string
): { holders: InlinePolicyHolder[]; unreadable: string[] } {
  const holders: InlinePolicyHolder[] = [];
  const unreadable: string[] = [];
  const unnamed = (v: unknown): boolean => typeof v !== 'string' || !IAM_NAME.test(v);
  for (const [logicalId, record] of Object.entries(stateResources)) {
    if (record === null || typeof record !== 'object') continue;
    const props = record.properties ?? {};
    const standalone = standaloneInlinePolicyOf(record.resourceType, props);
    if (standalone !== undefined) {
      if (standalone.kind !== kind) continue;
      const principalMatches = sameIamName(standalone.principal, principal);
      const nameMatches = sameIamName(standalone.policyName, policyName);
      if (principalMatches && nameMatches) {
        holders.push({
          logicalId,
          principal: standalone.principal as string,
          policyName: standalone.policyName as string,
          document: props['PolicyDocument'],
        });
      } else if (
        (principalMatches || unnamed(standalone.principal)) &&
        (nameMatches || unnamed(standalone.policyName))
      ) {
        unreadable.push(logicalId);
      }
      continue;
    }
    if (record.resourceType === 'AWS::IAM::Policy') {
      // The physical id IS the policy name; a redacted one may name it unseen.
      const nameMatches = sameIamName(record.physicalId, policyName);
      if (!nameMatches && !unnamed(record.physicalId)) continue;
      const listed = props[POLICY_LIST_FIELDS[kind]];
      const entries = Array.isArray(listed) ? (listed as unknown[]) : [];
      const named = entries.find((p) => sameIamName(p, principal));
      if (nameMatches && typeof named === 'string') {
        holders.push({
          logicalId,
          principal: named,
          policyName: record.physicalId,
          document: props['PolicyDocument'],
        });
      } else if (named !== undefined || entries.some(unnamed)) {
        unreadable.push(logicalId);
      }
      continue;
    }
    if (!Object.hasOwn(PRINCIPAL_KINDS, record.resourceType)) continue;
    if (PRINCIPAL_KINDS[record.resourceType] !== kind) continue;
    // The physical id IS the principal; a redacted one may name it unseen.
    const principalMatches = sameIamName(record.physicalId, principal);
    if (!principalMatches && !unnamed(record.physicalId)) continue;
    const policies = props['Policies'];
    if (!Array.isArray(policies)) continue;
    for (const entry of policies as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const name = (entry as Record<string, unknown>)['PolicyName'];
      if (principalMatches && sameIamName(name, policyName)) {
        holders.push({
          logicalId,
          principal: record.physicalId,
          policyName: name as string,
          document: (entry as Record<string, unknown>)['PolicyDocument'],
        });
      } else if (unnamed(name) || sameIamName(name, policyName)) {
        unreadable.push(logicalId);
      }
    }
  }
  return { holders, unreadable: [...new Set(unreadable)] };
}
