import { SetTopicAttributesCommand, GetTopicAttributesCommand } from '@aws-sdk/client-sns';
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
 * AWS SNS Topic Policy Provider
 *
 * Implements resource provisioning for AWS::SNS::TopicPolicy using the SNS SDK.
 * This is required because SNS TopicPolicy is not supported by Cloud Control API.
 *
 * SNS TopicPolicy applies a policy document to one or more SNS topics via
 * SetTopicAttributes with AttributeName='Policy'.
 */
export class SNSTopicPolicyProvider implements ResourceProvider {
  private logger = getLogger().child('SNSTopicPolicyProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::SNS::TopicPolicy', new Set(['Topics', 'PolicyDocument'])],
  ]);

  /**
   * Create an SNS topic policy
   *
   * Applies the PolicyDocument to each topic in the Topics array.
   * Physical ID is a comma-separated list of topic ARNs.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SNS topic policy ${logicalId}`);

    const topics = properties['Topics'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!topics || topics.length === 0) {
      throw new ProvisioningError(
        `Topics is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    try {
      for (const topicArn of topics) {
        await this.setTopicPolicy(topicArn, policyDoc);
      }

      this.logger.debug(`Successfully created SNS topic policy ${logicalId}`);

      // Physical ID is the comma-separated list of topic ARNs
      const physicalId = topics.join(',');

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an SNS topic policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS topic policy ${logicalId}: ${physicalId}`);

    const topics = properties['Topics'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!topics || topics.length === 0) {
      throw new ProvisioningError(
        `Topics is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    try {
      for (const topicArn of topics) {
        await this.setTopicPolicy(topicArn, policyDoc);
      }

      this.logger.debug(`Successfully updated SNS topic policy ${logicalId}`);

      const newPhysicalId = topics.join(',');

      return {
        physicalId: newPhysicalId,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SNS topic policy
   *
   * Removes the policy from each topic by setting an empty policy.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SNS topic policy ${logicalId}: ${physicalId}`);

    const topicArns = physicalId.split(',');

    for (const topicArn of topicArns) {
      try {
        await this.setTopicPolicy(topicArn, '');
        this.logger.debug(`Removed policy from topic ${topicArn}`);
      } catch (error) {
        // If the topic doesn't exist or policy is already empty, skip it
        if (
          error instanceof Error &&
          (error.name === 'NotFoundException' ||
            error.name === 'NotFound' ||
            error.message.includes('not found') ||
            error.message.includes('does not exist') ||
            error.message.includes('Invalid parameter'))
        ) {
          const clientRegion = await getAwsClients().sns.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            topicArn
          );
          this.logger.debug(`Topic ${topicArn} not found or policy already removed, skipping`);
          continue;
        }
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to delete SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }

    this.logger.debug(`Successfully deleted SNS topic policy ${logicalId}`);
  }

  /**
   * Read the AWS-current SNS topic policy in CFn-property shape.
   *
   * The provider's `create()` builds `physicalId` as a comma-joined list
   * of topic ARNs. We:
   *   1. Split the physical id back into the list of topic ARNs and surface
   *      them as `Topics` (matching `create()` shape).
   *   2. Fetch `GetTopicAttributes` on the FIRST topic to retrieve the
   *      `Policy` attribute and surface it as `PolicyDocument` (JSON-parsed
   *      to match the object form cdkd state holds).
   *
   * Single-topic fetch is intentional: cdkd applies the same policy to
   * every topic in `Topics`, so the body is the same on each. A future
   * enhancement could verify per-topic that the policy actually matches
   * (catches manual divergence between multiple targets), but the bulk of
   * drift cases involve a single topic and the body content is what users
   * actually care about.
   *
   * Returns `undefined` when no topics are listed in the physical id, or
   * when the first listed topic is gone (`NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    const topics = physicalId.split(',').filter((t) => t.length > 0);
    if (topics.length === 0) return undefined;

    const firstTopic = topics[0]!;
    let policyAttr: string | undefined;
    try {
      const resp = await getAwsClients().sns.send(
        new GetTopicAttributesCommand({ TopicArn: firstTopic })
      );
      policyAttr = resp.Attributes?.['Policy'];
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (
        e.name === 'NotFoundException' ||
        e.name === 'NotFound' ||
        (typeof e.message === 'string' && e.message.includes('does not exist'))
      ) {
        return undefined;
      }
      throw err;
    }

    const result: Record<string, unknown> = {
      Topics: topics,
    };
    if (policyAttr) {
      try {
        result['PolicyDocument'] = JSON.parse(policyAttr) as unknown;
      } catch {
        result['PolicyDocument'] = policyAttr;
      }
    }
    return result;
  }

  /**
   * Adopt an existing SNS topic policy into cdkd state.
   *
   * The operational identifier for a `TopicPolicy` is the **comma-joined
   * list of SNS topic ARNs** the policy is attached to — every AWS SDK
   * call (`SetTopicAttributes` / `GetTopicAttributes`) takes a topic ARN
   * via the `TopicArn` parameter, and cdkd's `create()` records
   * `topics.join(',')` as the resource's `physicalId` so subsequent
   * `update()` / `delete()` / `readCurrentState()` calls hit the right
   * topic(s). A `TopicPolicy` has no standalone identity, no taggable
   * ARN, and no `aws:cdk:path` lookup — only the parent topics are
   * taggable.
   *
   * Resolution order (closes [#356](https://github.com/go-to-k/cdkd/issues/356)):
   *
   * 1. **`knownPhysicalId` if it is a comma-joined list of SNS topic ARNs.**
   *    Preserves the `cdkd import --resource <logicalId>=<topic-arns>`
   *    path that has always worked.
   * 2. **`properties.Topics.join(',')` if every entry is a literal topic
   *    ARN.** Closes the `--migrate-from-cloudformation` case: AWS
   *    CloudFormation's `DescribeStackResources` returns the CFn-generated
   *    policy NAME for `AWS::SNS::TopicPolicy` (e.g.
   *    `MyStack-MyTopicPolicy-XXXXXXXXXX`), which is NOT a valid topic
   *    ARN. The first time cdkd touches the imported state with that
   *    name, `readCurrentState` → `GetTopicAttributes` rejects it.
   * 3. **Hard error** when neither path resolves a topic-ARN list. This
   *    covers (a) `--migrate-from-cloudformation` against a CFn stack
   *    whose template carries `Topics: [{Ref: <MyTopic>}]` (the typical
   *    CDK shape) when the referenced topic is NOT in the importable
   *    set (or hasn't been imported yet in the current run), and (b)
   *    explicit `--resource <logicalId>=<non-arn>` typos. Pointing the
   *    user at `--resource <logicalId>=<topic-arns>` is the recovery
   *    path that always works.
   *
   * Intrinsic-valued `Topics` entries (e.g. `{Ref: <MyTopic>}`) fall into
   * branch 3 here even when the referenced sibling has been imported in
   * the same run — `import()` is called BEFORE
   * `resolveImportedProperties` runs the synth template's Properties
   * through the intrinsic resolver, so the raw intrinsic object is what
   * we see. The recovery message names `--resource` as the explicit
   * escape hatch.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    // 1. knownPhysicalId is a comma-joined list of SNS topic ARNs — use
    //    it as-is (existing `--resource <logicalId>=<topic-arns>` path).
    if (input.knownPhysicalId && isSnsTopicArnList(input.knownPhysicalId)) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }

    // 2. Properties.Topics is an array of literal topic ARNs — join and
    //    use (`--migrate-from-cloudformation` happy path when the template
    //    carries literal Topics entries, plus the no-knownPhysicalId
    //    auto path when properties is the only signal).
    const topics = input.properties['Topics'];
    if (Array.isArray(topics) && topics.length > 0) {
      const allLiteralArns = topics.every((t) => typeof t === 'string' && isSnsTopicArn(t));
      if (allLiteralArns) {
        return { physicalId: (topics as string[]).join(','), attributes: {} };
      }
    }

    // 3. No topic-ARN list recoverable — hard error rather than null.
    //    Returning null would silently mark the resource as
    //    `skipped-not-found` in the import summary and bake the unusable
    //    CFn-generated name into cdkd state for any caller passing
    //    `knownPhysicalId`. Naming the explicit override is the
    //    load-bearing recovery hint.
    const knownNote = input.knownPhysicalId
      ? ` Got knownPhysicalId='${input.knownPhysicalId}' (not a comma-joined list of SNS topic ARNs; CloudFormation returns the policy resource NAME for AWS::SNS::TopicPolicy, which is not the operational identifier).`
      : '';
    const topicsNote =
      Array.isArray(topics) && topics.length > 0
        ? ` Properties.Topics=${JSON.stringify(topics)} did not resolve to a list of literal topic ARNs (intrinsic-valued entries like {Ref: <Topic>} are not resolved at import time).`
        : ' Properties.Topics is missing or empty.';
    throw new Error(
      `Cannot determine topic ARNs for ${input.resourceType} '${input.logicalId}'.${knownNote}${topicsNote} ` +
        `Re-run with --resource ${input.logicalId}=<comma-joined-topic-ARNs> ` +
        `(e.g. arn:aws:sns:${input.region}:<account>:<topic-name>) to point cdkd at the topic(s) this policy is attached to.`
    );
  }

  /**
   * Set the policy on a single SNS topic
   */
  private async setTopicPolicy(topicArn: string, policyDoc: string): Promise<void> {
    const snsClient = getAwsClients().sns;
    await snsClient.send(
      new SetTopicAttributesCommand({
        TopicArn: topicArn,
        AttributeName: 'Policy',
        AttributeValue: policyDoc,
      })
    );
  }
}

