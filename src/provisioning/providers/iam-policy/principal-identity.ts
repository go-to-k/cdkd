import {
  GetGroupCommand,
  GetRoleCommand,
  GetUserCommand,
  NoSuchEntityException,
  type IAMClient,
} from '@aws-sdk/client-iam';
import { getStackRecords, verifiedIdentityCache } from '../../../deployment/stack-records-scope.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import type { InlinePolicyPrincipalKind } from '../../../types/resource.js';
import { isAccessDeniedError } from '../../name-lookup.js';
import { markNotGone } from '../../not-gone.js';
import {
  assertRecordedIdentity,
  reAdoptRemedy,
  recordedIdentityId,
  RecordedIdentityError,
  RecordedIdentityMismatchError,
} from '../../recorded-identity.js';
import type { DeleteContext } from '../../region-check.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import { injectiveKey } from '../../../state/record-keys.js';

/**
 * go-to-k/cdkd#6655: an inline policy is removed from its principals BY NAME
 * (`Delete{Role,Group,User}Policy`), and a destroy deletes the policy before
 * the principal it names, so the principal's own identity compare runs too
 * late: the policy would already be stripped from a same-named role, group or
 * user someone else made. Each principal the policy names that is a record of
 * THIS stack with a usable recorded identity id is read first and compared.
 *
 * The stack's records come from the scope every deploy, destroy and rollback
 * binds around a provider call (`stack-records-scope.ts`), so no call site
 * changes. A principal outside the stack, one whose record holds no id (legacy,
 * masked), or no bound scope (`cdkd drift --revert`): no read, by name as
 * before. `AWS::IAM::User` / `AWS::IAM::Group` are compared once
 * `SURVIVOR_IDENTITY_ATTRIBUTES` lists them; until then they read nothing.
 */
const PRINCIPAL_SPECS: Readonly<
  Record<
    InlinePolicyPrincipalKind,
    {
      resourceType: string;
      label: string;
      /** The id attribute the live read answers; must equal the table's key. */
      attribute: string;
      /** The IAM action the read needs, named by a denied read's refusal. */
      permission: string;
      read: (client: IAMClient, name: string) => Promise<string | undefined>;
    }
  >
> = {
  role: {
    resourceType: 'AWS::IAM::Role',
    label: 'IAM role',
    attribute: 'RoleId',
    permission: 'iam:GetRole',
    read: async (client, name) =>
      (await client.send(new GetRoleCommand({ RoleName: name }))).Role?.RoleId,
  },
  group: {
    resourceType: 'AWS::IAM::Group',
    label: 'IAM group',
    attribute: 'GroupId',
    permission: 'iam:GetGroup',
    read: async (client, name) =>
      (await client.send(new GetGroupCommand({ GroupName: name, MaxItems: 1 }))).Group?.GroupId,
  },
  user: {
    resourceType: 'AWS::IAM::User',
    label: 'IAM user',
    attribute: 'UserId',
    permission: 'iam:GetUser',
    read: async (client, name) =>
      (await client.send(new GetUserCommand({ UserName: name }))).User?.UserId,
  },
};

/** Exported for the test pinning each spec's attribute to the identity table. */
export const INLINE_POLICY_PRINCIPAL_SPECS = PRINCIPAL_SPECS;

/**
 * The operation sending the inline policy's change to a principal: a removal
 * (`delete`, `update`) or a `Put*Policy` (`attach`, go-to-k/cdkd#6722).
 */
export type InlinePolicyOperation = 'delete' | 'update' | 'attach';

/**
 * The policy whose change is sent to the principals, for the wording and the
 * resource type of a refusal: an inline `AWS::IAM::Policy` (the default), or
 * an `AWS::IAM::ManagedPolicy` attached by its `Roles` / `Groups` / `Users`
 * (go-to-k/cdkd#6722).
 */
export interface PolicyOwner {
  readonly label: string;
  readonly resourceType: string;
}
export const INLINE_POLICY_OWNER: PolicyOwner = {
  label: 'IAM policy',
  resourceType: 'AWS::IAM::Policy',
};
export const MANAGED_POLICY_OWNER: PolicyOwner = {
  label: 'IAM managed policy',
  resourceType: 'AWS::IAM::ManagedPolicy',
};

