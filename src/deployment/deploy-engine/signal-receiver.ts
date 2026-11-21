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
  DescribeStackEventsCommand,
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
  /**
   * go-to-k/cdkd#6706: an `AutoScalingRollingUpdate` declaring
   * `WaitOnResourceSignals`: its `PauseTime` (CloudFormation's default 5
   * minutes when absent), the wait for the replaced instances' signals.
   */
  rollingPauseMs?: number;
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
  const rollingPauseMs = rollingSignalPauseMs(resource);
  const rolling = rollingPauseMs !== undefined && { rollingPauseMs };
  if (!hasPolicy && !hasInitMetadata && !rolling) return undefined;
  if (!hasPolicy) return { count: 0, timeoutMs: 0, hasInitMetadata, ...rolling };
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
  return { count, timeoutMs, hasInitMetadata, ...rolling };
}

/** An `AutoScalingRollingUpdate` with `WaitOnResourceSignals`: its `PauseTime` in ms. */
function rollingSignalPauseMs(resource: object): number | undefined {
  const policy = (resource as { UpdatePolicy?: unknown }).UpdatePolicy;
  if (policy === null || typeof policy !== 'object') return undefined;
  const replacing = (policy as Record<string, unknown>)['AutoScalingReplacingUpdate'];
  const willReplace =
    replacing !== null && typeof replacing === 'object'
      ? (replacing as Record<string, unknown>)['WillReplace']
      : undefined;
  // A replacing update takes precedence: the new group's CreationPolicy waits.
  if (willReplace === true || willReplace === 'true') return undefined;
  const rolling = (policy as Record<string, unknown>)['AutoScalingRollingUpdate'];
  if (rolling === null || typeof rolling !== 'object') return undefined;
  const wait = (rolling as Record<string, unknown>)['WaitOnResourceSignals'];
  if (wait !== true && wait !== 'true') return undefined;
  const pause = isoDurationMs((rolling as Record<string, unknown>)['PauseTime']);
  return Math.min(pause ?? DEFAULT_SIGNAL_TIMEOUT_MS, MAX_SIGNAL_TIMEOUT_MS);
}

/** Every template resource asking the receiver for something. */
export function signalCandidatesOf(template: CloudFormationTemplate): Map<string, SignalCandidate> {
  return signalPlanOf(template).candidates;
}

/** How the template's user data calls `cfn-init` / `cfn-signal` for one resource. */
export interface BootstrapCalls {
  signedSignal: boolean;
  signedInit: boolean;
  /** A call naming the resource without credentials (`--role` etc.). */
  unsigned: boolean;
}

/**
 * The receiver's candidates, and the resources it cannot serve because a
 * `cfn-init` / `cfn-signal` naming them runs WITHOUT credentials (the AWS
 * CDK default, `initOptions.includeRole: false`): CloudFormation answers an
 * unsigned call only from an instance that is a resource of its own stack,
 * which no cdkd-made instance is (measured).
 *
 * FAIL SAFE: a wrongly armed resource waits until its `Timeout` and fails the
 * deploy, a wrongly unarmed one only keeps the warn-and-proceed behavior. So
 * a `ResourceSignal` resource is armed only when the template's user data
 * holds a SIGNED `cfn-signal --resource <it>` (or `aws cloudformation
 * signal-resource --logical-resource-id <it>`) and no unsigned call naming
 * it; a metadata-only resource only when a signed `cfn-init --resource <it>`
 * reads it.
 */
export function signalPlanOf(template: CloudFormationTemplate): {
  candidates: Map<string, SignalCandidate>;
  unsigned: string[];
} {
  const candidates = new Map<string, SignalCandidate>();
  const unsigned: string[] = [];
  const resources = template.Resources ?? {};
  const calls = bootstrapCallsByResource(resources);
  for (const [id, resource] of Object.entries(resources)) {
    const candidate = signalCandidateOf(resource);
    if (candidate === undefined) continue;
    const call = calls.get(id);
    if (call?.unsigned === true) {
      unsigned.push(id);
      continue;
    }
    const signalled = candidate.count > 0 || candidate.rollingPauseMs !== undefined;
    if (signalled ? call?.signedSignal === true : call?.signedInit === true) {
      candidates.set(id, candidate);
    }
  }
  return { candidates, unsigned };
}

