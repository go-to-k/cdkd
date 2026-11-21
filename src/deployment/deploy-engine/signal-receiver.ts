/**
 * go-to-k/cdkd#6705: the persistent CloudFormation "signal receiver" that lets
 * a cdkd stack honor `CreationPolicy` signals and serve `cfn-init` metadata.
 * Design and measurements: docs/design/6705-cloudformation-signal-receiver.md.
 *
 * `cfn-signal --resource` and `cfn-init` call CloudFormation's
 * `SignalResource` / `DescribeStackResource`, which only a CloudFormation stack
 * answers, and CDK grants the instance role those calls on `AWS::StackId`
 * alone. So a stack declaring such a resource keeps ONE receiver stack, named
 * exactly as the cdkd stack, for its whole lifetime, and cdkd resolves
 * `AWS::StackId` to the receiver's real ARN: CDK's grant then names it.
 *
 * Each deploy arms the resources it creates (or replaces) with a fresh
 * `WaitCondition` under the same logical id, in ONE `UpdateStack` before the
 * DAG runs (the stack stays `UPDATE_IN_PROGRESS` until they complete, so no
 * later update is possible mid-deploy), and keeps every other `cfn-init`
 * resource's metadata on a `WaitConditionHandle`.
 *
 * A stack holding the name that lacks the receiver tag AND description is
 * never touched; every refusal falls back to creating without waiting.
 */

import {
  CancelUpdateStackCommand,
  ContinueUpdateRollbackCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  type CloudFormationClient,
} from '@aws-sdk/client-cloudformation';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import type { CloudFormationTemplate } from '../../types/resource.js';

/** The tag that marks a stack as a cdkd signal receiver. */
export const RECEIVER_TAG_KEY = 'cdkd:signal-receiver';
/** The receiver's fixed description, checked together with the tag. */
export const RECEIVER_DESCRIPTION =
  'cdkd signal receiver: answers cfn-signal / cfn-init for the cdkd stack of the same name (do not edit)';
const ANCHOR_ID = 'CdkdSignalReceiverAnchor';

/** CloudFormation's ceiling for a `ResourceSignal.Timeout`. */
const MAX_SIGNAL_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** CloudFormation's default `ResourceSignal.Timeout`. */
const DEFAULT_SIGNAL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
/** CloudFormation's limit for an inline `TemplateBody`. */
const MAX_TEMPLATE_BODY_BYTES = 51_200;
/** How long a deploy waits for the receiver to settle or become ready. */
const SETTLE_WAIT_MS = 10 * 60 * 1000;

export interface SignalCandidate {
  count: number;
  timeoutMs: number;
  hasInitMetadata: boolean;
}

export interface ReceiverLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** An ISO 8601 duration as CloudFormation spells it (`PT15M`), in ms. */
export function isoDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value.trim());
  if (match === null || (match[1] ?? match[2] ?? match[3]) === undefined) return undefined;
  return (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;
}

/**
 * What a template resource asks the receiver for: a `CreationPolicy`
 * `ResourceSignal` (count + timeout, `count: 0` when it declares none) and/or
 * `AWS::CloudFormation::Init` metadata. `undefined` when neither.
 */
export function signalCandidateOf(resource: unknown): SignalCandidate | undefined {
  if (resource === null || typeof resource !== 'object') return undefined;
  const r = resource as { CreationPolicy?: unknown; Metadata?: unknown };
  const policy =
    r.CreationPolicy !== null && typeof r.CreationPolicy === 'object'
      ? (r.CreationPolicy as Record<string, unknown>)['ResourceSignal']
      : undefined;
  const hasInitMetadata =
    r.Metadata !== null &&
    typeof r.Metadata === 'object' &&
    Object.hasOwn(r.Metadata, 'AWS::CloudFormation::Init');
  const hasPolicy = policy !== undefined && policy !== null && typeof policy === 'object';
  if (!hasPolicy && !hasInitMetadata) return undefined;
  if (!hasPolicy) return { count: 0, timeoutMs: 0, hasInitMetadata };
  const p = policy as Record<string, unknown>;
  const rawCount = p['Count'];
  const count =
    rawCount === undefined
      ? 1
      : typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount > 0
        ? rawCount
        : typeof rawCount === 'string' && /^\d+$/.test(rawCount.trim()) && Number(rawCount) > 0
          ? Number(rawCount.trim())
          : 1;
  const timeoutMs = Math.min(
    isoDurationMs(p['Timeout']) ?? DEFAULT_SIGNAL_TIMEOUT_MS,
    MAX_SIGNAL_TIMEOUT_MS
  );
  return { count, timeoutMs, hasInitMetadata };
}

