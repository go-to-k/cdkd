import { isInterruptedWaitError, startInterruptWatch } from '../provisioning/interrupt-watch.js';
import type { DeferredReadinessEntry } from '../provisioning/deferred-readiness.js';
import type { Logger } from '../types/config.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { safeMsg } from '../utils/display-safe.js';
import { ProvisioningError, ResourceTimeoutError } from '../utils/error-handler.js';
import { outsideEnclosingDeadlines, withResourceDeadline } from './resource-deadline.js';

/** What a {@link DeferredReadinessRun} reads from the deploy it serves. */
export interface DeferredReadinessRunDeps {
  logger: Pick<Logger, 'info' | 'debug'>;
  region: string;
  /** The deadline of one operation on the type, as the operation itself runs under. */
  budget: (
    resourceType: string,
    operation: 'CREATE' | 'UPDATE'
  ) => { warnAfterMs: number; timeoutMs: number };
  /** The engine's interrupt flag: Ctrl-C, or a sibling resource that failed. */
  interrupted: () => boolean;
  /**
   * Mask `text` with what `logicalId` resolved from secrets (its own
   * secret-derived name included). Every line and error naming a waited
   * resource goes through it, whichever consumer asked. Identity by default.
   */
  mask?: (logicalId: string, text: string) => string;
}

interface DeferredEntry {
  readonly resourceType: string;
  readonly operation: 'CREATE' | 'UPDATE';
  readonly physicalIds: readonly string[];
  readonly waits: readonly DeferredReadinessEntry[];
  /** The one wait, started on the first need; rejects with the RAW cause. */
  promise?: Promise<void>;
}

/**
 * Whether `entry` is an IAM propagation settle (`iam-propagation-settle.ts`):
 * every wait it holds is one. An IAM operation defers no other kind today; a
 * mixed entry would keep the `--no-wait` wording and its info line.
 */
function isIamPropagation(entry: DeferredEntry): boolean {
  return entry.waits.length > 0 && entry.waits.every((w) => w.kind === 'iam-propagation');
}

/** Whether a wait of `entry` still has time left (an unknown end counts as left). */
function hasTimeLeft(entry: DeferredEntry): boolean {
  return entry.waits.some((w) => (w.remainingMs?.() ?? 1) > 0);
}

/** How often a running readiness wait looks at the engine's interrupt flag. */
export const deferredReadinessPoll = { intervalMs: 500 };

/**
 * One deploy's readiness waits that `--no-wait` skipped (go-to-k/cdkd#6940),
 * recorded per logical id when the operation that skipped one succeeded.
 *
 * A wait runs only when the deploy needs the resource: a `Fn::GetAtt` of a
 * value that exists only once it is ready, a custom resource invoked while it
 * is upstream, or a call AWS refuses until it is ready. It starts on the
 * FIRST such need and is memoized as one promise, so every later need shares
 * it, and an unneeded resource costs nothing.
 *
 * The wait runs in the async context of the operation that deferred it (its
 * masking and printing bags), outside every deadline that context carried,
 * under its OWN `--resource-timeout` for the resource's type. Ctrl-C or a
 * failed sibling aborts it, and its AbortSignal stops the provider's poll.
 *
 * ENGINE-instance state, rebuilt per `deploy()`, like the attribute healer:
 * one engine deploys one stack, and `--stack-concurrency` runs several.
 */
export class DeferredReadinessRun {
  private readonly entries = new Map<string, DeferredEntry>();
  private readonly deps: DeferredReadinessRunDeps;

  constructor(deps: DeferredReadinessRunDeps) {
    this.deps = deps;
  }

  /**
   * Record what a SUCCEEDED operation on `logicalId` deferred. An operation
   * that deferred nothing clears an earlier entry: it waited itself, or made
   * a resource the earlier wait no longer describes.
   */
  record(
    logicalId: string,
    resourceType: string,
    operation: 'CREATE' | 'UPDATE',
    deferred: ReadonlyMap<string, DeferredReadinessEntry>
  ): void {
    if (deferred.size === 0) {
      this.entries.delete(logicalId);
      return;
    }
    this.entries.set(logicalId, {
      resourceType,
      operation,
      physicalIds: [...deferred.keys()],
      waits: [...deferred.values()],
    });
  }

  /** Whether any operation of this deploy deferred a readiness wait. */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** Whether `logicalId`'s readiness wait was skipped in this deploy. */
  isDeferred(logicalId: string): boolean {
    return this.entries.has(logicalId);
  }

  /** The logical id whose deferred wait was reported for `physicalId`, if any. */
  logicalIdOf(physicalId: string): string | undefined {
    for (const [logicalId, entry] of this.entries) {
      if (entry.physicalIds.includes(physicalId)) return logicalId;
    }
    return undefined;
  }