/**
 * Recognize a single SNS topic ARN. AWS standard form is
 * `arn:<partition>:sns:<region>:<account>:<name>`; FIFO topics end in
 * `.fifo`. Accepts every partition (`aws` / `aws-cn` / `aws-us-gov` /
 * `aws-iso` / etc.) via the broader `arn:<partition>:sns:` prefix shape.
 */
function isSnsTopicArn(value: string): boolean {
  return /^arn:[a-z0-9-]+:sns:[a-z0-9-]+:\d{12}:[\w.-]+$/.test(value);
}

/**
 * Recognize a comma-joined list of SNS topic ARNs. cdkd's `create()`
 * records `topics.join(',')` as the `physicalId`, so a single ARN
 * (`arn:aws:sns:us-east-1:123456789012:my-topic`) is also accepted.
 * Every comma-separated segment must be a valid SNS topic ARN — a CFn
 * generated name like `MyStack-MyTopicPolicy-XXX` is correctly rejected
 * because it does not match the ARN prefix, and a partially-valid
 * mixture (one literal ARN + one CFn name) is also rejected so we fall
 * back to the properties-based resolution rather than baking a half-bad
 * list into state.
 */
function isSnsTopicArnList(value: string): boolean {
  const segments = value.split(',');
  if (segments.length === 0) return false;
  return segments.every((s) => isSnsTopicArn(s));
}
