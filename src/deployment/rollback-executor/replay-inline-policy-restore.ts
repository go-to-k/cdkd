import { isRedactedRecordedValue } from '../../provisioning/redacted-delete-address.js';
import { safeMsg } from '../../utils/display-safe.js';
import { carryLogOnlyValues, type RecordedSecretValues } from '../secret-redaction.js';
import type { ResourceState } from '../../types/state.js';
import {
  POLICY_LIST_FIELDS,
  type HeldInlinePolicyRemoval,
  type RollbackInlinePolicyWriters,
} from '../inline-policy-claims.js';
import { maskedFailureText, safe } from './messages.js';
import { addRecordNames, createOpMasker } from './names.js';
import type { RollbackExecutorContext, RollbackReplayResult } from './types.js';

/**
 * go-to-k/cdkd#4408: put back each inline policy a removal of this rollback
 * took off a principal while a record still holds it there
 * ({@link RollbackInlinePolicyWriters.takeHeldRemovals}), with that record's
 * RECORDED document — what cdkd state says the principal holds, which need
 * not be what AWS held before. Run at the end of each completed-op replay over
 * the bag (`replayRollback`), when every record of the segment is the one the
 * rollback leaves. `replayFailedOperations` runs BEFORE its segment's
 * completed ops, so it calls this only when interrupted (no completed-op
 * replay follows), with `refuseAll`: the records it would read may still be
 * the failed deploy's, so it warns for each and puts nothing back.
 *
 * A holder whose own op of this rollback has not completed is not put back
 * from either (`unsettled`): its record is the failed deploy's post-op one,
 * and the rollback never writes a grant the state before that deploy lacked.
 *
 * The put is `IAMPolicyProvider.create` with a one-principal bag naming the
 * holder's name explicitly: exactly one `Put{Role,Group,User}Policy`, the same
 * serialization the role / group / user providers use for a `Policies` entry.
 *
 * A successful put is recorded as a `ROLLBACK_RESOURCE_SUCCEEDED` event on
 * the holder's logical id, so `cdkd events` shows the grant it wrote.
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
  stackName: string,
  ctx: RollbackExecutorContext,
  result: Pick<RollbackReplayResult, 'warnings'>,
  options: { refuseAll?: boolean } = {}
): Promise<void> {
  for (const removal of writers.takeHeldRemovals(stateResources)) {
    await restoreOne(removal, stateResources, stackName, ctx, result, options.refuseAll === true);
  }
}

async function restoreOne(
  { kind, holders, unreadable, unsettled }: HeldInlinePolicyRemoval,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  result: Pick<RollbackReplayResult, 'warnings'>,
  refuseAll: boolean
): Promise<void> {
  const { logger } = ctx;
  // Logical ids only: a policy or principal name can be secret-derived.
  const ids = [...new Set(holders.map((h) => h.logicalId))].map((id) => safe(id)).join(', ');
  const lost =
    safeMsg`the ${kind} it is on lacks that inline policy until the resource is next updated, or ` +
    `'cdkd drift <stack> --revert' restores it`;
  if (refuseAll || unsettled.length > 0) {
    const pending = refuseAll ? ids : unsettled.map((id) => safe(id)).join(', ');
    logger.warn(
      safeMsg`  Rollback: an inline policy this rollback removed is recorded by ${ids}, but the ` +
        safeMsg`rollback of ${pending} has not completed, so that record may be the failed ` +
        safeMsg`deploy's and cdkd did not put it back; ${lost}.`
    );
    result.warnings++;
    return;
  }
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
  // The deploy's log-only needles for each holder, as `replaySingle` carries
  // an op's (go-to-k/cdkd#1998): a NoEcho value an AWS error may quote.
  const secrets: RecordedSecretValues = new Map();
  for (const h of holders) {
    const bag = ctx.logOnlyNeedlesFor?.(h.logicalId);
    if (bag) carryLogOnlyValues(bag, secrets);
  }
  const masker = createOpMasker(logger, secrets);
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
        [POLICY_LIST_FIELDS[kind]]: [holder.principal],
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
  // Logical id and kind only, as the lines above: no name or document.
  const holderType = stateResources[holder.logicalId]?.resourceType;
  ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
    stackName,
    operation: 'UPDATE',
    logicalId: holder.logicalId,
    ...(typeof holderType === 'string' && { resourceType: holderType }),
    provisionedBy: 'sdk',
    reason: `Put back the inline policy this resource records on its ${kind}, which the rollback had removed from it.`,
  });
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
