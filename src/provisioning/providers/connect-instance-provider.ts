import {
  ConnectClient,
  CreateInstanceCommand,
  DeleteInstanceCommand,
  DescribeInstanceAttributeCommand,
  DescribeInstanceCommand,
  ListInstanceAttributesCommand,
  ListInstancesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateInstanceAttributeCommand,
  ResourceNotFoundException,
  type CreateInstanceCommandInput,
  type DirectoryType,
  type Instance,
  type InstanceAttributeType,
} from '@aws-sdk/client-connect';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure, verbosePointerTail } from '../../utils/aws-failure-text.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../created-resource-sink.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markRedactedCause,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { isInterruptedWaitError, startInterruptWatch } from '../interrupt-watch.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { markNotGone } from '../not-gone.js';
import { normalizeAwsTagsToCfn, readNameProperty } from '../import-helpers.js';
import { coerceCfnBoolean } from '../config-shape.js';
import { resolvedResourceTimeoutMs } from '../resource-timeout-registry.js';
import { planTagDiff, refuseMalformedDesiredTags, tagPlanWarning } from '../tag-list.js';
import { acquireIdempotencyToken } from './idempotency-token.js';
import { connectInstanceIdOf } from '../connect-instance-id.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { definedAttributes } from '../attribute-map.js';

const RESOURCE_TYPE = 'AWS::Connect::Instance';

/**
 * Every member of the CFn `Attributes` block (the schema's
 * `additionalProperties: false` definition) and the `InstanceAttributeType`
 * `UpdateInstanceAttribute` / `DescribeInstanceAttribute` take for it.
 */
export const CONNECT_INSTANCE_ATTRIBUTE_TYPES: Readonly<Record<string, InstanceAttributeType>> = {
  InboundCalls: 'INBOUND_CALLS',
  OutboundCalls: 'OUTBOUND_CALLS',
  ContactflowLogs: 'CONTACTFLOW_LOGS',
  ContactLens: 'CONTACT_LENS',
  AutoResolveBestVoices: 'AUTO_RESOLVE_BEST_VOICES',
  UseCustomTTSVoices: 'USE_CUSTOM_TTS_VOICES',
  EarlyMedia: 'EARLY_MEDIA',
  MultiPartyConference: 'MULTI_PARTY_CONFERENCE',
  HighVolumeOutBound: 'HIGH_VOLUME_OUTBOUND',
  EnhancedContactMonitoring: 'ENHANCED_CONTACT_MONITORING',
  EnhancedChatMonitoring: 'ENHANCED_CHAT_MONITORING',
  MultiPartyChatConference: 'MULTI_PARTY_CHAT_CONFERENCE',
  MessageStreaming: 'MESSAGE_STREAMING',
  AutoMuteAgentOnHold: 'AUTO_MUTE_AGENT_ON_HOLD',
};

/** The two `Attributes` members `CreateInstance` itself takes; the rest go through `UpdateInstanceAttribute`. */
const CREATE_CALL_ATTRIBUTES = new Set(['InboundCalls', 'OutboundCalls']);

/** The region segment of a Connect instance ARN, or `undefined` for anything else. */
function arnRegionOf(physicalId: string): string | undefined {
  if (!physicalId.startsWith('arn:')) return undefined;
  const region = physicalId.split(':')[3];
  return region ? region : undefined;
}

/** One `Attributes` read: the usable members, and the names of any that are not booleans. */
interface AttributesRead {
  values: Map<string, boolean>;
  malformed: string[];
  unknown: string[];
  container: 'absent' | 'object' | 'malformed';
}

/** Read an `Attributes` block into booleans, by member name. */
function readAttributes(value: unknown): AttributesRead {
  const read: AttributesRead = {
    values: new Map(),
    malformed: [],
    unknown: [],
    container: 'object',
  };
  if (value === undefined || value === null) return { ...read, container: 'absent' };
  if (typeof value !== 'object' || Array.isArray(value)) return { ...read, container: 'malformed' };
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(CONNECT_INSTANCE_ATTRIBUTE_TYPES, key)) {
      read.unknown.push(key);
      continue;
    }
    if (member === undefined || member === null) continue;
    const flag = coerceCfnBoolean(member);
    if (flag === undefined) read.malformed.push(key);
    else read.values.set(key, flag);
  }
  return read;
}

