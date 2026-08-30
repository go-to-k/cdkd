import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, afterAll } from 'vite-plus/test';

import {
  activeStreamFence,
  createStreamFence,
  streamFenceDisabled,
  type FenceableStream,
} from '../stream-fence.js';

/**
 * A stand-in for `process.stdout` / `process.stderr` that records what actually
 * reached the terminal, and with what arguments. The fence patches `write` in
 * place, so every assertion below distinguishes "buffered" (nothing here) from
 * "printed" (here).
 */
function fakeStream(returns = true): FenceableStream & {
  printed: string[];
  calls: unknown[][];
} {
  const printed: string[] = [];
  const calls: unknown[][] = [];
  return {
    printed,
    calls,
    write(chunk: string | Uint8Array, ...rest: unknown[]) {
      printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      calls.push([chunk, ...rest]);
      return returns;
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
    expect(fence.capturing()).toBe(false);
    expect(fence.buffered()).toBeUndefined();
  });

  it('forwards every argument of a passed-through write and returns the stream own value', () => {
    // Backpressure is real: product code may do `if (!stream.write(x)) await
    // drain`. A wrapper that hardcodes `true`, or drops the encoding, changes
    // the caller's behaviour on a path the fence is supposed to be invisible on.
    const fence = createStreamFence();
    const err = fakeStream(false);
    fence.attach(err, 'stderr');

    const callback = (): void => {};
    const returned = err.write('body\n', 'utf8', callback);

    expect(returned).toBe(false);
    expect(err.calls).toEqual([['body\n', 'utf8', callback]]);
  });

  it('buffers writes made during a test instead of printing them', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('Warning: --region is deprecated\n');

    expect(err.printed).toEqual([]);
    expect(fence.capturing()).toBe(true);
    expect(fence.buffered()?.map((w) => w.text)).toEqual([
      'Warning: --region is deprecated\n',
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
    const fence = createStreamFence();
    const out = fakeStream();
    const err = fakeStream();
    fence.attach(out, 'stdout');
    fence.attach(err, 'stderr');

    fence.begin();
    out.write('a stdout notice\n');
    fence.replay('destroy.test.ts > destroy > releases the lock');

    expect(err.printed).toEqual(['stderr | destroy.test.ts > destroy > releases the lock\n']);
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

  it('falls back to an attached stream for the header when stderr is not one', () => {
    // Guards the `?.` on the header write: dropping the header silently is a
    // worse outcome than putting it on the only stream there is.
    const fence = createStreamFence();
    const out = fakeStream();
    fence.attach(out, 'stdout');

    fence.begin();
    out.write('body\n');
    fence.replay('some > test');

    expect(out.printed).toEqual(['stderr | some > test\n', 'body\n']);
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

  it('replays a non-utf8 encoding faithfully, and renders it decoded', () => {
    // `write('6869', 'hex')` writes the two bytes `hi`, not those four
    // characters. A buffer that keeps only the rendered text would replay the
    // wrong bytes; one that keeps only the chunk would make `buffered()`
    // unreadable.
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('6869', 'hex');

    expect(fence.buffered()?.map((w) => w.text)).toEqual(['hi']);

    fence.replay();
    expect(err.calls).toEqual([['6869', 'hex']]);
  });

  it('stops capturing at finish() but keeps the buffer for a later replay', () => {
    // The ordering this depends on is vitest's: afterEach -> onTestFinished ->
    // onTestFailed. Clearing the buffer at finish() would make every replay
    // empty; not stopping capture at all would swallow afterAll and the next
    // file's top-level writes forever.
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('during the test\n');
    fence.finish();
    err.write('after the test\n');

    expect(fence.capturing()).toBe(false);
    expect(err.printed).toEqual(['after the test\n']);

    fence.replay();
    expect(err.printed).toEqual(['after the test\n', 'during the test\n']);
  });

  it('discards the previous test buffer at begin()', () => {
    const fence = createStreamFence();
    const err = fakeStream();
    fence.attach(err, 'stderr');

    fence.begin();
    err.write('from the passing test\n');
    fence.finish();
    fence.begin();
    fence.replay();

    expect(err.printed).toEqual([]);
  });
});

describe('streamFenceDisabled', () => {
  it('is off by default and on only for the exact opt-out value', () => {
    expect(streamFenceDisabled({})).toBe(false);
    expect(streamFenceDisabled({ CDKD_TEST_STREAM_PASSTHROUGH: '0' })).toBe(false);
    expect(streamFenceDisabled({ CDKD_TEST_STREAM_PASSTHROUGH: 'true' })).toBe(false);
    expect(streamFenceDisabled({ CDKD_TEST_STREAM_PASSTHROUGH: '1' })).toBe(true);
  });
});

describe('the fence installed over the real process streams', () => {
  const passthrough = streamFenceDisabled(process.env);

  it.skipIf(passthrough)('is active while this very test runs', () => {
    // The wiring, not the logic: proves `tests/setup.ts` installed the fence
    // AND that its `beforeEach` began a capture for this test. Without both,
    // the line below would land in the run's output.
    const fence = activeStreamFence();
    expect(fence).toBeDefined();
    expect(fence?.capturing()).toBe(true);

    const marker = 'stream-fence live check — this line must not reach the run output\n';
    process.stderr.write(marker);

    expect(fence?.buffered()?.some((w) => w.text === marker)).toBe(true);
  });

  it.skipIf(!passthrough)('is not installed under CDKD_TEST_STREAM_PASSTHROUGH=1', () => {
    expect(activeStreamFence()).toBeUndefined();
  });
});

// The live half of the finish() contract: `afterAll` runs after the last test's
// `onTestFinished`, so capture must already be off here. If the wiring stopped
// calling finish(), this write would be buffered and then dropped — exactly the
// silent-swallow the fence must not do — and the assertion fails the file.
afterAll(() => {
  if (streamFenceDisabled(process.env)) return;
  expect(activeStreamFence()?.capturing()).toBe(false);
});

describe('the fence assumes tests within a file run serially', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const testFilesUnder = (root: string): string[] => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // `withFileTypes` rather than `statSync`: a broken symlink under
        // `tests/` would make the whole critic throw rather than report.
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(full);
      }
    };
    walk(root);
    return found;
  };

  it('no suite opts into vitest concurrent mode', () => {
    // One buffer per worker: with `it.concurrent`, one test's begin() would
    // wipe a peer's buffer and a failure could replay another test's writes.
    // The fence would have to become per-test-context first.
    //
    // BOTH roots in vite.config.ts's `include` are scanned, not just `tests/**`
    // — `src/**/*.test.ts` runs under the same setup file and the same worker.
    const roots = [join(REPO_ROOT, 'tests'), join(REPO_ROOT, 'src')];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of testFilesUnder(root)) {
        // A CALL or a chain, not the words: this very file and
        // `once-leak-detector.test.ts` both discuss `it.concurrent` in prose,
        // and a bare-word match reports them as offenders. Anchoring on
        // `.concurrent` alone rather than on `it|test|describe` also catches
        // a chained form, where the modifier comes first and the concurrency
        // marker is not preceded by `it` / `test` / `describe` at all.
        if (/\.concurrent\s*[(.<]/.test(readFileSync(file, 'utf8'))) {
          offenders.push(file);
        }
      }
    }

    expect(
      offenders,
      'these suites run concurrently, which the stream fence single buffer cannot ' +
        `serve correctly:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('vite.config.ts does not turn concurrency on globally', () => {
    // The cheapest way to break the assumption is not per-suite at all:
    // `sequence: { concurrent: true }` makes EVERY test concurrent at once, and
    // the per-file scan above would report nothing.
    const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    expect(
      /concurrent\s*:\s*true/.test(config),
      'vite.config.ts enables vitest concurrency globally; the stream fence in ' +
        'tests/stream-fence.ts keeps one buffer per worker and cannot serve that'
    ).toBe(false);
  });
});
