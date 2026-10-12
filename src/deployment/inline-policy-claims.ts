import type {
  InlinePolicyClaimed,
  InlinePolicyPrincipalKind,
  TemplateResource,
} from '../types/resource.js';
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
 * - An `AWS::IAM::RolePolicy` / `UserPolicy` / `GroupPolicy` writer claims its
 *   recorded `PolicyName` on its recorded `RoleName` / `UserName` /
 *   `GroupName`, whichever route wrote it (go-to-k/cdkd#4821).
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
    // go-to-k/cdkd#4821: a standalone inline policy resource IS one name on
    // one principal, so a completed create or update of it (whatever its
    // route) left that name there, holding its recorded document.
    const standalone = standaloneInlinePolicyOf(record.resourceType, record.properties);
    if (standalone !== undefined) {
      if (
        standalone.kind === kind &&
        sameIamName(standalone.principal, principal) &&
        sameIamName(standalone.policyName, policyName)
      ) {
        return true;
      }
      continue;
    }
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

export const POLICY_LIST_FIELDS: Record<InlinePolicyPrincipalKind, string> = {
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
 * go-to-k/cdkd#4821: the resource types that are ONE inline policy name on one
 * principal (no SDK provider: they go through Cloud Control).
 */
const STANDALONE_POLICY_KINDS: Record<string, InlinePolicyPrincipalKind> = {
  'AWS::IAM::RolePolicy': 'role',
  'AWS::IAM::GroupPolicy': 'group',
  'AWS::IAM::UserPolicy': 'user',
};

/** Whether `resourceType` is a standalone inline policy (`AWS::IAM::RolePolicy` ...). */
export function isStandaloneInlinePolicyType(resourceType: string): boolean {
  return Object.hasOwn(STANDALONE_POLICY_KINDS, resourceType);
}

/**
 * The principal and name a standalone inline policy record holds, read from
 * its properties, as recorded (unvalidated: a value that is not an IAM name
 * matches nothing). `undefined` for every other type.
 */
export function standaloneInlinePolicyOf(
  resourceType: string,
  properties: Readonly<Record<string, unknown>> | undefined
): { kind: InlinePolicyPrincipalKind; principal: unknown; policyName: unknown } | undefined {
  if (!isStandaloneInlinePolicyType(resourceType)) return undefined;
  const kind = STANDALONE_POLICY_KINDS[resourceType]!;
  const props = properties ?? {};
  return {
    kind,
    principal: props[PRINCIPAL_NAME_FIELDS[kind]],
    policyName: props['PolicyName'],
  };
}

/**
 * go-to-k/cdkd#4821: whether a delete of the standalone inline policy record
 * `properties` would remove a name ANOTHER completed writer of this deploy has
 * put on the same principal (`claimed`), so the delete must leave it. Any
 * doubt (no predicate, an unreadable name or principal, a `physicalId` that
 * is not Cloud Control's `<PolicyName>|<principal>` for them) answers
 * `false`: the delete proceeds.
 */
export function standaloneInlinePolicyHandedOff(
  resourceType: string,
  properties: Readonly<Record<string, unknown>> | undefined,
  claimed: InlinePolicyClaimed | undefined,
  physicalId?: string
): boolean {
  if (claimed === undefined) return false;
  const target = standaloneInlinePolicyOf(resourceType, properties);
  if (target === undefined) return false;
  const { kind, principal, policyName } = target;
  if (typeof principal !== 'string' || !IAM_NAME.test(principal)) return false;
  if (typeof policyName !== 'string' || !IAM_NAME.test(policyName)) return false;
  if (
    physicalId !== undefined &&
    physicalId.toLowerCase() !== `${policyName}|${principal}`.toLowerCase()
  ) {
    return false;
  }
  return claimed(kind, principal, policyName) === true;
}

/** Whether `resourceType` is a principal that holds inline `Policies`. */
export function isInlinePolicyPrincipalType(resourceType: string): boolean {
  return Object.hasOwn(PRINCIPAL_KINDS, resourceType);
}

function principalKindOf(resourceType: string): InlinePolicyPrincipalKind | undefined {
  return Object.hasOwn(PRINCIPAL_KINDS, resourceType) ? PRINCIPAL_KINDS[resourceType] : undefined;
}

/** A principal or policy name this deploy cannot know before it resolves. */
const ANY = '*';

const PRINCIPAL_NAME_FIELDS: Record<InlinePolicyPrincipalKind, string> = {
  role: 'RoleName',
  group: 'GroupName',
  user: 'UserName',
};

/** An IAM name as a match key (lowercased), or {@link ANY} for anything else. */
function nameKey(value: unknown): string {
  return typeof value === 'string' && IAM_NAME.test(value) ? value.toLowerCase() : ANY;
}

/**
 * The keys one TEMPLATE entry of a policy's principal list may name. A `Ref`
 * to a principal of this stack keys by the logical id (`ref:` cannot occur in
 * an IAM name) plus every name it can resolve to: its template name and its
 * recorded physical id. Anything else that is not a literal name is {@link ANY}.
 */
function templatePrincipalKeys(
  entry: unknown,
  kind: InlinePolicyPrincipalKind,
  templateResources: Readonly<Record<string, TemplateResource>>,
  stateResources: Readonly<Record<string, ResourceState>>
): string[] {
  if (typeof entry === 'string') return [nameKey(entry)];
  const ref =
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)['Ref']
      : undefined;
  if (typeof ref !== 'string' || !Object.hasOwn(templateResources, ref)) return [ANY];
  const target = templateResources[ref]!;
  if (principalKindOf(target.Type) !== kind) return [ANY];
  return principalSelfKeys(ref, kind, target, stateResources);
}

/** The keys a principal of this stack is known by (see {@link templatePrincipalKeys}). */
function principalSelfKeys(
  logicalId: string,
  kind: InlinePolicyPrincipalKind,
  template: TemplateResource | undefined,
  stateResources: Readonly<Record<string, ResourceState>>
): string[] {
  const keys = [`ref:${logicalId}`];
  // A declared name read only when literal: an unreadable one (a token such as
  // `${stackName}-fn`) names THIS principal, so it must not key as ANY and
  // meet every other principal's policies — the logical id already keys it.
  const declared = template?.Properties?.[PRINCIPAL_NAME_FIELDS[kind]];
  const declaredKey = nameKey(declared);
  if (declaredKey !== ANY) keys.push(declaredKey);
  const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
  if (record !== undefined && principalKindOf(record.resourceType) === kind) {
    const recordedKey = nameKey(record.physicalId);
    if (recordedKey !== ANY) keys.push(recordedKey);
  }
  return keys;
}

/** The names of a `Policies` list; a list that is not one may hold any. */
function policiesNames(policies: unknown): string[] {
  if (policies === undefined || policies === null) return [];
  if (!Array.isArray(policies)) return [ANY];
  return policies.map((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? nameKey((entry as Record<string, unknown>)['PolicyName'])
      : ANY
  );
}

interface InlinePolicyClaim {
  kind: InlinePolicyPrincipalKind;
  principal: string;
  name: string;
}

/**
 * go-to-k/cdkd#4821: the pairs a standalone inline policy row PUTS (`desired`:
 * a create, or the create of a replacement) and REMOVES (`old`: the
 * replacement's delete of its old copy), each its principal with its own
 * name. `undefined` for every other type.
 */
function standaloneClaimSides(
  logicalId: string,
  change: ResourceChange,
  templateResources: Readonly<Record<string, TemplateResource>>,
  stateResources: Readonly<Record<string, ResourceState>>
): { desired: InlinePolicyClaim[]; old: InlinePolicyClaim[] } | undefined {
  const template = Object.hasOwn(templateResources, logicalId)
    ? templateResources[logicalId]
    : undefined;
  const desired = standaloneInlinePolicyOf(change.resourceType, template?.Properties ?? {});
  if (desired === undefined) return undefined;
  const { kind } = desired;
  const name = nameKey(desired.policyName);
  const sides = {
    desired: templatePrincipalKeys(desired.principal, kind, templateResources, stateResources).map(
      (principal) => ({ kind, principal, name })
    ),
    old: [] as InlinePolicyClaim[],
  };
  const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
  if (record?.resourceType === change.resourceType) {
    const old = standaloneInlinePolicyOf(change.resourceType, record.properties)!;
    sides.old.push({ kind, principal: nameKey(old.principal), name: nameKey(old.policyName) });
  }
  return sides;
}

/**
 * Every (principal, inline policy name) pair a create / update row may PUT or
 * REMOVE, read before dispatch from its template entry and its pre-deploy
 * record. Over-approximates: what it cannot read keys as {@link ANY}, which
 * only orders more writers, never fewer. Empty for a row that writes none.
 */
function inlinePolicyClaimsOf(
  logicalId: string,
  change: ResourceChange,
  templateResources: Readonly<Record<string, TemplateResource>>,
  stateResources: Readonly<Record<string, ResourceState>>
): InlinePolicyClaim[] {
  const template = Object.hasOwn(templateResources, logicalId)
    ? templateResources[logicalId]
    : undefined;
  const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
  const recorded = record?.resourceType === change.resourceType ? record : undefined;
  const claims: InlinePolicyClaim[] = [];
  const cross = (kind: InlinePolicyPrincipalKind, principals: string[], names: string[]): void => {
    for (const principal of new Set(principals)) {
      for (const name of new Set(names)) claims.push({ kind, principal, name });
    }
  };
  const standalone = standaloneClaimSides(logicalId, change, templateResources, stateResources);
  if (standalone !== undefined) return [...standalone.desired, ...standalone.old];
  if (change.resourceType === 'AWS::IAM::Policy') {
    const desired = template?.Properties ?? {};
    const old = recorded?.properties ?? {};
    const names: string[] = [];
    if (desired['PolicyName'] !== undefined) names.push(nameKey(desired['PolicyName']));
    if (old['PolicyName'] !== undefined) names.push(nameKey(old['PolicyName']));
    // The physical id is the name, or `<name>:<role>` in the provider's old
    // format, which it reads the same way.
    if (recorded !== undefined)
      names.push(
        nameKey(
          typeof recorded.physicalId === 'string'
            ? recorded.physicalId.split(':')[0]
            : recorded.physicalId
        )
      );
    if (names.length === 0) return claims;
    for (const kind of ['role', 'group', 'user'] as const) {
      const field = POLICY_LIST_FIELDS[kind];
      const principals: string[] = [];
      const listed = desired[field];
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          principals.push(...templatePrincipalKeys(entry, kind, templateResources, stateResources));
        }
      } else if (listed !== undefined) {
        principals.push(ANY);
      }
      const held = old[field];
      if (Array.isArray(held)) principals.push(...held.map(nameKey));
      else if (held !== undefined && held !== null) principals.push(ANY);
      cross(kind, principals, names);
    }
    return claims;
  }
  const kind = principalKindOf(change.resourceType);
  if (kind === undefined) return claims;
  // A principal puts or removes inline policies only on a create, a
  // replacement (the create of the new principal), or an update whose own
  // diff changed `Policies` — the rule the claim predicate reads.
  const writesPolicies =
    change.changeType === 'CREATE' ||
    (change.propertyChanges ?? []).some((c) => c.requiresReplacement) ||
    ownPoliciesChange(change);
  if (!writesPolicies) return claims;
  cross(kind, principalSelfKeys(logicalId, kind, template, stateResources), [
    ...policiesNames(template?.Properties?.['Policies']),
    ...policiesNames(recorded?.properties?.['Policies']),
  ]);
  return claims;
}

