/**
 * Kill a test worker whose event loop stopped turning past the running test's
 * timeout (go-to-k/cdkd#7042).
 *
 * Vitest fails a test at its timeout through a timer, a macrotask. A poll loop
 * that awaits only already-resolved promises never yields to the macrotask
 * queue, so that timer never runs: a provider wait whose sleep double resolves
 * at once (`sleep = async () => {}`, `mockResolvedValue()`) beside a read that
 * never satisfies it spins on microtasks until the wait's own budget expires,
 * which is 30 minutes of real time for most providers. The worker then hangs
 * the run, and outlives a killed parent as a CPU-bound orphan.
 *
 * No code on the stuck thread runs again, so the check lives on a worker
 * thread. The main thread stores a heartbeat from a timer into shared memory,
 * and the running test's timeout from a `beforeEach`. When the heartbeat is
 * older than that timeout plus a grace, the watchdog writes the test's name to
 * stderr and kills the process: vitest reports the file failed ("Worker exited
 * unexpectedly") instead of waiting. Every sleep double, present or future, is
 * covered without touching any of them, and production code is unchanged.
 *
 * Scope and limits:
 * - From a test's `beforeEach` to its `afterEach` the bound
 *   is that test's own timeout, never below the default `hookTimeout`, so a case that declares a longer bound (a spawning case,
 *   `tests/contended-case-timeout.ts`) keeps it. A hook declaring its own
 *   longer timeout is not read, and a `retry` attempt that blocks past the
 *   bound is killed rather than retried.
 * - From an `afterEach` to the next `beforeEach` it stays armed, at
 *   `BETWEEN_TESTS_MS`: a wait a failing test started and never awaited keeps
 *   spinning after it. A new file's collection is unarmed.
 * - A synchronous block (a `spawnSync`, a CPU-bound walk) also stops the
 *   heartbeat; one running past its test's timeout plus the grace is killed
 *   the same way, which vitest could not interrupt either.
 * - It never arms under an attached inspector (a paused debugger stops the
 *   heartbeat), nor with `CDKD_TEST_WATCHDOG=0`.
 * - Overlapping `concurrent` tests share one slot: the first to finish moves it
 *   to the between-tests bound, and the label names the latest to start.
 * - It needs the `forks` pool (vitest's default, which `vite.config.ts`
 *   keeps): under `threads` the kill would stop the whole run.
 */
import inspector from 'node:inspector';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach } from 'vite-plus/test';

import { CONTENDED_CASE_TIMEOUT_MS } from './contended-case-timeout.js';

/** How far past the running test's timeout a stalled event loop is tolerated. */
export const WATCHDOG_GRACE_MS = 5_000;
/** The line the watchdog writes before it kills the worker. */
export const WATCHDOG_MARKER = '[event-loop-watchdog]';

/** vitest's default `hookTimeout`; `vite.config.ts` does not override it. */
export const HOOK_TIMEOUT_FLOOR_MS = 10_000;
/**
 * The bound between one test's `afterEach` and the next `beforeEach`. A
 * describe block's `beforeAll` runs there, and some walk the real tree
 * synchronously past the hook floor (`gen-update-path-coverage.test.ts` was
 * killed at 15 s under a 10 s bound, and passes in 55 s alone), so this is
 * the suite's hang ceiling. `CDKD_TEST_WATCHDOG_BETWEEN_MS` shortens it for
 * `event-loop-watchdog.test.ts`'s child run only.
 */
export const BETWEEN_TESTS_MS =
  Number(process.env.CDKD_TEST_WATCHDOG_BETWEEN_MS) > 0
    ? Number(process.env.CDKD_TEST_WATCHDOG_BETWEEN_MS)
    : CONTENDED_CASE_TIMEOUT_MS;
const HEARTBEAT_MS = 200;
const CHECK_MS = 250;
const LABEL_BYTES = 4096;
// Int32 slots: the last heartbeat (ms since `origin`), the running test's
// timeout (0 while no test runs), and the label's length in bytes.
const BEAT = 0;
const TIMEOUT = 1;
const LABEL_LENGTH = 2;

