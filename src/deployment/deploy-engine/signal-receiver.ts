/**
 * go-to-k/cdkd#6705: a transient CloudFormation "signal receiver" stack, so a
 * resource's `CreationPolicy` is honored and `cfn-init` finds its metadata.
 *
 * `cfn-signal --stack <name> --resource <id>` and `cfn-init --stack <name>
 * --resource <id>` call CloudFormation's `SignalResource` and
 * `DescribeStackResource`. Only CloudFormation can answer them, and a cdkd
 * deploy has no CloudFormation stack. So, for a deploy that creates such a
 * resource, cdkd creates a stack named exactly as the cdkd stack (what
 * `${AWS::StackName}` resolves to) holding one `AWS::CloudFormation::WaitCondition`
 * per such resource, under the same logical id, with the resource's
 * `CreationPolicy` count and its resolved `Metadata`. The real resource's
 * create then waits for its receiver to reach `CREATE_COMPLETE`, and the deploy
 * deletes the receiver at its end.
 *
 * Measured (us-east-1): a receiver's `Metadata` is served while it is
 * `CREATE_IN_PROGRESS`; `SignalResource` -> `CREATE_COMPLETE` takes ~20 s;
 * `DeleteStack` during `CREATE_IN_PROGRESS` finishes in ~10 s.
 *
 * One stack name holds one stack, and a stack cannot be updated while it is
 * being created, so the receiver is created ONCE, just before the first such
 * resource is created, holding every candidate whose metadata resolves then.
 * The receiver's own timeout is CloudFormation's maximum; each resource's
 * declared `Timeout` is counted by cdkd from the resource's own create.
 *
 * Every refusal falls back to the earlier behavior — create without waiting,
 * with a warning — never a failed deploy: a CloudFormation stack of that name
 * that is not a receiver (the same app deployed with the AWS CDK CLI), a
 * denied `CreateStack`, a nested child (its name holds `~`, which a
 * CloudFormation stack name cannot), or metadata not resolvable yet.
 */