/** Every `cfn-init` / `cfn-signal` call in the template's user data, by the resource it names. */
export function bootstrapCallsByResource(
  resources: Record<string, unknown>
): Map<string, BootstrapCalls> {
  const out = new Map<string, BootstrapCalls>();
  for (const script of userDataScriptsOf(resources)) {
    for (const command of commandsOf(script)) {
      const call = parseBootstrapCall(command);
      if (call === undefined) continue;
      const entry = out.get(call.resource) ?? {
        signedSignal: false,
        signedInit: false,
        unsigned: false,
      };
      if (!call.signed) entry.unsigned = true;
      else if (call.kind === 'signal') entry.signedSignal = true;
      else entry.signedInit = true;
      out.set(call.resource, entry);
    }
  }
  return out;
}

const TOKEN_PLACEHOLDER = '__CDKD_TOKEN__';
const CREDENTIAL_FLAGS = new Set(['--role', '--access-key', '--credential-file', '-f']);

/** Every `UserData` value in the template (instances, launch templates, launch configurations), as script text. */
function userDataScriptsOf(resources: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'UserData') out.push(renderScript(inner, true));
      else walk(inner, depth + 1);
    }
  };
  for (const resource of Object.values(resources)) {
    if (resource !== null && typeof resource === 'object') {
      walk((resource as { Properties?: unknown }).Properties, 0);
    }
  }
  return out;
}

/** The text a user-data value renders to; every unresolved reference becomes a placeholder. */
function renderScript(value: unknown, topLevel = false): string {
  if (typeof value === 'string') {
    if (topLevel && /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length >= 8) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(decoded)) return decoded;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return TOKEN_PLACEHOLDER;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return TOKEN_PLACEHOLDER;
  const [fn, arg] = entries[0]!;
  if (fn === 'Fn::Base64') return renderScript(arg);
  if (
    fn === 'Fn::Join' &&
    Array.isArray(arg) &&
    typeof arg[0] === 'string' &&
    Array.isArray(arg[1])
  ) {
    return (arg[1] as unknown[]).map((part) => renderScript(part)).join(arg[0]);
  }
  if (fn === 'Fn::Sub') {
    const body = typeof arg === 'string' ? arg : Array.isArray(arg) ? arg[0] : undefined;
    if (typeof body === 'string') return body.replace(/\$\{[^!][^}]*\}/g, TOKEN_PLACEHOLDER);
  }
  return TOKEN_PLACEHOLDER;
}

