import { createHash } from 'node:crypto';
import { ProvisioningError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import {
  markNonRetryable,
  markRedactedCause,
  isRetryableTransientError,
} from '../../deployment/retryable-errors.js';
import { markRefusedBeforeApplying } from '../../deployment/prior-attempt-scope.js';
import { startInterruptWatch } from '../interrupt-watch.js';
import { resolvedResourceTimeoutMs } from '../resource-timeout-registry.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type { UpdateContext } from '../../types/resource.js';
import type { IdLogSink } from './id-log.js';
import { maskCallerIdentity } from './caller-identity.js';

/**
 * go-to-k/cdkd#6437: `UpdatePolicy.CodeDeployLambdaAliasUpdate` under
 * `--update-policy`. CloudFormation: "To perform an CodeDeploy deployment when
 * the version changes on an `AWS::Lambda::Alias` resource, use the
 * `CodeDeployLambdaAliasUpdate` update policy."
 *
 * `AWS::Lambda::Alias` has no SDK provider, so this runs inside
 * `CloudControlProvider.update` (its only route), BEFORE the Cloud Control
 * patch: when the alias's `FunctionVersion` changes, cdkd shifts the alias
 * through a CodeDeploy deployment (current version -> target version, the
 * policy's hooks) and waits for it to succeed; the patch then leaves
 * `FunctionVersion` alone and applies the alias's other changed properties.
 * It runs under `--no-wait` too (see the wait below). A failed deployment
 * fails the update before Cloud Control is called, so
 * nothing but CodeDeploy's own traffic shift (which its rollback undoes) has
 * changed.
 *
 * The rollback revert reaches this through the same `update()`, with the
 * forward deploy's journaled (resolved) policy: the alias is shifted back
 * through CodeDeploy, as CloudFormation's rollback update does.
 *
 * Without `UpdateContext.updatePolicy` (no `--update-policy`) nothing here
 * runs and no AWS call is made.
 */

export const CODEDEPLOY_ALIAS_POLICY_KEY = 'CodeDeployLambdaAliasUpdate';

/**
 * What a deployment needs on top of its configuration's traffic time (its
 * start-up and hooks) for the fits-the-timeout check before it starts.
 */
export const SHIFT_OVERHEAD_RESERVE_MS = 5 * 60_000;

/** The poll interval of the deployment wait. */
export const CODEDEPLOY_POLL_MS = 15_000;

/** A deployment in one of these is still running (one per deployment group). */
export const ACTIVE_DEPLOYMENT_STATUSES = ['Created', 'Queued', 'InProgress', 'Baking', 'Ready'];

/** The minimal client surface this module sends through (an SDK client, or a test double). */
export interface SendClient {
  send(command: unknown): Promise<unknown>;
}

export interface CodeDeployAliasClients {
  codeDeploy: SendClient;
  lambda: SendClient;
  /** The SDK command classes, loaded lazily with the clients. */
  commands: {
    GetAlias: new (input: Record<string, unknown>) => unknown;
    UpdateAlias: new (input: Record<string, unknown>) => unknown;
    GetDeploymentGroup: new (input: Record<string, unknown>) => unknown;
    GetDeploymentConfig: new (input: Record<string, unknown>) => unknown;
    ListDeployments: new (input: Record<string, unknown>) => unknown;
    CreateDeployment: new (input: Record<string, unknown>) => unknown;
    GetDeployment: new (input: Record<string, unknown>) => unknown;
    StopDeployment: new (input: Record<string, unknown>) => unknown;
  };
  destroy(): void;
}

/** What the provider needs to run a deployment. */
export interface CodeDeployAliasHost {
  logger: IdLogSink;
  sleep(ms: number): Promise<void>;
  /** Deployments this process started, per alias physical id (a revert may stop its own). */
  startedAliasDeployments: Map<string, string>;
  /** The clients, in the Cloud Control client's region. */
  codeDeployAliasClients(): Promise<CodeDeployAliasClients>;
  /** The clock the waits' deadlines read (tests advance it with `sleep`); `Date.now` when absent. */
  now?: (() => number) | undefined;
}

function clockOf(host: CodeDeployAliasHost): () => number {
  return () => host.now?.() ?? Date.now();
}

/** The resolved `CodeDeployLambdaAliasUpdate` fields. */
export interface AliasDeploymentPolicy {
  applicationName: string;
  deploymentGroupName: string;
  beforeAllowTrafficHook?: string | undefined;
  afterAllowTrafficHook?: string | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The policy's fields, or the reason they are unusable (a missing name, or a
 * value that is not a string: an intrinsic cdkd could not resolve).
 */
export function readAliasDeploymentPolicy(
  updatePolicy: Readonly<Record<string, unknown>> | undefined
): AliasDeploymentPolicy | { unusable: string } | undefined {
  const policy = updatePolicy?.[CODEDEPLOY_ALIAS_POLICY_KEY];
  if (policy === undefined) return undefined;
  if (!isObject(policy)) return { unusable: 'it is not an object' };
  const applicationName = nonEmptyString(policy['ApplicationName']);
  const deploymentGroupName = nonEmptyString(policy['DeploymentGroupName']);
  if (applicationName === undefined || deploymentGroupName === undefined) {
    return { unusable: 'its ApplicationName and DeploymentGroupName must both be names' };
  }
  const hooks: Record<string, string | undefined> = {};
  for (const key of ['BeforeAllowTrafficHook', 'AfterAllowTrafficHook'] as const) {
    const value = policy[key];
    if (value === undefined || value === null) continue;
    const name = nonEmptyString(value);
    if (name === undefined) return { unusable: `its ${key} must be a function name` };
    hooks[key] = name;
  }
  return {
    applicationName,
    deploymentGroupName,
    ...(hooks['BeforeAllowTrafficHook'] !== undefined && {
      beforeAllowTrafficHook: hooks['BeforeAllowTrafficHook'],
    }),
    ...(hooks['AfterAllowTrafficHook'] !== undefined && {
      afterAllowTrafficHook: hooks['AfterAllowTrafficHook'],
    }),
  };
}

/** A Lambda version number as CodeDeploy takes it ("a valid positive integer"). */
function versionText(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[1-9][0-9]*$/.test(text) ? text : undefined;
}

/** The function name inside an alias or function ARN, else the value itself. */
export function functionNameOf(physicalId: string, functionName: unknown): string | undefined {
  // arn:<partition>:lambda:<region>:<account>:function:<name>:<alias>
  const fromArn = (arn: string): string | undefined => {
    const parts = arn.split(':');
    return parts.length >= 7 && parts[0] === 'arn' && parts[5] === 'function'
      ? nonEmptyString(parts[6])
      : undefined;
  };
  const fromId = fromArn(physicalId);
  if (fromId !== undefined) return fromId;
  const declared = nonEmptyString(functionName);
  if (declared === undefined) return undefined;
  if (declared.startsWith('arn:')) return fromArn(declared);
  // A partial ARN (`<account>:function:<name>`), or `<name>:<qualifier>`.
  const parts = declared.split(':');
  return parts[1] === 'function' ? nonEmptyString(parts[2]) : nonEmptyString(parts[0]);
}

/**
 * The AppSpec of the deployment: CodeDeploy's Lambda shape, one
 * `AWS::Lambda::Function` resource with `Name` / `Alias` / `CurrentVersion` /
 * `TargetVersion`, and the hooks the policy names.
 */
export function aliasAppSpec(
  resourceName: string,
  functionName: string,
  aliasName: string,
  currentVersion: string,
  targetVersion: string,
  policy: AliasDeploymentPolicy
): string {
  const hooks: Array<Record<string, string>> = [];
  if (policy.beforeAllowTrafficHook !== undefined) {
    hooks.push({ BeforeAllowTraffic: policy.beforeAllowTrafficHook });
  }
  if (policy.afterAllowTrafficHook !== undefined) {
    hooks.push({ AfterAllowTraffic: policy.afterAllowTrafficHook });
  }
  // `version: 0.0` as the AppSpec reference spells it: `JSON.stringify`
  // would write the number as `0`. `0.0` is a valid JSON number.
  const body = JSON.stringify({
    Resources: [
      {
        [resourceName]: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Name: functionName,
            Alias: aliasName,
            CurrentVersion: currentVersion,
            TargetVersion: targetVersion,
          },
        },
      },
    ],
    ...(hooks.length > 0 && { Hooks: hooks }),
  });
  return `{"version":0.0,${body.slice(1)}`;
}

