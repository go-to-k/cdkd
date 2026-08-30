---
description: cdkd test-run output discipline (the stream fence in tests/setup.ts)
paths:
  - 'tests/setup.ts'
  - 'tests/stream-fence.ts'
  - 'tests/unit/stream-fence.test.ts'
---

# A green run must print nothing

`tests/setup.ts` installs a stream fence (`tests/stream-fence.ts`) that buffers
raw `process.stdout` / `process.stderr` writes made inside a test and replays
them, headed by the test's full name, only when that test FAILS.

Vitest attributes and suppresses `console.*`; a raw `stream.write()` bypasses
that entirely, and product code uses it deliberately where the logger is the
wrong channel — the deprecated-`--region` notice in `src/cli/options.ts`, the
SIGINT notices in `src/provisioning/interrupt-watch.ts` and
`src/cli/commands/destroy-runner.ts`, the critic summaries under `scripts/`.
Measured 2026-08-30 before the fence: 108 such lines, ~20 KB of `vp test run`'s
~22 KB full-suite output, all of it from PASSING tests. After: the whole run
prints well under 2 KB.

That is a correctness property, not a tidiness one. A green run's output is what
a person or an agent reads to decide whether to trust the run, and 20 KB of
notices from passing tests is 20 KB a real signal can hide in.

## The capture is bounded at BOTH ends

Vitest runs `afterEach` -> `onTestFinished` -> `onTestFailed` (verified against
`@vitest/runner` 4.1.10). The fence therefore stops capturing at
`onTestFinished` while KEEPING the buffer, so the replay driven by
`onTestFailed` still finds something to replay, and everything after that — a
later `beforeAll`, `afterAll`, the next file's module top level in a reused
worker — writes straight through.

**Starting the capture without ever stopping it turns the carve-out into a
silent SWALLOW, which is strictly worse than the noise the fence removes.** That
is what the first cut of this fence did, and the docs claimed the opposite; an
`afterAll` in `tests/unit/stream-fence.test.ts` now asserts the fence is no
longer capturing once the file's tests are done, so the claim is fenced rather
than merely written.

## Working with it

- **To ASSERT on such a write, REPLACE `process.stderr.write` and restore it**,
  rather than spying. That is already this repo's convention — see
  `tests/unit/cli/options.test.ts` and
  `tests/unit/provisioning/interrupt-watch.test.ts`, both of which record that
  `vi.spyOn` does not intercept the stream cleanly under vitest's output
  capture. A replacement sits ABOVE the fence, so the fence never sees those
  writes.
- **`CDKD_TEST_STREAM_PASSTHROUGH=1` disables the fence entirely.** Use it when
  debugging a hang or a crash: a run that never reaches the end of a test never
  reaches the replay either, so buffering would hide exactly the output you
  need.
- **One buffer per worker, so tests within a file must run SERIALLY.**
  `it.concurrent` would let one test's capture wipe a peer's buffer and let a
  failure replay another test's writes. This repo uses none, and
  `tests/unit/stream-fence.test.ts` fails if that changes.

End-user-facing detail lives in [docs/testing.md](../../docs/testing.md).
