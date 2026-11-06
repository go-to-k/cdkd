import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import type { DeleteContext } from '../../region-check.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
} from '../../../types/resource.js';
import { derivedNamePairs } from './shared.js';

/**
 * A failure wrap that never quotes AWS's own text (issue #2319). The thrown
 * message is persisted to `deployments/{runId}.jsonl`, and an IAM
 * `AccessDenied` names the caller's assumed-role ARN, so an AWS-authored
 * failure is named by its class plus the `--verbose` pointer: AWS's text
 * goes to `debug` through the masker, and the wrap is stamped
 * `markRedactedCause` so the retry classifiers read the withheld text on the
 * unmasked `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}), except from a post-create wiring step's
 * failure ({@link markAuxiliaryFailure}), where "it" would read as this user
 * or group (#3826). A cdkd-authored or transport error, or a
 * non-`Error` throw, keeps its text masked (issue #2177,
 * `wrapMaskedAwsError`, issue #4244).
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
 * sees the catch that throws it as a wrap.
 */
export function wrapMaskedError(
  this: IAMUserGroupProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error)) return build(mask(failure.detail));
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  return markRedactedCause(build(`${mask(failure.summary)}${relay}`));
}

/**
 * The cleanup-failure text a partial-create `warn` quotes after `head`, with
 * its closing period (go-to-k/cdkd#2319). An AWS-authored failure is named by
 * its CLASS at warn, since a denied `Delete*` names the caller's assumed-role
 * ARN; AWS's own text goes to `debug` under the same `head`, through `log`'s
 * masker. A cdkd-authored or transport error keeps its text, masked.
 */
export function cleanupFailureText(
  this: IAMUserGroupProvider,
  head: string,
  cleanupError: unknown,
  log: { mask: MaskerFn; debug: (message: string) => void }
): string {
  const failure = describeAwsFailure(cleanupError);
  if (!failure.redacted) return `${log.mask(failure.detail)}.`;
  log.debug(`${head}${log.mask(failure.detail)}`);
  return log.mask(failure.summary);
}

export async function create(
  this: IAMUserGroupProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation (the `ssm-parameter-provider.ts`
  // shape), built here and handed to whichever type's arm runs. Every
  // bag-derived value is masked RAW as well -- user / group names, attached
  // ARNs, group memberships and inline policy names all come out of the
  // resolved `properties` bag. Absent context means identity.
  //
  // A User / Group name is REWRITTEN from the template value (stack prefix,
  // charset folding, truncation), so the masker cannot recognise it by
  // itself: it is added as a needle when the value it came from is a secret.
  const log = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    derivedNamePairs(resourceType, logicalId, properties)
  );
  switch (resourceType) {
    case 'AWS::IAM::User':
      return this.createUser(logicalId, resourceType, properties, log);
    case 'AWS::IAM::Group':
      return this.createGroup(logicalId, resourceType, properties, log);
    case 'AWS::IAM::UserToGroupAddition':
      return this.createUserToGroupAddition(logicalId, resourceType, properties, log);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

export async function update(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177 -- see `create()`. The recorded name is also paired with the
  // PREVIOUS value it was derived from.
  const log = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    [
      ...derivedNamePairs(resourceType, logicalId, properties),
      ...derivedNamePairs(resourceType, logicalId, previousProperties).map(
        ([raw]) => [raw, physicalId] as const
      ),
    ]
  );
  switch (resourceType) {
    case 'AWS::IAM::User':
      return this.updateUser(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context?.inlinePolicyClaimed
      );
    case 'AWS::IAM::Group':
      return this.updateGroup(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context?.inlinePolicyClaimed
      );
    case 'AWS::IAM::UserToGroupAddition':
      return this.updateUserToGroupAddition(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function deleteImpl(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  switch (resourceType) {
    case 'AWS::IAM::User':
      return this.deleteUser(logicalId, physicalId, resourceType, context);
    case 'AWS::IAM::Group':
      return this.deleteGroup(logicalId, physicalId, resourceType, context);
    case 'AWS::IAM::UserToGroupAddition':
      return this.deleteUserToGroupAddition(
        logicalId,
        physicalId,
        resourceType,
        properties,
        context
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}
