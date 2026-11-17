import type { ASGProvider } from '../asg-provider.js';
import {
  CancelInstanceRefreshCommand,
  DescribeInstanceRefreshesCommand,
  StartInstanceRefreshCommand,
  type RefreshPreferences,
} from '@aws-sdk/client-auto-scaling';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  isRetryableTransientError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { resolvedResourceTimeoutMs } from '../../resource-timeout-registry.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  INSTANCE_REFRESH_TRIGGER_PROPERTIES,
  REPLACEMENT_TRIGGER_PROPERTIES,
  changedTriggers,
  rollingUpdatePolicy,
  willReplaceGroup,
} from './update-policy.js';

/**
 * go-to-k/cdkd#6437: `UpdatePolicy.AutoScalingRollingUpdate` and
 * `UpdatePolicy.AutoScalingInstanceRefresh`, honored under `--update-policy`
 * as an EC2 Auto Scaling instance refresh started after the group's
 * `UpdateAutoScalingGroup`, then waited on.
 *
 * - The refresh runs only when the update changes a property CloudFormation
 *   lists for the policy ({@link REPLACEMENT_TRIGGER_PROPERTIES} for a rolling
 *   update, {@link INSTANCE_REFRESH_TRIGGER_PROPERTIES} for an instance
 *   refresh).
 * - A failed, cancelled or timed-out refresh fails the update. The refresh is
 *   cancelled (never rolled back by AWS: cdkd starts it after the group
 *   already holds the new configuration, so AWS's "previous configuration" is
 *   the new one) and the deploy's rollback reverts the group, which starts a
 *   refresh back to the old configuration under the same policy. That is
 *   CloudFormation's mechanism too: "CloudFormation stack rollback is the
 *   rollback mechanism for `AutoScalingInstanceRefresh`".
 * - `--no-wait` (`CDKD_NO_WAIT`) starts the refresh and returns: the refresh
 *   continues in the background and its outcome is not checked.
 * - Performance gives way to parity here on purpose: the template asked for a
 *   gradual rollout, and only a template declaring the policy pays for it.
 */

/** What the update's `UpdatePolicy` asks the provider to do after the update call. */
export type InstanceRefreshSelection =
  | { kind: 'none' }
  /** CloudFormation: "You can't specify both ... If you do, the stack update fails." */
  | { kind: 'conflict' }
  | { kind: 'rolling'; policy: Readonly<Record<string, unknown>>; triggers: string[] }
  | { kind: 'instance-refresh'; policy: Readonly<Record<string, unknown>>; triggers: string[] };

/**
 * Pick the refresh the update owes, from the policy handed over under
 * `--update-policy` (absent otherwise) and the two property bags. Pure, and
 * read before any AWS call so a conflict is refused before the group changes.
 * `WillReplace: true` routes the update through a replacement in the engine,
 * so a rolling update never runs beside it (CloudFormation's precedence).
 */
export function selectInstanceRefresh(
  updatePolicy: Readonly<Record<string, unknown>> | undefined,
  properties: Readonly<Record<string, unknown>>,
  previousProperties: Readonly<Record<string, unknown>>,
  unsettled?: ReadonlySet<string>
): InstanceRefreshSelection {
  // A trigger an earlier failed refresh left unsettled counts as changed: the
  // record may already equal the template while instances run either side.
  const triggersOf = (keys: readonly string[]): string[] => {
    const moved = changedTriggers(keys, properties, previousProperties);
    return keys.filter((key) => moved.includes(key) || unsettled?.has(key) === true);
  };
  if (updatePolicy === undefined) return { kind: 'none' };
  const refreshBlock = objectAt(updatePolicy, 'AutoScalingInstanceRefresh');
  const rolling = rollingUpdatePolicy(updatePolicy);
  const rollingDeclared = objectAt(updatePolicy, 'AutoScalingRollingUpdate') !== undefined;
  if (refreshBlock !== undefined && rollingDeclared) return { kind: 'conflict' };
  if (refreshBlock !== undefined && !willReplaceGroup(updatePolicy)) {
    const triggers = triggersOf(INSTANCE_REFRESH_TRIGGER_PROPERTIES);
    return triggers.length > 0
      ? { kind: 'instance-refresh', policy: refreshBlock, triggers }
      : { kind: 'none' };
  }
  if (rolling !== undefined) {
    const triggers = triggersOf(REPLACEMENT_TRIGGER_PROPERTIES);
    return triggers.length > 0 ? { kind: 'rolling', policy: rolling, triggers } : { kind: 'none' };
  }
  return { kind: 'none' };
}