/** What the pre-delete check found for one principal. */
export type PrincipalVerdict =
  /** Not an in-stack record with a usable id: delete by name, as before. */
  | { kind: 'unchecked' }
  /** The live holder carries the recorded id. */
  | { kind: 'verified' }
  /** No holder of the name: the delete would answer `NoSuchEntity` too. */
  | { kind: 'gone' }
  /** Another holder of the name: nothing may be sent to it. */
  | { kind: 'mismatch'; principalLogicalId: string; label: string; attribute: string };

/**
 * The usable recorded identity ids of the in-stack `kind` records named
 * `name`, with the first such record's logical id, or `undefined` when none.
 *
 * `skipFresh` (an attach, go-to-k/cdkd#6722): when EVERY record of the
 * name holding a usable id was written fresh by this deploy (its create, or an update that
 * answered `wasReplaced`, so the id is the one AWS's create just answered),
 * `undefined`: no read. The signal is what the engine dispatched
 * (`writtenFreshThisRun`), never inferred from the ids: an in-place update
 * reads by name. One stale record of the name keeps the read, with every
 * id (fresh ones included) accepted. Only a deploy's view knows it; a
 * rollback replay and a destroy read every in-stack principal with an id.
 * With no bound scope there are no records, so nothing is read.
 */
function inStackRecordedIds(
  kind: InlinePolicyPrincipalKind,
  name: string,
  skipFresh: boolean
): { logicalId: string; key: string; values: string[] } | undefined {
  const view = getStackRecords();
  if (view === undefined) return undefined;
  const { resourceType } = PRINCIPAL_SPECS[kind];
  let found: { logicalId: string; key: string; values: string[] } | undefined;
  let allFresh = true;
  for (const [logicalId, record] of view.live()) {
    if (record.resourceType !== resourceType || record.physicalId !== name) continue;
    const recorded = recordedIdentityId(resourceType, { recordedAttributes: record.attributes });
    if (recorded === undefined) continue;
    if (!(skipFresh && view.writtenFreshThisRun?.(logicalId) === true)) allFresh = false;
    if (found === undefined) found = { logicalId, key: recorded.key, values: [] };
    if (!found.values.includes(recorded.value)) found.values.push(recorded.value);
  }
  return found === undefined || allFresh ? undefined : found;
}

/**
 * Read and compare one principal (see {@link PRINCIPAL_SPECS}). Throws what
 * the read throws (other than `NoSuchEntity`), left to the retry classifiers,
 * and a not-gone {@link RecordedIdentityError} for a read answering without
 * an id; never sends a write.
 */
