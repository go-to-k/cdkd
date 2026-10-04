import type { InlinePolicyClaimed, InlinePolicyPrincipalKind } from '../types/resource.js';
import type { ResourceChange, ResourceState } from '../types/state.js';

/**
 * How a resource's completed provider call in this deploy wrote its inline
 * policies: `'create'` (a create, or the create of a replacement) puts every
 * one it declares; `'update'` puts what its provider's update puts.
 */
export type InlinePolicyWrite = 'create' | 'update';

/**
 * go-to-k/cdkd#4156: whether ANOTHER resource of this deploy has ALREADY
 * written the inline policy `policyName` onto `principal` — so removing that
 * name from it would strip that resource's live grant.
 *
 * An `AWS::IAM::Policy` update or delete removes its OLD name from principals.
 * When another resource hands that name onto the same principal in the same
 * deploy (a swap of two policies' names, a rename away from a name a new policy
 * takes, a delete beside a create of the same name), the removal used to strip
 * the other resource's grant, and the next deploy saw no diff.
 *
 * Evaluated LIVE, at the moment of each removal, from what each other resource
 * RECORDED after its provider call completed in this deploy (`writers`), never
 * from the template: a value resolved ahead of the write (a custom resource's
 * `Data`, a `GetAtt` of a resource this deploy updates, a nested stack's
 * output) can differ from what is written, and a claimant that has not run,
 * is still running, or failed has put nothing. Any such case answers `false`,
 * so the removal proceeds; a claimant that runs later puts the name back. A
 * wrong `true` would be FAIL-OPEN — the removed policy's OLD document would
 * stay attached under that name, owned by no record — so every doubt answers
 * `false`: a value that is not a string in IAM's name charset (a mask or a
 * redacted secret-derived reference included) matches nothing.
 *
 * - An `AWS::IAM::Policy` writer claims the name it RECORDED as its physical id
 *   (what its create / update returned) on each principal its recorded
 *   `Roles` / `Groups` / `Users` lists.
 * - An `AWS::IAM::Role` / `Group` / `User` writer claims each recorded
 *   `Policies[].PolicyName` on its recorded physical id — only when the write
 *   put them: a create, or an update whose own diff changed `Policies`.
 *
 * Names compare case-insensitively, as IAM compares them on one principal.
 */
export function isInlinePolicyClaimedByCompletedWriter(
  args: {
    /** The resource removing the name; it never claims against itself. */
    selfLogicalId: string;
    /** The resources whose provider write COMPLETED in this deploy. */
    writers: ReadonlyMap<string, InlinePolicyWrite>;
    changes: ReadonlyMap<string, ResourceChange>;
    /** This deploy's live state bag: each writer's record as it wrote it. */
    stateResources: Record<string, ResourceState>;
  },
  kind: InlinePolicyPrincipalKind,
  principal: string,
  policyName: string
): boolean {
  const { selfLogicalId, writers, changes, stateResources } = args;
  for (const [lid, write] of writers) {
    if (lid === selfLogicalId || !Object.hasOwn(stateResources, lid)) continue;
    const record = stateResources[lid]!;
    // Only the SDK providers are known to put every name and entry they
    // record; a Cloud Control write is not confirmed to (an unchanged entry
    // may not be re-put), so it claims nothing.
    if (record.provisionedBy === 'cc-api') continue;
    const props = record.properties ?? {};
    if (record.resourceType === 'AWS::IAM::Policy') {
      if (!sameIamName(record.physicalId, policyName)) continue;
      const listed = props[POLICY_LIST_FIELDS[kind]];
      if (Array.isArray(listed) && listed.some((p) => sameIamName(p, principal))) return true;
      continue;
    }
    if (!Object.hasOwn(PRINCIPAL_KINDS, record.resourceType)) continue;
    if (PRINCIPAL_KINDS[record.resourceType] !== kind) continue;
    if (!sameIamName(record.physicalId, principal)) continue;
    if (write !== 'create' && !ownPoliciesChange(changes.get(lid))) continue;
    const policies = props['Policies'];
    if (!Array.isArray(policies)) continue;
    const declares = policies.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        sameIamName((entry as Record<string, unknown>)['PolicyName'], policyName)
    );
    if (declares) return true;
  }
  return false;
}

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
 * - A write whose ACTUAL route was Cloud Control is not recorded (see
 *   {@link RollbackInlinePolicyWriters.record}).
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
    if (via === 'cc-api') {
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
   * remove it). `undefined` for every other type.
   */
  claimedFor(
    resourceType: string,
    logicalId: string,
    stateResources: Record<string, ResourceState>
  ): InlinePolicyClaimed | undefined {
    if (resourceType !== 'AWS::IAM::Policy' && !Object.hasOwn(PRINCIPAL_KINDS, resourceType)) {
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
   * it had when it asked: the removal is noted BEFORE the call, so a delete or
   * revert that failed or was skipped part-way (one principal detached, the
   * next refused) keeps that record, and putting its document back would
   * re-grant what this rollback had just revoked. A remover that completed
   * replaced or dropped its record, which then no longer names the removal.
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
          !removers.has(h.logicalId) ||
          removers.get(h.logicalId) === undefined ||
          stateResources[h.logicalId] !== removers.get(h.logicalId)
      );
      if (others.length === 0) continue;
      this.removals.delete(key);
      held.push({ kind, holders: others, unreadable });
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
 * it last. A Cloud Control record holds too: the put-back writes what it
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

/**
 * Only a value in IAM's name charset matches: a mask or a redacted reference
 * names no principal or policy, even if the query spells it too. Names compare
 * case-insensitively, as IAM compares them on one principal.
 */
function sameIamName(a: unknown, b: string): boolean {
  return typeof a === 'string' && IAM_NAME.test(a) && a.toLowerCase() === b.toLowerCase();
}

function removalKey(
  kind: InlinePolicyPrincipalKind,
  principal: string,
  policyName: string
): string {
  return JSON.stringify([kind, principal.toLowerCase(), policyName.toLowerCase()]);
}

/** IAM's role / group / user / inline policy name charset. */
const IAM_NAME = /^[\w+=,.@-]+$/;

const POLICY_LIST_FIELDS: Record<InlinePolicyPrincipalKind, string> = {
  role: 'Roles',
  group: 'Groups',
  user: 'Users',
};

const PRINCIPAL_KINDS: Record<string, InlinePolicyPrincipalKind> = {
  'AWS::IAM::Role': 'role',
  'AWS::IAM::Group': 'group',
  'AWS::IAM::User': 'user',
};

/**
 * Whether this deploy's diff changed the principal's `Policies` itself — a
 * row the diff only PROPAGATED from another resource does not count.
 */
function ownPoliciesChange(change: ResourceChange | undefined): boolean {
  return (change?.propertyChanges ?? []).some(
    (c) => c.path === 'Policies' && c.inPlacePropagated !== true && c.replacementPropagated !== true
  );
}