/** Every template resource asking the receiver for something. */
export function signalCandidatesOf(template: CloudFormationTemplate): Map<string, SignalCandidate> {
  return signalPlanOf(template).candidates;
}

/**
 * The receiver's candidates, and the resources it cannot serve because their
 * user data calls `cfn-init` / `cfn-signal` WITHOUT credentials (CDK's
 * default, `initOptions.includeRole: false`). CloudFormation answers such an
 * unsigned call only from an instance that is a resource of its own stack, so
 * no receiver can: those keep the warn-and-proceed behavior. A resource whose
 * user data holds no `cfn-*` call (signals sent some other way, e.g. a signed
 * `aws cloudformation signal-resource`) is served; one with only cfn-init
 * metadata is served only when a signed `cfn-init` reads it.
 */
export function signalPlanOf(template: CloudFormationTemplate): {
  candidates: Map<string, SignalCandidate>;
  unsigned: string[];
} {
  const candidates = new Map<string, SignalCandidate>();
  const unsigned: string[] = [];
  const resources = template.Resources ?? {};
  for (const [id, resource] of Object.entries(resources)) {
    const candidate = signalCandidateOf(resource);
    if (candidate === undefined) continue;
    const calls = bootstrapCallsOf(resources, id);
    if (calls === 'unsigned') {
      unsigned.push(id);
      continue;
    }
    if (candidate.count === 0 && calls !== 'signed') continue;
    candidates.set(id, candidate);
  }
  return { candidates, unsigned };
}

// A command word (`/opt/aws/bin/cfn-init -v`), not a file name (`cfn-init.log`).
const BOOTSTRAP_CALL = /(?<=^|[\s/"'(;&|]|\\n)cfn-(?:init|signal)(?=\s)/g;
const CREDENTIAL_FLAG = /\s(?:--role|--access-key|--credential-file|-f)[\s=]/;

/**
 * How `logicalId`'s user data (its own, or its launch template's or launch
 * configuration's) calls `cfn-init` / `cfn-signal`: `signed` when every call
 * passes credentials (`--role`, `--access-key`, `--credential-file`),
 * `unsigned` when any does not, `none` when it calls neither.
 */
export function bootstrapCallsOf(
  resources: Record<string, unknown>,
  logicalId: string
): 'signed' | 'unsigned' | 'none' {
  const text = userDataTextOf(resources, logicalId);
  if (text === undefined) return 'none';
  let found = false;
  for (const match of text.matchAll(BOOTSTRAP_CALL)) {
    found = true;
    const rest = text.slice(match.index + match[0].length);
    const end = rest.search(/\\n|\n|;|&&|\|\|/);
    const call = ` ${end === -1 ? rest : rest.slice(0, end)} `;
    if (!CREDENTIAL_FLAG.test(call)) return 'unsigned';
  }
  return found ? 'signed' : 'none';
}

function propertiesOf(
  resources: Record<string, unknown>,
  id: unknown
): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const resource = resources[id];
  if (resource === null || typeof resource !== 'object') return undefined;
  const props = (resource as { Properties?: unknown }).Properties;
  return props !== null && typeof props === 'object'
    ? (props as Record<string, unknown>)
    : undefined;
}

function refOf(value: unknown): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)['Ref']
    : undefined;
}