export async function verifyInlinePolicyPrincipal(params: {
  client: IAMClient;
  kind: InlinePolicyPrincipalKind;
  name: string;
  policyLogicalId: string;
  physicalId: string;
  /** The operation sending the policy's change, for the wording of a refusal. */
  operation: InlinePolicyOperation;
  owner?: PolicyOwner;
}): Promise<PrincipalVerdict> {
  const { client, kind, name, policyLogicalId, physicalId, operation } = params;
  const owner = params.owner ?? INLINE_POLICY_OWNER;
  const recorded = inStackRecordedIds(kind, name, operation === 'attach');
  if (recorded === undefined) return { kind: 'unchecked' };
  const spec = PRINCIPAL_SPECS[kind];
  // Two records of one name (a stale duplicate): the holder is ours when it
  // carries any of their ids, on the first read and on the re-read alike, so
  // each answer matching one is handed to the compare as the first.
  const value = recorded.values[0]!;
  const read = async (): Promise<string | undefined> => {
    const id = await spec.read(client, name);
    return id !== undefined && recorded.values.includes(id) ? value : id;
  };
  // go-to-k/cdkd#6722: a match is kept for the rest of the run, so N policies
  // naming one principal read it once; a rejected compare is dropped, so the
  // next attempt reads again. Each caller words its own refusal below.
  const cache = verifiedIdentityCache(getStackRecords());
  const cacheKey = injectiveKey(
    spec.resourceType,
    recorded.logicalId,
    name,
    ...[...recorded.values].sort()
  );
  let compare = cache?.get(cacheKey);
  if (compare === undefined) {
    const started = (async () => {
      await assertRecordedIdentity({
        label: spec.label,
        resourceType: spec.resourceType,
        logicalId: recorded.logicalId,
        physicalId: name,
        liveId: await read(),
        reread: read,
        context: { recordedAttributes: { [recorded.key]: value } },
      });
    })();
    compare = started;
    if (cache !== undefined) {
      cache.set(cacheKey, started);
      started.catch(() => {
        if (cache.get(cacheKey) === started) cache.delete(cacheKey);
      });
    }
  }
  try {
    await compare;
    return { kind: 'verified' };
  } catch (error) {
    if (error instanceof NoSuchEntityException) return { kind: 'gone' };
    if (error instanceof RecordedIdentityMismatchError) {
      return {
        kind: 'mismatch',
        principalLogicalId: recorded.logicalId,
        label: spec.label,
        attribute: error.attribute,
      };
    }
    if (error instanceof RecordedIdentityError) {
      // Reworded for the policy (the helper's names the principal's delete).
      throw new InlinePolicyPrincipalUnconfirmedError(
        policyLogicalId,
        physicalId,
        `${spec.label} ${recorded.logicalId}`,
        recorded.key,
        operation,
        owner
      );
    }
    // go-to-k/cdkd#6722: a denied read does not lift with time, and the
    // by-name write it guards is never the fallback (the #6665 shape).
    if (isAccessDeniedError(error)) {
      throw new InlinePolicyPrincipalReadDeniedError({
        policyLogicalId,
        physicalId,
        principal: `${spec.label} ${recorded.logicalId}`,
        permission: spec.permission,
        error,
        operation,
        owner,
      });
    }
    throw error;
  }
}

/** The in-stack principal reads one policy delete or update runs at once. */
export const PRINCIPAL_READ_CONCURRENCY = 5;

/**
 * {@link verifyInlinePolicyPrincipal} for each distinct principal of
 * `principals` (a name listed twice is read once), keyed by
 * `injectiveKey(kind, name)`. At most {@link PRINCIPAL_READ_CONCURRENCY}
 * reads at a time (IAM throttles reads at a low rate), and every read settles
 * before the first failure is thrown: no re-read wait outlives this attempt
 * into the runner's retry.
 */
export async function verifyInlinePolicyPrincipals(params: {
  client: IAMClient;
  principals: ReadonlyArray<readonly [InlinePolicyPrincipalKind, string]>;
  policyLogicalId: string;
  physicalId: string;
  operation: InlinePolicyOperation;
  owner?: PolicyOwner;
}): Promise<Map<string, PrincipalVerdict>> {
  const { client, principals, policyLogicalId, physicalId, operation, owner } = params;
  const distinct = principals.filter(
    ([kind, name], i) =>
      principals.findIndex(([k, n]) => injectiveKey(k, n) === injectiveKey(kind, name)) === i
  );
  const results: Array<PromiseSettledResult<PrincipalVerdict>> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < distinct.length) {
      const index = next++;
      const [kind, name] = distinct[index]!;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await verifyInlinePolicyPrincipal({
            client,
            kind,
            name,
            policyLogicalId,
            physicalId,
            operation,
            ...(owner && { owner }),
          }),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PRINCIPAL_READ_CONCURRENCY, distinct.length) }, worker)
  );
  const verdicts = new Map<string, PrincipalVerdict>();
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') throw result.reason;
    const [kind, name] = distinct[index]!;
    verdicts.set(injectiveKey(kind, name), result.value);
  }
  return verdicts;
}

/** How a refusal about `principal` opens, per operation. */
function operationPrefix(
  operation: InlinePolicyOperation,
  owner: PolicyOwner,
  policyLogicalId: string,
  principal: string
): string {
  const policy = `${owner.label} ${policyLogicalId}`;
  switch (operation) {
    case 'update':
      return `Cannot remove ${policy} from ${principal} during an update: `;
    case 'attach':
      return `Cannot attach ${policy} to ${principal}: `;
    default:
      return `Cannot delete ${policy} from ${principal}: `;
  }
}

