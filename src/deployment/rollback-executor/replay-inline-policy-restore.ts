import { isRedactedRecordedValue } from '../../provisioning/redacted-delete-address.js';
import { safeMsg } from '../../utils/display-safe.js';
import type { ResourceState } from '../../types/state.js';
import type {
  HeldInlinePolicyRemoval,
  RollbackInlinePolicyWriters,
} from '../inline-policy-claims.js';
import { maskedFailureText, safe } from './messages.js';
import { addRecordNames, createOpMasker } from './names.js';
import type { RollbackExecutorContext, RollbackReplayResult } from './types.js';

const LIST_FIELD = { role: 'Roles', group: 'Groups', user: 'Users' } as const;

/**
 * go-to-k/cdkd#4408: put back each inline policy a removal of this rollback
 * took off a principal while a record still holds it there
 * ({@link RollbackInlinePolicyWriters.takeHeldRemovals}), with that record's
 * RECORDED document — what cdkd state says the principal holds. Run at the end
 * of each completed-op replay over the bag (`replayRollback`, never
 * `replayFailedOperations`, which runs BEFORE its segment's completed ops), so
 * every record of the segment is the one the rollback leaves.
 *
 * The put is `IAMPolicyProvider.create` with a one-principal bag naming the
 * holder's name explicitly: exactly one `Put{Role,Group,User}Policy`, the same
 * serialization the role / group / user providers use for a `Policies` entry.
 *
 * It puts nothing, and warns, when the holders' documents differ, or one is
 * absent or redacted (a `{{resolve:...}}` reference or the mask, which would
 * be written literally): the principal then lacks the policy, fail-closed, as
 * before the fix. A failed put warns too. Neither fails the op that removed
 * the name, which completed; a re-run of the rollback would not repeat it.
 */
export async function restoreHeldInlinePolicies(
  writers: RollbackInlinePolicyWriters,
  stateResources: Record<string, ResourceState>,
  ctx: RollbackExecutorContext,
  result: Pick<RollbackReplayResult, 'warnings'>
): Promise<void> {
  for (const removal of writers.takeHeldRemovals(stateResources)) {
    await restoreOne(removal, stateResources, ctx, result);
  }
}

async function restoreOne(
  { kind, holders, unreadable }: HeldInlinePolicyRemoval,
  stateResources: Record<string, ResourceState>,
  ctx: RollbackExecutorContext,
  result: Pick<RollbackReplayResult, 'warnings'>
): Promise<void> {
  const { logger } = ctx;
  // Logical ids only: a policy or principal name can be secret-derived.
  const ids = [...new Set(holders.map((h) => h.logicalId))].map((id) => safe(id)).join(', ');
  const lost =
    safeMsg`the ${kind} it is on lacks that inline policy until the resource is next updated, or ` +
    `'cdkd drift <stack> --revert' restores it`;
  if (unreadable.length > 0) {
    logger.warn(
      safeMsg`  Rollback: an inline policy this rollback removed is recorded by ${ids}, and ` +
        safeMsg`${unreadable.map((id) => safe(id)).join(', ')} may record it too under a redacted ` +
        safeMsg`name, so cdkd did not put it back; ${lost}.`
    );
    result.warnings++;
    return;
  }
  const documents = holders.map((h) => serializedDocument(h.document));
  if (documents.some((d) => d === undefined)) {
    logger.warn(
      safeMsg`  Rollback: an inline policy this rollback removed is still recorded by ${ids}, but its ` +
        safeMsg`recorded document is absent or redacted, so cdkd did not put it back; ${lost}.`
    );
    result.warnings++;
    return;
  }
  if (new Set(documents).size > 1) {
    logger.warn(
      safeMsg`  Rollback: an inline policy this rollback removed is recorded by ${ids} with different ` +
        safeMsg`documents under one name on one ${kind}, so cdkd put neither back; ${lost}.`
    );
    result.warnings++;
    return;
  }
  const holder = holders[0]!;
  const masker = createOpMasker(logger, new Map());
  for (const h of holders) {
    const record = stateResources[h.logicalId];
    addRecordNames(
      masker,
      {
        logicalId: h.logicalId,
        resourceType: record?.resourceType,
        physicalId: record?.physicalId,
      },
      record
    );
  }
  try {
    const { provider, provisionedBy } = ctx.providerRegistry.getProviderFor({
      resourceType: 'AWS::IAM::Policy',
      provisionedBy: 'sdk',
    });
    if (provisionedBy !== 'sdk') {
      throw new Error('AWS::IAM::Policy is not routed to its SDK provider');
    }
    await provider.create(
      holder.logicalId,
      'AWS::IAM::Policy',
      {
        PolicyName: holder.policyName,
        PolicyDocument: holder.document,
        [LIST_FIELD[kind]]: [holder.principal],
      },
      { maskSecrets: masker.mask }
    );
  } catch (error) {
    logger.warn(
      maskedFailureText(
        safeMsg`  Rollback: could not put back the inline policy ${ids} records on its ${kind} ` +
          safeMsg`(${lost}): `,
        error,
        masker.mask
      )
    );
    result.warnings++;
    return;
  }
  logger.info(safeMsg`  Rollback: put back the inline policy ${ids} records on its ${kind}`);
}

/**
 * The document as a put sends it — verbatim when a string, JSON otherwise —
 * or `undefined` when it cannot be sent: absent, not a document, or redacted.
 */
function serializedDocument(document: unknown): string | undefined {
  if (typeof document === 'string') {
    return document.length > 0 && !isRedactedRecordedValue(document) ? document : undefined;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return undefined;
  }
  return isRedactedRecordedValue(document) ? undefined : JSON.stringify(document);
}