/**
 * The deployment wait's limit: inside the resource timeout (`--resource-timeout`,
 * 30 minutes by default) by a margin of two minutes or a tenth of the timeout,
 * whichever is less, less what the update already spent, so the wait ends (and
 * stops its deployment) before the engine's own deadline abandons it. The same
 * rule as the Auto Scaling instance refresh.
 */
export function deploymentWaitCapMs(resourceType: string, elapsedMs = 0): number {
  const { timeoutMs, marginMs } = deploymentTimeouts(resourceType);
  return Math.max(0, timeoutMs - marginMs - Math.max(0, elapsedMs));
}

/**
 * The limit of the wait for the deployment group to settle after a deployment
 * cdkd started failed or was stopped (CodeDeploy's rollback is a deployment of
 * its own): what is left of {@link deploymentWaitCapMs}, but never less than
 * the margin minus 30 seconds, which the deployment wait leaves free for it.
 * So a deployment that ran out the clock still gets its rollback waited for
 * inside the resource timeout, and the deploy's own rollback does not meet it.
 */
export function settleWaitCapMs(resourceType: string, elapsedMs = 0): number {
  const { marginMs } = deploymentTimeouts(resourceType);
  return Math.max(deploymentWaitCapMs(resourceType, elapsedMs), marginMs - 30_000, 0);
}

