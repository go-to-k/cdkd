/// <reference types="node" />

import { beforeEach, onTestFailed, onTestFinished } from 'vite-plus/test';

/**
 * Buffer direct `process.stdout` / `process.stderr` writes made DURING a test,
 * and replay them only if that test fails.
 *
 * Vitest attributes and (under this repo's reporter) suppresses `console.*`,
 * but a raw `stream.write()` bypasses that entirely and lands in the run's
 * output unattributed. Product code writes that way on purpose in the few
 * places where the logger is the wrong channel — the deprecated-`--region`
 * notice (`src/cli/options.ts`), the SIGINT notices in
 * `src/provisioning/interrupt-watch.ts` and `src/cli/commands/destroy-runner.ts`,
 * the critic summaries under `scripts/` — so the suites exercising those paths
 * legitimately trigger them. Measured 2026-08-30 on the full suite: 108 such
 * lines, ~20 KB of `vp test run`'s ~22 KB of output. The reporter's own output
 * was under a tenth of what a GREEN run printed.
 *
 * The point is not tidiness. A green run's output is what a person or an agent
 * reads to decide whether to trust the run, and 20 KB of notices from PASSING
 * tests is 20 KB a real signal can hide in. So the rule is the one the failure
 * output already follows: say nothing when the test passes, say everything when
 * it does not.
 *
 * Capture is bounded by the TEST, not merely started by it. `onTestFinished`
 * stops it while KEEPING the buffer, because vitest runs
 * `afterEach` -> `onTestFinished` -> `onTestFailed` (verified against
 * `@vitest/runner` 4.1.10) and a replay driven by the last of those must still
 * find something to replay. Without that stop the fence never turns off after
 * the first test: `afterAll`, a later `beforeAll`, and the next file's module
 * top level in a reused worker would all be captured and then silently dropped
 * by the following `begin()` — swallowing diagnostics rather than deferring
 * them, which is strictly worse than the noise this exists to remove.
 *
 * Deliberately NOT buffered:
 *
 *   - writes outside a test body (module top level, `beforeAll` / `afterAll`).
 *     A harness announcing the scratch directory it will clean up is diagnostic
 *     about the FILE, and there is no failing test to attach it to.
 *     `beforeEach` and `afterEach` are INSIDE the fence, not outside it: they
 *     bracket a specific test, and `finish()` runs at `onTestFinished`, which is
 *     after `afterEach`. So a per-test hook's writes are replayed when that test
 *     fails and dropped when it passes — the same rule as the test body, which
 *     is the point, since that is where a `withRetry` teardown notice comes
 *     from.
 *   - anything at all when `CDKD_TEST_STREAM_PASSTHROUGH=1` is set. Debugging a
 *     hang or a crash needs the writes as they happen: a run that never reaches
 *     the end of a test never reaches the replay either.
 *
 * Known limit: one buffer per worker, so the fence assumes tests within a file
 * run SERIALLY. `it.concurrent` / `describe.concurrent` would let one test's
 * `begin()` wipe a peer's buffer and let a failure replay another test's
 * writes. This repo uses neither, and
 * `tests/unit/stream-fence.test.ts` fails if that stops being true.
 */

export type StreamName = 'stdout' | 'stderr';

export interface CapturedWrite {
  readonly stream: StreamName;
  /** The chunk exactly as the caller passed it, so the replay is byte-faithful. */
  readonly chunk: string | Uint8Array;
  /** The caller's encoding argument, if it passed one rather than a callback. */
  readonly encoding: BufferEncoding | undefined;
  /** A readable rendering of {@link chunk}, for assertions and for grepping a replay. */
  readonly text: string;
}

/** The subset of a writable stream this fence needs — kept narrow so a test can pass a fake. */
export interface FenceableStream {
  write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean;
}

export interface StreamFence {
  /** Patch `stream.write` so writes made while capturing are buffered. */
  attach(stream: FenceableStream, name: StreamName): void;
  /** Start capturing, discarding any previous test's buffer. */
  begin(): void;
  /** Stop capturing but KEEP the buffer, so a later `replay()` can still read it. */
  finish(): void;
  /** Write everything buffered so far to the stream it was written to, then forget it. */
  replay(label?: string): void;
  /** What is buffered right now, or `undefined` when nothing has been captured yet. */
  buffered(): readonly CapturedWrite[] | undefined;
  /** Whether writes are currently being diverted into the buffer. */
  capturing(): boolean;
}

