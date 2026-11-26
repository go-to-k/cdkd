import {
  LightsailClient,
  PutAlarmCommand,
  GetAlarmsCommand,
  DeleteAlarmCommand,
  type Alarm,
  type PutAlarmCommandInput,
  type MetricName,
  type ComparisonOperator,
  type TreatMissingData,
  type ContactProtocol,
  type AlarmState,
} from '@aws-sdk/client-lightsail';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { markNotGone } from '../not-gone.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generatedNameFor } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { definedAttributes } from '../attribute-map.js';
import { coerceCfnBoolean } from '../config-shape.js';
import { injectiveKey } from '../../state/record-keys.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceNotFound,
  ResourceImportResult,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import {
  isThrottlingError,
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { safeMsg } from '../../utils/display-safe.js';

/**
 * The Lightsail APIs this provider calls, each with its own token bucket on
 * AWS's side, per account and region (go-to-k/cdkd#6830). Bucket size and
 * refill per second, from the Lightsail API throttling page of the Lightsail
 * user guide: `PutAlarm` 3 / 1, `DeleteAlarm` 3 / 1, `GetAlarms` 5 / 1.
 */
export type LightsailAlarmApi = 'PutAlarm' | 'GetAlarms' | 'DeleteAlarm';

const AWS_BUCKETS: Record<LightsailAlarmApi, { size: number; refillPerSecond: number }> = {
  PutAlarm: { size: 3, refillPerSecond: 1 },
  DeleteAlarm: { size: 3, refillPerSecond: 1 },
  GetAlarms: { size: 5, refillPerSecond: 1 },
};

/**
 * A client-side token bucket mirroring one of Lightsail's, so a deploy sends
 * no more than AWS refills (go-to-k/cdkd#6830). A dozen alarms dispatched
 * together otherwise drain the 3-token `PutAlarm` bucket in one burst, and the
 * 1-per-second refill throttles the rest; Cloud Control's handler then also
 * fails its own clean-up `DeleteAlarm`, leaving the alarm to collide with the
 * retry.
 *
 * It starts one token short of AWS's bucket and refills a little slower, so
 * calls the account makes outside cdkd (the console, another deploy) have
 * room; a throttle that still happens is retried by the provider.
 */
export class LightsailTokenBucket {
  private tokens: number;
  private last: number;
  private readonly size: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    size: number,
    refillPerSecond: number,
    now: () => number = () => Date.now(),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    this.size = size;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.sleep = sleep;
    this.tokens = size;
    this.last = now();
  }

  /** Wait until a token is free, then take it. */
  async take(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.tokens = Math.min(
        this.size,
        this.tokens + ((now - this.last) / 1000) * this.refillPerSecond
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000));
    }
  }
}

/**
 * One bucket per region and API, process-wide: AWS counts per account and
 * region, and `deploy --all` runs several stacks in one process. The key has
 * no account: stacks of two accounts in one process share a bucket, which is
 * only slower.
 */
const buckets = new Map<string, LightsailTokenBucket>();

export function bucketFor(region: string, api: LightsailAlarmApi): LightsailTokenBucket {
  const key = injectiveKey(region, api);
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    const aws = AWS_BUCKETS[api];
    bucket = new LightsailTokenBucket(Math.max(1, aws.size - 1), aws.refillPerSecond * 0.9);
    buckets.set(key, bucket);
  }
  return bucket;
}

/** Drops every bucket, for tests. */
export function resetLightsailTokenBuckets(): void {
  buckets.clear();
}

/**
 * AWS Lightsail Alarm Provider (go-to-k/cdkd#6830).
 *
 * `PutAlarm` creates or overwrites the alarm of that name, `GetAlarms` reads
 * it, `DeleteAlarm` removes it. The physical id is the alarm name, as Cloud
 * Control's. Every call takes a token of {@link LightsailTokenBucket} first.
 *
 * `PutAlarm` does not refuse a taken name, so the type is a name-adopting
 * create (`NAME_ADOPTING_SDK_CREATE_TYPES`): the deploy engine looks the name
 * up through {@link import} before the create and refuses any holder.
 */
