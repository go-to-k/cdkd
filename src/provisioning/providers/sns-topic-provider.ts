import { SNSClient, GetTopicAttributesCommand, NotFoundException } from '@aws-sdk/client-sns';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import { generatedNameFor } from '../resource-name.js';
import { coerceCfnBoolean } from '../config-shape.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
  ResourceNotFound,
} from '../../types/resource.js';
import { isAuxiliaryFailure } from '../auxiliary-failure.js';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { hasErrorName, nameHeldBefore, type NameHeldBefore } from './create-ownership.js';
import { create } from './sns-topic/create.js';
import {
  update,
  applyUpdate,
  subscribeInline,
  reconcileInlineSubscriptions,
} from './sns-topic/update.js';
import { deleteImpl } from './sns-topic/delete.js';
import { readCurrentState, importImpl } from './sns-topic/read-state.js';

export {
  SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT,
  buildSubscriptionAttributes,
  buildDeliveryStatusAttributeMap,
  normalizeDeliveryStatusProtocol,
} from './sns-topic/shared.js';

/**
 * AWS SNS Topic Provider
 *
 * Implements resource provisioning for AWS::SNS::Topic using the SNS SDK.
 * WHY: SNS CreateTopic is synchronous and idempotent - the CC API adds unnecessary
 * polling overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class SNSTopicProvider implements ResourceProvider {
  snsClient: SNSClient;
  logger: ConsoleLogger = getLogger().child('SNSTopicProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SNS::Topic',
      new Set([
        'TopicName',
        'FifoTopic',
        'ContentBasedDeduplication',
        'DisplayName',
        'KmsMasterKeyId',
        'Tags',
        'TracingConfig',
        'SignatureVersion',
        'ArchivePolicy',
        'DataProtectionPolicy',
        'DeliveryStatusLogging',
        'Subscription',
        'FifoThroughputScope',
        'MaximumMessageSize',
      ]),
    ],
  ]);

  /** See {@link callerAccount}. */
  callerIdentity: { account: string; partition: string } | undefined;

  constructor() {
    const awsClients = getAwsClients();
    this.snsClient = awsClients.sns;
  }

  /**
   * The caller's account and partition from STS, for the ARN a topic name
   * maps to. Memoized on the instance only once a VALIDATED answer arrived:
   * a failure is retried by the next lookup, never cached.
   */
  async callerAccount(): Promise<{ account: string; partition: string }> {
    if (this.callerIdentity !== undefined) return this.callerIdentity;
    const identity = await getAwsClients().sts.send(new GetCallerIdentityCommand({}));
    const partition = identity.Arn?.split(':')[1];
    if (typeof identity.Account !== 'string' || !/^\d{12}$/.test(identity.Account) || !partition) {
      throw new Error('STS did not report a usable account and partition');
    }
    this.callerIdentity = { account: identity.Account, partition };
    return this.callerIdentity;
  }

  /**
   * Did a topic hold `topicName` before this create (go-to-k/cdkd#4403)?
   * `CreateTopic` takes no ARN, so the one the name maps to is built from
   * the caller's account and partition (STS) and this client's region, then
   * read. Only SNS's own `NotFoundException` is `free`; a failed STS call, an
   * unreadable identity or any other error is `unknown`.
   */
  async topicHeldBefore(topicName: string): Promise<NameHeldBefore> {
    return nameHeldBefore(
      async () => {
        const region = await this.snsClient.config.region();
        const { account, partition } = await this.callerAccount();
        if (!region) throw new Error('the SNS client reported no region');
        await this.snsClient.send(
          new GetTopicAttributesCommand({
            TopicArn: `arn:${partition}:sns:${region}:${account}:${topicName}`,
          })
        );
        return true;
      },
      (error) => error instanceof NotFoundException || hasErrorName(error, ['NotFoundException'])
    );
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

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

  applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    maskSecrets?: SecretMasker
  ): Promise<ResourceUpdateResult> {
    return applyUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      maskSecrets
    );
  }

  subscribeInline(
    topicArn: string,
    sub: Record<string, unknown>,
    logicalId: string,
    mask: MaskerFn
  ): Promise<void> {
    return subscribeInline.call(this, topicArn, sub, logicalId, mask);
  }

  reconcileInlineSubscriptions(
    topicArn: string,
    oldSubs: Array<Record<string, unknown>>,
    newSubs: Array<Record<string, unknown>>,
    logicalId: string,
    mask: MaskerFn
  ): Promise<void> {
    return reconcileInlineSubscriptions.call(this, topicArn, oldSubs, newSubs, logicalId, mask);
  }

  /**
   * The failure wrap the create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through `mask`, and the
   * wrap is stamped `markRedactedCause`, so the retry classifiers read the
   * withheld text on the `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}) so a create-first replacement still
   * recognises the collision, except from a post-create step's failure
   * ({@link markAuxiliaryFailure}), where "it" would read as this resource. A
   * non-`Error` throw is withheld the same way, unstamped: it has no chain.
   *
   * A cdkd-authored or transport error keeps its text, masked, stamped exactly
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244). The delete
   * tests its typed not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(`${mask(failure.summary)}${relay}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing SNS topic.
   *
   * CloudFormation's `AWS::SNS::Topic` exposes `TopicName` and `TopicArn`.
   * The cdkd physicalId is the topic ARN, so both are derivable without
   * an AWS call. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-sns-topic.html#aws-properties-sns-topic-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- consistent async signature with other providers
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'TopicArn':
        return physicalId;
      case 'TopicName':
        return physicalId.split(':').pop();
      default:
        return undefined;
    }
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties);
  }

  /**
   * No drift-unknown paths remain. `DeliveryStatusLogging` is reverse-mapped
   * (see `readCurrentState`), and the inline `Subscription` list is now
   * reverse-mapped too (issue #980) — but only when state actually recorded
   * inline subscriptions, so a Topic whose subscriptions are managed as
   * separate `AWS::SNS::Subscription` resources (CDK L2 `addSubscription()`)
   * does not surface them here.
   */
  getDriftUnknownPaths(): string[] {
    return [];
  }

  /**
   * Fold `TracingConfig: 'PassThrough'` onto `''` (issue #6226). A topic that
   * never set the attribute reads back as `''`, while a removal or a
   * `drift --revert` resets it to `PassThrough`, SNS's default — the same
   * live fact. Without the fold an unset baseline drifts against the reset
   * forever. Both sides fold, so a declared `PassThrough` compares equal too.
   */
  canonicalizeDriftProperties(
    _resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (properties['TracingConfig'] !== 'PassThrough') return properties;
    return { ...properties, TracingConfig: '' };
  }

  /** go-to-k/cdkd#4705: the name `create()` sends when the template names none. */
  generatedCreateName(
    _resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    if (properties['TopicName']) return undefined;
    // go-to-k/cdkd#6100: the rule ends a FIFO topic's name with `.fifo`.
    return generatedNameFor('AWS::SNS::Topic', logicalId, { properties });
  }

  /**
   * go-to-k/cdkd#6100: a `FifoTopic` the plan cannot read (an intrinsic still
   * unresolved) decides whether the name ends with `.fifo`, so the guard
   * looks the name up at the create, with the resolved properties.
   */
  lookupNeedsResolvedProperties(
    _resourceType: string,
    properties: Record<string, unknown>
  ): boolean {
    const fifo = properties['FifoTopic'];
    return fifo !== undefined && fifo !== null && coerceCfnBoolean(fifo) === undefined;
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