/** The script's commands: line continuations joined, split at newlines and `;` `&&` `||` `|`. */
function commandsOf(script: string): string[] {
  return script
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * A `cfn-init` / `cfn-signal` (Linux path or `.exe`) or `aws cloudformation
 * signal-resource` command: which resource it names and whether it passes
 * credentials. `undefined` for anything else, or one naming no resource.
 */
export function parseBootstrapCall(
  command: string
): { kind: 'init' | 'signal'; resource: string; signed: boolean } | undefined {
  const tokens = command
    .split(/\s+/)
    .map((t) => t.replace(/^[\[("',]+|[\]),"']+$/g, ''))
    .filter((t) => t.length > 0);
  const at = tokens.findIndex((t) => /(?:^|[/\\])cfn-(?:init|signal)(?:\.exe)?$/i.test(t));
  if (at !== -1) {
    const kind = /init(?:\.exe)?$/i.test(tokens[at]!) ? 'init' : 'signal';
    const args = tokens.slice(at + 1);
    const resource = flagValue(args, ['--resource', '-r']);
    if (resource === undefined) return undefined;
    const signed = args.some((t) => CREDENTIAL_FLAGS.has(t.split('=')[0]!));
    return { kind, resource, signed };
  }
  const aws = tokens.findIndex(
    (t, i) =>
      /(?:^|[/\\])aws(?:\.exe)?$/i.test(t) &&
      tokens[i + 1] === 'cloudformation' &&
      tokens[i + 2] === 'signal-resource'
  );
  if (aws !== -1) {
    const resource = flagValue(tokens.slice(aws + 3), ['--logical-resource-id']);
    return resource === undefined ? undefined : { kind: 'signal', resource, signed: true };
  }
  return undefined;
}

function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split('=', 2) as [string, string | undefined];
    if (!names.includes(flag)) continue;
    const value = inline ?? args[i + 1];
    return value === undefined || value.includes(TOKEN_PLACEHOLDER) ? undefined : value;
  }
  return undefined;
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
  /** The resolved metadata each served resource was last sent with (to restore it). */
  private metadataById = new Map<string, unknown>();
  /** Serializes the receiver updates this deploy's rolling updates make. */
  private rollingChain: Promise<unknown> = Promise.resolve();
  /** go-to-k/cdkd#6706: the count each rolling-update waiter was armed with. */
  private armedCounts = new Map<string, number>();
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

  /**
   * go-to-k/cdkd#6706: arm a rolling update's waiter for `count` signals,
   * right before its Instance Refresh starts (never for an update that runs
   * none). Only while the receiver is idle: one waiter of this deploy still
   * pending holds it `UPDATE_IN_PROGRESS`, and that refresh then waits for no
   * signal (warned). Never throws.
   */
  armRolling(logicalId: string, count: number): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (this.stackId === undefined || count <= 0) return false;
      try {
        const client = this.client();
        const status = (await this.describe(client, this.stackId))?.StackStatus;
        if (status === undefined || status.endsWith('_IN_PROGRESS')) {
          this.logger.warn(
            safeMsg`${logicalId}: the CloudFormation signal receiver is busy with another wait of this deploy (${status ?? 'gone'}), so this rolling update waits for no signal`
          );
          return false;
        }
        const current = await this.currentResources(client);
        const metadata = current[logicalId]?.['Metadata'] ?? this.metadataById.get(logicalId);
        if (current[logicalId] !== undefined) {
          // A waiter or holder of the same logical id cannot become a fresh
          // waiter in place: remove it first, in its own update.
          const without = { ...current };
          delete without[logicalId];
          await this.update(client, { [ANCHOR_ID]: anchorResource(), ...without });
          if ((await this.awaitSettled(client)) !== 'UPDATE_COMPLETE') {
            throw new Error('the receiver did not finish removing the earlier waiter');
          }
        }
        await this.update(client, {
          [ANCHOR_ID]: anchorResource(),
          ...current,
          [logicalId]: waiterResource(count, metadata),
        });
        if (metadata !== undefined) this.metadataById.set(logicalId, metadata);
        await this.awaitWaiting(client, new Set([logicalId]));
        this.armed.add(logicalId);
        this.armedIds.push(logicalId);
        this.armedCounts.set(logicalId, count);
        this.armedUpdate = true;
        this.logger.info(
          safeMsg`Signal receiver ${this.stackName}: the rolling update of ${logicalId} waits for ${count} signal(s)`
        );
        return true;
      } catch (error) {
        this.fallbackWarn(error);
        return false;
      }
    };
    const next = this.rollingChain.then(run, run);
    this.rollingChain = next;
    return next;
  }

  /**
   * go-to-k/cdkd#6706: a rolling update's FAILURE so far: the waiter failed
   * (or the receiver's rollback removed it), with the signal's reason from the
   * events since `since`. `undefined` while it still waits or completed.
   */
  async failureOf(logicalId: string, since: number): Promise<string | undefined> {
    if (!this.armed.has(logicalId) || this.stackId === undefined) return undefined;
    const client = this.client();
    let status: string | undefined;
    try {
      const out = await client.send(
        new DescribeStackResourceCommand({ StackName: this.stackId, LogicalResourceId: logicalId })
      );
      status = out.StackResourceDetail?.ResourceStatus;
    } catch (error) {
      if (!notFound(error)) return undefined;
      status = 'GONE';
    }
    if (status !== 'CREATE_FAILED' && status !== 'GONE' && status?.startsWith('DELETE') !== true) {
      return undefined;
    }
    return (
      (await this.failureReasonOf(client, logicalId, since)) ?? `its signal wait ended (${status})`
    );
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
    resolveMetadata: (logicalId: string) => Promise<unknown>,
    /** go-to-k/cdkd#6706: a rolling update's signal count (the instances it replaces). */
    counts: ReadonlyMap<string, number> = new Map()
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
        if (metadata !== undefined) this.metadataById.set(id, metadata);
        const count = counts.get(id) ?? candidate.count;
        if (armIds.has(id) && count > 0) {
          desired[id] = waiterResource(count, metadata);
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
      this.armedCounts = new Map([...counts].filter(([id]) => toArm.has(id)));
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
  async awaitSignals(
    logicalId: string,
    startedAt: number,
    stop: () => boolean,
    /** go-to-k/cdkd#6706: a rolling update's own deadline, in place of the policy's `Timeout`. */
    deadlineOverride?: number
  ): Promise<void> {
    const candidate = this.candidates.get(logicalId);
    if (!this.armed.has(logicalId) || candidate === undefined || this.stackId === undefined) return;
    const client = this.client();
    const deadline = deadlineOverride ?? startedAt + candidate.timeoutMs;
    const count = this.armedCounts.get(logicalId) ?? candidate.count;
    const timeoutMs = deadline - startedAt;
    this.logger.info(
      safeMsg`${logicalId}: waiting for ${count} CreationPolicy signal(s) (timeout ${Math.round(timeoutMs / 1000)}s)`
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
        // A FAILURE signal fails the waiter and CloudFormation rolls the
        // receiver's update back, which removes it: between two polls only
        // its events still say why.
        reason ??= await this.failureReasonOf(client, logicalId, startedAt);
        throw new Error(
          reason !== undefined && /FAILURE signal/i.test(reason)
            ? safeMsg`${logicalId} received a FAILURE signal (CreationPolicy): ${reason}`
            : safeMsg`${logicalId} did not receive its CreationPolicy signal(s): its wait in the signal receiver ended (${reason ?? status ?? 'unknown'})`
        );
      }
      if (this.now() >= deadline) {
        throw new Error(
          safeMsg`${logicalId} did not receive ${count} CreationPolicy signal(s) within ${Math.round(timeoutMs / 1000)}s`
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
      await this.restoreServed(client);
    } catch (error) {
      this.logger.debug(
        safeMsg`Could not settle the signal receiver: ${describeAwsFailure(error).summary}`
      );
    }
  }

  /**
   * After a cancel or a FAILURE signal rolled the receiver back to a template
   * an earlier re-arm stripped, put each served resource's metadata back on a
   * holder, so cfn-init on an instance launched later still finds it.
   */
  private async restoreServed(client: CloudFormationClient): Promise<void> {
    if ((await this.awaitSettled(client)) === undefined) return;
    const current = await this.currentResources(client);
    const missing = [...this.metadataById].filter(([id]) => current[id] === undefined);
    if (missing.length === 0) return;
    const restored: TemplateResources = { [ANCHOR_ID]: anchorResource(), ...current };
    for (const [id, metadata] of missing) restored[id] = holderResource(metadata);
    await this.update(client, restored);
    await this.awaitSettled(client);
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

  /** The latest `CREATE_FAILED` reason the receiver's events give for `logicalId`. */
  private async failureReasonOf(
    client: CloudFormationClient,
    logicalId: string,
    since: number
  ): Promise<string | undefined> {
    try {
      const out = await client.send(new DescribeStackEventsCommand({ StackName: this.stackId }));
      return out.StackEvents?.find(
        (e) =>
          e.LogicalResourceId === logicalId &&
          e.ResourceStatus === 'CREATE_FAILED' &&
          // Not an earlier deploy's waiter under the same logical id.
          (e.Timestamp?.getTime() ?? 0) >= since
      )?.ResourceStatusReason;
    } catch {
      return undefined;
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
    // A receiver a killed deploy left waiting refuses DeleteStack until its
    // update is cancelled (its waiters time out only after 12 hours).
    if (stack.StackStatus === 'UPDATE_IN_PROGRESS') {
      await client.send(new CancelUpdateStackCommand({ StackName: stackId }));
      const deadline = Date.now() + SETTLE_WAIT_MS;
      for (;;) {
        const status = (await client.send(new DescribeStacksCommand({ StackName: stackId })))
          .Stacks?.[0]?.StackStatus;
        if (status === undefined || !status.endsWith('_IN_PROGRESS') || Date.now() >= deadline)
          break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
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