/** The user data's template text (a literal base64 string decoded), or `undefined`. */
function userDataTextOf(resources: Record<string, unknown>, logicalId: string): string | undefined {
  const props = propertiesOf(resources, logicalId);
  if (props === undefined) return undefined;
  let userData = props['UserData'];
  if (userData === undefined) {
    const lt = props['LaunchTemplate'] as Record<string, unknown> | undefined;
    const ltProps = propertiesOf(
      resources,
      refOf(lt?.['LaunchTemplateId']) ?? refOf(lt?.['LaunchTemplateName'])
    );
    userData = (ltProps?.['LaunchTemplateData'] as Record<string, unknown> | undefined)?.[
      'UserData'
    ];
  }
  if (userData === undefined) {
    userData = propertiesOf(resources, refOf(props['LaunchConfigurationName']))?.['UserData'];
  }
  if (userData === undefined) return undefined;
  if (typeof userData === 'string') {
    const decoded = Buffer.from(userData, 'base64').toString('utf8');
    return /cfn-/.test(decoded) ? decoded : userData;
  }
  return JSON.stringify(userData);
}

/** Whether a CloudFormation stack can carry this name (a nested child's cannot). */
export function canReceiveFor(stackName: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName);
}

interface LiveStack {
  StackId?: string | undefined;
  StackStatus?: string | undefined;
  Description?: string | undefined;
  Tags?: { Key?: string | undefined; Value?: string | undefined }[] | undefined;
}

/** A cdkd receiver: its tag AND its description, never one alone. */
export function isReceiver(stack: LiveStack): boolean {
  return (
    stack.Tags?.some((t) => t.Key === RECEIVER_TAG_KEY && t.Value === 'true') === true &&
    stack.Description === RECEIVER_DESCRIPTION
  );
}

type TemplateResources = Record<string, Record<string, unknown>>;

/** The receiver's template from its resources. */
export function receiverTemplateBody(resources: TemplateResources): string {
  return JSON.stringify({ Description: RECEIVER_DESCRIPTION, Resources: resources });
}

/** A waiter: a fresh WaitCondition taking `count` signals, with metadata. */
export function waiterResource(count: number, metadata: unknown): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFormation::WaitCondition',
    CreationPolicy: { ResourceSignal: { Count: Math.max(count, 1), Timeout: 'PT12H' } },
    ...(metadata !== undefined && { Metadata: metadata }),
  };
}

/** A metadata holder: completes at once, serves `cfn-init`. */
export function holderResource(metadata: unknown): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFormation::WaitConditionHandle',
    ...(metadata !== undefined && { Metadata: metadata }),
  };
}

const anchorResource = (): Record<string, unknown> => ({
  Type: 'AWS::CloudFormation::WaitConditionHandle',
});

function notFound(error: unknown): boolean {
  return /does not exist/i.test(error instanceof Error ? error.message : '');
}

function noUpdates(error: unknown): boolean {
  return /No updates are to be performed/i.test(error instanceof Error ? error.message : '');
}

const SETTLED = /(_COMPLETE|_FAILED)$/;

/**
 * One deploy's view of the stack's receiver. `ensure()` finds, adopts or
 * creates it (before the diff, so `AWS::StackId` resolves to it); `arm()` sets
 * this deploy's waiters; `awaitSignals()` waits for one; `settle()` cancels a
 * leftover update at the deploy's end.
 */
export class SignalReceiver {
  private stackId: string | undefined;
  private armed = new Set<string>();
  /** Armed waiters whose signals arrived. */
  private finished = new Set<string>();
  /** Every waiter `arm()` added, disarmed ones included. */
  private armedIds: string[] = [];
  private armedUpdate = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly stackName: string;
  private readonly candidates: ReadonlyMap<string, SignalCandidate>;
  private readonly client: () => CloudFormationClient;
  private readonly logger: ReceiverLogger;

  constructor(
    stackName: string,
    candidates: ReadonlyMap<string, SignalCandidate>,
    client: () => CloudFormationClient,
    logger: ReceiverLogger,
    clock: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
  ) {
    this.stackName = stackName;
    this.candidates = candidates;
    this.client = client;
    this.logger = logger;
    this.sleep = clock.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = clock.now ?? Date.now;
  }

  /** The receiver's StackId once `ensure()` found or made it. */
  get receiverStackId(): string | undefined {
    return this.stackId;
  }

  candidate(logicalId: string): SignalCandidate | undefined {
    return this.candidates.get(logicalId);
  }

  /** Whether this deploy armed a waiter for `logicalId`. */
  isArmed(logicalId: string): boolean {
    return this.armed.has(logicalId);
  }