/**
 * go-to-k/cdkd#6722: AWS refused a principal's identity read for
 * authorization. Non-retryable (a retry is denied again), and nothing is
 * sent to the principal: the by-name write is what the read guards. Names the
 * permission (static text) and the error's class (an SDK class name, never
 * AWS's text, which can name the caller); no `cause`, so AWS's text stays off
 * the error a deployment event persists. Marked not gone: the logical ids are
 * template-controlled text.
 */
export class InlinePolicyPrincipalReadDeniedError extends RecordedIdentityError {
  constructor(params: {
    policyLogicalId: string;
    physicalId: string;
    principal: string;
    permission: string;
    error: unknown;
    operation: InlinePolicyOperation;
    owner: PolicyOwner;
  }) {
    const { policyLogicalId, physicalId, principal, permission, error, operation, owner } = params;
    const name = (error as { name?: unknown } | null)?.name;
    const errorClass =
      typeof name === 'string' && /^[A-Za-z0-9]{1,64}$/.test(name) ? name : 'a 403';
    super(
      operationPrefix(operation, owner, policyLogicalId, principal) +
        `AWS refused the ${permission} read cdkd makes to confirm it is the one cdkd created ` +
        `(${errorClass}), so cdkd sent nothing to it and kept the record. Grant ${permission} to ` +
        `the identity running cdkd and re-run.`,
      owner.resourceType,
      policyLogicalId,
      physicalId
    );
    Object.setPrototypeOf(this, InlinePolicyPrincipalReadDeniedError.prototype);
    this.name = 'InlinePolicyPrincipalReadDeniedError';
    markNonRetryable(this);
    markNotGone(this);
  }
}

/**
 * A principal's read answered without its identity id: cdkd cannot tell it
 * from a successor, so nothing is sent to it. Left to the retry classifiers,
 * as the shared helper's own no-id error is (`assertRecordedIdentity`): a
 * retry may get an answer with the id. Marked not gone in the constructor,
 * since the logical ids are template-controlled text.
 */
export class InlinePolicyPrincipalUnconfirmedError extends RecordedIdentityError {
  constructor(
    policyLogicalId: string,
    physicalId: string,
    principal: string,
    attribute: string,
    operation: InlinePolicyOperation,
    owner: PolicyOwner = INLINE_POLICY_OWNER
  ) {
    super(
      operationPrefix(operation, owner, policyLogicalId, principal) +
        `AWS answered without its ` +
        `${attribute}, so cdkd cannot confirm it is the one cdkd created; nothing was sent to it ` +
        `and the record is kept. Re-run the operation.`,
      owner.resourceType,
      policyLogicalId,
      physicalId
    );
    Object.setPrototypeOf(this, InlinePolicyPrincipalUnconfirmedError.prototype);
    this.name = 'InlinePolicyPrincipalUnconfirmedError';
    markNotGone(this);
  }
}

/**
 * The refusal of an inline policy delete that found a principal of this stack
 * held by another resource: nothing was sent to it (the policy was removed
 * from every other principal), and the record is kept. Non-retryable in the
 * constructor: a retry reads the same holder. Names the attribute, never
 * either value; marked not gone, since the logical ids are template-controlled
 * text.
 */