function objectAt(
  bag: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> | undefined {
  const value = bag[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A non-negative integer from a template value: a number, or a string of
 * digits (`UpdatePolicy` is not intrinsic-resolved, and a template may quote
 * a number). Anything else is `undefined`.
 */
export function policyInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * An ISO 8601 duration as CloudFormation's `PauseTime` spells it (`PT5M`,
 * `PT1H30M`, `PT90S`), in seconds; `undefined` for anything else.
 */
export function pauseTimeSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value.trim());
  if (match === null || (match[1] ?? match[2] ?? match[3]) === undefined) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/**
 * The refresh preferences approximating an `AutoScalingRollingUpdate` on a
 * group of `desired` instances. CloudFormation replaces up to `MaxBatchSize`
 * (default 1) instances at a time while keeping `MinInstancesInService`
 * (default 0) in service, pausing `PauseTime` after each batch. An instance
 * refresh is shaped by percentages of the desired capacity instead:
 *
 * - `MinInstancesInService` below `desired`: terminate-then-launch batches of
 *   `k = min(MaxBatchSize, desired - MinInstancesInService)`, as
 *   `MinHealthyPercentage = floor(100 * (desired - k) / desired)` and
 *   `MaxHealthyPercentage = 100`. AWS keeps at least that percentage healthy,
 *   so a batch is at most `k` (rounding can make it smaller, never larger).
 * - `MinInstancesInService` at or above `desired`: launch-before-terminate,
 *   `MinHealthyPercentage = 100` and `MaxHealthyPercentage =
 *   100 + ceil(100 * min(MaxBatchSize, desired) / desired)` (capped at 200),
 *   so up to `MaxBatchSize` extra instances run during the refresh.
 * - `PauseTime` becomes `InstanceWarmup`: AWS waits that long after a new
 *   instance is in service before it counts as healthy, which is where
 *   CloudFormation pauses. No `PauseTime` is 0 (CloudFormation sets no pause),
 *   or 300 when `WaitOnResourceSignals` is true (CloudFormation's `PT5M`).
 * - `SkipMatching: false`: CloudFormation replaces every instance.
 *
 * `ignored` collects the members no preference expresses.
 */
export function rollingRefreshPreferences(
  rolling: Readonly<Record<string, unknown>>,
  desired: number,
  ignored: (member: string) => void
): RefreshPreferences {
  const batch = readInteger(rolling, 'MaxBatchSize', 1, ignored);
  const minInService = readInteger(rolling, 'MinInstancesInService', 0, ignored);
  const waitOnSignals =
    rolling['WaitOnResourceSignals'] === true || rolling['WaitOnResourceSignals'] === 'true';
  const pauseRaw = rolling['PauseTime'];
  let warmup = pauseTimeSeconds(pauseRaw);
  if (warmup === undefined) {
    if (pauseRaw !== undefined) ignored('PauseTime');
    warmup = waitOnSignals ? 300 : 0;
  }
  for (const member of [
    'MinActiveInstancesPercent',
    'MinSuccessfulInstancesPercent',
    'SuspendProcesses',
  ]) {
    if (rolling[member] !== undefined) ignored(member);
  }
  const size = Math.max(desired, 1);
  const perBatch = Math.max(batch, 1);
  if (minInService < size) {
    const k = Math.min(perBatch, size - minInService);
    return {
      MinHealthyPercentage: Math.floor((100 * (size - k)) / size),
      MaxHealthyPercentage: 100,
      InstanceWarmup: warmup,
      SkipMatching: false,
    };
  }
  return {
    MinHealthyPercentage: 100,
    MaxHealthyPercentage: Math.min(200, 100 + Math.ceil((100 * Math.min(perBatch, size)) / size)),
    InstanceWarmup: warmup,
    SkipMatching: false,
  };
}

function readInteger(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  ignored: (member: string) => void
): number {
  const raw = bag[key];
  if (raw === undefined) return fallback;
  const value = policyInteger(raw);
  if (value === undefined) {
    ignored(key);
    return fallback;
  }
  return value;
}

/**
 * The refresh `AutoScalingInstanceRefresh` declares: its `Strategy` and its
 * `Preferences`, with CloudFormation's defaults where the template leaves a
 * percentage or `SkipMatching` out (the group's `InstanceMaintenancePolicy`,
 * else `100` / `110` for `Rolling` and `90` / `100` for `ReplaceRootVolume`;
 * `SkipMatching: true`). A member whose value is not the type the API takes
 * is dropped and reported through `ignored`.
 */
export function declaredRefresh(
  block: Readonly<Record<string, unknown>>,
  maintenancePolicy: unknown,
  ignored: (member: string) => void
): { strategy: 'Rolling' | 'ReplaceRootVolume'; preferences: RefreshPreferences } {
  const strategyRaw = block['Strategy'];
  const strategy = strategyRaw === 'ReplaceRootVolume' ? 'ReplaceRootVolume' : 'Rolling';
  if (
    strategyRaw !== undefined &&
    strategyRaw !== 'Rolling' &&
    strategyRaw !== 'ReplaceRootVolume'
  ) {
    ignored('Strategy');
  }
  const prefs = objectAt(block, 'Preferences') ?? {};
  const maintenance =
    typeof maintenancePolicy === 'object' && maintenancePolicy !== null
      ? (maintenancePolicy as Record<string, unknown>)
      : {};
  const integerPref = (key: string): number | undefined => {
    if (prefs[key] === undefined) return undefined;
    const value = policyInteger(prefs[key]);
    if (value === undefined) ignored(`Preferences.${key}`);
    return value;
  };
  const enumPref = (key: string, allowed: readonly string[]): string | undefined => {
    const value = prefs[key];
    if (value === undefined) return undefined;
    if (typeof value === 'string' && allowed.includes(value)) return value;
    ignored(`Preferences.${key}`);
    return undefined;
  };
  const min =
    integerPref('MinHealthyPercentage') ??
    policyInteger(maintenance['MinHealthyPercentage']) ??
    (strategy === 'Rolling' ? 100 : 90);
  const max =
    integerPref('MaxHealthyPercentage') ??
    policyInteger(maintenance['MaxHealthyPercentage']) ??
    (strategy === 'Rolling' ? 110 : 100);
  const warmup = integerPref('InstanceWarmup');
  const bake = integerPref('BakeTime');
  const checkpointDelay = integerPref('CheckpointDelay');
  let checkpoints: number[] | undefined;
  if (prefs['CheckpointPercentages'] !== undefined) {
    const raw = prefs['CheckpointPercentages'];
    const parsed = Array.isArray(raw) ? raw.map(policyInteger) : [undefined];
    if (parsed.every((p): p is number => p !== undefined)) checkpoints = parsed;
    else ignored('Preferences.CheckpointPercentages');
  }
  let skipMatching = true;
  if (prefs['SkipMatching'] !== undefined) {
    const raw = prefs['SkipMatching'];
    if (raw === true || raw === 'true') skipMatching = true;
    else if (raw === false || raw === 'false') skipMatching = false;
    else ignored('Preferences.SkipMatching');
  }
  const scaleIn = enumPref('ScaleInProtectedInstances', ['Refresh', 'Ignore', 'Wait']);
  const standby = enumPref('StandbyInstances', ['Terminate', 'Ignore', 'Wait']);
  let alarms: string[] | undefined;
  const alarmSpec = objectAt(prefs, 'AlarmSpecification');
  if (prefs['AlarmSpecification'] !== undefined) {
    const raw = alarmSpec?.['Alarms'];
    if (Array.isArray(raw) && raw.every((a): a is string => typeof a === 'string')) alarms = raw;
    else ignored('Preferences.AlarmSpecification');
  }
  return {
    strategy,
    preferences: {
      MinHealthyPercentage: min,
      MaxHealthyPercentage: max,
      SkipMatching: skipMatching,
      ...(warmup !== undefined && { InstanceWarmup: warmup }),
      ...(bake !== undefined && { BakeTime: bake }),
      ...(checkpointDelay !== undefined && { CheckpointDelay: checkpointDelay }),
      ...(checkpoints !== undefined && { CheckpointPercentages: checkpoints }),
      ...(scaleIn !== undefined && {
        ScaleInProtectedInstances: scaleIn as RefreshPreferences['ScaleInProtectedInstances'],
      }),
      ...(standby !== undefined && {
        StandbyInstances: standby as RefreshPreferences['StandbyInstances'],
      }),
      ...(alarms !== undefined && { AlarmSpecification: { Alarms: alarms } }),
    },
  };
}

/** The poll interval of the refresh wait. */
export const INSTANCE_REFRESH_POLL_MS = 15_000;

/** A refresh in one of these is still running (AWS runs one per group). */
const ACTIVE_STATUSES = new Set([
  'Pending',
  'InProgress',
  'Cancelling',
  'RollbackInProgress',
  'Baking',
]);

export interface InstanceRefreshRun {
  logicalId: string;
  physicalId: string;
  resourceType: string;
  selection: Extract<InstanceRefreshSelection, { kind: 'rolling' | 'instance-refresh' }>;
  /** The update's desired bag (its `InstanceMaintenancePolicy` is read). */
  properties: Readonly<Record<string, unknown>>;
  /**
   * A rollback revert: a refresh THIS process started for the group and that
   * is still running is cancelled first, and a rolling revert replaces only
   * the instances not on the restored configuration (`SkipMatching: true`).
   */
  replayingState: boolean;
  /**
   * `UpdateContext.markUnsettled`: the trigger properties are marked before
   * the refresh starts, so a failed refresh leaves them unsettled and the
   * deploy's rollback reverts the group (the update itself already landed).
   */
  markUnsettled?: ((propertyName: string) => void) | undefined;
  /** `Date.now()` when `update()` began: the wait's limit counts from there. */
  startedAt?: number | undefined;
  mask: MaskerFn;
}

/**
 * The refresh wait's limit: inside the resource timeout the engine's own
 * deadline enforces (`--resource-timeout`, 30 minutes by default) by a margin
 * of two minutes or a tenth of the timeout, whichever is less, less what the
 * update already spent (`elapsedMs`, from `update()`'s start). The wait then
 * ends first, cancels its refresh and says why, instead of being abandoned by
 * the deadline. The engine's clock also covers retries before this
 * `update()`, which this cannot see; the margin absorbs a short one.
 */
export function refreshWaitCapMs(resourceType: string, elapsedMs = 0): number {
  const timeoutMs = resolvedResourceTimeoutMs(resourceType) ?? 30 * 60 * 1000;
  const marginMs = Math.min(2 * 60_000, Math.floor(timeoutMs / 10));
  return Math.max(0, timeoutMs - marginMs - Math.max(0, elapsedMs));
}

const START_ATTEMPTS = 3;

/**
 * Start the instance refresh `run.selection` asks for and wait for it to end.
 * Throws (marked non-retryable, so `withRetry` never re-runs the update into
 * an `InstanceRefreshInProgress`) when it cannot start, ends in anything but
 * `Successful`, or outlives {@link refreshWaitCapMs}; the last cancels it
 * first. A Ctrl-C cancels it and throws the interrupt. Every cancel names the
 * refresh this call started, and is sent only while that refresh is the one
 * running.
 */
export async function runInstanceRefresh(
  provider: ASGProvider,
  run: InstanceRefreshRun
): Promise<void> {
  const { logicalId, physicalId, resourceType, selection, mask } = run;
  const wrapRefreshError = (text: string, cause?: Error): ProvisioningError =>
    markNonRetryable(
      new ProvisioningError(
        mask(`Failed to update AutoScalingGroup ${logicalId}: ${text}`),
        resourceType,
        logicalId,
        physicalId,
        cause
      )
    );

  const ignored: string[] = [];
  let strategy: 'Rolling' | 'ReplaceRootVolume' = 'Rolling';
  let preferences: RefreshPreferences;
  if (selection.kind === 'rolling') {
    const group = await describeQuietly(provider, physicalId, mask);
    if (group !== undefined && (group.Instances ?? []).length === 0 && !group.DesiredCapacity) {
      provider.logger.debug(
        mask(
          `AutoScalingGroup ${logicalId} has no instances; the rolling update has nothing to replace`
        )
      );
      return;
    }
    const desired =
      group?.DesiredCapacity ??
      policyInteger(run.properties['DesiredCapacity']) ??
      policyInteger(run.properties['MinSize']) ??
      1;
    preferences = rollingRefreshPreferences(selection.policy, desired, (m) => ignored.push(m));
    // A revert replaces only what the forward moved: an instance already on
    // the restored configuration (the forward's refresh never reached it, or
    // the forward update never landed) is kept.
    // Skip matching compares launch templates and instance types, so it is
    // used only when the revert moves nothing else: a subnet or placement
    // group change, or a group restored to a launch configuration, rolls
    // every instance.
    if (
      run.replayingState &&
      selection.triggers.every(
        (key) => key === 'LaunchTemplate' || key === 'MixedInstancesPolicy'
      ) &&
      (run.properties['LaunchTemplate'] != null || run.properties['MixedInstancesPolicy'] != null)
    ) {
      preferences = { ...preferences, SkipMatching: true };
    }
    if (
      selection.policy['WaitOnResourceSignals'] === true ||
      selection.policy['WaitOnResourceSignals'] === 'true'
    ) {
      provider.logger.warn(
        mask(
          `${logicalId}: UpdatePolicy AutoScalingRollingUpdate WaitOnResourceSignals is not honored; cdkd does not wait for cfn-signal success signals, and waits PauseTime after each new instance is in service instead.`
        )
      );
    }
  } else {
    const declared = declaredRefresh(
      selection.policy,
      run.properties['InstanceMaintenancePolicy'],
      (m) => ignored.push(m)
    );
    strategy = declared.strategy;
    preferences = declared.preferences;
    // A revert must not stop at the forward's checkpoints or alarms: the
    // alarm may be what failed the forward refresh.
    if (run.replayingState) {
      const {
        AlarmSpecification: _alarms,
        CheckpointPercentages: _checkpoints,
        CheckpointDelay: _delay,
        ...kept
      } = preferences;
      preferences = kept;
    }
  }
  const policyName =
    selection.kind === 'rolling' ? 'AutoScalingRollingUpdate' : 'AutoScalingInstanceRefresh';
  if (ignored.length > 0) {
    provider.logger.info(
      mask(`${logicalId}: UpdatePolicy ${policyName} ${ignored.join(', ')} not applied by cdkd.`)
    );
  }

  const startOnce = async (): Promise<string> => {
    const response = await provider.getClient().send(
      new StartInstanceRefreshCommand({
        AutoScalingGroupName: physicalId,
        Strategy: strategy,
        Preferences: preferences,
      })
    );
    const id = response.InstanceRefreshId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('StartInstanceRefresh returned no InstanceRefreshId');
    }
    return id;
  };
  // A throttle is retried here: the update itself already landed, and the
  // error below is marked non-retryable, so nothing else would retry it.
  const start = async (): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await startOnce();
      } catch (error) {
        const transient = error instanceof Error && isRetryableTransientError(error, error.message);
        if (!transient || attempt >= START_ATTEMPTS) throw error;
        await provider.sleep(2_000 * attempt);
      }
    }
  };
  // The trigger properties are moving from here on (the update landed; the
  // refresh replaces instances asynchronously).
  for (const key of selection.triggers) run.markUnsettled?.(key);
  let refreshId: string;
  try {
    try {
      refreshId = await start();
    } catch (error) {
      if (!isNamed(error, 'InstanceRefreshInProgressFault') || !run.replayingState) throw error;
      // The failed deploy's refresh (abandoned by a deadline, or started
      // under --no-wait) may still be running; the revert owns the group,
      // but only for a refresh this process started.
      const active = await activeRefreshId(provider, physicalId);
      const ours = provider.startedRefreshes.get(physicalId);
      if (typeof active !== 'string' || ours === undefined || active !== ours) throw error;
      provider.logger.info(
        mask(
          `${logicalId}: cancelling instance refresh ${active}, still running from the failed deploy, before reverting the group.`
        )
      );
      await cancelIfActive(provider, logicalId, physicalId, active, mask, true);
      await settleActiveRefresh(provider, physicalId, logicalId);
      refreshId = await start();
    }
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    if (isNamed(error, 'InstanceRefreshInProgressFault')) {
      throw wrapRefreshError(
        `an instance refresh is already running on the group, and AWS runs one at a time. Wait for it to finish or cancel it, then ${run.replayingState ? 'run the rollback again' : 'deploy again'}.`,
        cause
      );
    }
    throw wrapRefreshError(
      `could not start the instance refresh: ${describeAwsFailure(error).detail}`,
      cause
    );
  }
  provider.startedRefreshes.set(physicalId, refreshId);
  provider.logger.info(
    mask(
      `${logicalId}: UpdatePolicy ${policyName}: instance refresh ${refreshId} started (${selection.triggers.join(', ')} changed; MinHealthyPercentage ${preferences.MinHealthyPercentage}, MaxHealthyPercentage ${preferences.MaxHealthyPercentage}${preferences.InstanceWarmup !== undefined ? `, InstanceWarmup ${preferences.InstanceWarmup}s` : ''}).`
    )
  );
  if (process.env['CDKD_NO_WAIT'] === 'true') {
    provider.logger.info(
      mask(
        `${logicalId}: --no-wait: not waiting for the instance refresh; its outcome is not checked.`
      )
    );
    return;
  }

  const capMs = refreshWaitCapMs(
    resourceType,
    run.startedAt !== undefined ? Date.now() - run.startedAt : 0
  );
  const maxPolls = Math.max(1, Math.ceil(capMs / INSTANCE_REFRESH_POLL_MS));
  const watch = startInterruptWatch(`The instance refresh of AutoScalingGroup ${logicalId}`);
  try {
    for (let poll = 0; poll < maxPolls; poll++) {
      for (let slept = 0; slept < INSTANCE_REFRESH_POLL_MS; slept += 1_000) {
        if (watch.isInterrupted()) {
          await cancelIfActive(provider, logicalId, physicalId, refreshId, mask, true);
          throw watch.onInterrupted();
        }
        await provider.sleep(1_000);
      }
      if (watch.isInterrupted()) {
        await cancelIfActive(provider, logicalId, physicalId, refreshId, mask, true);
        throw watch.onInterrupted();
      }
      const read = await readRefresh(provider, physicalId, refreshId);
      if (read === undefined) {
        // A throttle or a blip is not an outcome: keep waiting.
        provider.logger.debug(
          mask(`DescribeInstanceRefreshes for AutoScalingGroup ${logicalId} failed`)
        );
        continue;
      }
      if (read.status === 'Successful') {
        provider.logger.info(mask(`${logicalId}: instance refresh ${refreshId} succeeded.`));
        return;
      }
      if (read.status !== undefined && !ACTIVE_STATUSES.has(read.status)) {
        throw wrapRefreshError(
          `instance refresh ${refreshId} ended ${read.status}${read.reason ? `: ${read.reason}` : ''}`
        );
      }
    }
  } finally {
    watch.dispose();
  }
  const cancel = await cancelIfActive(provider, logicalId, physicalId, refreshId, mask, false);
  const outcome =
    cancel === 'cancelled'
      ? 'and was cancelled'
      : cancel === 'not-running'
        ? 'and is no longer running'
        : 'and could not be confirmed cancelled (check aws autoscaling describe-instance-refreshes)';
  throw wrapRefreshError(
    `instance refresh ${refreshId} did not finish within ${capMs >= 120_000 ? `${Math.round(capMs / 60_000)} minutes` : `${Math.round(capMs / 1_000)} seconds`} ${outcome}. Raise the limit with --resource-timeout ${resourceType}=<duration>.`
  );
}

