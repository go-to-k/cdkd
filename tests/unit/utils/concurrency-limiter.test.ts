import { describe, it, expect } from 'vite-plus/test';
import {
  BackgroundTaskCancelledError,
  createConcurrencyLimiter,
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

  it('refuses a non-positive limit', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow('positive integer');
    expect(() => createConcurrencyLimiter(1.5)).toThrow('positive integer');
  });
});
