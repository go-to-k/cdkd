---
description: cdkd test-run output discipline (the stream fence)
paths:
  - 'tests/setup.ts'
  - 'tests/stream-fence.ts'
  - 'tests/unit/stream-fence.test.ts'
---

# A green run prints nothing

`tests/setup.ts` installs a stream fence (`tests/stream-fence.ts`) that buffers
raw `process.stdout` / `process.stderr` writes made inside a test and replays
them, headed by the test's name, only when that test FAILS. Vitest suppresses
`console.*`, but a raw `stream.write()` bypasses that, and product code uses one
where the logger is unfit.

**The capture is bounded at BOTH ends.** Vitest runs `afterEach` ->
`onTestFinished` -> `onTestFailed`, so the fence stops at `onTestFinished` while
KEEPING the buffer (the `onTestFailed` replay still finds it), and everything
after writes straight through; `beforeEach` / `afterEach` are INSIDE it. **Capturing without ever stopping turns the carve-out into a
silent SWALLOW** — an `afterAll` in `stream-fence.test.ts` asserts it stopped.

- **To ASSERT on such a write, REPLACE `process.stderr.write` and restore it**
  rather than spying: `vi.spyOn` does not intercept cleanly here, and a
  replacement sits ABOVE the fence.
- **`CDKD_TEST_STREAM_PASSTHROUGH=1` disables the fence**, for a hang or crash:
  a run that never finishes a test never reaches the replay.
- **One buffer per worker, so tests in a file must run SERIALLY**;
  `it.concurrent` would let one test's capture wipe a peer's buffer, and
  `stream-fence.test.ts` fails if any appears.