async function describeQuietly(
  provider: ASGProvider,
  physicalId: string,
  mask: MaskerFn
): Promise<Awaited<ReturnType<ASGProvider['describeGroup']>> | undefined> {
  try {
    return await provider.describeGroup(physicalId);
  } catch (error) {
    provider.logger.debug(
      mask(`DescribeAutoScalingGroups(${physicalId}) failed: ${describeAwsFailure(error).detail}`)
    );
    return undefined;
  }
}

/** The refresh's status and reason, or `undefined` when it could not be read. */
async function readRefresh(
  provider: ASGProvider,
  physicalId: string,
  refreshId: string
): Promise<{ status: string | undefined; reason: string | undefined } | undefined> {
  try {
    const response = await provider.getClient().send(
      new DescribeInstanceRefreshesCommand({
        AutoScalingGroupName: physicalId,
        InstanceRefreshIds: [refreshId],
      })
    );
    const refresh = response.InstanceRefreshes?.[0];
    return { status: refresh?.Status, reason: refresh?.StatusReason };
  } catch {
    return undefined;
  }
}

/**
 * The id of the group's running refresh before an update writes anything, or
 * `undefined` when none runs or the read failed (the start then reports a
 * conflict itself). `DescribeInstanceRefreshes` returns a group's refreshes
 * "sorted by creation timestamp in descending order", so the first one is
 * the latest, and only the latest can be running.
 */
