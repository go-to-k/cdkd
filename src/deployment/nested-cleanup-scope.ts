import { AsyncLocalStorage } from 'node:async_hooks';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { asIsMessage, displayStackName, safeMsg } from '../utils/display-safe.js';

/**
 * The cleanup phase of a nested stack tree (go-to-k/cdkd#6398).
 *
 * CloudFormation deletes the resources a stack update replaced only once the
 * WHOLE stack tree's update succeeded: a nested stack's cleanup waits for its
 * root. A nested child's engine finishes inside its parent's DAG, while a
 * sibling child or the parent may still reference the child's old resource
 * (a renamed schedule group another child's schedules live in), so it must
 * not run its own cleanup pass then. It hands the pass to the ROOT engine
 * instead, through the queue bound here.
 *
 * Bound by the ROOT engine (no `parentStackInfo`) around its
 * `executeDeployment`, and read by every descendant engine: a child never
 * rebinds, so a grandchild reaches the root as a child does. The root drains
 * the queue before its own cleanup pass, once its outputs resolved, on
 * success only, and closes it when
 * the deploy fails or is interrupted. A child that finds no queue (no root
 * engine above it) or a closed one (the root's rollback re-creating it) runs
 * its pass itself, as before.
 */
export interface QueuedNestedCleanup {
  /** The child stack, named on the root's cleanup line. */
  readonly stackName: string;
  /**
   * go-to-k/cdkd#7012: a top-level producer's own pass, held for the stacks
   * of the run that import its outputs, rather than a nested child's.
   */
  readonly producer?: true;
  /**
   * Runs the child's cleanup pass and persists what it deleted. Never meant
   * to throw; a throw is reported and the next entry still runs.
   */
  readonly run: (context: NestedCleanupContext) => Promise<NestedCleanupOutcome>;
  /**
   * The root failed or was interrupted first, or (go-to-k/cdkd#7012) a stack
   * importing the producer's outputs did not deploy: the pass never runs.
   */
  readonly abandon: (why: CleanupAbandonCause) => void;
  /**
   * The root succeeded but the pass could not run (or threw): warn per entry
   * left, and count each as a partial update, the exit-2 contract for a
   * survivor the deploy did not address.
   */
  readonly fail: () => NestedCleanupOutcome;
}

export type CleanupAbandonCause = 'failed' | 'interrupted' | 'consumer-failed';

export interface NestedCleanupContext {
  /** The ROOT engine's interrupt flag, read live. */
  readonly interrupted: () => boolean;
}

export interface NestedCleanupOutcome {
  /** Rows the pass turned into a partial update (an old resource left in AWS). */
  readonly updatePartial: number;
}

interface CleanupLogger {
  info(message: string): void;
  warn(message: string): void;
}

export class NestedCleanupQueue {
  private readonly entries: QueuedNestedCleanup[] = [];
  private open = true;

  /** Queue a child's pass; `false` once the root drained or abandoned the queue. */
  enqueue(entry: QueuedNestedCleanup): boolean {
    if (!this.open) return false;
    this.entries.push(entry);
    return true;
  }

  /** How many passes wait in the queue. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * go-to-k/cdkd#7012: hand every queued pass, in order, to `other` (a
   * producer's held queue) and close this one, as `runAll` would. Each runs
   * later in the async context of this call, where `runAll` would have run it.
   */
  drainInto(other: NestedCleanupQueue): void {
    this.open = false;
    const inThisScope = AsyncLocalStorage.snapshot();
    for (const entry of this.entries.splice(0)) {
      const moved: QueuedNestedCleanup = {
        ...entry,
        run: (context) => inThisScope(() => entry.run(context)),
      };
      if (!other.enqueue(moved)) entry.abandon('failed');
    }
  }

  /**
   * The root's success: run every queued pass, in the order the children
   * finished (a grandchild before its parent child), one stack at a time,
   * BEFORE the root's own pass, so a child's old resource goes before the
   * parent's old resource it used (dependents first, as within a stack). An
   * interrupt between stacks stops it; what is left stays recorded in each
   * child's state for the next deploy.
   */
  async runAll(
    context: NestedCleanupContext,
    logger: CleanupLogger
  ): Promise<NestedCleanupOutcome & { readonly nestedUpdatePartial: number }> {
    this.open = false;
    let updatePartial = 0;
    let nestedUpdatePartial = 0;
    for (let entry = this.entries.shift(); entry !== undefined; entry = this.entries.shift()) {
      if (context.interrupted()) {
        entry.abandon('interrupted');
        for (const rest of this.entries.splice(0)) rest.abandon('interrupted');
        break;
      }
      const kind = entry.producer === true ? 'stack' : 'nested stack';
      logger.info(
        safeMsg`Deleting the replaced resources of ${kind} ${displayStackName(entry.stackName)}`
      );
      let left: number;
      try {
        left = (await entry.run(context)).updatePartial;
      } catch (error) {
        logger.warn(
          safeMsg`  ⚠ The cleanup of ${kind} ${displayStackName(entry.stackName)} failed: ${asIsMessage(describeAwsFailure(error).summary)}. Its old resources were not deleted`
        );
        left = entry.fail().updatePartial;
      }
      updatePartial += left;
      if (entry.producer !== true) nestedUpdatePartial += left;
    }
    return { updatePartial, nestedUpdatePartial };
  }

  /** The root failed or was interrupted: no queued pass runs. */
  abandon(why: CleanupAbandonCause): void {
    this.open = false;
    for (const entry of this.entries.splice(0)) entry.abandon(why);
  }
}

const nestedCleanupStore = new AsyncLocalStorage<NestedCleanupQueue>();

export function withNestedCleanupQueue<T>(queue: NestedCleanupQueue, fn: () => T): T {
  return nestedCleanupStore.run(queue, fn);
}

/** The root engine's queue, or `undefined` when no root engine is on the stack. */
export function getNestedCleanupQueue(): NestedCleanupQueue | undefined {
  return nestedCleanupStore.getStore();
}
