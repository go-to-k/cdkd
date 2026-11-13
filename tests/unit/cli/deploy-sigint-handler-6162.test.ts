import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  createDeploySigintHandler,
  exitAfterAbortingUploads,
} from '../../../src/cli/commands/deploy/helpers.js';

/**
 * go-to-k/cdkd#6162: deploy's first Ctrl-C waits for operations in progress,
 * asset uploads included; the second aborts the in-flight multipart uploads,
 * prints which, and only THEN exits.
 */
afterEach(() => {
  vi.useRealTimers();
});

const DEST = 's3://cdkd-assets-1-us-east-1/abc.zip';

function harness(done: Promise<void>, destinations: string[] = [DEST]) {
  const order: string[] = [];
  const onFirst = vi.fn(() => void order.push('onFirst'));
  const exit = vi.fn((code: number) => void order.push(`exit ${code}`));
  const write = vi.fn((text: string) => void order.push(`write ${text.trim()}`));
  const abort = vi.fn(() => {
    order.push('abort');
    return { destinations, done };
  });
  const handler = createDeploySigintHandler({ onFirst, write, exit, abort, budgetMs: 1000 });
  return { handler, order, onFirst, exit, abort, write };
}

describe('deploy SIGINT handler', () => {
  it('first signal: no abort, no exit — the in-flight uploads run on', async () => {
    const h = harness(Promise.resolve());
    h.handler();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.onFirst).toHaveBeenCalledTimes(1);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.order).toEqual([
      'write Interrupted — waiting for in-progress operations to complete...',
      'onFirst',
    ]);
  });

  it('second signal: aborts, prints the interruption naming the uploads, THEN exits 130', async () => {
    let finish!: () => void;
    const h = harness(new Promise<void>((r) => (finish = r)));
    h.handler();
    h.handler();
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled(); // still aborting
    finish();
    await new Promise((r) => setTimeout(r, 0));
    const tail = h.order.slice(h.order.indexOf('abort'));
    expect(tail).toEqual([
      'abort',
      `write Interrupted: aborted the in-flight asset upload(s) ${DEST}.`,
      'exit 130',
    ]);
  });

  it('second signal with nothing in flight: no interruption line, still exits', async () => {
    const h = harness(Promise.resolve(), []);
    h.handler();
    h.handler();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.order.some((l) => l.startsWith('write Interrupted:'))).toBe(false);
    expect(h.exit).toHaveBeenCalledWith(130);
  });

  it('third signal while aborting: exits at once', () => {
    const h = harness(new Promise<void>(() => undefined));
    h.handler();
    h.handler();
    h.handler();
    expect(h.exit).toHaveBeenCalledWith(130);
  });
});

describe('exitAfterAbortingUploads', () => {
  it('exits once the abort settles', async () => {
    const exit = vi.fn();
    await exitAfterAbortingUploads(exit, () => undefined, () => ({
      destinations: [],
      done: Promise.resolve(),
    }));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('exits on the budget when the abort hangs, says so, and exits only once', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const write = vi.fn();
    let finish!: () => void;
    const done = exitAfterAbortingUploads(
      exit,
      write,
      () => ({ destinations: [DEST], done: new Promise<void>((r) => (finish = r)) }),
      1000
    );
    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain(
      `exiting before the abort of the in-flight asset upload(s) ${DEST} was confirmed`
    );
    finish();
    await done;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