export async function runningRefreshOf(
  provider: ASGProvider,
  physicalId: string
): Promise<string | undefined> {
  const active = await activeRefreshId(provider, physicalId);
  return typeof active === 'string' ? active : undefined;
}

/** The id of the group's running refresh, `undefined` for none, `UNREADABLE` when the read failed. */
const UNREADABLE = Symbol('unreadable');
async function activeRefreshId(
  provider: ASGProvider,
  physicalId: string
): Promise<string | undefined | typeof UNREADABLE> {
  try {
    const response = await provider
      .getClient()
      .send(
        new DescribeInstanceRefreshesCommand({ AutoScalingGroupName: physicalId, MaxRecords: 1 })
      );
    const latest = response.InstanceRefreshes?.[0];
    return latest?.Status !== undefined && ACTIVE_STATUSES.has(latest.Status)
      ? latest.InstanceRefreshId
      : undefined;
  } catch {
    return UNREADABLE;
  }
}

/**
 * Cancel `refreshId`, only while it is the group's running refresh:
 * `CancelInstanceRefresh` names no refresh, so a cancel sent after another one
 * started (a rollback's, an operator's) would stop that one instead. The read
 * and the cancel are two calls, so a refresh started in between (only once
 * `refreshId` ended) would still be cancelled; the API offers no tighter
 * check. `warn` reports an unreadable or failed cancel itself; otherwise the
 * caller words the outcome.
 */
