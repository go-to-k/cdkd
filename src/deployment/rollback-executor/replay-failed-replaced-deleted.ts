/**
 * The failed-op replay's two arms for a failed UPDATE whose delete-first
 * replacement removed the old resource before the new one's create failed,
 * split out of `replay-failed.ts` (go-to-k/cdkd#6958) to keep it under the
 * file-size cap.
 *
 * - `skip-failed-replaced-deleted` (go-to-k/cdkd#4604): warned, nothing done.
 * - `recreate-failed-replaced-deleted` (go-to-k/cdkd#6958): a type a plain
 *   deploy replaces delete-first (`replacesDeleteFirst`) re-creates the old
 *   resource from its journaled record, as CloudFormation's UPDATE_ROLLBACK
 *   does, so the VPC gets its gateway and the subnet its route table back.
 */
import { displayPhysicalId } from '../../provisioning/secret-physical-id.js';
import { applyDefaultNameForFallback } from '../../provisioning/resource-name.js';
import { acceptedCreateOnlyDropsEvidence } from '../../provisioning/property-coverage.js';
import { withNameGenerationReached } from '../../state/name-generation.js';
import { cdkdRemedy, proseQuoted } from '../../utils/pasteable-command.js';
import { safeMsg } from '../../utils/display-safe.js';
import type { ResourceState } from '../../types/state.js';
import { withoutVersionAttestation } from '../reference-provenance-record.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import { isRecreateRetryableError } from '../retryable-errors.js';
import {
  noEchoLeavesOf,
  recordNoEchoAttributeValues,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import type { MaskerFn } from '../../provisioning/masked-retry-logger.js';
import {
  recordRollbackSkip,
  refusalResourceType,
  replayingStateCreateContext,
  shownLogicalId,
} from './messages.js';
import { ABSENT_BASELINE_SKIP_CAUSE, requireRestorableBaseline } from './names.js';
import { refuseMaskedReplayBaseline, resolveReplayProps } from './replay-props.js';
import { refuseMarkedNoEchoRecreate } from './replay-noecho.js';
import { createWithRollbackRetry, recordedPropertiesAfterReplayCreate } from './replay-retry.js';
import { redactRollbackRecord, type ReplayResolvers } from './replay-secrets.js';
import type { FailedOperation, FailedOpReplayResult, RollbackExecutorContext } from './types.js';
import type { ReplayFailedOperationsOptions } from './replay-failed-checks.js';

/** What both arms read from `replayFailedOperations`' iteration. */
export interface ReplacedDeletedScope {
  op: FailedOperation;
  stateResources: Record<string, ResourceState>;
  stackName: string;
  ctx: RollbackExecutorContext;
  result: FailedOpReplayResult;
  /** The op's masker (`createOpMasker`). */
  mask: MaskerFn;
  secrets: RecordedSecretValues;
  resolver: ReplayResolvers;
  options: Pick<ReplayFailedOperationsOptions, 'forDestroy' | 'isInterrupted' | 'afterOp'>;
}

/** The replay's arm for either action. */
export async function replayReplacedDeleted(
  action: 'skip-failed-replaced-deleted' | 'recreate-failed-replaced-deleted',
  s: ReplacedDeletedScope
): Promise<void> {
  if (action === 'skip-failed-replaced-deleted') skipFailedReplacedDeleted(s);
  else await recreateFailedReplacedDeleted(s);
}

/** `skip-failed-replaced-deleted`: warned, nothing reverted (go-to-k/cdkd#4604). */
export function skipFailedReplacedDeleted(s: ReplacedDeletedScope): void {
  const { op, mask } = s;
  // A delete-first replacement removed the old resource before its create
  // failed. Nothing is reverted (there is nothing to revert onto); the record
  // still names the removed id. Cleared with its orphan like every warned
  // skip: kept alone, a later `--revert-failed` would aim a force-revert at a
  // resource that is gone.
  s.ctx.logger.warn(
    safeMsg`  Rollback: Skipping failed UPDATE of ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) — its replacement deleted the old resource ${mask(String(displayPhysicalId(op.previousState?.resourceType ?? op.resourceType, op.physicalId)))} before the new one's create failed, so there is nothing to revert` +
      (s.options.forDestroy === true
        ? '; the destroy drops its record with the stack'
        : '; state still records it, and a deploy whose template still replaces it creates it again')
  );
  recordRollbackSkip(
    s,
    op,
    'The failed UPDATE was a replacement that deleted the old resource before its create failed, so there is nothing to revert it onto; state still records the deleted resource.'
  );
}

/**
 * `recreate-failed-replaced-deleted`: re-create the old resource from
 * `op.previousState` through the replay-CREATE context the reverse
 * replacement uses, and record it under its new physical id. A failure
 * throws to the replay's shared catch, which keeps the op for a re-run.
 */
export async function recreateFailedReplacedDeleted(s: ReplacedDeletedScope): Promise<void> {
  const { op, stateResources, ctx, mask, secrets } = s;
  const { logger } = ctx;
  const prev = op.previousState!;
  if (
    !requireRestorableBaseline(prev.properties, logger, {
      logicalId: op.logicalId,
      consequence: 're-create the deleted resource with nothing it declared',
      remedy: `Re-run ${proseQuoted(cdkdRemedy('cdkd deploy'), '`')} to create it from the template.`,
      retry: `re-running ${proseQuoted(cdkdRemedy('cdkd rollback', '--revert-failed'), '`')} retries this op`,
    })
  ) {
    recordRollbackSkip(s, op, ABSENT_BASELINE_SKIP_CAUSE);
    return;
  }
  const oldType = prev.resourceType;
  logger.info(
    safeMsg`  Rollback: re-creating ${shownLogicalId(op.logicalId)} (${refusalResourceType(oldType)}): its replacement deleted ` +
      `the old resource before the new one's create failed`
  );
  const { provider, provisionedBy } = ctx.providerRegistry.getProviderFor({
    resourceType: oldType,
    provisionedBy: prev.provisionedBy,
  });
  const resolvedPrevProps =
    (await resolveReplayProps(prev.properties, s.resolver, secrets, ctx, op.logicalId, prev)) ?? {};
  // Issue #2274 / go-to-k/cdkd#4043, as the reverse replacement's re-create:
  // a masked value is refused before the create, not sent.
  refuseMarkedNoEchoRecreate(resolvedPrevProps, noEchoLeavesOf(prev), op.logicalId);
  refuseMaskedReplayBaseline(resolvedPrevProps, op.logicalId);
  // go-to-k/cdkd#3199, as the reverse replacement's re-create: a Cloud
  // Control create gets the name the engine's create sites fill. A copy, so
  // the recorded bag below never holds it.
  const createProps = {
    ...(provisionedBy === 'cc-api'
      ? applyDefaultNameForFallback(op.logicalId, oldType, resolvedPrevProps)
      : resolvedPrevProps),
  };
  const createResult = await createWithRollbackRetry(
    provider,
    () =>
      withCurrentResourceSecrets(secrets, () =>
        provider.create(
          op.logicalId,
          oldType,
          createProps,
          replayingStateCreateContext(secrets, prev.typedPayloadLeaves)
        )
      ),
    op.logicalId,
    logger,
    s.options.isInterrupted,
    mask,
    {
      isRetryable: isRecreateRetryableError,
      interruptedMessage: 'Rollback interrupted while re-creating the deleted old resource',
    }
  );
  // go-to-k/cdkd#4434: the create's NoEcho declaration first, as the reverse
  // replacement records it.
  recordNoEchoAttributeValues(createResult, secrets, resolvedPrevProps);
  const { observedProperties: _staleObserved, noEchoValueMacs: _staleMacs, ...prevRecord } = prev;
  const restoredProperties =
    recordedPropertiesAfterReplayCreate(prevRecord, createResult) ?? prev.properties;
  stateResources[op.logicalId] = withoutVersionAttestation(
    redactRollbackRecord(
      {
        ...withNameGenerationReached(prevRecord, op.logicalId, op.nameGeneration),
        physicalId: createResult.physicalId,
        attributes: createResult.attributes ?? {},
        properties: restoredProperties,
        // A new resource: its evidence is rebuilt for the route it took.
        acceptedCreateOnlyDrops: acceptedCreateOnlyDropsEvidence(
          restoredProperties,
          oldType,
          provisionedBy
        ),
      },
      secrets,
      prevRecord.properties,
      prevRecord.attributes
    )
  );
  logger.info(
    safeMsg`  Rollback: ${shownLogicalId(op.logicalId)} re-created as ${mask(String(displayPhysicalId(oldType, createResult.physicalId)))}`
  );
  await s.options.afterOp?.(op.logicalId);
  ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
    stackName: s.stackName,
    operation: 'UPDATE',
    logicalId: op.logicalId,
    resourceType: oldType,
    ...(provisionedBy && { provisionedBy }),
  });
}
