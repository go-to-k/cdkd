/**
 * The create-first replacement (`createFirstThenDeleteOld`).
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';
import type { NoEchoDeleteValues } from '../../noecho-delete-reresolution.js';
import { printingSecretsFor, secretNameBagFor } from '../masking.js';
import type { ProvisionedBy } from '../../../provisioning/provider-registry.js';
import type { ResourceCreateResult, ResourceProvider } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  asIsMessage,
  displayAwsMessage,
  displaySafe,
  safeMsg,
} from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import {
  type ReplacementNameChange,
  renderReplacementNameChange,
  maskRewrittenSentName,
} from '../../replacement-name-holder.js';
import { withCurrentResourceSecrets } from '../../resource-secrets-scope.js';
import { generatedReplacementHolderAdvice } from '../name-collision.js';
import { isNameCollisionErrorFrom, markNonRetryable } from '../../retryable-errors.js';
import {
  type RecordedSecretValues,
  createSecretMasker,
  createUnionSecretMasker,
  maskSecretsInText,
  unionOfSecretBags,
} from '../../secret-redaction.js';
import { prepareFinalSnapshotForDelete } from './delete-context.js';
import { deleteReplacedAfterCreate } from './delete-replaced.js';
import type { ReplacementRunState, ReplacementDeps } from './run-state.js';

/**
 * The create-first order for a replacement whose name is KNOWN to move off
 * the one the old resource holds (go-to-k/cdkd#3931): the `--recreate-via-*`
 * destroy-then-create and the UPDATE-not-supported fallback's DELETE →
 * CREATE delete first only to free a name the old resource holds, and here
 * it holds another. Deleting first freed nothing, so when another resource
 * held the new name the create collided with the managed resource already
 * gone. Now the old resource is deleted only once its replacement exists,
 * and a collision refuses with nothing deleted.
 *
 * The final-snapshot gate runs BEFORE the create, so its refusals still
 * change nothing; the delete after it is the property-driven cleanup's
 * ({@link deleteReplacedAfterCreate}).
 */
