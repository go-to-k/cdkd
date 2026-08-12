import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Canary for the runtime `*Once`-leak detector (issue #1618).
 *
 * This suite LEAKS ON PURPOSE. It exists so that "the detector has gone dead"
 * and "the tree is clean" stop producing the same green CI result — the
 * vacuous pass that `.claude/rules/testing.md` forbids for any checker.
 *
 * How it is wired:
 *
 * - In the normal `once-leak-detect` job the file is allow-listed (it leaks, so
 *   `vp run gen:once-leak-allowlist` picks it up automatically and keeps it
 *   there), and the job stays green.
 * - The `detector canary` CI step re-runs THIS FILE ONLY with
 *   `CDKD_ONCE_LEAK_IGNORE_ALLOWLIST=1` and requires a NON-ZERO exit. If the
 *   detector ever stops instrumenting — a `@vitest/spy` internals change, a
 *   `vi.fn` patch that overwrites ours, a refactor that drops the wrapper —
 *   this run goes green and the step fails loudly.
 *
 * The assertions below deliberately pass under the corrupted reading, which is
 * the point: it is a faithful reproduction of the issue #1588 pathology, where
 * the shifted test still satisfied its own assertions.
 *
 * Do NOT "fix" the priming here. This file is not a defect; the three real
 * offenders are tracked by issue #1655.
 */
describe('once-leak detector canary (leaks deliberately — see issue #1618)', () => {
  const send = vi.fn();

  beforeEach(() => {
    // `clearAllMocks` on purpose: it clears call records but does NOT drain the
    // `*Once` queue, which is the exact asymmetry the detector exists for.
    vi.clearAllMocks();
  });

  it('primes two responses but consumes only one', () => {
    send.mockReturnValueOnce('first').mockReturnValueOnce('LEAKED-TO-THE-NEXT-TEST');

    expect(send()).toBe('first');
  });

  it('receives the previous test\'s leftover as its own first response', () => {
    send.mockReturnValueOnce('what this test believes it primed');

    // Reads the LEAKED value, not its own. Asserting the corrupted value keeps
    // this suite green in the normal job while the detector is what flags it.
    expect(send()).toBe('LEAKED-TO-THE-NEXT-TEST');
  });
});
