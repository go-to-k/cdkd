import type { IAMClient } from '@aws-sdk/client-iam';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import type { ProvisioningError } from '../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type { DeleteContext } from '../region-check.js';
import type { MaskedLogSinks, MaskerFn } from '../masked-retry-logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import type { AttachedPrincipals } from './iam-policy/shared.js';
import { create, detachPartialPolicy } from './iam-policy/create.js';
import { update } from './iam-policy/update.js';
import { deleteImpl } from './iam-policy/delete.js';
import { readCurrentState, decodePolicyDocument, importImpl } from './iam-policy/read-state.js';

export {
  POLICY_NAME_SKIP_REASON,
  POLICY_NO_TARGET_SKIP_REASON,
  POLICY_MALFORMED_TARGET_SKIP_REASON,
  POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON,
} from './iam-policy/shared.js';

/**
 * AWS IAM Policy Provider
 *
 * Implements resource provisioning for AWS::IAM::Policy using the IAM SDK.
 * This is required because IAM Policy is not supported by Cloud Control API.
 *
 * Note: AWS::IAM::Policy in CloudFormation is an inline policy attached to roles/users/groups,
 * not a managed policy (AWS::IAM::ManagedPolicy).
 */
export class IAMPolicyProvider implements ResourceProvider {
  iamClient: IAMClient;
  logger: ConsoleLogger = getLogger().child('IAMPolicyProvider');

  /**
   * A failure wrap that never quotes AWS's own text (issue #2319). The thrown
   * message is persisted to `deployments/{runId}.jsonl`, and an IAM
   * `AccessDenied` names the caller's assumed-role ARN, so an AWS-authored
   * failure is named by its class plus the `--verbose` pointer: AWS's text
   * goes to `debug` through the masker, and the wrap is stamped
   * `markRedactedCause` so the retry classifiers read the withheld text on the
   * unmasked `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}). A cdkd-authored or transport error, or a
   * non-`Error` throw, keeps its text masked (issue #2177,
   * `wrapMaskedAwsError`, issue #4244).
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
   * sees the catch that throws it as a wrap.
   */
  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error)) return build(mask(failure.detail));
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    return markRedactedCause(
      build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`)
    );
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::IAM::Policy', new Set(['PolicyName', 'PolicyDocument', 'Roles', 'Groups', 'Users'])],
  ]);

  constructor() {
    // Use global AWS clients manager for better resource management
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM inline policy
   */
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  /** See {@link detachPartialPolicy} in `iam-policy/create.ts`. */
  detachPartialPolicy(
    logicalId: string,
    policyName: string,
    attached: AttachedPrincipals,
    sinks: MaskedLogSinks,
    maskSecrets: MaskerFn | undefined
  ): Promise<void> {
    return detachPartialPolicy.call(this, logicalId, policyName, attached, sinks, maskSecrets);
  }

  /**
   * Update an IAM inline policy
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  /**
   * Delete an IAM inline policy
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  /** See {@link readCurrentState} in `iam-policy/read-state.ts`. */
  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties);
  }

  /** See {@link decodePolicyDocument} in `iam-policy/read-state.ts`. */
  decodePolicyDocument(raw: string | undefined): unknown {
    return decodePolicyDocument.call(this, raw);
  }

  /** See {@link importImpl} in `iam-policy/read-state.ts`. */
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
