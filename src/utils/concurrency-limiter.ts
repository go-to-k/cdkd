/**
 * A small in-process concurrency limiter with two priorities.
 *
 * `schedule(task)` runs `task` once fewer than `limit` scheduled tasks are in
 * flight, and otherwise queues it. An URGENT task (the default) queues ahead of
 * every BACKGROUND one, so a caller that is awaiting its answer is never
 * starved behind a queue of speculative work (a prefetch); `promote()` moves an
 * already-queued background task to the urgent end when a caller starts
 * awaiting it. A task's rejection is delivered to its own promise only: the
 * slot is released either way, so one failure cannot wedge the queue.
 *
 * A task never acquires a second slot from inside its body, so the limiter
 * cannot deadlock on itself.
 */

export interface ScheduledTask<T> {
  readonly promise: Promise<T>;
  /**
   * Move this task ahead of every queued background task. A no-op once it has
   * started (or when it was already urgent and queued ahead).
   */
  readonly promote: () => void;
}

export interface ConcurrencyLimiter {
  schedule<T>(task: () => Promise<T>, options?: { background?: boolean }): ScheduledTask<T>;
  /** Tasks currently running. */
  readonly activeCount: number;
  /** Tasks waiting for a slot. */
  readonly pendingCount: number;
}

interface QueueEntry {
  urgent: boolean;
  start: () => void;
}

export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency limit must be a positive integer, got ${String(limit)}`);
  }
  let active = 0;
  // Urgent entries always precede background ones: `insert` keeps the array
  // partitioned, so the head is the next task to run.
  const queue: QueueEntry[] = [];

  const insert = (entry: QueueEntry): void => {
    if (!entry.urgent) {
      queue.push(entry);
      return;
    }
    const firstBackground = queue.findIndex((e) => !e.urgent);
    if (firstBackground === -1) queue.push(entry);
    else queue.splice(firstBackground, 0, entry);
  };

  const drain = (): void => {
    while (active < limit && queue.length > 0) {
      queue.shift()!.start();
    }
  };

  return {
    schedule<T>(task: () => Promise<T>, options?: { background?: boolean }): ScheduledTask<T> {
      let resolveTask!: (value: T) => void;
      let rejectTask!: (reason: unknown) => void;
      const promise = new Promise<T>((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
      });
      const entry: QueueEntry = {
        urgent: options?.background !== true,
        start: () => {
          active++;
          // `Promise.resolve().then(task)` turns a synchronous throw into a
          // rejection, so the slot is released on that path too.
          Promise.resolve()
            .then(task)
            .then(resolveTask, rejectTask)
            .finally(() => {
              active--;
              drain();
            });
        },
      };
      insert(entry);
      drain();
      return {
        promise,
        promote: () => {
          if (entry.urgent) return;
          const index = queue.indexOf(entry);
          if (index === -1) return; // already started
          queue.splice(index, 1);
          entry.urgent = true;
          insert(entry);
        },
      };
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return queue.length;
    },
  };
}