export class LightsailAlarmProvider implements ResourceProvider {
  private client?: LightsailClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('LightsailAlarmProvider');

  /** All of `PutAlarm`'s members; `AlarmArn` and `State` are read-only. */
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lightsail::Alarm',
      new Set([
        'AlarmName',
        'MonitoredResourceName',
        'MetricName',
        'ComparisonOperator',
        'EvaluationPeriods',
        'Threshold',
        'DatapointsToAlarm',
        'TreatMissingData',
        'ContactProtocols',
        'NotificationTriggers',
        'NotificationEnabled',
      ]),
    ],
  ]);

  /** The throttle backoff ceilings of {@link send}, one per retry. Tests shorten them. */
  throttleDelaysMs: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 20_000];

  /** The jitter source for {@link throttleDelaysMs}, in `[0, 1)`; tests pin it. */
  throttleJitter: () => number = () => Math.random();

  /** The one wait {@link send} makes between throttle retries; tests replace it. */
  throttleSleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** The bucket a call takes a token of; tests replace it. */
  takeToken: (region: string, api: LightsailAlarmApi) => Promise<void> = (region, api) =>
    bucketFor(region, api).take();

  getClient(): LightsailClient {
    // `maxAttempts: 1`: the SDK's own throttle retries would resend outside
    // the bucket; {@link send} owns every retry, each taking a token. A 5xx
    // reaches the engine's retry, and every call here is safe to resend.
    this.client ??= new LightsailClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
      maxAttempts: 1,
    });
    return this.client;
  }

  /**
   * Send one call, paced by the region's bucket for its API and retried on a
   * throttle with jittered backoff. Every call is safe to resend: `PutAlarm`
   * overwrites the alarm of that name, `DeleteAlarm` of a gone alarm answers
   * not-found, and `GetAlarms` only reads. Any other failure, and a throttle
   * past the budget, is thrown unchanged.
   */
  private async send<T>(
    api: LightsailAlarmApi,
    logicalId: string,
    call: (client: LightsailClient) => Promise<T>
  ): Promise<T> {
    const client = this.getClient();
    const region = await client.config.region();
    for (let retry = 0; ; retry++) {
      await this.takeToken(region, api);
      try {
        return await call(client);
      } catch (error) {
        const ceiling = this.throttleDelaysMs[retry];
        if (ceiling === undefined || !isThrottlingError(error)) throw error;
        const delay = Math.round(ceiling / 2 + (this.throttleJitter() * ceiling) / 2);
        this.logger.debug(
          safeMsg`${api} for ${logicalId} was throttled; retrying in ${delay}ms (retry ${retry + 1}/${this.throttleDelaysMs.length})`
        );
        await this.throttleSleep(delay);
      }
    }
  }

  /**
   * The failure wrap the create, update and delete catches throw: an
   * AWS-authored failure by its CLASS, AWS's text to `debug` through the
   * operation's masker (a thrown message is persisted, go-to-k/cdkd#2319),
   * stamped `markRedactedCause` so the retry classifiers read the chain. As
   * `CloudWatchAlarmProvider`'s.
   */
  private wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(safeMsg`Creating Lightsail alarm ${logicalId}`);
    const alarmName =
      (properties['AlarmName'] as string | undefined) ||
      (this.generatedCreateName(resourceType, logicalId, properties) as string);
    const mask = maskerOrIdentity(context?.maskSecrets);

    // Built before the `try`: its refusal is cdkd's own, not an AWS failure.
    const input = this.buildPutAlarmInput(logicalId, alarmName, properties);
    try {
      await this.send('PutAlarm', logicalId, (client) => client.send(new PutAlarmCommand(input)));
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create Lightsail alarm ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
    return {
      physicalId: alarmName,
      attributes: await this.readAttributesAfterWrite(alarmName, logicalId, mask, 'create'),
    };
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(safeMsg`Updating Lightsail alarm ${logicalId}: ${physicalId}`);
    // The physical id is a NAME, so a client in another region than the state
    // record would act on a same-named alarm cdkd does not manage
    // (go-to-k/cdkd#2613).
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    const mask = maskerOrIdentity(context?.maskSecrets);

    // Built before the `try`: its refusal is cdkd's own, not an AWS failure.
    const input = this.buildPutAlarmInput(logicalId, physicalId, properties);
    try {
      // `PutAlarm` replaces the whole configuration of the named alarm.
      await this.send('PutAlarm', logicalId, (client) => client.send(new PutAlarmCommand(input)));
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Lightsail alarm ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
    // An empty read (failed, or no alarm listed) is no `attributes`: the map
    // REPLACES the record, so `{}` would erase the recorded AlarmArn / State
    // (go-to-k/cdkd#7009).
    const attributes = await this.readAttributesAfterWrite(physicalId, logicalId, mask, 'update');
    return {
      physicalId,
      wasReplaced: false,
      ...(Object.keys(attributes).length > 0 && { attributes }),
    };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(safeMsg`Deleting Lightsail alarm ${logicalId}: ${physicalId}`);
    // The id is a NAME: a client in another region than the record would
    // delete a same-named alarm cdkd does not manage there (go-to-k/cdkd#2613).
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-delete'
    );
    try {
      await this.send('DeleteAlarm', logicalId, (client) =>
        client.send(new DeleteAlarmCommand({ alarmName: physicalId }))
      );
    } catch (error) {
      if (this.isNotFound(error)) {
        assertRegionMatch(
          await this.getClient().config.region(),
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(safeMsg`Lightsail alarm ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Lightsail alarm ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // Only the typed not-found above means the alarm is gone; the wrap must
      // not read as already deleted to the delete classifiers (#2319, #5228).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  /**
   * `AlarmArn` and `State` after a write, read with `GetAlarms`. The alarm
   * exists by now, so a failed read does not fail the create or update: it
   * warns and returns no attributes. After a create the record then holds
   * none, which the `Fn::GetAtt`-miss heal reads back through {@link import}
   * when a template asks for one. After an update `update()` returns no
   * `attributes`, so the record keeps the last read's (go-to-k/cdkd#7009):
   * the `AlarmArn` is the alarm's and does not move, and `State` is the
   * snapshot that read took. Failing here would leave a live alarm with no
   * state record.
   */
  private async readAttributesAfterWrite(
    alarmName: string,
    logicalId: string,
    mask: MaskerFn,
    operation: 'create' | 'update'
  ): Promise<Record<string, unknown>> {
    try {
      const alarm = await this.getAlarm(alarmName, logicalId);
      return definedAttributes({ AlarmArn: alarm?.arn, State: alarm?.state });
    } catch (error) {
      this.logger.warn(
        mask(
          operation === 'create'
            ? safeMsg`Could not read Lightsail alarm ${alarmName} back after creating it (${describeAwsFailure(error).summary}); its AlarmArn and State are read again when needed`
            : safeMsg`Could not read Lightsail alarm ${alarmName} back after updating it (${describeAwsFailure(error).summary}); the recorded AlarmArn and State are kept, State as of the last read`
        )
      );
      return {};
    }
  }

  /** The alarm of that name, `undefined` when Lightsail has none. */
  private async getAlarm(alarmName: string, logicalId: string): Promise<Alarm | undefined> {
    try {
      const resp = await this.send('GetAlarms', logicalId, (client) =>
        client.send(new GetAlarmsCommand({ alarmName }))
      );
      return resp.alarms?.find((alarm) => alarm.name === alarmName);
    } catch (error) {
      if (this.isNotFound(error)) return undefined;
      throw error;
    }
  }

  private buildPutAlarmInput(
    logicalId: string,
    alarmName: string,
    properties: Record<string, unknown>
  ): PutAlarmCommandInput {
    const input: PutAlarmCommandInput = {
      alarmName,
      metricName: properties['MetricName'] as MetricName,
      monitoredResourceName: properties['MonitoredResourceName'] as string,
      comparisonOperator: properties['ComparisonOperator'] as ComparisonOperator,
      threshold: Number(properties['Threshold']),
      evaluationPeriods: Number(properties['EvaluationPeriods']),
    };
    if (properties['DatapointsToAlarm'] != null) {
      input.datapointsToAlarm = Number(properties['DatapointsToAlarm']);
    }
    if (properties['TreatMissingData'] != null) {
      input.treatMissingData = properties['TreatMissingData'] as TreatMissingData;
    }
    if (properties['ContactProtocols'] != null) {
      input.contactProtocols = properties['ContactProtocols'] as ContactProtocol[];
    }
    if (properties['NotificationTriggers'] != null) {
      input.notificationTriggers = properties['NotificationTriggers'] as AlarmState[];
    }
    if (properties['NotificationEnabled'] != null) {
      // An unreadable value is refused, never read as `false`: that would
      // switch the alarm's notifications off.
      const enabled = coerceCfnBoolean(properties['NotificationEnabled']);
      if (enabled === undefined) {
        throw markNonRetryable(
          new ProvisioningError(
            `Lightsail alarm ${logicalId}: NotificationEnabled must be true or false`,
            'AWS::Lightsail::Alarm',
            logicalId
          )
        );
      }
      input.notificationEnabled = enabled;
    }
    return input;
  }

  /** The alarm as CloudFormation properties, for `cdkd drift`. */
  async readCurrentState(
    physicalId: string,
    logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const alarm = await this.getAlarm(physicalId, logicalId);
    if (!alarm) return RESOURCE_NOT_FOUND;
    const result: Record<string, unknown> = {};
    if (alarm.name !== undefined) result['AlarmName'] = alarm.name;
    if (alarm.monitoredResourceInfo?.name !== undefined) {
      result['MonitoredResourceName'] = alarm.monitoredResourceInfo.name;
    }
    if (alarm.metricName !== undefined) result['MetricName'] = alarm.metricName;
    if (alarm.comparisonOperator !== undefined) {
      result['ComparisonOperator'] = alarm.comparisonOperator;
    }
    if (alarm.evaluationPeriods !== undefined) {
      result['EvaluationPeriods'] = alarm.evaluationPeriods;
    }
    if (alarm.threshold !== undefined) result['Threshold'] = alarm.threshold;
    if (alarm.datapointsToAlarm !== undefined)
      result['DatapointsToAlarm'] = alarm.datapointsToAlarm;
    if (alarm.treatMissingData !== undefined) result['TreatMissingData'] = alarm.treatMissingData;
    if (alarm.contactProtocols !== undefined) {
      result['ContactProtocols'] = [...alarm.contactProtocols];
    }
    if (alarm.notificationTriggers !== undefined) {
      result['NotificationTriggers'] = [...alarm.notificationTriggers];
    }
    if (alarm.notificationEnabled !== undefined) {
      result['NotificationEnabled'] = alarm.notificationEnabled;
    }
    return result;
  }

  /** go-to-k/cdkd#4705: the name `create()` sends when the template names none. */
  generatedCreateName(
    _resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    if (properties['AlarmName']) return undefined;
    return generatedNameFor('AWS::Lightsail::Alarm', logicalId);
  }

  /**
   * Verify an alarm by name. Lightsail alarms carry no tags, so there is no
   * `aws:cdk:path` walk: an alarm with no `AlarmName` to go by needs an
   * explicit `--resource` override.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'AlarmName');
    if (!explicit) return null;
    const alarm = await this.getAlarm(explicit, input.logicalId);
    return alarm
      ? {
          physicalId: explicit,
          attributes: definedAttributes({ AlarmArn: alarm.arn, State: alarm.state }),
        }
      : null;
  }

  private isNotFound(err: unknown): boolean {
    return err instanceof Error && err.name === 'NotFoundException';
  }
}
