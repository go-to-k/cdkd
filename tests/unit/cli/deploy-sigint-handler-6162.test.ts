import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  createDeploySigintHandler,
  exitAfterAbortingUploads,
} from '../../../src/cli/commands/deploy/helpers.js';

/**
 * go-to-k/cdkd#6162: deploy's first Ctrl-C waits for operations in progress,
 * asset uploads included; the second aborts the in-flight multipart uploads
 * and only THEN exits.
 */
afterEach(() => {
  vi.useRealTimers();
});

function harness(abort: () => Promise<void>) {
  const order: string[] = [];
  const onFirst = vi.fn(() => order.push('onFirst'));
  const exit = vi.fn((code: number) => void order.push(`exit ${code}`));
  const wrapped = vi.fn(async () => {
    order.push('abort start');
    await abort();
    order.push('abort done');
  });
  const handler = createDeploySigintHandler({
    onFirst,
    write: () => undefined,
    exit,
    abort: wrapped,
    budgetMs: 1000,
  });
  return { handler, order, onFirst, exit, abort: wrapped };
}

describe('deploy SIGINT handler', () => {
  it('first signal: no abort, no exit — the in-flight uploads run on', async () => {
    const h = harness(async () => undefined);
    h.handler();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.onFirst).toHaveBeenCalledTimes(1);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('second signal: aborts the in-flight uploads, THEN exits 130', async () => {
    let finishAbort!: () => void;
    const h = harness(() => new Promise<void>((r) => (finishAbort = r)));
    h.handler();
    h.handler();
    await Promise.resolve();
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled(); // still aborting
    finishAbort();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.order).toEqual(['onFirst', 'abort start', 'abort done', 'exit 130']);
  });

  it('third signal while aborting: exits at once', async () => {
    const h = harness(() => new Promise<void>(() => undefined));
    h.handler();
    h.handler();
    h.handler();
    expect(h.exit).toHaveBeenCalledWith(130);
  });
});

describe('exitAfterAbortingUploads', () => {
  it('exits once the abort settles, even when it rejects', async () => {
    const exit = vi.fn();
    await exitAfterAbortingUploads(exit, () => Promise.reject(new Error('x')), 1000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('exits on the budget when the abort hangs, and only once', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    let finish!: () => void;
    const done = exitAfterAbortingUploads(exit, () => new Promise((r) => (finish = r)), 1000);
    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledTimes(1);
    finish();
    await done;
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
