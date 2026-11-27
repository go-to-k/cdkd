import { isInterruptedWaitError } from '../../../provisioning/interrupt-watch.js';
import { isStatefulRecreateTargetForReplace } from '../../../provisioning/stateful-types.js';
import { isWaitAbandonedError } from '../../../provisioning/wait-abandoned.js';
import type { ResourceState } from '../../../types/state.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { asIsMessage, displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import type { DeployEngine } from '../../deploy-engine.js';
import { markRedactedCause } from '../../retryable-errors.js';
import { MAX_CAUSE_CHAIN_DEPTH } from '../../retryable-errors/marks.js';
import {
  maskSecretsInText,
  unionOfSecretBags,
  type RecordedSecretValues,
} from '../../secret-redaction.js';
import { printingSecretsFor } from '../masking.js';

/** The Cloud Control handler code for "this patch cannot be applied in place". */
export const CC_NOT_UPDATABLE_CODE = 'NotUpdatable';
const CC_NOT_UPDATABLE_EXCEPTION = 'NotUpdatableException';

/** Where a missing replacement rule is reported. */
const NEW_ISSUE_URL = 'https://github.com/go-to-k/cdkd/issues/new';

/**
 * go-to-k/cdkd#7079: was this failed update of `logicalId` Cloud Control's
 * `NotUpdatable` answer — the synchronous `NotUpdatableException`, or the
 * asynchronous handler code on an UPDATE? Read structurally, never from AWS's
 * prose, and anchored on `logicalId` as `isUpdateUnsupportedError` is: a
 * nested stack's child rejection is the child's, not this resource's.
 */
export function isNotUpdatableError(error: unknown, logicalId: string): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    current !== null && current !== undefined && depth < MAX_CAUSE_CHAIN_DEPTH;
    depth++
  ) {
    const link = current as {
      name?: unknown;
      ccErrorCode?: unknown;
      ccOperation?: unknown;
      logicalId?: unknown;
      cause?: unknown;
    };
    if (typeof link.logicalId === 'string' && link.logicalId !== logicalId) return false;
    if (link.name === CC_NOT_UPDATABLE_EXCEPTION) return true;
    if (link.ccErrorCode === CC_NOT_UPDATABLE_CODE && link.ccOperation === 'UPDATE') return true;
    current = link.cause;
  }
  return false;
}

/**
 * The prefilled new-issue link for a missing replacement rule. It carries ONLY
 * the resource type, the property paths and the error code: never a value, a
 * physical id, an account, a region or a stack name. `undefined` for a type
 * outside AWS's own namespaces (`AWS::`, `Alexa::`): a private or third-party
 * registry type names someone's own resource, which never reaches a public
 * issue, and no cdkd rule could be added for it.
 */
export function replacementRuleIssueUrl(
  resourceType: string,
  properties: readonly string[]
): string | undefined {
  if (!/^(AWS|Alexa)::/.test(resourceType)) return undefined;
  const shown = properties.length > 0 ? properties.join(', ') : '(unknown)';
  const params = new URLSearchParams({
    title: `Replacement rule: ${resourceType} ${shown}`,
    body:
      `Cloud Control refused an in-place update that CloudFormation applies by replacement.\n\n` +
      `Resource type: ${resourceType}\nProperty: ${shown}\nError code: ${CC_NOT_UPDATABLE_CODE}\n`,
  });
  return `${NEW_ISSUE_URL}?${params.toString()}`;
}

/**
 * What to do after a `NotUpdatable` refusal: the property, that CloudFormation
 * replaces the resource, the exact `--replace-resource` command, and the link
 * to report the missing rule. A nested child's resource is out of the flag's
 * reach (it names a top-level stack's resources), so no command is offered.
 */
/** An explicit `false` / `"false"`. */
function isExplicitFalse(value: unknown): boolean {
  return value === false || value === 'false';
}

