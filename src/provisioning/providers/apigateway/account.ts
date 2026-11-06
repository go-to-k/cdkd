import { ApiGatewayProvider } from '../apigateway-provider.js';
import { UpdateAccountCommand } from '@aws-sdk/client-api-gateway';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

// ─── AWS::ApiGateway::Account ───────────────────────────────────────

/**
 * Create API Gateway Account settings
 *
 * Uses UpdateAccountCommand because API Gateway Account is a singleton.
 * Retries on "not authorized" errors due to IAM role trust propagation delays.
 */
export async function createAccount(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway Account ${logicalId}`);

  const cloudWatchRoleArn = properties['CloudWatchRoleArn'] as string | undefined;

  try {
    await this.updateAccountWithRetry(cloudWatchRoleArn, logicalId, resourceType, log);

    log.debug(`Successfully created API Gateway Account ${logicalId}`);

    return {
      physicalId: 'ApiGatewayAccount',
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway Account ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * Update API Gateway Account settings
 */
export async function updateAccount(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  log.debug(`Updating API Gateway Account ${logicalId}`);

  const cloudWatchRoleArn = properties['CloudWatchRoleArn'] as string | undefined;

  try {
    await this.updateAccountWithRetry(cloudWatchRoleArn, logicalId, resourceType, log);

    log.debug(`Successfully updated API Gateway Account ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway Account ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Delete API Gateway Account settings
 *
 * Clears the CloudWatch role ARN by setting it to empty string.
 */
export async function deleteAccount(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway Account ${logicalId}`);

  try {
    await this.apiGatewayClient.send(
      new UpdateAccountCommand({
        patchOperations: [
          {
            op: 'replace',
            path: '/cloudwatchRoleArn',
            value: '',
          },
        ],
      })
    );

    this.logger.debug(`Successfully deleted API Gateway Account ${logicalId}`);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const failure = this.wrapMaskedError(
      context?.maskSecrets ?? ((text) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway Account ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The Account is a per-region singleton that cannot be absent, so a
    // `NotFoundException` from `UpdateAccount` names something else and the
    // CloudWatch role ARN is still set. The wrap carries that class, which
    // satisfies the "already deleted" classifiers' `NotFoundException`
    // needle and would drop the record, so mark it not gone: they check the
    // marker first (go-to-k/cdkd#5222, #5228). Retryability stays the retry
    // classifiers'.
    throw error instanceof Error && error.name.includes('NotFound')
      ? markNotGone(failure)
      : failure;
  }
}

/**
 * Update Account with retry logic for IAM propagation delays
 *
 * When a new IAM role is created and immediately assigned as the API Gateway
 * CloudWatch role, API Gateway may reject it with "not authorized" because
 * the IAM trust relationship hasn't fully propagated yet.
 *
 * `log` is the calling operation's masked sink (issue #2177).
 */
export async function updateAccountWithRetry(
  this: ApiGatewayProvider,
  cloudWatchRoleArn: string | undefined,
  logicalId: string,
  _resourceType: string,
  log: MaskedLogSinks
): Promise<void> {
  // Use `!== undefined` rather than a truthy gate so that an explicit
  // empty string `''` (the cdkd-state representation of "no
  // CloudWatchRole configured", produced by readCurrentStateAccount,
  // by deleteAccount, and by `removalDefaults` for a removed property) reaches AWS as a legitimate
  // `replace /cloudwatchRoleArn ''` patch operation. A truthy gate
  // would silently drop `''` and produce an empty patchOperations
  // list, so `cdkd drift --revert` would succeed with no actual
  // AWS-side change and the very next `cdkd drift` would re-detect
  // the same drift — a silent fail mode.
  const patchOperations =
    cloudWatchRoleArn !== undefined
      ? [
          {
            op: 'replace' as const,
            path: '/cloudwatchRoleArn',
            value: cloudWatchRoleArn,
          },
        ]
      : [];

  for (let attempt = 1; attempt <= ApiGatewayProvider.MAX_IAM_RETRIES; attempt++) {
    try {
      await this.apiGatewayClient.send(new UpdateAccountCommand({ patchOperations }));
      return;
    } catch (error) {
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      const message = describeAwsFailure(error).detail;
      const isIamPropagationError =
        message.toLowerCase().includes('not authorized') ||
        message.toLowerCase().includes('does not have required permissions') ||
        message.toLowerCase().includes('the role arn does not have required trust') ||
        message.toLowerCase().includes('too many requests');

      if (isIamPropagationError && attempt < ApiGatewayProvider.MAX_IAM_RETRIES) {
        log.warn(
          `IAM propagation delay for ${logicalId} (attempt ${attempt}/${ApiGatewayProvider.MAX_IAM_RETRIES}), ` +
            `retrying in ${ApiGatewayProvider.IAM_RETRY_DELAY_MS / 1000}s...`
        );
        await this.sleep(ApiGatewayProvider.IAM_RETRY_DELAY_MS);
        continue;
      }

      throw error;
    }
  }
}
