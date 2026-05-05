import {
  SQSClient,
  SetQueueAttributesCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS SQS Queue Policy Provider
 *
 * Implements resource provisioning for AWS::SQS::QueuePolicy using the SQS SDK.
 * This is required because SQS Queue Policy is not supported by Cloud Control API.
 */
export class SQSQueuePolicyProvider implements ResourceProvider {
  private sqsClient: SQSClient;
  private logger = getLogger().child('SQSQueuePolicyProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::SQS::QueuePolicy', new Set(['Queues', 'PolicyDocument'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.sqsClient = awsClients.sqs;
  }

  /**
   * Create an SQS queue policy
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SQS queue policy ${logicalId}`);

    const queues = properties['Queues'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!queues || queues.length === 0) {
      throw new ProvisioningError(
        `Queues is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Apply policy to all queues
      for (const queueUrl of queues) {
        this.logger.debug(`Setting policy for queue: ${queueUrl}`);
        await this.sqsClient.send(
          new SetQueueAttributesCommand({
            QueueUrl: queueUrl,
            Attributes: {
              Policy: policyDoc,
            },
          })
        );
      }

      this.logger.debug(`Successfully created SQS queue policy ${logicalId}`);

      // Physical ID is the first queue URL
      return {
        physicalId: queues[0]!,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        queues[0],
        cause
      );
    }
  }

  /**
   * Update an SQS queue policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SQS queue policy ${logicalId}: ${physicalId}`);

    const queues = properties['Queues'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!queues || queues.length === 0) {
      throw new ProvisioningError(
        `Queues is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Apply policy to all queues
      for (const queueUrl of queues) {
        this.logger.debug(`Updating policy for queue: ${queueUrl}`);
        await this.sqsClient.send(
          new SetQueueAttributesCommand({
            QueueUrl: queueUrl,
            Attributes: {
              Policy: policyDoc,
            },
          })
        );
      }

      this.logger.debug(`Successfully updated SQS queue policy ${logicalId}`);

      return {
        physicalId: queues[0]!,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SQS queue policy
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SQS queue policy ${logicalId}: ${physicalId}`);

    try {
      // Remove the policy by setting it to empty
      await this.sqsClient.send(
        new SetQueueAttributesCommand({
          QueueUrl: physicalId,
          Attributes: {
            Policy: '',
          },
        })
      );

      this.logger.debug(`Successfully deleted SQS queue policy ${logicalId}`);
    } catch (error) {
      // Check if queue doesn't exist
      if (
        error instanceof Error &&
        (error.name === 'QueueDoesNotExist' || error.message.includes('does not exist'))
      ) {
        const clientRegion = await this.sqsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Queue ${physicalId} does not exist, skipping policy deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current SQS queue policy in CFn-property shape.
   *
   * The provider's `create()` records `physicalId` as the first queue URL
   * in the `Queues` array. Drift here surfaces:
   *   - `Queues` — single-element array containing `physicalId`. The full
   *     state list of queues isn't recoverable from AWS (no reverse index)
   *     and the comparator only descends into keys present in state, so a
   *     state with multiple queues will still surface drift on
   *     `PolicyDocument` for the first queue (the most common drift case).
   *   - `PolicyDocument` — fetched via `GetQueueAttributes` for
   *     `Policy`, JSON-parsed back to the object form cdkd state holds.
   *
   * Returns `undefined` when the queue is gone (`QueueDoesNotExist`) or
   * when no policy is currently attached (the `Policy` attribute is
   * absent / empty).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let policyAttr: string | undefined;
    try {
      const resp = await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: physicalId,
          AttributeNames: ['Policy'],
        })
      );
      policyAttr = resp.Attributes?.['Policy'];
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (
        e.name === 'QueueDoesNotExist' ||
        (typeof e.message === 'string' && e.message.includes('does not exist'))
      ) {
        return undefined;
      }
      throw err;
    }
    if (!policyAttr) return undefined;

    const result: Record<string, unknown> = {
      Queues: [physicalId],
    };
    try {
      result['PolicyDocument'] = JSON.parse(policyAttr) as unknown;
    } catch {
      result['PolicyDocument'] = policyAttr;
    }
    return result;
  }

  /**
   * Adopt an existing SQS queue policy into cdkd state.
   *
   * **Explicit override only.** A `QueuePolicy` is an attachment applied to
   * a queue via `SetQueueAttributes(Policy=...)` — it has no standalone
   * identity and is not independently taggable. There is no `aws:cdk:path`
   * tag to look up by; only the queue itself is taggable.
   *
   * Users adopting an existing queue policy should pass
   * `--resource <logicalId>=<queueUrl>` (matching the physical id format
   * returned by `create()`, which uses the first queue URL).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