async function cancelIfActive(
  provider: ASGProvider,
  logicalId: string,
  physicalId: string,
  refreshId: string,
  mask: MaskerFn,
  warn: boolean
): Promise<'cancelled' | 'not-running' | 'unconfirmed'> {
  const active = await activeRefreshId(provider, physicalId);
  if (active === UNREADABLE) {
    if (warn) {
      provider.logger.warn(
        mask(
          `${logicalId}: could not read whether instance refresh ${refreshId} is still running, so it was not cancelled; check aws autoscaling describe-instance-refreshes.`
        )
      );
    }
    return 'unconfirmed';
  }
  if (active !== refreshId) return 'not-running';
  try {
    await provider
      .getClient()
      .send(new CancelInstanceRefreshCommand({ AutoScalingGroupName: physicalId }));
    return 'cancelled';
  } catch (error) {
    if (isNamed(error, 'ActiveInstanceRefreshNotFoundFault')) return 'not-running';
    provider.logger.warn(
      mask(
        `${logicalId}: could not cancel instance refresh ${refreshId}: ${describeAwsFailure(error).detail}`
      )
    );
    return 'unconfirmed';
  }
}

/**
 * Wait (bounded, 10 minutes) until the group runs no refresh, so a new one
 * can start. A Ctrl-C ends the wait with the interrupt.
 */
