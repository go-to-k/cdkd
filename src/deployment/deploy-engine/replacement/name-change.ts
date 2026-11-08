/**
 * The replacement name-change checks run before a replacement's create.
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import type { ProvisionedBy } from '../../../provisioning/provider-registry.js';
import { explicitNamePropertyFor } from '../../../provisioning/resource-name.js';
import type { ResourceProvider } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displayAwsMessage, displaySafe } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import {
  type ReplacementNameChange,
  probeErrorMeansNameHeld,
  probeFoundSameId,
  replacementCreateAdoptsName,
  replacementMovesEventBus,
  replacementNameProbe,
  replacementOrderIsCaseSensitive,
  renderReplacementNameChange,
  replacementRequestsDifferentName,
  maskRewrittenSentName,
  replacementSentNameMoves,
  replacementGeneratedNameMoves,
} from '../../replacement-name-holder.js';
import { markNonRetryable, markRedactedCause } from '../../retryable-errors.js';
import {
  type RecordedSecretValues,
  SECRET_MASK,
  maskSecretsInText,
} from '../../secret-redaction.js';
import type { ReplacementDeps } from './run-state.js';

/**
 * The name a Type-changed replacement asks for, as a change to probe
 * (go-to-k/cdkd#3937): across two types the "same" name is not one the old
 * resource holds in the new type's name space. `undefined` without an
 * explicit, plain name (a generated one is not compared).
 */
export function typeChangeNameQuestion(
  resourceType: string,
  input: { desiredProperties: Record<string, unknown>; currentResource: ResourceState }
): ReplacementNameChange | undefined {
  const property = explicitNamePropertyFor(resourceType);
  if (property === undefined) return undefined;
  const desired = input.desiredProperties[property];
  if (typeof desired !== 'string' || desired === '' || desired === SECRET_MASK) return undefined;
  if (desired.includes('{{resolve:')) return undefined;
  return {
    property,
    desiredName: desired,
    heldName: undefined,
    heldProperty: undefined,
    physicalId: input.currentResource.physicalId,
  };
}

/**
 * The name a replacement moves to when it is KNOWN to differ from the one
 * the old resource holds ({@link replacementRequestsDifferentName}), checked
 * against AWS where the create would not refuse a taken name
 * (go-to-k/cdkd#3937, {@link replacementNameProbe}).
 *
 * - The probe finds ANOTHER resource under the name: refuses, with nothing
 *   created or deleted — the create would hand that resource back (or
 *   overwrite it) and the deploy would record it as its own.
 * - It finds the OLD resource: the difference was not real, so `undefined`
 *   and the caller keeps its pre-existing order.
 * - It cannot be asked, or fails: refuses, since a guess either way can
 *   adopt a stranger's resource.
 *
 * The answer also picks the ORDER of the fallback and `--recreate-via-*`
 * arms, so it compares names exactly unless the type's name space is known
 * to fold case (go-to-k/cdkd#3931, {@link replacementOrderIsCaseSensitive});
 * an EventBridge rule moving bus counts as a name change
 * ({@link replacementMovesEventBus}). A Type change onto a name-adopting
 * type always asks, and a holder found under the id the old resource of
 * ANOTHER type has is still refused: two namespaces, two resources.
 */