const isBufferEncoding = (value: unknown): value is BufferEncoding => typeof value === 'string';

const render = (chunk: string | Uint8Array, encoding: BufferEncoding | undefined): string => {
  if (typeof chunk !== 'string') return Buffer.from(chunk).toString('utf8');
  // `write('deadbeef', 'hex')` writes BYTES, not those eight characters, so the
  // readable rendering has to decode the same way the stream would.
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8') {
    return Buffer.from(chunk, encoding).toString('utf8');
  }
  return chunk;
};

export function createStreamFence(): StreamFence {
  const originals = new Map<StreamName, FenceableStream['write']>();

  let capturing = false;
  let captured: CapturedWrite[] | undefined;

  const writeThrough = (write: CapturedWrite): void => {
    const original = originals.get(write.stream) ?? originals.values().next().value;
    if (write.encoding === undefined) original?.(write.chunk);
    else original?.(write.chunk, write.encoding);
  };

  return {
    attach(stream, name) {
      const original = stream.write.bind(stream);
      originals.set(name, original);

      stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
        if (!capturing) {
          return original(chunk, encoding, callback);
        }
        const enc = isBufferEncoding(encoding) ? encoding : undefined;
        (captured ??= []).push({ stream: name, chunk, encoding: enc, text: render(chunk, enc) });
        // `write(chunk, cb)` and `write(chunk, encoding, cb)` are both real call
        // shapes and a caller may be awaiting that callback. Swallowing the
        // write must not also swallow its completion signal.
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') {
          (done as () => void)();
        }
        return true;
      }) as FenceableStream['write'];
    },

    begin() {
      capturing = true;
      captured = [];
    },

    finish() {
      capturing = false;
    },

    replay(label) {
      if (captured === undefined || captured.length === 0) return;
      const pending = captured;
      // Cleared BEFORE writing so a second replay in the same test (two
      // `onTestFailed` handlers, a retry) cannot print the same lines twice.
      captured = [];
      if (label !== undefined) {
        // Same shape as vitest's own console attribution, so a replay reads
        // like the rest of a failure block.
        writeThrough({
          stream: 'stderr',
          chunk: `stderr | ${label}\n`,
          encoding: undefined,
          text: '',
        });
      }
      for (const write of pending) writeThrough(write);
    },

    buffered() {
      return captured;
    },

    capturing() {
      return capturing;
    },
  };
}

/** Whether the fence should stay out of the way entirely. Exported so both arms are testable. */
export function streamFenceDisabled(env: Record<string, string | undefined>): boolean {
  return env['CDKD_TEST_STREAM_PASSTHROUGH'] === '1';
}

const INSTALLED_KEY = '__cdkd_stream_fence__';

/** The fence installed over the real process streams, for tests that assert on it. */
export function activeStreamFence(): StreamFence | undefined {
  return (globalThis as Record<string, unknown>)[INSTALLED_KEY] as StreamFence | undefined;
}

export function installStreamFence(): void {
  if (streamFenceDisabled(process.env)) return;

  const host = globalThis as Record<string, unknown>;
  let fence = host[INSTALLED_KEY] as StreamFence | undefined;
  if (fence === undefined) {
    fence = createStreamFence();
    host[INSTALLED_KEY] = fence;
    fence.attach(process.stdout, 'stdout');
    fence.attach(process.stderr, 'stderr');
  }

  const installed = fence;
  beforeEach(() => {
    installed.begin();
    // Runs BEFORE `onTestFailed` and keeps the buffer, so this only closes the
    // window — everything after it (a later `beforeAll`, `afterAll`, the next
    // file's top level) writes straight through.
    onTestFinished(() => installed.finish());
    onTestFailed((context) => {
      // `fullName` rather than `name`: two same-named tests in different files
      // are otherwise indistinguishable in a replay.
      installed.replay(context.task.fullName);
    });
  });
}
