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
   * The operational identifier for a `QueuePolicy` is the **queue URL**
   * (`https://sqs.<region>.amazonaws.com/<account>/<name>`) — every AWS
   * SDK call (`SetQueueAttributes` / `GetQueueAttributes`) takes a queue
   * URL via the `QueueUrl` parameter, and cdkd's `create()` records the
   * first `Queues` entry as the resource's `physicalId` so subsequent
   * `update()` / `delete()` / `readCurrentState()` calls hit the right
   * queue. A `QueuePolicy` has no standalone identity, no taggable ARN,
   * and no `aws:cdk:path` lookup — only the parent queue is taggable.
   *
   * Resolution order (closes [#351](https://github.com/go-to-k/cdkd/issues/351)):
   *
   * 1. **`knownPhysicalId` if it is a valid queue URL.** Preserves the
   *    `cdkd import --resource <logicalId>=<queueUrl>` path that has
   *    always worked.
   * 2. **First entry of `properties.Queues` if it is a literal queue URL.**
   *    Closes the `--migrate-from-cloudformation` case: AWS CloudFormation's
   *    `DescribeStackResources` returns the CFn-generated policy NAME for
   *    `AWS::SQS::QueuePolicy` (e.g. `MyStack-MyQueuePolicy-XXXXXXXXXX`),
   *    which is NOT a valid `QueueUrl` and crashes the AWS SDK
   *    `queueUrlMiddleware` with `TypeError: Invalid URL` the first time
   *    cdkd touches it (typically `captureObservedForImportedResources` →
   *    `readCurrentState` → `GetQueueAttributes`). The user can also
   *    point `--migrate-from-cloudformation` at a stack whose QueuePolicy
   *    is templated as `Queues: ['https://sqs...']` (rare but valid) —
   *    that literal form falls into this branch.
   * 3. **Hard error** when neither path resolves a queue URL. This
   *    covers (a) `--migrate-from-cloudformation` against a CFn stack
   *    whose template carries `Queues: [{Ref: <MyQueue>}]` (the typical
   *    CDK shape) when the referenced queue is NOT in the importable
   *    set (or hasn't been imported yet in the current run), and (b)
   *    explicit `--resource <logicalId>=<non-url>` typos. Pointing the
   *    user at `--resource <logicalId>=<queueUrl>` is the recovery path
   *    that always works.
   *
   * Intrinsic-valued `Queues[0]` (e.g. `{Ref: <MyQueue>}`) falls into
   * branch 3 here even when the referenced sibling has been imported in
   * the same run — `import()` is called BEFORE
   * `resolveImportedProperties` runs the synth template's Properties
   * through the intrinsic resolver, so the raw intrinsic object is what
   * we see. The recovery message names `--resource` as the explicit
   * escape hatch.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    // 1. knownPhysicalId is a valid queue URL — use it as-is (existing
    //    `--resource <logicalId>=<queueUrl>` path).
    if (input.knownPhysicalId && isSqsQueueUrl(input.knownPhysicalId)) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }

    // 2. Properties.Queues[0] is a literal queue URL — use it
    //    (`--migrate-from-cloudformation` happy path when the template
    //    carries a literal Queues entry, plus the no-knownPhysicalId
    //    auto path when properties is the only signal).
    const queues = input.properties['Queues'];
    if (Array.isArray(queues) && queues.length > 0) {
      const first = queues[0];
      if (typeof first === 'string' && isSqsQueueUrl(first)) {
        return { physicalId: first, attributes: {} };
      }
    }

    // 3. No queue URL recoverable — hard error rather than null. Returning
    //    null would silently mark the resource as `skipped-not-found` in
    //    the import summary and bake the unusable CFn-generated name into
    //    cdkd state for any caller passing `knownPhysicalId`. Naming the
    //    explicit override is the load-bearing recovery hint.
    const knownNote = input.knownPhysicalId
      ? ` Got knownPhysicalId='${input.knownPhysicalId}' (not a queue URL; CloudFormation returns the policy resource NAME for AWS::SQS::QueuePolicy, which is not the operational identifier).`
      : '';
    const queuesNote =
      Array.isArray(queues) && queues.length > 0
        ? ` Properties.Queues[0]=${JSON.stringify(queues[0])} did not resolve to a literal queue URL (intrinsic-valued entries like {Ref: <Queue>} are not resolved at import time).`
        : ' Properties.Queues is missing or empty.';
    throw new Error(
      `Cannot determine queue URL for ${input.resourceType} '${input.logicalId}'.${knownNote}${queuesNote} ` +
        `Re-run with --resource ${input.logicalId}=<queueUrl> ` +
        `(e.g. https://sqs.${input.region}.amazonaws.com/<account>/<queue-name>) to point cdkd at the queue this policy is attached to.`
    );
  }
}

/**
 * Recognize an SQS queue URL. AWS standard form is
 * `https://sqs.<region>.amazonaws.com/<account>/<name>`; FIFO queues end
 * in `.fifo`. Non-standard partitions (`amazonaws.com.cn` /
 * `c2s.ic.gov` / etc.) are accepted via the broader prefix check.
 */
function isSqsQueueUrl(value: string): boolean {
  return value.startsWith('https://sqs.') && value.includes('/');
}