function deploymentTimeouts(resourceType: string): { timeoutMs: number; marginMs: number } {
  const timeoutMs = resolvedResourceTimeoutMs(resourceType) ?? 30 * 60 * 1000;
  return { timeoutMs, marginMs: Math.min(2 * 60_000, Math.floor(timeoutMs / 10)) };
}

export interface AliasShiftInput {
  logicalId: string;
  physicalId: string;
  resourceType: string;
  properties: Readonly<Record<string, unknown>>;
  previousProperties: Readonly<Record<string, unknown>>;
  context: UpdateContext | undefined;
  mask: MaskerFn;
}

/**
 * `'shifted'`: CodeDeploy moves (or already moved) the alias's
 * `FunctionVersion`, so the Cloud Control patch must leave it alone.
 * `'none'`: nothing applies; the update proceeds as without the policy.
 */
export type AliasShiftOutcome = 'shifted' | 'none';

/**
 * Shift the alias through CodeDeploy when `--update-policy` handed this update
 * a `CodeDeployLambdaAliasUpdate` and its `FunctionVersion` changes; see the
 * module comment. Throws (marked non-retryable, so `withRetry` never re-runs
 * the update into the running deployment) when the deployment cannot start,
 * ends in anything but `Succeeded`, or outlives {@link deploymentWaitCapMs}
 * (stopped first). A Ctrl-C stops it and throws the interrupt.
 */