/**
 * go-to-k/cdkd#4227: order the create / update rows that write the same
 * inline policy name on the same IAM principal, so none of them runs while
 * another is in flight.
 *
 * The claim predicate ({@link isInlinePolicyClaimedByCompletedWriter}) keeps a
 * name only once its other writer has COMPLETED. Two writers with no
 * dependency between them (two `iam.Policy` constructs on one role swapping
 * names, or one renamed away from a name a new one takes) ran concurrently,
 * so each removal could miss the other's put and the role kept neither
 * policy. In sequence, either order is correct: the second writer sees the
 * first one's completed write, or removes only what the first then re-puts.
 *
 * Only the colliding rows are ordered, derived from the diff before dispatch:
 * a row that shares no (principal, name) pair with another gets no edge, and a
 * stack with fewer than two inline-policy writers costs one pass over its rows.
 * Each added edge makes the later of the pair (by `rank`, then logical id;
 * a standalone `AWS::IAM::RolePolicy` / `GroupPolicy` / `UserPolicy` paired
 * with another kind of writer is always the later, go-to-k/cdkd#4821)
 * depend on the earlier one, and only when neither already depends on the
 * other through `dependencies`, so it can never close a cycle: an edge `u -> v`
 * closes one only when `v` already reaches `u`.
 *
 * `dependencies` (each row's direct dependencies, among `writes` only) is
 * updated in place; the added edges are returned.
 */