export async function checkedReplacementNameChange(
  deps: ReplacementDeps,
  input: {
    logicalId: string;
    resourceType: string;
    oldResourceType: string;
    stackName: string;
    currentResource: ResourceState;
    desiredProperties: Record<string, unknown>;
    createProvider: ResourceProvider;
    createdVia: ProvisionedBy | undefined;
    createProps: Record<string, unknown>;
    secrets: RecordedSecretValues;
  }
): Promise<ReplacementNameChange | undefined> {
  const { logicalId, resourceType, currentResource, secrets } = input;
  const question = {
    oldResourceType: input.oldResourceType,
    newResourceType: resourceType,
    desiredProperties: input.desiredProperties,
    recorded: currentResource.properties,
    observed: currentResource.observedProperties,
    physicalId: currentResource.physicalId,
  };
  // The #3808 comparison folds case, which is the safe direction for a
  // refusal. Here it decides whether deleting first frees the name, and
  // whether an adopting create is asked first, so a case-only rename is a
  // different name unless the type folds case.
  const adopts = replacementCreateAdoptsName(resourceType, input.createdVia);
  const typeChanged = input.oldResourceType !== resourceType;
  const generatedMove = replacementGeneratedNameMoves({
    oldResourceType: input.oldResourceType,
    newResourceType: resourceType,
    createdVia: input.createdVia,
    desiredProperties: input.desiredProperties,
    physicalId: currentResource.physicalId,
    logicalId,
  });
  const change =
    replacementRequestsDifferentName(question) ??
    (adopts || replacementOrderIsCaseSensitive(resourceType)
      ? replacementRequestsDifferentName({ ...question, caseSensitive: true })
      : undefined) ??
    replacementMovesEventBus(question) ??
    replacementSentNameMoves({
      oldResourceType: input.oldResourceType,
      newResourceType: resourceType,
      createdVia: input.createdVia,
      desiredProperties: input.desiredProperties,
      physicalId: currentResource.physicalId,
      logicalId,
    }) ??
    (adopts && typeChanged ? typeChangeNameQuestion(resourceType, input) : undefined) ??
    // go-to-k/cdkd#5064 phase 2: a generated name at the next generation.
    generatedMove;
  if (change === undefined) return undefined;
  // That move is checked by the generated-name guard when it planned the
  // replacement (a lookup at plan time, the intent in the ledger so a crash
  // re-run takes its own resource back); the probe below covers the rest.
  if (change === generatedMove && deps.generatedNameGuarded(logicalId)) return change;
  const probe = replacementNameProbe({
    resourceType,
    createdVia: input.createdVia,
    change,
    region: deps.stackRegion,
  });
  if (probe === undefined) return change;
  // A secret-derived name a provider rewrites before sending (ELBv2) is
  // printed by AWS, and in the holder's ARN, in a spelling the recorded
  // secrets do not match: mask that spelling too.
  const maskName = maskRewrittenSentName(resourceType, input.createProps, logicalId, (text) =>
    maskSecretsInText(text, secrets)
  );
  const subject = `${displaySafe(logicalId)} (${displaySafe(resourceType)})`;
  const adoptsText =
    `its create API hands back or overwrites an existing resource of that name instead of ` +
    `refusing it`;
  if (probe === null) {
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd cannot ` +
            `check whether another resource already holds it. Nothing was created or deleted.`
        ),
        'NAMED_REPLACEMENT_COLLISION'
      )
    );
  }
  // Every SDK provider of a name-adopting type implements `import()`
  // (pinned in `replacement-name-holder.test.ts`). One without it is a test
  // double or a wrapper; refusing there would turn every mocked renamed
  // queue, topic, rule or alarm in the suite into a probe test.
  const lookup = input.createProvider.import?.bind(input.createProvider);
  if (lookup === undefined) return change;
  let found: Awaited<ReturnType<NonNullable<ResourceProvider['import']>>>;
  try {
    found = await deps.withRetry(
      () =>
        lookup({
          logicalId,
          resourceType,
          stackName: input.stackName,
          region: deps.stackRegion,
          properties: input.createProps,
          ...probe,
        }),
      logicalId,
      undefined,
      undefined,
      input.createProvider
    );
  } catch (probeError) {
    if (probeErrorMeansNameHeld(resourceType, probeError)) {
      throw markNonRetryable(
        new CdkdError(
          maskName(
            `${subject} requires replacement, and S3 answered 403 Forbidden for bucket ` +
              `${displaySafe(change.desiredName)}: another account owns that name, or a bucket ` +
              `of this account denies this identity \`s3:ListBucket\`, or the request's ` +
              `credentials were rejected. Nothing was created or deleted. Choose another name, ` +
              `or if the bucket is yours grant \`s3:ListBucket\` on it (or delete it) and ` +
              `re-run.`
          ),
          'NAMED_REPLACEMENT_COLLISION',
          probeError instanceof Error ? probeError : undefined
        )
      );
    }
    // go-to-k/cdkd#2319: the thrown message is persisted to
    // `deployments/{runId}.jsonl`, and an AWS-authored probe failure (an
    // `AccessDenied`) names the caller's ARN and account. It is named by its
    // class plus the `--verbose` pointer, AWS's own text goes to `debug`
    // masked, and the wrap is stamped so a classifier still reads that text
    // on the `cause` chain. A cdkd-authored or transport failure keeps its text.
    const failure = describeAwsFailure(probeError);
    const failureText = (text: string): string =>
      maskName(
        `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd could ` +
          `not check whether another resource already holds it: ${text}${text.endsWith('.') ? '' : '.'} ` +
          `Nothing was created or deleted. Re-run the deploy once the check can succeed.`
      );
    const awsText = displayAwsMessage(maskName(failure.detail));
    if (failure.redacted) deps.logger.debug(failureText(awsText));
    const refusal = new CdkdError(
      failureText(failure.redacted ? displaySafe(maskName(failure.summary)) : awsText),
      'NAMED_REPLACEMENT_COLLISION',
      probeError instanceof Error ? probeError : undefined
    );
    throw markNonRetryable(
      failure.redacted && probeError instanceof Error ? markRedactedCause(refusal) : refusal
    );
  }
  if (found === null) return change;
  if (
    !typeChanged &&
    probeFoundSameId(resourceType, found.physicalId, currentResource.physicalId)
  ) {
    return undefined;
  }
  // go-to-k/cdkd#5143: the holder may be this resource's own copy that an
  // earlier rolled-back deploy kept; say so only when the history shows it.
  const keptByRollback =
    (await deps.rollbackRetainedCopies?.(input.stackName).catch(() => [])) ?? [];
  const ownRetainedCopy = keptByRollback.some(
    (copy) =>
      copy.logicalId === logicalId &&
      copy.resourceType === resourceType &&
      probeFoundSameId(resourceType, copy.physicalId, found.physicalId)
  );
  // Worded from what the history records, not as a fact about the live
  // holder: the copy may since have been deleted and the name taken by an
  // unrelated resource, which the advice must not tell anyone to delete.
  const remedy = ownRetainedCopy
    ? `This stack's event history records that a rolled-back deploy kept ` +
      `${displaySafe(logicalId)}'s replacement under this name because of ` +
      `UpdateReplacePolicy: Retain, as CloudFormation also does, untracked by cdkd. If the ` +
      `holder is that copy and you no longer need it, delete it; otherwise choose another name.`
    : `Choose a name no other resource holds, or delete the resource holding it if it is yours.`;
  throw markNonRetryable(
    new CdkdError(
      maskName(
        `${subject} requires replacement, and another existing resource ` +
          `(${displaySafe(found.physicalId)}) already holds the name it asks for. ` +
          `${renderReplacementNameChange(change, input.createProps)}. Since ${adoptsText}, creating the replacement ` +
          `would take that resource over and record it as this stack's. Nothing was ` +
          `created or deleted. ${remedy}`
      ),
      'NAMED_REPLACEMENT_COLLISION'
    )
  );
}