  /**
   * Wait for `logicalId` to be ready, or `undefined` when its readiness was
   * not deferred in this deploy. `reason` names THIS consumer's need: it words
   * the line the first need prints, and this consumer's error. Rejects with a
   * {@link ProvisioningError} naming the resource when it ends failed, a
   * {@link ResourceTimeoutError} when its deadline runs out, and an
   * interrupted-wait error on Ctrl-C or a failed sibling.
   */
  awaitReady(logicalId: string, reason: string): Promise<void> | undefined {
    const entry = this.entries.get(logicalId);
    if (entry === undefined) return undefined;
    if (entry.promise === undefined) {
      // In the deferring operation's context: its bags, not this consumer's.
      const started = entry.waits[0]!.inContext(() => this.run(logicalId, entry, reason));
      // Every consumer awaits its own wrapper below; the raw one is never left unhandled.
      started.catch(() => undefined);
      entry.promise = started;
    }
    return entry.promise.catch((error: unknown) => {
      throw this.consumerError(logicalId, entry, reason, error);
    });
  }

  /**
   * {@link awaitReady} for each of `logicalIds` that was deferred, concurrently.
   * The IAM propagation settles this need STARTS that still have time left are
   * named on ONE line: a custom resource commonly waits for its handler's role
   * and policy and, two hops up, its function's role and policy. A settle whose
   * time has passed waits for nothing and is not named; one an earlier consumer
   * started was named on that consumer's line.
   */
  async awaitAll(logicalIds: Iterable<string>, reason: string): Promise<void> {
    const ids = [...logicalIds];
    const startingSettles = ids.filter((id) => {
      const entry = this.entries.get(id);
      return (
        entry !== undefined &&
        entry.promise === undefined &&
        isIamPropagation(entry) &&
        hasTimeLeft(entry)
      );
    });
    if (startingSettles.length > 0) {
      this.deps.logger.info(
        startingSettles.reduce(
          (text, id) => this.mask(id, text),
          safeMsg`Waiting for IAM to propagate ${String(startingSettles.length)} permission write(s) of this deploy (${startingSettles.join(', ')}): ${reason}`
        )
      );
    }
    const waits: Promise<void>[] = [];
    for (const id of ids) {
      const wait = this.awaitReady(id, reason);
      if (wait !== undefined) waits.push(wait);
    }
    if (waits.length === 0) return;
    // allSettled first, so a second failure is not left unhandled.
    const settled = await Promise.allSettled(waits);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  private mask(logicalId: string, text: string): string {
    return this.deps.mask ? this.deps.mask(logicalId, text) : text;
  }

  private consumerError(
    logicalId: string,
    entry: DeferredEntry,
    reason: string,
    error: unknown
  ): unknown {
    if (isInterruptedWaitError(error) || error instanceof ResourceTimeoutError) return error;
    return new ProvisioningError(
      this.mask(
        logicalId,
        `${logicalId} (${entry.resourceType}) did not become ready (${reason}): ${describeAwsFailure(error).summary}`
      ),
      entry.resourceType,
      logicalId,
      undefined,
      error instanceof Error ? error : undefined
    );
  }

  private async run(logicalId: string, entry: DeferredEntry, reason: string): Promise<void> {
    const { resourceType, operation } = entry;
    if (isIamPropagation(entry)) {
      // Named on the consumer's one line (`awaitAll`); per resource only in debug.
      this.deps.logger.debug(
        this.mask(
          logicalId,
          safeMsg`Waiting for IAM to propagate ${logicalId} (${resourceType}), written moments ago: ${reason}`
        )
      );
    } else {
      this.deps.logger.info(
        this.mask(
          logicalId,
          safeMsg`Waiting for ${logicalId} (${resourceType}), whose readiness wait --no-wait skipped: ${reason}`
        )
      );
    }
    const controller = new AbortController();
    const watch = startInterruptWatch(`Readiness wait for ${logicalId}`);
    let poll: NodeJS.Timeout | undefined;
    const { warnAfterMs, timeoutMs } = this.deps.budget(resourceType, operation);
    // The readiness deadline opens INSIDE each wait's captured context, with
    // every deadline that context carried exited first: the deferring
    // operation's own deadline settled long ago, and its remaining budget
    // (counted from that operation's start) must not bound this wait.
    const deadlineOptions = {
      warnAfterMs,
      timeoutMs,
      onWarn: (elapsedMs: number) =>
        this.deps.logger.info(
          this.mask(
            logicalId,
            safeMsg`Still waiting for ${logicalId} (${resourceType}) to be ready after ${Math.max(1, Math.round(elapsedMs / 60_000))}m`
          )
        ),
      onTimeout: (elapsedMs: number) =>
        new ResourceTimeoutError(
          logicalId,
          resourceType,
          this.deps.region,
          elapsedMs,
          operation,
          timeoutMs
        ),
    };
    try {
      await new Promise<void>((resolve, reject) => {
        poll = setInterval(() => {
          if (watch.isInterrupted() || this.deps.interrupted()) {
            clearInterval(poll);
            controller.abort();
            reject(watch.onInterrupted());
          }
        }, deferredReadinessPoll.intervalMs);
        Promise.all(
          entry.waits.map(({ wait, inContext }) =>
            inContext(() =>
              outsideEnclosingDeadlines(() =>
                withResourceDeadline(() => wait(controller.signal), deadlineOptions)
              )
            )
          )
        ).then(
          () => resolve(),
          (error: unknown) => reject(error)
        );
      });
      this.deps.logger.debug(safeMsg`${logicalId} (${resourceType}) is ready`);
    } finally {
      // Whatever ended the wait (ready, failed, timed out, interrupted), the
      // provider's poll stops with it.
      clearInterval(poll);
      controller.abort();
      watch.dispose();
    }
  }
}