  /** An armed resource that was not created after all: no wait, cancelled at `settle()`. */
  disarm(logicalId: string): void {
    this.armed.delete(logicalId);
  }

  /**
   * Find the stack's receiver (by its recorded id, else by name), adopt one an
   * earlier failed deploy made, or create it. Returns its StackId, or
   * `undefined` when there is none to use (a foreign stack holds the name, or
   * a CloudFormation call was refused). Never throws.
   */
  async ensure(recordedStackId: string | undefined): Promise<string | undefined> {
    try {
      const client = this.client();
      let stack =
        recordedStackId !== undefined ? await this.describe(client, recordedStackId) : undefined;
      if (stack !== undefined && !isReceiver(stack)) stack = undefined;
      if (stack === undefined) {
        const byName = await this.describe(client, this.stackName);
        if (byName !== undefined && !isReceiver(byName)) {
          this.logger.warn(
            safeMsg`A CloudFormation stack named ${this.stackName} exists and is not cdkd's signal receiver, so it is left alone; resources declaring a CreationPolicy or cfn-init metadata are created without waiting for signals.`
          );
          return undefined;
        }
        stack = byName;
      }
      if (stack === undefined) {
        const out = await client.send(
          new CreateStackCommand({
            StackName: this.stackName,
            TemplateBody: receiverTemplateBody({ [ANCHOR_ID]: anchorResource() }),
            Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }],
          })
        );
        this.stackId = out.StackId;
        this.logger.info(
          safeMsg`Created the CloudFormation signal receiver stack ${this.stackName} (tag cdkd:signal-receiver=true): this stack declares CreationPolicy signals or cfn-init metadata, which only a CloudFormation stack can answer. It holds no resources of yours, AWS::StackId resolves to it, and cdkd destroy deletes it.`
        );
      } else {
        this.stackId = stack.StackId;
      }
      if (this.stackId === undefined) return undefined;
      await this.recover(client, stack?.StackStatus);
      const settled = await this.awaitSettled(client);
      if (settled === undefined) {
        throw new Error('the receiver stack did not settle in a usable state');
      }
      return this.stackId;
    } catch (error) {
      this.fallbackWarn(error);
      this.stackId = undefined;
      return undefined;
    }
  }

  /**
   * Arm this deploy's waiters: `armIds` (the rows creating or replacing a
   * resource with a `ResourceSignal`) get a fresh waiter, every other
   * candidate keeps its metadata on a holder. `resolveMetadata` throws for a
   * resource whose metadata cannot be sent; such an armed resource is not
   * covered. Never throws; returns the ids armed.
   */
  async arm(
    armIds: ReadonlySet<string>,
    resolveMetadata: (logicalId: string) => Promise<unknown>
  ): Promise<ReadonlySet<string>> {
    if (this.stackId === undefined) return new Set();
    try {
      const client = this.client();
      const current = await this.currentResources(client);
      const desired: TemplateResources = { [ANCHOR_ID]: anchorResource() };
      const toArm = new Set<string>();
      for (const [id, candidate] of this.candidates) {
        let metadata: unknown;
        try {
          metadata = candidate.hasInitMetadata ? await resolveMetadata(id) : undefined;
        } catch {
          this.logger.warn(
            safeMsg`${id}: its Metadata cannot be sent to the CloudFormation signal receiver (it reads a NoEcho value or a resource not created yet), so cfn-init and cfn-signal for it are not served this deploy`
          );
          if (current[id] !== undefined) desired[id] = current[id];
          continue;
        }
        if (armIds.has(id) && candidate.count > 0) {
          desired[id] = waiterResource(candidate.count, metadata);
          toArm.add(id);
        } else if (candidate.hasInitMetadata) {
          const existing = current[id];
          desired[id] =
            existing !== undefined && existing['Type'] === 'AWS::CloudFormation::WaitCondition'
              ? { ...existing, ...(metadata !== undefined && { Metadata: metadata }) }
              : holderResource(metadata);
        }
      }
      // A waiter from an earlier deploy cannot take signals again: remove it
      // first, in its own update.
      const rearm = [...toArm].filter((id) => current[id] !== undefined);
      if (rearm.length > 0) {
        const without = Object.fromEntries(
          Object.entries(desired).filter(([id]) => !rearm.includes(id))
        );
        await this.update(client, without);
        if ((await this.awaitSettled(client)) !== 'UPDATE_COMPLETE') {
          throw new Error('the receiver did not finish removing its earlier waiters');
        }
      }
      const changed = await this.update(client, desired);
      if (changed) this.armedUpdate = toArm.size > 0;
      if (toArm.size > 0) await this.awaitWaiting(client, toArm);
      this.armed = toArm;
      this.armedIds = [...toArm];
      if (toArm.size > 0) {
        this.logger.info(
          safeMsg`Signal receiver ${this.stackName}: waiting for CreationPolicy signals from ${[...toArm].join(', ')}`
        );
      }
      return toArm;
    } catch (error) {
      this.fallbackWarn(error);
      this.armed = new Set();
      return new Set();
    }
  }

  /**
   * Wait for `logicalId`'s signals: its waiter `CREATE_COMPLETE`. Throws on a
   * FAILURE signal, on the policy's `Timeout` counted from `startedAt`, when
   * the receiver rolls the waiter back, and when `stop()` says the deploy is
   * stopping (a sibling failed, or Ctrl-C).
   */
  async awaitSignals(logicalId: string, startedAt: number, stop: () => boolean): Promise<void> {
    const candidate = this.candidates.get(logicalId);
    if (!this.armed.has(logicalId) || candidate === undefined || this.stackId === undefined) return;
    const client = this.client();
    const deadline = startedAt + candidate.timeoutMs;
    this.logger.info(
      safeMsg`${logicalId}: waiting for ${candidate.count} CreationPolicy signal(s) (timeout ${Math.round(candidate.timeoutMs / 1000)}s)`
    );
    for (;;) {
      if (stop())
        throw new Error(
          safeMsg`${logicalId}: the CreationPolicy signal wait stopped with the deploy`
        );
      let status: string | undefined;
      let reason: string | undefined;
      try {
        const out = await client.send(
          new DescribeStackResourceCommand({
            StackName: this.stackId,
            LogicalResourceId: logicalId,
          })
        );
        status = out.StackResourceDetail?.ResourceStatus;
        reason = out.StackResourceDetail?.ResourceStatusReason;
      } catch (error) {
        if (!notFound(error)) throw error;
        status = 'GONE';
      }
      if (status === 'CREATE_COMPLETE') {
        this.finished.add(logicalId);
        this.logger.info(safeMsg`${logicalId}: received its CreationPolicy signal(s)`);
        return;
      }
      if (
        status === 'CREATE_FAILED' ||
        status === 'GONE' ||
        status?.startsWith('DELETE') === true
      ) {
        throw new Error(
          safeMsg`${logicalId} received a FAILURE signal or no signal (CreationPolicy): ${reason ?? status ?? 'unknown'}`
        );
      }
      if (this.now() >= deadline) {
        throw new Error(
          safeMsg`${logicalId} did not receive ${candidate.count} CreationPolicy signal(s) within ${Math.round(candidate.timeoutMs / 1000)}s`
        );
      }
      await this.sleep(Math.min(POLL_INTERVAL_MS, Math.max(deadline - this.now(), 0)));
    }
  }

  /**
   * The deploy's end: an update this deploy left in progress (a waiter never
   * signalled) is cancelled, which takes this deploy's waiters back out.
   * Never throws.
   */
  async settle(): Promise<void> {
    if (!this.armedUpdate || this.stackId === undefined) return;
    // Every waiter this deploy armed received its signals: CloudFormation
    // completes the update itself; a cancel now would roll it back.
    if (this.armedIds.every((id) => this.finished.has(id))) return;
    try {
      const client = this.client();
      const stack = await this.describe(client, this.stackId);
      if (stack?.StackStatus === 'UPDATE_IN_PROGRESS') {
        await client.send(new CancelUpdateStackCommand({ StackName: this.stackId }));
        this.logger.debug(safeMsg`Cancelled the signal receiver's unfinished update`);
      }
    } catch (error) {
      this.logger.debug(
        safeMsg`Could not cancel the signal receiver's update: ${describeAwsFailure(error).summary}`
      );
    }
  }

  /**
   * A receiver a killed deploy left waiting (`UPDATE_IN_PROGRESS`; its
   * waiters time out only after 12 hours) is cancelled: this deploy holds the
   * stack's lock, so no other deploy is using it. One stuck in
   * `UPDATE_ROLLBACK_FAILED` continues its rollback. One whose creation failed
   * (`ROLLBACK_COMPLETE`, unusable) is deleted and made again.
   */
  private async recover(client: CloudFormationClient, status: string | undefined): Promise<void> {
    if (status === 'UPDATE_IN_PROGRESS') {
      this.logger.info(
        safeMsg`Cancelling the signal receiver update a previous deploy left waiting`
      );
      await client.send(new CancelUpdateStackCommand({ StackName: this.stackId }));
    } else if (status === 'UPDATE_ROLLBACK_FAILED') {
      await client.send(new ContinueUpdateRollbackCommand({ StackName: this.stackId }));
    } else if (status === 'ROLLBACK_COMPLETE' || status === 'CREATE_FAILED') {
      await client.send(new DeleteStackCommand({ StackName: this.stackId }));
      const deadline = this.now() + SETTLE_WAIT_MS;
      while ((await this.describe(client, this.stackId!)) !== undefined) {
        if (this.now() >= deadline) throw new Error('the failed receiver stack was not deleted');
        await this.sleep(POLL_INTERVAL_MS);
      }
      const out = await client.send(
        new CreateStackCommand({
          StackName: this.stackName,
          TemplateBody: receiverTemplateBody({ [ANCHOR_ID]: anchorResource() }),
          Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }],
        })
      );
      this.stackId = out.StackId;
    }
  }

  private fallbackWarn(error: unknown): void {
    const failure = describeAwsFailure(error);
    this.logger.warn(
      safeMsg`The CloudFormation signal receiver ${this.stackName} is unavailable (${failure.summary}); resources declaring a CreationPolicy or cfn-init metadata are created without waiting for signals.`
    );
    this.logger.debug(safeMsg`Signal receiver failure detail: ${failure.detail}`);
  }

  private async describe(
    client: CloudFormationClient,
    name: string
  ): Promise<LiveStack | undefined> {
    try {
      const out = await client.send(new DescribeStacksCommand({ StackName: name }));
      const stack = out.Stacks?.[0];
      if (stack === undefined || stack.StackStatus === 'DELETE_COMPLETE') return undefined;
      return stack;
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  }

  /** Wait until no operation runs on the receiver; its final status, or `undefined`. */
  private async awaitSettled(client: CloudFormationClient): Promise<string | undefined> {
    const deadline = this.now() + SETTLE_WAIT_MS;
    while (this.now() < deadline) {
      const stack = await this.describe(client, this.stackId!);
      const status = stack?.StackStatus;
      if (status === undefined) return undefined;
      if (SETTLED.test(status) && !status.endsWith('ROLLBACK_FAILED')) {
        if (status === 'CREATE_FAILED' || status === 'ROLLBACK_COMPLETE') return undefined;
        return status;
      }
      if (status.endsWith('ROLLBACK_FAILED')) return undefined;
      await this.sleep(POLL_INTERVAL_MS);
    }
    return undefined;
  }

  private async currentResources(client: CloudFormationClient): Promise<TemplateResources> {
    const out = await client.send(new GetTemplateCommand({ StackName: this.stackId }));
    const body = out.TemplateBody;
    if (typeof body !== 'string') return {};
    const parsed = JSON.parse(body) as { Resources?: TemplateResources };
    const resources = { ...(parsed.Resources ?? {}) };
    delete resources[ANCHOR_ID];
    return resources;
  }

  /** `true` when CloudFormation took the update; `false` for "no updates". */
  private async update(
    client: CloudFormationClient,
    resources: TemplateResources
  ): Promise<boolean> {
    const body = receiverTemplateBody(resources);
    if (body.length > MAX_TEMPLATE_BODY_BYTES) {
      throw new Error(
        `the receiver template (${body.length} bytes of cfn-init metadata) exceeds the ${MAX_TEMPLATE_BODY_BYTES}-byte inline TemplateBody limit`
      );
    }
    try {
      await client.send(
        new UpdateStackCommand({
          StackName: this.stackId,
          TemplateBody: body,
          Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }],
        })
      );
      return true;
    } catch (error) {
      if (noUpdates(error)) return false;
      throw error;
    }
  }

  /** Wait until every armed waiter is `CREATE_IN_PROGRESS` (an instance's first call finds it). */
  private async awaitWaiting(
    client: CloudFormationClient,
    ids: ReadonlySet<string>
  ): Promise<void> {
    const deadline = this.now() + SETTLE_WAIT_MS;
    const pending = new Set(ids);
    while (pending.size > 0) {
      for (const id of [...pending]) {
        try {
          const out = await client.send(
            new DescribeStackResourceCommand({ StackName: this.stackId, LogicalResourceId: id })
          );
          if (out.StackResourceDetail?.ResourceStatus !== undefined) pending.delete(id);
        } catch (error) {
          if (!notFound(error)) throw error;
        }
      }
      if (pending.size === 0) return;
      if (this.now() >= deadline) throw new Error('the receiver waiters did not appear');
      await this.sleep(POLL_INTERVAL_MS / 2);
    }
  }
}

