/// <reference types="node" />

import { beforeEach, onTestFailed } from 'vite-plus/test';

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
 * lines, ~20 KB of the run's ~22 KB of output. The reporter's own output was
 * under a tenth of what a GREEN run printed.
 *
 * The point is not tidiness. A green run's output is what a person or an agent
 * reads to decide whether to trust the run, and 20 KB of notices from PASSING
 * tests is 20 KB a real signal can hide in. So the rule is the one the failure
 * output already follows: say nothing when the test passes, say everything when
 * it does not.
 *
 * Deliberately NOT buffered:
 *
 *   - writes outside a test body (module top level, `beforeAll` / `afterAll`).
 *     A harness announcing the scratch directory it will clean up is diagnostic
 *     about the FILE, and there is no failing test to attach it to.
 *   - anything at all when `CDKD_TEST_STREAM_PASSTHROUGH=1` is set. Debugging a
 *     hang or a crash needs the writes as they happen: a run that never reaches
 *     the end of a test never reaches the replay either.
 */

export type StreamName = 'stdout' | 'stderr';

export interface CapturedWrite {
  readonly stream: StreamName;
  readonly text: string;
}

/** The subset of a writable stream this fence needs — kept narrow so a test can pass a fake. */
export interface FenceableStream {
  write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean;
}

export interface StreamFence {
  /** Patch `stream.write` so writes made between `begin()` and `end()` are buffered. */
  attach(stream: FenceableStream, name: StreamName): void;
  /** Start buffering (called at the start of each test). */
  begin(): void;
  /** Stop buffering; subsequent writes pass straight through. */
  end(): void;
  /**
   * Write everything buffered so far to the stream it was written to, then
   * forget it. `label` heads the replay so a run with several failures says
   * which test each block came from — the attribution the raw writes lack.
   */
  replay(label?: string): void;
  /** What is buffered right now, or `undefined` when not buffering. */
  buffered(): readonly CapturedWrite[] | undefined;
}

const toText = (chunk: string | Uint8Array): string =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

export function createStreamFence(): StreamFence {
  const originals = new Map<StreamName, (chunk: string) => boolean>();

  /**
   * The writes seen since the current test started, or `undefined` when no test
   * is running — which is what lets the out-of-test writes above pass through.
   */
  let captured: CapturedWrite[] | undefined;

  return {
    attach(stream, name) {
      const original = stream.write.bind(stream);
      originals.set(name, (chunk: string) => original(chunk));

      stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
        if (captured === undefined) {
          return original(chunk, encoding, callback);
        }
        captured.push({ stream: name, text: toText(chunk) });
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
      captured = [];
    },

    end() {
      captured = undefined;
    },

    replay(label) {
      if (captured === undefined || captured.length === 0) return;
      const pending = captured;
      // Cleared BEFORE writing so the replay's own writes are not re-captured,
      // and so a second replay in the same test (two `onTestFailed` handlers, a
      // retry) cannot print the same lines twice.
      captured = [];
      if (label !== undefined) {
        originals.get('stderr')?.(`stderr | ${label}\n`);
      }
      for (const write of pending) {
        originals.get(write.stream)?.(write.text);
      }
    },

    buffered() {
      return captured;
    },
  };
}

const INSTALLED_KEY = '__cdkd_stream_fence__';

/** The fence installed over the real process streams, for tests that assert on it. */
export function activeStreamFence(): StreamFence | undefined {
  return (globalThis as Record<string, unknown>)[INSTALLED_KEY] as StreamFence | undefined;
}

export function installStreamFence(): void {
  if (process.env['CDKD_TEST_STREAM_PASSTHROUGH'] === '1') return;

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
    // Reset at the START of a test rather than clearing at the end: a replay
    // driven by `onTestFailed` must still find the buffer, and this file does
    // not get to assume it runs before or after the failure hooks.
    installed.begin();
    onTestFailed((context) => {
      installed.replay(context.task.name);
    });
  });
}