/** The CFn `Attributes` block of a `ListInstanceAttributes` answer. */
function attributesFromList(
  list: ReadonlyArray<{ AttributeType?: string | undefined; Value?: string | undefined }>
): Record<string, boolean> {
  const byType = new Map(list.map((a) => [a.AttributeType, a.Value]));
  const out: Record<string, boolean> = {};
  for (const [key, type] of Object.entries(CONNECT_INSTANCE_ATTRIBUTE_TYPES)) {
    const flag = coerceCfnBoolean(byType.get(type));
    if (flag !== undefined) out[key] = flag;
  }
  return out;
}

/** The record's read-only attributes from one `DescribeInstance` answer. */
function attributesOf(instance: Instance | undefined): Record<string, unknown> {
  return definedAttributes({
    Id: instance?.Id,
    Arn: instance?.Arn,
    ServiceRole: instance?.ServiceRole,
    CreatedTime: instance?.CreatedTime?.toISOString(),
    InstanceStatus: instance?.InstanceStatus,
  });
}

/** A failure the instance wait keeps polling through. */
function isTransientRead(error: unknown): boolean {
  return isThrottlingError(error) || isTransientServerError(error);
}

/**
 * SDK Provider for AWS::Connect::Instance (go-to-k/cdkd#6912).
 *
 * `CreateInstance` / `UpdateInstanceAttribute` / `TagResource` /
 * `UntagResource` / `DeleteInstance`. The physical id is the instance ARN, as
 * Cloud Control's: `Arn` is the schema's primary identifier and what `Ref`
 * returns. `Id`, `Arn`, `ServiceRole`, `CreatedTime` and `InstanceStatus` are
 * the read-only attributes.
 *
 * An SDK provider rather than Cloud Control for `--no-wait`: the Cloud Control
 * handler returns only once the instance is `ACTIVE`, about 60-80 s after
 * `CreateInstance`, while the instance accepts dependent calls (storage
 * configs, contact flows, Lambda associations, `UpdateInstanceAttribute`)
 * about 20-25 s in, still `CREATION_IN_PROGRESS` (measured, us-east-1). A
 * create therefore waits for that readiness, applies the `Attributes`
 * members `CreateInstance` does not take, and then waits for `ACTIVE` unless
 * `CDKD_NO_WAIT` is set. `ServiceRole` exists only once the instance is
 * `ACTIVE`: a `Fn::GetAtt` of it on a `--no-wait` record waits for it at
 * resolution (`getatt-construct-app.ts`).
 */