/**
 * Delete the receiver recorded for a stack being destroyed, orphaned or
 * exported. Only a stack carrying the receiver tag AND description, addressed
 * by its recorded id. Never throws; warns with the remedy.
 */
export async function deleteSignalReceiver(
  client: CloudFormationClient,
  stackId: string,
  logger: ReceiverLogger
): Promise<void> {
  try {
    const out = await client.send(new DescribeStacksCommand({ StackName: stackId }));
    const stack = out.Stacks?.[0];
    if (stack === undefined || stack.StackStatus === 'DELETE_COMPLETE') return;
    if (!isReceiver(stack)) return;
    await client.send(new DeleteStackCommand({ StackName: stackId }));
    logger.info(
      safeMsg`Deleting the CloudFormation signal receiver stack ${stack.StackName ?? stackId}`
    );
  } catch (error) {
    if (notFound(error)) return;
    logger.warn(
      safeMsg`Could not delete the CloudFormation signal receiver stack (${describeAwsFailure(error).summary}); delete it with: aws cloudformation delete-stack --stack-name '${stackId}'`
    );
  }
}

/**
 * `cdkd export`, right before its IMPORT changeset takes the stack's name:
 * delete the stack's signal receiver holding it and wait until it is gone.
 * A no-op when the name is free or held by anything else (the export's own
 * pre-flight refused that). Throws when the delete does not finish.
 */
