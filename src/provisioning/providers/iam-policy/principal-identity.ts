import {
  GetGroupCommand,
  GetRoleCommand,
  GetUserCommand,
  NoSuchEntityException,
  type IAMClient,
} from '@aws-sdk/client-iam';
import { getStackRecords } from '../../../deployment/stack-records-scope.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import type { InlinePolicyPrincipalKind } from '../../../types/resource.js';
import { markNotGone } from '../../not-gone.js';
import {
  assertRecordedIdentity,
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
      read: (client: IAMClient, name: string) => Promise<string | undefined>;
    }
  >
> = {
  role: {
    resourceType: 'AWS::IAM::Role',
    label: 'IAM role',
    attribute: 'RoleId',
    read: async (client, name) =>
      (await client.send(new GetRoleCommand({ RoleName: name }))).Role?.RoleId,
  },
  group: {
    resourceType: 'AWS::IAM::Group',
    label: 'IAM group',
    attribute: 'GroupId',
    read: async (client, name) =>
      (await client.send(new GetGroupCommand({ GroupName: name, MaxItems: 1 }))).Group?.GroupId,
  },
  user: {
    resourceType: 'AWS::IAM::User',
    label: 'IAM user',
    attribute: 'UserId',
    read: async (client, name) =>
      (await client.send(new GetUserCommand({ UserName: name }))).User?.UserId,
  },
};

/** Exported for the test pinning each spec's attribute to the identity table. */
export const INLINE_POLICY_PRINCIPAL_SPECS = PRINCIPAL_SPECS;

/** The operation that removes the inline policy from a principal. */
export type InlinePolicyOperation = 'delete' | 'update';

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
 */
function inStackRecordedIds(
  kind: InlinePolicyPrincipalKind,
  name: string
): { logicalId: string; key: string; values: string[] } | undefined {
  const view = getStackRecords();
  if (view === undefined) return undefined;
  const { resourceType } = PRINCIPAL_SPECS[kind];
  let found: { logicalId: string; key: string; values: string[] } | undefined;
  for (const [logicalId, record] of view.live()) {
    if (record.resourceType !== resourceType || record.physicalId !== name) continue;
    const recorded = recordedIdentityId(resourceType, { recordedAttributes: record.attributes });
    if (recorded === undefined) continue;
    if (found === undefined) found = { logicalId, key: recorded.key, values: [] };
    if (!found.values.includes(recorded.value)) found.values.push(recorded.value);
  }
  return found;
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
  /** The operation removing the policy, for the wording of a refusal. */
  operation: InlinePolicyOperation;
}): Promise<PrincipalVerdict> {
  const { client, kind, name, policyLogicalId, physicalId, operation } = params;
  const recorded = inStackRecordedIds(kind, name);
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
  try {
    await assertRecordedIdentity({
      label: spec.label,
      resourceType: spec.resourceType,
      logicalId: recorded.logicalId,
      physicalId: name,
      liveId: await read(),
      reread: read,
      context: { recordedAttributes: { [recorded.key]: value } },
    });
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
        operation
      );
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
}): Promise<Map<string, PrincipalVerdict>> {
  const { client, principals, policyLogicalId, physicalId, operation } = params;
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
    operation: InlinePolicyOperation
  ) {
    super(
      (operation === 'update'
        ? `Cannot remove IAM policy ${policyLogicalId} from ${principal} during an update: `
        : `Cannot delete IAM policy ${policyLogicalId} from ${principal}: `) +
        `AWS answered without its ` +
        `${attribute}, so cdkd cannot confirm it is the one cdkd created; nothing was sent to it ` +
        `and the record is kept. Re-run the operation.`,
      'AWS::IAM::Policy',
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