export function orderInlinePolicyWriters(args: {
  /** The rows of the create / update phase. */
  writes: readonly string[];
  changes: ReadonlyMap<string, ResourceChange>;
  templateResources: Readonly<Record<string, TemplateResource>>;
  /** The pre-deploy records. */
  stateResources: Readonly<Record<string, ResourceState>>;
  dependencies: Map<string, Set<string>>;
  /** A row's execution level: an edge goes from the lower to the higher. */
  rank: (logicalId: string) => number;
}): Array<{ before: string; after: string }> {
  const { writes, changes, templateResources, stateResources, dependencies, rank } = args;
  const writers = writes.filter((id) => {
    const type = changes.get(id)?.resourceType;
    return (
      type === 'AWS::IAM::Policy' ||
      (type !== undefined &&
        (isInlinePolicyPrincipalType(type) || isStandaloneInlinePolicyType(type)))
    );
  });
  if (writers.length < 2) return [];

  const exact = new Map<string, Set<string>>();
  const loose: Array<{ id: string; claim: InlinePolicyClaim }> = [];
  const all: Array<{ id: string; claim: InlinePolicyClaim }> = [];
  for (const id of writers) {
    for (const claim of inlinePolicyClaimsOf(
      id,
      changes.get(id)!,
      templateResources,
      stateResources
    )) {
      all.push({ id, claim });
      if (claim.principal === ANY || claim.name === ANY) {
        loose.push({ id, claim });
        continue;
      }
      const key = JSON.stringify([claim.kind, claim.principal, claim.name]);
      const ids = exact.get(key) ?? new Set<string>();
      ids.add(id);
      exact.set(key, ids);
    }
  }

  // Two principals of the stack are never the same principal, so a name one
  // of them cannot read before resolving does not make it collide with another.
  const principalRows = new Set(
    writers.filter((id) => isInlinePolicyPrincipalType(changes.get(id)!.resourceType))
  );
  const standaloneRows = new Set(
    writers.filter((id) => isStandaloneInlinePolicyType(changes.get(id)!.resourceType))
  );
  const sides = new Map(
    [...standaloneRows].map((id) => [
      id,
      standaloneClaimSides(id, changes.get(id)!, templateResources, stateResources)!,
    ])
  );
  const sameClaim = (p: InlinePolicyClaim, q: InlinePolicyClaim): boolean =>
    p.kind === q.kind &&
    (p.principal === ANY || q.principal === ANY || p.principal === q.principal) &&
    (p.name === ANY || q.name === ANY || p.name === q.name);
  /** Whether standalone row `a`'s old copy holds a pair standalone row `b` creates. */
  const releasesFor = (a: string, b: string): boolean =>
    sides.get(a)!.old.some((o) => sides.get(b)!.desired.some((d) => sameClaim(o, d)));
  const pairs = new Map<string, [string, string]>();
  const pair = (a: string, b: string): void => {
    if (a === b || (principalRows.has(a) && principalRows.has(b))) return;
    // go-to-k/cdkd#4821: a standalone inline policy's create is refused while
    // its name is on the principal, so the other writer, which may be
    // releasing that name, goes first. Its delete of a replaced old name then
    // leaves the name the other writer has put there (the claim predicate).
    // Two standalone ones: the one replaced AWAY from a name the other
    // creates releases it first, when only one of them does.
    const sa = standaloneRows.has(a);
    const sb = standaloneRows.has(b);
    let first: string | undefined;
    if (sa !== sb) first = sa ? b : a;
    else if (sa && sb) {
      const aReleases = releasesFor(a, b);
      const bReleases = releasesFor(b, a);
      if (aReleases !== bReleases) first = aReleases ? a : b;
    }
    first ??= rank(a) < rank(b) || (rank(a) === rank(b) && a < b) ? a : b;
    const [x, y] = first === a ? [a, b] : [b, a];
    pairs.set(JSON.stringify([x, y]), [x, y]);
  };
  for (const ids of exact.values()) {
    const list = [...ids];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) pair(list[i]!, list[j]!);
    }
  }
  const meets = (a: string, b: string): boolean => a === ANY || b === ANY || a === b;
  for (const { id, claim } of loose) {
    for (const other of all) {
      if (other.claim.kind !== claim.kind) continue;
      if (meets(claim.principal, other.claim.principal) && meets(claim.name, other.claim.name)) {
        pair(id, other.id);
      }
    }
  }
  if (pairs.size === 0) return [];

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of dependencies.get(id) ?? []) stack.push(dep);
    }
    return false;
  };
  const added: Array<{ before: string; after: string }> = [];
  for (const [before, after] of pairs.values()) {
    if (reaches(after, before) || reaches(before, after)) continue;
    const deps = dependencies.get(after) ?? new Set<string>();
    deps.add(before);
    dependencies.set(after, deps);
    added.push({ before, after });
  }
  return added;
}