export function notUpdatableRemedy(input: {
  logicalId: string;
  resourceType: string;
  stackName: string;
  /** The top-level keys this update changed, template to template. */
  changedProperties: ReadonlySet<string>;
  record: ResourceState;
  /** The template's `UpdateReplacePolicy`: `Retain` keeps the old resource and its data. */
  updateReplacePolicy: string | undefined;
  nestedChild: boolean;
}): string {
  const properties = [...input.changedProperties].sort();
  const changes = properties.length > 0 ? `, which changes ${properties.join(', ')}` : '';
  // The command never carries `--force-stateful-recreation`: the data loss is
  // stated, and the deploy's own refusal asks for that confirmation.
  const stateful =
    input.updateReplacePolicy !== 'Retain' &&
    isStatefulRecreateTargetForReplace(
      input.record.resourceType,
      input.record.properties,
      input.record.observedProperties
    ) !== null;
  const how = input.nestedChild
    ? " --replace-resource names a top-level stack's resources only, so it cannot replace a resource of a nested stack."
    : ` To replace it in this deploy, as CloudFormation does: ${
        pasteableCommand('cdkd deploy', [
          { value: input.stackName, hole: 'stack' },
          { flag: '--replace-resource', value: input.logicalId, hole: 'logicalId' },
        ]).command
      }.` +
      (stateful
        ? safeMsg` ${input.logicalId} is stateful: replacing it deletes its data, which the deploy asks you to confirm with --force-stateful-recreation.`
        : '');
  // go-to-k/cdkd#7098: under `ReplaceComputeEnvironment: false` CloudFormation
  // does not replace a Batch compute environment either; it fails the same way.
  if (
    input.resourceType === 'AWS::Batch::ComputeEnvironment' &&
    isExplicitFalse(input.record.properties?.['ReplaceComputeEnvironment'])
  ) {
    return (
      safeMsg`\n${input.logicalId} (${input.resourceType}): Batch refused this update in place (${CC_NOT_UPDATABLE_CODE})${changes}. ReplaceComputeEnvironment is false, so neither cdkd nor CloudFormation replaces the environment.` +
      ` Set ReplaceComputeEnvironment to true (or remove it) to have the change replace it, which deletes the old environment once its job queues move.` +
      how.replace(
        ' To replace it in this deploy, as CloudFormation does: ',
        ' Or replace it in this deploy only: '
      )
    );
  }
  const issueUrl = replacementRuleIssueUrl(input.resourceType, properties);
  return (
    safeMsg`\n${input.logicalId} (${input.resourceType}): Cloud Control refused this update in place (${CC_NOT_UPDATABLE_CODE})${changes}; CloudFormation replaces the resource for such a change.` +
    how +
    (issueUrl === undefined
      ? ''
      : `\ncdkd has no replacement rule for this property yet; report it so one is added: ${issueUrl}`)
  );
}

/**
 * The error a failed in-place update rethrows, with `remedies` appended.
 *
 * go-to-k/cdkd#2319: appended to AWS's own error, a remedy would be dropped
 * with AWS's text when the event recorder reduces that error to its class.
 * Such an error is wrapped instead: the class plus the remedy in the persisted
 * message, AWS's text in `debug` (masked) and on the `cause`, which every
 * downstream mark reader walks. An interrupted or abandoned wait, a non-Error,
 * or no remedy at all is returned as it is.
 */
export function withUpdateFailureRemedy(
  engine: DeployEngine,
  updateError: unknown,
  logicalId: string,
  remedy: string,
  updateSecrets: RecordedSecretValues
): unknown {
  if (
    remedy === '' ||
    !(updateError instanceof Error) ||
    isInterruptedWaitError(updateError) ||
    isWaitAbandonedError(updateError)
  ) {
    return updateError;
  }
  const updateFailure = describeAwsFailure(updateError);
  if (updateFailure.redacted) {
    const shownSecrets = unionOfSecretBags([
      updateSecrets,
      printingSecretsFor(engine.secretsRun, logicalId),
    ]);
    engine.logger.debug(
      safeMsg`${maskSecretsInText(logicalId, shownSecrets)}: the update failed: ${asIsMessage(
        maskSecretsInText(updateFailure.detail, shownSecrets)
      )}`
    );
    const wrapped = new Error(`${displaySafe(updateFailure.summary)}${remedy}`, {
      cause: updateError,
    });
    // The AWS class stays the recorded `error.name`, as when the error
    // itself was thrown -- except `CredentialsProviderError`, a name
    // `isAwsAuthoredFailure` reads as AWS-authored on its own, so the
    // recorder would reduce the wrap too and drop the remedy.
    if (updateError.name !== 'CredentialsProviderError') wrapped.name = updateError.name;
    return markRedactedCause(wrapped);
  }
  updateError.message += remedy;
  return updateError;
}