async function settleActiveRefresh(
  provider: ASGProvider,
  physicalId: string,
  logicalId: string
): Promise<void> {
  const watch = startInterruptWatch(
    `The cancelled instance refresh of AutoScalingGroup ${logicalId}`
  );
  try {
    for (let poll = 0; poll < 40; poll++) {
      try {
        const response = await provider.getClient().send(
          new DescribeInstanceRefreshesCommand({
            AutoScalingGroupName: physicalId,
            MaxRecords: 1,
          })
        );
        const status = response.InstanceRefreshes?.[0]?.Status;
        if (status === undefined || !ACTIVE_STATUSES.has(status)) return;
      } catch {
        // Unreadable: try again after the interval; the start reports the outcome.
      }
      for (let slept = 0; slept < INSTANCE_REFRESH_POLL_MS; slept += 1_000) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        await provider.sleep(1_000);
      }
    }
  } finally {
    watch.dispose();
  }
}

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/**
 * go-to-k/cdkd#6437, `CreateContext.awaitInService`: wait for a group an
 * `AutoScalingReplacingUpdate` just created to have its desired capacity of
 * instances `InService` and `Healthy`, so the old group is deleted only once
 * the new one serves. Waits under `--no-wait` too: returning early would let
 * the old group, and its capacity, go before the new group has any. cdkd
 * reads the group's own instance states only; it receives no `cfn-signal`
 * and does not read target-group health. Bounded like the refresh wait
 * ({@link refreshWaitCapMs}, from `startedAt`); a timeout throws, marked
 * non-retryable, and the create's own cleanup retires the new group.
 */