/**
 * The (principal, inline policy name) pairs a RECORD holds, as match keys
 * (lowercased; {@link ANY} for an unreadable name or principal). Empty for a
 * record of no inline-policy-writing type.
 */
function recordInlinePolicyKeys(record: ResourceState | undefined): string[] {
  if (record === undefined || record === null || typeof record !== 'object') return [];
  const props = record.properties ?? {};
  const keys: string[] = [];
  const add = (kind: InlinePolicyPrincipalKind, principal: unknown, name: unknown): void => {
    keys.push(JSON.stringify([kind, nameKey(principal), nameKey(name)]));
  };
  const standalone = standaloneInlinePolicyOf(record.resourceType, props);
  if (standalone !== undefined) {
    add(standalone.kind, standalone.principal, standalone.policyName);
    return keys;
  }
  if (record.resourceType === 'AWS::IAM::Policy') {
    const names = [
      props['PolicyName'],
      typeof record.physicalId === 'string' ? record.physicalId.split(':')[0] : record.physicalId,
    ];
    for (const kind of ['role', 'group', 'user'] as const) {
      const listed = props[POLICY_LIST_FIELDS[kind]];
      if (listed === undefined || listed === null) continue;
      const principals = Array.isArray(listed) ? (listed as unknown[]) : [undefined];
      for (const p of principals) for (const n of names) add(kind, p, n);
    }
    return keys;
  }
  const kind = principalKindOf(record.resourceType);
  if (kind === undefined) return keys;
  for (const name of policiesNames(props['Policies'])) add(kind, record.physicalId, name);
  return keys;
}