export async function shiftAliasThroughCodeDeploy(
  host: CodeDeployAliasHost,
  input: AliasShiftInput,
  /** Internal: the revert already stopped its own deployment once, at the first call's start. */
  again?: { startedAt: number }
): Promise<AliasShiftOutcome> {
  const stoppedOwn = again !== undefined;
  const { logicalId, physicalId, resourceType, properties, previousProperties, context, mask } =
    input;
  if (resourceType !== 'AWS::Lambda::Alias') return 'none';
  const read = readAliasDeploymentPolicy(context?.updatePolicy);
  if (read === undefined) return 'none';
  const desiredVersion = properties['FunctionVersion'];
  if (String(desiredVersion) === String(previousProperties['FunctionVersion'])) return 'none';

  const replaying = context?.replayingState === true;
  const fail = (text: string, cause?: unknown): ProvisioningError =>
    markNonRetryable(
      new ProvisioningError(
        mask(`Failed to update Lambda alias ${logicalId}: ${text}`),
        resourceType,
        logicalId,
        physicalId,
        cause instanceof Error ? cause : undefined
      )
    );
  // Nothing has been sent yet: a refusal here changed nothing, unless an
  // earlier call of this process (an earlier attempt of this update, or the
  // forward deploy a revert undoes) started a deployment on this alias. The
  // mark is proof only when none did, since it drops the attempted bag.
  const earlierDeployment = host.startedAliasDeployments.has(physicalId);
  const refuse = (text: string, cause?: unknown): ProvisioningError =>
    earlierDeployment ? fail(text, cause) : markRefusedBeforeApplying(fail(text, cause));
  // A revert's bag is a state record: a refusal would leave the alias
  // un-rollbackable, so it takes the direct update with a warning instead.
  const unusable = (text: string): AliasShiftOutcome => {
    if (!replaying) {
      throw refuse(
        `UpdatePolicy ${CODEDEPLOY_ALIAS_POLICY_KEY} cannot be applied: ${text}. Fix the template, or deploy without --update-policy to switch the alias directly.`
      );
    }
    host.logger.warn(
      mask(
        `${logicalId}: UpdatePolicy ${CODEDEPLOY_ALIAS_POLICY_KEY} cannot be applied on the rollback (${text}); the alias is switched directly.`
      )
    );
    return 'none';
  };

  if ('unusable' in read) return unusable(read.unusable);
  const policy = read;
  const targetVersion = versionText(desiredVersion);
  if (targetVersion === undefined) {
    return unusable('the new FunctionVersion is not a published version number');
  }
  const aliasName = nonEmptyString(properties['Name']);
  const functionName = functionNameOf(physicalId, properties['FunctionName']);
  if (aliasName === undefined || functionName === undefined) {
    return unusable('the alias Name or FunctionName could not be read');
  }

  const now = clockOf(host);
  const startedAt = again?.startedAt ?? now();
  const clients = await host.codeDeployAliasClients();
  try {
    // The version the alias serves now, and whether its traffic is split.
    // Read from Lambda rather than the record, so an alias already moved (an
    // earlier attempt of this update, or CodeDeploy's rollback of a failed
    // one) is not shifted again. Unreadable, it is not guessed from the record:
    // after CodeDeploy rolled a failed shift back, the record names the
    // version the alias no longer serves.
    let liveError: unknown;
    const live = await liveAliasState(clients, functionName, aliasName, (error) => {
      liveError = error;
      host.logger.debug(
        mask(
          `GetAlias for ${logicalId} failed: ${maskCallerIdentity(describeAwsFailure(error).detail)}`
        )
      );
    });
    // A throttle or a blip: nothing has been sent, so the update's own retry
    // (`withRetry`) may run it again. Not marked non-retryable.
    if (
      live === undefined &&
      liveError instanceof Error &&
      isRetryableTransientError(liveError, liveError.message)
    ) {
      // The classifiers read the cause's text, which the message withholds
      // (markRedactedCause). Not refused-before-applying: an earlier attempt of
      // this update may have shifted the alias before its patch failed.
      throw markRedactedCause(
        new ProvisioningError(
          mask(`Failed to update Lambda alias ${logicalId}: lambda:GetAlias failed transiently.`),
          resourceType,
          logicalId,
          physicalId,
          liveError
        )
      );
    }

    // One deployment runs per deployment group: refuse before anything is
    // sent while another is running (an operator's, or one an interrupted
    // deploy left). A revert stops only a deployment this process started.
    const active = await activeDeployments(clients, policy, mask, host, logicalId);
    if (active === UNREADABLE) {
      throw refuse(
        `cdkd could not list the running deployments of deployment group ${policy.deploymentGroupName}, so it cannot tell whether one is running. Grant codedeploy:ListDeployments, then ${replaying ? 'run the rollback again' : 'deploy again'}.`
      );
    }
    if (active.length > 0) {
      const ours = host.startedAliasDeployments.get(physicalId);
      if (stoppedOwn || !replaying || ours === undefined || !active.includes(ours)) {
        throw refuse(
          `deployment ${active.join(', ')} is already running on deployment group ${policy.deploymentGroupName}, and CodeDeploy runs one at a time. Wait for it to finish or stop it, then ${replaying ? 'run the rollback again' : 'deploy again'}.`
        );
      }
      host.logger.info(
        mask(
          `${logicalId}: stopping CodeDeploy deployment ${ours}, still running from the failed deploy, before reverting the alias.`
        )
      );
      await stopDeployment(clients, ours, host, logicalId, mask);
      await settleGroup(
        clients,
        policy,
        host,
        logicalId,
        mask,
        settleWaitCapMs(resourceType, now() - startedAt)
      );
      return await shiftAliasThroughCodeDeploy(host, input, { startedAt });
    }

    // After the running-deployment check, which needs no alias read: a revert
    // that cannot read the alias still stops its own running deployment first.
    if (live === undefined || live.version === undefined) {
      return unusable(
        "the alias's current version could not be read (lambda:GetAlias), so the deployment's CurrentVersion is unknown"
      );
    }

    // Only once no deployment runs: while one shifts, the alias still names
    // its original version (the new one takes traffic through its routing
    // weights), which would read as already moved.
    //
    // A split with no deployment running is what a deployment that ended
    // Failed or Stopped mid-shift leaves on a group without automatic
    // rollback (or one set by hand). A revert clears it when the state it
    // restores declares no RoutingConfig: the revert puts the alias back, and
    // the weighted version may be the one the rollback deletes next.
    let weighted = live.weighted;
    if (weighted && replaying && properties['RoutingConfig'] == null) {
      await clearRoutingConfig(clients, functionName, aliasName, fail);
      host.logger.info(
        mask(`${logicalId}: cleared the traffic split a stopped deployment left on the alias.`)
      );
      weighted = false;
    }
    const currentVersion = live.version;
    if (currentVersion === targetVersion) {
      host.logger.debug(
        mask(`${logicalId}: the alias already serves version ${targetVersion}; no deployment`)
      );
      // A split the restored or desired state declares is the template's own.
      if (weighted && properties['RoutingConfig'] == null) {
        host.logger.warn(
          mask(
            `${logicalId}: the alias serves version ${targetVersion} but still splits traffic to other versions (RoutingConfig) with no CodeDeploy deployment running; cdkd leaves the split as it is.`
          )
        );
      }
      return 'shifted';
    }

    // A deployment configuration that cannot finish inside the wait is
    // refused before it starts, not stopped half-way at the cap.
    // The traffic time alone undercounts: the deployment's start-up and its
    // hooks (a BeforeAllowTraffic hook runs first) come on top, so a
    // configuration within SHIFT_OVERHEAD_RESERVE_MS of the cap would still
    // be stopped at it.
    const totalMs = await trafficShiftMs(clients, policy, host, logicalId, mask);
    const capAtStart = deploymentWaitCapMs(resourceType, now() - startedAt);
    if (totalMs !== undefined && totalMs + SHIFT_OVERHEAD_RESERVE_MS >= capAtStart) {
      const minutes = Math.ceil((totalMs + SHIFT_OVERHEAD_RESERVE_MS) / 60_000) + 5;
      const tooLong = `the deployment group's configuration shifts traffic over ${formatDuration(totalMs)}, which with ${formatDuration(SHIFT_OVERHEAD_RESERVE_MS)} for the deployment's start-up and hooks does not fit the ${formatDuration(capAtStart)} the resource timeout leaves for it`;
      if (!replaying) {
        throw refuse(
          `UpdatePolicy ${CODEDEPLOY_ALIAS_POLICY_KEY}: ${tooLong}. Raise the timeout with --resource-timeout ${resourceType}=${minutes}m, or deploy without --update-policy to switch the alias directly.`
        );
      }
      host.logger.warn(
        mask(
          `${logicalId}: on the rollback, ${tooLong}; the alias is switched directly, without the gradual shift and with its hooks skipped.`
        )
      );
      return 'none';
    }

    const content = aliasAppSpec(
      logicalId,
      functionName,
      aliasName,
      currentVersion,
      targetVersion,
      policy
    );
    let deploymentId: string;
    try {
      deploymentId = await createDeployment(clients, host, policy, content);
    } catch (error) {
      // AWS's text can quote the caller's principal (an AccessDenied), and
      // this message is persisted in the deployment events.
      throw refuse(
        `CodeDeploy did not start the deployment on deployment group ${policy.deploymentGroupName}: ${maskCallerIdentity(describeAwsFailure(error).detail)}`,
        error
      );
    }
    host.startedAliasDeployments.set(physicalId, deploymentId);
    host.logger.info(
      mask(
        `${logicalId}: UpdatePolicy ${CODEDEPLOY_ALIAS_POLICY_KEY}: CodeDeploy deployment ${deploymentId} started (version ${currentVersion} -> ${targetVersion}, deployment group ${policy.deploymentGroupName}).`
      )
    );
    // Waited for under `--no-wait` too: the alias serves the previous version
    // until the shift ends, and the same deploy can delete that version (a CDK
    // `currentVersion` without a RETAIN removal policy is a new logical id on
    // every code change), which would cut off the traffic still routed to it.
    const capMs = deploymentWaitCapMs(resourceType, now() - startedAt);
    const ended = await waitForDeployment(
      clients,
      host,
      deploymentId,
      capMs,
      logicalId,
      mask,
      policy
    );
    if (ended.status === 'Succeeded') {
      host.logger.info(mask(`${logicalId}: CodeDeploy deployment ${deploymentId} succeeded.`));
      return 'shifted';
    }
    if (ended.status === 'timeout') {
      const stopped = await stopDeployment(clients, deploymentId, host, logicalId, mask);
      // CodeDeploy's rollback of the stopped deployment runs as a deployment
      // of its own; the deploy's rollback would otherwise meet it.
      if (stopped) {
        await settleGroup(
          clients,
          policy,
          host,
          logicalId,
          mask,
          settleWaitCapMs(resourceType, now() - startedAt)
        );
      }
      throw fail(
        `CodeDeploy deployment ${deploymentId} did not finish within ${formatDuration(capMs)} and ${stopped ? 'was stopped' : 'could not be confirmed stopped (check aws deploy get-deployment)'}. Raise the limit with --resource-timeout ${resourceType}=<duration>.`
      );
    }
    // Failed / Stopped: CodeDeploy's rollback (a deployment of its own)
    // shifts the traffic back; wait for the group to settle so the alias is
    // read where it ends up, and so the deploy's own rollback does not meet
    // a running deployment.
    await settleGroup(
      clients,
      policy,
      host,
      logicalId,
      mask,
      settleWaitCapMs(resourceType, now() - startedAt)
    );
    const after = await liveAliasState(clients, functionName, aliasName);
    // CodeDeploy's error text quotes ARNs (the account id), and this message
    // is persisted in the deployment events.
    throw fail(
      `CodeDeploy deployment ${deploymentId} ended ${ended.status}${ended.reason !== undefined ? `: ${maskCallerIdentity(ended.reason)}` : ''}. ` +
        (after === undefined
          ? 'cdkd could not read the alias afterwards.'
          : `The alias serves version ${after.version ?? 'unknown'}${after.weighted ? ', with traffic still split across versions' : ''}.`)
    );
  } finally {
    clients.destroy();
  }
}

