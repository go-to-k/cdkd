import { describe, it, expect } from 'vite-plus/test';

import {
  activeStreamFence,
  createStreamFence,
  type FenceableStream,
} from '../stream-fence.js';

/**
 * A stand-in for `process.stdout` / `process.stderr` that records what actually
 * reached the terminal. The fence patches `write` in place, so every assertion
 * below distinguishes "buffered" (nothing here) from "printed" (here).
 */
function fakeStream(): FenceableStream & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    write(chunk: string | Uint8Array) {
      printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  };
}

describe('createStreamFence', () => {
  it('passes writes straight through before a test begins', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    err.write('module top level\n');

    expect(err.printed).toEqual(['module top level\n']);
    expect(fence.buffered()).toBeUndefined();
  });

  it('buffers writes made during a test instead of printing them', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('Warning: --region is deprecated\n');

    expect(err.printed).toEqual([]);
    expect(fence.buffered()).toEqual([
      { stream: 'stderr', text: 'Warning: --region is deprecated\n' },
    ]);
  });

  it('replays the buffer to the stream each line was written to, in order', () => {
    const fence = createStreamFence();
    const out = fakeStream();
    const err = fakeStream();
    fence.attach(out, 'stdout');
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('first\n');
    out.write('second\n');
    err.write('third\n');
    fence.replay();

    expect(err.printed).toEqual(['first\n', 'third\n']);
    expect(out.printed).toEqual(['second\n']);
  });

  it('heads the replay with the failing test name, on stderr', () => {
    // The raw writes carry no attribution — that is the whole reason they are
    // a problem in a run's output. A replay driven by a failure knows which
    // test it belongs to, so it says so.
    const fence = createStreamFence();
    const out = fakeStream();
    const err = fakeStream();
    fence.attach(out, 'stdout');
    fence.attach(err, 'stderr');

    fence.begin();
    out.write('a stdout notice\n');
    fence.replay('destroy > releases the lock');

    expect(err.printed).toEqual(['stderr | destroy > releases the lock\n']);
    expect(out.printed).toEqual(['a stdout notice\n']);
  });

  it('emits no header when the replay is unlabelled', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('body\n');
    fence.replay();

    expect(err.printed).toEqual(['body\n']);
  });

  it('does not print the same line twice when replayed more than once', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('once\n');
    fence.replay();
    fence.replay();

    expect(err.printed).toEqual(['once\n']);
  });

  it('does not re-capture the writes its own replay makes', () => {
    // The buffer is cleared BEFORE the replay writes, so a replay running while
    // capture is still active cannot feed itself. Without that ordering the
    // same line would sit in the buffer again after the replay returned.
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('boom\n');
    fence.replay();

    expect(err.printed).toEqual(['boom\n']);
    expect(fence.buffered()).toEqual([]);
  });

  it('invokes the completion callback of a swallowed write in both call shapes', () => {
    // A caller may await the callback. Swallowing the write must not also
    // swallow its completion signal, or a `write(chunk, cb)` in product code
    // would hang for the duration of the test.
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');
    fence.begin();

    let twoArg = false;
    let threeArg = false;
    err.write('a\n', () => {
      twoArg = true;
    });
    err.write('b\n', 'utf8', () => {
      threeArg = true;
    });

    expect(twoArg).toBe(true);
    expect(threeArg).toBe(true);
    expect(err.printed).toEqual([]);
  });

  it('decodes a Uint8Array chunk so the replay is readable text', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write(new TextEncoder().encode('bytes\n'));
    fence.replay();

    expect(err.printed).toEqual(['bytes\n']);
  });

  it('goes back to passing through after the test ends', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    fence.end();
    err.write('afterAll diagnostic\n');

    expect(err.printed).toEqual(['afterAll diagnostic\n']);
    expect(fence.buffered()).toBeUndefined();
  });
});

describe('the fence installed over the real process streams', () => {
  const passthrough = process.env['CDKD_TEST_STREAM_PASSTHROUGH'] === '1';

  it.skipIf(passthrough)('is active while this very test runs', () => {
    // The wiring, not the logic: proves `tests/setup.ts` installed the fence
    // AND that its `beforeEach` began a capture for this test. Without both,
    // the line below would land in the run's output.
    const fence = activeStreamFence();
    expect(fence).toBeDefined();

    const marker = 'stream-fence live check — this line must not reach the run output\n';
    process.stderr.write(marker);

    expect(fence?.buffered()?.some((w) => w.text === marker)).toBe(true);
  });

  it.skipIf(!passthrough)('is not installed under CDKD_TEST_STREAM_PASSTHROUGH=1', () => {
    expect(activeStreamFence()).toBeUndefined();
  });
});