/**
 * go-to-k/cdkd#4821: the rollback twin of {@link orderInlinePolicyWriters}.
 * A rollback replays a segment's completed updates and replacements one at a
 * time, newest first (`replay`, in that order). Reversing a standalone inline
 * policy's replacement RE-CREATES its old name, which Cloud Control refuses
 * while another writer of the deploy (an `AWS::IAM::Policy`, or a role /
 * group / user's `Policies`) still holds that name — the forward order ran
 * that writer first, so newest-first reverses the standalone one first. Each
 * standalone op that shares a (principal, name) pair, read from its current
 * and its pre-deploy record, with a later non-standalone op therefore moves
 * to just after the last such op, never past an op it has a dependency with
 * either way (the scan stops there). Every other op keeps its place; with no standalone op among
 * two or more inline-policy writers, `replay` is returned as is.
 */
export function orderInlinePolicyReversals<
  T extends { logicalId: string; previousState?: ResourceState | undefined },
>(replay: readonly T[], stateResources: Readonly<Record<string, ResourceState>>): T[] {
  const current = (op: T): ResourceState | undefined =>
    Object.hasOwn(stateResources, op.logicalId) ? stateResources[op.logicalId] : undefined;
  const isStandalone = (op: T): boolean =>
    [current(op), op.previousState].some(
      (r) => r !== undefined && r !== null && isStandaloneInlinePolicyType(r.resourceType)
    );
  if (!replay.some(isStandalone)) return [...replay];
  const keysOf = new Map<T, Set<string>>();
  for (const op of replay) {
    const keys = [
      ...recordInlinePolicyKeys(current(op)),
      ...recordInlinePolicyKeys(op.previousState),
    ];
    if (keys.length > 0) keysOf.set(op, new Set(keys));
  }
  if (keysOf.size < 2) return [...replay];
  const meets = (a: string, b: string): boolean => a === ANY || b === ANY || a === b;
  const collide = (a: Set<string>, b: Set<string>): boolean => {
    for (const ka of a) {
      const [kindA, pA, nA] = JSON.parse(ka) as [string, string, string];
      for (const kb of b) {
        const [kindB, pB, nB] = JSON.parse(kb) as [string, string, string];
        if (kindA === kindB && meets(pA, pB) && meets(nA, nB)) return true;
      }
    }
    return false;
  };
  const dependsOn = (a: T, b: T): boolean =>
    [current(a), a.previousState].some(
      (r) => Array.isArray(r?.dependencies) && r.dependencies.includes(b.logicalId)
    );
  const order = [...replay];
  // Latest-first, so a standalone op moved past another one keeps its place
  // relative to it.
  for (const op of [...replay].reverse()) {
    if (!isStandalone(op)) continue;
    const mine = keysOf.get(op);
    if (mine === undefined) continue;
    const at = order.indexOf(op);
    let last = -1;
    for (let j = at + 1; j < order.length; j++) {
      const other = order[j]!;
      const theirs = keysOf.get(other);
      // Never past an op it has a dependency with, colliding or not.
      if (dependsOn(op, other) || dependsOn(other, op)) break;
      if (theirs === undefined || isStandalone(other)) continue;
      if (collide(mine, theirs)) last = j;
    }
    if (last < 0) continue;
    order.splice(at, 1);
    order.splice(last, 0, op);
  }
  return order;
}

/**
 * Whether this deploy's diff changed the principal's `Policies` itself — a
 * row the diff only PROPAGATED from another resource does not count.
 */
function ownPoliciesChange(change: ResourceChange | undefined): boolean {
  return (change?.propertyChanges ?? []).some(
    (c) => c.path === 'Policies' && c.inPlacePropagated !== true && c.replacementPropagated !== true
  );
}
