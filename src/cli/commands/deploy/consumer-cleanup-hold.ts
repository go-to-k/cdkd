import { NestedCleanupQueue } from '../../../deployment/nested-cleanup-scope.js';
import { displayStackName, safeMsg } from '../../../utils/display-safe.js';

/**
 * go-to-k/cdkd#7012: a producer's cleanup phase, held until every stack of
 * the same `cdkd deploy` run that imports its outputs (`Fn::ImportValue`,
 * `Fn::GetStackOutput`) has deployed.
 *
 * A producer that replaces an exported resource deletes the old copy in its
 * cleanup phase, at the end of its own deploy, before its consumers start
 * (they wait for it). A consumer that then fails rolls back to the old
 * imported values, which would name the deleted copy. CloudFormation never
 * gets here: it refuses to update an export while another stack imports it.
 * cdkd lets one run change it when the consumer deploys in the same run
 * (go-to-k/cdkd#6088), so it keeps the old copy until those consumers are
 * done: all deployed, the pass runs as it would have; any one did not (it
 * failed, was cancelled, or never started), the pass is abandoned and every
 * old copy stays recorded in the producer's state, which its next deploy
 * deletes. The producer's state was saved with those entries before its
 * consumers started, so a Ctrl-C or force-quit in between leaves them
 * recorded too.
 *
 * Only a producer with an importing consumer in the run gets a queue, and the
 * engine queues into it only when there is something to delete, so a
 * single-stack deploy and a producer that replaced nothing keep today's
 * timing and make no extra AWS or S3 call.
 */
export class ConsumerCleanupHold<K> {
  /** Producer to the stacks of the run importing its outputs. */
  private readonly consumers: ReadonlyMap<K, ReadonlySet<K>>;
  /** Stack to whether it deployed; first settle wins. */
  private readonly settled = new Map<K, boolean>();
  private readonly waiters = new Set<() => void>();
  private readonly releases = new Map<K, { promise: Promise<void>; resolve: () => void }>();

  private constructor(consumers: ReadonlyMap<K, ReadonlySet<K>>) {
    this.consumers = consumers;
  }

  /**
   * The hold for a run of `stacks`, where `producersOf` answers the stacks a
   * stack imports outputs from. `undefined` when no stack of the run imports
   * from another stack of the run.
   */
  static build<K>(
    stacks: readonly K[],
    producersOf: (stack: K) => Iterable<K>
  ): ConsumerCleanupHold<K> | undefined {
    const inRun = new Set(stacks);
    const consumers = new Map<K, Set<K>>();
    for (const consumer of stacks) {
      for (const producer of producersOf(consumer)) {
        if (producer === consumer || !inRun.has(producer)) continue;
        let set = consumers.get(producer);
        if (set === undefined) consumers.set(producer, (set = new Set()));
        set.add(consumer);
      }
    }
    return consumers.size === 0 ? undefined : new ConsumerCleanupHold(consumers);
  }

  /** Whether a stack of the run imports `producer`'s outputs. */
  hasConsumers(producer: K): boolean {
    return this.consumers.has(producer);
  }

  /** The queue a producer's engine holds its cleanup in; `undefined` for any other stack. */
  queueFor(producer: K): NestedCleanupQueue | undefined {
    return this.hasConsumers(producer) ? new NestedCleanupQueue() : undefined;
  }

  /** `stack` deployed (`true`), or ended any other way (`false`). The first call wins. */
  settle(stack: K, deployed: boolean): void {
    if (this.settled.has(stack)) return;
    this.settled.set(stack, deployed);
    for (const wake of [...this.waiters]) wake();
  }

  /** The run is over: a stack never settled did not deploy. */
  settleRest(): void {
    for (const set of this.consumers.values()) {
      for (const consumer of set) this.settle(consumer, false);
    }
  }

  /** Resolves once `producer`'s deploy hands its held cleanup over (`waitForConsumers`). */
  released(producer: K): Promise<void> {
    return this.releaseOf(producer).promise;
  }

  /**
   * Called by a producer whose engine queued its cleanup: lets the run go on
   * to its consumers, then waits until each one settled. Answers the
   * consumers that did not deploy.
   */
  async waitForConsumers(producer: K): Promise<K[]> {
    this.releaseOf(producer).resolve();
    const consumers = [...(this.consumers.get(producer) ?? [])];
    while (consumers.some((consumer) => !this.settled.has(consumer))) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
    return consumers.filter((consumer) => this.settled.get(consumer) !== true);
  }

  private releaseOf(producer: K): { promise: Promise<void>; resolve: () => void } {
    let release = this.releases.get(producer);
    if (release === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      release = { promise, resolve };
      this.releases.set(producer, release);
    }
    return release;
  }
}

interface HoldLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * A producer's held cleanup, run from its own deploy (its clients, lock
 * manager and state backend still open): waits for the consumers, then runs
 * the queue, or abandons it with one line naming the consumers that did not
 * deploy. Answers the partial updates the pass left (exit 2).
 */
export async function runHeldProducerCleanup<K extends { stackName: string }>(
  hold: ConsumerCleanupHold<K>,
  queue: NestedCleanupQueue,
  producer: K,
  logger: HoldLogger
): Promise<{ updatePartial: number; nestedUpdatePartial: number }> {
  const notDeployed = await hold.waitForConsumers(producer);
  if (notDeployed.length > 0) {
    logger.info(
      safeMsg`Keeping the replaced resources of stack ${displayStackName(producer.stackName)}: ${notDeployed.map((c) => displayStackName(c.stackName)).join(', ')}, which imports its outputs, did not deploy and may still use them. cdkd keeps them in state, and the next deploy deletes them`
    );
    queue.abandon('consumer-failed');
    return { updatePartial: 0, nestedUpdatePartial: 0 };
  }
  // The producer's deploy took its SIGINT handler with it: a Ctrl-C now stops
  // the queue between passes (each pass installs its own while it runs).
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);
  try {
    return await queue.runAll({ interrupted: () => interrupted }, logger);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