export async function removeSignalReceiverNamed(
  client: CloudFormationClient,
  stackName: string,
  logger: ReceiverLogger,
  clock: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<void> {
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = clock.now ?? Date.now;
  const out = await client
    .send(new DescribeStacksCommand({ StackName: stackName }))
    .catch((error: unknown) => {
      if (notFound(error)) return undefined;
      throw error;
    });
  const stack = out?.Stacks?.[0];
  if (
    stack?.StackId === undefined ||
    stack.StackStatus === 'DELETE_COMPLETE' ||
    !isReceiver(stack)
  ) {
    return;
  }
  const stackId = stack.StackId;
  logger.info(
    safeMsg`Deleting the CloudFormation signal receiver stack ${stackName} so the export can take its name`
  );
  await client.send(new DeleteStackCommand({ StackName: stackId }));
  const deadline = now() + SETTLE_WAIT_MS;
  for (;;) {
    const status = await client
      .send(new DescribeStacksCommand({ StackName: stackId }))
      .then((r) => r.Stacks?.[0]?.StackStatus)
      .catch((error: unknown) => {
        if (notFound(error)) return 'DELETE_COMPLETE';
        throw error;
      });
    if (status === undefined || status === 'DELETE_COMPLETE') return;
    if (status === 'DELETE_FAILED' || now() >= deadline) {
      throw new Error(
        safeMsg`The CloudFormation signal receiver stack ${stackName} could not be deleted (${status}); delete it, then re-run the export`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