import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackResourceCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  type CloudFormationClient,
} from '@aws-sdk/client-cloudformation';
import { safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { startInterruptWatch } from '../../provisioning/interrupt-watch.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import type { CloudFormationTemplate } from '../../types/resource.js';

/** The tag that marks a stack as a cdkd signal receiver (and nothing else). */
export const RECEIVER_TAG_KEY = 'cdkd:signal-receiver';

/** CloudFormation's ceiling for a `ResourceSignal.Timeout`. */
const MAX_SIGNAL_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** CloudFormation's default `ResourceSignal.Timeout`. */
const DEFAULT_SIGNAL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const READY_WAIT_MS = 120_000;

export interface SignalCandidate {
  count: number;
  timeoutMs: number;
  hasInitMetadata: boolean;
}

interface Logger {
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
 * `ResourceSignal` (count + timeout), and/or `AWS::CloudFormation::Init`
 * metadata for `cfn-init`. `undefined` when it asks for neither.
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
  if ((policy === undefined || policy === null) && !hasInitMetadata) return undefined;
  if (policy === undefined || policy === null || typeof policy !== 'object') {
    // cfn-init only: the receiver serves metadata, nobody waits on a signal.
    return { count: 0, timeoutMs: 0, hasInitMetadata };
  }
  const p = policy as Record<string, unknown>;
  const rawCount = p['Count'];
  const count =
    rawCount === undefined
      ? 1
      : typeof rawCount === 'number'
        ? rawCount
        : typeof rawCount === 'string' && /^\d+$/.test(rawCount.trim())
          ? Number(rawCount.trim())
          : 1;
  const timeoutMs = Math.min(
    isoDurationMs(p['Timeout']) ?? DEFAULT_SIGNAL_TIMEOUT_MS,
    MAX_SIGNAL_TIMEOUT_MS
  );
  return { count, timeoutMs, hasInitMetadata };
}

/** The receiver's template: one WaitCondition per covered resource. */
export function receiverTemplate(
  entries: ReadonlyArray<{ logicalId: string; count: number; metadata?: unknown }>
): string {
  const resources: Record<string, unknown> = {};
  for (const { logicalId, count, metadata } of entries) {
    resources[logicalId] = {
      Type: 'AWS::CloudFormation::WaitCondition',
      // A metadata-only entry still needs a policy to stay CREATE_IN_PROGRESS
      // (and so readable) while its resource boots; nothing waits on it.
      CreationPolicy: { ResourceSignal: { Count: Math.max(count, 1), Timeout: 'PT12H' } },
      ...(metadata !== undefined && { Metadata: metadata }),
    };
  }
  return JSON.stringify({
    Description:
      'cdkd signal receiver: answers cfn-signal / cfn-init for a cdkd deploy; deleted when the deploy ends',
    Resources: resources,
  });
}

export type CoverVerdict = 'covered' | 'not-covered';

interface LiveStack {
  StackId?: string | undefined;
  StackStatus?: string | undefined;
  Description?: string | undefined;
  Tags?: { Key?: string | undefined; Value?: string | undefined }[] | undefined;
}

/** A cdkd receiver: its tag AND its description, never one alone. */
function isReceiver(stack: LiveStack): boolean {
  return (
    stack.Tags?.some((t) => t.Key === RECEIVER_TAG_KEY && t.Value === 'true') === true &&
    stack.Description === RECEIVER_DESCRIPTION
  );
}

const RECEIVER_DESCRIPTION =
  'cdkd signal receiver: answers cfn-signal / cfn-init for a cdkd deploy; deleted when the deploy ends';

/**
 * One deploy's receiver. `candidates` are the CREATE rows asking for one;
 * `resolveMetadata` resolves a candidate's `Metadata` against the deploy's
 * current state, throwing when it cannot yet.
 */
export class SignalReceiver {
  private ensured: Promise<ReadonlySet<string>> | undefined;
  /** Set once the create is SENT (it may have succeeded even if it threw). */
  private created = false;
  /** The receiver's StackId, as the create returned it. */
  private stackId: string | undefined;
  private readonly stackName: string;
  private readonly candidates: ReadonlyMap<string, SignalCandidate>;
  private readonly client: () => CloudFormationClient;
  private readonly logger: Logger;
  /** Test seams: the poll loops' sleep and clock. */
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    stackName: string,
    candidates: ReadonlyMap<string, SignalCandidate>,
    client: () => CloudFormationClient,
    logger: Logger,
    clock: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
  ) {
    this.stackName = stackName;
    this.candidates = candidates;
    this.client = client;
    this.logger = logger;
    this.sleep = clock.sleep ?? sleep;
    this.now = clock.now ?? Date.now;
  }

  /** Whether a CloudFormation stack can carry this name (a nested child's cannot). */
  static canReceiveFor(stackName: string): boolean {
    return /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName);
  }

  candidate(logicalId: string): SignalCandidate | undefined {
    return this.candidates.get(logicalId);
  }

  /** Whether an earlier `cover()` put `logicalId` in the receiver. */
  isCovered(logicalId: string): boolean {
    return this.coveredIds?.has(logicalId) === true;
  }
  private coveredIds: ReadonlySet<string> | undefined;

  /**
   * Create the receiver once (single-flight) and say whether it covers
   * `logicalId`. Never throws: anything that stops a receiver falls back.
   */
  async cover(
    logicalId: string,
    resolveMetadata: (logicalId: string) => Promise<unknown>
  ): Promise<CoverVerdict> {
    if (!this.candidates.has(logicalId)) return 'not-covered';
    this.ensured ??= this.create(resolveMetadata);
    const covered = await this.ensured;
    this.coveredIds = covered;
    return covered.has(logicalId) ? 'covered' : 'not-covered';
  }

  private async create(
    resolveMetadata: (logicalId: string) => Promise<unknown>
  ): Promise<ReadonlySet<string>> {
    try {
      const client = this.client();
      if (!(await this.clearStaleReceiver(client))) return new Set();
      const entries: { logicalId: string; count: number; metadata?: unknown }[] = [];
      for (const [logicalId, candidate] of this.candidates) {
        let metadata: unknown;
        if (candidate.hasInitMetadata) {
          try {
            metadata = await resolveMetadata(logicalId);
          } catch {
            this.logger.debug(
              safeMsg`Signal receiver: ${logicalId}'s Metadata does not resolve yet; it is not covered`
            );
            continue;
          }
        }
        entries.push({ logicalId, count: candidate.count, metadata });
      }
      if (entries.length === 0) return new Set();
      // Sent: from here a failure may still have created it, so `dispose`
      // looks for it (by name, then its tag) when no id came back.
      this.created = true;
      const out = await client.send(
        new CreateStackCommand({
          StackName: this.stackName,
          TemplateBody: receiverTemplate(entries),
          Tags: [{ Key: RECEIVER_TAG_KEY, Value: 'true' }],
          // One resource's FAILURE must not delete the others' receivers
          // mid-wait; `dispose` deletes the stack.
          OnFailure: 'DO_NOTHING',
        })
      );
      this.stackId = out.StackId;
      this.logger.info(
        safeMsg`Created the CloudFormation signal receiver stack ${this.stackName} for ${entries.length} resource(s) declaring a CreationPolicy or cfn-init metadata (deleted when the deploy ends)`
      );
      const ids = new Set(entries.map((e) => e.logicalId));
      await this.awaitReceiving(client, ids);
      return ids;
    } catch (error) {
      const failure = describeAwsFailure(error);
      this.logger.warn(
        safeMsg`Could not create the CloudFormation signal receiver stack ${this.stackName} (${failure.summary}); resources declaring a CreationPolicy are created without waiting for signals.`
      );
      this.logger.debug(safeMsg`Signal receiver failure detail: ${failure.detail}`);
      return new Set();
    }
  }

  /**
   * A stack of this name that cdkd left (an interrupted deploy) is deleted;
   * any other — the app deployed with the AWS CDK CLI — is never touched, and
   * the receiver is not created. `true` when the name is free.
   */
  private async clearStaleReceiver(client: CloudFormationClient): Promise<boolean> {
    const stack = await this.findByName(client);
    if (stack === undefined) return true;
    if (!isReceiver(stack)) {
      this.logger.warn(
        safeMsg`A CloudFormation stack named ${this.stackName} exists (not a cdkd signal receiver), so it is left alone; resources declaring a CreationPolicy are created without waiting for signals.`
      );
      return false;
    }
    // Addressed by the id just read, never the name: a stack that took the
    // name in between is another stack.
    const staleId = stack.StackId;
    await client.send(new DeleteStackCommand({ StackName: staleId }));
    const deadline = this.now() + READY_WAIT_MS;
    while (this.now() < deadline) {
      const out = await client.send(new DescribeStacksCommand({ StackName: staleId }));
      if (out.Stacks?.[0]?.StackStatus === 'DELETE_COMPLETE') return true;
      await this.sleep(POLL_INTERVAL_MS);
    }
    throw new Error('the signal receiver an earlier deploy left did not finish deleting');
  }

  /** The live stack holding the name, or `undefined` when none does. */
  private async findByName(client: CloudFormationClient): Promise<LiveStack | undefined> {
    try {
      const out = await client.send(new DescribeStacksCommand({ StackName: this.stackName }));
      const stack = out.Stacks?.[0];
      if (stack === undefined || stack.StackStatus === 'DELETE_COMPLETE') return undefined;
      return stack;
    } catch (error) {
      if (/does not exist/i.test(error instanceof Error ? error.message : '')) return undefined;
      throw error;
    }
  }

  /** Wait until every receiver resource exists (so the instance's first call finds it). */
  private async awaitReceiving(
    client: CloudFormationClient,
    ids: ReadonlySet<string>
  ): Promise<void> {
    const deadline = this.now() + READY_WAIT_MS;
    while (this.now() < deadline) {
      const out = await client.send(
        new DescribeStackResourcesCommand({ StackName: this.stackId ?? this.stackName })
      );
      const present = new Set((out.StackResources ?? []).map((r) => r.LogicalResourceId));
      if ([...ids].every((id) => present.has(id))) return;
      await this.sleep(POLL_INTERVAL_MS / 2);
    }
    throw new Error('the signal receiver resources did not appear');
  }

  /**
   * Wait for `logicalId`'s signals: its receiver resource `CREATE_COMPLETE`.
   * Throws on a FAILURE signal (`CREATE_FAILED`), on `Timeout` counted from
   * `startedAt`, and on Ctrl-C. A metadata-only entry waits for nothing.
   */
  async awaitSignals(logicalId: string, startedAt: number): Promise<void> {
    const candidate = this.candidates.get(logicalId);
    if (candidate === undefined || candidate.count === 0) return;
    const client = this.client();
    const deadline = startedAt + candidate.timeoutMs;
    const watch = startInterruptWatch(`CreationPolicy signal wait for ${logicalId}`);
    this.logger.info(
      safeMsg`${logicalId}: waiting for ${candidate.count} CreationPolicy signal(s) (timeout ${Math.round(candidate.timeoutMs / 1000)}s)`
    );
    try {
      for (;;) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        let out;
        try {
          out = await client.send(
            new DescribeStackResourceCommand({
              StackName: this.stackId ?? this.stackName,
              LogicalResourceId: logicalId,
            })
          );
        } catch (error) {
          if (/does not exist/i.test(error instanceof Error ? error.message : '')) {
            throw new Error(safeMsg`${logicalId}'s signal receiver is gone before it signalled (CreationPolicy)`);
          }
          throw error;
        }
        const status = out.StackResourceDetail?.ResourceStatus;
        if (status === 'CREATE_COMPLETE') {
          this.logger.info(safeMsg`${logicalId}: received its CreationPolicy signal(s)`);
          return;
        }
        if (status === 'CREATE_FAILED' || status?.startsWith('DELETE') === true) {
          throw new Error(
            safeMsg`${logicalId} received a FAILURE signal or did not signal (CreationPolicy): ${out.StackResourceDetail?.ResourceStatusReason ?? status}`
          );
        }
        if (this.now() >= deadline) {
          throw new Error(
            safeMsg`${logicalId} did not receive ${candidate.count} CreationPolicy signal(s) within ${Math.round(candidate.timeoutMs / 1000)}s`
          );
        }
        await this.sleep(Math.min(POLL_INTERVAL_MS, Math.max(deadline - this.now(), 0)));
      }
    } finally {
      watch.dispose();
    }
  }

  /**
   * Delete the receiver if this deploy sent its create. Never throws. By the
   * id the create returned; when none came back (an ambiguous failure), only
   * a stack holding the name that carries the receiver tag is deleted.
   */
  async dispose(): Promise<void> {
    if (!this.created) return;
    try {
      const client = this.client();
      let id = this.stackId;
      if (id === undefined) {
        const stack = await this.findByName(client);
        if (stack === undefined || !isReceiver(stack)) return;
        id = stack.StackId;
      }
      await client.send(new DeleteStackCommand({ StackName: id }));
      this.logger.debug(safeMsg`Deleting the signal receiver stack ${this.stackName}`);
    } catch (error) {
      this.logger.warn(
        safeMsg`Could not delete the CloudFormation signal receiver stack ${this.stackName} (${describeAwsFailure(error).summary}); the next deploy deletes it, or delete it by hand.`
      );
    }
  }
}

/**
 * The deploy's receiver, or `undefined` when no CREATE row asks for one or the
 * stack's name cannot be a CloudFormation stack's (a nested child; those keep
 * the warn-and-proceed path).
 */
export function buildSignalReceiver(
  engine: { logger: Logger },
  stackName: string,
  createChanges: ReadonlyArray<{ logicalId: string }>,
  template: CloudFormationTemplate
): SignalReceiver | undefined {
  const candidates = new Map<string, SignalCandidate>();
  for (const { logicalId } of createChanges) {
    const candidate = signalCandidateOf(template.Resources?.[logicalId]);
    if (candidate !== undefined) candidates.set(logicalId, candidate);
  }
  if (candidates.size === 0) return undefined;
  if (!SignalReceiver.canReceiveFor(stackName)) {
    engine.logger.debug(
      safeMsg`No signal receiver for ${stackName}: not a name a CloudFormation stack can carry`
    );
    return undefined;
  }
  return new SignalReceiver(
    stackName,
    candidates,
    () => getAwsClients().cloudFormation,
    engine.logger
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
