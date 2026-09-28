/**
 * A small in-process concurrency limiter with two priorities.
 *
 * `schedule(task)` runs `task` once fewer than `limit` scheduled tasks are in
 * flight, and otherwise queues it. An URGENT task (the default) queues ahead of
 * every BACKGROUND one, so a caller that is awaiting its answer is never
 * starved behind a queue of speculative work (a prefetch); `promote()` makes a
 * background task urgent when a caller starts awaiting it. A task's rejection
 * is delivered to its own promise only: the slot is released either way, so
 * one failure cannot wedge the queue.
 *
 * `cancel()` withdraws a task that is STILL background: a queued one is
 * dropped, a running one has its `AbortSignal` aborted, and either way its
 * promise rejects with {@link BackgroundTaskCancelledError}. An urgent task —
 * including a promoted one, which a caller is awaiting — is never cancelled.
 *
 * A task never acquires a second slot from inside its body, so the limiter
 * cannot deadlock on itself.
 *
 * A task body receives its {@link TaskUrgency} alongside the signal, so work
 * that behaves differently in the background (a backoff sleep on an unref'd
 * timer) can follow a caller starting to wait on it while it runs (issue
 * #3939).
 */

/** A running task's view of whether anyone is waiting on it. */
export interface TaskUrgency {
  /** Whether the task is urgent NOW: scheduled urgent, or promoted since. */
  readonly urgent: boolean;
  /**
   * Whether a caller is waiting on this task NOW: it is urgent, or an urgent
   * task is QUEUED for a slot. A queued urgent task starts only when a running
   * task releases its slot, so while one waits every running task — background
   * ones included — is on its caller's path, and must not let the process
   * exit under it. False again once no urgent task is queued.
   */
  readonly awaited: boolean;
  /**
   * Call `listener` once when {@link awaited} turns true: on this task's
   * promotion, or when an urgent task is queued behind the running ones — at
   * once if it already is true. Returns a function that removes the listener.
   * A listener must not throw: it runs synchronously, inside the `schedule()`
   * or `promote()` of the caller that is waiting.
   */
  onAwaited(listener: () => void): () => void;
}

export interface ScheduledTask<T> {
  readonly promise: Promise<T>;
  /**
   * Make this task urgent: a queued one moves ahead of every queued background
   * task, and a running one can no longer be cancelled.
   */
  readonly promote: () => void;
  /**
   * Cancel this task if it is still background. Returns whether it was
   * cancelled (false for an urgent / promoted task, or one already settled).
   */
  readonly cancel: () => boolean;
}

export interface ConcurrencyLimiter {
  schedule<T>(
    task: (signal: AbortSignal, urgency: TaskUrgency) => Promise<T>,
    options?: { background?: boolean }
  ): ScheduledTask<T>;
  /** Tasks currently running. */
  readonly activeCount: number;
  /** Tasks waiting for a slot. */
  readonly pendingCount: number;
}

/** The rejection of a background task withdrawn by `cancel()`. */
export class BackgroundTaskCancelledError extends Error {
  constructor() {
    super('Background task cancelled');
    this.name = 'BackgroundTaskCancelledError';
  }
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
  // Every running task's `onAwaited` listeners, fired when an urgent task
  // has to queue: it waits on whichever running task releases a slot first.
  const urgentWaiterListeners = new Set<() => void>();
  const urgentQueued = (): boolean => queue.length > 0 && queue[0]!.urgent;
  const notifyUrgentWaiter = (): void => {
    for (const listener of [...urgentWaiterListeners]) listener();
  };

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
    schedule<T>(
      task: (signal: AbortSignal, urgency: TaskUrgency) => Promise<T>,
      options?: { background?: boolean }
    ): ScheduledTask<T> {
      let resolveTask!: (value: T) => void;
      let rejectTask!: (reason: unknown) => void;
      const promise = new Promise<T>((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
      });
      const controller = new AbortController();
      let settled = false;
      // A cancelled RUNNING task gives its slot back at once rather than when
      // its body notices the abort, so a slow-to-abort call cannot hold up
      // the urgent work behind it.
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        active--;
        drain();
      };
      const promoteListeners = new Set<() => void>();
      const urgency: TaskUrgency = {
        get urgent() {
          return entry.urgent;
        },
        get awaited() {
          return entry.urgent || urgentQueued();
        },
        onAwaited: (listener) => {
          if (urgency.awaited) {
            listener();
            return () => {};
          }
          const remove = (): void => {
            promoteListeners.delete(once);
            urgentWaiterListeners.delete(once);
          };
          const once = (): void => {
            remove();
            listener();
          };
          promoteListeners.add(once);
          urgentWaiterListeners.add(once);
          return remove;
        },
      };
      const entry: QueueEntry = {
        urgent: options?.background !== true,
        start: () => {
          active++;
          // `Promise.resolve().then(...)` turns a synchronous throw into a
          // rejection, so the slot is released on that path too.
          Promise.resolve()
            .then(() => task(controller.signal, urgency))
            .then(
              (value) => {
                if (settled) return;
                settled = true;
                resolveTask(value);
              },
              (error: unknown) => {
                if (settled) return;
                settled = true;
                rejectTask(error);
              }
            )
            .finally(release);
        },
      };
      insert(entry);
      drain();
      if (entry.urgent && queue.includes(entry)) notifyUrgentWaiter();
      return {
        promise,
        promote: () => {
          if (entry.urgent) return;
          entry.urgent = true;
          for (const listener of [...promoteListeners]) listener();
          const index = queue.indexOf(entry);
          if (index === -1) return; // already running: now uncancellable
          queue.splice(index, 1);
          insert(entry);
          // Still queued, so no slot is free: it waits on the running tasks.
          notifyUrgentWaiter();
        },
        cancel: () => {
          if (entry.urgent || settled) return false;
          settled = true;
          const index = queue.indexOf(entry);
          if (index !== -1) {
            queue.splice(index, 1);
          } else {
            controller.abort();
            release();
          }
          rejectTask(new BackgroundTaskCancelledError());
          return true;
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