interface WatchdogState {
  readonly origin: number;
  // A monotonic clock (a wall clock jumping forward would read as a stale
  // heartbeat), taken when the watchdog starts: a test's fake timers replace
  // `performance` and `Date`. The worker thread computes the same value from
  // its own `performance`, whose `timeOrigin` differs from this thread's.
  readonly now: () => number;
  readonly slots: Int32Array;
  readonly label: Uint8Array;
}

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { origin, slotsBuffer, labelBuffer, graceMs, checkMs, marker } = workerData;
const slots = new Int32Array(slotsBuffer);
const label = new Uint8Array(labelBuffer);
setInterval(() => {
  const timeout = Atomics.load(slots, ${TIMEOUT});
  if (timeout <= 0) return;
  const stale =
    performance.timeOrigin + performance.now() - origin - Atomics.load(slots, ${BEAT});
  if (stale <= timeout + graceMs) return;
  const name = Buffer.from(label.subarray(0, Atomics.load(slots, ${LABEL_LENGTH}))).toString('utf8');
  fs.writeSync(
    2,
    '\\n' + marker + ' ' + name + ': the event loop has not turned for ' + Math.round(stale) +
      ' ms, past the bound of ' + timeout + ' ms plus ' + graceMs + ' ms, so vitest cannot fail the test. ' +
      'A loop awaiting only already-resolved promises (a sleep double that resolves at once, ' +
      'beside a wait the test never satisfies) or a synchronous block starves the timeout ' +
      'timer. Killing the test worker (go-to-k/cdkd#7042).\\n'
  );
  process.kill(process.pid, 'SIGKILL');
}, checkMs);
`;

const STATE_KEY = Symbol.for('cdkd.eventLoopWatchdog');

function startWatchdog(): WatchdogState | null {
  if (inspector.url() !== undefined || process.env.CDKD_TEST_WATCHDOG === '0') return null;
  const realNow = performance.now.bind(performance);
  const { timeOrigin } = performance;
  const now = (): number => timeOrigin + realNow();
  const origin = now();
  const slotsBuffer = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const labelBuffer = new SharedArrayBuffer(LABEL_BYTES);
  const state: WatchdogState = {
    origin,
    now,
    slots: new Int32Array(slotsBuffer),
    label: new Uint8Array(labelBuffer),
  };
  new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      origin,
      slotsBuffer,
      labelBuffer,
      graceMs: WATCHDOG_GRACE_MS,
      checkMs: CHECK_MS,
      marker: WATCHDOG_MARKER,
    },
  }).unref();
  setInterval(() => beat(state), HEARTBEAT_MS).unref();
  return state;
}

function beat(state: WatchdogState): void {
  Atomics.store(state.slots, BEAT, state.now() - state.origin);
}

/**
 * Start the watchdog once per process (setup files re-run per test file) and
 * arm it around every test of the importing file.
 */
export function installEventLoopWatchdog(): void {
  const holder = process as unknown as Record<symbol, WatchdogState | null | undefined>;
  if (holder[STATE_KEY] === undefined) holder[STATE_KEY] = startWatchdog();
  const state = holder[STATE_KEY];
  if (state === null || state === undefined) return;

  // A new file's collection is not a test: disarm whatever the previous file
  // in this process left armed.
  Atomics.store(state.slots, TIMEOUT, 0);
  let current = '';

  beforeEach((context) => {
    current = context.task.fullName;
    setLabel(state, current);
    beat(state);
    const timeout = context.task.timeout;
    // The armed window also holds the file's own `beforeEach` / `afterEach`
    // hooks, which vitest bounds by `hookTimeout` (10 s by default, not
    // overridden here), so the bound is never below it.
    Atomics.store(
      state.slots,
      TIMEOUT,
      Number.isFinite(timeout) && timeout > 0
        ? Math.min(Math.max(timeout, HOOK_TIMEOUT_FLOOR_MS), 2 ** 30)
        : 0
    );
  });
  // Stay armed after the test: a wait the test started and never awaited (it
  // threw first) keeps spinning once the runner moves on. The bound covers
  // what can legitimately run synchronously before the next `beforeEach` --
  // a describe block's `beforeAll`, which some files give a long timeout.
  afterEach(() => {
    setLabel(state, `after ${current}`);
    beat(state);
    Atomics.store(state.slots, TIMEOUT, Math.min(BETWEEN_TESTS_MS, 2 ** 30));
  });
}

function setLabel(state: WatchdogState, label: string): void {
  // At most 4 UTF-8 bytes per code point, so a cut by code points always fits
  // and never splits a character.
  const bytes = new TextEncoder().encode(
    Array.from(label)
      .slice(0, LABEL_BYTES / 4)
      .join('')
  );
  state.label.set(bytes);
  Atomics.store(state.slots, LABEL_LENGTH, bytes.length);
}
