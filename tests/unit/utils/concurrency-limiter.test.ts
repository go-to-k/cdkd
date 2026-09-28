import { describe, it, expect } from 'vite-plus/test';
import {
  BackgroundTaskCancelledError,
  createConcurrencyLimiter,
  type TaskUrgency,
} from '../../../src/utils/concurrency-limiter.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A task the test settles by hand; `started` records the start order. */
function manualTasks(): {
  started: string[];
  task: (name: string) => () => Promise<string>;
  finish: (name: string, error?: Error) => void;
} {
  const started: string[] = [];
  const settle = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  return {
    started,
    task: (name) => () =>
      new Promise<string>((resolve, reject) => {
        started.push(name);
        settle.set(name, { resolve, reject });
      }),
    finish: (name, error) => {
      const s = settle.get(name)!;
      if (error) s.reject(error);
      else s.resolve(name);
    },
  };
}

describe('createConcurrencyLimiter', () => {
  it('never runs more than the limit at once, and runs every task', async () => {
    const limiter = createConcurrencyLimiter(3);
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) =>
          limiter.schedule(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight--;
            return i;
          }).promise
      )
    );
    expect(maxInFlight).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it('a rejecting or synchronously throwing task releases its slot', async () => {
    const limiter = createConcurrencyLimiter(1);
    const failing = limiter.schedule(() => Promise.reject(new Error('boom'))).promise;
    const throwing = limiter.schedule((): Promise<never> => {
      throw new Error('sync');
    }).promise;
    const after = limiter.schedule(() => Promise.resolve('ok')).promise;
    await expect(failing).rejects.toThrow('boom');
    await expect(throwing).rejects.toThrow('sync');
    await expect(after).resolves.toBe('ok');
    expect(limiter.activeCount).toBe(0);
  });

  it('urgent tasks start before queued background tasks, FIFO within each priority', async () => {
    const limiter = createConcurrencyLimiter(1);
    const t = manualTasks();
    limiter.schedule(t.task('first'));
    limiter.schedule(t.task('bg1'), { background: true });
    limiter.schedule(t.task('bg2'), { background: true });
    limiter.schedule(t.task('urgent1'));
    limiter.schedule(t.task('urgent2'));
    await flush();
    for (const name of ['first', 'urgent1', 'urgent2', 'bg1', 'bg2']) {
      t.finish(name);
      await flush();
    }
    expect(t.started).toEqual(['first', 'urgent1', 'urgent2', 'bg1', 'bg2']);
  });

  it('promote() moves a queued background task ahead of the other background ones', async () => {
    const limiter = createConcurrencyLimiter(1);
    const t = manualTasks();
    limiter.schedule(t.task('running'));
    limiter.schedule(t.task('bg1'), { background: true });
    const bg2 = limiter.schedule(t.task('bg2'), { background: true });
    const urgent = limiter.schedule(t.task('urgent'));
    bg2.promote();
    await flush();
    for (const name of ['running', 'urgent', 'bg2', 'bg1']) {
      t.finish(name);
      await flush();
    }
    // Promoted: ahead of bg1, but behind the urgent task already waiting.
    expect(t.started).toEqual(['running', 'urgent', 'bg2', 'bg1']);
    await expect(bg2.promise).resolves.toBe('bg2');
    await expect(urgent.promise).resolves.toBe('urgent');
  });

  it('promote() on an already-urgent queued task keeps FIFO among urgent tasks', async () => {
    const limiter = createConcurrencyLimiter(1);
    const t = manualTasks();
    limiter.schedule(t.task('running'));
    limiter.schedule(t.task('u1'));
    const u2 = limiter.schedule(t.task('u2'));
    u2.promote();
    await flush();
    for (const name of ['running', 'u1', 'u2']) {
      t.finish(name);
      await flush();
    }
    expect(t.started).toEqual(['running', 'u1', 'u2']);
  });

  it('cancel() after a background task finished on its own returns false', async () => {
    const limiter = createConcurrencyLimiter(1);
    const done = limiter.schedule(() => Promise.resolve('done'), { background: true });
    await expect(done.promise).resolves.toBe('done');
    expect(done.cancel()).toBe(false);
  });

  it('promote() after a task started is a no-op', async () => {
    const limiter = createConcurrencyLimiter(1);
    const t = manualTasks();
    const running = limiter.schedule(t.task('running'), { background: true });
    await flush();
    running.promote();
    expect(limiter.pendingCount).toBe(0);
    t.finish('running');
    await expect(running.promise).resolves.toBe('running');
  });

  it('cancel() drops a queued background task and aborts a running one, freeing its slot', async () => {
    const limiter = createConcurrencyLimiter(1);
    let seen: AbortSignal | undefined;
    const running = limiter.schedule(
      (signal) => {
        seen = signal;
        return new Promise<string>(() => {}); // ignores the abort on purpose
      },
      { background: true }
    );
    const queued = limiter.schedule(() => Promise.resolve('never'), { background: true });
    const after = limiter.schedule(() => Promise.resolve('after'));
    await flush();

    expect(queued.cancel()).toBe(true);
    expect(running.cancel()).toBe(true);
    expect(seen?.aborted).toBe(true);
    await expect(running.promise).rejects.toBeInstanceOf(BackgroundTaskCancelledError);
    await expect(queued.promise).rejects.toBeInstanceOf(BackgroundTaskCancelledError);
    // The slot came back although the aborted body never settled.
    await expect(after.promise).resolves.toBe('after');
    expect(limiter.pendingCount).toBe(0);
    expect(running.cancel()).toBe(false); // idempotent
  });

  it('cancel() never touches an urgent task, nor a background one promoted while running or queued', async () => {
    const limiter = createConcurrencyLimiter(1);
    const t = manualTasks();
    const urgent = limiter.schedule(t.task('urgent'));
    const promotedQueued = limiter.schedule(t.task('pq'), { background: true });
    promotedQueued.promote();
    expect(urgent.cancel()).toBe(false);
    expect(promotedQueued.cancel()).toBe(false);
    await flush();
    t.finish('urgent');
    await flush();

    const limiter2 = createConcurrencyLimiter(1);
    const promotedRunning = limiter2.schedule(t.task('pr'), { background: true });
    await flush();
    promotedRunning.promote();
    expect(promotedRunning.cancel()).toBe(false);
    t.finish('pr');
    t.finish('pq');
    await expect(promotedRunning.promise).resolves.toBe('pr');
    await expect(promotedQueued.promise).resolves.toBe('pq');
  });

  it('a task sees its CURRENT urgency: promoted while running, the listener fires once', async () => {
    const limiter = createConcurrencyLimiter(1);
    let seen: TaskUrgency | undefined;
    let finish!: () => void;
    const task = limiter.schedule(
      (_signal, urgency) => {
        seen = urgency;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      { background: true }
    );
    await flush();
    expect(seen!.urgent).toBe(false);
    let fired = 0;
    let removedFired = 0;
    seen!.onAwaited(() => fired++);
    const remove = seen!.onAwaited(() => removedFired++);
    remove();

    task.promote();
    task.promote();
    expect(seen!.urgent).toBe(true);
    expect(fired).toBe(1);
    expect(removedFired).toBe(0);
    // Already urgent: a new listener runs at once.
    let late = 0;
    seen!.onAwaited(() => late++);
    expect(late).toBe(1);
    finish();
    await task.promise;
  });

  it('a task promoted while QUEUED starts already urgent; an urgent one starts urgent', async () => {
    const limiter = createConcurrencyLimiter(1);
    const t = manualTasks();
    const blocker = limiter.schedule(t.task('blocker'));
    const urgencies: boolean[] = [];
    const queued = limiter.schedule(
      async (_signal, urgency) => {
        urgencies.push(urgency.urgent);
      },
      { background: true }
    );
    queued.promote();
    const urgent = limiter.schedule(async (_signal, urgency) => {
      urgencies.push(urgency.urgent);
    });
    await flush();
    t.finish('blocker');
    await Promise.all([blocker.promise, queued.promise, urgent.promise]);
    expect(urgencies).toEqual([true, true]);
  });

  it("promoting one task fires only ITS listeners, never another task's", async () => {
    const limiter = createConcurrencyLimiter(2);
    const urgencies: TaskUrgency[] = [];
    const finishes: Array<() => void> = [];
    const start = (): ReturnType<typeof limiter.schedule<void>> =>
      limiter.schedule(
        (_signal, urgency) => {
          urgencies.push(urgency);
          return new Promise<void>((resolve) => finishes.push(resolve));
        },
        { background: true }
      );
    const a = start();
    const b = start();
    await flush();
    const fired = [0, 0];
    urgencies[0]!.onAwaited(() => fired[0]!++);
    urgencies[1]!.onAwaited(() => fired[1]!++);
    a.promote();
    expect(fired).toEqual([1, 0]);
    expect(urgencies.map((u) => u.urgent)).toEqual([true, false]);
    for (const finish of finishes) finish();
    await Promise.all([a.promise, b.promise]);
  });

  it('an urgent task QUEUED behind running background tasks makes each of them awaited, until it starts', async () => {
    const limiter = createConcurrencyLimiter(2);
    const urgencies: TaskUrgency[] = [];
    const finishes: Array<() => void> = [];
    const background = (): ReturnType<typeof limiter.schedule<void>> =>
      limiter.schedule(
        (_signal, urgency) => {
          urgencies.push(urgency);
          return new Promise<void>((resolve) => finishes.push(resolve));
        },
        { background: true }
      );
    const a = background();
    const b = background();
    await flush();
    const fired = [0, 0];
    urgencies[0]!.onAwaited(() => fired[0]!++);
    urgencies[1]!.onAwaited(() => fired[1]!++);
    expect(urgencies.map((u) => u.awaited)).toEqual([false, false]);

    // No slot is free, so the urgent task queues and waits on A and B.
    const urgent = limiter.schedule(() => Promise.resolve('u'));
    expect(fired).toEqual([1, 1]);
    expect(urgencies.map((u) => [u.urgent, u.awaited])).toEqual([
      [false, true],
      [false, true],
    ]);

    finishes[0]!();
    await expect(urgent.promise).resolves.toBe('u');
    // It has started: B, still background, is no longer waited on.
    expect(urgencies[1]!.awaited).toBe(false);
    finishes[1]!();
    await Promise.all([a.promise, b.promise]);
  });

  it('promoting a QUEUED task makes the running background ones awaited; an urgent task that starts at once does not', async () => {
    const limiter = createConcurrencyLimiter(2);
    let running!: TaskUrgency;
    const finishes: Array<() => void> = [];
    const a = limiter.schedule(
      (_signal, urgency) => {
        running = urgency;
        return new Promise<void>((resolve) => finishes.push(resolve));
      },
      { background: true }
    );
    await flush();
    let fired = 0;
    running.onAwaited(() => fired++);
    // A free slot: this urgent task starts at once, nobody waits on A.
    const direct = limiter.schedule(() => new Promise<void>((resolve) => finishes.push(resolve)));
    await flush();
    expect(fired).toBe(0);
    expect(running.awaited).toBe(false);

    const queued = limiter.schedule(() => Promise.resolve('q'), { background: true });
    expect(fired).toBe(0);
    queued.promote();
    expect(fired).toBe(1);
    expect(running.awaited).toBe(true);
    for (const finish of finishes) finish();
    await Promise.all([a.promise, direct.promise, queued.promise]);
  });

  it('refuses a non-positive limit', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow('positive integer');
    expect(() => createConcurrencyLimiter(1.5)).toThrow('positive integer');
  });
});