export class ConnectInstanceProvider implements ResourceProvider {
  private client: ConnectClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('ConnectInstanceProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Connect::Instance',
      new Set(['IdentityManagementType', 'InstanceAlias', 'DirectoryId', 'Attributes', 'Tags']),
    ],
  ]);

  /**
   * Issue #1160: the create-only keys, whose removal is a replacement, and
   * `Tags`, whose removed entries are untagged. `Attributes` is required by
   * the schema; a member removed from it is left at its live value (warned in
   * {@link update}), since the type has no documented value to reset it to.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Connect::Instance',
      new Set(['IdentityManagementType', 'InstanceAlias', 'DirectoryId', 'Tags']),
    ],
  ]);

  /** How long and how often create waits for the instance; tests shorten it. */
  instanceWait = {
    pollIntervalMs: 3_000,
    timeoutMs: 900_000,
    sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  getClient(): ConnectClient {
    // `CreateInstance` carries an idempotency token (`ClientToken`), so the
    // SDK's own replay of a 5xx returns the instance the first request made.
    this.client ??= new ConnectClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
    return this.client;
  }

  /**
   * Wrap a caught failure into the thrown error, keeping the caller's
   * identity out of its message (go-to-k/cdkd#2319): an AWS-authored failure
   * is named by its CLASS, AWS's text goes to debug through the masker.
   */
  private wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error)) return build(mask(failure.detail));
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(failure.detail).message));
    return markRedactedCause(build(mask(failure.summary)));
  }

  /**
   * The `Attributes` booleans the template declares. Refuses, non-retryable,
   * a block that is not an object, an unknown member, a member that is not a
   * boolean, and (on create) a missing `InboundCalls` / `OutboundCalls`.
   */
  private desiredAttributes(
    properties: Record<string, unknown>,
    logicalId: string,
    physicalId?: string
  ): Map<string, boolean> {
    const read = readAttributes(properties['Attributes']);
    const refuse = (what: string): never => {
      throw markNonRetryable(
        new ProvisioningError(
          safeMsg`Attributes of Connect instance ${logicalId} ${what}` +
            ` — the instance was not ${physicalId === undefined ? 'created' : 'updated'}`,
          RESOURCE_TYPE,
          logicalId,
          physicalId
        )
      );
    };
    if (read.container === 'absent') refuse('is required');
    if (read.container === 'malformed') refuse('must be an object');
    if (read.unknown.length > 0) {
      refuse(safeMsg`names members the type does not have: ${read.unknown.join(', ')}`);
    }
    if (read.malformed.length > 0) {
      refuse(safeMsg`must hold booleans, but ${read.malformed.join(', ')} does not`);
    }
    // The schema requires both, on create and update alike.
    for (const key of CREATE_CALL_ATTRIBUTES) {
      if (!read.values.has(key)) refuse(safeMsg`must declare ${key}`);
    }
    return read.values;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = maskerOrIdentity(context?.maskSecrets);
    const identityType = properties['IdentityManagementType'];
    if (typeof identityType !== 'string' || identityType === '') {
      throw markNonRetryable(
        new ProvisioningError(
          safeMsg`IdentityManagementType is required for Connect instance ${logicalId}`,
          resourceType,
          logicalId
        )
      );
    }
    const attributes = this.desiredAttributes(properties, logicalId);
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const input: CreateInstanceCommandInput = {
      IdentityManagementType: identityType as DirectoryType,
      InboundCallsEnabled: attributes.get('InboundCalls') === true,
      OutboundCallsEnabled: attributes.get('OutboundCalls') === true,
    };
    const alias = readNameProperty({ properties } as ResourceImportInput, 'InstanceAlias');
    if (alias !== undefined) input.InstanceAlias = alias;
    if (typeof properties['DirectoryId'] === 'string' && properties['DirectoryId'] !== '') {
      input.DirectoryId = properties['DirectoryId'];
    }
    if (tags.length > 0) input.Tags = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));

    // Memoised per logical id for the deploy, so the engine's own retry of a
    // create whose response was lost resends the SAME token and is handed the
    // same instance back, instead of minting a second one.
    const createToken = acquireIdempotencyToken({ scope: 'CreateInstance', logicalId });
    input.ClientToken = createToken.value;

    this.logger.debug(mask(`Creating Connect instance ${logicalId}: ${alias ?? '(no alias)'}`));
    let arn: string | undefined;
    try {
      const response = await this.getClient().send(new CreateInstanceCommand(input));
      arn = response.Arn;
      if (!arn) {
        throw new ProvisioningError(
          safeMsg`CreateInstance returned no Arn for Connect instance ${logicalId}`,
          resourceType,
          logicalId
        );
      }
      reportCreatedResource(logicalId, resourceType, arn); // go-to-k/cdkd#5511
      const instanceId = response.Id ?? connectInstanceIdOf(arn);

      const deadline = this.deadline();
      let instance = await this.waitForInstance(instanceId, logicalId, 'ready', deadline, mask);
      for (const [key, flag] of attributes) {
        if (CREATE_CALL_ATTRIBUTES.has(key)) continue;
        await this.updateAttribute(instanceId, key, flag, deadline, logicalId, mask);
      }
      if (process.env['CDKD_NO_WAIT'] === 'true') {
        this.logger.debug(
          mask(`Skipping the ACTIVE wait for Connect instance ${logicalId} (CDKD_NO_WAIT=true)`)
        );
      } else {
        instance = await this.waitForInstance(instanceId, logicalId, 'active', deadline, mask);
      }
      createToken.release();
      return {
        physicalId: arn,
        attributes: { ...attributesOf(instance), Id: instanceId, Arn: arn },
      };
    } catch (error) {
      if (isInterruptedWaitError(error)) throw error;
      const cause = error instanceof Error ? error : undefined;
      let thrown =
        error instanceof CdkdError && error instanceof ProvisioningError
          ? error
          : this.wrapMaskedError(
              mask,
              error,
              (text) =>
                new ProvisioningError(
                  `Failed to create Connect instance ${logicalId}: ${text}`,
                  resourceType,
                  logicalId,
                  arn,
                  cause
                )
            );
      if (arn !== undefined) {
        thrown = await this.retireFailedCreate(thrown, logicalId, resourceType, arn, mask);
      }
      throw thrown;
    }
  }

  /** The wall-clock end of one create's waits, capped by `--resource-timeout`. */
  private deadline(): number {
    const userTimeoutMs = resolvedResourceTimeoutMs(RESOURCE_TYPE);
    const timeoutMs =
      userTimeoutMs === undefined
        ? this.instanceWait.timeoutMs
        : Math.min(this.instanceWait.timeoutMs, userTimeoutMs / 2);
    return Date.now() + timeoutMs;
  }

  /**
   * An instance CreateInstance made whose create then failed (it reached
   * CREATION_FAILED, an attribute was refused, or the wait ran out) is deleted
   * here, so it is not left live with no state record (go-to-k/cdkd#2169).
   * `DeleteInstance` takes effect at once (measured: `DescribeInstance` 404
   * within a second). When that delete fails too, the error names the
   * survivor for the failed-CREATE journal.
   */
  private async retireFailedCreate(
    thrown: ProvisioningError,
    logicalId: string,
    resourceType: string,
    arn: string,
    mask: MaskerFn
  ): Promise<ProvisioningError> {
    try {
      await this.getClient().send(
        new DeleteInstanceCommand({ InstanceId: connectInstanceIdOf(arn) })
      );
      retractCreatedResource(logicalId, resourceType, arn);
      return thrown;
    } catch (cleanupError) {
      if (cleanupError instanceof ResourceNotFoundException) {
        retractCreatedResource(logicalId, resourceType, arn);
        return thrown;
      }
      const failure = describeAwsFailure(cleanupError);
      this.logger.debug(
        mask(`Failed to delete Connect instance ${arn} after its create failed: ${failure.detail}`)
      );
      this.logger.warn(
        mask(
          safeMsg`Connect instance ${logicalId} (${arn}) was created but its create failed, and deleting it failed too (${failure.summary}). Delete it before the next deploy: aws connect delete-instance --instance-id ${connectInstanceIdOf(arn)}`
        )
      );
      return markCreatedBeforeFailure(thrown, logicalId, resourceType, arn);
    }
  }

  /**
   * Poll until the instance is `ready` (it accepts dependent calls:
   * `DescribeInstanceAttribute` answers, which coincides with the first
   * dependent create succeeding) or `active` (`InstanceStatus` ACTIVE, the
   * point Cloud Control's handler returns at). `CREATION_FAILED` fails the
   * create, with AWS's `StatusReason` behind `--verbose` (it can quote the
   * caller's identity, go-to-k/cdkd#2319). A not-found read keeps polling:
   * a newly created instance answers 404 to its dependent calls for its
   * first 20-25 s. Returns the last `DescribeInstance` answer.
   */
  private async waitForInstance(
    instanceId: string,
    logicalId: string,
    until: 'ready' | 'active',
    deadline: number,
    mask: MaskerFn
  ): Promise<Instance | undefined> {
    const { pollIntervalMs, sleep } = this.instanceWait;
    const watch = startInterruptWatch(`Connect instance ${logicalId} ${until} wait`);
    let instance: Instance | undefined;
    try {
      for (;;) {
        let ready = false;
        try {
          instance = (
            await this.getClient().send(new DescribeInstanceCommand({ InstanceId: instanceId }))
          ).Instance;
          const status = instance?.InstanceStatus;
          if (status === 'CREATION_FAILED') {
            const reason = instance?.StatusReason?.Message;
            if (reason) {
              this.logger.debug(
                mask(`Connect instance ${logicalId} entered CREATION_FAILED: ${reason}`)
              );
            }
            throw markNonRetryable(
              new ProvisioningError(
                safeMsg`Connect instance ${logicalId} entered CREATION_FAILED.` +
                  verbosePointerTail(),
                RESOURCE_TYPE,
                logicalId,
                instance?.Arn
              )
            );
          }
          if (status === 'ACTIVE') return instance;
          if (until === 'ready') {
            await this.getClient().send(
              new DescribeInstanceAttributeCommand({
                InstanceId: instanceId,
                AttributeType: 'INBOUND_CALLS',
              })
            );
            ready = true;
          }
        } catch (error) {
          if (error instanceof ProvisioningError) throw error;
          if (!(error instanceof ResourceNotFoundException) && !isTransientRead(error)) throw error;
          if (Date.now() >= deadline) throw error;
          this.logger.debug(
            mask(
              `Connect instance ${instanceId}: not readable yet (${describeAwsFailure(error).summary})`
            )
          );
        }
        if (ready) return instance;
        if (Date.now() >= deadline) {
          throw markNonRetryable(
            new ProvisioningError(
              safeMsg`Connect instance ${logicalId} was still ${instance?.InstanceStatus ?? 'unreadable'} when its ${until === 'ready' ? 'readiness' : 'ACTIVE'} wait ran out`,
              RESOURCE_TYPE,
              logicalId,
              instance?.Arn
            )
          );
        }
        if (watch.isInterrupted()) throw watch.onInterrupted();
        await sleep(pollIntervalMs);
      }
    } finally {
      watch.dispose();
    }
  }

  /**
   * `UpdateInstanceAttribute` for one `Attributes` member. A not-found or
   * transient answer is retried until `deadline`: the instance can still be
   * settling into accepting attribute writes.
   */
  private async updateAttribute(
    instanceId: string,
    key: string,
    flag: boolean,
    deadline: number,
    logicalId: string,
    mask: MaskerFn
  ): Promise<void> {
    const attributeType = CONNECT_INSTANCE_ATTRIBUTE_TYPES[key] as InstanceAttributeType;
    for (;;) {
      try {
        await this.getClient().send(
          new UpdateInstanceAttributeCommand({
            InstanceId: instanceId,
            AttributeType: attributeType,
            Value: String(flag),
          })
        );
        return;
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException) && !isTransientRead(error)) throw error;
        if (Date.now() >= deadline) throw error;
        this.logger.debug(mask(`Connect instance ${logicalId}: ${key} not writable yet, retrying`));
        await this.instanceWait.sleep(this.instanceWait.pollIntervalMs);
      }
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    const mask = maskerOrIdentity(context?.maskSecrets);
    const stateBorne = context?.replayingState === true || context?.desiredFromAwsReadback === true;

    // A malformed Attributes from the template is refused before any call;
    // one carried by a state record (a rollback replay or a drift revert)
    // applies its usable members and leaves the rest at their live values.
    let desired: Map<string, boolean>;
    try {
      desired = this.desiredAttributes(properties, logicalId, physicalId);
    } catch (error) {
      if (!stateBorne) throw error;
      desired = readAttributes(properties['Attributes']).values;
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): Attributes is not a block of booleans; only its usable members are applied.`
      );
    }
    const previous = readAttributes(previousProperties['Attributes']).values;
    const changed = [...desired].filter(([key, flag]) => previous.get(key) !== flag);
    const unsettled = context?.unsettledProperties?.has('Attributes') === true;
    const toWrite = unsettled ? [...desired] : changed;
    const removed = [...previous.keys()].filter((key) => !desired.has(key));
    if (removed.length > 0) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): Attributes no longer declares ${removed.join(', ')}; the instance keeps the current value.`
      );
    }

    const desiredTags = refuseMalformedDesiredTags(
      properties['Tags'],
      resourceType,
      logicalId,
      physicalId
    );
    const recordedPlan = planTagDiff(previousProperties['Tags'], desiredTags);
    // go-to-k/cdkd#5487: unsettled Tags re-send every template tag.
    const plan =
      context?.unsettledProperties?.has('Tags') === true
        ? { ...recordedPlan, set: planTagDiff([], desiredTags).set }
        : recordedPlan;
    const warning = tagPlanWarning(plan, resourceType, logicalId);
    if (warning) this.logger.warn(warning);

    const instanceId = connectInstanceIdOf(physicalId);
    try {
      if (toWrite.length > 0) {
        context?.markUnsettled?.('Attributes');
        this.logger.debug(mask(`Updating Connect instance ${logicalId} attributes: ${physicalId}`));
        // No settle wait: a write is answered once applied. A not-found
        // fails at once (the deadline is now), it means the instance is gone.
        for (const [key, flag] of toWrite) {
          await this.updateAttribute(instanceId, key, flag, Date.now(), logicalId, mask);
        }
      }
      if (plan.remove.length > 0 || plan.set.size > 0) {
        context?.markUnsettled?.('Tags');
        if (plan.remove.length > 0) {
          await this.getClient().send(
            new UntagResourceCommand({ resourceArn: physicalId, tagKeys: plan.remove })
          );
        }
        if (plan.set.size > 0) {
          await this.getClient().send(
            new TagResourceCommand({ resourceArn: physicalId, tags: Object.fromEntries(plan.set) })
          );
        }
      }
      return { physicalId, wasReplaced: false };
    } catch (error) {
      if (error instanceof CdkdError || isInterruptedWaitError(error)) throw error;
      if (error instanceof ResourceNotFoundException) {
        assertRegionMatch(
          await this.getClient().config.region(),
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Connect instance ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * `DeleteInstance`. It takes effect at once (measured: `DescribeInstance`
   * returns 404 within a second), so there is no wait. The instance's
   * Connect-managed directory goes with it, which is what the handler's
   * `ds:*` delete permissions serve.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(safeMsg`Deleting Connect instance ${logicalId}: ${physicalId}`);
    const mask = maskerOrIdentity(context?.maskSecrets);
    try {
      await this.getClient().send(
        new DeleteInstanceCommand({ InstanceId: connectInstanceIdOf(physicalId) })
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        // The id is addressed in the CLIENT's region: a client in another
        // region than the ARN or the record answers 404 for a live instance.
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion ?? arnRegionOf(physicalId),
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(safeMsg`Connect instance ${physicalId} does not exist, skipping`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const failure = this.wrapMaskedError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Connect instance ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // Only the typed not-found above means this instance is gone.
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(failure)
        : failure;
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Arn') return physicalId;
    if (attributeName === 'Id') return connectInstanceIdOf(physicalId);
    const resp = await this.getClient().send(
      new DescribeInstanceCommand({ InstanceId: connectInstanceIdOf(physicalId) })
    );
    return attributesOf(resp.Instance)[attributeName];
  }

  /**
   * The instance as `DescribeInstance` and `ListInstanceAttributes` report it,
   * in CFn property shape. `Attributes` carries every member AWS reports;
   * `Tags` drops AWS-reserved `aws:` keys. `DirectoryId` is write-only and
   * not read back.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const instanceId = connectInstanceIdOf(physicalId);
    try {
      const instance = (
        await this.getClient().send(new DescribeInstanceCommand({ InstanceId: instanceId }))
      ).Instance;
      if (!instance) return RESOURCE_NOT_FOUND;
      const list: Array<{ AttributeType?: string | undefined; Value?: string | undefined }> = [];
      let nextToken: string | undefined;
      do {
        const page = await this.getClient().send(
          new ListInstanceAttributesCommand({ InstanceId: instanceId, NextToken: nextToken })
        );
        list.push(...(page.Attributes ?? []));
        nextToken = page.NextToken;
      } while (nextToken);
      const result: Record<string, unknown> = {};
      if (instance.IdentityManagementType !== undefined) {
        result['IdentityManagementType'] = instance.IdentityManagementType;
      }
      if (instance.InstanceAlias !== undefined) result['InstanceAlias'] = instance.InstanceAlias;
      result['Attributes'] = attributesFromList(list);
      result['Tags'] = normalizeAwsTagsToCfn(instance.Tags);
      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
  }

  /**
   * Adopt an existing instance into cdkd state: the `--resource` override
   * (the instance ARN or id) verified by `DescribeInstance`, else the
   * template's `InstanceAlias`, which is unique per account and region,
   * looked up through `ListInstances`. The recorded id is always the ARN.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const instance = (
          await this.getClient().send(
            new DescribeInstanceCommand({ InstanceId: connectInstanceIdOf(input.knownPhysicalId) })
          )
        ).Instance;
        if (!instance?.Arn) return null;
        return { physicalId: instance.Arn, attributes: attributesOf(instance) };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }
    const alias = readNameProperty(input, 'InstanceAlias');
    if (alias === undefined) return null;
    let nextToken: string | undefined;
    do {
      const page = await this.getClient().send(new ListInstancesCommand({ NextToken: nextToken }));
      const match = page.InstanceSummaryList?.find((s) => s.InstanceAlias === alias);
      if (match?.Arn) {
        return {
          physicalId: match.Arn,
          attributes: definedAttributes({
            Id: match.Id,
            Arn: match.Arn,
            ServiceRole: match.ServiceRole,
            CreatedTime: match.CreatedTime?.toISOString(),
            InstanceStatus: match.InstanceStatus,
          }),
        };
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return null;
  }
}