const UNREADABLE = Symbol('unreadable');

/**
 * How long the deployment group's configuration takes to move all traffic
 * (`TimeBasedCanary`: one interval; `TimeBasedLinear`: one interval per step
 * after the first; `AllAtOnce`: none), or `undefined` when it cannot be read
 * (the wait's cap still bounds the deployment). Hooks add to this.
 */
async function trafficShiftMs(
  clients: CodeDeployAliasClients,
  policy: AliasDeploymentPolicy,
  host: CodeDeployAliasHost,
  logicalId: string,
  mask: MaskerFn
): Promise<number | undefined> {
  try {
    const group = (await clients.codeDeploy.send(
      new clients.commands.GetDeploymentGroup({
        applicationName: policy.applicationName,
        deploymentGroupName: policy.deploymentGroupName,
      })
    )) as { deploymentGroupInfo?: { deploymentConfigName?: unknown } };
    const configName = nonEmptyString(group.deploymentGroupInfo?.deploymentConfigName);
    if (configName === undefined) return undefined;
    const config = (await clients.codeDeploy.send(
      new clients.commands.GetDeploymentConfig({ deploymentConfigName: configName })
    )) as { deploymentConfigInfo?: { trafficRoutingConfig?: Record<string, unknown> } };
    return trafficRoutingMs(config.deploymentConfigInfo?.trafficRoutingConfig);
  } catch (error) {
    host.logger.warn(
      mask(
        `${logicalId}: cdkd could not read deployment group ${policy.deploymentGroupName}'s configuration, so it does not check the deployment fits the resource timeout: ${maskCallerIdentity(describeAwsFailure(error).detail)}`
      )
    );
    return undefined;
  }
}