export async function createFirstThenDeleteOld(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  input: {
    logicalId: string;
    resourceType: string;
    oldResourceType: string;
    currentResource: ResourceState;
    createProvider: ResourceProvider;
    createProps: Record<string, unknown>;
    deleteProvider: ResourceProvider;
    /** The layer `deleteProvider` was routed to, for a guard row (issue #2422). */
    deleteProvisionedBy: 'sdk' | 'cc-api' | undefined;
    deleteProperties: Record<string, unknown>;
    secrets: RecordedSecretValues;
    change: ReplacementNameChange;
    /** An equal physical id on the two halves names the SAME resource. */
    equalIdIsSameResource: boolean;
    snapshotPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    deletePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    /** What forced the replacement, for the refusals. */
    trigger: string;
    /** `UpdateReplacePolicy: Retain`: create only, the old resource stays. */
    retainOld?: boolean;
    /** go-to-k/cdkd#4682: today's values at the old record's NoEcho coordinates. */
    noEchoDeleteValues?: NoEchoDeleteValues | undefined;
    /** go-to-k/cdkd#5064 phase 2: what the generated-name guard reads. */
    stackName: string;
    createdVia: ProvisionedBy | undefined;
    resolvedProps: Record<string, unknown>;
  }
): Promise<ResourceCreateResult> {
  const { logicalId, resourceType, currentResource, secrets } = input;
  const retainOld = input.retainOld === true;
  // Before the create, so a refusal changes nothing. A PRE_DELETE_SNAPSHOT
  // type would take its snapshot here, before the create window; none of
  // them has a name `replacementRequestsDifferentName` reads, so none
  // reaches this method.
  const finalSnapshotIdentifier = retainOld
    ? undefined
    : await prepareFinalSnapshotForDelete(
        deps,
        logicalId,
        input.oldResourceType,
        currentResource,
        input.snapshotPolicy,
        // A superset of the delete's masker below (`createSecretMasker(secrets)`):
        // the resolved bag plus the #2007 name bag. No PRE_DELETE_SNAPSHOT type
        // reaches this method today, so no snapshot line is logged here yet.
        createUnionSecretMasker([secrets, secretNameBagFor(deps.secretsRun(), logicalId)])
      );
  deps.logger.info(
    retainOld
      ? safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource (the old one is retained)...`
      : safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource before deleting the old one...`
  );
  // The rewritten spelling of a secret-derived name (ELBv2), under either
  // prefix flag, is in AWS's text, the physical ids and the rendered name
  // change, where the literal mask misses it.
  const maskName = maskRewrittenSentName(resourceType, input.createProps, logicalId, (text) =>
    maskSecretsInText(text, secrets)
  );
  let createResult: ResourceCreateResult;
  try {
    createResult = await deps.guardedReplacementCreate(
      {
        logicalId,
        resourceType,
        stackName: input.stackName,
        createdVia: input.createdVia,
        resolvedProps: input.resolvedProps,
      },
      () =>
        deps.withRetry(
          () =>
            withCurrentResourceSecrets(secrets, () =>
              input.createProvider.create(logicalId, resourceType, input.createProps, {
                maskSecrets: createSecretMasker(secrets),
              })
            ),
          logicalId,
          undefined,
          undefined,
          input.createProvider
        )
    );
  } catch (createError) {
    // The old resource is untouched: a raw failure is the whole story.
    if (!isNameCollisionErrorFrom(createError, logicalId)) throw createError;
    // go-to-k/cdkd#2319: the refusal is persisted, so an AWS-authored
    // collision is quoted by its class plus the `--verbose` pointer and AWS's
    // text goes to `debug`. No reader needs AWS's wording in this MESSAGE:
    // `isNameCollisionErrorFrom` reads the chain, the rollback keys on the
    // code, and the "the create collided" sentence is cdkd's. A provider's
    // own wrap keeps its text.
    const createFailure = describeAwsFailure(createError);
    const createAwsMsg = displayAwsMessage(maskName(createFailure.detail));
    const createMsg = createFailure.redacted
      ? displaySafe(maskName(createFailure.summary)).replace(/\.$/, '')
      : createAwsMsg;
    if (createFailure.redacted) {
      deps.logger.debug(
        safeMsg`${maskName(logicalId)}: the create-first attempt collided: ${asIsMessage(createAwsMsg)}`
      );
    }
    // Marked: the message quotes the collision text, which the recreate
    // retry classifier would otherwise retry for minutes.
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
            `(${input.trigger}), and cdkd created the new resource first because its name ` +
            `differs, but the create collided: ${createMsg}. If the collision is on the ` +
            `requested name: ${renderReplacementNameChange(input.change, input.createProps)}. Nothing was deleted` +
            (retainOld ? ` (UpdateReplacePolicy: Retain keeps the old resource in place)` : '') +
            `. Choose a name no other resource holds, or delete the resource holding it if it ` +
            `is yours.` +
            generatedReplacementHolderAdvice({
              stackName: input.stackName,
              logicalId,
              change: input.change,
              oldPhysicalId: currentResource.physicalId,
              // The printing bag too: the old name can be secret-derived.
              mask: (text: string) =>
                maskName(
                  maskSecretsInText(
                    text,
                    unionOfSecretBags([secrets, printingSecretsFor(deps.secretsRun(), logicalId)])
                  )
                ),
            })
        ),
        'NAMED_REPLACEMENT_COLLISION',
        createError instanceof Error ? createError : undefined
      )
    );
  }
  if (input.equalIdIsSameResource && createResult.physicalId === currentResource.physicalId) {
    // A name-idempotent create handed the old resource back, so it holds the
    // requested name after all and deleting it would delete the "new" one.
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
            `(${input.trigger}) under a new name, but the create returned the resource being ` +
            `replaced (${displaySafe(currentResource.physicalId)}) instead of a new one, so ` +
            `cdkd cannot tell which name it holds. Nothing was deleted. Delete that resource ` +
            `by hand if it is yours, then re-run the deploy.`
        ),
        'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
      )
    );
  }
  if (retainOld) return createResult;
  deps.logger.info(
    safeMsg`  Deleting old ${logicalId} (${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)})...`
  );
  await deleteReplacedAfterCreate(
    run,
    deps,
    logicalId,
    input.oldResourceType,
    currentResource,
    input.deleteProvider,
    input.deleteProperties,
    finalSnapshotIdentifier,
    input.deletePolicy,
    secrets,
    input.deleteProvisionedBy,
    input.noEchoDeleteValues
  );
  return createResult;
}
