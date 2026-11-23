import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  createDeploySigintHandler,
  exitAfterAbortingUploads,
  forceQuitRollbackLine,
} from '../../../src/cli/commands/deploy/helpers.js';
import type { StartedForceQuitFlush } from '../../../src/deployment/force-quit-journal.js';

/**
 * go-to-k/cdkd#6894: deploy's force-quit (the second signal) and a hang-up
 * (SIGHUP) write the rollback journal of each deploy still running before the
 * process exits, inside the same budget as the upload abort.
 */
afterEach(() => {
  vi.useRealTimers();
});

function deferredFlush(pending = 1): {
  flush: () => StartedForceQuitFlush;
  finish: (names: string[]) => void;
  calls: () => number;
} {
  let finish!: (names: string[]) => void;
  const done = new Promise<string[]>((r) => (finish = r));
  let calls = 0;
  return {
    flush: () => {
      calls++;
      return { pending, done };
    },
    finish: (names) => finish(names),
    calls: () => calls,
  };
}

function harness(flush: () => StartedForceQuitFlush) {
  const order: string[] = [];
  const onFirst = vi.fn(() => void order.push('onFirst'));
  const exit = vi.fn((code: number) => void order.push(`exit ${code}`));
  const write = vi.fn((text: string) => void order.push(`write ${text.trim()}`));
  const abort = vi.fn(() => ({ destinations: [], done: Promise.resolve() }));
  const handler = createDeploySigintHandler({
    onFirst,
    write,
    exit,
    abort,
    flush,
    budgetMs: 1000,
  });
  return { handler, order, exit, write, abort, onFirst };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('deploy force-quit writes the rollback journal before it exits', () => {
  it('second signal: flushes, prints the rollback command, THEN exits 130', async () => {
    const f = deferredFlush();
    const h = harness(f.flush);
    h.handler();
    expect(f.calls()).toBe(0); // the first signal drains; nothing is flushed
    h.handler();
    expect(f.calls()).toBe(1);
    await tick();
    expect(h.exit).not.toHaveBeenCalled(); // still writing the journal
    f.finish(['MyStack']);
    await tick();
    expect(h.order.slice(-2)).toEqual([
      `write ${forceQuitRollbackLine('MyStack').trim()}`,
      'exit 130',
    ]);
    expect(forceQuitRollbackLine('MyStack')).toContain('cdkd rollback MyStack');
    // The lock-recovery line is still printed.
    expect(h.order.some((l) => l.includes('Release with: cdkd force-unlock'))).toBe(true);
  });

  it('a flush that recorded nothing prints no rollback line', async () => {
    const f = deferredFlush(0);
    const h = harness(f.flush);
    h.handler();
    h.handler();
    f.finish([]);
    await tick();
    expect(h.order.some((l) => l.includes('cdkd rollback'))).toBe(false);
    expect(h.exit).toHaveBeenCalledWith(130);
  });

  it('exits on the budget when the journal write hangs, and says the journal may be missing', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const write = vi.fn();
    const f = deferredFlush();
    const done = exitAfterAbortingUploads(
      exit,
      write,
      () => ({ destinations: [], done: Promise.resolve() }),
      1000,
      f.flush
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'exiting before the rollback journal was written'
    );
    f.finish(['Late']);
    await done;
    expect(exit).toHaveBeenCalledOnce();
    expect(write.mock.calls.map((c) => String(c[0])).join('')).not.toContain('Late');
  });

  it('SIGHUP: force-quits at once (no first-signal drain), flushes, and exits 129', async () => {
    const f = deferredFlush();
    const h = harness(f.flush);
    h.handler.hangup();
    expect(f.calls()).toBe(1);
    expect(h.abort).toHaveBeenCalledOnce();
    // The run is told to stop, so no further stack starts while the journal
    // is written.
    expect(h.onFirst).toHaveBeenCalledOnce();
    expect(h.order.some((l) => l.startsWith('write Interrupted — waiting'))).toBe(false);
    // A later SIGINT / forwarded SIGTERM does not cut the hang-up's flush short.
    h.handler();
    h.handler();
    expect(h.exit).not.toHaveBeenCalled();
    f.finish(['MyStack']);
    await tick();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(129);
    expect(h.order).toContain(`write ${forceQuitRollbackLine('MyStack').trim()}`);
  });

  it('SIGHUP after the first Ctrl-C force-quits with 129', async () => {
    const f = deferredFlush();
    const h = harness(f.flush);
    h.handler();
    h.handler.hangup();
    expect(f.calls()).toBe(1);
    f.finish([]);
    await tick();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(129);
  });

  it('SIGHUP during a Ctrl-C force-quit changes nothing; a third Ctrl-C still exits at once', () => {
    const f = deferredFlush();
    const h = harness(f.flush);
    h.handler();
    h.handler();
    h.handler.hangup();
    expect(f.calls()).toBe(1);
    expect(h.exit).not.toHaveBeenCalled();
    h.handler();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(130);
  });

  it('the budget expiring with no journal write pending says nothing about the journal', async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const exit = vi.fn();
    void exitAfterAbortingUploads(
      exit,
      write,
      () => ({ destinations: [], done: new Promise<void>(() => undefined) }),
      1000,
      () => ({ pending: 0, done: Promise.resolve([]) })
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(write.mock.calls.map((c) => String(c[0])).join('')).not.toContain('rollback journal');
  });

  it('a flush that throws synchronously still exits with the code asked for', async () => {
    const exit = vi.fn();
    await exitAfterAbortingUploads(
      exit,
      () => undefined,
      () => ({ destinations: [], done: Promise.resolve() }),
      1000,
      () => {
        throw new Error('registry broke');
      },
      129
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(129);
  });
});