/** {@link trafficShiftMs}'s reading of a `TrafficRoutingConfig`. */
export function trafficRoutingMs(config: Record<string, unknown> | undefined): number | undefined {
  if (!isObject(config)) return undefined;
  const positive = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  if (config['type'] === 'AllAtOnce') return 0;
  if (config['type'] === 'TimeBasedCanary') {
    const canary = config['timeBasedCanary'] as Record<string, unknown> | undefined;
    const interval = positive(canary?.['canaryInterval']);
    return interval === undefined ? undefined : interval * 60_000;
  }
  if (config['type'] === 'TimeBasedLinear') {
    const linear = config['timeBasedLinear'] as Record<string, unknown> | undefined;
    const interval = positive(linear?.['linearInterval']);
    const percentage = positive(linear?.['linearPercentage']);
    if (interval === undefined || percentage === undefined) return undefined;
    return (Math.ceil(100 / percentage) - 1) * interval * 60_000;
  }
  return undefined;
}

/** Remove the alias's routing weights (`UpdateAlias` with an empty `AdditionalVersionWeights`). */
async function clearRoutingConfig(
  clients: CodeDeployAliasClients,
  functionName: string,
  aliasName: string,
  // Not refused-before-applying: a failure after the request went out (a
  // timeout) may have cleared it.
  fail: (text: string, cause?: unknown) => ProvisioningError
): Promise<void> {
  try {
    await clients.lambda.send(
      new clients.commands.UpdateAlias({
        FunctionName: functionName,
        Name: aliasName,
        RoutingConfig: { AdditionalVersionWeights: {} },
      })
    );
  } catch (error) {
    throw fail(
      `the alias still splits traffic from a stopped CodeDeploy deployment, and clearing it failed: ${maskCallerIdentity(describeAwsFailure(error).detail)}`,
      error
    );
  }
}

/** The group's running deployment ids, or `UNREADABLE` when the list failed. */
async function activeDeployments(
  clients: CodeDeployAliasClients,
  policy: AliasDeploymentPolicy,
  mask: MaskerFn,
  host: CodeDeployAliasHost,
  logicalId: string
): Promise<string[] | typeof UNREADABLE> {
  try {
    const ids: string[] = [];
    let nextToken: string | undefined;
    // Every page: an active deployment need not be on the first. Bounded, so
    // a service that keeps answering with a token cannot hold the deploy.
    for (let page = 0; page < 20; page++) {
      const response = (await clients.codeDeploy.send(
        new clients.commands.ListDeployments({
          applicationName: policy.applicationName,
          deploymentGroupName: policy.deploymentGroupName,
          includeOnlyStatuses: ACTIVE_DEPLOYMENT_STATUSES,
          ...(nextToken !== undefined && { nextToken }),
        })
      )) as { deployments?: unknown; nextToken?: unknown };
      if (Array.isArray(response.deployments)) {
        ids.push(...response.deployments.filter((id): id is string => typeof id === 'string'));
      }
      nextToken = nonEmptyString(response.nextToken);
      if (nextToken === undefined) return ids;
    }
    return UNREADABLE;
  } catch (error) {
    host.logger.debug(
      mask(
        `ListDeployments for ${logicalId} failed: ${maskCallerIdentity(describeAwsFailure(error).detail)}`
      )
    );
    return UNREADABLE;
  }
}

const CREATE_ATTEMPTS = 3;