export class InlinePolicyPrincipalMismatchError extends RecordedIdentityError {
  constructor(params: {
    policyLogicalId: string;
    physicalId: string;
    mismatches: ReadonlyArray<Extract<PrincipalVerdict, { kind: 'mismatch' }>>;
    context: DeleteContext | undefined;
  }) {
    const { policyLogicalId, physicalId, mismatches, context } = params;
    const named = mismatches
      .map((m) => `${m.label} ${m.principalLogicalId} (its ${m.attribute} differs)`)
      .join(', ');
    super(
      `Cannot delete IAM policy ${policyLogicalId} from ${named}: the principal holding the name ` +
        `cdkd recorded is not the one cdkd created, so cdkd sent it no delete and kept the record ` +
        `(the principal's own record refuses its delete the same way). Leave that principal ` +
        `alone; if the one cdkd created is gone (its inline policy went with it), drop the ` +
        `record with ${stateOrphanRecordRemedy(context, policyLogicalId)}.`,
      'AWS::IAM::Policy',
      policyLogicalId,
      physicalId
    );
    Object.setPrototypeOf(this, InlinePolicyPrincipalMismatchError.prototype);
    this.name = 'InlinePolicyPrincipalMismatchError';
    markNonRetryable(this);
    markNotGone(this);
  }
}

/**
 * go-to-k/cdkd#6722: before any `Put{Role,Group,User}Policy`, compare each
 * principal the policy is about to be put on (see
 * {@link verifyInlinePolicyPrincipal}); a holder with another id refuses the
 * whole write, so nothing is put anywhere. A skipped put would leave cdkd's
 * own principal silently without the permission, and the put itself would
 * GRANT it to a principal cdkd did not create. A principal already gone is
 * left to the put, which answers `NoSuchEntity` as before.
 */
export async function assertInlinePolicyAttachTargets(params: {
  client: IAMClient;
  principals: ReadonlyArray<readonly [InlinePolicyPrincipalKind, string]>;
  policyLogicalId: string;
  physicalId: string;
  owner?: PolicyOwner;
}): Promise<void> {
  const { client, principals, policyLogicalId, physicalId } = params;
  const owner = params.owner ?? INLINE_POLICY_OWNER;
  const verdicts = await verifyInlinePolicyPrincipals({
    client,
    principals,
    policyLogicalId,
    physicalId,
    operation: 'attach',
    owner,
  });
  const mismatches = [...verdicts.values()].filter(
    (verdict): verdict is Extract<PrincipalVerdict, { kind: 'mismatch' }> =>
      verdict.kind === 'mismatch'
  );
  if (mismatches.length > 0) {
    throw new InlinePolicyAttachMismatchError({
      policyLogicalId,
      physicalId,
      mismatches,
      owner,
    });
  }
}

/**
 * The refusal of an inline policy put that found a principal of this stack
 * held by another resource: no `Put*Policy` was sent to any principal, so
 * nothing was granted. Non-retryable in the constructor: a retry reads the
 * same holder. Names the attribute, never either value, and both ways
 * forward per principal: adopt a replacement the user made, or drop the
 * principal's record. Marked not gone, since the logical ids are
 * template-controlled text.
 */
export class InlinePolicyAttachMismatchError extends RecordedIdentityError {
  constructor(params: {
    policyLogicalId: string;
    physicalId: string;
    mismatches: ReadonlyArray<Extract<PrincipalVerdict, { kind: 'mismatch' }>>;
    owner: PolicyOwner;
  }) {
    const { policyLogicalId, physicalId, mismatches, owner } = params;
    const named = mismatches
      .map((m) => `${m.label} ${m.principalLogicalId} (its ${m.attribute} differs)`)
      .join(', ');
    const remedies = mismatches
      .map(
        (m) =>
          `For ${m.principalLogicalId}: if you replaced it yourself, adopt the new one with ` +
          `${reAdoptRemedy(m.principalLogicalId)} and re-run; otherwise leave that ${m.label} ` +
          `alone, and if the one cdkd created is gone, drop its record with ` +
          `${stateOrphanRecordRemedy(undefined, m.principalLogicalId)}`
      )
      .join('. ');
    super(
      `Cannot attach ${owner.label} ${policyLogicalId} to ${named}: the principal holding the name ` +
        `cdkd recorded is not the one cdkd created, so cdkd sent the policy to no principal ` +
        `(granting nothing) and kept the principals' records. ${remedies}.`,
      owner.resourceType,
      policyLogicalId,
      physicalId
    );
    Object.setPrototypeOf(this, InlinePolicyAttachMismatchError.prototype);
    this.name = 'InlinePolicyAttachMismatchError';
    markNonRetryable(this);
    markNotGone(this);
  }
}