export async function waitForInService(
  provider: ASGProvider,
  groupName: string,
  logicalId: string,
  resourceType: string,
  mask: MaskerFn,
  startedAt: number
): Promise<void> {
  const capMs = refreshWaitCapMs(resourceType, Date.now() - startedAt);
  const maxPolls = Math.max(1, Math.ceil(capMs / INSTANCE_REFRESH_POLL_MS));
  const watch = startInterruptWatch(`The new instances of AutoScalingGroup ${logicalId}`);
  let last = '';
  try {
    for (let poll = 0; poll < maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      const group = await describeQuietly(provider, groupName, mask);
      if (group !== undefined) {
        const desired = group.DesiredCapacity ?? 0;
        const ready = (group.Instances ?? []).filter(
          (i) => i.LifecycleState === 'InService' && i.HealthStatus === 'Healthy'
        ).length;
        last = `${ready} of ${desired}`;
        if (ready >= desired) {
          provider.logger.info(
            mask(`${logicalId}: the new group has ${last} instances in service.`)
          );
          return;
        }
      }
      for (let slept = 0; slept < INSTANCE_REFRESH_POLL_MS; slept += 1_000) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        await provider.sleep(1_000);
      }
    }
  } finally {
    watch.dispose();
  }
  throw markNonRetryable(
    new ProvisioningError(
      mask(
        `the new instances of AutoScalingGroup ${logicalId} were not in service in time (${last || 'unread'}); the old group is kept, and the new group is deleted without waiting for it to go: let it finish before deploying again. Raise the limit with --resource-timeout ${resourceType}=<duration>.`
      ),
      resourceType,
      logicalId,
      groupName
    )
  );
}