/** `CreateDeployment`, a throttle retried here (the step's errors are not retried by `withRetry`). */
async function createDeployment(
  clients: CodeDeployAliasClients,
  host: CodeDeployAliasHost,
  policy: AliasDeploymentPolicy,
  content: string
): Promise<string> {
  const sha256 = createHash('sha256').update(content).digest('hex');
  for (let attempt = 1; ; attempt++) {
    try {
      const response = (await clients.codeDeploy.send(
        new clients.commands.CreateDeployment({
          applicationName: policy.applicationName,
          deploymentGroupName: policy.deploymentGroupName,
          revision: { revisionType: 'AppSpecContent', appSpecContent: { content, sha256 } },
        })
      )) as { deploymentId?: unknown };
      const id = nonEmptyString(response.deploymentId);
      if (id === undefined) throw new Error('CreateDeployment returned no deploymentId');
      return id;
    } catch (error) {
      const transient = error instanceof Error && isRetryableTransientError(error, error.message);
      if (!transient || attempt >= CREATE_ATTEMPTS) throw error;
      await host.sleep(2_000 * attempt);
    }
  }
}

/** The deployment's status and error text, or `undefined` when it could not be read. */
async function readDeployment(
  clients: CodeDeployAliasClients,
  deploymentId: string
): Promise<{ status: string | undefined; reason: string | undefined } | undefined> {
  try {
    const response = (await clients.codeDeploy.send(
      new clients.commands.GetDeployment({ deploymentId })
    )) as {
      deploymentInfo?: { status?: unknown; errorInformation?: { message?: unknown } };
    };
    const info = response.deploymentInfo;
    return {
      status: typeof info?.status === 'string' ? info.status : undefined,
      reason: nonEmptyString(info?.errorInformation?.message),
    };
  } catch {
    return undefined;
  }
}

/** Poll until the deployment ends, the cap passes, or Ctrl-C (which stops it). */
async function waitForDeployment(
  clients: CodeDeployAliasClients,
  host: CodeDeployAliasHost,
  deploymentId: string,
  capMs: number,
  logicalId: string,
  mask: MaskerFn,
  policy: AliasDeploymentPolicy
): Promise<{ status: string; reason?: string | undefined }> {
  // A wall-clock deadline, not a poll count: each poll's own latency would
  // otherwise stretch the wait past the resource timeout's margin.
  const now = clockOf(host);
  const deadline = now() + capMs;
  const watch = startInterruptWatch(`The CodeDeploy deployment of Lambda alias ${logicalId}`);
  try {
    do {
      for (
        let slept = 0;
        slept < CODEDEPLOY_POLL_MS && (slept === 0 || now() < deadline);
        slept += 1_000
      ) {
        if (watch.isInterrupted()) {
          await stopOnInterrupt(clients, deploymentId, host, logicalId, mask, policy);
          throw watch.onInterrupted();
        }
        await host.sleep(1_000);
      }
      if (watch.isInterrupted()) {
        await stopOnInterrupt(clients, deploymentId, host, logicalId, mask, policy);
        throw watch.onInterrupted();
      }
      const read = await readDeployment(clients, deploymentId);
      if (read === undefined) {
        // A throttle or a blip is not an outcome: keep waiting.
        host.logger.debug(mask(`GetDeployment ${deploymentId} for ${logicalId} failed`));
        continue;
      }
      if (read.status === 'Succeeded' || read.status === 'Failed' || read.status === 'Stopped') {
        return { status: read.status, reason: read.reason };
      }
    } while (now() < deadline);
  } finally {
    watch.dispose();
  }
  return { status: 'timeout' };
}

/** How long a Ctrl-C waits for CodeDeploy's rollback of the stopped deployment. */
export const INTERRUPT_SETTLE_MS = 60_000;

/**
 * Ctrl-C: stop the deployment, then wait (bounded, {@link INTERRUPT_SETTLE_MS})
 * for CodeDeploy's rollback of it, so a `cdkd rollback` run right after does
 * not meet that rollback deployment and refuse. The interrupt is latched, so
 * this settle does not read it.
 */
async function stopOnInterrupt(
  clients: CodeDeployAliasClients,
  deploymentId: string,
  host: CodeDeployAliasHost,
  logicalId: string,
  mask: MaskerFn,
  policy: AliasDeploymentPolicy
): Promise<void> {
  if (await stopDeployment(clients, deploymentId, host, logicalId, mask)) {
    host.logger.info(
      mask(
        `${logicalId}: stopped CodeDeploy deployment ${deploymentId}; waiting up to ${INTERRUPT_SETTLE_MS / 1_000} seconds for its rollback.`
      )
    );
    await settleGroup(clients, policy, host, logicalId, mask, INTERRUPT_SETTLE_MS, false);
  }
}

/**
 * `StopDeployment` with CodeDeploy's rollback on, so the traffic shifts back.
 * `true` when CodeDeploy accepted it, or the deployment had already ended.
 */
async function stopDeployment(
  clients: CodeDeployAliasClients,
  deploymentId: string,
  host: CodeDeployAliasHost,
  logicalId: string,
  mask: MaskerFn
): Promise<boolean> {
  try {
    await clients.codeDeploy.send(
      new clients.commands.StopDeployment({ deploymentId, autoRollbackEnabled: true })
    );
    return true;
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'DeploymentAlreadyCompletedException') return true;
    host.logger.warn(
      mask(
        `${logicalId}: StopDeployment ${deploymentId} failed: ${maskCallerIdentity(describeAwsFailure(error).detail)}`
      )
    );
    return false;
  }
}

/**
 * Wait (bounded) until the deployment group runs no deployment: CodeDeploy's
 * rollback of a failed or stopped deployment is a deployment of its own.
 */
async function settleGroup(
  clients: CodeDeployAliasClients,
  policy: AliasDeploymentPolicy,
  host: CodeDeployAliasHost,
  logicalId: string,
  mask: MaskerFn,
  capMs: number,
  /** `false` after a Ctrl-C already stopped the deployment (the latch stays set). */
  honorInterrupt = true
): Promise<void> {
  const now = clockOf(host);
  const deadline = now() + capMs;
  const watch = startInterruptWatch(`The CodeDeploy rollback wait of Lambda alias ${logicalId}`);
  try {
    for (;;) {
      if (honorInterrupt && watch.isInterrupted()) throw watch.onInterrupted();
      const active = await activeDeployments(clients, policy, mask, host, logicalId);
      if (active !== UNREADABLE && active.length === 0) return;
      // No sleep the deadline cannot use.
      if (now() + CODEDEPLOY_POLL_MS > deadline) break;
      await host.sleep(CODEDEPLOY_POLL_MS);
    }
  } finally {
    watch.dispose();
  }
  host.logger.warn(
    mask(
      `${logicalId}: deployment group ${policy.deploymentGroupName} still runs a deployment; continuing without waiting for it.`
    )
  );
}

async function liveAliasState(
  clients: CodeDeployAliasClients,
  functionName: string,
  aliasName: string,
  onError?: (error: unknown) => void
): Promise<{ version: string | undefined; weighted: boolean } | undefined> {
  try {
    const alias = (await clients.lambda.send(
      new clients.commands.GetAlias({ FunctionName: functionName, Name: aliasName })
    )) as { FunctionVersion?: unknown; RoutingConfig?: { AdditionalVersionWeights?: unknown } };
    const weights = alias.RoutingConfig?.AdditionalVersionWeights;
    return {
      version: versionText(alias.FunctionVersion),
      weighted: isObject(weights) && Object.keys(weights).length > 0,
    };
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

function formatDuration(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1_000)} seconds`;
}

/**
 * Build the clients in `region` (the Cloud Control client's), refusing when it
 * cannot be resolved, as the other SDK calls this provider makes do.
 */
export async function buildCodeDeployAliasClients(
  regionOf: () => Promise<string | undefined>
): Promise<CodeDeployAliasClients> {
  let region: string | undefined;
  try {
    region = canonicalizeRegion((await regionOf())?.trim());
  } catch {
    region = undefined;
  }
  if (region === undefined || region === '') {
    throw markRefusedBeforeApplying(
      markNonRetryable(
        new Error(
          "cdkd could not resolve the Cloud Control client's region, so it cannot address the CodeDeploy deployment. Re-run with --region set to the stack's region."
        )
      )
    );
  }
  const {
    CodeDeployClient,
    CreateDeploymentCommand,
    GetDeploymentCommand,
    GetDeploymentConfigCommand,
    GetDeploymentGroupCommand,
    ListDeploymentsCommand,
    StopDeploymentCommand,
  } = await import('@aws-sdk/client-codedeploy');
  const { LambdaClient, GetAliasCommand, UpdateAliasCommand } =
    await import('@aws-sdk/client-lambda');
  const codeDeploy = new CodeDeployClient({ ...ambientClientDefaults(), region });
  const lambda = new LambdaClient({ ...ambientClientDefaults(), region });
  return {
    codeDeploy: codeDeploy as unknown as SendClient,
    lambda: lambda as unknown as SendClient,
    commands: {
      GetAlias: GetAliasCommand as never,
      UpdateAlias: UpdateAliasCommand as never,
      GetDeploymentGroup: GetDeploymentGroupCommand as never,
      GetDeploymentConfig: GetDeploymentConfigCommand as never,
      ListDeployments: ListDeploymentsCommand as never,
      CreateDeployment: CreateDeploymentCommand as never,
      GetDeployment: GetDeploymentCommand as never,
      StopDeployment: StopDeploymentCommand as never,
    },
    destroy() {
      codeDeploy.destroy();
      lambda.destroy();
    },
  };
}
